import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClipDraftController, clipDraftPatch, clipDraftRaw, clipDraftSource } from '../apps/web/src/clip-draft-state.ts';
import { isTimelineRecord } from '../packages/contracts/src/timeline-replacement.mjs';
import { createClipDraftClient } from '../apps/web/src/clip-draft-client.ts';
import { transformSync } from 'esbuild';

const id = n => `d1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-12T16:00:00.000Z';
const projectId = id(1), timelineId = id(2), clipId = id(3), trackId = id(4), assetId = id(5);
const source = { assetId, assetSha256: 'b'.repeat(64) };
const raw = { name: 'Saved clip', trackId, startFrame: 0, durationFrames: 120, sourceInFrame: 0, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 };
const key = { projectId, timelineId, clipId };
const context = () => ({ ...key, scope: 'project:1:inspector:1', restored: false, connected: true, visible: true, busy: false, timelineRevision: 7, source: structuredClone(source), saved: structuredClone(raw) });
const record = (patch = {}) => ({ baseRevision: 7, source: structuredClone(source), raw: { ...structuredClone(raw), name: 'Recovered draft' }, updatedAt: stamp, ...patch });
const row = (draft = null) => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(6), key, revision: draft ? 1 : 0, targetStatus: 'matching', draft });
const timeline = (patch = {}, revision = 8) => ({ id: timelineId, projectId, revision, fps: 30, width: 720, height: 1280, durationFrames: Number(patch.startFrame ?? raw.startFrame) + Number(patch.durationFrames ?? raw.durationFrames),
  tracks: [{ id: trackId, name: 'Video 1', kind: 'video', orderIndex: 0, hidden: false, muted: false }],
  clips: [{ id: clipId, assetId, ...structuredClone(raw), ...patch }], createdAt: stamp, updatedAt: stamp });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const pastDebounce = () => new Promise(resolve => setTimeout(resolve, 20));
const writeInput = () => ({ ...key, workspaceScope: 'a'.repeat(64), instanceId: id(6), expectedRevision: 0, baseRevision: 7, source, raw });
async function clientWriteFailure(fetcher) {
  let failure;
  try { await createClipDraftClient(fetcher).put(writeInput()); } catch (error) { failure = error; }
  assert.ok(failure, 'The actual client must reject the synthetic failed write');
  return failure;
}
const httpFailure = (code, status, message = 'Opaque service response') => clientWriteFailure(async () => new Response(JSON.stringify({ ok: false, error: { code, message, details: {}, retryable: false } }), { status }));
const treeNodes = tree => Array.isArray(tree) ? tree.flatMap(treeNodes) : tree && typeof tree === 'object' ? [tree, ...treeNodes(tree.props?.children)] : [];
function recoveryView(state, controller, confirm, pending = false, refs = []) {
  const file = readFileSync(new URL('../apps/web/src/ClipDraftRecovery.tsx', import.meta.url), 'utf8');
  let cursor = 0;
  const disclosure = { exports: {} };
  const react = { createElement: (type, props, ...children) => type === disclosure.exports.default ? type({ ...props, children }) : ({ type, props: { ...props, children } }), useRef: initial => refs[cursor++] ||= { current: initial } }; react.default = react;
  Function('require', 'module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/RecoveryStorageDetails.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)(name => {
    assert.equal(name, 'react'); return react;
  }, disclosure, disclosure.exports);
  const module = { exports: {} };
  Function('require', 'module', 'exports', transformSync(file, { loader: 'tsx', format: 'cjs' }).code)(name => {
    if (name === 'react') return react;
    if (name === './RecoveryStorageDetails.tsx') return disclosure.exports;
    if (name === '@mioon/ui/components/button') return { Button: 'Button' };
    if (name === '@mioon/ui/components/workbench-confirm') return { useConfirmation: () => confirm };
    throw Error(`Unexpected recovery component dependency: ${name}`);
  }, module, module.exports);
  return module.exports.default({ state, controller, pending });
}
function harness(t, { draft = null, ctx = context(), hooks = {}, delay = 100000 } = {}) {
  let saved = row(draft);
  const calls = [], changes = [];
  const client = {
    async get(input) { calls.push(['get', structuredClone(input)]); return hooks.get ? hooks.get(input, structuredClone(saved)) : structuredClone(saved); },
    async put(input) {
      calls.push(['put', structuredClone(input)]);
      if (hooks.put) return hooks.put(input, structuredClone(saved));
      assert.equal(input.workspaceScope, saved.workspaceScope); assert.equal(input.instanceId, saved.instanceId);
      if (input.expectedRevision !== saved.revision) throw Error('DRAFT_CONFLICT');
      saved = { ...saved, revision: saved.revision + 1, draft: { baseRevision: input.baseRevision, source: structuredClone(input.source), raw: structuredClone(input.raw), updatedAt: stamp } };
      return structuredClone(saved);
    },
    async remove(input) {
      calls.push(['delete', structuredClone(input)]);
      if (hooks.remove) return hooks.remove(input, structuredClone(saved));
      if (input.expectedRevision !== saved.revision) throw Error('DRAFT_CONFLICT');
      saved = { ...saved, revision: saved.revision + 1, draft: null }; return structuredClone(saved);
    },
  };
  const controller = createClipDraftController({ context: ctx, client, validateTimeline: (value, projectId) => isTimelineRecord(value, { projectId }), delay, onChange: value => changes.push(value) });
  t.after(() => controller.dispose());
  return { controller, calls, changes, current: () => structuredClone(saved), replace: next => { saved = structuredClone(next); }, ctx };
}

test('whole raw form round-trips incomplete numeric strings and fade omission without business execution', async t => {
  const h = harness(t); await h.controller.load();
  h.controller.edit('startFrame', ''); h.controller.edit('sourceInFrame', '001'); h.controller.edit('gain', '0.50');
  h.controller.edit('rect', { x: '', y: '0', width: '720', height: '1280' });
  await h.controller.flush();
  const stored = h.current().draft;
  assert.equal(stored.raw.startFrame, ''); assert.equal(stored.raw.sourceInFrame, '001'); assert.equal(stored.raw.gain, '0.50'); assert.equal(stored.raw.rect.x, '');
  assert.equal(Object.hasOwn(stored.raw, 'fadeInFrames'), false); assert.equal(Object.hasOwn(stored.raw, 'fadeOutFrames'), false);
  assert.equal(h.controller.getState().dirty, true); assert.equal(h.controller.getState().phase, 'saved');
  assert.deepEqual(h.calls.map(x => x[0]), ['get', 'put']);
  const restored = harness(t, { draft: stored }); await restored.controller.load();
  assert.equal(restored.controller.getState().raw.startFrame, 0, 'GET never hydrates the form');
  assert.equal(restored.controller.restore(), true); assert.deepEqual(restored.controller.getState().raw, stored.raw);
  assert.deepEqual(restored.calls.map(x => x[0]), ['get']);
});

test('invalid raw numbers and missing name never become valid zero-valued business patches', () => {
  for (const [field, value] of [['startFrame', ''], ['sourceInFrame', '  '], ['sourceInFrame', '0x10'], ['gain', ''], ['durationFrames', '1.5'], ['fadeInFrames', '-1'], ['name', '']]) assert.equal(clipDraftPatch({ ...raw, [field]: value }), null, field);
  assert.equal(clipDraftPatch({ ...raw, rect: { ...raw.rect, x: '' } }), null);
  assert.ok(clipDraftPatch({ ...raw, name: 'n'.repeat(200) }));
  assert.equal(Object.hasOwn(clipDraftPatch(raw), 'fadeInFrames'), false);
  assert.equal(clipDraftPatch({ ...raw, fadeInFrames: '0' }).fadeInFrames, 0);
  assert.deepEqual(clipDraftRaw({ id: clipId, assetId, ...raw }), raw);
  assert.deepEqual(clipDraftSource({ assetId, versionId: id(9) }, { sha256: source.assetSha256 }), { ...source, versionId: id(9) });
});

test('a delayed GET preserves newer typed input and requires explicit old-draft handling', async t => {
  const gate = deferred(), h = harness(t, { hooks: { get: () => gate.promise } });
  const loading = h.controller.load(); h.controller.edit('name', 'Typed during GET'); h.replace(row(record())); gate.resolve(row(record())); await loading;
  assert.equal(h.controller.getState().raw.name, 'Typed during GET'); assert.equal(h.controller.restore(), false);
  await h.controller.flush(); assert.deepEqual(h.calls.map(x => x[0]), ['get']);
  assert.equal(await h.controller.discardStored(), true); await h.controller.flush();
  assert.equal(h.current().draft.raw.name, 'Typed during GET');
});

test('restoration freezes base revision and complete source, including unrelated timeline updates', async t => {
  const h = harness(t, { draft: record() }); await h.controller.load(); h.controller.restore();
  h.controller.setContext({ ...h.ctx, timelineRevision: 8 });
  assert.equal(h.controller.getState().baseRevision, 7); assert.equal(h.controller.getState().conflict, true);
  let saves = 0; await h.controller.save(async () => { saves++; return null; }); assert.equal(saves, 0);
  const g = harness(t); await g.controller.load(); g.controller.edit('name', 'Old source draft');
  g.controller.setContext({ ...g.ctx, source: { ...source, assetId: id(99) } });
  assert.equal(g.controller.getState().conflict, true); assert.deepEqual(g.controller.getState().source, source);
  const stale = harness(t, { draft: record({ baseRevision: 6 }) }); await stale.controller.load(); stale.controller.restore();
  assert.equal(stale.controller.getState().conflict, true); assert.equal(stale.controller.getState().baseRevision, 6);
});

test('only a complete matching fresh applied business ACK clears the exact persisted draft', async t => {
  const h = harness(t); await h.controller.load(); h.controller.edit('name', 'Business saved'); await h.controller.flush();
  const result = await h.controller.save(async (target, patch, base) => { assert.equal(target, clipId); assert.equal(base, 7); return timeline(patch); });
  assert.equal(result.revision, 8); assert.equal(h.current().draft, null); assert.equal(h.controller.getState().dirty, false);
  assert.equal(h.controller.getState().baseRevision, 8); assert.equal(h.calls.filter(x => x[0] === 'delete')[0][1].expectedRevision, 1);
  for (const wrong of [value => ({ ...value, projectId: id(90) }), value => ({ ...value, revision: 9 }), value => ({ ...value, clips: [] }), value => ({ ...value, tracks: [] }), value => ({ ...value, clips: value.clips.map(clip => ({ ...clip, assetId: id(91) })) })]) {
    const g = harness(t); await g.controller.load(); g.controller.edit('name', 'Keep');
    await g.controller.save(async (_id, patch) => wrong(timeline(patch)));
    assert.equal(g.controller.getState().dirty, true); assert.equal(g.calls.some(x => x[0] === 'delete'), false);
  }
});

test('newer input typed while business save awaits survives and is never rebased or cleared', async t => {
  const gate = deferred(), h = harness(t); await h.controller.load(); h.controller.edit('name', 'Submitted');
  let submitted; const saving = h.controller.save(async (_id, patch) => { submitted = patch; return gate.promise; }); await tick();
  h.controller.edit('name', 'Newer input'); gate.resolve(timeline(submitted)); await saving;
  assert.equal(h.controller.getState().raw.name, 'Newer input'); assert.equal(h.controller.getState().baseRevision, 7); assert.equal(h.controller.getState().conflict, true);
  await h.controller.flush(); assert.equal(h.current().draft.raw.name, 'Newer input'); assert.equal(h.calls.some(x => x[0] === 'delete'), false);
});

test('an older applied ACK never regresses an observed newer timeline or clears its draft', async t => {
  const gate = deferred(), h = harness(t); await h.controller.load(); h.controller.edit('name', 'Submitted');
  let patch; const saving = h.controller.save(async (_id, value) => { patch = value; return gate.promise; }); await tick();
  h.controller.setContext({ ...h.ctx, timelineRevision: 9, saved: { ...raw, name: 'Someone newer' } }); gate.resolve(timeline(patch)); await saving;
  assert.equal(h.controller.getState().raw.name, 'Submitted'); assert.equal(h.controller.getState().baseRevision, 7); assert.equal(h.controller.getState().conflict, true);
  assert.equal(h.calls.some(x => x[0] === 'delete'), false);
});

test('unknown business outcome and unmounted owner preserve draft without automatic replay', async t => {
  const h = harness(t); await h.controller.load(); h.controller.edit('name', 'Uncertain');
  await h.controller.save(async () => null); assert.equal(h.controller.getState().dirty, true); assert.ok(h.current().draft);
  const gate = deferred(), g = harness(t); await g.controller.load(); g.controller.edit('name', 'Unmounted');
  let patch; const saving = g.controller.save(async (_id, value) => { patch = value; return gate.promise; }); await tick();
  g.controller.dispose(); gate.resolve(timeline(patch)); await saving; assert.equal(g.calls.some(x => x[0] === 'delete'), false);
});

test('multiwindow write conflict fails closed and reread never silently overwrites foreign raw', async t => {
  const h = harness(t); await h.controller.load(); h.controller.edit('name', 'This window');
  h.replace({ ...row(record({ raw: { ...raw, name: 'Other window' } })), revision: 2 });
  await h.controller.flush(); assert.equal(h.controller.getState().phase, 'error');
  const writes = h.calls.length; await h.controller.flush(); assert.equal(h.calls.length, writes);
  await h.controller.load(); assert.equal(h.controller.getState().raw.name, 'This window'); assert.equal(h.controller.getState().candidate.raw.name, 'Other window');
  await h.controller.flush(); assert.equal(h.current().draft.raw.name, 'Other window');
});

test('delayed local PUT coalesces newer input only after the first exact CAS is accepted', async t => {
  const gate = deferred(); let count = 0;
  const h = harness(t, { hooks: { put: async input => { count++; const next = { ...row(), revision: input.expectedRevision + 1, draft: record({ baseRevision: input.baseRevision, source: input.source, raw: input.raw }) }; if (count === 1) { await gate.promise; h.replace(next); return next; } h.replace(next); return next; } } });
  await h.controller.load(); h.controller.edit('name', 'First'); const writing = h.controller.flush(); await tick(); h.controller.edit('name', 'Latest'); gate.resolve(); await writing; await h.controller.flush();
  assert.equal(h.current().draft.raw.name, 'Latest'); assert.deepEqual(h.calls.filter(x => x[0] === 'put').map(x => x[1].expectedRevision), [0, 1]);
});

test('explicit discard checks captured serial and never removes another window’s newer draft', async t => {
  const h = harness(t); await h.controller.load(); h.controller.edit('name', 'First'); await h.controller.flush();
  const captured = h.controller.capture(); h.controller.edit('name', 'Changed during confirmation');
  assert.equal(h.controller.isCurrent(captured), false); assert.equal(await h.controller.discard(captured), false); assert.equal(h.calls.some(x => x[0] === 'delete'), false);
  await h.controller.flush(); h.replace({ ...h.current(), revision: 3, draft: record({ raw: { ...raw, name: 'Other window' } }) });
  assert.equal(await h.controller.discard(h.controller.capture()), false); assert.equal(h.current().draft.raw.name, 'Other window'); assert.equal(h.controller.getState().dirty, true);
});

test('typing during explicit stored-draft deletion preserves input and does not leave a phantom recovery candidate', async t => {
  const gate = deferred(), h = harness(t, { draft: record(), hooks: { remove: async (input, saved) => { await gate.promise; const next = { ...saved, revision: input.expectedRevision + 1, draft: null }; h.replace(next); return next; } } });
  await h.controller.load(); const deleting = h.controller.discardStored(); await tick(); h.controller.edit('name', 'Typed during delete'); gate.resolve(); assert.equal(await deleting, true);
  assert.equal(h.controller.getState().candidate, null); assert.equal(h.controller.getState().raw.name, 'Typed during delete'); await h.controller.flush(); assert.equal(h.current().draft.raw.name, 'Typed during delete');
});

test('backend identity changes require explicit page reload, never silently adopting a new authority', async t => {
  const h = harness(t); await h.controller.load(); h.controller.edit('name', 'Retain'); await h.controller.flush();
  h.replace({ ...h.current(), instanceId: id(77) }); await h.controller.load();
  assert.equal(h.controller.getState().phase, 'error'); assert.match(h.controller.getState().error, /实例/); assert.equal(h.controller.getState().raw.name, 'Retain');
  const writes = h.calls.filter(x => x[0] === 'put').length; await h.controller.flush(); assert.equal(h.calls.filter(x => x[0] === 'put').length, writes);
});

test('restored branch retains ordinary in-memory editing and discard without local draft I/O', async t => {
  const h = harness(t, { ctx: { ...context(), restored: true } }); await h.controller.load(); h.controller.edit('name', 'Restored local input');
  assert.equal(await h.controller.discard(h.controller.capture()), true); assert.equal(h.controller.getState().raw.name, raw.name); assert.equal(h.controller.getState().phase, 'unsupported'); assert.deepEqual(h.calls, []);
  h.controller.edit('name', 'Explicit business save'); await h.controller.save(async (_id, patch) => timeline(patch)); assert.equal(h.controller.getState().dirty, false); assert.deepEqual(h.calls, []);
});

test('lost autosave ACK followed by applied business ACK cannot falsely mark the sidecar cleared', async t => {
  const h = harness(t, { hooks: { put: async input => { h.replace({ ...row(), revision: 1, draft: record({ raw: input.raw }) }); throw Error('Response lost'); } } });
  await h.controller.load(); h.controller.edit('name', 'Accepted by business'); await h.controller.save(async (_id, patch) => timeline(patch));
  assert.equal(h.controller.getState().dirty, true); assert.equal(h.controller.getState().conflict, true); assert.equal(h.controller.getState().phase, 'error'); assert.match(h.controller.getState().error, /本地草稿状态尚未确认/); assert.ok(h.current().draft); assert.equal(h.calls.some(x => x[0] === 'delete'), false);
});

test('busy lane and hidden view never dispatch a business save and recovery never does so', async t => {
  const h = harness(t, { draft: record() }); await h.controller.load(); h.controller.restore(); let calls = 0;
  h.controller.setContext({ ...h.ctx, busy: true }); await h.controller.save(async () => { calls++; return null; });
  h.controller.setContext({ ...h.ctx, visible: false }); await h.controller.save(async () => { calls++; return null; }); assert.equal(h.controller.edit('name', 'Hidden'), false);
  assert.equal(calls, 0); assert.deepEqual(h.calls.map(x => x[0]), ['get']);
});

test('HTTP adapter uses same-origin sidecar only and rejects malformed/unsupported write acknowledgments', async () => {
  const calls = [], client = createClipDraftClient(async (url, options) => { calls.push([url, options]); return new Response(JSON.stringify({ ok: true, data: row() }), { status: 200 }); });
  assert.deepEqual(await client.get(key), row()); assert.match(calls[0][0], /^\/api\/local-drafts\/clip\?/); assert.equal(calls[0][1].credentials, 'same-origin');
  for (const data of [{ ...row(), revision: '1' }, { ...row(), draft: record({ raw: { ...raw, injected: true } }) }]) {
    const invalid = createClipDraftClient(async () => new Response(JSON.stringify({ ok: true, data }), { status: 200 })); await assert.rejects(invalid.get(key));
  }
  const unsupported = createClipDraftClient(async () => new Response(JSON.stringify({ ok: true, data: { supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED' } }), { status: 200 }));
  assert.equal((await unsupported.get(key)).supported, false); await assert.rejects(unsupported.put({ ...key, workspaceScope: 'a'.repeat(64), instanceId: id(6), expectedRevision: 0, baseRevision: 7, source, raw }));
});

test('recovery is embedded in the existing right inspector with explicit restore and local plaintext warning', () => {
  const inspector = readFileSync(new URL('../apps/web/src/TimelineInspector.jsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../apps/web/src/ClipDraftRecovery.tsx', import.meta.url), 'utf8');
  assert.match(inspector, /<ClipDraftRecovery state=\{state\}/); assert.match(view, /仅片段属性，本地明文；最后未确认输入可能丢失/);
  assert.match(view, /恢复到属性表单/); assert.doesNotMatch(view, /mutateTimeline|edit_tasks|role="dialog"/);
  assert.doesNotMatch(inspector, /setBaseRevision|same\(latest, baseline/);
  assert.match(inspector, /data-testid="remove-clip" disabled=\{busy \|\| dirty \|\| state.submitting \|\| Boolean\(state.candidate\)\}/);
  assert.match(inspector, /先保存或放弃片段草稿，再移除此片段/);
});

test('a delayed reread cannot resurrect a candidate after its exact DELETE is confirmed', async t => {
  const gate = deferred(); let reads = 0;
  const h = harness(t, { draft: record(), hooks: { get: (_key, current) => ++reads === 1 ? current : gate.promise } });
  await h.controller.load(); const old = h.current(), loading = h.controller.load(); await tick();
  assert.equal(await h.controller.discardStored(), true); gate.resolve(old); await loading;
  assert.equal(h.controller.getState().candidate, null); assert.equal(h.current().draft, null);
  h.controller.edit('name', 'After deletion'); await h.controller.flush(); assert.equal(h.calls.at(-1)[1].expectedRevision, 2);
});

test('offline input automatically schedules a local write after a safe reconnect', async t => {
  const h = harness(t, { ctx: { ...context(), connected: false }, delay: 0 }); await h.controller.load();
  h.controller.edit('name', 'Offline input'); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(h.calls.some(x => x[0] === 'put'), false);
  h.controller.setContext({ ...h.ctx, connected: true }); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.current().draft.raw.name, 'Offline input');
});

test('repeated Save while the local flush awaits cannot dispatch duplicate business edits', async t => {
  const gate = deferred(); const h = harness(t, { hooks: { put: async input => { await gate.promise; return { ...row(), revision: 1, draft: record({ raw: input.raw }) }; } } });
  await h.controller.load(); h.controller.edit('name', 'Single save'); let calls = 0;
  const save = async (_id, patch) => { calls++; return timeline(patch); };
  const first = h.controller.save(save); await tick(); assert.equal(await h.controller.save(save), null); gate.resolve(); await first;
  assert.equal(calls, 1);
});

test('late durable preparation cannot execute after view, owner, source or base changes; its own busy state is allowed', async t => {
  for (const update of [ctx => ({ ...ctx, visible: false }), ctx => ({ ...ctx, connected: false }), ctx => ({ ...ctx, scope: 'new owner' }), ctx => ({ ...ctx, timelineRevision: 8 }), ctx => ({ ...ctx, source: { ...source, assetId: id(77) } }), ctx => ({ ...ctx, busy: true })]) {
    const gate = deferred(), h = harness(t); await h.controller.load(); h.controller.edit('name', 'Prepared input'); let executes = 0;
    const saving = h.controller.save(async (_id, patch, _base, { canExecute }) => { await gate.promise; if (!canExecute()) return null; executes++; return timeline(patch); });
    await tick(); const next = update(h.ctx); h.controller.setContext(next); gate.resolve(); await saving;
    assert.equal(executes, next.busy ? 1 : 0);
    if (!next.busy) assert.equal(h.calls.some(x => x[0] === 'delete'), false);
  }
});

for (const [code, status, kind] of [
  ['LOCAL_DRAFT_CAPACITY', 507, 'refused'], ['LOCAL_DRAFT_LIMIT', 413, 'refused'],
  ['LOCAL_DRAFT_CONFLICT', 409, 'conflict'], ['LOCAL_DRAFT_STALE_INSTANCE', 409, 'conflict'],
  ['LOCAL_DRAFT_SAVE_UNCERTAIN', 503, 'unknown'], ['UNRECOGNIZED_FUTURE_CODE', 409, 'unknown'],
]) {
  test(`actual HTTP client preserves structured ${code}/${status} without interpreting message text`, async () => {
    const error = await httpFailure(code, status, 'LOCAL_DRAFT_CAPACITY: definitely safe to retry');
    assert.equal(error.code, code); assert.equal(error.status, status); assert.equal(error.kind, kind);
    assert.match(error.message, /definitely safe to retry/);
  });
}

test('actual HTTP client treats code/status mismatches, malformed 2xx and network loss as unknown outcomes', async () => {
  const mismatch = await httpFailure('LOCAL_DRAFT_CAPACITY', 503, 'Capacity exceeded');
  assert.equal(mismatch.code, 'LOCAL_DRAFT_CAPACITY'); assert.equal(mismatch.status, 503); assert.equal(mismatch.kind, 'unknown');
  for (const body of ['not json', JSON.stringify({ ok: true, data: { ...row(), revision: 'wrong' } }), JSON.stringify({ ok: 'true', data: row() })]) {
    const error = await clientWriteFailure(async () => new Response(body, { status: 200 }));
    assert.equal(error.kind, 'unknown'); assert.equal(error.status, 200);
  }
  const network = await clientWriteFailure(async () => { throw Error('LOCAL_DRAFT_CAPACITY: refused without writing'); });
  assert.equal(network.kind, 'unknown'); assert.equal(network.status, null);
});

test('actual HTTP client refuses to treat malformed error envelopes as proof of a known refusal', async () => {
  const error = { code: 'LOCAL_DRAFT_CAPACITY', message: 'Capacity refusal', details: {}, retryable: false };
  for (const broken of [
    { code: error.code, message: error.message },
    { ...error, details: 'not an object' },
    { ...error, retryable: 'false' },
    { ...error, injected: true },
  ]) {
    const failure = await clientWriteFailure(async () => new Response(JSON.stringify({ ok: false, error: broken }), { status: 507 }));
    assert.equal(failure.kind, 'unknown'); assert.equal(failure.status, 507);
  }
});

test('capacity refusal pauses autosave through debounce, read-only GET null, typing and reconnect, then permits a local-only exit', async t => {
  const failure = await httpFailure('LOCAL_DRAFT_CAPACITY', 507);
  const h = harness(t, { delay: 5, hooks: { put: async () => { throw failure; } } });
  await h.controller.load(); h.controller.edit('name', 'Capacity-blocked input'); await h.controller.flush();
  assert.equal(h.controller.getState().autosavePaused, true); assert.equal(h.controller.getState().failure.kind, 'refused');
  await pastDebounce(); assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put']);
  await h.controller.load(); assert.equal(h.current().draft, null);
  h.controller.edit('name', 'Newer blocked input');
  h.controller.setContext({ ...h.ctx, connected: false }); h.controller.setContext({ ...h.ctx, connected: true });
  await new Promise(resolve => setTimeout(resolve, 280)); await h.controller.flush();
  assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put', 'get'], 'GET and context refresh must not silently retry a refused write');
  const token = h.controller.capture(), before = structuredClone(h.calls);
  assert.equal(h.controller.canAbandon(token), true); assert.equal(h.controller.abandonCurrentInput(token), true);
  assert.deepEqual(h.controller.getState().raw, raw); assert.equal(h.controller.hasUnsaved(), false); assert.equal(h.controller.isCurrent(token), false);
  assert.equal(h.controller.getState().autosavePaused, true); assert.deepEqual(h.calls, before); assert.equal(h.current().draft, null);
});

test('unknown PUT followed by GET null never becomes a known refusal, and late server publication remains recoverable after local exit', async t => {
  const failure = await clientWriteFailure(async () => { throw Error('Socket closed after request upload'); });
  let sent;
  const h = harness(t, { delay: 5, hooks: { put: async input => { sent = structuredClone(input); throw failure; } } });
  await h.controller.load(); h.controller.edit('name', 'Possibly written input'); await h.controller.flush();
  assert.equal(h.controller.getState().failure.kind, 'unknown');
  await h.controller.load(); assert.equal(h.current().draft, null); await pastDebounce();
  assert.equal(h.controller.getState().failure.kind, 'unknown'); assert.equal(h.controller.getState().autosavePaused, true);
  const before = structuredClone(h.calls); assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), true);
  assert.deepEqual(h.calls, before); assert.equal(h.controller.getState().dirty, false); assert.equal(h.controller.getState().retainedRecord, true);
  const published = { ...row(), revision: 1, draft: record({ raw: sent.raw, source: sent.source, baseRevision: sent.baseRevision }) };
  h.replace(published); await h.controller.load(); await pastDebounce();
  assert.equal(h.controller.getState().raw.name, raw.name); assert.equal(h.controller.getState().dirty, false);
  assert.deepEqual(h.controller.getState().candidate, published.draft); assert.deepEqual(h.current(), published);
  assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put', 'get', 'get']);
});

for (const [code, status, kind] of [['LOCAL_DRAFT_CAPACITY', 507, 'refused'], ['LOCAL_DRAFT_CONFLICT', 409, 'conflict']]) {
  test(`a later verified GET ${kind} cannot erase an earlier unknown write outcome`, async t => {
    const unknownWrite = await clientWriteFailure(async () => { throw Error('Write response lost after upload'); });
    const readClient = createClipDraftClient(async (_url, options) => {
      assert.equal(options.method, 'GET');
      return new Response(JSON.stringify({ ok: false, error: { code, message: 'This later read was rejected', details: {}, retryable: false } }), { status });
    });
    let reads = 0, readFailure;
    const h = harness(t, { delay: 5, hooks: {
      put: async () => { throw unknownWrite; },
      get: async (input, saved) => {
        if (++reads === 1) return saved;
        try { return await readClient.get(input); } catch (error) { readFailure = error; throw error; }
      },
    } });
    await h.controller.load(); h.controller.edit('name', 'Keep the uncertain input'); h.controller.edit('gain', '0.50'); await h.controller.flush();
    const priorFailure = structuredClone(h.controller.getState().failure), priorRaw = structuredClone(h.controller.getState().raw);
    assert.equal(priorFailure.kind, 'unknown');
    await h.controller.load(); await pastDebounce(); await h.controller.flush();
    assert.equal(readFailure.code, code); assert.equal(readFailure.status, status); assert.equal(readFailure.kind, kind);
    assert.deepEqual(h.controller.getState().failure, priorFailure, 'A rejected read proves nothing about the earlier PUT');
    assert.deepEqual(h.controller.getState().raw, priorRaw); assert.equal(h.controller.getState().dirty, true);
    assert.equal(h.controller.getState().autosavePaused, true); assert.equal(h.controller.getState().baseRevision, 7);
    assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put', 'get']);
  });
}

for (const code of ['LOCAL_DRAFT_STALE_INSTANCE', 'LOCAL_DRAFT_CONFLICT']) {
  test(`${code} pauses new PUTs across reads, changed input and context without replacing either window's record`, async t => {
    const failure = await httpFailure(code, 409);
    const h = harness(t, { delay: 5, hooks: { put: async () => { throw failure; } } });
    await h.controller.load(); h.controller.edit('name', 'This window'); await h.controller.flush();
    const foreign = { ...row(record({ raw: { ...raw, name: 'Other window' } })), ...(code === 'LOCAL_DRAFT_STALE_INSTANCE' ? { instanceId: id(77) } : {}) };
    h.replace(foreign); await h.controller.load(); h.controller.edit('name', 'Still this window');
    h.controller.setContext({ ...h.ctx, timelineRevision: 8 }); await pastDebounce(); await h.controller.flush();
    assert.equal(h.controller.getState().autosavePaused, true); assert.equal(h.controller.getState().failure.kind, 'conflict');
    assert.equal(h.controller.getState().raw.name, 'Still this window'); assert.deepEqual(h.current(), foreign);
    assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put', 'get']);
    const before = structuredClone(h.calls); assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), true);
    assert.deepEqual(h.calls, before); assert.deepEqual(h.current(), foreign);
  });
}

test('an unresolved autosave may be abandoned locally, and its late PUT cannot resurrect the form or erase newer input', async t => {
  const gate = deferred(); let sent;
  const h = harness(t, { delay: 5, hooks: { put: async input => { sent = structuredClone(input); await gate.promise; const next = { ...row(), revision: 1, draft: record({ raw: input.raw }) }; h.replace(next); return next; } } });
  await h.controller.load(); h.controller.edit('name', 'Old unresolved input'); const writing = h.controller.flush(); await tick();
  const oldToken = h.controller.capture(); assert.equal(h.controller.canAbandon(oldToken), true);
  assert.equal(h.controller.abandonCurrentInput(oldToken), true); assert.equal(h.controller.isCurrent(oldToken), false);
  h.controller.edit('name', 'New local input'); await h.controller.load();
  const currentToken = h.controller.capture(); gate.resolve(); await writing; await pastDebounce();
  assert.equal(h.controller.isCurrent(currentToken), true); assert.equal(h.controller.getState().raw.name, 'New local input');
  assert.equal(h.controller.getState().dirty, true); assert.equal(h.controller.getState().autosavePaused, true);
  assert.equal(h.current().draft.raw.name, sent.raw.name); assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put', 'get']);
  const remounted = harness(t, { draft: h.current().draft }); await remounted.controller.load();
  assert.equal(remounted.controller.getState().raw.name, raw.name, 'A late stored draft is offered, never silently hydrated');
  assert.equal(remounted.controller.getState().candidate.raw.name, 'Old unresolved input');
});

test('abandoning a business Save waiting on an unresolved local PUT prevents every later business handoff', async t => {
  const gate = deferred();
  const h = harness(t, { hooks: { put: async input => { await gate.promise; const next = { ...row(), revision: 1, draft: record({ raw: input.raw }) }; h.replace(next); return next; } } });
  await h.controller.load(); h.controller.edit('name', 'Save blocked on local autosave'); let handoffs = 0;
  const saving = h.controller.save(async (_id, patch) => { handoffs++; return timeline(patch); }); await tick();
  assert.equal(h.controller.getState().submitting, true); assert.equal(handoffs, 0);
  const token = h.controller.capture(); assert.equal(h.controller.canAbandon(token), true);
  assert.equal(h.controller.abandonCurrentInput(token), true); assert.equal(h.controller.getState().submitting, false);
  gate.resolve(); await saving;
  assert.equal(handoffs, 0); assert.equal(h.controller.getState().raw.name, raw.name); assert.equal(h.controller.getState().dirty, false);
  assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put']); assert.ok(h.current().draft, 'Local-only exit never deletes the late-published record');
});

test('abandonment is fenced after actual business handoff and while the durable lane is pending', async t => {
  const h = harness(t), gate = deferred(); await h.controller.load(); h.controller.edit('name', 'Durable original');
  const durable = Object.freeze({ requestId: 'fixed-durable-request', expectedRevision: 7, clipId, patch: Object.freeze({ name: 'Durable original' }) });
  let submitted;
  const saving = h.controller.save(async (_id, patch) => { submitted = patch; return gate.promise; }); await tick();
  assert.equal(submitted.name, 'Durable original');
  assert.equal(h.controller.canAbandon(h.controller.capture()), false); assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), false);
  gate.resolve(null); await saving; h.controller.setContext({ ...h.ctx, busy: true });
  assert.equal(h.controller.canAbandon(h.controller.capture()), false); assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), false);
  assert.equal(h.controller.getState().raw.name, 'Durable original'); assert.equal(durable.requestId, 'fixed-durable-request');
  assert.deepEqual(durable.patch, { name: 'Durable original' }); assert.equal(h.calls.some(([method]) => method === 'delete'), false);
});

test('explicit local-only exit preserves an existing stored draft and its original restore base and source', async t => {
  const stored = record({ baseRevision: 6 }), h = harness(t, { draft: stored }); await h.controller.load();
  h.controller.edit('name', 'Unsent current input'); const before = h.current(), calls = structuredClone(h.calls);
  assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), true);
  assert.deepEqual(h.current(), before); assert.deepEqual(h.calls, calls); assert.equal(h.controller.getState().retainedRecord, true);
  await h.controller.load(); assert.equal(h.controller.restore(), true);
  assert.deepEqual(h.controller.getState().raw, stored.raw); assert.equal(h.controller.getState().baseRevision, 6);
  assert.deepEqual(h.controller.getState().source, stored.source); assert.equal(h.controller.getState().conflict, true);
  assert.equal(h.calls.some(([method]) => method === 'delete'), false);
});

test('a captured local-only exit cannot discard text changed back to the same value or a revisited owner', async t => {
  const h = harness(t); await h.controller.load(); h.controller.edit('name', 'Original input');
  const captured = h.controller.capture();
  assert.equal(captured.projectId, projectId); assert.equal(captured.timelineId, timelineId); assert.equal(captured.clipId, clipId);
  h.controller.edit('name', 'New input'); h.controller.edit('name', 'Original input');
  assert.equal(h.controller.canAbandon(captured), false); assert.equal(h.controller.abandonCurrentInput(captured), false);
  assert.equal(h.controller.getState().raw.name, 'Original input');
  const owner = h.controller.capture(); h.controller.setContext({ ...h.ctx, scope: 'project:2:inspector:1' });
  assert.equal(h.controller.abandonCurrentInput(owner), false); assert.equal(h.controller.getState().dirty, true);
});

for (const outcome of ['cancel', 'confirm', 'new input', 'changed back', 'pending business', 'pending prop']) {
  test(`actual recovery confirmation preserves exact local-input ownership: ${outcome}`, async t => {
    const failure = await httpFailure('LOCAL_DRAFT_CAPACITY', 507), confirmation = deferred(), prompts = [];
    const h = harness(t, { hooks: { put: async () => { throw failure; } } });
    await h.controller.load(); h.controller.edit('name', 'Input at confirmation'); await h.controller.flush();
    const refs = [], confirm = message => { prompts.push(message); return confirmation.promise; };
    const tree = recoveryView(h.controller.getState(), h.controller, confirm, false, refs);
    const abandon = treeNodes(tree).find(node => node.props?.['data-testid'] === 'abandon-current-clip-input');
    assert.ok(abandon, 'The actual Inspector recovery UI exposes an explicit local-only exit');
    assert.equal(Boolean(abandon.props.disabled), false);
    const calls = structuredClone(h.calls), clicking = abandon.props.onClick();
    assert.equal(prompts.length, 1); assert.match(prompts[0], /当前输入/); assert.match(prompts[0], /保留|仍/);
    assert.equal(h.controller.getState().dirty, true, 'Opening confirmation alone must not abandon input');
    if (outcome === 'new input' || outcome === 'changed back') h.controller.edit('name', 'Typed after dialog opened');
    if (outcome === 'changed back') h.controller.edit('name', 'Input at confirmation');
    if (outcome === 'pending business') h.controller.setContext({ ...h.ctx, busy: true });
    if (outcome === 'pending prop') {
      const pendingTree = recoveryView(h.controller.getState(), h.controller, confirm, true, refs);
      assert.equal(treeNodes(pendingTree).find(node => node.props?.['data-testid'] === 'abandon-current-clip-input').props.disabled, true);
    }
    confirmation.resolve(outcome !== 'cancel'); await clicking;
    const accepted = outcome === 'confirm';
    assert.equal(h.controller.getState().dirty, !accepted);
    assert.equal(h.controller.getState().raw.name, accepted ? raw.name : outcome === 'new input' ? 'Typed after dialog opened' : 'Input at confirmation');
    assert.deepEqual(h.calls, calls, 'Confirmation and local exit perform no DELETE, PUT or business execution');
  });
}

test('local-only exit fences a late GET without silently offering its old recovery candidate', async t => {
  const reading = deferred(), h = harness(t, { hooks: { get: () => reading.promise } });
  const loading = h.controller.load(); h.controller.edit('name', 'Typed before GET returned');
  assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), true);
  const nextToken = h.controller.capture(); reading.resolve(row(record())); await loading;
  assert.equal(h.controller.isCurrent(nextToken), true); assert.equal(h.controller.getState().raw.name, raw.name);
  assert.equal(h.controller.getState().candidate, null); assert.equal(h.controller.getState().dirty, false);
  assert.deepEqual(h.calls.map(([method]) => method), ['get']);
});

test('late abandoned PUT completion cannot invalidate a newer explicit GET or attach an old write acknowledgement', async t => {
  const oldWrite = deferred(), newRead = deferred(); let reads = 0;
  const h = harness(t, { hooks: {
    get: (_key, saved) => ++reads === 1 ? saved : newRead.promise,
    put: async input => { await oldWrite.promise; return { ...row(), revision: 1, draft: record({ raw: input.raw }) }; },
  } });
  await h.controller.load(); h.controller.edit('name', 'Old in-flight input'); const writing = h.controller.flush(); await tick();
  assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), true);
  h.controller.edit('name', 'New retained input'); const loading = h.controller.load(); await tick();
  oldWrite.resolve(); await writing;
  assert.equal(h.controller.getState().raw.name, 'New retained input'); assert.equal(h.controller.getState().candidate, null);
  const current = { ...row(record({ raw: { ...raw, name: 'Record from explicit reread' } })), revision: 2 };
  newRead.resolve(current); await loading;
  assert.equal(h.controller.getState().raw.name, 'New retained input');
  assert.equal(h.controller.getState().candidate.raw.name, 'Record from explicit reread');
  assert.equal(h.controller.getState().autosavePaused, true);
  assert.deepEqual(h.calls.map(([method]) => method), ['get', 'put', 'get']);
});
