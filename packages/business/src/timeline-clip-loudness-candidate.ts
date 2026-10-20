import {setImmediate as nextTurn} from 'node:timers/promises';
import {EXPORT_LOUDNESS_ADVISORY_MARGIN_DB, exportLoudnessMeasurementSchema} from '@mioon/contracts/export-loudness';
import type {ExportLoudnessMeasurement, ExportLoudnessTarget} from '@mioon/contracts/export-loudness';
import type {TimelineClipLoudnessResponse} from '@mioon/contracts/timeline-clip-loudness';
import {TIMELINE_CLIP_LOUDNESS_LIMITS, TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU} from '@mioon/contracts/timeline-clip-loudness';
import {createExportLoudnessAccumulator} from './export-loudness-meter.ts';

type Candidate = NonNullable<TimelineClipLoudnessResponse['candidate']>;
const invalidPcm = (): never => {throw Object.assign(new Error('The complete selected clip candidate could not be measured.'), {code: 'LOUDNESS_INVALID_PCM'});};

/** The selected clip is linear through its saved gain, fades and envelope. A
 * constant multiplier on its isolated, unclipped float signal is therefore the
 * candidate signal. Unlike a loudness arithmetic prediction, this feeds every
 * scaled sample through fresh gates, K-weighting and true-peak FIR state.
 *
 * The caller exclusively owns this bounded PCM buffer. Reuse it in place only
 * after the original meter has finished; no source or timeline row is changed.
 */
export async function prepareTimelineClipLoudnessCandidate({pcm, original, target, beforeGain, fence}: {
  pcm: Buffer; original: ExportLoudnessMeasurement; target: ExportLoudnessTarget;
  beforeGain: number; fence: () => void;
}): Promise<Candidate> {
  fence();
  if (!Buffer.isBuffer(pcm) || pcm.length !== original.sampleFrames * 8 || pcm.length > TIMELINE_CLIP_LOUDNESS_LIMITS.pcmBytes)
    return invalidPcm();
  const common = {beforeGain, marginDb: EXPORT_LOUDNESS_ADVISORY_MARGIN_DB, applyAllowed: false} as const;
  if (original.state !== 'valid' || original.integratedLufs === null)
    return {...common, status: 'unavailable', reason: 'NO_VALID_LOUDNESS', requiredGainDb: null, gainMultiplier: null,
      afterGain: null, measurement: null, meetsTarget: false, meetsTruePeak: false, measuredPcmBytes: 0};
  const requiredGainDb = target.integratedLufs - original.integratedLufs;
  const gainMultiplier = 10 ** (requiredGainDb / 20), afterGain = beforeGain * gainMultiplier;
  if (!Number.isFinite(gainMultiplier) || gainMultiplier <= 0 || !Number.isFinite(afterGain) || afterGain <= 0 || afterGain > 2)
    return {...common, status: 'unavailable', reason: 'GAIN_OUT_OF_RANGE', requiredGainDb, gainMultiplier,
      afterGain: null, measurement: null, meetsTarget: false, meetsTruePeak: false, measuredPcmBytes: 0};
  const meter = createExportLoudnessAccumulator(original.decodedDurationSeconds);
  // Small aligned slices bound synchronous work and let cancellation/owner-loss
  // run between slices. They are views of the single retained buffer, not more
  // full-clip copies; amplitudes above full scale remain float, never clamped.
  for (let start = 0; start < pcm.length; start += 65536) {
    fence();
    const end = Math.min(start + 65536, pcm.length);
    for (let offset = start; offset < end; offset += 4) pcm.writeFloatLE(pcm.readFloatLE(offset) * gainMultiplier, offset);
    meter.write(pcm.subarray(start, end));
    await nextTurn();
    fence();
  }
  const parsed = exportLoudnessMeasurementSchema.safeParse(meter.finish());
  if (!parsed.success || parsed.data.sampleFrames !== original.sampleFrames) return invalidPcm();
  fence();
  const measurement = parsed.data;
  return {...common, status: 'measured', reason: null, requiredGainDb, gainMultiplier, afterGain, measurement,
    meetsTarget: measurement.state === 'valid' && measurement.integratedLufs !== null &&
      Math.abs(measurement.integratedLufs - target.integratedLufs) <= TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU,
    meetsTruePeak: measurement.truePeakDbtp !== null && measurement.truePeakDbtp <= target.truePeakCeilingDbtp - EXPORT_LOUDNESS_ADVISORY_MARGIN_DB,
    measuredPcmBytes: pcm.length};
}
