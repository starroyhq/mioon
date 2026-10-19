import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopLutRecoveryHost } from '../apps/desktop/src/lut-recovery-host.ts';
import { ClipLutRecoveryError, parseClipLutRecoveryRequest, parseClipLutRecoveryResponse } from '../packages/contracts/src/clip-lut-recovery.ts';

const record = (change: Record<string, unknown> = {}) => ({ version: 1, workspaceScope: 'a'.repeat(64), projectId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', name: 'look.cube', sizeBytes: 30, sha256: 'b'.repeat(64), ...change });
const identity = (change: Record<string, unknown> = {}) => ({ workspaceScope: record().workspaceScope, projectId: record().projectId, ...change });
const denied = { ok: false, code: 'LUT_RECOVERY_UNAVAILABLE' };
interface HostState {current: boolean; scope: string; owner: boolean; calls: unknown[]; guard: (() => void) | null}
type Overrides = Record<string, ((state: HostState, value: Record<string, unknown>) => unknown) | undefined>;
function fixture(overrides: Overrides = {}) {
  const state: HostState = { current: true, scope: record().workspaceScope, owner: true, calls: [], guard: null };
  const owner = { projectId: record().projectId, isCurrent: () => state.current };
  const host = createDesktopLutRecoveryHost({
    ownerForEvent: (event: unknown) => event === 'editor' && state.owner ? owner : null,
    currentWorkspaceScope: () => state.scope,
    createStore: (guard: () => void) => {
      state.guard = guard;
      return Object.fromEntries(['read', 'reserve', 'verify', 'complete'].map((action: string) => [action, (value: unknown) => {
        state.calls.push([action, value]); guard();
        return overrides[action] ? overrides[action](state, value as Record<string, unknown>) : action === 'read' ? record() : undefined;
      }]));
    },
  } as unknown as Parameters<typeof createDesktopLutRecoveryHost>[0]);
  return { state, host };
}

test('shared requests are exact metadata-only envelopes and reject getters without invoking them', () => {
  let getters = 0;
  const getter = (object: Record<string, unknown>, key: string) => Object.defineProperty({ ...object }, key, { enumerable: true, get() { getters++; return object[key]; } });
  const read = { action: 'read', identity: identity() }, reserve = { action: 'reserve', value: record() };
  for (const bad of [null, [], { ...read, path: '/private/userData' }, { action: 'delete', value: record() },
    { action: 'invoke', channel: 'fs:read', value: record() }, getter(read, 'action'),
    { ...read, identity: getter(identity(), 'projectId') }, { ...read, identity: { ...identity(), path: '/tmp/x' } },
    { ...reserve, value: getter(record(), 'name') }, { ...reserve, value: { ...record(), cubeText: 'LUT_3D_SIZE 2' } },
    ...['/private/look.cube', '..\\look.cube', 'bad\n.cube', 'x'.repeat(3000) + '.cube'].map(name => ({ ...reserve, value: record({ name }) })),
    { ...reserve, value: record({ sizeBytes: Number.MAX_SAFE_INTEGER }) },
    { ...reserve, value: Object.assign(Object.create({ inherited: true }), record()) },
    { ...read, [Symbol('hidden')]: true }]) assert.throws(() => parseClipLutRecoveryRequest(bad));
  assert.equal(getters, 0);
  for (const action of ['reserve', 'verify', 'complete']) assert.deepEqual(parseClipLutRecoveryRequest({ action, value: record() }), { action, value: record() });
  const parsed = parseClipLutRecoveryRequest(reserve); reserve.value.name = 'changed.cube'; assert.equal((parsed as {value: {name: string}}).value.name, 'look.cube');
});

test('shared response parser refuses extra data, getters, wrong scope and metadata from writes', () => {
  const request = { action: 'read', identity: identity() };
  let touched = false;
  const accessor = Object.defineProperty({ ok: true }, 'value', { enumerable: true, get() { touched = true; return record(); } });
  for (const response of [accessor, { ok: true, value: null, path: '/private/store' }, { ok: false, code: 'ENOENT' },
    { ok: false, code: 'LUT_RECOVERY_CORRUPT', message: '/private/store' }, { ok: true, value: record({ workspaceScope: 'c'.repeat(64) }) },
    { ok: true, value: record({ projectId: '33333333-3333-4333-8333-333333333333' }) }, { ok: true, value: { ...record(), path: '/private' } }]) {
    assert.throws(() => parseClipLutRecoveryResponse(response, request as unknown as Parameters<typeof parseClipLutRecoveryResponse>[1]));
  }
  assert.equal(touched, false);
  assert.throws(() => parseClipLutRecoveryResponse({ ok: true, value: record() }, { action: 'reserve', value: record() } as unknown as Parameters<typeof parseClipLutRecoveryResponse>[1]));
});

test('host rejects unowned editor, wrong project and workspace before reading or mutating store', async () => {
  const { state, host } = fixture();
  for (const action of ['read', 'reserve', 'verify', 'complete']) {
    for (const change of [{ workspaceScope: 'c'.repeat(64) }, { projectId: '33333333-3333-4333-8333-333333333333' }]) {
      assert.deepEqual(await host.dispatch('editor', action === 'read' ? { action, identity: identity(change) } : { action, value: record(change) }), denied);
    }
    assert.deepEqual(await host.dispatch('launcher', action === 'read' ? { action, identity: identity() } : { action, value: record() }), denied);
  }
  state.current = false;
  assert.deepEqual(await host.dispatch('editor', { action: 'read', identity: identity() }), denied);
  assert.deepEqual(state.calls, []);
});

test('queued requests capture the old document and reject invalidation before store access', async () => {
  const { state, host } = fixture();
  const pending = host.dispatch('editor', { action: 'read', identity: identity() });
  state.current = false;
  assert.deepEqual(await pending, denied); assert.deepEqual(state.calls, []);
  state.current = true;
  const oldScope = host.dispatch('editor', { action: 'reserve', value: record() });
  state.scope = 'c'.repeat(64);
  assert.deepEqual(await oldScope, denied); assert.deepEqual(state.calls, []);
});

test('host queue isolates guards and drains after failures without exposing raw diagnostics', async () => {
  let first = true;
  const { state, host } = fixture({ read() { if (first) { first = false; throw new Error('EACCES /private/userData/pending.json'); } return record(); } });
  assert.throws(() => state.guard!());
  const a = host.dispatch('editor', { action: 'read', identity: identity() });
  const b = host.dispatch('editor', { action: 'read', identity: identity() });
  assert.deepEqual(await a, denied); assert.deepEqual(await b, { ok: true, value: record() });
  assert.throws(() => state.guard!());
  assert.equal(state.calls.length, 2);
});

for (const action of ['read', 'reserve', 'verify', 'complete']) {
  test(`host rechecks ownership after synchronous ${action} and store guard before publication`, async () => {
    const request = action === 'read' ? { action, identity: identity() } : { action, value: record() };
    for (const invalidation of ['current', 'scope']) {
      const invalidate = (state: HostState) => { if (invalidation === 'current') state.current = false; else state.scope = 'c'.repeat(64); };
      const f = fixture({ [action](state) { invalidate(state); return record(); } });
      assert.deepEqual(await f.host.dispatch('editor', request), denied);
      let published = false;
      const g = fixture({ [action](state: HostState) { invalidate(state); state.guard!(); published = true; return record(); } });
      assert.deepEqual(await g.host.dispatch('editor', request), denied); assert.equal(published, false);
    }
  });
}

test('host returns only recognized application codes and validates store read metadata', async () => {
  for (const code of ['LUT_RECOVERY_CONFLICT', 'LUT_RECOVERY_CORRUPT', 'LUT_RECOVERY_UNAVAILABLE']) {
    const { host } = fixture({ reserve() { throw new ClipLutRecoveryError(code as ConstructorParameters<typeof ClipLutRecoveryError>[0], '/private/userData/secret'); } });
    assert.deepEqual(await host.dispatch('editor', { action: 'reserve', value: record() }), { ok: false, code });
  }
  for (const value of [{ ...record(), path: '/private/userData' }, record({ workspaceScope: 'c'.repeat(64) }), record({ name: '/private/look.cube' })]) {
    const { host } = fixture({ read() { return value; } });
    const result = await host.dispatch('editor', { action: 'read', identity: identity() });
    assert.equal(result.ok, false); assert.deepEqual(Object.keys(result).sort(), ['code', 'ok']); assert.doesNotMatch(JSON.stringify(result), /private|userData/);
  }
});

test('host snapshots mutable requests before queueing and uses the captured document owner', async () => {
  const calls: unknown[] = [], firstOwner = { projectId: record().projectId, valid: true, isCurrent() { return this.valid; } };
  let currentOwner = firstOwner;
  const host = createDesktopLutRecoveryHost({ ownerForEvent: () => currentOwner, currentWorkspaceScope: () => record().workspaceScope,
    createStore: (guard: () => void) => ({ read() { guard(); calls.push('read'); return record(); }, reserve(value: Record<string, unknown>) { guard(); calls.push(value.name); }, verify() {}, complete() {} }) } as unknown as Parameters<typeof createDesktopLutRecoveryHost>[0]);
  const value = record(), first = host.dispatch('editor', { action: 'reserve', value });
  value.name = 'changed-after-dispatch.cube';
  assert.deepEqual(await first, { ok: true, value: null }); assert.deepEqual(calls, ['look.cube']);
  const oldDocument = host.dispatch('editor', { action: 'read', identity: identity() });
  firstOwner.valid = false;
  currentOwner = { projectId: record().projectId, isCurrent() { return true; } } as typeof firstOwner;
  const newDocument = host.dispatch('editor', { action: 'read', identity: identity() });
  assert.deepEqual(await oldDocument, denied);
  assert.deepEqual(await newDocument, { ok: true, value: record() });
  assert.deepEqual(calls, ['look.cube', 'read']);
});
