import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {buildDatabase, FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import type {ProjectFileFormat} from '../packages/business/src/project-file/schema/databases.ts';
import {compareManifest, readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {historyManifestForVersion, projectManifestForVersion} from '../packages/business/src/project-file/schema/format-manifests.ts';
import {assertEditorStorageCounters, assertEditorStorageInventory, editorStorageInventory} from '../packages/business/src/project-file/schema/domains/sequence.ts';
import {format5TimelineEntityColumns} from '../packages/business/src/project-file/format5-timeline.ts';
import {addFormat5HistoryStructureInside, addFormat5ProjectStructureInside, writeFormat5HistoryVersionInside, writeFormat5ProjectVersionInside} from '../packages/business/src/project-file/schema/format5-upgrade.ts';
import {installCrossFileTriggers, removeCrossFileTriggersInside} from '../packages/business/src/project-file/cross-file/install.ts';
import {foreignKeyCheck} from '../packages/business/src/project-file/cross-file/inspect.ts';
import {validateDeclaredSchema, declaredSchema} from './helpers/project-file-schema-derivation.ts';

const id = (number: number): string => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const at = '2026-01-01T00:00:00.000Z';
function connection(projectVersion: ProjectFileFormat = FORMAT5_PROJECT_SCHEMA_VERSION, historyVersion: number = FORMAT5_HISTORY_SCHEMA_VERSION): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; ATTACH ':memory:' AS project; ATTACH ':memory:' AS cache; BEGIN");
  buildDatabase(db, 'history', 'main', undefined, historyVersion);
  buildDatabase(db, 'project', 'project', undefined, projectVersion);
  buildDatabase(db, 'cache', 'cache');
  db.prepare('INSERT INTO project.project_file VALUES(1,?,0,?)').run(id(1), 'a'.repeat(32));
  db.prepare('INSERT INTO main.history_state VALUES(1,?,0,?)').run(id(1), 'a'.repeat(32));
  db.exec('COMMIT');
  installCrossFileTriggers(db, projectVersion);
  db.prepare('INSERT INTO project.projects VALUES(?,?)').run(id(1), '{}');
  return db;
}
const edge = (number: number, source = id(2), target = id(3)) => ({id: id(number), projectId: id(1), source, target, kind: 'sequence', createdAt: at});
function insertEdge(db: DatabaseSync, value: ReturnType<typeof edge> | Record<string, unknown>, archived = false): void {
  db.prepare('INSERT INTO project.edges(id,projectId,data,archivedAt,archiveBatchId,archiveReason) VALUES(?,?,?,?,?,?)').run(String(value.id), id(1), JSON.stringify(value), archived ? at : null, archived ? id(99) : null, archived ? 'user-delete' : null);
}

test('format 5 declares an independent exact project and history catalog', () => {
  validateDeclaredSchema(declaredSchema(FORMAT5_PROJECT_SCHEMA_VERSION));
  const db = connection();
  try {
    for (const [schema, expected, digest] of [
      ['project', projectManifestForVersion(FORMAT5_PROJECT_SCHEMA_VERSION), 'e1e8c1981367a2cea4cfcf2d86ee0a1ad0d143274ab32332b8ac9069736d80dd'],
      ['main', historyManifestForVersion(FORMAT5_HISTORY_SCHEMA_VERSION), '7372a5fff07b2d29a5ca6e913fcc3c75b0c6ab0582f2ac028cb1a3610efff1b5'],
    ] as const) {
      assert.ok(expected);
      const manifest = readSchemaManifest(db, schema);
      assert.deepEqual(compareManifest(manifest, expected.entries), {missing: [], unexpected: [], changed: []});
      assert.equal(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), digest);
    }
    assert.deepEqual(foreignKeyCheck(db), []);
  } finally {db.close();}
});

test('format 5 edge CHECK and partial uniqueness reject malformed/live ambiguous edges and retain archived bytes', () => {
  const db = connection();
  try {
    insertEdge(db, edge(10));
    for (const invalid of [edge(11), edge(12, id(4), id(3)), {...edge(13, id(4), id(5)), role: 'first_frame'}, {...edge(14, id(4), id(5)), kind: 'decorative'}, {...edge(15, id(4), id(5)), kind: 'reference', role: 'first_frame'}]) {
      assert.throws(() => insertEdge(db, invalid), /constraint/u);
    }
    insertEdge(db, edge(16), true);
    insertEdge(db, {...edge(17), kind: 'decorative'}, true);
    const reference = {...edge(18, id(4), id(3)), kind: 'reference', role: 'first_frame', sourceAssetId: id(20)};
    insertEdge(db, reference);
    assert.throws(() => insertEdge(db, {...reference, id: id(19), source: id(5)}), /constraint/u);
    assert.equal(db.prepare('SELECT count(*) AS n FROM project.edges').get()!.n, 4);
  } finally {db.close();}
});

test('format 5 native entity rows advance exactly the changed target revisions and keep raw byte semantics', () => {
  const db = connection();
  const at = '2026-01-01T00:00:00.000Z';
  const track = {id: id(2), name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false};
  const header = {id: id(5), projectId: id(1), revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 60,
    createdAt: at, updatedAt: at, mainTrack: {trackId: id(2), sequenceNodeId: id(3)}, tracks: [track]};
  const clip = (number: number, extra: Record<string, unknown> = {}) => ({id: id(number), trackId: id(2),
    name: `Clip ${number}`, startFrame: 0, durationFrames: 30, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: .5, assetId: id(20), sourceState: 'ready', ...extra});
  const cue = (number: number, extra: Record<string, unknown> = {}) => ({id: id(number), text: 'A', startFrame: 0, durationFrames: 10, anchor: null, ...extra});
  const clipColumns = ['trackId', 'startFrame', 'durationFrames', 'sourceInFrame', 'sourceState', 'anchorPresent', 'anchorClipId', 'anchorOffset', 'sourceKind', 'sourceNodeId', 'segmentGroupId', 'versionMode', 'versionId', 'assetId', 'shotId', 'jobId'];
  const cueColumns = ['startFrame', 'durationFrames', 'anchorClipId', 'anchorOffset', 'dialogueShotId', 'dialogueLineId'];
  const insertRow = (table: string, columns: readonly string[], timelineId: string, value: {id: string}) => {
    const projected = format5TimelineEntityColumns(table === 'timeline_clips' ? 'clip' : 'cue', value as never);
    db.prepare(`INSERT INTO project.${table}(timelineId,id,projectId,${columns.join(',')},data) VALUES(?,?,?,${columns.map(() => '?').join(',')},?)`)
      .run(timelineId, value.id, id(1), ...columns.map(column => projected[column] ?? null), JSON.stringify(value));
  };
  const writeRow = (table: string, columns: readonly string[], value: {id: string}) => {
    const projected = format5TimelineEntityColumns(table === 'timeline_clips' ? 'clip' : 'cue', value as never);
    db.prepare(`UPDATE project.${table} SET data=?,${columns.map(column => `${column}=?`).join(',')} WHERE id=?`)
      .run(JSON.stringify(value), ...columns.map(column => projected[column] ?? null), value.id);
  };
  const insertClip = (value: ReturnType<typeof clip>) => insertRow('timeline_clips', clipColumns, header.id, value);
  const writeClip = (value: ReturnType<typeof clip>) => writeRow('timeline_clips', clipColumns, value);
  const insertCue = (value: ReturnType<typeof cue>) => insertRow('timeline_cues', cueColumns, header.id, value);
  const writeCue = (value: ReturnType<typeof cue>) => writeRow('timeline_cues', cueColumns, value);
  const revision = (kind: string, targetId: string) => Number(db.prepare('SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind=? AND targetId=?').get(kind, targetId)?.revision);
  try {
    db.prepare('INSERT INTO project.timelines VALUES(?,?,?)').run(header.id, id(1), JSON.stringify(header));
    insertClip(clip(10)); insertCue(cue(20));
    assert.equal(revision('timeline_clip', id(10)), 1);
    assert.equal(revision('timeline_subtitle', id(20)), 1);
    // Identical bytes never advance a revision.
    writeClip(clip(10)); writeCue(cue(20));
    assert.equal(revision('timeline_clip', id(10)), 1);
    assert.equal(revision('timeline_subtitle', id(20)), 1);
    // A semantically equivalent JSON escape is still a byte change.
    writeCue(cue(20, {text: '\\u0041'}));
    assert.equal(revision('timeline_subtitle', id(20)), 2);
    writeClip(clip(10, {name: 'Changed'}));
    assert.equal(revision('timeline_clip', id(10)), 2);
    insertClip(clip(11, {startFrame: 30}));
    assert.equal(revision('timeline_clip', id(11)), 1);
    db.prepare('DELETE FROM project.timeline_clips WHERE id=?').run(id(11));
    assert.equal(revision('timeline_clip', id(11)), 2);
    assert.throws(() => insertClip(clip(10)), /constraint/u);
    assert.throws(() => insertRow('timeline_clips', clipColumns, header.id, clip(12, {startFrame: -1} as never)), /constraint/u);
    assert.throws(() => db.prepare('INSERT INTO project.timeline_clips(timelineId,id,projectId,data) VALUES(?,?,?,?)')
      .run(header.id, id(21), id(1), JSON.stringify(clip(21))), /constraint/u);
  } finally {db.close();}
});

for (const source of [PROJECT_FILE_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION] as const) test(`format ${source} DDL converts to the exact format 5 catalog atomically without an intermediate published version`, () => {
  const history = source === PROJECT_FILE_SCHEMA_VERSION ? HISTORY_SCHEMA_VERSION : FORMAT4_HISTORY_SCHEMA_VERSION;
  const db = connection(source, history);
  try {
    db.exec('BEGIN');
    removeCrossFileTriggersInside(db, source);
    addFormat5ProjectStructureInside(db, 'project', source);
    addFormat5HistoryStructureInside(db, history);
    assert.equal(db.prepare('SELECT version FROM project.schema_version').get()!.version, source);
    assert.equal(db.prepare('SELECT version FROM main.schema_version').get()!.version, history);
    for (const [schema, expected] of [['project', projectManifestForVersion(FORMAT5_PROJECT_SCHEMA_VERSION)], ['main', historyManifestForVersion(FORMAT5_HISTORY_SCHEMA_VERSION)]] as const) {
      assert.deepEqual(compareManifest(readSchemaManifest(db, schema), expected!.entries), {missing: [], unexpected: [], changed: []});
    }
    installCrossFileTriggers(db, FORMAT5_PROJECT_SCHEMA_VERSION);
    assert.deepEqual(foreignKeyCheck(db), []);
    writeFormat5ProjectVersionInside(db, 'project', source);
    writeFormat5HistoryVersionInside(db, history);
    db.exec('COMMIT');
    assert.equal(db.prepare('SELECT version FROM project.schema_version').get()!.version, FORMAT5_PROJECT_SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT version FROM main.schema_version').get()!.version, FORMAT5_HISTORY_SCHEMA_VERSION);
  } finally {if (db.isTransaction) db.exec('ROLLBACK'); db.close();}
});

test('source trigger removal refuses unknown TEMP triggers without discarding them', () => {
  const db = connection(FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT4_HISTORY_SCHEMA_VERSION);
  try {
    db.exec("CREATE TEMP TRIGGER unknown_guard BEFORE INSERT ON project.projects BEGIN SELECT RAISE(ABORT,'unknown');END; BEGIN");
    const before = db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE type='trigger'").get()!.n;
    assert.throws(() => removeCrossFileTriggersInside(db, FORMAT4_PROJECT_SCHEMA_VERSION), /reviewed source profile/u);
    assert.equal(db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE type='trigger'").get()!.n, before);
  } finally {if (db.isTransaction) db.exec('ROLLBACK'); db.close();}
});

test('format 5 preserves old binding versions as locked and old empty bindings as detached', () => {
  const db = connection(FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT4_HISTORY_SCHEMA_VERSION);
  try {
    db.exec('BEGIN');
    db.prepare('INSERT INTO project.shots(id,projectId,data) VALUES(?,?,?)').run(id(2), id(1), '{}');
    db.prepare('INSERT INTO project.assets(id,projectId,data) VALUES(?,?,?)').run(id(30), id(1), '{}');
    db.prepare('INSERT INTO project.subjects VALUES(?,?,?,?,?,?,?,?)').run(id(31), id(1), 'character', 'Synthetic subject', 1, id(32), at, at);
    const version = {id: id(32), projectId: id(1), subjectId: id(31), number: 1, assetId: id(30)};
    db.prepare('INSERT INTO project.subject_versions VALUES(?,?,?,?,?,?)').run(version.id, version.projectId, version.subjectId, version.number, version.assetId, JSON.stringify(version));
    for (const [number, versionId, role] of [[33, id(32), 'subject'], [34, null, 'style']] as const) {
      db.prepare('INSERT INTO project.subject_bindings VALUES(?,?,?,?,?,?,?,?,?,?)').run(id(number), id(1), id(2), id(31), role, 1, versionId, id(32), at, at);
    }
    db.exec('COMMIT; BEGIN');
    removeCrossFileTriggersInside(db, FORMAT4_PROJECT_SCHEMA_VERSION);
    addFormat5ProjectStructureInside(db, 'project', FORMAT4_PROJECT_SCHEMA_VERSION);
    const bindings = db.prepare('SELECT id,bindingMode,subjectVersionId,reviewedHeadVersionId FROM project.subject_bindings ORDER BY id').all();
    assert.deepEqual(bindings.map(row => ({...row})), [
      {id: id(33), bindingMode: 'locked', subjectVersionId: id(32), reviewedHeadVersionId: id(32)},
      {id: id(34), bindingMode: 'detached', subjectVersionId: null, reviewedHeadVersionId: id(32)},
    ]);
    db.prepare("UPDATE project.subject_bindings SET bindingMode='follow',subjectVersionId=NULL,revision=revision+1 WHERE id=?").run(id(33));
    const activeIndex = db.prepare("SELECT sql FROM project.sqlite_master WHERE type='index' AND name='subject_bindings_active_shot'").get()!.sql;
    assert.equal(activeIndex, "CREATE INDEX subject_bindings_active_shot ON subject_bindings(shotId) WHERE bindingMode IN ('follow','locked')");
    const active = db.prepare("SELECT id,bindingMode FROM project.subject_bindings INDEXED BY subject_bindings_active_shot WHERE shotId=? AND bindingMode IN ('follow','locked') ORDER BY id").all(id(2));
    assert.deepEqual(active.map(row => ({...row})), [{id: id(33), bindingMode: 'follow'}], 'a followed version-null binding stays indexed while a detached binding is excluded');
    assert.throws(() => db.prepare("UPDATE project.subject_bindings SET bindingMode='locked',revision=revision+1 WHERE id=?").run(id(33)), /constraint/u);
    db.exec('ROLLBACK');
  } finally {if (db.isTransaction) db.exec('ROLLBACK'); db.close();}
});

function jsonBytes(bytes: number): string {
  const empty = JSON.stringify({padding: ''});
  return JSON.stringify({padding: 'x'.repeat(bytes - Buffer.byteLength(empty))});
}
test('unified history and receipts enforce exact bytes, complete entries, immutable replay and row caps', () => {
  const db = connection();
  const addHistory = (number: number, before = '{}', after = '{}', origin = 'user') => db.prepare('INSERT INTO main.editor_history_entries VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id(number), id(1), id(90), number, 'synthetic-edit', origin, before, after, at);
  const addReceipt = (number: number, response: string) => db.prepare('INSERT INTO main.editor_requests VALUES(?,?,?,?,?,?,?)')
    .run(`synthetic-request-${number}`, id(1), 'synthetic-edit', 'a'.repeat(64), response, number, at);
  try {
    addHistory(1, jsonBytes(4 * 1024 * 1024 - 2));
    assert.throws(() => addHistory(2, jsonBytes(4 * 1024 * 1024 - 1)), /constraint/u);
    assert.throws(() => addHistory(2, '{}', '{}', 'mio'), /constraint/u);
    assert.throws(() => db.exec("UPDATE main.editor_history_entries SET operation='changed'"), /EDITOR_HISTORY_IMMUTABLE/u);
    db.exec('DELETE FROM main.editor_history_entries');
    for (let number = 1; number <= 200; number++) addHistory(number);
    assert.throws(() => addHistory(201), /EDITOR_HISTORY_LIMIT/u);
    assert.equal(db.prepare('SELECT count(*) AS n FROM main.editor_history_entries').get()!.n, 200);
    addReceipt(1, jsonBytes(65536));
    assert.throws(() => addReceipt(2, jsonBytes(65537)), /constraint/u);
    assert.throws(() => addReceipt(1, '{}'), /EDITOR_REQUEST_IMMUTABLE/u);
    assert.throws(() => db.exec("UPDATE main.editor_requests SET response='{}'"), /EDITOR_REQUEST_IMMUTABLE/u);
    assert.deepEqual(foreignKeyCheck(db), []);
  } finally {db.close();}
});

test('editor storage deltas match full inventory through rollback, deletion, immutable updates and underflow', t => {
  const db = connection();
  const insertHistory = db.prepare('INSERT INTO main.editor_history_entries VALUES(?,?,?,?,?,?,?,?,?)');
  const insertReceipt = db.prepare('INSERT INTO main.editor_requests VALUES(?,?,?,?,?,?,?)');
  const history = () => insertHistory.run(id(70), id(1), id(90), 1, 'synthetic-edit', 'user', '{"x":1}', '{}', at);
  const receipt = () => insertReceipt.run('counter-receipt', id(1), 'synthetic-edit', 'a'.repeat(64), '{"x":2}', 1, at);
  const zero = {historyEntries: 0, historyBytes: 0, receiptRows: 0, receiptBytes: 0};
  try {
    assert.deepEqual(editorStorageInventory(db), zero);
    assertEditorStorageInventory(db);
    const sql: string[] = [], prepare = db.prepare.bind(db);
    const observer = t.mock.method(db, 'prepare', (statement: string) => {sql.push(statement); return prepare(statement);});
    assertEditorStorageCounters(db);
    observer.mock.restore();
    assert.equal(sql.length, 1);
    assert.match(sql[0]!, /FROM main\.editor_storage_counters/u);
    assert.doesNotMatch(sql[0]!, /editor_history_entries|editor_requests/u);
    db.exec('BEGIN'); history(); receipt(); assertEditorStorageInventory(db); db.exec('ROLLBACK');
    assert.deepEqual(editorStorageInventory(db), zero); assertEditorStorageInventory(db);
    history(); receipt(); assertEditorStorageInventory(db);
    assert.throws(() => db.exec("UPDATE main.editor_history_entries SET beforePatch='{}'"), /EDITOR_HISTORY_IMMUTABLE/u);
    assert.throws(() => db.exec("UPDATE main.editor_requests SET response='{}'"), /EDITOR_REQUEST_IMMUTABLE/u);
    assertEditorStorageInventory(db);
    db.exec('UPDATE main.editor_storage_counters SET historyEntries=0,historyBytes=0');
    assertEditorStorageCounters(db);
    assert.throws(() => assertEditorStorageInventory(db), {code: 'EDITOR_STORAGE_CORRUPT'});
    assert.throws(() => db.exec('DELETE FROM main.editor_history_entries'), /EDITOR_STORAGE_CORRUPT/u);
    assert.equal(db.prepare('SELECT count(*) AS n FROM main.editor_history_entries').get()!.n, 1);
    db.exec('UPDATE main.editor_storage_counters SET historyEntries=1,historyBytes=9');
    assertEditorStorageInventory(db);
    db.exec('UPDATE main.editor_storage_counters SET receiptRows=0,receiptBytes=0');
    assert.throws(() => db.exec('DELETE FROM main.editor_requests'), /EDITOR_STORAGE_CORRUPT/u);
    assert.equal(db.prepare('SELECT count(*) AS n FROM main.editor_requests').get()!.n, 1);
    db.exec('UPDATE main.editor_storage_counters SET receiptRows=1,receiptBytes=7');
    assertEditorStorageInventory(db);
    assert.throws(() => db.exec('UPDATE main.editor_storage_counters SET historyBytes=9007199254740992'), /constraint/u);
    assert.throws(() => db.exec('DELETE FROM main.editor_storage_counters'), /EDITOR_STORAGE_CORRUPT/u);
    assert.throws(() => db.exec('INSERT OR REPLACE INTO main.editor_storage_counters VALUES(1,0,0,0,0)'), /EDITOR_STORAGE_CORRUPT/u);
    db.exec('DELETE FROM main.editor_history_entries; DELETE FROM main.editor_requests');
    assert.deepEqual(editorStorageInventory(db), zero); assertEditorStorageInventory(db);
  } finally {if (db.isTransaction) db.exec('ROLLBACK'); db.close();}
});

test('editor byte quotas preserve exact 0/1-byte boundaries near full history and receipt budgets', () => {
  const db = connection();
  const insertHistory = db.prepare('INSERT INTO main.editor_history_entries VALUES(?,?,?,?,?,?,?,?,?)');
  const history = (number: number, bytes: number) => insertHistory.run(id(number + 100), id(1), id(90), number, 'synthetic-edit', 'user', jsonBytes(bytes - 2), '{}', at);
  const insertReceipt = db.prepare('INSERT INTO main.editor_requests VALUES(?,?,?,?,?,?,?)');
  const receipt = (number: number, bytes: number) => insertReceipt.run(`byte-receipt-${number}`, id(1), 'synthetic-edit', 'a'.repeat(64), jsonBytes(bytes), number, at);
  try {
    db.exec('BEGIN');
    for (let number = 1; number <= 31; number++) history(number, 4 * 1024 * 1024);
    history(32, 4 * 1024 * 1024 - 100);
    history(33, 100);
    assert.equal(editorStorageInventory(db).historyBytes, 128 * 1024 * 1024);
    assertEditorStorageInventory(db);
    db.prepare('DELETE FROM main.editor_history_entries WHERE actionId=?').run(id(133));
    assert.throws(() => history(33, 101), /EDITOR_HISTORY_LIMIT/u);
    assert.equal(editorStorageInventory(db).historyBytes, 128 * 1024 * 1024 - 100);
    assertEditorStorageInventory(db);
    db.exec('DELETE FROM main.editor_history_entries');
    for (let number = 1; number <= 511; number++) receipt(number, 65536);
    receipt(512, 65536 - 100);
    receipt(513, 100);
    assert.equal(editorStorageInventory(db).receiptBytes, 32 * 1024 * 1024);
    assertEditorStorageInventory(db);
    db.prepare('DELETE FROM main.editor_requests WHERE requestId=?').run('byte-receipt-513');
    assert.throws(() => receipt(513, 101), /EDITOR_RECEIPT_LIMIT/u);
    assert.equal(editorStorageInventory(db).receiptBytes, 32 * 1024 * 1024 - 100);
    assertEditorStorageInventory(db);
    db.exec('ROLLBACK');
    assert.deepEqual(editorStorageInventory(db), {historyEntries: 0, historyBytes: 0, receiptRows: 0, receiptBytes: 0});
    assertEditorStorageInventory(db);
  } finally {if (db.isTransaction) db.exec('ROLLBACK'); db.close();}
});

test('the full receipt row budget is enforced independently of response bytes', () => {
  const db = connection();
  const insert = db.prepare('INSERT INTO main.editor_requests VALUES(?,?,?,?,?,?,?)');
  try {
    db.exec('BEGIN');
    for (let number = 0; number < 65536; number++) insert.run(`row-receipt-${number}`, id(1), 'synthetic-edit', 'a'.repeat(64), '{}', number, at);
    assertEditorStorageInventory(db);
    assert.throws(() => insert.run('row-receipt-overflow', id(1), 'synthetic-edit', 'a'.repeat(64), '{}', 65537, at), /EDITOR_RECEIPT_LIMIT/u);
    assert.deepEqual(editorStorageInventory(db), {historyEntries: 0, historyBytes: 0, receiptRows: 65536, receiptBytes: 131072});
    assertEditorStorageInventory(db);
    db.exec('ROLLBACK'); assertEditorStorageInventory(db);
  } finally {if (db.isTransaction) db.exec('ROLLBACK'); db.close();}
});
