import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {isTimelineRenderRecord,exportPreflightResponseSchema} from '@mioon/contracts';
import {agentTaskChecksSchema} from '@mioon/contracts/agent-tasks-v2';
import type {AgentTaskCheck,AgentTaskChecks,AgentTaskCheckValues,AgentTaskCheckGroup,AgentTaskCheckReason} from '@mioon/contracts/agent-tasks-v2';
import type {AgentTaskSnapshot,AgentTaskStep} from '@mioon/contracts/agent-tasks-v2';
import type {WorkspaceStore} from '../db.ts';
import {createOwnedMediaGraphReader} from '../inspection.ts';
import {validateManagedSource} from '../managed-media.ts';
import {storyboardOutputGeometry} from '../storyboard-output.ts';
import {createImageHistoryReaders} from '../images/history.ts';
import {createFrameHistoryReaders} from '../frames-history.ts';
import {createSceneHistoryReaders} from '../scene-history.ts';

type Value=Record<string,unknown>;
type Target=AgentTaskCheck['target'];
type Basis=AgentTaskCheck['basis'];
type TaskKind='job'|'export'|'image'|'frame'|'scene';
interface Origin {kind:TaskKind;id:string;step:AgentTaskStep;operation:string;requestId:string}
export type AgentTaskChecksPreflight=(input:{projectId:string;expectedRevision:number},options?:{signal?:AbortSignal})=>Promise<unknown>;
const object=(value:unknown):value is Value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const operations:Readonly<Record<string,{kind:TaskKind;group:AgentTaskCheckGroup;type:AgentTaskCheck['type']}>>={
 mioon_export_create:{kind:'export',group:'export_render',type:'export_status'},mioon_timeline_render:{kind:'export',group:'export_render',type:'export_status'},
 mioon_generation_submit:{kind:'job',group:'generation',type:'generation_status'},mioon_image_generate:{kind:'image',group:'generation',type:'generation_status'},
 mioon_frame_extract:{kind:'frame',group:'decomposition_frames',type:'frame_status'},mioon_scene_detect:{kind:'scene',group:'decomposition_frames',type:'decomposition_status'},
 mioon_scene_shots_create:{kind:'scene',group:'decomposition_frames',type:'decomposition_status'},
};
const targetKinds={job:'job',export:'export',image:'image_task',frame:'frame_task',scene:'scene_task'} as const;
const activeStates=new Set(['queued','submitting','running','downloading','dispatching','receiving','persisting','cancelling']);
const failedStates=new Set(['failed','cancelled','cancelled_before_start','cancelled_before_dispatch','interrupted','interrupted_before_dispatch','local_result_error']);
const unknownStates=new Set(['submission_unknown','outcome_unknown','output_review_required']);
function knownObservationFailure(error:unknown):boolean {
 const code=object(error)?error.code:undefined;
 return typeof code==='string'&&(code==='NOT_FOUND'||/^(?:INSPECTION_|MANAGED_|IMAGE_|FRAME_|SCENE_|TIMELINE_|INVALID_TIMELINE_|PREFLIGHT_|EXPORT_|MEDIA_|SUBTITLE_|RESTORE_|RESTORED_|WORKSPACE_READ_ONLY)/u.test(code));
}
function safeName(value:unknown,filename=false):string|undefined {
 if(typeof value!=='string')return;
 const text=(filename?path.win32.basename(path.posix.basename(value)):value).slice(0,8192)
  .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/\s+/gu,' ').trim();
 let result='';for(const character of text){if(result.length+character.length>80)break;result+=character;}return result||undefined;
}
function decode(value:unknown):Value|undefined {if(typeof value!=='string')return;try{const parsed:unknown=JSON.parse(value);return object(parsed)?parsed:undefined;}catch{return;}}
function row(store:WorkspaceStore,table:'jobs'|'exports'|'assets'|'shots'|'versions'|'timelines',projectId:string,id:string):Value|undefined {
 const record=store.db.prepare(`SELECT data FROM ${table} WHERE ${table==='timelines'?'projectId':'id'}=? AND projectId=? AND length(CAST(data AS BLOB))<=4194304`).get(id,projectId);
 const value=decode(record?.data);return value&&value.projectId===projectId&&(table==='timelines'||value.id===id)?value:undefined;
}
function stateResult(state:unknown):Pick<AgentTaskCheck,'status'|'reason'> {
 if(state==='succeeded')return {status:'passed'};
 if(state==='undone')return {status:'not_applicable',reason:{code:'NOT_CHANGED'}};
 if(typeof state!=='string')return {status:'failed',reason:{code:'RECORD_UNAVAILABLE'}};
 if(activeStates.has(state))return {status:'pending',reason:{code:'TASK_PENDING'}};
 if(unknownStates.has(state))return {status:'failed',reason:{code:'RESULT_UNKNOWN'}};
 if(failedStates.has(state))return {status:'failed',reason:{code:state.includes('cancelled')?'TASK_CANCELLED':state.includes('interrupted')?'TASK_INTERRUPTED':'TASK_FAILED'}};
 return {status:'failed',reason:{code:'RECORD_UNAVAILABLE'}};
}
function geometry(value:unknown):AgentTaskCheckValues {
 if(!object(value))return {};
 return Object.fromEntries((['width','height','fps','durationFrames'] as const).filter(key=>integer(value[key])&&Number(value[key])>0).map(key=>[key,value[key]]));
}
function stateValues(state:unknown):AgentTaskCheckValues {return typeof state==='string'&&/^[a-z][a-z0-9_]{0,63}$/u.test(state)?{status:state}:{};}
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,child:unknown)=>object(child)?Object.fromEntries(Object.entries(child).sort(([a],[b])=>a.localeCompare(b))):child);

/** Read-time, local observations only. No result is retained or used as mutation,
 * provider-dispatch, approval or recovery authority. Full media preflight uses
 * the host's existing bounded read lifecycle, never an independently owned worker. */
export async function readAgentTaskChecks(store:WorkspaceStore,snapshot:AgentTaskSnapshot,{preflight,includePreflight=false,signal}:{preflight?:AgentTaskChecksPreflight;includePreflight?:boolean;signal?:AbortSignal}={}):Promise<AgentTaskChecks> {
 signal?.throwIfAborted();
 const {run}=snapshot,projectId=run.projectId,steps=new Map(snapshot.steps.map(step=>[step.id,step]));
 const groups:AgentTaskChecks['groups']=[{id:'export_render',items:[]},{id:'generation',items:[]},{id:'timeline',items:[]},{id:'decomposition_frames',items:[]}];
 const revision=(kind:Target['kind'],id:string,fallback=0):number=>{
  if(kind==='run')return run.revision;
  const saved=store.db.prepare('SELECT revision FROM agent_task_target_revisions_v2 WHERE projectId=? AND kind=? AND targetId=?').get(projectId,kind,id)?.revision;
  return integer(saved)?saved:integer(fallback)?fallback:0;
 };
 const basis=(target:Target,fallback=0):Basis=>[{kind:target.kind,id:target.id,revision:revision(target.kind,target.id,fallback)}];
 const related=(proof:Basis,targets:Array<{kind:Target['kind'];id:unknown}>):Basis=>{
  const result=new Map(proof.map(item=>[`${item.kind}:${item.id}`,item]));
  for(const target of targets)if(uuid(target.id)&&!result.has(`${target.kind}:${target.id}`))result.set(`${target.kind}:${target.id}`,{kind:target.kind,id:target.id,revision:revision(target.kind,target.id)});
  return [...result.values()];
 };
 const add=(group:AgentTaskCheckGroup,type:AgentTaskCheck['type'],target:Target,proof:Basis,result:Pick<AgentTaskCheck,'status'|'reason'>,extra:Partial<Pick<AgentTaskCheck,'expected'|'current'|'progress'>>={}):void=>{
  groups.find(value=>value.id===group)!.items.push({id:`${type}:${target.kind}:${target.id}`,type,source:'host',target,basis:proof,...result,...extra});
 };
 const reason=(status:AgentTaskCheck['status'],code:AgentTaskCheckReason,params?:AgentTaskCheckValues):Pick<AgentTaskCheck,'status'|'reason'>=>({status,reason:{code,...(params?{params}:{})}});
 const origins:Origin[]=[],boundSteps=new Set<string>();
 const hasOrigins=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_job_origins_v2'").get();
 if(hasOrigins)for(const source of store.db.prepare('SELECT kind,jobId,stepId,operation,requestId FROM agent_task_job_origins_v2 WHERE projectId=? AND runId=? ORDER BY stepId,kind,jobId').all(projectId,run.id)){
  const step=typeof source.stepId==='string'?steps.get(source.stepId):undefined,description=step?.toolCall?operations[step.toolCall.name]:undefined;
  if(!step||!description||description.kind!==source.kind||typeof source.operation!=='string'||`mioon_${source.operation.replaceAll('.','_')}`!==step.toolCall?.name||source.requestId!==step.id||!uuid(source.jobId))continue;
  origins.push({kind:description.kind,id:source.jobId,step,operation:source.operation,requestId:step.id});boundSteps.add(step.id);
 }
 // Older runs can lack a background binding. A retained successful ACK is
 // accepted only when the current same-project task still binds its request to
 // that exact tool step; arbitrary IDs in a model tool result are never enough.
 for(const step of snapshot.steps){
  const description=step.toolCall?operations[step.toolCall.name]:undefined;if(!description||boundSteps.has(step.id)||step.kind!=='tool')continue;
  const result=object(step.result)?step.result:undefined;
  if(step.status==='completed'&&uuid(result?.id))origins.push({kind:description.kind,id:result.id,step,operation:step.toolCall!.name.slice(6).replaceAll('_','.'),requestId:step.id});
  else{
   const target:Target={kind:'step',id:step.id};
   const state=step.status==='completed'?'failed':step.status==='dispatch_started'||step.status==='unknown'?'outcome_unknown':['intent','awaiting_approval'].includes(step.status)?'queued':step.status;
   add(description.group,description.type,target,basis(target),stateResult(state),{current:stateValues(step.status)});
  }
 }
 const graph=createOwnedMediaGraphReader(store.db,projectId);
 const asset=(id:unknown,exportId?:string):Value|undefined=>{
  if(!uuid(id))return;
  try{
   const value=graph.asset(id);if(value.projectId!==projectId||value.id!==id||!integer(value.sizeBytes)||typeof value.sha256!=='string')return;
   if(exportId&&(value.provenance!=='export'||value.mimeType!=='video/mp4'||typeof value.relativePath!=='string'||!new RegExp(`^media/export-${exportId}-[a-f\\d-]{36}\\.mp4$`,'iu').test(value.relativePath)))return;
   const source=validateManagedSource(store.root,value);return source.info.size===value.sizeBytes?value:undefined;
  }catch(error){if(!knownObservationFailure(error))throw error;return;}
 };
 for(const origin of origins){
  const kind=targetKinds[origin.kind];let value:Value|undefined;
  try{
   if(origin.kind==='job'||origin.kind==='export')value=row(store,origin.kind==='job'?'jobs':'exports',projectId,origin.id);
   else if(origin.kind==='image')value=createImageHistoryReaders(store).taskDto(projectId,origin.id) as unknown as Value;
   else if(origin.kind==='frame')value=createFrameHistoryReaders(store).taskDto(projectId,origin.id) as unknown as Value;
   else value=createSceneHistoryReaders(store).task(projectId,origin.id).dto as unknown as Value;
  }catch(error){if(!knownObservationFailure(error))throw error;/* Invalid local lineage is a failed observation. */}
  if(value?.requestId!==origin.requestId)value=undefined;
  const shotName=origin.kind==='job'&&uuid(value?.shotId)?row(store,'shots',projectId,value.shotId)?.title:undefined;
  let label=safeName(origin.kind==='job'?shotName:origin.kind==='image'?value?.name:undefined);
  if((origin.kind==='frame'||origin.kind==='scene')&&uuid(value?.sourceAssetId))try{label=safeName(graph.asset(value.sourceAssetId).name,true);}catch(error){if(!knownObservationFailure(error))throw error;}
  // Exports have no public name field. An unexpected local `name` (including
  // a worker path) must not become display content.
  const target:Target={kind,id:origin.id,...(label?{name:label}:{})},proof=basis(target,integer(value?.revision)?value.revision:0);
  const state=value?.status??value?.state,description=operations[origin.step.toolCall!.name]!,result=stateResult(state),current=stateValues(state);
  const progress=typeof value?.progress==='number'&&Number.isFinite(value.progress)&&value.progress>=0&&value.progress<=100?value.progress:undefined;
  add(description.group,description.type,target,proof,result,{current,...(result.status==='pending'&&progress!==undefined?{progress}:{})});
  if(origin.kind==='export'){
   const published=asset(value?.assetId,origin.id),artifactResult=result.status==='pending'?reason('pending','TASK_PENDING'):result.status!=='passed'?reason('not_applicable','ARTIFACT_UNAVAILABLE'):published?{status:'passed' as const}:reason('failed','ARTIFACT_UNAVAILABLE');
   const artifactProof=related(proof,published?[{kind:'asset',id:published.id}]:[]);
   add('export_render','export_artifact',target,artifactProof,artifactResult,{current:{available:!!published,...(published?{assetId:String(published.id)}:{})}});
   let expected:AgentTaskCheckValues={},matches=!!value;
   try{
    if(value?.mode==='timeline'){
     const args=object(origin.step.toolCall?.arguments)?origin.step.toolCall.arguments:{};
     const input={...args,projectId,requestId:origin.requestId},receiptRow=store.db.prepare('SELECT requestHash,response FROM timeline_requests WHERE requestId=? AND length(CAST(response AS BLOB))<=4194304').get(origin.requestId),receipt=decode(receiptRow?.response);
     const requestHash=createHash('sha256').update(canonical({operation:'timeline.render',input})).digest('hex');
     matches=isTimelineRenderRecord(value,input)&&!!receipt&&receiptRow?.requestHash===requestHash&&isTimelineRenderRecord(receipt,input)&&receipt.status==='queued'&&receipt.assetId===null&&receipt.url===null&&receipt.error===null&&receipt.updatedAt===receipt.createdAt&&
      ['id','projectId','requestId','mode','purpose','timelineRevision','createdAt'].every(field=>receipt[field]===value![field])&&isDeepStrictEqual(receipt.snapshot,value.snapshot);
     const frozen=object(value.snapshot)?value.snapshot:undefined,delivery=object(frozen?.delivery)?frozen.delivery:undefined;
     expected=geometry(object(delivery?.effective)?delivery.effective:frozen?.timeline);
    }else if(value){
     expected=geometry(storyboardOutputGeometry(value));
     const receipt=store.db.prepare("SELECT resourceId FROM idempotency WHERE scope='export' AND requestId=?").get(origin.requestId);
     matches=receipt?.resourceId===origin.id&&Array.isArray(value.snapshot)&&Array.isArray(value.orderedVersionIds)&&value.snapshot.length===value.orderedVersionIds.length&&value.snapshot.every((item,index)=>object(item)&&item.versionId===(value!.orderedVersionIds as unknown[])[index]);
     const ack=object(origin.step.result)?origin.step.result:undefined;
     if(ack)matches=matches&&isDeepStrictEqual(ack.outputGeometry,value.outputGeometry)&&isDeepStrictEqual(ack.orderedVersionIds,value.orderedVersionIds);
     if(matches)for(const entry of value.snapshot as unknown[]){if(!object(entry)){matches=false;break;}const version=graph.version(entry.versionId,entry.shotId,entry.assetId);if(version.sha256!==entry.sha256){matches=false;break;}}
    }
   }catch(error){if(!knownObservationFailure(error))throw error;matches=false;}
   const observed=geometry(published);if(published&&(['width','height'] as const).some(field=>expected[field]!==undefined&&expected[field]!==observed[field]))matches=false;
   add('export_render','export_parameters',target,artifactProof,!matches?reason('failed','PARAMETERS_MISMATCH'):result.status==='pending'?reason('pending','TASK_PENDING'):result.status==='passed'&&!published?reason('failed','ARTIFACT_UNAVAILABLE'):result.status!=='passed'?reason('not_applicable','TASK_FAILED'):{status:'passed'},{expected,current:observed});
  }
  if(origin.kind==='job'||origin.kind==='image'){
   let version:Value|undefined,output:Value|undefined;
   try{
    if(uuid(value?.versionId)){
     const read=origin.kind==='job'?graph.version(value.versionId,value.shotId):graph.imageVersion(value.versionId);
     if(object(read)&&read.projectId===projectId&&(origin.kind==='job'?read.jobId===origin.id:read.taskId===origin.id)){version=read;output=asset(read.assetId);}
    }
   }catch(error){if(!knownObservationFailure(error))throw error;/* A succeeded state alone cannot establish publication. */}
   const published=!!version&&!!output;
   const publicationProof=related(proof,published?[{kind:origin.kind==='job'?'version':'image_version',id:version!.id},{kind:'asset',id:output!.id}]:[]);
   add('generation','generation_publication',target,publicationProof,result.status==='pending'?reason('pending','TASK_PENDING'):result.status!=='passed'?reason('not_applicable','VERSION_UNPUBLISHED'):published?{status:'passed'}:reason('failed','VERSION_UNPUBLISHED'),{current:{available:published,...(published?{versionId:String(version!.id),assetId:String(output!.id)}:{})}});
   const mock=value?.providerId==='mock',cost=origin.step.cost;
   const notDispatched=cost!=='submitted'&&cost!=='unknown'&&cost!=='charged'&&failedStates.has(String(state));
   add('generation','generation_cost',target,proof,mock||notDispatched?{status:'not_applicable'}:cost==='unknown'||unknownStates.has(String(state))?reason('failed','COST_UNKNOWN'):cost==='charged'?{status:'passed'}:reason('pending',cost==='submitted'?'COST_SUBMITTED':'COST_PENDING'),{current:{cost:mock||notDispatched?'not_applicable':cost??'pending'}});
  }
 }
 const timelineChanged=snapshot.changes.some(change=>change.targets.some(target=>target.kind.startsWith('timeline')));
 const timeline=row(store,'timelines',projectId,projectId),timelineTarget:Target={kind:'timeline',id:uuid(timeline?.id)?timeline.id:projectId},timelineProof=basis(timelineTarget,integer(timeline?.revision)?timeline.revision:0);
 // Timeline aggregate revisions are stored under projectId, while the UI
 // locates the saved timeline by its own id. Keep the actual aggregate revision.
 if(timelineProof[0]&&integer(timeline?.revision))timelineProof[0].revision=timeline.revision;
 if(timelineChanged){
  const clips=Array.isArray(timeline?.clips)?timeline.clips:[],tracks=Array.isArray(timeline?.tracks)?timeline.tracks:[];let missing=timeline?0:1;
  const sourceProof=related(timelineProof,clips.flatMap(clip=>object(clip)?[{kind:'asset' as const,id:clip.assetId},{kind:'version' as const,id:clip.versionId},{kind:'job' as const,id:clip.jobId},{kind:'shot' as const,id:clip.shotId}]:[]));
  for(const clip of clips){if(!object(clip)||!tracks.some(track=>object(track)&&track.id===clip.trackId)){missing++;continue;}try{graph.clipSource(clip);}catch(error){if(!knownObservationFailure(error))throw error;missing++;}}
  add('timeline','timeline_references',timelineTarget,sourceProof,missing?reason('failed','REFERENCES_UNAVAILABLE',{missingCount:missing}):{status:'passed'},{current:{referenceCount:clips.length,missingCount:missing}});
  // Media hashing and ffprobe can take seconds. Ordinary status reads only
  // inspect local references; a supplied callback does not opt into that work.
  if(!includePreflight)add('timeline','timeline_preflight',timelineTarget,timelineProof,reason('pending','PREFLIGHT_NOT_REQUESTED'));
  else if(!preflight||!integer(timeline?.revision)||timeline.revision<1)add('timeline','timeline_preflight',timelineTarget,timelineProof,reason('pending','PREFLIGHT_UNAVAILABLE'));
  else{
   const input={projectId,expectedRevision:timeline.revision};let report:ReturnType<typeof exportPreflightResponseSchema.safeParse>|undefined;
   try{report=exportPreflightResponseSchema.safeParse(await preflight(input,{signal}));}catch(error){signal?.throwIfAborted();if(!knownObservationFailure(error))throw error;/* Known local media refusal leaves the read available. */}
   signal?.throwIfAborted();
   const latest=row(store,'timelines',projectId,projectId);
   if(!report?.success||report.data.projectId!==projectId||report.data.expectedRevision!==input.expectedRevision)add('timeline','timeline_preflight',timelineTarget,timelineProof,reason('pending','PREFLIGHT_UNAVAILABLE'));
   else if(report.data.status==='stale'||!isDeepStrictEqual(latest,timeline)||report.data.timelineId!==timeline.id||report.data.timelineRevision!==input.expectedRevision)add('timeline','timeline_preflight',timelineTarget,timelineProof,reason('pending','PREFLIGHT_STALE'));
   else{
    const value=report.data,blockingCount=value.issues.filter(issue=>issue.severity==='error').length,params={blockingCount,issueCodes:value.issues.map(issue=>issue.code)};
    add('timeline','timeline_preflight',timelineTarget,sourceProof,value.status==='ready'?{status:'passed'}:reason(value.status==='blocked'?'failed':'pending',value.status==='blocked'?'PREFLIGHT_BLOCKED':'PREFLIGHT_INCOMPLETE',params),{current:{...geometry(value.summary),...params}});
   }
  }
 }
 for(const group of groups)if(!group.items.length){
  const type=group.id==='export_render'?'export_status':group.id==='generation'?'generation_status':group.id==='timeline'?'timeline_references':'decomposition_status',target:Target={kind:'run',id:run.id};
  add(group.id,type,target,basis(target),reason('not_applicable',group.id==='timeline'?'NOT_CHANGED':'NO_APPLICABLE_TASK'));
 }
 signal?.throwIfAborted();return agentTaskChecksSchema.parse({projectId,runId:run.id,runRevision:run.revision,groups});
}
