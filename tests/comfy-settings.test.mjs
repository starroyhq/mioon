import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod, stat, symlink, link} from 'node:fs/promises';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION, COMFY_SETTINGS_NAMESPACE, COMFY_SETTINGS_LIMITS,
  comfyImageCheckRequestSchema, isComfyImageSettingsResult} from '../packages/contracts/src/comfy-images.mjs';
import {createComfySettings, createComfySettingsFile, parseComfyConfiguration, parseComfySettingsUpdate,
  sanitizeComfySettingsResult, validateComfySettingsEnvelope, comfySettingsError, sanitizeComfySettingsError,
  COMFY_SETTINGS_READ_CURRENT, COMFY_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/comfy/settings.mjs';
import {IMAGE_SETTINGS_READ_CURRENT, IMAGE_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/images/settings.mjs';

const SENTINEL = 'synthetic-private-value-never-an-actual-key';
const reservedPorts = () => [4318, 4319];
const config = (changes = {}) => ({...structuredClone(DEFAULT_COMFY_IMAGE_CONFIGURATION), enabled: true,
  baseUrl: 'http://127.0.0.1:8188', model: 'checkpoints/synthetic.safetensors', ...changes});
const update = (revision = 0, configuration = config()) => ({expectedRevision: revision, configuration});
const expected = value => ({expectedRevision: value.revision, configuration: value.configuration});
const envelope = (revision = 1, configuration = config()) => ({version: 1, namespace: COMFY_SETTINGS_NAMESPACE, revision, configuration});
const check = (changes = {}) => ({ok: true, baseUrl: config().baseUrl, comfyVersion: '0.39.0',
  checkpoints: [config().model, 'second.safetensors'], selectedCheckpointAvailable: true,
  nodeClasses: ['CheckpointLoaderSimple', 'EmptyLatentImage', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage'], ...changes});
function memory(initial = null) {
  let value = structuredClone(initial), saves = 0;
  return {load: async () => structuredClone(value), save: async next => { saves++; value = structuredClone(next); },
    get value() { return structuredClone(value); }, get saves() { return saves; }};
}
const recordCheck = (settings, value) => settings.recordCheck(value, settings.clearCheck(value.baseUrl));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
async function engine(t, options = {}) {
  const settings = await createComfySettings({persistence: memory(), reservedPorts, ...options});
  t.after(() => settings.close()); return settings;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-comfy-settings-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'comfy-settings'), file = path.join(directory, 'settings.json');
  return {root, directory, file, persistence: createComfySettingsFile({directory, privateRoot: root})};
}
const safeError = error => {
  assert.ok(/^COMFY_SETTINGS_[A-Z_]+$/.test(error.code));
  assert.equal(error.message.includes(SENTINEL), false);
  assert.equal(error.message.includes('/tmp/'), false);
  return true;
};

test('defaults are disabled and independent; getters and saves never probe the network or adopt secrets', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Settings must not contact a provider');
  t.after(() => { globalThis.fetch = original; });
  const persistence = memory(), settings = await engine(t, {persistence});
  const initial = await settings.get();
  assert.deepEqual(initial, {revision: 0, configuration: DEFAULT_COMFY_IMAGE_CONFIGURATION, readiness: {checked: false, checkedAt: null}});
  assert.ok(isComfyImageSettingsResult(initial));
  assert.equal(persistence.value, null); assert.equal(persistence.saves, 0);
  assert.equal(settings[COMFY_SETTINGS_READ_CURRENT], settings.readCurrent);
  assert.equal(settings[COMFY_SETTINGS_ASSERT_CURRENT], settings.assertCurrent);
  assert.notEqual(COMFY_SETTINGS_READ_CURRENT, IMAGE_SETTINGS_READ_CURRENT);
  assert.notEqual(COMFY_SETTINGS_ASSERT_CURRENT, IMAGE_SETTINGS_ASSERT_CURRENT);
  assert.equal(settings.isReady(), false);
  const saved = await settings.put(update());
  assert.deepEqual(Object.keys(saved).sort(), ['configuration', 'readiness', 'revision']);
  assert.equal(saved.revision, 1); assert.equal(saved.readiness.checked, false);
  assert.deepEqual(persistence.value, envelope());
  assert.throws(() => settings.assertCurrent(expected(saved)), {code: 'COMFY_SETTINGS_CHECK_REQUIRED'});
});

test('configuration and update parsers enforce one fixed profile and complete enabled settings', () => {
  for (const changes of [{baseUrl: ''}, {model: ''}, {enabled: true, baseUrl: '', model: ''},
    {enabled: false, baseUrl: '', model: 'synthetic'}, {enabled: false, model: ''}, {providerId: 'openai'},
    {connectionId: 'custom'}, {profileId: 'arbitrary-workflow'}, {comfyVersion: '0.40.0'},
    {model: '../escape'}, {model: '/absolute'}, {model: ' padded '}, {model: 'C:\\secret'}, {model: 'x'.repeat(241)},
    {model: 'checkpoint?key=private'}, {options: {...config().options, n: 2}},
    {options: {...config().options, width: 1024}}, {apiKey: SENTINEL}, {secret: null}, {workflow: {}}]) {
    assert.throws(() => parseComfyConfiguration(config(changes)), {code: 'COMFY_SETTINGS_VALIDATION'});
  }
  for (const value of [{...update(), secret: null}, {...update(), readiness: {checked: true}}, {...update(), namespace: 'other'},
    update(-1), update(0.1), update(Number.MAX_SAFE_INTEGER + 1), {...update(), configuration: []}, null,
    Object.assign(Object.create({}), update()), {...update(), [Symbol('extra')]: true}]) {
    assert.throws(() => parseComfySettingsUpdate(value), {code: 'COMFY_SETTINGS_VALIDATION'});
  }
  assert.deepEqual(parseComfyConfiguration(DEFAULT_COMFY_IMAGE_CONFIGURATION), DEFAULT_COMFY_IMAGE_CONFIGURATION);
  assert.equal(parseComfyConfiguration(config({enabled: false})).enabled, false);
  // A check may list checkpoints before one has been selected; saving an
  // enabled configuration still requires a concrete model.
  assert.equal(comfyImageCheckRequestSchema.safeParse({baseUrl: config().baseUrl, model: ''}).success, true);
});

test('canonical explicit-port loopback only; no credentials, paths, DNS, query, fragments or URL normalization', () => {
  for (const baseUrl of ['https://127.0.0.1:8188', 'http://localhost:8188', 'http://127.1:8188', 'http://2130706433:8188',
    'http://127.0.0.2:8188', 'http://0.0.0.0:8188', 'http://[::ffff:127.0.0.1]:8188', 'http://[0:0:0:0:0:0:0:1]:8188',
    'http://127.0.0.1', 'http://127.0.0.1:08188', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://127.0.0.1:8188/', 'http://127.0.0.1:8188/v1', 'http://127.0.0.1:8188?key=private',
    'http://127.0.0.1:8188#private', 'http://user:pass@127.0.0.1:8188', ' http://127.0.0.1:8188',
    'HTTP://127.0.0.1:8188', 'http://127.0.0.1:8188\\secret', 'http://%31%32%37.0.0.1:8188']) {
    assert.throws(() => parseComfyConfiguration(config({baseUrl})), {code: 'COMFY_SETTINGS_VALIDATION'});
  }
  for (const baseUrl of ['http://127.0.0.1:80', 'http://127.0.0.1:65535', 'http://[::1]:8188']) {
    assert.equal(parseComfyConfiguration(config({baseUrl})).baseUrl, baseUrl);
  }
});

test('trusted own-port policy is checked on save and rechecked synchronously at the final fence', async t => {
  let ownPorts = [4318];
  const settings = await engine(t, {reservedPorts: () => ownPorts});
  const saved = await settings.put(update()); recordCheck(settings, check());
  assert.equal(settings.assertCurrent(expected(saved)), true);
  ownPorts = [8188];
  assert.deepEqual((await settings.get()).configuration, saved.configuration);
  assert.throws(() => settings.assertCurrent(expected(saved)), {code: 'COMFY_SETTINGS_DESTINATION_DENIED'});
  await assert.rejects(settings.put(update(1)), {code: 'COMFY_SETTINGS_DESTINATION_DENIED'});
  ownPorts = [4318]; assert.equal(settings.assertCurrent(expected(saved)), true);
  ownPorts = [8188];
  assert.throws(() => settings.clearCheck(config().baseUrl), {code: 'COMFY_SETTINGS_DESTINATION_DENIED'});
  ownPorts = [4318];
  assert.equal(settings.isReady(), false, 'Even a denied re-check revokes earlier endpoint evidence');
  recordCheck(settings, check()); assert.equal(settings.assertCurrent(expected(saved)), true);
  for (const policy of [undefined, [], [0], [65536], ['4318'], Promise.resolve([4318]), () => { throw Error(SENTINEL); }]) {
    const value = await engine(t, {reservedPorts: policy});
    await assert.rejects(value.put(update()), error => error.code === 'COMFY_SETTINGS_DESTINATION_DENIED' && safeError(error));
    assert.equal((await value.put(update(0, DEFAULT_COMFY_IMAGE_CONFIGURATION))).revision, 1);
  }
});

test('trusted checks are bounded in-memory evidence, permit catalog selection and never persist across restart', async t => {
  const persistence = memory(), settings = await engine(t, {persistence});
  const checked = check({selectedCheckpointAvailable: false}); recordCheck(settings, checked);
  checked.checkpoints.length = 0;
  const saved = await settings.put(update());
  assert.equal(saved.readiness.checked, true); assert.match(saved.readiness.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(settings.isReady(), true); assert.equal(settings.assertCurrent(expected(saved)), true);
  assert.equal(Object.hasOwn(persistence.value, 'readiness'), false);
  const otherModel = await settings.put(update(1, config({model: 'second.safetensors'})));
  assert.equal(otherModel.readiness.checked, true);
  const unlisted = await settings.put(update(2, config({model: 'unlisted.safetensors'})));
  assert.equal(unlisted.readiness.checked, false);
  assert.throws(() => settings.assertCurrent(expected(unlisted)), {code: 'COMFY_SETTINGS_CHECK_REQUIRED'});
  const disabled = await settings.put(update(3, config({enabled: false})));
  assert.deepEqual(disabled.readiness, {checked: false, checkedAt: null});
  assert.throws(() => settings.assertCurrent(expected(disabled)), {code: 'COMFY_SETTINGS_DISABLED'});
  const enabled = await settings.put(update(4)); assert.equal(enabled.readiness.checked, true);
  const changedBase = await settings.put(update(5, config({baseUrl: 'http://[::1]:8188'})));
  assert.equal(changedBase.readiness.checked, false);
  const returned = await settings.put(update(6)); assert.equal(returned.readiness.checked, false);
  recordCheck(settings, check()); await settings.close();
  assert.equal(settings.isReady(), false);
  const restarted = await engine(t, {persistence});
  const current = await restarted.get(); assert.equal(current.revision, 7);
  assert.deepEqual(current.readiness, {checked: false, checkedAt: null});
  assert.throws(() => restarted.assertCurrent(expected(current)), {code: 'COMFY_SETTINGS_CHECK_REQUIRED'});
  recordCheck(restarted, check()); assert.equal(restarted.assertCurrent(expected(current)), true);
});

test('check recording rejects malformed protocol evidence and own backend destinations', async t => {
  const settings = await engine(t);
  for (const value of [{...check(), apiKey: SENTINEL}, check({comfyVersion: '0.40.0'}), check({nodeClasses: []}),
    check({nodeClasses: Array(6).fill('SaveImage')}), check({checkpoints: Array(257).fill('model')}),
    check({checkpoints: ['../escape']}), check({checkpoints: ['model', 'model']}), check({ok: false}), null]) {
    const token = settings.clearCheck(config().baseUrl);
    assert.throws(() => settings.recordCheck(value, token), {code: 'COMFY_SETTINGS_VALIDATION'});
  }
  assert.throws(() => settings.clearCheck('http://127.0.0.1:4318'), {code: 'COMFY_SETTINGS_DESTINATION_DENIED'});
  assert.equal(settings.isReady(config()), false);
});

test('explicit rechecks revoke readiness before I/O and superseded or rejected check responses cannot restore it', async t => {
  const settings = await engine(t);
  const saved = await settings.put(update()); recordCheck(settings, check());
  assert.equal(settings.isReady(), true);
  const older = settings.clearCheck(config().baseUrl);
  assert.deepEqual((await settings.get()).readiness, {checked: false, checkedAt: null});
  assert.throws(() => settings.assertCurrent(expected(saved)), {code: 'COMFY_SETTINGS_CHECK_REQUIRED'});
  const newer = settings.clearCheck(config().baseUrl);
  assert.throws(() => settings.recordCheck(check({comfyVersion: 'bad-version'}), newer), {code: 'COMFY_SETTINGS_VALIDATION'});
  assert.throws(() => settings.recordCheck(check(), older), {code: 'COMFY_SETTINGS_CONFLICT'});
  assert.throws(() => settings.recordCheck(check(), newer), {code: 'COMFY_SETTINGS_CONFLICT'});
  assert.equal(settings.isReady(), false);
  const latest = settings.clearCheck(config().baseUrl); settings.recordCheck(check(), latest);
  assert.equal(settings.isReady(), true);
  assert.throws(() => settings.recordCheck(check(), latest), {code: 'COMFY_SETTINGS_CONFLICT'});
  const other = settings.clearCheck('http://[::1]:8188');
  assert.equal(settings.isReady(), true, 'Checking a different endpoint does not revoke current endpoint evidence');
  assert.throws(() => settings.recordCheck(check(), other), {code: 'COMFY_SETTINGS_CONFLICT'});
  assert.equal(settings.isReady(), true);
  assert.throws(() => settings.clearCheck('http://localhost:8188'), {code: 'COMFY_SETTINGS_VALIDATION'});
  const interrupted = settings.clearCheck(config().baseUrl); await settings.close();
  assert.throws(() => settings.recordCheck(check(), interrupted), {code: 'COMFY_SETTINGS_CLOSED'});
  assert.throws(() => settings.clearCheck(config().baseUrl), {code: 'COMFY_SETTINGS_CLOSED'});
});

test('CAS serializes concurrent puts, copies caller data and fences every older revision or changed binding', async t => {
  const persistence = memory(), settings = await engine(t, {persistence}); recordCheck(settings, check());
  const input = update(), first = settings.put(input);
  input.configuration.model = 'mutated.safetensors'; input.configuration.options.n = 9;
  assert.throws(() => settings.readCurrent(), {code: 'COMFY_SETTINGS_CONFLICT'});
  assert.equal(settings.isReady(config()), false);
  const results = await Promise.allSettled([first, settings.put(update())]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'COMFY_SETTINGS_CONFLICT');
  const old = await settings.get(); assert.deepEqual(old.configuration, config());
  assert.equal(settings.assertCurrent(expected(old)), true);
  const sameConfiguration = await settings.put(update(1));
  assert.equal(sameConfiguration.revision, 2); assert.equal(persistence.saves, 2);
  assert.throws(() => settings.assertCurrent(expected(old)), {code: 'COMFY_SETTINGS_CONFLICT'});
  assert.throws(() => settings.assertCurrent(update(2, config({model: 'second.safetensors'}))), {code: 'COMFY_SETTINGS_CONFLICT'});
  const copied = settings.readCurrent(); copied.configuration.model = 'outside.safetensors'; copied.readiness.checked = false;
  assert.equal(settings.assertCurrent(expected(sameConfiguration)), true);
});

test('admitted writes block synchronous read, recording and final fence before and throughout persistence', async t => {
  const persistence = memory(), settings = await engine(t, {persistence}); recordCheck(settings, check());
  const old = await settings.put(update()), save = persistence.save, gate = deferred(), entered = deferred();
  persistence.save = async candidate => { entered.resolve(); await gate.promise; return save(candidate); };
  const pending = settings.put(update(1, config({model: 'second.safetensors'})));
  assert.throws(() => settings.assertCurrent(expected(old)), {code: 'COMFY_SETTINGS_CONFLICT'});
  await entered.promise;
  assert.throws(() => settings[COMFY_SETTINGS_READ_CURRENT](), {code: 'COMFY_SETTINGS_CONFLICT'});
  assert.throws(() => settings.clearCheck(config().baseUrl), {code: 'COMFY_SETTINGS_CONFLICT'});
  assert.throws(() => settings.recordCheck(check()), {code: 'COMFY_SETTINGS_CONFLICT'});
  gate.resolve(); const saved = await pending;
  assert.equal(settings[COMFY_SETTINGS_ASSERT_CURRENT](expected(saved)), true);
  assert.throws(() => settings.assertCurrent(expected(old)), {code: 'COMFY_SETTINGS_CONFLICT'});
});

test('known failed saves prove the exact prior durable envelope before reopening the fence and never retry', async t => {
  for (const existing of [false, true]) {
    const persistence = memory(), settings = await engine(t, {persistence}); recordCheck(settings, check());
    const old = existing ? await settings.put(update()) : await settings.get();
    const durable = persistence.value, load = persistence.load, reading = deferred(), gate = deferred(); let attempts = 0;
    persistence.save = async () => { attempts++; throw Error(SENTINEL); };
    persistence.load = async () => { reading.resolve(); await gate.promise; return load(); };
    const pending = settings.put(update(old.revision)); await reading.promise;
    assert.throws(() => settings.readCurrent(), {code: 'COMFY_SETTINGS_CONFLICT'});
    gate.resolve(); await assert.rejects(pending, error => error.code === 'COMFY_SETTINGS_SAVE_FAILED' && safeError(error));
    assert.equal(attempts, 1); assert.deepEqual(await settings.get(), old); assert.deepEqual(persistence.value, durable);
    if (existing) assert.equal(settings.assertCurrent(expected(old)), true);
  }
});

test('candidate, missing, foreign and unreadable failed-save outcomes latch closed until a fresh owner', async t => {
  for (const outcome of ['candidate', 'missing', 'foreign', 'unreadable']) {
    const persistence = memory(), settings = await engine(t, {persistence}); recordCheck(settings, check());
    const old = await settings.put(update()), save = persistence.save, load = persistence.load; let attempts = 0;
    persistence.save = async candidate => {
      attempts++;
      if (outcome === 'candidate') await save(candidate);
      persistence.load = async () => {
        if (outcome === 'unreadable') throw Error(SENTINEL);
        if (outcome === 'missing') return null;
        if (outcome === 'foreign') return {...envelope(2), namespace: SENTINEL};
        return load();
      };
      throw Error(SENTINEL);
    };
    await assert.rejects(settings.put(update(1, config({model: 'second.safetensors'}))), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
    assert.equal(attempts, 1);
    await assert.rejects(settings.get(), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
    await assert.rejects(settings.put(update(1)), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
    assert.throws(() => settings.assertCurrent(expected(old)), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
    assert.throws(() => settings.readCurrent(), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
    assert.equal(settings.isReady(), false);
    if (outcome === 'candidate') {
      const restarted = await engine(t, {persistence});
      assert.equal((await restarted.get()).revision, 2);
      assert.equal((await restarted.get()).configuration.model, 'second.safetensors');
      assert.equal(restarted.isReady(), false);
    }
  }
});

test('failed-save read-back is time bounded and late proof cannot reopen a latched owner', async t => {
  const persistence = memory(), settings = await engine(t, {persistence});
  const old = await settings.put(update()), load = persistence.load, entered = deferred(), late = deferred();
  persistence.save = async () => { throw Error(SENTINEL); };
  persistence.load = async () => { entered.resolve(); await late.promise; return load(); };
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = settings.put(update(1));
  const rejection = assert.rejects(pending, {code: 'COMFY_SETTINGS_SAVE_FAILED'});
  await entered.promise;
  assert.throws(() => settings.assertCurrent(expected(old)), {code: 'COMFY_SETTINGS_CONFLICT'});
  t.mock.timers.tick(5000); await rejection;
  late.resolve(); await Promise.resolve(); await Promise.resolve();
  await assert.rejects(settings.get(), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
  assert.throws(() => settings.readCurrent(), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
});

test('corrupt initial storage and maximum revisions fail closed with sanitized fixed errors', async t => {
  for (const initial of [{...envelope(), secret: {value: SENTINEL}}, {...envelope(), namespace: 'mioon.images.v1'},
    {...envelope(), version: 2}, {...envelope(), revision: -1}, {...envelope(), readiness: {checked: true}},
    {...envelope(), configuration: config({apiKey: SENTINEL})}, undefined]) {
    const persistence = {load: async () => initial, save: async () => assert.fail('Corrupt storage cannot be overwritten')};
    const settings = await engine(t, {persistence});
    await assert.rejects(settings.get(), {code: 'COMFY_SETTINGS_CORRUPT'});
    await assert.rejects(settings.put(update()), {code: 'COMFY_SETTINGS_CORRUPT'});
  }
  const persistence = memory(envelope(Number.MAX_SAFE_INTEGER)), settings = await engine(t, {persistence});
  await assert.rejects(settings.put(update(Number.MAX_SAFE_INTEGER)), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
  assert.equal(persistence.saves, 0);
  const unknown = sanitizeComfySettingsError(Object.assign(Error(SENTINEL), {code: SENTINEL, status: 999, path: SENTINEL}));
  assert.equal(unknown.code, 'COMFY_SETTINGS_SAVE_FAILED'); assert.equal(unknown.status, 503); safeError(unknown);
  assert.deepEqual(Object.keys(unknown).sort(), ['code', 'message', 'status']);
  assert.equal(comfySettingsError('__proto__').code, 'COMFY_SETTINGS_SAVE_FAILED');
  const clean = sanitizeComfySettingsResult({...await settings.get(), namespace: SENTINEL, path: SENTINEL, apiKey: SENTINEL});
  assert.equal(JSON.stringify(clean).includes(SENTINEL), false);
});

test('close immediately blocks all new access while an in-flight save reaches one durable outcome', async t => {
  const persistence = memory(), settings = await engine(t, {persistence}), gate = deferred(), entered = deferred(), save = persistence.save;
  recordCheck(settings, check());
  persistence.save = async candidate => { entered.resolve(); await gate.promise; return save(candidate); };
  const pending = settings.put(update()); await entered.promise;
  const closing = settings.close();
  assert.throws(() => settings.readCurrent(), {code: 'COMFY_SETTINGS_CLOSED'});
  assert.throws(() => settings.assertCurrent(update()), {code: 'COMFY_SETTINGS_CLOSED'});
  assert.throws(() => settings.recordCheck(check()), {code: 'COMFY_SETTINGS_CLOSED'});
  assert.equal(settings.isReady(config()), false);
  await assert.rejects(settings.get(), {code: 'COMFY_SETTINGS_CLOSED'});
  await assert.rejects(settings.put(update()), {code: 'COMFY_SETTINGS_CLOSED'});
  gate.resolve(); await pending; await closing; await settings.close();
  assert.equal(persistence.saves, 1);
  const restarted = await engine(t, {persistence});
  assert.equal((await restarted.get()).revision, 1); assert.equal(restarted.isReady(), false);
});

test('default file reads never create directories; writes create only one private atomic envelope', async t => {
  const f = await fixture(t), settings = await createComfySettings({directory: f.directory, privateRoot: f.root, reservedPorts});
  t.after(() => settings.close());
  await settings.get(); await settings.get();
  await assert.rejects(stat(f.directory), {code: 'ENOENT'});
  recordCheck(settings, check()); const saved = await settings.put(update());
  assert.equal(saved.readiness.checked, true);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), envelope());
  assert.deepEqual(await readdir(f.directory), ['settings.json']);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  await settings.put(update(1));
  assert.equal((await f.persistence.load()).revision, 2);
  assert.deepEqual(await readdir(f.directory), ['settings.json']);
  const restarted = await createComfySettings({directory: f.directory, privateRoot: f.root, reservedPorts});
  t.after(() => restarted.close());
  assert.equal((await restarted.get()).revision, 2); assert.equal(restarted.isReady(), false);
});

test('unrelated Agent, Images and custom files retain their exact bytes and modes', async t => {
  const f = await fixture(t), files = [];
  for (const name of ['agent-settings', 'image-settings', 'custom-settings']) {
    const directory = path.join(f.root, name), file = path.join(directory, 'settings.json');
    await mkdir(directory, {mode: 0o755}); await writeFile(file, `${name}:${SENTINEL}\n`, {mode: 0o644}); files.push(file);
  }
  const settings = await engine(t, {persistence: f.persistence});
  await settings.put(update());
  for (const file of files) {
    assert.equal(await readFile(file, 'utf8'), `${path.basename(path.dirname(file))}:${SENTINEL}\n`);
    assert.equal((await stat(file)).mode & 0o777, 0o644);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o755);
  }
});

test('invalid, credential-bearing and oversized envelopes never create or overwrite the dedicated file', async t => {
  const f = await fixture(t);
  for (const value of [update(), {...envelope(), namespace: SENTINEL}, {...envelope(), apiKey: SENTINEL},
    {...envelope(), configuration: config({model: 'x'.repeat(COMFY_SETTINGS_LIMITS.envelopeBytes + 1)})}]) {
    assert.throws(() => validateComfySettingsEnvelope(value), {code: 'COMFY_SETTINGS_CORRUPT'});
    await assert.rejects(f.persistence.save(value), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
    await assert.rejects(stat(f.directory), {code: 'ENOENT'});
  }
  await mkdir(f.directory, {mode: 0o700});
  for (const content of ['{"secret":"' + SENTINEL, 'x'.repeat(COMFY_SETTINGS_LIMITS.envelopeBytes + 1),
    JSON.stringify({...envelope(), secret: SENTINEL}), JSON.stringify({...envelope(), namespace: 'agent'})]) {
    await writeFile(f.file, content, {mode: 0o600});
    const settings = await engine(t, {persistence: f.persistence});
    await assert.rejects(settings.get(), error => error.code === 'COMFY_SETTINGS_CORRUPT' && safeError(error));
    await assert.rejects(settings.put(update()), {code: 'COMFY_SETTINGS_CORRUPT'});
    assert.equal(await readFile(f.file, 'utf8'), content);
  }
});

test('symlinked roots, managed parents, directories and files plus hard links fail closed', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t), other = path.join(f.root, 'other'), target = path.join(other, 'target.json');
  await mkdir(other, {mode: 0o700}); await writeFile(target, JSON.stringify(envelope(88)), {mode: 0o600});
  await symlink(other, f.directory);
  await assert.rejects(f.persistence.load(), {code: 'COMFY_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
  await rm(f.directory); await mkdir(f.directory, {mode: 0o700}); await symlink(target, f.file);
  await assert.rejects(f.persistence.load(), {code: 'COMFY_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
  await rm(f.file); await link(target, f.file);
  await assert.rejects(f.persistence.load(), {code: 'COMFY_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
  const alias = path.join(f.root, 'alias'); await symlink(other, alias);
  for (const options of [{directory: path.join(alias, 'comfy-settings'), privateRoot: f.root},
    {directory: path.join(alias, 'comfy-settings'), privateRoot: alias}]) {
    const file = createComfySettingsFile(options);
    await assert.rejects(file.load(), {code: 'COMFY_SETTINGS_CORRUPT'});
    await assert.rejects(file.save(envelope()), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
  }
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), envelope(88));
});

test('unsafe existing permissions and nonregular files are rejected without repair or truncation', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t); await f.persistence.save(envelope());
  for (const [target, mode] of [[f.file, 0o644], [f.directory, 0o755], [f.root, 0o755]]) {
    await chmod(target, mode);
    await assert.rejects(f.persistence.load(), {code: 'COMFY_SETTINGS_CORRUPT'});
    await assert.rejects(f.persistence.save(envelope(2)), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
    assert.equal((await stat(target)).mode & 0o777, mode);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), envelope());
    await chmod(target, target === f.file ? 0o600 : 0o700);
  }
  await rm(f.file); await mkdir(f.file, {mode: 0o700});
  await assert.rejects(f.persistence.load(), {code: 'COMFY_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'COMFY_SETTINGS_SAVE_FAILED'});
  assert.equal((await stat(f.file)).isDirectory(), true);
});

test('path boundaries are absolute and private; raw concurrent readers see only complete atomic envelopes', async t => {
  for (const options of [{directory: 'relative'}, {directory: '/tmp/comfy-settings', privateRoot: '/tmp/other'},
    {directory: '/tmp/comfy-settings', privateRoot: 'relative'}, {directory: '/tmp/comfy\0settings'}]) {
    assert.throws(() => createComfySettingsFile(options), {code: 'COMFY_SETTINGS_CORRUPT'});
  }
  const f = await fixture(t); await f.persistence.save(envelope());
  const observed = [], reader = (async () => { for (let i = 0; i < 30; i++) observed.push(JSON.parse(await readFile(f.file, 'utf8'))); })();
  for (let revision = 2; revision < 12; revision++) await f.persistence.save(envelope(revision));
  await reader;
  for (const value of observed) assert.deepEqual(value, envelope(value.revision));
  assert.deepEqual(await readdir(f.directory), ['settings.json']);
});
