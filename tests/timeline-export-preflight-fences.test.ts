import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createAssetMediaServices} from '../packages/business/src/asset-media-services.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {applyFormat5ConversionInside} from '../packages/business/src/project-file/format5-conversion-store.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {prepareTrustedFormat5Conversion} from '../packages/business/src/project-file/format5-upgrade.ts';
import {FORMAT4_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectStore, registerProjectTransactionFence} from '../packages/business/src/project-file/store.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createTimelinePreflightServices} from '../packages/business/src/timeline-preflight.ts';
import {EXPORT_PREFLIGHT_LIMITS, exportPreflightResponseSchema} from '../packages/contracts/src/export-preflight.ts';
import type {SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';
import {DEFAULT_TIMELINE_OUTPUT_PRESET} from '../packages/contracts/src/timeline-output-geometry.ts';

async function fixture(t: test.TestContext, assetCount = 1) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-preflight-fences-'));
  let close: (() => Promise<void>) | undefined;
  t.after(async () => {
    try {await close?.();}
    finally {await rm(root, {recursive: true, force: true});}
  });
  const projectId = randomUUID();
  const store = createProjectStore({projectId, projectFile: path.join(root, 'project.mioon'),
    targetFormat: FORMAT4_PROJECT_SCHEMA_VERSION, format4: {},
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  close = async () => store.close();
  ensureProjectRow(store, {name: 'Cold preflight', timelinePresetId: DEFAULT_TIMELINE_OUTPUT_PRESET});
  const conversion = prepareTrustedFormat5Conversion(store);
  store.tx(() => applyFormat5ConversionInside(store, conversion));
  const project = store.get('projects', projectId) as Record<string, unknown>;
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  const application = createProjectServiceApplication(library, undefined, {});
  const services = createServices(store, new Map(), {application, env: {}});
  const preflights: ReturnType<typeof createTimelinePreflightServices>[] = [];
  close = async () => {
    try {
      await Promise.all(preflights.map(service => service.drain()));
      await services.drain();
    } finally {store.close(); library.close();}
  };
  const file = path.join(root, 'synthetic.mp4');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30:d=1',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads:v', '1', '-pix_fmt', 'yuv420p', file],
  {timeout: 30_000, maxStdoutBytes: 0, maxStderrBytes: 65_536});
  const bytes = await readFile(file), dataBase64 = bytes.toString('base64');
  async function apply(operation: string, intent: Record<string, unknown>) {
    const {envelope, planDigest} = await services.call(operation, {projectId, ...intent}) as {envelope: SequenceEditEnvelope; planDigest: string};
    const receipt = await services.call('sequence.action.commit', {projectId, envelope, expectedPlanDigest: planDigest}) as {status: string};
    assert.equal(receipt.status, 'applied');
  }
  await apply('sequence.board.edit', {kind: 'board-root-create', name: 'Synthetic sequence', position: {x: 0, y: 0}});
  const assetIds: string[] = [];
  for (let index = 0; index < assetCount; index++) {
    const asset = await services.call('asset.import', {projectId, name: `Take ${index + 1}.mp4`, mimeType: 'video/mp4', dataBase64}) as {id: string};
    assetIds.push(asset.id);
    await apply('sequence.timeline.edit', {kind: 'insert-asset', assetId: asset.id, trackId: null, startFrame: index * 30});
  }
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  assert.ok(timeline);
  assert.deepEqual(timeline.clips.map(clip => clip.assetId), assetIds);
  const expectedRevision = timeline.revision;
  const hashes = () => assetIds.map(assetId => store.db.prepare(`SELECT json_extract(data,'$.sha256') AS sha256 FROM project.assets WHERE id=?`)
    .get(assetId)?.sha256);
  assert.deepEqual(hashes(), assetIds.map(() => null));
  function preflight(options?: Parameters<typeof createTimelinePreflightServices>[1]) {
    const service = createTimelinePreflightServices(store, options);
    preflights.push(service);
    return async () => exportPreflightResponseSchema.parse(await service.handlers['timeline.export.preflight']({
      projectId, expectedRevision,
    }));
  }
  const media = createAssetMediaServices(store, {outsidePaths: application.outsidePaths});
  return {store, project, assetIds, hashes, preflight, prepareAsset: (assetId: string) => media.call('asset.media.prepare', {
    projectId, purpose: 'export', assets: [{assetId, referenceRevision: 1}],
  }), sizeBytes: bytes.length};
}

test('a sampled video only consumes its own bytes once in the cold preflight budget', async t => {
  const f = await fixture(t);
  const check = f.preflight({limits: {...EXPORT_PREFLIGHT_LIMITS, totalBytes: f.sizeBytes + Math.floor(f.sizeBytes / 2)}});
  const first = await check(), repeated = await check();
  assert.equal(first.status, 'ready', JSON.stringify(first));
  assert.equal(repeated.status, 'ready', JSON.stringify(repeated));
  assert.equal(first.snapshotHash, repeated.snapshotHash);
  assert.deepEqual(first.checks, {totalAssets: 1, checkedAssets: 1, bytesHashed: f.sizeBytes, fullDecode: false});
  assert.deepEqual(first.checks, repeated.checks);
});

test('preflight reports preparation while a referenced asset is undergoing full hash preparation', async t => {
  const f = await fixture(t);
  const check = f.preflight();
  // The operation starts synchronously and takes its first asynchronous file
  // read before yielding. The preflight runs in that same turn.
  const [preparing, pending] = await Promise.all([f.prepareAsset(f.assetIds[0]!), check()]);
  assert.ok(preparing);
  assert.equal(pending.status, 'incomplete', JSON.stringify(pending));
  assert.equal(pending.issues[0]?.code, 'PREFLIGHT_BUSY');
  assert.equal(pending.snapshotHash, null);
  const settled = await check();
  assert.equal(settled.status, 'ready', JSON.stringify(settled));
});

test('an independent content write between two hash commits makes preflight stale', async t => {
  const f = await fixture(t, 2);
  let wrote = false;
  const check = f.preflight({beforeEffect: () => {
    const [first, second] = f.hashes();
    if (!wrote && !f.store.db.isTransaction && typeof first === 'string' && second === null) {
      wrote = true;
      f.store.tx(() => f.store.put('projects', {...f.project, name: 'A concurrent rename', revision: 2}));
    }
  }});
  const result = await check();
  assert.ok(wrote);
  assert.equal(result.status, 'stale', JSON.stringify(result));
  assert.equal(result.issues[0]?.code, 'PREFLIGHT_STALE');
  assert.equal(result.snapshotHash, null);
  assert.equal((f.store.get('projects', f.store.projectId) as {name: string}).name, 'A concurrent rename');
  assert.equal(f.hashes()[1], null, 'only the first source may have committed its hash');
  assert.equal((await check()).status, 'ready');
});

test('a transaction fence change rolls back the current hash instead of hiding it behind a new stamp', async t => {
  const f = await fixture(t);
  const before = readProjectContentStamp(f.store.db);
  const check = f.preflight();
  const unregister = registerProjectTransactionFence(f.store.db, () => {
    f.store.put('projects', {...f.project, name: 'Fence change', revision: 2});
  });
  try {
    const result = await check();
    assert.equal(result.status, 'stale', JSON.stringify(result));
    assert.equal(result.issues[0]?.code, 'PREFLIGHT_STALE');
    assert.deepEqual(f.hashes(), [null]);
    assert.deepEqual(readProjectContentStamp(f.store.db), before);
  } finally {unregister();}
  assert.equal((await check()).status, 'ready');
});
