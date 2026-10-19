import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {setImmediate as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {publishMarker} from '../packages/business/src/workspace-backup-storage.ts';
import type {TestContext} from 'node:test';
type Loose = Record<string, unknown>;
interface StorageFixture {base: string; source: string; destination: string; store: ReturnType<typeof openStore>; close: ()=>void}
const digest=(bytes: Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function fixture(t: TestContext): StorageFixture {const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-backup-storage-')),source=path.join(base,'source'),destination=path.join(base,'backup');const store=openStore(source);t.after(()=>{store.close();fs.rmSync(base,{recursive:true,force:true});});return {base,source,destination,store,close:()=>store.close()};}
const absent=(f: StorageFixture)=>assert.equal(fs.existsSync(path.join(f.destination,'COMPLETE.json')),false);
function asset(f: StorageFixture,{size=8,bytes=Buffer.from('original')}: {size?: number; bytes?: Buffer}={}): string {
 const project=f.store.put('projects',{id:randomUUID(),name:'Storage fixture'}),id=randomUUID(),relativePath=`media/${id}.mp4`,file=path.join(f.source,relativePath);
 fs.writeFileSync(file,bytes,{mode:0o600});if(size!==bytes.length)fs.truncateSync(file,size);
 f.store.put('assets',{id,projectId:project.id,relativePath,sha256:digest(bytes),sizeBytes:size});return file;
}
for(const suffix of ['-wal','-journal'])test(`nonempty SQLite ${suffix} is refused and never repaired`,async t=>{
 const f=fixture(t);f.close();const file=path.join(f.source,`workbench.sqlite${suffix}`);fs.writeFileSync(file,'pending write',{mode:0o600});
 await assert.rejects(createWorkspaceBackup(f),(error: unknown)=>(error as {code?: string}).code==='WORKSPACE_BACKUP_NOT_COLD');assert.equal(fs.readFileSync(file,'utf8'),'pending write');assert.equal(fs.existsSync(f.destination),false);
});
test('empty sidecars are accepted, excluded and unchanged; safe legacy modes are retained',async t=>{
 const f=fixture(t);const file=asset(f);f.close();fs.chmodSync(file,0o644);fs.chmodSync(path.join(f.source,'media'),0o755);
 for(const suffix of ['-wal','-journal','-shm'])fs.writeFileSync(path.join(f.source,`workbench.sqlite${suffix}`),'',{mode:0o644});
 await createWorkspaceBackup(f);assert.equal(fs.statSync(file).mode&0o777,0o644);assert.equal(fs.statSync(path.join(f.source,'media')).mode&0o777,0o755);
 for(const suffix of ['-wal','-journal','-shm'])assert.equal(fs.statSync(path.join(f.source,`workbench.sqlite${suffix}`)).size,0);
});
for(const kind of ['symlink','hardlink','broad-mode','foreign-owner','fifo'])test(`selected source ${kind} is rejected without changing target`,async t=>{
 const f=fixture(t),file=asset(f);f.close();const outside=path.join(f.base,'outside');fs.writeFileSync(outside,'outside unchanged',{mode:0o600});
 if(kind==='symlink'){fs.unlinkSync(file);fs.symlinkSync(outside,file);}
 if(kind==='hardlink'){fs.unlinkSync(file);fs.linkSync(outside,file);}
 if(kind==='broad-mode')fs.chmodSync(file,0o666);
 if(kind==='foreign-owner'||kind==='fifo'){
  const original=fs.lstatSync;t.mock.method(fs,'lstatSync',function(this: typeof fs,target: string|Buffer|URL,...args: unknown[]){const info=Reflect.apply(original,this,[target,...args]) as fs.Stats;if(String(target)===file){if(kind==='foreign-owner')info.uid=(process.getuid?.()??0)+1;else info.isFile=()=>false;}return info;});syncBuiltinESMExports();
 }
 try{await assert.rejects(createWorkspaceBackup(f),(error: unknown)=>(error as {code?: string}).code==='STORAGE_PRIVATE_REQUIRED');absent(f);assert.equal(fs.readFileSync(outside,'utf8'),'outside unchanged');}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
test('an unrecognized symlink in managed media is rejected rather than silently followed or copied',async t=>{
 const f=fixture(t);f.close();fs.symlinkSync('/etc/passwd',path.join(f.source,'media','excluded-link'));
 await assert.rejects(createWorkspaceBackup(f),(error: unknown)=>(error as {code?: string}).code==='STORAGE_PRIVATE_REQUIRED');absent(f);
});
for(const kind of ['relative','nested','existing','symlink-parent'])test(`invalid destination ${kind} is never reused or repaired`,async t=>{
 const f=fixture(t);f.close();let destination=f.destination;
 if(kind==='relative')destination='relative-backup';
 if(kind==='nested')destination=path.join(f.source,'backup');
 if(kind==='existing'){fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(path.join(destination,'sentinel'),'unchanged');}
 if(kind==='symlink-parent'){const link=path.join(f.base,'alias');fs.symlinkSync(f.base,link);destination=path.join(link,'backup');}
 await assert.rejects(createWorkspaceBackup({...f,destination}));if(kind==='existing')assert.equal(fs.readFileSync(path.join(destination,'sentinel'),'utf8'),'unchanged');absent(f);
});
for(const kind of ['database','single-file','total'])test(`fixed ${kind} byte limit rejects sparse oversize input before streaming media`,async t=>{
 const f=fixture(t);
 if(kind==='single-file')asset(f,{size:8*1024**3+1});
 if(kind==='total')for(let n=0;n<9;n++)asset(f,{size:8*1024**3});
 f.close();if(kind==='database')fs.truncateSync(path.join(f.source,'workbench.sqlite'),512*1024**2+1);
 await assert.rejects(createWorkspaceBackup(f),(error: unknown)=>(error as {code?: string}).code==='WORKSPACE_BACKUP_LIMIT');absent(f);
});
test('cancellation during chunked capture leaves no COMPLETE and releases only its own lease',async t=>{
 const f=fixture(t);asset(f,{size:8*1024*1024});f.close();const controller=new AbortController(),operation=createWorkspaceBackup({...f,signal:controller.signal});await pause();controller.abort();
 await assert.rejects(operation,(error: unknown)=>(error as {code?: string}).code==='WORKSPACE_BACKUP_CANCELLED');absent(f);assert.equal(fs.existsSync(path.join(f.source,'server.lock')),false);
});
test('source replacement after capture starts is fenced before completion',async t=>{
 const f=fixture(t);f.close();const operation=createWorkspaceBackup(f);await pause();const db=path.join(f.source,'workbench.sqlite');fs.appendFileSync(db,'late change');
 await assert.rejects(operation,(error: unknown)=>['WORKSPACE_BACKUP_CHANGED','WORKSPACE_BACKUP_LIMIT'].includes((error as {code?: string}).code as string));absent(f);
});
test('new backup parent fsync failure is fatal before publication and source is unchanged',async t=>{
 const f=fixture(t);f.close();const before=fs.readFileSync(path.join(f.source,'workbench.sqlite')),original=fs.fsyncSync;
 t.mock.method(fs,'fsyncSync',function(fd: number){const info=fs.fstatSync(fd);if(info.isDirectory()&&info.ino===fs.statSync(f.base).ino)throw Object.assign(Error('synthetic sync failure'),{code:'EIO'});return original(fd);});syncBuiltinESMExports();
 try{await assert.rejects(createWorkspaceBackup(f),(error: unknown)=>(error as {code?: string}).code==='WORKSPACE_BACKUP_IO');absent(f);assert.deepEqual(fs.readFileSync(path.join(f.source,'workbench.sqlite')),before);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
test('publication failure removes only owned marker and fsyncs rollback',t=>{
 const f=fixture(t);f.close();fs.mkdirSync(f.destination,{mode:0o700});const original=fs.fsyncSync;let calls=0;
 t.mock.method(fs,'fsyncSync',function(fd: number){if(fs.fstatSync(fd).isDirectory()&&++calls===1)throw Object.assign(Error('first flush fails'),{code:'EIO'});return original(fd);});syncBuiltinESMExports();
 try{assert.throws(()=>publishMarker(path.join(f.destination,'COMPLETE.json'),f.destination,Buffer.from('{}'),()=>{}));absent(f);assert.equal(calls,2);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
test('publication never adopts and deletes a substituted marker inode',t=>{
 const f=fixture(t);f.close();fs.mkdirSync(f.destination,{mode:0o700});const marker=path.join(f.destination,'COMPLETE.json'),original=fs.linkSync;
 t.mock.method(fs,'linkSync',function(from: string,to: string){const value=original(from,to);fs.unlinkSync(to);fs.writeFileSync(to,'foreign marker',{mode:0o600});return value;});syncBuiltinESMExports();
 try{assert.throws(()=>publishMarker(marker,f.destination,Buffer.from('{}'),()=>{}),(error: unknown)=>(error as {code?: string}).code==='WORKSPACE_BACKUP_PUBLICATION_UNCONFIRMED');assert.equal(fs.readFileSync(marker,'utf8'),'foreign marker');}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
test('verify rejects linked payload and does not create SQLite sidecars beside completed database',async t=>{
 const f=fixture(t);const file=asset(f);f.close();await createWorkspaceBackup(f);await verifyWorkspaceBackup({directory:f.destination});
 const copied=path.join(f.destination,'payload/media',path.basename(file));fs.linkSync(copied,path.join(f.base,'hardlink'));
 await assert.rejects(verifyWorkspaceBackup({directory:f.destination}),(error: unknown)=>(error as {code?: string}).code==='STORAGE_PRIVATE_REQUIRED');
 for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(path.join(f.destination,`payload/workbench.sqlite${suffix}`)),false);
});

test('capture rehashes stored destination bytes before claiming verified integrity',async t=>{
 const f=fixture(t);asset(f);f.close();const originalOpen=fs.openSync,originalWrite=fs.writeSync,paths=new Map();let corrupted=false;
 t.mock.method(fs,'openSync',function(this: typeof fs,file: string|Buffer|URL,...args: unknown[]){const fd=Reflect.apply(originalOpen,this,[file,...args]) as number;paths.set(fd,String(file));return fd;});
 t.mock.method(fs,'writeSync',function(fd: number,buffer: Uint8Array,offset: number,length: number,position: number){
  if(!corrupted&&paths.get(fd)?.startsWith(path.join(f.destination,'payload/media')+path.sep)){
   corrupted=true;const altered=Buffer.from(buffer);altered[offset]^=1;return originalWrite(fd,altered,offset,length,position);
  }
  return originalWrite(fd,buffer,offset,length,position);
 });syncBuiltinESMExports();
 try{await assert.rejects(createWorkspaceBackup(f),(error: unknown)=>(error as {code?: string}).code==='WORKSPACE_BACKUP_CORRUPT');assert.equal(corrupted,true);absent(f);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

for(const fault of ['unlink','metadata','replacement'])test(`completed backup stays verified with explicit lock cleanup warning after ${fault}`,async t=>{
 const f=fixture(t);f.close();const lock=path.join(f.source,'server.lock'),marker=path.join(f.destination,'COMPLETE.json');let injected=false;
 if(fault==='unlink'){
  const original=fs.unlinkSync;t.mock.method(fs,'unlinkSync',function(this: typeof fs,file: string|Buffer|URL,...args: unknown[]){if(String(file)===lock){injected=true;throw Object.assign(Error('synthetic unlink denied'),{code:'EACCES'});}return Reflect.apply(original,this,[file,...args]);});
 }else if(fault==='metadata'){
  const original=fs.lstatSync;t.mock.method(fs,'lstatSync',function(this: typeof fs,file: string|Buffer|URL,...args: unknown[]){if(!injected&&String(file)===lock&&fs.existsSync(marker)){injected=true;throw Object.assign(Error('synthetic metadata failure'),{code:'EIO'});}return Reflect.apply(original,this,[file,...args]);});
 }else{
  const original=fs.linkSync;t.mock.method(fs,'linkSync',function(from: string,to: string){const value=original(from,to);if(String(to)===marker){injected=true;fs.renameSync(lock,`${lock}.original`);fs.writeFileSync(lock,'new owner',{mode:0o600});}return value;});
 }
 syncBuiltinESMExports();let result;
 try{result=await createWorkspaceBackup(f);assert.equal(injected,true);assert.deepEqual(result.warnings,['SOURCE_LOCK_RELEASE_UNCONFIRMED']);assert.equal(fs.existsSync(marker),true);assert.equal(fs.existsSync(lock),true);if(fault==='replacement')assert.equal(fs.readFileSync(lock,'utf8'),'new owner');}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
 const {warnings,...captured}=result;assert.deepEqual(await verifyWorkspaceBackup({directory:f.destination}),captured);
});
test('cancelled backup retains cancellation and explicitly reports uncertain source lock cleanup',async t=>{
 const f=fixture(t);f.close();const lock=path.join(f.source,'server.lock'),original=fs.unlinkSync,controller=new AbortController();
 t.mock.method(fs,'unlinkSync',function(this: typeof fs,file: string|Buffer|URL,...args: unknown[]){if(String(file)===lock)throw Object.assign(Error('synthetic cleanup failure'),{code:'EACCES'});return Reflect.apply(original,this,[file,...args]);});syncBuiltinESMExports();
 try{const operation=createWorkspaceBackup({...f,signal:controller.signal});await pause();controller.abort();await assert.rejects(operation,(error: unknown)=>{const view=error as {code?: string; cleanupUnconfirmed?: boolean};return view.code==='WORKSPACE_BACKUP_CANCELLED'&&view.cleanupUnconfirmed===true;});absent(f);assert.equal(fs.existsSync(lock),true);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
