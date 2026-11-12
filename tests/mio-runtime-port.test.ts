import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createMioRuntime, createMioRuntimePort} from '../packages/business/src/agent/mio-runtime.ts';
import {createMioTestFixture, mioTestPolicy} from './helpers/mio-runtime-fixture.ts';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createTestAuthorizations} from './helpers/agent-authorizations.ts';

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

test('runtime factories share the real application policy CAS and receipts across independent kernel hosts', async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-r1-runtime-policy-'));
  const library = openAppLibrary({dataDir: path.join(root, 'app')}), a = openStore(path.join(root, 'a')), b = openStore(path.join(root, 'b'));
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const first = createMioRuntime({store: a, policyStore: library.agentPolicy, agentSettings: settings, authorizations: createTestAuthorizations(a, settings), selfPort: () => 4318});
  const second = createMioRuntime({store: b, policyStore: library.agentPolicy, agentSettings: settings, authorizations: createTestAuthorizations(b, settings), selfPort: () => 4318});
  try {
    const legacyRequestId = randomUUID(), legacyInput = {revision: 0, stepLimit: 12, modes: {...first.policy().modes}};
    const legacyPolicy = {...legacyInput, revision: 1};
    const legacyDigest = createHash('sha256').update(JSON.stringify(legacyInput)).digest('hex');
    library.agentPolicy.write(legacyPolicy, {requestId: legacyRequestId, digest: legacyDigest}, 0);
    const legacyReplay = {requestId: legacyRequestId, expectedRevision: 0, stepLimit: 12, modes: legacyInput.modes};
    assert.deepEqual(first.updatePolicy(legacyReplay), legacyPolicy);
    assert.throws(() => second.updatePolicy({...legacyReplay, stepLimit: 13}), {code: 'AGENT_TASK_REQUEST_CONFLICT'});
    assert.deepEqual(library.agentPolicy.readRequest(legacyRequestId), {digest: legacyDigest, policy: legacyPolicy});
    const input = {requestId: randomUUID(), expectedRevision: 1, modes: {...legacyPolicy.modes, local_reversible: 'confirm'}};
    const saved = first.updatePolicy(input);
    assert.deepEqual(saved, {revision: 2, stepLimit: 12, modes: input.modes});
    assert.deepEqual(second.policy(), saved); assert.deepEqual(second.updatePolicy(input), saved);
    assert.equal(library.db.prepare('SELECT count(*) AS count FROM agent_task_policy_requests_v2').get()!.count, 2);
    const staleId = randomUUID();
    assert.throws(() => second.updatePolicy({...input, requestId: staleId}), {code: 'AGENT_TASK_REVISION_CONFLICT'});
    assert.equal(library.agentPolicy.readRequest(staleId), null);
    assert.throws(() => a.tx(() => {
      first.updatePolicy({...input, requestId: randomUUID(), expectedRevision: 2, stepLimit: 14, modes: {...saved.modes, local_irreversible: 'direct'}});
      throw new Error('Rollback of a project transaction');
    }), /Rollback of a project transaction/u);
    assert.equal(second.policy().stepLimit, 12); assert.equal(second.policy().revision, 3); assert.equal(second.policy().modes.local_irreversible, 'direct');
    for (const store of [a, b]) {
      assert.equal(store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='agent_task_policy_v2'").get(), undefined);
      assert.equal(store.db.prepare('PRAGMA database_list').all().some(row => row.file === library.databaseFile), false);
    }
    const paid = {...input, requestId: randomUUID(), expectedRevision: 3, modes: {...second.policy().modes, paid: 'direct'}};
    assert.throws(() => second.updatePolicy(paid), {code: 'AGENT_TASK_APPROVAL_REQUIRED'});
    assert.equal(library.agentPolicy.readRequest(paid.requestId), null);
    assert.equal(second.updatePolicy({...paid, acknowledgePaid: true}).modes.paid, 'direct');
  } finally {
    first.dispose(); second.dispose(); await Promise.all([first.drain(), second.drain()]);
    await settings.close(); a.close(); b.close(); library.close(); rmSync(root, {recursive: true, force: true});
  }
});
