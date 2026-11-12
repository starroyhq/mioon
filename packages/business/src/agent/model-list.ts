import {AGENT_MODEL_LIST_LIMITS,agentListedModelSchema,agentModelListSuccessSchema} from '../../../contracts/src/agent-model-list.ts';
import type {AgentListedModel,AgentModelListSelection,AgentModelListResult,AgentModelListSuccess} from '../../../contracts/src/agent-model-list.ts';
import {parseAgentModelListSelection,resolveAgentModelListDescriptor,adaptAgentModelListModels} from './model-list-descriptors.ts';
import {createAgentModelListTransport,AgentModelListTransportError} from './model-list-transport.ts';
import type {AgentModelListTransport} from './model-list-transport.ts';

export interface FetchAgentModelListOptions{selection:AgentModelListSelection;apiKey:string|null;signal?:AbortSignal;selfPort?:number}
export interface FetchAgentModelListDependencies{transport?:AgentModelListTransport;now?:()=>Date;totalTimeoutMs?:number}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function shape():never{throw new TypeError('Unsupported model list shape');}
function bounded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{const aborted=()=>reject(new AgentModelListTransportError('aborted'));if(signal.aborted)return aborted();signal.addEventListener('abort',aborted,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));});
}
/** Lists carry observations only. Metadata never changes profiles, budgets,
 * verification, settings, selection or model authorization. */
export async function fetchAgentModelList({selection:input,apiKey,signal,selfPort}:FetchAgentModelListOptions,{transport=createAgentModelListTransport(),now=()=>new Date(),totalTimeoutMs=AGENT_MODEL_LIST_LIMITS.totalTimeoutMs}:FetchAgentModelListDependencies={}):Promise<AgentModelListResult>{
 const selection=parseAgentModelListSelection(input,{selfPort}),descriptor=resolveAgentModelListDescriptor(selection,{selfPort});
 if(!descriptor)return {outcome:'unavailable',reason:'not_provided'};
 if(!apiKey&&!descriptor.allowNone)return {outcome:'invalid_key',reason:'required'};
 if(!Number.isInteger(totalTimeoutMs)||totalTimeoutMs<1||totalTimeoutMs>AGENT_MODEL_LIST_LIMITS.totalTimeoutMs)throw new TypeError('Invalid model-list deadline');
 const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},totalTimeoutMs);
 const models:AgentListedModel[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined,offset=0,rawBytes=0;
 const fetchedAt=now().toISOString();
 const success=(complete:boolean):AgentModelListSuccess=>agentModelListSuccessSchema.parse({outcome:'success',models,complete,source:descriptor.source,fetchedAt});
 const baseBytes=Buffer.byteLength(JSON.stringify({outcome:'success',models:[],complete:false,source:descriptor.source,fetchedAt}));let dtoBytes=baseBytes;
 try{
  for(let pageIndex=0;pageIndex<AGENT_MODEL_LIST_LIMITS.pages;pageIndex++){
   const page=await bounded(transport({selection,apiKey,signal:controller.signal,selfPort,...(descriptor.pagination==='cursor'&&cursor!==undefined?{cursor}:{}),...(descriptor.pagination==='offset'?{offset}:{}),maxBytes:AGENT_MODEL_LIST_LIMITS.rawBytes-rawBytes}),controller.signal);
   if(controller.signal.aborted)throw new AgentModelListTransportError('aborted');
   if(page.status===401)return {outcome:'invalid_key',reason:'rejected'};
   if(page.status===403)return {outcome:'invalid_key',reason:'permission_denied'};
   if(page.status===404)return {outcome:'unavailable',reason:'not_found'};
   if(page.status===405)return {outcome:'unavailable',reason:'http_unavailable'};
   if(page.status===429)return {outcome:'unreachable',reason:'rate_limited'};
   if(page.status>=500&&page.status<=599)return {outcome:'unreachable',reason:'server_error'};
   if(page.status!==200)return {outcome:'unreachable',reason:'http_error'};
   if(!(page.body instanceof Uint8Array)||page.body.byteLength>AGENT_MODEL_LIST_LIMITS.rawBytes-rawBytes)return {outcome:'unreachable',reason:'response_limit'};
   rawBytes+=page.body.byteLength;
   let value:unknown;
   try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(page.body));}catch{return {outcome:'unreachable',reason:'invalid_response'};}
   if(!record(value)||!Array.isArray(value.data))return {outcome:'unavailable',reason:'unsupported_shape'};
   let more=false,next:string|undefined;
   if(descriptor.pagination==='cursor'){
    if(typeof value.has_more!=='boolean')shape();more=value.has_more;
    if(more){if(typeof value.last_id!=='string'||!value.data.length||!record(value.data.at(-1))||value.data.at(-1)!.id!==value.last_id||cursors.has(value.last_id))shape();next=value.last_id;}
   }else if(descriptor.pagination==='offset'){
    if(!Number.isSafeInteger(value.total_count)||Number(value.total_count)<0||!record(value.links)||!(value.links.next===null||typeof value.links.next==='string'))shape();
    more=offset+value.data.length<Number(value.total_count)||Boolean(value.links.next);
    if(more&&!value.data.length)shape();
   }
   // Validate the complete included page before retaining a bounded prefix.
   const projected:AgentListedModel[]=[];
   for(const row of value.data){
    if(!record(row)||typeof row.id!=='string')shape();
    const displayName=descriptor.format==='anthropic'?row.display_name:row.name;
    if(displayName!==undefined&&typeof displayName!=='string')shape();
    if(apiKey&&(row.id.includes(apiKey)||typeof displayName==='string'&&displayName.includes(apiKey)))return {outcome:'unreachable',reason:'invalid_response'};
    const model=adaptAgentModelListModels(selection,[{id:row.id,...(displayName!==undefined?{displayName}: {})}])[0]!;
    const parsed=agentListedModelSchema.safeParse(model);if(!parsed.success)shape();projected.push(parsed.data);
   }
   for(const model of projected){
    if(ids.has(model.id))continue;
    const size=Buffer.byteLength(JSON.stringify(model))+(models.length?1:0);
    // Reserve the fixed local HTTP/cache wrapper without truncating any field.
    if(models.length===AGENT_MODEL_LIST_LIMITS.models||dtoBytes+size>AGENT_MODEL_LIST_LIMITS.resultBytes-128)return success(false);
    models.push(model);ids.add(model.id);dtoBytes+=size;
   }
   if(!more)return success(true);
   if(models.length===AGENT_MODEL_LIST_LIMITS.models||rawBytes===AGENT_MODEL_LIST_LIMITS.rawBytes)return success(false);
   if(next!==undefined){cursors.add(next);cursor=next;}
   offset+=value.data.length;
  }
  return success(false);
 }catch(error){
  if(error instanceof AgentModelListTransportError){if(error.reason==='policy')return {outcome:'network_denied',reason:'policy'};return {outcome:'unreachable',reason:timedOut?'timeout':error.reason};}
  return {outcome:'unavailable',reason:'unsupported_shape'};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
