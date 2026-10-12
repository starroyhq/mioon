import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipDraftController } from '../apps/web/src/clip-draft-state.ts';
import { ClipDraftRequestError } from '../apps/web/src/clip-draft-client.ts';

const id = n => `d2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-12T21:00:00.000Z';
const key = { projectId: id(1), timelineId: id(2), clipId: id(3) };
const source = { assetId: id(5), assetSha256: 'b'.repeat(64), versionId: id(8) };
const raw = { name: 'Saved clip', trackId: id(4), startFrame: 0, durationFrames: 120, sourceInFrame: 0,
  rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 };
const context = () => ({ ...key, scope: 'project:1:inspector:1', restored: false, connected: true, visible: true,
  busy: false, timelineRevision: 7, source: structuredClone(source), saved: structuredClone(raw) });
const record = (patch = {}) => ({ baseRevision: 7, source: structuredClone(source), raw: { ...structuredClone(raw), name: 'Recovered' }, updatedAt: stamp, ...patch });
const row = (draft = null) => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(6), key,
  revision: draft ? 1 : 0, targetStatus: 'matching', draft });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const ack = input => ({ ...row(), revision: input.expectedRevision + 1,
  draft: record({ raw: structuredClone(input.raw), source: structuredClone(input.source), baseRevision: input.baseRevision }) });

function harness(t, { draft = null, ctx = context(), hooks = {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let saved = row(draft);
  const calls = [], changes = [];
  const client = {
    async get(input) { calls.push(['get', structuredClone(input)]); return hooks.get ? hooks.get(input, structuredClone(saved)) : structuredClone(saved); },
    async put(input) {
      calls.push(['put', structuredClone(input)]);
      if (hooks.put) return hooks.put(input, structuredClone(saved));
      assert.equal(input.expectedRevision, saved.revision); assert.equal(input.instanceId, saved.instanceId); assert.equal(input.workspaceScope, saved.workspaceScope);
      saved = ack(input); return structuredClone(saved);
    },
    async remove(input) {
      calls.push(['delete', structuredClone(input)]);
      if (hooks.remove) return hooks.remove(input, structuredClone(saved));
      assert.equal(input.expectedRevision, saved.revision);
      saved = { ...saved, revision: input.expectedRevision + 1, draft: null }; return structuredClone(saved);
    },
  };
  const controller = createClipDraftController({ context: ctx, client, onChange: next => changes.push(structuredClone(next)) });
  t.after(() => controller.dispose());
  return { controller, calls, changes, ctx, current: () => structuredClone(saved), replace: next => { saved = structuredClone(next); },
    puts: () => calls.filter(([method]) => method === 'put').map(([, input]) => input) };
}

test('close flush persists exact raw before the 250 ms timer and never calls business Save', async t => {
  const h = harness(t); await h.controller.load();
  h.controller.save = async () => { assert.fail('A close flush cannot dispatch business Save'); };
  h.controller.edit('name', 'Typed just before close'); h.controller.edit('startFrame', ''); h.controller.edit('gain', '0.50');
  h.controller.edit('rect', { ...raw.rect, x: '001' });
  assert.equal(h.controller.hasUnpersisted(), true); t.mock.timers.tick(249); assert.equal(h.puts().length, 0);
  const captured = structuredClone(h.controller.getState().raw), closing = h.controller.flushForClose();
  assert.equal(h.puts().length, 1, 'Close starts PUT without waiting for the debounce');
  assert.equal(await closing, true); assert.deepEqual(h.current().draft.raw, captured);
  assert.deepEqual(h.current().draft.source, source); assert.equal(h.current().draft.baseRevision, 7);
  assert.equal(h.controller.hasUnpersisted(), false); assert.equal(h.controller.hasUnsaved(), true);
  t.mock.timers.tick(1000); await turn(); assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put']);
});

test('ordinary flush remains Promise<void> and business dirty differs from unpersisted raw', async t => {
  const h = harness(t); await h.controller.load(); h.controller.edit('name', 'Unapplied business change');
  assert.equal(await h.controller.flush(), undefined); assert.equal(h.controller.getDirty(), true);
  assert.equal(h.controller.hasUnsaved(), true); assert.equal(h.controller.hasUnpersisted(), false);
  assert.equal(await h.controller.flushForClose(), true); assert.equal(h.puts().length, 1);
});

for (const persisted of [false, true]) {
  test(`a ${persisted ? 'persisted dirty' : 'pristine'} fast-path close rechecks serial when its Promise settles`, async t => {
    const h = harness(t);
    if (persisted) { await h.controller.load(); h.controller.edit('name', 'Already stored'); await h.controller.flush(); }
    const closing = h.controller.flushForClose(); h.controller.edit('name', 'Changed before close Promise settled');
    assert.equal(await closing, false); assert.equal(h.controller.hasUnpersisted(), true);
    assert.equal(h.puts().length, persisted ? 1 : 0); assert.equal(h.controller.getState().raw.name, 'Changed before close Promise settled');
  });
}

test('a pristine form and an untouched recovery candidate need no close write', async t => {
  const h = harness(t, { draft: record() });
  assert.equal(h.controller.hasUnpersisted(), false); assert.equal(await h.controller.flushForClose(), true); assert.deepEqual(h.calls, []);
  await h.controller.load(); assert.equal(await h.controller.flushForClose(), true);
  assert.equal(h.controller.getState().raw.name, raw.name); assert.equal(h.controller.getState().candidate.raw.name, 'Recovered');
  assert.equal(h.controller.restore(), true); assert.equal(h.controller.getDirty(), true);
  assert.equal(h.controller.hasUnpersisted(), false); assert.equal(await h.controller.flushForClose(), true);
  assert.deepEqual(h.calls.map(([method]) => method), ['get']);
});

test('dirty input before GET finishes returns false without implicit reads, writes, or lost raw', async t => {
  const reading = deferred(), h = harness(t, { hooks: { get: () => reading.promise } });
  h.controller.edit('name', 'Not loaded'); assert.equal(await h.controller.flushForClose(), false); assert.deepEqual(h.calls, []);
  const loading = h.controller.load(); assert.equal(await h.controller.flushForClose(), false);
  assert.equal(h.controller.hasUnpersisted(), true); assert.equal(h.controller.getState().raw.name, 'Not loaded');
  reading.resolve(row()); await loading; assert.equal(await h.controller.flushForClose(), true);
  assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put']);
});

test('restored workspaces keep manual editing and close false for dirty raw with no sidecar I/O', async t => {
  const h = harness(t, { ctx: { ...context(), restored: true } }); await h.controller.load();
  assert.equal(await h.controller.flushForClose(), true); assert.equal(h.controller.edit('name', 'Restored manual edit'), true);
  assert.equal(h.controller.hasUnpersisted(), true); assert.equal(await h.controller.flushForClose(), false);
  assert.equal(h.controller.getState().raw.name, 'Restored manual edit'); assert.equal(h.controller.getDirty(), true); assert.deepEqual(h.calls, []);
});

test('offline dirty input and an unresolved different candidate cannot be acknowledged on close', async t => {
  const h = harness(t, { draft: record(), ctx: { ...context(), connected: false } }); await h.controller.load();
  h.controller.edit('name', 'Keep current input'); assert.equal(await h.controller.flushForClose(), false);
  h.controller.setContext({ ...h.ctx, connected: true }); assert.equal(await h.controller.flushForClose(), false);
  assert.equal(h.controller.hasUnpersisted(), true); assert.equal(h.controller.getState().raw.name, 'Keep current input');
  assert.equal(h.controller.getState().candidate.raw.name, 'Recovered'); assert.deepEqual(h.calls.map(([method]) => method), ['get']);
});

test('concurrent close requests join the old PUT and perform at most one legal next CAS for current raw', async t => {
  const first = deferred(), second = deferred();
  const h = harness(t, { hooks: { put: async input => { await (input.expectedRevision === 0 ? first : second).promise; const next = ack(input); h.replace(next); return next; } } });
  await h.controller.load(); h.controller.edit('name', 'Older in-flight raw'); const writing = h.controller.flush();
  h.controller.edit('name', 'Current raw before close');
  const closing = h.controller.flushForClose(), concurrent = h.controller.flushForClose();
  assert.equal(closing, concurrent, 'Concurrent close requests share one drain'); assert.equal(h.puts().length, 1);
  first.resolve(); await writing; await turn(); assert.equal(h.puts().length, 2);
  assert.deepEqual(h.puts().map(input => [input.expectedRevision, input.raw.name]), [[0, 'Older in-flight raw'], [1, 'Current raw before close']]);
  second.resolve(); assert.equal(await closing, true); assert.equal(await concurrent, true);
  assert.equal(h.controller.hasUnpersisted(), false); assert.equal(h.calls.some(([method]) => method === 'delete'), false);
});

test('concurrent ordinary flush callers share a bounded next write instead of recursively chasing edits', async t => {
  const first = deferred(), second = deferred();
  const h = harness(t, { hooks: { put: async input => { if (input.expectedRevision < 2) await (input.expectedRevision === 0 ? first : second).promise;
    const next = ack(input); h.replace(next); return next; } } });
  await h.controller.load(); h.controller.edit('name', 'First'); const writing = h.controller.flush();
  h.controller.edit('name', 'Second'); const a = h.controller.flush(), b = h.controller.flush();
  first.resolve(); await writing; await turn(); assert.equal(h.puts().length, 2);
  h.controller.edit('name', 'Third'); second.resolve(); await Promise.all([a, b]);
  assert.equal(h.puts().length, 2, 'Concurrent callers must not chase another changed serial');
  assert.equal(h.controller.hasUnpersisted(), true); t.mock.timers.tick(250); await turn();
  assert.deepEqual(h.puts().map(input => input.expectedRevision), [0, 1, 2]);
});

test('editing during the final close PUT returns false and leaves newer raw for the normal debounce', async t => {
  const gate = deferred(); let count = 0;
  const h = harness(t, { hooks: { put: async input => { if (++count === 1) await gate.promise; const next = ack(input); h.replace(next); return next; } } });
  await h.controller.load(); h.controller.edit('name', 'Captured close raw'); const closing = h.controller.flushForClose();
  h.controller.edit('name', 'Newer raw during close'); gate.resolve(); assert.equal(await closing, false);
  assert.equal(h.puts().length, 1); assert.equal(h.current().draft.raw.name, 'Captured close raw');
  assert.equal(h.controller.getState().raw.name, 'Newer raw during close'); assert.equal(h.controller.hasUnpersisted(), true);
  t.mock.timers.tick(249); await turn(); assert.equal(h.puts().length, 1);
  t.mock.timers.tick(1); await turn(); assert.equal(h.puts().length, 2); assert.equal(h.current().draft.raw.name, 'Newer raw during close');
});

test('input changed back during close still invalidates the captured serial', async t => {
  const gate = deferred(), h = harness(t, { hooks: { put: async input => { await gate.promise; return ack(input); } } });
  await h.controller.load(); h.controller.edit('name', 'Same visible value'); const token = h.controller.capture(), closing = h.controller.flushForClose();
  h.controller.edit('name', 'Intervening edit'); h.controller.edit('name', 'Same visible value'); gate.resolve();
  assert.equal(await closing, false); assert.equal(h.controller.isCurrent(token), false); assert.equal(h.puts().length, 1);
  assert.equal(await h.controller.flushForClose(), true, 'A new explicit close may recognize the exact confirmed value');
});

test('editing while close awaits an old PUT does not start a hidden next submission', async t => {
  const gate = deferred(), h = harness(t, { hooks: { put: async input => { await gate.promise; const next = ack(input); h.replace(next); return next; } } });
  await h.controller.load(); h.controller.edit('name', 'Old raw'); const writing = h.controller.flush();
  h.controller.edit('name', 'Close raw'); const closing = h.controller.flushForClose(); h.controller.edit('name', 'Still editing');
  gate.resolve(); await writing; assert.equal(await closing, false); assert.equal(h.puts().length, 1);
  assert.equal(h.controller.getState().raw.name, 'Still editing'); assert.equal(h.controller.hasUnpersisted(), true);
});

for (const [code, status, kind] of [['LOCAL_DRAFT_CAPACITY', 507, 'refused'], ['LOCAL_DRAFT_CONFLICT', 409, 'conflict'],
  ['LOCAL_DRAFT_STALE_INSTANCE', 409, 'conflict'], ['LOCAL_DRAFT_SAVE_UNCERTAIN', 503, 'unknown']]) {
  test(`${code} returns close false and preserves raw/CAS without automatic retry`, async t => {
    const failure = new ClipDraftRequestError('Opaque refusal or uncertain response', code, status);
    const h = harness(t, { hooks: { put: async () => { throw failure; } } });
    await h.controller.load(); h.controller.edit('name', 'Never discard'); const before = structuredClone(h.controller.getState().raw);
    assert.equal(await h.controller.flushForClose(), false); assert.equal(h.controller.getState().failure.kind, kind);
    await h.controller.load(); h.controller.setContext({ ...h.ctx, connected: false }); h.controller.setContext(h.ctx);
    t.mock.timers.tick(1000); await turn(); assert.equal(await h.controller.flushForClose(), false); await h.controller.flush();
    assert.deepEqual(h.controller.getState().raw, before); assert.equal(h.controller.hasUnpersisted(), true);
    assert.deepEqual(h.puts().map(input => input.expectedRevision), [0]); assert.equal(h.controller.getState().autosavePaused, true);
  });
}

for (const altered of ['raw', 'baseRevision', 'source', 'instanceId', 'workspaceScope', 'revision', 'key']) {
  test(`close rejects a PUT acknowledgement with different ${altered}`, async t => {
    const h = harness(t, { hooks: { put: async input => {
      const next = ack(input);
      if (altered === 'raw') next.draft.raw.name = 'Wrong ACK';
      if (altered === 'baseRevision') next.draft.baseRevision++;
      if (altered === 'source') next.draft.source.versionId = id(99);
      if (altered === 'instanceId') next.instanceId = id(99);
      if (altered === 'workspaceScope') next.workspaceScope = 'f'.repeat(64);
      if (altered === 'revision') next.revision++;
      if (altered === 'key') next.key = { ...key, clipId: id(99) };
      return next;
    } } });
    await h.controller.load(); h.controller.edit('name', 'Exact input'); assert.equal(await h.controller.flushForClose(), false);
    assert.equal(h.controller.getState().raw.name, 'Exact input'); assert.equal(h.controller.hasUnpersisted(), true);
    assert.equal(await h.controller.flushForClose(), false); assert.equal(h.puts().length, 1);
  });
}

test('a reread with a new service instance never grants close confirmation for the old draft', async t => {
  const h = harness(t); await h.controller.load(); h.controller.edit('name', 'Stored under old authority'); await h.controller.flush();
  h.replace({ ...h.current(), instanceId: id(99) }); await h.controller.load();
  assert.equal(h.controller.hasUnpersisted(), true); assert.equal(await h.controller.flushForClose(), false);
  assert.equal(h.puts().length, 1); assert.equal(h.controller.getState().raw.name, 'Stored under old authority');
});

test('an explicit in-flight reread cannot reuse an old saved acknowledgement to release close', async t => {
  const reading = deferred(); let reads = 0;
  const h = harness(t, { hooks: { get: (_input, saved) => ++reads === 1 ? saved : reading.promise } });
  await h.controller.load(); h.controller.edit('name', 'Stored before reread'); await h.controller.flush();
  const loading = h.controller.load(); assert.equal(h.controller.hasUnpersisted(), true);
  assert.equal(await h.controller.flushForClose(), false); assert.equal(h.controller.getState().phase, 'loading');
  assert.equal(h.puts().length, 1); reading.resolve({ ...h.current(), instanceId: id(99) }); await loading;
  assert.equal(await h.controller.flushForClose(), false); assert.equal(h.controller.hasUnpersisted(), true);
});

test('an in-flight DELETE cannot satisfy close even for an untouched recovery candidate', async t => {
  const gate = deferred(), h = harness(t, { draft: record(), hooks: { remove: async (input, saved) => { await gate.promise;
    const next = { ...saved, revision: input.expectedRevision + 1, draft: null }; h.replace(next); return next; } } });
  await h.controller.load(); const deleting = h.controller.discardStored();
  assert.equal(h.controller.hasUnpersisted(), true); assert.equal(await h.controller.flushForClose(), false);
  gate.resolve(); assert.equal(await deleting, true); assert.equal(h.controller.hasUnpersisted(), false);
  assert.equal(await h.controller.flushForClose(), true); assert.equal(h.puts().length, 0);
});

test('scope replacement fences an old close ACK and never marks its new owner persisted', async t => {
  const gate = deferred(), h = harness(t, { hooks: { put: async input => { await gate.promise; return ack(input); } } });
  await h.controller.load(); h.controller.edit('name', 'Old owner'); const closing = h.controller.flushForClose(), token = h.controller.capture();
  h.controller.setContext({ ...h.ctx, scope: 'project:1:inspector:2' }); const changeCount = h.changes.length;
  gate.resolve(); assert.equal(await closing, false); assert.equal(h.controller.isCurrent(token), false);
  assert.equal(h.changes.length, changeCount); assert.equal(h.controller.getState().raw.name, 'Old owner');
  assert.equal(h.controller.getState().phase, 'saving'); assert.equal(await h.controller.flushForClose(), false);
});

test('abandonment cannot let an old close release a later owner', async t => {
  const gate = deferred(), h = harness(t, { hooks: { put: async input => { await gate.promise; return ack(input); } } });
  await h.controller.load(); h.controller.edit('name', 'Old unresolved raw'); const closing = h.controller.flushForClose();
  assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), true); h.controller.edit('name', 'New owner input');
  const current = h.controller.capture(); gate.resolve(); assert.equal(await closing, false);
  assert.equal(h.controller.isCurrent(current), true); assert.equal(h.controller.getState().raw.name, 'New owner input');
  assert.equal(h.controller.hasUnpersisted(), true); assert.equal(await h.controller.flushForClose(), false); assert.equal(h.puts().length, 1);
});

test('explicitly abandoned clean input may leave while retaining historical unknown evidence', async t => {
  const h = harness(t, { hooks: { put: async () => { throw new ClipDraftRequestError('Lost write response'); } } });
  await h.controller.load(); h.controller.edit('name', 'Abandon only when explicitly chosen'); assert.equal(await h.controller.flushForClose(), false);
  assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), true);
  assert.equal(h.controller.getState().failure.kind, 'unknown'); assert.equal(h.controller.getState().retainedRecord, true);
  assert.equal(h.controller.hasUnpersisted(), false); assert.equal(await h.controller.flushForClose(), true);
  assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put']);
});

test('disposing then activating the same object cannot reuse a previous close acknowledgement', async t => {
  const gate = deferred(); let count = 0;
  const h = harness(t, { hooks: { put: async input => { if (++count === 1) await gate.promise; const next = ack(input); h.replace(next); return next; } } });
  await h.controller.load(); h.controller.edit('name', 'Old mount'); const oldClose = h.controller.flushForClose();
  h.controller.dispose(); h.controller.activate(); h.controller.edit('name', 'New mount'); await h.controller.load();
  const current = h.controller.capture(); gate.resolve(); assert.equal(await oldClose, false);
  assert.equal(h.controller.isCurrent(current), true); assert.equal(h.controller.getState().raw.name, 'New mount');
  assert.equal(h.controller.hasUnpersisted(), true); assert.equal(h.controller.getState().phase, 'ready');
});
