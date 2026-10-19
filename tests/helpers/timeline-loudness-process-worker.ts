// Disposable owned process. It can kill only itself at the single reviewed
// afterBusinessCommit boundary; it never deletes a lock or signals a neighbor.
import path from 'node:path';
import {writeFileSync} from 'node:fs';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createEditTasks} from '../../packages/business/src/edit-tasks.ts';
import {onMediaProcess} from '../../packages/business/src/media-processes.ts';
const root=process.argv[2],taskMethods=new Set(['prepare','get','list','execute','reconcile','reconcileStartup']);
const operations=new Set(['timeline.loudness.prepare','timeline.loudness.apply','timeline.undo','timeline.get','timeline.history.get']);
const dispatches=[],media=[],liveMedia=new Set();let armed=false,store,services,tasks,closing;
const off=onMediaProcess(event=>{media.push({type:event.type,pid:event.pid});if(event.type==='started')liveMedia.add(event.pid);else if(event.type==='exited')liveMedia.delete(event.pid);});
const report=value=>{if(process.connected)process.send(value);};
const close=()=>closing??=(async()=>{await tasks?.drain();await services?.drain();off();store?.close();if(process.connected)process.disconnect();})();
try{
  store=openStore(root);services=createServices(store,new Map());
  tasks=createEditTasks({store,services:{call(operation,input){dispatches.push({operation,input});return services.call(operation,input);}},fault:phase=>{
    if(armed&&phase==='afterBusinessCommit'){
      writeFileSync(path.join(root,'owned-loudness-crash-proof.json'),JSON.stringify({phase,pid:process.pid,liveMediaCount:liveMedia.size,
        dispatchCount:dispatches.length,operation:dispatches.at(-1)?.operation,requestId:dispatches.at(-1)?.input.requestId}),{mode:0o600});
      process.kill(process.pid,'SIGKILL');
    }
  }});
  const startup=tasks.reconcileStartup();
  process.on('message',async message=>{
    try{
      if(message.method==='close'){await close();return;}
      let data;
      if(message.method==='arm'){if(message.input!=='afterBusinessCommit')throw Error('Unsupported phase');armed=true;data={armed};}
      else if(message.method==='observe')data={dispatches,media,liveMediaCount:liveMedia.size};
      else if(message.method==='rpc'){
        if(!operations.has(message.input.operation))throw Error('Unsupported operation');
        data=await services.call(message.input.operation,message.input.input);
      }else{if(!taskMethods.has(message.method))throw Error('Unsupported task method');data=await tasks[message.method](message.input);}
      report({type:'reply',id:message.id,data});
    }catch(error){report({type:'reply',id:message.id,error:{code:error.code,message:error.message}});}
  });
  report({type:'ready',pid:process.pid,startup});
}catch(error){process.exitCode=1;report({type:'fatal',code:error.code,message:error.message});await close();}
process.once('disconnect',()=>{close().catch(()=>{process.exitCode=1;});});
