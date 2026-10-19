import type {ServerResponse} from 'node:http';

interface RequestIdentity{operation?:string;projectId?:string}
interface Options{
  subscribeMedia(observer:(event:unknown)=>void):()=>void;
  busy():never;signal?:AbortSignal;
}
/** Deletion is admitted only in a quiet backend. HTTP includes SSE and file
 * transfers, so deleting never races an accepted stream or a not-yet-journaled
 * Agent request. This guard refuses work; it never cancels another request. */
export function createProjectDeletionGate({subscribeMedia,busy,signal}:Options){
  const requests=new Map<ServerResponse,RequestIdentity>(),endings=new Map<ServerResponse,()=>void>(),media=new Set<number>(),work=new Set<object>();
  let closed=false;
  const unsubscribe=subscribeMedia(value=>{
    if(!value||typeof value!=='object')return;
    const event=value as Record<string,unknown>;
    if(typeof event.pid!=='number'||!Number.isSafeInteger(event.pid)||event.pid<1)return;
    if(event.type==='started')media.add(event.pid);
    if(event.type==='exited')media.delete(event.pid);
  });
  const close=()=>{if(closed)return;closed=true;unsubscribe();signal?.removeEventListener('abort',close);for(const end of endings.values())end();requests.clear();media.clear();work.clear();};
  signal?.addEventListener('abort',close,{once:true});if(signal?.aborted)close();
  return {
    // Accepted filesystem publication can outlive its HTTP caller. Its own
    // lease ends after cleanup, rather than when the response socket closes.
    hold():()=>void{if(closed)busy();const token={};work.add(token);return()=>{work.delete(token);};},
    track(response:ServerResponse):void{
      if(closed||requests.has(response))return;requests.set(response,{});
      const done=()=>{response.removeListener('finish',done);response.removeListener('close',done);endings.delete(response);requests.delete(response);};
      endings.set(response,done);response.once('finish',done);response.once('close',done);
    },
    rpc(response:ServerResponse,operation:unknown,input:unknown):void{
      if(!requests.has(response))return;
      const projectId=input&&typeof input==='object'&&!Array.isArray(input)&&'projectId' in input?input.projectId:undefined;
      requests.set(response,{...(typeof operation==='string'?{operation}:{}),...(typeof projectId==='string'?{projectId}:{})});
    },
    assertIdle(projectId:string):void{
      if(closed||work.size||media.size||[...requests.values()].some(request=>request.operation!=='project.delete'||request.projectId!==projectId))busy();
    },
    close,
  };
}
