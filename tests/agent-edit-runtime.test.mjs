import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openStore, createServices} from '@mioon/business';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.mjs';
import {createChatRuntime} from '../packages/business/src/agent/chat-runtime.mjs';
import {createAgentEditService} from '../packages/business/src/agent/edit-proposals.mjs';
import {parseEditToolArguments} from '../packages/business/src/agent/edit-tool-policy.mjs';

function done(protocol, changes = {title: 'REVIEWED_TITLE', prompt: null}, name = 'mioon_propose_shot_update') {
  const argumentsJson = JSON.stringify(changes), id = 'call_edit', itemId = 'fc_distinct_item';
  const toolCall = {id, name, arguments: changes, argumentsJson, ...(protocol === 'responses' ? {itemId} : {})};
  return {type: 'done', finishReason: 'tool_calls', toolCall, providerOutput: protocol === 'responses' ?
    [{id: itemId, type: 'function_call', call_id: id, name, arguments: argumentsJson, status: 'completed'}] :
    {role: 'assistant', content: null, tool_calls: [{id, type: 'function', function: {name, arguments: argumentsJson}}]}};
}
async function until(check) { for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await delay(2); } assert.fail('Synthetic run did not settle'); }
async function fixture(t, protocol = 'chat_completions', options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-edit-runtime-')), store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'PROJECT_NOT_DISCLOSED'});
  const other = await services.call('project.create', {name: 'FOREIGN_PROJECT'});
  const shot = await services.call('shot.create', {projectId: project.id, title: 'SAVED_TITLE', prompt: 'SAVED_PROMPT_ONLY'});
  const foreign = await services.call('shot.create', {projectId: other.id, title: 'FOREIGN_SHOT', prompt: 'SECRET_FOREIGN'});
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const initial = await settings.get();
  await settings.put({expectedRevision: 0, configuration: {...initial.configuration, protocol}, secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_TEST_ONLY'}});
  const calls = [], acquired = [];
  const supplied = {get: (...args) => settings.get(...args), [AGENT_CREDENTIAL_ACQUIRE](...args) {
    const row = store.db.prepare('SELECT acceptance FROM agent_chat_requests ORDER BY rowid DESC LIMIT 1').get();
    acquired.push(JSON.parse(row.acceptance));
    return settings[AGENT_CREDENTIAL_ACQUIRE](...args);
  }};
  const editService = createAgentEditService({store, services});
  const gateway = async function* (args) {
    calls.push(args);
    if (options.gateway) { yield* options.gateway(args, calls.length); return; }
    if (args.readTools?.scope === 'selected_shot_edit' && args.readTools.phase === 'request') yield done(protocol);
    else {yield {type: 'delta', text: args.readTools ? 'EDIT_ANSWER_PENDING_REVIEW_NOT_APPLIED' : 'TYPED_ANSWER'}; yield {type: 'done', finishReason: 'stop'};}
  };
  const authorizations=createTestAuthorizations(store,settings);
  const make = () => createChatRuntime({store,authorizations, agentSettings: supplied, editService, gateway, selfPort: () => 4318, mode: 'simulated'});
  let runtime = make();
  t.after(async () => {runtime.close(); await settings.close(); store.close(); await rm(root, {recursive: true, force: true});});
  return {store, services, project, other, shot, foreign, calls, acquired, editService, get runtime() {return runtime;},
    restart() {runtime.close(); runtime = make();},
    async input(context = 'selected_shot_edit') {
      await authorizeTestScope(authorizations,context);
      const snap = await runtime.snapshot(project.id), configuration = snap.settings.configuration, {available, ...capability} = snap.edit;
      const {available: _available, ...inspection} = snap.inspection;
      return {requestId: randomUUID(), instanceId: snap.instanceId, expectedSettingsRevision: snap.settings.revision,
        expectedConversationRevision: snap.revision, message: 'Suggest a clearer title', consent: {destination: deriveAgentEndpoint(configuration),
          protocol, model: configuration.model, context, ...(context === 'selected_shot_edit' ? {projectId: project.id, ...capability, shotId: shot.id, expectedRevision: shot.revision} : context === 'project_inspection' ? {projectId: project.id, ...inspection} : {})}};
    },
    finish(sent) {return until(() => {const run = runtime.get(project.id, sent.run.id, sent.instanceId).run; return run.status !== 'running' && run;});},
  };
}
for (const protocol of ['chat_completions', 'responses']) test(`${protocol}: immutable selected target and exact first body are durable before credentials, proposal does not apply until review`, async t => {
  const f = await fixture(t, protocol), original = f.store.get('shots', f.shot.id), input = await f.input();
  const sent = await f.runtime.send(f.project.id, input), run = await f.finish(sent);
  assert.equal(run.status, 'completed'); assert.equal(f.calls.length, 2); assert.equal(f.acquired.length, 1);
  assert.equal(run.contextMode, 'selected_shot_edit'); assert.equal(run.editTarget.shotId, f.shot.id);
  assert.deepEqual(f.acquired[0].execution.target, run.editTarget);
  assert.deepEqual(f.acquired[0].execution.request.context, f.calls[0].messages);
  assert.match(f.acquired[0].execution.request.body, /SAVED_PROMPT_ONLY/);
  assert.doesNotMatch(f.acquired[0].execution.request.body, /FOREIGN|PROJECT_NOT_DISCLOSED|SYNTHETIC_TEST_ONLY/);
  assert.ok(!f.acquired[0].execution.request.body.includes(f.shot.id));
  const first = JSON.parse(f.acquired[0].execution.request.body); assert.equal(first.tools.length, 1);
  assert.deepEqual(f.store.get('shots', f.shot.id), original);
  const result = JSON.parse(run.activity[1].resultJson);
  assert.equal(result.status, 'pending_review'); assert.equal(result.applied, false);
  const proposal = f.runtime.editGet(f.project.id, result.proposalId).proposal;
  assert.equal(proposal.status, 'pending'); assert.equal(proposal.runStatus, 'completed');
  const steps = f.store.db.prepare('SELECT data FROM agent_chat_steps WHERE runId=? ORDER BY position').all(run.id).map(x => JSON.parse(x.data));
  const finalBody = JSON.parse(steps[2].request.body); assert.deepEqual(finalBody.tools, []);
  if (protocol === 'responses') {assert.equal(finalBody.input.at(-1).call_id, 'call_edit'); assert.equal(finalBody.input.at(-2).id, 'fc_distinct_item');}
  else {assert.equal(finalBody.messages.at(-1).tool_call_id, 'call_edit'); assert.equal(finalBody.messages.at(-2).tool_calls[0].id, 'call_edit');}
  const approved = await f.runtime.editApprove(f.project.id, proposal.id, {instanceId: sent.instanceId, digest: proposal.digest});
  assert.equal(approved.proposal.status, 'applied'); assert.equal(f.store.get('shots', f.shot.id).title, 'REVIEWED_TITLE');
  assert.equal(f.store.get('shots', f.shot.id).revision, f.shot.revision + 1);
  f.restart(); assert.equal(f.runtime.lookup(f.project.id, input.requestId).run.assistantText, run.assistantText);
  assert.equal(f.calls.length, 2); assert.equal(f.acquired.length, 1);
  assert.equal(f.runtime.editGet(f.project.id, proposal.id).proposal.status, 'applied');
  await assert.rejects(async () => f.runtime.editApprove(f.project.id, proposal.id, {instanceId: sent.instanceId, digest: proposal.digest}), {code: 'AGENT_CHAT_SESSION_EXPIRED'});
});

test('edit responses and full saved text never enter typed or inspection context; edit receives no earlier inspection answer', async t => {
  const f = await fixture(t);
  await f.finish(await f.runtime.send(f.project.id, await f.input()));
  await f.finish(await f.runtime.send(f.project.id, await f.input('typed_chat_only')));
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).messages), /EDIT_ANSWER|SAVED_PROMPT/);
  await f.finish(await f.runtime.send(f.project.id, await f.input('project_inspection')));
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).messages), /EDIT_ANSWER|SAVED_PROMPT/);
  await f.finish(await f.runtime.send(f.project.id, await f.input()));
  const latestFirst = f.calls.at(-2);
  assert.equal(latestFirst.messages.filter(x => x.role === 'assistant').length, 1);
  assert.equal(latestFirst.messages.find(x => x.role === 'assistant').content, 'TYPED_ANSWER');
});

test('foreign, missing and stale selected targets or changed consent fail before credentials and acceptance', async t => {
  const f = await fixture(t), input = await f.input();
  for (const patch of [{shotId: f.foreign.id}, {shotId: randomUUID()}, {expectedRevision: 99}, {projectId: f.other.id},
    {catalogHash: '0'.repeat(64)}, {maxTitleBytes: 601}, {maxModelRequests: 3}]) {
    await assert.rejects(f.runtime.send(f.project.id, {...input, consent: {...input.consent, ...patch}}));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.acquired.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM agent_chat_runs').get().n, 0);
  await assert.rejects(f.runtime.send(f.project.id, {...await f.input('typed_chat_only'), consent: {...input.consent, context: 'typed_chat_only'}}), {code: 'AGENT_CHAT_VALIDATION'});
});

for (const stopAt of ['intent', 'completed']) test(`Stop at tool ${stopAt} cancels pending proposal atomically and fences continuation`, async t => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, 'responses', {gateway: async function* (_args, number) { if (number === 1) {await gate; yield done('responses');} else {yield {type: 'done', finishReason: 'stop'};} }});
  const sent = await f.runtime.send(f.project.id, await f.input());
  f.runtime.subscribe(f.project.id, sent.run.id, sent.instanceId, 0, event => {
    if (event.run?.status === 'running' && event.run.activity.some(x => x.kind === 'tool' && x.status === stopAt)) f.runtime.stop(f.project.id, sent.run.id, {instanceId: sent.instanceId});
  });
  release(); const run = await f.finish(sent); assert.equal(run.status, 'stopped'); assert.equal(f.calls.length, 1);
  const rows = f.runtime.editList(f.project.id, {view: 'all'}).proposals;
  assert.equal(rows.length, stopAt === 'intent' ? 0 : 1);
  if (rows.length) {assert.equal(rows[0].status, 'cancelled'); await assert.rejects(async () => f.runtime.editApprove(f.project.id, rows[0].id, {instanceId: sent.instanceId, digest: rows[0].digest}));}
  assert.equal(f.store.get('shots', f.shot.id).title, 'SAVED_TITLE');
});

for (const variant of ['failed', 'interrupted']) test(`${variant} final model cannot leave an approvable proposal or restart model calls`, async t => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, 'chat_completions', {gateway: async function* (_args, number) {
    if (number === 1) yield done('chat_completions'); else {if (variant === 'interrupted') await gate; else throw new Error('synthetic provider failure'); yield {type: 'done', finishReason: 'stop'};}
  }});
  const sent = await f.runtime.send(f.project.id, await f.input());
  if (variant === 'interrupted') {await until(() => f.calls.length === 2); f.restart(); release();}
  else await f.finish(sent);
  const rows = f.runtime.editList(f.project.id, {view: 'all'}).proposals;
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'cancelled'); assert.equal(rows[0].runStatus, variant);
  const instanceId = (await f.runtime.snapshot(f.project.id)).instanceId;
  await assert.rejects(async () => f.runtime.editApprove(f.project.id, rows[0].id, {instanceId, digest: rows[0].digest}));
  await delay(10); assert.equal(f.calls.length, 2); assert.equal(f.store.get('shots', f.shot.id).revision, f.shot.revision);
});

test('no-op, both-null, invalid title, unknown function and model authority cannot create proposals', async t => {
  for (const [changes, name] of [[{title: 'SAVED_TITLE', prompt: null}], [{title: null, prompt: null}], [{title: '', prompt: null}],
    [{title: 'x', prompt: null, shotId: randomUUID()}], [{title: 'x', prompt: null}, 'shot.update'], [{title: null, prompt: 'x'.repeat(5001)}]]) {
    const f = await fixture(t, 'chat_completions', {gateway: async function* (args) {if (args.readTools) yield done('chat_completions', changes, name); else yield {type: 'done', finishReason: 'stop'};}});
    const run = await f.finish(await f.runtime.send(f.project.id, await f.input()));
    assert.equal(run.status, 'failed'); assert.equal(f.calls.length, 1);
    assert.equal(f.runtime.editList(f.project.id).proposals.length, 0); assert.equal(f.store.get('shots', f.shot.id).title, 'SAVED_TITLE');
    const typed = await f.finish(await f.runtime.send(f.project.id, await f.input('typed_chat_only')));
    assert.equal(typed.status, 'completed');
  }
  for (const json of ['{"title":"a","title":"b","prompt":null}', '{"title":"a","ti\\u0074le":"b","prompt":null}'])
    assert.throws(() => parseEditToolArguments('mioon_propose_shot_update', json), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
});

test('Stop racing just after final completion still cancels an unapproved proposal and preserves original answer', async t => {
  const f = await fixture(t), sent = await f.runtime.send(f.project.id, await f.input()), run = await f.finish(sent);
  const result = JSON.parse(run.activity[1].resultJson);
  const stopped = f.runtime.stop(f.project.id, run.id, {instanceId: sent.instanceId});
  assert.equal(stopped.run.status, 'completed'); assert.equal(stopped.run.assistantText, run.assistantText);
  assert.equal(f.runtime.editGet(f.project.id, result.proposalId).proposal.status, 'cancelled');
  const approval = await f.runtime.editApprove(f.project.id, result.proposalId, {instanceId: sent.instanceId, digest: result.digest});
  assert.equal(approval.proposal.status, 'cancelled'); assert.equal(f.store.get('shots', f.shot.id).revision, f.shot.revision);
});

test('full maximum saved prompt is disclosed without excerpts only in selected edit mode; empty proposed prompt clears on approval', async t => {
  const f = await fixture(t, 'responses', {gateway: async function* (args) {
    if (args.readTools?.phase === 'request') yield done('responses', {title: null, prompt: ''});
    else {yield {type: 'done', finishReason: 'stop'};}
  }});
  const prompt = '界'.repeat(5000);
  const changed = await f.services.call('shot.update', {shotId: f.shot.id, expectedRevision: f.shot.revision, patch: {prompt}});
  const input = await f.input(); input.consent.expectedRevision = changed.revision;
  const sent = await f.runtime.send(f.project.id, input), run = await f.finish(sent);
  assert.equal(run.status, 'completed');
  assert.equal(JSON.parse(f.calls[0].messages.at(-1).content).saved.prompt, prompt);
  const result = JSON.parse(run.activity[1].resultJson);
  const applied = await f.runtime.editApprove(f.project.id, result.proposalId, {instanceId: sent.instanceId, digest: result.digest});
  assert.equal(applied.proposal.status, 'applied'); assert.equal(f.store.get('shots', f.shot.id).prompt, '');
  assert.equal(f.store.get('shots', f.shot.id).title, 'SAVED_TITLE');
});

test('malformed or oversized saved target cannot reach accepted context or credentials', async t => {
  const f = await fixture(t);
  for (const patch of [{title: ''}, {title: 'x'.repeat(151)}, {prompt: '界'.repeat(5001)}, {prompt: 'unsafe\u0000saved'}]) {
    f.store.put('shots', {...f.shot, ...patch});
    await assert.rejects(f.runtime.send(f.project.id, await f.input()));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.acquired.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM agent_chat_runs').get().n, 0);
});

test('saved shot changes during model wait cannot retarget or rebase the accepted proposal', async t => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, 'chat_completions', {gateway: async function* (_args, number) {
    if (number === 1) {await gate; yield done('chat_completions');} else yield {type: 'done', finishReason: 'stop'};
  }});
  const sent = await f.runtime.send(f.project.id, await f.input());
  await until(() => f.calls.length === 1);
  await f.services.call('shot.update', {shotId: f.shot.id, expectedRevision: f.shot.revision, patch: {title: 'NEW_USER_TITLE'}});
  release(); const run = await f.finish(sent);
  assert.equal(run.editTarget.title, 'SAVED_TITLE'); assert.equal(run.editTarget.expectedRevision, f.shot.revision);
  const result = JSON.parse(run.activity[1].resultJson);
  const approved = await f.runtime.editApprove(f.project.id, result.proposalId, {instanceId: sent.instanceId, digest: result.digest});
  assert.equal(approved.proposal.status, 'failed'); assert.equal(approved.proposal.outcome.code, 'REVISION_CONFLICT');
  assert.equal(f.store.get('shots', f.shot.id).title, 'NEW_USER_TITLE'); assert.equal(f.store.get('shots', f.foreign.id).title, 'FOREIGN_SHOT');
});
