import type {ExportLoudnessMeasurement} from '@mioon/contracts/export-loudness';

export const EXPORT_LOUDNESS_SAMPLE_RATE = 48000;
export const EXPORT_LOUDNESS_CHANNELS = 2;
export const EXPORT_LOUDNESS_MAX_SECONDS = 600;
export const EXPORT_LOUDNESS_MAX_PCM_BYTES = 230400000;
export const EXPORT_LOUDNESS_DURATION_TOLERANCE_SECONDS = 0.1;
const FRAME_BYTES = 8;
const BLOCK_FRAMES = 19200;
const HOP_FRAMES = 4800;
const MAX_BLOCKS = 5997;
const ABSOLUTE_GATE_ENERGY = 10 ** ((-70 + 0.691) / 10);

type MeterErrorCode = 'LOUDNESS_INVALID_PCM' | 'LOUDNESS_DURATION_MISMATCH' |
  'LOUDNESS_RESOURCE_LIMIT' | 'LOUDNESS_DURATION_LIMIT';
export type ExportLoudnessMeterError = Error & {readonly code: MeterErrorCode};
function failure(code: MeterErrorCode): ExportLoudnessMeterError {
  return Object.assign(new Error('The exported audio loudness measurement could not be completed.'), {code});
}

// ITU-R BS.1770-5 (11/2023), Annex 1, Tables 1 and 2. These coefficients
// are specifically for 48 kHz. Each stereo channel has independent state.
// https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf
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

// Exact published Annex 2 coefficients: four phases, twelve input-rate taps
// each (48 coefficients). Tap zero multiplies the newest sample, so these
// implement y[4*n+p] = sum(h[p+4*k] * x[n-k]). Overall FIR group delay is
// 23.5 output samples = 5.875 input frames. Do not normalise these phases or
// add the fixed-point 12.04 dB attenuation: all calculations are float64.
const PHASE_0 = [0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000,
  -0.0594482421875, 0.1373291015625, 0.9721679687500, -0.1022949218750,
  0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500] as const;
const PHASE_1 = [-0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250,
  -0.1665039062500, 0.4650878906250, 0.7797851562500, -0.2003173828125,
  0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375] as const;
const PHASE_2 = [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000,
  -0.2003173828125, 0.7797851562500, 0.4650878906250, -0.1665039062500,
  0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875] as const;
const PHASE_3 = [-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750,
  -0.1022949218750, 0.9721679687500, 0.1373291015625, -0.0594482421875,
  0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750] as const;

class TruePeak {
  // Duplicated rings avoid remainder operations inside the FIR dot products.
  private readonly left = new Float64Array(24);
  private readonly right = new Float64Array(24);
  private cursor = 0;
  peak = 0;

  process(left: number, right: number): void {
    const cursor = this.cursor;
    this.left[cursor] = this.left[cursor + 12] = left;
    this.right[cursor] = this.right[cursor + 12] = right;
    let l0 = 0, l1 = 0, l2 = 0, l3 = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0;
    for (let tap = 0; tap < 12; tap++) {
      const l = this.left[cursor + 12 - tap], r = this.right[cursor + 12 - tap];
      l0 += l * PHASE_0[tap]; r0 += r * PHASE_0[tap];
      l1 += l * PHASE_1[tap]; r1 += r * PHASE_1[tap];
      l2 += l * PHASE_2[tap]; r2 += r * PHASE_2[tap];
      l3 += l * PHASE_3[tap]; r3 += r * PHASE_3[tap];
    }
    this.peak = Math.max(this.peak, Math.abs(l0), Math.abs(l1), Math.abs(l2), Math.abs(l3),
      Math.abs(r0), Math.abs(r1), Math.abs(r2), Math.abs(r3));
    this.cursor = cursor === 11 ? 0 : cursor + 1;
  }

  drain(): void {
    // Only natural EOF calls this. All four output phases of the last input
    // sample remain observable through eleven further input-rate FIR steps.
    // These zeros never enter K-weighting, gates, duration, or decoded counts.
    for (let frame = 0; frame < 11; frame++) this.process(0, 0);
  }
}

const loudness = (energy: number): number => -0.691 + 10 * Math.log10(energy);
const peakDb = (peak: number): number | null => peak === 0 ? null : 20 * Math.log10(peak);

/** Streaming f32le, 48 kHz, stereo only. Annex 1 integrated loudness uses
 * complete 400 ms blocks with 100 ms hops, strict -70 LUFS absolute gating,
 * then the strict -10 LU relative gate (also retaining the absolute gate).
 * No rounded decoder metadata or -70 summary sentinel participates.
 *
 * Storage is bounded: 5,997 float64 block energies (47,976 bytes), four hop
 * energies, 48 FIR history doubles and an eight-byte residual frame, plus
 * scalar/filter state. It never retains source PCM or counts incomplete blocks.
 * Failed reducers are terminal. Successful finish is idempotent and frozen;
 * writing after finish is an error. Call finish only after clean decoder EOF.
 */
export function createExportLoudnessAccumulator(expectedDurationSeconds: number): {
  write(chunk: Buffer): void;
  finish(): ExportLoudnessMeasurement;
} {
  if (!Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0) throw failure('LOUDNESS_INVALID_PCM');
  if (expectedDurationSeconds > EXPORT_LOUDNESS_MAX_SECONDS) throw failure('LOUDNESS_DURATION_LIMIT');
  const residual = Buffer.allocUnsafe(FRAME_BYTES);
  const blockEnergies = new Float64Array(MAX_BLOCKS);
  const hopEnergies = new Float64Array(4);
  const leftWeight = new KWeighting(), rightWeight = new KWeighting(), truePeak = new TruePeak();
  let residualBytes = 0, sampleFrames = 0, samplePeakLinear = 0;
  let hopFrames = 0, completedHops = 0, hopSum = 0, hopCorrection = 0, gatingBlockCount = 0;
  let failed: unknown;
  let result: ExportLoudnessMeasurement | undefined;

  const consume = (chunk: Buffer, offset: number): void => {
    const left = chunk.readFloatLE(offset), right = chunk.readFloatLE(offset + 4);
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw failure('LOUDNESS_INVALID_PCM');
    samplePeakLinear = Math.max(samplePeakLinear, Math.abs(left), Math.abs(right));
    truePeak.process(left, right);
    const l = leftWeight.process(left), r = rightWeight.process(right);
    // Compensated positive sums within each hop avoid drift and subtractive
    // cancellation when quiet material follows loud material. Overlapping
    // blocks are sums of four hops, never sliding sums subtracting old energy.
    const corrected = l * l + r * r - hopCorrection;
    const next = hopSum + corrected;
    hopCorrection = (next - hopSum) - corrected;
    hopSum = next;
    sampleFrames++; hopFrames++;
    if (hopFrames === HOP_FRAMES) {
      hopEnergies[completedHops % 4] = hopSum;
      completedHops++; hopFrames = 0; hopSum = 0; hopCorrection = 0;
      if (completedHops >= 4) {
        blockEnergies[gatingBlockCount++] = (hopEnergies[0] + hopEnergies[1] + hopEnergies[2] + hopEnergies[3]) / BLOCK_FRAMES;
      }
    }
  };

  return Object.freeze({
    write(chunk: Buffer): void {
      if (failed) throw failed;
      if (result) throw failure('LOUDNESS_INVALID_PCM');
      try {
        if (!Buffer.isBuffer(chunk)) throw failure('LOUDNESS_INVALID_PCM');
        if (chunk.length > EXPORT_LOUDNESS_MAX_PCM_BYTES - sampleFrames * FRAME_BYTES - residualBytes)
          throw failure('LOUDNESS_RESOURCE_LIMIT');
        let offset = 0;
        if (residualBytes) {
          const count = Math.min(FRAME_BYTES - residualBytes, chunk.length);
          chunk.copy(residual, residualBytes, 0, count); residualBytes += count; offset += count;
          if (residualBytes === FRAME_BYTES) {consume(residual, 0); residualBytes = 0;}
        }
        while (offset + FRAME_BYTES <= chunk.length) {consume(chunk, offset); offset += FRAME_BYTES;}
        if (offset < chunk.length) {residualBytes = chunk.length - offset; chunk.copy(residual, 0, offset);}
      } catch (error) {failed = error; throw error;}
    },
    finish(): ExportLoudnessMeasurement {
      if (failed) throw failed;
      if (result) return result;
      try {
        if (residualBytes || !sampleFrames) throw failure('LOUDNESS_INVALID_PCM');
        // Match the existing exported-AAC allowance, including only arithmetic
        // noise at the inclusive 100 ms boundary, not another sample frame.
        if (Math.abs(sampleFrames - expectedDurationSeconds * EXPORT_LOUDNESS_SAMPLE_RATE) >
            EXPORT_LOUDNESS_DURATION_TOLERANCE_SECONDS * EXPORT_LOUDNESS_SAMPLE_RATE + 1e-7)
          throw failure('LOUDNESS_DURATION_MISMATCH');
        truePeak.drain();
        let absoluteGatedBlockCount = 0, relativeGatedBlockCount = 0, absoluteSum = 0, relativeSum = 0;
        for (let block = 0; block < gatingBlockCount; block++) {
          const energy = blockEnergies[block];
          if (energy > ABSOLUTE_GATE_ENERGY) {absoluteGatedBlockCount++; absoluteSum += energy;}
        }
        const relativeEnergy = absoluteGatedBlockCount ? absoluteSum / absoluteGatedBlockCount / 10 : 0;
        const relativeGateLufs = absoluteGatedBlockCount ? loudness(relativeEnergy) : null;
        for (let block = 0; block < gatingBlockCount; block++) {
          const energy = blockEnergies[block];
          if (energy > ABSOLUTE_GATE_ENERGY && energy > relativeEnergy) {relativeGatedBlockCount++; relativeSum += energy;}
        }
        const state = samplePeakLinear === 0 ? 'digital_silence' : !gatingBlockCount ? 'too_short' :
          !relativeGatedBlockCount ? 'below_gate' : 'valid';
        // Annex 2 is an approximate reconstruction; retain the original
        // sample maximum too, so it cannot produce a less conservative peak.
        const truePeakLinear = Math.max(samplePeakLinear, truePeak.peak);
        result = Object.freeze({sampleRate: EXPORT_LOUDNESS_SAMPLE_RATE, channels: EXPORT_LOUDNESS_CHANNELS,
          sampleFrames, decodedDurationSeconds: sampleFrames / EXPORT_LOUDNESS_SAMPLE_RATE, state,
          integratedLufs: state === 'valid' ? loudness(relativeSum / relativeGatedBlockCount) : null,
          samplePeakLinear, samplePeakDbfs: peakDb(samplePeakLinear), truePeakLinear, truePeakDbtp: peakDb(truePeakLinear),
          gatingBlockCount, absoluteGatedBlockCount, relativeGatedBlockCount, relativeGateLufs});
        return result;
      } catch (error) {failed = error; throw error;}
    },
  });
}
