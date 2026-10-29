import test from 'node:test';
import assert from 'node:assert/strict';
import {LOCALES,translate,validateCatalogs} from '../packages/i18n/src/index.ts';
import {mioRequirementMessages} from '../packages/i18n/src/catalogs/mio-requirements.ts';
import {taskRequirementTitle,taskRequirementCurrent,taskRequirementStatus,taskRequirementNote,isTaskGoalRepairActive,visibleTaskRequirements} from '../apps/web/src/agent-task-requirements.ts';
import {component,goalStep,goalId,modelId,nodes,repairStep,report,requirement,snapshot,text} from './helpers/agent-task-requirements-ui.ts';

test('H4b requirements precede host groups with the approved hint and one combined worst summary',()=>{
  const snap=snapshot(),value=report([requirement()]);
  value.groups[2]!.items.push({id:'host',source:'host',type:'timeline_references',status:'passed',target:{kind:'timeline',id:snap.run.projectId},basis:[{kind:'timeline',id:snap.run.projectId,revision:1}]});
  const tree=component(snap,value).render();
  assert.deepEqual(nodes(tree).filter(node=>node.props['data-check-group']).map(node=>node.props['data-check-group']),['requirements','timeline']);
  assert.match(text(tree),/要求Mio 根据你的话整理/u);assert.match(text(tree),/完成情况 2 项 · 1 项要求未达成/u);
  const summary=nodes(tree).find(node=>node.props['data-testid']==='agent-task-check-summary')!;assert.equal(summary.props['data-tone'],'danger');
  assert.match(text(tree),/时长 30 秒（允许 ±1 秒）当前 31.6 秒/u);
});
test('H4b repairs show failed requirements as repairing across running, approval and answer, leaving pending unchanged',()=>{
  for(const status of ['running','awaiting_approval','awaiting_answer'] as const){
    const snap=snapshot(status);snap.steps.push(repairStep({status:'dispatch_started'}));
    const value=report([requirement(),requirement({id:'pending',status:'pending',current:{}}),requirement({id:'met',status:'passed'})]);
    const tree=component(snap,value).render(),rows=nodes(tree).filter(node=>node.props['data-testid']==='agent-task-requirement');
    assert.equal(isTaskGoalRepairActive(snap),true);assert.deepEqual(rows.map(row=>row.props['data-status']),['repairing','pending','passed']);
    assert.equal(nodes(rows[0]).filter(node=>node.props.className==='wb-spinner').length,1);assert.match(text(rows[0]),/补做中/u);
    assert.equal(nodes(rows[1]).filter(node=>node.props.className==='wb-spinner').length,0);assert.match(text(rows[1]),/当前值暂不可用/u);
    assert.match(text(tree),/完成情况 3 项 · 1 项补做中/u);assert.equal(nodes(tree).some(node=>node.props['data-testid']==='agent-task-check-note'),false);
  }
});
test('H4b original active rounds and paused repairs do not expose completion early',()=>{
  const running=snapshot('running');assert.equal(isTaskGoalRepairActive(running),false);assert.equal(component(running,report([requirement()])).render(),null);
  running.steps.push(repairStep());running.run.status='paused';assert.equal(isTaskGoalRepairActive(running),false);assert.equal(component(running,report([requirement()])).render(),null);
  running.run.status='completed';assert.equal(taskRequirementStatus(requirement(),running),'failed');
});
test('H4b three explanatory notes reflect requirements and the single repair or budget boundary',()=>{
  const snap=snapshot(),failed=[requirement()],pending=[requirement({status:'pending'})];
  assert.equal(taskRequirementNote(failed,snap),undefined);assert.equal(taskRequirementNote(pending,snap),'waiting');
  snap.run.stepsUsed=snap.run.budget;assert.equal(taskRequirementNote(failed,snap),'budget');assert.equal(taskRequirementNote(pending,snap),'waiting');
  assert.equal(taskRequirementNote([requirement({status:'passed'})],snap),undefined);
  snap.steps.push(repairStep());assert.equal(taskRequirementNote(failed,snap),'once');assert.equal(taskRequirementNote(pending,snap),undefined);
  for(const [status,hasRepair,used,key] of [['failed',true,12,'once'],['pending',false,12,'waiting'],['failed',false,30,'budget']] as const){
    const value=snapshot();value.run.stepsUsed=used;if(hasRepair)value.steps.push(repairStep());
    const tree=component(value,report([requirement({status})])).render(),note=nodes(tree).find(node=>node.props['data-testid']==='agent-task-check-note')!;
    assert.equal(text(note),translate('zh-Hans',`agent.requirements.note.${key}`));assert.equal(nodes(note).some(node=>node.type==='button'),false);
  }
});
test('H4b new declarations and clearing receipts suppress cached previous requirements immediately',()=>{
  const snap=snapshot(),old=report([requirement()]);assert.equal(visibleTaskRequirements(old,snap).length,1);
  const nextId='30000000-0000-4000-8000-000000000002';snap.steps.push(goalStep([{type:'subtitle_count',min:1}],{id:nextId,position:3}));assert.deepEqual(visibleTaskRequirements(old,snap),[]);
  assert.equal(visibleTaskRequirements(report([requirement({goalStepId:nextId})]),snap).length,1);
  snap.steps.push(goalStep([],{id:'30000000-0000-4000-8000-000000000003',position:4}));assert.deepEqual(visibleTaskRequirements(old,snap),[]);
  assert.deepEqual(visibleTaskRequirements({...old,runId:modelId},snapshot()),[]);
  const diagnostic=snapshot();diagnostic.run.diagnostic={profile:'text'};assert.deepEqual(visibleTaskRequirements(old,diagnostic),[]);
});
test('H4b range, count, format and generation copy use only observed machine values in four languages',()=>{
  const cases=[requirement({expected:{maxSeconds:30}}),requirement({expected:{minSeconds:10}}),requirement({expected:{minSeconds:10,maxSeconds:30}}),requirement({expected:{minSeconds:30,maxSeconds:30}}),...(['clip_count','subtitle_count','shot_count'] as const).flatMap(type=>[{min:1},{max:3},{min:3,max:3},{min:1,max:3}].map(expected=>requirement({type,expected,current:{count:3}}))),requirement({type:'timeline_format',expected:{width:1080,height:1920,fps:30},current:{width:1080,height:1920,fps:30}}),requirement({type:'export_parameters',expected:{width:1080,durationFrames:900},current:{width:1080,durationFrames:900}}),requirement({type:'generation_completed',expected:{status:'succeeded'},current:{count:2,completedCount:1}})];
  for(const locale of LOCALES)for(const item of cases){assert.ok(taskRequirementTitle(item,locale));assert.ok(taskRequirementCurrent(item,locale));assert.doesNotMatch(taskRequirementTitle(item,locale),/undefined|NaN/u);}
  assert.equal(taskRequirementTitle(cases[0]!,'zh-Hans'),'时长不超过 30 秒');assert.equal(taskRequirementTitle(cases[7]!,'en'),'1–3 clips');
  assert.equal(taskRequirementTitle(requirement({type:'subtitle_count',expected:{min:1}}),'en'),'At least 1 caption');
  assert.equal(taskRequirementTitle(requirement({type:'subtitle_count',expected:{min:2}}),'en'),'At least 2 captions');
  assert.equal(taskRequirementCurrent(cases.at(-1)!,'zh-Hans'),'当前 1/2 已完成');assert.equal(taskRequirementCurrent(requirement({current:{}}),'en'),'Current value unavailable');
  assert.equal(taskRequirementCurrent(requirement({type:'generation_completed',current:{count:0,completedCount:0}}),'en'),'No generation result to check yet');
});
test('H4b restored views show requirements and notes through existing read controls, including English',()=>{
  const snap=snapshot();snap.steps.push(repairStep());const tree=component(snap,report([requirement()]),{locale:'en',readOnly:true}).render();
  assert.match(text(tree),/1 requirement not met/u);assert.match(text(tree),/Set by Mio from your request/u);assert.match(text(tree),/Now 31.6 s/u);assert.match(text(tree),/Mio repairs automatically once per round/u);
  assert.equal(nodes(tree).filter(node=>node.type==='button').length,2);assert.equal(nodes(tree).filter(node=>node.props['data-testid']==='agent-task-requirement').length,1);
});
test('H4b all-met requirements default collapsed and every added phrase has four-language placeholders',()=>{
  const tree=component(snapshot(),report([requirement({status:'passed'})])).render();assert.match(text(tree),/全部达成/u);assert.equal(nodes(tree).find(node=>node.props.id==='h4b-checks')!.props.hidden,true);
  assert.deepEqual(validateCatalogs(mioRequirementMessages),[]);
  for(const [key,value] of Object.entries(mioRequirementMessages))for(const locale of LOCALES){assert.ok(value[locale]);assert.doesNotMatch(JSON.stringify(value[locale]),/任务|任務|\btasks?\b|タスク/iu,key);}
  assert.equal(goalId,snapshot().steps[0]!.id);
});
