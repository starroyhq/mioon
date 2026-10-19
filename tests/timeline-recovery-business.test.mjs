import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {AppError,TIMELINE_MUTATION_OPERATIONS,hasRequestNotAppliedProof,isTimelineMutationResponse} from '@mioon/contracts';
import {timelineLoudnessCandidateDigest} from '@mioon/contracts/timeline-loudness-apply';
import {openStore,ownsStoreLock} from '../packages/business/src/db.ts';
import {createServices,hash} from '../packages/business/src/services.ts';
import {createTimelineServices} from '../packages/business/src/timeline.ts';
import {createTimelineLoudnessApplyServices} from '../packages/business/src/timeline-loudness-apply.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {readyMixLoudness,mixLoudnessInput} from './fixtures/timeline-mix-loudness-fixtures.mjs';

const at='2026-10-10T00:00:00.000Z',clone=value=>JSON.parse(JSON.stringify(value));
const tables=['projects','timelines','assets','shots','jobs','versions','exports','timeline_history','timeline_history_cursors','timeline_requests','timeline_format_requests'];
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-timeline-recovery-'));
 let store=openStore(root),services=createServices(store,new Map()),apply;
 const f={root,get store(){return store;},call:(op,input)=>op==='timeline.loudness.apply'?apply(input):services.call(op,input),
  liveCall:(op,input)=>services.call(op,input),
  restart(){store.close();store=openStore(root);services=createServices(store,new Map());connectApply();},
  capture(){return Object.fromEntries(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));},
  asset(patch={}){const id=randomUUID();return store.put('assets',{id,projectId:f.projectId,name:'Recovery fixture',mimeType:'video/mp4',
   duration:10,width:720,height:1280,hasAudio:true,hasVideo:true,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`,createdAt:at,...patch});},
  async generated(patch={}){
   const asset=f.asset({provenance:'generated'}),shot=await f.call('shot.create',{projectId:f.projectId,title:'Recovery shot'}),jobId=randomUUID(),versionId=randomUUID();
   const job=store.put('jobs',{id:jobId,projectId:f.projectId,shotId:shot.id,versionId,assetId:asset.id,status:'succeeded',snapshot:{projectId:f.projectId,shotId:shot.id},...patch});
   const version=store.put('versions',{id:versionId,projectId:f.projectId,shotId:shot.id,jobId,assetId:asset.id,sha256:asset.sha256,number:1});
   store.put('shots',{...shot,selectedVersionId:version.id});return {asset,shot,job,version};
  }
 };
 // This recovery suite replaces measurement only. The apply admission service,
 // shared SQLite mutation/history/receipt transaction, ownership boundary and
 // public replay path are production code. Actual decoding and the private
 // measurement lifetime are covered by timeline-loudness-apply-business and
 // timeline-loudness-transactions (including its createServices media test).
 function reportFor(timeline){
  const report=readyMixLoudness({...mixLoudnessInput,projectId:f.projectId,expectedRevision:timeline.revision,
   target:{integratedLufs:-24,truePeakCeilingDbtp:-1}}),sampleFrames=timeline.durationFrames*1600;
  const clips=timeline.clips.filter(clip=>clip.gain>0&&!timeline.tracks.find(track=>track.id===clip.trackId).muted);
  report.identity={timelineId:timeline.id,timelineRevision:timeline.revision,snapshotSha256:hash(timeline),
   range:{startFrame:0,endFrame:timeline.durationFrames,sampleFrames},
   sources:[...new Set(clips.map(clip=>clip.assetId))].sort().map(assetId=>({assetId,sha256:store.get('assets',assetId).sha256,sizeBytes:1024}))};
  const blocks=1+Math.floor((sampleFrames-19200)/4800);
  for(const measurement of [report.original,report.candidate.measurement])Object.assign(measurement,{sampleFrames,
   decodedDurationSeconds:sampleFrames/48000,gatingBlockCount:blocks,absoluteGatedBlockCount:blocks,relativeGatedBlockCount:blocks});
  report.candidate.gains=clips.map(clip=>({clipId:clip.id,assetId:clip.assetId,beforeGain:clip.gain,
   afterGain:clip.gain*report.candidate.gainMultiplier})).sort((a,b)=>a.clipId<b.clipId?-1:1);
  Object.assign(report.checks,{bytesHashed:report.identity.sources.length*2048,pcmBytes:sampleFrames*16,
   decodeWorkFrames:timeline.durationFrames*2,segmentCount:clips.length});
  return report;
 }
 function connectApply(){
  const assertAvailable=()=>{if(!ownsStoreLock(store))throw new AppError('EDIT_TASK_OWNER_REQUIRED','Owner required',403);};
  const shared=createTimelineServices(store,{hash,now:()=>new Date().toISOString(),
   required:(table,id)=>{const value=store.get(table,id);if(!value)throw new AppError('NOT_FOUND','Missing',404);return value;},
   check:(value,revision)=>{if(value.revision!==revision)throw new AppError('REVISION_CONFLICT','Changed',409);}});
  apply=createTimelineLoudnessApplyServices({assertAvailable,transactions:shared.createLoudnessApplyTransactions(assertAvailable),
   measurement:{async withFreshMeasurement(input,consume){
    const timeline=store.list('timelines').find(value=>value.projectId===input.projectId),report=reportFor(timeline);
    return consume(report,()=>{assertAvailable();assert.deepEqual(store.get('timelines',timeline.id),timeline);});
   }}}).handlers['timeline.loudness.apply'];
 }
 f.loudnessFields=async timeline=>{const report=reportFor(timeline);return {mixProfile:report.mixProfile,measurementProfile:report.measurementProfile,
  target:report.target,snapshotSha256:report.identity.snapshotSha256,candidateDigest:await timelineLoudnessCandidateDigest(report)};};
 connectApply();
 f.projectId=(await f.call('project.create',{name:t.name.slice(0,150)})).id;
 f.otherId=(await f.call('project.create',{name:'Other private project'})).id;
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return f;
}
const params=(f,timeline,fields={})=>({projectId:f.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...fields});
async function populated(f){
 const timeline=await f.call('timeline.get',{projectId:f.projectId}),asset=f.asset();
 return f.call('timeline.clip.add',params(f,timeline,{assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:60}));
}
async function allReceipts(f){
 const generated=await f.generated(),other=f.asset(),replacement=f.asset(),receipts=[];
 let timeline=await f.call('timeline.get',{projectId:f.projectId});
 async function call(operation,fields={}){
  const input=params(f,timeline,fields),response=await f.call(operation,input);
  assert.equal(isTimelineMutationResponse(operation,input,response),true,`${operation} complete ACK`);
  receipts.push({operation,input,response:clone(response)});if(operation!=='timeline.render')timeline=operation==='timeline.loudness.apply'?response.timeline:response;return response;
 }
 // Record a real format mutation while the timeline is still pristine; later
 // receipts exercise its historical replay after content and history exist.
 await call('timeline.format.set',{expectedProjectRevision:f.store.get('projects',f.projectId).revision,presetId:'landscape_720'});
 await call('timeline.seed');
 await call('timeline.track.add',{kind:'audio',name:'Extra audio'});
 await call('timeline.track.update',{trackId:timeline.tracks[0].id,patch:{name:'Renamed track'}});
 await call('timeline.clip.add',{trackId:timeline.tracks[1].id,assetId:other.id,startFrame:90,durationFrames:30});
 const clipId=timeline.clips.at(-1).id;
 await call('timeline.clip.update',{clipId,patch:{startFrame:100,durationFrames:20,gain:.6}});
 await call('timeline.clip.split',{clipId,atFrame:110});
 await call('timeline.clip.replaceSource',{clipId,assetId:replacement.id});
 await call('timeline.subtitle.add',{text:'初始字幕',startFrame:0,durationFrames:30});
 const cueId=timeline.subtitles.cues[0].id;
 await call('timeline.subtitle.update',{cueId,patch:{text:'更新字幕'}});
 await call('timeline.subtitle.remove',{cueId});
 await call('timeline.loudness.apply',await f.loudnessFields(timeline));
 await call('timeline.render',{purpose:'preview'});
 await call('timeline.clip.remove',{clipId});
 await call('timeline.clip.rippleRemove',{clipId:timeline.clips.find(clip=>clip.startFrame===110).id});
 await call('timeline.undo');
 await call('timeline.redo');
 assert.deepEqual(new Set(receipts.map(x=>x.operation)),new Set(TIMELINE_MUTATION_OPERATIONS));
 return {timeline,receipts,generated};
}
async function rejected(f,operation,input,{code,proof=false}={}){
 const before=f.capture();
 await assert.rejects(f.call(operation,input),error=>{
  if(code)assert.ok((Array.isArray(code)?code:[code]).includes(error.code),`${operation}: ${error.code}, expected ${code}`);
  assert.equal(error.details?.mutationOutcome,proof?'not_applied':undefined);
  if(proof){assert.equal(error.details.requestId,input.requestId);assert.equal(hasRequestNotAppliedProof(error,input,{operation}),true);}
  assert.ok(!JSON.stringify(error).includes('FOREIGN_SECRET'));return true;
 });
 assert.deepEqual(f.capture(),before);
}

test('service-created empty timelines remain writable while a zero-track sentinel is rejected without writes',async t=>{
 const f=await fixture(t),original=await f.call('timeline.get',{projectId:f.projectId});
 assert.deepEqual(original.tracks.map(({kind,name,orderIndex,hidden,muted})=>({kind,name,orderIndex,hidden,muted})),[
  {kind:'video',name:'Video 1',orderIndex:0,hidden:false,muted:false},
  {kind:'video',name:'Video 2',orderIndex:1,hidden:false,muted:false},
  {kind:'audio',name:'Audio 1',orderIndex:2,hidden:false,muted:false},
 ]);
 assert.deepEqual(original.clips,[]);
 const input=params(f,original,{kind:'video'}),added=await f.call('timeline.track.add',input);
 assert.equal(added.tracks.length,4);assert.equal(added.revision,original.revision+1);
 f.store.put('timelines',{...added,tracks:[]});
 await rejected(f,'timeline.track.add',params(f,added,{kind:'video'}),{code:'INVALID_TIMELINE_SNAPSHOT'});
 await rejected(f,'timeline.track.add',input,{code:'INVALID_TIMELINE_SNAPSHOT'});
 f.store.put('timelines',added);
 const before=f.capture();assert.deepEqual(await f.call('timeline.track.add',input),added);assert.deepEqual(f.capture(),before);
});

test('all seventeen retained responses remain exact after removal, branching, render progress and restart',async t=>{
 const f=await fixture(t),result=await allReceipts(f);let timeline=result.timeline;
 for(const clip of [...timeline.clips])timeline=await f.call('timeline.clip.remove',params(f,timeline,{clipId:clip.id}));
 const render=result.receipts.find(x=>x.operation==='timeline.render').response;
 f.store.put('exports',{...f.store.get('exports',render.id),status:'failed',error:{code:'EXPORT_FAILED',message:'Synthetic offline failure',retryable:true},updatedAt:'2026-10-10T01:00:00.000Z'});
 f.restart();const before=f.capture();
 for(const {operation,input,response} of result.receipts){assert.deepEqual(await f.liveCall(operation,input),response);assert.deepEqual(f.capture(),before);}
 const independent=openStore(f.root,{lock:false});try{
  const services=createServices(independent,new Map());
  for(const {operation,input,response} of result.receipts){
   if(operation==='timeline.loudness.apply')await assert.rejects(services.call(operation,input),error=>{
    assert.equal(error.code,'EDIT_TASK_OWNER_REQUIRED');assert.equal(error.details?.mutationOutcome,undefined);return true;
   });
   else assert.deepEqual(await services.call(operation,input),response);
  }
 }finally{independent.close();}
 assert.deepEqual(f.capture(),before);
});

test('all seventeen fresh stale-revision rejections carry only transaction-backed not-applied proof',async t=>{
 const f=await fixture(t),{receipts,timeline}=await allReceipts(f);
 for(const saved of receipts)await rejected(f,saved.operation,{...saved.input,requestId:randomUUID(),expectedRevision:timeline.revision-1},{code:'REVISION_CONFLICT',proof:true});
 const clip=timeline.clips[0];
 await rejected(f,'timeline.clip.split',params(f,timeline,{clipId:clip.id,atFrame:clip.startFrame}),{code:'SPLIT_BOUNDS',proof:true});
 await rejected(f,'timeline.clip.update',params(f,timeline,{clipId:clip.id,patch:{sourceInFrame:10000}}),{code:'SOURCE_BOUNDS',proof:true});
 await rejected(f,'timeline.seed',params(f,timeline),{code:'TIMELINE_NOT_EMPTY',proof:true});
 await rejected(f,'timeline.track.update',params(f,timeline,{trackId:timeline.tracks.find(x=>x.kind==='audio').id,patch:{hidden:false}}),{code:'AUDIO_HIDDEN_UNSUPPORTED',proof:true});
 await rejected(f,'timeline.clip.remove',params(f,timeline,{clipId:randomUUID()}),{code:'CLIP_NOT_FOUND'});
 await rejected(f,'timeline.clip.add',params(f,timeline,{assetId:f.asset({projectId:f.otherId,name:'FOREIGN_SECRET'}).id,trackId:timeline.tracks[0].id,startFrame:1000,durationFrames:1}),{code:'CROSS_PROJECT_REFERENCE'});
});

test('legacy initialization and transaction lifecycle failures never manufacture pre-write proof',async t=>{
 const f=await fixture(t),input={projectId:f.projectId,expectedRevision:2,requestId:randomUUID(),kind:'video'};
 await rejected(f,'timeline.track.add',input,{code:'REVISION_CONFLICT'});
 assert.equal(f.store.list('timelines').length,0);
 const timeline=await f.call('timeline.get',{projectId:f.projectId});
 const before=f.capture();
 const services=createServices({...f.store,tx:callback=>{f.store.tx(callback);throw new AppError('REVISION_CONFLICT','Ambiguous after commit',409);}},new Map());
 const accepted=params(f,timeline,{kind:'video'});
 await assert.rejects(services.call('timeline.track.add',accepted),error=>error.code==='REVISION_CONFLICT'&&error.details?.mutationOutcome===undefined);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM timeline_requests WHERE requestId=?').get(accepted.requestId).n,1);
 assert.notDeepEqual(f.capture(),before);
});

test('lost acknowledgements retain proof absence after project, timeline and historical source ownership changes',async t=>{
 for(const corruption of ['project identity','timeline SQL owner','timeline JSON owner','historical source SQL owner','indirect generation owner'])await t.test(corruption,async t=>{
  const f=await fixture(t),{receipts,generated,timeline:initial}=await allReceipts(f);let timeline=initial;
  for(const clip of [...timeline.clips])timeline=await f.call('timeline.clip.remove',params(f,timeline,{clipId:clip.id}));
  if(corruption==='project identity')f.store.db.prepare("UPDATE projects SET data=json_set(data,'$.id',?,'$.name','FOREIGN_SECRET') WHERE id=?").run(f.otherId,f.projectId);
  if(corruption==='timeline SQL owner')f.store.db.prepare('UPDATE timelines SET projectId=? WHERE id=?').run(f.otherId,timeline.id);
  if(corruption==='timeline JSON owner')f.store.db.prepare("UPDATE timelines SET data=json_set(data,'$.projectId',?) WHERE id=?").run(f.otherId,timeline.id);
  if(corruption==='historical source SQL owner')f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.otherId,generated.asset.id);
  if(corruption==='indirect generation owner')f.store.db.prepare("UPDATE jobs SET data=json_set(data,'$.projectId',?,'$.secret','FOREIGN_SECRET') WHERE id=?").run(f.otherId,generated.job.id);
  for(const {operation,input,response} of receipts){
   if(operation==='timeline.format.set'&&['historical source SQL owner','indirect generation owner'].includes(corruption)){
    // The pristine format ACK contains no historical asset references. Current
    // project/timeline ownership remains valid after clips have been removed.
    const before=f.capture();assert.deepEqual(await f.call(operation,input),response);assert.deepEqual(f.capture(),before);
   }else await rejected(f,operation,input,{code:['TIMELINE_SOURCE_UNAVAILABLE','INVALID_TIMELINE_SNAPSHOT']});
  }
 });
});

test('all seventeen malformed, foreign and semantically corrupt durable receipts fail closed unchanged',async t=>{
 for(const corruption of ['hash','JSON','owner','semantics'])await t.test(corruption,async t=>{
  const f=await fixture(t),{receipts}=await allReceipts(f);f.store.db.exec('DROP TRIGGER immutable_timeline_responses');
  for(const {operation,input,response} of receipts){
   const changed=clone(response);
   if(corruption==='owner')(operation==='timeline.loudness.apply'?changed.timeline:changed).projectId=f.otherId;
   if(corruption==='semantics'){
    const timeline=operation==='timeline.render'?changed.snapshot.timeline:operation==='timeline.loudness.apply'?changed.timeline:changed;
    if(operation==='timeline.format.set')timeline.width=720; // Valid square pair, wrong accepted preset.
    else if(operation==='timeline.loudness.apply')timeline.clips[0].gain=.1; // Must match the retained application gain proof.
    else timeline.clips[0].sourceInFrame=10000;
   }
   if(corruption==='hash')f.store.db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run('g'.repeat(64),input.requestId);
   else f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(corruption==='JSON'?'FOREIGN_SECRET invalid JSON':JSON.stringify(changed),input.requestId);
   await rejected(f,operation,input,{code:['INVALID_TIMELINE_SNAPSHOT','TIMELINE_SOURCE_UNAVAILABLE']});
  }
 });
});

async function prepared(f,operation){
 const generated=await f.generated();let timeline=await f.call('timeline.get',{projectId:f.projectId});
 if(!['timeline.seed','timeline.format.set'].includes(operation))timeline=await f.call('timeline.seed',params(f,timeline));
 if(operation==='timeline.redo')timeline=await f.call('timeline.undo',params(f,timeline));
 if(['timeline.subtitle.update','timeline.subtitle.remove'].includes(operation))timeline=await f.call('timeline.subtitle.add',params(f,timeline,{text:'待修改字幕',startFrame:0,durationFrames:30}));
 const clip=timeline.clips[0];
 const fields={
  'timeline.track.add':{kind:'video'},'timeline.track.update':{trackId:timeline.tracks[0].id,patch:{name:'Changed'}},
  'timeline.clip.add':{assetId:generated.asset.id,trackId:timeline.tracks[1].id,startFrame:0,durationFrames:30},
  'timeline.clip.update':{clipId:clip?.id,patch:{gain:.3}},'timeline.clip.remove':{clipId:clip?.id},
  'timeline.clip.rippleRemove':{clipId:clip?.id},
  'timeline.clip.split':{clipId:clip?.id,atFrame:30},'timeline.clip.replaceSource':{clipId:clip?.id,assetId:f.asset().id},
  'timeline.render':{purpose:'preview'},
  'timeline.subtitle.add':{text:'新增字幕',startFrame:0,durationFrames:30},
  'timeline.subtitle.update':{cueId:timeline.subtitles?.cues[0].id,patch:{text:'已修改字幕'}},
  'timeline.subtitle.remove':{cueId:timeline.subtitles?.cues[0].id},
  'timeline.format.set':{expectedProjectRevision:f.store.get('projects',f.projectId).revision,presetId:'landscape_720'}
 };
 return {timeline,input:params(f,timeline,operation==='timeline.loudness.apply'?await f.loudnessFields(timeline):fields[operation]??{})};
}
test('every keyed write rolls back receipt failures and post-write owner changes without not-applied proof',async t=>{
 for(const operation of TIMELINE_MUTATION_OPERATIONS)for(const corruption of ['receipt failure','timeline owner'])await t.test(`${operation}: ${corruption}`,async t=>{
  const f=await fixture(t),{input,timeline}=await prepared(f,operation);
  if(corruption==='receipt failure')f.store.db.exec("CREATE TRIGGER fail_timeline_receipt BEFORE INSERT ON timeline_requests BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;");
  else f.store.db.exec(`CREATE TRIGGER corrupt_timeline_owner AFTER INSERT ON timeline_requests BEGIN UPDATE timelines SET projectId='${f.otherId}' WHERE id='${timeline.id}'; END;`);
  await rejected(f,operation,input);
 });
});

test('history only restores editable keys and cannot replace aggregate identity or revision',async t=>{
 for(const field of ['id','projectId','revision','createdAt'])await t.test(field,async t=>{
  const f=await fixture(t),timeline=await populated(f);
  f.store.db.exec('DROP TRIGGER immutable_timeline_history');
  const row=f.store.db.prepare('SELECT id,beforeSnapshot FROM timeline_history WHERE projectId=? ORDER BY position DESC LIMIT 1').get(f.projectId),saved=JSON.parse(row.beforeSnapshot);
  saved[field]=field==='revision'?1:randomUUID();
  f.store.db.prepare('UPDATE timeline_history SET beforeSnapshot=? WHERE id=?').run(JSON.stringify(saved),row.id);
  await rejected(f,'timeline.undo',params(f,timeline),{code:'INVALID_TIMELINE_SNAPSHOT'});
 });
});

test('forty-two independently bounded source lineages remain editable and renderable beyond four MiB aggregate metadata',async t=>{
 const f=await fixture(t);let timeline=await f.call('timeline.get',{projectId:f.projectId});
 for(let i=0;i<42;i++){
  const generated=await f.generated({padding:'x'.repeat(100000)});
  timeline.clips.push({id:randomUUID(),trackId:timeline.tracks[0].id,assetId:generated.asset.id,name:'Large lineage',startFrame:i*30,durationFrames:30,sourceInFrame:0,gain:1,rect:{x:0,y:0,width:720,height:1280}});
 }
 timeline.durationFrames=42*30;f.store.put('timelines',timeline);
 const edit=params(f,timeline,{trackId:timeline.tracks[0].id,patch:{name:'Still valid'}});
 timeline=await f.call('timeline.track.update',edit);
 const input=params(f,timeline,{purpose:'export'}),render=await f.call('timeline.render',input);
 assert.equal(render.snapshot.assets.length,42);
 const before=f.capture();assert.deepEqual(await f.call('timeline.render',input),render);assert.deepEqual(f.capture(),before);
 f.restart();assert.deepEqual(await f.call('timeline.track.update',edit),timeline);
});

test('legacy optional frozen fields remain omitted and replay bytes are never normalized',async t=>{
 const f=await fixture(t),timeline=await populated(f),input=params(f,timeline,{purpose:'preview'}),render=await f.call('timeline.render',input);
 for(const asset of render.snapshot.assets){delete asset.hasAudio;delete asset.relativePath;}
 const protections=f.store.db.prepare("SELECT sql FROM sqlite_schema WHERE name IN ('immutable_timeline_responses','immutable_timeline_render_snapshot') ORDER BY name").all();
 f.store.db.exec('DROP TRIGGER immutable_timeline_responses; DROP TRIGGER immutable_timeline_render_snapshot;');
 f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(render),input.requestId);
 f.store.put('exports',render);
 // Synthetic legacy bytes are valid, but current38 requires complete guards.
 for(const protection of protections)f.store.db.exec(protection.sql);
 const before=f.capture();f.restart();
 assert.deepEqual(await f.call('timeline.render',input),render);assert.deepEqual(f.capture(),before);
});

test('independent writers share one retained response and competing fresh keys receive rollback proof',async t=>{
 const f=await fixture(t),timeline=await populated(f),input=params(f,timeline,{clipId:timeline.clips[0].id,atFrame:30});
 const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openStore}=await import(workerData.db);const {createServices}=await import(workerData.services);const store=openStore(workerData.root,{lock:false});parentPort.postMessage({ready:true});parentPort.once('message',async()=>{try{parentPort.postMessage({response:await createServices(store,new Map()).call('timeline.clip.split',workerData.input)});}catch(error){parentPort.postMessage({code:error.code,details:error.details});}finally{store.close();}});})();`;
 async function race(inputs){
  const workers=inputs.map(input=>new Worker(source,{eval:true,workerData:{root:f.root,input,db:new URL('../packages/business/src/db.ts',import.meta.url).href,services:new URL('../packages/business/src/services.ts',import.meta.url).href}}));
  t.after(()=>Promise.all(workers.map(worker=>worker.terminate())));
  await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);})));
  const results=workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));workers.forEach(worker=>worker.postMessage('go'));return Promise.all(results);
 }
 const results=await race([input,input]);assert.deepEqual(results[0].response,results[1].response);assert.ok(results[0].response);
 const current=results[0].response,competitors=await race([1,2].map(()=>params(f,current,{clipId:current.clips[0].id,atFrame:15})));
 assert.equal(competitors.filter(x=>x.response).length,1);
 const failed=competitors.find(x=>x.code);assert.equal(failed.code,'REVISION_CONFLICT');assert.equal(failed.details.mutationOutcome,'not_applied');
});


test('split receipts cannot reset moving-media source time using the still-image acknowledgement alternative',async t=>{
 for(const mimeType of ['video/mp4','audio/wav'])await t.test(mimeType,async t=>{
  const f=await fixture(t),asset=f.asset({mimeType});let timeline=await f.call('timeline.get',{projectId:f.projectId});
  timeline=await f.call('timeline.clip.add',params(f,timeline,{assetId:asset.id,trackId:timeline.tracks.find(track=>track.kind===(mimeType.startsWith('audio/')?'audio':'video')).id,startFrame:0,durationFrames:60}));
  const input=params(f,timeline,{clipId:timeline.clips[0].id,atFrame:30}),response=await f.call('timeline.clip.split',input);
  response.clips.find(clip=>clip.id!==input.clipId).sourceInFrame=0;
  f.store.db.exec('DROP TRIGGER immutable_timeline_responses');
  f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(response),input.requestId);
  await rejected(f,'timeline.clip.split',input,{code:'INVALID_TIMELINE_SNAPSHOT'});
 });
});

test('render replay rejects stable source identity changes and mismatched retained frozen snapshots',async t=>{
 for(const field of ['sha256','mimeType','duration','width','height','hasAudio','relativePath'])await t.test(field,async t=>{
  const f=await fixture(t),timeline=await populated(f),input=params(f,timeline,{purpose:'preview'}),render=await f.call('timeline.render',input);
  const saved=f.store.get('exports',render.id),frozen=saved.snapshot.assets[0];
  const values={sha256:'b'.repeat(64),mimeType:'video/webm',duration:11,width:722,height:1282,hasAudio:false,relativePath:'media/wrong.fixture'};
  frozen[field]=values[field];
  f.store.db.exec('DROP TRIGGER immutable_timeline_responses; DROP TRIGGER immutable_timeline_render_snapshot;');
  f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(saved),input.requestId);
  if(['sha256','mimeType','relativePath'].includes(field))f.store.put('exports',saved);
  await rejected(f,'timeline.render',input,{code:['TIMELINE_SOURCE_UNAVAILABLE','INVALID_TIMELINE_SNAPSHOT']});
 });
});


test('schema-produced timelines larger than the replacement cap preserve generic mutation receipts and history',async t=>{
 const f=await fixture(t),asset=f.asset(),name='\0'.repeat(200);let timeline=await f.call('timeline.get',{projectId:f.projectId}),lastAdd,earlyReplacement;
 for(let index=0;index<100;index++){
  const input=params(f,timeline,{assetId:asset.id,trackId:timeline.tracks[0].id,name,startFrame:index,durationFrames:1});
  timeline=await f.call('timeline.clip.add',input);lastAdd={operation:'timeline.clip.add',input,response:clone(timeline)};
  if(index===0){
   const replacement=params(f,timeline,{clipId:timeline.clips[0].id,assetId:f.asset().id});
   timeline=await f.call('timeline.clip.replaceSource',replacement);
   earlyReplacement={operation:'timeline.clip.replaceSource',input:replacement,response:clone(timeline)};
  }
 }
 assert.ok(Buffer.byteLength(JSON.stringify(timeline))>128*1024);
 const receipts=[earlyReplacement,lastAdd];
 for(const operation of ['timeline.track.update','timeline.undo','timeline.redo']){
  const input=params(f,timeline,operation==='timeline.track.update'?{trackId:timeline.tracks[0].id,patch:{name:'Large legacy timeline'}}:{});
  timeline=await f.call(operation,input);receipts.push({operation,input,response:clone(timeline)});
 }
 const renderInput=params(f,timeline,{purpose:'preview'}),render=await f.call('timeline.render',renderInput);
 receipts.push({operation:'timeline.render',input:renderInput,response:clone(render)});
 const history=f.store.db.prepare('SELECT beforeSnapshot,afterSnapshot FROM timeline_history WHERE projectId=? ORDER BY position DESC LIMIT 1').get(f.projectId);
 assert.ok(Buffer.byteLength(history.beforeSnapshot)>128*1024);assert.ok(Buffer.byteLength(history.afterSnapshot)>128*1024);
 f.restart();const before=f.capture();
 for(const {operation,input,response} of receipts)assert.deepEqual(await f.call(operation,input),response);
 assert.deepEqual(f.capture(),before);
});


test('historical render replay preserves frozen bytes after same-source shorter duration and audio metadata drift',async t=>{
 const f=await fixture(t);let timeline=await populated(f);
 timeline=await f.call('timeline.clip.update',params(f,timeline,{clipId:timeline.clips[0].id,patch:{fadeInFrames:4,fadeOutFrames:3}}));
 const input=params(f,timeline,{purpose:'preview'}),render=await f.call('timeline.render',input),original=JSON.stringify(render);
 const source=f.store.get('assets',timeline.clips[0].assetId);
 f.store.put('assets',{...source,duration:.25,width:2,height:2,hasAudio:false});
 const retained=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
 f.restart();const before=f.capture(),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n,events=[],off=onMediaProcess(event=>events.push(event));
 t.mock.method(globalThis,'fetch',()=>{throw Error('Replay must not use the network');});
 try{
  assert.equal(JSON.stringify(await f.call('timeline.render',input)),original);
  assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,retained);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  assert.deepEqual(f.capture(),before);assert.deepEqual(events,[]);
  // A new render still validates current metadata; only exact retained replay
  // may recover the historical acknowledgement without re-rendering anything.
  await rejected(f,'timeline.render',{...input,requestId:randomUUID()},{code:'FADE_AUDIO_UNSUPPORTED',proof:true});
  f.store.put('assets',{...source,duration:.25});
  await rejected(f,'timeline.render',{...input,requestId:randomUUID()},{code:'SOURCE_BOUNDS',proof:true});
 }finally{off();}
});
