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
export interface TaskDisplayOptions {fps?:number;lookup?:TaskDisplayLookup}

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
function displayValue(field:AgentTaskDisplayField,value:AgentTaskDisplayValue,locale:Locale,options:TaskDisplayOptions):string|undefined {
  if(value===null)return translate(locale,'agent.display.empty');
  if(typeof value==='boolean')return field.unit==='boolean'?translate(locale,value?'agent.display.on':'agent.display.off'):undefined;
  if(typeof value==='string'){
    if(field.property==='gainDb'&&value==='muted')return translate(locale,'agent.display.muted');
    if(field.property==='description'||field.property==='subtitleText')return projectText(value)??translate(locale,'agent.display.empty');
    return enumText(field.property,value,locale);
  }
  if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)return;
  if(field.unit==='db'){if(value < -200 || value > 20)return;}
  else if(!['positionX','positionY'].includes(field.property)&&(value<0||['frames','pixels','count'].includes(field.unit)&&!Number.isSafeInteger(value)))return;
  if(!['frames','seconds','db','pixels','count'].includes(field.unit))return;
  const fps=options.fps,converted=field.unit==='frames'&&typeof fps==='number'&&Number.isFinite(fps)&&fps>0?value/fps:undefined;
  const seconds=converted!==undefined&&Number.isFinite(converted)?converted:undefined;
  const precise=seconds!==undefined||field.unit==='seconds'||field.unit==='db';
  const number=precise&&Math.abs(seconds??value)<0.05?0:seconds??value;
  const formatted=new Intl.NumberFormat(locale,precise?{minimumFractionDigits:1,maximumFractionDigits:1}:{maximumFractionDigits:3}).format(Object.is(number,-0)?0:number);
  if(field.property==='versionNumber')return `V${formatted}`;
  return translate(locale,`agent.display.unit.${seconds===undefined?field.unit:'seconds'}` as 'agent.display.unit.frames'|'agent.display.unit.seconds'|'agent.display.unit.db'|'agent.display.unit.pixels'|'agent.display.unit.count',{value:formatted});
}

interface FormattedField {field:AgentTaskDisplayField;entry:TaskDisplayEntry}
function emptyValue(field:AgentTaskDisplayField,value:AgentTaskDisplayValue|undefined):boolean {
  return value===null||typeof value==='string'&&(field.property==='description'||field.property==='subtitleText')&&projectText(value)===undefined;
}
function formattedFields(display:AgentTaskDisplay,locale:Locale,options:TaskDisplayOptions):FormattedField[] {
  const operation=knownOperation(display.operation);if(!operation)return [];
  const allowed=display.fields.slice(0,2000).filter(field=>{
    const target=field.targetIndex===undefined?undefined:display.targets[field.targetIndex];
    return (field.targetIndex===undefined||Number.isSafeInteger(field.targetIndex)&&field.targetIndex>=0&&!!target)&&allowedField(operation,field,target);
  });
  const rangeChangeTargets=new Set(allowed.filter(field=>['sourceInFrame','durationFrames'].includes(field.property)
    &&[field.before,field.after].some(value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)
    &&[field.before,field.after].every(value=>value===undefined||value===null||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)).map(field=>field.targetIndex));
  const result:FormattedField[]=[];
  for(const field of allowed){
    // A6 calculates out-point from the saved in-point and duration. An
    // unchanged input is absent from changed fields; either changed input is
    // sufficient evidence not to repeat its derived out-point in this row.
    if(field.property==='sourceOutFrame'&&rangeChangeTargets.has(field.targetIndex))continue;
    const before=field.before===undefined?undefined:displayValue(field,field.before,locale,options);
    const after=field.after===undefined?undefined:displayValue(field,field.after,locale,options);
    if(field.before!==undefined&&before===undefined||field.after!==undefined&&after===undefined||before===undefined&&after===undefined)continue;
    const target=field.targetIndex===undefined?undefined:display.targets[field.targetIndex],fieldKey=`agent.display.field.${field.property}` as FieldKey;
    const prefix=target&&display.targets.length>1?`${targetTitle(target,locale,options.lookup)} · `:'';
    result.push({field,entry:{label:prefix+translate(locale,fieldKey),value:before===undefined||emptyValue(field,field.before)?after??before!:after===undefined?before:`${before} → ${after}`}});
  }
  return result;
}

/** Format only the read-only allowlisted projection. Raw snapshots, model
 * summaries, tool arguments and undo material never enter this formatter. */
export function taskDisplayEntries(display:AgentTaskDisplay|undefined,locale:Locale,options:TaskDisplayOptions={}):TaskDisplayEntry[] {
  return display?formattedFields(display,locale,options).map(item=>item.entry):[];
}
export function taskDisplayLines(display:AgentTaskDisplay|undefined,locale:Locale,options:TaskDisplayOptions={}):string[] {
  return taskDisplayEntries(display,locale,options).map(entry=>`${entry.label} ${entry.value}`);
}
/** Compact Change copy is separate from the full details list. Creation is an
 * action with a target, never an invented empty-to-value modification. */
export function taskChangeSummary(display:AgentTaskDisplay|undefined,locale:Locale,options:TaskDisplayOptions={}):string {
  if(!display)return '';
  const operation=knownOperation(display.operation);if(!operation)return '';
  let fields=formattedFields(display,locale,options),creation='';
  const kind=operation==='timeline.subtitle.add'?'subtitle':operation==='timeline.clip.add'?'clip':operation==='shot.create'?'shot':undefined;
  if(kind){
    const text=kind==='subtitle'?fields.find(item=>item.field.property==='subtitleText'&&typeof item.field.after==='string'):undefined;
    const target=display.targets.find(item=>item.kind===(kind==='subtitle'?'timeline_subtitle':kind==='clip'?'timeline_clip':'shot'));
    const name=text&&typeof text.field.after==='string'?projectText(text.field.after):target?safeName(options.lookup?.(target.kind,target.id))??safeName(target.name):undefined;
    creation=name?translate(locale,`agent.display.add.${kind}`,{text:name}):taskOperationTitle(operation,locale);
    if(text)fields=fields.filter(item=>item!==text);
  }
  const shown=fields.slice(0,2).map(({field,entry})=>field.before!==undefined&&emptyValue(field,field.before)&&!kind?translate(locale,'agent.display.setField',{field:entry.label,value:entry.value}):`${entry.label} ${entry.value}`);
  const omitted=fields.length-shown.length;
  if(omitted)shown.push(translate(locale,'agent.display.moreFields',{count:omitted}));
  return [creation,...shown].filter(Boolean).join(' · ')||taskOperationTitle(operation,locale);
}

/** Only this server snapshot's safe conflict values may be called current.
 * Planned values and unrelated browser caches are never substituted. */
export function taskCurrentEntries(display:AgentTaskDisplay|undefined,locale:Locale,options:TaskDisplayOptions={}):TaskDisplayEntry[] {
  if(!display)return [];
  const fields:AgentTaskDisplayField[]=[];
  for(const field of display.fields.slice(0,2000)){
    if(field.current===undefined||field.targetIndex===undefined||!Number.isSafeInteger(field.targetIndex)||field.targetIndex<0)continue;
    const target=display.targets[field.targetIndex];if(!target||!allowedField(display.operation,field,target))continue;
    fields.push({targetIndex:field.targetIndex,property:field.property,unit:field.unit,after:field.current});
  }
  return taskDisplayEntries({...display,fields},locale,options);
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
