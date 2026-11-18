import {putTestAgentConfiguration,testAgentExecution} from './agent-settings-fixture.ts';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../../packages/business/src/project-file/test-store.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../../packages/business/src/project-service-application.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {createAgentTaskJournal} from '../../packages/business/src/agent/task-journal-v2.ts';
import {createMioProjectImport} from '../../packages/business/src/agent/mio-project-import.ts';
import {buildTaskModelRequest} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelItem,TaskModelOutput,TaskModelRequest} from '../../packages/business/src/agent/task-gateway-v2.ts';
import {selectTaskModelTools} from '../../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME,AGENT_TASK_LOADABLE_TOOL_GROUP_IDS} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import {MIO_PROJECT_FILE_IMPORT_TOOL} from '../../packages/contracts/src/mio-project-import.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskControlAction,AgentTaskJson,AgentTaskSnapshot,AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './agent-authorizations.ts';
import {png} from './timeline-image-fixtures.ts';

export const protocols=['chat_completions','responses','anthropic_messages'] as const satisfies readonly AgentProtocol[];
type ImportPort=ReturnType<typeof createMioProjectImport>;
type Preparation=Awaited<ReturnType<ImportPort['prepare']>>;
type CreationProof=Parameters<Parameters<ImportPort['execute']>[1]['recordCreatedInside']>[0];
export const call=(name:string,input:AgentTaskJson={}):AgentTaskToolCall=>({id:randomUUID(),name,arguments:input});
export function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
export function output(protocol:AgentProtocol,calls:AgentTaskToolCall[]=[]):TaskModelOutput{
  const text='Synthetic project file import';
  const providerOutput:AgentTaskJson=protocol==='anthropic_messages'?{role:'assistant',content:[{type:'text',text},...calls.map(item=>({type:'tool_use',id:item.id,name:item.name,input:item.arguments}))]}
    :protocol==='responses'?[{type:'message',role:'assistant',content:[{type:'output_text',text}]},...calls.map(item=>({type:'function_call',call_id:item.id,name:item.name,arguments:JSON.stringify(item.arguments),status:'completed'}))]
    :{role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(item=>({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))}:{})};
  return {text,toolCalls:calls,providerOutput};
}
type Script=(index:number,request:TaskModelRequest)=>AsyncGenerator<TaskModelItem,void,undefined>;
export async function fixture(t:TestContext,protocol:AgentProtocol='responses',options:{safetyStepLimit?:number;withoutPort?:boolean}={}){
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-project-import-tools-'));
  let store=openStore(root),services=createServices(store,new Map());
  await services.call('project.create',{name:'Mio project import tool test'});
  const projectId=store.projectId,source=path.join(root,'source.png'),sourceBytes=png({width:32,height:24,rgba:false});
  writeFileSync(source,sourceBytes);const sourceTime=new Date('2026-11-01T00:00:00.000Z');utimesSync(source,sourceTime,sourceTime);
  const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
  await putTestAgentConfiguration(settings,{expectedRevision:0,configuration:{presetId:'ollama',platformId:'local',protocol,model:'qwen3:8b',baseUrl:'http://127.0.0.1:11434'+(protocol==='anthropic_messages'?'':'/v1')},secret:{action:'remove'}});
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
    const runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318,...(options.safetyStepLimit===undefined?{}:{journal:createAgentTaskJournal(store,{safetyStepLimit:options.safetyStepLimit})})});
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
    async send(){return current.runtime.send(projectId,{requestId:randomUUID(),text:'Import the source file from this project.',expectedSettingsRevision:testAgentExecution(await settings.get()).revision});},
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
      const saved=await settings.get(),history:AgentTaskJson[]=[{role:'user',content:'Continue the frozen project import intent.'}],body=object(JSON.parse(buildTaskModelRequest(testAgentExecution(saved).configuration,history,selectTaskModelTools(current.tools.list()),4318)));
      assert.ok(Array.isArray(body.tools));
      for(const entry of body.tools){
        const wire=object(entry),definition=protocol==='chat_completions'?object(wire.function):wire;if(definition.name!==AGENT_TASK_TOOLS_LOAD_NAME)continue;
        const schema=object(definition[protocol==='anthropic_messages'?'input_schema':'parameters']),properties=object(schema.properties);
        schema.properties={[mode]:{type:'array',items:{type:'string',enum:mode==='groups'?AGENT_TASK_LOADABLE_TOOL_GROUP_IDS:['mioon_project_media_list']},minItems:1,maxItems:mode==='groups'?AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.length:1},...(properties._mio_step?{_mio_step:properties._mio_step}:{})};schema.required=[mode];
      }
      const original=JSON.stringify(body),created=current.runtime.journal.create({projectId,requestId:randomUUID(),text:'Continue the frozen project import intent.',configuration:{...testAgentExecution(saved).configuration},settingsRevision:testAgentExecution(saved).revision,settingsBinding:testAgentExecution(saved).binding,context:history});
      current.runtime.journal.beginModelStep(created.run.id,{request:{body:original,history},data:{baseline:current.runtime.journal.revisionSnapshot(projectId).map(({kind,id,revision})=>({kind,id,revision}))}},[]);
      await reopen();
      return {original,sent:await current.runtime.action(projectId,created.run.id,{requestId:randomUUID(),expectedRevision:current.runtime.get(projectId,created.run.id).run.revision,action:'resume'})};
    },
  };
}
export function plan(f:Awaited<ReturnType<typeof fixture>>,protocol:AgentProtocol,extraFirst:AgentTaskToolCall[]=[]){
  const importCall=call(MIO_PROJECT_FILE_IMPORT_TOOL,{path:'source.png',name:'Imported source'});
  f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_FILE_IMPORT_TOOL]}),...extraFirst]:index===2?[importCall]:[])};});
  return importCall;
}
export function imports(f:Awaited<ReturnType<typeof fixture>>){return f.store.list('assets',f.projectId);}
export function receipts(f:Awaited<ReturnType<typeof fixture>>){
  const directory=path.join(f.store.tempDir,'asset-imports');
  return existsSync(directory)?readdirSync(directory).filter(name=>name.endsWith('.json')).sort().map(name=>({name,bytes:readFileSync(path.join(directory,name))})):[];
}
