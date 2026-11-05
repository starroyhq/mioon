import test from 'node:test';
import assert from 'node:assert/strict';
import type {ProjectEntriesResponse} from '../packages/contracts/src/project-entry.ts';
import {createProjectEntryIdentityOwner, readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import {ProjectEntryDirectoryError} from '../apps/web/src/project-entry-directory-client.ts';
import {createWorkspacePreferences} from '../apps/web/src/workspace-preferences.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';

const scope = 'a'.repeat(64), otherScope = 'b'.repeat(64);
const id = (n: number): string => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snapshot = (instanceId = id(1), appLibraryScope = scope): ProjectEntriesResponse => ({version: 1, appLibraryScope, instanceId,
  registered: [{project: {projectId: id(10), name: '只读项目', projectFile: '/synthetic/project.mioon', fileIdentity: {dev: '1', ino: '2'}, lastOpenedAt: null, summary: null}, availability: {state: 'missing'}, coverUrl: null}]});
const tick = (): Promise<void> => new Promise(setImmediate);

test('identity accepts only a complete directory and notifies independent subscribers without any selection writer', async () => {
  let value: unknown = {...snapshot(), extra: true}, reads = 0, first = 0, second = 0;
  const owner = createProjectEntryIdentityOwner({read: async () => {reads++; return value;}});
  assert.equal(await owner.discover(), null); assert.equal(reads, 0);
  const release = owner.subscribe(() => first++); owner.subscribe(() => second++); owner.activate();
  assert.equal(await owner.discover(), null); assert.equal(owner.getVerifiedScope(), null); owner.assertIdentity();
  value = snapshot(); assert.deepEqual(await readProjectEntryIdentity(owner), snapshot());
  assert.equal(owner.getVerifiedScope(), scope); assert.equal(owner.getState().instanceId, id(1));
  assert.equal(owner.getState().snapshot?.registered[0].project.summary, null);
  assert.equal(owner.getState().snapshot?.registered[0].availability.state, 'missing');
  assert.equal(first, 4); assert.equal(second, 4); release(); await owner.refresh();
  assert.equal(first, 4); assert.equal(second, 6);
  assert.equal('rememberOpened' in owner, false); assert.equal('put' in owner, false); owner.dispose();
});

test('a verified library or same-library instance change blocks permanently across retries and lifetimes', async () => {
  for (const [replacement, code] of [[snapshot(id(2)), 'PROJECT_ENTRY_STALE_INSTANCE'], [snapshot(id(1), otherScope), 'PROJECT_ENTRY_SCOPE_MISMATCH']] as const) {
    let value = snapshot(), reads = 0;
    const owner = createProjectEntryIdentityOwner({read: async () => {reads++; return value;}}); owner.activate(); await owner.discover();
    value = replacement; assert.equal(await owner.refresh(), null); assert.equal(owner.getState().phase, 'blocked');
    assert.equal(owner.getState().snapshot, null); assert.equal(owner.getVerifiedScope(), null);
    assert.throws(owner.assertIdentity, {code, status: 409});
    owner.dispose(); owner.activate(); value = snapshot();
    assert.equal(await owner.discover(), null); assert.equal(await owner.refresh(), null); assert.equal(reads, 2);
    await assert.rejects(readProjectEntryIdentity(owner), {code, status: 409}); owner.dispose();
    const replacementOwner = createProjectEntryIdentityOwner({read: async () => replacement}); replacementOwner.activate();
    assert.deepEqual(await replacementOwner.discover(), replacement); replacementOwner.dispose();
  }
});

test('discover joins one flight, explicit refresh aborts older replies and retired lifetime cannot block the new owner', async () => {
  const requests: {signal: AbortSignal; reply: ReturnType<typeof Promise.withResolvers<unknown>>}[] = [];
  const owner = createProjectEntryIdentityOwner({read: ({signal}) => {const reply = Promise.withResolvers<unknown>(); requests.push({signal, reply}); return reply.promise;}});
  owner.activate(); const initial = owner.discover(), joined = owner.discover(); assert.equal(initial, joined); assert.equal(requests.length, 1);
  const fresh = owner.refresh(); assert.equal(requests[0].signal.aborted, true); requests[1].reply.resolve(snapshot());
  assert.deepEqual(await fresh, snapshot()); requests[0].reply.resolve(snapshot(id(2), otherScope)); assert.equal(await initial, null);
  const retired = owner.refresh(); owner.dispose(); owner.activate(); const current = owner.discover();
  requests[3].reply.resolve(snapshot()); await current;
  requests[2].reply.reject(new ProjectEntryDirectoryError('UNAUTHORIZED', 401)); assert.equal(await retired, null);
  await tick(); assert.equal(owner.getState().phase, 'ready'); assert.equal(owner.getVerifiedScope(), scope); owner.dispose();
});

test('network and auth failures remain unknown, preserve verified identity, and retry only the same service', async () => {
  let error: unknown = new ProjectEntryDirectoryError('UNAUTHORIZED', 401);
  const owner = createProjectEntryIdentityOwner({read: async () => {if (error) throw error; return snapshot();}}); owner.activate();
  for (const [code, status] of [['UNAUTHORIZED', 401], ['ORIGIN_REJECTED', 403]] as const) {
    error = new ProjectEntryDirectoryError(code, status); await assert.rejects(readProjectEntryIdentity(owner), {code, status});
    assert.equal(owner.getState().snapshot, null); assert.equal(owner.getVerifiedScope(), null); owner.assertIdentity();
  }
  error = null; await owner.refresh(); error = Error('private network path'); await owner.refresh();
  assert.equal(owner.getState().phase, 'error'); assert.equal(owner.getState().snapshot, null); assert.equal(owner.getVerifiedScope(), scope);
  assert.deepEqual(owner.getState().failure, {code: 'BACKEND_UNAVAILABLE'}); owner.assertIdentity();
  error = null; await owner.refresh(); assert.equal(owner.getState().phase, 'ready'); owner.dispose();
});

test('an invalid replacement cannot establish an instance or silently convert a failed read to an empty directory', async () => {
  let value: unknown = snapshot(); const owner = createProjectEntryIdentityOwner({read: async () => value}); owner.activate(); await owner.discover();
  value = {...snapshot(id(2)), registered: [{project: {}}]};
  await assert.rejects(readProjectEntryIdentity(owner), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  assert.equal(owner.getState().identityBlocked, false); assert.equal(owner.getState().snapshot, null); assert.equal(owner.getState().instanceId, id(1));
  value = snapshot(id(2)); await owner.refresh(); assert.equal(owner.getState().identityBlocked, true); owner.dispose();
});

test('sticky identity prevents an old preference queue and late ACK from reviving after A to null to A', async () => {
  let value = snapshot(); const owner = createProjectEntryIdentityOwner({read: async () => value}); owner.activate(); await owner.discover();
  const ack = Promise.withResolvers<Response>(), calls: RequestInit[] = [], cache = new Map<string, string>();
  const preferences = createWorkspacePreferences({getStorageScope: owner.getVerifiedScope, delayMs: 60_000, maxWaitMs: 60_000,
    storage: {getItem: key => cache.get(key) ?? null, setItem: (key, text) => {cache.set(key, text);}},
    fetchImpl: async (_url, options) => {
      calls.push(options ?? {});
      if (options?.method === 'PUT') return ack.promise;
      return new Response(JSON.stringify({ok: true, data: {projectId: id(10), revision: 0, state: null}}));
    }});
  await preferences.load(id(10)); const draft = defaultWorkspaceState(); draft.shared.assetsCollapsed = true;
  preferences.update(id(10), draft, {immediate: true}); await tick(); assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  value = snapshot(id(2)); await owner.refresh(); assert.equal(owner.getVerifiedScope(), null);
  const before = new Map(cache); ack.resolve(new Response(JSON.stringify({ok: true, data: {projectId: id(10), revision: 1, state: draft}}))); await tick();
  owner.dispose(); owner.activate(); value = snapshot(); await owner.refresh(); await preferences.flush();
  assert.equal(owner.getVerifiedScope(), null); assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  assert.deepEqual(cache, before); assert.equal(preferences.hasUnsaved(), true); await preferences.dispose({flush: false}); owner.dispose();
});
