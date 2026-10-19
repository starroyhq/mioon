import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {PROPOSAL_FUNCTION, PROPOSED_TITLE, PROPOSED_PROMPT} from './helpers/agent-edit-wire-model.ts';
import {editWireFixture, editRoute, chatRoute, database, savedProposal, savedShot, tableSnapshot, until, REPO, EDIT_WIRE_TOKEN, DOMAIN_TABLES} from './helpers/agent-edit-wire-fixture.ts';

const unchangedTables = DOMAIN_TABLES.filter(table => table !== 'shots');
const bodyItems = capture => capture.protocol === 'responses' ? capture.body.input : capture.body.messages;
const mutationRows = root => database(root, db => db.prepare("SELECT * FROM mutation_requests WHERE operation='shot.update' ORDER BY requestId").all());
function assertWire(f, shot) {
  const [first, second] = f.model.captures;
  assert.equal(f.model.errors.length, 0, f.model.errors.join('\n'));
  assert.equal(f.model.captures.length, 2);
  for (const capture of [first, second]) {
    assert.equal(capture.method, 'POST'); assert.equal(capture.headers.authorization, undefined);
    assert.equal(capture.path, f.protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
    assert.equal(capture.body.stream, true);
    for (const absent of ['previous_response_id', 'conversation', 'background']) assert.equal(capture.body[absent], undefined);
    assert.equal(JSON.stringify(capture.body).includes('UNSELECTED_PROJECT_NAME_MUST_NOT_REACH_MODEL'), false);
  }
  const selected = JSON.parse(bodyItems(first).findLast(item => item.role === 'user').content);
  assert.deepEqual(selected, {kind: 'untrusted_selected_shot', saved: {title: shot.title, prompt: shot.prompt}, userRequest: 'Improve this selected saved shot'});
  assert.equal(first.body.tools.length, 1);
  const definition = f.protocol === 'responses' ? first.body.tools[0] : first.body.tools[0].function;
  assert.equal(definition.name, PROPOSAL_FUNCTION); assert.equal(definition.strict, undefined, 'Ollama omits unsupported strict wire control; local validation remains closed');
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['prompt', 'title']);
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual([...definition.parameters.required].sort(), ['prompt', 'title']);
  assert.deepEqual(second.body.tools, []); assert.equal(second.body.tool_choice, undefined, 'Ollama omits unsupported tool_choice; the answer parser rejects another call');
  const items = bodyItems(second), output = f.protocol === 'responses' ? items.find(item => item.type === 'function_call_output') : items.find(item => item.role === 'tool');
  const call = f.protocol === 'responses' ? items.find(item => item.type === 'function_call') : items.find(item => item.role === 'assistant' && item.tool_calls)?.tool_calls[0];
  assert.equal(f.protocol === 'responses' ? output.call_id : output.tool_call_id, first.callId);
  assert.equal(f.protocol === 'responses' ? call.call_id : call.id, first.callId);
  assert.equal(f.protocol === 'responses' ? call.name : call.function.name, PROPOSAL_FUNCTION);
  assert.deepEqual(JSON.parse(f.protocol === 'responses' ? call.arguments : call.function.arguments), {title: PROPOSED_TITLE, prompt: PROPOSED_PROMPT});
  const result = JSON.parse(f.protocol === 'responses' ? output.output : output.content);
  assert.deepEqual(Object.keys(result).sort(), ['applied','digest','kind','operation','proposalId','status']);
  assert.equal(result.kind, 'untrusted_shot_update_proposal'); assert.equal(result.operation, 'shot.update');
  assert.equal(result.status, 'pending_review'); assert.equal(result.applied, false);
  return result;
}
async function assertNoDomainWork(f, before, modelCalls, acquisitions) {
  assert.deepEqual(tableSnapshot(f.root), before);
  assert.equal(f.model.captures.length, modelCalls);
  if (acquisitions !== undefined) assert.equal((await f.process.observe()).acquisitions, acquisitions);
}

for (const protocol of ['chat_completions', 'responses']) {
  test(`${protocol}: real HTTP/SSE proposal is durable and exact; approval applies only the selected title/prompt once`, {timeout: 30000}, async t => {
    const f = await editWireFixture(t, protocol), {project, shot} = await f.setup();
    await f.rpc('shot.create', {projectId: project.id, title: 'UNSELECTED_SHOT_SECRET', prompt: 'Never disclosed'});
    const before = tableSnapshot(f.root), untouched = tableSnapshot(f.root, unchangedTables);
    const {input, sent, done, proposal} = await f.propose(project.id, shot);
    assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error)); assert.ok(proposal);
    assert.equal(proposal.status, 'pending'); assert.equal(proposal.runStatus, 'completed');
    assert.deepEqual(proposal.target, {projectId: project.id, shotId: shot.id, expectedRevision: shot.revision});
    assert.deepEqual(proposal.diff, {before: {title: shot.title, prompt: shot.prompt}, after: {title: PROPOSED_TITLE, prompt: PROPOSED_PROMPT}});
    const result = assertWire(f, shot); assert.equal(result.proposalId, proposal.id); assert.equal(result.digest, proposal.digest);
    assert.equal(JSON.stringify(f.model.captures).includes('UNSELECTED_SHOT_SECRET'), false);
    assert.deepEqual(tableSnapshot(f.root), before, 'proposal cannot mutate any business row');
    assert.equal(mutationRows(f.root).length, 0);
    const record = savedProposal(f.root, proposal.id), definition = JSON.parse(record.definition);
    assert.deepEqual(definition.input, {shotId: shot.id, expectedRevision: shot.revision, patch: {title: PROPOSED_TITLE, prompt: PROPOSED_PROMPT}, requestId: definition.input.requestId});
    assert.equal(record.approval, null); assert.equal(record.outcome, null);
    assert.equal(database(f.root, db => db.prepare('SELECT count(*) AS n FROM agent_chat_steps WHERE runId=?').get(sent.run.id).n), 3);
    const replay = await f.send(project.id, input); assert.equal(replay.replayed, true); assert.equal(replay.run.id, sent.run.id);
    const sse = await fetch(`${f.process.url}${chatRoute(project.id)}/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=0`, {headers: {authorization: `Bearer ${EDIT_WIRE_TOKEN}`}});
    assert.match(sse.headers.get('content-type'), /^text\/event-stream/u); assert.match(await sse.text(), /event: terminal/u);
    const acquisitions = (await f.process.observe()).acquisitions;
    const approved = await f.action(project.id, proposal, 'approve');
    assert.equal(approved.proposal.status, 'applied'); assert.equal(approved.proposal.outcome.revision, shot.revision + 1);
    const current = savedShot(f.root, shot.id);
    assert.equal(current.title, PROPOSED_TITLE); assert.equal(current.prompt, PROPOSED_PROMPT); assert.equal(current.revision, shot.revision + 1);
    for (const key of ['projectId','referenceAssetIds','aspectRatio','duration','parameters','position','orderIndex','selectedVersionId']) assert.deepEqual(current[key], shot[key]);
    assert.deepEqual(tableSnapshot(f.root, unchangedTables), untouched);
    const mutations = mutationRows(f.root); assert.equal(mutations.length, 1); assert.equal(mutations[0].requestId, definition.input.requestId);
    const phases = (await f.process.observe()).phases.filter(label => label !== 'beforeApproval');
    for (let i = 0; i < 3; i++) assert.deepEqual((await f.action(project.id, proposal, 'approve')).proposal, approved.proposal);
    assert.deepEqual((await f.process.observe()).phases.filter(label => label !== 'beforeApproval'), phases, 'duplicate approval cannot enter dispatch again');
    assert.deepEqual(mutationRows(f.root), mutations); assert.equal(f.model.captures.length, 2); assert.equal((await f.process.observe()).acquisitions, acquisitions);
  });

  test(`${protocol}: pending and lost approval acknowledgement survive process restart; read-only rediscovery never dispatches`, {timeout: 30000}, async t => {
    const f = await editWireFixture(t, protocol), {project, shot} = await f.setup(), {proposal, sent} = await f.propose(project.id, shot);
    const before = tableSnapshot(f.root), record = savedProposal(f.root, proposal.id);
    await f.restart();
    const rediscovered = await f.proposals(project.id); assert.notEqual(rediscovered.instanceId, sent.instanceId);
    assert.deepEqual(rediscovered.proposals, [proposal]); assert.deepEqual(savedProposal(f.root, proposal.id), record);
    await assertNoDomainWork(f, before, 2, 0); assert.deepEqual((await f.process.observe()).phases, []);
    const stale = await f.request(editRoute(project.id, proposal.id, 'approve'), {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}});
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'AGENT_CHAT_SESSION_EXPIRED');
    assert.equal(await f.lostAcknowledgement(editRoute(project.id, proposal.id, 'approve'), {instanceId: rediscovered.instanceId, digest: proposal.digest}), 200);
    const applied = (await f.proposal(project.id, proposal.id)).proposal; assert.equal(applied.status, 'applied');
    const after = tableSnapshot(f.root), mutations = mutationRows(f.root);
    await f.restart();
    assert.equal((await f.proposals(project.id)).proposals.length, 0);
    assert.deepEqual((await f.proposal(project.id, proposal.id)).proposal, applied);
    assert.deepEqual((await f.action(project.id, proposal, 'approve')).proposal, applied);
    assert.deepEqual((await f.action(project.id, proposal, 'recover')).proposal, applied);
    await assertNoDomainWork(f, after, 2, 0); assert.deepEqual(mutationRows(f.root), mutations); assert.deepEqual((await f.process.observe()).phases.filter(label => label !== 'beforeApproval'), []);
  });

  for (const phase of ['request', 'answer']) test(`${protocol}: Stop during ${phase} aborts the actual socket and leaves no approvable edit`, {timeout: 30000}, async t => {
    const f = await editWireFixture(t, protocol), {project, shot} = await f.setup(), before = tableSnapshot(f.root);
    f.model.plan({hold: phase}); const input = await f.input(project.id, shot), sent = await f.send(project.id, input);
    await until(() => f.model.held().some(key => key.startsWith(`${phase}:`)), `held ${phase}`);
    if (phase === 'answer') {
      const pending = (await f.proposals(project.id)).proposals[0]; assert.ok(pending);
      const premature = await f.request(editRoute(project.id, pending.id, 'approve'), {method: 'POST', input: {instanceId: sent.instanceId, digest: pending.digest}});
      assert.equal(premature.status, 409);
    }
    const stopped = await f.data(`${chatRoute(project.id)}/runs/${sent.run.id}/stop`, {method: 'POST', input: {instanceId: sent.instanceId}});
    assert.equal(stopped.run.status, 'stopped');
    await until(() => f.model.captures.at(-1).closed, 'Stop closes provider socket');
    f.model.release(phase);
    const all = await f.proposals(project.id, '?view=all');
    for (const proposal of all.proposals) {
      assert.equal(proposal.status, 'cancelled');
      const refused = await f.request(editRoute(project.id, proposal.id, 'approve'), {method: 'POST', input: {instanceId: all.instanceId, digest: proposal.digest}});
      assert.ok(refused.status === 409 || refused.body.data?.proposal?.status === 'cancelled');
    }
    await f.restart(); assert.equal((await f.lookup(project.id, input.requestId)).run.status, 'stopped');
    await assertNoDomainWork(f, before, phase === 'request' ? 1 : 2, 0); assert.equal(mutationRows(f.root).length, 0);
  });

  test(`${protocol}: failed second answer, second tool attempt and interrupted run cannot approve captured proposals`, {timeout: 45000}, async t => {
    const f = await editWireFixture(t, protocol), {project, shot} = await f.setup(), before = tableSnapshot(f.root);
    for (const plan of [{error: 'answer'}, {secondTool: true}, {truncate: 'answer'}]) {
      const {done, proposal} = await f.propose(project.id, shot, plan);
      assert.equal(done.run.status, 'failed'); assert.ok(proposal); assert.equal(proposal.status, 'cancelled');
      const snapshot = await f.proposal(project.id, proposal.id);
      const refused = await f.request(editRoute(project.id, proposal.id, 'approve'), {method: 'POST', input: {instanceId: snapshot.instanceId, digest: proposal.digest}});
      assert.ok(refused.status === 409 || refused.body.data?.proposal?.status === 'cancelled');
    }
    f.model.plan({hold: 'answer'}); const input = await f.input(project.id, shot); await f.send(project.id, input);
    await until(() => f.model.held().some(key => key.startsWith('answer:')), 'held second answer');
    const pending = (await f.proposals(project.id)).proposals[0]; assert.ok(pending);
    await f.restart({crash: true});
    const cancelled = (await f.proposal(project.id, pending.id)).proposal;
    assert.equal(cancelled.runStatus, 'interrupted'); assert.equal(cancelled.status, 'cancelled');
    const refused = await f.request(editRoute(project.id, pending.id, 'approve'), {method: 'POST', input: {instanceId: (await f.proposals(project.id)).instanceId, digest: pending.digest}});
    assert.ok(refused.status === 409 || refused.body.data?.proposal?.status === 'cancelled');
    await assertNoDomainWork(f, before, 8, 0);
  });

  test(`${protocol}: malformed, duplicate, unauthorized and target-bearing function arguments fail before any proposal or mutation`, {timeout: 45000}, async t => {
    const f = await editWireFixture(t, protocol), {project, shot} = await f.setup(), before = tableSnapshot(f.root);
    const plans = [{name: 'shot.update'}, {name: 'generation.submit'}, {arguments: {title: 'Unsafe', prompt: null, shotId: randomUUID()}},
      {rawArguments: '{"title":"first","title":"second","prompt":null}'}, {arguments: {title: null, prompt: null}}, {arguments: {title: '', prompt: null}}, {rawArguments: '{'}, {truncate: 'request'}];
    for (const plan of plans) {
      const {done, proposal} = await f.propose(project.id, shot, plan);
      assert.equal(done.run.status, 'failed'); assert.equal(proposal, undefined);
    }
    assert.equal((await f.proposals(project.id, '?view=all')).proposals.length, 0);
    await assertNoDomainWork(f, before, plans.length);
  });

  test(`${protocol}: null leaves title untouched, empty prompt clears it, and stale revisions fail without rebasing`, {timeout: 30000}, async t => {
    const f = await editWireFixture(t, protocol), {project, shot} = await f.setup();
    const first = await f.propose(project.id, shot, {arguments: {title: null, prompt: ''}});
    assert.equal(first.done.run.status, 'completed'); assert.deepEqual(first.proposal.patch, {prompt: ''});
    await f.action(project.id, first.proposal, 'approve');
    const cleared = savedShot(f.root, shot.id); assert.equal(cleared.title, shot.title); assert.equal(cleared.prompt, '');
    const next = await f.propose(project.id, cleared);
    await f.rpc('shot.update', {shotId: shot.id, expectedRevision: cleared.revision, requestId: randomUUID(), patch: {title: 'Concurrent manual title'}});
    const manual = savedShot(f.root, shot.id), result = await f.action(project.id, next.proposal, 'approve');
    assert.equal(result.proposal.status, 'failed'); assert.deepEqual(result.proposal.outcome, {status: 'not_applied', code: 'REVISION_CONFLICT'});
    assert.deepEqual(savedShot(f.root, shot.id), manual);
    assert.deepEqual((await f.action(project.id, next.proposal, 'approve')).proposal, result.proposal);
    assert.deepEqual((await f.action(project.id, next.proposal, 'recover')).proposal, result.proposal);
    assert.equal(mutationRows(f.root).length, 2); assert.equal(f.model.captures.length, 4);
  });
}

test('edit endpoints enforce auth/origin/methods/closed bounded schemas, project ownership, epoch and immutable digest', {timeout: 30000}, async t => {
  const f = await editWireFixture(t, 'chat_completions'), {project, shot} = await f.setup(), other = await f.setup();
  const {proposal, sent} = await f.propose(project.id, shot), before = tableSnapshot(f.root), acquisitions = (await f.process.observe()).acquisitions;
  const actionInput = {instanceId: sent.instanceId, digest: proposal.digest};
  for (const action of [undefined, 'approve', 'reject', 'recover']) {
    const route = editRoute(project.id, proposal.id, action), options = action ? {method: 'POST', input: actionInput} : {};
    assert.equal((await f.request(route, {...options, authenticated: false})).status, 401);
    for (const origin of ['https://evil.example', 'null']) assert.equal((await f.request(route, {...options, headers: {origin}})).status, 403);
    assert.equal((await f.request(route, {method: action ? 'GET' : 'POST', ...(action ? {} : {input: {}})})).status, 405);
    assert.equal((await f.request(editRoute(other.project.id, proposal.id, action), options)).status, 404);
    assert.equal((await f.request(route + '?extra=1', options)).status, 400);
  }
  assert.equal((await f.request(editRoute(project.id), {authenticated: false})).status, 401);
  assert.equal((await f.request(editRoute(project.id), {method: 'POST', input: {}})).status, 405);
  for (const query of ['limit=0','limit=51','limit=1&limit=2','view=other','cursor=','cursor=bad','x=1']) assert.equal((await f.request(editRoute(project.id) + '?' + query)).status, 400);
  for (const action of ['approve','reject','recover']) {
    const route = editRoute(project.id, proposal.id, action);
    for (const input of [{...actionInput, extra: true}, {...actionInput, digest: 'f'.repeat(64)}, {...actionInput, projectId: other.project.id}, {...actionInput, shotId: other.shot.id}, {...actionInput, instanceId: randomUUID()}]) {
      const rejected = await f.request(route, {method: 'POST', input}); assert.ok([400, 409].includes(rejected.status), JSON.stringify(rejected.body));
    }
    assert.equal((await f.request(route, {method: 'POST', raw: '{'})).status, 400);
    assert.equal((await f.request(route, {method: 'POST', input: actionInput, headers: {'content-type': 'text/plain'}})).status, 400);
    assert.equal((await f.request(route, {method: 'POST', raw: JSON.stringify(actionInput) + ' '.repeat(1024)})).status, 413);
  }
  for (const operation of ['agent.edit.approve','agent.edit.reject','agent.edit.recover','mioon_propose_shot_update','agent.chat.editApprove']) {
    const rejected = await f.request('/api/rpc', {method: 'POST', input: {operation, input: actionInput}}); assert.equal(rejected.body.error.code, 'UNKNOWN_OPERATION');
  }
  const foreignInput = await f.input(project.id, other.shot);
  assert.equal((await f.request(`${chatRoute(project.id)}/runs`, {method: 'POST', input: foreignInput})).status, 404);
  const staleInput = await f.input(project.id, {...shot, revision: shot.revision + 1});
  assert.equal((await f.request(`${chatRoute(project.id)}/runs`, {method: 'POST', input: staleInput})).status, 409);
  await assertNoDomainWork(f, before, 2, acquisitions); assert.equal(mutationRows(f.root).length, 0);
});

test('two authenticated windows racing approve/reject produce one durable decision and at most one exact mutation', {timeout: 30000}, async t => {
  const f = await editWireFixture(t, 'responses'), {project, shot} = await f.setup();
  for (const order of [['approve','reject'], ['reject','approve']]) {
    const current = savedShot(f.root, shot.id), {proposal, sent} = await f.propose(project.id, current, {arguments: {title: `Race winner ${order.join('-')}`, prompt: null}});
    const beforeCount = mutationRows(f.root).length;
    const decisions = await Promise.all(order.map(action => f.request(editRoute(project.id, proposal.id, action), {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}})));
    assert.ok(decisions.every(result => result.status === 200 || result.status === 409));
    const settled = (await f.proposal(project.id, proposal.id)).proposal;
    assert.ok(['applied','rejected'].includes(settled.status));
    const after = savedShot(f.root, shot.id);
    if (settled.status === 'applied') { assert.equal(after.revision, current.revision + 1); assert.equal(mutationRows(f.root).length, beforeCount + 1); }
    else { assert.deepEqual(after, current); assert.equal(mutationRows(f.root).length, beforeCount); }
    const fixed = savedProposal(f.root, proposal.id), domain = tableSnapshot(f.root);
    await f.action(project.id, proposal, 'approve'); await f.action(project.id, proposal, 'reject');
    assert.deepEqual(savedProposal(f.root, proposal.id), fixed); assert.deepEqual(tableSnapshot(f.root), domain);
  }
});

test('bounded unresolved listing rediscovers old pending edits before pagination and rejects cross-project/view cursors', {timeout: 45000}, async t => {
  const f = await editWireFixture(t, 'chat_completions'), {project, shot} = await f.setup(), other = await f.setup();
  const oldest = (await f.propose(project.id, shot)).proposal;
  for (let i = 0; i < 5; i++) {
    const {proposal} = await f.propose(project.id, shot, {arguments: {title: `Rejected synthetic ${i}`, prompt: null}});
    assert.equal((await f.action(project.id, proposal, 'reject')).proposal.status, 'rejected');
  }
  const newest = (await f.propose(project.id, shot, {arguments: {title: 'Newest pending proposal', prompt: null}})).proposal;
  const before = tableSnapshot(f.root), rows = tableSnapshot(f.root, ['agent_edit_proposals']);
  await f.restart();
  const pending = await f.proposals(project.id, '?limit=1'); assert.deepEqual(pending.proposals.map(value => value.id), [newest.id]); assert.ok(pending.nextCursor);
  const next = await f.proposals(project.id, '?limit=1&cursor=' + encodeURIComponent(pending.nextCursor));
  assert.deepEqual(next.proposals.map(value => value.id), [oldest.id]); assert.equal(next.nextCursor, null);
  assert.equal((await f.request(editRoute(other.project.id) + '?cursor=' + encodeURIComponent(pending.nextCursor))).status, 400);
  assert.equal((await f.request(editRoute(project.id) + '?view=all&cursor=' + encodeURIComponent(pending.nextCursor))).status, 400);
  const all = await f.proposals(project.id, '?view=all&limit=50'); assert.equal(all.proposals.length, 7);
  await assertNoDomainWork(f, before, 14, 0); assert.deepEqual(tableSnapshot(f.root, ['agent_edit_proposals']), rows);
});

for (const corruption of ['shot-json-id', 'shot-json-project', 'foreign-reference', 'foreign-selected-version', 'proposal-relational-shot']) {
  test(`saved ${corruption} corruption fails closed without following an indirect foreign target`, {timeout: 30000}, async t => {
    const f = await editWireFixture(t, 'chat_completions'), {project, shot} = await f.setup(), other = await f.setup();
    const {proposal, sent} = await f.propose(project.id, shot);
    database(f.root, db => {
      const own = JSON.parse(db.prepare('SELECT data FROM shots WHERE id=?').get(shot.id).data);
      if (corruption === 'shot-json-id') own.id = other.shot.id;
      else if (corruption === 'shot-json-project') own.projectId = other.project.id;
      else if (corruption === 'foreign-reference') {
        const id = randomUUID(); db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(id, other.project.id, JSON.stringify({id, projectId: other.project.id, name: 'FOREIGN_ASSET_SECRET'})); own.referenceAssetIds = [id];
      } else if (corruption === 'foreign-selected-version') {
        const id = randomUUID(), jobId = randomUUID(), assetId = randomUUID();
        db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(jobId, other.project.id, JSON.stringify({id: jobId, projectId: other.project.id, shotId: other.shot.id}));
        db.prepare('INSERT INTO versions(id,projectId,jobId,data) VALUES(?,?,?,?)').run(id, other.project.id, jobId, JSON.stringify({id, projectId: other.project.id, jobId, assetId, shotId: other.shot.id, private: 'FOREIGN_VERSION_SECRET'})); own.selectedVersionId = id;
      } else {
        // Simulate on-disk corruption, including an out-of-band writer that has
        // defeated SQLite's normal immutable-definition trigger. Never a route.
        for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='agent_edit_proposals'").all()) db.exec(`DROP TRIGGER "${row.name}"`);
        db.prepare('UPDATE agent_edit_proposals SET shotId=? WHERE id=?').run(other.shot.id, proposal.id); return;
      }
      db.prepare('UPDATE shots SET data=? WHERE id=?').run(JSON.stringify(own), shot.id);
    }, {writable: true});
    const before = tableSnapshot(f.root);
    for (const action of [undefined, 'approve', 'recover', 'reject']) {
      const result = await f.request(editRoute(project.id, proposal.id, action), action ? {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}} : {});
      assert.ok([404, 503].includes(result.status), JSON.stringify(result.body));
      assert.equal(JSON.stringify(result.body).includes('FOREIGN_'), false);
    }
    await assertNoDomainWork(f, before, 2); assert.equal(mutationRows(f.root).length, 0);
  });
}

for (const protocol of ['chat_completions','responses']) for (const boundary of ['beforeApproval','afterApproval','beforeDispatch','afterDispatchStarted','afterDispatch','afterOutcome','beforeAcknowledgement']) {
  test(`${protocol}: owned SIGKILL at ${boundary} retains immutable review intent and only explicit recovery can dispatch`, {timeout: 35000}, async t => {
    const f = await editWireFixture(t, protocol), {project, shot} = await f.setup(), {proposal, sent} = await f.propose(project.id, shot);
    const initial = savedProposal(f.root, proposal.id), definition = JSON.parse(initial.definition), unaffected = tableSnapshot(f.root, unchangedTables);
    await f.process.arm(boundary);
    const attempt = f.request(editRoute(project.id, proposal.id, 'approve'), {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}}).then(value => ({response: value}), error => ({error}));
    const terminated = await Promise.race([f.process.exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error(`Crash boundary not reached: ${boundary}`)), 12000); timer.unref(); })]);
    assert.equal(terminated.signal, 'SIGKILL', f.process.output); assert.ok((await attempt).error);
    assert.equal((await f.trace()).at(-1).label, boundary); assert.equal((await f.trace()).at(-1).crash, true);
    const crashed = savedProposal(f.root, proposal.id), committed = ['afterDispatch','afterOutcome','beforeAcknowledgement'].includes(boundary);
    assert.equal(savedShot(f.root, shot.id).revision, shot.revision + Number(committed));
    assert.equal(mutationRows(f.root).length, Number(committed));
    assert.equal(crashed.definition, initial.definition); assert.equal(crashed.digest, initial.digest);
    if (boundary === 'beforeApproval') assert.equal(crashed.approval, null);
    else assert.deepEqual(JSON.parse(crashed.approval).input, definition.input);
    await f.restart();
    const fresh = await f.proposal(project.id, proposal.id), resumed = fresh.proposal;
    assert.equal(resumed.status, boundary === 'beforeApproval' ? 'pending' : committed ? 'applied' : 'unknown');
    assert.equal(f.model.captures.length, 2); assert.equal((await f.process.observe()).acquisitions, 0); assert.deepEqual((await f.process.observe()).phases, []);
    const saved = savedProposal(f.root, proposal.id), domain = tableSnapshot(f.root);
    await f.proposals(project.id); await f.proposals(project.id, '?view=all'); await f.proposal(project.id, proposal.id);
    assert.deepEqual(savedProposal(f.root, proposal.id), saved); assert.deepEqual(tableSnapshot(f.root), domain);
    if (boundary === 'beforeApproval') {
      const recovery = await f.request(editRoute(project.id, proposal.id, 'recover'), {method: 'POST', input: {instanceId: fresh.instanceId, digest: proposal.digest}});
      assert.equal(recovery.status, 409, 'an unapproved proposal cannot recover into a mutation');
      assert.equal((await f.action(project.id, proposal, 'approve')).proposal.status, 'applied');
    } else {
      // Duplicate approvals are lookup-only even for an unknown outcome.
      assert.deepEqual((await f.action(project.id, proposal, 'approve')).proposal, resumed);
      assert.deepEqual(tableSnapshot(f.root), domain);
      assert.equal((await f.process.observe()).phases.filter(label => label === 'afterDispatch').length, 0);
      assert.equal((await f.action(project.id, proposal, 'recover')).proposal.status, 'applied');
    }
    assert.equal(savedShot(f.root, shot.id).revision, shot.revision + 1); assert.equal(mutationRows(f.root).length, 1);
    assert.equal(mutationRows(f.root)[0].requestId, definition.input.requestId);
    const final = savedProposal(f.root, proposal.id); assert.equal(final.definition, initial.definition); assert.equal(final.digest, initial.digest);
    if (crashed.approval !== null) assert.equal(final.approval, crashed.approval, 'recovery never grants another approval');
    assert.deepEqual(tableSnapshot(f.root, unchangedTables), unaffected); assert.equal(f.model.captures.length, 2); assert.equal((await f.process.observe()).acquisitions, 0);
    const afterRecovery = tableSnapshot(f.root);
    await f.action(project.id, proposal, 'recover'); await f.action(project.id, proposal, 'approve');
    assert.deepEqual(tableSnapshot(f.root), afterRecovery); assert.equal(mutationRows(f.root).length, 1);
  });
}

test('MCP discovery and calls expose no proposal/approval/recovery authority', {timeout: 30000}, async t => {
  const f = await editWireFixture(t, 'responses'), {project, shot} = await f.setup(), {proposal} = await f.propose(project.id, shot), before = tableSnapshot(f.root);
  const client = new Client({name: 'synthetic-edit-boundary-audit', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(REPO, 'apps/mcp/src/index.ts')], cwd: REPO,
    env: {...f.testRuntimeEnvironment, PATH: process.env.PATH || '', HOME: f.root, MIOON_BASE_URL: f.process.url, MIOON_TOKEN: EDIT_WIRE_TOKEN}, stderr: 'pipe'});
  f.deferCleanup(() => client.close()); await client.connect(transport);
  const listing = await client.listTools(); assert.equal(listing.tools.some(tool => /agent.*edit|propose_shot|edit.*approve|edit.*recover/u.test(tool.name)), false);
  for (const name of ['mioon_propose_shot_update','agent_edit_approve','agent_edit_recover','agent_chat_editApprove']) {
    const result = await client.callTool({name, arguments: {proposalId: proposal.id, digest: proposal.digest}});
    assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).error.code, 'UNKNOWN_OPERATION');
  }
  await assertNoDomainWork(f, before, 2);
});
