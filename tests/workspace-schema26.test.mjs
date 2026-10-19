import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26, validateWorkspaceSchema26, validateWorkspaceSchema24For26Migration} from '../packages/business/src/workspace-schema-v26.ts';
import {open, fixture, snapshot, preserved, populate, task, insert, probe, facade, operations24, columns, assertBoundedSequenceProjection} from './workspace-schema26-fixtures.mjs';

function database(t, profile = 'ordinary-24-seeded') {
  const db = open(':memory:'); t.after(() => db.close()); fixture(db, profile); return db;
}
function directory(t) {
  const value = mkdtempSync(path.join(tmpdir(), 'mioon-schema26-'));
  t.after(() => rmSync(value, {recursive:true, force:true})); return value;
}
function writes(db) {
  const result = [];
  initializeWorkspaceSchema26(facade(db, value => { if (value.phase === 'after') result.push(value); }));
  return result;
}
function noMutation(db, attempt) {
  const before = snapshot(db), observed = [];
  assert.throws(() => attempt(facade(db, value => observed.push(value))), {code:'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.deepEqual(snapshot(db), before, 'unsupported migration changes no logical schema or records');
  assert.equal(db.isTransaction, false);
  assert.ok(observed.every(value => value.sql === 'BEGIN IMMEDIATE'), 'rejection precedes every DDL, copy, sequence and marker effect');
}

test('ordinary26 fixes the retained old-constructor red and admits only its new durable operation', t => {
  const db = open(':memory:'); t.after(() => db.close()); initializeWorkspaceSchemaThrough24(db);
  probe(db, () => assert.throws(() => insert(db, 'edit_tasks', task(db)), /CHECK constraint failed: operation/));
  const before = snapshot(db); initializeWorkspaceSchema26(db); preserved(db, before);
  probe(db, () => assert.doesNotThrow(() => insert(db, 'edit_tasks', task(db))));
  for (const operation of ['timeline.loudness.prepare','timeline.loudness.apply.v2','timeline.render','clip.update']) {
    probe(db, () => assert.throws(() => insert(db, 'edit_tasks', task(db, {operation})), /CHECK/));
  }
});

for (const profile of ['ordinary-24','ordinary-24-seeded','ordinary-24-mock','ordinary-24-mock-seeded']) {
  test(`ordinary26 preserves independent ${profile} raw catalog and every record/receipt/sequence`, t => {
    const db = database(t, profile), before = snapshot(db);
    initializeWorkspaceSchema26(db); preserved(db, before);
    const after = snapshot(db); validateWorkspaceSchema26(db); initializeWorkspaceSchema26(db);
    assert.deepEqual(snapshot(db), after, 'validated26 reentry does not rebuild or rewrite anything');
    assert.deepEqual(db.prepare('PRAGMA table_info(edit_tasks)').all().map(value => value.name), columns);
  });
}

test('ordinary26 preserves all19 legacy operations, all states, raw BLOB/TEXT and signed64 rowids/high-water marks', t => {
  const db = database(t); populate(db); const before = snapshot(db);
  initializeWorkspaceSchema26(db); preserved(db, before);
  assert.equal(db.prepare('SELECT count(*) AS count FROM edit_tasks').get().count, 154);
  probe(db, () => {
    const value = task(db); insert(db, 'edit_tasks', value);
    const statement = db.prepare('SELECT position FROM edit_tasks WHERE id=?'); statement.setReadBigInts(true);
    assert.equal(statement.get(value.id).position, 9007199254742000n);
  });
});

for (const sequence of [null, 0n, 8000n, 9007199254741999n]) {
  test(`ordinary26 preserves empty sequence ${sequence ?? 'absence'} including original rowid`, t => {
    const db = database(t, 'ordinary-24');
    if (sequence !== null) db.prepare("INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,'edit_tasks',?)").run(9007199254741991n, sequence);
    const before = snapshot(db); initializeWorkspaceSchema26(db); preserved(db, before);
    probe(db, () => {
      const value = task(db); insert(db, 'edit_tasks', value);
      const statement = db.prepare('SELECT position FROM edit_tasks WHERE id=?'); statement.setReadBigInts(true);
      assert.equal(statement.get(value.id).position, (sequence ?? 0n) + 1n);
    });
  });
}

test('ordinary26 keeps lane uniqueness, immutable identity, state machine, input bounds and FK constraints', t => {
  const db = database(t); initializeWorkspaceSchema26(db); const before = snapshot(db);
  for (const operation of [...operations24,'timeline.loudness.apply']) probe(db, () => insert(db, 'edit_tasks', task(db, {operation})));
  for (const patch of [{lane:'reference:mutation'},{lane:'subject:mutation'},{bytes:16383},{revision:0},{revision:1.5},{acknowledged:1},{input:'[]'},{input:'broken'},{input:'{"padding":"'+'x'.repeat(8192)+'"}'},{status:'dispatching',claim:null},{status:'applied',receiptDigest:null},{status:'not_applied',errorCode:null}]) {
    probe(db, () => assert.throws(() => insert(db, 'edit_tasks', {...task(db), ...patch}), /CHECK/));
  }
  probe(db, () => {
    const value = task(db); insert(db, 'edit_tasks', value);
    assert.throws(() => db.prepare('DELETE FROM edit_tasks WHERE id=?').run(value.id), /retained/);
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO edit_tasks SELECT * FROM edit_tasks WHERE id=?').run(value.id), /immutable/);
    assert.throws(() => db.prepare("UPDATE edit_tasks SET input='{}',revision=revision+1 WHERE id=?").run(value.id), /immutable|transition/);
    const requestId = randomUUID(), next = {...value, id:randomUUID(), requestId, input:JSON.stringify({...JSON.parse(value.input), requestId})};
    assert.throws(() => insert(db, 'edit_tasks', next), /UNIQUE/);
    db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?").run(randomUUID(), randomUUID(), value.id);
    db.prepare("UPDATE edit_tasks SET status='not_applied',revision=revision+1,errorCode='STALE' WHERE id=?").run(value.id);
    assert.throws(() => db.prepare("UPDATE edit_tasks SET status='unknown',revision=revision+1 WHERE id=?").run(value.id), /transition/);
    db.prepare('UPDATE edit_tasks SET acknowledged=1,revision=revision+1 WHERE id=?').run(value.id);
    insert(db, 'edit_tasks', next);
    assert.throws(() => insert(db, 'edit_tasks', {...task(db), projectId:randomUUID(), input:JSON.stringify({projectId:'missing',requestId:randomUUID()})}), /CHECK|FOREIGN KEY/);
  });
  probe(db, () => {
    const value = task(db), projectId = randomUUID();
    assert.throws(() => insert(db, 'edit_tasks', {...value, projectId, input:JSON.stringify({projectId, requestId:value.requestId})}), /FOREIGN KEY/);
  });
  assert.deepEqual(snapshot(db), before);
});

test('ordinary26 preserves unrelated custom table/index/trigger/view without executing imported DDL', t => {
  const db = database(t);
  db.exec("CREATE TABLE custom_notes(id INTEGER PRIMARY KEY,value); INSERT INTO custom_notes VALUES(7,x'00FF'),(8,2.125); CREATE INDEX custom_note_value ON custom_notes(value); CREATE TRIGGER custom_note_watch AFTER UPDATE ON custom_notes BEGIN SELECT 1;END; CREATE VIEW custom_project_view AS SELECT id FROM projects");
  const before = snapshot(db); initializeWorkspaceSchema26(db); preserved(db, before);
});

for (const [name, sql] of [
  ['custom attached index','CREATE INDEX custom_task_digest ON edit_tasks(digest)'],
  ['custom attached trigger','CREATE TRIGGER custom_task_watch AFTER UPDATE ON edit_tasks BEGIN SELECT 1;END'],
  ['dependent view','CREATE VIEW custom_tasks AS SELECT id FROM "EDIT_TASKS"'],
  ['external trigger dependency','CREATE TRIGGER custom_project_watch AFTER UPDATE ON projects BEGIN SELECT id FROM [edit_tasks];END'],
  ['marker trigger',"CREATE TRIGGER custom_marker AFTER INSERT ON schema_version BEGIN UPDATE projects SET data='changed';END"],
  ['inbound cascade FK',"CREATE TABLE custom_task_children(id TEXT REFERENCES edit_tasks(id) ON DELETE CASCADE); INSERT INTO custom_task_children SELECT id FROM edit_tasks"],
  ['inbound restrict FK','CREATE TABLE custom_task_children(id TEXT REFERENCES edit_tasks(id) ON DELETE RESTRICT)'],
  ['additional task column','ALTER TABLE edit_tasks ADD COLUMN custom TEXT'],
  ['changed protection','DROP TRIGGER retain_edit_tasks; CREATE TRIGGER retain_edit_tasks BEFORE DELETE ON edit_tasks BEGIN SELECT 1;END'],
  ['missing protection','DROP INDEX edit_tasks_project_page'],
  ['staging collision','CREATE TABLE edit_tasks_loudness_v26(value)'],
  ['restore residue','CREATE TABLE workspace_restoration(value)'],
  ['TEMP task trigger','CREATE TEMP TRIGGER custom_temp_task AFTER INSERT ON main.edit_tasks BEGIN SELECT 1;END'],
  ['TEMP marker trigger','CREATE TEMP TRIGGER custom_temp_marker AFTER INSERT ON main.schema_version BEGIN SELECT 1;END'],
  ['TEMP dependent view','CREATE TEMP VIEW custom_temp_view AS SELECT id FROM main.edit_tasks'],
]) test(`ordinary26 rejects ${name} before schema or data effects`, t => {
  const db = database(t); db.exec(sql); const temp = snapshot(db, 'temp');
  noMutation(db, initializeWorkspaceSchema26); assert.deepEqual(snapshot(db, 'temp'), temp);
});

for (const [name, sql] of [
  ['missing marker','DELETE FROM schema_version WHERE version=12'],
  ['restored25 marker','INSERT INTO schema_version VALUES(25)'],
  ['unexpanded26 marker','INSERT INTO schema_version VALUES(26)'],
  ['future27 marker','INSERT INTO schema_version VALUES(27)'],
  ['unknown signed64 marker','INSERT INTO schema_version VALUES(9223372036854775807)'],
  ['negative marker','INSERT INTO schema_version VALUES(-1)'],
  ['duplicate sequence',"INSERT INTO sqlite_sequence(name,seq) VALUES('edit_tasks',100)"],
  ['absent occupied sequence',"DELETE FROM sqlite_sequence WHERE name='edit_tasks'"],
  ['low sequence',"UPDATE sqlite_sequence SET seq=1 WHERE name='edit_tasks'"],
  ['negative sequence',"UPDATE sqlite_sequence SET seq=-1 WHERE name='edit_tasks'"],
  ['real sequence',"UPDATE sqlite_sequence SET seq=100.5 WHERE name='edit_tasks'"],
  ['text sequence',"UPDATE sqlite_sequence SET seq='unknown' WHERE name='edit_tasks'"],
  ['blob sequence',"UPDATE sqlite_sequence SET seq=x'313030' WHERE name='edit_tasks'"],
]) test(`ordinary26 rejects ${name} without repairing or rewriting old records`, t => {
  const db = database(t); db.exec(sql); noMutation(db, initializeWorkspaceSchema26);
});

for (const profile of ['restored-25','restored-25-seeded','restored-25-mock-seeded']) test(`ordinary26 never migrates frozen ${profile}`, t => {
  const db = database(t, profile); noMutation(db, initializeWorkspaceSchema26); noMutation(db, validateWorkspaceSchema26);
});

test('ordinary26 read-only validator does not bootstrap24 and rejects lost/mixed markers', t => {
  const db = database(t); noMutation(db, validateWorkspaceSchema26); initializeWorkspaceSchema26(db);
  for (const sql of ['DELETE FROM schema_version WHERE version=26','INSERT INTO schema_version VALUES(25)','DELETE FROM schema_version WHERE version=12']) {
    probe(db, () => { db.exec(sql); assert.throws(() => validateWorkspaceSchema26(db), {code:'RESTORE_SCHEMA_UNSUPPORTED'}); });
  }
});

test('ordinary26 main-qualified migration ignores harmless TEMP table shadows and preserves them', t => {
  const db = database(t); db.exec('CREATE TEMP TABLE edit_tasks(value); INSERT INTO temp.edit_tasks VALUES(73); CREATE TEMP TABLE schema_version(value); INSERT INTO temp.schema_version VALUES(25)');
  const temp = snapshot(db, 'temp'); initializeWorkspaceSchema26(db); validateWorkspaceSchema26(db); assert.deepEqual(snapshot(db, 'temp'), temp);
  assert.equal(db.prepare('SELECT max(version) AS version FROM main.schema_version').get().version,26);
});

test('ordinary26 refuses unsafe connection settings and nested transactions', t => {
  const db = database(t), before = snapshot(db);
  db.exec('PRAGMA foreign_keys=OFF'); assert.throws(() => initializeWorkspaceSchema26(db), /unsafe connection/); db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA trusted_schema=ON'); assert.throws(() => initializeWorkspaceSchema26(db), /unsafe connection/); db.exec('PRAGMA trusted_schema=OFF');
  db.exec('BEGIN'); assert.throws(() => initializeWorkspaceSchema26(db), /nested/); assert.equal(db.isTransaction,true); db.exec('ROLLBACK');
  assert.deepEqual(snapshot(db),before);
});

test('ordinary26 rolls back every DDL/copy/index/trigger/sequence/marker stage before and after native execution', async t => {
  const reference = database(t); populate(reference); const stages = writes(reference);
  assert.equal(stages.length,16, 'begin/create/copy/drop/rename + 3 indexes + 4 triggers + delete/restore sequence + marker + commit');
  for (const stage of stages) for (const phase of ['before','after']) {
    if (stage.sql === 'COMMIT' && phase === 'after') continue;
    await t.test(`${phase} ${stage.index}: ${stage.sql.split('\n')[0].slice(0,90)}`, () => {
      const db = open(':memory:');
      try {
        fixture(db); populate(db); const before = snapshot(db);
        const fault = new Error(`injected ${phase} stage ${stage.index}`);
        assert.throws(() => initializeWorkspaceSchema26(facade(db, value => {
          if (value.index === stage.index && value.phase === phase) throw fault;
        })), error => error === fault);
        assert.equal(db.isTransaction,false);
        assert.deepEqual(snapshot(db),before,'failed transaction restores exact logical catalog, raw rows, receipts and sequence');
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
        initializeWorkspaceSchema26(db); preserved(db,before);
      } finally { db.close(); }
    });
  }
});

async function killAt(filename, stage) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./workspace-schema26-kill-child.mjs', import.meta.url)), filename, String(stage.index)], {stdio:['ignore','pipe','pipe']});
  let stderr = '', stdout = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const result = once(child, 'exit');
  try {
    const reached = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`child did not reach stage ${stage.index}: ${stderr}`)),15000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`child exited before kill ${code}/${signal}: ${stderr}`)); });
      child.stdout.setEncoding('utf8').on('data', chunk => {
        stdout += chunk;
        if (!stdout.includes('\n')) return;
        clearTimeout(timeout);
        try { resolve(JSON.parse(stdout.slice(0,stdout.indexOf('\n')))); } catch (error) { reject(error); }
      });
    });
    assert.equal(reached.index,stage.index); assert.equal(reached.sql,stage.sql); assert.equal(reached.journal,'wal');
    assert.equal(reached.transaction,stage.sql !== 'COMMIT');
    assert.equal(child.kill('SIGKILL'),true);
    const [code, signal] = await result;
    assert.equal(code,null); assert.equal(signal,'SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await result; }
  }
}

test('real WAL child SIGKILL at every migration write cold-reopens complete24 or committed26 and converges on reentry', async t => {
  const root = directory(t), reference = database(t), stages = writes(reference);
  for (const stage of stages) {
    await t.test(`SIGKILL after native stage ${stage.index}: ${stage.sql.split('\n')[0].slice(0,90)}`, async () => {
      const filename = path.join(root, `stage-${stage.index}.sqlite`);
      let db = open(filename), before;
      try { fixture(db); populate(db); db.exec('PRAGMA journal_mode=WAL'); before=snapshot(db); } finally { db.close(); }
      await killAt(filename,stage);
      db = open(filename);
      try {
        if (stage.sql === 'COMMIT') preserved(db,before);
        else assert.deepEqual(snapshot(db),before,'SQLite cold recovery returns the exact complete ordinary24 logical state');
        assert.equal(db.prepare("SELECT count(*) AS count FROM main.sqlite_schema WHERE name='edit_tasks_loudness_v26'").get().count,0);
        initializeWorkspaceSchema26(db); preserved(db,before);
        const after = snapshot(db); db.close(); db=open(filename);
        validateWorkspaceSchema26(db); initializeWorkspaceSchema26(db); assert.deepEqual(snapshot(db),after);
      } finally { db.close(); }
    });
  }
});


test('non-integer sequence projection masks giant TEXT/BLOB payloads before they cross into JavaScript', () => {
  assertBoundedSequenceProjection(initializeWorkspaceSchema26);
});

test('complete24 read-only migration preflight rejects marker trigger before frozen bootstrap', t => {
  const db = database(t), before = snapshot(db);
  validateWorkspaceSchema24For26Migration(db);
  assert.deepEqual(snapshot(db), before, 'complete24 preflight is read-only');
  db.exec("CREATE TRIGGER imported_marker_side_effect AFTER INSERT ON schema_version BEGIN UPDATE projects SET data='changed';END");
  noMutation(db, validateWorkspaceSchema24For26Migration);
});
