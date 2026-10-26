import type {RootProps,RootHook} from './helpers/strict-root-ui-types.ts';
type BoardTree=BoardNode|string|number|boolean|null|undefined|BoardTree[];
interface BoardNode {type:string;props:RootProps;children:BoardTree[]}
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { translate } from '../packages/i18n/src/index.ts';

function harness(file:string,props:Record<string,unknown>,onConnect?: (tree:BoardNode)=>void) {
  const code = transformSync(readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
  const hooks:RootHook[] = [], pending:(()=>void)[] = [];
  let cursor = 0, tree:BoardNode, visible = true;
  const effect = (fn:()=>void|(()=>void),deps?:readonly unknown[]) => { const at = cursor++, old = hooks[at]; if (!old || !deps || deps.some((value, i) => value !== old.deps?.[i])) pending.push(() => { old?.cleanup?.(); hooks[at] = { deps, cleanup: fn() }; }); };
  const react = { createElement: (type:string,props:RootProps,...children:BoardTree[]) => ({ type, props: props || {}, children }), Fragment: 'fragment', useLayoutEffect: effect,
    useRef: <T,>(value:T) => { const at = cursor++; return (hooks[at] ||= {current:value}) as {current:T}; },
    useState: <T,>(value:T):[T,(next:T|((value:T)=>T))=>void] => { const at = cursor++; hooks[at] ||= { value }; return [hooks[at].value as T, next => { hooks[at].value = typeof next === 'function' ? (next as (value:T)=>T)(hooks[at].value as T) : next; }]; },
    useMemo: <T,>(fn:()=>T,deps:readonly unknown[]) => { const at = cursor++, old = hooks[at]; if (!old || deps.some((value, i) => value !== old.deps![i])) hooks[at] = { deps, value: fn() }; return hooks[at].value as T; } };
  const module = {exports:{} as {default(props:Record<string,unknown>):BoardNode}};
  Function('module', 'exports', 'require', code)(module, module.exports, (name: string) => {
    if (name === 'react') return react;
    if (name.includes('I18nProvider')) return { useI18n: () => ({ t: (key:Parameters<typeof translate>[1],params?:Parameters<typeof translate>[2]) => translate('zh-Hans', key, params), formatNumber: (value:number) => String(value) }) };
    if (name.includes('workspace-visibility')) return { useWorkspaceVisibility: () => visible, WorkspaceVisibilityProvider: 'Visibility' };
    if (name.endsWith('.css')) return {};
    return new Proxy({}, { get: (_, key) => key === '__esModule' ? true : String(key) });
  });
  const all = (node:BoardTree,predicate:(node:BoardNode)=>unknown,results:BoardNode[] = []):BoardNode[] => { if (node && typeof node === 'object') { if (predicate(node as BoardNode)) results.push(node as BoardNode); for (const child of Array.isArray(node) ? node : (node as BoardNode).children || []) all(child, predicate, results); } return results; };
  function render(patch: Record<string, unknown> = {}) { Object.assign(props, patch); cursor = 0; tree = module.exports.default(props); onConnect?.(tree); while (pending.length) pending.shift()!(); return tree; }
  return { render, find: (id:string) => all(tree, node => node.props?.['data-testid'] === id)[0]!, all: (predicate:(node:BoardNode)=>unknown) => all(tree, predicate), props,
    visible(value: boolean) { visible = value; }, unmount() { hooks.forEach(hook => hook.cleanup?.()); } };
}
test('library chips, layout and filter portal retire across hide/reopen and project ownership', () => {
  const actions: unknown[] = [], props = { scope: 'project-1:epoch', visible: true, count: 4, layout: 'grid', onLayout: (value: unknown) => actions.push(value), search: 'search', chips: [{ key: 'video', label: 'Video', remove: () => actions.push('remove') }], children: 'real filters' };
  const h = harness('AssetLibraryToolbar.tsx', props); h.render();
  const list = h.find('asset-layout-list').props.onClick;
  const chip = h.all((node) => node.type === 'WorkbenchChip')[0].props.onClick;
  const popover = h.all((node) => node.type === 'WorkbenchPopover')[0].props.onOpenChange;
  list(); chip(); popover(true); h.render(); assert.deepEqual(actions, ['list', 'remove']); assert.equal(h.all((node) => node.type === 'WorkbenchPopover')[0].props.open, true);
  h.render({ visible: false }); list(); chip(); popover(true); h.render(); assert.equal(h.all((node) => node.type === 'WorkbenchPopover')[0].props.open, false); assert.equal(actions.length, 2);
  h.render({ visible: true, scope: 'project-2:epoch' }); list(); chip(); popover(true); h.render(); assert.equal(actions.length, 2); assert.equal(h.all((node) => node.type === 'WorkbenchPopover')[0].props.open, false);
  h.find('asset-layout-list').props.onClick(); assert.equal(actions.at(-1), 'list'); h.unmount();
});
test('storyboard dragging and selection retain source asset but cannot reorder another project or hidden surface', () => {
  const calls: unknown[] = [], props = { scope: 'p1', open: true, onOpenChange() {}, shots: [{ id: 's1', title: 'First', duration: 2, selectedVersionId: 'v1' }, { id: 's2', title: 'Second', duration: 3 }], versions: [{ id: 'v1', assetId: 'a1', number: 1, snapshot: { duration: 4 } }], selectedId: 's1', reordering: false, assetDragType: 'application/asset', onSelect: (id:string) => calls.push(['select', id]), onReorder: (id:string,index:number) => calls.push(['reorder', id, index]), onAddShot() {}, renderThumbnail: () => 'thumb' };
  const h = harness('StoryboardStrip.tsx', props); h.render();
  const data:Record<string,string> = {}, first = h.find('storyboard-shot-s1');
  first.props.onDragStart({ dataTransfer: { setData: (key:string,value:string) => { data[key] = value; } }, preventDefault() { assert.fail('valid drag'); } });
  assert.deepEqual(data, { 'text/plain': 's1', 'application/asset': 'a1' }); h.render();
  const oldDrop = h.find('storyboard-shot-s2').props.onDrop;
  oldDrop({ preventDefault() {} }); assert.deepEqual(calls.at(-1), ['reorder', 's1', 1]); h.render();
  const oldSelect = h.all((node) => node.props?.className === 'storyboard-preview')[0].props.onClick;
  h.render({ scope: 'p2' }); oldDrop({ preventDefault() {} }); oldSelect(); assert.equal(calls.length, 1);
  h.visible(false); h.render(); h.all((node) => node.props?.className === 'storyboard-preview')[0].props.onClick(); assert.equal(calls.length, 1); h.unmount();
});
test('storyboard separate move controls retain order boundaries and retire stale callbacks', () => {
  const calls: unknown[] = [], props = { scope: 'p1', open: true, onOpenChange() {}, shots: [{ id: 's1', title: 'First', duration: 2 }, { id: 's2', title: 'Second', duration: 3 }], versions: [], selectedId: null, reordering: false, assetDragType: 'application/asset', onSelect: (id:string) => calls.push(['select', id]), onReorder: (id:string,index:number) => calls.push(['reorder', id, index]), onAddShot() {}, renderThumbnail: () => 'thumb' };
  const h = harness('StoryboardStrip.tsx', props); h.render();
  const move = (name: string, direction: 'moveEarlier'|'moveLater') => h.all((node) => node.type === 'WorkbenchButton' && node.props?.['aria-label'] === translate('zh-Hans', `storyboard.${direction}`, { name }))[0];
  assert.equal(move('First', 'moveEarlier').props.disabled, true); assert.equal(move('Second', 'moveLater').props.disabled, true);
  const later = move('First', 'moveLater').props.onClick, earlier = move('Second', 'moveEarlier').props.onClick;
  later(); earlier(); assert.deepEqual(calls, [['reorder', 's1', 1], ['reorder', 's2', 0]]);
  h.render({ reordering: true }); assert.ok(h.all(node => node.type === 'WorkbenchButton' && /将/.test(node.props?.['aria-label'] || '')).every(node => node.props.disabled));
  h.render({ reordering: false, scope: 'p2' }); later(); earlier(); assert.equal(calls.length, 2);
  const next = move('First', 'moveLater').props.onClick; h.render({ open: false }); next(); assert.equal(calls.length, 2);
  h.visible(false); h.render({ open: true }); move('First', 'moveLater').props.onClick(); assert.equal(calls.length, 2); h.unmount();
});
test('compact node player preserves explicit seek and pauses late play after its source is replaced', async () => {
  let resolvePlay!:()=>void, playCalls = 0, pauses = 0;
  const video = { isConnected: true, paused: true, ended: false, currentTime: 0, duration: 4,
    play() { playCalls++; this.paused = false; return new Promise<void>(resolve => { resolvePlay = resolve; }); }, pause() { pauses++; this.paused = true; } };
  let element = video, mediaEvents:{onLoadedMetadata(event:{currentTarget:typeof video}):void}|undefined;
  const h = harness('CompactNodePlayer.tsx', { sourceKey: 'v1', renderMedia: (events:NonNullable<typeof mediaEvents>) => { mediaEvents = events; return 'video'; } }, (tree) => { (tree.props.ref as {current:unknown}).current = { querySelector: () => element }; });
  h.render(); (mediaEvents)!.onLoadedMetadata({ currentTarget: video }); h.render();
  const range = h.all((node) => node.type === 'input')[0]; range.props.onChange({ target: { value: '3' } }); assert.equal(video.currentTime, 3);
  h.all((node) => node.type === 'WorkbenchButton')[0].props.onClick({ stopPropagation() {} }); assert.equal(playCalls, 1);
  const next = { ...video, paused: true, pause() {} }; element = next; h.render({ sourceKey: 'v2' });
  (resolvePlay)!(); await Promise.resolve(); assert.equal(video.paused, true); assert.ok(pauses > 0);
  h.visible(false); h.render(); h.all((node) => node.type === 'WorkbenchButton')[0].props.onClick({ stopPropagation() {} }); assert.equal(playCalls, 1); h.unmount();
});
