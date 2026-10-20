import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { translate, renderMessage, formatNumber, validateCatalogs } from '../packages/i18n/src/index.ts';
import type { Locale } from '../packages/i18n/src/index.ts';
import * as annotationState from '../apps/web/src/asset-annotation-state.ts';
import { createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
const projectId = '00000000-0000-4000-8000-000000000001', assetId = '00000000-0000-4000-8000-000000000002';
interface TestNode { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
interface HookRecord { current?: unknown; value?: unknown; fn?: () => (() => void) | void; deps?: unknown[]; cleanup?: (() => void) | void }
const propsOf = (node: TestNode | null | undefined): Record<string, unknown> => { assert.ok(node); return node.props ?? {}; };
const firstChild = (node: TestNode | null | undefined): unknown => { assert.ok(node); return (node.children ?? [])[0]; };
const compile = (file: string): string => transformSync(readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), { loader: file.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs' }).code;
function hooksHarness() {
  const hooks: HookRecord[] = []; let cursor = 0, pending: number[] = [];
  const effect = (fn: () => (() => void) | void, deps?: unknown[]): void => { const at = cursor++, old = hooks[at]; if (!old || !deps || deps.some((v, i) => v !== old.deps?.[i])) { hooks[at] = { ...old, fn, deps }; pending.push(at); } };
  const react = { createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): TestNode => ({ type, props: props ?? {}, children }), Fragment: 'fragment',
    useRef: (value: unknown): HookRecord => hooks[cursor++] ||= { current: value },
    useState(value: unknown): [unknown, (next: unknown) => void] { const at = cursor++; hooks[at] ||= { value }; return [hooks[at].value, (next: unknown) => { hooks[at].value = typeof next === 'function' ? (next as (current: unknown) => unknown)(hooks[at].value) : next; }]; },
    useMemo(fn: () => unknown, deps: unknown[]): unknown { const at = cursor++, old = hooks[at]; if (!old || deps.some((v, i) => v !== old.deps?.[i])) hooks[at] = { value: fn(), deps }; return hooks[at].value; },
    useLayoutEffect: effect, useEffect: effect };
  return { react, reset() { cursor = 0; }, flush() { for (const at of pending) { const hook = hooks[at]; if (!hook) continue; hook.cleanup?.(); hook.cleanup = hook.fn?.(); } pending = []; }, cleanup() { hooks.forEach(hook => hook.cleanup?.()); }, replayEffects() { hooks.forEach(hook => hook.cleanup?.()); hooks.forEach(hook => { if (hook.fn) hook.cleanup = hook.fn(); }); } };
}
const find = (node: unknown, predicate: (node: TestNode) => boolean): TestNode | undefined => { if (!node || typeof node !== 'object') return undefined; const value = node as TestNode; if (predicate(value)) return value; const children = Array.isArray(node) ? node : value.children ?? []; for (const child of children) { const found = find(child, predicate); if (found) return found; } return undefined; };
interface AnnotationStateEntry { row: { revision: number; tags: string[]; note: string }; draft: { tags: string[]; note: string; tagInput: string }; dirty: boolean; verified: boolean; loading: boolean; saving: boolean; uncertain: boolean; conflict: boolean }
interface ComponentHarness { props: Record<string, unknown>; state: { scope: string; ownerScope: string; projectId: string; assetIds: string[]; version: number; dirtyCount: number; uncertainCount: number; entries: Record<string, AnnotationStateEntry> }; saved(): number; edited: [string, string][]; discarded: number[]; render(patch?: Record<string, unknown>): TestNode; find(id: string): TestNode | undefined; hide(): void; unmount(): void }
function component(locale: Locale = 'en'): ComponentHarness {
  const h = hooksHarness(), module: { exports: Record<string, unknown> } = { exports: {} }; let visible = true, tree: TestNode | undefined, saved = 0, edited: [string, string][] = [], discarded: number[] = []; let props: Record<string, unknown>;
  const state = { scope: 's', ownerScope: 'o', projectId, assetIds: [assetId], version: 1, dirtyCount: 1, uncertainCount: 0, entries: { [assetId]: { row: { revision: 0, tags: [], note: '' }, draft: { tags: ['<tag>'], note: '<b>literal</b>', tagInput: '' }, dirty: true, verified: true, loading: false, saving: false, uncertain: false, conflict: false } } };
  const controller = { getState: () => state, save: () => { saved++; }, editNote: (id: string, note: string) => { edited.push([id, note]); }, editTagInput() {}, addTag() {}, removeTag() {}, clear() {}, discard() {}, refresh() {}, discardRetained: (version: number) => { discarded.push(version); } };
  props = { asset: { id: assetId, projectId, name: 'Named asset' }, state, controller, blocked: false, confirm: async () => true };
  Function('module', 'exports', 'require', compile('AssetAnnotations.tsx'))(module, module.exports, (name: string) => name === 'react' ? h.react : name.includes('I18nProvider') ? { useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => translate(locale, key as never, params as never), renderMessage: (value: unknown) => renderMessage(locale, value as never), formatNumber: (value: number) => formatNumber(locale, value) }) } : name.includes('AgentEditingBoundary') ? { __esModule: true, default: 'editing-boundary' } : name.includes('workspace-visibility') ? { useWorkspaceVisibility: () => visible } : name.includes('/button') ? { Button: 'button' } : name.includes('/input') ? { Input: 'input' } : name.includes('/textarea') ? { Textarea: 'textarea' } : assert.fail(name));
  const componentDefault = (module.exports as { default: (componentProps: Record<string, unknown>) => TestNode }).default;
  return { props, state, saved: () => saved, edited, discarded,
    render(patch: Record<string, unknown> = {}) { Object.assign(props, patch); h.reset(); tree = componentDefault(props); h.flush(); return tree; },
    find: (id: string) => find(tree, node => node.props?.['data-testid'] === id), hide() { visible = false; }, unmount: h.cleanup };
}
test('actual annotation TSX renders four locales, plain text and Save/Clear/Discard/Refresh controls', () => {
  assert.deepEqual(validateCatalogs(), []);
  for (const locale of (['zh-Hans', 'zh-Hant', 'en', 'ja'] as Locale[])) {
    const h = component(locale), tree = h.render();
    assert.equal(firstChild(h.find('annotation-save')), translate(locale, 'annotations.save'));
    assert.equal(propsOf(h.find('annotation-note')).value, '<b>literal</b>');
    assert.equal(find(tree, node => Object.hasOwn(node.props ?? {}, 'dangerouslySetInnerHTML')), undefined);
    for (const name of ['save', 'clear', 'discard', 'refresh']) assert.ok(h.find(`annotation-${name}`));
    (propsOf(h.find('annotation-save')).onClick as () => void)(); assert.equal(h.saved(), 1);
  }
});
test('old target, hidden/collapsed and unmounted handlers cannot mutate newer selection', () => {
  for (const mode of ['selection', 'hidden', 'collapsed', 'unmounted']) {
    const h = component(); h.render(); const save = propsOf(h.find('annotation-save')).onClick as () => void, edit = propsOf(h.find('annotation-note')).onChange as (event: { target: { value: string } }) => void;
    if (mode === 'selection') h.render({ asset: { id: 'different', projectId, name: 'Other' } });
    if (mode === 'hidden') { h.hide(); h.render(); }
    if (mode === 'collapsed') h.render({ visible: false });
    if (mode === 'unmounted') h.unmount();
    save(); edit({ target: { value: 'obsolete' } }); assert.equal(h.saved(), 0, mode); assert.deepEqual(h.edited, [], mode);
  }
});
test('foreign-project asset never exposes note fields, uncertainty and restore disable writes', () => {
  const h = component(); h.render({ asset: { id: assetId, projectId: 'foreign', name: 'Foreign' } }); assert.equal(h.find('annotation-note'), undefined);
  h.render({ asset: { id: assetId, projectId, name: 'Owned' }, restored: true }); assert.equal(propsOf(h.find('annotation-save')).disabled, true); assert.equal(propsOf(h.find('annotation-note')).disabled, true);
  const entry = h.state.entries[assetId]; assert.ok(entry); entry.uncertain = true; h.render({ restored: false }); assert.equal(propsOf(h.find('annotation-discard')).disabled, true); assert.equal(propsOf(h.find('annotation-clear')).disabled, true); assert.ok(h.find('annotation-tasks'));
});
test('discard-all confirmation is snapshot-bound and does not act after navigation', async () => {
  const h = component(); let resolve: ((value: boolean) => void) | undefined; h.render({ confirm: () => new Promise<boolean>(r => { resolve = r; }) });
  const action = (propsOf(h.find('annotation-discard-all')).onClick as () => Promise<void>)(); h.render({ visible: false }); assert.ok(resolve); resolve(true); await action;
  assert.deepEqual(h.discarded, []);
});
test('actual hook survives StrictMode cleanup/setup and publishes native-close dirtiness', async () => {
  const h = hooksHarness(), module: { exports: Record<string, unknown> } = { exports: {} }, events = new Map<string, (event: unknown) => void>();
  const window = { addEventListener: (name: string, cb: (event: unknown) => void) => { events.set(name, cb); }, removeEventListener: (name: string) => { events.delete(name); } }, document = { ...window, visibilityState: 'visible' };
  Function('module', 'exports', 'require', 'window', 'document', compile('use-asset-annotations.ts'))(module, module.exports, (name: string) => name === 'react' ? h.react : name === './asset-annotation-state.ts' ? annotationState : assert.fail(name), window, document);
  const registry = createNativeCloseRegistry(), options = { scope: 's', ownerScope: 'o', projectId, assets: [{ id: assetId, projectId }], read: async () => ({ projectId, items: [{ id: assetId, assetId, projectId, revision: 0, tags: [], note: '' }] }), save: async () => ({ result: null }), canSave: () => true, hasPending: () => false, pendingState: [], refreshGeneration: 0, registry };
  h.reset(); const result = (module.exports as { useAssetAnnotations: (value: unknown) => { controller: Parameters<typeof annotationState.createAssetAnnotationController>[0] extends never ? never : ReturnType<typeof annotationState.createAssetAnnotationController> } }).useAssetAnnotations(options); h.flush(); h.replayEffects(); await new Promise<void>(r => { setImmediate(r); });
  result.controller.editNote(assetId, 'retained'); const retainedEntry = (result.controller.getState().entries as Record<string, AnnotationStateEntry | undefined>)[assetId]; assert.ok(retainedEntry); assert.equal(retainedEntry.draft.note, 'retained');
  const capturedClose = registry.capture()[0]; assert.ok(capturedClose); assert.equal(capturedClose.dirty, true); h.cleanup(); assert.equal(registry.capture().length, 0);
});

test('discard-all confirmation survives an unrelated dialog rerender', async () => {
  const h = component(); let resolve: ((value: boolean) => void) | undefined; h.render({ confirm: () => new Promise<boolean>(r => { resolve = r; }) });
  const action = (propsOf(h.find('annotation-discard-all')).onClick as () => Promise<void>)(); h.render(); assert.ok(resolve); resolve(true); await action;
  assert.deepEqual(h.discarded, [1]);
});
test('actual AssetLibrary composes saved tag, type, name, disposition and unused filters, retaining unknown rows', async () => {
  const dispositions = await import('../apps/web/src/asset-disposition-state.ts');
  const projectId = 'project', ids: string[] = ['match', 'wrongTag', 'unknown', 'used', 'rejected', 'wrongType', 'wrongName', 'foreign'];
  const assets = ids.map((id: string) => ({ id, projectId: id === 'foreign' ? 'foreign' : projectId, name: id === 'wrongName' ? 'other' : `needle ${id}`, mimeType: id === 'wrongType' ? 'audio/wav' : 'image/png', sizeBytes: 100 }));
  const state = { scope: 's', entries: Object.fromEntries(ids.map((id: string) => [id, { phase: 'ready', row: { disposition: id === 'rejected' ? 'rejected' : 'favorite' } }])) };
  const annotations = { state: { scope: 's', ownerScope: 'owner', projectId, assetIds: ids, entries: Object.fromEntries(ids.filter((id: string) => id !== 'unknown').map((id: string) => [id, { verified: true, row: { tags: id === 'wrongTag' ? ['different'] : ['tag'] } }])) }, controller: {} };
  let stateIndex = 0, captured: { id: string }[] | undefined;
  const react = { createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): TestNode => ({ type, props: props ?? {}, children }), useState: () => [ ([{ scope: projectId, value: 'assets' }, { scope: 's', value: 'favorite' }, { scope: 'owner', value: 'tag' }])[stateIndex++], () => {} ] };
  const module: { exports: Record<string, unknown> } = { exports: {} }, primitives = new Proxy({} as Record<string, unknown>, { get: (_target: unknown, key: string) => String(key) });
  const code = transformSync(readFileSync(new URL('../apps/web/src/AssetLibrary.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
  Function('module', 'exports', 'require', code)(module, module.exports, (name: string) => {
    if (name === 'react') return react;
    if (name.includes('I18nProvider')) return { useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => translate('en', key as never, params as never), renderMessage: (value: unknown) => renderMessage('en', value as never), formatNumber: (value: number) => String(value) }) };
    if (name === './asset-annotation-state.ts') return annotationState;
    if (name === './asset-disposition-state.ts') return dispositions;
    if (name === './AssetDispositionControls.tsx') return { __esModule: true, default: 'disposition', useDispositionInteraction: () => ({ visible: true, admit: (action: () => unknown) => action() }) };
    if (name === './AssetTimelineUsage.tsx') return { __esModule: true, default: 'usage', AssetTimelineUsageFilters: 'usage-filter', useAssetTimelineUsageFilter: (input: { assets: { id: string }[] }) => { captured = input.assets; return { visibleAssets: input.assets.filter((asset: { id: string }) => asset.id !== 'used'), filter: 'unused', reset() {}, choose() {} }; } };
    // Layout owns presentation only; keep the real annotation/disposition
    // filters and their input to the usage filter under test below.
    if (name === './AssetLibraryToolbar.tsx') return { __esModule: true, default: 'asset-library-toolbar', useAssetLibraryLayout: (scope: string) => { assert.equal(scope, projectId); return { layout: 'grid', setLayout() {} }; } };
    if (name === './Timeline.tsx') return { assetKind: () => 'image', dragAsset() {} };
    if (name === './AssetAnnotations.tsx') return { __esModule: true, default: 'annotations-editor' };
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@mioon/') || ['./WorkspaceControls.tsx', './workspace-visibility.tsx', './Nodes.tsx'].includes(name)) return primitives;
    return { __esModule: true, default: name };
  });
  const tree = (module.exports as { default: (componentProps: Record<string, unknown>) => TestNode }).default({ assets, filter: 'image', search: 'needle', project: { id: projectId }, busy: {}, dispositions: { state, controller: {} }, annotations, selectedAsset: assets[1], timelineUsage: {}, onFilter() {}, onSearch() {} });
  assert.ok(captured); assert.deepEqual(captured.map((asset: { id: string }) => asset.id), ['match', 'unknown', 'used']);
  assert.ok(find(tree, node => node.props?.['data-testid'] === 'asset-card-match'));
  assert.ok(find(tree, node => node.props?.['data-testid'] === 'asset-card-unknown'));
  assert.equal(find(tree, node => node.props?.['data-testid'] === 'asset-card-used'), undefined);
  const selectedOutside = find(tree, node => node.props?.['data-testid'] === 'asset-filter-selected-outside');
  assert.ok(selectedOutside, 'Filtering preserves the selected asset outside the result list');
  const dispositionNode = find(selectedOutside, node => node.type === 'disposition'); assert.ok(dispositionNode); const dispositionAsset = (dispositionNode.props as { asset?: { id?: string } }).asset; assert.ok(dispositionAsset); assert.equal(dispositionAsset.id, 'wrongTag');
  assert.equal(find(tree, node => node.type === 'annotations-editor'), undefined, 'Annotation editing now belongs to Inspector');
  assert.ok(find(tree, node => node.props?.['data-testid'] === 'annotation-unverified-unknown'));
});

test('annotation protection uses the actual asset owner and cannot release a dirty or unknown draft', () => {
  const h = component(), tree = h.render();
  assert.equal(tree.type, 'editing-boundary');
  assert.equal(tree.props?.projectId, projectId);
  assert.deepEqual(tree.props?.targets, [{kind:'asset_annotation',id:assetId,revision:0}]);
  const release = tree.props?.canRelease as () => boolean;
  assert.equal(release(), false);
  h.state.entries[assetId].dirty = false;
  assert.equal(release(), true);
  h.state.entries[assetId].uncertain = true;
  assert.equal(release(), false);
});
