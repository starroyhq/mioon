import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AppError} from '../packages/contracts/src/app-error.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createServerProject} from './helpers/project-database.ts';
import {beginFixtureToolStep, mioFixtureConfiguration} from './helpers/mio-model-fixture.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {createProjectServiceApplication, testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createMioProjectJournal} from '../packages/business/src/agent/mio-journal-factory.ts';
import {withTaskEffectOrigin, withAgentTaskJobOrigin} from '../packages/business/src/agent/task-effects-v2.ts';
import type {AgentTaskEffectOrigin} from '../packages/business/src/agent/task-effects-v2.ts';
import {installProjectVersionCapture, saveBeforeBulkChangeInside} from '../packages/business/src/project-versions/capture.ts';
import {decodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import type {EncodedProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import {captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {previewDifferences} from '../packages/business/src/project-versions/preview.ts';
import {registerProjectTransactionObserver} from '../packages/business/src/project-file/store.ts';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
function fixture(t: TestContext, options: {now?: () => Date} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'project-version-capture-'));
  const {store, projectId} = createServerProject(root, {name: 'Mio capture'});
  const library = testProjectAppLibrary(store)!, owner = new AbortController();
  const application = createProjectServiceApplication(library, owner.signal, {});
  const provider: Provider = {id: 'mock', capabilities: {models: ['mock-motion-v1'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [2], mock: true, configured: true, enabled: true},
    async submit() {throw Error('No provider dispatch is expected');}, async reconcile() {return null;}, async poll() {return {status: 'running'};}, async download() {throw Error('No download is expected');}};
  const services = createServices(store, new Map([['mock', provider]]), {application, env: {}, imageOptions: {autoRun: false}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false}});
  const dispose = installProjectVersionCapture(store, {assertMutationAllowed: () => services.assertMutationAllowed(), ...options});
  const journal = createMioProjectJournal(store, library.agentPolicy), tools = createAgentTaskTools({store, services, journal, policyStore: library.agentPolicy});
  const run = journal.create({requestId: randomUUID(), projectId, text: 'Capture a local edit', configuration: mioFixtureConfiguration}).run;
  t.after(async () => {tools.dispose(); dispose(); await services.drain(); store.close(); rmSync(root, {recursive: true, force: true});});
  const counts = () => ['project_versions', 'project_version_blobs', 'project_version_requests', 'project_version_capture_marks']
    .map(table => Number(store.db.prepare(`SELECT count(*) n FROM main.${table}`).get()!.n));
  const sequence = () => Number(store.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence);
  const versions = () => store.db.prepare('SELECT * FROM main.project_versions ORDER BY rowid').all();
  const document = (id: string) => decodeProjectDocument(store.db.prepare('SELECT b.* FROM main.project_version_blobs b JOIN main.project_versions v ON v.blobHash=b.hash WHERE v.id=?').get(id) as unknown as EncodedProjectDocument);
  const origin = (runId = run.id, recorded = false): AgentTaskEffectOrigin => ({runId, stepId: randomUUID(), projectId, requestId: randomUUID(), operation: 'shot.update',
    recorded, beforeEffect() {}, recordInside() {throw Error('The synthetic transaction has no task receipt');}});
  const execute = async (operation: string, input: Record<string, unknown>, failRecord = false) => {
    const prepared = tools.prepare({projectId, operation, input});
    const step = beginFixtureToolStep(journal, run.id, {tier: prepared.risk, targets: prepared.targets,
      toolCall: {id: randomUUID(), name: tools.list().find(tool => tool.operation === prepared.operation)!.name, arguments: input as AgentTaskJson}});
    journal.markDispatch(run.id, step.id);
    const outcome = await tools.execute(prepared, {runId: run.id, stepId: step.id, requestId: step.id,
      beforeEffect: () => journal.assertTargets(projectId, prepared.targets),
      recordInside: (result, changes) => {if (failRecord) throw Error('Synthetic task receipt storage failure'); journal.completeStepInside(run.id, step.id, {result, changes});},
      appendChangesInside: changes => journal.appendChangesInside(run.id, step.id, changes)});
    if (!outcome.recorded) journal.completeStep(run.id, step.id, {result: outcome.result, changes: outcome.changes});
    return {outcome, step};
  };
  return {root, store, projectId, library, owner, services, journal, tools, run, counts, sequence, versions, document, origin, execute, dispose};
}

test('the first actual Mio tool write saves its pre-state and pre-change attribution boundary only once per run', async t => {
  const f = fixture(t), before = f.sequence();
  const first = await f.execute('shot.create', {title: 'Mio first shot', duration: 2});
  assert.equal(first.outcome.recorded, true);
  assert.deepEqual(f.counts(), [1, 1, 0, 1]);
  const version = f.versions()[0];
  assert.equal(version.trigger, 'mio-turn'); assert.equal(version.mioRunId, f.run.id);
  assert.equal(version.contentSequence, before); assert.equal(version.mioChangeRowid, 0);
  const saved = f.document(String(version.id));
  assert.deepEqual(saved.tables.shots, []); assert.equal(saved.evidence.contentSequence, before);
  const changes = f.store.tx(() => previewDifferences(f.store, saved, captureProjectDocumentInside(f.store), Number(version.mioChangeRowid), String(version.createdAt)));
  assert.ok(changes.some(change => change.table === 'shots' && change.source === 'mio'));
  assert.ok(record(first.outcome.result));
  await f.execute('shot.update', {shotId: first.outcome.result.id, expectedRevision: first.outcome.result.revision, patch: {title: 'Second edit'}});
  assert.deepEqual(f.counts(), [1, 1, 0, 1]);
});

test('history-only, no-op and rolled-back transactions leave no run mark; a same-value content UPDATE captures', async t => {
  const f = fixture(t), shot = await f.services.call('shot.create', {projectId: f.projectId, title: 'Already saved', duration: 2}) as {id: string};
  const origin = f.origin(), before = f.sequence();
  withTaskEffectOrigin(origin, () => f.store.tx(() => {f.store.db.exec('UPDATE main.history_state SET seenContentSequence=seenContentSequence');}));
  withTaskEffectOrigin(origin, () => f.store.tx(() => f.store.get('shots', shot.id)));
  assert.equal(f.sequence(), before); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
  assert.throws(() => withTaskEffectOrigin(origin, () => f.store.tx(() => {
    f.store.db.prepare('UPDATE project.shots SET data=data WHERE id=?').run(shot.id); throw Error('Synthetic domain rollback');
  })), /Synthetic domain rollback/u);
  assert.equal(f.sequence(), before); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
  withTaskEffectOrigin(origin, () => f.store.tx(() => f.store.db.prepare('UPDATE project.shots SET data=data WHERE id=?').run(shot.id)));
  assert.ok(f.sequence() > before); assert.deepEqual(f.counts(), [1, 1, 0, 1]);
});

test('capture preparation errors do not block history-only work and reject the actual content transaction', t => {
  let denied = true;
  const failure = new AppError('PROJECT_VERSION_SNAPSHOT_LIMIT', 'Synthetic snapshot capacity failure', 413);
  const f = fixture(t, {now: () => {if (denied) throw failure; return new Date('2026-11-03T00:00:00.000Z');}}), origin = f.origin();
  withTaskEffectOrigin(origin, () => f.store.tx(() => f.store.db.exec('UPDATE main.history_state SET seenContentSequence=seenContentSequence')));
  const before = f.sequence();
  assert.throws(() => withTaskEffectOrigin(origin, () => f.store.tx(() => f.store.put('shots', {id: randomUUID(), projectId: f.projectId, title: 'Must roll back'}))), error => error === failure);
  assert.deepEqual(f.store.list('shots'), []); assert.deepEqual(f.counts(), [0, 0, 0, 0]); assert.equal(f.sequence(), before);
  denied = false;
  withTaskEffectOrigin(origin, () => f.store.tx(() => f.store.put('shots', {id: randomUUID(), projectId: f.projectId, title: 'A later real write'})));
  assert.deepEqual(f.counts(), [1, 1, 0, 1]);
});

test('a failing Mio receipt rolls back the domain write, pre-state, mark and attribution journal together', async t => {
  const f = fixture(t), before = f.sequence();
  await assert.rejects(f.execute('shot.create', {title: 'Receipt failure', duration: 2}, true), /Synthetic task receipt storage failure/u);
  assert.deepEqual(f.store.list('shots'), []); assert.deepEqual(f.counts(), [0, 0, 0, 0]); assert.equal(f.sequence(), before);
  assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
  assert.equal(f.journal.snapshot(f.run.id).steps.filter(step => step.kind === 'tool').at(-1)?.result, undefined);
  await f.execute('shot.create', {title: 'Successful later tool', duration: 2});
  assert.deepEqual(f.counts(), [1, 1, 0, 1]);
});

test('two asynchronous run origins capture only their own first synchronous transaction', async t => {
  const f = fixture(t);
  f.journal.transition(f.run.id, f.journal.run(f.run.id).revision, 'completed');
  const second = f.journal.create({requestId: randomUUID(), projectId: f.projectId, text: 'Second run', configuration: mioFixtureConfiguration}).run;
  const one = f.origin(f.run.id, true), two = f.origin(second.id);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {release = resolve;});
  const first = withTaskEffectOrigin(one, async () => {await waiting; f.store.tx(() => f.store.put('shots', {id: randomUUID(), projectId: f.projectId, title: 'First resumed'}));});
  await withTaskEffectOrigin(two, async () => {await Promise.resolve(); f.store.tx(() => f.store.put('shots', {id: randomUUID(), projectId: f.projectId, title: 'Second commits first'}));});
  release(); await first;
  assert.deepEqual(f.counts(), [2, 2, 0, 2]);
  assert.deepEqual(f.versions().map(row => row.mioRunId), [second.id, f.run.id]);
  assert.deepEqual(f.versions().map(row => f.document(String(row.id)).tables.shots.length), [0, 1]);
});

test('a recorded background task can make the run first content publication', async t => {
  const f = fixture(t), shot = await f.services.call('shot.create', {projectId: f.projectId, title: 'Background owner', duration: 2}) as {id: string; revision: number};
  const accepted = await f.execute('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, providerId: 'mock', model: 'mock-motion-v1'});
  assert.ok(record(accepted.outcome.result));
  assert.deepEqual(f.counts(), [0, 0, 0, 0], 'acceptance writes only history');
  withAgentTaskJobOrigin(f.store.db, 'job', String(accepted.outcome.result.id), () => f.store.tx(() => {
    f.store.put('assets', {id: randomUUID(), projectId: f.projectId, name: 'Published result', mimeType: 'video/mp4'});
  }));
  assert.deepEqual(f.counts(), [1, 1, 0, 1]);
  assert.equal(f.versions()[0].mioRunId, f.run.id);
  assert.deepEqual(f.document(String(f.versions()[0].id)).tables.assets, []);
});

test('LUT raw transactions join capture before any Mio acknowledgement and keep exact import replay', async t => {
  const f = fixture(t), input = {projectId: f.projectId, requestId: randomUUID(), name: 'Captured.cube', dataBase64: Buffer.from(cube).toString('base64')};
  let acknowledgements = 0;
  const origin: AgentTaskEffectOrigin = {...f.origin(), operation: 'lut.importSelected', recordInside: () => {acknowledgements++;}};
  const before = f.sequence();
  f.store.db.exec("CREATE TEMP TRIGGER synthetic_version_capacity BEFORE INSERT ON main.project_versions BEGIN SELECT RAISE(ABORT,'Synthetic version storage full');END");
  await assert.rejects(withTaskEffectOrigin(origin, () => f.services.call('lut.import', input)), {code: 'LUT_STORAGE_UNAVAILABLE'});
  assert.equal(origin.recorded, false); assert.equal(acknowledgements, 0);
  assert.deepEqual(f.counts(), [0, 0, 0, 0]); assert.equal(f.sequence(), before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM project.project_lut_resources').get()!.n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.lut_import_requests').get()!.n, 0);
  f.store.db.exec('DROP TRIGGER synthetic_version_capacity');
  const result = await withTaskEffectOrigin(origin, () => f.services.call('lut.import', input));
  assert.equal(origin.recorded, true); assert.equal(acknowledgements, 1);
  assert.deepEqual(f.counts(), [1, 1, 0, 1]);
  assert.deepEqual(f.document(String(f.versions()[0].id)).tables.project_lut_resources, []);
  assert.deepEqual(await withTaskEffectOrigin(origin, () => f.services.call('lut.import', input)), result);
  assert.equal(acknowledgements, 1); assert.deepEqual(f.counts(), [1, 1, 0, 1]);
});

test('the official selected-LUT tool captures its first write and binds the real Mio receipt atomically', async t => {
  const f = fixture(t), selected = await f.tools.stageImport({projectId: f.projectId, requestId: randomUUID(), name: 'Selected.cube', mimeType: '', dataBase64: Buffer.from(cube).toString('base64')});
  assert.ok(record(selected)); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
  const admitted = await f.execute('lut.importSelected', {handle: selected.id});
  assert.equal(admitted.outcome.recorded, true);
  assert.equal(f.journal.step(admitted.step.id).status, 'completed');
  assert.equal(f.journal.snapshot(f.run.id).changes.length, 1);
  assert.deepEqual(f.counts(), [1, 1, 0, 1]);
  assert.deepEqual(f.document(String(f.versions()[0].id)).tables.project_lut_resources, []);
  const changes = f.store.tx(() => previewDifferences(f.store, f.document(String(f.versions()[0].id)), captureProjectDocumentInside(f.store),
    Number(f.versions()[0].mioChangeRowid), String(f.versions()[0].createdAt)));
  assert.ok(changes.some(change => change.table === 'project_lut_resources' && change.source === 'mio'));
  const before = f.counts();
  await f.execute('lut.importSelected', {handle: selected.id});
  assert.deepEqual(f.counts(), before); assert.equal(f.journal.snapshot(f.run.id).changes.length, 1);
});

test('selected-LUT snapshot capacity failure leaves no business row, capture mark or false completion', async t => {
  const failure = new AppError('PROJECT_VERSION_SNAPSHOT_LIMIT', 'Synthetic capture preparation capacity failure', 413);
  const f = fixture(t, {now: () => {throw failure;}});
  const selected = await f.tools.stageImport({projectId: f.projectId, requestId: randomUUID(), name: 'Too-full.cube', mimeType: '', dataBase64: Buffer.from(cube).toString('base64')});
  assert.ok(record(selected)); const before = f.sequence();
  await assert.rejects(f.execute('lut.importSelected', {handle: selected.id}), error => error === failure);
  assert.deepEqual(f.counts(), [0, 0, 0, 0]); assert.equal(f.sequence(), before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM project.project_lut_resources').get()!.n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.lut_import_requests').get()!.n, 0);
  assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
  const tool = f.journal.snapshot(f.run.id).steps.filter(step => step.kind === 'tool').at(-1)!;
  assert.equal(tool.result, undefined); assert.notEqual(tool.status, 'completed');
  // The earlier import admission is deliberately retained. It does not grant
  // permission to repeat an uncertain accepted tool or invent a completion.
  assert.equal(f.store.db.prepare('SELECT status FROM main.mio_imports WHERE id=?').get(String(selected.id))!.status, 'importing');
  await assert.rejects(f.execute('lut.importSelected', {handle: selected.id}), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  assert.deepEqual(f.counts(), [0, 0, 0, 0]);
});

test('Mio capture application admission rejects aborted and replaced B1 owners before any write', async t => {
  for (const mode of ['aborted', 'replaced'] as const) await t.test(mode, async child => {
    const f = fixture(child), origin = f.origin(), before = f.store.db.prepare('SELECT total_changes() n').get()!.n;
    let replacement: ReturnType<typeof openAppLibrary> | undefined;
    const reason = new Error('Application capture owner stopped');
    if (mode === 'aborted') f.owner.abort(reason);
    else {f.library.close(); replacement = openAppLibrary({dataDir: f.root}); child.after(() => replacement!.close());}
    const action = () => withTaskEffectOrigin(origin, () => f.store.tx(() => {
      f.store.db.exec('UPDATE main.history_state SET seenContentSequence=seenContentSequence');
      f.store.put('shots', {id: randomUUID(), projectId: f.projectId, title: 'Denied'});
    }));
    if (mode === 'aborted') assert.throws(action, error => error === reason);
    else {assert.doesNotThrow(() => createProjectServiceApplication(replacement!).assertMutationAllowed()); assert.throws(action, {name: 'TypeError', message: 'Project services require a live application library owner'});}
    assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n, before);
    assert.deepEqual(f.counts(), [0, 0, 0, 0]); assert.deepEqual(f.store.list('shots'), []);
  });
});

test('bulk pre-state and domain changes share rollback and snapshot identity; missing admission is refused', t => {
  const f = fixture(t), before = f.sequence();
  assert.throws(() => saveBeforeBulkChangeInside(f.store, {trigger: 'restore', requestId: randomUUID(), assertMutationAllowed: () => f.services.assertMutationAllowed()}), /live project transaction/u);
  const remove = registerProjectTransactionObserver(f.store.db, () => {throw Error('Synthetic bulk commit failure');});
  assert.throws(() => f.store.tx(() => {
    saveBeforeBulkChangeInside(f.store, {trigger: 'restore', requestId: randomUUID(), assertMutationAllowed: () => f.services.assertMutationAllowed()});
    f.store.put('shots', {id: randomUUID(), projectId: f.projectId, title: 'Rolled back bulk'});
  }), /Synthetic bulk commit failure/u);
  remove(); assert.deepEqual(f.counts(), [0, 0, 0, 0]); assert.equal(f.sequence(), before);
  const saved = f.store.tx(() => {
    const version = saveBeforeBulkChangeInside(f.store, {trigger: 'restore', requestId: randomUUID(), assertMutationAllowed: () => f.services.assertMutationAllowed()});
    f.store.put('shots', {id: randomUUID(), projectId: f.projectId, title: 'Bulk after snapshot'}); return version;
  });
  assert.equal(saved.trigger, 'restore'); assert.equal(saved.contentSequence, before);
  assert.deepEqual(f.document(saved.id).tables.shots, []); assert.deepEqual(f.counts(), [1, 1, 0, 0]);
});

test('rotating away an automatic version keeps its run mark and cannot take a second first-write snapshot', async t => {
  const f = fixture(t, {now: () => new Date('2026-10-01T00:00:00.000Z')});
  const first = await f.execute('shot.create', {title: 'A run whose old version is rotated', duration: 2});
  assert.ok(record(first.outcome.result));
  const originalId = String(f.versions()[0].id);
  for (let index = 0; index < 21; index++) f.store.tx(() => saveBeforeBulkChangeInside(f.store, {trigger: 'bulk-change', requestId: randomUUID(),
    assertMutationAllowed: () => f.services.assertMutationAllowed(), now: () => new Date(Date.UTC(2026, 10, 3, 0, 0, index)), timeZone: () => 'UTC'}));
  assert.equal(f.store.db.prepare('SELECT 1 FROM main.project_versions WHERE id=?').get(originalId), undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM main.project_version_capture_marks WHERE kind='mio-turn' AND key=?").get(f.run.id)!.n, 1);
  const before = f.counts();
  await f.execute('shot.update', {shotId: first.outcome.result.id, expectedRevision: first.outcome.result.revision, patch: {title: 'Later same-run edit'}});
  assert.deepEqual(f.counts(), before);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM main.project_versions WHERE trigger='mio-turn'").get()!.n, 0);
});
