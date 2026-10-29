import {randomUUID} from 'node:crypto';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {createMockProvider} from '../../packages/business/src/providers/mock.ts';
import type {Provider,ProviderContext} from '../../packages/business/src/provider-registry.ts';
import {createTestAuthorizations,authorizeTestScope} from './agent-authorizations.ts';
import type {TaskGateway,TaskModelOutput} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentTaskJson,AgentTaskToolCall,AgentTaskControlAction} from '../../packages/contracts/src/agent-tasks-v2.ts';

export const GOAL_PROTOCOLS=['chat_completions','responses','anthropic_messages'] as const;
export type GoalProtocol=typeof GOAL_PROTOCOLS[number];
export const goalCall=(name:string,args:AgentTaskJson):AgentTaskToolCall=>({id:randomUUID(),name,arguments:args});
export const setCountGoal=(count:number)=>goalCall('mioon_goal_set',{conditions:[{type:'shot_count',min:count,max:count}]});
export function goalOutput(protocol:GoalProtocol,calls:AgentTaskToolCall[]=[],text='Saved final reply'):TaskModelOutput {
 const providerOutput:AgentTaskJson=protocol==='responses'
  ?[{type:'message',role:'assistant',content:[{type:'output_text',text}]},...calls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'}))]
  :protocol==='anthropic_messages'
   ?{role:'assistant',content:[{type:'text',text},...calls.map(call=>({type:'tool_use',id:call.id,name:call.name,input:call.arguments}))]}
   :{role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}:{})};
 return {text,toolCalls:calls,providerOutput};
}
export async function openGoalRepairFixture(root:string,protocol:GoalProtocol,existingProjectId?:string){
 const store=openStore(root),mock=createMockProvider({db:store.db,root}),context=(value:ProviderContext)=>({signal:value.signal??undefined,beforeSubmit:value.beforeSubmit,requestId:value.requestId,jobId:value.jobId,...(typeof value.providerRegion==='string'?{providerRegion:value.providerRegion}:{})});
 const provider:Provider={...mock,submit:(snapshot,value)=>mock.submit(snapshot,context(value)),reconcile:(id,value)=>mock.reconcile(id,context(value)),poll:(id,value)=>mock.poll(id,context(value)),download:(id,destination,value)=>mock.download(id,destination,context(value)),cancel:(id,value)=>mock.cancel(id,context(value))};
 const services=createServices(store,new Map([['mock',provider]]));
 const project=existingProjectId?{id:existingProjectId}:await services.call('project.create',{name:'Goal repair fixture'}) as {id:string};
 if(!existingProjectId)await services.call('shot.create',{projectId:project.id,title:'Original shot'});
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
 await settings.put({expectedRevision:0,configuration:{presetId:'custom',platformId:'custom',protocol,model:'synthetic-goal-model',baseUrl:'https://goal.example.com/v1'},secret:{action:'replace',storage:'session',value:'SYNTHETIC_GOAL_REPAIR_TEST_ONLY'}});
 const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
 const tools=createAgentTaskTools({store,services}),bodies:string[]=[];
 let plan:(index:number)=>AgentTaskToolCall[]|Promise<AgentTaskToolCall[]>=()=>[];
 const gateway:TaskGateway=async function*(request){bodies.push(request.body);yield {type:'done',output:goalOutput(protocol,await plan(bodies.length))};};
 const runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
 return {store,services,settings,tools,runtime,bodies,projectId:project.id,
  plan(next:typeof plan){plan=next;},
  async send(extra:Record<string,unknown>={}){const sent=await runtime.send(project.id,{requestId:randomUUID(),text:'Make the requested shots',expectedSettingsRevision:(await settings.get()).revision,...extra});await runtime.drain();return runtime.get(project.id,sent.run.id);},
  async action(runId:string,action:AgentTaskControlAction,extra:Record<string,unknown>={}){const current=runtime.get(project.id,runId);await runtime.action(project.id,runId,{requestId:randomUUID(),expectedRevision:current.run.revision,action,...extra});await runtime.drain();return runtime.get(project.id,runId);},
  async close(){runtime.close();await runtime.drain();tools.dispose();await services.drain();await settings.close();store.close();},
 };
}
