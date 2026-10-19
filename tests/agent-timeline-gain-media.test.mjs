import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {run} from '../packages/business/src/media-runtime.ts';
import {canonical} from '../packages/business/src/services.ts';
import {database, savedProposal, tableSnapshot, REPO, EDIT_WIRE_TOKEN} from './helpers/agent-edit-wire-fixture.mjs';
import {savedTimeline, timelineRows} from './helpers/agent-timeline-wire-fixture.mjs';
import {gainWireFixture, clipBytesExceptGain, GAIN_FUNCTION} from './helpers/agent-timeline-gain-wire-fixture.mjs';

// A bounded real-media acceptance, complementary to the protocol/crash matrix.
// Every gain is proposed by the existing owned loopback SSE fixture, explicitly
// reviewed over HTTP, journaled by production services, and exported by the real
// queue/worker/shared renderer. No external model/provider or user media is used.
const RATE = 48000, FRAMES = 90, SECONDS = FRAMES / 30;
const evidence = path.join(REPO, 'evidence/agent-gain/media');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const records = {startedAt: new Date().toISOString(), runtime: process.version,
  fixtureScope: {
    sources: ['48 kHz stereo PCM WAV', '44.1 kHz mono PCM WAV', '48 kHz mono AAC embedded in synthetic red H264 MP4'],
    protocol: 'chat_completions, owned loopback fragmented SSE fixture only',
    path: 'HTTP asset import → reviewed gain proposal/approval → timeline journal → HTTP export queue → production worker/renderer → decoded AAC',
    durationSeconds: SECONDS, output: '720×1280, 30 fps H264 + 48 kHz stereo AAC',
    gainCases: 'Each source: 1 → 0.4 → undo to 1; stereo additionally reviewed 0 and 1.5',
    limits: 'Synthetic Linux acceptance only. Does not claim real-provider, Mac/Windows, arbitrary media, loudness normalization, limiting, or clipping prevention. The >1 case has deliberately low-level input; gains above 1 can clip other material.',
  }, commands: [], checks: []};

// Reuse the production bounded, shell-free, timeout/reap-aware media runner.
// Binary decoded PCM is written to a bounded three-second file, not collected
// with a new child-process UTF-8 or binary stream implementation.
async function command(file, args) {
  try {
    const stdout = await run(file, args, {timeout: 120000});
    records.commands.push({file, args, exitCode: 0, stdout});
    return stdout;
  } catch (error) {
    records.commands.push({file, args, error: {code: error.code, message: error.message}});
    throw error;
  }
}
const ffmpeg = args => command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1', ...args]);

function wave(rate, frequencies, seconds = 4) {
  const channels = frequencies.length, frames = Math.round(rate * seconds), bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    // A source trim regression introduces these otherwise absent marker tones.
    const frequency = frame < rate / 2 ? 1700 + channel * 100 : frequencies[channel];
    bytes.writeInt16LE(Math.round(0.18 * Math.sin(2 * Math.PI * frequency * frame / rate) * 32767), 44 + (frame * channels + channel) * 2);
  }
  return bytes;
}
function stats(bytes, start, end, channel = 0, frequencies = []) {
  const from = Math.round(start * RATE), to = Math.round(end * RATE);
  assert.ok(to * 8 <= bytes.length && to > from);
  let energy = 0, peak = 0;
  const sums = frequencies.map(frequency => ({frequency, real: 0, imaginary: 0}));
  for (let frame = from; frame < to; frame++) {
    const value = bytes.readFloatLE((frame * 2 + channel) * 4);
    assert.ok(Number.isFinite(value)); energy += value * value; peak = Math.max(peak, Math.abs(value));
    for (const sum of sums) {
      const phase = 2 * Math.PI * sum.frequency * frame / RATE;
      sum.real += value * Math.cos(phase); sum.imaginary += value * Math.sin(phase);
    }
  }
  return {start, end, channel, rms: Math.sqrt(energy / (to - from)), peak,
    amplitudes: Object.fromEntries(sums.map(sum => [sum.frequency, 2 * Math.hypot(sum.real, sum.imaginary) / (to - from)]))};
}
function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual}, expected ${expected} ± ${tolerance}`);
}
function sameContent(actual, expected, label) {
  assert.deepEqual({...actual, revision: expected.revision, updatedAt: expected.updatedAt}, expected, label);
}
const history = (f, projectId) => f.rpc('timeline.history.get', {projectId});
const timelineTables = ['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests'];

async function exportMedia(f, projectId, timeline, name) {
  const requested = await f.rpc('timeline.render', {projectId, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export'});
  assert.deepEqual(requested.snapshot.timeline, timeline, 'worker receives the exact reviewed saved snapshot');
  const deadline = Date.now() + 90000;
  let job;
  do {
    job = await f.rpc('export.get', {exportId: requested.id});
    if (['failed', 'succeeded'].includes(job.status)) break;
    await delay(80);
  } while (Date.now() < deadline);
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  assert.deepEqual(job.snapshot, requested.snapshot, 'queued snapshot is immutable');
  const response = await fetch(f.process.url + job.url, {headers: {authorization: `Bearer ${EDIT_WIRE_TOKEN}`}, signal: AbortSignal.timeout(12000)});
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()), file = path.join(evidence, `${name}.mp4`);
  assert.ok(bytes.length < 8 * 1024 * 1024, 'synthetic three-second export remains bounded');
  await writeFile(file, bytes);
  const info = JSON.parse(await command('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]));
  const video = info.streams.find(stream => stream.codec_type === 'video'), audio = info.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(info.streams.length, 2); assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 720); assert.equal(video.height, 1280); assert.equal(video.r_frame_rate, '30/1');
  assert.equal(Number(video.nb_read_frames), FRAMES); assert.equal(Number(video.nb_frames), FRAMES);
  assert.equal(audio.codec_name, 'aac'); assert.equal(Number(audio.sample_rate), RATE); assert.equal(audio.channels, 2);
  assert.ok(Number(audio.nb_read_frames) > 0); near(Number(info.format.duration), SECONDS, 0.035, 'container duration');
  near(Number(video.duration), SECONDS, 0.00001, 'video duration'); near(Number(audio.duration), SECONDS, 0.025, 'audio duration');
  const pcmPath = path.join(f.root, `${name}.f32`);
  await ffmpeg(['-threads', '1', '-i', file, '-vn', '-ac', '2', '-ar', String(RATE), '-t', String(SECONDS), '-c:a', 'pcm_f32le', '-f', 'f32le', pcmPath]);
  const pcm = await readFile(pcmPath); assert.equal(pcm.length, SECONDS * RATE * 8);
  const frameMd5 = await command('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file, '-map', '0:v:0', '-an', '-threads', '1', '-f', 'framemd5', '-']);
  const frameHashes = frameMd5.split('\n').filter(line => line && !line.startsWith('#'));
  assert.equal(frameHashes.length, FRAMES, 'decode every real output video frame');
  const report = {name, exportId: job.id, timelineRevision: timeline.revision, sha256: sha(bytes), decodedPcmSha256: sha(pcm),
    decodedVideoSha256: sha(frameHashes.join('\n')), decodedSamplesPerChannel: pcm.length / 8,
    probe: {frames: Number(video.nb_read_frames), duration: Number(info.format.duration), audioFrames: Number(audio.nb_read_frames), video: video.codec_name, audio: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels}};
  records.checks.push({name: `${name}: real queued export and decode`, ...report});
  return {pcm, frameHashes, report};
}

async function reviewedGain(f, selection, gain) {
  const {project, clipId} = selection, before = structuredClone(selection.timeline);
  const histBefore = await history(f, project.id), receiptsBefore = timelineRows(f.root).length;
  const modelCalls = f.model.captures.length, acquisitionsBefore = (await f.process.observe()).acquisitions;
  f.model.plan({name: GAIN_FUNCTION, arguments: {gain}});
  const input = await f.input(project.id, selection, {message: `Set the selected saved clip linear gain to ${gain} 🎚️ 片段`});
  const sent = await f.send(project.id, input), done = await f.terminal(project.id, input.requestId);
  const proposal = (await f.proposals(project.id, '?view=all')).proposals.find(item => item.runId === sent.run.id);
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error)); assert.equal(proposal.status, 'pending');
  assert.deepEqual(proposal.patch, {gain}); assert.deepEqual(savedTimeline(f.root, project.id), before, 'proposal alone does not mutate media or timeline');
  const row = savedProposal(f.root, proposal.id), definition = JSON.parse(row.definition);
  assert.deepEqual(definition.input.patch, {gain}); assert.equal(definition.operation, 'timeline.clip.update');
  const approved = (await f.action(project.id, proposal, 'approve')).proposal;
  assert.equal(approved.status, 'applied');
  const adjusted = savedTimeline(f.root, project.id);
  assert.equal(adjusted.revision, before.revision + 1);
  const clipBefore = before.clips.find(clip => clip.id === clipId), clipAfter = adjusted.clips.find(clip => clip.id === clipId);
  assert.equal(clipAfter.gain, gain); assert.equal(clipBytesExceptGain(clipAfter), clipBytesExceptGain(clipBefore));
  sameContent(adjusted, {...before, clips: before.clips.map(clip => clip.id === clipId ? {...clip, gain} : clip)},
    'only selected gain changes; exact source, trim, timing, rect, fades, tracks and other clips survive');
  const histAfter = await history(f, project.id);
  assert.equal(histAfter.cursor, histBefore.cursor + 1); assert.equal(histAfter.length, histBefore.cursor + 1);
  assert.equal(histAfter.undoEntry.operation, 'timeline.clip.update');
  assert.equal(timelineRows(f.root).length, receiptsBefore + 1);
  const receipt = timelineRows(f.root).find(item => item.requestId === definition.input.requestId);
  assert.deepEqual(JSON.parse(receipt.response), adjusted);
  assert.equal(receipt.requestHash, sha(canonical({operation: definition.operation, input: definition.input})));
  const after = tableSnapshot(f.root, timelineTables), durable = savedProposal(f.root, proposal.id);
  for (const action of ['approve', 'recover', 'approve']) assert.deepEqual((await f.action(project.id, proposal, action)).proposal, approved);
  assert.deepEqual(await f.rpc('timeline.clip.update', definition.input), adjusted, 'exact shared timeline receipt replay');
  assert.deepEqual(tableSnapshot(f.root, timelineTables), after, 'applied replay adds no history, revision or request');
  assert.deepEqual(savedProposal(f.root, proposal.id), durable); assert.equal(f.model.captures.length, modelCalls + 2);
  assert.deepEqual(f.model.errors, []); assert.equal((await f.process.observe()).acquisitions, acquisitionsBefore + 1, 'one empty local credential acquisition per run; approval/replay acquire none');
  for (const capture of f.model.captures.slice(modelCalls)) assert.equal(capture.headers.authorization, undefined);
  records.checks.push({name: `${selection.name}: reviewed gain ${gain} and exact applied replay`, proposalId: proposal.id,
    requestId: definition.input.requestId, beforeRevision: before.revision, afterRevision: adjusted.revision,
    historyBefore: histBefore.cursor, historyAfter: histAfter.cursor, gainBefore: clipBefore.gain, gainAfter: gain});
  selection.timeline = adjusted;
  return {proposal, approved, definition, receipt};
}

async function fixtureSources(f) {
  const result = [];
  for (const [name, rate, tones] of [['stereo', 48000, [440, 880]], ['mono', 44100, [660]], ['embedded', 48000, [990]],
    ['other', 48000, [1930]], ['zero', 48000, [2370]], ['muted', 48000, [2570]]]) {
    const file = path.join(f.root, `${name}.wav`); await writeFile(file, wave(rate, tones));
    result.push({name, rate, tones, file, mimeType: 'audio/wav'});
  }
  const embedded = result.find(item => item.name === 'embedded'), output = path.join(f.root, 'embedded.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=30:d=4', '-i', embedded.file,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', '4', output]);
  embedded.file = output; embedded.mimeType = 'video/mp4';
  return result;
}
async function setup(f, fixture, allSources) {
  const project = await f.rpc('project.create', {name: `Synthetic reviewed ${fixture.name} gain`});
 // This pixel/audio fixture explicitly preserves its historical 720 canvas.
 await f.rpc('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'portrait_720'});

  let timeline = await f.rpc('timeline.get', {projectId: project.id});
  const sources = [];
  for (const source of [fixture, ...allSources.filter(item => ['other', 'zero', 'muted'].includes(item.name))]) {
    const bytes = await readFile(source.file);
    const asset = await f.rpc('asset.import', {projectId: project.id, name: path.basename(source.file), mimeType: source.mimeType, dataBase64: bytes.toString('base64')});
    assert.equal(asset.sha256, sha(bytes)); assert.equal(asset.hasAudio, true);
    sources.push({...asset, fixtureName: source.name});
  }
  const mutate = async (operation, fields) => timeline = await f.rpc(operation, {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields});
  const source = name => sources.find(item => item.fixtureName === name);
  const selectedTrack = timeline.tracks.find(track => track.kind === (fixture.mimeType.startsWith('video/') ? 'video' : 'audio'));
  for (const name of ['Unrelated audio', 'Zero source', 'Muted source']) await mutate('timeline.track.add', {kind: 'audio', name});
  const track = name => timeline.tracks.find(item => item.name === name);
  await mutate('timeline.track.update', {trackId: track('Muted source').id, patch: {muted: true}});
  await mutate('timeline.clip.add', {trackId: selectedTrack.id, assetId: source(fixture.name).id, name: 'Selected saved clip 🎚️ 片段',
    startFrame: 15, durationFrames: 60, sourceInFrame: 15, gain: 1, fadeInFrames: 12, fadeOutFrames: 12,
    ...(selectedTrack.kind === 'video' ? {rect: {x: 20, y: 40, width: 400, height: 600}} : {})});
  const clipId = timeline.clips.at(-1).id;
  await mutate('timeline.clip.add', {trackId: track('Unrelated audio').id, assetId: source('other').id, name: 'Other audible clip', startFrame: 0, durationFrames: 15, sourceInFrame: 15, gain: 0.7});
  await mutate('timeline.clip.add', {trackId: track('Zero source').id, assetId: source('zero').id, name: 'Zero gain still silent', startFrame: 0, durationFrames: 90, sourceInFrame: 15, gain: 0, fadeInFrames: 12, fadeOutFrames: 12});
  // These muted clip edges split the selected clip inside both saved fades.
  await mutate('timeline.clip.add', {trackId: track('Muted source').id, assetId: source('muted').id, name: 'Muted track still silent', startFrame: 21, durationFrames: 48, sourceInFrame: 15, gain: 2, fadeInFrames: 12, fadeOutFrames: 12});
  return {name: fixture.name, project, timeline, sources, clipId, fixture};
}

function compareAudio(baseline, result, fixture, ratio, label) {
  assert.deepEqual(result.frameHashes, baseline.frameHashes, `${label}: all decoded video frames unchanged`);
  const windows = [];
  for (const channel of [0, 1]) {
    const tone = fixture.tones[channel] ?? fixture.tones[0];
    for (const [start, end] of [[0.58, 0.66], [0.74, 0.82], [1.1, 1.9], [2.18, 2.26], [2.34, 2.42]]) {
      const frequencies = [tone, 1700, 1800, 2370, 2570];
      const before = stats(baseline.pcm, start, end, channel, frequencies), after = stats(result.pcm, start, end, channel, frequencies);
      assert.ok(before.rms > 0.012, `${label}: baseline tone exists in every fade/plateau window`);
      const rmsRatio = after.rms / before.rms;
      near(rmsRatio, ratio, 0.035, `${label}: decoded AAC RMS, channel ${channel}, ${start}..${end}`);
      // Tone leakage is inspected over the long coherent plateau window only.
      if (start === 1.1) {
        assert.ok(before.amplitudes[tone] > 0.1, `${label}: source tone and channel retained`);
        for (const frequency of [1700, 1800, 2370, 2570]) {
          assert.ok(before.amplitudes[frequency] < 0.002 && after.amplitudes[frequency] < 0.002,
            `${label}: trim marker, zero gain and muted-track tones remain absent (${frequency} Hz)`);
        }
        const expectedPeak = 0.18 * (fixture.tones.length === 1 ? 1 / Math.sqrt(2) : 1);
        near(before.amplitudes[tone], expectedPeak, 0.008, `${label}: baseline amplitude/upmix`);
      }
      windows.push({channel, start, end, beforeRms: before.rms, afterRms: after.rms, rmsRatio});
    }
    const otherBefore = stats(baseline.pcm, 0.1, 0.4, channel, [1930]), otherAfter = stats(result.pcm, 0.1, 0.4, channel, [1930]);
    assert.ok(otherBefore.amplitudes[1930] > 0.08);
    near(otherAfter.rms / otherBefore.rms, 1, 0.01, `${label}: unrelated audible clip unchanged`);
    assert.ok(stats(result.pcm, 2.65, 2.95, channel).rms < 0.00001, `${label}: silent tail stays silent`);
  }
  records.checks.push({name: `${label}: decoded AAC gain/fades, trim, other audio and silent sources`, expectedRmsRatio: ratio, tolerance: 0.035, windows});
}

test('reviewed Agent gain reaches real queued media and undo restores decoded audio', {timeout: 240000}, async t => {
  await mkdir(evidence, {recursive: true});
  try {
    const f = await gainWireFixture(t, 'chat_completions'), sourceFixtures = await fixtureSources(f);
    for (const fixture of sourceFixtures.filter(item => ['stereo', 'mono', 'embedded'].includes(item.name))) {
      const selection = await setup(f, fixture, sourceFixtures), {project, clipId} = selection;
      const original = structuredClone(selection.timeline);
      const sourceRows = () => database(f.root, db => selection.sources.map(asset => db.prepare('SELECT data FROM assets WHERE id=?').get(asset.id).data));
      const originalRows = sourceRows();
      const baseline = await exportMedia(f, project.id, original, `${fixture.name}-baseline`);
      const applied = await reviewedGain(f, selection, 0.4);
      const adjusted = await exportMedia(f, project.id, selection.timeline, `${fixture.name}-gain-0.4`);
      compareAudio(baseline, adjusted, fixture, 0.4, `${fixture.name}: reviewed 0.4`);
      const beforeUndo = await history(f, project.id);
      selection.timeline = await f.rpc('timeline.undo', {projectId: project.id, expectedRevision: selection.timeline.revision, requestId: randomUUID()});
      sameContent(selection.timeline, original, 'undo restores exact original content including gain, media, fades and other tracks');
      assert.equal(selection.timeline.clips.find(clip => clip.id === clipId).gain, 1);
      const afterUndo = await history(f, project.id); assert.equal(afterUndo.cursor, beforeUndo.cursor - 1); assert.equal(afterUndo.length, beforeUndo.length);
      const undoState = tableSnapshot(f.root, timelineTables);
      assert.deepEqual((await f.action(project.id, applied.proposal, 'approve')).proposal, applied.approved);
      assert.deepEqual(await f.rpc('timeline.clip.update', applied.definition.input), JSON.parse(applied.receipt.response));
      assert.deepEqual(tableSnapshot(f.root, timelineTables), undoState, 'historical applied replay cannot reapply the gain after undo');
      const undone = await exportMedia(f, project.id, selection.timeline, `${fixture.name}-undo`);
      compareAudio(baseline, undone, fixture, 1, `${fixture.name}: undo`);
      assert.deepEqual(undone.pcm, baseline.pcm, 'same restored sources and envelopes yield byte-identical decoded audio');
      if (fixture.name === 'stereo') {
        await reviewedGain(f, selection, 0);
        const zero = await exportMedia(f, project.id, selection.timeline, 'stereo-gain-0');
        compareAudio(baseline, zero, fixture, 0, 'stereo: reviewed zero');
        for (const channel of [0, 1]) assert.ok(stats(zero.pcm, 0.6, 2.4, channel).rms < 0.00001, 'reviewed zero is silent despite nonzero muted source');
        await reviewedGain(f, selection, 1.5);
        const boosted = await exportMedia(f, project.id, selection.timeline, 'stereo-gain-1.5');
        compareAudio(baseline, boosted, fixture, 1.5, 'stereo: reviewed low-level boost');
        for (const channel of [0, 1]) assert.ok(stats(boosted.pcm, 1.1, 1.9, channel).peak < 0.35, 'only this low-level boost fixture stays below full scale; no general clipping guarantee');
      }
      assert.deepEqual(sourceRows(), originalRows, 'original managed source metadata bytes never change');
      for (const row of originalRows) {
        const source = JSON.parse(row);
        assert.equal(sha(await readFile(path.join(f.root, source.relativePath))), source.sha256, 'original managed media bytes never change');
      }
      records.checks.push({name: `${fixture.name}: original imported source bytes and metadata preserved`, sources: selection.sources.map(({id, sha256, mimeType}) => ({id, sha256, mimeType}))});
    }
    assert.equal(f.model.captures.length, 10, 'five bounded synthetic review runs, two SSE requests each');
    assert.deepEqual(f.model.errors, []); assert.equal((await f.process.observe()).acquisitions, 5);
    records.result = 'passed';
  } catch (error) {
    records.result = 'failed'; records.error = {message: error.message, code: error.code, stack: error.stack}; throw error;
  } finally {
    records.finishedAt = new Date().toISOString();
    await writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify(records, null, 2));
  }
});
