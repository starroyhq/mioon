import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync, type StatementResultingChanges} from 'node:sqlite';
import {opacityUpgradeFixture, upgradeFixtureHash, type OpacityUpgradeOptions} from './helpers/opacity-upgrade-fixture.ts';
import {logicalTables, raw} from './helpers/opacity-backup-fixture.ts';
import {requireEligibleOrdinary40, upgradeCopiedDatabase40To42, captureOrdinaryUpgradePreservation} from '../packages/business/src/opacity-upgrade-database.ts';
import {classifyCurrentWorkspaceSchema, installCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {classifyWorkspaceSchema42} from '../packages/business/src/workspace-schema-v42.ts';
import {hash} from '../packages/business/src/services.ts';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.ts';

async function copied(t: test.TestContext, options?: OpacityUpgradeOptions|undefined) {
  const f = await (opacityUpgradeFixture(t, options) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture>), file = path.join(f.base, 'unpublished.sqlite');
  fs.copyFileSync(f.database, file);
  const db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;');
  t.after(() => db.close()); return {...f, db, file};
}
function unchanged(f: Awaited<ReturnType<typeof copied>>, code: string) {
  const before = (logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']); assert.throws(() => requireEligibleOrdinary40(f.db), {code});
  assert.deepEqual((logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']), before); assert.throws(() => upgradeCopiedDatabase40To42(f.db), {code});
  assert.deepEqual((logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']), before); assert.equal(f.db.isTransaction, false);
}
function withoutTriggers(db: DatabaseSync, mutate: { (): StatementResultingChanges; (): void; (): void; }) {
  const guards = db.prepare("SELECT name,sql FROM main.sqlite_schema WHERE type='trigger' ORDER BY name").all();
  for (const guard of guards) db.exec('DROP TRIGGER \"'+guard.name+'\"');
  try {mutate();} finally {for (const guard of guards) db.exec((guard.sql as string));}
}
function pending(f: Awaited<ReturnType<typeof copied>>, status = 'prepared', acknowledged = 0) {
  const input = {...f.input, requestId: randomUUID()}, claim = ['dispatching', 'applied', 'not_applied'].includes(status) ? randomUUID() : null;
  f.db.prepare(`INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,claim,claimInstance,receiptDigest,errorCode,createdAt,updatedAt,bytes)
    VALUES(?,?,'timeline.clip.update',?,?,?,'timeline:mutation','new',?,1,?,?,?,?,?,?,?,16384)`).run(
    randomUUID(), f.projectId, JSON.stringify(input), input.requestId, hash({operation: 'timeline.clip.update', input}), status, acknowledged,
    claim, claim ? randomUUID() : null, status === 'applied' ? 'a'.repeat(64) : null, status === 'not_applied' ? 'REVISION_CONFLICT' : null,
    '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z');
}
function timelineExport(f: Awaited<ReturnType<typeof copied>>) {
  const input = {projectId: f.projectId, requestId: randomUUID(), expectedRevision: f.timeline.revision, purpose: 'preview'};
  const snapshot = (freezeTimelineSnapshot as unknown as (timeline:typeof f.timeline,assets:Map<string,typeof f.asset>)=>ReturnType<typeof freezeTimelineSnapshot>)(f.timeline, new Map([[f.assetId, f.asset]]));
  const accepted = {id: randomUUID(), projectId: f.projectId, requestId: input.requestId, mode: 'timeline', purpose: 'preview',
    timelineRevision: f.timeline.revision, snapshot, status: 'queued', assetId: null, url: null, error: null,
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z'};
  const value = {...accepted, status: 'failed', error: {code: 'TEST_FAILURE', message: 'Synthetic historical failure'}};
  f.db.prepare('INSERT INTO exports(id,projectId,data) VALUES(?,?,?)').run(value.id, f.projectId, raw(value));
  f.db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(input.requestId, hash({operation: 'timeline.render', input}), raw(accepted));
  return {input, accepted, value};
}

test('exact40 read gate and copied upgrade retain raw histories, receipts, ACK task, LUT bytes, preferences and sequence', async t => {
  const f = await copied(t), sourceHash = upgradeFixtureHash(fs.readFileSync(f.database)), before = captureOrdinaryUpgradePreservation(f.db), changes = f.db.prepare('SELECT total_changes() n').get()!.n;
  requireEligibleOrdinary40(f.db); assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, changes);
  assert.deepEqual(classifyCurrentWorkspaceSchema(f.db), {schemaVersion: 40, profile: 'ordinary'});
  upgradeCopiedDatabase40To42(f.db); assert.deepEqual(classifyWorkspaceSchema42(f.db), {schemaVersion: 42, profile: 'ordinary'});
  assert.deepEqual(captureOrdinaryUpgradePreservation(f.db, true), before);
  const after = (logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']); after.schema_version.rows = after.schema_version.rows.filter(row => row.version !== 42n);
  assert.deepEqual(after, f.before); assert.equal(upgradeFixtureHash(fs.readFileSync(f.database)), sourceHash);
  assert.equal(f.db.prepare("SELECT typeof(seq) type,seq FROM sqlite_sequence WHERE name='edit_tasks'").get()!.type, 'real');
  assert.throws(() => classifyCurrentWorkspaceSchema(f.db));
});

for (const status of ['prepared', 'unknown', 'dispatching', 'applied', 'not_applied'] as const) test(`unresolved or unacknowledged ${status} task refuses without state edits`, async t => {
  const f = await copied(t); pending(f, status); unchanged(f, 'UNRESOLVED_TASKS');
});

test('terminal acknowledged task still needs its original request digest and receipt evidence', async t => {
  const f = await copied(t);
  withoutTriggers(f.db, () => f.db.prepare('UPDATE edit_tasks SET digest=?').run('f'.repeat(64)));
  unchanged(f, 'SOURCE_INVALID');
});

test('restored41 remains held with its original origin and epoch and is never converted', async t => {
  const f = await copied(t); f.db.exec("UPDATE sqlite_sequence SET seq=7001 WHERE name='edit_tasks'"); installCurrentWorkspaceRestoreSchema(f.db, {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(), manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: '2026-10-16T00:00:00.000Z'});
  unchanged(f, 'SOURCE_INVALID'); assert.equal(classifyCurrentWorkspaceSchema(f.db).schemaVersion, 41);
  assert.equal(f.db.prepare('SELECT executionEpoch FROM edit_tasks').get()!.executionEpoch, 'captured');
});

for (const variant of ['unknown table', 'missing marker', 'foreign key', 'malformed JSON', 'duplicate JSON', 'bad preferences'] as const) test(`${variant} source fails closed without a42 marker`, async t => {
  const f = await copied(t);
  if (variant === 'unknown table') f.db.exec('CREATE TABLE surprise(x)');
  else if (variant === 'missing marker') f.db.exec('DELETE FROM schema_version WHERE version=40');
  else if (variant === 'foreign key') {f.db.exec('PRAGMA foreign_keys=OFF'); f.db.prepare('UPDATE assets SET projectId=?').run(randomUUID()); f.db.exec('PRAGMA foreign_keys=ON');}
  else if (variant === 'malformed JSON') f.db.prepare('UPDATE projects SET data=?').run('not-json');
  else if (variant === 'duplicate JSON') f.db.prepare('UPDATE projects SET data=?').run(`{"id":"${f.projectId}","id":"${f.projectId}"}`);
  else f.db.prepare('UPDATE workspace_preferences SET state=?').run('{"version":1}');
  unchanged(f, 'SOURCE_INVALID');
});

for (const patch of [{provenance: 'generated'}, {relativePath: '../outside.mp4'}, {relativePath: 'media/noncanonical.mp4'}, {mimeType: 'application/octet-stream'}, {sha256: 'bad'}, {sizeBytes: 0}] as const) test(`candidate incompatible asset ${Object.keys(patch)[0]} refuses source intact`, async t => {
  const f = await copied(t); f.db.prepare('UPDATE assets SET data=?').run(JSON.stringify({...f.asset, ...patch}));
  assert.throws(() => requireEligibleOrdinary40(f.db));
  const before = (logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']); assert.throws(() => upgradeCopiedDatabase40To42(f.db)); assert.deepEqual((logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']), before);
});

test('legacy sequence export is explicitly unsupported rather than hidden from project reads', async t => {
  const f = await copied(t), id = randomUUID();
  f.db.prepare('INSERT INTO exports(id,projectId,data) VALUES(?,?,?)').run(id, f.projectId, JSON.stringify({id, projectId: f.projectId, requestId: randomUUID(), status: 'failed', snapshot: [], assetId: null, url: null, error: null}));
  unchanged(f, 'UNSUPPORTED_EXPORT');
});

test('valid failed timeline export with its queued identity receipt survives as read-only history', async t => {
  const f = await copied(t); timelineExport(f); const before = captureOrdinaryUpgradePreservation(f.db);
  requireEligibleOrdinary40(f.db); upgradeCopiedDatabase40To42(f.db); assert.deepEqual(captureOrdinaryUpgradePreservation(f.db, true), before);
});

for (const variant of ['missing receipt', 'wrong identity', 'invalid snapshot', 'queued'] as const) test(`timeline export ${variant} cannot acquire42 admission`, async t => {
  const f = await copied(t), e = timelineExport(f);
  withoutTriggers(f.db, ((() => {
    if (variant === 'missing receipt') f.db.prepare('DELETE FROM timeline_requests WHERE requestId=?').run(e.input.requestId);
    else if (variant === 'wrong identity') f.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify({...e.accepted, id: randomUUID()}), e.input.requestId);
    else if (variant === 'invalid snapshot') f.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify({...e.value, snapshot: {...e.value.snapshot, assets: []}}), e.value.id);
    else f.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify(e.accepted), e.value.id);
  }) as unknown as Parameters<typeof withoutTriggers>[1]));
  const before = (logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']);assert.throws(() => upgradeCopiedDatabase40To42(f.db));assert.deepEqual((logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']), before);
});

for (const mode of ['throw after marker', 'unknown table after marker', 'row mutation after marker'] as const) test(`${mode} rolls back marker and all private-copy changes`, async t => {
  const f = await copied(t), before = (logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']), native = f.db.exec.bind(f.db);
  f.db.exec = sql => {
    const result = native(sql);
    if (sql.startsWith('INSERT INTO main.schema_version')) {
      if (mode === 'throw after marker') throw Error('Synthetic private failure');
      if (mode === 'unknown table after marker') native('CREATE TABLE incomplete(x)');
      else native("UPDATE workspace_preferences SET state=state||' '");
    }
    return result;
  };
  assert.throws(() => upgradeCopiedDatabase40To42(f.db));f.db.exec = native;
  assert.equal(f.db.isTransaction, false);assert.deepEqual((logicalTables(f.db) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before']), before);
});

test('nested caller transaction and unsafe PRAGMAs refuse without ending a caller transaction', async t => {
  const f = await copied(t);f.db.exec('BEGIN');
  assert.throws(() => upgradeCopiedDatabase40To42(f.db));assert.equal(f.db.isTransaction, true);f.db.exec('ROLLBACK');
  for (const pragma of ['foreign_keys=OFF', 'trusted_schema=ON', 'ignore_check_constraints=ON'] as const) {
    f.db.exec('PRAGMA '+pragma);assert.throws(() => requireEligibleOrdinary40(f.db));assert.throws(() => upgradeCopiedDatabase40To42(f.db));
    f.db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;PRAGMA ignore_check_constraints=OFF;');
  }
  requireEligibleOrdinary40(f.db);
});


test('legitimate acknowledged not_applied task retains its absence proof and cannot be resumed', async t => {
  const f = await copied(t, {rejectTask: true}); assert.equal(f.rejectedTask!.status, 'not_applied'); assert.equal(f.rejectedTask!.acknowledged, true);
  const before = captureOrdinaryUpgradePreservation(f.db);requireEligibleOrdinary40(f.db);upgradeCopiedDatabase40To42(f.db);
  assert.deepEqual(captureOrdinaryUpgradePreservation(f.db, true), before);
});

for (const status of ['queued', 'submitting', 'submission_unknown', 'running', 'downloading', 'unknown'] as const) test(`generation job ${status} cannot enter ordinary42`, async t => {
  const f = await copied(t), id = randomUUID();
  f.db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(id, f.projectId, JSON.stringify({id, projectId: f.projectId, status}));
  unchanged(f, 'UNRESOLVED_TASKS');
});
