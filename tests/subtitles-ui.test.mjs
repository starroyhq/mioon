import { i18nTestModule, message, renderMessage, translate } from './helpers/i18n.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as subtitles from '../apps/web/src/subtitle-state.js';
import { timelineHistoryState } from '../apps/web/src/timeline-history.js';

const id = n => `95000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), cueId = id(3), secondId = id(4);
const cue = (patch = {}) => ({ id: cueId, text: '你好，世界！\nHello!', startFrame: 0, durationFrames: 30, ...patch });
const timeline = (patch = {}) => ({ id: timelineId, projectId, revision: 7, fps: 30, width: 720, height: 1280, durationFrames: 180,
  tracks: [{ id: id(5), kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false }],
  clips: [{ id: id(6), assetId: id(7), trackId: id(5), name: 'Media', startFrame: 0, durationFrames: 180, sourceInFrame: 0, gain: 1, rect: { x: 0, y: 0, width: 720, height: 1280 } }],
  subtitles: { profileId: 'bottom_cjk_v1', cues: [cue(), cue({ id: secondId, text: '第二条', startFrame: 60 })] },
  createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', ...patch });
const context = (patch = {}) => ({ scope: `${projectId}:1`, projectId, timeline: timeline(), connected: true, pending: false, ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function applied(intent, original = timeline()) {
  const saved = structuredClone(original), input = intent.input;
  saved.revision = input.expectedRevision + 1;
  if (intent.operation.endsWith('.add')) saved.subtitles.cues.push({ id: id(9), text: input.text, startFrame: input.startFrame, durationFrames: input.durationFrames });
  else if (intent.operation.endsWith('.update')) Object.assign(saved.subtitles.cues.find(cue => cue.id === input.cueId), input.patch);
  else saved.subtitles.cues = saved.subtitles.cues.filter(cue => cue.id !== input.cueId);
  return saved;
}
function fixture({ ctx = context(), submit } = {}) {
  let live = ctx, request = 0;
  const intents = [], changes = [];
  const controller = subtitles.createSubtitleController({ getContext: () => live, createRequestId: () => `subtitle-request-${++request}`, onChange: state => changes.push(state),
    submit: async intent => { intents.push(intent); return submit ? submit(intent) : { status: 'applied', timeline: applied(intent, live.timeline) }; } });
  controller.setContext(live); controller.setVisible(true);
  return { controller, intents, changes, set(patch) { live = { ...live, ...patch }; controller.setContext(live); }, get context() { return live; }, get requests() { return request; } };
}
const taskFor = (intent, status = 'applied', patch = {}) => ({ operation: intent.operation, projectId: intent.projectId, requestId: intent.input.requestId, input: structuredClone(intent.input), status, ...patch });

test('new cue chooses exact integer frame and bounded duration, then sends literal text without IDs or style fields', async () => {
  const h = fixture(); assert.equal(h.controller.begin(120), true);
  h.controller.edit('text', '  中文，标点！\n{a}:\\path%');
  assert.equal(subtitles.subtitleDraftIssue(h.controller.getState()), '');
  const saved = await h.controller.save();
  assert.ok(saved); assert.deepEqual(h.intents[0].input, { projectId, expectedRevision: 7, requestId: 'subtitle-request-1', text: '  中文，标点！\n{a}:\\path%', startFrame: 120, durationFrames: 60 });
  assert.equal(Object.isFrozen(h.intents[0].input), true); assert.equal(h.controller.getState().cueId, id(9)); assert.equal(h.controller.getState().dirty, false);
});

test('shared validation rejects fractional, blank, out-of-media, overlap, long lines, extra lines and unsupported glyphs without editing text', () => {
  const h = fixture(); h.controller.select(cueId);
  for (const [key, value] of [['startFrame', '.5'], ['startFrame', ''], ['durationFrames', 181], ['durationFrames', 61], ['text', 'a'.repeat(21)], ['text', 'a\nb\nc'], ['text', '测试🙂'], ['text', 'a\tb']]) {
    h.controller.discardDraft(); h.controller.edit(key, value);
    assert.ok(subtitles.subtitleDraftIssue(h.controller.getState()), `${key}: ${value}`); assert.equal(h.controller.getState().draft[key], value); assert.equal(subtitles.subtitleCanSave(h.controller.getState()), false);
  }
  h.controller.discardDraft(); h.controller.edit('text', 'ok\n测🙂'); assert.match(subtitles.subtitleDraftIssue(h.controller.getState()), /第2行第2个字符.*U\+1F642/);
  h.controller.discardDraft(); h.controller.edit('text', '中文标点，。！？\nASCII 123'); assert.equal(subtitles.subtitleDraftIssue(h.controller.getState()), '');
  assert.ok(subtitles.subtitleAddReason(timeline(), 180)); assert.ok(subtitles.subtitleAddReason(timeline(), 1.2)); assert.ok(subtitles.subtitleAddReason(timeline({ durationFrames: 0 }), 0));
  assert.ok(subtitles.subtitleAddReason(timeline({ subtitles: { profileId: 'bottom_cjk_v1', cues: Array.from({ length: 100 }, (_, i) => cue({ id: id(100 + i) })) } }), 0));
});

test('selection and explicit discard preserve existing saved text and reject a retained selection callback', () => {
  const h = fixture(); h.controller.select(cueId); const first = h.controller.getState();
  h.controller.edit('text', 'draft'); assert.equal(h.controller.select(secondId), false); assert.equal(h.controller.getState().cueId, cueId);
  h.controller.discardDraft(); assert.equal(h.controller.getState().draft.text, cue().text); assert.equal(h.controller.select(secondId), true);
  h.controller.edit('text', 'stale', first); assert.equal(h.controller.getState().draft.text, '第二条');
});

test('edits during a fresh ACK survive with the acknowledged CAS revision', async () => {
  const hold = deferred(), h = fixture({ submit: () => hold.promise });
  h.controller.select(cueId); h.controller.edit('text', 'submitted'); const saving = h.controller.save();
  h.controller.edit('text', 'newer'); hold.resolve({ status: 'applied', timeline: applied(h.intents[0]) }); await saving;
  assert.equal(h.controller.getState().draft.text, 'newer'); assert.equal(h.controller.getState().dirty, true); assert.equal(h.controller.getState().baseRevision, 8);
  assert.equal(h.intents[0].input.patch.text, 'submitted'); assert.equal(Object.isFrozen(h.intents[0].input.patch), true);
});

test('late ACK cannot downgrade a newer timeline or touch a different project', async () => {
  for (const projectChanged of [false, true]) {
    const hold = deferred(), h = fixture({ submit: () => hold.promise }); h.controller.select(cueId); h.controller.edit('text', 'submitted'); const saving = h.controller.save();
    if (projectChanged) h.set({ scope: 'new-project:2', projectId: id(20), timeline: timeline({ projectId: id(20), revision: 1 }) });
    else { h.set({ timeline: timeline({ revision: 10 }) }); h.controller.edit('text', 'newer'); }
    const before = h.controller.getState(); hold.resolve({ status: 'applied', timeline: applied(h.intents[0]) }); await saving;
    assert.equal(h.controller.getState().timeline.revision, before.timeline.revision);
    assert.equal(h.controller.getState().draft?.text, before.draft?.text);
    assert.equal(h.controller.getState().projectId, before.projectId);
  }
});

test('unknown response freezes original identity; exact recovery preserves newer draft and never retries', async () => {
  const h = fixture({ submit: async () => ({ status: 'unknown' }) }); h.controller.select(cueId); h.controller.edit('text', 'original'); await h.controller.save();
  const intent = h.intents[0]; h.controller.edit('text', 'later'); await h.controller.save();
  assert.equal(h.requests, 1); assert.equal(h.intents.length, 1); assert.equal(h.controller.getState().uncertain.input.patch.text, 'original');
  h.controller.recovered(taskFor(intent, 'applied', { input: { ...intent.input, patch: { text: 'different' } } })); assert.ok(h.controller.getState().uncertain);
  h.set({ timeline: applied(intent) }); h.controller.recovered(taskFor(intent));
  assert.equal(h.controller.getState().uncertain, null); assert.equal(h.controller.getState().draft.text, 'later'); assert.equal(h.controller.getState().conflict, true);
  h.controller.discardDraft(); assert.equal(h.controller.getState().draft.text, 'original'); assert.equal(h.controller.getState().dirty, false);
});

test('unknown add recovered after explicit discard stays closed and never recreates the original draft', async () => {
  const h = fixture({ submit: async () => ({ status: 'unknown' }) }); h.controller.begin(120); h.controller.edit('text', 'new'); await h.controller.save();
  const intent = h.intents[0]; h.controller.discardDraft(); h.set({ timeline: applied(intent) }); h.controller.recovered(taskFor(intent));
  assert.equal(h.controller.getState().draft, null); assert.equal(h.controller.getState().uncertain, null); assert.equal(h.intents.length, 1);
  assert.equal(h.controller.select(id(9)), true); assert.equal(h.controller.getState().draft.text, 'new');
});

test('historical recovery and pending remount cannot supply a fresh ACK or create a second identity', async () => {
  const h = fixture(); h.controller.select(cueId); h.controller.edit('text', 'current');
  h.controller.recovered({ operation: 'timeline.subtitle.update', projectId, requestId: 'old-request', input: { projectId, requestId: 'old-request', expectedRevision: 2, cueId, patch: { text: 'historical' } }, status: 'applied' });
  assert.equal(h.controller.getState().draft.text, 'current'); assert.equal(h.controller.getState().dirty, true);
  const remounted = fixture({ ctx: context({ pending: true }) }); remounted.controller.select(cueId); remounted.controller.edit('text', 'next'); await remounted.controller.save();
  assert.equal(remounted.requests, 0); assert.equal(remounted.controller.begin(120), false);
  remounted.set({ pending: false }); await remounted.controller.save(); assert.equal(remounted.requests, 1);
});

test('hidden and disposed controllers cannot submit, but a remounted dock keeps the same draft', async () => {
  const h = fixture(); h.controller.select(cueId); h.controller.edit('text', 'retained'); const old = h.controller.getState();
  h.controller.setVisible(false); h.controller.edit('text', 'hidden', old); await h.controller.save(old); assert.equal(h.intents.length, 0); assert.equal(h.controller.getState().draft.text, 'retained');
  h.controller.setVisible(true); assert.equal(h.controller.getState().draft.text, 'retained');
  h.controller.dispose(); await h.controller.save(old); assert.equal(h.intents.length, 0);
  h.controller.activate(); h.controller.setContext(context()); h.controller.setVisible(true); h.controller.select(secondId); h.controller.edit('text', 'stale', old); assert.equal(h.controller.getState().draft.text, '第二条');
});

test('malformed fresh ACK remains unknown and removal requires clean saved selection', async () => {
  const h = fixture({ submit: intent => ({ status: 'applied', timeline: { ...applied(intent), revision: 77 } }) }); h.controller.select(cueId); h.controller.edit('text', 'keep');
  await h.controller.remove(); assert.equal(h.requests, 0); await h.controller.save(); assert.ok(h.controller.getState().uncertain); assert.equal(h.controller.getState().draft.text, 'keep');
  const clean = fixture(); clean.controller.select(cueId); const saved = await clean.controller.remove();
  assert.equal(clean.intents[0].operation, 'timeline.subtitle.remove'); assert.deepEqual(clean.intents[0].input, { projectId, expectedRevision: 7, requestId: 'subtitle-request-1', cueId });
  assert.ok(!saved.subtitles.cues.some(cue => cue.id === cueId)); assert.equal(clean.controller.getState().draft, null);
});

test('undo/redo snapshots refresh a clean selection, preserve dirty edits, and expose subtitle labels', () => {
  const h = fixture(); h.controller.select(cueId);
  const undo = timeline({ revision: 8, subtitles: { profileId: 'bottom_cjk_v1', cues: [cue({ text: 'before' })] } }); h.set({ timeline: undo }); assert.equal(h.controller.getState().draft.text, 'before');
  h.controller.edit('text', 'keep draft'); h.set({ timeline: timeline({ revision: 9 }) }); assert.equal(h.controller.getState().draft.text, 'keep draft'); assert.equal(h.controller.getState().conflict, true);
  const history = { projectId, timelineId, revision: 9, cursor: 1, length: 2, canUndo: true, canRedo: true, undoEntry: { id: id(41), operation: 'timeline.subtitle.add' }, redoEntry: { id: id(42), operation: 'timeline.subtitle.remove' } };
  const state = timelineHistoryState({ projectId, timeline: timeline({ revision: 9 }), history, dirty: true }); assert.equal(state.canUndo, false); assert.equal(state.canRedo, false); assert.equal(state.undoLabel, '新增字幕'); assert.equal(state.redoLabel, '移除字幕');
  h.controller.discardDraft(); assert.equal(h.controller.getState().draft.text, cue().text);
});

function componentHarness(filename, imports = {}) {
  let slots = [], cursor = 0, visible = true, props, tree, confirm = async () => true;
  const hooks = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useRef: value => { const i = cursor++; return slots[i] ||= { current: value }; }, useLayoutEffect: (fn, deps) => { const i = cursor++, prior = slots[i]; if (!prior || deps.some((value, n) => value !== prior.deps[n])) { prior?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; } } };
  const source = readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8'), module = { exports: {} };
  const require = name => name === './i18n/I18nProvider.tsx' ? i18nTestModule() : name.endsWith('packages/i18n/src/index.ts') ? i18n : name === 'react' ? { ...hooks, default: hooks } : name.endsWith('workbench-confirm') ? { useConfirmation: () => (...args) => confirm(...args) } : name.endsWith('workspace-visibility.jsx') ? { useWorkspaceVisibility: () => visible } : name.endsWith('subtitle-state.js') ? subtitles : name.endsWith('.css') ? {} : imports[name] || new Proxy({}, { get: (_, key) => String(key) });
  Function('require', 'module', 'exports', transformSync(source, { loader: 'jsx', format: 'cjs' }).code)(require, module, module.exports);
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  return { render(next = props) { props = next; cursor = 0; tree = module.exports.default(props); return tree; }, find: testId => nodes(tree).find(node => node.props?.['data-testid'] === testId), nodes: () => nodes(tree),
    visible(value) { visible = value; }, confirm(fn) { confirm = fn; }, unmount() { slots.forEach(slot => slot.cleanup?.()); slots = []; }, source };
}

test('actual Inspector input/save/discard handlers preserve literal text, reachable footer and stale render status', async () => {
  const h = fixture(), ui = componentHarness('SubtitleInspector.jsx'); h.controller.select(cueId);
  const props = () => ({ state: h.controller.getState(), controller: h.controller, renderJob: { timelineRevision: 6 }, onBack() {}, onOpenTasks() {} });
  ui.render(props()); ui.find('subtitle-text').props.onChange({ target: { value: '原样 {a}%\\\nEnglish' } }); ui.render(props());
  assert.equal(ui.find('subtitle-save').props.disabled, false); await ui.find('subtitle-save').props.onClick(); assert.equal(h.intents[0].input.patch.text, '原样 {a}%\\\nEnglish');
  ui.render(props()); ui.find('subtitle-text').props.onChange({ target: { value: 'discard me' } }); ui.render(props()); ui.find('subtitle-discard').props.onClick();
  assert.equal(h.controller.getState().draft.text, '原样 {a}%\\\nEnglish'); assert.ok(ui.find('subtitle-render-status').props.children.join('').includes('旧快照'));
  const footer = ui.nodes().find(node => node.type === 'footer'); assert.ok(footer); assert.ok(footer.props.children.flat().some(node => node.props?.['data-testid'] === 'subtitle-save'));
  assert.ok(ui.source.includes('subtitles.ui.renderNote')); assert.ok(translate('zh-Hans', 'subtitles.ui.renderNote').includes('不是最终画面预览')); assert.ok(!ui.source.includes('maxLength='));
});

test('actual Inspector retained handlers reject hidden, changed selection, unmount, and late remove confirmation', async () => {
  const h = fixture(), ui = componentHarness('SubtitleInspector.jsx'); h.controller.select(cueId);
  const props = () => ({ state: h.controller.getState(), controller: h.controller, onBack() {}, onOpenTasks() {} });
  ui.render(props()); const edit = ui.find('subtitle-text').props.onChange; h.controller.select(secondId); ui.render(props()); edit({ target: { value: 'wrong' } }); assert.equal(h.controller.getState().draft.text, '第二条');
  const second = ui.find('subtitle-text').props.onChange; ui.visible(false); ui.render(props()); second({ target: { value: 'hidden' } }); assert.equal(h.controller.getState().draft.text, '第二条');
  ui.visible(true); ui.render(props()); const hold = deferred(); ui.confirm(() => hold.promise); const removal = ui.find('subtitle-remove').props.onClick(); h.controller.edit('text', 'new edit'); hold.resolve(true); await removal; assert.equal(h.intents.length, 0);
  ui.render(props()); const retained = ui.find('subtitle-save').props.onClick; ui.unmount(); await retained(); assert.equal(h.intents.length, 0);
});

test('actual lane buttons select and add once, reject hidden/unmounted and superseded timeline handlers', () => {
  const ui = componentHarness('SubtitleLane.jsx'), calls = [], saved = timeline();
  const props = { timeline: saved, pixelsPerFrame: 2, pixelsPerSecond: 60, width: 780, playhead: 120, visible: true, onSelect: cueId => calls.push(['select', cueId]), onAdd: frame => calls.push(['add', frame]), onSeek: frame => calls.push(['seek', frame]) };
  ui.render(props); ui.find('subtitle-add').props.onClick(); ui.find(`subtitle-cue-${cueId}`).props.onClick({ stopPropagation() {} }); assert.deepEqual(calls, [['add', 120], ['select', cueId]]);
  calls.length = 0; const old = ui.find('subtitle-add').props.onClick; ui.render({ ...props, timeline: timeline({ revision: 8 }) }); old(); assert.deepEqual(calls, []);
  const current = ui.find('subtitle-add').props.onClick; ui.render({ ...props, visible: false }); current(); assert.deepEqual(calls, []);
  ui.render(props); const last = ui.find('subtitle-add').props.onClick; ui.unmount(); last(); assert.deepEqual(calls, []);
});

const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
const compile = (source, name, scope) => { const env = { msg: message, ...scope }; return Function(...Object.keys(env), `${source}; return ${name};`)(...Object.values(env)); };

test('actual App subtitle selection keeps other Properties/Agent drafts and requires explicit subtitle discard', async () => {
  const h = fixture(), updates = [], untouched = { clip: 'clip draft', source: 'source draft', format: 'format draft', agent: 'agent draft' };
  let approved = false, current = true;
  const scope = { context: () => ({ projectId, epoch: 1 }), panelIntent: { current: 1 }, subtitlesRef: { current: { controller: h.controller } }, viewRef: { current: { activeMode: 'editing', editing: { playhead: 120 } } }, loading: false,
    confirm: async () => approved, isCurrent: () => current, notify: () => {}, openTasks: () => {}, setPropertiesPage: value => updates.push(['page', value]), setRightDockTab: value => updates.push(['tab', value]), setPanelOpen: (...args) => updates.push(['panel', ...args]) };
  const open = compile(section('  async function openSubtitle(', '  function clipReplacementContext('), 'openSubtitle', scope);
  await open(cueId); assert.equal(h.controller.getState().cueId, cueId); h.controller.edit('text', 'subtitle draft'); updates.length = 0;
  await open(secondId); assert.equal(h.controller.getState().draft.text, 'subtitle draft'); assert.deepEqual(updates, []);
  approved = true; await open(secondId); assert.equal(h.controller.getState().cueId, secondId); assert.deepEqual(untouched, { clip: 'clip draft', source: 'source draft', format: 'format draft', agent: 'agent draft' });
  h.controller.edit('text', 'keep'); current = false; await open(cueId); assert.equal(h.controller.getState().draft.text, 'keep');
});

test('actual App selection confirmation rejects later edits and panel intent instead of reopening a hidden pane', async () => {
  for (const change of ['draft', 'panel']) {
    const h = fixture(), hold = deferred(), updates = []; h.controller.select(cueId); h.controller.edit('text', 'old');
    const panelIntent = { current: 1 }, scope = { context: () => ({ projectId }), panelIntent, subtitlesRef: { current: { controller: h.controller } }, viewRef: { current: { activeMode: 'editing', editing: { playhead: 120 } } }, loading: false, confirm: () => hold.promise, isCurrent: () => true, notify() {}, openTasks() {}, setPropertiesPage: value => updates.push(value), setRightDockTab() {}, setPanelOpen() {} };
    const open = compile(section('  async function openSubtitle(', '  function clipReplacementContext('), 'openSubtitle', scope), selecting = open(secondId);
    if (change === 'draft') h.controller.edit('text', 'new'); else panelIntent.current++;
    hold.resolve(true); await selecting; assert.equal(h.controller.getState().cueId, cueId); assert.deepEqual(updates, []);
  }
});

test('actual App subtitle bridge passes exact durable identity and rechecks visible ownership before dispatch', async () => {
  const h = fixture(); h.controller.select(cueId); h.controller.edit('text', 'submitted'); await h.controller.save(); const intent = h.intents[0], calls = [];
  let live = { ...context(), visible: true }, allowed;
  const scope = { subtitleContext: () => live, isDurableEditOperation: operation => operation.startsWith('timeline.subtitle.'), subtitleAcknowledged: subtitles.subtitleAcknowledged, subtitlesRef: { current: { controller: { getState: () => ({ selection: intent.selection }), isVisible: () => live.visible } } }, tasksRef: { current: { blocked: () => false } },
    runDurable: async (lane, operation, input, message, options) => { calls.push({ lane, operation, input }); live = { ...live, visible: false }; allowed = options.canExecute(); const saved = applied(intent); options.validateResponse(saved); return saved; } };
  const save = compile(section('  async function saveSubtitle(', '  const subtitles = useSubtitles('), 'saveSubtitle', scope);
  const response = await save(intent); assert.equal(response.status, 'applied'); assert.equal(calls[0].input, intent.input); assert.equal(allowed, false);
  assert.equal((await save(intent)).status, 'rejected'); assert.equal(calls.length, 1);
});

test('actual App history handler blocks a dirty subtitle and calls the shared undo/redo route when clean', async () => {
  const saved = timeline(), history = { projectId, timelineId, revision: 7, cursor: 1, length: 2, canUndo: true, canRedo: true, undoEntry: { id: id(41), operation: 'timeline.subtitle.add' }, redoEntry: { id: id(42), operation: 'timeline.subtitle.remove' } };
  for (const dirty of [true, false]) {
    const calls = [], scope = { workspaceMode: 'editing', currentProject: { current: projectId }, dataRef: { current: { project: { id: projectId }, timeline: saved, timelineHistory: history } }, timelineHistoryState, isBusy: () => false, timelinePending: false, clipDirty: false, subtitleDirty: dirty, online: true, auth: true, loading: false, mutateTimeline: operation => calls.push(operation) };
    const run = compile(section('  function changeTimelineHistory(', '  useEffect(() => {\n    const onKeyDown'), 'changeTimelineHistory', scope);
    run('undo'); run('redo'); assert.deepEqual(calls, dirty ? [] : ['timeline.undo', 'timeline.redo']);
  }
});

function navigationGuard(h, confirm, resets) {
  const scope = { nativeWindow: null, shotTextRef: { current: null }, clipDraftRef: { current: null }, context: () => ({ projectId }), isCurrent: () => true, subtitlesRef: { current: { controller: h.controller } }, dirtyRef: { current: false }, confirm,
    subjectsRef: { current: null }, ...Object.fromEntries(['setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch'].map(name => [name, value => resets.push([name, value])])) };
  return compile(section('  async function guardNavigation(', '  async function guardProjectNavigation('), 'guardNavigation', scope);
}
test('actual App navigation consults same-tick subtitle state before React dirty rerender', async () => {
  const h = fixture(), resets = [], prompts = []; h.controller.select(cueId); h.controller.edit('text', 'same-tick');
  let approved = false;
  const guard = navigationGuard(h, async message => { prompts.push(message); return approved; }, resets);
  assert.equal(await guard(), false); assert.equal(prompts.length, 1); assert.equal(h.controller.getState().draft.text, 'same-tick'); assert.deepEqual(resets, []);
  approved = true; assert.equal(await guard(), true); assert.equal(h.controller.getState().dirty, false); assert.equal(h.controller.getState().draft.text, cue().text);
  assert.ok(resets.some(([name, value]) => name === 'setSubtitleDirty' && value === false));
});

test('actual App late navigation confirmation cannot discard a newer subtitle draft in the same project', async () => {
  const h = fixture(), hold = deferred(), resets = []; h.controller.select(cueId); h.controller.edit('text', 'before dialog');
  const guard = navigationGuard(h, () => hold.promise, resets), navigating = guard();
  h.controller.edit('text', 'newer input'); hold.resolve(true); assert.equal(await navigating, false);
  assert.equal(h.controller.getState().draft.text, 'newer input'); assert.equal(h.controller.getState().dirty, true); assert.deepEqual(resets, []);
});
