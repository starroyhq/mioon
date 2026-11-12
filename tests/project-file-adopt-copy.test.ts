import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {chmodSync,copyFileSync,existsSync,linkSync,lstatSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {withLockedProjectCopy} from '../packages/business/src/project-file/adopt-copy.ts';
import type {LockedProjectCopyReplacement} from '../packages/business/src/project-file/adopt-copy.ts';
import {createProjectFile,inspectProjectFileReadOnly} from '../packages/business/src/project-file/connection.ts';
import {copyProjectToNewFile} from '../packages/business/src/project-file/copy.ts';
import {createProjectCopyStagingDirectory,inspectCopiedProjectFile,openProjectBackup} from '../packages/business/src/project-file/backup.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import type {ProjectFileFormat} from '../packages/business/src/project-file/schema/databases.ts';

const code=(expected:string)=>(error:unknown):boolean=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code===expected);
const fileIdentity=(file:string)=>{const info=lstatSync(file,{bigint:true});return {dev:String(info.dev),ino:String(info.ino)};};
const evidence=(file:string)=>({bytes:readFileSync(file),info:lstatSync(file,{bigint:true})});
const unchanged=(file:string,before:ReturnType<typeof evidence>)=>{
 assert.deepEqual(readFileSync(file),before.bytes);
 const after=lstatSync(file,{bigint:true});
 for(const field of ['dev','ino','size','mtimeNs','ctimeNs'] as const)assert.equal(after[field],before.info[field],field);
};
function fixture(t:TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-adopt-copy-')),original=path.join(root,'original.mioon'),selected=path.join(root,'selected.mioon');
 const projectId=createProjectFile(original),location={localDir:path.join(root,'old-records'),cacheDir:path.join(root,'old-cache'),tempDir:path.join(root,'old-tmp')};
 const store=openProjectStore({projectFile:original,locate:()=>location});
 store.put('projects',{id:projectId,name:'Selected copy',revision:1,note:projectId});store.close();
 copyFileSync(original,selected);
 const source=inspectCopiedProjectFile(selected),directory=path.join(root,'capture');
 const options={projectFile:selected,expectedIdentity:fileIdentity(selected),expectedSource:source,snapshotDirectory:directory};
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});});
 return {root,original,selected,projectId,location,source,directory,options};
}
async function build(copy:LockedProjectCopyReplacement,root:string,targetFormat?:ProjectFileFormat){
 const directory=createProjectCopyStagingDirectory(root,'.project-copy-'),file=path.join(directory,'project.mioon'),reader=openProjectBackup(copy.projectFile);
 try{
  const result=await copyProjectToNewFile(reader,{projectFile:file,sourceProjectDir:root,targetProjectDir:root,projectId:randomUUID(),contentToken:randomBytes(16).toString('hex'),clearProcessRevisions:true,targetFormat,publish:(temporary,destination)=>renameSync(temporary,destination)});
  return {file,directory,expected:{...result,fileIdentity:fileIdentity(file)}};
 }finally{reader.close();}
}

for(const format of [PROJECT_FILE_SCHEMA_VERSION,FORMAT4_PROJECT_SCHEMA_VERSION] as const)test(`adoption builds a format ${format} target and replaces only the selected copy under a new identity`,async t=>{
 const f=fixture(t),original=evidence(f.original),history=evidence(path.join(f.location.localDir,'history.db')),oldSelected=fileIdentity(f.selected);
 let newId='',newToken='';
 await withLockedProjectCopy(f.options,async copy=>{
  assert.equal(copy.identity.projectId,f.projectId);assert.equal(copy.identity.formatVersion,PROJECT_FILE_SCHEMA_VERSION);
  const before=lstatSync(f.selected,{bigint:true});
  const stage=await build(copy,f.root,format);newId=stage.expected.projectId;newToken=stage.expected.contentToken;
  const after=lstatSync(f.selected,{bigint:true});
  for(const field of ['dev','ino','size','mtimeNs','ctimeNs'] as const)assert.equal(after[field],before[field],field);
  const copied=copy.replace(stage.file,stage.expected);
  assert.equal(copied.projectId,newId);assert.equal(copied.contentToken,newToken);assert.equal(existsSync(stage.file),false);
  const target=inspectCopiedProjectFile(f.selected);assert.equal(target.projectId,newId);assert.equal(target.formatVersion,format);
 });
 assert.notEqual(newId,f.projectId);assert.notEqual(newToken,f.source.contentToken);assert.notDeepEqual(fileIdentity(f.selected),oldSelected);
 const store=openProjectStore({projectFile:f.selected,locate:id=>({localDir:path.join(f.root,'new',id),cacheDir:path.join(f.root,'new-cache',id),tempDir:path.join(f.root,'new-tmp',id)}),
  ...(format===FORMAT4_PROJECT_SCHEMA_VERSION?{format4:{}}:{})});
 try{
  assert.equal(store.projectId,newId);assert.equal(store.historyState,'fresh');
  assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()?.version,format===FORMAT4_PROJECT_SCHEMA_VERSION?FORMAT4_HISTORY_SCHEMA_VERSION:HISTORY_SCHEMA_VERSION);
  assert.equal((store.get('projects',newId) as {note:string}|null)?.note,f.projectId,'free text is not globally rekeyed');
  assert.equal(store.db.prepare('SELECT count(*) n FROM main.project_versions').get()!.n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM main.mio_runs').get()!.n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM main.jobs').get()!.n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM main.local_draft_states').get()!.n,0);
 }finally{store.close();}
 unchanged(f.original,original);unchanged(path.join(f.location.localDir,'history.db'),history);
 assert.equal(existsSync(path.join(f.directory,'project.source.sqlite')),false);
 for(const suffix of ['-journal','-wal','-shm'])assert.equal(existsSync(f.selected+suffix),false);
});

test('the original SQLite write lock and held-inode guard survive native backup and every callback await',async t=>{
 const f=fixture(t),before=evidence(f.selected),originalOpen=fs.openSync;
 let probes=0,fsAttempts=0;
 const probe=()=>{
  t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{if(String(args[0])===f.selected)fsAttempts++;return originalOpen(...args);});syncBuiltinESMExports();
  assert.throws(()=>inspectProjectFileReadOnly(f.selected),code('PROJECT_LOCKED'));
  const program=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(f.selected)},{timeout:0});try{try{db.exec('BEGIN IMMEDIATE');process.stdout.write('unlocked');}catch(error){if(error.errcode!==5)throw error;process.stdout.write('locked');}}finally{db.close();}`;
  assert.equal(execFileSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8'}),'locked');
  assert.equal(fsAttempts,0);t.mock.restoreAll();syncBuiltinESMExports();probes++;
 };
 await withLockedProjectCopy({...f.options,onBoundary:phase=>{if(phase==='locked'||phase==='captured')probe();}},async copy=>{
  probe();await new Promise<void>(resolve=>setImmediate(resolve));probe();
  assert.equal(copy.identity.projectId,f.projectId);
 });
 assert.equal(probes,4);unchanged(f.selected,before);
 const db=new DatabaseSync(f.selected);try{db.exec('BEGIN IMMEDIATE;ROLLBACK');}finally{db.close();}
});

for(const kind of ['symlink','hardlink','held'] as const)test(`${kind} selected files are refused before creating snapshot input`,async t=>{
 const f=fixture(t),original=evidence(f.original);let store:ReturnType<typeof openProjectStore>|undefined;
 if(kind!=='held'){rmSync(f.selected);if(kind==='symlink')symlinkSync(f.original,f.selected);else linkSync(f.original,f.selected);}
 else store=openProjectStore({projectFile:f.selected,locate:()=>({localDir:path.join(f.root,'selected-records'),cacheDir:path.join(f.root,'selected-cache'),tempDir:path.join(f.root,'selected-tmp')})});
 try{await assert.rejects(withLockedProjectCopy({...f.options,expectedIdentity:fileIdentity(f.selected)},async()=>assert.fail('must not run')),code(kind==='held'?'PROJECT_LOCKED':'PROJECT_INVALID'));}
 finally{store?.close();}
 assert.equal(existsSync(f.directory),false);
 if(kind!=='hardlink')unchanged(f.original,original);else assert.deepEqual(readFileSync(f.original),original.bytes);
});

for(const mismatch of ['inode','project','sequence','token'] as const)test(`stale ${mismatch} selection refuses without touching the selected file`,async t=>{
 const f=fixture(t),before=evidence(f.selected),options={...f.options,expectedIdentity:{...f.options.expectedIdentity},expectedSource:{...f.source}};
 if(mismatch==='inode')options.expectedIdentity.ino='0';
 if(mismatch==='project')options.expectedSource.projectId=randomUUID();
 if(mismatch==='sequence')options.expectedSource.contentSequence++;
 if(mismatch==='token')options.expectedSource.contentToken=f.source.contentToken==='f'.repeat(32)?'e'.repeat(32):'f'.repeat(32);
 await assert.rejects(withLockedProjectCopy(options,async()=>assert.fail('must not run')),code('PROJECT_COPY_SOURCE_CHANGED'));
 unchanged(f.selected,before);assert.equal(existsSync(f.directory),false);
});

for(const suffix of ['-wal','-shm','-journal'] as const)test(`unsafe ${suffix} leaves selected content and sidecar untouched`,async t=>{
 const f=fixture(t),before=evidence(f.selected);writeFileSync(f.selected+suffix,suffix==='-journal'?Buffer.from([1,2,3]):Buffer.alloc(0));
 const sidecar=evidence(f.selected+suffix);
 await assert.rejects(withLockedProjectCopy(f.options,async()=>assert.fail('must not run')),code('PROJECT_INVALID'));
 unchanged(f.selected,before);unchanged(f.selected+suffix,sidecar);assert.equal(existsSync(f.directory),false);
});

test('a read-only file can be replaced from a writable folder without writing the old inode',{
 skip:process.platform==='win32'||process.getuid?.()===0?'POSIX permissions require an unprivileged POSIX user':false,
},async t=>{
 const f=fixture(t);chmodSync(f.selected,0o444);const before=evidence(f.selected);
 await withLockedProjectCopy(f.options,async copy=>{const stage=await build(copy,f.root);copy.replace(stage.file,stage.expected);});
 assert.notEqual(inspectCopiedProjectFile(f.selected).projectId,f.projectId);assert.equal(existsSync(f.selected+'-journal'),false);
 assert.equal(before.info.mode&0o222n,0n);assert.notEqual(lstatSync(f.selected,{bigint:true}).ino,before.info.ino);
});

test('a non-writable project folder refuses staging while leaving the selected file unchanged',{
 skip:process.platform==='win32'||process.getuid?.()===0?'POSIX permissions require an unprivileged POSIX user':false,
},async t=>{
 const f=fixture(t),snapshot=mkdtempSync(path.join(tmpdir(),'mioon-adopt-private-')),before=evidence(f.selected);
 chmodSync(f.root,0o555);
 try{
  await assert.rejects(withLockedProjectCopy({...f.options,snapshotDirectory:snapshot},async copy=>{await build(copy,f.root);}),code('EACCES'));
  unchanged(f.selected,before);assert.equal(existsSync(path.join(snapshot,'project.source.sqlite')),false);
 }finally{chmodSync(f.root,0o700);rmSync(snapshot,{recursive:true,force:true});}
});

test('even a cold rollback journal is refused unchanged before any preparation',async t=>{
 const f=fixture(t);writeFileSync(f.selected+'-journal',Buffer.alloc(0));const journal=evidence(f.selected+'-journal'),selected=evidence(f.selected);
 await assert.rejects(withLockedProjectCopy(f.options,async()=>assert.fail('must not prepare')),code('PROJECT_INVALID'));
 unchanged(f.selected,selected);unchanged(f.selected+'-journal',journal);
 assert.equal(existsSync(f.directory),false);assert.equal(inspectProjectFileReadOnly(f.selected).projectId,f.projectId);
});

test('a same-path foreign file is never removed or replaced after selection changes',async t=>{
 const f=fixture(t),saved=path.join(f.root,'old-selected.mioon'),foreign=path.join(f.root,'foreign.mioon'),foreignId=createProjectFile(foreign),foreignBefore=evidence(foreign);
 await assert.rejects(withLockedProjectCopy(f.options,async copy=>{
  const stage=await build(copy,f.root);renameSync(f.selected,saved);renameSync(foreign,f.selected);
  copy.replace(stage.file,stage.expected);
 }),code('PROJECT_COPY_SOURCE_CHANGED'));
 assert.deepEqual(readFileSync(f.selected),foreignBefore.bytes);assert.equal(inspectCopiedProjectFile(f.selected).projectId,foreignId);
 assert.equal(inspectCopiedProjectFile(saved).projectId,f.projectId);assert.equal(existsSync(path.join(f.directory,'project.source.sqlite')),false);
});

test('stage identity, stage stamp and same-folder ownership are revalidated before rename',async t=>{
 const f=fixture(t),before=evidence(f.selected);
 await withLockedProjectCopy(f.options,async copy=>{
  const stage=await build(copy,f.root);
  assert.throws(()=>copy.replace(stage.file,{...stage.expected,fileIdentity:{...stage.expected.fileIdentity,ino:'0'}}),code('PROJECT_COPY_SOURCE_CHANGED'));
  assert.throws(()=>copy.replace(stage.file,{...stage.expected,contentToken:stage.expected.contentToken==='f'.repeat(32)?'e'.repeat(32):'f'.repeat(32)}),code('PROJECT_COPY_SOURCE_CHANGED'));
  const other=path.join(f.root,'not-a-copy-stage');renameSync(stage.directory,other);
  assert.throws(()=>copy.replace(path.join(other,'project.mioon'),stage.expected),TypeError);
 });
 unchanged(f.selected,before);
});

test('owner abort after capture refuses replacement while releasing the lock and discarding private input',async t=>{
 const f=fixture(t),before=evidence(f.selected),controller=new AbortController(),sentinel=Error('owner stopped');
 await assert.rejects(withLockedProjectCopy({...f.options,assertMutationAllowed:()=>{if(controller.signal.aborted)throw sentinel;}},async copy=>{
  const stage=await build(copy,f.root);controller.abort();copy.replace(stage.file,stage.expected);
 }),error=>error===sentinel);
 unchanged(f.selected,before);assert.equal(existsSync(path.join(f.directory,'project.source.sqlite')),false);
 const db=new DatabaseSync(f.selected);try{db.exec('BEGIN IMMEDIATE;ROLLBACK');}finally{db.close();}
});

test('rename failure preserves the complete stage and original selected database',async t=>{
 const f=fixture(t),before=evidence(f.selected),rename=fs.renameSync;let staged='';
 await assert.rejects(withLockedProjectCopy(f.options,async copy=>{
  const stage=await build(copy,f.root);staged=stage.file;
  t.mock.method(fs,'renameSync',(...args:Parameters<typeof fs.renameSync>)=>{if(String(args[1])===f.selected)throw Object.assign(Error('denied'),{code:'EACCES'});return rename(...args);});syncBuiltinESMExports();
  copy.replace(stage.file,stage.expected);
 }),code('EACCES'));
 t.mock.restoreAll();syncBuiltinESMExports();unchanged(f.selected,before);assert.equal(existsSync(staged),true);
 assert.notEqual(inspectCopiedProjectFile(staged).projectId,f.projectId);
});

test('a successful capability cannot replace the file twice and caller failures do not rewrite the committed new ID',async t=>{
 const f=fixture(t),sentinel=Error('registration unavailable');let newId='';
 await assert.rejects(withLockedProjectCopy(f.options,async copy=>{
  const stage=await build(copy,f.root);newId=stage.expected.projectId;copy.replace(stage.file,stage.expected);
  assert.throws(()=>copy.replace(stage.file,stage.expected),TypeError);throw sentinel;
 }),error=>error===sentinel);
 assert.equal(inspectCopiedProjectFile(f.selected).projectId,newId);assert.notEqual(newId,f.projectId);
 assert.equal(existsSync(path.join(f.directory,'project.source.sqlite')),false);assert.ok(readdirSync(f.root).includes('selected.mioon'));
});
