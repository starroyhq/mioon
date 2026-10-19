import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod, stat, symlink, link} from 'node:fs/promises';
import {createImageSettingsFile} from '../packages/business/src/images/settings-file.ts';
import {createImageSettings} from '../packages/business/src/images/settings.ts';
import {DEFAULT_IMAGE_CONFIGURATION, IMAGE_SETTINGS_NAMESPACE} from '../packages/contracts/src/image-settings.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';

const envelope = (revision = 1) => ({version: 1, namespace: IMAGE_SETTINGS_NAMESPACE, revision, configuration: structuredClone(DEFAULT_IMAGE_CONFIGURATION), secret: null});
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-image-file-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'image-settings'), file = path.join(directory, 'settings.json');
  return {root, directory, file, persistence: createImageSettingsFile({directory, privateRoot: root})};
}

test('dedicated image envelope uses private atomic file and reading defaults does not create directories', async t => {
  const f = await fixture(t);
  assert.equal(await f.persistence.load(), null);
  await assert.rejects(stat(f.directory), {code: 'ENOENT'});
  await f.persistence.save(envelope());
  assert.deepEqual(await f.persistence.load(), envelope());
  assert.deepEqual(await readdir(f.directory), ['settings.json']);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  await f.persistence.save(envelope(2));
  assert.deepEqual(await f.persistence.load(), envelope(2));
});

test('image updates preserve independent Agent envelope bytes and neither adopt nor migrate its secrets', async t => {
  const f = await fixture(t), agentDirectory = path.join(f.root, 'agent-settings'), agentFile = path.join(agentDirectory, 'settings.json');
  const original = JSON.stringify({version: 2, revision: 8, configuration: DEFAULT_AGENT_CONFIGURATION, secret: {binding: 'agent-only', encrypted: 'c3ludGhldGlj'}}) + '\n';
  await mkdir(agentDirectory, {mode: 0o700}); await writeFile(agentFile, original, {mode: 0o600});
  const settings = await createImageSettings({persistence: f.persistence});
  assert.equal((await settings.get()).secret.configured, false);
  await settings.put({expectedRevision: 0, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: {action: 'replace', storage: 'session', value: 'synthetic-image-isolated'}});
  assert.equal(await readFile(agentFile, 'utf8'), original);
  assert.equal((await f.persistence.load())!.secret, null);
  await settings.close();
  const wrongFile = createImageSettingsFile({directory: agentDirectory, privateRoot: f.root});
  await assert.rejects(wrongFile.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  const wrongEngine = await createImageSettings({persistence: wrongFile});
  await assert.rejects(wrongEngine.put({expectedRevision: 0, configuration: DEFAULT_IMAGE_CONFIGURATION, secret: {action: 'remove'}}), {code: 'IMAGE_SETTINGS_CORRUPT'});
  assert.equal(await readFile(agentFile, 'utf8'), original);
  await wrongEngine.close();
});

test('plaintext update DTOs, nonimage envelopes, corrupt and oversized file contents fail closed', async t => {
  const f = await fixture(t);
  for (const invalid of [{expectedRevision: 0, configuration: DEFAULT_IMAGE_CONFIGURATION, secret: {action: 'replace', storage: 'session', value: 'synthetic-plaintext'}},
    {...envelope(), namespace: 'agent'}, {...envelope(), secret: {value: 'synthetic-plaintext'}}, {...envelope(), apiKey: 'synthetic-plaintext'}]) {
    await assert.rejects(f.persistence.save(invalid), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    await assert.rejects(stat(f.directory), {code: 'ENOENT'});
  }
  await mkdir(f.directory, {mode: 0o700});
  for (const content of ['{"secret":"synthetic-corrupt', 'x'.repeat(64 * 1024 + 1), JSON.stringify({...envelope(), namespace: 'agent'})]) {
    await writeFile(f.file, content, {mode: 0o600});
    await assert.rejects(f.persistence.load(), (error: unknown) => {const failure = error as {code?: string; message?: string}; return failure.code === 'IMAGE_SETTINGS_CORRUPT' && !failure.message!.includes('synthetic');});
    const settings = await createImageSettings({persistence: f.persistence});
    await assert.rejects(settings.put({expectedRevision: 0, configuration: DEFAULT_IMAGE_CONFIGURATION, secret: {action: 'remove'}}), {code: 'IMAGE_SETTINGS_CORRUPT'});
    assert.equal(await readFile(f.file, 'utf8'), content);
    await settings.close();
  }
});

test('symlinked parents, directory, envelope and hard links fail closed without changing target', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t), other = path.join(f.root, 'other');
  await mkdir(other, {mode: 0o700}); await symlink(other, f.directory);
  await assert.rejects(f.persistence.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  await rm(f.directory); await mkdir(f.directory, {mode: 0o700});
  const target = path.join(other, 'target.json'); await writeFile(target, JSON.stringify(envelope(88)), {mode: 0o600});
  await symlink(target, f.file);
  await assert.rejects(f.persistence.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.equal(JSON.parse(await readFile(target, 'utf8')).revision, 88);
  await rm(f.file); await link(target, f.file);
  await assert.rejects(f.persistence.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  const alias = path.join(f.root, 'parent-alias'); await symlink(other, alias);
  const nested = createImageSettingsFile({directory: path.join(alias, 'nested')});
  await assert.rejects(nested.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await assert.rejects(nested.save(envelope()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
});

test('unsafe file and directory permissions fail closed without chmod repair', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t); await f.persistence.save(envelope());
  await chmod(f.file, 0o644);
  await assert.rejects(f.persistence.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope(2)), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.equal((await stat(f.file)).mode & 0o777, 0o644);
  await chmod(f.file, 0o600); await chmod(f.directory, 0o755);
  await assert.rejects(f.persistence.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope(2)), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  await chmod(f.directory, 0o700); await rm(f.file); await mkdir(f.file, {mode: 0o700});
  await assert.rejects(f.persistence.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
});

test('concurrent raw readers see complete envelopes and no leftover temporary files', async t => {
  const f = await fixture(t); await f.persistence.save(envelope());
  const observed: {revision: number}[] = [];
  const reader = (async () => { for (let index = 0; index < 40; index++) observed.push(JSON.parse(await readFile(f.file, 'utf8'))); })();
  for (let revision = 2; revision <= 10; revision++) await f.persistence.save(envelope(revision));
  await reader;
  for (const value of observed) assert.deepEqual(value, envelope(value.revision));
  assert.deepEqual(await readdir(f.directory), ['settings.json']);
});

test('settings file path is absolute and bounded by a private root', () => {
  for (const options of [{directory: 'relative'}, {directory: '/tmp/image-settings', privateRoot: '/tmp/other'},
    {directory: '/tmp/image-settings', filename: '../agent-settings.tson'}, {directory: '/tmp/image-settings', filename: '/settings.json'}]) {
    assert.throws(() => createImageSettingsFile(options), {code: 'IMAGE_SETTINGS_CORRUPT'});
  }
});
