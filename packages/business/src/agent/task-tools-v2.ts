import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {setTimeout as waitDelay} from 'node:timers/promises';
import {AppError,schemas,descriptions,operationEffect,parse} from '@mioon/contracts';
import {ensurePrivateDirectory,readPrivateFile,writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {isTimelineMixLoudnessResponse} from '@mioon/contracts/timeline-mix-loudness';
import {isTimelineLoudnessApplicableReport,timelineLoudnessCandidateDigest} from '@mioon/contracts/timeline-loudness-apply';
import type {OperationName} from '@mioon/contracts';
import type {WorkspaceStore} from '../db.ts';
import {registerWorkspaceTransactionObserver,registerWorkspaceTransactionFence} from '../db.ts';
import type {OrdinaryServices} from '../services.ts';
import type {AgentTaskTier,AgentTaskTarget,AgentTaskJson,AgentTaskChange} from '../../../contracts/src/agent-tasks-v2.ts';
import {agentTaskTargetSchema} from '../../../contracts/src/agent-tasks-v2.ts';
import {AGENT_TASK_TOOL_SCHEMAS} from './task-tool-schemas-v2.ts';
import {agentTaskParameterFeedback} from './task-tool-errors-v2.ts';
import {taskEffectOrigin,withTaskEffectOrigin,setAgentTaskJobOriginRunner,setAgentTaskJobDispatchRecorder,setAgentTaskJobTargetGate,assertAgentTaskBindingEffect,isAgentTaskEffectBlocked} from './task-effects-v2.ts';
import {createAgentTaskJournal} from './task-journal-v2.ts';
import {createTimelineRecoveryBoundary} from '../timeline-recovery.ts';
import type {TimelineRecord,TimelineClipRecord,TimelineTrackRecord,TimelineSubtitleCueRecord} from '../timeline-inputs.ts';
import type {AgentTaskEffectOrigin,TaskChangeInput} from './task-effects-v2.ts';

type Value=Record<string,unknown>;
const object=(value:unknown):value is Value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const json=(value:unknown):AgentTaskJson=>JSON.parse(JSON.stringify(value??null)) as AgentTaskJson;
function fail(code:string,message:string):never{throw new AppError(code,message,409);}

// Every public RPC is reviewed here. New operations fail discovery until this
// list is deliberately extended; advisory operationEffects never grant access.
const readOperations=[
 'video.connection.list','export.activity.get','task.disposition.list',
 'lut.list','lut.inspect','lut.look.inspect','timeline.colour.source.inspect','timeline.colour.image.inspect','timeline.colour.jpeg.inspect',
 'timeline.format.get','frame.request.get','frame.task.get','frame.task.list',
 // Scene detection only analyses an owned video and saves a cut list; it changes
 // no project content, so it shares the read-only tier with its readers.
 'scene.detect','scene.request.get','scene.task.get','scene.task.list','scene.result.get','image.profile.list','image.request.get','image.task.get','image.task.list','image.group.list','image.group.get','image.version.list','image.task.remote.get',
 'project.inspect','asset.inspect','shot.inspect','timeline.inspect','subject.list','subject.version.list','subject.binding.list','asset.range.get','asset.disposition.list','asset.annotation.list','asset.waveform.get',
 'timeline.export.preflight','timeline.export.samplePeak','timeline.export.loudness','timeline.loudness.prepare','timeline.clip.loudness','timeline.audioPreview.plan','timeline.audioPreview.continuousPlan','timeline.export.capabilities',
 'asset.list','provider.list','job.get','job.list','version.list','export.get','timeline.history.get',
] as const;
const reversibleOperations=[
 'project.rename','timeline.format.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove','subject.binding.set','asset.range.set','asset.disposition.set','asset.annotation.set',
 'shot.create','shot.update','shot.reorder','node.create','node.update','edge.create','edge.delete','reference.attach','reference.detach','version.select',
 'timeline.loudness.apply','timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.rippleRemove','timeline.clip.split','timeline.seed',
 'timeline.clip.refreshSources','timeline.shots.append','timeline.clip.splitAtScenes',
] as const;
// A storyboard's images and shots are created by its background task after the
// call returns, so a run's undo cannot compensate them; the user undoes the batch.
const irreversibleOperations=[
 'frame.extract','scene.shots.create','subject.create','subject.version.add','asset.waveform.request','export.create','timeline.render',
] as const;
const paidOperations=['generation.submit','image.generate'] as const;
const forbiddenOperations=[
 'export.cancel','export.output.get','task.disposition.markFailed','task.disposition.archiveCompleted',
 'workspace.settings.get','workspace.settings.set','workspace.backup.status','workspace.backup.list','workspace.backup.create','workspace.backup.restore.stage',
 'project.delete','project.summary.list','agent.authorization.list','agent.authorization.grant','agent.authorization.revoke','lut.import','workspace.backup.inspect','workspace.restore.inspect','project.create','project.list','project.get','asset.import',
 'job.retry','job.cancel','job.reconcile','frame.task.cancelQueued','frame.task.recoverResult','scene.task.cancel','scene.cuts.save','scene.shots.undo','image.task.cancelQueued','image.task.recoverResult','image.task.observeRemote','image.review.prepare','image.review.get','image.review.list','timeline.get','timeline.undo','timeline.redo',
 // Angle and lighting batches are user-driven for now; Mio can still read the
 // resulting subject versions. Tools for them belong to the harness tool groups.
 'subject.variants.create','subject.variants.retry','subject.variants.undo','subject.variants.get','subject.variants.list',
] as const;
const tierByOperation=new Map<string,AgentTaskTier>([
 ...readOperations.map(operation=>[operation,'read_only'] as const),...reversibleOperations.map(operation=>[operation,'local_reversible'] as const),
 ...irreversibleOperations.map(operation=>[operation,'local_irreversible'] as const),...paidOperations.map(operation=>[operation,'paid'] as const),
]);
export const AGENT_TASK_OPERATION_ADMISSION=Object.freeze(Object.fromEntries([
 ...[...tierByOperation].map(([operation,tier])=>[operation,{allowed:true,tier}]),...forbiddenOperations.map(operation=>[operation,{allowed:false,reason:'management, cross-project discovery, or raw file authority'}]),
]));
export function assertAgentTaskOperationCoverage():void{
 const expected=Object.keys(schemas).sort(),actual=Object.keys(AGENT_TASK_OPERATION_ADMISSION).sort();
 if(canonical(expected)!==canonical(actual))throw Error('Agent task operation admission is incomplete');
}
assertAgentTaskOperationCoverage();
const hostFields=new Set(['projectId','requestId','approval','approved','allowPaid','permission','dataBase64','filePath','relativePath','apiKey','credential']);
function rejectHostFields(value:unknown):void{
 if(Array.isArray(value)){for(const child of value)rejectHostFields(child);return;}
 if(!object(value))return;
 for(const [key,child] of Object.entries(value)){if(hostFields.has(key))fail('AGENT_TASK_INVALID_TOOL','工具不能指定宿主身份、文件或授权');rejectHostFields(child);}
}
function hydrateInput(operation:string,input:Value,projectId:string,requestId:string):Value{
 const schema=schemas[operation as OperationName];
 const source=operation==='image.review.prepare'&&object(input.input)?{...input,input:hydrateInput('image.generate',input.input,projectId,requestId)}:input;
 for(const candidate of [{...source,projectId,requestId},{...source,projectId},{...source,requestId},source]){
  const result=schema.safeParse(candidate);if(result.success&&object(result.data))return result.data;
 }
 return parse(operation as OperationName,source) as Value;
}
function taskToolOperation(operation:string):string{
 if(operation==='mioon_node_inspect')return 'node.inspect';
 if(operation==='mioon_edge_inspect')return 'edge.inspect';
 if(operation==='mioon_task_wait')return 'task.wait';
 if(operation==='mioon_asset_import_selected')return 'asset.importSelected';
 if(operation==='mioon_lut_import_selected')return 'lut.importSelected';
 return operation.startsWith('mioon_')?Object.keys(AGENT_TASK_OPERATION_ADMISSION).find(name=>`mioon_${name.replaceAll('.','_')}`===operation)??operation:operation;
}
/** Only explicit identity paths are read from already admitted arguments. This
 * pure fallback also supports old saved steps without reference metadata; it
 * neither validates a new tool request nor grants mutation authority. */
export function agentTaskExplicitTargets(operation:string,input:unknown,projectId:string):Array<Pick<AgentTaskTarget,'kind'|'id'>>{
 if(!object(input))return [];
 operation=taskToolOperation(operation);
 const references=new Map<string,Pick<AgentTaskTarget,'kind'|'id'>>();
 const add=(kind:string,value:unknown):void=>{if(typeof value==='string')references.set(`${kind}:${value}`,{kind,id:value});};
 for(const [field,kind] of [['shotId','shot'],['targetShotId','shot'],['nodeId','node'],['sourceNodeId','node'],['edgeId','edge'],['jobId','job'],['assetId','asset'],['sourceAssetId','asset'],['versionId','version'],['exportId','export'],['clipId','timeline_clip'],['trackId','timeline_track'],['cueId','timeline_subtitle'],['subjectId','subject'],['subjectVersionId','subject_version'],['bindingId','subject_binding'],['taskId',operation.startsWith('frame.')?'frame_task':operation.startsWith('scene.')?'scene_task':'image_task'],['groupId','image_group'],['lutId','lut']] as const)add(kind,input[field]);
 // The journal identifies this project's timeline by projectId; the wire's
 // timelineId names the same aggregate without granting another project scope.
 if(typeof input.timelineId==='string')add('timeline',projectId);
 if(operation==='edge.create')for(const field of ['source','target'] as const){add('node',input[field]);add('shot',input[field]);}
 for(const field of ['shotIds','assetIds'] as const)if(Array.isArray(input[field]))for(const value of input[field])add(field==='shotIds'?'shot':'asset',value);
 if(operation==='task.wait')add(input.kind==='image'?'image_task':input.kind==='frame'?'frame_task':input.kind==='scene'?'scene_task':String(input.kind),input.id);
 if(operation==='task.disposition.list'&&Array.isArray(input.targets))for(const target of input.targets)if(object(target))add(target.kind==='generation'?'job':target.kind==='render'?'export':'edit_task',target.taskId);
 const shot=operation==='shot.create'?input:operation==='shot.update'&&object(input.patch)?input.patch:undefined;
 if(shot){if(Array.isArray(shot.referenceAssetIds))for(const id of shot.referenceAssetIds)add('asset',id);add('asset',shot.lastFrameAssetId);}
 const clip=operation==='timeline.clip.add'?input:operation==='timeline.clip.update'&&object(input.patch)?input.patch:undefined;
 if(clip){add('timeline_track',clip.trackId);if(object(clip.colour)&&object(clip.colour.look))add('lut',clip.colour.look.resourceId);}
 if(operation==='image.generate'&&object(input.inputImage))add('asset',input.inputImage.assetId);
 if(operation==='generation.submit'&&object(input.videoInput)&&Array.isArray(input.videoInput.images))for(const image of input.videoInput.images)if(object(image))add('asset',image.assetId);
 const assetKind=operation.startsWith('asset.range.')?'asset_range':operation.startsWith('asset.annotation.')?'asset_annotation':operation.startsWith('asset.disposition.')?'asset_disposition':undefined;
 if(assetKind){add(assetKind,input.assetId);if(Array.isArray(input.assetIds))for(const id of input.assetIds)add(assetKind,id);}
 return [...references.values()];
}
export interface AgentTaskToolDefinition {name:string;operation:string;description:string;parameters:unknown;risk:AgentTaskTier;receipt:string;recovery:string;undo:string}
export interface PreparedAgentTaskTool {projectId:string;operation:string;input:Value;risk:AgentTaskTier;targets:AgentTaskTarget[];referencedTargets?:AgentTaskTarget[];before:Snapshot}
export interface AgentTaskToolContext {runId:string;stepId:string;requestId:string;signal?:AbortSignal;beforeEffect:()=>void;recordInside:(result:AgentTaskJson,changes?:TaskChangeInput[])=>void;appendChangesInside?:(changes:TaskChangeInput[])=>void}
export interface AgentTaskUndoContext {requestId?:string;beforeEffect:()=>void;beforeCompensation?:()=>void;recordInside:(change:AgentTaskChange)=>void;retainInside:(change:AgentTaskChange,reason:string)=>void;expectedTargets?:AgentTaskTarget[]}
export interface AgentTaskLocalRecovery {outcome:'not_applied';reason:'read_only'|'atomic_receipt_absent'}
interface SnapshotEntry {kind:string;id:string;table:string;value:Value;revision:number}
type Snapshot=Record<string,SnapshotEntry>;
const rowTables:Readonly<Record<string,string>>={shots:'shot',nodes:'node',edges:'edge',jobs:'job',assets:'asset',versions:'version',exports:'export'};
const extraTables:Readonly<Record<string,{kind:string;id:string}>>={asset_ranges:{kind:'asset_range',id:'assetId'},asset_dispositions:{kind:'asset_disposition',id:'assetId'},asset_annotations:{kind:'asset_annotation',id:'assetId'},subjects:{kind:'subject',id:'id'},subject_versions:{kind:'subject_version',id:'id'},subject_bindings:{kind:'subject_binding',id:'id'},image_tasks:{kind:'image_task',id:'id'},image_groups:{kind:'image_group',id:'id'},image_versions:{kind:'image_version',id:'id'},frame_tasks:{kind:'frame_task',id:'id'}};
const key=(kind:string,id:string):string=>`${kind}:${id}`;
function readRevision(store:WorkspaceStore,projectId:string,kind:string,id:string):number{
 return Number(store.db.prepare('SELECT revision FROM agent_task_target_revisions_v2 WHERE projectId=? AND kind=? AND targetId=?').get(projectId,kind,id)?.revision??0);
}
function snapshot(store:WorkspaceStore,projectId:string):Snapshot{
 const result:Snapshot={};
 const insert=(kind:string,id:string,table:string,value:Value):void=>{result[key(kind,id)]={kind,id,table,value:structuredClone(value),revision:readRevision(store,projectId,kind,id)};};
 const project=store.get('projects',projectId);if(object(project))insert('project',projectId,'projects',project);
 for(const [table,kind] of Object.entries(rowTables))for(const row of store.db.prepare(`SELECT id,data FROM ${table} WHERE projectId=?`).all(projectId)){
  const value:unknown=JSON.parse(String(row.data));if(!object(value)||value.id!==row.id||value.projectId!==projectId)fail('AGENT_TASK_INVALID_TARGET','项目记录无法验证');insert(kind,String(row.id),table,value);
 }
 for(const [table,descriptor] of Object.entries(extraTables)){
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
  for(const row of store.db.prepare(`SELECT * FROM ${table} WHERE projectId=?`).all(projectId))insert(descriptor.kind,String(row[descriptor.id]),table,{...row});
 }
 const timeline=store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId);
 if(timeline){const value:unknown=JSON.parse(String(timeline.data));if(!object(value)||value.projectId!==projectId)fail('AGENT_TASK_INVALID_TARGET','时间线记录无法验证');
  for(const [field,kind] of [['clips','timeline_clip'],['tracks','timeline_track'],['subtitles','timeline_subtitle']] as const){const children=field==='subtitles'&&object(value.subtitles)?value.subtitles.cues:value[field];if(Array.isArray(children))for(const child of children)if(object(child)&&typeof child.id==='string')insert(kind,child.id,field,child);}
  insert('timeline',projectId,'timeline_format',Object.fromEntries(['fps','width','height'].map(field=>[field,value[field]])));
 }
 return result;
}
function comparable(value:Value):Value{return Object.fromEntries(Object.entries(value).filter(([field])=>!['revision','updatedAt','createdAt'].includes(field)));}
type UndoDisposition=NonNullable<AgentTaskChange['undoDisposition']>;
const reversibleMetadata=new Set(['asset_range','asset_disposition','asset_annotation','subject_binding']);
function defaultMetadataCompensation(kind:string,value:Value):Value|null{
 if(kind==='asset_range')return null;
 if(kind==='asset_disposition')return {...value,disposition:'neutral'};
 if(kind==='asset_annotation')return {...value,tags:'[]',note:''};
 return {...value,subjectVersionId:null};
}
function undoEntries(change:AgentTaskChange):Array<{before?:SnapshotEntry;after?:SnapshotEntry}>|null{
 if(!Array.isArray(change.undo)||!change.undo.length)return null;
 const entries:Array<{before?:SnapshotEntry;after?:SnapshotEntry}>=[];
 for(const value of change.undo){
  if(!object(value))return null;
  for(const side of [value.before,value.after])if(side!==undefined&&(!object(side)||typeof side.kind!=='string'||typeof side.id!=='string'||typeof side.table!=='string'||!object(side.value)))return null;
  const entry=value as unknown as {before?:SnapshotEntry;after?:SnapshotEntry},identity=entry.after??entry.before;
  if(!identity||entry.before&&entry.after&&(entry.before.id!==entry.after.id||entry.before.kind!==entry.after.kind||entry.before.table!==entry.after.table)||!change.targets.some(target=>target.kind===identity.kind&&target.id===identity.id))return null;
  entries.push(entry);
 }
 return entries.length===change.targets.length&&new Set(entries.map(entry=>key((entry.after??entry.before)!.kind,(entry.after??entry.before)!.id))).size===entries.length?entries:null;
}
function undoDisposition(change:AgentTaskChange,current:Snapshot,expected:AgentTaskTarget[],revision:(target:AgentTaskTarget)=>number,claimed:(target:AgentTaskTarget)=>boolean):UndoDisposition{
 if(change.status!=='applied'||!change.reversible)return 'retain';
 const entries=undoEntries(change);if(!entries||expected.some(claimed))return 'blocked';
 const unchanged=entries.every(entry=>{const identity=(entry.after??entry.before)!,found=current[key(identity.kind,identity.id)];return canonical(found?comparable(found.value):null)===canonical(entry.after?comparable(entry.after.value):null);});
 if(expected.every(target=>revision(target)===target.revision))return unchanged?'undo':'blocked';
 // A revision mismatch alone also describes ABA or an incomplete compound
 // change. Only one exact target with a different saved value proves that it
 // can be kept intact while independent earlier changes are compensated.
 const target=expected.length===1?expected[0]:undefined;
 return target&&entries.length===1&&target.revisionAfter!==undefined&&revision(target)>target.revision&&!unchanged?'retain':'blocked';
}
function undoDependencies(store:WorkspaceStore,change:AgentTaskChange,current:Snapshot,entries:Array<{before?:SnapshotEntry;after?:SnapshotEntry}>):UndoDisposition{
 const {db}=store,removedEdges=new Set(entries.filter(entry=>!entry.before&&entry.after?.kind==='edge').map(entry=>entry.after!.id));
 const timelineEntries=entries.filter(entry=>(entry.after??entry.before)!.kind.startsWith('timeline'));
 if(timelineEntries.length){
  // Validate the same merged aggregate as actual compensation. Independent
  // revisions alone cannot detect new references, clip overlap or source bounds.
  const next={...current};for(const entry of timelineEntries){const identity=(entry.after??entry.before)!,id=key(identity.kind,identity.id);if(entry.before)next[id]=entry.before;else delete next[id];}
  try{
   const boundary=createTimelineRecoveryBoundary(db,{projectId:change.projectId}),base=boundary.read();if(!base)return 'blocked';
   const values=(kind:string):Value[]=>Object.values(next).filter(item=>item.kind===kind).map(item=>structuredClone(item.value));
   const timeline={...base,...next[key('timeline',change.projectId)]?.value,tracks:values('timeline_track') as unknown as TimelineTrackRecord[],clips:values('timeline_clip') as unknown as TimelineClipRecord[],...(base.subtitles?{subtitles:{...base.subtitles,cues:values('timeline_subtitle') as unknown as TimelineSubtitleCueRecord[]}}:{})} satisfies TimelineRecord;
   boundary.validate(timeline);
  }catch(error){if(error instanceof AppError)return 'blocked';throw error;}
 }
 for(const entry of entries){
  if(entry.before||!entry.after||entry.after.kind.startsWith('timeline'))continue;
  const identity=entry.after;
  if(extraTables[identity.table]?.kind===identity.kind&&reversibleMetadata.has(identity.kind)){if(!current[key(identity.kind,identity.id)])return 'blocked';continue;}
  if(!['shots','nodes','edges'].includes(identity.table))return 'blocked';
  if(identity.table==='edges')continue;
  if(Object.values(current).some(item=>item.kind==='edge'&&!removedEdges.has(item.id)&&(item.value.source===identity.id||item.value.target===identity.id)))return 'blocked';
  if(identity.kind!=='shot')continue;
  // Cleared bindings remain durable tombstones with the same shot foreign key.
  if(Object.values(current).some(item=>item.kind==='subject_binding'&&item.value.shotId===identity.id))return 'blocked';
  const jobs=Object.values(current).filter(item=>item.kind==='job'&&item.value.shotId===identity.id);if(!jobs.length)continue;
  const target=change.targets.length===1?change.targets[0]:undefined,shotId=identity.id;
  if(change.operation!=='shot.create'||entries.length!==1||target?.kind!=='shot'||target.id!==shotId)return 'blocked';
    const ownedJob=db.prepare(`SELECT 1 FROM agent_task_job_origins_v2 b JOIN jobs j ON j.id=b.jobId AND j.projectId=b.projectId
     JOIN agent_task_steps_v2 s ON s.id=b.stepId AND s.runId=b.runId AND s.projectId=b.projectId
     WHERE b.kind='job' AND b.jobId=? AND b.projectId=? AND b.runId=? AND b.operation='generation.submit'
     AND b.requestId=json_extract(j.data,'$.requestId') AND s.status='completed' AND json_extract(s.data,'$.kind')='tool'
     AND json_extract(s.data,'$.toolCall.name')='mioon_generation_submit' AND json_extract(s.data,'$.toolCall.arguments.shotId')=?
     AND EXISTS(SELECT 1 FROM agent_task_changes_v2 c,json_each(c.data,'$.targets') t WHERE c.runId=b.runId AND c.stepId=b.stepId AND c.projectId=b.projectId
      AND json_extract(c.data,'$.operation')='generation.submit' AND json_extract(c.data,'$.reversible')=0 AND json_extract(c.data,'$.status')='applied'
      AND json_extract(t.value,'$.kind')='job' AND json_extract(t.value,'$.id')=j.id)`);
  return jobs.every(job=>ownedJob.get(job.id,change.projectId,change.runId,shotId))?'retain':'blocked';
 }
 return 'undo';
}
/** Read-only whole-run preview. The actual compensation validates again inside
 * its transaction; this projection never grants permission to undo. */
export function projectAgentTaskUndo(store:WorkspaceStore,projectId:string,changes:AgentTaskChange[]):Map<string,Pick<AgentTaskChange,'modifiedAfter'|'undoDisposition'>>{
 if(!changes.length)return new Map();
 const current=snapshot(store,projectId),revisions=new Map<string,number>(),chain=new Map<string,AgentTaskTarget>(),result=new Map<string,Pick<AgentTaskChange,'modifiedAfter'|'undoDisposition'>>();let blocked=false;
 const revision=(target:AgentTaskTarget):number=>revisions.get(key(target.kind,target.id))??readRevision(store,projectId,target.kind,target.id);
 const claimed=(target:AgentTaskTarget):boolean=>!!store.db.prepare('SELECT 1 FROM agent_task_edit_claims_v2 WHERE projectId=? AND kind=? AND targetId=?').get(projectId,target.kind,target.id);
 for(const change of [...changes].reverse()){
  const modifiedAfter=change.targets.some(target=>target.revisionAfter!==undefined&&readRevision(store,projectId,target.kind,target.id)>target.revisionAfter);
  if(change.status==='reverted'){for(const target of change.revertedTargets??[])chain.set(key(target.kind,target.id),target);result.set(change.id,{modifiedAfter,undoDisposition:'retain'});continue;}
  if(change.status!=='applied'||!change.reversible){result.set(change.id,{modifiedAfter,undoDisposition:'retain'});continue;}
  const expected=change.targets.map(target=>{const next=chain.get(key(target.kind,target.id));return next&&next.revisionBefore===(target.revisionAfter??target.revision)?next:target;});
  let disposition=blocked?'blocked':undoDisposition(change,current,expected,revision,claimed);if(disposition==='undo')disposition=undoDependencies(store,change,current,undoEntries(change)!);result.set(change.id,{modifiedAfter,undoDisposition:disposition});
  if(disposition==='blocked'){blocked=true;continue;}
  if(disposition!=='undo')continue;
  for(const entry of undoEntries(change)!){const identity=(entry.after??entry.before)!,id=key(identity.kind,identity.id);if(entry.before)current[id]=structuredClone(entry.before);else if(reversibleMetadata.has(identity.kind)){const value=defaultMetadataCompensation(identity.kind,identity.value);if(value)current[id]={...identity,value};else delete current[id];}else delete current[id];}
  for(const target of change.targets){const value={...target,revision:revision(target)+1};revisions.set(key(target.kind,target.id),value.revision);chain.set(key(target.kind,target.id),value);}
 }
 return result;
}
/** Recheck supersession within the same transaction as its journal record. */
export function agentTaskChangeWasModified(store:WorkspaceStore,change:AgentTaskChange,expected:AgentTaskTarget[]):boolean{
 return undoDisposition(change,snapshot(store,change.projectId),expected,target=>readRevision(store,change.projectId,target.kind,target.id),target=>!!store.db.prepare('SELECT 1 FROM agent_task_edit_claims_v2 WHERE projectId=? AND kind=? AND targetId=?').get(change.projectId,target.kind,target.id))==='retain';
}
function differences(before:Snapshot,after:Snapshot):Array<{before?:SnapshotEntry;after?:SnapshotEntry}>{
 const result:Array<{before?:SnapshotEntry;after?:SnapshotEntry}>=[];
 for(const id of new Set([...Object.keys(before),...Object.keys(after)]))if(canonical(before[id]?comparable(before[id]!.value):null)!==canonical(after[id]?comparable(after[id]!.value):null))result.push({before:before[id],after:after[id]});
 return result;
}
function changes(prepared:PreparedAgentTaskTool,after:Snapshot,{backgroundGeneration=false}:{backgroundGeneration?:boolean}={}):TaskChangeInput[]{
 const diff=differences(prepared.before,after).filter(entry=>{
  if(!backgroundGeneration||entry.before?.kind!=='job'||entry.after?.kind!=='job'||entry.before.id!==entry.after.id||entry.before.value.requestId!==prepared.input.requestId||entry.after.value.requestId!==prepared.input.requestId)return true;
  // Progress and scheduling remain durable in the job itself. They are not
  // separate business effects and must not consume the assistant audit quota.
  const lifecycleValue=(value:Value):Value=>Object.fromEntries(Object.entries(comparable(value)).filter(([field])=>!['progress','nextPollAt'].includes(field)));
  return canonical(lifecycleValue(entry.before.value))!==canonical(lifecycleValue(entry.after.value));
 });if(!diff.length)return [];
 const build=(entries:typeof diff,operation:string,reversible:boolean):TaskChangeInput=>({projectId:prepared.projectId,operation,
  targets:entries.map(({before,after:next})=>({kind:(next??before)!.kind,id:(next??before)!.id,revision:next?.revision??before!.revision+1,revisionBefore:before?.revision??0,revisionAfter:next?.revision??before!.revision+1})),
  before:json(entries.map(change=>change.before??null)),after:json(entries.map(change=>change.after??null)),undo:json(entries),reversible,summary:descriptions[operation]??operation});
 const autoSelections=prepared.operation==='generation.submit'?diff.filter(entry=>entry.before?.kind==='shot'&&entry.after?.kind==='shot'&&entry.before.value.selectedVersionId!==entry.after.value.selectedVersionId):[];
 const remaining=diff.filter(entry=>!autoSelections.includes(entry)),jobUpdates=backgroundGeneration?remaining.filter(entry=>(entry.after??entry.before)?.kind==='job'):[];
 const outputs=remaining.filter(entry=>!jobUpdates.includes(entry));
 return [...(jobUpdates.length?[build(jobUpdates,'generation.status',false)]:[]),...(outputs.length?[build(outputs,backgroundGeneration?'generation.publish':prepared.operation,prepared.risk==='local_reversible')]:[]),...autoSelections.map(entry=>build([entry],'version.select',true))];
}

/** Paths and raw bytes are never sent to the model. Local task results retain
 * enough identifiers for a subsequent observation, without provider secrets. */
function projectResult(value:unknown,depth=0):AgentTaskJson{
 if(depth>12)return '[truncated]';
 if(Array.isArray(value))return value.slice(0,200).map(item=>projectResult(item,depth+1));
 if(object(value)){const result:{[key:string]:AgentTaskJson}={};for(const [field,child] of Object.entries(value)){if(['relativePath','path','fileLocation','dataBase64','apiKey','credential','credentialRef','secret','configuration','canonicalInput','canonicalIntent','snapshot'].includes(field))continue;result[field]=projectResult(child,depth+1);}return result;}
 if(typeof value==='string')return value.length>16000?value.slice(0,16000)+'[truncated]':value;
 return value===null||typeof value==='boolean'||typeof value==='number'?value:null;
}
function transactionResult(operation:string,projectId:string,value:unknown):AgentTaskJson{
 // These domains return an internal replay envelope from their acceptance
 // transaction. The committed task receipt must expose the same task reference
 // as the public service; other transaction results keep their exact shape.
 if(object(value)&&typeof value.replayed==='boolean'){
  const task=operation==='image.generate'?value.response:operation==='frame.extract'?value.value:undefined;
  if(object(task)&&typeof task.id==='string'&&task.projectId===projectId)return projectResult(task);
 }
 return projectResult(value);
}

export function createAgentTaskTools({store,services}:{store:WorkspaceStore;services:OrdinaryServices}){
 const {db}=store;
 const preparedOrigins=new WeakMap<AgentTaskEffectOrigin,PreparedAgentTaskTool>();
 const backgroundOrigins=new WeakSet<AgentTaskEffectOrigin>();
 const transactionSnapshots=new WeakMap<AgentTaskEffectOrigin,Snapshot>();
 const transactionCounts=new WeakMap<AgentTaskEffectOrigin,number>();
 const removeFence=registerWorkspaceTransactionFence(db,()=>{const origin=taskEffectOrigin();if(!origin)return;if(!origin.recorded)origin.beforeEffect();transactionSnapshots.set(origin,snapshot(store,origin.projectId));transactionCounts.set(origin,Number(db.prepare('SELECT total_changes() AS n').get()!.n));});
 const removeObserver=registerWorkspaceTransactionObserver(db,result=>{
  const origin=taskEffectOrigin(),active=origin?preparedOrigins.get(origin):undefined,before=origin?transactionSnapshots.get(origin):undefined;if(!origin||!active||!before||origin.projectId!==active.projectId)return;
  const after=snapshot(store,active.projectId),backgroundGeneration=backgroundOrigins.has(origin)&&active.operation==='generation.submit',captured=changes({...active,before},after,{backgroundGeneration});
  // Cost uncertainty is audit evidence even when only a scheduling field was
  // updated. Keep it independent of the filtered business-change projection.
  const uncertain=captured.some(change=>Array.isArray(change.after)&&change.after.some(entry=>object(entry)&&object(entry.value)&&['submission_unknown','outcome_unknown'].includes(String(entry.value.status??entry.value.state))))||backgroundGeneration&&Object.values(after).some(entry=>entry.kind==='job'&&entry.value.requestId===origin.requestId&&entry.value.status==='submission_unknown');
  if(uncertain){const step=journal.step(origin.stepId);if(step.cost==='submitted')journal.updateStep(origin.runId,origin.stepId,{cost:'unknown'});}
  if(!captured.length){
   // Same-value local mutations can still commit a revision and immutable RPC
   // receipt. Their task receipt must share that transaction as well. Paid
   // review preparation and file-import intent markers are deliberately excluded.
   if(!origin.recorded&&active.risk==='local_reversible'&&Number(db.prepare('SELECT total_changes() AS n').get()!.n)>(transactionCounts.get(origin)??Number.MAX_SAFE_INTEGER)){origin.recordInside(transactionResult(active.operation,active.projectId,result),[]);origin.recorded=true;}
   return;
  }
  if(origin.recorded){if(!origin.appendChangesInside)throw Error('Late task changes require a durable origin recorder');origin.appendChangesInside(captured);}
  else{origin.recordInside(transactionResult(active.operation,active.projectId,result),captured);origin.recorded=true;}
 });
 const journal=createAgentTaskJournal(store);
 const removeDispatchRecorder=setAgentTaskJobDispatchRecorder(db,binding=>{const step=journal.step(binding.stepId);if(step.cost!=='submitted')journal.updateStep(binding.runId,binding.stepId,{cost:'submitted'});});
 const removeTargetGate=setAgentTaskJobTargetGate(db,(binding,target)=>{
  let expected:AgentTaskTarget|undefined;
  try{
   assertAgentTaskBindingEffect(db,binding);
   expected=journal.step(binding.stepId).targets?.find(item=>item.kind===target.kind&&item.id===target.id);if(!expected)fail('AGENT_TASK_TARGET_CHANGED','后台结果没有此目标的修改权限');journal.assertTargets(binding.projectId,[expected]);return true;
  }catch(error){
   const failure=object(error)&&typeof error.code==='string'?error.code:'',targetFailure=failure==='AGENT_TASK_TARGET_CHANGED'||failure==='AGENT_TASK_TARGET_CLAIMED';
   const knownGate=isAgentTaskEffectBlocked(error)&&['AGENT_TASK_TARGET_SKIPPED','AGENT_TASK_STOPPED','AGENT_TASK_PAUSED','AGENT_TASK_CONSENT_REQUIRED','AGENT_TASK_SETTINGS_CHANGED','AGENT_TASK_APPROVAL_REQUIRED','AGENT_TASK_EFFECT_BLOCKED','AGENT_TASK_ABORTED','ABORT_ERR','AGENT_TASK_CLOSED','AGENT_TASK_READ_ONLY'].includes(failure);
   if(!targetFailure&&!knownGate)throw error;
   const run=journal.run(binding.runId),step=journal.step(binding.stepId),data=object(step.data)?step.data:{},sameOrigin=step.runId===run.id&&run.projectId===binding.projectId;
   const targets=(values:unknown):AgentTaskTarget[]=>Array.isArray(values)?values.flatMap(value=>{const parsed=agentTaskTargetSchema.safeParse(value);return parsed.success?[parsed.data]:[];}):[];
   const retainedReferences=data.referencedTargets===undefined&&step.toolCall?agentTaskExplicitTargets(step.toolCall.name,step.toolCall.arguments,run.projectId):targets(data.referencedTargets);
   const references=[target,...(step.targets??[]),...targets(data.dispatchApprovalTargets),...retainedReferences];
   const skipped=knownGate&&failure==='AGENT_TASK_TARGET_SKIPPED'&&sameOrigin&&references.some(reference=>run.skippedTargets?.some(item=>item.target.kind===reference.kind&&item.target.id===reference.id));
   const denied=knownGate&&failure==='AGENT_TASK_STOPPED'&&sameOrigin&&data.backgroundDenied===true,handled=skipped||denied;
   // Gate denial is never permission to select a target. Only actual target
   // conflicts create a conflict pause; handled selections retain their choice.
   const actual=targetFailure?(data.backgroundInvalidated===true?targets(data.conflictTargets):journal.conflictingTargets(binding.projectId,expected?[expected]:step.targets??[])):[];
   if(actual.length)journal.updateStep(binding.runId,step.id,{data:{...data,backgroundInvalidated:true,conflictTargets:json(actual)}});
   journal.appendEvent(binding.runId,handled?'background_selection_skipped':actual.length?'conflict':'background_selection_blocked',{stepId:binding.stepId,targetKind:target.kind,targetId:target.id,automaticSelectionSkipped:true,reason:handled?(skipped?'target_skipped':'background_denied'):failure});
   if(!handled&&run.status==='running')journal.transition(run.id,journal.run(run.id).revision,'paused',actual.length?(failure==='AGENT_TASK_TARGET_CLAIMED'?'editing':'conflict'):failure);return false;
  }
 });
 const removeJobOrigins=setAgentTaskJobOriginRunner(db,(binding,callback)=>{
  const origin:AgentTaskEffectOrigin={...binding,beforeEffect:()=>{},recorded:true,recordInside:()=>{throw Error('A worker cannot replace its acceptance receipt');},appendChangesInside:captured=>{journal.appendChangesInside(binding.runId,binding.stepId,captured);}};
  backgroundOrigins.add(origin);
  preparedOrigins.set(origin,{projectId:binding.projectId,operation:binding.operation,input:{requestId:binding.requestId},risk:'local_irreversible',targets:[],before:snapshot(store,binding.projectId)});
  return withTaskEffectOrigin(origin,callback);
 });
 const owned=(table:string,id:unknown,projectId:string):Value=>{
  if(typeof id!=='string')return fail('AGENT_TASK_INVALID_TARGET','工具目标无效');
  const row=db.prepare(`SELECT projectId FROM ${table} WHERE id=?`).get(id);if(!row||row.projectId!==projectId)return fail('AGENT_TASK_INVALID_TARGET','目标不属于当前项目');
  const record=store.get(table,id);if(!object(record))return fail('AGENT_TASK_INVALID_TARGET','工具目标无效');return record;
 };
 async function parameterFeedback({projectId,operation,input,beforeTargetRead}:{projectId:string;operation:string;input:unknown;beforeTargetRead?:(target:{kind:string;id:string})=>void}){
  operation=taskToolOperation(operation);if(operation!=='generation.submit'||!object(input))return null;
  rejectHostFields(input);
  for(const target of agentTaskExplicitTargets(operation,input,projectId))beforeTargetRead?.(target);
  owned('shots',input.shotId,projectId);
  let capabilities:unknown;
  if(typeof input.connectionId==='string'&&typeof input.modelEntryId==='string'){
   const connections:unknown=await services.call('video.connection.list',{});
   const connection=Array.isArray(connections)?connections.find(item=>object(item)&&item.connectionId===input.connectionId&&item.configurationRevision===input.configurationRevision&&item.providerId===input.providerId):undefined;
   if(object(connection)&&Array.isArray(connection.models)){
    const model=connection.models.find(item=>object(item)&&object(item.entry)&&item.entry.id===input.modelEntryId&&(input.model===undefined||item.entry.modelId===input.model));
    if(object(model))capabilities=model.capabilities;
   }
  }
  return agentTaskParameterFeedback({operation,input,capabilities});
 }
 function prepare({projectId,operation,input,beforeTargetRead}:{projectId:string;operation:string;input:unknown;beforeTargetRead?:(target:{kind:string;id:string})=>void}):PreparedAgentTaskTool{
  operation=taskToolOperation(operation);
  let risk=['task.wait','node.inspect','edge.inspect'].includes(operation)?'read_only':['asset.importSelected','lut.importSelected'].includes(operation)?'local_irreversible':tierByOperation.get(operation);
  if(!risk||!object(input))fail('AGENT_TASK_TOOL_FORBIDDEN','此工具未获准用于助理任务');rejectHostFields(input);
  let hostInput:Value={...input};
  const schema=Object.hasOwn(schemas,operation)?schemas[operation as OperationName]:null;
  // Whether identity exists in the exact input is discovered from the generated
  // schema, while authoritative validation remains the shared runtime schema.
  if(schema){const hydrated=hydrateInput(operation,hostInput,projectId,'00000000-0000-4000-8000-000000000000');hostInput={...hydrated};delete hostInput.requestId;}
  // A persisted skip is checked from validated explicit identities before
  // looking up the target. Deleting it must not turn a skip into another read.
  const references=agentTaskExplicitTargets(operation,hostInput,projectId);for(const target of references)beforeTargetRead?.(target);
  if(!store.get('projects',projectId))fail('AGENT_TASK_INVALID_TARGET','当前项目不存在');
  const before=snapshot(store,projectId),targets:AgentTaskTarget[]=[];
  if(risk==='local_reversible'&&operation.startsWith('timeline.')&&!before[key('timeline',projectId)])risk='local_irreversible';
  const add=(kind:string,id:string):void=>{const target={kind,id,revision:readRevision(store,projectId,kind,id)};if(!targets.some(value=>value.kind===kind&&value.id===id))targets.push(target);};
  if(operation==='task.wait'){
   if(!['job','image','frame','scene','export'].includes(String(hostInput.kind))||typeof hostInput.id!=='string')fail('AGENT_TASK_INVALID_TOOL','等待目标无效');
   const table=hostInput.kind==='job'?'jobs':hostInput.kind==='image'?'image_tasks':hostInput.kind==='frame'?'frame_tasks':hostInput.kind==='scene'?'scene_tasks':'exports';
   const owner=db.prepare(`SELECT projectId FROM ${table} WHERE id=?`).get(hostInput.id);if(owner?.projectId!==projectId)fail('AGENT_TASK_INVALID_TARGET','等待目标不属于当前项目');
   add(hostInput.kind==='image'?'image_task':hostInput.kind==='frame'?'frame_task':hostInput.kind==='scene'?'scene_task':String(hostInput.kind),hostInput.id);
  }
  if(operation==='task.disposition.list'){
   if(!Array.isArray(hostInput.targets))fail('AGENT_TASK_INVALID_TOOL','任务观察目标无效');
   for(const target of hostInput.targets){if(!object(target)||typeof target.taskId!=='string'||!['generation','render','edit'].includes(String(target.kind)))fail('AGENT_TASK_INVALID_TOOL','任务观察目标无效');
    const table=target.kind==='generation'?'jobs':target.kind==='render'?'exports':'edit_tasks';
    if(db.prepare(`SELECT projectId FROM ${table} WHERE id=?`).get(target.taskId)?.projectId!==projectId)fail('AGENT_TASK_INVALID_TARGET','观察任务不属于当前项目');
    add(target.kind==='generation'?'job':target.kind==='render'?'export':'edit_task',target.taskId);
   }
  }
  for(const [field,table,kind] of [['shotId','shots','shot'],['targetShotId','shots','shot'],['nodeId','nodes','node'],['sourceNodeId','nodes','node'],['edgeId','edges','edge'],['jobId','jobs','job'],['assetId','assets','asset'],['sourceAssetId','assets','asset'],['versionId','versions','version'],['exportId','exports','export']] as const)if(hostInput[field]!==undefined){owned(table,hostInput[field],projectId);add(kind,String(hostInput[field]));}
  // Only edge endpoints are entity identities. Loudness tools use `target`
  // for measurement settings and must retain their own shared-schema checks.
  if(operation==='edge.create')for(const field of ['source','target'] as const)if(hostInput[field]!==undefined){const id=String(hostInput[field]);const table=store.get('nodes',id)?'nodes':'shots';owned(table,id,projectId);add(table==='nodes'?'node':'shot',id);}
  for(const field of ['shotIds','assetIds'] as const)if(Array.isArray(hostInput[field]))for(const id of hostInput[field]){owned(field==='shotIds'?'shots':'assets',id,projectId);add(field==='shotIds'?'shot':'asset',String(id));}
  // Scene tasks are observed directly; they are not part of the change snapshot.
  if(operation.startsWith('scene.')&&hostInput.taskId!==undefined&&db.prepare('SELECT projectId FROM scene_tasks WHERE id=?').get(String(hostInput.taskId))?.projectId!==projectId)fail('AGENT_TASK_INVALID_TARGET','目标不属于当前项目');
  for(const [field,kind] of [['clipId','timeline_clip'],['trackId','timeline_track'],['cueId','timeline_subtitle'],['subjectId','subject'],['subjectVersionId','subject_version'],['bindingId','subject_binding'],...(operation.startsWith('scene.')?[]:[['taskId',operation.startsWith('frame.')?'frame_task':'image_task']] as const),['groupId','image_group']] as const)if(hostInput[field]!==undefined){const found=before[key(kind,String(hostInput[field]))];if(!found)fail('AGENT_TASK_INVALID_TARGET','目标不属于当前项目');if(kind!=='timeline_track'||!operation.startsWith('timeline.clip.'))add(kind,String(hostInput[field]));}
  if(operation==='timeline.clip.rippleRemove'){
   const removed=before[key('timeline_clip',String(hostInput.clipId))];
   if(removed)for(const entry of Object.values(before))if(entry.kind==='timeline_clip'&&entry.value.trackId===removed.value.trackId&&Number(entry.value.startFrame)>=Number(removed.value.startFrame))add(entry.kind,entry.id);
  }
  if(operation==='reference.detach'){
   const edge=before[key('edge',String(hostInput.edgeId))];
   if(edge)for(const [field,kind] of [['source','node'],['target','shot']] as const){const id=edge.value[field];if(typeof id==='string'&&before[key(kind,id)])add(kind,id);}
  }
  if(operation==='timeline.format.set')add('timeline',projectId);
  if(operation==='project.rename')add('project',projectId);
  if(operation==='shot.reorder')for(const item of Object.values(before).filter(item=>item.kind==='shot'))add(item.kind,item.id);
  // Aggregate operations genuinely affect all these targets. A single clip or
  // subtitle edit deliberately does not claim the complete timeline revision.
  if(['timeline.seed','timeline.loudness.apply','timeline.clip.splitAtScenes'].includes(operation))for(const item of Object.values(before).filter(item=>item.kind.startsWith('timeline_')||operation==='timeline.seed'&&item.kind==='shot'))add(item.kind,item.id);
  if(operation.startsWith('asset.range.'))add('asset_range',String(hostInput.assetId));
  if(operation==='asset.annotation.set')add('asset_annotation',String(hostInput.assetId));
  if(operation==='asset.disposition.set')add('asset_disposition',String(hostInput.assetId));
  // Observations retain all owner checks above but do not reserve mutation
  // targets. A draft or normal background progress must not block reading the
  // last saved value; write tools still carry their exact revision footprint.
  // Reference revisions carry no mutation authority. Preserve the exact
  // footprint above, and use these extra identities only for skip checks.
  const referencedTargets=[...targets];for(const reference of references)if(!referencedTargets.some(target=>target.kind===reference.kind&&target.id===reference.id))referencedTargets.push({...reference,revision:0});
  return {projectId,operation,input:hostInput,risk,targets:risk==='read_only'?[]:targets,referencedTargets,before};
 }
 async function execute(prepared:PreparedAgentTaskTool,context:AgentTaskToolContext):Promise<{result:AgentTaskJson;changes:TaskChangeInput[];recorded:boolean}>{
  const beforeEffect=():void=>{
   context.beforeEffect();
   if(prepared.operation==='shot.reorder'){
    const expected=Object.values(prepared.before).filter(item=>item.kind==='shot').map(item=>item.id).sort();
    const current=db.prepare('SELECT id FROM shots WHERE projectId=? ORDER BY id').all(prepared.projectId).map(row=>String(row.id));
    if(canonical(expected)!==canonical(current))fail('AGENT_TASK_TARGET_CHANGED','镜头集合已变化，请重新规划排序');
   }
  };
  const origin:AgentTaskEffectOrigin={...context,beforeEffect,projectId:prepared.projectId,operation:prepared.operation,recorded:false};
  preparedOrigins.set(origin,prepared);
  return withTaskEffectOrigin(origin,async()=>{
   beforeEffect();if(context.signal?.aborted)fail('AGENT_TASK_ABORTED','任务已暂停');
   if(prepared.operation==='node.inspect'||prepared.operation==='edge.inspect')return {result:inspectCanvas(prepared.projectId,prepared.operation,prepared.input),changes:[],recorded:false};
   if(prepared.operation==='task.wait')return {result:await waitTask(prepared.projectId,prepared.input,context.signal,context.beforeEffect),changes:[],recorded:false};
   if(['asset.importSelected','lut.importSelected'].includes(prepared.operation))return executeImport(prepared,context,origin);
   const input=hydrateInput(prepared.operation,prepared.input,prepared.projectId,context.requestId);
   // Aggregate CAS must not mistake another clip's edit for a target conflict.
   // The host has just checked the model's exact target revisions and will check
   // them again after BEGIN; only synchronous target-local edits use this CAS.
   if(prepared.risk==='local_reversible'&&/^(timeline\.(clip|track|subtitle)\.)/u.test(prepared.operation)){
    const row=db.prepare("SELECT json_extract(data,'$.revision') AS revision FROM timelines WHERE projectId=?").get(prepared.projectId);
    if(typeof row?.revision==='number')input.expectedRevision=row.revision;
   }
   if(prepared.operation==='project.rename'||prepared.operation==='shot.reorder'){
    const project=store.get('projects',prepared.projectId);if(object(project)&&typeof project.revision==='number')input.expectedRevision=project.revision;
   }
   const parsed:unknown=parse(prepared.operation as OperationName,input);
    let value:unknown;
    try{value=prepared.operation==='image.generate'&&input.providerId!=='mock'?await generateApprovedImage(parsed,prepared,context):await services.call(prepared.operation,parsed,{signal:context.signal});}
    catch(error){if(origin.effectFailure)throw origin.effectFailure;throw error;}
    if(origin.effectFailure)throw origin.effectFailure;
    let result:AgentTaskJson;
    if(prepared.operation==='timeline.loudness.prepare'){
     if(!isTimelineMixLoudnessResponse(value,parsed))fail('AGENT_TASK_INVALID_TOOL_RESULT','响度工具未返回完整且匹配本次请求的报告');
     result=projectResult(value);
     // Bind only the complete report actually returned to Mio. Projection must
     // never mint a usable digest for a stripped or truncated observation.
     if(!isTimelineMixLoudnessResponse(result,parsed)||canonical(result)!==canonical(value))fail('AGENT_TASK_INVALID_TOOL_RESULT','响度报告无法完整提供给助理');
     if(isTimelineLoudnessApplicableReport(result))result={...result,candidateDigest:await timelineLoudnessCandidateDigest(result)};
    }else result=projectResult(value);
    return {result,changes:changes(prepared,snapshot(store,prepared.projectId)),recorded:origin.recorded};
  });
 }
 function inspectCanvas(projectId:string,operation:string,input:Value):AgentTaskJson{
  const limit=input.limit??20,after=input.after??'';
  if(Object.keys(input).some(field=>!['limit','after'].includes(field))||!Number.isInteger(limit)||Number(limit)<1||Number(limit)>20||typeof after!=='string'||after!==''&&!/^[a-f0-9-]{36}$/iu.test(after))fail('AGENT_TASK_INVALID_TOOL','画布观察参数无效');
  const table=operation==='node.inspect'?'nodes':'edges';
  const rows=db.prepare(`SELECT id,projectId,CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND 32768 THEN data END AS data FROM ${table} WHERE projectId=? AND id>? ORDER BY id LIMIT ?`).all(projectId,after,Number(limit)+1);
  const items=rows.slice(0,Number(limit)).map(row=>{if(typeof row.data!=='string'||row.projectId!==projectId)fail('AGENT_TASK_INVALID_TARGET','画布记录无法验证');const value:unknown=JSON.parse(row.data);if(!object(value)||value.id!==row.id||value.projectId!==projectId)fail('AGENT_TASK_INVALID_TARGET','画布记录无法验证');
   return projectResult(Object.fromEntries((table==='nodes'?['id','projectId','revision','type','label','text','assetId','position']:['id','projectId','kind','role','source','target']).filter(field=>Object.hasOwn(value,field)).map(field=>[field,value[field]])));
  });
  return {projectId,items,nextAfter:rows.length>Number(limit)?String(rows[Number(limit)-1]!.id):null};
 }
 async function generateApprovedImage(input:unknown,prepared:PreparedAgentTaskTool,context:AgentTaskToolContext):Promise<unknown>{
  const profiles=await services.call('image.profile.list',{includeSettingsRevision:true});
  const items=object(profiles)&&Array.isArray(profiles.items)?profiles.items:[];
  const profile=items.find(item=>object(item)&&item.providerId===prepared.input.providerId&&item.model===prepared.input.model);
  if(!object(profile)||typeof profile.settingsRevision!=='number')fail('IMAGE_LIVE_DISABLED','图像配置尚未允许生成');
  const review=await services.call('image.review.prepare',{input,settingsRevision:profile.settingsRevision},{signal:context.signal});
  if(!object(review)||typeof review.id!=='string'||typeof review.revision!=='number')fail('IMAGE_REVIEW_INVALID','图像审批无法验证');
  context.beforeEffect();return services.imageApproval({projectId:prepared.projectId,reviewId:review.id,expectedRevision:review.revision});
 }
 async function waitTask(projectId:string,input:Value,signal?:AbortSignal,beforeEffect:()=>void=()=>{}):Promise<AgentTaskJson>{
  for(;;){beforeEffect();if(signal?.aborted)fail('AGENT_TASK_ABORTED','任务已暂停');const result=readWaitResult(projectId,input);if(result!==null)return result;await waitDelay(500,undefined,{signal});}
 }
 function readWaitResult(projectId:string,input:Value):AgentTaskJson|null{
  if(!['job','image','frame','scene','export'].includes(String(input.kind))||typeof input.id!=='string')fail('AGENT_TASK_INVALID_TOOL','等待目标无效');
  const operation=({job:'job.get',image:'image.task.get',frame:'frame.task.get',scene:'scene.task.get',export:'export.get'} as const)[input.kind as 'job'|'image'|'frame'|'scene'|'export'];
  const table=input.kind==='job'?'jobs':input.kind==='image'?'image_tasks':input.kind==='frame'?'frame_tasks':input.kind==='scene'?'scene_tasks':'exports';
  const owner=db.prepare(`SELECT projectId FROM ${table} WHERE id=?`).get(input.id);if(owner?.projectId!==projectId)fail('AGENT_TASK_INVALID_TARGET','等待目标不属于当前项目');

  const args=input.kind==='job'?{jobId:input.id}:input.kind==='export'?{exportId:input.id}:{projectId,taskId:input.id};
  // These five audited handlers are synchronous local observations. Calling the
  // public async dispatcher is unnecessary during unknown-result resolution.
  const value=services.handlers[operation]!(args as never);if(!object(value)||typeof value.then==='function')fail('AGENT_TASK_INVALID_TARGET','任务无法验证');
  if(value.projectId!==projectId)fail('AGENT_TASK_INVALID_TARGET','目标不属于当前项目');
  const state=value.status??value.state;
  // An interrupted scene task saved nothing and can simply be run again; a
  // storyboard whose result could not be saved also left no shots.
  if(input.kind==='scene')return ['succeeded','failed','cancelled','cancelled_before_start','interrupted','local_result_error','undone'].includes(String(state))?projectResult(value):null;
  if(['outcome_unknown','submission_unknown','interrupted_before_dispatch','interrupted','local_result_error'].includes(String(state)))fail('AGENT_TASK_UNKNOWN_RESULT','已有任务结果需要人工核对，不能重新提交');
  return ['succeeded','failed','cancelled','cancelled_before_dispatch','cancelled_before_start'].includes(String(state))?projectResult(value):null;
 }
 function recoverWait(prepared:PreparedAgentTaskTool):AgentTaskJson|null{if(prepared.operation!=='task.wait')fail('AGENT_TASK_INVALID_TOOL','此步骤不是等待任务');return readWaitResult(prepared.projectId,prepared.input);}
 function recoverLocalUnknown(prepared:PreparedAgentTaskTool,input:{runId:string;stepId:string;requestId:string}):AgentTaskLocalRecovery|null{
  const run=journal.run(input.runId),step=journal.step(input.stepId);
  if(input.requestId!==step.id||run.projectId!==prepared.projectId||step.runId!==run.id||step.status!=='unknown'||step.result!==undefined||step.toolCall?.name!==list().find(tool=>tool.operation===prepared.operation)?.name)return null;
  if(journal.snapshot(run.id).changes.some(change=>change.stepId===step.id))return null;
  if(prepared.risk==='read_only'&&prepared.operation!=='task.wait')return {outcome:'not_applied',reason:'read_only'};
  if(prepared.risk==='paid'){
   // Only a worker dispatching a queued job or image task reaches a provider, and dispatch records the step's cost.
   // Acceptance commits that record, its request receipt and the v2 job origin in one transaction; with none of
   // them nothing was accepted, sent or billed. Any present record keeps the step for provider reconciliation.
   const receipts=prepared.operation==='generation.submit'?["SELECT 1 FROM idempotency WHERE scope='generation' AND requestId=?"]:prepared.operation==='image.generate'?['SELECT 1 FROM image_requests WHERE requestId=?','SELECT 1 FROM image_tasks WHERE requestId=?']:null;
   if(!receipts||step.cost!==undefined&&step.cost!=='pending')return null;
   if(receipts.some(sql=>db.prepare(sql).get(input.requestId))||db.prepare('SELECT 1 FROM agent_task_job_origins_v2 WHERE runId=? AND stepId=?').get(input.runId,input.stepId))return null;
   return {outcome:'not_applied',reason:'atomic_receipt_absent'};
  }
  if(prepared.risk!=='local_reversible'||!reversibleOperations.includes(prepared.operation as typeof reversibleOperations[number]))return null;
  // These operations have no effects outside their domain transaction. The
  // immutable domain receipt and v2 completion either both committed or neither
  // did. A present domain receipt is preserved for explicit result inspection.
  const table=prepared.operation==='project.rename'?'project_mutation_requests':prepared.operation.startsWith('reference.')?'reference_requests':prepared.operation==='subject.binding.set'?'subject_requests':prepared.operation==='asset.range.set'?'asset_range_requests':prepared.operation==='asset.disposition.set'?'asset_disposition_requests':prepared.operation==='asset.annotation.set'?'asset_annotation_requests':prepared.operation.startsWith('timeline.')?'timeline_requests':prepared.operation.startsWith('edge.')?null:'mutation_requests';
  if(table&&db.prepare(`SELECT 1 FROM ${table} WHERE requestId=?`).get(input.requestId))return null;
  return {outcome:'not_applied',reason:'atomic_receipt_absent'};
 }
 async function stageImport(input:{projectId:string;requestId:string;name:string;mimeType:string;dataBase64:string}):Promise<AgentTaskJson>{
  if(!store.get('projects',input.projectId))fail('AGENT_TASK_INVALID_TARGET','当前项目不存在');
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)||input.dataBase64.length%4)fail('INVALID_MEDIA','文件编码无效');
  const lut=/\.cube$/iu.test(input.name),mimeType=lut?'application/x-cube':input.mimeType,limit=(lut?7:30)*1024*1024;
  const bytes=Buffer.from(input.dataBase64,'base64');if(!bytes.length||bytes.length>limit)fail('INVALID_MEDIA',lut?'Cube文件须为1字节至7MiB':'文件大小须为1字节至30MiB');
  if(input.name.length<1||input.name.length>200||!lut&&!['image/png','image/jpeg','image/webp','video/mp4','video/webm','audio/wav','audio/mpeg','audio/mp4'].includes(mimeType))fail('INVALID_MEDIA','文件类型无效');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const previous=db.prepare('SELECT * FROM agent_task_imports_v2 WHERE requestId=?').get(input.requestId);
  if(previous){if(previous.projectId!==input.projectId||previous.sha256!==sha256||previous.name!==input.name||previous.mimeType!==mimeType)fail('AGENT_TASK_REQUEST_CONFLICT','文件选择请求已用于其他内容');return {id:String(previous.id),handle:String(previous.id),name:String(previous.name),mimeType:String(previous.mimeType),status:String(previous.status)};}
  const id=randomUUID(),relativePath=`agent-imports/${id}.bin`;ensurePrivateDirectory(path.join(store.root,'agent-imports'),{create:true});writePrivateFileAtomic(path.join(store.root,relativePath),bytes,{root:store.root,maxBytes:limit,replace:false});
  store.tx(()=>db.prepare("INSERT INTO agent_task_imports_v2(id,projectId,requestId,name,mimeType,relativePath,sha256,status,assetId,createdAt) VALUES(?,?,?,?,?,?,?,'selected',NULL,?)").run(id,input.projectId,input.requestId,input.name,mimeType,relativePath,sha256,new Date().toISOString()));
  return {id,handle:id,name:input.name,mimeType,status:'selected'};
 }
 async function executeImport(prepared:PreparedAgentTaskTool,context:AgentTaskToolContext,origin:AgentTaskEffectOrigin):Promise<{result:AgentTaskJson;changes:TaskChangeInput[];recorded:boolean}>{
  const handle=prepared.input.handle;if(typeof handle!=='string')fail('AGENT_TASK_INVALID_TOOL','请选择已授权文件');
  const row=db.prepare('SELECT * FROM agent_task_imports_v2 WHERE id=? AND projectId=?').get(handle,prepared.projectId);if(!row)fail('AGENT_TASK_INVALID_TARGET','文件选择记录不属于当前项目');
  const isLut=prepared.operation==='lut.importSelected';if((row.mimeType==='application/x-cube')!==isLut)fail('AGENT_TASK_INVALID_TOOL','文件句柄类型与工具不符');
  if(isLut&&typeof row.resourceId==='string'){return {result:projectResult(await services.call('lut.inspect',{projectId:prepared.projectId,lutId:row.resourceId})),changes:[],recorded:false};}
  if(row.assetId){const asset=owned('assets',row.assetId,prepared.projectId);return {result:projectResult(asset),changes:[],recorded:false};}
  if(row.status!=='selected')fail('AGENT_TASK_UNKNOWN_RESULT','该文件导入结果未知，请先查询原任务');
  if(typeof row.relativePath!=='string'||row.relativePath!==`agent-imports/${String(row.id)}.bin`)fail('AGENT_TASK_INVALID_TARGET','文件选择记录无法验证');
  context.beforeEffect();
  const bytes=readPrivateFile(path.join(store.root,row.relativePath),{root:store.root,maxBytes:(isLut?7:30)*1024*1024});if(!Buffer.isBuffer(bytes)||createHash('sha256').update(bytes).digest('hex')!==row.sha256)fail('AGENT_TASK_INVALID_TARGET','已选文件内容发生变化');
  store.tx(()=>{context.beforeEffect();const changed=db.prepare("UPDATE agent_task_imports_v2 SET status='importing' WHERE id=? AND projectId=? AND status='selected'").run(handle,prepared.projectId);if(changed.changes!==1)fail('AGENT_TASK_UNKNOWN_RESULT','该文件导入已受理');});
  origin.importHandle=handle;
  context.beforeEffect();const value=await services.call(isLut?'lut.import':'asset.import',{projectId:prepared.projectId,name:row.name,...(isLut?{requestId:context.requestId}:{mimeType:row.mimeType}),dataBase64:bytes.toString('base64')},{signal:context.signal});
   return {result:projectResult(value),changes:changes(prepared,snapshot(store,prepared.projectId)),recorded:origin.recorded};
 }
 function undo(change:AgentTaskChange,context:AgentTaskUndoContext):{targets:AgentTaskTarget[];retained?:boolean}{
  if(!change.reversible||change.status!=='applied'||!Array.isArray(change.undo))fail('AGENT_TASK_NOT_REVERSIBLE','此项变化不能撤销');
  const undoEntries=change.undo;
  return store.tx(()=>{
   context.beforeEffect();const current=snapshot(store,change.projectId),expected=context.expectedTargets??change.targets;
   for(const target of expected){if(readRevision(store,change.projectId,target.kind,target.id)!==target.revision)fail('AGENT_TASK_TARGET_CHANGED','目标在此项变化后已被修改');if(db.prepare('SELECT 1 FROM agent_task_edit_claims_v2 WHERE projectId=? AND kind=? AND targetId=?').get(change.projectId,target.kind,target.id))fail('AGENT_TASK_TARGET_CLAIMED','目标仍有未保存草稿');}
   const entries:Array<{before?:SnapshotEntry;after?:SnapshotEntry}>=[];
   for(const item of undoEntries){if(!object(item))fail('AGENT_TASK_INVALID_TARGET','撤销记录无效');const before=item.before,after=item.after;if(before!==undefined&&!object(before)||after!==undefined&&!object(after))fail('AGENT_TASK_INVALID_TARGET','撤销记录无效');
    const entry={...(before?{before:before as unknown as SnapshotEntry}:{}),...(after?{after:after as unknown as SnapshotEntry}:{})},identity=entry.after??entry.before;if(!identity||typeof identity.kind!=='string'||typeof identity.id!=='string'||typeof identity.table!=='string')fail('AGENT_TASK_INVALID_TARGET','撤销目标无效');
    const found=current[key(identity.kind,identity.id)];if(canonical(found?comparable(found.value):null)!==canonical(entry.after?comparable(entry.after.value):null))fail('AGENT_TASK_TARGET_CHANGED','目标已变化，无法覆盖当前编辑');entries.push(entry);
   }
   const dependencies=undoDependencies(store,change,current,entries);
   if(dependencies==='blocked')fail('AGENT_TASK_TARGET_CHANGED','目标已有新的依赖，无法撤销');
   if(dependencies==='retain'){context.retainInside(change,'保留生成记录及产物所需镜头');return {targets:[],retained:true};}
   context.beforeCompensation?.();
   const timelineTargets=entries.filter(entry=>(entry.after??entry.before)!.kind.startsWith('timeline'));
   // References are removed before their source node/shot. Restoration inserts
   // the owning rows first, then edges, so all domain relations remain valid.
   const rows=entries.filter(entry=>!timelineTargets.includes(entry)).sort((a,b)=>{
    const aEdge=(a.after??a.before)!.kind==='edge',bEdge=(b.after??b.before)!.kind==='edge';return aEdge===bEdge?0:aEdge?(a.before?1:-1):(b.before?-1:1);
   });
   for(const entry of rows)compensateRow(change.projectId,entry);
   if(timelineTargets.length)services.compensateAgentTimelineInside(change.projectId,timelineTargets.map(entry=>({kind:(entry.after??entry.before)!.kind,id:(entry.after??entry.before)!.id,before:entry.before?.value??null,after:entry.after?.value??null})));
   context.recordInside(change);
   return {targets:change.targets.map(target=>({...target,revision:readRevision(store,change.projectId,target.kind,target.id)}))};
  });
 }
 function compensateRow(projectId:string,entry:{before?:SnapshotEntry;after?:SnapshotEntry}):void{
  const identity=(entry.after??entry.before)!,table=identity.table;
  if(Object.hasOwn(rowTables,table)||table==='projects'){
   if(!entry.before){
    if(!['shots','nodes','edges'].includes(table))fail('AGENT_TASK_NOT_REVERSIBLE','此产物不可删除');
    if(table!=='edges'){
     if(db.prepare("SELECT 1 FROM edges WHERE projectId=? AND (json_extract(data,'$.source')=? OR json_extract(data,'$.target')=?) LIMIT 1").get(projectId,identity.id,identity.id))fail('AGENT_TASK_TARGET_CHANGED','目标已有新连线');
     if(table==='shots'&&db.prepare("SELECT 1 FROM jobs WHERE projectId=? AND json_extract(data,'$.shotId')=? LIMIT 1").get(projectId,identity.id))fail('AGENT_TASK_TARGET_CHANGED','镜头已有生成任务');
    }
    db.prepare(`DELETE FROM ${table} WHERE id=? AND projectId=?`).run(identity.id,projectId);return;
   }
   const current=store.get(table,identity.id),value={...entry.before.value};
   if(object(current)&&typeof current.revision==='number')value.revision=current.revision+1;
   if(Object.hasOwn(value,'updatedAt'))value.updatedAt=new Date().toISOString();
   store.put(table,value);return;
  }
  const descriptor=extraTables[table];if(!descriptor||!reversibleMetadata.has(identity.kind))fail('AGENT_TASK_NOT_REVERSIBLE','此项没有安全补偿操作');
  const row=db.prepare(`SELECT * FROM ${table} WHERE ${descriptor.id}=? AND projectId=?`).get(identity.id,projectId);
  if(!row)fail('AGENT_TASK_TARGET_CHANGED','目标记录已改变');
  let value:Value;
  if(entry.before)value={...entry.before.value};
  else {const defaults=defaultMetadataCompensation(identity.kind,row);if(defaults===null){db.prepare('DELETE FROM asset_ranges WHERE assetId=? AND projectId=?').run(identity.id,projectId);return;}value=defaults;}
  if(typeof row.revision==='number')value.revision=row.revision+1;
  if(Object.hasOwn(value,'updatedAt'))value.updatedAt=new Date().toISOString();
  const fields=Object.keys(value).filter(field=>field!==descriptor.id&&field!=='projectId');
  const values=fields.map(field=>{const item=value[field];if(typeof item==='string'||typeof item==='number'||item===null)return item;throw new TypeError('Invalid compensation SQL value');});
  db.prepare(`UPDATE ${table} SET ${fields.map(field=>`"${field}"=?`).join(',')} WHERE ${descriptor.id}=? AND projectId=?`).run(...values,identity.id,projectId);
 }
 const list=():AgentTaskToolDefinition[]=>[...[...tierByOperation].map(([operation,risk])=>({name:`mioon_${operation.replaceAll('.','_')}`,operation,description:descriptions[operation]??operation,parameters:AGENT_TASK_TOOL_SCHEMAS[operation],risk,receipt:operationEffect(operation).readOnly?'observation':'durable task step',recovery:'read retained receipt; never repeat unknown execution',undo:risk==='local_reversible'?'target compensation':'unavailable'})),
  ...(['node','edge'] as const).map(kind=>({name:`mioon_${kind}_inspect`,operation:`${kind}.inspect`,description:`分页观察当前项目${kind==='node'?'画布节点的文本和位置':'连线的来源与目标'}，不读文件。`,parameters:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:20},after:{type:'string',description:'Previous nextAfter; omit for the first page.'}},additionalProperties:false},risk:'read_only' as const,receipt:'observation',recovery:'read saved metadata',undo:'unavailable'})),
  {name:'mioon_task_wait',operation:'task.wait',description:'等待当前项目内已受理任务，仅查询本地状态；不提交或轮询供应商。',parameters:{type:'object',properties:{kind:{type:'string',enum:['job','image','frame','scene','export']},id:{type:'string',format:'uuid'}},required:['kind','id'],additionalProperties:false},risk:'read_only',receipt:'observation',recovery:'read local state',undo:'unavailable'},
  {name:'mioon_asset_import_selected',operation:'asset.importSelected',description:'导入用户已选择并授权的文件句柄，不能指定路径或字节。',parameters:{type:'object',properties:{handle:{type:'string',format:'uuid'}},required:['handle'],additionalProperties:false},risk:'local_irreversible',receipt:'durable import receipt',recovery:'read original handle',undo:'unavailable'},
  {name:'mioon_lut_import_selected',operation:'lut.importSelected',description:'导入用户选择的Cube文件句柄，最多7MiB，不允许路径或字节。',parameters:{type:'object',properties:{handle:{type:'string',format:'uuid'}},required:['handle'],additionalProperties:false},risk:'local_irreversible',receipt:'durable import receipt',recovery:'read original handle',undo:'unavailable'},
 ];
 return {list,prepare,parameterFeedback,execute,undo,stageImport,wait:waitTask,recoverWait,recoverLocalUnknown,snapshot:(projectId:string)=>snapshot(store,projectId),dispose:()=>{removeObserver();removeFence();removeJobOrigins();removeDispatchRecorder();removeTargetGate();}};
}
export type AgentTaskTools=ReturnType<typeof createAgentTaskTools>;
