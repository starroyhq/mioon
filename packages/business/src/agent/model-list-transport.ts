import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpsRequestDefault,type RequestOptions} from 'node:https';
import {request as httpRequestDefault,type ClientRequest,type ClientRequestArgs,type IncomingMessage} from 'node:http';
import {isIP} from 'node:net';
import {checkServerIdentity,type TLSSocket} from 'node:tls';
import {AGENT_MODEL_LIST_LIMITS} from '../../../contracts/src/agent-model-list.ts';
import type {AgentModelListSelection} from '../../../contracts/src/agent-model-list.ts';
import {resolveAgentModelListDescriptor} from './model-list-descriptors.ts';
import {resolvePinnedAgentDestination,assertPinnedAgentSocket} from './network-policy.ts';
import type {AgentTransportDependencies} from './network-policy.ts';
import {ANTHROPIC_MESSAGES_API_VERSION} from './anthropic-protocol.ts';
import {errorCode} from './chat-errors.ts';

export type ModelListTransportFailure='connection_failed'|'timeout'|'aborted'|'invalid_response'|'response_limit'|'policy';
export class AgentModelListTransportError extends Error {
 readonly reason:ModelListTransportFailure;
 constructor(reason:ModelListTransportFailure){super('Model list request failed');this.reason=reason;}
}
export interface AgentModelListPageRequest {selection:AgentModelListSelection;apiKey:string|null;signal?:AbortSignal;selfPort?:number;cursor?:string;offset?:number;maxBytes?:number}
export interface AgentModelListPage {status:number;body:Uint8Array}
export type AgentModelListTransport=(request:AgentModelListPageRequest)=>Promise<AgentModelListPage>;
// Only explicit certificate validation failures are policy denials. Socket
// resets/refusals and other transport failures remain connectivity failures.
const certificateFailures=new Set(['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','CERT_REVOKED','INVALID_CA','CERT_SIGNATURE_FAILURE','ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED']);
/** The only public construction inputs are trusted Node dependencies and lower
 * test budgets. Every GET route/header is re-derived from the selection. */
export function createAgentModelListTransport({lookup=dnsLookup,httpsRequest=httpsRequestDefault,httpRequest=httpRequestDefault,limits:overrides={}}:AgentTransportDependencies={}):AgentModelListTransport{
 const limits:Record<'connectTimeoutMs'|'readTimeoutMs'|'totalTimeoutMs'|'maxHeaderBytes'|'maxDnsAnswers',number>={connectTimeoutMs:AGENT_MODEL_LIST_LIMITS.connectTimeoutMs,readTimeoutMs:AGENT_MODEL_LIST_LIMITS.readTimeoutMs,totalTimeoutMs:AGENT_MODEL_LIST_LIMITS.totalTimeoutMs,maxHeaderBytes:AGENT_MODEL_LIST_LIMITS.maxHeaderBytes,maxDnsAnswers:AGENT_MODEL_LIST_LIMITS.maxDnsAnswers};
 for(const [key,value]of Object.entries(overrides)){if(!Object.hasOwn(limits,key)||!Number.isInteger(value)||value<1||value>limits[key as keyof typeof limits])throw new TypeError('Invalid model-list transport budget');limits[key as keyof typeof limits]=value;}
 return async function getPage({selection,apiKey,signal,selfPort,cursor,offset,maxBytes=AGENT_MODEL_LIST_LIMITS.rawBytes}):Promise<AgentModelListPage>{
  const controller=new AbortController();let request:ClientRequest|undefined,response:IncomingMessage|undefined,failure:AgentModelListTransportError|undefined,rejectPending:((error:unknown)=>void)|undefined;
  const fail=(reason:ModelListTransportFailure)=>{if(failure)return;failure=new AgentModelListTransportError(reason);controller.abort();request?.destroy();response?.destroy();rejectPending?.(failure);};
  const externalAbort=()=>fail('aborted');signal?.addEventListener('abort',externalAbort,{once:true});if(signal?.aborted)externalAbort();
  const totalTimer=setTimeout(()=>fail('timeout'),limits.totalTimeoutMs),connectTimer=setTimeout(()=>fail('timeout'),limits.connectTimeoutMs);
  try{
   const descriptor=resolveAgentModelListDescriptor(selection,{selfPort});if(!descriptor)throw new AgentModelListTransportError('policy');
   if(!Number.isInteger(maxBytes)||maxBytes<0||maxBytes>AGENT_MODEL_LIST_LIMITS.rawBytes)throw new AgentModelListTransportError('response_limit');
   const url=new URL(descriptor.url);
   if(descriptor.pagination==='cursor'){
    url.searchParams.set('limit','100');
    if(cursor!==undefined){if(!cursor||cursor.length>200||/[\u0000-\u001f\u007f-\u009f]/u.test(cursor))throw new AgentModelListTransportError('invalid_response');url.searchParams.set('after_id',cursor);}
    if(offset!==undefined)throw new AgentModelListTransportError('policy');
   }else if(descriptor.pagination==='offset'){
    if(cursor!==undefined||offset!==undefined&&(!Number.isInteger(offset)||offset<0||offset>=1000))throw new AgentModelListTransportError('policy');
    url.searchParams.set('offset',String(offset??0));url.searchParams.set('limit','100');
   }else if(cursor!==undefined||offset!==undefined)throw new AgentModelListTransportError('policy');
   const destination=await resolvePinnedAgentDestination(url,{local:descriptor.local,selfPort,lookup,signal:controller.signal,maxDnsAnswers:limits.maxDnsAnswers});
   if(failure||controller.signal.aborted)throw failure??new AgentModelListTransportError('aborted');
   const headers:Record<string,string>={Accept:'application/json','Accept-Encoding':'identity',Connection:'close'};
   if(descriptor.auth==='anthropic'){headers['anthropic-version']=ANTHROPIC_MESSAGES_API_VERSION;if(apiKey)headers['x-api-key']=apiKey;}
   else if(apiKey)headers.Authorization=`Bearer ${apiKey}`;
   const pinnedLookup:NonNullable<ClientRequestArgs['lookup']>=(_host,options,callback)=>{let done=callback,settings:unknown=options;if(typeof settings==='function'){done=settings as typeof callback;settings={};}if(controller.signal.aborted)return done(new AgentModelListTransportError('aborted'),'');if((settings as {all?:boolean}).all)done(null,[{address:destination.address,family:destination.family}]);else done(null,destination.address,destination.family);};
   const requestOptions:RequestOptions&{autoSelectFamily:false}={protocol:destination.secure?'https:':'http:',hostname:destination.hostname,port:destination.port,path:destination.path,method:'GET',headers,agent:false,family:destination.family,autoSelectFamily:false,maxHeaderSize:limits.maxHeaderBytes,lookup:pinnedLookup,...(destination.secure?{rejectUnauthorized:true,servername:isIP(destination.hostname)?'':destination.hostname,checkServerIdentity:(_host:string,certificate:Parameters<typeof checkServerIdentity>[1])=>checkServerIdentity(destination.hostname,certificate)}:{})};
   const page=await new Promise<AgentModelListPage>((resolve,reject)=>{
    rejectPending=reject;
    const requestFn=destination.secure?httpsRequest:httpRequest;
    request=requestFn(requestOptions,incoming=>{
     response=incoming;if(failure){incoming.destroy();return;}
     const status=incoming.statusCode??0;
     // Never read error/redirect bodies, nor reflect response headers.
     if(status!==200){incoming.destroy();resolve({status,body:new Uint8Array()});return;}
     const type=incoming.headers['content-type'],encoding=incoming.headers['content-encoding'],length=incoming.headers['content-length'];
     if(typeof type!=='string'||!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/iu.test(type)||encoding&&encoding!=='identity'){fail('invalid_response');return;}
     if(length!==undefined&&(typeof length!=='string'||!/^\d+$/u.test(length)||Number(length)>maxBytes)){fail('response_limit');return;}
     void(async()=>{const chunks:Buffer[]=[];let size=0;try{for await(const chunk of incoming){if(!(chunk instanceof Uint8Array)||chunk.byteLength>maxBytes-size){fail('response_limit');return;}size+=chunk.byteLength;chunks.push(Buffer.from(chunk));}if(failure||controller.signal.aborted)throw failure??new AgentModelListTransportError('aborted');if(incoming.complete===false)throw new AgentModelListTransportError('invalid_response');resolve({status,body:Buffer.concat(chunks,size)});}catch(error){if(error instanceof AgentModelListTransportError)fail(error.reason);else fail('connection_failed');}})();
    });
    request.on('error',error=>fail(destination.secure&&certificateFailures.has(errorCode(error)??'')?'policy':'connection_failed'));request.on('upgrade',(_response,socket)=>{socket.destroy();fail('invalid_response');});request.setTimeout(limits.readTimeoutMs,()=>fail('timeout'));
    request.once('socket',socket=>{(socket as TLSSocket).once(destination.secure?'secureConnect':'connect',()=>{if(failure||controller.signal.aborted){socket.destroy();return;}try{assertPinnedAgentSocket(socket,destination);}catch{fail('policy');return;}clearTimeout(connectTimer);try{request?.end();}catch{fail('connection_failed');}});});
   });
   return page;
  }catch(error){if(failure)throw failure;if(error instanceof AgentModelListTransportError)throw error;throw new AgentModelListTransportError(errorCode(error)==='AGENT_CHAT_NETWORK_DENIED'?'policy':signal?.aborted?'aborted':'connection_failed');}
  finally{clearTimeout(totalTimer);clearTimeout(connectTimer);signal?.removeEventListener('abort',externalAbort);request?.destroy();response?.destroy();}
 };
}
