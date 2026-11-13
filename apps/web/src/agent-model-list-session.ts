import {AGENT_MODEL_LIST_LIMITS,agentModelListRequestSchema,agentModelListResultSchema,agentModelListCacheRequestSchema,agentModelListCacheResultSchema} from '../../../packages/contracts/src/agent-model-list.ts';
import type {AgentModelListRequest,AgentModelListResult,AgentModelListCacheRequest,AgentModelListCacheResult,AgentModelListSuccess} from '../../../packages/contracts/src/agent-model-list.ts';

export interface AgentModelListClient {
 modelsList(input:AgentModelListRequest,options:{signal:AbortSignal}):Promise<unknown>;
 modelsCache(input:AgentModelListCacheRequest,options:{signal:AbortSignal}):Promise<unknown>;
}
const failure=()=>new Error('Model list request did not complete.');
/** Browser-only transport. The one-use input value exists only in this POST;
 * neither this client nor the discovery session retains a credential. */
export function createAgentModelListClient({fetchImpl=(input:RequestInfo|URL,init?:RequestInit)=>globalThis.fetch(input,init),timeoutMs=18000}:{fetchImpl?:typeof fetch;timeoutMs?:number}={}):AgentModelListClient{
 async function request(input:unknown,path:'list'|'cache',external:AbortSignal):Promise<unknown>{
  const controller=new AbortController(),abort=()=>controller.abort();external.addEventListener('abort',abort,{once:true});if(external.aborted)abort();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const operation=(async()=>{
   const parsed=path==='list'?agentModelListRequestSchema.parse(input):agentModelListCacheRequestSchema.parse(input);
   const response=await fetchImpl(`/api/agent/models/${path}`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed),signal:controller.signal});
   if(!response.ok||!response.body)throw failure();
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   try{while(true){const next=await reader.read();if(next.done)break;if(next.value.byteLength>AGENT_MODEL_LIST_LIMITS.resultBytes-size)throw failure();size+=next.value.byteLength;chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   const envelope:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   if(!envelope||typeof envelope!=='object'||Object.keys(envelope).length!==2||!('ok'in envelope)||envelope.ok!==true||!('data'in envelope))throw failure();
   return path==='list'?agentModelListResultSchema.parse(envelope.data):agentModelListCacheResultSchema.parse(envelope.data);
  })();
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure());},timeoutMs);controller.signal.addEventListener('abort',()=>reject(failure()),{once:true});if(controller.signal.aborted)reject(failure());})]);}
  catch{throw failure();}finally{clearTimeout(timer);external.removeEventListener('abort',abort);}
 }
 return {modelsList:(input,{signal})=>request(input,'list',signal),modelsCache:(input,{signal})=>request(input,'cache',signal)};
}
export type AgentModelListPhase='idle'|'loading'|'waiting_key'|'success'|'invalid_key'|'unavailable'|'unreachable'|'network_denied'|'error';
export interface AgentModelListView {requestId:number;identity:string;phase:AgentModelListPhase;observation:AgentModelListSuccess|null;result:AgentModelListResult|null;fromCache:boolean}
interface Entry {view:AgentModelListView;epoch:number;controller:AbortController|null}
type Credential=AgentModelListRequest['credential'];
const identity=(input:AgentModelListCacheRequest)=>JSON.stringify([input.serviceKey,input.selection.presetId,input.selection.platformId,input.selection.baseUrl,input.selection.protocol]);
const empty=(key:string):AgentModelListView=>({requestId:0,identity:key,phase:'idle',observation:null,result:null,fromCache:false});
/** Independent observations and cancellation epochs never join the settings
 * draft or its CAS. Only an active detail can issue a request. */
export function createAgentModelListSession({client=createAgentModelListClient(),onChange=()=>{}}:{client?:AgentModelListClient;onChange?:(views:Readonly<Record<string,AgentModelListView>>)=>void}={}){
 const entries=new Map<string,Entry>();let active:string|null=null,disposed=false,nextRequestId=0;
 const emit=()=>{if(!disposed)onChange(Object.fromEntries([...entries].map(([key,entry])=>[key,structuredClone(entry.view)])));};
 function cancel(key:string){const entry=entries.get(key);if(entry){entry.epoch++;entry.controller?.abort();entry.controller=null;if(entry.view.phase==='loading')entry.view={...entry.view,phase:entry.view.observation?'success':'idle'};}}
 function get(input:AgentModelListCacheRequest):Entry{
  let entry=entries.get(input.serviceKey);const key=identity(input);
  if(!entry||entry.view.identity!==key){cancel(input.serviceKey);entry={view:empty(key),epoch:(entry?.epoch??0)+1,controller:null};entries.set(input.serviceKey,entry);}
  return entry;
 }
 async function run(raw:AgentModelListCacheRequest,readCredential?:()=>Credential|null){
  if(disposed)return;const parsed=agentModelListCacheRequestSchema.safeParse(raw);if(!parsed.success)return;const input=parsed.data;
  if(active!==input.serviceKey){if(active)cancel(active);active=input.serviceKey;}
  const entry=get(input);cancel(input.serviceKey);const epoch=++entry.epoch,controller=new AbortController();entry.controller=controller;entry.view={...entry.view,requestId:++nextRequestId,phase:'loading',result:null,fromCache:!readCredential};emit();
  const current=()=>!disposed&&active===input.serviceKey&&entries.get(input.serviceKey)===entry&&entry.epoch===epoch&&!controller.signal.aborted;
  try{
   if(!readCredential){
    const cached:AgentModelListCacheResult=agentModelListCacheResultSchema.parse(await client.modelsCache(input,{signal:controller.signal}));
    if(!current())return;
    entry.view=cached.status==='hit'?{...entry.view,phase:'success',observation:cached.result,result:cached.result}:{...entry.view,phase:'idle'};
    emit();return;
   }
   if(!current())return;
   // Read DOM immediately before dispatch. This value is never placed
   // in an Entry, state emission, request identity or replayable closure.
   const credential=readCredential();if(!credential){entry.view={...entry.view,phase:'waiting_key',result:null};emit();return;}
   const request=agentModelListRequestSchema.safeParse({...input,credential});if(!request.success){entry.view={...entry.view,phase:'error',result:null};emit();return;}
   const result=agentModelListResultSchema.parse(await client.modelsList(request.data,{signal:controller.signal}));if(!current())return;
   entry.view={...entry.view,phase:result.outcome,result,fromCache:false,...(result.outcome==='success'?{observation:result}:{})};emit();
  }catch{if(current()){entry.view={...entry.view,phase:'error',result:null};emit();}}
  finally{if(entry.epoch===epoch)entry.controller=null;}
 }
 return {
  readCache:(input:AgentModelListCacheRequest)=>run(input),
  refresh:(input:AgentModelListCacheRequest,credential:()=>Credential|null)=>run(input,credential),
  isCurrentSuccess(key:string,requestId:number){
   const view=entries.get(key)?.view;
   return active===key&&view?.requestId===requestId&&view.result?.outcome==='success'&&!view.fromCache;
  },
  invalidate(key?:string){if(key===undefined){for(const id of entries.keys())cancel(id);active=null;}else cancel(key);emit();},
  forget(keys:readonly string[]){const keep=new Set(keys);for(const key of entries.keys())if(!keep.has(key)){cancel(key);entries.delete(key);if(active===key)active=null;}emit();},
  suspend(){if(active)cancel(active);active=null;emit();},
  dispose(){disposed=true;for(const key of entries.keys())cancel(key);entries.clear();active=null;},
  getState:()=>Object.fromEntries([...entries].map(([key,entry])=>[key,structuredClone(entry.view)])),
 };
}
