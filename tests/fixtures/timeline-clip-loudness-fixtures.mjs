import {EXPORT_LOUDNESS_PROFILE} from '@mioon/contracts/export-loudness';
export const clipLoudnessOperation = 'timeline.clip.loudness';
export const clipLoudnessToken = 'synthetic-clip-loudness-test-token';
export const clipLoudnessInput = {projectId: '11111111-1111-4111-8111-111111111111', timelineId: '22222222-2222-4222-8222-222222222222',
  expectedRevision: 4, clipId: '44444444-4444-4444-8444-444444444444', expectedAssetSha256: 'a'.repeat(64), measurementProfile: EXPORT_LOUDNESS_PROFILE};
export function readyClipLoudness(input = clipLoudnessInput) {
  return {...input, status: 'ready', checkedAt: '2026-10-15T00:00:00.000Z', applyAllowed: false,
    processingProfile: 'timeline-isolated-clip-float-v1', stage: 'isolated_clip_post_gain_fades_pre_mix',
    identity: {snapshotSha256: 'b'.repeat(64), trackId: '55555555-5555-4555-8555-555555555555', assetId: '33333333-3333-4333-8333-333333333333',
      assetSha256: input.expectedAssetSha256, sourceBytes: 1024, startFrame: 17, durationFrames: 30, sourceInFrame: 6,
      gain: .75, fadeInFrames: 3, fadeOutFrames: 4, trackMuted: false, measurementStartFrame: 0, measurementEndFrame: 30},
    measurement: {sampleRate: 48000, channels: 2, sampleFrames: 48000, decodedDurationSeconds: 1, state: 'valid',
      integratedLufs: -20, samplePeakLinear: .5, samplePeakDbfs: 20 * Math.log10(.5), truePeakLinear: .6, truePeakDbtp: 20 * Math.log10(.6),
      gatingBlockCount: 7, absoluteGatedBlockCount: 7, relativeGatedBlockCount: 7, relativeGateLufs: -30},
    checks: {bytesHashed: 2048, pcmBytes: 384000, decodeWorkFrames: 31, segmentCount: 1, passes: 1, audioFullyDecoded: true}};
}
export function silentClipLoudness(input = clipLoudnessInput) {
  const value = readyClipLoudness(input);
  Object.assign(value.measurement, {state: 'digital_silence', integratedLufs: null, samplePeakLinear: 0, samplePeakDbfs: null,
    truePeakLinear: 0, truePeakDbtp: null, absoluteGatedBlockCount: 0, relativeGatedBlockCount: 0, relativeGateLufs: null}); return value;
}
