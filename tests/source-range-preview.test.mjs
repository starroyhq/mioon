import { i18nTestModule } from './helpers/i18n.ts';
import * as creationI18n from '../apps/web/src/creation-i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as exportSettings from '../apps/web/src/export-settings-state.ts';
import * as ranges from '../apps/web/src/source-range-state.ts';

const source = readFileSync(new URL('../apps/web/src/Preview.tsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
function harness() {
  const slots = [], elements = new Map(); let cursor = 0, effects = [], layouts = [], tree;
  const h = { visible: true, readyState: 1, duration: 1200 };
  const effect = (queue, fn, deps) => { const i = cursor++, prior = slots[i]; if (prior && deps.every((v, j) => Object.is(v, prior.deps[j]))) return; slots[i] = { deps, cleanup: prior?.cleanup, fn }; queue.push(i); };
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useRef: value => { const i = cursor++; return slots[i] ||= { current: value }; }, useEffect: (fn, deps) => effect(effects, fn, deps), useLayoutEffect: (fn, deps) => effect(layouts, fn, deps) };
  react.default = react;
  const module = { exports: {} };
  const require = id => id === './i18n/I18nProvider.tsx' ? i18nTestModule() : id === './creation-i18n.ts' ? creationI18n : id === './UiPreferencesProvider.tsx' ? {useUiPreferences:()=>({preferences:{timecodeFormat:'timecode'}})} : id === 'react' ? react : id === './export-settings-state.ts' ? exportSettings : id === './source-range-state.ts' ? ranges : id === './api.ts' ? { assetUrl: asset => asset?.url || '', statusText: value => value } : id === './Timeline.tsx' ? { assetKind: asset => asset?.mimeType.split('/')[0], framesLabel: String } : id === './workspace-visibility.tsx' ? { useWorkspaceVisibility: () => h.visible } : id === './Nodes.tsx' ? { disposeMedia: element => { element.pause(); element.removeAttribute('src'); element.load(); } } : id === './icons.tsx' ? { default: 'Icon', __esModule: true } : new Proxy({}, { get: (_, key) => String(key) });
  Function('require', 'module', 'exports', code)(require, module, module.exports);
  const flush = queue => { for (const i of queue) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].fn(); } };
  h.render = props => {
    cursor = 0; effects = []; layouts = []; tree = module.exports.default(props);
    for (const node of nodes(tree)) if (node.props?.ref) {
      const key = node.props.key;
      if (!elements.has(key)) elements.set(key, { src: node.props.src, _currentTime: 0, get currentTime() { return this._currentTime; }, set currentTime(value) { this.seeks++; this._currentTime = h.quantizeTime ? h.quantizeTime(value) : value; }, readyState: h.readyState, duration: h.duration, paused: true, seeking: false, isConnected: true, loads: 0, seeks: 0,
        getAttribute(name) { return name === 'src' ? this.src : null; }, setAttribute(name, value) { if (name === 'src') this.src = value; }, removeAttribute(name) { if (name === 'src') this.src = null; }, pause() { this.paused = true; }, load() { this.loads++; this.currentTime = 0; } });
      node.props.ref.current = elements.get(key);
    }
    flush(layouts); flush(effects); return tree;
  };
  h.media = () => nodes(tree).find(node => ['video', 'audio'].includes(node.type));
  h.all = () => nodes(tree);
  h.unmount = () => { for (const slot of slots) slot.cleanup?.(); for (const element of elements.values()) element.isConnected = false; };
  return h;
}
const props = (patch = {}) => ({ visible: true, kind: 'source', asset: { id: 'source-a', name: 'Source', url: '/media/a', duration: 1200, mimeType: 'video/mp4' }, playhead: 800, onSeek: () => {}, sourceScope: 'project-a:1:source-a:1', sourcePosition: 0, onSourcePosition: () => {}, ...patch });

for (const kind of ['video', 'audio']) {
  test(`${kind}: native playback and paused seek publish source position without moving the timeline or feedback-seeking`, () => {
    const h = harness(), positions = [], timeline = [];
    const p = props({ asset: { ...props().asset, mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}` }, onSourcePosition: (frame, scope) => positions.push([frame, scope]), onSeek: frame => timeline.push(frame) });
    h.render(p); const node = h.media(), element = node.props.ref.current;
    positions.length = 0;
    element.currentTime = 2.499; element.paused = false; node.props.onTimeUpdate({ currentTarget: element });
    assert.deepEqual(positions, [[74, p.sourceScope]]); assert.deepEqual(timeline, []);
    h.render({ ...p, sourcePosition: 74 }); assert.equal(element.currentTime, 2.499);
    element.paused = true; element.currentTime = 4.25; h.media().props.onSeeked({ currentTarget: element });
    assert.equal(positions.at(-1)[0], 127); assert.deepEqual(timeline, []);
    h.render({ ...p, sourcePosition: 127, playhead: 900 }); assert.equal(element.currentTime, 4.25);
    assert.equal(h.all().filter(item => ['audio', 'video'].includes(item.type)).length, 1);
    assert.equal(node.props.autoPlay, undefined);
  });
}

test('explicit source seek tokens apply once and same-frame repeat seeks are deliberate', () => {
  const h = harness(), positions = [], p = props({ onSourcePosition: frame => positions.push(frame) });
  h.render(p); const element = h.media().props.ref.current;
  h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 20000 } });
  assert.equal(element.currentTime, 20000 / 30); h.media().props.onSeeked({ currentTarget: element }); assert.equal(positions.at(-1), 20000);
  element.currentTime = 668;
  h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 20000 }, sourcePosition: 20040 }); assert.equal(element.currentTime, 668);
  h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 2, frame: 20000 } }); assert.equal(element.currentTime, 20000 / 30);
});

test('hidden callbacks cannot play, seek, or publish; reopening pauses and preserves position', () => {
  const h = harness(), positions = [], p = props({ onSourcePosition: frame => positions.push(frame) });
  h.render(p); const old = h.media(), element = old.props.ref.current; positions.length = 0;
  element.currentTime = 3; element.paused = false; h.visible = false; h.render(p);
  for (const name of ['onPlay', 'onPlaying', 'onLoadedMetadata', 'onTimeUpdate', 'onSeeked']) { old.props[name]({ currentTarget: element }); assert.equal(element.currentTime, 3); assert.equal(element.paused, true); }
  assert.deepEqual(positions, []);
  h.visible = true; h.render(p); assert.equal(element.currentTime, 3); assert.equal(element.paused, true);
  h.visible = false; h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 300 } }); assert.equal(element.currentTime, 3);
  h.visible = true; h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 300 } }); assert.equal(element.currentTime, 10); assert.equal(element.paused, true);
});

test('project/asset epochs and source replacement reject old callbacks and obsolete seek requests', () => {
  const h = harness(), positions = [], p = props({ onSourcePosition: (frame, scope) => positions.push([frame, scope]) });
  h.render(p); const old = h.media(), oldElement = old.props.ref.current;
  const next = { ...p, sourceScope: 'project-b:1:source-a:2', sourceSeek: { scope: p.sourceScope, id: 1, frame: 500 } };
  h.render(next); const element = h.media().props.ref.current; positions.length = 0;
  assert.notEqual(element, oldElement); assert.equal(oldElement.src, null); assert.equal(oldElement.loads, 1); assert.equal(element.currentTime, 0);
  oldElement.currentTime = 8; oldElement.paused = false;
  for (const name of ['onPlay', 'onLoadedMetadata', 'onTimeUpdate', 'onSeeked']) old.props[name]({ currentTarget: oldElement });
  assert.deepEqual(positions, []); assert.equal(oldElement.paused, true);
  h.unmount(); assert.equal(element.src, null); assert.equal(element.loads, 1);
});

test('next-frame source seek does not stall one millisecond before an integer frame boundary', () => {
  const h = harness(), positions = [], p = props({ sourcePosition: 74, onSourcePosition: frame => positions.push(frame) });
  h.render(p); const element = h.media().props.ref.current;
  element.currentTime = 2.499; element.paused = true;
  h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 75 } });
  assert.equal(element.currentTime, 2.5);
  h.media().props.onSeeked({ currentTarget: element }); assert.equal(positions.at(-1), 75);
});

test('native source pause publishes the actual newer frame, while hidden pause remains inert', () => {
  const h = harness(), positions = [], p = props({ onSourcePosition: frame => positions.push(frame) });
  h.render(p); const node = h.media(), element = node.props.ref.current;
  element.paused = false; element.currentTime = 2; node.props.onTimeUpdate({ currentTarget: element }); assert.equal(positions.at(-1), 60);
  element.currentTime = 2.499; element.paused = true; node.props.onPause({ currentTarget: element }); assert.equal(positions.at(-1), 74);
  const controller = ranges.createSourceRangeController({ read: async () => ({ id: p.asset.id, assetId: p.asset.id, projectId: 'project-a', revision: 0, range: null, sourceFrameCount: 36000, fps: 30 }), save: async () => null });
  controller.setContext({ scope: p.sourceScope, projectId: 'project-a', asset: p.asset });
  controller.position(positions.at(-1), p.sourceScope); assert.equal(controller.getState().position, 74);
  h.visible = false; h.render(p); const before = positions.length; element.currentTime = 3; node.props.onPause({ currentTarget: element }); assert.equal(positions.length, before);
});

test('source playback position is restored across preview tabs without replaying an older explicit seek', () => {
  const h = harness(), p = props();
  const requested = { scope: p.sourceScope, id: 1, frame: 30 };
  h.render({ ...p, sourceSeek: requested });
  h.media().props.onSeeked({ currentTarget: h.media().props.ref.current });
  h.render({ ...p, kind: 'timeline', sourceSeek: requested, sourcePosition: 150, timeline: { revision: 1 }, job: { id: 'render', timelineRevision: 1, status: 'succeeded', url: '/render' } });
  h.render({ ...p, sourceSeek: requested, sourcePosition: 150 });
  assert.equal(h.media().props.ref.current.currentTime, 5);
  assert.equal(h.media().props.ref.current.paused, true);
});

test('exclusive source end seeks to EOF and publishes count instead of sticking on count minus one', () => {
  const h = harness(), positions = [], p = props({ asset: { ...props().asset, duration: 2 }, onSourcePosition: frame => positions.push(frame) });
  h.render(p); const element = h.media().props.ref.current; element.duration = 2;
  element.currentTime = 1.999; element.paused = true;
  h.render({ ...p, sourcePosition: 59, sourceSeek: { scope: p.sourceScope, id: 1, frame: 60 } });
  assert.equal(element.currentTime, 2);
  h.media().props.onSeeked({ currentTarget: element }); assert.equal(positions.at(-1), 60);
  assert.equal(ranges.sourcePositionFrame(element.currentTime, 60), 60);
});


test('microsecond-quantized native seeks advance every source frame and retain strict duration bounds', () => {
  const h = harness(), positions = [];
  h.quantizeTime = seconds => Math.floor(seconds * 1e6) / 1e6;
  const p = props({ asset: { ...props().asset, duration: 2 }, sourcePosition: 55, onSourcePosition: frame => positions.push(frame) });
  h.render(p); const element = h.media().props.ref.current; element.duration = 2;
  let current = 55, id = 0;
  for (const direction of [...Array(5).fill(1), ...Array(8).fill(-1)]) {
    const frame = current + direction;
    h.render({ ...p, sourcePosition: current, sourceSeek: { scope: p.sourceScope, id: ++id, frame } });
    h.media().props.onSeeked({ currentTarget: element });
    assert.equal(positions.at(-1), frame, `seek ${frame} quantized to ${element.currentTime}`);
    h.media().props.onPause({ currentTarget: element });
    assert.equal(positions.at(-1), frame);
    current = positions.at(-1);
  }
  assert.equal(current, 52, 'Next and Prev advance from the last published integer without accumulated drift');
  assert.equal(ranges.sourcePositionFrame(56 / 30 - .000002, 60), 55, 'two microseconds before the boundary is still the earlier frame');
  assert.equal(ranges.sourcePositionFrame(2.5 - .001, 90), 74, 'off-boundary source time retains floor semantics');
  assert.equal(ranges.sourceFrameCount(1.866666), 55, 'media duration never uses browser-position tolerance');
  assert.equal(ranges.sourcePositionFrame(2.000001, 60), 60, 'source position still clamps to source bounds');
});


test('explicit seek intent survives seeked/timeupdate/play ordering and clears when native playback moves away', () => {
  for (const round of [Math.floor, Math.round]) {
    const h = harness(), positions = [], p = props({ sourcePosition: 55, onSourcePosition: frame => positions.push(frame) });
    h.quantizeTime = seconds => round(seconds * 1e6) / 1e6;
    h.render(p); const element = h.media().props.ref.current;
    h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 56 } });
    const node = h.media(), before = positions.length;
    element.seeking = true; element.paused = false;
    node.props.onTimeUpdate({ currentTarget: element }); node.props.onPause({ currentTarget: element });
    assert.equal(positions.length, before, 'intermediate seek events must not replace the integer intent');
    element.seeking = false; node.props.onPlay({ currentTarget: element });
    node.props.onTimeUpdate({ currentTarget: element }); assert.equal(positions.at(-1), 56);
    node.props.onSeeked({ currentTarget: element }); assert.equal(positions.at(-1), 56);
    element.currentTime = 1.95; node.props.onTimeUpdate({ currentTarget: element }); assert.equal(positions.at(-1), 58);
    element.paused = true; element.currentTime = 1.866666; node.props.onSeeked({ currentTarget: element });
    assert.equal(positions.at(-1), 55, 'an unrelated native seek uses floor semantics after explicit intent has expired');
  }
});

test('source replacement cannot reuse an old quantized seek intent or accept its late callbacks', () => {
  const h = harness(), positions = [], p = props({ onSourcePosition: (frame, scope) => positions.push([frame, scope]) });
  h.quantizeTime = seconds => Math.floor(seconds * 1e6) / 1e6;
  h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 56 } });
  const old = h.media(), oldElement = old.props.ref.current; old.props.onSeeked({ currentTarget: oldElement });
  assert.deepEqual(positions.at(-1), [56, p.sourceScope]);
  const next = { ...p, sourceScope: 'project-a:1:source-b:2', asset: { ...p.asset, id: 'source-b', url: '/media/b' } };
  h.render(next); const element = h.media().props.ref.current;
  element.currentTime = 1.866666; h.media().props.onSeeked({ currentTarget: element });
  assert.deepEqual(positions.at(-1), [55, next.sourceScope]);
  const before = positions.length; old.props.onSeeked({ currentTarget: oldElement }); old.props.onPause({ currentTarget: oldElement });
  assert.equal(positions.length, before);
});

// Run the real JSX component with controlled media readiness/event ordering.
// This is an actual-component regression, not a browser/native media claim.
for (const kind of ['video', 'audio']) {
  test(`${kind}: an unacknowledged explicit source seek survives rerender before metadata`, () => {
    const h = harness(), positions = [], p = props({ asset: { ...props().asset, duration: 10, mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}` }, onSourcePosition: frame => positions.push(frame) });
    h.readyState = 0; h.duration = NaN;
    h.render(p); const element = h.media().props.ref.current;
    const requested = { ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 150 } };
    h.render(requested); h.render({ ...requested });
    element.readyState = 1; element.duration = 10;
    h.media().props.onLoadedMetadata({ currentTarget: element });
    assert.equal(element.currentTime, 5, 'metadata must retain frame 150 rather than restoring stale sourcePosition 0');
    h.media().props.onSeeked({ currentTarget: element });
    assert.equal(positions.at(-1), 150);
  });
}

for (const kind of ['video', 'audio']) {
  const sourceProps = patch => props({ asset: { ...props().asset, duration: 10, mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}` }, ...patch });
  test(`${kind}: metadata-unready playback callbacks cannot acknowledge or publish an explicit seek`, () => {
    const h = harness(), positions = [], p = sourceProps({ onSourcePosition: frame => positions.push(frame) });
    h.readyState = 0; h.duration = NaN;
    h.render(p); const element = h.media().props.ref.current;
    const requested = { ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 150 } };
    h.render(requested);
    assert.equal(element.seeks, 0, 'defer currentTime assignment until metadata is available');
    element.paused = false;
    for (const name of ['onPlay', 'onPlaying', 'onTimeUpdate', 'onPause', 'onSeeked']) h.media().props[name]({ currentTarget: element });
    assert.deepEqual(positions, []);
    h.render({ ...requested });
    element.readyState = 1; element.duration = 10; element.paused = true;
    h.media().props.onLoadedMetadata({ currentTarget: element });
    assert.equal(element.currentTime, 5);
    h.media().props.onSeeked({ currentTarget: element });
    assert.deepEqual(positions, [150]);
  });

  test(`${kind}: newest token wins through an older metadata callback and pending rerenders`, () => {
    const h = harness(), positions = [], p = sourceProps({ onSourcePosition: frame => positions.push(frame) });
    h.readyState = 0; h.duration = NaN;
    h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 150 } });
    const old = h.media(), element = old.props.ref.current;
    const latest = { ...p, sourceSeek: { scope: p.sourceScope, id: 2, frame: 180 } };
    h.render(latest); h.render({ ...latest });
    element.readyState = 1; element.duration = 10;
    old.props.onLoadedMetadata({ currentTarget: element });
    assert.equal(element.currentTime, 6, 'a queued callback must read the latest seek token');
    element.seeking = true;
    h.render({ ...latest });
    const writes = element.seeks;
    old.props.onSeeked({ currentTarget: element });
    h.media().props.onPause({ currentTarget: element });
    assert.deepEqual(positions, [], 'unfinished native seek is not an acknowledgement');
    assert.equal(element.seeks, writes, 'same token does not assign currentTime again');
    // Native events have no historical-time payload. The retained callback
    // reads the newest currentTime once the current native seek has finished.
    element.seeking = false; old.props.onSeeked({ currentTarget: element });
    assert.deepEqual(positions, [180]);
    h.render({ ...latest, sourcePosition: 180 });
    element.currentTime = 7; element.paused = false;
    h.media().props.onPlay({ currentTarget: element }); h.media().props.onTimeUpdate({ currentTarget: element });
    assert.equal(positions.at(-1), 210);
    h.render({ ...latest, sourcePosition: 210 }); assert.equal(element.currentTime, 7);
    h.render({ ...latest, sourcePosition: 210, sourceSeek: { ...latest.sourceSeek, id: 3 } });
    assert.equal(element.currentTime, 6, 'a new token intentionally repeats the earlier target');
  });

  test(`${kind}: a seek finishing while hidden is acknowledged only on visible reopening`, () => {
    const h = harness(), positions = [], p = sourceProps({ onSourcePosition: frame => positions.push(frame) });
    h.render(p); positions.length = 0;
    const requested = { ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 150 } };
    h.render(requested); const node = h.media(), element = node.props.ref.current;
    element.seeking = true; h.visible = false; h.render(requested);
    element.seeking = false;
    for (const name of ['onLoadedMetadata', 'onSeeked', 'onPause']) node.props[name]({ currentTarget: element });
    assert.deepEqual(positions, []); assert.equal(element.currentTime, 5); assert.equal(element.paused, true);
    const writes = element.seeks;
    h.visible = true; h.render(requested);
    assert.deepEqual(positions, [150]); assert.equal(element.seeks, writes, 'reopening acknowledges the finished seek without replay');
    h.render({ ...requested, sourcePosition: 150 });
    element.currentTime = 6; element.paused = false; h.media().props.onPlay({ currentTarget: element }); h.media().props.onTimeUpdate({ currentTarget: element });
    h.render({ ...requested, sourcePosition: 180 });
    h.render({ ...requested, sourcePosition: 180, kind: 'timeline', timeline: { revision: 1 }, job: { id: 'render', timelineRevision: 1, status: 'succeeded', url: '/render' } });
    h.render({ ...requested, sourcePosition: 180 });
    assert.equal(h.media().props.ref.current.currentTime, 6, 'returning after acknowledgement restores actual position, not old frame 150');
    assert.equal(h.media().props.ref.current.paused, true);
  });

  test(`${kind}: an unacknowledged seek survives preview-tab replacement and old callbacks stay inert`, () => {
    const h = harness(), positions = [], p = sourceProps({ onSourcePosition: (frame, scope) => positions.push([frame, scope]) });
    const requested = { ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 150 } };
    h.render(requested); const old = h.media(), oldElement = old.props.ref.current;
    oldElement.seeking = true;
    h.render({ ...requested, kind: 'timeline', timeline: { revision: 1 }, job: { id: 'render', timelineRevision: 1, status: 'succeeded', url: '/render' } });
    oldElement.seeking = false;
    for (const name of ['onLoadedMetadata', 'onSeeked', 'onPause']) old.props[name]({ currentTarget: oldElement });
    assert.deepEqual(positions, []);
    h.render(requested); const element = h.media().props.ref.current;
    assert.equal(element.currentTime, 5, 'an unacknowledged token is still pending after media replacement');
    h.media().props.onSeeked({ currentTarget: element });
    assert.deepEqual(positions, [[150, p.sourceScope]]);
    const next = { ...p, sourceScope: 'project-b:1:source-b:2', asset: { ...p.asset, id: 'source-b', url: '/media/b' }, sourceSeek: requested.sourceSeek };
    h.render(next); const newElement = h.media().props.ref.current; positions.length = 0;
    oldElement.currentTime = 5;
    for (const name of ['onLoadedMetadata', 'onSeeked', 'onPause']) old.props[name]({ currentTarget: oldElement });
    assert.deepEqual(positions, []); assert.equal(newElement.currentTime, 0);
    h.render({ ...next, sourceSeek: { scope: next.sourceScope, id: 1, frame: 60 } });
    h.media().props.onSeeked({ currentTarget: newElement });
    assert.deepEqual(positions, [[60, next.sourceScope]], 'same id in a new scope is independent');
  });

  test(`${kind}: stable native scrubbing can supersede an unacknowledged explicit seek`, () => {
    const h = harness(), positions = [], p = sourceProps({ onSourcePosition: frame => positions.push(frame) });
    const requested = { ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 150 } };
    h.render(requested); const element = h.media().props.ref.current;
    element.seeking = true; element.currentTime = 8;
    h.media().props.onSeeked({ currentTarget: element }); assert.deepEqual(positions, []);
    element.seeking = false; h.media().props.onSeeked({ currentTarget: element });
    assert.deepEqual(positions, [240]);
    h.render({ ...requested, sourcePosition: 240 });
    element.currentTime = 7; h.media().props.onSeeked({ currentTarget: element });
    assert.equal(positions.at(-1), 210, 'native scrub remains authoritative after token acknowledgement');
    h.render({ ...requested, sourcePosition: 210 });
    h.render({ ...requested, sourcePosition: 210, kind: 'timeline', timeline: { revision: 1 }, job: { id: 'render', timelineRevision: 1, status: 'succeeded', url: '/render' } });
    h.render({ ...requested, sourcePosition: 210 });
    assert.equal(h.media().props.ref.current.currentTime, 7, 'old explicit target cannot undo later native scrubs');
  });
}

for (const kind of ['video', 'audio']) {
  test(`${kind}: pending metadata seek retains integer intent through quantized playback and pause`, () => {
    for (const round of [Math.floor, Math.round]) {
      const h = harness(), positions = [], p = props({ asset: { ...props().asset, duration: 10, mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}` }, sourcePosition: 55, onSourcePosition: frame => positions.push(frame) });
      h.readyState = 0; h.duration = NaN; h.quantizeTime = seconds => round(seconds * 1e6) / 1e6;
      const requested = { ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 56 } };
      h.render(requested); h.render({ ...requested });
      const element = h.media().props.ref.current; element.readyState = 1; element.duration = 10;
      h.media().props.onLoadedMetadata({ currentTarget: element });
      element.seeking = true; element.paused = false;
      h.media().props.onPlaying({ currentTarget: element }); h.media().props.onTimeUpdate({ currentTarget: element });
      assert.deepEqual(positions, []);
      element.seeking = false; h.media().props.onSeeked({ currentTarget: element });
      assert.equal(positions.at(-1), 56);
      h.render({ ...requested, sourcePosition: 56 });
      element.paused = true; h.media().props.onPause({ currentTarget: element }); assert.equal(positions.at(-1), 56);
      element.currentTime = 2; element.paused = false;
      h.media().props.onPlay({ currentTarget: element }); h.media().props.onTimeUpdate({ currentTarget: element }); assert.equal(positions.at(-1), 60);
    }
  });
}
