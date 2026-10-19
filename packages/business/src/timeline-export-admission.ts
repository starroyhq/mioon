import {getOpacityCandidateAssembly} from './opacity-candidate-store.ts';
import {createOpacityCandidateDomain} from './opacity-candidate-domain.ts';
import {OPACITY_CANDIDATE_PREFLIGHT_MESSAGES} from './opacity-candidate-preflight.ts';
import {TIMELINE_COLOUR_PREFLIGHT_MESSAGES} from '../../contracts/src/timeline-colour.ts';
import {restoreEffectFence as legacyRestoreEffectFence} from './workspace-restore-invocation.ts';
import {refuseRestoredOperation as legacyRefuseRestoredOperation,safeWorkspaceRestoreError} from './workspace-restore-policy.ts';
import {AppError,timelineExportCapabilityResultSchema,resolveTimelineExportDelivery,timelineExportCapabilitySchemas} from '@mioon/contracts';
import {createTimelineRecoveryBoundary} from './timeline-recovery.ts';
import {inspectTimelineExportCapability} from './timeline-export-capabilities.ts';
import {checkpoint,awaitProvider,boundedShutdown} from './operation-lifecycle.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {TimelineRecoveryInput} from './timeline-recovery.ts';
import type {TimelineRecord} from './timeline-inputs.ts';

interface ExportAdmissionStore {db: DatabaseSync;root?: string}
interface TimelineFormatDelivery {effective: {profileId?: string;width: number;height: number;scaling?: string}}
export interface TimelineExportCapabilityReport {
 projectId: string;timelineId: string|null;timelineRevision: number|null;expectedRevision: number;exportSettings: unknown;
 delivery: unknown;checkedAt: string;status: string;issues: {code: string;message: string|undefined}[];
}
interface AdmissionInspectOptions {signal: AbortSignal;beforeEffect: (()=>void)|undefined;capabilityWorkRoot: string|undefined}
interface AdmissionOptions {signal?: AbortSignal}
interface InspectResult {status?: string;code?: string;terminationUnconfirmed?: boolean}
interface ActiveCheck {controller: AbortController;task: Promise<unknown>|null}
type RefuseRestoredOperation=(target: unknown,operation: string,input?: Record<string, unknown>)=>void;
interface RenderPrepared {replayed?: boolean;response?: unknown;snapshot?: {delivery: unknown;timeline: {id: string}}}
interface RenderHooks {prepare: ()=>RenderPrepared;accept: (value: {timelineId: string;snapshotHash: string;failure: AppError|null})=>unknown}

const messages: Readonly<Record<string,string>>=Object.freeze({
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
const issue=(code: string): {code: string;message: string|undefined}=>({code,message:messages[code]});
export function timelineExportCapabilityError(code: string): AppError{return new AppError(code,messages[code]??messages.EXPORT_CAPABILITY_FAILED,409);}

// Own every underlying check, including a non-cooperative injected helper. No
// asynchronous media work ever runs while an admission SQLite transaction is open.
export function createTimelineExportAdmissionServices(store: ExportAdmissionStore,{signal:ownerSignal,inspect=inspectTimelineExportCapability,hash}: {signal?: AbortSignal;inspect?: (delivery: unknown,options: AdmissionInspectOptions)=>Promise<InspectResult|null>;hash?: (value: unknown)=>string}={}){
 const opacity=getOpacityCandidateAssembly(store);
 const opacityDomain=opacity?createOpacityCandidateDomain(store):null;
 const refuseRestoredOperation: RefuseRestoredOperation=(target,operation,input)=>{
  if(opacity){opacity.refuseOperation(operation,input);return;}
  legacyRefuseRestoredOperation(target as never,operation,input);
 };
 const restoreEffectFence=(): ((()=>void)|undefined)=>opacity?opacity.effectFence():legacyRestoreEffectFence(store);
 const active=new Set<ActiveCheck>(),candidateCheckFences=new WeakSet<object>();let stopped=false,shutdownFailure: unknown;
 function assertCandidateCheckFence(fence: unknown): void{
  opacity?.checkpoint();
  if(typeof fence!=='function'||!candidateCheckFences.has(fence))throw new AppError('RESTORE_OPERATION_UNAVAILABLE','This internal candidate operation is unavailable.',409);
  fence();
 }
 async function inspectOwned(delivery: unknown,{signal:callSignal}: AdmissionOptions={},candidateCheckFence?: unknown): Promise<unknown>{
  // Candidate callers can reach this fixed bounded check only from the
  // already authorized render or advisory invocation. The registration never
  // escapes this service, so a caller-supplied callback grants no capability.
  if(opacity)assertCandidateCheckFence(candidateCheckFence);
  else refuseRestoredOperation(store,'timeline.export.capabilities');
  const beforeEffect=opacity?()=>assertCandidateCheckFence(candidateCheckFence):restoreEffectFence();
  const external=ownerSignal&&callSignal&&ownerSignal!==callSignal?AbortSignal.any([ownerSignal,callSignal]):ownerSignal||callSignal;
  checkpoint(external);if(shutdownFailure)throw shutdownFailure;if(stopped)throw new AppError('OPERATION_CANCELLED','Operation interrupted by shutdown',503);
  if(store.db.isTransaction)throw new AppError('EXPORT_CAPABILITY_CONFIGURATION',messages.EXPORT_CAPABILITY_CONFIGURATION,409);
  const controller=new AbortController(),signal=external?AbortSignal.any([external,controller.signal]):controller.signal;
  const entry: ActiveCheck={controller,task:null};active.add(entry);
  const task=Promise.resolve().then(()=>{beforeEffect?.();return inspect(delivery,{signal,beforeEffect,capabilityWorkRoot:store.root});});
  entry.task=task.catch((error: {terminationUnconfirmed?: boolean})=>{if(error.terminationUnconfirmed)shutdownFailure=error;}).finally(()=>active.delete(entry));
  try{
   const value=await awaitProvider(()=>task,signal);checkpoint(signal);beforeEffect?.();
   if(value?.code==='EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED')throw Object.assign(Error(messages.EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED),{code:'MEDIA_TERMINATION_UNCONFIRMED',terminationUnconfirmed:true});
   return timelineExportCapabilityResultSchema.safeParse(value).success?value:{status:'incomplete',code:'EXPORT_CAPABILITY_FAILED'};
  }catch(error){
   const failure=error as {terminationUnconfirmed?: boolean;code?: string};
   if(failure.terminationUnconfirmed){shutdownFailure=error;throw error;}
   if(safeWorkspaceRestoreError(error))throw error;
   checkpoint(signal);if(['OPERATION_CANCELLED','MEDIA_CANCELLED'].includes(failure.code as string))throw error;
   return {status:'incomplete',code:'EXPORT_CAPABILITY_FAILED'};
  }
 }
 function read(input: TimelineRecoveryInput): {timeline: TimelineRecord;delivery: unknown;snapshot?: unknown}|null{
  if(opacityDomain){
   // The candidate domain freezes the same raw opacity and delivery snapshot
   // used by render acceptance, including fixed source and LUT ownership.
   const captured=opacityDomain.readPreflightSnapshot(input);
   return captured.timeline?{timeline:captured.timeline as unknown as TimelineRecord,delivery:captured.snapshot?.delivery??resolveTimelineExportDelivery(captured.timeline,input.exportSettings),snapshot:captured.snapshot}:null;
  }
  const timeline=createTimelineRecoveryBoundary(store.db,input).read();
  return timeline?{timeline:timeline as unknown as TimelineRecord,delivery:resolveTimelineExportDelivery(timeline as never,input.exportSettings) as unknown}:null;
 }
 async function capabilities(input: TimelineRecoveryInput,options: AdmissionOptions={}): Promise<TimelineExportCapabilityReport>{
  refuseRestoredOperation(store,'timeline.export.capabilities',input);
  // Direct service users get the same strict syntax boundary as RPC callers.
  input=opacityDomain?opacityDomain.parse('timeline.export.capabilities',input) as unknown as TimelineRecoveryInput:timelineExportCapabilitySchemas['timeline.export.capabilities'].parse(input) as unknown as TimelineRecoveryInput;
  checkpoint(options.signal);checkpoint(ownerSignal);
  const report: TimelineExportCapabilityReport={projectId:input.projectId,timelineId:null,timelineRevision:null,expectedRevision:input.expectedRevision as number,exportSettings:input.exportSettings,
   delivery:null,checkedAt:new Date().toISOString(),status:'blocked',issues:[]};
  let initial;
  try{initial=read(input);}catch(error){
   const failure=error as {code?: string};
   if(opacity&&(safeWorkspaceRestoreError(error)||failure.code==='RESTORE_STORE_UNVERIFIED'))throw error;
   // The historical capability report has a fixed issue enum. Preserve that
   // contract while letting the candidate UI localize an exact finite render
   // refusal; never forward a source exception's raw message or details.
   if(opacity){
    const fixedMessage=Object.hasOwn(OPACITY_CANDIDATE_PREFLIGHT_MESSAGES,failure.code as string)?(OPACITY_CANDIDATE_PREFLIGHT_MESSAGES as Record<string,string>)[failure.code as string]:
     Object.hasOwn(TIMELINE_COLOUR_PREFLIGHT_MESSAGES,failure.code as string)?(TIMELINE_COLOUR_PREFLIGHT_MESSAGES as Record<string,string>)[failure.code as string]:null;
    if(fixedMessage)throw new AppError(failure.code as string,fixedMessage,409);
   }
   if(failure.code==='NOT_FOUND')throw error;report.issues=[issue(failure.code==='INVALID_TIMELINE_SNAPSHOT'?'INVALID_TIMELINE_SNAPSHOT':'TIMELINE_SOURCE_UNAVAILABLE')];return report;
  }
  if(!initial){report.issues=[issue('TIMELINE_MISSING')];return report;}
  report.timelineId=initial.timeline.id;report.timelineRevision=initial.timeline.revision;report.delivery=initial.delivery;
  if(initial.timeline.revision!==input.expectedRevision){report.status='stale';report.issues=[issue('EXPORT_CAPABILITY_STALE')];return report;}
  const candidateCheckFence=opacity?restoreEffectFence():undefined;
  if(opacity){if(typeof candidateCheckFence!=='function')throw new AppError('RESTORE_OPERATION_UNAVAILABLE','This internal candidate operation is unavailable.',409);candidateCheckFences.add(candidateCheckFence as object);}
  let result: InspectResult|undefined;
  try{result=await inspectOwned(initial.delivery,options,candidateCheckFence) as InspectResult;}
  finally{if(opacity)candidateCheckFences.delete(candidateCheckFence as object);}
  // Re-read ownership and exact geometry/content after the await; a report may
  // never bind a successful check to a replaced owner or a different revision.
  let current;try{current=read(input);}catch(error){const failure=error as {code?: string};if(opacity&&(safeWorkspaceRestoreError(error)||failure.code==='RESTORE_STORE_UNVERIFIED'))throw error;current=null;}
  if(!current||JSON.stringify(current)!==JSON.stringify(initial)){report.status='stale';report.issues=[issue('EXPORT_CAPABILITY_STALE')];return report;}
  report.status=result!.status as string;report.issues=result!.status==='available'?[]:[issue(result!.code as string)];return report;
 }
 async function render(input: TimelineRecoveryInput,options: AdmissionOptions,{prepare,accept}: RenderHooks): Promise<unknown>{
  refuseRestoredOperation(store,'timeline.render',input);
  // prepare replays immutable historical ACKs before current revision, any
  // local compute, or capability availability can affect their result.
  const before=prepare();if(before.replayed)return before.response;
  const candidateRenderFence=opacity?restoreEffectFence():undefined;
  if(opacity){if(typeof candidateRenderFence!=='function')throw new AppError('RESTORE_OPERATION_UNAVAILABLE','This internal candidate operation is unavailable.',409);candidateCheckFences.add(candidateRenderFence as object);}
  try{
   const result=await inspectOwned(before.snapshot!.delivery,options,candidateRenderFence) as InspectResult;
   checkpoint(options?.signal);checkpoint(ownerSignal);
   // accept runs a second exact transaction: receipt replay/dedupe, project and
   // source ownership, CAS, unchanged snapshot, then possible pre-write rejection.
   return accept({timelineId:before.snapshot!.timeline.id,snapshotHash:(hash as (value: unknown)=>string)(before.snapshot),failure:result.status==='available'?null:timelineExportCapabilityError(result.code as string)});
  }finally{if(opacity)candidateCheckFences.delete(candidateRenderFence as object);}
 }
 const stop=(): void=>{stopped=true;for(const entry of active)entry.controller.abort();};
 ownerSignal?.addEventListener('abort',stop,{once:true});if(ownerSignal?.aborted)stop();
 async function drain(): Promise<void>{stop();await boundedShutdown(Promise.allSettled([...active].map(entry=>entry.task)),'EXPORT_CAPABILITY_STOP_TIMEOUT');ownerSignal?.removeEventListener('abort',stop);if(shutdownFailure)throw shutdownFailure;}
 return {handlers:{'timeline.export.capabilities':capabilities},render,inspect:opacity?(delivery: unknown,options: AdmissionOptions)=>inspectOwned(delivery,options):inspectOwned,drain};
}
