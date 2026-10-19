import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openStore, createServices} from '@mioon/business';
import {deriveAgentEndpoint, AGENT_TIMELINE_MOVE_CONTEXT, agentTimelineMoveReviewTarget} from '@mioon/contracts';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.ts';
import {createChatRuntime} from '../packages/business/src/agent/chat-runtime.ts';
import {createAgentEditService} from '../packages/business/src/agent/edit-proposals.ts';
import {editToolCapability, EDIT_TOOL_CATALOG_HASH} from '../packages/business/src/agent/edit-tool-policy.ts';

const context = AGENT_TIMELINE_MOVE_CONTEXT;
function done(protocol, changes = {startFrame: 90}, name = 'mioon_propose_timeline_clip_move') {
  const argumentsJson = JSON.stringify(changes), id = 'call_timeline_move', itemId = 'fc_distinct_timeline';
  const toolCall = {id, name, arguments: changes, argumentsJson, ...(protocol === 'responses' ? {itemId} : {})};
  return {type: 'done', finishReason: 'tool_calls', toolCall, providerOutput: protocol === 'responses' ?
    [{id: itemId, type: 'function_call', call_id: id, name, arguments: argumentsJson, status: 'completed'}] :
    {role: 'assistant', content: null, tool_calls: [{id, type: 'function', function: {name, arguments: argumentsJson}}]}};
}
async function until(check) { for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await delay(2); } assert.fail('Synthetic move run did not settle'); }
async function fixture(t, protocol = 'chat_completions', options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-timeline-edit-runtime-')), store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'PRIVATE_PROJECT_NAME'}), other = await services.call('project.create', {name: 'PRIVATE_FOREIGN_PROJECT'});
  const assetId = randomUUID();
  store.put('assets', {id: assetId, projectId: project.id, name: 'PRIVATE_ASSET_NAME', mimeType: 'image/png', duration: 0,
    width: 720, height: 1280, relativePath: 'media/PRIVATE_PATH.png', sha256: 'a'.repeat(64)});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const add = async (trackId, startFrame, durationFrames, name) => {
    timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), trackId, assetId, startFrame, durationFrames});
    const clip = timeline.clips.at(-1);
    timeline = await services.call('timeline.clip.update', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), clipId: clip.id, patch: {name}});
    return clip.id;
  };
  const clipId = await add(timeline.tracks[0].id, 0, 30, 'SELECTED_SAVED_CLIP');
  await add(timeline.tracks[0].id, 300, 30, 'PRIVATE_SAME_TRACK_OTHER_CLIP');
  await add(timeline.tracks[1].id, 900, 30, 'PRIVATE_OTHER_TRACK_CLIP');
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const initial = await settings.get();
  await settings.put({expectedRevision: 0, configuration: {...initial.configuration, protocol}, secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_TEST_ONLY'}});
  const calls = [], acquired = [];
  const supplied = {get: (...args) => settings.get(...args), [AGENT_CREDENTIAL_ACQUIRE](...args) {
    acquired.push(JSON.parse(store.db.prepare('SELECT acceptance FROM agent_chat_requests ORDER BY rowid DESC LIMIT 1').get().acceptance));
    return settings[AGENT_CREDENTIAL_ACQUIRE](...args);
  }};
  const editService = createAgentEditService({store, services});
  const gateway = async function* (args) {
    calls.push(args);
    if (options.gateway) {yield* options.gateway(args, calls.length); return;}
    if (args.readTools?.scope === context && args.readTools.phase === 'request') yield done(protocol);
    else {yield {type: 'delta', text: args.readTools ? 'TIMELINE_ANSWER_PENDING_REVIEW' : 'TYPED_ANSWER'}; yield {type: 'done', finishReason: 'stop'};}
  };
  const authorizations=createTestAuthorizations(store,settings);
  const make = () => createChatRuntime({store,authorizations, agentSettings: supplied, editService, gateway, selfPort: () => 4318, mode: 'simulated'});
  let runtime = make();
  t.after(async () => {runtime.close(); await settings.close(); store.close(); await rm(root, {recursive: true, force: true});});
  return {store, services, project, other, timeline, clipId, calls, acquired, editService, get runtime() {return runtime;},
    restart() {runtime.close(); runtime = make();},
    async input(mode = context) {
      await authorizeTestScope(authorizations,mode);
      const snap = await runtime.snapshot(project.id), configuration = snap.settings.configuration;
      const {available, ...capability} = mode === context ? snap.timelineEdit : snap.inspection;
      return {requestId: randomUUID(), instanceId: snap.instanceId, expectedSettingsRevision: snap.settings.revision,
        expectedConversationRevision: snap.revision, message: 'Move the selected clip to frame 90', consent: {destination: deriveAgentEndpoint(configuration),
          protocol, model: configuration.model, context: mode, ...(mode === context ? {projectId: project.id, ...capability, timelineId: timeline.id, clipId, expectedRevision: timeline.revision} : mode === 'project_inspection' ? {projectId: project.id, ...capability} : {})}};
    },
    finish(sent) {return until(() => {const run = runtime.get(project.id, sent.run.id, sent.instanceId).run; return run.status !== 'running' && run;});},
  };
}
for (const protocol of ['chat_completions', 'responses']) test(`${protocol}: exact selected timing consent is durable before outbound work and only review can apply`, async t => {
  const f = await fixture(t, protocol), input = await f.input(), snap = await f.runtime.snapshot(f.project.id);
  assert.deepEqual(snap.edit, editToolCapability(true)); assert.equal(snap.edit.catalogHash, EDIT_TOOL_CATALOG_HASH);
  const sent = await f.runtime.send(f.project.id, input), run = await f.finish(sent);
  assert.equal(run.status, 'completed'); assert.equal(f.calls.length, 2); assert.equal(f.acquired.length, 1);
  assert.equal(run.contextMode, context); assert.equal(run.provenance.category, 'project_selected_timeline_timing');
  const accepted = f.acquired[0], target = accepted.execution.target;
  assert.deepEqual(run.editTarget, agentTimelineMoveReviewTarget(target)); assert.equal(target.clip.assetId, f.timeline.clips[0].assetId);
  assert.deepEqual(accepted.execution.request.context, f.calls[0].messages);
  assert.equal(accepted.consent.timelineId, f.timeline.id); assert.equal(accepted.consent.clipId, f.clipId);
  const wire = accepted.execution.request.body;
  assert.match(wire, /SELECTED_SAVED_CLIP/); assert.doesNotMatch(wire, /PRIVATE_|SYNTHETIC_TEST_ONLY|assetId|sourceInFrame|relativePath|remainingTimelineEndFrame|subtitleEndFrame/);
  for (const id of [f.project.id, f.timeline.id, f.clipId, f.timeline.clips[0].assetId]) assert.equal(wire.includes(id), false);
  assert.deepEqual(JSON.parse(f.calls[0].messages.at(-1).content).saved.occupiedIntervals, [{startFrame: 300, endFrame: 330}]);
  assert.deepEqual(await f.services.call('timeline.get', {projectId: f.project.id}), f.timeline);
  const result = JSON.parse(run.activity[1].resultJson), proposal = f.runtime.editGet(f.project.id, result.proposalId).proposal;
  assert.equal(result.kind, 'untrusted_timeline_clip_move_proposal'); assert.equal(result.status, 'pending_review'); assert.equal(result.applied, false);
  assert.equal(proposal.status, 'pending'); assert.equal(proposal.runStatus, 'completed'); assert.deepEqual(proposal.patch, {startFrame: 90});
  const steps = f.store.db.prepare('SELECT data FROM agent_chat_steps WHERE runId=? ORDER BY position').all(run.id).map(x => JSON.parse(x.data));
  const finalBody = JSON.parse(steps[2].request.body); assert.deepEqual(finalBody.tools, []);
  if (protocol === 'responses') {assert.equal(finalBody.store, false); assert.equal(finalBody.previous_response_id, undefined); assert.equal(finalBody.input.at(-1).call_id, 'call_timeline_move'); assert.equal(finalBody.input.at(-2).id, 'fc_distinct_timeline');}
  else assert.equal(finalBody.messages.at(-1).tool_call_id, 'call_timeline_move');
  const approved = await f.runtime.editApprove(f.project.id, proposal.id, {instanceId: sent.instanceId, digest: proposal.digest});
  assert.equal(approved.proposal.status, 'applied');
  const moved = await f.services.call('timeline.get', {projectId: f.project.id});
  assert.deepEqual(moved.clips[0], {...f.timeline.clips[0], startFrame: 90}); assert.deepEqual(moved.clips.slice(1), f.timeline.clips.slice(1));
  f.restart(); assert.equal(f.runtime.lookup(f.project.id, input.requestId).run.assistantText, run.assistantText);
  assert.equal(f.calls.length, 2); assert.equal(f.acquired.length, 1);
  assert.equal(f.runtime.editGet(f.project.id, proposal.id).proposal.status, 'applied');
  await assert.rejects(async () => f.runtime.editApprove(f.project.id, proposal.id, {instanceId: sent.instanceId, digest: proposal.digest}), {code: 'AGENT_CHAT_SESSION_EXPIRED'});
});

test('timeline-derived turns are excluded from typed and inspection context; another move sees only typed history', async t => {
  const f = await fixture(t);
  await f.finish(await f.runtime.send(f.project.id, await f.input()));
  await f.finish(await f.runtime.send(f.project.id, await f.input('typed_chat_only')));
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).messages), /TIMELINE_ANSWER|SELECTED_SAVED_CLIP/);
  await f.finish(await f.runtime.send(f.project.id, await f.input('project_inspection')));
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).messages), /TIMELINE_ANSWER|SELECTED_SAVED_CLIP/);
  await f.finish(await f.runtime.send(f.project.id, await f.input()));
  assert.deepEqual(f.calls.at(-2).messages.filter(x => x.role === 'assistant').map(x => x.content), ['TYPED_ANSWER']);
});

test('foreign target, stale revision and every consent binding fail before acceptance or credentials', async t => {
  const f = await fixture(t), input = await f.input();
  for (const patch of [{clipId: randomUUID()}, {timelineId: randomUUID()}, {expectedRevision: 99}, {projectId: f.other.id},
    {catalogHash: '0'.repeat(64)}, {maxModelRequests: 3}, {maxToolCalls: 2}, {maxResultBytes: 8193}, {maxStartFrame: 18001}, {maxOccupiedIntervals: 100},
    {destination: 'https://different.example/v1/chat/completions'}, {model: 'different'}, {protocol: 'responses'}, {shotId: randomUUID()}, {patch: {startFrame: 90}}])
    await assert.rejects(f.runtime.send(f.project.id, {...input, consent: {...input.consent, ...patch}}));
  assert.equal(f.calls.length, 0); assert.equal(f.acquired.length, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM agent_chat_runs').get().n, 0);
});

for (const stopAt of ['intent', 'completed']) test(`Stop at move tool ${stopAt} cancels unapproved work and fences continuation`, async t => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, 'responses', {gateway: async function* (_args, number) {if (number === 1) {await gate; yield done('responses');} else yield {type: 'done', finishReason: 'stop'};}});
  const sent = await f.runtime.send(f.project.id, await f.input());
  f.runtime.subscribe(f.project.id, sent.run.id, sent.instanceId, 0, event => {
    if (event.run?.status === 'running' && event.run.activity.some(x => x.kind === 'tool' && x.status === stopAt)) f.runtime.stop(f.project.id, sent.run.id, {instanceId: sent.instanceId});
  });
  release(); const run = await f.finish(sent); assert.equal(run.status, 'stopped'); assert.equal(f.calls.length, 1);
  const proposals = f.runtime.editList(f.project.id, {view: 'all'}).proposals;
  assert.equal(proposals.length, stopAt === 'intent' ? 0 : 1); if (proposals.length) assert.equal(proposals[0].status, 'cancelled');
  assert.deepEqual(await f.services.call('timeline.get', {projectId: f.project.id}), f.timeline);
});

for (const variant of ['failed', 'stopped', 'interrupted']) test(`move final-answer ${variant} never enables review or repeats model work on restart`, async t => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, 'responses', {gateway: async function* (_args, number) {
    if (number === 1) yield done('responses'); else {await gate; if (variant === 'failed') throw Error('synthetic transport failure'); yield {type: 'done', finishReason: 'stop'};}
  }});
  const sent = await f.runtime.send(f.project.id, await f.input()); await until(() => f.calls.length === 2);
  if (variant === 'stopped') f.runtime.stop(f.project.id, sent.run.id, {instanceId: sent.instanceId});
  if (variant === 'interrupted') f.restart(); release();
  if (variant === 'failed') await f.finish(sent);
  const proposal = f.runtime.editList(f.project.id, {view: 'all'}).proposals[0]; assert.equal(proposal.status, 'cancelled');
  const snap = await f.runtime.snapshot(f.project.id);
  await assert.rejects(async () => f.runtime.editApprove(f.project.id, proposal.id, {instanceId: snap.instanceId, digest: proposal.digest}));
  f.restart(); await delay(10); assert.equal(f.calls.length, 2); assert.deepEqual(await f.services.call('timeline.get', {projectId: f.project.id}), f.timeline);
});

test('invalid, no-op, overlapping and authority-bearing model moves never create proposals', async t => {
  for (const [changes, name] of [[{startFrame: 0}], [{startFrame: 300}], [{startFrame: 17990}], [{startFrame: -1}], [{startFrame: 1.5}],
    [{startFrame: 90, clipId: randomUUID()}], [{startFrame: 90, requestId: randomUUID()}], [{startFrame: 90, trackId: randomUUID()}], [{startFrame: 90}, 'timeline.clip.update']]) {
    const f = await fixture(t, 'chat_completions', {gateway: async function* () {yield done('chat_completions', changes, name);}});
    const run = await f.finish(await f.runtime.send(f.project.id, await f.input()));
    assert.equal(run.status, 'failed'); assert.equal(f.calls.length, 1); assert.equal(f.runtime.editList(f.project.id).proposals.length, 0);
    assert.deepEqual(await f.services.call('timeline.get', {projectId: f.project.id}), f.timeline);
  }
});

test('Stop racing completed move preserves answer but cancels pending proposal; restart does not retry it', async t => {
  const f = await fixture(t), sent = await f.runtime.send(f.project.id, await f.input()), run = await f.finish(sent), result = JSON.parse(run.activity[1].resultJson);
  assert.equal(f.runtime.stop(f.project.id, run.id, {instanceId: sent.instanceId}).run.status, 'completed');
  assert.equal(f.runtime.editGet(f.project.id, result.proposalId).proposal.status, 'cancelled');
  f.restart(); assert.equal(f.calls.length, 2); assert.equal(f.runtime.lookup(f.project.id, sent.run.requestId).run.assistantText, run.assistantText);
});

for (const failure of ['foreign_source', 'invalid_timeline']) test(`saved ${failure} during model wait fails only that move, leaving typed chat usable`, async t => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, 'responses', {gateway: async function* (args) {
    if (args.readTools?.scope === context) {await gate; yield done('responses');} else yield {type: 'done', finishReason: 'stop'};
  }});
  const sent = await f.runtime.send(f.project.id, await f.input()); await until(() => f.calls.length === 1);
  if (failure === 'foreign_source') {
    const asset = f.store.get('assets', f.timeline.clips[0].assetId); f.store.put('assets', {...asset, projectId: f.other.id});
  } else f.store.put('timelines', {...f.timeline, width: 722});
  release(); const run = await f.finish(sent);
  assert.equal(run.status, 'failed'); assert.equal(run.error.code, failure === 'foreign_source' ? 'TIMELINE_SOURCE_UNAVAILABLE' : 'INVALID_TIMELINE_SNAPSHOT');
  assert.equal(f.calls.length, 1);
  const typed = await f.finish(await f.runtime.send(f.project.id, await f.input('typed_chat_only')));
  assert.equal(typed.status, 'completed'); assert.equal(f.calls.length, 2);
});
