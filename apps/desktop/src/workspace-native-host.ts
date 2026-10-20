import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream,constants,openSync,fstatSync,closeSync} from 'node:fs';
import {ensurePrivateDirectory,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import {workspaceNativeRequestSchema} from '../../../packages/contracts/src/workspace-native.ts';
import {workspaceSettingsSchema,type WorkspaceSettings} from '../../../packages/contracts/src/workspace-configuration.ts';
import {exportOutputSchema,type ExportOutput} from '../../../packages/contracts/src/export-controls.ts';
interface Owner {projectId?:string;isCurrent():boolean}
interface Options<E>{ownerForEvent(event:E):Owner|null;chooseDirectory():Promise<string|null>;setBackupDirectory(directory:string):Promise<unknown>;readSettings():Promise<WorkspaceSettings>;readWorkspaceRoot():Promise<string>;readExport(identity:{projectId:string;exportId:string}):Promise<unknown>;openPath(file:string):Promise<string>;revealPath(file:string):void;restart():Promise<boolean>}
const unavailable=()=>Object.assign(new Error('Native workspace action is unavailable.'),{code:'WORKSPACE_NATIVE_UNAVAILABLE'});
const same=(a:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number},b:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number})=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
/** Fixed authenticated metadata reads for the current backend lifetime. */
export async function readNativeBackendMetadata({base,token,resource,input,signal,check}:{base:string;token:string;resource:'/api/rpc'|'/api/workspace-info';input?:object;signal:AbortSignal;check:()=>void}):Promise<unknown> {
 check();const response=await fetch(new URL(resource,base),{method:input?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 const reader=response.body?.getReader();if(!reader)throw unavailable();let content='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
 try{for(;;){const next=await reader.read();if(next.done)break;check();bytes+=next.value.byteLength;if(bytes>256*1024)throw unavailable();content+=decoder.decode(next.value,{stream:true});}content+=decoder.decode();}
 catch{await reader.cancel().catch(()=>{});throw unavailable();}finally{reader.releaseLock();}
 check();let value:unknown;try{value=JSON.parse(content);}catch{throw unavailable();}
 if(!response.ok||!value||typeof value!=='object'||!('ok' in value)||value.ok!==true||!('data' in value))throw unavailable();return value.data;
}
async function verifyExport(root:string,output:ExportOutput,check:()=>void) {
 validatePrivateDirectory(root);if(!path.isAbsolute(output.fileLocation)||path.resolve(output.fileLocation)!==output.fileLocation||path.dirname(output.fileLocation)!==path.join(root,'media'))throw unavailable();
 const identity=validateManagedFile(output.fileLocation,{root})!;if(identity.size!==output.sizeBytes)throw unavailable();
 const fd=openSync(output.fileLocation,constants.O_RDONLY|constants.O_NOFOLLOW);if(!same(identity,fstatSync(fd))){closeSync(fd);throw unavailable();}
 const stream=createReadStream(output.fileLocation,{fd,autoClose:true,highWaterMark:1024*1024}),hash=createHash('sha256');let bytes=0;
 try{for await(const chunk of stream){check();bytes+=chunk.length;if(bytes>output.sizeBytes)throw unavailable();hash.update(chunk);}}finally{stream.destroy();}
 check();const after=validateManagedFile(output.fileLocation,{root});if(!after||!same(identity,after)||bytes!==output.sizeBytes||hash.digest('hex')!==output.sha256)throw unavailable();
}
/** Renderer input contains only fixed actions and export identities. Paths come
 * from the OS picker or a verified current backend response, never IPC input. */
export function createWorkspaceNativeHost<E>(options:Options<E>) {
 let busy=false;
 return {async dispatch(event:E,raw:unknown):Promise<unknown>{
  const request=workspaceNativeRequestSchema.parse(raw),owner=options.ownerForEvent(event);if(!owner||busy)throw unavailable();
  const check=()=>{if(!owner.isCurrent())throw unavailable();};check();
  if((request.action==='openExport'||request.action==='revealExport')&&owner.projectId&&owner.projectId!==request.identity.projectId)throw unavailable();
  busy=true;
  try{
   if(request.action==='restart'){return await options.restart();}
   if(request.action==='chooseBackupLocation'){
    const selected=await options.chooseDirectory();check();if(selected===null)return null;
    if(!path.isAbsolute(selected)||path.resolve(selected)!==selected)throw unavailable();
    const directory=path.join(selected,'Mioon Backups');ensurePrivateDirectory(directory,{create:true});check();
    const saved=workspaceSettingsSchema.parse(await options.setBackupDirectory(directory));check();if(saved.backupDirectory!==directory)throw unavailable();return saved;
   }
   if(request.action==='revealBackupLocation'){
    const settings=workspaceSettingsSchema.parse(await options.readSettings());check();validatePrivateDirectory(settings.backupDirectory);
    return (await options.openPath(settings.backupDirectory))==='';
   }
   const identity=request.identity,output=exportOutputSchema.parse(await options.readExport(identity));check();
   if(output.projectId!==identity.projectId||output.exportId!==identity.exportId)throw unavailable();
   const root=await options.readWorkspaceRoot();check();await verifyExport(root,output,check);check();
   if(request.action==='openExport')return (await options.openPath(output.fileLocation))==='';
   options.revealPath(output.fileLocation);return true;
  }finally{busy=false;}
 }};
}
