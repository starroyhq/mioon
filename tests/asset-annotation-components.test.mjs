import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { translate, renderMessage, formatNumber, validateCatalogs } from '../packages/i18n/src/index.ts';
import * as annotationState from '../apps/web/src/asset-annotation-state.ts';
import { createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
const projectId = '00000000-0000-4000-8000-000000000001', assetId = '00000000-0000-4000-8000-000000000002';
const compile = file => transformSync(readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), { loader: file.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs' }).code;
function hooksHarness() {
  const hooks = []; let cursor = 0, pending = [];
  const effect = (fn, deps) => { const at = cursor++, old = hooks[at]; if (!old || !deps || deps.some((v, i) => v !== old.deps?.[i])) { hooks[at] = { ...old, fn, deps }; pending.push(at); } };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'fragment',
    useRef: value => hooks[cursor++] ||= { current: value },
    useState(value) { const at = cursor++; hooks[at] ||= { value }; return [hooks[at].value, next => { hooks[at].value = typeof next === 'function' ? next(hooks[at].value) : next; }]; },
    useMemo(fn, deps) { const at = cursor++, old = hooks[at]; if (!old || deps.some((v, i) => v !== old.deps[i])) hooks[at] = { value: fn(), deps }; return hooks[at].value; },
    useLayoutEffect: effect, useEffect: effect };
  return { react, reset() { cursor = 0; }, flush() { for (const at of pending) { hooks[at].cleanup?.(); hooks[at].cleanup = hooks[at].fn(); } pending = []; }, cleanup() { hooks.forEach(h => h.cleanup?.()); }, replayEffects() { hooks.forEach(h => h.cleanup?.()); hooks.forEach(h => { if (h.fn) h.cleanup = h.fn(); }); } };
}
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : (Array.isArray(node) ? node : node.children || []).map(child => find(child, predicate)).find(Boolean);
function component(locale = 'en') {
  const h = hooksHarness(), module = { exports: {} }; let visible = true, tree, saved = 0, edited = [], discarded = [], props;
  const state = { scope: 's', ownerScope: 'o', projectId, assetIds: [assetId], version: 1, dirtyCount: 1, uncertainCount: 0, entries: { [assetId]: { row: { revision: 0, tags: [], note: '' }, draft: { tags: ['<tag>'], note: '<b>literal</b>', tagInput: '' }, dirty: true, verified: true, loading: false, saving: false, uncertain: false, conflict: false } } };
  const controller = { getState: () => state, save: () => saved++, editNote: (id, note) => edited.push([id, note]), editTagInput() {}, addTag() {}, removeTag() {}, clear() {}, discard() {}, refresh() {}, discardRetained: version => discarded.push(version) };
  props = { asset: { id: assetId, projectId, name: 'Named asset' }, state, controller, blocked: false, confirm: async () => true };
  Function('module', 'exports', 'require', compile('AssetAnnotations.tsx'))(module, module.exports, name => name === 'react' ? h.react : name.includes('I18nProvider') ? { useI18n: () => ({ t: (key, params) => translate(locale, key, params), renderMessage: value => renderMessage(locale, value), formatNumber: value => formatNumber(locale, value) }) } : name.includes('workspace-visibility') ? { useWorkspaceVisibility: () => visible } : name.includes('/button') ? { Button: 'button' } : name.includes('/input') ? { Input: 'input' } : assert.fail(name));
  return { props, state, saved: () => saved, edited, discarded,
    render(patch = {}) { Object.assign(props, patch); h.reset(); tree = module.exports.default(props); h.flush(); return tree; },
    find: id => find(tree, node => node.props?.['data-testid'] === id), hide() { visible = false; }, unmount: h.cleanup };
}
test('actual annotation TSX renders four locales, plain text and Save/Clear/Discard/Refresh controls', () => {
  assert.deepEqual(validateCatalogs(), []);
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    const h = component(locale), tree = h.render();
    assert.equal(h.find('annotation-save').children[0], translate(locale, 'annotations.save'));
    assert.equal(h.find('annotation-note').props.value, '<b>literal</b>');
    assert.equal(find(tree, node => Object.hasOwn(node.props || {}, 'dangerouslySetInnerHTML')), undefined);
    for (const name of ['save', 'clear', 'discard', 'refresh']) assert.ok(h.find(`annotation-${name}`));
    h.find('annotation-save').props.onClick(); assert.equal(h.saved(), 1);
  }
});
test('old target, hidden/collapsed and unmounted handlers cannot mutate newer selection', () => {
  for (const mode of ['selection', 'hidden', 'collapsed', 'unmounted']) {
    const h = component(); h.render(); const save = h.find('annotation-save').props.onClick, edit = h.find('annotation-note').props.onChange;
    if (mode === 'selection') h.render({ asset: { id: 'different', projectId, name: 'Other' } });
    if (mode === 'hidden') { h.hide(); h.render(); }
    if (mode === 'collapsed') h.render({ visible: false });
    if (mode === 'unmounted') h.unmount();
    save(); edit({ target: { value: 'obsolete' } }); assert.equal(h.saved(), 0, mode); assert.deepEqual(h.edited, [], mode);
  }
});
test('foreign-project asset never exposes note fields, uncertainty and restore disable writes', () => {
  const h = component(); h.render({ asset: { id: assetId, projectId: 'foreign', name: 'Foreign' } }); assert.equal(h.find('annotation-note'), undefined);
  h.render({ asset: { id: assetId, projectId, name: 'Owned' }, restored: true }); assert.equal(h.find('annotation-save').props.disabled, true); assert.equal(h.find('annotation-note').props.disabled, true);
  h.state.entries[assetId].uncertain = true; h.render({ restored: false }); assert.equal(h.find('annotation-discard').props.disabled, true); assert.equal(h.find('annotation-clear').props.disabled, true); assert.ok(h.find('annotation-tasks'));
});
test('discard-all confirmation is snapshot-bound and does not act after navigation', async () => {
  const h = component(); let resolve; h.render({ confirm: () => new Promise(r => resolve = r) });
  const action = h.find('annotation-discard-all').props.onClick(); h.render({ visible: false }); resolve(true); await action;
  assert.deepEqual(h.discarded, []);
});
test('actual hook survives StrictMode cleanup/setup and publishes native-close dirtiness', async () => {
  const h = hooksHarness(), module = { exports: {} }, events = new Map();
  const window = { addEventListener: (name, cb) => events.set(name, cb), removeEventListener: name => events.delete(name) }, document = { ...window, visibilityState: 'visible' };
  Function('module', 'exports', 'require', 'window', 'document', compile('use-asset-annotations.ts'))(module, module.exports, name => name === 'react' ? h.react : name === './asset-annotation-state.ts' ? annotationState : assert.fail(name), window, document);
  const registry = createNativeCloseRegistry(), options = { scope: 's', ownerScope: 'o', projectId, assets: [{ id: assetId, projectId }], read: async () => ({ projectId, items: [{ id: assetId, assetId, projectId, revision: 0, tags: [], note: '' }] }), save: async () => ({ result: null }), canSave: () => true, hasPending: () => false, pendingState: [], refreshGeneration: 0, registry };
  h.reset(); const result = module.exports.useAssetAnnotations(options); h.flush(); h.replayEffects(); await new Promise(r => setImmediate(r));
  result.controller.editNote(assetId, 'retained'); assert.equal(result.controller.getState().entries[assetId].draft.note, 'retained');
  assert.equal(registry.capture()[0].dirty, true); h.cleanup(); assert.equal(registry.capture().length, 0);
});

test('discard-all confirmation survives an unrelated dialog rerender', async () => {
  const h = component(); let resolve; h.render({ confirm: () => new Promise(r => resolve = r) });
  const action = h.find('annotation-discard-all').props.onClick(); h.render(); resolve(true); await action;
  assert.deepEqual(h.discarded, [1]);
});
test('actual AssetLibrary composes saved tag, type, name, disposition and unused filters, retaining unknown rows', async () => {
  const dispositions = await import('../apps/web/src/asset-disposition-state.js');
  const projectId = 'project', ids = ['match', 'wrongTag', 'unknown', 'used', 'rejected', 'wrongType', 'wrongName', 'foreign'];
  const assets = ids.map(id => ({ id, projectId: id === 'foreign' ? 'foreign' : projectId, name: id === 'wrongName' ? 'other' : `needle ${id}`, mimeType: id === 'wrongType' ? 'audio/wav' : 'image/png', sizeBytes: 100 }));
  const state = { scope: 's', entries: Object.fromEntries(ids.map(id => [id, { phase: 'ready', row: { disposition: id === 'rejected' ? 'rejected' : 'favorite' } }])) };
  const annotations = { state: { scope: 's', ownerScope: 'owner', projectId, assetIds: ids, entries: Object.fromEntries(ids.filter(id => id !== 'unknown').map(id => [id, { verified: true, row: { tags: id === 'wrongTag' ? ['different'] : ['tag'] } }])) }, controller: {} };
  let stateIndex = 0, captured;
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), useState: () => [ [{ scope: projectId, value: 'assets' }, { scope: 's', value: 'favorite' }, { scope: 'owner', value: 'tag' }][stateIndex++], () => {} ] };
  const module = { exports: {} }, primitives = new Proxy({}, { get: (_, key) => String(key) });
  const code = transformSync(readFileSync(new URL('../apps/web/src/AssetLibrary.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  Function('module', 'exports', 'require', code)(module, module.exports, name => {
    if (name === 'react') return react;
    if (name.includes('I18nProvider')) return { useI18n: () => ({ t: (key, params) => translate('en', key, params), renderMessage: value => renderMessage('en', value), formatNumber: value => String(value) }) };
    if (name === './asset-annotation-state.ts') return annotationState;
    if (name === './asset-disposition-state.js') return dispositions;
    if (name === './AssetDispositionControls.jsx') return { __esModule: true, default: 'disposition', useDispositionInteraction: () => ({ visible: true, admit: action => action() }) };
    if (name === './AssetTimelineUsage.tsx') return { __esModule: true, default: 'usage', AssetTimelineUsageFilters: 'usage-filter', useAssetTimelineUsageFilter: input => { captured = input.assets; return { visibleAssets: input.assets.filter(asset => asset.id !== 'used'), filter: 'unused', reset() {}, choose() {} }; } };
    // Layout owns presentation only; keep the real annotation/disposition
    // filters and their input to the usage filter under test below.
    if (name === './AssetLibraryToolbar.tsx') return { __esModule: true, default: 'asset-library-toolbar', useAssetLibraryLayout: scope => { assert.equal(scope, projectId); return { layout: 'grid', setLayout() {} }; } };
    if (name === './Timeline.jsx') return { assetKind: () => 'image', dragAsset() {} };
    if (name === './AssetAnnotations.tsx') return { __esModule: true, default: 'annotations-editor' };
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@mioon/') || ['./WorkspaceControls.jsx', './workspace-visibility.jsx', './Nodes.jsx'].includes(name)) return primitives;
    return { __esModule: true, default: name };
  });
  const tree = module.exports.default({ assets, filter: 'image', search: 'needle', project: { id: projectId }, busy: {}, dispositions: { state, controller: {} }, annotations, selectedAsset: assets[1], timelineUsage: {}, onFilter() {}, onSearch() {} });
  assert.deepEqual(captured.map(asset => asset.id), ['match', 'unknown', 'used']);
  assert.ok(find(tree, node => node.props?.['data-testid'] === 'asset-card-match'));
  assert.ok(find(tree, node => node.props?.['data-testid'] === 'asset-card-unknown'));
  assert.equal(find(tree, node => node.props?.['data-testid'] === 'asset-card-used'), undefined);
  const selectedOutside = find(tree, node => node.props?.['data-testid'] === 'asset-filter-selected-outside');
  assert.ok(selectedOutside, 'Filtering preserves the selected asset outside the result list');
  assert.equal(find(selectedOutside, node => node.type === 'disposition').props.asset.id, 'wrongTag');
  assert.equal(find(tree, node => node.type === 'annotations-editor'), undefined, 'Annotation editing now belongs to Inspector');
  assert.ok(find(tree, node => node.props?.['data-testid'] === 'annotation-unverified-unknown'));
});
