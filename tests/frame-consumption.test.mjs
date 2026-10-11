import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {startWorker} from '../packages/business/src/jobs.mjs';
import {run,runStreaming} from '../packages/business/src/media-runtime.mjs';
import {fileHash,probe} from '../packages/business/src/media.mjs';
import {validatePng} from '../packages/business/src/images/png.mjs';
import {isFrameTaskResponse,isFrameMutationResponse,isReferenceMutationResponse,isSubjectMutationResponse,isTimelineMutationResponse,schemas} from '@mioon/contracts';

// Local acceptance, not a mocked decoder/renderer. Every media input is a tiny
// one-second lavfi fixture; provider registries are empty and fetch is forbidden.
const timeout=120000,sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const row=(db,table,id)=>({...db.prepare(`SELECT rowid AS savedRowid,* FROM ${table} WHERE id=?`).get(id)});
const allRows=db=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const changes=db=>db.prepare('SELECT total_changes() AS n').get().n;
const insert=(db,table,value)=>{const keys=Object.keys(value);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value));};
const fixtureMedia=args=>run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-filter_threads','1','-filter_complex_threads','1',...args],{timeout:30000});
async function until(read,done,label){
 const end=Date.now()+45000;let value;
 while(Date.now()<end){value=await read();if(done(value))return value;if(['failed','interrupted','local_result_error'].includes(value?.state)||value?.status==='failed')assert.fail(`${label}: ${JSON.stringify(value)}`);await pause(10);}
 assert.fail(`${label} did not finish: ${JSON.stringify(value)}`);
}
async function centerPixel(file,x,y){
 const chunks=[];await runStreaming('ffmpeg',['-v','error','-nostdin','-i',file,'-vf',`crop=2:2:${x}:${y},format=rgb24`,'-frames:v','1','-threads','1','-f','rawvideo','pipe:1'],{timeout:30000,maxStdoutBytes:12,onStdout:chunk=>{chunks.push(Buffer.from(chunk));}});
 const pixels=Buffer.concat(chunks);assert.equal(pixels.length,12);return [...pixels.subarray(0,3)];
}
function nearColor(actual,expected){assert.ok(expected.every((value,index)=>Math.abs(actual[index]-value)<25),`expected ${expected}, received ${actual}`);}
async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-frame-consumption-'))),providers=new Map(),f={root,providers};
 t.mock.method(globalThis,'fetch',()=>{assert.fail('Frame consumption must not use network/provider/model calls');});
 t.after(async()=>{try{await f.worker?.stop();await f.services?.drain();}finally{f.store?.close();await rm(root,{recursive:true,force:true});}});
 const original=path.join(root,'synthetic-original.mp4');
 await fixtureMedia(['-f','lavfi','-i','color=c=red:s=64x48:r=30:d=1','-vf',"drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,0.5)',setsar=1",'-an','-c:v','libx264','-preset','ultrafast','-crf','12','-bf','0','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',original]);
 f.store=openStore(root);f.services=createServices(f.store,providers);f.call=(operation,input)=>f.services.call(operation,input);
 f.project=await f.call('project.create',{name:'Real extracted-frame consumers'});f.other=await f.call('project.create',{name:'Foreign synthetic owner'});
 const bytes=await readFile(original),imported=await f.call('asset.import',{projectId:f.project.id,name:'One-second synthetic.mp4',mimeType:'video/mp4',dataBase64:bytes.toString('base64')});
 f.source=f.store.get('assets',imported.id);f.sourceFile=path.join(root,f.source.relativePath);f.sourceBytes=bytes;
 assert.equal(f.source.sha256,sha(bytes));assert.deepEqual([f.source.width,f.source.height],[64,48]);assert.ok(Math.abs(f.source.duration-1)<0.04);
 f.extract=async sourceFrame=>{
  const input={projectId:f.project.id,sourceAssetId:f.source.id,sourceHash:f.source.sha256,sourceFrame,requestId:randomUUID()},ack=await f.call('frame.extract',input);
  assert.equal(isFrameMutationResponse('frame.extract',input,ack),true);
  const task=await until(()=>f.call('frame.task.get',{projectId:f.project.id,taskId:ack.id}),value=>value.state==='succeeded','real frame extraction');
  assert.equal(isFrameTaskResponse(task),true);const asset=f.store.get('assets',task.result.assetId),file=path.join(root,asset.relativePath),png=await readFile(file);
  assert.equal(asset.provenance,'extracted-frame');assert.equal(asset.mimeType,'image/png');assert.equal(asset.relativePath,`media/${asset.id}.png`);
  assert.deepEqual(await validatePng(png,{width:64,height:48,opaque:true}),{mimeType:'image/png',width:64,height:48,byteLength:png.length,sha256:sha(png)});
  assert.equal(asset.sha256,sha(png));return {input,ack,task,asset,file,png};
 };
 f.timelineInput=(timeline,extra={})=>({projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...extra});
 f.nodeInput=asset=>({projectId:f.project.id,type:'image',assetId:asset.id,label:'Captured frame',position:{x:40,y:40},requestId:randomUUID()});
 f.subjectInput=asset=>({projectId:f.project.id,kind:'product',name:'Captured product',assetId:asset.id,requestId:randomUUID()});
 f.bindInput=(subject,shot)=>({projectId:f.project.id,subjectId:subject.id,shotId:shot.id,role:'subject',subjectVersionId:subject.headVersionId,expectedRevision:0,expectedSubjectRevision:subject.revision,requestId:randomUUID()});
 f.render=async timeline=>{
  const input=f.timelineInput(timeline,{purpose:'export'}),ack=await f.call('timeline.render',input);assert.equal(isTimelineMutationResponse('timeline.render',input,ack),true);
  f.worker??=startWorker(f.store,f.services,providers);await f.worker.tick();
  const result=await until(()=>f.call('export.get',{exportId:ack.id}),value=>value.status==='succeeded','real timeline render'),asset=f.store.get('assets',result.assetId),file=path.join(root,asset.relativePath);
  const metadata=await probe(file),video=metadata.probe.streams.find(stream=>stream.codec_type==='video');
  assert.deepEqual([metadata.width,metadata.height],[720,1280]);assert.ok(Math.abs(metadata.duration-1)<0.04);assert.equal(Number(video.nb_frames),30);
  // Decode all video and audio to EOF with errors fatal; then count real decoded
  // video frames independently rather than trusting only container metadata.
  await run('ffmpeg',['-v','error','-xerror','-nostdin','-i',file,'-map','0:v:0','-map','0:a:0?','-f','null','-'],{timeout:45000});
  const frames=await run('ffmpeg',['-v','error','-xerror','-nostdin','-i',file,'-map','0:v:0','-an','-f','framemd5','-'],{timeout:45000});
  assert.equal(frames.split('\n').filter(line=>line&&!line.startsWith('#')).length,30);
  return {input,ack,result,asset,file,sha256:await fileHash(file)};
 };
 return f;
}
async function preparedConsumers(f,frame){
 const projectId=f.project.id,nodeInput=f.nodeInput(frame.asset),node=await f.call('node.create',nodeInput),shot=await f.call('shot.create',{projectId,title:'First-frame consumer',requestId:randomUUID()});
 const attachInput={projectId,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:node.revision,expectedShotRevision:shot.revision,role:'first_frame',requestId:randomUUID()};
 const subjectInput=f.subjectInput(frame.asset),subject=await f.call('subject.create',subjectInput);
 let timeline=await f.call('timeline.get',{projectId});const clipInput=f.timelineInput(timeline,{trackId:timeline.tracks[0].id,assetId:frame.asset.id,startFrame:0,durationFrames:30});
 timeline=await f.call('timeline.clip.add',clipInput);
 return {nodeInput,node,shot,attachInput,subjectInput,subject,timeline,clipInput};
}
async function assertConsumerRejections(f,frame,prepared){
 const {node,shot,attachInput,subject,timeline}=prepared,projectId=f.project.id;
 const attempts=[
  ['node.create',f.nodeInput(frame.asset),'IMAGE_SOURCE_INVALID'],
  ['node.update',{nodeId:node.id,expectedRevision:node.revision,patch:{label:'Must not write'},requestId:randomUUID()},'IMAGE_SOURCE_INVALID'],
  ['shot.create',{projectId,title:'Must not write',referenceAssetIds:[frame.asset.id],requestId:randomUUID()},'IMAGE_SOURCE_INVALID'],
  ['reference.attach',attachInput,'INVALID_REFERENCE_RECORD'],
  ['subject.create',f.subjectInput(frame.asset),'INVALID_SUBJECT_RECORD'],
  ['subject.version.add',{projectId,subjectId:subject.id,expectedRevision:subject.revision,assetId:frame.asset.id,requestId:randomUUID()},'INVALID_SUBJECT_RECORD'],
  ['subject.binding.set',f.bindInput(subject,shot),'INVALID_SUBJECT_RECORD'],
  ['timeline.clip.add',f.timelineInput(timeline,{trackId:timeline.tracks[1].id,assetId:frame.asset.id,startFrame:0,durationFrames:30}),'TIMELINE_SOURCE_UNAVAILABLE'],
  ['timeline.render',f.timelineInput(timeline,{purpose:'export'}),'TIMELINE_SOURCE_UNAVAILABLE'],
  ['asset.inspect',{projectId},'INSPECTION_UNAVAILABLE'],
 ];
 const before=allRows(f.store.db),count=changes(f.store.db),sourceHash=await fileHash(f.sourceFile),frameHash=await fileHash(frame.file);
 for(const [operation,input,code] of attempts){
  assert.equal(schemas[operation].safeParse(input).success,true,`${operation} uses the actual strict input schema`);
  await assert.rejects(f.call(operation,input),error=>{
   assert.equal(error.code,code,operation);assert.ok([404,409].includes(error.status));
   assert.doesNotMatch(JSON.stringify(error),/PRIVATE_FRAME_SENTINEL|frame-staging|synthetic-original|sourceHash|stagedReceipt|canonicalInput/);
   assert.equal(error.details?.mutationOutcome,undefined,'corruption does not prove a fresh business rejection');return true;
  });
  assert.equal(changes(f.store.db),count,`${operation} must reject before writes, including rolled-back writes`);
  assert.deepEqual(allRows(f.store.db),before,`${operation} must preserve all rows`);
 }
 assert.equal(await fileHash(f.sourceFile),sourceHash);assert.equal(await fileHash(frame.file),frameHash);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM exports').get().n,0);
}

test('real extraction reaches first-frame reference, frozen subject versions and full timeline export while old bytes survive',{timeout},async t=>{
 const f=await fixture(t),projectId=f.project.id,db=f.store.db;
 // Frozen legacy records are seeded without any provider. Their SQL and JSON
 // bytes must survive extraction and subsequent consumer writes unchanged.
 const oldShot=await f.call('shot.create',{projectId,title:'Retained original shot',requestId:randomUUID()}),jobId=randomUUID(),versionId=randomUUID();
 const job={id:jobId,projectId,shotId:oldShot.id,assetId:f.source.id,versionId,status:'succeeded',createdAt:oldShot.createdAt};
 const version={id:versionId,projectId,shotId:oldShot.id,jobId,assetId:f.source.id,sha256:f.source.sha256,number:1,createdAt:oldShot.createdAt};
 insert(db,'jobs',{id:jobId,projectId,data:JSON.stringify(job,null,1)});insert(db,'versions',{id:versionId,projectId,jobId,data:JSON.stringify(version,null,1)});
 const oldRows=[['assets',f.source.id],['shots',oldShot.id],['jobs',jobId],['versions',versionId]].map(([table,id])=>({table,id,value:row(db,table,id)}));
 let timeline=await f.call('timeline.get',{projectId});const originalClipInput=f.timelineInput(timeline,{trackId:timeline.tracks[0].id,assetId:f.source.id,startFrame:0,durationFrames:30});
 timeline=await f.call('timeline.clip.add',originalClipInput);const oldTimeline=structuredClone(timeline),oldExport=await f.render(timeline),oldExportRow=row(db,'exports',oldExport.result.id);
 const oldHistory=db.prepare('SELECT * FROM timeline_history WHERE projectId=? ORDER BY position').all(projectId);
 const oldReceipts=db.prepare('SELECT * FROM timeline_requests ORDER BY rowid').all();
 const first=await f.extract(0),second=await f.extract(15);assert.notEqual(first.asset.id,second.asset.id);assert.notEqual(first.asset.sha256,second.asset.sha256);
 nearColor(await centerPixel(first.file,32,24),[255,0,0]);nearColor(await centerPixel(second.file,32,24),[0,0,255]);
 const node=await f.call('node.create',f.nodeInput(second.asset)),shot=await f.call('shot.create',{projectId,title:'Captured first frame',requestId:randomUUID()});
 const attachInput={projectId,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:node.revision,expectedShotRevision:shot.revision,role:'first_frame',requestId:randomUUID()},attached=await f.call('reference.attach',attachInput);
 assert.equal(isReferenceMutationResponse('reference.attach',attachInput,attached),true);assert.deepEqual(attached.shot.referenceAssetIds,[second.asset.id]);assert.equal(attached.edge.sourceAssetId,second.asset.id);
 const subjectInput=f.subjectInput(first.asset),subject=await f.call('subject.create',subjectInput),versionRow=row(db,'subject_versions',subject.headVersionId);
 assert.equal(isSubjectMutationResponse('subject.create',subjectInput,subject),true);assert.equal(subject.headVersion.provenance.frameSource.frameTaskId,first.task.id);
 const bindInput=f.bindInput(subject,attached.shot),binding=await f.call('subject.binding.set',bindInput);
 assert.equal(isSubjectMutationResponse('subject.binding.set',bindInput,binding),true);
 const addInput={projectId,subjectId:subject.id,expectedRevision:subject.revision,assetId:second.asset.id,requestId:randomUUID()},updated=await f.call('subject.version.add',addInput);
 assert.equal(isSubjectMutationResponse('subject.version.add',addInput,updated),true);assert.equal(updated.headVersion.provenance.frameSource.frameTaskId,second.task.id);
 assert.deepEqual([updated.headVersion.provenance.versionId,updated.headVersion.provenance.shotId,updated.headVersion.provenance.jobId],[null,null,null]);
 const retainedBinding=(await f.call('subject.binding.list',{projectId,subjectId:subject.id})).items[0];assert.equal(retainedBinding.subjectVersionId,subject.headVersionId);assert.equal(retainedBinding.needsReview,true);
 assert.deepEqual(row(db,'subject_versions',subject.headVersionId),versionRow);
 timeline=await f.call('timeline.clip.remove',f.timelineInput(timeline,{clipId:timeline.clips[0].id}));
 const frameClipInput=f.timelineInput(timeline,{trackId:timeline.tracks[0].id,assetId:second.asset.id,startFrame:0,durationFrames:30});timeline=await f.call('timeline.clip.add',frameClipInput);
 assert.equal(isTimelineMutationResponse('timeline.clip.add',frameClipInput,timeline),true);assert.equal(timeline.clips[0].sourceInFrame,0);
 const exported=await f.render(timeline);nearColor(await centerPixel(exported.file,360,640),[0,0,255]);
 assert.equal(exported.result.snapshot.assets[0].sha256,second.asset.sha256);assert.equal(exported.result.snapshot.assets[0].mimeType,'image/png');
 for(const {table,id,value} of oldRows)assert.deepEqual(row(db,table,id),value,`${table} original row bytes`);
 assert.deepEqual(row(db,'exports',oldExport.result.id),oldExportRow);assert.deepEqual(f.store.get('exports',oldExport.result.id).snapshot.timeline,oldTimeline);
 assert.deepEqual(db.prepare('SELECT * FROM timeline_history WHERE projectId=? ORDER BY position LIMIT ?').all(projectId,oldHistory.length),oldHistory);
 for(const receipt of oldReceipts)assert.deepEqual(db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(receipt.requestId),receipt);
 assert.equal(await fileHash(oldExport.file),oldExport.sha256);assert.deepEqual(await readFile(f.sourceFile),f.sourceBytes);assert.equal(await fileHash(f.sourceFile),f.source.sha256);
 assert.equal(await fileHash(first.file),first.asset.sha256);assert.equal(await fileHash(second.file),second.asset.sha256);
 const before=allRows(db),count=changes(db);
 assert.deepEqual(await f.call('frame.extract',first.input),first.ack);assert.deepEqual(await f.call('timeline.render',oldExport.input),oldExport.ack);assert.deepEqual(await f.call('reference.attach',attachInput),attached);
 assert.deepEqual(await f.call('subject.create',subjectInput),subject);assert.deepEqual(await f.call('subject.version.add',addInput),updated);
 assert.equal(changes(db),count);assert.deepEqual(allRows(db),before);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM versions').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_tasks').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exports').get().n,2);assert.equal(f.providers.size,0);
});

for(const corruption of ['malformed original ACK','hidden mixed legacy owner','reassigned frame owner'])test(`all explicit consumers reject ${corruption} before any write`,{timeout},async t=>{
 const f=await fixture(t),frame=await f.extract(15),prepared=await preparedConsumers(f,frame),db=f.store.db;
 if(corruption==='malformed original ACK'){
  db.exec('DROP TRIGGER immutable_frame_requests');const saved=db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(frame.input.requestId);
  db.prepare('UPDATE frame_requests SET response=? WHERE requestId=?').run(JSON.stringify({...JSON.parse(saved.response),private:'PRIVATE_FRAME_SENTINEL'}),frame.input.requestId);
 }else if(corruption==='hidden mixed legacy owner'){
  db.exec('DROP TRIGGER reject_legacy_frame_asset_owner');const projectId=f.other.id,shotId=randomUUID(),jobId=randomUUID(),versionId=randomUUID();
  insert(db,'shots',{id:shotId,projectId,data:JSON.stringify({id:shotId,projectId,referenceAssetIds:[],private:'PRIVATE_FRAME_SENTINEL'})});
  insert(db,'jobs',{id:jobId,projectId,data:JSON.stringify({id:jobId,projectId,shotId,versionId,assetId:frame.asset.id,status:'succeeded'})});
  insert(db,'versions',{id:versionId,projectId,jobId,data:JSON.stringify({id:versionId,projectId,jobId,shotId,assetId:frame.asset.id})});
  db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...frame.asset,provenance:'user-import'}),frame.asset.id);
 }else{
  db.exec('PRAGMA foreign_keys=OFF;PRAGMA ignore_check_constraints=ON;DROP TRIGGER immutable_frame_task_identity;DROP TRIGGER frame_task_state_transitions');
  db.prepare('UPDATE frame_tasks SET projectId=? WHERE id=?').run(f.other.id,frame.task.id);
 }
 await assertConsumerRejections(f,frame,prepared);
});
