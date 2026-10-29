import {agentTaskGoalsSchema} from '@mioon/contracts/agent-tasks-v2';
import type {AgentTaskGoals,AgentTaskGoalCondition,AgentTaskStep,AgentTaskCheck,AgentTaskCheckValues,AgentTaskRequirement} from '@mioon/contracts/agent-tasks-v2';

const integer={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const number={type:'number',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const dimension={...integer,minimum:1},fps={type:'number',exclusiveMinimum:0,maximum:Number.MAX_SAFE_INTEGER};
const condition=(type:string,properties:Record<string,unknown>={},required:string[]=[])=>({type:'object',properties:{type:{type:'string',enum:[type]},...properties},required:['type',...required],additionalProperties:false});
export const AGENT_TASK_GOAL_SET_PARAMETERS=Object.freeze({type:'object',properties:{conditions:{type:'array',maxItems:20,items:{anyOf:[
 condition('duration',{seconds:number,toleranceSeconds:number},['seconds']),
 {...condition('duration',{minSeconds:number,maxSeconds:number}),description:'Inclusive duration bounds in seconds: provide minSeconds, maxSeconds or both, with minSeconds not exceeding maxSeconds. Do not combine bounds with seconds or toleranceSeconds.',anyOf:[{required:['minSeconds']},{required:['maxSeconds']}]},
 condition('timeline_format',{width:dimension,height:dimension,fps},['width','height','fps']),
 {...condition('export_parameters',{width:dimension,height:dimension,fps,durationFrames:integer}),anyOf:['width','height','fps','durationFrames'].map(key=>({required:[key]}))},
 ...['clip_count','subtitle_count','shot_count'].map(type=>({...condition(type,{min:integer,max:integer}),description:'Inclusive count bounds: provide min, max or both. When both are present, min must not exceed max. Exact counts use min=max.',anyOf:[{required:['min']},{required:['max']}]})),condition('generation_completed'),
]}}},required:['conditions'],additionalProperties:false});

/** Return a new, fixed-order JSON projection. No prose, identifiers or host
 * authority can be smuggled into a condition; [] explicitly clears goals. */
export function normalizeAgentTaskGoals(input:unknown):AgentTaskGoals|null{
 const parsed=agentTaskGoalsSchema.safeParse(input);if(!parsed.success)return null;
 return {conditions:parsed.data.conditions.map(value=>{
  if(value.type==='duration')return value.seconds!==undefined?{type:value.type,seconds:value.seconds,toleranceSeconds:value.toleranceSeconds??0}:{type:value.type,...(value.minSeconds===undefined?{}:{minSeconds:value.minSeconds}),...(value.maxSeconds===undefined?{}:{maxSeconds:value.maxSeconds})};
  if(value.type==='timeline_format')return {type:value.type,width:value.width,height:value.height,fps:value.fps};
  if(value.type==='export_parameters')return {type:value.type,...(value.width===undefined?{}:{width:value.width}),...(value.height===undefined?{}:{height:value.height}),...(value.fps===undefined?{}:{fps:value.fps}),...(value.durationFrames===undefined?{}:{durationFrames:value.durationFrames})};
  if(value.type==='generation_completed')return {type:value.type};
  return {type:value.type,...(value.min===undefined?{}:{min:value.min}),...(value.max===undefined?{}:{max:value.max})};
 })};
}
export interface TaskSavedGoals extends AgentTaskGoals {stepId:string}
/** Only this run's last completed receipt can replace its goals. A corrupt
 * newest receipt is withheld instead of reviving an older declaration. */
export function latestAgentTaskGoals(steps:readonly AgentTaskStep[]):TaskSavedGoals|undefined{
 const step=steps.filter(value=>value.kind==='tool'&&value.status==='completed'&&value.toolCall?.name==='mioon_goal_set').reduce<AgentTaskStep|undefined>((last,value)=>!last||value.position>last.position?value:last,undefined);
 if(!step)return;
 const requested=normalizeAgentTaskGoals(step.toolCall?.arguments),saved=normalizeAgentTaskGoals(step.result);
 if(!requested||!saved||JSON.stringify(requested)!==JSON.stringify(saved))return;
 return {stepId:step.id,...saved};
}

export interface TaskGoalObservation {
 timeline:{target:AgentTaskCheck['target'];basis:AgentTaskCheck['basis'];values:AgentTaskCheckValues;clipCount?:number;subtitleCount?:number};
 project:{target:AgentTaskCheck['target'];basis:AgentTaskCheck['basis'];shotCount?:number};
 run:{target:AgentTaskCheck['target'];basis:AgentTaskCheck['basis']};
 /** The exact H3a host checks, including receipt/asset/publication validation. */
 checks:readonly AgentTaskCheck[];
 steps:readonly AgentTaskStep[];
 exports:readonly {stepId:string;checks:readonly AgentTaskCheck[];values?:AgentTaskCheckValues}[];
}
type Result=Pick<AgentTaskRequirement,'status'|'reason'>;
const pending=():Result=>({status:'pending',reason:{code:'RECORD_UNAVAILABLE'}});
const compare=(matches:boolean):Result=>matches?{status:'passed'}:{status:'failed',reason:{code:'PARAMETERS_MISMATCH'}};
function fields(condition:AgentTaskGoalCondition):AgentTaskCheckValues{
 if(condition.type==='duration')return condition.seconds!==undefined?{durationSeconds:condition.seconds,toleranceSeconds:condition.toleranceSeconds??0}:{...(condition.minSeconds===undefined?{}:{minSeconds:condition.minSeconds}),...(condition.maxSeconds===undefined?{}:{maxSeconds:condition.maxSeconds})};
 if(condition.type==='clip_count'||condition.type==='subtitle_count'||condition.type==='shot_count')return {...(condition.min===undefined?{}:{min:condition.min}),...(condition.max===undefined?{}:{max:condition.max})};
 if(condition.type==='generation_completed')return {status:'succeeded'};
 return {...(condition.width===undefined?{}:{width:condition.width}),...(condition.height===undefined?{}:{height:condition.height}),...(condition.fps===undefined?{}:{fps:condition.fps}),...('durationFrames' in condition?{durationFrames:condition.durationFrames}:{})};
}

/** Pure comparison over the host's read-only observations. In particular,
 * completion goals cannot bypass H3a's managed-file/receipt/publication checks. */
export function evaluateAgentTaskGoals(goals:TaskSavedGoals,observation:TaskGoalObservation):AgentTaskRequirement[]{
 return goals.conditions.map((condition,index)=>{
  let owner=observation.timeline,current:AgentTaskCheckValues={},result:Result=pending();const expected=fields(condition);
  if(condition.type==='duration'){
   const {durationFrames,fps}=owner.values;
   if(durationFrames!==undefined&&fps!==undefined&&fps>0){
    current={durationFrames,fps,durationSeconds:durationFrames/fps};
    // Saved timelines use integer frames. Accept the nearest half-frame in
    // addition to the explicit tolerance; the fixed epsilon is only roundoff.
    result=compare(condition.seconds!==undefined
     ?Math.abs(durationFrames-condition.seconds*fps)<=(condition.toleranceSeconds??0)*fps+0.5+1e-9
     :(condition.minSeconds===undefined||durationFrames>=condition.minSeconds*fps-0.5-1e-9)&&(condition.maxSeconds===undefined||durationFrames<=condition.maxSeconds*fps+0.5+1e-9));
   }
  }else if(condition.type==='timeline_format'){
   current=Object.fromEntries((['width','height','fps'] as const).filter(key=>owner.values[key]!==undefined).map(key=>[key,owner.values[key]]));
   if(Object.keys(current).length===3)result=compare(current.width===condition.width&&current.height===condition.height&&current.fps===condition.fps);
  }else if(condition.type==='clip_count'||condition.type==='subtitle_count'||condition.type==='shot_count'){
   const value=condition.type==='clip_count'?observation.timeline.clipCount:condition.type==='subtitle_count'?observation.timeline.subtitleCount:observation.project.shotCount;
   if(condition.type==='shot_count')owner={...observation.project,values:{}};
   if(value!==undefined){current={count:value};result=compare((condition.min===undefined||value>=condition.min)&&(condition.max===undefined||value<=condition.max));}
  }else if(condition.type==='export_parameters'){
   const names=['mioon_export_create','mioon_timeline_render'];
   const step=observation.steps.filter(item=>item.kind==='tool'&&item.toolCall&&names.includes(item.toolCall.name)).reduce<AgentTaskStep|undefined>((last,value)=>!last||value.position>last.position?value:last,undefined);
   // The H3 producer supplies the host's exact step→task binding. An ACK's
   // arbitrary id cannot switch this requirement to another export's checks.
   const observed=step?observation.exports.find(item=>item.stepId===step.id):undefined,checks=observed?.checks??[];
   const parameters=checks.find(item=>item.type==='export_parameters');
   if(parameters)owner={target:parameters.target,basis:parameters.basis,values:{}};else owner={...observation.run,values:{}};
   current={...(parameters?.expected??{}),...(observed?.values??{}),...(parameters?.current??{}),...(parameters?{status:'accepted_parameters'}:{})};
   if(checks.some(item=>item.status==='failed'))result={status:'failed',reason:{code:checks.find(item=>item.status==='failed')?.reason?.code??'TASK_FAILED'}};
   else if(checks.some(item=>item.status==='pending'))result={status:'pending',reason:{code:'TASK_PENDING'}};
   else if(!parameters||!['export_status','export_artifact','export_parameters'].every(type=>checks.some(item=>item.type===type&&item.status==='passed')))result={status:'failed',reason:{code:checks.find(item=>item.status==='failed')?.reason?.code??'NO_APPLICABLE_TASK'}};
   else if(Object.keys(expected).every(key=>Object.hasOwn(current,key)))result=compare(Object.entries(expected).every(([key,value])=>current[key as keyof AgentTaskCheckValues]===value));
  }else{
   owner={...observation.run,values:{}};
   const statuses=observation.checks.filter(item=>item.type==='generation_status'&&item.target.kind!=='run'),publications=observation.checks.filter(item=>item.type==='generation_publication');
   const completed=statuses.filter(item=>item.status==='passed'&&publications.some(publication=>publication.target.kind===item.target.kind&&publication.target.id===item.target.id&&publication.status==='passed')).length;
   current={count:statuses.length,completedCount:completed};
   if(statuses.some(item=>item.status==='failed')||publications.some(item=>item.status==='failed'))result={status:'failed',reason:{code:statuses.find(item=>item.status==='failed')?.reason?.code??publications.find(item=>item.status==='failed')?.reason?.code??'TASK_FAILED'}};
   else if(statuses.some(item=>item.status==='pending')||publications.some(item=>item.status==='pending'))result={status:'pending',reason:{code:'TASK_PENDING'}};
   else result=statuses.length&&completed===statuses.length?{status:'passed'}:{status:'failed',reason:{code:statuses.length?'VERSION_UNPUBLISHED':'NO_APPLICABLE_TASK'}};
  }
  return {id:`goal:${goals.stepId}:${index}`,type:condition.type,source:'goal',goalStepId:goals.stepId,target:owner.target,basis:owner.basis,...result,expected,current};
 });
}
