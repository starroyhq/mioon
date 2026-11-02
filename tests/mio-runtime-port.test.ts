import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createMioRuntimePort} from '../packages/business/src/agent/mio-runtime.ts';
import {createMioTestFixture, mioTestPolicy} from './helpers/mio-runtime-fixture.ts';

function gate() {let resolve = () => {}; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('two kernel hosts own separate runtime/transport lifecycles and drain both scopes before the caller closes stores', {timeout: 30_000}, async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-r1-runtime-port-'));
  const releaseA = gate(), enteredA = gate(), endedA = gate(), abortedA = gate();
  const releaseB = gate(), enteredB = gate(), endedB = gate();
  const drainEnteredA = gate(), drainEnteredB = gate(), transportA = gate(), transportB = gate();
  const a = await createMioTestFixture(path.join(root, 'a'), async function* (request) {
    request.beforeSubmit?.(); request.signal?.addEventListener('abort', () => abortedA.resolve(), {once: true}); enteredA.resolve();
    try {await releaseA.promise; yield {type: 'done', output: {text: 'A', toolCalls: [], providerOutput: {role: 'assistant', content: 'A'}}};} finally {endedA.resolve();}
  });
  const b = await createMioTestFixture(path.join(root, 'b'), async function* (request) {
    request.beforeSubmit?.(); enteredB.resolve();
    try {await releaseB.promise; yield {type: 'done', output: {text: 'B', toolCalls: [], providerOutput: {role: 'assistant', content: 'B'}}};} finally {endedB.resolve();}
  });
  a.runtime.close(); b.runtime.close();
  const countsA = {handled: 0, interrupted: 0, disposed: 0}, countsB = {handled: 0, interrupted: 0, disposed: 0};
  const makePort = (fixture: typeof a, counts: typeof countsA, drainEntered: ReturnType<typeof gate>, releaseTransport: ReturnType<typeof gate>) => createMioRuntimePort<string>({
    store: fixture.store, agentSettings: fixture.settings, authorizations: fixture.authorizations, tools: fixture.tools,
    selfPort: () => 4318, policy: mioTestPolicy,
    gateway: fixture.gateway,
    createTransport(runtime) {return {
      async handle(text) {counts.handled++; await runtime.send(fixture.store.projectId, {requestId: randomUUID(), expectedSettingsRevision: 1, text}); return true;},
      interrupt() {counts.interrupted++;},
      async drain() {drainEntered.resolve(); await releaseTransport.promise;},
      dispose() {counts.disposed++;},
    };},
  });
  const portA = makePort(a, countsA, drainEnteredA, transportA), portB = makePort(b, countsB, drainEnteredB, transportB);
  try {
    assert.equal(await portA.handle('A synthetic request'), true); await enteredA.promise; assert.equal(portA.isBusy(), true);
    portA.interrupt(); portA.interrupt(); await abortedA.promise;
    assert.equal(await portA.handle('A must reject after interruption'), false); assert.equal(countsA.handled, 1);
    assert.equal(await portB.handle('B remains usable after A interruption'), true); await enteredB.promise; assert.equal(portB.isBusy(), true);
    let drainedA = false, drainedB = false;
    const pendingA = portA.drain().then(() => {drainedA = true;}), pendingB = portB.drain().then(() => {drainedB = true;});
    await Promise.all([drainEnteredA.promise, drainEnteredB.promise]);
    releaseA.resolve(); await endedA.promise; await tick();
    assert.equal(drainedA, false, 'Settling the executor alone cannot finish host drain while transport is pending');
    transportB.resolve(); await tick();
    assert.equal(drainedB, false, 'Settling transport alone cannot finish host drain while its executor is pending');
    transportA.resolve(); releaseB.resolve(); await endedB.promise; await Promise.all([pendingA, pendingB]);
    portA.dispose(); portA.dispose(); portA.interrupt(); portB.dispose(); portB.dispose(); portB.interrupt();
    assert.deepEqual(countsA, {handled: 1, interrupted: 1, disposed: 1});
    assert.deepEqual(countsB, {handled: 1, interrupted: 1, disposed: 1});
    assert.equal(a.store.db.isOpen, true); assert.equal(b.store.db.isOpen, true);
    assert.equal(a.store.get('projects', b.store.projectId), null); assert.equal(b.store.get('projects', a.store.projectId), null);
    assert.equal(await portB.handle('B must reject after disposal'), false);
  } finally {
    releaseA.resolve(); releaseB.resolve(); transportA.resolve(); transportB.resolve();
    portA.dispose(); portB.dispose(); await Promise.all([portA.drain(), portB.drain()]);
    await a.close(); await b.close(); rmSync(root, {recursive: true, force: true});
  }
});

for (const reject of [false, true]) test(`a transport without drain retains its deferred handle until ${reject ? 'rejection' : 'completion'}`, {timeout: 30_000}, async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-r1-runtime-handle-'));
  const fixture = await createMioTestFixture(root, async function* () {throw new Error('This transport-only request must not start the model gateway');});
  fixture.runtime.close();
  const entered = gate(), release = gate(), originalError = new Error('The accepted transport request failed');
  let calls = 0, interrupts = 0, drained = false;
  const port = createMioRuntimePort<string>({store: fixture.store, agentSettings: fixture.settings,
    authorizations: fixture.authorizations, tools: fixture.tools, gateway: fixture.gateway, selfPort: () => 4318, policy: mioTestPolicy,
    createTransport() {return {
      async handle() {calls++; entered.resolve(); await release.promise; if (reject) throw originalError; return true;},
      interrupt() {interrupts++;},
    };},
  });
  try {
    const result = port.handle('deferred request').then(value => ({value}), error => ({error}));
    await entered.promise;
    assert.equal(port.isBusy(), true);
    const drain = port.drain().then(() => {drained = true; return {error: undefined};}, error => {drained = true; return {error};});
    await tick(); assert.equal(drained, false, 'A missing transport.drain cannot detach an accepted asynchronous handle');
    port.interrupt(); port.interrupt();
    assert.equal(await port.handle('late request'), false); assert.equal(calls, 1); assert.equal(interrupts, 1);
    await tick(); assert.equal(drained, false, 'Interruption cannot declare an unresolved accepted request drained');
    release.resolve();
    const [handled, settled] = await Promise.all([result, drain]);
    if (reject) {
      assert.ok('error' in handled); assert.equal(handled.error, originalError);
      assert.ok(settled.error instanceof AggregateError); assert.ok(settled.error.errors.includes(originalError));
    } else {
      assert.deepEqual(handled, {value: true}); assert.equal(settled.error, undefined);
    }
    assert.equal(port.isBusy(), false); port.dispose(); port.dispose();
    assert.equal(fixture.store.db.isOpen, true);
  } finally {
    release.resolve(); port.dispose(); await port.drain().catch(() => {}); await fixture.close(); rmSync(root, {recursive: true, force: true});
  }
});
