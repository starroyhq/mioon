import {assertProjectStore} from './store-runtime.ts';
import {AppError,timelineExportCapabilityResultSchema,resolveTimelineExportDelivery,timelineExportCapabilitySchemas} from '@mioon/contracts';
import {createTimelineRecoveryBoundary} from './timeline-recovery.ts';
import {createFormat5ExportTicket,format5ExportBlockersFromTimeline,recheckFormat5ExportTicket} from './format5-timeline-export.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {timelineStorageFormat,timelineStorageSchema} from './project-file/timeline-storage.ts';
import {isSequenceProjectFormat} from './project-file/schema/databases.ts';
import {inspectTimelineExportCapability} from './timeline-export-capabilities.ts';
import {checkpoint,awaitProvider,boundedShutdown} from './operation-lifecycle.ts';
import {isProjectStore} from './project-file/store.ts';
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
 PLACEHOLDER_CLIP:'The export range contains a placeholder segment. Generate it or split/remove it before exporting.',
 VERSION_TOO_SHORT:'A following segment selects a version shorter than its cut. Select or lock a usable version before exporting.',
});
const issue=(code: string): {code: string;message: string|undefined}=>({code,message:messages[code]});
export function timelineExportCapabilityError(code: string): AppError{return new AppError(code,messages[code]??messages.EXPORT_CAPABILITY_FAILED,409);}

// Own every underlying check, including a non-cooperative injected helper. No
// asynchronous media work ever runs while an admission SQLite transaction is open.
export function createTimelineExportAdmissionServices(store: ExportAdmissionStore,{signal:ownerSignal,inspect=inspectTimelineExportCapability,hash}: {signal?: AbortSignal;inspect?: (delivery: unknown,options: AdmissionInspectOptions)=>Promise<InspectResult|null>;hash?: (value: unknown)=>string}={}){
 assertProjectStore(store);
 const active=new Set<ActiveCheck>();let stopped=false,shutdownFailure: unknown;
 async function inspectOwned(delivery: unknown,{signal:callSignal}: AdmissionOptions={}): Promise<unknown>{
  assertProjectStore(store);
  let settled=false;
  const beforeEffect=()=>{
   if(settled||stopped)throw new AppError('OPERATION_CANCELLED','Export capability observation has ended',503);
   checkpoint(signal);assertProjectStore(store);
  };
  const external=ownerSignal&&callSignal&&ownerSignal!==callSignal?AbortSignal.any([ownerSignal,callSignal]):ownerSignal||callSignal;
  checkpoint(external);if(shutdownFailure)throw shutdownFailure;if(stopped)throw new AppError('OPERATION_CANCELLED','Operation interrupted by shutdown',503);
  if(store.db.isTransaction)throw new AppError('EXPORT_CAPABILITY_CONFIGURATION',messages.EXPORT_CAPABILITY_CONFIGURATION,409);
  const controller=new AbortController(),signal=external?AbortSignal.any([external,controller.signal]):controller.signal;
  const entry: ActiveCheck={controller,task:null};active.add(entry);
  const task=Promise.resolve().then(()=>{beforeEffect?.();return inspect(delivery,{signal,beforeEffect,capabilityWorkRoot:store.tempDir});});
  entry.task=task.catch((error: {terminationUnconfirmed?: boolean})=>{if(error.terminationUnconfirmed)shutdownFailure=error;}).finally(()=>active.delete(entry));
  try{
   const value=await awaitProvider(()=>task,signal);checkpoint(signal);beforeEffect?.();
   if(value?.code==='EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED')throw Object.assign(Error(messages.EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED),{code:'MEDIA_TERMINATION_UNCONFIRMED',terminationUnconfirmed:true});
   return timelineExportCapabilityResultSchema.safeParse(value).success?value:{status:'incomplete',code:'EXPORT_CAPABILITY_FAILED'};
  }catch(error){
   const failure=error as {terminationUnconfirmed?: boolean;code?: string};
   if(failure.terminationUnconfirmed){shutdownFailure=error;throw error;}
   if((error as {code?:unknown})?.code==='PROJECT_STORE_UNVERIFIED')throw error;
   checkpoint(signal);if(['OPERATION_CANCELLED','MEDIA_CANCELLED'].includes(failure.code as string))throw error;
   return {status:'incomplete',code:'EXPORT_CAPABILITY_FAILED'};
  }finally{settled=true;}
 }
 function read(input: TimelineRecoveryInput): {timeline: TimelineRecord;delivery: unknown}|null{
  const timeline=createTimelineRecoveryBoundary(store.db,input).read();
  return timeline?{timeline:timeline as unknown as TimelineRecord,delivery:resolveTimelineExportDelivery(timeline as never,input.exportSettings) as unknown}:null;
 }
 async function format5Capabilities(input: TimelineRecoveryInput,options: AdmissionOptions,
  report: TimelineExportCapabilityReport): Promise<TimelineExportCapabilityReport>{
  const range=input.exportRange!==null&&typeof input.exportRange==='object'&&!Array.isArray(input.exportRange)
   ?{startFrame:Number((input.exportRange as Record<string,unknown>).startFrame),endFrame:Number((input.exportRange as Record<string,unknown>).endFrame)}:null;
  const ticket=createFormat5ExportTicket(store as never,range);
  const timeline=readFormat5TimelineRecord(store.db,'project');
  report.timelineId=ticket.timelineId;report.timelineRevision=ticket.timelineRevision;
  report.delivery=timeline?resolveTimelineExportDelivery(timeline as never,input.exportSettings):null;
  if(ticket.timelineRevision!==input.expectedRevision){report.status='stale';report.issues=[issue('EXPORT_CAPABILITY_STALE')];return report;}
  if(ticket.blockers.length){report.status='blocked';report.issues=[issue(ticket.blockers[0]!.code as string)];return report;}
  const result=await inspectOwned(report.delivery,options) as InspectResult;
  const recheck=recheckFormat5ExportTicket(store as never,ticket);
  if(!recheck.ok){report.status='stale';report.issues=[issue('EXPORT_CAPABILITY_STALE')];return report;}
  report.status=result.status as string;report.issues=result.status==='available'?[]:[issue(result.code as string)];return report;
 }
 async function capabilities(input: TimelineRecoveryInput,options: AdmissionOptions={}): Promise<TimelineExportCapabilityReport>{
  assertProjectStore(store);
  // Direct service users get the same strict syntax boundary as RPC callers.
  input=timelineExportCapabilitySchemas['timeline.export.capabilities'].parse(input) as unknown as TimelineRecoveryInput;
  checkpoint(options.signal);checkpoint(ownerSignal);
  const report: TimelineExportCapabilityReport={projectId:input.projectId,timelineId:null,timelineRevision:null,expectedRevision:input.expectedRevision as number,exportSettings:input.exportSettings,
   delivery:null,checkedAt:new Date().toISOString(),status:'blocked',issues:[]};
  if(isSequenceProjectFormat(timelineStorageFormat(store.db,timelineStorageSchema(store.db))))
   return format5Capabilities(input,options,report);
  let initial;
  try{initial=read(input);}catch(error){
   const failure=error as {code?: string};
   // The historical capability report has a fixed issue enum; never forward
   // a source exception's raw message or details.
   if(failure.code==='NOT_FOUND')throw error;report.issues=[issue(failure.code==='INVALID_TIMELINE_SNAPSHOT'?'INVALID_TIMELINE_SNAPSHOT':'TIMELINE_SOURCE_UNAVAILABLE')];return report;
  }
  if(!initial){report.issues=[issue('TIMELINE_MISSING')];return report;}
  report.timelineId=initial.timeline.id;report.timelineRevision=initial.timeline.revision;report.delivery=initial.delivery;
  if(initial.timeline.revision!==input.expectedRevision){report.status='stale';report.issues=[issue('EXPORT_CAPABILITY_STALE')];return report;}
  if(isSequenceProjectFormat(timelineStorageFormat(store.db,timelineStorageSchema(store.db)))){
   const exportedRange=input.exportRange!==null&&typeof input.exportRange==='object'&&!Array.isArray(input.exportRange)
    ?{startFrame:Number((input.exportRange as Record<string,unknown>).startFrame),endFrame:Number((input.exportRange as Record<string,unknown>).endFrame)}:null;
   const blocker=format5ExportBlockersFromTimeline(store.db,initial.timeline as never,exportedRange)[0];
   if(blocker){report.status='blocked';report.issues=[issue(blocker.code)];return report;}
  }
  const result=await inspectOwned(initial.delivery,options) as InspectResult;
  // Re-read ownership and exact geometry/content after the await; a report may
  // never bind a successful check to a replaced owner or a different revision.
  let current;try{current=read(input);}catch{current=null;}
  if(!current||JSON.stringify(current)!==JSON.stringify(initial)){report.status='stale';report.issues=[issue('EXPORT_CAPABILITY_STALE')];return report;}
  report.status=result.status as string;report.issues=result.status==='available'?[]:[issue(result.code as string)];return report;
 }
 async function render(input: TimelineRecoveryInput,options: AdmissionOptions,{prepare,accept}: RenderHooks): Promise<unknown>{
  assertProjectStore(store);
  // prepare replays immutable historical ACKs before current revision, any
  // local compute, or capability availability can affect their result.
  const before=prepare();if(before.replayed)return before.response;
  const format5Ticket=isSequenceProjectFormat(timelineStorageFormat(store.db,timelineStorageSchema(store.db)))
    ?createFormat5ExportTicket(store as never):null;
  const result=await inspectOwned(before.snapshot!.delivery,options) as InspectResult;
  checkpoint(options?.signal);checkpoint(ownerSignal);
  const ticketCheck=format5Ticket?recheckFormat5ExportTicket(store as never,format5Ticket):null;
  const stale=Boolean(format5Ticket&&ticketCheck&&!ticketCheck.ok);
  if(format5Ticket&&format5Ticket.blockers.length)return accept({timelineId:before.snapshot!.timeline.id,
    snapshotHash:(hash as (value: unknown)=>string)(before.snapshot),failure:timelineExportCapabilityError(format5Ticket.blockers[0]!.code as string)});
  if(stale)return accept({timelineId:before.snapshot!.timeline.id,
    snapshotHash:(hash as (value: unknown)=>string)(before.snapshot),failure:timelineExportCapabilityError('EXPORT_CAPABILITY_STALE')});
  // accept runs a second exact transaction: receipt replay/dedupe, project and
  // source ownership, CAS, unchanged snapshot, then possible pre-write rejection.
  return accept({timelineId:before.snapshot!.timeline.id,snapshotHash:(hash as (value: unknown)=>string)(before.snapshot),failure:result.status==='available'?null:timelineExportCapabilityError(result.code as string)});
 }
 const stop=(): void=>{stopped=true;for(const entry of active)entry.controller.abort();};
 ownerSignal?.addEventListener('abort',stop,{once:true});if(ownerSignal?.aborted)stop();
 async function drain(): Promise<void>{stop();await boundedShutdown(Promise.allSettled([...active].map(entry=>entry.task)),'EXPORT_CAPABILITY_STOP_TIMEOUT');ownerSignal?.removeEventListener('abort',stop);if(shutdownFailure)throw shutdownFailure;}
 return {handlers:{'timeline.export.capabilities':capabilities},render,inspect:inspectOwned,drain};
}
