import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,writeSync,fsyncSync,renameSync,unlinkSync,lstatSync,realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {workspaceNativeRequestSchema} from '../../../packages/contracts/src/workspace-native.ts';
import {exportOutputSchema,type ExportOutput} from '../../../packages/contracts/src/export-controls.ts';
import {parseProjectApiPath} from '../../../packages/contracts/src/project-file.ts';
import {isProjectFileHeld} from '@mioon/business/project-file/held-files';
import {isAppLibraryHeld} from '@mioon/business/app-db/connection';
import {computeFullSha256,isInsideRealDirectory,referencePathForRealFile} from '@mioon/business/media-reference/index';
interface Owner {projectId?:string;isCurrent():boolean}
interface Options<E>{ownerForEvent(event:E):Owner|null;readWorkspaceRoot(projectId:string):Promise<string>;readExport(identity:{projectId:string;exportId:string}):Promise<unknown>;openPath(file:string):Promise<string>;revealPath(file:string):void;restart():Promise<boolean>;chooseSaveFile?(suggestedName:string):Promise<string|null>;fetchProjectPackage?(exportId:string):Promise<Response>}
const unavailable=()=>Object.assign(new Error('Native workspace action is unavailable.'),{code:'WORKSPACE_NATIVE_UNAVAILABLE'});
const same=(a:BigIntStats,b:BigIntStats):boolean=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
/** Fixed authenticated metadata reads for the current backend lifetime: the
 * app-level RPC, workspace information, or one project's RPC. */
export async function readNativeBackendMetadata({base,token,resource,input,signal,check}:{base:string;token:string;resource:string;input?:object;signal:AbortSignal;check:()=>void}):Promise<unknown> {
 const route=parseProjectApiPath(resource),projectInfo=route?.kind==='other'&&route.segments.length===1&&route.segments[0]==='workspace-info';
 if(resource!=='/api/rpc'&&resource!=='/api/ui-preferences'&&route?.kind!=='rpc'&&!projectInfo)throw unavailable();
 check();const response=await fetch(new URL(resource,base),{method:input?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 const reader=response.body?.getReader();if(!reader)throw unavailable();let content='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
 try{for(;;){const next=await reader.read();if(next.done)break;check();bytes+=next.value.byteLength;if(bytes>256*1024)throw unavailable();content+=decoder.decode(next.value,{stream:true});}content+=decoder.decode();}
 catch{await reader.cancel().catch(()=>{});throw unavailable();}finally{reader.releaseLock();}
 check();let value:unknown;try{value=JSON.parse(content);}catch{throw unavailable();}
 if(!response.ok||!value||typeof value!=='object'||!('ok' in value)||value.ok!==true||!('data' in value))throw unavailable();return value.data;
}
/** Native effects consume only a backend-verified export descriptor. Project
 * media is ordinary storage; L1 supplies header/sample/full-hash admission,
 * held-file exclusion and descriptor identity fences on both platforms. */
async function verifyExport(root:string,output:ExportOutput,check:()=>void):Promise<()=>void> {
 try{
  check();
  const proof=output.publication;
  if(!proof||proof.projectId!==output.projectId||proof.assetId!==output.assetId||proof.owner.kind!=='export'||proof.owner.id!==output.exportId||proof.targetKind!=='exports'||proof.sha256!==output.sha256||proof.sizeBytes!==output.sizeBytes||proof.mimeType!=='video/mp4'||!path.isAbsolute(root)||path.resolve(root)!==root||!path.isAbsolute(output.fileLocation)||path.resolve(output.fileLocation)!==output.fileLocation||output.producer.kind!=='export'||output.producer.id!==output.exportId)throw unavailable();
  const realRoot=realpathSync(root),file=realpathSync(output.fileLocation),directory=path.join(realRoot,'导出');
  if(file!==output.fileLocation||path.dirname(file)!==directory||path.relative(realRoot,file).split(path.sep).join('/')!==proof.projectRelativePath||!isInsideRealDirectory(realRoot,file))throw unavailable();
  const projectIdentity=lstatSync(realRoot,{bigint:true}),directoryIdentity=lstatSync(directory,{bigint:true}),identity=lstatSync(file,{bigint:true});
  if(!projectIdentity.isDirectory()||!directoryIdentity.isDirectory()||directoryIdentity.isSymbolicLink()||realpathSync(directory)!==directory||!identity.isFile()||identity.isSymbolicLink()||identity.size!==BigInt(output.sizeBytes))throw unavailable();
  const held=(info:BigIntStats):boolean=>{const id={dev:String(info.dev),ino:String(info.ino)};return isProjectFileHeld(id)||isAppLibraryHeld(id);};
  if(held(identity))throw unavailable();
  const current=():void=>{
   check();
   const actual=lstatSync(file,{bigint:true}),parent=lstatSync(realRoot,{bigint:true}),outputDirectory=lstatSync(directory,{bigint:true});
   if(realpathSync(root)!==realRoot||!parent.isDirectory()||parent.dev!==projectIdentity.dev||parent.ino!==projectIdentity.ino||!outputDirectory.isDirectory()||outputDirectory.isSymbolicLink()||outputDirectory.dev!==directoryIdentity.dev||outputDirectory.ino!==directoryIdentity.ino||realpathSync(directory)!==directory||realpathSync(file)!==file||!actual.isFile()||!same(identity,actual)||held(actual))throw unavailable();
  };
  if(process.platform==='win32')await verifyWindowsExport(realRoot,output,current);
  else await verifyOrdinaryExport(realRoot,output,current);
  current();return current;
 }catch{throw unavailable();}
}
async function verifyOrdinaryExport(root:string,output:ExportOutput,check:()=>void):Promise<void>{
 const reference={...referencePathForRealFile(root,output.fileLocation,true),...output.fingerprint};
 const verified=await computeFullSha256({projectDir:root,projectFile:path.join(root,'project.mioon'),mayReadOutside:()=>false,
  isHeld:id=>isProjectFileHeld(id)||isAppLibraryHeld(id)},reference,{maxBytes:8*1024**3,beforeEffect:check});
 if(verified.sha256!==output.sha256||verified.reference.sizeBytes!==output.sizeBytes)throw unavailable();
 check();
}
/** Windows ordinary media uses the same bigint volume/file-index identity and
 * L1 descriptor reader as other asset references. Private-storage ACL/single-
 * link readers remain reserved for app/local/cache/temp files. */
async function verifyWindowsExport(root:string,output:ExportOutput,check:()=>void):Promise<void>{
 await verifyOrdinaryExport(root,output,check);
}
/** Renderer input contains only fixed actions and export identities. Paths come
 * from the OS picker or a verified current backend response, never IPC input. */
const PACKAGE_TOKEN_TTL_MS=2*60*60*1000;
/** Streams a finished backend package to a part file beside the destination,
 * then renames it; the save dialog already confirmed any overwrite. */
async function writeProjectPackage(response:Response,destination:string,check:()=>void):Promise<void>{
 const expected=Number(response.headers.get('content-length'));
 if(!response.ok||!response.body||!Number.isSafeInteger(expected))throw unavailable();
 const part=`${destination}.part`,fd=openSync(part,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let bytes=0,done=false;
 try{
  for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){check();let offset=0;while(offset<chunk.length)offset+=writeSync(fd,chunk,offset,chunk.length-offset);bytes+=chunk.length;}
  if(bytes!==expected)throw unavailable();fsyncSync(fd);done=true;
 }finally{closeSync(fd);if(!done){try{unlinkSync(part);}catch{}}}
 renameSync(part,destination);
}
export function createWorkspaceNativeHost<E>(options:Options<E>) {
 let busy=false;
 const destinations=new Map<string,{file:string;expires:number}>();
 const destination=(token:string):string=>{const entry=destinations.get(token);if(!entry||entry.expires<Date.now()){destinations.delete(token);throw unavailable();}return entry.file;};
 return {async dispatch(event:E,raw:unknown):Promise<unknown>{
  const request=workspaceNativeRequestSchema.parse(raw),owner=options.ownerForEvent(event);if(!owner||busy)throw unavailable();
  const check=()=>{if(!owner.isCurrent())throw unavailable();};check();
  if((request.action==='openExport'||request.action==='revealExport')&&owner.projectId&&owner.projectId!==request.identity.projectId)throw unavailable();
  busy=true;
  try{
   if(request.action==='restart'){return await options.restart();}
   if(request.action==='chooseProjectPackageDestination'){
    if(!options.chooseSaveFile)throw unavailable();
    const selected=await options.chooseSaveFile(request.suggestedName);check();if(selected===null)return null;
    if(!path.isAbsolute(selected)||path.resolve(selected)!==selected)throw unavailable();
    const file=selected.toLowerCase().endsWith('.mioon')?selected:`${selected}.mioon`,token=randomUUID();
    destinations.set(token,{file,expires:Date.now()+PACKAGE_TOKEN_TTL_MS});return {token,fileName:path.basename(file)};
   }
   if(request.action==='saveProjectPackage'){
    if(!options.fetchProjectPackage)throw unavailable();
    const file=destination(request.token);
    await writeProjectPackage(await options.fetchProjectPackage(request.exportId),file,check);check();return {fileName:path.basename(file)};
   }
   if(request.action==='revealProjectPackage'){options.revealPath(destination(request.token));return true;}
   const identity=request.identity;
   const readOutput=async():Promise<ExportOutput>=>{try{const result=exportOutputSchema.parse(await options.readExport(identity));check();if(result.projectId!==identity.projectId||result.exportId!==identity.exportId)throw unavailable();return result;}catch{throw unavailable();}};
   const output=await readOutput(),root=await options.readWorkspaceRoot(identity.projectId);check();
   const current=await verifyExport(root,output,check);check();
   // An async hash is not authority for a later revision or a different owner.
   // Re-read the exact authenticated export immediately before the shell effect.
   if(JSON.stringify(await readOutput())!==JSON.stringify(output))throw unavailable();
   current();check();
   if(request.action==='openExport')return (await options.openPath(output.fileLocation))==='';
   options.revealPath(output.fileLocation);return true;
  }finally{busy=false;}
 }};
}
