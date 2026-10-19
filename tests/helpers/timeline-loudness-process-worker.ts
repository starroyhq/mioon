// Disposable owned process. It can kill only itself at the single reviewed
// afterBusinessCommit boundary; it never deletes a lock or signals a neighbor.
import path from 'node:path';
import {writeFileSync} from 'node:fs';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createEditTasks} from '../../packages/business/src/edit-tasks.ts';
import {onMediaProcess} from '../../packages/business/src/media-processes.ts';
const root=process.argv[2];
if(!root)throw Error('Usage: timeline-loudness-process-worker <root>');
const taskMethods: ReadonlySet<string>=new Set(['prepare','get','list','execute','reconcile','reconcileStartup']);
const operations: ReadonlySet<string>=new Set(['timeline.loudness.prepare','timeline.loudness.apply','timeline.undo','timeline.get','timeline.history.get']);
interface DispatchRecord {operation: string; input: {requestId?: string; [key: string]: unknown}}
type Store=ReturnType<typeof openStore>;type Services=ReturnType<typeof createServices>;type Tasks=ReturnType<typeof createEditTasks>;
const dispatches: DispatchRecord[]=[],media: {type: string; pid: number|undefined}[]=[],liveMedia=new Set<number|undefined>();
let armed=false,store: Store|undefined,services: Services|undefined,tasks: Tasks|undefined,closing: Promise<void>|undefined;
const off=onMediaProcess(event=>{media.push({type:event.type,pid:event.pid});if(event.type==='started')liveMedia.add(event.pid);else if(event.type==='exited')liveMedia.delete(event.pid);});
const report=(value: unknown): void=>{if(process.connected)process.send?.(value);};
const close=(): Promise<void>=>closing??=(async()=>{await tasks?.drain();await services?.drain();off();store?.close();if(process.connected)process.disconnect();})();
try{
  store=openStore(root);services=createServices(store,new Map());
  tasks=createEditTasks({store,services:{call(operation: string,input: never){dispatches.push({operation,input:input as DispatchRecord['input']});return services!.call(operation,input);}},fault:(phase: string)=>{
    if(armed&&phase==='afterBusinessCommit'){
      writeFileSync(path.join(root,'owned-loudness-crash-proof.json'),JSON.stringify({phase,pid:process.pid,liveMediaCount:liveMedia.size,
        dispatchCount:dispatches.length,operation:dispatches.at(-1)?.operation,requestId:dispatches.at(-1)?.input.requestId}),{mode:0o600});
      process.kill(process.pid,'SIGKILL');
    }
  }} as never);
  const startup=tasks.reconcileStartup();
  interface WorkerMessage {method: string; input: string|Record<string, unknown>; id: string}
  process.on('message',async (raw: unknown)=>{
    const message=raw as WorkerMessage;
    try{
      if(message.method==='close'){await close();return;}
      let data: unknown;
      if(message.method==='arm'){if(message.input!=='afterBusinessCommit')throw Error('Unsupported phase');armed=true;data={armed};}
      else if(message.method==='observe')data={dispatches,media,liveMediaCount:liveMedia.size};
      else if(message.method==='rpc'){
        const rpcInput=message.input as Record<string, unknown> & {operation?: string; input?: unknown};
        if(!operations.has(String(rpcInput.operation)))throw Error('Unsupported operation');
        data=await services!.call(String(rpcInput.operation),rpcInput.input as never);
      }else{if(!taskMethods.has(message.method))throw Error('Unsupported task method');const taskMethod=(tasks as unknown as Record<string,(input: unknown)=>Promise<unknown>>)[message.method];data=await taskMethod(message.input);}
      report({type:'reply',id:message.id,data});
    }catch(error){const failure=error as {code?: string; message?: string};report({type:'reply',id:message.id,error:{code:failure.code,message:failure.message??String(error)}});}
  });
  report({type:'ready',pid:process.pid,startup});
}catch(error){process.exitCode=1;const failure=error as {code?: string; message?: string};report({type:'fatal',code:failure.code,message:failure.message??String(error)});await close();}
process.once('disconnect',()=>{close().catch(()=>{process.exitCode=1;});});
