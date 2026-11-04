import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {AgentTaskChange, AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createServerProject, openServerProject} from './helpers/project-database.ts';
import {beginFixtureToolStep, mioFixtureConfiguration} from './helpers/mio-model-fixture.ts';
import {createTestAuthorizations} from './helpers/agent-authorizations.ts';
import {createServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createMioProjectJournal} from '../packages/business/src/agent/mio-journal-factory.ts';
import {createAgentTaskTools, projectAgentTaskUndo} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {installProjectVersionCapture} from '../packages/business/src/project-versions/capture.ts';
import {captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {copyProjectVersionsInside} from '../packages/business/src/project-versions/copy.ts';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
interface Shot {id: string; revision: number; prompt: string; orderIndex: number}
async function fixture(t: TestContext, sharedProjectId?: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'project-version-mio-undo-')), created = createServerProject(root, {name: 'Version undo combination', ...(sharedProjectId ? {projectId: sharedProjectId} : {})});
  let store = created.store;
  const projectId = created.projectId, settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  function assemble() {
    const library = testProjectAppLibrary(store)!, services = createServices(store, new Map(), {env: {}, imageOptions: {autoRun: false}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false}});
    const dispose = installProjectVersionCapture(store, {assertMutationAllowed: () => services.assertMutationAllowed()});
    const journal = createMioProjectJournal(store, library.agentPolicy), tools = createAgentTaskTools({store, services, journal, policyStore: library.agentPolicy});
    const runtime = createAgentTaskRuntime({store, agentSettings: settings, authorizations: createTestAuthorizations(store, settings), tools, journal,
      policyStore: library.agentPolicy, selfPort: () => 4318, assertMutationAllowed: () => services.assertMutationAllowed()});
    const versions = createProjectVersions(store, {assertMutationAllowed: () => services.assertMutationAllowed()});
    return {services, journal, tools, runtime, versions, async close() {runtime.close(); tools.dispose(); dispose(); await services.drain();}};
  }
  let current = assemble();
  const run = current.journal.create({requestId: randomUUID(), projectId, text: 'Restore and compensate independent targets', configuration: mioFixtureConfiguration}).run;
  t.after(async () => {await current.close(); await settings.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  const state = () => ({content: store.tx(() => captureProjectDocumentInside(store)), changes: store.db.prepare('SELECT * FROM main.mio_changes ORDER BY rowid').all(),
    versions: store.db.prepare('SELECT * FROM main.project_versions ORDER BY rowid').all(), receipts: store.db.prepare('SELECT * FROM main.project_version_requests ORDER BY rowid').all(),
    total: store.db.prepare('SELECT total_changes() n').get()!.n});
  const shot = (id: string): Shot => store.get('shots', id) as Shot;
  async function execute(operation: string, input: Record<string, unknown>) {
    const prepared = current.tools.prepare({projectId, operation, input}), step = beginFixtureToolStep(current.journal, run.id, {
      tier: prepared.risk, targets: prepared.targets, toolCall: {id: randomUUID(), name: current.tools.list().find(tool => tool.operation === operation)!.name, arguments: input as AgentTaskJson}});
    current.journal.markDispatch(run.id, step.id);
    const outcome = await current.tools.execute(prepared, {runId: run.id, stepId: step.id, requestId: step.id,
      beforeEffect: () => current.journal.assertTargets(projectId, prepared.targets),
      recordInside: (result, changes) => current.journal.completeStepInside(run.id, step.id, {result, changes}),
      appendChangesInside: changes => current.journal.appendChangesInside(run.id, step.id, changes)});
    if (!outcome.recorded) current.journal.completeStep(run.id, step.id, {result: outcome.result, changes: outcome.changes});
    return current.journal.snapshot(run.id).changes.filter(change => change.stepId === step.id);
  }
  const restore = (versionId: string) => {
    const preview = current.versions.preview({projectId, versionId});
    return current.versions.restore({projectId, versionId, requestId: randomUUID(), expectedContentSequence: preview.contentSequence, expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest});
  };
  const undo = (change: AgentTaskChange) => current.tools.undo(change, {beforeEffect: () => current.services.assertMutationAllowed(),
    recordInside: item => {current.journal.markChangeRevertedInside(item.id);}, retainInside: (item, reason) => {current.journal.markChangeRetainedInside(item.id, reason);}});
  return {projectId, run, execute, restore, undo, shot, state,
    get store() {return store;}, get journal() {return current.journal;}, get services() {return current.services;}, get versions() {return current.versions;}, get runtime() {return current.runtime;},
    async reopen() {await current.close(); store.close(); store = openServerProject(root, projectId); current = assemble();}};
}

test('a new real Mio edit is attributable after raw version copying even below the original rowid boundary', async t => {
  const source = await fixture(t), shot = await source.services.call('shot.create', {projectId: source.projectId, title: 'Copied content', prompt: 'Before', duration: 2}) as Shot;
  for (const prompt of ['First Mio edit', 'Captured Mio edit']) await source.execute('shot.update', {
    shotId: shot.id, expectedRevision: source.shot(shot.id).revision, patch: {prompt}});
  const saved = source.versions.save({projectId: source.projectId, requestId: randomUUID()}).version;
  const oldBoundary = Number(source.store.db.prepare('SELECT mioChangeRowid FROM main.project_versions WHERE id=?').get(saved.id)!.mioChangeRowid);
  assert.equal(oldBoundary, 2);
  const target = await fixture(t, source.projectId);
  // The real switch retains this project content and its persistent target
  // ledger. Construct that same content with a separate empty history owner.
  target.store.put('shots', source.shot(shot.id));
  const ledger = source.store.db.prepare('SELECT * FROM project.agent_task_target_revisions_v2 ORDER BY kind,targetId').all();
  target.store.tx(() => {
    for (const row of ledger) target.store.db.prepare('INSERT INTO project.agent_task_target_revisions_v2(projectId,kind,targetId,revision) VALUES(?,?,?,?) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=excluded.revision')
      .run(row.projectId, row.kind, row.targetId, row.revision);
    copyProjectVersionsInside(source.store.db, target.store.db, {projectId: source.projectId});
  });
  assert.equal(target.store.db.prepare('SELECT count(*) n FROM main.mio_changes').get()!.n, 0);
  assert.equal(target.store.db.prepare('SELECT 1 FROM main.mio_runs WHERE id=?').get(source.run.id), undefined, 'old execution authority is not copied');
  const [change] = await target.execute('shot.update', {shotId: shot.id, expectedRevision: target.shot(shot.id).revision, patch: {prompt: 'New domain Mio edit'}});
  const newRowid = Number(target.store.db.prepare('SELECT rowid FROM main.mio_changes WHERE id=?').get(change.id)!.rowid);
  assert.ok(newRowid < oldBoundary); assert.ok(change.targets.some(item => Number(item.revisionAfter) > Number(ledger.find(row => row.kind === 'shot' && row.targetId === shot.id)!.revision)));
  const state = target.state(), preview = target.versions.preview({projectId: target.projectId, versionId: saved.id});
  assert.equal(preview.changes.find(item => item.table === 'shots' && item.key.includes(shot.id))!.source, 'mio');
  assert.deepEqual(target.state(), state, 'attribution reads neither rewrite change state nor grant old undo authority');
});

async function restoredIndependentTargets(t: TestContext) {
  const f = await fixture(t), a = await f.services.call('shot.create', {projectId: f.projectId, title: 'Restored target', prompt: 'A before', duration: 2}) as Shot,
    b = await f.services.call('shot.create', {projectId: f.projectId, title: 'Independent target', prompt: 'B before', duration: 2}) as Shot;
  const [independent] = await f.execute('shot.update', {shotId: b.id, expectedRevision: b.revision, patch: {prompt: 'B by Mio'}});
  const saved = f.versions.save({projectId: f.projectId, requestId: randomUUID(), name: 'A before and B after'});
  const [restored] = await f.execute('shot.update', {shotId: a.id, expectedRevision: a.revision, patch: {prompt: 'A by Mio'}});
  f.journal.transition(f.run.id, f.journal.run(f.run.id).revision, 'completed');
  const changes = f.store.db.prepare('SELECT * FROM main.mio_changes ORDER BY rowid').all(), bRevision = f.journal.targetRevision(f.projectId, 'shot', b.id);
  const result = f.restore(saved.version.id);
  assert.ok(result.appliedChanges.some(change => change.table === 'shots'));
  assert.equal(f.shot(a.id).prompt, 'A before'); assert.equal(f.shot(b.id).prompt, 'B by Mio');
  assert.ok(f.journal.targetRevision(f.projectId, 'shot', a.id) > restored.targets[0]!.revision);
  assert.equal(f.journal.targetRevision(f.projectId, 'shot', b.id), bRevision);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM main.mio_changes ORDER BY rowid').all(), changes, 'restore must not mark changes superseded or rewrite Mio evidence');
  return Object.assign(f, {a, b, independent, restored, restoredVersionId: saved.version.id});
}

test('a restored target refuses stale single compensation with zero writes while an independent target remains undoable', async t => {
  const f = await restoredIndependentTargets(t), before = f.state();
  assert.throws(() => f.undo(f.restored), {code: 'AGENT_TASK_TARGET_CHANGED'});
  assert.deepEqual(f.state(), before);
  f.undo(f.independent);
  assert.equal(f.shot(f.a.id).prompt, 'A before'); assert.equal(f.shot(f.b.id).prompt, 'B before');
  const states = new Map(f.journal.snapshot(f.run.id).changes.map(change => [change.id, change.status]));
  assert.equal(states.get(f.restored.id), 'applied'); assert.equal(states.get(f.independent.id), 'reverted');
});

test('the native undo_all keeps a restored target superseded and compensates only its independent target', async t => {
  const f = await restoredIndependentTargets(t);
  const projected = projectAgentTaskUndo(f.store, f.projectId, f.journal.snapshot(f.run.id).changes);
  assert.equal(projected.get(f.restored.id)?.undoDisposition, 'retain');
  assert.equal(projected.get(f.independent.id)?.undoDisposition, 'undo');
  const result = await f.runtime.action(f.projectId, f.run.id, {requestId: randomUUID(), expectedRevision: f.journal.run(f.run.id).revision, action: 'undo_all'});
  assert.equal(result.run.status, 'reverted');
  const states = new Map(result.changes.map(change => [change.id, change.status]));
  assert.equal(states.get(f.restored.id), 'superseded'); assert.equal(states.get(f.independent.id), 'reverted');
  assert.equal(f.shot(f.a.id).prompt, 'A before'); assert.equal(f.shot(f.b.id).prompt, 'B before');
});

test('real connection reopen retains the restored revision fence and independent undo eligibility', async t => {
  const f = await restoredIndependentTargets(t);
  await f.reopen();
  const before = f.state();
  assert.throws(() => f.undo(f.restored), {code: 'AGENT_TASK_TARGET_CHANGED'});
  assert.deepEqual(f.state(), before);
  assert.equal(projectAgentTaskUndo(f.store, f.projectId, f.journal.snapshot(f.run.id).changes).get(f.independent.id)?.undoDisposition, 'undo');
  f.undo(f.independent);
  assert.equal(f.shot(f.a.id).prompt, 'A before'); assert.equal(f.shot(f.b.id).prompt, 'B before');
});

test('restoration followed by ABA does not weaken the existing whole-run blocked rule', async t => {
  const f = await restoredIndependentTargets(t);
  await f.services.call('shot.update', {shotId: f.a.id, expectedRevision: f.shot(f.a.id).revision, requestId: randomUUID(), patch: {prompt: 'A by Mio'}});
  const before = f.state();
  assert.throws(() => f.undo(f.restored), {code: 'AGENT_TASK_TARGET_CHANGED'}); assert.deepEqual(f.state(), before);
  const projected = projectAgentTaskUndo(f.store, f.projectId, f.journal.snapshot(f.run.id).changes);
  assert.equal(projected.get(f.restored.id)?.undoDisposition, 'blocked');
  await assert.rejects(f.runtime.action(f.projectId, f.run.id, {requestId: randomUUID(), expectedRevision: f.journal.run(f.run.id).revision, action: 'undo_all'}), {code: 'AGENT_TASK_TARGET_CHANGED'});
  assert.deepEqual(f.store.tx(() => captureProjectDocumentInside(f.store)), before.content);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM main.mio_changes ORDER BY rowid').all(), before.changes);
});

test('compound shot ordering restored by a version remains blocked for stale Mio compensation', async t => {
  const f = await fixture(t), a = await f.services.call('shot.create', {projectId: f.projectId, title: 'First', duration: 2}) as Shot,
    b = await f.services.call('shot.create', {projectId: f.projectId, title: 'Second', duration: 2}) as Shot;
  const saved = f.versions.save({projectId: f.projectId, requestId: randomUUID()});
  const project = f.store.get('projects', f.projectId) as {revision: number};
  const [change] = await f.execute('shot.reorder', {expectedRevision: project.revision, shotIds: [b.id, a.id]});
  assert.ok(change.targets.length > 1);
  f.journal.transition(f.run.id, f.journal.run(f.run.id).revision, 'completed');
  f.restore(saved.version.id);
  const before = f.state();
  assert.throws(() => f.undo(change), {code: 'AGENT_TASK_TARGET_CHANGED'}); assert.deepEqual(f.state(), before);
  assert.equal(projectAgentTaskUndo(f.store, f.projectId, f.journal.snapshot(f.run.id).changes).get(change.id)?.undoDisposition, 'blocked');
  assert.ok(f.shot(a.id).orderIndex < f.shot(b.id).orderIndex);
});
