import test from 'node:test';
import assert from 'node:assert/strict';
import {accessSync, constants, realpathSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isExportPreflightResponse} from '@mioon/contracts';
import {
  createTimelineColourPlan, isTimelineColourSnapshot, timelineMixedColourPlanSchema,
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
import {
  openStore, classifyCurrentWorkspaceSchema, installCurrentWorkspaceRestoreSchema,
  validateCurrentWorkspaceRestoreSchema, validateCurrentWorkspaceColourProfile,
} from '../packages/business/src/db.mjs';
import {validateWorkspaceColourRows} from '../packages/business/src/workspace-colour-validation.ts';
import {snapshot as databaseSnapshot} from './workspace-schema26-fixtures.mjs';
import {png, sha, imageColour, stamp, timelineFixture} from './helpers/timeline-image-fixtures.mjs';

const code = 'TIMELINE_IMAGE_COMPOSITOR_BUDGET';
const budgetError = {code, message: TIMELINE_COLOUR_PREFLIGHT_MESSAGES[code]};
const intervals = count => Array.from({length: count}, (_, index) => [index * 3, 3]);

function fixture(ranges, {hidden = []} = {}) {
  const projectId = randomUUID();
  const bytes = ranges.map((_, index) => png({width: 8, height: 8,
    pixel: () => [32 + index * 7, 96, 160, 128]}));
  const assets = bytes.map((data, index) => {
    const id = randomUUID();
    return {id, projectId, name: `PNG ${index + 1}`, mimeType: 'image/png',
      relativePath: `media/${id}.png`, sha256: sha(data), sizeBytes: data.length,
      width: 8, height: 8, duration: null, hasVideo: true, hasAudio: false,
      provenance: 'user-import', createdAt: stamp};
  });
  const evidence = assets.map(asset => ({profileId: 'png-rgb8-srgb-v1',
    sha256: asset.sha256, sourceByteLength: asset.sizeBytes, width: 8, height: 8,
    bitDepth: 8, alphaMode: 'straight', orientation: 1, colourTag: 'srgb'}));
  const timeline = timelineFixture(assets, evidence.map(value => imageColour(value)));
  timeline.clips.forEach((clip, index) => {
    [clip.startFrame, clip.durationFrames] = ranges[index];
    clip.rect = {x: (index % 6) * 96, y: Math.floor(index / 6) * 96, width: 96, height: 96};
  });
  timeline.tracks.forEach((track, index) => { track.hidden = hidden.includes(index); });
  timeline.durationFrames = Math.max(...ranges.map(([start, duration]) => start + duration));
  return {projectId, assets, bytes, evidence, timeline,
    freeze: extra => freezeTimelineSnapshot(timeline, new Map(assets.map(asset => [asset.id, asset])), undefined, extra)};
}

function simultaneous(snapshot, segment) {
  const images = new Set(snapshot.colourPlan.clips.filter(clip => clip.kind === 'image').map(clip => clip.clipId));
  return snapshot.timeline.clips.filter(clip => images.has(clip.id) &&
    clip.startFrame <= segment.beginFrame && clip.startFrame + clip.durationFrames >= segment.endFrame).length;
}

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-image-concurrency-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

async function materialize(root, f) {
  await mkdir(path.join(root, 'media'), {recursive: true});
  const prepared = new Map();
  for (const [index, asset] of f.assets.entries()) {
    const file = path.join(root, asset.relativePath);
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

test('managed PNG compositor admits two overlapping inputs and rejects the third with actionable guidance', () => {
  assert.equal(TIMELINE_IMAGE_COMPOSITOR_INPUTS, 2);
  const two = fixture([[0, 6], [0, 6]]);
  assert.equal(two.freeze().colourPlan.clips.length, 2);
  assert.equal(isTimelineColourSnapshot(two.freeze()), true);
  const three = fixture([[0, 6], [0, 6], [0, 6]]);
  assert.throws(() => createTimelineColourPlan(three.timeline, three.assets), budgetError);
  assert.match(budgetError.message, /2/u);
  assert.match(budgetError.message, /错开|stagger/iu);
  assert.match(budgetError.message, /隐藏|hide/iu);
  assert.match(budgetError.message, /视频|video/iu);
  // Multiple clips of the same asset still open distinct segment inputs.
  three.timeline.clips.forEach(clip => {
    clip.assetId = three.assets[0].id;
    clip.colour = imageColour(three.evidence[0]);
  });
  assert.throws(() => createTimelineColourPlan(three.timeline, [three.assets[0]]), budgetError);
});

test('PNG concurrency uses end-exclusive boundaries regardless of clip order', () => {
  const f = fixture([[0, 6], [0, 3], [3, 3]]);
  const saved = f.freeze();
  assert.deepEqual(timelineCompositionSegments(f.timeline), [
    {beginFrame: 0, endFrame: 3}, {beginFrame: 3, endFrame: 6},
  ]);
  assert.deepEqual(planTimelineExportRange(saved).segments.map(segment => simultaneous(saved, segment)), [2, 2]);
  // Make start edges precede matching end edges in source iteration order.
  f.timeline.clips.reverse();
  assert.equal(f.freeze().colourPlan.clips.length, 3);
  f.timeline.clips.find(clip => clip.startFrame === 3).startFrame = 2;
  assert.throws(() => createTimelineColourPlan(f.timeline, f.assets), budgetError,
    'one shared frame is a real third simultaneous input');
});

test('hidden PNG tracks are omitted while legacy images and twelve video inputs retain their historical path', () => {
  const f = fixture([[0, 6], [0, 6], [0, 6], [0, 6]], {hidden: [2, 3]});
  // A hidden source with invalidated interpretation is not rendered or counted.
  f.timeline.clips[2].colour.source = null;
  assert.deepEqual(f.freeze().colourPlan.clips.map(clip => clip.clipId), f.timeline.clips.slice(0, 2).map(clip => clip.id));
  f.timeline.tracks[3].hidden = false;
  assert.throws(() => createTimelineColourPlan(f.timeline, f.assets), budgetError);

  const legacy = fixture(Array.from({length: 12}, () => [0, 6]));
  legacy.timeline.clips.forEach(clip => { delete clip.colour; });
  assert.equal(createTimelineColourPlan(legacy.timeline, legacy.assets), undefined);
  legacy.assets.forEach(asset => { asset.mimeType = 'video/mp4'; asset.duration = 1; });
  legacy.timeline.clips.forEach((clip, index) => {
    clip.colour = {profileId: 'mioon-rec709-sdr-clip-v1', source: {
      assetSha256: legacy.assets[index].sha256, streamIndex: 0,
      profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: stamp,
    }, look: null};
  });
  const videoPlan = createTimelineColourPlan(legacy.timeline, legacy.assets);
  assert.equal(videoPlan.profileId, 'mioon-rec709-sdr-render-v1');
  assert.equal(videoPlan.clips.length, 12);
  assert.ok(videoPlan.clips.every(clip => !Object.hasOwn(clip, 'kind')));
});

for (const scenario of ['twelve sequential', 'two visible plus hidden']) {
  test(`production render opens only active PNG inputs: ${scenario}`,
    {timeout: 120000, skip: process.platform === 'win32' && 'POSIX argv recorder'}, async t => {
      const root = await directory(t);
      const f = scenario === 'twelve sequential' ? fixture(intervals(12)) :
        fixture([[0, 6], [0, 6], [0, 6]], {hidden: [2]});
      const frozen = f.freeze(), expected = planTimelineExportRange(frozen).segments;
      assert.equal(frozen.colourPlan.clips.length, scenario === 'twelve sequential' ? 12 : 2);
      assert.equal(expected.length, scenario === 'twelve sequential' ? 12 : 1);
      const prepared = await materialize(root, f), output = path.join(root, 'render.mp4');
      const calls = await recordFfmpeg(root, () => renderTimeline(frozen, prepared, output));
      const segments = calls.filter(args => /^segment-\d{3}\.mov$/u.test(path.basename(args.at(-1))));
      assert.equal(segments.length, expected.length, 'every actual compositor segment was observed');
      const used = new Set();
      for (const [index, args] of segments.entries()) {
        const inputs = args.flatMap((arg, position) => arg === '-i' ? [args[position + 1]] : []);
        assert.equal(inputs.length, simultaneous(frozen, expected[index]));
        assert.ok(inputs.length <= 2, `segment ${index} opens ${inputs.length} PNGs`);
        assert.ok(inputs.every(file => path.extname(file) === '.png'));
        assert.ok(inputs.every(file => !f.assets.some(asset => file === path.join(root, asset.relativePath))),
          'the production compositor consumes attempt-owned derived PNG layers');
        inputs.forEach(file => used.add(file));
      }
      assert.equal(used.size, scenario === 'twelve sequential' ? 12 : 2,
        'nonoverlapping clips are not dropped, and hidden clips never become compositor inputs');
      const video = (await probe(output)).probe.streams.find(stream => stream.codec_type === 'video');
      assert.equal(Number(video.nb_frames), f.timeline.durationFrames);
      assert.equal(video.width, 720);
      assert.equal(video.height, 720);
      assert.equal((await readdir(root)).some(name => name.startsWith('.timeline-')), false);
    });
}

test('preflight reports the shared PNG cap before probing or writing, including a safe selected range', async t => {
  const root = await directory(t), store = openStore(root);
  let probes = 0;
  const preflight = createTimelinePreflightServices(store, {probe: async () => { probes++; assert.fail('over-budget plans must fail before probing'); }});
  t.after(async () => { await preflight.drain(); store.close(); });
  const f = fixture(intervals(4));
  f.timeline.clips.slice(0, 3).forEach(clip => { clip.startFrame = 0; });
  store.put('projects', {id: f.projectId, name: 'PNG concurrency', createdAt: stamp, updatedAt: stamp});
  f.assets.forEach(asset => store.put('assets', asset));
  store.put('timelines', f.timeline);
  const before = databaseSnapshot(store.db), changes = store.db.prepare('SELECT total_changes() AS n').get().n;
  for (const extra of [{}, {exportRange: {startFrame: 9, endFrame: 12}}]) {
    const input = {projectId: f.projectId, expectedRevision: 1, ...extra};
    const report = await preflight.handlers['timeline.export.preflight'](input);
    assert.equal(isExportPreflightResponse(report, input), true);
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.issues, [{...budgetError, severity: 'error'}]);
    assert.equal(report.checks.checkedAssets, 0);
    assert.equal(report.checks.bytesHashed, 0);
  }
  assert.equal(probes, 0);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.deepEqual(databaseSnapshot(store.db), before);
});

test('a safe export range cannot bypass an over-budget whole frozen mixed plan', async t => {
  const root = await directory(t), f = fixture(intervals(4));
  const frozen = f.freeze({exportRange: {startFrame: 9, endFrame: 12}});
  frozen.timeline.clips.slice(0, 3).forEach(clip => { clip.startFrame = 0; });
  assert.equal(timelineMixedColourPlanSchema.safeParse(frozen.colourPlan).success, true,
    'the frozen plan itself is structurally valid; only whole-timeline concurrency changed');
  const plan = planTimelineExportRange(frozen);
  assert.equal(plan.segments.length, 1);
  assert.equal(simultaneous(frozen, plan.segments[0]), 1);
  assert.equal(isTimelineColourSnapshot(frozen), false);
  const prepared = new Map(f.assets.map(asset => [asset.id, {...asset, path: path.join(root, asset.relativePath)}]));
  assert.doesNotThrow(() => validateTimeline(frozen.timeline, prepared));
  const events = [], off = onMediaProcess(event => events.push(event));
  try { await assert.rejects(renderTimeline(frozen, prepared, path.join(root, 'invalid.mp4')), budgetError); }
  finally { off(); }
  assert.deepEqual(events, [], 'whole-plan admission precedes decoding, deriving and compositor spawn');
  assert.deepEqual(await readdir(root), [], 'no render staging or output is created');
});

function rewrite(db, table, column, value) {
  const guards = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE UPDATE%'").all(table);
  for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
  try { db.prepare(`UPDATE ${table} SET ${column}=?`).run(JSON.stringify(value)); }
  finally { for (const guard of guards) db.exec(guard.sql); }
}

for (const location of ['export', 'receipt']) {
  test(`restored33 rejects an over-budget frozen ${location} consistently without changing retained evidence`, async t => {
    const root = await directory(t), store = openStore(root), db = store.db;
    t.after(() => store.close());
    const f = fixture(intervals(4));
    store.put('projects', {id: f.projectId, name: 'Restored PNG concurrency', createdAt: stamp, updatedAt: stamp});
    f.assets.forEach(asset => store.put('assets', asset));
    store.put('timelines', f.timeline);
    const rendered = {id: randomUUID(), projectId: f.projectId, requestId: randomUUID(),
      mode: 'timeline', purpose: 'export', timelineRevision: 1,
      snapshot: f.freeze({exportRange: {startFrame: 9, endFrame: 12}}),
      status: 'queued', assetId: null, url: null, error: null, createdAt: stamp, updatedAt: stamp};
    store.put('exports', rendered);
    db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(rendered.requestId, 'a'.repeat(64), JSON.stringify(rendered));
    assert.equal(classifyCurrentWorkspaceSchema(db).schemaVersion, 32);
    assert.equal(installCurrentWorkspaceRestoreSchema(db, {restorationId: randomUUID(),
      workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(), manifestHash: 'a'.repeat(64),
      sourceDbHash: 'b'.repeat(64), createdAt: stamp}).schemaVersion, 33);
    assert.equal(validateCurrentWorkspaceRestoreSchema(db).schemaVersion, 33);

    const corrupt = structuredClone(rendered);
    corrupt.snapshot.timeline.clips.slice(0, 3).forEach(clip => { clip.startFrame = 0; });
    assert.equal(timelineMixedColourPlanSchema.safeParse(corrupt.snapshot.colourPlan).success, true);
    assert.equal(isTimelineColourSnapshot(corrupt.snapshot), false);
    rewrite(db, location === 'export' ? 'exports' : 'timeline_requests', location === 'export' ? 'data' : 'response', corrupt);
    const before = databaseSnapshot(db), changes = db.prepare('SELECT total_changes() AS n').get().n;
    for (const validate of [
      () => validateWorkspaceColourRows(db, {allowColour: true, allowMixedImages: true}),
      () => validateCurrentWorkspaceColourProfile(db),
      () => classifyCurrentWorkspaceSchema(db),
      () => validateCurrentWorkspaceRestoreSchema(db),
    ]) assert.throws(validate, {code: 'WORKSPACE_COLOUR_INVALID'});
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.deepEqual(databaseSnapshot(db), before);
  });
}
