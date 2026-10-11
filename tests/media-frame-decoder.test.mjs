import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { once, getEventListeners } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FRAME_PROFILE, FRAME_PROFILE_ID } from '@mioon/contracts';
import { decodeManagedFrame, frameDecodePlan, FRAME_DECODE_LIMITS } from '../packages/business/src/frame-decoder.mjs';
import { validateManagedSource } from '../packages/business/src/managed-media.mjs';
import { parseProbeOutput } from '../packages/business/src/media-probe.mjs';
import { run, runStreaming } from '../packages/business/src/media-runtime.mjs';
import { hasUnconfirmedMediaProcesses, onMediaProcess, terminateMediaProcesses } from '../packages/business/src/media-processes.mjs';
import { renderMockImagePng, validatePng } from '../packages/business/src/images/png.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeCode = code => error => error.code === code && !error.message.includes('synthetic-private') && !Object.hasOwn(error, 'cause');
const metadata = (stream = {}, format = {}, extra = []) => ({ probe: {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1', start_time: '0', ...format },
  streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 16, height: 12, pix_fmt: 'yuv420p', field_order: 'progressive',
    start_time: '0', start_pts: 0, duration: '1', time_base: '1/15360', sample_aspect_ratio: '1:1', disposition: { attached_pic: 0 }, ...stream }, ...extra],
} });
const plan = (value = metadata(), requestedFrame = 0, mimeType = 'video/mp4') => frameDecodePlan(value, { requestedFrame, mimeType });
async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-frame-decode-'));
  await chmod(root, 0o700); await mkdir(path.join(root, 'media'), { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function source(root, { name = 'synthetic-private-source.mp4', bytes = Buffer.from('synthetic-private-managed-source'), mimeType = 'video/mp4' } = {}) {
  const relativePath = `media/${name}`, file = path.join(root, relativePath);
  if (bytes !== null) await writeFile(file, bytes, { mode: 0o600 });
  const actual = bytes ?? await readFile(file);
  const asset = { relativePath, sha256: hash(actual), mimeType, sizeBytes: actual.length };
  return { root, asset, ...validateManagedSource(root, asset), requestedFrame: 0 };
}
function environment(t, key, value) {
  const old = process.env[key]; process.env[key] = value;
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
async function binary(root, name, body) {
  const file = path.join(root, name);
  await writeFile(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 }); return file;
}
async function fakeProbe(t, root, value = metadata({ width: 1024, height: 1024 })) {
  const file = await binary(root, 'synthetic probe 工具', `process.stdout.write(${JSON.stringify(JSON.stringify(value.probe))});`);
  environment(t, 'MIOON_FFPROBE_PATH', file); return file;
}
async function fakeDecode(t, root, body) {
  const file = await binary(root, 'synthetic decoder 工具', body); environment(t, 'MIOON_FFMPEG_PATH', file); return file;
}

test('exact integer presentation threshold preserves CFR boundaries and fractional time bases', () => {
  assert.match(plan(metadata(), 1).filter, /between\(pts,512,9216000\)/);
  assert.match(plan(metadata(), 2).filter, /between\(pts,1024,9216000\)/);
  assert.match(plan(metadata({ time_base: '1/1000' }), 1).filter, /between\(pts,34,600000\)/);
  assert.match(plan(metadata({ time_base: '1/1000000000' }), 10).filter, /between\(pts,333333334,600000000000\)/);
  assert.match(plan(metadata({ time_base: '1/1000000000', duration: '600' }, { duration: '600' }), 17999).filter, /between\(pts,599966666667,600000000000\)/);
  const filter = plan().filter;
  assert.match(filter, /if\(eq\(TB,1\/15360\),if\(isnan\(pts\),0,/);
  assert.match(filter, /eq\(interlace_type,PROGRESSIVE\)/);
  assert.doesNotMatch(filter, /toFixed|gte\(t,|eq\(n,|fps=/);
  assert.equal(FRAME_PROFILE_ID, 'local-png-1024-v1');
  assert.equal(FRAME_PROFILE.selectionRule, 'first-pts-at-or-after-v1');
});

test('fixed aspect-preserving output is bounded and never upscales either orientation', () => {
  for (const [width, height, expected] of [[16, 12, [16, 12]], [12, 16, [12, 16]], [3840, 2160, [1024, 576]], [2160, 3840, [576, 1024]],
    [4096, 1, [1024, 1]], [1, 4096, [1, 1024]], [1500, 1000, [1024, 683]], [1024, 1024, [1024, 1024]]]) {
    const result = plan(metadata({ width, height }));
    assert.deepEqual([result.width, result.height], expected);
    assert.deepEqual(result.probe, { streamIndex: 0, timeBaseNumerator: 1, timeBaseDenominator: 15360, width, height, rotation: 0, sarNumerator: 1, sarDenominator: 1 });
    assert.match(result.filter, new RegExp(`scale=${expected[0]}:${expected[1]}:flags=bilinear,setsar=1,format=rgb24$`));
  }
  assert.equal(FRAME_DECODE_LIMITS.sourcePixels, 8 * 1024 * 1024);
  assert.equal(FRAME_DECODE_LIMITS.outputBytes, 4 * 1024 * 1024);
  assert.equal(FRAME_DECODE_LIMITS.decodeMs, 120000); assert.equal(FRAME_DECODE_LIMITS.attemptMs, 180000);
});

test('capture-only profile rejects ambiguous streams, nonzero/unknown starts, SAR, rotation and unsupported decode bounds', () => {
  const cases = [
    metadata({ codec_name: 'hevc' }), metadata({ pix_fmt: 'yuv420p10le' }), metadata({ bits_per_raw_sample: '10' }), metadata({ field_order: 'tt' }), metadata({ field_order: 'unknown' }),
    metadata({ width: 4097 }), metadata({ width: 4096, height: 4096 }), metadata({ width: 0 }),
    metadata({ sample_aspect_ratio: '2:1' }), metadata({ sample_aspect_ratio: '0:0' }), metadata({ sample_aspect_ratio: undefined }),
    metadata({ tags: { rotate: '0' } }), metadata({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }),
    metadata({ side_data_list: [{ displaymatrix: 'synthetic-private-matrix' }] }), metadata({}, { tags: { rotation: '0' } }),
    metadata({ start_time: '0.001' }), metadata({ start_time: '-0.001' }), metadata({ start_time: undefined }), metadata({ start_time: 'N/A' }), metadata({ start_pts: 1 }),
    metadata({}, { start_time: undefined }), metadata({}, { start_time: '0.001' }), metadata({}, { start_time: '' }),
    metadata({ duration: '601' }), metadata({ duration: '0' }), metadata({}, { duration: '0' }), metadata({}, { duration: '601' }), metadata({}, { duration: 'Infinity' }),
    metadata({ time_base: '1001/30000' }), metadata({ time_base: '1/1000000001' }), metadata({ time_base: '1/0' }), metadata({ time_base: undefined }),
    metadata({ index: -1 }), metadata({ index: 256 }), metadata({}, {}, [{ ...metadata().probe.streams[0], index: 1 }]),
    metadata({}, {}, [{ index: 0, codec_type: 'audio' }]), metadata({ disposition: { attached_pic: 1 } }), metadata({ disposition: { attached_pic: '0' } }),
    metadata({}, { format_name: 'concat' }), metadata({}, { format_name: 'matroska,webm' }),
  ];
  for (const value of cases) assert.throws(() => plan(value), safeCode('FRAME_PROFILE_UNSUPPORTED'));
  for (const requestedFrame of [-1, 0.5, NaN, Infinity, 18000, Number.MAX_SAFE_INTEGER]) assert.throws(() => plan(metadata(), requestedFrame), { code: 'MEDIA_INVALID_CONFIGURATION' });
  assert.throws(() => plan(metadata(), 30), { code: 'FRAME_NO_FRAME' });
  for (const codec_name of ['vp8', 'vp9']) for (const field_order of [undefined, 'unknown', 'progressive']) {
    const result = plan(metadata({ codec_name, field_order, duration: undefined, time_base: '1/1000' }, { format_name: 'matroska,webm' }), 1, 'video/webm');
    assert.equal(result.probe.timeBaseDenominator, 1000);
  }
  assert.equal(plan(metadata({ index: 3 }, {}, [{ index: 1, codec_type: 'video', disposition: { attached_pic: 1 } }, { index: 0, codec_type: 'audio' }])).probe.streamIndex, 3);
  // A capture refusal never changes the existing generic editor probe profile.
  assert.equal(parseProbeOutput(JSON.stringify(metadata({ codec_name: 'hevc', width: 7680, height: 4320 }).probe)).width, 7680);
});

test('bad input, pre-abort, changed source and source byte cap reject before spawning', async t => {
  const root = await sandbox(t), input = await source(root), events = [], off = onMediaProcess(event => events.push(event)); t.after(off);
  for (const patch of [{ file: 'https://example.invalid/private' }, { root: '.' }, { requestedFrame: -1 }, { beforeSpawn: 1 }]) {
    await assert.rejects(decodeManagedFrame({ ...input, ...patch }), { code: 'MEDIA_INVALID_CONFIGURATION' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(decodeManagedFrame({ ...input, signal: controller.signal }), { code: 'MEDIA_CANCELLED' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(decodeManagedFrame({ ...input, asset: { ...input.asset, sha256: '0'.repeat(64) } }), { code: 'MANAGED_SOURCE_CHANGED' });
  await writeFile(input.file, 'changed');
  await assert.rejects(decodeManagedFrame(input), { code: 'MANAGED_SOURCE_CHANGED' });
  const big = await source(root, { name: 'big.mp4' }); await truncate(big.file, FRAME_DECODE_LIMITS.sourceBytes + 1); big.info = await stat(big.file);
  await assert.rejects(decodeManagedFrame(big), { code: 'MANAGED_SOURCE_LIMIT' });
  assert.deepEqual(events, []);
});

test('synthetic tools verify exact selected stream, shell-free restricted arguments, minimal environment and safe provenance', async t => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture; native Windows readiness is tested separately'); return; }
  const root = await sandbox(t), input = await source(root), png = await renderMockImagePng(), resultFile = path.join(root, 'decoder-observed.json');
  await fakeProbe(t, root, metadata({ index: 3, width: 1024, height: 1024 }, {}, [{ index: 0, codec_type: 'audio' }]));
  const payload = path.join(root, 'png.bin'); await writeFile(payload, png);
  await fakeDecode(t, root, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({args:process.argv.slice(2),keys:Object.keys(process.env)}));process.stdout.write(fs.readFileSync(${JSON.stringify(payload)}));`);
  environment(t, 'SYNTHETIC_PRIVATE_PROVIDER_KEY', 'synthetic-private-never-forward');
  let guards = 0;
  const guardSignals = [], controller = new AbortController();
  const decoded = await decodeManagedFrame({ ...input, requestedFrame: 2, signal: controller.signal, beforeSpawn(attemptSignal) { guards++; guardSignals.push(attemptSignal); } });
  assert.equal(guards, 2); assert.ok(decoded.bytes.equals(png));
  assert.ok(guardSignals[0] instanceof AbortSignal); assert.equal(guardSignals[0], guardSignals[1]); assert.notEqual(guardSignals[0], controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(decoded.metadata, await validatePng(png));
  assert.deepEqual(decoded.provenance, { profileId: FRAME_PROFILE_ID, selectionRule: FRAME_PROFILE.selectionRule, sourceFrame: 2, fps: 30,
    sourceHash: input.asset.sha256, probe: { streamIndex: 3, timeBaseNumerator: 1, timeBaseDenominator: 15360, width: 1024, height: 1024, rotation: 0, sarNumerator: 1, sarDenominator: 1 } });
  assert.doesNotMatch(JSON.stringify(decoded.provenance), /synthetic-private|relativePath|actualSelectedPTS|selectedPts/);
  const { args, keys } = JSON.parse(await readFile(resultFile, 'utf8'));
  for (const flag of ['-nostdin', '-noautorotate', '-copyts', '-an', '-sn', '-dn']) assert.ok(args.includes(flag));
  for (const [flag, value] of [['-max_pixels', String(FRAME_DECODE_LIMITS.sourcePixels)], ['-protocol_whitelist', 'file,pipe'], ['-format_whitelist', 'mov,matroska'], ['-map', '0:3'], ['-map_metadata', '-1'],
    ['-map_metadata:s:v:0', '-1'], ['-map_chapters', '-1'], ['-frames:v', '1'], ['-fps_mode', 'passthrough'], ['-c:v', 'png'], ['-pix_fmt', 'rgb24'], ['-f', 'image2pipe']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.equal(args.at(-1), 'pipe:1'); assert.equal(args[args.indexOf('-i') + 1], input.file);
  assert.equal(args.filter(value => value === '-threads').length, 2);
  args.forEach((value, index) => { if (['-threads', '-filter_threads'].includes(value)) assert.equal(args[index + 1], '1'); });
  assert.ok(!args.includes('-ss')); assert.ok(!args.includes('-r')); assert.ok(!args.includes('-y'));
  assert.ok(!keys.includes('SYNTHETIC_PRIVATE_PROVIDER_KEY')); assert.ok(!keys.includes('MIOON_FFMPEG_PATH'));
  assert.deepEqual(await readdir(path.join(root, 'media')), ['synthetic-private-source.mp4']);
});

test('owner guards are synchronous and a post-probe refusal cannot spawn a decoder', async t => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const root = await sandbox(t), input = await source(root), events = [], off = onMediaProcess(event => events.push(event)); t.after(off);
  await fakeProbe(t, root);
  let calls = 0;
  await assert.rejects(decodeManagedFrame({ ...input, beforeSpawn() { if (++calls === 2) throw Object.assign(new Error('Owner fence closed.'), { code: 'OWNER_FENCE_CLOSED' }); } }), { code: 'OWNER_FENCE_CLOSED' });
  assert.deepEqual(events.map(event => [event.kind, event.type]), [['ffprobe', 'started'], ['ffprobe', 'exited']]);
  const before = events.length;
  await assert.rejects(decodeManagedFrame({ ...input, async beforeSpawn() {} }), { code: 'MEDIA_INVALID_CONFIGURATION' });
  assert.equal(events.length, before);
});

test('empty, malformed, concatenated, excessive and failed decoder output never produce a receipt', async t => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const root = await sandbox(t), input = await source(root), png = await renderMockImagePng(), payload = path.join(root, 'valid.png'); await writeFile(payload, png);
  await fakeProbe(t, root);
  const cases = [
    ['empty', '', 'FRAME_NO_FRAME'],
    ['malformed', `process.stdout.write('synthetic-private-not-png');`, 'FRAME_OUTPUT_INVALID'],
    ['truncated', `const b=require('node:fs').readFileSync(${JSON.stringify(payload)});process.stdout.write(b.subarray(0,b.length-1));`, 'FRAME_OUTPUT_INVALID'],
    ['concatenated', `const b=require('node:fs').readFileSync(${JSON.stringify(payload)});process.stdout.write(Buffer.concat([b,b]));`, 'FRAME_OUTPUT_INVALID'],
    ['overflow', `process.stdout.write(Buffer.alloc(${FRAME_DECODE_LIMITS.outputBytes + 1}));`, 'MEDIA_OUTPUT_LIMIT'],
    ['failed', `process.stderr.write('synthetic-private-input-path-and-output');process.exit(1);`, 'MEDIA_EXIT_FAILED'],
  ];
  for (const [name, body, code] of cases) await t.test(name, async sub => {
    await fakeDecode(sub, root, body); await assert.rejects(decodeManagedFrame(input), safeCode(code));
    assert.deepEqual(await terminateMediaProcesses(), []);
  });
});

test('both source mutation during decode and cancellation at decoder close reject valid PNG bytes', async t => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const root = await sandbox(t), png = await renderMockImagePng(), payload = path.join(root, 'valid.png'); await writeFile(payload, png); await fakeProbe(t, root);
  const input = await source(root);
  await t.test('source changed', async sub => {
    await fakeDecode(sub, root, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(input.file)},'changed source');process.stdout.write(fs.readFileSync(${JSON.stringify(payload)}));`);
    await assert.rejects(decodeManagedFrame(input), { code: 'MANAGED_SOURCE_CHANGED' });
  });
  const fresh = await source(root);
  await t.test('cancel at close', async sub => {
    await fakeDecode(sub, root, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(payload)}));`);
    const controller = new AbortController(), off = onMediaProcess(event => { if (event.kind === 'ffmpeg' && event.type === 'exited') controller.abort(); }); sub.after(off);
    await assert.rejects(decodeManagedFrame({ ...fresh, signal: controller.signal }), { code: 'MEDIA_CANCELLED' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});

test('whole attempt deadline and in-flight cancellation stop and reap the owned child', async t => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const root = await sandbox(t), input = await source(root); await fakeProbe(t, root); await fakeDecode(t, root, 'setInterval(()=>{},1000);');
  for (const kind of ['abort', 'attempt', 'decode']) await t.test(kind, async sub => {
    const controller = new AbortController(), events = [], original = globalThis.setTimeout;
    let guards = 0;
    if (kind !== 'abort') sub.mock.method(globalThis, 'setTimeout', function (callback, delay, ...args) {
      const shorten = kind === 'attempt' && delay === FRAME_DECODE_LIMITS.attemptMs || kind === 'decode' && guards === 2 && delay === FRAME_DECODE_LIMITS.decodeMs;
      return original(callback, shorten ? 250 : delay, ...args);
    });
    const off = onMediaProcess(event => { events.push(event); if (kind === 'abort' && event.kind === 'ffmpeg' && event.type === 'started') controller.abort(); }); sub.after(off);
    await assert.rejects(decodeManagedFrame({ ...input, signal: controller.signal, beforeSpawn() { guards++; } }), {
      code: kind === 'abort' ? 'MEDIA_CANCELLED' : kind === 'decode' ? 'MEDIA_TIMEOUT' : 'FRAME_ATTEMPT_TIMEOUT',
    });
    assert.equal(events.filter(event => event.type === 'started').length, events.filter(event => event.type === 'exited').length);
    assert.deepEqual(await terminateMediaProcesses(), []); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});

test('unconfirmed decoder termination is preserved and blocks new child starts until actual close', async t => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const root = await sandbox(t), input = await source(root); await fakeProbe(t, root); await fakeDecode(t, root, 'setInterval(()=>{},1000);');
  const originalKill = ChildProcess.prototype.kill, controller = new AbortController(), events = []; let owned;
  const intercept = t.mock.method(ChildProcess.prototype, 'kill', function () { owned = this; return false; });
  const off = onMediaProcess(event => { events.push(event); if (event.kind === 'ffmpeg' && event.type === 'started') controller.abort(); });
  try {
    await assert.rejects(decodeManagedFrame({ ...input, signal: controller.signal }), { code: 'MEDIA_CANCELLED', terminationUnconfirmed: true });
    assert.equal(hasUnconfirmedMediaProcesses(), true);
    const count = events.length;
    await assert.rejects(decodeManagedFrame(input), { code: 'MEDIA_TERMINATION_UNCONFIRMED', terminationUnconfirmed: true });
    assert.equal(events.length, count);
    intercept.mock.restore(); const closed = once(owned, 'close'); originalKill.call(owned, 'SIGKILL'); await closed;
    assert.equal(hasUnconfirmedMediaProcesses(), false);
  } finally { off(); intercept.mock.restore(); if (owned?.exitCode === null && owned?.signalCode === null) originalKill.call(owned, 'SIGKILL'); }
});

// The real fixtures use per-frame colors, not testsrc's visually similar frames.
// Only fixture creation uses frame indexes; production selection is entirely PTS.
const colors = [[240, 20, 20], [20, 230, 20], [20, 20, 240], [230, 230, 20], [20, 230, 230], [230, 20, 230], [220, 120, 20], [110, 20, 220], [20, 150, 110], [210, 110, 150], [120, 190, 220], [230, 230, 230]];
async function coloredFixture(root, { name, rate = '30', count = 12, width = 16, height = 12, extra = [], filters = 'setsar=1', codec = 'libx264', extension = 'mp4' }) {
  const raw = path.join(root, `${name}.rgb`), bytes = Buffer.alloc(width * height * 3 * count);
  for (let frame = 0; frame < count; frame++) for (let at = frame * width * height * 3; at < (frame + 1) * width * height * 3; at += 3) bytes.set(colors[frame % colors.length], at);
  await writeFile(raw, bytes);
  const file = path.join(root, 'media', `${name}.${extension}`);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
    '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`, '-framerate', rate, '-i', raw,
    '-vf', filters, '-an', '-c:v', codec, ...(codec === 'libx264' ? ['-preset', 'medium', '-crf', '12', '-bf', '0'] : ['-deadline', 'realtime', '-cpu-used', '8']),
    '-pix_fmt', 'yuv420p', '-threads', '1', ...extra, file]);
  return source(root, { name: `${name}.${extension}`, bytes: null, mimeType: extension === 'webm' ? 'video/webm' : 'video/mp4' });
}
async function pngColor(root, decoded, name) {
  const file = path.join(root, `${name}.png`); await writeFile(file, decoded.bytes);
  const chunks = [];
  await runStreaming('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', file,
    '-frames:v', '1', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { maxStdoutBytes: decoded.metadata.width * decoded.metadata.height * 3, onStdout(chunk) { chunks.push(chunk); } });
  const pixels = Buffer.concat(chunks), at = (Math.floor(decoded.metadata.height / 2) * decoded.metadata.width + Math.floor(decoded.metadata.width / 2)) * 3;
  return [...pixels.subarray(at, at + 3)];
}
async function assertColor(root, input, mark, expectedIndex, label) {
  const decoded = await decodeManagedFrame({ ...input, requestedFrame: mark });
  const actual = await pngColor(root, decoded, label), expected = colors[expectedIndex % colors.length];
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= 16, `${label}: ${actual} should match frame color ${expected}`));
  assert.equal(decoded.provenance.sourceFrame, mark); assert.ok(!Object.hasOwn(decoded.provenance, 'actualSelectedPTS'));
  return decoded;
}

test('real colored CFR30 and CFR24 choose the first presentation frame at or after N/30', { timeout: 60000 }, async t => {
  const root = await sandbox(t);
  const cfr30 = await coloredFixture(root, { name: 'cfr30' });
  for (const mark of [0, 1, 2, 5, 11]) await assertColor(root, cfr30, mark, mark, `cfr30-${mark}`);
  const cfr24 = await coloredFixture(root, { name: 'cfr24', rate: '24' });
  for (const [mark, index] of [[0, 0], [1, 1], [2, 2], [5, 4], [10, 8]]) await assertColor(root, cfr24, mark, index, `cfr24-${mark}`);
  const eof = await coloredFixture(root, { name: 'eof24', rate: '24', count: 2 });
  await assert.rejects(decodeManagedFrame({ ...eof, requestedFrame: 2 }), { code: 'FRAME_NO_FRAME' });
  await assert.rejects(decodeManagedFrame({ ...cfr30, requestedFrame: 12 }), { code: 'FRAME_NO_FRAME' });
});

test('real VFR, B-frame reordering and fractional timestamps obey presentation time rather than frame numbers', { timeout: 60000 }, async t => {
  const root = await sandbox(t);
  // A trailing guard frame gives the last asserted VFR frame an explicit
  // following timestamp. Some muxer versions otherwise put the final sample
  // exactly at the container end and omit it from decoded presentation frames.
  const vfr = await coloredFixture(root, { name: 'vfr', count: 5, filters: "setsar=1,settb=1/90000,setpts='if(eq(N,0),0,if(eq(N,1),3000,if(eq(N,2),9000,if(eq(N,3),18000,27000))))'",
    extra: ['-enc_time_base', '1:90000', '-video_track_timescale', '90000', '-fps_mode', 'vfr'] });
  const vfrProbe = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts:stream=time_base', '-of', 'json', vfr.file]));
  assert.equal(vfrProbe.streams[0].time_base, '1/90000');
  assert.deepEqual(vfrProbe.frames.slice(0, 4).map(frame => frame.pts), [0, 3000, 9000, 18000]);
  for (const [mark, index] of [[1, 1], [2, 2], [3, 2], [4, 3]]) await assertColor(root, vfr, mark, index, `vfr-${mark}`);
  const bframes = await coloredFixture(root, { name: 'bframes', extra: ['-bf', '2', '-g', '30', '-x264-params', 'b-adapt=0'] });
  const bprobe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', bframes.file]));
  assert.ok(bprobe.streams[0].has_b_frames > 0);
  for (const mark of [1, 2, 5, 10]) await assertColor(root, bframes, mark, mark, `bframes-${mark}`);
  const fractional = await coloredFixture(root, { name: 'fractional', rate: '30000/1001', extra: ['-video_track_timescale', '30000'] });
  for (const mark of [1, 2, 5]) await assertColor(root, fractional, mark, mark, `fractional-${mark}`);
});

test('real filter evaluation cannot select missing PTS, a mismatched actual time base or an interlaced frame', { timeout: 60000 }, async () => {
  const filter = plan().filter;
  for (const prefix of ['settb=1/15360,setpts=NAN', 'settb=1/1000', 'settb=1/15360,setfield=tff']) {
    const result = await runStreaming('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'color=c=red:s=16x12:r=30:d=0.1', '-vf', `${prefix},${filter}`, '-frames:v', '1',
      '-fps_mode', 'passthrough', '-threads', '1', '-c:v', 'png', '-pix_fmt', 'rgb24', '-f', 'image2pipe', 'pipe:1'], {
      maxStdoutBytes: FRAME_DECODE_LIMITS.outputBytes, onStdout() { assert.fail('An unsupported filter frame must not be selected'); },
    });
    assert.equal(result.stdoutBytes, 0);
  }
});

test('real WebM VP8/VP9 and nonsquare downscaled output follow the same bounded profile', { timeout: 60000 }, async t => {
  const root = await sandbox(t);
  for (const codec of ['libvpx', 'libvpx-vp9']) {
    const input = await coloredFixture(root, { name: codec, codec, count: 4, extension: 'webm' });
    // WebM timestamps are milliseconds: the second frame is at 33ms, just
    // before 1/30. The first eligible native timestamp is therefore 67ms.
    await assertColor(root, input, 1, 2, `${codec}-mark1`);
    await assertColor(root, input, 0, 0, `${codec}-mark0`);
  }
  const landscape = await coloredFixture(root, { name: 'wide', width: 1536, height: 864, count: 1 });
  const decoded = await assertColor(root, landscape, 0, 0, 'wide-scaled');
  assert.deepEqual([decoded.metadata.width, decoded.metadata.height], [1024, 576]);
});

test('real nonzero origin, non-square SAR, rotation and malformed local input are refused safely', { timeout: 60000 }, async t => {
  const root = await sandbox(t);
  const shifted = await coloredFixture(root, { name: 'shifted', count: 3, filters: 'setsar=1,setpts=PTS+1/TB', extra: ['-copyts'] });
  await assert.rejects(decodeManagedFrame(shifted), { code: 'FRAME_PROFILE_UNSUPPORTED' });
  const sar = await coloredFixture(root, { name: 'sar', count: 3, filters: 'setsar=2/1' });
  await assert.rejects(decodeManagedFrame(sar), { code: 'FRAME_PROFILE_UNSUPPORTED' });
  const clean = await coloredFixture(root, { name: 'unrotated', count: 3 });
  const rotated = path.join(root, 'media', 'rotated.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-display_rotation:v:0', '90', '-i', clean.file, '-map', '0:v', '-c', 'copy', rotated]);
  const rotatedProbe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', rotated]));
  assert.ok(rotatedProbe.streams[0].side_data_list?.some(entry => entry.side_data_type === 'Display Matrix' && Math.abs(entry.rotation) === 90));
  await assert.rejects(decodeManagedFrame(await source(root, { name: 'rotated.mp4', bytes: null })), { code: 'FRAME_PROFILE_UNSUPPORTED' });
  await assert.rejects(decodeManagedFrame(await source(root)), safeCode('MEDIA_EXIT_FAILED'));
});
