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
