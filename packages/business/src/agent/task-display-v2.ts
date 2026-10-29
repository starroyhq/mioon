import path from 'node:path';
import {AGENT_TASK_DISPLAY_TARGET_KINDS} from '@mioon/contracts/agent-tasks-v2';
import type {AgentTaskChange,AgentTaskDisplay,AgentTaskDisplayField,AgentTaskDisplayTarget,AgentTaskDisplayValue,AgentTaskStep,AgentTaskTarget} from '@mioon/contracts/agent-tasks-v2';
import type {WorkspaceStore} from '../db.ts';

type Value=Record<string,unknown>;
type Property=AgentTaskDisplayField['property'];
type Unit=AgentTaskDisplayField['unit'];
type Projected=Partial<Record<Property,{unit:Unit;value:AgentTaskDisplayValue}>>;
type TargetReader=(target:Pick<AgentTaskTarget,'kind'|'id'>)=>Value|undefined;
const object=(value:unknown):value is Value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const kinds:ReadonlySet<string>=new Set(AGENT_TASK_DISPLAY_TARGET_KINDS);
const ratios:ReadonlySet<string>=new Set(['9:16','16:9','1:1','3:4','4:3','21:9']);

function boundedCharacters(value:string,limit:number):string {
  let result='';for(const character of value){if(result.length+character.length>limit)break;result+=character;}return result;
}
/** Prose comes only from the authorized description/subtitle fields. Normalize
 * invisible controls without interpreting user text as paths or credentials. */
function safeText(value:unknown,limit=240):string|undefined {
  if(typeof value!=='string')return;
  const result=boundedCharacters(value,8192)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,' ')
    .replace(/\s+/gu,' ').trim();
  if(!result)return;
  return boundedCharacters(result,limit);
}
function name(value:Value|undefined,kind:string):string|undefined {
  if(!value)return;
  const candidate=kind==='timeline_subtitle'?value.text:kind==='shot'?value.title:value.name??value.label??value.title;
  if(typeof candidate!=='string')return;
  // Only media filenames are paths; slashes in project content stay literal.
  return safeText(kind==='asset'||kind==='timeline_clip'?path.win32.basename(path.posix.basename(candidate)):candidate,80);
}
function target(value:Pick<AgentTaskTarget,'kind'|'id'>,record?:Value):AgentTaskDisplayTarget|undefined {
  if(!uuid.test(value.id))return;
  const kind=kinds.has(value.kind)?value.kind as AgentTaskDisplayTarget['kind']:'unknown',label=name(record,kind);
  return {kind,id:value.id,...(label?{name:label}:{})};
}
function operation(value:string):string {
  if(value==='mioon_asset_import_selected')return 'asset.importSelected';
  if(value==='mioon_lut_import_selected')return 'lut.importSelected';
  const normalized=value.startsWith('mioon_')?value.slice(6).replaceAll('_','.'):value;
  return /^[a-z][A-Za-z\d]*(?:\.[a-z][A-Za-z\d]*)*$/u.test(normalized)&&normalized.length<=100?normalized:'other';
}
function fields(operationName:string,kind:string,value:Value|undefined):Projected {
  const result:Projected={};if(!value)return result;
  const put=(property:Property,unit:Unit,item:AgentTaskDisplayValue|undefined):void=>{if(item!==undefined)result[property]={unit,value:item};};
  const number=(property:Property,unit:Unit,item:unknown,integer=false,maximum=Number.MAX_SAFE_INTEGER):void=>{if(typeof item==='number'&&Number.isFinite(item)&&item>=0&&item<=maximum&&(!integer||Number.isSafeInteger(item)))put(property,unit,item);};
  if(operationName.startsWith('timeline.clip.')&&kind==='timeline_clip'){
    for(const field of ['durationFrames','sourceInFrame','startFrame','fadeInFrames','fadeOutFrames'] as const)number(field,'frames',value[field],true);
    if(Number.isSafeInteger(value.sourceInFrame)&&Number.isSafeInteger(value.durationFrames))number('sourceOutFrame','frames',Number(value.sourceInFrame)+Number(value.durationFrames),true);
    if(typeof value.gain==='number'&&Number.isFinite(value.gain)&&value.gain>=0&&value.gain<=2)put('gainDb','db',value.gain===0?'muted':20*Math.log10(value.gain));
    if(object(value.rect)){for(const [property,field] of [['positionX','x'],['positionY','y'],['width','width'],['height','height']] as const)number(property,'pixels',value.rect[field],true,1920);}
  }
  if(['shot.create','shot.update'].includes(operationName)&&kind==='shot'){
    if(typeof value.aspectRatio==='string'&&ratios.has(value.aspectRatio))put('aspectRatio','ratio',value.aspectRatio);
    number('durationSeconds','seconds',value.duration,false,20);
    put('description','text',safeText(value.prompt));
  }
  if(operationName.startsWith('timeline.subtitle.')&&kind==='timeline_subtitle')put('subtitleText','text',safeText(value.text));
  // A saved previs scene is summarised by how many figures, props and keyframes it holds.
  if(operationName==='previs.scene.set'&&kind==='node'&&object(value.scene)){
    for(const [property,field] of [['figureCount','figures'],['propCount','props'],['keyframeCount','keyframes']] as const){const items=value.scene[field];if(Array.isArray(items))number(property,'count',items.length,true,100);}
  }
  if(['generation.submit','image.generate'].includes(operationName)){
    let source=kind==='job'&&object(value.snapshot)?{...value.snapshot,providerId:value.providerId,model:value.model}:value;
    if(kind==='image_task'&&typeof value.input==='string'&&value.input.length<=24576){try{const input:unknown=JSON.parse(value.input);if(object(input))source=input;}catch{/* Corrupt retained input contributes no display values. */}}
    const providers=['mock','runway','ark','veo','minimax','vidu','kling','wan','openai','openai-compatible','comfy-local'];
    if(typeof source.providerId==='string'&&providers.includes(source.providerId))put('provider','enum',source.providerId);
    if(typeof source.model==='string'&&safeText(source.model,100)===source.model&&/^[A-Za-z\d][A-Za-z\d_.:-]{0,99}$/u.test(source.model)&&!/(?:secret|token|password|credential)/iu.test(source.model))put('model','text',source.model);
    if(typeof source.aspectRatio==='string'&&ratios.has(source.aspectRatio))put('aspectRatio','ratio',source.aspectRatio);
    number('durationSeconds','seconds',source.duration,false,120);
    if(operationName==='generation.submit'){
      if(typeof source.subjectVersionId==='string'||object(source.subjectReference))put('mode','enum','subject_reference');
      else if(Array.isArray(source.referenceAssetIds))put('mode','enum',source.referenceAssetIds.length?(typeof source.lastFrameAssetId==='string'?'first_last_frame':'image_to_video'):'text_to_video');
    }else if(source.purpose==='edit'||source.purpose==='generate')put('mode','enum',source.purpose==='edit'?'image_edit':'text_to_image');
    if(kind==='version'||kind==='image_version')number('versionNumber','count',source.number,true);
    const parameters=object(source.parameters)?source.parameters:{};
    if(typeof parameters.resolution==='string'&&/^(?:\d{2,5}p|\d{2,5}[x×]\d{2,5})$/u.test(parameters.resolution))put('resolution','enum',parameters.resolution);
    if(typeof parameters.generateAudio==='boolean')put('generateAudio','boolean',parameters.generateAudio);
    number('seed','count',parameters.seed,true);
    const options=object(source.options)?source.options:{};
    for(const field of ['width','height'] as const)number(field,'pixels',options[field],true,16384);
    number('count','count',options.n,true,100);
    if(typeof options.size==='string'&&/^\d{2,5}x\d{2,5}$/u.test(options.size))put('resolution','enum',options.size);
    for(const [field,allowed] of [['quality',['low','medium','high','auto']],['outputFormat',['png','jpeg','webp']],['background',['opaque','transparent','auto']]] as const)if(typeof options[field]==='string'&&(allowed as readonly string[]).includes(options[field] as string))put(field,'enum',options[field] as string);
  }
  return result;
}
function snapshotEntries(value:unknown):Map<string,Value> {
  const result=new Map<string,Value>();if(!Array.isArray(value))return result;
  for(const entry of value)if(object(entry)&&typeof entry.kind==='string'&&typeof entry.id==='string'&&object(entry.value))result.set(`${entry.kind}:${entry.id}`,entry.value);
  return result;
}
function appendFields(output:AgentTaskDisplay,index:number|undefined,before:Projected,after:Projected,preview=false):void {
  for(const property of new Set([...Object.keys(before),...Object.keys(after)]) as Set<Property>){
    const previous=before[property],next=after[property];
    if(!preview&&previous?.value===next?.value)continue;
    if(output.fields.length>=2000)return;
    output.fields.push({...(index===undefined?{}:{targetIndex:index}),property,unit:(next??previous)!.unit,...(preview?{}:{before:previous?.value??null}),after:next?.value??null});
  }
}
/** No model summary or undo material is consulted by this projection. */
export function projectAgentTaskChangeDisplay(change:AgentTaskChange):AgentTaskDisplay {
  const display:AgentTaskDisplay={operation:operation(change.operation),targets:[],targetCount:0,fields:[]},before=snapshotEntries(change.before),after=snapshotEntries(change.after);
  // Old workers labelled every lifecycle update as a submission. Correct only
  // its read-time label; the original audit row and reversal evidence stay intact.
  if(display.operation==='generation.submit'&&change.targets.some(item=>item.kind==='job'&&before.has(`job:${item.id}`)&&after.has(`job:${item.id}`))&&!change.targets.some(item=>item.kind==='job'&&!before.has(`job:${item.id}`)&&after.has(`job:${item.id}`))){
    display.operation=change.targets.some(item=>['asset','version'].includes(item.kind)&&!before.has(`${item.kind}:${item.id}`)&&after.has(`${item.kind}:${item.id}`))?'generation.publish':'generation.status';
  }
  for(const item of change.targets){
    const key=`${item.kind}:${item.id}`,previous=before.get(key),next=after.get(key),projected=target(item,next??previous);if(!projected)continue;
    display.targetCount++;if(display.targets.length>=200)continue;
    const index=display.targets.push(projected)-1;
    appendFields(display,index,fields(display.operation,item.kind,previous),fields(display.operation,item.kind,next));
  }
  return display;
}
/** Planned values come only from the exact retained tool arguments. They are
 * intentionally one-sided, not presented as an immutable historical baseline. */
export function projectAgentTaskStepDisplay(step:AgentTaskStep,readTarget?:TargetReader,includeCurrent=false):AgentTaskDisplay|undefined {
  if(!step.toolCall)return;
  const display:AgentTaskDisplay={operation:operation(step.toolCall.name),targets:[],targetCount:0,fields:[]},args=object(step.toolCall.arguments)?step.toolCall.arguments:{};
  const targets:Pick<AgentTaskTarget,'kind'|'id'>[]=[...(step.targets??[])];
  for(const [field,kind] of [['shotId','shot'],['clipId','timeline_clip'],['cueId','timeline_subtitle'],['trackId','timeline_track'],['assetId','asset'],['nodeId','node'],['jobId','job'],['exportId','export']] as const){const id=args[field];if(typeof id==='string'&&uuid.test(id)&&!targets.some(item=>item.kind===kind&&item.id===id))targets.push({kind,id});}
  // A creation has no saved target yet. Its parameter fields are operation-wide;
  // never manufacture an identity merely to provide an approval preview.
  const operationWide=['shot.create','timeline.clip.add','timeline.subtitle.add','image.generate'].includes(display.operation);
  if(operationWide||!targets.length){const kind=display.operation==='shot.create'?'shot':display.operation==='timeline.clip.add'?'timeline_clip':display.operation==='timeline.subtitle.add'?'timeline_subtitle':'unknown';appendFields(display,undefined,{},fields(display.operation,kind,args),true);}
  for(const item of targets){
    const current=readTarget?.(item),projected=target(item,current);if(!projected)continue;
    display.targetCount++;if(display.targets.length>=200)continue;
    const index=display.targets.push(projected)-1,input=object(args.patch)?args.patch:args;if(operationWide)continue;
    // A whole previs scene's counts say nothing about the planned edit, and next
    // to the current counts in a conflict they would read as a difference.
    let planned=display.operation==='previs.scene.set'?{}:fields(display.operation,item.kind,input);
    // A gain batch plans one gain for each clip it lists.
    if(display.operation==='timeline.clip.setGains'){const listed=Array.isArray(args.gains)?args.gains.find(entry=>object(entry)&&entry.clipId===item.id):undefined;planned=object(listed)?fields(display.operation,item.kind,{gain:listed.gain}):{};}
    if(display.operation==='generation.submit'&&item.kind==='shot')planned=fields(display.operation,'shot',{...(current?.revision===args.expectedRevision?{aspectRatio:current.aspectRatio,duration:current.duration,referenceAssetIds:current.referenceAssetIds,lastFrameAssetId:current.lastFrameAssetId}:{}),...args});
    appendFields(display,index,{},planned,true);
    // Conflict values are read from this snapshot's saved project state, never
    // from the browser cache or the model's parameters. Only already planned
    // attributes may gain a current value, through the same safe projection.
    if(includeCurrent){const saved=fields(display.operation,item.kind,current);for(const field of display.fields)if(field.targetIndex===index){const value=saved[field.property];if(value?.unit===field.unit)field.current=value.value;}}
  }
  return display;
}

/** Lazy project-local names for approval previews. This reads saved metadata
 * only; it cannot execute a tool, read a media file, or contact a provider. */
export function agentTaskDisplayTargetReader(store:WorkspaceStore,projectId:string):TargetReader {
  let timeline:Value|undefined,loaded=false;
  const tables:Readonly<Record<string,string>>={project:'projects',shot:'shots',node:'nodes',edge:'edges',asset:'assets',version:'versions',job:'jobs',export:'exports'};
  return target=>{
    if(!uuid.test(target.id))return;
    const table=Object.hasOwn(tables,target.kind)?tables[target.kind]:undefined;
    if(table){const value:unknown=store.get(table,target.id);return object(value)&&value.id===target.id&&(target.kind==='project'?value.id===projectId:value.projectId===projectId)?value:undefined;}
    if(!['timeline_clip','timeline_track','timeline_subtitle'].includes(target.kind))return;
    if(!loaded){loaded=true;const row=store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId);if(typeof row?.data==='string'){let value:unknown;try{value=JSON.parse(row.data);}catch{return;}if(object(value)&&value.projectId===projectId)timeline=value;}}
    const values=target.kind==='timeline_clip'?timeline?.clips:target.kind==='timeline_track'?timeline?.tracks:object(timeline?.subtitles)?timeline.subtitles.cues:undefined;
    return Array.isArray(values)?values.find((item):item is Value=>object(item)&&item.id===target.id):undefined;
  };
}
