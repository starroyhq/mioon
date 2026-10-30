import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, chmod, stat, lstat, writeFile, readFile, readdir, rm, symlink, link, rename} from 'node:fs/promises';
import {lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import desktopIdentity from '../apps/desktop/identity.ts';
import {dataPaths, prepareDesktopStorage, showStorageStartupFailure, storageFailureDialog, ensureDataIdentity,
  readToolConfig, saveToolConfig, writeConnection, removeConnection, removeConnectionOnShutdown} from '../apps/desktop/src/config.ts';
import {createDesktopAgentSettings} from '../apps/desktop/src/secret-store.ts';
import {QuitCoordinator} from '../apps/desktop/src/lifecycle.ts';

const identity = desktopIdentity.identityForChannel('development');
const privateError = (error: unknown) => (error as {code?: string}).code === 'STORAGE_PRIVATE_REQUIRED';
const posix = {skip: process.platform === 'win32'};
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-desktop-private-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const userData = path.join(root, 'user-data');
  await mkdir(userData, {mode: 0o700});
  return {root, userData, paths: dataPaths(root, userData)};
}
interface FakeApp extends EventEmitter {getPath(name: string): string; setPath(name: string, directory: string): void; whenReady(): Promise<void>; exit(code: number): void; requestSingleInstanceLock(): boolean}
function fakeApp(appData: string): {app: FakeApp; calls: unknown[][]} {
  const calls: unknown[][] = [];
  const app = new EventEmitter() as FakeApp;
  app.getPath = (name: string) => { assert.equal(name, 'appData'); return appData; };
  app.setPath = (name: string, directory: string) => {
    assert.equal(lstatSync(directory).mode & 0o777, 0o700, 'Electron receives only a verified private directory');
    calls.push(['setPath', name, directory]);
  };
  app.whenReady = async () => { calls.push(['ready']); };
  app.exit = (code: number) => { calls.push(['exit', code]); app.emit('quit'); };
  app.requestSingleInstanceLock = () => { calls.push(['lock']); return true; };
  return {app, calls};
}
interface SnapshotEntry {name: string; mode: number; ino: number; nlink: number; bytes: string | null; children: SnapshotEntry[] | null}
async function snapshot(directory: string): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name), info = await lstat(file);
    entries.push({name, mode: info.mode, ino: info.ino, nlink: info.nlink,
      bytes: info.isFile() ? (await readFile(file)).toString('base64') : null,
      children: info.isDirectory() ? await snapshot(file) : null});
  }
  return entries;
}

test('desktop prepares a private empty root before any Electron path change', posix, async t => {
  const f = await fixture(t), {app, calls} = fakeApp(f.root);
  const target = path.join(f.root, 'new', 'profile');
  const paths = prepareDesktopStorage(app as unknown as Parameters<typeof prepareDesktopStorage>[0], target, identity.channel);
  assert.equal(paths.userData, target);
  assert.deepEqual(calls, [['setPath', 'userData', target]]);
  assert.deepEqual(await readdir(target), []);
  assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
});

for (const mode of [0o755, 0o777]) test(`desktop rejects existing ${mode.toString(8)} root without changing bytes, modes or Electron paths`, posix, async t => {
  const f = await fixture(t), {app, calls} = fakeApp(f.root);
  await writeFile(path.join(f.userData, 'untouched.txt'), 'synthetic original', {mode: 0o600});
  await chmod(f.userData, mode);
  const before = await snapshot(f.userData);
  assert.throws(() => prepareDesktopStorage(app as unknown as Parameters<typeof prepareDesktopStorage>[0], f.userData), privateError);
  assert.deepEqual(calls, []);
  assert.deepEqual(await snapshot(f.userData), before);
  assert.equal((await stat(f.userData)).mode & 0o777, mode);
  await assert.rejects(ensureDataIdentity(f.paths, identity), privateError);
  assert.deepEqual(await snapshot(f.userData), before);
});

test('desktop rejects a symlink root or ancestor before creating anything outside it', posix, async t => {
  const f = await fixture(t), {app, calls} = fakeApp(f.root);
  const outside = path.join(f.root, 'outside'), alias = path.join(f.root, 'alias');
  await mkdir(outside, {mode: 0o700}); await symlink(outside, alias);
  for (const directory of [alias, path.join(alias, 'new', 'profile')]) {
    assert.throws(() => prepareDesktopStorage(app as unknown as Parameters<typeof prepareDesktopStorage>[0], directory), privateError);
    assert.deepEqual(await readdir(outside), []);
  }
  assert.deepEqual(calls, []);
});

const unsafeChildren: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>]> = [
  ['workspace root', async f => { await mkdir(f.paths.dataDir, {mode: 0o755}); }],
  ['workspace media link', async f => { await mkdir(f.paths.dataDir, {mode: 0o700}); await symlink(f.root, path.join(f.paths.dataDir, 'media')); }],
  ['workspace SQLite link', async f => { await mkdir(f.paths.dataDir, {mode: 0o700}); await symlink(path.join(f.root, 'original'), path.join(f.paths.dataDir, 'workbench.sqlite')); }],
  ['workspace token mode', async f => { await mkdir(f.paths.dataDir, {mode: 0o700}); await writeFile(path.join(f.paths.dataDir, 'access-token'), 'synthetic-token', {mode: 0o644}); }],
  ['settings directory', async f => { await mkdir(path.join(f.userData, 'agent-settings'), {mode: 0o755}); }],
  ['settings envelope mode', async f => { await mkdir(path.join(f.userData, 'agent-settings'), {mode: 0o700}); await writeFile(path.join(f.userData, 'agent-settings', 'settings.json'), '{synthetic', {mode: 0o644}); }],
  ['identity mode', async f => { await writeFile(path.join(f.userData, 'desktop-identity.json'), '{}', {mode: 0o644}); }],
  ['config hardlink', async f => { await writeFile(path.join(f.root, 'original'), '{}', {mode: 0o600}); await link(path.join(f.root, 'original'), f.paths.configFile); }],
  ['discovery oversized', async f => { await writeFile(path.join(f.userData, 'mcp-connection.json'), 'x'.repeat(16 * 1024 + 1), {mode: 0o600}); }],
];
for (const [name, arrange] of unsafeChildren) test(`desktop preflights unsafe ${name} before identity and Electron writes`, posix, async t => {
  const f = await fixture(t), {app, calls} = fakeApp(f.root);
  await arrange(f);
  const before = await snapshot(f.userData);
  assert.throws(() => prepareDesktopStorage(app as unknown as Parameters<typeof prepareDesktopStorage>[0], f.userData), privateError);
  assert.deepEqual(calls, []);
  await assert.rejects(ensureDataIdentity(f.paths, identity), privateError);
  assert.deepEqual(await snapshot(f.userData), before);
});

test('desktop preserves channel separation before handing a directory to Electron', posix, async t => {
  const f = await fixture(t), {app, calls} = fakeApp(f.root);
  await ensureDataIdentity(f.paths, desktopIdentity.identityForChannel('production'));
  const before = await snapshot(f.userData);
  assert.throws(() => prepareDesktopStorage(app as unknown as Parameters<typeof prepareDesktopStorage>[0], f.userData, 'development'), /another app channel/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await snapshot(f.userData), before);
});

test('private corrupt settings JSON stays scoped to settings rather than blocking desktop metadata preflight', posix, async t => {
  const f = await fixture(t), {app, calls} = fakeApp(f.root);
  await mkdir(path.join(f.userData, 'agent-settings'), {mode: 0o700});
  const file = path.join(f.userData, 'agent-settings', 'settings.json');
  await writeFile(file, '{broken synthetic envelope', {mode: 0o600});
  prepareDesktopStorage(app as unknown as Parameters<typeof prepareDesktopStorage>[0], f.userData);
  assert.equal(calls[0]?.[0], 'setPath');
  const settings = await createDesktopAgentSettings({userData: f.userData, appId: identity.appId, safeStorage: {isEncryptionAvailable: () => false} as unknown as Parameters<typeof createDesktopAgentSettings>[0]['safeStorage']});
  await assert.rejects(settings.get(), {code: 'AGENT_SETTINGS_CORRUPT'});
  assert.equal(await readFile(file, 'utf8'), '{broken synthetic envelope');
  await settings.close();
});

test('desktop identity and tool config reject linked or oversized files without reading/replacing their targets', posix, async t => {
  const f = await fixture(t), target = path.join(f.root, 'target');
  await writeFile(target, '{"ffmpeg":"synthetic secret"}', {mode: 0o600});
  await symlink(target, f.paths.configFile);
  await assert.rejects(readToolConfig(f.paths.configFile, {}), privateError);
  await assert.rejects(saveToolConfig(f.paths.configFile, {ffmpeg: '/safe', ffprobe: '/safe'}), privateError);
  assert.equal(await readFile(target, 'utf8'), '{"ffmpeg":"synthetic secret"}');
  await rm(f.paths.configFile);
  await writeFile(f.paths.configFile, 'x'.repeat(64 * 1024 + 1), {mode: 0o600});
  await assert.rejects(readToolConfig(f.paths.configFile, {}), privateError);
  const marker = path.join(f.userData, 'desktop-identity.json');
  await rm(f.paths.configFile); await link(target, marker);
  await assert.rejects(ensureDataIdentity(f.paths, identity), privateError);
  assert.equal((await stat(target)).nlink, 2);
});

test('desktop discovery validates both existing files before rotating or removing either one', posix, async t => {
  const f = await fixture(t), token = path.join(f.userData, 'mcp-token'), descriptor = path.join(f.userData, 'mcp-connection.json');
  await writeConnection(f.paths, {url: 'http://127.0.0.1:12345', token: 'old-synthetic', pid: process.pid});
  await chmod(descriptor, 0o644);
  const before = await snapshot(f.userData);
  await assert.rejects(writeConnection(f.paths, {url: 'http://127.0.0.1:12346', token: 'new-synthetic', pid: process.pid}), privateError);
  await assert.rejects(removeConnection(f.paths), privateError);
  assert.deepEqual(await snapshot(f.userData), before);
  await chmod(descriptor, 0o600); await rm(token);
  const target = path.join(f.root, 'outside-token');
  await writeFile(target, 'outside-synthetic', {mode: 0o600}); await symlink(target, token);
  const beforeLinked = await snapshot(f.userData);
  await assert.rejects(removeConnection(f.paths), privateError);
  assert.deepEqual(await snapshot(f.userData), beforeLinked);
  assert.equal(await readFile(target, 'utf8'), 'outside-synthetic');
});

test('desktop atomic writers leave attacker-created legacy temporary paths untouched', posix, async t => {
  const f = await fixture(t), target = path.join(f.root, 'outside');
  await writeFile(target, 'untouched synthetic target', {mode: 0o600});
  const sentinels = ['desktop-config.json.tmp', 'mcp-token.tmp', 'mcp-connection.json.tmp'];
  for (const name of sentinels) await symlink(target, path.join(f.userData, name));
  await saveToolConfig(f.paths.configFile, {ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe'});
  await writeConnection(f.paths, {url: 'http://127.0.0.1:12345', token: 'synthetic', pid: process.pid});
  await ensureDataIdentity(f.paths, identity);
  for (const name of sentinels) assert.equal((await lstat(path.join(f.userData, name))).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), 'untouched synthetic target');
  for (const name of ['desktop-config.json', 'mcp-token', 'mcp-connection.json', 'desktop-identity.json']) assert.equal((await stat(path.join(f.userData, name))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(f.userData)).filter(name => name.startsWith('.')), []);
});

test('desktop settings recheck the userData privacy boundary on each save', posix, async t => {
  const f = await fixture(t);
  const settings = await createDesktopAgentSettings({userData: f.userData, appId: identity.appId, safeStorage: {isEncryptionAvailable: () => false} as unknown as Parameters<typeof createDesktopAgentSettings>[0]['safeStorage']});
  t.after(() => settings.close());
  const initial = await settings.get();
  await chmod(f.userData, 0o755);
  await assert.rejects(settings.put({expectedRevision: initial.revision, configuration: initial.configuration, secret: {action: 'remove'}}), {code: 'AGENT_SETTINGS_SAVE_FAILED'});
  assert.deepEqual(await readdir(f.userData), []);
  assert.equal((await stat(f.userData)).mode & 0o777, 0o755);
});

test('fatal startup uses only a fresh private diagnostic directory, shows actionable UI, then cleans it at quit', posix, async t => {
  const f = await fixture(t), {app, calls} = fakeApp(f.root);
  await chmod(f.userData, 0o755);
  const before = await snapshot(f.root); const messages: Array<Record<string, unknown>> = [];
  const dialog = {showMessageBox: async (message: Record<string, unknown>) => { messages.push(message); calls.push(['dialog']); }, showErrorBox: () => assert.fail('unexpected pre-ready fallback')};
  await showStorageStartupFailure(app as unknown as Parameters<typeof showStorageStartupFailure>[0], dialog as unknown as Parameters<typeof showStorageStartupFailure>[1], {code: 'STORAGE_PRIVATE_REQUIRED'}, {temporaryRoot: f.root});
  const diagnostic = calls[0]?.[2];
  assert.notEqual(diagnostic, f.userData);
  assert.deepEqual(calls, [['setPath', 'userData', diagnostic], ['setPath', 'sessionData', diagnostic], ['ready'], ['dialog'], ['exit', 1]]);
  assert.match((messages[0] as {detail: string}).detail, /MIOON_DESKTOP_USER_DATA/);
  assert.deepEqual(await snapshot(f.root), before);
});

test('fatal startup never uses default userData or readiness if a diagnostic directory cannot be verified', posix, async t => {
  const f = await fixture(t), {app, calls} = fakeApp(f.root), boxes: unknown[][] = [];
  const alias = path.join(f.root, 'tmp-alias'); await symlink(f.userData, alias);
  const dialog = {showMessageBox: () => assert.fail('must not initialize UI') as unknown, showErrorBox: (...args: unknown[]) => boxes.push(args)};
  await showStorageStartupFailure(app as unknown as Parameters<typeof showStorageStartupFailure>[0], dialog as unknown as Parameters<typeof showStorageStartupFailure>[1], {code: 'STORAGE_PRIVATE_REQUIRED'}, {temporaryRoot: alias});
  assert.deepEqual(calls, [['exit', 1]]);
  assert.equal(boxes.length, 1);
  assert.deepEqual(await readdir(f.userData), []);
});

test('diagnostic cleanup preserves a replacement directory instead of deleting an ambiguous path', posix, async t => {
  const f = await fixture(t), {app, calls} = fakeApp(f.root);
  let replacement: string | undefined;
  const dialog = {showMessageBox: async () => {
    replacement = calls[0]?.[2] as string;
    await rename(replacement, `${replacement}-original`);
    await mkdir(replacement, {mode: 0o700});
    await writeFile(path.join(replacement, 'keep'), 'synthetic replacement', {mode: 0o600});
  }, showErrorBox: () => assert.fail('unexpected fallback')};
  await showStorageStartupFailure(app as unknown as Parameters<typeof showStorageStartupFailure>[0], dialog as unknown as Parameters<typeof showStorageStartupFailure>[1], {code: 'STORAGE_PRIVATE_REQUIRED'}, {temporaryRoot: f.root});
  assert.equal(await readFile(path.join(replacement!, 'keep'), 'utf8'), 'synthetic replacement');
});

test('main isolates fatal storage handling from lock acquisition and normal readiness', async () => {
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /try \{ initializeDesktopPrivateStorage\(privateStorageHelperFile\(app\)\); paths = prepareDesktopStorage\(/);
  assert.match(main, /if \(startupStorageError\) void showStorageStartupFailure\(app, dialog, startupStorageError\);\s*else if \(!app\.requestSingleInstanceLock\(\)\)/);
  assert.doesNotMatch(main, /mkdirSync\(paths\.userData|app\.setPath\('userData', paths\.userData\)/);
});

test('fatal startup copy distinguishes identity, channel, canonical-path and ACL blockers without raw errors', () => {
  const channel = storageFailureDialog({code: 'DESKTOP_CHANNEL_MISMATCH', message: 'synthetic-private-path'});
  assert.match(channel.message, /另一个应用通道/);
  assert.match(channel.detail, /不要删除或改写现有标识/);
  assert.doesNotMatch(channel.detail, /synthetic-private-path/);
  assert.match(storageFailureDialog({code: 'DESKTOP_IDENTITY_INVALID'}).message, /标识无法读取/);
  assert.match(storageFailureDialog({code: 'STORAGE_PRIVATE_REQUIRED', reason: 'SYMBOLIC_LINK'}).detail, /真实的绝对路径/);
  assert.match(storageFailureDialog({code: 'STORAGE_PRIVACY_UNAVAILABLE'}).detail, /ACL/);
});

test('quit preserves newly unsafe discovery, warns once without secrets and still stops backend and clears session exactly once', posix, async t => {
  const f = await fixture(t), warnings: unknown[] = [];
  await writeConnection(f.paths, {url: 'http://127.0.0.1:12345', token: 'synthetic-never-log-token', pid: process.pid});
  await chmod(path.join(f.userData, 'mcp-token'), 0o644);
  const before = await snapshot(f.userData);
  let backendStops = 0, sessionClears = 0, finished = 0; let ready: boolean | null = true;
  const coordinator = new QuitCoordinator({getWindow: () => null, stop: async () => {
    backendStops++;
    assert.equal(await removeConnectionOnShutdown(f.paths, {warn: message => warnings.push(message)}), false);
    sessionClears++; ready = null;
  }, finish: () => finished++});
  await Promise.all([coordinator.request(), coordinator.request()]);
  await coordinator.request();
  assert.equal(coordinator.state, 'finished');
  assert.equal(backendStops, 1); assert.equal(sessionClears, 1); assert.equal(finished, 1); assert.equal(ready, null);
  assert.deepEqual(await snapshot(f.userData), before);
  assert.deepEqual(warnings, ['DESKTOP_DISCOVERY_CLEANUP_SKIPPED: Discovery files were preserved because storage privacy checks failed.']);
  assert.doesNotMatch(String(warnings[0]), /synthetic-never-log-token|mcp-token|user-data|127\.0\.0\.1/);
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /await backend\?\.stop\(\);\s*await cleanupStoppedBackend\(\);/);
  assert.match(main, /async function cleanupStoppedBackend\(\)\s*\{\s*await removeConnectionOnShutdown\(paths\);\s*await activeSession\?\.clearStorageData\(\);\s*activeSession = null;\s*ready = null;/);
});

test('shutdown cleanup keeps non-privacy programming errors visible', async () => {
  const warnings: unknown[] = [];
  await assert.rejects(removeConnectionOnShutdown(undefined as unknown as Parameters<typeof removeConnectionOnShutdown>[0], {warn: message => warnings.push(message)}), TypeError);
  assert.deepEqual(warnings, []);
});
