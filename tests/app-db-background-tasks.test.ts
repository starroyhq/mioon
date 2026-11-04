import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {BACKGROUND_TASK_INDEX_LIMITS, normalizeBackgroundTaskIndexEntry} from '../packages/contracts/src/project-registry.ts';
import type {BackgroundTaskIndexEntry, StoredBackgroundTaskIndexEntry} from '../packages/contracts/src/project-registry.ts';

const at = '2026-11-04T00:00:00.000Z', source = 'a'.repeat(64), otherSource = 'b'.repeat(64);
const insert = 'INSERT INTO background_task_index(projectId,kind,taskId,sourceHistory,phase,reason,revision,taskRevision,data) VALUES(?,?,?,?,?,?,?,?,?)';
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-background-index-'));
  const library = openAppLibrary({dataDir: root});
  t.after(() => {library.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = randomUUID();
  const entry = (extra: Partial<BackgroundTaskIndexEntry> = {}): BackgroundTaskIndexEntry => ({projectId,
    projectFile: path.join(root, 'Film.mioon'), kind: 'job', taskId: randomUUID(), indexedAt: at,
    phase: 'active', reason: null, sourceHistory: source, revision: 1, taskRevision: 1, ...extra});
  const changes = () => library.db.prepare('SELECT total_changes() n').get()!.n;
  const snapshot = () => library.db.prepare('SELECT rowid,* FROM background_task_index ORDER BY projectId,kind,taskId,sourceHistory').all();
  return {library, projectId, entry, changes, snapshot};
}

test('legacy input remains unverified and reads never create a record', t => {
  const f = fixture(t), changes = f.changes();
  assert.deepEqual(f.library.taskIndex.listProject(f.projectId), []);
  assert.equal(f.changes(), changes);
  const legacy = {projectId: f.projectId, projectFile: f.entry().projectFile, kind: 'export' as const, taskId: randomUUID(), indexedAt: at};
  f.library.taskIndex.upsert(legacy);
  assert.deepEqual(f.library.taskIndex.list(), [normalizeBackgroundTaskIndexEntry(legacy)]);
  const row = f.library.db.prepare('SELECT phase,reason,sourceHistory,revision,taskRevision FROM background_task_index').get();
  assert.deepEqual({...row}, {phase: 'prepared', reason: 'INDEX_UNVERIFIED', sourceHistory: '', revision: 1, taskRevision: 0});
  assert.equal(f.library.taskIndex.list()[0]!.sourceHistory, null);
});

test('unchanged polling and project marking do not rewrite timestamps, revisions or bytes', t => {
  const f = fixture(t), entry = f.entry();
  f.library.taskIndex.upsert(entry);
  const before = f.snapshot(), changes = f.changes();
  for (let index = 0; index < 200; index++) f.library.taskIndex.upsert({...entry, indexedAt: '2026-11-04T01:00:00.000Z', revision: index + 1});
  f.library.taskIndex.markProject(f.projectId, 'active', null);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.changes(), changes);
  f.library.taskIndex.markProject(f.projectId, 'blocked', 'PROJECT_MISSING');
  const blocked = f.library.taskIndex.listProject(f.projectId)[0]!;
  assert.equal(blocked.revision, 2); assert.equal(blocked.taskRevision, 1); assert.equal(blocked.phase, 'blocked');
  const marked = f.snapshot(), after = f.changes();
  f.library.taskIndex.markProject(f.projectId, 'blocked', 'PROJECT_MISSING');
  assert.deepEqual(f.snapshot(), marked); assert.equal(f.changes(), after);
  f.library.taskIndex.upsert({...entry, taskRevision: 2});
  assert.equal(f.library.taskIndex.list()[0]!.revision, 3);
});

test('a stale task revision cannot mutate or finish newer indexed work', t => {
  const f = fixture(t), entry = f.entry({taskRevision: 7}); f.library.taskIndex.upsert(entry);
  const before = f.snapshot();
  for (const phase of ['active', 'blocked', 'done'] as const) {
    assert.throws(() => f.library.taskIndex.upsert({...entry, phase, taskRevision: 6}), {code: 'BACKGROUND_TASK_INDEX_CONFLICT'});
    assert.throws(() => f.library.taskIndex.assertCanUpsert([{...entry, phase, taskRevision: 6}]), {code: 'BACKGROUND_TASK_INDEX_CONFLICT'});
  }
  assert.deepEqual(f.snapshot(), before);
  f.library.taskIndex.upsert({...entry, phase: 'done'});
  assert.deepEqual(f.library.taskIndex.list(), []);
});

test('archiving an old source is replayable and cannot retire or overwrite a new generation', t => {
  const f = fixture(t), old = f.entry(), current = {...old, sourceHistory: otherSource}, legacy = {...old, sourceHistory: null};
  f.library.taskIndex.upsert(old); f.library.taskIndex.upsert(current); f.library.taskIndex.upsert(legacy);
  f.library.taskIndex.archive(f.projectId, source);
  const rows = f.library.taskIndex.listProject(f.projectId);
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.sourceHistory === otherSource)!.phase, 'active');
  assert.deepEqual(rows.filter(row => row.phase === 'archived').map(row => row.sourceHistory).sort(), [null, source].sort());
  const archived = f.snapshot(), changes = f.changes();
  f.library.taskIndex.archive(f.projectId, source);
  assert.deepEqual(f.snapshot(), archived); assert.equal(f.changes(), changes);
  assert.throws(() => f.library.taskIndex.upsert(old), {code: 'BACKGROUND_TASK_INDEX_CONFLICT'});
  assert.throws(() => f.library.taskIndex.assertCanUpsert([old]), {code: 'BACKGROUND_TASK_INDEX_CONFLICT'});
  assert.throws(() => f.library.taskIndex.upsert({...old, phase: 'done'}), {code: 'BACKGROUND_TASK_INDEX_CONFLICT'});
  f.library.taskIndex.replace(f.projectId, [current]);
  assert.equal(f.library.taskIndex.listProject(f.projectId).length, 3);
  f.library.taskIndex.replace(f.projectId, []);
  assert.equal(f.library.taskIndex.listProject(f.projectId).length, 2);
  assert.ok(f.library.taskIndex.listProject(f.projectId).every(row => row.phase === 'archived'));
});

test('replacement is project-local and rolls back when it would resurrect archived work', t => {
  const f = fixture(t), old = f.entry(), live = f.entry(), other = f.entry({projectId: randomUUID()});
  for (const entry of [old, live, other]) f.library.taskIndex.upsert(entry);
  f.library.taskIndex.archive(f.projectId, source);
  f.library.taskIndex.upsert({...live, sourceHistory: otherSource});
  const before = f.snapshot();
  assert.throws(() => f.library.taskIndex.replace(f.projectId, [old]), {code: 'BACKGROUND_TASK_INDEX_CONFLICT'});
  assert.deepEqual(f.snapshot(), before);
  f.library.taskIndex.replace(f.projectId, [{...live, sourceHistory: otherSource, phase: 'done'}]);
  assert.deepEqual(f.library.taskIndex.listProject(other.projectId), [normalizeBackgroundTaskIndexEntry(other)]);
  assert.equal(f.library.taskIndex.listProject(f.projectId).filter(row => row.phase === 'archived').length, 2);
});

test('the per-project limit includes retained archives and accepts exactly the configured boundary', t => {
  const f = fixture(t), entries = Array.from({length: BACKGROUND_TASK_INDEX_LIMITS.project}, () => f.entry());
  f.library.tx(() => {for (const entry of entries) f.library.taskIndex.upsert(entry);});
  assert.equal(f.library.taskIndex.listProject(f.projectId).length, BACKGROUND_TASK_INDEX_LIMITS.project);
  const before = f.snapshot(), changes = f.changes();
  f.library.taskIndex.assertCanUpsert([entries[0]!]);
  assert.throws(() => f.library.taskIndex.assertCanUpsert([f.entry()]), {code: 'APP_LIBRARY_LIMIT'});
  assert.throws(() => f.library.taskIndex.upsert(f.entry()), {code: 'APP_LIBRARY_LIMIT'});
  assert.throws(() => f.library.db.prepare(insert).run(...columns(normalizeBackgroundTaskIndexEntry(f.entry()))), /BACKGROUND_TASK_INDEX_LIMIT/);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.changes(), changes);
  f.library.taskIndex.upsert({...entries[0]!, phase: 'blocked', reason: 'WAITING_USER'});
  f.library.taskIndex.archive(f.projectId, source);
  assert.throws(() => f.library.taskIndex.upsert(f.entry({sourceHistory: otherSource})), {code: 'APP_LIBRARY_LIMIT'});
  assert.equal(f.library.taskIndex.listProject(f.projectId).length, BACKGROUND_TASK_INDEX_LIMITS.project);
});

test('the application limit refuses one extra record without changing another project', t => {
  const f = fixture(t);
  f.library.tx(() => {
    for (let project = 0; project < BACKGROUND_TASK_INDEX_LIMITS.application / BACKGROUND_TASK_INDEX_LIMITS.project; project++) {
      const projectId = randomUUID();
      for (let task = 0; task < BACKGROUND_TASK_INDEX_LIMITS.project; task++) f.library.taskIndex.upsert(f.entry({projectId}));
    }
  });
  assert.equal(f.library.taskIndex.list().length, BACKGROUND_TASK_INDEX_LIMITS.application);
  const before = f.snapshot(), changes = f.changes();
  const completed = {...f.library.taskIndex.list()[0]!, phase: 'done' as const};
  f.library.taskIndex.assertCanUpsert([f.entry(), completed]);
  assert.throws(() => f.library.taskIndex.assertCanUpsert([f.entry()]), {code: 'APP_LIBRARY_LIMIT'});
  assert.throws(() => f.library.taskIndex.upsert(f.entry()), {code: 'APP_LIBRARY_LIMIT'});
  assert.throws(() => f.library.db.prepare(insert).run(...columns(normalizeBackgroundTaskIndexEntry(f.entry()))), /BACKGROUND_TASK_INDEX_LIMIT/);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.changes(), changes);
});

test('pre-COMMIT preflight counts the final batch without a reservation or transaction side effect', t => {
  const f = fixture(t), entries = Array.from({length: BACKGROUND_TASK_INDEX_LIMITS.project}, () => f.entry());
  f.library.tx(() => {for (const entry of entries) f.library.taskIndex.upsert(entry);});
  const fresh = f.entry(), done = {...entries[0]!, phase: 'done' as const}, advanced = {...entries[1]!, taskRevision: 2};
  const before = f.snapshot(), changes = f.changes();
  assert.equal(f.library.db.isTransaction, false);
  f.library.taskIndex.assertCanUpsert([fresh, done, advanced]);
  assert.equal(f.library.db.isTransaction, false);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.changes(), changes);
  assert.throws(() => f.library.taskIndex.assertCanUpsert([fresh, fresh]), /each task once per source/);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.changes(), changes);
  f.library.tx(() => {
    f.library.taskIndex.assertCanUpsert([fresh, done]);
    assert.equal(f.library.db.isTransaction, true);
    f.library.taskIndex.upsert(done); f.library.taskIndex.upsert(fresh); f.library.taskIndex.upsert(advanced);
  });
  assert.equal(f.library.taskIndex.listProject(f.projectId).length, BACKGROUND_TASK_INDEX_LIMITS.project);
  assert.equal(f.library.taskIndex.listProject(f.projectId).find(row => row.taskId === advanced.taskId)!.taskRevision, 2);
});

test('a verified source adopts a full legacy index slot without temporarily exceeding quota', t => {
  const f = fixture(t), legacy = Array.from({length: BACKGROUND_TASK_INDEX_LIMITS.project}, () => f.entry({sourceHistory: null, phase: 'prepared', reason: 'INDEX_UNVERIFIED', taskRevision: 0}));
  f.library.tx(() => {for (const entry of legacy) f.library.taskIndex.upsert(entry);});
  const verified = {...legacy[0]!, sourceHistory: source, phase: 'active' as const, reason: null, taskRevision: 2};
  const before = f.snapshot(), changes = f.changes();
  f.library.taskIndex.assertCanUpsert([verified]);
  f.library.taskIndex.assertCanUpsert([verified, {...legacy[0]!, phase: 'done'}]);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.changes(), changes);
  f.library.taskIndex.upsert(verified);
  const rows = f.library.taskIndex.listProject(f.projectId);
  assert.equal(rows.length, BACKGROUND_TASK_INDEX_LIMITS.project);
  assert.equal(rows.filter(row => row.taskId === verified.taskId).length, 1);
  assert.equal(rows.find(row => row.taskId === verified.taskId)!.sourceHistory, source);
  assert.throws(() => f.library.taskIndex.assertCanUpsert([{...verified, sourceHistory: otherSource}]), {code: 'APP_LIBRARY_LIMIT'});
  assert.throws(() => f.library.taskIndex.upsert({...verified, sourceHistory: otherSource}), {code: 'APP_LIBRARY_LIMIT'});
  assert.deepEqual(f.library.taskIndex.listProject(f.projectId), rows);
});

test('legacy adoption rolls back as one app transaction and never consumes an archived placeholder', t => {
  const f = fixture(t), legacy = f.entry({sourceHistory: null, phase: 'prepared', reason: 'INDEX_UNVERIFIED', taskRevision: 0});
  f.library.taskIndex.upsert(legacy);
  const before = f.snapshot(), exec = f.library.db.exec.bind(f.library.db);
  const mock = t.mock.method(f.library.db, 'exec', (sql: string): void => {if (sql === 'COMMIT') throw Error('adoption injected'); exec(sql);});
  assert.throws(() => f.library.taskIndex.upsert({...legacy, sourceHistory: source, phase: 'active', reason: null}), /adoption injected/);
  mock.mock.restore(); assert.deepEqual(f.snapshot(), before);
  f.library.taskIndex.archive(f.projectId, null);
  const archived = f.library.taskIndex.listProject(f.projectId)[0]!;
  f.library.taskIndex.assertCanUpsert([{...legacy, sourceHistory: source, phase: 'active', reason: null}]);
  f.library.taskIndex.upsert({...legacy, sourceHistory: source, phase: 'active', reason: null});
  f.library.taskIndex.upsert({...legacy, sourceHistory: otherSource, phase: 'active', reason: null});
  assert.equal(f.library.taskIndex.listProject(f.projectId).length, 3);
  assert.deepEqual(f.library.taskIndex.listProject(f.projectId).find(row => row.sourceHistory === null), archived);
  assert.deepEqual(f.library.taskIndex.listProject(f.projectId).filter(row => row.phase === 'active').map(row => row.sourceHistory).sort(), [source, otherSource]);
});

function columns(entry: StoredBackgroundTaskIndexEntry): (string | number | null)[] {
  return [entry.projectId, entry.kind, entry.taskId, entry.sourceHistory ?? '', entry.phase, entry.reason, entry.revision, entry.taskRevision, JSON.stringify(entry)];
}
for (const field of ['phase', 'sourceHistory', 'reason', 'revision', 'taskRevision'] as const) test(`native ${field} projection rejects drift from the stored JSON`, t => {
  const f = fixture(t), entry = normalizeBackgroundTaskIndexEntry(f.entry()), values = columns(entry);
  const index = {sourceHistory: 3, phase: 4, reason: 5, revision: 6, taskRevision: 7}[field];
  values[index] = field === 'phase' ? 'blocked' : field === 'sourceHistory' ? otherSource : field === 'reason' ? 'OTHER' : 2;
  assert.throws(() => f.library.db.prepare(insert).run(...values), /CHECK constraint failed/);
  assert.deepEqual(f.library.taskIndex.list(), []);
});

test('native keys, revisions and archived retention cannot be bypassed by REPLACE', t => {
  const f = fixture(t), entry = normalizeBackgroundTaskIndexEntry(f.entry()); f.library.taskIndex.upsert(entry);
  const before = f.snapshot();
  assert.throws(() => f.library.db.prepare(insert.replace('INSERT INTO', 'INSERT OR REPLACE INTO')).run(...columns(entry)), /BACKGROUND_TASK_INDEX_CONFLICT/);
  assert.throws(() => f.library.db.prepare('UPDATE OR REPLACE background_task_index SET sourceHistory=?').run(otherSource), /BACKGROUND_TASK_INDEX_CONFLICT/);
  assert.throws(() => f.library.db.exec('UPDATE background_task_index SET revision=0'), /BACKGROUND_TASK_INDEX_CONFLICT|CHECK constraint failed/);
  assert.deepEqual(f.snapshot(), before);
  f.library.taskIndex.archive(f.projectId, source);
  const archived = f.snapshot();
  assert.throws(() => f.library.db.exec('DELETE FROM background_task_index'), /BACKGROUND_TASK_INDEX_CONFLICT/);
  const replacement = normalizeBackgroundTaskIndexEntry(f.entry({sourceHistory: otherSource}));
  const rowid = f.library.db.prepare('SELECT rowid FROM background_task_index').get()!.rowid;
  assert.equal(typeof rowid, 'number');
  assert.throws(() => f.library.db.prepare(insert.replace('INSERT INTO background_task_index(', 'INSERT OR REPLACE INTO background_task_index(rowid,').replace('VALUES(', 'VALUES(?,')).run(Number(rowid), ...columns(replacement)), /BACKGROUND_TASK_INDEX_CONFLICT/);
  assert.deepEqual(f.snapshot(), archived);
});

test('raw fallback data cannot claim an active stage, and public null is distinct from an empty source string', t => {
  const f = fixture(t), entry = normalizeBackgroundTaskIndexEntry(f.entry()), values = columns(entry);
  const {phase: _phase, reason: _reason, sourceHistory: _source, revision: _revision, taskRevision: _taskRevision, ...legacy} = entry;
  values[8] = JSON.stringify(legacy);
  assert.throws(() => f.library.db.prepare(insert).run(...values), /CHECK constraint failed/);
  assert.throws(() => f.library.taskIndex.upsert({...entry, sourceHistory: ''}), {name: 'ZodError'});
  assert.throws(() => f.library.taskIndex.upsert({...entry, taskRevision: -1}), {name: 'ZodError'});
  assert.throws(() => f.library.taskIndex.upsert({...entry, revision: 0}), {name: 'ZodError'});
  assert.throws(() => f.library.taskIndex.upsert({...entry, revision: Number.MAX_SAFE_INTEGER + 1}), {name: 'ZodError'});
  assert.throws(() => f.library.taskIndex.upsert({...entry, taskRevision: Number.MAX_SAFE_INTEGER + 1}), {name: 'ZodError'});
  const hiddenNul = 'a'.repeat(30) + '\0' + 'b'.repeat(33);
  assert.equal(Buffer.byteLength(hiddenNul), 64);
  assert.throws(() => f.library.db.prepare(insert).run(...columns({...entry, sourceHistory: hiddenNul})), /CHECK constraint failed/);
  assert.deepEqual(f.library.taskIndex.list(), []);
});

for (const damage of ['projection', 'duplicate-key'] as const) test(`a damaged ${damage} record cannot turn unfinished work into an empty query`, t => {
  const f = fixture(t), entry = normalizeBackgroundTaskIndexEntry(f.entry()), values = columns(entry);
  values[8] = damage === 'projection' ? JSON.stringify({...entry, phase: 'done'})
    : JSON.stringify(entry).replace('"phase":"active"', '"phase":"active","phase":"done"');
  f.library.db.exec('PRAGMA ignore_check_constraints=ON');
  try {f.library.db.prepare(insert).run(...values);} finally {f.library.db.exec('PRAGMA ignore_check_constraints=OFF');}
  const before = f.snapshot(), changes = f.changes();
  assert.throws(() => f.library.taskIndex.listProject(f.projectId), {code: 'APP_LIBRARY_INVALID'});
  assert.throws(() => f.library.taskIndex.list(), {code: 'APP_LIBRARY_INVALID'});
  assert.deepEqual(f.snapshot(), before); assert.equal(f.changes(), changes);
});
