import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.mjs';
import {createLocalDrafts,LOCAL_DRAFT_FILENAME} from '../packages/business/src/local-drafts.ts';
import {clipDraftDiskSchema} from '@mioon/contracts/local-drafts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';

// These synchronous fault callbacks model explicit injected boundaries. They do
// not assert that ordinary JavaScript shutdown can interrupt synchronous calls.
const errorCode=expected=>error=>error?.code===expected&&!error.message.includes('PRIVATE');
const bytes=file=>fs.existsSync(file)?fs.readFileSync(file):null;
async function fixture(t){
  const root=fs.mkdtempSync(path.join(tmpdir(),'mioon-draft-publication-'));
  const store=openStore(root),services=createServices(store,new Map()),controller=new AbortController();
  const project=await services.call('project.create',{name:'Publication fence fixture'}),assetId=randomUUID();
  const asset=store.put('assets',{id:assetId,projectId:project.id,name:'Synthetic',mimeType:'image/png',width:2,height:2,hasVideo:true,hasAudio:false,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${assetId}.png`,createdAt:new Date().toISOString()});
  let timeline=await services.call('timeline.get',{projectId:project.id});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:90});
  const clip=timeline.clips[0],key={projectId:project.id,timelineId:timeline.id,clipId:clip.id};
  const raw={name:'Raw draft 文本',trackId:clip.trackId,startFrame:'',durationFrames:'9e',sourceInFrame:'0',rect:{x:'0',y:'',width:'-1',height:720},gain:'0.',fadeInFrames:''};
  const file=path.join(root,LOCAL_DRAFT_FILENAME),dbFile=path.join(root,'workbench.sqlite');
  let owned=true,foreignScope=false,fault=()=>{},sourceHook=()=>{},identityHook=()=>{},writes=0,published=null;
  const storage={readPrivateFile,validatePrivateDirectory,
    validateManagedFile(target,options){const info=validateManagedFile(target,options);identityHook(target);return foreignScope&&target===dbFile?{...info,ino:info.ino+1}:info;},
    writePrivateFileAtomic(target,contents,options){const result=writePrivateFileAtomic(target,contents,options);writes++;published=Buffer.from(contents);return result;},
  };
  const guards={ownsLock:()=>owned&&ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),
    readTimeline:id=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read(),
    readClipAsset:(id,value)=>{sourceHook();return createTimelineRecoveryBoundary(store.db,{projectId:id}).clipSource(value);},
  };
  const drafts=createLocalDrafts({root,storage,guards,signal:controller.signal,fault:point=>fault(point)});
  const snapshot=()=>JSON.stringify({schema:store.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(),tables:store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]),changes:store.db.prepare('SELECT total_changes() n').get().n});
  const initialBusiness=snapshot();
  t.after(()=>{try{assert.equal(snapshot(),initialBusiness,'draft fences must not change business records, schema, history, CAS or revisions');}finally{store.close();fs.rmSync(root,{recursive:true,force:true});}});
  const input=(response=drafts.get(key),patch={})=>({workspaceScope:response.workspaceScope,instanceId:response.instanceId,...key,expectedRevision:response.revision,baseRevision:timeline.revision,source:{assetId:asset.id,assetSha256:asset.sha256},raw,...patch});
  const deletion=response=>({workspaceScope:response.workspaceScope,instanceId:response.instanceId,...key,expectedRevision:response.revision});
  return {root,file,dbFile,key,raw,drafts,controller,input,deletion,snapshot,
    get writes(){return writes;},get published(){return published;},
    setFault(fn){fault=fn;},setSourceHook(fn){sourceHook=fn;},setIdentityHook(fn){identityHook=fn;},
    revoke(kind){if(kind==='owner')owned=false;else if(kind==='abort')controller.abort();else foreignScope=true;},
    restore(){owned=true;foreignScope=false;fault=()=>{};sourceHook=()=>{};identityHook=()=>{};},
  };
}
function prepare(f,method){
  const saved=f.drafts.put(f.input());
  const request=method==='put'?f.input(saved,{raw:{...f.raw,name:'Edited but unsubmitted',startFrame:'007'}}):f.deletion(saved);
  return {saved,request,call:()=>method==='put'?f.drafts.put(request):f.drafts.discard(request)};
}
function assertPublished(f,method,request,expectedRevision){
  const actual=bytes(f.file);assert.deepEqual(actual,f.published,'accepted publication bytes must remain exact');
  const disk=JSON.parse(actual.toString('utf8'));assert.ok(clipDraftDiskSchema.safeParse(disk).success);
  assert.equal(disk.entries.length,1);const row=disk.entries[0];
  assert.deepEqual({projectId:row.projectId,timelineId:row.timelineId,clipId:row.clipId},f.key);
  assert.equal(row.revision,expectedRevision);assert.equal(fs.statSync(f.file).mode&0o777,0o600);
  if(method==='discard'){assert.equal(row.draft,null);assert.deepEqual(Object.keys(row).sort(),['clipId','draft','projectId','revision','timelineId']);}
  else{assert.deepEqual(row.draft.raw,request.raw);assert.deepEqual(row.draft.source,request.source);assert.equal(row.draft.baseRevision,request.baseRevision);assert.equal(Object.hasOwn(row.draft.raw,'fadeOutFrames'),false);}
  return actual;
}
const preCodes={owner:'LOCAL_DRAFT_OWNER_REQUIRED',abort:'LOCAL_DRAFT_STORAGE_UNAVAILABLE',scope:'LOCAL_DRAFT_SCOPE_MISMATCH'};
for(const method of ['put','discard'])for(const kind of ['owner','abort','scope']){
  test(`${method}: ${kind} revoked at beforePersist refuses publication and preserves old bytes`,async t=>{
    const f=await fixture(t),op=prepare(f,method),before=bytes(f.file),writes=f.writes,business=f.snapshot();let reached=false;
    f.setFault(point=>{if(point==='beforePersist'){reached=true;f.revoke(kind);}});
    assert.throws(op.call,errorCode(preCodes[kind]));assert.ok(reached);
    assert.equal(f.writes,writes);assert.deepEqual(bytes(f.file),before);assert.equal(f.snapshot(),business);
  });
}
for(const kind of ['owner','abort','scope'])test(`first PUT: ${kind} revoked at beforePersist does not create a companion`,async t=>{
  const f=await fixture(t),request=f.input();f.setFault(point=>{if(point==='beforePersist')f.revoke(kind);});
  assert.throws(()=>f.drafts.put(request),errorCode(preCodes[kind]));assert.equal(f.writes,0);assert.equal(fs.existsSync(f.file),false);
});
for(const method of ['put','discard'])for(const point of ['afterPersist','beforeDirectorySync','afterDirectorySync'])for(const kind of ['owner','abort','scope']){
  test(`${method}: ${kind} revoked at ${point} reports uncertain after exactly one publication`,async t=>{
    const f=await fixture(t),op=prepare(f,method),writes=f.writes,business=f.snapshot();let reached=false;
    f.setFault(label=>{if(label===point){reached=true;f.revoke(kind);}});
    assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(reached);assert.equal(f.writes,writes+1);
    const accepted=assertPublished(f,method,op.request,2);assert.equal(f.snapshot(),business);
    if(kind!=='abort'){
      f.restore();const confirmed=op.call();assert.equal(confirmed.revision,2);assert.equal(f.writes,writes+1);
      assert.deepEqual(bytes(f.file),accepted);assert.deepEqual(op.call(),confirmed);assert.equal(f.writes,writes+1);
    }else{
      assert.throws(op.call,errorCode('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(bytes(f.file),accepted);assert.equal(f.writes,writes+1);
    }
  });
}
for(const method of ['put','discard'])for(const point of ['beforeDirectorySync','afterDirectorySync'])for(const kind of ['owner','abort','scope']){
  test(`exact ${method} retry: ${kind} revoked at ${point} cannot ACK or rewrite the accepted slot`,async t=>{
    const f=await fixture(t),op=prepare(f,method),saved=op.call(),accepted=bytes(f.file),metadata=fs.statSync(f.file),writes=f.writes;let reached=false;
    f.setFault(label=>{if(label===point){reached=true;f.revoke(kind);}});
    assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(reached);assert.equal(f.writes,writes);
    assert.deepEqual(bytes(f.file),accepted);assert.equal(fs.statSync(f.file).mtimeMs,metadata.mtimeMs);
    if(kind!=='abort'){f.restore();assert.deepEqual(op.call(),saved);assert.deepEqual(bytes(f.file),accepted);assert.equal(f.writes,writes);}
  });
}
for(const exactRetry of [false,true])test(`${exactRetry?'exact PUT retry':'fresh PUT'}: final response identity failure stays uncertain`,async t=>{
  const f=await fixture(t),op=prepare(f,'put');if(exactRetry)op.call();
  const writes=f.writes;let afterSync=false,responseSource=false,identityFailed=false;
  f.setFault(point=>{if(point==='afterDirectorySync')afterSync=true;});
  // response() performs the historical source read after the sync checkpoint.
  // Arm only there, so extra identity checks inside confirmPublished cannot
  // accidentally satisfy this distinct final-ACK regression.
  f.setSourceHook(()=>{if(afterSync)responseSource=true;});
  f.setIdentityHook(target=>{if(responseSource&&target===f.dbFile){identityFailed=true;throw Error('PRIVATE final ACK identity');}});
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(identityFailed,'the final response identity read must be exercised');
  assert.equal(f.writes,writes+(exactRetry?0:1));const accepted=assertPublished(f,'put',op.request,2);
  f.restore();assert.equal(op.call().revision,2);assert.deepEqual(bytes(f.file),accepted);assert.equal(f.writes,writes+(exactRetry?0:1));
});
for(const exactRetry of [false,true])for(const kind of ['owner','abort'])test(`${exactRetry?'exact PUT retry':'fresh PUT'}: final response ${kind} revocation cannot ACK`,async t=>{
  const f=await fixture(t),op=prepare(f,'put');if(exactRetry)op.call();const writes=f.writes;let afterSync=false,reached=false;
  f.setFault(point=>{if(point==='afterDirectorySync')afterSync=true;});
  f.setSourceHook(()=>{if(afterSync){reached=true;f.revoke(kind);}});
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(reached);
  assert.equal(f.writes,writes+(exactRetry?0:1));assertPublished(f,'put',op.request,2);
});
for(const method of ['put','discard'])test(`${method}: uncertain publication and failed exact retries preserve CAS, raw fields and tombstones`,async t=>{
  const f=await fixture(t),op=prepare(f,method),writes=f.writes;
  f.setFault(point=>{if(point==='beforeDirectorySync')throw Error('PRIVATE directory checkpoint');});
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));const accepted=assertPublished(f,method,op.request,2),metadata=fs.statSync(f.file);
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));
  assert.equal(f.writes,writes+1);assert.deepEqual(bytes(f.file),accepted);assert.equal(fs.statSync(f.file).mtimeMs,metadata.mtimeMs);
  f.restore();const confirmed=op.call();assert.equal(confirmed.revision,2);assert.equal(f.writes,writes+1);assert.deepEqual(bytes(f.file),accepted);
  if(method==='put'){
    const different={...op.request,raw:{...op.request.raw,name:'Not an exact retry'}};
    assert.throws(()=>f.drafts.put(different),errorCode('LOCAL_DRAFT_CONFLICT'));
    const deleted=f.drafts.discard(f.deletion(confirmed));assert.equal(deleted.revision,3);assert.equal(deleted.draft,null);
    const tombstone=bytes(f.file);assert.throws(op.call,errorCode('LOCAL_DRAFT_CONFLICT'));assert.deepEqual(bytes(f.file),tombstone);
  }else{
    const recreated=f.drafts.put(f.input(confirmed));assert.equal(recreated.revision,3);const latest=bytes(f.file);
    assert.throws(op.call,errorCode('LOCAL_DRAFT_CONFLICT'));assert.deepEqual(bytes(f.file),latest);
  }
});
for(const mismatch of ['identity','type','private-mode'])test(`directory checkpoint rejects a real opened descriptor with ${mismatch} mismatch before fsync`,async t=>{
  const f=await fixture(t),op=prepare(f,'put'),other=path.join(f.root,'other-directory'),regular=path.join(f.root,'regular-file');
  fs.mkdirSync(other,{mode:0o700});fs.writeFileSync(regular,'synthetic descriptor',{mode:0o600});
  const originalOpen=fs.openSync,originalSync=fs.fsyncSync;let armed=false,openedFd,openedInfo,opened=false,synced=false;
  f.setFault(point=>{if(point==='beforeDirectorySync')armed=true;});
  // Only this synthetic checkpoint's open is redirected. Real descriptors and
  // fstat metadata are used; validation and atomic storage helpers remain real.
  fs.openSync=function(target,...args){
    if(armed&&target===f.root){armed=false;opened=true;openedFd=originalOpen(mismatch==='identity'?other:mismatch==='type'?regular:target,...args);
      if(mismatch==='private-mode')fs.chmodSync(f.root,0o755);openedInfo=fs.fstatSync(openedFd);return openedFd;}
    return originalOpen(target,...args);
  };
  fs.fsyncSync=function(fd){if(fd===openedFd){synced=true;if(mismatch==='private-mode')fs.chmodSync(f.root,0o700);}return originalSync(fd);};
  syncBuiltinESMExports();
  let failure;
  try{op.call();}catch(error){failure=error;}
  finally{fs.openSync=originalOpen;fs.fsyncSync=originalSync;syncBuiltinESMExports();fs.chmodSync(f.root,0o700);}
  assert.ok(opened,'the actual directory checkpoint open must be exercised');assert.ok(openedInfo);
  assert.equal(failure?.code,'LOCAL_DRAFT_SAVE_UNCERTAIN');assert.equal(synced,false,'an unverified descriptor must not be fsynced');
  const accepted=assertPublished(f,'put',op.request,2);f.restore();assert.equal(op.call().revision,2);assert.deepEqual(bytes(f.file),accepted);
});
for(const method of ['put','discard'])for(const kind of ['owner','abort'])test(`${method}: ${kind} revoked by the final prepublication identity read refuses the write`,async t=>{
  const f=await fixture(t),op=prepare(f,method),before=bytes(f.file),writes=f.writes;let armed=false,reached=false;
  f.setFault(point=>{if(point==='beforePersist')armed=true;});
  f.setIdentityHook(target=>{if(armed&&target===f.dbFile){armed=false;reached=true;f.revoke(kind);}});
  assert.throws(op.call,errorCode(preCodes[kind]));assert.ok(reached,'the identity read immediately before atomic publication must run');
  assert.equal(f.writes,writes);assert.deepEqual(bytes(f.file),before);
});
for(const exactRetry of [false,true])test(`${exactRetry?'exact PUT retry':'fresh PUT'}: response source lookup failure after directory sync stays uncertain`,async t=>{
  const f=await fixture(t),op=prepare(f,'put');if(exactRetry)op.call();const writes=f.writes;let afterSync=false,reached=false;
  f.setFault(point=>{if(point==='afterDirectorySync')afterSync=true;});
  f.setSourceHook(()=>{if(afterSync){reached=true;throw Error('PRIVATE response source lookup');}});
  assert.throws(op.call,errorCode('LOCAL_DRAFT_SAVE_UNCERTAIN'));assert.ok(reached);
  assert.equal(f.writes,writes+(exactRetry?0:1));const accepted=assertPublished(f,'put',op.request,2);
  f.restore();assert.equal(op.call().revision,2);assert.deepEqual(bytes(f.file),accepted);assert.equal(f.writes,writes+(exactRetry?0:1));
});
