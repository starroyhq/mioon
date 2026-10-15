import {TIMELINE_MUTATION_OPERATIONS,REFERENCE_MUTATION_OPERATIONS,SUBJECT_MUTATION_OPERATIONS,AppError} from '@mioon/contracts';
import {getWorkspaceRestoreContext, isRestoredRecordHeld} from './workspace-restore-schema.mjs';
import {assertRestoreInvocation,restoreDigest} from './workspace-restore-invocation.mjs';
import {ownsStoreLock} from './db.mjs';

// This catalogue is an execution boundary, not an inference from readOnly hints
// or operation suffixes. New local effects require a live pinned invocation.
export const RESTORE_READ_OPERATIONS = Object.freeze([
 'asset.annotation.list', 'workspace.restore.inspect', 'project.list', 'project.get', 'asset.list', 'lut.list', 'lut.inspect', 'lut.look.inspect',
 'job.get', 'job.list', 'version.list', 'export.get', 'timeline.get',
 'timeline.history.get', 'timeline.format.get', 'project.inspect', 'asset.inspect',
 'shot.inspect', 'timeline.inspect', 'asset.range.get', 'asset.disposition.list',
 'subject.list', 'subject.version.list', 'subject.binding.list','asset.waveform.get',
 'image.request.get','image.task.get','image.task.list','image.group.get','image.group.list','image.version.list','frame.request.get','frame.task.get','frame.task.list',
]);
export const RESTORE_LOCAL_OPERATIONS = Object.freeze([
 'project.create','asset.import','shot.create','shot.update','shot.reorder','node.create','node.update','edge.create','edge.delete','reference.attach','reference.detach','version.select','export.create',
 'timeline.format.set','timeline.undo','timeline.redo','timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.render','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove','timeline.export.capabilities','timeline.export.preflight','asset.range.set','asset.disposition.set','subject.create','subject.version.add','subject.binding.set',
]);
export const RESTORE_DENIED_OPERATIONS = Object.freeze([
 'asset.annotation.set', 'lut.import',
 'timeline.clip.loudness','timeline.loudness.prepare','timeline.loudness.apply','timeline.audioPreview.plan','timeline.export.samplePeak','timeline.export.loudness','workspace.backup.inspect','provider.list','generation.submit','job.retry','job.cancel','job.reconcile','asset.waveform.request',
 'frame.extract','frame.task.cancelQueued','frame.task.recoverResult','image.profile.list','image.review.prepare','image.review.get','image.review.list','image.generate','image.task.cancelQueued','image.task.recoverResult','image.task.remote.get','image.task.observeRemote',
]);
const messages=Object.freeze({
 RESTORE_OPERATION_UNAVAILABLE:'This operation is unavailable in this restored workspace.',
 RESTORED_RECORD_HELD:'This captured record is held and cannot execute or change in this restored workspace.',
 RESTORE_WORKSPACE_ORIGIN_REQUIRED:'A new explicit action must supply this restored workspace origin.',
 RESTORE_WORKSPACE_ORIGIN_MISMATCH:'The action belongs to a different workspace origin.',
});
export function workspaceRestoreError(code='RESTORE_OPERATION_UNAVAILABLE') {
 const key=Object.hasOwn(messages,code)?code:'RESTORE_OPERATION_UNAVAILABLE';
 return new AppError(key,messages[key],409);
}
export function safeWorkspaceRestoreError(error) {
 return Object.hasOwn(messages,error?.code)?workspaceRestoreError(error.code):null;
}
export function assertWorkspaceRestoreOrigin(store,context={}) {
 const restored=getWorkspaceRestoreContext(store);
 if(!restored)return null;
 const origin=context?.expectedWorkspaceOrigin;
 if(typeof origin!=='string'||origin.length!==36||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(origin))
  throw workspaceRestoreError('RESTORE_WORKSPACE_ORIGIN_REQUIRED');
 if(origin!==restored.workspaceOrigin)throw workspaceRestoreError('RESTORE_WORKSPACE_ORIGIN_MISMATCH');
 if(!ownsStoreLock(store))throw workspaceRestoreError();
 return restored;
}
const targets=Object.freeze({
 'job.retry':['jobs','jobId'], 'job.cancel':['jobs','jobId'], 'job.reconcile':['jobs','jobId'],
 'frame.task.cancelQueued':['frame_tasks','taskId'], 'frame.task.recoverResult':['frame_tasks','taskId'],
 'image.task.cancelQueued':['image_tasks','taskId'], 'image.task.recoverResult':['image_tasks','taskId'],
 'image.task.observeRemote':['image_tasks','taskId'],
});
export function refuseRestoredOperation(store,operation,input) {
 if(!getWorkspaceRestoreContext(store))return;
 if(RESTORE_LOCAL_OPERATIONS.includes(operation)||operation==='timeline.get'||operation==='workspace.preferences.put'){
  assertRestoreInvocation(store,operation,input);
  assertRestoreRequestVacant(store,operation,input);
  return;
 }
 const target=Object.hasOwn(targets,operation)?targets[operation]:null;
 if(target&&typeof input?.[target[1]]==='string'){
  // A foreign target and a missing target receive the same refusal. Relational
  // ownership is checked before captured membership or stored JSON is read.
  const row=store.db.prepare(`SELECT projectId FROM ${target[0]} WHERE id=?`).get(input[target[1]]);
  if(row&&(input.projectId===undefined||row.projectId===input.projectId)&&isRestoredRecordHeld(store,target[0],input[target[1]]))
   throw workspaceRestoreError('RESTORED_RECORD_HELD');
 }
 throw workspaceRestoreError();
}
export function refuseRestoredTask(store,taskId,projectId) {
 if(!getWorkspaceRestoreContext(store))return;
 if(typeof taskId==='string'&&typeof projectId==='string'&&store.db.prepare('SELECT 1 FROM edit_tasks WHERE id=? AND projectId=?').get(taskId,projectId)&&isRestoredRecordHeld(store,'edit_tasks',taskId))throw workspaceRestoreError('RESTORED_RECORD_HELD');
 throw workspaceRestoreError();
}
// Fixed special-route families are refused before constructing or entering a
// settings/approval/Agent runtime. No URI segment provides an execution grant.
export function isUnavailableRestoredRoute(pathname,method) {
 return /^\/api\/agent(?:\/|$)/u.test(pathname)||/^\/api\/images(?:\/|$)/u.test(pathname);
}

// Captured intents reserve their original business key even when they never
// reached a domain receipt. Ownership precedes disclosure of captured presence.
export function assertRestoreRequestVacant(store,operation,input){
 if(!getWorkspaceRestoreContext(store)||typeof input?.requestId!=='string')return;
 const projectId=input.projectId??(operation==='shot.update'||operation==='version.select'?store.db.prepare('SELECT projectId FROM shots WHERE id=?').get(input.shotId)?.projectId:operation==='node.update'?store.db.prepare('SELECT projectId FROM nodes WHERE id=?').get(input.nodeId)?.projectId:undefined);
 if(!projectId||!store.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))throw workspaceRestoreError();
 const namespace=operation==='export.create'?'export':TIMELINE_MUTATION_OPERATIONS.includes(operation)?'timeline':REFERENCE_MUTATION_OPERATIONS.includes(operation)?'reference':'local-mutation';
 const taskLane=namespace==='timeline'?'timeline:mutation':namespace==='reference'?'reference:mutation':namespace==='local-mutation'?'subject:mutation':null;
 const captured=store.db.prepare('SELECT projectId FROM workspace_restore_holds WHERE requestId=? AND namespace IN (?,?) LIMIT 2').all(input.requestId,namespace,taskLane);
 if(captured.length)throw workspaceRestoreError(captured.every(row=>row.projectId===projectId)?'RESTORED_RECORD_HELD':'RESTORE_OPERATION_UNAVAILABLE');
 if(!['local-mutation','timeline'].includes(namespace))return;
 const proposalOperation=namespace==='timeline'?'timeline.clip.update':'shot.update';
 // Foreign payloads never cross this query boundary. The sealed SQL row only
 // answers whether the same global business-key namespace is already held.
 const foreign=store.db.prepare(`SELECT 1 FROM agent_edit_proposals p JOIN workspace_restore_holds h ON h.kind='agent_edit_proposals' AND h.id=p.id WHERE p.projectId<>? AND EXISTS(SELECT 1 FROM json_tree(p.definition) WHERE key='requestId' AND path='$.input' AND value=?) AND EXISTS(SELECT 1 FROM json_each(p.definition) WHERE key='operation' AND value=?) LIMIT 1`).get(projectId,input.requestId,proposalOperation);
 if(foreign)throw workspaceRestoreError();
 const rows=store.db.prepare(`SELECT p.id,p.projectId,p.runId,p.digest,CASE WHEN length(CAST(p.definition AS BLOB)) BETWEEN 1 AND 131072 THEN p.definition END AS definition FROM agent_edit_proposals p JOIN workspace_restore_holds h ON h.kind='agent_edit_proposals' AND h.id=p.id WHERE p.projectId=? LIMIT 2049`).all(projectId);
 if(rows.length>2048)throw workspaceRestoreError();
 for(const row of rows){
  let definition;try{definition=JSON.parse(row.definition);}catch{throw workspaceRestoreError();}
  if(!definition||definition.id!==row.id||definition.projectId!==projectId||definition.runId!==row.runId||restoreDigest(definition)!==row.digest||!['shot.update','timeline.clip.update'].includes(definition.operation)||typeof definition.input?.requestId!=='string')throw workspaceRestoreError();
  if(definition.operation===proposalOperation&&definition.input.requestId===input.requestId)throw workspaceRestoreError('RESTORED_RECORD_HELD');
 }
}
