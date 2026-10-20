import {validateWorkspaceSchema50} from './workspace-schema-v50.ts';
import {validateWorkspaceRestoreSchemaV51} from './workspace-restore-schema-v51.ts';
import {validateWorkspaceSchema48} from './workspace-schema-v48.ts';
import {validateWorkspaceRestoreSchemaV49} from './workspace-restore-schema-v49.ts';
import {requireWorkspaceEnvelopeRuntime} from './workspace-envelope-runtime.ts';
import {readCurrentWorkspaceRole} from './workspace-schema-dispatch.ts';
import type {DatabaseSync} from 'node:sqlite';
import {isProxy} from 'node:util/types';
import {AppError} from '../../contracts/src/app-error.ts';
import {validateWorkspaceSchema40} from './workspace-schema-v40.ts';
import {validateWorkspaceSchema44} from './workspace-schema-v44.ts';
import {validateWorkspaceRestoreSchemaV45} from './workspace-restore-schema-v45.ts';
import {validateVolumeEnvelope} from '../../contracts/src/timeline-volume-envelope.ts';

export const TIMELINE_VOLUME_ENVELOPE_REJECTION_CODES=Object.freeze([
 'TIMELINE_VOLUME_ENVELOPE_INVALID','TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED',
 'TIMELINE_VOLUME_ENVELOPE_LIMIT','TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED',
]);
export function volumeEnvelopeMutationError(code:string,details:Record<string,unknown>={}){
 return new AppError(code,code==='TIMELINE_VOLUME_ENVELOPE_LIMIT'?'时间线音量包络超过完整记录保存上限。':'时间线音量包络不能安全应用。',409,details);
}
// Descriptor-only detection: the ingress layer owns shape validation. Never
// execute an untrusted accessor or proxy merely to decide workspace authority.
export function hasTimelineVolumeEnvelope(value:unknown):boolean{
 const pending:unknown[]=[value],seen=new Set<object>();
 while(pending.length){const item=pending.pop();if(!item||typeof item!=='object'||isProxy(item)||seen.has(item))continue;seen.add(item);
  for(const key of Reflect.ownKeys(item)){if(key==='volumeEnvelope'||key==='volumeEnvelopeProfile'||key==='volumeEnvelopeProcessingProfile')return true;
   const descriptor=Object.getOwnPropertyDescriptor(item,key);if(descriptor&&Object.hasOwn(descriptor,'value'))pending.push(descriptor.value);
  }
 }
 return false;
}
/** Profile compatibility only, never execution authority. Reads and captured
 * evidence also use this guard. Restored mutations remain gated independently
 * by the existing owned-store, pinned invocation, origin and vacancy checks. */
export function assertTimelineVolumeEnvelopeWorkspace(db:DatabaseSync,value:unknown):void{
 if(!hasTimelineVolumeEnvelope(value))return;
 try{
  const runtime=requireWorkspaceEnvelopeRuntime();
  const role=readCurrentWorkspaceRole(db);
  if(role==='ordinary-50')validateWorkspaceSchema50(db);
  else if(role==='restored-51-evidence')validateWorkspaceRestoreSchemaV51(db);
  else if(role==='ordinary-48')validateWorkspaceSchema48(db);
  else if(role==='restored-49-evidence')validateWorkspaceRestoreSchemaV49(db);
  else if(role==='ordinary-44')validateWorkspaceSchema44(db);
  else if(role==='restored-45-evidence')validateWorkspaceRestoreSchemaV45(db);
  else if(role==='restored-41-evidence')runtime.validateRestored41(db);
  else validateWorkspaceSchema40(db,{verifyBytes:false});
 }
 catch{throw volumeEnvelopeMutationError('TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED');}
}
export function validateTimelineVolumeEnvelopeClip(clip:{durationFrames:number;volumeEnvelope?:unknown},source:{mimeType?:string;hasAudio?:boolean}):void{
 if(!Object.hasOwn(clip,'volumeEnvelope'))return;
 try{validateVolumeEnvelope(clip.volumeEnvelope,clip.durationFrames);}
 catch{throw volumeEnvelopeMutationError('TIMELINE_VOLUME_ENVELOPE_INVALID');}
 if(clip.volumeEnvelope!==null&&(source.mimeType?.startsWith('image/')||source.hasAudio!==true))
  throw volumeEnvelopeMutationError('TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED');
}
/** Full candidates, not field estimates. The caller supplies finalized revision
 * and timestamps and the exact response wrapper before its first write. */
export function admitTimelineVolumeEnvelopeWrite(timeline:unknown,{before,after,response=timeline,related}:{before?:unknown;after?:unknown;response?:unknown;related?:unknown}={}):void{
 if(!hasTimelineVolumeEnvelope(timeline)&&!hasTimelineVolumeEnvelope(before)&&!hasTimelineVolumeEnvelope(related))return;
 for(const [record,value]of Object.entries({timeline,before,after,response})){
  if(value===undefined)continue;
  const actualBytes=Buffer.byteLength(JSON.stringify(value),'utf8'),maxBytes=262144;
  if(actualBytes>maxBytes)throw volumeEnvelopeMutationError('TIMELINE_VOLUME_ENVELOPE_LIMIT',{record,maxBytes,actualBytes});
 }
}
