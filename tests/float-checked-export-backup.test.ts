import {CURRENT_RESTORED_SCHEMA} from './helpers/workspace-schema-current.ts';
import type {FixtureExport} from './helpers/strict-timeline-core-types.ts';
import type {BackupResult,RestoreResult} from './helpers/strict-timeline-backup-types.ts';
import type {TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
/** Actual cold backup/verification/offline restore gate. Synthetic small media
 * bytes are hash-checked and preserved; no renderer, worker or decoder runs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {openStore, getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createWorkspaceBackup, verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup, inspectWorkspaceRestorePublication} from '../packages/business/src/workspace-restore.ts';
import {isRestoredRecordHeld} from '../packages/business/src/workspace-restore-schema.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {claimFloatTimelineExport, bindFloatTimelineMeasurement} from '../packages/business/src/timeline-float-outcome.ts';
import {createTimelineFloatAudioAccumulator} from '../packages/business/src/timeline-float-audio-check.ts';
import {tree, logical, hash} from './helpers/workspace-restore-offline-fixture.ts';

const settings = {profileId: 'mp4_h264_float_checked_v2', resolution: 'short_360', rateControl: {mode: 'crf', quality: 'standard'}};
const domain = ['projects', 'assets', 'timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests', 'exports'];
const select = (db: DatabaseSync) => Object.fromEntries(domain.map(table => [table, db.prepare(`SELECT rowid AS oldRowid,* FROM "${table}" ORDER BY rowid`).all()]));
function measured(peak: number) {
  const checker = createTimelineFloatAudioAccumulator(3), bytes = Buffer.alloc(4800 * 8);
  for (let offset = 0; offset < bytes.length; offset += 4) bytes.writeFloatLE(peak, offset);
  checker.write(bytes); return checker.finish();
}

test('cold backup verify and offline restore preserve v2 queued failed succeeded raw reports and keep inherited work held', {timeout: 30_000}, async t => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-float-backup-'));
  const source = path.join(base, 'source'), backup = path.join(base, 'backup'), destination = path.join(base, 'restored');
  const media: (import("../packages/business/src/media-processes.ts").MediaProcessEvent)[] = [], off = onMediaProcess(event => media.push(event));
  t.after(() => {off(); fs.rmSync(base, {recursive: true, force: true});});
  const store = (openStore(source) as FixtureStore), services = (createServices(store, new Map(), {exportOptions: {
    inspect: async () => ({status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'}),
  }}) as FixtureServices);
  let project, frozenRows, originalTables; const renders = [], registered: ({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; relativePath: string; sha256: string; sizeBytes: number; width: number; height: number; duration: number; hasAudio: boolean; provenance: string; createdAt: string; } | { id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; relativePath: string; sha256: string; sizeBytes: number; width: number; height: number; duration: number; hasAudio: boolean; provenance: string; createdAt: string; url: string; })[] = [];
  try {
    project = await services.call('project.create', {name: 'Cold v2 preservation 🎬'});
    let timeline = await services.call('timeline.get', {projectId: project.id});
    const sourceBytes = Buffer.from('Synthetic source bytes for offline backup inventory; never decoded.'), sourceId = randomUUID(), relativePath = `media/${sourceId}.png`;
    const asset = {id: sourceId, projectId: project.id, name: 'Synthetic source', mimeType: 'image/png', relativePath,
      sha256: hash(sourceBytes), sizeBytes: sourceBytes.length, width: 16, height: 16, duration: 0, hasAudio: false, provenance: 'user-import', createdAt: new Date().toISOString()};
    fs.writeFileSync(path.join(source, relativePath), sourceBytes, {mode: 0o600, flag: 'wx'}); store.put('assets', asset); registered.push(asset);
    timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      trackId: timeline.tracks[0].id, assetId: sourceId, startFrame: 0, durationFrames: 3});
    for (const status of (['queued', 'failed', 'succeeded'] as const)) {
      const input:Record<string,unknown>&{projectId:string;expectedRevision:number;requestId:string} = {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export',
        exportSettings: structuredClone(settings), deliveryName: `Cold ${status} 🎬`};
      const accepted:FixtureExport = await services.call('timeline.render', input);
      if (status !== 'queued') {
        const claim = claimFloatTimelineExport((store.get('exports', accepted.id)! as FixtureExport), new Date().toISOString()); let output = null;
        if (status === 'succeeded') {
          const bytes = Buffer.from('Synthetic published media for offline hash-preservation only.'), id = randomUUID();
          const published = {id, projectId: project.id, name: 'Synthetic published export', mimeType: 'video/mp4',
            relativePath: `media/export-${accepted.id}-${randomUUID()}.mp4`, sha256: hash(bytes), sizeBytes: bytes.length,
            width: 360, height: 640, duration: 0.1, hasAudio: true, provenance: 'export', createdAt: new Date().toISOString(), url: `/media/${id}`};
          fs.writeFileSync(path.join(source, published.relativePath), bytes, {mode: 0o600, flag: 'wx'}); store.put('assets', published); registered.push(published);
          output = {assetId: id, sha256: published.sha256};
        }
        store.put('exports', {...claim, status, assetId: output?.assetId ?? null, url: output ? `/media/${output.assetId}` : null,
          audioCheck: bindFloatTimelineMeasurement(claim, measured(status === 'failed' ? 1.4 : 0.5), new Date().toISOString(), output),
          error: status === 'failed' ? {code: 'EXPORT_AUDIO_OVER_RANGE', message: 'Lower saved gains and request a new export.', retryable: false} : null});
      }
      const current:FixtureExport = (store.get('exports', accepted.id)! as FixtureExport); assert.equal(isTimelineRenderRecord(current, input), true);
      // Noncanonical whitespace stresses raw-byte preservation independently of
      // object equality. The immutable snapshot remains exactly the same value.
      const raw = ' \n' + JSON.stringify(current, null, '\t') + '\n ';
      store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(raw, accepted.id);
      const receipt = store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId);
      assert.equal(Object.hasOwn(JSON.parse((((receipt)!.response) as unknown as Parameters<typeof JSON.parse>[0])), 'audioCheck'), false);
      assert.equal(Object.hasOwn(JSON.parse((((receipt)!.response) as unknown as Parameters<typeof JSON.parse>[0])), 'renderAttemptId'), false);
      renders.push({input, accepted, status, raw, receipt, reportJson: current.audioCheck ? JSON.stringify(current.audioCheck) : null});
    }
    frozenRows = select(store.db); originalTables = logical(store.db);
  } finally {await services.drain(); store.close();}
  assert.deepEqual((media as unknown), []);
  const sourceBefore = tree(source), databaseBytes = fs.readFileSync(path.join(source, 'workbench.sqlite'));
  const created = await (createWorkspaceBackup({source, destination: backup}) as Promise<BackupResult>);
  assert.equal(created.integrity, 'verified'); assert.deepEqual(await (verifyWorkspaceBackup({directory: backup}) as Promise<BackupResult>), created);
  assert.equal(created.inventory.complete, false, 'queued work is retained unresolved, never presented as completed');
  assert.ok(created.inventory.issues.some((value: { code: string; }) => value.code === 'UNRESOLVED_TASK_RETAINED'));
  assert.equal(created.inventory.issues.some((value: { code: string; }) => ['INVALID_TASK_RECORD', 'MISSING_REGISTERED_MEDIA', 'REGISTERED_MEDIA_MISMATCH'].includes(value.code)), false);
  assert.deepEqual(fs.readFileSync(path.join(backup, 'payload/workbench.sqlite')), databaseBytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.entries.map((value: { path: unknown; }) => value.path).sort(), ['payload/workbench.sqlite', ...registered.map(value => `payload/${value.relativePath}`)].sort());
  for (const asset of registered) {
    const entry = manifest.entries.find((value: { path: string; }) => value.path === `payload/${asset.relativePath}`);
    assert.equal(entry.sha256, asset.sha256); assert.equal(entry.bytes, asset.sizeBytes);
  }
  assert.deepEqual(tree(source), sourceBefore); const backupBefore = tree(backup);
  const restored = await (restoreWorkspaceBackup({directory: backup, destination}) as Promise<RestoreResult>);
  assert.equal(restored.publication, 'confirmed'); assert.equal(restored.databaseSchemaVersion, CURRENT_RESTORED_SCHEMA);
  assert.equal(restored.heldCounts.exports, 3); assert.ok(restored.heldCounts.timeline_requests >= 3);
  assert.deepEqual(restored.inventory, created.inventory);
  assert.deepEqual(tree(source), sourceBefore); assert.deepEqual(tree(backup), backupBefore);
  const status = await inspectWorkspaceRestorePublication({directory: backup, destination});
  assert.equal(status.publication, 'observed_guarded'); assert.equal(status.workspaceOrigin, restored.workspaceOrigin);
  const db = new DatabaseSync(path.join(destination, 'workbench.sqlite'), {readOnly: true});
  try {
    assert.deepEqual(select(db), frozenRows);
    const after = logical(db);
    for (const [table, values] of Object.entries(originalTables)) {
      const actual = after[table].filter(value => table !== 'schema_version' || (value as {version?:number}).version !== CURRENT_RESTORED_SCHEMA).map(value => {
        const next = Object.assign(Object.create(Object.getPrototypeOf(value)), value);
        if (table === 'edit_tasks') delete next.executionEpoch; return next;
      });
      assert.deepEqual(actual, values, table);
    }
  } finally {db.close();}
  let restoredCapabilityChecks = 0;
  const reopened = (openStore(destination) as FixtureStore), restoredServices = (createServices(reopened, new Map(), {exportOptions: {
    inspect: async () => {restoredCapabilityChecks++; throw Error('Historical held replay must never probe capability');},
  }}) as FixtureServices);
  try {
    assert.equal((getWorkspaceRestoreContext(reopened))!.workspaceOrigin, restored.workspaceOrigin);
    const before = logical(reopened.db), writes = (reopened.db.prepare('SELECT total_changes() AS n').get())!.n;
    for (const value of renders) {
      assert.equal(isRestoredRecordHeld(reopened, 'exports', value.accepted.id), true);
      assert.equal(isRestoredRecordHeld(reopened, 'timeline_requests', value.input.requestId), true);
      const raw = (reopened.db.prepare('SELECT data FROM exports WHERE id=?').get(value.accepted.id))!.data;
      assert.equal(raw, value.raw); assert.equal(JSON.parse(raw).status, value.status);
      assert.equal(JSON.parse(raw).audioCheck ? JSON.stringify(JSON.parse(raw).audioCheck) : null, value.reportJson);
      assert.deepEqual(reopened.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(value.input.requestId), value.receipt);
      assert.throws(() => reopened.put('exports', {...JSON.parse(raw), status: 'running'}), /RESTORED_RECORD_HELD/);
      // A held export cannot execute, but its exact original queued receipt
      // remains readable. Historical replay must never create a local origin.
      const replay = await restoredServices.call('timeline.render', value.input, {expectedWorkspaceOrigin: restored.workspaceOrigin});
      assert.equal(JSON.stringify(replay), JSON.stringify(value.accepted));
    }
    assert.deepEqual(logical(reopened.db), before); assert.deepEqual(select(reopened.db), frozenRows);
    assert.equal((reopened.db.prepare('SELECT total_changes() AS n').get())!.n, writes); assert.equal(restoredCapabilityChecks, 0);
    assert.equal((reopened.db.prepare('SELECT count(*) AS n FROM workspace_restore_export_origins').get())!.n, 0);
  } finally {await restoredServices.drain(); reopened.close();}
  for (const asset of registered) assert.equal(hash(fs.readFileSync(path.join(destination, asset.relativePath))), asset.sha256);
  assert.deepEqual(tree(source), sourceBefore); assert.deepEqual(tree(backup), backupBefore); assert.deepEqual((media as unknown), []);
});
