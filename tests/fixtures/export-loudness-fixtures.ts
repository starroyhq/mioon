import {EXPORT_LOUDNESS_PROFILE, exportLoudnessReason, exportLoudnessSuggestion} from '@mioon/contracts/export-loudness';
export const loudnessOperation = 'timeline.export.loudness';
export const loudnessInput = {projectId:'11111111-1111-4111-8111-111111111111',exportId:'22222222-2222-4222-8222-222222222222',
  expectedArtifactSha256:'a'.repeat(64),measurementProfile:EXPORT_LOUDNESS_PROFILE};
export const loudnessToken = 'synthetic-export-loudness-test-token';
export const loudnessTarget = {integratedLufs:-16,truePeakCeilingDbtp:-1};
export type ExportLoudnessReasonCode = Parameters<typeof exportLoudnessReason>[0];
export interface LoudnessFixtureInput {readonly projectId: string; readonly exportId: string; readonly expectedArtifactSha256: string; readonly measurementProfile: string; readonly target: {readonly integratedLufs: number; readonly truePeakCeilingDbtp: number}}
export function readyLoudness(input: LoudnessFixtureInput = {...loudnessInput, target: loudnessTarget}) {
  const measurement = {sampleRate:48000 as const,channels:2 as const,sampleFrames:48000,decodedDurationSeconds:1,state:'valid' as const,
    integratedLufs:-20,samplePeakLinear:0.5,samplePeakDbfs:20*Math.log10(0.5),truePeakLinear:0.6,truePeakDbtp:20*Math.log10(0.6),
    gatingBlockCount:7,absoluteGatedBlockCount:7,relativeGatedBlockCount:7,relativeGateLufs:-30};
  return {...input,stage:'decoded-export-file',checkedAt:'2026-10-14T00:00:00.000Z',status:'ready',
    artifact:{assetId:'33333333-3333-4333-8333-333333333333',sha256:input.expectedArtifactSha256,snapshotSha256:'b'.repeat(64),sizeBytes:1024,timelineRevision:4},
    measurement,suggestion:exportLoudnessSuggestion(measurement,input.target),reason:null,checks:{bytesHashed:2048,audioFullyDecoded:true}};
}
export function incompleteLoudness(code: ExportLoudnessReasonCode = 'BUSY', input: Omit<LoudnessFixtureInput,'target'> = loudnessInput) {
  return {...input,stage:'decoded-export-file',checkedAt:'2026-10-14T00:00:00.000Z',status:'incomplete',artifact:null,measurement:null,
    suggestion:null,reason:exportLoudnessReason(code),checks:{bytesHashed:0,audioFullyDecoded:false}};
}
