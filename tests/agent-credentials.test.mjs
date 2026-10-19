import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.ts';
import {createAgentSettingsBroker, createAgentSettingsClient} from '../apps/desktop/src/secret-broker.ts';

const SECRET = 'SYNTHETIC_ACQUISITION_KEY';
function codec() {
  const key = randomBytes(32);
  return {encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
    decrypt(text) { const bytes = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(); }};
}
async function engine(t, extra = {}, storage = 'session') {
  let persisted;
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async value => { persisted = value; }}, ...extra});
  t.after(() => settings.close());
  const initial = await settings.get();
  const saved = await settings.put({expectedRevision: 0, configuration: initial.configuration, secret: {action: 'replace', storage, value: SECRET}});
  return {settings, expected: {expectedRevision: saved.revision, configuration: saved.configuration}, get persisted() { return persisted; }};
}
const safe = value => { assert.equal(JSON.stringify(value).includes(SECRET), false); return true; };
const request = (operation, input) => ({type: 'agent-settings-request', version: 1, requestId: randomUUID(), operation, selfPort: 4318, ...(input ? {input} : {})});
function pair(settings, timeout = 10000) {
  const port = new EventEmitter(), outgoing = [], replies = [];
  const broker = createAgentSettingsBroker({agentSettings: settings, getSelfPort: () => 4318, send: data => { replies.push(data); port.emit('message', {data}); }});
  port.postMessage = message => { outgoing.push(message); queueMicrotask(() => broker.handle(message)); };
  const client = createAgentSettingsClient({port, timeout});
  return {client, broker, port, outgoing, replies, close() { client.close(); broker.close(); }};
}

test('trusted symbol acquisition requires exact revision/full configuration, while public read stays key-free', async t => {
  const f = await engine(t); assert.deepEqual(Object.keys(f.settings).sort(), ['close', 'get', 'put']);
  const acquired = await f.settings[AGENT_CREDENTIAL_ACQUIRE](f.expected, {selfPort: 4318});
  assert.equal(acquired.apiKey, SECRET); safe(await f.settings.get()); safe(f.persisted);
  for (const input of [{...f.expected, expectedRevision: 0}, {...f.expected, configuration: {...f.expected.configuration, model: 'different'}},
    {...f.expected, configuration: {...f.expected.configuration, protocol: 'responses'}},
    {...f.expected, configuration: {...f.expected.configuration, baseUrl: 'https://different.example.com/v1'}}]) await assert.rejects(f.settings[AGENT_CREDENTIAL_ACQUIRE](input), {code: 'AGENT_SETTINGS_CONFLICT'});
  await assert.rejects(f.settings[AGENT_CREDENTIAL_ACQUIRE]({...f.expected, secret: SECRET}), {code: 'AGENT_SETTINGS_VALIDATION'});
  await f.settings.put({expectedRevision: f.expected.expectedRevision, configuration: {...f.expected.configuration, baseUrl: 'https://changed.example.com/v1'}, secret: {action: 'keep'}});
  const changed = await f.settings.get();
  assert.equal((await f.settings[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision: changed.revision, configuration: changed.configuration})).apiKey, null);
});

test('persistent credentials recheck OS vault and binding at each acquire without caching decoded secrets', async t => {
  let available = true, reads = 0;
  const vault = codec(), original = vault.decrypt;
  vault.decrypt = text => { reads++; return original(text); };
  const f = await engine(t, {secretCodec: vault, storage: () => ({persistentAvailable: available, sessionScope: 'app', reasonCode: available ? null : 'OS_SECRET_STORE_UNAVAILABLE'})}, 'persistent');
  assert.equal((await f.settings[AGENT_CREDENTIAL_ACQUIRE](f.expected)).apiKey, SECRET);
  assert.equal((await f.settings[AGENT_CREDENTIAL_ACQUIRE](f.expected)).apiKey, SECRET); assert.equal(reads, 2);
  available = false; await assert.rejects(f.settings[AGENT_CREDENTIAL_ACQUIRE](f.expected), {code: 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'}); assert.equal(reads, 2);
  available = true; vault.decrypt = () => JSON.stringify({version: 1, binding: 'wrong', value: SECRET});
  await assert.rejects(f.settings[AGENT_CREDENTIAL_ACQUIRE](f.expected), error => error.code === 'AGENT_SETTINGS_STORAGE_UNAVAILABLE' && safe({message: error.message}));
  safe(await f.settings.get()); safe(f.persisted);
});

test('aborting queued/decrypting acquisition prevents key delivery and bounded tail still permits safe reads', async t => {
  let release;
  const vault = codec(); vault.decrypt = () => new Promise(resolve => { release = resolve; });
  const f = await engine(t, {secretCodec: vault, storage: {persistentAvailable: true, sessionScope: 'app', reasonCode: null}}, 'persistent');
  const controller = new AbortController(), pending = f.settings[AGENT_CREDENTIAL_ACQUIRE](f.expected, {signal: controller.signal});
  const rejected = assert.rejects(pending, {code: 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'}); await turn(); controller.abort(); await rejected;
  release(JSON.stringify({version: 1, binding: 'wrong', value: SECRET})); await turn(); safe(await f.settings.get());
});

test('desktop acquisition is narrow, request-bound and never put in cached public settings replies', async t => {
  const f = await engine(t), p = pair(f.settings); t.after(() => p.close());
  assert.deepEqual(Object.keys(p.client).sort(), ['close', 'get', 'put']);
  const acquired = await p.client[AGENT_CREDENTIAL_ACQUIRE](f.expected, {selfPort: 4318}); assert.equal(acquired.apiKey, SECRET);
  const sent = p.outgoing[0]; assert.equal(sent.operation, 'acquire'); safe(sent);
  p.broker.handle(sent); await turn(); assert.equal(p.replies.at(-1).ok, false); safe(p.replies.at(-1));
  safe(await p.client.get({selfPort: 4318}));
  const wrong = request('acquire', {...f.expected, configuration: {...f.expected.configuration, model: 'another'}});
  p.broker.handle(wrong); await turn(); assert.equal(p.replies.at(-1).ok, false); safe(p.replies.at(-1));
  const changed = await p.client.put({expectedRevision: f.expected.expectedRevision, configuration: {...f.expected.configuration, protocol: 'responses'}, secret: {action: 'keep'}}, {selfPort: 4318});
  assert.equal(changed.configuration.protocol, 'responses'); assert.equal(changed.secret.configured, true);
  await assert.rejects(p.client[AGENT_CREDENTIAL_ACQUIRE]({...f.expected, expectedRevision: changed.revision}, {selfPort: 4318}), {code: 'AGENT_SETTINGS_CONFLICT'});
  assert.equal((await p.client[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision: changed.revision, configuration: changed.configuration}, {selfPort: 4318})).apiKey, SECRET);
  assert.ok(p.outgoing.every(message => message.version === 1));
});

test('client rejects credential-shaped responses to public reads and wrong-bound acquisition responses', async t => {
  const f = await engine(t), port = new EventEmitter(), outgoing = [];
  port.postMessage = message => outgoing.push(message);
  const client = createAgentSettingsClient({port}); t.after(() => client.close());
  const get = client.get();
  port.emit('message', {data: {type: 'agent-settings-response', version: 1, requestId: outgoing.at(-1).requestId, ok: true,
    data: {revision: f.expected.expectedRevision, configuration: f.expected.configuration, apiKey: SECRET}}});
  await assert.rejects(get, error => error.code === 'AGENT_SETTINGS_UNAVAILABLE' && safe({message: error.message}));
  const acquire = client[AGENT_CREDENTIAL_ACQUIRE](f.expected);
  port.emit('message', {data: {type: 'agent-settings-response', version: 1, requestId: outgoing.at(-1).requestId, ok: true,
    data: {revision: f.expected.expectedRevision, configuration: {...f.expected.configuration, model: 'different'}, apiKey: SECRET}}});
  await assert.rejects(acquire, {code: 'AGENT_SETTINGS_UNAVAILABLE'});
});

test('abort/utility replacement cancels main acquisition and late credentials reach neither client nor replacement', async t => {
  const f = await engine(t); let finish, signal;
  const settings = {get: () => f.settings.get(), [AGENT_CREDENTIAL_ACQUIRE](expected, options) { signal = options.signal; return new Promise(resolve => { finish = () => resolve({revision: expected.expectedRevision, configuration: expected.configuration, apiKey: SECRET}); }); }};
  const old = pair(settings); t.after(() => old.close());
  const controller = new AbortController();
  const pending = old.client[AGENT_CREDENTIAL_ACQUIRE](f.expected, {selfPort: 4318, signal: controller.signal});
  const rejected = assert.rejects(pending, {code: 'AGENT_SETTINGS_UNAVAILABLE'}); await turn(); controller.abort(); await rejected; await turn();
  assert.equal(signal.aborted, true); old.close();
  const replacement = pair(f.settings); t.after(() => replacement.close());
  finish(); await turn(); assert.equal(old.replies.length, 0); assert.equal(replacement.replies.length, 0);
  safe(await replacement.client.get({selfPort: 4318}));
});

test('acquisition client deadline is bounded and sanitized, with cancellation sent to main', async t => {
  const f = await engine(t), port = new EventEmitter(), outgoing = [];
  port.postMessage = message => outgoing.push(message);
  const client = createAgentSettingsClient({port, timeout: 10}); t.after(() => client.close());
  await assert.rejects(client[AGENT_CREDENTIAL_ACQUIRE](f.expected), {code: 'AGENT_SETTINGS_TIMEOUT'});
  assert.equal(outgoing.at(-1).type, 'agent-credential-cancel'); outgoing.forEach(safe);
});
