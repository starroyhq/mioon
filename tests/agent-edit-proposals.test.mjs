import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices, canonical} from '../packages/business/src/services.mjs';
import {createAgentEditService, AGENT_EDIT_LIMITS} from '../packages/business/src/agent/edit-proposals.mjs';
import {editToolPolicy} from '../packages/business/src/agent/edit-tool-policy.mjs';

const timestamp = () => new Date().toISOString();
const code = expected => caught => caught.code === expected && !JSON.stringify(caught).includes('PRIVATE');
async function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-agent-edits-'));
  let store = openStore(root), services = createServices(store, new Map()), edits, calls = 0;
  let fault = options.fault || (() => {}), dispatch = options.dispatch;
  const start = () => { edits = createAgentEditService({store, services: {updateShotInProject(projectId, input) {
    const operation = 'shot.update';
    calls++; assert.equal(projectId, input.projectId ?? store.get('shots', input.shotId).projectId); assert.equal(store.db.isTransaction, false);
    const scoped = {call(op, values) { assert.equal(op, 'shot.update'); return services.updateShotInProject(projectId, values); }};
    return dispatch ? dispatch(operation, input, scoped) : scoped.call(operation, input);
  }}, fault: label => fault(label), limits: options.limits}); };
  start();
  const project = await services.call('project.create', {name: 'Reviewed local edits'});
  const other = await services.call('project.create', {name: 'PRIVATE_OTHER_PROJECT'});
  const shot = await services.call('shot.create', {projectId: project.id, title: 'Saved title', prompt: 'Saved prompt'});
  store.put('shots', {...shot, relativePath: 'PRIVATE_PATH', apiKey: 'PRIVATE_KEY', snapshot: {body: 'PRIVATE_SNAPSHOT'}});
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const f = {root, project, other, shot, get store() { return store; }, get edits() { return edits; }, get calls() { return calls; },
    get services() { return services; }, setFault(fn) { fault = fn; }, setDispatch(fn) { dispatch = fn; },
    restart() { store.close(); store = openStore(root); services = createServices(store, new Map()); start(); },
    second() { return createAgentEditService({store, services: {updateShotInProject(projectId, input) { calls++; return services.updateShotInProject(projectId, input); }}}); },
    request(proposal) { return {projectId: proposal.projectId, proposalId: proposal.id, digest: proposal.digest}; },
    row(proposal) { return store.db.prepare('SELECT * FROM agent_edit_proposals WHERE id=?').get(proposal.id); },
    receipts() { return store.db.prepare('SELECT * FROM mutation_requests').all(); },
    prepare(changes = {title: 'Proposed title', prompt: null}, fields = {}) {
      const target = edits.pinTarget(project.id, {shotId: shot.id, expectedRevision: store.get('shots', shot.id).revision});
      const runId = randomUUID(), requestId = randomUUID(), threadId = randomUUID(), toolId = randomUUID();
      // Independent synthetic fixture supplies the exact accepted execution
      // evidence; end-to-end protocol/HTTP tests exercise its real producer.
      const existing = store.db.prepare('SELECT id FROM agent_chat_threads WHERE projectId=?').get(project.id);
      const tid = existing?.id || threadId;
      if (!existing) store.db.prepare('INSERT INTO agent_chat_threads VALUES(?,?,0,1)').run(tid, project.id);
      const position = store.db.prepare('SELECT count(*) n FROM agent_chat_runs WHERE projectId=?').get(project.id).n + 1;
      const run = {id: runId, projectId: project.id, requestId, threadId: tid, status: 'running',
        contextMode: 'selected_shot_edit', editTarget: target, modelRequestState: 'dispatch_started', activity: [], ...fields};
      const acceptance = {version: 1, execution: {version: 1, target, policy: editToolPolicy(project.id)}};
      store.db.prepare('INSERT INTO agent_chat_requests VALUES(?,?,?,?,?,?,?)').run(requestId, project.id, tid, runId, 'fixture', JSON.stringify(acceptance), 100);
      store.db.prepare('INSERT INTO agent_chat_runs VALUES(?,?,?,?,?,?,?,?)').run(runId, project.id, tid, requestId, position, run.status, JSON.stringify(run), 100);
      const toolCall = {id: 'call_' + randomUUID(), name: 'mioon_propose_shot_update', arguments: changes, argumentsJson: JSON.stringify(changes)};
      const tool = {id: toolId, projectId: project.id, runId, position: 2, kind: 'tool', ordinal: 1, status: 'dispatch_started',
        intent: {toolCall, provenance: {category: 'project_selected_shot_text', projectId: project.id, operation: 'shot.update'}}};
      store.db.prepare('INSERT INTO agent_chat_steps VALUES(?,?,?,?,?,?,?,?)').run(toolId, runId, project.id, 2, 'tool', tool.status, JSON.stringify(tool), 100);
      return {run, tool, target, changes, toolCall, projectId: project.id, runId};
    },
    create(prepared) { return store.tx(() => edits.createInside(prepared)); },
    finish(prepared, proposal, status = 'completed') {
      const {run, tool} = prepared;
      if (proposal) {
        const result = {kind: 'untrusted_shot_update_proposal', status: 'pending_review', applied: false,
          proposalId: proposal.id, digest: proposal.digest, operation: 'shot.update'};
        tool.observation = {result, resultJson: JSON.stringify(result), provenance: tool.intent.provenance}; tool.status = 'completed';
        store.db.prepare('UPDATE agent_chat_steps SET status=?,data=? WHERE id=?').run(tool.status, JSON.stringify(tool), tool.id);
        run.activity = [{id: tool.id, kind: 'tool', ordinal: 1, status: 'completed', resultJson: tool.observation.resultJson}];
      }
      if (status === 'completed') {
        const final = {id: randomUUID(), runId: run.id, projectId: run.projectId, kind: 'model', position: 3, ordinal: 2,
          status: 'completed', output: {type: 'done', finishReason: 'stop'}};
        store.db.prepare('INSERT INTO agent_chat_steps VALUES(?,?,?,?,?,?,?,?)').run(final.id, run.id, run.projectId, 3, 'model', 'completed', JSON.stringify(final), 100);
        run.activity.push({id: final.id, kind: 'model', ordinal: 2, status: 'completed'});
      }
      run.status = status; run.modelRequestState = status === 'completed' ? 'completed' : 'unknown';
      store.db.prepare('UPDATE agent_chat_runs SET status=?,data=? WHERE id=?').run(status, JSON.stringify(run), run.id);
    },
    proposal(changes, status = 'completed') { const prepared = f.prepare(changes); const proposal = f.create(prepared); f.finish(prepared, proposal, status); return proposal; },
  };
  return f;
}

const domain = f => JSON.stringify(['projects', 'shots', 'nodes', 'assets', 'jobs', 'versions', 'timelines'].map(table =>
  f.store.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));

test('creation pins exact saved fields; proposals do not mutate; null preserves and empty prompt clears', async t => {
  const f = await fixture(t), before = domain(f), prepared = f.prepare({title: null, prompt: ''}), proposal = f.create(prepared);
  assert.equal(domain(f), before); assert.equal(f.calls, 0); assert.deepEqual(f.receipts(), []);
  assert.deepEqual(proposal.diff, {before: {title: 'Saved title', prompt: 'Saved prompt'}, after: {title: 'Saved title', prompt: ''}});
  assert.deepEqual(proposal.patch, {prompt: ''}); assert.equal(proposal.status, 'pending'); assert.equal(proposal.runStatus, 'running');
  assert.equal(JSON.stringify(proposal).includes('PRIVATE'), false);
  assert.throws(() => f.edits.createInside(prepared), /capture transaction/);
  f.finish(prepared, proposal);
  const applied = await f.edits.approve(f.request(proposal));
  assert.equal(applied.status, 'applied'); assert.equal(applied.runStatus, 'completed'); assert.equal(f.store.get('shots', f.shot.id).prompt, '');
  assert.equal(f.calls, 1); assert.equal(f.store.get('shots', f.shot.id).revision, 2);
});

test('approval is durable before dispatch and exact immutable request is the shared receipt', async t => {
  const f = await fixture(t), proposal = f.proposal(), request = f.request(proposal);
  f.setDispatch((operation, input, services) => {
    const row = f.row(proposal), definition = JSON.parse(row.definition), approval = JSON.parse(row.approval);
    assert.equal(row.status, 'dispatching'); assert.equal(approval.operation, operation);
    assert.deepEqual(approval.input, input); assert.deepEqual(input, definition.input); assert.equal(approval.digest, proposal.digest);
    return services.call(operation, input);
  });
  const outcome = await f.edits.approve(request), writes = f.store.db.prepare('SELECT total_changes() n').get().n;
  for (let n = 0; n < 3; n++) assert.deepEqual(await f.edits.approve(request), outcome);
  assert.deepEqual(await f.edits.recover(request), outcome); assert.equal(f.calls, 1);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, writes);
  const {requestId, ...input} = JSON.parse(f.row(proposal).definition).input, receipt = f.receipts()[0];
  assert.equal(receipt.requestId, requestId); assert.equal(receipt.canonicalInput, canonical(input));
  await f.services.call('shot.update', {shotId: f.shot.id, expectedRevision: 2, patch: {title: 'Later manual edit'}});
  assert.deepEqual((await f.edits.approve(request)).outcome, outcome.outcome); assert.equal(f.store.get('shots', f.shot.id).title, 'Later manual edit');
  assert.equal(JSON.stringify(outcome).includes('PRIVATE'), false);
});

test('approval requires successful terminal proposal-bearing final model result', async t => {
  const f = await fixture(t), prepared = f.prepare(), proposal = f.create(prepared);
  await assert.rejects(f.edits.approve(f.request(proposal)), code('AGENT_EDIT_RUN_INCOMPLETE'));
  assert.equal(f.row(proposal).approval, null); assert.equal(f.calls, 0);
  f.finish(prepared, proposal);
  f.store.db.prepare("UPDATE agent_chat_steps SET status='unknown' WHERE runId=? AND position=3").run(prepared.runId);
  await assert.rejects(f.edits.approve(f.request(proposal)), code('AGENT_EDIT_STORAGE_UNAVAILABLE'));
  assert.equal(f.calls, 0);
});

for (const status of ['failed', 'stopped', 'interrupted']) test(`${status} invalidates unapproved proposal durably and never grants approval`, async t => {
  const f = await fixture(t), proposal = f.proposal(undefined, status);
  await assert.rejects(f.edits.approve(f.request(proposal)), code('AGENT_EDIT_RUN_INCOMPLETE'));
  f.edits.reconcile(); assert.equal(f.edits.get({projectId: f.project.id, proposalId: proposal.id}).status, 'cancelled');
  f.restart(); f.edits.reconcile();
  await assert.rejects(f.edits.approve(f.request(proposal)), code('AGENT_EDIT_RUN_INCOMPLETE')); assert.equal(f.calls, 0);
});

test('Stop cancellation participates in caller transaction and rolls back together', async t => {
  const f = await fixture(t), prepared = f.prepare(), proposal = f.create(prepared);
  assert.throws(() => f.store.tx(() => { assert.equal(f.edits.cancelRun(prepared.runId), true); throw new Error('rollback'); }), /rollback/);
  assert.equal(f.row(proposal).status, 'pending');
  f.store.tx(() => f.edits.cancelRun(prepared.runId));
  assert.equal(f.row(proposal).status, 'cancelled'); assert.equal(f.edits.cancelRun(prepared.runId), false);
});

for (const boundary of ['beforeApproval', 'afterApproval', 'beforeDispatch', 'afterDispatchStarted', 'afterDispatch', 'afterOutcome', 'beforeAcknowledgement'])
  test(`restart at ${boundary} never dispatches automatically; explicit recovery keeps exact key`, async t => {
    const f = await fixture(t), proposal = f.proposal(), request = f.request(proposal);
    const original = JSON.parse(f.row(proposal).definition);
    f.setFault(label => { if (label === boundary) throw new Error('synthetic crash'); });
    await assert.rejects(f.edits.approve(request), /synthetic crash/);
    const committed = ['afterDispatch', 'afterOutcome', 'beforeAcknowledgement'].includes(boundary), calls = f.calls;
    assert.equal(f.store.get('shots', f.shot.id).revision, committed ? 2 : 1);
    f.setFault(() => {}); f.restart(); f.edits.reconcile();
    assert.equal(f.calls, calls); assert.equal(f.store.get('shots', f.shot.id).revision, committed ? 2 : 1);
    const saved = f.edits.get({projectId: f.project.id, proposalId: proposal.id});
    assert.equal(saved.status, boundary === 'beforeApproval' ? 'pending' : committed ? 'applied' : 'unknown');
    assert.deepEqual(JSON.parse(f.row(proposal).definition), original);
    if (boundary === 'beforeApproval') await assert.rejects(f.edits.recover(request), code('AGENT_EDIT_CONFLICT'));
    else {
      if (!committed) { assert.equal((await f.edits.approve(request)).status, 'unknown'); assert.equal(f.calls, calls); }
      assert.equal((await f.edits.recover(request)).status, 'applied');
      assert.equal(f.calls, calls + Number(!committed)); assert.equal(f.store.get('shots', f.shot.id).revision, 2);
      assert.equal(f.receipts()[0].requestId, original.input.requestId);
    }
  });

test('lost dispatch response reconciles receipt and repeated approve/recover never repeats the mutation', async t => {
  const f = await fixture(t), proposal = f.proposal();
  f.setDispatch(async (operation, input, services) => { await services.call(operation, input); throw new Error('PRIVATE_RESPONSE_LOST'); });
  const result = await f.edits.approve(f.request(proposal));
  assert.equal(result.status, 'applied'); assert.equal(f.calls, 1); assert.equal(f.receipts().length, 1);
  assert.equal((await f.edits.recover(f.request(proposal))).status, 'applied'); assert.equal(f.calls, 1);
});

test('unknown dispatch retains explicit uncertainty until recovery, without a new approval or key', async t => {
  const f = await fixture(t), proposal = f.proposal(), request = f.request(proposal);
  f.setDispatch(() => { throw new Error('PRIVATE_UNKNOWN'); });
  const unknown = await f.edits.approve(request); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.outcome, undefined);
  const approval = f.row(proposal).approval;
  f.restart(); f.edits.reconcile(); assert.equal(f.calls, 1);
  assert.equal((await f.edits.approve(request)).status, 'unknown'); assert.equal(f.calls, 1);
  f.setDispatch(null); assert.equal((await f.edits.recover(request)).status, 'applied');
  assert.equal(f.row(proposal).approval, approval); assert.equal(f.calls, 2); assert.equal(f.receipts().length, 1);
});

test('stale revision stays a rejected exact diff; recovery never rebases or changes key', async t => {
  const f = await fixture(t), proposal = f.proposal(), request = f.request(proposal), definition = f.row(proposal).definition;
  await f.services.call('shot.update', {shotId: f.shot.id, expectedRevision: 1, patch: {prompt: 'Manual change'}});
  const result = await f.edits.approve(request);
  assert.equal(result.status, 'failed'); assert.deepEqual(result.outcome, {status: 'not_applied', code: 'REVISION_CONFLICT'});
  assert.equal(f.row(proposal).definition, definition); assert.deepEqual(result.diff, proposal.diff); assert.equal(f.receipts().length, 0);
  f.restart(); f.edits.reconcile(); assert.equal((await f.edits.recover(request)).status, 'failed'); assert.equal(f.calls, 1);
  assert.equal(f.store.get('shots', f.shot.id).prompt, 'Manual change');
});

test('two windows arbitrate reject/approve atomically and repeated in-flight approval never redispatches', async t => {
  const f = await fixture(t), proposal = f.proposal(), request = f.request(proposal), second = f.second();
  let finish;
  f.setDispatch((operation, input, services) => new Promise(resolve => { finish = () => resolve(services.call(operation, input)); }));
  const first = f.edits.approve(request);
  assert.equal(second.reject(request).status, 'dispatching');
  assert.equal((await second.approve(request)).status, 'dispatching');
  assert.equal((await second.recover(request)).status, 'dispatching'); assert.equal(f.calls, 1);
  finish(); assert.equal((await first).status, 'applied'); assert.equal(f.receipts().length, 1);
  const another = f.proposal({title: 'Never applied', prompt: null});
  assert.equal(second.reject(f.request(another)).status, 'rejected');
  assert.equal((await f.edits.approve(f.request(another))).status, 'rejected'); assert.equal(f.calls, 1);
});

for (const changes of [{title: null, prompt: null}, {title: '', prompt: null}, {title: ' ', prompt: null},
  {title: 'Saved title', prompt: null}, {title: null, prompt: 'Saved prompt'}, {title: 'x'.repeat(151), prompt: null},
  {title: null, prompt: 'x'.repeat(5001)}, {title: null, prompt: '\ud800'}, {title: null, prompt: '\0bad'},
  {title: null, prompt: 'valid', duration: 5}]) test(`invalid/no-op proposal is not persisted: ${JSON.stringify(changes).slice(0,70)}`, async t => {
    const f = await fixture(t), prepared = f.prepare(changes), before = domain(f);
    assert.throws(() => f.create(prepared), code('AGENT_EDIT_VALIDATION'));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_edit_proposals').get().n, 0);
    assert.equal(domain(f), before); assert.equal(f.calls, 0);
  });

test('capture rollback leaves no proposal, partial approval, receipt or business edit', async t => {
  const f = await fixture(t), prepared = f.prepare(), before = domain(f);
  assert.throws(() => f.store.tx(() => { f.edits.createInside(prepared); throw new Error('observation persistence failed'); }), /persistence failed/);
  assert.equal(f.edits.list({projectId: f.project.id}).proposals.length, 0); assert.equal(domain(f), before);
  const proposal = f.create(prepared); f.finish(prepared, proposal);
  f.store.db.exec("CREATE TRIGGER fail_edit_approval BEFORE UPDATE OF approval ON agent_edit_proposals BEGIN SELECT RAISE(ABORT,'approval disk failure');END;");
  await assert.rejects(f.edits.approve(f.request(proposal)), /approval disk failure/);
  assert.equal(f.row(proposal).approval, null); assert.equal(f.calls, 0); assert.equal(domain(f), before);
});

test('shared receipt insertion rollback is unknown and explicit recovery uses the original operation', async t => {
  const f = await fixture(t), proposal = f.proposal();
  f.store.db.exec("CREATE TRIGGER fail_shared_receipt BEFORE INSERT ON mutation_requests BEGIN SELECT RAISE(ABORT,'receipt disk failure');END;");
  const result = await f.edits.approve(f.request(proposal)); assert.equal(result.status, 'unknown');
  assert.equal(f.store.get('shots', f.shot.id).revision, 1); assert.equal(f.receipts().length, 0);
  f.store.db.exec('DROP TRIGGER fail_shared_receipt'); f.restart(); f.edits.reconcile();
  assert.equal((await f.edits.recover(f.request(proposal))).status, 'applied'); assert.equal(f.store.get('shots', f.shot.id).revision, 2);
});

test('limits reject new rows without eviction; immutable proposal/approval identities resist overwrite/delete', async t => {
  const f = await fixture(t, {limits: {rows: 1}}), proposal = f.proposal();
  const second = f.prepare({title: 'Second proposal', prompt: null});
  assert.throws(() => f.create(second), code('AGENT_EDIT_STORAGE_LIMIT'));
  assert.equal(f.edits.list({projectId: f.project.id}).proposals[0].id, proposal.id);
  assert.throws(() => f.store.db.prepare('DELETE FROM agent_edit_proposals WHERE id=?').run(proposal.id), /must be retained/);
  assert.throws(() => f.store.db.prepare("UPDATE agent_edit_proposals SET definition='{}' WHERE id=?").run(proposal.id), /immutable/);
  await f.edits.approve(f.request(proposal));
  assert.throws(() => f.store.db.prepare("UPDATE agent_edit_proposals SET approval='{}' WHERE id=?").run(proposal.id), /immutable/);
  assert.ok(f.row(proposal).bytes <= AGENT_EDIT_LIMITS.rowBytes);
});

test('unresolved pagination filters first and binds cursors to project/view', async t => {
  const f = await fixture(t), oldest = f.proposal(), middle = f.proposal({title: 'Middle', prompt: null});
  const newest = f.proposal({title: 'Newest rejected', prompt: null}); f.edits.reject(f.request(newest));
  const first = f.edits.list({projectId: f.project.id, limit: 1});
  assert.equal(first.proposals[0].id, middle.id); assert.ok(first.nextCursor);
  const next = f.edits.list({projectId: f.project.id, limit: 1, cursor: first.nextCursor});
  assert.equal(next.proposals[0].id, oldest.id); assert.equal(next.nextCursor, null);
  assert.throws(() => f.edits.list({projectId: f.other.id, cursor: first.nextCursor}), code('AGENT_EDIT_VALIDATION'));
  assert.throws(() => f.edits.list({projectId: f.project.id, view: 'all', cursor: first.nextCursor}), code('AGENT_EDIT_VALIDATION'));
  assert.equal(f.edits.list({projectId: f.project.id, view: 'all'}).proposals.length, 3);
});

test('changed digest/id/project and missing/foreign target return safe errors without dispatch', async t => {
  const f = await fixture(t), proposal = f.proposal(), request = f.request(proposal);
  await assert.rejects(f.edits.approve({...request, digest: 'a'.repeat(64)}), code('AGENT_EDIT_CONFLICT'));
  await assert.rejects(f.edits.approve({...request, proposalId: randomUUID()}), code('AGENT_EDIT_NOT_FOUND'));
  await assert.rejects(f.edits.approve({...request, projectId: f.other.id}), code('AGENT_EDIT_NOT_FOUND'));
  f.store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(f.other.id, f.shot.id);
  assert.throws(() => f.edits.get({projectId: f.project.id, proposalId: proposal.id}), code('AGENT_EDIT_NOT_FOUND'));
  await assert.rejects(f.edits.approve(request), code('AGENT_EDIT_NOT_FOUND')); assert.equal(f.calls, 0);
});

for (const corruption of ['deleted-target', 'target-json-owner', 'project-json-identity', 'saved-receipt-relation'])
  test(`applied DTO cannot expose saved receipt with ${corruption}`, async t => {
    const f = await fixture(t), proposal = f.proposal(); await f.edits.approve(f.request(proposal));
    if (corruption === 'deleted-target') f.store.db.prepare('DELETE FROM shots WHERE id=?').run(f.shot.id);
    if (corruption === 'target-json-owner') f.store.put('shots', {...f.store.get('shots', f.shot.id), projectId: f.other.id});
    if (corruption === 'project-json-identity') f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({id: f.other.id}), f.project.id);
    if (corruption === 'saved-receipt-relation') {
      const receipt = f.receipts()[0], response = JSON.parse(receipt.response); response.referenceAssetIds = [randomUUID()];
      f.store.db.exec('DROP TRIGGER immutable_mutation_requests');
      f.store.db.prepare('UPDATE mutation_requests SET response=? WHERE requestId=?').run(JSON.stringify(response), receipt.requestId);
    }
    assert.throws(() => f.edits.get({projectId: f.project.id, proposalId: proposal.id}), code(['deleted-target', 'saved-receipt-relation'].includes(corruption) ? 'AGENT_EDIT_NOT_FOUND' : 'AGENT_EDIT_STORAGE_UNAVAILABLE'));
    assert.equal(f.calls, 1);
  });

for (const limits of [{bytes: 100}, {definitionBytes: 100}, {rowBytes: 100}])
  test(`serialized byte budget ${Object.keys(limits)[0]} rejects before persistence`, async t => {
    const f = await fixture(t, {limits}), prepared = f.prepare();
    assert.throws(() => f.create(prepared), code('AGENT_EDIT_STORAGE_LIMIT'));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_edit_proposals').get().n, 0);
    assert.equal(f.calls, 0); assert.equal(f.store.get('shots', f.shot.id).revision, 1);
  });

test('list/get are read-only and completed pending review survives entirely new service instances', async t => {
  const f = await fixture(t), proposal = f.proposal(), definition = f.row(proposal).definition;
  const before = f.store.db.prepare('SELECT total_changes() n').get().n;
  for (let n = 0; n < 3; n++) {
    assert.equal(f.edits.list({projectId: f.project.id}).proposals[0].id, proposal.id);
    assert.equal(f.edits.get({projectId: f.project.id, proposalId: proposal.id}).status, 'pending');
  }
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, before);
  f.restart(); f.edits.reconcile();
  assert.equal(f.edits.list({projectId: f.project.id}).proposals[0].status, 'pending');
  assert.equal(f.row(proposal).definition, definition); assert.equal(f.calls, 0);
});

test('a proposal never rebases when the target changes while the model is preparing its reply', async t => {
  const f = await fixture(t), prepared = f.prepare();
  await f.services.call('shot.update', {shotId: f.shot.id, expectedRevision: 1, patch: {title: 'Concurrent manual title'}});
  const proposal = f.create(prepared); f.finish(prepared, proposal);
  assert.equal(proposal.target.expectedRevision, 1); assert.equal(proposal.diff.before.title, 'Saved title');
  assert.equal((await f.edits.approve(f.request(proposal))).outcome.code, 'REVISION_CONFLICT');
  assert.equal(f.store.get('shots', f.shot.id).title, 'Concurrent manual title');
});

test('saved proposal digest and immutable accepted target detect corrupt intent without exposing text', async t => {
  const f = await fixture(t), proposal = f.proposal(), definition = JSON.parse(f.row(proposal).definition);
  f.store.db.exec('DROP TRIGGER immutable_agent_edit_intent');
  definition.diff.after.title = 'PRIVATE_CORRUPT';
  f.store.db.prepare('UPDATE agent_edit_proposals SET definition=? WHERE id=?').run(JSON.stringify(definition), proposal.id);
  assert.throws(() => f.edits.get({projectId: f.project.id, proposalId: proposal.id}), code('AGENT_EDIT_STORAGE_UNAVAILABLE'));
  await assert.rejects(f.edits.approve(f.request(proposal)), code('AGENT_EDIT_STORAGE_UNAVAILABLE')); assert.equal(f.calls, 0);
});
