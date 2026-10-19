import { creationUiMessages } from '../packages/i18n/src/catalogs/creation-ui.ts';
import { createLanguageStore } from '../apps/web/src/i18n/language-store.ts';
import { createI18nTestContext } from './helpers/i18n.ts';
import { comfyConnectorAvailabilityDescriptor } from '../apps/web/src/comfy-image-settings.ts';
import { creationTestDependency } from './helpers/creation-i18n.ts';
import * as nativeCloseSources from '../apps/web/src/native-close-sources.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { canonicalImageInput } from '../packages/contracts/src/images.ts';
import { ApiError } from '../apps/web/src/api.ts';
import * as imageLogic from '../apps/web/src/image-generation.ts';
import * as imageEditIntents from '../apps/web/src/image-edit-intent.ts';
import { IMAGE_LIMITS } from '../packages/contracts/src/images.ts';
import { DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION } from '../packages/contracts/src/image-settings.ts';
import { IMAGE_REVIEW_DESTINATION, IMAGE_REVIEW_POLICY } from '../packages/contracts/src/image-reviews.ts';
import { IMAGE_FIXED_OPTIONS, IMAGE_MODELS, createImageGenerationSession, imageCanGenerate, imageDraftDirty, imageInputIssue, imageTaskLabel } from '../apps/web/src/image-generation.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
type Obj = Record<string, unknown>;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), groupId = id(2), taskId = id(3), requestId = id(4), versionId = id(5), assetId = id(6);
const at = '2026-10-10T10:00:00.000Z';
const settings = (patch: Obj = {}): Obj => ({ revision: 1, configuration: { ...DEFAULT_IMAGE_CONFIGURATION, enabled: true }, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, ...patch });
const paidInput = (patch: Obj = {}): Obj => ({ projectId, name: '原始图像', prompt: '  原始描述\n不要改写。  ', providerId: 'openai', model: IMAGE_MODELS.openai, options: { ...IMAGE_FIXED_OPTIONS }, requestId: id(60), ...patch });
const review = (input: Obj = paidInput(), patch: Obj = {}): Obj => ({ id: id(70), projectId: input.projectId, requestId: input.requestId, input, inputHash: createHash('sha256').update(canonicalImageInput(input as never)).digest('hex'), settingsRevision: 1, destination: IMAGE_REVIEW_DESTINATION, policy: { ...IMAGE_REVIEW_POLICY }, state: 'pending', revision: 1, taskId: null, postAttempts: 0, createdAt: at, updatedAt: at, approvedAt: null, rejectedAt: null, dispatchedAt: null, ...patch });
const task = (patch: Obj = {}): Obj => ({ id: taskId, projectId, groupId, requestId, name: '测试图像', prompt: '清晨的山间小屋', providerId: 'mock', model: IMAGE_MODELS.mock, options: { ...IMAGE_FIXED_OPTIONS }, state: 'queued', revision: 1, dispatched: false, versionId: null, errorCode: null, createdAt: at, updatedAt: at, ...patch });
const group = (patch: Obj = {}): Obj => ({ id: groupId, projectId, name: '测试图像', revision: 1, headVersionId: null, activeTaskId: taskId, createdAt: at, updatedAt: at, ...patch });
const version = (patch: Obj = {}): Obj => ({ id: versionId, projectId, groupId, taskId, number: 1, assetId, sha256: 'a'.repeat(64), mimeType: 'image/png', width: 1024, height: 1024, byteLength: 3400, isMock: true, providerId: 'mock', model: IMAGE_MODELS.mock, options: { ...IMAGE_FIXED_OPTIONS }, createdAt: at, ...patch });
const page = (items: unknown[], nextCursor: unknown = null): Obj => ({ projectId, items, nextCursor });
interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void }
const deferred = <T = Obj>(): Deferred<T> => { let resolve: (value: T) => void = () => undefined, reject: (reason?: unknown) => void = () => undefined; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async (): Promise<void> => { for (let n = 0; n < 120; n++) await Promise.resolve(); };
const error = (code = 'NETWORK', details?: unknown): ApiError => new ApiError('NEVER SHOW private provider text', code, details, Boolean(details));
interface MemoryStorage { data: Map<string, unknown>; getItem(key: string): unknown; setItem(key: string, value: unknown): void; removeItem(key: string): boolean }
function memoryStorage(): MemoryStorage { const data = new Map<string, unknown>(); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: unknown): void => {data.set(key, value);}, removeItem: (key: string): boolean => data.delete(key) }; }
interface InputView extends Obj {
  projectId?: string; requestId?: string; groupId?: string; taskId?: string; reviewId?: string;
  limit?: number; settingsRevision?: number; input?: Obj; expectedRevision?: number; state?: unknown;
  name?: string; prompt?: string; providerId?: string; options?: Obj; id?: string; operation?: string;
}
interface EntityView extends Obj {
  id?: string; projectId?: string; groupId?: string; taskId?: string; requestId?: string; state?: string;
  revision?: number; activeTaskId?: string | null; headVersionId?: string | null; versionId?: string | null;
  name?: string; prompt?: string; providerId?: string; model?: string; options?: Obj; createdAt?: string; updatedAt?: string;
  assetId?: string; dispatched?: boolean; approvedAt?: string | null; rejectedAt?: string | null; settingsRevision?: number;
}
interface DataStore { groups: EntityView[]; tasks: EntityView[]; versions: EntityView[]; reviews: EntityView[]; receipts: Map<string, unknown> }
type AcceptFn = (input: Obj) => Obj;
type ApiFn = (operation: string, input: InputView, data: DataStore) => unknown;
type ApproveFn = (value: EntityView & {input?: Obj}, data: DataStore, accept: AcceptFn) => unknown;
type RejectFn = (value: EntityView & {input?: Obj}, data: DataStore) => unknown;
interface FixtureOptions {
  storage?: MemoryStorage; groups?: Obj[]; tasks?: Obj[]; versions?: Obj[]; reviews?: Obj[];
  api?: ApiFn; approve?: ApproveFn; reject?: RejectFn; settings?: Obj; customSettings?: Obj; session?: Record<string, unknown>;
}
interface Fixture {
  session: ReturnType<typeof createImageGenerationSession>; api: ApiFn; reviewClient: Record<string, unknown>;
  settingsClient: Record<string, unknown>; customSettingsClient: Record<string, unknown>;
  privateCalls: Obj[]; calls: Array<{operation: string; input: unknown}>; data: DataStore; storage: MemoryStorage;
  changes: Obj[]; notifications: unknown[][]; timers: Map<number, () => void>;
  keyCount(): number; tick(): Promise<boolean>;
}
function fixture(options: FixtureOptions = {}): Fixture {
  const calls: Array<{operation: string; input: unknown}> = [], privateCalls: Obj[] = [], changes: Obj[] = [], notifications: unknown[][] = [], timers = new Map<number, () => void>(), storage = options.storage || memoryStorage();
  let sequence = 0, keys = 0;
  const data: DataStore = { groups: options.groups || [], tasks: options.tasks || [], versions: options.versions || [], reviews: options.reviews || [], receipts: new Map() };
  function accept(input: Obj): Obj {
    const result = task({ ...input, id: data.tasks.length ? id(30 + data.tasks.length) : taskId, groupId: input.groupId || groupId });
    delete result.expectedRevision;
    data.tasks = [result, ...data.tasks]; data.groups = [group({ id: result.groupId, name: result.name, revision: input.expectedRevision ? (input.expectedRevision as number) + 1 : 1, activeTaskId: result.id })];
    data.receipts.set(String(input.requestId), { projectId, requestId: input.requestId, operation: 'image.generate', response: structuredClone(result) }); return result;
  }
  const api: ApiFn = async (operation: string, input: InputView): Promise<unknown> => {
    calls.push({ operation, input: structuredClone(input) });
    if (options.api) { const response = await options.api(operation, input, data); if (response !== undefined) return response; }
    if (operation === 'image.group.list') return page(data.groups.slice(0, input.limit as number));
    if (operation === 'image.group.get') return data.groups.find(item => item.id === input.groupId);
    if (operation === 'image.task.list') return page(data.tasks.filter(item => !input.groupId || item.groupId === input.groupId).slice(0, input.limit as number));
    if (operation === 'image.version.list') return page(data.versions.filter(item => item.groupId === input.groupId).slice(0, input.limit as number));
    if (operation === 'image.request.get') return data.receipts.get(String(input.requestId)) || null;
    if (operation === 'image.task.get') return data.tasks.find(item => item.id === input.taskId);
    if (operation === 'image.review.prepare') { const result = review(input.input as Obj, { settingsRevision: input.settingsRevision }); data.reviews.unshift(result); return result; }
    if (operation === 'image.review.get') return data.reviews.find(item => item.id === input.reviewId);
    if (operation === 'image.review.list') return page(data.reviews.slice(0, input.limit as number));
    if (operation === 'image.generate') return accept(input);
    if (['image.task.cancelQueued', 'image.task.recoverResult'].includes(operation)) {
      const original = data.tasks.find(item => item.id === input.taskId)!, result = { ...original, state: operation.endsWith('cancelQueued') ? 'cancelled_before_dispatch' : 'persisting', revision: (original.revision as number) + 1 };
      data.tasks = [result]; data.groups = [group({ activeTaskId: operation.endsWith('cancelQueued') ? null : taskId })];
      data.receipts.set(String(input.requestId), { projectId, requestId: input.requestId, operation, response: structuredClone(result) }); return result;
    }
    throw error('UNSUPPORTED');
  };
  const reviewClient = { async approve(value: EntityView & {input?: Obj}): Promise<unknown> { privateCalls.push({ action: 'approve', review: structuredClone(value) }); if (options.approve) return options.approve(value, data, accept); const result = accept(value.input as Obj); data.reviews = data.reviews.map(item => item.id === value.id ? { ...item, state: 'approved', revision: 2, taskId: result.id, approvedAt: at } : item); return result; }, async reject(value: EntityView & {input?: Obj}): Promise<unknown> { privateCalls.push({ action: 'reject', review: structuredClone(value) }); if (options.reject) return options.reject(value, data); const result = { ...value, state: 'rejected', revision: 2, rejectedAt: at }; data.reviews = data.reviews.map(item => item.id === value.id ? result : item); return result; } };
  const settingsClient = { read: async () => options.settings || settings({ configuration: { ...DEFAULT_IMAGE_CONFIGURATION } }) }, customSettingsClient = { read: async () => options.customSettings || settings({ revision: 0, configuration: { ...DEFAULT_CUSTOM_IMAGE_CONFIGURATION }, secret: { configured: false, storage: 'none' } }) };
  const session = createImageGenerationSession({ projectId, api: api as never, storage: storage as never, reviewClient: reviewClient as never, settings: options.settings as never, customSettings: options.customSettings as never, requestId: () => { keys++; return keys === 1 && !data.tasks.some(item => item.requestId === requestId) ? requestId : id(40 + keys); }, onChange: (next: Obj) => {changes.push(next);}, onGenerated: (...args: unknown[]) => {notifications.push(args);}, setTimer: (fn: () => void) => {const key = ++sequence; timers.set(key, fn); return key;}, clearTimer: (key: number) => {timers.delete(key);}, ...(options.session as never) });
  return { session, api, reviewClient, settingsClient, customSettingsClient, privateCalls, calls, data, storage, changes, notifications, timers, keyCount: () => keys, async tick(): Promise<boolean> { const [key, fn] = timers.entries().next().value || [undefined, undefined]; if (!fn) return false; timers.delete(key); fn(); await flush(); return true; } };
}
async function ready(f: Fixture): Promise<void> { await f.session.load(); f.session.edit('name', '测试图像'); f.session.edit('prompt', '清晨的山间小屋'); }
const mutations = (f: Fixture) => f.calls.filter(call => ['image.generate', 'image.task.cancelQueued', 'image.task.recoverResult'].includes(call.operation));

test('fixed Mock intent is persisted and verified before one explicit dispatch', async () => {
  const storage = memoryStorage(); let savedBeforeDispatch = false;
  const f = fixture({ storage, api: (operation, input) => { if (operation === 'image.generate') savedBeforeDispatch = [...storage.data.values()].some(value => JSON.parse(value).input.requestId === input.requestId); } });
  await ready(f); assert.equal(imageCanGenerate(f.session.getState()), true); assert.equal(await f.session.generate(), true);
  assert.equal(savedBeforeDispatch, true); assert.equal(mutations(f).length, 1);
  assert.deepEqual(mutations(f)[0].input, { projectId, name: '测试图像', prompt: '清晨的山间小屋', providerId: 'mock', model: IMAGE_MODELS.mock, options: IMAGE_FIXED_OPTIONS, requestId });
  assert.equal(f.storage.data.size, 0); assert.equal(imageDraftDirty(f.session.getState()), false); f.session.dispose();
});

test('storage failure and silent storage discard fail before dispatch', async () => {
  for (const setItem of [() => { throw error(); }, () => {}]) {
    const f = fixture({ storage: { getItem: () => null, setItem, removeItem() {} } }); await ready(f);
    assert.equal(await f.session.generate(), false); assert.equal(mutations(f).length, 0); assert.match(f.session.getState().message, /尚未发送/); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋'); f.session.dispose();
  }
});

test('lost acknowledgement remains unknown across renderer recreation and null lookup never resends', async () => {
  const storage = memoryStorage(), f = fixture({ storage, api: operation => { if (operation === 'image.generate') throw error(); } });
  await ready(f); await f.session.generate(); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(await f.session.generate(), false); f.session.dispose();
  const g = fixture({ storage }); await g.session.load(); assert.equal(g.session.getState().pending.input.requestId, requestId); assert.equal(await g.session.generate(), false); assert.equal(g.keyCount(), 0); assert.equal(mutations(g).length, 0); assert.match(g.session.getState().message, /不能证明/); g.session.dispose();
});

test('historical receipt is followed by authoritative task get and never downgrades current success', async () => {
  const f = fixture({ api: (operation, input, data) => { if (operation === 'image.generate') { data.groups = [group({ activeTaskId: null, headVersionId: versionId })]; data.tasks = [task({ state: 'succeeded', dispatched: true, revision: 4, versionId })]; data.versions = [version()]; data.receipts.set(input.requestId, { projectId, requestId, operation, response: task() }); throw error(); } } });
  await ready(f); await f.session.generate(); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().tasks[0].revision, 4); assert.equal(f.session.getState().versions[0].assetId, assetId); assert.equal(f.notifications.length, 1); assert.equal(mutations(f).length, 1);
  const requestIndex = f.calls.findIndex(call => call.operation === 'image.request.get'); assert.equal(f.calls[requestIndex + 1].operation, 'image.task.get'); await f.session.load(); assert.equal(f.notifications.length, 1); f.session.dispose();
});

test('forged receipt operation, scope, payload or regressed task cannot clear pending', async () => {
  for (const mismatch of ['operation', 'scope', 'payload', 'task']) {
    const f = fixture({ api: (operation, input, data) => {
      if (operation === 'image.generate') { data.tasks = [task()]; throw error(); }
      if (operation === 'image.request.get') return { projectId: mismatch === 'scope' ? id(99) : projectId, requestId, operation: mismatch === 'operation' ? 'image.task.cancelQueued' : 'image.generate', response: task({ ...(mismatch === 'payload' ? { prompt: 'Changed input' } : {}) }) };
      if (operation === 'image.task.get' && mismatch === 'task') return task({ id: id(99) });
    } }); await ready(f); await f.session.generate(); assert.notEqual(f.session.getState().pending, null, mismatch); assert.equal(f.storage.data.size, 1); assert.equal(mutations(f).length, 1); f.session.dispose();
  }
});

test('only an exact operation, project, request and input-hash rejection proof releases the intent', async () => {
  for (const mismatch of [null, 'operation', 'projectId', 'requestId', 'inputHash']) {
    const f = fixture({ api: (operation, input) => {
      if (operation !== 'image.generate') return;
      const proof = { status: 'not_accepted', projectId, operation, requestId: input.requestId, inputHash: createHash('sha256').update(canonicalImageInput(input)).digest('hex') };
      if (mismatch) proof[mismatch] = mismatch === 'inputHash' ? '0'.repeat(64) : 'wrong-owner';
      throw error('IMAGE_GROUP_BUSY', { imageOutcome: proof });
    } }); await ready(f); await f.session.generate(); assert.equal(Boolean(f.session.getState().pending), Boolean(mismatch), String(mismatch)); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋'); assert.equal(mutations(f).length, 1); assert.doesNotMatch(f.session.getState().message, /private provider/); f.session.dispose();
  }
});

test('timed out submission retains exact request and never automatically retries', async () => {
  const held = deferred(), f = fixture({ api: operation => operation === 'image.generate' ? held.promise : undefined, session: { timeoutMs: 10 } }); await ready(f); await f.session.generate();
  assert.equal(f.session.getState().pending.input.requestId, requestId); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(mutations(f).length, 1); held.resolve(task()); await flush(); assert.equal(f.session.getState().phase, 'unknown'); f.session.dispose();
});

test('507 capacity proof clears a rejected intent while arbitrary server errors stay unknown', async () => {
  for (const code of ['IMAGE_CAPACITY', 'UNKNOWN_SERVER_FAILURE']) {
    const f = fixture({ api: (operation, input) => {
      if (operation !== 'image.generate') return;
      throw new ApiError('private server error', code, { imageOutcome: { status: 'not_accepted', projectId, operation, requestId, inputHash: createHash('sha256').update(canonicalImageInput(input)).digest('hex') } }, false);
    } }); await ready(f); await f.session.generate(); assert.equal(Boolean(f.session.getState().pending), code !== 'IMAGE_CAPACITY'); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋'); assert.equal(mutations(f).length, 1); f.session.dispose();
  }
});

test('late read and acknowledgement from disposed project cannot change state, receipt or callbacks', async () => {
  const held = deferred(), f = fixture({ api: operation => operation === 'image.generate' ? held.promise : undefined }); await ready(f); const sending = f.session.generate(); await flush(); const count = f.changes.length;
  f.session.dispose(); const stored = [...f.storage.data.values()][0]; held.resolve(task()); await sending;
  assert.equal(f.changes.length, count); assert.equal([...f.storage.data.values()][0], stored); assert.equal(f.notifications.length, 0);
  const reading = deferred(), g = fixture({ api: operation => operation === 'image.group.list' ? reading.promise : undefined }); const loading = g.session.load(); g.session.dispose(); reading.resolve(page([group()])); await loading; assert.equal(g.session.getState().groups.length, 0);
});

test('double click dispatches once, hidden panels keep draft and only visible reads poll with bounded budget', async () => {
  const held = deferred(), f = fixture({ api: operation => operation === 'image.generate' ? held.promise : undefined }); await ready(f); const sending = f.session.generate(); assert.equal(await f.session.generate(), false); await flush(); assert.equal(mutations(f).length, 1); f.session.setVisible(false); held.resolve(task()); await sending; assert.equal(f.timers.size, 0); f.session.dispose();
  const g = fixture({ groups: [group()], tasks: [task()], session: { pollLimit: 2 } }); await ready(g); g.session.setVisible(false); assert.equal(g.session.getState().draft.prompt, '清晨的山间小屋'); assert.equal(await g.session.generate(), false); assert.equal(g.timers.size, 0);
  g.session.setVisible(true); await flush(); assert.equal(await g.tick(), true); assert.equal(await g.tick(), true); assert.equal(g.timers.size, 0); assert.equal(g.session.getState().pollPaused, true); assert.equal(mutations(g).length, 0); g.session.dispose();
});

test('interrupted and queued tasks cancel explicitly; local-result recovery never calls generate', async () => {
  for (const state of ['queued', 'interrupted_before_dispatch']) {
    const f = fixture({ groups: [group()], tasks: [task({ state })] }); await f.session.load(); const saved = f.session.getState().tasks[0]; await f.session.act('cancelQueued', saved); assert.equal(f.session.getState().tasks[0].state, 'cancelled_before_dispatch'); assert.equal(mutations(f)[0].operation, 'image.task.cancelQueued'); assert.equal(await f.session.act('cancelQueued', saved), false); f.session.dispose();
  }
  const g = fixture({ groups: [group()], tasks: [task({ state: 'local_result_error', dispatched: true, revision: 3 })] }); await g.session.load(); await g.session.act('recoverResult', g.session.getState().tasks[0]); assert.equal(mutations(g)[0].operation, 'image.task.recoverResult'); assert.equal(g.session.getState().tasks[0].state, 'persisting'); assert.equal(mutations(g).length, 1); g.session.dispose();
  const h = fixture({ groups: [group()], tasks: [task({ state: 'outcome_unknown', dispatched: true })] }); await h.session.load(); assert.equal(await h.session.act('cancelQueued', h.session.getState().tasks[0]), false); assert.equal(mutations(h).length, 0); await h.session.act('recoverResult', h.session.getState().tasks[0]); assert.equal(mutations(h).length, 1); assert.equal(mutations(h)[0].operation, 'image.task.recoverResult'); h.session.dispose();
});

test('new-version target requires explicit draft discard, preserves immutable name and binds base revision', async () => {
  const f = fixture({ groups: [group({ activeTaskId: null, revision: 7, headVersionId: versionId })], tasks: [task({ state: 'succeeded', dispatched: true, revision: 4, versionId })], versions: [version()] }); await ready(f);
  await f.session.requestTarget(groupId); assert.equal(f.session.getState().target, null); assert.deepEqual(f.session.getState().targetRequest, { groupId }); f.session.keepDraft(); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋');
  await f.session.requestTarget(groupId); await f.session.confirmTarget(); assert.deepEqual(f.session.getState().target, { groupId, expectedRevision: 7 }); assert.equal(f.session.edit('name', 'Renamed'), false); assert.equal(f.session.edit('prompt', '第二张图像'), true); assert.equal(mutations(f).length, 0);
  await f.session.generate(); const input = mutations(f)[0].input; assert.equal(input.groupId, groupId); assert.equal(input.expectedRevision, 7); assert.equal(input.name, '测试图像'); assert.equal(input.prompt, '第二张图像'); f.session.dispose();
});

test('accepted group omitted from first page is resolved by identity and remains selected with its task', async () => {
  const unrelated = group({ id: id(80), name: 'Unrelated', activeTaskId: null });
  const f = fixture({ api: (operation, input, data) => { if (operation === 'image.group.list' && data.tasks.length) return page([unrelated]); } }); await ready(f); await f.session.generate();
  assert.equal(f.session.getState().selectedGroupId, groupId); assert.equal(f.session.getState().tasks[0].id, taskId); assert.ok(f.calls.some(call => call.operation === 'image.group.get' && call.input.groupId === groupId)); assert.equal(f.timers.size, 1); f.session.dispose();
});

test('same-project stale list cannot downgrade a newer mutation acknowledgement', async () => {
  const held = deferred(); let hold = false;
  const f = fixture({ api: operation => operation === 'image.group.list' && hold ? held.promise : undefined }); await ready(f); hold = true; const reading = f.session.load(); await flush(); const generating = f.session.generate(); await flush(); hold = false; held.resolve(page([])); await reading; await generating;
  assert.equal(mutations(f).length, 1); assert.equal(f.session.getState().tasks[0].id, taskId); f.session.dispose();
});

test('completion is observed before rereading current group and immutable result page', async () => {
  const f = fixture({ groups: [group({ activeTaskId: null, headVersionId: versionId, revision: 2 })], tasks: [task({ state: 'succeeded', dispatched: true, revision: 4, versionId })], versions: [version()], api: operation => operation === 'image.group.list' ? page([group()]) : undefined });
  await f.session.load(); assert.equal(f.session.getState().groups[0].activeTaskId, null); assert.equal(f.session.getState().groups[0].revision, 2); assert.equal(f.session.getState().versions[0].id, versionId);
  const names = f.calls.map(call => call.operation); assert.ok(names.indexOf('image.task.list') < names.indexOf('image.group.get')); assert.ok(names.indexOf('image.group.get') < names.indexOf('image.version.list')); f.session.dispose();
});

test('actual library reveal respects newer project, navigation and panel choices while refresh is pending', async () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  async function revealImageAsset('), end = app.indexOf('  async function selectProject(', start);
  assert.ok(start > 0 && end > start); const source = app.slice(start, end).trim();
  for (const changed of [null, 'projectEpoch', 'navigationEpoch', 'panelIntent', 'currentProject']) {
    const held = deferred(), calls = [];
    const env = { currentProject: { current: projectId }, projectEpoch: { current: 1 }, navigationEpoch: { current: 1 }, panelIntent: { current: 1 }, dataRef: { current: { assets: [] } }, refresh: () => held.promise, updateView: (...args) => calls.push(['view', ...args]), setPanelOpen: (...args) => calls.push(['panel', ...args]), setMobilePanel: value => calls.push(['mobile', value]) };
    const reveal = Function(...Object.keys(env), `return (${source});`)(...Object.values(env));
    const reading = reveal(assetId, projectId); if (changed) env[changed].current = changed === 'currentProject' ? id(90) : 2;
    held.resolve({ assets: [{ id: assetId, name: 'Saved image' }] }); await reading;
    assert.equal(calls.length, changed ? 0 : 3, String(changed));
    if (!changed) assert.deepEqual(calls[0], ['view', 'shared', { assetSearch: 'Saved image', assetFilter: 'all' }]);
  }
  assert.match(app, /<Dialog open=\{showImage\}/);
  assert.match(app, /<AgentDockPane id="right-dock-image"[^>]*visible=\{showImage\}/);
  assert.match(app, /setShowTasks\(false\); setShowDelivery\(false\); setShowImage\(true\)/);
  assert.doesNotMatch(app, /rightDockTab === 'image'/);
  assert.doesNotMatch(source, /node\.create|setPreviewAsset|image\.generate/);
  assert.doesNotThrow(() => transformSync(app, { loader: 'tsx', format: 'esm' }));
});

test('input limits match contract and state copy distinguishes unknown, failure, cancellation and local failure', () => {
  assert.equal(imageInputIssue({ name: '有效', prompt: '正常\n\t内容' }), '');
  for (const prompt of [' ', 'x'.repeat(2001), 'x\u0000y']) assert.notEqual(imageInputIssue({ name: '有效', prompt }), '');
  assert.equal(new Set(['outcome_unknown', 'failed', 'cancelled_before_dispatch', 'local_result_error', 'interrupted_before_dispatch'].map(imageTaskLabel)).size, 5);
});

test('renderer remains an extracted dock with explicit providers, fixed paid disclosure and local previews', () => {
  const source = readFileSync(new URL('../apps/web/src/ImageGeneration.tsx', import.meta.url), 'utf8');
  assert.doesNotThrow(() => transformSync(source, { loader: 'tsx', format: 'esm' }));
  const displayCopy = source + Object.entries(creationUiMessages).filter(([key]) => source.includes(`'${key}'`)).map(([, value]) => JSON.stringify(value['zh-Hans'])).join('\n');
  for (const text of ['useWorkspaceVisibility', 'image-provider-openai', '真实调用尚未验证', '确定性测试图案', '未加密', 'image-paid-warning', 'image-review-approve', 'image-review-reject', 'image-draft-guard', 'image-edit-version', 'image-version-preview', 'image-reveal-asset', 'image-cancel-queued', 'image-recover-result']) assert.ok(displayCopy.includes(text), text);
  assert.match(source, /composerVisible \? `\/media\/\$\{encodeURIComponent\(version.assetId\)\}` : undefined/);
  assert.doesNotMatch(source, /type="password"|Dialog|dangerouslySetInnerHTML|node\.create|shot\.attach/);
  assert.match(source, /disabled=\{busy \|\| Boolean\(state.target\)\}/);
});

const componentSource = readFileSync(new URL('../apps/web/src/ImageGeneration.tsx', import.meta.url), 'utf8');
type EventHandler = (...args: unknown[]) => unknown;
type UiNode = {type?: unknown; props: Obj & {children?: unknown; ref: {current: {value: string}}; onChange: EventHandler; onClick: EventHandler; onSubmit: EventHandler}};
const element = (type: unknown, props: Obj | null = {}, ...children: unknown[]): UiNode => ({type, props: {...(props ?? {}), children: children.length === 1 ? children[0] : children} as UiNode['props']});
const nodes = (tree: unknown): UiNode[] => Array.isArray(tree) ? tree.flatMap((item: unknown) => nodes(item)) : tree !== null && typeof tree === 'object' && 'props' in tree ? [tree as UiNode, ...nodes((tree as UiNode).props.children)] : [];
const depsEqual = (left: unknown, right: unknown): boolean => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value: unknown, index: number) => Object.is(value, right[index]));
interface RenderOptions { languageStore?: unknown; projectAssets?: Obj[]; editIntent?: unknown; isEditIntentCurrent?: unknown; onRevealAsset?: unknown }
interface RenderSlot { [key: string]: unknown; value?: unknown; deps?: unknown; callback?: () => unknown; cleanup?: unknown }
interface Harness {
  render(owner?: string): UiNode; find(id: string): UiNode; form(): UiNode;
  change(id: string, value: unknown): void; click(id: string): void;
  settings(slot?: string): UiNode | undefined; show(value: boolean): void;
  readonly dirty: boolean; unmount(): void;
}
function renderer(f: Fixture, options: RenderOptions = {}): Harness {
  const slots: RenderSlot[] = []; let index = 0; let effects: number[] = []; let visible = true; let tree!: UiNode;
  let currentProject = projectId; let dirty = false;
  const react: Obj & {default?: Obj} = {
    createElement: (type: unknown, props: Obj | null, ...children: unknown[]): UiNode => type === 'SettingsNavigationSlot' ? (children[0] as (register: () => void) => UiNode)(() => {}) : element(type, props, ...children),
    useState(initial: unknown) {
      const slot = index++; slots[slot] ||= {value: typeof initial === 'function' ? (initial as () => unknown)() : initial};
      const state = slots[slot];
      return [state.value, (value: unknown) => {state.value = typeof value === 'function' ? (value as (current: unknown) => unknown)(state.value) : value;}] as const;
    },
    useRef(initial: unknown) { return slots[index++] ||= {current: initial}; },
    useMemo(callback: () => unknown, deps?: unknown) {
      const slot = index++, existing = slots[slot];
      if (!existing || !depsEqual(deps, existing.deps)) slots[slot] = {value: callback(), deps};
      return slots[slot].value;
    },
    useLayoutEffect(callback: () => unknown, deps?: unknown) {
      const slot = index++, old = slots[slot];
      if (old && depsEqual(deps, old.deps)) return;
      slots[slot] = {callback, deps, cleanup: old?.cleanup}; effects.push(slot);
    },
  };
  react.default = react;
  const module: {exports: Obj} = {exports: {}}, primitive = new Proxy<Obj>({}, {get: (_target, key) => String(key)});
  const require = (name: string): unknown => {
    const i18nDependency = creationTestDependency(name, options.languageStore); if (i18nDependency) return i18nDependency;
    if (name === './native-close-sources.ts') return nativeCloseSources;
    if (name === './editor-settings-scope.ts') {
      const settingsModule: {exports: Obj} = {exports: {}};
      const code = transformSync(readFileSync(new URL('../apps/web/src/editor-settings-scope.ts', import.meta.url), 'utf8'), {loader: 'ts', format: 'cjs'}).code;
      Function('module', 'exports', 'require', code)(settingsModule, settingsModule.exports, (dependency: string) => {assert.equal(dependency, 'react'); return react;});
      return settingsModule.exports;
    }
    if (name === 'react') return react;
    if (name === '@mioon/contracts') return {IMAGE_LIMITS};
    if (name === './image-generation.ts') return {...imageLogic, createImageGenerationSession: (value: Obj) => createImageGenerationSession({...value, api: f.api as never, storage: f.storage as never, requestId: () => requestId, setTimer: () => 1, clearTimer() {}} as never)};
    if (name === './image-edit-intent.ts') return imageEditIntents;
    if (name === './workspace-visibility.tsx') return {useWorkspaceVisibility: () => visible};
    if (name === './ComfyImageSettings.tsx') return {__esModule: true, default: 'ComfyImageSettings'};
    if (name === './ComfyImageDetails.tsx') return {ComfyImageReviewDetails: 'ComfyImageReviewDetails', ComfyImageTaskDetails: 'ComfyImageTaskDetails'};
    if (name === './comfy-image-settings.ts') return {comfyConnectorAvailabilityDescriptor, createComfyImageSettingsClient: () => ({read: async () => null})};
    if (name === './SettingsNavigationSlot.tsx') return {__esModule: true, default: 'SettingsNavigationSlot'};
    if (name === './ImageSettings.tsx') return {__esModule: true, default: 'ImageSettings'};
    if (name === './image-settings.ts') return {createImageSettingsClient: (value: {slot?: string}) => value?.slot === 'custom' ? f.customSettingsClient : f.settingsClient};
    if (name === './icons.tsx') return {default: 'Icon'};
    if (name === './image-generation.css') return {};
    if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.tsx') return primitive;
    throw Error(name);
  };
  Function('module', 'exports', 'require', transformSync(componentSource, {loader: 'tsx', format: 'cjs'}).code)(module, module.exports, require);
  const renderComponent = module.exports.default as (props: Obj) => UiNode;
  const harness: Harness = {
    render(owner: string = currentProject): UiNode {
      currentProject = owner; index = 0; effects = [];
      tree = renderComponent({projectId: owner, projectName: 'Test project', reviewClient: f.reviewClient, settingsClient: f.settingsClient, customSettingsClient: f.customSettingsClient, onDirtyChange: (value: unknown) => {dirty = value === true;}, onRevealAsset: options.onRevealAsset, projectAssets: options.projectAssets || [], editIntent: options.editIntent || null, isEditIntentCurrent: options.isEditIntentCurrent});
      for (const slot of effects) {slots[slot].cleanup = (slots[slot].callback as () => unknown)();}
      return tree;
    },
    find(idValue: string): UiNode { const value = nodes(tree).find(node => node.props['data-testid'] === idValue); assert.ok(value, idValue); return value; },
    form(): UiNode { const value = nodes(tree).find(node => node.type === 'form'); assert.ok(value, 'form'); return value; },
    change(idValue: string, value: unknown): void {(harness.find(idValue).props.onChange as EventHandler)({target: {value}}); harness.render();},
    click(idValue: string): void {(harness.find(idValue).props.onClick as EventHandler)(); harness.render();},
    settings(slot = 'official'): UiNode | undefined { return nodes(tree).find(node => node.type === 'ImageSettings' && node.props.slot === slot); },
    show(value: boolean): void {visible = value; harness.render();},
    get dirty(): boolean {return dirty;},
    unmount(): void {for (const slot of slots) if (typeof slot.cleanup === 'function') (slot.cleanup as () => void)();},
  };
  return harness;
}

test('actual composer keeps draft across hidden tabs and invalidates old edit/submit handlers after reveal', async () => {
  const f = fixture(), ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-generation-name', '保留名称'); ui.change('image-generation-prompt', '保留描述'); assert.equal(ui.dirty, true);
  const edit = ui.find('image-generation-prompt').props.onChange, submit = ui.form().props.onSubmit;
  ui.show(false); assert.equal(ui.find('image-generation-page').props.inert, true); assert.equal(ui.find('image-generate').props.disabled, true); edit({ target: { value: '旧回调' } }); submit({ preventDefault() {} });
  ui.show(true); await flush(); ui.render(); edit({ target: { value: '仍是旧回调' } }); submit({ preventDefault() {} }); ui.render(); assert.equal(ui.find('image-generation-prompt').props.value, '保留描述'); assert.equal(mutations(f).length, 0); ui.unmount(); f.session.dispose();
});

test('actual composer fences project navigation and current submit uses only typed image fields', async () => {
  const f = fixture(), ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-generation-name', '测试图像'); ui.change('image-generation-prompt', '清晨的山间小屋');
  const oldEdit = ui.find('image-generation-prompt').props.onChange, oldSubmit = ui.form().props.onSubmit; oldSubmit({ preventDefault() {} }); await flush(); ui.render(); assert.equal(mutations(f).length, 1);
  ui.render(id(90)); await flush(); ui.render(); oldEdit({ target: { value: 'Wrong project' } }); oldSubmit({ preventDefault() {} }); ui.render(); assert.equal(ui.find('image-generation-prompt').props.value, ''); assert.equal(ui.find('image-generation-page').props['data-project-id'], id(90)); assert.equal(mutations(f).length, 1); ui.unmount(); f.session.dispose();
});

test('paid generation saves the exact visible prompt before preparation and sends only one private approval', async () => {
  const f = fixture({ settings: settings(), api: (operation, input) => { if (operation === 'image.review.prepare') { const saved = JSON.parse([...f.storage.data.values()][0]); assert.deepEqual(saved.input, input.input); assert.equal(saved.approvalAttempted, false); } }, approve: (value, data, accept) => { const saved = JSON.parse([...f.storage.data.values()][0]); assert.equal(saved.approvalAttempted, true); assert.equal(saved.reviewId, value.id); return accept(value.input); } });
  await ready(f); f.session.edit('prompt', '  光线\n原文，不优化。  '); f.session.selectProvider('openai');
  assert.equal(await f.session.generate(), false); assert.equal(await f.session.generatePaid(), true);
  assert.equal(f.privateCalls.length, 1); assert.equal(f.privateCalls[0].review.input.prompt, '  光线\n原文，不优化。  '); assert.equal(f.privateCalls[0].review.settingsRevision, 1);
  assert.equal(mutations(f).length, 0); assert.equal(f.calls.filter(call => call.operation === 'image.review.prepare').length, 1); assert.equal(f.storage.data.size, 0); f.session.dispose();
});

test('hide and reveal during preparation never auto-approves; explicit approval uses the original review', async () => {
  const held = deferred(); let original;
  const f = fixture({ settings: settings(), api: (operation, input, data) => { if (operation === 'image.review.prepare') { original = review(input.input); data.reviews = [original]; return held.promise; } } });
  await ready(f); f.session.selectProvider('openai'); const sending = f.session.generatePaid(); await flush(); f.session.setVisible(false); f.session.setVisible(true); held.resolve(original); await sending;
  assert.equal(f.privateCalls.length, 0); assert.equal(f.session.getState().pending.approvalAttempted, false); assert.equal(f.session.edit('prompt', 'changed'), false);
  await f.session.load(); assert.equal(f.privateCalls.length, 0); assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), true); assert.equal(f.privateCalls.length, 1); assert.deepEqual(f.privateCalls[0].review.input, original.input); f.session.dispose();
});

test('configuration changes during preparation keep original review stale and cannot authorize a new configuration', async () => {
  const held = deferred(); let original;
  const f = fixture({ settings: settings(), api: (operation, input, data) => { if (operation === 'image.review.prepare') { original = review(input.input); data.reviews = [original]; return held.promise; } } });
  await ready(f); f.session.selectProvider('openai'); const sending = f.session.generatePaid(); await flush(); f.session.setSettings(settings({ revision: 2 })); held.resolve(original); await sending;
  assert.equal(f.privateCalls.length, 0); assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), false); assert.equal(f.session.getState().pending.settingsRevision, 1);
  await f.session.rejectReview(f.session.getState().reviews[0]); assert.equal(f.privateCalls[0].action, 'reject'); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋'); f.session.dispose();
});

test('a changed prepared prompt, provider, destination or settings revision is never privately approved', async () => {
  for (const patch of [{ input: paidInput({ prompt: 'forged' }) }, { destination: 'https://other.example.com' }, { settingsRevision: 2 }]) {
    const f = fixture({ settings: settings(), api: (operation, input) => operation === 'image.review.prepare' ? review(input.input, patch) : undefined }); await ready(f); f.session.selectProvider('openai'); await f.session.generatePaid(); assert.equal(f.privateCalls.length, 0); assert.ok(f.session.getState().pending); f.session.dispose();
  }
});

test('lost paid acknowledgement recovers original task receipt without another approval or generation', async () => {
  const f = fixture({ settings: settings(), approve: (value, data, accept) => { accept(value.input); throw error(); } }); await ready(f); f.session.selectProvider('openai'); await f.session.generatePaid();
  assert.equal(f.session.getState().pending, null); assert.equal(f.privateCalls.length, 1); assert.equal(mutations(f).length, 0); assert.equal(f.session.getState().tasks[0].providerId, 'openai'); await f.session.load(); assert.equal(f.privateCalls.length, 1); f.session.dispose();
});

test('lost approval with no receipt is retained across restart and never repeated by reads', async () => {
  const f = fixture({ settings: settings(), approve: () => { throw error(); } }); await ready(f); f.session.selectProvider('openai'); await f.session.generatePaid(); const pending = f.session.getState().pending, original = f.data.reviews[0]; assert.equal(pending.approvalAttempted, true); f.session.dispose();
  const g = fixture({ settings: settings(), storage: f.storage, reviews: [original] }); await g.session.load(); g.session.setVisible(false); g.session.setVisible(true); await flush(); await g.session.load(); assert.equal(g.privateCalls.length, 0); assert.equal(g.calls.some(call => call.operation === 'image.review.prepare'), false); assert.equal(await g.session.generatePaid(), false); assert.equal(g.keyCount(), 0); assert.deepEqual(g.session.getState().pending.input, pending.input); g.session.dispose();
});

test('external review approval preserves separate composer draft and rejection never generates', async () => {
  const original = review(), f = fixture({ settings: settings(), reviews: [original] }); await ready(f); const draft = f.session.getState().draft;
  assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), true); assert.deepEqual(f.privateCalls[0].review.input, original.input); assert.deepEqual(f.session.getState().draft, draft); assert.equal(mutations(f).length, 0); f.session.dispose();
  const g = fixture({ settings: settings(), reviews: [original] }); await g.session.load(); await g.session.rejectReview(g.session.getState().reviews[0]); assert.deepEqual(g.privateCalls.map(call => call.action), ['reject']); assert.equal(g.session.getState().reviews[0].state, 'rejected'); assert.equal(g.data.tasks.length, 0); assert.equal(g.storage.data.size, 0); g.session.dispose();
});

test('double approval, late project completion and settings-read outage remain safe', async () => {
  const held = deferred(), original = review(), f = fixture({ settings: settings(), reviews: [original], approve: () => held.promise }); await f.session.load(); const approving = f.session.approveReview(original); assert.equal(await f.session.approveReview(original), false); assert.equal(f.privateCalls.length, 1); f.session.dispose(); const stored = [...f.storage.data.values()][0]; held.resolve(task({ ...original.input })); await approving; assert.equal([...f.storage.data.values()][0], stored);
  const g = fixture({ session: { settingsReader: async () => { throw error(); } } }); await ready(g); assert.equal(imageCanGenerate(g.session.getState()), true); await g.session.generate(); assert.equal(mutations(g).length, 1); g.session.dispose();
});

test('actual paid button is the only composer action authorizing payment; settings navigation retains draft', async () => {
  const f = fixture({ settings: settings() }), ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-generation-name', 'Visible title'); ui.change('image-generation-prompt', '  Exact visible prompt  '); ui.click('image-provider-openai');
  assert.equal(ui.find('image-generate').props.type, 'button'); ui.form().props.onSubmit({ preventDefault() {} }); ui.find('image-generation-prompt').props.onKeyDown({ ctrlKey: true, key: 'Enter', preventDefault() {} }); await flush(); assert.equal(f.privateCalls.length, 0);
  const oldPaid = ui.find('image-generate').props.onClick; ui.click('image-settings-open'); oldPaid(); assert.equal(ui.settings().props.active, true); ui.settings().props.onClose(); ui.render(); await flush(); ui.render(); oldPaid(); assert.equal(f.privateCalls.length, 0); assert.equal(ui.find('image-generation-prompt').props.value, '  Exact visible prompt  ');
  ui.click('image-generate'); await flush(); ui.render(); assert.equal(f.privateCalls.length, 1); assert.equal(f.privateCalls[0].review.input.prompt, '  Exact visible prompt  '); ui.unmount(); f.session.dispose();
});

test('exact pending review stays visible when omitted from the current review page', async () => {
  const held = deferred(); let original;
  const f = fixture({ settings: settings(), api: (operation, input, data) => { if (operation === 'image.review.prepare') { original = review(input.input); data.reviews = [original]; return held.promise; } if (operation === 'image.review.list') return page([]); } });
  await ready(f); f.session.selectProvider('openai'); const preparing = f.session.generatePaid(); await flush(); f.session.setVisible(false); held.resolve(original); await preparing; f.session.setVisible(true); await flush(); await f.session.load();
  assert.equal(f.session.getState().reviews.length, 1); assert.equal(f.session.getState().reviews[0].id, original.id); assert.equal(f.privateCalls.length, 0); f.session.dispose();
});

test('valid-shaped altered rejection acknowledgement cannot release an uncertain original request', async () => {
  const f = fixture({ settings: settings(), approve: () => { throw error(); }, reject: value => review({ ...value.input, prompt: 'Changed' }, { id: value.id, state: 'rejected', revision: 2, rejectedAt: at }) });
  await ready(f); f.session.selectProvider('openai'); await f.session.generatePaid(); const pending = f.session.getState().pending;
  assert.equal(await f.session.rejectReview(f.session.getState().reviews[0]), false); assert.deepEqual(f.session.getState().pending, pending); assert.equal(f.storage.data.size, 1); assert.equal(f.session.getState().reviews[0].state, 'pending'); f.session.dispose();
});

const customConfig = (patch = {}) => ({ ...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'https://images.example.com/tenant/v1', model: 'vendor-image-exact', ...patch });
const customSettings = (patch = {}) => settings({ configuration: customConfig(), ...patch });
const customReview = (input = paidInput({ providerId: 'openai-compatible', model: 'vendor-image-exact' }), patch = {}) => review(input, { configuration: customConfig(), destination: 'https://images.example.com/tenant/v1/images/generations', ...patch });
function customFixture(options = {}) {
  return fixture({ ...options, customSettings: options.customSettings || customSettings(), api: async (operation, input, data) => {
    if (options.api) { const result = await options.api(operation, input, data); if (result !== undefined) return result; }
    if (operation === 'image.review.prepare') { const result = customReview(input.input, { settingsRevision: input.settingsRevision }); data.reviews.unshift(result); return result; }
  } });
}

test('custom paid click binds full immutable configuration and resolved destination with no endpoint in typed input', async () => {
  const f = customFixture({ api: (operation, input) => { if (operation === 'image.review.prepare') { const saved = JSON.parse([...f.storage.data.values()][0]); assert.equal(saved.version, 2); assert.deepEqual(saved.configuration, customConfig()); assert.equal(saved.destination, customReview().destination); assert.equal(saved.approvalAttempted, false); assert.deepEqual(Object.keys(input).sort(), ['input', 'settingsRevision']); assert.equal(input.input.baseUrl, undefined); assert.equal(input.input.configuration, undefined); } } });
  await ready(f); f.session.selectProvider('openai-compatible'); f.session.edit('prompt', '  原始自定义描述\n保留。  '); assert.equal(imageCanGenerate(f.session.getState()), true); assert.equal(await f.session.generate(), false); assert.equal(await f.session.generatePaid(), true);
  assert.equal(f.privateCalls.length, 1); assert.equal(f.privateCalls[0].review.input.model, 'vendor-image-exact'); assert.equal(f.privateCalls[0].review.input.prompt, '  原始自定义描述\n保留。  '); assert.deepEqual(f.privateCalls[0].review.configuration, customConfig()); assert.equal(mutations(f).length, 0); assert.equal(f.storage.data.size, 0); f.session.dispose();
});

test('custom paid preparation refuses valid-shaped destination/configuration substitution and never normalizes receipts', async () => {
  for (const baseUrl of ['https://different.example.com/v1', 'https://IMAGES.example.com:443/tenant/v1/']) {
    const f = customFixture({ api: (operation, input) => operation === 'image.review.prepare' ? customReview(input.input, { configuration: customConfig({ baseUrl }), destination: `${baseUrl}/images/generations` }) : undefined });
    await ready(f); f.session.selectProvider('openai-compatible'); await f.session.generatePaid(); assert.equal(f.privateCalls.length, 0); assert.ok(f.session.getState().pending); assert.equal(f.session.getState().pending.configuration.baseUrl, customConfig().baseUrl); f.session.dispose();
  }
});

test('custom preparation hide, slot switch and changed configuration never auto-approve on return', async () => {
  for (const transition of ['hide', 'settings']) {
    const held = deferred(); let original;
    const f = customFixture({ api: (operation, input, data) => { if (operation === 'image.review.prepare') { original = customReview(input.input); data.reviews = [original]; return held.promise; } } });
    await ready(f); f.session.selectProvider('openai-compatible'); const sending = f.session.generatePaid(); await flush();
    if (transition === 'hide') { f.session.setVisible(false); f.session.setVisible(true); } else f.session.setCustomSettings(customSettings({ revision: 2, configuration: customConfig({ baseUrl: 'https://new.example.com/v1' }) }));
    held.resolve(original); await sending; assert.equal(f.privateCalls.length, 0); assert.equal(f.session.getState().pending.approvalAttempted, false); await f.session.load(); assert.equal(f.privateCalls.length, 0);
    if (transition === 'settings') assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), false);
    else { assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), true); assert.equal(f.privateCalls.length, 1); }
    f.session.dispose();
  }
});

test('custom unknown approval survives restart as exact v2 intent and is not reapproved by reads', async () => {
  const f = customFixture({ approve: () => { throw error(); } }); await ready(f); f.session.selectProvider('openai-compatible'); await f.session.generatePaid(); const pending = f.session.getState().pending, original = f.data.reviews[0]; assert.equal(pending.version, 2); assert.equal(pending.approvalAttempted, true); f.session.dispose();
  const g = customFixture({ storage: f.storage, reviews: [original] }); await g.session.load(); g.session.setVisible(false); g.session.setVisible(true); await flush(); await g.session.load(); assert.deepEqual(g.session.getState().pending, pending); assert.equal(g.privateCalls.length, 0); assert.equal(g.calls.some(call => call.operation === 'image.review.prepare'), false); assert.equal(await g.session.generatePaid(), false); g.session.dispose();
  const invalidStorage = memoryStorage(); invalidStorage.setItem(`mioon.image-intent.v1:${projectId}`, JSON.stringify({ ...pending, version: 1 })); const h = customFixture({ storage: invalidStorage }); await h.session.load(); assert.equal(h.session.getState().storageBlocked, true); assert.equal(h.privateCalls.length, 0); h.session.dispose();
});

test('custom lost approval ACK resolves only the retained request without a second paid dispatch', async () => {
  const f = customFixture({ approve: (value, data, accept) => { accept(value.input); throw error(); } }); await ready(f); f.session.selectProvider('openai-compatible'); await f.session.generatePaid(); assert.equal(f.session.getState().pending, null); assert.equal(f.privateCalls.length, 1); assert.equal(f.session.getState().tasks[0].providerId, 'openai-compatible'); await f.session.load(); assert.equal(f.privateCalls.length, 1); assert.equal(mutations(f).length, 0); f.session.dispose();
});

test('historical custom review authority survives advanced task states and current settings outages', async () => {
  const input = paidInput({ providerId: 'openai-compatible', model: 'vendor-image-exact', requestId }), original = customReview(input, { state: 'dispatched', revision: 3, taskId, approvedAt: at, dispatchedAt: at, postAttempts: 1 });
  for (const state of ['dispatching', 'succeeded', 'failed', 'outcome_unknown', 'local_result_error']) {
    const current = task({ ...input, state, dispatched: true, revision: 4, ...(state === 'succeeded' ? { versionId } : {}), ...(state === 'failed' ? { errorCode: 'IMAGE_PROVIDER_ERROR' } : {}) });
    const loaded = { ...imageLogic.initialImageGenerationState(), customSettings: customSettings({ configuration: customConfig({ baseUrl: 'https://current.example.com/v1' }) }), reviews: [original] };
    assert.equal(imageLogic.imageTaskReview(loaded, current)?.destination, original.destination, state); assert.equal(imageLogic.imageTaskReview({ ...loaded, reviews: [] }, current), null); assert.equal(imageLogic.imageTaskReview(loaded, { ...current, prompt: 'changed' }), null);
  }
  const f = customFixture({ reviews: [original], session: { settingsReader: async () => { throw error(); }, customSettingsReader: async () => { throw error(); } } }); await f.session.load(); assert.equal(f.session.getState().customSettings, null); assert.equal(f.session.getState().reviews[0].destination, original.destination); assert.ok(f.calls.some(call => call.operation === 'image.review.list')); f.session.dispose();
});

test('actual custom paid button is explicit, settings slots stay mounted and history never invents a recipient', async () => {
  const f = customFixture(), ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-generation-name', 'Custom visible'); ui.change('image-generation-prompt', 'Exact custom prompt'); ui.click('image-provider-custom');
  assert.equal(ui.find('image-generate').props.type, 'button'); assert.equal(ui.find('image-generate').props.disabled, false); assert.ok(JSON.stringify(ui.find('image-custom-profile')).includes(customReview().destination));
  ui.form().props.onSubmit({ preventDefault() {} }); ui.find('image-generation-prompt').props.onKeyDown({ ctrlKey: true, key: 'Enter', preventDefault() {} }); await flush(); assert.equal(f.privateCalls.length, 0);
  const oldPaid = ui.find('image-generate').props.onClick; ui.click('image-settings-open'); assert.equal(ui.settings('custom').props.active, true); assert.equal(ui.settings('official').props.active, false); assert.notEqual(ui.settings('official').props.client, ui.settings('custom').props.client);
  ui.settings('custom').props.onSelectSlot('official'); ui.render(); assert.equal(ui.settings('official').props.active, true); assert.equal(ui.settings('custom').props.active, false); oldPaid(); assert.equal(f.privateCalls.length, 0);
  ui.settings('official').props.onClose(); ui.render(); await flush(); ui.render(); oldPaid(); assert.equal(f.privateCalls.length, 0); ui.click('image-generate'); await flush(); ui.render(); assert.equal(f.privateCalls.length, 1); assert.equal(f.privateCalls[0].review.destination, customReview().destination); ui.unmount(); f.session.dispose();
});

test('a paid button authorization snapshot cannot authorize later draft or same-revision custom destination changes', async () => {
  for (const change of ['prompt', 'configuration']) {
    const f = customFixture(); await ready(f); f.session.selectProvider('openai-compatible'); const shown = imageLogic.imagePaidAuthorization(f.session.getState());
    if (change === 'prompt') f.session.edit('prompt', 'new prompt'); else f.session.setCustomSettings(customSettings({ configuration: customConfig({ baseUrl: 'https://later.example.com/v1' }) }));
    assert.equal(await f.session.generatePaid(shown), false); assert.equal(f.calls.some(call => call.operation === 'image.review.prepare'), false); assert.equal(f.privateCalls.length, 0); assert.equal(f.storage.data.size, 0); f.session.dispose();
  }
});


test('only allowlisted custom failures proven before dispatch show safe actionable connection explanations', () => {
  const codes = ['IMAGE_NETWORK_DENIED', 'IMAGE_CONNECTION_FAILED', 'IMAGE_TIMEOUT', 'IMAGE_DISPATCH_BLOCKED', 'IMAGE_SETTINGS_CONFLICT', 'IMAGE_SETTINGS_NOT_CONFIGURED', 'IMAGE_SETTINGS_DISABLED'];
  for (const errorCode of codes) {
    const beforePost = task({ providerId: 'openai-compatible', model: 'vendor-image-exact', state: 'failed', dispatched: false, revision: 2, errorCode });
    const text = imageLogic.imageTaskConnectionMessage(beforePost);
    assert.match(text, /本次未发送生成 POST/); assert.match(text, /重新明确批准/); assert.match(text, /不会自动重试/); assert.doesNotMatch(text, /https?:|IMAGE_|密钥值|免费|不收费/);
    for (const patch of [{ providerId: 'openai', model: IMAGE_MODELS.openai }, { dispatched: true }, { state: 'outcome_unknown', dispatched: true }, { state: 'queued' }, { errorCode: 'RAW_PROVIDER_SECRET' }]) assert.equal(imageLogic.imageTaskConnectionMessage({ ...beforePost, ...patch }), '');
  }
  assert.match(imageLogic.imageTaskMessage('outcome_unknown'), /无法确认服务商结果/); assert.doesNotMatch(imageLogic.imageTaskMessage('outcome_unknown'), /未发送|免费|不收费/);
});

test('actual custom failed task shows fixed pre-dispatch guidance without reflecting raw provider text', async () => {
  for (const errorCode of ['IMAGE_NETWORK_DENIED', 'IMAGE_SETTINGS_CONFLICT', 'RAW_PROVIDER_SECRET']) {
    const f = customFixture({ tasks: [task({ providerId: 'openai-compatible', model: 'vendor-image-exact', state: 'failed', revision: 2, errorCode })] }), ui = renderer(f); ui.render(); await flush(); ui.render();
    const notice = ui.find('image-task-connection-notice');
    if (errorCode === 'RAW_PROVIDER_SECRET') assert.equal(notice, undefined); else assert.match(JSON.stringify(notice), /本次未发送生成 POST/);
    assert.doesNotMatch(JSON.stringify(ui.find('image-task')), /RAW_PROVIDER_SECRET|IMAGE_NETWORK_DENIED|IMAGE_SETTINGS_CONFLICT/); ui.unmount(); f.session.dispose();
  }
});

function historyFixture(options = {}) {
  const otherGroupId = id(90), otherVersionId = id(91), otherTaskId = id(92), otherAssetId = id(93), unknownTaskId = id(94);
  const f = fixture({
    groups: [group({ name: 'Group A', headVersionId: versionId, activeTaskId: unknownTaskId }), group({ id: otherGroupId, name: 'Group B', headVersionId: otherVersionId, activeTaskId: null })],
    tasks: [task({ id: unknownTaskId, requestId: id(95), state: 'outcome_unknown', dispatched: true }), task({ state: 'succeeded', dispatched: true, revision: 4, versionId }), task({ id: otherTaskId, requestId: id(96), groupId: otherGroupId, name: 'Group B', state: 'succeeded', dispatched: true, revision: 4, versionId: otherVersionId })],
    versions: [version(), version({ id: otherVersionId, groupId: otherGroupId, taskId: otherTaskId, assetId: otherAssetId })],
    ...options,
  });
  return { ...f, otherGroupId, otherVersionId, otherTaskId, otherAssetId, unknownTaskId };
}

test('history selection clears wrong-group versions and cursors during delayed failure, then retries without losing draft or recovery', async () => {
  const held = deferred(); let fail = true;
  const f = historyFixture({ api: (operation, input, data) => {
    if (operation === 'image.task.list' && input.groupId === id(90) && fail) return held.promise;
    if (operation === 'image.version.list' && input.groupId === groupId) return page(data.versions.filter(item => item.groupId === groupId), 'older-A-versions');
  } });
  let selecting;
  try {
    await ready(f); const draft = f.session.getState().draft;
    assert.equal(f.session.getState().nextVersionCursor, 'older-A-versions');
    selecting = f.session.selectGroup(f.otherGroupId); await flush();
    let state = f.session.getState();
    assert.equal(state.selectedGroupId, f.otherGroupId);
    assert.deepEqual(state.versions, [], 'Group A images must disappear as soon as B is selected');
    assert.equal(state.nextVersionCursor, null); assert.equal(state.versionCursor, null); assert.deepEqual(state.versionTrail, []);
    assert.equal(state.historyPhase, 'loading'); assert.deepEqual(state.draft, draft);
    assert.ok(state.tasks.some(item => item.id === f.unknownTaskId), 'Retain A’s recoverable task record');
    held.reject(error()); assert.equal(await selecting, false);
    state = f.session.getState(); assert.equal(state.historyPhase, 'read_error'); assert.deepEqual(state.versions, []); assert.deepEqual(state.draft, draft);
    fail = false; assert.equal(await f.session.load(), true);
    state = f.session.getState(); assert.equal(state.historyPhase, 'ready'); assert.equal(state.versions[0].id, f.otherVersionId); assert.deepEqual(state.draft, draft);
    await f.session.selectGroup(groupId);
    assert.equal(f.session.getState().versions[0].id, versionId); assert.ok(f.session.getState().tasks.some(item => item.id === f.unknownTaskId));
    assert.equal(mutations(f).length, 0); assert.equal(f.privateCalls.length, 0);
  } finally { held.resolve(page([])); await selecting; f.session.dispose(); }
});

test('history selection preserves the current group’s versions, page and draft through failed refresh', async () => {
  const held = deferred(); let hold = false;
  const f = historyFixture({ api: (operation, input, data) => {
    if (operation === 'image.group.list' && hold) return held.promise;
    if (operation === 'image.version.list' && input.groupId === groupId) return page(data.versions.filter(item => item.groupId === groupId), 'older-A-versions');
  } });
  let reading;
  try {
    await ready(f); const previous = f.session.getState(); hold = true; reading = f.session.load(); await flush();
    let state = f.session.getState(); assert.deepEqual(state.versions, previous.versions); assert.equal(state.nextVersionCursor, previous.nextVersionCursor); assert.deepEqual(state.draft, previous.draft);
    held.reject(error()); await reading; state = f.session.getState();
    assert.deepEqual(state.versions, previous.versions); assert.equal(state.selectedGroupId, groupId); assert.equal(state.nextVersionCursor, previous.nextVersionCursor); assert.deepEqual(state.draft, previous.draft);
    assert.equal(mutations(f).length, 0);
  } finally { held.resolve(page([])); await reading; f.session.dispose(); }
});

test('history selection version pagination clears the prior page on failure and can return to the retained page identity', async () => {
  const held = deferred();
  const f = historyFixture({ api: (operation, input, data) => {
    if (operation !== 'image.version.list' || input.groupId !== groupId) return;
    if (input.cursor) return held.promise;
    return page(data.versions.filter(item => item.groupId === groupId), 'older-A-versions');
  } });
  let paging;
  try {
    await f.session.load(); paging = f.session.pageVersions(true); await flush();
    let state = f.session.getState(); assert.deepEqual(state.versions, []); assert.equal(state.nextVersionCursor, null); assert.equal(state.versionCursor, 'older-A-versions'); assert.deepEqual(state.versionTrail, [null]);
    held.reject(error()); await paging; assert.equal(await f.session.pageVersions(true), false);
    assert.equal(await f.session.pageVersions(false), true); state = f.session.getState(); assert.equal(state.versions[0].id, versionId); assert.equal(state.versionCursor, null); assert.deepEqual(state.versionTrail, []);
    assert.equal(mutations(f).length, 0);
  } finally { held.resolve(page([])); await paging; f.session.dispose(); }
});

test('history selection group pagination removes old versions before its new group page is readable', async () => {
  const held = deferred(); let rejectPage = true;
  const f = historyFixture({ api: (operation, input, data) => {
    if (operation !== 'image.group.list') return;
    if (input.cursor) return rejectPage ? held.promise : page([data.groups[1]]);
    return page([data.groups[0]], 'older-groups');
  } });
  let paging;
  try {
    await f.session.load(); paging = f.session.pageGroups(true); await flush();
    let state = f.session.getState(); assert.equal(state.selectedGroupId, null); assert.deepEqual(state.versions, []); assert.equal(state.nextVersionCursor, null);
    held.reject(error()); await paging; assert.deepEqual(f.session.getState().versions, []);
    rejectPage = false; await f.session.load(); state = f.session.getState(); assert.equal(state.selectedGroupId, f.otherGroupId); assert.equal(state.versions[0].id, f.otherVersionId);
    assert.equal(mutations(f).length, 0);
  } finally { held.resolve(page([])); await paging; f.session.dispose(); }
});

test('history selection after explicit target confirmation reloads its own versions without replacing a newer draft', async () => {
  const f = historyFixture();
  try {
    f.data.groups[0].activeTaskId = null;
    await ready(f); await f.session.requestTarget(groupId);
    await f.session.selectGroup(f.otherGroupId); assert.equal(f.session.getState().versions[0].id, f.otherVersionId);
    await f.session.confirmTarget(); const state = f.session.getState();
    assert.equal(state.selectedGroupId, groupId); assert.equal(state.versions[0]?.id, versionId); assert.equal(state.historyPhase, 'ready');
    assert.deepEqual(state.target, { groupId, expectedRevision: 1 }); assert.equal(state.draft.prompt, '清晨的山间小屋'); assert.equal(mutations(f).length, 0);
  } finally { f.session.dispose(); }
});

test('actual history selection never labels or reveals A’s saved asset as B during a failed read', async () => {
  const held = deferred(); let fail = true; const reveals = [];
  const f = historyFixture({ api: (operation, input) => operation === 'image.task.list' && input.groupId === id(90) && fail ? held.promise : undefined });
  const ui = renderer(f, { onRevealAsset: (...args) => reveals.push(args) });
  try {
    ui.render(); await flush(); ui.render(); assert.equal(ui.find('image-version-preview').props.src, `/media/${assetId}`);
    const oldReveal = ui.find('image-reveal-asset').props.onClick;
    ui.change('image-generation-prompt', 'Keep my current description');
    ui.change('image-history-group', f.otherGroupId); await flush(); ui.render();
    assert.equal(ui.find('image-history-group').props.value, f.otherGroupId);
    assert.equal(ui.find('image-version-preview'), undefined); assert.equal(ui.find('image-reveal-asset'), undefined);
    oldReveal(); assert.deepEqual(reveals, [], 'Captured A callbacks cannot reveal its asset under selected B');
    assert.match(JSON.stringify(ui.find('image-history-status')), /正在读取/);
    held.reject(error()); await flush(); ui.render();
    assert.equal(ui.find('image-version-preview'), undefined); assert.equal(ui.find('image-reveal-asset'), undefined); assert.match(JSON.stringify(ui.find('image-history-status')), /暂时无法读取/);
    fail = false; ui.click('image-refresh'); await flush(); ui.render();
    assert.equal(ui.find('image-version-preview').props.src, `/media/${f.otherAssetId}`); assert.match(ui.find('image-version-preview').props.alt, /Group B/);
    oldReveal(); assert.deepEqual(reveals, []);
    ui.click('image-reveal-asset'); assert.deepEqual(reveals, [[f.otherAssetId, projectId]]);
    assert.equal(ui.find('image-generation-prompt').props.value, 'Keep my current description'); assert.equal(mutations(f).length, 0);
  } finally { held.resolve(page([])); await flush(); ui.unmount(); f.session.dispose(); }
});

test('history selection from accepted or recovered generation clears another group’s versions even when follow-up reads fail', async () => {
  for (const lostAcknowledgement of [false, true]) {
    let accepted = false;
    const f = historyFixture({ api: (operation, input, data) => {
      if (operation === 'image.generate') {
        const result = task({ ...input, id: id(98), groupId: id(90) });
        data.tasks.unshift(result); data.receipts.set(input.requestId, { projectId, requestId: input.requestId, operation, response: result }); accepted = true;
        if (lostAcknowledgement) throw error();
        return result;
      }
      if (operation === 'image.group.list' && accepted) throw error();
    } });
    try {
      await ready(f); assert.equal(f.session.getState().versions[0].id, versionId);
      assert.equal(await f.session.generate(), true);
      const state = f.session.getState(); assert.equal(state.pending, null); assert.equal(state.selectedGroupId, f.otherGroupId); assert.deepEqual(state.versions, []); assert.equal(state.nextVersionCursor, null);
      assert.equal(state.historyPhase, 'read_error'); assert.ok(state.tasks.some(item => item.id === id(98))); assert.equal(mutations(f).length, 1);
      assert.equal(f.calls.some(call => call.operation === 'image.request.get'), lostAcknowledgement);
    } finally { f.session.dispose(); }
  }
});

test('history selection from saved paid approval clears the old group while keeping the unrelated composer draft', async () => {
  const original = review(paidInput({ groupId: id(90), expectedRevision: 1 }));
  const f = historyFixture({ settings: settings(), reviews: [original], api: (operation, _input, data) => {
    if (operation === 'image.group.list' && data.tasks.some(item => item.providerId === 'openai')) throw error();
  } });
  try {
    await ready(f); const draft = f.session.getState().draft;
    assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), true);
    const state = f.session.getState(); assert.equal(state.selectedGroupId, f.otherGroupId); assert.deepEqual(state.versions, []); assert.equal(state.nextVersionCursor, null); assert.deepEqual(state.draft, draft);
    assert.equal(state.historyPhase, 'read_error'); assert.equal(f.privateCalls.length, 1); assert.equal(mutations(f).length, 0);
  } finally { f.session.dispose(); }
});

test('history selection same-group accepted generation or approval clears an older version page until the first page is confirmed', async () => {
  for (const paid of [false, true]) {
    const first = version({ number: 2 }), older = version({ id: id(101), taskId: id(102), number: 1 }), original = review(paidInput({ groupId, expectedRevision: 1 }));
    let failRead = true;
    const f = historyFixture({ settings: settings(), reviews: paid ? [original] : [], api: (operation, input, data) => {
      if (operation === 'image.group.list' && failRead && data.tasks.some(item => item.state === 'queued')) throw error();
      if (operation === 'image.version.list' && input.groupId === groupId) return input.cursor ? page([older]) : page([first], 'older-A-versions');
    } });
    try {
      f.data.groups[0].activeTaskId = null;
      await ready(f);
      if (!paid) { await f.session.requestTarget(groupId); await f.session.confirmTarget(); }
      await f.session.pageVersions(true);
      let state = f.session.getState(); assert.equal(state.selectedGroupId, groupId); assert.equal(state.versionCursor, 'older-A-versions'); assert.equal(state.versions[0].id, older.id);
      assert.equal(paid ? await f.session.approveReview(state.reviews[0]) : await f.session.generate(), true);
      state = f.session.getState(); assert.equal(state.selectedGroupId, groupId); assert.equal(state.versionCursor, null); assert.deepEqual(state.versionTrail, []); assert.deepEqual(state.versions, []); assert.equal(state.nextVersionCursor, null); assert.equal(state.historyPhase, 'read_error');
      failRead = false; await f.session.load(); state = f.session.getState(); assert.equal(state.versions[0].id, first.id); assert.equal(state.versionCursor, null); assert.equal(state.historyPhase, 'ready');
      assert.equal(mutations(f).length, paid ? 0 : 1); assert.equal(f.privateCalls.length, paid ? 1 : 0);
    } finally { f.session.dispose(); }
  }
});

test('history selection accepted generation or approval invalidates an older group cursor before a failed first-page refresh', async () => {
  for (const paid of [false, true]) {
    const original = review(paidInput({ groupId: id(90), expectedRevision: 1 })); let failRead = true;
    const f = historyFixture({ settings: settings(), reviews: paid ? [original] : [], api: (operation, input, data) => {
      if (operation !== 'image.group.list') return;
      if (failRead && data.tasks.some(item => item.state === 'queued')) throw error();
      if (!input.cursor) return page([data.groups[0]], 'group-page-two');
      if (input.cursor === 'group-page-two') return page([data.groups[1]], 'group-page-three');
      return page([]);
    } });
    try {
      await ready(f); const draft = f.session.getState().draft;
      await f.session.pageGroups(true); let state = f.session.getState();
      assert.equal(state.groupCursor, 'group-page-two'); assert.equal(state.nextGroupCursor, 'group-page-three');
      assert.equal(paid ? await f.session.approveReview(state.reviews[0]) : await f.session.generate(), true);
      state = f.session.getState(); assert.equal(state.groupCursor, null); assert.deepEqual(state.groupTrail, []);
      assert.equal(state.nextGroupCursor, null, 'A cursor from the former page cannot be used under first-page identity');
      assert.equal(state.historyPhase, 'read_error'); assert.equal(state.pending, null); assert.equal(f.data.receipts.size, 1);
      if (paid) assert.deepEqual(state.draft, draft);
      assert.equal(await f.session.pageGroups(true), false); assert.equal(f.calls.some(call => call.input.cursor === 'group-page-three'), false);
      failRead = false; await f.session.load(); state = f.session.getState(); assert.equal(state.groupCursor, null); assert.equal(state.nextGroupCursor, 'group-page-two'); assert.equal(f.data.receipts.size, 1);
      assert.equal(mutations(f).length, paid ? 0 : 1); assert.equal(f.privateCalls.length, paid ? 1 : 0);
    } finally { f.session.dispose(); }
  }
});

test('four-language changes preserve mounted image drafts and the same pending paid review without automatic approval', async () => {
  const languageStore = createLanguageStore({ systemLanguages: ['zh-Hans'] });
  const held = deferred(); let original;
  const f = fixture({ settings: settings(), api: (operation, input, data) => { if (operation === 'image.review.prepare') { original = review(input.input); data.reviews = [original]; return held.promise; } } }), ui = renderer(f, { languageStore });
  ui.render(); await flush(); ui.render();
  const name = '保留名称 / Image / 画像', prompt = '  原文 <script>\nexact prompt  ';
  ui.change('image-generation-name', name); ui.change('image-generation-prompt', prompt); ui.click('image-provider-openai');
  const before = f.calls.length;
  for (const locale of ['zh-Hant', 'en', 'ja', 'zh-Hans']) {
    await languageStore.setPreference(locale); ui.render(); await flush(); ui.render();
    assert.equal(ui.find('image-generation-name').props.value, name);
    assert.equal(ui.find('image-generation-prompt').props.value, prompt);
    assert.equal(f.calls.length, before); assert.equal(f.privateCalls.length, 0);
  }
  ui.click('image-generate'); await flush(); ui.show(false); held.resolve(original); await flush(); ui.show(true); await flush(); ui.render();
  const approval = ui.find('image-review-approve'); assert.ok(approval);
  const pendingCalls = f.calls.length;
  for (const locale of ['ja', 'en', 'zh-Hant']) {
    await languageStore.setPreference(locale); ui.render(); await flush(); ui.render();
    assert.ok(ui.find('image-review-approve')); assert.equal(f.calls.length, pendingCalls); assert.equal(f.privateCalls.length, 0);
  }
  ui.click('image-review-approve'); await flush(); ui.render();
  assert.equal(f.privateCalls.length, 1); assert.equal(f.privateCalls[0].review.input.name, name); assert.equal(f.privateCalls[0].review.input.prompt, prompt);
  ui.unmount(); f.session.dispose(); languageStore.dispose();
});

const editAsset = () => ({ id: assetId, projectId, name: 'Owned reference.png', sha256: 'a'.repeat(64), mimeType: 'image/png', provenance: 'user-import', sizeBytes: 120, width: 64, height: 64 });
function editIntentFixture(f) {
  const source = editAsset(), changes = [];
  let visible = true, sources = [source], current = true;
  const controller = imageEditIntents.createImageEditIntentController({
    getContext: () => ({ visible, scope: 'project:epoch:panel', projectId, assets: sources, session: f.session, isCurrent: () => current }),
    isDirty: imageDraftDirty, onChange: value => changes.push(value),
  });
  return { controller, changes, source,
    intent: number => imageEditIntents.captureImageEditIntent({ id: id(number), scope: 'project:epoch:panel', projectId, asset: source }),
    hide() { visible = false; f.session.setVisible(false); controller.retire(); }, show() { visible = true; f.session.setVisible(true); }, setSources(value) { sources = value; }, current(value) { current = value; } };
}
test('external image edit intent prefills one exact source without generating or approving', async () => {
  const f = fixture(); await f.session.load(); const h = editIntentFixture(f), intent = h.intent(900);
  await h.controller.receive(intent); assert.equal(h.changes.at(-1).phase, 'applied');
  assert.equal(f.session.getState().mode, 'edit'); assert.deepEqual(f.session.getState().inputImage, { assetId, sha256: 'a'.repeat(64) });
  assert.equal(mutations(f).length, 0); assert.equal(f.privateCalls.length, 0);
  assert.equal(f.calls.some(call => call.operation === 'image.review.prepare'), false);
  f.session.edit('prompt', 'Keep edited description'); await h.controller.receive(intent);
  assert.equal(f.session.getState().draft.prompt, 'Keep edited description'); f.session.dispose();
});
test('image edit intent uses the existing discard guard and stale form/source confirmations preserve the draft', async () => {
  const f = fixture(); await ready(f); const h = editIntentFixture(f);
  await h.controller.receive(h.intent(901)); assert.equal(h.changes.at(-1).phase, 'confirm');
  const stale = h.changes.at(-1).ticket; assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋');
  f.session.edit('prompt', 'Newer form'); assert.equal(await h.controller.confirm(stale), false); assert.equal(f.session.getState().draft.prompt, 'Newer form');
  await h.controller.receive(h.intent(902)); const changedSource = h.changes.at(-1).ticket;
  h.setSources([{ ...editAsset(), sha256: 'b'.repeat(64) }]); assert.equal(await h.controller.confirm(changedSource), false); assert.equal(f.session.getState().draft.prompt, 'Newer form');
  h.setSources([editAsset()]); await h.controller.receive(h.intent(903)); const confirmed = h.changes.at(-1).ticket;
  assert.equal(await h.controller.confirm(confirmed), true); assert.equal(f.session.getState().draft.prompt, ''); assert.equal(f.session.getState().mode, 'edit');
  assert.equal(mutations(f).length, 0); assert.equal(f.privateCalls.length, 0); f.session.dispose();
});
test('hiding or retiring an image edit intent rejects old confirmation even after showing the same project', async () => {
  const f = fixture(); await ready(f); const h = editIntentFixture(f);
  await h.controller.receive(h.intent(904)); const ticket = h.changes.at(-1).ticket;
  h.hide(); h.show(); assert.equal(await h.controller.confirm(ticket), false);
  assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋'); assert.equal(f.session.getState().mode, 'text');
  assert.equal(mutations(f).length, 0); f.session.dispose();
});
test('actual image composer waits for its reads before applying a fresh edit intent and never submits it', async () => {
  const f = fixture(), source = editAsset(), intent = imageEditIntents.captureImageEditIntent({ id: id(905), scope: 'project:epoch:panel', projectId, asset: source });
  const options = { projectAssets: [source], editIntent: intent, isEditIntentCurrent: value => value === intent }, ui = renderer(f, options);
  ui.render(); await flush(); ui.render(); await flush(); ui.render();
  assert.equal(ui.find('image-mode-edit').props['aria-pressed'], true);
  assert.equal(ui.find('image-source-asset').props.value, `${assetId}:${source.sha256}`);
  assert.equal(mutations(f).length, 0); assert.equal(f.privateCalls.length, 0); ui.unmount(); f.session.dispose();
});

test('image edit intent capture rejects foreign, duplicate and unsupported source identities', () => {
  const source = editAsset(), capture = value => imageEditIntents.captureImageEditIntent({ id: id(906), scope: 'scope', projectId, asset: value });
  assert.equal(capture({ ...source, projectId: id(999) }), null);
  assert.equal(capture({ ...source, mimeType: 'image/jpeg' }), null);
  assert.equal(capture({ ...source, width: 2048 }), null);
  const intent = capture(source); assert.ok(Object.isFrozen(intent));
  assert.equal(imageEditIntents.imageEditIntentSource(intent, { scope: 'scope', projectId, assets: [source, source] }), null);
  assert.equal(imageEditIntents.imageEditIntentSource(intent, { scope: 'other', projectId, assets: [source] }), null);
});
