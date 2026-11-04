
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,existsSync,readFileSync,writeFileSync,statSync,copyFileSync,symlinkSync,linkSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {ownsStoreLock} from '../packages/business/src/store-runtime.ts';

import {createServices} from '../packages/business/src/services.ts';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.ts';
import {createLocalDrafts,LOCAL_DRAFT_FILENAME} from '../packages/business/src/local-drafts.ts';
import {LOCAL_DRAFT_LIMITS,clipDraftEnvelopeSchema,clipDraftListSchema} from '@mioon/contracts/local-drafts';

import {type TestContext} from 'node:test';
import {errorView} from './helpers/test-error.ts';
import {schemaObjects,withoutForeignKeys} from './helpers/project-database.ts';
import {clipDraftEntries,clipDraftSnapshot,seedClipDraftEntries} from './helpers/local-clip-draft-sql.ts';

interface DraftKey {projectId: string; timelineId: string; clipId: string}
interface DraftEnvelope {revision: number; draft: {raw: Record<string, unknown>; [key: string]: unknown} | null; workspaceScope?: string; instanceId?: string; [key: string]: unknown}
interface DraftsHandle {get(key: DraftKey): DraftEnvelope; put(input: unknown): DraftEnvelope; list(input: unknown): {items: DraftEnvelope[]}; discard(input: unknown): DraftEnvelope}
interface DraftFixture {root: string; file: string; key: DraftKey; project: {id: string}; asset: Record<string, unknown>; timeline: {id: string; revision: number; tracks: {id: string}[]; clips: {id: string; trackId: string}[]}; clip: {id: string; trackId: string}; raw: Record<string, unknown>; store: ReturnType<typeof openStore>; drafts: DraftsHandle;
  start(channel?: string, extra?: Record<string, unknown>): DraftsHandle; setFault(fn: (point: string) => void): void;
  input(response?: DraftEnvelope, patch?: Record<string, unknown>): Record<string, unknown> & {source: Record<string, unknown>};
  deletion(response: DraftEnvelope): Record<string, unknown>;
  restart(): void; snapshot(): string}

const code=(value: string)=>(error: unknown)=>{const failure=errorView(error);return failure.code===value&&!failure.message!.includes('PRIVATE');};
async function fixture(t: TestContext): Promise<DraftFixture> {
  const projectRoot=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-local-draft-'));let store=openStore(projectRoot);const root=store.localDir;let service=createServices(store,new Map()),drafts: DraftsHandle | undefined,fault: (point: string)=>void=()=>{};
  const project=await service.call('project.create',{name:'Local draft'}) as {id: string};
  const assetId=randomUUID();const asset=store.put('assets',{id:assetId,projectId:project.id,name:'Synthetic',mimeType:'image/png',width:2,height:2,hasVideo:true,hasAudio:false,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${assetId}.png`,createdAt:new Date().toISOString()});
  let timeline=await service.call('timeline.get',{projectId:project.id}) as {id: string; revision: number; tracks: {id: string}[]; clips: {id: string; trackId: string}[]};
  timeline=await service.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:90}) as {id: string; revision: number; tracks: {id: string}[]; clips: {id: string; trackId: string}[]};
  const clip=timeline.clips[0],key={projectId:project.id,timelineId:timeline.id,clipId:clip.id};
  const raw={name:'Unsubmitted input',trackId:clip.trackId,startFrame:'',durationFrames:'9e',sourceInFrame:'0',rect:{x:'0',y:'',width:'-1',height:720},gain:'0.',fadeInFrames:''};
  function start(channel: string='web',extra: Record<string, unknown>={}): DraftsHandle {drafts=createLocalDrafts({store,channel: channel as 'web',guards:{ownsLock:()=>ownsStoreLock(store),readTimeline:(id: string)=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read(),readClipAsset:(id: string,c: unknown)=>createTimelineRecoveryBoundary(store.db,{projectId:id}).clipSource(c as never)},fault:(point: string)=>fault(point),...extra} as never) as unknown as DraftsHandle;return drafts;}
  start();
  t.after(()=>{store!.close();rmSync(projectRoot,{recursive:true,force:true});});
  return {root,file:path.join(root,LOCAL_DRAFT_FILENAME),key,project,asset,timeline,clip,raw,get store(){return store!;},get drafts(){return drafts!;},start,setFault(fn: (point: string)=>void){fault=fn;},
    input(response: DraftEnvelope = drafts!.get(key), patch: Record<string, unknown>={}): Record<string, unknown> & {source: Record<string, unknown>} {return {workspaceScope:response.workspaceScope,instanceId:response.instanceId,...key,expectedRevision:response.revision,baseRevision:timeline.revision,source:{assetId:(asset as {id: string}).id,assetSha256:(asset as {sha256: string}).sha256},raw,...patch};},
    deletion(response: DraftEnvelope){return {workspaceScope:response.workspaceScope,instanceId:response.instanceId,...key,expectedRevision:response.revision};},
    restart(){store!.close();store=openStore(projectRoot);service=createServices(store,new Map());start();},
    snapshot(){return JSON.stringify(schemaObjects(store!.db).map(({name,sql})=>({name,sql})))+'\n'+JSON.stringify(['projects','assets','timelines','timeline_requests','timeline_history','edit_tasks'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));},
  } as unknown as DraftFixture;
}

test('GET/list are noncreating and draft writes retain raw text without changing business schemas or records',async t=>{
  const f=await fixture(t),before=f.snapshot(),changes=(f.store.db.prepare('SELECT total_changes() n').get() as {n: number}).n;
  const empty=f.drafts.get(f.key);assert.equal(empty.revision,0);assert.equal(empty.draft,null);assert.equal(existsSync(f.file),false);assert.ok(clipDraftEnvelopeSchema.safeParse(empty).success);
  assert.deepEqual(f.drafts.list({projectId:f.project.id}).items,[]);assert.equal(existsSync(f.file),false);assert.equal((f.store.db.prepare('SELECT total_changes() n').get() as {n:number}).n,changes);
  const put=f.drafts.put(f.input(empty));assert.equal(put.revision,1);assert.deepEqual(put.draft!.raw,f.raw);assert.equal(Object.hasOwn(put.draft!.raw,'fadeOutFrames'),false);
  assert.ok(clipDraftListSchema.safeParse(f.drafts.list({projectId:f.project.id})).success);assert.equal(f.drafts.list({projectId:f.project.id}).items[0].name,f.raw.name);
  assert.equal(existsSync(f.file),false);assert.equal(f.snapshot(),before);assert.ok((f.store.db.prepare('SELECT total_changes() n').get() as {n: number}).n>changes);
  assert.equal(clipDraftEntries(f.store).length,1);assert.equal(f.store.db.prepare("SELECT workspaceScope FROM local_draft_states WHERE kind='clip'").get()!.workspaceScope,put.workspaceScope);
});

test('exact latest PUT/DELETE retries, two-window CAS and tombstones prevent ABA',async t=>{
  const f=await fixture(t),input=f.input(),first=f.drafts.put(input);assert.deepEqual(f.drafts.put(input),first);
  const second=f.drafts.put(f.input(first,{raw:{...f.raw,name:'Newer'}}));
  assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_CONFLICT'));
  assert.throws(()=>f.drafts.discard(f.deletion(first)),code('LOCAL_DRAFT_CONFLICT'));
  const deleted=f.drafts.discard(f.deletion(second));assert.equal(deleted.revision,3);assert.equal(deleted.draft,null);assert.deepEqual(f.drafts.discard(f.deletion(second)),deleted);
  const recreated=f.drafts.put(f.input(deleted));assert.equal(recreated.revision,4);
  assert.throws(()=>f.drafts.discard(f.deletion(second)),code('LOCAL_DRAFT_CONFLICT'));
  assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_CONFLICT'));
});

test('a fresh target changed by reentrant business work is rechecked inside the save transaction',async t=>{
  const f=await fixture(t),input=f.input(),draftsBefore=clipDraftSnapshot(f.store);let reached=false,businessAfterChange='';
  f.setFault(point=>{if(point==='beforePersist'){
    reached=true;f.store.put('timelines',{...f.timeline,revision:f.timeline.revision+1});businessAfterChange=f.snapshot();
  }});
  assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_CONFLICT'));assert.ok(reached);
  assert.equal(clipDraftSnapshot(f.store),draftsBefore);assert.equal(f.snapshot(),businessAfterChange);
  assert.equal(clipDraftEntries(f.store).length,0);
});

test('historical source ownership changed before persist cannot publish a newer raw draft',async t=>{
  const f=await fixture(t),saved=f.drafts.put(f.input()),input=f.input(saved,{raw:{...f.raw,name:'New input'}}),draftsBefore=clipDraftSnapshot(f.store);let reached=false,businessAfterChange='';
  f.setFault(point=>{if(point==='beforePersist'){
    reached=true;const foreign=randomUUID();
    withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(foreign,JSON.stringify({...f.asset,projectId:foreign}),String(f.asset.id)));
    businessAfterChange=f.snapshot();
  }});
  assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.ok(reached);
  assert.equal(clipDraftSnapshot(f.store),draftsBefore);assert.equal(f.snapshot(),businessAfterChange);
  assert.equal(clipDraftEntries(f.store)[0].revision,saved.revision);
});

test('scope survives store reopen but old instance requests cannot write; channel scope stays fenced and old copied JSON is ignored',async t=>{
  const f=await fixture(t),first=f.drafts.put(f.input()),oldInput=f.input(first);f.restart();
  const reopened=f.drafts.get(f.key);assert.equal(reopened.workspaceScope,first.workspaceScope);assert.notEqual(reopened.instanceId,first.instanceId);assert.deepEqual(reopened.draft,first.draft);
  assert.throws(()=>f.drafts.put(oldInput),code('LOCAL_DRAFT_STALE_INSTANCE'));
  const before=clipDraftSnapshot(f.store);f.start('production');assert.throws(()=>f.drafts.get(f.key),code('LOCAL_DRAFT_SCOPE_MISMATCH'));assert.equal(clipDraftSnapshot(f.store),before);
  f.start();const foreign=await fixture(t),old=JSON.stringify({version:1,workspaceScope:first.workspaceScope,entries:clipDraftEntries(f.store)});writeFileSync(f.file,old,{mode:0o600});copyFileSync(f.file,foreign.file);
  assert.equal(foreign.drafts.get(foreign.key).revision,0);assert.notEqual(foreign.drafts.get(foreign.key).workspaceScope,first.workspaceScope);assert.equal(readFileSync(foreign.file,'utf8'),old);
});

test('persisted baseline/source never rebase; deleted target draft stays discoverable and explicitly discardable',async t=>{
  const f=await fixture(t),saved=f.drafts.put(f.input());
  const next={...f.timeline,revision:f.timeline.revision+1};f.store.put('timelines',next);
  assert.equal(f.drafts.get(f.key).targetStatus,'changed');
  assert.throws(()=>f.drafts.put(f.input(saved,{baseRevision:next.revision})),code('LOCAL_DRAFT_CONFLICT'));
  const retained=f.drafts.put(f.input(saved,{raw:{...f.raw,name:'Still editing'}}));assert.equal(retained.draft!.baseRevision,f.timeline.revision);assert.equal(retained.targetStatus,'changed');
  f.store.put('timelines',{...next,clips:[],durationFrames:0});
  const missing=f.drafts.get(f.key);assert.equal(missing.targetStatus,'missing');assert.equal(f.drafts.list({projectId:f.project.id}).items[0].targetStatus,'missing');
  assert.equal(f.drafts.discard(f.deletion(missing)).draft,null);
});

test('retired corrupt or unknown JSON is ignored without overwriting evidence or importing it',async t=>{
  const f=await fixture(t),input=f.input();
  for(const contents of ['{','null',JSON.stringify({version:3,workspaceScope:input.workspaceScope,entries:[]}),JSON.stringify({version:1,workspaceScope:input.workspaceScope,entries:[],credentials:'PRIVATE'})]){
    writeFileSync(f.file,contents,{mode:0o600});const before=readFileSync(f.file),revision=f.drafts.get(f.key).revision;
    assert.equal(revision,clipDraftEntries(f.store).length?1:0);assert.equal(f.drafts.put(input).revision,1);assert.deepEqual(readFileSync(f.file),before);
  }
});

test('historical source ownership is required after clip removal before draft/name/revision disclosure or mutation',async t=>{
  const f=await fixture(t),saved=f.drafts.put(f.input()),before=clipDraftSnapshot(f.store);
  f.store.put('timelines',{...f.timeline,revision:f.timeline.revision+1,clips:[],durationFrames:0} as never);
  const foreign=randomUUID();
  withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(foreign,JSON.stringify({...f.asset,projectId:foreign}),(f.asset as {id: string}).id));
  for(const call of [()=>f.drafts.get(f.key),()=>f.drafts.list({projectId:f.project.id}),()=>f.drafts.put(f.input(saved)),()=>f.drafts.discard(f.deletion(saved))])assert.throws(call,code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));
  assert.equal(clipDraftSnapshot(f.store),before);
});

test('strict fields reject credentials, paths, getters, proxies, malformed raw and oversized text without writing',async t=>{
  const f=await fixture(t),input=f.input();let touched=0;
  for(const bad of [{...input,apiKey:'PRIVATE'},{...input,path:'/PRIVATE'},{...input,raw:{...f.raw,extra:1}},{...input,source:{...input.source,path:'/PRIVATE'}},{...input,raw:{...f.raw,gain:'1'.repeat(49)}},{...input,raw:{...f.raw,name:'x'.repeat(201)}}])assert.throws(()=>f.drafts.put(bad),code('LOCAL_DRAFT_VALIDATION'));
  const getter={...input};Object.defineProperty(getter,'raw',{enumerable:true,get(){touched++;return f.raw;}});assert.throws(()=>f.drafts.put(getter),code('LOCAL_DRAFT_VALIDATION'));
  assert.throws(()=>f.drafts.put(new Proxy(input,{})),code('LOCAL_DRAFT_VALIDATION'));assert.equal(touched,0);assert.equal(existsSync(f.file),false);
});

test('existing 200-character clip names remain exact while another raw field changes',async t=>{
  const f=await fixture(t),name='长'.repeat(200),raw={...f.raw,name,startFrame:'30'};
  const saved=f.drafts.put(f.input(undefined,{raw}));assert.equal(saved.draft!.raw.name,name);assert.equal(f.drafts.list({projectId:f.project.id}).items[0].name,name);
});

test('retired unsafe JSON is never read, repaired or replaced and unrelated targets stay untouched',async t=>{
  const f=await fixture(t),input=f.input();writeFileSync(f.file,'{}',{mode:0o644});
  assert.equal(f.drafts.put(input).revision,1);assert.equal(statSync(f.file).mode&0o777,0o644);rmSync(f.file);
  const target=path.join(f.root,'unrelated.json');writeFileSync(target,'PRIVATE',{mode:0o600});symlinkSync(target,f.file);
  assert.equal(f.drafts.get(f.key).revision,1);assert.equal(readFileSync(target,'utf8'),'PRIVATE');
  rmSync(f.file);linkSync(target,f.file);assert.equal(f.drafts.put(input).revision,1);assert.equal(readFileSync(target,'utf8'),'PRIVATE');
});

test('a closed real kernel owner cannot write companion files',async t=>{
  const f=await fixture(t),input=f.input();assert.throws(()=>openStore(f.store.projectDir),{code:'PROJECT_LOCKED'});f.store.close();
  const drafts=createLocalDrafts({store:f.store,guards:{ownsLock:()=>ownsStoreLock(f.store),readTimeline:()=>f.timeline,readClipAsset:()=>f.asset}});
  assert.throws(()=>drafts.put(input),code('LOCAL_DRAFT_OWNER_REQUIRED'));assert.equal(existsSync(f.file),false);
  assert.throws(()=>drafts.get(f.key),code('LOCAL_DRAFT_OWNER_REQUIRED'));assert.throws(()=>drafts.list({projectId:f.project.id}),code('LOCAL_DRAFT_OWNER_REQUIRED'));
});

test('duplicate SQL slot identities and oversized rows refuse without changing saved evidence',async t=>{
  const f=await fixture(t),saved=f.drafts.put(f.input()),before=clipDraftSnapshot(f.store);
  for(const mutate of [()=>f.store.db.exec('INSERT INTO local_clip_drafts SELECT * FROM local_clip_drafts'),()=>f.store.db.prepare('UPDATE local_clip_drafts SET data=?').run('x'.repeat(LOCAL_DRAFT_LIMITS.envelopeBytes+1))]){
    assert.throws(mutate);assert.deepEqual(f.drafts.get(f.key),saved);assert.equal(clipDraftSnapshot(f.store),before);
  }
});

test('malformed UTF-8 cannot enter SQL draft data and retired corrupt bytes remain untouched',async t=>{
  const f=await fixture(t),saved=f.drafts.put(f.input()),before=clipDraftSnapshot(f.store),corrupt=Buffer.from([0x7b,0xff,0x7d]);writeFileSync(f.file,corrupt);
  assert.throws(()=>f.store.db.exec("UPDATE local_clip_drafts SET data=CAST(x'7bff7d' AS TEXT)"));
  assert.deepEqual(f.drafts.get(f.key),saved);assert.equal(clipDraftSnapshot(f.store),before);assert.deepEqual(readFileSync(f.file),corrupt);
});

for(const point of ['beforePersist','beforeCommit','afterCommit','afterPersist','afterConfirm'])test(`failure at ${point} preserves either old or exact newly-published bytes without domain work`,async t=>{
  const f=await fixture(t),input=f.input(),before=f.snapshot();f.setFault(label=>{if(label===point)throw Error('PRIVATE fault');});
  assert.throws(()=>f.drafts.put(input),code(['beforePersist','beforeCommit'].includes(point)?'LOCAL_DRAFT_STORAGE_UNAVAILABLE':'LOCAL_DRAFT_SAVE_UNCERTAIN'));f.setFault(()=>{});
  const found=f.drafts.get(f.key);assert.equal(found.revision,['beforePersist','beforeCommit'].includes(point)?0:1);assert.equal(f.snapshot(),before);
  if(found.revision)assert.deepEqual(f.drafts.put(input),found);
});

test('logical slot capacity includes tombstones, refuses new slot without eviction',async t=>{
  const f=await fixture(t),response=f.drafts.get(f.key),entries=Array.from({length:LOCAL_DRAFT_LIMITS.slots},()=>({...f.key,clipId:randomUUID(),revision:1,draft:null}));
  seedClipDraftEntries(f.store,String(response.workspaceScope),entries);const before=clipDraftSnapshot(f.store);
  assert.throws(()=>f.drafts.put(f.input(response)),code('LOCAL_DRAFT_CAPACITY'));assert.equal(clipDraftSnapshot(f.store),before);
});

test('exact PUT and DELETE retries require a successful durability checkpoint after an uncertain publication',async t=>{
  const f=await fixture(t),input=f.input();f.setFault(point=>{if(point==='beforeConfirm')throw Error('PRIVATE COMMIT confirmation fault');});
  assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.equal(f.drafts.get(f.key).revision,1);
  assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_SAVE_UNCERTAIN'));
  f.setFault(()=>{});const saved=f.drafts.put(input),remove=f.deletion(saved);
  f.setFault(point=>{if(point==='beforeConfirm')throw Error('PRIVATE COMMIT confirmation fault');});
  assert.throws(()=>f.drafts.discard(remove),code('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.equal(f.drafts.get(f.key).draft,null);
  assert.throws(()=>f.drafts.discard(remove),code('LOCAL_DRAFT_SAVE_UNCERTAIN'));
  f.setFault(()=>{});assert.equal(f.drafts.discard(remove).revision,2);
});

test('SDR colour drafts survive actual history reopen without normalizing omitted, null or source-invalidated looks', async t => {
  const f = await fixture(t);
  const look = { resourceId: randomUUID(), resourceSha256: 'b'.repeat(64), resourceProfile: 'mioon-cube3d-normalized-tetrahedral-v1', purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: false, strength: 0.37 };
  const colour = { profileId: 'mioon-rec709-sdr-clip-v1', source: { assetSha256: f.asset.sha256, streamIndex: 0, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: '2026-10-14T18:00:00.000Z' }, look };
  for (const fields of [{}, { colour }, { colour: { ...colour, source: null } }, { colour: null }]) {
    const raw = { ...f.raw, ...fields }, before = f.snapshot();
    const saved = f.drafts.put(f.input(undefined, { raw }));
    assert.deepEqual(saved.draft!.raw, raw); assert.equal(f.snapshot(), before, 'A local history draft never mutates the business timeline');
    f.restart();
    const reloaded = f.drafts.get(f.key);
    assert.deepEqual(reloaded.draft!.raw, raw); assert.equal(Object.hasOwn(reloaded.draft!.raw, 'colour'), Object.hasOwn(fields, 'colour'));
    f.drafts.discard(f.deletion(reloaded));
  }
});
