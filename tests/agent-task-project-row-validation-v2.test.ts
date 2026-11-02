import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore, createProjectStore} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary, projectFileIdentity} from '../packages/business/src/app-db/index.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {validateAgentTaskRowsV2} from '../packages/business/src/agent/task-schema-v2.ts';
import {bindAgentTaskRowValidation} from '../packages/business/src/agent/task-project-row-validation-v2.ts';
import {withoutForeignKeys} from './helpers/project-database.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';

const options = {allowConversations: true, allowInteractions: true, allowRequestReferences: true, allowAnswers: true};
const invalid = {code: 'RESTORE_SCHEMA_UNSUPPORTED'};
function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-task-row-validation-'));
  t.after(() => rmSync(root, {recursive: true, force: true})); return root;
}
function fixture(t: TestContext) {
  const store = openStore(scratch(t)), library = testProjectAppLibrary(store); assert.ok(library);
  t.after(() => store.close());
  const now = new Date().toISOString();
  store.put('projects', {id: store.projectId, name: 'Actual row validation', revision: 1, createdAt: now, updatedAt: now});
  const journal = createAgentTaskJournal(store), run = journal.create({projectId: store.projectId, requestId: randomUUID(), text: 'Synthetic row validation', configuration: {}}).run;
  const step = journal.beginStep(run.id, {kind: 'model', request: {synthetic: true}});
  return {store, library, journal, run, step};
}
const changes = (db: {prepare(sql: string): {get(): unknown}}): unknown => db.prepare('SELECT total_changes() AS n').get();

test('the TEST validator reads the actual app policy and project rows without writing either connection', t => {
  const f = fixture(t);
  f.library.agentPolicy.write({...DEFAULT_AGENT_TASK_POLICY, revision: 1}, {requestId: randomUUID(), digest: 'a'.repeat(64)});
  const before = [changes(f.store.db), changes(f.library.db)];
  validateAgentTaskRowsV2(f.store.db, options);
  const localBytes = ['agent_task_runs_v2', 'agent_task_steps_v2', 'agent_task_changes_v2', 'agent_task_events_v2', 'agent_task_controls_v2', 'agent_task_control_states_v2']
    .reduce((sum, table) => sum + Number(f.store.db.prepare(`SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS n FROM ${table}`).get()!.n), 0);
  validateAgentTaskRowsV2(f.store.db, {...options, maxBytes: localBytes});
  assert.deepEqual([changes(f.store.db), changes(f.library.db)], before);
  assert.equal(f.store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='agent_task_policy_v2'").get(), undefined);
  assert.equal(f.store.db.prepare('PRAGMA database_list').all().some(row => row.file === f.library.databaseFile), false);
  assert.throws(() => validateAgentTaskRowsV2(f.store.db, {...options, maxBytes: 1}), invalid);
  assert.throws(() => validateAgentTaskRowsV2(f.store.db, {...options, allowRequestReferences: false}), invalid);
  const saved = f.library.db.prepare('SELECT data FROM agent_task_policy_v2 WHERE id=1').get()!.data;
  f.library.db.prepare('UPDATE agent_task_policy_v2 SET data=? WHERE id=1').run('{}');
  const badBefore = [changes(f.store.db), changes(f.library.db)];
  assert.throws(() => validateAgentTaskRowsV2(f.store.db, options), invalid);
  assert.deepEqual([changes(f.store.db), changes(f.library.db)], badBefore);
  f.library.db.prepare('UPDATE agent_task_policy_v2 SET data=? WHERE id=1').run(String(saved));
  validateAgentTaskRowsV2(f.store.db, options);
});

test('kernel validation retains row identity, cross-file foreign keys, target revisions and seen sequence checks', t => {
  const f = fixture(t), db = f.store.db;
  const saved = db.prepare('SELECT data FROM agent_task_runs_v2 WHERE id=?').get(f.run.id)!.data;
  db.prepare("UPDATE agent_task_runs_v2 SET data=json_set(data,'$.id',?) WHERE id=?").run(randomUUID(), f.run.id);
  assert.throws(() => validateAgentTaskRowsV2(db, options), invalid);
  db.prepare('UPDATE agent_task_runs_v2 SET data=? WHERE id=?').run(String(saved), f.run.id);
  withoutForeignKeys(db, () => db.prepare("UPDATE agent_task_runs_v2 SET projectId=?,data=json_set(data,'$.projectId',?) WHERE id=?").run('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', f.run.id));
  const beforeForeign = [changes(db), changes(f.library.db)];
  assert.throws(() => validateAgentTaskRowsV2(db, options), invalid);
  assert.deepEqual([changes(db), changes(f.library.db)], beforeForeign);
  withoutForeignKeys(db, () => db.prepare('UPDATE agent_task_runs_v2 SET projectId=?,data=? WHERE id=?').run(f.store.projectId, String(saved), f.run.id));
  db.exec('PRAGMA ignore_check_constraints=ON');
  try {
    db.exec('UPDATE agent_task_target_revisions_v2 SET revision=0');
    assert.throws(() => validateAgentTaskRowsV2(db, options), {code: 'RESTORE_SCHEMA_UNSUPPORTED', message: 'Invalid Agent target revision'});
    db.exec('UPDATE agent_task_target_revisions_v2 SET revision=1');
  } finally {db.exec('PRAGMA ignore_check_constraints=OFF');}
  db.exec('UPDATE main.history_state SET seenContentSequence=seenContentSequence+1');
  assert.throws(() => validateAgentTaskRowsV2(db, options), invalid);
  db.exec('UPDATE main.history_state SET seenContentSequence=(SELECT contentSequence FROM project.project_file)');
  validateAgentTaskRowsV2(db, options);
});

test('production validation needs its registered project and held application owner, and unbinding is reference counted', t => {
  const root = scratch(t), library = openAppLibrary({dataDir: path.join(root, 'app')}), wrong = openAppLibrary({dataDir: path.join(root, 'other-app')});
  const store = createProjectStore({projectFile: path.join(root, 'project.mioon'), locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')})});
  t.after(() => {store.close(); library.close(); wrong.close();});
  const identity = projectFileIdentity(store.projectFile); assert.ok(identity);
  const now = new Date().toISOString();
  store.put('projects', {id: store.projectId, name: 'Registered', revision: 1, createdAt: now, updatedAt: now});
  library.registry.upsert({projectId: store.projectId, projectFile: store.projectFile, fileIdentity: identity, name: 'Registered', lastOpenedAt: now, summary: null});
  assert.throws(() => validateAgentTaskRowsV2(store.db, options), {name: 'TypeError', message: 'Project Agent task row validation requires a live application context'});
  assert.throws(() => bindAgentTaskRowValidation({...store}, library), {name: 'TypeError', message: 'Agent task row validation requires the exact live project store'});
  assert.throws(() => bindAgentTaskRowValidation(store, wrong), {name: 'TypeError', message: 'Agent task row validation application does not own this project'});
  const one = bindAgentTaskRowValidation(store, library), two = bindAgentTaskRowValidation(store, library);
  one(); validateAgentTaskRowsV2(store.db, options);
  two();
  assert.throws(() => validateAgentTaskRowsV2(store.db, options), {name: 'TypeError', message: 'Project Agent task row validation requires a live application context'});
  const unbind = bindAgentTaskRowValidation(store, library);
  library.close();
  assert.throws(() => validateAgentTaskRowsV2(store.db, options), {name: 'TypeError', message: 'Agent task row validation requires a live application library'});
  unbind();
});

test('TEST context cannot bind another app library or survive closing its exact project owner', t => {
  const f = fixture(t), wrong = openAppLibrary({dataDir: path.join(scratch(t), 'app')});
  t.after(() => wrong.close());
  assert.throws(() => bindAgentTaskRowValidation(f.store, wrong), {name: 'TypeError', message: 'Agent task row validation application does not own this TEST project'});
  f.store.close();
  assert.throws(() => bindAgentTaskRowValidation(f.store, wrong), {name: 'TypeError', message: 'Agent task row validation requires the exact live project store'});
});
