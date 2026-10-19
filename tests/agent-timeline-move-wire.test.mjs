import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {AGENT_TIMELINE_MOVE_CONTEXT, agentTimelineMoveReviewTarget} from '@mioon/contracts';
import {canonical} from '../packages/business/src/services.ts';
import {editRoute, chatRoute, database, savedProposal, tableSnapshot, until, REPO, EDIT_WIRE_TOKEN, DOMAIN_TABLES} from './helpers/agent-edit-wire-fixture.mjs';
import {timelineWireFixture, timelineRows, savedTimeline, clipBytesExceptStart, MOVE_FUNCTION, MOVE_START, MOVE_MESSAGE} from './helpers/agent-timeline-wire-fixture.mjs';

const unchangedTables = DOMAIN_TABLES.filter(table => !['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests'].includes(table));
const items = capture => capture.protocol === 'responses' ? capture.body.input : capture.body.messages;
const fields = (timeline, extra = {}) => ({projectId: timeline.projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...extra});
const receipt = (root, requestId) => timelineRows(root).find(row => row.requestId === requestId);
const requestsFor = (root, projectId) => database(root, db => db.prepare('SELECT * FROM agent_chat_requests WHERE projectId=? ORDER BY rowid').all(projectId));
const noShotMutations = root => assert.equal(database(root, db => db.prepare('SELECT count(*) n FROM mutation_requests').get().n), 0);

function assertWire(f, selection) {
  const {project, timeline, clip, sources} = selection, [first, answer] = f.model.captures;
  assert.deepEqual(f.model.errors, []); assert.equal(f.model.captures.length, 2);
  for (const capture of [first, answer]) {
    assert.equal(capture.method, 'POST'); assert.equal(capture.headers.authorization, undefined);
    assert.equal(capture.path, f.protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
    assert.equal(capture.body.stream, true);
    for (const name of ['previous_response_id', 'conversation', 'background']) assert.equal(capture.body[name], undefined);
    const serialized = JSON.stringify(capture.body);
    assert.doesNotMatch(serialized, /PRIVATE_|relativePath|sha256|sourceInFrame|remainingTimelineEndFrame|subtitleEndFrame|fadeInFrames|fadeOutFrames/);
    for (const id of [project.id, timeline.id, ...timeline.clips.map(value => value.id), ...timeline.tracks.map(value => value.id), ...sources.map(value => value.id)])
      assert.equal(serialized.includes(id), false, 'backend-owned source and target identifiers never enter model context');
    if (f.protocol === 'responses') assert.equal(capture.body.store, false);
  }
  const track = timeline.tracks.find(value => value.id === clip.trackId);
  assert.deepEqual(JSON.parse(items(first).findLast(value => value.role === 'user').content), {
    kind: 'untrusted_selected_timeline_clip', saved: {
      clip: {name: clip.name, startFrame: 30, durationFrames: 60, endFrame: 90}, track: {name: track.name, kind: track.kind},
      fps: 30, occupiedIntervals: [{startFrame: 300, endFrame: 330}], maxEndFrame: 18000}, userRequest: MOVE_MESSAGE});
  assert.equal(first.body.tools.length, 1);
  const tool = f.protocol === 'responses' ? first.body.tools[0] : first.body.tools[0].function;
  assert.equal(tool.name, MOVE_FUNCTION); assert.deepEqual(Object.keys(tool.parameters.properties), ['startFrame']);
  assert.deepEqual(tool.parameters.required, ['startFrame']); assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.startFrame.type, 'integer'); assert.equal(tool.parameters.properties.startFrame.minimum, 0);
  assert.equal(tool.parameters.properties.startFrame.maximum, 18000);
  assert.deepEqual(answer.body.tools, []);
  assert.equal(answer.body.tool_choice, undefined, 'the synthetic Ollama endpoint omits unsupported tool_choice');
  const output = items(answer).find(value => f.protocol === 'responses' ? value.type === 'function_call_output' : value.role === 'tool');
  const call = f.protocol === 'responses' ? items(answer).find(value => value.type === 'function_call') : items(answer).find(value => value.tool_calls)?.tool_calls[0];
  assert.equal(f.protocol === 'responses' ? output.call_id : output.tool_call_id, first.callId);
  assert.equal(f.protocol === 'responses' ? call.call_id : call.id, first.callId);
  if (f.protocol === 'responses') assert.notEqual(call.id, call.call_id);
  assert.equal(f.protocol === 'responses' ? call.name : call.function.name, MOVE_FUNCTION);
  assert.deepEqual(JSON.parse(f.protocol === 'responses' ? call.arguments : call.function.arguments), {startFrame: MOVE_START});
  const result = JSON.parse(f.protocol === 'responses' ? output.output : output.content);
  assert.deepEqual(Object.keys(result).sort(), ['applied', 'digest', 'kind', 'operation', 'proposalId', 'status']);
  assert.equal(result.kind, 'untrusted_timeline_clip_move_proposal'); assert.equal(result.operation, 'timeline.clip.update');
  assert.equal(result.status, 'pending_review'); assert.equal(result.applied, false);
  return result;
}
async function assertQuiet(f, domain, modelCalls = 2) {
  assert.deepEqual(tableSnapshot(f.root), domain); assert.equal(f.model.captures.length, modelCalls);
  assert.equal((await f.process.observe()).acquisitions, 0);
  assert.deepEqual((await f.process.observe()).phases.filter(value => value !== 'beforeApproval'), []);
}

for (const protocol of ['chat_completions', 'responses']) {
  test(`${protocol}: actual fragmented HTTP/SSE move freezes a startFrame-only review and authenticated approval shares the timeline transaction`, {timeout: 30000}, async t => {
    const f = await timelineWireFixture(t, protocol), selection = await f.setup(), {project, timeline, clip} = selection;
    const before = tableSnapshot(f.root), untouched = tableSnapshot(f.root, unchangedTables), receiptsBefore = timelineRows(f.root).length;
    f.model.plan({name: MOVE_FUNCTION, arguments: {startFrame: MOVE_START}, hold: 'request'});
    const input = await f.input(project.id, selection), sent = await f.send(project.id, input);
    await until(() => f.model.held().some(value => value.startsWith('request:')), 'fragmented selected-move request');
    const accepted = JSON.parse(requestsFor(f.root, project.id)[0].acceptance);
    assert.deepEqual(JSON.parse(accepted.execution.request.body), f.model.captures[0].body);
    assert.deepEqual(accepted.execution.target.clip, clip); assert.equal(accepted.consent.clipId, clip.id);
    assert.equal(accepted.execution.policy.context, AGENT_TIMELINE_MOVE_CONTEXT);
    assert.equal(accepted.execution.policy.maxModelRequests, 2); assert.equal(accepted.execution.policy.maxToolCalls, 1);
    assert.equal((await f.proposals(project.id, '?view=all')).proposals.length, 0, 'streamed fragments are not executable');
    assert.deepEqual(tableSnapshot(f.root), before);
    f.model.release('request');
    const done = await f.terminal(project.id, input.requestId), proposal = (await f.proposals(project.id)).proposals[0];
    assert.equal(done.run.status, 'completed', JSON.stringify(done.run.error)); assert.equal(proposal.status, 'pending');
    assert.equal(proposal.runStatus, 'completed'); assert.equal(done.run.contextMode, AGENT_TIMELINE_MOVE_CONTEXT);
    assert.equal(done.run.provenance.category, 'project_selected_timeline_timing');
    assert.deepEqual(done.run.editTarget, agentTimelineMoveReviewTarget(accepted.execution.target));
    assert.deepEqual(proposal.patch, {startFrame: MOVE_START});
    assert.deepEqual(proposal.diff, {before: {startFrame: 30, endFrame: 90, durationFrames: 60, timelineDurationFrames: 630},
      after: {startFrame: MOVE_START, endFrame: 180, durationFrames: 60, timelineDurationFrames: 630}});
    const output = assertWire(f, selection); assert.equal(output.proposalId, proposal.id); assert.equal(output.digest, proposal.digest);
    assert.deepEqual(tableSnapshot(f.root), before, 'a durable proposal never changes business rows');
    const row = savedProposal(f.root, proposal.id), definition = JSON.parse(row.definition);
    assert.equal(row.targetKind, 'timeline_clip'); assert.equal(row.shotId, null); assert.equal(row.timelineId, timeline.id); assert.equal(row.clipId, clip.id);
    assert.equal(definition.version, 2); assert.equal(definition.operation, 'timeline.clip.update');
    assert.equal(clipBytesExceptStart(definition.target.clip), clipBytesExceptStart(clip));
    assert.deepEqual(definition.input, {projectId: project.id, clipId: clip.id, expectedRevision: timeline.revision, requestId: definition.input.requestId, patch: {startFrame: MOVE_START}});
    assert.equal(row.approval, null); assert.equal(row.outcome, null); assert.notEqual(definition.input.requestId, input.requestId);
    const steps = database(f.root, db => db.prepare('SELECT data FROM agent_chat_steps WHERE runId=? ORDER BY position').all(sent.run.id).map(value => JSON.parse(value.data)));
    assert.equal(steps.length, 3); assert.deepEqual(JSON.parse(steps[2].request.body), f.model.captures[1].body);
    const replay = await f.send(project.id, input); assert.equal(replay.replayed, true); assert.equal(replay.run.id, sent.run.id);
    const stream = await fetch(`${f.process.url}${chatRoute(project.id)}/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=0`,
      {headers: {authorization: `Bearer ${EDIT_WIRE_TOKEN}`}, signal: AbortSignal.timeout(12000)});
    assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type'), /^text\/event-stream/u);
    assert.match(await stream.text(), /event: terminal/u);
    const approved = await f.action(project.id, proposal, 'approve'), moved = savedTimeline(f.root, project.id);
    assert.equal(approved.proposal.status, 'applied'); assert.equal(moved.revision, timeline.revision + 1);
    assert.deepEqual(moved.clips.find(value => value.id === clip.id), {...clip, startFrame: MOVE_START});
    assert.equal(clipBytesExceptStart(moved.clips[0]), clipBytesExceptStart(clip), 'source, trim, geometry, gain and fades retain their serialized bytes');
    assert.deepEqual(moved.clips.slice(1), timeline.clips.slice(1)); assert.deepEqual(moved.tracks, timeline.tracks);
    assert.deepEqual(tableSnapshot(f.root, unchangedTables), untouched, 'source metadata and every non-timeline business row retain exact database bytes');
    const savedReceipt = receipt(f.root, definition.input.requestId);
    assert.deepEqual(JSON.parse(savedReceipt.response), moved);
    assert.equal(database(f.root, db => db.prepare('SELECT operation FROM timeline_history WHERE projectId=? ORDER BY position DESC LIMIT 1').get(project.id).operation), 'timeline.clip.update');
    assert.equal(savedReceipt.requestHash, createHash('sha256').update(canonical({operation: definition.operation, input: definition.input})).digest('hex'));
    assert.equal(timelineRows(f.root).length, receiptsBefore + 1); noShotMutations(f.root);
    const after = tableSnapshot(f.root), durable = savedProposal(f.root, proposal.id), phases = (await f.process.observe()).phases;
    assert.deepEqual(JSON.parse(durable.approval).input, definition.input); assert.equal(durable.definition, row.definition);
    for (const action of ['approve', 'recover', 'approve']) assert.deepEqual((await f.action(project.id, proposal, action)).proposal, approved.proposal);
    assert.deepEqual(tableSnapshot(f.root), after); assert.deepEqual(savedProposal(f.root, proposal.id), durable);
    assert.deepEqual((await f.process.observe()).phases.filter(value => value !== 'beforeApproval'), phases.filter(value => value !== 'beforeApproval'));
    assert.equal(f.model.captures.length, 2);
  });

  test(`${protocol}: pending restart and lost approval ACK retain one exact key with no automatic model or mutation POST`, {timeout: 30000}, async t => {
    const f = await timelineWireFixture(t, protocol), selection = await f.setup(), {project, timeline} = selection;
    const {proposal, sent} = await f.propose(project.id, selection), before = tableSnapshot(f.root), initial = savedProposal(f.root, proposal.id);
    const definition = JSON.parse(initial.definition), baseline = timelineRows(f.root).length;
    await f.restart();
    const rediscovered = await f.proposals(project.id); assert.notEqual(rediscovered.instanceId, sent.instanceId);
    assert.deepEqual(rediscovered.proposals, [proposal]); assert.deepEqual(savedProposal(f.root, proposal.id), initial);
    await assertQuiet(f, before);
    const stale = await f.request(editRoute(project.id, proposal.id, 'approve'), {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}});
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'AGENT_CHAT_SESSION_EXPIRED');
    assert.equal(await f.lostAcknowledgement(editRoute(project.id, proposal.id, 'approve'), {instanceId: rediscovered.instanceId, digest: proposal.digest}), 200);
    const applied = (await f.proposal(project.id, proposal.id)).proposal, after = tableSnapshot(f.root), durable = savedProposal(f.root, proposal.id);
    assert.equal(applied.status, 'applied'); assert.equal(savedTimeline(f.root, project.id).revision, timeline.revision + 1);
    assert.equal(timelineRows(f.root).length, baseline + 1); assert.ok(receipt(f.root, definition.input.requestId));
    await f.restart();
    assert.deepEqual((await f.proposals(project.id)).proposals, []); assert.deepEqual((await f.proposal(project.id, proposal.id)).proposal, applied);
    for (const action of ['approve', 'recover']) assert.deepEqual((await f.action(project.id, proposal, action)).proposal, applied);
    assert.deepEqual(savedProposal(f.root, proposal.id), durable); await assertQuiet(f, after);
  });

  test(`${protocol}: applied historical replay remains exact after undo, redo, selected clip removal and process restart`, {timeout: 30000}, async t => {
    const f = await timelineWireFixture(t, protocol), selection = await f.setup(), {project, clip} = selection;
    const {proposal} = await f.propose(project.id, selection), applied = (await f.action(project.id, proposal, 'approve')).proposal;
    const original = savedProposal(f.root, proposal.id), definition = JSON.parse(original.definition), savedReceipt = receipt(f.root, definition.input.requestId);
    let current = savedTimeline(f.root, project.id);
    current = await f.rpc('timeline.undo', fields(current)); assert.equal(current.clips.find(value => value.id === clip.id).startFrame, 30);
    assert.deepEqual((await f.proposal(project.id, proposal.id)).proposal, applied);
    current = await f.rpc('timeline.redo', fields(current)); assert.equal(current.clips.find(value => value.id === clip.id).startFrame, MOVE_START);
    current = await f.rpc('timeline.clip.remove', fields(current, {clipId: clip.id})); assert.equal(current.clips.some(value => value.id === clip.id), false);
    const afterRemoval = tableSnapshot(f.root);
    assert.deepEqual(await f.rpc('timeline.clip.update', definition.input), JSON.parse(savedReceipt.response), 'shared RPC replays the saved successful response, never recreates the removed clip');
    assert.deepEqual((await f.action(project.id, proposal, 'recover')).proposal, applied); assert.deepEqual(tableSnapshot(f.root), afterRemoval);
    await f.restart();
    assert.deepEqual((await f.proposal(project.id, proposal.id)).proposal, applied);
    for (const action of ['approve', 'recover']) assert.deepEqual((await f.action(project.id, proposal, action)).proposal, applied);
    assert.deepEqual(savedProposal(f.root, proposal.id), original); assert.deepEqual(receipt(f.root, definition.input.requestId), savedReceipt);
    await assertQuiet(f, afterRemoval);
  });

  test(`${protocol}: stale timeline CAS records a request-bound rejection without rebase, receipt or second dispatch`, {timeout: 30000}, async t => {
    const f = await timelineWireFixture(t, protocol), selection = await f.setup(), {project, timeline, clip} = selection;
    const {proposal} = await f.propose(project.id, selection), definition = JSON.parse(savedProposal(f.root, proposal.id).definition);
    const manual = await f.rpc('timeline.clip.update', fields(timeline, {clipId: clip.id, patch: {startFrame: 180}}));
    const before = tableSnapshot(f.root), failed = (await f.action(project.id, proposal, 'approve')).proposal;
    assert.equal(failed.status, 'failed'); assert.deepEqual(failed.outcome, {status: 'not_applied', code: 'REVISION_CONFLICT'});
    assert.deepEqual(savedTimeline(f.root, project.id), manual); assert.equal(receipt(f.root, definition.input.requestId), undefined);
    const phases = (await f.process.observe()).phases;
    for (const action of ['approve', 'recover']) assert.deepEqual((await f.action(project.id, proposal, action)).proposal, failed);
    assert.deepEqual(tableSnapshot(f.root), before);
    assert.deepEqual((await f.process.observe()).phases.filter(value => value !== 'beforeApproval'), phases.filter(value => value !== 'beforeApproval'));
    assert.equal(f.model.captures.length, 2);
  });

  test(`${protocol}: forged model authority, invalid timing, overlap and incomplete SSE fail before proposal capture`, {timeout: 45000}, async t => {
    const f = await timelineWireFixture(t, protocol), selection = await f.setup(), {project, clip} = selection, before = tableSnapshot(f.root);
    const plans = [
      {name: 'timeline.clip.update'}, {name: 'agent.edit.approve'}, {name: 'generation.submit'},
      ...[{clipId: clip.id}, {projectId: project.id}, {requestId: randomUUID()}, {expectedRevision: selection.timeline.revision}, {trackId: clip.trackId},
        {assetId: clip.assetId}, {durationFrames: 90}, {sourceInFrame: 0}, {gain: 1}, {approved: true}].map(extra => ({arguments: {startFrame: MOVE_START, ...extra}})),
      ...[30, 300, 17950, -1, 1.5].map(startFrame => ({arguments: {startFrame}})),
      {rawArguments: '{"startFrame":120,"start\\u0046rame":180}'}, {rawArguments: '{'}, {truncate: 'request'},
    ];
    for (const plan of plans) {
      const {done, proposal} = await f.propose(project.id, selection, plan);
      assert.equal(done.run.status, 'failed', JSON.stringify({plan, run: done.run})); assert.equal(proposal, undefined);
    }
    assert.deepEqual((await f.proposals(project.id, '?view=all')).proposals, []);
    assert.deepEqual(tableSnapshot(f.root), before); assert.equal(f.model.captures.length, plans.length); noShotMutations(f.root);
    assert.deepEqual((await f.process.observe()).phases, []);
  });

  for (const phase of ['request', 'answer']) test(`${protocol}: Stop during move ${phase} closes the provider socket and blocks later approval`, {timeout: 30000}, async t => {
    const f = await timelineWireFixture(t, protocol), selection = await f.setup(), {project} = selection, before = tableSnapshot(f.root);
    f.model.plan({name: MOVE_FUNCTION, arguments: {startFrame: MOVE_START}, hold: phase});
    const input = await f.input(project.id, selection), sent = await f.send(project.id, input);
    await until(() => f.model.held().some(value => value.startsWith(`${phase}:`)), `held move ${phase}`);
    if (phase === 'answer') {
      const proposal = (await f.proposals(project.id)).proposals[0]; assert.ok(proposal);
      const premature = await f.request(editRoute(project.id, proposal.id, 'approve'), {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}});
      assert.equal(premature.status, 409);
    }
    assert.equal((await f.data(`${chatRoute(project.id)}/runs/${sent.run.id}/stop`, {method: 'POST', input: {instanceId: sent.instanceId}})).run.status, 'stopped');
    await until(() => f.model.captures.at(-1).closed, 'Stop closes actual provider socket'); f.model.release(phase);
    for (const proposal of (await f.proposals(project.id, '?view=all')).proposals) {
      assert.equal(proposal.status, 'cancelled');
      const refused = await f.request(editRoute(project.id, proposal.id, 'approve'), {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}});
      assert.ok(refused.status === 409 || refused.body.data?.proposal?.status === 'cancelled');
    }
    await f.restart(); assert.equal((await f.lookup(project.id, input.requestId)).run.status, 'stopped');
    await assertQuiet(f, before, phase === 'request' ? 1 : 2);
  });

  test(`${protocol}: tools-off answer failure and backend interruption leave captured move proposals unapprovable`, {timeout: 45000}, async t => {
    const f = await timelineWireFixture(t, protocol), selection = await f.setup(), {project} = selection, before = tableSnapshot(f.root);
    for (const plan of [{error: 'answer'}, {secondTool: true}, {truncate: 'answer'}]) {
      const {done, proposal, sent} = await f.propose(project.id, selection, plan);
      assert.equal(done.run.status, 'failed'); assert.ok(proposal); assert.equal(proposal.status, 'cancelled');
      const refused = await f.request(editRoute(project.id, proposal.id, 'approve'), {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}});
      assert.ok(refused.status === 409 || refused.body.data?.proposal?.status === 'cancelled');
    }
    f.model.plan({name: MOVE_FUNCTION, arguments: {startFrame: MOVE_START}, hold: 'answer'});
    const input = await f.input(project.id, selection); await f.send(project.id, input);
    await until(() => f.model.held().some(value => value.startsWith('answer:')), 'interrupted move answer');
    const pending = (await f.proposals(project.id)).proposals[0]; await f.restart({crash: true});
    const snapshot = await f.proposal(project.id, pending.id);
    assert.equal(snapshot.proposal.status, 'cancelled'); assert.equal(snapshot.proposal.runStatus, 'interrupted');
    const refused = await f.request(editRoute(project.id, pending.id, 'approve'), {method: 'POST', input: {instanceId: snapshot.instanceId, digest: pending.digest}});
    assert.ok(refused.status === 409 || refused.body.data?.proposal?.status === 'cancelled');
    await assertQuiet(f, before, 8);
  });
}

test('move HTTP routes fence authentication, project, epoch, digest and outbound consent before any authority is acquired', {timeout: 30000}, async t => {
  const f = await timelineWireFixture(t, 'responses'), selection = await f.setup(), other = await f.setup(), {project} = selection;
  const {proposal, sent} = await f.propose(project.id, selection), before = tableSnapshot(f.root), acceptedCount = requestsFor(f.root, project.id).length;
  const actionInput = {instanceId: sent.instanceId, digest: proposal.digest};
  for (const action of [undefined, 'approve', 'reject', 'recover']) {
    const route = editRoute(project.id, proposal.id, action), options = action ? {method: 'POST', input: actionInput} : {};
    assert.equal((await f.request(route, {...options, authenticated: false})).status, 401);
    assert.equal((await f.request(route, {...options, headers: {origin: 'https://untrusted.example'}})).status, 403);
    assert.equal((await f.request(editRoute(other.project.id, proposal.id, action), options)).status, 404);
    assert.equal((await f.request(route, {method: action ? 'GET' : 'POST', ...(action ? {} : {input: {}})})).status, 405);
  }
  for (const action of ['approve', 'reject', 'recover']) for (const override of [
    {digest: 'f'.repeat(64)}, {instanceId: randomUUID()}, {projectId: other.project.id}, {clipId: other.clip.id}, {requestId: randomUUID()}, {patch: {startFrame: 240}},
  ]) {
    const response = await f.request(editRoute(project.id, proposal.id, action), {method: 'POST', input: {...actionInput, ...override}});
    assert.ok([400, 409].includes(response.status), JSON.stringify(response.body));
  }
  const input = await f.input(project.id, selection);
  for (const override of [{projectId: other.project.id}, {clipId: other.clip.id}, {timelineId: other.timeline.id}, {expectedRevision: selection.timeline.revision + 1},
    {catalogHash: '0'.repeat(64)}, {maxModelRequests: 3}, {maxToolCalls: 2}, {maxStartFrame: 18001}, {maxOccupiedIntervals: 100}, {maxOccupiedIntervals: 101},
    {maxResultBytes: 8193}, {destination: 'https://foreign.example/v1/responses'}, {protocol: 'chat_completions'}, {model: 'different'}, {shotId: randomUUID()}]) {
    const rejected = await f.request(`${chatRoute(project.id)}/runs`, {method: 'POST', input: {...input, consent: {...input.consent, ...override}}});
    assert.ok([400, 404, 409].includes(rejected.status), JSON.stringify(rejected.body));
  }
  for (const operation of ['agent.edit.approve', 'agent.edit.reject', 'agent.edit.recover', MOVE_FUNCTION]) {
    const response = await f.request('/api/rpc', {method: 'POST', input: {operation, input: actionInput}});
    assert.equal(response.body.error.code, 'UNKNOWN_OPERATION');
  }
  assert.equal(requestsFor(f.root, project.id).length, acceptedCount); assert.equal(f.model.captures.length, 2);
  assert.deepEqual(tableSnapshot(f.root), before); assert.equal(savedProposal(f.root, proposal.id).approval, null);
});

test('two authenticated windows racing move approve/reject retain one decision and at most one exact timeline receipt', {timeout: 30000}, async t => {
  const f = await timelineWireFixture(t, 'responses'), selection = await f.setup(), {project, clip} = selection;
  for (const order of [['approve', 'reject'], ['reject', 'approve'], ['approve', 'approve']]) {
    const current = savedTimeline(f.root, project.id), startFrame = current.clips.find(value => value.id === clip.id).startFrame === 120 ? 180 : 120;
    const {proposal, sent} = await f.propose(project.id, {...selection, timeline: current}, {arguments: {startFrame}});
    const definition = JSON.parse(savedProposal(f.root, proposal.id).definition), baseline = timelineRows(f.root).length;
    const results = await Promise.all(order.map(action => f.request(editRoute(project.id, proposal.id, action), {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}})));
    assert.ok(results.every(value => value.status === 200 || value.status === 409));
    const settled = (await f.proposal(project.id, proposal.id)).proposal; assert.ok(['applied', 'rejected'].includes(settled.status));
    if (order.every(value => value === 'approve')) assert.equal(settled.status, 'applied');
    const changed = Number(settled.status === 'applied'), after = savedTimeline(f.root, project.id);
    assert.equal(after.revision, current.revision + changed); assert.equal(timelineRows(f.root).length, baseline + changed);
    assert.equal(Boolean(receipt(f.root, definition.input.requestId)), Boolean(changed));
    if (!changed) assert.deepEqual(after, current);
    const fixed = savedProposal(f.root, proposal.id), domain = tableSnapshot(f.root);
    for (const action of ['approve', 'reject']) assert.deepEqual((await f.action(project.id, proposal, action)).proposal, settled);
    assert.deepEqual(savedProposal(f.root, proposal.id), fixed); assert.deepEqual(tableSnapshot(f.root), domain);
  }
  assert.equal(f.model.captures.length, 6); noShotMutations(f.root);
});

for (const state of ['pending', 'historical']) test(`${state} move HTTP review refuses a source that now belongs to a foreign project`, {timeout: 30000}, async t => {
  const f = await timelineWireFixture(t, 'responses'), selection = await f.setup(), other = await f.setup(), {project, sources} = selection;
  const {proposal, sent} = await f.propose(project.id, selection);
  if (state === 'historical') {
    await f.action(project.id, proposal, 'approve');
    let current = savedTimeline(f.root, project.id);
    for (const clip of current.clips.filter(value => value.assetId === sources[0].id))
      current = await f.rpc('timeline.clip.remove', fields(current, {clipId: clip.id}));
    assert.equal((await f.proposal(project.id, proposal.id)).proposal.status, 'applied');
  }
  database(f.root, db => db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(other.project.id,
    JSON.stringify({...sources[0], projectId: other.project.id, name: 'FOREIGN_SOURCE_SECRET'}), sources[0].id), {writable: true});
  const before = tableSnapshot(f.root), row = savedProposal(f.root, proposal.id);
  for (const action of [undefined, 'approve', 'recover', 'reject']) {
    const response = await f.request(editRoute(project.id, proposal.id, action), action ? {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}} : {});
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(JSON.stringify(response.body).includes('FOREIGN_SOURCE_SECRET'), false);
  }
  assert.deepEqual(tableSnapshot(f.root), before); assert.deepEqual(savedProposal(f.root, proposal.id), row);
  assert.equal(f.model.captures.length, 2);
});

for (const protocol of ['chat_completions', 'responses']) for (const boundary of ['beforeApproval', 'afterApproval', 'afterDispatchStarted', 'afterDispatch', 'beforeAcknowledgement']) {
  test(`${protocol}: owned SIGKILL at move ${boundary} never auto-repeats inference or approval and recovery retains the exact key`, {timeout: 35000}, async t => {
    const f = await timelineWireFixture(t, protocol), selection = await f.setup(), {project, timeline} = selection;
    const {proposal, sent} = await f.propose(project.id, selection), original = savedProposal(f.root, proposal.id), definition = JSON.parse(original.definition);
    const baseline = timelineRows(f.root).length, untouched = tableSnapshot(f.root, unchangedTables);
    await f.process.arm(boundary);
    const attempt = f.request(editRoute(project.id, proposal.id, 'approve'), {method: 'POST', input: {instanceId: sent.instanceId, digest: proposal.digest}}).then(response => ({response}), error => ({error}));
    const terminated = await Promise.race([f.process.exited, new Promise((_, reject) => {const timer = setTimeout(() => reject(Error(`Move crash hook not reached: ${boundary}`)), 12000); timer.unref();})]);
    assert.equal(terminated.signal, 'SIGKILL', f.process.output); assert.ok((await attempt).error);
    assert.deepEqual((await f.trace()).at(-1), {label: boundary, crash: true});
    const committed = ['afterDispatch', 'beforeAcknowledgement'].includes(boundary), crashed = savedProposal(f.root, proposal.id);
    assert.equal(savedTimeline(f.root, project.id).revision, timeline.revision + Number(committed));
    assert.equal(timelineRows(f.root).length, baseline + Number(committed)); assert.equal(crashed.definition, original.definition);
    if (boundary === 'beforeApproval') assert.equal(crashed.approval, null);
    else assert.deepEqual(JSON.parse(crashed.approval).input, definition.input);
    await f.restart();
    const snapshot = await f.proposal(project.id, proposal.id), resumed = snapshot.proposal;
    assert.equal(resumed.status, boundary === 'beforeApproval' ? 'pending' : committed ? 'applied' : 'unknown');
    const domain = tableSnapshot(f.root), rediscovered = savedProposal(f.root, proposal.id);
    await f.proposals(project.id); await f.proposals(project.id, '?view=all'); await f.proposal(project.id, proposal.id);
    assert.deepEqual(savedProposal(f.root, proposal.id), rediscovered); await assertQuiet(f, domain);
    if (boundary === 'beforeApproval') {
      const refused = await f.request(editRoute(project.id, proposal.id, 'recover'), {method: 'POST', input: {instanceId: snapshot.instanceId, digest: proposal.digest}});
      assert.equal(refused.status, 409);
      assert.equal((await f.action(project.id, proposal, 'approve')).proposal.status, 'applied');
    } else {
      assert.deepEqual((await f.action(project.id, proposal, 'approve')).proposal, resumed); await assertQuiet(f, domain);
      assert.equal((await f.action(project.id, proposal, 'recover')).proposal.status, 'applied');
    }
    assert.equal(savedTimeline(f.root, project.id).revision, timeline.revision + 1); assert.equal(timelineRows(f.root).length, baseline + 1);
    assert.ok(receipt(f.root, definition.input.requestId)); assert.equal(savedProposal(f.root, proposal.id).definition, original.definition);
    if (crashed.approval !== null) assert.equal(savedProposal(f.root, proposal.id).approval, crashed.approval);
    assert.deepEqual(tableSnapshot(f.root, unchangedTables), untouched); assert.equal(f.model.captures.length, 2);
    assert.equal((await f.process.observe()).acquisitions, 0);
    const final = tableSnapshot(f.root); await f.action(project.id, proposal, 'recover'); await f.action(project.id, proposal, 'approve');
    assert.deepEqual(tableSnapshot(f.root), final);
  });
}

test('actual CLI and MCP update/undo share the approved Agent timeline history while exposing no Agent approval tools', {timeout: 45000}, async t => {
  const f = await timelineWireFixture(t, 'responses'), selection = await f.setup(), {project, clip} = selection;
  const {proposal} = await f.propose(project.id, selection); await f.action(project.id, proposal, 'approve');
  const approved = savedTimeline(f.root, project.id), originalProposal = savedProposal(f.root, proposal.id), baseline = timelineRows(f.root).length;
  const client = new Client({name: 'synthetic-agent-timeline-boundary-audit', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(REPO, 'apps/mcp/src/index.ts')], cwd: REPO,
    env: {...f.testRuntimeEnvironment, PATH: process.env.PATH || '', HOME: f.root, MIOON_BASE_URL: f.process.url, MIOON_TOKEN: EDIT_WIRE_TOKEN, MIOON_ENABLE_LIVE_PROVIDER: '0'}, stderr: 'ignore'});
  f.deferCleanup(() => client.close()); await client.connect(transport);
  const tools = (await client.listTools()).tools.map(value => value.name);
  for (const name of ['timeline_clip_update', 'timeline_undo']) assert.ok(tools.includes(name));
  assert.equal(tools.some(name => /agent.*edit|propose_timeline|edit.*approve|edit.*recover/u.test(name)), false);
  const cli = async (operation, input) => {const result = await f.cli(operation, input); assert.equal(result.code, 0, result.stderr); assert.equal(result.body.ok, true); return result.body.data;};
  const mcp = async (name, input) => {
    const result = await client.callTool({name, arguments: input}), envelope = JSON.parse(result.content.find(value => value.type === 'text').text);
    assert.equal(Boolean(result.isError), false, JSON.stringify(envelope)); assert.equal(envelope.ok, true); return envelope.data;
  };
  const cliInput = fields(approved, {clipId: clip.id, patch: {startFrame: 180}});
  let current = await cli('timeline.clip.update', cliInput);
  assert.equal(current.clips.find(value => value.id === clip.id).startFrame, 180); assert.deepEqual(savedTimeline(f.root, project.id), current);
  assert.deepEqual(await cli('timeline.clip.update', cliInput), current);
  current = await cli('timeline.undo', fields(current)); assert.deepEqual(current.clips, approved.clips);
  const mcpInput = fields(current, {clipId: clip.id, patch: {startFrame: 210}});
  current = await mcp('timeline_clip_update', mcpInput); assert.equal(current.clips.find(value => value.id === clip.id).startFrame, 210);
  assert.deepEqual(await mcp('timeline_clip_update', mcpInput), current);
  current = await mcp('timeline_undo', fields(current)); assert.deepEqual(current.clips, approved.clips);
  assert.equal(current.revision, approved.revision + 4); assert.equal(timelineRows(f.root).length, baseline + 4);
  assert.deepEqual(await f.rpc('timeline.get', {projectId: project.id}), current);
  assert.deepEqual(savedProposal(f.root, proposal.id), originalProposal); noShotMutations(f.root);
  const noAuthorityBefore = tableSnapshot(f.root);
  for (const operation of ['agent.edit.approve', 'agent.edit.reject', 'agent.edit.recover', MOVE_FUNCTION]) {
    const rejected = await f.cli(operation, {proposalId: proposal.id, digest: proposal.digest});
    assert.notEqual(rejected.code, 0); assert.equal(rejected.body.error.code, 'UNKNOWN_OPERATION');
    const response = await client.callTool({name: operation.replaceAll('.', '_'), arguments: {proposalId: proposal.id, digest: proposal.digest}});
    assert.equal(response.isError, true); assert.equal(JSON.parse(response.content[0].text).error.code, 'UNKNOWN_OPERATION');
  }
  assert.deepEqual(tableSnapshot(f.root), noAuthorityBefore); assert.equal(f.model.captures.length, 2);
});
