// Test-only isolated filesystem/response seams for newly created synthetic files.
// Production constructors, HTTP routing and shutdown deadlines stay unchanged.
import http from 'node:http';
import fs from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '@mioon/business';
import {startServer} from '../../apps/server/src/index.mjs';
import {FILE_RESPONSE_LIMITS} from '../../apps/server/src/file-response.mjs';

const [mode, root] = process.argv.slice(2);
if (!['open', 'stat', 'headers', 'headers-prearm-delay'].includes(mode) || !path.isAbsolute(root)) throw Error('Invalid synthetic shutdown fixture');
const headerMode = mode.startsWith('headers');
const token = 'synthetic-q4-shutdown-budget-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 3000;
  while (!check()) {if (Date.now() >= deadline) throw Error(label); await delay(5);}
}
let release;
const pending = new Promise(resolve => {release = resolve;});
const state = {intercepted: 0, opened: 0, closed: 0, streams: 0, endCalls: 0};
const store = openStore(root), projectId = randomUUID(), targets = [];
store.put('projects', {id: projectId, name: 'Synthetic nonsettling HTTP filesystem'});
for (const empty of [false, true]) {
  const id = randomUUID(), file = path.join(root, 'media', `${id}.bin`);
  await writeFile(file, empty ? '' : 'synthetic-local-bytes', {mode: 0o600});
  store.put('assets', {id, projectId, name: 'Synthetic transport', mimeType: 'application/octet-stream', relativePath: `media/${id}.bin`});
  targets.push({id, file, empty});
}
store.close();
const names = new Set(targets.map(item => item.file));
const originalOpen = fs.promises.open, originalEnd = http.ServerResponse.prototype.end;
const originalServerClose = http.Server.prototype.close, originalForceDrain = http.Server.prototype.closeAllConnections;
const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
const timerRecords = [], timerHandles = new WeakMap(), socketRecords = [], socketHandles = new Set();
const clock = {started: null, forceCalls: [], httpClosedAt: null, finished: null, preArmDelayMs: 0};
let tracing = false, activeTimerId = null;
// Observe actual production timers in this disposable child only. Delays are
// never shortened/replaced. Worker, service and server each have a 5s timer;
// retaining their callsites avoids attributing one owner's timer to another.
globalThis.setTimeout = function(callback, milliseconds, ...args) {
  if (!tracing || ![3000, 5000].includes(milliseconds)) return originalSetTimeout(callback, milliseconds, ...args);
  const record = {id: timerRecords.length, delayMs: milliseconds, armedAt: performance.now(), firedAt: null, clearedAt: null,
    callsite: new Error().stack.split('\n').slice(2, 7).join('\n')};
  timerRecords.push(record);
  const handle = originalSetTimeout(function(...values) {
    record.firedAt = performance.now(); const prior = activeTimerId; activeTimerId = record.id;
    try { return callback.apply(this, values); } finally { activeTimerId = prior; }
  }, milliseconds, ...args);
  timerHandles.set(handle, record); return handle;
};
globalThis.clearTimeout = function(handle) {
  const record = handle && typeof handle === 'object' ? timerHandles.get(handle) : null;
  if (record) record.clearedAt = performance.now();
  return originalClearTimeout(handle);
};
http.Server.prototype.close = function(callback) {
  if (tracing && mode === 'headers-prearm-delay') {
    // Deterministic scheduling/pre-arm delay: the caller is paused before the
    // unchanged server.close and its subsequent 3s/5s timers are armed. This
    // reproduces elapsed >5s without inventing a late timer or leaking an fd.
    const before = performance.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2600);
    clock.preArmDelayMs = performance.now() - before;
  }
  return originalServerClose.call(this, typeof callback !== 'function' ? callback : function(...args) {
    if (tracing) clock.httpClosedAt = performance.now();
    return callback.apply(this, args);
  });
};
http.Server.prototype.closeAllConnections = function(...args) {
  if (tracing) clock.forceCalls.push({at: performance.now(), timerId: activeTimerId,
    liveBefore: [...socketHandles].filter(socket => !socket.destroyed).length, closedDescriptors: state.closed});
  const result = originalForceDrain.apply(this, args);
  if (tracing) clock.forceCalls.at(-1).destroyedAfter = [...socketHandles].filter(socket => socket.destroyed).length;
  return result;
};
let service, closing, report;
fs.promises.open = async function(file, ...args) {
  if (!names.has(String(file))) return originalOpen.call(this, file, ...args);
  state.intercepted++;
  if (mode === 'open') await pending;
  const handle = await originalOpen.call(this, file, ...args); state.opened++;
  return {
    async stat() {if (mode === 'stat') await pending; return handle.stat();},
    createReadStream(options) {state.streams++; return handle.createReadStream(options);},
    async close() {await handle.close(); state.closed++;},
  };
};
syncBuiltinESMExports();
if (headerMode) http.ServerResponse.prototype.end = function(...args) {
  if ((this.req.method === 'HEAD' && this.req.url === `/media/${targets[0].id}`) ||
      (this.req.method === 'GET' && this.req.url === `/media/${targets[1].id}`)) {
    // An actual ServerResponse that never flushes end(). File descriptors must
    // nevertheless close; the ordinary server socket drain owns these peers.
    state.endCalls++;
    if (!socketHandles.has(this.socket)) {
      const socket = this.socket, record = {closedAt: null};
      socketHandles.add(socket); socketRecords.push(record);
      socket.once('close', () => {record.closedAt = performance.now();});
    }
    return this;
  }
  return originalEnd.apply(this, args);
};
const requests = [];
try {
  service = await startServer({dataDir: root, port: 0, token});
  function request(target, method = 'GET') {
    const req = http.get(`${service.url}/media/${target.id}`, {method, agent: false, headers: {authorization: `Bearer ${token}`}}, res => {
      res.on('error', () => {}); res.resume();
    });
    req.on('error', () => {}); requests.push(req); return req;
  }
  if (headerMode) {
    request(targets[0], 'HEAD'); request(targets[1]);
    await until(() => state.endCalls === 2 && state.closed === 2, 'Header-only descriptor release did not settle');
    const beforeClose = {...state};
    tracing = true; clock.started = performance.now(); await service.close(); clock.finished = performance.now();
    // Node may deliver socket 'close' listeners after server.close's callback.
    // Observe their real events instead of assuming callback order means reaped.
    await until(() => socketRecords.every(socket => socket.closedAt !== null), 'Owned header sockets did not emit close');
    clock.socketsObservedAt = performance.now();
    report = {mode, outcome: 'closed', elapsedMs: clock.finished - clock.started, beforeClose, afterClose: {...state},
      clock, timers: timerRecords, sockets: socketRecords, destroyedSockets: [...socketHandles].filter(socket => socket.destroyed).length};
  } else {
    for (let index = 0; index < FILE_RESPONSE_LIMITS.active; index++) request(targets[0]);
    await until(() => state.intercepted === FILE_RESPONSE_LIMITS.active, 'Synthetic open seam was not reached');
    requests[0].destroy(); await delay(30);
    const busy = await fetch(`${service.url}/media/${targets[0].id}`, {
      headers: {authorization: `Bearer ${token}`, connection: 'close'}, signal: AbortSignal.timeout(1000)});
    const busyBody = await busy.json();
    if (busy.status !== 503 || busyBody.error.code !== 'FILE_RESPONSE_BUSY') throw Error('Pending descriptor slot was released before observation');
    const beforeClose = {...state}, started = performance.now();
    closing = service.close();
    let outcome;
    try {await closing; outcome = 'closed';} catch (error) {outcome = error.code;}
    const elapsedMs = performance.now() - started, afterTimeout = {...state};
    const stillSameRejectedClose = service.close() === closing;
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
process.stdout.write(JSON.stringify(report) + '\n');
// A failed close deliberately keeps the SQLite owner until this isolated
// process exits. No product retry, hidden reopen or guessed cleanup is invoked.
