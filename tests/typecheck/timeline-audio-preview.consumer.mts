import {
  AUDIO_PREVIEW_PROFILE,AUDIO_PREVIEW_LIMITS,audioPreviewSchemas,
  audioPreviewPlanInputSchema,audioPreviewSourceInputSchema,audioPreviewPlanSchema,
  buildAudioPreviewPlan,isAudioPreviewPlan,audioPreviewPlanDigestMaterial,
  deriveTimelineAudioSamples,audioPreviewEnvelopeAtSample,audioPreviewEnvelopeGainAtLocalSample,
} from '@mioon/contracts/timeline-audio-preview';
import type {
  AudioPreviewPlan,AudioPreviewPlanInput,AudioPreviewSourceInput,AudioPreviewSourceDescriptor,
  AudioPreviewVoice,AudioPreviewSnapshot,TimelineAudioSamples,AudioPreviewPlanErrorCode,AudioPreviewDecodeSegment,
} from '@mioon/contracts/timeline-audio-preview';
import {timelineCompositionSegments} from '@mioon/contracts/timeline-segments';
import type {TimelineCompositionSegment} from '@mioon/contracts/timeline-segments';
import {nativeAudioConfigSchema,nativeAudioCommandSchema,nativeAudioProofSchema,nativeAudioProofMaterial} from '@mioon/contracts/native-audio-preview';
import type {NativeAudioOwner,NativeAudioConfig,NativeAudioCommand,NativeAudioProof,NativeAudioPreviewBridge} from '@mioon/contracts/native-audio-preview';
import {createNativeAudioPreviewHost,createNativeAudioPreviewSigningIdentity} from '../../apps/desktop/src/native-audio-preview-host.ts';
import type {NativeAudioDocument,NativeAudioContents} from '../../apps/desktop/src/native-audio-preview-host.ts';
import {createNativeAudioPreviewBroker} from '../../apps/desktop/src/native-audio-preview-broker.ts';
import {createNativeAudioPreviewBridge} from '../../apps/desktop/src/native-audio-preview-preload.ts';
import {createNativeAudioPreviewAuthority} from '@mioon/business/native-audio-preview';

declare const value:unknown;
declare const saved:AudioPreviewSnapshot;
declare const hashText:(text:string)=>string;
const input:AudioPreviewPlanInput={projectId:'project-id',timelineId:'timeline-id',expectedRevision:1,startFrame:0};
const parsed:AudioPreviewPlanInput=audioPreviewPlanInputSchema.parse(input);
const plan:AudioPreviewPlan=buildAudioPreviewPlan(parsed,saved,hashText);
const source:AudioPreviewSourceDescriptor=plan.sources[0]!;
const segment:AudioPreviewDecodeSegment=source.decodeSegments[0]!;
const segments:readonly TimelineCompositionSegment[]=timelineCompositionSegments(saved.timeline);
// Charged original decode frames include one input lookahead frame per segment.
const decodedFrames:number=plan.work.decodedSourceFrames;
const decodeCount:number=plan.work.decodeSegments;
const voice:AudioPreviewVoice=plan.voices[0]!;
const sourceInput:AudioPreviewSourceInput={...parsed,clipId:source.clipId,sourceHash:source.sourceHash,planHash:plan.planHash};
const checkedSource:AudioPreviewSourceInput=audioPreviewSourceInputSchema.parse(sourceInput);
const checkedPlan:AudioPreviewPlan=audioPreviewPlanSchema.parse(plan);
const declared:AudioPreviewPlanInput=audioPreviewSchemas['timeline.audioPreview.plan'].parse(input);
if(isAudioPreviewPlan(value,input)){const narrowed:AudioPreviewPlan=value;void narrowed;}
const material:string=audioPreviewPlanDigestMaterial(plan);
const samples:TimelineAudioSamples=deriveTimelineAudioSamples(voice,voice.intersectionStartFrame);
const scalar:number=audioPreviewEnvelopeAtSample(voice,plan.range.startSample);
const endpoint:number=audioPreviewEnvelopeGainAtLocalSample(voice,samples.durationSamples);
const profile:typeof AUDIO_PREVIEW_PROFILE=plan.profileId;
const budget:number=AUDIO_PREVIEW_LIMITS.memoryBytes;
const code:AudioPreviewPlanErrorCode='AUDIO_PREVIEW_AUDIO_UNKNOWN';
const workLimit:AudioPreviewPlanErrorCode='AUDIO_PREVIEW_BUDGET';
// @ts-expect-error Every source requires its exact original decode segments.
const unsegmented:AudioPreviewSourceDescriptor={sourceKey:source.sourceKey,profileId:source.profileId,clipId:source.clipId,
  assetId:source.assetId,sourceHash:source.sourceHash,sourceInFrame:0,durationFrames:1,sampleFrames:1600,pcmBytes:12800,sourceBytes:1};
// @ts-expect-error Shared composition bounds are readonly.
segments[0]!.beginFrame=1;
// @ts-expect-error Decode segments cannot select a sample rate.
const inventedRate:AudioPreviewDecodeSegment={...segment,sampleRate:44100};
// @ts-expect-error Fixed binary identity cannot accept a caller-selected stream.
const callerStream:AudioPreviewSourceInput={...sourceInput,stream:0};
// @ts-expect-error A prepared preview cannot claim durable export success.
const durableStatus:AudioPreviewPlan['status']='succeeded';
// @ts-expect-error The first profile does not admit a caller-selected sample rate.
const sampleRate:typeof AUDIO_PREVIEW_LIMITS.sampleRate=44100;
void [checkedSource,checkedPlan,declared,material,scalar,endpoint,profile,budget,code,callerStream,durableStatus,sampleRate,
  segment,segments,decodedFrames,decodeCount,workLimit,unsegmented,inventedRate];

declare const nativeOwner:NativeAudioOwner;
declare const nativeDocument:NativeAudioDocument;
declare const nativeContents:NativeAudioContents;
declare const nativeBridge:NativeAudioPreviewBridge;
declare const rawNative:unknown;
const signer=createNativeAudioPreviewSigningIdentity(nativeOwner.backendId);
const publicConfig:NativeAudioConfig=nativeAudioConfigSchema.parse(signer.config);
const nativeProof:NativeAudioProof=nativeAudioProofSchema.parse(rawNative);
const signed:string=signer.sign(nativeProof);
const proofMaterial:string=nativeAudioProofMaterial(nativeProof);
const command:NativeAudioCommand=nativeAudioCommandSchema.parse(rawNative);
const authority=createNativeAudioPreviewAuthority(publicConfig);
const broker=createNativeAudioPreviewBroker({backendId:nativeOwner.backendId,send(value){void value;},isCurrent:()=>true});
const nativeHost=createNativeAudioPreviewHost({backendId:nativeOwner.backendId,origin:'http://127.0.0.1:1234',signer,
  isAdmissionAllowed:()=>true,ownerForContents:contents=>contents===nativeContents?nativeDocument:null,request:value=>broker.request(value)});
const fixedBridge=createNativeAudioPreviewBridge({invoke:async(_channel,request)=>request.action==='describe'?nativeOwner:false,on(){},removeListener(){}});
void authority.command(command);
void nativeHost.dispatch({sender:nativeContents,senderFrame:nativeDocument.frame},{action:'describe'});
const nativeReloadRetired:Promise<boolean>=nativeHost.retireOwnerForReload(nativeDocument,new AbortController().signal);
void nativeReloadRetired;
// @ts-expect-error A window id is not an exact captured main-frame document.
void nativeHost.retireOwnerForReload(nativeOwner.windowId,new AbortController().signal);
// @ts-expect-error Reload observation must be owned by a cancellable native attempt.
void nativeHost.retireOwnerForReload(nativeDocument);
void nativeBridge.acquire(input,plan.planHash,'action-id');
// @ts-expect-error The signer exposes only its public configuration, never its private key.
const exposedPrivateKey=signer.privateKey;
// @ts-expect-error Fixed source signing cannot become a general arbitrary-bytes signing oracle.
signer.sign(new Uint8Array(32));
// @ts-expect-error Source proofs cannot carry arbitrary destination URLs.
const destinationProof:NativeAudioProof={...nativeProof,url:'https://example.invalid'};
// @ts-expect-error Proof sequencing must be an integer number, not an opaque claim.
const textSequence:NativeAudioProof={...nativeProof,sequence:'next'};
// @ts-expect-error Native business ownership requires a window record, not just a project and context.
const unownedNative:NativeAudioOwner={backendId:nativeOwner.backendId,contextId:nativeOwner.contextId,projectId:nativeOwner.projectId};
// @ts-expect-error Main-to-utility commands have no generic business command lane.
broker.request({type:'rpc',operation:'timeline.render',input});
// @ts-expect-error The renderer cannot supply its own admitted memory total.
nativeBridge.acquire({...input,admittedBytes:1},plan.planHash,'action-id');
// @ts-expect-error The fixed prepare bridge cannot accept filesystem paths or URLs.
fixedBridge.acquire({...input,path:'/tmp/source.wav'},plan.planHash,'action-id');
type NativeIsAny<T>=0 extends(1&T)?true:false;
type NativeAssert<T extends true>=T;
export type CheckedNativeProof=NativeAssert<NativeIsAny<NativeAudioProof> extends false?true:false>;
export type CheckedNativeHost=NativeAssert<NativeIsAny<ReturnType<typeof createNativeAudioPreviewHost>> extends false?true:false>;
export type CheckedNativeDispatch=NativeAssert<NativeIsAny<Awaited<ReturnType<typeof nativeHost.dispatch>>> extends false?true:false>;
export type CheckedNativeAuthority=NativeAssert<NativeIsAny<ReturnType<typeof createNativeAudioPreviewAuthority>> extends false?true:false>;
export type CheckedNativeBridge=NativeAssert<NativeIsAny<ReturnType<typeof createNativeAudioPreviewBridge>> extends false?true:false>;
void [signed,proofMaterial,exposedPrivateKey,destinationProof,textSequence,unownedNative];
