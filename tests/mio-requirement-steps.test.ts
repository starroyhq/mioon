import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import type {AgentTaskJson,AgentTaskSnapshot,AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {LOCALES,translate,validateCatalogs} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/index.ts';
import {mioPanelMessages} from '../packages/i18n/src/catalogs/mio-panel.ts';
import * as presentation from '../apps/web/src/agent-task-presentation.ts';
import * as requirements from '../apps/web/src/agent-task-requirements.ts';
import * as reviews from '../apps/web/src/agent-task-reviews.ts';
import * as questions from '../apps/web/src/agent-task-questions.ts';
import {agentTaskErrorKey} from '../apps/web/src/agent-task-errors.ts';
import {agentTaskNewConversationBlock,agentTaskSessionBusy,agentTaskWaitingQuestion} from '../apps/web/src/agent-tasks-v2.ts';
import {createI18nTestContext} from './helpers/i18n.ts';

const projectId='10000000-0000-4000-8000-000000000001',runId='20000000-0000-4000-8000-000000000001';
const id=(value:number)=>`30000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
const json=(value:unknown):AgentTaskJson=>JSON.parse(JSON.stringify(value)) as AgentTaskJson;
function step(position:number,extra:Partial<AgentTaskStep>={}):AgentTaskStep {
  return {id:id(position),runId,position,kind:'model',status:'completed',createdAt:'2026-10-29T12:00:00.000Z',updatedAt:'2026-10-29T12:00:00.100Z',...extra};
}
function goal(position:number,conditions:AgentTaskJson[]=[{type:'subtitle_count',min:1}],extra:Partial<AgentTaskStep>={}):AgentTaskStep {
  const value={conditions};
  return step(position,{kind:'tool',tier:'read_only',toolCall:{id:`call-${position}`,name:'mioon_goal_set',arguments:value},result:value,...extra});
}
function snapshot(steps:AgentTaskStep[],status:AgentTaskSnapshot['run']['status']='completed'):AgentTaskSnapshot {
  return {run:{id:runId,projectId,requestId:'h4b-step-fixture',text:'Make a vertical cut.',status,revision:1,stepLimit:30,budget:30,stepsUsed:steps.length,configuration:{},createdAt:'2026-10-29T12:00:00.000Z',updatedAt:'2026-10-29T12:00:01.000Z'},steps,changes:[]};
}

test('H4b goal step titles use only normalized counts in four languages',()=>{
  const titles={'zh-Hans':'整理要求 · 1 项','zh-Hant':'整理要求 · 1 項',en:'Set requirements · 1',ja:'要件を整理 · 1 件'};
  assert.deepEqual(validateCatalogs(mioPanelMessages),[]);
  for(const locale of LOCALES){
    const current=goal(1,undefined,{text:'DO_NOT_SHOW_USER_OR_MODEL_PROSE'});
    assert.equal(presentation.taskStepTitle(current,locale),titles[locale]);
    assert.equal(presentation.taskGoalCount(current),1);
    assert.ok(presentation.taskStepTitle(goal(2,[]),locale).includes('0'));
  }
});

test('H4b latest goal accepts equivalent key order and the legacy default tolerance',()=>{
  const current=goal(2,[{type:'duration',seconds:30}]);
  current.result={conditions:[{toleranceSeconds:0,seconds:30,type:'duration'}]};
  const before=structuredClone(current);
  assert.equal(presentation.taskLatestGoalStep([current])?.id,current.id);
  assert.equal(presentation.taskGoalCount(current),1);
  assert.deepEqual(current,before);
  const bounded=goal(3,[{type:'duration',minSeconds:29,maxSeconds:30}]);
  assert.equal(presentation.taskLatestGoalStep([bounded])?.id,bounded.id);
});

test('H4b goal updates follow saved positions and an empty declaration replaces older requirements',()=>{
  const first=goal(1),second=goal(3,[{type:'subtitle_count',min:1},{type:'shot_count',max:6}]),cleared=goal(5,[]);
  assert.equal(presentation.taskLatestGoalStep([second,first])?.id,second.id);
  assert.deepEqual([...presentation.taskUpdatedGoalStepIds([second,first])],[first.id]);
  assert.equal(presentation.taskLatestGoalStep([second,cleared,first])?.id,cleared.id);
  assert.deepEqual(new Set(presentation.taskUpdatedGoalStepIds([second,cleared,first])),new Set([first.id,second.id]));
  assert.equal(presentation.taskGoalCount(cleared),0);
});

test('H4b rejected and unfinished goal calls never replace the latest completed declaration',()=>{
  const original=goal(1);
  for(const status of ['intent','dispatch_started','awaiting_approval','awaiting_answer','unknown','denied','rejected','failed'] as const){
    const later=goal(2,[],{status});
    assert.equal(presentation.taskLatestGoalStep([original,later])?.id,original.id,status);
    assert.equal(presentation.taskUpdatedGoalStepIds([original,later]).size,0,status);
  }
});

test('H4b corrupt latest goal receipts withhold requirements instead of reviving an older set',()=>{
  const first=goal(1),second=goal(2,[{type:'shot_count',min:1}]);
  for(const result of [null,{conditions:[{type:'shot_count',min:2}]},{conditions:[{type:'unknown',text:'DO_NOT_SHOW'}]},{conditions:[],approved:true}]){
    const corrupt=goal(3,[{type:'shot_count',min:1}],{result:json(result)});
    assert.equal(presentation.taskLatestGoalStep([first,second,corrupt]),undefined);
    assert.deepEqual([...presentation.taskUpdatedGoalStepIds([first,second,corrupt])],[first.id]);
    assert.equal(presentation.taskGoalCount(corrupt),undefined);
    assert.equal(presentation.taskStepTitle(corrupt,'en'),'Set requirements');
  }
});

test('H4b updated goal badges stay within the same round and require matching completed receipts',()=>{
  const first=goal(1),different=goal(2,[],{runId:'20000000-0000-4000-8000-000000000002'});
  assert.equal(presentation.taskUpdatedGoalStepIds([first,different]).size,0);
  const later=goal(3,[]),updated=presentation.taskUpdatedGoalStepIds([first,later]);
  assert.equal(presentation.taskStepBadge(first,updated),'updated');
  assert.equal(presentation.taskStepBadge(later,updated),undefined);
  assert.equal(presentation.taskStepBadge(step(4),updated),undefined);
});

test('H4b only the repair model request gets its fixed title and repair badge',()=>{
  const repair={sourceModelStepId:id(1)},model=step(2,{repair,text:'DO_NOT_SHOW_TITLE'}),tool=goal(3,undefined,{repair});
  for(const locale of LOCALES){
    assert.equal(presentation.taskStepTitle(model,locale),translate(locale,'agent.panel.goal.repairTitle'));
    assert.equal(presentation.taskStepTitle(step(4,{text:'DO_NOT_SHOW_TITLE'}),locale),translate(locale,'agent.display.model'));
    assert.doesNotMatch(presentation.taskStepTitle(model,locale),/DO_NOT_SHOW|30000000|mioon_/u);
  }
  assert.equal(presentation.taskStepBadge(model),'repair');
  assert.equal(presentation.taskStepBadge(tool),undefined);
  assert.equal(presentation.taskStepBadge(step(4,{kind:'wait',repair})),undefined);
  assert.equal(presentation.taskStepTitle(tool,'en'),'Set requirements · 1');
});

test('H4b repair chains mark only the first model by position, separately for each round and source',()=>{
  const repair={sourceModelStepId:id(1)},first=step(2,{repair}),tool=goal(3,undefined,{repair}),later=step(4,{repair});
  const otherSource=step(5,{repair:{sourceModelStepId:id(8)}}),otherRound=step(6,{runId:'20000000-0000-4000-8000-000000000002',repair});
  const steps=[later,tool,otherRound,otherSource,first],firstRepairs=presentation.taskFirstGoalRepairStepIds(steps);
  assert.deepEqual(firstRepairs,new Set([first.id,otherSource.id,otherRound.id]));
  for(const locale of LOCALES){
    assert.equal(presentation.taskStepTitle(first,locale,firstRepairs),translate(locale,'agent.panel.goal.repairTitle'));
    assert.equal(presentation.taskStepTitle(later,locale,firstRepairs),translate(locale,'agent.display.model'));
    assert.equal(presentation.taskStepTitle(tool,locale,firstRepairs),translate(locale,'agent.panel.goal.titleCount',{count:1}));
  }
  assert.deepEqual(steps.map(step=>presentation.taskStepBadge(step,undefined,firstRepairs)),[undefined,undefined,'repair','repair','repair']);
});

test('H4b malformed goal arguments cannot reflect arbitrary values in a step title',()=>{
  for(const args of [{conditions:[{type:'subtitle_count',min:1}],secret:'DO_NOT_SHOW'},{conditions:[{type:'subtitle_count',min:'DO_NOT_SHOW'}]},{conditions:'DO_NOT_SHOW'},{conditions:Array.from({length:21},()=>({type:'generation_completed'}))}]){
    const malformed=goal(1,[],{toolCall:{id:'call',name:'mioon_goal_set',arguments:json(args)},result:json(args),text:'DO_NOT_SHOW'});
    assert.equal(presentation.taskGoalCount(malformed),undefined);
    assert.equal(presentation.taskStepTitle(malformed,'en'),'Set requirements');
  }
});

interface RenderNode {type:unknown;props:Record<string,unknown> & {children:unknown[]}}
interface Hook {value?:unknown;current?:unknown;deps?:readonly unknown[];effect?:()=>void|(()=>void);cleanup?:void|(()=>void)}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nodes=(value:unknown):RenderNode[]=>Array.isArray(value)?value.flatMap(nodes):record(value)&&record(value.props)&&Array.isArray(value.props.children)?[value as unknown as RenderNode,...nodes(value.props.children)]:[];
const text=(value:unknown):string=>Array.isArray(value)?value.map(text).join(''):record(value)&&record(value.props)?text(value.props.children):typeof value==='string'||typeof value==='number'?String(value):'';
const panelSource=readFileSync(new URL('../apps/web/src/AgentTaskPanel.tsx',import.meta.url),'utf8');
function panel(value:AgentTaskSnapshot,locale:Locale='zh-Hans',readOnly=false) {
  const hooks:Hook[]=[];
  let cursor=0,pending:number[]=[],tree:unknown;
  const state={phase:'ready',project:{readOnly,runs:[value.run],authorization:{scopes:['project_agent']},settings:{configuration:{model:'synthetic-model'}}},snapshot:value,draft:'',uploads:[],pending:null,error:'',conversationId:runId,conversation:{id:runId,title:'Synthetic'},rounds:[value],selectionKey:runId,legacy:false,draftDirty:false,draftVersion:0,unknownOutcome:false,history:{conversations:[],nextCursor:null,phase:'closed'}};
  const react={createElement:(type:unknown,props:Record<string,unknown>|null,...children:unknown[])=>({type,props:{...props,children}}),Fragment:'fragment',useRef:(current:unknown)=>hooks[cursor++]??={current},useState:(value:unknown)=>{const index=cursor++;hooks[index]??={value};return[hooks[index]!.value,(next:unknown)=>{hooks[index]!.value=typeof next==='function'?next(hooks[index]!.value):next;}];},useLayoutEffect:(effect:()=>void|(()=>void),deps:readonly unknown[])=>{const index=cursor++,old=hooks[index];if(!old||deps.some((value,at)=>value!==old.deps?.[at])){hooks[index]={...old,effect,deps};pending.push(index);}}};
  const previous=globalThis.document;
  globalThis.document={visibilityState:'visible',addEventListener(){},removeEventListener(){}} as unknown as Document;
  const module:{exports:{default?:(props:Record<string,unknown>)=>unknown}}={exports:{}};
  const dependencies=(name:string):unknown=>{
    if(name==='react')return{...react,default:react};
    if(name==='./agent-task-presentation.ts')return presentation;
    if(name==='./agent-task-requirements.ts')return requirements;
    if(name==='./agent-task-reviews.ts')return reviews;
    if(name==='./agent-task-questions.ts')return questions;
    if(name==='./agent-task-errors.ts')return{agentTaskErrorKey};
    if(name.includes('I18nProvider'))return{useI18n:()=>createI18nTestContext(locale)};
    if(name.includes('workspace-visibility'))return{useWorkspaceVisibility:()=>true};
    if(name.includes('workbench-controls'))return{WorkbenchButton:'button',WorkbenchDialogContent:'dialog-content'};
    if(name.includes('workbench-tooltip'))return{WorkbenchTooltip:'tooltip'};
    if(name.includes('workbench-popover'))return{WorkbenchPopover:'popover',WorkbenchPopoverContent:'popover-content',WorkbenchPopoverTrigger:'popover-trigger'};
    if(name.includes('/dialog'))return{Dialog:'dialog'};
    if(name.includes('/textarea'))return{Textarea:'textarea'};
    if(name.includes('/input'))return{Input:'input'};
    if(name==='./AgentTaskChecks.tsx')return{__esModule:true,default:'checks'};
    if(name==='./agent-tasks-v2.ts')return{agentTaskNewConversationBlock,agentTaskSessionBusy,agentTaskWaitingQuestion,createAgentTaskReceiptStore:()=>({}),agentTaskPromptValid:()=>true,createAgentTaskSession:(options:{onChange:(value:typeof state)=>void})=>({getState:()=>state,load:()=>options.onChange(state),setVisible(){},dispose(){}})};
    if(name.includes('native-close-sources'))return{createAgentTaskCloseReporter:()=>({publish(){},release(){}})};
    if(name.includes('agent-settings.ts'))return{deriveAgentEndpoint:()=>'/synthetic'};
    return{__esModule:true,default:'placeholder'};
  };
  try{Function('module','exports','require',transformSync(panelSource,{loader:'tsx',format:'cjs'}).code)(module,module.exports,dependencies);}catch(error){globalThis.document=previous;throw error;}
  const render=()=>{cursor=0;pending=[];tree=module.exports.default!({projectId,onSettings(){},onClose(){}});for(const index of pending){hooks[index]!.cleanup?.();hooks[index]!.cleanup=hooks[index]!.effect!();}return nodes(tree);};
  try{render();render();}catch(error){for(const hook of hooks)hook.cleanup?.();globalThis.document=previous;throw error;}
  return{render,find:(testId:string)=>nodes(tree).find(node=>node.props['data-testid']===testId),close(){for(const hook of hooks)hook.cleanup?.();globalThis.document=previous;}};
}

test('H4b real Panel renders read-only goal rows and only model/old-goal neutral badges',()=>{
  const first=goal(1),latest=goal(3,[{type:'subtitle_count',min:1},{type:'shot_count',max:6}]),repair=step(5,{repair:{sourceModelStepId:id(4)},text:'Repairing'}),tool=goal(6,undefined,{repair:{sourceModelStepId:id(4)},status:'intent'});
  for(const locale of LOCALES)for(const readOnly of [false,true]){
    const h=panel(snapshot([first,latest,repair,tool]),locale,readOnly);
    try{
      const tree=h.render(),badges=tree.filter(node=>node.props['data-testid']==='agent-task-step-badge');
      assert.deepEqual(badges.map(node=>node.props['data-badge']),['updated','repair']);
      assert.deepEqual(badges.map(text),[translate(locale,'agent.panel.goal.updatedBadge'),translate(locale,'agent.panel.goal.repairBadge')]);
      assert.ok(badges.every(node=>node.type==='span'&&node.props.className==='mio-step-badge'));
      for(const goal of [first,latest])assert.equal(tree.find(node=>node.props['data-step-id']===goal.id)?.props['data-read'],'true');
      assert.equal(tree.find(node=>node.props['data-step-id']===repair.id)?.props['data-read'],undefined);
      assert.ok(tree.some(node=>node.type==='checks'&&node.props.readOnly===readOnly));
      assert.doesNotMatch(text(tree),/mioon_goal_set|sourceModelStepId|subtitle_count/u);
    }finally{h.close();}
  }
});

test('H4b real Panel exposes completion checks during active repairs, including approval and answers',()=>{
  const repair=step(2,{repair:{sourceModelStepId:id(1)},text:'Repairing'});
  for(const status of ['running','awaiting_approval','awaiting_answer','completed','paused','failed','stopped','interrupted','reverted'] as const){
    const h=panel(snapshot([goal(1),repair],status));
    try{assert.equal(h.render().some(node=>node.type==='checks'),['running','awaiting_approval','awaiting_answer','completed'].includes(status),status);}finally{h.close();}
  }
  for(const steps of [[goal(1),step(2,{text:'Working'})],[goal(1,undefined,{repair:{sourceModelStepId:id(1)}}),step(2,{text:'Working'})]]){
    const h=panel(snapshot(steps,'running'));
    try{assert.equal(h.render().some(node=>node.type==='checks'),false);}finally{h.close();}
  }
});

test('H4b real Panel labels a model-tool-model repair continuation exactly once, including recovery copy',()=>{
  const repair={sourceModelStepId:id(1)},first=step(2,{repair,text:'Read the project'}),tool=goal(3,undefined,{repair}),later=step(4,{repair,text:'Finished'});
  for(const readOnly of [false,true]){
    const h=panel(snapshot([goal(1),later,tool,first]),'en',readOnly);
    try{
      const tree=h.render(),badges=tree.filter(node=>node.props['data-testid']==='agent-task-step-badge'&&node.props['data-badge']==='repair');
      assert.equal(badges.length,1);
      assert.match(text(tree.find(node=>node.props['data-step-id']===first.id)),/Repair unmet requirements/u);
      const laterRow=tree.find(node=>node.props['data-step-id']===later.id);
      assert.match(text(laterRow),new RegExp(translate('en','agent.display.model'),'u'));
      assert.doesNotMatch(text(laterRow),/Repair unmet requirements|Repair/u);
    }finally{h.close();}
  }
});

test('H4b active repairs mount completion checks even when every model reply is empty',()=>{
  const original=step(2,{text:'',result:{text:'',toolCalls:[]}}),repair=step(3,{repair:{sourceModelStepId:original.id},text:'',result:{text:'',toolCalls:[]}});
  for(const status of ['running','awaiting_approval','awaiting_answer'] as const){
    const h=panel(snapshot([goal(1),original,repair],status));
    try{assert.equal(h.render().some(node=>node.type==='checks'),true,status);}finally{h.close();}
  }
  for(const value of [snapshot([goal(1),original],'running'),snapshot([goal(1),original,repair],'completed')]){
    const h=panel(value);
    try{assert.equal(h.render().some(node=>node.type==='checks'),false,value.run.status);}finally{h.close();}
  }
});
