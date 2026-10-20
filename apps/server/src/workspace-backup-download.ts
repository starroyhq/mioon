import type {ServerResponse} from 'node:http';
/** One bounded stream owns its cancellation. A closed browser must not leave a
 * file iterator waiting for a drain event that can no longer arrive. */
export async function sendWorkspaceBackup(res:ServerResponse,id:string,read:(signal:AbortSignal)=>AsyncIterable<Uint8Array>,ownerSignal:AbortSignal):Promise<void>{
  const closed=new AbortController(),signal=AbortSignal.any([ownerSignal,closed.signal]);
  const close=()=>closed.abort();res.once('close',close);
  const write=async(chunk:Uint8Array)=>{
    signal.throwIfAborted();if(res.write(chunk))return;
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{res.off('drain',drain);res.off('error',fail);signal.removeEventListener('abort',abort);};
      const drain=()=>{cleanup();resolve();},fail=(error:Error)=>{cleanup();reject(error);},abort=()=>{cleanup();reject(signal.reason);};
      res.once('drain',drain);res.once('error',fail);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  };
  const iterator=read(signal)[Symbol.asyncIterator]();
  try{
    const first=await iterator.next();signal.throwIfAborted();
    res.writeHead(200,{'Content-Type':'application/vnd.mioon.workspace-backup','Content-Disposition':`attachment; filename="${id}.mioon-backup"`,'Cache-Control':'no-store'});
    if(!first.done)await write(first.value);
    for(;;){const next=await iterator.next();if(next.done)break;await write(next.value);}
    res.end();
  }finally{closed.abort();res.off('close',close);await iterator.return?.();}
}
