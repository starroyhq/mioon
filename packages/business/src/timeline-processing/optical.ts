import {createHash} from 'node:crypto';
import type {ClipTiming} from '../../../contracts/src/timeline-speed.ts';
import {compileClipTimeMap} from '../../../contracts/src/timeline-clip-timing.ts';
import {compileInterpolationPhase, isInterpolationPixelFormat} from '../../../contracts/src/timeline-interpolation.ts';
import type {InterpolationPhasePlan} from '../../../contracts/src/timeline-interpolation.ts';
import {timeMapSourceWindowForOutput} from '../../../contracts/src/timeline-time-map.ts';
import {createSceneDetector, SCENE_DETECTION_LIMITS} from '../scene-detection.ts';
import {speedPictureWindows} from '../timeline-speed-export-plan.ts';
import {MANAGED_FILE_IO_LIMITS} from '../managed-file-io.ts';
import {PROCESSING_CACHE_LIMIT_BYTES, ProcessingFailure} from './cache.ts';
import {OPTICAL_FLOW_CUT_POLICY, OPTICAL_FLOW_FILTER, OPTICAL_PROXY_PROFILE} from './optical-proxy-port.ts';
import {REVERSE_PROXY_LIMITS, prepareSourceVideo, reverseLocalInput, reverseToolBase} from './reverse-profile.ts';
import type {VideoProfile} from './reverse-profile.ts';
import {checkLosslessProxy, decodeVerifiedVideoChunk, losslessProxyEncoderArgs} from './reverse.ts';
import type {RenderReverseProxyOptions, ReverseProxyMediaOptions} from './reverse.ts';
import {MAX_OPTICAL_SEGMENTS, createReverseStaging, finishMediaInput, readOwnedBytes, runReverseTool, writeMediaInput, writeOwnedBytes} from './reverse-io.ts';
import type {ReverseStaging} from './reverse-io.ts';

export interface OpticalProxyInput {
  readonly sourcePath: string;
  readonly mapHash: string;
  readonly window: {
    readonly timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>;
    readonly beforeFrames: number;
    readonly afterFrames: number;
    readonly sourceFrames: number;
  };
  readonly sceneCuts?: () => Promise<readonly number[] | null> | readonly number[] | null;
}

const fps = 30;
const fpsClock = {fpsNumerator: fps, fpsDenominator: 1};
const ticksPerFrame = 90000 / fps;
const contextFrames = 2;
const maxChunkFrames = 1000;
const sourceChunkFrames = REVERSE_PROXY_LIMITS.sourceChunkSeconds * fps;
const timeoutMs = 30 * 60 * 1000;
const mib = 1024 ** 2;
const unavailable = (): never => {throw new ProcessingFailure('INTERPOLATION_UNAVAILABLE');};
const unsupported = (): never => {throw new ProcessingFailure('UNSUPPORTED_FORMAT');};
const failed = (): never => {throw new ProcessingFailure('PROCESSING_FAILED');};

type SourceVideo = Awaited<ReturnType<typeof prepareSourceVideo>>;
type StagedFile = Awaited<ReturnType<ReverseStaging['create']>>;
interface OwnedOutput {
  readonly from: number;
  readonly to: number;
  readonly frames: readonly {sourceFrame: number; pts: number}[];
}
interface OpticalBlock {
  readonly phase: InterpolationPhasePlan;
  readonly from: number;
  readonly to: number;
  readonly source: {readonly start: number; readonly end: number; readonly key: number};
  readonly optical: readonly OwnedOutput[];
}
interface OpticalState {
  readonly input: OpticalProxyInput;
  readonly source: SourceVideo;
  readonly blocks: readonly OpticalBlock[];
  readonly outputBytesLimit: number;
}
interface PreparedOpticalProxy {
  readonly profile: {
    readonly id: typeof OPTICAL_PROXY_PROFILE;
    readonly phase: InterpolationPhasePlan['profile'];
    readonly maxPhaseErrorFrames: number;
    readonly buildSha256: string;
    readonly filter: string;
    readonly filterAllocationBytes: number;
    readonly assembly: 'ffv1-segments-setts-v1';
    readonly video: VideoProfile;
    readonly sceneHash: string;
    readonly cutPolicy: typeof OPTICAL_FLOW_CUT_POLICY;
    readonly firstOutputFrame: number;
    readonly frameCount: number;
  };
  readonly reservationBytes: number;
}

const states = new WeakMap<PreparedOpticalProxy, OpticalState>();
function lowerBound(values: readonly number[], target: number): number {
  let first = 0, last = values.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (values[middle]! < target) first = middle + 1;
    else last = middle;
  }
  return first;
}

function ownedFlowOutput(phase: InterpolationPhasePlan, timestamps: ReadonlyMap<number, number>,
  from: number, to: number, sceneStart: number, sceneEnd: number, direction: 1 | -1): OwnedOutput {
  const first = phase.frames[from]!.fromFrame, last = phase.frames[to - 1]!.toFrame;
  const frames: {sourceFrame: number; pts: number}[] = [];
  for (let ordinal = first; direction * (ordinal - last) <= 0; ordinal += direction) {
    const pts = timestamps.get(ordinal);
    if (pts === undefined || frames.length >= maxChunkFrames) return unavailable();
    frames.push({sourceFrame: ordinal, pts});
  }
  const real = (sourceFrame: number): number | undefined => sourceFrame >= sceneStart && sourceFrame < sceneEnd
    ? timestamps.get(sourceFrame) : undefined;
  // Keep the two real neighbours wherever they exist. At a source or scene
  // edge the same side's endpoint supplies any missing references.
  for (let i = 0; i < contextFrames; i++) {
    const lead = frames[0]!, tail = frames.at(-1)!;
    const previous = lead.sourceFrame - direction, next = tail.sourceFrame + direction;
    const previousPts = real(previous), nextPts = real(next);
    frames.unshift(previousPts === undefined ? {sourceFrame: lead.sourceFrame, pts: lead.pts - (frames[1]!.pts - lead.pts)}
      : {sourceFrame: previous, pts: previousPts});
    frames.push(nextPts === undefined ? {sourceFrame: tail.sourceFrame, pts: tail.pts + (tail.pts - frames.at(-2)!.pts)}
      : {sourceFrame: next, pts: nextPts});
  }
  if (frames.some((frame, index) => index > 0 && frame.pts <= frames[index - 1]!.pts)) return unavailable();
  return {from, to, frames};
}

function makeBlocks(phase: InterpolationPhasePlan, positions: readonly number[], cuts: readonly number[],
  native: SourceVideo['state']['video']['frames'], direction: 1 | -1): OpticalBlock[] {
  const timestamps = new Map(phase.input.map(frame => [frame.sourceFrame, frame.pts]));
  const result: OpticalBlock[] = [];
  const sceneFor = (ordinal: number): number => lowerBound(cuts, ordinal + 1);
  const sectionFor = (ordinal: number): number => Math.floor(positions[ordinal]! / sourceChunkFrames);
  const canFlow = (index: number, scene: number): boolean => {
    const frame = phase.frames[index]!;
    // Keep the shared off sample on each side of every possible native cut.
    // The off frame identifies that interval in either playback direction.
    return frame.active && frame.fromFrame !== frame.toFrame &&
      cuts[scene - 1] !== frame.offFrame && cuts[scene] !== frame.offFrame + 1 &&
      sceneFor(frame.fromFrame) === scene && sceneFor(frame.toFrame) === scene;
  };
  for (let from = 0; from < phase.frames.length;) {
    const first = phase.frames[from]!.offFrame, scene = sceneFor(first), section = sectionFor(first);
    let to = from + 1;
    while (to < phase.frames.length && sceneFor(phase.frames[to]!.offFrame) === scene &&
      sectionFor(phase.frames[to]!.offFrame) === section) to++;
    let start = Math.min(first, phase.frames[to - 1]!.offFrame);
    let end = Math.max(first, phase.frames[to - 1]!.offFrame) + 1;
    const optical: OwnedOutput[] = [];
    for (let begin = from; begin < to;) {
      if (!canFlow(begin, scene)) {begin++; continue;}
      let until = begin + 1;
      while (until < to && canFlow(until, scene)) until++;
      const out = ownedFlowOutput(phase, timestamps, begin, until,
        cuts[scene - 1] ?? 0, cuts[scene] ?? positions.length, direction);
      for (const {sourceFrame} of out.frames) {
        start = Math.min(start, sourceFrame);
        end = Math.max(end, sourceFrame + 1);
      }
      optical.push(out);
      begin = until;
    }
    if (end - start > maxChunkFrames || !native[start] || !native[end - 1]) return unsupported();
    result.push({phase, from, to, source: {start, end, key: native[start]!.previousKey}, optical});
    from = to;
  }
  return result;
}

function flowAllocationBytes(video: VideoProfile): number {
  // FFmpeg 7.1's minterpolate allocates two separate 128-byte-per-pixel
  // arrays and one 36-byte-per-pixel array for motion contexts.
  return Math.max(128 * mib, (Math.ceil(video.width * video.height * 128 / mib) + 1) * mib);
}

function admitVideo(video: VideoProfile): boolean {
  // Motion contexts, filter/pipe/encoder picture buffers, and the working
  // allowance for the processing host. The shared FFV1 profile separately
  // limits the encoder's worst-case allocation; encoding never overlaps flow.
  const flowBytes = video.width * video.height * 292 + 24 * video.frameBytes + 256 * mib;
  return isInterpolationPixelFormat(video.pixelFormat) && video.width >= 32 && video.height >= 32 &&
    flowBytes <= REVERSE_PROXY_LIMITS.processBytes;
}

async function detectOpticalCuts(source: SourceVideo, requiredFrames: number, sourceFrames: number,
  options: ReverseProxyMediaOptions): Promise<readonly number[]> {
  const {state, video} = source;
  const {maxEdge, maxDurationSeconds} = SCENE_DETECTION_LIMITS;
  // Match the saved detector's editing clock and scoring. Its frame-capture
  // adapter only admits square-pixel 4:2:0 AVC/VPx; optical's decoder also
  // admits other planar layouts. RGB here is only the small analysis image.
  const ratio = Math.min(1, maxEdge / Math.max(video.width, video.height));
  const width = Math.max(1, Math.round(video.width * ratio)), height = Math.max(1, Math.round(video.height * ratio));
  const frameCount = Math.min(sourceFrames, requiredFrames);
  if (frameCount > maxDurationSeconds * fps) return unsupported();
  const detector = createSceneDetector({width, height, maxFrames: frameCount});
  await runReverseTool('ffmpeg', ['-v', 'error', ...reverseToolBase, '-threads', '1',
    '-max_pixels', String(REVERSE_PROXY_LIMITS.maxPixels), '-reinit_filter', '0', '-noautorotate',
    ...reverseLocalInput(state.input.sourcePath, state.container), '-map', `0:${video.index}`, '-an', '-sn', '-dn',
    '-vf', `fps=${fps}:round=down,scale=${width}:${height}:flags=area,format=rgb24`, '-frames:v', String(frameCount),
    '-threads:v', '1', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], options, {
    stdoutLimit: frameCount * detector.frameBytes, timeoutMs, stdout: bytes => detector.write(bytes),
  });
  if (detector.frames !== frameCount) return unavailable();
  return detector.finish(frameCount).cuts.map(cut => cut.frame);
}

export async function prepareOpticalProxy(input: OpticalProxyInput, options: ReverseProxyMediaOptions): Promise<PreparedOpticalProxy> {
  const {window: {timing, sourceFrames, beforeFrames, afterFrames}} = input;
  const durationFrames = timing.outputWindow.toFrame - timing.outputWindow.fromFrame;
  const clip = {id: input.mapHash, timing, startFrame: beforeFrames, sourceInFrame: 0, durationFrames};
  const base = compileClipTimeMap(clip, {fps});
  if (!base.ok || base.value.root.mapHash !== input.mapHash) return unavailable();
  const frameCount = beforeFrames + durationFrames + afterFrames;
  const picture = {start: 0, end: frameCount};
  const windows = speedPictureWindows(clip, base.value, picture, picture, sourceFrames);
  const branchWindows = windows.map(({plan}) => {
    const window = timeMapSourceWindowForOutput(plan, {contextFrames});
    return window.ok ? window.value : unavailable();
  });
  const startFrame = Math.max(0, Math.min(...branchWindows.map(window => window.startFrame)) - contextFrames);
  const endFrame = Math.min(sourceFrames, Math.max(...branchWindows.map(window => window.endFrame)) + contextFrames);
  const source = await prepareSourceVideo({sourcePath: input.sourcePath, sourceFps: fpsClock, sourceWindow: {
    startFrame, endFrame, frameCount: endFrame - startFrame, direction: base.value.direction,
    outputFromFrame: 0, outputToFrame: frameCount,
  }}, admitVideo, options);
  const {state, video} = source;
  const tickInFrames = fps * video.timeBase.numerator / video.timeBase.denominator;
  const positionOf = (pts: number): number => pts * tickInFrames - fps * state.originUs / 1e6;
  const positions = state.video.frames.map(frame => positionOf(frame.pts));
  const clock = {positions, end: positionOf(state.video.endOfStream)};
  const phases = windows.map(({plan}) => {
    const phase = compileInterpolationPhase(plan, clock);
    return phase.ok && phase.value.available ? phase.value : unavailable();
  });
  // Include enough source beyond the mapped clip for the saved detector's
  // flash/minimum-shot context. A 30 fps cut only pins an editing interval;
  // on VFR/high-rate sources isolate every possible native cut in that span.
  const detected = await input.sceneCuts?.() ?? await detectOpticalCuts(source, endFrame + fps * 6, sourceFrames, options);
  const cuts = [...new Set(detected.flatMap(frame => {
    const first = lowerBound(positions, frame - 1 - tickInFrames / 2);
    const last = lowerBound(positions, frame - tickInFrames / 2);
    return Array.from({length: last - first + 1}, (_, offset) => first + offset);
  }))]
    .filter(frame => frame > 0 && frame < positions.length).sort((a, b) => a - b);
  const blocks = phases.flatMap((phase, index) => makeBlocks(phase, positions, cuts, state.video.frames,
    windows[index]!.plan.direction === 'forward' ? 1 : -1));
  if (blocks.length > MAX_OPTICAL_SEGMENTS) throw new ProcessingFailure('CACHE_LIMIT');
  const nativeScratch = Math.max(...blocks.map(block => block.source.end - block.source.start));
  const syntheticScratch = Math.max(...blocks.map(block => block.optical.length ? block.optical.at(-1)!.to - block.from : 0));
  const scratchBytes = (nativeScratch + syntheticScratch) * video.frameBytes;
  const overhead = video.encoderAllocationBytes + 64 * 1024 + blocks.length * 128;
  const ideal = Math.ceil(frameCount * video.frameBytes * 1.5) + 4 * mib + frameCount * 256;
  // During estimation/encoding only the scratch and sealed segments coexist.
  // During assembly the scratch has been removed and the final proxy coexists
  // with the sealed segments.
  const outputBytesLimit = Math.min(ideal, PROCESSING_CACHE_LIMIT_BYTES - overhead - scratchBytes,
    Math.floor((PROCESSING_CACHE_LIMIT_BYTES - overhead) / 2), MANAGED_FILE_IO_LIMITS.fileBytes);
  const reservationBytes = outputBytesLimit + Math.max(scratchBytes, outputBytesLimit) + overhead;
  if (outputBytesLimit < 4 * mib || !Number.isSafeInteger(reservationBytes)) throw new ProcessingFailure('CACHE_LIMIT');
  const profile = Object.freeze({id: OPTICAL_PROXY_PROFILE, phase: phases[0]!.profile,
    maxPhaseErrorFrames: Math.max(...phases.map(phase => phase.maxPhaseErrorFrames)), buildSha256: source.buildSha256,
    filter: OPTICAL_FLOW_FILTER, filterAllocationBytes: flowAllocationBytes(video), assembly: 'ffv1-segments-setts-v1' as const,
    video, sceneHash: createHash('sha256').update(JSON.stringify(cuts)).digest('hex'), cutPolicy: OPTICAL_FLOW_CUT_POLICY,
    firstOutputFrame: 0 - beforeFrames, frameCount});
  const prepared = {profile, reservationBytes};
  states.set(prepared, {input, source, blocks, outputBytesLimit});
  return prepared;
}

// A balanced expression stays below FFmpeg's expression depth even on a
// high-rate source. All entries are exact integers in the 1/90000 timebase.
function ptsExpression(ticks: readonly number[], from = 0, to = ticks.length): string {
  if (to - from === 1) return String(ticks[from]);
  const middle = (from + to) >>> 1;
  return `if(lt(N,${middle}),${ptsExpression(ticks, from, middle)},${ptsExpression(ticks, middle, to)})`;
}

async function interpolateBlock(output: OwnedOutput, block: OpticalBlock, video: VideoProfile, original: StagedFile, synthetic: StagedFile,
  staging: ReverseStaging, options: ReverseProxyMediaOptions, frame: Buffer): Promise<void> {
  const shift = Math.floor(output.frames[0]!.pts / ticksPerFrame) - 1;
  const ticks = output.frames.map(each => each.pts - shift * ticksPerFrame);
  const start = output.from - shift, end = output.to - shift, count = end - start;
  const format = video.pixelFormat, size = `${video.width}x${video.height}`;
  const filter = `settb=1/90000,setpts='${ptsExpression(ticks)}',${OPTICAL_FLOW_FILTER},trim=start_pts=${start}:end_pts=${end},showinfo=checksum=0`;
  let bytes = 0, observed = 0;
  await runReverseTool('ffmpeg', ['-v', 'info', ...reverseToolBase, '-max_alloc', String(flowAllocationBytes(video)),
    '-noauto_conversion_filters', '-copyts',
    '-threads', '1', '-thread_queue_size', '1', '-f', 'rawvideo', '-pixel_format', format, '-video_size', size, '-framerate', String(fps),
    '-i', 'pipe:0', '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filter,
    '-threads:v', '1', '-c:v', 'rawvideo', '-pix_fmt', `+${format}`, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'],
  options, {stdoutLimit: count * video.frameBytes, timeoutMs,
    async stdin(stream) {
      for (const each of output.frames) {
        staging.fence();
        await readOwnedBytes(original.handle, frame, (each.sourceFrame - block.source.start) * frame.length);
        await writeMediaInput(stream, frame);
      }
      await finishMediaInput(stream);
    },
    async stdout(data) {
      await writeOwnedBytes(synthetic.handle, data, (output.from - block.from) * video.frameBytes + bytes);
      bytes += data.length;
    },
    stderrLine(line) {
      if (!line.includes('Parsed_showinfo_') || !/\bn:\s*\d/.test(line)) return;
      const match = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s.*\bfmt:\s*([a-z0-9_]+)\b/.exec(line);
      if (!match || Number(match[1]) !== observed || Number(match[2]) !== start + observed || match[3] !== format || observed >= count) failed();
      observed++;
    }});
  if (observed !== count || bytes !== count * video.frameBytes) failed();
}

async function verifyOpticalOutputClock(file: string, frameCount: number, options: ReverseProxyMediaOptions): Promise<void> {
  let observed = 0, partial = '';
  function accept(line: string): void {
    const expected = Math.round(observed * 1000 / fps);
    if (observed >= frameCount || line.trim() !== String(expected)) failed();
    observed++;
  }
  await runReverseTool('ffprobe', ['-v', 'error', '-threads', '1', '-select_streams', 'v:0',
    '-show_packets', '-show_entries', 'packet=pts', '-of', 'csv=p=0', ...reverseLocalInput(file, 'matroska')], options, {
    stdoutLimit: frameCount * 16, timeoutMs, stdout(chunk) {
      const lines = (partial + chunk.toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      if (partial.length > 16) failed();
      for (const line of lines) accept(line);
    },
  });
  if (partial) accept(partial);
  if (observed !== frameCount) failed();
}

export async function renderOpticalProxy(input: OpticalProxyInput, prepared: PreparedOpticalProxy, options: RenderReverseProxyOptions) {
  const state = states.get(prepared);
  if (!state || state.input !== input) throw new ProcessingFailure('SOURCE_UNAVAILABLE');
  const {profile: {video, firstOutputFrame, frameCount}} = prepared;
  const staging = createReverseStaging(options.stagingDirectory, options);
  const media = {...options, beforeEffect: staging.fence};
  const digest = createHash('sha256');
  let count = 0, segmentBytes = 0;
  const segments: StagedFile[] = [];
  try {
    const original = await staging.create('video-block.raw'), synthetic = await staging.create('video.raw');
    const output = Buffer.allocUnsafe(video.frameBytes), filterInput = Buffer.allocUnsafe(video.frameBytes);
    for (const block of state.blocks) {
      await decodeVerifiedVideoChunk(state.source.state, video, block.source, original, staging, media);
      // Complete motion estimation before starting the FFV1 encoder. Its
      // resident pixel arrays must never overlap the encoder's packet buffers.
      for (const part of block.optical) await interpolateBlock(part, block, video, original, synthetic, staging, media, filterInput);
      const remaining = state.outputBytesLimit - segmentBytes;
      if (remaining < 4 * mib) throw new ProcessingFailure('CACHE_LIMIT');
      const segment = await staging.create(`optical-${String(segments.length).padStart(5, '0')}.mkv`);
      await runReverseTool('ffmpeg', losslessProxyEncoderArgs(fpsClock, remaining, video),
        media, {outputFd: segment.handle.fd, timeoutMs, async stdin(stream) {
          let runIndex = 0;
          for (let index = block.from; index < block.to; index++) {
            const part = block.optical[runIndex];
            const generated = part && index >= part.from;
            const ordinal = generated ? index - block.from : block.phase.frames[index]!.offFrame - block.source.start;
            staging.fence();
            await readOwnedBytes((generated ? synthetic : original).handle, output, ordinal * output.length);
            digest.update(output);
            await writeMediaInput(stream, output);
            count++;
            if (part && part.to === index + 1) runIndex++;
          }
          await finishMediaInput(stream);
        }});
      await segment.handle.sync();
      segmentBytes += (await segment.handle.stat()).size;
      if (segmentBytes > state.outputBytesLimit) throw new ProcessingFailure('CACHE_LIMIT');
      await segment.handle.close();
      segments.push(segment);
      options.onProgress?.(count * 90 / frameCount);
    }
    if (count !== frameCount) failed();
    await staging.remove(original);
    await staging.remove(synthetic);

    // Rejoin the independently encoded FFV1 blocks without re-encoding.
    // Recreate each timestamp directly on Matroska's millisecond clock. Some
    // FFmpeg builds carry the packet ticks through a stream-copy filter
    // without rescaling from that filter's time base.
    const playlist = await staging.create('optical.ffconcat');
    const lines = ['ffconcat version 1.0', ...segments.map(segment => {
      staging.pathFor(segment);
      return `file ${segment.fileName}`;
    })].join('\n') + '\n';
    await writeOwnedBytes(playlist.handle, Buffer.from(lines), 0);
    await playlist.handle.sync();
    const proxy = await staging.create('proxy.mkv');
    await runReverseTool('ffmpeg', ['-v', 'error', ...reverseToolBase, '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', 'concat,matroska', '-f', 'concat', '-safe', '1', '-auto_convert', '0', '-i', staging.pathFor(playlist),
      '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'copy',
      '-bsf:v', 'setts=pts=round(N*1000/30):dts=round(N*1000/30):duration=round((N+1)*1000/30)-round(N*1000/30):time_base=1/1000',
      '-fs', String(Math.max(1, state.outputBytesLimit - mib)), '-f', 'matroska', 'fd:'],
    media, {outputFd: proxy.handle.fd, timeoutMs});
    await proxy.handle.sync();
    if ((await proxy.handle.stat()).size > state.outputBytesLimit) throw new ProcessingFailure('CACHE_LIMIT');
    for (const segment of segments) await staging.remove(segment);
    await staging.remove(playlist);
    const file = staging.pathFor(proxy);
    await checkLosslessProxy(file, video, null, {frameCount, digest: digest.digest('hex')}, null, media);
    await verifyOpticalOutputClock(file, frameCount, media);
    const clock = await staging.create('clock.json');
    const record = {...prepared.profile, mapHash: input.mapHash};
    await writeOwnedBytes(clock.handle, Buffer.from(JSON.stringify(record)), 0);
    await clock.handle.sync();
    return {profileId: OPTICAL_PROXY_PROFILE, mapHash: input.mapHash, firstOutputFrame, frameCount, sampleCount: 0,
      files: [await staging.evidence(proxy), await staging.evidence(clock)]};
  } finally {await staging.close();}
}
