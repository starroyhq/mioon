import path from 'node:path';
import {lstat,opendir,realpath} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {workspaceInfoViewSchema} from '../../../packages/contracts/src/workspace-info.ts';
import type {ApplicationWorkspaceInfo,ApplicationWorkspaceStorageInfo,WorkspaceMetadata,WorkspaceInfo,WorkspaceStorageUsage,WorkspaceInfoView} from '../../../packages/contracts/src/workspace-info.ts';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {PROJECT_RECORDS_DIRECTORY} from '../../../packages/contracts/src/project-file.ts';
import type {AppDirectories} from './project-host/directories.ts';

const MAX_ENTRIES=20_000,MAX_DEPTH=16;
const sameDirectory=(left:BigIntStats,right:BigIntStats):boolean=>right.isDirectory()&&!right.isSymbolicLink()&&left.dev===right.dev&&left.ino===right.ino&&left.birthtimeNs===right.birthtimeNs;
const missing=(error:unknown):boolean=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT');

/** Resolve the configured root, including aliases such as macOS /tmp. Links
 * discovered below this selected root are still never followed. */
async function inventoryRoot(root:string,signal:AbortSignal):Promise<{directory:string;metadata:BigIntStats}|'missing'|'unsafe'>{
  signal.throwIfAborted();let absolute:string;
  try{absolute=await realpath(path.resolve(root));signal.throwIfAborted();}catch(error){signal.throwIfAborted();return missing(error)?'missing':'unsafe';}
  const base=path.parse(absolute).root;
  let current=base,metadata:BigIntStats|undefined;
  for(const name of ['',...absolute.slice(base.length).split(path.sep).filter(Boolean)]){
    signal.throwIfAborted();if(name)current=path.join(current,name);
    try{metadata=await lstat(current,{bigint:true});signal.throwIfAborted();}
    catch(error){signal.throwIfAborted();return missing(error)?'missing':'unsafe';}
    if(!metadata.isDirectory()||metadata.isSymbolicLink())return 'unsafe';
  }
  return {directory:absolute,metadata:metadata!};
}

/** Metadata only: bounded streaming enumeration, no files opened or followed.
 * Totals are estimates; a changed/unreadable entry makes that root incomplete. */
async function inventory(root:string,signal:AbortSignal,missingIsEmpty=false):Promise<WorkspaceStorageUsage>{
  const usage:WorkspaceStorageUsage={bytes:0,files:0,complete:true};
  const initial=await inventoryRoot(root,signal);
  signal.throwIfAborted();
  if(initial==='missing'||initial==='unsafe')return {...usage,complete:initial==='missing'&&missingIsEmpty};
  const queue=[{directory:initial.directory,depth:0,metadata:initial.metadata}];let entries=0,limited=false;
  while(queue.length&&!limited){
    signal.throwIfAborted();const current=queue.shift()!;
    try{
      const before=await lstat(current.directory,{bigint:true});signal.throwIfAborted();
      if(!sameDirectory(current.metadata,before)){usage.complete=false;continue;}
      const directory=await opendir(current.directory,{bufferSize:32});
      try{
        signal.throwIfAborted();
        if(!sameDirectory(before,await lstat(current.directory,{bigint:true}))){usage.complete=false;continue;}
        for(;;){
          signal.throwIfAborted();const entry=await directory.read();signal.throwIfAborted();if(!entry)break;
          if(++entries>MAX_ENTRIES){usage.complete=false;limited=true;break;}
          const target=path.join(current.directory,entry.name);
          try{
            const metadata=await lstat(target,{bigint:true});signal.throwIfAborted();
            if(metadata.isSymbolicLink()){usage.complete=false;continue;}
            if(metadata.isDirectory()){
              if(current.depth>=MAX_DEPTH)usage.complete=false;
              else queue.push({directory:target,depth:current.depth+1,metadata});
            }else if(metadata.isFile()){
              if(metadata.size<0n){usage.complete=false;continue;}
              usage.files++;
              if(metadata.size>BigInt(Number.MAX_SAFE_INTEGER-usage.bytes)){usage.bytes=Number.MAX_SAFE_INTEGER;usage.complete=false;}
              else usage.bytes+=Number(metadata.size);
            }else usage.complete=false;
          }catch{signal.throwIfAborted();usage.complete=false;}
        }
        if(!sameDirectory(before,await lstat(current.directory,{bigint:true})))usage.complete=false;
      }finally{await directory.close();}
    }catch{signal.throwIfAborted();usage.complete=false;}
  }
  signal.throwIfAborted();return usage;
}

interface WorkspaceInfoOptions{root:string;channel:WorkspaceInfo['channel'];version:string;tools:WorkspaceInfo['tools'];signal:AbortSignal;pendingProjectCleanup?:number}
/** Project/native callers retain the base DTO and the whole-root usage. */
export async function readWorkspaceInfo({root,channel,version,tools,signal,pendingProjectCleanup=0}:WorkspaceInfoOptions):Promise<WorkspaceInfo>{
  return {version,channel,dataDirectory:root,usage:await inventory(root,signal),tools,pendingProjectCleanup};
}

/** Application inventories are independent: an external cache is not part of
 * dataDir usage, while a nested/aliased cache must not be summed into it twice. */
type ApplicationInfoOptions=Omit<WorkspaceInfoOptions,'root'>&{directories:Pick<AppDirectories,'dataDir'|'cacheDir'>};
export function workspaceInfoView(parameters:URLSearchParams):WorkspaceInfoView{
  const values=parameters.getAll('view'),parsed=workspaceInfoViewSchema.safeParse(values[0]??'full');
  if(values.length>1||!parsed.success)throw new AppError('VALIDATION_ERROR','工作区信息视图无效。',400);
  return parsed.data;
}
export function readApplicationWorkspaceInfo(options:ApplicationInfoOptions&{view:'metadata'}):Promise<WorkspaceMetadata>;
export function readApplicationWorkspaceInfo(options:ApplicationInfoOptions&{view:'storage'}):Promise<ApplicationWorkspaceStorageInfo>;
export function readApplicationWorkspaceInfo(options:ApplicationInfoOptions&{view?:'full'}):Promise<ApplicationWorkspaceInfo>;
export function readApplicationWorkspaceInfo(options:ApplicationInfoOptions&{view:WorkspaceInfoView}):Promise<ApplicationWorkspaceInfo|WorkspaceMetadata|ApplicationWorkspaceStorageInfo>;
export async function readApplicationWorkspaceInfo({directories,view='full',...options}:ApplicationInfoOptions&{view?:WorkspaceInfoView}):Promise<ApplicationWorkspaceInfo|WorkspaceMetadata|ApplicationWorkspaceStorageInfo>{
  options.signal.throwIfAborted();
  const info:WorkspaceMetadata={version:options.version,channel:options.channel,dataDirectory:directories.dataDir,tools:options.tools,pendingProjectCleanup:options.pendingProjectCleanup??0};
  if(view==='metadata')return info;
  const records=await inventory(path.join(directories.dataDir,PROJECT_RECORDS_DIRECTORY),options.signal,true);
  const cache=await inventory(directories.cacheDir,options.signal,true);
  options.signal.throwIfAborted();
  const result={...info,storage:{records,cache,cacheDirectory:directories.cacheDir}};
  return view==='storage'?result:{...result,usage:await inventory(directories.dataDir,options.signal)};
}
