import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {OwnedFixtureLifetime, startOwnedEditBackend, fixtureCli, fixtureDeadline} from './agent-edit-wire-lifecycle.ts';

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
