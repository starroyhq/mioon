import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod, stat, symlink, link} from 'node:fs/promises';
import {createAgentSettingsFile} from '../packages/business/src/agent/settings-file.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';

const envelope = (revision = 1) => ({version: 2, revision, configuration: {...DEFAULT_AGENT_CONFIGURATION}, secret: null});
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-agent-file-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'agent-settings'), file = path.join(directory, 'settings.json');
  return {root, directory, file, persistence: createAgentSettingsFile({directory})};
}

test('metadata and encrypted material have one private atomic envelope, with no extra credential file', async t => {
  const f = await fixture(t);
  assert.equal(await f.persistence.load(), null);
  await assert.rejects(stat(f.directory), {code: 'ENOENT'}, 'opening settings does not create files');
  await f.persistence.save(envelope());
  assert.deepEqual(await f.persistence.load(), envelope());
  assert.deepEqual(await readdir(f.directory), ['settings.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  }
  await f.persistence.save(envelope(2));
  assert.deepEqual(await f.persistence.load(), envelope(2));
});

test('corrupt and oversized envelopes fail closed without overwrite or raw contents', async t => {
  const f = await fixture(t);
  await mkdir(f.directory, {mode: 0o700});
  for (const content of ['{"secret":"synthetic-corrupt', 'x'.repeat(64 * 1024 + 1)]) {
    await writeFile(f.file, content, {mode: 0o600});
    await assert.rejects(f.persistence.load(), (error: unknown) => {const failure = error as {code?: string; message?: string}; return failure.code === 'AGENT_SETTINGS_CORRUPT' && !String(failure.message).includes('synthetic-corrupt');});
    const settings = await createAgentSettings({persistence: f.persistence});
    await assert.rejects(settings.put({expectedRevision: 0, configuration: {...DEFAULT_AGENT_CONFIGURATION}, secret: {action: 'remove'}}), {code: 'AGENT_SETTINGS_CORRUPT'});
    assert.equal(await readFile(f.file, 'utf8'), content);
  }
});

test('symlinked directory, parent or envelope and hard-linked envelope are rejected', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t), other = path.join(f.root, 'other');
  await mkdir(other, {mode: 0o700});
  await symlink(other, f.directory);
  await assert.rejects(f.persistence.load(), {code: 'AGENT_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'AGENT_SETTINGS_SAVE_FAILED'});
  await rm(f.directory);
  await mkdir(f.directory, {mode: 0o700});
  const target = path.join(other, 'target.json');
  await writeFile(target, JSON.stringify(envelope(88)), {mode: 0o600});
  await symlink(target, f.file);
  await assert.rejects(f.persistence.load(), {code: 'AGENT_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'AGENT_SETTINGS_SAVE_FAILED'});
  assert.equal(JSON.parse(await readFile(target, 'utf8')).revision, 88);
  await rm(f.file); await link(target, f.file);
  await assert.rejects(f.persistence.load(), {code: 'AGENT_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'AGENT_SETTINGS_SAVE_FAILED'});
  const alias = path.join(f.root, 'parent-alias'); await symlink(other, alias);
  const nested = createAgentSettingsFile({directory: path.join(alias, 'nested')});
  await assert.rejects(nested.load(), {code: 'AGENT_SETTINGS_CORRUPT'});
  await assert.rejects(nested.save(envelope()), {code: 'AGENT_SETTINGS_SAVE_FAILED'});
});

test('unsafe owner permissions and invalid file types fail closed without chmod-based bypass', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  await f.persistence.save(envelope());
  await chmod(f.file, 0o644);
  await assert.rejects(f.persistence.load(), {code: 'AGENT_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope(2)), {code: 'AGENT_SETTINGS_SAVE_FAILED'});
  assert.equal((await stat(f.file)).mode & 0o777, 0o644);
  await chmod(f.file, 0o600); await chmod(f.directory, 0o755);
  await assert.rejects(f.persistence.load(), {code: 'AGENT_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope(2)), {code: 'AGENT_SETTINGS_SAVE_FAILED'});
  await chmod(f.directory, 0o700); await rm(f.file); await mkdir(f.file, {mode: 0o700});
  await assert.rejects(f.persistence.load(), {code: 'AGENT_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope(2)), {code: 'AGENT_SETTINGS_SAVE_FAILED'});
});

test('concurrent readers see only old or new complete settings envelopes', async t => {
  const f = await fixture(t);
  await f.persistence.save(envelope());
  const observed: Array<{revision: number}> = [];
  // Raw readers are used here because the stricter protected reader deliberately
  // rejects an inode swap between lstat/open instead of trusting raced metadata.
  const reader = (async () => { for (let i = 0; i < 100; i++) observed.push(JSON.parse(await readFile(f.file, 'utf8'))); })();
  for (let revision = 2; revision <= 10; revision++) await f.persistence.save(envelope(revision));
  await reader;
  for (const value of observed) assert.deepEqual(value, envelope(value.revision));
  assert.deepEqual(await readdir(f.directory), ['settings.json']);
});
