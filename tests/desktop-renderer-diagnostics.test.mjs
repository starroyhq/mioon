import { ensurePrivateDirectory, validatePrivateDirectory } from '@mioon/contracts/private-storage';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyRendererEvent, createRendererDiagnostics, installRendererHealthDiagnostics, RENDERER_DIAGNOSTIC_LIMITS } from '../apps/desktop/src/renderer-diagnostics.ts';

const metadata = { version: '2.3.4-rc.1+build.01', mioonDesktop: { channel: 'production' } };

async function fixture(t, manifest = metadata) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-renderer-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modulePath = path.join(directory, 'build/backend.cjs');
  await mkdir(path.dirname(modulePath));
  if (manifest !== null) await writeFile(path.join(path.dirname(modulePath), 'package.json'), JSON.stringify(manifest));
  const dataDir = path.join(directory, 'private-user-data');
  await mkdir(dataDir, { mode: 0o700 });
  const logDirectory = path.join(dataDir, 'diagnostics');
  const file = path.join(logDirectory, 'renderer-health.jsonl');
  const create = options => createRendererDiagnostics({ dataDir, modulePath,
    directoryPolicy: { ensurePrivateDirectory, validatePrivateDirectory }, ...options });
  return { directory, modulePath, dataDir, logDirectory, file, create };
}

async function records(file) {
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
  const contents = new EventEmitter(), recovery = [], recorded = [];
  // The real main registers recovery first; diagnostics are attached afterwards
  // and must not reorder, replace, await or suppress those handlers.
  contents.on('unresponsive', () => recovery.push('unresponsive'));
  contents.on('render-process-gone', (_event, details) => recovery.push(details.reason));
  installRendererHealthDiagnostics(contents, { record: (event, details) => recorded.push({ event, details }) });
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
