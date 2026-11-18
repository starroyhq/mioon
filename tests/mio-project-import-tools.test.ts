import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {listAgentTaskTools,listDiagnosticAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {selectTaskModelTools,sourceTaskModelToolNames} from '../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME,AGENT_TASK_LOADABLE_TOOL_NAMES,AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES,loadedAgentTaskToolNames} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {MIO_PROJECT_FILE_IMPORT_TOOL,MIO_PROJECT_FILE_IMPORT_OPERATION,mioProjectFileImportInputSchema,mioProjectFileImportResultSchema} from '../packages/contracts/src/mio-project-import.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import type {AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {protocols,call,object,output,fixture,plan,imports} from './helpers/mio-project-import-tools-fixture.ts';

test('the import contract admits only a bounded visible project file and never host authority',()=>{
  assert.deepEqual(mioProjectFileImportInputSchema.parse({path:'素材/镜头.png'}),{path:'素材/镜头.png'});
  assert.deepEqual(mioProjectFileImportInputSchema.parse({path:'source.png',name:'Display name'}),{path:'source.png',name:'Display name'});
  assert.equal(mioProjectFileImportInputSchema.safeParse({path:'界'.repeat(1364)+'.png'}).success,true);
  const invalid:unknown[]=[{}, {path:''}, {path:'/private/source.png'}, {path:'C:/source.png'}, {path:'\\\\server\\source.png'}, {path:'../source.png'}, {path:'a/../source.png'}, {path:'.private/source.png'}, {path:'source.png:ads'}, {path:'NUL.png'}, {path:'COM¹.png'}, {path:'source\u007f.png'}, {path:'\ud800.png'}, {path:'界'.repeat(1365)+'.png'}, {path:'source.png',name:''}, {path:'source.png',name:'x'.repeat(201)}];
  for(const key of ['projectId','requestId','assetId','sourcePath','dataBase64','approved','confirmOutside','adapter'])invalid.push({path:'source.png',[key]:'forged'});
  for(const input of invalid)assert.equal(mioProjectFileImportInputSchema.safeParse(input).success,false,JSON.stringify(input));
});

test('the strict import result matches one asset and cannot carry paths or private proofs',()=>{
  const assetId=randomUUID(),projectId=randomUUID(),hash='a'.repeat(64),asset={id:assetId,projectId,name:'Imported',mimeType:'image/png',sizeBytes:20,
    referenceRevision:1,sha256:hash,fingerprint:{sizeBytes:20,mtimeMs:0,sampledSha256:hash,fullSha256:hash},hashState:'full',url:projectMediaPath(projectId,assetId)};
  const result={registration:'created',assetId,asset};assert.equal(mioProjectFileImportResultSchema.safeParse(result).success,true);
  assert.equal(mioProjectFileImportResultSchema.safeParse({...result,registration:'reused'}).success,true);
  for(const candidate of [{...result,registration:'updated'},{...result,assetId:randomUUID()},{...result,sourcePath:'/private/source.png'},{...result,asset:{...asset,reference:{path:'/private/source.png'}}},{...result,asset:{...asset,proof:{receiptKey:'private'}}}])assert.equal(mioProjectFileImportResultSchema.safeParse(candidate).success,false);
});

test('the import is native-only, non-core, reversible and unavailable without its host port',async t=>{
  const native=listAgentTaskTools(),tool=native.find(item=>item.name===MIO_PROJECT_FILE_IMPORT_TOOL);assert.ok(tool);
  assert.equal(tool.operation,MIO_PROJECT_FILE_IMPORT_OPERATION);assert.equal(tool.risk,'local_reversible');
  assert.ok(AGENT_TASK_LOADABLE_TOOL_NAMES.includes(MIO_PROJECT_FILE_IMPORT_TOOL));assert.ok(!AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES.includes(MIO_PROJECT_FILE_IMPORT_TOOL));
  assert.ok(!selectTaskModelTools(native).some(item=>item.name===MIO_PROJECT_FILE_IMPORT_TOOL));
  assert.ok(!listDiagnosticAgentTaskTools().some(item=>item.name===MIO_PROJECT_FILE_IMPORT_TOOL));
  const f=await fixture(t,'responses',{withoutPort:true});
  await assert.rejects(async()=>{const prepared=f.tools.prepare({projectId:f.projectId,operation:MIO_PROJECT_FILE_IMPORT_TOOL,input:{path:'source.png'}});await f.tools.prepareProjectFileImport(prepared,{requestId:randomUUID(),beforeEffect(){}});});assert.equal(f.prepares.length,0);assert.equal(imports(f).length,0);
});

test('only a completed matching native names receipt can grant the import tool',()=>{
  type Evidence=Pick<AgentTaskStep,'kind'|'status'|'toolCall'|'result'>;
  const valid:Evidence={kind:'tool',status:'completed',toolCall:call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_FILE_IMPORT_TOOL]}),result:{names:[MIO_PROJECT_FILE_IMPORT_TOOL]}};
  assert.deepEqual(loadedAgentTaskToolNames([valid]),[MIO_PROJECT_FILE_IMPORT_TOOL]);
  for(const status of ['intent','awaiting_approval','dispatch_started','unknown','rejected','denied','failed'] as const)assert.deepEqual(loadedAgentTaskToolNames([{...valid,status}]),[]);
  const invalid:Evidence[]=[{...valid,kind:'model'},{...valid,toolCall:call('mioon_other_tool',{names:[MIO_PROJECT_FILE_IMPORT_TOOL]})},{...valid,toolCall:call(AGENT_TASK_TOOLS_LOAD_NAME,{names:['mioon_asset_range_get']})},{...valid,result:{names:[MIO_PROJECT_FILE_IMPORT_TOOL],extra:true}},{...valid,toolCall:call(AGENT_TASK_TOOLS_LOAD_NAME,{groups:['assets']}),result:{groups:['assets'],tools:[MIO_PROJECT_FILE_IMPORT_TOOL]}}];
  for(const evidence of invalid)assert.ok(!loadedAgentTaskToolNames([evidence]).includes(MIO_PROJECT_FILE_IMPORT_TOOL));
});

for(const protocol of protocols)test(protocol+': loading and importing in one reply never prepares the early file call',async t=>{
  const f=await fixture(t,protocol),early=call(MIO_PROJECT_FILE_IMPORT_TOOL,{path:'source.png'}),later=plan(f,protocol,[early]);
  const done=await f.settle((await f.send()).run.id),rejected=done.steps.find(step=>step.toolCall?.id===early.id);assert.ok(rejected);
  assert.equal(rejected.status,'rejected');assert.equal(rejected.error?.code,'TOOL_NOT_LOADED');assert.equal(done.steps.find(step=>step.toolCall?.id===later.id)?.status,'completed');
  assert.equal(f.executions.length,1);assert.equal(f.creations.length,1);assert.equal(imports(f).length,1);assert.equal(done.changes.length,1);
});

for(const protocol of protocols)test(protocol+': legacy assets groups cannot discover or authorize project file import after reopening',async t=>{
  const f=await fixture(t,protocol,{safetyStepLimit:2});
  f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{groups:['assets']})]:index===2?[call(MIO_PROJECT_FILE_IMPORT_TOOL,{path:'source.png'})]:[])};});
  const {sent,original}=await f.frozen('groups'),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'safety_limit');assert.equal(f.requests[0]?.body,original);
  const load=paused.steps.find(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME);assert.ok(load);assert.equal(load.status,'completed');const receipt=object(load.result);assert.deepEqual(receipt.groups,['assets']);assert.ok(Array.isArray(receipt.tools));assert.ok(!receipt.tools.includes(MIO_PROJECT_FILE_IMPORT_TOOL));
  await f.reopen();await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');const done=await f.settle(sent.run.id);
  assert.equal(done.steps.find(step=>step.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL)?.error?.code,'TOOL_NOT_LOADED');assert.equal(f.prepares.length,0);assert.equal(f.executions.length,0);assert.equal(imports(f).length,0);
  assert.ok(sourceTaskModelToolNames(protocol,{body:f.requests[1]!.body}).includes('mioon_asset_range_get'));assert.ok(!sourceTaskModelToolNames(protocol,{body:f.requests[1]!.body}).includes(MIO_PROJECT_FILE_IMPORT_TOOL));assert.deepEqual(done.steps.find(step=>step.id===load.id)?.result,receipt);
});

for(const protocol of protocols)test(protocol+': a frozen older names enum rejects the import name before source preparation',async t=>{
  const f=await fixture(t,protocol);f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_FILE_IMPORT_TOOL]})]:index===2?[call(MIO_PROJECT_FILE_IMPORT_TOOL,{path:'source.png'})]:[])};});
  const {sent,original}=await f.frozen('names'),done=await f.settle(sent.run.id);assert.equal(f.requests[0]?.body,original);
  assert.equal(done.steps.find(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME)?.error?.code,'VALIDATION_ERROR');assert.equal(done.steps.find(step=>step.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL)?.error?.code,'TOOL_NOT_LOADED');
  assert.equal(f.prepares.length,0);assert.equal(f.executions.length,0);assert.equal(imports(f).length,0);
});
