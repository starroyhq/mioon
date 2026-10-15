import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as stateModule from '../apps/web/src/timeline-clip-loudness-state.ts';
import { context, report, deferred } from './helpers/timeline-clip-loudness-ui-fixture.mjs';

function hookHarness() {
  const refs = [], effects = [], pending = []; let cursor = 0;
  const react = {
    useRef(value) { const index = cursor++; return refs[index] ??= { current: value }; },
    useState(value) { const index = cursor++; refs[index] ??= { value }; return [refs[index].value, next => { refs[index].value = next; }]; },
    useLayoutEffect(fn, deps) { const index = cursor++, old = effects[index]; if (!old || !deps || deps.some((item, i) => item !== old.deps?.[i])) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: fn() }; }); },
  };
  const module = { exports: {} }, source = readFileSync(new URL('../apps/web/src/use-timeline-clip-loudness.ts', import.meta.url), 'utf8');
  Function('module','exports','require',transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module,module.exports, name => name === 'react' ? react : stateModule);
  return { render(options) { cursor = 0; const view = module.exports.useTimelineClipLoudness(options); while (pending.length) pending.shift()(); return view; },
    dispose() { effects.forEach(item => item?.cleanup?.()); } };
}
test('actual hook installs visibility/pagehide fences, never auto-reads and removes ownership on disposal', async t => {
  const oldDocument = globalThis.document, oldWindow = globalThis.window, document = new EventTarget(), window = new EventTarget();
  document.visibilityState = 'visible'; globalThis.document = document; globalThis.window = window;
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
  let live = context(); const calls = [], waits = [], h = hookHarness();
  const options = () => ({ context: live, getContext: () => live, read(input, options) { const wait = deferred(); waits.push(wait); calls.push({ input, options }); return wait.promise; } });
  const view = h.render(options()), owned = view.controller; h.render(options()); assert.equal(calls.length, 0);
  const pending = owned.prepare(owned.getState());
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls[0].options.signal.aborted, true); waits[0].resolve(report(calls[0].input)); await pending; assert.equal(owned.getState().report, null);
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); h.render(options()); assert.equal(calls.length, 1);
  const next = owned.prepare(owned.getState()); waits[1].resolve(report(calls[1].input)); await next; assert.equal(owned.getState().phase, 'ready');
  window.dispatchEvent(new Event('pagehide')); assert.equal(owned.getState().report, null); assert.equal(calls.length, 2);
  live = { ...live, revision: 5 }; const masked = h.render(options()); assert.equal(masked.state.report, null);
  const third = owned.prepare(owned.getState()); h.dispose(); assert.equal(calls[2].options.signal.aborted, true);
  waits[2].resolve(report(calls[2].input, live)); await third; assert.equal(owned.getState().report, null);
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); assert.equal(owned.getState().visible, false); assert.equal(calls.length, 3);
});
