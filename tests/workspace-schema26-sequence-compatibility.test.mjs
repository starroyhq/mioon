import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {initializeWorkspaceSchema26, validateWorkspaceSchema26, validateWorkspaceSchema24For26Migration} from '../packages/business/src/workspace-schema-v26.ts';
import {migrateComfyImageReviewSchema} from '../packages/business/src/images/review-schema.mjs';
import {migrateComfyImageSchema} from '../packages/business/src/comfy-image-schema.mjs';
import {migrateFrameSchema} from '../packages/business/src/frame-schema.mjs';
import {migrateTimelineFormatSchema} from '../packages/business/src/timeline-format-schema.mjs';
import {migrateTimelineFormatEditTasks, migrateTimelineSubtitleEditTasks} from '../packages/business/src/edit-task-schema.mjs';
import {open, fixture, snapshot, preserved, task, insert, probe, facade, assertBoundedSequenceProjection} from './workspace-schema26-fixtures.mjs';

function database(t) {
  const db = open(':memory:');
  t.after(() => db.close());
  fixture(db, 'ordinary-24');
  return db;
}

function sequence(db) {
  const statement = db.prepare("SELECT rowid,typeof(seq) AS kind,seq FROM main.sqlite_sequence WHERE name='edit_tasks'");
  statement.setReadBigInts(true);
  return statement.all().map(value => ({...value}));
}

function setSequence(db, value, rowid = 9007199254741991n) {
  db.exec("DELETE FROM main.sqlite_sequence WHERE name='edit_tasks'");
  db.prepare("INSERT INTO main.sqlite_sequence(rowid,name,seq) VALUES(?,'edit_tasks',?)").run(rowid, value);
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { fn(); db.exec('COMMIT'); }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

function migrateFormat(db) {
  transaction(db, () => {
    migrateTimelineFormatSchema(db);
    migrateTimelineFormatEditTasks(db);
    db.exec('INSERT INTO schema_version VALUES(21)');
  });
}

function assertNextPosition(db, expected) {
  probe(db, () => {
    const value = task(db);
    insert(db, 'edit_tasks', value);
    const statement = db.prepare('SELECT position FROM edit_tasks WHERE id=?');
    statement.setReadBigInts(true);
    assert.equal(statement.get(value.id).position, expected);
  });
}

for (const migration of ['format21', 'subtitle22']) {
  test(`actual historical ${migration} Number rebind produces REAL sequence that migrates intact to26`, t => {
    const db = open(':memory:');
    t.after(() => db.close());
    // Independently frozen18 plus the actual immutable historical migrations;
    // neither the sequence storage change nor old table SQL is manufactured.
    db.exec(readFileSync(new URL('./fixtures/images-legacy-schema18.sql', import.meta.url), 'utf8'));
    transaction(db, () => {
      migrateComfyImageReviewSchema(db);
      migrateComfyImageSchema(db);
      db.exec('INSERT INTO schema_version VALUES(19)');
    });
    transaction(db, () => {
      migrateFrameSchema(db);
      db.exec('INSERT INTO schema_version VALUES(20)');
    });
    if (migration === 'subtitle22') migrateFormat(db);
    insert(db, 'edit_tasks', task(db, {operation: 'timeline.track.add', position: 31n}));
    setSequence(db, 8123n, 701n);
    assert.deepEqual(sequence(db), [{rowid: 701n, kind: 'integer', seq: 8123n}]);
    if (migration === 'format21') migrateFormat(db);
    else transaction(db, () => {
      migrateTimelineSubtitleEditTasks(db);
      db.exec('INSERT INTO schema_version VALUES(22)');
    });
    const historicalSequence = [{rowid: 701n, kind: 'real', seq: 8123}];
    assert.deepEqual(sequence(db), historicalSequence, 'the historical Number binding is the concrete source of REAL storage');
    initializeWorkspaceSchemaThrough24(db);
    assert.deepEqual(sequence(db), historicalSequence);
    const before = snapshot(db);
    validateWorkspaceSchema24For26Migration(db);
    initializeWorkspaceSchema26(db);
    preserved(db, before);
    assert.deepEqual(sequence(db), historicalSequence);
    const after = snapshot(db);
    validateWorkspaceSchema26(db);
    initializeWorkspaceSchema26(db);
    assert.deepEqual(snapshot(db), after);
    assertNextPosition(db, 8124n);
    assert.deepEqual(snapshot(db), after, 'rollback of an insert probe also retains REAL storage');
  });
}

for (const value of [0n, 8123n, 9007199254740991n, 9007199254741999n, 9223372036854775807n, 0, 8123, Number.MAX_SAFE_INTEGER]) {
  const kind = typeof value === 'bigint' ? 'integer' : 'real';
  test(`ordinary26 preserves empty ${kind} sequence ${value}, exact large rowid and AUTOINCREMENT behavior`, t => {
    const db = database(t);
    setSequence(db, value);
    const originalSequence = sequence(db), before = snapshot(db);
    assert.equal(originalSequence[0].kind, kind);
    validateWorkspaceSchema24For26Migration(db);
    initializeWorkspaceSchema26(db);
    preserved(db, before);
    assert.deepEqual(sequence(db), originalSequence);
    const after = snapshot(db);
    validateWorkspaceSchema26(db);
    initializeWorkspaceSchema26(db);
    assert.deepEqual(snapshot(db), after);
    if (value === 9223372036854775807n) {
      const candidate = task(db);
      assert.throws(() => insert(db, 'edit_tasks', candidate), /database or disk is full/);
      assert.deepEqual(sequence(db), originalSequence, 'exhausted signed64 sequence does not reset');
    } else {
      assertNextPosition(db, BigInt(value) + 1n);
      assert.deepEqual(snapshot(db), after);
    }
  });
}

for (const value of [31n, 8123n, 31, 8123, Number.MAX_SAFE_INTEGER]) {
  const kind = typeof value === 'bigint' ? 'integer' : 'real';
  test(`ordinary26 preserves occupied ${kind} sequence ${value} at or above maximum position`, t => {
    const db = database(t);
    insert(db, 'edit_tasks', task(db, {operation: 'timeline.track.add', position: 31n}));
    setSequence(db, value);
    const originalSequence = sequence(db), before = snapshot(db);
    initializeWorkspaceSchema26(db);
    preserved(db, before);
    assert.deepEqual(sequence(db), originalSequence);
    assertNextPosition(db, BigInt(value) + 1n);
  });
}

for (const [name, expression] of [
  ['null', 'NULL'],
  ['integer negative', '-1'],
  ['real negative', '-1.0'],
  ['real fractional', '8123.5'],
  ['real above safe integer', '9007199254740992.0'],
  ['real near signed64 limit', '9223372036854775807.0'],
  ['positive infinity', '9e999'],
  ['negative infinity', '-9e999'],
  ['numeric text', "'8123'"],
  ['other text', "'unknown'"],
  ['blob', "x'38313233'"],
  ['integer below maximum position', '30'],
  ['real below maximum position', '30.0'],
]) {
  test(`ordinary26 rejects ${name} sequence before mutation`, t => {
    const db = database(t);
    insert(db, 'edit_tasks', task(db, {operation: 'timeline.track.add', position: 31n}));
    db.exec(`UPDATE sqlite_sequence SET seq=${expression} WHERE name='edit_tasks'`);
    const before = snapshot(db), effects = [];
    for (const validate of [validateWorkspaceSchema24For26Migration, initializeWorkspaceSchema26]) {
      assert.throws(() => validate(facade(db, effect => effects.push(effect))), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
      assert.deepEqual(snapshot(db), before);
      assert.equal(db.isTransaction, false);
    }
    assert.ok(effects.every(effect => effect.sql === 'BEGIN IMMEDIATE'), 'no DDL or record write is attempted');
  });
}

for (const duplicate of [8123n, 8123]) {
  test(`ordinary26 rejects duplicate INTEGER/REAL sequence rows even with valid high-water values (${typeof duplicate})`, t => {
    const db = database(t);
    setSequence(db, 8123);
    db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('edit_tasks',?)").run(duplicate);
    const before = snapshot(db);
    assert.throws(() => initializeWorkspaceSchema26(db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
    assert.deepEqual(snapshot(db), before);
  });
}

test('ordinary26 compares safe REAL sequence to an unsafe integer position without Number rounding', t => {
  const db = database(t);
  insert(db, 'edit_tasks', task(db, {operation: 'timeline.track.add', position: 9007199254740993n}));
  setSequence(db, Number.MAX_SAFE_INTEGER);
  const before = snapshot(db);
  assert.throws(() => initializeWorkspaceSchema26(db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.deepEqual(snapshot(db), before);
});

for (const [phase, sql] of [
  ['after', 'DROP TABLE main.edit_tasks'],
  ['after', 'ALTER TABLE main.edit_tasks_loudness_v26 RENAME TO edit_tasks'],
  ['after', "DELETE FROM main.sqlite_sequence WHERE name='edit_tasks'"],
  ['before', "INSERT INTO main.sqlite_sequence(rowid,name,seq) VALUES(?,'edit_tasks',?)"],
  ['after', "INSERT INTO main.sqlite_sequence(rowid,name,seq) VALUES(?,'edit_tasks',?)"],
  ['after', 'INSERT INTO main.schema_version(version) VALUES(26)'],
  ['before', 'COMMIT'],
]) {
  test(`ordinary26 rollback retains REAL sequence bytes, storage and rowid ${phase} ${sql}`, t => {
    const db = database(t);
    insert(db, 'edit_tasks', task(db, {operation: 'timeline.track.add', position: 31n}));
    setSequence(db, 8123);
    const before = snapshot(db), originalSequence = sequence(db), fault = new Error('injected REAL sequence rollback');
    assert.throws(() => initializeWorkspaceSchema26(facade(db, event => {
      if (event.phase === phase && event.sql === sql) throw fault;
    })), error => error === fault);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(sequence(db), originalSequence);
    initializeWorkspaceSchema26(db);
    preserved(db, before);
    assert.deepEqual(sequence(db), originalSequence);
    assertNextPosition(db, 8124n);
  });
}

test('numeric sequence compatibility retains SQL masking of giant TEXT/BLOB inputs', () => {
  assertBoundedSequenceProjection(initializeWorkspaceSchema26);
});
