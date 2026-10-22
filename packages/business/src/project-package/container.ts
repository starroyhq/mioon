import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,writeSync,fsyncSync} from 'node:fs';
import {AppError} from '@mioon/contracts';
import {validateManagedDirectory,getWindowsManagedFileIO} from '@mioon/contracts/private-storage';
import {
 PROJECT_PACKAGE_FORMAT,PROJECT_PACKAGE_FORMAT_VERSION,PROJECT_PACKAGE_LIMITS,PROJECT_PACKAGE_MANIFEST_PATH,PROJECT_PACKAGE_DOCUMENT_PATH,
 PROJECT_PACKAGE_COMPLETE_PATH,isProjectPackageMediaPath,projectPackageFormatProbeSchema,projectPackageManifestSchema,projectPackageCompleteSchema,
} from '../../../contracts/src/project-package.ts';
import type {ProjectPackageManifest,ProjectPackageComplete,ProjectPackageErrorCode} from '../../../contracts/src/project-package.ts';
import {createNewDirectory,inspectFile,sameFile,syncDirectory} from '../workspace-backup-storage.ts';

// Same framing as the workspace backup bundle: a magic line, then per file a
// 4-byte length, a JSON header {path,bytes} and the raw bytes; a zero length ends it.
export const PROJECT_PACKAGE_MAGIC=Buffer.from('MIOON-PROJECT-1\n');
const {chunkBytes:CHUNK,headerBytes:HEADER,manifestBytes:MANIFEST,documentBytes:DOCUMENT,completeBytes:COMPLETE}=PROJECT_PACKAGE_LIMITS;

const messages:Record<ProjectPackageErrorCode,string>={
 PROJECT_PACKAGE_NOT_MIOON:'This file is not a Mioon project file.',
 PROJECT_PACKAGE_CORRUPT:'The project file is damaged or incomplete.',
 PROJECT_PACKAGE_NEWER_FORMAT:'The project file was made by a newer version of Mioon.',
 PROJECT_PACKAGE_INVALID_CONTENT:'The project in this file is not valid.',
 PROJECT_PACKAGE_MEDIA_REJECTED:'Some media in this file did not pass checks.',
 PROJECT_PACKAGE_NO_SPACE:'There is not enough disk space.',
 PROJECT_PACKAGE_CANCELLED:'The operation was cancelled.',
 PROJECT_PACKAGE_SOURCE_MISSING:'Some media files of this project are missing or changed.',
 PROJECT_PACKAGE_SOURCE_CHANGED:'A media file changed while the project was being exported.',
 PROJECT_PACKAGE_BUSY:'Another project file operation is running.',
 PROJECT_PACKAGE_NOT_FOUND:'The project file operation was not found.',
};
const statuses:Partial<Record<ProjectPackageErrorCode,number>>={PROJECT_PACKAGE_BUSY:409,PROJECT_PACKAGE_NOT_FOUND:404,PROJECT_PACKAGE_SOURCE_MISSING:409,PROJECT_PACKAGE_SOURCE_CHANGED:409,PROJECT_PACKAGE_NO_SPACE:507};
export function projectPackageError(code:ProjectPackageErrorCode,details?:Record<string,unknown>):AppError{
 return new AppError(code,messages[code],statuses[code]??400,details);
}
const fail=(code:ProjectPackageErrorCode,details?:Record<string,unknown>):never=>{throw projectPackageError(code,details);};
/** Maps low-level failures to the package vocabulary; AppErrors pass through. */
export function asProjectPackageError(error:unknown,signal?:AbortSignal):unknown{
 if(error instanceof AppError)return error;
 if(signal?.aborted||(error as {name?:string})?.name==='AbortError')return projectPackageError('PROJECT_PACKAGE_CANCELLED');
 if((error as {code?:string})?.code==='ENOSPC')return projectPackageError('PROJECT_PACKAGE_NO_SPACE');
 return error;
}
const sha256=(value:Uint8Array):string=>createHash('sha256').update(value).digest('hex');
function header(name:string,bytes:number):Buffer{
 const body=Buffer.from(JSON.stringify({path:name,bytes})),size=Buffer.alloc(4);size.writeUInt32BE(body.length);return Buffer.concat([size,body]);
}
function* chunks(value:Buffer):Generator<Buffer>{for(let offset=0;offset<value.length;offset+=CHUNK)yield value.subarray(offset,offset+CHUNK);}

export interface ProjectPackageMediaSource {path:string;read(signal?:AbortSignal):AsyncIterable<Uint8Array>}
export interface ProjectPackageProgress {files:number;bytes:number}

/** Streams a package in manifest order. Media are re-hashed while they are
 * written, so a source that changed after the manifest was built aborts the
 * stream instead of producing a file whose hashes would not verify. */
export async function* writeProjectPackage({manifest,document,media,signal,progress=()=>{}}:{manifest:ProjectPackageManifest;document:Buffer;media:readonly ProjectPackageMediaSource[];signal?:AbortSignal;progress?:(state:ProjectPackageProgress)=>void}):AsyncGenerator<Uint8Array>{
 const parsed=projectPackageManifestSchema.parse(manifest),manifestBytes=Buffer.from(JSON.stringify(parsed));
 if(manifestBytes.length>MANIFEST||document.length>DOCUMENT)fail('PROJECT_PACKAGE_INVALID_CONTENT');
 const [entry,...files]=parsed.files;
 if(!entry||entry.bytes!==document.length||entry.sha256!==sha256(document))fail('PROJECT_PACKAGE_INVALID_CONTENT');
 const sources=new Map(media.map(source=>[source.path,source]));
 if(sources.size!==files.length||files.some(file=>!sources.has(file.path)))fail('PROJECT_PACKAGE_INVALID_CONTENT');
 let written=0,total=document.length;
 yield PROJECT_PACKAGE_MAGIC;
 yield header(PROJECT_PACKAGE_MANIFEST_PATH,manifestBytes.length);yield* chunks(manifestBytes);
 yield header(PROJECT_PACKAGE_DOCUMENT_PATH,document.length);yield* chunks(document);
 progress({files:++written,bytes:total});
 for(const file of files){
  signal?.throwIfAborted();
  yield header(file.path,file.bytes);
  const hash=createHash('sha256');let bytes=0;
  for await(const value of sources.get(file.path)!.read(signal)){
   signal?.throwIfAborted();
   const chunk=Buffer.from(value.buffer,value.byteOffset,value.byteLength);
   bytes+=chunk.length;if(bytes>file.bytes)fail('PROJECT_PACKAGE_SOURCE_CHANGED',{path:file.path});
   hash.update(chunk);yield* chunks(chunk);total+=chunk.length;progress({files:written,bytes:total});
  }
  if(bytes!==file.bytes||hash.digest('hex')!==file.sha256)fail('PROJECT_PACKAGE_SOURCE_CHANGED',{path:file.path});
  progress({files:++written,bytes:total});
 }
 const complete:ProjectPackageComplete={format:PROJECT_PACKAGE_FORMAT,formatVersion:PROJECT_PACKAGE_FORMAT_VERSION,manifestSha256:sha256(manifestBytes),fileCount:parsed.files.length,totalBytes:total};
 const completeBytes=Buffer.from(JSON.stringify(complete));
 yield header(PROJECT_PACKAGE_COMPLETE_PATH,completeBytes.length);yield completeBytes;
 yield Buffer.alloc(4);
}

class BoundedReader {
 private iterator:AsyncIterator<Uint8Array>;
 private buffered=Buffer.alloc(0);
 private signal:AbortSignal|undefined;
 constructor(source:AsyncIterable<Uint8Array>,signal?:AbortSignal){this.iterator=source[Symbol.asyncIterator]();this.signal=signal;}
 async read(length:number,code:ProjectPackageErrorCode='PROJECT_PACKAGE_CORRUPT'):Promise<Buffer>{
  if(length<0||length>CHUNK)fail('PROJECT_PACKAGE_CORRUPT');
  const parts:Buffer[]=[];let remaining=length;
  while(remaining){
   this.signal?.throwIfAborted();
   if(!this.buffered.length){
    const next=await this.iterator.next();
    if(next.done||!(next.value instanceof Uint8Array))fail(code);
    this.buffered=Buffer.from(next.value.buffer,next.value.byteOffset,next.value.byteLength);if(!this.buffered.length)continue;
   }
   const size=Math.min(remaining,this.buffered.length);parts.push(this.buffered.subarray(0,size));this.buffered=this.buffered.subarray(size);remaining-=size;
  }
  return Buffer.concat(parts,length);
 }
 async end():Promise<void>{if(this.buffered.length)fail('PROJECT_PACKAGE_CORRUPT');const next=await this.iterator.next();if(!next.done)fail('PROJECT_PACKAGE_CORRUPT');}
 async close():Promise<void>{await this.iterator.return?.();}
}

export interface StagedProjectPackageFile {path:string;file:string;bytes:number;sha256:string}
export interface ReadProjectPackageResult {manifest:ProjectPackageManifest;document:unknown;media:Map<string,StagedProjectPackageFile>;totalBytes:number}

async function readEntryHeader(reader:BoundedReader):Promise<{path:string;bytes:number}|null>{
 const size=(await reader.read(4)).readUInt32BE();
 if(size===0)return null;
 if(size>HEADER)fail('PROJECT_PACKAGE_CORRUPT');
 let value:unknown;try{value=JSON.parse((await reader.read(size)).toString('utf8'));}catch{fail('PROJECT_PACKAGE_CORRUPT');}
 if(!value||typeof value!=='object'||Array.isArray(value))fail('PROJECT_PACKAGE_CORRUPT');
 const entry=value as Record<string,unknown>;
 if(Object.keys(entry).sort().join(',')!=='bytes,path'||typeof entry.path!=='string'||typeof entry.bytes!=='number'||!Number.isSafeInteger(entry.bytes)||entry.bytes<0)fail('PROJECT_PACKAGE_CORRUPT');
 return {path:entry.path as string,bytes:entry.bytes as number};
}
async function readSmall(reader:BoundedReader,bytes:number):Promise<Buffer>{
 const parts:Buffer[]=[];let remaining=bytes;
 while(remaining){const chunk=await reader.read(Math.min(remaining,CHUNK));parts.push(chunk);remaining-=chunk.length;}
 return Buffer.concat(parts,bytes);
}
function parseManifest(bytes:Buffer):ProjectPackageManifest{
 let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('PROJECT_PACKAGE_CORRUPT');}
 const probe=projectPackageFormatProbeSchema.safeParse(value);
 if(!probe.success)throw projectPackageError('PROJECT_PACKAGE_CORRUPT');
 if(probe.data.formatVersion>PROJECT_PACKAGE_FORMAT_VERSION)throw projectPackageError('PROJECT_PACKAGE_NEWER_FORMAT',{formatVersion:probe.data.formatVersion,supported:PROJECT_PACKAGE_FORMAT_VERSION});
 const manifest=projectPackageManifestSchema.safeParse(value);
 if(!manifest.success)throw projectPackageError('PROJECT_PACKAGE_CORRUPT');
 return manifest.data;
}
async function writeStagedFile(reader:BoundedReader,file:string|null,root:string,bytes:number,check:()=>void,advance:(size:number)=>void):Promise<string>{
 const hash=createHash('sha256');
 if(file===null){
  let remaining=bytes;
  while(remaining){check();const chunk=await reader.read(Math.min(remaining,CHUNK));hash.update(chunk);remaining-=chunk.length;advance(chunk.length);}
  return hash.digest('hex');
 }
 if(process.platform==='win32'){
  const handle=getWindowsManagedFileIO().openFile(file,{root,private:true,maxBytes:PROJECT_PACKAGE_LIMITS.fileBytes,mode:'create'});
  try{
   let remaining=bytes;
   while(remaining){check();const chunk=await reader.read(Math.min(remaining,CHUNK));handle.write(chunk);hash.update(chunk);remaining-=chunk.length;advance(chunk.length);}
   handle.flush();const saved=handle.metadata();
   if(saved.size!==bytes||!sameFile(saved,inspectFile(file,root,{private:true,maxBytes:PROJECT_PACKAGE_LIMITS.fileBytes})))fail('PROJECT_PACKAGE_CORRUPT');
  }finally{handle.close();}
  return hash.digest('hex');
 }
 const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{
  const identity=fstatSync(fd);if(!identity.isFile()||identity.nlink!==1||identity.uid!==process.getuid?.())fail('PROJECT_PACKAGE_CORRUPT');
  let remaining=bytes;
  while(remaining){
   check();const chunk=await reader.read(Math.min(remaining,CHUNK));
   let offset=0;while(offset<chunk.length)offset+=writeSync(fd,chunk,offset,chunk.length-offset);
   hash.update(chunk);remaining-=chunk.length;advance(chunk.length);
  }
  fsyncSync(fd);
 }finally{closeSync(fd);}
 return hash.digest('hex');
}

/** Reads a package into `destination`, a newly created private directory owned
 * by the caller. Entries must follow the manifest order and match its sizes and
 * hashes; the caller validates the returned document and discards the
 * directory on any failure. */
export async function readProjectPackage({source,destination,signal,check=()=>{},progress=()=>{}}:{source:AsyncIterable<Uint8Array>;destination:string|null;signal?:AbortSignal;check?:()=>void;progress?:(state:ProjectPackageProgress)=>void}):Promise<ReadProjectPackageResult>{
 if(destination!==null)validateManagedDirectory(destination,{root:destination,private:true});
 const reader=new BoundedReader(source,signal),guard=():void=>{check();signal?.throwIfAborted();};
 try{
  if(!(await reader.read(PROJECT_PACKAGE_MAGIC.length,'PROJECT_PACKAGE_NOT_MIOON')).equals(PROJECT_PACKAGE_MAGIC))fail('PROJECT_PACKAGE_NOT_MIOON');
  const first=await readEntryHeader(reader);
  if(!first||first.path!==PROJECT_PACKAGE_MANIFEST_PATH||first.bytes>MANIFEST)fail('PROJECT_PACKAGE_CORRUPT');
  const manifestBytes=await readSmall(reader,first!.bytes),manifest=parseManifest(manifestBytes);
  const mediaDirectory=destination===null?'':path.join(destination,'media'),media=new Map<string,StagedProjectPackageFile>();
  let document:unknown,files=0,total=0,directory=false;
  for(const expected of manifest.files){
   guard();
   const entry=await readEntryHeader(reader);
   if(!entry||entry.path!==expected.path||entry.bytes!==expected.bytes)fail('PROJECT_PACKAGE_CORRUPT');
   if(expected.path===PROJECT_PACKAGE_DOCUMENT_PATH){
    if(expected.bytes>DOCUMENT)fail('PROJECT_PACKAGE_CORRUPT');
    const bytes=await readSmall(reader,expected.bytes);
    if(sha256(bytes)!==expected.sha256)fail('PROJECT_PACKAGE_CORRUPT');
    try{document=JSON.parse(bytes.toString('utf8'));}catch{fail('PROJECT_PACKAGE_INVALID_CONTENT');}
    total+=bytes.length;
   }else{
    if(!isProjectPackageMediaPath(expected.path))fail('PROJECT_PACKAGE_CORRUPT');
    if(destination!==null&&!directory){createNewDirectory(mediaDirectory,destination);directory=true;}
    const file=destination===null?null:path.join(destination,expected.path);
    const digest=await writeStagedFile(reader,file,destination??'',expected.bytes,guard,size=>{total+=size;progress({files,bytes:total});});
    if(digest!==expected.sha256)fail('PROJECT_PACKAGE_CORRUPT');
    media.set(expected.path,{path:expected.path,file:file??'',bytes:expected.bytes,sha256:digest});
   }
   progress({files:++files,bytes:total});
  }
  const last=await readEntryHeader(reader);
  if(!last||last.path!==PROJECT_PACKAGE_COMPLETE_PATH||last.bytes>COMPLETE)fail('PROJECT_PACKAGE_CORRUPT');
  let complete:unknown;try{complete=JSON.parse((await readSmall(reader,last!.bytes)).toString('utf8'));}catch{fail('PROJECT_PACKAGE_CORRUPT');}
  const marker=projectPackageCompleteSchema.safeParse(complete);
  if(!marker.success||marker.data.manifestSha256!==sha256(manifestBytes)||marker.data.fileCount!==manifest.files.length||marker.data.totalBytes!==total)fail('PROJECT_PACKAGE_CORRUPT');
  if(await readEntryHeader(reader)!==null)fail('PROJECT_PACKAGE_CORRUPT');
  await reader.end();guard();
  if(destination!==null){if(directory)syncDirectory(mediaDirectory,destination);syncDirectory(destination,destination);}
  return {manifest,document,media,totalBytes:total};
 }catch(error){throw asProjectPackageError(error,signal);}
 finally{await reader.close();}
}
