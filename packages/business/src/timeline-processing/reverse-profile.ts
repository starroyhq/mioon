import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ClipTiming} from '../../../contracts/src/timeline-speed.ts';
import type {CompiledTimeMap, TimeMapSourceBoundary, TimeMapSourceWindow, TimeMapTimebase} from '../../../contracts/src/timeline-time-map.ts';
import {restoreTimeMap, timeMapRootInfo, timeMapSourceRangeForEdit, timeMapSourceWindowForOutput, TIMELINE_TIME_MAP_LIMITS} from '../../../contracts/src/timeline-time-map.ts';
import {checkMediaEffect, run} from '../media-runtime.ts';
import {withProbePermit} from '../media-probe.ts';
import {MANAGED_FILE_IO_LIMITS} from '../managed-file-io.ts';
import {PROCESSING_CACHE_LIMIT_BYTES} from './cache.ts';
import {reverseError, runReverseTool} from './reverse-io.ts';
import type {ReverseProxyMediaOptions} from './reverse-io.ts';

export const REVERSE_PROXY_PROFILE = 'timeline-reverse-source-v1' as const;
export const REVERSE_PROXY_COVERAGE_VERSION = 2 as const;
export const REVERSE_PROXY_RESERVATION_STEP = 64 * 1024 ** 2;
const exportAudioRate = 48_000;
const exportSamplesPerFrame = exportAudioRate / 30;
const mib = 1024 ** 2;
// Decoders get one thread and restricted frame dimensions. Interframe codecs
// may hold a decoded-picture buffer; FFV1 encodes only four slices in parallel.
export const REVERSE_PROXY_LIMITS = Object.freeze({
  sourceChunkSeconds: 2, processBytes: 1024 ** 3, maxPixels: 16_777_216,
  interFrameBytes: 24 * mib, intraFrameBytes: 64 * mib, ffv1PacketAllocation: 512 * mib, nativeFrames: 1_000_000,
});
export const reverseToolBase = ['-hide_banner', '-nostdin', '-xerror', '-max_alloc', String(128 * mib), '-filter_threads', '1'];
export const colorOptions = {
  color_range: '-color_range', color_space: '-colorspace', color_transfer: '-color_trc', color_primaries: '-color_primaries',
  chroma_location: '-chroma_sample_location',
} as const;
type ColourKey = keyof typeof colorOptions;
type VideoColour = Readonly<Partial<Record<ColourKey, string>>>;
interface Rational { readonly numerator: number; readonly denominator: number }

/** Half-open bounds on the original, forward 48 kHz source clock. */
export interface ReverseProxyAudioCoverage { readonly fromSample: number; readonly toSample: number }

export interface ReverseProxyInput {
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly mapHash: string;
  readonly sourceWindow: TimeMapSourceWindow;
  readonly sourceFps: TimeMapTimebase;
  readonly media: 'video' | 'audio';
  readonly videoStreamIndex?: number;
  readonly audioStreamIndex?: number;
  readonly audioWindow?: ReverseProxyAudioCoverage;
  /** An approved union of visible picture and transition handle windows. */
  readonly pictureWindow?: TimeMapSourceWindow;
}

export interface VideoProfile {
  readonly index: number;
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string;
  readonly frameBytes: number;
  readonly timeBase: Rational;
  readonly sampleAspect: Rational;
  readonly colour: VideoColour;
  readonly threads: 1 | 4;
  readonly encoderAllocationBytes: number;
}
interface AudioProfile {
  readonly index: number;
  readonly codec: string;
  readonly rate: number;
  readonly channels: number;
  readonly layout: string;
  readonly firstMediaSample: number;
}
export interface ReverseProxyProfile {
  readonly id: typeof REVERSE_PROXY_PROFILE;
  readonly coverageVersion: typeof REVERSE_PROXY_COVERAGE_VERSION;
  readonly buildSha256: string;
  readonly storage: 'matroska' | 'raw';
  readonly video: VideoProfile | null;
  readonly audio: AudioProfile | null;
}
export interface PreparedReverseProxy {
  readonly profile: ReverseProxyProfile;
  readonly reservationBytes: number;
}

export interface VideoFrame { readonly pts: number; readonly previousKey: number }
export interface ReverseVideoChunk { readonly start: number; readonly end: number; readonly key: number; }
interface ReverseVideoPlan {
  readonly frames: readonly VideoFrame[];
  readonly chunks: readonly ReverseVideoChunk[];
  readonly frameCount: number;
  readonly endOfStream: number;
  readonly firstSourceOrdinal: number;
  readonly sourceZeroPts: number;
  readonly endSourcePts: number;
}
interface AudioSourceZero {readonly streamIndex: number; readonly pts: string; readonly timeBase: Rational}
interface ReverseAudioPlan {
  readonly startSample: number;
  readonly sampleCount: number;
  readonly sourceCoverage: ReverseProxyAudioCoverage;
  readonly sourceZero: AudioSourceZero;
}
export interface SourceVideoPlan {
  readonly input: Pick<ReverseProxyInput, 'sourcePath'>;
  readonly container: string;
  readonly originUs: number;
  readonly video: Pick<ReverseVideoPlan, 'frames'>;
}
interface PreparedState {
  readonly input: ReverseProxyInput;
  readonly container: string;
  readonly originUs: number;
  readonly video: ReverseVideoPlan | null;
  readonly audio: ReverseAudioPlan | null;
  readonly scratchBytes: number;
  readonly outputBytesLimit: number;
}

const preparedState = new WeakMap<PreparedReverseProxy, PreparedState>();
const unsupported = (): never => {throw reverseError('UNSUPPORTED_FORMAT');};
const hash = /^[a-f0-9]{64}$/;
const timeMapHash = /^[a-f0-9]{16}$/;
const name = /^[a-zA-Z0-9_]+$/;
// NUT can carry the original planar float32 samples without reducing their
// bit depth. All admitted formats are local single-file demuxers.
const containers = ['mov', 'matroska', 'mp3', 'wav', 'nut'] as const;
const intraCodecs = ['ffv1', 'rawvideo', 'prores', 'v210', 'mjpeg', 'png'];
const interCodecs = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4'];
const isIndex = (index: unknown): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= 255;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function snapshotWindow(w: TimeMapSourceWindow): TimeMapSourceWindow {
  if (!w || w.direction !== 'reverse' || ![w.startFrame, w.endFrame, w.outputFromFrame, w.outputToFrame].every(Number.isSafeInteger) ||
      w.startFrame < 0 || w.endFrame <= w.startFrame || w.outputFromFrame < 0 || w.outputToFrame <= w.outputFromFrame ||
      w.frameCount !== w.endFrame - w.startFrame || w.frameCount > TIMELINE_TIME_MAP_LIMITS.maxSourceFrames) return unsupported();
  return Object.freeze({startFrame: w.startFrame, endFrame: w.endFrame, frameCount: w.frameCount, direction: 'reverse',
    outputFromFrame: w.outputFromFrame, outputToFrame: w.outputToFrame});
}

function snapshot(input: ReverseProxyInput): ReverseProxyInput {
  if (typeof input.sourcePath !== 'string' || !path.isAbsolute(input.sourcePath) || input.sourcePath.includes('\0') ||
      !hash.test(input.sourceSha256) || !timeMapHash.test(input.mapHash) || !['video', 'audio'].includes(input.media)) unsupported();
  const fps = input.sourceFps, audio = input.audioWindow;
  const sourceWindow = snapshotWindow(input.sourceWindow);
  const pictureWindow = input.pictureWindow === undefined ? null : snapshotWindow(input.pictureWindow);
  if (!fps ||
      ![fps.fpsNumerator, fps.fpsDenominator].every(n => Number.isInteger(n) && n > 0 && n <= 1_000_000) ||
      (input.videoStreamIndex !== undefined && !isIndex(input.videoStreamIndex)) ||
      (input.audioStreamIndex !== undefined && !isIndex(input.audioStreamIndex))) unsupported();
  if (audio !== undefined && (!audio || ![audio.fromSample, audio.toSample].every(Number.isSafeInteger) ||
      audio.fromSample < 0 || audio.toSample <= audio.fromSample)) unsupported();
  if (pictureWindow && (input.media !== 'video' || pictureWindow.startFrame > sourceWindow.startFrame ||
      pictureWindow.endFrame < sourceWindow.endFrame)) unsupported();
  return Object.freeze({sourcePath: input.sourcePath, sourceSha256: input.sourceSha256, mapHash: input.mapHash, media: input.media,
    sourceWindow, sourceFps: Object.freeze({fpsNumerator: fps.fpsNumerator, fpsDenominator: fps.fpsDenominator}),
    videoStreamIndex: input.videoStreamIndex, audioStreamIndex: input.audioStreamIndex,
    ...(audio ? {audioWindow: Object.freeze({fromSample: audio.fromSample, toSample: audio.toSample})} : {}),
    ...(pictureWindow ? {pictureWindow} : {})});
}

export function reversePreparedState(input: ReverseProxyInput, prepared: PreparedReverseProxy): PreparedState {
  const state = preparedState.get(prepared);
  if (!state || JSON.stringify(snapshot(input)) !== JSON.stringify(state.input)) throw reverseError('SOURCE_UNAVAILABLE');
  return state;
}

export function reverseLocalInput(file: string, container?: string): string[] {
  return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', container ?? containers.join(','),
    ...(container === undefined || container === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    ...(container ? ['-f', container] : []), '-i', file];
}
export function reverseColorArgs(colour: VideoColour): string[] {
  return Object.entries(colour).flatMap(([key, value]) => [colorOptions[key as ColourKey], value === 'gbr' ? 'rgb' : value]);
}

function rational(value: unknown, delimiter = '/'): Rational {
  if (typeof value !== 'string') return unsupported();
  const parts = value.split(delimiter);
  if (parts.length !== 2 || parts.some(part => !/^[1-9][0-9]{0,9}$/.test(part))) return unsupported();
  const [numerator, denominator] = parts.map(Number) as [number, number];
  if (numerator > 1e9 || denominator > 1e9) unsupported();
  return Object.freeze({numerator, denominator});
}

function timeUs(value: unknown): number {
  if (value === 'N/A' || value === undefined) return 0;
  if (typeof value !== 'string' || !/^-?[0-9]{1,9}(?:\.[0-9]{1,6})?$/.test(value)) return unsupported();
  const [seconds, micros = ''] = value.replace('-', '').split('.');
  const result = (value.startsWith('-') ? -1 : 1) * (Number(seconds) * 1_000_000 + Number(micros.padEnd(6, '0')));
  return Number.isSafeInteger(result) ? result : unsupported();
}

function asInteger(value: unknown): number | null {
  if (typeof value === 'string' && /^-?[0-9]{1,16}$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function pixelBytes(format: string, width: number, height: number): number {
  const yuv = /^yuv(a?)(420|422|444|440|411|410)p(?:(9|10|12|14|16)le)?$/.exec(format);
  if (yuv) {
    const subX = {420: 2, 422: 2, 444: 1, 440: 1, 411: 4, 410: 4}[yuv[2] as '420'];
    const subY = {420: 2, 422: 1, 444: 1, 440: 2, 411: 1, 410: 4}[yuv[2] as '420'];
    return ((yuv[1] ? 2 : 1) * width * height + 2 * Math.ceil(width / subX) * Math.ceil(height / subY)) * (yuv[3] ? 2 : 1);
  }
  const rgb = /^gbr(a?)p(?:(9|10|12|14|16|f32)le)?$/.exec(format);
  if (rgb) return (rgb[1] ? 4 : 3) * width * height * (rgb[2] === 'f32' ? 4 : rgb[2] ? 2 : 1);
  const gray = /^gray(?:(9|10|12|14|16|f32)le)?$/.exec(format);
  if (gray) return width * height * (gray[1] === 'f32' ? 4 : gray[1] ? 2 : 1);
  if (['bgra', 'bgr0'].includes(format)) return width * height * 4;
  return unsupported();
}

function makeVideo(stream: Record<string, unknown>): VideoProfile {
  const index = stream.index, codec = stream.codec_name, width = asInteger(stream.width), height = asInteger(stream.height);
  const pixelFormat = stream.pix_fmt;
  if (!isIndex(index) || typeof codec !== 'string' || (!intraCodecs.includes(codec) && !interCodecs.includes(codec)) ||
      typeof pixelFormat !== 'string' || !width || !height || width < 1 || height < 1 || width * height > REVERSE_PROXY_LIMITS.maxPixels ||
      (stream.field_order !== undefined && stream.field_order !== 'unknown' && stream.field_order !== 'progressive')) return unsupported();
  if (Array.isArray(stream.side_data_list) && stream.side_data_list.some(each => isRecord(each) &&
    (Object.hasOwn(each, 'rotation') || /display matrix/i.test(String(each.side_data_type))))) unsupported();
  const frameBytes = pixelBytes(pixelFormat, width, height);
  const limit = intraCodecs.includes(codec) ? REVERSE_PROXY_LIMITS.intraFrameBytes : REVERSE_PROXY_LIMITS.interFrameBytes;
  if (frameBytes > limit) unsupported();
  // FFV1 v3 allocates a worst-case packet before it sees the actual entropy
  // of a frame. The allowance includes its geometric allocation growth.
  const encoderAllocationBytes = pixelFormat.endsWith('f32le') ? 0 : Math.max(128 * mib, Math.ceil(width * height * 148 * 17 / 16) + mib);
  // Budget two live packet allocations, the fixed encoder/mux queues and a
  // reserve for the executable, decoder state and FFV1 slice contexts.
  const estimatedEncoderBytes = encoderAllocationBytes * 2 + frameBytes * 8 + 160 * mib;
  if (encoderAllocationBytes > REVERSE_PROXY_LIMITS.ffv1PacketAllocation || estimatedEncoderBytes > REVERSE_PROXY_LIMITS.processBytes) unsupported();
  const colour: Partial<Record<ColourKey, string>> = {};
  for (const key of Object.keys(colorOptions) as ColourKey[]) {
    const value = stream[key];
    if (value === undefined || value === 'unknown' || value === 'unspecified' || value === 'N/A') continue;
    if (typeof value !== 'string' || !name.test(value)) return unsupported();
    colour[key] = value;
  }
  return Object.freeze({index, codec, width, height, pixelFormat, frameBytes, timeBase: rational(stream.time_base),
    sampleAspect: stream.sample_aspect_ratio === undefined || stream.sample_aspect_ratio === 'N/A' || stream.sample_aspect_ratio === '0:1'
      ? Object.freeze({numerator: 1, denominator: 1}) : rational(stream.sample_aspect_ratio, ':'),
    colour: Object.freeze(colour), threads: pixelFormat === 'gbrap16le' ? 4 : 1, encoderAllocationBytes});
}

async function firstDecodedTimestamp(stream: Record<string, unknown>, input: ReverseProxyInput, container: string,
  options: ReverseProxyMediaOptions): Promise<AudioSourceZero> {
  const index = stream.index, timeBase = rational(stream.time_base);
  if (!isIndex(index)) return unsupported();
  const text = await withProbePermit(options.signal, () => run('ffprobe', [
    '-v', 'error', '-threads', '1', '-max_alloc', String(128 * mib), '-max_pixels', String(REVERSE_PROXY_LIMITS.maxPixels),
    '-select_streams', String(index), '-read_intervals', '%+#512', '-show_frames',
    '-show_entries', 'frame=pts,best_effort_timestamp', '-of', 'json', ...reverseLocalInput(input.sourcePath, container),
  ], {...options, beforeSpawn: options.beforeEffect, maxStdoutBytes: 128 * 1024, timeout: 15_000}));
  let data: unknown;
  try {data = JSON.parse(text);} catch {return unsupported();}
  const first = isRecord(data) && Array.isArray(data.frames) ? data.frames[0] : null;
  if (!isRecord(first)) return unsupported();
  const pts = asInteger(first.pts);
  if (pts === null || asInteger(first.best_effort_timestamp) !== pts) return unsupported();
  return Object.freeze({streamIndex: index, pts: String(pts), timeBase});
}

function timestampSample(timestamp: AudioSourceZero, rate: number): number {
  const {numerator, denominator} = timestamp.timeBase;
  const scaled = BigInt(timestamp.pts) * BigInt(numerator) * BigInt(rate), divisor = BigInt(denominator);
  const sign = scaled < 0n ? -1n : 1n;
  return safeNumber(sign * ((2n * sign * scaled + divisor) / (2n * divisor)));
}

async function makeAudio(stream: Record<string, unknown>, picture: Record<string, unknown> | undefined,
  input: ReverseProxyInput, container: string, options: ReverseProxyMediaOptions):
  Promise<{profile: AudioProfile; plan: ReverseAudioPlan}> {
  const index = stream.index, codec = stream.codec_name, rate = asInteger(stream.sample_rate), channels = asInteger(stream.channels);
  if (!isIndex(index) || typeof codec !== 'string' || !name.test(codec) || !rate || rate < 8000 || rate > 192000 || !channels || channels < 1 || channels > 8) return unsupported();
  const layout = stream.channel_layout && stream.channel_layout !== 'unknown' ? stream.channel_layout : channels === 1 ? 'mono' : channels === 2 ? 'stereo' : null;
  if (typeof layout !== 'string' || !/^[a-zA-Z0-9_ .()+-]{1,64}$/.test(layout)) return unsupported();
  const audioStart = await firstDecodedTimestamp(stream, input, container, options);
  // Match SP-E: the source clock starts at the first decoded picture, or at
  // the first decoded audio sample when the source has no picture stream.
  const sourceZero = picture ? await firstDecodedTimestamp(picture, input, container, options) : audioStart;
  const firstMediaSample = timestampSample(audioStart, rate) - timestampSample(sourceZero, rate);
  if (!Number.isSafeInteger(firstMediaSample)) return unsupported();
  return {profile: Object.freeze({index, codec, rate, channels, layout, firstMediaSample}),
    plan: audioPlan(input, sourceZero, rate)};
}

export async function reverseProbe(file: string, options: ReverseProxyMediaOptions, container?: string): Promise<{format: Record<string, unknown>; streams: Record<string, unknown>[]}> {
  return withProbePermit(options.signal, async () => {
    const text = await run('ffprobe', ['-v', 'error', '-threads', '1', '-max_pixels', String(REVERSE_PROXY_LIMITS.maxPixels),
      '-show_format', '-show_streams', '-of', 'json', ...reverseLocalInput(file, container)],
    {...options, beforeSpawn: options.beforeEffect, maxStdoutBytes: 512 * 1024});
    let data: unknown;
    try {data = JSON.parse(text);} catch {return unsupported();}
    if (!isRecord(data) || !isRecord(data.format) || !Array.isArray(data.streams) || data.streams.length > 256 || !data.streams.every(isRecord)) return unsupported();
    return {format: data.format, streams: data.streams};
  });
}

function floorRatio(n: bigint, d: bigint): bigint {
  const quotient = n / d;
  return n < 0n && n % d !== 0n ? quotient - 1n : quotient;
}
const ceilRatio = (n: bigint, d: bigint): bigint => -floorRatio(-n, d);
function safeNumber(value: bigint): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : unsupported();
}
function tickBound(frame: number, fps: TimeMapTimebase, timeBase: Rational, mode: 'floor' | 'ceil'): number {
  const num = BigInt(frame) * BigInt(fps.fpsDenominator) * BigInt(timeBase.denominator);
  const den = BigInt(fps.fpsNumerator) * BigInt(timeBase.numerator);
  return safeNumber(mode === 'floor' ? floorRatio(num, den) : ceilRatio(num, den));
}

function sourceSampleBoundary(boundary: TimeMapSourceBoundary): number {
  const numerator = BigInt(boundary.kind === 'rational' ? boundary.numerator : boundary.ticks);
  const denominator = boundary.kind === 'rational' ? BigInt(boundary.denominator) : 1n << 64n;
  return safeNumber(ceilRatio(numerator * BigInt(exportSamplesPerFrame), denominator));
}

function tempoAudioCoverage(plan: CompiledTimeMap, timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>): ReverseProxyAudioCoverage | undefined {
  const {rootLength} = timeMapRootInfo(plan.root);
  if (rootLength.kind !== 'exact') return unsupported();
  const {loTime, hiTime} = timing.view;
  const samples = BigInt(exportSamplesPerFrame);
  const offset = BigInt(hiTime.offsetOutputFrames - loTime.offsetOutputFrames);
  const span = loTime.anchor === hiTime.anchor ? 0n : hiTime.anchor === 'end' ? 1n : -1n;
  const divisor = BigInt(rootLength.denominator);
  const count = ceilRatio((span * BigInt(rootLength.numerator) + offset * divisor) * samples, divisor);
  if (count <= BigInt(plan.outputWindow.fromFrame) * samples) return;
  const complete = restoreTimeMap(plan.root, {...timing.view,
    outputWindow: {fromFrame: 0, toFrame: safeNumber(ceilRatio(count, samples))}});
  if (!complete.ok) return unsupported();
  const range = timeMapSourceRangeForEdit(complete.value);
  if (!range.ok) return unsupported();
  return {fromSample: sourceSampleBoundary(range.value.start), toSample: sourceSampleBoundary(range.value.end)};
}

function interpolationAudioCoverage(plan: CompiledTimeMap): ReverseProxyAudioCoverage {
  const range = timeMapSourceRangeForEdit(plan);
  if (!range.ok) return unsupported();
  const {start, end} = plan.root.sourceRange;
  // SP-E uses [floor(xFirst) - 1, floor(xLast) + 3) for cubic interpolation
  // in reversed PCM coordinates. Converting back flips the margins. Allow
  // one extra sample for its sub-sample inverse approximation at a boundary.
  return {fromSample: Math.max(sourceSampleBoundary(start), sourceSampleBoundary(range.value.start) - 4),
    toSample: Math.min(sourceSampleBoundary(end), sourceSampleBoundary(range.value.end) + 2)};
}

/** The continuous audio read can extend beyond the last discrete video frame.
 * Pitch-preserving 2–4× also needs the complete motion view for tempo history. */
export function reverseAudioCoverage(plan: CompiledTimeMap, timing: ClipTiming): ReverseProxyAudioCoverage | undefined {
  if (timing.profile !== 'timeline-speed-v1' || plan.direction !== 'reverse') return;
  const {sourceFps, outputFps} = plan.root;
  if ([sourceFps, outputFps].some(fps => fps.fpsNumerator !== 30 || fps.fpsDenominator !== 1)) return unsupported();
  const speed = timing.basis.speed;
  const tempo = !timing.pitchShift && speed.kind === 'constant' && speed.rate.numerator >= 2 * speed.rate.denominator &&
    speed.rate.numerator <= 4 * speed.rate.denominator;
  const coverage = tempo ? tempoAudioCoverage(plan, timing) : interpolationAudioCoverage(plan);
  if (!coverage) return;
  const {fromSample, toSample} = coverage;
  if (fromSample < 0 || fromSample >= toSample) return unsupported();
  const visible = timeMapSourceWindowForOutput(plan);
  if (!visible.ok) return unsupported();
  if (fromSample >= visible.value.startFrame * exportSamplesPerFrame && toSample <= visible.value.endFrame * exportSamplesPerFrame) return;
  return Object.freeze({fromSample, toSample});
}

function commonDivisor(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function audioPlan(input: ReverseProxyInput, sourceZero: AudioSourceZero, rate: number): ReverseAudioPlan {
  const {startFrame, endFrame} = input.sourceWindow;
  const {fpsNumerator, fpsDenominator} = input.sourceFps;
  const [exportGridNumerator, exportGridDenominator] = [BigInt(exportAudioRate) * BigInt(fpsDenominator), BigInt(fpsNumerator)];
  const start = floorRatio(BigInt(startFrame) * exportGridNumerator, exportGridDenominator);
  const end = ceilRatio(BigInt(endFrame) * exportGridNumerator, exportGridDenominator);
  const extra = input.audioWindow;
  const first = extra ? BigInt(extra.fromSample) : start;
  const last = extra ? BigInt(extra.toSample) : end;
  // Outward alignment makes each endpoint exactly representable in both the
  // native PCM and export clocks, including raw fallback at 44.1 kHz.
  const divisor = commonDivisor(exportAudioRate, rate);
  const exportStep = BigInt(exportAudioRate / divisor), nativeStep = BigInt(rate / divisor);
  const from = floorRatio(start < first ? start : first, exportStep);
  const to = ceilRatio(end > last ? end : last, exportStep);
  return Object.freeze({startSample: safeNumber(from * nativeStep), sampleCount: safeNumber((to - from) * nativeStep), sourceZero,
    sourceCoverage: Object.freeze({fromSample: safeNumber(from * exportStep), toSample: safeNumber(to * exportStep)})});
}

function lowerBound(frames: readonly VideoFrame[], pts: number, allowEqual = true): number {
  let lo = 0, hi = frames.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2), value = frames[mid]!.pts;
    if (value < pts || !allowEqual && value === pts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type VideoSourceInput = Pick<ReverseProxyInput, 'sourcePath' | 'sourceWindow' | 'sourceFps' | 'pictureWindow'>;

async function buildVideoPlan(input: VideoSourceInput, profile: VideoProfile, container: string, options: ReverseProxyMediaOptions): Promise<ReverseVideoPlan> {
  const {sourceFps: fps} = input, w = input.pictureWindow ?? input.sourceWindow;
  const startOffset = tickBound(w.startFrame, fps, profile.timeBase, 'floor');
  const endOffset = tickBound(w.endFrame, fps, profile.timeBase, 'ceil');
  const frames: VideoFrame[] = [];
  let pending = '', previousKey = -1, lastDuration = 0;
  const endIndexed = new Error('The reverse source window has been indexed.');
  // These local video envelopes carry one presentation frame per packet.
  // The decoder still proves the packet PTS and frame count in every chunk.
  // Avoid decoding the entire prefix once just to index a lossless source.
  const usePackets = intraCodecs.includes(profile.codec);
  const accept = (line: string): void => {
    if (!line) return;
    // compact can append side data to a frame and print empty lines after it.
    const pts = asInteger((usePackets ? /(?:^|\|)pts=(-?[0-9]+)(?:\||$)/ : /(?:^|\|)best_effort_timestamp=(-?[0-9]+)(?:\||$)/).exec(line)?.[1]);
    const flag = (usePackets ? /(?:^|\|)flags=([A-Z_]*)/ : /(?:^|\|)key_frame=([01])(?:\||$)/).exec(line)?.[1];
    if (pts === null || flag === undefined || Math.abs(pts) >= 2 ** 50 || frames.length >= REVERSE_PROXY_LIMITS.nativeFrames ||
        (frames.length && pts <= frames.at(-1)!.pts)) return unsupported();
    const duration = /\|(?:duration|pkt_duration)=([0-9]+)(?:\||$)/.exec(line);
    lastDuration = asInteger(duration?.[1]) ?? 0;
    if (usePackets ? flag.startsWith('K') : flag === '1') previousKey = frames.length;
    frames.push({pts, previousKey});
    // The successor proves the exclusive bound. There is no need to decode
    // the unused tail of a long source.
    if (pts - frames[0]!.pts >= endOffset) throw endIndexed;
  };
  try {
    await runReverseTool('ffprobe', ['-v', 'error', '-threads', '1', '-max_alloc', String(128 * mib), '-max_pixels', String(REVERSE_PROXY_LIMITS.maxPixels),
      '-select_streams', String(profile.index), usePackets ? '-show_packets' : '-show_frames',
      '-show_entries', usePackets ? 'packet=pts,duration,flags' : 'frame=key_frame,best_effort_timestamp,duration,pkt_duration', '-of', 'compact=p=0:nk=0',
      ...reverseLocalInput(input.sourcePath, container)], options, {timeoutMs: 600_000, stdoutLimit: 160 * REVERSE_PROXY_LIMITS.nativeFrames,
      stdout(chunk) {
        const lines = (pending + chunk.toString('utf8')).split('\n');
        pending = lines.pop() ?? '';
        if (pending.length > 4096) unsupported();
        for (const line of lines) accept(line.trim());
      }});
    accept(pending.trim());
  } catch (error) {
    if (error !== endIndexed) throw error;
  }
  checkMediaEffect(options.beforeEffect, options.signal);
  if (!frames.length || frames[0]!.previousKey !== 0) unsupported();
  // Source frame zero is the first picture. The demuxer's format start can
  // belong to an earlier audio stream and is only used for seek addressing.
  const sourceZeroPts = frames[0]!.pts;
  const startPts = safeNumber(BigInt(sourceZeroPts) + BigInt(startOffset));
  const endPts = safeNumber(BigInt(sourceZeroPts) + BigInt(endOffset));
  const finalPts = frames.at(-1)!.pts;
  // Containers such as Matroska express frame end in a coarser timebase than
  // the project clock. Allow one tick of quantisation when the duration is
  // known. Never silently make an arbitrarily long source window from one frame.
  const endOfStream = finalPts + (lastDuration || (frames.length > 1 ? finalPts - frames.at(-2)!.pts : 0));
  if (startPts < frames[0]!.pts - 1 || endPts > endOfStream + 1) unsupported();
  const first = Math.max(0, lowerBound(frames, startPts, false) - 1);
  const last = lowerBound(frames, endPts);
  if (last <= first) unsupported();
  const chunks: ReverseVideoChunk[] = [];
  // Use source PTS rather than native frame count, which is not a clock on VFR
  // media. Consecutive chunks own disjoint ordinal windows.
  const maxTicks = Math.ceil(REVERSE_PROXY_LIMITS.sourceChunkSeconds * profile.timeBase.denominator / profile.timeBase.numerator);
  for (let end = last; end > first;) {
    const start = Math.max(first, lowerBound(frames, frames[end - 1]!.pts - maxTicks, false));
    if (start >= end) unsupported();
    chunks.push({start, end, key: frames[start]!.previousKey});
    end = start;
  }
  return {frames, chunks, frameCount: last - first, firstSourceOrdinal: first, sourceZeroPts, endOfStream,
    endSourcePts: frames[last]?.pts ?? endOfStream};
}

function metadataStream(streams: Record<string, unknown>[], kind: 'video' | 'audio', index?: number): Record<string, unknown> | undefined {
  const selected = streams.find(stream => stream.codec_type === kind && (index === undefined || stream.index === index) &&
    !(kind === 'video' && isRecord(stream.disposition) && stream.disposition.attached_pic === 1));
  if (index !== undefined && !selected) return unsupported();
  return selected;
}

async function videoTools(video: VideoProfile | null, options: ReverseProxyMediaOptions): Promise<string> {
  const tools = {...options, beforeSpawn: options.beforeEffect, maxStdoutBytes: 128 * 1024, maxStderrBytes: 64 * 1024};
  const ffmpegVersion = await run('ffmpeg', ['-version'], tools);
  const ffprobeVersion = await run('ffprobe', ['-version'], tools);
  if (video) {
    const encoder = await run('ffmpeg', ['-hide_banner', '-h', 'encoder=ffv1'], tools);
    const formats = /Supported pixel formats:\s*([^\r\n]+)/.exec(encoder)?.[1]?.trim().split(/\s+/) ?? [];
    if (!formats.includes(video.pixelFormat)) unsupported();
  }
  return createHash('sha256').update(JSON.stringify([ffmpegVersion, ffprobeVersion])).digest('hex');
}

export async function prepareSourceVideo(input: VideoSourceInput, admit: (video: VideoProfile) => boolean,
  options: ReverseProxyMediaOptions) {
  const metadata = await reverseProbe(input.sourcePath, options);
  const format = metadata.format.format_name;
  const container = typeof format === 'string' && containers.find(choice => format.split(',').includes(choice));
  const stream = metadataStream(metadata.streams, 'video');
  if (!container || !stream) return unsupported();
  const originUs = timeUs(metadata.format.start_time);
  const video = makeVideo(stream);
  if (!admit(video)) return unsupported();
  return {video, buildSha256: await videoTools(video, options), state: {
    input, originUs, container, video: await buildVideoPlan(input, video, container, options),
  }};
}

export function reverseProxyDiskBudget(storage: ReverseProxyProfile['storage'], rawVideoBytes: number,
  audioBytes: number, blockBytes: number, frameCount: number) {
  const fileLimit = MANAGED_FILE_IO_LIMITS.fileBytes;
  // The decoded audio scratch is removed before the encoder starts. The
  // final PCM, video block and ordinal index can coexist during encoding.
  const scratchBytes = Math.max(2 * audioBytes, audioBytes + blockBytes) + frameCount * 128 + 65536;
  const outputBytesLimit = storage === 'raw' ? rawVideoBytes + audioBytes
    : Math.min(fileLimit, PROCESSING_CACHE_LIMIT_BYTES - scratchBytes);
  const initialOutputBytes = storage === 'raw' ? outputBytesLimit
    : Math.min(outputBytesLimit, REVERSE_PROXY_RESERVATION_STEP, rawVideoBytes + audioBytes + 4 * mib);
  const reservationBytes = scratchBytes + initialOutputBytes;
  if (![audioBytes, blockBytes, ...(storage === 'raw' ? [rawVideoBytes] : [])].every(bytes => bytes <= fileLimit) ||
      outputBytesLimit < 1 || !Number.isSafeInteger(reservationBytes) || reservationBytes > PROCESSING_CACHE_LIMIT_BYTES)
    throw reverseError('CACHE_LIMIT');
  return {scratchBytes, outputBytesLimit, reservationBytes};
}

export async function prepareReverseProxy(value: ReverseProxyInput, options: ReverseProxyMediaOptions): Promise<PreparedReverseProxy> {
  const input = snapshot(value);
  const metadata = await reverseProbe(input.sourcePath, options);
  const format = metadata.format.format_name;
  const container = typeof format === 'string' && containers.find(choice => format.split(',').includes(choice));
  if (!container) return unsupported();
  const originUs = timeUs(metadata.format.start_time);
  const audioStream = metadataStream(metadata.streams, 'audio', input.audioStreamIndex);
  const pictureStream = metadataStream(metadata.streams, 'video', input.videoStreamIndex);
  const videoStream = input.media === 'video' ? pictureStream : undefined;
  if ((input.media === 'video' && !videoStream) || (input.media === 'audio' && !audioStream)) return unsupported();
  const video = videoStream ? makeVideo(videoStream) : null;
  const sound = audioStream ? await makeAudio(audioStream, pictureStream, input, container, options) : null;
  const audio = sound?.profile ?? null;
  const storage = video?.pixelFormat.endsWith('f32le') ? 'raw' : 'matroska';
  const profile: ReverseProxyProfile = Object.freeze({id: REVERSE_PROXY_PROFILE, coverageVersion: REVERSE_PROXY_COVERAGE_VERSION,
    buildSha256: await videoTools(storage === 'matroska' ? video : null, options), storage, video, audio});
  const audioBytes = (sound?.plan.sampleCount ?? 0) * (audio?.channels ?? 0) * 4;
  if (audio && (audioBytes < 1 || audioBytes > MANAGED_FILE_IO_LIMITS.fileBytes)) throw reverseError('CACHE_LIMIT');
  const videoPlan = video ? await buildVideoPlan(input, video, container, options) : null;
  const frameCount = videoPlan?.frameCount ?? 0, frameBytes = video?.frameBytes ?? 0;
  const blockBytes = frameBytes * (videoPlan?.chunks.reduce((max, item) => Math.max(max, item.end - item.start), 0) ?? 0);
  const {scratchBytes, outputBytesLimit, reservationBytes} = reverseProxyDiskBudget(storage, frameCount * frameBytes, audioBytes, blockBytes, frameCount);
  const prepared: PreparedReverseProxy = Object.freeze({profile, reservationBytes});
  preparedState.set(prepared, {input, container, originUs, video: videoPlan, audio: sound?.plan ?? null, scratchBytes, outputBytesLimit});
  return prepared;
}
