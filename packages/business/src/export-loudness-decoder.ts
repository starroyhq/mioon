import type {ExportLoudnessMeasurement} from '@mioon/contracts/export-loudness';
import {createExportLoudnessAccumulator} from './export-loudness-meter.ts';
import {createExportAudioObservationDecoder, parseExportSamplePeakProbe} from './export-sample-peak-decoder.ts';
import type {ExportSamplePeakDecoderRuntime, ExportSamplePeakDecodeOptions, ExportSamplePeakProbe} from './export-sample-peak-decoder.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code: string): Error & {code: string} => Object.assign(new Error('The exported audio loudness check could not be completed.'), {code});
const translatedCodes: Readonly<Record<string, string>> = Object.freeze({
  SAMPLE_PEAK_UNSUPPORTED_FORMAT: 'LOUDNESS_UNSUPPORTED_FORMAT',
  SAMPLE_PEAK_DURATION_LIMIT: 'LOUDNESS_DURATION_LIMIT',
  SAMPLE_PEAK_DURATION_MISMATCH: 'LOUDNESS_DURATION_MISMATCH',
  SAMPLE_PEAK_INVALID_PCM: 'LOUDNESS_INVALID_PCM',
  SAMPLE_PEAK_BUDGET: 'LOUDNESS_BUDGET',
});
function translate(error: unknown): unknown {
  if (object(error) && typeof error.code === 'string') {
    const code = translatedCodes[error.code];
    if (code) return Object.assign(failure(code), error.terminationUnconfirmed === true ? {terminationUnconfirmed: true} : {});
  }
  return error;
}

/** Preserve the narrow native AAC/48k/stereo parser. Only a structurally valid
 * MP4 with known indexed streams and a matching complete delivery duration can
 * be called no-audio; malformed, ambiguous, or unsupported probes cannot. */
export function parseExportLoudnessProbe(output: unknown, expectedDurationSeconds: number): ExportSamplePeakProbe {
  try {return parseExportSamplePeakProbe(output, expectedDurationSeconds);}
  catch (error) {
    if (!object(error) || error.code !== 'SAMPLE_PEAK_UNSUPPORTED_FORMAT' || typeof output !== 'string' ||
        Buffer.byteLength(output) > 128 * 1024) throw translate(error);
    let parsed: unknown;
    try {parsed = JSON.parse(output);} catch {throw translate(error);}
    if (!object(parsed) || !Array.isArray(parsed.streams) || parsed.streams.length < 1 || parsed.streams.length > 256 ||
        !object(parsed.format) || parsed.format.format_name !== 'mov,mp4,m4a,3gp,3g2,mj2') throw translate(error);
    const indexes = new Set<number>();
    for (const stream of parsed.streams) {
      if (!object(stream) || typeof stream.index !== 'number' || !Number.isSafeInteger(stream.index) || stream.index < 0 ||
          indexes.has(stream.index) || stream.codec_type === 'audio' ||
          !['video', 'subtitle', 'data', 'attachment'].includes(String(stream.codec_type))) throw translate(error);
      indexes.add(stream.index);
    }
    const rawDuration = parsed.format.duration;
    if (typeof rawDuration !== 'string' || rawDuration.length > 40 || !/^\d+(?:\.\d+)?$/u.test(rawDuration)) throw translate(error);
    const duration = Number(rawDuration);
    if (!Number.isFinite(duration) || duration <= 0) throw translate(error);
    if (Math.abs(duration * 48000 - expectedDurationSeconds * 48000) > 4800 + 1e-7) throw failure('LOUDNESS_DURATION_MISMATCH');
    throw failure('LOUDNESS_NO_AUDIO');
  }
}

export type ExportLoudnessDecoderRuntime = ExportSamplePeakDecoderRuntime;
export type ExportLoudnessDecodeOptions = ExportSamplePeakDecodeOptions;
export type ExportLoudnessDecoder = (file: string, expectedDurationSeconds: number, options: ExportLoudnessDecodeOptions) => Promise<ExportLoudnessMeasurement>;

/** Same trusted natural-EOF transport and exact child lifecycle as samplePeak.
 * No render, resampling, channel summing, output file, or network protocol. */
export function createExportLoudnessDecoder(runtime: ExportLoudnessDecoderRuntime): ExportLoudnessDecoder {
  const decode = createExportAudioObservationDecoder(runtime, createExportLoudnessAccumulator, parseExportLoudnessProbe);
  return async (file, expectedDurationSeconds, options) => {
    try {return await decode(file, expectedDurationSeconds, options);}
    catch (error) {throw translate(error);}
  };
}
