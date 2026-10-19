import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installPreferencesCloseDrain, installUnsavedGuard, QuitCoordinator } from '../apps/desktop/src/lifecycle.ts';
import { createWorkspacePreferences } from '../apps/web/src/workspace-preferences.ts';
import { defaultWorkspaceState } from '../apps/web/src/workspace-state.ts';

interface WindowFixture extends EventEmitter {
  webContents: EventEmitter; destroyed: boolean; dirty: boolean;
  isDestroyed(): boolean; close(): void;
}
function windowFixture(): WindowFixture {
  const win = new EventEmitter() as WindowFixture;
  win.webContents = new EventEmitter();
  win.destroyed = false; win.dirty = false;
  win.isDestroyed = () => win.destroyed;
  win.close = () => {
    let prevented = false;
    win.emit('close', { preventDefault() { prevented = true; } });
    if (prevented) return;
    if (win.dirty) {
      let allowed = false;
      win.webContents.emit('will-prevent-unload', { preventDefault() { allowed = true; } });
      if (!allowed) return;
    }
    win.destroyed = true; win.emit('closed');
  };
  return win;
}
function defer<T = void>(): {promise: Promise<T>; resolve: (value?: T) => void} {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>(r => { resolve = r as (value?: T) => void; });
  return {promise, resolve};
}
type WindowArg<T> = T extends (...args: infer A) => unknown ? A[0] : never;
const asWindow = <T>(win: WindowFixture): WindowArg<T> => win as unknown as WindowArg<T>;

test('native quit keeps window and backend alive through queued preference flush, then stops once', async () => {
  const win = windowFixture(), older = defer(), latest = defer(), events: string[] = [];
  const coordinator = new QuitCoordinator({ getWindow: () => win, stop: async () => events.push('stop'), finish: () => events.push('finish') });
  installPreferencesCloseDrain(asWindow<typeof installPreferencesCloseDrain>(win), {
    flush: async () => { events.push('older'); await older.promise; events.push('latest'); await latest.promise; return true; },
    confirmClose: () => assert.fail('A saved view does not need confirmation'), onCancel: () => coordinator.cancel(),
  });
  const quitting = coordinator.request();
  assert.equal(quitting, coordinator.request());
  await Promise.resolve();
  assert.equal(win.destroyed, false); assert.deepEqual(events, ['older']);
  older.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['older', 'latest']); assert.equal(win.destroyed, false);
  latest.resolve(); assert.equal(await quitting, true);
  assert.deepEqual(events, ['older', 'latest', 'stop', 'finish']);
});

test('real controller close drain acknowledges an older in-flight CAS then persists the final mode', async t => {
  const projectId = '5af3042d-08ae-4f37-8774-2d64dc15f5cb', first = defer(), started = defer(), calls: Array<Record<string, unknown>> = [];
  let revision = 0;
  const controller = createWorkspacePreferences({ storage: undefined, retryDelays: [], requestTimeoutMs: 0,
    fetchImpl: (async (_url: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === 'GET') return { ok: true, json: async () => ({ ok: true, data: { projectId, revision: 0, state: null } }) };
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>; calls.push(body);
      assert.equal(options?.keepalive, true); assert.equal(body.expectedRevision, revision);
      if (calls.length === 1) { started.resolve(); await first.promise; }
      revision++;
      return { ok: true, json: async () => ({ ok: true, data: { projectId, revision, state: body.state } }) };
    }) as unknown as typeof fetch });
  t.after(() => controller.dispose({ flush: false }));
  await controller.load(projectId);
  const older = defaultWorkspaceState(); older.editing.playhead = 42;
  controller.update(projectId, older, { immediate: true }); await started.promise;
  controller.update(projectId, { ...older, activeMode: 'editing' }, { immediate: true });
  const win = windowFixture(); let stopped = 0;
  const coordinator = new QuitCoordinator({ getWindow: () => win, stop: async () => stopped++, finish: () => {} });
  installPreferencesCloseDrain(asWindow<typeof installPreferencesCloseDrain>(win), { flush: async () => { await controller.flush({ keepalive: true }); return !controller.hasUnsaved(); },
    confirmClose: () => assert.fail('Successful CAS drain must not ask to discard'), onCancel: () => coordinator.cancel() });
  const quit = coordinator.request();
  await Promise.resolve(); assert.equal(win.destroyed, false); assert.equal(stopped, 0);
  first.resolve(); assert.equal(await quit, true);
  assert.equal(calls.length, 2); assert.equal(calls[1].expectedRevision, 1);
  const latestCall = calls[1] as {state: {activeMode: string; editing: {playhead: number}}}; assert.equal(latestCall.state.activeMode, 'editing'); assert.equal(latestCall.state.editing.playhead, 42);
  assert.equal(controller.hasUnsaved(), false); assert.equal(stopped, 1);
});

test('unavailable preferences have a bounded close wait and an explicit discard decision', async () => {
  const win = windowFixture(); let asked = 0, stopped = 0;
  const coordinator = new QuitCoordinator({ getWindow: () => win, stop: async () => stopped++, finish: () => {} });
  installPreferencesCloseDrain(asWindow<typeof installPreferencesCloseDrain>(win), { flush: () => new Promise(() => {}), timeoutMs: 10,
    confirmClose: () => { asked++; return true; }, onCancel: () => coordinator.cancel() });
  assert.equal(await coordinator.request(), true);
  assert.equal(asked, 1); assert.equal(stopped, 1); assert.equal(win.destroyed, true);
});

test('cancel after preference failure keeps backend alive; next request can succeed', async () => {
  const win = windowFixture(); let saved = false, asked = 0, stopped = 0;
  const coordinator = new QuitCoordinator({ getWindow: () => win, stop: async () => stopped++, finish: () => {} });
  installPreferencesCloseDrain(asWindow<typeof installPreferencesCloseDrain>(win), { flush: async () => saved,
    confirmClose: () => { asked++; return false; }, onCancel: () => coordinator.cancel() });
  assert.equal(await coordinator.request(), false);
  assert.equal(asked, 1); assert.equal(stopped, 0); assert.equal(win.destroyed, false);
  saved = true;
  assert.equal(await coordinator.request(), true);
  assert.equal(asked, 1); assert.equal(stopped, 1);
});

test('preference close drain preserves existing unsaved business-draft cancellation', async () => {
  const win = windowFixture(); win.dirty = true;
  let discard = false, stopped = 0, flushes = 0;
  const coordinator = new QuitCoordinator({ getWindow: () => win, stop: async () => stopped++, finish: () => {} });
  installPreferencesCloseDrain(asWindow<typeof installPreferencesCloseDrain>(win), { flush: async () => { flushes++; return true; }, confirmClose: () => true, onCancel: () => coordinator.cancel() });
  installUnsavedGuard(asWindow<typeof installUnsavedGuard>(win), { confirmDiscard: () => discard, onCancel: () => coordinator.cancel() });
  assert.equal(await coordinator.request(), false);
  assert.equal(stopped, 0); assert.equal(win.destroyed, false);
  discard = true;
  assert.equal(await coordinator.request(), true);
  assert.equal(stopped, 1); assert.equal(flushes, 2);
});

test('a throwing drain or failed failure dialog cannot create an unhandled rejection or destroy drafts', async () => {
  const win = windowFixture(); let cancellations = 0;
  installPreferencesCloseDrain(asWindow<typeof installPreferencesCloseDrain>(win), { flush: () => { throw Error('backend absent'); },
    confirmClose: () => { throw Error('dialog unavailable'); }, onCancel: () => { cancellations++; } });
  win.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1); assert.equal(win.destroyed, false);
});
