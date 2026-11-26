import {existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {timelineCompositionSegments} from '../../packages/contracts/src/timeline-segments.ts';
import {timeMapPlanFrames, trimTimeMap} from '../../packages/contracts/src/timeline-time-map.ts';
import {compare, media, probeFrames, startFfmpeg} from './process.mjs';
import {encoderArgs, fps, makeFixture, markerOrdinals, presetPlan, rawArgs, small, unwrap, writeLookup} from './video.mjs';

const seconds = frames => (frames / fps).toFixed(9);

function hashes(ffmpeg, file) {
  return media(ffmpeg, ['-i', file, '-map', '0:v:0', '-c:v', 'rawvideo', '-threads:v', '1',
    '-f', 'framehash', 'pipe:1']).toString().trimEnd().split('\n')
    .filter(line => !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
}

function fingerprint(ffmpeg, ffprobe, file) {
  return {hashes: hashes(ffmpeg, file), ids: markerOrdinals(ffmpeg, file),
    pts: probeFrames(ffprobe, file).map(frame => frame.pts), bytes: statSync(file).size};
}

function pcmInput() {
  return ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
}

function encodeSegment(ffmpeg, proxy, from, to, crf, file) {
  return startFfmpeg(ffmpeg, [...rawArgs(small), '-i', proxy, ...pcmInput(),
    '-vf', `trim=start_frame=${from}:end_frame=${to},setpts=N/(30*TB)`, '-map', '0:v:0', '-map', '1:a:0',
    ...encoderArgs(crf), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-t', seconds(to - from), file]);
}

function concatenate(ffmpeg, folder, segments, files, output) {
  const list = path.join(folder, 'concat.txt');
  // Relative controlled names match the original index even when jobs complete out of order.
  writeFileSync(list, files.map((file, index) => `file '${path.basename(file)}'\nduration ${seconds(
    segments[index].endFrame - segments[index].beginFrame)}`).join('\n') + '\n');
  const frames = segments.at(-1).endFrame;
  media(ffmpeg, ['-f', 'concat', '-safe', '1', '-i', list, '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy', '-video_track_timescale', '30000', '-af', `apad,atrim=end_sample=${frames * 1600},asetpts=N/SR/TB`,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-t', seconds(frames), '-movflags', '+faststart', output]);
}

async function encodeLayout(ffmpeg, ffprobe, folder, proxy, segments, crf) {
  mkdirSync(folder);
  const files = segments.map((_, index) => path.join(folder, `segment-${index}.mov`));
  const completionOrder = [];
  const start = performance.now();
  const jobs = segments.map(({beginFrame, endFrame}, index) => encodeSegment(ffmpeg, proxy, beginFrame, endFrame, crf, files[index]));
  try {
    await Promise.all(jobs.map(async (job, index) => {
      await job.result();
      completionOrder.push(index);
    }));
  } catch (error) {
    await Promise.all(jobs.map(job => job.stop()));
    throw error;
  }
  const output = path.join(folder, 'joined.mp4');
  concatenate(ffmpeg, folder, segments, files, output);
  return {output, workers: jobs.length, completionOrder, wallSeconds: (performance.now() - start) / 1000,
    stagedBytes: files.reduce((sum, file) => sum + statSync(file).size, 0), ...fingerprint(ffmpeg, ffprobe, output)};
}

function compareLayouts(whole, split, expected) {
  const planOrdinals = compare(expected, split.ids);
  const wholeOrdinals = compare(expected, whole.ids);
  const pixels = compare(whole.hashes, split.hashes);
  const presentationTicks = compare(expected.map((_, n) => n * 1000), split.pts);
  const wholePresentationTicks = compare(expected.map((_, n) => n * 1000), whole.pts);
  return {planOrdinals, wholeOrdinals, pixels, presentationTicks, wholePresentationTicks,
    pass: [planOrdinals, wholeOrdinals, pixels, presentationTicks, wholePresentationTicks].every(row => row.pass)};
}

function finalEncode(ffmpeg, joined, frames, file) {
  media(ffmpeg, ['-i', joined, '-map', '0:v:0', '-map', '0:a:0', ...encoderArgs(), '-c:a', 'copy',
    '-t', seconds(frames), '-movflags', '+faststart', file]);
}

export async function runSegments({ffmpeg, ffprobe, scratchDir}) {
  const file = path.join(scratchDir, 'input.mp4');
  const count = 150;
  makeFixture(ffmpeg, file, small, count);
  const index = probeFrames(ffprobe, file);
  if (index.length !== count || !compare(index.map(frame => frame.ordinal), markerOrdinals(ffmpeg, file)).pass) {
    throw new Error('Wrong segment fixture length or ordinal');
  }
  const rows = [];
  for (const direction of ['forward', 'reverse']) {
    const plan = presetPlan('fastToSlow', count, direction);
    const expected = Array.from(unwrap(timeMapPlanFrames(plan)));
    const rowDir = path.join(scratchDir, direction);
    mkdirSync(rowDir);
    const proxy = path.join(rowDir, 'timed.yuv');
    await writeLookup(ffmpeg, file, small, index, direction, expected, proxy,
      ['-c:v', 'rawvideo', '-threads:v', '1', '-f', 'rawvideo']);
    const cuts = [1, 43, 89, expected.length];
    const segments = timelineCompositionSegments({durationFrames: expected.length, clips: [
      {startFrame: 0, durationFrames: expected.length},
      ...cuts.map((end, i) => ({startFrame: cuts[i - 1] ?? 0, durationFrames: end - (cuts[i - 1] ?? 0)})),
    ]});
    if (segments.length !== 4) throw new Error('Expected four clip-edge segments');
    const clock = segments.map(({beginFrame, endFrame}) => {
      const window = unwrap(trimTimeMap(plan, beginFrame, endFrame));
      const planned = Array.from(unwrap(timeMapPlanFrames(window)));
      return {beginFrame, endFrame, planned,
        retained: compare(expected.slice(beginFrame, endFrame), planned),
        resetToRootZero: compare(planned, expected.slice(0, endFrame - beginFrame))};
    });

    const wholeSegments = [{beginFrame: 0, endFrame: expected.length}];
    const whole = await encodeLayout(ffmpeg, ffprobe, path.join(rowDir, 'whole'), proxy, wholeSegments, 23);
    const current = await encodeLayout(ffmpeg, ffprobe, path.join(rowDir, 'current-split'), proxy, segments, 23);
    const lossless = await encodeLayout(ffmpeg, ffprobe, path.join(rowDir, 'lossless-split'), proxy, segments, 0);
    const fallback = path.join(rowDir, 'fallback.mp4');
    const start = performance.now();
    finalEncode(ffmpeg, lossless.output, expected.length, fallback);
    const fallbackWallSeconds = (performance.now() - start) / 1000;
    const candidate = fingerprint(ffmpeg, ffprobe, fallback);
    delete whole.output;
    delete current.output;
    delete lossless.output;
    rows.push({direction, expected, clock, whole, current, lossless, candidate, fallbackWallSeconds,
      currentComparison: compareLayouts(whole, current, expected),
      candidateComparison: compareLayouts(whole, candidate, expected)});
  }
  return {fixture: {...small, sourceFrames: count, fps, preset: 'fastToSlow'}, threshold: {maxWorkers: 4,
    frameCountDelta: 0, ordinalMismatches: 0, pixelHashMismatches: 0, ptsTickMismatches: 0, rootWindowMismatches: 0},
    candidatePass: rows.every(row => row.candidateComparison.pass && row.clock.every(part => part.retained.pass)),
    rows, pass: rows.every(row => row.currentComparison.pass && row.clock.every(part => part.retained.pass))};
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function runCancel({ffmpeg, ffprobe, scratchDir}) {
  const stage = path.join(scratchDir, 'active');
  mkdirSync(stage);
  const source = path.join(scratchDir, 'input.mp4');
  const destination = path.join(scratchDir, 'published.mov');
  makeFixture(ffmpeg, source, small, 150);
  const frameIndex = probeFrames(ffprobe, source);
  const expected = unwrap(timeMapPlanFrames(presetPlan('slowMiddle', frameIndex.length, 'forward')));
  const sourceSize = statSync(source).size;
  const proxy = path.join(stage, 'lookup.mov');
  const controller = new AbortController();
  const jobs = [];
  const observe = (role, job, file) => {
    const record = {role, job, file, frames: 0};
    jobs.push(record);
    if (file) createInterface({input: job.child.stdout}).on('line', line => {
      if (line.startsWith('frame=')) record.frames = Number(line.slice(6));
    });
  };

  const lookup = writeLookup(ffmpeg, source, small, frameIndex, 'forward', expected, proxy, encoderArgs(),
    {signal: controller.signal, observe, realtime: true}).then(() => 'complete', error => {
    if (error.name !== 'AbortError') return 'error';
    return 'aborted';
  });
  const segments = Array.from({length: 4}, (_, index) => {
    const role = `segment-${index}`;
    const file = path.join(stage, `${role}.mov`);
    const job = startFfmpeg(ffmpeg, ['-re', '-stream_loop', '-1', '-i', source,
      '-t', '60', ...encoderArgs(), '-an', '-progress', 'pipe:1', file], {stdout: true});
    observe(role, job, file);
    return job;
  });
  controller.signal.addEventListener('abort', () => {
    for (const job of segments) void job.stop();
  }, {once: true});
  const completed = Promise.all([lookup, ...segments.map(job => job.closed)]).then(([status, ...encoders]) => {
    if (!controller.signal.aborted && status === 'complete' && encoders.every(row => row.code === 0)) {
      renameSync(proxy, destination);
    }
    return status;
  });

  let beforeCancel;
  let lookupStatus;
  let secondsAfterCancel;
  try {
    const startDeadline = performance.now() + 15_000;
    while (jobs.length !== 6 || !jobs.every(({frames, file}) =>
      !file || (frames > 0 && existsSync(file) && statSync(file).size > 0))) {
      if (performance.now() > startDeadline) throw new Error('Did not observe all partial outputs before cancellation');
      await delay(50);
    }
    beforeCancel = jobs.map(({job, role, file, frames}) => ({role, pid: job.child.pid, frames,
      running: pidExists(job.child.pid), bytes: file ? statSync(file).size : null}));
    const start = performance.now();
    controller.abort();
    lookupStatus = await completed;
    rmSync(stage, {recursive: true});
    secondsAfterCancel = (performance.now() - start) / 1000;
  } finally {
    controller.abort();
    await completed;
    rmSync(stage, {recursive: true, force: true});
  }

  const result = await Promise.all(beforeCancel.map(async (row, index) => ({
    ...row, status: await jobs[index].job.closed, reaped: !pidExists(row.pid),
  })));
  const remaining = readdirSync(scratchDir);
  return {threshold: {children: 6, survivors: 0, stageFiles: 0, publishedFiles: 0, secondsToReapAndClean: 5},
    telemetry: result, secondsAfterCancel, lookupStatus, remaining, stageFiles: Number(existsSync(stage)),
    publishedFiles: Number(existsSync(destination)),
    pass: secondsAfterCancel <= 5 && lookupStatus === 'aborted' && !existsSync(destination) && remaining.length === 1 &&
      remaining[0] === path.basename(source) && statSync(source).size === sourceSize &&
      result.every(row => row.running && row.reaped && (row.status.signal !== null || row.status.code !== 0))};
}
