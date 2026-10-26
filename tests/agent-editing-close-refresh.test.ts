import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import * as protection from '../apps/web/src/agent-editing-protection.ts';
import type {AgentTaskClaim, AgentTaskEditingInput, AgentTaskTarget} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createNativeCloseAdmission, createNativeCloseRegistry} from '../apps/web/src/native-close-state.ts';
import {createSettingsNavigationRegistry} from '../apps/web/src/settings-navigation-state.ts';
import {createAgentTaskCloseReporter} from '../apps/web/src/native-close-sources.ts';

const boundaryCode = transformSync(readFileSync(new URL('../apps/web/src/AgentEditingBoundary.tsx', import.meta.url), 'utf8'), {loader: 'tsx', format: 'cjs'}).code;
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

/** Run the actual boundary's private owner map and watchAgentEditingClose with
 * a real editing controller and P0. Only React mounting and local HTTP are fake. */
async function fixture({initialReadFailure = false}: {initialReadFailure?: boolean} = {}) {
  const projectId = crypto.randomUUID(), target: AgentTaskTarget = {kind: 'timeline', id: projectId, revision: 4};
  const effects: (() => void | (() => void))[] = [], cleanups: (() => void)[] = [], writes: AgentTaskEditingInput[] = [];
  let observation: protection.AgentEditingObservation = {claims: [], targets: [{...target}], timelineRevision: 2};
  let read: (() => Promise<protection.AgentEditingObservation>) | null = null, failRead = initialReadFailure, failWrite = false;
  let controller: ReturnType<typeof protection.createAgentEditingProtection> | undefined, ownerId = '', reads = 0;
  const client: protection.AgentEditingClient = {
    async read() { reads++; if (failRead) throw new Error('synthetic read failure'); return read ? read() : structuredClone(observation); },
    async update(input) {
      writes.push(input);
      if (failWrite) throw new Error('synthetic lost write acknowledgement');
      observation = {...observation, claims: ['claim', 'restore'].includes(input.action) ? [{id: crypto.randomUUID(), projectId, ownerId,
        target: {...target}, state: 'active', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z'}] : []};
      return structuredClone(observation);
    },
  };
  const react = {
    createContext: () => ({Provider: 'editing-context'}),
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({type, props: {...props, children}}),
    useRef: (current: unknown) => ({current}), useState: (value: unknown) => [value, () => {}],
    useLayoutEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
  };
  const module = {exports: {} as typeof import('../apps/web/src/AgentEditingBoundary.tsx')};
  Function('require', 'module', 'exports', boundaryCode)((id: string) => {
    if (id === 'react') return {...react, default: react};
    if (id === './agent-editing-protection.ts') return {...protection, createAgentEditingProtection: (options: Parameters<typeof protection.createAgentEditingProtection>[0]) => {
      ownerId = options.ownerId; return controller = protection.createAgentEditingProtection({...options, client});
    }};
    if (id.includes('I18nProvider')) return {useI18n: () => ({t: (key: string) => key})};
    if (id.includes('workbench-confirm')) return {useConfirmation: () => async () => false};
    if (id.includes('/button')) return {Button: 'button'};
    if (id.includes('packages/i18n')) return {message: (key: string) => ({key})};
    if (id.endsWith('.css')) return {};
    assert.fail(`Unexpected boundary dependency ${id}`);
  }, module, module.exports);
  const boundary = module.exports, registry = createNativeCloseRegistry(), settings = createSettingsNavigationRegistry();
  const release = boundary.watchAgentEditingClose(registry);
  const element = boundary.default({projectId, targets: [target], canRelease: () => true, children: null}) as unknown as {type: (props: unknown) => unknown; props: unknown};
  element.type(element.props);
  for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  await flush();
  assert.ok(controller);
  const liveController = controller;
  const close = createNativeCloseAdmission({registry, settings, readScope: () => 'synthetic-editor', readDocumentURL: () => 'https://synthetic.invalid/',
    now: () => 1000, newToken: () => 'synthetic-close'});
  return {controller: liveController, registry, close, boundary, writes, target,
    get reads() { return reads; }, get observation() { return observation; },
    setObservation(next: protection.AgentEditingObservation) { observation = next; }, setRead(next: (() => Promise<protection.AgentEditingObservation>) | null) { read = next; },
    failRead(value = true) { failRead = value; }, failWrite() { failWrite = true; },
    commit(token: string) { return close.commit(token, {discardDirty: true, allowDrainFailure: false, expiresAt: 2000}); },
    claim(patch: Partial<AgentTaskClaim> = {}): AgentTaskClaim { return {id: crypto.randomUUID(), projectId, ownerId, target: {...target}, state: 'active', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z', ...patch}; },
    cleanup() { close.dispose(); release(); for (const cleanup of cleanups) cleanup(); liveController.dispose(); },
  };
}

test('known-idle project polling cannot invalidate unchanged Mio draft discard consent', async () => {
  const f = await fixture();
  try {
    const mio = createAgentTaskCloseReporter(f.registry);
    mio.publish({draft: 'Synthetic unsent draft', draftVersion: 1, draftDirty: true, uploads: [], phase: 'ready', pending: null, snapshot: null});
    const before = f.registry.capture(), ticket = f.close.inspect(); assert.equal(ticket.disposition, 'dirty');
    for (let index = 0; index < 2; index++) await f.boundary.refreshAgentEditingTargets(f.target.id);
    assert.deepEqual(f.registry.capture(), before); assert.equal(f.commit(ticket.token), true);
    const event = {preventDefault() { assert.fail('Unchanged input must remain admissible'); }, returnValue: ''};
    assert.equal(f.close.beforeUnload(event), true); assert.equal(f.writes.length, 0); mio.release();
  } finally { f.cleanup(); }
});

test('known-idle observation remains noneditable and cannot dispatch acquire or release while its GET is pending', async () => {
  const f = await fixture();
  try {
    const held = Promise.withResolvers<protection.AgentEditingObservation>(); f.setRead(() => held.promise);
    const before = f.registry.capture(), reading = f.controller.refresh();
    assert.equal(f.controller.getState().phase, 'idle'); assert.equal(f.controller.canEdit(), false);
    assert.equal(await f.controller.acquire(), false); assert.equal(await f.controller.release(), false);
    assert.deepEqual(f.registry.capture(), before); assert.equal(f.writes.length, 0);
    held.resolve(structuredClone(f.observation)); await reading;
    assert.deepEqual(f.registry.capture(), before);
  } finally { f.cleanup(); }
});

test('a failed first observation cannot establish an idle cache or release its unknown close fence', async () => {
  const f = await fixture({initialReadFailure: true});
  try {
    assert.equal(f.reads, 1); assert.equal(f.controller.getState().phase, 'uncertain');
    assert.equal(f.close.inspect().disposition, 'blocked'); assert.equal(f.controller.canEdit(), false);
    const held = Promise.withResolvers<protection.AgentEditingObservation>(); f.failRead(false); f.setRead(() => held.promise);
    const reading = f.controller.refresh(); assert.equal(f.controller.getState().phase, 'loading');
    assert.equal(await f.controller.acquire(), false); assert.equal(f.writes.length, 0);
    held.resolve(structuredClone(f.observation)); await reading;
    assert.equal(f.controller.getState().phase, 'idle'); assert.equal(f.controller.canEdit(), false);
  } finally { f.cleanup(); }
});

for (const change of ['target-revision', 'timeline-revision', 'claim', 'read-failure'] as const) test(`actual ${change} during idle observation invalidates an old close ticket`, async () => {
  const f = await fixture();
  try {
    const ticket = f.close.inspect();
    if (change === 'target-revision') f.setObservation({...f.observation, targets: [{...f.target, revision: 5}]});
    if (change === 'timeline-revision') f.setObservation({...f.observation, timelineRevision: 3});
    if (change === 'claim') f.setObservation({...f.observation, claims: [f.claim()]});
    if (change === 'read-failure') f.failRead();
    await f.controller.refresh(); assert.equal(f.commit(ticket.token), false);
    if (change === 'claim' || change === 'read-failure') assert.equal(f.registry.capture().find(source => source.slot === 'agent-editing-v2')?.blocked, true);
    assert.equal(f.writes.length, 0); assert.equal(f.controller.canEdit(), false);
  } finally { f.cleanup(); }
});

test('unchanged active claims ignore observational timestamps but exact claim identity changes still revoke consent', async () => {
  const f = await fixture();
  try {
    await f.controller.acquire(); assert.equal(f.controller.canEdit(), true);
    const first = f.close.inspect(), before = f.registry.capture();
    f.setObservation({...f.observation, claims: f.observation.claims.map(claim => ({...claim, updatedAt: '2026-10-26T00:00:01Z'}))});
    await f.controller.refresh(); assert.deepEqual(f.registry.capture(), before); assert.equal(f.commit(first.token), true);
    f.close.cancel(first.token);
    const second = f.close.inspect(); f.setObservation({...f.observation, claims: f.observation.claims.map(claim => ({...claim, id: crypto.randomUUID()}))});
    await f.controller.refresh(); assert.equal(f.commit(second.token), false);
    assert.equal(f.writes.length, 1);
  } finally { f.cleanup(); }
});

test('claim and target response ordering is observational while a real claim authority change revokes consent', async () => {
  const f = await fixture();
  try {
    await f.controller.acquire();
    const other = {...f.target, kind: 'shot', id: crypto.randomUUID(), revision: 9};
    f.setObservation({...f.observation, targets: [{...f.target}, other], claims: [...f.observation.claims, f.claim({target: other})]});
    await f.controller.refresh(); const ticket = f.close.inspect(), before = f.registry.capture();
    f.setObservation({...f.observation, targets: [...f.observation.targets].reverse(), claims: [...f.observation.claims].reverse().map(claim => ({...claim, updatedAt: '2026-10-26T00:00:02Z'}))});
    await f.controller.refresh(); assert.deepEqual(f.registry.capture(), before); assert.equal(f.commit(ticket.token), true);
    f.close.cancel(ticket.token); const changed = f.close.inspect();
    f.setObservation({...f.observation, claims: f.observation.claims.map(claim => ({...claim, state: 'uncertain'}))});
    await f.controller.refresh(); assert.equal(f.controller.canEdit(), false); assert.equal(f.commit(changed.token), false);
    assert.equal(f.registry.capture().find(source => source.slot === 'agent-editing-v2')?.blocked, true); assert.equal(f.writes.length, 1);
  } finally { f.cleanup(); }
});

test('an unresolved claim keeps its original pending fence across GET reconciliation without replay', async () => {
  const f = await fixture();
  try {
    f.failWrite(); await f.controller.acquire(); const pending = f.controller.getState().pending;
    assert.ok(pending); assert.equal(f.controller.getState().phase, 'uncertain'); assert.equal(f.close.inspect().disposition, 'blocked');
    await f.controller.refresh(); assert.equal(f.controller.getState().phase, 'uncertain');
    assert.equal(f.controller.getState().pending, pending); assert.equal(f.controller.canEdit(), false); assert.equal(f.writes.length, 1);
  } finally { f.cleanup(); }
});
