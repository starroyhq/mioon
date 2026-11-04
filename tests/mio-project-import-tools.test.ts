import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,unlinkSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools,listAgentTaskTools,listDiagnosticAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createMioProjectImport} from '../packages/business/src/agent/mio-project-import.ts';
import {buildTaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelItem,TaskModelOutput,TaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import {selectTaskModelTools,sourceTaskModelToolNames} from '../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME,AGENT_TASK_LOADABLE_TOOL_GROUP_IDS,AGENT_TASK_LOADABLE_TOOL_NAMES,AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES,loadedAgentTaskToolNames} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createMioAssembly} from '../packages/business/src/agent/mio-assembly.ts';
import {MIO_PROJECT_FILE_IMPORT_TOOL,MIO_PROJECT_FILE_IMPORT_OPERATION,mioProjectFileImportInputSchema,mioProjectFileImportResultSchema} from '../packages/contracts/src/mio-project-import.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskControlAction,AgentTaskJson,AgentTaskSnapshot,AgentTaskStep,AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const protocols=['chat_completions','responses','anthropic_messages'] as const satisfies readonly AgentProtocol[];
type ImportPort=ReturnType<typeof createMioProjectImport>;
type Preparation=Awaited<ReturnType<ImportPort['prepare']>>;
type CreationProof=Parameters<Parameters<ImportPort['execute']>[1]['recordCreatedInside']>[0];
const call=(name:string,input:AgentTaskJson={}):AgentTaskToolCall=>({id:randomUUID(),name,arguments:input});
function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function output(protocol:AgentProtocol,calls:AgentTaskToolCall[]=[]):TaskModelOutput{
  const text='Synthetic project file import';
  const providerOutput:AgentTaskJson=protocol==='anthropic_messages'?{role:'assistant',content:[{type:'text',text},...calls.map(item=>({type:'tool_use',id:item.id,name:item.name,input:item.arguments}))]}
    :protocol==='responses'?[{type:'message',role:'assistant',content:[{type:'output_text',text}]},...calls.map(item=>({type:'function_call',call_id:item.id,name:item.name,arguments:JSON.stringify(item.arguments),status:'completed'}))]
    :{role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(item=>({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))}:{})};
  return {text,toolCalls:calls,providerOutput};
}
type Script=(index:number,request:TaskModelRequest)=>AsyncGenerator<TaskModelItem,void,undefined>;
async function fixture(t:TestContext,protocol:AgentProtocol='responses',options:{withoutPort?:boolean}={}){
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-project-import-tools-'));
  let store=openStore(root),services=createServices(store,new Map());
  await services.call('project.create',{name:'Mio project import tool test'});
  const projectId=store.projectId,source=path.join(root,'source.png'),sourceBytes=png({width:32,height:24,rgba:false});
  writeFileSync(source,sourceBytes);const sourceTime=new Date('2026-11-01T00:00:00.000Z');utimesSync(source,sourceTime,sourceTime);
  const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
  await settings.put({expectedRevision:0,configuration:{presetId:'ollama',platformId:'local',protocol,model:'qwen3:8b',baseUrl:'http://127.0.0.1:11434'+(protocol==='anthropic_messages'?'':'/v1')},secret:{action:'remove'}});
  const authorizations=createTestAuthorizations(()=>store,settings);await authorizeTestScope(authorizations,'project_agent');
  const prepares:Array<{requestId:string;retained:unknown;result:Preparation}>=[],executions:Preparation[]=[],lookups:Preparation[]=[],creations:CreationProof[]=[],requests:TaskModelRequest[]=[];
  let unknownBeforeExecute=false,unknownAfterExecute=false,failCreatedRecord=false,reuseBeforeExecute=false,closed=false;
  let script:Script=async function*(){yield {type:'done',output:output(protocol)};};
  const gateway=async function*(request:TaskModelRequest){request.beforeSubmit?.();requests.push(request);yield*script(requests.length,request);};
  function build(){
    const application=testProjectAppLibrary(store);assert.ok(application);
    const actual=createMioProjectImport({store,services,privateDirectories:[application.dataDir,store.cacheDir,store.tempDir]});
    const projectImport:ImportPort={
      async prepare(owner,input,context){const result=await actual.prepare(owner,input,context);prepares.push({requestId:context.requestId,retained:context.retained===undefined?undefined:structuredClone(context.retained),result:structuredClone(result)});return result;},
      async execute(preparation,context){
        executions.push(structuredClone(preparation));
        if(unknownBeforeExecute){unknownBeforeExecute=false;throw Object.assign(Error('Synthetic lost dispatch result'),{code:'AGENT_TASK_UNKNOWN_RESULT'});}
        if(reuseBeforeExecute){reuseBeforeExecute=false;await actual.execute(preparation,{...context,recordCreatedInside(){}});}
        const result=await actual.execute(preparation,{...context,recordCreatedInside(proof){creations.push(structuredClone(proof));context.recordCreatedInside(proof);if(failCreatedRecord)throw Object.assign(Error('Synthetic atomic audit failure'),{code:'SQLITE_FULL'});}});
        if(unknownAfterExecute){unknownAfterExecute=false;throw Object.assign(Error('Synthetic lost acknowledgement'),{code:'AGENT_TASK_UNKNOWN_RESULT'});}
        return result;
      },
      async lookup(preparation,context){lookups.push(structuredClone(preparation));return actual.lookup(preparation,context);},
    };
    const tools=createAgentTaskTools({store,services,...(options.withoutPort?{}:{projectImport})});
    const runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
    return {actual,tools,runtime};
  }
  let current=build();
  async function closeProject(){current.runtime.close();await current.runtime.drain();current.tools.dispose();await services.drain();store.close();}
  async function close(){if(closed)return;closed=true;await closeProject();await settings.close();}
  async function reopen(){await closeProject();store=openStore(root);services=createServices(store,new Map());current=build();}
  t.after(async()=>{await close();rmSync(root,{recursive:true,force:true});});
  return {root,projectId,source,sourceBytes,sourceTime,prepares,executions,lookups,creations,requests,
    get store(){return store;},get services(){return services;},get tools(){return current.tools;},get runtime(){return current.runtime;},get port(){return current.actual;},close,
    script(value:Script){script=value;},
    failBeforeExecute(){unknownBeforeExecute=true;},failAfterExecute(){unknownAfterExecute=true;},failRecord(){failCreatedRecord=true;},reuseNext(){reuseBeforeExecute=true;},
    async send(){return current.runtime.send(projectId,{requestId:randomUUID(),text:'Import the source file from this project.',expectedSettingsRevision:(await settings.get()).revision});},
    async settle(id:string){await current.runtime.drain();return current.runtime.get(projectId,id);},
    async wait(id:string,status:'awaiting_approval'|'paused'){
      // Source preparation includes real media I/O. Await the runtime's work
      // boundary instead of racing it against the runner's wall-clock speed.
      await current.runtime.drain();
      const value=current.runtime.get(projectId,id);assert.equal(value.run.status,status);return value;
    },
    async action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return current.runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
    reopen,
    async frozen(mode:'groups'|'names'){
      const saved=await settings.get(),history:AgentTaskJson[]=[{role:'user',content:'Continue the frozen project import intent.'}],body=object(JSON.parse(buildTaskModelRequest(saved.configuration,history,selectTaskModelTools(current.tools.list()),4318)));
      assert.ok(Array.isArray(body.tools));
      for(const entry of body.tools){
        const wire=object(entry),definition=protocol==='chat_completions'?object(wire.function):wire;if(definition.name!==AGENT_TASK_TOOLS_LOAD_NAME)continue;
        const schema=object(definition[protocol==='anthropic_messages'?'input_schema':'parameters']),properties=object(schema.properties);
        schema.properties={[mode]:{type:'array',items:{type:'string',enum:mode==='groups'?AGENT_TASK_LOADABLE_TOOL_GROUP_IDS:['mioon_project_media_list']},minItems:1,maxItems:mode==='groups'?AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.length:1},...(properties._mio_step?{_mio_step:properties._mio_step}:{})};schema.required=[mode];
      }
      const original=JSON.stringify(body),created=current.runtime.journal.create({projectId,requestId:randomUUID(),text:'Continue the frozen project import intent.',configuration:{...saved.configuration},settingsRevision:saved.revision,context:history});
      current.runtime.journal.beginModelStep(created.run.id,{request:{body:original,history},data:{baseline:current.runtime.journal.revisionSnapshot(projectId).map(({kind,id,revision})=>({kind,id,revision}))}},[]);
      await reopen();
      return {original,sent:await current.runtime.action(projectId,created.run.id,{requestId:randomUUID(),expectedRevision:current.runtime.get(projectId,created.run.id).run.revision,action:'resume'})};
    },
  };
}
function plan(f:Awaited<ReturnType<typeof fixture>>,protocol:AgentProtocol,extraFirst:AgentTaskToolCall[]=[]){
  const importCall=call(MIO_PROJECT_FILE_IMPORT_TOOL,{path:'source.png',name:'Imported source'});
  f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_FILE_IMPORT_TOOL]}),...extraFirst]:index===2?[importCall]:[])};});
  return importCall;
}
function imports(f:Awaited<ReturnType<typeof fixture>>){return f.store.list('assets',f.projectId);}
function receipts(f:Awaited<ReturnType<typeof fixture>>){
  const directory=path.join(f.store.tempDir,'asset-imports');
  return existsSync(directory)?readdirSync(directory).filter(name=>name.endsWith('.json')).sort().map(name=>({name,bytes:readFileSync(path.join(directory,name))})):[];
}

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

for(const protocol of protocols)test(protocol+': a direct import creates exactly one atomic Change and replays only retained records',async t=>{
  const f=await fixture(t,protocol),importCall=plan(f,protocol),beforeSource=readFileSync(f.source),beforeStat=lstatSync(f.source,{bigint:true});
  const done=await f.settle((await f.send()).run.id);assert.equal(done.run.status,'completed');
  const step=done.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);assert.equal(step.status,'completed');
  const result=mioProjectFileImportResultSchema.parse(step.result);assert.equal(result.registration,'created');assert.equal(imports(f).length,1);assert.equal(f.creations.length,1);
  const changes=done.changes.filter(change=>change.stepId===step.id);assert.equal(changes.length,1);assert.equal(changes[0]?.operation,MIO_PROJECT_FILE_IMPORT_OPERATION);assert.equal(changes[0]?.reversible,true);
  assert.deepEqual(changes[0]?.targets.map(target=>[target.kind,target.id]),[['asset',result.assetId]]);
  assert.ok(f.prepares.every(item=>item.requestId===step.id));assert.equal(f.executions.length,1);
  assert.deepEqual(readFileSync(f.source),beforeSource);assert.equal(lstatSync(f.source,{bigint:true}).mtimeNs,beforeStat.mtimeNs);
  assert.ok(!sourceTaskModelToolNames(protocol,{body:f.requests[0]!.body}).includes(MIO_PROJECT_FILE_IMPORT_TOOL));assert.ok(sourceTaskModelToolNames(protocol,{body:f.requests[1]!.body}).includes(MIO_PROJECT_FILE_IMPORT_TOOL));
  assert.ok(!JSON.stringify(done).includes(f.root));for(const request of f.requests)assert.ok(!request.body.includes(f.root));
  const ids=done.steps.filter(item=>item.kind==='model').map(item=>item.id),sent=f.requests.map(request=>request.body),prepares=f.prepares.length,executions=f.executions.length;
  unlinkSync(f.source);await f.reopen();
  const records=createMioRecords(f.store),assembly=createMioAssembly(records),before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  for(const [index,id]of ids.entries()){const saved=records.request(records.step(id).currentRequestId!);assert.equal(saved.originalBody,null);assert.equal(object(assembly.hydrate(saved)).body,sent[index]);}
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);assert.equal(f.prepares.length,prepares);assert.equal(f.executions.length,executions);
});

for(const protocol of protocols)test(protocol+': loading and importing in one reply never prepares the early file call',async t=>{
  const f=await fixture(t,protocol),early=call(MIO_PROJECT_FILE_IMPORT_TOOL,{path:'source.png'}),later=plan(f,protocol,[early]);
  const done=await f.settle((await f.send()).run.id),rejected=done.steps.find(step=>step.toolCall?.id===early.id);assert.ok(rejected);
  assert.equal(rejected.status,'rejected');assert.equal(rejected.error?.code,'TOOL_NOT_LOADED');assert.equal(done.steps.find(step=>step.toolCall?.id===later.id)?.status,'completed');
  assert.equal(f.executions.length,1);assert.equal(f.creations.length,1);assert.equal(imports(f).length,1);assert.equal(done.changes.length,1);
});

for(const protocol of protocols)test(protocol+': legacy assets groups cannot discover or authorize project file import after reopening',async t=>{
  const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:2});
  f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{groups:['assets']})]:index===2?[call(MIO_PROJECT_FILE_IMPORT_TOOL,{path:'source.png'})]:[])};});
  const {sent,original}=await f.frozen('groups'),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'budget');assert.equal(f.requests[0]?.body,original);
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

for(const protocol of protocols)for(const mutation of ['replacement','same-inode'] as const)test(protocol+': approval pins the original '+mutation+' source'+(mutation==='same-inode'?' across close and reopen':''),async t=>{
  const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});const importCall=plan(f,protocol);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();
  const step=waiting.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);assert.equal(f.prepares.length,1);assert.equal(f.executions.length,0);
  const retained=f.runtime.journal.step(step.id).data;assert.ok(object(retained).projectFileImport);assert.ok(!JSON.stringify(waiting).includes(f.root));
  const prior=lstatSync(f.source,{bigint:true});
  if(mutation==='replacement'){renameSync(f.source,f.source+'.original');writeFileSync(f.source,f.sourceBytes);assert.notEqual(lstatSync(f.source,{bigint:true}).ino,prior.ino);}
  else{const changed=Buffer.from(f.sourceBytes);changed[changed.length-1]^=1;writeFileSync(f.source,changed);assert.equal(lstatSync(f.source,{bigint:true}).ino,prior.ino);}
  utimesSync(f.source,f.sourceTime,f.sourceTime);assert.equal(lstatSync(f.source,{bigint:true}).mtimeNs,prior.mtimeNs);
  if(mutation==='same-inode'){await f.reopen();const current=f.runtime.get(f.projectId,sent.run.id);assert.equal(current.run.status,'interrupted');await f.action(current,'resume');}
  else await f.action(waiting,'approve',{stepId:step.id});
  const done=await f.settle(sent.run.id);
  assert.equal(f.executions.length,0);assert.equal(f.creations.length,0);assert.equal(imports(f).length,0);assert.equal(done.changes.length,0);assert.notEqual(done.steps.find(item=>item.id===step.id)?.status,'completed');
  assert.deepEqual(object(f.runtime.journal.step(step.id).data).projectFileImport,object(retained).projectFileImport,'Reapproval must not replace the frozen source proof');
});

for(const protocol of protocols)test(protocol+': a denied import never executes and preserves the source',async t=>{
  const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});const importCall=plan(f,protocol);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();const step=waiting.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);
  await f.action(waiting,'deny',{stepId:step.id});const done=await f.settle(sent.run.id);
  assert.equal(done.steps.find(item=>item.id===step.id)?.status,'rejected');assert.equal(f.executions.length,0);assert.equal(imports(f).length,0);assert.deepEqual(readFileSync(f.source),f.sourceBytes);
});

for(const protocol of protocols)test(protocol+': unchanged approval resumes after reopening with the original private proof',async t=>{
  const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});const importCall=plan(f,protocol);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();const step=waiting.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);
  const original=structuredClone(object(f.runtime.journal.step(step.id).data).projectFileImport);assert.ok(original);
  await f.reopen();const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');await f.action(interrupted,'resume');
  const again=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();assert.equal(f.executions.length,0);assert.deepEqual(object(f.runtime.journal.step(step.id).data).projectFileImport,original);
  await f.action(again,'approve',{stepId:step.id});const done=await f.settle(sent.run.id);
  assert.equal(done.steps.find(item=>item.id===step.id)?.status,'completed');assert.equal(imports(f).length,1);assert.equal(f.creations.length,1);assert.equal(done.changes.filter(change=>change.stepId===step.id).length,1);
  assert.ok(f.prepares.some(item=>item.retained!==undefined));assert.ok(f.prepares.every(item=>item.requestId===step.id));assert.deepEqual(object(f.runtime.journal.step(step.id).data).projectFileImport,original);
});

test('an already registered original request returns reused without claiming a creation or undo right',async t=>{
  const f=await fixture(t);f.reuseNext();const importCall=plan(f,'responses'),done=await f.settle((await f.send()).run.id),step=done.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);
  assert.equal(step.status,'completed');assert.equal(mioProjectFileImportResultSchema.parse(step.result).registration,'reused');assert.equal(imports(f).length,1);assert.equal(f.creations.length,0);assert.equal(done.changes.length,0);
  const original=f.executions[0];assert.ok(original);const before=receipts(f),asset=structuredClone(imports(f)[0]);unlinkSync(f.source);
  const replay=await f.port.execute(original,{beforeEffect(){},recordCreatedInside(){assert.fail('Reusing a prior row cannot grant creation ownership');}});
  assert.equal(replay.disposition,'reused');assert.deepEqual(imports(f),[asset]);assert.deepEqual(receipts(f),before);assert.equal(f.runtime.get(f.projectId,done.run.id).changes.length,0);
});

test('unknown before effect is resolved only through the original step request and never blind retry',async t=>{
  const f=await fixture(t);plan(f,'responses');f.failBeforeExecute();const done=await f.settle((await f.send()).run.id),step=done.steps.find(item=>item.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL);assert.ok(step);
  assert.equal(step.status,'unknown');assert.equal(done.run.pauseReason,'unknown_outcome');assert.equal(imports(f).length,0);
  await assert.rejects(f.action(done,'retry',{stepId:step.id}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.executions.length,1);
  const current=f.runtime.get(f.projectId,done.run.id);await f.action(current,'resolve_unknown',{stepId:step.id,resolution:'discard'});const after=f.runtime.get(f.projectId,done.run.id);
  assert.equal(after.steps.find(item=>item.id===step.id)?.status,'failed');assert.equal(f.lookups.length,1);assert.deepEqual(f.lookups[0],f.executions[0]);assert.equal(imports(f).length,0);assert.equal(f.executions.length,1);
});

test('an unprovable original receipt remains unknown across reopening and cannot be discarded or retried',async t=>{
  const f=await fixture(t);plan(f,'responses');f.failBeforeExecute();const done=await f.settle((await f.send()).run.id),step=done.steps.find(item=>item.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL);assert.ok(step);assert.equal(step.status,'unknown');
  const directory=path.join(f.store.tempDir,'asset-imports');mkdirSync(directory,{recursive:true,mode:0o700});const receipt=path.join(directory,createHash('sha256').update(step.id).digest('hex')+'.json');writeFileSync(receipt,'{"version":1}',{mode:0o600});
  const before=readFileSync(receipt);unlinkSync(f.source);await f.reopen();
  for(const resolution of ['discard','accept_result']){const current=f.runtime.get(f.projectId,done.run.id);await assert.rejects(f.action(current,'resolve_unknown',{stepId:step.id,resolution}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.runtime.get(f.projectId,done.run.id).steps.find(item=>item.id===step.id)?.status,'unknown');}
  await assert.rejects(f.action(f.runtime.get(f.projectId,done.run.id),'retry',{stepId:step.id}),{code:'AGENT_TASK_UNKNOWN_RESULT'});
  assert.equal(f.executions.length,1);assert.equal(imports(f).length,0);assert.deepEqual(readFileSync(receipt),before);assert.ok(f.lookups.length>=1);assert.ok(f.lookups.every(proof=>JSON.stringify(proof)===JSON.stringify(f.executions[0])));
});

for(const outcome of ['applied','retired'] as const)test('an unknown '+outcome+' original registration is observed without recreating ownership after reopening',async t=>{
  const f=await fixture(t);f.reuseNext();f.failAfterExecute();const importCall=plan(f,'responses'),done=await f.settle((await f.send()).run.id),step=done.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);
  assert.equal(step.status,'unknown');assert.equal(done.changes.length,0);assert.equal(f.creations.length,0);const asset=object(imports(f)[0]);assert.ok(typeof asset.id==='string');const assetId=asset.id;
  if(outcome==='retired')f.store.tx(()=>f.store.db.prepare('DELETE FROM assets WHERE id=?').run(assetId));
  const before=receipts(f);unlinkSync(f.source);await f.reopen();
  await f.action(f.runtime.get(f.projectId,done.run.id),'resolve_unknown',{stepId:step.id,resolution:'accept_result'});
  const resolved=f.runtime.get(f.projectId,done.run.id),saved=resolved.steps.find(item=>item.id===step.id);assert.ok(saved);
  if(outcome==='applied'){assert.equal(saved.status,'completed');const result=mioProjectFileImportResultSchema.parse(saved.result);assert.equal(result.registration,'reused');assert.equal(result.assetId,assetId);assert.equal(imports(f).length,1);}
  else{assert.equal(saved.status,'failed');assert.equal(saved.error?.code,'PROJECT_IMPORT_RETIRED');assert.equal(imports(f).length,0);}
  assert.equal(resolved.changes.length,0);assert.equal(f.executions.length,1);assert.equal(f.creations.length,0);assert.equal(f.lookups.length,1);assert.deepEqual(f.lookups[0],f.executions[0]);assert.deepEqual(receipts(f),before);assert.equal(existsSync(f.source),false);assert.ok(!JSON.stringify(resolved).includes(f.root));
});

test('a lost acknowledgement after atomic registration cannot duplicate the asset or Change',async t=>{
  const f=await fixture(t);plan(f,'responses');f.failAfterExecute();const sent=await f.send();await f.runtime.drain();const done=f.runtime.get(f.projectId,sent.run.id),step=done.steps.find(item=>item.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL);assert.ok(step);
  assert.equal(step.status,'completed');assert.equal(imports(f).length,1);assert.equal(done.changes.filter(change=>change.stepId===step.id).length,1);assert.equal(f.creations.length,1);
  const before=receipts(f);await f.reopen();const reopened=f.runtime.get(f.projectId,sent.run.id);assert.equal(reopened.steps.find(item=>item.id===step.id)?.status,'completed');assert.equal(imports(f).length,1);assert.equal(reopened.changes.filter(change=>change.stepId===step.id).length,1);assert.deepEqual(receipts(f),before);
});

test('a journal failure rolls back asset registration and its unique Change together',async t=>{
  const f=await fixture(t);plan(f,'responses');f.failRecord();const sent=await f.send();await f.runtime.drain();
  assert.equal(imports(f).length,0);assert.equal(f.runtime.journal.snapshot(sent.run.id).changes.length,0);assert.equal(f.creations.length,1);
});

test('dedicated compensation removes only the untouched row and cannot revive its original request',async t=>{
  const f=await fixture(t);plan(f,'responses');const done=await f.settle((await f.send()).run.id),change=done.changes.find(item=>item.operation===MIO_PROJECT_FILE_IMPORT_OPERATION);assert.ok(change);
  const step=done.steps.find(item=>item.id===change.stepId);assert.ok(step);const original=f.executions[0];assert.ok(original);const before=receipts(f);
  const requestId=randomUUID();unlinkSync(f.source);await f.action(done,'undo_change',{changeId:change.id,requestId});const reverted=f.runtime.get(f.projectId,done.run.id);
  assert.equal(imports(f).length,0);assert.equal(reverted.changes.find(item=>item.id===change.id)?.status,'reverted');assert.deepEqual(receipts(f),before);assert.equal(existsSync(f.source),false);
  assert.equal(object(f.runtime.journal.lookupControl(requestId)?.result).state,'completed');
  await assert.rejects(f.port.execute(original,{beforeEffect(){},recordCreatedInside(){assert.fail('A retired request must not create an asset');}}));
  const lookup=await f.port.lookup(original,{beforeEffect(){}});assert.equal(lookup.outcome,'retired');lookup.assertCurrent();
  assert.equal(imports(f).length,0);assert.deepEqual(receipts(f),before);assert.equal(f.creations.length,1);
});

for(const obstacle of ['claim','modified','consumer'] as const)test('compensation preserves an imported row with a later '+obstacle,async t=>{
  const f=await fixture(t);plan(f,'responses');const done=await f.settle((await f.send()).run.id),change=done.changes.find(item=>item.operation===MIO_PROJECT_FILE_IMPORT_OPERATION);assert.ok(change);const target=change.targets[0];assert.ok(target);
  if(obstacle==='claim')f.runtime.journal.claim({projectId:f.projectId,ownerId:'import-review-draft',targets:[{...target,revision:f.runtime.journal.targetRevision(f.projectId,'asset',target.id)}]});
  else if(obstacle==='modified'){const asset=f.store.get('assets',target.id);assert.ok(asset);f.store.put('assets',{...asset,name:'Later manual name'});}
  else await f.services.call('asset.annotation.set',{projectId:f.projectId,requestId:randomUUID(),assetId:target.id,expectedRevision:0,tags:['Keep'],note:'A manual consumer'});
  const asset=structuredClone(f.store.get('assets',target.id)),before=receipts(f),current=f.runtime.get(f.projectId,done.run.id);
  await assert.rejects(f.action(current,'undo_change',{changeId:change.id}));assert.deepEqual(f.store.get('assets',target.id),asset);assert.equal(f.runtime.get(f.projectId,done.run.id).changes.find(item=>item.id===change.id)?.status,'applied');assert.deepEqual(receipts(f),before);assert.deepEqual(readFileSync(f.source),f.sourceBytes);
});
