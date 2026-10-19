import {EXPORT_LOUDNESS_PROFILE,EXPORT_LOUDNESS_ADVISORY_MARGIN_DB} from '@mioon/contracts/export-loudness';
import {TIMELINE_MIX_LOUDNESS_PROFILE} from '@mioon/contracts/timeline-mix-loudness';

type NullableMeasurement = {
  sampleRate: number; channels: number; sampleFrames: number; decodedDurationSeconds: number; state: string;
  integratedLufs: number | null; samplePeakLinear: number; samplePeakDbfs: number | null;
  truePeakLinear: number; truePeakDbtp: number | null;
  gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number; relativeGateLufs: number | null;
};
interface MixCandidate {
  status: string; reason: string | null; marginDb: number; applyAllowed: boolean;
  requiredGainDb: number | null; gainMultiplier: number | null;
  gains: Array<{clipId: string; assetId: string; beforeGain: number; afterGain: number}>;
  measurement: NullableMeasurement | null; meetsTarget: boolean; meetsTruePeak: boolean;
}
interface MixResult {
  projectId: string; expectedRevision: number; mixProfile: unknown; measurementProfile: unknown;
  target: {integratedLufs: number; truePeakCeilingDbtp: number};
  status: string; checkedAt: string; stage: string; applyAllowed: boolean;
  identity: {timelineId: string; timelineRevision: number; snapshotSha256: string;
    range: {startFrame: number; endFrame: number; sampleFrames: number};
    sources: Array<{assetId: string; sha256: string; sizeBytes: number}>};
  original: NullableMeasurement;
  candidate: MixCandidate;
  checks: {bytesHashed: number; pcmBytes: number; decodeWorkFrames: number; segmentCount: number; passes: number; audioFullyDecoded: boolean};
}
export const mixLoudnessOperation='timeline.loudness.prepare';
export const mixLoudnessToken='synthetic-mix-loudness-test-token';
export const mixLoudnessInput={projectId:'11111111-1111-4111-8111-111111111111',expectedRevision:4,
  mixProfile:TIMELINE_MIX_LOUDNESS_PROFILE,measurementProfile:EXPORT_LOUDNESS_PROFILE,
  target:{integratedLufs:-16,truePeakCeilingDbtp:-1}};
export function readyMixLoudness(input: typeof mixLoudnessInput = mixLoudnessInput): MixResult {
  const original: NullableMeasurement={sampleRate:48000,channels:2,sampleFrames:48000,decodedDurationSeconds:1,state:'valid',
    integratedLufs:-20,samplePeakLinear:0.5,samplePeakDbfs:20*Math.log10(0.5),truePeakLinear:0.6,truePeakDbtp:20*Math.log10(0.6),
    gatingBlockCount:7,absoluteGatedBlockCount:7,relativeGatedBlockCount:7,relativeGateLufs:-30};
  const requiredGainDb=input.target.integratedLufs-original.integratedLufs!,gainMultiplier=10**(requiredGainDb/20);
  const measurement={...original,integratedLufs:input.target.integratedLufs,relativeGateLufs:input.target.integratedLufs-10,
    samplePeakLinear:original.samplePeakLinear*gainMultiplier,samplePeakDbfs:original.samplePeakDbfs!+requiredGainDb,
    truePeakLinear:original.truePeakLinear*gainMultiplier,truePeakDbtp:original.truePeakDbtp!+requiredGainDb};
  const assetId='33333333-3333-4333-8333-333333333333';
  return {...structuredClone(input),status:'ready',checkedAt:'2026-10-14T00:00:00.000Z',stage:'preencode_float_mix',applyAllowed:false,
    identity:{timelineId:'22222222-2222-4222-8222-222222222222',timelineRevision:input.expectedRevision,snapshotSha256:'b'.repeat(64),
      range:{startFrame:0,endFrame:30,sampleFrames:48000},sources:[{assetId,sha256:'a'.repeat(64),sizeBytes:1024}]},original,
    candidate:{status:'measured',reason:null,marginDb:EXPORT_LOUDNESS_ADVISORY_MARGIN_DB,applyAllowed:false,requiredGainDb,gainMultiplier,
      gains:[{clipId:'44444444-4444-4444-8444-444444444444',assetId,beforeGain:1,afterGain:gainMultiplier}],measurement,meetsTarget:true,
      meetsTruePeak:measurement.truePeakDbtp<=input.target.truePeakCeilingDbtp-EXPORT_LOUDNESS_ADVISORY_MARGIN_DB},
    checks:{bytesHashed:2048,pcmBytes:768000,decodeWorkFrames:60,segmentCount:1,passes:2,audioFullyDecoded:true}};
}
export function silentMixLoudness(input: typeof mixLoudnessInput = mixLoudnessInput): MixResult {
  const value=readyMixLoudness(input);
  Object.assign(value.original,{state:'digital_silence',integratedLufs:null,samplePeakLinear:0,samplePeakDbfs:null,
    truePeakLinear:0,truePeakDbtp:null,absoluteGatedBlockCount:0,relativeGatedBlockCount:0,relativeGateLufs:null});
  value.candidate={status:'unavailable',reason:'NO_VALID_LOUDNESS',marginDb:EXPORT_LOUDNESS_ADVISORY_MARGIN_DB,applyAllowed:false,
    requiredGainDb:null,gainMultiplier:null,gains:[],measurement:null,meetsTarget:false,meetsTruePeak:false};
  Object.assign(value.checks,{pcmBytes:384000,decodeWorkFrames:30,passes:1});return value;
}
