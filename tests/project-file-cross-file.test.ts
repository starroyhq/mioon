import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {SQLInputValue} from 'node:sqlite';
import {readFormat72} from './helpers/project-file-schema-derivation.ts';
import {buildDatabase, schemaStatements} from '../packages/business/src/project-file/schema/databases.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {CROSS_FILE_RELATIONS} from '../packages/business/src/project-file/cross-file/relations.ts';
import type {CrossFileRelation} from '../packages/business/src/project-file/cross-file/relations.ts';
import {CONVERTED_TEMP_TRIGGERS} from '../packages/business/src/project-file/cross-file/converted-triggers.ts';
import {
  crossFileTriggerStatements, installCrossFileTriggers, relationConstraintName, relationTriggerStatements, FOREIGN_KEY_MESSAGE, SEEN_SEQUENCE_TRIGGER,
} from '../packages/business/src/project-file/cross-file/install.ts';
import {foreignKeyCheck, schemaObjects} from '../packages/business/src/project-file/cross-file/inspect.ts';

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const plain = <T extends object>(row: T | undefined): T | undefined => row === undefined ? undefined : {...row};
const storedText = (sql: string): string => sql.replace(/^CREATE TEMP TRIGGER /, 'CREATE TRIGGER ');

/** The kernel connection's layout in memory: history.db is main, the project
 * file is attached as project and cache.db as cache. */
function attachedConnection(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS project");
  db.exec("ATTACH DATABASE ':memory:' AS cache");
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}
function kernelConnection(): DatabaseSync {
  const db = attachedConnection();
  db.exec('BEGIN');
  buildDatabase(db, 'history', 'main');
  buildDatabase(db, 'project', 'project');
  buildDatabase(db, 'cache', 'cache');
  db.exec('COMMIT');
  installCrossFileTriggers(db);
  return db;
}
/** The metadata rows first, then the project row with the same ID. */
function addProject(db: DatabaseSync): string {
  const projectId = randomUUID();
  db.prepare('INSERT INTO main.history_state VALUES(1,?,0)').run(projectId);
  db.prepare('INSERT INTO project.project_file VALUES(1,?,0)').run(projectId);
  db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId, '{}');
  return projectId;
}
function sqliteError(action: () => unknown): {message: string; errcode: number} {
  try {
    action();
  } catch (error) {
    return {message: (error as Error).message, errcode: Number((error as {errcode?: unknown}).errcode)};
  }
  assert.fail('expected an SQLite error');
}
const sequences = (db: DatabaseSync) => ({
  file: Number(db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence),
  seen: Number(db.prepare('SELECT seenContentSequence FROM main.history_state').get()?.seenContentSequence),
});

// ---------------------------------------------------------------------------
// Stand-in tables: the same constraint as a real same-file foreign key and as the emulation

interface Column {readonly name: string; readonly type: string; readonly notnull: boolean}
function columnsOf(db: DatabaseSync, schema: string, table: string, names: readonly string[]): Column[] {
  const info = new Map(db.prepare('SELECT name,type,"notnull" AS required FROM pragma_table_xinfo(?,?)').all(table, schema).map(row => [String(row.name), row] as const));
  return names.map(name => {
    const row = info.get(name);
    assert.ok(row, `${schema}.${table} has no column ${name}`);
    return {name, type: String(row.type), notnull: Number(row.required) === 1};
  });
}
const definition = (column: Column): string => [quote(column.name), column.type, column.notnull ? 'NOT NULL' : ''].filter(Boolean).join(' ');

interface Pair {readonly reference: DatabaseSync; readonly kernel: DatabaseSync}
/** The reference keeps parent and child in one database with a real foreign key
 * (deferred where format 72 deferred it); the kernel side puts the parent in
 * `project`, the child in the relation's own schema and installs the four
 * generated triggers for the stand-in names. Both use the real key columns. */
function standInPair(relation: CrossFileRelation, childColumns: readonly Column[], parentColumns: readonly Column[]): Pair {
  for (const column of [...childColumns, ...parentColumns]) assert.ok(!['rowKey', 'note', 'info'].includes(column.name), column.name);
  const parentKey = parentColumns.map(column => quote(column.name)).join(','), childKey = childColumns.map(column => quote(column.name)).join(',');
  const parentTable = (schema: string) => `CREATE TABLE ${schema}.parent(${parentColumns.map(definition).join(',')},note TEXT,info TEXT,UNIQUE(${parentKey}))`;
  const childBody = `rowKey INTEGER PRIMARY KEY,${childColumns.map(definition).join(',')},info TEXT`;
  const reference = new DatabaseSync(':memory:');
  reference.exec('PRAGMA foreign_keys=ON');
  reference.exec(parentTable('main'));
  reference.exec(`CREATE TABLE main.child(${childBody},FOREIGN KEY(${childKey}) REFERENCES parent(${parentKey})${relation.originallyDeferred ? ' DEFERRABLE INITIALLY DEFERRED' : ''})`);
  const kernel = attachedConnection();
  kernel.exec(parentTable(relation.parent.schema));
  kernel.exec(`CREATE TABLE ${relation.child.schema}.child(${childBody})`);
  for (const sql of relationTriggerStatements(relation, {child: {table: 'child'}, parent: {table: 'parent'}})) kernel.exec(sql);
  return {reference, kernel};
}
function realColumns(db: DatabaseSync, relation: CrossFileRelation): {child: Column[]; parent: Column[]} {
  return {
    child: columnsOf(db, relation.child.schema, relation.child.table, relation.child.columns),
    parent: columnsOf(db, relation.parent.schema, relation.parent.table, relation.parent.columns),
  };
}

const numbers = new Map<string, number>();
function keyValue(column: Column, label: string): SQLInputValue {
  if (!/INT/i.test(column.type)) return label;
  if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
  return numbers.get(label)!;
}

interface Operation {readonly label: string; readonly sql: string; readonly values?: readonly SQLInputValue[]}
type Outcome = {readonly ok: true} | {readonly ok: false; readonly message: string; readonly errcode: number};
function run(db: DatabaseSync, operation: Operation): Outcome {
  try {
    db.prepare(operation.sql).run(...operation.values ?? []);
    return {ok: true};
  } catch (error) {
    return {ok: false, message: (error as Error).message, errcode: Number((error as {errcode?: unknown}).errcode)};
  }
}
const described = (operation: Operation, outcome: Outcome): string => `${operation.label}: ${outcome.ok ? 'ok' : outcome.message}`;

/** One sequence of writes, run in autocommit mode on both sides. */
function equivalenceOperations(parentColumns: readonly Column[], childColumns: readonly Column[]): Operation[] {
  const n = parentColumns.length, names = childColumns.map(column => column.name);
  const parentKey = parentColumns.map(column => quote(column.name)), childKey = childColumns.map(column => quote(column.name));
  const key = (tag: string) => parentColumns.map((column, i) => keyValue(column, `${tag}-${i}`));
  const marks = (count: number) => Array.from({length: count}, () => '?').join(',');
  const replaced = (tuple: readonly SQLInputValue[], at: number, value: SQLInputValue) => tuple.map((item, i) => i === at ? value : item);
  const [a, b, missing, other] = [key('a'), key('b'), key('missing'), key('new')];
  const every = parentColumns.map((_, i) => i);
  const operations: Operation[] = [];
  const add = (label: string, sql: string, values: readonly SQLInputValue[] = []) => { operations.push({label, sql, values}); };
  const insertParent = (tag: string, tuple: readonly SQLInputValue[]) => add(`insert parent ${tag}`, `INSERT INTO parent(${parentKey.join(',')},note) VALUES(${marks(n + 1)})`, [...tuple, tag]);
  const insertChild = (label: string, tuple: readonly SQLInputValue[]) => add(label, `INSERT INTO child(${childKey.join(',')}) VALUES(${marks(n)})`, tuple);
  const setChild = (label: string, columns: readonly number[], values: readonly SQLInputValue[]) => add(label, `UPDATE child SET ${columns.map(i => `${childKey[i]!}=?`).join(',')} WHERE rowKey=1`, values);
  const setParent = (label: string, note: string, columns: readonly number[], values: readonly SQLInputValue[]) => add(label, `UPDATE parent SET ${columns.map(i => `${parentKey[i]!}=?`).join(',')} WHERE note='${note}'`, values);
  insertParent('a', a);
  insertParent('b', b);
  insertChild('insert a child whose parent exists', a);
  insertChild('insert a child whose parent is missing', missing);
  for (let i = 0; i < n; i++) insertChild(`insert a child with ${names[i]!} NULL and the other columns unmatched`, replaced(missing, i, null));
  if (n > 1) for (let i = 0; i < n; i++) insertChild(`insert a child that differs from its parent only in ${names[i]!}`, replaced(a, i, missing[i]!));
  add('replace the child row with one whose parent is missing', `INSERT OR REPLACE INTO child(rowKey,${childKey.join(',')}) VALUES(1,${marks(n)})`, missing);
  setChild('set the child key to a missing parent', every, missing);
  if (n > 1) for (let i = 0; i < n; i++) setChild(`set only the child's ${names[i]!} so that no parent matches`, [i], [missing[i]!]);
  setChild('set the child key to another existing parent', every, b);
  setChild('set the child key back', every, a);
  setChild('set the child key to its current value', every, a);
  add('update a non-key child column', "UPDATE child SET info='changed' WHERE rowKey=1");
  add('delete a referenced parent', "DELETE FROM parent WHERE note='a'");
  add('delete an unreferenced parent', "DELETE FROM parent WHERE note='b'");
  insertParent('b', b);
  add('update a non-key parent column', "UPDATE parent SET info='changed' WHERE note='a'");
  add('upsert a referenced parent without touching its key', `INSERT INTO parent(${parentKey.join(',')},note) VALUES(${marks(n + 1)}) ON CONFLICT(${parentKey.join(',')}) DO UPDATE SET info='upserted'`, [...a, 'a']);
  add('replace a referenced parent row with the same key', `INSERT OR REPLACE INTO parent(${parentKey.join(',')},note,info) VALUES(${marks(n + 2)})`, [...a, 'a', 'replaced']);
  add('set a referenced parent key to the same value', `UPDATE parent SET ${parentKey.map(column => `${column}=${column}`).join(',')} WHERE note='a'`);
  for (let i = 0; i < n; i++) setParent(`change the ${parentColumns[i]!.name} of a referenced parent`, 'a', [i], [other[i]!]);
  if (n > 1) setParent('change the whole key of a referenced parent', 'a', every, other);
  setParent('change the key of an unreferenced parent', 'b', every, other);
  add('delete the referencing child', 'DELETE FROM child WHERE rowKey=1');
  for (let i = 0; i < n; i++) insertChild(`insert a child that matches the parent but has ${names[i]!} NULL`, replaced(a, i, null));
  add('delete a parent whose children all have a NULL key column', "DELETE FROM parent WHERE note='a'");
  return operations;
}

test('each emulated relation behaves like its format-72 foreign key on stand-in tables', t => {
  const real = kernelConnection();
  let operationCount = 0, foreignKeyFailures = 0;
  try {
    for (const relation of CROSS_FILE_RELATIONS) {
      const columns = realColumns(real, relation), pair = standInPair(relation, columns.child, columns.parent);
      try {
        const operations = equivalenceOperations(columns.parent, columns.child);
        const reference = operations.map(operation => run(pair.reference, operation)), kernel = operations.map(operation => run(pair.kernel, operation));
        const name = relationConstraintName(relation);
        assert.deepEqual(kernel.map((outcome, i) => described(operations[i]!, outcome)), reference.map((outcome, i) => described(operations[i]!, outcome)), name);
        let failures = 0;
        reference.forEach((outcome, i) => {
          if (outcome.ok) return;
          // Only the code of a foreign-key failure differs: SQLITE_CONSTRAINT_FOREIGNKEY becomes SQLITE_CONSTRAINT_TRIGGER.
          const emulated = kernel[i]!;
          assert.ok(!emulated.ok);
          if (outcome.message === FOREIGN_KEY_MESSAGE) {
            assert.deepEqual([outcome.errcode, emulated.errcode], [787, 1811], `${name}: ${operations[i]!.label}`);
            failures++;
          } else {
            assert.equal(emulated.errcode, outcome.errcode, `${name}: ${operations[i]!.label}`);
          }
        });
        // Single-column keys run 23 writes, 5 of them refused for a missing or referenced parent; composite keys more.
        assert.ok(operations.length >= 23 && failures >= 5 && reference.filter(outcome => outcome.ok).length >= 15, name);
        operationCount += operations.length;
        foreignKeyFailures += failures;
      } finally {
        pair.reference.close();
        pair.kernel.close();
      }
    }
  } finally {
    real.close();
  }
  t.diagnostic(`${CROSS_FILE_RELATIONS.length} relations, ${operationCount} writes on each side, ${foreignKeyFailures} refused as FOREIGN KEY constraint failed`);
});

test('the two formerly deferred relations now check immediately: backfilling after the parent row passes, other orders fail at once (intended narrowing)', () => {
  const real = kernelConnection();
  try {
    const deferred = CROSS_FILE_RELATIONS.filter(relation => relation.originallyDeferred);
    assert.deepEqual(deferred.map(relation => `${relation.child.table}->${relation.parent.table}`), ['image_tasks->image_versions', 'scene_tasks->scene_results']);
    for (const relation of deferred) {
      const columns = realColumns(real, relation), pair = standInPair(relation, columns.child, columns.parent);
      try {
        // The backfilled column: image_tasks.versionId, scene_tasks.resultId.
        const backfill = relation.child.nullable.indexOf(true);
        assert.equal(relation.child.nullable.filter(Boolean).length, 1);
        const childKey = columns.child.map(column => quote(column.name)), parentKey = columns.parent.map(column => quote(column.name));
        const fixed = (row: number) => columns.parent.map((column, i) => keyValue(column, `row${row}-${i}`));
        const result = (row: number, version = 'v') => fixed(row).map((value, i) => i === backfill ? keyValue(columns.parent[i]!, `row${row}-${version}`) : value);
        const insertResult = (row: number, version = 'v'): Operation => ({label: 'insert the result row', sql: `INSERT INTO parent(${parentKey.join(',')}) VALUES(${parentKey.map(() => '?').join(',')})`, values: result(row, version)});
        const setBackfill = (row: number, version: string | null): Operation => ({label: version === null ? 'clear the task\'s result column' : 'backfill the task\'s result column',
          sql: `UPDATE child SET ${childKey[backfill]!}=? WHERE rowKey=${row}`, values: [version === null ? null : result(row, version)[backfill]!]});
        const deleteResult = (row: number): Operation => ({label: 'delete the result row', sql: `DELETE FROM parent WHERE ${parentKey.map(column => `${column}=?`).join(' AND ')}`, values: result(row)});
        const rekeyResult = (row: number): Operation => ({label: 'change the result row key', sql: `UPDATE parent SET ${parentKey[backfill]!}=? WHERE ${parentKey.map(column => `${column}=?`).join(' AND ')}`, values: [result(row, 'w')[backfill]!, ...result(row)]});
        /** Runs the steps in one transaction and stops at the first failure, as the writing code would. */
        const transaction = (db: DatabaseSync, steps: readonly Operation[]): string[] => {
          const log: string[] = [];
          db.exec('BEGIN');
          for (const step of steps) {
            const outcome = run(db, step);
            log.push(described(step, outcome));
            if (!outcome.ok) { db.exec('ROLLBACK'); return log; }
          }
          const commit = {label: 'COMMIT', sql: 'COMMIT'};
          log.push(described(commit, run(db, commit)));
          if (db.isTransaction) db.exec('ROLLBACK');
          return log;
        };
        for (const db of [pair.reference, pair.kernel]) {
          for (let row = 1; row <= 7; row++) db.prepare(`INSERT INTO child(rowKey,${childKey.join(',')}) VALUES(${row},${childKey.map(() => '?').join(',')})`).run(...fixed(row).map((value, i) => i === backfill ? null : value));
          // Rows 4-7 start bound to their result row (in autocommit, so both sides accept it).
          for (const row of [4, 5, 6, 7]) for (const step of [insertResult(row), setBackfill(row, 'v')]) assert.deepEqual(run(db, step), {ok: true}, step.label);
        }
        const fk = FOREIGN_KEY_MESSAGE, ok = 'COMMIT: ok';
        const scenarios: readonly {readonly steps: readonly Operation[]; readonly reference: readonly string[]; readonly kernel: readonly string[]}[] = [
          // images.ts:258-260 and scene-tasks.ts:329-332: insert the result row, then backfill the task.
          {steps: [insertResult(1), setBackfill(1, 'v')], reference: ['insert the result row: ok', 'backfill the task\'s result column: ok', ok], kernel: ['insert the result row: ok', 'backfill the task\'s result column: ok', ok]},
          // The reverse order: the reference waits for COMMIT, the emulation stops at the backfill.
          {steps: [setBackfill(2, 'v'), insertResult(2)], reference: ['backfill the task\'s result column: ok', 'insert the result row: ok', ok], kernel: [`backfill the task's result column: ${fk}`]},
          {steps: [setBackfill(3, 'v')], reference: ['backfill the task\'s result column: ok', `COMMIT: ${fk}`], kernel: [`backfill the task's result column: ${fk}`]},
          // Delete path: deleting the parent before clearing the child now fails at the delete.
          {steps: [deleteResult(4), setBackfill(4, null)], reference: ['delete the result row: ok', 'clear the task\'s result column: ok', ok], kernel: [`delete the result row: ${fk}`]},
          {steps: [setBackfill(5, null), deleteResult(5)], reference: ['clear the task\'s result column: ok', 'delete the result row: ok', ok], kernel: ['clear the task\'s result column: ok', 'delete the result row: ok', ok]},
          // Key-change path: the same holds for changing the referenced key.
          {steps: [rekeyResult(6), setBackfill(6, 'w')], reference: ['change the result row key: ok', 'backfill the task\'s result column: ok', ok], kernel: [`change the result row key: ${fk}`]},
          {steps: [setBackfill(7, null), rekeyResult(7), setBackfill(7, 'w')], reference: ['clear the task\'s result column: ok', 'change the result row key: ok', 'backfill the task\'s result column: ok', ok],
            kernel: ['clear the task\'s result column: ok', 'change the result row key: ok', 'backfill the task\'s result column: ok', ok]},
        ];
        for (const scenario of scenarios) {
          assert.deepEqual(transaction(pair.reference, scenario.steps), scenario.reference, `${relationConstraintName(relation)} reference`);
          assert.deepEqual(transaction(pair.kernel, scenario.steps), scenario.kernel, `${relationConstraintName(relation)} kernel`);
        }
      } finally {
        pair.reference.close();
        pair.kernel.close();
      }
    }
  } finally {
    real.close();
  }
  // On the real tables the delete and key-change paths never happen: format 72 already keeps
  // image versions and scene results immutable and retained, unconditionally.
  const project = schemaStatements('project');
  for (const table of ['image_versions', 'scene_results']) {
    for (const event of ['DELETE', 'UPDATE']) assert.ok(project.some(sql => new RegExp(`^CREATE TRIGGER \\w+ BEFORE ${event} ON ${table}\\s+BEGIN SELECT RAISE\\(ABORT,`).test(sql)), `${table} ${event}`);
  }
});

test('installed connection-level triggers are exactly the generated statements', () => {
  const db = kernelConnection();
  try {
    const statements = crossFileTriggerStatements();
    // 26 converted format-72 triggers + 4 per relation + the content-sequence copy.
    // scene_task_state_transitions reads no other database, so it is not among them.
    assert.deepEqual([CONVERTED_TEMP_TRIGGERS.length, CROSS_FILE_RELATIONS.length, statements.length], [26, 55, 247]);
    const stored = db.prepare("SELECT type,name,tbl_name,sql FROM temp.sqlite_master ORDER BY rowid").all();
    assert.ok(stored.every(row => row.type === 'trigger'));
    assert.deepEqual(stored.map(row => row.sql), statements.map(storedText));
    assert.deepEqual(stored.map(row => row.name), [
      ...CONVERTED_TEMP_TRIGGERS.map(trigger => trigger.name),
      ...CROSS_FILE_RELATIONS.flatMap(relation => ['child_insert', 'child_update', 'parent_delete', 'parent_update'].map(event => `${relationConstraintName(relation)}_${event}`)),
      'project_file_seen_sequence',
    ]);
    assert.deepEqual(stored.slice(26, -1).map(row => row.tbl_name), CROSS_FILE_RELATIONS.flatMap(relation => [relation.child.table, relation.child.table, relation.parent.table, relation.parent.table]));
    assert.equal(statements.at(-1), SEEN_SEQUENCE_TRIGGER);
    assert.equal(SEEN_SEQUENCE_TRIGGER, 'CREATE TEMP TRIGGER project_file_seen_sequence AFTER UPDATE OF contentSequence ON project.project_file BEGIN UPDATE history_state SET seenContentSequence=NEW.contentSequence;END');
    const jobs = CROSS_FILE_RELATIONS.find(relation => relation.child.table === 'jobs')!;
    const fail = "BEGIN SELECT RAISE(ABORT,'FOREIGN KEY constraint failed');END";
    assert.deepEqual(relationTriggerStatements(jobs), [
      `CREATE TEMP TRIGGER project_file_fk_30_child_insert BEFORE INSERT ON "main"."jobs" WHEN NEW."projectId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "project"."projects" WHERE "id"=NEW."projectId") ${fail}`,
      `CREATE TEMP TRIGGER project_file_fk_30_child_update BEFORE UPDATE OF "projectId" ON "main"."jobs" WHEN NEW."projectId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "project"."projects" WHERE "id"=NEW."projectId") ${fail}`,
      `CREATE TEMP TRIGGER project_file_fk_30_parent_delete BEFORE DELETE ON "project"."projects" WHEN EXISTS(SELECT 1 FROM "main"."jobs" WHERE "projectId"=OLD."id") ${fail}`,
      `CREATE TEMP TRIGGER project_file_fk_30_parent_update BEFORE UPDATE OF "id" ON "project"."projects" WHEN (OLD."id" IS NOT NEW."id") AND EXISTS(SELECT 1 FROM "main"."jobs" WHERE "projectId"=OLD."id") ${fail}`,
    ]);
    assert.match(relationTriggerStatements(CROSS_FILE_RELATIONS.find(relation => relation.index === 41)!)[3]!,
      / BEFORE UPDATE OF "id","projectId" ON "project"\."scene_results" WHEN \(OLD\."id" IS NOT NEW\."id" OR OLD\."projectId" IS NOT NEW\."projectId"\) AND EXISTS\(SELECT 1 FROM "main"\."scene_tasks" WHERE "resultId"=OLD\."id" AND "projectId"=OLD\."projectId"\) /);
    assert.match(relationTriggerStatements(jobs, {child: {schema: 'x', table: 'c"t'}, parent: {table: 'p'}})[0]!, / ON "x"\."c""t" WHEN .* FROM "project"\."p" WHERE /);
  } finally {
    db.close();
  }
});

test('converted triggers restore to their format-72 text', () => {
  const originals = new Map(readFormat72().objects.filter(object => object.type === 'trigger').map(object => [object.name, object.sql] as const));
  const exemption = "NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='projects')";
  let restored = 0;
  for (const trigger of CONVERTED_TEMP_TRIGGERS) {
    let sql = storedText(trigger.sql).replace(/\b(?:project|main|cache)\./g, '');
    if (/^agent_target_(?:jobs|exports|image_tasks|frame_tasks)_(?:insert|update|delete)_v2$/.test(trigger.name)) {
      // Put the project-deletion exemption back: `WHEN X BEGIN` for insert and delete, `WHEN X AND (` for update.
      sql = sql.replace(/^(CREATE TRIGGER \w+ AFTER (?:INSERT|UPDATE|DELETE) ON \w+) (WHEN )?/, (_, head: string, when?: string) => `${head} WHEN ${exemption} ${when ? 'AND ' : ''}`);
      restored++;
    }
    assert.equal(sql, originals.get(trigger.name), trigger.name);
  }
  assert.equal(restored, 12);
});

test('with all three databases attached and the triggers installed, every write to every table compiles', () => {
  const db = kernelConnection();
  let tables = 0;
  try {
    for (const schema of ['main', 'project', 'cache']) {
      for (const table of db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name`).all().map(row => String(row.name))) {
        const target = `${schema}.${quote(table)}`;
        const columns = db.prepare('SELECT name FROM pragma_table_xinfo(?,?) WHERE hidden=0').all(table, schema).map(row => quote(String(row.name)));
        for (const sql of [`EXPLAIN INSERT INTO ${target} DEFAULT VALUES`, `EXPLAIN UPDATE ${target} SET ${columns.map(column => `${column}=${column}`).join(',')}`, `EXPLAIN DELETE FROM ${target}`]) {
          assert.doesNotThrow(() => db.prepare(sql).all(), `${schema}: ${sql}`);
        }
        tables++;
      }
    }
  } finally {
    db.close();
  }
  // main also holds the Mock provider's two ledger tables.
  assert.equal(tables, 47 + 2 + 20 + 3);
});

test('real tables: cross-file keys, process-entity revisions and the content sequence', () => {
  const db = kernelConnection();
  try {
    const projectId = addProject(db), elsewhere = randomUUID(), jobId = randomUUID();
    assert.deepEqual(sequences(db), {file: 2, seen: 2});
    assert.deepEqual(sqliteError(() => db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(jobId, elsewhere, '{}')), {message: FOREIGN_KEY_MESSAGE, errcode: 1811});
    db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(jobId, projectId, '{}');
    const revision = () => plain(db.prepare("SELECT projectId,kind,targetId,revision FROM project.agent_task_target_revisions_v2 WHERE kind='job'").get());
    assert.deepEqual(revision(), {projectId, kind: 'job', targetId: jobId, revision: 1});
    db.prepare('UPDATE jobs SET data=? WHERE id=?').run('{"status":"done"}', jobId);
    assert.deepEqual(revision(), {projectId, kind: 'job', targetId: jobId, revision: 2});
    // Process-entity revisions live in the project file, so job writes advance its content sequence too.
    assert.deepEqual(sequences(db), {file: 4, seen: 4});
    assert.deepEqual(sqliteError(() => db.prepare('UPDATE jobs SET projectId=? WHERE id=?').run(elsewhere, jobId)), {message: FOREIGN_KEY_MESSAGE, errcode: 1811});

    db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,0)').run(projectId);
    const deleteProject = () => sqliteError(() => db.prepare('DELETE FROM projects WHERE id=?').run(projectId));
    assert.deepEqual(deleteProject(), {message: FOREIGN_KEY_MESSAGE, errcode: 1811});
    // Connection-level triggers run before the project file's own single-project trigger.
    assert.deepEqual(sqliteError(() => db.prepare('UPDATE projects SET id=? WHERE id=?').run(elsewhere, projectId)), {message: FOREIGN_KEY_MESSAGE, errcode: 1811});
    db.prepare('DELETE FROM jobs WHERE id=?').run(jobId);
    assert.deepEqual(deleteProject(), {message: FOREIGN_KEY_MESSAGE, errcode: 1811}, 'timeline_history_cursors still refers to it');
    db.prepare('DELETE FROM timeline_history_cursors').run();
    // What remains is the project file's own foreign key from its target revisions.
    assert.deepEqual(deleteProject(), {message: FOREIGN_KEY_MESSAGE, errcode: 787});

    const waveform = (owner: string) => db.prepare('INSERT INTO waveform_cache(cacheKey,projectId,sourceSha256,algorithm,status,attemptId,data,bytes,reservedBytes) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID().replaceAll('-', '').padEnd(64, '0'), owner, 'a'.repeat(64), 'peaks-v1', 'ready', randomUUID(), '{}', 1, 0);
    assert.deepEqual(sqliteError(() => waveform(elsewhere)), {message: FOREIGN_KEY_MESSAGE, errcode: 1811});
    waveform(projectId);
    assert.equal(db.prepare('SELECT count(*) AS n FROM cache.waveform_cache').get()?.n, 1);

    const before = sequences(db);
    db.prepare('INSERT INTO shots(id,projectId,data) VALUES(?,?,?)').run(randomUUID(), projectId, '{}');
    const after = sequences(db);
    assert.ok(after.file > before.file);
    assert.equal(after.seen, after.file);
    db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,1)').run(projectId);
    assert.deepEqual(sequences(db), after, 'a local-records write leaves the content sequence alone');
    assert.deepEqual(foreignKeyCheck(db), []);
  } finally {
    db.close();
  }
});

test('foreignKeyCheck reports orphans written around the triggers; schemaObjects spans all four schemas', () => {
  const db = kernelConnection();
  try {
    addProject(db);
    const elsewhere = randomUUID();
    assert.deepEqual(foreignKeyCheck(db), []);
    const cursors = CROSS_FILE_RELATIONS.find(relation => relation.child.table === 'timeline_history_cursors')!;
    db.exec(`DROP TRIGGER temp.${relationConstraintName(cursors)}_child_insert`);
    db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,0)').run(elsewhere);
    const orphanRowid = Number(db.prepare('SELECT rowid FROM main.timeline_history_cursors WHERE projectId=?').get(elsewhere)?.rowid);
    assert.deepEqual(foreignKeyCheck(db).map(plain), [{schema: 'main', table: 'timeline_history_cursors', rowid: orphanRowid, parent: 'projects', parentSchema: 'project', constraint: 'project_file_fk_54'}]);
    assert.throws(() => installCrossFileTriggers(db), /partly installed: missing project_file_fk_54_child_insert$/);

    // A same-file orphan, written with SQLite's own foreign keys off.
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('INSERT INTO shots(id,projectId,data) VALUES(?,?,?)').run(randomUUID(), elsewhere, '{}');
    db.exec('PRAGMA foreign_keys=ON');
    const sameFile = foreignKeyCheck(db).filter(violation => violation.schema === 'project').map(violation => `${violation.table}->${violation.parentSchema}.${violation.parent} ${violation.constraint}`).sort();
    // agent_target_shots_insert_v2 wrote the shot's target revision under the same missing project.
    assert.deepEqual(sameFile, ['agent_task_target_revisions_v2->project.projects fk:0', 'shots->project.projects fk:0']);
    assert.equal(foreignKeyCheck(db).at(-1)?.constraint, 'project_file_fk_54');

    const objects = schemaObjects(db);
    assert.deepEqual([...new Set(objects.map(object => object.schema))], ['main', 'temp', 'project', 'cache']);
    const of = (schema: string) => objects.filter(object => object.schema === schema);
    assert.deepEqual([of('main').length, of('project').length, of('cache').length, of('temp').length],
      [SCHEMA_MANIFEST.history.entries.length, SCHEMA_MANIFEST.project.entries.length, SCHEMA_MANIFEST.cache.entries.length, 246]);
    for (const schema of ['main', 'temp', 'project', 'cache']) {
      const keys = of(schema).map(object => [object.type, object.name] as const);
      assert.deepEqual(keys, [...keys].sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0), `${schema} is sorted by type and name`);
    }
    const targetRevisions = of('temp').filter(object => /^agent_target_(?:jobs|exports|image_tasks|frame_tasks)_(?:insert|update|delete)_v2$/.test(object.name));
    assert.equal(targetRevisions.length, 12);
    assert.ok(targetRevisions.every(object => object.type === 'trigger' && object.sql?.startsWith(`CREATE TRIGGER ${object.name} AFTER `)));
    assert.equal(objects.find(object => object.schema === 'main' && object.name === 'jobs')?.sql, 'CREATE TABLE jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL)');
    assert.equal(objects.filter(object => object.name === 'agent_target_jobs_insert_v2').map(object => object.schema).join(), 'temp');
  } finally {
    db.close();
  }
});

test('installCrossFileTriggers is idempotent and refuses a connection it cannot complete', () => {
  const db = kernelConnection();
  try {
    const count = () => Number(db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE type='trigger'").get()?.n);
    assert.equal(count(), 247);
    installCrossFileTriggers(db);
    assert.equal(count(), 247);
    db.exec('CREATE TEMP TRIGGER extra AFTER INSERT ON main.jobs BEGIN SELECT 1;END');
    assert.throws(() => installCrossFileTriggers(db), /partly installed: unexpected extra$/);
  } finally {
    db.close();
  }

  const noCache = new DatabaseSync(':memory:');
  try {
    noCache.exec("ATTACH DATABASE ':memory:' AS project");
    assert.throws(() => installCrossFileTriggers(noCache), /need the cache database attached/);
  } finally {
    noCache.close();
  }

  const shadowed = attachedConnection();
  try {
    shadowed.exec('BEGIN');
    buildDatabase(shadowed, 'history', 'main');
    buildDatabase(shadowed, 'project', 'project');
    buildDatabase(shadowed, 'cache', 'cache');
    shadowed.exec('COMMIT');
    shadowed.exec('CREATE TEMP VIEW Agent_Task_Target_Revisions_V2 AS SELECT 1');
    assert.throws(() => installCrossFileTriggers(shadowed), /shadow project tables: Agent_Task_Target_Revisions_V2/);
  } finally {
    shadowed.close();
  }

  // The cache database is attached but empty: the cache triggers fail and nothing stays installed.
  const incomplete = attachedConnection();
  try {
    incomplete.exec('BEGIN');
    buildDatabase(incomplete, 'history', 'main');
    buildDatabase(incomplete, 'project', 'project');
    incomplete.exec('COMMIT');
    assert.throws(() => installCrossFileTriggers(incomplete), /no such table: cache\.previs_thumbnails/);
    assert.equal(incomplete.prepare("SELECT count(*) AS n FROM temp.sqlite_master").get()?.n, 0);
    assert.equal(incomplete.isTransaction, false);
  } finally {
    incomplete.close();
  }
});
