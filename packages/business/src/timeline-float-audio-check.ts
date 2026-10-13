import path from 'node:path';
import {TIMELINE_EXPORT_FLOAT_LIMITS} from '@mioon/contracts/timeline-export-float';
import type {TimelineExportAudioMeasurement} from '@mioon/contracts/timeline-export-float';

export const TIMELINE_FLOAT_AUDIO_LIMITS = Object.freeze({outputFrames: TIMELINE_EXPORT_FLOAT_LIMITS.outputFrames, sampleFrames: TIMELINE_EXPORT_FLOAT_LIMITS.sampleFrames,
  pcmBytes: TIMELINE_EXPORT_FLOAT_LIMITS.pcmBytes, totalMs: TIMELINE_EXPORT_FLOAT_LIMITS.timeoutMs, responseBytes: TIMELINE_EXPORT_FLOAT_LIMITS.reportBytes, probeBytes: 128 * 1024, stderrBytes: 64 * 1024});
const FRAME_BYTES = 8, SAMPLES_PER_FRAME = 1600, CHECKPOINT_BYTES = 64 * 1024;
type CheckError = Error & {code: string; terminationUnconfirmed?: boolean};
const failure = (code: string, message: string): CheckError => Object.assign(new Error(message), {code});
const configuration = (): CheckError => failure('MEDIA_INVALID_CONFIGURATION', 'Invalid float audio check configuration.');
const invalidPcm = (): CheckError => failure('EXPORT_AUDIO_INVALID_PCM', 'The generated float audio did not contain complete finite sample frames.');
const mismatch = (): CheckError => failure('EXPORT_AUDIO_SAMPLE_COUNT_MISMATCH', 'The generated float audio does not match the complete selected interval.');
const timeout = (): CheckError => failure('EXPORT_AUDIO_TIMEOUT', 'The generated float audio check exceeded its total time budget.');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownedMeasurements = new WeakSet<object>();
const ownedFailures = new WeakMap<object, Readonly<{code: string; measurement: TimelineExportAudioMeasurement | null}>>();
const exactFrames = (outputFrames: number): number => {
  if (!Number.isSafeInteger(outputFrames) || outputFrames < 1 || outputFrames > TIMELINE_FLOAT_AUDIO_LIMITS.outputFrames) throw configuration();
  return outputFrames * SAMPLES_PER_FRAME;
};

/** Server-created evidence only. Never infer authority from an error's public
 * properties or from a caller-supplied JSON-shaped measurement. */
export function isOwnedTimelineFloatAudioMeasurement(value: unknown): value is TimelineExportAudioMeasurement {
  return object(value) && ownedMeasurements.has(value);
}
export function readTimelineFloatAudioCheckFailure(value: unknown): Readonly<{code: string; measurement: TimelineExportAudioMeasurement | null}> | undefined {
  return object(value) ? ownedFailures.get(value) : undefined;
}
/** Retain the completed pre-encode observation if a later encode, final probe
 * or exact cleanup fails. Ownership/cancellation uncertainty is never branded.
 * This accepts only a measurement minted in this module's current lifetime. */
export function rememberTimelineFloatAudioFailure(error: unknown, measurement: TimelineExportAudioMeasurement | null,
  incompleteCode: 'EXPORT_AUDIO_STAGING_CHANGED' = 'EXPORT_AUDIO_STAGING_CHANGED'): void {
  if (!object(error) || error.terminationUnconfirmed === true ||
      ['MEDIA_CANCELLED', 'RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH', 'INVALID_TIMELINE_SNAPSHOT'].includes(String(error.code))) return;
  if (measurement !== null && !isOwnedTimelineFloatAudioMeasurement(measurement)) throw configuration();
  if (measurement === null && incompleteCode !== 'EXPORT_AUDIO_STAGING_CHANGED') throw configuration();
  ownedFailures.set(error, Object.freeze({code: measurement ? measurement.peakLinear > 1 ? 'EXPORT_AUDIO_OVER_RANGE' : 'EXPORT_AUDIO_WITHIN_LIMIT' : incompleteCode, measurement}));
}
export function assertTimelineFloatAudioAllowed(measurement: TimelineExportAudioMeasurement): void {
  if (!isOwnedTimelineFloatAudioMeasurement(measurement)) throw configuration();
  if (measurement.peakLinear <= 1) return;
  const error = failure('EXPORT_AUDIO_OVER_RANGE', 'The pre-encode float audio peak exceeds one. Lower the saved gains and request a new export.');
  ownedFailures.set(error, Object.freeze({code: error.code, measurement}));
  throw error;
}

/** Constant storage: two channel peaks/counters and less than one stereo-frame
 * remainder. No rounding, clamping, normalization, PCM history or EOF padding.
 * Every finite scalar sample contributes, including values above one. */
export function createTimelineFloatAudioAccumulator(outputFrames: number): {
  write(chunk: Buffer): void; finish(): TimelineExportAudioMeasurement;
} {
  const expectedFrames = exactFrames(outputFrames), expectedBytes = expectedFrames * FRAME_BYTES;
  const residual = Buffer.allocUnsafe(FRAME_BYTES);
  let residualBytes = 0, sampleFrames = 0, left = 0, right = 0, leftOver = 0, rightOver = 0, finished = false;
  let failed: unknown;
  const alive = (): void => { if (failed) throw failed; if (finished) throw invalidPcm(); };
  const consume = (chunk: Buffer, offset: number): void => {
    const l = chunk.readFloatLE(offset), r = chunk.readFloatLE(offset + 4);
    if (!Number.isFinite(l) || !Number.isFinite(r)) throw invalidPcm();
    const la = Math.abs(l), ra = Math.abs(r);
    left = Math.max(left, la); right = Math.max(right, ra);
    if (la > 1) leftOver++; if (ra > 1) rightOver++; sampleFrames++;
  };
  return Object.freeze({
    write(chunk: Buffer): void {
      alive();
      try {
        if (!Buffer.isBuffer(chunk)) throw invalidPcm();
        if (chunk.length > expectedBytes - sampleFrames * FRAME_BYTES - residualBytes) throw mismatch();
        let offset = 0;
        if (residualBytes) {
          const size = Math.min(FRAME_BYTES - residualBytes, chunk.length);
          chunk.copy(residual, residualBytes, 0, size); residualBytes += size; offset += size;
          if (residualBytes === FRAME_BYTES) { consume(residual, 0); residualBytes = 0; }
        }
        while (offset + FRAME_BYTES <= chunk.length) { consume(chunk, offset); offset += FRAME_BYTES; }
        if (offset < chunk.length) { residualBytes = chunk.length - offset; chunk.copy(residual, 0, offset); }
      } catch (error) { failed = error; throw error; }
    },
    finish(): TimelineExportAudioMeasurement {
      alive();
      try {
        if (residualBytes) throw invalidPcm();
        if (sampleFrames !== expectedFrames) throw mismatch();
        const measurement: TimelineExportAudioMeasurement = {sampleRate: 48000, channels: 2, sampleFormat: 'f32le',
          sampleFrames, sampleCount: sampleFrames * 2, peakLinear: Math.max(left, right), overRangeSampleCount: leftOver + rightOver,
          channelPeaks: [{channel: 0, peakLinear: left, overRangeSampleCount: leftOver}, {channel: 1, peakLinear: right, overRangeSampleCount: rightOver}]};
        for (const channel of measurement.channelPeaks) Object.freeze(channel);
        Object.freeze(measurement.channelPeaks); Object.freeze(measurement);
        if (Buffer.byteLength(JSON.stringify(measurement)) > TIMELINE_FLOAT_AUDIO_LIMITS.responseBytes) throw invalidPcm();
        ownedMeasurements.add(measurement); finished = true; return measurement;
      } catch (error) { failed = error; throw error; }
    },
  });
}

interface RunOptions {
  signal?: AbortSignal; timeout: number; maxStdoutBytes: number; maxStderrBytes: number;
  beforeSpawn: () => void; beforeEffect: () => void;
}
export interface TimelineFloatAudioRuntime {
  run(command: string, args: string[], options: RunOptions): Promise<unknown>;
  runStreaming(command: string, args: string[], options: RunOptions & {onStdout: (chunk: Buffer) => void}): Promise<unknown>;
  withProbePermit<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
  checkMediaEffect(beforeEffect: () => void, signal?: AbortSignal): void;
  readonly terminationMs: number;
}
export interface TimelineFloatAudioCheckOptions {
  readonly signal?: AbortSignal;
  /** Synchronous live attempt/source/owned staging inode fence. */
  readonly beforeEffect: () => void;
  /** Exact generated, reserved segment paths and frame counts, never DTO input. */
  readonly ownedSegments: readonly {readonly file: string; readonly outputFrames: number}[];
  /** Optional tighter existing capability deadline; never expands 120 seconds. */
  readonly remainingMs?: () => number;
}
const concatInput = (list: string): string[] => ['-protocol_whitelist', 'file', '-format_whitelist', 'concat,mov', '-f', 'concat', '-safe', '0', '-i', list];
export function parseTimelineFloatAudioProbe(raw: unknown, expectedFrames?: number): number {
  const unsupported = (): CheckError => failure('EXPORT_AUDIO_FORMAT_MISMATCH', 'The generated audio is not the fixed float32 48 kHz stereo format.');
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > TIMELINE_FLOAT_AUDIO_LIMITS.probeBytes) throw unsupported();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unsupported(); }
  if (!object(value) || !Array.isArray(value.streams) || value.streams.length !== 2 || !object(value.format) || value.format.format_name !== (expectedFrames === undefined ? 'concat' : 'mov,mp4,m4a,3gp,3g2,mj2')) throw unsupported();
  const streams = value.streams;
  if (!streams.every(stream => object(stream) && Number.isSafeInteger(stream.index) && typeof stream.index === 'number' && stream.index >= 0) ||
      streams[0].index === streams[1].index || streams.filter(stream => stream.codec_type === 'video').length !== 1) throw unsupported();
  const audio = streams.filter(stream => stream.codec_type === 'audio');
  if (audio.length !== 1 || audio[0].codec_name !== 'pcm_f32le' || audio[0].sample_fmt !== 'flt' || audio[0].sample_rate !== '48000' ||
      audio[0].channels !== 2 || audio[0].channel_layout !== 'stereo') throw unsupported();
  if (expectedFrames !== undefined && (audio[0].time_base !== '1/48000' || !Number.isSafeInteger(audio[0].duration_ts) || audio[0].duration_ts !== exactFrames(expectedFrames))) throw mismatch();
  return audio[0].index as number;
}

/** This is only for this attempt's generated owned concat list. Natural EOF
 * must match the complete frozen interval exactly. The probe permit, runtime
 * and cancellation remain the existing media lane, with no cache/new queue. */
export function createTimelineFloatAudioChecker(runtime: TimelineFloatAudioRuntime):
  (list: string, outputFrames: number, options: TimelineFloatAudioCheckOptions) => Promise<TimelineExportAudioMeasurement> {
  return async (list, outputFrames, options) => {
    if (typeof list !== 'string' || !path.isAbsolute(list) || list.includes('\0') || !options || typeof options.beforeEffect !== 'function' ||
        (options.remainingMs !== undefined && typeof options.remainingMs !== 'function') || !Number.isSafeInteger(runtime.terminationMs) ||
        runtime.terminationMs < 0 || runtime.terminationMs >= TIMELINE_FLOAT_AUDIO_LIMITS.totalMs) throw configuration();
    if (!Array.isArray(options.ownedSegments) || options.ownedSegments.length < 1 || options.ownedSegments.length > 200 ||
        options.ownedSegments.some(segment => !segment || typeof segment.file !== 'string' || !path.isAbsolute(segment.file) || segment.file.includes('\0') ||
          path.dirname(segment.file) !== path.dirname(list) || !Number.isSafeInteger(segment.outputFrames) || segment.outputFrames < 1) ||
        new Set(options.ownedSegments.map(segment => segment.file)).size !== options.ownedSegments.length ||
        options.ownedSegments.reduce((total, segment) => total + segment.outputFrames, 0) !== outputFrames) throw configuration();
    const accumulator = createTimelineFloatAudioAccumulator(outputFrames);
    const outerBudget = options.remainingMs?.() ?? TIMELINE_FLOAT_AUDIO_LIMITS.totalMs;
    if (!Number.isFinite(outerBudget) || outerBudget > TIMELINE_FLOAT_AUDIO_LIMITS.totalMs) throw configuration();
    if (outerBudget < 1) throw timeout();
    const computeMs = Math.min(outerBudget, TIMELINE_FLOAT_AUDIO_LIMITS.totalMs - runtime.terminationMs), deadline = performance.now() + computeMs;
    const budgetController = new AbortController(), queueSignal = options.signal ? AbortSignal.any([options.signal, budgetController.signal]) : budgetController.signal;
    const timer = setTimeout(() => budgetController.abort(), computeMs); timer.unref();
    let callbackFailure: unknown;
    const remaining = (): number => {
      const outer = options.remainingMs?.() ?? computeMs;
      if (!Number.isFinite(outer) || outer > TIMELINE_FLOAT_AUDIO_LIMITS.totalMs) throw configuration();
      const left = Math.floor(Math.min(outer, deadline - performance.now()));
      if (left < 1 || budgetController.signal.aborted) throw timeout();
      return left;
    };
    const fence = (): void => { runtime.checkMediaEffect(options.beforeEffect, options.signal); remaining(); };
    const runOptions = (bytes: number, cap = computeMs): RunOptions => ({signal: options.signal, timeout: Math.min(cap, remaining()),
      maxStdoutBytes: bytes, maxStderrBytes: TIMELINE_FLOAT_AUDIO_LIMITS.stderrBytes, beforeSpawn: fence, beforeEffect: fence});
    try {
      fence();
      for (const segment of options.ownedSegments) {
        fence();
        await runtime.withProbePermit(queueSignal, async () => {
          fence();
          const raw = await runtime.run('ffprobe', ['-v', 'error', '-show_entries',
            'format=format_name:stream=index,codec_type,codec_name,sample_fmt,sample_rate,channels,channel_layout,time_base,duration_ts', '-of', 'json',
            '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0', '-f', 'mov', '-i', segment.file],
            runOptions(TIMELINE_FLOAT_AUDIO_LIMITS.probeBytes, 10000));
          fence(); parseTimelineFloatAudioProbe(raw, segment.outputFrames);
        });
        fence();
      }
      const index = await runtime.withProbePermit(queueSignal, async () => {
        fence();
        const raw = await runtime.run('ffprobe', ['-v', 'error', '-show_entries',
          'format=format_name:stream=index,codec_type,codec_name,sample_fmt,sample_rate,channels,channel_layout', '-of', 'json', ...concatInput(list)],
          runOptions(TIMELINE_FLOAT_AUDIO_LIMITS.probeBytes, 10000));
        fence(); return parseTimelineFloatAudioProbe(raw);
      });
      fence();
      let bytesSeen = 0;
      const decoded = await runtime.runStreaming('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-filter_threads', '1',
        '-reinit_filter', '0', ...concatInput(list), '-map', `0:${index}`, '-vn', '-sn', '-dn', '-threads', '1', '-af', 'asetpts=N/SR/TB',
        '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], {...runOptions(TIMELINE_FLOAT_AUDIO_LIMITS.pcmBytes), onStdout(chunk: Buffer): void {
          try {
            fence(); if (!Buffer.isBuffer(chunk)) throw invalidPcm();
            for (let at = 0; at < chunk.length; at += CHECKPOINT_BYTES) { if (at) fence(); accumulator.write(chunk.subarray(at, at + CHECKPOINT_BYTES)); }
            bytesSeen += chunk.length;
          } catch (error) { callbackFailure = error; throw error; }
        }});
      fence();
      if (!object(decoded) || decoded.stdoutBytes !== bytesSeen) throw invalidPcm();
      const measurement = accumulator.finish(); fence(); return measurement;
    } catch (error) {
      let source = callbackFailure ?? error;
      if (object(error) && error.terminationUnconfirmed === true && object(source)) source.terminationUnconfirmed = true;
      // An actual owned child with unconfirmed close always wins over any
      // coincident budget/cancellation classification. Never discard its flag.
      if (object(source) && source.terminationUnconfirmed === true) throw source;
      if (object(source) && (options.signal?.aborted ||
          ['MEDIA_CANCELLED', 'RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH', 'INVALID_TIMELINE_SNAPSHOT'].includes(String(source.code)))) {
        if (!(budgetController.signal.aborted && !options.signal?.aborted && source.code === 'MEDIA_CANCELLED')) throw source;
      }
      if (budgetController.signal.aborted && !options.signal?.aborted || object(source) && source.code === 'MEDIA_TIMEOUT') source = timeout();
      const codes = ['EXPORT_AUDIO_INVALID_PCM', 'EXPORT_AUDIO_SAMPLE_COUNT_MISMATCH', 'EXPORT_AUDIO_FORMAT_MISMATCH', 'EXPORT_AUDIO_TIMEOUT', 'EXPORT_AUDIO_STAGING_CHANGED'];
      const code = object(source) && codes.includes(String(source.code)) ? String(source.code) :
        object(source) && source.code === 'MEDIA_OUTPUT_LIMIT' ? 'EXPORT_AUDIO_OUTPUT_LIMIT' :
        object(source) && source.code === 'MEDIA_SPAWN_FAILED' ? 'EXPORT_AUDIO_DECODER_UNAVAILABLE' : 'EXPORT_AUDIO_DECODE_FAILED';
      const safe = source instanceof Error && object(source) && source.code === code ? source : failure(code, 'The complete generated float audio check could not be verified.');
      ownedFailures.set(safe, Object.freeze({code, measurement: null})); throw safe;
    } finally { clearTimeout(timer); }
  };
}
