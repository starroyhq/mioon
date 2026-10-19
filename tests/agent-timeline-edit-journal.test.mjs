import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deriveAgentEndpoint, AGENT_TIMELINE_MOVE_CONTEXT} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {createChatJournal} from '../packages/business/src/agent/chat-journal.ts';
import {buildAgentRequest} from '../packages/business/src/agent/agent-gateway.ts';
import {selectChatContext} from '../packages/business/src/agent/chat-context.ts';
import {timelineEditToolPolicy, timelineEditToolCapability} from '../packages/business/src/agent/timeline-edit-tool-policy.ts';
import {editToolPolicy, editToolCapability} from '../packages/business/src/agent/edit-tool-policy.ts';

const unavailable = {code: 'AGENT_CHAT_STORAGE_UNAVAILABLE'}, mode = AGENT_TIMELINE_MOVE_CONTEXT;
const config = protocol => ({presetId: 'ollama', platformId: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', protocol});
function fixture(t, protocol = 'chat_completions') {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-timeline-edit-journal-')), projectId = randomUUID();
  let store = openStore(root), journal = createChatJournal({store}); store.put('projects', {id: projectId});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const track = {id: randomUUID(), name: 'Saved track', kind: 'video', orderIndex: 0, hidden: false, muted: false};
  const target = {projectId, timelineId: randomUUID(), expectedRevision: 2, fps: 30, width: 720, height: 1280, durationFrames: 30,
    clip: {id: randomUUID(), trackId: track.id, assetId: randomUUID(), name: 'Saved clip', startFrame: 0, durationFrames: 30, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1},
    track, occupiedIntervals: [], remainingTimelineEndFrame: 0, subtitleEndFrame: 0};
  const userText = 'Move selected clip to frame 90', configuration = config(protocol);
  const {messages} = selectChatContext([], userText, mode, {historyRuns: 12}, target);
  const provenance = {category: 'project_selected_timeline_timing', projectId, sourceRunIds: []};
  const request = {protocol, body: buildAgentRequest({configuration, messages, readTools: {phase: 'request', scope: mode}}).body, context: messages, provenance};
  const execution = {version: 1, policy: timelineEditToolPolicy(projectId), target, request};
  const {available, ...capability} = timelineEditToolCapability(true);
  const consent = {destination: deriveAgentEndpoint(configuration), protocol, model: configuration.model, context: mode, projectId,
    ...capability, timelineId: target.timelineId, clipId: target.clip.id, expectedRevision: target.expectedRevision};
  const call = {id: 'call_saved_move', name: 'mioon_propose_timeline_clip_move', arguments: {startFrame: 90}, argumentsJson: '{"startFrame":90}', ...(protocol === 'responses' ? {itemId: 'fc_saved_move'} : {})};
  const output = {type: 'done', finishReason: 'tool_calls', toolCall: call, providerOutput: protocol === 'responses' ?
    [{id: call.itemId, type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsJson, status: 'completed'}] :
    {role: 'assistant', content: null, tool_calls: [{id: call.id, type: 'function', function: {name: call.name, arguments: call.argumentsJson}}]}};
  const observedProvenance = {category: provenance.category, projectId, operation: 'timeline.clip.update'};
  const result = {kind: 'untrusted_timeline_clip_move_proposal', operation: 'timeline.clip.update', status: 'pending_review', applied: false, proposalId: randomUUID(), digest: 'a'.repeat(64)};
  const observation = {result, resultJson: JSON.stringify(result), provenance: observedProvenance};
  let accepted;
  const f = {root, projectId, target, configuration, messages, execution, request, consent, call, output, observation,
    get store() {return store;}, get journal() {return journal;}, get id() {return accepted.run.id;},
    accept(overrides = {}) {
      accepted = journal.accept({projectId, requestId: randomUUID(), fingerprint: 'synthetic', instanceId: randomUUID(), configuration,
        messages, consent, input: {message: userText, expectedSettingsRevision: 0, expectedConversationRevision: 0}, execution, ...overrides}); return accepted;
    },
    first() {return journal.steps(projectId, f.id)[0];},
    dispatch() {return journal.modelDispatch(f.id, f.first().id);},
    complete() {return journal.modelComplete(f.id, f.first().id, {output});},
    intent() {return journal.toolIntent(f.id, f.first().id, {toolCall: call, provenance: observedProvenance});},
    capture(callback = () => observation) {return journal.captureTool(f.id, journal.steps(projectId, f.id)[1].id, callback);},
    next() {return {...request, body: buildAgentRequest({configuration, messages, readTools: {phase: 'answer', scope: mode, toolCall: call, providerOutput: output.providerOutput, result: observation.resultJson}}).body};},
    rows(table) {return store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();},
    reopen() {store.close(); store = openStore(root); journal = createChatJournal({store});},
    observed() {f.accept(); f.dispatch(); f.complete(); f.intent(); return f.capture();},
  };
  return f;
}
for (const protocol of ['chat_completions', 'responses']) {
  test(`${protocol}: move journal persists exact target and full protocol continuation without rewriting accepted bytes`, t => {
    const f = fixture(t, protocol); f.observed();
    const before = f.rows('agent_chat_requests')[0].acceptance, second = f.journal.prepareContinuation(f.id, f.next());
    f.journal.modelDispatch(f.id, second.step.id); f.journal.modelComplete(f.id, second.step.id, {output: {type: 'done', finishReason: 'stop'}});
    const finished = f.journal.finish(f.id, 'completed');
    assert.deepEqual(finished.run.editTarget, f.target); assert.equal(f.journal.replay(f.id, 0)[0].run.contextMode, mode);
    const saved = f.rows('agent_chat_steps'); f.reopen(); assert.deepEqual(f.journal.recover(), []);
    assert.deepEqual(f.rows('agent_chat_steps'), saved); assert.equal(f.rows('agent_chat_requests')[0].acceptance, before);
    assert.deepEqual(f.journal.get(f.projectId, f.id), finished.run);
  });
  test(`${protocol}: continuation rejects replaced call IDs, results, model parameters and tool-enabled answers`, t => {
    const f = fixture(t, protocol); f.observed();
    for (const mutate of [
      body => {if (protocol === 'responses') body.input.at(-1).call_id = 'forged'; else body.messages.at(-1).tool_call_id = 'forged';},
      body => {if (protocol === 'responses') body.input.at(-1).output = '{}'; else body.messages.at(-1).content = '{}';},
      body => {body.tools = JSON.parse(f.request.body).tools;}, body => {body.max_tokens = 999;}, body => {body.store = true;},
    ]) {const next = f.next(), body = JSON.parse(next.body); mutate(body); next.body = JSON.stringify(body); assert.throws(() => f.journal.prepareContinuation(f.id, next), unavailable);}
    const next = f.journal.prepareContinuation(f.id, f.next()); f.journal.modelDispatch(f.id, next.step.id);
    assert.throws(() => f.journal.modelComplete(f.id, next.step.id, {output: f.output}), unavailable);
    assert.equal(f.journal.steps(f.projectId, f.id).length, 3);
  });
  for (const boundary of ['accepted', 'first-dispatch', 'first-complete', 'intent', 'capture-started', 'observed', 'prepared', 'second-dispatch'])
    test(`${protocol}: restart at timeline ${boundary} only reconciles local state`, t => {
      const f = fixture(t, protocol); f.accept();
      if (boundary !== 'accepted') f.dispatch();
      if (!['accepted', 'first-dispatch'].includes(boundary)) f.complete();
      if (!['accepted', 'first-dispatch', 'first-complete'].includes(boundary)) f.intent();
      if (boundary === 'capture-started') assert.throws(() => f.capture(() => {throw Error('synthetic crash');}));
      if (['observed', 'prepared', 'second-dispatch'].includes(boundary)) f.capture();
      if (['prepared', 'second-dispatch'].includes(boundary)) {const next = f.journal.prepareContinuation(f.id, f.next()); if (boundary === 'second-dispatch') f.journal.modelDispatch(f.id, next.step.id);}
      const steps = f.journal.steps(f.projectId, f.id), accepted = f.rows('agent_chat_requests')[0].acceptance;
      f.reopen(); assert.equal(f.journal.recover()[0].status, 'interrupted');
      assert.deepEqual(f.journal.steps(f.projectId, f.id).map(x => x.status), steps.map(x => x.status === 'completed' ? 'completed' : 'unknown'));
      assert.equal(f.rows('agent_chat_requests')[0].acceptance, accepted); assert.deepEqual(f.journal.recover(), []);
      if (steps[1] && steps[1].status !== 'completed') assert.throws(() => f.capture(() => assert.fail('cannot recapture')), unavailable);
    });
}

test('new mode refuses altered scope, target, catalog and exact outbound context before durable acceptance', t => {
  for (const change of [
    value => {value.execution.target.clip.assetId = 'not-an-id';},
    value => {value.execution.policy.catalog[0].name = 'mioon_propose_shot_update';},
    value => {value.consent.clipId = randomUUID();}, value => {value.consent.expectedRevision++;},
    value => {value.execution.request.provenance.category = 'project_selected_shot_text';},
    value => {const body = JSON.parse(value.execution.request.body); body.tools = []; value.execution.request.body = JSON.stringify(body);},
  ]) {
    const f = fixture(t), value = structuredClone({consent: f.consent, execution: f.execution}); change(value);
    assert.throws(() => f.accept(value), unavailable); assert.equal(f.rows('agent_chat_requests').length, 0);
  }
});

test('move evidence cannot be downgraded to inspection, shot editing or typed history', t => {
  for (const corrupt of ['project_inspection', 'selected_shot_edit', 'typed_chat_only']) {
    const f = fixture(t); f.accept(); f.store.db.exec('DROP TRIGGER immutable_agent_chat_inspection_context');
    if (corrupt === 'typed_chat_only') f.store.db.exec("UPDATE agent_chat_runs SET data=json_remove(data,'$.contextMode','$.provenance','$.activity')");
    else f.store.db.prepare("UPDATE agent_chat_runs SET data=json_set(data,'$.contextMode',?)").run(corrupt);
    assert.throws(() => f.journal.get(f.projectId, f.id), unavailable);
  }
});

test('Stop invalidates pending move dispatch and continuation; completed capture is never repeated', t => {
  const f = fixture(t); f.accept(); f.dispatch(); f.complete(); const intent = f.intent();
  f.journal.finish(f.id, 'stopped');
  assert.throws(() => f.journal.captureTool(f.id, intent.step.id, () => assert.fail('stopped proposal')), unavailable);
  assert.throws(() => f.journal.prepareContinuation(f.id, f.next()), unavailable);
  const other = fixture(t); other.observed(); let recaptured = false;
  other.capture(() => {recaptured = true; return other.observation;}); assert.equal(recaptured, false);
});

test('schema-1 shot accepted JSON bytes remain byte-identical across successful completion and reopen', t => {
  const f = fixture(t), target = {projectId: f.projectId, shotId: randomUUID(), expectedRevision: 1, title: 'Saved title', prompt: 'Saved prompt'};
  const {messages} = selectChatContext([], 'Keep unchanged', 'selected_shot_edit', {historyRuns: 12}, target);
  const {available, ...capability} = editToolCapability(true), provenance = {category: 'project_selected_shot_text', projectId: f.projectId, sourceRunIds: []};
  const execution = {version: 1, policy: editToolPolicy(f.projectId), target, request: {protocol: f.configuration.protocol,
    body: buildAgentRequest({configuration: f.configuration, messages, readTools: {phase: 'request', scope: 'selected_shot_edit'}}).body, context: messages, provenance}};
  f.accept({messages, execution, input: {message: 'Keep unchanged', expectedSettingsRevision: 0, expectedConversationRevision: 0},
    consent: {destination: deriveAgentEndpoint(f.configuration), protocol: f.configuration.protocol, model: f.configuration.model, context: 'selected_shot_edit', projectId: f.projectId,
      ...capability, shotId: target.shotId, expectedRevision: 1}});
  const original = f.rows('agent_chat_requests')[0].acceptance; f.dispatch();
  f.journal.modelComplete(f.id, f.first().id, {output: {type: 'done', finishReason: 'stop'}}); f.journal.finish(f.id, 'completed');
  f.reopen(); f.journal.recover(); assert.equal(f.rows('agent_chat_requests')[0].acceptance, original);
  assert.equal(f.journal.get(f.projectId, f.id).contextMode, 'selected_shot_edit');
});
