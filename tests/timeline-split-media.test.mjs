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

// Real, local-only acceptance: API split mutations, two independently queued
// exports, FFmpeg decode, every-frame comparison, and audio around new seams.
// H.264 is lossy and the renderer starts new encoding segments at clip edges:
// splitting need not produce byte-identical files or decoded-frame hashes.
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.join(repo, 'evidence/split-clips/media');
const token = 'timeline-split-media-local-token-000000000';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const frames = 91, fps = 30, sampleRate = 48000;
const records = { startedAt: new Date().toISOString(), runtime: process.version, fixturePolicy: 'Synthetic local media only; no live providers', commands: [], http: [], checks: [] };

async function command(file, args, binary = false) {
  try {
    const result = await exec(file, args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    records.commands.push({ file, args, exitCode: 0, stdout: binary ? { bytes: result.stdout.length, sha256: sha(result.stdout) } : result.stdout, stderr: String(result.stderr) });
    return result.stdout;
  } catch (error) {
    records.commands.push({ file, args, exitCode: error.code, stderr: String(error.stderr) });
    throw error;
  }
}
const ffmpeg = args => command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1', ...args]);
async function freePort() {
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-split-media-'));
  await mkdir(evidence, { recursive: true });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.ts'], { cwd: repo, env: { ...process.env, PORT: String(port), MIOON_DATA_DIR: root, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0', RUNWAYML_API_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  records.server = { pid: child.pid, port, stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', bytes => records.server.stdout += bytes);
  child.stderr.setEncoding('utf8').on('data', bytes => records.server.stderr += bytes);
  child.on('close', (exitCode, signal) => Object.assign(records.server, { exitCode, signal }));
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
    records.finishedAt = new Date().toISOString();
    await writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify(records, null, 2));
    await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`Backend exited: ${records.server.stderr}`);
    try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
    await pause(40);
  }
  assert.ok(ready, `Backend startup timed out: ${records.server.stderr}`);
  async function rpc(operation, input = {}) {
    const response = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ operation, input }) });
    const body = await response.json();
    records.http.push({ operation, input: input.dataBase64 ? { ...input, dataBase64: `[${input.dataBase64.length} base64 characters]` } : input, status: response.status, body });
    assert.equal(response.status, 200, `${operation}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true, JSON.stringify(body));
    return body.data;
  }
  async function render(projectId, timeline, name) {
    const requested = await rpc('timeline.render', { projectId, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export' });
    assert.deepEqual(requested.snapshot.timeline, timeline);
    let job = requested;
    const deadline = Date.now() + 180_000;
    while (!['failed', 'succeeded'].includes(job.status) && Date.now() < deadline) { await pause(100); job = await rpc('export.get', { exportId: requested.id }); }
    assert.equal(job.status, 'succeeded', JSON.stringify(job));
    const response = await fetch(base + job.url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const file = path.join(evidence, name), bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(file, bytes);
    return { file, job, sha256: sha(bytes) };
  }
  return { root, rpc, render };
}
async function makeFixtures(root) {
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=green@0.65:size=240x320:rate=30,format=rgba', '-frames:v', '1', '-threads', '1', path.join(root, 'background.png')]);
  // Every source video frame moves; incorrect right-half source trims cannot
  // accidentally pass like a static-color or short looping fixture could.
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4', '-f', 'lavfi', '-i', 'aevalsrc=0.15*sin(2*PI*697*t)*(0.4+0.15*t):s=48000:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', path.join(root, 'motion.mp4')]);
  // Source seconds carry different tones, detecting source reset as well as
  // timing discontinuity; PCM avoids hiding a fixture delay in the assertion.
  await ffmpeg(['-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*(440+440*floor(t))*t):s=48000:d=4', '-c:a', 'pcm_s16le', path.join(root, 'trim-tone.wav')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=2371:sample_rate=48000:duration=4', '-c:a', 'pcm_s16le', path.join(root, 'muted.wav')]);
}
async function probe(file, format) {
  const info = JSON.parse(await command('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]));
  const video = info.streams.find(stream => stream.codec_type === 'video'), audio = info.streams.find(stream => stream.codec_type === 'audio');
  assert.ok(video && audio);
  assert.equal(video.codec_name, 'h264'); assert.equal(video.width, format.width); assert.equal(video.height, format.height);
  assert.equal(video.r_frame_rate, '30/1'); assert.equal(video.avg_frame_rate, '30/1'); assert.equal(Number(video.nb_read_frames), frames);
  assert.equal(audio.codec_name, 'aac'); assert.equal(Number(audio.sample_rate), sampleRate); assert.equal(audio.channels, 2);
  assert.ok(Math.abs(Number(video.duration) - frames / fps) < 0.00001);
  assert.ok(Math.abs(Number(info.format.duration) - frames / fps) < 0.035);
  await command('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  await writeFile(file.replace(/\.mp4$/, '-probe.json'), JSON.stringify(info, null, 2));
  return { frames: Number(video.nb_read_frames), duration: Number(info.format.duration), size: [video.width, video.height], videoCodec: video.codec_name, audioCodec: audio.codec_name };
}
async function decodedVideo(file, filter = 'scale=180:320') {
  return command('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file, '-an', '-vf', `${filter},format=rgb24`, '-fps_mode', 'passthrough', '-threads', '1', '-f', 'rawvideo', '-'], true);
}
async function decodedAudio(file) {
  return command('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], true);
}
function compareFrames(before, after, frameBytes, label) {
  assert.equal(before.length, frames * frameBytes, `${label}: original frame count`);
  assert.equal(after.length, before.length, `${label}: split frame count`);
  const details = [];
  for (let n = 0; n < frames; n++) {
    let absolute = 0, squares = 0;
    for (let i = n * frameBytes; i < (n + 1) * frameBytes; i++) { const difference = before[i] - after[i]; absolute += Math.abs(difference); squares += difference * difference; }
    details.push({ frame: n, mae: absolute / frameBytes, rmse: Math.sqrt(squares / frameBytes) });
  }
  const worst = details.reduce((a, b) => a.mae > b.mae ? a : b);
  const meanAbsoluteError = details.reduce((sum, frame) => sum + frame.mae, 0) / frames;
  // Low single-digit RGB tolerance permits different H.264 GOP boundaries,
  // while testing the moving-video crop separately avoids dilution by blank space.
  assert.ok(worst.mae < 3.0, `${label}: visible frame mismatch ${JSON.stringify(worst)}`);
  assert.ok(meanAbsoluteError < 1.0, `${label}: mean RGB error ${meanAbsoluteError}`);
  return { label, meanAbsoluteError, worst, perFrame: details };
}
function audioStats(bytes, start, end, frequencies = []) {
  const from = Math.round(start * sampleRate), to = Math.min(Math.round(end * sampleRate), bytes.length / 4);
  let energy = 0;
  for (let i = from; i < to; i++) energy += bytes.readFloatLE(i * 4) ** 2;
  const amplitudes = Object.fromEntries(frequencies.map(frequency => {
    let real = 0, imaginary = 0;
    for (let i = from; i < to; i++) { const value = bytes.readFloatLE(i * 4), phase = 2 * Math.PI * frequency * i / sampleRate; real += value * Math.cos(phase); imaginary += value * Math.sin(phase); }
    return [frequency, 2 * Math.hypot(real, imaginary) / (to - from)];
  }));
  return { start, end, rms: Math.sqrt(energy / (to - from)), amplitudes };
}
function compareAudio(before, after, start, end) {
  const from = Math.round(start * sampleRate), to = Math.round(end * sampleRate);
  let squared = 0, peak = 0, baseEnergy = 0;
  for (let i = from; i < to; i++) {
    const a = before.readFloatLE(i * 4), b = after.readFloatLE(i * 4), difference = a - b;
    squared += difference ** 2; baseEnergy += a ** 2; peak = Math.max(peak, Math.abs(difference));
  }
  const rmse = Math.sqrt(squared / (to - from)), relativeRmse = Math.sqrt(squared / (baseEnergy || 1));
  assert.ok(rmse < 0.003, `Audio mismatch near ${start}..${end}s: RMSE ${rmse}, peak ${peak}`);
  return { start, end, rmse, relativeRmse, peakDifference: peak };
}

test('clip split preserves real rendered multitrack composition and exact frame count', { timeout: 600_000 }, async t => {
  const f = await fixture(t);
  try {
    await makeFixtures(f.root);
    const project = await f.rpc('project.create', { name: 'Synthetic split render equivalence' });
    let timeline = await f.rpc('timeline.get', { projectId: project.id });
    async function mutate(operation, input) { timeline = await f.rpc(operation, { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), ...input }); return timeline; }
    async function importFile(name, mimeType) { return f.rpc('asset.import', { projectId: project.id, name, mimeType, dataBase64: (await readFile(path.join(f.root, name))).toString('base64') }); }
    const image = await importFile('background.png', 'image/png'), video = await importFile('motion.mp4', 'video/mp4'), audio = await importFile('trim-tone.wav', 'audio/wav'), muted = await importFile('muted.wav', 'audio/wav');
    const videos = timeline.tracks.filter(track => track.kind === 'video').sort((a, b) => a.orderIndex - b.orderIndex), audioTrack = timeline.tracks.find(track => track.kind === 'audio');
    await mutate('timeline.track.add', { kind: 'audio', name: 'Muted reference' });
    const mutedTrack = timeline.tracks.find(track => track.name === 'Muted reference');
    await mutate('timeline.track.update', { trackId: mutedTrack.id, patch: { muted: true } });
    await mutate('timeline.clip.add', { trackId: videos[0].id, assetId: image.id, startFrame: 0, durationFrames: frames, gain: 0.7 });
    await mutate('timeline.clip.add', { trackId: videos[1].id, assetId: video.id, startFrame: 7, durationFrames: 73, sourceInFrame: 11, gain: 0.6, rect: { x: 96, y: 320, width: 528, height: 396 } });
    await mutate('timeline.clip.add', { trackId: audioTrack.id, assetId: audio.id, startFrame: 3, durationFrames: 80, sourceInFrame: 13, gain: 0.35 });
    await mutate('timeline.clip.add', { trackId: mutedTrack.id, assetId: muted.id, startFrame: 0, durationFrames: frames, sourceInFrame: 8, gain: 2 });
    const original = structuredClone(timeline);
    const before = await f.render(project.id, original, 'before-split.mp4');
    records.checks.push({ name: 'Before split export', result: 'passed', ...await probe(before.file, original) });
    const splitPlan = [[image, 31], [video, 43], [audio, 47], [muted, 59]];
    for (const [asset, atFrame] of splitPlan) {
      const clip = structuredClone(timeline.clips.find(clip => clip.assetId === asset.id));
      const previousIds = new Set(timeline.clips.map(clip => clip.id));
      await mutate('timeline.clip.split', { clipId: clip.id, atFrame });
      const left = timeline.clips.find(item => item.id === clip.id), added = timeline.clips.filter(item => !previousIds.has(item.id));
      assert.equal(added.length, 1);
      const right = added[0], offset = atFrame - clip.startFrame;
      assert.deepEqual(left, { ...clip, durationFrames: offset });
      assert.deepEqual(right, { ...clip, id: right.id, startFrame: atFrame, durationFrames: clip.durationFrames - offset, sourceInFrame: asset.mimeType.startsWith('image/') ? 0 : clip.sourceInFrame + offset });
      assert.equal(timeline.durationFrames, frames);
      assert.deepEqual(timeline.tracks, original.tracks);
      records.checks.push({ name: `Split ${asset.name}`, result: 'passed', atFrame, left, right });
    }
    const after = await f.render(project.id, timeline, 'after-split.mp4');
    records.checks.push({ name: 'After split export', result: 'passed', ...await probe(after.file, original) });
    const full = compareFrames(await decodedVideo(before.file), await decodedVideo(after.file), 180 * 320 * 3, 'full composition');
    const cropFilter = 'crop=528:296:96:370,scale=264:148';
    const moving = compareFrames(await decodedVideo(before.file, cropFilter), await decodedVideo(after.file, cropFilter), 264 * 148 * 3, 'moving source crop');
    records.checks.push({ name: 'All 91 decoded video frames equivalent within lossy encoding tolerance', result: 'passed', full, moving });
    const beforeAudio = await decodedAudio(before.file), afterAudio = await decodedAudio(after.file);
    assert.equal(beforeAudio.length, afterAudio.length, 'Decoded audio sample count stays unchanged');
    assert.ok(beforeAudio.length / 4 >= frames * 1600);
    const soundComparisons = [compareAudio(beforeAudio, afterAudio, 0, frames / fps), ...splitPlan.map(([, frame]) => compareAudio(beforeAudio, afterAudio, frame / fps - 0.04, frame / fps + 0.04))];
    const audioWindows = [];
    for (const [start, end, frequency] of [[0.35, 0.5, 440], [0.85, 1.3, 880], [1.8, 2.3, 1320], [2.7, 2.75, 1760]]) {
      for (const [version, bytes] of [['before', beforeAudio], ['after', afterAudio]]) {
        const stats = audioStats(bytes, start, end, [frequency, 697, 2371]);
        assert.ok(stats.amplitudes[frequency] > 0.025, `${version}: source tone ${frequency} missing ${JSON.stringify(stats)}`);
        assert.ok(stats.amplitudes[2371] < 0.002, `${version}: muted track audible ${JSON.stringify(stats)}`);
        if (end < 2.6) assert.ok(stats.amplitudes[697] > 0.015, `${version}: embedded audio missing ${JSON.stringify(stats)}`);
        audioWindows.push({ version, ...stats });
      }
    }
    for (const bytes of [beforeAudio, afterAudio]) assert.ok(audioStats(bytes, 2.86, 3).rms < 0.002, 'Tail after all audible clips is silent');
    records.checks.push({ name: 'Audio continuity, nonzero source trims, gains, and track mute preserved', result: 'passed', decodedSamples: beforeAudio.length / 4, soundComparisons, audioWindows });
    await ffmpeg(['-i', before.file, '-i', after.file, '-filter_complex', '[0:v]select=eq(n\\,43),scale=360:640[a];[1:v]select=eq(n\\,43),scale=360:640[b];[a][b]hstack=inputs=2[out]', '-map', '[out]', '-frames:v', '1', '-threads', '1', path.join(evidence, 'split-boundary-before-after.png')]);
    records.originalTimeline = original; records.splitTimeline = timeline;
    records.outputs = { before: { exportId: before.job.id, sha256: before.sha256 }, after: { exportId: after.job.id, sha256: after.sha256 } };
    records.result = 'passed';
    await writeFile(path.join(evidence, 'summary.json'), JSON.stringify({ result: 'passed', frames, duration: frames / fps, splitFrames: splitPlan.map(([, frame]) => frame), visual: { full: { meanAbsoluteError: full.meanAbsoluteError, worst: full.worst }, moving: { meanAbsoluteError: moving.meanAbsoluteError, worst: moving.worst } }, soundComparisons, audioWindows, outputs: records.outputs }, null, 2));
  } catch (error) {
    records.result = 'failed'; records.error = { message: error.message, stack: error.stack };
    throw error;
  }
});
