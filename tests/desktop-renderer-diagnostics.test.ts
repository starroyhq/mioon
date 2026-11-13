import { ensurePrivateDirectory, validatePrivateDirectory } from '@mioon/contracts/private-storage';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyRendererEvent, createRendererDiagnostics, installRendererHealthDiagnostics, RENDERER_DIAGNOSTIC_LIMITS } from '../apps/desktop/src/renderer-diagnostics.ts';
import {exportDesktopDiagnostics} from '../apps/desktop/src/diagnostics-export.ts';
import {settingsOpenPhases} from '../apps/desktop/src/settings-diagnostics-protocol.ts';
import type {SettingsDiagnosticRecord} from '../apps/desktop/src/settings-diagnostics-protocol.ts';

const metadata = { version: '2.3.4-rc.1+build.01', mioonDesktop: { channel: 'production' } };
const settingsRead: SettingsDiagnosticRecord = {schemaVersion: 1, at: '2026-01-02T03:04:05.000Z',
  event: 'settings-page-read', attempt: 1, page: 'appearance', startedMs: 0, endedMs: 30, durationMs: 30, utilityMaxDelayMs: null};

async function fixture(t: TestContext, manifest: Record<string, unknown> | null = metadata) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-renderer-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modulePath = path.join(directory, 'build/backend.cjs');
  await mkdir(path.dirname(modulePath));
  if (manifest !== null) await writeFile(path.join(path.dirname(modulePath), 'package.json'), JSON.stringify(manifest));
  const dataDir = path.join(directory, 'private-user-data');
  await mkdir(dataDir, { mode: 0o700 });
  const logDirectory = path.join(dataDir, 'diagnostics');
  const file = path.join(logDirectory, 'renderer-health.jsonl');
  const create = (options: Record<string, unknown> = {}) => createRendererDiagnostics({ dataDir, modulePath,
    directoryPolicy: { ensurePrivateDirectory, validatePrivateDirectory }, ...options } as Parameters<typeof createRendererDiagnostics>[0]);
  return { directory, modulePath, dataDir, logDirectory, file, create };
}

type RendererRecord = {at: string; [key: string]: unknown};
async function records(file: string): Promise<RendererRecord[]> {
  return (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('classification preserves renderer event causality without inventing a cause', () => {
  assert.equal(classifyRendererEvent('unresponsive', undefined), 'unresponsive');
  assert.equal(classifyRendererEvent('responsive', undefined), 'responsive');
  for (const [reason, expected] of [['clean-exit', 'exited'], ['abnormal-exit', 'abnormal'], ['killed', 'terminated'],
    ['crashed', 'crashed'], ['oom', 'crashed'], ['launch-failed', 'crashed'], ['integrity-failure', 'crashed']])
    assert.equal(classifyRendererEvent('render-process-gone', { reason, exitCode: 1 }), expected, reason);
  for (const details of [undefined, {}, { reason: 'private-reason' }, 'private'])
    assert.equal(classifyRendererEvent('render-process-gone', details), null, JSON.stringify(details));
  // Classification follows the bounded reason only; a malformed exitCode stays
  // null in the persisted record instead of downgrading a known crash cause.
  assert.equal(classifyRendererEvent('render-process-gone', { reason: 'crashed', exitCode: 'private' }), 'crashed');
  for (const event of ['start', 'ready', undefined, null, 1, { event: 'unresponsive' }])
    assert.equal(classifyRendererEvent(event, { reason: 'crashed' }), null, String(event));
});

test('renderer diagnostics persist only fixed health fields with generated version metadata', async t => {
  const f = await fixture(t);
  const diagnostics = f.create();
  const before = Date.now();
  assert.equal(diagnostics.record('unresponsive'), true);
  assert.equal(diagnostics.record('responsive'), true);
  assert.equal(diagnostics.record('render-process-gone', { reason: 'crashed', exitCode: 139 }), true);
  const after = Date.now();
  const lines = await records(f.file);
  assert.equal(lines.length, 3);
  for (const record of lines) {
    assert.deepEqual(Object.keys(record).sort(), ['appVersion', 'at', 'channel', 'classification', 'event', 'exitCode', 'reason', 'schemaVersion']);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.appVersion, '2.3.4-rc.1+build.01');
    assert.equal(record.channel, 'production');
    assert.equal(new Date(record.at).toISOString(), record.at);
    assert.ok(Date.parse(record.at) >= before && Date.parse(record.at) <= after);
  }
  assert.deepEqual(lines.map(({ event, classification, reason, exitCode }) => ({ event, classification, reason, exitCode })), [
    { event: 'unresponsive', classification: 'unresponsive', reason: null, exitCode: null },
    { event: 'responsive', classification: 'responsive', reason: null, exitCode: null },
    { event: 'render-process-gone', classification: 'crashed', reason: 'crashed', exitCode: 139 },
  ]);
  if (process.platform !== 'win32') {
    await chmod(f.logDirectory, 0o777);
    await chmod(f.file, 0o666);
  }
  assert.equal(diagnostics.record('unresponsive'), true);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.logDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  }
});

test('unknown and hostile fields never persist private strings or caller identity', async t => {
  const f = await fixture(t);
  const privateValue = 'sk-secret-https://renderer.invalid/Users/private/project/document-title/request-body';
  assert.equal(f.create().record('render-process-gone', {
    reason: 'crashed', exitCode: 1, url: privateValue, title: privateValue, content: privateValue,
    path: f.dataDir, token: privateValue, stack: privateValue, error: { message: privateValue, stack: privateValue },
    request: privateValue, material: privateValue, env: { API_KEY: privateValue }, appVersion: privateValue,
    channel: privateValue, at: privateValue, schemaVersion: 99,
  }), true);
  assert.equal(f.create().record(privateValue), true);
  const content = await readFile(f.file, 'utf8');
  assert.ok(!content.includes(privateValue));
  assert.ok(!content.includes(f.dataDir));
  assert.doesNotMatch(content, /"url"|"title"|"content"|"path"|"token"|"stack"|"error"|"request"|"material"|"env"/);
  const lines = await records(f.file);
  assert.deepEqual(lines.map(record => record.event), ['render-process-gone', null]);
  assert.deepEqual(lines.map(record => record.classification), ['crashed', null]);
  assert.deepEqual(lines.map(record => record.schemaVersion), [1, 1]);
});

test('capacity and rotation stay bounded to fileCount files and maxBytes per file', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const diagnostics = f.create();
  // One real record establishes the fixed line size; rotation is asserted with
  // the actual serialized bytes, not an estimate.
  assert.equal(diagnostics.record('unresponsive'), true);
  const line = (await stat(f.file)).size;
  const perFile = Math.floor(RENDERER_DIAGNOSTIC_LIMITS.maxBytes / line);
  const needed = perFile * RENDERER_DIAGNOSTIC_LIMITS.fileCount * 2 + 10;
  for (let index = 0; index < needed; index++) assert.equal(diagnostics.record('unresponsive'), true);
  const names = (await readdir(f.logDirectory)).sort();
  assert.deepEqual(names, ['renderer-health.jsonl', 'renderer-health.jsonl.1', 'renderer-health.jsonl.2']);
  for (const name of names) assert.ok((await stat(path.join(f.logDirectory, name))).size <= RENDERER_DIAGNOSTIC_LIMITS.maxBytes, name);
  let total = 0;
  for (const name of names) total += (await readFile(path.join(f.logDirectory, name), 'utf8')).trim().split('\n').length;
  assert.ok(total <= perFile * RENDERER_DIAGNOSTIC_LIMITS.fileCount, 'the family never exceeds its bounded capacity');
  assert.ok(total < needed, 'rotation drops the oldest records instead of growing without bound');
  assert.ok(total >= perFile * (RENDERER_DIAGNOSTIC_LIMITS.fileCount - 1), 'the bounded family retains the most recent evidence');
});

test('settings diagnostics coalesce into one delayed append and may flush for export', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({apis: ['setTimeout']});
  let writes = 0;
  const diagnostics = f.create({directoryPolicy: {validatePrivateDirectory,
    ensurePrivateDirectory(directory: string, options: {create: true}) {writes++; return ensurePrivateDirectory(directory, options);}}});
  assert.equal(diagnostics.recordSettings(settingsRead), true);
  assert.equal(diagnostics.recordSettings({...settingsRead, attempt: 2}), true);
  assert.equal(writes, 0);
  t.mock.timers.tick(199);
  assert.equal(writes, 0);
  t.mock.timers.tick(1);
  assert.equal(writes, 1);
  assert.deepEqual(await records(f.file), [settingsRead, {...settingsRead, attempt: 2}]);

  assert.equal(diagnostics.recordSettings({...settingsRead, attempt: 3}), true);
  diagnostics.flushSettings();
  t.mock.timers.tick(200);
  assert.equal(writes, 2);
  assert.deepEqual((await records(f.file)).map(row => row.attempt), [1, 2, 3]);
});

test('settings diagnostics retain a bounded batch without delaying renderer health writes', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({apis: ['setTimeout']});
  const diagnostics = f.create();
  for (let attempt = 1; attempt <= 150; attempt++) assert.equal(diagnostics.recordSettings({...settingsRead, attempt}), true);
  assert.equal(diagnostics.record('unresponsive'), true);
  assert.deepEqual((await records(f.file)).map(row => row.event), ['unresponsive']);
  t.mock.timers.tick(200);
  const result = await records(f.file);
  assert.equal(result.length, 65);
  assert.deepEqual(result.slice(1).map(row => row.attempt), Array.from({length: 64}, (_, index) => index + 87));
  const bytesBefore = (await stat(f.file)).size;
  const phases = Object.fromEntries(settingsOpenPhases.map(phase => [phase, 120_000]));
  for (let attempt = 151; attempt <= 214; attempt++) {
    assert.equal(diagnostics.recordSettings({schemaVersion: 1, at: settingsRead.at, attempt, event: 'settings-open-timing',
      mode: 'cold', outcome: 'ready', elapsedMs: 120_000, utilityMaxDelayMs: null, phases}), true);
  }
  t.mock.timers.tick(200);
  const largeRows = (await records(f.file)).slice(result.length);
  assert.ok(largeRows.length > 0 && largeRows.length < 64);
  assert.equal(largeRows.at(-1)?.attempt, 214);
  assert.ok((await stat(f.file)).size - bytesBefore <= 16 * 1024);
});

test('Help export includes only the sanitized diagnostics family in rotation order', async t => {
  const f = await fixture(t);
  assert.equal(f.create().record('responsive'), true);
  const [current] = await records(f.file);
  const privateValue = 'synthetic-private-string';
  await writeFile(f.file + '.2', JSON.stringify({...current, event: 'unresponsive', privateValue}) + '\n', {mode: 0o600});
  const timing = {schemaVersion: 1, at: current.at, event: 'settings-open-slow', attempt: 1,
    mode: 'warm', outcome: 'ready', elapsedMs: 3200, utilityMaxDelayMs: 3000, phases: {mainReceived: 0, show: 150, bootReady: 3200}};
  const page = {schemaVersion: 1, at: current.at, event: 'settings-page-read', attempt: 1, page: 'appearance',
    startedMs: 3100, endedMs: 3150, durationMs: 50, utilityMaxDelayMs: 9};
  const rotated = [
    {...current, event: 'render-process-gone', reason: 'crashed', exitCode: 19, classification: privateValue, token: privateValue},
    {...timing, phases: {...timing.phases, [privateValue]: 1}, token: privateValue},
    {...page, url: privateValue},
    {...page, page: privateValue},
  ];
  await writeFile(f.file + '.1', rotated.map(record => JSON.stringify(record)).join('\n') + '\ninvalid-json\n', {mode: 0o600});
  await writeFile(f.file + '.3', JSON.stringify(current) + '\n', {mode: 0o600});
  await writeFile(path.join(f.logDirectory, 'unrelated.jsonl'), privateValue, {mode: 0o600});
  const destination = path.join(f.directory, 'support.jsonl');
  await writeFile(destination, 'previous export');
  assert.equal(await exportDesktopDiagnostics({dataDir: f.dataDir, destination}), 'saved');
  const result = await records(destination);
  assert.deepEqual(result.map(record => record.event), ['unresponsive', 'render-process-gone', 'settings-open-slow', 'settings-page-read', 'responsive']);
  assert.deepEqual(result.filter(record => 'classification' in record).map(record => record.classification), ['unresponsive', 'crashed', 'responsive']);
  assert.deepEqual(result[2], timing);
  assert.deepEqual(result[3], page);
  assert.equal(result[1].exitCode, 19);
  const output = await readFile(destination, 'utf8');
  assert.ok(!output.includes(privateValue));
  assert.ok(!output.includes(f.directory));
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.deepEqual(await records(f.file), [current]);
});

test('Help export rejects unsafe and oversized sources without altering the selected destination', async t => {
  const f = await fixture(t);
  const destination = path.join(f.directory, 'support.jsonl');
  assert.equal(await exportDesktopDiagnostics({dataDir: f.dataDir, destination}), 'empty');
  await assert.rejects(stat(destination), {code: 'ENOENT'});
  assert.equal(f.create().record('responsive'), true);
  await writeFile(destination, 'previous export');
  const source = f.file + '.1';
  const other = path.join(f.directory, 'unrelated.jsonl');
  await writeFile(other, 'untouched');
  await symlink(other, source);
  await assert.rejects(exportDesktopDiagnostics({dataDir: f.dataDir, destination}));
  assert.equal(await readFile(other, 'utf8'), 'untouched');
  await rm(source);
  await writeFile(source, Buffer.alloc(RENDERER_DIAGNOSTIC_LIMITS.maxBytes + 1), {mode: 0o600});
  await assert.rejects(exportDesktopDiagnostics({dataDir: f.dataDir, destination}));
  assert.equal(await readFile(destination, 'utf8'), 'previous export');
  await rm(source);
  await assert.rejects(exportDesktopDiagnostics({dataDir: f.dataDir, destination: f.file}));
  const privateFile = path.join(f.dataDir, 'local-data.jsonl');
  await writeFile(privateFile, 'unrelated private data', {mode: 0o600});
  await assert.rejects(exportDesktopDiagnostics({dataDir: f.dataDir, destination: privateFile}));
  assert.equal(await readFile(privateFile, 'utf8'), 'unrelated private data');
  const redirect = path.join(f.directory, 'symlink.jsonl');
  await symlink(other, redirect);
  await assert.rejects(exportDesktopDiagnostics({dataDir: f.dataDir, destination: redirect}));
  assert.equal(await readFile(other, 'utf8'), 'untouched');
  assert.deepEqual((await records(f.file)).map(record => record.event), ['responsive']);
});

test('Help export rechecks the native owner before publication and removes the staged file on refusal', async t => {
  const f = await fixture(t);
  assert.equal(f.create().record('responsive'), true);
  const destination = path.join(f.directory, 'support.jsonl');
  const expired = Error('Native save owner expired');
  let checks = 0;
  const before = (await readdir(f.directory)).sort();
  await assert.rejects(exportDesktopDiagnostics({dataDir: f.dataDir, destination,
    check: () => {if (++checks === 3) throw expired;}}), expired);
  assert.deepEqual((await readdir(f.directory)).sort(), before);
});

test('write, rotation and permission failures are tolerated and never throw', async t => {
  const f = await fixture(t);
  assert.equal(createRendererDiagnostics({ dataDir: null, modulePath: f.modulePath,
    directoryPolicy: { ensurePrivateDirectory, validatePrivateDirectory } }).record('unresponsive'), false);
  assert.equal(f.create({ directoryPolicy: { ensurePrivateDirectory: () => { throw new Error('private storage unavailable'); },
    validatePrivateDirectory } }).record('unresponsive'), false);
  // A regular file where the diagnostics directory belongs must fail closed.
  const blocked = await fixture(t);
  await writeFile(blocked.logDirectory, 'not-a-directory');
  assert.equal(blocked.create().record('unresponsive'), false);
  // A symlinked log file must be rejected without touching its target.
  const linked = await fixture(t);
  const victim = path.join(linked.directory, 'victim.txt');
  await writeFile(victim, 'do-not-touch');
  await mkdir(linked.logDirectory, { recursive: true });
  await symlink(victim, linked.file);
  assert.equal(linked.create().record('unresponsive'), false);
  assert.equal(await readFile(victim, 'utf8'), 'do-not-touch');
  // A hard-linked log file is not privately owned and is rejected as well.
  const hardLinked = await fixture(t);
  await mkdir(hardLinked.logDirectory, { recursive: true });
  await writeFile(hardLinked.file, '');
  await link(hardLinked.file, path.join(hardLinked.directory, 'other-link'));
  assert.equal(hardLinked.create().record('unresponsive'), false);
  // Read-only directories fail without changing process/caller state.
  const readOnly = await fixture(t);
  await mkdir(readOnly.logDirectory, { recursive: true });
  if (process.platform !== 'win32') await chmod(readOnly.logDirectory, 0o500);
  try { readOnly.create().record('unresponsive'); }
  finally { if (process.platform !== 'win32') await chmod(readOnly.logDirectory, 0o700); }
});

test('installation is additive: existing recovery handlers still run and diagnostics never leak', () => {
  const contents = new EventEmitter(), recovery: string[] = [], recorded: Array<{event: unknown; details: unknown}> = [];
  // The real main registers recovery first; diagnostics are attached afterwards
  // and must not reorder, replace, await or suppress those handlers.
  contents.on('unresponsive', () => recovery.push('unresponsive'));
  contents.on('render-process-gone', (_event, details) => recovery.push(details.reason));
  installRendererHealthDiagnostics(contents, { record: (event: unknown, details: unknown) => { recorded.push({event, details}); return true; } });
  contents.emit('unresponsive');
  contents.emit('responsive');
  contents.emit('render-process-gone', { private: 'event-object' }, { reason: 'crashed', exitCode: 139, url: 'https://private.invalid', token: 'sk-private', content: 'document body' });
  assert.deepEqual(recovery, ['unresponsive', 'crashed']);
  assert.deepEqual(recorded, [
    { event: 'unresponsive', details: undefined },
    { event: 'responsive', details: undefined },
    { event: 'render-process-gone', details: { reason: 'crashed', exitCode: 139 } },
  ]);
  // Diagnostic failures and unusual webContents surfaces are contained.
  const throwing = new EventEmitter();
  throwing.on('unresponsive', () => recovery.push('recovery-after-failure'));
  installRendererHealthDiagnostics(throwing, { record: () => { throw new Error('diagnostic transport failed'); } });
  assert.doesNotThrow(() => throwing.emit('unresponsive'));
  assert.equal(recovery.at(-1), 'recovery-after-failure');
  assert.doesNotThrow(() => installRendererHealthDiagnostics({ on() { throw new Error('no listener surface'); } }, { record: () => true }));
  assert.doesNotThrow(() => installRendererHealthDiagnostics(new EventEmitter(), null));
});
