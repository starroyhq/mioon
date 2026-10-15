import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {probeTimelineSource, prepareTimelineInputs} from '../packages/business/src/timeline-sources.mjs';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.mjs';
import {inspectStaticSrgbJfif} from '../packages/business/src/timeline-jpeg-admission.ts';
import {inspectStaticSrgbPng} from '../packages/business/src/timeline-image-admission.ts';
import {run} from '../packages/business/src/media-runtime.mjs';
import {png, imageColour, evidenceOnly, timelineFixture, sha} from './helpers/timeline-image-fixtures.mjs';
import {jpegColour} from './helpers/timeline-jpeg-workflow-fixtures.mjs';
import {probeJfifFixture, PROBE_JFIF_SHA256} from './helpers/timeline-jpeg-probe-fixture.mjs';

const genericFormats = 'mov,matroska,mp3,wav,png_pipe,jpeg_pipe,webp_pipe';
const option = (args, key) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
function recordSpawns(t) {
  const original = childProcess.spawn, calls = [];
  childProcess.spawn = function(command, args, options) {
    calls.push({command: path.basename(command), args: [...args], shell: options?.shell});
    return original.call(this, command, args, options);
  };
  syncBuiltinESMExports();
  t.after(() => {childProcess.spawn = original; syncBuiltinESMExports();});
  return calls;
}
async function fixture(t, {bytes = probeJfifFixture(), mimeType = 'image/jpeg', declaredHash, evidence} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-jfif-probe-'));
  await mkdir(path.join(root, 'media'), {mode: 0o700});
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const asset = {id: randomUUID(), projectId: randomUUID(), sha256: declaredHash ?? sha(bytes), sizeBytes: bytes.length,
    mimeType, relativePath: `media/${randomUUID()}.${extension}`, width: 320, height: 180, duration: null, hasAudio: false};
  const file = path.join(root, asset.relativePath); await writeFile(file, bytes, {mode: 0o600});
  t.after(() => rm(root, {recursive: true, force: true}));
  const originalEvidence = evidence ?? evidenceOnly(await (mimeType === 'image/png' ? inspectStaticSrgbPng : inspectStaticSrgbJfif)(bytes));
  // Malformed-input cases supply a plausible saved declaration bound to their
  // current bytes; the actual source preparation must reject the file itself.
  const boundEvidence = {...originalEvidence, sha256: asset.sha256, sourceByteLength: bytes.length};
  const colour = mimeType === 'image/png' ? imageColour(boundEvidence) : jpegColour(boundEvidence);
  const timeline = timelineFixture([asset], [colour]);
  const snapshot = freezeTimelineSnapshot(timeline, new Map([[asset.id, asset]]));
  return {root, file, bytes, asset, snapshot,
    prepare: options => prepareTimelineInputs(snapshot, {root, projectId: asset.projectId,
      readAsset: id => id === asset.id ? asset : null, ...options})};
}
function assertLocalProbe(call, file, verified) {
  assert.equal(call.command, 'ffprobe'); assert.equal(call.shell, false);
  assert.deepEqual(call.args, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    ...(verified ? ['-format_whitelist', 'jpeg_pipe', '-f', 'jpeg_pipe'] : ['-format_whitelist', genericFormats]),
    '-show_format', '-show_streams', '-of', 'json', file]);
  assert.equal(option(call.args, '-protocol_whitelist'), 'file,pipe');
  assert.equal(option(call.args, '-format_whitelist'), verified ? 'jpeg_pipe' : genericFormats);
  assert.equal(call.args.includes('image2'), false); assert.equal(call.args.includes('-pattern_type'), false);
  assert.equal(call.args.includes('glob'), false); assert.equal(call.args.at(-1), file);
  if (verified) assert.equal(option(call.args, '-f'), 'jpeg_pipe');
  else assert.equal(call.args.includes('-f'), false);
}

test('exact 2592-byte JFIF reproduces real image2 autodetect and old restricted generic probe failure', async t => {
  const bytes = probeJfifFixture(); assert.equal(bytes.length, 2592); assert.equal(sha(bytes), PROBE_JFIF_SHA256);
  const f = await fixture(t);
  // Diagnostic only, on the fixed synthetic file: establish which demuxer the
  // real installed ffprobe autodetector chooses, without changing product policy.
  const detected = JSON.parse(await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_format', '-show_streams', '-of', 'json', f.file]));
  assert.equal(detected.format.format_name, 'image2');
  assert.equal(detected.streams[0].codec_name, 'mjpeg');
  const calls = recordSpawns(t);
  await assert.rejects(probeTimelineSource(f.file), {code: 'MEDIA_EXIT_FAILED'});
  assert.equal(calls.length, 1); assertLocalProbe(calls[0], f.file, false);
});

test('hash-owned strict admission and real decode precede a jpeg_pipe-only metadata probe', async t => {
  const f = await fixture(t), before = await readFile(f.file), calls = recordSpawns(t), receivedOptions = [];
  const prepared = await f.prepare({probe: async (file, options) => {
    receivedOptions.push(options);
    assert.equal(calls.length, 1, 'one actual strict FFmpeg decode has completed before metadata probing');
    assert.equal(calls[0].command, 'ffmpeg');
    assert.equal(options.verifiedJfif, true);
    return probeTimelineSource(file, options);
  }});
  assert.equal(receivedOptions.length, 1);
  assert.deepEqual(calls.map(call => call.command), ['ffmpeg', 'ffprobe']);
  assertLocalProbe(calls[1], f.file, true);
  // The existing strict pixel decoder deliberately uses a single fixed image2
  // input with patterns disabled; the newly restricted metadata probe does not.
  assert.equal(option(calls[0].args, '-c:v'), 'mjpeg');
  assert.equal(option(calls[0].args, '-pattern_type'), 'none');
  assert.equal(option(calls[0].args, '-i'), f.file);
  const verified = prepared.get(f.asset.id), stream = verified.colourProbe.streams[0];
  assert.equal(verified.width, 320); assert.equal(verified.height, 180); assert.equal(verified.videoStreamIndex, 0);
  assert.equal(stream.codec_name, 'mjpeg'); assert.equal(stream.pix_fmt, 'yuvj444p');
  assert.equal(stream.width, 320); assert.equal(stream.height, 180);
  assert.equal(verified.colourImageEvidence.profileId, 'jfif-ycbcr8-srgb-v1');
  assert.equal(verified.colourImageEvidence.sha256, PROBE_JFIF_SHA256);
  assert.deepEqual(await readFile(f.file), before);
});

test('bad source hash, malformed JPEG and PNG masquerading as JPEG fail before decode or metadata probe spawn', async t => {
  const valid = probeJfifFixture(), validEvidence = evidenceOnly(await inspectStaticSrgbJfif(valid));
  const cases = [
    {bytes: valid, declaredHash: 'f'.repeat(64), code: 'MANAGED_SOURCE_CHANGED'},
    {bytes: valid.subarray(0, -2), evidence: validEvidence, code: 'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'},
    {bytes: png({width: 320, height: 180, rgba: false}), evidence: validEvidence, code: 'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'},
    {bytes: Buffer.from('not a JPEG but named image/jpeg'), evidence: validEvidence, code: 'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'},
  ];
  const calls = recordSpawns(t);
  for (const scenario of cases) {
    const f = await fixture(t, scenario); let probes = 0;
    await assert.rejects(f.prepare({probe: async (...args) => {probes++; return probeTimelineSource(...args);}}), {code: scenario.code});
    assert.equal(probes, 0); assert.equal(calls.length, 0);
  }
});

test('PNG source preparation retains the exact generic restricted probe without JPEG decode or flags', async t => {
  const f = await fixture(t, {bytes: png({width: 320, height: 180, rgba: false}), mimeType: 'image/png'});
  const calls = recordSpawns(t); let probes = 0;
  const prepared = await f.prepare({probe: async (file, options) => {
    probes++; assert.equal(Object.hasOwn(options, 'verifiedJfif'), false); return probeTimelineSource(file, options);
  }});
  assert.equal(probes, 1); assert.equal(calls.length, 1); assertLocalProbe(calls[0], f.file, false);
  assert.equal(prepared.get(f.asset.id).colourProbe.streams[0].codec_name, 'png');
});

test('generic video probe remains unchanged and only literal true selects the closed JPEG demuxer', async t => {
  const f = await fixture(t), videoFile = path.join(f.root, 'media', 'synthetic.mp4');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=gray:s=32x32:r=30',
    '-frames:v', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-y', videoFile]);
  const calls = recordSpawns(t);
  const media = await probeTimelineSource(videoFile); assert.equal(media.hasVideo, true);
  assert.equal(media.probe.streams[0].codec_name, 'h264'); assertLocalProbe(calls[0], videoFile, false);
  for (const value of [undefined, false, 1, 'true']) {
    await assert.rejects(probeTimelineSource(f.file, {verifiedJfif: value}), {code: 'MEDIA_EXIT_FAILED'});
    assertLocalProbe(calls.at(-1), f.file, false);
  }
});
