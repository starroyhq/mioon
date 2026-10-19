import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { translate } from '../packages/i18n/src/index.ts';

function harness(file, props, onConnect) {
  const code = transformSync(readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
  const hooks = [], pending = [];
  let cursor = 0, tree, visible = true;
  const effect = (fn, deps) => { const at = cursor++, old = hooks[at]; if (!old || !deps || deps.some((value, i) => value !== old.deps?.[i])) pending.push(() => { old?.cleanup?.(); hooks[at] = { deps, cleanup: fn() }; }); };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'fragment', useLayoutEffect: effect,
    useRef: value => { const at = cursor++; return hooks[at] ||= { current: value }; },
    useState: value => { const at = cursor++; hooks[at] ||= { value }; return [hooks[at].value, next => { hooks[at].value = typeof next === 'function' ? next(hooks[at].value) : next; }]; },
    useMemo: (fn, deps) => { const at = cursor++, old = hooks[at]; if (!old || deps.some((value, i) => value !== old.deps[i])) hooks[at] = { deps, value: fn() }; return hooks[at].value; } };
  const module = { exports: {} };
  Function('module', 'exports', 'require', code)(module, module.exports, name => {
    if (name === 'react') return react;
    if (name.includes('I18nProvider')) return { useI18n: () => ({ t: (key, params) => translate('zh-Hans', key, params), formatNumber: value => String(value) }) };
    if (name.includes('workspace-visibility')) return { useWorkspaceVisibility: () => visible, WorkspaceVisibilityProvider: 'Visibility' };
    if (name.endsWith('.css')) return {};
    return new Proxy({}, { get: (_, key) => key === '__esModule' ? true : String(key) });
  });
  const all = (node, predicate, results = []) => { if (node && typeof node === 'object') { if (predicate(node)) results.push(node); for (const child of Array.isArray(node) ? node : node.children || []) all(child, predicate, results); } return results; };
  function render(patch = {}) { Object.assign(props, patch); cursor = 0; tree = module.exports.default(props); onConnect?.(tree); while (pending.length) pending.shift()(); return tree; }
  return { render, find: id => all(tree, node => node.props?.['data-testid'] === id)[0], all: predicate => all(tree, predicate), props,
    visible(value) { visible = value; }, unmount() { hooks.forEach(hook => hook.cleanup?.()); } };
}
test('library chips, layout and filter portal retire across hide/reopen and project ownership', () => {
  const actions = [], props = { scope: 'project-1:epoch', visible: true, count: 4, layout: 'grid', onLayout: value => actions.push(value), search: 'search', chips: [{ key: 'video', label: 'Video', remove: () => actions.push('remove') }], children: 'real filters' };
  const h = harness('AssetLibraryToolbar.tsx', props); h.render();
  const list = h.find('asset-layout-list').props.onClick;
  const chip = h.all(node => node.type === 'WorkbenchChip')[0].props.onClick;
  const popover = h.all(node => node.type === 'WorkbenchPopover')[0].props.onOpenChange;
  list(); chip(); popover(true); h.render(); assert.deepEqual(actions, ['list', 'remove']); assert.equal(h.all(node => node.type === 'WorkbenchPopover')[0].props.open, true);
  h.render({ visible: false }); list(); chip(); popover(true); h.render(); assert.equal(h.all(node => node.type === 'WorkbenchPopover')[0].props.open, false); assert.equal(actions.length, 2);
  h.render({ visible: true, scope: 'project-2:epoch' }); list(); chip(); popover(true); h.render(); assert.equal(actions.length, 2); assert.equal(h.all(node => node.type === 'WorkbenchPopover')[0].props.open, false);
  h.find('asset-layout-list').props.onClick(); assert.equal(actions.at(-1), 'list'); h.unmount();
});
test('storyboard dragging and selection retain source asset but cannot reorder another project or hidden surface', () => {
  const calls = [], props = { scope: 'p1', open: true, onOpenChange() {}, shots: [{ id: 's1', title: 'First', duration: 2, selectedVersionId: 'v1' }, { id: 's2', title: 'Second', duration: 3 }], versions: [{ id: 'v1', assetId: 'a1', number: 1, snapshot: { duration: 4 } }], selectedId: 's1', reordering: false, assetDragType: 'application/asset', onSelect: id => calls.push(['select', id]), onReorder: (id, index) => calls.push(['reorder', id, index]), onAddShot() {}, renderThumbnail: () => 'thumb' };
  const h = harness('StoryboardStrip.tsx', props); h.render();
  const data = {}, first = h.find('storyboard-shot-s1');
  first.props.onDragStart({ dataTransfer: { setData: (key, value) => { data[key] = value; } }, preventDefault() { assert.fail('valid drag'); } });
  assert.deepEqual(data, { 'text/plain': 's1', 'application/asset': 'a1' }); h.render();
  const oldDrop = h.find('storyboard-shot-s2').props.onDrop;
  oldDrop({ preventDefault() {} }); assert.deepEqual(calls.at(-1), ['reorder', 's1', 1]); h.render();
  const oldSelect = h.all(node => node.props?.className === 'storyboard-preview')[0].props.onClick;
  h.render({ scope: 'p2' }); oldDrop({ preventDefault() {} }); oldSelect(); assert.equal(calls.length, 1);
  h.visible(false); h.render(); h.all(node => node.props?.className === 'storyboard-preview')[0].props.onClick(); assert.equal(calls.length, 1); h.unmount();
});
test('storyboard separate move controls retain order boundaries and retire stale callbacks', () => {
  const calls = [], props = { scope: 'p1', open: true, onOpenChange() {}, shots: [{ id: 's1', title: 'First', duration: 2 }, { id: 's2', title: 'Second', duration: 3 }], versions: [], selectedId: null, reordering: false, assetDragType: 'application/asset', onSelect: id => calls.push(['select', id]), onReorder: (id, index) => calls.push(['reorder', id, index]), onAddShot() {}, renderThumbnail: () => 'thumb' };
  const h = harness('StoryboardStrip.tsx', props); h.render();
  const move = (name, direction) => h.all(node => node.type === 'WorkbenchButton' && node.props?.['aria-label'] === translate('zh-Hans', `storyboard.${direction}`, { name }))[0];
  assert.equal(move('First', 'moveEarlier').props.disabled, true); assert.equal(move('Second', 'moveLater').props.disabled, true);
  const later = move('First', 'moveLater').props.onClick, earlier = move('Second', 'moveEarlier').props.onClick;
  later(); earlier(); assert.deepEqual(calls, [['reorder', 's1', 1], ['reorder', 's2', 0]]);
  h.render({ reordering: true }); assert.ok(h.all(node => node.type === 'WorkbenchButton' && /将/.test(node.props?.['aria-label'] || '')).every(node => node.props.disabled));
  h.render({ reordering: false, scope: 'p2' }); later(); earlier(); assert.equal(calls.length, 2);
  const next = move('First', 'moveLater').props.onClick; h.render({ open: false }); next(); assert.equal(calls.length, 2);
  h.visible(false); h.render({ open: true }); move('First', 'moveLater').props.onClick(); assert.equal(calls.length, 2); h.unmount();
});
test('compact node player preserves explicit seek and pauses late play after its source is replaced', async () => {
  let resolvePlay, playCalls = 0, pauses = 0;
  const video = { isConnected: true, paused: true, ended: false, currentTime: 0, duration: 4,
    play() { playCalls++; this.paused = false; return new Promise(resolve => { resolvePlay = resolve; }); }, pause() { pauses++; this.paused = true; } };
  let element = video, mediaEvents;
  const h = harness('CompactNodePlayer.tsx', { sourceKey: 'v1', renderMedia: events => { mediaEvents = events; return 'video'; } }, tree => { tree.props.ref.current = { querySelector: () => element }; });
  h.render(); mediaEvents.onLoadedMetadata({ currentTarget: video }); h.render();
  const range = h.all(node => node.type === 'input')[0]; range.props.onChange({ target: { value: '3' } }); assert.equal(video.currentTime, 3);
  h.all(node => node.type === 'WorkbenchButton')[0].props.onClick({ stopPropagation() {} }); assert.equal(playCalls, 1);
  const next = { ...video, paused: true, pause() {} }; element = next; h.render({ sourceKey: 'v2' });
  resolvePlay(); await Promise.resolve(); assert.equal(video.paused, true); assert.ok(pauses > 0);
  h.visible(false); h.render(); h.all(node => node.type === 'WorkbenchButton')[0].props.onClick({ stopPropagation() {} }); assert.equal(playCalls, 1); h.unmount();
});
