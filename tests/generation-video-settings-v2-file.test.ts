import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, link, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {VIDEO_PROVIDER_NAMES, VIDEO_SETTINGS_LIMITS, defaultVideoModels} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration} from '../packages/contracts/src/video-providers.ts';
import {VIDEO_SETTINGS_V1_RESET_NOTICE} from '../packages/contracts/src/generation-video-settings.ts';
import type {VideoConnectionConfigurationV2} from '../packages/contracts/src/generation-video-settings.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {createVideoSettingsV2} from '../packages/business/src/video/settings-v2.ts';
import {createVideoSettingsV2File, videoSettingsV2FileIdentity} from '../packages/business/src/video/settings-v2-file.ts';

const OLD_KEY = 'synthetic-legacy-video-key';
const legacy = (): VideoConnectionConfiguration => ({id: randomUUID(), providerId: 'minimax', name: 'Legacy video account', region: 'global', workspaceId: '', enabled: true, archived: false, outputHosts: [], models: defaultVideoModels('minimax')});
const current = (): VideoConnectionConfigurationV2 => ({id: randomUUID(), providerId: 'minimax', name: VIDEO_PROVIDER_NAMES.minimax, region: 'global', workspaceId: '', enabled: false, outputHosts: [], models: defaultVideoModels('minimax')});
async function fixture(t: {after(fn: () => unknown): void}, withLegacy = true) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-g1-video-v2-file-'))), options = {directory: path.join(root, 'video-settings'), privateRoot: root};
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = path.join(options.directory, 'settings.json'), configuration = legacy();
  if (withLegacy) {
    const settings = await createVideoSettings(options);
    await settings.put({action: 'save', expectedRevision: 0, configuration, secret: {action: 'replace', value: OLD_KEY, storage: 'session'}});
    await settings.close();
  }
  return {root, file, options, configuration};
}

test('recognized complete video v1 reads as empty v2 without decrypting, importing, consuming its notice or writing', async t => {
  const f = await fixture(t), envelope = JSON.parse(await readFile(f.file, 'utf8'));
  // A syntactically valid opaque ciphertext proves reset does not depend on
  // having a working OS codec or on successfully decrypting historical keys.
  envelope.credentials[0].encrypted = Buffer.from('legacy-opaque-ciphertext').toString('base64');
  await writeFile(f.file, JSON.stringify(envelope), {mode: 0o600});
  const before = await readFile(f.file), info = await stat(f.file); let encryptions = 0, decryptions = 0;
  const secretCodec = {encrypt() {encryptions++; throw Error('Do not encrypt legacy keys');}, decrypt() {decryptions++; throw Error('Do not decrypt legacy keys');}};
  const settings = await createVideoSettingsV2({...f.options, secretCodec}); t.after(() => settings.close());
  for (let read = 0; read < 3; read++) {
    const snapshot = await settings.get(); assert.equal(snapshot.revision, 0); assert.deepEqual(snapshot.connections, []); assert.equal(snapshot.notice, VIDEO_SETTINGS_V1_RESET_NOTICE);
    assert.doesNotMatch(JSON.stringify(snapshot), /Legacy|legacy-opaque|synthetic-legacy|credentialRef|encrypted/);
  }
  assert.deepEqual(await readFile(f.file), before); assert.equal((await stat(f.file)).ino, info.ino);
  assert.equal(encryptions, 0); assert.equal(decryptions, 0);
  await assert.rejects(settings.put({action: 'restoreCredential', expectedRevision: 0}), {code: 'VIDEO_SETTINGS_VALIDATION'});
  assert.equal((await settings.get()).notice, VIDEO_SETTINGS_V1_RESET_NOTICE);
  const saved = await settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}});
  assert.equal(saved.notice, null); assert.equal(saved.revision, 1); assert.equal((await settings.get()).notice, null);
  const disk = JSON.parse(await readFile(f.file, 'utf8')); assert.equal(disk.version, 2); assert.deepEqual(disk.credentials, []);
  assert.doesNotMatch(JSON.stringify(disk), /Legacy|legacy-opaque|synthetic-legacy/); assert.equal(encryptions, 0); assert.equal(decryptions, 0);
});

test('a rejected explicit save retains the legacy reset notice until a later successful save', async t => {
  const f = await fixture(t), before = await readFile(f.file), settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
  await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'replace', storage: 'persistent', value: 'synthetic-new-key'}}), {code: 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.deepEqual(await readFile(f.file), before); assert.equal((await settings.get()).notice, VIDEO_SETTINGS_V1_RESET_NOTICE);
  assert.equal((await settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}})).notice, null);
});

test('malformed legacy envelopes and unknown versions fail closed and cannot be overwritten by v2 saves', async t => {
  for (const mutation of ['json', 'version0', 'version3', 'namespace', 'extra', 'recipient', 'history', 'oversized'] as const) {
    const f = await fixture(t), value = JSON.parse(await readFile(f.file, 'utf8'));
    if (mutation === 'version0') value.version = 0;
    if (mutation === 'version3') value.version = 3;
    if (mutation === 'namespace') value.namespace = 'mioon.images.openai.v1';
    if (mutation === 'extra') value.unknown = true;
    if (mutation === 'recipient') value.credentials[0].endpoint = 'https://attacker.example.com';
    if (mutation === 'history') value.history = [];
    const bytes = mutation === 'json' ? '{broken' : mutation === 'oversized' ? ' '.repeat(VIDEO_SETTINGS_LIMITS.fileBytes + 1) : JSON.stringify(value);
    await writeFile(f.file, bytes, {mode: 0o600}); const settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
    await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_CORRUPT'});
    await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_CORRUPT'});
    assert.equal(await readFile(f.file, 'utf8'), bytes);
  }
});

test('unsafe file modes and linked legacy paths are never treated as recognized resets', {skip: process.platform === 'win32'}, async t => {
  for (const mutation of ['mode', 'directory-mode', 'symlink', 'hardlink'] as const) {
    const f = await fixture(t), before = await readFile(f.file);
    if (mutation === 'mode') await chmod(f.file, 0o644);
    if (mutation === 'directory-mode') await chmod(f.options.directory, 0o755);
    if (mutation === 'symlink') {await rename(f.file, f.file + '.target'); await symlink(f.file + '.target', f.file);}
    if (mutation === 'hardlink') await link(f.file, f.file + '.link');
    const settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
    await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_CORRUPT'});
    await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_CORRUPT'});
    assert.deepEqual(await readFile(f.file), before);
  }
});

test('legacy source changes, deletion and equal-byte inode replacements fence the first save and fault read-back', async t => {
  for (const mutation of ['changed', 'deleted', 'replaced'] as const) {
    const f = await fixture(t), settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
    assert.equal((await settings.get()).notice, VIDEO_SETTINGS_V1_RESET_NOTICE);
    const original = await readFile(f.file), info = await stat(f.file);
    if (mutation === 'changed') {const value = JSON.parse(original.toString()); value.connections[0].configuration.name = 'Different legacy account'; value.history[0].configuration.name = 'Different legacy account'; await writeFile(f.file, JSON.stringify(value), {mode: 0o600});}
    if (mutation === 'deleted') await unlink(f.file);
    if (mutation === 'replaced') {await rename(f.file, f.file + '.original'); await writeFile(f.file, original, {mode: 0o600}); assert.notEqual((await stat(f.file)).ino, info.ino);}
    const external = mutation === 'deleted' ? null : await readFile(f.file);
    await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
    await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
    await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
    if (external === null) await assert.rejects(readFile(f.file), {code: 'ENOENT'}); else assert.deepEqual(await readFile(f.file), external);
  }
});

test('invalid UTF-8 sources fail closed even when replacement decoding yields identical text', async t => {
  const f = await fixture(t), envelope = JSON.parse(await readFile(f.file, 'utf8'));
  envelope.connections[0].configuration.name = 'byte-marker-X'; envelope.history[0].configuration.name = 'byte-marker-X';
  const bytes = Buffer.from(JSON.stringify(envelope));
  for (let index = 0; index < bytes.length; index++) if (bytes.subarray(index, index + 13).toString() === 'byte-marker-X') bytes[index + 12] = 0x80;
  const changed = Buffer.from(bytes); for (let index = 0; index < changed.length; index++) if (changed[index] === 0x80) changed[index] = 0x81;
  assert.equal(bytes.toString('utf8'), changed.toString('utf8')); assert.notDeepEqual(bytes, changed);
  for (const invalid of [bytes, changed]) {
    await writeFile(f.file, invalid, {mode: 0o600});
    const settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
    await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_CORRUPT'});
    await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_CORRUPT'});
    assert.deepEqual(await readFile(f.file), invalid);
  }
});

test('valid UTF-8 replacement characters remain readable in known legacy settings', async t => {
  const f = await fixture(t), envelope = JSON.parse(await readFile(f.file, 'utf8'));
  envelope.connections[0].configuration.name = '合法 Unicode \ufffd'; envelope.history[0].configuration.name = '合法 Unicode \ufffd';
  const bytes = Buffer.from(JSON.stringify(envelope)); await writeFile(f.file, bytes, {mode: 0o600});
  const settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
  assert.equal((await settings.get()).notice, VIDEO_SETTINGS_V1_RESET_NOTICE);
  assert.deepEqual((await settings.get()).connections, []); assert.deepEqual(await readFile(f.file), bytes);
});

test('a file appearing after an initially missing source cannot be overwritten by an empty v2 owner', async t => {
  const f = await fixture(t, false), settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
  assert.equal((await settings.get()).notice, null);
  const author = await createVideoSettings(f.options); await author.put({action: 'save', expectedRevision: 0, configuration: f.configuration, secret: {action: 'keep'}}); await author.close();
  const external = await readFile(f.file);
  await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
  await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_SAVE_FAILED'}); assert.deepEqual(await readFile(f.file), external);
});

test('independent v2 authors cannot overwrite each other and successful saves advance the owner source baseline', async t => {
  const f = await fixture(t, false), owner = await createVideoSettingsV2(f.options); t.after(() => owner.close()); const configuration = current();
  await owner.put({action: 'save', expectedRevision: 0, configuration, secret: {action: 'keep'}});
  const stale = await createVideoSettingsV2(f.options); t.after(() => stale.close());
  await owner.put({action: 'save', expectedRevision: 1, configuration: {...configuration, enabled: true}, secret: {action: 'keep'}});
  const external = await readFile(f.file);
  await assert.rejects(stale.put({action: 'save', expectedRevision: 1, configuration, secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
  await assert.rejects(stale.get(), {code: 'VIDEO_SETTINGS_SAVE_FAILED'}); assert.deepEqual(await readFile(f.file), external);
  assert.equal((await owner.put({action: 'save', expectedRevision: 2, configuration, secret: {action: 'keep'}})).revision, 3);
});

test('symlink substitution after a safe legacy read cannot change the target or clear the source fault', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t), settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
  const original = await readFile(f.file); await rename(f.file, f.file + '.target'); await symlink(f.file + '.target', f.file);
  await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
  await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_SAVE_FAILED'}); assert.deepEqual(await readFile(f.file + '.target'), original);
});

test('v2 persistence rejects saves without an observed baseline and rejects paths outside its private root', async t => {
  const f = await fixture(t, false), file = createVideoSettingsV2File(f.options);
  await assert.rejects(file.save({version: 2, namespace: 'mioon.video.providers.v1', revision: 0, connections: [], history: [], credentials: [], deletedConnectionIds: []}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
  await assert.rejects(readFile(f.file), {code: 'ENOENT'});
  assert.throws(() => createVideoSettingsV2File({directory: path.dirname(f.root), privateRoot: f.root}), {code: 'VIDEO_SETTINGS_CORRUPT'});
});

test('a failed malformed-file load never grants the persistence layer permission to overwrite it', async t => {
  const f = await fixture(t), bytes = '{broken'; await writeFile(f.file, bytes, {mode: 0o600});
  const file = createVideoSettingsV2File(f.options);
  await assert.rejects(file.load(), {code: 'VIDEO_SETTINGS_CORRUPT'});
  await assert.rejects(file.save({version: 2, namespace: 'mioon.video.providers.v1', revision: 0, connections: [], history: [], credentials: [], deletedConnectionIds: []}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
  assert.equal(await readFile(f.file, 'utf8'), bytes);
});

test('file generation identity distinguishes reused POSIX device and inode numbers', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t), original = await stat(f.file), identity = videoSettingsV2FileIdentity(original);
  for (const field of ['birthtimeMs', 'ctimeMs', 'mtimeMs', 'size', 'mode', 'uid', 'nlink'] as const) {
    // Simulate ext4 reusing the same dev/ino, independently of the host allocator.
    const reused = {...original, [field]: original[field] + 1};
    assert.equal(reused.dev, original.dev); assert.equal(reused.ino, original.ino);
    assert.notEqual(videoSettingsV2FileIdentity(reused), identity, field);
  }
});

test('equal bytes on the same inode cannot bypass the save fence after a metadata generation change', async t => {
  const f = await fixture(t), settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
  const bytes = await readFile(f.file), before = await stat(f.file);
  await utimes(f.file, before.atime, new Date(before.mtimeMs + 2000));
  const after = await stat(f.file);
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.deepEqual(await readFile(f.file), bytes);
  assert.notEqual(after.mtimeMs, before.mtimeMs);
  await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
  await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_SAVE_FAILED'}); assert.deepEqual(await readFile(f.file), bytes);
});

test('first publication never clobbers a file appearing at the atomic no-replace commit', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t, false), settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
  const external = Buffer.from('{"external":"another owner"}'), originalLink = fs.linkSync; let inserted = false;
  t.mock.method(fs, 'linkSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === f.file && !inserted) {inserted = true; fs.writeFileSync(f.file, external, {mode: 0o600, flag: 'wx'});}
    return originalLink(source, destination);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(settings.put({action: 'save', expectedRevision: 0, configuration: current(), secret: {action: 'keep'}}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
    assert.equal(inserted, true); assert.deepEqual(await readFile(f.file), external);
    await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
});

test('recognized v1 retains its original uppercase UUID compatibility before resetting to empty v2', async t => {
  const f = await fixture(t), value = JSON.parse(await readFile(f.file, 'utf8'));
  const original = value.connections[0].configuration.id;
  const bytes = Buffer.from(JSON.stringify(value).replaceAll(original, 'ABCDEF12-0000-4000-8000-000000000001'));
  await writeFile(f.file, bytes, {mode: 0o600});
  const settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
  const snapshot = await settings.get(); assert.equal(snapshot.notice, VIDEO_SETTINGS_V1_RESET_NOTICE); assert.deepEqual(snapshot.connections, []); assert.deepEqual(await readFile(f.file), bytes);
});
