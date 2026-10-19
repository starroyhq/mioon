import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as state from '../apps/web/src/version-comparison-state.ts';
import { comparisonMessages } from '../packages/i18n/src/catalogs/comparison.ts';
import { translate } from '../packages/i18n/src/index.ts';
import { createComparisonPlayback } from '../apps/web/src/comparison-playback.ts';
import { comparisonDetailRows } from '../apps/web/src/comparison-details.ts';
const code = transformSync(readFileSync(new URL('../apps/web/src/VersionComparison.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function context() { return { scope: 'same-project:epoch', projectId: id(1), workspaceOrigin: 'normal', connected: true, visible: true, restored: false,
  shot: { id: id(2), projectId: id(1), selectedVersionId: null },
  versions: [3, 4, 5].map(n => ({ id: id(n), projectId: id(1), shotId: id(2), assetId: id(n + 10), sha256: 'a'.repeat(64), number: n, snapshot: { prompt: `Prompt ${n}`, duration: n, aspectRatio: '16:9' } })),
  assets: [13, 14, 15].map(n => ({ id: id(n), projectId: id(1), sha256: 'a'.repeat(64), mimeType: 'video/mp4' })) }; }
function harness() {
  let locale = 'en', cursor = 0, tree, ownerCalls = 0, closes = 0, registered;
  const hooks = [], pending = [], events = new Map(), used = [];
  const document = { visibilityState: 'visible', addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) };
  const window = { addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) };
  const effect = (fn, deps) => { const at = cursor++, old = hooks[at]; if (!old || !deps || deps.some((v, i) => v !== old.deps?.[i])) pending.push(() => { old?.cleanup?.(); hooks[at] = { deps, cleanup: fn() }; }); };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'fragment',
    useRef(value) { const at = cursor++; return hooks[at] ||= { current: value }; },
    useState(value) { const at = cursor++; hooks[at] ||= { value }; return [hooks[at].value, next => { hooks[at].value = typeof next === 'function' ? next(hooks[at].value) : next; }]; },
    useLayoutEffect: effect };
  const t = (key, params = {}) => comparisonMessages[key] ? comparisonMessages[key][locale].replace(/\{(\w+)\}/g, (_, k) => String(params[k])) : translate(locale, key, params);
  const module = { exports: {} };
  Function('module', 'exports', 'require', 'document', 'window', code)(module, module.exports, name => name === 'react' ? react : name.includes('I18nProvider') ? { useI18n: () => ({ t, formatDate: value => value, formatNumber: value => String(value) }) } : name.includes('version-comparison-state') ? state : name.includes('comparison-playback') ? { createComparisonPlayback } : name.includes('comparison-details') ? { comparisonDetailRows } : name.includes('/switch') ? { Switch: 'switch' } : name.includes('workbench-icons') ? { Play: 'svg', Pause: 'svg' } : name.includes('button') ? { Button: 'button' } : name.includes('/dialog') ? Object.fromEntries(['Dialog', 'DialogContent', 'DialogTitle', 'DialogDescription', 'DialogClose'].map(key => [key, key])) : {}, document, window);
  function all(node, predicate, results = []) { if (node && typeof node === 'object') { if (predicate(node)) results.push(node); for (const child of Array.isArray(node) ? node : node.children || []) all(child, predicate, results); } return results; }
  const props = { context: context(), getContext: () => props.context, busy: false, onClose: () => closes++, onUse: b => used.push(b), onBeforePlay: () => ownerCalls++, onRegisterMediaPause: pause => { registered = pause; return () => { registered = null; }; } };
  function render(patch = {}) { Object.assign(props, patch); cursor = 0; tree = module.exports.default(props); while (pending.length) pending.shift()(); return tree; }
  const find = testId => all(tree, node => node.props?.['data-testid'] === testId)[0];
  const videos = () => all(tree, node => node.type === module.exports.ComparisonVideo);
  function choose(side, n) { find(`comparison-select-${side}`).props.onChange({ target: { value: id(n) } }); render(); }
  function media(node) { const element = { isConnected: true, src: node.props.binding.url, pauses: 0, duration: 4, currentTime: 0, play() { return Promise.resolve(); }, pause() { this.pauses++; }, getAttribute() { return this.src; } }; node.props.register(element); return element; }
  return { render, find, choose, videos, media, props, used, events, document, ownerCalls: () => ownerCalls, closes: () => closes, pause: () => registered?.(),
    locale(value) { locale = value; render(); }, button(text) { return all(tree, node => node.type === 'button' && node.children.includes(text))[0]; },
    unmount() { hooks.forEach(hook => hook.cleanup?.()); }, module, react, pending, hooks, setCursor(value) { cursor = value; } };
}
test('actual dialog requires two explicit distinct choices and never defaults latest', () => {
  const h = harness(); h.render(); assert.equal(h.videos().length, 0); assert.equal(h.used.length, 0);
  h.choose('A', 3); assert.equal(h.videos().length, 0); h.choose('B', 3); assert.equal(h.find('comparison-select-B').props.value, '');
  h.choose('B', 4); assert.equal(h.videos().length, 2); assert.equal(h.find('comparison-select-A').props.value, id(3));
  h.props.context.versions.reverse(); h.props.context.shot.selectedVersionId = id(5); h.render(); assert.equal(h.find('comparison-select-A').props.value, id(3));
  h.locale('ja'); assert.equal(h.find('comparison-select-B').props.value, id(4)); assert.equal(h.videos().length, 2);
  h.unmount();
});
test('playback owns one side, pauses peer and registers external pause', () => {
  const h = harness(); h.render(); h.choose('A', 3); h.choose('B', 4);
  const [a, b] = h.videos(), left = h.media(a), right = h.media(b);
  a.props.onPlay({ currentTarget: left }); assert.equal(right.pauses, 1); assert.equal(h.ownerCalls(), 1);
  b.props.onPlay({ currentTarget: right }); assert.equal(left.pauses, 1);
  left.paused = true; a.props.onPlay({ currentTarget: left }); assert.equal(h.ownerCalls(), 2); left.paused = false;
  h.pause(); assert.equal(left.pauses, 2); assert.equal(right.pauses, 2);
  h.document.visibilityState = 'hidden'; h.events.get('visibilitychange')(); a.props.onPlay({ currentTarget: left }); assert.equal(h.ownerCalls(), 2); assert.ok(left.pauses > 2);
  h.document.visibilityState = 'visible'; h.events.get('pagehide')(); h.unmount();
});
test('offline fences retained events immediately and requires explicit clear/reselection after reconnect', () => {
  const h = harness(); h.render(); h.choose('A', 3); h.choose('B', 4); const a = h.videos()[0], element = h.media(a), use = h.find('comparison-use-A').props.onClick;
  h.props.context = { ...h.props.context, connected: false }; a.props.onPlay({ currentTarget: element }); use(); assert.equal(h.ownerCalls(), 0); assert.equal(h.used.length, 0);
  h.render(); h.render({ context: { ...h.props.context, connected: true } }); assert.equal(h.videos().length, 0); assert.equal(h.find('comparison-use-A').props.disabled, true);
  h.button('Clear comparison choices').props.onClick(); h.render(); h.choose('A', 3); h.choose('B', 4); assert.equal(h.videos().length, 2); h.unmount();
});
test('retained use/play callbacks cannot select or play a newly substituted side', () => {
  const h = harness(); h.render(); h.choose('A', 3); h.choose('B', 4); const old = h.videos()[0], element = h.media(old), use = h.find('comparison-use-A').props.onClick;
  h.choose('A', 5); const next = h.videos()[0]; h.media(next); old.props.onPlay({ currentTarget: element }); use(); assert.equal(h.ownerCalls(), 0); assert.equal(h.used.length, 0);
  h.find('comparison-use-A').props.onClick(); assert.equal(h.used[0].versionId, id(5)); h.unmount(); old.props.onPlay({ currentTarget: element }); assert.equal(h.ownerCalls(), 0);
});
test('same-ID mutated source, project scope, and hidden dialog suppress actual players', () => {
  for (const mutate of [c => c.versions[0].sha256 = 'b'.repeat(64), c => c.scope = 'other', c => c.visible = false, c => c.restored = true]) {
    const h = harness(); h.render(); h.choose('A', 3); h.choose('B', 4); mutate(h.props.context); h.render(); assert.equal(h.videos().length, 0); h.unmount();
  }
});
test('single decoder cleans up src and restores it during StrictMode-style effect replay', () => {
  const h = harness(), binding = state.captureComparison(context(), id(3)); let registered;
  const element = { src: binding.url, pauses: 0, loads: 0, pause() { this.pauses++; }, load() { this.loads++; }, getAttribute() { return this.src; }, setAttribute(_, value) { this.src = value; }, removeAttribute() { this.src = null; } };
  const props = { binding, label: 'A', register: value => { registered = value; }, onPlay() {}, onError() {} };
  let tree = h.module.exports.ComparisonVideo(props); tree.props.ref.current = element; while (h.pending.length) h.pending.shift()(); assert.equal(registered, element);
  h.hooks.forEach(hook => hook.cleanup?.()); assert.equal(element.src, null); assert.equal(element.loads, 1);
  // Effect setup replay, retaining refs/state, is represented by dropping only effect records.
  h.hooks.forEach((hook, at) => { if ('deps' in hook) h.hooks[at] = undefined; }); h.setCursor(0);
  tree = h.module.exports.ComparisonVideo(props); tree.props.ref.current = element; while (h.pending.length) h.pending.shift()(); assert.equal(element.src, binding.url); assert.equal(registered, element);
  h.unmount(); assert.equal(element.loads, 2);
});

test('all four locales render actual ready and stale controls without resetting choices', () => {
  const h = harness(); h.render(); h.choose('A', 3); h.choose('B', 4);
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    h.locale(locale); assert.equal(h.find('comparison-select-A').props.value, id(3)); assert.equal(h.find('comparison-select-B').props.value, id(4));
    assert.equal(h.videos()[0].props.label.includes('{'), false);
  }
  h.props.context.connected = false; h.render();
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) { h.locale(locale); assert.equal(h.videos().length, 0); }
  h.unmount();
});

test('retained chooser and reset cannot rebind or clear a newer scope or newer choices', () => {
  const h = harness(); h.render(); h.choose('A', 3); h.choose('B', 4);
  const choose = h.find('comparison-select-A').props.onChange, reset = h.button('Clear comparison choices').props.onClick;
  h.props.context = { ...h.props.context, scope: 'different-epoch' };
  choose({ target: { value: id(5) } }); reset(); h.render();
  assert.equal(h.find('comparison-select-A').props.value, id(3)); assert.equal(h.videos().length, 0);
  h.render(); h.button('Clear comparison choices').props.onClick(); h.render(); h.choose('A', 5); h.choose('B', 4);
  choose({ target: { value: id(3) } }); reset(); h.render(); assert.equal(h.find('comparison-select-A').props.value, id(5)); assert.equal(h.videos().length, 2);
  h.unmount();
});

test('removing the open shot retains a closable unavailable dialog without playback or replacement', () => {
  const h = harness(); h.render(); h.choose('A', 3); h.choose('B', 4); const old = h.videos()[0], element = h.media(old);
  h.props.context.shot = null; const tree = h.render(); assert.equal(tree.type, 'Dialog'); assert.equal(h.videos().length, 0);
  assert.equal(h.find('comparison-select-A').props.value, id(3)); old.props.onPlay({ currentTarget: element }); assert.equal(h.ownerCalls(), 0);
  tree.props.onOpenChange(false); assert.equal(h.closes(), 1); h.unmount();
});

test('actual differences switch filters frozen parameters and stale add cannot insert a replacement source', () => {
  const h = harness(), added = []; h.render({ onAdd: binding => added.push(binding) }); h.choose('A', 3); h.choose('B', 4);
  const add = h.find('comparison-add-A').props.onClick; add(); assert.equal(added[0].versionId, id(3));
  const rows = h.find('comparison-differences'); assert.ok(rows);
  h.find('comparison-differences-only').props.onCheckedChange(true); h.render();
  // Source prompt and duration differ; equal/missing model and provider rows disappear.
  const body = h.find('comparison-differences').children[1];
  assert.equal(body.children[0].length, 2);
  h.choose('A', 5); add(); assert.equal(added.length, 1); h.unmount();
});

test('enabling synchronized playback is explicit and does not start either decoder', () => {
  const h = harness(); h.render(); h.choose('A', 3); h.choose('B', 4);
  const media = h.videos().map(node => h.media(node));
  h.find('comparison-sync').props.onCheckedChange(true); h.render();
  assert.ok(h.videos().every(node => node.props.controls === false)); assert.equal(h.ownerCalls(), 0);
  assert.ok(h.find('comparison-shared-play')); assert.ok(media.every(element => element.pauses > 0));
  h.unmount();
});
