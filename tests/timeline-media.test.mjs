import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Independent, local-only renderer acceptance. The HTTP backend and its client are
// children of this one test invocation; no externally hosted backend or media is used.
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.join(repo, 'evidence/v2-tests/media');
const token = 'timeline-media-local-test-token-000000000';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const records = { startedAt: new Date().toISOString(), runtime: process.version, fixturePolicy: 'Synthetic lavfi media only; live providers disabled; HTTP client and server launched together', commands: [], http: [], processes: [], checks: [] };

async function command(file, args, binary = false) {
  const startedAt = new Date().toISOString();
  try {
    const result = await exec(file, args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    records.commands.push({ file, args, startedAt, exitCode: 0, stdout: binary ? { bytes: result.stdout.length, sha256: sha(result.stdout) } : result.stdout, stderr: String(result.stderr) });
    return result.stdout;
  } catch (error) {
    records.commands.push({ file, args, startedAt, exitCode: error.code, stdout: String(error.stdout), stderr: String(error.stderr) });
    throw error;
  }
}
async function ffmpeg(args) { return command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1', ...args]); }
async function freePort() {
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'video-workbench-v2-media-'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let child;
  async function start() {
    const processRecord = { action: 'start', at: new Date().toISOString(), port, root, stdout: '', stderr: '' };
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: repo, env: { ...process.env, PORT: String(port), WB_DATA_DIR: root, WB_TOKEN: token, VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER: '0', RUNWAYML_API_SECRET: '', RUNWAY_MAX_GENERATIONS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    processRecord.pid = child.pid; records.processes.push(processRecord);
    child.stdout.on('data', bytes => processRecord.stdout += bytes); child.stderr.on('data', bytes => processRecord.stderr += bytes);
    child.on('close', (code, signal) => Object.assign(processRecord, { exitCode: code, signal }));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error(`Backend exited: ${processRecord.stderr}`);
      try { if ((await fetch(base + '/health')).ok) return; } catch {}
      await pause(30);
    }
    throw Error(`Backend startup timed out: ${processRecord.stderr}`);
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const current = child, exited = once(current, 'exit');
    records.processes.push({ action: 'stop', signal, pid: current.pid, at: new Date().toISOString() }); current.kill(signal); await exited;
  }
  async function rpc(operation, input = {}, expectedStatus = 200) {
    const response = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ operation, input }) });
    const body = await response.json();
    records.http.push({ at: new Date().toISOString(), operation, input: input.dataBase64 ? { ...input, dataBase64: `[${input.dataBase64.length} base64 characters]` } : input, status: response.status, body });
    assert.equal(response.status, expectedStatus, `${operation}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, expectedStatus === 200, JSON.stringify(body)); return body.ok ? body.data : body.error;
  }
  async function exportUntil(id, predicate, timeout = 90_000) {
    const deadline = Date.now() + timeout; let job;
    while (Date.now() < deadline) {
      job = await rpc('export.get', { exportId: id }); if (predicate(job)) return job;
      await pause(75);
    }
    throw Error(`Export timeout: ${JSON.stringify(job)}`);
  }
  async function finish(id) {
    const job = await exportUntil(id, j => ['succeeded', 'failed'].includes(j.status));
    assert.equal(job.status, 'succeeded', JSON.stringify(job)); return job;
  }
  async function download(job, name) {
    assert.ok(job.assetId && job.url); const response = await fetch(base + job.url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer());
    const file = path.join(evidence, name); await writeFile(file, bytes); return file;
  }
  function inspect(fn, writable = false) {
    const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), { readOnly: !writable });
    try { return fn(db); } finally { db.close(); }
  }
  async function importFile(projectId, name, mimeType) {
    return rpc('asset.import', { projectId, name, mimeType, dataBase64: (await readFile(path.join(root, name))).toString('base64') });
  }
  async function project(name) {
    const p = await rpc('project.create', { name }); let timeline = await rpc('timeline.get', { projectId: p.id });
    async function mutate(operation, input) { timeline = await rpc(operation, { projectId: p.id, expectedRevision: timeline.revision, requestId: randomUUID(), ...input }); return timeline; }
    async function render(purpose = 'export') {
      return rpc('timeline.render', { projectId: p.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose });
    }
    return { id: p.id, get timeline() { return timeline; }, mutate, render };
  }
  await mkdir(evidence, { recursive: true });
  t.after(async () => {
    await stop(); records.finishedAt = new Date().toISOString(); records.result = records.checks.length && records.checks.every(c => c.result === 'passed') ? 'passed' : 'failed_or_incomplete';
    await writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify(records, null, 2)); await rm(root, { recursive: true, force: true });
  });
  await start(); return { root, base, start, stop, rpc, exportUntil, finish, download, inspect, importFile, project };
}

async function check(t, name, fn) {
  await t.test(name, async () => {
    try { const detail = await fn(); records.checks.push({ name, result: 'passed', ...detail }); }
    catch (error) { records.checks.push({ name, result: 'failed', message: error.message, stack: error.stack }); throw error; }
  });
}
async function probeOutput(file, frames, { legacy = false } = {}) {
  const info = JSON.parse(await command('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]));
  const video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio');
  assert.ok(video); assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 720); assert.equal(video.height, 1280); assert.equal(video.r_frame_rate, '30/1'); if (!legacy) assert.equal(video.avg_frame_rate, '30/1'); assert.equal(Number(video.nb_read_frames), frames);
  assert.ok(audio); assert.equal(audio.codec_name, 'aac'); assert.equal(Number(audio.sample_rate), 48000); assert.equal(audio.channels, 2); assert.equal(audio.channel_layout, 'stereo');
  assert.ok(Math.abs(Number(video.duration) - frames / 30) <= (legacy ? 0.05 : 0.00001), `video duration ${video.duration}`);
  assert.ok(Math.abs(Number(info.format.duration) - frames / 30) <= 0.05, `container duration ${info.format.duration}`);
  await command('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  await writeFile(file.replace(/\.mp4$/, '-probe.json'), JSON.stringify(info, null, 2)); return info;
}
async function frame(file, n) {
  const bytes = await command('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file, '-vf', `select=eq(n\\,${n}),format=rgb24`, '-fps_mode', 'passthrough', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-'], true);
  assert.equal(bytes.length, 720 * 1280 * 3, `frame ${n} exists`); return bytes;
}
function pixel(bytes, x, y) { const offset = (y * 720 + x) * 3; return [...bytes.subarray(offset, offset + 3)]; }
function expectPixel(bytes, x, y, expected, label) {
  const actual = pixel(bytes, x, y); assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 20), `${label}: pixel (${x},${y}) expected ${expected}, received ${actual}`); return { x, y, expected, actual, label };
}
async function pcm(file) { return command('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], true); }
function analyzeAudio(bytes, start, end, frequencies = []) {
  const from = Math.round(start * 48000), to = Math.min(Math.round(end * 48000), bytes.length / 4); let sum = 0;
  for (let i = from; i < to; i++) { const v = bytes.readFloatLE(i * 4); sum += v * v; }
  const amplitudes = Object.fromEntries(frequencies.map(frequency => {
    let re = 0, im = 0; for (let i = from; i < to; i++) { const v = bytes.readFloatLE(i * 4), angle = 2 * Math.PI * frequency * i / 48000; re += v * Math.cos(angle); im += v * Math.sin(angle); }
    return [frequency, 2 * Math.hypot(re, im) / (to - from)];
  }));
  return { start, end, rms: Math.sqrt(sum / (to - from)), amplitudes };
}
function expectTone(data, frequency, absentFrequency) {
  assert.ok(data.rms > 0.015, `expected audible signal: ${JSON.stringify(data)}`);
  assert.ok(data.amplitudes[frequency] > 0.015, `expected ${frequency}Hz: ${JSON.stringify(data)}`);
  if (absentFrequency) assert.ok(data.amplitudes[frequency] > data.amplitudes[absentFrequency] * 8, `source trim frequency: ${JSON.stringify(data)}`);
}
function expectSilence(data) { assert.ok(data.rms < 0.002, `expected silence: ${JSON.stringify(data)}`); }
async function fingerprints(file) {
  const video = await command('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']);
  return { video: video.split('\n').filter(line => line && !line.startsWith('#')).join('\n'), audio: sha(await pcm(file)) };
}

async function makeFixtures(root) {
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:size=720x1280:rate=30', '-frames:v', '1', '-threads', '1', path.join(root, 'red.png')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=720x1280:rate=30', '-frames:v', '1', '-threads', '1', path.join(root, 'blue.png')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red@0.5:size=120x120:rate=30,format=rgba', '-frames:v', '1', '-threads', '1', path.join(root, 'alpha-red.png')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=30:duration=1', '-f', 'lavfi', '-i', 'color=c=yellow:size=320x180:rate=30:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', path.join(root, 'trim-source.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-c:a', 'pcm_s16le', '-ac', '1', path.join(root, 'trim-tone.wav')]);
}

test('multitrack v2 real-media rendering acceptance', { timeout: 600_000 }, async t => {
  const f = await fixture(t); await makeFixtures(f.root);
  let composite;
  await check(t, 'layer order, transparent contain, exact frame edges, gaps, source trims, preview/export parity', async () => {
    const p = await f.project('V2 synthetic composite');
    const red = await f.importFile(p.id, 'red.png', 'image/png'), video = await f.importFile(p.id, 'trim-source.mp4', 'video/mp4'), audio = await f.importFile(p.id, 'trim-tone.wav', 'audio/wav');
    const videos = p.timeline.tracks.filter(track => track.kind === 'video').sort((a, b) => a.orderIndex - b.orderIndex), audioTrack = p.timeline.tracks.find(track => track.kind === 'audio');
    assert.ok(videos.length >= 2 && audioTrack);
    await p.mutate('timeline.clip.add', { trackId: videos[0].id, assetId: red.id, startFrame: 0, durationFrames: 60 });
    await p.mutate('timeline.clip.add', { trackId: videos[0].id, assetId: red.id, startFrame: 90, durationFrames: 30 });
    await p.mutate('timeline.clip.add', { trackId: videos[1].id, assetId: video.id, startFrame: 15, durationFrames: 30, sourceInFrame: 30, rect: { x: 180, y: 320, width: 360, height: 640 } });
    await p.mutate('timeline.clip.add', { trackId: audioTrack.id, assetId: audio.id, startFrame: 60, durationFrames: 30, sourceInFrame: 30 });
    const frozen = structuredClone(p.timeline), preview = await p.render('preview'), exported = await p.render('export');
    assert.equal(preview.mode, 'timeline'); assert.equal(preview.purpose, 'preview'); assert.equal(exported.purpose, 'export'); assert.equal(preview.timelineRevision, frozen.revision);
    assert.deepEqual(preview.snapshot.timeline, frozen); assert.deepEqual(exported.snapshot.timeline, frozen);
    for (const asset of [red, video, audio]) assert.equal(preview.snapshot.assets.find(a => a.id === asset.id)?.sha256, asset.sha256);
    // Change real visual content while the frozen jobs are queued/running. The
    // requested jobs must retain red frames 30..59 from their original snapshot.
    const originalLowerClip = p.timeline.clips.find(clip => clip.assetId === red.id && clip.startFrame === 0);
    await p.mutate('timeline.clip.update', { clipId: originalLowerClip.id, patch: { durationFrames: 30 } });
    const previewDone = await f.finish(preview.id), exportDone = await f.finish(exported.id);
    const previewFile = await f.download(previewDone, 'composite-preview.mp4'), exportFile = await f.download(exportDone, 'composite-export.mp4');
    await probeOutput(previewFile, 120); await probeOutput(exportFile, 120);
    assert.deepEqual(await fingerprints(previewFile), await fingerprints(exportFile), 'preview/export must decode identically');
    const pixels = [];
    for (const n of [0, 14, 45, 59, 90, 119]) pixels.push({ frame: n, ...expectPixel(await frame(exportFile, n), 360, 640, [255, 0, 0], 'lower red clip / exact edge') });
    for (const n of [15, 44]) {
      const bytes = await frame(exportFile, n);
      pixels.push({ frame: n, ...expectPixel(bytes, 360, 640, [255, 255, 0], 'upper video trimmed to second (yellow) source second') });
      pixels.push({ frame: n, ...expectPixel(bytes, 360, 350, [255, 0, 0], 'contain padding is transparent over lower track') });
      pixels.push({ frame: n, ...expectPixel(bytes, 50, 640, [255, 0, 0], 'outside overlay rectangle remains lower track') });
    }
    for (const n of [60, 89]) pixels.push({ frame: n, ...expectPixel(await frame(exportFile, n), 360, 640, [0, 0, 0], 'picture gap is black even with audio') });
    const sound = await pcm(exportFile);
    const silenceBefore = analyzeAudio(sound, 0.1, 0.4), embedded = analyzeAudio(sound, 0.7, 1.2, [330, 660]), silenceBetween = analyzeAudio(sound, 1.6, 1.9), audioOnly = analyzeAudio(sound, 2.1, 2.8, [440, 880]), silenceAfter = analyzeAudio(sound, 3.1, 3.8);
    expectSilence(silenceBefore); expectTone(embedded, 660, 330); expectSilence(silenceBetween); expectTone(audioOnly, 880, 440); expectSilence(silenceAfter);
    await ffmpeg(['-i', exportFile, '-vf', 'select=eq(n\\,15)', '-frames:v', '1', '-threads', '1', path.join(evidence, 'layered-frame-15.png')]);
    const range = await fetch(f.base + exportDone.url, { headers: { authorization: `Bearer ${token}`, range: 'bytes=0-31' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
    composite = { p, red, video, audio, videos, audioTrack, frozen, preview, exported, exportDone, exportFile };
    return { projectId: p.id, previewId: preview.id, exportId: exported.id, frames: 120, pixels, audio: { silenceBefore, embedded, silenceBetween, audioOnly, silenceAfter }, previewExportDecodedEqual: true, mediaRangeStatus: 206 };
  });

  await check(t, 'single-frame clips, leading black gap and non-whole-second ending retain exactly 71 frames', async () => {
    const p = await f.project('V2 exact single-frame boundaries');
    const red = await f.importFile(p.id, 'red.png', 'image/png'), blue = await f.importFile(p.id, 'blue.png', 'image/png');
    const videos = p.timeline.tracks.filter(track => track.kind === 'video').sort((a, b) => a.orderIndex - b.orderIndex);
    await p.mutate('timeline.clip.add', { trackId: videos[0].id, assetId: red.id, startFrame: 1, durationFrames: 1 });
    await p.mutate('timeline.clip.add', { trackId: videos[1].id, assetId: blue.id, startFrame: 1, durationFrames: 1 });
    await p.mutate('timeline.clip.add', { trackId: videos[0].id, assetId: red.id, startFrame: 65, durationFrames: 6 });
    const job = await f.finish((await p.render()).id), file = await f.download(job, 'single-frame-boundaries.mp4');
    await probeOutput(file, 71); const pixels = [];
    for (const n of [0, 2, 64]) pixels.push({ frame: n, ...expectPixel(await frame(file, n), 360, 640, [0, 0, 0], 'leading/interior gap') });
    pixels.push({ frame: 1, ...expectPixel(await frame(file, 1), 360, 640, [0, 0, 255], 'exactly one blue upper-track frame') });
    for (const n of [65, 70]) pixels.push({ frame: n, ...expectPixel(await frame(file, n), 360, 640, [255, 0, 0], 'last six red frames') });
    const sound = analyzeAudio(await pcm(file), 0.1, 2.2); expectSilence(sound);
    return { exportId: job.id, frames: 71, duration: 71 / 30, pixels, sound };
  });

  await check(t, 'RGBA source alpha preserves lower pixels and audio-only timelines render a real black video stream', async () => {
    const p = await f.project('V2 alpha and audio-only acceptance');
    const blue = await f.importFile(p.id, 'blue.png', 'image/png');
    const alpha = await f.importFile(p.id, 'alpha-red.png', 'image/png');
    const sound = await f.importFile(p.id, 'trim-tone.wav', 'audio/wav');
    const videos = p.timeline.tracks.filter(track => track.kind === 'video').sort((a, b) => a.orderIndex - b.orderIndex);
    const audio = p.timeline.tracks.find(track => track.kind === 'audio');
    await p.mutate('timeline.clip.add', { trackId: videos[0].id, assetId: blue.id, startFrame: 0, durationFrames: 30 });
    await p.mutate('timeline.clip.add', { trackId: videos[1].id, assetId: alpha.id, startFrame: 0, durationFrames: 30, rect: { x: 300, y: 580, width: 120, height: 120 } });
    const alphaFile = await f.download(await f.finish((await p.render()).id), 'alpha-source-composite.mp4');
    await probeOutput(alphaFile, 30);
    const alphaFrame = await frame(alphaFile, 15);
    const blended = expectPixel(alphaFrame, 360, 640, [127, 0, 127], 'half-transparent red source blends over blue');
    const outside = expectPixel(alphaFrame, 80, 80, [0, 0, 255], 'outside image rectangle remains blue');
    for (const clip of [...p.timeline.clips]) await p.mutate('timeline.clip.remove', { clipId: clip.id });
    await p.mutate('timeline.clip.add', { trackId: audio.id, assetId: sound.id, startFrame: 3, durationFrames: 27, sourceInFrame: 30 });
    const audioFile = await f.download(await f.finish((await p.render()).id), 'audio-only-timeline.mp4');
    await probeOutput(audioFile, 30);
    for (const n of [0, 15, 29]) expectPixel(await frame(audioFile, n), 360, 640, [0, 0, 0], 'audio-only timeline stays black');
    const decoded = await pcm(audioFile);
    const leading = analyzeAudio(decoded, 0.01, 0.06), audible = analyzeAudio(decoded, 0.25, 0.75, [440, 880]);
    expectSilence(leading); expectTone(audible, 880, 440);
    return { blended, outside, leading, audible, audioOnlyFrames: 30 };
  });

  await check(t, 'hidden is picture-only; video mute silences embedded sound; audio mute silences audio tracks', async () => {
    const p = await f.project('V2 hidden versus muted');
    const video = await f.importFile(p.id, 'trim-source.mp4', 'video/mp4'), audio = await f.importFile(p.id, 'trim-tone.wav', 'audio/wav');
    const v = p.timeline.tracks.find(track => track.kind === 'video'), a = p.timeline.tracks.find(track => track.kind === 'audio');
    await p.mutate('timeline.clip.add', { trackId: v.id, assetId: video.id, startFrame: 0, durationFrames: 30, sourceInFrame: 30 });
    await p.mutate('timeline.clip.add', { trackId: a.id, assetId: audio.id, startFrame: 0, durationFrames: 30, sourceInFrame: 30 });
    await p.mutate('timeline.track.update', { trackId: v.id, patch: { hidden: true } });
    await p.mutate('timeline.track.update', { trackId: a.id, patch: { muted: true } });
    const hidden = await f.finish((await p.render()).id), hiddenFile = await f.download(hidden, 'hidden-video-audible.mp4'); await probeOutput(hiddenFile, 30);
    expectPixel(await frame(hiddenFile, 15), 360, 640, [0, 0, 0], 'hidden video has no picture');
    const hiddenAudio = analyzeAudio(await pcm(hiddenFile), 0.15, 0.85, [660, 880]); expectTone(hiddenAudio, 660, 880);
    await p.mutate('timeline.track.update', { trackId: v.id, patch: { muted: true } });
    const silent = await f.finish((await p.render()).id), silentFile = await f.download(silent, 'all-muted-silence.mp4'); await probeOutput(silentFile, 30);
    const silentAudio = analyzeAudio(await pcm(silentFile), 0.15, 0.85); expectSilence(silentAudio);
    await p.mutate('timeline.track.update', { trackId: a.id, patch: { muted: false } });
    const audioOnly = await f.finish((await p.render()).id), audioFile = await f.download(audioOnly, 'hidden-video-audio-track.mp4');
    const audioTrack = analyzeAudio(await pcm(audioFile), 0.15, 0.85, [660, 880]); expectTone(audioTrack, 880, 660);
    return { hiddenAudio, silentAudio, audioTrack, hiddenPictureBlack: true };
  });

  await check(t, 'overlapping independent audio and embedded video sound mix without implicit normalization; clip gain applies', async () => {
    const p = await f.project('V2 audio mixing and gain');
    const video = await f.importFile(p.id, 'trim-source.mp4', 'video/mp4'), audio = await f.importFile(p.id, 'trim-tone.wav', 'audio/wav');
    const v = p.timeline.tracks.find(track => track.kind === 'video'), a = p.timeline.tracks.find(track => track.kind === 'audio');
    await p.mutate('timeline.clip.add', { trackId: v.id, assetId: video.id, startFrame: 0, durationFrames: 30, sourceInFrame: 30 });
    await p.mutate('timeline.clip.add', { trackId: a.id, assetId: audio.id, startFrame: 0, durationFrames: 30, sourceInFrame: 30, gain: 0.5 });
    const audioClip = p.timeline.clips.find(clip => clip.trackId === a.id);
    const mixedFile = await f.download(await f.finish((await p.render()).id), 'mixed-gain-half.mp4');
    const mixed = analyzeAudio(await pcm(mixedFile), 0.15, 0.85, [660, 880]); expectTone(mixed, 660); expectTone(mixed, 880);
    await p.mutate('timeline.clip.update', { clipId: audioClip.id, patch: { gain: 1 } });
    const fullFile = await f.download(await f.finish((await p.render()).id), 'mixed-gain-full.mp4');
    const full = analyzeAudio(await pcm(fullFile), 0.15, 0.85, [660, 880]);
    const ratio = full.amplitudes[880] / mixed.amplitudes[880]; assert.ok(ratio > 1.85 && ratio < 2.15, `gain 0.5 -> 1 should double amplitude: ${ratio}`);
    assert.ok(Math.abs(full.amplitudes[660] / mixed.amplitudes[660] - 1) < 0.1, 'changing one clip gain preserves other embedded audio');
    await p.mutate('timeline.clip.update', { clipId: audioClip.id, patch: { gain: 0 } });
    const zeroFile = await f.download(await f.finish((await p.render()).id), 'mixed-gain-zero.mp4');
    const zero = analyzeAudio(await pcm(zeroFile), 0.15, 0.85, [660, 880]); expectTone(zero, 660, 880);
    return { mixed, full, zero, gainAmplitudeRatio: ratio };
  });

  await check(t, 'snapshot, output bytes and original asset references stay frozen after later timeline edits', async () => {
    assert.ok(composite, 'composite render prerequisite succeeded');
    const { p, red, exported, exportDone, exportFile, frozen } = composite;
    const beforeHash = sha(await readFile(exportFile));
    const clip = p.timeline.clips.find(clip => clip.assetId === red.id);
    await p.mutate('timeline.clip.update', { clipId: clip.id, patch: { durationFrames: 15 } });
    const after = await f.rpc('export.get', { exportId: exported.id });
    assert.deepEqual(after.snapshot.timeline, frozen); assert.equal(after.timelineRevision, frozen.revision); assert.equal(after.assetId, exportDone.assetId); assert.equal(after.url, exportDone.url);
    const response = await fetch(f.base + after.url, { headers: { authorization: `Bearer ${token}` } }); assert.equal(sha(Buffer.from(await response.arrayBuffer())), beforeHash);
    const next = await f.finish((await p.render()).id); assert.notEqual(next.id, after.id); assert.notEqual(next.assetId, after.assetId); assert.equal(next.timelineRevision, p.timeline.revision);
    return { originalExportId: after.id, originalRevision: frozen.revision, currentRevision: p.timeline.revision, originalOutputSha256: beforeHash, laterExportId: next.id, frozenReferenceIds: after.snapshot.assets.map(a => a.id) };
  });

  await check(t, 'worker verifies actual source bytes against frozen hashes before rendering', async () => {
    const p = await f.project('V2 source bytes tamper guard'), red = await f.importFile(p.id, 'red.png', 'image/png');
    await p.mutate('timeline.clip.add', { trackId: p.timeline.tracks.find(track => track.kind === 'video').id, assetId: red.id, startFrame: 0, durationFrames: 30 });
    const rawAsset = f.inspect(db => JSON.parse(db.prepare('SELECT data FROM assets WHERE id=?').get(red.id).data));
    await writeFile(path.join(f.root, rawAsset.relativePath), await readFile(path.join(f.root, 'blue.png')));
    const job = await p.render(), failed = await f.exportUntil(job.id, j => ['succeeded', 'failed'].includes(j.status));
    assert.equal(failed.status, 'failed', JSON.stringify(failed)); assert.equal(failed.assetId, null); assert.equal(failed.url, null); assert.match(failed.error.message, /hash|bytes|snapshot|哈希|快照|校验/i);
    assert.equal(failed.snapshot.assets.find(a => a.id === red.id).sha256, red.sha256);
    return { exportId: failed.id, error: failed.error, expectedSha256: red.sha256, tamperedSha256: sha(await readFile(path.join(f.root, rawAsset.relativePath))) };
  });

  await check(t, 'durable running timeline render recovers after actual backend SIGKILL', async () => {
    const p = await f.project('V2 render restart recovery'), red = await f.importFile(p.id, 'red.png', 'image/png');
    await p.mutate('timeline.clip.add', { trackId: p.timeline.tracks.find(track => track.kind === 'video').id, assetId: red.id, startFrame: 0, durationFrames: 300 });
    const queued = await p.render(); const running = await f.exportUntil(queued.id, j => j.status === 'running' || j.status === 'failed' || j.status === 'succeeded');
    assert.equal(running.status, 'running', 'capture a genuine in-progress worker before SIGKILL'); await f.stop('SIGKILL');
    // Let an orphan encoder finish or be reaped before reopening the same output.
    // This still exercises persisted `running` recovery in a fresh backend process.
    await pause(2500); await f.start();
    const recovered = await f.finish(queued.id); assert.equal(recovered.id, queued.id); assert.deepEqual(recovered.snapshot, queued.snapshot);
    const file = await f.download(recovered, 'recovered-running.mp4'); await probeOutput(file, 300);
    const duplicates = f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM exports WHERE id=?').get(queued.id).n); assert.equal(duplicates, 1);
    return { exportId: recovered.id, recoveredFrom: 'running', restart: 'actual SIGKILL and new HTTP backend process', outputFrames: 300 };
  });

  await check(t, 'v1 selected-shot sequence export remains separate and decodable with an empty v2 timeline', async () => {
    const p = await f.project('V1 sequence backward compatibility'), red = await f.importFile(p.id, 'red.png', 'image/png');
    const shot = await f.rpc('shot.create', { projectId: p.id, title: 'Original sequence', prompt: 'Local mock; no paid generation', referenceAssetIds: [red.id], duration: 2 });
    const generation = await f.rpc('generation.submit', { shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'mock' });
    const deadline = Date.now() + 45_000; let done;
    do { done = await f.rpc('job.get', { jobId: generation.id }); if (['succeeded', 'failed'].includes(done.status)) break; await pause(100); } while (Date.now() < deadline);
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    const state = await f.rpc('project.get', { projectId: p.id }); assert.equal(state.timeline.clips.length, 0); assert.equal(state.shots.length, 1);
    const requestId = randomUUID(), job = await f.rpc('export.create', { projectId: p.id, requestId });
    assert.equal((await f.rpc('export.create', { projectId: p.id, requestId })).id, job.id); assert.notEqual(job.mode, 'timeline'); assert.deepEqual(job.orderedVersionIds, [state.shots[0].selectedVersionId]); assert.ok(Array.isArray(job.snapshot));
    const exported = await f.finish(job.id), file = await f.download(exported, 'v1-sequence-export.mp4'); await probeOutput(file, 60, { legacy: true });
    assert.equal((await f.rpc('timeline.get', { projectId: p.id })).clips.length, 0);
    return { exportId: exported.id, selectedVersionId: state.shots[0].selectedVersionId, timelineClipCount: 0, frames: 60, provider: 'local synthetic mock' };
  });
});
