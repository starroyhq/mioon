import type {NativeAdditionalCloseSnapshot} from '../apps/web/src/native-close-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageGenerationSession, imageDraftDirty } from '../apps/web/src/image-generation.ts';
import { createEditorSettingsScope } from '../apps/web/src/editor-settings-scope.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { createImageGenerationCloseReporter } from '../apps/web/src/native-close-sources.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';

// These tests join the actual sessions and close reporters to the actual scope
// and admission. A fake boolean source cannot reproduce focus starting a load.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), requestId = id(5);
const settle = () => new Promise(resolve => setImmediate(resolve));
const commitOptions = (patch: { allowUnknown?: boolean; discardDirty?: boolean; allowDrainFailure?: boolean; }|undefined = {}) => ({ discardDirty: true, allowDrainFailure: false, expiresAt: 1500, ...patch });
function unload(admission:ReturnType<typeof createNativeCloseAdmission>) {
  let prevented = false;
  const event = { type: 'beforeunload', preventDefault() { prevented = true; }, returnValue: undefined };
  admission.prepareBeforeUnload(event as unknown as Parameters<typeof admission.prepareBeforeUnload>[0]);
  const allowed = admission.beforeUnload(event as unknown as Parameters<typeof admission.beforeUnload>[0]);
  return { allowed, prevented };
}
function closeFixture(registry:ReturnType<typeof createNativeCloseRegistry>,scope:ReturnType<typeof createEditorSettingsScope>,additional:NativeAdditionalCloseSnapshot = { dirty: false, busy: false, unknown: false, identity: [] }) {
  let sequence = 0;
  return createNativeCloseAdmission({
    registry, settings: createSettingsNavigationRegistry(), readScope: () => `workspace:${projectId}:1`,
    readDocumentURL: () => `http://127.0.0.1:8123/?project=${projectId}`,
    readAdditionalSnapshot: () => additional, onObservationPause: paused => scope.pauseObservation(paused),
    now: () => 1000, newToken: () => `modal-close-${++sequence}`,
  });
}

test('actual image draft stays unchanged through native modal focus and cancellation performs reads only', async t => {
  const registry = createNativeCloseRegistry(), reporter = createImageGenerationCloseReporter(registry);
  const calls: unknown[] = [], stored = new Map<string,string>(), timers = new Map<number,()=>void>(); let timerId = 0, session:ReturnType<typeof createImageGenerationSession>;
  const storage = { getItem: (key:string) => stored.get(key) ?? null, setItem: (key:string,value:string) => stored.set(key, value), removeItem: (key:string) => stored.delete(key) };
  session = createImageGenerationSession({
    projectId, storage:storage as unknown as Storage, requestId: () => requestId,
    api: async operation => {
      calls.push(operation);
      if (['image.group.list', 'image.task.list', 'image.review.list'].includes(operation)) return { projectId, items: [], nextCursor: null };
      throw new Error(`Unexpected image operation: ${operation}`);
    },
    onChange: state => reporter.publish({ state:state as Parameters<typeof reporter.publish>[0]['state'], dirty: imageDraftDirty(state), rejectionBlocked: session.getNativeCloseState().rejectionBlocked }),
    setTimer: callback => { timers.set(++timerId, callback); return timerId; }, clearTimer: key => timers.delete(key!),
  });
  reporter.publish({ state: session.getState() as Parameters<typeof reporter.publish>[0]['state'], dirty: imageDraftDirty(session.getState()), rejectionBlocked: session.getNativeCloseState().rejectionBlocked });
  const scope = createEditorSettingsScope(async () => true), unsubscribe = scope.subscribe(active => session.setVisible(active));
  const admission = closeFixture(registry, scope);
  t.after(() => { scope.dispose(); admission.dispose(); unsubscribe(); session.dispose(); reporter.release(); });
  assert.equal(await session.load(), true);
  assert.equal(session.edit('name', 'Keep this image name'), true);
  assert.equal(session.edit('prompt', 'Keep this exact image prompt'), true);
  const draft = structuredClone(session.getState().draft), before = [...calls];
  const first = admission.inspect(), captured = registry.capture();
  assert.equal(first.disposition, 'dirty');
  scope.blur(); scope.focus(); await settle();
  assert.equal(registry.isCurrent(captured), true);
  assert.deepEqual(calls, before);
  assert.equal(admission.commit(first.token, commitOptions()), true);
  assert.deepEqual(unload(admission), { allowed: true, prevented: false });
  assert.deepEqual(session.getState().draft, draft);
  assert.deepEqual(calls, before);
  // Model main cancelling after a prevented/did-not-close window lifetime.
  assert.equal(admission.cancel(first.token), true);
  await settle();
  assert.deepEqual(calls, [...before, 'image.group.list', 'image.task.list', 'image.review.list']);
  assert.deepEqual(session.getState().draft, draft);
  assert.equal(stored.size, 0);
  assert.equal(reporter.getState().busy, false);
});
