import type {RootFailure} from './helpers/strict-root-error-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {renameSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {lstatSync} from 'node:fs';
import {initializeNodePrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {createPrivateTemporaryDirectory,getWindowsManagedFileIO,privateStorageIdentity} from '../packages/contracts/src/private-storage.ts';
const enabled=process.platform==='win32';
const MiB=1024*1024;
type ManagedIO = NonNullable<ReturnType<typeof getWindowsManagedFileIO>>;
async function fixture(work: (root: string, io: ManagedIO) => Promise<void>){await initializeNodePrivateStorage();const root=createPrivateTemporaryDirectory(os.tmpdir(),'mioon-stream-');try{await work(root,getWindowsManagedFileIO()!);}finally{rmSync(root,{recursive:true,force:true});}}
function write(io: ManagedIO,root: string,file: string,bytes: Buffer){const out=io.openFile(file,{root,private:true,maxBytes:bytes.length,mode:'create'});try{for(let offset=0;offset<bytes.length;offset+=MiB)out.write(bytes.subarray(offset,offset+MiB));out.flush();return out.metadata();}finally{out.close();}}
test('native Windows opaque streaming leases read/write beyond 64MiB with exact bounded chunks and full identities',{skip:!enabled,timeout:180000},()=>fixture(async(root,io)=>{
 const file=path.join(root,'large.bin'),chunk=Buffer.alloc(MiB,0xa7),hash=createHash('sha256');const writer=io.openFile(file,{root,private:true,maxBytes:65*MiB,mode:'create'});let expected;
 try{assert.throws(()=>writer.write(Buffer.alloc(MiB+1)),e=>(e as RootFailure).reason==='INVALID_LIMIT');for(let i=0;i<65;i++){writer.write(chunk);hash.update(chunk);}assert.throws(()=>writer.write(Buffer.from('x')),e=>(e as RootFailure).reason==='SIZE_LIMIT');writer.flush();expected=writer.metadata();assert.equal(expected.size,65*MiB);assert.match(privateStorageIdentity(expected),/^windows:[a-f0-9]{16}:[a-f0-9]{32}$/);}finally{writer.close();}
 assert.throws(()=>writer.metadata(),e=>(e as RootFailure).reason==='IO_ERROR');writer.close();
 const reader=io.openFile(file,{root,private:true,maxBytes:65*MiB,mode:'read',expected});const actual=createHash('sha256');let total=0;
 try{assert.throws(()=>reader.read(MiB+1),e=>(e as RootFailure).reason==='INVALID_LIMIT');assert.throws(()=>reader.write(Buffer.from('x')),e=>(e as RootFailure).reason==='IO_ERROR');for(;;){const bytes=reader.read(MiB);if(!bytes.length)break;actual.update(bytes);total+=bytes.length;}assert.equal(total,65*MiB);assert.equal(actual.digest('hex'),hash.digest('hex'));assert.equal(privateStorageIdentity(reader.metadata()),privateStorageIdentity(expected));}finally{reader.close();}
 const flush=io.openFile(file,{root,private:true,maxBytes:65*MiB,mode:'flush',expected});try{assert.throws(()=>flush.write(Buffer.from('x')),e=>(e as RootFailure).reason==='IO_ERROR');flush.flush();}finally{flush.close();}
 io.syncDirectory(root,{private:true});io.removeOwnedFile(file,{root,expected,maxBytes:65*MiB});
}));
test('native Windows streamed publication and removal compare full identity and never clobber another file',{skip:!enabled,timeout:60000},()=>fixture(async(root,io)=>{
 const staged=path.join(root,'stage'),final=path.join(root,'final');const expected=write(io,root,staged,Buffer.from('complete payload'));
 const published=io.renameNoReplace(staged,final,{root,expected});assert.equal(privateStorageIdentity(published),privateStorageIdentity(expected));
 const replacement=write(io,root,staged,Buffer.from('other payload'));assert.throws(()=>io.renameNoReplace(staged,final,{root,expected:replacement}),e=>(e as RootFailure).reason==='ALREADY_EXISTS');assert.throws(()=>io.removeOwnedFile(staged,{root,expected}),e=>(e as RootFailure).reason==='FILE_CHANGED');
 const reader=io.openFile(final,{root,private:true,mode:'read',expected:published});try{await setImmediate();assert.equal(reader.read(100).toString(),'complete payload');assert.throws(()=>renameSync(root,root+'-moved'),e=>['EPERM','EACCES','EBUSY'].includes((e as RootFailure).code!));}finally{reader.close();}
 io.removeOwnedFile(staged,{root,expected:replacement});io.removeOwnedFile(final,{root,expected:published});
}));
test('native Windows directory enumeration crosses bounded native pages without omitting or repeating entries',{skip:!enabled,timeout:120000},()=>fixture(async(root,io)=>{
 const entries=[];for(let index=0;index<500;index++){const name=String(index).padStart(4,'0')+'-'+('a'.repeat(96)),file=path.join(root,name);const writer=io.openFile(file,{root,private:true,maxBytes:0,mode:'create'});try{entries.push({name,file,expected:writer.metadata()});}finally{writer.close();}}
 const scan=io.openDirectory(root,{root,private:true});try{const names=[];for(;;){const name=scan.next();if(name===null)break;names.push(name);}assert.equal(names.length,500);assert.deepEqual(names.sort(),entries.map(entry=>entry.name).sort());}finally{scan.close();}
 for(const entry of entries)io.removeOwnedFile(entry.file,{root,expected:entry.expected,maxBytes:0});
}));
test('native Windows lease methods reject other addons wrapped objects before interpreting their pointers',{skip:!enabled,timeout:60000},()=>fixture(async(root,io)=>{
 const require=createRequire(import.meta.url),native=require('../packages/node-host/build/Release/mioon_private_storage.node');
 const keyringRequire=createRequire(new URL('../apps/server/package.json',import.meta.url));
 // Constructing this foreign native object performs no read/write/delete of any
 // credential; it only supplies a genuine napi-rs receiver for type confusion.
 const {AsyncEntry}=keyringRequire('@napi-rs/keyring');const foreign=new AsyncEntry('app.starroy.mioon.native-receiver-qa','synthetic-unused');
 const file=path.join(root,'receiver'),expected=write(io,root,file,Buffer.from('safe'));
 const lease=native.openManagedFile(file,{root,kind:'file',private:true,maxBytes:4,mode:'read'},()=>lstatSync(file));
 try{for(const receiver of [{},foreign,Buffer.alloc(1)])for(const [method,args] of [['metadata',[]],['close',[]],['read',[1]],['write',[Buffer.from('x')]],['flush',[]],['next',[]]] as [string, unknown[]][])assert.throws(()=>lease[method].call(receiver,...args),e=>(e as RootFailure).reason==='IO_ERROR');assert.equal(lease.read(4).toString(),'safe');}finally{lease.close();}
 io.removeOwnedFile(file,{root,expected});
}));
test('native Windows parent flush accepts safe ordinary owner directories and rejects dangerous grants and reparse points',{skip:!enabled,timeout:60000},()=>fixture(async(root,io)=>{
 const parent=path.join(root,'ordinary');mkdirSync(parent);
 const grant=spawnSync('icacls.exe',[parent,'/grant','*S-1-5-32-544:(OI)(CI)F'],{encoding:'utf8'});assert.equal(grant.status,0);
 const child=path.join(parent,'private-child'),expected=io.createDirectoryNew(child,{});
 io.syncDirectory(parent,{private:false});assert.throws(()=>io.syncDirectory(parent,{private:true}),e=>(e as RootFailure).reason==='UNSAFE_ACL');
 const junction=path.join(root,'junction');symlinkSync(parent,junction,'junction');assert.throws(()=>io.syncDirectory(junction,{private:false}),e=>(e as RootFailure).reason==='REPARSE_POINT');
 const dangerous=spawnSync('icacls.exe',[parent,'/grant','*S-1-1-0:(OI)(CI)F'],{encoding:'utf8'});assert.equal(dangerous.status,0);assert.throws(()=>io.syncDirectory(parent,{private:false}),e=>(e as RootFailure).reason==='UNSAFE_ACL');
 // No removal is attempted through the deliberately unsafe ancestor; the
 // owning fixture removes only its freshly created test tree in finally.
 assert.match(privateStorageIdentity(expected),/^windows:/);
}));
test('native Windows directory enumeration, durable flush and exact owned cleanup retain protected handles',{skip:!enabled,timeout:60000},()=>fixture(async(root,io)=>{
 const dir=path.join(root,'owned');const identity=io.createDirectoryNew(dir,{root});assert.throws(()=>io.createDirectoryNew(dir,{root}),e=>(e as RootFailure).reason==='ALREADY_EXISTS');
 const files=['one','two','three'].map(name=>{const file=path.join(dir,name);return {file,expected:write(io,root,file,Buffer.from(name))};});
 const scan=io.openDirectory(dir,{root,private:true});try{assert.equal(privateStorageIdentity(scan.metadata()),privateStorageIdentity(identity));const names=[];for(;;){const name=scan.next();if(name===null)break;names.push(name);}assert.deepEqual(names.sort(),['one','three','two']);assert.equal(scan.next(),null);assert.throws(()=>renameSync(dir,dir+'-moved'),e=>['EPERM','EACCES','EBUSY'].includes((e as RootFailure).code!));}finally{scan.close();}
 io.syncDirectory(dir,{root,private:true});assert.throws(()=>io.removeOwnedDirectory(dir,{root,expected:identity}),e=>(e as RootFailure).reason==='IO_ERROR');for(const file of files)io.removeOwnedFile(file.file,{root,expected:file.expected});io.removeOwnedDirectory(dir,{root,expected:identity});
 const second=io.createDirectoryNew(dir,{root});assert.notEqual(privateStorageIdentity(second),privateStorageIdentity(identity));assert.throws(()=>io.removeOwnedDirectory(dir,{root,expected:identity}),e=>(e as RootFailure).reason==='FILE_CHANGED');io.removeOwnedDirectory(dir,{root,expected:second});
}));
