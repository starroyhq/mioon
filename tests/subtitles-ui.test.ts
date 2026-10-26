import type {RootModule,RootControlledModules} from './helpers/strict-root-ui-types.ts';
type SubtitleProps = {state?:subtitles.SubtitleState;controller?:ReturnType<typeof subtitles.createSubtitleController>;renderJob?:{timelineRevision:number};onBack?:()=>void;onOpenTasks?:()=>void;timeline?:unknown;pixelsPerFrame?:number;pixelsPerSecond?:number;width?:number;playhead?:number;visible?:boolean;onSelect?:(cueId:unknown)=>unknown;onAdd?:(frame:unknown)=>unknown;onSeek?:(frame:unknown)=>unknown};
import type {RootHook} from './helpers/strict-root-ui-types.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import { i18nTestModule, message, renderMessage, translate } from './helpers/i18n.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as subtitles from '../apps/web/src/subtitle-state.ts';
import { timelineHistoryState } from '../apps/web/src/timeline-history.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const id = (n: number) => `95000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), cueId = id(3), secondId = id(4);
const cue = (patch: { id?: string; text?: string; startFrame?: number; }|undefined = {}) => ({ id: cueId, text: '你好，世界！\nHello!', startFrame: 0, durationFrames: 30, ...patch });
const timeline = (patch: { durationFrames?: number; subtitles?: { profileId: string; cues: ReturnType<typeof cue>[]; }|{ profileId: string; cues: ReturnType<typeof cue>[]; }; projectId?: string; revision?: number; }|undefined = {}) => ({ id: timelineId, projectId, revision: 7, fps: 30, width: 720, height: 1280, durationFrames: 180,
  tracks: [{ id: id(5), kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false }],
  clips: [{ id: id(6), assetId: id(7), trackId: id(5), name: 'Media', startFrame: 0, durationFrames: 180, sourceInFrame: 0, gain: 1, rect: { x: 0, y: 0, width: 720, height: 1280 } }],
  subtitles: { profileId: 'bottom_cjk_v1', cues: [cue(), cue({ id: secondId, text: '第二条', startFrame: 60 })] },
  createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', ...patch });
const context = (patch: { pending?: boolean; }|undefined = {}) => ({ scope: `${projectId}:1`, projectId, timeline: timeline(), connected: true, pending: false, ...patch });
const deferred = () => { let resolve!:(value?:unknown)=>void, reject!:(reason?:unknown)=>void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function applied(intent: subtitles.SubtitleIntent, original: ReturnType<typeof timeline> = timeline()) {
  const saved = structuredClone(original), input = intent.input;
  saved.revision = (input.expectedRevision)! + 1;
  if (intent.operation.endsWith('.add')) saved.subtitles.cues.push({ id: id(9), text: input.text as string, startFrame: input.startFrame!, durationFrames: input.durationFrames! });
  else if (intent.operation.endsWith('.update')) Object.assign(saved.subtitles.cues.find((cue) => cue.id === input.cueId)!, input.patch);
  else saved.subtitles.cues = saved.subtitles.cues.filter((cue) => cue.id !== input.cueId);
  return saved;
}
function fixture({ ctx = context(), submit }: {ctx?:ReturnType<typeof context>;submit?:(intent:subtitles.SubtitleIntent)=>Promise<unknown>} = {}) {
  let live = ctx, request = 0;
  const intents: subtitles.SubtitleIntent[] = [], changes: subtitles.SubtitleState[] = [];
  const controller = subtitles.createSubtitleController((({ getContext: () => live, createRequestId: () => `subtitle-request-${++request}`, onChange: (state:subtitles.SubtitleState) => changes.push(state),
    submit: async (intent:subtitles.SubtitleIntent) => { intents.push(intent); return submit ? submit(intent) : { status: 'applied', timeline: applied(intent, live.timeline) }; } }) as unknown as Parameters<typeof subtitles.createSubtitleController>[0]));
  controller.setContext(((live) as unknown as Parameters<typeof controller.setContext>[0])); controller.setVisible(true);
  return { controller, intents, changes, set(patch: { scope?: string; projectId?: string; timeline?: { id: string; projectId: string; revision: number; fps: number; width: number; height: number; durationFrames: number; tracks: { id: string; kind: string; name: string; orderIndex: number; hidden: boolean; muted: boolean; }[]; clips: { id: string; assetId: string; trackId: string; name: string; startFrame: number; durationFrames: number; sourceInFrame: number; gain: number; rect: { x: number; y: number; width: number; height: number; }; }[]; subtitles: { profileId: string; cues: { id: string; text: string; startFrame: number; durationFrames: number; }[]; }; createdAt: string; updatedAt: string; }; pending?: boolean; connected?: boolean; }) { live = { ...live, ...patch }; controller.setContext(((live) as unknown as Parameters<typeof controller.setContext>[0])); }, get context() { return live; }, get requests() { return request; } };
}
const taskFor = (intent: subtitles.SubtitleIntent, status: string|undefined = 'applied', patch: { input?: { patch: { text: string; }; projectId: string|null; expectedRevision: number|null; requestId: string; cueId?: string|null; text?: unknown; startFrame?: number; durationFrames?: number; }; }|undefined = {}) => ({ operation: intent.operation, projectId: intent.projectId, requestId: intent.input.requestId, input: structuredClone(intent.input), status, ...patch });

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
    h.controller.discardDraft(); h.controller.edit(((key) as unknown as Parameters<typeof h.controller.edit>[0]), value);
    assert.ok(subtitles.subtitleDraftIssue(h.controller.getState()), `${key}: ${value}`); assert.equal((h.controller.getState().draft)![key as keyof subtitles.SubtitleDraft], value); assert.equal(subtitles.subtitleCanSave(h.controller.getState()), false);
  }
  h.controller.discardDraft(); h.controller.edit('text', 'ok\n测🙂'); assert.match(subtitles.subtitleDraftIssue(h.controller.getState()), /第2行第2个字符.*U\+1F642/);
  h.controller.discardDraft(); h.controller.edit('text', '中文标点，。！？\nASCII 123'); assert.equal(subtitles.subtitleDraftIssue(h.controller.getState()), '');
  assert.ok(subtitles.subtitleAddReason(((timeline()) as unknown as Parameters<typeof subtitles.subtitleAddReason>[0]), 180)); assert.ok(subtitles.subtitleAddReason(((timeline()) as unknown as Parameters<typeof subtitles.subtitleAddReason>[0]), 1.2)); assert.ok(subtitles.subtitleAddReason(((timeline({ durationFrames: 0 })) as unknown as Parameters<typeof subtitles.subtitleAddReason>[0]), 0));
  assert.ok(subtitles.subtitleAddReason(((timeline({ subtitles: { profileId: 'bottom_cjk_v1', cues: Array.from({ length: 100 }, (_, i) => cue({ id: id(100 + i) })) } })) as unknown as Parameters<typeof subtitles.subtitleAddReason>[0]), 0));
});

test('selection and explicit discard preserve existing saved text and reject a retained selection callback', () => {
  const h = fixture(); h.controller.select(cueId); const first = h.controller.getState();
  h.controller.edit('text', 'draft'); assert.equal(h.controller.select(secondId), false); assert.equal(h.controller.getState().cueId, cueId);
  h.controller.discardDraft(); assert.equal((h.controller.getState().draft)!.text, cue().text); assert.equal(h.controller.select(secondId), true);
  h.controller.edit('text', 'stale', first); assert.equal((h.controller.getState().draft)!.text, '第二条');
});

test('edits during a fresh ACK survive with the acknowledged CAS revision', async () => {
  const hold = deferred(), h = fixture({ submit: () => hold.promise });
  h.controller.select(cueId); h.controller.edit('text', 'submitted'); const saving = h.controller.save();
  h.controller.edit('text', 'newer'); (hold.resolve)!({ status: 'applied', timeline: applied(h.intents[0]) }); await saving;
  assert.equal((h.controller.getState().draft)!.text, 'newer'); assert.equal(h.controller.getState().dirty, true); assert.equal(h.controller.getState().baseRevision, 8);
  assert.equal((h.intents[0].input.patch)!.text, 'submitted'); assert.equal(Object.isFrozen(h.intents[0].input.patch), true);
});

test('late ACK cannot downgrade a newer timeline or touch a different project', async () => {
  for (const projectChanged of [false, true]) {
    const hold = deferred(), h = fixture({ submit: () => hold.promise }); h.controller.select(cueId); h.controller.edit('text', 'submitted'); const saving = h.controller.save();
    if (projectChanged) h.set((({ scope: 'new-project:2', projectId: id(20), timeline: timeline({ projectId: id(20), revision: 1 }) }) as unknown as Parameters<typeof h.set>[0]));
    else { h.set((({ timeline: timeline({ revision: 10 }) }) as unknown as Parameters<typeof h.set>[0])); h.controller.edit('text', 'newer'); }
    const before = h.controller.getState(); (hold.resolve)!({ status: 'applied', timeline: applied(h.intents[0]) }); await saving;
    assert.equal((h.controller.getState().timeline)!.revision, (before.timeline)!.revision);
    assert.equal(h.controller.getState().draft?.text, before.draft?.text);
    assert.equal(h.controller.getState().projectId, before.projectId);
  }
});

test('unknown response freezes original identity; exact recovery preserves newer draft and never retries', async () => {
  const h = fixture({ submit: async () => ({ status: 'unknown' }) }); h.controller.select(cueId); h.controller.edit('text', 'original'); await h.controller.save();
  const intent = h.intents[0]; h.controller.edit('text', 'later'); await h.controller.save();
  assert.equal(h.requests, 1); assert.equal(h.intents.length, 1); assert.equal(((h.controller.getState().uncertain)!.input.patch)!.text, 'original');
  h.controller.recovered(taskFor(intent, 'applied', { input: { ...intent.input, patch: { text: 'different' } } })); assert.ok(h.controller.getState().uncertain);
  h.set((({ timeline: applied(intent) }) as unknown as Parameters<typeof h.set>[0])); h.controller.recovered(taskFor(intent));
  assert.equal(h.controller.getState().uncertain, null); assert.equal((h.controller.getState().draft)!.text, 'later'); assert.equal(h.controller.getState().conflict, true);
  h.controller.discardDraft(); assert.equal((h.controller.getState().draft)!.text, 'original'); assert.equal(h.controller.getState().dirty, false);
});

test('unknown add recovered after explicit discard stays closed and never recreates the original draft', async () => {
  const h = fixture({ submit: async () => ({ status: 'unknown' }) }); h.controller.begin(120); h.controller.edit('text', 'new'); await h.controller.save();
  const intent = h.intents[0]; h.controller.discardDraft(); h.set((({ timeline: applied(intent) }) as unknown as Parameters<typeof h.set>[0])); h.controller.recovered(taskFor(intent));
  assert.equal(h.controller.getState().draft, null); assert.equal(h.controller.getState().uncertain, null); assert.equal(h.intents.length, 1);
  assert.equal(h.controller.select(id(9)), true); assert.equal((h.controller.getState().draft)!.text, 'new');
});

test('historical recovery and pending remount cannot supply a fresh ACK or create a second identity', async () => {
  const h = fixture(); h.controller.select(cueId); h.controller.edit('text', 'current');
  h.controller.recovered({ operation: 'timeline.subtitle.update', projectId, requestId: 'old-request', input: { projectId, requestId: 'old-request', expectedRevision: 2, cueId, patch: { text: 'historical' } }, status: 'applied' });
  assert.equal((h.controller.getState().draft)!.text, 'current'); assert.equal(h.controller.getState().dirty, true);
  const remounted = fixture({ ctx: context({ pending: true }) }); remounted.controller.select(cueId); remounted.controller.edit('text', 'next'); await remounted.controller.save();
  assert.equal(remounted.requests, 0); assert.equal(remounted.controller.begin(120), false);
  remounted.set({ pending: false }); await remounted.controller.save(); assert.equal(remounted.requests, 1);
});

test('hidden and disposed controllers cannot submit, but a remounted dock keeps the same draft', async () => {
  const h = fixture(); h.controller.select(cueId); h.controller.edit('text', 'retained'); const old = h.controller.getState();
  h.controller.setVisible(false); h.controller.edit('text', 'hidden', old); await h.controller.save(old); assert.equal(h.intents.length, 0); assert.equal((h.controller.getState().draft)!.text, 'retained');
  h.controller.setVisible(true); assert.equal((h.controller.getState().draft)!.text, 'retained');
  h.controller.dispose(); await h.controller.save(old); assert.equal(h.intents.length, 0);
  h.controller.activate(); h.controller.setContext(((context()) as unknown as Parameters<typeof h.controller.setContext>[0])); h.controller.setVisible(true); h.controller.select(secondId); h.controller.edit('text', 'stale', old); assert.equal((h.controller.getState().draft)!.text, '第二条');
});

test('malformed fresh ACK remains unknown and removal requires clean saved selection', async () => {
  const h = fixture((({ submit: (intent: subtitles.SubtitleIntent) => ({ status: 'applied', timeline: { ...applied(intent), revision: 77 } }) }) as unknown as Parameters<typeof fixture>[0])); h.controller.select(cueId); h.controller.edit('text', 'keep');
  await h.controller.remove(); assert.equal(h.requests, 0); await h.controller.save(); assert.ok(h.controller.getState().uncertain); assert.equal((h.controller.getState().draft)!.text, 'keep');
  const clean = fixture(); clean.controller.select(cueId); const saved = await clean.controller.remove();
  assert.equal(clean.intents[0].operation, 'timeline.subtitle.remove'); assert.deepEqual(clean.intents[0].input, { projectId, expectedRevision: 7, requestId: 'subtitle-request-1', cueId });
  assert.ok(!((saved)!.subtitles!.cues)!.some(cue => cue.id === cueId)); assert.equal(clean.controller.getState().draft, null);
});

test('undo/redo snapshots refresh a clean selection, preserve dirty edits, and expose subtitle labels', () => {
  const h = fixture(); h.controller.select(cueId);
  const undo = timeline({ revision: 8, subtitles: { profileId: 'bottom_cjk_v1', cues: [cue({ text: 'before' })] } }); h.set((({ timeline: undo }) as unknown as Parameters<typeof h.set>[0])); assert.equal((h.controller.getState().draft)!.text, 'before');
  h.controller.edit('text', 'keep draft'); h.set((({ timeline: timeline({ revision: 9 }) }) as unknown as Parameters<typeof h.set>[0])); assert.equal((h.controller.getState().draft)!.text, 'keep draft'); assert.equal(h.controller.getState().conflict, true);
  const history = { projectId, timelineId, revision: 9, cursor: 1, length: 2, canUndo: true, canRedo: true, undoEntry: { id: id(41), operation: 'timeline.subtitle.add' }, redoEntry: { id: id(42), operation: 'timeline.subtitle.remove' } };
  const state = timelineHistoryState({ projectId, timeline: timeline({ revision: 9 }), history, dirty: true }); assert.equal(state.canUndo, false); assert.equal(state.canRedo, false); assert.equal(state.undoLabel, '新增字幕'); assert.equal(state.redoLabel, '移除字幕');
  h.controller.discardDraft(); assert.equal((h.controller.getState().draft)!.text, cue().text);
});

function componentHarness<File extends 'SubtitleInspector.tsx'|'SubtitleLane.tsx'>(filename: File, imports: { [x: string]: unknown; }|undefined = {}, locale: string|undefined = 'zh-Hans') {
  let slots: RootHook[] = [], cursor = 0, visible = true, props: SubtitleProps, tree: string|number|boolean|RootNode|RootTree[]|null|undefined, confirm:(...args:unknown[])=>Promise<unknown> = async () => true;
  const hooks = { createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }), useRef: (value: unknown) => { const i = cursor++; return slots[i] ||= { current: value }; }, useLayoutEffect: (fn: () => void | (() => void), deps: readonly unknown[] | undefined) => { const i = cursor++, prior = slots[i] as RootHook|undefined; if (!prior || deps!.some((value, n) => value !== prior.deps![n])) { prior?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; } } };
  const source = readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8'), module = { exports: {} as RootModule<RootControlledModules[File]> };
  const require = (name: string) => name === './i18n/I18nProvider.tsx' ? i18nTestModule(((locale) as unknown as Parameters<typeof i18nTestModule>[0])) : name.endsWith('packages/i18n/src/index.ts') ? i18n : name === 'react' ? { ...hooks, default: hooks } : name.endsWith('workbench-confirm') ? { useConfirmation: () => (...args: unknown[]) => confirm(...args) } : name.endsWith('workspace-visibility.tsx') ? { useWorkspaceVisibility: () => visible } : name.endsWith('subtitle-state.ts') ? subtitles : name.endsWith('.css') ? {} : imports[name] || new Proxy({}, { get: (_, key) => String(key) });
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)(require, module, module.exports);
  const nodes = (value: RootTree) : RootNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  return { render(next: SubtitleProps = props) { props = next; cursor = 0; tree = (module.exports.default as RootModule<RootControlledModules['SubtitleInspector.tsx']>['default']|RootModule<RootControlledModules['SubtitleLane.tsx']>['default'])(props as unknown as Parameters<RootControlledModules['SubtitleInspector.tsx']['default']>[0]&Parameters<RootControlledModules['SubtitleLane.tsx']['default']>[0]); return tree; }, find: (testId: unknown) => nodes(tree).find(node => node.props?.['data-testid'] === testId), nodes: () => nodes(tree),
    visible(value: boolean) { visible = value; }, confirm(fn: ()=>Promise<unknown>) { confirm = fn; }, unmount() { slots.forEach(slot => slot.cleanup?.()); slots = []; }, source };
}

test('actual Inspector input/save/discard handlers preserve literal text, reachable footer and stale render status', async () => {
  const h = fixture(), ui = componentHarness('SubtitleInspector.tsx'); h.controller.select(cueId);
  const props = () => ({ state: h.controller.getState(), controller: h.controller, renderJob: { timelineRevision: 6 }, onBack() {}, onOpenTasks() {} });
  ui.render(props()); (ui.find('subtitle-text'))!.props.onChange({ target: { value: '原样 {a}%\\\nEnglish' } }); ui.render(props());
  assert.equal((ui.find('subtitle-save'))!.props.disabled, false); await (ui.find('subtitle-save'))!.props.onClick(); assert.equal((h.intents[0].input.patch)!.text, '原样 {a}%\\\nEnglish');
  ui.render(props()); (ui.find('subtitle-text'))!.props.onChange({ target: { value: 'discard me' } }); ui.render(props()); (ui.find('subtitle-discard'))!.props.onClick();
  assert.equal((h.controller.getState().draft)!.text, '原样 {a}%\\\nEnglish'); assert.ok((ui.find('subtitle-render-status'))!.props.children.join('').includes('旧快照'));
  const footer = ui.nodes().find((node) => node.type === 'footer'); assert.ok(footer); assert.ok(footer.props.children.flat().some((node) => (node as RootNode)!.props?.['data-testid'] === 'subtitle-save'));
  assert.ok(ui.source.includes('subtitles.ui.renderNote')); assert.ok(translate('zh-Hans', 'subtitles.ui.renderNote').includes('不是最终画面预览')); assert.ok(!ui.source.includes('maxLength='));
});

test('actual Inspector retained handlers reject hidden, changed selection, unmount, and late remove confirmation', async () => {
  const h = fixture(), ui = componentHarness('SubtitleInspector.tsx'); h.controller.select(cueId);
  const props = () => ({ state: h.controller.getState(), controller: h.controller, onBack() {}, onOpenTasks() {} });
  ui.render(props()); const edit = (ui.find('subtitle-text'))!.props.onChange; h.controller.select(secondId); ui.render(props()); edit({ target: { value: 'wrong' } }); assert.equal((h.controller.getState().draft)!.text, '第二条');
  const second = (ui.find('subtitle-text'))!.props.onChange; ui.visible(false); ui.render(props()); second({ target: { value: 'hidden' } }); assert.equal((h.controller.getState().draft)!.text, '第二条');
  ui.visible(true); ui.render(props()); const hold = deferred(); ui.confirm(() => hold.promise); const removal = (ui.find('subtitle-remove'))!.props.onClick(); h.controller.edit('text', 'new edit'); (hold.resolve)!(true); await removal; assert.equal(h.intents.length, 0);
  ui.render(props()); const retained = (ui.find('subtitle-save'))!.props.onClick; ui.unmount(); await retained(); assert.equal(h.intents.length, 0);
});

test('actual lane buttons select and add once, reject hidden/unmounted and superseded timeline handlers', () => {
  const ui = componentHarness('SubtitleLane.tsx'), calls: unknown[] = [], saved = timeline();
  const props = { timeline: saved, pixelsPerFrame: 2, pixelsPerSecond: 60, width: 780, playhead: 120, visible: true, onSelect: (cueId: unknown) => calls.push(['select', cueId]), onAdd: (frame: unknown) => calls.push(['add', frame]), onSeek: (frame: unknown) => calls.push(['seek', frame]) };
  ui.render(props); (ui.find('subtitle-add'))!.props.onClick(); (ui.find(`subtitle-cue-${cueId}`))!.props.onClick({ stopPropagation() {} }); assert.deepEqual(calls, [['add', 120], ['select', cueId]]);
  calls.length = 0; const old = (ui.find('subtitle-add'))!.props.onClick; ui.render({ ...props, timeline: timeline({ revision: 8 }) }); old(); assert.deepEqual((calls as unknown), []);
  const current = (ui.find('subtitle-add'))!.props.onClick; ui.render({ ...props, visible: false }); current(); assert.deepEqual((calls as unknown), []);
  ui.render(props); const last = (ui.find('subtitle-add'))!.props.onClick; ui.unmount(); last(); assert.deepEqual((calls as unknown), []);
});

test('English subtitle track uses a short visible name with full count and add action labels', () => {
  const ui = componentHarness('SubtitleLane.tsx', {}, 'en');
  ui.render({timeline: timeline(), pixelsPerFrame: 2, pixelsPerSecond: 60, width: 780, playhead: 120, visible: true, onSelect() {}, onAdd() {}, onSeek() {}});
  const name = ui.nodes().find((node) => node.type === 'strong');
  assert.deepEqual((name)!.props.children, ['Subtitles']);
  assert.equal((name)!.props.title, 'Manual subtitles · 2/100');
  assert.equal((ui.find('subtitle-add'))!.props['aria-label'], 'Add at playhead');
  assert.equal(((ui.find('subtitle-add'))!.props.children[0] as RootNode)!.props.name, 'plus');
  ui.unmount();
});

const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const section = (start: string, end: string) => app.slice(app.indexOf(start), app.indexOf(end));
const compile = (source: string, name: string, scope:Record<string,unknown>) => { const env = { msg: message, ...scope }; return Function(...Object.keys(env), `${source}; return ${name};`)(...Object.values(env)) as (...args:unknown[])=>Promise<{status:string}>; };

test('actual App subtitle selection keeps other Properties/Agent drafts and requires explicit subtitle discard', async () => {
  const h = fixture(), updates: unknown[] = [], untouched = { clip: 'clip draft', source: 'source draft', format: 'format draft', agent: 'agent draft' };
  let approved = false, current = true;
  const scope = { context: () => ({ projectId, epoch: 1 }), panelIntent: { current: 1 }, subtitlesRef: { current: { controller: h.controller } }, viewRef: { current: { activeMode: 'editing', editing: { playhead: 120 } } }, loading: false,
    confirm: async () => approved, isCurrent: () => current, notify: () => {}, openTasks: () => {}, setPropertiesPage: (value: unknown) => updates.push(['page', value]), setRightDockTab: (value: unknown) => updates.push(['tab', value]), setPanelOpen: (...args: unknown[]) => updates.push(['panel', ...args]) };
  const open = compile(section('  async function openSubtitle(', '  function clipReplacementContext('), 'openSubtitle', scope);
  await open(cueId); assert.equal(h.controller.getState().cueId, cueId); h.controller.edit('text', 'subtitle draft'); updates.length = 0;
  await open(secondId); assert.equal((h.controller.getState().draft)!.text, 'subtitle draft'); assert.deepEqual((updates as unknown), []);
  approved = true; await open(secondId); assert.equal(h.controller.getState().cueId, secondId); assert.deepEqual(untouched, { clip: 'clip draft', source: 'source draft', format: 'format draft', agent: 'agent draft' });
  h.controller.edit('text', 'keep'); current = false; await open(cueId); assert.equal((h.controller.getState().draft)!.text, 'keep');
});

test('actual App selection confirmation rejects later edits and panel intent instead of reopening a hidden pane', async () => {
  for (const change of ['draft', 'panel']) {
    const h = fixture(), hold = deferred(), updates: unknown[] = []; h.controller.select(cueId); h.controller.edit('text', 'old');
    const panelIntent = { current: 1 }, scope = { context: () => ({ projectId }), panelIntent, subtitlesRef: { current: { controller: h.controller } }, viewRef: { current: { activeMode: 'editing', editing: { playhead: 120 } } }, loading: false, confirm: () => hold.promise, isCurrent: () => true, notify() {}, openTasks() {}, setPropertiesPage: (value: unknown) => updates.push(value), setRightDockTab() {}, setPanelOpen() {} };
    const open = compile(section('  async function openSubtitle(', '  function clipReplacementContext('), 'openSubtitle', scope), selecting = open(secondId);
    if (change === 'draft') h.controller.edit('text', 'new'); else panelIntent.current++;
    (hold.resolve)!(true); await selecting; assert.equal(h.controller.getState().cueId, cueId); assert.deepEqual((updates as unknown), []);
  }
});

test('actual App subtitle bridge passes exact durable identity and rechecks visible ownership before dispatch', async () => {
  const h = fixture(); h.controller.select(cueId); h.controller.edit('text', 'submitted'); await h.controller.save(); const intent = h.intents[0], calls: { input: unknown; }[]|{ lane: unknown; operation: unknown; input: unknown; }[] = [];
  let live = { ...context(), visible: true }, allowed;
  const scope = { subtitleContext: () => live, isDurableEditOperation: (operation: string) => operation.startsWith('timeline.subtitle.'), subtitleAcknowledged: subtitles.subtitleAcknowledged, subtitlesRef: { current: { controller: { getState: () => ({ selection: intent.selection }), isVisible: () => live.visible } } }, tasksRef: { current: { blocked: () => false } },
    runDurable: async (lane: unknown, operation: unknown, input: unknown, message: unknown, options: { canExecute: () => unknown; validateResponse: (arg0: never) => void; }) => { calls.push({ lane, operation, input }); live = { ...live, visible: false }; allowed = options.canExecute(); const saved = applied(intent); options.validateResponse(((saved) as unknown as Parameters<typeof options.validateResponse>[0])); return saved; } };
  const save = compile(section('  async function saveSubtitle(', '  const subtitles = useSubtitles('), 'saveSubtitle', scope);
  const response = await save(intent); assert.equal(response.status, 'applied'); assert.equal(calls[0].input, intent.input); assert.equal(allowed, false);
  assert.equal((await save(intent)).status, 'rejected'); assert.equal(calls.length, 1);
});

test('actual App history handler blocks a dirty subtitle and calls the shared undo/redo route when clean', async () => {
  const saved = timeline(), history = { projectId, timelineId, revision: 7, cursor: 1, length: 2, canUndo: true, canRedo: true, undoEntry: { id: id(41), operation: 'timeline.subtitle.add' }, redoEntry: { id: id(42), operation: 'timeline.subtitle.remove' } };
  for (const dirty of [true, false]) {
    const calls: unknown[] = [], scope = { workspaceMode: 'editing', currentProject: { current: projectId }, dataRef: { current: { project: { id: projectId }, timeline: saved, timelineHistory: history } }, timelineHistoryState, isBusy: () => false, timelinePending: false, clipDirty: false, subtitleDirty: dirty, online: true, auth: true, loading: false, mutateTimeline: (operation: unknown) => calls.push(operation) };
    const run = compile(section('  function changeTimelineHistory(', '  useEffect(() => {\n    const onKeyDown'), 'changeTimelineHistory', scope);
    run('undo'); run('redo'); assert.deepEqual(calls, dirty ? [] : ['timeline.undo', 'timeline.redo']);
  }
});

function navigationGuard(h: { controller: unknown; intents?: subtitles.SubtitleIntent[]; changes?: subtitles.SubtitleState[]; set?: (patch: { scope?: string; projectId?: string; timeline?: { id: string; projectId: string; revision: number; fps: number; width: number; height: number; durationFrames: number; tracks: { id: string; kind: string; name: string; orderIndex: number; hidden: boolean; muted: boolean; }[]; clips: { id: string; assetId: string; trackId: string; name: string; startFrame: number; durationFrames: number; sourceInFrame: number; gain: number; rect: { x: number; y: number; width: number; height: number; }; }[]; subtitles: { profileId: string; cues: { id: string; text: string; startFrame: number; durationFrames: number; }[]; }; createdAt: string; updatedAt: string; }; pending?: boolean; connected?: boolean; }) => void; context?: { pending: boolean; scope: string; projectId: string; timeline: { durationFrames: number; subtitles: { profileId: string; cues: ReturnType<typeof cue>[]; }; projectId: string; revision: number; id: string; fps: number; width: number; height: number; tracks: { id: string; kind: string; name: string; orderIndex: number; hidden: boolean; muted: boolean; }[]; clips: { id: string; assetId: string; trackId: string; name: string; startFrame: number; durationFrames: number; sourceInFrame: number; gain: number; rect: { x: number; y: number; width: number; height: number; }; }[]; createdAt: string; updatedAt: string; }; connected: boolean; }; requests?: number; }, confirm: (message?:unknown)=>Promise<unknown>, resets: unknown[][]) {
  const scope = { nativeWindow: null, shotTextRef: { current: null }, clipDraftRef: { current: null }, context: () => ({ projectId }), isCurrent: () => true, subtitlesRef: { current: { controller: h.controller } }, dirtyRef: { current: false }, confirm,
    subjectsRef: { current: null }, ...Object.fromEntries(['setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch'].map(name => [name, (value: unknown) => resets.push([name, value])])) };
  return compile(section('  async function guardNavigation(', '  async function guardProjectNavigation('), 'guardNavigation', scope);
}
test('actual App navigation consults same-tick subtitle state before React dirty rerender', async () => {
  const h = fixture(), resets: unknown[][] = [], prompts = []; h.controller.select(cueId); h.controller.edit('text', 'same-tick');
  let approved = false;
  const guard = navigationGuard(h, async (message: unknown) => { prompts.push(message); return approved; }, resets);
  assert.equal(await guard(), false); assert.equal(prompts.length, 1); assert.equal((h.controller.getState().draft)!.text, 'same-tick'); assert.deepEqual((resets as unknown), []);
  approved = true; assert.equal(await guard(), true); assert.equal(h.controller.getState().dirty, false); assert.equal((h.controller.getState().draft)!.text, cue().text);
  assert.ok(resets.some(([name, value]) => name === 'setSubtitleDirty' && value === false));
});

test('actual App late navigation confirmation cannot discard a newer subtitle draft in the same project', async () => {
  const h = fixture(), hold = deferred(), resets: unknown[][] = []; h.controller.select(cueId); h.controller.edit('text', 'before dialog');
  const guard = navigationGuard(h, () => hold.promise, resets), navigating = guard();
  h.controller.edit('text', 'newer input'); (hold.resolve)!(true); assert.equal(await navigating, false);
  assert.equal((h.controller.getState().draft)!.text, 'newer input'); assert.equal(h.controller.getState().dirty, true); assert.deepEqual((resets as unknown), []);
});
