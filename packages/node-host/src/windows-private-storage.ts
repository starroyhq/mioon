import path from 'node:path';
import {lstatSync,type Stats} from 'node:fs';
import {PrivateStorageError,bindWindowsPrivateStorageIdentity,privateStorageIdentity} from '@mioon/contracts/private-storage';
import type {WindowsPrivateStorageBackend,ManagedFileOptions,WindowsManagedFileIO} from '@mioon/contracts/private-storage';
interface NativeOptions {root?:string;kind:'file'|'directory';create?:boolean;allowMissing?:boolean;private?:boolean;maxBytes?:number}
interface NativeInspection {metadata:Stats;volume:string;fileId:string}
interface NativeLease {metadata():NativeInspection;read(size:number):Buffer;write(bytes:Buffer):void;flush():void;next():string|null;close():void}
interface NativeManagedOptions extends NativeOptions {mode?:'read'|'create'|'flush';expectedVolume?:string;expectedFileId?:string}
export interface WindowsStorageNative {
  apiVersion:1;
  assertAvailable():void;
  inspect(file:string,options:NativeOptions,metadata:()=>Stats):NativeInspection|null;
  read(file:string,options:NativeOptions):Buffer|null;
  write(file:string,bytes:Uint8Array,options:NativeOptions&{replace:boolean}):void;
  remove(file:string,options:NativeOptions):void;
  temporary(parent:string,prefix:string):string;
  openManagedFile?(file:string,options:NativeManagedOptions,metadata:()=>Stats):NativeLease;
  openManagedDirectory?(directory:string,options:NativeManagedOptions,metadata:()=>Stats):NativeLease;
  createManagedDirectory?(directory:string,options:NativeManagedOptions,metadata:()=>Stats):NativeInspection;
  syncManagedDirectory?(directory:string,options:NativeManagedOptions):void;
  renameManaged?(source:string,destination:string,options:NativeManagedOptions,metadata:()=>Stats):NativeInspection;
  removeManaged?(file:string,options:NativeManagedOptions):void;
}
const unavailable=()=>new PrivateStorageError('WINDOWS_ACL_UNIMPLEMENTED','The complete Windows private storage helper is unavailable.','STORAGE_PRIVACY_UNAVAILABLE');
const failure=(error:unknown):never=>{
  if(error instanceof PrivateStorageError)throw error;
  const reason=error!==null&&typeof error==='object'?(error as {reason?:unknown}).reason:undefined;
  const allowed=['INVALID_PATH','UNSAFE_ALIAS','UNSUPPORTED_FILESYSTEM','REPARSE_POINT','FOREIGN_OWNER','UNSAFE_ACL','FILE_TYPE','HARD_LINK','FILE_CHANGED','MISSING','ALREADY_EXISTS','SIZE_LIMIT','IO_ERROR'];
  throw new PrivateStorageError(typeof reason==='string'&&allowed.includes(reason)?reason:'IO_ERROR','Windows private storage validation or operation failed; existing data was not repaired.');
};
function maximum(value:unknown,fallback=4096):number {
  const size=value??fallback;if(typeof size!=='number'||!Number.isSafeInteger(size)||size<0||size>64*1024*1024)throw new PrivateStorageError('INVALID_LIMIT','A safe storage byte limit is required.');return size;
}
export function createWindowsPrivateStorageBackend(native:WindowsStorageNative):WindowsPrivateStorageBackend {
  if(process.platform!=='win32'||native?.apiVersion!==1||['assertAvailable','inspect','read','write','remove','temporary'].some(name=>typeof (native as unknown as Record<string,unknown>)[name]!=='function'))throw unavailable();
  const safely=<T>(work:()=>T):T=>{try{return work();}catch(error){return failure(error);}};
  const metadata=(result:NativeInspection):Stats=>{bindWindowsPrivateStorageIdentity(result.metadata,result.volume,result.fileId);return result.metadata;};
  const inspect=(file:string,options:NativeOptions)=>safely(()=>{
    // The native walk keeps every verified component/leaf handle pinned while
    // this fixed callback obtains real Node metadata. CRT descriptors are not
    // interchangeable between a Node-API addon and the host Node process.
    const result=native.inspect(file,options,()=>lstatSync(file));if(result===null)return null;
    return metadata(result);
  });
  const managed=(file:string,options:ManagedFileOptions,kind:'file'|'directory'):NativeOptions=>({...options,root:options.root??path.dirname(file),kind,...(options.maxBytes===undefined?{}:{maxBytes:maximum(options.maxBytes)})});
  const streamMaximum=(value:number|undefined):number=>{const size=value??8*1024*1024*1024;if(!Number.isSafeInteger(size)||size<0||size>8*1024*1024*1024)throw new PrivateStorageError('INVALID_LIMIT','A safe streaming storage byte limit is required.');return size;};
  const expected=(info:Stats):{expectedVolume:string;expectedFileId:string}=>{const identity=privateStorageIdentity(info),parts=/^windows:([a-f0-9]{16}):([a-f0-9]{32})$/u.exec(identity);if(!parts)throw unavailable();return {expectedVolume:parts[1]!,expectedFileId:parts[2]!};};
  const streamFunctions=['openManagedFile','openManagedDirectory','createManagedDirectory','syncManagedDirectory','renameManaged','removeManaged'] as const;
  const managedFileIO:WindowsManagedFileIO|undefined=streamFunctions.every(name=>typeof native[name]==='function')?Object.freeze({
    openFile:(file,options)=>safely(()=>{const lease=native.openManagedFile!(file,{...options,kind:'file',maxBytes:streamMaximum(options.maxBytes),...(options.expected?expected(options.expected):{})},()=>lstatSync(file));return Object.freeze({
      metadata:()=>safely(()=>metadata(lease.metadata())),
      read:(size:number)=>safely(()=>{if(!Number.isInteger(size)||size<1||size>1024*1024)throw new PrivateStorageError('INVALID_LIMIT','A safe streaming chunk size is required.');const result=lease.read(size);if(!Buffer.isBuffer(result)||result.length>size)throw unavailable();return result;}),
      write:(bytes:Uint8Array)=>safely(()=>{if(!(bytes instanceof Uint8Array)||bytes.byteLength>1024*1024)throw new PrivateStorageError('INVALID_LIMIT','A safe streaming chunk size is required.');lease.write(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes));}),
      flush:()=>safely(()=>lease.flush()),close:()=>safely(()=>lease.close()),
    });}),
    createDirectoryNew:(directory,options)=>safely(()=>metadata(native.createManagedDirectory!(directory,{root:options.root??directory,kind:'directory',private:true},()=>lstatSync(directory)))),
    openDirectory:(directory,options)=>safely(()=>{const lease=native.openManagedDirectory!(directory,{...options,kind:'directory'},()=>lstatSync(directory));return Object.freeze({metadata:()=>safely(()=>metadata(lease.metadata())),next:()=>safely(()=>lease.next()),close:()=>safely(()=>lease.close())});}),
    syncDirectory:(directory,options)=>safely(()=>native.syncManagedDirectory!(directory,{...options,root:options.root??directory,kind:'directory'})),
    renameNoReplace:(source,destination,options)=>safely(()=>metadata(native.renameManaged!(source,destination,{root:options.root,kind:'file',maxBytes:streamMaximum(undefined),...expected(options.expected)},()=>lstatSync(destination)))),
    removeOwnedFile:(file,options)=>safely(()=>native.removeManaged!(file,{root:options.root,kind:'file',maxBytes:streamMaximum(options.maxBytes),...expected(options.expected)})),
    removeOwnedDirectory:(directory,options)=>safely(()=>native.removeManaged!(directory,{root:options.root,kind:'directory',...expected(options.expected)})),
  } satisfies WindowsManagedFileIO):undefined;
  const backend:WindowsPrivateStorageBackend={apiVersion:1,platform:'win32',...(managedFileIO?{managedFileIO}:{}),
    assertStoragePrivacyAvailable:()=>safely(()=>native.assertAvailable()),
    ensurePrivateDirectory:(directory,options={})=>inspect(directory,{...options,kind:'directory',private:true}),
    validatePrivateDirectory:(directory,options={})=>inspect(directory,{allowMissing:options.allowMissing,kind:'directory',private:true}),
    createPrivateTemporaryDirectory:(parent,prefix='mioon-private-')=>safely(()=>{if(!/^[a-zA-Z0-9.-]{1,80}$/u.test(prefix))throw new PrivateStorageError('INVALID_PATH','A safe temporary directory prefix is required.');return native.temporary(parent,prefix);}),
    validateManagedDirectory:(directory,options={})=>inspect(directory,managed(directory,options,'directory')),
    validateManagedFile:(file,options={})=>inspect(file,managed(file,options,'file')),
    readPrivateFile:(file,options={})=>safely(()=>{const maxBytes=maximum(options.maxBytes),result=native.read(file,{...managed(file,options,'file'),private:options.private??true,maxBytes});if(result===null)return null;if(!Buffer.isBuffer(result)||result.length>maxBytes)throw unavailable();return options.encoding?result.toString(options.encoding):result;}),
    writePrivateFileAtomic:(file,bytes,options={})=>safely(()=>{const maxBytes=maximum(options.maxBytes),length=typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength;if(length>maxBytes)throw new PrivateStorageError('SIZE_LIMIT','The private storage file exceeds its safe size limit.');const contents=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);native.write(file,contents,{root:options.root??path.dirname(file),kind:'file',private:true,maxBytes,replace:options.replace??true});}),
    removePrivateFile:(file,options={})=>safely(()=>native.remove(file,{...managed(file,options,'file'),private:options.private??true,maxBytes:maximum(options.maxBytes),allowMissing:true})),
  };
  return Object.freeze(backend);
}
