import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

// This is a command/graph regression, not a decoder or execution-authority test.
// Its baseline is application-owned local Git source with a pinned pre-seam hash.
// Media is never spawned: all subprocess entry points fail closed after Git read.
const baselineCommit = '812d18a9d493f01f94235bd4f424b4e17e742ad8';
const rendererPath = 'packages/business/src/timeline-media.mjs';
const baselineHash = 'b89728d7508ea1ca0d2011c3fad710722411993bd8a0989553167733bf343dde';
const repo = fileURLToPath(new URL('../', import.meta.url));
const rendererUrl = new URL('../' + rendererPath, import.meta.url).href;
const baselineUrl = rendererUrl + '?opacity-legacy-baseline=' + baselineCommit;
const baselineSource = cp.execFileSync('git', ['show', baselineCommit + ':' + rendererPath], {
  cwd: repo, encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 5000,
});
assert.equal(createHash('sha256').update(baselineSource).digest('hex'), baselineHash);
let childAttempts = 0;
const forbidChild = () => { childAttempts++; throw Error('A pure legacy renderer regression may not spawn a subprocess'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidChild);
syncBuiltinESMExports();

const runtimeKey = Symbol.for('mioon.test.opacity-legacy-render-regression');
const runtimeExpression = 'globalThis[Symbol.for("mioon.test.opacity-legacy-render-regression")]';
const mediaUrl = new URL('../packages/business/src/media.mjs', import.meta.url).href;
const mediaRuntimeUrl = new URL('../packages/business/src/media-runtime.mjs', import.meta.url).href;
const imageStageUrl = new URL('../packages/business/src/timeline-image-staging.ts', import.meta.url).href;
const actualRuntimeUrl = mediaRuntimeUrl + '?opacity-legacy-actual-runtime';
const actualMediaUrl = mediaUrl + '?opacity-legacy-actual-media';
let activeRuntime;
globalThis[runtimeKey] = {
  run: (...args) => activeRuntime.run(...args),
  runStreaming: (...args) => activeRuntime.runStreaming(...args),
  probe: (...args) => activeRuntime.probe(...args),
  prepareImages: (...args) => activeRuntime.prepareImages(...args),
};
const hooks = registerHooks({load(url, context, next) {
  if (url === baselineUrl) return {format: 'module', shortCircuit: true, source: baselineSource};
  if (url === mediaRuntimeUrl) return {format: 'module', shortCircuit: true,
    source: `export * from ${JSON.stringify(actualRuntimeUrl)};export const run=(...args)=>${runtimeExpression}.run(...args);export const runStreaming=(...args)=>${runtimeExpression}.runStreaming(...args);`};
  if (url === mediaUrl) return {format: 'module', shortCircuit: true,
    source: `export * from ${JSON.stringify(actualMediaUrl)};export const run=(...args)=>${runtimeExpression}.run(...args);export const probe=(...args)=>${runtimeExpression}.probe(...args);`};
  if (url === imageStageUrl) return {format: 'module', shortCircuit: true,
    source: `export const prepareTimelineImageLayers=(...args)=>${runtimeExpression}.prepareImages(...args);`};
  return next(url, context);
}});

// Dynamic imports occur only after interception; actual planners, frozen schema
// constructors, source interpretation checks and filter builders remain in use.
const [currentRenderer, oldRenderer, contracts, colour, inputs, dbModule, schemas,
  schema26, schema28, schema30, schema32, schema34, schema36, schema38, schema40,
  restore41, databaseHelpers, imageFixtures, imageAdmission] = await Promise.all([
  import(rendererUrl), import(baselineUrl), import('@mioon/contracts'),
  import('../packages/contracts/src/timeline-colour.ts'),
  import('../packages/business/src/timeline-inputs.mjs'),
  import('../packages/business/src/db.mjs'),
  import('../packages/business/src/workspace-fixed-schema.mjs'),
  import('../packages/business/src/workspace-schema-v26.ts'),
  import('../packages/business/src/workspace-schema-v28.ts'),
  import('../packages/business/src/workspace-schema-v30.ts'),
  import('../packages/business/src/workspace-schema-v32.ts'),
  import('../packages/business/src/workspace-schema-v34.ts'),
  import('../packages/business/src/workspace-schema-v36.ts'),
  import('../packages/business/src/workspace-schema-v38.ts'),
  import('../packages/business/src/workspace-schema-v40.ts'),
  import('../packages/business/src/workspace-restore-schema-v41.ts'),
  import('./workspace-schema26-fixtures.mjs'),
  import('./helpers/timeline-image-fixtures.mjs'),
  import('../packages/business/src/timeline-image-admission.ts'),
]);
void dbModule; // Installs the unchanged fixed envelope runtime before schema use.
const profile = restore41.createWorkspaceRestoreProfileV41(schemas.initializeWorkspaceSchemaThrough24);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-16T00:00:00.000Z';

async function fixture(root, managed) {
  const bytes = imageFixtures.png({width: 8, height: 8});
  const evidence = imageFixtures.evidenceOnly(await imageAdmission.inspectStaticSrgbPng(bytes));
  const common = {projectId: id(1), duration: 1, width: 64, height: 48, hasVideo: true,
    hasAudio: true, audioStreamIndex: 1, videoStreamIndex: 0};
  const video = {...common, id: id(2), mimeType: 'video/mp4', sha256: 'a'.repeat(64),
    relativePath: 'media/video.mp4', path: path.join(root, 'video.mp4'), sizeBytes: 128,
    colourProbe: {streams: [{index: 0, codec_type: 'video', codec_name: 'h264',
      width: 64, height: 48, pix_fmt: 'yuv420p', color_range: 'tv',
      color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709'}]}};
  const image = {...common, id: id(3), mimeType: 'image/png', sha256: evidence.sha256,
    relativePath: 'media/image.png', path: path.join(root, 'image.png'), sizeBytes: bytes.length,
    hasAudio: false, width: 8, height: 8, colourImageEvidence: evidence,
    colourProbe: {streams: [{index: 0, codec_type: 'video', codec_name: 'png',
      width: 8, height: 8, pix_fmt: 'rgba', sample_aspect_ratio: '1:1'}]}};
  const sound = {...common, id: id(4), mimeType: 'audio/wav', sha256: 'b'.repeat(64),
    relativePath: 'media/sound.wav', path: path.join(root, 'sound.wav'), sizeBytes: 128,
    width: 0, height: 0, hasVideo: false, audioStreamIndex: 0};
  const assets = new Map([video, image, sound].map(asset => [asset.id, asset]));
  const tracks = [0, 1, 2].map(n => ({id: id(10 + n), name: `Track ${n}`,
    kind: n === 2 ? 'audio' : 'video', orderIndex: n, hidden: false, muted: false}));
  const clip = (n, asset, patch) => ({id: id(20 + n), name: `Clip ${n}`, trackId: tracks[n].id,
    assetId: asset.id, startFrame: 0, durationFrames: 9, sourceInFrame: 2,
    rect: {x: 0, y: 0, width: 720, height: 720}, gain: .75, ...patch});
  const clips = [clip(0, video, {fadeInFrames: 2, fadeOutFrames: 2,
    volumeEnvelope: {profileId: 'mioon-clip-linear-attenuation-v1', points: [{frame: 0, multiplier: .5}, {frame: 9, multiplier: 1}]}}),
    clip(1, image, {startFrame: 3, durationFrames: 3, sourceInFrame: 0,
      rect: {x: 180, y: 180, width: 360, height: 360}, gain: 1}),
    clip(2, sound, {sourceInFrame: 4, fadeInFrames: 1, fadeOutFrames: 1})];
  if (managed) {
    clips[0].colour = {profileId: 'mioon-rec709-sdr-clip-v1', source: {
      assetSha256: video.sha256, streamIndex: 0, profileId: 'rec709-yuv-sdr-v1',
      range: 'limited', declaredBy: 'user', declaredAt: stamp}, look: null};
    clips[1].colour = imageFixtures.imageColour(evidence);
  }
  const timeline = {id: id(5), projectId: id(1), revision: 1, fps: 30, width: 720,
    height: 720, durationFrames: 9, tracks, clips, createdAt: stamp, updatedAt: stamp};
  if (managed) timeline.subtitles = {profileId: contracts.TIMELINE_SUBTITLE_PROFILE_ID,
    cues: [{id: id(30), text: 'Legacy 字幕', startFrame: 2, durationFrames: 5}]};
  const snapshot = inputs.freezeTimelineSnapshot(timeline, assets);
  assert.equal(Object.hasOwn(snapshot, 'opacityPlan'), false);
  assert.equal(snapshot.timeline.clips.some(c => Object.hasOwn(c, 'opacityEnvelope')), false);
  if (managed) assert.equal(snapshot.colourPlan.profileId, colour.TIMELINE_MIXED_COLOUR_RENDER_PROFILE);
  return {snapshot, assets};
}

function retainedSnapshots(snapshot, assets) {
  const db = databaseHelpers.open(':memory:');
  try {
    for (const initialize of [schemas.initializeWorkspaceSchemaThrough24,
      schema26.initializeWorkspaceSchema26, schema28.initializeWorkspaceSchema28,
      schema30.initializeWorkspaceSchema30, schema32.initializeWorkspaceSchema32,
      schema34.initializeWorkspaceSchema34, schema36.initializeWorkspaceSchema36,
      schema38.initializeWorkspaceSchema38, schema40.initializeWorkspaceSchema40]) initialize(db);
    databaseHelpers.insert(db, 'projects', {id: id(1), data: JSON.stringify({id: id(1)})});
    for (const asset of assets.values()) databaseHelpers.insert(db, 'assets', {
      id: asset.id, projectId: id(1), data: JSON.stringify(asset),
    });
    const record = {id: id(40), projectId: id(1), requestId: 'legacy-render-regression',
      mode: 'timeline', purpose: 'export', timelineRevision: snapshot.timeline.revision,
      snapshot, status: 'queued', assetId: null, url: null, error: null, createdAt: stamp, updatedAt: stamp};
    databaseHelpers.insert(db, 'exports', {id: record.id, projectId: id(1), data: JSON.stringify(record)});
    schema40.validateWorkspaceSchema40(db);
    assert.deepEqual(profile.classifyWorkspaceSchemaV40V41(db), {schemaVersion: 40, profile: 'ordinary'});
    const ordinaryRaw = db.prepare('SELECT data FROM exports WHERE id=?').get(record.id).data;
    profile.installWorkspaceRestoreSchemaV41(db, {restorationId: id(101), workspaceOrigin: id(102),
      sourceBackupId: id(103), manifestHash: 'c'.repeat(64), sourceDbHash: 'd'.repeat(64), createdAt: stamp});
    profile.validateWorkspaceRestoreSchemaV41(db);
    assert.deepEqual(profile.classifyWorkspaceSchemaV40V41(db), {schemaVersion: 41, profile: 'restored-local-v9'});
    const restoredRaw = db.prepare('SELECT data FROM exports WHERE id=?').get(record.id).data;
    assert.equal(restoredRaw, ordinaryRaw, 'restoration keeps original receipt bytes');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_restore_holds WHERE kind='exports'").get().count, 1);
    // These held snapshots are inspected only by the inert graph harness. This
    // deliberately grants no restored job permission and invokes no worker.
    return [[40, JSON.parse(ordinaryRaw).snapshot], [41, JSON.parse(restoredRaw).snapshot]];
  } finally { db.close(); }
}

function fakeRuntime(snapshot, root) {
  const calls = [], frames = snapshot.exportRange ? snapshot.exportRange.endFrame - snapshot.exportRange.startFrame : snapshot.timeline.durationFrames;
  const remember = (kind, command, args, options = {}) => {
    options.beforeEffect?.();
    const files = {};
    for (const option of ['-filter_complex_script', '-filter_script:v']) {
      const at = args.indexOf(option); if (at >= 0) files[option] = fs.readFileSync(args[at + 1], 'utf8');
    }
    if (args.includes('concat')) files.concat = fs.readFileSync(args[args.indexOf('-i') + 1], 'utf8');
    calls.push({kind, command, argv: [...args], files,
      timeout: options.timeout, maxStdoutBytes: options.maxStdoutBytes, maxStderrBytes: options.maxStderrBytes});
  };
  return {calls,
    async run(command, args, options) { remember('run', command, args, options); return ''; },
    async runStreaming(command, args, options) {
      remember('runStreaming', command, args, options);
      assert.ok(args.includes('-filter_script:v'), 'only subtitle ink measurement may stream');
      const count = Number(args[args.indexOf('-frames:v') + 1]), bytes = Buffer.alloc(4096 * 256 * count);
      for (let n = 0; n < count; n++) { bytes[n * 4096 * 256 + 100 * 4096 + 100] = 255; bytes[n * 4096 * 256 + 140 * 4096 + 200] = 255; }
      options.onStdout(bytes); return {stdoutBytes: bytes.length};
    },
    async probe(file, options) {
      options?.beforeEffect?.(); calls.push({kind: 'probe', file});
      return {width: 720, height: 720, duration: frames / 30, hasAudio: true, hasVideo: true,
        probe: {streams: [{codec_type: 'video', codec_name: 'h264', r_frame_rate: '30/1', avg_frame_rate: '30/1',
          nb_frames: String(frames), sample_aspect_ratio: '1:1', pix_fmt: 'yuv420p', has_b_frames: 0,
          time_base: '1/30000', duration: String(frames / 30), start_pts: 0, start_time: '0',
          color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv'},
        {codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, time_base: '1/48000',
          channel_layout: 'stereo', duration: String(frames / 30), start_pts: 0, start_time: '0'}],
        format: {format_name: 'mov,mp4', start_time: '0'}}};
    },
    async prepareImages(inputs, _destination, options) {
      calls.push({kind: 'managed-image-stage', inputs});
      return {path: clipId => path.join(root, `managed-${clipId}.png`),
        effect: () => options.beforeEffect?.(), verifyBytes: () => options.beforeEffect?.(), cleanup: () => true};
    },
  };
}

test('old40/41 graphs and argv match pinned pre-seam renderer exactly for video, image, audio, subtitles and selected ranges', async t => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), 'mioon-opacity-legacy-')));
  // Equal test-owned staging names make argv comparison literal: no replacement
  // or normalization can conceal an unexpected path, argument or filter change.
  const fixedDirectory = prefix => { const target = prefix + 'legacy-regression'; fs.mkdirSync(target, {mode: 0o700}); return target; };
  t.mock.method(fs, 'mkdtempSync', fixedDirectory);
  t.mock.method(fsp, 'mkdtemp', async prefix => fixedDirectory(prefix));
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll(); mock.restoreAll(); syncBuiltinESMExports(); hooks.deregister(); delete globalThis[runtimeKey];
    await fsp.rm(root, {recursive: true, force: true});
  });
  let compared = 0;
  for (const managed of [false, true]) {
    const source = await fixture(root, managed);
    for (const [version, retained] of retainedSnapshots(source.snapshot, source.assets)) {
      for (const range of [null, {startFrame: 1, endFrame: 8}]) {
        const snapshot = structuredClone(retained); if (range) snapshot.exportRange = range;
        const frozenRaw = JSON.stringify(snapshot), destination = path.join(root, 'result.mp4');
        activeRuntime = fakeRuntime(snapshot, root);
        await oldRenderer.renderTimeline(snapshot, source.assets, destination, {beforeEffect() {}});
        const expected = activeRuntime.calls;
        activeRuntime = fakeRuntime(snapshot, root);
        await currentRenderer.renderTimeline(snapshot, source.assets, destination, {beforeEffect() {}});
        assert.deepEqual(activeRuntime.calls, expected, `schema${version} managed=${managed} selected=${Boolean(range)}: exact argv, filters, script and concat bytes`);
        assert.equal(JSON.stringify(snapshot), frozenRaw, 'neither renderer mutates retained raw snapshot');
        const graphs = expected.flatMap(call => [call.files?.['-filter_complex_script'], call.argv?.[call.argv.indexOf('-filter_complex') + 1]]).filter(value => typeof value === 'string' && value.includes('[outv]'));
        assert.equal(graphs.length, 3, 'clip edges produce three genuinely compared visual segments');
        assert.ok(graphs.some(graph => graph.includes('overlay=x=180:y=180:')));
        assert.ok(graphs.every(graph => graph.includes('asetpts=N/SR/TB')));
        assert.ok(graphs.some(graph => graph.includes('afade=t=in:')));
        assert.ok(graphs.every(graph => !graph.includes('geq=')), 'old snapshot adds no opacity stage');
        if (managed) {
          assert.ok(graphs.some(graph => graph.includes(':alpha=premultiplied')));
          assert.ok(graphs.some(graph => graph.includes('drawtext=')));
          assert.equal(expected.filter(call => call.kind === 'managed-image-stage').length, 1);
        }
        assert.deepEqual(await fsp.readdir(root), [], 'each inert attempt removes its own temporary staging');
        compared++;
      }
    }
  }
  assert.equal(childAttempts, 0);
  assert.equal(compared, 8);
  t.diagnostic('8 exact before/after comparisons; real in-memory40/41 receipt capture; all media mocked; zero child attempts; no encoded-file identity claim');
});
