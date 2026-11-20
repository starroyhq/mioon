/** Empirical filter probes for SP-I0.
 *
 * The source frames are single-frame lossless NUT files with a 1/90000
 * timebase; a concat list assigns each source frame the PTS from the shared
 * time-map inverse (rounded to 6 decimal places by the concat demuxer). This
 * keeps the input PTS independent of any container's fixed frame-rate guess
 * while staying lossless, so blend output levels can be compared with the
 * exact FFmpeg 7.1 minterpolate alpha arithmetic. */
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compiledCurve, inverseSourceTimes, FPS, errorStats} from './phase.mjs';

const WIDTH = 64, HEIGHT = 64, TB_DEN = 90_000;

export function runFfmpeg(ffmpeg, args, options = {}) {
  const done = spawnSync(ffmpeg, args, {encoding: 'utf8', timeout: options.timeout ?? 900_000,
    maxBuffer: 16 * 1024 * 1024});
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`ffmpeg failed (${done.status}): ${done.stderr.slice(-1600)}`);
  return done;
}

function probeFfmpeg(ffprobe, args) {
  const done = spawnSync(ffprobe, args, {encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024});
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`ffprobe failed (${done.status}): ${done.stderr.slice(-800)}`);
  return done.stdout;
}

export function writeConcatInput(ffmpeg, dir, values, times) {
  const list = ['ffconcat version 1.0'];
  for (let n = 0; n < values.length; n++) {
    const name = `f${String(n).padStart(3, '0')}.nut`;
    // One lossless rawvideo frame in a NUT container with an explicit 1/90000 timebase.
    const raw = path.join(dir, `f${String(n).padStart(3, '0')}.raw`);
    writeFileSync(raw, Buffer.alloc(WIDTH * HEIGHT, values[n]));
    runFfmpeg(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${WIDTH}x${HEIGHT}`,
      '-framerate', String(FPS), '-i', raw, '-frames:v', '1', '-c:v', 'rawvideo', '-pix_fmt', 'gray',
      '-time_base', `1/${TB_DEN}`, path.join(dir, name)]);
    rmSync(raw, {force: true});
    const next = n + 1 < times.length ? times[n + 1] : times[n] + 1 / FPS;
    list.push(`file ${name}`, `duration ${(next - times[n]).toFixed(6)}`);
  }
  const file = path.join(dir, 'list.ffconcat');
  writeFileSync(file, list.join('\n') + '\n');
  return file;
}

export function inputPts(ffprobe, list) {
  const csv = probeFfmpeg(ffprobe, ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-select_streams', 'v', '-show_entries', 'frame=pts', '-of', 'csv=p=0']);
  return csv.trim().split(/\s+/).filter(Boolean).map(value => Number(value.replace(',', '')));
}

export function filterGraph(ffmpeg, list, filter, frames, dir, name) {
  const output = path.join(dir, `${name}.yuv`);
  runFfmpeg(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', filter,
    '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'gray', output]);
  const raw = readFileSync(output);
  const values = [];
  for (let frame = 0; frame < frames; frame++) values.push(raw[frame * WIDTH * HEIGHT]);
  return values;
}

/** Exact alpha arithmetic from FFmpeg 7.1 vf_minterpolate.c interpolate():
 * pts = av_rescale(out_pts, 1024 * out_tb.num * in_tb.den, out_tb.den * in_tb.num);
 * alpha = (pts - in_pts1*1024) / (in_pts2 - in_pts1), clipped and integer-truncated.
 * in_tb = 1/90000, out_tb = 1/30 => pts = out_pts * 3,072,000. */
export function emulatedAlpha(pts, outputFrame) {
  const scaled = outputFrame * 1024 * TB_DEN / FPS;
  let pair = 0;
  while (pair + 2 < pts.length && outputFrame * (TB_DEN / FPS) > pts[pair + 1]) pair++;
  const span = pts[pair + 1] - pts[pair];
  const alpha = span > 0 ? Math.trunc((scaled - pts[pair] * 1024) / span) : 0;
  return {pair, alpha: Math.max(0, Math.min(1024, alpha)), scaled};
}

/** Exact framerate filter weights (vf_framerate.c 7.1): input PTS are rescaled
 * to dest_time_base (here 1/90000), work_pts = start_pts + n*3000, and the
 * 7-bit blend factor is trunc((work_pts - pts0) * 128 / (pts1 - pts0)). */
export function emulatedFramerate(pts, outputFrame) {
  const workPts = pts[0] + outputFrame * (TB_DEN / FPS);
  let pair = 0;
  while (pair + 2 < pts.length && workPts >= pts[pair + 1]) pair++;
  const span = pts[pair + 1] - pts[pair];
  // av_rescale() in vf_framerate rounds to nearest, unlike the integer division
  // in vf_minterpolate's alpha.
  const factor = span > 0 ? Math.round((workPts - pts[pair]) * 128 / span) : 0;
  return {pair, factor: Math.max(0, Math.min(128, factor))};
}

export function probeVfrBlend(ffmpeg, ffprobe, samples, times, workRoot) {
  const dir = mkdtempSync(path.join(workRoot, 'vfr-'));
  try {
    const values = times.map((_, n) => n % 2 === 0 ? 16 : 239);
    const list = writeConcatInput(ffmpeg, dir, values, times);
    const pts = inputPts(ffprobe, list);
    const frames = samples.length;
    const minterpolate = filterGraph(ffmpeg, list, 'minterpolate=fps=30:mi_mode=blend:scd=none', frames, dir, 'mci');
    const framerate = filterGraph(ffmpeg, list, 'framerate=fps=30:interp_start=0:interp_end=255:scene=100', frames, dir, 'fr');
    const rows = samples.map((sample, j) => {
      const simulated = emulatedAlpha(pts, j);
      const pair = simulated.pair;
      const v0 = values[pair], v1 = values[Math.min(values.length - 1, pair + 1)];
      const predicted = (simulated.alpha * v1 + (1024 - simulated.alpha) * v0 + 512) >> 10;
      const desired = Math.round(sample.phase * v1 + (1 - sample.phase) * v0);
      const fr = emulatedFramerate(pts, j);
      const frPair = fr.pair, fr0 = values[frPair], fr1 = values[Math.min(values.length - 1, frPair + 1)];
      const frPredicted = (fr0 * (128 - fr.factor) + fr1 * fr.factor + 64) >> 7;
      return {outputFrame: j, desiredPhase: sample.phase, desiredSource: sample.position,
        pair, alpha: simulated.alpha, quantizedSource: pair + simulated.alpha / 1024,
        predictedPixel: predicted, desiredPixel: desired, frameratePair: frPair,
        framerateFactor: fr.factor, framerateQuantizedSource: frPair + fr.factor / 128,
        frameratePredictedPixel: frPredicted,
        minterpolatePixel: minterpolate[j], frameratePixel: framerate[j]};
    });
    const matches = rows.filter(row => row.minterpolatePixel === row.predictedPixel).length;
    const framerateMatches = rows.filter(row => row.frameratePixel === row.frameratePredictedPixel).length;
    return {rows, minterpolateMatches: matches, framerateMatches,
      inputPtsTicks: pts.slice(0, 8), timebase: `1/${TB_DEN}`,
      phaseError: errorStats(rows.map(row => row.quantizedSource - row.desiredSource)),
      pixelError: errorStats(rows.map(row => row.minterpolatePixel - row.desiredPixel)),
      frameratePhaseError: errorStats(rows.map(row => row.framerateQuantizedSource - row.desiredSource)),
      framerateFormulaMatches: rows.filter(row => row.frameratePixel === row.frameratePredictedPixel).length};
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

export function curveEmpirical(ffmpeg, ffprobe, workRoot) {
  const curve = compiledCurve();
  const times = inverseSourceTimes(curve.samples);
  return {curveMapHash: curve.root.mapHash, outputFrames: curve.outputFrames,
    probe: probeVfrBlend(ffmpeg, ffprobe, curve.samples, times, workRoot)};
}

export function constantEmpirical(ffmpeg, ffprobe, workRoot) {
  const times = Array.from({length: 150}, (_, n) => n * 4 / FPS);
  const samples = Array.from({length: 600}, (_, j) => {
    const position = j / 4;
    return {outputFrame: j, position, phase: position - Math.floor(position), sourceFrame: Math.floor(position)};
  });
  return {outputFrames: 600, probe: probeVfrBlend(ffmpeg, ffprobe, samples, times, workRoot)};
}
