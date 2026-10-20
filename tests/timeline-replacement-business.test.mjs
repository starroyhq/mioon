import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';

const operation='timeline.clip.replaceSource';
const clone=value=>JSON.parse(JSON.stringify(value));
const domain=value=>clone({tracks:value.tracks,clips:value.clips,durationFrames:value.durationFrames});
const at='2026-10-10T00:00:00.000Z';
const outsideTables=['projects','assets','shots','nodes','edges','jobs','versions','exports'];
const definiteRejections=new Set(['REVISION_CONFLICT','SOURCE_UNCHANGED','INVALID_CLIP_TYPE','SOURCE_BOUNDS','INVALID_FADE','FADE_AUDIO_UNSUPPORTED']);
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-replacement-'));
 let store=openStore(root),services=createServices(store,new Map());
 const f={root,get store(){return store;},call:(op,input)=>services.call(op,input),
  restart(){store.close();store=openStore(root);services=createServices(store,new Map());},
  capture(tables=['timelines','timeline_history','timeline_history_cursors','timeline_requests']){
   return Object.fromEntries(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  },
  asset(mimeType='video/mp4',patch={}){const id=randomUUID();return store.put('assets',{id,projectId:f.projectId,name:'Synthetic source',mimeType,
   duration:10,width:720,height:1280,hasVideo:!mimeType.startsWith('audio/'),hasAudio:!mimeType.startsWith('image/'),provenance:'user-import',
   sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`,createdAt:at,...patch});},
  async generated(patch={}){
   const asset=f.asset('video/mp4',{provenance:'generated',...patch}),projectId=asset.projectId;
   const shot=await f.call('shot.create',{projectId,title:'Synthetic shot'}),jobId=randomUUID(),versionId=randomUUID();
   const snapshot={projectId,shotId:shot.id,referenceAssetIds:[],referenceAssets:[]};
   const job=store.put('jobs',{id:jobId,projectId,shotId:shot.id,versionId,assetId:asset.id,status:'succeeded',providerId:'mock',requestId:randomUUID(),snapshot});
   const version=store.put('versions',{id:versionId,projectId,shotId:shot.id,assetId:asset.id,jobId,number:1,sha256:asset.sha256,snapshot});
   return {asset,shot,job,version};
  },
  update(table,id,patch={},sql={}){
   if(table==='versions')store.db.exec('DROP TRIGGER IF EXISTS immutable_versions');
   const record={...store.get(table,id),...patch};
   store.db.prepare(`UPDATE ${table} SET data=?${Object.keys(sql).map(key=>`,${key}=?`).join('')} WHERE id=?`).run(JSON.stringify(record),...Object.values(sql),id);
  },
  async timeline(asset=f.asset(),patch={}){
   let timeline=await f.call('timeline.get',{projectId:f.projectId});
   timeline=await f.call('timeline.clip.add',params(f,timeline,{assetId:asset.id,trackId:timeline.tracks.find(track=>track.kind===(asset.mimeType.startsWith('audio/')?'audio':'video')).id,
    name:'Keep this clip',startFrame:23,sourceInFrame:asset.mimeType.startsWith('image/')?0:7,durationFrames:60,gain:.65,rect:{x:40,y:80,width:360,height:640},...patch}));
   return timeline;
  }
 };
 f.projectId=(await f.call('project.create',{name:t.name.slice(0,150)})).id;
 f.otherId=(await f.call('project.create',{name:'Other private project'})).id;
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 return f;
}
const params=(f,timeline,extra={})=>({projectId:f.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...extra});
const replace=(f,timeline,asset,extra={})=>params(f,timeline,{clipId:timeline.clips[0].id,assetId:asset.id,...extra});
function corruptTimelineAggregate(f,timeline){
 const db=f.store.db,names=['agent_target_timeline_update_v2','agent_target_timeline_timeline_clip_update_v2','agent_target_timeline_timeline_track_update_v2','agent_target_timeline_timeline_subtitle_update_v2'];
 const guards=db.prepare(`SELECT name,sql FROM sqlite_schema WHERE name IN (${names.map(()=>'?').join(',')}) ORDER BY name`).all(...names);
 assert.deepEqual(guards.map(value=>value.name),[...names].sort());
 const tables=[...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests','agent_task_target_revisions_v2'],before=f.capture(tables);
 assert.throws(()=>db.prepare('UPDATE timelines SET data=? WHERE id=?').run('{',timeline.id),/malformed JSON/);
 assert.deepEqual(f.capture(tables),before,'live target guards reject malformed aggregate bytes atomically');
 // Only direct construction of corrupt fixture bytes omits these four JSON
 // readers. Restore their exact SQL before any business rejection is tested.
 try{
  for(const guard of guards)db.exec(`DROP TRIGGER "${guard.name}"`);
  db.prepare('UPDATE timelines SET data=? WHERE id=?').run('{',timeline.id);
 }finally{for(const guard of guards)db.exec(guard.sql);}
 assert.deepEqual(db.prepare(`SELECT name,sql FROM sqlite_schema WHERE name IN (${names.map(()=>'?').join(',')}) ORDER BY name`).all(...names),guards);
}
async function rejectAtomic(f,input,code){
 const before=f.capture([...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests']);
 await assert.rejects(f.call(operation,input),error=>{
  assert.ok((Array.isArray(code)?code:[code]).includes(error.code),`Expected ${code}, received ${error.code}: ${error.message}`);
  assert.ok(!JSON.stringify(error).includes('FOREIGN_SECRET'),'Errors must not expose a foreign record');
  const fresh=!before.timeline_requests.some(row=>row.requestId===input.requestId);
  if(fresh&&definiteRejections.has(error.code)){
   assert.equal(error.details.mutationOutcome,'not_applied');assert.equal(error.details.requestId,input.requestId);
  }else assert.equal(error.details?.mutationOutcome,undefined,'An existing receipt, unknown error or ownership failure is not not-applied proof');
  return true;
 });
 assert.deepEqual(f.capture([...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests']),before);
}

test('replacement preserves complete clip editing state, pins explicit provenance, and round-trips one history entry',async t=>{
 const f=await fixture(t),old=await f.generated(),next=await f.generated();
 let timeline=await f.timeline(old.asset,{fadeInFrames:5,fadeOutFrames:9});
 Object.assign(timeline.clips[0],{versionId:old.version.id,shotId:old.shot.id,jobId:old.job.id});
 f.store.put('timelines',timeline);
 timeline=await f.call('timeline.clip.add',params(f,timeline,{assetId:old.asset.id,trackId:timeline.tracks[1].id,startFrame:0,durationFrames:30}));
 const frozenExport=await f.call('timeline.render',params(f,timeline,{purpose:'preview'}));
 const before=clone(timeline),outside=f.capture(outsideTables),historyBefore=await f.call('timeline.history.get',{projectId:f.projectId});
 const request=replace(f,timeline,next.asset,{versionId:next.version.id});
 const result=await f.call(operation,request),expected={...before.clips[0],assetId:next.asset.id,versionId:next.version.id,shotId:next.shot.id};delete expected.jobId;
 assert.deepEqual(result.clips[0],expected);assert.deepEqual(result.clips[1],before.clips[1]);
 assert.deepEqual(result.tracks,before.tracks);assert.equal(result.durationFrames,before.durationFrames);assert.equal(result.id,before.id);
 assert.equal(result.revision,before.revision+1);assert.equal(result.createdAt,before.createdAt);
 assert.equal(Object.hasOwn(result.clips[0],'sourceSha256'),false);
 assert.equal(frozenExport.snapshot.timeline.clips[0].assetId,old.asset.id);
 assert.deepEqual(f.capture(outsideTables),outside);
 const history=await f.call('timeline.history.get',{projectId:f.projectId});assert.equal(history.length,historyBefore.length+1);assert.equal(history.undoEntry.operation,operation);
 const entry=f.store.db.prepare('SELECT * FROM timeline_history WHERE id=?').get(history.undoEntry.id);
 assert.deepEqual(JSON.parse(entry.beforeSnapshot),domain(before));assert.deepEqual(JSON.parse(entry.afterSnapshot),domain(result));
 timeline=await f.call('timeline.undo',params(f,result));assert.deepEqual(domain(timeline),domain(before));
 timeline=await f.call('timeline.redo',params(f,timeline));assert.deepEqual(domain(timeline),domain(result));
 assert.deepEqual(f.capture(outsideTables),outside);
 const selection=await f.call('version.select',{shotId:old.shot.id,versionId:old.version.id,expectedRevision:old.shot.revision});
 assert.equal(selection.selectedVersionId,old.version.id);
 assert.deepEqual((await f.call('timeline.get',{projectId:f.projectId})).clips,result.clips,'Version selection never retargets a clip');
 assert.deepEqual(await f.call(operation,request),result);
});

test('asset-only generated replacement removes stale provenance without inventing links or legacy fade keys',async t=>{
 const f=await fixture(t),old=await f.generated(),next=await f.generated();
 const timeline=await f.timeline(old.asset);
 Object.assign(timeline.clips[0],{versionId:old.version.id,shotId:old.shot.id,jobId:old.job.id});f.store.put('timelines',timeline);
 const result=await f.call(operation,replace(f,timeline,next.asset));
 const expected={...timeline.clips[0],assetId:next.asset.id};for(const key of ['versionId','shotId','jobId'])delete expected[key];
 assert.deepEqual(result.clips[0],expected);
 for(const key of ['versionId','shotId','jobId','sourceSha256','fadeInFrames','fadeOutFrames'])assert.equal(Object.hasOwn(result.clips[0],key),false,key);
});

test('replacement cannot commit a saved extension field rejected by the shared acknowledgement guard',async t=>{
 const f=await fixture(t),timeline=await f.timeline();timeline.clips[0].unsupportedExtension='preserve until explicitly migrated';f.store.put('timelines',timeline);
 await rejectAtomic(f,replace(f,timeline,f.asset()),'INVALID_TIMELINE_SNAPSHOT');
 assert.equal(f.store.get('timelines',timeline.id).clips[0].unsupportedExtension,'preserve until explicitly migrated');
});

test('each media category can replace its own kind, including image and audio containers',async t=>{
 for(const [from,to] of [['video/mp4','video/webm'],['audio/wav','audio/mp4'],['image/png','image/jpeg']])await t.test(`${from} to ${to}`,async t=>{
  const f=await fixture(t),old=f.asset(from),next=f.asset(to),timeline=await f.timeline(old);
  const result=await f.call(operation,replace(f,timeline,next));
  assert.deepEqual(result.clips[0],{...timeline.clips[0],assetId:next.id});
 });
});

test('same source, changed category, short media, incompatible fades and stale revision reject atomically without discarding redo',async t=>{
 const f=await fixture(t),old=f.asset(),timeline=await f.timeline(old,{fadeInFrames:8,fadeOutFrames:6});
 const extra=await f.call('timeline.track.add',params(f,timeline,{kind:'video'})),current=await f.call('timeline.undo',params(f,extra));
 const base=replace(f,current,f.asset());
 await rejectAtomic(f,{...base,assetId:old.id},'SOURCE_UNCHANGED');
 for(const mimeType of ['image/png','audio/wav'])await rejectAtomic(f,{...base,requestId:randomUUID(),assetId:f.asset(mimeType).id},'INVALID_CLIP_TYPE');
 for(const duration of [0,2,undefined])await rejectAtomic(f,{...base,requestId:randomUUID(),assetId:f.asset('video/mp4',{duration}).id},'SOURCE_BOUNDS');
 await rejectAtomic(f,{...base,requestId:randomUUID(),assetId:f.asset('video/mp4',{hasAudio:false}).id},'FADE_AUDIO_UNSUPPORTED');
 await rejectAtomic(f,{...base,expectedRevision:current.revision-1},'REVISION_CONFLICT');
 await rejectAtomic(f,{...base,clipId:randomUUID()},'CLIP_NOT_FOUND');
 assert.equal((await f.call('timeline.history.get',{projectId:f.projectId})).canRedo,true);
});

test('replacement accepts the exact preserved source end and rejects one-frame-short or fractional final frames',async t=>{
 const f=await fixture(t),timeline=await f.timeline();
 for(const duration of [66/30,66.9/30])await rejectAtomic(f,replace(f,timeline,f.asset('video/mp4',{duration})),'SOURCE_BOUNDS');
 const exact=f.asset('video/mp4',{duration:67/30}),result=await f.call(operation,replace(f,timeline,exact));
 assert.equal(result.clips[0].sourceInFrame,7);assert.equal(result.clips[0].durationFrames,60);
});

test('duplicates, lost acknowledgements and restart replay the exact response after undo, branching, replacement and clip removal',async t=>{
 const f=await fixture(t),timeline=await f.timeline(),next=f.asset(),request=replace(f,timeline,next);
 const responses=await Promise.all(Array.from({length:8},()=>f.call(operation,request)));
 responses.forEach(value=>assert.deepEqual(value,responses[0]));const saved=responses[0];
 assert.equal(saved.revision,timeline.revision+1);f.restart();
 assert.deepEqual(await f.call(operation,request),saved);
 let current=await f.call('timeline.undo',params(f,saved));
 const afterUndo=f.capture();assert.deepEqual(await f.call(operation,request),saved);assert.deepEqual(f.capture(),afterUndo);
 current=await f.call(operation,replace(f,current,f.asset()));
 current=await f.call('timeline.clip.remove',params(f,current,{clipId:request.clipId}));
 f.restart();const afterRemoval=f.capture();assert.deepEqual(await f.call(operation,request),saved);assert.deepEqual(f.capture(),afterRemoval);
 for(const changed of [{assetId:f.asset().id},{versionId:randomUUID()},{expectedRevision:current.revision},{projectId:f.otherId}])
  await rejectAtomic(f,{...request,...changed},'IDEMPOTENCY_CONFLICT');
 assert.equal((await f.call('timeline.get',{projectId:f.projectId})).clips.length,0);
});

test('missing timelines and missing/foreign assets reject without initialization or information leakage',async t=>{
 const f=await fixture(t),next=f.asset();
 await rejectAtomic(f,{projectId:f.projectId,expectedRevision:1,requestId:randomUUID(),clipId:randomUUID(),assetId:next.id},'CLIP_NOT_FOUND');
 assert.equal(f.store.list('timelines').length,0);
 const timeline=await f.timeline(),base=replace(f,timeline,next);
 await rejectAtomic(f,{...base,assetId:randomUUID()},'TIMELINE_SOURCE_UNAVAILABLE');
 await rejectAtomic(f,{...base,assetId:f.asset('video/mp4',{projectId:f.otherId,name:'FOREIGN_SECRET'}).id},'TIMELINE_SOURCE_UNAVAILABLE');
 await rejectAtomic(f,{...base,projectId:randomUUID()},'TIMELINE_SOURCE_UNAVAILABLE');
});

test('new replacement rejects SQL/JSON owner and identity corruption before CAS can expose current data',async t=>{
 const cases=[
  ['project JSON identity',(f,tl,next)=>f.update('projects',f.projectId,{id:f.otherId,name:'FOREIGN_SECRET'})],
  ['timeline SQL owner',(f,tl,next)=>f.update('timelines',tl.id,{}, {projectId:f.otherId})],
  ['timeline JSON owner',(f,tl,next)=>f.update('timelines',tl.id,{projectId:f.otherId,name:'FOREIGN_SECRET'})],
  ['timeline JSON identity',(f,tl,next)=>f.update('timelines',tl.id,{id:randomUUID()})],
  ['current asset SQL owner',(f,tl,next)=>f.update('assets',tl.clips[0].assetId,{}, {projectId:f.otherId})],
  ['current asset JSON owner',(f,tl,next)=>f.update('assets',tl.clips[0].assetId,{projectId:f.otherId,name:'FOREIGN_SECRET'})],
  ['candidate asset SQL owner',(f,tl,next)=>f.update('assets',next.id,{}, {projectId:f.otherId})],
  ['candidate asset JSON owner',(f,tl,next)=>f.update('assets',next.id,{projectId:f.otherId,name:'FOREIGN_SECRET'})],
  ['candidate asset JSON identity',(f,tl,next)=>f.update('assets',next.id,{id:randomUUID()})],
  ['malformed candidate JSON',(f,tl,next)=>f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run('{',next.id)],
  ['oversized candidate JSON',(f,tl,next)=>f.update('assets',next.id,{padding:'x'.repeat(17000)})],
  ['malformed timeline JSON',corruptTimelineAggregate],
 ];
 for(const [name,corrupt] of cases)await t.test(name,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),next=f.asset();corrupt(f,timeline,next);
  const input=replace(f,timeline,next);
  await rejectAtomic(f,input,['TIMELINE_SOURCE_UNAVAILABLE','CLIP_NOT_FOUND']);
  if(name.startsWith('current')||name.startsWith('timeline')||name.startsWith('project'))
   await rejectAtomic(f,{...input,expectedRevision:1},['TIMELINE_SOURCE_UNAVAILABLE','CLIP_NOT_FOUND']);
 });
});

test('explicit versions and asset-only selection validate complete actual reverse generation ownership',async t=>{
 const cases=[
  ['unknown version',async(f,g)=>({versionId:randomUUID()})],
  ['wrong asset version',async(f,g)=>({versionId:(await f.generated()).version.id})],
  ['foreign version',async(f,g)=>({versionId:(await f.generated({projectId:f.otherId})).version.id})],
  ['version SQL owner',async(f,g)=>{f.update('versions',g.version.id,{}, {projectId:f.otherId});}],
  ['version JSON owner',async(f,g)=>{f.update('versions',g.version.id,{projectId:f.otherId});}],
  ['version SQL job',async(f,g)=>{const other=await f.generated();f.store.db.prepare('DELETE FROM versions WHERE id=?').run(other.version.id);f.update('versions',g.version.id,{}, {jobId:other.job.id});}],
  ['version hash',async(f,g)=>{f.update('versions',g.version.id,{sha256:'b'.repeat(64)});}],
  ['job JSON owner',async(f,g)=>{f.update('jobs',g.job.id,{projectId:f.otherId});}],
  ['job SQL owner',async(f,g)=>{f.update('jobs',g.job.id,{}, {projectId:f.otherId});}],
  ['job asset mismatch',async(f,g)=>{f.update('jobs',g.job.id,{assetId:f.asset().id});}],
  ['job version mismatch',async(f,g)=>{f.update('jobs',g.job.id,{versionId:randomUUID()});}],
  ['job shot mismatch',async(f,g)=>{f.update('jobs',g.job.id,{shotId:randomUUID()});}],
  ['shot SQL owner',async(f,g)=>{f.update('shots',g.shot.id,{}, {projectId:f.otherId});}],
  ['shot reference asset owner',async(f,g)=>{f.update('shots',g.shot.id,{referenceAssetIds:[f.asset('image/png',{projectId:f.otherId}).id]});}],
  ['version snapshot owner',async(f,g)=>{f.update('versions',g.version.id,{snapshot:{projectId:f.otherId}});}],
  ['job snapshot source owner',async(f,g)=>{f.update('jobs',g.job.id,{snapshot:{referenceAssets:[{id:f.asset('image/png',{projectId:f.otherId}).id}]}});}],
  ['missing reverse version',async(f,g)=>{f.store.db.prepare('DELETE FROM versions WHERE id=?').run(g.version.id);}],
  ['hidden foreign reverse owner',async(f,g)=>{f.update('assets',g.asset.id,{provenance:'user-import'});f.update('versions',g.version.id,{projectId:f.otherId},{projectId:f.otherId});}],
  ['duplicate reverse owner',async(f,g)=>{const other=await f.generated();f.update('versions',other.version.id,{assetId:g.asset.id});}],
 ];
 for(const [name,corrupt] of cases)await t.test(name,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),generated=await f.generated(),patch=await corrupt(f,generated);
  await rejectAtomic(f,replace(f,timeline,generated.asset,{versionId:generated.version.id,...patch}),'TIMELINE_SOURCE_UNAVAILABLE');
  if(!patch)await rejectAtomic(f,replace(f,timeline,generated.asset),'TIMELINE_SOURCE_UNAVAILABLE');
 });
});

test('saved replacement receipts fail closed when their response structure or exact scope is corrupted',async t=>{
 const cases=[
  ['foreign project',value=>({...value,projectId:randomUUID(),name:'FOREIGN_SECRET'})],
  ['different timeline',value=>({...value,id:randomUUID()})],
  ['wrong revision',value=>({...value,revision:value.revision+1})],
  ['missing target clip',value=>({...value,clips:[]})],
  ['different target source',value=>({...value,clips:value.clips.map(clip=>({...clip,assetId:randomUUID()}))})],
  ['invented provenance',value=>({...value,clips:value.clips.map(clip=>({...clip,versionId:randomUUID()}))})],
  ['wrong total duration',value=>({...value,durationFrames:value.durationFrames+1})],
  ['invalid fades',value=>({...value,clips:value.clips.map(clip=>({...clip,fadeInFrames:clip.durationFrames+1}))})],
  ['out of source bounds',value=>({...value,clips:value.clips.map(clip=>({...clip,sourceInFrame:300}))})],
  ['malformed JSON',()=>'{'],
  ['oversized response',value=>({...value,padding:'x'.repeat(132000)})]
 ];
 for(const [name,change] of cases)await t.test(name,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),request=replace(f,timeline,f.asset()),result=await f.call(operation,request);
  f.store.db.exec('DROP TRIGGER immutable_timeline_responses');const corrupt=change(result);
  f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(typeof corrupt==='string'?corrupt:JSON.stringify(corrupt),request.requestId);
  await rejectAtomic(f,request,['INVALID_TIMELINE_SNAPSHOT','TIMELINE_SOURCE_UNAVAILABLE']);
 });
});

test('malformed or oversized replacement receipt hashes are rejected before response decoding',async t=>{
 for(const requestHash of ['x'.repeat(200000),'g'.repeat(64),'0'.repeat(63)])await t.test(`invalid hash length ${requestHash.length}`,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),request=replace(f,timeline,f.asset());await f.call(operation,request);
  f.store.db.exec('DROP TRIGGER immutable_timeline_responses');
  f.store.db.prepare('UPDATE timeline_requests SET requestHash=?,response=? WHERE requestId=?').run(requestHash,'FOREIGN_SECRET invalid JSON',request.requestId);
  await rejectAtomic(f,request,'INVALID_TIMELINE_SNAPSHOT');
 });
});

test('historical replay requires current project, aggregate and every saved source to retain ownership',async t=>{
 const cases=[
  ['missing project',async(f,tl,next)=>{f.store.db.exec('PRAGMA foreign_keys=OFF');f.store.db.prepare('DELETE FROM projects WHERE id=?').run(f.projectId);}],
  ['missing timeline',async(f,tl,next)=>f.store.db.prepare('DELETE FROM timelines WHERE id=?').run(tl.id)],
  ['reassigned timeline',async(f,tl,next)=>f.update('timelines',tl.id,{projectId:f.otherId},{projectId:f.otherId})],
  ['missing saved source',async(f,tl,next)=>f.store.db.prepare('DELETE FROM assets WHERE id=?').run(next.id)],
  ['reassigned saved source',async(f,tl,next)=>f.update('assets',next.id,{projectId:f.otherId,name:'FOREIGN_SECRET'},{projectId:f.otherId})],
  ['saved source SQL/JSON mismatch',async(f,tl,next)=>f.update('assets',next.id,{}, {projectId:f.otherId})],
 ];
 for(const [name,change] of cases)await t.test(name,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),next=f.asset(),request=replace(f,timeline,next),saved=await f.call(operation,request);
  await f.call('timeline.clip.remove',params(f,saved,{clipId:request.clipId}));await change(f,saved,next);
  await rejectAtomic(f,request,['TIMELINE_SOURCE_UNAVAILABLE','CLIP_NOT_FOUND']);
 });
});

test('durable receipt failures and post-write owner corruption roll back timeline, redo branch, history and request together',async t=>{
 for(const mode of ['receipt failure','timeline owner','asset owner','source duration','source audio','response corruption','hash corruption'])await t.test(mode,async t=>{
  const f=await fixture(t),timeline=await f.timeline(undefined,{fadeInFrames:2}),next=f.asset(),extra=await f.call('timeline.track.add',params(f,timeline,{kind:'audio'}));
  const current=await f.call('timeline.undo',params(f,extra)),request=replace(f,current,next);
  if(mode==='receipt failure')f.store.db.exec("CREATE TRIGGER fail_replacement_receipt BEFORE INSERT ON timeline_requests BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;");
  if(mode==='timeline owner')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_owner AFTER UPDATE ON timelines BEGIN UPDATE timelines SET projectId='${f.otherId}' WHERE id=NEW.id; END;`);
  if(mode==='asset owner')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_source AFTER UPDATE ON timelines BEGIN UPDATE assets SET projectId='${f.otherId}' WHERE id='${next.id}'; END;`);
  if(mode==='source duration')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_duration AFTER UPDATE ON timelines BEGIN UPDATE assets SET data=json_set(data,'$.duration',1) WHERE id='${next.id}'; END;`);
  if(mode==='source audio')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_audio AFTER UPDATE ON timelines BEGIN UPDATE assets SET data=json_set(data,'$.hasAudio',json('false')) WHERE id='${next.id}'; END;`);
  if(mode==='response corruption')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_receipt AFTER INSERT ON timeline_requests BEGIN DELETE FROM timeline_requests WHERE requestId=NEW.requestId; END;`);
  if(mode==='hash corruption')f.store.db.exec(`DROP TRIGGER immutable_timeline_responses; CREATE TRIGGER corrupt_replacement_hash AFTER INSERT ON timeline_requests BEGIN UPDATE timeline_requests SET requestHash='${'0'.repeat(64)}' WHERE requestId=NEW.requestId; END;`);
  const before=f.capture([...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests']);
  await assert.rejects(f.call(operation,request),error=>{
   assert.equal(error.details?.mutationOutcome,undefined,'Post-write validation or database errors remain unknown to recovery clients');
   return mode==='receipt failure'?/injected receipt failure/.test(error.message):['TIMELINE_SOURCE_UNAVAILABLE','CLIP_NOT_FOUND','INVALID_TIMELINE_SNAPSHOT','SOURCE_BOUNDS','FADE_AUDIO_UNSUPPORTED'].includes(error.code);
  });
  assert.deepEqual(f.capture([...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests']),before);
 });
});

async function race(t,f,inputs){
 const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openStore}=await import(workerData.db);const {createServices}=await import(workerData.services);const store=openStore(workerData.root,{lock:false});parentPort.postMessage({ready:true});parentPort.once('message',async()=>{try{parentPort.postMessage({result:await createServices(store,new Map()).call('${operation}',workerData.input)});}catch(error){parentPort.postMessage({error:error.code||error.message});}finally{store.close();}});})().catch(error=>{throw error});`;
 const workers=inputs.map(input=>new Worker(source,{eval:true,workerData:{root:f.root,input,db:new URL('../packages/business/src/db.ts',import.meta.url).href,services:new URL('../packages/business/src/services.ts',import.meta.url).href}}));
 t.after(()=>Promise.all(workers.map(worker=>worker.terminate())));
 await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);})));
 const pending=workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));workers.forEach(worker=>worker.postMessage('go'));
 return Promise.all(pending);
}
test('independent SQLite writers serialize exact duplicates once and conflicting fresh writers by CAS',async t=>{
 const f=await fixture(t),timeline=await f.timeline(),request=replace(f,timeline,f.asset());
 const duplicate=await race(t,f,[request,request,request]);duplicate.forEach(value=>{assert.equal(value.error,undefined);assert.deepEqual(value.result,duplicate[0].result);});
 assert.equal(duplicate[0].result.revision,timeline.revision+1);
 const current=duplicate[0].result,requests=Array.from({length:3},()=>replace(f,current,f.asset()));
 const competing=await race(t,f,requests);assert.equal(competing.filter(value=>value.result).length,1);
 competing.filter(value=>value.error).forEach(value=>assert.equal(value.error,'REVISION_CONFLICT'));
 assert.equal((await f.call('timeline.get',{projectId:f.projectId})).revision,current.revision+1);
 assert.equal((await f.call('timeline.history.get',{projectId:f.projectId})).length,3);
});

test('replacement uses only local metadata and never invokes providers or network',async t=>{
 const f=await fixture(t),timeline=await f.timeline(),request=replace(f,timeline,f.asset());
 let outbound=0;t.mock.method(globalThis,'fetch',()=>{outbound++;throw Error('Forbidden outbound');});
 const provider=new Proxy({}, {get(){outbound++;throw Error('Forbidden provider');}}),services=createServices(f.store,new Map([['mock',provider]]));
 await services.call(operation,request);assert.equal(outbound,0);
});
