import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MIO_STORAGE_TABLES, mioStorageSnapshotSchema} from '../packages/contracts/src/mio-storage.ts';
import type {MioStorageSnapshot, MioStorageTable} from '../packages/contracts/src/mio-storage.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {HISTORY_TABLES_BY_DOMAIN} from '../packages/business/src/project-file/schema/tables.ts';
import {MIO_QUOTA_BYTES_SQL, MIO_QUOTA_ROWS_SQL, MIO_STORAGE_LIMITS} from '../packages/business/src/project-file/schema/domains/mio.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';

const at = '2026-11-02T00:00:00.000Z';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-r1c-storage-')), store = openStore(root);
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  store.put('projects', {id: store.projectId, name: 'Synthetic storage project'});
  return {root, store, db: store.db, records: createMioRecords(store)};
}
function seeded(t: TestContext) {
  const f = fixture(t), {store, records, db} = f, {projectId} = store;
  const conversationId = randomUUID(), runId = randomUUID(), stepId = randomUUID(), requestId = randomUUID();
  const body = JSON.stringify({private: 'PRIVATE_RAW_REQUEST 中文🙂', path: '/PRIVATE/path'});
  let shared = '';
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic storage project'});
    shared = records.putBlob(JSON.stringify({private: 'PRIVATE_SHARED_CONTENT 中文🙂'}), at);
    records.createConversation({id: conversationId, createdAt: at, updatedAt: at});
    records.createRun({id: runId, conversationId, requestId: randomUUID(), digest: hash('send'), stepLimit: 30, budget: 30, locale: 'en', configurationBlobHash: shared, settingsRevision: 1, rulesSnapshotHash: shared, createdAt: at, updatedAt: at});
    records.appendEntry({id: randomUUID(), runId, kind: 'user_message', createdAt: at, payload: {blobHash: shared}});
    records.appendEntry({id: randomUUID(), runId, kind: 'note', createdAt: at, payload: {blobHash: shared}});
    records.createStep({id: stepId, runId, kind: 'model', createdAt: at});
    records.beginRequest({id: requestId, stepId, assemblerVersion: 1, protocol: 'responses', body, assembledAt: at,
      inputManifest: {version: 1, entryIds: [], noteEntryIds: [], configurationBlobHash: shared, toolsBlobHash: shared, systemBlobHash: shared, baselineBlobHash: shared, rulesBlobHash: shared, parameters: {}, viewVersion: 1}});
    records.saveControl({requestId: randomUUID(), runId, digest: hash('control'), data: {private: 'PRIVATE_CONTROL'}}, at);
    const controlId = db.prepare('SELECT requestId FROM mio_controls').get()!.requestId;
    records.setControlState(String(controlId), {private: 'PRIVATE_CONTROL_STATE'}, at);
    // Exercise every retained table, including local-only records that the
    // former workspace inventory omitted. SQL fixtures still obey real DDL.
    db.prepare('INSERT INTO mio_changes VALUES(?,?,?,?,?)').run(randomUUID(), runId, stepId, projectId, '{"private":"PRIVATE_CHANGE"}');
    db.prepare('INSERT INTO mio_imports(id,projectId,requestId,name,mimeType,relativePath,sha256,status,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), projectId, randomUUID(), 'PRIVATE_FILE', 'image/png', 'PRIVATE_PATH/file.png', 'a'.repeat(64), 'selected', at);
    db.prepare('INSERT INTO mio_job_origins VALUES(?,?,?,?,?,?,?)').run('job', randomUUID(), runId, stepId, projectId, randomUUID(), 'PRIVATE_OPERATION');
    db.prepare('INSERT INTO mio_edit_claims VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), projectId, 'synthetic-owner', 'shot', randomUUID(), 1, 'active', at, at);
    records.saveEditOwner('synthetic-owner', 1, 1);
    records.saveEditReceipt({requestId: randomUUID(), ownerId: 'synthetic-owner', digest: hash('edit'), data: {private: 'PRIVATE_EDIT_RECEIPT'}});
    records.setConversationPolicy({requestId: randomUUID(), conversationId, expectedRevision: 0, modes: null, global: structuredClone(DEFAULT_AGENT_TASK_POLICY), at});
    db.prepare('INSERT INTO mio_process_target_revisions VALUES(?,?,?,?)').run(projectId, 'job', randomUUID(), 1);
  });
  return {...f, conversationId, runId, stepId, requestId, body, shared};
}
function table(snapshot: MioStorageSnapshot, name: MioStorageTable) {
  const result = snapshot.tables.find(item => item.name === name); assert.ok(result); return result;
}
function totals(snapshot: MioStorageSnapshot): MioStorageSnapshot {
  const bytes = snapshot.tables.reduce((sum, item) => sum + item.bytes, 0);
  const rows = snapshot.tables.reduce((sum, item) => sum + (item.countedRows ? item.rows : 0), 0);
  return {...snapshot, usage: {bytes, rows}, retained: {bytes, rows: snapshot.tables.reduce((sum, item) => sum + item.rows, 0)},
    remaining: {bytes: Math.max(0, snapshot.limits.bytes - bytes), rows: Math.max(0, snapshot.limits.rows - rows)},
    status: bytes >= snapshot.limits.bytes || rows >= snapshot.limits.rows ? 'full' : bytes >= snapshot.limits.bytes * .9 || rows >= snapshot.limits.rows * .9 ? 'near_limit' : 'available'};
}

test('project storage counts nineteen real tables with the exact quota formula and one copy of each blob', t => {
  const f = seeded(t), actual = readMioStorage(f.db);
  assert.equal(actual.version, 2); assert.equal(actual.scope, 'project'); assert.equal(actual.projectId, f.store.projectId);
  assert.equal(actual.format, 'mio_records'); assert.deepEqual(actual.limits, MIO_STORAGE_LIMITS);
  assert.equal(actual.limits.rows, 65536);
  assert.deepEqual(actual.tables.map(item => item.name), HISTORY_TABLES_BY_DOMAIN.mio);
  for (const item of actual.tables) {
    const rows = f.db.prepare(`SELECT * FROM main.${item.name}`).all();
    assert.ok(rows.length > 0, `${item.name} must have a retained fixture`);
    // Every byte-bearing kernel column is text; numeric fields have no charge.
    const bytes = rows.reduce((sum, row) => sum + Object.values(row).reduce<number>((total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value) : 0), 0), 0);
    assert.equal(item.rows, rows.length); assert.equal(item.bytes, bytes, item.name);
    assert.equal(item.countedBytes, true); assert.equal(item.countedRows, item.name !== 'mio_edit_receipts');
  }
  assert.deepEqual(actual.usage, {...f.db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS bytes,${MIO_QUOTA_ROWS_SQL} AS rows`).get()});
  assert.equal(actual.retained.rows, actual.usage.rows + table(actual, 'mio_edit_receipts').rows);
  const blob = f.db.prepare('SELECT * FROM mio_blobs WHERE sha256=?').get(f.shared)!;
  assert.equal(table(actual, 'mio_blobs').rows, 1);
  assert.equal(table(actual, 'mio_blobs').bytes, Buffer.byteLength(String(blob.sha256) + String(blob.content) + String(blob.createdAt)));
  assert.deepEqual(table(actual, 'mio_storage_counters'), {name: 'mio_storage_counters', bytes: 0, rows: 1, countedBytes: true, countedRows: true, quotaGuard: 'row_only'});
  assert.deepEqual({...f.db.prepare('SELECT bytes,rows FROM mio_storage_counters WHERE singleton=1').get()}, actual.usage);
  assert.ok(!actual.tables.some(item => String(item.name).includes('agent_task_policy')));
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_|\/PRIVATE\/|inputManifest|originalBody|partialText|digest/u);
});

test('failed/unknown request originals and partials remain charged, successful archival removes only durable cleared content', t => {
  for (const state of ['failed', 'unknown', 'completed'] as const) {
    const f = seeded(t), before = readMioStorage(f.db), partial = 'PRIVATE_PARTIAL 中文🙂';
    f.store.tx(() => {
      f.records.markDispatched(f.requestId, at);
      f.records.updateStep(f.stepId, 'dispatch_started', {status: 'dispatch_started', partialText: partial, updatedAt: at});
      if (state !== 'completed') f.records.failRequest(f.requestId, state, at);
    });
    const checkpoint = readMioStorage(f.db);
    assert.equal(table(checkpoint, 'mio_steps').bytes - table(before, 'mio_steps').bytes, Buffer.byteLength(partial) + Buffer.byteLength(f.records.step(f.stepId).status) - Buffer.byteLength('intent'));
    assert.equal(f.records.request(f.requestId).originalBody, f.body);
    if (state === 'completed') {
      f.store.tx(() => f.records.completeModelRequest(f.requestId, {entryId: randomUUID(), output: {protocol: 'responses', providerOutput: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'PRIVATE_FINAL'}]}]}, at}));
      const done = readMioStorage(f.db);
      assert.equal(f.records.request(f.requestId).originalBody, null); assert.equal(f.records.step(f.stepId).partialText, null);
      assert.equal(table(done, 'mio_requests').bytes - table(checkpoint, 'mio_requests').bytes,
        -Buffer.byteLength(f.body) + Buffer.byteLength('completed') - Buffer.byteLength('dispatch_started') + Buffer.byteLength(at));
      assert.equal(table(done, 'mio_steps').bytes - table(checkpoint, 'mio_steps').bytes,
        -Buffer.byteLength(partial) + Buffer.byteLength('completed') - Buffer.byteLength('dispatch_started') + Buffer.byteLength(String(f.records.step(f.stepId).resultEntryId)));
    } else {
      assert.ok(table(checkpoint, 'mio_requests').bytes >= Buffer.byteLength(f.body));
      assert.equal(f.records.step(f.stepId).partialText, partial);
    }
    assert.deepEqual(readMioStorage(f.db).usage, {...f.db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS bytes,${MIO_QUOTA_ROWS_SQL} AS rows`).get()});
  }
});

test('storage reads use only the registered kernel identity and cause zero writes even under SQLite query_only', t => {
  const f = seeded(t), before = readMioStorage(f.db);
  const changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  const contentSequence = f.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence;
  const snapshots = () => MIO_STORAGE_TABLES.map(name => f.db.prepare(`SELECT * FROM main.${name} ORDER BY rowid`).all());
  const data = snapshots(); f.db.exec('PRAGMA query_only=ON');
  assert.deepEqual(readMioStorage(f.db), before); assert.deepEqual(readMioStorage(f.db), before);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(f.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence, contentSequence);
  assert.equal(f.db.isTransaction, false); assert.deepEqual(snapshots(), data);
  f.db.exec('PRAGMA query_only=OFF');
  const impostor = new DatabaseSync(':memory:');
  t.after(() => impostor.close());
  impostor.exec('CREATE TABLE history_state(singleton INTEGER,projectId TEXT);CREATE TABLE mio_runs(id TEXT)');
  impostor.prepare('INSERT INTO history_state VALUES(1,?)').run(f.store.projectId);
  assert.throws(() => readMioStorage(impostor), /live kernel project database/u);
  assert.throws(() => readMioStorage({...f.db} as DatabaseSync), /live kernel project database/u);
  f.store.close(); assert.throws(() => readMioStorage(f.db), /live kernel project database/u);
});

test('receipt payload protection is distinct from execution quota, and receipts disclose actual retained rows', t => {
  const f = fixture(t), {projectId} = f.store;
  let next = 0;
  function fill(rows: number) { f.store.tx(() => {
    const insert = f.db.prepare('INSERT INTO mio_process_target_revisions VALUES(?,?,?,1)');
    while (next < rows) insert.run(projectId, 'job', String(next++));
  }); }
  // The numeric counter row occupies one counted row from the beginning.
  assert.deepEqual(readMioStorage(f.db).usage, {bytes: 0, rows: 1});
  fill(58981); const below = readMioStorage(f.db);
  assert.equal(below.usage.rows, 58982); assert.equal(below.status, 'available');
  fill(58982); const near = readMioStorage(f.db);
  assert.equal(near.usage.rows, 58983); assert.equal(near.status, 'near_limit');
  fill(65535);
  const full = readMioStorage(f.db); assert.equal(full.status, 'full'); assert.equal(full.usage.rows, 65536);
  const receipt = {requestId: randomUUID(), ownerId: 'synthetic-owner', digest: hash('edit'), data: {text: 'x'.repeat(65525)}};
  assert.equal(Buffer.byteLength(JSON.stringify(receipt.data)), 65536);
  f.store.tx(() => f.records.saveEditReceipt(receipt));
  const after = readMioStorage(f.db);
  assert.equal(after.usage.rows, full.usage.rows); assert.equal(after.retained.rows, 65537);
  assert.ok(after.usage.bytes > full.usage.bytes); assert.equal(table(after, 'mio_edit_receipts').quotaGuard, 'row_only');
  assert.deepEqual(after.independentLimits, {editReceiptDataBytes: 65536, editReceiptTotalBytes: null, editReceiptTotalRows: null});
  assert.throws(() => f.store.tx(() => f.records.saveEditReceipt({...receipt, requestId: randomUUID(), data: {text: 'x'.repeat(65526)}})));
  assert.throws(() => f.store.tx(() => f.db.prepare('INSERT INTO mio_conversations VALUES(?,?,?,?)').run(randomUUID(), projectId, at, at)), /AGENT_TASK_STORAGE_LIMIT/u);
  assert.deepEqual(readMioStorage(f.db), after);
});

test('doctor detects tampered or missing counters without repairing them or writing on GET', t => {
  const f = seeded(t), original = readMioStorage(f.db).usage;
  const corrupt = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'AGENT_TASK_STORAGE_CORRUPT';
  function rejectsWithoutWrites() {
    const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
    f.db.exec('PRAGMA query_only=ON');
    assert.throws(() => readMioStorage(f.db), corrupt);
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
    f.db.exec('PRAGMA query_only=OFF');
  }
  f.db.exec('UPDATE mio_storage_counters SET bytes=bytes+1'); rejectsWithoutWrites();
  f.db.prepare('UPDATE mio_storage_counters SET bytes=?,rows=?').run(original.bytes, original.rows);
  f.db.exec('UPDATE mio_storage_counters SET rows=rows+1'); rejectsWithoutWrites();
  f.db.prepare('UPDATE mio_storage_counters SET bytes=?,rows=?').run(original.bytes, original.rows);
  assert.deepEqual(readMioStorage(f.db).usage, original);
  // Simulate on-disk structural damage after the kernel opened a valid file.
  // Ordinary domain writes cannot remove this protected singleton.
  for (const row of f.db.prepare("SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name='mio_storage_counters'").all()) {
    assert.match(String(row.name), /^[a-z_][a-z0-9_]*$/u); f.db.exec(`DROP TRIGGER ${String(row.name)}`);
  }
  f.db.exec('DELETE FROM mio_storage_counters'); rejectsWithoutWrites();
  f.db.exec('DROP TABLE mio_storage_counters'); rejectsWithoutWrites();
  f.db.exec('CREATE TABLE mio_storage_counters(singleton INTEGER,bytes INTEGER,rows INTEGER)');
  const insert = f.db.prepare('INSERT INTO mio_storage_counters VALUES(1,?,?)');
  insert.run(original.bytes, original.rows); insert.run(original.bytes, original.rows); rejectsWithoutWrites();
  f.db.exec('DELETE FROM mio_storage_counters WHERE rowid=2;UPDATE mio_storage_counters SET bytes=0.5'); rejectsWithoutWrites();
  f.db.prepare('UPDATE mio_storage_counters SET bytes=?').run(BigInt(Number.MAX_SAFE_INTEGER) + 1n); rejectsWithoutWrites();
});

test('incremental counters equal full inventory after updates, no-ops, exempt writes, deletes and rollback', t => {
  const f = seeded(t), {projectId} = f.store;
  function equal() {
    const actual = readMioStorage(f.db);
    assert.deepEqual(actual.usage, {...f.db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS bytes,${MIO_QUOTA_ROWS_SQL} AS rows`).get()});
    assert.deepEqual({...f.db.prepare('SELECT bytes,rows FROM mio_storage_counters').get()}, actual.usage);
    return actual;
  }
  const start = equal();
  f.store.tx(() => f.db.prepare('UPDATE mio_steps SET partialText=? WHERE id=?').run('partial 中文🙂', f.stepId)); equal();
  f.store.tx(() => f.db.prepare('UPDATE mio_steps SET partialText=partialText WHERE id=?').run(f.stepId)); equal();
  f.store.tx(() => f.db.prepare('UPDATE mio_steps SET partialText=NULL WHERE id=?').run(f.stepId)); assert.deepEqual(equal(), start);
  f.store.tx(() => f.records.saveEditReceipt({requestId: randomUUID(), ownerId: 'synthetic-owner', digest: hash('new edit'), data: {text: 'exempt receipt 中文'}}));
  const receipt = equal(); assert.equal(receipt.usage.rows, start.usage.rows); assert.ok(receipt.usage.bytes > start.usage.bytes);
  f.store.tx(() => f.db.prepare('UPDATE mio_edit_claims SET state=?').run('uncertain')); equal();
  f.store.tx(() => f.db.prepare('DELETE FROM mio_edit_claims').run()); const removed = equal();
  assert.equal(table(removed, 'mio_edit_claims').rows, 0);
  assert.throws(() => f.store.tx(() => {
    f.db.prepare('UPDATE mio_steps SET partialText=? WHERE id=?').run('rollback retained bytes', f.stepId); equal();
    f.db.prepare('INSERT INTO mio_process_target_revisions VALUES(?,?,?,1)').run(projectId, 'job', randomUUID()); equal();
    throw new Error('force synthetic rollback');
  }), /force synthetic rollback/u);
  assert.deepEqual(equal(), removed);
});

test('the closed version 2 schema enforces complete inventory, exact equations, boundaries and overflow safety', t => {
  const f = seeded(t), valid = readMioStorage(f.db);
  const invalid: unknown[] = [
    {...valid, version: 1}, {...valid, scope: 'workspace'}, {...valid, projectId: 'arbitrary'}, {...valid, format: 'inline'},
    {...valid, limits: {...valid.limits, bytes: 2 ** 30}}, {...valid, limits: {...valid.limits, rows: 20000}}, {...valid, independentLimits: {...valid.independentLimits, editReceiptTotalRows: 65536}},
    {...valid, retained: {...valid.retained, rows: valid.usage.rows}}, {...valid, usage: {...valid.usage, bytes: valid.usage.bytes + 1}},
    {...valid, remaining: {...valid.remaining, rows: 0}}, {...valid, status: 'full'}, {...valid, secret: 'PRIVATE'},
    {...valid, tables: valid.tables.slice(1)}, {...valid, tables: [...valid.tables.slice(1), valid.tables[1]]},
    {...valid, tables: valid.tables.map((item, index) => index ? item : {...item, name: 'sqlite_schema'})},
    {...valid, tables: valid.tables.map(item => item.name === 'mio_edit_receipts' ? {...item, countedRows: true} : item)},
    {...valid, tables: valid.tables.map(item => item.name === 'mio_edit_claims' ? {...item, quotaGuard: 'execution'} : item)},
    {...valid, tables: valid.tables.map(item => item.name === 'mio_blobs' ? {...item, countedBytes: false} : item)},
    totals({...valid, tables: valid.tables.map(item => item.name === 'mio_storage_counters' ? {...item, rows: 0} : item)}),
    totals({...valid, tables: valid.tables.map(item => item.name === 'mio_storage_counters' ? {...item, bytes: 1} : item)}),
    {...valid, tables: valid.tables.map((item, index) => index ? item : {...item, rows: 0.5})},
    {...valid, usage: {...valid.usage, rows: -1}}, {...valid, usage: {...valid.usage, bytes: Infinity}},
  ];
  for (const value of invalid) assert.equal(mioStorageSnapshotSchema.safeParse(value).success, false);
  const empty = readMioStorage(fixture(t).db);
  for (const [rows, status] of [[58982, 'available'], [58983, 'near_limit'], [65536, 'full'], [65537, 'full']] as const) {
    const value = totals({...empty, tables: empty.tables.map(item => item.name === 'mio_events' ? {...item, rows: rows - 1} : item)});
    assert.equal(value.status, status); assert.equal(mioStorageSnapshotSchema.safeParse(value).success, true);
  }
  for (const bytes of [Math.ceil(268435456 * .9) - 1, Math.ceil(268435456 * .9), 268435456, Number.MAX_SAFE_INTEGER]) {
    const value = totals({...empty, tables: empty.tables.map(item => item.name === 'mio_blobs' ? {...item, bytes} : item)});
    assert.equal(mioStorageSnapshotSchema.safeParse(value).success, true);
  }
  const overflow = {...empty, tables: empty.tables.map((item, index) => ({...item, bytes: index < 2 ? Number.MAX_SAFE_INTEGER : 0}))};
  assert.equal(mioStorageSnapshotSchema.safeParse(overflow).success, false);
});
