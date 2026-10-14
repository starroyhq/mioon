/** Test-only ownership. No production module imports this helper. */
import assert from 'node:assert/strict';
import {inheritedTestCompileCache} from '../../scripts/lib/test-compile-cache.ts';
export {inheritedTestCompileCache};
import http from 'node:http';
import {spawn} from 'node:child_process';
import type {ChildProcess, SpawnOptions} from 'node:child_process';
import type {Server, ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

type Disposer = () => unknown | Promise<unknown>;
interface FixtureContext {signal?: AbortSignal; after(callback: () => Promise<void>): unknown}
export interface ChildExit {code: number | null; signal: NodeJS.Signals | null}
const aborted = (): Error => Object.assign(new Error('Owned fixture is closed or cancelled'), {name: 'AbortError'});

/** A single after hook owns all resources, so one failed disposer cannot skip
 * a later MCP/child cleanup. Closure is fenced synchronously before any await. */
export class OwnedFixtureLifetime {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly disposers: Disposer[] = [];
  private readonly acquisitions = new Set<Promise<unknown>>();
  private readonly acquisitionCleanupErrors: unknown[] = [];
  private closing = false;
  private closed?: Promise<void>;
  constructor(context?: FixtureContext) {
    this.signal = context?.signal ? AbortSignal.any([context.signal, this.controller.signal]) : this.controller.signal;
    context?.after(() => this.close());
  }
  assertActive(): void {if (this.closing || this.signal.aborted) throw this.signal.reason ?? aborted();}
  deferCleanup(dispose: Disposer): void {this.assertActive(); this.disposers.push(dispose);}
  acquire<T>(create: () => Promise<T>, dispose: (value: T) => unknown | Promise<unknown>): Promise<T> {
    this.assertActive();
    const acquiring = Promise.resolve().then(() => {this.assertActive(); return create();}).then(async value => {
      try {this.assertActive(); this.deferCleanup(() => dispose(value)); return value;}
      catch (error) {
        try {await dispose(value);} catch (cleanupError) {
          this.acquisitionCleanupErrors.push(cleanupError);
          throw new AggregateError([error, cleanupError], 'Late owned acquisition cleanup failed');
        }
        throw error;
      }
    });
    this.acquisitions.add(acquiring);
    void acquiring.then(() => this.acquisitions.delete(acquiring), () => this.acquisitions.delete(acquiring));
    return acquiring;
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    // Publish before abort listeners or disposers can re-enter close().
    this.closed = new Promise<void>((done, failed) => {resolve = done; reject = failed;});
    this.controller.abort(aborted());
    void (async () => {
      // A listener/root acquisition that finishes late is still owned, and its
      // disposal finishes before the fixture's directory may be removed.
      const errors: unknown[] = [];
      try {await fixtureDeadline(Promise.allSettled([...this.acquisitions]), 'owned fixture acquisition close');}
      catch (error) {errors.push(error);}
      errors.push(...this.acquisitionCleanupErrors);
      for (const dispose of this.disposers.splice(0).reverse()) {try {await dispose();} catch (error) {errors.push(error);}}
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Owned fixture cleanup failed');
    })().then(resolve, reject);
    return this.closed;
  }
}

export function fixtureDeadline<T>(promise: Promise<T>, label: string, ms = 12000, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); callback();};
    const cancel = () => finish(() => reject(signal?.reason ?? aborted()));
    const timer = setTimeout(() => finish(() => reject(Error(`Timed out: ${label}`))), ms);
    signal?.addEventListener('abort', cancel, {once: true});
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal?.aborted) cancel();
  });
}
export async function until<T>(check: () => T | Promise<T>, label: string, ms = 10000, signal?: AbortSignal): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    const result = await fixtureDeadline(Promise.resolve().then(check), label, Math.max(1, end - Date.now()), signal);
    if (result) return result as NonNullable<T>;
    await delay(Math.min(15, Math.max(1, end - Date.now())), undefined, {signal});
  }
  assert.fail(`Timed out: ${label}`);
}

export interface OwnedEditBackend {
  child: ChildProcess; exited: Promise<ChildExit>; readonly output: string; url: string;
  observe(): Promise<{acquisitions: number; phases: string[]}>;
  arm(boundary: string): Promise<{armed: string}>;
  close(): Promise<ChildExit>; crash(): Promise<ChildExit>;
}
interface BackendOptions {repo: string; entry: string; token: string; lifetime?: OwnedFixtureLifetime}
export async function startOwnedEditBackend(root: string, {repo, entry, token, lifetime}: BackendOptions): Promise<OwnedEditBackend> {
  lifetime?.assertActive();
  const child = spawn(process.execPath, [entry], {cwd: repo, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {PATH: process.env.PATH || '', HOME: root, TMPDIR: tmpdir(), LANG: 'C.UTF-8', NODE_ENV: 'test', ...inheritedTestCompileCache()}});
  let output = '', readyReceived = false;
  for (const stream of [child.stdout, child.stderr]) {assert.ok(stream); stream.setEncoding('utf8').on('data', chunk => {output = (output + chunk).slice(-20000);});}
  const exited = new Promise<ChildExit>((resolve, reject) => {child.once('exit', (code, signal) => resolve({code, signal})); child.once('error', reject);});
  const closed = new Promise<ChildExit>((resolve, reject) => {child.once('close', (code, signal) => resolve({code, signal})); child.once('error', reject);});
  // The ownership/cleanup path may observe close after an early spawn error.
  void closed.catch(() => {});
  let readyResolve!: (value: {pid: number; url: string}) => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<{pid: number; url: string}>((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
  // A failed send/spawn may reject readiness before the readiness await begins.
  void ready.catch(() => {});
  const replies = new Map<string, {resolve: (value: any) => void; reject: (error: unknown) => void}>();
  const rejectReplies = (error: unknown) => {for (const reply of replies.values()) reply.reject(error); replies.clear();};
  child.on('message', (value: unknown) => {
    const message = value as {type?: string; requestId?: string; data?: unknown; message?: string; pid: number; url: string};
    if (message.type === 'ready') {readyReceived = true; readyResolve(message);}
    else if (message.type === 'error') {const error = Error(message.message); readyReject(error); rejectReplies(error);}
    else if (message.type === 'reply' && message.requestId) replies.get(message.requestId)?.resolve(message.data);
  });
  exited.then(result => {const error = Error(`Owned backend exited: ${JSON.stringify(result)}\n${output}`); readyReject(error); rejectReplies(error);}, error => {readyReject(error); rejectReplies(error);});
  child.once('disconnect', () => rejectReplies(Error('Owned backend IPC disconnected')));
  const running = () => child.exitCode === null && child.signalCode === null;
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!child.connected) return reject(Error('Owned backend IPC is closed'));
    child.send(message, error => error ? reject(error) : resolve());
  });
  const ask = async (message: object) => {
    lifetime?.assertActive();
    const requestId = randomUUID();
    try {
      const reply = new Promise<any>((resolve, reject) => {replies.set(requestId, {resolve, reject}); send({...message, requestId}).catch(reject);});
      return await fixtureDeadline(reply, 'owned backend IPC', 12000, lifetime?.signal);
    } finally {replies.delete(requestId);}
  };
  let closing: Promise<ChildExit> | undefined, crashing: Promise<ChildExit> | undefined;
  const instance: OwnedEditBackend = {child, exited, url: '', get output() {return output;},
    observe: () => ask({type: 'observe'}), arm: boundary => ask({type: 'arm', boundary}),
    crash() {return crashing ??= (async () => {if (running()) assert.equal(child.kill('SIGKILL'), true); return fixtureDeadline(closed, 'owned backend crash');})();},
    close() {return closing ??= (async () => {
      if (!running()) return fixtureDeadline(closed, 'owned backend close');
      // A close IPC racing async startup can disconnect before a listener is
      // created. Until readiness, terminate/reap this exact owned child instead.
      if (!readyReceived) return instance.crash();
      try {return await fixtureDeadline((async () => {await send({type: 'close'}); return closed;})(), 'owned backend close');}
      catch (error) {try {await instance.crash();} catch (cleanupError) {throw new AggregateError([error, cleanupError], 'Owned backend close and reap failed');} throw error;}
    })();},
  };
  // Register synchronously after spawn, before any readiness/IPC await.
  lifetime?.deferCleanup(() => instance.close());
  try {
    lifetime?.assertActive();
    await send({type: 'start', dataDir: root, token});
    const result = await fixtureDeadline(ready, 'owned backend readiness', 12000, lifetime?.signal);
    assert.equal(result.pid, child.pid); instance.url = result.url;
    assert.equal((await instance.observe()).acquisitions, 0); lifetime?.assertActive(); return instance;
  } catch (error) {
    try {await instance.crash();} catch (cleanupError) {throw new AggregateError([error, cleanupError], 'Owned backend startup and reap failed');}
    throw Error(`${error instanceof Error ? error.message : String(error)}\n${output}`, {cause: error});
  }
}

/** Close the listener before closing its connections; repeated close is safe. */
export function ownedModelCloser(server: Server, responses: Set<ServerResponse>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => closing ??= fixtureDeadline(new Promise<void>((resolve, reject) => {
    server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    for (const response of responses) response.destroy();
    server.closeAllConnections();
  }), 'owned model close');
}

export async function fixtureHttpRequest(lifetime: OwnedFixtureLifetime, url: string, token: string,
  {method = 'GET', input, raw, authenticated = true, headers = {}}: {method?: string; input?: unknown; raw?: string; authenticated?: boolean; headers?: Record<string, string>} = {}) {
  lifetime.assertActive();
  const response = await fetch(url, {method, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(12000)]),
    headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {}), ...headers},
    ...(raw !== undefined || input !== undefined ? {body: raw ?? JSON.stringify(input)} : {})});
  const text = await response.text();
  return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null};
}
export function fixtureLostAcknowledgement(lifetime: OwnedFixtureLifetime, url: string, token: string, input: unknown): Promise<number> {
  lifetime.assertActive();
  return fixtureDeadline(new Promise<number>((resolve, reject) => {
    const request = http.request(url, {method: 'POST', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(12000)]),
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}}, response => {const status = response.statusCode!; response.destroy(); resolve(status);});
    request.once('error', reject); request.end(JSON.stringify(input));
  }), 'deliberately lost HTTP acknowledgement', 12000, lifetime.signal);
}

export async function fixtureCli(lifetime: OwnedFixtureLifetime, command: string, args: string[], options: SpawnOptions, operation: string, token: string) {
  lifetime.assertActive();
  const child = spawn(command, args, {...options, env: {...options.env, ...inheritedTestCompileCache()}, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  assert.ok(child.stdout); assert.ok(child.stderr);
  child.stdout.setEncoding('utf8').on('data', chunk => {stdout += chunk;});
  child.stderr.setEncoding('utf8').on('data', chunk => {stderr += chunk;});
  const closed = new Promise<ChildExit>((resolve, reject) => {child.once('close', (code, signal) => resolve({code, signal})); child.once('error', reject);});
  void closed.catch(() => {});
  let stopping: Promise<ChildExit> | undefined;
  const stop = () => stopping ??= (async () => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); return fixtureDeadline(closed, 'owned CLI close');})();
  lifetime.deferCleanup(stop);
  let ended: ChildExit;
  try {ended = await fixtureDeadline(closed, `CLI timed out: ${operation}`, 12000, lifetime.signal);}
  catch (error) {try {await stop();} catch (cleanupError) {throw new AggregateError([error, cleanupError], 'Owned CLI execution and reap failed');} throw error;}
  assert.equal(ended.signal, null, stderr);
  assert.equal(stdout.includes(token), false); assert.equal(stderr.includes(token), false);
  return {code: ended.code, body: JSON.parse(stdout), stderr};
}
