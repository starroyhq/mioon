import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore, schemaObjects, foreignKeyCheck} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {collectTaskProjectOverview} from '../packages/business/src/agent/task-context-observations-v2.ts';
import {agentTaskJobBinding} from '../packages/business/src/agent/task-effects-v2.ts';
import {readAgentTaskStorage} from '../packages/business/src/agent/task-storage-v2.ts';
import {installAgentTaskDefinitionsV2, validateAgentTaskRowsV2, dropAgentTaskTargetTriggersV2} from '../packages/business/src/agent/task-schema-v2.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations} from './helpers/agent-authorizations.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-task-project-assembly-'));
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  const first = openStore(path.join(root, 'first')), second = openStore(path.join(root, 'second'));
  t.after(() => {first.close(); second.close(); library.close(); rmSync(root, {recursive: true, force: true});});
  for (const store of [first, second]) {
    const date = new Date().toISOString();
    store.put('projects', {id: store.projectId, name: 'Synthetic project', revision: 1, createdAt: date, updatedAt: date});
  }
  return {root, library, first, second};
}

test('real project journals share only injected app policy, preserving CAS, replay and project transactions', t => {
  const {library, first, second} = fixture(t);
  const testPolicy = createAgentTaskJournal(first);
  assert.deepEqual(testPolicy.policy(), DEFAULT_AGENT_TASK_POLICY);
  assert.notEqual(testProjectAppLibrary(first)?.db, library.db);
  const policyStore = library.agentPolicy;
  const a = createAgentTaskJournal(first, {policyStore}), b = createAgentTaskJournal(second, {policyStore});
  assert.deepEqual(a.policy(), DEFAULT_AGENT_TASK_POLICY);
  const requestId = randomUUID(), input = {...a.policy(), stepLimit: 12};
  const saved = a.updatePolicy(input, requestId);
  assert.deepEqual(saved, {...input, revision: 1});
  assert.deepEqual(b.policy(), saved);
  assert.deepEqual(b.updatePolicy(input, requestId), saved);
  assert.deepEqual(b.lookupPolicy(requestId), saved);
  assert.throws(() => b.updatePolicy({...input, stepLimit: 13}, requestId), {code: 'AGENT_TASK_REQUEST_CONFLICT'});
  assert.throws(() => b.updatePolicy(input, randomUUID()), {code: 'AGENT_TASK_REVISION_CONFLICT'});
  assert.equal(library.db.prepare('SELECT count(*) AS n FROM agent_task_policy_requests_v2').get()?.n, 1);
  for (const store of [first, second]) {
    assert.equal(schemaObjects(store.db).some(row => row.name === 'agent_task_policy_v2'), false);
    assert.equal(store.db.prepare('PRAGMA database_list').all().some(row => String(row.file) === library.databaseFile), false);
  }
  // A project rollback cannot undo a separately committed app-global policy.
  assert.throws(() => first.tx(() => {a.updatePolicy({...saved, stepLimit: 14}, randomUUID()); throw Error('project rollback');}), /project rollback/);
  assert.equal(b.policy().stepLimit, 14);
  const run = a.create({projectId: first.projectId, requestId: randomUUID(), text: 'Synthetic model step', configuration: {}}).run;
  const model = a.beginStep(run.id, {kind: 'model', request: {synthetic: true}});
  assert.deepEqual(a.events(run.id).find(event => event.type === 'step')?.data, model);
  const stored = first.db.prepare("SELECT data FROM agent_task_events_v2 WHERE type='step'").get();
  assert.match(String(stored?.data), /mioon-model-request-ref\/1/u);
  assert.equal(a.conversationPolicies(), true);
  assert.deepEqual(foreignKeyCheck(first.db), []);
});

test('the app policy port checks the expected revision inside its own transaction without a partial receipt', t => {
  const {library} = fixture(t), store = library.agentPolicy;
  const next = {...structuredClone(DEFAULT_AGENT_TASK_POLICY), revision: 1};
  store.write(next, {requestId: 'first', digest: 'a'.repeat(64)}, 0);
  assert.throws(() => store.write({...next, revision: 2}, {requestId: 'stale', digest: 'b'.repeat(64)}, 0), {code: 'AGENT_TASK_REVISION_CONFLICT'});
  assert.equal(store.readRequest('stale'), null);
  assert.deepEqual(store.read(), next);
  store.write({...next, revision: 2}, {requestId: 'second', digest: 'c'.repeat(64)}, 1);
  assert.equal(store.read()?.revision, 2);
});

test('policy CAS refuses an outer application transaction without changing policy or its receipt', t => {
  const {library, first} = fixture(t), store = library.agentPolicy;
  const journal = createAgentTaskJournal(first, {policyStore: store});
  const before = journal.updatePolicy({...structuredClone(DEFAULT_AGENT_TASK_POLICY), stepLimit: 12}, randomUUID());
  const requestId = randomUUID(), receipts = library.db.prepare('SELECT * FROM agent_task_policy_requests_v2 ORDER BY requestId').all();
  library.tx(() => {
    assert.throws(() => journal.updatePolicy({...before, stepLimit: 14}, requestId), /Nested transactions are not supported/u);
    assert.equal(library.db.isTransaction, true);
    assert.deepEqual(store.read(), before);
    assert.equal(store.readRequest(requestId), null);
  });
  assert.deepEqual(store.read(), before);
  assert.deepEqual(library.db.prepare('SELECT * FROM agent_task_policy_requests_v2 ORDER BY requestId').all(), receipts);
  // The original B1 call can still compose with an app transaction and roll back.
  assert.throws(() => library.tx(() => {
    store.write({...before, revision: before.revision + 1}, {requestId, digest: 'd'.repeat(64)});
    assert.equal(store.readRequest(requestId)?.policy.revision, before.revision + 1);
    throw Error('outer rollback');
  }), /outer rollback/u);
  assert.deepEqual(store.read(), before);
  assert.equal(store.readRequest(requestId), null);
});

test('runtime policy injection retains explicit paid confirmation and rejects stale policy edits', async t => {
  const {library, first} = fixture(t), settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  t.after(() => settings.close());
  const runtime = createAgentTaskRuntime({store: first, policyStore: library.agentPolicy, agentSettings: settings,
    authorizations: createTestAuthorizations(() => ({...first}), settings), selfPort: () => 4318});
  t.after(() => runtime.close());
  const input = {requestId: randomUUID(), expectedRevision: 0, stepLimit: 30, modes: {...runtime.policy().modes, paid: 'direct'}};
  assert.throws(() => runtime.updatePolicy(input), {code: 'AGENT_TASK_APPROVAL_REQUIRED'});
  assert.equal(library.agentPolicy.read(), null);
  assert.equal(runtime.updatePolicy({...input, acknowledgePaid: true}).modes.paid, 'direct');
  assert.throws(() => runtime.updatePolicy({...input, requestId: randomUUID()}), {code: 'AGENT_TASK_REVISION_CONFLICT'});
});

test('project tools snapshot all eight attached content families and stage attachments under localDir/imports', async t => {
  const {root, library, first: store} = fixture(t), {db, projectId} = store;
  const unused = (): never => {throw Error('This read/import-staging test must not invoke application backups');};
  const configuration = createWorkspaceConfiguration({root: path.join(root, 'app'), documents: library.documents});
  const services = createServices(store, new Map(), {application: {configuration, backups: {
    getStatus: unused, list: unused, create: unused, stageRestore: unused, exportBundle: unused, importBundle: unused, importDirectory: unused,
    isBusy: () => false, assertMutationAllowed() {}, start() {}, stop() {}, drain: async () => {}, tick: async () => {},
  }}});
  const tools = createAgentTaskTools({store, services, policyStore: library.agentPolicy});
  t.after(async () => {tools.dispose(); await services.drain();});
  const assetId = randomUUID(), shotId = randomUUID(), subjectId = randomUUID(), subjectVersionId = randomUUID(), bindingId = randomUUID();
  const groupId = randomUUID(), imageVersionId = randomUUID(), taskId = randomUUID(), date = new Date().toISOString();
  store.tx(() => {
    store.put('assets', {id: assetId, projectId, mimeType: 'image/png'});
    store.put('shots', {id: shotId, projectId});
    db.prepare('INSERT INTO asset_ranges VALUES(?,?,1,0,10)').run(assetId, projectId);
    db.prepare("INSERT INTO asset_dispositions VALUES(?,?,1,'favorite')").run(assetId, projectId);
    db.prepare("INSERT INTO asset_annotations VALUES(?,?,1,'[]','synthetic')").run(assetId, projectId);
    db.prepare("INSERT INTO subjects VALUES(?,?,'character','Synthetic',1,?,?,?)").run(subjectId, projectId, subjectVersionId, date, date);
    const subjectVersion = {id: subjectVersionId, projectId, subjectId, number: 1, assetId};
    db.prepare('INSERT INTO subject_versions VALUES(?,?,?,?,?,?)').run(subjectVersionId, projectId, subjectId, 1, assetId, JSON.stringify(subjectVersion));
    db.prepare("INSERT INTO subject_bindings VALUES(?,?,?,?, 'subject',1,?,?,?,?)").run(bindingId, projectId, shotId, subjectId, subjectVersionId, subjectVersionId, date, date);
    db.prepare("INSERT INTO image_groups VALUES(?,?,'Synthetic',1,?,NULL,?,?)").run(groupId, projectId, imageVersionId, date, date);
    const imageVersion = {id: imageVersionId, projectId, groupId, taskId, number: 1, assetId};
    db.prepare('INSERT INTO image_versions VALUES(?,?,?,?,?,?,?)').run(imageVersionId, projectId, groupId, taskId, 1, assetId, JSON.stringify(imageVersion));
  });
  const snapshot = tools.snapshot(projectId);
  for (const [kind, id, table] of [
    ['asset_range', assetId, 'asset_ranges'], ['asset_disposition', assetId, 'asset_dispositions'], ['asset_annotation', assetId, 'asset_annotations'],
    ['subject', subjectId, 'subjects'], ['subject_version', subjectVersionId, 'subject_versions'], ['subject_binding', bindingId, 'subject_bindings'],
    ['image_group', groupId, 'image_groups'], ['image_version', imageVersionId, 'image_versions'],
  ]) {
    assert.equal(snapshot[`${kind}:${id}`]?.table, table);
    assert.ok(snapshot[`${kind}:${id}`]!.revision > 0);
  }
  const requestId = randomUUID(), input = {projectId, requestId, name: 'synthetic.png', mimeType: 'image/png', dataBase64: Buffer.from('synthetic private bytes').toString('base64')};
  const staged = await tools.stageImport(input);
  assert.deepEqual(await tools.stageImport(input), staged);
  assert.ok(staged !== null && typeof staged === 'object' && !Array.isArray(staged));
  assert.equal(readFileSync(path.join(store.localDir, 'imports', `${staged.id}.bin`), 'utf8'), 'synthetic private bytes');
  assert.equal(existsSync(path.join(store.projectDir, 'agent-imports')), false);
  assert.equal(db.prepare('SELECT relativePath FROM agent_task_imports_v2 WHERE requestId=?').get(requestId)?.relativePath, `imports/${staged.id}.bin`);
  const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
  const selected = await tools.stageImport({projectId, requestId: randomUUID(), name: 'synthetic.cube', mimeType: '', dataBase64: Buffer.from(cube).toString('base64')});
  assert.ok(selected !== null && typeof selected === 'object' && !Array.isArray(selected));
  const journal = createAgentTaskJournal(store, {policyStore: library.agentPolicy});
  const run = journal.create({projectId, requestId: randomUUID(), text: 'Import selected local cube', configuration: {}}).run;
  const prepared = tools.prepare({projectId, operation: 'lut.importSelected', input: {handle: selected.id}});
  const step = journal.beginStep(run.id, {kind: 'tool', tier: prepared.risk, targets: prepared.targets});
  journal.markDispatch(run.id, step.id);
  const outcome = await tools.execute(prepared, {runId: run.id, stepId: step.id, requestId: step.id,
    beforeEffect: () => journal.assertTargets(projectId, prepared.targets),
    recordInside: (result, changes) => journal.completeStepInside(run.id, step.id, {result, changes}),
    appendChangesInside: changes => journal.appendChangesInside(run.id, step.id, changes),
  });
  if (!outcome.recorded) journal.completeStep(run.id, step.id, {result: outcome.result, changes: outcome.changes});
  assert.equal(journal.step(step.id).status, 'completed');
  assert.equal(db.prepare('SELECT status FROM agent_task_imports_v2 WHERE id=?').get(String(selected.id))?.status, 'imported');
  assert.equal(db.prepare('SELECT count(*) AS n FROM project.project_lut_resources').get()?.n, 1);
  const jobId = randomUUID();
  store.put('jobs', {id: jobId, projectId, shotId, status: 'queued'});
  store.tx(() => db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)')
    .run('job', jobId, run.id, step.id, projectId, step.id, 'generation.submit'));
  assert.equal(collectTaskProjectOverview(store, projectId).counts.pendingBackground, 1);
  assert.equal(journal.snapshot(run.id).backgroundPending, true);
  assert.deepEqual(agentTaskJobBinding(db, 'job', jobId), {runId: run.id, stepId: step.id, projectId, requestId: step.id, operation: 'generation.submit'});
  assert.equal(agentTaskJobBinding(db, 'job', randomUUID()), undefined);
  assert.deepEqual(foreignKeyCheck(db), []);
});

test('legacy workspace schema entry points leave kernel project and TEMP target triggers intact', t => {
  const {first} = fixture(t), before = schemaObjects(first.db);
  assert.ok(before.some(row => row.schema === 'project' && row.name.startsWith('agent_target_')));
  assert.ok(before.some(row => row.schema === 'temp' && row.name.startsWith('agent_target_')));
  for (const legacy of [installAgentTaskDefinitionsV2, dropAgentTaskTargetTriggersV2]) {
    assert.throws(() => legacy(first.db), {name: 'TypeError', message: 'Agent task workspace schema operations do not accept project databases'});
  }
  assert.throws(() => validateAgentTaskRowsV2(first.db), {name: 'TypeError', message: 'Project Agent task row validation requires a live application context'});
  assert.ok(testProjectAppLibrary(first));
  validateAgentTaskRowsV2(first.db);
  assert.deepEqual(schemaObjects(first.db), before);
  const storage = readAgentTaskStorage(first.db);
  assert.equal(storage.status, 'available');
  assert.equal(storage.scope, 'project');
  assert.ok(storage.tables.every(table => !['agent_task_policy_v2', 'agent_task_policy_requests_v2'].includes(table.name)));
  assert.deepEqual(schemaObjects(first.db), before);
});
