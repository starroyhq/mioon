import {restoreEffectFence} from './workspace-restore-invocation.mjs';
import {refuseRestoredOperation,safeWorkspaceRestoreError} from './workspace-restore-policy.mjs';
import {AppError,timelineExportCapabilityResultSchema,resolveTimelineExportDelivery,timelineExportCapabilitySchemas} from '@mioon/contracts';
import {createTimelineRecoveryBoundary} from './timeline-recovery.mjs';
import {inspectTimelineExportCapability} from './timeline-export-capabilities.mjs';
import {checkpoint,awaitProvider,boundedShutdown} from './operation-lifecycle.mjs';

const messages=Object.freeze({
 EXPORT_CAPABILITY_AVAILABLE:'The selected fixed export profile completed the bounded local encode and mux check.',
 EXPORT_CAPABILITY_TOOL_UNAVAILABLE:'The required local media tool is unavailable.',
 EXPORT_CAPABILITY_UNSUPPORTED:'The required fixed encoder or muxer is unavailable.',
 EXPORT_CAPABILITY_BUSY:'Another local export capability check is running. Try again when it finishes.',
 EXPORT_CAPABILITY_TIMEOUT:'The bounded local export capability check reached its time limit.',
 EXPORT_CAPABILITY_CANCELLED:'The local export capability check was interrupted.',
 EXPORT_CAPABILITY_CONFIGURATION:'The local media tool configuration is invalid.',
 EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED:'The local media process exit could not be confirmed.',
 EXPORT_CAPABILITY_FAILED:'The selected fixed export profile did not complete its local encode and mux proof.',
 EXPORT_CAPABILITY_OUTPUT_LIMIT:'The bounded local export capability check exceeded its output limit.',
 TIMELINE_MISSING:'This project has no saved timeline.',
 INVALID_TIMELINE_SNAPSHOT:'The saved timeline contains invalid or unsupported settings.',
 TIMELINE_SOURCE_UNAVAILABLE:'The saved timeline or a referenced source is not available in this project.',
 EXPORT_CAPABILITY_STALE:'The saved timeline or its source metadata changed. Check the current selection again.',
});
const issue=code=>({code,message:messages[code]});
export function timelineExportCapabilityError(code){return new AppError(code,messages[code]??messages.EXPORT_CAPABILITY_FAILED,409);}

// Own every underlying check, including a non-cooperative injected helper. No
// asynchronous media work ever runs while an admission SQLite transaction is open.
export function createTimelineExportAdmissionServices(store,{signal:ownerSignal,inspect=inspectTimelineExportCapability,hash}={}){
 const active=new Set();let stopped=false,shutdownFailure;
 async function inspectOwned(delivery,{signal:callSignal}={}){
  refuseRestoredOperation(store,'timeline.export.capabilities');
  const beforeEffect=restoreEffectFence(store);
  const external=ownerSignal&&callSignal&&ownerSignal!==callSignal?AbortSignal.any([ownerSignal,callSignal]):ownerSignal||callSignal;
  checkpoint(external);if(shutdownFailure)throw shutdownFailure;if(stopped)throw new AppError('OPERATION_CANCELLED','Operation interrupted by shutdown',503);
  if(store.db.isTransaction)throw new AppError('EXPORT_CAPABILITY_CONFIGURATION',messages.EXPORT_CAPABILITY_CONFIGURATION,409);
  const controller=new AbortController(),signal=external?AbortSignal.any([external,controller.signal]):controller.signal;
  const entry={controller,task:null};active.add(entry);
  const task=Promise.resolve().then(()=>{beforeEffect?.();return inspect(delivery,{signal,beforeEffect});});
  entry.task=task.catch(error=>{if(error.terminationUnconfirmed)shutdownFailure=error;}).finally(()=>active.delete(entry));
  try{
   const value=await awaitProvider(()=>task,signal);checkpoint(signal);beforeEffect?.();
   if(value?.code==='EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED')throw Object.assign(Error(messages.EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED),{code:'MEDIA_TERMINATION_UNCONFIRMED',terminationUnconfirmed:true});
   return timelineExportCapabilityResultSchema.safeParse(value).success?value:{status:'incomplete',code:'EXPORT_CAPABILITY_FAILED'};
  }catch(error){
   if(error.terminationUnconfirmed){shutdownFailure=error;throw error;}
   if(safeWorkspaceRestoreError(error))throw error;
   checkpoint(signal);if(['OPERATION_CANCELLED','MEDIA_CANCELLED'].includes(error.code))throw error;
   return {status:'incomplete',code:'EXPORT_CAPABILITY_FAILED'};
  }
 }
 function read(input){
  const timeline=createTimelineRecoveryBoundary(store.db,input).read();
  return timeline?{timeline,delivery:resolveTimelineExportDelivery(timeline,input.exportSettings)}:null;
 }
 async function capabilities(input,options={}){
  refuseRestoredOperation(store,'timeline.export.capabilities',input);
  // Direct service users get the same strict syntax boundary as RPC callers.
  input=timelineExportCapabilitySchemas['timeline.export.capabilities'].parse(input);
  checkpoint(options.signal);checkpoint(ownerSignal);
  const report={projectId:input.projectId,timelineId:null,timelineRevision:null,expectedRevision:input.expectedRevision,exportSettings:input.exportSettings,
   delivery:null,checkedAt:new Date().toISOString(),status:'blocked',issues:[]};
  let initial;
  try{initial=read(input);}catch(error){if(error.code==='NOT_FOUND')throw error;report.issues=[issue(error.code==='INVALID_TIMELINE_SNAPSHOT'?'INVALID_TIMELINE_SNAPSHOT':'TIMELINE_SOURCE_UNAVAILABLE')];return report;}
  if(!initial){report.issues=[issue('TIMELINE_MISSING')];return report;}
  report.timelineId=initial.timeline.id;report.timelineRevision=initial.timeline.revision;report.delivery=initial.delivery;
  if(initial.timeline.revision!==input.expectedRevision){report.status='stale';report.issues=[issue('EXPORT_CAPABILITY_STALE')];return report;}
  const result=await inspectOwned(initial.delivery,options);
  // Re-read ownership and exact geometry/content after the await; a report may
  // never bind a successful check to a replaced owner or a different revision.
  let current;try{current=read(input);}catch{current=null;}
  if(!current||JSON.stringify(current)!==JSON.stringify(initial)){report.status='stale';report.issues=[issue('EXPORT_CAPABILITY_STALE')];return report;}
  report.status=result.status;report.issues=result.status==='available'?[]:[issue(result.code)];return report;
 }
 async function render(input,options,{prepare,accept}){
  refuseRestoredOperation(store,'timeline.render',input);
  // prepare replays immutable historical ACKs before current revision, any
  // local compute, or capability availability can affect their result.
  const before=prepare();if(before.replayed)return before.response;
  const result=await inspectOwned(before.snapshot.delivery,options);
  checkpoint(options?.signal);checkpoint(ownerSignal);
  // accept runs a second exact transaction: receipt replay/dedupe, project and
  // source ownership, CAS, unchanged snapshot, then possible pre-write rejection.
  return accept({timelineId:before.snapshot.timeline.id,snapshotHash:hash(before.snapshot),failure:result.status==='available'?null:timelineExportCapabilityError(result.code)});
 }
 const stop=()=>{stopped=true;for(const entry of active)entry.controller.abort();};
 ownerSignal?.addEventListener('abort',stop,{once:true});if(ownerSignal?.aborted)stop();
 async function drain(){stop();await boundedShutdown(Promise.allSettled([...active].map(entry=>entry.task)),'EXPORT_CAPABILITY_STOP_TIMEOUT');ownerSignal?.removeEventListener('abort',stop);if(shutdownFailure)throw shutdownFailure;}
 return {handlers:{'timeline.export.capabilities':capabilities},render,inspect:inspectOwned,drain};
}
