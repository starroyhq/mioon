import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, realpath, access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {OwnedFixtureLifetime, startOwnedEditBackend, fixtureCli, fixtureDeadline, inheritedTestCompileCache} from './agent-edit-wire-lifecycle.ts';

const deferred = <T = void>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};};
test('owned fixture tries every disposer, retains errors, and closes exactly once', async () => {
  const lifetime = new OwnedFixtureLifetime(), calls: string[] = [], first = Error('first failure'), second = Error('second failure');
  lifetime.deferCleanup(() => {calls.push('root');});
  lifetime.deferCleanup(() => {calls.push('model'); throw second;});
  lifetime.deferCleanup(() => {calls.push('backend'); throw first;});
  lifetime.deferCleanup(() => {calls.push('MCP');});
  const closing = lifetime.close(); assert.equal(lifetime.close(), closing);
  await assert.rejects(closing, error => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === second);
  assert.deepEqual(calls, ['MCP', 'backend', 'model', 'root']);
  assert.throws(() => lifetime.deferCleanup(() => {}), /closed or cancelled/u);
});
test('late acquisition is disposed and cannot reopen a closing fixture', async () => {
  const lifetime = new OwnedFixtureLifetime(), gate = deferred<string>(); let disposed = '';
  const entered = deferred();
  const acquisition = lifetime.acquire(() => {entered.resolve(); return gate.promise;}, value => {disposed = value;});
  await entered.promise;
  const rejected = assert.rejects(acquisition, /closed or cancelled/u);
  let closed = false; const closing = lifetime.close().then(() => {closed = true;});
  await Promise.resolve(); assert.equal(closed, false);
  gate.resolve('late owned value'); await rejected; await closing;
  assert.equal(disposed, 'late owned value');
});
test('context cancellation interrupts pending waits without dropping original cleanup failure', async () => {
  const controller = new AbortController(), hooks: Array<() => Promise<void>> = [];
  const lifetime = new OwnedFixtureLifetime({signal: controller.signal, after: callback => hooks.push(callback)});
  const failure = Error('forced disposal failure'); lifetime.deferCleanup(() => {throw failure;});
  const pending = fixtureDeadline(new Promise(() => {}), 'pending IPC', 12000, lifetime.signal);
  const aborted = Error('outer test cancelled'); const rejection = assert.rejects(pending, error => error === aborted);
  controller.abort(aborted); await rejection;
  assert.throws(() => lifetime.assertActive(), error => error === aborted);
  await assert.rejects(hooks[0]!(), error => error === failure);
});
test('pre-readiness owned backend is reaped on cancellation, never published later', {timeout: 15000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-owned-startup-regression-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const entry = path.join(root, 'pending.cjs');
  // A real child announces only its PID, never backend readiness. IPC owns it.
  await writeFile(entry, `process.on('message', () => {}); setInterval(() => {}, 1000);`);
  const lifetime = new OwnedFixtureLifetime(); const starting = startOwnedEditBackend(root, {repo: root, entry, token: 'synthetic', lifetime});
  const rejected = assert.rejects(starting, /closed or cancelled/u);
  await lifetime.close(); await rejected; // close resolves only after owned child stdio closes.
  assert.throws(() => lifetime.assertActive(), /closed or cancelled/u);
});
test('a spawn error is consumed without an unhandled readiness rejection', {timeout: 15000}, async () => {
  const lifetime = new OwnedFixtureLifetime();
  await assert.rejects(startOwnedEditBackend('/does-not-exist', {repo: '/does-not-exist', entry: 'absent', token: 'synthetic', lifetime}), /startup and reap failed|ENOENT/u);
  await assert.rejects(lifetime.close(), /ENOENT/u);
});
test('actual CLI child is reaped even when a different disposer throws first', {timeout: 15000}, async () => {
  const lifetime = new OwnedFixtureLifetime();
  const running = fixtureCli(lifetime, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, 'owned-test', 'synthetic');
  const rejected = assert.rejects(running, /closed or cancelled/u), forced = Error('forced earlier cleanup');
  lifetime.deferCleanup(() => {throw forced;});
  await assert.rejects(lifetime.close(), error => error === forced); await rejected;
});

test('synchronous cancellation listeners see the same pending close promise', async () => {
  const lifetime = new OwnedFixtureLifetime(), gate = deferred(); let nested: Promise<void> | undefined;
  lifetime.signal.addEventListener('abort', () => {nested = lifetime.close();});
  lifetime.deferCleanup(() => gate.promise);
  const closing = lifetime.close(); assert.equal(nested, closing);
  gate.resolve(); await closing;
});

test('close awaits late acquisition disposal and retains its exact failure', async () => {
  const lifetime = new OwnedFixtureLifetime(), creating = deferred<string>(), entered = deferred(), disposing = deferred();
  const failure = Error('late disposal failed');
  const acquired = lifetime.acquire(() => {entered.resolve(); return creating.promise;}, async () => {await disposing.promise; throw failure;});
  const rejected = assert.rejects(acquired, error => error instanceof AggregateError && error.errors[1] === failure);
  await entered.promise; const closing = lifetime.close();
  const failedClose = assert.rejects(closing, error => error === failure);
  creating.resolve('late'); await Promise.resolve(); disposing.resolve();
  await rejected; await failedClose;
});

for (const disconnectAt of ['start-send', 'server-starting']) test(`backend startup owns a parent IPC disconnect at ${disconnectAt} until every acquired resource closes`, {timeout: 15000}, async t => {
  const lifetime = new OwnedFixtureLifetime(t);
  const root = await lifetime.acquire(async () => mkdtemp(path.join(await realpath(tmpdir()), 'mioon-owned-disconnect-regression-')), value => rm(value, {recursive: true, force: true}));
  const entry = fileURLToPath(new URL('./agent-edit-wire-process.ts', import.meta.url));
  const child = spawn(process.execPath, [entry], {stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {PATH: process.env.PATH || '', HOME: root, TMPDIR: tmpdir(), LANG: 'C.UTF-8', NODE_ENV: 'test', ...inheritedTestCompileCache()}});
  let stderr = '';
  assert.ok(child.stderr); child.stderr.setEncoding('utf8').on('data', chunk => {stderr = (stderr + chunk).slice(-20000);});
  const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({code, signal})); child.once('error', reject);
  });
  lifetime.deferCleanup(async () => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await fixtureDeadline(exited, 'backend disconnect reap'); child.stderr?.destroy();});
  const disconnected = new Promise<void>((resolve, reject) => {
    child.on('message', (value: unknown) => {
      const message = value as {type?: string; phase?: string};
      if (disconnectAt === message.phase && message.type === 'startup-phase') {child.disconnect(); resolve();}
    });
    child.send({type: 'start', dataDir: root, token: 'synthetic-disconnect-regression-token'}, error => {
      if (error) reject(error); else if (disconnectAt === 'start-send') {child.disconnect(); resolve();}
    });
  });
  // Deliver start, then disappear before readiness. The child must consume an
  // IPC send failure and await startup rather than publishing an orphan server.
  await fixtureDeadline(disconnected, `backend disconnect at ${disconnectAt}`);
  assert.deepEqual(await fixtureDeadline(exited, 'backend parent disconnect'), {code: 0, signal: null}, stderr);
  assert.equal(stderr.includes('EPIPE'), false, stderr);
  await assert.rejects(access(path.join(root, 'server.lock')), {code: 'ENOENT'});
});

test('readiness failure retains a fixed startup phase without copying child labels or secrets', {timeout: 15000}, async t => {
  const lifetime = new OwnedFixtureLifetime(t);
  const root = await lifetime.acquire(async () => mkdtemp(path.join(await realpath(tmpdir()), 'mioon-owned-phase-regression-')), value => rm(value, {recursive: true, force: true}));
  const entry = path.join(root, 'pending.cjs');
  const token = 'synthetic-phase-regression-token';
  // One IPC channel orders the phase reports before the deliberate failure;
  // no sleep or filesystem marker races the parent's receipt of diagnostics.
  await writeFile(entry, `process.on('message',message=>{process.send({type:'startup-phase',phase:'module-loading'});process.send({type:'startup-phase',phase:message.token});process.send({type:'error',message:'synthetic startup failure'});});`);
  await assert.rejects(startOwnedEditBackend(root, {repo: root, entry, token, lifetime}), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /phase=module-loading/u);
    assert.match(error.message, /ready=false exit=null signal=null cancelled=false/u);
    assert.match(error.message, /Owned backend reap: \{"code":null,"signal":"SIGKILL"\}/u);
    assert.equal(error.message.includes(token), false); assert.equal(error.message.includes(root), false);
    return true;
  });
});
