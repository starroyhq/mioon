import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspacePreferences, durableWorkspaceState, type WorkspacePreferencesStatus } from '../apps/web/src/workspace-preferences.ts';
import { defaultWorkspaceState, readStoredWorkspaceState, writeWorkspaceState, type WorkspaceState } from '../apps/web/src/workspace-state.ts';

const A = '994d1f5d-b34d-494b-a3cb-fb0e6c5df761';
const B = '297ac636-dd29-4eab-b8e5-a4514df7d3c2';
const SELECTED = 'd6c2b1f0-7712-4411-b6fe-ed1d3e9bf2e9';
const copy = <T>(value: T): T => structuredClone(value);
const state = (playhead = 0, activeMode: WorkspaceState['activeMode'] = 'canvas') => {
  const value = defaultWorkspaceState(); value.editing.playhead = playhead; value.activeMode = activeMode;
  return value;
};
const response = (data: { ok: boolean; data?: unknown; error?: { code: string; details: { currentRevision: unknown; }; }|{ code: string; message: string; }; }, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => copy(data) });
const deferred = () => { let resolve!: (value?: unknown)=>void, reject!: (reason?: unknown)=>void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pump = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Storage {
  values = new Map();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}
class Clock {
  time = 0; next = 0; timers = new Map();
  now = () => this.time;
  setTimeout = (fn: ()=>void, delay: number) => { const id = ++this.next; this.timers.set(id, { at: this.time + delay, fn }); return id; };
  clearTimeout = (id: unknown) => { this.timers.delete(id); };
  async tick(duration: number) {
    await pump();
    const end = this.time + duration;
    let count = 0;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++count < 1000, 'No busy retry loop');
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await pump();
    }
    this.time = end; await pump();
  }
}
class Server {
  records = new Map<string,import('./helpers/strict-workspace-boundary-types.ts').PreferenceState>(); calls:import('./helpers/strict-workspace-boundary-types.ts').PreferenceCall[] = []; hook:import('./helpers/strict-workspace-boundary-types.ts').PreferenceHook|null = null;
  set(projectId: string, value: unknown, revision = 1) { this.records.set(projectId, { projectId, revision, state: durableWorkspaceState(value) }); }
  data(projectId: string) { return copy(this.records.get(projectId) || { projectId, revision: 0, state: null }); }
  apply = (call: import('./helpers/strict-workspace-boundary-types.ts').PreferenceCall) => {
    const current = this.data((call.projectId as string));
    if (call.options.method === 'GET') return response({ ok: true, data: current });
    const body = call.body;
    if (current.revision === body.expectedRevision + 1 && JSON.stringify(current.state) === JSON.stringify(body.state)) {
      return response({ ok: true, data: current });
    }
    if (current.revision !== body.expectedRevision) return response({ ok: false, error: { code: 'PREFERENCES_CONFLICT', details: { currentRevision: current.revision } } }, 409);
    const next = { projectId: call.projectId, revision: current.revision + 1, state: copy(body.state) };
    this.records.set(call.projectId, next); return response({ ok: true, data: next });
  };
  fetch = async (url: string, options: RequestInit) => {
    const call = { url, projectId: decodeURIComponent(url.split('/').at(-1)!), options, body: options.body ? JSON.parse((options.body as string)) : null };
    this.calls.push(call);
    return this.hook ? this.hook(call, () => this.apply(call)) : this.apply(call);
  };
  puts() { return this.calls.filter(call => call.options.method === 'PUT'); }
}
function fixture(t: test.TestContext, options = {}) {
  const clock = new Clock(), server = new Server(), storage = new Storage(), states: { id: string; value: WorkspaceState; }[] = [], statuses: { id: string; value: WorkspacePreferencesStatus; }[] = [];
  const controller = (createWorkspacePreferences as unknown as (options:import('./helpers/strict-workspace-boundary-types.ts').PreferenceOptions)=>ReturnType<typeof createWorkspacePreferences>)({ fetchImpl: server.fetch, storage, requestTimeoutMs: 0,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    retryDelays: [10, 30], onState: (id, value) => states.push({ id, value }),
    onStatus: (id, value) => statuses.push({ id, value }), ...options });
  t.after(() => controller.dispose({ flush: false }));
  return { controller, clock, server, storage, states, statuses };
}

test('initial asynchronous GET gates defaults and every save', async t => {
  const { controller, server, clock } = fixture(t), gate = deferred();
  server.set(A, state(123, 'editing')); server.hook = (call, apply) => call.options.method === 'GET' ? gate.promise.then(apply) : apply();
  const loading = controller.load(A);
  assert.equal(controller.update(A, state(), { immediate: true }), false);
  await clock.tick(2000);
  assert.equal(server.puts().length, 0);
  gate.resolve!(); const loaded = await loading;
  assert.equal(loaded!.editing.playhead, 123); assert.equal(loaded!.activeMode, 'editing');
  await controller.flush(); assert.equal(server.puts().length, 0); assert.equal(controller.hasUnsaved(), false);
});

test('only confirmed absence imports a sanitized legacy record; search is renderer-only', async t => {
  const { controller, server, storage, clock } = fixture(t);
  const legacy = state(39, 'editing'); legacy.canvas.selectedId = SELECTED; legacy.canvas.selectedEdgeId = 'old-invalid-id';
  legacy.editing.quickAssetId = 'credential-like-text'; legacy.shared.assetSearch = 'private search'; (legacy as unknown as {secret:string}).secret = 'not allowed';
  writeWorkspaceState(A, legacy, storage);
  const loaded = await controller.load(A);
  assert.equal(loaded!.shared.assetSearch, 'private search'); assert.equal(server.puts().length, 0);
  await clock.tick(250);
  const saved = server.data(A);
  assert.equal(saved.revision, 1); assert.equal(saved.state!.canvas.selectedId, SELECTED);
  assert.equal(saved.state!.canvas.selectedEdgeId, null); assert.equal(saved.state!.editing.quickAssetId, null);
  assert.equal('assetSearch' in saved.state!.shared, false); assert.equal('secret' in saved.state!, false);
  assert.ok(![...storage.values.values()].join('').includes('private search'));
  assert.ok(![...storage.values.values()].join('').includes('credential-like-text'));
  assert.equal(controller.hasUnsaved(), false);
});

test('an existing remote workspace wins over stale local preferences without a write', async t => {
  const { controller, server, storage, clock } = fixture(t);
  writeWorkspaceState(A, state(12), storage); server.set(A, state(456, 'editing'), 8);
  assert.equal((await controller.load(A))!.editing.playhead, 456);
  await clock.tick(2000); await controller.flush();
  assert.equal(server.puts().length, 0); assert.equal(controller.getStatus(A)!.revision, 8);
});

test('a complete legacy v1 GET defaults snapping on without a migration write', async t => {
  const { controller, server, clock } = fixture(t), legacy = durableWorkspaceState(state(123, 'editing'));
  delete (legacy.editing as unknown as Record<PropertyKey,unknown>).snappingEnabled;
  server.records.set(A, { projectId: A, revision: 7, state: copy(legacy) });
  const loaded = await controller.load(A);
  assert.equal(loaded!.editing.snappingEnabled, true); assert.equal(loaded!.editing.playhead, 123);
  assert.equal(controller.getStatus(A)!.phase, 'saved'); assert.equal(controller.getStatus(A)!.revision, 7);
  await clock.tick(2000); await controller.flush();
  assert.equal(server.puts().length, 0); assert.equal(controller.hasUnsaved(), false);
  assert.deepEqual(server.data(A).state, legacy);
});

test('a raw legacy v1 cache defaults snapping on for safe import or offline fallback', async t => {
  for (const offline of [false, true] as const) {
    const { controller, server, storage, clock } = fixture(t), legacy = state(51, 'editing');
    delete (legacy.editing as unknown as Record<PropertyKey,unknown>).snappingEnabled;
    const raw = JSON.stringify(legacy); storage.setItem(`mioon.workspace.v1:${A}`, raw);
    if (offline) server.hook = () => { throw new Error('offline'); };
    const loaded = await controller.load(A);
    assert.equal(loaded!.editing.snappingEnabled, true); assert.equal(loaded!.editing.playhead, 51);
    await clock.tick(2000); await controller.flush();
    if (offline) {
      assert.equal(controller.getStatus(A)!.phase, 'local'); assert.equal(server.puts().length, 0);
      assert.equal(storage.getItem(`mioon.workspace.v1:${A}`), raw);
    } else {
      assert.equal(server.puts().length, 1); assert.equal(server.puts()[0].body.state.editing.snappingEnabled, true);
      assert.equal(server.data(A).revision, 1); assert.equal(controller.getStatus(A)!.phase, 'saved');
    }
  }
});

test('GET accepts only whole-layout legacy omission and seeds both mode flags without migration writes', async t => {
  for (const magnetLegacy of [false, true] as const) {
    const { controller, server, clock } = fixture(t), legacy = durableWorkspaceState(state(42, 'editing'));
    delete (legacy as unknown as Record<PropertyKey,unknown>).layout;
    if (magnetLegacy) delete (legacy.editing as unknown as Record<PropertyKey,unknown>).snappingEnabled;
    else legacy.editing.snappingEnabled = false;
    legacy.shared.assetsCollapsed = true;
    server.records.set(A, { projectId: A, revision: 8, state: copy(legacy) });
    const loaded = await controller.load(A);
    for (const mode of ['canvas', 'editing'] as const) {
      assert.equal(loaded!.layout[mode].assetsCollapsed, true);
      assert.equal(loaded!.layout[mode].inspectorCollapsed, false);
      assert.equal(loaded!.layout[mode].assetsWidth, 260);
    }
    assert.equal(loaded!.editing.snappingEnabled, magnetLegacy);
    await clock.tick(2000); await controller.flush();
    assert.equal(controller.getStatus(A)!.phase, 'saved'); assert.equal(controller.getStatus(A)!.revision, 8);
    assert.equal(server.puts().length, 0); assert.equal(controller.hasUnsaved(), false);
    assert.deepEqual(server.data(A).state, legacy);
  }
});

test('raw legacy layout cache safely imports after confirmed absence and remains local when offline', async t => {
  for (const offline of [false, true] as const) {
    const { controller, server, storage, clock } = fixture(t), legacy = state(51, 'editing');
    delete (legacy as unknown as Record<PropertyKey,unknown>).layout; legacy.shared.inspectorCollapsed = true; legacy.editing.snappingEnabled = false;
    const raw = JSON.stringify(legacy); storage.setItem(`mioon.workspace.v1:${A}`, raw);
    if (offline) server.hook = () => { throw new Error('offline'); };
    const loaded = await controller.load(A);
    assert.equal(loaded!.layout.canvas.inspectorCollapsed, true); assert.equal(loaded!.layout.editing.inspectorCollapsed, true);
    assert.equal(loaded!.editing.snappingEnabled, false);
    await clock.tick(2000); await controller.flush();
    if (offline) {
      assert.equal(controller.getStatus(A)!.phase, 'local'); assert.equal(server.puts().length, 0);
      assert.equal(storage.getItem(`mioon.workspace.v1:${A}`), raw);
    } else {
      assert.equal(server.puts().length, 1); assert.deepEqual(server.data(A).state!.layout, loaded!.layout);
      assert.equal(server.data(A).revision, 1);
    }
  }
});

test('mode layout changes persist independently and a lost response replays the exact layout body', async t => {
  const { controller, server, clock, storage } = fixture(t), original = state();
  original.layout.canvas = { assetsWidth: 480, inspectorWidth: 555.25, assetsCollapsed: true, inspectorCollapsed: false };
  original.layout.editing = { assetsWidth: 182, inspectorWidth: 260, assetsCollapsed: false, inspectorCollapsed: true, timelineHeight: 701 };
  original.editing.snappingEnabled = false;
  await controller.load(A);
  let lost = true;
  server.hook = (call, apply) => {
    const result = apply();
    if (call.options.method === 'PUT' && lost) { lost = false; throw new Error('lost after commit'); }
    return result;
  };
  controller.update(A, original, { immediate: true }); await pump();
  const later = copy(original); later.activeMode = 'editing'; later.layout.editing.timelineHeight = 612;
  controller.update(A, later);
  await clock.tick(10);
  assert.deepEqual(server.puts()[0].body, server.puts()[1].body);
  assert.deepEqual(server.data(A).state!.layout, later.layout); assert.equal(server.data(A).revision, 2);
  assert.deepEqual(readStoredWorkspaceState(A, storage)!.layout, later.layout);
  assert.deepEqual((await controller.load(B))!.layout, state().layout);
  assert.deepEqual((await controller.load(A, { reload: true }))!.layout, later.layout);
  assert.equal(controller.getSnapshot(A)!.editing.snappingEnabled, false);
});

test('PUT acknowledgement cannot omit layout or repair a missing nested field even when defaults match', async t => {
  for (const mutate of [
(    value: { layout: unknown; }) => { delete (value as unknown as Record<PropertyKey,unknown>).layout; },
(    value: { layout: { canvas: { assetsWidth: unknown; }; }; }) => { delete (value.layout.canvas as unknown as Record<PropertyKey,unknown>).assetsWidth; },
(    value: { layout: { editing: { timelineHeight: unknown; }; }; }) => { delete (value.layout.editing as unknown as Record<PropertyKey,unknown>).timelineHeight; },
(    value: { layout: { editing: { extra: boolean; }; }; }) => { value.layout.editing.extra = true; },
(    value: { layout: { canvas: { assetsCollapsed: null; }; }; }) => { value.layout.canvas.assetsCollapsed = null; },
  ] as const) {
    const { controller, server } = fixture(t);
    await controller.load(A);
    server.hook = (call, apply) => {
      const result = apply(); if (call.options.method !== 'PUT') return result;
      const data = server.data(A); (mutate as unknown as (value:unknown)=>void)(((data.state! as unknown as Parameters<typeof mutate>[0]))); return response({ ok: true, data });
    };
    controller.update(A, state(12), { immediate: true }); await pump();
    assert.equal(controller.hasUnsaved(), true); assert.equal(controller.getStatus(A)!.revision, 0);
    server.hook = null; await controller.flush();
    assert.deepEqual(server.puts()[0].body, server.puts()[1].body);
    assert.equal(server.data(A).revision, 1); assert.equal(controller.hasUnsaved(), false);
  }
});

test('magnet off persists, reloads, and stays isolated while lost responses replay its exact CAS body', async t => {
  const { controller, server, clock, storage } = fixture(t);
  const disabled = state(); disabled.editing.snappingEnabled = false;
  await controller.load(A);
  let lost = true;
  server.hook = (call, apply) => {
    const result = apply();
    if (call.options.method === 'PUT' && lost) { lost = false; throw new Error('lost after commit'); }
    return result;
  };
  controller.update(A, disabled, { immediate: true }); await pump();
  assert.equal(server.puts()[0].body.state.editing.snappingEnabled, false);
  await clock.tick(10);
  assert.deepEqual(server.puts()[0].body, server.puts()[1].body);
  assert.equal(server.data(A).revision, 1); assert.equal(controller.hasUnsaved(), false);
  assert.equal(readStoredWorkspaceState(A, storage)!.editing.snappingEnabled, false);
  assert.equal((await controller.load(B))!.editing.snappingEnabled, true);
  controller.update(B, state(22)); await controller.flush();
  assert.equal(server.data(B).state!.editing.snappingEnabled, true);
  assert.equal((await controller.load(A, { reload: true }))!.editing.snappingEnabled, false);
  assert.equal(server.data(A).state!.editing.snappingEnabled, false);
});

test('a PUT acknowledgement cannot omit the magnet field even when its default would match', async t => {
  const { controller, server } = fixture(t);
  await controller.load(A);
  server.hook = (call, apply) => {
    const result = apply();
    if (call.options.method !== 'PUT') return result;
    const data = server.data(A); delete (data.state!.editing as unknown as Record<PropertyKey,unknown>).snappingEnabled;
    return response({ ok: true, data });
  };
  controller.update(A, state(12), { immediate: true }); await pump();
  assert.equal(controller.hasUnsaved(), true); assert.equal(controller.getStatus(A)!.phase, 'pending');
  assert.equal(controller.getStatus(A)!.revision, 0);
  server.hook = null; await controller.flush();
  assert.deepEqual(server.puts()[0].body, server.puts()[1].body);
  assert.equal(server.data(A).revision, 1); assert.equal(controller.hasUnsaved(), false);
});

test('absent or malformed legacy storage does not schedule a default-state write', async t => {
  const { controller, server, storage, clock } = fixture(t);
  storage.setItem(`mioon.workspace.v1:${A}`, '{broken');
  assert.equal(readStoredWorkspaceState(A, storage), null);
  await controller.load(A); await clock.tick(2000); await controller.flush();
  assert.equal(server.puts().length, 0); assert.equal(controller.hasUnsaved(), false);
});

test('an unavailable API keeps the remote untouched, permits local fallback, and reloads authoritatively', async t => {
  const { controller, server, storage, clock, statuses } = fixture(t);
  server.set(A, state(888), 7); writeWorkspaceState(A, state(3), storage);
  server.hook = () => { throw new TypeError('offline'); };
  assert.equal((await controller.load(A))!.editing.playhead, 3);
  assert.equal(controller.getStatus(A)!.phase, 'local'); assert.equal(controller.hasUnsaved(), false);
  controller.update(A, state(25, 'editing'), { immediate: true }); await clock.tick(10000); await controller.flush();
  assert.equal(controller.hasUnsaved(), true); assert.equal(server.puts().length, 0);
  assert.equal(statuses.at(-1)!.value.phase, 'local'); assert.equal(statuses.at(-1)!.value.pending, true);
  assert.equal(statuses.at(-1)!.value.canRetry, false);
  assert.equal(readStoredWorkspaceState(A, storage)!.editing.playhead, 25); assert.equal(server.data(A).state!.editing.playhead, 888);
  server.hook = null;
  assert.equal((await controller.load(A, { reload: true }))!.editing.playhead, 888);
  assert.equal(controller.hasUnsaved(), false); assert.equal(server.puts().length, 0);
});

test('denied storage is harmless while API preferences load and save', async t => {
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const { controller, server } = fixture(t, { storage: denied });
  server.set(A, state(4)); await controller.load(A);
  controller.update(A, state(5), { immediate: true }); await controller.flush();
  assert.equal(server.data(A).state!.editing.playhead, 5); assert.equal(controller.hasUnsaved(), false);
});

test('a denied global localStorage getter never prevents remote persistence', async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'localStorage', prior) : delete (globalThis as unknown as Record<PropertyKey,unknown>).localStorage);
  const { controller, server } = fixture(t, { storage: undefined });
  await controller.load(A); controller.update(A, state(5)); await controller.flush();
  assert.equal(server.data(A).state!.editing.playhead, 5);
});

test('transient saves retry serially and retain the latest edits behind the exact failed body', async t => {
  const { controller, server, clock } = fixture(t);
  await controller.load(A);
  let failures = 1;
  server.hook = (call, apply) => { if (call.options.method === 'PUT' && failures-- > 0) throw new Error('connection failed'); return apply(); };
  controller.update(A, state(10), { immediate: true }); await pump();
  assert.equal(controller.getStatus(A)!.phase, 'pending');
  controller.update(A, state(20)); await clock.tick(10);
  assert.deepEqual(server.puts().map(call => [call.body.expectedRevision, call.body.state.editing.playhead]), [[0, 10], [0, 10], [1, 20]]);
  assert.equal(server.data(A).state!.editing.playhead, 20); assert.equal(controller.hasUnsaved(), false);
});

test('lost response retries the exact acknowledged write before saving a newer desired state', async t => {
  const { controller, server, clock } = fixture(t);
  await controller.load(A); let lost = true;
  server.hook = (call, apply) => { const result = apply(); if (call.options.method === 'PUT' && lost) { lost = false; throw new Error('response lost after commit'); } return result; };
  controller.update(A, state(71), { immediate: true }); await pump();
  controller.update(A, state(72)); await clock.tick(10);
  assert.deepEqual(server.puts()[0].body, server.puts()[1].body);
  assert.equal(server.data(A).revision, 2); assert.equal(server.data(A).state!.editing.playhead, 72);
  assert.equal(controller.getStatus(A)!.phase, 'saved');
});

test('automatic retry count is finite and explicit flush can recover the retained request', async t => {
  const { controller, server, clock } = fixture(t);
  await controller.load(A); server.hook = () => { throw new Error('offline'); };
  controller.update(A, state(12), { immediate: true }); await clock.tick(10000);
  assert.equal(server.puts().length, 3); assert.equal(clock.timers.size, 0);
  assert.equal(controller.getStatus(A)!.phase, 'error'); assert.equal(controller.hasUnsaved(), true);
  assert.equal(controller.getStatus(A)!.canRetry, true);
  controller.update(A, state(99)); await clock.tick(10000); assert.equal(server.puts().length, 3);
  server.hook = null; await controller.flush();
  assert.equal(server.data(A).state!.editing.playhead, 99); assert.equal(controller.hasUnsaved(), false);
});

test('a flush waits the in-flight request and chains only the newest state with the next revision', async t => {
  const { controller, server } = fixture(t), gate = deferred();
  await controller.load(A); let held = true;
  server.hook = (call, apply) => { if (call.options.method === 'PUT' && held) { held = false; return gate.promise.then(apply); } return apply(); };
  controller.update(A, state(1), { immediate: true }); await pump();
  controller.update(A, state(2), { immediate: true }); controller.update(A, state(3));
  let complete = false; const flushing = controller.flush({ keepalive: true }).then(() => { complete = true; });
  await pump(); assert.equal(server.puts().length, 1); assert.equal(complete, false);
  gate.resolve!(); await flushing;
  assert.deepEqual(server.puts().map(call => [call.body.expectedRevision, call.body.state.editing.playhead]), [[0, 1], [1, 3]]);
  assert.ok(server.puts().every(call => call.options.keepalive === true && call.options.credentials === 'same-origin'));
  assert.equal(controller.hasUnsaved(), false);
});

test('a final flush resolves on an in-flight failure with pending unsaved state instead of looping', async t => {
  const { controller, server, clock } = fixture(t), gate = deferred();
  await controller.load(A); server.hook = () => gate.promise;
  controller.update(A, state(1), { immediate: true }); await pump(); controller.update(A, state(2));
  const flushing = controller.flush({ keepalive: true }); gate.reject!(new Error('offline'));
  await flushing; assert.equal(controller.hasUnsaved(), true); assert.equal(server.puts().length, 1);
  assert.equal(clock.timers.size, 1);
});

test('conflict blocks all further writes until an explicit authoritative reload', async t => {
  const { controller, server, clock } = fixture(t);
  server.set(A, state(1), 4); await controller.load(A); server.set(A, state(5), 5);
  controller.update(A, state(2), { immediate: true }); await pump();
  assert.equal(controller.getStatus(A)!.phase, 'conflict'); assert.equal(controller.hasUnsaved(), true);
  controller.update(A, state(3), { immediate: true }); await controller.flush(); await clock.tick(10000);
  await controller.load(B); await controller.load(A); await controller.flush();
  assert.equal(server.puts().length, 1); assert.equal(controller.getStatus(A)!.phase, 'conflict');
  assert.equal((await controller.load(A, { reload: true }))!.editing.playhead, 5);
  controller.update(A, state(6), { immediate: true }); await controller.flush();
  assert.equal(server.data(A).revision, 6); assert.equal(server.data(A).state!.editing.playhead, 6);
});

test('non-transient save errors do not auto-retry or overwrite on a later flush', async t => {
  const { controller, server, clock } = fixture(t);
  await controller.load(A); server.hook = () => response({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  controller.update(A, state(1), { immediate: true }); await clock.tick(10000); await controller.flush();
  assert.equal(server.puts().length, 1); assert.equal(controller.getStatus(A)!.phase, 'error');
  assert.equal(controller.getStatus(A)!.error!.code, 'UNAUTHORIZED'); assert.equal(controller.hasUnsaved(), true);
  assert.equal(controller.getStatus(A)!.canRetry, false);
});

test('stale project loads cannot replace the active UI, while sessions remain independent', async t => {
  const { controller, server, states } = fixture(t), gate = deferred();
  server.set(A, state(10)); server.set(B, state(20));
  server.hook = (call, apply) => call.projectId === A && call.options.method === 'GET' ? gate.promise.then(apply) : apply();
  const first = controller.load(A); await controller.load(B); gate.resolve!();
  assert.equal(await first, null); assert.deepEqual(states.map(item => item.id), [B]);
  assert.equal(controller.getSnapshot(A)!.editing.playhead, 10); assert.equal(controller.getSnapshot(B)!.editing.playhead, 20);
  assert.equal((await controller.load(A))!.editing.playhead, 10); assert.deepEqual(states.map(item => item.id), [B, A]);
});

test('a superseded same-project reload ignores the older delayed load result', async t => {
  const { controller, server, states } = fixture(t), gate = deferred(); let gets = 0;
  server.hook = (call, apply) => {
    if (call.options.method === 'GET' && ++gets === 1) return gate.promise;
    return apply();
  };
  const first = controller.load(A); server.set(A, state(44), 8); await controller.load(A, { reload: true });
  gate.resolve!(response({ ok: true, data: { projectId: A, revision: 3, state: durableWorkspaceState(state(9)) } }));
  assert.equal(await first, null); assert.deepEqual(states.map(item => item.value.editing.playhead), [44]);
  assert.equal(controller.getStatus(A)!.revision, 8);
});

test('project switching flushes the previous project without waiting to load the next', async t => {
  const { controller, server } = fixture(t), gate = deferred();
  await controller.load(A); controller.update(A, state(111));
  server.hook = (call, apply) => call.projectId === A && call.options.method === 'PUT' ? gate.promise.then(apply) : apply();
  await controller.load(B); controller.update(B, state(222), { immediate: true }); await controller.flush({ projectId: B });
  assert.equal(server.data(B).state!.editing.playhead, 222); assert.equal(server.data(A).revision, 0);
  gate.resolve!(); await controller.flush({ projectId: A });
  assert.equal(server.data(A).state!.editing.playhead, 111); assert.equal(controller.getSnapshot(B)!.editing.playhead, 222);
});

test('trailing debounce coalesces frequent geometry changes and has a bounded max wait', async t => {
  const { controller, server, clock } = fixture(t);
  await controller.load(A);
  for (let frame = 1; frame <= 10; frame++) {
    controller.update(A, state(frame)); await clock.tick(100);
  }
  assert.equal(server.puts().length, 1); assert.equal(server.data(A).state!.editing.playhead, 10);
  controller.update(A, state(11)); await clock.tick(249); assert.equal(server.puts().length, 1);
  await clock.tick(1); assert.equal(server.puts().length, 2); assert.equal(server.data(A).state!.editing.playhead, 11);
});

test('lifecycle flush bypasses trailing throttle and local-only search changes never write remotely', async t => {
  const { controller, server, storage, clock } = fixture(t);
  await controller.load(A); controller.update(A, state(87));
  await clock.tick(20); assert.equal(server.puts().length, 0);
  await controller.flush({ keepalive: true }); assert.equal(server.puts().length, 1);
  const next = state(87); next.shared.assetSearch = 'never persisted'; controller.update(A, next);
  await clock.tick(1000); await controller.flush();
  assert.equal(server.puts().length, 1); assert.equal(controller.getSnapshot(A)!.shared.assetSearch, 'never persisted');
  assert.ok(![...storage.values.values()].join('').includes('never persisted'));
});

test('disposal ignores delayed loads and callbacks, and does not import defaults or legacy afterward', async t => {
  const { controller, server, storage, states, statuses, clock } = fixture(t), gate = deferred();
  writeWorkspaceState(A, state(25), storage);
  server.hook = (call, apply) => gate.promise.then(apply);
  const loading = controller.load(A); const count = statuses.length;
  await controller.dispose(); gate.resolve!(); assert.equal(await loading, null);
  await clock.tick(5000); assert.equal(states.length, 0); assert.equal(statuses.length, count); assert.equal(server.puts().length, 0);
  assert.equal(controller.update(A, state(9)), false); assert.equal(await controller.load(B), null);
});

test('disposal keeps an existing save and final queued keepalive update alive without callbacks', async t => {
  const { controller, server, statuses, clock } = fixture(t), gate = deferred();
  await controller.load(A); let held = true;
  server.hook = (call, apply) => { if (held) { held = false; return gate.promise.then(apply); } return apply(); };
  controller.update(A, state(1), { immediate: true }); await pump(); controller.update(A, state(2));
  const count = statuses.length, disposing = controller.dispose(); gate.resolve!(); await disposing;
  assert.equal(server.data(A).state!.editing.playhead, 2); assert.equal(statuses.length, count); assert.equal(clock.timers.size, 0);
  assert.equal(controller.hasUnsaved(), false);
});

test('transport timeout is bounded and cannot later apply a stale GET result', async t => {
  const { controller, server, clock, states } = fixture(t, { requestTimeoutMs: 50 }); const gate = deferred();
  server.hook = () => gate.promise; const loading = controller.load(A); await clock.tick(50);
  await loading; assert.equal(controller.getStatus(A)!.phase, 'local'); assert.equal(states.length, 1);
  gate.resolve!(response({ ok: true, data: { projectId: A, revision: 6, state: durableWorkspaceState(state(99)) } }));
  await pump(); assert.equal(controller.getSnapshot(A)!.editing.playhead, 0); assert.equal(states.length, 1);
});

test('malformed remote envelopes never establish absence or trigger legacy import', async t => {
  const { controller, server, storage, clock } = fixture(t);
  writeWorkspaceState(A, state(10), storage); server.hook = () => response({ ok: true, data: { projectId: B, revision: 0, state: null } });
  await controller.load(A); controller.update(A, state(20)); await controller.flush(); await clock.tick(10000);
  assert.equal(controller.getStatus(A)!.phase, 'local'); assert.equal(server.puts().length, 0);
});

test('partial, unbounded or unexpected successful remote states cannot become writable defaults', async t => {
  const malformed = [
    { version: 1, canvas: {}, editing: {}, shared: {} },
    { ...durableWorkspaceState(state()), activeMode: 'unknown' },
    { ...durableWorkspaceState(state()), extra: 'not a preference' },
  ];
  const outOfBounds = durableWorkspaceState(state()); outOfBounds.editing.playhead = 999999; malformed.push(outOfBounds);
  const wrongId = durableWorkspaceState(state()); wrongId.canvas.selectedId = 'unexpected-text'; malformed.push(wrongId);
  for (const bad of [null, 0, 1, 'true', 'false', [], {}] as const) {
    const wrongMagnet = durableWorkspaceState(state()); (wrongMagnet.editing as unknown as {snappingEnabled:unknown}).snappingEnabled = bad; malformed.push(wrongMagnet);
  }
  for (const key of Object.keys(durableWorkspaceState(state()).editing).filter(key => key !== 'snappingEnabled')) {
    const partialLegacy = durableWorkspaceState(state());
    delete (partialLegacy.editing as unknown as Record<PropertyKey,unknown>).snappingEnabled; delete (partialLegacy.editing as unknown as Record<PropertyKey,unknown>)[key]; malformed.push(partialLegacy);
  }
  const unknownLegacy = durableWorkspaceState(state()); delete (unknownLegacy.editing as unknown as Record<PropertyKey,unknown>).snappingEnabled;
  (unknownLegacy.editing as unknown as {magnet:boolean}).magnet = true; malformed.push(unknownLegacy);
  for (const bad of [null, [], {}, false, { canvas: {} }] as const) {
    const value = durableWorkspaceState(state()); (value as unknown as {layout:unknown}).layout = bad; malformed.push(value);
  }
  for (const mode of ['canvas', 'editing'] as const) {
    for (const key of Object.keys(state().layout[mode])) {
      const value = durableWorkspaceState(state()); delete (value.layout[mode] as unknown as Record<PropertyKey,unknown>)[key]; malformed.push(value);
    }
    for (const assetsWidth of [0, 481, '242', null] as const) {
      const value = durableWorkspaceState(state()); (value.layout[mode] as unknown as {assetsWidth:unknown}).assetsWidth = assetsWidth; malformed.push(value);
    }
    const extra = durableWorkspaceState(state()); (extra.layout[mode] as unknown as {extra:boolean}).extra = true; malformed.push(extra);
  }
  const missingShared = durableWorkspaceState(state()); delete (missingShared as unknown as Record<PropertyKey,unknown>).layout; delete (missingShared.shared as unknown as Record<PropertyKey,unknown>).assetsCollapsed; malformed.push(missingShared);
  for (const value of malformed) {
    const { controller, server, storage, clock } = fixture(t);
    writeWorkspaceState(A, state(10), storage);
    server.hook = () => response({ ok: true, data: { projectId: A, revision: 4, state: value } });
    assert.equal((await controller.load(A))!.editing.playhead, 10);
    controller.update(A, state(20), { immediate: true }); await controller.flush(); await clock.tick(10000);
    assert.equal(controller.getStatus(A)!.phase, 'local'); assert.equal(server.puts().length, 0);
  }
});

test('complete remote preferences accept JSON field reordering without a write', async t => {
  const { controller, server } = fixture(t), expected = durableWorkspaceState(state(23, 'editing'));
  const reorder = (value: unknown): unknown => value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  server.hook = () => response({ ok: true, data: { projectId: A, revision: 7, state: reorder(expected) } });
  assert.equal((await controller.load(A))!.editing.playhead, 23);
  assert.equal(controller.getStatus(A)!.phase, 'saved');
  await controller.flush(); assert.equal(server.puts().length, 0);
});

test('response validation matches the backend UUID contract including sentinel IDs', async t => {
  const { controller, server } = fixture(t), saved = state(12);
  saved.canvas.selectedId = '00000000-0000-0000-0000-000000000000';
  saved.editing.selectedClipId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  server.set(A, saved);
  assert.equal((await controller.load(A))!.canvas.selectedId, saved.canvas.selectedId);
  assert.equal(controller.getStatus(A)!.phase, 'saved');
  await controller.flush(); assert.equal(server.puts().length, 0);
});
