import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,statSync,renameSync,copyFileSync,openSync,closeSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';
import {createLocalDrafts} from '../packages/business/src/local-drafts.ts';
import {createLastProject} from '../packages/business/src/last-project.ts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';

// Frozen old sidecar formula is deliberately independent of the shared helper.
const legacy=({channel,root,directory,db})=>createHash('sha256').update(JSON.stringify([channel,path.resolve(root),String(directory.dev),String(directory.ino),String(db.dev),String(db.ino),db.birthtimeMs??null])).digest('hex');
const base={channel:'web',root:path.resolve('/work/example'),directory:{dev:1,ino:2},db:{dev:3,ino:4}};
const storage={readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile};
function fixture(t){
  const parent=mkdtempSync(path.join(tmpdir(),'mioon-workspace-scope-')),root=path.join(parent,'workspace');
  mkdirSync(root,{mode:0o700});writeFileSync(path.join(root,'workbench.sqlite'),'database bytes',{mode:0o600});
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const input=(channel='web')=>({channel,root,directory:validatePrivateDirectory(root),db:validateManagedFile(path.join(root,'workbench.sqlite'),{root})});
  return {parent,root,input,scope:()=>calculateWorkspaceScope(input())};
}

test('frozen identity vectors preserve exact SHA-256 field order and encodings',{skip:process.platform==='win32'},()=>{
  const vectors=[
    [base,'c926cf02905124ed3dcf1c927d5824bf1ad4618b6888036ecabe5f83d7cce269'],
    [{...base,channel:'production',db:{dev:3,ino:4,birthtimeMs:0}},'4860ddba2acec4fe9a79d4978e0026b1674f0a38d5899b637a8f16b46711061d'],
    [{channel:'development',root:'/work/工作区',directory:{dev:9007199254740993n,ino:18446744073709551615n},db:{dev:7n,ino:8n,birthtimeMs:1700000000123.456}},'4b59c6195b6b919f736fc9ec33e28d049bed8854092ab902a8586acf4be13326'],
  ];
  for(const [input,expected] of vectors){assert.equal(legacy(input),expected);assert.equal(calculateWorkspaceScope(input),expected);}
});

test('number and bigint IDs, absent birthtime and lexical path resolution retain legacy behavior',()=>{
  const scope=calculateWorkspaceScope(base);
  assert.equal(calculateWorkspaceScope({...base,directory:{dev:1n,ino:2n},db:{dev:3n,ino:4n}}),scope);
  assert.equal(calculateWorkspaceScope({...base,db:{...base.db,birthtimeMs:undefined}}),scope);
  assert.notEqual(calculateWorkspaceScope({...base,db:{...base.db,birthtimeMs:0}}),scope);
  assert.equal(calculateWorkspaceScope({...base,root:base.root+'/child/../'}),scope);
  assert.equal(calculateWorkspaceScope({...base,directory:{...base.directory,birthtimeMs:99}}),scope);
  for(const channel of ['web','production','development']){
    const input={...base,channel};assert.equal(calculateWorkspaceScope(input),legacy(input));
  }
  for(const input of [
    {...base,channel:'production'}, {...base,channel:'development'}, {...base,root:base.root+'-other'},
    {...base,directory:{...base.directory,dev:99}}, {...base,directory:{...base.directory,ino:99}},
    {...base,db:{...base.db,dev:99}}, {...base,db:{...base.db,ino:99}}, {...base,db:{...base.db,birthtimeMs:99}},
  ]){assert.notEqual(calculateWorkspaceScope(input),scope);assert.equal(calculateWorkspaceScope(input),legacy(input));}
});

test('filesystem identity survives reopen and in-place writes, but not copied or replaced database',t=>{
  const f=fixture(t),before=f.scope(),dbFile=path.join(f.root,'workbench.sqlite');
  const fd=openSync(dbFile,'r');closeSync(fd);assert.equal(f.scope(),before);
  writeFileSync(dbFile,'changed database bytes');assert.equal(f.scope(),before);
  assert.equal(f.scope(),legacy(f.input()));
  const copied=fixture(t);copyFileSync(dbFile,path.join(copied.root,'workbench.sqlite'));assert.notEqual(copied.scope(),before);
  const replacement=path.join(f.root,'replacement.sqlite');copyFileSync(dbFile,replacement);
  assert.notEqual(statSync(replacement).ino,statSync(dbFile).ino);
  renameSync(replacement,dbFile);assert.notEqual(f.scope(),before);
});

test('replacement directory changes identity even when original database inode is retained',t=>{
  const f=fixture(t),before=f.input(),oldRoot=path.join(f.parent,'old-workspace');
  renameSync(f.root,oldRoot);mkdirSync(f.root,{mode:0o700});
  renameSync(path.join(oldRoot,'workbench.sqlite'),path.join(f.root,'workbench.sqlite'));
  const after=f.input();assert.equal(after.db.ino,before.db.ino);assert.notEqual(after.directory.ino,before.directory.ino);
  assert.notEqual(calculateWorkspaceScope(after),calculateWorkspaceScope(before));
});

test('draft and last-project services share legacy identity without weakening caller guards',t=>{
  const f=fixture(t),key={projectId:'11111111-1111-4111-8111-111111111111',timelineId:'22222222-2222-4222-8222-222222222222',clipId:'33333333-3333-4333-8333-333333333333'};
  let ownsLock=true;
  const guards={ownsLock:()=>ownsLock,isRestored:()=>false,readTimeline:()=>null,readClipAsset:()=>null,readProject:()=>null};
  for(const channel of ['web','production','development']){
    const options={root:f.root,channel,storage,guards},drafts=createLocalDrafts(options),lastProject=createLastProject(options);
    assert.equal(drafts.get(key).workspaceScope,legacy(f.input(channel)));
    assert.equal(lastProject.get().workspaceScope,legacy(f.input(channel)));
    ownsLock=false;
    assert.throws(()=>drafts.get(key),{code:'LOCAL_DRAFT_OWNER_REQUIRED'});
    assert.throws(()=>lastProject.get(),{code:'LAST_PROJECT_OWNER_REQUIRED'});
    ownsLock=true;
  }
  for(const [create,code] of [[createLocalDrafts,'LOCAL_DRAFT_VALIDATION'],[createLastProject,'LAST_PROJECT_VALIDATION']]){
    assert.throws(()=>create({root:'relative',storage,guards}),{code});
  }
  const options={root:f.root,storage,guards},drafts=createLocalDrafts(options),lastProject=createLastProject(options);
  drafts.get(key);lastProject.get();
  const replacement=path.join(f.root,'replacement.sqlite');writeFileSync(replacement,'replacement',{mode:0o600});renameSync(replacement,path.join(f.root,'workbench.sqlite'));
  assert.throws(()=>drafts.get(key),{code:'LOCAL_DRAFT_SCOPE_MISMATCH'});
  assert.throws(()=>lastProject.get(),{code:'LAST_PROJECT_SCOPE_MISMATCH'});
});
