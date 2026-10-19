import { ensurePrivateDirectory, validatePrivateDirectory } from '@mioon/contracts/private-storage';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyBackendExit, createExitDiagnostics, EXIT_DIAGNOSTIC_LIMITS } from '../apps/desktop/src/exit-diagnostics.ts';

const runtime = { node: '24.14.0', electron: '44.7.0', sqlite: '3.52.0' };
const validEvent = { event: 'exit', classification: 'normal', reason: 'stop-requested', state: 'stopped',
  expected: true, forced: false, exitConfirmed: true, shutdownFailed: false, mediaExitConfirmed: true, code: 0 };

async function fixture(t: TestContext, metadata: Record<string, unknown> | null = { version: '2.3.4-rc.1+build.01', mioonDesktop: { channel: 'production' } }) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-private-exit-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modulePath = path.join(directory, 'build/backend.cjs');
  await mkdir(path.dirname(modulePath));
  if (metadata !== null) await writeFile(path.join(path.dirname(modulePath), 'package.json'), JSON.stringify(metadata));
  const dataDir = path.join(directory, 'private-user-data');
  await mkdir(dataDir, { mode: 0o700 });
  const logDirectory = path.join(dataDir, 'diagnostics');
  const file = path.join(logDirectory, 'backend-exit.jsonl');
  return { directory, modulePath, dataDir, logDirectory, file,
    create: (options: Record<string, unknown> = {}) => createExitDiagnostics({ dataDir, modulePath, versions: runtime, directoryPolicy: { ensurePrivateDirectory, validatePrivateDirectory }, ...options } as Parameters<typeof createExitDiagnostics>[0]) };
}

type ExitRecord = Record<string, unknown> & {runId: string; time: string; appVersion: unknown; channel: unknown; code: unknown; expected: unknown; forced: unknown; termination: unknown; runtime: Record<string, unknown>};
async function records(file: string): Promise<ExitRecord[]> {
  return (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('exit classification preserves the triggering fault and requires confirmed successful shutdown for normal', () => {
  const normal = { reason: 'stop-requested', shutdownFailed: false, forced: false, expected: true, code: 0, mediaExitConfirmed: true };
  for (const [change, expected] of ([
    [{}, 'normal'], [{ reason: null }, 'normal'], [{ expected: false }, 'abnormal'], [{ code: 1 }, 'abnormal'],
    [{ code: '0' }, 'abnormal'], [{ mediaExitConfirmed: false }, 'abnormal'], [{ forced: true, code: 1 }, 'terminated'],
    [{ reason: 'signal-term' }, 'terminated'], [{ reason: 'signal-int' }, 'terminated'],
    [{ reason: 'startup-failed', forced: true }, 'abnormal'], [{ shutdownFailed: true, forced: true }, 'abnormal'],
    [{ reason: 'communication-lost', forced: true }, 'connection-lost'], [{ reason: 'lease-expired' }, 'connection-lost']
  ] as Array<[Record<string, unknown>, string]>)) assert.equal(classifyBackendExit({ ...normal, ...change }), expected, JSON.stringify(change));
});

test('exit diagnostics persist only fixed lifecycle fields with generated run and version metadata', async t => {
  const f = await fixture(t);
  const diagnostics = f.create();
  const before = Date.now();
  assert.equal(diagnostics.record(validEvent), true);
  const after = Date.now();
  const recordsList = await records(f.file); const record = recordsList[0]!;
  assert.deepEqual(record, { ...validEvent, signal: null, termination: null,
    runId: record.runId, time: record.time, appVersion: '2.3.4-rc.1+build.01', channel: 'production', runtime });
  assert.match(record.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Date(record.time).toISOString(), record.time);
  assert.ok(Date.parse(record.time) >= before && Date.parse(record.time) <= after);
  if (process.platform !== 'win32') {
    await chmod(f.logDirectory, 0o777);
    await chmod(f.file, 0o666);
  }
  assert.equal(diagnostics.record({ event: 'start', state: 'starting' }), true);
  assert.equal((await records(f.file))[1].runId, record.runId);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.logDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  }
});

test('unknown and invalid fields never persist private strings or caller supplied identity', async t => {
  const f = await fixture(t);
  const privateValue = 'sk-secret-/Users/private/project/request-body-material-content';
  const event = Object.fromEntries(Object.keys(validEvent).map(key => [key, privateValue]));
  Object.assign(event, { signal: 'SIGKILL', termination: privateValue, runId: privateValue, time: privateValue,
    appVersion: privateValue, channel: privateValue, runtime: privateValue,
    path: f.dataDir, config: { token: privateValue }, request: privateValue, material: privateValue,
    error: { message: privateValue, stack: privateValue }, env: { API_KEY: privateValue } });
  assert.equal(f.create().record(event), true);
  const content = await readFile(f.file, 'utf8');
  assert.ok(!content.includes(privateValue));
  assert.ok(!content.includes(f.dataDir));
  assert.doesNotMatch(content, /SIGKILL|API_KEY|"config"|"error"|"env"|"request"|"material"|"path"/);
  const recordsList = await records(f.file); const record = recordsList[0]!;
  for (const key of [...Object.keys(validEvent), 'termination', 'signal']) assert.equal(record[key], null, key);
});

test('metadata is optional and only bounded exact versions and known channels are retained', async t => {
  const f = await fixture(t, null);
  assert.equal(f.create({ versions: {} }).record({ event: 'start' }), true);
  assert.deepEqual((await records(f.file))[0].runtime, { node: null, electron: null, sqlite: null });
  assert.equal((await records(f.file))[0].appVersion, null);
  assert.equal((await records(f.file))[0].channel, null);
  const metadataFile = path.join(path.dirname(f.modulePath), 'package.json');
  for (const version of ['02.3.4', '2.3.4-01', '^2.3.4', '2.3', '2.3.4\n', '/Users/private/secret', `2.3.4-${'a'.repeat(70)}`]) {
    await writeFile(metadataFile, JSON.stringify({ version, mioonDesktop: { channel: '/Users/private/secret' } }));
    assert.equal(f.create({ versions: { node: '24.0.0\n', electron: '44.7.0-token', sqlite: '/Users/private/secret' } })
      .record({ event: 'start' }), true);
    const record = (await records(f.file)).at(-1)!;
    assert.equal(record.appVersion, null, version);
    assert.equal(record.channel, null);
    assert.deepEqual(record.runtime, { node: null, electron: null, sqlite: null });
  }
  await writeFile(metadataFile, '{malformed');
  assert.equal(f.create().record({ event: 'start' }), true);
  assert.equal((await records(f.file)).at(-1)!.appVersion, null);
});

test('rotation bounds every file and total retained bytes across repeated factories', async t => {
  const f = await fixture(t);
  const runIds = new Set();
  for (let run = 0; run < 12; run++) {
    const diagnostics = f.create();
    for (let index = 0; index < 80; index++) assert.equal(diagnostics.record({ ...validEvent, code: run }), true);
    const files = await readdir(f.logDirectory);
    assert.ok(files.length <= EXIT_DIAGNOSTIC_LIMITS.fileCount);
    let total = 0;
    for (const name of files) {
      assert.match(name, /^backend-exit\.jsonl(?:\.[12])?$/);
      const file = path.join(f.logDirectory, name), info = await stat(file);
      assert.ok(info.size <= EXIT_DIAGNOSTIC_LIMITS.maxBytes);
      total += info.size;
      if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
      for (const record of await records(file)) runIds.add(record.runId);
    }
    assert.ok(total <= EXIT_DIAGNOSTIC_LIMITS.maxBytes * EXIT_DIAGNOSTIC_LIMITS.fileCount);
  }
  assert.equal((await readdir(f.logDirectory)).length, 3);
  assert.ok(runIds.size > 1);
  assert.equal((await records(f.file)).at(-1)!.code, 11);
});

test('an oversized preexisting diagnostic is removed before bounded append', async t => {
  const f = await fixture(t);
  await mkdir(f.logDirectory, { recursive: true });
  for (const suffix of ['', '.1', '.2']) await writeFile(`${f.file}${suffix}`, Buffer.alloc(EXIT_DIAGNOSTIC_LIMITS.maxBytes + 1));
  assert.equal(f.create().record(validEvent), true);
  assert.equal((await records(f.file)).length, 1);
  assert.ok((await stat(f.file)).size <= EXIT_DIAGNOSTIC_LIMITS.maxBytes);
  assert.deepEqual(await readdir(f.logDirectory), ['backend-exit.jsonl']);
});

test('unavailable storage and malformed inputs return false without changing lifecycle', async t => {
  const f = await fixture(t);
  await rm(f.dataDir, { recursive: true });
  await writeFile(f.dataDir, 'directory blocked');
  assert.equal(f.create().record(validEvent), false);
  assert.equal(f.create({ dataDir: undefined }).record(validEvent), false);
  assert.equal(f.create({ dataDir: '' }).record(validEvent), false);
  const errorEvent = Object.defineProperty({}, 'event', { get() { throw new Error('private-error-body'); } });
  assert.equal(f.create().record(errorEvent), false);
  assert.equal(await readFile(f.dataDir, 'utf8'), 'directory blocked');
});

test('diagnostic storage refuses symlink files and directories', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const target = path.join(f.directory, 'private-existing-file');
  await writeFile(target, 'existing private content');
  await mkdir(f.logDirectory, { recursive: true });
  await symlink(target, f.file);
  assert.equal(f.create().record(validEvent), false);
  assert.equal(await readFile(target, 'utf8'), 'existing private content');
  await rm(f.logDirectory, { recursive: true });
  const elsewhere = path.join(f.directory, 'private-existing-directory');
  await mkdir(elsewhere);
  await symlink(elsewhere, f.logDirectory);
  assert.equal(f.create().record(validEvent), false);
  assert.deepEqual(await readdir(elsewhere), []);
});

test('only safe integer exit codes and true booleans are retained', async t => {
  const f = await fixture(t);
  const diagnostics = f.create();
  for (const code of [0, 1, -1, Number.MAX_SAFE_INTEGER, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.equal(diagnostics.record({ event: 'exit', code, expected: 1, forced: 'false', termination: 'utility-kill' }), true);
    const record = (await records(f.file)).at(-1)!;
    assert.equal(record.code, Number.isSafeInteger(code) ? code : null);
    assert.equal(record.expected, null);
    assert.equal(record.forced, null);
    assert.equal(record.termination, 'utility-kill');
  }
});

test('diagnostics inspect only explicit fields and snapshot each exit code once', async t => {
  const f = await fixture(t);
  let reads = 0;
  const event = { event: 'exit', get code() { return reads++ === 0 ? 1 : 'private-caller-string'; },
    get unknown() { throw new Error('must not enumerate'); },
    toJSON() { throw new Error('must not serialize caller object'); } };
  assert.equal(f.create().record(event), true);
  assert.equal(reads, 1);
  assert.equal((await records(f.file))[0].code, 1);
  for (const node of ['24.0.0\r', '24.0.0\u2028', '24.0.0\u2029']) {
    assert.equal(f.create({ versions: { node } }).record({ event: 'start' }), true);
    assert.equal((await records(f.file)).at(-1)!.runtime.node, null);
  }
});

for (const suffix of ['', '.1', '.2']) {
  test(`diagnostic ${suffix || 'current'} hardlink cannot change another file's bytes or permissions`, { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t);
    await mkdir(f.logDirectory, { mode: 0o700 });
    const target = path.join(f.directory, 'unrelated-sentinel');
    await writeFile(target, 'UNCHANGED_SYNTHETIC_SENTINEL', { mode: 0o644 });
    await link(target, `${f.file}${suffix}`);
    const before = await stat(target);
    assert.equal(f.create().record(validEvent), false);
    assert.equal(await readFile(target, 'utf8'), 'UNCHANGED_SYNTHETIC_SENTINEL');
    const after = await stat(target);
    assert.equal(after.mode, before.mode);
    assert.equal(after.ino, before.ino);
    assert.equal(after.nlink, 2);
  });
}

for (const suffix of ['.1', '.2']) {
  test(`diagnostic rotation slot ${suffix} refuses symlinks without changing the target`, { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t);
    await mkdir(f.logDirectory, { mode: 0o700 });
    const target = path.join(f.directory, 'rotation-sentinel');
    await writeFile(target, 'UNCHANGED_ROTATION_SENTINEL', { mode: 0o644 });
    await symlink(target, `${f.file}${suffix}`);
    assert.equal(f.create().record(validEvent), false);
    assert.equal(await readFile(target, 'utf8'), 'UNCHANGED_ROTATION_SENTINEL');
    assert.equal((await stat(target)).mode & 0o777, 0o644);
  });
}

test('file replacement at open is refused before chmod or append', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const diagnostics = f.create();
  assert.equal(diagnostics.record(validEvent), true);
  const original = await readFile(f.file);
  const replacement = path.join(f.directory, 'replacement-sentinel'), retained = `${f.file}.retained`;
  await writeFile(replacement, 'UNCHANGED_REPLACEMENT', { mode: 0o644 });
  const open = fs.openSync, rename = fs.renameSync;
  let swapped = false;
  fs.openSync = (...args) => {
    if (args[0] === f.file && !swapped) {
      swapped = true; rename(f.file, retained); rename(replacement, f.file);
    }
    return open(...args);
  };
  syncBuiltinESMExports();
  try { assert.equal(diagnostics.record(validEvent), false); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(swapped, true);
  assert.equal(await readFile(f.file, 'utf8'), 'UNCHANGED_REPLACEMENT');
  assert.equal((await stat(f.file)).mode & 0o777, 0o644);
  assert.deepEqual(await readFile(retained), original);
});

test('rotation rechecks all slot identities after permission inspection', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const diagnostics = f.create();
  await mkdir(f.logDirectory, { mode: 0o700 });
  await writeFile(f.file, Buffer.alloc(EXIT_DIAGNOSTIC_LIMITS.maxBytes, 32), { mode: 0o600 });
  await writeFile(`${f.file}.1`, 'OLDER', { mode: 0o600 });
  await writeFile(`${f.file}.2`, 'OLDEST', { mode: 0o600 });
  const previous = (await stat(`${f.file}.1`)).ino;
  const chmod = fs.fchmodSync;
  let swapped = false;
  fs.fchmodSync = (descriptor, mode) => {
    chmod(descriptor, mode);
    if (!swapped && fs.fstatSync(descriptor).ino === previous) {
      swapped = true;
      fs.renameSync(`${f.file}.1`, `${f.file}.retained`);
      fs.writeFileSync(`${f.file}.1`, 'UNCHANGED_ROTATION_REPLACEMENT', { mode: 0o644 });
    }
  };
  syncBuiltinESMExports();
  try { assert.equal(diagnostics.record(validEvent), false); }
  finally { fs.fchmodSync = chmod; syncBuiltinESMExports(); }
  assert.equal(swapped, true);
  assert.equal(await readFile(`${f.file}.1`, 'utf8'), 'UNCHANGED_ROTATION_REPLACEMENT');
  assert.equal((await stat(`${f.file}.1`)).mode & 0o777, 0o644);
  assert.equal(await readFile(`${f.file}.2`, 'utf8'), 'OLDEST');
  assert.equal((await stat(f.file)).size, EXIT_DIAGNOSTIC_LIMITS.maxBytes);
});
