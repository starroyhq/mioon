import {LOUDNESS_RANGE_LIMITS, LOUDNESS_RANGE_PROFILE,
  type LoudnessRangeMeasurement} from '@mioon/contracts/loudness-range';

const FRAME_BYTES = 8;
const HOPS_PER_WINDOW = LOUDNESS_RANGE_LIMITS.windowFrames / LOUDNESS_RANGE_LIMITS.hopFrames;
const ABSOLUTE_GATE_ENERGY = 10 ** ((-70 + 0.691) / 10);
type MeterErrorCode = 'LOUDNESS_INVALID_PCM' | 'LOUDNESS_DURATION_MISMATCH' |
  'LOUDNESS_RESOURCE_LIMIT' | 'LOUDNESS_DURATION_LIMIT';
export type LoudnessRangeMeterError = Error & {readonly code: MeterErrorCode};
function failure(code: MeterErrorCode): LoudnessRangeMeterError {
  return Object.assign(new Error('The clip loudness range measurement could not be completed.'), {code});
}

// ITU-R BS.1770-5 Annex 1, Tables 1/2, fixed 48kHz coefficients. This
// isolated reducer does not alter the existing persisted loudness profile.
class KWeighting {
  private shelf1 = 0;
  private shelf2 = 0;
  private highpass1 = 0;
  private highpass2 = 0;
  process(sample: number): number {
    const shelf = 1.53512485958697 * sample + this.shelf1;
    this.shelf1 = -2.69169618940638 * sample + 1.69065929318241 * shelf + this.shelf2;
    this.shelf2 = 1.19839281085285 * sample - 0.73248077421585 * shelf;
    const weighted = shelf + this.highpass1;
    this.highpass1 = -2 * shelf + 1.99004745483398 * weighted + this.highpass2;
    this.highpass2 = shelf - 0.99007225036621 * weighted;
    return weighted;
  }
}
const loudness = (energy: number): number => -0.691 + 10 * Math.log10(energy);

/** EBU Tech3342 (2023) §3.1/§5 gate and percentile algorithm, using complete
 * three-second in-file windows at 100ms hops. The separate profile makes
 * this boundary explicit: no start/end zero padding is manufactured, so
 * inputs shorter than three seconds have no LRA result. This is not a
 * certification of an EBU-mode meter; §5 recommends trailing silence for
 * file measurements, which is intentionally not added to a selected clip.
 * https://tech.ebu.ch/files/live/sites/tech/files/shared/tech/tech3342.pdf
 *
 * Retained storage is bounded to 571 block energies, 30 hop energies,
 * one residual eight-byte frame and scalar/filter state. Source PCM is
 * never retained. A failed reducer is terminal; finish is frozen/idempotent.
 */
export function createLoudnessRangeMeter(): {
  push(chunk: Uint8Array): void;
  finish(expectedDurationSeconds?: number): LoudnessRangeMeasurement;
} {
  const residual = Buffer.allocUnsafe(FRAME_BYTES);
  const hopEnergies = new Float64Array(HOPS_PER_WINDOW);
  const blockEnergies = new Float64Array(LOUDNESS_RANGE_LIMITS.shortTermBlocks);
  const leftWeight = new KWeighting(), rightWeight = new KWeighting();
  let residualBytes = 0, sampleFrames = 0, samplePeakLinear = 0;
  let hopFrames = 0, completedHops = 0, hopSum = 0, hopCorrection = 0, shortTermBlockCount = 0;
  let failed: unknown;
  let result: LoudnessRangeMeasurement | undefined;
  const consume = (bytes: Buffer, offset: number): void => {
    const left = bytes.readFloatLE(offset), right = bytes.readFloatLE(offset + 4);
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw failure('LOUDNESS_INVALID_PCM');
    samplePeakLinear = Math.max(samplePeakLinear, Math.abs(left), Math.abs(right));
    const l = leftWeight.process(left), r = rightWeight.process(right);
    const corrected = l * l + r * r - hopCorrection;
    const next = hopSum + corrected;
    hopCorrection = (next - hopSum) - corrected;
    hopSum = next;
    sampleFrames++; hopFrames++;
    if (hopFrames === LOUDNESS_RANGE_LIMITS.hopFrames) {
      hopEnergies[completedHops % HOPS_PER_WINDOW] = hopSum;
      completedHops++; hopFrames = 0; hopSum = 0; hopCorrection = 0;
      if (completedHops >= HOPS_PER_WINDOW) {
        let energy = 0;
        // Sum positive hop energies afresh; a subtractive sliding sum can
        // lose the quiet tail after a loud window due to cancellation.
        for (const value of hopEnergies) energy += value;
        blockEnergies[shortTermBlockCount++] = energy / LOUDNESS_RANGE_LIMITS.windowFrames;
      }
    }
  };
  return Object.freeze({
    push(chunk: Uint8Array): void {
      if (failed) throw failed;
      if (result) throw failure('LOUDNESS_INVALID_PCM');
      try {
        if (!(chunk instanceof Uint8Array)) throw failure('LOUDNESS_INVALID_PCM');
        if (chunk.byteLength > LOUDNESS_RANGE_LIMITS.pcmBytes - sampleFrames * FRAME_BYTES - residualBytes)
          throw failure('LOUDNESS_RESOURCE_LIMIT');
        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let offset = 0;
        if (residualBytes) {
          const count = Math.min(FRAME_BYTES - residualBytes, bytes.length);
          bytes.copy(residual, residualBytes, 0, count); residualBytes += count; offset += count;
          if (residualBytes === FRAME_BYTES) {consume(residual, 0); residualBytes = 0;}
        }
        while (offset + FRAME_BYTES <= bytes.length) {consume(bytes, offset); offset += FRAME_BYTES;}
        if (offset < bytes.length) {residualBytes = bytes.length - offset; bytes.copy(residual, 0, offset);}
      } catch (error) {failed = error; throw error;}
    },
    finish(expectedDurationSeconds?: number): LoudnessRangeMeasurement {
      if (failed) throw failed;
      if (result) return result;
      try {
        if (residualBytes || !sampleFrames) throw failure('LOUDNESS_INVALID_PCM');
        if (expectedDurationSeconds !== undefined) {
          if (!Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0) throw failure('LOUDNESS_INVALID_PCM');
          if (expectedDurationSeconds > LOUDNESS_RANGE_LIMITS.durationSeconds) throw failure('LOUDNESS_DURATION_LIMIT');
          if (Math.abs(sampleFrames - expectedDurationSeconds * LOUDNESS_RANGE_LIMITS.sampleRate) >
              LOUDNESS_RANGE_LIMITS.durationToleranceSeconds * LOUDNESS_RANGE_LIMITS.sampleRate + 1e-7)
            throw failure('LOUDNESS_DURATION_MISMATCH');
        }
        let absoluteGatedBlockCount = 0, absoluteSum = 0;
        for (let block = 0; block < shortTermBlockCount; block++) {
          if (blockEnergies[block] >= ABSOLUTE_GATE_ENERGY) {
            absoluteGatedBlockCount++; absoluteSum += blockEnergies[block];
          }
        }
        const relativeEnergy = absoluteGatedBlockCount ? absoluteSum / absoluteGatedBlockCount / 100 : 0;
        const relativeGateLufs = absoluteGatedBlockCount ? loudness(relativeEnergy) : null;
        const gated: number[] = [];
        for (let block = 0; block < shortTermBlockCount; block++) {
          const energy = blockEnergies[block];
          if (energy >= ABSOLUTE_GATE_ENERGY && energy >= relativeEnergy) gated.push(loudness(energy));
        }
        gated.sort((a, b) => a - b);
        // Tech3342 §5's one-based round((n-1)*p+1), converted to zero-based.
        const lowPercentileLufs = gated.length ? gated[Math.round((gated.length - 1) * 0.1)] : null;
        const highPercentileLufs = gated.length ? gated[Math.round((gated.length - 1) * 0.95)] : null;
        const state = !shortTermBlockCount ? 'too_short' : samplePeakLinear === 0 ? 'digital_silence' :
          !absoluteGatedBlockCount ? 'below_gate' : 'valid';
        result = Object.freeze({profile: LOUDNESS_RANGE_PROFILE, sampleRate: 48000, channels: 2,
          sampleFrames, decodedDurationSeconds: sampleFrames / LOUDNESS_RANGE_LIMITS.sampleRate,
          state, samplePeakLinear, shortTermBlockCount, absoluteGatedBlockCount,
          relativeGatedBlockCount: gated.length, relativeGateLufs, lowPercentileLufs, highPercentileLufs,
          loudnessRangeLu: lowPercentileLufs === null || highPercentileLufs === null ? null : highPercentileLufs - lowPercentileLufs});
        return result;
      } catch (error) {failed = error; throw error;}
    },
  });
}
