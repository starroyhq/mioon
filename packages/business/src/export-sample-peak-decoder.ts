import path from 'node:path';
import {EXPORT_SAMPLE_PEAK_LIMITS} from '@mioon/contracts/export-sample-peak';
import type {ExportSamplePeakMeasurement} from '@mioon/contracts/export-sample-peak';

const SAMPLE_RATE = 48000;
const FRAME_BYTES = 8;
const PROBE_BYTES = 128 * 1024;
const PROBE_TIMEOUT_MS = 10000;
const STDERR_BYTES = 64 * 1024;
const CHECKPOINT_BYTES = 64 * 1024;
type PeakError = Error & {code: string; terminationUnconfirmed?: boolean};
const failure = (code: string, message: string): PeakError => Object.assign(new Error(message), {code});
const configuration = (): PeakError => failure('MEDIA_INVALID_CONFIGURATION', 'Invalid local media runtime configuration.');
const invalidPcm = (): PeakError => failure('SAMPLE_PEAK_INVALID_PCM', 'The exported audio did not produce complete finite sample frames.');
const unsupported = (): PeakError => failure('SAMPLE_PEAK_UNSUPPORTED_FORMAT', 'The exported audio format is not supported for this check.');
const durationMismatch = (): PeakError => failure('SAMPLE_PEAK_DURATION_MISMATCH', 'The decoded audio duration does not match the delivered interval.');
const outputLimit = (): PeakError => failure('MEDIA_OUTPUT_LIMIT', 'Local media output exceeded its fixed resource limit.');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateDuration(duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0) throw configuration();
  if (duration > EXPORT_SAMPLE_PEAK_LIMITS.durationSeconds)
    throw failure('SAMPLE_PEAK_DURATION_LIMIT', 'The delivered interval exceeds the supported duration.');
}

function matchesDuration(frames: number, duration: number): boolean {
  // Only floating arithmetic noise is tolerated at the inclusive boundary;
  // rounding probe durations to a whole frame would widen the 100 ms limit.
  return Math.abs(frames - duration * SAMPLE_RATE) <= EXPORT_SAMPLE_PEAK_LIMITS.durationToleranceSeconds * SAMPLE_RATE + 1e-7;
}

/** Every finite decoded f32 sample contributes to its own channel's absmax.
 * Constant storage: two scalars and one eight-byte frame buffer, with fewer
 * than eight residual bytes retained between writes. There is no PCM history,
 * channel summing, quantization, clipping, normalization, or silence padding.
 * A failed or completed reducer is terminal and cannot be resumed. */
export function createExportSamplePeakAccumulator(expectedDurationSeconds: number): {
  write(chunk: Buffer): void;
  finish(): ExportSamplePeakMeasurement;
} {
  validateDuration(expectedDurationSeconds);
  const residual = Buffer.allocUnsafe(FRAME_BYTES);
  let residualBytes = 0, sampleFrames = 0, left = 0, right = 0, finished = false;
  let failed: unknown;
  const consume = (chunk: Buffer, offset: number): void => {
    const l = chunk.readFloatLE(offset), r = chunk.readFloatLE(offset + 4);
    if (!Number.isFinite(l) || !Number.isFinite(r)) throw invalidPcm();
    left = Math.max(left, Math.abs(l)); right = Math.max(right, Math.abs(r)); sampleFrames++;
  };
  const alive = (): void => {
    if (failed) throw failed;
    if (finished) throw invalidPcm();
  };
  return Object.freeze({
    write(chunk: Buffer): void {
      alive();
      try {
        if (!Buffer.isBuffer(chunk)) throw invalidPcm();
        // Count residual bytes too: even one byte past the hard cap fails.
        if (chunk.length > EXPORT_SAMPLE_PEAK_LIMITS.pcmBytes - sampleFrames * FRAME_BYTES - residualBytes) throw outputLimit();
        let offset = 0;
        if (residualBytes) {
          const count = Math.min(FRAME_BYTES - residualBytes, chunk.length);
          chunk.copy(residual, residualBytes, 0, count); residualBytes += count; offset += count;
          if (residualBytes === FRAME_BYTES) { consume(residual, 0); residualBytes = 0; }
        }
        while (offset + FRAME_BYTES <= chunk.length) { consume(chunk, offset); offset += FRAME_BYTES; }
        if (offset < chunk.length) { residualBytes = chunk.length - offset; chunk.copy(residual, 0, offset); }
      } catch (error) { failed = error; throw error; }
    },
    finish(): ExportSamplePeakMeasurement {
      alive();
      try {
        if (residualBytes || !sampleFrames) throw invalidPcm();
        if (!matchesDuration(sampleFrames, expectedDurationSeconds)) throw durationMismatch();
        const peakLinear = Math.max(left, right);
        const channelPeaks: ExportSamplePeakMeasurement['channelPeaks'] = [
          Object.freeze({channel: 0, label: 'left', peakLinear: left, peakDbfs: left === 0 ? null : 20 * Math.log10(left), silent: left === 0}),
          Object.freeze({channel: 1, label: 'right', peakLinear: right, peakDbfs: right === 0 ? null : 20 * Math.log10(right), silent: right === 0}),
        ];
        Object.freeze(channelPeaks); finished = true;
        return Object.freeze({sampleRate: SAMPLE_RATE, channels: 2, sampleFrames, decodedDurationSeconds: sampleFrames / SAMPLE_RATE,
          peakLinear, peakDbfs: peakLinear === 0 ? null : 20 * Math.log10(peakLinear), silent: peakLinear === 0,
          overFullScale: peakLinear > 1, channelPeaks});
      } catch (error) { failed = error; throw error; }
    },
  });
}

export interface ExportSamplePeakProbe {
  readonly streamIndex: number;
  readonly sampleRate: 48000;
  readonly channels: 2;
  readonly durationSeconds: number;
}

function positiveDuration(value: unknown): number {
  if (typeof value !== 'string' || value.length > 40 || !/^\d+(?:\.\d+)?$/u.test(value)) throw unsupported();
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) throw unsupported();
  return duration;
}

/** A deliberately narrower parser than general imported-media probing. The
 * actual unique audio stream index is mandatory; no first-audio fallback. */
export function parseExportSamplePeakProbe(output: unknown, expectedDurationSeconds: number): ExportSamplePeakProbe {
  validateDuration(expectedDurationSeconds);
  if (typeof output !== 'string' || Buffer.byteLength(output) > PROBE_BYTES) throw unsupported();
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw unsupported(); }
  if (!object(parsed) || !Array.isArray(parsed.streams) || !parsed.streams.length || parsed.streams.length > 256 ||
      !object(parsed.format) || parsed.format.format_name !== 'mov,mp4,m4a,3gp,3g2,mj2') throw unsupported();
  const indexes = new Set<number>();
  let audio: Record<string, unknown> | undefined;
  for (const stream of parsed.streams) {
    if (!object(stream) || !Number.isSafeInteger(stream.index) || typeof stream.index !== 'number' || stream.index < 0 || indexes.has(stream.index)) throw unsupported();
    indexes.add(stream.index);
    if (stream.codec_type === 'audio') { if (audio) throw unsupported(); audio = stream; }
  }
  if (!audio || audio.codec_name !== 'aac' || audio.sample_rate !== '48000' || audio.channels !== 2 || audio.channel_layout !== 'stereo') throw unsupported();
  const durationSeconds = positiveDuration(audio.duration), formatDuration = positiveDuration(parsed.format.duration);
  if (!matchesDuration(durationSeconds * SAMPLE_RATE, expectedDurationSeconds) ||
      !matchesDuration(formatDuration * SAMPLE_RATE, expectedDurationSeconds)) throw durationMismatch();
  return Object.freeze({streamIndex: audio.index as number, sampleRate: SAMPLE_RATE, channels: 2, durationSeconds});
}

export interface ExportSamplePeakDecodeOptions {
  readonly signal?: AbortSignal;
  /** Trusted caller's synchronous live ownership, file-identity and budget fence. */
  readonly beforeEffect: () => void;
  /** Milliseconds left in the caller's one absolute operation deadline. The
   * caller also aborts signal at that deadline, including during permit wait. */
  readonly remainingMs: () => number;
}
export type ExportSamplePeakDecoder = (file: string, expectedDurationSeconds: number, options: ExportSamplePeakDecodeOptions) => Promise<ExportSamplePeakMeasurement>;

interface RunOptions {
  signal?: AbortSignal;
  timeout: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  beforeSpawn: () => void;
  beforeEffect: () => void;
}
/** Trusted JS composition-root adapters reuse the existing exact-child
 * runner, global probe permit, sanitization, cancellation and reap policy.
 * Keeping the boundary typed avoids importing the untyped service graph. */
export interface ExportSamplePeakDecoderRuntime {
  run(command: string, args: string[], options: RunOptions): Promise<unknown>;
  runStreaming(command: string, args: string[], options: RunOptions & {onStdout: (chunk: Buffer) => void}): Promise<unknown>;
  withProbePermit<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
  checkMediaEffect(beforeEffect: () => void, signal?: AbortSignal): void;
}

const localInputArgs = (file: string): string[] => [
  '-protocol_whitelist', 'file', '-format_whitelist', 'mov',
  '-enable_drefs', '0', '-use_absolute_path', '0', '-f', 'mov', '-i', file,
];

/** Complete natural-EOF decoding of one already-verified managed MP4. The
 * caller owns pre/post byte hashes and final publication. No path repair,
 * output file, cache, render, resample, downmix or duration truncation occurs.
 * Disabling filter reinitialization makes audio buffersrc reject midstream
 * format/rate/layout changes; -xerror prevents treating a decoder error as EOF.
 * pcm_f32le only packs the native AAC float samples into interleaved bytes. */
export function createExportSamplePeakDecoder(runtime: ExportSamplePeakDecoderRuntime): ExportSamplePeakDecoder {
  return createExportAudioObservationDecoder(runtime, createExportSamplePeakAccumulator, parseExportSamplePeakProbe);
}

/** Shared trusted transport only: preserve the exact existing finite-stream
 * codec invocation and child lifecycle while each observation owns its pure
 * reducer and probe policy. This function never authorizes a caller path. */
export function createExportAudioObservationDecoder<Measurement>(runtime: ExportSamplePeakDecoderRuntime,
  createAccumulator: (expectedDurationSeconds: number) => {write(chunk: Buffer): void; finish(): Measurement},
  parseProbe: (output: unknown, expectedDurationSeconds: number) => ExportSamplePeakProbe,
): (file: string, expectedDurationSeconds: number, options: ExportSamplePeakDecodeOptions) => Promise<Measurement> {
  return async function decodeExportAudioObservation(file, expectedDurationSeconds, options) {
    if (typeof file !== 'string' || !file || file.includes('\0') || !path.isAbsolute(file) ||
        !options || typeof options.beforeEffect !== 'function' || typeof options.remainingMs !== 'function') throw configuration();
    validateDuration(expectedDurationSeconds);
    const accumulator = createAccumulator(expectedDurationSeconds);
    let callbackFailure: unknown;
    const remaining = (): number => {
      const value = options.remainingMs();
      if (!Number.isFinite(value) || value > EXPORT_SAMPLE_PEAK_LIMITS.timeoutMs) throw configuration();
      if (value < 1) throw failure('SAMPLE_PEAK_BUDGET', 'The exported audio check exhausted its operation budget.');
      return Math.floor(value);
    };
    const fence = (): void => {
      try { runtime.checkMediaEffect(options.beforeEffect, options.signal); remaining(); }
      catch (error) { callbackFailure = error; throw error; }
    };
    const runnerOptions = (maxStdoutBytes: number, timeoutCap: number = EXPORT_SAMPLE_PEAK_LIMITS.timeoutMs): RunOptions => ({signal: options.signal, timeout: Math.min(timeoutCap, remaining()),
      maxStdoutBytes, maxStderrBytes: STDERR_BYTES, beforeSpawn: fence, beforeEffect: fence});
    try {
      fence();
      const probe = await runtime.withProbePermit(options.signal, async () => {
        fence();
        const raw = await runtime.run('ffprobe', ['-v', 'error',
          '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration',
          '-of', 'json', ...localInputArgs(file)], runnerOptions(PROBE_BYTES, PROBE_TIMEOUT_MS));
        fence();
        return parseProbe(raw, expectedDurationSeconds);
      });
      fence();
      let bytesSeen = 0;
      const decoded = await runtime.runStreaming('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-filter_threads', '1',
        '-reinit_filter', '0', ...localInputArgs(file), '-map', `0:${probe.streamIndex}`, '-vn', '-sn', '-dn', '-threads', '1',
        '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
      ], {...runnerOptions(EXPORT_SAMPLE_PEAK_LIMITS.pcmBytes), onStdout(chunk: Buffer): void {
        try {
          if (!Buffer.isBuffer(chunk)) throw invalidPcm();
          fence();
          for (let offset = 0; offset < chunk.length; offset += CHECKPOINT_BYTES) {
            if (offset) fence();
            accumulator.write(chunk.subarray(offset, offset + CHECKPOINT_BYTES));
          }
          bytesSeen += chunk.length;
        } catch (error) { callbackFailure = error; throw error; }
      }});
      fence();
      if (!object(decoded) || decoded.stdoutBytes !== bytesSeen) throw invalidPcm();
      return accumulator.finish();
    } catch (error) {
      if (!callbackFailure) throw error;
      if (object(error) && error.terminationUnconfirmed === true && object(callbackFailure)) callbackFailure.terminationUnconfirmed = true;
      throw callbackFailure;
    }
  };
}
