import * as currentTaskSchema from '../packages/business/src/agent/task-schema-v2.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore, schemaObjects, foreignKeyCheck} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import type {AgentPolicyStore} from '../packages/business/src/app-db/stores.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createMioRuntime} from '../packages/business/src/agent/mio-runtime.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {collectTaskProjectOverview} from '../packages/business/src/agent/task-context-observations-v2.ts';
import {agentTaskJobBinding} from '../packages/business/src/agent/task-effects-v2.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {validateAgentTaskRowsV2} from '../packages/business/src/agent/task-schema-v2.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskToolCall, AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
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

/** Keep P2's real application CAS implementation, while project execution
 * history uses R1 records. Constructing the policy façade reads no old Mio row. */
function projectJournal(store: ProjectStore, policyStore: AgentPolicyStore) {
  const policy = createAgentTaskJournal(store, {policyStore});
  return createMioJournal(store, {policy: () => policy.policy(), lookupPolicy: requestId => policy.lookupPolicy(requestId), updatePolicy: (input, requestId) => policy.updatePolicy(input, requestId)});
}
function beginSyntheticModel(journal: ReturnType<typeof projectJournal>, runId: string, tool?: {call: AgentTaskToolCall; parameters: AgentTaskJson}) {
  const history: AgentTaskJson[] = [{role: 'user', content: journal.run(runId).text}];
  const body = JSON.stringify({model: 'synthetic', stream: true, messages: history, ...(tool ? {tools: [{type: 'function', function: {name: tool.call.name, parameters: tool.parameters}}]} : {})});
  const baseline = JSON.parse(JSON.stringify(journal.revisionSnapshot(journal.run(runId).projectId))) as AgentTaskJson;
  return journal.beginModelStep(runId, {request: {body, history}, data: {baseline}}, []);
}

test('real project journals share only injected app policy, preserving CAS, replay and project transactions', t => {
  const {library, first, second} = fixture(t);
  const testPolicy = createAgentTaskJournal(first);
  assert.deepEqual(testPolicy.policy(), DEFAULT_AGENT_TASK_POLICY);
  assert.notEqual(testProjectAppLibrary(first)?.db, library.db);
  const policyStore = library.agentPolicy;
  const a = projectJournal(first, policyStore), b = projectJournal(second, policyStore);
  assert.deepEqual(a.policy(), DEFAULT_AGENT_TASK_POLICY);
  const requestId = randomUUID(), input = {...a.policy(), stepLimit: 12, modes: {...a.policy().modes, local_reversible: 'confirm' as const}};
  const saved = a.updatePolicy(input, requestId);
  assert.deepEqual(saved, {...input, revision: 1, stepLimit: DEFAULT_AGENT_TASK_POLICY.stepLimit});
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
  const modes = {...saved.modes, local_irreversible: 'direct' as const};
  assert.throws(() => first.tx(() => {a.updatePolicy({revision: saved.revision, modes}, randomUUID()); throw Error('project rollback');}), /project rollback/);
  assert.deepEqual(b.policy(), {...saved, revision: 2, modes});
  const run = a.create({projectId: first.projectId, requestId: randomUUID(), text: 'Synthetic model step', configuration: {protocol: 'chat_completions', model: 'synthetic'}}).run;
  const model = beginSyntheticModel(a, run.id);
  assert.deepEqual(a.snapshot(run.id).steps, [model]);
  const events = a.events(run.id); assert.ok(events.length > 0);
  assert.ok(events.every(event => event.type === 'invalidate' && event.data === null));
  assert.equal(a.eventSequence(run.id), events.at(-1)?.sequence);
  assert.deepEqual(first.db.prepare('PRAGMA main.table_info(mio_events)').all().map(row => row.name), ['runId', 'sequence', 'createdAt']);
  const records = createMioRecords(first), stored = records.request(records.step(model.id).currentRequestId!);
  assert.equal(stored.originalBody, (model.request as {body: string}).body);
  assert.ok(stored.inputManifest.entryIds.includes(records.entries(run.id).find(entry => entry.kind === 'user_message')!.id));
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
  const journal = projectJournal(first, store);
  const before = journal.updatePolicy({revision: 0, modes: {...DEFAULT_AGENT_TASK_POLICY.modes, local_reversible: 'confirm'}}, randomUUID());
  const requestId = randomUUID(), receipts = library.db.prepare('SELECT * FROM agent_task_policy_requests_v2 ORDER BY requestId').all();
  library.tx(() => {
    assert.throws(() => journal.updatePolicy({revision: before.revision, modes: {...before.modes, local_irreversible: 'direct'}}, requestId), /Nested transactions are not supported/u);
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
  const runtime = createMioRuntime({store: first, policyStore: library.agentPolicy, agentSettings: settings,
    authorizations: createTestAuthorizations(first, settings), selfPort: () => 4318});
  t.after(() => runtime.close());
  const input = {requestId: randomUUID(), expectedRevision: 0, modes: {...runtime.policy().modes, paid: 'direct'}};
  assert.throws(() => runtime.updatePolicy(input), {code: 'AGENT_TASK_APPROVAL_REQUIRED'});
  assert.equal(library.agentPolicy.read(), null);
  assert.equal(runtime.updatePolicy({...input, acknowledgePaid: true}).modes.paid, 'direct');
  assert.throws(() => runtime.updatePolicy({...input, requestId: randomUUID()}), {code: 'AGENT_TASK_REVISION_CONFLICT'});
});

test('project tools snapshot all eight attached content families and stage attachments under localDir/imports', async t => {
  const {root, library, first: store} = fixture(t), {db, projectId} = store;
  const services = createServices(store, new Map(), {application: createProjectServiceApplication(library)});
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
  assert.equal(db.prepare('SELECT relativePath FROM mio_imports WHERE requestId=?').get(requestId)?.relativePath, `imports/${staged.id}.bin`);
  const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
  const selected = await tools.stageImport({projectId, requestId: randomUUID(), name: 'synthetic.cube', mimeType: '', dataBase64: Buffer.from(cube).toString('base64')});
  assert.ok(selected !== null && typeof selected === 'object' && !Array.isArray(selected));
  const journal = projectJournal(store, library.agentPolicy);
  const run = journal.create({projectId, requestId: randomUUID(), text: 'Import selected local cube', configuration: {protocol: 'chat_completions', model: 'synthetic'}}).run;
  const prepared = tools.prepare({projectId, operation: 'lut.importSelected', input: {handle: selected.id}});
  assert.equal(typeof selected.id, 'string');
  const call: AgentTaskToolCall = {id: 'import-selected-cube', name: 'mioon_lut_import_selected', arguments: {handle: selected.id}};
  const definition = tools.list().find(tool => tool.name === call.name); assert.ok(definition);
  const model = beginSyntheticModel(journal, run.id, {call, parameters: definition.parameters as AgentTaskJson});
  journal.markDispatch(run.id, model.id);
  journal.completeStep(run.id, model.id, {result: {text: '', toolCalls: [call as unknown as AgentTaskJson], providerOutput: {role: 'assistant', content: null, tool_calls: [{id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}]}}});
  const step = journal.beginStep(run.id, {kind: 'tool', toolCall: call, data: {sourceModelStepId: model.id}, tier: prepared.risk, targets: prepared.targets});
  journal.markDispatch(run.id, step.id);
  const outcome = await tools.execute(prepared, {runId: run.id, stepId: step.id, requestId: step.id,
    beforeEffect: () => journal.assertTargets(projectId, prepared.targets),
    recordInside: (result, changes) => journal.completeStepInside(run.id, step.id, {result, changes}),
    appendChangesInside: changes => journal.appendChangesInside(run.id, step.id, changes),
  });
  if (!outcome.recorded) journal.completeStep(run.id, step.id, {result: outcome.result, changes: outcome.changes});
  assert.equal(journal.step(step.id).status, 'completed');
  assert.equal(db.prepare('SELECT status FROM mio_imports WHERE id=?').get(String(selected.id))?.status, 'imported');
  assert.equal(db.prepare('SELECT count(*) AS n FROM project.project_lut_resources').get()?.n, 1);
  const jobId = randomUUID();
  store.put('jobs', {id: jobId, projectId, shotId, status: 'queued'});
  store.tx(() => db.prepare('INSERT INTO mio_job_origins(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)')
    .run('job', jobId, run.id, step.id, projectId, step.id, 'generation.submit'));
  assert.equal(collectTaskProjectOverview(store, projectId).counts.pendingBackground, 1);
  assert.equal(journal.snapshot(run.id).backgroundPending, true);
  assert.deepEqual(agentTaskJobBinding(db, 'job', jobId), {runId: run.id, stepId: step.id, projectId, requestId: step.id, operation: 'generation.submit'});
  assert.equal(agentTaskJobBinding(db, 'job', randomUUID()), undefined);
  assert.deepEqual(foreignKeyCheck(db), []);
});

test('current row validation leaves content TEMP and history process target triggers intact', t => {
  const {first} = fixture(t), before = schemaObjects(first.db);
  assert.ok(before.some(row => row.schema === 'project' && row.name.startsWith('agent_target_')));
  assert.ok(before.some(row => row.schema === 'temp' && row.name === 'subject_variant_version_binding'));
  assert.ok(before.some(row => row.schema === 'temp' && row.name === 'scene_result_identity'));
  for (const table of ['jobs', 'exports', 'image_tasks', 'frame_tasks']) for (const operation of ['insert', 'update', 'delete']) {
    const name = `agent_target_${table}_${operation}_v2`;
    assert.ok(before.some(row => row.schema === 'main' && row.name === name));
    assert.equal(before.some(row => row.schema === 'project' && row.name === name), false);
    assert.equal(before.some(row => row.schema === 'temp' && row.name === name), false);
  }
  assert.ok(before.some(row => row.schema === 'project' && row.name === 'agent_target_shots_update_v2'));
  assert.ok(before.some(row => row.schema === 'project' && row.name === 'agent_target_subjects_update_v2'));
  for (const retired of ['installAgentTaskDefinitionsV2','dropAgentTaskTargetTriggersV2']) {
    assert.equal(Object.hasOwn(currentTaskSchema,retired),false,'Legacy schema mutation capability is absent');
  }
  assert.throws(() => validateAgentTaskRowsV2(first.db), {name: 'TypeError', message: 'Project Agent task row validation requires a live application context'});
  assert.ok(testProjectAppLibrary(first));
  validateAgentTaskRowsV2(first.db);
  assert.deepEqual(schemaObjects(first.db), before);
  const storage = readMioStorage(first.db);
  assert.equal(storage.status, 'available');
  assert.equal(storage.scope, 'project');
  assert.ok(storage.tables.every(table => !['agent_task_policy_v2', 'agent_task_policy_requests_v2'].includes(table.name)));
  assert.deepEqual(schemaObjects(first.db), before);
});
