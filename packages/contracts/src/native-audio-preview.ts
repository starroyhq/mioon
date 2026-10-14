import {z} from 'zod';
import {audioPreviewPlanInputSchema, audioPreviewSourceInputSchema, AUDIO_PREVIEW_LIMITS} from './timeline-audio-preview.ts';

/** Fixed native audition ownership metadata. No business operation, credential,
 * path, arbitrary URL, PCM or renderer-declared byte budget crosses this lane. */
export const NATIVE_AUDIO_VERSION = 1 as const;
export const NATIVE_AUDIO_PCM_PATH = '/api/timeline-audio-preview/pcm';
export const NATIVE_AUDIO_LEASE_HEADER = 'X-Mioon-Audio-Lease';
export const NATIVE_AUDIO_PROOF_HEADER = 'X-Mioon-Audio-Proof';
export const NATIVE_AUDIO_SIGNATURE_HEADER = 'X-Mioon-Audio-Signature';
const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeAudioOwnerSchema = z.object({backendId:id,windowId:id,contextId:id,projectId:id}).strict();
export type NativeAudioOwner = z.infer<typeof nativeAudioOwnerSchema>;
export const nativeAudioConfigSchema = z.object({version:z.literal(1),backendId:id,
  // Ed25519 SubjectPublicKeyInfo: fixed algorithm prefix plus a 32-byte PUBLIC key.
  publicKey:z.string().regex(/^302a300506032b6570032100[a-f0-9]{64}$/u)}).strict();
export type NativeAudioConfig = z.infer<typeof nativeAudioConfigSchema>;
const identity = {owner:nativeAudioOwnerSchema,actionId:id,leaseId:id};
export const nativeAudioLeaseSchema = z.object({...identity,input:audioPreviewPlanInputSchema,planHash:digest,
  admittedBytes:z.number().int().min(AUDIO_PREVIEW_LIMITS.transportReserveBytes).max(AUDIO_PREVIEW_LIMITS.memoryBytes)}).strict();
export type NativeAudioLease = z.infer<typeof nativeAudioLeaseSchema>;
export const nativeAudioCommandSchema = z.discriminatedUnion('type',[
  z.object({type:z.literal('native-audio:reserve'),version:z.literal(1),requestId:id,...identity,
    input:audioPreviewPlanInputSchema,planHash:digest}).strict(),
  z.object({type:z.literal('native-audio:retire'),version:z.literal(1),requestId:id,...identity}).strict(),
]);
export type NativeAudioCommand = z.infer<typeof nativeAudioCommandSchema>;
export const nativeAudioReplySchema = z.discriminatedUnion('status',[
  z.object({type:z.literal('native-audio:reply'),version:z.literal(1),requestId:id,backendId:id,leaseId:id,
    status:z.literal('reserved'),planHash:digest,admittedBytes:z.number().int().min(AUDIO_PREVIEW_LIMITS.transportReserveBytes).max(AUDIO_PREVIEW_LIMITS.memoryBytes)}).strict(),
  z.object({type:z.literal('native-audio:reply'),version:z.literal(1),requestId:id,backendId:id,leaseId:id,
    status:z.enum(['retired','blocked','rejected']),code:z.enum(['NONE','INVALID','BUSY','STALE','UNAVAILABLE','CLEANUP_UNCONFIRMED'])}).strict(),
]);
export type NativeAudioReply = z.infer<typeof nativeAudioReplySchema>;
export const nativeAudioProofSchema = z.object({version:z.literal(1),backendId:id,leaseId:id,
  sequence:z.number().int().min(1).max(AUDIO_PREVIEW_LIMITS.clips),input:audioPreviewSourceInputSchema}).strict();
export type NativeAudioProof = z.infer<typeof nativeAudioProofSchema>;
export function nativeAudioSourceQuery(input:z.infer<typeof audioPreviewSourceInputSchema>):string {
  return new URLSearchParams({projectId:input.projectId,timelineId:input.timelineId,expectedRevision:String(input.expectedRevision),
    startFrame:String(input.startFrame),clipId:input.clipId,sourceHash:input.sourceHash,planHash:input.planHash}).toString();
}
export function nativeAudioProofMaterial(proof:NativeAudioProof):string {
  const {input}=proof;
  return JSON.stringify(['mioon-native-audio-pcm-v1','GET',NATIVE_AUDIO_PCM_PATH,proof.backendId,proof.leaseId,proof.sequence,
    input.projectId,input.timelineId,input.expectedRevision,input.startFrame,input.clipId,input.sourceHash,input.planHash]);
}
export function sameNativeAudioOwner(a:NativeAudioOwner,b:NativeAudioOwner):boolean {
  return a.backendId===b.backendId&&a.windowId===b.windowId&&a.contextId===b.contextId&&a.projectId===b.projectId;
}
export const NATIVE_AUDIO_CHANNEL='mioon:native-audio-preview:v1';
export const NATIVE_AUDIO_EVENT='mioon:native-audio-preview:event:v1';
export const nativeAudioRequestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('describe')}).strict(),
  z.object({action:z.literal('acquire'),contextId:id,actionId:id,input:audioPreviewPlanInputSchema,planHash:digest}).strict(),
  z.object({action:z.literal('cancel'),contextId:id,actionId:id}).strict(),
  z.object({action:z.literal('retired'),contextId:id,actionId:id,leaseId:id,status:z.enum(['retired','unconfirmed'])}).strict(),
]);
export type NativeAudioRequest=z.infer<typeof nativeAudioRequestSchema>;
export const nativeAudioAcquireResultSchema=z.discriminatedUnion('status',[
  z.object({status:z.literal('granted'),lease:nativeAudioLeaseSchema}).strict(),
  z.object({status:z.enum(['cancelled','blocked','unavailable','busy'])}).strict(),
]);
export type NativeAudioAcquireResult=z.infer<typeof nativeAudioAcquireResultSchema>;
export const nativeAudioEventSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('revoke'),lease:nativeAudioLeaseSchema,reason:z.enum(['handoff','release','owner-change','shutdown'])}).strict(),
  z.object({type:z.literal('waiting'),owner:nativeAudioOwnerSchema,actionId:id,waitingForWindowId:id}).strict(),
  z.object({type:z.literal('blocked'),owner:nativeAudioOwnerSchema,actionId:id}).strict(),
]);
export type NativeAudioEvent=z.infer<typeof nativeAudioEventSchema>;
export interface NativeAudioPreviewBridge {
  context():Promise<NativeAudioOwner|null>;
  acquire(input:z.infer<typeof audioPreviewPlanInputSchema>,planHash:string,actionId:string):Promise<NativeAudioAcquireResult>;
  cancel(actionId:string):Promise<boolean>;
  retired(lease:NativeAudioLease,status:'retired'|'unconfirmed'):Promise<boolean>;
  subscribe(listener:(event:NativeAudioEvent)=>void):()=>void;
}
