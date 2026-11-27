import {createHash} from 'node:crypto';
import path from 'node:path';
import {timeMapPlanInfo} from '../../../contracts/src/timeline-time-map.ts';
import {processingProxyResultSchema} from '../../../contracts/src/timeline-processing-storage.ts';
import type {ProcessingCacheReceipt} from '../../../contracts/src/timeline-processing-storage.ts';
import {SPEED_BUDGET_EXCEEDED, SPEED_MAPPING_INVALID, SPEED_PROCESSING_NOT_READY, SPEED_SOURCE_UNSUPPORTED,
  UNSUPPORTED_INTERPOLATION_FORMAT} from '../../../contracts/src/timeline-speed-export.ts';
import {checkMediaEffect} from '../media-runtime.ts';
import {withProbePermit} from '../media-probe.ts';
import {mixSpeedBlendFrame, speedBlendFrameBytes} from '../timeline-speed-export-blend.ts';
import {readTimelineOpticalVideo, readTimelineVideoSamples} from '../timeline-speed-export-video.ts';
import {PROCESSING_CACHE_LIMIT_BYTES, ProcessingFailure} from './cache.ts';
import {createReverseStaging, finishMediaInput, isDiskFull, readOwnedBytes, runReverseTool, writeMediaInput, writeOwnedBytes} from './reverse-io.ts';
import type {ReverseProxyMediaOptions} from './reverse-io.ts';
import {REVERSE_PROXY_LIMITS, reverseToolBase} from './reverse-profile.ts';
import {TIMELINE_PREVIEW_CACHE_PROFILE} from './preview-port.ts';
import type {PreparedPreviewProcessing, PreviewProcessingInput, PreviewProcessingRenderer} from './preview-port.ts';

const maxSide = 960;
const maxSourcePixels = REVERSE_PROXY_LIMITS.maxPixels;
const maxBitrate = 8_000_000;
const manifestOverhead = 64 * 1024;
const timeoutMs = 30 * 60 * 1000;
const localInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska'];

type SourceSamples = Awaited<ReturnType<typeof readTimelineVideoSamples>>;
type VideoIndex = SourceSamples['index'];
type Staging = ReturnType<typeof createReverseStaging>;
type PreviewResult = Extract<ProcessingCacheReceipt['result'], {profileId: typeof TIMELINE_PREVIEW_CACHE_PROFILE}>;

interface SampledVideo {
  readonly kind: 'sampled';
  readonly source: SourceSamples;
  readonly first: number;
  readonly last: number;
  readonly frameBytes: number;
  readonly pixelFormat: string;
}
interface OpticalVideo {
  readonly kind: 'optical';
  readonly file: string;
  readonly offset: number;
  readonly index: VideoIndex;
}
interface PreparedState {
  readonly input: PreviewProcessingInput;
  readonly profile: PreparedPreviewProcessing['profile'];
  readonly video: SampledVideo | OpticalVideo;
  readonly outputBytes: number;
}
const states = new WeakMap<PreparedPreviewProcessing, PreparedState>();
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

async function prepareVideo(input: PreviewProcessingInput, options: ReverseProxyMediaOptions) {
  const probeOptions = {...options, maxPixels: maxSourcePixels};
  if (input.optical) {
    const {stream, index, offset} = await readTimelineOpticalVideo(input.source, input.plan, input.optical, probeOptions);
    const video: OpticalVideo = {kind: 'optical', file: input.optical.file, offset, index};
    return {video, stream, size: geometry(index), scratchBytes: 0};
  }
  const source = await readTimelineVideoSamples(input.source, input.plan, {...probeOptions, blend: input.interpolation === 'blend'});
  const size = geometry(source.index);
  let first = Infinity, last = -1;
  if (source.blend) {
    for (const {from, to} of source.blend) {first = Math.min(first, from, to); last = Math.max(last, from, to);}
  } else {
    for (const ordinal of source.ordinals) {first = Math.min(first, ordinal); last = Math.max(last, ordinal);}
  }
  const frameBytes = source.blend
    ? speedBlendFrameBytes(source.index.pixelFormat, source.index.width, source.index.height)
    : size.width * size.height * 3 / 2;
  if (frameBytes === null) throw unsupported();
  const pixelFormat = source.blend ? source.index.pixelFormat : 'yuv420p';
  const video: SampledVideo = {kind: 'sampled', source, first, last, frameBytes, pixelFormat};
  return {video, stream: source.stream, size, scratchBytes: (last - first + 1) * frameBytes};
}

async function prepare(input: PreviewProcessingInput, options: ReverseProxyMediaOptions): Promise<PreparedPreviewProcessing> {
  checkMediaEffect(options.beforeEffect, options.signal);
  if (!path.isAbsolute(input.source.path) || input.source.path.includes('\0') || !/^[a-f0-9]{64}$/u.test(input.sourceSha256) ||
      !['off', 'blend', 'optical'].includes(input.interpolation) ||
      (input.interpolation === 'optical') !== Boolean(input.optical) ||
      input.optical && (!path.isAbsolute(input.optical.file) || input.optical.file.includes('\0'))) throw unsupported();
  const info = timeMapPlanInfo(input.plan);
  if (!info.ok) throw unsupported();
  let ready: Awaited<ReturnType<typeof prepareVideo>>;
  try {ready = await prepareVideo(input, options);}
  catch (error) {
    const code = (error as {code?: string} | null)?.code;
    if (code === SPEED_SOURCE_UNSUPPORTED || code === SPEED_MAPPING_INVALID || code === UNSUPPORTED_INTERPOLATION_FORMAT) throw unsupported();
    if (code === SPEED_PROCESSING_NOT_READY && input.optical) throw new ProcessingFailure('INTERPOLATION_UNAVAILABLE');
    if (code === SPEED_BUDGET_EXCEEDED) throw cacheLimit();
    throw error;
  }
  const {video, stream, size, scratchBytes} = ready;
  const fps = input.plan.root.outputFps.fpsNumerator;
  const outputBytes = Math.ceil(input.plan.durationFrames * maxBitrate / (fps * 8)) + 2 * 1024 ** 2;
  const reservationBytes = scratchBytes + outputBytes + manifestOverhead;
  if (!Number.isSafeInteger(reservationBytes) || reservationBytes < 1 || reservationBytes > PROCESSING_CACHE_LIMIT_BYTES) throw cacheLimit();
  const profile = Object.freeze({profileId: TIMELINE_PREVIEW_CACHE_PROFILE, mapHash: info.value.mapHash, sourceSha256: input.sourceSha256,
    sourceStream: stream, buildSha256: await buildIdentity(options), ...size, fps, effectiveInterpolation: input.interpolation});
  const prepared = Object.freeze({profile, reservationBytes});
  states.set(prepared, {input: {...input, source: {...input.source}, ...(input.optical ? {optical: {...input.optical}} : {})}, profile, video, outputBytes});
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

function rasterFilters(index: VideoIndex, profile: PreparedState['profile']): string[] {
  return [...orientation(index.rotation), `scale=${profile.width}:${profile.height}:flags=bicubic`, 'setsar=1', 'format=yuv420p'];
}

async function decodeSampled(state: PreparedState, video: SampledVideo, staging: Staging,
  scratch: Awaited<ReturnType<Staging['create']>>, options: ReverseProxyMediaOptions,
  onProgress?: (percent: number) => void): Promise<void> {
  const {first, last, frameBytes, source, pixelFormat} = video;
  const {input, profile} = state;
  const count = last - first + 1;
  const filter = [`trim=start_frame=${first}:end_frame=${last + 1}`,
    ...(source.blend ? [] : rasterFilters(source.index, profile))].join(',');
  const expected = count * frameBytes;
  let bytes = 0;
  await runReverseTool('ffmpeg', ['-v', 'error', ...reverseToolBase, '-threads', '1', '-max_pixels', String(maxSourcePixels),
    ...(source.blend ? ['-noauto_conversion_filters'] : []),
    '-noautorotate', ...localInput, '-i', input.source.path, '-map', `0:${source.stream}`, '-an', '-sn', '-dn',
    '-vf', filter, '-frames:v', String(count), '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', source.blend ? `+${pixelFormat}` : pixelFormat,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], options, {timeoutMs, stdoutLimit: expected,
    async stdout(chunk) {
      staging.fence();
      await writeOwnedBytes(scratch.handle, chunk, bytes);
      bytes += chunk.length;
      onProgress?.(45 * bytes / expected);
    }});
  if (bytes !== expected) throw failed();
}

function outputArgs({profile, outputBytes}: PreparedState): string[] {
  return ['-an', '-sn', '-dn', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-maxrate', String(maxBitrate), '-bufsize', String(maxBitrate), '-threads:v', '1', '-bf', '0',
    '-g', String(profile.fps * 2), '-pix_fmt', 'yuv420p', '-video_track_timescale', String(profile.fps),
    '-fs', String(outputBytes), '-f', 'mp4', 'fd:'];
}

async function encodeSampled(state: PreparedState, video: SampledVideo, staging: Staging, outputFd: number,
  media: ReverseProxyMediaOptions, onProgress?: (percent: number) => void): Promise<void> {
  const {profile} = state;
  const {source, frameBytes, pixelFormat} = video;
  const {blend, ordinals, index} = source;
  const scratch = await staging.create('preview-frames.raw');
  await decodeSampled(state, video, staging, scratch, media, onProgress);
  const reader = Buffer.allocUnsafe(frameBytes);
  const blendBuffers = blend && {second: Buffer.allocUnsafe(frameBytes), mixed: Buffer.allocUnsafe(frameBytes)};
  const [width, height] = blend ? [index.width, index.height] : [profile.width, profile.height];
  const filters = source.rawInterpretation ? ['-vf', [source.rawInterpretation, ...rasterFilters(index, profile)].join(',')] : [];
  let prior = -1;
  await runReverseTool('ffmpeg', ['-v', 'error', ...reverseToolBase, '-f', 'rawvideo', '-pixel_format', pixelFormat,
    '-video_size', `${width}x${height}`, '-framerate', String(profile.fps), '-i', 'pipe:0', ...filters, ...outputArgs(state)],
  media, {timeoutMs, outputFd, async stdin(stream) {
    for (let offset = 0; offset < ordinals.length; offset++) {
      staging.fence();
      const sample = blend?.[offset];
      const ordinal = sample?.from ?? ordinals[offset]!;
      if (ordinal !== prior) {await readOwnedBytes(scratch.handle, reader, (ordinal - video.first) * frameBytes); prior = ordinal;}
      if (sample && blendBuffers && sample.from !== sample.to) {
        await readOwnedBytes(scratch.handle, blendBuffers.second, (sample.to - video.first) * frameBytes);
        mixSpeedBlendFrame(reader, blendBuffers.second, sample.weight, blendBuffers.mixed);
        await writeMediaInput(stream, blendBuffers.mixed);
      } else await writeMediaInput(stream, reader);
      onProgress?.(45 + 50 * (offset + 1) / ordinals.length);
    }
    await finishMediaInput(stream);
  }});
  await staging.remove(scratch);
}

async function encodeOptical(state: PreparedState, video: OpticalVideo, outputFd: number, media: ReverseProxyMediaOptions): Promise<void> {
  const {profile, input} = state;
  const end = video.offset + input.plan.durationFrames;
  // The lossless proxy already has every output frame in order, including
  // the cut policy and direction. Rebuild the exact clip clock after trimming
  // any transition handles and the Matroska clock's millisecond rounding.
  const filter = [`trim=start_frame=${video.offset}:end_frame=${end}`, `settb=1/${profile.fps}`, 'setpts=N',
    ...rasterFilters(video.index, profile)].join(',');
  await runReverseTool('ffmpeg', ['-v', 'error', ...reverseToolBase, '-threads', '1', '-max_pixels', String(maxSourcePixels),
    '-noautorotate', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'matroska', '-i', video.file,
    '-map', '0:v:0', '-vf', filter, '-fps_mode', 'passthrough', ...outputArgs(state)], media, {timeoutMs, outputFd});
}

async function verify(file: string, {profile, input: {plan: {durationFrames}}}: PreparedState, options: ReverseProxyMediaOptions): Promise<void> {
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
      stream.time_base !== `1/${profile.fps}` || stream.duration_ts !== durationFrames || Number(stream.nb_read_frames) !== durationFrames) throw failed();
}

async function render(input: PreviewProcessingInput, prepared: PreparedPreviewProcessing,
  options: Parameters<PreviewProcessingRenderer['render']>[2]): Promise<PreviewResult> {
  const state = states.get(prepared);
  if (!state || state.input.plan !== input.plan || state.input.interpolation !== input.interpolation || state.input.sourceSha256 !== input.sourceSha256 ||
      state.input.source.path !== input.source.path || state.input.source.videoStreamIndex !== input.source.videoStreamIndex ||
      state.input.optical?.file !== input.optical?.file || state.input.optical?.firstOutputFrame !== input.optical?.firstOutputFrame ||
      state.input.optical?.frameCount !== input.optical?.frameCount) throw unsupported();
  const {profile, video} = state;
  const frameCount = input.plan.durationFrames;
  const staging = createReverseStaging(options.stagingDirectory, options);
  const media = {...options, beforeEffect: staging.fence};
  try {
    const output = await staging.create('preview.mp4');
    if (video.kind === 'optical') await encodeOptical(state, video, output.handle.fd, media);
    else await encodeSampled(state, video, staging, output.handle.fd, media, options.onProgress);
    if ((await output.handle.stat()).size >= state.outputBytes) throw cacheLimit();
    await verify(staging.pathFor(output), state, media);
    const clock = await staging.create('clock.json');
    await writeOwnedBytes(clock.handle, Buffer.from(JSON.stringify({...profile, frameCount})), 0);
    const files = await Promise.all([staging.evidence(output), staging.evidence(clock)]);
    const receipt = processingProxyResultSchema.safeParse({
      profileId: TIMELINE_PREVIEW_CACHE_PROFILE, mapHash: profile.mapHash, frameCount, sampleCount: 0, files,
    });
    if (!receipt.success || receipt.data.profileId !== TIMELINE_PREVIEW_CACHE_PROFILE) throw failed();
    options.onProgress?.(100);
    return receipt.data;
  } catch (error) {
    if (isDiskFull(error)) throw new ProcessingFailure('DISK_FULL', {cause: error});
    throw error;
  } finally {await staging.close();}
}

export const timelinePreviewProcessingRenderer = {prepare, render} satisfies PreviewProcessingRenderer;
