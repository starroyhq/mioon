import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {createChatJournal, CHAT_JOURNAL_LIMITS} from '../packages/business/src/agent/chat-journal.ts';
import {createChatRuntime, CHAT_SYSTEM_INSTRUCTION, CHAT_LIMITS} from '../packages/business/src/agent/chat-runtime.ts';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.ts';

const SECRET = 'SYNTHETIC_JOURNAL_KEY_DO_NOT_PERSIST';
const until = async check => { for (let n = 0; n < 300; n++) { const value = check(); if (value) return value; await delay(2); } assert.fail('Bounded synthetic condition was not reached'); };
async function fixture(t, {gateway, journalLimits, settingsWrapper} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-chat-journal-'));
  let store = openStore(root), runtime, calls = 0, acquisitions = 0, closed = false;
  store.put('projects', {id: 'p1', name: 'PROJECT_PAYLOAD_EXCLUDED'}); store.put('projects', {id: 'p2'});
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const initial = await settings.get();
  await settings.put({expectedRevision: 0, configuration: initial.configuration, secret: {action: 'replace', storage: 'session', value: SECRET}});
  const wrapped = {get: (...args) => settings.get(...args), [AGENT_CREDENTIAL_ACQUIRE](...args) { acquisitions++; return settings[AGENT_CREDENTIAL_ACQUIRE](...args); }};
  const authorizations=createTestAuthorizations(()=>store,settings);
  const start = () => createChatRuntime({store,authorizations, agentSettings: settingsWrapper ? settingsWrapper(wrapped) : wrapped, selfPort: () => 4318,
    ...(journalLimits ? {journalLimits} : {}), gateway: async function* (options) { calls++; if (gateway) yield* gateway(options); else { yield {type: 'delta', text: 'Saved response'}; yield {type: 'done', finishReason: 'stop'}; } }});
  runtime = start();
  t.after(async () => { runtime.close(); if (!closed) store.close(); await settings.close(); rmSync(root, {recursive: true, force: true}); });
  const f = {root, settings, get store() { return store; }, get runtime() { return runtime; }, get calls() { return calls; }, get acquisitions() { return acquisitions; },
    restart() { runtime.close(); store.close(); store = openStore(root); runtime = start(); },
    closeStore() { runtime.close(); store.close(); closed = true; },
    async input(projectId = 'p1', overrides = {}) { await authorizeTestScope(authorizations); const snapshot = await runtime.snapshot(projectId); return {requestId: randomUUID(), instanceId: snapshot.instanceId,
      expectedSettingsRevision: snapshot.settings.revision, expectedConversationRevision: snapshot.revision, message: 'Typed only',
      consent: {destination: deriveAgentEndpoint(snapshot.settings.configuration), protocol: snapshot.settings.configuration.protocol, model: snapshot.settings.configuration.model, context: 'typed_chat_only'}, ...overrides}; },
    async finish(sent) { return until(() => { const result = runtime.get(sent.projectId, sent.run.id, sent.instanceId); return result.run.status !== 'running' && result; }); },
  };
  return f;
}
function acceptDirect(store, input, configuration, projectId = 'p1') {
  const journal = createChatJournal({store});
  const messages = [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user', content: input.message}];
  return {journal, accepted: journal.accept({projectId, requestId: input.requestId, fingerprint: 'synthetic-fingerprint', instanceId: input.instanceId,
    configuration, messages, consent: input.consent, input}), messages};
}

test('empty snapshot/history is zero-write; stable thread UUID materializes only at accepted send', async t => {
  const f = await fixture(t), before = f.store.db.prepare('SELECT total_changes() n').get().n;
  const first = await f.runtime.snapshot('p1'), page = f.runtime.history('p1');
  assert.equal(first.threadId, page.threadId); assert.match(first.threadId, /^[a-f0-9-]{36}$/);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, before);
  f.restart(); const next = await f.runtime.snapshot('p1');
  assert.equal(first.threadId, next.threadId); assert.notEqual(first.instanceId, next.instanceId);
  const sent = await f.runtime.send('p1', await f.input()); await f.finish(sent);
  assert.equal(sent.threadId, first.threadId); assert.equal(sent.run.threadId, first.threadId);
  assert.equal(f.store.db.prepare('SELECT id FROM agent_chat_threads WHERE projectId=?').get('p1').id, first.threadId);
});

test('accepted context/config/consent and initial event commit before acquisition or acknowledgement; dispatch precedes gateway', async t => {
  let entered = false, release, f;
  f = await fixture(t, {settingsWrapper: settings => ({get: settings.get, [AGENT_CREDENTIAL_ACQUIRE](expected, options) {
    entered = true;
    const accepted = f.store.db.prepare('SELECT acceptance FROM agent_chat_requests').get();
    const run = JSON.parse(f.store.db.prepare('SELECT data FROM agent_chat_runs').get().data);
    assert.ok(accepted); assert.equal(run.modelRequestState, 'not_started');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_chat_events').get().n, 1);
    return new Promise(resolve => { release = async () => resolve(await settings[AGENT_CREDENTIAL_ACQUIRE](expected, options)); });
  }}), gateway: async function* (options) {
    const accepted = JSON.parse(f.store.db.prepare('SELECT acceptance FROM agent_chat_requests').get().acceptance);
    const persisted = JSON.parse(f.store.db.prepare('SELECT data FROM agent_chat_runs').get().data);
    assert.equal(persisted.modelRequestState, 'dispatch_started'); assert.ok(persisted.modelRequestStartedAt);
    assert.deepEqual(options.messages, accepted.messages); assert.deepEqual(options.configuration, accepted.configuration);
    yield {type: 'delta', text: 'durable'}; yield {type: 'done', finishReason: 'stop'};
  }});
  const input = await f.input(), sent = await f.runtime.send('p1', input);
  await until(() => entered); assert.equal(f.calls, 0);
  const acceptance = JSON.parse(f.store.db.prepare('SELECT acceptance FROM agent_chat_requests WHERE requestId=?').get(input.requestId).acceptance);
  assert.deepEqual(acceptance.consent, input.consent); assert.deepEqual(acceptance.messages, [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user', content: input.message}]);
  assert.equal(acceptance.instanceId, input.instanceId); await release();
  assert.equal((await f.finish(sent)).run.status, 'completed');
  assert.equal(readFileSync(path.join(f.root, 'workbench.sqlite')).includes(Buffer.from(SECRET)), false);
  const logical = ['agent_chat_requests', 'agent_chat_runs', 'agent_chat_events'].map(table => JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all())).join('');
  assert.equal(logical.includes(SECRET), false); assert.equal(logical.includes('PROJECT_PAYLOAD_EXCLUDED'), false);
  assert.throws(() => f.store.db.prepare('UPDATE agent_chat_requests SET acceptance=?').run('{}'), /immutable/);
  assert.throws(() => f.store.db.prepare('DELETE FROM agent_chat_requests').run(), /retained/);
  assert.throws(() => f.store.db.prepare("UPDATE agent_chat_runs SET data=json_set(data,'$.configuration.model','changed')").run(), /immutable/);
  assert.throws(() => f.store.db.prepare("UPDATE agent_chat_runs SET data=json_set(data,'$.userText','changed')").run(), /immutable/);
  assert.throws(() => f.store.db.prepare('UPDATE agent_chat_events SET data=?').run('{}'), /immutable/);
});

test('completed and interrupted runs survive real database reopen; lookup is scoped, read-only and independent of settings', async t => {
  const f = await fixture(t), input = await f.input(), completed = await f.finish(await f.runtime.send('p1', input));
  f.restart(); const before = f.store.db.prepare('SELECT total_changes() n').get().n;
  const found = f.runtime.lookup('p1', input.requestId);
  assert.deepEqual(found.run, completed.run); assert.notEqual(found.instanceId, completed.instanceId); assert.equal(found.threadId, completed.threadId);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, before); assert.equal(f.calls, 1); assert.equal(f.acquisitions, 1);
  assert.throws(() => f.runtime.lookup('p2', input.requestId), {code: 'AGENT_CHAT_NOT_FOUND'});
  assert.throws(() => f.runtime.lookup('missing', input.requestId), {code: 'AGENT_CHAT_NOT_FOUND'});
  await assert.rejects(f.runtime.send('p1', input), {code: 'AGENT_CHAT_SESSION_EXPIRED'});
  const fresh = await f.input(); await assert.rejects(f.runtime.send('p1', {...input, instanceId: fresh.instanceId}), {code: 'AGENT_CHAT_IDEMPOTENCY_CONFLICT'});
  assert.equal(f.calls, 1);
});

test('startup recovers pre-dispatch and dispatch-started records without any acquisition or inference', async t => {
  const f = await fixture(t), input = await f.input(), configuration = (await f.settings.get()).configuration;
  f.runtime.close();
  const first = acceptDirect(f.store, input, configuration);
  const secondInput = {...input, requestId: randomUUID()}, second = acceptDirect(f.store, secondInput, configuration, 'p2');
  second.journal.dispatch(second.accepted.run.id); second.journal.append(second.accepted.run.id, 'Committed prefix');
  f.restart();
  const before = f.runtime.lookup('p1', input.requestId), dispatched = f.runtime.lookup('p2', secondInput.requestId);
  assert.equal(before.run.status, 'interrupted'); assert.equal(before.run.modelRequestState, 'not_started');
  assert.equal(dispatched.run.status, 'interrupted'); assert.equal(dispatched.run.modelRequestState, 'unknown'); assert.equal(dispatched.run.assistantText, 'Committed prefix');
  assert.equal(f.calls, 0); assert.equal(f.acquisitions, 0);
  const events = []; f.runtime.subscribe('p2', dispatched.run.id, dispatched.instanceId, 0, event => events.push(event));
  assert.deepEqual(events.map(event => event.id), [1, 2, 3]); assert.ok(events.every(event => event.instanceId === dispatched.instanceId));
  assert.equal(events.at(-1).run.status, 'interrupted');
  f.restart(); assert.equal(f.runtime.lookup('p2', secondInput.requestId).run.lastEventId, dispatched.run.lastEventId);
});

test('durable delta events are batched by bytes, committed before publication and flushed on Stop', async t => {
  let release;
  const f = await fixture(t, {gateway: async function* ({signal}) {
    yield {type: 'delta', text: 'x'.repeat(CHAT_LIMITS.batchBytes + 15)};
    await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, {once: true}); });
    yield {type: 'delta', text: 'LATE'};
  }});
  const sent = await f.runtime.send('p1', await f.input()), seen = [];
  f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => {
    const durable = JSON.parse(f.store.db.prepare('SELECT data FROM agent_chat_events WHERE runId=? AND seq=?').get(sent.run.id, event.id).data);
    assert.equal(durable.id, event.id); assert.equal(durable.type, event.type); seen.push(event);
  });
  await until(() => release);
  const stopped = f.runtime.stop('p1', sent.run.id, {instanceId: sent.instanceId});
  assert.equal(stopped.run.assistantText, 'x'.repeat(CHAT_LIMITS.batchBytes + 15));
  assert.deepEqual(seen.map(event => event.type), ['snapshot', 'delta', 'delta', 'terminal']);
  assert.deepEqual(seen.filter(event => event.type === 'delta').map(event => Buffer.byteLength(event.text)), [CHAT_LIMITS.batchBytes, 15]);
  release(); await delay(5); assert.equal(f.runtime.get('p1', sent.run.id, sent.instanceId).run.assistantText.includes('LATE'), false);
});

test('small fragments wait for the bounded timer instead of committing every character', async t => {
  let release;
  const f = await fixture(t, {gateway: async function* ({signal}) {
    for (let n = 0; n < 100; n++) yield {type: 'delta', text: '字'};
    await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, {once: true}); });
  }});
  const sent = await f.runtime.send('p1', await f.input()); await until(() => release);
  assert.equal(f.runtime.get('p1', sent.run.id, sent.instanceId).run.assistantText, '');
  await until(() => f.runtime.get('p1', sent.run.id, sent.instanceId).run.assistantText);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_chat_events WHERE runId=?').get(sent.run.id).n, 2);
  f.runtime.stop('p1', sent.run.id, {instanceId: sent.instanceId});
});

test('admission capacity failure is atomic and occurs before acquisition/network; retained requests never evict', async t => {
  const f = await fixture(t, {journalLimits: {runs: 1}}), first = await f.input();
  const sent = await f.finish(await f.runtime.send('p1', first)), next = await f.input();
  await assert.rejects(f.runtime.send('p1', next), {code: 'AGENT_CHAT_STORAGE_LIMIT'});
  assert.equal(f.calls, 1); assert.equal(f.acquisitions, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_chat_requests').get().n, 1);
  assert.equal((await f.runtime.send('p1', first)).run.id, sent.run.id);
  f.restart(); assert.equal(f.runtime.lookup('p1', first.requestId).run.id, sent.run.id);
  assert.equal(f.store.db.prepare('SELECT reservedBytes n FROM agent_chat_quota').get().n, 0);
});

test('byte capacity rejects before acceptance and leaves no thread, request, run or event', async t => {
  const f = await fixture(t, {journalLimits: {bytes: CHAT_JOURNAL_LIMITS.terminalReserveBytes}});
  await assert.rejects(f.runtime.send('p1', await f.input()), {code: 'AGENT_CHAT_STORAGE_LIMIT'});
  for (const table of ['agent_chat_threads', 'agent_chat_requests', 'agent_chat_runs', 'agent_chat_events']) assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.calls, 0); assert.equal(f.acquisitions, 0);
});

test('streaming byte capacity preserves accepted intent and emits only committed prefix plus reserved failure terminal', async t => {
  const f = await fixture(t, {journalLimits: {bytes: CHAT_JOURNAL_LIMITS.terminalReserveBytes + 18000}, gateway: async function* () {
    yield {type: 'delta', text: 'x'.repeat(CHAT_LIMITS.responseBytes)}; yield {type: 'done', finishReason: 'stop'};
  }});
  const input = await f.input(), sent = await f.runtime.send('p1', input), seen = [];
  f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => seen.push(event));
  const complete = await f.finish(sent);
  assert.equal(complete.run.status, 'failed'); assert.equal(complete.run.error.code, 'AGENT_CHAT_STORAGE_LIMIT');
  assert.ok(complete.run.assistantText.length < CHAT_LIMITS.responseBytes);
  assert.equal(seen.filter(event => event.type === 'delta').map(event => event.text).join(''), complete.run.assistantText);
  assert.equal(f.runtime.lookup('p1', input.requestId).run.id, sent.run.id); assert.equal(f.calls, 1);
  assert.equal(f.store.db.prepare('SELECT reservedBytes n FROM agent_chat_quota').get().n, 0);
});

test('journal write failure fences all streams and closes subscribers without publishing uncommitted text', async t => {
  let produce;
  const f = await fixture(t, {gateway: async function* ({signal}) {
    await new Promise(resolve => { produce = resolve; signal.addEventListener('abort', resolve, {once: true}); });
    yield {type: 'delta', text: 'NEVER_PUBLISH'.repeat(250)}; yield {type: 'done', finishReason: 'stop'};
  }});
  const input = await f.input(), sent = await f.runtime.send('p1', input), seen = []; let closed = false;
  f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => seen.push(event), () => { closed = true; });
  await until(() => produce);
  f.store.db.exec("CREATE TRIGGER synthetic_reject_chat_event BEFORE INSERT ON agent_chat_events WHEN NEW.seq>1 BEGIN SELECT RAISE(ABORT,'synthetic disk failure');END;");
  produce(); await until(() => closed);
  assert.deepEqual(seen.map(event => event.type), ['snapshot']);
  assert.throws(() => f.runtime.lookup('p1', input.requestId), {code: 'AGENT_CHAT_STORAGE_UNAVAILABLE'});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_chat_events').get().n, 1);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT data FROM agent_chat_runs').get().data).assistantText, '');
  f.store.db.exec('DROP TRIGGER synthetic_reject_chat_event'); f.restart();
  const recovered = f.runtime.lookup('p1', input.requestId);
  assert.equal(recovered.run.status, 'interrupted'); assert.equal(recovered.run.modelRequestState, 'unknown'); assert.equal(f.calls, 1);
});

test('acceptance commit followed by acknowledgement-side failure stays recoverable and never starts a gateway', async t => {
  const f = await fixture(t), input = await f.input(), tx = f.store.tx;
  let injected = false;
  f.store.tx = operation => { const value = tx(operation); if (!injected) { injected = true; throw Error('synthetic lost commit acknowledgement'); } return value; };
  await assert.rejects(f.runtime.send('p1', input), {code: 'AGENT_CHAT_STORAGE_UNAVAILABLE'});
  assert.equal(f.calls, 0); assert.equal(f.acquisitions, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_chat_requests').get().n, 1);
  f.restart(); const recovered = f.runtime.lookup('p1', input.requestId);
  assert.equal(recovered.run.status, 'interrupted'); assert.equal(recovered.run.modelRequestState, 'not_started');
});

test('close flushes pending text and makes provider/credential callbacks inert after SQLite closes', async t => {
  let release;
  const f = await fixture(t, {gateway: async function* ({signal}) {
    yield {type: 'delta', text: 'pending-prefix'};
    await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, {once: true}); });
    yield {type: 'delta', text: 'late-after-db-close'}; yield {type: 'done', finishReason: 'stop'};
  }});
  const sent = await f.runtime.send('p1', await f.input()); await until(() => release);
  const seen = []; f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => seen.push(event));
  f.closeStore(); release(); await delay(10);
  assert.equal(seen.at(-1).run.status, 'interrupted'); assert.equal(seen.at(-1).run.assistantText, 'pending-prefix');
  assert.throws(() => f.runtime.lookup('p1', sent.run.requestId), {code: 'AGENT_CHAT_CLOSED'});
});

test('history pages are scoped chronological16; browsing older pages does not widen the accepted model context', async t => {
  let lastMessages;
  const f = await fixture(t, {gateway: async function* (options) { lastMessages = options.messages; yield {type: 'delta', text: 'ok'}; yield {type: 'done', finishReason: 'stop'}; }});
  const ids = [];
  for (let n = 0; n < 35; n++) ids.push((await f.finish(await f.runtime.send('p1', await f.input('p1', {message: `turn-${n}`})))).run.id);
  const recent = f.runtime.history('p1'), older = f.runtime.history('p1', {before: recent.historyCursor}), first = f.runtime.history('p1', {before: older.historyCursor});
  assert.deepEqual(recent.runs.map(run => run.id), ids.slice(19)); assert.deepEqual(older.runs.map(run => run.id), ids.slice(3, 19));
  assert.deepEqual(first.runs.map(run => run.id), ids.slice(0, 3)); assert.equal(first.historyCursor, null);
  assert.throws(() => f.runtime.history('p2', {before: recent.historyCursor}), {code: 'AGENT_CHAT_NOT_FOUND'});
  await f.finish(await f.runtime.send('p1', await f.input('p1', {message: 'latest'})));
  assert.deepEqual(lastMessages.filter(message => message.role === 'user').map(message => message.content), [...Array.from({length: 12}, (_, n) => `turn-${23 + n}`), 'latest']);
  const raw = f.store.db.prepare('SELECT acceptance FROM agent_chat_requests ORDER BY rowid DESC LIMIT 1').get();
  assert.deepEqual(JSON.parse(raw.acceptance).messages, lastMessages);
});

test('bounded durable replay resets oversized history to a snapshot without deleting saved events', async t => {
  const f = await fixture(t), input = await f.input(), configuration = (await f.settings.get()).configuration;
  f.runtime.close(); const {journal, accepted} = acceptDirect(f.store, input, configuration);
  journal.dispatch(accepted.run.id);
  for (let n = 0; n < 270; n++) journal.append(accepted.run.id, 'x');
  journal.finish(accepted.run.id, 'stopped');
  f.restart(); const found = f.runtime.lookup('p1', input.requestId), events = [];
  f.runtime.subscribe('p1', found.run.id, found.instanceId, 0, event => events.push(event));
  assert.equal(events.length, 1); assert.equal(events[0].type, 'snapshot'); assert.equal(events[0].run.assistantText, 'x'.repeat(270));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_chat_events WHERE runId=?').get(found.run.id).n, 272);
  assert.throws(() => f.store.db.prepare('DELETE FROM agent_chat_events WHERE runId=?').run(found.run.id), /retained/);
  const tail = []; f.runtime.subscribe('p1', found.run.id, found.instanceId, found.run.lastEventId - 2, event => tail.push(event));
  assert.deepEqual(tail.map(event => event.id), [found.run.lastEventId - 1, found.run.lastEventId]);
  assert.equal(f.calls, 0); assert.equal(f.acquisitions, 0);
});

test('reentrant Stop from one subscriber cannot send a late delta after another subscriber terminal', async t => {
  let release;
  const f = await fixture(t, {gateway: async function* ({signal}) {
    await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, {once: true}); });
    yield {type: 'delta', text: 'x'.repeat(CHAT_LIMITS.batchBytes)}; yield {type: 'done', finishReason: 'stop'};
  }});
  const sent = await f.runtime.send('p1', await f.input()), first = [], second = [];
  f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => {
    first.push(event.type);
    if (event.type === 'delta') f.runtime.stop('p1', sent.run.id, {instanceId: sent.instanceId});
  });
  f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => second.push(event.type));
  await until(() => release); release(); await f.finish(sent);
  assert.deepEqual(first, ['snapshot', 'delta', 'terminal']); assert.deepEqual(second, first);
});

test('close during pending credential acquisition prevents post-close journal writes and gateway calls', async t => {
  let release, entered;
  const f = await fixture(t, {settingsWrapper: settings => ({get: settings.get, [AGENT_CREDENTIAL_ACQUIRE](expected) {
    entered = true;
    return new Promise(resolve => { release = () => resolve({revision: expected.expectedRevision, configuration: expected.configuration, apiKey: SECRET}); });
  }})});
  await f.runtime.send('p1', await f.input()); await until(() => entered);
  f.closeStore(); release(); await delay(10);
  assert.equal(f.calls, 0);
});

test('public run/history/event DTOs omit unknown persisted fields and sanitize stored error messages', async t => {
  const f = await fixture(t, {gateway: async function* () { throw Error('synthetic provider fault'); }});
  const sent = await f.finish(await f.runtime.send('p1', await f.input()));
  f.store.db.prepare("UPDATE agent_chat_runs SET data=json_set(data,'$.internalSecret',?,'$.error.message',?) WHERE id=?").run(SECRET, SECRET, sent.run.id);
  // Simulate a forward-version/internal event field in this disposable fixture.
  f.store.db.exec('DROP TRIGGER immutable_agent_chat_events');
  f.store.db.prepare("UPDATE agent_chat_events SET data=json_set(data,'$.internalSecret',?,'$.run.internalSecret',?) WHERE runId=? AND seq=1").run(SECRET, SECRET, sent.run.id);
  const result = f.runtime.get('p1', sent.run.id, sent.instanceId);
  assert.equal(Object.hasOwn(result.run, 'internalSecret'), false); assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(f.runtime.lookup('p1', sent.run.requestId)).includes(SECRET), false);
  assert.equal(JSON.stringify(f.runtime.history('p1')).includes(SECRET), false);
  assert.equal(JSON.stringify(await f.runtime.snapshot('p1')).includes(SECRET), false);
  const events = []; f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => events.push(event));
  assert.equal(JSON.stringify(events).includes(SECRET), false); assert.equal(events.at(-1).run.status, 'failed');
});

test('persisted run identity/status mismatch fails closed before returning scope data', async t => {
  for (const [field, value] of [['id', randomUUID()], ['projectId', 'p2'], ['threadId', randomUUID()], ['requestId', randomUUID()], ['status', 'stopped']]) {
    const f = await fixture(t), sent = await f.finish(await f.runtime.send('p1', await f.input()));
    f.store.db.exec('DROP TRIGGER immutable_agent_chat_run_identity');
    f.store.db.prepare('UPDATE agent_chat_runs SET data=json_set(data,?,?) WHERE id=?').run(`$.${field}`, value, sent.run.id);
    assert.throws(() => f.runtime.get('p1', sent.run.id, sent.instanceId), {code: 'AGENT_CHAT_STORAGE_UNAVAILABLE'}, field);
    assert.equal(f.calls, 1);
  }
});

test('persisted run must agree with immutable acceptance and owning thread, even if SQL/data scopes both change', async t => {
  const f = await fixture(t), sent = await f.finish(await f.runtime.send('p1', await f.input()));
  f.store.db.exec('DROP TRIGGER immutable_agent_chat_run_identity');
  f.store.db.prepare("UPDATE agent_chat_runs SET projectId='p2',data=json_set(data,'$.projectId','p2') WHERE id=?").run(sent.run.id);
  assert.throws(() => f.runtime.get('p2', sent.run.id, sent.instanceId), {code: 'AGENT_CHAT_STORAGE_UNAVAILABLE'});
});

test('malformed or oversized persisted run shapes fail closed rather than leaking raw JSON', async t => {
  for (const [field, value] of [['assistantText', 'x'.repeat(CHAT_LIMITS.responseBytes + 1)], ['assistantText', 123],
    ['lastEventId', -1], ['modelRequestState', 'remote_billing_proven'], ['configuration.apiKey', SECRET], ['internalPadding', 'x'.repeat(1024 * 1024)]]) {
    const f = await fixture(t), sent = await f.finish(await f.runtime.send('p1', await f.input()));
    f.store.db.exec('DROP TRIGGER immutable_agent_chat_run_identity');
    f.store.db.prepare('UPDATE agent_chat_runs SET data=json_set(data,?,?) WHERE id=?').run(`$.${field}`, value, sent.run.id);
    assert.throws(() => f.runtime.lookup('p1', sent.run.requestId), {code: 'AGENT_CHAT_STORAGE_UNAVAILABLE'}, field);
    assert.equal(f.calls, 1);
  }
});

test('persisted event scope/sequence mismatch is rejected before any replay publication', async t => {
  const f = await fixture(t), sent = await f.finish(await f.runtime.send('p1', await f.input()));
  f.store.db.exec('DROP TRIGGER immutable_agent_chat_events');
  f.store.db.prepare("UPDATE agent_chat_events SET data=json_set(data,'$.projectId','p2') WHERE runId=? AND seq=1").run(sent.run.id);
  const events = [];
  assert.throws(() => f.runtime.subscribe('p1', sent.run.id, sent.instanceId, 0, event => events.push(event)), {code: 'AGENT_CHAT_STORAGE_UNAVAILABLE'});
  assert.equal(events.length, 0); assert.equal(f.calls, 1);
});
