import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { translate } from '../packages/i18n/src/index.ts';
const code = transformSync(readFileSync(new URL('../apps/web/src/ExportPreview.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
function harness(locale = 'en') {
  const hooks = [], pending = [], events = new Map(); let cursor = 0, tree, ownerCalls = 0, registered,workflowStep=1,formal={record:null,enabled:false};
  const document = { visibilityState: 'visible', addEventListener: (key, value) => events.set(key, value), removeEventListener: key => events.delete(key) };
  const window = { addEventListener: (key, value) => events.set(key, value), removeEventListener: key => events.delete(key) };
  const effect = (fn, deps) => {
    const index = cursor++, old = hooks[index];
    if (!old || !deps || deps.some((value, at) => value !== old.deps?.[at])) pending.push(() => { old?.cleanup?.(); hooks[index] = { deps, cleanup: fn() }; });
  };
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'fragment',
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useState(initial) { const index = cursor++; hooks[index] ||= { value: initial }; return [hooks[index].value, next => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next; }]; },
    useEffect: effect, useLayoutEffect: effect };
  const module = { exports: {} };
  Function('module', 'exports', 'require', 'document', 'window', code)(module, module.exports, name => name === 'react' ? react : name.includes('I18nProvider') ? { useI18n: () => ({ t: (key, params) => translate(locale, key, params) }) } : name.endsWith('ExportWorkflow.tsx')?{useExportWorkflowStep:()=>workflowStep,useExportWorkflowMedia:()=>formal}:name.includes('button') ? { Button: 'button' } : { __esModule: true, default: 'summary' }, document, window);
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const child of (Array.isArray(node) ? node : node.children || [])) { const result = find(child, predicate); if (result) return result; }
    return null;
  };
  let element = null;
  const props = { result: { phase: 'succeeded', record: { id: 'exact-export', snapshot: {} }, stale: false, url: '/media/exact?preview=1&exportId=exact-export' }, visible: true,
    canSelect: true, canGenerate: true, canCheck: true, onCheck() {}, onSelect() {}, onGenerate() {}, onRangeChange() {}, rangeDraft: null, preflightState: null,
    onBeforePlay: () => ownerCalls++, onRegisterMediaPause(pause) { registered = pause; return () => { registered = null; }; } };
  function render(patch = {}) {
    Object.assign(props, patch); cursor = 0; tree = module.exports.default(props);
    const video = find(tree, node => node.type === 'video');
    if (video) {
      if (!element || element.src !== video.props.src) element = { src: video.props.src, paused: true,pauseCount:0,playCount:0,currentTime:0,duration:10,play(){this.paused=false;this.playCount++;return Promise.resolve();}, pause() { this.paused=true;this.pauseCount++; }, getAttribute() { return this.src; } };
      video.props.ref.current = element;
    } else if (hooks[0]) hooks[0].current = null;
    while (pending.length) pending.shift()();
    return video;
  }
  return { render, props,setWorkflow(step,record=null,enabled=false){workflowStep=step;formal={record,enabled};}, find: predicate => find(tree, predicate), ownerCalls: () => ownerCalls, element: () => element, document, events, pause: () => registered?.(), unmount: () => { hooks.forEach(hook => hook.cleanup?.()); hooks[0].current = null; } };
}
test('actual TSX guards both play events and reciprocal pause without autoplay', () => {
  const h = harness(), video = h.render(), element = h.element();
  assert.equal(video.props.autoPlay, undefined);
  video.props.onPlay({ currentTarget: element }); video.props.onPlaying({ currentTarget: element }); assert.equal(h.ownerCalls(), 2);
  h.pause(); assert.ok(element.paused > 0);
  const detached = { pauseCount: 0, pause() { this.pauseCount++; }, getAttribute() { return element.src; } };
  video.props.onPlaying({ currentTarget: detached }); assert.equal(detached.pauseCount, 1); assert.equal(h.ownerCalls(), 2);
  h.unmount();
});
test('late events cannot restart hidden, closed, stale, background or unmounted media', () => {
  for (const mode of ['hidden', 'closed', 'stale', 'background', 'unmounted']) {
    const h = harness(), video = h.render(), element = h.element();
    if (mode === 'hidden') h.render({ visible: false });
    if (mode === 'closed') { h.find(node => node.type === 'button' && node.children.includes('Close player')).props.onClick(); h.render(); }
    if (mode === 'stale') h.render({ result: { ...h.props.result, stale: true, url: null } });
    if (mode === 'background') { h.document.visibilityState = 'hidden'; h.events.get('visibilitychange')(); }
    if (mode === 'unmounted') { h.unmount(); }
    video.props.onPlaying({ currentTarget: element }); assert.equal(h.ownerCalls(), 0, mode); assert.ok(element.paused > 0, mode);
  }
});
test('close/reopen only changes player presentation and all four locales render standalone', () => {
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    const h = harness(locale); let generated = 0, changed = 0;
    const video = h.render({ onGenerate: () => generated++, onRangeChange: () => changed++ }); assert.ok(video);
    const button = h.find(node => node.type === 'button' && node.children.includes(translate(locale, 'export.sample.close'))); button.props.onClick(); h.render();
    assert.equal(generated, 0); assert.equal(changed, 0); assert.equal(h.find(node => node.type === 'video'), null);
    h.unmount();
  }
});


test('step-specific preview never labels a sample as a running or completed formal output',()=>{
 const h=harness();h.setWorkflow(4,{id:'formal',status:'running'},false);assert.equal(h.render(),null);
 h.setWorkflow(5,{id:'formal',status:'succeeded',url:'/media/formal-immutable-output'},true);let video=h.render();assert.equal(video.props.src,'/media/formal-immutable-output');assert.equal(video.props.controls,undefined);assert.equal(video.props.autoPlay,undefined);
 h.setWorkflow(5,{id:'formal',status:'succeeded',url:'/media/formal-immutable-output'},false);assert.equal(h.render(),null,'held output cannot borrow the sample URL');h.unmount();
});
test('custom player controls play and seek only their exact visible media owner',async()=>{
 const h=harness();let video=h.render(),element=h.element();video.props.onLoadedMetadata({currentTarget:element});h.render();
 const play=h.find(node=>node.props?.['data-testid']==='export-preview-play');play.props.onClick();await Promise.resolve();assert.equal(element.playCount,1);
 const seek=h.find(node=>node.type==='input'&&node.props?.type==='range');seek.props.onChange({currentTarget:{value:'3.2'}});assert.equal(element.currentTime,3.2);
 h.render({visible:false});play.props.onClick();seek.props.onChange({currentTarget:{value:'9'}});assert.equal(element.playCount,1);assert.equal(element.currentTime,3.2);h.unmount();
});

test('all three review steps expose a real empty-player action and one compact range row', async () => {
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    for (const step of [1, 2, 3]) {
      const h = harness(locale), calls = [];
      h.setWorkflow(step);
      h.render({ result: { phase: 'idle', record: null, stale: false, url: null }, onGenerate: () => { calls.push('generate'); } });
      assert.deepEqual(calls, [], `${locale}/${step}: mounting is passive`);
      const empty = h.find(node => node.props?.['data-testid'] === 'export-preview-empty-generate');
      const range = h.find(node => node.props?.['data-testid'] === 'export-preview-range-controls');
      const generate = h.find(node => node.props?.['data-testid'] === 'export-preview-generate');
      assert.ok(empty); assert.equal(empty.props.disabled, false); assert.ok(range); assert.ok(generate);
      assert.ok(h.find(node => node.props?.['data-testid'] === 'export-preview-details'));
      assert.equal(h.find(node => node.props?.['data-testid'] === 'export-preview-details').props.open, undefined);
      await empty.props.onClick();
      assert.deepEqual(calls, ['generate']);
      h.render();
      await h.find(node => node.props?.['data-testid'] === 'export-preview-generate').props.onClick();
      assert.deepEqual(calls, ['generate', 'generate']);
      h.unmount();
    }
  }
});

test('sample generation is single-flight and old actions lose authority after visibility or step changes', async () => {
  const h = harness(), calls = []; let resolve;
  const pending = new Promise(done => { resolve = done; });
  h.render({ result: { phase: 'idle', record: null, stale: false, url: null }, onGenerate: () => { calls.push('generate'); return pending; } });
  const empty = h.find(node => node.props?.['data-testid'] === 'export-preview-empty-generate');
  const range = h.find(node => node.props?.['data-testid'] === 'export-preview-generate');
  const first = empty.props.onClick(); await range.props.onClick();
  assert.deepEqual(calls, ['generate'], 'two controls share one admission flight');
  h.render({ visible: false }); await empty.props.onClick(); assert.equal(calls.length, 1);
  resolve(); await first;
  h.render({ visible: true });
  const retained = h.find(node => node.props?.['data-testid'] === 'export-preview-empty-generate');
  h.setWorkflow(4, { id: 'formal', status: 'running' }, false); h.render();
  await retained.props.onClick();
  assert.equal(calls.length, 1, 'a review action cannot generate after a formal task replaces it');
  assert.equal(h.find(node => node.props?.['data-testid'] === 'export-preview-empty-generate'), null);
  h.unmount();
});

test('checking, a running sample, unknown outcome and disabled admission cannot dispatch a new sample', async () => {
  for (const patch of [
    { preflightState: { phase: 'checking' } },
    { result: { phase: 'running', record: null, stale: false, url: null } },
    { result: { phase: 'unknown', record: null, stale: false, url: null } },
    { canGenerate: false },
    { visible: false },
  ]) {
    const h = harness(); let calls = 0;
    h.render({ result: { phase: 'idle', record: null, stale: false, url: null }, onGenerate: () => { calls++; }, ...patch });
    const generate = h.find(node => node.props?.['data-testid'] === 'export-preview-generate');
    assert.equal(generate.props.disabled, true);
    await generate.props.onClick(); assert.equal(calls, 0); h.unmount();
  }
  const h = harness();
  h.render({ preflightState: { phase: 'error' }, checkDetails: 'safe capability explanation' });
  assert.equal(h.find(node => node.props?.['data-testid'] === 'export-preview-details').props.open, true, 'blocking diagnostics stay visible');
  h.unmount();
});
