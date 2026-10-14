import {TIMELINE_LOUDNESS_APPLY_CLIENT_MS, readTimelineLoudnessApplyEnvelope} from '@mioon/client/timeline-loudness-apply';

export interface LoudnessApplyWireOptions {
  readonly expectedWorkspaceOrigin?:string;
  readonly signal?:AbortSignal;
  readonly fetcher?:typeof fetch;
  /** Test seam may only shorten the normal end-to-end deadline. */
  readonly timeoutMs?:number;
}
const fault=(code:string):Error & {code:string}=>Object.assign(new Error('增益应用结果尚未确认。请核对原请求，不要创建新请求重试。'),{code});
function observe<T>(work:Promise<T>,signal:AbortSignal,cancelled:()=>Error):Promise<T>{
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(callback:()=>void):void=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);callback();};
    const abort=():void=>finish(()=>reject(cancelled()));
    signal.addEventListener('abort',abort,{once:true});
    work.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));
    if(signal.aborted)abort();
  });
}
/** Internal fixed-operation transport for the established durable task API or
 * the same-origin shared RPC. A local deadline cannot revoke an accepted write. */
export async function readLoudnessApplyRpc(path:string,body:unknown,options:LoudnessApplyWireOptions={}):Promise<{response:Response;body:unknown}>{
  const valid=body===undefined?/^\/api\/tasks\/[a-f0-9-]{36}\?projectId=[a-f0-9-]{36}$/iu.test(path):/^\/api\/(?:rpc|tasks\/prepare|tasks\/[a-f0-9-]{36}\/(?:execute|reconcile|acknowledge))$/iu.test(path);
  if(!valid)throw fault('VALIDATION');
  const timeout=options.timeoutMs??TIMELINE_LOUDNESS_APPLY_CLIENT_MS;
  if(!Number.isFinite(timeout)||timeout<=0||timeout>TIMELINE_LOUDNESS_APPLY_CLIENT_MS)throw fault('VALIDATION');
  const controller=new AbortController();let timedOut=false,ownedResponse:Response|undefined;
  const abort=():void=>controller.abort();
  const cancelled=():Error=>fault(timedOut?'TIMEOUT':'OPERATION_CANCELLED');
  options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;abort();},timeout);
  try{
    if(options.signal?.aborted)abort();if(controller.signal.aborted)throw cancelled();
    let response:Response;
    try{
      response=await observe((options.fetcher??fetch)(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
        ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),signal:controller.signal}).then(value=>{
          ownedResponse=value;
          if(controller.signal.aborted){void value.body?.cancel().catch(()=>{});throw cancelled();}return value;
        }),controller.signal,cancelled);
    }catch{if(controller.signal.aborted)throw cancelled();throw fault('NETWORK');}
    try{return {response,body:await observe(readTimelineLoudnessApplyEnvelope(response,controller.signal),controller.signal,cancelled)};}
    catch{if(controller.signal.aborted)throw cancelled();throw fault('BACKEND_PROTOCOL_ERROR');}
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);abort();
    // Abort may win after fetch's fulfilment check but before observe delivers
    // the response. No reader owns that body yet, so retire it here as well.
    if(ownedResponse?.body&&!ownedResponse.body.locked)void ownedResponse.body.cancel().catch(()=>{});
  }
}
