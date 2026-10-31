import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath,symlink,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {projectAgentTaskUndo,createAgentTaskTools,agentTaskExplicitTargets,AGENT_TASK_OPERATION_ADMISSION,assertAgentTaskOperationCoverage} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import type {AgentTaskJson,AgentTaskChange} from '../packages/contracts/src/agent-tasks-v2.ts';
import {setAgentTaskEffectGate,assertAgentTaskJobEffect,allowAgentTaskJobTargetMutation,resumeAgentTaskJobs,stopAgentTaskJobs,isAgentTaskJobStopped,withAgentTaskJobOrigin,recordAgentTaskJobDispatch} from '../packages/business/src/agent/task-effects-v2.ts';
import {AGENT_TASK_TOOL_SCHEMAS,AGENT_TASK_TOOL_SCHEMA_HASH} from '../packages/business/src/agent/task-tool-schemas-v2.ts';
import {projectAgentTaskToolSchema} from '../packages/business/src/agent/task-tool-model-schema.ts';
import {operationDefinition} from '../packages/client/src/index.ts';
import {createMockImageAdapter} from '../packages/business/src/images/adapter.ts';
import type {CreateServicesOptions} from '../packages/business/src/services.ts';
import {createImageSettings} from '../packages/business/src/images/settings.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {buildTaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskGateway,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import type {VideoSettingsService} from '../packages/business/src/video/settings.ts';
import {defaultVideoModels} from '../packages/contracts/src/video-providers.ts';
import {imageTaskResponseSchema} from '../packages/contracts/src/images.ts';
import {frameTaskResponseSchema} from '../packages/contracts/src/frame-extraction.ts';
import type {VideoConnectionConfiguration} from '../packages/contracts/src/video-providers.ts';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function schemaReference(root:unknown,reference:unknown):unknown{
 assert.equal(typeof reference,'string');const ref=reference as string;assert.ok(ref==='#'||ref.startsWith('#/'),`Schema reference must be local: ${ref}`);
 const tokens=decodeURIComponent(ref.slice(1)).split('/').slice(1);let value=root;
 for(const token of tokens){const field=token.replaceAll('~1','/').replaceAll('~0','~');assert.ok((record(value)||Array.isArray(value))&&Object.hasOwn(value,field),`Dangling schema reference: ${ref}`);value=(value as Record<string,unknown>)[field];}
 assert.ok(record(value)||typeof value==='boolean',`Reference must resolve to a schema: ${ref}`);return value;
}
function assertSchemaReferences(root:unknown,value:unknown=root):void{
 if(Array.isArray(value)){for(const child of value)assertSchemaReferences(root,child);return;}if(!record(value))return;
 if(Object.hasOwn(value,'$ref'))schemaReference(root,value.$ref);
 if(record(value.properties))for(const hidden of ['projectId','requestId'])assert.equal(Object.hasOwn(value.properties,hidden),false,`Host field ${hidden} must not be model input`);
 for(const child of Object.values(value))assertSchemaReferences(root,child);
}
function schemaAt(root:unknown,path:readonly string[]):unknown{
 let value=root;for(const field of path){while(record(value)&&typeof value.$ref==='string')value=schemaReference(root,value.$ref);assert.ok(record(value)&&Object.hasOwn(value,field),field);value=value[field];}
 while(record(value)&&typeof value.$ref==='string')value=schemaReference(root,value.$ref);return value;
}
function expandSchemaReferences(root:unknown,value:unknown=root):unknown{
 if(Array.isArray(value))return value.map(child=>expandSchemaReferences(root,child));if(!record(value))return value;
 if(Object.hasOwn(value,'$ref')){const target=expandSchemaReferences(root,schemaReference(root,value.$ref));assert.ok(record(target));return {...target,...Object.fromEntries(Object.entries(value).filter(([key])=>key!=='$ref').map(([key,child])=>[key,expandSchemaReferences(root,child)]))};}
 return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,expandSchemaReferences(root,child)]));
}
async function fixture(t:TestContext,options:CreateServicesOptions={},providers:ReadonlyMap<string,Provider>=new Map()){
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-task-tools-v2-')),store=openStore(root),services=createServices(store,providers,options);
 const value=await services.call('project.create',{name:'Tools fixture'});if(!record(value)||typeof value.id!=='string')throw Error('Invalid test project');
 const projectId=value.id,journal=createAgentTaskJournal(store),tools=createAgentTaskTools({store,services});
 const run=journal.create({requestId:randomUUID(),projectId,text:'synthetic local task',configuration:{}}).run;
 t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 async function execute(operation:string,input:Record<string,unknown>,options:{beforeEffect?:()=>void;failRecord?:boolean;runId?:string}={}){
  const runId=options.runId??run.id,prepared=tools.prepare({projectId,operation,input}),step=journal.beginStep(runId,{kind:'tool',tier:prepared.risk,targets:prepared.targets,toolCall:{id:randomUUID(),name:tools.list().find(tool=>tool.operation===prepared.operation)!.name,arguments:JSON.parse(JSON.stringify(input)) as AgentTaskJson}});journal.markDispatch(runId,step.id);
  const outcome=await tools.execute(prepared,{runId,stepId:step.id,requestId:step.id,beforeEffect:()=>{options.beforeEffect?.();journal.assertTargets(projectId,prepared.targets);},
   recordInside:(result,changes)=>{if(options.failRecord)throw Object.assign(Error('injected durable write failure'),{code:'SQLITE_FULL'});journal.completeStepInside(runId,step.id,{result,changes});},appendChangesInside:changes=>{journal.appendChangesInside(runId,step.id,changes);}});
  if(!outcome.recorded)journal.completeStep(runId,step.id,{result:outcome.result,changes:outcome.changes});return {outcome,step:journal.step(step.id),changes:journal.snapshot(runId).changes.filter(change=>change.stepId===step.id)};
 }
 async function shot(title:string){const value=await services.call('shot.create',{projectId,title});if(!record(value)||typeof value.id!=='string'||typeof value.revision!=='number')throw Error('Invalid test shot');return {id:value.id,revision:value.revision};}
 function undo(change:AgentTaskChange,expectedTargets?:AgentTaskChange['targets']){return tools.undo(change,{beforeEffect:()=>{},recordInside:item=>{journal.markChangeRevertedInside(item.id);},retainInside:(item,reason)=>{journal.markChangeRetainedInside(item.id,reason);},...(expectedTargets?{expectedTargets}:{})});}
 return {root,store,services,projectId,journal,tools,run,execute,shot,undo};
}
async function acceptedGeneratedShot(t:TestContext){
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(){throw Error('No synthetic worker was started');},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No synthetic output requested');}};
 const f=await fixture(t,{},new Map([['mock',provider]])),created=await f.execute('shot.create',{title:'Retained generated shot',duration:2});assert.ok(record(created.outcome.result));
 const shotId=String(created.outcome.result.id),generation={shotId,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'};
 await f.execute('generation.submit',generation);return {...f,created,shotId,generation};
}
test('background generation polling keeps one submission audit and bounded history while preserving cost uncertainty and publication',async t=>{
 const f=await acceptedGeneratedShot(t),job=f.store.list('jobs',f.projectId)[0];assert.ok(record(job)&&typeof job.id==='string');
 const jobId=job.id,generation=f.journal.snapshot(f.run.id).steps.find(step=>step.toolCall?.name==='mioon_generation_submit')!;
 const update=(patch:Record<string,unknown>)=>withAgentTaskJobOrigin(f.store.db,'job',jobId,()=>f.store.tx(()=>{const current=f.store.get('jobs',jobId);assert.ok(record(current));return f.store.put('jobs',{...current,...patch,revision:Number(current.revision)+1,updatedAt:new Date().toISOString()});}));
 recordAgentTaskJobDispatch(f.store.db,'job',jobId);
 update({status:'running',phase:'polling',providerJobId:'synthetic-accepted-task',submissionCount:1});
 const before=f.journal.snapshot(f.run.id),events=f.journal.events(f.run.id),revision=f.journal.targetRevision(f.projectId,'job',jobId);
 // A full business-history budget must not block ordinary provider polling.
 f.store.db.exec("CREATE TRIGGER synthetic_poll_history_full BEFORE INSERT ON agent_task_changes_v2 BEGIN SELECT RAISE(ABORT,'synthetic history full');END;");
 for(let i=0;i<300;i++)update({progress:i%80,nextPollAt:1000+i});
 assert.deepEqual(f.journal.snapshot(f.run.id),before);assert.deepEqual(f.journal.events(f.run.id),events);
 assert.ok(f.journal.targetRevision(f.projectId,'job',jobId)>revision);assert.equal((f.store.get('jobs',jobId) as Record<string,unknown>).nextPollAt,1299);
 f.store.db.exec('DROP TRIGGER synthetic_poll_history_full');
 const originalJob=f.store.get('jobs',jobId);
 f.store.db.exec("CREATE TRIGGER synthetic_cost_audit_full BEFORE UPDATE ON agent_task_steps_v2 WHEN json_extract(NEW.data,'$.cost')='unknown' BEGIN SELECT RAISE(ABORT,'synthetic cost audit full');END;");
 assert.throws(()=>update({status:'submission_unknown',phase:'reconciliation_required'}),/synthetic cost audit full/u);
 assert.deepEqual(f.store.get('jobs',jobId),originalJob);assert.deepEqual(f.journal.snapshot(f.run.id),before);
 f.store.db.exec('DROP TRIGGER synthetic_cost_audit_full');
 update({status:'submission_unknown',phase:'reconciliation_required'});assert.equal(f.journal.step(generation.id).cost,'unknown');
 const unknown=f.journal.snapshot(f.run.id);update({nextPollAt:5000});assert.deepEqual(f.journal.snapshot(f.run.id),unknown);
 update({status:'running',phase:'reconciled'});
 const assetId=randomUUID(),versionId=randomUUID(),publish=()=>withAgentTaskJobOrigin(f.store.db,'job',jobId,()=>f.store.tx(()=>{
  f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic published result.mp4',mimeType:'video/mp4'});
  f.store.put('versions',{id:versionId,projectId:f.projectId,jobId,shotId:f.shotId,assetId,number:1,isMock:true});
  const shot=f.store.get('shots',f.shotId);assert.ok(record(shot));f.store.put('shots',{...shot,selectedVersionId:versionId,revision:Number(shot.revision)+1});
  const current=f.store.get('jobs',jobId);assert.ok(record(current));f.store.put('jobs',{...current,status:'succeeded',phase:'complete',progress:100,versionId,nextPollAt:0});
 }));
 publish();const done=f.journal.snapshot(f.run.id);
 assert.equal(done.changes.filter(change=>change.operation==='generation.submit').length,1);
 assert.equal(done.changes.filter(change=>change.operation==='generation.publish').length,1);
 assert.equal(done.changes.filter(change=>change.operation==='version.select').length,1);
 assert.equal(done.changes.filter(change=>change.operation==='generation.status').length,4);
 assert.equal(done.run.stepsUsed,before.run.stepsUsed);assert.equal(f.journal.step(generation.id).cost,'unknown');
 const publication=done.changes.find(change=>change.operation==='generation.publish')!;
 assert.deepEqual(publication.targets.map(target=>target.kind).sort(),['asset','version']);assert.equal(publication.reversible,false);
 update({progress:100,nextPollAt:6000});assert.equal(f.journal.snapshot(f.run.id).changes.length,done.changes.length);
 assert.equal(f.store.list('jobs',f.projectId).length,1);assert.equal(f.store.list('versions',f.projectId).length,1);
 assert.equal((f.store.get('jobs',jobId) as Record<string,unknown>).submissionCount,1);
});
test('background generation audit never suppresses frozen input changes or another request',async t=>{
 const f=await acceptedGeneratedShot(t),job=f.store.list('jobs',f.projectId)[0];assert.ok(record(job)&&typeof job.id==='string');
 const before=f.journal.snapshot(f.run.id);
 withAgentTaskJobOrigin(f.store.db,'job',job.id,()=>f.store.tx(()=>f.store.put('jobs',{...job,snapshot:{...(record(job.snapshot)?job.snapshot:{}),prompt:'Synthetic changed frozen input'},nextPollAt:1000})));
 const after=f.journal.snapshot(f.run.id);assert.equal(after.changes.length,before.changes.length+1);assert.equal(after.changes.at(-1)?.operation,'generation.status');
 const other=await f.services.call('generation.submit',{...f.generation,requestId:randomUUID()});assert.ok(record(other)&&typeof other.id==='string');
 withAgentTaskJobOrigin(f.store.db,'job',job.id,()=>f.store.tx(()=>f.store.put('jobs',{...other,nextPollAt:2000})));
 const unrelated=f.journal.snapshot(f.run.id);assert.equal(unrelated.changes.length,after.changes.length+1);assert.equal(unrelated.changes.at(-1)?.targets[0]?.id,other.id);
});
test('undo retains a same-run generated shot container with explicit durable metadata and original evidence',async t=>{
 const f=await acceptedGeneratedShot(t),change=f.created.changes[0]!,before=structuredClone(change),shot=f.store.get('shots',f.shotId),jobs=f.store.list('jobs',f.projectId),targets=f.journal.revisionSnapshot(f.projectId);
 assert.equal(projectAgentTaskUndo(f.store,f.projectId,f.journal.snapshot(f.run.id).changes).get(change.id)?.undoDisposition,'retain');
 const result=f.undo(change),retained=f.journal.snapshot(f.run.id).changes.find(item=>item.id===change.id)!;
 assert.equal(result.retained,true);assert.equal(retained.reversible,false);assert.equal(retained.status,'applied');assert.match(retained.summary??'',/保留生成记录及产物所需镜头/);
 assert.deepEqual(retained.before,before.before);assert.deepEqual(retained.after,before.after);assert.deepEqual(retained.undo,before.undo);assert.equal(retained.revertedAt,undefined);
 assert.deepEqual(f.store.get('shots',f.shotId),shot);assert.deepEqual(f.store.list('jobs',f.projectId),jobs);assert.deepEqual(f.journal.revisionSnapshot(f.projectId),targets);
 const event=f.journal.events(f.run.id).at(-1)!;assert.equal(event.type,'change');assert.ok(record(event.data));assert.equal(event.data.reversible,false);
});
for(const obstacle of ['unbound_job','foreign_run_job','aba','draft','edge','compound','extra_target'] as const)test(`same-run shot retention never skips ${obstacle}`,async t=>{
 const f=await acceptedGeneratedShot(t);let change=f.created.changes[0]!;
 if(obstacle==='compound'){const other=await f.execute('shot.create',{title:'Another reversible target'});assert.ok(Array.isArray(change.undo));assert.ok(Array.isArray(other.changes[0]!.undo));change={...change,undo:[...change.undo,...other.changes[0]!.undo],targets:[...change.targets,...other.changes[0]!.targets]};}
 if(obstacle==='extra_target')change={...change,targets:[...change.targets,...change.targets]};
 if(obstacle==='unbound_job')await f.services.call('generation.submit',{...f.generation,requestId:randomUUID()});
 if(obstacle==='foreign_run_job'){
  f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'completed');const other=f.journal.create({requestId:randomUUID(),projectId:f.projectId,text:'Another run',configuration:{}}).run;
  await f.execute('generation.submit',f.generation,{runId:other.id});
 }
 if(obstacle==='aba'){await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:1,patch:{title:'External edit'}});await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:2,patch:{title:'Retained generated shot'}});}
 if(obstacle==='draft')f.journal.claim({projectId:f.projectId,ownerId:'retention-draft-owner',targets:change.targets});
 if(obstacle==='edge'){const node=await f.services.call('node.create',{projectId:f.projectId,type:'text',text:'External node',position:{x:0,y:0}});assert.ok(record(node));await f.services.call('edge.create',{projectId:f.projectId,source:f.shotId,target:node.id});}
 const before=f.journal.snapshot(f.run.id),shot=f.store.get('shots',f.shotId),jobs=f.store.list('jobs',f.projectId);
 assert.equal(projectAgentTaskUndo(f.store,f.projectId,[change]).get(change.id)?.undoDisposition,'blocked');
 assert.throws(()=>f.undo(change),{code:obstacle==='draft'?'AGENT_TASK_TARGET_CLAIMED':'AGENT_TASK_TARGET_CHANGED'});
 assert.deepEqual(f.journal.snapshot(f.run.id),before);assert.deepEqual(f.store.get('shots',f.shotId),shot);assert.deepEqual(f.store.list('jobs',f.projectId),jobs);
});
test('retention audit failure rolls back the change classification, run revision and event atomically',async t=>{
 const f=await acceptedGeneratedShot(t),change=f.created.changes[0]!,before=f.journal.snapshot(f.run.id),events=f.journal.events(f.run.id),shot=f.store.get('shots',f.shotId),jobs=f.store.list('jobs',f.projectId);
 f.store.db.exec(`CREATE TRIGGER test_retention_audit BEFORE INSERT ON agent_task_events_v2 WHEN NEW.type='change' AND json_extract(NEW.data,'$.data.id')='${change.id}' AND json_extract(NEW.data,'$.data.reversible')=0 BEGIN SELECT RAISE(ABORT,'synthetic retention audit failure');END;`);
 assert.throws(()=>f.undo(change),/synthetic retention audit failure/);assert.deepEqual(f.journal.snapshot(f.run.id),before);assert.deepEqual(f.journal.events(f.run.id),events);assert.deepEqual(f.store.get('shots',f.shotId),shot);assert.deepEqual(f.store.list('jobs',f.projectId),jobs);
});
test('all public operations have explicit admission; model cannot acquire administration or raw file authority',async t=>{
 const f=await fixture(t);assertAgentTaskOperationCoverage();assert.equal(Object.keys(AGENT_TASK_OPERATION_ADMISSION).length,Object.keys(schemas).length);
 const names=new Set(f.tools.list().map(tool=>tool.operation));
 for(const operation of ['project.delete','agent.authorization.grant','lut.import','asset.import','project.get','timeline.get','timeline.undo','timeline.redo','job.retry','job.reconcile','image.task.observeRemote','export.cancel','export.output.get','task.disposition.markFailed','task.disposition.archiveCompleted','workspace.settings.get','workspace.settings.set','workspace.backup.create','workspace.backup.restore.stage'])assert.equal(names.has(operation),false,operation);
 for(const operation of ['project.rename','shot.update','timeline.clip.update','image.generate','generation.submit','task.wait','asset.importSelected','video.connection.list','export.activity.get','task.disposition.list'])assert.equal(names.has(operation),true,operation);
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'shot.create',input:{title:'unauthorized',requestId:randomUUID()}}),{code:'AGENT_TASK_INVALID_TOOL'});
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'shot.create',input:{title:'unauthorized',projectId:randomUUID()}}),{code:'AGENT_TASK_INVALID_TOOL'});
});
test('every actual model tool catalog has self-contained schema references in both protocols',async t=>{
 const f=await fixture(t),tools=f.tools.list(),settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});t.after(()=>settings.close());
 for(const tool of tools)assertSchemaReferences(tool.parameters);
 const current=await settings.get();
 for(const protocol of ['chat_completions','responses'] as const){
  const body:unknown=JSON.parse(buildTaskModelRequest({...current.configuration,protocol},[{role:'user',content:'Synthetic schema discovery only'}],tools,4318));assert.ok(record(body)&&Array.isArray(body.tools));assert.equal(body.tools.length,tools.length);
  for(const tool of body.tools){assert.ok(record(tool));const definition=protocol==='responses'?tool:tool.function;assert.ok(record(definition));assertSchemaReferences(definition.parameters);}
 }
});
test('projected nested identifiers retain the exact shared UUID constraints and strict host validation',async t=>{
 const f=await fixture(t);
 for(const [operation,path] of [
  ['shot.create',['properties','referenceAssetIds','items']],['shot.update',['properties','patch','properties','referenceAssetIds','items']],
  ['timeline.clip.add',['properties','assetId']],['timeline.clip.add',['properties','trackId']],['reference.attach',['properties','sourceNodeId']],
 ] as const){
  const tool=f.tools.list().find(item=>item.operation===operation);assert.ok(tool);
  const actual=schemaAt(tool.parameters,path),expected=schemaAt(operationDefinition(operation).inputSchema,path);assert.deepEqual(actual,expected,operation);assert.deepEqual(actual,{type:'string',format:'uuid'});
 }
 const input={projectId:f.projectId,title:'Concrete UUID references',referenceAssetIds:[randomUUID()]};assert.equal(schemas['shot.create'].safeParse(input).success,true);
 for(const id of ['', 'not-a-uuid','11111111-1111-4111-8111'])assert.equal(schemas['shot.create'].safeParse({...input,referenceAssetIds:[id]}).success,false);
 assert.equal(schemas['shot.create'].safeParse({...input,unexpected:true}).success,false);
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'shot.update',input:{shotId:randomUUID(),expectedRevision:1,patch:{title:'Denied',projectId:f.projectId}}}),{code:'AGENT_TASK_INVALID_TOOL'});
});
test('fixed tool JSON schemas match shared runtime schema projection without adding runtime dependencies',()=>{
 assert.equal(AGENT_TASK_TOOL_SCHEMA_HASH,createHash('sha256').update(JSON.stringify(AGENT_TASK_TOOL_SCHEMAS)).digest('hex'));
 const hidden=new Set(['projectId','requestId']);
 function scrub(value:unknown):unknown{if(Array.isArray(value))return value.map(scrub);if(!record(value))return value;return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,key==='properties'&&record(child)?Object.fromEntries(Object.entries(child).filter(([field])=>!hidden.has(field)).map(([field,nested])=>[field,scrub(nested)])):key==='required'&&Array.isArray(child)?child.filter(field=>!hidden.has(String(field))):scrub(child)]));}
 for(const operation of Object.keys(schemas)){const shared=operationDefinition(operation).inputSchema;assert.deepEqual(AGENT_TASK_TOOL_SCHEMAS[operation],scrub(expandSchemaReferences(shared)),operation);}
});
test('video tool discovery preserves Wan input bounds while runtime admission rejects invalid combinations and host fields',async t=>{
 const f=await fixture(t),shot=await f.shot('Wan tool discovery'),tool=f.tools.list().find(item=>item.operation==='generation.submit');assert.ok(tool);
 const parameters=schemaAt(tool.parameters,['properties','parameters']);assert.ok(record(parameters));
 for(const field of ['durationSeconds','aspectRatio','promptExtend','watermark','resolution','generateAudio'])assert.deepEqual(schemaAt(tool.parameters,['properties','parameters','properties',field]),schemaAt(operationDefinition('generation.submit').inputSchema,['properties','parameters','properties',field]),field);
 assert.deepEqual(schemaAt(tool.parameters,['properties','parameters','properties','durationSeconds']),{anyOf:[{type:'number',const:-1},{type:'integer',minimum:2,maximum:30}]});
 assert.deepEqual(schemaAt(tool.parameters,['properties','videoInput','properties','mode']),{type:'string',enum:['text','first_frame','first_last_frame','reference_images']});
 assert.deepEqual(schemaAt(tool.parameters,['properties','videoInput','properties','images','items','properties','assetId']),{type:'string',format:'uuid'});
 // The shared input holds Seedance 2.5's 30 references; a Wan request above 10 is refused below.
 assert.equal(schemaAt(tool.parameters,['properties','videoInput','properties','images','maxItems']),30);
 assert.equal(schemaAt(tool.parameters,['properties','videoInput','properties','prompt','maxLength']),20000);assertSchemaReferences(tool.parameters);
 const input={shotId:shot.id,expectedRevision:shot.revision,providerId:'wan',model:'wan3.0-video',connectionId:randomUUID(),configurationRevision:1,modelEntryId:randomUUID(),videoInput:{version:1,mode:'text',images:[],prompt:'Synthetic tool input'},parameters:{durationSeconds:5,resolution:'720P',aspectRatio:'adaptive',generateAudio:true,promptExtend:true,watermark:false}};
 for(const durationSeconds of [-1,2,30]){
  const prepared=f.tools.prepare({projectId:f.projectId,operation:'generation.submit',input:{...input,parameters:{...input.parameters,durationSeconds}}});
  assert.deepEqual(prepared.input.videoInput,input.videoInput);assert.deepEqual(prepared.input.parameters,{...input.parameters,durationSeconds});assert.equal(Object.hasOwn(prepared.input,'requestId'),false);
 }
 const image={role:'reference_image',assetId:randomUUID()};
 for(const invalid of [
  {...input,parameters:{...input.parameters,durationSeconds:1}},{...input,parameters:{...input.parameters,durationSeconds:31}},{...input,parameters:{...input.parameters,unexpected:true}},
  {...input,providerId:'ark'},{...input,subjectVersionId:randomUUID()},
  {...input,videoInput:{...input.videoInput,images:[image]}},
  {...input,videoInput:{...input.videoInput,mode:'reference_images',images:[image,image]}},
  {...input,videoInput:{...input.videoInput,mode:'reference_images',images:Array.from({length:11},()=>({...image,assetId:randomUUID()}))}},
 ])assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'generation.submit',input:invalid}),{code:'VALIDATION_ERROR'});
 for(const invalid of [{...input,requestId:randomUUID()},{...input,projectId:f.projectId},{...input,videoInput:{...input.videoInput,projectId:f.projectId}}])assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'generation.submit',input:invalid}),{code:'AGENT_TASK_INVALID_TOOL'});
});
test('Wan explicit image references retain order and enforce skipped targets before lookup or paid execution',async t=>{
 const f=await fixture(t),shot=await f.shot('Wan image references'),images=Array.from({length:10},()=>({role:'reference_image',assetId:randomUUID()}));
 const input={shotId:shot.id,expectedRevision:shot.revision,providerId:'wan',model:'wan3.0-video',connectionId:randomUUID(),configurationRevision:1,modelEntryId:randomUUID(),videoInput:{version:1,mode:'reference_images',images,prompt:'图1 and 图10 preserve their positions'}};
 const prepared=f.tools.prepare({projectId:f.projectId,operation:'generation.submit',input});
 assert.deepEqual(prepared.input.videoInput,input.videoInput);assert.deepEqual(prepared.targets.map(({kind,id})=>({kind,id})),[{kind:'shot',id:shot.id}]);
 const references=[{kind:'shot',id:shot.id},...images.map(({assetId})=>({kind:'asset',id:assetId}))];
 assert.deepEqual(prepared.referencedTargets?.map(({kind,id})=>({kind,id})),references);
 assert.deepEqual(agentTaskExplicitTargets('generation.submit',{...input,videoInput:{...input.videoInput,images:[...images,images[0]]}},f.projectId),references,'Historical duplicate evidence is deduplicated without changing input order');
 const originalGet=f.store.get.bind(f.store);let lookups=0;const trackedGet=t.mock.method(f.store,'get',(table:string,id:string)=>{lookups++;return originalGet(table,id);});
 for(const image of images){
  const visited:Array<{kind:string;id:string}>=[];lookups=0;
  assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'generation.submit',input,beforeTargetRead:target=>{visited.push(target);if(target.kind==='asset'&&target.id===image.assetId)throw Object.assign(Error('Explicit reference was skipped'),{code:'AGENT_TASK_TARGET_SKIPPED'});}}),{code:'AGENT_TASK_TARGET_SKIPPED'});
  assert.deepEqual(visited,references.slice(0,images.indexOf(image)+2));assert.equal(lookups,0,'Skip rejection precedes project/target lookup and never reaches execution');
 }
 trackedGet.mock.restore();
});
test('schema projection resolves escaped local identities before removing host inputs and refuses recursive or missing evidence',()=>{
 const source={type:'object',properties:{projectId:{type:'string',format:'uuid'},requestId:{type:'string',minLength:8,maxLength:200},'owned/id~slot':{type:'string',format:'uuid'},assetId:{$ref:'#/properties/projectId'},nested:{type:'object',properties:{requestId:{type:'string'},assetId:{$ref:'#/properties/owned~1id~0slot'}},required:['requestId','assetId'],additionalProperties:false}},required:['projectId','requestId','assetId','nested'],additionalProperties:false};
 assert.deepEqual(projectAgentTaskToolSchema(source),{type:'object',properties:{'owned/id~slot':{type:'string',format:'uuid'},assetId:{type:'string',format:'uuid'},nested:{type:'object',properties:{assetId:{type:'string',format:'uuid'}},required:['assetId'],additionalProperties:false}},required:['assetId','nested'],additionalProperties:false});
 for(const bad of [{$ref:'#'},{$ref:'#/missing'},{$ref:'https://example.invalid/schema'},{$ref:'#/properties/bad~2escape'},{properties:{item:{$ref:'#/properties/item'}}}])assert.throws(()=>projectAgentTaskToolSchema(bad),/unresolved or recursive/);
 assert.deepEqual(source.properties.assetId,{$ref:'#/properties/projectId'},'generation must not mutate the public schema');
});
test('real tool discovery projects only protocol-supported definition fields on the wire',async t=>{
 const f=await fixture(t),settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});t.after(()=>settings.close());const current=await settings.get();
 for(const protocol of ['chat_completions','responses'] as const){const value:unknown=JSON.parse(buildTaskModelRequest({...current.configuration,protocol},[{role:'user',content:'Synthetic body only'}],f.tools.list(),4318));if(!record(value)||!Array.isArray(value.tools))throw Error('Invalid model request');
  for(const item of value.tools){if(!record(item))throw Error('Invalid tool');const definition=protocol==='responses'?item:item.function;if(!record(definition))throw Error('Invalid definition');assert.deepEqual(Object.keys(definition).filter(field=>!['type','name','description','parameters','strict'].includes(field)),[]);}
 }
});
test('a local mutation and its durable Change/step commit together; targeted undo preserves another manual target',async t=>{
 const f=await fixture(t),shot=await f.shot('Before'),other=await f.shot('Elsewhere');
 const completed=await f.execute('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{title:'AI title'}});
 assert.equal(completed.step.status,'completed');assert.equal(completed.changes.length,1);assert.equal(completed.changes[0]!.reversible,true);
 await f.services.call('shot.update',{shotId:other.id,expectedRevision:other.revision,patch:{title:'Manual elsewhere'}});
 f.undo(completed.changes[0]!);
 assert.equal((f.store.get('shots',shot.id) as Record<string,unknown>).title,'Before');assert.equal((f.store.get('shots',other.id) as Record<string,unknown>).title,'Manual elsewhere');
 assert.equal(f.journal.snapshot(f.run.id).changes[0]!.status,'reverted');
});
test('journal write failure rolls back the domain mutation and no result receipt is claimed',async t=>{
 const f=await fixture(t),shot=await f.shot('Before');
 await assert.rejects(f.execute('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{title:'Must roll back'}},{failRecord:true}),{code:'SQLITE_FULL'});
 assert.equal((f.store.get('shots',shot.id) as Record<string,unknown>).title,'Before');assert.equal(f.journal.snapshot(f.run.id).changes.length,0);
 const step=f.journal.snapshot(f.run.id).steps.at(-1)!;f.journal.updateStep(f.run.id,step.id,{status:'unknown'});
 const prepared=f.tools.prepare({projectId:f.projectId,operation:'shot.update',input:{shotId:shot.id,expectedRevision:1,patch:{title:'Must roll back'}}}),before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 assert.deepEqual(f.tools.recoverLocalUnknown(prepared,{runId:f.run.id,stepId:step.id,requestId:step.id}),{outcome:'not_applied',reason:'atomic_receipt_absent'});
 assert.equal(f.tools.recoverLocalUnknown(prepared,{runId:f.run.id,stepId:step.id,requestId:randomUUID()}),null);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
});
for(const operation of ['generation.submit','image.generate'] as const)test(`${operation}: an unknown paid step is provably not applied only while no acceptance, job origin or dispatch cost exists`,async t=>{
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(){throw Error('No synthetic worker was started');},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No synthetic output requested');}};
 const f=await fixture(t,{imageOptions:{autoRun:false}},new Map([['mock',provider]]));let input:Record<string,unknown>;
 if(operation==='generation.submit'){const created=await f.execute('shot.create',{title:'Paid unknown',duration:2});assert.ok(record(created.outcome.result));input={shotId:String(created.outcome.result.id),expectedRevision:1,providerId:'mock',model:'mock-motion-v1'};}
 else input={name:'Paid unknown',prompt:'Synthetic',providerId:'mock',model:'mock-image-v1',options:{...IMAGE_FIXED_OPTIONS}};
 const prepared=f.tools.prepare({projectId:f.projectId,operation,input}),accepted=()=>f.store.db.prepare(operation==='generation.submit'?'SELECT COUNT(*) AS n FROM jobs':'SELECT COUNT(*) AS n FROM image_tasks').get()!.n;
 for(const evidence of ['none','cost','origin','receipt'] as const){
  // A lost journal write rolls the whole acceptance back, as a crash before its commit would.
  await assert.rejects(f.execute(operation,input,{failRecord:true}),{code:'SQLITE_FULL'},evidence);assert.equal(accepted(),0,evidence);
  const step=f.journal.snapshot(f.run.id).steps.at(-1)!;f.journal.updateStep(f.run.id,step.id,{status:'unknown'});
  if(evidence==='cost')f.journal.updateStep(f.run.id,step.id,{cost:'submitted'});
  if(evidence==='origin')f.store.db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run(operation==='generation.submit'?'job':'image',randomUUID(),f.run.id,step.id,f.projectId,step.id,operation);
  // An acceptance without its v2 completion, as after a crash between the two commits.
  if(evidence==='receipt'){await f.services.call(operation,{...input,...(operation==='image.generate'?{projectId:f.projectId}:{}),requestId:step.id});assert.equal(accepted(),1);}
  assert.deepEqual(f.tools.recoverLocalUnknown(prepared,{runId:f.run.id,stepId:step.id,requestId:step.id}),evidence==='none'?{outcome:'not_applied',reason:'atomic_receipt_absent'}:null,evidence);
 }
});
test('same-value mutations complete the v2 receipt in the domain transaction even with no Change',async t=>{
 const f=await fixture(t),shot=await f.shot('Before'),done=await f.execute('shot.update',{shotId:shot.id,expectedRevision:1,patch:{title:'Before'}});
 assert.equal(done.outcome.recorded,true);assert.equal(done.step.status,'completed');assert.equal(done.changes.length,0);assert.equal((f.store.get('shots',shot.id) as Record<string,unknown>).revision,2);
 const project=f.store.get('projects',f.projectId) as Record<string,unknown>,renamed=await f.execute('project.rename',{expectedRevision:project.revision,name:project.name});assert.equal(renamed.outcome.recorded,true);assert.equal(renamed.changes.length,0);
});
test('effect fence after intent and immediately before the domain transaction blocks revoked authority',async t=>{
 const f=await fixture(t),shot=await f.shot('Before');let fences=0;
 await assert.rejects(f.execute('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{title:'Not allowed'}},{beforeEffect:()=>{if(++fences===2)throw Object.assign(Error('revoked'),{code:'AGENT_TASK_CONSENT_REQUIRED'});}}),{code:'AGENT_TASK_CONSENT_REQUIRED'});
 assert.equal(fences,2);assert.equal((f.store.get('shots',shot.id) as Record<string,unknown>).title,'Before');assert.equal(f.journal.snapshot(f.run.id).changes.length,0);
});
test('target ownership is checked before a foreign record can be read or changed',async t=>{
 // Another project's records live in that project's own store: this project has none of them.
 const f=await fixture(t),other=await fixture(t);
 const foreign=await other.services.call('shot.create',{projectId:other.projectId,title:'Foreign private title'});if(!record(foreign))throw Error('Invalid shot');
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'shot.update',input:{shotId:foreign.id,expectedRevision:1,patch:{title:'Invalid'}}}),{code:'AGENT_TASK_INVALID_TARGET'});
 const privateJob=other.store.put('jobs',{id:randomUUID(),projectId:other.projectId,status:'failed',requestId:randomUUID()});
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'task.disposition.list',input:{targets:[{kind:'generation',taskId:privateJob.id}]}}),{code:'AGENT_TASK_INVALID_TARGET'});
});
test('task-only canvas discovery is bounded, project scoped, and enables editing existing nodes',async t=>{
 const f=await fixture(t),own=await f.services.call('node.create',{projectId:f.projectId,type:'text',text:'Owned canvas text',position:{x:10,y:20}}),other=await fixture(t);if(!record(own))throw Error('Invalid fixtures');
 await other.services.call('node.create',{projectId:other.projectId,type:'text',text:'FOREIGN_CANVAS_NEVER_SEND',position:{x:10,y:20}});
 const observed=await f.execute('mioon_node_inspect',{limit:1});assert.match(JSON.stringify(observed.outcome.result),/Owned canvas text/);assert.doesNotMatch(JSON.stringify(observed.outcome.result),/FOREIGN_CANVAS/);
 const updated=await f.execute('node.update',{nodeId:own.id,expectedRevision:1,patch:{text:'Updated after discovery'}});assert.equal(updated.step.status,'completed');
 await assert.rejects(f.execute('mioon_edge_inspect',{limit:21}),{code:'AGENT_TASK_INVALID_TOOL'});
});
test('manual edit followed by reverting text is still an ABA conflict for task undo',async t=>{
 const f=await fixture(t),shot=await f.shot('Before'),done=await f.execute('shot.update',{shotId:shot.id,expectedRevision:1,patch:{title:'AI'}});
 await f.services.call('shot.update',{shotId:shot.id,expectedRevision:2,patch:{title:'Manual'}});await f.services.call('shot.update',{shotId:shot.id,expectedRevision:3,patch:{title:'AI'}});
 assert.throws(()=>f.undo(done.changes[0]!),{code:'AGENT_TASK_TARGET_CHANGED'});assert.equal((f.store.get('shots',shot.id) as Record<string,unknown>).title,'AI');
});
test('reverse compensation can advance its own revision chain while refusing unrelated external edits',async t=>{
 const f=await fixture(t),shot=await f.shot('Before'),first=await f.execute('shot.update',{shotId:shot.id,expectedRevision:1,patch:{title:'First'}}),second=await f.execute('shot.update',{shotId:shot.id,expectedRevision:2,patch:{title:'Second'}});
 const next=f.undo(second.changes[0]!);f.undo(first.changes[0]!,next.targets);assert.equal((f.store.get('shots',shot.id) as Record<string,unknown>).title,'Before');
});
test('claims on the exact target block execution while a claim elsewhere leaves the task free',async t=>{
 const f=await fixture(t),shot=await f.shot('Before'),other=await f.shot('Other'),ownerId=randomUUID();
 f.journal.claim({projectId:f.projectId,ownerId,targets:[{kind:'shot',id:other.id,revision:f.journal.targetRevision(f.projectId,'shot',other.id)}]});
 const completed=await f.execute('shot.update',{shotId:shot.id,expectedRevision:1,patch:{title:'Allowed'}});assert.equal(completed.step.status,'completed');
 f.journal.claim({projectId:f.projectId,ownerId,targets:[{kind:'shot',id:shot.id,revision:f.journal.targetRevision(f.projectId,'shot',shot.id)}]});
 await assert.rejects(f.execute('shot.update',{shotId:shot.id,expectedRevision:2,patch:{title:'Blocked'}}),{code:'AGENT_TASK_TARGET_CLAIMED'});
 const observed=await f.execute('version.list',{shotId:shot.id});assert.equal(observed.step.status,'completed');assert.deepEqual(observed.step.targets,[]);
 const job=f.store.put('jobs',{id:randomUUID(),projectId:f.projectId,status:'running',revision:1}),prepared=f.tools.prepare({projectId:f.projectId,operation:'job.get',input:{jobId:job.id}});
 f.store.put('jobs',{...job,progress:50,revision:2});assert.deepEqual(prepared.targets,[]);const latest=await f.execute('job.get',{jobId:job.id});assert.ok(record(latest.step.result));assert.equal(latest.step.result.progress,50);
});
test('durable worker origin cannot bypass a missing or revoked backend gate',async t=>{
 const f=await fixture(t),step=f.journal.beginStep(f.run.id,{kind:'tool'});
 f.store.tx(()=>f.store.db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run('job','synthetic-job',f.run.id,step.id,f.projectId,step.id,'generation.submit'));
 assert.throws(()=>assertAgentTaskJobEffect(f.store.db,'job','synthetic-job'),{code:'AGENT_TASK_EFFECT_BLOCKED'});
 let allowed=true;const remove=setAgentTaskEffectGate(f.store.db,()=>{if(!allowed)throw Object.assign(Error('revoked'),{code:'AGENT_TASK_CONSENT_REQUIRED'});});
 assertAgentTaskJobEffect(f.store.db,'job','synthetic-job');allowed=false;assert.throws(()=>assertAgentTaskJobEffect(f.store.db,'job','synthetic-job'),{code:'AGENT_TASK_CONSENT_REQUIRED'});remove();
});
test('timeline compensation restores only one clip and preserves manual edits on another clip',async t=>{
 const f=await fixture(t),assetId=randomUUID();f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic image',mimeType:'image/png',width:720,height:1280,duration:0,hasVideo:true,hasAudio:false,sha256:'a'.repeat(64),relativePath:'media/fixture.png',provenance:'user-import',createdAt:new Date().toISOString()});
 const timeline=await f.services.call('timeline.get',{projectId:f.projectId});if(!record(timeline)||!Array.isArray(timeline.tracks)||!record(timeline.tracks[0]))throw Error('Invalid timeline');const trackId=timeline.tracks[0].id;
 const first=await f.execute('timeline.clip.add',{assetId,trackId,expectedRevision:1,startFrame:0,durationFrames:30});
 const firstClip=f.store.db.prepare("SELECT json_extract(data,'$.clips[0].id') AS id FROM timelines WHERE projectId=?").get(f.projectId)!;
 await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),assetId,trackId,expectedRevision:2,startFrame:30,durationFrames:30,name:'Manual added'});
 const secondClip=f.store.db.prepare("SELECT json_extract(data,'$.clips[1].id') AS id FROM timelines WHERE projectId=?").get(f.projectId)!;
 await f.services.call('timeline.clip.update',{projectId:f.projectId,requestId:randomUUID(),clipId:secondClip.id,expectedRevision:3,patch:{name:'Manual renamed'}});
 f.undo(first.changes[0]!);
 const saved=f.store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(f.projectId)!;const parsed:unknown=JSON.parse(String(saved.data));if(!record(parsed)||!Array.isArray(parsed.clips))throw Error('Invalid result');
 assert.equal(parsed.clips.some((value:unknown)=>record(value)&&value.id===firstClip.id),false);assert.equal(parsed.clips.length,1);assert.equal((parsed.clips[0] as Record<string,unknown>).name,'Manual renamed');
});
test('an unrelated timeline edit does not invalidate a target-local edit through aggregate CAS',async t=>{
 const f=await fixture(t),assetId=randomUUID();f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic image',mimeType:'image/png',width:720,height:1280,duration:0,hasVideo:true,hasAudio:false,sha256:'b'.repeat(64),relativePath:'media/fixture.png',provenance:'user-import',createdAt:new Date().toISOString()});
 const initial=await f.services.call('timeline.get',{projectId:f.projectId});if(!record(initial)||!Array.isArray(initial.tracks)||!record(initial.tracks[0]))throw Error('Invalid timeline');const trackId=initial.tracks[0].id;
 for(const startFrame of [0,30])await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:startFrame===0?1:2,assetId,trackId,startFrame,durationFrames:30});
 const ids=f.store.db.prepare("SELECT json_extract(data,'$.clips[0].id') AS first,json_extract(data,'$.clips[1].id') AS second FROM timelines WHERE projectId=?").get(f.projectId)!;
 await f.services.call('timeline.clip.update',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:3,clipId:ids.second,patch:{name:'Manual elsewhere'}});
 const result=await f.execute('timeline.clip.update',{expectedRevision:3,clipId:ids.first,patch:{name:'AI target'}});assert.equal(result.step.status,'completed');
 const row=f.store.db.prepare("SELECT json_extract(data,'$.clips[0].name') AS first,json_extract(data,'$.clips[1].name') AS second FROM timelines WHERE projectId=?").get(f.projectId)!;
 assert.equal(row.first,'AI target');assert.equal(row.second,'Manual elsewhere');
});
test('shot reorder uses exact shot targets while preserving an unrelated manual project rename',async t=>{
 const f=await fixture(t),a=await f.shot('A'),b=await f.shot('B'),project=f.store.get('projects',f.projectId);assert.ok(record(project));const revision=project.revision;
 await f.services.call('project.rename',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:revision,name:'Manual name retained'});
 const result=await f.execute('shot.reorder',{expectedRevision:revision,shotIds:[b.id,a.id]});assert.equal(result.step.status,'completed');
 const saved=f.store.get('projects',f.projectId);assert.ok(record(saved));assert.equal(saved.name,'Manual name retained');assert.equal((f.store.get('shots',b.id) as Record<string,unknown>).orderIndex,0);assert.equal((f.store.get('shots',a.id) as Record<string,unknown>).orderIndex,1);assert.ok(result.changes.every(change=>change.targets.every(target=>target.kind==='shot')));
});
for(const change of ['add','edit','aba'] as const)test(`shot reorder still rejects ${change} after its intent without moving any shot`,async t=>{
 const f=await fixture(t),a=await f.shot('A'),b=await f.shot('B'),project=f.store.get('projects',f.projectId);assert.ok(record(project));
 const prepared=f.tools.prepare({projectId:f.projectId,operation:'shot.reorder',input:{expectedRevision:project.revision,shotIds:[b.id,a.id]}}),step=f.journal.beginStep(f.run.id,{kind:'tool',targets:prepared.targets,tier:prepared.risk});f.journal.markDispatch(f.run.id,step.id);
 if(change==='add')await f.shot('Manual C');else {await f.services.call('shot.update',{shotId:a.id,expectedRevision:1,patch:{title:'Manual renamed'}});if(change==='aba')await f.services.call('shot.update',{shotId:a.id,expectedRevision:2,patch:{title:'A'}});}
 await assert.rejects(f.tools.execute(prepared,{runId:f.run.id,stepId:step.id,requestId:step.id,beforeEffect:()=>f.journal.assertTargets(f.projectId,prepared.targets),recordInside:(result,changes)=>f.journal.completeStepInside(f.run.id,step.id,{result,changes})}),{code:'AGENT_TASK_TARGET_CHANGED'});
 assert.equal((f.store.get('shots',a.id) as Record<string,unknown>).orderIndex,0);assert.equal((f.store.get('shots',b.id) as Record<string,unknown>).orderIndex,1);assert.equal(f.journal.snapshot(f.run.id).changes.length,0);
});
test('selected Cube import retains one atomic immutable receipt and cannot expose source bytes',async t=>{
 const f=await fixture(t),cube='LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
 const selected=await f.tools.stageImport({projectId:f.projectId,requestId:randomUUID(),name:'local.cube',mimeType:'',dataBase64:Buffer.from(cube).toString('base64')});if(!record(selected))throw Error('Invalid selected file');
 const admitted=await f.execute('lut.importSelected',{handle:selected.id});assert.equal(admitted.step.status,'completed');assert.equal(admitted.changes[0]!.reversible,false);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project_lut_resources').get()!.n,1);
 const replay=await f.execute('lut.importSelected',{handle:selected.id});assert.equal(replay.step.status,'completed');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project_lut_resources').get()!.n,1);
 const manifest=f.store.db.prepare('SELECT status,resourceId,assetId FROM agent_task_imports_v2 WHERE id=?').get(String(selected.id))!;assert.equal(manifest.status,'imported');assert.equal(typeof manifest.resourceId,'string');assert.equal(manifest.assetId,null);
 assert.doesNotMatch(JSON.stringify(admitted.step.result),/dataBase64|relativePath|LUT_3D_SIZE/);
});
test('selected import rejects symlink staging and enforces the 7 MiB Cube limit',async t=>{
 const f=await fixture(t),outside=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-task-import-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 await symlink(outside,path.join(f.root,'agent-imports'));
 await assert.rejects(f.tools.stageImport({projectId:f.projectId,requestId:randomUUID(),name:'small.cube',mimeType:'',dataBase64:Buffer.from('LUT_3D_SIZE 2').toString('base64')}),{code:'STORAGE_PRIVATE_REQUIRED'});
 await assert.rejects(f.tools.stageImport({projectId:f.projectId,requestId:randomUUID(),name:'large.cube',mimeType:'',dataBase64:Buffer.alloc(7*1024*1024+1).toString('base64')}),{code:'INVALID_MEDIA'});
});
test('foreign task.wait is rejected before invoking any task status reader',async t=>{
 // The foreign job lives in another project's own store: this project has no such job.
 const f=await fixture(t),other=await fixture(t);
 const id=randomUUID();other.store.put('jobs',{id,projectId:other.projectId,status:'succeeded',private:'FOREIGN_CONTENT'});
 let reads=0;const reader=f.services.handlers['job.get']!;f.services.handlers['job.get']=(input,context)=>{reads++;return reader(input,context);};
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'task.wait',input:{kind:'job',id}}),{code:'AGENT_TASK_INVALID_TARGET'});
 await assert.rejects(f.tools.wait(f.projectId,{kind:'job',id}),{code:'AGENT_TASK_INVALID_TARGET'});assert.equal(reads,0);
});
test('unknown wait recovery only observes an existing local result and never drives the worker',async t=>{
 const f=await fixture(t),id=randomUUID();f.store.put('jobs',{id,projectId:f.projectId,status:'queued',revision:1});
 const prepared=f.tools.prepare({projectId:f.projectId,operation:'task.wait',input:{kind:'job',id}}),before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 assert.equal(f.tools.recoverWait(prepared),null);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
 f.store.put('jobs',{id,projectId:f.projectId,status:'submission_unknown',revision:2});assert.throws(()=>f.tools.recoverWait(prepared),{code:'AGENT_TASK_UNKNOWN_RESULT'});
 f.store.put('jobs',{id,projectId:f.projectId,status:'succeeded',revision:3,versionId:randomUUID()});const recovered=f.tools.recoverWait(prepared);assert.ok(record(recovered));assert.equal(recovered.status,'succeeded');
});
test('selected file authority is rechecked before opening its private bytes',async t=>{
 const f=await fixture(t),selected=await f.tools.stageImport({projectId:f.projectId,requestId:randomUUID(),name:'small.cube',mimeType:'',dataBase64:Buffer.from('LUT_3D_SIZE 2').toString('base64')});if(!record(selected))throw Error('Invalid file');
 await rm(path.join(f.root,`agent-imports/${String(selected.id)}.bin`));
 let fences=0;await assert.rejects(f.execute('lut.importSelected',{handle:selected.id},{beforeEffect:()=>{if(++fences===2)throw Object.assign(Error('revoked'),{code:'AGENT_TASK_CONSENT_REQUIRED'});}}),{code:'AGENT_TASK_CONSENT_REQUIRED'});
 assert.equal(fences,2);assert.equal(f.store.db.prepare('SELECT status FROM agent_task_imports_v2 WHERE id=?').get(String(selected.id))!.status,'selected');
});
test('image worker rechecks authority after acceptance and immediately before dispatch',async t=>{
 let enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});let dispatches=0;
 const f=await fixture(t,{imageOptions:{generate:async(snapshot,context)=>{enter();await barrier;return createMockImageAdapter().generate(snapshot,{...context,beforeDispatch:()=>{if(typeof context.beforeDispatch!=='function')throw Error('Missing host fence');context.beforeDispatch();dispatches++;}});}}});
 let allowed=true;const remove=setAgentTaskEffectGate(f.store.db,()=>{if(!allowed)throw Object.assign(Error('revoked'),{code:'AGENT_TASK_CONSENT_REQUIRED'});});t.after(remove);
 const manual=await f.shot('Before manual');
 const result=await f.execute('image.generate',{name:'Synthetic',prompt:'Local synthetic fixture',providerId:'mock',model:'mock-image-v1',options:{size:'1024x1024',quality:'low',background:'opaque',outputFormat:'png',n:1}});
 assert.deepEqual(result.step.result,result.outcome.result);assert.ok(record(result.step.result)&&typeof result.step.result.id==='string');assert.equal(Object.hasOwn(result.step.result,'response'),false);assert.equal(Object.hasOwn(result.step.result,'replayed'),false);
 await entered;await f.services.call('shot.update',{shotId:manual.id,expectedRevision:1,patch:{title:'Manual during async wait'}});allowed=false;release();
 await delay(20);assert.equal(f.store.db.prepare('SELECT state FROM image_tasks LIMIT 1').get()!.state,'queued');
 assert.equal(dispatches,0);assert.equal(f.store.db.prepare('SELECT dispatched FROM image_tasks LIMIT 1').get()!.dispatched,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_versions').get()!.n,0);assert.equal(f.journal.step(result.step.id).cost,undefined);
 assert.equal(f.journal.snapshot(f.run.id).changes.some(change=>change.targets.some(target=>target.kind==='shot'&&target.id===manual.id)),false);
 allowed=true;resumeAgentTaskJobs(f.store.db,f.run.id);
 for(let i=0;i<500;i++){if(f.store.db.prepare('SELECT state FROM image_tasks LIMIT 1').get()?.state==='succeeded')break;await delay(5);}
 assert.equal(f.store.db.prepare('SELECT state FROM image_tasks LIMIT 1').get()!.state,'succeeded');assert.equal(dispatches,1);resumeAgentTaskJobs(f.store.db,f.run.id);await delay(10);assert.equal(dispatches,1);
});
test('frame acceptance persists the public task reference in its atomic step receipt',async t=>{
 const f=await fixture(t,{frameOptions:{autoRun:false}}),bytes=Buffer.from('Synthetic local frame admission source; decoder is disabled'),id=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex'),relativePath=`media/${id}.mp4`;
 await writeFile(path.join(f.root,relativePath),bytes,{mode:0o600});
 f.store.put('assets',{id,projectId:f.projectId,name:'Source.mp4',mimeType:'video/mp4',sha256,relativePath,sizeBytes:bytes.length,duration:2,width:32,height:32,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});
 const result=await f.execute('frame.extract',{sourceAssetId:id,sourceHash:sha256,sourceFrame:0});
 assert.equal(result.outcome.recorded,true);assert.deepEqual(result.step.result,result.outcome.result);assert.ok(record(result.step.result)&&typeof result.step.result.id==='string');assert.equal(result.step.result.projectId,f.projectId);assert.equal(result.step.result.state,'queued');assert.equal(Object.hasOwn(result.step.result,'value'),false);assert.equal(Object.hasOwn(result.step.result,'replayed'),false);
});
test('cancelled frame wait returns the original cancellation instead of waiting forever',async t=>{
 const f=await fixture(t,{frameOptions:{autoRun:false}}),bytes=Buffer.from('Synthetic cancelled frame source; decoder disabled'),id=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex'),relativePath=`media/${id}.mp4`;
 await writeFile(path.join(f.root,relativePath),bytes,{mode:0o600});f.store.put('assets',{id,projectId:f.projectId,name:'Source.mp4',mimeType:'video/mp4',sha256,relativePath,sizeBytes:bytes.length,duration:2,width:32,height:32,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});
 const accepted=await f.execute('frame.extract',{sourceAssetId:id,sourceHash:sha256,sourceFrame:0});assert.ok(record(accepted.step.result));
 const taskId=String(accepted.step.result.id);await f.services.call('frame.task.cancelQueued',{projectId:f.projectId,taskId,expectedRevision:accepted.step.result.revision,requestId:randomUUID()});
 const prepared=f.tools.prepare({projectId:f.projectId,operation:'task.wait',input:{kind:'frame',id:taskId}}),recovered=f.tools.recoverWait(prepared);assert.ok(record(recovered));assert.equal(recovered.state,'cancelled_before_start');
 const waited=await f.execute('task.wait',{kind:'frame',id:taskId});assert.equal(waited.step.status,'completed');assert.ok(record(waited.step.result));assert.equal(waited.step.result.state,'cancelled_before_start');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM frame_tasks').get()!.n,1);
});
for(const kind of ['image','frame'] as const)test(`${kind} local result error stops host waiting for explicit recovery`,async t=>{
 const f=await fixture(t,{imageOptions:{autoRun:false},frameOptions:{autoRun:false}});let accepted;
 if(kind==='image')accepted=await f.execute('image.generate',{name:'Synthetic',prompt:'Local fixture',providerId:'mock',model:'mock-image-v1',options:{size:'1024x1024',quality:'low',background:'opaque',outputFormat:'png',n:1}});
 else {const id=randomUUID(),bytes=Buffer.from('Synthetic frame recovery source; decoder disabled'),sha256=createHash('sha256').update(bytes).digest('hex'),relativePath=`media/${id}.mp4`;await writeFile(path.join(f.root,relativePath),bytes,{mode:0o600});f.store.put('assets',{id,projectId:f.projectId,name:'Source.mp4',mimeType:'video/mp4',sha256,relativePath,sizeBytes:bytes.length,duration:2,width:32,height:32,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});accepted=await f.execute('frame.extract',{sourceAssetId:id,sourceHash:sha256,sourceFrame:0});}
 assert.ok(record(accepted.step.result));const id=String(accepted.step.result.id),operation=kind==='image'?'image.task.get':'frame.task.get',reader=f.services.handlers[operation]!;
 // Inject a public domain observation after the source has passed its own
 // dispatch/start fence. Waiting must hand control back to the recovery UI.
 f.services.handlers[operation]=(input,context)=>{const value=reader(input,context);assert.ok(record(value));return kind==='image'?imageTaskResponseSchema.parse({...value,state:'local_result_error',dispatched:true,errorCode:'IMAGE_RESULT_INVALID'}):frameTaskResponseSchema.parse({...value,state:'local_result_error',started:true,errorCode:'FRAME_RESULT_INVALID'});};
 const prepared=f.tools.prepare({projectId:f.projectId,operation:'task.wait',input:{kind,id}}),before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 assert.throws(()=>f.tools.recoverWait(prepared),{code:'AGENT_TASK_UNKNOWN_RESULT'});await assert.rejects(f.tools.wait(f.projectId,{kind,id}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
});
test('stopping retires only bound unstarted video image frame and export work and closes background pending',async t=>{
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(){throw Error('No worker may send');},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No worker may download');}};
 const fullRequestQuota=(code:string)=>(point:string,details:Record<string,unknown>={})=>{if(point==='before_request_receipt'&&String(details.operation).endsWith('cancelQueued'))throw Object.assign(Error('Synthetic legacy request quota is full'),{code});};
 const f=await fixture(t,{imageOptions:{autoRun:false,fault:fullRequestQuota('IMAGE_CAPACITY')},frameOptions:{autoRun:false,fault:fullRequestQuota('FRAME_CAPACITY')}},new Map([['mock',provider]])),shot=await f.shot('Queued source'),bytes=Buffer.from('Synthetic locally selected video'),id=randomUUID(),relativePath=`media/${id}.mp4`,sha256=createHash('sha256').update(bytes).digest('hex');
 await writeFile(path.join(f.root,relativePath),bytes,{mode:0o600});f.store.put('assets',{id,projectId:f.projectId,name:'Selected source.mp4',mimeType:'video/mp4',relativePath,sha256,sizeBytes:bytes.length,width:32,height:32,duration:2,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});
 await f.execute('generation.submit',{shotId:shot.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'});
 await f.execute('image.generate',{name:'Queued image',prompt:'Synthetic',providerId:'mock',model:'mock-image-v1',options:{...IMAGE_FIXED_OPTIONS}});
 await f.execute('frame.extract',{sourceAssetId:id,sourceHash:sha256,sourceFrame:0});
 const timeline=await f.services.call('timeline.get',{projectId:f.projectId});if(!record(timeline)||!Array.isArray(timeline.tracks)||!record(timeline.tracks[0]))throw Error('Invalid timeline');
 await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:1,assetId:id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:1});await f.execute('timeline.render',{expectedRevision:2,purpose:'export'});
 assert.equal(f.journal.snapshot(f.run.id).backgroundPending,true);f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'paused','user');stopAgentTaskJobs(f.store.db,f.run.id);assert.equal(f.journal.snapshot(f.run.id).backgroundPending,true,'pause preserves all original queued requests');
 f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'stopped');stopAgentTaskJobs(f.store.db,f.run.id);
 assert.equal((f.store.list('jobs',f.projectId)[0] as Record<string,unknown>).status,'cancelled');const cancelledExport=f.store.list('exports',f.projectId)[0] as Record<string,unknown>;assert.equal(cancelledExport.status,'failed');assert.ok(record(cancelledExport.error));assert.equal(cancelledExport.error.code,'EXPORT_CANCELLED');assert.equal(f.store.db.prepare('SELECT state FROM image_tasks').get()!.state,'cancelled_before_dispatch');assert.equal(f.store.db.prepare('SELECT state FROM frame_tasks').get()!.state,'cancelled_before_start');assert.equal(f.journal.snapshot(f.run.id).backgroundPending,false);
 const saved=JSON.stringify(f.journal.snapshot(f.run.id));stopAgentTaskJobs(f.store.db,f.run.id);assert.equal(JSON.stringify(f.journal.snapshot(f.run.id)),saved,'same stopped run does not repeat cancellation receipts');assert.equal(f.store.list('assets',f.projectId).length,1);
});
test('stopping an already dispatched image preserves its late product and completes pending only after result persistence',async t=>{
 let enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});let posts=0;
 const f=await fixture(t,{imageOptions:{generate:async(snapshot,context)=>{if(typeof context.beforeDispatch!=='function')throw Error('Missing dispatch fence');context.beforeDispatch();posts++;enter();await barrier;return createMockImageAdapter().generate(snapshot,{beforeDispatch:()=>{}});}}});
 const remove=setAgentTaskEffectGate(f.store.db,()=>{if(f.journal.run(f.run.id).status==='stopped')throw Object.assign(Error('Stopped'),{code:'AGENT_TASK_STOPPED'});});t.after(remove);
 await f.execute('image.generate',{name:'Late retained image',prompt:'Synthetic',providerId:'mock',model:'mock-image-v1',options:{...IMAGE_FIXED_OPTIONS}});await entered;
 f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'stopped');stopAgentTaskJobs(f.store.db,f.run.id);assert.equal(f.store.db.prepare('SELECT state FROM image_tasks').get()!.state,'dispatching');assert.equal(f.journal.snapshot(f.run.id).backgroundPending,true);release();
 for(let i=0;i<500;i++){if(f.store.db.prepare('SELECT state FROM image_tasks').get()?.state==='succeeded')break;await delay(5);}
 assert.equal(f.store.db.prepare('SELECT state FROM image_tasks').get()!.state,'succeeded');assert.equal(f.journal.snapshot(f.run.id).backgroundPending,false);assert.equal(posts,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_versions').get()!.n,1);
});
test('single background rejection cancels only its accepted step and duplicate rejection adds no receipt',async t=>{
 const f=await fixture(t,{imageOptions:{autoRun:false}}),input={prompt:'Synthetic selected approval',providerId:'mock',model:'mock-image-v1',options:{...IMAGE_FIXED_OPTIONS}},first=await f.execute('image.generate',{...input,name:'First pending'}),second=await f.execute('image.generate',{...input,name:'Second pending'});
 assert.throws(()=>stopAgentTaskJobs(f.store.db,f.run.id,first.step.id),{code:'AGENT_TASK_EFFECT_BLOCKED'});
 f.journal.updateStep(f.run.id,first.step.id,{data:{backgroundDenied:true}});
 assert.throws(()=>stopAgentTaskJobs(f.store.db,randomUUID(),first.step.id),{code:'AGENT_TASK_EFFECT_BLOCKED'});
 stopAgentTaskJobs(f.store.db,f.run.id,first.step.id);
 const rows=f.store.db.prepare('SELECT id,requestId,state FROM image_tasks ORDER BY rowid').all();assert.equal(rows[0]!.state,'cancelled_before_dispatch');assert.equal(rows[1]!.state,'queued');assert.equal(rows[1]!.requestId,second.step.id);assert.equal(f.journal.run(f.run.id).status,'running');assert.equal(f.journal.snapshot(f.run.id).backgroundPending,true);
 assert.equal(isAgentTaskJobStopped(f.store.db,'image',String(rows[0]!.id)),true);assert.equal(isAgentTaskJobStopped(f.store.db,'image',String(rows[1]!.id)),false);
 const requests=f.store.db.prepare('SELECT count(*) AS n FROM image_requests').get()!.n,changes=f.journal.snapshot(f.run.id).changes.length;
 stopAgentTaskJobs(f.store.db,f.run.id,first.step.id);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_requests').get()!.n,requests);assert.equal(f.journal.snapshot(f.run.id).changes.length,changes);assert.equal(f.store.db.prepare('SELECT state FROM image_tasks WHERE requestId=?').get(second.step.id)!.state,'queued');
});
test('existing image group accepts its own revision advance and single background approval sends the original task once',async t=>{
 let seed=true,enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});let posts=0;
 const f=await fixture(t,{imageOptions:{generate:async(snapshot,context)=>{if(seed)return createMockImageAdapter().generate(snapshot,context);enter();await barrier;return createMockImageAdapter().generate(snapshot,{...context,beforeDispatch:()=>{if(typeof context.beforeDispatch!=='function')throw Error('Missing host dispatch fence');context.beforeDispatch();posts++;}});}}});
 const input={name:'Existing group',prompt:'Seed synthetic group',providerId:'mock',model:'mock-image-v1',options:{...IMAGE_FIXED_OPTIONS}},acceptedSeed=await f.services.call('image.generate',{...input,projectId:f.projectId,requestId:randomUUID()});if(!record(acceptedSeed)||typeof acceptedSeed.id!=='string'||typeof acceptedSeed.groupId!=='string')throw Error('Invalid seed task');
 async function until(check:()=>boolean):Promise<void>{const deadline=Date.now()+30_000;while(!check()){if(Date.now()>=deadline)assert.fail('Synthetic image task did not settle');await delay(10);}}
 await until(()=>f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(acceptedSeed.id as string)?.state==='succeeded');seed=false;
 const group=await f.services.call('image.group.get',{projectId:f.projectId,groupId:acceptedSeed.groupId});if(!record(group)||typeof group.id!=='string'||typeof group.revision!=='number')throw Error('Invalid existing group');
 f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'stopped');
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();await settings.put({expectedRevision:0,configuration:initial.configuration,secret:{action:'replace',storage:'session',value:'SYNTHETIC_EXISTING_IMAGE_GROUP_ONLY'}});
 const authorizations=createTestAuthorizations(()=>({...f.store}),settings);await authorizeTestScope(authorizations,'project_agent');let modelCalls=0;
 const args={...input,prompt:'Same group second synthetic version',groupId:group.id,expectedRevision:group.revision};
 const gateway:TaskGateway=async function*(){const output:TaskModelOutput={text:'Synthetic image queued',toolCalls:[],providerOutput:[]};modelCalls++;if(modelCalls===1)output.toolCalls=[{id:'load-existing-image-group-tools',name:'mioon_tools_load',arguments:{groups:['images']}}];else if(modelCalls===2)output.toolCalls=[{id:'existing-image-group-call',name:'mioon_image_generate',arguments:args}];output.providerOutput=output.toolCalls.map(call=>({type:'function_call',id:`fc_${call.id}`,call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'}));yield {type:'done',output};};
 const runtime=createAgentTaskRuntime({store:f.store,agentSettings:settings,authorizations,tools:f.tools,journal:f.journal,gateway,selfPort:()=>4318});
 try{
  runtime.updatePolicy({requestId:randomUUID(),expectedRevision:runtime.policy().revision,stepLimit:30,modes:{...runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
  const sent=await runtime.send(f.projectId,{requestId:randomUUID(),text:'Generate the next version in the selected group',expectedSettingsRevision:(await settings.get()).revision});await entered;await runtime.drain();
  const completed=runtime.get(f.projectId,sent.run.id),step=completed.steps.find(item=>item.toolCall?.name==='mioon_image_generate');if(!step)throw Error('Missing accepted image step');const target=step.targets?.find(item=>item.kind==='image_group'&&item.id===group.id);assert.ok(target);
  assert.equal(completed.steps.filter(item=>item.toolCall?.name==='mioon_tools_load'&&item.status==='completed').length,1);assert.equal(completed.run.stepsUsed,5);
  const admittedRevision=f.journal.targetRevision(f.projectId,'image_group',group.id);assert.ok(admittedRevision>target.revision,'acceptance advances the existing group target itself');
  const task=f.store.db.prepare('SELECT id,state FROM image_tasks WHERE requestId=?').get(step.id)!;assert.equal(task.state,'queued');
  runtime.updatePolicy({requestId:randomUUID(),expectedRevision:runtime.policy().revision,stepLimit:30,modes:{...runtime.policy().modes,paid:'confirm'}});release();
  await until(()=>runtime.get(f.projectId,sent.run.id).run.status==='awaiting_approval');const pending=runtime.get(f.projectId,sent.run.id);assert.equal(pending.steps.find(item=>item.id===step.id)?.approvalRequired,true);assert.equal(posts,0);assert.equal(f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(task.id)!.state,'queued');
  await runtime.action(f.projectId,sent.run.id,{requestId:randomUUID(),action:'approve',stepId:step.id,expectedRevision:pending.run.revision});await runtime.drain();await until(()=>f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(task.id)?.state==='succeeded');
  assert.equal(posts,1);assert.equal(modelCalls,3);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks WHERE requestId=?').get(step.id)!.n,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_versions WHERE taskId=?').get(task.id)!.n,1);resumeAgentTaskJobs(f.store.db,sent.run.id);await delay(10);assert.equal(posts,1);assert.equal(runtime.get(f.projectId,sent.run.id).backgroundPending,false);
 }finally{release();runtime.close();await runtime.drain();await settings.close();}
});
test('an unstarted frame task remains queued across a blocked final fence and resumes its original request once',async t=>{
 let enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});let decodes=0;
 const f=await fixture(t,{frameOptions:{decode:async input=>{if(!input?.signal||!input.beforeSpawn)throw Error('Missing frame fence');enter();await barrier;input.beforeSpawn(input.signal);decodes++;throw Object.assign(Error('Synthetic decoder found no frame'),{code:'FRAME_NO_FRAME'});}}}),bytes=Buffer.from('Synthetic frame source'),id=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex'),relativePath=`media/${id}.mp4`;
 await writeFile(path.join(f.root,relativePath),bytes,{mode:0o600});f.store.put('assets',{id,projectId:f.projectId,name:'Source.mp4',mimeType:'video/mp4',sha256,relativePath,sizeBytes:bytes.length,duration:2,width:32,height:32,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});
 let allowed=true;const remove=setAgentTaskEffectGate(f.store.db,()=>{if(!allowed)throw Object.assign(Error('paused'),{code:'AGENT_TASK_PAUSED'});});t.after(remove);
 const accepted=await f.execute('frame.extract',{sourceAssetId:id,sourceHash:sha256,sourceFrame:0});await entered;allowed=false;release();await delay(20);
 const blocked=f.store.db.prepare('SELECT id,requestId,state,started FROM frame_tasks').get()!;assert.equal(blocked.state,'queued');assert.equal(blocked.started,0);assert.equal(decodes,0);
 allowed=true;resumeAgentTaskJobs(f.store.db,f.run.id);
 for(let i=0;i<200;i++){if(f.store.db.prepare('SELECT state FROM frame_tasks').get()?.state==='failed')break;await delay(5);}
 const resumed=f.store.db.prepare('SELECT id,requestId,state,started FROM frame_tasks').get()!;assert.equal(resumed.id,blocked.id);assert.equal(resumed.requestId,blocked.requestId);assert.equal(resumed.requestId,accepted.step.id);assert.equal(resumed.started,1);assert.equal(resumed.state,'failed');assert.equal(decodes,1);
 resumeAgentTaskJobs(f.store.db,f.run.id);await delay(10);assert.equal(decodes,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM frame_requests').get()!.n,1);
});
test('a queued v2 render paused during preparation starts no encoding and resumes the same export once',async t=>{
 const f=await fixture(t),result=await createMockImageAdapter().generate({providerId:'mock',model:'mock-image-v1',prompt:'Synthetic local render source',options:{...IMAGE_FIXED_OPTIONS}},{beforeDispatch:()=>{}}),id=randomUUID(),relativePath=`media/${id}.png`;
 await writeFile(path.join(f.root,relativePath),result.bytes,{mode:0o600});f.store.put('assets',{id,projectId:f.projectId,name:'Synthetic source.png',mimeType:'image/png',sha256:createHash('sha256').update(result.bytes).digest('hex'),relativePath,sizeBytes:result.bytes.length,width:1024,height:1024,duration:0,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});
 const timeline=await f.services.call('timeline.get',{projectId:f.projectId});if(!record(timeline)||!Array.isArray(timeline.tracks)||!record(timeline.tracks[0]))throw Error('Invalid timeline');
 await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:1,assetId:id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:1});
 const accepted=await f.execute('timeline.render',{expectedRevision:2,purpose:'export'});let allowed=true,paused=false,encodes=0;
 const remove=setAgentTaskEffectGate(f.store.db,()=>{if(!allowed)throw Object.assign(Error('paused'),{code:'AGENT_TASK_PAUSED'});}),off=onMediaProcess(event=>{if(event.type==='started'&&event.kind==='ffprobe'&&!paused){paused=true;allowed=false;}if(event.type==='started'&&event.kind==='ffmpeg')encodes++;});t.after(remove);t.after(off);
 const worker=startWorker(f.store,f.services,new Map());
 try{await worker.tick();assert.equal(paused,true);assert.equal(encodes,0);const blocked=f.store.list('exports',f.projectId)[0] as Record<string,unknown>;assert.equal(blocked.status,'queued');assert.equal(blocked.requestId,accepted.step.id);
  allowed=true;await worker.tick();const completed=f.store.list('exports',f.projectId)[0] as Record<string,unknown>;assert.equal(completed.id,blocked.id);assert.equal(completed.status,'succeeded');assert.ok(encodes>0);const count=encodes;await worker.tick();assert.equal(encodes,count);assert.equal(f.store.list('exports',f.projectId).length,1);
 }finally{await worker.stop();}
});
test('media observation rechecks task authority after an async boundary and before hashing or probing again',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Local synthetic source; revocation must prevent probing'),id=randomUUID(),relativePath=`media/${id}.mp4`,sha256=createHash('sha256').update(bytes).digest('hex');
 await writeFile(path.join(f.root,relativePath),bytes,{mode:0o600});f.store.put('assets',{id,projectId:f.projectId,name:'Observation.mp4',mimeType:'video/mp4',sha256,relativePath,sizeBytes:bytes.length,duration:2,width:32,height:32,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});
 const timeline=await f.services.call('timeline.get',{projectId:f.projectId});if(!record(timeline)||!Array.isArray(timeline.tracks)||!record(timeline.tracks[0]))throw Error('Invalid timeline');
 await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:1,assetId:id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:30});
 const processes:unknown[]=[],off=onMediaProcess(event=>processes.push(event));t.after(off);
 for(const [operation,input] of [['timeline.colour.source.inspect',{assetId:id}],['timeline.export.preflight',{expectedRevision:2}],['frame.extract',{sourceAssetId:id,sourceHash:sha256,sourceFrame:0}]] as const){
  let allowed=true,fences=0,denials=0;
  await assert.rejects(f.execute(operation,input,{beforeEffect:()=>{fences++;if(!allowed){denials++;throw Object.assign(Error('revoked'),{code:'AGENT_TASK_CONSENT_REQUIRED'});}if(fences===1)queueMicrotask(()=>{allowed=false;});}}),{code:'AGENT_TASK_CONSENT_REQUIRED'});
  assert.ok(fences>1);assert.ok(denials>=1);assert.equal(processes.length,0,'no local probe is launched after revocation');
 }
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM frame_tasks').get()!.n,0,'revoked source hashing cannot accept frame work');
});
test('trusted task approval bridges the existing image review and retains uncertain cost evidence without network',async t=>{
 const settings=await createImageSettings({persistence:{load:async()=>null,save:async()=>{}}});t.after(()=>settings.close());
 await settings.put({expectedRevision:0,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:true},secret:{action:'replace',storage:'session',value:'SYNTHETIC_IMAGE_GATEWAY_ONLY'}});
 let submitted=0;const f=await fixture(t,{imageOptions:{settings,liveGateway:{generate:async(_input,context={})=>{if(typeof context.beforeDispatch!=='function')throw Error('Missing dispatch fence');context.beforeDispatch();submitted++;throw Object.assign(Error('Synthetic lost response; no network transport exists'),{code:'IMAGE_OUTCOME_UNKNOWN'});}}}});
 await f.services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
 const remove=setAgentTaskEffectGate(f.store.db,()=>{});t.after(remove);
 const input={name:'Synthetic reviewed image',prompt:'Never sent to a provider',providerId:'openai',model:IMAGE_MODELS.openai,options:{...IMAGE_FIXED_OPTIONS}};
 await assert.rejects(f.services.call('image.generate',{...input,projectId:f.projectId,requestId:randomUUID()}),{code:'IMAGE_REVIEW_REQUIRED'});
 const result=await f.execute('image.generate',input);
 for(let i=0;i<100;i++){if(f.store.db.prepare('SELECT state FROM image_tasks LIMIT 1').get()?.state==='outcome_unknown')break;await delay(5);}
 assert.equal(submitted,1);assert.equal(f.store.db.prepare('SELECT state FROM image_reviews LIMIT 1').get()!.state,'dispatched');assert.equal(f.store.db.prepare('SELECT postAttempts FROM image_reviews LIMIT 1').get()!.postAttempts,1);
 assert.equal(f.journal.step(result.step.id).cost,'unknown');
 const task=f.store.db.prepare('SELECT id FROM image_tasks LIMIT 1').get()!;await assert.rejects(f.tools.wait(f.projectId,{kind:'image',id:task.id}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(submitted,1);
});
test('video worker has a final grant fence after its durable claim and never resubmits a blocked attempt',async t=>{
 let enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});let posts=0;
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){enter();await barrier;context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-only'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,{},providers),shot=await f.shot('Synthetic generation');
 let allowed=true;const remove=setAgentTaskEffectGate(f.store.db,()=>{if(!allowed)throw Object.assign(Error('revoked'),{code:'AGENT_TASK_CONSENT_REQUIRED'});});t.after(remove);
 const accepted=await f.execute('generation.submit',{shotId:shot.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'});
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_task_job_origins_v2').get()!.n,1);
 const worker=startWorker(f.store,f.services,providers);
 try{await entered;allowed=false;release();await worker.tick();await worker.tick();
  assert.equal(posts,0);const blocked=f.store.list('jobs',f.projectId)[0] as Record<string,unknown>;assert.equal(blocked.status,'queued');assert.equal(blocked.submissionCount,0);assert.equal(f.journal.step(accepted.step.id).cost,undefined);
  allowed=true;await worker.tick();await worker.tick();assert.equal(posts,1);assert.equal((f.store.list('jobs',f.projectId)[0] as Record<string,unknown>).id,blocked.id);assert.equal(f.store.list('jobs',f.projectId).length,1);
 }finally{release();await worker.stop();}
});
test('stopping a claimed but unsent video task finishes local cancellation after the final fence',async t=>{
 let enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});let posts=0;
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(_snapshot,context){enter();await barrier;context.beforeSubmit?.();posts++;return {providerJobId:'never-sent'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,{},providers),shot=await f.shot('Stopped claimed source'),remove=setAgentTaskEffectGate(f.store.db,()=>{if(f.journal.run(f.run.id).status==='stopped')throw Object.assign(Error('Stopped'),{code:'AGENT_TASK_STOPPED'});});t.after(remove);
 await f.execute('generation.submit',{shotId:shot.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'});const worker=startWorker(f.store,f.services,providers);
 try{await entered;assert.equal((f.store.list('jobs',f.projectId)[0] as Record<string,unknown>).status,'submitting');f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'stopped');stopAgentTaskJobs(f.store.db,f.run.id);assert.equal(f.journal.snapshot(f.run.id).backgroundPending,true);release();await worker.tick();await worker.tick();
  const finished=f.store.list('jobs',f.projectId)[0] as Record<string,unknown>;assert.equal(finished.status,'cancelled');assert.equal(finished.submissionCount,0);assert.equal(f.journal.snapshot(f.run.id).backgroundPending,false);assert.equal(posts,0);
 }finally{release();await worker.stop();}
});
test('background automatic selection retains products but pauses on a saved or draft target conflict',async t=>{
 const f=await fixture(t),shot=await f.shot('Selected target'),target={kind:'shot',id:shot.id,revision:f.journal.targetRevision(f.projectId,'shot',shot.id)},step=f.journal.beginStep(f.run.id,{kind:'tool',targets:[target]});f.journal.markDispatch(f.run.id,step.id);f.journal.completeStep(f.run.id,step.id,{result:{accepted:true}});
 f.store.tx(()=>f.store.db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run('job','synthetic-result',f.run.id,step.id,f.projectId,step.id,'generation.submit'));
 const remove=setAgentTaskEffectGate(f.store.db,()=>{});t.after(remove);assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job','synthetic-result',{kind:'shot',id:shot.id}),true);
 f.journal.claim({projectId:f.projectId,ownerId:randomUUID(),targets:[target]});
 assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job','synthetic-result',{kind:'shot',id:shot.id}),false);assert.equal(f.journal.run(f.run.id).status,'paused');assert.equal(f.journal.run(f.run.id).pauseReason,'editing');assert.ok(f.journal.events(f.run.id).some(event=>event.type==='conflict'));const source=f.journal.step(step.id).data;assert.ok(record(source));assert.deepEqual(source.conflictTargets,[target]);
});
for(const action of ['revoke_grant','disable_paid_direct'] as const)test(`real runtime ${action} after video claim blocks its synthetic POST`,async t=>{
 let enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});let posts=0;
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(_snapshot,context){enter();await barrier;context.beforeSubmit?.();posts++;return {providerJobId:'never-actually-sent'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,{},providers),shot=await f.shot('Real gate source');f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'stopped');
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();await settings.put({expectedRevision:0,configuration:initial.configuration,secret:{action:'replace',storage:'session',value:'SYNTHETIC_TASK_GATE_ONLY'}});
 const authorizations=createTestAuthorizations(()=>({...f.store}),settings);await authorizeTestScope(authorizations,'project_agent');let modelCalls=0;
 const gateway:TaskGateway=async function*(){const output:TaskModelOutput={text:'Queued synthetic task',toolCalls:[],providerOutput:[]};modelCalls++;if(modelCalls===1)output.toolCalls=[{id:'load-synthetic-generation-tools',name:'mioon_tools_load',arguments:{groups:['video']}}];else if(modelCalls===2){const args={shotId:shot.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'};output.toolCalls=[{id:'synthetic-generation-call',name:'mioon_generation_submit',arguments:args}];}output.providerOutput=output.toolCalls.map(call=>({type:'function_call',id:`fc_${call.id}`,call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'}));yield {type:'done',output};};
 const runtime=createAgentTaskRuntime({store:f.store,agentSettings:settings,authorizations,tools:f.tools,journal:f.journal,gateway,selfPort:()=>4318});let worker:ReturnType<typeof startWorker>|undefined;
 try{
  runtime.updatePolicy({requestId:randomUUID(),expectedRevision:runtime.policy().revision,stepLimit:30,modes:{...runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
  const sent=await runtime.send(f.projectId,{requestId:randomUUID(),text:'Queue synthetic generation',expectedSettingsRevision:(await settings.get()).revision});await runtime.drain();const completed=runtime.get(f.projectId,sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(completed.run.stepsUsed,5);assert.equal(completed.steps.filter(item=>item.toolCall?.name==='mioon_tools_load'&&item.status==='completed').length,1);
  worker=startWorker(f.store,f.services,providers);await entered;
  if(action==='revoke_grant'){const current=await authorizations.list(),grant=current.authorizations.find(item=>item.scope==='project_agent');assert.ok(grant);await authorizations.revoke({requestId:randomUUID(),expectedRevision:current.revision,authorizationId:grant.id});}
  else runtime.updatePolicy({requestId:randomUUID(),expectedRevision:runtime.policy().revision,stepLimit:30,modes:{...runtime.policy().modes,paid:'confirm'}});
  release();await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal((f.store.list('jobs',f.projectId)[0] as Record<string,unknown>).status,'queued');assert.equal(modelCalls,3);
 }finally{release();await worker?.stop();runtime.close();await runtime.drain();await settings.close();}
});
for(const action of ['send','revoke_task_authority','disable_workspace_live'] as const)test(`configured video v2 ${action} preserves the frozen connection credential and final dispatch gates`,async t=>{
 const directory=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-task-video-settings-')),settings=await createVideoSettings({directory:path.join(directory,'settings'),privateRoot:directory});
 const configuration:VideoConnectionConfiguration={id:randomUUID(),providerId:'ark',name:'Synthetic configured v2 Ark',region:'cn-beijing',workspaceId:'',enabled:true,archived:false,outputHosts:[],models:defaultVideoModels('ark')};
 await settings.put({action:'save',expectedRevision:0,configuration,secret:{action:'replace',storage:'session',value:'SYNTHETIC_BOUND_VIDEO_KEY'}});
 let enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(resolve=>{enter=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
 const bound:VideoSettingsService={...settings,async acquire(binding,signal){const key=await settings.acquire(binding,signal);enter();await barrier;return key;}};
 let posts=0,authorization='';const f=await fixture(t,{videoSettings:bound,profileNow:()=>Date.UTC(2026,9,20),videoFetch:async(_input,init)=>{if(init?.method==='POST'){posts++;authorization=new Headers(init.headers).get('Authorization')??'';}return new Response(JSON.stringify({id:'synthetic-configured-v2-task',status:'running'}),{headers:{'content-type':'application/json'}});}});
 t.after(async()=>{await settings.close();await rm(directory,{recursive:true,force:true});});
 await f.services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
 const shot=await f.services.call('shot.create',{projectId:f.projectId,title:'Configured synthetic video',prompt:'Synthetic geometry moves',duration:4,aspectRatio:'9:16'});if(!record(shot))throw Error('Invalid shot');
 const listed=await f.execute('video.connection.list',{});assert.doesNotMatch(JSON.stringify(listed.outcome.result),/SYNTHETIC_BOUND_VIDEO_KEY|credentialRef/);
 const model=configuration.models[0]!;const accepted=await f.execute('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId:'ark',model:model.modelId,connectionId:configuration.id,configurationRevision:1,modelEntryId:model.id,parameters:{resolution:'720p'}});
 let allowed=true;const remove=setAgentTaskEffectGate(f.store.db,()=>{if(!allowed)throw Object.assign(Error('Task authority revoked'),{code:'AGENT_TASK_CONSENT_REQUIRED'});});t.after(remove);
 const worker=startWorker(f.store,f.services,new Map());
 try{await entered;const original=f.store.list('jobs',f.projectId)[0] as Record<string,unknown>;
  if(action==='revoke_task_authority')allowed=false;
  if(action==='disable_workspace_live')await f.services.call('workspace.settings.set',{expectedRevision:1,liveGeneration:false});
  release();await worker.tick();
  const current=f.store.list('jobs',f.projectId)[0] as Record<string,unknown>;assert.equal(current.id,original.id);assert.equal(f.store.list('jobs',f.projectId).length,1);
  if(action==='send'){assert.equal(posts,1);assert.equal(authorization,'Bearer SYNTHETIC_BOUND_VIDEO_KEY');assert.equal(current.status,'running');assert.equal(f.journal.step(accepted.step.id).cost,'submitted');}
  else{assert.equal(posts,0);assert.equal(f.journal.step(accepted.step.id).cost,undefined);if(action==='revoke_task_authority'){assert.equal(current.status,'queued');assert.equal(current.submissionCount,0);}else{assert.equal(current.status,'failed');assert.ok(record(current.error));assert.equal(current.error.code,'LIVE_GENERATION_DISABLED');}}
 }finally{release();await worker.stop();}
});

test('explicit local task observations retain references without claiming mutation targets',async t=>{
 const f=await acceptedGeneratedShot(t),job=f.store.list('jobs',f.projectId)[0];assert.ok(record(job)&&typeof job.id==='string');
 for(const [operation,input] of [['task.wait',{kind:'job',id:job.id}],['task.disposition.list',{targets:[{kind:'generation',taskId:job.id}]}]] as const){const prepared=f.tools.prepare({projectId:f.projectId,operation,input});assert.deepEqual(prepared.targets,[]);assert.deepEqual(prepared.referencedTargets?.map(target=>({kind:target.kind,id:target.id})),[{kind:'job',id:job.id}]);assert.equal(prepared.risk,'read_only');}
 const seen:{kind:string;id:string}[]=[];assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'version.list',input:{shotId:f.shotId},beforeTargetRead:target=>{seen.push(target);throw Object.assign(Error('target skipped'),{code:'AGENT_TASK_TARGET_SKIPPED'});}}),{code:'AGENT_TASK_TARGET_SKIPPED'});assert.deepEqual(seen,[{kind:'shot',id:f.shotId}]);
 const missing=randomUUID();assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'version.list',input:{shotId:missing},beforeTargetRead:target=>{assert.equal(target.id,missing);throw Object.assign(Error('target skipped before ownership lookup'),{code:'AGENT_TASK_TARGET_SKIPPED'});}}),{code:'AGENT_TASK_TARGET_SKIPPED'});
});

test('validated explicit identity paths are checked before missing project or target reads',async t=>{
 const f=await fixture(t),missing=randomUUID(),other=randomUUID(),projectId=randomUUID();
 const colour={profileId:'mioon-rec709-sdr-clip-v1',source:null,look:{resourceId:missing,resourceSha256:'a'.repeat(64),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}};
 const cases:Array<{operation:string;input:Record<string,unknown>;kind:string;id?:string}>=[
  {operation:'timeline.clip.add',input:{assetId:other,trackId:missing,expectedRevision:1,startFrame:0,durationFrames:30},kind:'timeline_track'},
  {operation:'timeline.clip.update',input:{clipId:other,expectedRevision:1,patch:{trackId:missing}},kind:'timeline_track'},
  {operation:'shot.create',input:{title:'New shot',referenceAssetIds:[missing]},kind:'asset'},
  {operation:'shot.create',input:{title:'New shot',lastFrameAssetId:missing},kind:'asset'},
  {operation:'shot.update',input:{shotId:other,expectedRevision:1,patch:{referenceAssetIds:[missing]}},kind:'asset'},
  {operation:'shot.update',input:{shotId:other,expectedRevision:1,patch:{lastFrameAssetId:missing}},kind:'asset'},
  {operation:'image.generate',input:{name:'Edited image',providerId:'mock',model:IMAGE_MODELS.mock,prompt:'Edit the selected image',options:IMAGE_FIXED_OPTIONS,purpose:'edit',inputImage:{assetId:missing,sha256:'a'.repeat(64)}},kind:'asset'},
  {operation:'lut.inspect',input:{lutId:missing},kind:'lut'},
  {operation:'timeline.clip.add',input:{assetId:other,trackId:other,expectedRevision:1,startFrame:0,durationFrames:30,colour},kind:'lut'},
  {operation:'timeline.clip.update',input:{clipId:other,expectedRevision:1,patch:{colour}},kind:'lut'},
  {operation:'timeline.audioPreview.plan',input:{timelineId:missing,expectedRevision:1,startFrame:0},kind:'timeline',id:projectId},
  {operation:'asset.range.get',input:{assetId:missing},kind:'asset_range'},
 ];
 for(const item of cases){let checked=false;assert.throws(()=>f.tools.prepare({projectId,operation:item.operation,input:item.input,beforeTargetRead:target=>{if(target.kind===item.kind&&target.id===(item.id??missing)){checked=true;throw Object.assign(Error('Skipped before any saved-target lookup'),{code:'AGENT_TASK_TARGET_SKIPPED'});}}}),{code:'AGENT_TASK_TARGET_SKIPPED'},item.operation);assert.equal(checked,true,item.operation);}
});

test('nested references are deduplicated without adding mutation authority or interpreting prose',async t=>{
 const f=await fixture(t),assetId=randomUUID(),literal=randomUUID();
 const prepared=f.tools.prepare({projectId:f.projectId,operation:'shot.create',input:{title:`asset ${literal}`,prompt:JSON.stringify({assetId:literal,trackId:literal}),referenceAssetIds:[assetId,assetId],lastFrameAssetId:assetId,parameters:{seed:42}}});
 assert.deepEqual(prepared.targets,[]);assert.deepEqual(prepared.referencedTargets,[{kind:'asset',id:assetId,revision:0}]);
 const cleared=f.tools.prepare({projectId:f.projectId,operation:'shot.create',input:{title:literal,lastFrameAssetId:null}});assert.deepEqual(cleared.referencedTargets,[]);
 const image=f.tools.prepare({projectId:f.projectId,operation:'image.generate',input:{name:'Edit image',providerId:'mock',model:IMAGE_MODELS.mock,prompt:literal,options:IMAGE_FIXED_OPTIONS,purpose:'edit',inputImage:{assetId,sha256:'a'.repeat(64)}}});
 assert.deepEqual(image.targets,[]);assert.deepEqual(image.referencedTargets,[{kind:'asset',id:assetId,revision:0}]);
});

test('clip destination references stay separate from exact mutation and revision targets',async t=>{
 const f=await fixture(t),assetId=randomUUID();f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic image',mimeType:'image/png',width:720,height:1280,duration:0,hasVideo:true,hasAudio:false,sha256:'b'.repeat(64),relativePath:'media/fixture.png',provenance:'user-import',createdAt:new Date().toISOString()});
 const timeline=await f.services.call('timeline.get',{projectId:f.projectId});assert.ok(record(timeline)&&Array.isArray(timeline.tracks)&&record(timeline.tracks[0])&&record(timeline.tracks[1]));const first=timeline.tracks[0].id,second=timeline.tracks[1].id;assert.equal(typeof first,'string');assert.equal(typeof second,'string');
 await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),assetId,trackId:first,expectedRevision:1,startFrame:0,durationFrames:30});
 const row=f.store.db.prepare("SELECT json_extract(data,'$.clips[0].id') AS id FROM timelines WHERE projectId=?").get(f.projectId)!;assert.equal(typeof row.id,'string');
 const prepared=f.tools.prepare({projectId:f.projectId,operation:'timeline.clip.update',input:{clipId:row.id,expectedRevision:2,patch:{trackId:second}}});
 assert.deepEqual(prepared.targets.map(target=>({kind:target.kind,id:target.id})),[{kind:'timeline_clip',id:row.id}]);assert.deepEqual(prepared.referencedTargets?.map(target=>({kind:target.kind,id:target.id})),[{kind:'timeline_clip',id:row.id},{kind:'timeline_track',id:second}]);
 await f.services.call('timeline.track.update',{projectId:f.projectId,requestId:randomUUID(),trackId:second,expectedRevision:2,patch:{name:'Manual rename outside the clip footprint'}});
 f.journal.claim({projectId:f.projectId,ownerId:'destination-track-draft',targets:[{kind:'timeline_track',id:String(second),revision:f.journal.targetRevision(f.projectId,'timeline_track',String(second))}]});
 assert.doesNotThrow(()=>f.journal.assertTargets(f.projectId,prepared.targets));
});

test('saved argument reference fallback treats canonical and model tool names identically',()=>{
 const projectId=randomUUID(),id=randomUUID(),other=randomUUID();
 for(const [operation,input,expected] of [
  ['timeline.clip.update',{clipId:other,patch:{trackId:id}},[{kind:'timeline_clip',id:other},{kind:'timeline_track',id}]],
  ['shot.update',{shotId:other,patch:{referenceAssetIds:[id],lastFrameAssetId:id}},[{kind:'shot',id:other},{kind:'asset',id}]],
  ['image.generate',{inputImage:{assetId:id,sha256:'a'.repeat(64)}},[{kind:'asset',id}]],
  ['frame.task.get',{taskId:id},[{kind:'frame_task',id}]],
  ['task.wait',{kind:'image',id},[{kind:'image_task',id}]],
  ['node.inspect',{limit:20,after:id},[]],
  ['edge.inspect',{limit:20,after:id},[]],
  ['asset.importSelected',{handle:id},[]],
  ['lut.importSelected',{handle:id},[]],
 ] as const){const model=`mioon_${operation.replaceAll('.','_').replace('importSelected','import_selected')}`;assert.deepEqual(agentTaskExplicitTargets(operation,input,projectId),expected,operation);assert.deepEqual(agentTaskExplicitTargets(model,input,projectId),expected,model);}
 assert.deepEqual(agentTaskExplicitTargets('shot.create',{title:id,prompt:JSON.stringify({assetId:id})},projectId),[]);
 assert.deepEqual(agentTaskExplicitTargets('image.generate',null,projectId),[]);
});

for(const metadata of ['saved','legacy'] as const)test(`late selection recognizes a skipped reference with ${metadata} metadata without another conflict`,async t=>{
 const f=await fixture(t),shot=await f.shot('Late product target'),reference={kind:'asset',id:randomUUID(),revision:0},target={kind:'shot',id:shot.id,revision:f.journal.targetRevision(f.projectId,'shot',shot.id)};
 const source=f.journal.beginStep(f.run.id,{kind:'tool',targets:[reference],data:{conflictTargets:[reference]}});f.store.tx(()=>f.journal.skipTargetsInside(f.run.id,[{stepId:source.id,target:reference}]));
 const accepted=f.journal.beginStep(f.run.id,{kind:'tool',targets:[target],toolCall:{id:randomUUID(),name:'mioon_image_generate',arguments:{name:'Synthetic retained edit',providerId:'mock',model:IMAGE_MODELS.mock,prompt:'Retained input',options:IMAGE_FIXED_OPTIONS,purpose:'edit',inputImage:{assetId:reference.id,sha256:'a'.repeat(64)}}},...(metadata==='saved'?{data:{referencedTargets:[reference]}}:{})});
 f.store.tx(()=>f.store.db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run('job','synthetic-reference-result',f.run.id,accepted.id,f.projectId,accepted.id,'generation.submit'));
 const remove=setAgentTaskEffectGate(f.store.db,()=>{throw Object.assign(Error('Explicit reference was skipped'),{code:'AGENT_TASK_TARGET_SKIPPED'});});t.after(remove);
 assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job','synthetic-reference-result',{kind:'shot',id:shot.id}),false);assert.equal(f.journal.run(f.run.id).status,'running');
 const event=f.journal.events(f.run.id).at(-1)!;assert.equal(event.type,'background_selection_skipped');assert.ok(record(event.data));assert.equal(event.data.reason,'target_skipped');assert.equal(f.journal.events(f.run.id).some(item=>item.type==='conflict'),false);
});

for(const kind of ['asset_range','asset_disposition','asset_annotation','subject_binding'] as const)test(`undo preview preserves the existing first ${kind} metadata compensation`,async t=>{
 const f=await fixture(t),assetId=randomUUID();f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic source',mimeType:kind==='asset_range'?'video/mp4':'image/png',width:640,height:480,duration:4,hasVideo:true,hasAudio:false,relativePath:'media/synthetic-fixture',sha256:'a'.repeat(64),provenance:'user-import'});
 let operation:string,input:Record<string,unknown>;
 if(kind==='asset_range'){operation='asset.range.set';input={assetId,expectedRevision:0,inFrame:0,outFrame:30};}
 else if(kind==='asset_disposition'){operation='asset.disposition.set';input={assetId,expectedRevision:0,disposition:'favorite'};}
 else if(kind==='asset_annotation'){operation='asset.annotation.set';input={assetId,expectedRevision:0,tags:['Synthetic'],note:'Synthetic note'};}
 else{const subject=await f.services.call('subject.create',{projectId:f.projectId,requestId:randomUUID(),kind:'character',name:'Synthetic subject',assetId});assert.ok(record(subject));const shot=await f.shot('Bound shot');operation='subject.binding.set';input={shotId:shot.id,subjectId:subject.id,role:'subject',subjectVersionId:subject.headVersionId,expectedRevision:0,expectedSubjectRevision:subject.revision};}
 const created=await f.execute(operation,input),change=created.changes[0]!;assert.equal(created.changes.length,1);assert.equal(change.targets[0]?.kind,kind);assert.equal(projectAgentTaskUndo(f.store,f.projectId,[change]).get(change.id)?.undoDisposition,'undo');
 f.undo(change);assert.equal(f.journal.snapshot(f.run.id).changes[0]?.status,'reverted');
 if(kind==='asset_range')assert.equal(f.store.db.prepare('SELECT 1 FROM asset_ranges WHERE assetId=?').get(assetId),undefined);
 else if(kind==='asset_disposition')assert.equal(f.store.db.prepare('SELECT disposition FROM asset_dispositions WHERE assetId=?').get(assetId)?.disposition,'neutral');
 else if(kind==='asset_annotation'){const row=f.store.db.prepare('SELECT tags,note FROM asset_annotations WHERE assetId=?').get(assetId);assert.equal(row?.tags,'[]');assert.equal(row?.note,'');}
 else assert.equal(f.store.db.prepare('SELECT subjectVersionId FROM subject_bindings WHERE id=?').get(change.targets[0]!.id)?.subjectVersionId,null);
 assert.ok(f.store.get('assets',assetId));
});

for(const owner of ['manual','same_run'] as const)test(`whole undo preview respects a ${owner} clip depending on a newly created track`,async t=>{
 const f=await fixture(t),assetId=randomUUID();f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic image',mimeType:'image/png',width:720,height:1280,duration:0,hasVideo:true,hasAudio:false,sha256:'a'.repeat(64),relativePath:'media/fixture.png',provenance:'user-import',createdAt:new Date().toISOString()});
 await f.services.call('timeline.get',{projectId:f.projectId});const created=await f.execute('timeline.track.add',{kind:'video',name:'AI track',expectedRevision:1}),change=created.changes[0]!,trackId=change.targets.find(target=>target.kind==='timeline_track')!.id;
 const input={expectedRevision:2,assetId,trackId,startFrame:0,durationFrames:30,name:'Later clip'};
 if(owner==='manual'){
  await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),...input});assert.deepEqual(projectAgentTaskUndo(f.store,f.projectId,[change]).get(change.id),{modifiedAfter:false,undoDisposition:'blocked'});assert.throws(()=>f.undo(change),{code:'AGENT_TASK_TARGET_CHANGED'});
  const timeline=await f.services.call('timeline.inspect',{projectId:f.projectId});assert.ok(record(timeline)&&Array.isArray(timeline.clips));assert.equal(timeline.clips.length,1);
 }else{
  const clip=await f.execute('timeline.clip.add',input),changes=f.journal.snapshot(f.run.id).changes;assert.deepEqual([...projectAgentTaskUndo(f.store,f.projectId,changes).values()].map(value=>value.undoDisposition),['undo','undo']);f.undo(clip.changes[0]!);f.undo(change);
  const timeline=await f.services.call('timeline.inspect',{projectId:f.projectId});assert.ok(record(timeline)&&Array.isArray(timeline.clips)&&Array.isArray(timeline.tracks));assert.equal(timeline.clips.length,0);assert.equal(timeline.tracks.some(item=>record(item)&&item.id===trackId),false);
 }
});

for(const owner of ['manual','same_run'] as const)test(`undo preview preserves a created shot referenced by a ${owner} subject binding`,async t=>{
 const f=await fixture(t),assetId=randomUUID();f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic source',mimeType:'image/png',width:640,height:480,duration:0,hasVideo:true,hasAudio:false,relativePath:'media/synthetic-fixture',sha256:'a'.repeat(64),provenance:'user-import'});
 const created=await f.execute('shot.create',{title:'AI created shot'}),change=created.changes[0]!,shotId=change.targets.find(target=>target.kind==='shot')!.id;
 const subject=await f.services.call('subject.create',{projectId:f.projectId,requestId:randomUUID(),kind:'character',name:'Synthetic subject',assetId});assert.ok(record(subject));
 const input={shotId,subjectId:subject.id,role:'subject',subjectVersionId:subject.headVersionId,expectedRevision:0,expectedSubjectRevision:subject.revision};
 if(owner==='manual')await f.services.call('subject.binding.set',{projectId:f.projectId,requestId:randomUUID(),...input});
 else{const binding=await f.execute('subject.binding.set',input),preview=projectAgentTaskUndo(f.store,f.projectId,f.journal.snapshot(f.run.id).changes);assert.equal(preview.get(binding.changes[0]!.id)?.undoDisposition,'undo');assert.equal(preview.get(change.id)?.undoDisposition,'blocked');f.undo(binding.changes[0]!);assert.equal(f.store.db.prepare('SELECT subjectVersionId FROM subject_bindings WHERE shotId=?').get(shotId)?.subjectVersionId,null);}
 assert.deepEqual(projectAgentTaskUndo(f.store,f.projectId,[change]).get(change.id),{modifiedAfter:false,undoDisposition:'blocked'});assert.throws(()=>f.undo(change),{code:'AGENT_TASK_TARGET_CHANGED'});assert.ok(f.store.get('shots',shotId));
});
test('undo preview uses timeline validation when restoring a clip would overlap a later manual clip',async t=>{
 const f=await fixture(t),assetId=randomUUID();f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic image',mimeType:'image/png',width:720,height:1280,duration:0,hasVideo:true,hasAudio:false,sha256:'a'.repeat(64),relativePath:'media/fixture.png',provenance:'user-import',createdAt:new Date().toISOString()});
 const timeline=await f.services.call('timeline.get',{projectId:f.projectId});assert.ok(record(timeline)&&Array.isArray(timeline.tracks)&&record(timeline.tracks[0]));const trackId=timeline.tracks[0].id;
 const added=await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:1,assetId,trackId,startFrame:0,durationFrames:30});assert.ok(record(added)&&Array.isArray(added.clips)&&record(added.clips[0]));const clipId=added.clips[0].id;
 const changed=await f.execute('timeline.clip.update',{expectedRevision:2,clipId,patch:{startFrame:60}}),change=changed.changes[0]!;assert.equal(projectAgentTaskUndo(f.store,f.projectId,[change]).get(change.id)?.undoDisposition,'undo');
 await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:3,assetId,trackId,startFrame:0,durationFrames:30});assert.deepEqual(projectAgentTaskUndo(f.store,f.projectId,[change]).get(change.id),{modifiedAfter:false,undoDisposition:'blocked'});assert.throws(()=>f.undo(change),{code:'AGENT_TASK_TARGET_CHANGED'});
 const retained=await f.services.call('timeline.inspect',{projectId:f.projectId});assert.ok(record(retained)&&Array.isArray(retained.clips));assert.equal(retained.clips.length,2);assert.equal(retained.clips.find(item=>record(item)&&item.id===clipId)?.startFrame,60);
});
// Storyboards: one detected cut at frame 45 of 90 over a 32x32 synthetic video.
const storyboardDetection=async(input:{beforeSpawn:(signal:AbortSignal)=>void;signal:AbortSignal;options:unknown;asset:{sha256:string}})=>{input.beforeSpawn(input.signal);return {profileId:'scene-cuts-v1',fps:30,frameCount:90,options:input.options,cuts:[{frame:45,score:0.5}],segments:[],sourceHash:input.asset.sha256,analysis:{width:32,height:32,decodedFrames:90}};};
const storyboardFrames=async(input:{beforeSpawn:(signal:AbortSignal)=>void;signal:AbortSignal;marks:number[];asset:{sha256:string};onFrame:(frame:{index:number;marks:number[];bytes:Buffer})=>void})=>{
 input.beforeSpawn(input.signal);input.marks.forEach((_mark,index)=>input.onFrame({index,marks:[index],bytes:storyboardPng(index)}));
 return {profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1',sourceHash:input.asset.sha256,width:32,height:32,probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:32,height:32,rotation:0,sarNumerator:1,sarDenominator:1},frameOf:input.marks.map((_mark,index)=>index)};
};
function storyboardPng(index:number):Buffer{
 const chunk=(type:string,data:Buffer):Buffer=>{const value=Buffer.alloc(12+data.length);value.writeUInt32BE(data.length);value.write(type,4,'ascii');data.copy(value,8);value.writeUInt32BE(crc32(value.subarray(4,value.length-4)),value.length-4);return value;};
 const header=Buffer.alloc(13);header.writeUInt32BE(32);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;
 const rows=Buffer.alloc((32*3+1)*32,index*40+20);for(let y=0;y<32;y++)rows[y*(32*3+1)]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
async function storyboardSource(f:Awaited<ReturnType<typeof fixture>>){
 const bytes=Buffer.from('Synthetic storyboard reference; decoder replaced'),id=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex'),relativePath=`media/${id}.mp4`;
 await writeFile(path.join(f.root,relativePath),bytes,{mode:0o600});
 f.store.put('assets',{id,projectId:f.projectId,name:'Reference.mp4',mimeType:'video/mp4',sha256,relativePath,sizeBytes:bytes.length,duration:3,width:32,height:32,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:new Date().toISOString()});
 const ack=await f.services.call('scene.detect',{projectId:f.projectId,sourceAssetId:id,sourceHash:sha256,requestId:randomUUID()});assert.ok(record(ack));
 for(let i=0;i<500;i++){const value=f.services.handlers['scene.task.get']!({projectId:f.projectId,taskId:ack.id} as never);if(record(value)&&value.state==='succeeded'&&record(value.result))return {id,sha256,resultId:String(value.result.id)};await delay(5);}
 throw Error('Synthetic detection did not finish');
}
const sceneState=(f:Awaited<ReturnType<typeof fixture>>,id:string):string=>String(f.store.db.prepare('SELECT state FROM scene_tasks WHERE id=?').get(id)!.state);
test('storyboard acceptance binds its task to the step and a stopped run retires it before it starts',async t=>{
 const f=await fixture(t,{sceneOptions:{detect:storyboardDetection as never,decodeKeyframes:(async()=>{throw Error('A held storyboard must not decode');}) as never}});
 const remove=setAgentTaskEffectGate(f.store.db,()=>{throw Object.assign(Error('Paused'),{code:'AGENT_TASK_PAUSED'});});t.after(remove);
 const source=await storyboardSource(f);
 assert.deepEqual(AGENT_TASK_OPERATION_ADMISSION['scene.shots.create'],{allowed:true,tier:'local_irreversible'});assert.equal(AGENT_TASK_OPERATION_ADMISSION['scene.shots.undo'].allowed,false);
 const accepted=await f.execute('scene.shots.create',{sourceAssetId:source.id,sourceHash:source.sha256,resultId:source.resultId,segments:[1,2]});
 assert.ok(record(accepted.step.result));assert.deepEqual([accepted.step.result.kind,accepted.step.result.state,accepted.step.result.requestId],['shots','queued',accepted.step.id]);
 const taskId=String(accepted.step.result.id);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM agent_task_job_origins_v2 WHERE kind='scene' AND jobId=? AND runId=? AND stepId=?").get(taskId,f.run.id,accepted.step.id)!.n,1);
 await delay(30);assert.equal(sceneState(f,taskId),'queued','the Assistant gate holds an unstarted storyboard');
 assert.equal(f.journal.snapshot(f.run.id).backgroundPending,true);
 f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'stopped');stopAgentTaskJobs(f.store.db,f.run.id);
 assert.equal(sceneState(f,taskId),'cancelled_before_start');assert.equal(f.journal.snapshot(f.run.id).backgroundPending,false);
 const recovered=f.tools.recoverWait(f.tools.prepare({projectId:f.projectId,operation:'task.wait',input:{kind:'scene',id:taskId}}));
 assert.ok(record(recovered));assert.equal(recovered.state,'cancelled_before_start');
 assert.equal(f.store.list('shots',f.projectId).length,0);
});
test('a storyboard built for the Assistant records its images and shots as one late irreversible change',async t=>{
 const f=await fixture(t,{sceneOptions:{detect:storyboardDetection as never,decodeKeyframes:storyboardFrames as never}});
 const remove=setAgentTaskEffectGate(f.store.db,()=>{});t.after(remove);
 const source=await storyboardSource(f);
 const accepted=await f.execute('scene.shots.create',{sourceAssetId:source.id,sourceHash:source.sha256,resultId:source.resultId,segments:[1,2]});assert.ok(record(accepted.step.result));
 const taskId=String(accepted.step.result.id);
 for(let i=0;i<500&&sceneState(f,taskId)!=='succeeded';i++)await delay(5);
 assert.equal(sceneState(f,taskId),'succeeded');assert.equal(f.journal.snapshot(f.run.id).backgroundPending,false);
 const late=f.journal.snapshot(f.run.id).changes.filter(change=>change.stepId===accepted.step.id);
 assert.equal(late.length,1);assert.equal(late[0]!.operation,'scene.shots.create');assert.equal(late[0]!.reversible,false);
 assert.deepEqual(late[0]!.targets.map(target=>target.kind).sort(),['asset','asset','shot','shot'],'a revision-only project touch is no change');
 assert.equal(projectAgentTaskUndo(f.store,f.projectId,late).get(late[0]!.id)?.undoDisposition,'retain','the user undoes the batch, not the run');
 const waited=await f.execute('task.wait',{kind:'scene',id:taskId});assert.ok(record(waited.step.result));assert.equal(waited.step.result.state,'succeeded');
 assert.ok(record(waited.step.result.undo)&&waited.step.result.undo.available===true);
});
