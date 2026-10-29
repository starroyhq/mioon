import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assembleModelInput} from '../packages/business/src/agent/task-context-v2.ts';
import type {TaskModelContextFragment} from '../packages/business/src/agent/task-context-v2.ts';
import {taskResponseLanguageContext,TASK_MODEL_LIMITS} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentTaskJson,AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {GOAL_PROTOCOLS,goalCall,goalOutput} from './helpers/agent-task-goal-repair-fixture.ts';

for(const protocol of GOAL_PROTOCOLS)test(`${protocol}: compaction pins the frozen repair message once and subsequent small requests share its prefix`,()=>{
 const runId=randomUUID(),stamp='2026-10-29T00:00:00.000Z',fragments:TaskModelContextFragment[]=[],steps:AgentTaskStep[]=[];
 const message='Host-derived data for reference only; no permission or approval.\n'+JSON.stringify({kind:'mio.goal.repair',requirements:[{type:'shot_count',expected:{min:2,max:2},current:{count:1}}]});
 const context:AgentTaskJson[]=[taskResponseLanguageContext('en'),{role:'user',content:'Produce two shots.'}];
 const append=(index:number,size:number)=>{
  const modelId=randomUUID(),calls=index===1?[]:[goalCall('mioon_project_inspect',{})],output=goalOutput(protocol,calls,`Response ${index}:`+'x'.repeat(size));
  const results=calls.map(call=>({callId:call.id,result:{payload:'saved'.repeat(4000)}}));
  steps.push({id:modelId,runId,kind:'model',position:steps.length,status:'completed',createdAt:stamp,updatedAt:stamp,result:JSON.parse(JSON.stringify(output)) as AgentTaskJson});
  fragments.push({kind:'notes',notes:[],modelStepId:modelId},{kind:'continuation',modelStepId:modelId,output,results,...(index===1?{repairMessage:message}:{})});
 };
 const input=()=>assembleModelInput({context,text:'ignored',replay:{protocol,fragments,steps,runId,baseline:[]}}).history;
 let index=0;for(;index<11;index++){append(index,27000);if(JSON.stringify(input()).includes('mio.context.journal'))break;}
 assert.ok(index<11);const before=input(),serialized=JSON.stringify(before);
 assert.ok(Buffer.byteLength(serialized)<TASK_MODEL_LIMITS.historyBytes);assert.match(serialized,/mio\.context\.journal/u);
 assert.equal(before.filter(item=>typeof item==='object'&&item!==null&&!Array.isArray(item)&&item.role==='user'&&item.content===message).length,1);
 assert.deepEqual(input(),before,'reassembly does not recompute the gap or change compaction boundaries');
 append(index+1,0);const after=input();
 assert.ok(JSON.stringify(after.slice(0,before.length))===serialized,'an appended small round below the next compaction boundary preserves the frozen prefix');
 assert.equal(JSON.stringify(after).split('mio.goal.repair').length-1,1);
});
