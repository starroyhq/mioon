import path from 'node:path';
import {lstat,readdir} from 'node:fs/promises';
import type {WorkspaceInfo} from '../../../packages/contracts/src/workspace-info.ts';
/** A bounded, non-following inventory. A changed or unreadable entry makes the
 * estimate explicitly incomplete; external targets are never traversed. */
export async function readWorkspaceInfo({root,channel,version,tools,signal,pendingProjectCleanup=0}:{root:string;channel:WorkspaceInfo['channel'];version:string;tools:WorkspaceInfo['tools'];signal:AbortSignal;pendingProjectCleanup?:number}):Promise<WorkspaceInfo>{
  const usage={bytes:0,files:0,complete:true},queue=[root];let entries=0;
  while(queue.length){signal.throwIfAborted();const directory=queue.shift();if(!directory)break;
    try{const metadata=await lstat(directory);if(!metadata.isDirectory()||metadata.isSymbolicLink()){usage.complete=false;continue;}
      for(const name of await readdir(directory)){signal.throwIfAborted();if(++entries>20000){usage.complete=false;queue.length=0;break;}
        const target=path.join(directory,name);try{const stat=await lstat(target);if(stat.isSymbolicLink()){usage.complete=false;continue;}if(stat.isDirectory())queue.push(target);else if(stat.isFile()){usage.files++;usage.bytes+=stat.size;}else usage.complete=false;}catch{usage.complete=false;}}
    }catch{usage.complete=false;}
  }
  return {version,channel,dataDirectory:root,usage,tools,pendingProjectCleanup};
}
