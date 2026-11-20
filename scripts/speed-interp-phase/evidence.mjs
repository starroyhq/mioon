/** Scene-cut, occlusion/fast-motion and 2-second-chunk evidence for SP-I0. */
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runFfmpeg} from './samples.mjs';

const OPTICAL = 'minterpolate=fps=30:mi_mode=mci:mc_mode=obmc:me_mode=bilat:me=epzs:mb_size=16:search_param=32:vsbmc=0';

function decodeRaw(ffmpeg, input, output, {width, height, frames, fps = 30}) {
  runFfmpeg(ffmpeg, ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(fps),
    '-i', input, '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', output]);
  return readFileSync(output);
}
function frameY(raw, frame, width, height) {
  return raw.subarray(frame * width * height * 3 / 2, frame * width * height * 3 / 2 + width * height);
}
function framesEqualY(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
function meanAbsDiff(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += Math.abs(a[index] - b[index]);
  return sum / a.length;
}
function filterRaw(ffmpeg, source, workRoot, width, height, sourceFrames, filter, outputFrames) {
  const dir = mkdtempSync(path.join(workRoot, 'evidence-'));
  try {
    const input = path.join(dir, 'in.yuv'), output = path.join(dir, 'out.yuv');
    writeFileSync(input, source);
    const args = ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', '30', '-i', input];
    runFfmpeg(ffmpeg, [...args, '-vf', filter, '-frames:v', String(outputFrames), '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p', output]);
    return readFileSync(output);
  } finally {rmSync(dir, {recursive: true, force: true});}
}

export function sceneCutEvidence(ffmpeg, sample, workRoot) {
  const {width, height, sourceFrames} = sample;
  const source = decodeRaw(ffmpeg, sample.file, path.join(workRoot, 'scene-cut-source.yuv'),
    {width, height, frames: sourceFrames});
  const outputFrames = sourceFrames * 4;
  const make = suffix => filterRaw(ffmpeg, source, workRoot, width, height, sourceFrames,
    `setpts=4*(PTS-STARTPTS),${OPTICAL}${suffix},trim=end_frame=${outputFrames}`,
    outputFrames);
  const optical = make(':scd=fdiff:scd_threshold=10');
  const noScd = make(':scd=none');
  const frameA = frameY(source, 29, width, height), frameB = frameY(source, 30, width, height);
  const cross = raw => {
    let count = 0;
    for (let j = 0; j < outputFrames; j++) {
      const y = frameY(raw, j, width, height);
      if (!framesEqualY(y, frameA) && !framesEqualY(y, frameB)) count++;
    }
    return count;
  };
  // Only the cut neighbourhood is meaningful; elsewhere red/blue frames also
  // differ from both cut frames, so restrict to output frames whose source
  // coordinate is between 29 and 31.
  const cutZone = j => {const position = j / 4; return position >= 28.5 && position <= 30.5;};
  const crossInZone = raw => {
    let count = 0, total = 0;
    for (let j = 0; j < outputFrames; j++) {
      if (!cutZone(j)) continue;
      total++;
      const y = frameY(raw, j, width, height);
      if (!framesEqualY(y, frameA) && !framesEqualY(y, frameB)) count++;
    }
    return {crossScene: count, frames: total};
  };
  return {cutSourceFrame: 29.5, outputFrames, scdFdiff: crossInZone(optical), scdNone: crossInZone(noScd),
    rule: 'cross-scene = output frame differs from both source frames that meet at the cut'};
}

export function motionEvidence(ffmpeg, samples, workRoot) {
  const rows = {};
  for (const [name, sample] of Object.entries(samples)) {
    const {width, height, sourceFrames} = sample;
    const source = decodeRaw(ffmpeg, sample.file, path.join(workRoot, `${name}-source.yuv`),
      {width, height, frames: sourceFrames});
    const truth = readFileSync(sample.groundTruth);
    const truthFrameBytes = width * height * 3 / 2;
    const outputFrames = sourceFrames * 4;
    const run = filter => filterRaw(ffmpeg, source, workRoot, width, height, sourceFrames,
      `setpts=4*(PTS-STARTPTS),${filter},trim=end_frame=${outputFrames}`, outputFrames);
    const blend = run('framerate=fps=30:interp_start=0:interp_end=255');
    const optical = run(`${OPTICAL}:scd=fdiff:scd_threshold=10`);
    const outputFrameBytes = width * height * 3 / 2;
    const errors = {blend: [], optical: [], blendQuarter: [], opticalQuarter: []};
    const available = Math.min(outputFrames, blend.length / outputFrameBytes, optical.length / outputFrameBytes);
    for (let j = 0; j < available; j++) {
      const reference = frameY(truth.subarray(j * truthFrameBytes, (j + 1) * truthFrameBytes), 0, width, height);
      const blendError = meanAbsDiff(frameY(blend, j, width, height), reference);
      const opticalError = meanAbsDiff(frameY(optical, j, width, height), reference);
      errors.blend.push(blendError); errors.optical.push(opticalError);
      if (j % 4 === 2) {errors.blendQuarter.push(blendError); errors.opticalQuarter.push(opticalError);}
    }
    const average = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    rows[name] = {comparedFrames: available, blendMeanAbsError: average(errors.blend),
      opticalMeanAbsError: average(errors.optical),
      blendQuarterPhaseMeanAbsError: average(errors.blendQuarter),
      opticalQuarterPhaseMeanAbsError: average(errors.opticalQuarter)};
  }
  return {method: '120 fps ground truth; 0.25x output frame j compared with high-fps frame j', rows};
}

export function chunkEvidence(ffmpeg, workRoot) {
  const width = 64, height = 64, sourceFrames = 180, chunkFrames = 60, overlap = 2;
  const dir = mkdtempSync(path.join(workRoot, 'chunks-'));
  try {
    const sourceFile = path.join(dir, 'chunk-source.yuv');
    runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30:d=6', '-frames:v', String(sourceFrames),
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', sourceFile]);
    const source = readFileSync(sourceFile);
    const frameBytes = width * height * 3 / 2;
    const outputFrames = sourceFrames * 4;
    const full = filterRaw(ffmpeg, source, workRoot, width, height, sourceFrames,
      `setpts=4*(PTS-STARTPTS),${OPTICAL}:scd=fdiff:scd_threshold=10`, outputFrames);
    const owned = new Map();
    for (let chunk = 0; chunk * chunkFrames < sourceFrames; chunk++) {
      const sourceStart = chunk * chunkFrames;
      const sourceEnd = Math.min(sourceFrames, sourceStart + chunkFrames);
      const contextStart = Math.max(0, sourceStart - overlap);
      const contextEnd = Math.min(sourceFrames, sourceEnd + overlap);
      const chunkRaw = source.subarray(contextStart * frameBytes, contextEnd * frameBytes);
      const globalOffset = contextStart;
      const output = filterRaw(ffmpeg, chunkRaw, workRoot, width, height, contextEnd - contextStart,
        `setpts=4*(PTS-STARTPTS)+${4 * globalOffset},${OPTICAL}:scd=fdiff:scd_threshold=10`,
        (contextEnd - contextStart) * 4);
      const outputFrameBytes = width * height * 3 / 2;
      const firstOutputFrame = 4 * globalOffset;
      for (let frame = 4 * sourceStart; frame < 4 * sourceEnd; frame++) {
        const localIndex = frame - firstOutputFrame;
        const raw = output.subarray(localIndex * outputFrameBytes, (localIndex + 1) * outputFrameBytes);
        owned.set(frame, raw);
      }
    }
    let mismatches = 0, missing = 0;
    for (let frame = 0; frame < outputFrames; frame++) {
      const candidate = owned.get(frame);
      if (!candidate) {missing++; continue;}
      const reference = full.subarray(frame * (width * height * 3 / 2), (frame + 1) * (width * height * 3 / 2));
      if (!candidate.equals(reference)) mismatches++;
    }
    return {sourceFrames, chunkFrames, overlapSourceFrames: overlap, outputFrames,
      ownedFrames: owned.size, missingFrames: missing, mismatchedFrames: mismatches,
      exactBoundaryOwnership: missing === 0 && owned.size === outputFrames,
      byteIdenticalToFullRun: mismatches === 0};
  } finally {rmSync(dir, {recursive: true, force: true});}
}
