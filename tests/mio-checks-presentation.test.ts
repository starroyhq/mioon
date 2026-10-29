import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_TASK_CHECK_REASONS,AGENT_TASK_CHECK_TARGET_KINDS} from '../packages/contracts/src/agent-task-checks-v2.ts';
import type {AgentTaskCheck,AgentTaskCheckValues} from '../packages/contracts/src/agent-task-checks-v2.ts';
import type {AgentTaskChange,AgentTaskSnapshot,AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {LOCALES,translate} from '../packages/i18n/src/index.ts';
import {taskCheckTargetTitle,taskTargetTitle,taskCheckExplanation,taskCheckMetadata,taskCheckLocation} from '../apps/web/src/agent-task-presentation.ts';

const projectId='20000000-0000-4000-8000-000000000001',runId='20000000-0000-4000-8000-000000000002',targetId='20000000-0000-4000-8000-000000000003',otherId='20000000-0000-4000-8000-000000000004',stepId='20000000-0000-4000-8000-000000000005',stamp='2026-10-29T00:00:00.000Z';
function check(patch:Partial<AgentTaskCheck>={}):AgentTaskCheck{return {id:'synthetic-check',type:'export_artifact',source:'host',status:'failed',target:{kind:'export',id:targetId},basis:[{kind:'export',id:targetId,revision:1}],...patch};}
function snapshot(patch:Partial<AgentTaskSnapshot>={}):AgentTaskSnapshot{return {run:{id:runId,projectId,requestId:'synthetic-check-presentation',text:'Synthetic local fixture',status:'completed',revision:3,stepLimit:30,budget:30,stepsUsed:2,configuration:{},createdAt:stamp,updatedAt:stamp},steps:[],changes:[],...patch};}
function change(targets:AgentTaskChange['targets']):AgentTaskChange{return {id:otherId,runId,stepId,projectId,operation:'shot.update',targets,before:null,after:null,reversible:true,status:'applied',createdAt:stamp};}
function step(name:string,patch:Partial<AgentTaskStep>={}):AgentTaskStep{return {id:stepId,runId,position:1,kind:'tool',status:'completed',createdAt:stamp,updatedAt:stamp,toolCall:{id:'synthetic-call',name,arguments:{}},...patch};}

test('check object titles prefer the supplied safe name before the existing lookup fallback',()=>{
 for(const locale of LOCALES){
  let lookups=0;const lookup=()=>{lookups++;return 'Current canvas title';},named=check({target:{kind:'shot',id:targetId,name:'  Saved\u202e A/B\n title  '}});
  assert.equal(taskCheckTargetTitle(named,locale,lookup),'Saved A/B title');assert.equal(lookups,0);
  const unnamed=check({target:{kind:'shot',id:targetId}});assert.equal(taskCheckTargetTitle(unnamed,locale,lookup),taskTargetTitle('shot',targetId,locale,lookup));
  assert.equal(taskCheckTargetTitle(unnamed,locale),taskTargetTitle('shot',targetId,locale));
  assert.equal(taskCheckTargetTitle(check({target:{kind:'asset',id:targetId,name:'/private/project/scene-a.mp4'}}),locale),'scene-a.mp4');
  assert.equal(taskCheckTargetTitle(check({target:{kind:'asset',id:targetId,name:'C:\\private\\scene-a.mp4'}}),locale),'scene-a.mp4');
  assert.equal(taskCheckTargetTitle(check({target:{kind:'shot',id:targetId,name:'🌃'.repeat(50)}}),locale),'🌃'.repeat(40));
 }
});

test('every current check reason becomes four-language prose without machine values or issue codes',()=>{
 const values:AgentTaskCheckValues={status:'synthetic_private_status',issueCodes:['SYNTHETIC_PRIVATE_ISSUE'],cost:'unknown',assetId:targetId,versionId:otherId};
 for(const reason of AGENT_TASK_CHECK_REASONS)for(const locale of LOCALES){
  const item=check({reason:{code:reason,params:values},current:values,expected:values}),text=taskCheckExplanation(item,locale);
  assert.equal(text,translate(locale,`agent.checks.reason.${reason}`),`${reason}/${locale}`);assert.ok(text?.trim());
  assert.doesNotMatch(text,/agent\.checks\.|SYNTHETIC_PRIVATE_ISSUE|synthetic_private_status|20000000|issueCodes|versionId|assetId/u);assert.ok(!text.includes(reason));
 }
 const noReason=check({status:'pending',current:values});assert.equal(taskCheckExplanation(noReason,'en'),undefined);
});

test('resolution mismatch details require all four supplied dimensions and an actual difference',()=>{
 const expected:AgentTaskCheckValues={width:1080,height:1920},current:AgentTaskCheckValues={width:720,height:1280},item=check({type:'export_parameters',reason:{code:'PARAMETERS_MISMATCH'},expected,current});
 for(const locale of LOCALES){
  const detail=taskCheckExplanation(item,locale);assert.ok(detail);assert.ok(detail.includes('1080×1920'));assert.ok(detail.includes('720×1280'));assert.doesNotMatch(detail,/undefined|NaN|PARAMETERS_MISMATCH/u);
  for(const container of ['expected','current'] as const)for(const field of ['width','height'] as const){const partial={...item,[container]:{...item[container]}};delete partial[container]![field];assert.equal(taskCheckExplanation(partial,locale),translate(locale,'agent.checks.reason.PARAMETERS_MISMATCH'));}
  assert.equal(taskCheckExplanation({...item,current:expected},locale),translate(locale,'agent.checks.reason.PARAMETERS_MISMATCH'));
  assert.equal(taskCheckExplanation({...item,expected:undefined,current:undefined,reason:{code:'PARAMETERS_MISMATCH',params:{width:1080,height:1920}}},locale),translate(locale,'agent.checks.reason.PARAMETERS_MISMATCH'));
 }
});

test('count explanations use supplied missing and blocking counts without inventing file facts',()=>{
 for(const locale of LOCALES){
  const missing=check({type:'timeline_references',reason:{code:'REFERENCES_UNAVAILABLE',params:{missingCount:2}},current:{missingCount:1}});
  assert.equal(taskCheckExplanation(missing,locale),translate(locale,'agent.checks.reason.REFERENCES_UNAVAILABLE.count',{count:2}));
  assert.equal(taskCheckExplanation({...missing,reason:{code:'REFERENCES_UNAVAILABLE'}},locale),translate(locale,'agent.checks.reason.REFERENCES_UNAVAILABLE.count',{count:1}));
  assert.equal(taskCheckExplanation({...missing,reason:{code:'REFERENCES_UNAVAILABLE'},current:{}},locale),translate(locale,'agent.checks.reason.REFERENCES_UNAVAILABLE'));
  const blocked=check({type:'timeline_preflight',reason:{code:'PREFLIGHT_BLOCKED',params:{blockingCount:3}},current:{blockingCount:1,issueCodes:['SYNTHETIC_PRIVATE_ISSUE']}});
  assert.equal(taskCheckExplanation(blocked,locale),translate(locale,'agent.checks.reason.PREFLIGHT_BLOCKED.count',{count:3}));
  assert.equal(taskCheckExplanation({...blocked,reason:{code:'PREFLIGHT_BLOCKED'}},locale),translate(locale,'agent.checks.reason.PREFLIGHT_BLOCKED.count',{count:1}));
  assert.equal(taskCheckExplanation({...blocked,reason:{code:'PREFLIGHT_BLOCKED'},current:{blockingCount:0}},locale),translate(locale,'agent.checks.reason.PREFLIGHT_BLOCKED'));
  assert.doesNotMatch(taskCheckExplanation(check({reason:{code:'ARTIFACT_UNAVAILABLE'}}),locale)??'',/已(?:被)?(?:移动|移動|删除|刪除)|was (?:moved|deleted)|削除されました/u);
 }
});

test('only supplied pending progress becomes a localized percentage and other waits retain their reason',()=>{
 for(const locale of LOCALES)for(const progress of [0,62,100]){
  const item=check({type:'generation_status',status:'pending',progress,reason:{code:'TASK_PENDING'}});
  assert.equal(taskCheckExplanation(item,locale),translate(locale,'agent.checks.generationProgress',{progress:new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(progress)}));
  assert.equal(taskCheckExplanation({...item,type:'frame_status'},locale),translate(locale,'agent.checks.progress',{progress:new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(progress)}));
 }
 assert.equal(taskCheckExplanation(check({type:'generation_status',status:'pending',progress:62.34}),'en'),'Generating 62.3%');
 assert.equal(taskCheckExplanation(check({status:'passed',progress:62}),'en'),undefined);
 for(const locale of LOCALES)for(const reason of ['COST_SUBMITTED','PREFLIGHT_INCOMPLETE','PREFLIGHT_UNAVAILABLE'] as const){const text=taskCheckExplanation(check({status:'pending',reason:{code:reason}}),locale);assert.equal(text,translate(locale,`agent.checks.reason.${reason}`));assert.doesNotMatch(text??'',/%|62/u);}
});

test('timeline metadata displays only supplied clip count, paired dimensions and frame rate',()=>{
 const current:AgentTaskCheckValues={referenceCount:3,width:1080,height:1920,fps:30,durationFrames:90,assetId:targetId,status:'synthetic_private_status',issueCodes:['SYNTHETIC_PRIVATE_ISSUE']};
 for(const locale of LOCALES){
  const item=check({type:'timeline_preflight',current});assert.deepEqual(taskCheckMetadata(item,locale),[translate(locale,'agent.checks.metadata.clips',{count:3}),'1080×1920','30 fps']);
  assert.deepEqual(taskCheckMetadata({...item,current:undefined,expected:current},locale),[]);assert.deepEqual(taskCheckMetadata({...item,type:'export_parameters'},locale),[]);
  assert.deepEqual(taskCheckMetadata({...item,current:{width:1080}},locale),[]);assert.deepEqual(taskCheckMetadata({...item,current:{height:1920}},locale),[]);
  assert.deepEqual(taskCheckMetadata({...item,current:{fps:30}},locale),['30 fps']);assert.deepEqual(taskCheckMetadata({...item,current:{referenceCount:0}},locale),[translate(locale,'agent.checks.metadata.clips',{count:0})]);
 }
});

test('existing shot and timeline changes are reused for object navigation without fabricated changes',()=>{
 const shot=change([{kind:'shot',id:targetId,revision:1}]),clip=change([{kind:'timeline_clip',id:otherId,revision:2}]),value=snapshot({changes:[shot,clip]});
 assert.deepEqual(taskCheckLocation(check({target:{kind:'shot',id:targetId}}),value),{change:shot});assert.deepEqual(taskCheckLocation(check({target:{kind:'timeline',id:targetId}}),value),{change:clip});
 assert.equal(taskCheckLocation(check({target:{kind:'shot',id:otherId}}),value),undefined);assert.equal(taskCheckLocation(check({target:{kind:'timeline',id:targetId}}),snapshot({changes:[shot]})),undefined);
 assert.deepEqual(taskCheckLocation(check({target:{kind:'shot',id:targetId}}),value,true),{change:shot});assert.deepEqual(taskCheckLocation(check({target:{kind:'timeline',id:targetId}}),value,true),{change:clip});
});

test('background navigation reuses known destinations and omits restored image and frame destinations',()=>{
 const value=snapshot();
 for(const readOnly of [false,true]){
  assert.deepEqual(taskCheckLocation(check({target:{kind:'job',id:targetId}}),value,readOnly),{request:targetId});assert.deepEqual(taskCheckLocation(check({target:{kind:'scene_task',id:targetId}}),value,readOnly),{request:`scene:${targetId}`});
 }
 for(const [kind,prefix] of [['image_task','image'],['frame_task','frame']] as const){assert.deepEqual(taskCheckLocation(check({target:{kind,id:targetId}}),value),{request:`${prefix}:${targetId}`});assert.equal(taskCheckLocation(check({target:{kind,id:targetId}}),value,true),undefined);}
 const supported=new Set<AgentTaskCheck['target']['kind']>(['shot','timeline','job','scene_task','image_task','frame_task','export']);
 for(const kind of AGENT_TASK_CHECK_TARGET_KINDS)if(!supported.has(kind))assert.equal(taskCheckLocation(check({target:{kind,id:targetId}}),value),undefined,kind);
});

test('export navigation requires a matching timeline render source and never guesses storyboard exports',()=>{
 const item=check({target:{kind:'export',id:targetId}});
 assert.equal(taskCheckLocation(item,snapshot()),undefined);assert.equal(taskCheckLocation(item,snapshot({steps:[step('mioon_export_create',{result:{id:targetId}})]})),undefined);
 assert.equal(taskCheckLocation(item,snapshot({steps:[step('mioon_timeline_render',{result:{id:otherId},targets:[{kind:'export',id:otherId,revision:1}]})]})),undefined);
 assert.equal(taskCheckLocation(item,snapshot({steps:[step('mioon_generation_submit',{result:{id:targetId}})]})),undefined);
 for(const name of ['mioon_timeline_render','timeline.render'])for(const evidence of [{result:{id:targetId}},{targets:[{kind:'export',id:targetId,revision:1}]}] satisfies Array<Partial<AgentTaskStep>>){const value=snapshot({steps:[step(name,evidence)]});assert.deepEqual(taskCheckLocation(item,value),{request:`render:${targetId}`});assert.deepEqual(taskCheckLocation(item,value,true),{request:`render:${targetId}`});}
});
