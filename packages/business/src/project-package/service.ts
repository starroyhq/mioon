import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,rmSync,createWriteStream,createReadStream,renameSync,statSync,existsSync,lstatSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import type {WorkspaceStore} from '../db.ts';
import {projectPackageOptionsSchema} from '../../../contracts/src/project-package.ts';
import type {ProjectPackageOptions,ProjectPackageManifest,ProjectPackageCounts} from '../../../contracts/src/project-package.ts';
import {writeProjectPackage,readProjectPackage,projectPackageError,asProjectPackageError} from './container.ts';
import {collectProject,packageDocumentBytes,buildManifest,createProjectFromDocument,findProjectPackageReceipt} from './document.ts';
import type {ProjectDocument,ProjectPackageReceipt} from './document.ts';

export const PROJECT_PACKAGE_DIRECTORY='project-packages';
const IMPORT_TTL_MS=30*60*1000,MAX_PENDING_IMPORTS=4;

export type ProjectPackagePhase='running'|'ready'|'failed'|'cancelled';
export interface ProjectPackageError {code:string;details?:Record<string,unknown>}
export interface ProjectPackageExportStatus {id:string;kind:'export';projectId:string;phase:ProjectPackagePhase;stage:'writing'|'verifying'|'done';files:number;totalFiles:number;bytes:number;totalBytes:number;fileName:string;error?:ProjectPackageError}
export interface ProjectPackageImportPreview {id:string;kind:'import';name:string;suggestedName:string;nameTaken:boolean;counts:ProjectPackageCounts;totalBytes:number;fileCount:number;appVersion:string;createdAt:string;timeline:{width:number;height:number;fps:number}|null}
export interface ProjectPackageExportPreview {projectId:string;counts:ProjectPackageCounts;totalBytes:number;assets:{total:number;used:number};exports:{count:number;bytes:number};missing:{assetId:string;name:string;reason:'missing'|'changed'}[];warnings:{runningTasks:number}}

interface ExportSession {status:ProjectPackageExportStatus;controller:AbortController;file:string;done:Promise<void>}
interface ImportSession {id:string;directory:string;manifest:ProjectPackageManifest;document:ProjectDocument;files:Map<string,string>;expires:number;committing:boolean;preview:ProjectPackageImportPreview;opened:boolean}

const safeName=(value:string):string=>value.replace(/[\\/:*?"<>|\u0000-\u001f]/gu,'_').trim().slice(0,120)||'project';
const hash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorOf=(error:unknown):ProjectPackageError=>{const value=error as {code?:unknown;details?:unknown};return {code:typeof value?.code==='string'?value.code:'PROJECT_PACKAGE_CORRUPT',...(value?.details&&typeof value.details==='object'?{details:value.details as Record<string,unknown>}:{})};};

/** Local, in-memory sessions: a restart cancels them and the next start clears
 * the private staging directory. Nothing here enters the task center. */
export function createProjectPackageService({store,appVersion,afterCreate=async()=>{}}:{store:WorkspaceStore;appVersion:string;afterCreate?:(result:{projectId:string;jobIds:string[]})=>Promise<void>}){
 const base=path.join(store.root,PROJECT_PACKAGE_DIRECTORY);
 const exports=new Map<string,ExportSession>(),imports=new Map<string,ImportSession>();
 let closed=false;
 const ensureBase=():void=>{
  if(existsSync(base)){const stat=lstatSync(base);if(!stat.isDirectory()||stat.isSymbolicLink())throw projectPackageError('PROJECT_PACKAGE_CORRUPT');}
  else mkdirSync(base,{mode:0o700});
 };
 const fresh=(name:string):string=>{ensureBase();const directory=path.join(base,name);mkdirSync(directory,{mode:0o700});return directory;};
 const running=():boolean=>[...exports.values()].some(session=>session.status.phase==='running');
 const expire=():void=>{const now=Date.now();for(const [id,session] of imports)if(session.expires<now&&!session.committing)discardImport(id);};
 function discardImport(id:string):void{const session=imports.get(id);if(!session)return;imports.delete(id);rmSync(session.directory,{recursive:true,force:true});}
 const projectNames=():Set<string>=>new Set(store.list('projects').map(row=>(row as {name?:string}).name??''));
 function uniqueName(name:string):{suggested:string;taken:boolean}{
  const names=projectNames();if(!names.has(name))return {suggested:name,taken:false};
  for(let index=2;index<1000;index++){const candidate=`${name}（${index}）`.slice(0,150);if(!names.has(candidate))return {suggested:candidate,taken:true};}
  return {suggested:`${name.slice(0,140)}（${Date.now()}）`,taken:true};
 }
 const exportBytes=(projectId:string):{count:number;bytes:number}=>{
  const row=store.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(json_extract(data,'$.sizeBytes')),0) AS bytes FROM assets WHERE projectId=? AND json_extract(data,'$.provenance')='export'").get(projectId) as {count:number;bytes:number};
  return {count:row.count,bytes:row.bytes};
 };
 const name=(projectId:string):string=>{const row=store.get('projects',projectId) as {name?:string}|null;if(!row)throw projectPackageError('PROJECT_PACKAGE_NOT_FOUND');return row.name??'project';};

 return {
  /** Cheap pre-check for the export dialog; media bytes are not read. */
  preview(projectId:string,options:unknown):ProjectPackageExportPreview{
   const parsed=projectPackageOptionsSchema.parse(options);name(projectId);
   const all=collectProject(store,projectId,{...parsed,media:'all'}),used=collectProject(store,projectId,{...parsed,media:'used'});
   const chosen=parsed.media==='all'?all:used;
   return {projectId,counts:chosen.counts,totalBytes:chosen.totalBytes,assets:{total:all.counts.assets,used:used.counts.assets},exports:exportBytes(projectId),missing:chosen.missing,warnings:chosen.warnings};
  },
  startExport(projectId:string,options:unknown):ProjectPackageExportStatus{
   if(closed)throw projectPackageError('PROJECT_PACKAGE_CANCELLED');
   if(running())throw projectPackageError('PROJECT_PACKAGE_BUSY');
   const parsed:ProjectPackageOptions=projectPackageOptionsSchema.parse(options),projectName=name(projectId);
   const collected=collectProject(store,projectId,parsed);
   if(collected.missing.length)throw projectPackageError('PROJECT_PACKAGE_SOURCE_MISSING',{missing:collected.missing});
   const id=randomUUID(),document=packageDocumentBytes(collected.document);
   const manifest=buildManifest({collected,document,appVersion,options:parsed,name:projectName});
   ensureBase();
   const file=path.join(base,`${id}.mioon`),part=`${file}.part`,controller=new AbortController();
   const status:ProjectPackageExportStatus={id,kind:'export',projectId,phase:'running',stage:'writing',files:0,totalFiles:manifest.files.length,bytes:0,totalBytes:manifest.files.reduce((sum,entry)=>sum+entry.bytes,0),fileName:`${safeName(projectName)}.mioon`};
   const done=(async()=>{
    try{
     await pipeline(Readable.from(writeProjectPackage({manifest,document,media:collected.media.map(entry=>entry.source),signal:controller.signal,progress:state=>{status.files=state.files;status.bytes=state.bytes;}})),createWriteStream(part,{flags:'wx',mode:0o600}),{signal:controller.signal});
     status.stage='verifying';
     await readProjectPackage({source:createReadStream(part,{highWaterMark:1024*1024}),destination:null,signal:controller.signal});
     renameSync(part,file);status.stage='done';status.phase='ready';
    }catch(error){
     rmSync(part,{force:true});
     const failure=asProjectPackageError(error,controller.signal);
     status.phase=(failure as {code?:string}).code==='PROJECT_PACKAGE_CANCELLED'?'cancelled':'failed';status.error=errorOf(failure);
    }
   })();
   exports.set(id,{status,controller,file,done});
   return {...status};
  },
  status(id:string):ProjectPackageExportStatus{const session=exports.get(id);if(!session)throw projectPackageError('PROJECT_PACKAGE_NOT_FOUND');return {...session.status};},
  /** The finished file; the caller streams it and may then discard the session. */
  exportFile(id:string):{file:string;bytes:number;fileName:string}{
   const session=exports.get(id);if(!session||session.status.phase!=='ready')throw projectPackageError('PROJECT_PACKAGE_NOT_FOUND');
   return {file:session.file,bytes:statSync(session.file).size,fileName:session.status.fileName};
  },
  async discardExport(id:string):Promise<void>{
   const session=exports.get(id);if(!session)return;
   session.controller.abort();await session.done;exports.delete(id);rmSync(session.file,{force:true});
  },
  /** Stages and verifies an uploaded file; nothing is created until commit.
   * `opened` marks a file the desktop received from the OS (double-click);
   * a window collects it once through takeOpened(). */
  async stageImport(source:AsyncIterable<Uint8Array>,signal?:AbortSignal,{opened=false}:{opened?:boolean}={}):Promise<ProjectPackageImportPreview>{
   if(closed)throw projectPackageError('PROJECT_PACKAGE_CANCELLED');
   expire();
   if(imports.size>=MAX_PENDING_IMPORTS)throw projectPackageError('PROJECT_PACKAGE_BUSY');
   const id=randomUUID(),directory=fresh(id);
   try{
    const read=await readProjectPackage({source,destination:directory,signal});
    const document=read.document as ProjectDocument;
    if(!document||document.formatVersion!==1||!document.project||typeof document.project.name!=='string'||!Array.isArray(document.assets))throw projectPackageError('PROJECT_PACKAGE_INVALID_CONTENT');
    const files=new Map([...read.media].map(([key,value])=>[key,value.file]));
    const {suggested,taken}=uniqueName(read.manifest.project.name),timeline=document.timeline as {width?:number;height?:number;fps?:number}|null;
    const preview:ProjectPackageImportPreview={id,kind:'import',name:read.manifest.project.name,suggestedName:suggested,nameTaken:taken,counts:read.manifest.counts,totalBytes:read.totalBytes,fileCount:read.manifest.files.length,
     appVersion:read.manifest.appVersion,createdAt:read.manifest.createdAt,timeline:timeline&&typeof timeline.width==='number'?{width:timeline.width,height:timeline.height??0,fps:timeline.fps??30}:null};
    imports.set(id,{id,directory,manifest:read.manifest,document,files,expires:Date.now()+IMPORT_TTL_MS,committing:false,preview,opened});
    return preview;
   }catch(error){rmSync(directory,{recursive:true,force:true});throw asProjectPackageError(error,signal);}
  },
  /** Hands out the oldest file opened from the OS, once; the rest wait for
   * the next call so a window shows them one at a time. */
  takeOpened():ProjectPackageImportPreview|null{
   expire();
   for(const session of imports.values())if(session.opened&&!session.committing){
    session.opened=false;const {suggested,taken}=uniqueName(session.manifest.project.name);
    return {...session.preview,suggestedName:suggested,nameTaken:taken};
   }
   return null;
  },
  async commitImport(id:string,input:{requestId:string;name:string}):Promise<{projectId:string}>{
   const receipt:ProjectPackageReceipt={scope:'project-import',requestId:input.requestId,requestHash:hash({id,name:input.name})};
   const replay=findProjectPackageReceipt(store,receipt);if(replay)return replay;
   const session=imports.get(id);if(!session||session.committing)throw projectPackageError('PROJECT_PACKAGE_NOT_FOUND');
   session.committing=true;
   try{
    const result=createProjectFromDocument(store,{document:session.document,files:session.files,name:input.name,move:true,receipt});
    discardImport(id);await afterCreate(result).catch(()=>{});
    return {projectId:result.projectId};
   }catch(error){session.committing=false;throw error;}
  },
  discardImport,
  async duplicate(projectId:string,input:{requestId:string;name:string}):Promise<{projectId:string}>{
   const receipt:ProjectPackageReceipt={scope:'project-duplicate',requestId:input.requestId,requestHash:hash({projectId,name:input.name})};
   const replay=findProjectPackageReceipt(store,receipt);if(replay)return replay;
   if(running())throw projectPackageError('PROJECT_PACKAGE_BUSY');
   const collected=collectProject(store,projectId,{media:'all',includeExports:false});
   if(collected.missing.length)throw projectPackageError('PROJECT_PACKAGE_SOURCE_MISSING',{missing:collected.missing});
   // Live media are copied, never moved; LUT bytes come from the database.
   const directory=fresh(randomUUID()),files=new Map<string,string>();
   try{
    for(const asset of store.list('assets',projectId) as {id:string;relativePath:string}[]){const entry=collected.document.assets.find(item=>item.id===asset.id);if(entry)files.set(entry.media,path.join(store.root,asset.relativePath));}
    for(const entry of collected.media)if(!files.has(entry.path)){const file=path.join(directory,path.basename(entry.path));await pipeline(Readable.from(entry.source.read()),createWriteStream(file,{flags:'wx',mode:0o600}));files.set(entry.path,file);}
    const result=createProjectFromDocument(store,{document:collected.document,files,name:input.name,move:false,receipt});
    await afterCreate(result).catch(()=>{});
    return {projectId:result.projectId};
   }finally{rmSync(directory,{recursive:true,force:true});}
  },
  uniqueName,
  /** Called once at backend start, before any session exists. */
  clearStale():void{if(existsSync(base))rmSync(base,{recursive:true,force:true});},
  async close():Promise<void>{closed=true;for(const id of [...exports.keys()])await this.discardExport(id);for(const id of [...imports.keys()])discardImport(id);},
 };
}
export type ProjectPackageService=ReturnType<typeof createProjectPackageService>;
