import {clipLoudnessInput, readyClipLoudness} from './timeline-clip-loudness-fixtures.ts';
import {EXPORT_LOUDNESS_ADVISORY_MARGIN_DB} from '@mioon/contracts/export-loudness';
export const matchInput = {...clipLoudnessInput, target: {integratedLufs: -23, truePeakCeilingDbtp: -1}};
/** Valid deterministic transport data; real DSP is exercised separately. */
export function matchedClipLoudness(input = matchInput) {
  const report = readyClipLoudness(input), requiredGainDb = input.target.integratedLufs - report.measurement.integratedLufs;
  const gainMultiplier = 10 ** (requiredGainDb / 20);
  const measurement = {...report.measurement, integratedLufs: input.target.integratedLufs,
    samplePeakLinear: Math.fround(report.measurement.samplePeakLinear * gainMultiplier),
    samplePeakDbfs: 20 * Math.log10(Math.fround(report.measurement.samplePeakLinear * gainMultiplier)),
    truePeakLinear: report.measurement.truePeakLinear * gainMultiplier,
    truePeakDbtp: report.measurement.truePeakDbtp + requiredGainDb,
    relativeGateLufs: report.measurement.relativeGateLufs + requiredGainDb};
  return {...report, target: input.target, candidate: {status: 'measured' as const, reason: null,
    requiredGainDb, gainMultiplier, beforeGain: report.identity.gain, afterGain: report.identity.gain * gainMultiplier,
    measurement, measuredPcmBytes: report.checks.pcmBytes,
    meetsTarget: true, meetsTruePeak: measurement.truePeakDbtp <= input.target.truePeakCeilingDbtp - EXPORT_LOUDNESS_ADVISORY_MARGIN_DB,
    marginDb: EXPORT_LOUDNESS_ADVISORY_MARGIN_DB, applyAllowed: false as const}};
}
