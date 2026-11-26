#!/usr/bin/env node
/** D9 product benchmark. Synthetic inputs and working media are always
 * temporary. Only summary JSON and stderr logs are kept for CI. */
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {loadavg, tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {OPTICAL_FLOW_FILTER} from '../../packages/business/src/timeline-processing/optical-proxy-port.ts';
import {probe} from './bench.mjs';
import {generateAnalytic, runFfmpeg} from './samples.mjs';
import {resolveTools} from './tools.mjs';

const [, , option, directory] = process.argv;
assert.ok(option === '--output' && directory, 'usage: run-product.mjs --output DIRECTORY');
const output = path.resolve(directory);
mkdirSync(output, {recursive: true});
const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-sp-i-product-'));
const worker = fileURLToPath(new URL('./product-worker.mjs', import.meta.url));
const status = line => {
  console.log(line);
  writeFileSync(path.join(output, 'status.log'), line + '\n', {flag: 'a'});
};
const report = {schemaVersion: 1, card: 'SP-I', status: 'running',
  environment: {platform: process.platform, arch: process.arch, node: process.version, loadBefore: loadavg()},
  measurement: {rss: 'Sum of worker and descendant RSS sampled every 100 ms. Shared pages may be counted twice.',
    includes: 'Optical proxy generation (optical only), video staging and a common libx264 encode for the portrait runs.'},
  portrait: [], motion: {}};
const mib = 1024 ** 2;

function measureRss(pid) {
  const result = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,rss='], {encoding: 'utf8', timeout: 3000});
  if (result.status !== 0) return null;
  const children = new Map();
  let rss = 0;
  for (const line of result.stdout.trim().split('\n')) {
    const [id, parent, kib] = line.trim().split(/\s+/).map(Number);
    if (id === pid) rss = kib;
    const siblings = children.get(parent) ?? [];
    siblings.push([id, kib]);
    children.set(parent, siblings);
  }
  const visited = new Set([pid]);
  for (const parent of visited) {
    for (const [id, kib] of children.get(parent) ?? []) {
      if (visited.has(id)) continue;
      visited.add(id);
      rss += kib;
    }
  }
  return rss * 1024;
}

async function runMode(tools, label, mode, {file, sourceFrames, width, height, cutSourceFrame}, delivery = 'lossless') {
  const name = label + '-' + mode;
  const work = path.join(scratch, name);
  mkdirSync(work, {mode: 0o700});
  const stdout = path.join(work, 'worker.json');
  const log = path.join(output, name + '.stderr.log');
  const outFd = openSync(stdout, 'w', 0o600);
  const errFd = openSync(log, 'w', 0o600);
  const args = [worker, mode, file, String(sourceFrames), work, delivery];
  if (cutSourceFrame !== undefined) args.push(String(cutSourceFrame));
  const start = process.hrtime.bigint();
  const child = spawn(process.execPath, args, {
    env: {...process.env, MIOON_FFMPEG_PATH: tools.ffmpeg, MIOON_FFPROBE_PATH: tools.ffprobe},
    stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  let peakRssBytes = 0;
  const interval = setInterval(() => {
    const rss = measureRss(child.pid);
    if (rss !== null) peakRssBytes = Math.max(rss, peakRssBytes);
  }, 100);
  status(`start ${name}`);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0, `${name} failed (${code ?? signal}): ${readFileSync(log, 'utf8').slice(-1200)}`);
  } finally {clearInterval(interval);}
  const wallSeconds = Number((Number(process.hrtime.bigint() - start) / 1e9).toFixed(3));
  const result = path.join(work, delivery === 'x264' ? 'result.mkv' : 'stage.mkv');
  const video = probe(tools.ffprobe, result);
  assert.deepEqual([video.width, video.height, video.rFrameRate, video.nbFrames],
    [width, height, '30/1', sourceFrames * 4], name);
  assert.ok(peakRssBytes > 0, `no RSS sample for ${name}`);
  const stats = {...JSON.parse(readFileSync(stdout, 'utf8')), mode, wallSeconds, peakRssBytes,
    frameCount: video.nbFrames, width, height, fps: video.rFrameRate};
  status(`finish ${name}: ${wallSeconds}s, ${(peakRssBytes / mib).toFixed(1)} MiB, ${video.nbFrames} frames`);
  return {file: result, stats, work};
}

function synthetic(ffmpeg, name, width, height, sourceFrames) {
  const file = path.join(scratch, name + '.mov');
  runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=30`, '-frames:v', String(sourceFrames),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', '-bf', '0', '-g', '60',
    '-pix_fmt', 'yuv420p', '-video_track_timescale', '30000', file]);
  return {file, sourceFrames, width, height};
}

function frameHashes(ffmpeg, input, filter = []) {
  return runFfmpeg(ffmpeg, ['-copyts', '-filter_threads', '1', '-i', input, ...filter, '-an',
    '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-f', 'framemd5', 'pipe:1']).stdout
    .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
}

async function longSource(tools) {
  const source = synthetic(tools.ffmpeg, 'long-source', 64, 64, 3600);
  const {file, stats} = await runMode(tools, 'long-source', 'optical', source);
  const {ffmpeg} = tools;
  const product = frameHashes(ffmpeg, file);
  const original = frameHashes(ffmpeg, source.file);
  // A single continuous filter run, with two clones padding each physical endpoint.
  const reference = frameHashes(ffmpeg, source.file, ['-vf', 'tpad=start=2:start_mode=clone:stop=2:stop_mode=clone,' +
    'settb=1/90000,setpts=N*12000,' + OPTICAL_FLOW_FILTER + ',trim=start_pts=8:end_pts=14408']);
  assert.equal(reference.length, stats.frameCount);
  assert.equal(product.length, reference.length);
  let anchorMismatches = 0;
  for (let frame = 0; frame < original.length; frame++) if (product[4 * frame] !== original[frame]) anchorMismatches++;
  let seamFrames = 0, seamMismatches = 0;
  for (let seam = 240; seam < product.length; seam += 240) {
    for (let frame = seam - 4; frame < seam + 4; frame++) {
      seamFrames++;
      if (product[frame] !== reference[frame]) seamMismatches++;
    }
  }
  assert.equal(anchorMismatches, 0, 'original source frame missing or out of order');
  assert.equal(seamMismatches, 0, 'block seam differs from the direct continuous optical run');
  return {...stats, sourceFrames: original.length, sourceDurationSeconds: 120, sourceBlockFrames: 60, seamFrames, seamMismatches,
    anchorMismatches, continuousReferenceMismatches: product.filter((hash, i) => reference[i] !== hash).length};
}

function encodeAnalytic(ffmpeg, label, source) {
  const file = path.join(scratch, label + '.mov');
  runFfmpeg(ffmpeg, ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${source.width}x${source.height}`,
    '-framerate', '30', '-i', source.file, '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0',
    '-threads', '1', '-bf', '0', '-video_track_timescale', '30000', file]);
  return {...source, file};
}

async function motionSample(tools, label, source) {
  const truth = readFileSync(source.groundTruth);
  const pixels = source.width * source.height;
  const frameBytes = pixels * 3 / 2;
  // The final interval repeats the last source image by design; compare
  // only fractional phases with two physical images.
  const frames = source.sourceFrames * 4 - 3;
  const rows = {};
  let blend;
  for (const mode of ['off', 'blend', 'optical']) {
    const {file, work} = await runMode(tools, label, mode, source);
    const raw = path.join(work, 'luma.raw');
    runFfmpeg(tools.ffmpeg, ['-i', file, '-threads:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', raw]);
    const output = readFileSync(raw);
    assert.equal(output.length, source.sourceFrames * 4 * frameBytes);
    let distance = 0, differentFromBlend = 0;
    for (let i = 1; i < frames; i++) {
      if (i % 4 === 0) continue;
      const start = i * frameBytes;
      for (let j = start; j < start + pixels; j++) {
        distance += Math.abs(output[j] - truth[j]);
        if (mode === 'optical' && output[j] !== blend[j]) differentFromBlend++;
      }
    }
    if (mode === 'blend') blend = output;
    rows[mode] = {fractionalLumaMae: distance / ((frames - 1) * 0.75 * pixels), differentFromBlend};
  }
  assert.ok(rows.optical.differentFromBlend > 0, label + ' did not exercise distinct blend and optical paths');
  return rows;
}

try {
  const tools = resolveTools(scratch);
  Object.assign(report.environment, {ffmpeg: tools.version, mediaToolSource: tools.source});
  const portrait = synthetic(tools.ffmpeg, 'portrait', 1080, 1920, 150);
  for (const mode of ['off', 'blend', 'optical']) {
    const stage = await runMode(tools, 'portrait', mode, portrait, 'x264');
    report.portrait.push(stage.stats);
    rmSync(stage.work, {recursive: true, force: true});
  }
  report.longSource = await longSource(tools);
  const originals = generateAnalytic(tools.ffmpeg, path.join(scratch, 'analytic'));
  for (const label of ['occlusion', 'fastMotion']) {
    report.motion[label] = await motionSample(tools, label, encodeAnalytic(tools.ffmpeg, label, originals[label]));
  }
  const scene = encodeAnalytic(tools.ffmpeg, 'sceneCut', originals.sceneCut);
  const normal = await runMode(tools, 'sceneCut', 'off', scene);
  const optical = await runMode(tools, 'sceneCut', 'optical', scene);
  const offFrames = frameHashes(tools.ffmpeg, normal.file);
  const opticalFrames = frameHashes(tools.ffmpeg, optical.file);
  const cut = scene.cutSourceFrame * 4;
  assert.deepEqual(opticalFrames.slice(cut - 3, cut + 4), offFrames.slice(cut - 3, cut + 4));
  report.sceneCut = {injectedKnownCut: scene.cutSourceFrame, matchedOffOutputFrames: {from: cut - 3, through: cut + 3}};
  assert.ok([report.portrait[2], report.longSource].every(row => row.peakRssBytes <= 1024 * mib),
    'optical processing exceeded the 1 GiB task budget');
  report.status = 'ok';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.message ?? error).slice(0, 2000);
  status(report.error);
  process.exitCode = 1;
} finally {
  report.environment.loadAfter = loadavg();
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  rmSync(scratch, {recursive: true, force: true});
}
