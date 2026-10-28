import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {setAgentTaskEffectGate} from '../packages/business/src/agent/task-effects-v2.ts';
import {readAgentTaskChecks} from '../packages/business/src/agent/task-checks-v2.ts';
import type {AgentTaskChecksPreflight} from '../packages/business/src/agent/task-checks-v2.ts';
import type {AgentTaskJson,AgentTaskCheck} from '../packages/contracts/src/agent-tasks-v2.ts';
import {agentTaskChecksSchema} from '../packages/contracts/src/agent-task-checks-v2.ts';
import {isTimelineRenderRecord} from '../packages/contracts/src/index.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
function item(value:Awaited<ReturnType<typeof readAgentTaskChecks>>,type:AgentTaskCheck['type'],id?:string):AgentTaskCheck {
 const found=value.groups.flatMap(group=>group.items).find(check=>check.type===type&&(id===undefined||check.target.id===id));assert.ok(found,`${type} exists`);return found;
}
async function fixture(t:TestContext,{imageAutoRun=false}:{imageAutoRun?:boolean}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-task-checks-')),store=openStore(root),services=createServices(store,new Map(),{imageOptions:{autoRun:imageAutoRun},frameOptions:{autoRun:false},sceneOptions:{autoRun:false}}),removeGate=setAgentTaskEffectGate(store.db,()=>{});
 const project=object(await services.call('project.create',{name:'Checks project'})),projectId=String(project.id),journal=createAgentTaskJournal(store),tools=createAgentTaskTools({store,services});
 const snapshot=journal.create({projectId,requestId:randomUUID(),text:'Checks only',configuration:{}}),runId=snapshot.run.id;
 const source=(name='Source.mp4',bytes:Buffer=Buffer.from('SYNTHETIC_MANAGED_SOURCE'),mimeType='video/mp4')=>{
  const id=randomUUID(),relativePath=`media/${id}.${mimeType==='image/png'?'png':'mp4'}`;writeFileSync(join(root,relativePath),bytes,{mode:0o600});
  return store.put('assets',{id,projectId,name,mimeType,relativePath,sizeBytes:bytes.length,sha256:sha(bytes),width:64,height:64,duration:2,provenance:'user-import',createdAt:new Date().toISOString(),url:`/media/${id}`});
 };
 const step=(name:string,args:AgentTaskJson={},result?:AgentTaskJson,status:'completed'|'failed'|'unknown'|'awaiting_approval'='completed')=>{
  const value=journal.beginStep(runId,{kind:'tool',toolCall:{id:randomUUID(),name,arguments:args}});if(status==='unknown')journal.markDispatch(runId,value.id);journal.updateStep(runId,value.id,{status,...(result===undefined?{}:{result})});return journal.step(value.id);
 };
 const tool=async(name:string,args:AgentTaskJson={})=>{
  const value=journal.beginStep(runId,{kind:'tool',toolCall:{id:randomUUID(),name,arguments:args}}),prepared=tools.prepare({projectId,operation:name,input:args});journal.markDispatch(runId,value.id);
  const outcome=await tools.execute(prepared,{runId,stepId:value.id,requestId:value.id,beforeEffect:()=>{},recordInside:(result,changes)=>{journal.completeStepInside(runId,value.id,{result,changes});},appendChangesInside:changes=>{journal.appendChangesInside(runId,value.id,changes);}});
  if(journal.step(value.id).status!=='completed')journal.completeStep(runId,value.id,{result:outcome.result,changes:outcome.changes});return journal.step(value.id);
 };
 const origin=(kind:string,id:string,stepId:string,operation:string)=>store.db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run(kind,id,runId,stepId,projectId,stepId,operation);
 const snapshotNow=()=>journal.snapshot(runId);
 const read=(preflight?:AgentTaskChecksPreflight,options:{includePreflight?:boolean}={})=>readAgentTaskChecks(store,snapshotNow(),{preflight,...options});
 t.after(async()=>{await services.drain();removeGate();tools.dispose();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,services,journal,tools,projectId,runId,source,step,tool,origin,snapshotNow,read};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function timeline(f:Fixture){
 const source=f.source('Still.png',png({width:64,height:64}),'image/png');
 let saved=object(await f.services.call('timeline.get',{projectId:f.projectId}));const tracks=saved.tracks;assert.ok(Array.isArray(tracks));
 const changed=await f.tool('mioon_timeline_clip_add',{expectedRevision:Number(saved.revision),assetId:source.id,trackId:String(object(tracks[0]).id),startFrame:0,durationFrames:30});
 saved=object(await f.services.call('timeline.get',{projectId:f.projectId}));return {saved,source,changed};
}
function ready(f:Fixture,saved:Record<string,unknown>){
 return {projectId:f.projectId,timelineId:saved.id,timelineRevision:saved.revision,expectedRevision:saved.revision,snapshotHash:'a'.repeat(64),checkedAt:new Date().toISOString(),status:'ready',
  summary:{fps:30,width:Number(saved.width),height:Number(saved.height),durationFrames:30,trackCount:(saved.tracks as unknown[]).length,clipCount:1,assetCount:1,visualClipCount:1,audibleClipCount:0,mutedTrackCount:0,hiddenVideoTrackCount:0},checks:{totalAssets:1,checkedAssets:1,bytesHashed:100,fullDecode:false},issues:[]};
}

test('empty checks have the four stable groups without creating a timeline or writing records',async t=>{
 const f=await fixture(t),before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n,first=await f.read();assert.equal(agentTaskChecksSchema.safeParse(first).success,true);
 assert.deepEqual(first.groups.map(group=>group.id),['export_render','generation','timeline','decomposition_frames']);assert.ok(first.groups.every(group=>group.items.every(check=>check.status==='not_applicable')));
 assert.deepEqual(await f.read(),first);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timelines WHERE projectId=?').get(f.projectId)!.n,0);
});

test('unaccepted failures, approval waits and unknown outcomes have typed step checks without raw errors',async t=>{
 const f=await fixture(t),failed=f.step('mioon_export_create',{},undefined,'failed'),unknown=f.step('mioon_generation_submit',{},undefined,'unknown'),waiting=f.step('mioon_frame_extract',{},undefined,'awaiting_approval');
 f.journal.updateStep(f.runId,failed.id,{error:{code:'PRIVATE_PROVIDER_ERROR',message:'/PRIVATE_PATH secret from provider'}});
 const checks=await f.read();assert.equal(item(checks,'export_status',failed.id).reason?.code,'TASK_FAILED');assert.equal(item(checks,'generation_status',unknown.id).reason?.code,'RESULT_UNKNOWN');assert.equal(item(checks,'frame_status',waiting.id).status,'pending');
 assert.doesNotMatch(JSON.stringify(checks),/PRIVATE_PATH|PRIVATE_PROVIDER_ERROR|secret from provider/);
});

test('render checks bind accepted parameters and output geometry to the original request',async t=>{
 const f=await fixture(t),setup=await timeline(f),render=await f.tool('mioon_timeline_render',{expectedRevision:Number(setup.saved.revision),purpose:'export'}),result=object(render.result),exportId=String(result.id);
 let checks=await f.read(async()=>ready(f,setup.saved));assert.equal(item(checks,'export_status',exportId).status,'pending');assert.equal(item(checks,'export_parameters',exportId).status,'pending');
 const bytes=Buffer.from('SYNTHETIC_EXPORT_BYTES'),assetId=randomUUID(),relativePath=`media/export-${exportId}-${randomUUID()}.mp4`;writeFileSync(join(f.root,relativePath),bytes,{mode:0o600});
 f.store.put('assets',{id:assetId,projectId:f.projectId,name:'/PRIVATE/export.mp4',mimeType:'video/mp4',relativePath,sizeBytes:bytes.length,sha256:sha(bytes),width:setup.saved.width,height:setup.saved.height,duration:1,provenance:'export',createdAt:new Date().toISOString(),url:`/media/${assetId}`});
 const current=object(f.store.get('exports',exportId));f.store.put('exports',{...current,status:'succeeded',assetId,url:`/media/${assetId}`,updatedAt:new Date().toISOString()});
 checks=await f.read(async()=>ready(f,setup.saved));assert.equal(item(checks,'export_status',exportId).status,'passed');assert.equal(item(checks,'export_artifact',exportId).status,'passed');assert.equal(item(checks,'export_parameters',exportId).status,'passed');
 const output=object(f.store.get('assets',assetId));f.store.put('assets',{...output,width:2});checks=await f.read();assert.equal(item(checks,'export_parameters',exportId).reason?.code,'PARAMETERS_MISMATCH');assert.equal(item(checks,'export_parameters',exportId).expected?.width,setup.saved.width);assert.equal(item(checks,'export_parameters',exportId).current?.width,2);
 f.store.put('assets',output);const modified=f.snapshotNow();const savedStep=modified.steps.find(value=>value.id===render.id)!;assert.ok(savedStep.toolCall);savedStep.toolCall.arguments={expectedRevision:Number(setup.saved.revision)+1,purpose:'export'};
 assert.equal(item(await readAgentTaskChecks(f.store,modified),'export_parameters',exportId).reason?.code,'PARAMETERS_MISMATCH');
 assert.doesNotMatch(JSON.stringify(checks),/PRIVATE|relativePath|snapshot|prompt|configuration/);
 f.store.put('exports',{...object(f.store.get('exports',exportId)),name:'/PRIVATE/worker/output.mp4'});assert.equal(item(await f.read(),'export_status',exportId).target.name,undefined);assert.doesNotMatch(JSON.stringify(await f.read()),/PRIVATE\/worker/);
});

test('export existence rejects missing, swapped and symlinked managed files without changing the saved task',async t=>{
 const f=await fixture(t),setup=await timeline(f),render=await f.tool('mioon_timeline_render',{expectedRevision:Number(setup.saved.revision),purpose:'preview'}),exportId=String(object(render.result).id),assetId=randomUUID(),bytes=Buffer.from('SYNTHETIC_OUTPUT'),relativePath=`media/export-${exportId}-${randomUUID()}.mp4`;
 const output={id:assetId,projectId:f.projectId,name:'Output',mimeType:'video/mp4',relativePath,sizeBytes:bytes.length,sha256:sha(bytes),width:setup.saved.width,height:setup.saved.height,duration:1,provenance:'export',createdAt:new Date().toISOString()};f.store.put('assets',output);
 f.store.put('exports',{...object(f.store.get('exports',exportId)),status:'succeeded',assetId,url:`/media/${assetId}`,updatedAt:new Date().toISOString()});
 assert.equal(item(await f.read(),'export_artifact',exportId).status,'failed');writeFileSync(join(f.root,relativePath),bytes,{mode:0o600});assert.equal(item(await f.read(),'export_artifact',exportId).status,'passed');
 const outside=join(f.root,'outside.mp4');writeFileSync(outside,bytes,{mode:0o600});unlinkSync(join(f.root,relativePath));symlinkSync(outside,join(f.root,relativePath));const before=JSON.stringify(f.store.get('exports',exportId));assert.equal(item(await f.read(),'export_artifact',exportId).status,'failed');assert.equal(JSON.stringify(f.store.get('exports',exportId)),before);
 f.store.put('assets',{...output,relativePath:`media/export-${randomUUID()}-${randomUUID()}.mp4`});assert.equal(item(await f.read(),'export_artifact',exportId).status,'failed');
});

test('video generation observes current local progress, publication and cost without provider calls',async t=>{
 const f=await fixture(t),shot=object(await f.services.call('shot.create',{projectId:f.projectId,title:'Shot\nName',prompt:'PRIVATE_PROMPT'})),jobId=randomUUID(),versionId=randomUUID(),assetId=randomUUID();
 const step=f.step('mioon_generation_submit',{shotId:String(shot.id),expectedRevision:Number(shot.revision),providerId:'mock'},{id:jobId});f.origin('job',jobId,step.id,'generation.submit');
 const snapshot={...shot,projectId:f.projectId,shotId:shot.id,providerId:'mock',model:'mock-v1',referenceAssets:[]},createdAt=new Date().toISOString();
 const job={id:jobId,projectId:f.projectId,shotId:shot.id,requestId:step.id,status:'running',phase:'rendering',progress:62,providerId:'mock',model:'mock-v1',snapshot,revision:2,versionId:null,createdAt,updatedAt:createdAt};f.store.put('jobs',job);
 let checks=await f.read();assert.equal(item(checks,'generation_status',jobId).status,'pending');assert.equal(item(checks,'generation_status',jobId).progress,62);assert.equal(item(checks,'generation_status',jobId).target.name,'Shot Name');assert.equal(item(checks,'generation_publication',jobId).status,'pending');
 const bytes=Buffer.from('SYNTHETIC_GENERATED_VIDEO'),relativePath=`media/${assetId}.mp4`;writeFileSync(join(f.root,relativePath),bytes,{mode:0o600});
 f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Generated video',mimeType:'video/mp4',sha256:sha(bytes),sizeBytes:bytes.length,relativePath,width:64,height:64,duration:2,provenance:'generation',createdAt});
 f.store.put('versions',{id:versionId,projectId:f.projectId,shotId:shot.id,jobId,number:1,providerId:'mock',model:'mock-v1',isMock:true,snapshot,assetId,sha256:sha(bytes),url:`/media/${assetId}`,createdAt});f.store.put('jobs',{...job,status:'succeeded',progress:100,versionId});
 checks=await f.read();assert.equal(item(checks,'generation_status',jobId).status,'passed');assert.equal(item(checks,'generation_publication',jobId).status,'passed');assert.equal(item(checks,'generation_cost',jobId).status,'not_applicable');
 f.store.put('jobs',{...job,providerId:'runway',status:'submission_unknown'});f.journal.updateStep(f.runId,step.id,{cost:'unknown'});checks=await f.read();assert.equal(item(checks,'generation_status',jobId).reason?.code,'RESULT_UNKNOWN');assert.equal(item(checks,'generation_cost',jobId).reason?.code,'COST_UNKNOWN');
 f.store.put('jobs',{...job,providerId:'runway'});f.journal.updateStep(f.runId,step.id,{cost:'submitted'});assert.equal(item(await f.read(),'generation_cost',jobId).reason?.code,'COST_SUBMITTED');
 f.store.put('jobs',{...job,providerId:'runway',status:'failed'});f.journal.updateStep(f.runId,step.id,{cost:'pending'});assert.equal(item(await f.read(),'generation_cost',jobId).status,'not_applicable');assert.doesNotMatch(JSON.stringify(checks),/PRIVATE_PROMPT|snapshot|providerJobId/);
});

test('an ACK cannot claim a foreign or unrelated task and legacy ACKs remain readable',async t=>{
 const f=await fixture(t),id=randomUUID(),step=f.step('mioon_generation_submit',{}, {id}),foreign=randomUUID(),base={id,projectId:foreign,requestId:step.id,status:'running',providerId:'mock'};f.store.put('projects',{id:foreign,name:'Foreign'});f.store.put('jobs',base);
 assert.equal(item(await f.read(),'generation_status',id).reason?.code,'RECORD_UNAVAILABLE');f.store.db.prepare('UPDATE jobs SET projectId=? WHERE id=?').run(f.projectId,id);f.store.put('jobs',{...base,projectId:f.projectId,requestId:randomUUID()});assert.equal(item(await f.read(),'generation_status',id).reason?.code,'RECORD_UNAVAILABLE');f.store.put('jobs',{...base,projectId:f.projectId});assert.equal(item(await f.read(),'generation_status',id).status,'pending');
});

test('image generation reads its saved local task and cancellation without starting the image worker',async t=>{
 const f=await fixture(t),step=await f.tool('mioon_image_generate',{name:'Synthetic image',prompt:'PRIVATE_PROMPT',providerId:'mock',model:'mock-image-v1',options:{size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1}}),id=String(object(step.result).id);
 const first=await f.read();assert.equal(item(first,'generation_status',id).status,'pending');assert.equal(item(first,'generation_cost',id).status,'not_applicable');
 const task=object(await f.services.call('image.task.get',{projectId:f.projectId,taskId:id}));await f.services.call('image.task.cancelQueued',{projectId:f.projectId,taskId:id,expectedRevision:task.revision,requestId:randomUUID()});
 assert.equal(item(await f.read(),'generation_status',id).reason?.code,'TASK_CANCELLED');assert.doesNotMatch(JSON.stringify(first),/PRIVATE_PROMPT|snapshot|relativePath/);
});

test('a completed mock image publishes an owned version and checks never restart generation',async t=>{
 const f=await fixture(t,{imageAutoRun:true}),step=await f.tool('mioon_image_generate',{name:'Synthetic image',prompt:'Synthetic fixture',providerId:'mock',model:'mock-image-v1',options:{size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1}}),id=String(object(step.result).id);
 let saved:Record<string,unknown>|undefined;
 for(let attempt=0;attempt<1000;attempt++){const current=object(await f.services.call('image.task.get',{projectId:f.projectId,taskId:id}));if(current.state==='succeeded'){saved=current;break;}await setImmediate();}
 assert.ok(saved,'The local mock worker completes without provider network');const before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n,checks=await f.read();assert.equal(item(checks,'generation_status',id).status,'passed');assert.equal(item(checks,'generation_publication',id).status,'passed');assert.equal(item(checks,'generation_publication',id).current?.versionId,saved.versionId);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
 const publication=item(checks,'generation_publication',id),assetId=publication.current?.assetId;assert.ok(assetId);const output=object(f.store.get('assets',assetId));unlinkSync(join(f.root,String(output.relativePath)));assert.equal(item(await f.read(),'generation_publication',id).status,'failed');assert.equal(object(await f.services.call('image.task.get',{projectId:f.projectId,taskId:id})).state,'succeeded');
});

test('frame and decomposition checks follow terminal local records without decoder or model work',async t=>{
 const f=await fixture(t),source=f.source(),frame=await f.tool('mioon_frame_extract',{sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:0}),frameId=String(object(frame.result).id);
 assert.equal(item(await f.read(),'frame_status',frameId).status,'pending');const saved=object(await f.services.call('frame.task.get',{projectId:f.projectId,taskId:frameId}));await f.services.call('frame.task.cancelQueued',{projectId:f.projectId,taskId:frameId,expectedRevision:saved.revision,requestId:randomUUID()});assert.equal(item(await f.read(),'frame_status',frameId).reason?.code,'TASK_CANCELLED');
 const scene=await f.tool('mioon_scene_detect',{sourceAssetId:source.id,sourceHash:source.sha256}),sceneId=String(object(scene.result).id);assert.equal(item(await f.read(),'decomposition_status',sceneId).status,'pending');const detection=object(await f.services.call('scene.task.get',{projectId:f.projectId,taskId:sceneId}));await f.services.call('scene.task.cancel',{projectId:f.projectId,taskId:sceneId,expectedRevision:detection.revision,requestId:randomUUID()});assert.equal(item(await f.read(),'decomposition_status',sceneId).reason?.code,'TASK_CANCELLED');
});

test('timeline references and the full preflight are distinct and refreshed after manual changes',async t=>{
 const f=await fixture(t),setup=await timeline(f),calls:Array<{projectId:string;expectedRevision:number}>=[],preflight:AgentTaskChecksPreflight=async input=>{calls.push(input);return ready(f,setup.saved);};
 let checks=await f.read(preflight,{includePreflight:true});assert.equal(item(checks,'timeline_references').status,'passed');assert.equal(item(checks,'timeline_preflight').status,'passed');assert.deepEqual(calls,[{projectId:f.projectId,expectedRevision:Number(setup.saved.revision)}]);
 const changed={...setup.saved,revision:Number(setup.saved.revision)+1,clips:(setup.saved.clips as unknown[]).map(clip=>({...object(clip),assetId:randomUUID()}))};f.store.db.prepare('UPDATE timelines SET data=? WHERE projectId=?').run(JSON.stringify(changed),f.projectId);
 checks=await f.read(async()=>({...ready(f,changed),status:'blocked',snapshotHash:null,summary:null,issues:[{code:'TIMELINE_SOURCE_UNAVAILABLE',severity:'error',message:'PRIVATE_PATH'}]}),{includePreflight:true});assert.equal(item(checks,'timeline_references').reason?.code,'REFERENCES_UNAVAILABLE');assert.equal(item(checks,'timeline_preflight').reason?.code,'PREFLIGHT_BLOCKED');assert.equal(item(checks,'timeline_preflight').basis[0].revision,changed.revision);assert.doesNotMatch(JSON.stringify(checks),/PRIVATE_PATH/);
});

test('preflight absence, bounded incomplete and stale async reports never become passed',async t=>{
 const f=await fixture(t),setup=await timeline(f);assert.equal(item(await f.read(undefined,{includePreflight:true}),'timeline_preflight').reason?.code,'PREFLIGHT_UNAVAILABLE');
 const incomplete={...ready(f,setup.saved),status:'incomplete',issues:[{code:'PREFLIGHT_TIMEOUT',severity:'warning',message:'Bounded timeout'}]};assert.equal(item(await f.read(async()=>incomplete,{includePreflight:true}),'timeline_preflight').reason?.code,'PREFLIGHT_INCOMPLETE');
 const stale=await f.read(async()=>{f.store.db.prepare('UPDATE timelines SET data=? WHERE projectId=?').run(JSON.stringify({...setup.saved,revision:Number(setup.saved.revision)+1}),f.projectId);return ready(f,setup.saved);},{includePreflight:true});assert.equal(item(stale,'timeline_preflight').reason?.code,'PREFLIGHT_STALE');assert.equal(item(stale,'timeline_preflight').status,'pending');
 assert.equal(item(await f.read(async()=>({...ready(f,setup.saved),projectId:randomUUID()}),{includePreflight:true}),'timeline_preflight').reason?.code,'PREFLIGHT_UNAVAILABLE');
});

test('storage and programming errors in optional preflight propagate instead of becoming ordinary check failures',async t=>{
 const f=await fixture(t);await timeline(f);const sqlite=Object.assign(new Error('Synthetic SQLite fault'),{code:'ERR_SQLITE_ERROR'});await assert.rejects(f.read(async()=>{throw sqlite;},{includePreflight:true}),error=>error===sqlite);const programming=new TypeError('Synthetic programming fault');await assert.rejects(f.read(async()=>{throw programming;},{includePreflight:true}),error=>error===programming);
});

test('all 128 legitimate preflight issues keep their machine codes and blocking count',async t=>{
 const f=await fixture(t),setup=await timeline(f),issues=Array.from({length:128},(_value,index)=>({code:`PREFLIGHT_ISSUE_${index}`,severity:'error',message:'Synthetic local failure'}));
 const checks=await f.read(async()=>({...ready(f,setup.saved),status:'blocked',issues}),{includePreflight:true}),check=item(checks,'timeline_preflight');assert.equal(check.status,'failed');assert.equal(check.current?.blockingCount,128);assert.deepEqual(check.current?.issueCodes,issues.map(issue=>issue.code));
});

test('a legal render snapshot changed at the same revision fails the immutable queued ACK comparison',async t=>{
 const f=await fixture(t),setup=await timeline(f),step=await f.tool('mioon_timeline_render',{expectedRevision:Number(setup.saved.revision),purpose:'preview'}),id=String(object(step.result).id),render=object(f.store.get('exports',id)),frozen=object(render.snapshot),savedTimeline=object(frozen.timeline),clips=savedTimeline.clips;assert.ok(Array.isArray(clips));
 const changed={...render,snapshot:{...frozen,timeline:{...savedTimeline,clips:clips.map(clip=>({...object(clip),name:'A different legal clip name'}))}}};
 assert.equal(isTimelineRenderRecord(changed,{projectId:f.projectId,requestId:step.id,expectedRevision:Number(setup.saved.revision),purpose:'preview'}),true);
 assert.throws(()=>f.store.put('exports',changed),error=>object(error).code==='ERR_SQLITE_ERROR');
 // A temporary read view injects old/corrupt evidence while keeping the main
 // table, immutable queued ACK and writer trigger intact.
 f.store.db.exec("CREATE TEMP VIEW exports AS SELECT id,projectId,json_set(data,'$.snapshot.timeline.clips[0].name','A different legal clip name') AS data FROM main.exports");
 try{assert.equal(item(await f.read(),'export_parameters',id).reason?.code,'PARAMETERS_MISMATCH');assert.deepEqual(JSON.parse(String(f.store.db.prepare('SELECT data FROM main.exports WHERE id=?').get(id)!.data)),render);}
 finally{f.store.db.exec('DROP VIEW temp.exports');}
});

test('preflight receives the observer signal and cancellation is never replaced by a passed report',async t=>{
 const f=await fixture(t),setup=await timeline(f),controller=new AbortController(),cancelled=new Error('Synthetic observer cancellation');
 await assert.rejects(readAgentTaskChecks(f.store,f.snapshotNow(),{signal:controller.signal,includePreflight:true,preflight:async(_input,options)=>{assert.equal(options?.signal,controller.signal);controller.abort(cancelled);return ready(f,setup.saved);}}),error=>error===cancelled);
});

test('default and false checks skip a supplied preflight callback while references keep refreshing',async t=>{
 const f=await fixture(t),setup=await timeline(f);let calls=0;
 const preflight:AgentTaskChecksPreflight=async()=>{calls++;return ready(f,setup.saved);};
 const before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 for(const options of [{},{includePreflight:false}]){
  const checks=await f.read(preflight,options);assert.equal(item(checks,'timeline_references').status,'passed');assert.equal(item(checks,'timeline_preflight').status,'pending');assert.equal(item(checks,'timeline_preflight').reason?.code,'PREFLIGHT_NOT_REQUESTED');
 }
 assert.equal(calls,0);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
 const full=await f.read(preflight,{includePreflight:true});assert.equal(calls,1);assert.equal(item(full,'timeline_preflight').status,'passed');
 const changed={...setup.saved,revision:Number(setup.saved.revision)+1,clips:(setup.saved.clips as unknown[]).map(clip=>({...object(clip),assetId:randomUUID()}))};f.store.db.prepare('UPDATE timelines SET data=? WHERE projectId=?').run(JSON.stringify(changed),f.projectId);
 const writes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n,refreshed=await f.read(preflight);
 assert.equal(item(refreshed,'timeline_references').reason?.code,'REFERENCES_UNAVAILABLE');assert.equal(item(refreshed,'timeline_references').basis[0].revision,changed.revision);assert.equal(item(refreshed,'timeline_preflight').reason?.code,'PREFLIGHT_NOT_REQUESTED');assert.equal(calls,1);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,writes);
});
