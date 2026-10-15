import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BackendSupervisor } from '../apps/desktop/src/supervisor.mjs';

const sensitive = 'private-token-request-body-/Users/private/movie.mp4';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { graceful = true, ready = true, ...options } = {}) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-exit-supervisor-'));
  const dataDir = path.join(directory, 'workspace'), modulePath = path.join(directory, 'backend.cjs');
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.4.1', mioonDesktop: { channel: 'production' } }));
  const children = [];
  const fork = () => {
    const child = new EventEmitter();
    child.messages = [];
    child.killCalls = 0;
    child.postMessage = message => {
      child.messages.push(message);
      if (message.type === 'start' && ready) setImmediate(() => child.emit('message', {
        type: 'ready', url: 'http://127.0.0.1:43210', runtime: { node: sensitive, token: sensitive }
      }));
      if (message.type === 'stop' && graceful) setImmediate(() => child.emit('exit', 0));
    };
    child.kill = () => { child.killCalls++; };
    children.push(child);
    return child;
  };
  const supervisor = new BackendSupervisor({ fork, modulePath, environment: { PRIVATE_API_KEY: sensitive },
    stopTimeout: 10, terminateTimeout: 10, exitTimeout: 10, forceKill: () => {}, ...options });
  const records = async () => (await readFile(path.join(dataDir, 'diagnostics/backend-exit.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  const config = { dataDir, distDir: sensitive, token: sensitive };
  t.after(async () => {
    if (supervisor.child) supervisor.child.emit('exit', 1);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, supervisor, config, records, children,
    get child() { return children.at(-1); } };
}

test('requested zero exit is normal, persisted before listeners, and contains only safe metadata', async t => {
  const f = await fixture(t);
  await f.supervisor.start(f.config);
  let exitObserved = false;
  f.supervisor.once('exit', () => {
    exitObserved = true;
    const last = JSON.parse(readFileSync(path.join(f.config.dataDir, 'diagnostics/backend-exit.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(last.event, 'exit');
    assert.equal(last.exitConfirmed, true);
  });
  await f.supervisor.stop();
  assert.equal(exitObserved, true);
  const records = await f.records(), exit = records.at(-1);
  assert.deepEqual(records.map(record => record.event), ['start', 'ready', 'stop-requested', 'exit']);
  assert.equal(exit.classification, 'normal');
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null, 'Electron utility exit supplies no signal');
  assert.equal(exit.expected, true);
  assert.equal(exit.forced, false);
  assert.equal(exit.exitConfirmed, true);
  assert.equal(exit.state, 'stopping');
  assert.equal(exit.appVersion, '0.4.1');
  assert.equal(exit.channel, 'production');
  assert.equal(Number.isNaN(Date.parse(exit.time)), false);
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes(sensitive), false);
  assert.equal(serialized.includes(f.directory), false);
});

for (const code of [0, 9, null]) {
  test(`unsolicited utility exit ${code} is abnormal and never triggers an automatic replacement`, async t => {
    const f = await fixture(t);
    await f.supervisor.start(f.config);
    f.child.emit('exit', code);
    await tick();
    const exit = (await f.records()).at(-1);
    assert.equal(exit.classification, 'abnormal');
    assert.equal(exit.reason, 'utility-exit');
    assert.equal(exit.code, code);
    assert.equal(exit.expected, false);
    assert.equal(exit.exitConfirmed, true);
    assert.equal(f.children.length, 1);
    assert.equal(f.supervisor.state, 'failed');
  });
}

test('stop escalation records each attempted termination separately from exit confirmation', async t => {
  const f = await fixture(t, { graceful: false });
  await f.supervisor.start(f.config);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(f.supervisor.stop(), { code: 'BACKEND_STOP_UNCONFIRMED' });
  t.mock.timers.tick(10);
  t.mock.timers.tick(10);
  t.mock.timers.tick(10);
  await rejected;
  let records = await f.records();
  assert.deepEqual(records.filter(record => record.event === 'termination-requested').map(record => record.termination),
    ['utility-kill', 'owned-sigkill']);
  assert.equal(records.at(-1).event, 'stop-unconfirmed');
  assert.equal(records.at(-1).exitConfirmed, false);
  assert.equal(records.some(record => record.event === 'exit'), false);
  assert.throws(() => f.supervisor.start(f.config), /already active/);
  f.child.emit('exit', 0);
  records = await f.records();
  assert.equal(records.at(-1).classification, 'terminated', 'a later zero code does not erase the forced stop');
  assert.equal(records.at(-1).state, 'stop-unconfirmed');
  assert.equal(records.at(-1).exitConfirmed, true);
});

test('heartbeat IPC loss is distinct from a utility crash even after a supervisor kill', async t => {
  const f = await fixture(t);
  let heartbeat;
  t.mock.method(globalThis, 'setInterval', callback => { heartbeat = callback; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  await f.supervisor.start(f.config);
  f.child.postMessage = () => { throw new Error(sensitive); };
  heartbeat();
  assert.equal(f.child.killCalls, 1);
  f.child.emit('exit', 1);
  const exit = (await f.records()).at(-1);
  assert.equal(exit.classification, 'connection-lost');
  assert.equal(exit.reason, 'communication-lost');
  assert.equal(exit.expected, false);
  assert.equal(exit.forced, true);
  assert.equal(JSON.stringify(await f.records()).includes(sensitive), false);
});

for (const [reason, classification] of [['lease-expired', 'connection-lost'], ['signal-term', 'terminated'],
  ['signal-int', 'terminated'], ['uncaught-exception', 'abnormal'], ['unhandled-rejection', 'abnormal']]) {
  test(`backend notice ${reason} retains its cause through a later user stop`, async t => {
    const f = await fixture(t);
    await f.supervisor.start(f.config);
    f.child.emit('message', { type: 'exit-diagnostic', reason, message: sensitive, stack: sensitive, code: sensitive });
    await f.supervisor.stop();
    const records = await f.records(), exit = records.at(-1);
    assert.equal(exit.reason, reason);
    assert.equal(exit.classification, classification);
    assert.equal(JSON.stringify(records).includes(sensitive), false);
  });
}

test('shutdown cleanup failure cannot be classified as a normal zero exit', async t => {
  const f = await fixture(t, { graceful: false });
  await f.supervisor.start(f.config);
  const stopping = assert.rejects(f.supervisor.stop(), { code: 'BACKEND_STOP_FAILED' });
  f.child.emit('message', { type: 'shutdown-failed', message: sensitive });
  f.child.emit('exit', 0);
  await stopping;
  const exit = (await f.records()).at(-1);
  assert.equal(exit.classification, 'abnormal');
  assert.equal(exit.shutdownFailed, true);
});

for (const intent of ['signal-term', 'signal-int', 'lease-expired']) {
  test(`fatal exception after ${intent} remains abnormal with both causes retained`, async t => {
    const f = await fixture(t);
    await f.supervisor.start(f.config);
    f.child.emit('message', { type: 'exit-diagnostic', reason: intent });
    f.child.emit('message', { type: 'exit-diagnostic', reason: 'uncaught-exception' });
    f.child.emit('exit', 1);
    const records = await f.records();
    assert.deepEqual(records.filter(record => record.event === 'backend-notice').map(record => record.reason),
      [intent, 'uncaught-exception']);
    assert.equal(records.at(-1).classification, 'abnormal');
    assert.equal(records.at(-1).reason, 'uncaught-exception');
  });
}

test('startup timeout cause is recorded without replacing the owned child', async t => {
  const f = await fixture(t, { ready: false, startupTimeout: 10 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starting = assert.rejects(f.supervisor.start(f.config), /超时/);
  t.mock.timers.tick(10);
  await starting;
  assert.equal(f.child.killCalls, 1);
  assert.throws(() => f.supervisor.start(f.config), /already active/);
  f.child.emit('exit', 1);
  const exit = (await f.records()).at(-1);
  assert.equal(exit.reason, 'startup-timeout');
  assert.equal(exit.classification, 'abnormal');
});

test('spawn failures persist a fixed type with no fabricated exit code or confirmation', async t => {
  const f = await fixture(t, { fork: () => { throw new Error(sensitive); } });
  await assert.rejects(f.supervisor.start(f.config), error => error.message === sensitive);
  const records = await f.records(), failure = records.at(-1);
  assert.equal(failure.event, 'spawn-failed');
  assert.equal(failure.reason, 'startup-error');
  assert.equal(failure.classification, 'abnormal');
  assert.equal(failure.code, null);
  assert.notEqual(failure.exitConfirmed, true);
  assert.equal(JSON.stringify(records).includes(sensitive), false);
});

test('diagnostic write failure does not turn a clean shutdown into a lifecycle failure', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.config.dataDir, 'diagnostics'), 'blocked');
  await f.supervisor.start(f.config);
  assert.equal(f.supervisor.diagnosticsAvailable, false);
  assert.deepEqual(await f.supervisor.stop(), { exitConfirmed: true, forced: false, code: 0 });
  assert.equal(f.supervisor.diagnosticsAvailable, false);
});

test('runtime errors persist a fixed cause and an invalid notice cannot replace it', async t => {
  const f = await fixture(t);
  await f.supervisor.start(f.config);
  f.child.emit('error', Object.assign(new Error(sensitive), { code: sensitive }));
  f.child.emit('message', { type: 'exit-diagnostic', reason: sensitive });
  f.child.emit('exit', 1);
  const records = await f.records(), exit = records.at(-1);
  assert.equal(exit.reason, 'runtime-error');
  assert.equal(exit.classification, 'abnormal');
  assert.equal(exit.termination, 'utility-kill');
  assert.equal(exit.forced, true);
  assert.equal(JSON.stringify(records).includes(sensitive), false);
});

test('confirmed utility death keeps unconfirmed media ownership visible and blocks restart', async t => {
  const f = await fixture(t);
  await f.supervisor.start(f.config);
  f.child.emit('message', { type: 'media-process', event: 'started', pid: process.pid + 10000 });
  f.child.emit('exit', 9);
  const exit = (await f.records()).at(-1);
  assert.equal(exit.exitConfirmed, true);
  assert.equal(exit.mediaExitConfirmed, false);
  assert.equal(exit.classification, 'abnormal');
  assert.equal(f.supervisor.state, 'media-unconfirmed');
  assert.throws(() => f.supervisor.start(f.config), { code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED' });
});

test('late old-child notices cannot contaminate the restarted backend run', async t => {
  const f = await fixture(t);
  await f.supervisor.start(f.config);
  const old = f.child;
  old.emit('exit', 9);
  await f.supervisor.start(f.config);
  const before = await f.records();
  old.emit('message', { type: 'exit-diagnostic', reason: 'uncaught-exception' });
  old.emit('exit', 7);
  assert.deepEqual(await f.records(), before);
  await f.supervisor.stop();
  const records = await f.records(), starts = records.filter(record => record.event === 'start');
  assert.notEqual(starts[0].runId, starts[1].runId);
  assert.equal(records.at(-1).classification, 'normal');
});
