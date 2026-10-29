import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {transformSync} from 'esbuild';
import type {AgentTaskSnapshot,AgentTaskStep,AgentTaskGoalCondition,AgentTaskJson} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskChecks,AgentTaskRequirement} from '../../packages/contracts/src/agent-task-checks-v2.ts';
import type {AgentTaskChecksViewState} from '../../apps/web/src/agent-task-checks-state.ts';
import {visibleAgentTaskChecks} from '../../apps/web/src/agent-task-checks-state.ts';
import {normalizeAgentTaskGoals} from '../../packages/business/src/agent/task-goals-v2.ts';
import * as presentation from '../../apps/web/src/agent-task-presentation.ts';
import * as requirements from '../../apps/web/src/agent-task-requirements.ts';
import {createI18nTestContext} from './i18n.ts';
import type {Locale} from '../../packages/i18n/src/index.ts';

export const projectId='10000000-0000-4000-8000-000000000001',runId='20000000-0000-4000-8000-000000000001',goalId='30000000-0000-4000-8000-000000000001',modelId='40000000-0000-4000-8000-000000000001',time='2026-10-29T00:00:00.000Z';
const json=(value:unknown):AgentTaskJson=>JSON.parse(JSON.stringify(value)) as AgentTaskJson;
export function goalStep(conditions:AgentTaskGoalCondition[],patch:Partial<AgentTaskStep>={}):AgentTaskStep {
  return {id:goalId,runId,position:1,kind:'tool',status:'completed',createdAt:time,updatedAt:time,tier:'read_only',toolCall:{id:'synthetic-goal',name:'mioon_goal_set',arguments:json({conditions})},result:json(normalizeAgentTaskGoals({conditions})),...patch};
}
export function snapshot(status:AgentTaskSnapshot['run']['status']='completed',conditions:AgentTaskGoalCondition[]=[{type:'duration',seconds:30,toleranceSeconds:1}]):AgentTaskSnapshot {
  return {run:{id:runId,projectId,requestId:'synthetic-h4b',text:'Make a cut',status,revision:1,stepsUsed:12,budget:30,stepLimit:30,configuration:{},createdAt:time,updatedAt:time},steps:[goalStep(conditions)],changes:[]};
}
export function repairStep(patch:Partial<AgentTaskStep>={}):AgentTaskStep {
  return {id:modelId,runId,position:2,kind:'model',status:'completed',createdAt:time,updatedAt:time,repair:{sourceModelStepId:'40000000-0000-4000-8000-000000000002'},...patch};
}
export function requirement(patch:Partial<AgentTaskRequirement>={}):AgentTaskRequirement {
  return {id:`goal:${goalId}:0`,type:'duration',source:'goal',goalStepId:goalId,status:'failed',target:{kind:'timeline',id:projectId},basis:[{kind:'timeline',id:projectId,revision:1}],expected:{durationSeconds:30,toleranceSeconds:1},current:{durationFrames:948,fps:30,durationSeconds:31.6},...patch};
}
export function report(items:AgentTaskRequirement[]):AgentTaskChecks {
  return {projectId,runId,runRevision:1,groups:[{id:'export_render',items:[]},{id:'generation',items:[]},{id:'timeline',items:[]},{id:'decomposition_frames',items:[]}],requirements:items};
}
export type Tree=string|number|boolean|null|undefined|Element|Tree[];
export interface Element {type:unknown;props:Record<string,unknown>&{children?:Tree}}
export const nodes=(tree:Tree):Element[]=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props.children)]:[];
export const text=(tree:Tree):string=>Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props.children):typeof tree==='string'||typeof tree==='number'?String(tree):'';

/** Evaluate the real component, hooks and handlers through the existing typed
 * tree harness. Actual React/DOM and CSS are verified separately in the browser. */
export function component(snapshotValue:AgentTaskSnapshot,reportValue:AgentTaskChecks,{locale='zh-Hans',readOnly=false}:{locale?:Locale;readOnly?:boolean}={}) {
  const state:AgentTaskChecksViewState={report:reportValue,loading:false,preflighting:false,error:false,justChecked:false},hooks:unknown[]=[state,true,true,undefined];
  let cursor=0,refCursor=0,rechecks=0;
  const refs=[{current:null},{current:{recheck(){rechecks++;return Promise.resolve();}}}];
  const react={createElement(type:unknown,props:Record<string,unknown>|null,...children:Tree[]):Tree{const value={...props,children};return typeof type==='function'?(type as(props:typeof value)=>Tree)(value):{type,props:value};},Fragment:'fragment',useId:()=> 'h4b-checks',useState(value:unknown){const index=cursor++;if(!(index in hooks))hooks[index]=typeof value==='function'?(value as()=>unknown)():value;return [hooks[index],(next:unknown)=>{hooks[index]=typeof next==='function'?(next as(previous:unknown)=>unknown)(hooks[index]):next;}];},useRef:()=>refs[refCursor++],useEffect(){},useLayoutEffect(){}};
  const module:{exports:{default?:(props:Record<string,unknown>)=>Tree}}={exports:{}},source=readFileSync(new URL('../../apps/web/src/AgentTaskChecks.tsx',import.meta.url),'utf8');
  Function('require','module','exports',transformSync(source,{loader:'tsx',format:'cjs',jsx:'transform'}).code)((id:string)=>{
    if(id==='react')return {...react,default:react};
    if(id.includes('workbench-controls'))return {WorkbenchButton:'button'};
    if(id.includes('workbench-tooltip'))return {WorkbenchTooltip:(props:{children:Tree})=>props.children};
    if(id==='./i18n/I18nProvider.tsx')return {useI18n:()=>createI18nTestContext(locale)};
    if(id==='./agent-task-checks-state.ts')return {visibleAgentTaskChecks,createAgentTaskChecksView:()=>assert.fail('No effects are mounted')};
    if(id==='./agent-task-presentation.ts')return presentation;
    if(id==='./agent-task-requirements.ts')return requirements;
    if(id==='./icons.tsx')return {__esModule:true,default:(props:Record<string,unknown>)=>({type:'svg',props})};
    assert.fail(`Unexpected H4b component dependency ${id}`);
  },module,module.exports);
  return {render(){cursor=0;refCursor=0;return module.exports.default!({scope:'h4b-fixture',snapshot:snapshotValue,latest:true,visible:true,readOnly});},setReport(value:AgentTaskChecks){hooks[0]={...state,report:value};},rechecks:()=>rechecks};
}
