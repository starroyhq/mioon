import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,unlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {AppError,hasRequestNotAppliedProof,isTimelineMutationResponse} from '@mioon/contracts';
import {timelineLoudnessCandidateDigest} from '../packages/contracts/src/timeline-loudness-apply.ts';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createServices,hash} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createTimelineServices} from '../packages/business/src/timeline.ts';
import {createTimelineMixLoudnessServices} from '../packages/business/src/timeline-mix-loudness.ts';
import {createTimelineLoudnessApplyServices} from '../packages/business/src/timeline-loudness-apply.ts';
import {readTimelinePreflightSnapshot,readTimelineSourceGraph} from '../packages/business/src/timeline-sources.ts';
import {validateTimeline} from '../packages/business/src/timeline-inputs.ts';
import {planTimelineMixLoudnessDecode} from '../packages/business/src/timeline-mix-loudness-decoder.ts';
import {validateManagedSource,verifiedManagedHash} from '../packages/business/src/managed-media.ts';
const operation='timeline.loudness.apply',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=value=>structuredClone(value);
function readSaved(store,projectId){
  const {db}=store,outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
  try{const {timeline}=readTimelinePreflightSnapshot(store,projectId);if(!timeline)return null;
    const assets=readTimelineSourceGraph(db,projectId,timeline);validateTimeline(timeline,assets,{structureOnly:true});return {timeline,assets:[...assets.values()]};
  }finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}
}
function rows(db){return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
  .map(({name})=>[name,db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]));}
async function syntheticDecode(timeline,assets,options){
  const plan=planTimelineMixLoudnessDecode(timeline,assets),tracks=new Map(timeline.tracks.map(track=>[track.id,track]));options.beforeEffect();
  for(let begin=0;begin<plan.sampleFrames;begin+=8192){const length=Math.min(8192,plan.sampleFrames-begin),chunk=Buffer.alloc(length*8);
    for(let i=0;i<length;i++){const frame=(begin+i)/1600,gain=timeline.clips.reduce((sum,clip)=>
      sum+(!tracks.get(clip.trackId).muted&&frame>=clip.startFrame&&frame<clip.startFrame+clip.durationFrames?clip.gain:0),0);
      const sample=.1*gain*Math.sin(2*Math.PI*997*(begin+i)/48000);chunk.writeFloatLE(sample,i*8);chunk.writeFloatLE(-sample,i*8+4);}
    options.onPcm(chunk);
  }return {sampleRate:48000,channels:2,...plan};
}
async function fixture(t,{group=false}={}){
  const root=await mkdtemp(path.join(tmpdir(),'mioon-atomic-gain-'));let store=openStore(root),services=createServices(store,new Map()),mix;
  const f={root,decodes:0,owner:true,onNow:null,get store(){return store;},get services(){return services;}};
  const project=await services.call('project.create',{name:'Atomic gain'}),assetId=randomUUID(),bytes=Buffer.alloc(96*1024,7);
  const asset={id:assetId,projectId:project.id,name:'Source.wav',mimeType:'audio/wav',relativePath:`media/${assetId}.wav`,sha256:sha(bytes),sizeBytes:bytes.length,
    duration:10,hasAudio:true,hasVideo:false,width:0,height:0,url:`/media/${assetId}`,createdAt:new Date().toISOString()};
  await writeFile(path.join(root,asset.relativePath),bytes,{mode:0o600});store.put('assets',asset);
  let timeline=await services.call('timeline.get',{projectId:project.id});
  const call=async(op,fields)=>timeline=await services.call(op,{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...fields});
  const audio=timeline.tracks.find(track=>track.kind==='audio').id;
  await call('timeline.clip.add',{trackId:audio,assetId,startFrame:0,durationFrames:group?30:60,gain:.75,fadeInFrames:0});
  if(group){
    await call('timeline.clip.add',{trackId:audio,assetId,startFrame:30,durationFrames:30,gain:.4});
    await call('timeline.track.add',{kind:'audio',name:'Zero'});const zero=timeline.tracks.at(-1).id;
    await call('timeline.clip.add',{trackId:zero,assetId,startFrame:0,durationFrames:60,gain:0});
    await call('timeline.track.add',{kind:'audio',name:'Muted'});const muted=timeline.tracks.at(-1).id;
    await call('timeline.clip.add',{trackId:muted,assetId,startFrame:0,durationFrames:60,gain:1.25});
    await call('timeline.track.update',{trackId:muted,patch:{muted:true}});
  }
  function connect(){
    const required=(table,id)=>{const value=store.get(table,id);if(!value)throw new AppError('NOT_FOUND','Missing',404);return value;};
    const check=(value,revision)=>{if(value.revision!==revision)throw new AppError('REVISION_CONFLICT','Changed',409);};
    const assertAvailable=()=>{if(getWorkspaceRestoreContext(store))throw new AppError('RESTORE_OPERATION_UNAVAILABLE','Restored',409);
      if(!f.owner||!ownsStoreLock(store))throw new AppError('TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED','Owner required',403);};
    const shared=createTimelineServices(store,{required,check,hash,now:()=>{f.onNow?.();return new Date().toISOString();}});
    const runtime={assertOrdinaryWorkspace:assertAvailable,ownsLock:()=>f.owner&&ownsStoreLock(store),readSavedTimeline:projectId=>readSaved(store,projectId),
      validateSource:validateManagedSource,hash:verifiedManagedHash,decode:async(...args)=>{f.decodes++;return syntheticDecode(...args);},
      terminate:async()=>[],waitForClose:async()=>[],boundedShutdown:async work=>{await work;}};
    mix=createTimelineMixLoudnessServices(store,{runtime});
    f.transactions=shared.createLoudnessApplyTransactions(assertAvailable);f.shared=shared;f.runtime=runtime;
    f.apply=createTimelineLoudnessApplyServices({measurement:mix,transactions:f.transactions,assertAvailable}).handlers[operation];
    f.review=async()=>{const current=store.get('timelines',timeline.id),input={projectId:project.id,expectedRevision:current.revision,mixProfile:'timeline-float-mix-v1',
      measurementProfile:'bs1770-5-48k-stereo-fir4x-v1',target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
      const report=await mix.handlers['timeline.loudness.prepare'](input);return {report,input:{...input,requestId:randomUUID(),snapshotSha256:report.identity.snapshotSha256,
        candidateDigest:await timelineLoudnessCandidateDigest(report)}};};
  }
  connect();f.project=project;f.asset=asset;f.timeline=timeline;
  f.restart=async()=>{await mix.drain();await services.drain();store.close();store=openStore(root);services=createServices(store,new Map());connect();};
  t.after(async()=>{await mix.drain().catch(()=>{});await services.drain().catch(()=>{});store.close();await rm(root,{recursive:true,force:true});});return f;
}
test('real shared SQLite transaction changes exact gains once; zero/muted, unrelated fields and old ACK bytes survive undo/redo',async t=>{
  const f=await fixture(t,{group:true}),{input,report}=await f.review(),before=clone(f.store.get('timelines',f.timeline.id)),historyBefore=f.shared.history(f.project.id),
    oldReceipts=f.store.db.prepare('SELECT * FROM timeline_requests ORDER BY rowid').all();
  const response=await f.apply(input),after=f.store.get('timelines',f.timeline.id),gains=new Map(report.candidate.gains.map(gain=>[gain.clipId,gain.afterGain]));
  assert.equal(gains.size,2);assert.equal(after.revision,before.revision+1);assert.equal(isTimelineMutationResponse(operation,input,response),true);
  const expected=clone(before);for(const clip of expected.clips)if(gains.has(clip.id))clip.gain=gains.get(clip.id);expected.revision=after.revision;expected.updatedAt=after.updatedAt;
  assert.deepEqual(after,expected);assert.deepEqual(f.store.db.prepare('SELECT * FROM timeline_requests ORDER BY rowid').all().slice(0,-1),oldReceipts);
  const history=f.shared.history(f.project.id);assert.equal(history.length,historyBefore.length+1);assert.equal(history.undoEntry.operation,operation);
  const undone=await f.services.call('timeline.undo',{projectId:f.project.id,expectedRevision:after.revision,requestId:randomUUID()});
  assert.deepEqual(undone.clips,before.clips);assert.deepEqual(undone.tracks,before.tracks);
  const redone=await f.services.call('timeline.redo',{projectId:f.project.id,expectedRevision:undone.revision,requestId:randomUUID()});assert.deepEqual(redone.clips,after.clips);
});
test('same key replays exact stored ACK after undo/restart/missing media and decoder; wrong content and cross-operation conflict',async t=>{
  const f=await fixture(t),{input}=await f.review(),response=await f.apply(input),raw=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
  await f.services.call('timeline.undo',{projectId:f.project.id,expectedRevision:response.timeline.revision,requestId:randomUUID()});
  await unlink(path.join(f.root,f.asset.relativePath));await f.restart();f.runtime.decode=async()=>{throw new Error('Decoder unavailable');};
  const before=rows(f.store.db),count=f.decodes;assert.equal(JSON.stringify(await f.apply(input)),raw);assert.equal(f.decodes,count);assert.deepEqual(rows(f.store.db),before);
  for(const patch of [{target:{...input.target,integratedLufs:-29}},{projectId:randomUUID()},{candidateDigest:'timeline-loudness-candidate-v1:'+ 'f'.repeat(64)}])
    await assert.rejects(f.apply({...input,...patch}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.services.call('timeline.clip.update',{projectId:input.projectId,expectedRevision:input.expectedRevision,requestId:input.requestId,
    clipId:f.timeline.clips[0].id,patch:{gain:.5}}),{code:'IDEMPOTENCY_CONFLICT'});assert.deepEqual(rows(f.store.db),before);
});
test('receipt replay keeps historical source/lineage DB ownership without requiring a current clip',async t=>{
  const f=await fixture(t),{input}=await f.review(),response=await f.apply(input);
  await f.services.call('timeline.clip.remove',{projectId:f.project.id,expectedRevision:response.timeline.revision,requestId:randomUUID(),clipId:f.timeline.clips[0].id});
  assert.deepEqual(await f.apply(input),response);
  const foreign=await f.services.call('project.create',{name:'Foreign'}),changed={...f.asset,projectId:foreign.id};
  f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(foreign.id,JSON.stringify(changed),f.asset.id);
  await assert.rejects(f.apply(input),{code:'TIMELINE_SOURCE_UNAVAILABLE'});
});
test('revision maximum and ordinary CAS conflicts reject before decoder with exact owner-bound not-applied proof',async t=>{
  const f=await fixture(t),{input}=await f.review();let timeline=f.store.get('timelines',f.timeline.id);timeline.revision++;f.store.put('timelines',timeline);
  const before=rows(f.store.db),count=f.decodes;await assert.rejects(f.apply(input),error=>error.code==='REVISION_CONFLICT'&&hasRequestNotAppliedProof(error,input,{operation}));
  assert.equal(f.decodes,count);assert.deepEqual(rows(f.store.db),before);
  timeline={...timeline,revision:Number.MAX_SAFE_INTEGER};f.store.put('timelines',timeline);const maximum={...input,expectedRevision:timeline.revision,requestId:randomUUID()};
  await assert.rejects(f.apply(maximum),error=>error.code==='TIMELINE_REVISION_LIMIT'&&hasRequestNotAppliedProof(error,maximum,{operation}));assert.equal(f.decodes,count);
});
test('candidate stale proof is specific and revoked ownership never receives a proof',async t=>{
  const f=await fixture(t),{input}=await f.review(),bad={...input,candidateDigest:'timeline-loudness-candidate-v1:'+ 'f'.repeat(64)},before=rows(f.store.db);
  await assert.rejects(f.apply(bad),error=>error.code==='TIMELINE_LOUDNESS_APPLY_STALE'&&hasRequestNotAppliedProof(error,bad,{operation}));assert.deepEqual(rows(f.store.db),before);
  const original=f.transactions.rejectBeforeApply;f.transactions.rejectBeforeApply=(input,error)=>{f.owner=false;return original(input,error);};
  await assert.rejects(f.apply({...bad,requestId:randomUUID()}),error=>error.code==='TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED'&&!error.details?.mutationOutcome);
  assert.deepEqual(rows(f.store.db),before);
});
test('the final fence rejects a revision change after validation before writing any gain/history/receipt',async t=>{
  const f=await fixture(t),{input}=await f.review(),before=rows(f.store.db);let changed=false;
  f.onNow=()=>{if(changed)return;changed=true;const timeline=f.store.get('timelines',f.timeline.id);timeline.revision++;f.store.put('timelines',timeline);};
  await assert.rejects(f.apply(input),{code:'TIMELINE_MIX_LOUDNESS_REVISION_CONFLICT'});assert.equal(changed,true);assert.deepEqual(rows(f.store.db),before);
});
const writeFaults=[['timeline',/^INSERT INTO timelines\(/u],['delete redo',/^DELETE FROM timeline_history WHERE/u],
  ['history',/^INSERT INTO timeline_history\(/u],['cursor',/^INSERT INTO timeline_history_cursors\(/u],['receipt',/^INSERT INTO timeline_requests\(/u]];
for(const [name,pattern]of writeFaults)for(const moment of ['before','after'])test(`atomic rollback at ${moment} ${name} preserves all raw rows and never claims not_applied`,async t=>{
  const f=await fixture(t,{group:true}),{input}=await f.review(),db=f.store.db,before=rows(db),prepare=db.prepare.bind(db);let fired=false;
  db.prepare=function(sql){const statement=prepare(sql);if(!pattern.test(sql))return statement;return new Proxy(statement,{get(target,key){
    const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
    if(key!=='run')return value.bind(target);return (...args)=>{if(!fired&&moment==='before'){fired=true;throw Object.assign(new Error('Injected write'),{code:'INJECTED_WRITE'});}
      const result=value.apply(target,args);if(!fired&&moment==='after'){fired=true;throw Object.assign(new Error('Injected write'),{code:'INJECTED_WRITE'});}return result;};}});};
  try{await assert.rejects(f.apply(input),error=>error.code==='INJECTED_WRITE'&&!error.details?.mutationOutcome);assert.equal(fired,true);}finally{db.prepare=prepare;}
  assert.equal(db.isTransaction,false);assert.deepEqual(rows(db),before);
});
test('no post-success fence can reclassify a committed application when owner closes immediately afterwards',async t=>{
  const f=await fixture(t),{input}=await f.review(),accept=f.transactions.accept;
  f.transactions.accept=(input,admission)=>{const value=accept(input,admission);f.owner=false;return value;};
  const response=await f.apply(input);assert.equal(response.timeline.revision,input.expectedRevision+1);
  assert.ok(f.store.db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(input.requestId));
});

function pcmWav(){
  const frames=3*48000,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);
  bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let i=0;i<frames;i++){const sample=Math.round(.15*32767*Math.sin(2*Math.PI*997*i/48000));bytes.writeInt16LE(sample,44+i*4);bytes.writeInt16LE(-sample,46+i*4);}return bytes;
}
test('actual createServices media + durable lost-after-commit recovers original ACK after undo and restart without a second apply',async t=>{
  const f=await fixture(t),bytes=pcmWav(),asset={...f.asset,sizeBytes:bytes.length,sha256:sha(bytes),duration:3};
  await writeFile(path.join(f.root,asset.relativePath),bytes,{mode:0o600});f.store.put('assets',asset);
  const current=f.store.get('timelines',f.timeline.id),prepareInput={projectId:f.project.id,expectedRevision:current.revision,mixProfile:'timeline-float-mix-v1',
    measurementProfile:'bs1770-5-48k-stereo-fir4x-v1',target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
  const report=await f.services.call('timeline.loudness.prepare',prepareInput);assert.equal(report.applyAllowed,false);assert.equal(report.candidate.meetsTruePeak,true);
  const input={...prepareInput,requestId:randomUUID(),snapshotSha256:report.identity.snapshotSha256,candidateDigest:await timelineLoudnessCandidateDigest(report)};
  let tasks=createEditTasks({store:f.store,services:f.services,fault:point=>{if(point==='afterBusinessCommit')throw Error('Lost result after commit');}});
  const saved=tasks.prepare({projectId:f.project.id,operation,input,origin:'new'});
  await assert.rejects(tasks.execute({projectId:f.project.id,taskId:saved.task.id,digest:saved.task.digest,instanceId:saved.instanceId}),{code:'EDIT_TASK_STORAGE_UNAVAILABLE'});
  const raw=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,response=JSON.parse(raw);
  assert.equal(isTimelineMutationResponse(operation,input,response),true);assert.equal(f.store.db.prepare('SELECT status FROM edit_tasks WHERE id=?').get(saved.task.id).status,'dispatching');
  await f.services.call('timeline.undo',{projectId:f.project.id,expectedRevision:response.timeline.revision,requestId:randomUUID()});
  await tasks.drain();await unlink(path.join(f.root,asset.relativePath));await f.restart();
  let dispatched=0;tasks=createEditTasks({store:f.store,services:{call(){dispatched++;throw Error('A retained receipt must not redispatch');}}});
  assert.deepEqual(tasks.reconcileStartup(),{processed:1,unavailable:0});const recovered=tasks.get({projectId:f.project.id,taskId:saved.task.id});
  assert.equal(recovered.task.status,'applied');assert.equal(recovered.task.requestId,input.requestId);
  const replayed=await tasks.execute({projectId:f.project.id,taskId:recovered.task.id,digest:recovered.task.digest,instanceId:recovered.instanceId});
  assert.equal(JSON.stringify(replayed.result),raw);assert.equal(dispatched,0);
  assert.equal(JSON.stringify(await f.services.call(operation,input)),raw);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM timeline_history WHERE operation=?').get(operation).n,1);
  await tasks.drain();
});

for(const moment of ['before','after'])test(`uncertain COMMIT ${moment} never carries not-applied proof and recovery uses the existing key`,async t=>{
  const f=await fixture(t),{input}=await f.review(),db=f.store.db,before=rows(db),exec=db.exec.bind(db);let fired=false;
  db.exec=function(sql){if(sql==='COMMIT'&&!fired&&db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(input.requestId)){
    fired=true;if(moment==='after')exec(sql);throw Object.assign(new Error('Uncertain COMMIT'),{code:'SQLITE_IOERR'});}return exec(sql);};
  try{await assert.rejects(f.apply(input),error=>error.code==='SQLITE_IOERR'&&!error.details?.mutationOutcome);assert.equal(fired,true);}finally{db.exec=exec;}
  if(moment==='before')assert.deepEqual(rows(db),before);
  else{const raw=db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,count=f.decodes;
    assert.equal(JSON.stringify(await f.apply(input)),raw);assert.equal(f.decodes,count);}
});
test('a rollback replacement error cannot borrow the original candidate/CAS rejection proof',async t=>{
  const f=await fixture(t),{input}=await f.review(),db=f.store.db,timeline=f.store.get('timelines',f.timeline.id);timeline.revision++;f.store.put('timelines',timeline);
  const before=rows(db),exec=db.exec.bind(db),replacement=new AppError('REVISION_CONFLICT','Rollback acknowledgement missing',409);let fired=false;
  db.exec=function(sql){if(sql==='ROLLBACK'&&!fired){fired=true;exec(sql);throw replacement;}return exec(sql);};
  try{await assert.rejects(f.apply(input),error=>error===replacement&&!error.details?.mutationOutcome);assert.equal(fired,true);}finally{db.exec=exec;}
  assert.equal(db.isTransaction,false);assert.deepEqual(rows(db),before);
});
