import type {AgentTaskSnapshot} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskChecks,AgentTaskCheckValues,AgentTaskRequirement} from '../../../packages/contracts/src/agent-task-checks-v2.ts';
import {translate} from '../../../packages/i18n/src/index.ts';
import type {Locale} from '../../../packages/i18n/src/index.ts';
import {taskLatestGoalStep} from './agent-task-presentation.ts';

export type TaskRequirementStatus='passed'|'failed'|'pending'|'repairing';
export const hasTaskGoalRepair=(snapshot:AgentTaskSnapshot):boolean=>snapshot.steps.some(step=>step.kind==='model'&&step.runId===snapshot.run.id&&step.repair!==undefined);
export function isTaskGoalRepairActive(snapshot:AgentTaskSnapshot):boolean {
  return !snapshot.run.diagnostic&&['running','awaiting_approval','awaiting_answer'].includes(snapshot.run.status)&&hasTaskGoalRepair(snapshot);
}
export const taskCurrentGoalStepId=(snapshot:AgentTaskSnapshot):string|undefined=>taskLatestGoalStep(snapshot.steps.filter(step=>step.runId===snapshot.run.id))?.id;
/** A cached report may precede the latest declaration or its clearing receipt.
 * Never show those older requirements while the replacement read is pending. */
export function visibleTaskRequirements(report:AgentTaskChecks|null,snapshot:AgentTaskSnapshot):AgentTaskRequirement[] {
  if(snapshot.run.diagnostic||!report||report.runId!==snapshot.run.id||report.projectId!==snapshot.run.projectId)return [];
  const latest=taskCurrentGoalStepId(snapshot);
  return latest?(report.requirements??[]).filter(item=>item.goalStepId===latest&&item.status!=='not_applicable'):[];
}
export function taskRequirementStatus(item:AgentTaskRequirement,snapshot:AgentTaskSnapshot):TaskRequirementStatus {
  return item.status==='failed'&&isTaskGoalRepairActive(snapshot)?'repairing':item.status==='passed'?'passed':item.status==='failed'?'failed':'pending';
}
export function taskRequirementNote(items:readonly AgentTaskRequirement[],snapshot:AgentTaskSnapshot):'once'|'waiting'|'budget'|undefined {
  if(!items.length||isTaskGoalRepairActive(snapshot))return;
  const failed=items.some(item=>item.status==='failed'),pending=items.some(item=>item.status==='pending'),repair=hasTaskGoalRepair(snapshot);
  if(repair&&failed)return 'once';
  if(!repair&&!failed&&pending)return 'waiting';
  if(!repair&&failed&&snapshot.run.stepsUsed>=snapshot.run.budget)return 'budget';
}
const numeric=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const number=(locale:Locale,value:number)=>new Intl.NumberFormat(locale,{useGrouping:false,maximumFractionDigits:3}).format(value);
function geometry(value:AgentTaskCheckValues,locale:Locale):string {
  const parts:string[]=[];
  if(numeric(value.width)&&numeric(value.height))parts.push(translate(locale,'agent.requirements.geometry.resolution',{width:value.width,height:value.height}));
  else if(numeric(value.width))parts.push(translate(locale,'agent.requirements.geometry.width',{width:value.width}));
  else if(numeric(value.height))parts.push(translate(locale,'agent.requirements.geometry.height',{height:value.height}));
  if(numeric(value.fps))parts.push(translate(locale,'agent.requirements.geometry.fps',{fps:number(locale,value.fps)}));
  if(numeric(value.durationFrames))parts.push(translate(locale,'agent.requirements.geometry.frames',{frames:value.durationFrames}));
  return parts.join(' · ');
}
export function taskRequirementTitle(item:AgentTaskRequirement,locale:Locale):string {
  const value=item.expected;
  if(item.type==='duration'){
    if(numeric(value.durationSeconds))return numeric(value.toleranceSeconds)&&value.toleranceSeconds>0
      ?translate(locale,'agent.requirements.duration.tolerance',{seconds:number(locale,value.durationSeconds),tolerance:number(locale,value.toleranceSeconds)})
      :translate(locale,'agent.requirements.duration.exact',{seconds:number(locale,value.durationSeconds)});
    if(numeric(value.minSeconds)&&numeric(value.maxSeconds))return value.minSeconds===value.maxSeconds
      ?translate(locale,'agent.requirements.duration.exact',{seconds:number(locale,value.minSeconds)})
      :translate(locale,'agent.requirements.duration.range',{min:number(locale,value.minSeconds),max:number(locale,value.maxSeconds)});
    if(numeric(value.minSeconds))return translate(locale,'agent.requirements.duration.min',{seconds:number(locale,value.minSeconds)});
    if(numeric(value.maxSeconds))return translate(locale,'agent.requirements.duration.max',{seconds:number(locale,value.maxSeconds)});
  }
  if(item.type==='clip_count'||item.type==='subtitle_count'||item.type==='shot_count'){
    const kind=item.type;
    if(numeric(value.min)&&numeric(value.max)&&value.min!==value.max)return translate(locale,`agent.requirements.${kind}.range`,{min:value.min,max:value.max});
    if(numeric(value.min)&&value.min===value.max)return translate(locale,`agent.requirements.${kind}.exact`,{count:value.min});
    if(numeric(value.min))return translate(locale,`agent.requirements.${kind}.min`,{count:value.min});
    if(numeric(value.max))return translate(locale,`agent.requirements.${kind}.max`,{count:value.max});
  }
  if(item.type==='generation_completed')return translate(locale,'agent.requirements.generation_completed');
  if(item.type==='timeline_format'||item.type==='export_parameters')return translate(locale,`agent.requirements.${item.type}`,{values:geometry(value,locale)});
  return translate(locale,'agent.requirements.current.unavailable');
}
export function taskRequirementCurrent(item:AgentTaskRequirement,locale:Locale):string {
  const value=item.current;
  if(item.type==='duration'&&numeric(value.durationSeconds))return translate(locale,'agent.requirements.current.duration',{seconds:number(locale,value.durationSeconds)});
  if((item.type==='clip_count'||item.type==='subtitle_count'||item.type==='shot_count')&&numeric(value.count))return translate(locale,`agent.requirements.current.${item.type}`,{count:value.count});
  if(item.type==='generation_completed'&&numeric(value.completedCount)&&numeric(value.count))return value.count===0?translate(locale,'agent.requirements.current.generationEmpty'):translate(locale,'agent.requirements.current.generation',{completed:value.completedCount,total:value.count});
  if(item.type==='timeline_format'||item.type==='export_parameters'){
    const values=geometry(value,locale);if(values)return translate(locale,'agent.requirements.current.geometry',{values});
  }
  return translate(locale,'agent.requirements.current.unavailable');
}
