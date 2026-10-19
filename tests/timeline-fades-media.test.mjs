import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {timelineAudioFadeFilters} from '../packages/business/src/timeline-audio.ts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {startServer} from '../apps/server/src/index.ts';

// Local synthetic acceptance: exact float PCM first, then the shared production
// renderer, a real HTTP queue/worker, and decoded lossy AAC. No provider calls.
const exec = promisify(execFile), sampleRate = 48000, samplesPerFrame = 1600;
const repo = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.join(repo, 'evidence/audio-fades/media');
const token = 'timeline-fades-synthetic-http-token';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const records = {startedAt: new Date().toISOString(), fixturePolicy: 'Generated PCM/lavfi only; local HTTP only; no model or provider operations', commands: [], checks: [], http: []};

async function command(file, args, binary = false) {
  const result = await exec(file, args, {encoding: binary ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000});
  records.commands.push({file, args, exitCode: 0, stdout: binary ? {bytes: result.stdout.length, sha256: hash(result.stdout)} : result.stdout});
  return result.stdout;
}
const ffmpeg = args => command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1', ...args]);
const decode = file => command('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], true);
const sample = (bytes, frame, channel = 0) => bytes.readFloatLE((frame * 2 + channel) * 4);
function envelope(frame, clip) {
  const fadeIn = (clip.fadeInFrames ?? 0) * samplesPerFrame;
  const fadeOut = (clip.fadeOutFrames ?? 0) * samplesPerFrame;
  const end = clip.durationFrames * samplesPerFrame;
  return (fadeIn && frame < fadeIn ? frame / fadeIn : 1) *
    (fadeOut && frame > end - fadeOut ? (end - frame) / fadeOut : 1);
}
function stats(bytes, start, end, frequencies = [], channel = 0) {
  const from = Math.round(start * sampleRate), to = Math.min(Math.round(end * sampleRate), bytes.length / 8);
  assert.ok(to > from);
  let energy = 0;
  for (let n = from; n < to; n++) energy += sample(bytes, n, channel) ** 2;
  const amplitudes = Object.fromEntries(frequencies.map(frequency => {
    let real = 0, imaginary = 0;
    for (let n = from; n < to; n++) {
      const value = sample(bytes, n, channel), phase = 2 * Math.PI * frequency * n / sampleRate;
      real += value * Math.cos(phase); imaginary += value * Math.sin(phase);
    }
    return [frequency, 2 * Math.hypot(real, imaginary) / (to - from)];
  }));
  return {start, end, channel, rms: Math.sqrt(energy / (to - from)), amplitudes};
}
function comparePcm(a, b, start, end, limit, label) {
  const from = Math.round(start * sampleRate), to = Math.round(end * sampleRate);
  let square = 0, max = 0;
  for (let n = from; n < to; n++) for (let c = 0; c < 2; c++) {
    const delta = sample(a, n, c) - sample(b, n, c);
    square += delta ** 2; max = Math.max(max, Math.abs(delta));
  }
  const rmse = Math.sqrt(square / ((to - from) * 2));
  assert.ok(rmse < limit, `${label}: PCM RMSE ${rmse}, peak ${max}`);
  return {start, end, rmse, peakDifference: max};
}
function wave(rate, frequencies, seconds = 5) {
  const channels = frequencies.length, frames = Math.round(rate * seconds), bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let n = 0; n < frames; n++) for (let c = 0; c < channels; c++) {
    // A different first half-second detects sourceInFrame being reset or ignored.
    const frequency = n < rate / 2 ? 1700 + c * 100 : frequencies[c];
    bytes.writeInt16LE(Math.round(0.2 * Math.sin(2 * Math.PI * frequency * n / rate) * 32767), 44 + (n * channels + c) * 2);
  }
  return bytes;
}

async function exactPcm(root, {name, rate, channels, fadeInFrames, fadeOutFrames}) {
  const clip = {startFrame: 21, durationFrames: 120, fadeInFrames, fadeOutFrames};
  const edges = [0, 15, 105, 120]; // Other clips force edges inside both long fades.
  const filters = ['[0:a]asplit=4[s0][s1][s2][dry]'];
  const common = 'asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.5,apad';
  const inputTrim = (begin, end) => `atrim=start_sample=${Math.round((0.5 + begin / 30) * rate)}:end_sample=${Math.round((0.5 + end / 30) * rate)}`;
  for (let n = 0; n < edges.length - 1; n++) {
    const begin = edges[n], end = edges[n + 1];
    filters.push(`[s${n}]${inputTrim(begin, end)},${common},atrim=end_sample=${(end - begin) * samplesPerFrame},${timelineAudioFadeFilters(clip, clip.startFrame + begin)}asetpts=N/SR/TB[a${n}]`);
  }
  filters.push('[a0][a1][a2]concat=n=3:v=0:a=1[out]');
  filters.push(`[dry]${inputTrim(0, 120)},${common},atrim=end_sample=192000,asetpts=N/SR/TB[baseline]`);
  const fadedPath = path.join(root, `${name}.f32`), dryPath = path.join(root, `${name}-dry.f32`);
  await ffmpeg(['-f', 'lavfi', '-i', `aevalsrc=${channels === 1 ? '0.25' : '0.25|0.125'}:s=${rate}:d=5`, '-filter_complex', filters.join(';'),
    '-map', '[out]', '-c:a', 'pcm_f32le', '-f', 'f32le', fadedPath,
    '-map', '[baseline]', '-c:a', 'pcm_f32le', '-f', 'f32le', dryPath]);
  const faded = await readFile(fadedPath), dry = await readFile(dryPath);
  assert.equal(faded.length, 192000 * 8); assert.equal(dry.length, faded.length);
  let worstError = 0;
  for (let n = 0; n < 192000; n++) for (let c = 0; c < 2; c++) {
    worstError = Math.max(worstError, Math.abs(sample(faded, n, c) - sample(dry, n, c) * envelope(n, clip)));
  }
  assert.ok(worstError < 2e-7, `${name}: fade must be sample-exact, including other-clip segment boundaries; error ${worstError}`);
  // Check the immediately adjacent PCM samples, not only windows that could hide a reset.
  const seams = edges.slice(1, -1).map(frame => {
    const n = frame * samplesPerFrame, delta = sample(faded, n) - sample(faded, n - 1);
    const expected = sample(dry, n) * envelope(n, clip) - sample(dry, n - 1) * envelope(n - 1, clip);
    assert.ok(Math.abs(delta - expected) < 2e-7, `${name}: discontinuity at frame ${frame}`);
    return {frame, delta, expected};
  });
  const windows = [0.1, 0.45, 0.55, 1.9, 2.05, 3.45, 3.55, 3.85].map(start => {
    const result = stats(faded, start, start + 0.05), baseline = stats(dry, start, start + 0.05);
    let square = 0;
    for (let n = Math.round(start * sampleRate); n < Math.round((start + 0.05) * sampleRate); n++) square += envelope(n, clip) ** 2;
    const expectedRatio = Math.sqrt(square / Math.round(0.05 * sampleRate));
    assert.ok(Math.abs(result.rms / baseline.rms - expectedRatio) < 2e-6);
    return {...result, expectedRatio, actualRatio: result.rms / baseline.rms};
  });
  records.checks.push({name: `Exact PCM: ${name}`, rate, channels, fadeInFrames, fadeOutFrames, samples: 192000, worstError, seams, windows});
}

async function httpFixture(root) {
  const server = await startServer({dataDir: path.join(root, 'server'), port: 0, token,
    chatGateway: async function* () { throw Error('Audio fade acceptance must never call a model'); }});
  async function request(operation, input = {}, expectFailure = false) {
    const response = await fetch(server.url + '/api/rpc', {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify({operation, input})});
    const body = await response.json();
    records.http.push({operation, input: input.dataBase64 ? {...input, dataBase64: `[${input.dataBase64.length} characters]`} : input, status: response.status, ...(body.ok ? {} : {error: body.error})});
    if (expectFailure) { assert.equal(body.ok, false); return body.error; }
    assert.equal(response.status, 200, `${operation}: ${JSON.stringify(body)}`); assert.equal(body.ok, true);
    return body.data;
  }
  async function finish(id, name) {
    const deadline = Date.now() + 90_000;
    let job;
    do { job = await request('export.get', {exportId: id}); if (['failed', 'succeeded'].includes(job.status)) break; await pause(80); } while (Date.now() < deadline);
    assert.equal(job.status, 'succeeded', JSON.stringify(job));
    const response = await fetch(server.url + job.url, {headers: {authorization: `Bearer ${token}`}});
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()), file = path.join(evidence, name);
    await writeFile(file, bytes);
    return {job, file, sha256: hash(bytes)};
  }
  return {server, request, finish};
}

async function probeOutput(file) {
  const info = JSON.parse(await command('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]));
  const v = info.streams.find(stream => stream.codec_type === 'video'), a = info.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(v.codec_name, 'h264'); assert.equal(v.width, 720); assert.equal(v.height, 1280);
  assert.equal(v.r_frame_rate, '30/1'); assert.equal(Number(v.nb_read_frames), 120);
  assert.equal(a.codec_name, 'aac'); assert.equal(Number(a.sample_rate), 48000); assert.equal(a.channels, 2);
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.035);
  return {frames: Number(v.nb_read_frames), seconds: Number(info.format.duration), video: v.codec_name, audio: a.codec_name, samplesPerSecond: Number(a.sample_rate), channels: a.channels};
}

async function queuedAcceptance(root) {
  await writeFile(path.join(root, 'stereo.wav'), wave(48000, [440, 880]));
  await writeFile(path.join(root, 'mono.wav'), wave(44100, [660]));
  await writeFile(path.join(root, 'embedded.wav'), wave(48000, [990]));
  await writeFile(path.join(root, 'muted.wav'), wave(48000, [2370]));
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=30:d=5', '-i', path.join(root, 'embedded.wav'), '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', '5', path.join(root, 'embedded.mp4')]);
  const f = await httpFixture(root);
  try {
    const project = await f.request('project.create', {name: 'Synthetic audio fade acceptance'});
 // This pixel/audio fixture explicitly preserves its historical 720 canvas.
 await f.request('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'portrait_720'});

    let timeline = await f.request('timeline.get', {projectId: project.id});
    const mutate = async (operation, fields) => timeline = await f.request(operation, {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields});
    const assets = new Map();
    for (const [name, mimeType] of [['stereo.wav', 'audio/wav'], ['mono.wav', 'audio/wav'], ['embedded.mp4', 'video/mp4'], ['muted.wav', 'audio/wav']]) {
      const asset = await f.request('asset.import', {projectId: project.id, name, mimeType, dataBase64: (await readFile(path.join(root, name))).toString('base64')});
      assets.set(name, {...asset, path: path.join(root, name)});
    }
    const videoTrack = timeline.tracks.find(track => track.kind === 'video');
    const stereoTrack = timeline.tracks.find(track => track.kind === 'audio');
    await mutate('timeline.track.update', {trackId: videoTrack.id, patch: {hidden: true}});
    for (const name of ['Mono 44.1 kHz', 'Muted boundary', 'Zero gain']) await mutate('timeline.track.add', {kind: 'audio', name});
    const track = name => timeline.tracks.find(item => item.name === name);
    await mutate('timeline.track.update', {trackId: track('Muted boundary').id, patch: {muted: true}});
    const plan = [
      {name: 'Stereo', trackId: stereoTrack.id, asset: 'stereo.wav', gain: 0.5, fadeInFrames: 30, fadeOutFrames: 30},
      {name: 'Mono', trackId: track('Mono 44.1 kHz').id, asset: 'mono.wav', gain: 0.75, fadeInFrames: 60, fadeOutFrames: 60},
      {name: 'Hidden video', trackId: videoTrack.id, asset: 'embedded.mp4', gain: 0.6, fadeInFrames: 60, fadeOutFrames: 30},
    ];
    for (const item of plan) {
      await mutate('timeline.clip.add', {trackId: item.trackId, assetId: assets.get(item.asset).id, name: item.name, startFrame: 0, durationFrames: 120, sourceInFrame: 15, gain: item.gain});
      item.clipId = timeline.clips.find(clip => clip.name === item.name).id;
    }
    // These unrelated clip edges are inside both fade regions of every audible
    // clip; a segment-local fade implementation audibly restarts at 0.5/3.5 s.
    await mutate('timeline.clip.add', {trackId: track('Muted boundary').id, assetId: assets.get('muted.wav').id, startFrame: 15, durationFrames: 90, sourceInFrame: 15, gain: 2, fadeInFrames: 30, fadeOutFrames: 30});
    await mutate('timeline.clip.add', {trackId: track('Zero gain').id, assetId: assets.get('muted.wav').id, startFrame: 0, durationFrames: 120, sourceInFrame: 15, gain: 0, fadeInFrames: 30, fadeOutFrames: 30});
    const dryTimeline = structuredClone(timeline);
    const dryInput = {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export'};
    const dryRequested = await f.request('timeline.render', dryInput);
    assert.deepEqual(dryRequested.snapshot.timeline, dryTimeline);
    const editInputs = [];
    for (const item of plan) {
      const input = {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), clipId: item.clipId, patch: {fadeInFrames: item.fadeInFrames, fadeOutFrames: item.fadeOutFrames}};
      timeline = await f.request('timeline.clip.update', input); editInputs.push({input, response: structuredClone(timeline)});
    }
    // The already queued dry export must continue using its immutable old fields.
    const fadedTimeline = structuredClone(timeline);
    const fadedRequested = await f.request('timeline.render', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'preview'});
    assert.deepEqual(fadedRequested.snapshot.timeline, fadedTimeline);
    const dry = await f.finish(dryRequested.id, 'queued-before-fades.mp4');
    const faded = await f.finish(fadedRequested.id, 'queued-with-fades.mp4');
    const dryPcm = await decode(dry.file), fadedPcm = await decode(faded.file);
    assert.equal(dryPcm.length, fadedPcm.length); assert.ok(fadedPcm.length >= 192000 * 8);
    const probes = [await probeOutput(dry.file), await probeOutput(faded.file)];
    const windows = [];
    for (const start of [0.1, 0.45, 0.55, 1.25, 1.9, 2.05, 2.75, 3.45, 3.55, 3.85]) {
      const end = start + 0.05;
      for (const [name, frequency, channel] of [['Stereo', 440, 0], ['Stereo', 880, 1], ['Mono', 660, 0], ['Hidden video', 990, 0]]) {
        const item = plan.find(row => row.name === name), clip = fadedTimeline.clips.find(row => row.id === item.clipId);
        const before = stats(dryPcm, start, end, [frequency, 2370, 1700, 1800], channel);
        const after = stats(fadedPcm, start, end, [frequency, 2370, 1700, 1800], channel);
        const expectedRatio = envelope(Math.round((start + end) / 2 * sampleRate), clip);
        const ratio = after.amplitudes[frequency] / before.amplitudes[frequency];
        assert.ok(before.amplitudes[frequency] > 0.025, `${name}: dry source tone/gain missing`);
        assert.ok(Math.abs(ratio - expectedRatio) < 0.045, `${name} ${start}..${end}: AAC envelope ${ratio}, expected ${expectedRatio}`);
        assert.ok(before.amplitudes[2370] < 0.003 && after.amplitudes[2370] < 0.003, 'Track mute and zero gain must suppress faded sources');
        assert.ok(before.amplitudes[1700] < 0.003 && before.amplitudes[1800] < 0.003, 'Nonzero sourceInFrame must omit the first source half-second');
        windows.push({name, frequency, channel, start, end, expectedRatio, ratio});
      }
    }
    // Longer windows independently check the specified gain and stereo layout.
    const steadyLeft = stats(dryPcm, 1, 3, [440, 880, 660, 990]);
    const steadyRight = stats(dryPcm, 1, 3, [440, 880, 660, 990], 1);
    for (const [actual, expected, label] of [
      [steadyLeft.amplitudes[440], 0.1, 'stereo gain left'], [steadyRight.amplitudes[880], 0.1, 'stereo gain right'],
      [steadyLeft.amplitudes[660], 0.2 * 0.75 / Math.sqrt(2), 'mono gain/upmix'],
      [steadyLeft.amplitudes[990], 0.2 * 0.6 / Math.sqrt(2), 'hidden embedded gain/upmix'],
    ]) assert.ok(Math.abs(actual - expected) < 0.012, `${label}: ${actual}, expected ${expected}`);
    assert.ok(steadyLeft.amplitudes[880] < 0.002 && steadyRight.amplitudes[440] < 0.002, 'Stereo channels must not collapse to mono');
    const pixel = await command('ffmpeg', ['-v', 'error', '-i', faded.file, '-vf', 'select=eq(n\\,60),scale=1:1,format=rgb24', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-'], true);
    assert.equal(pixel.length, 3); assert.ok([...pixel].every(value => value < 4), 'Hidden red video must remain visually black while embedded audio fades');
    records.checks.push({name: 'Queued export/preview AAC envelope, source trim, gain, mute, hidden video and stereo semantics', probes, windows, steadyLeft, steadyRight});

    // Splitting inside either fade is rejected atomically; meeting/plateau
    // boundaries remain valid and preserve the original full-clip envelope.
    const mono = plan.find(item => item.name === 'Mono');
    for (const atFrame of [30, 90]) {
      const error = await f.request('timeline.clip.split', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), clipId: mono.clipId, atFrame}, true);
      assert.equal(error.code, 'SPLIT_FADE_BOUNDS');
      assert.deepEqual(await f.request('timeline.get', {projectId: project.id}), timeline);
    }
    for (const item of plan) await mutate('timeline.clip.split', {clipId: item.clipId, atFrame: 60});
    const splitFile = path.join(evidence, 'shared-renderer-after-splits.mp4');
    await rm(splitFile, {force: true});
    await renderTimeline({timeline}, new Map([...assets.values()].map(asset => [asset.id, asset])), splitFile);
    const splitPcm = await decode(splitFile);
    assert.equal(splitPcm.length, fadedPcm.length);
    const comparisons = [comparePcm(fadedPcm, splitPcm, 0, 4, 0.003, 'whole split fade envelope'),
      ...[0.5, 2, 3.5].map(seam => comparePcm(fadedPcm, splitPcm, seam - 0.025, seam + 0.025, 0.003, `split/other-clip seam ${seam}`))];
    records.checks.push({name: 'Production shared renderer preserves meeting and plateau fades after allowed splits', probe: await probeOutput(splitFile), comparisons, timeline});

    for (const {input, response} of editInputs) assert.deepEqual(await f.request('timeline.clip.update', input), response, 'Fade mutation replay retains its historical response');
    assert.deepEqual(await f.request('timeline.render', dryInput), dryRequested, 'Original queued request replays exactly after fade edits and splits');
    const originalAgain = await f.finish(dryRequested.id, 'queued-before-fades.mp4');
    assert.equal(originalAgain.sha256, dry.sha256);
    assert.deepEqual(originalAgain.job.snapshot, dryRequested.snapshot);
    assert.deepEqual(await f.request('timeline.get', {projectId: project.id}), timeline, 'Historical replays must not change the current timeline');
    for (const item of plan) assert.equal(Object.hasOwn(dryRequested.snapshot.timeline.clips.find(clip => clip.id === item.clipId), 'fadeInFrames'), false);
    records.checks.push({name: 'Historical dry snapshot and output hash immutable after fade edits, splits and replay', dryExportId: dry.job.id, fadedExportId: faded.job.id, drySha256: dry.sha256, fadedSha256: faded.sha256, oldRevision: dryTimeline.revision, currentRevision: timeline.revision});
  } finally { await f.server.close(); }
}

test('audio fades preserve exact segment PCM and real queued render envelopes', {timeout: 180_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-audio-fades-'));
  await mkdir(evidence, {recursive: true});
  const checked = async (name, body) => {
    let failure;
    await t.test(name, async () => { try { await body(); } catch (error) { failure = error; throw error; } });
    if (failure) throw failure;
  };
  try {
    assert.equal(timelineAudioFadeFilters({startFrame: 0, durationFrames: 120}, 30), '');
    assert.equal(timelineAudioFadeFilters({startFrame: 0, durationFrames: 120, fadeInFrames: 0, fadeOutFrames: 0}, 30), '', 'Explicit zero must leave the old filter chain unchanged');
    for (const item of [
      {name: 'stereo-separated', rate: 48000, channels: 2, fadeInFrames: 30, fadeOutFrames: 30},
      {name: 'mono-resampled-meeting', rate: 44100, channels: 1, fadeInFrames: 60, fadeOutFrames: 60},
      {name: 'full-duration-fade-in', rate: 48000, channels: 2, fadeInFrames: 120, fadeOutFrames: 0},
      {name: 'full-duration-fade-out', rate: 48000, channels: 2, fadeInFrames: 0, fadeOutFrames: 120},
      {name: 'one-frame-ends', rate: 48000, channels: 1, fadeInFrames: 1, fadeOutFrames: 1},
    ]) await checked(item.name, () => exactPcm(root, item));
    await checked('HTTP snapshots and production MP4 audio', () => queuedAcceptance(root));
    records.result = 'passed';
  } catch (error) { records.result = 'failed'; records.error = {message: error.message, stack: error.stack}; throw error; }
  finally {
    records.finishedAt = new Date().toISOString();
    await writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify(records, null, 2));
    await rm(root, {recursive: true, force: true});
  }
});
