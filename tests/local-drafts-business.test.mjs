import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,statSync,copyFileSync,symlinkSync,linkSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.mjs';
import {createLocalDrafts,LOCAL_DRAFT_FILENAME} from '../packages/business/src/local-drafts.ts';
import {LOCAL_DRAFT_LIMITS,clipDraftEnvelopeSchema,clipDraftListSchema} from '@mioon/contracts/local-drafts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';

const storage={readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile};
const code=value=>error=>error.code===value&&!error.message.includes('PRIVATE');
async function fixture(t){
  const root=mkdtempSync(path.join(tmpdir(),'mioon-local-draft-'));let store=openStore(root),service=createServices(store,new Map()),drafts,fault=()=>{};
  const project=await service.call('project.create',{name:'Local draft'});
  const assetId=randomUUID();const asset=store.put('assets',{id:assetId,projectId:project.id,name:'Synthetic',mimeType:'image/png',width:2,height:2,hasVideo:true,hasAudio:false,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${assetId}.png`,createdAt:new Date().toISOString()});
  let timeline=await service.call('timeline.get',{projectId:project.id});
  timeline=await service.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:90});
  const clip=timeline.clips[0],key={projectId:project.id,timelineId:timeline.id,clipId:clip.id};
  const raw={name:'Unsubmitted input',trackId:clip.trackId,startFrame:'',durationFrames:'9e',sourceInFrame:'0',rect:{x:'0',y:'',width:'-1',height:720},gain:'0.',fadeInFrames:''};
  function start(channel='web',extra={}){drafts=createLocalDrafts({root,channel,storage,guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),readTimeline:id=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read(),readClipAsset:(id,c)=>createTimelineRecoveryBoundary(store.db,{projectId:id}).clipSource(c)},fault:point=>fault(point),...extra});return drafts;}
  start();
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,file:path.join(root,LOCAL_DRAFT_FILENAME),key,project,asset,timeline,clip,raw,get store(){return store;},get drafts(){return drafts;},start,setFault(fn){fault=fn;},
    input(response=drafts.get(key),patch={}){return {workspaceScope:response.workspaceScope,instanceId:response.instanceId,...key,expectedRevision:response.revision,baseRevision:timeline.revision,source:{assetId:asset.id,assetSha256:asset.sha256},raw,...patch};},
    deletion(response){return {workspaceScope:response.workspaceScope,instanceId:response.instanceId,...key,expectedRevision:response.revision};},
    restart(){store.close();store=openStore(root);service=createServices(store,new Map());start();},
    snapshot(){return JSON.stringify(store.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all())+'\n'+JSON.stringify(['projects','assets','timelines','timeline_requests','timeline_history','edit_tasks'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));},
  };
}

test('GET/list are noncreating and draft writes retain raw text without changing business schemas or records',async t=>{
  const f=await fixture(t),before=f.snapshot(),changes=f.store.db.prepare('SELECT total_changes() n').get().n;
  const empty=f.drafts.get(f.key);assert.equal(empty.revision,0);assert.equal(empty.draft,null);assert.equal(existsSync(f.file),false);assert.ok(clipDraftEnvelopeSchema.safeParse(empty).success);
  assert.deepEqual(f.drafts.list({projectId:f.project.id}).items,[]);assert.equal(existsSync(f.file),false);
  const put=f.drafts.put(f.input(empty));assert.equal(put.revision,1);assert.deepEqual(put.draft.raw,f.raw);assert.equal(Object.hasOwn(put.draft.raw,'fadeOutFrames'),false);
  assert.ok(clipDraftListSchema.safeParse(f.drafts.list({projectId:f.project.id})).success);assert.equal(f.drafts.list({projectId:f.project.id}).items[0].name,f.raw.name);
  assert.equal(statSync(f.file).mode&0o777,0o600);assert.equal(f.snapshot(),before);assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes);
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

test('scope survives store reopen but old instance requests cannot write; copied sidecars and other channels fail closed',async t=>{
  const f=await fixture(t),first=f.drafts.put(f.input()),oldInput=f.input(first);f.restart();
  const reopened=f.drafts.get(f.key);assert.equal(reopened.workspaceScope,first.workspaceScope);assert.notEqual(reopened.instanceId,first.instanceId);assert.deepEqual(reopened.draft,first.draft);
  assert.throws(()=>f.drafts.put(oldInput),code('LOCAL_DRAFT_STALE_INSTANCE'));
  const before=readFileSync(f.file);f.start('production');assert.throws(()=>f.drafts.get(f.key),code('LOCAL_DRAFT_SCOPE_MISMATCH'));assert.deepEqual(readFileSync(f.file),before);
  f.start();const foreign=await fixture(t);copyFileSync(f.file,foreign.file);chmodSync(foreign.file,0o600);assert.throws(()=>foreign.drafts.get(foreign.key),code('LOCAL_DRAFT_SCOPE_MISMATCH'));
});

test('persisted baseline/source never rebase; deleted target draft stays discoverable and explicitly discardable',async t=>{
  const f=await fixture(t),saved=f.drafts.put(f.input());
  const next={...f.timeline,revision:f.timeline.revision+1};f.store.put('timelines',next);
  assert.equal(f.drafts.get(f.key).targetStatus,'changed');
  assert.throws(()=>f.drafts.put(f.input(saved,{baseRevision:next.revision})),code('LOCAL_DRAFT_CONFLICT'));
  const retained=f.drafts.put(f.input(saved,{raw:{...f.raw,name:'Still editing'}}));assert.equal(retained.draft.baseRevision,f.timeline.revision);assert.equal(retained.targetStatus,'changed');
  f.store.put('timelines',{...next,clips:[],durationFrames:0});
  const missing=f.drafts.get(f.key);assert.equal(missing.targetStatus,'missing');assert.equal(f.drafts.list({projectId:f.project.id}).items[0].targetStatus,'missing');
  assert.equal(f.drafts.discard(f.deletion(missing)).draft,null);
});

test('unreadable/corrupt/unknown-format storage never means empty and never gets overwritten',async t=>{
  const f=await fixture(t);const input=f.input();
  for(const contents of ['{','null',JSON.stringify({version:2,workspaceScope:input.workspaceScope,entries:[]}),JSON.stringify({version:1,workspaceScope:input.workspaceScope,entries:[],credentials:'PRIVATE'})]){
    writeFileSync(f.file,contents,{mode:0o600});const before=readFileSync(f.file);
    assert.throws(()=>f.drafts.get(f.key),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),before);
  }
});

test('historical source ownership is required after clip removal before draft/name/revision disclosure or mutation',async t=>{
  const f=await fixture(t),saved=f.drafts.put(f.input()),before=readFileSync(f.file);
  f.store.put('timelines',{...f.timeline,revision:f.timeline.revision+1,clips:[],durationFrames:0});
  const foreign=randomUUID();f.store.put('projects',{...f.project,id:foreign});
  f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(foreign,JSON.stringify({...f.asset,projectId:foreign}),f.asset.id);
  for(const call of [()=>f.drafts.get(f.key),()=>f.drafts.list({projectId:f.project.id}),()=>f.drafts.put(f.input(saved)),()=>f.drafts.discard(f.deletion(saved))])assert.throws(call,code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));
  assert.deepEqual(readFileSync(f.file),before);
});

test('strict fields reject credentials, paths, getters, proxies, malformed raw and oversized text without writing',async t=>{
  const f=await fixture(t),input=f.input();let touched=0;
  for(const bad of [{...input,apiKey:'PRIVATE'},{...input,path:'/PRIVATE'},{...input,raw:{...f.raw,extra:1}},{...input,source:{...input.source,path:'/PRIVATE'}},{...input,raw:{...f.raw,gain:'1'.repeat(49)}},{...input,raw:{...f.raw,name:'x'.repeat(201)}}])assert.throws(()=>f.drafts.put(bad),code('LOCAL_DRAFT_VALIDATION'));
  const getter={...input};Object.defineProperty(getter,'raw',{enumerable:true,get(){touched++;return f.raw;}});assert.throws(()=>f.drafts.put(getter),code('LOCAL_DRAFT_VALIDATION'));
  assert.throws(()=>f.drafts.put(new Proxy(input,{})),code('LOCAL_DRAFT_VALIDATION'));assert.equal(touched,0);assert.equal(existsSync(f.file),false);
});

test('existing 200-character clip names remain exact while another raw field changes',async t=>{
  const f=await fixture(t),name='长'.repeat(200),raw={...f.raw,name,startFrame:'30'};
  const saved=f.drafts.put(f.input(undefined,{raw}));assert.equal(saved.draft.raw.name,name);assert.equal(f.drafts.list({projectId:f.project.id}).items[0].name,name);
});

test('unsafe sidecar files and unavailable storage refuse without repairing permissions or replacing links',async t=>{
  const f=await fixture(t),input=f.input();writeFileSync(f.file,'{}',{mode:0o644});
  assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.equal(statSync(f.file).mode&0o777,0o644);rmSync(f.file);
  const target=path.join(f.root,'unrelated.json');writeFileSync(target,'PRIVATE',{mode:0o600});symlinkSync(target,f.file);
  assert.throws(()=>f.drafts.get(f.key),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.equal(readFileSync(target,'utf8'),'PRIVATE');
  rmSync(f.file);linkSync(target,f.file);assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.equal(readFileSync(target,'utf8'),'PRIVATE');
});

test('lock:false stores cannot write companion files',async t=>{
  const f=await fixture(t),input=f.input(),reader=openStore(f.root,{lock:false});t.after(()=>reader.close());
  const drafts=createLocalDrafts({root:f.root,storage,guards:{ownsLock:()=>ownsStoreLock(reader),isRestored:()=>false,readTimeline:()=>f.timeline,readClipAsset:()=>f.asset}});
  assert.throws(()=>drafts.put(input),code('LOCAL_DRAFT_OWNER_REQUIRED'));assert.equal(existsSync(f.file),false);
  assert.throws(()=>drafts.get(f.key),code('LOCAL_DRAFT_OWNER_REQUIRED'));assert.throws(()=>drafts.list({projectId:f.project.id}),code('LOCAL_DRAFT_OWNER_REQUIRED'));
});

test('duplicate slot identities and oversized companion files remain intact and unavailable',async t=>{
  const f=await fixture(t),saved=f.drafts.put(f.input()),disk=JSON.parse(readFileSync(f.file,'utf8'));disk.entries.push(disk.entries[0]);
  for(const bytes of [JSON.stringify(disk),'x'.repeat(LOCAL_DRAFT_LIMITS.envelopeBytes+1)]){
    writeFileSync(f.file,bytes);assert.throws(()=>f.drafts.get(f.key),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.drafts.discard(f.deletion(saved)),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.equal(readFileSync(f.file,'utf8'),bytes);
  }
});

test('malformed UTF-8 in an otherwise valid draft envelope is preserved as corrupt evidence',async t=>{
  const f=await fixture(t),saved=f.drafts.put(f.input()),text=readFileSync(f.file,'utf8'),at=text.indexOf(f.raw.name);
  const corrupt=Buffer.concat([Buffer.from(text.slice(0,at)),Buffer.from([0xff]),Buffer.from(text.slice(at+1))]);writeFileSync(f.file,corrupt);
  assert.throws(()=>f.drafts.get(f.key),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.drafts.put(f.input(saved)),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),corrupt);
});

test('restored profile is explicit unsupported without filesystem/project/provider access',()=>{
  const never=()=>{throw Error('PRIVATE should not run');};
  const drafts=createLocalDrafts({root:'/unread',storage:{validatePrivateDirectory:never,validateManagedFile:never,readPrivateFile:never,writePrivateFileAtomic:never},guards:{ownsLock:never,isRestored:()=>true,readTimeline:never,readClipAsset:never}});
  for(const method of ['get','list','put','discard'])assert.deepEqual(drafts[method]({}),{supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'});
});

for(const point of ['beforePersist','afterPersist','afterDirectorySync'])test(`failure at ${point} preserves either old or exact newly-published bytes without domain work`,async t=>{
  const f=await fixture(t),input=f.input(),before=f.snapshot();f.setFault(label=>{if(label===point)throw Error('PRIVATE fault');});
  assert.throws(()=>f.drafts.put(input),code(point==='beforePersist'?'LOCAL_DRAFT_STORAGE_UNAVAILABLE':'LOCAL_DRAFT_SAVE_UNCERTAIN'));f.setFault(()=>{});
  const found=f.drafts.get(f.key);assert.equal(found.revision,point==='beforePersist'?0:1);assert.equal(f.snapshot(),before);
  if(found.revision)assert.deepEqual(f.drafts.put(input),found);
});

test('logical slot capacity includes tombstones, refuses new slot without eviction',async t=>{
  const f=await fixture(t),response=f.drafts.get(f.key),entries=Array.from({length:LOCAL_DRAFT_LIMITS.slots},()=>({...f.key,clipId:randomUUID(),revision:1,draft:null}));
  writeFileSync(f.file,JSON.stringify({version:1,workspaceScope:response.workspaceScope,entries}),{mode:0o600});const before=readFileSync(f.file);
  assert.throws(()=>f.drafts.put(f.input(response)),code('LOCAL_DRAFT_CAPACITY'));assert.deepEqual(readFileSync(f.file),before);
});

test('exact PUT and DELETE retries require a successful durability checkpoint after an uncertain publication',async t=>{
  const f=await fixture(t),input=f.input();f.setFault(point=>{if(point==='beforeDirectorySync')throw Error('PRIVATE fsync fault');});
  assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.equal(f.drafts.get(f.key).revision,1);
  assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_SAVE_UNCERTAIN'));
  f.setFault(()=>{});const saved=f.drafts.put(input),remove=f.deletion(saved);
  f.setFault(point=>{if(point==='beforeDirectorySync')throw Error('PRIVATE fsync fault');});
  assert.throws(()=>f.drafts.discard(remove),code('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.equal(f.drafts.get(f.key).draft,null);
  assert.throws(()=>f.drafts.discard(remove),code('LOCAL_DRAFT_SAVE_UNCERTAIN'));
  f.setFault(()=>{});assert.equal(f.drafts.discard(remove).revision,2);
});

test('SDR colour drafts survive actual sidecar reopen without normalizing omitted, null or source-invalidated looks', async t => {
  const f = await fixture(t);
  const look = { resourceId: randomUUID(), resourceSha256: 'b'.repeat(64), resourceProfile: 'mioon-cube3d-normalized-tetrahedral-v1', purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: false, strength: 0.37 };
  const colour = { profileId: 'mioon-rec709-sdr-clip-v1', source: { assetSha256: f.asset.sha256, streamIndex: 0, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: '2026-10-14T18:00:00.000Z' }, look };
  for (const fields of [{}, { colour }, { colour: { ...colour, source: null } }, { colour: null }]) {
    const raw = { ...f.raw, ...fields }, before = f.snapshot();
    const saved = f.drafts.put(f.input(undefined, { raw }));
    assert.deepEqual(saved.draft.raw, raw); assert.equal(f.snapshot(), before, 'A sidecar draft never mutates the business timeline');
    f.restart();
    const reloaded = f.drafts.get(f.key);
    assert.deepEqual(reloaded.draft.raw, raw); assert.equal(Object.hasOwn(reloaded.draft.raw, 'colour'), Object.hasOwn(fields, 'colour'));
    f.drafts.discard(f.deletion(reloaded));
  }
});
