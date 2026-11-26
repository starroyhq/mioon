import {statSync} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {performance} from 'node:perf_hooks';
import {
  TIMELINE_SPEED_PRESETS, TIMELINE_TIME_MAP_BASIS_PROFILE, compileTimeMap, initialTimeMap,
  instantiateSpeedPreset, timeMapPlanFrames,
} from '../../packages/contracts/src/timeline-time-map.ts';
import {MiB, compare, media, probeFrames, startFfmpeg} from './process.mjs';

export const fps = 30;
export const portrait = {width: 1080, height: 1920};
export const small = {width: 192, height: 128};
const video = {fpsNumerator: fps, fpsDenominator: 1};
const maxRssBytes = 1024 * MiB;
const blockFrames = fps * 2;
const markerBits = 12;
const markerCell = 16;

export function unwrap(result) {
  if (!result.ok) throw new Error(`Shared time map: ${JSON.stringify(result)}`);
  return result.value;
}

export function presetPlan(id, frameCount, direction, startFrame = 0) {
  const endFrame = startFrame + frameCount;
  const boundary = frame => ({kind: 'rational', numerator: String(frame), denominator: '1'});
  const speed = unwrap(instantiateSpeedPreset(id, startFrame, endFrame));
  const root = unwrap(compileTimeMap({profile: TIMELINE_TIME_MAP_BASIS_PROFILE, sourceFps: video, outputFps: video,
    sourceRange: {start: boundary(startFrame), end: boundary(endFrame)}, speed}));
  return initialTimeMap(root, direction);
}

export function encoderArgs(crf = 23) {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-threads:v', '2',
    '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p', '-r', String(fps), '-video_track_timescale', '30000'];
}

export function makeFixture(ffmpeg, file, geometry, frameCount) {
  const {width, height} = geometry;
  const markerWidth = markerBits * markerCell;
  if (width < markerWidth || height < markerCell || frameCount > 2 ** markerBits) throw new Error('Fixture exceeds marker range');
  // Broad luma cells survive the H.264 encode/decode. The rest of the frame has motion.
  const graph = `testsrc2=s=${width}x${height}:r=${fps}[picture];nullsrc=s=${markerWidth}x${markerCell}:r=${fps},format=yuv420p,` +
    `geq=lum='16+219*mod(floor(N/pow(2,floor(X/${markerCell}))),2)':cb=128:cr=128[ordinal];` +
    '[picture][ordinal]overlay=0:0';
  media(ffmpeg, ['-f', 'lavfi', '-i', graph, '-frames:v', String(frameCount), '-an',
    ...encoderArgs(), '-keyint_min', '60', '-sc_threshold', '0', file]);
}

export function markerOrdinals(ffmpeg, file) {
  const width = markerBits * markerCell;
  const bytes = media(ffmpeg, ['-threads:v', '2', '-i', file, '-map', '0:v:0', '-an',
    '-vf', `crop=${width}:${markerCell}:0:0,format=gray`, '-threads:v', '1',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
  const frameBytes = width * markerCell;
  if (bytes.length % frameBytes !== 0) throw new Error('Truncated marker frame');
  const ids = [];
  for (let frame = 0; frame < bytes.length; frame += frameBytes) {
    let id = 0;
    for (let bit = 0; bit < markerBits; bit++) {
      const sample = bytes[frame + 8 * width + markerCell * bit + 8];
      id |= (sample >= 128 ? 1 : 0) << bit;
    }
    ids.push(id);
  }
  return ids;
}

export function rawArgs(geometry) {
  return ['-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size',
    `${geometry.width}x${geometry.height}`, '-framerate', String(fps)];
}

function windows(entry, sourceFrameCount, direction) {
  if (direction === 'forward') return [{start: 0, end: sourceFrameCount, key: entry[0]}];
  const result = [];
  const keys = entry.filter(frame => frame.key);
  for (let end = sourceFrameCount; end > 0;) {
    const start = Math.max(0, end - blockFrames);
    const key = keys.findLast(frame => frame.ordinal <= start);
    if (!key) throw new Error('No preceding source keyframe');
    result.push({start, end, key});
    end = start;
  }
  return result;
}

// Accumulate exactly one frame at a time, regardless of OS pipe chunk boundaries.
async function* completeFrames(stream, frameBytes) {
  let frame = Buffer.allocUnsafe(frameBytes);
  let used = 0;
  for await (const chunk of stream) {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(frameBytes - used, chunk.length - offset);
      chunk.copy(frame, used, offset, offset + count);
      used += count;
      offset += count;
      if (used === frameBytes) {
        yield frame;
        frame = Buffer.allocUnsafe(frameBytes);
        used = 0;
      }
    }
  }
  if (used !== 0) throw new Error('Decoder returned a partial frame');
}


export async function writeLookup(ffmpeg, file, geometry, frameIndex, direction, plan, destination, encode,
  {signal, observe, realtime = false} = {}) {
  signal?.throwIfAborted();
  const chunks = windows(frameIndex, frameIndex.length, direction);
  const reverse = direction === 'reverse';
  const frameBytes = geometry.width * geometry.height * 3 / 2;
  const decodeMeasures = [];
  let outputIndex = 0;
  let active;
  const start = performance.now();
  const progress = observe ? ['-progress', 'pipe:1'] : [];
  const output = startFfmpeg(ffmpeg, [...rawArgs(geometry), '-i', 'pipe:0', '-an', ...encode, ...progress, destination],
    {stdin: true, stdout: Boolean(observe)});
  const abort = () => { void active?.stop(); void output.stop(); };
  signal?.addEventListener('abort', abort, {once: true});

  async function* select() {
    for (const {start, end, key} of chunks) {
      signal?.throwIfAborted();
      const filter = reverse ? ['-vf', `trim=start_frame=${start - key.ordinal}:end_frame=${end - key.ordinal},reverse`] : [];
      const seek = reverse ? ['-ss', (key.pts / 30_000).toFixed(9)] : [];
      active = startFfmpeg(ffmpeg, ['-threads:v', '2', ...(realtime ? ['-re'] : []), ...seek, '-i', file, '-map', '0:v:0', ...filter,
        '-an', '-pix_fmt', 'yuv420p', '-threads:v', '1', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], {stdout: true});
      observe?.('lookup-decoder', active);
      let decoded = 0;
      for await (const frame of completeFrames(active.child.stdout, frameBytes)) {
        const id = reverse ? end - 1 - decoded : start + decoded;
        decoded++;
        while (plan[outputIndex] === id) {
          yield frame;
          outputIndex++;
        }
      }
      decodeMeasures.push({start, end, keyOrdinal: key.ordinal, keyPts: key.pts, decoded, ...await active.result()});
      active = undefined;
      if (decoded !== end - start) throw new Error(`Unexpected decoded frame count in [${start},${end})`);
    }
    if (outputIndex !== plan.length) throw new Error('Lookup did not emit every planned frame');
  }

  try {
    observe?.('lookup-encoder', output, destination);
    await pipeline(Readable.from(select(), {highWaterMark: 1, objectMode: false}), output.child.stdin);
    signal?.throwIfAborted();
    const encodeMeasure = await output.result();
    const wallSeconds = (performance.now() - start) / 1000;
    const maxDecoderRssBytes = Math.max(...decodeMeasures.map(row => row.peakRssBytes ?? Infinity));
    const nodeRssHighWaterBytes = process.resourceUsage().maxRSS * 1024;
    const maxRss = Math.max(maxDecoderRssBytes, encodeMeasure.peakRssBytes ?? Infinity, nodeRssHighWaterBytes);
    return {wallSeconds, outputBytes: statSync(destination).size, maxProcessRssBytes: Number.isFinite(maxRss) ? maxRss : null,
      peakSumUpperBoundBytes: Number.isFinite(maxRss) ? maxDecoderRssBytes + encodeMeasure.peakRssBytes + nodeRssHighWaterBytes : null,
      nodeRssHighWaterBytes, encodeMeasure, decodeMeasures};
  } catch (error) {
    await Promise.all([active?.stop(), output.stop()]);
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function exactIndex(ffmpeg, ffprobe, file, frames) {
  const index = probeFrames(ffprobe, file);
  if (index.length !== frames || index.some(({ordinal, pts, key}) => pts !== ordinal * 1000 || key !== (ordinal % 60 === 0))) {
    throw new Error('Fixture frame index/GOP differs from its declared source clock');
  }
  if (compare(index.map(frame => frame.ordinal), markerOrdinals(ffmpeg, file)).pass === false) {
    throw new Error('Fixture did not encode its own frame ordinals');
  }
  return index;
}

function gatePerformance(measured, seconds, startToEndBudget = 1) {
  const secondsPerSecond = measured.wallSeconds / seconds;
  return {secondsPerSecond, pass: secondsPerSecond <= startToEndBudget &&
    measured.maxProcessRssBytes !== null && measured.maxProcessRssBytes <= maxRssBytes};
}

export async function runLookup({ffmpeg, ffprobe, scratchDir}) {
  const file = path.join(scratchDir, 'portrait.mp4');
  const sourceFrames = 150;
  makeFixture(ffmpeg, file, portrait, sourceFrames);
  const index = exactIndex(ffmpeg, ffprobe, file, sourceFrames);
  const rows = [];
  for (const {id} of TIMELINE_SPEED_PRESETS) {
    for (const direction of ['forward', 'reverse']) {
      const expected = Array.from(unwrap(timeMapPlanFrames(presetPlan(id, sourceFrames, direction))));
      const destination = path.join(scratchDir, `${id}-${direction}.mp4`);
      const measured = await writeLookup(ffmpeg, file, portrait, index, direction, expected, destination, encoderArgs());
      const actual = markerOrdinals(ffmpeg, destination);
      const match = compare(expected, actual);
      const performance = gatePerformance(measured, expected.length / fps);
      rows.push({id, direction, outputFrames: expected.length, expected, actual, match, measured, performance});
    }
  }
  return {source: {...portrait, fps, sourceFrames, sourceBytes: statSync(file).size, gop: 60},
    threshold: {frameMismatches: 0, countDelta: 0, secondsPerOutputSecond: 1, maxProcessRssBytes: maxRssBytes},
    rows, pass: rows.every(row => row.match.pass && row.performance.pass)};
}

export async function runReverse({ffmpeg, ffprobe, scratchDir}) {
  const rows = [];
  for (const seconds of [5, 30, 120]) {
    const file = path.join(scratchDir, `source-${seconds}.mp4`);
    const destination = path.join(scratchDir, `reverse-${seconds}.mp4`);
    const sourceFrames = seconds * fps;
    makeFixture(ffmpeg, file, portrait, sourceFrames);
    const index = exactIndex(ffmpeg, ffprobe, file, sourceFrames);
    const expected = Array.from(unwrap(timeMapPlanFrames(presetPlan('none', sourceFrames, 'reverse'))));
    const measured = await writeLookup(ffmpeg, file, portrait, index, 'reverse', expected, destination, encoderArgs());
    const actual = markerOrdinals(ffmpeg, destination);
    const match = compare(expected, actual);
    const performance = gatePerformance(measured, seconds);
    rows.push({seconds, sourceFrames, sourceBytes: statSync(file).size, expected, actual, match, measured, performance});
  }
  return {source: {...portrait, fps, gop: 60}, threshold: {frameMismatches: 0, countDelta: 0, maxSourceFramesPerBlock: blockFrames,
    secondsPerSourceSecond: 1, maxProcessRssBytes: maxRssBytes},
    rows, pass: rows.every(row => row.match.pass && row.performance.pass &&
      row.measured.decodeMeasures.every(block => block.decoded <= blockFrames))};
}
