import {createHash} from 'node:crypto';
import path from 'node:path';
import {timeMapPlanInfo} from '../../../contracts/src/timeline-time-map.ts';
import type {CompiledTimeMap} from '../../../contracts/src/timeline-time-map.ts';
import type {SpeedInterpolation} from '../../../contracts/src/timeline-speed.ts';
import {SPEED_BUDGET_EXCEEDED, SPEED_MAPPING_INVALID, SPEED_SOURCE_UNSUPPORTED} from '../../../contracts/src/timeline-speed-export.ts';
import {checkMediaEffect} from '../media-runtime.ts';
import {withProbePermit} from '../media-probe.ts';
import {readTimelineVideoSamples} from '../timeline-speed-export-video.ts';
import {PROCESSING_CACHE_LIMIT_BYTES, ProcessingFailure} from './cache.ts';
import {createReverseStaging, finishMediaInput, isDiskFull, readOwnedBytes, runReverseTool, writeMediaInput, writeOwnedBytes} from './reverse-io.ts';
import type {ReverseProxyFile, ReverseProxyMediaOptions} from './reverse-io.ts';
import {REVERSE_PROXY_LIMITS, reverseToolBase} from './reverse-profile.ts';

export const PREVIEW_PROXY_PROFILE = 'timeline-preview-output-v1' as const;
const maxSide = 960;
const maxSourcePixels = REVERSE_PROXY_LIMITS.maxPixels;
const maxBitrate = 8_000_000;
const manifestOverhead = 64 * 1024;
const timeoutMs = 30 * 60 * 1000;
const localInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska'];

type Source = Parameters<typeof readTimelineVideoSamples>[0];
type SourceSamples = Awaited<ReturnType<typeof readTimelineVideoSamples>>;
type VideoIndex = SourceSamples['index'];
type Staging = ReturnType<typeof createReverseStaging>;

export interface PreviewProxyInput {
  readonly source: Source;
  readonly sourceSha256: string;
  readonly plan: CompiledTimeMap;
  readonly interpolation: SpeedInterpolation;
}
export interface PreparedPreviewProxy {
  readonly profile: {
    readonly profileId: typeof PREVIEW_PROXY_PROFILE;
    readonly mapHash: string;
    readonly sourceSha256: string;
    readonly sourceStream: string;
    readonly buildSha256: string;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly effectiveInterpolation: 'off';
  };
  readonly reservationBytes: number;
}
export interface PreviewProxyResult {
  readonly profileId: typeof PREVIEW_PROXY_PROFILE;
  readonly mapHash: string;
  readonly frameCount: number;
  readonly sampleCount: 0;
  readonly files: readonly ReverseProxyFile[];
}

interface PreparedState {
  readonly input: PreviewProxyInput;
  readonly profile: PreparedPreviewProxy['profile'];
  readonly video: SourceSamples;
  readonly first: number;
  readonly last: number;
  readonly frameBytes: number;
  readonly outputBytes: number;
}
const states = new WeakMap<PreparedPreviewProxy, PreparedState>();
const unsupported = () => new ProcessingFailure('UNSUPPORTED_FORMAT');
const failed = () => new ProcessingFailure('PROCESSING_FAILED');
const cacheLimit = () => new ProcessingFailure('CACHE_LIMIT');

function geometry(index: VideoIndex): {width: number; height: number} {
  const {width, height, rotation, stream} = index;
  const ratio = typeof stream.sample_aspect_ratio === 'string' && /^\d+:\d+$/u.test(stream.sample_aspect_ratio)
    ? stream.sample_aspect_ratio.split(':').map(Number) : [1, 1];
  const displayWidth = width * ratio[0]! / ratio[1]!;
  if (!Number.isFinite(displayWidth) || displayWidth <= 0 || width * height > maxSourcePixels) throw unsupported();
  const rotated = Math.abs(rotation % 180) === 90;
  const [x, y] = rotated ? [height, displayWidth] : [displayWidth, height];
  const scale = Math.min(1, maxSide / Math.max(x, y));
  const even = (side: number) => Math.max(2, 2 * Math.round(side * scale / 2));
  return {width: even(x), height: even(y)};
}

async function buildIdentity(options: ReverseProxyMediaOptions): Promise<string> {
  const digest = createHash('sha256');
  for (const tool of ['ffmpeg', 'ffprobe'] as const) {
    await runReverseTool(tool, ['-version'], options, {stdoutLimit: 32 * 1024, stdout(chunk) {digest.update(chunk);}});
  }
  return digest.digest('hex');
}

export async function preparePreviewProxy(input: PreviewProxyInput, options: ReverseProxyMediaOptions): Promise<PreparedPreviewProxy> {
  checkMediaEffect(options.beforeEffect, options.signal);
  // The shared interpolation processor owns phase and pixel format admission.
  // While optical is pending, this renderer can emit only original samples.
  if (!path.isAbsolute(input.source.path) || input.source.path.includes('\0') || !/^[a-f0-9]{64}$/u.test(input.sourceSha256) ||
      input.interpolation !== 'off' && input.interpolation !== 'optical') throw unsupported();
  const info = timeMapPlanInfo(input.plan);
  if (!info.ok) throw unsupported();
  let video: SourceSamples;
  try {video = await readTimelineVideoSamples(input.source, input.plan, {...options, maxPixels: maxSourcePixels});}
  catch (error) {
    const code = (error as {code?: string} | null)?.code;
    if (code === SPEED_SOURCE_UNSUPPORTED || code === SPEED_MAPPING_INVALID) throw unsupported();
    if (code === SPEED_BUDGET_EXCEEDED) throw cacheLimit();
    throw error;
  }
  const {width, height} = geometry(video.index);
  const frameBytes = width * height * 3 / 2;
  const fps = input.plan.root.outputFps.fpsNumerator;
  let first = Infinity, last = -1;
  for (const ordinal of video.ordinals) {first = Math.min(first, ordinal); last = Math.max(last, ordinal);}
  const outputBytes = Math.ceil(video.ordinals.length * maxBitrate / (fps * 8)) + 2 * 1024 ** 2;
  const reservationBytes = (last - first + 1) * frameBytes + outputBytes + manifestOverhead;
  if (!Number.isSafeInteger(reservationBytes) || reservationBytes < 1 || reservationBytes > PROCESSING_CACHE_LIMIT_BYTES) throw cacheLimit();
  const profile = Object.freeze({profileId: PREVIEW_PROXY_PROFILE, mapHash: info.value.mapHash, sourceSha256: input.sourceSha256,
    sourceStream: video.stream, buildSha256: await buildIdentity(options), width, height, fps, effectiveInterpolation: 'off' as const});
  const prepared = Object.freeze({profile, reservationBytes});
  states.set(prepared, {input: {...input, source: {...input.source}}, profile, video, first, last, frameBytes, outputBytes});
  return prepared;
}

function orientation(rotation: number): string[] {
  switch ((rotation % 360 + 360) % 360) {
    case 90: return ['transpose=cclock'];
    case 180: return ['hflip', 'vflip'];
    case 270: return ['transpose=clock'];
    default: return [];
  }
}

async function decode(state: PreparedState, staging: Staging, scratch: Awaited<ReturnType<Staging['create']>>,
  options: ReverseProxyMediaOptions, onProgress?: (percent: number) => void): Promise<void> {
  const {first, last, profile, frameBytes, video, input} = state;
  const count = last - first + 1;
  const filter = [`trim=start_frame=${first}:end_frame=${last + 1}`, ...orientation(video.index.rotation),
    `scale=${profile.width}:${profile.height}:flags=bicubic`, 'setsar=1', 'format=yuv420p'].join(',');
  const expected = count * frameBytes;
  let bytes = 0;
  await runReverseTool('ffmpeg', ['-v', 'error', ...reverseToolBase, '-threads', '1', '-max_pixels', String(maxSourcePixels),
    '-noautorotate', ...localInput, '-i', input.source.path, '-map', `0:${video.stream}`, '-an', '-sn', '-dn',
    '-vf', filter, '-frames:v', String(count), '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', 'yuv420p',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], options, {timeoutMs, stdoutLimit: expected,
    async stdout(chunk) {
      staging.fence();
      await writeOwnedBytes(scratch.handle, chunk, bytes);
      bytes += chunk.length;
      onProgress?.(45 * bytes / expected);
    }});
  if (bytes !== expected) throw failed();
}

async function verify(file: string, {profile, video}: PreparedState, options: ReverseProxyMediaOptions): Promise<void> {
  const chunks: Buffer[] = [];
  await withProbePermit(options.signal, () => runReverseTool('ffprobe', ['-v', 'error', ...localInput, '-count_frames',
    '-show_entries', 'format=format_name:stream=codec_name,codec_type,pix_fmt,width,height,time_base,duration_ts,nb_read_frames', '-of', 'json', file],
  options, {stdoutLimit: 64 * 1024, stdout(chunk) {chunks.push(chunk);}, timeoutMs}));
  const {streams, format} = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    streams?: Record<string, unknown>[]; format?: {format_name?: string};
  };
  const stream = streams?.[0];
  if (!format?.format_name?.split(',').includes('mp4') || streams?.length !== 1 || !stream || stream.codec_name !== 'h264' ||
      stream.codec_type !== 'video' || stream.pix_fmt !== 'yuv420p' || stream.width !== profile.width || stream.height !== profile.height ||
      stream.time_base !== `1/${profile.fps}` || stream.duration_ts !== video.ordinals.length || Number(stream.nb_read_frames) !== video.ordinals.length) throw failed();
}

export async function renderPreviewProxy(input: PreviewProxyInput, prepared: PreparedPreviewProxy,
  options: ReverseProxyMediaOptions & {readonly stagingDirectory: string; readonly onProgress?: (percent: number) => void}): Promise<PreviewProxyResult> {
  const state = states.get(prepared);
  if (!state || state.input.plan !== input.plan || state.input.interpolation !== input.interpolation || state.input.sourceSha256 !== input.sourceSha256 ||
      state.input.source.path !== input.source.path || state.input.source.videoStreamIndex !== input.source.videoStreamIndex) throw unsupported();
  const {profile, video, frameBytes} = state;
  const frameCount = video.ordinals.length;
  const staging = createReverseStaging(options.stagingDirectory, options);
  const media = {...options, beforeEffect: staging.fence};
  try {
    const scratch = await staging.create('preview-frames.raw');
    await decode(state, staging, scratch, media, options.onProgress);
    const output = await staging.create('preview.mp4');
    const reader = Buffer.allocUnsafe(frameBytes);
    let prior = -1;
    await runReverseTool('ffmpeg', ['-v', 'error', ...reverseToolBase, '-f', 'rawvideo', '-pixel_format', 'yuv420p',
      '-video_size', `${profile.width}x${profile.height}`, '-framerate', String(profile.fps), '-i', 'pipe:0', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', String(maxBitrate), '-bufsize', String(maxBitrate),
      '-threads:v', '1', '-bf', '0', '-g', String(profile.fps * 2), '-pix_fmt', 'yuv420p',
      '-video_track_timescale', String(profile.fps), '-fs', String(state.outputBytes), '-f', 'mp4', 'fd:'], media,
    {timeoutMs, outputFd: output.handle.fd, async stdin(stream) {
      for (let offset = 0; offset < frameCount; offset++) {
        staging.fence();
        const ordinal = video.ordinals[offset]!;
        if (ordinal !== prior) {await readOwnedBytes(scratch.handle, reader, (ordinal - state.first) * frameBytes); prior = ordinal;}
        await writeMediaInput(stream, reader);
        options.onProgress?.(45 + 50 * (offset + 1) / frameCount);
      }
      await finishMediaInput(stream);
    }});
    await staging.remove(scratch);
    if ((await output.handle.stat()).size >= state.outputBytes) throw cacheLimit();
    await verify(staging.pathFor(output), state, media);
    const clock = await staging.create('clock.json');
    await writeOwnedBytes(clock.handle, Buffer.from(JSON.stringify({...profile, frameCount})), 0);
    const files = await Promise.all([staging.evidence(output), staging.evidence(clock)]);
    options.onProgress?.(100);
    return {profileId: PREVIEW_PROXY_PROFILE, mapHash: profile.mapHash, frameCount, sampleCount: 0, files};
  } catch (error) {
    if (isDiskFull(error)) throw new ProcessingFailure('DISK_FULL', {cause: error});
    throw error;
  } finally {await staging.close();}
}
