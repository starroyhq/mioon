import { comfyConnectorAvailabilityDescriptor } from '../apps/web/src/comfy-image-settings.ts';
import { creationTestDependency } from './helpers/creation-i18n.ts';
import * as nativeCloseSources from '../apps/web/src/native-close-sources.ts';
import * as imageEditIntent from '../apps/web/src/image-edit-intent.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import * as contracts from '../packages/contracts/src/index.ts';
import * as logic from '../apps/web/src/image-generation.ts';
import { createImageReviewClient, imageReviewIdentity } from '../apps/web/src/image-review.ts';
import { ApiError } from '../apps/web/src/api.ts';
const { canonicalImageInput: canonical, IMAGE_FIXED_OPTIONS: options, IMAGE_MODELS: models, DEFAULT_IMAGE_CONFIGURATION, IMAGE_REVIEW_POLICY, IMAGE_EDIT_REVIEW_DESTINATION } = contracts;
const id = (n: number): string => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), groupId = id(2), assetId = id(3), taskId = id(4), requestId = id(5), at = '2026-10-11T12:00:00.000Z';
const hash = (value: unknown): string => createHash('sha256').update(canonical(value as never)).digest('hex');
const sourceAsset = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ id: assetId, projectId, name: 'Imported source.png', mimeType: 'image/png', sha256: 'a'.repeat(64), width: 640, height: 480, sizeBytes: 2400, provenance: 'user-import', ...patch });
const descriptor = (asset: Record<string, unknown>): Record<string, unknown> => ({ assetId: asset.id, sha256: asset.sha256, name: asset.name, mimeType: asset.mimeType, width: asset.width, height: asset.height, byteLength: asset.sizeBytes, origin: { kind: 'user-import' } });
// Edits follow the source's ratio within the model's edit profile: the 640x480
// source below has a 1536 long edge and a 1152 short edge (a multiple of 16).
const editOptions = { ...options, size: '1536x1152' };
const input = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ projectId, name: 'Edit result', prompt: '  Change only the backdrop.\nKeep the framing.  ', providerId: 'openai', model: models.openai, options: editOptions, requestId, purpose: 'edit', inputImage: { assetId, sha256: 'a'.repeat(64) }, ...patch });
const review = (value: Record<string, unknown> = input(), patch: Record<string, unknown> = {}): Record<string, unknown> => ({ id: id(6), projectId: value.projectId, requestId: value.requestId, input: value, inputHash: hash(value), settingsRevision: 1, destination: value.purpose === 'edit' ? IMAGE_EDIT_REVIEW_DESTINATION : contracts.IMAGE_REVIEW_DESTINATION, policy: { ...IMAGE_REVIEW_POLICY }, ...(value.purpose === 'edit' ? { sourceImage: descriptor(sourceAsset({ id: (value.inputImage as Record<string, unknown>).assetId, sha256: (value.inputImage as Record<string, unknown>).sha256 })) } : {}), state: 'pending', revision: 1, taskId: null, postAttempts: 0, createdAt: at, updatedAt: at, approvedAt: null, rejectedAt: null, dispatchedAt: null, ...patch });
const task = (value: Record<string, unknown> = input(), patch: Record<string, unknown> = {}): Record<string, unknown> => { const result: Record<string, unknown> = { ...value, id: taskId, groupId: value.groupId || groupId, state: 'queued', revision: 1, dispatched: false, versionId: null, errorCode: null, createdAt: at, updatedAt: at, ...(value.purpose === 'edit' ? { sourceImage: descriptor(sourceAsset({ id: (value.inputImage as Record<string, unknown>).assetId, sha256: (value.inputImage as Record<string, unknown>).sha256 })) } : {}), ...patch }; delete result.expectedRevision; return result; };
const settings = (): Record<string, unknown> => ({ revision: 1, configuration: { ...DEFAULT_IMAGE_CONFIGURATION, enabled: true }, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' } });
interface MemoryStorage { data: Map<string, unknown>; getItem(key: string): unknown; setItem(key: string, value: unknown): void; removeItem(key: string): boolean }
const memory = (): MemoryStorage => { const data = new Map<string, unknown>(); return { data, getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: unknown) => {data.set(key, value);}, removeItem: (key: string) => data.delete(key) }; };
interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void }
const deferred = <T = Record<string, unknown>>(): Deferred<T> => { let resolve: (value: T) => void = () => undefined, reject: (reason?: unknown) => void = () => undefined; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async (): Promise<void> => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
interface DataStore { reviews: Array<Record<string, unknown>>; tasks: Array<Record<string, unknown>>; groups: Array<Record<string, unknown>>; receipts: Map<string, unknown> }
type AcceptFn = (value: Record<string, unknown>) => Record<string, unknown>;
type ApiFn = (operation: string, value: Record<string, unknown>, data: DataStore, accept: AcceptFn) => unknown;
type ApproveFn = (value: Record<string, unknown>, data: DataStore, accept: AcceptFn) => unknown;
interface FixtureConfig { api?: ApiFn; reviews?: Array<Record<string, unknown>>; storage?: MemoryStorage; approve?: ApproveFn }
interface Fixture {
  session: ReturnType<typeof logic.createImageGenerationSession>; sessionOptions: Record<string, unknown>;
  api: (...args: unknown[]) => unknown; reviewClient: Record<string, unknown>; storage: MemoryStorage;
  data: DataStore;
  calls: Array<{operation: string; input: unknown}>; approvals: Array<Record<string, unknown>>;
  settingsClient: Record<string, unknown>; customSettingsClient: Record<string, unknown>;
}
function fixture(config: FixtureConfig = {}): Fixture {
  const calls: Array<{operation: string; input: unknown}> = [], approvals: Array<Record<string, unknown>> = [], storage = config.storage || memory();
  const data: DataStore = { reviews: (config.reviews || []) as Array<Record<string, unknown>>, tasks: [], groups: [], receipts: new Map<string, unknown>() };
  const page = (owner: unknown, items: unknown[]) => ({ projectId: owner, items, nextCursor: null });
  function accept(value: Record<string, unknown>): Record<string, unknown> {
    const result = task(value); data.tasks = [result];
    data.groups = [{ id: groupId, projectId: value.projectId, name: value.name, revision: 1, headVersionId: null, activeTaskId: taskId, createdAt: at, updatedAt: at }];
    data.receipts.set(String(value.requestId), { projectId: value.projectId, requestId: value.requestId, operation: 'image.generate', response: result }); return result;
  }
  const api = (async (operation: string, value: Record<string, unknown>): Promise<unknown> => {
    calls.push({ operation, input: structuredClone(value) });
    if (config.api) { const result = await config.api(operation, value, data, accept); if (result !== undefined) return result; }
    if (operation === 'image.review.prepare') { const result = review(value.input as Record<string, unknown>); data.reviews = [result]; return result; }
    if (operation === 'image.review.get') return data.reviews.find(item => item.id === value.reviewId);
    if (operation === 'image.review.list') return page(value.projectId, data.reviews.filter(item => item.projectId === value.projectId));
    if (operation === 'image.group.list') return page(value.projectId, data.groups.filter(item => item.projectId === value.projectId));
    if (operation === 'image.group.get') return data.groups.find(item => item.id === value.groupId);
    if (operation === 'image.task.list') return page(value.projectId, data.tasks.filter(item => item.projectId === value.projectId));
    if (operation === 'image.task.get') return data.tasks.find(item => item.id === value.taskId);
    if (operation === 'image.version.list') return page(value.projectId, []);
    if (operation === 'image.request.get') return data.receipts.get(String(value.requestId)) || null;
    if (operation === 'image.generate') return accept(value);
    throw Error(operation);
  }) as (...args: unknown[]) => unknown;
  const reviewClient = { approve: async (value: Record<string, unknown>): Promise<unknown> => { approvals.push(structuredClone(value)); return config.approve ? config.approve(value, data, accept) : accept(value.input as Record<string, unknown>); }, reject: async (value: Record<string, unknown>): Promise<unknown> => { const result = { ...value, state: 'rejected', revision: 2, rejectedAt: at }; data.reviews = [result]; return result; } };
  const sessionOptions = { projectId, api, reviewClient, storage, settings: settings(), requestId: () => requestId, setTimer: () => 1, clearTimer() {} };
  const session = logic.createImageGenerationSession(sessionOptions as unknown as Parameters<typeof logic.createImageGenerationSession>[0]);
  return { session, sessionOptions, api, reviewClient, storage, data, calls, approvals, settingsClient: { read: async () => settings() }, customSettingsClient: { read: async () => { throw Error('Not configured'); } } };
}
async function compose(f: Fixture, provider = 'openai'): Promise<void> { await f.session.load(); f.session.edit('name', String(input().name)); f.session.edit('prompt', String(input().prompt)); f.session.selectProvider(provider); f.session.selectMode('edit'); f.session.selectSource(sourceAsset()); }

test('edit chooser uses metadata only and rejects unsupported formats, size, geometry, ownership and identity', () => {
  assert.equal(logic.imageEditSourceIssue(sourceAsset(), projectId), '');
  // PNG, JPEG and WebP sources under 50 MB with edges up to 4096 pixels are offered.
  for (const patch of [{ mimeType: 'image/jpeg' }, { mimeType: 'image/webp' }, { sizeBytes: contracts.IMAGE_EDIT_LIMITS.sourceBytes }, { width: 4096, height: 4096 }]) assert.equal(logic.imageEditSourceIssue(sourceAsset(patch), projectId), '', JSON.stringify(patch));
  for (const patch of [{ mimeType: 'image/gif' }, { projectId: id(50) }, { sha256: 'bad' }, { sizeBytes: contracts.IMAGE_EDIT_LIMITS.sourceBytes + 1 }, { width: 4097 }, { height: 0 }, { provenance: 'export' }]) assert.notEqual(logic.imageEditSourceIssue(sourceAsset(patch), projectId), '');
  const f = fixture(); f.session.selectMode('edit'); assert.equal(logic.imageDraftDirty(f.session.getState()), true); assert.equal(f.session.selectSource(sourceAsset()), true); assert.equal(f.calls.length, 0); assert.equal(f.approvals.length, 0); assert.deepEqual(f.session.getState().inputImage, input().inputImage); f.session.dispose();
});

test('Mock edit sends exactly purpose/inputImage with original prompt and no source authority or bytes', async () => {
  const f = fixture(); await compose(f, 'mock'); assert.equal(await f.session.generate(), true);
  assert.deepEqual(f.calls.find(call => call.operation === 'image.generate')!.input, input({ providerId: 'mock', model: models.mock }));
  assert.equal(f.approvals.length, 0); assert.equal(f.session.getState().mode, 'text'); assert.match(f.session.getState().message, /静态测试卡片/); f.session.dispose();
});

test('official edit preparation never approves, freezes descriptor, and only explicit approval sends original identity', async () => {
  const f = fixture(); await compose(f); assert.equal(await f.session.generatePaid(logic.imagePaidAuthorization(f.session.getState())), true);
  assert.deepEqual(f.calls.find(call => call.operation === 'image.review.prepare')!.input, { input: input(), settingsRevision: 1 }); assert.equal(f.approvals.length, 0);
  const state = f.session.getState(); assert.deepEqual(state.pending!.sourceImage, descriptor(sourceAsset())); assert.equal(state.pending!.approvalAttempted, false);
  assert.equal(f.session.selectSource(sourceAsset({ id: id(20) })), false); assert.equal(f.session.selectMode('text'), false);
  await f.session.load(); assert.equal(f.approvals.length, 0); assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), true); assert.deepEqual(f.approvals[0].input, input()); assert.equal(f.session.getState().pending, null); f.session.dispose();
});

test('current source, prompt, mode and provider bind old paid authorization and edit review approval', async () => {
  for (const change of [(session: Fixture['session']) => session.selectSource(sourceAsset({ id: id(21), sha256: 'b'.repeat(64) })), (session: Fixture['session']) => session.edit('prompt', 'Different edit'), (session: Fixture['session']) => session.selectMode('text'), (session: Fixture['session']) => session.selectProvider('mock')] as Array<(session: Fixture['session']) => unknown>) {
    const original = review(), f = fixture({ reviews: [original] }); await compose(f); const authorization = logic.imagePaidAuthorization(f.session.getState()); change(f.session);
    assert.equal(await f.session.generatePaid(authorization), false); assert.equal(await f.session.approveReview(original), false); assert.equal(f.approvals.length, 0); assert.equal(f.calls.some(call => call.operation === 'image.review.prepare'), false); f.session.dispose();
  }
});

test('external edit review explicitly stages immutable source and dirty draft replacement requires confirmation', async () => {
  const original = review(), f = fixture({ reviews: [original] }); await f.session.load(); f.session.edit('prompt', 'Keep my draft');
  assert.equal(f.session.requestEditReview(original), false); assert.equal(f.session.getState().draft.prompt, 'Keep my draft'); assert.deepEqual(f.session.getState().targetRequest, { reviewId: original.id });
  assert.equal(f.session.confirmTarget(), true); assert.deepEqual(f.session.getState().inputImage, (original!.input as Record<string, unknown>).inputImage); assert.equal(f.approvals.length, 0); assert.equal(logic.imageReviewCanApprove(f.session.getState(), original), true); f.session.dispose();
});

test('hidden preparation completion and remount retain source identity without automatically approving or replaying', async () => {
  const held = deferred<Record<string, unknown>>(); let original: Record<string, unknown> | undefined;
  const f = fixture({ api: (operation, value, data) => { if (operation === 'image.review.prepare') { original = review(value.input as Record<string, unknown>); data.reviews = [original!]; return held.promise; } } }); await compose(f); const preparing = f.session.generatePaid(); await flush(); f.session.setVisible(false); held.resolve(original!); await preparing; assert.equal(f.approvals.length, 0); f.session.dispose();
  const g = fixture({ storage: f.storage, reviews: [original!] }); await g.session.load(); assert.equal(g.approvals.length, 0); assert.deepEqual(g.session.getState().inputImage, (original!.input as Record<string, unknown>).inputImage); assert.equal(g.session.getState().mode, 'edit'); assert.equal(g.calls.some(call => call.operation === 'image.review.prepare'), false); g.session.dispose();
});

test('late old-project approval cannot clear retained intent or change another project', async () => {
  const held = deferred(), f = fixture({ approve: () => held.promise }); await compose(f); await f.session.generatePaid(); const approving = f.session.approveReview(f.session.getState().reviews[0]); await flush(); const saved = [...f.storage.data.values()][0]; f.session.dispose();
  const other = logic.createImageGenerationSession({ ...f.sessionOptions, projectId: id(99) }); await other.load(); held.resolve(task()); await approving; assert.equal([...f.storage.data.values()][0], saved); assert.equal(other.getState().tasks.length, 0); other.dispose();
});

test('unknown Mock edit receipt cannot clear against changed source or changed backend source descriptor', async () => {
  for (const patch of [{ inputImage: { assetId: id(22), sha256: 'b'.repeat(64) }, sourceImage: descriptor(sourceAsset({ id: id(22), sha256: 'b'.repeat(64) })) }, { sourceImage: descriptor(sourceAsset({ name: 'Changed after receipt.png' })) }]) {
    const f = fixture({ api: (operation, value, data, accept) => {
      if (operation === 'image.generate') { accept(value); throw new ApiError('Unknown', 'NETWORK'); }
      if (operation === 'image.task.get') return { ...data.tasks[0], ...patch };
    } }); await compose(f, 'mock'); await f.session.generate(); assert.ok(f.session.getState().pending); await f.session.load(); assert.equal(f.calls.filter(call => call.operation === 'image.generate').length, 1); f.session.dispose();
  }
});

test('paid approval and recovered receipts reject changed source metadata even when asset id and hash are unchanged', async () => {
  const f = fixture({ approve: (value, data) => { const forged = task(value.input as Record<string, unknown>, { sourceImage: descriptor(sourceAsset({ name: 'Forged source name.png' })) }); data.tasks = [forged]; data.receipts.set(requestId, { projectId, requestId, operation: 'image.generate', response: forged }); return forged; } });
  await compose(f); await f.session.generatePaid(); await f.session.approveReview(f.session.getState().reviews[0]); assert.ok(f.session.getState().pending); assert.equal(f.approvals.length, 1); assert.equal(f.session.getState().pending!.sourceImage!.name, sourceAsset().name); f.session.dispose();
});

test('old text-only pending receipts remain readable and never acquire edit fields', async () => {
  const storage = memory(), textInput: Record<string, unknown> = { ...input(), options }; delete textInput.purpose; delete textInput.inputImage;
  storage.setItem(`mioon.image-intent.v1:${projectId}`, JSON.stringify({ version: 1, operation: 'image.generate', input: textInput, settingsRevision: 1, reviewId: null, approvalAttempted: true }));
  const f = fixture({ storage, api: (operation, value, data, accept) => { if (operation === 'image.request.get') { const result = accept(textInput); return { projectId, requestId, operation: 'image.generate', response: result }; } } }); await f.session.load(); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().mode, 'text'); assert.equal(f.session.getState().tasks[0].purpose, undefined); assert.equal(f.approvals.length, 0); f.session.dispose();
});

test('private edit approval body contains only bound review identity and verifies server source metadata', async () => {
  const calls: Array<{url: unknown; init: RequestInit}> = [], original = review();
  const client = createImageReviewClient({ fetchImpl: (async (url: RequestInfo | URL, init: RequestInit = {}) => { calls.push({url, init}); return {ok: true, status: 200, json: async () => ({ok: true, data: task()})}; }) as unknown as typeof fetch });
  await client.approve(original); assert.equal(calls[0].url, '/api/images/reviews/approve'); assert.deepEqual(JSON.parse(String(calls[0].init.body)), { projectId, reviewId: original.id, expectedRevision: 1 }); assert.equal(calls[0].init.credentials, 'same-origin');
  const identity = imageReviewIdentity as (value: unknown) => unknown;
  assert.notEqual(identity(original), identity({...original, sourceImage: {...(original.sourceImage as Record<string, unknown>), name: 'Other.png'}}));
  const bad = createImageReviewClient({ fetchImpl: (async () => ({ok: true, json: async () => ({ok: true, data: task(input(), {sourceImage: {...(original.sourceImage as Record<string, unknown>), name: 'Other.png'}})})})) as unknown as typeof fetch }); await assert.rejects(bad.approve(original as never));
});

// Execute the real component and handlers with deterministic hook slots. No DOM
// string/source matching substitutes for these stale-callback assertions.
const component = readFileSync(new URL('../apps/web/src/ImageGeneration.tsx', import.meta.url), 'utf8');
type EventHandler = (...args: unknown[]) => unknown;
type UiNode = {type?: unknown; props: Record<string, unknown> & {children?: unknown; ref: {current: {value: string}}; onChange: EventHandler; onClick: EventHandler}};
const element = (type: unknown, props: Record<string, unknown> | null = {}, ...children: unknown[]): UiNode => ({type, props: {...(props ?? {}), children} as UiNode['props']});
// This legacy consumer does not supply a navigation registry. The actual Slot
// transparency/handler contract is exercised in settings-navigation-slot.test.
const renderElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): UiNode => type === 'SettingsNavigationSlot' ? (children[0] as (register: () => void) => UiNode)(() => {}) : element(type, props, ...children);
const nodes = (tree: unknown): UiNode[] => Array.isArray(tree) ? tree.flatMap((item: unknown) => nodes(item)) : tree !== null && typeof tree === 'object' && 'props' in tree ? [tree as UiNode, ...nodes((tree as UiNode).props.children)] : [];
interface RenderSlot { [key: string]: unknown; value?: unknown; deps?: unknown; fn?: () => unknown; cleanup?: unknown }
interface RenderState { [key: string]: unknown }
interface Harness {
  render(next?: string): UiNode; find(id: string): UiNode; click(id: string): void; change(id: string, value: unknown): void;
  hide(value: boolean): void; readonly dirty: boolean; unmount(): void;
}
function renderer(f: Fixture): Harness {
  const slots: RenderSlot[] = []; let index = 0; let effects: number[] = []; let visible = true; let tree!: UiNode; let owner = projectId; let dirty = false;
  const same = (a: unknown, b: unknown): boolean => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value: unknown, i: number) => Object.is(value, b[i]));
  const react: RenderState & {default?: RenderState} = {
    createElement: renderElement,
    useState(initial: unknown) {
      const slot = index++; slots[slot] ||= {value: typeof initial === 'function' ? (initial as () => unknown)() : initial};
      const state = slots[slot];
      return [state.value, (value: unknown) => {state.value = typeof value === 'function' ? (value as (current: unknown) => unknown)(state.value) : value;}] as const;
    },
    useRef(initial: unknown) { return slots[index++] ||= {current: initial}; },
    useMemo(fn: () => unknown, deps?: unknown) {
      const slot = index++, existing = slots[slot];
      if (!existing || !same(existing.deps, deps)) slots[slot] = {value: fn(), deps};
      return slots[slot].value;
    },
    useLayoutEffect(fn: () => unknown, deps?: unknown) {
      const slot = index++, previous = slots[slot];
      if (previous && same(previous.deps, deps)) return;
      slots[slot] = {fn, deps, cleanup: previous?.cleanup}; effects.push(slot);
    },
  };
  react.default = react;
  const module: {exports: RenderState} = {exports: {}}, primitive = new Proxy<Record<string, unknown>>({}, {get: (_target, key) => String(key)});
  const require = (name: string): unknown => {
    const i18nDependency = creationTestDependency(name); if (i18nDependency) return i18nDependency;
    if (name === './native-close-sources.ts') return nativeCloseSources;
    if (name === './image-edit-intent.ts') return imageEditIntent;
    if (name === './editor-settings-scope.ts') {
      const settingsModule: {exports: RenderState} = {exports: {}};
      const code = transformSync(readFileSync(new URL('../apps/web/src/editor-settings-scope.ts', import.meta.url), 'utf8'), {loader: 'ts', format: 'cjs'}).code;
      Function('module', 'exports', 'require', code)(settingsModule, settingsModule.exports, (dependency: string) => { assert.equal(dependency, 'react'); return react; });
      return settingsModule.exports;
    }
    if (name === 'react') return react;
    if (name === '@mioon/contracts') return contracts;
    if (name === './image-generation.ts') return {...logic, createImageGenerationSession: (value: Record<string, unknown>) => logic.createImageGenerationSession({...value, api: f.api, storage: f.storage, requestId: () => requestId, setTimer: () => 1, clearTimer() {}} as never)};
    if (name === './workspace-visibility.tsx') return {useWorkspaceVisibility: () => visible};
    if (name === './ImageSettings.tsx' || name === './ComfyImageSettings.tsx') return {__esModule: true, default: name};
    if (name === './SettingsNavigationSlot.tsx') return {__esModule: true, default: 'SettingsNavigationSlot'};
    if (name === './ComfyImageDetails.tsx') return primitive;
    if (name === './image-settings.ts') return {createImageSettingsClient: (value: {slot?: string}) => value?.slot === 'custom' ? f.customSettingsClient : f.settingsClient};
    if (name === './comfy-image-settings.ts') return {comfyConnectorAvailabilityDescriptor, createComfyImageSettingsClient: () => ({read: async () => {throw Error('Not configured');}})};
    if (name === './icons.tsx') return {default: 'Icon'};
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.tsx') return primitive;
    throw Error(name);
  };
  Function('module', 'exports', 'require', transformSync(component, {loader: 'tsx', format: 'cjs'}).code)(module, module.exports, require);
  const renderComponent = module.exports.default as (props: Record<string, unknown>) => UiNode;
  const harness: Harness = {
    render(next: string = owner): UiNode {
      owner = next; index = 0; effects = [];
      tree = renderComponent({projectId: owner, projectName: 'Project', projectAssets: [sourceAsset(), sourceAsset({id: id(21), sha256: 'b'.repeat(64), name: 'Second.png'})], reviewClient: f.reviewClient, settingsClient: f.settingsClient, customSettingsClient: f.customSettingsClient, onDirtyChange: (value: unknown) => {dirty = value === true;}});
      for (const slot of effects) {slots[slot].cleanup = (slots[slot].fn as () => unknown)();}
      return tree;
    },
    find(idValue: string): UiNode { const value = nodes(tree).find(node => node.props['data-testid'] === idValue); assert.ok(value, idValue); return value; },
    click(idValue: string): void {(harness.find(idValue).props.onClick as EventHandler)(); harness.render();},
    change(idValue: string, value: unknown): void {(harness.find(idValue).props.onChange as EventHandler)({target: {value}}); harness.render();},
    hide(value: boolean): void {visible = !value; harness.render();},
    get dirty(): boolean {return dirty;},
    unmount(): void {for (const slot of slots) if (typeof slot.cleanup === 'function') (slot.cleanup as () => void)();},
  };
  return harness;
}
async function uiCompose(ui: Harness): Promise<void> { ui.render(); await flush(); ui.render(); ui.change('image-generation-name', input().name); ui.change('image-generation-prompt', input().prompt); ui.click('image-provider-openai'); ui.click('image-mode-edit'); ui.change('image-source-asset', `${assetId}:${'a'.repeat(64)}`); }

test('actual source handlers retain dirty selection and reject late clicks after source change, tab change and project change', async () => {
  const f = fixture(), ui = renderer(f); await uiCompose(ui); assert.equal(ui.dirty, true); assert.equal((ui.find('image-source-preview').props.children as UiNode[])[0].props.src, `/media/${assetId}`);
  const oldPrepare = ui.find('image-generate').props.onClick, oldSource = ui.find('image-source-asset').props.onChange;
  ui.change('image-source-asset', `${id(21)}:${'b'.repeat(64)}`); oldPrepare(); oldSource({ target: { value: `${assetId}:${'a'.repeat(64)}` } }); ui.render(); assert.equal(ui.find('image-source-asset').props.value, `${id(21)}:${'b'.repeat(64)}`); assert.equal(f.calls.some(call => call.operation === 'image.review.prepare'), false);
  const beforeHide = ui.find('image-generate').props.onClick; ui.hide(true); beforeHide(); ui.hide(false); await flush(); ui.render(); beforeHide(); assert.equal(ui.find('image-generation-prompt').props.value, input().prompt); assert.equal(f.approvals.length, 0);
  const beforeProject = ui.find('image-generate').props.onClick; ui.render(id(99)); await flush(); ui.render(); beforeProject(); assert.equal(ui.find('image-generation-prompt').props.value, ''); assert.equal(f.calls.some(call => call.operation === 'image.review.prepare'), false); ui.unmount(); f.session.dispose();
});

test('actual edit composer prepares first, renders immutable source disclosure, and requires a fresh explicit approval handler', async () => {
  const f = fixture(), ui = renderer(f); await uiCompose(ui); ui.click('image-generate'); await flush(); ui.render(); assert.equal(f.approvals.length, 0); assert.ok(ui.find('image-edit-review-disclosure')); assert.equal(ui.find('image-review-approve').props.disabled, false);
  const oldApprove = ui.find('image-review-approve').props.onClick; ui.hide(true); oldApprove(); ui.hide(false); await flush(); ui.render(); oldApprove(); assert.equal(f.approvals.length, 0);
  ui.click('image-review-approve'); await flush(); ui.render(); assert.equal(f.approvals.length, 1); assert.deepEqual(f.approvals[0].sourceImage, descriptor(sourceAsset())); ui.unmount(); f.session.dispose();
});

test('source rejection never releases a request based on error, fabricated proof or null lookup', async () => {
  for (const mismatch of [null, 'operation', 'projectId', 'requestId', 'inputHash', 'missing']) {
    const f = fixture({ api: (operation, value) => {
      if (operation !== 'image.review.prepare') return;
      const imageOutcome: Record<string, unknown> = { status: 'not_accepted', projectId, operation, requestId: (value.input as Record<string, unknown>).requestId, inputHash: hash(value) };
      if (mismatch && mismatch !== 'missing') imageOutcome[mismatch] = 'wrong';
      throw new ApiError('Untrusted details', 'IMAGE_SOURCE_INVALID', mismatch === 'missing' ? undefined : { imageOutcome });
    } }); await compose(f); await f.session.generatePaid(); assert.equal(Boolean(f.session.getState().pending), true, String(mismatch)); assert.equal(f.session.getState().draft.prompt, input().prompt); assert.deepEqual(f.session.getState().inputImage, input().inputImage); assert.equal(f.approvals.length, 0); f.session.dispose();
  }
});

test('source-change approval stays pending until an explicit verified rejection, then source can change', async () => {
  const f = fixture({ approve: () => { throw new ApiError('Source unavailable', 'IMAGE_SOURCE_INVALID'); } }); await compose(f); await f.session.generatePaid(); await f.session.approveReview(f.session.getState().reviews[0]);
  assert.ok(f.session.getState().pending); assert.equal(f.session.selectSource(sourceAsset({ id: id(21) })), false); assert.equal(f.approvals.length, 1);
  await f.session.rejectReview(f.session.getState().reviews[0]); assert.equal(f.session.getState().pending, null); assert.equal(f.session.selectSource(sourceAsset({ id: id(21) })), true); assert.equal(f.approvals.length, 1); f.session.dispose();
});

test('unsupported edit providers cannot prepare and chosen group revision is never silently replaced', async () => {
  const f = fixture(); await compose(f); for (const providerId of ['openai-compatible', 'comfy-local']) { f.session.selectProvider(providerId); assert.equal(logic.imageCanGenerate(f.session.getState()), false); assert.equal(await f.session.generatePaid(), false); assert.equal(await f.session.prepareComfy(), false); }
  assert.equal(f.calls.some(call => call.operation === 'image.review.prepare'), false); f.session.dispose();
  const g = fixture(); g.data.groups = [{ id: groupId, projectId, name: 'Saved group', revision: 7, headVersionId: null, activeTaskId: null, createdAt: at, updatedAt: at }]; await g.session.load(); await g.session.requestTarget(groupId); g.session.edit('prompt', String(input().prompt)); g.session.selectMode('edit'); g.session.selectSource(sourceAsset());
  assert.deepEqual(g.session.getState().target, { groupId, expectedRevision: 7 }); g.data.groups[0].revision = 8; await g.session.load(); assert.equal(logic.imageCanGenerate(g.session.getState()), false); assert.equal(await g.session.generate(), false); assert.deepEqual(g.session.getState().target, { groupId, expectedRevision: 7 }); g.session.dispose();
});

test('invalid Mock PNG keeps an actionable unknown record across remount, never claims rejection or releases the key', async () => {
  const f = fixture({ api: (operation, value) => { if (operation === 'image.generate') throw new ApiError('Source problem', 'IMAGE_SOURCE_INVALID', { imageOutcome: { status: 'not_accepted', projectId, operation, requestId, inputHash: hash(value) } }); } }); await compose(f, 'mock'); await f.session.generate();
  assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().pending!.input.requestId, requestId); assert.match(f.session.getState().message, /源图核验.*结果仍未知/); assert.doesNotMatch(f.session.getState().message, /未被接受|生成失败/); assert.equal(f.session.selectSource(sourceAsset({ id: id(21) })), false); f.session.dispose();
  const g = fixture({ storage: f.storage }); await g.session.load(); assert.equal(g.session.getState().pending!.sourceIssue, 'IMAGE_SOURCE_INVALID'); assert.match(g.session.getState().message, /50 MB.*4096/); assert.deepEqual(g.session.getState().pending!.input, input({ providerId: 'mock', model: models.mock })); assert.equal(await g.session.generate(), false); assert.equal(g.calls.some(call => call.operation === 'image.generate'), false); g.session.dispose();
});
