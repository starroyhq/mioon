import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as audio from '../apps/web/src/clip-audio-state.js';
import * as timelineFormat from '../apps/web/src/timeline-format-state.js';

const asset = (patch = {}) => ({ id: 'asset-a', projectId: 'project-a', name: 'Source', mimeType: 'video/mp4', hasAudio: true, duration: 10, ...patch });
const clip = (patch = {}) => ({ id: 'clip-a', assetId: 'asset-a', name: 'Clip', trackId: 'video', startFrame: 0, durationFrames: 120, sourceInFrame: 0, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1, ...patch });
const timeline = (current = clip(), revision = 7, projectId = 'project-a') => ({ id: `timeline-${projectId}`, projectId, revision, fps: 30, width: 720, height: 1280, clips: [current], tracks: [{ id: 'video', kind: 'video', name: 'Video' }, { id: 'audio', kind: 'audio', name: 'Audio' }] });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const equalDeps = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));

// Run the real component tree and callbacks, with the same dependency-free
// hook fixture used by other inspector tests. Native layout is separate QA.
function inspectorHarness(patch = {}) {
  const slots = [], modules = new Map(), dirtyEvents = [], saves = [];
  let cursor = 0, effects = [], layouts = [], tree, needsRender = false, unmounted = false;
  let props = { clip: clip(), timeline: timeline(), asset: asset(), onDirtyChange: value => dirtyEvents.push(value), onSave: async (id, saved, revision) => { saves.push({ id, patch: structuredClone(saved), revision }); return timeline(clip(saved), revision + 1); }, onRemove() {}, onPreview() {}, busy: false, ...patch };
  const effect = (queue, callback, deps) => { const i = cursor++, prior = slots[i]; if (prior && equalDeps(deps, prior.deps)) return; slots[i] = { deps, callback, cleanup: prior?.cleanup }; queue.push(i); };
  const react = {
    createElement: (type, properties, ...children) => typeof type === 'function' ? type({ ...properties, children }) : ({ type, props: { ...properties, children } }),
    useState(initial) { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, next => { const value = typeof next === 'function' ? next(slots[i].value) : next; if (!Object.is(value, slots[i].value)) { slots[i].value = value; needsRender = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useEffect: (callback, deps) => effect(effects, callback, deps),
    useLayoutEffect: (callback, deps) => effect(layouts, callback, deps),
  };
  react.default = react;
  const primitive = new Proxy({}, { get: (_, key) => String(key) });
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const source = readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8');
    const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
    const module = { exports: {} };
    Function('require', 'module', 'exports', code)(id => {
      if (id === 'react') return react;
      if (id === './clip-audio-state.js') return audio;
      if (id === './timeline-format-state.js') return timelineFormat;
      if (id === './ClipAudioControls.jsx') return load('ClipAudioControls.jsx');
      if (id === './Timeline.jsx') return { assetKind: value => value?.mimeType?.split('/')[0] || 'image', framesLabel: String };
      if (id === '@mioon/contracts') return { sourceFrameCount: duration => Math.floor(duration * 30) };
      if (id === '@mioon/ui/components/workbench-confirm') return { useConfirmation: () => async () => true };
      if (id === './icons.jsx') return { default: 'Icon', __esModule: true };
      return primitive;
    }, module, module.exports);
    modules.set(filename, module.exports); return module.exports;
  }
  const component = load('TimelineInspector.jsx').default;
  const flush = queue => { for (const i of queue) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback(); } };
  const h = {
    dirtyEvents, saves,
    render(next = {}) {
      assert.equal(unmounted, false, 'Unmounted project inspector is not rendered again');
      props = { ...props, ...next };
      let attempts = 0;
      do { needsRender = false; cursor = 0; effects = []; layouts = []; tree = component(props); flush(layouts); flush(effects); assert.ok(++attempts < 20, 'Effects stabilize'); } while (needsRender);
      return tree;
    },
    find(id) { return nodes(tree).find(node => node.props?.['data-testid'] === id || node.props?.id === id); },
    all() { return nodes(tree); },
    text() { return text(tree); },
    edit(id, value) { const field = h.find(id); assert.ok(field, id); field.props.onChange({ target: { value } }); h.render(); },
    submit() { return nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
    reset() { nodes(tree).find(node => node.type === 'Button' && /^(放弃修改|载入最新片段)$/.test(text(node))).props.onClick(); h.render(); },
    unmount() { for (const slot of slots) slot.cleanup?.(); unmounted = true; },
  };
  h.render(); return h;
}

test('fade draft preserves omission, explicit zero and immutable copies', () => {
  const legacy = clip();
  assert.deepEqual(audio.clipAudioDraft(legacy), {});
  assert.deepEqual(audio.clipAudioPatch({ ...legacy, name: 'Renamed' }), {});
  assert.deepEqual(audio.clipAudioDraft(clip({ fadeInFrames: 0 })), { fadeInFrames: 0 });
  assert.deepEqual(audio.clipAudioPatch({ fadeInFrames: '0', fadeOutFrames: '30' }), { fadeInFrames: 0, fadeOutFrames: 30 });
  const inherited = Object.create({ fadeInFrames: 10 }); inherited.fadeOutFrames = 0;
  assert.deepEqual(audio.clipAudioDraft(inherited), { fadeOutFrames: 0 });
  const copied = audio.clipAudioDraft(clip({ fadeInFrames: 15 })); copied.fadeInFrames = 20;
  assert.equal(legacy.fadeInFrames, undefined);
});

test('fade validation checks both integers, per-side bounds, their sum and confirmed audio', () => {
  for (const value of [-1, 1.5, '', ' ', undefined, null, false, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.match(audio.clipAudioIssue(clip({ fadeInFrames: value }), asset()), /整数/);
  for (const values of [{ fadeInFrames: 121 }, { fadeOutFrames: 121 }, { fadeInFrames: 70, fadeOutFrames: 51 }]) assert.match(audio.clipAudioIssue(clip(values), asset()), /合计不能超过.*120.*同时检查并调整两项/);
  for (const source of [asset({ hasAudio: false }), asset({ hasAudio: undefined }), asset({ hasAudio: 'true' }), asset({ mimeType: 'image/png' })]) {
    assert.equal(audio.supportsClipAudioFades(source), false);
    assert.match(audio.clipAudioIssue(clip({ fadeInFrames: 1 }), source), /确认含音轨/);
    assert.equal(audio.clipAudioIssue(clip({ fadeInFrames: 0 }), source), '');
  }
  for (const source of [asset(), asset({ mimeType: 'audio/wav' })]) {
    assert.equal(audio.supportsClipAudioFades(source), true);
    assert.equal(audio.clipAudioIssue(clip({ fadeInFrames: 90, fadeOutFrames: 30 }), source), '');
    assert.equal(audio.clipAudioIssue(clip(), source), '');
  }
});

test('actual inspector renders integer fade controls inside its existing ScrollArea and keeps gain semantics', () => {
  for (const mimeType of ['video/mp4', 'audio/wav']) {
    const h = inspectorHarness({ asset: asset({ mimeType }) });
    for (const id of ['clip-fade-in', 'clip-fade-out']) {
      const field = h.find(id);
      assert.equal(field.props.value, 0); assert.equal(field.props.min, '0'); assert.equal(field.props.max, 120); assert.equal(field.props.step, '1'); assert.equal(field.props.disabled, false); assert.equal(field.props.required, true);
      assert.ok(nodes(h.all().find(node => node.type === 'ScrollArea')).includes(field));
      assert.match(field.props['aria-describedby'], /clip-fade-bounds clip-fade-effect/);
    }
    assert.equal(h.find('clip-gain').props.max, '2'); assert.equal(h.find('clip-gain').props.step, '0.05'); assert.equal(h.find('save-clip').props.disabled, true);
    assert.match(h.text(), /音频淡入\/淡出（帧）/); assert.match(h.text(), /30 帧 = 1 秒/);
    assert.match(text(h.find('clip-fade-effect')), /重新渲染时间线预览与导出.*源素材快速查看播放原始声音/);
  }
});

test('silent and unknown-audio videos show disabled fades with an honest no-effect explanation; images have no audio controls', () => {
  for (const value of [false, undefined]) {
    const h = inspectorHarness({ asset: asset({ hasAudio: value }) });
    assert.equal(h.find('clip-fade-in').props.disabled, true); assert.equal(h.find('clip-fade-out').props.disabled, true);
    assert.match(text(h.find('clip-fade-effect')), value === false ? /不含音轨.*不会产生效果/ : /尚未确认.*无法启用/);
    assert.equal(h.find('clip-gain').props.disabled, undefined, 'Existing gain semantics are preserved');
  }
  const image = inspectorHarness({ asset: asset({ mimeType: 'image/png', hasAudio: false }) });
  assert.equal(image.find('clip-fade-in'), undefined); assert.equal(image.find('clip-gain'), undefined);
});

test('unrelated save on legacy clip never adds zero fields; explicitly changing one missing fade adds only that zero', async () => {
  const h = inspectorHarness();
  h.edit('clip-name', 'New name'); await h.submit(); h.render();
  assert.equal(h.saves.length, 1); assert.equal(Object.hasOwn(h.saves[0].patch, 'fadeInFrames'), false); assert.equal(Object.hasOwn(h.saves[0].patch, 'fadeOutFrames'), false);
  assert.equal(h.find('save-clip').props.disabled, true); assert.equal(h.dirtyEvents.at(-1), false);
  h.edit('clip-fade-in', '0'); await h.submit(); h.render();
  assert.equal(h.saves[1].patch.fadeInFrames, 0); assert.equal(Object.hasOwn(h.saves[1].patch, 'fadeOutFrames'), false);
  assert.equal(h.saves[1].revision, 8);
});

test('unrelated save preserves explicit zero and fade values while discard restores omission', async () => {
  const explicit = clip({ fadeInFrames: 0, fadeOutFrames: 20 });
  const h = inspectorHarness({ clip: explicit, timeline: timeline(explicit) });
  h.edit('clip-name', 'Renamed'); await h.submit();
  assert.equal(h.saves[0].patch.fadeInFrames, 0); assert.equal(h.saves[0].patch.fadeOutFrames, 20);
  const legacy = inspectorHarness(); legacy.edit('clip-fade-in', '15'); legacy.reset();
  assert.equal(legacy.find('clip-fade-in').props.value, 0); assert.equal(legacy.dirtyEvents.at(-1), false);
  legacy.edit('clip-name', 'Still legacy'); await legacy.submit();
  assert.equal(Object.hasOwn(legacy.saves[0].patch, 'fadeInFrames'), false);
});

test('trim never silently clamps either fade and invalid totals cannot submit', async () => {
  const current = clip({ fadeInFrames: 60, fadeOutFrames: 40 });
  const h = inspectorHarness({ clip: current, timeline: timeline(current) });
  h.edit('clip-duration', '80');
  assert.equal(h.find('clip-fade-in').props.value, 60); assert.equal(h.find('clip-fade-out').props.value, 40); assert.equal(h.find('clip-fade-in').props.max, 80);
  assert.equal(h.find('clip-fade-validation').props.role, 'alert'); assert.equal(h.find('clip-fade-in').props['aria-invalid'], true);
  assert.match(text(h.find('clip-fade-validation')), /80 帧.*同时检查并调整两项/); assert.equal(h.find('save-clip').props.disabled, true);
  await h.submit(); assert.equal(h.saves.length, 0);
  h.edit('clip-fade-in', '50'); h.edit('clip-fade-out', '30');
  assert.equal(h.find('clip-fade-validation'), undefined); assert.equal(h.find('save-clip').props.disabled, false);
  await h.submit(); assert.equal(h.saves[0].patch.durationFrames, 80); assert.equal(h.saves[0].patch.fadeInFrames, 50); assert.equal(h.saves[0].patch.fadeOutFrames, 30);
});

test('invalid local fade drafts stay visible and block even direct form submission', async () => {
  for (const value of ['', '-1', '1.5', '121']) {
    const h = inspectorHarness(); h.edit('clip-fade-in', value);
    assert.equal(h.find('clip-fade-in').props.value, value); assert.equal(h.find('save-clip').props.disabled, true);
    await h.submit(); assert.equal(h.saves.length, 0); assert.equal(h.dirtyEvents.at(-1), true);
  }
});

test('edits made during save survive its acknowledgment and keep the exact next revision', async () => {
  const pending = deferred(), calls = [];
  const h = inspectorHarness({ onSave: (id, patch, revision) => { calls.push({ id, patch: structuredClone(patch), revision }); return calls.length === 1 ? pending.promise : Promise.resolve(timeline(clip(patch), revision + 1)); } });
  h.edit('clip-fade-in', '15'); const saving = h.submit();
  h.render({ busy: true }); h.edit('clip-fade-out', '20'); h.edit('clip-gain', '0');
  assert.equal(h.find('save-clip').props.disabled, true);
  await h.submit(); assert.equal(calls.length, 1);
  const saved = clip(calls[0].patch); pending.resolve(timeline(saved, 8)); await saving;
  h.render({ clip: saved, timeline: timeline(saved, 8), busy: false });
  assert.equal(h.find('clip-fade-out').props.value, '20'); assert.equal(h.find('clip-gain').props.value, '0'); assert.equal(h.dirtyEvents.at(-1), true);
  assert.equal(Object.hasOwn(calls[0].patch, 'fadeOutFrames'), false);
  await h.submit(); h.render();
  assert.equal(calls[1].revision, 8); assert.equal(calls[1].patch.fadeInFrames, 15); assert.equal(calls[1].patch.fadeOutFrames, 20); assert.equal(calls[1].patch.gain, 0); assert.equal(h.dirtyEvents.at(-1), false);
});

test('failed or unacknowledged save preserves fade edits and does not retry', async () => {
  for (const failure of [null, new Error('Offline')]) {
    let calls = 0;
    const h = inspectorHarness({ onSave: async () => { calls++; if (failure) throw failure; return null; } });
    h.edit('clip-fade-out', '30');
    if (failure) await assert.rejects(h.submit(), /Offline/); else await h.submit();
    h.render(); assert.equal(calls, 1); assert.equal(h.find('clip-fade-out').props.value, '30'); assert.equal(h.dirtyEvents.at(-1), true);
  }
});

test('external fade update conflicts with a dirty draft until explicit reload; unrelated revisions preserve the draft', async () => {
  const h = inspectorHarness(); h.edit('clip-fade-in', '15');
  h.render({ timeline: timeline(clip(), 8) });
  assert.equal(h.find('save-clip').props.disabled, false); assert.equal(h.find('clip-fade-in').props.value, '15');
  const remote = clip({ fadeOutFrames: 25 }); h.render({ clip: remote, timeline: timeline(remote, 9) });
  assert.equal(h.find('save-clip').props.disabled, true); assert.equal(h.find('clip-fade-in').props.value, '15'); assert.match(h.text(), /此片段已在别处更新/);
  await h.submit(); assert.equal(h.saves.length, 0);
  h.reset(); assert.equal(h.find('clip-fade-in').props.value, 0); assert.equal(h.find('clip-fade-out').props.value, 25); assert.equal(h.dirtyEvents.at(-1), false);
  h.edit('clip-name', 'After reload'); await h.submit();
  assert.equal(h.saves[0].revision, 9); assert.equal(h.saves[0].patch.fadeOutFrames, 25); assert.equal(Object.hasOwn(h.saves[0].patch, 'fadeInFrames'), false);
});

test('keyed project unmount fences late fade acknowledgments and retained form submit', async () => {
  const pending = deferred(), calls = [];
  const old = inspectorHarness({ onSave: (id, patch, revision) => { calls.push({ id, patch, revision }); return pending.promise; } });
  old.edit('clip-fade-in', '10'); const retained = old.all().find(node => node.type === 'form').props.onSubmit;
  const saving = old.submit(); old.unmount(); const oldDirtyCount = old.dirtyEvents.length;
  const current = clip({ id: 'clip-b', fadeOutFrames: 5 });
  const next = inspectorHarness({ clip: current, timeline: timeline(current, 2, 'project-b') }); next.edit('clip-fade-out', '8');
  pending.resolve(timeline(clip({ fadeInFrames: 10 }), 8)); await saving;
  await retained({ preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(old.dirtyEvents.length, oldDirtyCount); assert.equal(old.dirtyEvents.at(-1), false);
  assert.equal(next.find('clip-fade-out').props.value, '8'); assert.equal(next.dirtyEvents.at(-1), true);
  const source = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /TimelineInspector key=\{`\$\{data\.project\?\.id\}:\$\{chosenClip\.id\}:\$\{inspectorEpoch\}`\}/);
});

test('source playback copy stays explicit about dry audio and the shared render path', () => {
  const source = readFileSync(new URL('../apps/web/src/Preview.jsx', import.meta.url), 'utf8');
  assert.match(source, /源素材原声 · 不应用片段音量或淡入\/淡出/);
  assert.match(source, /音频淡入\/淡出均使用与导出相同的本地渲染/);
});
