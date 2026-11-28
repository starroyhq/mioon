import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chmodSync,existsSync,lstatSync,mkdtempSync,readFileSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createProjectCopyStagingDirectory,validateProjectCopyStagingDirectory,publishProjectCopyFile,publishCopiedFile,
 clearFatProjectCopyStage,fatProjectCopyStageIdentity} from '../packages/business/src/project-file/backup.ts';
const code=(expected:string)=>(error:unknown)=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code===expected);
function fixture(t:TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-s5-publish-')),stage=path.join(root,'stage'),target=path.join(root,'target.mioon');
 writeFileSync(stage,Buffer.from([0,1,2,255,42]),{mode:0o600});
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});});return {root,stage,target,bytes:readFileSync(stage)};
}
function noLinks(t:TestContext):void {t.mock.method(fs,'linkSync',()=>{throw Object.assign(Error('no links'),{code:'EOPNOTSUPP'});});syncBuiltinESMExports();}

test('supported hard-link publication exposes a complete file and does not allocate a placeholder',t=>{
 const f=fixture(t);let published=0;
 publishProjectCopyFile(f.stage,f.target,{onPlaceholder:()=>assert.fail('hard-link path has no placeholder'),onPublished:()=>{published++;assert.deepEqual(readFileSync(f.target),f.bytes);}});
 assert.equal(published,1);assert.deepEqual(readFileSync(f.stage),f.bytes);assert.deepEqual(readFileSync(f.target),f.bytes);
 assert.equal(lstatSync(f.stage,{bigint:true}).ino,lstatSync(f.target,{bigint:true}).ino);
});

for(const links of [true,false])for(const kind of ['empty','content','symlink'] as const)test(`occupied ${kind} target is never replaced (${links?'links':'fallback'})`,t=>{
 const f=fixture(t);if(!links)noLinks(t);
 if(kind==='symlink')symlinkSync(f.stage,f.target);else writeFileSync(f.target,kind==='content'?'keep':'');
 const before=lstatSync(f.target,{bigint:true});let placeholders=0;
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target,{onPlaceholder:()=>{placeholders++;}}),code('PROJECT_FILE_EXISTS'));
 const after=lstatSync(f.target,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.isSymbolicLink(),before.isSymbolicLink());assert.equal(placeholders,0);
 assert.deepEqual(readFileSync(f.stage),f.bytes);if(kind!=='symlink')assert.equal(readFileSync(f.target,'utf8'),kind==='content'?'keep':'');
});

test('Windows fallback reserves wx and renames only over its exact placeholder',{skip:process.platform!=='win32'},t=>{
 const f=fixture(t);noLinks(t);const order:string[]=[];let oldInode:string|undefined;
 publishProjectCopyFile(f.stage,f.target,{onPlaceholder:identity=>{
  order.push('placeholder');const info=lstatSync(f.target,{bigint:true});assert.equal(String(info.dev),identity.dev);assert.equal(String(info.ino),identity.ino);assert.equal(info.size,0n);oldInode=identity.ino;
 },onPublished:()=>{order.push('published');assert.deepEqual(readFileSync(f.target),f.bytes);}});
 assert.deepEqual(order,['placeholder','published']);assert.equal(existsSync(f.stage),false);assert.notEqual(String(lstatSync(f.target,{bigint:true}).ino),oldInode);
});

test('Windows fallback refuses a substituted placeholder',{skip:process.platform!=='win32'},t=>{
 const f=fixture(t);noLinks(t);const held=path.join(f.root,'saved-placeholder');
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target,{onPlaceholder:()=>{renameSync(f.target,held);writeFileSync(f.target,'a foreign file');}}),code('PROJECT_FILE_EXISTS'));
 assert.equal(readFileSync(f.target,'utf8'),'a foreign file');assert.equal(readFileSync(held).length,0);assert.deepEqual(readFileSync(f.stage),f.bytes);
});

test('Windows intent write failure cleans only its own placeholder',{skip:process.platform!=='win32'},t=>{
 const f=fixture(t);noLinks(t);const sentinel=Error('intent write failed');
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target,{onPlaceholder:()=>{throw sentinel;}}),error=>error===sentinel);
 assert.equal(existsSync(f.target),false);assert.deepEqual(readFileSync(f.stage),f.bytes);
});

test('rename failure leaves no target without changing the stage',t=>{
 const f=fixture(t);noLinks(t);t.mock.method(fs,'renameSync',()=>{throw Object.assign(Error('denied'),{code:'EACCES'});});syncBuiltinESMExports();
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target),code('EACCES'));assert.equal(existsSync(f.target),false);assert.deepEqual(readFileSync(f.stage),f.bytes);
});

for(const links of [true,false])test(`failure after publication preserves the complete public file (${links?'links':'fallback'})`,t=>{
 const f=fixture(t);if(!links)noLinks(t);const sentinel=Error('receipt sync failed');
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target,{onPublished:()=>{throw sentinel;}}),error=>error===sentinel);
 assert.deepEqual(readFileSync(f.target),f.bytes);
});

test('unavailable Windows wx publication does not change the V2 link-only contract',{skip:process.platform!=='win32'},t=>{
 const f=fixture(t);noLinks(t);
 assert.throws(()=>publishCopiedFile(f.stage,f.target),code('EOPNOTSUPP'));assert.equal(existsSync(f.target),false);
 const open=fs.openSync;t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{if(String(args[0])===f.target)throw Object.assign(Error('unsupported'),{code:'ENOTSUP'});return open(...args);});syncBuiltinESMExports();
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target),code('PROJECT_COPY_UNSUPPORTED_FILESYSTEM'));assert.equal(existsSync(f.target),false);assert.deepEqual(readFileSync(f.stage),f.bytes);
});

test('POSIX fallback publishes the allocated inode without creating a placeholder',{skip:process.platform==='win32'},t=>{
 const f=fixture(t);noLinks(t);const before=lstatSync(f.stage,{bigint:true});let checked=false,published=false;
 publishProjectCopyFile(f.stage,f.target,{
  beforeFallbackRename:()=>{checked=true;assert.equal(existsSync(f.target),false);},
  onPlaceholder:()=>assert.fail('POSIX fallback must never create a public placeholder'),
  onPublished:()=>{published=true;assert.equal(checked,true);assert.deepEqual(readFileSync(f.target),f.bytes);},
 });
 assert.equal(published,true);assert.equal(existsSync(f.stage),false);
 const after=lstatSync(f.target,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.birthtimeNs,before.birthtimeNs);
});

test('POSIX fallback rejects a target that appears after the stage check',{skip:process.platform==='win32'},t=>{
 const f=fixture(t);noLinks(t);
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target,{beforeFallbackRename:()=>writeFileSync(f.target,'foreign content')}),code('PROJECT_FILE_EXISTS'));
 assert.equal(readFileSync(f.target,'utf8'),'foreign content');assert.deepEqual(readFileSync(f.stage),f.bytes);
});

test('POSIX fallback rejects an empty or foreign-writable stage before touching the target',{skip:process.platform==='win32'},t=>{
 const f=fixture(t);noLinks(t);
 chmodSync(f.root,0o777);
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target),code('PROJECT_COPY_UNSUPPORTED_FILESYSTEM'));
 chmodSync(f.root,0o700);writeFileSync(f.stage,'');
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target),code('PROJECT_COPY_UNSUPPORTED_FILESYSTEM'));
 assert.equal(existsSync(f.target),false);
});

test('POSIX fallback reports disk full while retaining the allocated private source',{skip:process.platform==='win32'},t=>{
 const f=fixture(t);noLinks(t);
 t.mock.method(fs,'renameSync',()=>{throw Object.assign(Error('simulated full volume'),{code:'ENOSPC'});});syncBuiltinESMExports();
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target),code('PROJECT_COPY_CAPACITY'));
 assert.equal(existsSync(f.target),false);assert.deepEqual(readFileSync(f.stage),f.bytes);
 assert.throws(()=>publishCopiedFile(f.stage,f.target),code('EOPNOTSUPP'));
});

test('partial stage cleanup preserves a reused inode and entries without a recorded identity',{skip:process.platform==='win32'},t=>{
 const f=fixture(t),directory=createProjectCopyStagingDirectory(f.root),file=path.join(directory,'project.mioon');
 writeFileSync(file,'original copied prefix');
 const dirIdentity=fatProjectCopyStageIdentity(lstatSync(directory,{bigint:true})),identity=fatProjectCopyStageIdentity(lstatSync(file,{bigint:true}));
 assert.equal(clearFatProjectCopyStage(directory,{directory:dirIdentity,file:null}),false);
 const reused={...identity,birthtimeNs:String(BigInt(identity.birthtimeNs)+1n)};
 assert.equal(clearFatProjectCopyStage(directory,{directory:dirIdentity,file:reused}),false);
 assert.equal(readFileSync(file,'utf8'),'original copied prefix');
 assert.equal(clearFatProjectCopyStage(directory,{directory:dirIdentity,file:identity}),true);
 assert.equal(existsSync(directory),false);
});

test('portable stage directories allow ordinary project permissions but never a symbolic ancestor',t=>{
 const f=fixture(t);chmodSync(f.root,0o755);const stage=createProjectCopyStagingDirectory(f.root,'.project-copy-');
 assert.equal(validateProjectCopyStagingDirectory(stage).isDirectory(),true);assert.equal(Number(lstatSync(f.root).mode)&0o777,0o755);
 const alias=path.join(f.root,'alias');symlinkSync(stage,alias);
 assert.throws(()=>validateProjectCopyStagingDirectory(alias),code('PROJECT_LOCATION_INVALID'));
 assert.throws(()=>createProjectCopyStagingDirectory(alias),code('PROJECT_LOCATION_INVALID'));
 assert.throws(()=>createProjectCopyStagingDirectory(f.root,'../escape'),TypeError);
});
