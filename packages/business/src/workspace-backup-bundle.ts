import path from 'node:path';
import {constants,openSync,closeSync,fstatSync,writeSync,fsyncSync} from 'node:fs';
import {createReadStream} from 'node:fs';
import {AppError} from '@mioon/contracts';
import {validateManagedDirectory,getWindowsManagedFileIO} from '@mioon/contracts/private-storage';
import {WORKSPACE_BACKUP_LIMITS,isWorkspaceBackupPayloadPath} from '../../contracts/src/workspace-backup.ts';
import {withVerifiedWorkspaceBackup,verifyWorkspaceBackup,type VerifiedWorkspaceBackupContext} from './workspace-backup.ts';
import {createNewDirectory,inspectFile,sameFile,syncDirectory} from './workspace-backup-storage.ts';

// This transfer container keeps format1's manifest and payload byte-for-byte.
// It contains regular files only: no links, compression, external paths or
// platform-specific archive extensions. Restore still uses the old verifier.
const MAGIC=Buffer.from('MIOON-BACKUP-BUNDLE-1\n'),HEADER_BYTES=1024,CHUNK_BYTES=1024*1024;
const LIMIT=WORKSPACE_BACKUP_LIMITS.totalBytes+WORKSPACE_BACKUP_LIMITS.manifestBytes+4096;
const failure=()=>new AppError('WORKSPACE_BACKUP_BUNDLE_INVALID','The backup file is incomplete, changed or unsupported.',400);
const allowed=(name:string)=>name==='manifest.json'||name==='COMPLETE.json'||isWorkspaceBackupPayloadPath(name);
const maxBytes=(name:string)=>name==='manifest.json'?WORKSPACE_BACKUP_LIMITS.manifestBytes:name==='COMPLETE.json'?4096:name==='payload/workbench.sqlite'?WORKSPACE_BACKUP_LIMITS.databaseBytes:WORKSPACE_BACKUP_LIMITS.fileBytes;
function header(name:string,bytes:number):Buffer {const body=Buffer.from(JSON.stringify({path:name,bytes})),size=Buffer.alloc(4);size.writeUInt32BE(body.length);return Buffer.concat([size,body]);}

export async function* exportWorkspaceBackupBundle({directory,signal}:{directory:string;signal?:AbortSignal}):AsyncGenerator<Uint8Array> {
  const context=await withVerifiedWorkspaceBackup({directory,signal},value=>value) as VerifiedWorkspaceBackupContext;
  const names=['manifest.json',...context.files.map(file=>file.entry.path),'COMPLETE.json'];
  yield MAGIC;
  for(const name of names){
    signal?.throwIfAborted();context.checkFiles();
    const file=path.join(directory,name),identity=inspectFile(file,directory,{private:true,maxBytes:maxBytes(name)})!;
    yield header(name,identity.size);
    if(process.platform==='win32'){
      const handle=getWindowsManagedFileIO().openFile(file,{root:directory,private:true,maxBytes:maxBytes(name),mode:'read',expected:identity});let bytes=0;
      try{
        if(!sameFile(identity,handle.metadata()))throw failure();
        for(;;){signal?.throwIfAborted();context.checkFiles();const chunk=handle.read(CHUNK_BYTES);if(!chunk.length)break;bytes+=chunk.length;if(chunk.length>CHUNK_BYTES||bytes>identity.size)throw failure();yield chunk;}
        if(bytes!==identity.size||!sameFile(identity,handle.metadata())||!sameFile(identity,inspectFile(file,directory,{private:true,maxBytes:maxBytes(name)})))throw failure();
      }finally{handle.close();}
      continue;
    }
    const descriptor=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    if(!sameFile(identity,fstatSync(descriptor))){closeSync(descriptor);throw failure();}
    const stream=createReadStream(file,{fd:descriptor,autoClose:true,highWaterMark:CHUNK_BYTES});
    let bytes=0;
    try{for await(const chunk of stream){signal?.throwIfAborted();context.checkFiles();bytes+=chunk.length;if(bytes>identity.size)throw failure();yield chunk;}}
    finally{stream.destroy();}
    if(bytes!==identity.size||!sameFile(identity,inspectFile(file,directory,{private:true,maxBytes:maxBytes(name)})))throw failure();
  }
  await context.recheck();yield Buffer.alloc(4);
}

class BoundedReader {
  private iterator:AsyncIterator<Uint8Array>;
  private buffered=Buffer.alloc(0);
  private signal:AbortSignal|undefined;
  constructor(source:AsyncIterable<Uint8Array>,signal?:AbortSignal){this.iterator=source[Symbol.asyncIterator]();this.signal=signal;}
  async read(length:number):Promise<Buffer>{
    if(length<0||length>CHUNK_BYTES)throw failure();
    const chunks:Buffer[]=[];let remaining=length;
    while(remaining){
      this.signal?.throwIfAborted();
      if(!this.buffered.length){const next=await this.iterator.next();if(next.done||!(next.value instanceof Uint8Array)||next.value.byteLength>CHUNK_BYTES)throw failure();this.buffered=Buffer.from(next.value);if(!this.buffered.length)continue;}
      const size=Math.min(remaining,this.buffered.length);chunks.push(this.buffered.subarray(0,size));this.buffered=this.buffered.subarray(size);remaining-=size;
    }
    return Buffer.concat(chunks,length);
  }
  async end():Promise<void>{if(this.buffered.length)throw failure();const next=await this.iterator.next();if(!next.done)throw failure();}
  async close():Promise<void>{await this.iterator.return?.();}
}

/** destination must be a newly created private directory owned by the caller.
 * Invalid transfers are retained there, never published into the backup list. */
export async function importWorkspaceBackupBundle({source,destination,signal,check=()=>{}}:{source:AsyncIterable<Uint8Array>;destination:string;signal?:AbortSignal;check?:()=>void}):Promise<{fileCount:number;payloadBytes:number}> {
  validateManagedDirectory(destination,{root:destination,private:true});
  const reader=new BoundedReader(source,signal),seen=new Set<string>(),directories=new Set<string>();let total=0;
  try{
    if(!(await reader.read(MAGIC.length)).equals(MAGIC))throw failure();
    for(;;){
      check();signal?.throwIfAborted();const size=(await reader.read(4)).readUInt32BE();if(size===0)break;
      if(size>HEADER_BYTES||seen.size>=WORKSPACE_BACKUP_LIMITS.fileCount+2)throw failure();
      let value:unknown;try{value=JSON.parse((await reader.read(size)).toString('utf8'));}catch{throw failure();}
      if(!value||typeof value!=='object'||Array.isArray(value))throw failure();
      const entry=value as Record<string,unknown>,name=entry.path,bytes=entry.bytes;
      if(Object.keys(entry).sort().join(',')!=='bytes,path'||typeof name!=='string'||!allowed(name)||seen.has(name)||typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<0||bytes>maxBytes(name)||total+bytes>LIMIT)throw failure();
      seen.add(name);total+=bytes;
      const file=path.join(destination,name),parent=path.dirname(file),relativeParent=path.relative(destination,parent);
      if(relativeParent){let current=destination;for(const part of relativeParent.split(path.sep)){current=path.join(current,part);if(!directories.has(current)){createNewDirectory(current,destination);directories.add(current);}}}
      validateManagedDirectory(parent,{root:destination,private:true});
      if(process.platform==='win32'){
        const handle=getWindowsManagedFileIO().openFile(file,{root:destination,private:true,maxBytes:maxBytes(name),mode:'create'});
        try{
          let remaining=bytes;
          while(remaining){check();const chunk=await reader.read(Math.min(remaining,CHUNK_BYTES));handle.write(chunk);remaining-=chunk.length;}
          handle.flush();const saved=handle.metadata();
          if(saved.size!==bytes||!sameFile(saved,inspectFile(file,destination,{private:true,maxBytes:maxBytes(name)})))throw failure();
        }finally{handle.close();}
        continue;
      }
      const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{
        const identity=fstatSync(fd);if(!identity.isFile()||identity.nlink!==1||identity.uid!==process.getuid?.())throw failure();
        let remaining=bytes;
        while(remaining){check();const chunk=await reader.read(Math.min(remaining,CHUNK_BYTES));let offset=0;while(offset<chunk.length)offset+=writeSync(fd,chunk,offset,chunk.length-offset);remaining-=chunk.length;}
        fsyncSync(fd);
      }finally{closeSync(fd);}
    }
    await reader.end();check();
    if(!seen.has('manifest.json')||!seen.has('COMPLETE.json')||!seen.has('payload/workbench.sqlite'))throw failure();
    for(const directory of [...directories].reverse())syncDirectory(directory,destination);syncDirectory(destination,destination);
    const result=await verifyWorkspaceBackup({directory:destination,signal}) as {fileCount:number;payloadBytes:number};check();
    return {fileCount:result.fileCount,payloadBytes:result.payloadBytes};
  }finally{await reader.close();}
}
