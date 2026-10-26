import type {FixtureExport} from './helpers/strict-timeline-core-types.ts';
import type {BackupResult,RestoreResult} from './helpers/strict-timeline-backup-types.ts';
import type {TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore, getWorkspaceRestoreContext,
  validateCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {createServices, type JobRecord, type ServiceRow, type ServiceStore} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createWorkspaceBackup, verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {matchesRestoredExport} from '../packages/business/src/workspace-restore-exports.ts';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {timelineColourInputFilter} from '../packages/business/src/timeline-colour-lut.ts';
import {png, sha, imageColour, stamp, type ImageColourEvidence} from './helpers/timeline-image-fixtures.ts';
import {materializeHistoricalWorkspace} from './helpers/historical-workspace.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { Provider } from '@mioon/business/provider-registry';

const retainedTables = ['projects', 'assets', 'timelines', 'timeline_history',
  'timeline_history_cursors', 'timeline_requests', 'exports'];
const rawRows = (db: DatabaseSync) => Object.fromEntries(retainedTables.map(table => [table,
  db.prepare(`SELECT rowid AS retainedRowid, * FROM ${table} ORDER BY rowid`).all()]));

function assertRetainedRows(db: DatabaseSync, captured: Record<string,Record<string,import("node:sqlite").SQLOutputValue>[]>) {
  for (const [table, rows] of Object.entries(captured)) {
    for (const row of rows) {
      assert.deepEqual(db.prepare(`SELECT rowid AS retainedRowid, * FROM ${table} WHERE rowid=?`)
        .get(row.retainedRowid), row, `${table}: exact captured row ${row.retainedRowid}`);
    }
  }
}

async function assertSourceBytes(root: string, files: Map<unknown,Buffer<ArrayBufferLike>>) {
  for (const [relativePath, bytes] of files) {
    assert.deepEqual(await readFile(path.join(root, ((relativePath) as unknown as Parameters<typeof path.join>[1]))), bytes, ((relativePath) as unknown as Parameters<NonNullable<(typeof assert)["deepEqual"]>>[2]));
  }
}

async function executeQueued(store: FixtureStore, services: FixtureServices, accepted?: FixtureExport) {
  // The real local worker owns preparation, rendering, verification and publication.
  // No server, desktop runtime, provider or synthetic renderer is started.
  const worker = startWorker(store, services, new Map());
  try {
    await worker.tick();
    const completed = await services.call('export.get', {exportId: (accepted)!.id}) as FixtureExport;
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
    assert.deepEqual(completed.snapshot, (accepted)!.snapshot);
    const asset = store.get('assets', ((completed.assetId) as unknown as Parameters<NonNullable<(typeof store)["get"]>>[1]))!;
    const file = path.join(store.root, asset!.relativePath);
    assert.equal(sha(await readFile(file)), asset!.sha256);
    return {completed, persisted: (store.get('exports', completed.id)! as FixtureExport), asset, file};
  } finally {
    await worker.stop();
  }
}

async function decoded(file: string) {
  const chunks: (Buffer<ArrayBuffer>)[] = [];
  await runStreaming('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file,
    '-vf', `${timelineColourInputFilter('limited')},format=rgb24`, '-an',
    '-fps_mode', 'passthrough', '-threads', '1', '-f', 'rawvideo', 'pipe:1'], {
    timeout: 20000, maxStdoutBytes: 16 * 1024 * 1024,
    onStdout: chunk => chunks.push(Buffer.from(chunk)),
  });
  return Buffer.concat(chunks);
}

function assertMixedPixels(bytes: Buffer<ArrayBuffer>) {
  assert.equal(bytes.length, 6 * 720 * 720 * 3);
  const pixel = (frame: number, x: number, y: number) => {
    const start = (frame * 720 * 720 + y * 720 + x) * 3;
    return [...bytes.subarray(start, start + 3)];
  };
  const expected = .527924914041446 * (128 / 255) * 255;
  assert.ok(pixel(0, 400, 350).every(v => Math.abs(v - expected) < 4),
    'declared sRGB grey is transformed and straight-alpha composited over video');
  assert.ok(pixel(0, 215, 350).every(v => v < 4), 'hidden alpha-zero magenta does not leak');
  assert.ok(pixel(0, 185, 350).every(v => v < 4), 'image contain padding stays transparent');
  for (let frame = 0; frame < 6; frame++) {
    let white = 0;
    for (let y = 552; y < 672; y++) for (let x = 48; x < 672; x++) {
      if (pixel(frame, x, y).every(v => v > 220)) white++;
    }
    if (frame === 2 || frame === 3) assert.ok(white > 200, `subtitle present on frame ${frame}`);
    else assert.equal(white, 0, `subtitle absent on frame ${frame}`);
  }
}

test('cold backup32→restored33 explicitly rerenders mixed PNG/video/subtitle with exact decoded parity',
  {timeout: 120000}, async t => {
    const base = await mkdtemp(path.join(tmpdir(), 'mioon-image-restored-render-'));
    let source = path.join(base, 'source'), backup = path.join(base, 'backup');
    const restored = path.join(base, 'restored'), videoFile = path.join(base, 'video.mp4');
    let store!:FixtureStore|undefined, services!: FixtureServices|undefined;
    const close = async () => {
      await services?.drain();
      services = undefined;
      if (store?.db.isOpen) store.close();
      store = undefined;
    };
    t.after(async () => { await close(); await rm(base, {recursive: true, force: true}); });
    t.mock.method(globalThis, 'fetch', () => { throw Error('Network is forbidden in this local restore test'); });

    await run('ffmpeg', ['-v', 'error', '-threads', '1', '-f', 'lavfi', '-i',
      'color=black:s=64x64:r=30', '-frames:v', '6', '-an', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-color_range', 'tv', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
      videoFile], {timeout: 15000});
    const videoBytes = await readFile(videoFile);
    const imageBytes = png({width: 17, height: 19,
      pixel: x => x < 5 ? [255, 0, 255, 0] : [128, 128, 128, 128]});

    store = (openStore(source) as FixtureStore);
    services = (createServices(store, new Map()) as FixtureServices);
    const project = await services.call('project.create', {name: 'Cold mixed SDR rerender'});
    const projectId = project.id;
    let timeline = await services.call('timeline.format.set', {projectId,
      expectedProjectRevision: project.revision, expectedRevision: 0,
      requestId: randomUUID(), presetId: 'square_720'});
    const video = await services.call('asset.import', {projectId, name: 'Video.mp4',
      mimeType: 'video/mp4', dataBase64: videoBytes.toString('base64')});
    const image = await services.call('asset.import', {projectId, name: 'Still.png',
      mimeType: 'image/png', dataBase64: imageBytes.toString('base64')});
    const motion = await services.call('timeline.colour.source.inspect', {projectId, assetId: video.id});
    const picture = await services.call('timeline.colour.image.inspect', {projectId, assetId: image.id});
    assert.equal(motion.status, 'compatible');
    assert.equal(motion.evidence.range, 'limited');
    assert.equal(picture.status, 'compatible');
    const params = (extra: { assetId?: string; trackId?: string; startFrame?: number; durationFrames?: number; colour?: { profileId: string; source: { assetSha256: string; profileId: string; interpretation: string; declaredBy: string; declaredAt: string; evidence: ImageColourEvidence; }; look: unknown; }|{ profileId: string; source: { assetSha256: string; streamIndex: number|null; profileId: string; range: string; declaredBy: string; declaredAt: string; }; look: null; }; rect?: { x: number; y: number; width: number; height: number; }; text?: string; purpose?: string; }) => ({projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...extra});
    const videoColour = {profileId: 'mioon-rec709-sdr-clip-v1', source: {
      assetSha256: video.sha256, streamIndex: motion.streamIndex, profileId: 'rec709-yuv-sdr-v1',
      range: 'limited', declaredBy: 'user', declaredAt: stamp}, look: null};
    timeline = await services.call('timeline.clip.add', params({assetId: video.id,
      trackId: timeline.tracks[0].id, startFrame: 0, durationFrames: 6, colour: videoColour}));
    timeline = await services.call('timeline.clip.add', params({assetId: image.id,
      trackId: timeline.tracks[1].id, startFrame: 0, durationFrames: 6,
      rect: {x: 180, y: 180, width: 360, height: 360}, colour: imageColour(picture.evidence)}));
    timeline = await services.call('timeline.subtitle.add', params({text: 'Mixed SDR subtitle',
      startFrame: 2, durationFrames: 2}));

    const ordinary = await services.call('timeline.render', params({purpose: 'export'}));
    assert.equal((ordinary.snapshot.colourPlan)!.profileId, 'mioon-mixed-sdr-render-v2');
    const baseline = await executeQueued(store, services, ordinary);
    const ordinaryRgb = await decoded(baseline.file);
    assertMixedPixels(ordinaryRgb);
    // A second captured request remains genuinely queued. Restore must preserve it,
    // not resume it, while an independently acknowledged request may render.
    const held = await services.call('timeline.render', params({purpose: 'export'}));
    assert.deepEqual(held.snapshot, ordinary.snapshot);
    const heldRecord = (store.get('exports', held.id)! as FixtureExport);
    const captured = rawRows(store.db);
    const sourceFiles = new Map([[store.get('assets', video.id)!.relativePath, videoBytes],
      [store.get('assets', image.id)!.relativePath, imageBytes],
      [baseline!.asset.relativePath, await readFile(baseline.file)]]);
    await close();// Reviewed historical PNG-only fixture; never relabel or downgrade the current workspace.
    source = materializeHistoricalWorkspace({root: source}, path.join(base, 'source32'), {version: 32}).root;
    const coldDb = await readFile(path.join(source, 'workbench.sqlite'));

    const capturedBackup = await (createWorkspaceBackup({source, destination: backup}) as Promise<BackupResult>);
    assert.equal(capturedBackup.databaseSchemaVersion, 32);
    assert.equal(capturedBackup.integrity, 'verified');
    const verified = await (verifyWorkspaceBackup({directory: backup}) as Promise<BackupResult>);
    assert.equal(verified.databaseSchemaVersion, 32);
    assert.deepEqual(await readFile(path.join(backup, 'payload/workbench.sqlite')), coldDb);
    const installed = await (restoreWorkspaceBackup({directory: backup, destination: restored}) as Promise<RestoreResult>);
    assert.equal(installed.databaseSchemaVersion, 33);
    assert.equal(installed.sourceSchema, 32);
    assert.equal(installed.profile, 'restored-local-v5');

    store = (openStore(restored) as FixtureStore);
    services = (createServices(store, new Map()) as FixtureServices);
    const restoredInfo = validateCurrentWorkspaceRestoreSchema(store.db);
    assert.equal(restoredInfo.schemaVersion, 33);
    assert.equal(restoredInfo.sourceSchema, 32);
    assertRetainedRows(store.db, captured);
    await assertSourceBytes(restored, sourceFiles);
    assert.deepEqual(await services.call('timeline.get', {projectId}), timeline);
    assert.ok(store.db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(held.id));
    assert.equal(matchesRestoredExport(store, heldRecord!), false, 'captured queued export grants no execution authority');
    const context = {expectedWorkspaceOrigin: (getWorkspaceRestoreContext(store))!.workspaceOrigin};
    const request = params({purpose: 'export'});
    await assert.rejects(services.call('timeline.render', request), {code: 'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
    await assert.rejects(services.call('timeline.render', request, {expectedWorkspaceOrigin: randomUUID()}),
      {code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
    assert.equal(store.db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(request.requestId), undefined);
    const accepted = await services.call('timeline.render', request, context);
    assert.notEqual(accepted.id, held.id);
    assert.notEqual(accepted.requestId, held.requestId);
    assert.deepEqual(accepted.snapshot, held.snapshot);
    assert.deepEqual((store.get('exports', accepted.id)! as FixtureExport).snapshot, heldRecord!.snapshot);
    assert.equal(matchesRestoredExport(store, (store.get('exports', accepted.id)! as FixtureExport)), true);
    const binding = store.db.prepare('SELECT * FROM workspace_restore_export_origins WHERE exportId=?').get(accepted.id);
    assert.equal((binding)!.workspaceOrigin, context.expectedWorkspaceOrigin);
    assert.equal((binding)!.requestId, request.requestId);
    assert.deepEqual(validateCurrentWorkspaceRestoreSchema(store.db), restoredInfo, 'valid before actual rerender');

    const rerendered = await executeQueued(store, services, accepted);
    const restoredRgb = await decoded(rerendered.file);
    assert.deepEqual(restoredRgb, ordinaryRgb, 'decoded RGB is byte-identical after genuine cold restore');
    assertMixedPixels(restoredRgb);
    const stream = (await probe(rerendered.file)).probe.streams.find(s => s.codec_type === 'video');
    assert.equal((stream)!.width, 720);
    assert.equal((stream)!.height, 720);
    assert.equal(Number((stream)!.nb_frames), 6);
    for (const key of (['color_primaries', 'color_transfer', 'color_space'] as const)) assert.equal((stream)![key], 'bt709');
    assert.equal((stream)!.color_range, 'tv');
    assert.deepEqual((store.get('exports', held.id)! as FixtureExport), heldRecord, 'captured queued export never resumes or changes');
    assertRetainedRows(store.db, captured);
    await assertSourceBytes(restored, sourceFiles);
    assert.deepEqual(validateCurrentWorkspaceRestoreSchema(store.db), restoredInfo, 'valid after actual rerender');
    assert.equal((await readdir(path.join(restored, 'media'))).some(name =>
      name.startsWith('.timeline-render-') || name.endsWith('.part.mp4')), false);

    await close();
    store = (openStore(restored) as FixtureStore);
    assert.deepEqual(validateCurrentWorkspaceRestoreSchema(store.db), restoredInfo, 'valid after cold restored reopen');
    assertRetainedRows(store.db, captured);
    assert.deepEqual((store.get('exports', rerendered.completed.id)! as FixtureExport), rerendered.persisted);
    await assertSourceBytes(restored, sourceFiles);
    assert.deepEqual(await readFile(path.join(source, 'workbench.sqlite')), coldDb, 'ordinary database is untouched');
    assert.deepEqual(await readFile(path.join(backup, 'payload/workbench.sqlite')), coldDb, 'backup database is untouched');
    await assertSourceBytes(source, sourceFiles);
    t.diagnostic(`decoded RGB SHA-256: ${sha(restoredRgb)}; bytes: ${restoredRgb.length}; frames: 6; output: 720x720`);
    t.diagnostic(`ordinary MP4 SHA-256: ${baseline!.asset.sha256}; restored MP4 SHA-256: ${rerendered!.asset.sha256}`);
  });
