import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import { projectOpenAttempt, canPublishProjectOpen } from '../apps/web/src/project-open-state.ts';
import { workspaceOriginScope } from '../apps/web/src/workspace-origin.js';
import * as replacement from '../apps/web/src/clip-source-replacement.js';
import * as submissions from '../apps/web/src/submissions.js';
import { timelineHistoryState } from '../apps/web/src/timeline-history.js';
import { mutationNotApplied } from '../apps/web/src/mutation-submissions.js';

const taskIntentModule = { exports: {} };
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const id = n => `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), clipId = id(2), oldAssetId = id(3), newAssetId = id(4), trackId = id(5), timelineId = id(6), versionId = id(7), shotId = id(8);
const clip = patch => ({ id: clipId, name: '保留的片段名', assetId: oldAssetId, trackId, startFrame: 12, durationFrames: 90, sourceInFrame: 30, rect: { x: 20, y: 40, width: 680, height: 1200 }, gain: 0.7, ...patch });
const asset = (assetId, patch) => ({ id: assetId, projectId, name: assetId === oldAssetId ? '旧来源' : '新来源', mimeType: 'video/mp4', duration: assetId === oldAssetId ? 6 : 8, hasAudio: true, sha256: assetId, ...patch });
const timeline = (current = clip(), patch) => ({ id: timelineId, projectId, revision: 7, fps: 30, width: 720, height: 1280, durationFrames: 102,
  clips: [current], tracks: [{ id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false }], createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...patch });
const context = patch => ({ scope: `${projectId}:1:0`, projectId, clipId, timeline: timeline(), assets: [asset(oldAssetId), asset(newAssetId)],
  versions: [{ id: versionId, projectId, assetId: newAssetId, shotId, number: 2 }], shots: [{ id: shotId, projectId, title: '来源镜头' }], connected: true, visible: true, dirty: false, busy: false, pending: false, ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function acknowledged(review) {
  const saved = structuredClone(review.clip);
  for (const key of ['versionId', 'shotId', 'jobId']) delete saved[key];
  saved.assetId = review.candidate.assetId;
  if (review.candidate.versionId) { saved.versionId = review.candidate.versionId; saved.shotId = review.candidate.version.shotId; }
  return timeline(saved, { revision: review.expectedRevision + 1 });
}
function fixture(initial = context(), submit) {
  let live = initial;
  const calls = [], responses = [];
  const controller = replacement.createClipReplacementController({ getContext: () => live, submit: review => { calls.push(review); const waiting = deferred(); responses.push(waiting); return submit ? submit(review) : waiting.promise; } });
  controller.setContext(live);
  return { controller, calls, responses, state: () => controller.getState(), set(patch, commit = true) { live = { ...live, ...patch }; if (commit) controller.setContext(live); },
    review(key = `asset:${newAssetId}`) { assert.equal(controller.begin(), true); assert.equal(controller.choose(key), true); return controller.review(); } };
}

test('candidate list is current-project, same media category, non-current and exactly range/fade compatible', () => {
  const current = context({ timeline: timeline(clip({ fadeInFrames: 10, fadeOutFrames: 20 })) });
  current.assets.push(asset(id(10), { mimeType: 'image/png' }), asset(id(11), { mimeType: 'audio/wav' }), asset(id(12), { projectId: id(99) }),
    asset(id(13), { duration: 3.99 }), asset(id(14), { duration: null }), asset(id(15), { hasAudio: false }), asset(id(16), { hasAudio: undefined }));
  assert.deepEqual(replacement.clipReplacementCandidates(current).map(item => item.key), [`asset:${newAssetId}`, `version:${versionId}`]);
  const before = structuredClone(current);
  assert.match(replacement.clipReplacementCompatibility(clip(), current.assets[0], current.assets[0], projectId), /当前来源/);
  assert.match(replacement.clipReplacementCompatibility(clip(), current.assets[0], asset(id(17), { duration: 119 / 30 }), projectId), /不会自动裁短/);
  assert.equal(replacement.clipReplacementCompatibility(clip(), current.assets[0], asset(id(18), { duration: 4 }), projectId), '');
  assert.deepEqual(current, before, 'Filtering never clamps or mutates saved clip fields');
  for (const mimeType of ['image/png', 'audio/wav']) {
    const c = context({ timeline: timeline(clip({ sourceInFrame: 0 })), assets: [asset(oldAssetId, { mimeType }), asset(newAssetId, { mimeType })] });
    assert.equal(replacement.clipReplacementCandidates(c)[0].assetId, newAssetId);
    if (mimeType.startsWith('image')) { c.assets[1].duration = null; assert.equal(replacement.clipReplacementCandidates(c).length, 2); }
  }
});

test('review pins copied content and exact revision; only explicitly selected versions enter the payload', () => {
  const current = context({ timeline: timeline(clip({ versionId: id(91), shotId: id(92), jobId: id(93), fadeInFrames: 0 })) });
  const review = replacement.createClipReplacementReview(current, `asset:${newAssetId}`);
  assert.deepEqual(review.input, { clipId, assetId: newAssetId });
  assert.equal(review.expectedRevision, 7); assert.equal(review.clip.sourceInFrame, 30); assert.equal(review.clip.durationFrames, 90);
  assert.ok(Object.isFrozen(review)); assert.ok(Object.isFrozen(review.clip.rect)); assert.ok(Object.isFrozen(review.candidate.source));
  current.assets[1].name = 'Changed'; current.timeline.clips[0].rect.x = 0;
  assert.equal(review.candidate.source.name, '新来源'); assert.equal(review.clip.rect.x, 20);
  const version = replacement.createClipReplacementReview(context(), `version:${versionId}`);
  assert.deepEqual(version.input, { clipId, assetId: newAssetId, versionId }); assert.match(version.candidate.label, /来源镜头 · V2/);
  for (const patch of [{ projectId: id(99) }, { assetId: oldAssetId }, { shotId: id(99) }, { number: 0 }]) {
    const c = context(); Object.assign(c.versions[0], patch);
    assert.equal(replacement.createClipReplacementReview(c, `version:${versionId}`), null);
    assert.deepEqual(replacement.clipReplacementCandidates(c).map(item => item.key), [`asset:${newAssetId}`]);
  }
});

test('review requires saved selection, known timeline revision, online status and a clean draft', () => {
  for (const patch of [{ dirty: true }, { pending: true }, { busy: true }, { connected: false }, { visible: false }, { projectId: id(99) }, { clipId: id(99) }, { scope: null }, { timeline: timeline(clip(), { revision: 0 }) }]) {
    const c = context(patch); assert.ok(replacement.clipReplacementBlockedReason(c)); assert.equal(replacement.createClipReplacementReview(c, `asset:${newAssetId}`), null);
  }
  assert.match(replacement.clipReplacementBlockedReason(context({ dirty: true })), /保存或放弃/);
});

for (const [name, update] of [
  ['revision', c => { c.timeline.revision++; }], ['timeline ID', c => { c.timeline.id = id(99); }],
  ['clip timing', c => { c.timeline.clips[0].startFrame++; }], ['clip rect', c => { c.timeline.clips[0].rect.x = 0; }],
  ['clip gain', c => { c.timeline.clips[0].gain = 0; }], ['clip fades', c => { c.timeline.clips[0].fadeOutFrames = 10; }],
  ['candidate name', c => { c.assets[1].name = 'Renamed'; }], ['candidate duration', c => { c.assets[1].duration = 9; }],
  ['candidate hash', c => { c.assets[1].sha256 = 'different'; }], ['candidate audio', c => { c.assets[1].hasAudio = false; }],
  ['candidate byte size', c => { c.assets[1].sizeBytes = 200; }], ['candidate video stream', c => { c.assets[1].hasVideo = false; }],
  ['candidate managed path', c => { c.assets[1].relativePath = 'media/changed.mp4'; }],
  ['old source', c => { c.assets[0].duration = 7; }], ['version number', c => { c.versions[0].number = 3; }],
  ['version hash', c => { c.versions[0].sha256 = 'different'; }], ['version lineage', c => { c.versions[0].jobId = id(99); }],
  ['version owner', c => { c.versions[0].projectId = id(99); }], ['shot label', c => { c.shots[0].title = 'Renamed shot'; }],
]) test(`${name} change invalidates pinned review without refreshing or reviving its approval`, async () => {
  const f = fixture(), review = f.review(`version:${versionId}`), changed = context(); update(changed); f.set(changed);
  assert.equal(f.state().phase, 'stale'); assert.equal(f.state().review, review);
  f.set(context()); assert.equal(f.state().phase, 'stale'); assert.equal(await f.controller.approve(review), null); assert.equal(f.calls.length, 0);
});

test('dirty edits block even retained approval before React commits, and are never saved/discarded by replacement', async () => {
  const f = fixture(), review = f.review(), before = structuredClone(review);
  f.set({ dirty: true }, false); assert.equal(await f.controller.approve(review), null); assert.equal(f.calls.length, 0);
  assert.deepEqual(review, before); assert.equal(f.state().phase, 'review');
  f.set({ dirty: false }); const waiting = f.controller.approve(review); assert.equal(f.calls.length, 1);
  f.responses[0].resolve({ status: 'applied', timeline: acknowledged(review) }); await waiting; assert.equal(f.state().phase, 'applied');
});

test('choose and review are read-only; explicit approval is once-only and duplicate clicks do not re-key', async () => {
  const f = fixture(), review = f.review(); assert.equal(f.calls.length, 0);
  assert.equal(await f.controller.approve({ ...review }), null);
  const waiting = f.controller.approve(review); assert.equal(f.state().phase, 'sending');
  assert.equal(await f.controller.approve(review), null); assert.equal(f.controller.begin(), false); assert.equal(f.controller.cancel(), false); assert.equal(f.calls.length, 1);
  f.responses[0].resolve({ status: 'applied', timeline: acknowledged(review) }); await waiting;
  assert.equal(f.state().phase, 'applied'); assert.equal(await f.controller.approve(review), null); assert.equal(f.calls.length, 1);
});

test('cancelled review and retained choose/start/cancel callbacks cannot act on a newer review', async () => {
  const f = fixture(), initial = f.state(), old = f.review(), oldState = f.state(); f.controller.cancel(oldState);
  const next = f.review(); assert.notEqual(old, next);
  assert.equal(await f.controller.approve(old), null); assert.equal(f.controller.begin(initial), false); assert.equal(f.controller.cancel(oldState), false);
  assert.equal(f.controller.choose(`asset:${newAssetId}`, oldState), false); assert.equal(f.state().review, next); assert.equal(f.calls.length, 0);
});

test('Properties tab and dock collapse preserve review but hidden retained approval cannot submit', async () => {
  const f = fixture(), review = f.review(); f.set({ visible: false });
  assert.equal(f.state().phase, 'review'); assert.equal(f.state().review, review); assert.equal(await f.controller.approve(review), null);
  f.set({ visible: true }); assert.equal(f.state().review, review); assert.equal(f.calls.length, 0);
});

for (const patch of [{ projectId: id(99) }, { scope: `${projectId}:2:0` }, { clipId: id(99) }]) {
  test(`live owner fences late success and error before layout commit: ${JSON.stringify(patch)}`, async () => {
    for (const reject of [false, true]) {
      const f = fixture(), review = f.review(), waiting = f.controller.approve(review);
      f.set(patch, false);
      if (reject) f.responses[0].reject(Object.assign(Error('/private/secret'), { definitive: true })); else f.responses[0].resolve({ status: 'applied', timeline: acknowledged(review) });
      await waiting; assert.equal(f.state().phase, 'idle'); assert.equal(f.state().review, null);
      assert.equal(await f.controller.approve(review), null); assert.equal(f.calls.length, 1);
    }
  });
}

test('unmount fences all callbacks and acknowledgements; StrictMode reattachment can begin a fresh review', async () => {
  const f = fixture(), review = f.review(), waiting = f.controller.approve(review); f.controller.dispose();
  const before = f.state(); f.responses[0].resolve({ status: 'applied', timeline: acknowledged(review) }); await waiting;
  assert.equal(f.state(), before); assert.equal(f.controller.begin(), false); assert.equal(await f.controller.approve(review), null);
  f.controller.activate(); f.set(context()); assert.equal(f.state().phase, 'idle'); assert.ok(f.review());
});

test('null, malformed success and thrown errors including definitive 4xx remain unknown; no automatic reapproval', async () => {
  for (const result of [null, {}, { status: 'applied', timeline: timeline() }, Object.assign(Error('/private/access-token=bad'), { code: 'NOT_FOUND', definitive: true })]) {
    const f = fixture(context(), () => result instanceof Error ? Promise.reject(result) : Promise.resolve(result));
    const review = f.review(); await f.controller.approve(review); assert.equal(f.state().phase, 'unknown');
    assert.match(f.state().error, /恢复同一请求/); assert.doesNotMatch(f.state().error, /private|access-token|bad/);
    assert.equal(f.controller.begin(), false); assert.equal(await f.controller.approve(review), null); assert.equal(f.calls.length, 1);
  }
  const f = fixture(context(), () => Promise.resolve({ status: 'rejected', error: { code: 'SOURCE_BOUNDS', message: '/private/source.mp4' } }));
  await f.controller.approve(f.review()); assert.equal(f.state().phase, 'error'); assert.match(f.state().error, /未进行自动裁短/);
});

test('acknowledgement preserves every retained field and absent/explicit-zero fades and binds exact provenance', () => {
  for (const fades of [{}, { fadeInFrames: 0 }, { fadeOutFrames: 10 }, { fadeInFrames: 20, fadeOutFrames: 0 }]) {
    for (const key of [`asset:${newAssetId}`, `version:${versionId}`]) {
      const review = replacement.createClipReplacementReview(context({ timeline: timeline(clip({ ...fades, versionId: id(91), shotId: id(92), jobId: id(93) })) }), key);
      const value = acknowledged(review); assert.equal(replacement.clipReplacementAcknowledged(review, value), true);
      assert.equal(Object.hasOwn(value.clips[0], 'fadeInFrames'), Object.hasOwn(fades, 'fadeInFrames'));
      for (const patch of [{ assetId: oldAssetId }, { name: 'Renamed' }, { id: id(99) }, { sourceInFrame: 0 }, { durationFrames: 89 }, { gain: 0 }, { jobId: id(93) }, { fadeInFrames: 1 }]) {
        const wrong = structuredClone(value); Object.assign(wrong.clips[0], patch); assert.equal(replacement.clipReplacementAcknowledged(review, wrong), false);
      }
      if (!review.candidate.versionId) { value.clips[0].versionId = versionId; assert.equal(replacement.clipReplacementAcknowledged(review, value), false); }
    }
  }
});

test('error copy is actionable and never echoes server locations or secrets', () => {
  for (const code of ['UNAUTHORIZED', 'REVISION_CONFLICT', 'SOURCE_UNCHANGED', 'INVALID_CLIP_TYPE', 'INVALID_VERSION', 'SOURCE_BOUNDS', 'FADE_AUDIO_UNSUPPORTED', 'TIMELINE_SOURCE_UNAVAILABLE', 'UNKNOWN']) {
    const message = replacement.clipReplacementErrorMessage({ code, message: '/private/source.mp4 Authorization: Bearer secret' });
    assert.ok(message.length > 10); assert.doesNotMatch(message, /private|Authorization|secret/);
  }
});

const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const equalDeps = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
function componentHarness(patch = {}) {
  const slots = [], calls = [], responses = [], opened = [];
  let cursor = 0, effects = [], tree, needsRender = false, visible = true, dirty = false;
  let props = { context: context(), getDirty: () => dirty, onOpenRequests: () => opened.push(true), onReplace: review => { calls.push(review); const waiting = deferred(); responses.push(waiting); return waiting.promise; }, ...patch };
  const react = { createElement: (type, properties, ...children) => ({ type, props: { ...properties, children } }),
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { const value = typeof next === 'function' ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; needsRender = true; } }]; },
    useRef(initial) { return slots[cursor++] ||= { current: initial }; },
    useLayoutEffect(callback, deps) { const index = cursor++, previous = slots[index]; if (previous && equalDeps(deps, previous.deps)) return; slots[index] = { deps, callback, cleanup: previous?.cleanup }; effects.push(index); },
  }; react.default = react;
  const source = readFileSync(new URL('../apps/web/src/ClipSourceReplacement.jsx', import.meta.url), 'utf8');
  const module = { exports: {} };
  Function('require', 'module', 'exports', transformSync(source, { loader: 'jsx', format: 'cjs' }).code)(name => name === 'react' ? react : name === './clip-source-replacement.js' ? replacement : name === './workspace-visibility.jsx' ? { useWorkspaceVisibility: () => visible } : new Proxy({}, { get: (_, key) => String(key) }), module, module.exports);
  const h = { calls, responses, opened,
    render(next = {}) { props = { ...props, ...next }; let attempts = 0; do { needsRender = false; cursor = 0; effects = []; tree = module.exports.default(props); for (const index of effects) { slots[index].cleanup?.(); slots[index].cleanup = slots[index].callback(); } assert.ok(++attempts < 15); } while (needsRender); return tree; },
    find(testId) { return nodes(tree).find(node => node.props?.['data-testid'] === testId || node.props?.id === testId); },
    text() { return text(tree); }, all() { return nodes(tree); }, setDirty(value, render = true) { dirty = value; if (render) h.render(); }, setVisible(value) { visible = value; h.render(); },
    click(testId) { const node = h.find(testId); assert.ok(node, testId); const result = node.props.onClick(); h.render(); return result; },
    review() { h.click('begin-clip-replacement'); h.find('clip-replacement-candidate').props.onChange({ target: { value: `version:${versionId}` } }); h.render(); h.click('review-clip-replacement'); },
  }; h.render(); return h;
}

test('inline component renders accessible choose/review/explicit approval and every pinned source field', () => {
  const h = componentHarness(); assert.equal(h.find('clip-source-replacement').props['aria-labelledby'], 'clip-replacement-title');
  h.review(); assert.equal(h.calls.length, 0);
  for (const expected of [/旧来源/, /6\.00 秒/, /新来源/, /8\.00 秒/, /来源镜头 · V2/, /修订 7/, /30 帧/, /90 帧/, /12 → 102 帧/, /名称、位置、时长、入点/]) assert.match(h.text(), expected);
  assert.ok(h.all().filter(node => node.type === 'Button').every(node => node.props.type === 'button'));
  assert.equal(h.all().some(node => node.type === 'form' || node.props.role === 'dialog'), false);
  h.setDirty(true); assert.equal(h.find('approve-clip-replacement').props.disabled, true); assert.match(h.text(), /保存或放弃/);
});

test('real component preserves review across tab/collapse, fences retained approval after cancel, and explains unknown recovery', async () => {
  const h = componentHarness(); h.review(); const pinnedText = text(h.find('clip-replacement-review')), oldApprove = h.find('approve-clip-replacement').props.onClick;
  h.setVisible(false); assert.equal(h.find('approve-clip-replacement').props.disabled, true); await oldApprove(); assert.equal(h.calls.length, 0);
  h.setVisible(true); assert.equal(text(h.find('clip-replacement-review')), pinnedText);
  h.click('cancel-clip-replacement'); await oldApprove(); assert.equal(h.calls.length, 0);
  h.review(); const waiting = h.click('approve-clip-replacement'); assert.equal(h.calls.length, 1);
  assert.equal(h.find('clip-source-replacement').props['aria-busy'], true);
  h.responses[0].resolve(null); await waiting; h.render({ context: context({ pending: true }) });
  assert.equal(h.find('clip-source-replacement').props['data-phase'], 'unknown'); assert.match(h.text(), /当前浏览器会话.*无法保证自动找回/);
  assert.equal(h.find('approve-clip-replacement'), undefined); assert.equal(h.find('close-clip-replacement'), undefined);
  h.click('recover-clip-replacement'); assert.equal(h.opened.length, 1);
  assert.ok(h.all().some(node => node.props.role === 'alert'));
});

test('real component blocks same-tick dirty callbacks and exposes an immutable stale review with no approval', async () => {
  const h = componentHarness(); h.review(); const approve = h.find('approve-clip-replacement').props.onClick;
  h.setDirty(true, false); await approve(); assert.equal(h.calls.length, 0); h.setDirty(false);
  const changed = context(); changed.assets[1].name = 'Changed after review'; h.render({ context: changed });
  assert.equal(h.find('clip-source-replacement').props['data-phase'], 'stale'); assert.match(h.text(), /信息已变化/);
  assert.match(text(h.find('clip-replacement-review')), /新来源/); assert.doesNotMatch(text(h.find('clip-replacement-review')), /Changed after review/);
  assert.equal(h.find('approve-clip-replacement'), undefined); await approve(); assert.equal(h.calls.length, 0);
});

const appSource = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const extract = (start, end) => appSource.slice(appSource.indexOf(start), appSource.indexOf(end, appSource.indexOf(start)));
function sessionFixture(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { get length() { return values.size; }, key: index => [...values.keys()][index], getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; }); return values;
}
function parentHarness({ ready = true } = {}) {
  const c = context(), calls = [], dataRef = { current: { project: { id: projectId }, ...c } }, viewRef = { current: { activeMode: 'editing', editing: { selectedClipId: clipId, quickAssetId: null } } };
  const deps = { ...replacement, canPublishProjectOpen, workspaceOriginScope,
    nativeWindow: null, projectOpening: { phase: ready ? 'ready' : 'loading' },
    // This extracted App slice reaches the passive native status hook. Web has
    // no native binding; preserve that exact boundary without any host action.
    useEditorWindowStatus: binding => assert.equal(binding, null),
    openedProject: { current: ready ? projectOpenAttempt(projectId, 1, 'normal') : null }, importSession: { current: { active: true, selection: 0 } }, viewReady: { current: true }, workspaceRef: { current: { restored: false } }, dataRef, viewRef, currentProject: { current: projectId }, projectEpoch: { current: 1 }, inspectorEpoch: 0, dirtyRef: { current: false }, isBusy: () => false,
    tasksRef: { current: { blocked: () => false } }, pendingForProject: () => [], online: true, auth: true, loading: false, mutateTimeline: async (...args) => { calls.push(args); return acknowledged(args[3].review || replacement.createClipReplacementReview(c, `asset:${newAssetId}`)); } };
  const compiled = Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps; ${extract('function projectSessionReady()', '  const panelSurface =')} ${extract('function clipReplacementContext()', 'function exportSettingsContext()')} return { clipReplacementContext, replaceTimelineClipSource };`)(deps);
  return { ...compiled, deps, calls, c };
}

test('actual parent guard rechecks current project, selection, scope, revision, metadata and unsaved draft before dispatch', async () => {
  for (const change of [h => { h.deps.currentProject.current = id(99); }, h => { h.deps.projectEpoch.current++; }, h => { h.deps.viewRef.current.editing.selectedClipId = id(99); }, h => { h.deps.viewRef.current.activeMode = 'canvas'; }, h => { h.deps.viewRef.current.editing.quickAssetId = newAssetId; }, h => { h.deps.dirtyRef.current = true; }, h => { h.deps.dataRef.current.timeline.revision++; }, h => { h.deps.dataRef.current.assets[1].name = 'Changed'; }]) {
    const h = parentHarness(), review = replacement.createClipReplacementReview(h.c, `asset:${newAssetId}`); change(h);
    assert.equal((await h.replaceTimelineClipSource(review)).status, 'rejected'); assert.equal(h.calls.length, 0);
  }
  const h = parentHarness(), review = replacement.createClipReplacementReview(h.c, `asset:${newAssetId}`);
  assert.equal((await h.replaceTimelineClipSource(review)).status, 'applied'); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'timeline.clip.replaceSource'); assert.equal(h.calls[0][1], review.input); assert.equal(h.calls[0][2], 7);
});

test('actual parent replacement cannot use retained project metadata before session acceptance', async () => {
  const h = parentHarness({ ready: false }), review = replacement.createClipReplacementReview(h.c, `asset:${newAssetId}`);
  const live = h.clipReplacementContext();
  assert.equal(live.projectId, null); assert.equal(live.visible, false); assert.equal(live.connected, false);
  assert.equal((await h.replaceTimelineClipSource(review)).status, 'rejected'); assert.deepEqual(h.calls, []);
});

function runHarness(rpc) {
  const currentProject = { current: projectId }, calls = [], notices = [], busy = new Set(), dataRef = { current: { project: { id: projectId }, timeline: timeline() } };
  const deps = { ...submissions, shotTextRef: { current: null }, TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof, mutationNotApplied, clipReplacementErrorMessage: replacement.clipReplacementErrorMessage,
    readableError: error => error.message, context: () => ({ projectId }), isCurrent: owner => owner.projectId === currentProject.current,
    isBusy: key => busy.has(key), markBusy: (_project, key, value) => value ? busy.add(key) : busy.delete(key),
    isReferenceOperation: () => false, currentProject, dataRef, requestCounter: { current: 0 }, setData: value => { if (typeof value === 'function') value(dataRef.current); },
    setPending() {}, setSourceRangeRefresh() {}, setDispositionRefresh() {}, setAuth() {}, openTasks() {}, notify: (...args) => notices.push(args),
    refresh: async () => {}, rpc: async (operation, input) => { calls.push({ operation, input: structuredClone(input) }); return rpc(operation, input); } };
  Object.assign(deps, { captureTaskWorkspaceIntent, readTaskRevealContext: () => { const captured = deps.context(); return { active: true, projectId: captured.projectId, projectEpoch: 0, navigationEpoch: captured.epoch || 0, panelIntent: 0, workspaceScope: JSON.stringify(captured.workspace || 'test-workspace') }; } });
  const run = Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps; ${extract('async function runSession(', 'async function inspect(').replace('async function runSession(', 'async function run(')} return run;`)(deps);
  return { run, calls, notices };
}

test('actual App legacy session runner retains the exact replacement receipt for malformed success and unknown→404/409 replays', async t => {
  sessionFixture(t);
  const input = { projectId, clipId, assetId: newAssetId, expectedRevision: 7, requestId: 'source-replacement-original' };
  let response = null, error = Error('Lost connection');
  const h = runHarness(() => { if (error) throw error; return response; });
  await h.run('timeline:mutation', 'timeline.clip.replaceSource', input);
  const original = submissions.readPending(projectId, 'timeline:mutation'); assert.deepEqual(original.input, input);
  for (const code of ['NOT_FOUND', 'TIMELINE_SOURCE_UNAVAILABLE', 'INVALID_TIMELINE_SNAPSHOT', 'IDEMPOTENCY_CONFLICT', 'UNAUTHORIZED']) {
    error = Object.assign(Error('/private/ownership'), { code, definitive: true });
    await h.run(original.key, original.operation, original.input, undefined, { replay: true });
    assert.deepEqual(submissions.readPending(projectId, 'timeline:mutation'), original, code);
  }
  error = null; response = timeline(); await h.run(original.key, original.operation, original.input, undefined, { replay: true });
  assert.deepEqual(submissions.readPending(projectId, 'timeline:mutation'), original);
  response = acknowledged(replacement.createClipReplacementReview(context(), `asset:${newAssetId}`));
  await h.run(original.key, original.operation, original.input, undefined, { replay: true });
  assert.equal(submissions.readPending(projectId, 'timeline:mutation'), null);
  assert.ok(h.calls.every(call => JSON.stringify(call.input) === JSON.stringify(input)));
  assert.ok(h.notices.every(([message]) => !/private|ownership/.test(message)));
});

test('actual App legacy session runner clears replacement only for a matching request-bound fresh not-applied proof', async t => {
  sessionFixture(t);
  const input = { projectId, clipId, assetId: newAssetId, expectedRevision: 7, requestId: 'source-replacement-rejected' };
  let details = { mutationOutcome: 'not_applied', requestId: 'wrong-request' };
  const h = runHarness(() => { throw Object.assign(Error('/private/source.mp4'), { code: 'SOURCE_BOUNDS', definitive: true, details }); });
  await h.run('timeline:mutation', 'timeline.clip.replaceSource', input); assert.ok(submissions.readPending(projectId, 'timeline:mutation'));
  details = { mutationOutcome: 'not_applied', requestId: input.requestId };
  await h.run('timeline:mutation', 'timeline.clip.replaceSource', input, undefined, { replay: true });
  assert.equal(submissions.readPending(projectId, 'timeline:mutation'), null); assert.match(h.notices.at(-1)[0], /未进行自动裁短/);
});

test('source wiring uses the existing inline inspector, stable mutation key, session replay and no asset-only version inference', () => {
  const inspector = readFileSync(new URL('../apps/web/src/TimelineInspector.jsx', import.meta.url), 'utf8');
  assert.match(inspector, /ClipSourceReplacement context=\{\{ \.\.\.replacementContext, timeline, clipId: clip\.id, dirty \}\}/);
  assert.match(inspector, /getDirty=\{\(\) => dirtyRef\.current\}/); assert.match(inspector, /dirtyRef\.current = true/);
  assert.match(appSource, /chosenClip\.versionId === clipSource\.version\.id/);
  assert.match(appSource, /CollapsibleContent keepMounted className="inspector-region-content"/);
  assert.match(appSource, /return run\('timeline:mutation', operation/);
  const responseGuard = appSource.indexOf('!isTimelineMutationResponse(operation, input, result)'), exactClear = appSource.indexOf('clearPending(projectId, key, stored)');
  assert.ok(responseGuard >= 0 && exactClear > responseGuard, 'Validate the exact response before compare-and-clear of its retained intent');
  const component = readFileSync(new URL('../apps/web/src/ClipSourceReplacement.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(component, /\brpc\(|requestId\(|Dialog|Modal|confirm\(/);
});


test('replacement history names the explicit source edit for undo and redo', () => {
  const current = timeline();
  const entry = { id: id(98), operation: 'timeline.clip.replaceSource', createdAt: current.updatedAt };
  const history = { projectId, timelineId, revision: current.revision, cursor: 1, length: 1, canUndo: true, canRedo: false, undoEntry: entry, redoEntry: null };
  assert.equal(timelineHistoryState({ projectId, timeline: current, history }).undoLabel, '替换片段来源');
  assert.equal(timelineHistoryState({ projectId, timeline: current, history: { ...history, cursor: 0, canUndo: false, canRedo: true, undoEntry: null, redoEntry: entry } }).redoLabel, '替换片段来源');
});


test('retained acknowledgement copy is historical after later edits or undo', () => {
  const source = readFileSync(new URL('../apps/web/src/ClipSourceReplacement.jsx', import.meta.url), 'utf8');
  assert.match(source, /本次来源替换已确认。后续编辑或撤销可能改变当前片段，请以上方来源为准/);
  assert.doesNotMatch(source, /来源替换已确认，可通过时间线撤销恢复/);
});
