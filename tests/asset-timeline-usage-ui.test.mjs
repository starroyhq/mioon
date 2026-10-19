import { i18nTestModule, renderMessage as renderI18nMessage, message as msg } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { deriveTimelineAssetUsage, retainTimelineAssetUsage } from '../apps/web/src/timeline-asset-usage.ts';
import { dispositionCounts, dispositionFilters, filterLibraryAssets } from '../apps/web/src/asset-disposition-state.ts';
import * as annotations from '../apps/web/src/asset-annotation-state.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(path.join(root, 'apps/web/src/AssetTimelineUsage.tsx'), 'utf8');
const librarySource = readFileSync(path.join(root, 'apps/web/src/AssetLibrary.tsx'), 'utf8');
const id = n => `cb000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), otherProject = id(2), assetId = id(3);
const assets = [3, 4, 5].map(n => ({ id: id(n), projectId, name: `素材 ${n}`, mimeType: 'video/mp4', sizeBytes: 1000 }));
const timeline = { id: id(6), projectId, revision: 7, durationFrames: 150,
  tracks: [{ id: id(7), name: '主画面', orderIndex: 0 }, { id: id(8), name: '叠加画面', orderIndex: 1 }],
  clips: [{ id: id(9), assetId, trackId: id(7), name: '开场 <script>', startFrame: 0, durationFrames: 60, sourceInFrame: 15 },
    { id: id(10), assetId, trackId: id(8), name: '回望的第二个片段', startFrame: 90, durationFrames: 60, sourceInFrame: 30 }],
};
const usage = deriveTimelineAssetUsage({ projectId, assets, timeline, ready: true });
assert.equal(usage.status, 'ready');
const scopeProps = { projectId, scope: `${projectId}:1`, usage, visible: true };
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const find = (tree, selector) => nodes(tree).find(node => node.props?.['data-testid'] === selector);
const event = () => ({ stopped: 0, prevented: 0, stopPropagation() { this.stopped++; }, preventDefault() { this.prevented++; } });

/** Execute the actual TSX and hook lifecycles. Shared Button's real DOM is also
 * covered by a separate React server render below; this harness inspects events. */
function harness() {
  const slots = [], pending = new Map(); let cursor = 0, dirty = false;
  const h = { visible: true };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { const next = typeof value === 'function' ? value(slots[i].value) : value; if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; } }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, index) => !Object.is(v, slots[i].deps[index]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useLayoutEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, index) => !Object.is(v, slots[i].deps[index]))) { slots[i] = { deps, cleanup: slots[i]?.cleanup }; pending.set(i, fn); } },
    useId: () => { const i = cursor++; return `usage-list-${i}`; },
  };
  const load = (source, loader, require) => { const module = { exports: {} }; Function('require', 'module', 'exports', transformSync(source, { loader, format: 'cjs' }).code)(require, module, module.exports); return module.exports; };
  const strictRequire = name => {
    if (name === 'react') return { ...react, default: react };
    if (name.endsWith('/i18n/I18nProvider.tsx')) return i18nTestModule();
    if (name === '@mioon/ui/components/button') return { Button: 'Button' };
    if (name === '@mioon/ui/components/workbench-icons') return { Film: 'Film' };
    if (name.endsWith('.css')) return {};
    throw Error(`Unexpected TSX import ${name}`);
  };
  h.usage = load(source, 'tsx', strictRequire);
  const modules = {
    './AssetTimelineUsage.tsx': h.usage,
    './asset-disposition-state.ts': { dispositionCounts, dispositionFilters, filterLibraryAssets },
    './AssetDispositionControls.tsx': { __esModule: true, default: 'AssetDispositionControls', useDispositionInteraction: () => ({ visible: h.visible, admit: action => { if (h.visible) action(); } }) },
    './Timeline.tsx': { assetKind: () => 'video', dragAsset() {} },
    './WorkspaceControls.tsx': { WorkbenchTooltip: 'WorkbenchTooltip', WorkbenchSelect: 'WorkbenchSelect' },
    './AssetLibraryToolbar.tsx': { __esModule: true, default: 'AssetLibraryToolbar', useAssetLibraryLayout: () => ({ layout: 'grid', setLayout() {} }) },
    './asset-annotation-state.ts': annotations,
    './workspace-visibility.tsx': { WorkspaceVisibilityProvider: 'WorkspaceVisibilityProvider' },
    './Nodes.tsx': { Media: 'Media' },
    './icons.tsx': { __esModule: true, default: 'Icon' },
    './SubjectLibrary.tsx': { __esModule: true, default: 'SubjectLibrary' },
    '@mioon/ui/components/input': { Input: 'Input' },
    '@mioon/ui/components/tabs': { Tabs: 'Tabs', TabsList: 'TabsList', TabsTrigger: 'TabsTrigger', TabsContent: 'TabsContent' },
    '@mioon/ui/components/collapsible': { Collapsible: 'Collapsible', CollapsibleTrigger: 'CollapsibleTrigger', CollapsibleContent: 'CollapsibleContent' },
    '@mioon/ui/components/scroll-area': { ScrollArea: 'ScrollArea' },
  };
  h.library = load(librarySource, 'jsx', name => Object.hasOwn(modules, name) ? modules[name] : strictRequire(name)).default;
  h.render = (component, props) => { let result, iterations = 0; do { cursor = 0; dirty = false; result = component(props); if (++iterations > 10) throw Error('Repeated render update'); } while (dirty); for (const [i, fn] of pending) { slots[i].cleanup?.(); slots[i].cleanup = fn(); } pending.clear(); return result; };
  h.unmount = () => slots.forEach(slot => slot.cleanup?.());
  return h;
}

function libraryProps(patch = {}) {
  return { assets, project: { id: projectId }, filter: 'all', search: '', busy: {}, collapsed: false,
    onFilter() {}, onSearch() {}, timelineUsage: usage, selectedAsset: assets[0], inUseAssetIds: new Set([assetId]),
    dispositions: { state: { scope: scopeProps.scope, entries: Object.fromEntries(assets.map(asset => [asset.id, { phase: 'ready', row: { id: asset.id, assetId: asset.id, projectId, revision: 0, disposition: 'neutral' } }])) }, controller: {} }, ...patch };
}

test('only an own key in this project ready snapshot means zero; absence stays unknown', () => {
  const h = harness(), lookup = h.usage.assetTimelineUses;
  assert.equal(lookup(usage, projectId, assetId), usage.usesByAssetId[assetId]);
  assert.deepEqual(lookup(usage, projectId, id(4)), []);
  for (const value of [undefined, { ...usage, status: 'unknown' }, { ...usage, projectId: otherProject }]) assert.equal(lookup(value, projectId, assetId), null);
  assert.equal(lookup(usage, projectId, id(100)), null); assert.equal(lookup(usage, null, assetId), null);
  assert.equal(lookup({ ...usage, usesByAssetId: Object.create({ [assetId]: [] }) }, projectId, assetId), null);
});

test('unused is a pure local view, combines existing results, and keeps unknown assets visible', () => {
  const h = harness(), hook = h.usage.useAssetTimelineUsageFilter;
  const unknownAsset = { id: id(99), projectId, name: '刚导入' };
  const input = { ...scopeProps, assets: [...assets, unknownAsset] }, before = structuredClone(input);
  let view = h.render(hook, input); assert.equal(view.filter, 'all'); assert.equal(view.visibleAssets, input.assets);
  view.choose('unused'); view = h.render(hook, input);
  assert.deepEqual(view.visibleAssets.map(asset => asset.id), [id(4), id(5), id(99)]);
  view = h.render(hook, { ...input, assets: [assets[0], assets[2]] }); assert.deepEqual(view.visibleAssets.map(asset => asset.id), [id(5)]);
  view = h.render(hook, { ...input, usage: { ...usage, status: 'unknown' } }); assert.equal(view.visibleAssets.length, 4);
  assert.deepEqual(input, before);
});

test('filter resets on each project epoch and obsolete or hidden handlers cannot change it', () => {
  const h = harness(), hook = h.usage.useAssetTimelineUsageFilter, props = { ...scopeProps, assets };
  let view = h.render(hook, props); view.choose('unused'); view = h.render(hook, props); const old = view;
  assert.equal(view.filter, 'unused');
  view = h.render(hook, { ...props, projectId: otherProject, scope: `${otherProject}:2` }); assert.equal(view.filter, 'all');
  old.choose('unused'); view = h.render(hook, props); assert.equal(view.filter, 'all', 'A to B to A cannot restore old filter');
  const shown = view; h.render(hook, { ...props, visible: false }); shown.choose('unused');
  view = h.render(hook, props); assert.equal(view.filter, 'all'); shown.choose('unused'); view = h.render(hook, props); assert.equal(view.filter, 'all');
  h.unmount(); view.choose('unused');
});

test('compact count expands explicit destinations and sends precisely the chosen immutable use', () => {
  const h = harness(), calls = [], props = { ...scopeProps, assetId, assetName: assets[0].name, onLocate: (...args) => calls.push(args) };
  let tree = h.render(h.usage.default, props);
  const expand = find(tree, `asset-usage-expand-${assetId}`); assert.equal(expand.props['aria-expanded'], false);
  assert.match(text(expand), /当前时间线 · 2 次使用/);
  const hidden = find(tree, `asset-usage-locate-${id(10)}`); assert.equal(hidden.props.disabled, true); hidden.props.onClick(event()); assert.equal(calls.length, 0);
  expand.props.onClick(event()); tree = h.render(h.usage.default, props); assert.equal(calls.length, 0, 'Expanding never selects the first use');
  assert.equal(find(tree, `asset-usage-expand-${assetId}`).props['aria-controls'], nodes(tree).find(node => node.type === 'ul').props.id);
  const second = find(tree, `asset-usage-locate-${id(10)}`), first = find(tree, `asset-usage-locate-${id(9)}`);
  assert.match(text(second), /回望的第二个片段.*叠加画面 · 起点 90 帧/); assert.match(text(first), /主画面 · 起点 0 帧/);
  second.props.onClick(event()); assert.equal(calls.length, 1); assert.equal(calls[0][0], usage.usesByAssetId[assetId][1]); assert.ok(Object.isFrozen(calls[0][0]));
  assert.equal(calls[0][1](), true);
  find(tree, `asset-usage-expand-${assetId}`).props.onClick(event()); h.render(h.usage.default, props); assert.equal(calls[0][1](), false, 'A pending confirmation is invalid after list collapse');
  second.props.onClick(event()); assert.equal(calls.length, 1);
});

test('unchanged saved polling preserves expansion and pending choice; changed source metadata invalidates', () => {
  const h = harness(), calls = [], props = { ...scopeProps, assetId, assetName: '源', onLocate: (...args) => calls.push(args) };
  let tree = h.render(h.usage.default, props); find(tree, `asset-usage-expand-${assetId}`).props.onClick(event()); tree = h.render(h.usage.default, props);
  find(tree, `asset-usage-locate-${id(10)}`).props.onClick(event()); assert.equal(calls[0][1](), true);
  const fresh = deriveTimelineAssetUsage({ projectId, assets: structuredClone(assets), timeline: structuredClone(timeline), ready: true });
  assert.notEqual(fresh, usage);
  const retained = retainTimelineAssetUsage(usage, fresh); assert.equal(retained, usage);
  tree = h.render(h.usage.default, { ...props, usage: retained });
  assert.equal(find(tree, `asset-usage-expand-${assetId}`).props['aria-expanded'], true); assert.equal(calls[0][1](), true);
  const changedAssets = structuredClone(assets); changedAssets[0].sizeBytes++;
  const changed = retainTimelineAssetUsage(retained, deriveTimelineAssetUsage({ projectId, assets: changedAssets, timeline, ready: true }));
  assert.notEqual(changed, retained); assert.equal(changed.timelineRevision, retained.timelineRevision);
  tree = h.render(h.usage.default, { ...props, usage: changed });
  assert.equal(find(tree, `asset-usage-expand-${assetId}`).props['aria-expanded'], false); assert.equal(calls[0][1](), false);
});

test('unknown, unavailable and foreign assets cannot claim unused or expose destinations', () => {
  for (const patch of [{ usage: undefined }, { usage: { ...usage, status: 'unknown' } }, { projectId: otherProject }, { assetId: id(99) }]) {
    const h = harness(), tree = h.render(h.usage.default, { ...scopeProps, assetId, assetName: '源', ...patch });
    assert.match(text(tree), /当前时间线 · 使用情况未知/); assert.doesNotMatch(text(tree), /0 次|未使用/);
    assert.equal(nodes(tree).some(node => node.type === 'Button'), false);
  }
  const h = harness(), tree = h.render(h.usage.default, { ...scopeProps, assetId: id(4), assetName: '未编排' });
  assert.match(text(tree), /当前时间线 · 0 次使用/); assert.equal(nodes(tree).some(node => node.type === 'Button'), false);
});

test('navigation callbacks and in-flight predicates expire on hide, scope, snapshot, asset change and unmount', () => {
  for (const transition of [props => ({ ...props, visible: false }), props => ({ ...props, scope: `${projectId}:2` }), props => ({ ...props, usage: { ...usage, timelineRevision: 8 } }), props => ({ ...props, assetId: id(4) }), null]) {
    const h = harness(), calls = [], props = { ...scopeProps, assetId, assetName: '源', onLocate: (...args) => calls.push(args) };
    let tree = h.render(h.usage.default, props); find(tree, `asset-usage-expand-${assetId}`).props.onClick(event()); tree = h.render(h.usage.default, props);
    const retained = find(tree, `asset-usage-locate-${id(9)}`); retained.props.onClick(event()); assert.equal(calls[0][1](), true);
    if (transition) { h.render(h.usage.default, transition(props)); h.render(h.usage.default, props); } else h.unmount();
    assert.equal(calls[0][1](), false); retained.props.onClick(event()); assert.equal(calls.length, 1);
  }
});

test('controls do not nest buttons or drag assets; target labels remain narrow-panel keyboard buttons', () => {
  const h = harness(), props = { ...scopeProps, assetId, assetName: '源', onLocate() {} };
  let tree = h.render(h.usage.default, props); find(tree, `asset-usage-expand-${assetId}`).props.onClick(event()); tree = h.render(h.usage.default, props);
  const drag = event(); tree.props.onDragStart(drag); assert.equal(drag.prevented, 1); assert.equal(drag.stopped, 1);
  const pointer = event(); tree.props.onPointerDown(pointer); assert.equal(pointer.stopped, 1); assert.equal(tree.props.draggable, false); assert.ok(Object.hasOwn(tree.props, 'data-no-asset-drag'));
  for (const node of nodes(tree).filter(node => node.type === 'Button')) {
    assert.equal(node.props.type, 'button'); assert.equal(node.props.draggable, false); assert.equal(node.props.tabIndex, undefined);
    assert.equal(nodes(node.props.children).some(child => child.type === 'Button'), false); assert.ok(node.props['aria-label']);
  }
  const destination = find(tree, `asset-usage-locate-${id(9)}`); assert.equal(destination.props.style.whiteSpace, 'normal'); assert.equal(destination.props.style.overflowWrap, 'anywhere');
});

test('actual library composes usage filter, preserves hidden selected source and resets all filters', () => {
  const h = harness(), changes = [], props = libraryProps({ filter: 'video', search: '素材', onFilter: value => changes.push(['type', value]), onSearch: value => changes.push(['search', value]) });
  props.dispositions.state.entries[assetId].row.disposition = 'favorite';
  props.dispositions.state.entries[id(4)].row.disposition = 'favorite';
  const before = structuredClone({ assets, timeline }); let tree = h.render(h.library, props);
  find(tree, 'asset-disposition-filter-favorite').props.onClick(); tree = h.render(h.library, props);
  const filters = nodes(tree).find(node => node.type === h.usage.AssetTimelineUsageFilters); filters.props.onFilter('unused'); tree = h.render(h.library, props);
  assert.equal(find(tree, `asset-card-${assetId}`), undefined); assert.ok(find(tree, `asset-card-${id(4)}`)); assert.equal(find(tree, `asset-card-${id(5)}`), undefined);
  assert.deepEqual(changes, []); assert.equal(props.search, '素材'); assert.equal(props.filter, 'video');
  assert.ok(find(tree, 'asset-filter-selected-outside')); assert.ok(find(tree, 'asset-filter-hidden-used'));
  assert.ok(nodes(nodes(tree).find(node => node.props?.className === 'asset-scroll-area')).some(node => node.props?.['data-testid'] === 'asset-filter-selected-outside'));
  find(tree, 'asset-filter-show-selected').props.onClick(); tree = h.render(h.library, props);
  assert.ok(find(tree, `asset-card-${assetId}`)); assert.ok(find(tree, `asset-card-${id(5)}`)); assert.equal(find(tree, 'asset-filter-selected-outside'), undefined);
  assert.deepEqual(changes, [['type', 'all'], ['search', '']]); assert.equal(props.selectedAsset, assets[0]); assert.deepEqual({ assets, timeline }, before);
  assert.doesNotMatch(librarySource, /setQuickAssetId|setSelectedClipId|guardNavigation|sourceRangeScope/);
});

test('usage, type and mark filters compose once in the shared filter popover above the scrolling cards', () => {
  const h = harness(), tree = h.render(h.library, libraryProps());
  const scroll = nodes(tree).find(node => node.props?.className === 'asset-scroll-area');
  const scrolled = nodes(scroll);
  const toolbar = nodes(tree).find(node => node.type === 'AssetLibraryToolbar');
  const usageFilters = nodes(toolbar).find(node => node.type === h.usage.AssetTimelineUsageFilters);
  assert.ok(usageFilters, 'Usage controls belong to the same owned filter popover as type and marks');
  assert.equal(nodes(tree).filter(node => node.type === h.usage.AssetTimelineUsageFilters).length, 1);
  assert.equal(scrolled.includes(usageFilters), false);
  assert.equal(scrolled.some(node => node.props?.className === 'asset-tabs'), false);
  for (const selector of ['asset-disposition-filter-all', 'asset-disposition-refresh', 'asset-filter-reset']) {
    assert.ok(find(tree, selector));
    assert.equal(find(scroll, selector), undefined, `${selector} stays outside the scrolling area`);
  }
});

test('actual library passes explicit hidden and subjects visibility to usage controls', () => {
  const h = harness(), props = libraryProps({ subjects: {} });
  let tree = h.render(h.library, props); const card = () => nodes(tree).find(node => node.type === h.usage.default);
  assert.equal(card().props.visible, true);
  find(tree, 'library-subjects-tab').props.onClick(); tree = h.render(h.library, props); assert.equal(card().props.visible, false);
  find(tree, 'library-assets-tab').props.onClick(); tree = h.render(h.library, { ...props, collapsed: true }); assert.equal(card().props.visible, false);
  tree = h.render(h.library, props); assert.equal(card().props.visible, true);
  h.visible = false; tree = h.render(h.library, props); assert.equal(card().props.visible, false);
});

test('filter copy identifies saved revision and unavailable data, and stays guarded while hidden', () => {
  const h = harness(), calls = [], props = { ...scopeProps, filter: 'unused', onFilter: value => calls.push(value) };
  let tree = h.render(h.usage.AssetTimelineUsageFilters, props); assert.match(text(tree), /当前时间线 · 已保存 修订版 7/);
  const button = find(tree, 'asset-usage-filter-unused'); assert.equal(button.props['aria-pressed'], true); button.props.onClick(); assert.deepEqual(calls, ['unused']);
  tree = h.render(h.usage.AssetTimelineUsageFilters, { ...props, visible: false, usage: undefined }); assert.match(text(tree), /暂不可用.*未知素材/); assert.equal(find(tree, 'asset-usage-filter-unused').props.disabled, true);
  button.props.onClick(); assert.deepEqual(calls, ['unused']);
});

test('real React and shared Button render safe compact HTML without network or storage', () => {
  const fixture = `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server.browser';
    import AssetTimelineUsage, { AssetTimelineUsageFilters } from './src/AssetTimelineUsage.tsx';
    const props = ${JSON.stringify(scopeProps)};
    export const html = [renderToStaticMarkup(<AssetTimelineUsage {...props} assetId=${JSON.stringify(assetId)} assetName="源" />),
      renderToStaticMarkup(<AssetTimelineUsageFilters {...props} filter="all" onFilter={() => {}} />)];`;
  const script = `import {build} from 'esbuild'; globalThis.fetch = () => { throw Error('Unexpected network'); };
    for (const key of ['localStorage','sessionStorage']) Object.defineProperty(globalThis, key, {get() { throw Error('Unexpected storage'); }});
    const {outputFiles} = await build({stdin:{contents:${JSON.stringify(fixture)},loader:'jsx',resolveDir:${JSON.stringify(path.join(root, 'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
    const result = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64')); process.stdout.write(JSON.stringify(result.html)); process.exit(0);`;
  const [card, filters] = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
  assert.match(card, /data-slot="button"/); assert.match(card, /aria-expanded="false"/); assert.match(card, /<ul[^>]*hidden=""/);
  assert.match(card, /开场 &lt;script&gt;/); assert.doesNotMatch(card, /<script>/); assert.match(card, /起点 90 帧/);
  assert.match(filters, /当前时间线 · 已保存 修订版 7/); assert.match(filters, /未用于本时间线/); assert.match(filters, /role="group"/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|\bfetch\(|:\s*any\b|\bas\s+any\b|@ts-ignore|@ts-nocheck/);
});
