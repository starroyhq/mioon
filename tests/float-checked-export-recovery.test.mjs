import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isTimelineRenderRecord, publicValue} from '@mioon/contracts';
import {isTimelineExportAudioOutcome} from '@mioon/contracts/timeline-export-float';
import {installCurrentWorkspaceRestoreSchema, openStore} from '../packages/business/src/db.mjs';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {startWorker} from '../packages/business/src/jobs.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {isRestoredRecordHeld} from '../packages/business/src/workspace-restore-schema.mjs';
import {matchesRestoredExport} from '../packages/business/src/workspace-restore-exports.mjs';
import {createTimelineFloatAudioAccumulator} from '../packages/business/src/timeline-float-audio-check.ts';
import {claimFloatTimelineExport, bindFloatTimelineMeasurement, bindFloatTimelineFailure, ownedFloatTimelineMeasurement,
  floatSnapshotSha256} from '../packages/business/src/timeline-float-outcome.ts';

const PROFILE = 'mp4_h264_float_checked_v2';
const settings = () => ({profileId: PROFILE, resolution: 'short_360', rateControl: {mode: 'crf', quality: 'standard'}});
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const rows = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
  .map(({name}) => [name, plain(db.prepare(`SELECT rowid AS __rowid__,* FROM "${name}" ORDER BY rowid`).all())]));
const badSnapshot = error => error.code === 'INVALID_TIMELINE_SNAPSHOT';
const receipt = (f, input) => f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId);

// Tiny explicit IEEE-float WAV generated in memory. The source is never clipped,
// normalized or replaced when a saved timeline gain is changed later.
function floatWav(value = 0.7, frames = 4800) {
  const bytes = Buffer.alloc(44 + frames * 8);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(384000, 28); bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 8, 40);
  for (let offset = 44; offset < bytes.length; offset += 4) bytes.writeFloatLE(value, offset);
  return bytes;
}
function measurement(peak = 0.5, frames = 3) {
  const accumulator = createTimelineFloatAudioAccumulator(frames), samples = Buffer.alloc(frames * 1600 * 8);
  for (let offset = 0; offset < samples.length; offset += 4) samples.writeFloatLE(peak, offset);
  accumulator.write(samples); return accumulator.finish();
}
async function fixture(t, {gain = 1} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-float-recovery-'));
  let store = openStore(root), checks = 0, inspect = async () => {checks++; return {status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'};};
  let services = createServices(store, new Map(), {exportOptions: {inspect: (...args) => inspect(...args)}});
  const f = {root, get store() {return store;}, get services() {return services;}, get checks() {return checks;},
    input: (extra = {}) => ({projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(), purpose: 'export', exportSettings: settings(), ...extra}),
    setInspect: fn => {inspect = fn;}, state: () => rows(store.db),
    async restart({restore = false} = {}) {
      await services.drain(); store.close();
      if (restore) {
        const metadata = {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(), manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: new Date().toISOString()};
        const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
        try {installCurrentWorkspaceRestoreSchema(db, metadata); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');} finally {db.close();}
        f.context = {expectedWorkspaceOrigin: metadata.workspaceOrigin};
      }
      store = openStore(root); services = createServices(store, new Map(), {exportOptions: {inspect: (...args) => inspect(...args)}});
    },
  };
  t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  f.project = await services.call('project.create', {name: 'Float recovery 🎬'});
  f.timeline = await services.call('timeline.get', {projectId: f.project.id});
  f.timeline = await services.call('timeline.track.add', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(), kind: 'audio'});
  const bytes = floatWav(), id = randomUUID(), relativePath = `media/${id}.wav`;
  await writeFile(path.join(root, relativePath), bytes, {mode: 0o600, flag: 'wx'});
  f.asset = store.put('assets', {id, projectId: f.project.id, name: 'Owned float WAV', mimeType: 'audio/wav', sha256: sha(bytes), relativePath,
    width: 0, height: 0, duration: 0.1, hasAudio: true, sizeBytes: bytes.length, provenance: 'user-import', createdAt: new Date().toISOString()});
  f.timeline = await services.call('timeline.clip.add', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(),
    trackId: f.timeline.tracks.find(track => track.kind === 'audio').id, assetId: id, startFrame: 0, durationFrames: 3, gain});
  return f;
}
async function tick(f, observe) {
  const events = [], off = onMediaProcess(event => {events.push(event); observe?.(event);}), worker = startWorker(f.store, f.services, new Map());
  try {await worker.tick();} finally {off(); await worker.stop();}
  return events;
}
function terminal(f, accepted, peak = 1.4, {success = false} = {}) {
  const claim = claimFloatTimelineExport(f.store.get('exports', accepted.id), new Date().toISOString());
  let output = null;
  if (success) {
    const id = randomUUID(), asset = {id, projectId: f.project.id, name: 'Synthetic existing output', mimeType: 'video/mp4',
      relativePath: `media/export-${accepted.id}-${randomUUID()}.mp4`, sha256: 'b'.repeat(64), sizeBytes: 20,
      width: 360, height: 640, duration: 0.1, hasAudio: true, provenance: 'export', createdAt: new Date().toISOString(), url: `/media/${id}`};
    f.store.put('assets', asset); output = {assetId: id, sha256: asset.sha256};
  }
  const report = bindFloatTimelineMeasurement(claim, measurement(peak), new Date().toISOString(), output);
  return f.store.put('exports', {...claim, status: success ? 'succeeded' : 'failed', assetId: output?.assetId ?? null,
    url: output ? `/media/${output.assetId}` : null, audioCheck: report,
    error: success ? null : {code: 'EXPORT_AUDIO_OVER_RANGE', message: 'Lower the saved gains and request a new export.', retryable: false}});
}


async function storyboardFixture(f, projectId) {
  const shot = await f.services.call('shot.create', {projectId, requestId: randomUUID(), title: 'Synthetic storyboard'});
  const jobId = randomUUID(), versionId = randomUUID(), assetId = randomUUID(), createdAt = new Date().toISOString();
  f.store.put('assets', {id: assetId, projectId, name: 'Missing synthetic source', mimeType: 'video/mp4',
    relativePath: `media/${assetId}.mp4`, sha256: 'e'.repeat(64), sizeBytes: 20, width: 720, height: 1280,
    duration: 0.1, hasAudio: true, provenance: 'synthetic-mock', createdAt});
  f.store.put('jobs', {id: jobId, projectId, shotId: shot.id, versionId, status: 'succeeded'});
  f.store.put('versions', {id: versionId, projectId, jobId, shotId: shot.id, assetId, sha256: 'e'.repeat(64), createdAt});
  f.store.put('shots', {...shot, selectedVersionId: versionId});
}

test('storyboard and float timeline request keys remain separate in both orders and across projects', async t => {
  for (const crossProject of [false, true]) for (const timelineFirst of [false, true]) {
    await t.test(`crossProject=${crossProject}, timelineFirst=${timelineFirst}`, async t => {
      const f = await fixture(t), projectId = crossProject
        ? (await f.services.call('project.create', {name: 'Independent storyboard owner'})).id : f.project.id;
      await f.services.call('timeline.get', {projectId});
      await storyboardFixture(f, projectId);
      const requestId = randomUUID(), input = f.input({requestId}), legacyInput = {projectId, requestId};
      let legacy, accepted;
      if (timelineFirst) {
        accepted = await f.services.call('timeline.render', input);
        legacy = await f.services.call('export.create', legacyInput);
      } else {
        legacy = await f.services.call('export.create', legacyInput);
        accepted = await f.services.call('timeline.render', input);
      }
      assert.notEqual(legacy.id, accepted.id); assert.equal(legacy.requestId, accepted.requestId);
      const saved = receipt(f, input), legacyReceipt = plain(f.store.db.prepare("SELECT * FROM idempotency WHERE scope='export' AND requestId=?").get(requestId));
      terminal(f, accepted);
      const outputId = randomUUID();
      f.store.put('assets', {id: outputId, projectId, name: 'Historical storyboard output', mimeType: 'video/mp4',
        relativePath: `media/export-${legacy.id}-${randomUUID()}.mp4`, sha256: 'a'.repeat(64), sizeBytes: 20,
        width: 720, height: 1280, duration: 0.1, hasAudio: true, provenance: 'export', createdAt: new Date().toISOString()});
      for (const status of ['queued', 'succeeded', 'failed']) {
        const current = {...legacy, status, assetId: status === 'succeeded' ? outputId : null,
          url: status === 'succeeded' ? `/media/${outputId}` : null, error: status === 'failed' ? {code: 'SYNTHETIC_FAILURE', message: 'Known failure', retryable: false} : null};
        f.store.put('exports', current);
        f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify(current, null, 2), legacy.id);
        const before = f.state();
        assert.deepEqual(await f.services.call('export.get', {exportId: legacy.id}), publicValue(current));
        assert.deepEqual(await f.services.call('export.create', legacyInput), current, 'legacy replay retains its existing current-record semantics');
        assert.deepEqual(await f.services.call('timeline.render', input), accepted, 'timeline replay remains its exact queued ACK');
        await f.services.call('project.get', {projectId});
        await f.services.call('project.get', {projectId: f.project.id});
        assert.deepEqual(f.state(), before, 'reading/replaying either namespace cannot mutate either record');
      }
      await f.restart();
      assert.equal((await f.services.call('export.get', {exportId: legacy.id})).status, 'failed');
      assert.deepEqual(receipt(f, input), saved);
      assert.deepEqual(plain(f.store.db.prepare("SELECT * FROM idempotency WHERE scope='export' AND requestId=?").get(requestId)), legacyReceipt);
      // A same-key receipt mismatch is not a generic legacy exemption: the
      // independent old receipt must still prove this project/request/resource.
      const originalLegacyRow = f.store.db.prepare('SELECT * FROM exports WHERE id=?').get(legacy.id);
      for (const change of [
        () => f.store.db.prepare("UPDATE idempotency SET requestHash=? WHERE scope='export' AND requestId=?").run('f'.repeat(64), requestId),
        () => f.store.db.prepare("UPDATE idempotency SET resourceId=? WHERE scope='export' AND requestId=?").run(randomUUID(), requestId),
        () => f.store.db.prepare("UPDATE idempotency SET scope='unrelated' WHERE scope='export' AND requestId=?").run(requestId),
        () => f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify({...f.store.get('exports', legacy.id), projectId: randomUUID()}), legacy.id),
      ]) {
        change(); const before = f.state();
        await assert.rejects(f.services.call('export.get', {exportId: legacy.id}), badSnapshot);
        assert.deepEqual(f.state(), before);
        f.store.db.prepare('DELETE FROM idempotency WHERE requestId=?').run(requestId);
        f.store.db.prepare('INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES(?,?,?,?)')
          .run(legacyReceipt.scope, legacyReceipt.requestId, legacyReceipt.requestHash, legacyReceipt.resourceId);
        f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(originalLegacyRow.data, legacy.id);
      }
      const float = f.store.get('exports', accepted.id);
      f.store.put('exports', {...float, renderAttemptId: randomUUID()});
      await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot, 'stale float report still fails closed');
      assert.equal((await f.services.call('export.get', {exportId: legacy.id})).status, 'failed', 'unrelated legacy record is not a float-report authority');
      f.store.put('exports', float);
      f.store.put('exports', {...legacy, status: 'running'});
      const writes = [], put = f.store.put;
      f.store.put = (table, value) => {if (table === 'exports' && value.id === legacy.id) writes.push(value.status); return put(table, value);};
      try {await tick(f);} finally {f.store.put = put;}
      assert.deepEqual(writes, ['queued', 'running', 'failed'], 'legacy worker recovery/dispatch remains eligible; deliberately missing source fails normally');
      assert.equal(f.store.get('exports', legacy.id).error.code, 'ENOENT');
      assert.deepEqual(receipt(f, input), saved);
      assert.equal(f.store.list('exports').length, 2);
    });
  }
});

test('a stripped float row cannot borrow a real storyboard row and its receipt, even with an exact copied payload', async t => {
  for (const restored of [false, true]) for (const crossProject of [false, true]) for (const exactCopy of [false, true]) {
    await t.test(`restored=${restored}, crossProject=${crossProject}, exactCopy=${exactCopy}`, async t => {
      const f = await fixture(t), projectId = crossProject
        ? (await f.services.call('project.create', {name: 'Different storyboard owner'})).id : f.project.id;
      await f.services.call('timeline.get', {projectId}); await storyboardFixture(f, projectId);
      const input = f.input(), accepted = await f.services.call('timeline.render', input);
      const legacy = await f.services.call('export.create', {projectId, requestId: input.requestId});
      if (restored) {
        await f.restart({restore: true});
        const before = f.state();
        assert.deepEqual(await f.services.call('export.get', {exportId: legacy.id}), publicValue(legacy));
        assert.deepEqual(await f.services.call('export.get', {exportId: accepted.id}), publicValue(accepted));
        assert.deepEqual(await f.services.call('timeline.render', input), publicValue(accepted));
        assert.deepEqual(await f.services.call('export.create', {projectId, requestId: input.requestId}), publicValue(legacy));
        assert.deepEqual(f.state(), before, 'held reads/replays do not execute or rewrite either namespace');
        // Explicit raw-DB corruption fixture, not an application bypass. The
        // original captured material and receipts remain unchanged.
        f.store.db.exec('DROP TRIGGER restore_hold_exports_update');
      }
      f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');
      const forged = {...legacy, ...(exactCopy ? {} : {status: 'failed', error: {code: 'FORGED', message: 'Different payload', retryable: false}})};
      f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify(forged), accepted.id);
      const before = f.state();
      await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
      await assert.rejects(f.services.call('project.get', {projectId: f.project.id}), badSnapshot);
      assert.deepEqual(await f.services.call('export.get', {exportId: legacy.id}), publicValue(legacy));
      assert.deepEqual(f.state(), before);
    });
  }
});

test('pristine 140fa882 omitted and v1 golden receipts, snapshots, histories and rows survive open/read/replay byte-exact', async t => {
  const bytes = await readFile(new URL('./fixtures/float-checked-export-legacy-140fa882.json', import.meta.url));
  assert.equal(sha(bytes), 'fafe232360d51726403dfbe67bc18341c9f29d7fce65b12c243156bbc81a36c2');
  const baseline = JSON.parse(bytes), root = await mkdtemp(path.join(tmpdir(), 'mioon-float-old-golden-'));
  let store, services;
  t.after(async () => {await services?.drain(); store?.close(); await rm(root, {recursive: true, force: true});});
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;'); initializeWorkspaceSchemaThrough24(db);
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  try {
    for (const [table, values] of Object.entries(baseline.tables)) {
      db.prepare(`DELETE FROM "${table}"`).run();
      for (const value of values) {
        const keys = Object.keys(value).filter(key => key !== '__rowid__');
        db.prepare(`INSERT INTO "${table}"(rowid,${keys.map(key => `"${key}"`).join(',')}) VALUES(${Array(keys.length + 1).fill('?').join(',')})`)
          .run(value.__rowid__, ...keys.map(key => value[key]));
      }
    }
    db.exec('DELETE FROM sqlite_sequence;');
    for (const value of baseline.sequence) db.prepare('INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,?,?)').run(value.__rowid__, value.name, value.seq);
    db.exec('COMMIT; PRAGMA foreign_keys=ON;');
  } catch (error) {if (db.isTransaction) db.exec('ROLLBACK'); throw error;}
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  await mkdir(path.dirname(path.join(root, baseline.media.relativePath)), {recursive: true, mode: 0o700});
  await writeFile(path.join(root, baseline.media.relativePath), Buffer.from(baseline.media.base64, 'base64'));
  const before = rows(db); db.close(); store = openStore(root);
  // The frozen24 rows remain byte-exact; startup contributes only marker26.
  const expected = {...before, schema_version: [...before.schema_version, {__rowid__: 26, version: 26}]};
  services = createServices(store, new Map(), {exportOptions: {inspect: async () => {throw Error('Old replay must not probe');}}});
  assert.deepEqual(rows(store.db), expected);
  for (const render of baseline.renders) {
    const input = JSON.parse(render.inputJson), expected = JSON.parse(render.responseJson);
    assert.equal(JSON.stringify(await services.call('timeline.render', input)), render.responseJson);
    assert.equal(isTimelineRenderRecord(expected, input), true);
    assert.equal(JSON.stringify(await services.call('export.get', {exportId: render.exportId})), render.responseJson);
    for (const field of ['audioCheck', 'renderAttemptId']) assert.equal(Object.hasOwn(expected, field), false);
    assert.equal(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(render.requestId).response,
      baseline.tables.timeline_requests.find(value => value.requestId === render.requestId).response);
  }
  await services.call('project.get', {projectId: baseline.projectId}); assert.deepEqual(rows(store.db), expected);
});

test('failed v2 current report never enters immutable ACK; exact replay precedes changed capability/revision after restart', async t => {
  const f = await fixture(t), input = f.input({deliveryName: 'Explicit float'}), accepted = await f.services.call('timeline.render', input);
  const wire = JSON.stringify(accepted), saved = receipt(f, input), failed = terminal(f, accepted);
  assert.equal(isTimelineRenderRecord(publicValue(failed), input), true);
  assert.equal(failed.audioCheck.snapshotSha256, floatSnapshotSha256(failed.snapshot));
  f.timeline = await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(), clipId: f.timeline.clips[0].id, patch: {gain: 0.5}});
  f.setInspect(async () => {throw Error('Historical replay must bypass capability');}); await f.restart();
  const before = f.state(); assert.equal(JSON.stringify(await f.services.call('timeline.render', input)), wire);
  assert.deepEqual(await f.services.call('export.get', {exportId: accepted.id}), publicValue(failed));
  assert.deepEqual(receipt(f, input), saved); assert.deepEqual(f.state(), before);
  await assert.rejects(f.services.call('timeline.render', {...input, exportSettings: {...settings(), profileId: 'mp4_h264_v1'}}), {code: 'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.store.list('exports').length, 1);
});

test('server-only outcome adapter rejects unowned measured JSON and errors that self-assert audio authority', async t => {
  const f = await fixture(t), accepted = await f.services.call('timeline.render', f.input()), claim = claimFloatTimelineExport(f.store.get('exports', accepted.id), new Date().toISOString());
  const measured = measurement();
  assert.throws(() => bindFloatTimelineMeasurement(claim, structuredClone(measured), new Date().toISOString()), badSnapshot);
  assert.throws(() => ownedFloatTimelineMeasurement({audioCheck: structuredClone(measured)}), badSnapshot);
  assert.equal(bindFloatTimelineFailure(claim, Object.assign(Error('Forged'), {code: 'EXPORT_AUDIO_OVER_RANGE', audioCheck: measured, measurement: measured}), new Date().toISOString()), undefined);
  const bound = bindFloatTimelineMeasurement(claim, measured, new Date().toISOString());
  assert.equal(bound.attemptId, claim.renderAttemptId); assert.equal(bound.output, null);
  assert.equal(Object.hasOwn(accepted, 'renderAttemptId'), false); assert.equal(Object.hasOwn(accepted, 'audioCheck'), false);
});

test('v2 current export and project readers reject foreign attempt, snapshot, report/output hash and stripped profile', async t => {
  const f = await fixture(t), input = f.input(), accepted = await f.services.call('timeline.render', input), succeeded = terminal(f, accepted, 0.5, {success: true});
  assert.deepEqual(await f.services.call('export.get', {exportId: accepted.id}), publicValue(succeeded));
  const original = f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id).data, asset = f.store.get('assets', succeeded.assetId);
  for (const mutate of [value => {value.requestId = randomUUID();}, value => {value.renderAttemptId = randomUUID();}, value => {value.audioCheck.attemptId = randomUUID();},
    value => {value.audioCheck.projectId = randomUUID();}, value => {value.audioCheck.exportId = randomUUID();},
    value => {value.audioCheck.snapshotSha256 = 'c'.repeat(64);}, value => {value.audioCheck.output.sha256 = 'c'.repeat(64);},
    value => {value.audioCheck.output.assetId = randomUUID();}, value => {value.audioCheck.outputFrames++;},
    value => {delete value.audioCheck;}, value => {value.audioCheck.path = '/private/source';}]) {
    const changed = structuredClone(succeeded); mutate(changed); f.store.put('exports', changed);
    const before = f.state();
    await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
    await assert.rejects(f.services.call('project.get', {projectId: f.project.id}), badSnapshot);
    assert.deepEqual(f.state(), before); f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(original, accepted.id);
  }
  f.store.put('assets', {...asset, sha256: 'd'.repeat(64)});
  await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot); f.store.put('assets', asset);
  f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');
  for (const patch of [{mode: 'storyboard'}, {purpose: 'preview'}]) {
    f.store.put('exports', {...succeeded, ...patch});
    await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
    f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(original, accepted.id);
  }
  const stripped = structuredClone(succeeded); delete stripped.snapshot.delivery; delete stripped.audioCheck; delete stripped.renderAttemptId;
  f.store.put('exports', stripped);
  await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
  await assert.rejects(f.services.call('project.get', {projectId: f.project.id}), badSnapshot);
  assert.equal(receipt(f, input).response.includes('audioCheck'), false);
  const forgedId = randomUUID();
  f.store.put('exports', {...stripped, id: forgedId});
  await assert.rejects(f.services.call('export.get', {exportId: forgedId}), badSnapshot,
    'a different ID cannot exempt stripped v2 without a bound legacy export receipt');
  f.store.db.prepare('DELETE FROM exports WHERE id=?').run(forgedId);

  const other = await f.services.call('project.create', {name: 'Different relational owner'});
  await f.services.call('timeline.get', {projectId: other.id});
  const changedOwner = {...stripped, projectId: other.id};
  f.store.db.prepare('UPDATE exports SET projectId=?,data=? WHERE id=?').run(other.id, JSON.stringify(changedOwner), accepted.id);
  const before = f.state();
  await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot,
    'matching export identity still detects stripped v2 when its relational and JSON project were changed');
  await assert.rejects(f.services.call('project.get', {projectId: other.id}), badSnapshot);
  assert.deepEqual(f.state(), before);
});

test('worker restart removes interrupted v2 attempt without rewriting its receipt and the next attempt remeasures', {timeout: 60_000}, async t => {
  const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  const abandoned = claimFloatTimelineExport(f.store.get('exports', accepted.id), new Date().toISOString()); f.store.put('exports', abandoned);
  await f.restart();
  // startWorker immediately auto-ticks after constructor recovery. Capture the
  // exact writes to observe clearing before its next synchronous running claim.
  const writes = [], put = f.store.put;
  f.store.put = (table, value) => {if (table === 'exports' && value.id === accepted.id) writes.push(structuredClone(value)); return put(table, value);};
  const worker = startWorker(f.store, f.services, new Map());
  try {
    const queued = writes[0]; assert.equal(queued.status, 'queued');
    assert.equal(Object.hasOwn(queued, 'renderAttemptId'), false); assert.equal(Object.hasOwn(queued, 'audioCheck'), false);
    assert.equal(writes[1].status, 'running'); assert.notEqual(writes[1].renderAttemptId, abandoned.renderAttemptId);
    await worker.tick();
  } finally {await worker.stop(); f.store.put = put;}
  const result = f.store.get('exports', accepted.id); assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
  assert.notEqual(result.renderAttemptId, abandoned.renderAttemptId); assert.equal(result.audioCheck.attemptId, result.renderAttemptId);
  assert.equal(result.audioCheck.measurement.sampleFrames, 4800); assert.deepEqual(receipt(f, input), saved);
  assert.deepEqual(await f.services.call('timeline.render', input), accepted);
});

test('replaced attempt or newer completed outcome cannot receive an old worker report or publication', {timeout: 60_000}, async t => {
  for (const state of ['running', 'failed', 'succeeded']) await t.test(state, async t => {
    const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
    let replacement;
    const events = await tick(f, event => {
      if (replacement || event.type !== 'exited' || event.kind !== 'ffprobe') return;
      const current = f.store.get('exports', accepted.id);
      assert.equal(current.status, 'running'); assert.ok(current.renderAttemptId);
      const newer = {...current, renderAttemptId: randomUUID(), status: state};
      // A terminal replacement is a race fixture, never a production publication.
      // The old worker has no authority to repair or overwrite these bytes.
      if (state === 'failed') newer.error = {code: 'NEWER_ATTEMPT_FAILED', message: 'Newer result', retryable: false};
      f.store.put('exports', newer); replacement = f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id).data;
    });
    assert.ok(replacement); assert.equal(f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id).data, replacement);
    assert.equal(events.some(event => event.type === 'started' && event.kind === 'ffmpeg'), false);
    assert.equal(f.store.list('assets').some(asset => asset.provenance === 'export'), false);
    assert.deepEqual(receipt(f, input), saved); assert.equal(Object.hasOwn(f.store.get('exports', accepted.id), 'audioCheck'), false);
  });
});

test('real overrange v2 fails with one stored report and no final asset; explicit saved gain edit and new key succeeds', {timeout: 90_000}, async t => {
  const f = await fixture(t, {gain: 2}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  const source = await readFile(path.join(f.root, f.asset.relativePath)), timelineBytes = JSON.stringify(f.timeline);
  await tick(f);
  const failed = f.store.get('exports', accepted.id);
  assert.equal(failed.status, 'failed', JSON.stringify(failed.error)); assert.equal(failed.error.code, 'EXPORT_AUDIO_OVER_RANGE'); assert.equal(failed.error.retryable, false);
  assert.equal(failed.audioCheck.status, 'complete'); assert.equal(failed.audioCheck.code, 'EXPORT_AUDIO_OVER_RANGE');
  assert.ok(failed.audioCheck.measurement.peakLinear > 1.39 && failed.audioCheck.measurement.peakLinear < 1.41);
  assert.equal(failed.audioCheck.measurement.sampleFrames, 4800); assert.equal(failed.audioCheck.output, null);
  assert.equal(failed.assetId, null); assert.equal(failed.url, null); assert.equal(f.store.list('assets').some(asset => asset.provenance === 'export'), false);
  assert.equal((await readdir(path.join(f.root, 'media'))).some(name => name.startsWith('export-')), false);
  assert.equal(JSON.stringify(f.store.get('timelines', f.timeline.id)), timelineBytes);
  assert.deepEqual(receipt(f, input), saved); assert.deepEqual(await f.services.call('timeline.render', input), accepted);
  await f.restart(); assert.equal(f.store.get('exports', accepted.id).status, 'failed');
  const before = f.state(); await tick(f); assert.deepEqual(f.state(), before, 'failure/restart never retries automatically');
  f.timeline = await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(), clipId: f.timeline.clips[0].id, patch: {gain: 0.5}});
  const freshInput = f.input(), fresh = await f.services.call('timeline.render', freshInput); await tick(f);
  const succeeded = f.store.get('exports', fresh.id), output = f.store.get('assets', succeeded.assetId);
  assert.equal(succeeded.status, 'succeeded', JSON.stringify(succeeded.error));
  assert.equal(succeeded.audioCheck.code, 'EXPORT_AUDIO_WITHIN_LIMIT'); assert.ok(succeeded.audioCheck.measurement.peakLinear <= 1);
  assert.deepEqual(succeeded.audioCheck.output, {assetId: output.id, sha256: output.sha256});
  assert.equal(isTimelineExportAudioOutcome(succeeded, {snapshotSha256: floatSnapshotSha256(succeeded.snapshot), assetSha256: output.sha256}), true);
  assert.notEqual(succeeded.renderAttemptId, failed.renderAttemptId); assert.equal(f.store.list('exports').length, 2);
  assert.equal(sha(await readFile(path.join(f.root, f.asset.relativePath))), sha(source));
  assert.deepEqual(receipt(f, input), saved); assert.deepEqual(await f.services.call('timeline.render', input), accepted);
  await f.restart(); assert.deepEqual(await f.services.call('export.get', {exportId: fresh.id}), publicValue(succeeded));
});

test('restored inherited v2 queued/failed/succeeded rows stay held byte-exact while a new origin-bound local v2 succeeds', {timeout: 60_000}, async t => {
  const f = await fixture(t, {gain: 0.5}), held = [];
  for (const status of ['queued', 'failed', 'succeeded']) {
    const input = f.input(), accepted = await f.services.call('timeline.render', input);
    if (status !== 'queued') terminal(f, accepted, status === 'failed' ? 1.4 : 0.5, {success: status === 'succeeded'});
    held.push({input, id: accepted.id, raw: f.store.db.prepare('SELECT * FROM exports WHERE id=?').get(accepted.id), receipt: receipt(f, input)});
  }
  await f.restart({restore: true});
  for (const value of held) assert.equal(isRestoredRecordHeld(f.store, 'exports', value.id), true);
  const input = f.input(), accepted = await f.services.call('timeline.render', input, f.context);
  assert.equal(matchesRestoredExport(f.store, f.store.get('exports', accepted.id)), true);
  await tick(f); const succeeded = f.store.get('exports', accepted.id);
  assert.equal(succeeded.status, 'succeeded', JSON.stringify(succeeded.error)); assert.equal(succeeded.audioCheck.code, 'EXPORT_AUDIO_WITHIN_LIMIT');
  assert.equal(matchesRestoredExport(f.store, succeeded), true);
  for (const value of held) {
    assert.deepEqual(f.store.db.prepare('SELECT * FROM exports WHERE id=?').get(value.id), value.raw);
    assert.deepEqual(receipt(f, value.input), value.receipt);
  }
});

test('v2 read guards fail closed for malformed relational identities and corrupted immutable receipt fields', async t => {
  for (const target of ['row id', 'row project', 'foreign row project', 'row request', 'row request malformed', 'receipt status', 'receipt attempt', 'receipt hash', 'receipt JSON']) await t.test(target, async t => {
    const f = await fixture(t), input = f.input(), accepted = await f.services.call('timeline.render', input), failed = terminal(f, accepted), db = f.store.db;
    db.exec('DROP TRIGGER immutable_timeline_render_snapshot; DROP TRIGGER immutable_timeline_responses;');
    if (target.startsWith('row') || target === 'foreign row project') {
      const changed = structuredClone(failed);
      if (target === 'row id') changed.id = 'malformed-id';
      else if (target === 'row project') changed.projectId = null;
      else if (target === 'foreign row project') changed.projectId = randomUUID();
      else if (target === 'row request malformed') changed.requestId = {untrusted: true};
      else changed.requestId = randomUUID();
      db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify(changed), accepted.id);
    } else {
      const saved = receipt(f, input), changed = JSON.parse(saved.response);
      if (target === 'receipt hash') db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run('not-a-hash', input.requestId);
      else if (target === 'receipt JSON') db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run('{', input.requestId);
      else {
        if (target === 'receipt status') changed.status = 'failed';
        else changed.renderAttemptId = randomUUID();
        db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(changed), input.requestId);
      }
    }
    const before = f.state();
    await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
    await assert.rejects(f.services.call('project.get', {projectId: f.project.id}), badSnapshot);
    assert.deepEqual(f.state(), before);
  });
});

function renderConcatPhase(root) {
  const directory = path.join(root, 'media');
  return readdirSync(directory).some(name => name.startsWith('.timeline-render-') && existsSync(path.join(directory, name, 'segments.txt')));
}

test('late replacement after float measurement cannot publish the old attempt report or overwrite a newer failure', {timeout: 60_000}, async t => {
  const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  let concatStarts = 0, replacement;
  await tick(f, event => {
    if (event.type !== 'started' || event.kind !== 'ffmpeg' || !renderConcatPhase(f.root) || ++concatStarts !== 2) return;
    // The first render-owned concat process measures float PCM. The second
    // starts final AAC, so the entire sample check has already completed.
    const current = f.store.get('exports', accepted.id);
    f.store.put('exports', {...current, renderAttemptId: randomUUID(), status: 'failed',
      error: {code: 'NEWER_ATTEMPT_FAILED', message: 'Newer outcome owns this row', retryable: false}});
    replacement = f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id).data;
  });
  assert.equal(concatStarts, 2); assert.ok(replacement);
  assert.equal(f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id).data, replacement);
  assert.equal(Object.hasOwn(f.store.get('exports', accepted.id), 'audioCheck'), false);
  assert.equal(f.store.list('assets').some(asset => asset.provenance === 'export'), false); assert.deepEqual(receipt(f, input), saved);
  assert.equal((await readdir(path.join(f.root, 'media'))).some(name => name.startsWith('export-')), false);
});

test('cancellation after a complete float check requeues without token/report and cleans the exact owned part', {timeout: 60_000}, async t => {
  const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  const controller = new AbortController(); let concatStarts = 0, attempt;
  const off = onMediaProcess(event => {
    if (event.type !== 'started' || event.kind !== 'ffmpeg' || !renderConcatPhase(f.root) || ++concatStarts !== 2) return;
    attempt = f.store.get('exports', accepted.id).renderAttemptId; controller.abort();
  }), worker = startWorker(f.store, f.services, new Map(), {signal: controller.signal});
  try {await worker.tick();} finally {off(); await worker.stop();}
  assert.equal(concatStarts, 2); assert.ok(attempt);
  const queued = f.store.get('exports', accepted.id); assert.equal(queued.status, 'queued');
  assert.equal(Object.hasOwn(queued, 'renderAttemptId'), false); assert.equal(Object.hasOwn(queued, 'audioCheck'), false);
  assert.equal(queued.assetId, null); assert.equal(queued.url, null); assert.deepEqual(receipt(f, input), saved);
  assert.deepEqual((await readdir(path.join(f.root, 'media'))).sort(), [path.basename(f.asset.relativePath)]);
  await tick(f); const succeeded = f.store.get('exports', accepted.id);
  assert.equal(succeeded.status, 'succeeded', JSON.stringify(succeeded.error)); assert.notEqual(succeeded.renderAttemptId, attempt);
  assert.equal(succeeded.audioCheck.attemptId, succeeded.renderAttemptId); assert.deepEqual(receipt(f, input), saved);
});

test('final AAC spawn failure retains the complete same-attempt within-limit report with no published output', {timeout: 60_000}, async t => {
  const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  const prior = process.env.MIOON_FFMPEG_PATH; let decoder, changed = false;
  try {
    await tick(f, event => {
      if (event.type === 'started' && event.kind === 'ffmpeg' && renderConcatPhase(f.root) && decoder === undefined) decoder = event.pid;
      if (event.type === 'exited' && event.pid === decoder && !changed) {changed = true; process.env.MIOON_FFMPEG_PATH = path.join(f.root, 'missing-owned-final-encoder');}
    });
  } finally {if (prior === undefined) delete process.env.MIOON_FFMPEG_PATH; else process.env.MIOON_FFMPEG_PATH = prior;}
  assert.equal(changed, true);
  const failed = f.store.get('exports', accepted.id); assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'MEDIA_SPAWN_FAILED');
  assert.equal(failed.audioCheck.code, 'EXPORT_AUDIO_WITHIN_LIMIT'); assert.equal(failed.audioCheck.status, 'complete');
  assert.equal(failed.audioCheck.attemptId, failed.renderAttemptId); assert.equal(failed.audioCheck.measurement.sampleFrames, 4800);
  assert.equal(failed.audioCheck.output, null); assert.equal(failed.assetId, null); assert.equal(failed.url, null);
  assert.equal(f.store.list('assets').some(asset => asset.provenance === 'export'), false); assert.deepEqual(receipt(f, input), saved);
  assert.deepEqual((await readdir(path.join(f.root, 'media'))).sort(), [path.basename(f.asset.relativePath)]);
});
