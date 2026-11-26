import {lstat, type FileHandle} from 'node:fs/promises';
import {AppError} from '../../contracts/src/app-error.ts';
import {SPEED_BUDGET_EXCEEDED, SPEED_SOURCE_UNSUPPORTED, TIMELINE_SPEED_EXPORT_MESSAGES}
  from '../../contracts/src/timeline-speed-export.ts';
import type {ClipTiming} from '../../contracts/src/timeline-speed.ts';
import {
  restoreTimeMap, timeMapRootInfo, timeMapSourceRangeForEdit,
  type CompiledTimeMap, type TimeMapResult, type TimeMapSourceBoundary, type TimeMapSpeedRate,
} from '../../contracts/src/timeline-time-map.ts';
import {withProbePermit} from './media-probe.ts';
import {checkMediaEffect, MEDIA_RUNTIME_LIMITS, run, runStreamingWithBackpressure} from './media-runtime.ts';
import {
  createSpeedAudioSourceClock, invalidSpeedAudio as invalid, speedAudioSamplesPerFrame as samplesPerFrame,
} from './timeline-speed-export-audio-clock.ts';

const sampleRate = 48_000;
const bytesPerSample = 8;
const outputBatchSamples = 4_096;
const maximumPipeSamples = MEDIA_RUNTIME_LIMITS.streamingStdoutBytes / bytesPerSample;
const maximumTempoTailSamples = sampleRate / 50; // The SP-E0 20 ms extra-tail limit.
const shortTempoContextSamples = 8_192;
const demuxers = 'mov,matroska,mp3,wav';

interface RawReverseAudio {
  readonly sampleRate: number;
  readonly channels: number;
  readonly layout: string;
}

interface ReverseAudio {
  readonly fromSample: number;
  readonly toSample: number;
  readonly raw?: RawReverseAudio;
}

export interface TimelineSpeedAudioSource {
  readonly file: string;
  readonly streamIndex: number | string;
  readonly videoStreamIndex?: number | string | null;
  /** Reverse artifacts describe absolute source bounds on the 48 kHz clock. */
  readonly reversed?: ReverseAudio;
}

export interface TimelineSpeedAudioInput {
  readonly timing: ClipTiming;
  readonly plan: CompiledTimeMap;
  readonly source: TimelineSpeedAudioSource;
  readonly destination: string;
}

interface TimelineSpeedAudioEffects {
  readonly signal?: AbortSignal;
  readonly beforeEffect?: () => void;
}

export interface TimelineSpeedAudioOptions extends TimelineSpeedAudioEffects {
  readonly openOwnedFile: (file: string) => Promise<FileHandle>;
}

export type TimelineSpeedAudioMode = 'silence' | 'shift' | 'preserve';

function pitchPreservingRate(timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>): TimeMapSpeedRate | undefined {
  const speed = timing.basis.speed;
  if (timing.pitchShift || speed.kind !== 'constant') return undefined;
  const {numerator, denominator} = speed.rate;
  return numerator >= 2 * denominator && numerator <= 4 * denominator ? speed.rate : undefined;
}

export function timelineSpeedAudioMode(timing: ClipTiming): TimelineSpeedAudioMode {
  if (timing.profile === 'timeline-freeze-v1') return 'silence';
  return pitchPreservingRate(timing) ? 'preserve' : 'shift';
}

const budget = (): AppError =>
  new AppError(SPEED_BUDGET_EXCEEDED, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_BUDGET_EXCEEDED], 409);
const unwrap = <T>(result: TimeMapResult<T>): T => {
  if (!result.ok) throw invalid(result.code);
  return result.value;
};

/** A flat curve can use the exact affine sample clock in the resampler. */
function constantSourceRate(timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>): TimeMapSpeedRate | undefined {
  const speed = timing.basis.speed;
  if (speed.kind === 'constant') return speed.rate;
  const first = speed.points[0]?.rate;
  if (first && speed.points.every(({rate}) => rate.numerator === first.numerator && rate.denominator === first.denominator)) {
    return first;
  }
}

function ceilRatio(numerator: bigint, denominator: bigint): number {
  const quotient = numerator / denominator;
  const rounded = Number(quotient + (numerator % denominator > 0n ? 1n : 0n));
  if (!Number.isSafeInteger(rounded)) throw invalid('SAMPLE_CLOCK_RANGE');
  return rounded;
}

function sampleBoundary(boundary: TimeMapSourceBoundary): number {
  const numerator = BigInt(boundary.kind === 'rational' ? boundary.numerator : boundary.ticks);
  const denominator = boundary.kind === 'rational' ? BigInt(boundary.denominator) : 1n << 64n;
  return ceilRatio(numerator * BigInt(samplesPerFrame), denominator);
}

function motionLength(plan: CompiledTimeMap,
  timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>): number {
  const {sourceFps, outputFps, rootLength} = timeMapRootInfo(plan.root);
  if ([sourceFps, outputFps].some(fps => fps.fpsNumerator !== 30 || fps.fpsDenominator !== 1)) throw invalid('SAMPLE_CLOCK_RATE');
  const {loTime, hiTime} = timing.view;
  const offset = (hiTime.offsetOutputFrames - loTime.offsetOutputFrames) * samplesPerFrame;
  if (loTime.anchor === hiTime.anchor) return offset;
  const direction = hiTime.anchor === 'end' ? 1 : -1;
  if (rootLength.kind === 'exact') {
    const denominator = BigInt(rootLength.denominator);
    return ceilRatio(BigInt(direction * samplesPerFrame) * BigInt(rootLength.numerator) + BigInt(offset) * denominator, denominator);
  }
  const center = direction * samplesPerFrame * rootLength.value + offset;
  const error = samplesPerFrame * rootLength.errorBound + Number.EPSILON * 4 * (Math.abs(center) + Math.abs(offset) + 1);
  const low = Math.ceil(center - error), high = Math.ceil(center + error);
  if (low !== high || !Number.isSafeInteger(low)) throw invalid('SAMPLE_TAIL_UNRESOLVED');
  return low;
}

interface SampleWindow {readonly start: number; readonly end: number}

function localWindow(source: TimelineSpeedAudioSource, window: SampleWindow): SampleWindow {
  const reverse = source.reversed;
  if (!reverse) return window;
  if (window.start < reverse.fromSample || window.end > reverse.toSample || window.start >= window.end) throw invalid('REVERSE_PCM_WINDOW');
  return {start: reverse.toSample - window.end, end: reverse.toSample - window.start};
}

function resolveAudioStream(stream: string | number): string {
  if (typeof stream === 'number' && Number.isSafeInteger(stream) && stream >= 0) return String(stream);
  if (typeof stream === 'string' && /^(?:a:)?(?:0|[1-9]\d{0,4})$/u.test(stream)) return stream;
  throw invalid('AUDIO_STREAM');
}

function inputPcmArgs(source: TimelineSpeedAudioSource): string[] {
  const raw = source.reversed?.raw;
  return raw ? ['-format_whitelist', 'f32le', '-f', 'f32le', '-sample_rate', String(raw.sampleRate), '-ch_layout', raw.layout]
    : ['-format_whitelist', demuxers];
}

const unverifiedSourceClock = (): AppError =>
  new AppError(SPEED_SOURCE_UNSUPPORTED, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_SOURCE_UNSUPPORTED], 409,
    {audioReason: 'SOURCE_CLOCK_UNVERIFIED'});

function sourceFrameTimestamp(result: string, kind: 'audio' | 'video'): number {
  let probe: {streams?: {codec_type?: string; time_base?: string}[];
    frames?: {pts?: string | number; best_effort_timestamp?: string | number}[]};
  try { probe = JSON.parse(result); }
  catch (error) {
    if (error instanceof SyntaxError) throw unverifiedSourceClock();
    throw error;
  }
  const stream = probe?.streams?.[0], frame = probe?.frames?.[0];
  const base = typeof stream?.time_base === 'string' ? /^([1-9]\d{0,9})\/([1-9]\d{0,9})$/u.exec(stream.time_base) : null;
  const pts = frame && /^-?(?:0|[1-9]\d*)$/u.test(String(frame.pts)) ? Number(frame.pts) : NaN;
  if (probe?.streams?.length !== 1 || stream?.codec_type !== kind || !base || !Number.isSafeInteger(pts) ||
      Number(frame?.best_effort_timestamp) !== pts) throw unverifiedSourceClock();
  const numerator = BigInt(pts) * BigInt(base[1]!) * BigInt(sampleRate);
  const denominator = BigInt(base[2]!);
  const sign = numerator < 0n ? -1n : 1n;
  const sample = Number(sign * ((sign * numerator * 2n + denominator) / (2n * denominator)));
  if (!Number.isSafeInteger(sample)) throw unverifiedSourceClock();
  return sample;
}

async function firstDecodedSample(source: TimelineSpeedAudioSource, selector: string, kind: 'audio' | 'video',
  options: TimelineSpeedAudioEffects): Promise<number> {
  try {
    const probe = await withProbePermit(options.signal, () => run('ffprobe', [
      '-v', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', demuxers,
      '-select_streams', selector, '-read_intervals', '%+#512', '-show_frames', '-show_streams',
      '-show_entries', 'frame=pts,best_effort_timestamp:stream=codec_type,time_base', '-of', 'json', source.file,
    ], {signal: options.signal, beforeSpawn: options.beforeEffect, beforeEffect: options.beforeEffect,
      maxStdoutBytes: 128 * 1024, timeout: 15_000}));
    return sourceFrameTimestamp(probe, kind);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error &&
        ['MEDIA_EXIT_FAILED', 'MEDIA_OUTPUT_LIMIT', 'MEDIA_TIMEOUT'].includes(String(error.code))) throw unverifiedSourceClock();
    throw error;
  }
}

async function sourceClockOrigin(source: TimelineSpeedAudioSource, options: TimelineSpeedAudioEffects): Promise<number> {
  // Reverse artifacts use the provider-verified PCM sample interval directly.
  if (source.reversed) {
    const raw = source.reversed.raw;
    if (raw) await verifyRawReverseAudio(source, source.reversed, raw, options);
    return 0;
  }
  const audio = resolveAudioStream(source.streamIndex);
  const picture = source.videoStreamIndex;
  if (picture === undefined || picture === null) return firstDecodedSample(source, audio, 'audio', options);
  const video = String(picture);
  if (!/^(?:v:)?(?:0|[1-9]\d{0,4})$/u.test(video)) throw unverifiedSourceClock();
  const origin = await firstDecodedSample(source, video, 'video', options);
  await firstDecodedSample(source, audio, 'audio', options);
  return origin;
}

async function verifyRawReverseAudio(source: TimelineSpeedAudioSource, clock: ReverseAudio, raw: RawReverseAudio,
  options: TimelineSpeedAudioEffects): Promise<void> {
  if (!Number.isSafeInteger(raw.sampleRate) || raw.sampleRate < 8_000 || raw.sampleRate > 192_000 ||
      !Number.isSafeInteger(raw.channels) || raw.channels < 1 || raw.channels > 8 ||
      typeof raw.layout !== 'string' || !/^[a-zA-Z0-9_ .()+-]{1,64}$/u.test(raw.layout)) throw unverifiedSourceClock();
  const inputStart = BigInt(clock.fromSample) * BigInt(raw.sampleRate), inputEnd = BigInt(clock.toSample) * BigInt(raw.sampleRate);
  const outputRate = BigInt(sampleRate);
  if (inputStart % outputRate || inputEnd % outputRate) throw invalid('REVERSE_PCM_WINDOW');
  const bytes = (inputEnd - inputStart) / outputRate * BigInt(4 * raw.channels);
  checkMediaEffect(options.beforeEffect, options.signal);
  const file = await lstat(source.file, {bigint: true});
  checkMediaEffect(options.beforeEffect, options.signal);
  if (!file.isFile() || file.size !== bytes) throw invalid('REVERSE_PCM_WINDOW');
  const channelCount = await withProbePermit(options.signal, () => run('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', ...inputPcmArgs(source), '-select_streams', resolveAudioStream(source.streamIndex),
    '-show_entries', 'stream=channels', '-of', 'csv=p=0', source.file,
  ], {signal: options.signal, beforeSpawn: options.beforeEffect, beforeEffect: options.beforeEffect,
    maxStdoutBytes: 4096, timeout: 15_000}));
  if (channelCount.trim() !== String(raw.channels)) throw unverifiedSourceClock();
}

type PcmConsumer = (chunk: Buffer) => Promise<void>;
type Fence = () => void;

async function readPcm(source: TimelineSpeedAudioSource, origin: number, window: SampleWindow, options: TimelineSpeedAudioEffects,
  onStdout: PcmConsumer, stretch?: {readonly filter: string; readonly start: number; readonly end: number}): Promise<number> {
  const length = (stretch ? stretch.end - stretch.start : window.end - window.start) * bytesPerSample;
  if (!(length > 0 && length <= MEDIA_RUNTIME_LIMITS.streamingStdoutBytes)) throw budget();
  const stream = resolveAudioStream(source.streamIndex);
  const pad = source.reversed ? '' : `apad=whole_len=${window.end},`;
  const timestamps = source.reversed ? 'asetpts=PTS-STARTPTS,aresample=48000' :
    `asettb=1/48000,asetpts=PTS-(${origin}),aresample=48000:async=1:first_pts=0`;
  const clip = `${timestamps},aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo,` +
    `${pad}atrim=start_sample=${window.start}:end_sample=${window.end},asettb=1/48000,asetpts=N`;
  const filters = stretch
    ? `${clip},${stretch.filter},atrim=start_sample=${stretch.start}:end_sample=${stretch.end},asetpts=N/SR/TB`
    : clip;
  const {stdoutBytes} = await runStreamingWithBackpressure('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-copyts',
    '-protocol_whitelist', 'file,pipe', ...inputPcmArgs(source),
    '-reinit_filter', '0', '-i', source.file, '-map', `0:${stream}`, '-vn', '-sn', '-dn', '-filter_threads', '1',
    '-af', filters, '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1',
  ], {signal: options.signal, beforeSpawn: options.beforeEffect, beforeEffect: options.beforeEffect,
    maxStdoutBytes: length, onStdout});
  if (stdoutBytes % bytesPerSample || !stretch && stdoutBytes !== length) throw invalid('DECODED_SAMPLE_COUNT');
  return stdoutBytes / bytesPerSample;
}

async function writeBytes(handle: FileHandle, data: Buffer, fence: Fence): Promise<void> {
  for (let offset = 0; offset < data.length;) {
    fence();
    const result = await handle.write(data, offset, data.length - offset, null);
    fence();
    if (!result.bytesWritten) throw budget();
    offset += result.bytesWritten;
  }
}

/** Catmull–Rom interpolation, matching the SP-E0 continuous-resampling probe. */
function interpolate(p0: number, p1: number, p2: number, p3: number, phase: number): number {
  if (!Number.isFinite(p0) || !Number.isFinite(p1) || !Number.isFinite(p2) || !Number.isFinite(p3)) {
    throw invalid('NONFINITE_PCM');
  }
  return 0.5 * (2 * p1 + phase * ((-p0 + p2) + phase * ((2 * p0 - 5 * p1 + 4 * p2 - p3) +
    phase * (-p0 + 3 * p1 - 3 * p2 + p3))));
}

function pcmReadWindow(window: SampleWindow, localPosition: (sample: number) => number, from: number, to: number): SampleWindow {
  const first = localPosition(from), last = localPosition(to - 1);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last ||
      first < window.start - 1 || last > window.end) throw invalid('PCM_CLOCK_ORDER');
  const start = Math.max(window.start, Math.min(window.end - 1, Math.floor(first) - 1));
  return {start, end: Math.max(start + 1, Math.min(window.end, Math.floor(last) + 3))};
}

function pitchShiftClock(plan: CompiledTimeMap, timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>,
  motionSamples: number, from: number, to: number, reverseEnd?: number) {
  const speed = timing.basis.speed;
  const position = createSpeedAudioSourceClock(plan, motionSamples, constantSourceRate(timing),
    speed.kind === 'curve' ? speed.points : []);
  const localPosition = reverseEnd === undefined ? position : (sample: number) => reverseEnd - position(sample);
  const range = plan.root.sourceRange;
  const start = sampleBoundary(range.start), end = sampleBoundary(range.end);
  if (start >= end) throw invalid('EMPTY_SOURCE_PCM');
  const bounds = reverseEnd === undefined ? {start, end} : {start: reverseEnd - end, end: reverseEnd - start};
  return {window: pcmReadWindow(bounds, localPosition, from, to), localPosition};
}

function tempoSourceWindow(plan: CompiledTimeMap, timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>,
  motionSamples: number): SampleWindow {
  const complete = unwrap(restoreTimeMap(plan.root, {...timing.view,
    outputWindow: {fromFrame: 0, toFrame: Math.ceil(motionSamples / samplesPerFrame)}}));
  const {start, end} = unwrap(timeMapSourceRangeForEdit(complete));
  return {start: sampleBoundary(start), end: sampleBoundary(end)};
}

/** On the original 48 kHz clock, including interpolation or WSOLA history. */
export function timelineReverseAudioClock(plan: CompiledTimeMap, timing: ClipTiming):
  {readonly fromSample: number; readonly toSample: number} | null {
  if (timing.profile !== 'timeline-speed-v1' || plan.direction !== 'reverse') return null;
  const motionSamples = motionLength(plan, timing);
  const from = plan.outputWindow.fromFrame * samplesPerFrame;
  const to = Math.min(from + plan.durationFrames * samplesPerFrame, motionSamples);
  if (to <= from) return null;
  if (pitchPreservingRate(timing)) {
    const source = tempoSourceWindow(plan, timing, motionSamples);
    return {fromSample: source.start, toSample: source.end};
  }
  const end = sampleBoundary(plan.root.sourceRange.end);
  const {window} = pitchShiftClock(plan, timing, motionSamples, from, to, end);
  return {fromSample: end - window.end, toSample: end - window.start};
}

type SpeedPcmInput = Omit<TimelineSpeedAudioInput, 'destination'>;

async function pitchShift(input: SpeedPcmInput, timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>,
  options: TimelineSpeedAudioEffects, writePcm: PcmConsumer, fence: Fence,
  motionSamples: number, from: number, to: number, origin: number): Promise<void> {
  if (to <= from) return;
  const reversed = input.source.reversed;
  const {window: {start, end}, localPosition} = pitchShiftClock(input.plan, timing, motionSamples, from, to, reversed?.toSample);
  if (reversed && (start < 0 || end > reversed.toSample - reversed.fromSample)) throw invalid('REVERSE_PCM_WINDOW');
  const clamp = (index: number): number => Math.max(start, Math.min(end - 1, index));

  let pending = Buffer.alloc(0);
  let pendingStart = start;
  let outputSample = from;
  let position = localPosition(outputSample);
  const batch = Buffer.allocUnsafe(outputBatchSamples * bytesPerSample);
  let written = 0;
  const consume = async (chunk: Buffer): Promise<void> => {
    fence();
    const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const availableEnd = pendingStart + Math.floor(buffer.length / bytesPerSample);
    while (outputSample < to) {
      const integer = Math.floor(position);
      const phase = position - integer;
      const first = clamp(integer - 1), last = clamp(integer + 2);
      if (last >= availableEnd) break;
      if (first < pendingStart) throw invalid('PCM_CLOCK_ORDER');
      const p0 = (first - pendingStart) * bytesPerSample;
      const p1 = (clamp(integer) - pendingStart) * bytesPerSample;
      const p2 = (clamp(integer + 1) - pendingStart) * bytesPerSample;
      const p3 = (last - pendingStart) * bytesPerSample;
      for (let channel = 0; channel < bytesPerSample; channel += 4) {
        const value = interpolate(buffer.readFloatLE(p0 + channel), buffer.readFloatLE(p1 + channel),
          buffer.readFloatLE(p2 + channel), buffer.readFloatLE(p3 + channel), phase);
        if (!Number.isFinite(Math.fround(value))) throw invalid('NONFINITE_PCM');
        batch.writeFloatLE(value, written + channel);
      }
      written += bytesPerSample;
      outputSample++;
      if (outputSample < to) position = localPosition(outputSample);
      if (written === batch.length) {
        await writePcm(batch);
        written = 0;
      }
    }
    const keepFrom = outputSample < to ? Math.min(availableEnd, clamp(Math.floor(position) - 1)) : availableEnd;
    const keepOffset = (keepFrom - pendingStart) * bytesPerSample;
    pending = Buffer.from(buffer.subarray(keepOffset));
    pendingStart = keepFrom;
  };
  for (let cursor = start; cursor < end;) {
    const next = Math.min(end, cursor + maximumPipeSamples);
    await readPcm(input.source, origin, {start: cursor, end: next}, options, consume);
    cursor = next;
  }
  if (outputSample !== to || pending.length) throw invalid('RESAMPLED_SAMPLE_COUNT');
  if (written) await writePcm(batch.subarray(0, written));
}

async function tempo(input: SpeedPcmInput, timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>,
  options: TimelineSpeedAudioEffects, writePcm: PcmConsumer, fence: Fence, motionSamples: number, from: number, to: number,
  rate: TimeMapSpeedRate, origin: number): Promise<number> {
  if (to <= from) return 0;
  // All windows with this view start in the same WSOLA state. Trim after the
  // one continuous chain, retaining its preceding context for later windows.
  const source = localWindow(input.source, tempoSourceWindow(input.plan, timing, motionSamples));
  if (source.start >= source.end) throw invalid('EMPTY_SOURCE_PCM');
  const step = rate.numerator / rate.denominator;
  const chain = step === 2 ? 'atempo=2' : `atempo=2,atempo=${step / 2}`;
  // Short views can emit no samples before the cascaded WSOLA stages flush.
  // Supply zero context outside the already-trimmed source and crop the output clock as usual.
  const filter = source.end - source.start < shortTempoContextSamples
    ? `apad=pad_len=${shortTempoContextSamples},${chain}` : chain;
  let pending = Buffer.alloc(0);
  const emitted = await readPcm(input.source, origin, source, options, async chunk => {
    const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const end = buffer.length - buffer.length % bytesPerSample;
    for (let offset = 0; offset < end; offset += 4) {
      if (!Number.isFinite(buffer.readFloatLE(offset))) throw invalid('NONFINITE_PCM');
    }
    if (end) {fence(); await writePcm(buffer.subarray(0, end));}
    pending = Buffer.from(buffer.subarray(end));
  }, {filter, start: from, end: to});
  if (pending.length || to - from - emitted > maximumTempoTailSamples) throw invalid('TEMPO_TAIL_TOO_SHORT');
  return emitted;
}

/** One output sample clock for both export staging and audition windows. */
export async function renderTimelineSpeedAudioPcm(input: SpeedPcmInput, options: TimelineSpeedAudioEffects,
  createSink: () => PcmConsumer | Promise<PcmConsumer>): Promise<number | null> {
  const {timing, plan, source} = input;
  const fence = (): void => checkMediaEffect(options.beforeEffect, options.signal);
  fence();
  if (timing.profile === 'timeline-freeze-v1') return null;
  if ((plan.direction === 'reverse') !== Boolean(source.reversed)) throw invalid('REVERSE_PCM_WINDOW');
  if (source.reversed && (!Number.isSafeInteger(source.reversed.fromSample) || !Number.isSafeInteger(source.reversed.toSample) ||
      source.reversed.fromSample < 0 || source.reversed.toSample <= source.reversed.fromSample)) throw invalid('REVERSE_PCM_WINDOW');
  const tempoRate = pitchPreservingRate(timing);
  const samples = plan.durationFrames * samplesPerFrame;
  if (samples <= 0 || !Number.isSafeInteger(samples) || samples > maximumPipeSamples) throw budget();
  const motionSamples = motionLength(plan, timing);
  if (!(motionSamples > 0)) throw invalid('EMPTY_VIEW_PCM');
  const from = plan.outputWindow.fromFrame * samplesPerFrame;
  const to = Math.max(from, Math.min(from + samples, motionSamples));
  const origin = to === from ? 0 : await sourceClockOrigin(source, options);
  fence();
  const consume = await createSink();
  fence();
  const writePcm = async (chunk: Buffer): Promise<void> => {fence(); await consume(chunk); fence();};
  let emitted = to - from;
  if (tempoRate) emitted = await tempo(input, timing, options, writePcm, fence, motionSamples, from, to, tempoRate, origin);
  else await pitchShift(input, timing, options, writePcm, fence, motionSamples, from, to, origin);
  const silence = Buffer.alloc(outputBatchSamples * bytesPerSample);
  for (let pending = samples - emitted; pending > 0;) {
    const count = Math.min(pending, outputBatchSamples);
    await writePcm(silence.subarray(0, count * bytesPerSample));
    pending -= count;
  }
  return samples;
}

/** Private output-coordinate PCM consumed by every export segment. */
export async function prepareTimelineSpeedAudio(input: TimelineSpeedAudioInput, options: TimelineSpeedAudioOptions):
  Promise<{readonly path: string; readonly samples: number} | null> {
  const {destination} = input;
  const fence = (): void => checkMediaEffect(options.beforeEffect, options.signal);
  let handle: FileHandle | undefined;
  let failed = false;
  try {
    const samples = await renderTimelineSpeedAudioPcm(input, options, async () => {
      const output = await options.openOwnedFile(destination);
      handle = output;
      return chunk => writeBytes(output, chunk, fence);
    });
    if (samples === null) return null;
    const info = await handle?.stat();
    fence();
    if (!info?.isFile() || info.size !== samples * bytesPerSample) throw invalid('STAGED_SAMPLE_COUNT');
    return {path: destination, samples};
  } catch (error) {
    failed = true;
    if (error && typeof error === 'object' && 'code' in error && ['ENOSPC', 'EDQUOT'].includes(String(error.code))) throw budget();
    throw error;
  } finally {
    await handle?.close().catch(error => {if (!failed) throw error;});
  }
}
