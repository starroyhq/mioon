import test from 'node:test';
import assert from 'node:assert/strict';
import {accessSync, constants, realpathSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isExportPreflightResponse} from '@mioon/contracts';
import {
  createTimelineColourPlan, isTimelineColourSnapshot, timelineJpegMixedColourPlanSchema,
  TIMELINE_IMAGE_COMPOSITOR_INPUTS, TIMELINE_COLOUR_PREFLIGHT_MESSAGES,
} from '../packages/contracts/src/timeline-colour.ts';
import {timelineCompositionSegments} from '../packages/contracts/src/timeline-segments.ts';
import {freezeTimelineSnapshot, validateTimeline} from '../packages/business/src/timeline-inputs.mjs';
import {planTimelineExportRange} from '../packages/business/src/timeline-export-range-plan.ts';
import {renderTimeline} from '../packages/business/src/timeline-media.mjs';
import {probe} from '../packages/business/src/media.mjs';
import {mediaExecutable} from '../packages/business/src/media-environment.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {createTimelinePreflightServices} from '../packages/business/src/timeline-preflight.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {snapshot as databaseSnapshot} from './workspace-schema26-fixtures.mjs';
import {png, sha, imageColour, stamp, timelineFixture} from './helpers/timeline-image-fixtures.mjs';
import {pillowJfifFixture} from './helpers/timeline-jpeg-fixtures.mjs';
import {jpegColour} from './helpers/timeline-jpeg-workflow-fixtures.mjs';

const code = 'TIMELINE_IMAGE_COMPOSITOR_BUDGET';
const budgetError = {code, message: TIMELINE_COLOUR_PREFLIGHT_MESSAGES[code]};
const intervals = count => Array.from({length: count}, (_, index) => [index * 3, 3]);

function fixture(ranges, {hidden = [], formats = ranges.map((_, index) => index % 2 ? 'jpeg' : 'png')} = {}) {
  const projectId = randomUUID();
  const sampling = index => ['444', '422', '420'][index % 3];
  const bytes = ranges.map((_, index) => formats[index] === 'jpeg' ? pillowJfifFixture(sampling(index)) :
    png({width: 8, height: 8, pixel: () => [32 + index * 7, 96, 160, 128]}));
  const assets = bytes.map((data, index) => {
    const id = randomUUID(), jpeg = formats[index] === 'jpeg';
    return {id, projectId, name: `${jpeg ? 'JFIF JPEG' : 'PNG'} ${index + 1}`,
      mimeType: jpeg ? 'image/jpeg' : 'image/png', relativePath: `media/${id}.${jpeg ? 'jpg' : 'png'}`,
      sha256: sha(data), sizeBytes: data.length, width: jpeg ? 17 : 8, height: jpeg ? 13 : 8,
      duration: null, hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: stamp};
  });
  const evidence = assets.map((asset, index) => ({profileId: formats[index] === 'jpeg' ? 'jfif-ycbcr8-srgb-v1' : 'png-rgb8-srgb-v1',
    sha256: asset.sha256, sourceByteLength: asset.sizeBytes, width: asset.width, height: asset.height,
    bitDepth: 8, alphaMode: formats[index] === 'jpeg' ? 'opaque' : 'straight', orientation: 1,
    colourTag: formats[index] === 'jpeg' ? 'untagged' : 'srgb',
    ...(formats[index] === 'jpeg' ? {sampling: sampling(index), decoderPolicy: 'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1'} : {})}));
  const timeline = timelineFixture(assets, evidence.map((value, index) => formats[index] === 'jpeg' ? jpegColour(value) : imageColour(value)));
  timeline.clips.forEach((clip, index) => {
    [clip.startFrame, clip.durationFrames] = ranges[index];
    clip.rect = {x: (index % 6) * 96, y: Math.floor(index / 6) * 96, width: 96, height: 96};
  });
  timeline.tracks.forEach((track, index) => { track.hidden = hidden.includes(index); });
  timeline.durationFrames = Math.max(...ranges.map(([start, duration]) => start + duration));
  return {projectId, assets, bytes, evidence, timeline, hidden,
    freeze: extra => freezeTimelineSnapshot(timeline, new Map(assets.map(asset => [asset.id, asset])), undefined, extra)};
}

function simultaneous(snapshot, segment) {
  const images = new Set(snapshot.colourPlan.clips.filter(clip => clip.kind === 'image').map(clip => clip.clipId));
  return snapshot.timeline.clips.filter(clip => images.has(clip.id) &&
    clip.startFrame <= segment.beginFrame && clip.startFrame + clip.durationFrames >= segment.endFrame).length;
}

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-jpeg-concurrency-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

async function materialize(root, f) {
  await mkdir(path.join(root, 'media'), {recursive: true});
  const prepared = new Map();
  for (const [index, asset] of f.assets.entries()) {
    const file = path.join(root, asset.relativePath);
    if (f.hidden.includes(index)) {
      // No hidden source file exists. This is deliberately stronger than only
      // checking the final compositor argv: staging cannot decode it either.
      prepared.set(asset.id, {...asset, path: file});
      continue;
    }
    await writeFile(file, f.bytes[index]);
    const media = await probe(file);
    prepared.set(asset.id, {...asset, ...media, path: file,
      colourProbe: media.probe, colourImageEvidence: f.evidence[index]});
  }
  return prepared;
}

// Observe the actual production argv through the supported runtime setting.
// This shell only records NUL-delimited arguments, then execs the previously
// resolved trusted FFmpeg binary. No mock renderer, source edits or UI hooks.
async function recordFfmpeg(root, action) {
  const previous = process.env.MIOON_FFMPEG_PATH;
  const executable = mediaExecutable('ffmpeg');
  const candidates = path.isAbsolute(executable) ? [executable] :
    (process.env.PATH ?? '').split(path.delimiter).map(dir => path.resolve(dir, executable));
  const actual = candidates.find(file => {
    try { accessSync(file, constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(actual, 'the production FFmpeg executable must be available');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const marker = '__MIOON_FFMPEG_INVOCATION__';
  const log = path.join(root, 'ffmpeg-argv.bin'), wrapper = path.join(root, 'record-ffmpeg.sh');
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\0' ${quote(marker)} "$@" >> ${quote(log)}\nexec ${quote(realpathSync(actual))} "$@"\n`, {mode: 0o700});
  process.env.MIOON_FFMPEG_PATH = wrapper;
  try { await action(); }
  finally {
    if (previous === undefined) delete process.env.MIOON_FFMPEG_PATH;
    else process.env.MIOON_FFMPEG_PATH = previous;
  }
  const records = [];
  for (const arg of (await readFile(log)).toString('utf8').split('\0').slice(0, -1)) {
    if (arg === marker) records.push([]);
    else { assert.ok(records.length); records.at(-1).push(arg); }
  }
  return records;
}

test('the shared two-image budget admits PNG plus JPEG and rejects either format as the third input', () => {
  assert.equal(TIMELINE_IMAGE_COMPOSITOR_INPUTS, 2);
  const two = fixture([[0, 6], [0, 6]]), saved = two.freeze();
  assert.equal(saved.colourPlan.profileId, 'mioon-mixed-sdr-render-v3');
  assert.deepEqual(saved.colourPlan.clips.map(clip => clip.sourceProfileId), ['png-rgb8-srgb-v1', 'jfif-ycbcr8-srgb-v1']);
  assert.equal(isTimelineColourSnapshot(saved), true);
  for (const formats of [['png', 'jpeg', 'png'], ['png', 'jpeg', 'jpeg']]) {
    const three = fixture([[0, 6], [0, 6], [0, 6]], {formats});
    assert.throws(() => createTimelineColourPlan(three.timeline, three.assets), budgetError);
  }
  assert.match(budgetError.message, /2/); assert.match(budgetError.message, /PNG 与 JPEG 合计/);
  assert.match(budgetError.message, /错开/); assert.match(budgetError.message, /隐藏/);
  assert.match(budgetError.message, /视频轨道上限不变/);
  // Reusing one JPEG source in two overlapping clips still requires two inputs.
  const reused = fixture([[0, 6], [0, 6], [0, 6]], {formats: ['png', 'jpeg', 'jpeg']});
  reused.timeline.clips[2].assetId = reused.assets[1].id;
  reused.timeline.clips[2].colour = jpegColour(reused.evidence[1]);
  assert.throws(() => createTimelineColourPlan(reused.timeline, reused.assets.slice(0, 2)), budgetError);
});

test('mixed-format interval accounting is end-exclusive and independent of source ordering', () => {
  const f = fixture([[0, 6], [0, 3], [3, 3]], {formats: ['png', 'jpeg', 'jpeg']});
  const saved = f.freeze();
  assert.deepEqual(timelineCompositionSegments(f.timeline), [
    {beginFrame: 0, endFrame: 3}, {beginFrame: 3, endFrame: 6},
  ]);
  assert.deepEqual(planTimelineExportRange(saved).segments.map(segment => simultaneous(saved, segment)), [2, 2]);
  f.timeline.clips.reverse(); assert.equal(f.freeze().colourPlan.clips.length, 3);
  f.timeline.clips.find(clip => clip.startFrame === 3).startFrame = 2;
  assert.throws(() => createTimelineColourPlan(f.timeline, f.assets), budgetError,
    'one genuinely overlapping frame is rejected, not rounded away');
});

for (const scenario of ['PNG plus JPEG with hidden PNG/JPEG', 'six nonoverlapping alternating sources']) {
  test(`production renderer opens only active combined image inputs: ${scenario}`,
    {timeout: 120000, skip: process.platform === 'win32' && 'POSIX argv recorder'}, async t => {
      const root = await directory(t), hiddenCase = scenario.startsWith('PNG plus');
      const f = hiddenCase ? fixture([[0, 6], [0, 6], [0, 6], [0, 6]], {hidden: [2, 3]}) : fixture(intervals(6));
      if (hiddenCase) {
        f.timeline.clips[2].colour.source = null;
        f.timeline.clips[3].colour.source = null;
      }
      const frozen = f.freeze(), expected = planTimelineExportRange(frozen).segments;
      assert.equal(frozen.colourPlan.profileId, 'mioon-mixed-sdr-render-v3');
      assert.equal(frozen.colourPlan.clips.length, hiddenCase ? 2 : 6);
      assert.equal(expected.length, hiddenCase ? 1 : 6);
      const prepared = await materialize(root, f), output = path.join(root, 'render.mp4');
      const calls = await recordFfmpeg(root, () => renderTimeline(frozen, prepared, output));
      const segments = calls.filter(args => /^segment-\d{3}\.mov$/u.test(path.basename(args.at(-1))));
      assert.equal(segments.length, expected.length, 'every production compositor segment is observed');
      const used = new Set();
      for (const [index, args] of segments.entries()) {
        const inputs = args.flatMap((arg, position) => arg === '-i' ? [args[position + 1]] : []);
        assert.equal(inputs.length, simultaneous(frozen, expected[index]));
        assert.equal(inputs.length, hiddenCase ? 2 : 1);
        assert.ok(inputs.every(file => path.extname(file) === '.png'), 'both formats become verified private RGBA layers');
        assert.ok(inputs.every(file => !f.assets.some(asset => file === path.join(root, asset.relativePath))));
        inputs.forEach(file => used.add(file));
      }
      assert.equal(used.size, hiddenCase ? 2 : 6, 'all sequential sources survive and hidden sources never become layers');
      const hiddenPaths = f.hidden.map(index => path.join(root, f.assets[index].relativePath));
      assert.equal(calls.some(args => args.some(arg => hiddenPaths.includes(arg))), false, 'even derivation never opens a hidden input');
      const jpegPaths = f.assets.filter((asset, index) => asset.mimeType === 'image/jpeg' && !f.hidden.includes(index))
        .map(asset => path.join(root, asset.relativePath));
      for (const file of jpegPaths) assert.ok(calls.some(args => args.includes(file) && args.includes('mjpeg')),
        'visible JPEG source uses the fixed software JPEG decoder during derivation');
      const video = (await probe(output)).probe.streams.find(stream => stream.codec_type === 'video');
      assert.equal(Number(video.nb_frames), f.timeline.durationFrames);
      assert.equal(video.width, 720); assert.equal(video.height, 720);
      for (const [index, asset] of f.assets.entries()) if (!f.hidden.includes(index))
        assert.deepEqual(await readFile(path.join(root, asset.relativePath)), f.bytes[index]);
      assert.equal((await readdir(root)).some(name => name.startsWith('.timeline-')), false);
    });
}

test('preflight rejects a combined third image before probing or writes, even when the selected range is safe', async t => {
  const root = await directory(t), store = openStore(root);
  let probes = 0;
  const preflight = createTimelinePreflightServices(store, {probe: async () => { probes++; assert.fail('budget must fail before probe'); }});
  t.after(async () => { await preflight.drain(); store.close(); });
  for (const formats of [['png', 'jpeg', 'png', 'jpeg'], ['png', 'jpeg', 'jpeg', 'png']]) {
    const f = fixture(intervals(4), {formats});
    f.timeline.clips.slice(0, 3).forEach(clip => { clip.startFrame = 0; });
    store.put('projects', {id: f.projectId, name: 'Combined image concurrency', createdAt: stamp, updatedAt: stamp});
    f.assets.forEach(asset => store.put('assets', asset)); store.put('timelines', f.timeline);
    const before = databaseSnapshot(store.db), changes = store.db.prepare('SELECT total_changes() AS n').get().n;
    for (const extra of [{}, {exportRange: {startFrame: 9, endFrame: 12}}]) {
      const input = {projectId: f.projectId, expectedRevision: 1, ...extra};
      const report = await preflight.handlers['timeline.export.preflight'](input);
      assert.equal(isExportPreflightResponse(report, input), true);
      assert.equal(report.status, 'blocked'); assert.deepEqual(report.issues, [{...budgetError, severity: 'error'}]);
      assert.equal(report.checks.checkedAssets, 0); assert.equal(report.checks.bytesHashed, 0);
    }
    assert.equal(probes, 0); assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.deepEqual(databaseSnapshot(store.db), before);
  }
});

test('renderer independently rejects an over-budget mixed snapshot before decoding or staging', async t => {
  const root = await directory(t), f = fixture(intervals(4));
  const frozen = f.freeze({exportRange: {startFrame: 9, endFrame: 12}});
  frozen.timeline.clips.slice(0, 3).forEach(clip => { clip.startFrame = 0; });
  assert.equal(timelineJpegMixedColourPlanSchema.safeParse(frozen.colourPlan).success, true,
    'the JPEG-capable frozen plan is structurally valid; concurrency is the rejected condition');
  const selected = planTimelineExportRange(frozen);
  assert.equal(selected.segments.length, 1); assert.equal(simultaneous(frozen, selected.segments[0]), 1);
  assert.equal(isTimelineColourSnapshot(frozen), false);
  const prepared = new Map(f.assets.map(asset => [asset.id, {...asset, path: path.join(root, asset.relativePath)}]));
  assert.doesNotThrow(() => validateTimeline(frozen.timeline, prepared));
  const events = [], off = onMediaProcess(event => events.push(event));
  try { await assert.rejects(renderTimeline(frozen, prepared, path.join(root, 'invalid.mp4')), budgetError); }
  finally { off(); }
  assert.deepEqual(events, [], 'whole-plan admission precedes all local decoder and compositor processes');
  assert.deepEqual(await readdir(root), [], 'no staging or output was created');
});
