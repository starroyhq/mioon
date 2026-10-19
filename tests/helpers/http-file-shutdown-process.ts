// Test-only isolated filesystem/response seams for newly created synthetic files.
// Production constructors, HTTP routing and shutdown deadlines stay unchanged.
import http from 'node:http';
import type {Server as HttpServer, ServerResponse, ClientRequest, IncomingMessage} from 'node:http';
import type {Socket} from 'node:net';
import type {PathLike} from 'node:fs';
import fs from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '@mioon/business';
import type {Stats} from 'node:fs';
import {startServer} from '../../apps/server/src/index.ts';
import {FILE_RESPONSE_LIMITS} from '../../apps/server/src/file-response.ts';

const [mode, root] = process.argv.slice(2);
if (!mode || !root || !['open', 'stat', 'headers', 'headers-prearm-delay'].includes(mode) || !path.isAbsolute(root)) throw Error('Invalid synthetic shutdown fixture');
const dataRoot: string = root;
const headerMode = mode.startsWith('headers');
const token = 'synthetic-q4-shutdown-budget-token';
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: ()=>boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {if (Date.now() >= deadline) throw Error(label); await delay(5);}
}
let release!: ()=>void;
const pending = new Promise<void>(resolve => {release = resolve;});
const state = {intercepted: 0, opened: 0, closed: 0, streams: 0, endCalls: 0};
interface FixtureTarget {readonly id: string; readonly file: string; readonly empty: boolean}
const store = openStore(dataRoot), projectId = randomUUID(), targets: FixtureTarget[] = [];
store.put('projects', {id: projectId, name: 'Synthetic nonsettling HTTP filesystem'});
for (const empty of [false, true]) {
  const id = randomUUID(), file = path.join(root, 'media', `${id}.bin`);
  await writeFile(file, empty ? '' : 'synthetic-local-bytes', {mode: 0o600});
  store.put('assets', {id, projectId, name: 'Synthetic transport', mimeType: 'application/octet-stream', relativePath: `media/${id}.bin`});
  targets.push({id, file, empty});
}
store.close();
const names = new Set(targets.map((item: FixtureTarget) => item.file));
const originalOpen = fs.promises.open, originalEnd = http.ServerResponse.prototype.end;
const originalServerClose = http.Server.prototype.close, originalForceDrain = http.Server.prototype.closeAllConnections;
const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
interface TimerRecord {id: number; delayMs: number; armedAt: number; firedAt: number|null; clearedAt: number|null; callsite: string}
interface SocketRecord {closedAt: number|null}
interface SocketHandle {destroyed: boolean; once(event: string, listener: ()=>void): unknown}
interface Clock {started: number|null; forceCalls: {at: number; timerId: number|null; liveBefore: number; closedDescriptors: number; destroyedAfter?: number}[]; httpClosedAt: number|null; finished: number|null; preArmDelayMs: number; socketsObservedAt?: number}
const timerRecords: TimerRecord[] = [], timerHandles = new WeakMap<object, TimerRecord>(), socketRecords: SocketRecord[] = [], socketHandles = new Set<SocketHandle>();
const clock: Clock = {started: null, forceCalls: [], httpClosedAt: null, finished: null, preArmDelayMs: 0};
let tracing = false, activeTimerId: number|null = null;
// Observe actual production timers in this disposable child only. Delays are
// never shortened/replaced. Worker, service and server each have a 5s timer;
// retaining their callsites avoids attributing one owner's timer to another.
(globalThis as unknown as Record<string, unknown>).setTimeout = function(this: unknown, callback: (...args: unknown[])=>void, milliseconds?: number, ...args: unknown[]) {
  if (!tracing || ![3000, 5000].includes(milliseconds ?? 0)) return originalSetTimeout(callback, milliseconds, ...args);
  const record: TimerRecord = {id: timerRecords.length, delayMs: milliseconds ?? 0, armedAt: performance.now(), firedAt: null, clearedAt: null,
    callsite: (new Error().stack ?? '').split('\n').slice(2, 7).join('\n')};
  timerRecords.push(record);
  const handle = originalSetTimeout(function(this: unknown, ...values: unknown[]) {
    record.firedAt = performance.now(); const prior = activeTimerId; activeTimerId = record.id;
    try { return callback.apply(this, values); } finally { activeTimerId = prior; }
  }, milliseconds, ...args);
  timerHandles.set(handle as unknown as object, record); return handle;
} as unknown as typeof globalThis.setTimeout;
(globalThis as unknown as Record<string, unknown>).clearTimeout = function(this: unknown, handle?: NodeJS.Timeout) {
  const record = handle && typeof handle === 'object' ? timerHandles.get(handle as unknown as object) : null;
  if (record) record.clearedAt = performance.now();
  return originalClearTimeout(handle);
} as unknown as typeof globalThis.clearTimeout;
(http.Server.prototype as unknown as Record<string, unknown>).close = function(this: HttpServer, callback?: (error?: Error)=>void) {
  if (tracing && mode === 'headers-prearm-delay') {
    // Deterministic scheduling/pre-arm delay: the caller is paused before the
    // unchanged server.close and its subsequent 3s/5s timers are armed. This
    // reproduces elapsed >5s without inventing a late timer or leaking an fd.
    const before = performance.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2600);
    clock.preArmDelayMs = performance.now() - before;
  }
  return originalServerClose.call(this, typeof callback !== 'function' ? callback : function(this: unknown, ...args: unknown[]) {
    if (tracing) clock.httpClosedAt = performance.now();
    return (callback as (...values: unknown[])=>void).apply(this, args);
  });
} as never;
(http.Server.prototype as unknown as Record<string, unknown>).closeAllConnections = function(this: HttpServer, ...args: unknown[]) {
  if (tracing) clock.forceCalls.push({at: performance.now(), timerId: activeTimerId,
    liveBefore: [...socketHandles].filter((socket: SocketHandle) => !socket.destroyed).length, closedDescriptors: state.closed});
  const result = (originalForceDrain as (...values: unknown[])=>unknown).apply(this, args);
  const last = clock.forceCalls.at(-1);
  if (tracing && last) last.destroyedAfter = [...socketHandles].filter((socket: SocketHandle) => socket.destroyed).length;
  return result;
} as never;
let service: Awaited<ReturnType<typeof startServer>>|undefined, closing: Promise<unknown>|undefined, report: Record<string, unknown>|undefined;
(fs.promises as unknown as Record<string, unknown>).open = async function(this: unknown, file: PathLike, ...args: unknown[]) {
  if (!names.has(String(file))) return (originalOpen as unknown as (...values: unknown[])=>Promise<unknown>).call(this, file, ...args);
  state.intercepted++;
  if (mode === 'open') await pending;
  const handle = await (originalOpen as unknown as (...values: unknown[])=>Promise<{stat(): Promise<Stats>; createReadStream(options?: unknown): unknown; close(): Promise<void>}>).call(this, file, ...args); state.opened++;
  return {
    async stat() {if (mode === 'stat') await pending; return handle.stat();},
    createReadStream(options?: unknown) {state.streams++; return handle.createReadStream(options);},
    async close() {await handle.close(); state.closed++;},
  };
} as never;
syncBuiltinESMExports();
if (headerMode) (http.ServerResponse.prototype as unknown as Record<string, unknown>).end = function(this: ServerResponse, ...args: unknown[]) {
  const requestUrl = this.req.url;
  if ((this.req.method === 'HEAD' && requestUrl === `/media/${targets[0]!.id}`) ||
      (this.req.method === 'GET' && requestUrl === `/media/${targets[1]!.id}`)) {
    // An actual ServerResponse that never flushes end(). File descriptors must
    // nevertheless close; the ordinary server socket drain owns these peers.
    state.endCalls++;
    const socket = this.socket as Socket|null;
    if (socket && !socketHandles.has(socket as unknown as SocketHandle)) {
      const record: SocketRecord = {closedAt: null};
      socketHandles.add(socket as unknown as SocketHandle); socketRecords.push(record);
      socket.once('close', () => {record.closedAt = performance.now();});
    }
    return this;
  }
  return (originalEnd as (...values: unknown[])=>ServerResponse).apply(this, args);
} as never;
const requests: ClientRequest[] = [];
try {
  service = await startServer({dataDir: dataRoot, port: 0, token});
  function request(target: FixtureTarget, method = 'GET'): ClientRequest {
    const req = http.get(`${service!.url}/media/${target.id}`, {method, agent: false, headers: {authorization: `Bearer ${token}`}}, (res: IncomingMessage) => {
      res.on('error', () => {}); res.resume();
    });
    req.on('error', () => {}); requests.push(req); return req;
  }
  if (headerMode) {
    request(targets[0], 'HEAD'); request(targets[1]);
    await until(() => state.endCalls === 2 && state.closed === 2, 'Header-only descriptor release did not settle');
    const beforeClose = {...state};
    tracing = true; clock.started = performance.now(); await service!.close(); clock.finished = performance.now();
    // Node may deliver socket 'close' listeners after server.close's callback.
    // Observe their real events instead of assuming callback order means reaped.
    await until(() => socketRecords.every((socket: SocketRecord) => socket.closedAt !== null), 'Owned header sockets did not emit close');
    clock.socketsObservedAt = performance.now();
    report = {mode, outcome: 'closed', elapsedMs: clock.finished - clock.started, beforeClose, afterClose: {...state},
      clock, timers: timerRecords, sockets: socketRecords, destroyedSockets: [...socketHandles].filter(socket => socket.destroyed).length};
  } else {
    for (let index = 0; index < FILE_RESPONSE_LIMITS.active; index++) request(targets[0]);
    await until(() => state.intercepted === FILE_RESPONSE_LIMITS.active, 'Synthetic open seam was not reached');
    requests[0]?.destroy(); await delay(30);
    const busy = await fetch(`${service!.url}/media/${targets[0]!.id}`, {
      headers: {authorization: `Bearer ${token}`, connection: 'close'}, signal: AbortSignal.timeout(1000)});
    const busyBody = await busy.json() as {error?: {code?: string}};
    if (busy.status !== 503 || busyBody.error?.code !== 'FILE_RESPONSE_BUSY') throw Error('Pending descriptor slot was released before observation');
    const beforeClose = {...state}, started = performance.now();
    closing = service!.close();
    let outcome;
    try {await closing; outcome = 'closed';} catch (error) {outcome = (error as {code?: string}).code ?? String(error);}
    const elapsedMs = performance.now() - started, afterTimeout = {...state};
    const stillSameRejectedClose = service!.close() === closing;
    // Only now allow the operation to settle. This is cleanup of the test seam,
    // not a claim that an OS operation which never returns can be interrupted.
    release();
    await until(() => state.closed === FILE_RESPONSE_LIMITS.active, 'Late descriptors were not closed');
    report = {mode, outcome, elapsedMs, busyStatus: busy.status, beforeClose, afterTimeout, afterRelease: {...state}, stillSameRejectedClose};
  }
} finally {
  release(); for (const req of requests) req.destroy();
  fs.promises.open = originalOpen; syncBuiltinESMExports(); http.ServerResponse.prototype.end = originalEnd;
  http.Server.prototype.close = originalServerClose; http.Server.prototype.closeAllConnections = originalForceDrain;
  globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
}
process.stdout.write(JSON.stringify(report ?? {}) + '\n');
// A failed close deliberately keeps the SQLite owner until this isolated
// process exits. No product retry, hidden reopen or guessed cleanup is invoked.
