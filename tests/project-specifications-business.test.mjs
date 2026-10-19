import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {TIMELINE_OUTPUT_PRESETS,hasRequestNotAppliedProof} from '@mioon/contracts';
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-format-'));let store=openStore(root),services=createServices(store,new Map());
 const project=await services.call('project.create',{name:'Output fixture'});
 const f={project,root,get store(){return store;},call:(op,input)=>services.call(op,input),
  spec:(presetId='landscape_720',expectedRevision=0,extra={})=>({projectId:project.id,expectedProjectRevision:project.revision,expectedRevision,requestId:randomUUID(),presetId,...extra}),
  asset(){const id=randomUUID();return store.put('assets',{id,projectId:project.id,name:'Fixture',mimeType:'image/png',width:720,height:1280,sha256:'a'.repeat(64),relativePath:`media/${id}.png`});},
  capture(){return Object.fromEntries(['projects','timelines','timeline_requests','timeline_format_requests','timeline_history','timeline_history_cursors','exports','edit_tasks'].map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));},
  restart(){store.close();store=openStore(root);services=createServices(store,new Map());}
 };t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return f;
}
async function rejected(f,input,code){const before=f.capture();await assert.rejects(f.call('timeline.format.set',input),error=>error.code===code&&(['REVISION_CONFLICT','TIMELINE_FORMAT_LOCKED','TIMELINE_FORMAT_UNCHANGED'].includes(code)?hasRequestNotAppliedProof(error,input,{operation:'timeline.format.set'}):true));assert.deepEqual(f.capture(),before);}
async function addClip(f,timeline){return f.call('timeline.clip.add',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:f.asset().id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:30});}

test('format read is genuinely noncreating and absence creates exactly revision one without modifying project bytes',async t=>{
 const f=await fixture(t),before=f.capture();
 const read=await f.call('timeline.format.get',{projectId:f.project.id});
 assert.deepEqual(read,{projectId:f.project.id,projectRevision:1,timelineId:null,timelineRevision:0,presetId:'portrait_1080',fps:30,width:1080,height:1920,eligible:true,blockedReasons:[]});assert.deepEqual(f.capture(),before);
 const input=f.spec(),timeline=await f.call('timeline.format.set',input);
 assert.equal(timeline.revision,1);assert.equal(timeline.width,1280);assert.equal(timeline.height,720);assert.equal(timeline.tracks.length,3);
 assert.deepEqual(f.capture().projects,before.projects);assert.deepEqual(f.capture().timeline_history,[]);assert.deepEqual(f.capture().timeline_history_cursors,[]);
 assert.equal(f.capture().timeline_requests.length,1);assert.equal(f.capture().timeline_format_requests.length,1);
 f.restart();assert.deepEqual(await f.call('timeline.format.set',input),timeline);
});
test('default timeline lazy creation keeps the serialized shape with current 1080 dimensions',async t=>{
 const f=await fixture(t),timeline=await f.call('timeline.get',{projectId:f.project.id});
 assert.deepEqual(Object.keys(timeline),['id','projectId','revision','fps','width','height','tracks','clips','durationFrames','createdAt','updatedAt']);
 assert.equal(timeline.width,1080);assert.equal(timeline.height,1920);assert.equal(timeline.revision,1);
 assert.equal(f.capture().timeline_format_requests.length,0);assert.equal((await f.call('timeline.format.get',{projectId:f.project.id})).eligible,true);
 await rejected(f,f.spec('portrait_1080',1),'TIMELINE_FORMAT_UNCHANGED');
 const changed=await f.call('timeline.format.set',f.spec('square_720',1));assert.equal(changed.revision,2);assert.equal(changed.id,timeline.id);assert.deepEqual(changed.tracks,timeline.tracks);
});
test('both revision fences are atomic and unchanged format writes no receipt',async t=>{
 const f=await fixture(t);
 await rejected(f,f.spec('landscape_720',1),'REVISION_CONFLICT');await rejected(f,f.spec('landscape_720',0,{expectedProjectRevision:2}),'REVISION_CONFLICT');
 const created=await f.call('timeline.format.set',f.spec('portrait_720'));assert.equal(created.revision,1);
 await rejected(f,f.spec('portrait_720',1),'TIMELINE_FORMAT_UNCHANGED');await rejected(f,f.spec('square_720',0),'REVISION_CONFLICT');
 await f.call('shot.create',{projectId:f.project.id,title:'Revision fence'});
 await rejected(f,f.spec('square_720',1),'REVISION_CONFLICT');
 const changed=await f.call('timeline.format.set',f.spec('square_720',1,{expectedProjectRevision:2}));assert.equal(changed.revision,2);
});
test('repeated pristine changes retain exact old acknowledgements after editing and project revision drift',async t=>{
 const f=await fixture(t),first=f.spec('portrait_720'),portrait=await f.call('timeline.format.set',first);
 const second=f.spec('landscape_720',1),wide=await f.call('timeline.format.set',second);
 const square=await f.call('timeline.format.set',f.spec('square_720',2));assert.equal(square.revision,3);
 const added=await addClip(f,square);await f.call('shot.create',{projectId:f.project.id,title:'Later'});const before=f.capture();
 for(const [input,value] of [[first,portrait],[second,wide]])assert.deepEqual(await f.call('timeline.format.set',input),value);
 assert.deepEqual(f.capture(),before);assert.equal(added.clips[0].rect.width,720);assert.equal(added.clips[0].rect.height,720);
 await rejected(f,{...first,presetId:'square_720'},'IDEMPOTENCY_CONFLICT');
});
test('history including redo at cursor zero and an isolated cursor row blocks format changes',async t=>{
 const f=await fixture(t),empty=await f.call('timeline.format.set',f.spec()),added=await addClip(f,empty);
 assert.deepEqual((await f.call('timeline.format.get',{projectId:f.project.id})).blockedReasons,['CLIPS_PRESENT','HISTORY_PRESENT','REQUEST_HISTORY']);
 const undone=await f.call('timeline.undo',{projectId:f.project.id,expectedRevision:added.revision,requestId:randomUUID()});assert.equal(undone.clips.length,0);
 assert.deepEqual((await f.call('timeline.format.get',{projectId:f.project.id})).blockedReasons,['HISTORY_PRESENT','REQUEST_HISTORY']);
 await rejected(f,f.spec('square_720',undone.revision),'TIMELINE_FORMAT_LOCKED');
 const g=await fixture(t),timeline=await g.call('timeline.get',{projectId:g.project.id});g.store.db.prepare('INSERT INTO timeline_history_cursors VALUES(?,0)').run(g.project.id);
 assert.deepEqual((await g.call('timeline.format.get',{projectId:g.project.id})).blockedReasons,['HISTORY_PRESENT']);await rejected(g,g.spec('square_720',timeline.revision),'TIMELINE_FORMAT_LOCKED');
});
test('every supported format initializes clip rectangles against its own output pair',async t=>{
 for(const preset of TIMELINE_OUTPUT_PRESETS){const f=await fixture(t),timeline=await f.call('timeline.format.set',f.spec(preset.id)),added=await addClip(f,timeline);
  assert.deepEqual(added.clips[0].rect,{x:0,y:0,width:preset.width,height:preset.height});
  const invalid={projectId:f.project.id,expectedRevision:added.revision,requestId:randomUUID(),clipId:added.clips[0].id,patch:{rect:{x:2,y:0,width:preset.width,height:preset.height}}};const before=f.capture();
  await assert.rejects(f.call('timeline.clip.update',invalid));assert.deepEqual(f.capture(),before);
  const inspected=await f.call('timeline.inspect',{projectId:f.project.id});assert.equal(inspected.width,preset.width);assert.equal(inspected.height,preset.height);
 }
});
test('submitted rectangles retain VALIDATION_ERROR against all six saved pairs without database writes or proof',async t=>{
 for(const preset of TIMELINE_OUTPUT_PRESETS){
  const f=await fixture(t),timeline=await f.call('timeline.format.set',f.spec(preset.id)),asset=f.asset();
  const overflow=preset.width>preset.height?{x:0,y:preset.height-98,width:100,height:100}:{x:preset.width-98,y:0,width:100,height:100};
  const base={projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:30};
  async function fails(operation,input,path){
   const before=f.capture(),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
   await assert.rejects(f.call(operation,input),error=>{
    assert.equal(error.code,'VALIDATION_ERROR');assert.equal(error.status,400);assert.equal(error.message,'输入字段无效');
    assert.deepEqual(error.details.issues,[{path,message:`Rectangle must stay inside the ${preset.width}×${preset.height} output`}]);
    assert.equal(error.details.mutationOutcome,undefined);return true;
   });
   assert.deepEqual(f.capture(),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  }
  await fails('timeline.clip.add',{...base,rect:overflow},['rect']);
  const added=await f.call('timeline.clip.add',{...base,rect:{x:preset.width-100,y:preset.height-100,width:100,height:100}});
  await fails('timeline.clip.update',{projectId:f.project.id,expectedRevision:added.revision,requestId:randomUUID(),clipId:added.clips[0].id,patch:{rect:overflow}},['patch','rect']);
  // Persisted bad geometry remains aggregate corruption, not a caller error.
  f.store.put('timelines',{...added,clips:[{...added.clips[0],rect:overflow}]});
  const before=f.capture(),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(f.call('timeline.clip.update',{projectId:f.project.id,expectedRevision:added.revision,requestId:randomUUID(),clipId:added.clips[0].id,patch:{name:'No repair'}}),{code:'INVALID_TIMELINE_SNAPSHOT'});
  assert.deepEqual(f.capture(),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
 }
 const f=await fixture(t),asset=f.asset(),before=f.capture(),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
 await assert.rejects(f.call('timeline.clip.add',{projectId:f.project.id,expectedRevision:1,requestId:randomUUID(),assetId:asset.id,trackId:randomUUID(),startFrame:0,durationFrames:30,rect:{x:982,y:0,width:100,height:100}}),error=>error.code==='VALIDATION_ERROR'&&error.details.mutationOutcome===undefined);
 assert.deepEqual(f.capture(),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);assert.equal(f.store.list('timelines').length,0);
});

test('seed uses each saved output pair without changing shot generation aspect ratios',async t=>{
 for(const preset of TIMELINE_OUTPUT_PRESETS){const f=await fixture(t);let timeline=await f.call('timeline.format.set',f.spec(preset.id));
  const asset=f.asset();f.store.put('assets',{...asset,mimeType:'video/mp4',duration:1});
  const shot=await f.call('shot.create',{projectId:f.project.id,title:'Seed fixture'}),jobId=randomUUID(),versionId=randomUUID();
  f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:shot.id,status:'succeeded',providerId:'mock',requestId:randomUUID(),submissionCount:1,versionId});
  f.store.put('versions',{id:versionId,projectId:f.project.id,shotId:shot.id,jobId,assetId:asset.id,sha256:asset.sha256,number:1});
  const selected=await f.call('version.select',{shotId:shot.id,versionId,expectedRevision:shot.revision});
  timeline=await f.call('timeline.seed',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID()});
  assert.deepEqual(timeline.clips[0].rect,{x:0,y:0,width:preset.width,height:preset.height});assert.equal(selected.aspectRatio,'9:16');
 }
});

test('non-format receipts and all frozen timeline export statuses block even after a timeline is empty',async t=>{
 const f=await fixture(t),timeline=await f.call('timeline.format.set',f.spec()),added=await addClip(f,timeline);
 const acknowledgement=await f.call('timeline.render',{projectId:f.project.id,expectedRevision:added.revision,requestId:randomUUID(),purpose:'preview'});
 const rendered=f.store.get('exports',acknowledgement.id);
 const cleared={...added,revision:added.revision+1,clips:[],durationFrames:0};f.store.put('timelines',cleared);
 // Simulate a legacy project with no editable journal; immutable prior requests
 // and frozen exports independently remain authoritative lock evidence.
 f.store.db.prepare('DELETE FROM timeline_history WHERE projectId=?').run(f.project.id);f.store.db.prepare('DELETE FROM timeline_history_cursors WHERE projectId=?').run(f.project.id);
 const output=f.asset();
 for(const status of ['queued','running','failed','succeeded']){f.store.put('exports',{...rendered,status,assetId:status==='succeeded'?output.id:null,url:status==='succeeded'?`/media/${output.id}`:null,error:status==='failed'?{code:'RENDER_FAILED',message:'Fixture failure'}:null});
  assert.deepEqual((await f.call('timeline.format.get',{projectId:f.project.id})).blockedReasons,['REQUEST_HISTORY','EXPORT_HISTORY']);await rejected(f,f.spec('square_720',cleared.revision),'TIMELINE_FORMAT_LOCKED');}
});
test('corrupt aggregates, history, receipts and provenance fail closed rather than fabricate eligibility',async t=>{
 for(const tamper of [
  f=>f.store.db.prepare('UPDATE timelines SET data=? WHERE projectId=?').run('{',f.project.id),
  f=>f.store.db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(randomUUID(),'a'.repeat(64),'{'),
  f=>f.store.db.prepare('INSERT INTO timeline_history_cursors VALUES(?,1)').run(f.project.id),
  f=>{f.store.db.exec('DROP TRIGGER immutable_timeline_format_requests');f.store.db.prepare('UPDATE timeline_format_requests SET input=? WHERE projectId=?').run(JSON.stringify(f.spec('square_720')),f.project.id);},
 ]){const f=await fixture(t);await f.call('timeline.format.set',f.spec());
  if(tamper.toString().includes('UPDATE timeline_format_requests')){f.store.db.exec('PRAGMA ignore_check_constraints=ON');}
  tamper(f);const before=f.capture();await assert.rejects(f.call('timeline.format.get',{projectId:f.project.id}),error=>['INVALID_TIMELINE_SNAPSHOT','TIMELINE_SOURCE_UNAVAILABLE'].includes(error.code));assert.deepEqual(f.capture(),before);
 }
});
