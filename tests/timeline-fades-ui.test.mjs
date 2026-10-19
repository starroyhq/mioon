import * as envelopeState from '../apps/web/src/clip-volume-envelope-state.ts';
import * as opacityState from '../apps/web/src/clip-opacity-envelope-state.ts';
import * as opacityAssembly from '../apps/web/src/clip-opacity-candidate-assembly.ts';
import * as roleState from '../apps/web/src/clip-audio-role-state.ts';
import * as roleContract from '../packages/contracts/src/timeline-audio-role.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import * as i18nCore from '../packages/i18n/src/index.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as audio from '../apps/web/src/clip-audio-state.ts';
import * as timelineFormat from '../apps/web/src/timeline-format-state.ts';
import * as clipDraft from '../apps/web/src/clip-draft-state.ts';
import * as clipLut from '../apps/web/src/clip-lut-state.ts';
import { createClipLutRecovery } from '../apps/web/src/clip-lut-recovery.ts';
import { isTimelineRecord } from '@mioon/contracts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import * as removalState from '../apps/web/src/timeline-removal.ts';
import {hasOpenWorkbenchModal} from '../apps/web/src/workbench-modal-state.ts';

const id = n => `77000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-12T00:00:00.000Z';
const asset = (patch = {}) => ({ id: id(3), projectId: id(1), name: 'Source', sha256: 'a'.repeat(64), mimeType: 'video/mp4', hasAudio: true, duration: 10, ...patch });
const clip = (patch = {}) => ({ id: id(4), assetId: id(3), name: 'Clip', trackId: id(5), startFrame: 0, durationFrames: 120, sourceInFrame: 0, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1, ...patch });
const timeline = (current = clip(), revision = 7, projectId = id(1)) => ({ id: id(2), projectId, revision, fps: 30, width: 720, height: 1280, clips: [current], tracks: [{ id: id(5), kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false }, { id: id(6), kind: 'audio', name: 'Audio', orderIndex: 1, hidden: false, muted: false }], durationFrames: current.startFrame + current.durationFrames, createdAt: stamp, updatedAt: stamp });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const inspectors = new Set();
afterEach(() => { for (const h of inspectors) h.unmount(); inspectors.clear(); });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const equalDeps = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));

// Run the real component tree and callbacks, with the same dependency-free
// hook fixture used by other inspector tests. Native layout is separate QA.
async function inspectorHarness(patch = {}, lutRpc = async () => { throw Error('No LUT RPC expected'); }) {
  const slots = [], modules = new Map(), dirtyEvents = [], saves = [];
  let cursor = 0, effects = [], layouts = [], tree, needsRender = false, unmounted = false;
  let props = { clip: clip(), timeline: timeline(), asset: asset(), onDirtyChange: value => dirtyEvents.push(value), onSave: async (id, saved, revision) => { saves.push({ id, patch: structuredClone(saved), revision }); const next = timeline(clip(saved), revision + 1); props = { ...props, clip: next.clips[0], timeline: next }; return next; }, onRemove() {}, onPreview() {}, busy: false, ...patch };
  // The real hook/controller run against this local CAS transport. No HTTP or
  // business request is substituted for the explicit onSave callback above.
  let envelope;
  const client = {
    get: async key => structuredClone(envelope ||= { supported: true, key, workspaceScope: 'b'.repeat(64), instanceId: id(7), revision: 0, targetStatus: 'matching', draft: null }),
    put: async value => { assert.equal(value.expectedRevision, envelope.revision); envelope = { ...envelope, revision: envelope.revision + 1, draft: { raw: structuredClone(value.raw), source: value.source, baseRevision: value.baseRevision, updatedAt: stamp } }; return structuredClone(envelope); },
    remove: async value => { assert.equal(value.expectedRevision, envelope.revision); envelope = { ...envelope, revision: envelope.revision + 1, draft: null }; return structuredClone(envelope); },
  };
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
    const code = transformSync(source, { loader: filename.endsWith('.tsx') ? 'tsx' : filename.endsWith('.ts') ? 'ts' : 'jsx', format: 'cjs' }).code;
    const module = { exports: {} };
    Function('require', 'module', 'exports', code)(id => {
      if (id === 'react') return react;
      if (id === './i18n/I18nProvider.tsx') return i18nTestModule();
      if (id === './UiPreferencesProvider.tsx') return {useUiPreferences: () => ({preferences: DEFAULT_UI_PREFERENCES})};
      if (id === './timeline-removal.ts') return removalState;
      if (id === './ClipRemovalControls.tsx') return load('ClipRemovalControls.tsx');
      if (id === './workbench-modal-state.ts') return {hasOpenWorkbenchModal};
      if (id === '../../../packages/i18n/src/index.ts') return i18nCore;
      if (id === './clip-audio-state.ts') return audio;
      if (id === './timeline-format-state.ts') return timelineFormat;
      if (id === './clip-draft-state.ts') return clipDraft;
      if (id === './clip-audio-role-state.ts') return roleState;
      if (id === './clip-volume-envelope-state.ts') return envelopeState;
      if (id === './clip-opacity-envelope-state.ts') return opacityState;
      if (id === './clip-opacity-candidate-assembly.ts') return opacityAssembly;
      if (id === '../../../packages/contracts/src/timeline-audio-role.ts') return roleContract;
      if (id === './ClipAudioRoleControls.tsx') return load('ClipAudioRoleControls.tsx');
      if (id === './clip-lut-state.ts') return { ...clipLut, createClipLutController: options => clipLut.createClipLutController({ ...options, recovery: createClipLutRecovery({ storage: () => ({ getItem: () => null, setItem() {}, removeItem() {} }), lock: async (_name, action) => action() }) }) };
      if (id === './ClipLutControls.tsx') return load('ClipLutControls.tsx');
      if (id === './api.ts') return { rpc: lutRpc };
      if (id === './clip-draft-client.ts') return { createClipDraftClient: () => client };
      if (id === './clip-draft-hook.ts') return load('clip-draft-hook.ts');
      if (id === './ClipDraftRecovery.tsx') return load('ClipDraftRecovery.tsx');
      if (id === './RecoveryStorageDetails.tsx') return load('RecoveryStorageDetails.tsx');
      if (id === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => true };
      if (id === './ClipAudioControls.tsx') return load('ClipAudioControls.tsx');
      if (id === './Timeline.tsx') return { assetKind: value => value?.mimeType?.split('/')[0] || 'image', framesLabel: String };
      if (id === '@mioon/contracts') return { sourceFrameCount: duration => Math.floor(duration * 30), isTimelineRecord };
      if (id === '@mioon/ui/components/workbench-confirm') return { useConfirmation: () => async () => true };
      if (id === './icons.tsx') return { default: 'Icon', __esModule: true };
      return primitive;
    }, module, module.exports);
    modules.set(filename, module.exports); return module.exports;
  }
  const component = load('TimelineInspector.tsx').default;
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
    async reset() { nodes(tree).find(node => node.type === 'Button' && /^(放弃修改|载入最新片段)$/.test(text(node))).props.onClick(); await tick(); h.render(); },
    unmount() { if (unmounted) return; for (const slot of slots) slot.cleanup?.(); unmounted = true; },
  };
  inspectors.add(h); h.render(); await tick(); h.render(); return h;
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

test('actual inspector renders integer fade controls inside its existing ScrollArea and keeps gain semantics', async () => {
  for (const mimeType of ['video/mp4', 'audio/wav']) {
    const h = await inspectorHarness({ asset: asset({ mimeType }) });
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

test('silent and unknown-audio videos show disabled fades with an honest no-effect explanation; images have no audio controls', async () => {
  for (const value of [false, undefined]) {
    const h = await inspectorHarness({ asset: asset({ hasAudio: value }) });
    assert.equal(h.find('clip-fade-in').props.disabled, true); assert.equal(h.find('clip-fade-out').props.disabled, true);
    assert.match(text(h.find('clip-fade-effect')), value === false ? /不含音轨.*不会产生效果/ : /尚未确认.*无法启用/);
    assert.equal(h.find('clip-gain').props.disabled, undefined, 'Existing gain semantics are preserved');
  }
  const image = await inspectorHarness({ asset: asset({ mimeType: 'image/png', hasAudio: false }) });
  assert.equal(image.find('clip-fade-in'), undefined); assert.equal(image.find('clip-gain'), undefined);
});

test('unrelated save on legacy clip never adds zero fields; explicitly changing one missing fade adds only that zero', async () => {
  const h = await inspectorHarness();
  h.edit('clip-name', 'New name'); await h.submit(); h.render();
  assert.equal(h.saves.length, 1); assert.equal(Object.hasOwn(h.saves[0].patch, 'fadeInFrames'), false); assert.equal(Object.hasOwn(h.saves[0].patch, 'fadeOutFrames'), false);
  assert.equal(h.find('save-clip').props.disabled, true); assert.equal(h.dirtyEvents.at(-1), false);
  h.edit('clip-fade-in', '0'); await h.submit(); h.render();
  assert.equal(h.saves[1].patch.fadeInFrames, 0); assert.equal(Object.hasOwn(h.saves[1].patch, 'fadeOutFrames'), false);
  assert.equal(h.saves[1].revision, 8);
});

test('unrelated save preserves explicit zero and fade values while discard restores omission', async () => {
  const explicit = clip({ fadeInFrames: 0, fadeOutFrames: 20 });
  const h = await inspectorHarness({ clip: explicit, timeline: timeline(explicit) });
  h.edit('clip-name', 'Renamed'); await h.submit();
  assert.equal(h.saves[0].patch.fadeInFrames, 0); assert.equal(h.saves[0].patch.fadeOutFrames, 20);
  const legacy = await inspectorHarness(); legacy.edit('clip-fade-in', '15'); await legacy.reset();
  assert.equal(legacy.find('clip-fade-in').props.value, 0); assert.equal(legacy.dirtyEvents.at(-1), false);
  legacy.edit('clip-name', 'Still legacy'); await legacy.submit();
  assert.equal(Object.hasOwn(legacy.saves[0].patch, 'fadeInFrames'), false);
});

test('trim never silently clamps either fade and invalid totals cannot submit', async () => {
  const current = clip({ fadeInFrames: 60, fadeOutFrames: 40 });
  const h = await inspectorHarness({ clip: current, timeline: timeline(current) });
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
    const h = await inspectorHarness(); h.edit('clip-fade-in', value);
    assert.equal(h.find('clip-fade-in').props.value, value); assert.equal(h.find('save-clip').props.disabled, true);
    await h.submit(); assert.equal(h.saves.length, 0); assert.equal(h.dirtyEvents.at(-1), true);
  }
});

test('edits made during save survive its acknowledgment without silently rebasing the newer draft', async () => {
  const pending = deferred(), calls = [];
  const h = await inspectorHarness({ onSave: (id, patch, revision) => { calls.push({ id, patch: structuredClone(patch), revision }); return calls.length === 1 ? pending.promise : Promise.resolve(timeline(clip(patch), revision + 1)); } });
  h.edit('clip-fade-in', '15'); const saving = h.submit(); await tick();
  h.render({ busy: true }); h.edit('clip-fade-out', '20'); h.edit('clip-gain', '0');
  assert.equal(h.find('save-clip').props.disabled, true);
  await h.submit(); assert.equal(calls.length, 1);
  const saved = clip(calls[0].patch); pending.resolve(timeline(saved, 8)); await saving;
  h.render({ clip: saved, timeline: timeline(saved, 8), busy: false });
  assert.equal(h.find('clip-fade-out').props.value, '20'); assert.equal(h.find('clip-gain').props.value, '0'); assert.equal(h.dirtyEvents.at(-1), true);
  assert.equal(Object.hasOwn(calls[0].patch, 'fadeOutFrames'), false);
  assert.equal(h.find('save-clip').props.disabled, true); await h.submit(); assert.equal(calls.length, 1);
  await h.reset(); h.edit('clip-fade-out', '20'); h.edit('clip-gain', '0');
  await h.submit(); h.render();
  assert.equal(calls[1].revision, 8); assert.equal(calls[1].patch.fadeInFrames, 15); assert.equal(calls[1].patch.fadeOutFrames, 20); assert.equal(calls[1].patch.gain, 0); assert.equal(h.dirtyEvents.at(-1), false);
});

test('failed or unacknowledged save preserves fade edits and does not retry', async () => {
  for (const failure of [null, new Error('Offline')]) {
    let calls = 0;
    const h = await inspectorHarness({ onSave: async () => { calls++; if (failure) throw failure; return null; } });
    h.edit('clip-fade-out', '30');
    await h.submit();
    h.render(); assert.equal(calls, 1); assert.equal(h.find('clip-fade-out').props.value, '30'); assert.equal(h.dirtyEvents.at(-1), true);
    if (failure) { assert.ok(h.text().includes(i18nCore.translate('zh-Hans', 'recovery.notice.unconfirmed'))); assert.doesNotMatch(h.text(), /Offline/); }
  }
});

test('every newer timeline revision preserves the exact dirty fade input and requires explicit reload', async () => {
  const h = await inspectorHarness(); h.edit('clip-fade-in', '15');
  h.render({ timeline: timeline(clip(), 8) });
  assert.equal(h.find('save-clip').props.disabled, true); assert.equal(h.find('clip-fade-in').props.value, '15');
  const remote = clip({ fadeOutFrames: 25 }); h.render({ clip: remote, timeline: timeline(remote, 9) });
  assert.equal(h.find('save-clip').props.disabled, true); assert.equal(h.find('clip-fade-in').props.value, '15'); assert.match(h.text(), /草稿的时间线版本或来源已变化/);
  await h.submit(); assert.equal(h.saves.length, 0);
  await h.reset(); assert.equal(h.find('clip-fade-in').props.value, 0); assert.equal(h.find('clip-fade-out').props.value, 25); assert.equal(h.dirtyEvents.at(-1), false);
  h.edit('clip-name', 'After reload'); await h.submit();
  assert.equal(h.saves[0].revision, 9); assert.equal(h.saves[0].patch.fadeOutFrames, 25); assert.equal(Object.hasOwn(h.saves[0].patch, 'fadeInFrames'), false);
});

test('keyed project unmount fences late fade acknowledgments and retained form submit', async () => {
  const pending = deferred(), calls = [];
  const old = await inspectorHarness({ onSave: (id, patch, revision) => { calls.push({ id, patch, revision }); return pending.promise; } });
  old.edit('clip-fade-in', '10'); const retained = old.all().find(node => node.type === 'form').props.onSubmit;
  const saving = old.submit(); await tick(); old.unmount(); const oldDirtyCount = old.dirtyEvents.length;
  const current = clip({ id: id(8), fadeOutFrames: 5 });
  const next = await inspectorHarness({ clip: current, timeline: timeline(current, 2, id(9)) }); next.edit('clip-fade-out', '8');
  pending.resolve(timeline(clip({ fadeInFrames: 10 }), 8)); await saving;
  await retained({ preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(old.dirtyEvents.length, oldDirtyCount); assert.equal(old.dirtyEvents.at(-1), false);
  assert.equal(next.find('clip-fade-out').props.value, '8'); assert.equal(next.dirtyEvents.at(-1), true);
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /TimelineInspector key=\{displayedClipInspector.key\}/);
  assert.match(source, /key: `\$\{data\.project\?\.id\}:\$\{chosenClip\.id\}:\$\{inspectorEpoch\}`/);
});

test('source playback copy stays explicit about dry audio and the shared render path', () => {
  const source = readFileSync(new URL('../apps/web/src/Preview.tsx', import.meta.url), 'utf8');
  assert.match(source, /timeline.preview.sourceUnprocessed/); assert.match(i18nCore.translate('zh-Hans', 'timeline.preview.sourceUnprocessed'), /源素材原声 · 不应用片段音量或淡入\/淡出/);
  assert.match(source, /timeline.preview.renderDetail/); assert.match(i18nCore.translate('zh-Hans', 'timeline.preview.renderDetail'), /音频淡入\/淡出均使用与导出相同的本地渲染/);
});

test('real inspector adopts SDR, applies a declared creative LUT and saves through the common draft pipeline', async () => {
  const projectId = id(1), assetId = id(3), lutId = id(90), rpcCalls = [];
  const resource = { id: lutId, projectId, name: 'Creative.cube', kind: 'cube3d', sha256: 'c'.repeat(64), sizeBytes: 100, profile: 'mioon-cube3d-normalized-tetrahedral-v1',
    metadata: { profileId: 'mioon-cube3d-normalized-tetrahedral-v1', size: 2, title: null, domainMin: [0, 0, 0], domainMax: [1, 1, 1], rowCount: 8, rowOrder: 'red-fastest', interpolation: 'tetrahedral', numericPrecision: 'float64' },
    createdAt: stamp, colourCompatibility: 'unverified', renderBinding: 'not_implemented' };
  const h = await inspectorHarness({}, async (operation, input) => {
    rpcCalls.push({ operation, input });
    if (operation === 'timeline.colour.source.inspect') return { projectId, assetId, assetSha256: 'a'.repeat(64), streamIndex: 0, evidence: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited', pixelFormat: 'yuv420p', bitDepth: 8, hdrMetadata: false }, status: 'compatible', reason: null };
    if (operation === 'lut.list') return { projectId, items: [resource], nextAfter: null };
    if (operation === 'lut.inspect') return { resource, integrity: 'verified' };
    throw Error(`Unexpected ${operation}`);
  });
  assert.equal(h.saves.length, 0); assert.equal(rpcCalls.length, 0);
  h.find('open-clip-lut').props.onClick(); await tick(); h.render();
  h.edit('clip-lut-source-range', 'limited');
  h.find('clip-lut-source-declaration').props.onChange({ target: { checked: true } }); h.render();
  assert.equal(h.find('confirm-clip-colour-source').props.disabled, false);
  h.find('confirm-clip-colour-source').props.onClick(); h.render();
  assert.equal(h.saves.length, 0, 'Explicit source confirmation is still a local draft');
  h.edit('clip-lut-resource', lutId); await tick(); h.render();
  h.find('clip-lut-look-declaration').props.onChange({ target: { checked: true } }); h.render();
  h.find('apply-clip-lut').props.onClick(); h.render(); h.edit('clip-lut-strength', '37');
  h.find('clip-lut-enabled').props.onChange({ target: { checked: false } }); h.render();
  assert.equal(h.saves.length, 0); assert.equal(h.find('save-clip').props.disabled, false);
  await h.submit(); await tick(); h.render();
  assert.equal(h.saves.length, 1); const saved = h.saves[0].patch.colour;
  assert.equal(saved.profileId, 'mioon-rec709-sdr-clip-v1'); assert.equal(saved.source.assetSha256, 'a'.repeat(64)); assert.equal(saved.source.range, 'limited');
  assert.deepEqual(saved.look, { resourceId: lutId, resourceSha256: resource.sha256, resourceProfile: resource.profile, purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: false, strength: 0.37 });
  assert.equal(h.find('save-clip').props.disabled, true);
  assert.deepEqual(rpcCalls.map(call => call.operation), ['timeline.colour.source.inspect', 'lut.list', 'lut.inspect']);
});


test('actual inspector role selection uses shared dirty form and one existing Save revision', async () => {
  const h = await inspectorHarness({ draftContext: { audioRoleEditable: true } });
  assert.equal(h.find('clip-audio-role').props.disabled, false);
  assert.equal(h.find('clip-audio-role').props.value, '');
  assert.equal(h.saves.length, 0);
  h.edit('clip-audio-role', 'music');
  assert.equal(h.find('save-clip').props.disabled, false);
  assert.equal(h.saves.length, 0, 'Selecting is not an independent business save');
  await h.submit(); h.render();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0].patch.audioRole, 'music'); assert.equal(h.saves[0].revision, 7);
  assert.equal(h.find('clip-audio-role').props.value, 'music');
  assert.equal(h.find('save-clip').props.disabled, true);
  h.edit('clip-audio-role', ''); await h.submit(); h.render();
  assert.equal(h.saves.length, 2); assert.equal(h.saves[1].patch.audioRole, null); assert.equal(h.saves[1].revision, 8);
});

test('missing role capability blocks captured selector callbacks but unrelated inspector edits save', async () => {
  const h = await inspectorHarness();
  assert.equal(h.find('clip-audio-role').props.disabled, true);
  h.edit('clip-audio-role', 'human');
  assert.equal(h.find('save-clip').props.disabled, true);
  h.edit('clip-name', 'Renamed'); await h.submit(); h.render();
  assert.equal(h.saves.length, 1); assert.equal(Object.hasOwn(h.saves[0].patch, 'audioRole'), false);
});

test('role eligibility includes silent video, zero gain and muted timeline without enabling fades', async () => {
  const current = clip({ gain: 0 }); const saved = timeline(current); saved.tracks[0].muted = true;
  const h = await inspectorHarness({ clip: current, timeline: saved, asset: asset({ hasAudio: false }), draftContext: { audioRoleEditable: true } });
  assert.equal(h.find('clip-audio-role').props.disabled, false);
  assert.equal(h.find('clip-fade-in').props.disabled, true);
  h.edit('clip-audio-role', 'sfx'); await h.submit(); h.render();
  assert.equal(h.saves[0].patch.audioRole, 'sfx'); assert.equal(h.saves[0].patch.gain, 0);
});

test('image inspector excludes audio role; restored supported editor can save without sidecar support', async () => {
  const image = await inspectorHarness({ asset: asset({ mimeType: 'image/png', hasAudio: false }), draftContext: { audioRoleEditable: true } });
  assert.equal(image.find('clip-audio-role'), undefined);
  const restored = await inspectorHarness({ draftContext: { restored: true, audioRoleEditable: true } });
  restored.edit('clip-audio-role', 'human'); await restored.submit(); restored.render();
  assert.equal(restored.saves.length, 1); assert.equal(restored.saves[0].patch.audioRole, 'human');
});


test('captured enabled role selector cannot write after capability loss or owner unmount',async()=>{
 const h=await inspectorHarness({draftContext:{audioRoleEditable:true}});
 const captured=h.find('clip-audio-role').props.onChange;
 h.render({draftContext:{audioRoleEditable:false}});captured({target:{value:'human'}});h.render();assert.equal(h.find('save-clip').props.disabled,true);
 h.render({draftContext:{audioRoleEditable:true}});const later=h.find('clip-audio-role').props.onChange;h.unmount();later({target:{value:'music'}});assert.equal(h.saves.length,0);
});
