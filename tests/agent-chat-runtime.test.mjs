import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.mjs';
import {deriveAgentEndpoint} from '@mioon/contracts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn, setTimeout as delay} from 'node:timers/promises';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.mjs';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.mjs';
import {createChatRuntime, CHAT_LIMITS, CHAT_SYSTEM_INSTRUCTION} from '../packages/business/src/agent/chat-runtime.mjs';

const SECRET = 'SYNTHETIC_CHAT_RUNTIME_KEY';
const persistence = () => ({load: async () => null, save: async () => {}});
async function fixture(t, gateway, settingsOverride) {
  const settings = await createAgentSettings({persistence: persistence()});
  const initial = await settings.get();
  await settings.put({expectedRevision: 0, configuration: initial.configuration, secret: {action: 'replace', storage: 'session', value: SECRET}});
  const projects = new Set(Array.from({length: 40}, (_, i) => `p${i + 1}`)), reads = [];
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-chat-runtime-')), store = openStore(root);
  for (const id of projects) store.put('projects', {id, name: 'PRIVATE_PROJECT_RECORD_DO_NOT_SEND'});
  const realGet = store.get;
  store.get = (table, id) => { reads.push([table, id]); assert.equal(table, 'projects'); return projects.has(id) ? realGet(table, id) : null; };
  const calls = [];
  const authorizations=createTestAuthorizations(store,settings);
  const runtime = createChatRuntime({store,authorizations,
    agentSettings: settingsOverride ? settingsOverride(settings) : settings, selfPort: () => 4318, mode: 'simulated',
    gateway: async function* (options) { calls.push(options); if (gateway) yield* gateway(options); else { yield {type: 'delta', text: 'Synthetic answer'}; yield {type: 'done', finishReason: 'stop'}; } }});
  t.after(async () => { runtime.close(); await settings.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  return {runtime, settings, calls, projects, reads, store, root,
    async input(project = 'p1', changes = {}) { await authorizeTestScope(authorizations); const snapshot = await runtime.snapshot(project); return {requestId: randomUUID(), instanceId: snapshot.instanceId,
      expectedSettingsRevision: snapshot.settings.revision, expectedConversationRevision: snapshot.revision, message: 'Typed test text',
      consent: {destination: deriveAgentEndpoint(snapshot.settings.configuration), protocol: snapshot.settings.configuration.protocol, model: snapshot.settings.configuration.model, context: 'typed_chat_only'}, ...changes}; }};
}
async function until(check) { for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await delay(2); } assert.fail('Synthetic work did not reach expected state'); }
async function finish(f, sent) { return until(() => { const result = f.runtime.get(sent.projectId, sent.run.id, sent.instanceId); return result.run.status !== 'running' && result; }); }
async function* held({signal}) { yield {type: 'delta', text: 'Partial'}; await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true})); yield {type: 'delta', text: 'LATE_MUST_NOT_APPEAR'}; yield {type: 'done', finishReason: 'stop'}; }

test('chat is project-pinned, pure typed context, SQLite-durable, and one gateway invocation per explicit send', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.snapshot('missing'), {code: 'AGENT_CHAT_NOT_FOUND'});
  const snapshot = await f.runtime.snapshot('p1');
  assert.equal(snapshot.scope, 'chat_and_project_inspection'); assert.equal(snapshot.persistence, 'local_database'); assert.equal(snapshot.mode, 'simulated');
  assert.equal(snapshot.settings.secret.configured, true); assert.equal(JSON.stringify(snapshot).includes(SECRET), false);
  const input = await f.input(); const sent = await f.runtime.send('p1', input); const complete = await finish(f, sent);
  assert.equal(complete.run.status, 'completed'); assert.equal(complete.revision, 2); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].apiKey, SECRET);
  assert.deepEqual(f.calls[0].messages, [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user', content: input.message}]);
  assert.equal(JSON.stringify(f.calls[0].messages).includes('PRIVATE_PROJECT'), false);
  assert.equal(JSON.stringify(complete).includes(SECRET), false);
  assert.throws(() => f.runtime.get('p2', sent.run.id, sent.instanceId), {code: 'AGENT_CHAT_NOT_FOUND'});
  assert.throws(() => f.runtime.stop('p2', sent.run.id, {instanceId: sent.instanceId}), {code: 'AGENT_CHAT_NOT_FOUND'});
  assert.throws(() => f.runtime.subscribe('p2', sent.run.id, sent.instanceId, 0, () => {}), {code: 'AGENT_CHAT_NOT_FOUND'});
});

test('stable request replay precedes stale revisions but follows project and instance checks; changed reuse fails', async t => {
  const f = await fixture(t); const input = await f.input();
  const results = await Promise.all(Array.from({length: 8}, () => f.runtime.send('p1', input)));
  assert.equal(new Set(results.map(result => result.run.id)).size, 1); assert.equal(results.filter(result => !result.replayed).length, 1);
  await finish(f, results[0]);
  const settings = await f.settings.get();
  await f.settings.put({expectedRevision: settings.revision, configuration: {...settings.configuration, model: 'changed-model'}, secret: {action: 'keep'}});
  const replay = await f.runtime.send('p1', input); assert.equal(replay.replayed, true); assert.equal(f.calls.length, 1);
  await assert.rejects(f.runtime.send('p1', {...input, message: 'Changed'}), {code: 'AGENT_CHAT_IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.runtime.send('p2', input), {code: 'AGENT_CHAT_IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.runtime.send('p1', {...input, instanceId: randomUUID()}), {code: 'AGENT_CHAT_SESSION_EXPIRED'});
  f.projects.delete('p1'); await assert.rejects(f.runtime.send('p1', input), {code: 'AGENT_CHAT_NOT_FOUND'});
});

test('stale conversation, settings, unreviewed consent, oversized or extended requests never call gateway', async t => {
  const f = await fixture(t), input = await f.input();
  for (const [patch, code] of [[{expectedConversationRevision: 10}, 'AGENT_CHAT_CONVERSATION_CONFLICT'], [{expectedSettingsRevision: 0}, 'AGENT_CHAT_SETTINGS_CONFLICT'],
    [{consent: {...input.consent, model: 'different'}}, 'AGENT_CHAT_CONSENT_REQUIRED'], [{consent: {...input.consent, destination: 'https://changed.example.com'}}, 'AGENT_CHAT_CONSENT_REQUIRED'],
    [{consent: {...input.consent, context: 'project'}}, 'AGENT_CHAT_VALIDATION'], [{message: '中'.repeat(3000)}, 'AGENT_CHAT_VALIDATION'], [{message: 'bad\u0000'}, 'AGENT_CHAT_VALIDATION'],
    [{tools: []}, 'AGENT_CHAT_VALIDATION'], [{headers: {Authorization: SECRET}}, 'AGENT_CHAT_VALIDATION'], [{message: ' '}, 'AGENT_CHAT_VALIDATION']]) {
    await assert.rejects(f.runtime.send('p1', {...input, ...patch}), {code});
  }
  assert.equal(f.calls.length, 0);
});

test('navigation/detachment changes no run, stop preserves partial output and ignores every late callback', async t => {
  const f = await fixture(t, held), sent = await f.runtime.send('p1', await f.input());
  await until(() => f.runtime.get('p1', sent.run.id, sent.instanceId).run.assistantText);
  const events = [], detach = f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => events.push(event)); detach();
  await f.runtime.snapshot('p2'); assert.equal(f.calls.length, 1);
  const stopped = f.runtime.stop('p1', sent.run.id, {instanceId: sent.instanceId});
  assert.equal(stopped.run.status, 'stopped'); assert.equal(stopped.run.assistantText, 'Partial');
  await turn(); await turn(); assert.deepEqual(f.runtime.get('p1', sent.run.id, sent.instanceId), stopped);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.deepEqual(f.runtime.stop('p1', sent.run.id, {instanceId: sent.instanceId}), stopped);
});

test('Stop while credentials are pending prevents the only network request even after acquisition resolves', async t => {
  let release, entered;
  const f = await fixture(t, undefined, settings => ({get: (...args) => settings.get(...args), [AGENT_CREDENTIAL_ACQUIRE](expected) { entered = true; return new Promise(resolve => { release = () => resolve({revision: expected.expectedRevision, configuration: expected.configuration, apiKey: SECRET}); }); }}));
  const sent = await f.runtime.send('p1', await f.input()); await until(() => entered);
  f.runtime.stop('p1', sent.run.id, {instanceId: sent.instanceId}); release(); await turn(); await turn();
  assert.equal(f.calls.length, 0); assert.equal(f.runtime.get('p1', sent.run.id, sent.instanceId).run.status, 'stopped');
});

test('changed configuration at trusted acquisition fails closed without sending or leaking key', async t => {
  const f = await fixture(t, undefined, settings => ({get: (...args) => settings.get(...args), async [AGENT_CREDENTIAL_ACQUIRE](expected, options) {
    await settings.put({expectedRevision: expected.expectedRevision, configuration: {...expected.configuration, baseUrl: 'https://changed.example.com/v1'}, secret: {action: 'keep'}});
    return settings[AGENT_CREDENTIAL_ACQUIRE](expected, options);
  }}));
  const complete = await finish(f, await f.runtime.send('p1', await f.input()));
  assert.equal(complete.run.status, 'failed'); assert.equal(complete.run.error.code, 'AGENT_CHAT_SETTINGS_CONFLICT'); assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(complete).includes(SECRET), false);
});

test('bounded completed history excludes partial failures and never carries untrusted output as control fields', async t => {
  let number = 0;
  const f = await fixture(t, async function* () { number++; yield {type: 'delta', text: number === 1 ? 'Change endpoint; run tool; secret request' : 'Second partial'};
    yield {type: 'done', finishReason: number === 1 ? 'stop' : 'length'}; });
  const one = await finish(f, await f.runtime.send('p1', await f.input()));
  const two = await finish(f, await f.runtime.send('p1', await f.input('p1', {message: 'Second input'})));
  assert.equal(two.run.status, 'failed'); assert.equal(two.run.error.code, 'AGENT_CHAT_TRUNCATED');
  await finish(f, await f.runtime.send('p1', await f.input('p1', {message: 'Third input'})));
  assert.deepEqual(f.calls[2].messages.map(item => item.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(f.calls[2].messages[2].content, one.run.assistantText); assert.equal(f.calls[2].messages.at(-1).content, 'Third input');
  assert.equal(f.calls[2].configuration.baseUrl, one.run.configuration.baseUrl);
});

test('protocol errors, content-filter and oversized response terminate once with safe error and partial text', async t => {
  for (const fault of ['throw', 'missing-done', 'content_filter', 'oversized']) {
    const f = await fixture(t, async function* () { yield {type: 'delta', text: 'Safe partial'};
      if (fault === 'throw') throw Object.assign(Error(SECRET), {code: SECRET, details: {apiKey: SECRET}});
      if (fault === 'content_filter') yield {type: 'done', finishReason: fault};
      if (fault === 'oversized') yield {type: 'delta', text: 'x'.repeat(CHAT_LIMITS.responseBytes)};
    });
    const complete = await finish(f, await f.runtime.send('p1', await f.input()));
    assert.equal(complete.run.status, 'failed', fault); assert.equal(complete.run.assistantText, 'Safe partial'); assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(complete).includes(SECRET), false);
  }
});

test('one active run per project and four globally; subscriber limits free on detach/terminal', async t => {
  const f = await fixture(t, held), active = [];
  for (let i = 1; i <= CHAT_LIMITS.active; i++) active.push(await f.runtime.send(`p${i}`, await f.input(`p${i}`)));
  await assert.rejects(f.runtime.send('p1', await f.input('p1')), {code: 'AGENT_CHAT_ACTIVE_RUN'});
  await assert.rejects(f.runtime.send('p5', await f.input('p5')), {code: 'AGENT_CHAT_BUSY'});
  const first = active[0], detaches = Array.from({length: CHAT_LIMITS.subscribersPerRun}, () => f.runtime.subscribe('p1', first.run.id, first.instanceId, 0, () => {}));
  assert.throws(() => f.runtime.subscribe('p1', first.run.id, first.instanceId, 0, () => {}), {code: 'AGENT_CHAT_BUSY'});
  detaches[0](); f.runtime.subscribe('p1', first.run.id, first.instanceId, 0, () => {})();
  for (const sent of active) f.runtime.stop(sent.projectId, sent.run.id, {instanceId: sent.instanceId});
  const next = await f.runtime.send('p5', await f.input('p5')); assert.equal(next.run.status, 'running');
});

test('bounded event replay resets stale/ahead cursor by snapshot and never restarts inference', async t => {
  const f = await fixture(t, async function* () { for (let i = 0; i < 300; i++) yield {type: 'delta', text: `${i},`}; yield {type: 'done', finishReason: 'stop'}; });
  const complete = await finish(f, await f.runtime.send('p1', await f.input()));
  for (const cursor of [complete.run.lastEventId + 1, complete.run.lastEventId]) {
    const events = []; f.runtime.subscribe('p1', complete.run.id, complete.instanceId, cursor, event => events.push(event));
    assert.equal(events.length, 1); assert.equal(events[0].type, 'snapshot'); assert.equal(events[0].run.status, 'completed');
  }
  const replay = []; f.runtime.subscribe('p1', complete.run.id, complete.instanceId, complete.run.lastEventId - 2, event => replay.push(event));
  assert.deepEqual(replay.map(event => event.id), [complete.run.lastEventId - 1, complete.run.lastEventId]); assert.equal(f.calls.length, 1);
});

test('recent history is bounded without evicting original requests or enabling duplicate inference', async t => {
  const f = await fixture(t), input = await f.input(); await finish(f, await f.runtime.send('p1', input));
  for (let i = 0; i < CHAT_LIMITS.runsPerProject; i++) await finish(f, await f.runtime.send('p1', await f.input()));
  assert.equal((await f.runtime.snapshot('p1')).runs.length, CHAT_LIMITS.runsPerProject);
  assert.equal((await f.runtime.send('p1', input)).replayed, true); assert.equal(f.calls.length, CHAT_LIMITS.runsPerProject + 1);
  assert.equal(f.runtime.lookup('p1', input.requestId).run.requestId, input.requestId);
  const snapshot = await f.runtime.snapshot('p1');
  assert.ok(snapshot.historyCursor);
  const older = f.runtime.history('p1', {before: snapshot.historyCursor});
  assert.equal(older.runs.length, 1); assert.equal(older.runs[0].requestId, input.requestId); assert.equal(older.historyCursor, null);
});

test('shutdown interrupts streaming, closes subscribers before returning, makes late callbacks inert and invalidates new sends', async t => {
  const f = await fixture(t, held), input = await f.input(), sent = await f.runtime.send('p1', input);
  await until(() => f.calls.length); const events = [];
  f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => events.push(event));
  f.runtime.close(); assert.equal(events.at(-1).type, 'terminal'); assert.equal(events.at(-1).run.status, 'interrupted');
  const count = events.length; await turn(); assert.equal(events.length, count); assert.equal(f.calls[0].signal.aborted, true);
  await assert.rejects(f.runtime.send('p1', input), {code: 'AGENT_CHAT_CLOSED'});
});

test('backend-instance restart never recreates an old send', async t => {
  const old = await fixture(t), input = await old.input(); await finish(old, await old.runtime.send('p1', input)); old.runtime.close();
  const fresh = await fixture(t); assert.equal((await fresh.runtime.snapshot('p1')).runs.length, 0);
  await assert.rejects(fresh.runtime.send('p1', input), {code: 'AGENT_CHAT_SESSION_EXPIRED'}); assert.equal(fresh.calls.length, 0);
});

test('run deadline aborts stalled inference, preserves partial output and admits no automatic retry', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = await fixture(t, held), sent = await f.runtime.send('p1', await f.input());
  await until(() => f.calls.length);
  t.mock.timers.tick(CHAT_LIMITS.runMs);
  const ended = f.runtime.get('p1', sent.run.id, sent.instanceId);
  assert.equal(ended.run.status, 'failed'); assert.equal(ended.run.error.code, 'AGENT_CHAT_TIMEOUT'); assert.equal(ended.run.assistantText, 'Partial');
  assert.equal(f.calls[0].signal.aborted, true); await turn(); assert.equal(f.calls.length, 1); assert.deepEqual(f.runtime.get('p1', sent.run.id, sent.instanceId), ended);
});

test('explicit protocol and complete endpoint bind consent; no omitted/inferred protocol is accepted', async t => {
  const f = await fixture(t), original = await f.input();
  for (const consent of [
    {...original.consent, protocol: 'responses'},
    {...original.consent, destination: original.consent.destination.replace('/chat/completions', '/responses')},
    {...original.consent, destination: (await f.settings.get()).configuration.baseUrl},
  ]) await assert.rejects(f.runtime.send('p1', {...original, consent}), {code: 'AGENT_CHAT_CONSENT_REQUIRED'});
  const {protocol, ...missing} = original.consent;
  await assert.rejects(f.runtime.send('p1', {...original, consent: missing}), {code: 'AGENT_CHAT_VALIDATION'});
  assert.equal(f.calls.length, 0);
  const saved = await f.settings.get();
  await f.settings.put({expectedRevision: saved.revision, configuration: {...saved.configuration, protocol: 'responses'}, secret: {action: 'keep'}});
  await assert.rejects(f.runtime.send('p1', original), {code: 'AGENT_CHAT_SETTINGS_CONFLICT'});
  const input = await f.input(), run = await finish(f, await f.runtime.send('p1', input));
  assert.equal(run.run.configuration.protocol, 'responses');
  assert.equal(input.consent.destination, saved.configuration.baseUrl + '/responses');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].apiKey, SECRET);
});

test('protocol-only race at credential acquisition fails closed; no alternative adapter receives key', async t => {
  const f = await fixture(t, undefined, settings => ({get: (...args) => settings.get(...args), async [AGENT_CREDENTIAL_ACQUIRE](expected, options) {
    await settings.put({expectedRevision: expected.expectedRevision, configuration: {...expected.configuration, protocol: 'responses'}, secret: {action: 'keep'}});
    return settings[AGENT_CREDENTIAL_ACQUIRE](expected, options);
  }}));
  const complete = await finish(f, await f.runtime.send('p1', await f.input()));
  assert.equal(complete.run.status, 'failed'); assert.equal(complete.run.error.code, 'AGENT_CHAT_SETTINGS_CONFLICT'); assert.equal(f.calls.length, 0);
});

test('accepted Responses run remains protocol-pinned after settings switch and can still stop', async t => {
  const f = await fixture(t, held), config = await f.settings.get();
  await f.settings.put({expectedRevision: config.revision, configuration: {...config.configuration, protocol: 'responses'}, secret: {action: 'keep'}});
  const input = await f.input(), sent = await f.runtime.send('p1', input);
  await until(() => f.calls.length === 1);
  const newer = await f.settings.get();
  await f.settings.put({expectedRevision: newer.revision, configuration: {...newer.configuration, protocol: 'chat_completions'}, secret: {action: 'keep'}});
  assert.equal(f.runtime.get('p1', sent.run.id, sent.instanceId).run.configuration.protocol, 'responses');
  const stopped = f.runtime.stop('p1', sent.run.id, {instanceId: sent.instanceId});
  assert.equal(stopped.run.status, 'stopped'); assert.equal(f.calls[0].configuration.protocol, 'responses');
  assert.equal((await f.runtime.send('p1', input)).replayed, true); assert.equal(f.calls.length, 1);
});

test('unsupported protocol profile fails before any credential acquisition or gateway call', async t => {
  let acquired = 0;
  const f = await fixture(t, undefined, settings => ({get: (...args) => settings.get(...args), [AGENT_CREDENTIAL_ACQUIRE](...args) { acquired++; return settings[AGENT_CREDENTIAL_ACQUIRE](...args); }}));
  const config = await f.settings.get();
  await f.settings.put({expectedRevision: config.revision, configuration: {...config.configuration, protocol: 'responses', model: 'not-a-supported-openai-profile'}, secret: {action: 'keep'}});
  const result = await finish(f, await f.runtime.send('p1', await f.input()));
  assert.equal(result.run.status, 'failed'); assert.equal(acquired, 0); assert.equal(f.calls.length, 0);
});
