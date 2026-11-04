import {isProjectStore} from '../packages/business/src/project-file/store.ts';
import type {OrdinaryLocalDrafts} from './helpers/strict-timeline-audio-draft-types.ts';
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {ownsStoreLock} from '../packages/business/src/store-runtime.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.ts';
import {createLocalDrafts,LOCAL_DRAFT_FILENAME} from '../packages/business/src/local-drafts.ts';
import {clipDraftDiskSchema} from '@mioon/contracts/local-drafts';
import {schemaObjects} from './helpers/project-database.ts';
import {clipDraftEntries} from './helpers/local-clip-draft-sql.ts';

// These synchronous fault callbacks model explicit injected boundaries. They do
// not assert that ordinary JavaScript shutdown can interrupt synchronous calls.
const errorCode=(expected: string)=>(error: { code: string; message: string|string[]; })=>error?.code===expected&&!error.message.includes('PRIVATE');
async function fixture(t: test.TestContext){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-draft-publication-'));
  const store=(openStore(root) as TypedStore),services=(createServices(store,new Map()) as TypedServices),controller=new AbortController();
  const project=await services.call('project.create',{name:'Publication fence fixture'}),assetId=randomUUID();
  const asset=store.put('assets',{id:assetId,projectId:project.id,name:'Synthetic',mimeType:'image/png',width:2,height:2,hasVideo:true,hasAudio:false,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${assetId}.png`,createdAt:new Date().toISOString()});
  let timeline=await services.call('timeline.get',{projectId:project.id});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:90});
  const clip=timeline.clips[0],key={projectId:project.id,timelineId:timeline.id,clipId:clip.id};
  const raw={name:'Raw draft 文本',trackId:clip.trackId,startFrame:'',durationFrames:'9e',sourceInFrame:'0',rect:{x:'0',y:'',width:'-1',height:720},gain:'0.',fadeInFrames:''};
  assert.ok(isProjectStore(store));const localRoot=store.localDir;
  const file=path.join(localRoot,LOCAL_DRAFT_FILENAME),dbFile=path.join(localRoot,'history.db'),historyMode=fs.statSync(dbFile).mode&0o777;
  let owned=true,foreignScope=false,identityVariant:string|undefined,fault:(point:string)=>void=()=>{},sourceHook:()=>void=()=>{},identityHook:(target:string)=>void=()=>{},writes=0,published:Buffer|null=null;
  const originalLstat=fs.lstatSync;
  Object.defineProperty(fs,'lstatSync',{value:((target:Parameters<typeof fs.lstatSync>[0],...args:unknown[])=>{
    const info=Reflect.apply(originalLstat,fs,[target,...args]) as fs.Stats|fs.BigIntStats|undefined;
    if(String(target)!==dbFile)return info;
    identityHook(String(target));
    if(!info)return info;
    if(foreignScope||identityVariant==='identity')return Object.assign(Object.create(Object.getPrototypeOf(info)),info,{ino:typeof info.ino==='bigint'?info.ino+1n:info.ino+1});
    if(identityVariant==='type')return Object.assign(Object.create(Object.getPrototypeOf(info)),info,{isFile:()=>false});
    return info;
  }) as typeof fs.lstatSync});
  syncBuiltinESMExports();
  const sql=()=>Buffer.from(JSON.stringify({version:2,workspaceScope:store.db.prepare("SELECT workspaceScope FROM local_draft_states WHERE kind='clip'").get()?.workspaceScope??null,entries:clipDraftEntries(store)}));
  const guards={ownsLock:()=>owned&&ownsStoreLock(store),
    readTimeline:(id:string)=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read(),
    readClipAsset:(id:string,value:Parameters<ReturnType<typeof createTimelineRecoveryBoundary>["clipSource"]>[0])=>{sourceHook();return createTimelineRecoveryBoundary(store.db,{projectId:id}).clipSource(value);},
  };
  const drafts=createLocalDrafts(({store,guards,signal:controller.signal,fault:(point:string)=>{if(point==='afterPersist'){writes++;published=sql();}fault(point);}} as unknown as Parameters<typeof createLocalDrafts>[0])) as OrdinaryLocalDrafts;
  const snapshot=()=>{const objects=schemaObjects(store.db);return JSON.stringify({schema:objects.map(({name,sql})=>({name,sql})),tables:objects.filter(({type,name})=>type==='table'&&!name.startsWith('sqlite_')&&!['local_draft_states','local_clip_drafts','local_delivery_drafts','local_shot_text_drafts'].includes(name)).map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()])});};
  const initialBusiness=snapshot();
  t.after(()=>{Object.defineProperty(fs,'lstatSync',{value:originalLstat});syncBuiltinESMExports();try{assert.equal(snapshot(),initialBusiness,'draft fences must not change business records, schema, non-draft history or revisions');}finally{store.close();fs.rmSync(root,{recursive:true,force:true});}});
  const input=(response=drafts.get(key),patch={})=>({workspaceScope:response.workspaceScope,instanceId:response.instanceId,...key,expectedRevision:response.revision,baseRevision:timeline.revision,source:{assetId:asset.id,assetSha256:asset.sha256},raw,...patch});
  const deletion=(response: { workspaceScope: unknown; instanceId: unknown; revision: unknown; })=>({workspaceScope:response.workspaceScope,instanceId:response.instanceId,...key,expectedRevision:response.revision});
  return {root:localRoot,file,dbFile,key,raw,drafts,controller,input,deletion,snapshot,sql,historyMode,
    get writes(){return writes;},get published(){return published;},
    setFault(fn: (point:string)=>void){fault=fn;},setSourceHook(fn: ()=>void){sourceHook=fn;},setIdentityHook(fn: (target:string)=>void){identityHook=fn;},setIdentityVariant(value:string){identityVariant=value;},
    revoke(kind: string){if(kind==='owner')owned=false;else if(kind==='abort')controller.abort();else foreignScope=true;},
    restore(){owned=true;foreignScope=false;identityVariant=undefined;fs.chmodSync(localRoot,0o700);fault=()=>{};sourceHook=()=>{};identityHook=()=>{};},
  };
}
function prepare(f: Awaited<ReturnType<typeof fixture>>,method: string){
  const saved=f.drafts.put(f.input());
  const request=method==='put'?f.input(saved,{raw:{...f.raw,name:'Edited but unsubmitted',startFrame:'007'}}):f.deletion(saved);
  return {saved,request,call:()=>method==='put'?f.drafts.put(request):f.drafts.discard(request)};
}
function assertPublished(f: Awaited<ReturnType<typeof fixture>>,method: string,request: Record<string,unknown>,expectedRevision: number){
  const actual=f.sql();assert.deepEqual(actual,f.published,'accepted publication bytes must remain exact');
  const disk=JSON.parse(actual!.toString('utf8'));assert.ok(clipDraftDiskSchema.safeParse(disk).success);
  assert.equal(disk.entries.length,1);const row=disk.entries[0];
  assert.deepEqual({projectId:row.projectId,timelineId:row.timelineId,clipId:row.clipId},f.key);
  assert.equal(row.revision,expectedRevision);assert.equal(fs.statSync(f.dbFile).mode&0o777,f.historyMode);
  if(method==='discard'){assert.equal(row.draft,null);assert.deepEqual(Object.keys(row).sort(),['clipId','draft','projectId','revision','timelineId']);}
  else{assert.deepEqual(row.draft.raw,request.raw);assert.deepEqual(row.draft.source,request.source);assert.equal(row.draft.baseRevision,request.baseRevision);assert.equal(Object.hasOwn(row.draft.raw,'fadeOutFrames'),false);}
  return actual;
}
const preCodes:Record<string,string>={owner:'LOCAL_DRAFT_OWNER_REQUIRED',abort:'LOCAL_DRAFT_STORAGE_UNAVAILABLE',scope:'LOCAL_DRAFT_SCOPE_MISMATCH'};
for(const method of ['put','discard'])for(const kind of ['owner','abort','scope']){
  test(`${method}: ${kind} revoked at beforePersist refuses publication and preserves old bytes`,async t=>{
    const f=await fixture(t),op=prepare(f,method),before=f.sql(),writes=f.writes,business=f.snapshot();let reached=false;
    f.setFault((point: string)=>{if(point==='beforePersist'){reached=true;f.revoke(kind);}});
    assert.throws(op.call,errorCode(preCodes[kind]));assert.ok(reached);
    assert.equal(f.writes,writes);assert.deepEqual(f.sql(),before);assert.equal(f.snapshot(),business);
  });
}
for(const kind of ['owner','abort','scope'])test(`first PUT: ${kind} revoked at beforePersist does not create a companion`,async t=>{
  const f=await fixture(t),request=f.input();f.setFault((point: string)=>{if(point==='beforePersist')f.revoke(kind);});
  assert.throws(()=>f.drafts.put(request),errorCode(preCodes[kind]));assert.equal(f.writes,0);assert.equal(fs.existsSync(f.file),false);
});
for(const method of ['put','discard'])for(const kind of ['owner','abort','scope'])test(`${method}: ${kind} revoked inside the transaction before COMMIT rolls back the complete slot`,async t=>{
  const f=await fixture(t),op=prepare(f,method),before=f.sql(),writes=f.writes,business=f.snapshot();let reached=false;
  f.setFault(point=>{if(point==='beforeCommit'){reached=true;f.revoke(kind);}});
  assert.throws(op.call,errorCode(preCodes[kind]));assert.ok(reached);assert.equal(f.writes,writes);
  assert.deepEqual(f.sql(),before);assert.equal(f.snapshot(),business);assert.equal(fs.existsSync(f.file),false);
});
for(const kind of ['owner','abort','scope'])test(`first PUT: ${kind} revoked before COMMIT leaves neither slot nor scope state`,async t=>{
  const f=await fixture(t),request=f.input(),before=f.sql();let reached=false;
  f.setFault(point=>{if(point==='beforeCommit'){reached=true;f.revoke(kind);}});
  assert.throws(()=>f.drafts.put(request),errorCode(preCodes[kind]));assert.ok(reached);assert.equal(f.writes,0);
  assert.deepEqual(f.sql(),before);assert.equal(fs.existsSync(f.file),false);
});
for(const method of ['put','discard'])for(const point of ['afterPersist','beforeConfirm','afterConfirm'])for(const kind of ['owner','abort','scope']){
  test(`${method}: ${kind} revoked at ${point} reports uncertain after exactly one publication`,async t=>{
    const f=await fixture(t),op=prepare(f,method),writes=f.writes,business=f.snapshot();let reached=false;
    f.setFault((label: string)=>{if(label===point){reached=true;f.revoke(kind);}});
    assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(reached);assert.equal(f.writes,writes+1);
    const accepted=assertPublished(f,method,op.request,2);assert.equal(f.snapshot(),business);
    if(kind!=='abort'){
      f.restore();const confirmed=op.call();assert.equal(confirmed.revision,2);assert.equal(f.writes,writes+1);
      assert.deepEqual(f.sql(),accepted);assert.deepEqual(op.call(),confirmed);assert.equal(f.writes,writes+1);
    }else{
      assert.throws(op.call,errorCode('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(f.sql(),accepted);assert.equal(f.writes,writes+1);
    }
  });
}
for(const method of ['put','discard'])for(const point of ['beforeConfirm','afterConfirm'])for(const kind of ['owner','abort','scope']){
  test(`exact ${method} retry: ${kind} revoked at ${point} cannot ACK or rewrite the accepted slot`,async t=>{
    const f=await fixture(t),op=prepare(f,method),saved=op.call(),accepted=f.sql(),metadata=fs.statSync(f.dbFile),writes=f.writes;let reached=false;
    f.setFault((label: string)=>{if(label===point){reached=true;f.revoke(kind);}});
    assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(reached);assert.equal(f.writes,writes);
    assert.deepEqual(f.sql(),accepted);assert.equal(fs.statSync(f.dbFile).mtimeMs,metadata.mtimeMs);
    if(kind!=='abort'){f.restore();assert.deepEqual(op.call(),saved);assert.deepEqual(f.sql(),accepted);assert.equal(f.writes,writes);}
  });
}
for(const exactRetry of [false,true])test(`${exactRetry?'exact PUT retry':'fresh PUT'}: final response identity failure stays uncertain`,async t=>{
  const f=await fixture(t),op=prepare(f,'put');if(exactRetry)op.call();
  const writes=f.writes;let afterSync=false,responseSource=false,identityFailed=false;
  f.setFault((point: string)=>{if(point==='afterConfirm')afterSync=true;});
  // response() performs the historical source read after the sync checkpoint.
  // Arm only there, so extra identity checks inside confirmPublished cannot
  // accidentally satisfy this distinct final-ACK regression.
  f.setSourceHook(()=>{if(afterSync)responseSource=true;});
  f.setIdentityHook((target: string)=>{if(responseSource&&target===f.dbFile){identityFailed=true;throw Error('PRIVATE final ACK identity');}});
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(identityFailed,'the final response identity read must be exercised');
  assert.equal(f.writes,writes+(exactRetry?0:1));const accepted=assertPublished(f,'put',op.request,2);
  f.restore();assert.equal(op.call().revision,2);assert.deepEqual(f.sql(),accepted);assert.equal(f.writes,writes+(exactRetry?0:1));
});
for(const exactRetry of [false,true])for(const kind of ['owner','abort'])test(`${exactRetry?'exact PUT retry':'fresh PUT'}: final response ${kind} revocation cannot ACK`,async t=>{
  const f=await fixture(t),op=prepare(f,'put');if(exactRetry)op.call();const writes=f.writes;let afterSync=false,reached=false;
  f.setFault((point: string)=>{if(point==='afterConfirm')afterSync=true;});
  f.setSourceHook(()=>{if(afterSync){reached=true;f.revoke(kind);}});
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(reached);
  assert.equal(f.writes,writes+(exactRetry?0:1));assertPublished(f,'put',op.request,2);
});
for(const method of ['put','discard'])test(`${method}: uncertain publication and failed exact retries preserve CAS, raw fields and tombstones`,async t=>{
  const f=await fixture(t),op=prepare(f,method),writes=f.writes;
  f.setFault((point: string)=>{if(point==='beforeConfirm')throw Error('PRIVATE history checkpoint');});
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));const accepted=assertPublished(f,method,op.request,2),metadata=fs.statSync(f.dbFile);
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));
  assert.equal(f.writes,writes+1);assert.deepEqual(f.sql(),accepted);assert.equal(fs.statSync(f.dbFile).mtimeMs,metadata.mtimeMs);
  f.restore();const confirmed=op.call();assert.equal(confirmed.revision,2);assert.equal(f.writes,writes+1);assert.deepEqual(f.sql(),accepted);
  if(method==='put'){
    const different={...op.request,raw:{...(op.request as unknown as {raw:typeof f.raw}).raw,name:'Not an exact retry'}};
    assert.throws(()=>f.drafts.put(different),errorCode('LOCAL_DRAFT_CONFLICT'));
    const deleted=f.drafts.discard(f.deletion(confirmed));assert.equal(deleted.revision,3);assert.equal(deleted.draft,null);
    const tombstone=f.sql();assert.throws(op.call,errorCode('LOCAL_DRAFT_CONFLICT'));assert.deepEqual(f.sql(),tombstone);
  }else{
    const recreated=f.drafts.put(f.input(confirmed));assert.equal(recreated.revision,3);const latest=f.sql();
    assert.throws(op.call,errorCode('LOCAL_DRAFT_CONFLICT'));assert.deepEqual(f.sql(),latest);
  }
});
for(const mismatch of ['identity','type','private-mode'])test(`history checkpoint rejects ${mismatch} before COMMIT without replacing saved evidence`,async t=>{
  const f=await fixture(t),op=prepare(f,'put'),before=f.sql(),writes=f.writes;let reached=false;
  f.setFault((point:string)=>{if(point==='beforePersist'){reached=true;if(mismatch==='private-mode')fs.chmodSync(f.root,0o755);else f.setIdentityVariant(mismatch);}});
  assert.throws(op.call,errorCode(mismatch==='identity'?'LOCAL_DRAFT_SCOPE_MISMATCH':'LOCAL_DRAFT_STORAGE_UNAVAILABLE'));
  assert.ok(reached,'the real history identity checkpoint must be exercised');assert.equal(f.writes,writes);assert.deepEqual(f.sql(),before);
  assert.equal(fs.existsSync(f.file),false,'history confirmation cannot recreate the retired file');
  f.restore();assert.equal(op.call().revision,2);assert.equal(f.writes,writes+1);assertPublished(f,'put',op.request,2);
});
for(const method of ['put','discard'])for(const kind of ['owner','abort'])test(`${method}: ${kind} revoked by the final prepublication identity read refuses the write`,async t=>{
  const f=await fixture(t),op=prepare(f,method),before=f.sql(),writes=f.writes;let armed=false,reached=false;
  f.setFault((point: string)=>{if(point==='beforePersist')armed=true;});
  f.setIdentityHook((target: string)=>{if(armed&&target===f.dbFile){armed=false;reached=true;f.revoke(kind);}});
  assert.throws(op.call,errorCode(preCodes[kind]));assert.ok(reached,'the identity read immediately before SQL commit must run');
  assert.equal(f.writes,writes);assert.deepEqual(f.sql(),before);
});
for(const exactRetry of [false,true])test(`${exactRetry?'exact PUT retry':'fresh PUT'}: response source lookup failure after commit confirmation stays uncertain`,async t=>{
  const f=await fixture(t),op=prepare(f,'put');if(exactRetry)op.call();const writes=f.writes;let afterSync=false,reached=false;
  f.setFault((point: string)=>{if(point==='afterConfirm')afterSync=true;});
  f.setSourceHook(()=>{if(afterSync){reached=true;throw Error('PRIVATE response source lookup');}});
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(reached);
  assert.equal(f.writes,writes+(exactRetry?0:1));const accepted=assertPublished(f,'put',op.request,2);
  f.restore();assert.equal(op.call().revision,2);assert.deepEqual(f.sql(),accepted);assert.equal(f.writes,writes+(exactRetry?0:1));
});
