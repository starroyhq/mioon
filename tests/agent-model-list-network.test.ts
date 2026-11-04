import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {RequestOptions} from 'node:https';
import type {ClientRequest,IncomingMessage} from 'node:http';
import type {AgentModelListSelection} from '../packages/contracts/src/agent-model-list.ts';
import {AGENT_MODEL_LIST_LIMITS} from '../packages/contracts/src/agent-model-list.ts';
import {createAgentModelListTransport,AgentModelListTransportError} from '../packages/business/src/agent/model-list-transport.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
const selection:AgentModelListSelection={presetId:'openai',platformId:'global',baseUrl:'https://api.openai.com/v1',protocol:'chat_completions'};
const key='synthetic-key-marker';
const answers=async()=>[{address:'8.8.8.8',family:4}];
interface FixtureOptions{peer?:string;port?:number;authorized?:boolean;status?:number;type?:string;encoding?:string;body?:Uint8Array;stream?:Readable;beforeConnect?:()=>void;neverConnect?:boolean;requestError?:string}
function fixture({peer='8.8.8.8',port=443,authorized=true,status=200,type='application/json',encoding,body=Buffer.from('{"data":[]}'),stream,beforeConnect,neverConnect=false,requestError}:FixtureOptions={}){
 const state:{calls:number;ends:number;destroyed:boolean;options?:RequestOptions&{autoSelectFamily?:boolean};timeout?:()=>void;incoming?:IncomingMessage}={calls:0,ends:0,destroyed:false};
 const request=(options:RequestOptions,callback:(response:IncomingMessage)=>void):ClientRequest=>{
  state.calls++;state.options=options;
  const req=new EventEmitter() as ClientRequest;
  req.setTimeout=(_ms:number,handler?:()=>void)=>{state.timeout=handler;return req;};
  req.destroy=()=>{state.destroyed=true;return req;};
  req.end=(()=>{state.ends++;const incoming=(stream??Readable.from([body])) as IncomingMessage;Object.assign(incoming,{statusCode:status,headers:{'content-type':type,...(encoding?{'content-encoding':encoding}:{})},complete:true});state.incoming=incoming;callback(incoming);return req;}) as ClientRequest['end'];
  queueMicrotask(()=>{if(requestError){req.emit('error',Object.assign(Error(key),{code:requestError}));return;}if(neverConnect)return;const socket=new EventEmitter();Object.assign(socket,{remoteAddress:peer,remotePort:port,authorized,destroy(){state.destroyed=true;}});req.emit('socket',socket);beforeConnect?.();socket.emit('secureConnect');});
  return req;
 };
 return {state,request:request as unknown as typeof import('node:https').request};
}
function deps(f:ReturnType<typeof fixture>,lookup:unknown=answers):AgentTransportDependencies{return {httpsRequest:f.request,lookup:lookup as typeof import('node:dns/promises').lookup};}
test('list GET pins the original hostname, TLS identity and lookup; key waits for peer validation',async()=>{
 const f=fixture({beforeConnect:()=>assert.equal(f.state.ends,0)});
 const result=await createAgentModelListTransport(deps(f))({selection,apiKey:key});assert.equal(result.status,200);
 const options=f.state.options!;assert.equal(options.hostname,'api.openai.com');assert.equal(options.path,'/v1/models');assert.equal(options.method,'GET');assert.equal(options.agent,false);assert.equal(options.autoSelectFamily,false);assert.equal(options.servername,'api.openai.com');assert.equal(options.rejectUnauthorized,true);assert.equal(options.maxHeaderSize,16384);assert.deepEqual(options.headers,{Accept:'application/json','Accept-Encoding':'identity',Connection:'close',Authorization:`Bearer ${key}`});
 await new Promise<void>((resolve,reject)=>{assert.equal(typeof options.lookup,'function');(options.lookup as NonNullable<import('node:http').ClientRequestArgs['lookup']>)('attacker.example.com',{},(error,address,family)=>{if(error)return reject(error);assert.equal(address,'8.8.8.8');assert.equal(family,4);resolve();});});
 assert.equal(f.state.ends,1);assert.equal(f.state.destroyed,true);
});
test('all DNS answers, pinned peer and TLS authorization must pass before a key is sent',async()=>{
 for(const answer of [[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],[{address:'127.0.0.1',family:4}],[],Array.from({length:65},()=>({address:'8.8.8.8',family:4})),[{address:'8.8.8.8',family:6}]]){
  const f=fixture();await assert.rejects(createAgentModelListTransport(deps(f,async()=>answer))({selection,apiKey:key}),error=>error instanceof AgentModelListTransportError&&error.reason==='policy');assert.equal(f.state.calls,0);assert.equal(f.state.ends,0);
 }
 for(const options of [{peer:'1.1.1.1'},{port:444},{authorized:false}]){
  const f=fixture(options);await assert.rejects(createAgentModelListTransport(deps(f))({selection,apiKey:key}),error=>error instanceof AgentModelListTransportError&&error.reason==='policy');assert.equal(f.state.ends,0);
 }
});
test('certificate validation failures are policy denials while ordinary socket failures remain unreachable',async()=>{
 for(const code of ['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','CERT_REVOKED','INVALID_CA','CERT_SIGNATURE_FAILURE','ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED','ECONNRESET','ECONNREFUSED','ETIMEDOUT']){
  const f=fixture({requestError:code}),ordinary=['ECONNRESET','ECONNREFUSED','ETIMEDOUT'].includes(code);
  await assert.rejects(createAgentModelListTransport(deps(f))({selection,apiKey:key}),error=>error instanceof AgentModelListTransportError&&error.reason===(ordinary?'connection_failed':'policy')&&!error.message.includes(key));
  assert.equal(f.state.ends,0);assert.equal(f.state.destroyed,true);
 }
});
test('redirect/error response bodies are never read and unsupported encoding/type is rejected',async()=>{
 for(const status of [301,302,307,401,403,404,429,500]){
  const f=fixture({status,body:Buffer.from(key)});assert.deepEqual(await createAgentModelListTransport(deps(f))({selection,apiKey:key}),{status,body:new Uint8Array()});assert.equal(f.state.calls,1);assert.equal(f.state.incoming?.readableDidRead,false);
 }
 for(const options of [{type:'text/html'},{encoding:'gzip'},{type:'application/json; charset=latin1'}]){const f=fixture(options);await assert.rejects(createAgentModelListTransport(deps(f))({selection,apiKey:key}),error=>error instanceof AgentModelListTransportError&&error.reason==='invalid_response');}
});
test('JSON reads enforce exact raw-byte boundary, response stream errors, cancellation and finite deadlines',async()=>{
 for(const size of [AGENT_MODEL_LIST_LIMITS.rawBytes,AGENT_MODEL_LIST_LIMITS.rawBytes+1]){
  const f=fixture({body:Buffer.alloc(size,32)}),operation=createAgentModelListTransport(deps(f))({selection,apiKey:key});
  if(size===AGENT_MODEL_LIST_LIMITS.rawBytes)assert.equal((await operation).body.byteLength,size);else await assert.rejects(operation,error=>error instanceof AgentModelListTransportError&&error.reason==='response_limit');
 }
 const broken=new Readable({read(){this.destroy(Error(key));}}),f=fixture({stream:broken});await assert.rejects(createAgentModelListTransport(deps(f))({selection,apiKey:key}),error=>error instanceof AgentModelListTransportError&&error.reason==='connection_failed');
 const stalled=fixture({neverConnect:true});await assert.rejects(createAgentModelListTransport({...deps(stalled),limits:{connectTimeoutMs:5}})({selection,apiKey:key}),error=>error instanceof AgentModelListTransportError&&error.reason==='timeout');
 const pending=fixture({stream:new Readable({read(){}})}),controller=new AbortController(),operation=createAgentModelListTransport(deps(pending))({selection,apiKey:key,signal:controller.signal});setImmediate(()=>controller.abort());await assert.rejects(operation,error=>error instanceof AgentModelListTransportError&&error.reason==='aborted');assert.equal(pending.state.destroyed,true);
 const dnsPending=fixture(),dnsController=new AbortController(),dnsOperation=createAgentModelListTransport(deps(dnsPending,()=>new Promise(()=>{})))({selection,apiKey:key,signal:dnsController.signal});dnsController.abort();await assert.rejects(dnsOperation,error=>error instanceof AgentModelListTransportError&&error.reason==='aborted');assert.equal(dnsPending.state.calls,0);
 const endlessDns=fixture();await assert.rejects(createAgentModelListTransport({...deps(endlessDns,()=>new Promise(()=>{})),limits:{totalTimeoutMs:5}})({selection,apiKey:key}),error=>error instanceof AgentModelListTransportError&&error.reason==='timeout');assert.equal(endlessDns.state.calls,0);
 const activeStream=new Readable({read(){}}),active=fixture({stream:activeStream}),interval=setInterval(()=>activeStream.push(Buffer.from(' ')),2);
 try{await assert.rejects(createAgentModelListTransport({...deps(active),limits:{totalTimeoutMs:15}})({selection,apiKey:key}),error=>error instanceof AgentModelListTransportError&&error.reason==='timeout');}finally{clearInterval(interval);}
});
test('Anthropic cursors are encoded into fixed fields; no provider next URL or free query is accepted',async()=>{
 const anthropic={presetId:'anthropic',platformId:'global',baseUrl:'https://api.anthropic.com',protocol:'anthropic_messages'} as const,f=fixture();
 await createAgentModelListTransport(deps(f))({selection:anthropic,apiKey:key,cursor:'model/x?redirect=https://private.example.com'});
 const options=f.state.options!;assert.equal(options.path,'/v1/models?limit=100&after_id=model%2Fx%3Fredirect%3Dhttps%3A%2F%2Fprivate.example.com');assert.deepEqual(options.headers,{Accept:'application/json','Accept-Encoding':'identity',Connection:'close','anthropic-version':'2023-06-01','x-api-key':key});
 const router={presetId:'openrouter',platformId:'global',baseUrl:'https://openrouter.ai/api/v1',protocol:'responses'} as const,g=fixture();await createAgentModelListTransport(deps(g))({selection:router,apiKey:null,offset:100});assert.equal(g.state.options?.path,'/api/v1/models?offset=100&limit=100');
 const invalid=fixture();await assert.rejects(createAgentModelListTransport(deps(invalid))({selection,apiKey:key,offset:1}),error=>error instanceof AgentModelListTransportError&&error.reason==='policy');assert.equal(invalid.state.calls,0);
});
test('Ollama lists use exactly the chosen local origin, forbid self-port and ignore proxy environment',async()=>{
 let requests=0,observedPath='',observedAuth:string|undefined;
 const server=createServer((request,response)=>{requests++;observedPath=request.url??'';observedAuth=request.headers.authorization;response.setHeader('Content-Type','application/json');response.end('{"data":[]}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as AddressInfo).port,baseUrl=`http://127.0.0.1:${port}`,local={presetId:'ollama',platformId:'local',baseUrl,protocol:'anthropic_messages'} as const;
 const prior={HTTP_PROXY:process.env.HTTP_PROXY,HTTPS_PROXY:process.env.HTTPS_PROXY,ALL_PROXY:process.env.ALL_PROXY};
 try{
  process.env.HTTP_PROXY='http://127.0.0.1:1';process.env.HTTPS_PROXY='http://127.0.0.1:1';process.env.ALL_PROXY='http://127.0.0.1:1';
  const transport=createAgentModelListTransport();const result=await transport({selection:local,apiKey:key,selfPort:port===65535?port-1:port+1});assert.equal(result.status,200);assert.equal(observedPath,'/v1/models');assert.equal(observedAuth,`Bearer ${key}`);assert.equal(requests,1);
  await assert.rejects(transport({selection:local,apiKey:key,selfPort:port}));assert.equal(requests,1);
 }finally{for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'] as const){if(prior[name]===undefined)delete process.env[name];else process.env[name]=prior[name];}await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
