import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chmodSync,existsSync,lstatSync,mkdtempSync,readFileSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createProjectCopyStagingDirectory,validateProjectCopyStagingDirectory,publishProjectCopyFile,publishCopiedFile} from '../packages/business/src/project-file/backup.ts';
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

test('fallback reserves wx, records its exact identity and renames only over that placeholder',t=>{
 const f=fixture(t);noLinks(t);const order:string[]=[];let oldInode:string|undefined;
 publishProjectCopyFile(f.stage,f.target,{onPlaceholder:identity=>{
  order.push('placeholder');const info=lstatSync(f.target,{bigint:true});assert.equal(String(info.dev),identity.dev);assert.equal(String(info.ino),identity.ino);assert.equal(info.size,0n);oldInode=identity.ino;
 },onPublished:()=>{order.push('published');assert.deepEqual(readFileSync(f.target),f.bytes);}});
 assert.deepEqual(order,['placeholder','published']);assert.equal(existsSync(f.stage),false);assert.notEqual(String(lstatSync(f.target,{bigint:true}).ino),oldInode);
});

test('fallback refuses a substituted placeholder and never removes the replacement',t=>{
 const f=fixture(t);noLinks(t);const held=path.join(f.root,'saved-placeholder');
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target,{onPlaceholder:()=>{renameSync(f.target,held);writeFileSync(f.target,'a foreign file');}}),code('PROJECT_FILE_EXISTS'));
 assert.equal(readFileSync(f.target,'utf8'),'a foreign file');assert.equal(readFileSync(held).length,0);assert.deepEqual(readFileSync(f.stage),f.bytes);
});

test('an intent write failure cleans only its own placeholder and retains the complete stage',t=>{
 const f=fixture(t);noLinks(t);const sentinel=Error('intent write failed');
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target,{onPlaceholder:()=>{throw sentinel;}}),error=>error===sentinel);
 assert.equal(existsSync(f.target),false);assert.deepEqual(readFileSync(f.stage),f.bytes);
});

test('rename failure removes the owned placeholder without changing the stage',t=>{
 const f=fixture(t);noLinks(t);t.mock.method(fs,'renameSync',()=>{throw Object.assign(Error('denied'),{code:'EACCES'});});syncBuiltinESMExports();
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target),code('EACCES'));assert.equal(existsSync(f.target),false);assert.deepEqual(readFileSync(f.stage),f.bytes);
});

for(const links of [true,false])test(`failure after publication preserves the complete public file (${links?'links':'fallback'})`,t=>{
 const f=fixture(t);if(!links)noLinks(t);const sentinel=Error('receipt sync failed');
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target,{onPublished:()=>{throw sentinel;}}),error=>error===sentinel);
 assert.deepEqual(readFileSync(f.target),f.bytes);
});

test('unavailable wx publication is reported explicitly while the V2 link-only contract stays unchanged',t=>{
 const f=fixture(t);noLinks(t);
 assert.throws(()=>publishCopiedFile(f.stage,f.target),code('EOPNOTSUPP'));assert.equal(existsSync(f.target),false);
 const open=fs.openSync;t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{if(String(args[0])===f.target)throw Object.assign(Error('unsupported'),{code:'ENOTSUP'});return open(...args);});syncBuiltinESMExports();
 assert.throws(()=>publishProjectCopyFile(f.stage,f.target),code('PROJECT_COPY_UNSUPPORTED_FILESYSTEM'));assert.equal(existsSync(f.target),false);assert.deepEqual(readFileSync(f.stage),f.bytes);
});

test('portable stage directories allow ordinary project permissions but never a symbolic ancestor',t=>{
 const f=fixture(t);chmodSync(f.root,0o755);const stage=createProjectCopyStagingDirectory(f.root,'.project-copy-');
 assert.equal(validateProjectCopyStagingDirectory(stage).isDirectory(),true);assert.equal(Number(lstatSync(f.root).mode)&0o777,0o755);
 const alias=path.join(f.root,'alias');symlinkSync(stage,alias);
 assert.throws(()=>validateProjectCopyStagingDirectory(alias),code('PROJECT_LOCATION_INVALID'));
 assert.throws(()=>createProjectCopyStagingDirectory(alias),code('PROJECT_LOCATION_INVALID'));
 assert.throws(()=>createProjectCopyStagingDirectory(f.root,'../escape'),TypeError);
});
