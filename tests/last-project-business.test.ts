import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,statSync,copyFileSync,symlinkSync,linkSync,chmodSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createLastProject,readLastProjectTarget,LAST_PROJECT_FILENAME, type LastProjectOptions} from '@mioon/business/last-project';
import {LAST_PROJECT_LIMITS,lastProjectEnvelopeSchema} from '@mioon/contracts/last-project';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import type { SQLInputValue } from 'node:sqlite';

type FixtureEnvelope = Extract<ReturnType<ReturnType<typeof createLastProject>['get']>,{supported: true}>;
type FixtureLocator = Omit<ReturnType<typeof createLastProject>,'get'|'put'> & {get(): FixtureEnvelope; put(input: unknown): FixtureEnvelope};
const storage={readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile};
const code=(value: string)=>(error: unknown)=>(error as { code: string; message: string|string[]; }).code===value&&!(error as { code: string; message: string|string[]; }).message.includes('PRIVATE');
async function fixture(t: test.TestContext){
  const root=mkdtempSync(path.join(tmpdir(),'mioon-last-project-'));let store=(openStore(root) as unknown as TypedStore),fault: (point: string) => void=()=>{},locator!: FixtureLocator;
  const services=(createServices(store,new Map()) as unknown as TypedServices),project=await services.call('project.create',{name:'Existing project'}),other=await services.call('project.create',{name:'Other existing project'});
  const options=()=>({root,storage,guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),readProject:(id: string)=>readLastProjectTarget(store.db,id)},fault:(point: string)=>fault(point)});
  const start=(extra: Partial<LastProjectOptions>={})=>locator=createLastProject({...options(),...extra}) as FixtureLocator;start();
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,file:path.join(root,LAST_PROJECT_FILENAME),project,other,get store(){return store;},get locator(){return locator;},start,options,
    setFault(fn: (point: string) => void){fault=fn;},input(value: Extract<ReturnType<typeof locator.get>,{supported: true}>=locator.get() as Extract<ReturnType<typeof locator.get>,{supported: true}>,projectId: string|undefined=project.id){return {workspaceScope:value.workspaceScope,instanceId:value.instanceId,expectedRevision:value.revision,projectId};},
    restart(){store.close();store=(openStore(root) as unknown as TypedStore);start();},
    snapshot(){return JSON.stringify(store.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all())+'\n'+JSON.stringify(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,store.db.prepare(`SELECT * FROM "${(name as string).replaceAll('"','""')}" ORDER BY rowid`).all()]));},
  };
}

test('unset GET is noncreating; private fixed sidecar never mutates DB, schema, history or project/timeline',async t=>{
  const f=await fixture(t),before=f.snapshot(),changes=(f.store.db.prepare('SELECT total_changes() n').get())!.n;
  const empty=f.locator.get();assert.ok(lastProjectEnvelopeSchema.safeParse(empty).success);
  assert.deepEqual({...empty,workspaceScope:'scope',instanceId:'instance'},{supported:true,workspaceScope:'scope',instanceId:'instance',revision:0,projectId:null,updatedAt:null,targetStatus:'unset'});
  assert.equal(existsSync(f.file),false);assert.deepEqual(f.locator.get(),empty);
  const saved=f.locator.put(f.input(empty));assert.equal(saved.projectId,f.project.id);assert.equal(saved.revision,1);assert.equal(saved.targetStatus,'matching');assert.ok(lastProjectEnvelopeSchema.safeParse(saved).success);
  assert.equal(statSync(f.file).mode&0o777,0o600);assert.ok(statSync(f.file).size<=4096);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.file,'utf8'))).sort(),['projectId','revision','updatedAt','version','workspaceScope']);
  assert.equal(f.snapshot(),before);assert.equal((f.store.db.prepare('SELECT total_changes() n').get())!.n,changes);
});

test('CAS, immediate exact replay, two locator instances, restart and stale authority all fail closed',async t=>{
  const f=await fixture(t),first=f.locator,other=createLastProject(f.options()) as FixtureLocator,a=first.get(),b=other.get();assert.notEqual(a.instanceId,b.instanceId);assert.equal(a.workspaceScope,b.workspaceScope);
  const input=f.input(a),saved=first.put(input),bytes=readFileSync(f.file),metadata=statSync(f.file);
  assert.deepEqual(first.put(input),saved);assert.deepEqual(readFileSync(f.file),bytes);assert.equal(statSync(f.file).mtimeMs,metadata.mtimeMs);
  assert.throws(()=>other.put(input),code('LAST_PROJECT_STALE_INSTANCE'));
  assert.throws(()=>other.put(f.input(b,f.other.id)),code('LAST_PROJECT_CONFLICT'));
  const second=other.put(f.input(other.get(),f.other.id));assert.equal(second.revision,2);
  assert.throws(()=>first.put(input),code('LAST_PROJECT_CONFLICT'));
  f.restart();const restarted=f.locator.get();assert.equal(restarted.workspaceScope,a.workspaceScope);assert.notEqual(restarted.instanceId,a.instanceId);assert.equal(restarted.projectId,f.other.id);assert.equal(restarted.revision,2);
  assert.throws(()=>f.locator.put(f.input(second)),code('LAST_PROJECT_STALE_INSTANCE'));
  assert.throws(()=>f.locator.put({...f.input(restarted),workspaceScope:'f'.repeat(64)}),code('LAST_PROJECT_SCOPE_MISMATCH'));
});

test('missing remembered project is discoverable without reset; PUT missing target refuses even on replay',async t=>{
  const f=await fixture(t),input=f.input(),saved=f.locator.put(input),bytes=readFileSync(f.file);
  const protectedState=f.snapshot();assert.throws(()=>f.store.db.prepare('DELETE FROM projects WHERE id=?').run(f.project.id),/FOREIGN KEY/);
  assert.equal(f.snapshot(),protectedState,'the live target foreign key blocks raw project deletion');
  // The locator is independent of these shared business services. Use their
  // real project cleanup, preserving the locator's remembered missing target.
  const service=(createServices(f.store,new Map()) as unknown as TypedServices);let removed=false;
  const noDrafts=(projectId: unknown)=>{assert.equal(projectId,f.project.id);for(const name of ['local-drafts-v1.json','local-delivery-v1.json','local-shot-text-v1.json'])assert.equal(existsSync(path.join(f.root,name)),false);};
  service.setProjectDeletionCompanions({assertDeletable:noDrafts,removeProject:projectId=>{noDrafts(projectId);removed=true;}});
  const deleted=await service.call('project.delete',{projectId:f.project.id,expectedRevision:f.project.revision,requestId:randomUUID(),confirmPermanentDeletion:true});
  assert.equal(deleted.cleanup,'complete');assert.equal(removed,true);
  const before=f.snapshot(),found=f.locator.get();
  assert.deepEqual(found,{...saved,targetStatus:'missing'});assert.deepEqual(readFileSync(f.file),bytes);assert.equal(f.snapshot(),before);
  assert.throws(()=>f.locator.put(input),code('LAST_PROJECT_NOT_FOUND'));
  assert.throws(()=>f.locator.put(f.input(found,randomUUID())),code('LAST_PROJECT_NOT_FOUND'));
  assert.deepEqual(readFileSync(f.file),bytes);
  assert.equal(f.locator.put(f.input(found,f.other.id)).revision,2);
});

test('bounded SQL rejects relational/JSON identity disagreement, malformed and oversized target rows',async t=>{
  const f=await fixture(t),input=f.input();
  const guard=(f.store.db.prepare("SELECT sql FROM sqlite_schema WHERE name='agent_target_projects_update_v2'").get())!.sql,before=f.snapshot();
  assert.throws(()=>f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run('{',f.project.id),/malformed JSON/);
  assert.equal(f.snapshot(),before,'the live target guard atomically rejects malformed project JSON');
  const corrupt=(data: SQLInputValue)=>{
    f.store.db.exec('DROP TRIGGER agent_target_projects_update_v2');
    try{f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(data,f.project.id);}
    finally{f.store.db.exec(guard as string);}
    assert.equal((f.store.db.prepare("SELECT sql FROM sqlite_schema WHERE name='agent_target_projects_update_v2'").get())!.sql,guard);
  };
  for(const data of [JSON.stringify({...f.project,id:f.other.id}),'null','{','x'.repeat(16385),JSON.stringify({...f.project,name:'x'.repeat(20000)})]){
    corrupt(data);
    assert.throws(()=>f.locator.put(input),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));assert.equal(existsSync(f.file),false);
  }
  corrupt(JSON.stringify(f.project));f.locator.put(input);
  corrupt(JSON.stringify({...f.project,id:f.other.id}));
  assert.throws(()=>f.locator.get(),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));
});

test('strict direct input refuses unknown keys, getters, proxies and nonplain nested values without evaluation',async t=>{
  const f=await fixture(t),input=f.input();let touched=0;
  for(const bad of [{...input,path:'/PRIVATE'},{...input,token:'PRIVATE'},{...input,expectedRevision:-1},{...input,expectedRevision:0.5},{...input,expectedRevision:Number.MAX_SAFE_INTEGER+1},{...input,projectId:{}},{...input,projectId:'bad'},null,[],Object.create(input)])assert.throws(()=>f.locator.put(bad),code('LAST_PROJECT_VALIDATION'));
  const getter={...input};Object.defineProperty(getter,'projectId',{enumerable:true,get(){touched++;return f.project.id;}});
  assert.throws(()=>f.locator.put(getter),code('LAST_PROJECT_VALIDATION'));
  const proxy=new Proxy(input,{getPrototypeOf(){touched++;throw Error('PRIVATE');},ownKeys(){touched++;throw Error('PRIVATE');}});assert.throws(()=>f.locator.put(proxy),code('LAST_PROJECT_VALIDATION'));
  assert.throws(()=>f.locator.put({...input,projectId:'x'.repeat(2049)}),code('LAST_PROJECT_LIMIT'));assert.equal(touched,0);assert.equal(existsSync(f.file),false);
});

test('corrupt, future, extra-field, oversized and invalid UTF-8 sidecars never reset or overwrite',async t=>{
  const f=await fixture(t),input=f.input(),saved=f.locator.put(input),disk=JSON.parse(readFileSync(f.file,'utf8'));
  for(const bytes of ['{','null',JSON.stringify({...disk,version:2}),JSON.stringify({...disk,revision:0}),JSON.stringify({...disk,projectId:null}),JSON.stringify({...disk,path:'/PRIVATE'}),'x'.repeat(LAST_PROJECT_LIMITS.fileBytes+1),Buffer.from([0xff])]){
    writeFileSync(f.file,bytes);const before=readFileSync(f.file);
    assert.throws(()=>f.locator.get(),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.locator.put(f.input(saved)),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),before);
  }
});

test('foreign root and trusted build channel remain distinct and preserve copied evidence',async t=>{
  const f=await fixture(t);f.locator.put(f.input());const before=readFileSync(f.file);
  f.start({channel:'production'});assert.throws(()=>f.locator.get(),code('LAST_PROJECT_SCOPE_MISMATCH'));assert.deepEqual(readFileSync(f.file),before);
  const foreign=await fixture(t);copyFileSync(f.file,foreign.file);chmodSync(foreign.file,0o600);assert.throws(()=>foreign.locator.get(),code('LAST_PROJECT_SCOPE_MISMATCH'));assert.deepEqual(readFileSync(foreign.file),before);
});

test('symlinks, hardlinks, foreign modes and directories fail closed without repairing files',async t=>{
  const f=await fixture(t),input=f.input(),outside=path.join(f.root,'unrelated');writeFileSync(outside,'PRIVATE',{mode:0o600});
  writeFileSync(f.file,'{}',{mode:0o644});assert.throws(()=>f.locator.get(),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));assert.equal(statSync(f.file).mode&0o777,0o644);rmSync(f.file);
  symlinkSync(outside,f.file);assert.throws(()=>f.locator.put(input),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));assert.equal(readFileSync(outside,'utf8'),'PRIVATE');rmSync(f.file);
  linkSync(outside,f.file);assert.throws(()=>f.locator.get(),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));assert.equal(readFileSync(outside,'utf8'),'PRIVATE');rmSync(f.file);
  chmodSync(f.root,0o755);assert.throws(()=>f.locator.get(),code('LAST_PROJECT_OWNER_REQUIRED'));assert.equal(statSync(f.root).mode&0o777,0o755);chmodSync(f.root,0o700);
});

test('actual exclusive lock ownership is required, including before exact replay',async t=>{
  const f=await fixture(t),input=f.input();assert.throws(()=>(openStore(f.root) as unknown as TypedStore));
  const reader=(openStore(f.root,{lock:false}) as unknown as TypedStore);t.after(()=>reader.close());
  const unowned=createLastProject({...f.options(),guards:{...f.options().guards,ownsLock:()=>ownsStoreLock(reader)}});
  assert.throws(()=>unowned.get(),code('LAST_PROJECT_OWNER_REQUIRED'));assert.throws(()=>unowned.put(input),code('LAST_PROJECT_OWNER_REQUIRED'));assert.equal(existsSync(f.file),false);
  f.locator.put(input);const before=readFileSync(f.file);unlinkSync(path.join(f.root,'server.lock'));
  assert.throws(()=>f.locator.get(),code('LAST_PROJECT_OWNER_REQUIRED'));assert.throws(()=>f.locator.put(input),code('LAST_PROJECT_OWNER_REQUIRED'));assert.deepEqual(readFileSync(f.file),before);
});

test('restored profile returns exact unsupported before all storage, ownership and target access',()=>{
  const never=()=>{throw Error('PRIVATE access forbidden');};
  const locator=createLastProject({root:'/unread',storage:{validatePrivateDirectory:never,validateManagedFile:never,readPrivateFile:never,writePrivateFileAtomic:never},guards:{ownsLock:never,isRestored:()=>true,readProject:never}});
  assert.deepEqual(locator.get(),{supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'});assert.deepEqual(locator.put(new Proxy({},{})),{supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'});
});

for(const point of ['beforePersist','afterPersist','beforeDirectorySync','afterDirectorySync'])test(`fault at ${point} preserves old or exact published bytes and never changes the database`,async t=>{
  const f=await fixture(t),input=f.input(),before=f.snapshot();f.setFault((label: string)=>{if(label===point)throw Error('PRIVATE fault');});
  assert.throws(()=>f.locator.put(input),code(point==='beforePersist'?'LAST_PROJECT_STORAGE_UNAVAILABLE':'LAST_PROJECT_SAVE_UNCERTAIN'));
  const found=f.locator.get();assert.equal(found.revision,point==='beforePersist'?0:1);assert.equal(f.snapshot(),before);
  if(point==='beforeDirectorySync'||point==='afterDirectorySync')assert.throws(()=>f.locator.put(input),code('LAST_PROJECT_SAVE_UNCERTAIN'));
  f.setFault(()=>{});const saved=f.locator.put(input);assert.equal(saved.revision,1);assert.deepEqual(f.locator.put(input),saved);
});

test('abort fence blocks read, fresh publication and exact replay without changing stored evidence',async t=>{
  const f=await fixture(t),controller=new AbortController();f.start({signal:controller.signal});const input=f.input();
  f.setFault((point: string)=>{if(point==='beforePersist')controller.abort();});assert.throws(()=>f.locator.put(input),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));assert.equal(existsSync(f.file),false);
  assert.throws(()=>f.locator.get(),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));
  f.setFault(()=>{});const other=new AbortController();f.start({signal:other.signal});const next=f.input();f.locator.put(next);const bytes=readFileSync(f.file);other.abort();
  assert.throws(()=>f.locator.put(next),code('LAST_PROJECT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),bytes);
});

test('envelope contract rejects inconsistent unset/null combinations and unknown fields',()=>{
  const authority={supported:true,workspaceScope:'a'.repeat(64),instanceId:randomUUID()},unset={...authority,revision:0,projectId:null,updatedAt:null,targetStatus:'unset'};
  for(const value of [{...unset,revision:1},{...unset,targetStatus:'matching'},{...unset,projectId:randomUUID()},{...unset,path:'/PRIVATE'},{...authority,revision:0,projectId:randomUUID(),updatedAt:new Date().toISOString(),targetStatus:'matching'}])assert.equal(lastProjectEnvelopeSchema.safeParse(value).success,false);
});
