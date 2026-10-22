import {AGENT_TASK_STEP_STATUSES} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskDisplay,AgentTaskDisplayField,AgentTaskDisplayTarget,AgentTaskDisplayValue,AgentTaskStep} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {catalogs,translate} from '../../../packages/i18n/src/index.ts';
import type {Locale,MessageKey} from '../../../packages/i18n/src/index.ts';
import {mioPanelMessages} from '../../../packages/i18n/src/catalogs/mio-panel.ts';

type DisplayProperty=AgentTaskDisplayField['property'];
type DisplayUnit=AgentTaskDisplayField['unit'];
type DisplayKey=keyof typeof mioPanelMessages;
type OperationKey=Extract<DisplayKey,`agent.display.operation.${string}`>;
type TargetKey=Extract<DisplayKey,`agent.display.target.${string}`>;
type FieldKey=Extract<DisplayKey,`agent.display.field.${string}`>;
type EnumKey=Extract<DisplayKey,`agent.display.enum.${string}`>;
export type TaskDisplayLookup=(kind:string,id:string)=>string|undefined;
export interface TaskDisplayEntry {label:string;value:string}

const uuid=/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/iu;
const sensitive=/(?:\bBearer\s+|\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z\d_-]{8,}|\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+|(?:api[_ -]?key|access[_ -]?token|authorization|password|secret|credential|密钥|密鑰|密码|密碼|令牌)\s*[:=：])/iu;
const location=/(?:\b(?:https?|file|data):|[A-Za-z]:[\\/]|~\/|(?:^|\s)\/)/iu;
const controls=/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const internalId=/\b(?:shot|clip|asset|node|job|task|version|project)[_-][A-Za-z\d_-]{8,}\b/iu;

/** Even locally supplied names are presentation content, never locations or
 * identities. The server projection remains the authority for allowed fields. */
function safeText(value:unknown,limit:number):string|undefined {
  if(typeof value!=='string'||value.length>8192||controls.test(value)||uuid.test(value)||sensitive.test(value)||location.test(value)||internalId.test(value))return;
  const clean=value.replace(/\s+/gu,' ').trim();
  if(!clean||/[<>]/u.test(clean))return;
  return Array.from(clean).slice(0,limit).join('');
}
/** Description and subtitle text are authorized project content. Normalize
 * presentation controls without guessing whether their words are secrets. */
function projectText(value:string):string|undefined {
  const clean=value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/\s+/gu,' ').trim();
  if(!clean)return;
  let bounded='';for(const character of clean){if(bounded.length+character.length>240)break;bounded+=character;}return bounded;
}
function safeName(value:unknown):string|undefined {
  if(typeof value!=='string'||/^(?:https?|file|data):/iu.test(value)||value.length>8192)return;
  const basename=value.split(/[\\/]/u).at(-1);
  return safeText(basename,80);
}
const operationKeys=new Map<string,OperationKey>(Object.keys(mioPanelMessages)
  .filter(key=>key.startsWith('agent.display.operation.'))
  .map(key=>[key.slice('agent.display.operation.'.length),key as OperationKey]));
const toolOperations=new Map(Array.from(operationKeys.keys(),operation=>[`mioon_${operation.replaceAll('.','_')}`,operation]));
function knownOperation(value:string):string|undefined {
  return operationKeys.has(value)?value:toolOperations.get(value);
}

/** Short labels deliberately avoid the long public operation descriptions. */
export function taskOperationTitle(operation:string,locale:Locale):string {
  const known=knownOperation(operation),key=known?operationKeys.get(known):undefined;
  return translate(locale,key??'agent.display.fallback');
}
function targetKind(kind:string,locale:Locale):string {
  const key=`agent.display.target.${kind}`;
  return translate(locale,Object.hasOwn(mioPanelMessages,key)?key as TargetKey:'agent.display.target.unknown');
}
function targetTitle(target:AgentTaskDisplayTarget,locale:Locale,lookup?:TaskDisplayLookup):string {
  const kind=targetKind(target.kind,locale);
  const name=safeName(lookup?.(target.kind,target.id))??safeName(target.name);
  return name&&name!==kind?`${kind} · ${name}`:kind;
}
export function taskDisplayTargets(display:AgentTaskDisplay|undefined,locale:Locale,lookup?:TaskDisplayLookup):string {
  if(!display)return translate(locale,'agent.display.target.unknown');
  const names=display.targets.slice(0,200).map(target=>targetTitle(target,locale,lookup));
  const omitted=Math.max(0,display.targetCount-names.length);
  if(omitted)names.push(translate(locale,'agent.display.moreTargets',{count:omitted}));
  return names.join('、')||translate(locale,'agent.display.target.unknown');
}
const units:Readonly<Record<DisplayProperty,DisplayUnit>>={durationFrames:'frames',sourceInFrame:'frames',sourceOutFrame:'frames',startFrame:'frames',positionX:'pixels',positionY:'pixels',gainDb:'db',fadeInFrames:'frames',fadeOutFrames:'frames',aspectRatio:'ratio',durationSeconds:'seconds',description:'text',subtitleText:'text',provider:'enum',model:'text',mode:'enum',versionNumber:'count',resolution:'enum',generateAudio:'boolean',seed:'count',width:'pixels',height:'pixels',count:'count',quality:'enum',outputFormat:'enum',background:'enum'};
const clipFields:ReadonlySet<DisplayProperty>=new Set(['durationFrames','sourceInFrame','sourceOutFrame','startFrame','positionX','positionY','gainDb','fadeInFrames','fadeOutFrames','width','height']);
const shotFields:ReadonlySet<DisplayProperty>=new Set(['aspectRatio','durationSeconds','description']);
const generationFields:ReadonlySet<DisplayProperty>=new Set(['provider','model','mode','versionNumber','aspectRatio','durationSeconds','resolution','generateAudio','seed','width','height','count','quality','outputFormat','background']);
const providers:ReadonlySet<string>=new Set(['mock','runway','ark','veo','minimax','vidu','kling','wan','openai','openai-compatible','comfy-local']);
const ratios:ReadonlySet<string>=new Set(['9:16','16:9','1:1','3:4','4:3','21:9']);
const modes:ReadonlySet<string>=new Set(['text_to_video','image_to_video','first_last_frame','subject_reference','text_to_image','image_edit']);
function allowedField(operation:string,field:AgentTaskDisplayField,target?:AgentTaskDisplayTarget):boolean {
  if(!Object.hasOwn(units,field.property)||units[field.property]!==field.unit)return false;
  if(operation.startsWith('timeline.clip.'))return clipFields.has(field.property)&&(!target||target.kind==='timeline_clip');
  if(operation==='shot.create'||operation==='shot.update')return shotFields.has(field.property)&&(!target||target.kind==='shot');
  if(operation.startsWith('timeline.subtitle.'))return field.property==='subtitleText'&&(!target||target.kind==='timeline_subtitle');
  return (operation==='generation.submit'||operation==='image.generate')&&generationFields.has(field.property);
}
function enumText(property:DisplayProperty,value:string,locale:Locale):string|undefined {
  if(property==='aspectRatio')return ratios.has(value)?value:undefined;
  if(property==='provider')return providers.has(value)?value:undefined;
  if(property==='resolution')return /^(?:\d{2,5}p|\d{2,5}[x×]\d{2,5})$/u.test(value)?value:undefined;
  if(property==='model')return /^[A-Za-z\d][A-Za-z\d_.:-]{0,99}$/u.test(value)&&!/(?:secret|token|password|credential)|^(?:sk[-_]|ghp_)/iu.test(value)?safeText(value,100):undefined;
  if(property==='outputFormat')return ['png','jpeg','webp'].includes(value)?value.toUpperCase():undefined;
  let key:EnumKey|undefined;
  if(property==='mode'&&modes.has(value))key=`agent.display.enum.mode.${value}` as EnumKey;
  if(property==='quality'&&['low','medium','high','auto'].includes(value))key=`agent.display.enum.quality.${value}` as EnumKey;
  if(property==='background'&&['opaque','transparent','auto'].includes(value))key=`agent.display.enum.background.${value}` as EnumKey;
  return key&&Object.hasOwn(mioPanelMessages,key)?translate(locale,key):undefined;
}
function displayValue(field:AgentTaskDisplayField,value:AgentTaskDisplayValue,locale:Locale):string|undefined {
  if(value===null)return translate(locale,'agent.display.empty');
  if(typeof value==='boolean')return field.unit==='boolean'?translate(locale,value?'agent.display.on':'agent.display.off'):undefined;
  if(typeof value==='string'){
    if(field.property==='gainDb'&&value==='muted')return translate(locale,'agent.display.muted');
    if(field.property==='description'||field.property==='subtitleText')return projectText(value);
    return enumText(field.property,value,locale);
  }
  if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)return;
  if(field.unit==='db'){if(value < -200 || value > 20)return;}
  else if(!['positionX','positionY'].includes(field.property)&&(value<0||['frames','pixels','count'].includes(field.unit)&&!Number.isSafeInteger(value)))return;
  if(!['frames','seconds','db','pixels','count'].includes(field.unit))return;
  const formatted=new Intl.NumberFormat(locale,{maximumFractionDigits:3}).format(value);
  if(field.property==='versionNumber')return `V${formatted}`;
  return translate(locale,`agent.display.unit.${field.unit}` as 'agent.display.unit.frames'|'agent.display.unit.seconds'|'agent.display.unit.db'|'agent.display.unit.pixels'|'agent.display.unit.count',{value:formatted});
}

/** Format only the read-only allowlisted projection. Raw snapshots, model
 * summaries, tool arguments and undo material never enter this formatter. */
export function taskDisplayEntries(display:AgentTaskDisplay|undefined,locale:Locale):TaskDisplayEntry[] {
  if(!display)return [];
  const operation=knownOperation(display.operation);
  if(!operation)return [];
  const result:TaskDisplayEntry[]=[];
  for(const field of display.fields.slice(0,2000)){
    const target=field.targetIndex===undefined?undefined:display.targets[field.targetIndex];
    if(field.targetIndex!==undefined&&(!Number.isSafeInteger(field.targetIndex)||field.targetIndex<0||!target))continue;
    if(!allowedField(operation,field,target))continue;
    const before=field.before===undefined?undefined:displayValue(field,field.before,locale);
    const after=field.after===undefined?undefined:displayValue(field,field.after,locale);
    if(field.before!==undefined&&before===undefined||field.after!==undefined&&after===undefined||before===undefined&&after===undefined)continue;
    const fieldKey=`agent.display.field.${field.property}` as FieldKey;
    const prefix=target&&display.targets.length>1?`${targetTitle(target,locale)} · `:'';
    result.push({label:prefix+translate(locale,fieldKey),value:before===undefined?after!:after===undefined?before:`${before} → ${after}`});
  }
  return result;
}
export function taskDisplayLines(display:AgentTaskDisplay|undefined,locale:Locale):string[] {
  return taskDisplayEntries(display,locale).map(entry=>`${entry.label} ${entry.value}`);
}

/** Only this server snapshot's safe conflict values may be called current.
 * Planned values and unrelated browser caches are never substituted. */
export function taskCurrentEntries(display:AgentTaskDisplay|undefined,locale:Locale):TaskDisplayEntry[] {
  if(!display)return [];
  const fields:AgentTaskDisplayField[]=[];
  for(const field of display.fields.slice(0,2000)){
    if(field.current===undefined||field.targetIndex===undefined||!Number.isSafeInteger(field.targetIndex)||field.targetIndex<0)continue;
    const target=display.targets[field.targetIndex];if(!target||!allowedField(display.operation,field,target))continue;
    fields.push({targetIndex:field.targetIndex,property:field.property,unit:field.unit,after:field.current});
  }
  return taskDisplayEntries({...display,fields},locale);
}

export function taskStepTitle(step:AgentTaskStep,locale:Locale):string {
  if(step.kind==='model')return translate(locale,'agent.display.model');
  if(step.kind==='wait')return translate(locale,'agent.display.wait');
  // Tool explanations are untrusted prose. Invalid legacy content falls back to
  // a fixed operation label and the server's safe target projection.
  const text=safeText(step.text,40);
  if(text&&typeof step.text==='string'&&Array.from(step.text.trim()).length<=40&&!/[{}\[\]`]/u.test(text)&&!knownOperation(text)&&
    !/\bmioon_[a-z0-9_]+\b|\b(?:projectId|requestId|expectedRevision|_mio_step)\b/iu.test(text)&&
    !AGENT_TASK_STEP_STATUSES.some(status=>status===text)&&(!step.toolCall?.name||!text.includes(step.toolCall.name)))return text;
  const operation=step.display?.operation??step.toolCall?.name??'';
  const title=taskOperationTitle(operation,locale);
  return step.display?.targets.length?`${title} · ${taskDisplayTargets(step.display,locale)}`:title;
}

export function taskDurationSeconds(start:string,end:string):number|undefined {
  const first=Date.parse(start),last=Date.parse(end);
  return Number.isFinite(first)&&Number.isFinite(last)&&last>=first?Math.round((last-first)/100)/10:undefined;
}

/** A view-selection key, never visible copy or permission to reconcile work.
 * Domain-specific namespaces select existing image/frame recovery records. */
export function taskBackgroundLocation(step:AgentTaskStep):string|undefined {
  if(!step.toolCall)return;
  const operation=knownOperation(step.toolCall.name);
  const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const identity=(value:unknown):value is string=>typeof value==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value);
  if(operation==='task.wait'){
    const args=step.toolCall.arguments;
    if(!record(args)||!identity(args.id))return;
    return args.kind==='job'?args.id:args.kind==='export'?`render:${args.id}`:args.kind==='image'||args.kind==='frame'?`${args.kind}:${args.id}`:undefined;
  }
  if(operation==='image.generate'||operation==='frame.extract'){
    const kind=operation==='image.generate'?'image':'frame',targetKind=kind==='image'?'image_task':'frame_task';
    const ids=new Set((step.targets??[]).filter(target=>target.kind===targetKind&&identity(target.id)).map(target=>target.id));
    if(record(step.result)&&identity(step.result.id)&&identity(step.result.projectId)&&identity(kind==='image'?step.result.groupId:step.result.sourceAssetId))ids.add(step.result.id);
    if(ids.size===1)return `${kind}:${ids.values().next().value}`;
    return ids.size===0&&identity(step.id)?`${kind}-request:${step.id}`:undefined;
  }
  if(operation!=='generation.submit')return;
  const candidates=new Set((step.targets??[]).filter(target=>target.kind==='job'&&identity(target.id)).map(target=>target.id));
  const result=step.result;
  // A generation submission returns a Job DTO, whose own id is distinct from
  // the shot identity. An arbitrary result.id alone cannot identify a job.
  if(record(result)&&identity(result.id)&&identity(result.projectId)&&identity(result.shotId)&&result.id!==result.shotId)candidates.add(result.id);
  return candidates.size===1?candidates.values().next().value:undefined;
}

/** Key narrowing for callers deriving a label from a stable step status. */
export function taskStepStatusKey(status:AgentTaskStep['status']):MessageKey {
  const key=`agent.panel.stepStatus.${status}` as const;
  return Object.hasOwn(catalogs,key)?key:'agent.panel.stepStatus.unknown';
}
