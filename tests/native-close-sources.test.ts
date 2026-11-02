import type {HookSlot} from './helpers/strict-timeline-audio-harness-types.ts';
type SessionFor<F extends string>=ReturnType<typeof image.createImageGenerationSession>;
interface ImageFixtureData {reviews:ReturnType<typeof review>[];tasks:ReturnType<typeof task>[];groups:{id:string;projectId:string;name:unknown;revision:number;headVersionId:null;activeTaskId:string;createdAt:string;updatedAt:string}[];receipt:{projectId:string;requestId:unknown;operation:string;response:ReturnType<typeof task>}|null}
import type {ElementModule} from './helpers/strict-timeline-audio-harness-types.ts';
import type {ElementTree, ElementNode} from './helpers/strict-timeline-audio-harness-types.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import * as creationI18n from '../apps/web/src/creation-i18n.ts';
import * as comfySettings from '../apps/web/src/comfy-image-settings.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { transformSync } from 'esbuild';
import * as sources from '../apps/web/src/native-close-sources.ts';
import * as imageEditIntent from '../apps/web/src/image-edit-intent.ts';
import { createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import * as image from '../apps/web/src/image-generation.ts';
import * as contracts from '@mioon/contracts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), requestId = id(4), groupId = id(6), taskId = id(7), reviewId = id(8);
const at = '2026-10-10T10:00:00.000Z';
const deferred = <T = unknown>() => { let resolve!: (value?: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = (yes as (value?: T | PromiseLike<T>) => void); reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };
// Completion is an actual publication event, not an assumed number of event-loop
// turns. This deadline only rejects a hung test; it never proves completion.
function stateNotifications() {
  const listeners = new Set<()=>void>();
  return {
    notify() { for (const check of [...listeners]) check(); },
    until(condition:()=>unknown) {
      if (condition()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { listeners.delete(check); reject(Error('Expected close publication event within 5s')); }, 5000);
        const check = () => { if (condition()) { clearTimeout(timeout); listeners.delete(check); resolve(); } };
        listeners.add(check); check();
      });
    },
  };
}
const memory = () => { const map = new Map(); return { map, getItem: (key: unknown) => map.get(key) || null, setItem: (key: unknown, value: unknown) => map.set(key, value), removeItem: (key: unknown) => map.delete(key) }; };
const paidInput = (patch?: { providerId: string; model: "mock-image-v1"; }|undefined) => ({ projectId, name: 'PRIVATE_NAME', prompt: 'PRIVATE_PROMPT', providerId: 'openai', model: image.IMAGE_MODELS.openai, options: image.IMAGE_FIXED_OPTIONS, requestId, ...patch });
const review = (patch?: Record<string, unknown>) => { const input = paidInput(); return { id: reviewId, projectId, requestId, input, inputHash: createHash('sha256').update(contracts.canonicalImageInput(input)).digest('hex'), settingsRevision: 1, destination: contracts.IMAGE_REVIEW_DESTINATION, policy: contracts.IMAGE_REVIEW_POLICY, state: 'pending', revision: 1, taskId: null, postAttempts: 0, createdAt: at, updatedAt: at, approvedAt: null, rejectedAt: null, dispatchedAt: null, ...patch }; };
const task = (patch?: { prompt?: string; state?: string; }|undefined) => ({ id: taskId, projectId, groupId, requestId, name: 'PRIVATE_NAME', prompt: 'PRIVATE_PROMPT', providerId: 'mock', model: image.IMAGE_MODELS.mock, options: image.IMAGE_FIXED_OPTIONS, state: 'queued', revision: 1, dispatched: false, versionId: null, errorCode: null, createdAt: at, updatedAt: at, ...patch });
const page = <T>(items:T[]) => ({ projectId, items, nextCursor: null });
const imageSettings = { revision: 1, configuration: { ...contracts.DEFAULT_IMAGE_CONFIGURATION, enabled: true }, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' } };
function imageFixture(options:{reviews?:ReturnType<typeof review>[];storage?:ReturnType<typeof memory>;api?:(operation:string,input:Record<string,unknown>,data:ImageFixtureData)=>unknown;reject?:(value:{id:unknown},data:ImageFixtureData)=>unknown} = {}) {
  const data:ImageFixtureData = { reviews: options.reviews || [], tasks: [], groups: [], receipt: null }, calls:string[] = [], storage = options.storage || memory();
  const api = async (operation:string,input:Record<string,unknown>) => {
    calls.push(operation);
    if (options.api) { const value = await options.api(operation, input, data); if (value !== undefined) return value; }
    if (operation === 'image.group.list') return page(data.groups);
    if (operation === 'image.group.get') return data.groups.find(value => value.id === input!.groupId);
    if (operation === 'image.task.list') return page(data.tasks);
    if (operation === 'image.task.get') return data.tasks.find(value => value.id === input!.taskId);
    if (operation === 'image.version.list') return page([]);
    if (operation === 'image.review.list') return page(data.reviews);
    if (operation === 'image.request.get') return data.receipt;
    if (operation === 'image.generate') {
      const result = task(input); data.tasks = [result]; data.groups = [{ id: groupId, projectId, name: input!.name, revision: 1, headVersionId: null, activeTaskId: taskId, createdAt: at, updatedAt: at }];
      data.receipt = { projectId, requestId: input!.requestId, operation, response: result }; return result;
    }
    throw Error(operation);
  };
  const client = { read: async () => imageSettings }, rejects: (unknown)[] = [];
  const reviewClient = { approve: async () => { throw Error('No implicit approval'); }, reject: (value: { id: unknown; }) => { rejects.push(value.id); return options.reject ? options.reject(value, data) : Promise.reject(Error('Unknown reject')); } };
  return { data, api, storage, reviewClient, rejects, calls, settingsClient: client, customSettingsClient: { read: async () => null }, comfySettingsClient: { read: async () => null } };
}
const nodes = (tree: ElementTree): ElementNode[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const same = (a:readonly unknown[]|undefined,b:readonly unknown[]|undefined) => a && b && a.length === b.length && a.every((value: unknown, i: number) => Object.is(value, b[i]));
function renderer<F extends string>(filename:F, fixture: Record<string,unknown>, options:{registry?:ReturnType<typeof createNativeCloseRegistry>;visible?:boolean} = {}) {
  const path = process.env.MIOON_NATIVE_CLOSE_COMPONENT_ROOT ? resolve(process.env.MIOON_NATIVE_CLOSE_COMPONENT_ROOT, filename) : new URL(`../apps/web/src/${filename}`, import.meta.url);
  const source = readFileSync(path, 'utf8'), hooks:HookSlot[] = [], registry = options.registry || createNativeCloseRegistry();
  let cursor = 0, effects: number[] = [], tree: ElementTree, visible = options.visible ?? true, session: SessionFor<F>;
  const publications = stateNotifications();
  const observedRegistry = { ...registry, register(slot: unknown) {
    const registration = registry.register((slot as unknown as Parameters<typeof registry.register>[0]));
    return { ...registration, update(value: unknown) { registration.update((value as unknown as Parameters<typeof registration.update>[0])); publications.notify(); } };
  } };
  const react = {
    createElement: (type: unknown, props = {}, ...children: ElementTree[]) => ({ type, props: { ...props, children } }),
    useState(initial: unknown) { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, (value: (arg0: unknown) => unknown) => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value; }]; },
    useRef(initial: unknown) { return hooks[cursor++] ||= { current: initial }; },
    useMemo(fn: () => unknown, deps: readonly unknown[]) { const index = cursor++; if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { value: fn(), deps }; return hooks[index].value; },
    useLayoutEffect(fn:()=>void|(()=>void), deps: readonly unknown[]) { const index = cursor++, before = hooks[index]; if (before && same(before.deps, deps)) return; hooks[index] = { fn, deps, cleanup: before?.cleanup }; effects.push(index); },
  }; (react as typeof react & {default: unknown}).default = react;
  const module = ({ exports: {} } as ElementModule), primitives = new Proxy({}, { get: (_, name) => String(name) });
  const require = (name: string) => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return { useI18n: () => ({ t: (key: unknown, params: { readonly [x: string]: string|number; }) => i18n.translate('zh-Hans', (key as unknown as Parameters<typeof i18n.translate>[1]), (params as unknown as Parameters<typeof i18n.translate>[2])), renderMessage: (value: string|i18n.DisplayMessage|null|undefined) => i18n.renderMessage('zh-Hans', value), formatDate: (value: string|number|Date, options: Intl.DateTimeFormatOptions|undefined) => i18n.formatDate('zh-Hans', value, options), formatNumber: (value: number, options: Intl.NumberFormatOptions|undefined) => i18n.formatNumber('zh-Hans', value, options) }) };
    if (name === './creation-i18n.ts') return creationI18n;
    if (name === './editor-settings-scope.ts') {
      // Run the real optional native-activity hook against this renderer's hook
      // scheduler. No native scope is passed by the existing Web close cases.
      const activity = { exports: {} };
      const code = transformSync(readFileSync(new URL('../apps/web/src/editor-settings-scope.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
      Function('module', 'exports', 'require', code)(activity, activity.exports, (dependency: unknown) => {
        assert.equal(dependency, 'react', 'Native activity may depend only on this exact React fixture');
        return react;
      });
      return activity.exports;
    }
    if (name === './native-close-sources.ts') return sources;
    if (name === './image-edit-intent.ts') return imageEditIntent;
    if (name === '@mioon/contracts') return contracts;
    if (name === './image-generation.ts') return { ...image, createImageGenerationSession: (input: image.ImageGenerationSessionOptions) => session = (image.createImageGenerationSession({ ...input, requestId: () => requestId, setTimer: () => 1, clearTimer() {} }) as unknown as SessionFor<F>) };
    if (name === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => visible };
    if (name === './image-settings.ts') return { createImageSettingsClient: () => fixture.settingsClient };
    if (name === './comfy-image-settings.ts') return { ...comfySettings, createComfyImageSettingsClient: () => fixture.comfySettingsClient };
    if (name === './ComfyImageDetails.tsx') return primitives;
    if (['./ImageSettings.tsx', './ComfyImageSettings.tsx', './SettingsNavigationSlot.tsx', './icons.tsx'].includes(name)) return { __esModule: true, default: name };
    if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.tsx') return primitives;
    if (name.endsWith('.css')) return {};
    throw Error(`Unexpected close test import: ${name}`);
  };
  Function('module', 'exports', 'require', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)(module, module.exports, require);
  const ui = {
    render() {
      cursor = 0; effects = [];
      tree = module.exports.default({ nativeCloseRegistry: observedRegistry, projectId, projectName: 'Project', onClose() {}, onSettings() {}, ...fixture });
      for (const node of nodes(tree)) if (node.props.ref) (node.props.ref as {current:unknown}).current ||= { value: '', scrollTop: 0, scrollHeight: 0 };
      for (const index of effects) { hooks[index].cleanup?.(); hooks[index].cleanup = hooks[index].fn!(); }
      return tree;
    },
    find: (id: unknown) => nodes(tree).find((node: ElementNode) => node.props['data-testid'] === id),
    edit(id: string, value: string|boolean) { ui.find(id)!.props.onChange({ target: { value, checked: value } }); },
    click(id: string) { ui.find(id)!.props.onClick(); },
    form() { return nodes(tree).find((node: ElementNode) => node.type === 'form'); },
    hide() { visible = false; ui.render(); },
    unmount() { for (const hook of hooks) hook.cleanup?.(); },
    get session() { return session; }, registry,
    state: () => registry.capture()[0],
    waitForState: (condition:()=>unknown) => publications.until(condition),
  };
  return ui;
}
const safeMetadata = (state: unknown) => {
  assert.ok(state, 'Actual mounted component must register a native close source');
  assert.deepEqual(Object.keys(state).sort(), ['blocked', 'busy', 'dirty', 'owner', 'slot', 'version']);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_|private\.example|prompt|requestId|configuration|secret/);
};

test('hidden Image constructor immediately reports restored generation/remote intents and corrupt storage', () => {
  const generation = { version: 1, operation: 'image.generate', input: paidInput({ providerId: 'mock', model: image.IMAGE_MODELS.mock }) };
  const observation = { version: 1, operation: 'image.task.observeRemote', input: { projectId, taskId, expectedRevision: 1, requestId } };
  for (const [key, value] of [[`mioon.image-intent.v1:${projectId}`, generation], [`mioon.comfy-observation.v1:${projectId}`, observation], [`mioon.image-intent.v1:${projectId}`, 'corrupt']] as const) {
    const storage = memory(); storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    const f = imageFixture({ storage }), ui = renderer('ImageGeneration.tsx', f, { visible: false }); ui.render();
    safeMetadata(ui.state()); assert.equal(ui.state().blocked, true); assert.equal(f.calls.length, 0); assert.equal(storage.map.has(key), true); ui.unmount();
  }
});

test('actual Image edits report synchronously and accepted durable generation never requires cancellation', async () => {
  const held = deferred(), f = imageFixture({ api: (operation: string) => operation === 'image.generate' ? held.promise : undefined }), ui = renderer('ImageGeneration.tsx', f);
  ui.render(); await flush(); ui.render(); ui.edit('image-generation-name', 'PRIVATE_NAME'); ui.edit('image-generation-prompt', 'PRIVATE_PROMPT'); assert.equal(ui.state().dirty, true);
  const before = ui.state().version; ui.edit('image-generation-prompt', 'PRIVATE_PROMPT_2'); assert.ok(ui.state().version > before); ui.render();
  ui.form()!.props.onSubmit({ preventDefault() {} }); assert.equal(ui.state().busy, true); assert.equal(ui.state().blocked, true);
  const saved = task({ prompt: 'PRIVATE_PROMPT_2' }); held.resolve!(saved); await flush();
  assert.equal(ui.state().dirty, false); assert.equal(ui.state().blocked, false); assert.equal(ui.state().busy, false);
  const accepted = ui.state().version; await ui.session.load(); assert.equal(ui.state().version, accepted);
  assert.equal(f.calls.some(value => /cancel|recover|observeRemote/.test(value)), false); safeMetadata(ui.state()); ui.unmount();
});

test('actual Image lost rejection ACK remains blocked until an exact readonly rejected review is read', async () => {
  const saved = review(), f = imageFixture({ reviews: [saved] }), ui = renderer('ImageGeneration.tsx', f);
  ui.render(); await flush(); ui.render(); ui.click('image-review-reject'); assert.equal(ui.state().busy, true); assert.equal(ui.state().blocked, true);
  await flush(); await turn(); assert.equal(ui.state().busy, false); assert.equal(ui.state().blocked, true); assert.equal(ui.session.getState().pending, null);
  f.data.reviews = []; await ui.session.load(); assert.equal(ui.state().blocked, true);
  f.data.reviews = [saved]; await ui.session.load(); await turn(); assert.equal(ui.state().blocked, true);
  f.data.reviews = [review({ state: 'rejected', revision: 2, rejectedAt: at })]; await ui.session.load(); await ui.waitForState(() => !ui.state().blocked);
  assert.deepEqual(f.rejects, [reviewId]); safeMetadata(ui.state()); ui.unmount();
});

test('metadata versions follow draft identity, not saved Image task polling or chat stream deltas', () => {
  const registry = createNativeCloseRegistry(), report = sources.createImageGenerationCloseReporter(registry), state = image.initialImageGenerationState();
  const first = report.publish(({ state, dirty: false, rejectionBlocked: false } as unknown as Parameters<typeof report.publish>[0]));
  const second = report.publish(({ state: { ...state, tasks: [task()], historyPhase: 'loading' }, dirty: false, rejectionBlocked: false } as unknown as Parameters<typeof report.publish>[0])); assert.equal(second, first);
  for (const savedState of ['queued', 'dispatching', 'receiving', 'persisting', 'outcome_unknown', 'local_result_error']) {
    assert.equal(report.publish(({ state: { ...state, tasks: [task({ state: savedState })] }, dirty: false, rejectionBlocked: false } as unknown as Parameters<typeof report.publish>[0])).blocked, false);
  }
  const changed = report.publish(({ state: { ...state, mode: 'edit' }, dirty: true, rejectionBlocked: false } as unknown as Parameters<typeof report.publish>[0])); assert.equal(changed.dirty, true); assert.ok(changed.version > first.version);
  report.release(); report.publish(({ state, dirty: false, rejectionBlocked: false } as unknown as Parameters<typeof report.publish>[0])); assert.deepEqual((registry.capture() as unknown), []);
});

const latchOptions = { limit: contracts.IMAGE_REVIEW_LIMITS.reviewsPerProject, identityBytes: contracts.IMAGE_REVIEW_LIMITS.rowBytes };
test('rejection proof retains multiple exact identities; pending/unrelated/older evidence never clears', async () => {
  const publications = stateNotifications(), hashes:(ReturnType<typeof deferred<string>>&{identity:string})[] = [];
  const latch = sources.createImageRejectionCloseLatch(latchOptions, () => publications.notify(), identity => {
    const done = deferred<string>(); hashes.push({ identity, ...done }); return done.promise;
  });
  const finishHashes = async () => { await flush(); for (const row of hashes.splice(0)) row.resolve!(`digest:${row.identity}`); await flush(); };
  latch.begin('one', 1, 'identity-one'); latch.begin('two', 1, 'identity-two'); assert.equal(latch.getState().rejectionBlocked, true);
  await finishHashes();
  latch.reconcile('one', 1, 'pending', 'identity-one'); latch.reconcile('foreign', 2, 'rejected', 'identity-one');
  latch.reconcile('one', 1, 'rejected', 'identity-one'); await finishHashes(); assert.equal(latch.getState().rejectionBlocked, true);
  latch.reconcile('one', 2, 'rejected', 'identity-one'); await finishHashes(); assert.equal(latch.getState().rejectionBlocked, true);
  latch.reconcile('two', 2, 'rejected', 'identity-two'); await flush(); assert.equal(latch.getState().rejectionBlocked, true, 'uncompleted identity hash cannot authorize leaving');
  const completed = publications.until(() => !latch.getState().rejectionBlocked); await finishHashes(); await completed;
  assert.equal(latch.getState().rejectionBlocked, false); latch.dispose();
});

test('one hundred loop turns cannot certify completion; actual hash publication alone settles the observer', async () => {
  const publications = stateNotifications(), held = deferred<string>(); let digestCalls = 0;
  const latch = sources.createImageRejectionCloseLatch(latchOptions, () => publications.notify(), () => { digestCalls++; return held.promise; });
  latch.begin('one', 1, 'identity'); latch.reconcile('one', 2, 'rejected', 'identity'); await flush(); assert.equal(digestCalls, 2);
  // Exact previous helper is a negative control. Both digests deliberately stay
  // pending across all its turns, a valid scheduling outcome for WebCrypto.
  const oldTurnBudget = async (condition: { (): boolean; (): unknown; }) => { for (let n = 0; n < 100; n++) { if (condition()) return; await turn(); } assert.ok(condition(), 'Expected close proof to settle'); };
  await assert.rejects(oldTurnBudget(() => !latch.getState().rejectionBlocked), /Expected close proof to settle/);
  assert.equal(latch.getState().rejectionBlocked, true);
  const completed = publications.until(() => !latch.getState().rejectionBlocked);
  held.resolve!('exact-digest'); await completed; assert.equal(latch.getState().rejectionBlocked, false); latch.dispose();
});

test('real WebCrypto identity reconciliation publishes completion without a scheduler-turn assumption', async () => {
  const publications = stateNotifications();
  const latch = sources.createImageRejectionCloseLatch(latchOptions, () => publications.notify());
  latch.begin('one', 1, 'same real SHA bytes'); latch.reconcile('one', 2, 'rejected', 'same real SHA bytes');
  assert.equal(latch.getState().rejectionBlocked, true);
  await publications.until(() => !latch.getState().rejectionBlocked); assert.equal(latch.getState().rejectionBlocked, false); latch.dispose();
});

test('identity corruption, existing-domain overflow and hash failure never release close proof', async () => {
  for (const kind of ['different-identity', 'overflow', 'oversize', 'hash-failure']) {
    const latch = sources.createImageRejectionCloseLatch(latchOptions, () => {}, kind === 'hash-failure' ? () => Promise.reject(Error('Unavailable')) : undefined);
    if (kind === 'overflow') { for (let n = 0; n <= latchOptions.limit; n++) latch.begin(`id-${n}`, 1, `identity-${n}`); }
    else { latch.begin('one', 1, kind === 'oversize' ? 'x'.repeat(latchOptions.identityBytes + 1) : 'identity'); if (kind === 'different-identity') latch.reconcile('one', 2, 'rejected', 'changed'); }
    await flush(); await turn(); assert.equal(latch.getState().rejectionBlocked, true, kind); latch.dispose();
  }
});

test('disposed hash/reconciliation completions cannot publish or reset a replacement owner', async () => {
  const held = deferred<string>(); let oldChanges = 0;
  const old = sources.createImageRejectionCloseLatch(latchOptions, () => oldChanges++, () => held.promise);
  old.begin('one', 1, 'same'); old.reconcile('one', 2, 'rejected', 'same'); old.dispose(); const before = oldChanges;
  const fresh = sources.createImageRejectionCloseLatch(latchOptions); fresh.begin('two', 1, 'new'); held.resolve!('digest'); await flush();
  assert.equal(oldChanges, before); assert.equal(fresh.getState().rejectionBlocked, true); fresh.dispose();
});


test('readonly concurrent approval/dispatched proof resolves lost rejection without cancelling durable work', async () => {
  for (const status of ['approved', 'dispatched']) {
    const saved = review(), f = imageFixture({ reviews: [saved] }), ui = renderer('ImageGeneration.tsx', f);
    ui.render(); await flush(); ui.render(); ui.click('image-review-reject'); await flush(); assert.equal(ui.state().blocked, true);
    f.data.reviews = [review({ state: status, revision: status === 'approved' ? 2 : 3, taskId, approvedAt: at, ...(status === 'dispatched' ? { dispatchedAt: at, postAttempts: 1 } : {}) })];
    await ui.session.load(); await ui.waitForState(() => !ui.state().blocked);
    assert.deepEqual(f.rejects, [reviewId]); assert.equal(f.calls.some(value => /cancel|recover|generate/.test(value)), false); ui.unmount();
  }
});

test('a late failed hash for an older pending read cannot poison an already resolved review', async () => {
  const held = deferred<string>(); let calls = 0;
  const latch = sources.createImageRejectionCloseLatch(latchOptions, () => {}, () => ++calls === 2 ? held.promise : Promise.resolve('same-digest'));
  latch.begin('one', 1, 'same'); latch.reconcile('one', 1, 'pending', 'same'); latch.reconcile('one', 2, 'rejected', 'same');
  await flush(); assert.equal(latch.getState().rejectionBlocked, false); held.reject!(Error('Late unavailable hash')); await flush(); assert.equal(latch.getState().rejectionBlocked, false); latch.dispose();
});
