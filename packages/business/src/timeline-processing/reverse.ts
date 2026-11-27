import {createHash} from 'node:crypto';
import {createReverseStaging, finishMediaInput, isDiskFull, readOwnedBytes, reverseError, runReverseTool, writeMediaInput, writeOwnedBytes} from './reverse-io.ts';
import type {ReverseProxyFile, ReverseProxyMediaOptions, ReverseStaging} from './reverse-io.ts';
import {REVERSE_PROXY_LIMITS, REVERSE_PROXY_PROFILE, REVERSE_PROXY_RESERVATION_STEP, reverseColorArgs, reverseLocalInput, reversePreparedState, reverseProbe, reverseToolBase} from './reverse-profile.ts';
import type {PreparedReverseProxy, ReverseProxyInput, ReverseProxyProfile, ReverseVideoChunk, SourceVideoPlan} from './reverse-profile.ts';

export {REVERSE_PROXY_COVERAGE_VERSION, REVERSE_PROXY_LIMITS, REVERSE_PROXY_PROFILE, prepareReverseProxy, reverseAudioCoverage} from './reverse-profile.ts';
export type {PreparedReverseProxy, ReverseProxyAudioCoverage, ReverseProxyInput, ReverseProxyProfile} from './reverse-profile.ts';
export type {ReverseProxyFile, ReverseProxyMediaOptions, ReverseProxyWriter} from './reverse-io.ts';

export interface RenderReverseProxyOptions extends ReverseProxyMediaOptions {
  readonly stagingDirectory: string;
  readonly onProgress?: (percent: number) => void;
  readonly reserveBytes?: (requiredTotalBytes: number) => void;
}
export interface ReverseProxyResult {
  readonly profileId: typeof REVERSE_PROXY_PROFILE;
  readonly mapHash: string;
  readonly files: readonly ReverseProxyFile[];
  readonly frameCount: number;
  readonly sampleCount: number;
}

type PreparedState = ReturnType<typeof reversePreparedState>;
type Audio = NonNullable<ReverseProxyProfile['audio']>;
type Video = NonNullable<ReverseProxyProfile['video']>;
type StagedFile = Awaited<ReturnType<ReverseStaging['create']>>;
const audioClipFilter = (start: number, end: number): string => `atrim=start_sample=${start}:end_sample=${end},aresample=osf=flt`;
const audioArgs = (audio: Audio): string[] => ['-c:a', 'pcm_f32le', '-ar', String(audio.rate), '-ch_layout', audio.layout];
const rawAudioInput = (audio: Audio, file: string): string[] => ['-threads', '1', '-thread_queue_size', '1',
  '-f', 'f32le', '-ar', String(audio.rate), '-ch_layout', audio.layout, '-i', file];
const size = (video: Video): string => `${video.width}x${video.height}`;
const rawVideo = (video: Video): string[] => [
  '-c:v', 'rawvideo', '-pix_fmt', `+${video.pixelFormat}`, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1',
];
const restrictedDecode = ['-threads', '1', '-max_pixels', String(REVERSE_PROXY_LIMITS.maxPixels), '-reinit_filter', '0', '-noauto_conversion_filters'];
const offline = ['-v', 'error', ...reverseToolBase, ...restrictedDecode];
const muxTimeoutMs = 30 * 60 * 1000;

function swapSamples(input: Buffer, channels: number): void {
  const bytes = channels * 4;
  // Move all channels together, retaining the exact float32 bit patterns.
  for (let left = 0, right = input.length - bytes; left < right; left += bytes, right -= bytes) {
    for (let offset = 0; offset < bytes; offset += 4) {
      const at = left + offset, peer = right + offset, bits = input.readUInt32LE(at);
      input.writeUInt32LE(input.readUInt32LE(peer), at);
      input.writeUInt32LE(bits, peer);
    }
  }
}

async function decodeReverseAudio(state: PreparedState, audio: Audio, staging: ReverseStaging, options: ReverseProxyMediaOptions):
Promise<{file: StagedFile; digest: string; sampleCount: number}> {
  const {startSample, sampleCount} = state.audio!;
  const width = audio.channels * 4;
  const first = startSample - audio.firstMediaSample;
  const from = Math.max(0, first), until = Math.max(0, first + sampleCount);
  const leading = Math.min(sampleCount, Math.max(0, -first));
  const scratch = await staging.create('audio-source.f32le');
  let availableBytes = 0;
  if (until > from) {
    // Decode one continuous sample window before running the positional reverse
    // reads. A fresh codec seek at every block would restart priming and round
    // at compressed packet boundaries.
    await runReverseTool('ffmpeg', [...offline, ...reverseLocalInput(state.input.sourcePath, state.container),
      '-map', `0:${audio.index}`, '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-af', audioClipFilter(from, until), ...audioArgs(audio), '-f', 'f32le', 'pipe:1'], options,
    {stdoutLimit: (until - from) * width, timeoutMs: muxTimeoutMs, async stdout(chunk) {
      await writeOwnedBytes(scratch.handle, chunk, availableBytes);
      availableBytes += chunk.length;
    }});
  }
  if (availableBytes % width) throw reverseError('PROCESSING_FAILED');
  const availableUntil = leading + availableBytes / width;
  const output = await staging.create('audio.f32le');
  let position = 0;
  const digest = createHash('sha256');
  const maxBlock = audio.rate * REVERSE_PROXY_LIMITS.sourceChunkSeconds;
  const buffer = Buffer.allocUnsafe(Math.min(maxBlock, sampleCount) * width);
  for (let end = sampleCount; end > 0;) {
    staging.fence();
    const begin = Math.max(0, end - maxBlock);
    const block = buffer.subarray(0, (end - begin) * width);
    block.fill(0);
    const actualBegin = Math.max(leading, begin), actualEnd = Math.min(availableUntil, end);
    if (actualEnd > actualBegin) {
      // The stream may start late or end early relative to the video; samples
      // outside the stream are silent so the source-clock window stays exact.
      const target = block.subarray((actualBegin - begin) * width, (actualEnd - begin) * width);
      await readOwnedBytes(scratch.handle, target, (actualBegin - leading) * width);
    }
    swapSamples(block, audio.channels);
    digest.update(block);
    await writeOwnedBytes(output.handle, block, position);
    position += block.length;
    end = begin;
  }
  await staging.remove(scratch);
  return {file: output, digest: digest.digest('hex'), sampleCount};
}

function seekBefore(state: SourceVideoPlan, video: Video, ordinal: number): string[] {
  if (ordinal === 0) return [];
  const pts = state.video!.frames[ordinal]!.pts;
  const num = BigInt(pts) * BigInt(video.timeBase.numerator) * 1_000_000n;
  // Seek no later than the indexed key boundary. The timestamp check after
  // decoding, not the demuxer's seek rounding, owns native frame identity.
  const micros = num / BigInt(video.timeBase.denominator) - BigInt(state.originUs) - 1n;
  return micros > 0n ? ['-noaccurate_seek', '-ss', `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`] : [];
}

interface ReversedVideo {
  readonly index: StagedFile;
  readonly digest: string;
  readonly frameCount: number;
}

export async function decodeVerifiedVideoChunk(state: SourceVideoPlan, video: Video, chunk: ReverseVideoChunk,
  scratch: StagedFile, staging: ReverseStaging, options: ReverseProxyMediaOptions): Promise<void> {
  staging.fence();
  const count = chunk.end - chunk.start;
  const firstPts = state.video.frames[chunk.start]!.pts, lastPts = state.video.frames[chunk.end - 1]!.pts;
  const {numerator, denominator} = video.timeBase;
  // The filter admits only indexed PTS in its actual decoder timebase. The
  // showinfo rows are compared in order before reading the reversed block.
  const filter = `select='if(eq(TB,${numerator}/${denominator}),if(isnan(pts),0,between(pts,${firstPts},${lastPts})),0)',showinfo=checksum=0`;
  let bytes = 0, observed = 0;
  await runReverseTool('ffmpeg', ['-v', 'info', ...reverseToolBase, ...restrictedDecode,
    '-copyts', '-noautorotate', ...seekBefore(state, video, chunk.key), ...reverseLocalInput(state.input.sourcePath, state.container),
    '-map', `0:${video.index}`, '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', filter, '-frames:v', String(count), '-threads:v', '1', ...rawVideo(video)], options,
  {stdoutLimit: count * video.frameBytes,
    async stdout(data) {
      staging.fence();
      await writeOwnedBytes(scratch.handle, data, bytes);
      bytes += data.length;
    },
    stderrLine(line) {
      if (!line.includes('Parsed_showinfo_')) return;
      // These per-frame interpretations cannot be conveyed by static
      // Matroska tags or the raw-video clock. Reject instead of dropping them.
      if (/dynamic hdr|dolby vision|display matrix/i.test(line)) throw reverseError('UNSUPPORTED_FORMAT');
      if (!/\bn:\s*\d/.test(line)) return;
      if (observed >= count) throw reverseError('PROCESSING_FAILED');
      const match = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s.*\bfmt:\s*([a-z0-9_]+)\b.*\bs:\s*(\d+x\d+)\b.*\bi:([A-Z])/.exec(line);
      const expected = state.video.frames[chunk.start + observed]!;
      if (!match || Number(match[1]) !== observed || Number(match[2]) !== expected.pts ||
          match[3] !== video.pixelFormat || match[4] !== size(video) || match[5] !== 'P') throw reverseError('PROCESSING_FAILED');
      observed++;
    }});
  if (observed !== count || bytes !== count * video.frameBytes) throw reverseError('PROCESSING_FAILED');
}

async function decodeReverseVideo(state: PreparedState, video: Video, staging: ReverseStaging, options: ReverseProxyMediaOptions,
  emit: (frame: Buffer) => Promise<void>, progress: (frames: number) => void): Promise<ReversedVideo> {
  const plan = state.video!;
  const scratch = await staging.create('video-block.raw'), index = await staging.create('frames.jsonl');
  const digest = createHash('sha256');
  const frame = Buffer.allocUnsafe(video.frameBytes);
  let ordinal = 0, indexBytes = 0;
  for (const chunk of plan.chunks) {
    await decodeVerifiedVideoChunk({...state, video: plan}, video, chunk, scratch, staging, options);
    for (let sourceOrdinal = chunk.end - 1; sourceOrdinal >= chunk.start; sourceOrdinal--) {
      staging.fence();
      await readOwnedBytes(scratch.handle, frame, (sourceOrdinal - chunk.start) * video.frameBytes);
      digest.update(frame);
      await emit(frame);
      const line = Buffer.from(JSON.stringify({ordinal, sourceOrdinal,
        sourcePts: String(plan.frames[sourceOrdinal]!.pts),
        proxyPts: String(BigInt(ordinal) * BigInt(state.input.sourceFps.fpsDenominator))}) + '\n');
      await writeOwnedBytes(index.handle, line, indexBytes);
      indexBytes += line.length;
      ordinal++;
    }
    progress(ordinal);
  }
  if (ordinal !== plan.frameCount) throw reverseError('PROCESSING_FAILED');
  await staging.remove(scratch);
  return {index, digest: digest.digest('hex'), frameCount: ordinal};
}

export function losslessProxyEncoderArgs(fps: ReverseProxyInput['sourceFps'], outputBytesLimit: number,
  video: Video | null, audio: Audio | null = null, audioPath?: string, streamOutput = false): string[] {
  return ['-v', 'error', ...reverseToolBase, '-noauto_conversion_filters',
    ...(video ? ['-max_alloc', String(video.encoderAllocationBytes)] : []),
    ...(video ? ['-threads', '1', '-thread_queue_size', '1', '-f', 'rawvideo', '-pixel_format', video.pixelFormat, '-video_size', size(video),
      '-framerate', `${fps.fpsNumerator}/${fps.fpsDenominator}`, ...reverseColorArgs(video.colour), '-i', 'pipe:0'] : []),
    ...(audio && audioPath ? rawAudioInput(audio, audioPath) : []),
    ...(video ? ['-map', '0:v:0', '-vf', `setsar=${video.sampleAspect.numerator}/${video.sampleAspect.denominator}:max=1000000000`,
      '-c:v', 'ffv1', '-level', '3', '-slicecrc', '1', '-threads:v', String(video.threads),
      ...(video.threads === 4 ? ['-slices', '4'] : []),
      '-pix_fmt', `+${video.pixelFormat}`, ...reverseColorArgs(video.colour), '-fps_mode', 'passthrough'] : []),
    ...(audio ? ['-map', `${video ? 1 : 0}:a:0`, ...audioArgs(audio)] : []),
    '-map_metadata', '-1', '-map_chapters', '-1', '-max_interleave_delta', '2000000',
    ...(streamOutput ? ['-f', 'matroska', 'pipe:1']
      : ['-fs', String(Math.max(1, outputBytesLimit - (1024 * 1024))), '-f', 'matroska', 'fd:'])];
}

function muxWriter(output: StagedFile, state: PreparedState, prepared: PreparedReverseProxy,
  reserveBytes: RenderReverseProxyOptions['reserveBytes']) {
  // Streaming Matroska keeps one encoder and lets the host reserve every
  // compressed byte before writing it. The verified ordinal sidecar owns the clock.
  let reservedBytes = prepared.reservationBytes, position = 0;
  const maximumReservation = state.scratchBytes + state.outputBytesLimit;
  return async (chunk: Buffer): Promise<void> => {
    const required = state.scratchBytes + position + chunk.length;
    if (reserveBytes && required > reservedBytes) {
      const target = Math.min(maximumReservation, Math.max(required, reservedBytes + REVERSE_PROXY_RESERVATION_STEP));
      try {
        reserveBytes(target);
        reservedBytes = target;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        if (target === required || (code !== 'CACHE_LIMIT' && code !== 'DISK_FULL')) throw error;
        // Small remaining budgets can still fit the incoming chunk even when
        // the next amortized reservation does not fit.
        reserveBytes(required);
        reservedBytes = required;
      }
    }
    await writeOwnedBytes(output.handle, chunk, position);
    position += chunk.length;
  };
}

async function checkDecoded(file: string, args: string[], expectedBytes: number, expectedHash: string, options: ReverseProxyMediaOptions): Promise<void> {
  const digest = createHash('sha256');
  let decoded = 0;
  await runReverseTool('ffmpeg', [...offline, ...reverseLocalInput(file, 'matroska'), ...args], options,
    {stdoutLimit: expectedBytes, timeoutMs: muxTimeoutMs, stdout(bytes) {decoded += bytes.length; digest.update(bytes);}});
  if (decoded !== expectedBytes || digest.digest('hex') !== expectedHash) throw reverseError('PROCESSING_FAILED');
}

export async function checkLosslessProxy(file: string, video: Video | null, audio: Audio | null,
  frames: Pick<ReversedVideo, 'frameCount' | 'digest'> | null, signals: {sampleCount: number; digest: string} | null, options: ReverseProxyMediaOptions): Promise<void> {
  const probe = await reverseProbe(file, options, 'matroska');
  if (typeof probe.format.format_name !== 'string' || !probe.format.format_name.split(',').includes('matroska') ||
      probe.streams.length !== Number(Boolean(video)) + Number(Boolean(audio))) throw reverseError('PROCESSING_FAILED');
  if (video && frames) {
    const info = probe.streams.find(stream => stream.codec_type === 'video');
    if (!info || info.codec_name !== 'ffv1' || info.width !== video.width || info.height !== video.height ||
        info.pix_fmt !== video.pixelFormat || (info.sample_aspect_ratio ?? '1:1') !== `${video.sampleAspect.numerator}:${video.sampleAspect.denominator}` ||
        Object.entries(video.colour).some(([key, value]) => info[key] !== value)) throw reverseError('PROCESSING_FAILED');
    await checkDecoded(file, ['-map', '0:v:0', '-an', '-sn', '-dn', '-threads:v', '1', ...rawVideo(video)],
      frames.frameCount * video.frameBytes, frames.digest, options);
  }
  if (audio && signals) {
    const info = probe.streams.find(stream => stream.codec_type === 'audio');
    if (!info || info.codec_name !== 'pcm_f32le' || Number(info.sample_rate) !== audio.rate || info.channels !== audio.channels ||
        (info.channel_layout !== undefined && info.channel_layout !== audio.layout)) throw reverseError('PROCESSING_FAILED');
    await checkDecoded(file, ['-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
      signals.sampleCount * audio.channels * 4, signals.digest, options);
  }
}

/** Materialize and verify the reverse proxy in a private attempt directory.
 * The returned evidence contains only owned relative names. The task service
 * retains the authority to publish, pin or remove the attempt. */
export async function renderReverseProxy(input: ReverseProxyInput, prepared: PreparedReverseProxy,
  options: RenderReverseProxyOptions): Promise<ReverseProxyResult> {
  const state = reversePreparedState(input, prepared);
  const controller = new AbortController(), signal = AbortSignal.any([options.signal, controller.signal]);
  const owned: ReverseProxyMediaOptions = {...options, signal, ownerSignal: options.ownerSignal ?? options.signal};
  const staging = createReverseStaging(options.stagingDirectory, owned);
  const media: ReverseProxyMediaOptions = {...owned, beforeEffect: staging.fence};
  const {profile} = prepared, {video, audio} = profile;
  const report = (value: number): void => {staging.fence(); options.onProgress?.(value);};
  let failure: unknown;
  try {
    const sound = audio ? await decodeReverseAudio(state, audio, staging, media) : null;
    report(sound ? 20 : 5);
    const progress = (frames: number): void => report(20 + Math.floor(65 * frames / state.video!.frameCount));
    const rendered: {video: ReversedVideo | null} = {video: null};
    let mediaEvidence: ReverseProxyFile[];
    if (profile.storage === 'raw') {
      if (!video) throw reverseError('PROCESSING_FAILED');
      const output = await staging.create('video.raw');
      let position = 0;
      const frames = rendered.video = await decodeReverseVideo(state, video, staging, media, async frame => {
        await writeOwnedBytes(output.handle, frame, position); position += frame.length;
      }, progress);
      await output.handle.sync();
      const videoFile = await staging.evidence(output);
      if (videoFile.bytes !== frames.frameCount * video.frameBytes || videoFile.sha256 !== frames.digest) throw reverseError('PROCESSING_FAILED');
      mediaEvidence = [videoFile];
      if (sound) {
        await sound.file.handle.sync();
        const audioFile = await staging.evidence(sound.file);
        if (audioFile.sha256 !== sound.digest) throw reverseError('PROCESSING_FAILED');
        mediaEvidence.push(audioFile);
      }
    } else {
      const output = await staging.create('proxy.mkv');
      await runReverseTool('ffmpeg', losslessProxyEncoderArgs(input.sourceFps, state.outputBytesLimit, video, audio,
        sound ? staging.pathFor(sound.file) : undefined, true), media, {
        stdout: muxWriter(output, state, prepared, options.reserveBytes), stdoutLimit: state.outputBytesLimit,
        stdoutOverflow: () => reverseError('CACHE_LIMIT'), timeoutMs: muxTimeoutMs,
        ...(video ? {async stdin(stream: Parameters<typeof writeMediaInput>[0]) {
          rendered.video = await decodeReverseVideo(state, video, staging, media, frame => writeMediaInput(stream, frame), progress);
          await finishMediaInput(stream);
        }} : {}),
        onFailure() {controller.abort();},
      });
      await output.handle.sync();
      if ((await output.handle.stat()).size > state.outputBytesLimit) throw reverseError('CACHE_LIMIT');
      await checkLosslessProxy(staging.pathFor(output), video, audio, rendered.video, sound, media);
      if (sound) await staging.remove(sound.file);
      mediaEvidence = [await staging.evidence(output)];
    }
    const frames = rendered.video;
    const frameCount = frames?.frameCount ?? 0, sampleCount = sound?.sampleCount ?? 0;
    const index = frames?.index;
    if (index) {
      await index.handle.sync();
      mediaEvidence.push(await staging.evidence(index));
    }
    const metadata = await staging.create('clock.json');
    const pictureWindow = state.input.pictureWindow ?? state.input.sourceWindow;
    const clock = {
      profile, mapHash: state.input.mapHash, sourceSha256: state.input.sourceSha256, sourceWindow: state.input.sourceWindow,
      sourceClock: state.input.sourceFps, originUs: state.originUs,
      frameCount, sampleCount, sourceSampleStart: state.audio?.startSample ?? null,
      video: frames ? {index: 'frames.jsonl', timeBase: {numerator: 1, denominator: state.input.sourceFps.fpsNumerator},
        sourceTimeBase: video!.timeBase, decodedSha256: frames.digest,
        sourceCoverage: {startFrame: pictureWindow.startFrame, endFrame: pictureWindow.endFrame},
        firstSourceOrdinal: state.video!.firstSourceOrdinal, sourceZeroPts: String(state.video!.sourceZeroPts),
        endSourcePts: String(state.video!.endSourcePts)} : null,
      audio: sound ? {rate: audio!.rate, layout: audio!.layout, decodedSha256: sound.digest,
        sourceCoverage: state.audio!.sourceCoverage, sourceZero: state.audio!.sourceZero} : null,
      files: mediaEvidence,
    };
    await writeOwnedBytes(metadata.handle, Buffer.from(JSON.stringify(clock) + '\n'), 0);
    await metadata.handle.sync();
    const metaEvidence = await staging.evidence(metadata);
    report(100);
    return Object.freeze({profileId: REVERSE_PROXY_PROFILE, mapHash: state.input.mapHash, frameCount, sampleCount,
      files: Object.freeze([...mediaEvidence, metaEvidence])});
  } catch (error) {
    failure = isDiskFull(error) ? reverseError('DISK_FULL') : error;
    throw failure;
  } finally {
    try {await staging.close();}
    catch (error) {if (!failure) throw error;}
  }
}
