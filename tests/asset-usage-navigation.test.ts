import type {WorkspaceEditingState} from '../apps/web/src/workspace-state.ts';
import type {TimelineAssetUse} from '../apps/web/src/timeline-asset-usage.ts';
import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage, translate } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectOpenAttempt, canPublishProjectOpen } from '../apps/web/src/project-open-state.ts';
import { deriveTimelineAssetUsage } from '../apps/web/src/timeline-asset-usage.ts';
import { locateTimelineAssetUse, matchesTimelineAssetUse, revealTimelineAssetUse } from '../apps/web/src/timeline-asset-navigation.ts';

import { lenientFunction } from './helpers/eval-source.ts';
import type { DisplayMessage } from '../packages/i18n/src/types.ts';
const Function = lenientFunction;
const id = (n: number) => `ce100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const projectId = id(1), assetId = id(2);
  const assets = [{ id: assetId, projectId, name: '原始素材', sha256: 'a'.repeat(64), mimeType: 'video/mp4' }];
  const timeline = { id: id(3), projectId, revision: 3, durationFrames: 150, fps: 30,
    tracks: [{ id: id(4), kind: 'video', orderIndex: 0, name: '画面一', hidden: false, muted: false }],
    clips: [{ id: id(5), assetId, trackId: id(4), name: '片段一', startFrame: 90, sourceInFrame: 15, durationFrames: 60, rect: { x: 0, y: 0, width: 1280, height: 720 }, gain: 1 }] };
  let ready = true;
  const state = { active: true, projectId, projectEpoch: 1, navigationEpoch: 2, panelIntent: 3, attempt: 1, workspaceScope: 'normal' as string | null };
  const read = () => ({ ...state, usage: deriveTimelineAssetUsage({ projectId: state.projectId, assets, timeline, ready }) });
  const use = read().usage.usesByAssetId[assetId]?.[0]; assert.ok(use);
  return { assets, timeline, state, read, use, setReady: (value: boolean) => { ready = value; } };
}
const held = <T = boolean>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

test('a chosen saved use passes exact identity, asks once and reveals without changing source snapshots', async () => {
  const f = fixture(), before = JSON.stringify([f.assets, f.timeline]), calls: ("confirm" | TimelineAssetUse)[] = [];
  assert.equal(await locateTimelineAssetUse(f.use, { read: f.read, isVisible: () => true,
    confirm: async current => { assert.equal(current(), true); calls.push('confirm'); return true; }, reveal: use => calls.push(use) }), true);
  assert.deepEqual(calls, ['confirm', f.use]); assert.equal(JSON.stringify([f.assets, f.timeline]), before);
});
for (const [label, change] of [
  ['project', (f: Awaited<ReturnType<typeof fixture>>) => { f.state.projectId = id(9); }], ['project epoch', (f: Awaited<ReturnType<typeof fixture>>) => f.state.projectEpoch++],
  ['new selection', (f: Awaited<ReturnType<typeof fixture>>) => f.state.navigationEpoch++], ['panel intent', (f: Awaited<ReturnType<typeof fixture>>) => f.state.panelIntent++], ['new usage request', (f: Awaited<ReturnType<typeof fixture>>) => f.state.attempt++],
  ['workspace', (f: Awaited<ReturnType<typeof fixture>>) => { f.state.workspaceScope = 'restored:' + id(9); }], ['unmount', (f: Awaited<ReturnType<typeof fixture>>) => { f.state.active = false; }],
  ['unknown refresh', (f: Awaited<ReturnType<typeof fixture>>) => f.setReady(false)], ['new timeline', (f: Awaited<ReturnType<typeof fixture>>) => { f.timeline.id = id(9); }], ['revision', (f: Awaited<ReturnType<typeof fixture>>) => f.timeline.revision++],
  ['deleted clip', (f: Awaited<ReturnType<typeof fixture>>) => { f.timeline.clips = []; f.timeline.durationFrames = 0; }],
  ['same-revision moved clip', (f: Awaited<ReturnType<typeof fixture>>) => { f.timeline.clips[0].startFrame++; f.timeline.durationFrames++; }],
  ['same-revision asset source hash', (f: Awaited<ReturnType<typeof fixture>>) => { f.assets[0].sha256 = 'b'.repeat(64); }],
  ['same-revision name', (f: Awaited<ReturnType<typeof fixture>>) => { f.timeline.clips[0].name = '另一个版本'; }],
] as const) test(`held confirmation rejects changed ${label} before discard and before selection`, async () => {
  const f = fixture(), gate = held(); let predicate!: () => boolean, revealed = 0;
  const result = locateTimelineAssetUse(f.use, ({ read: f.read, isVisible: () => true, confirm: (current: () => boolean) => { predicate = current; return gate.promise; }, reveal: () => revealed++ } as unknown as Parameters<typeof locateTimelineAssetUse>[1]));
  assert.equal(predicate!(), true); change(f); assert.equal(predicate!(), false); gate.resolve!(true);
  assert.equal(await result, false); assert.equal(revealed, 0);
});
test('hidden/filtered/unmounted row and declined confirmation never reveal', async () => {
  for (const decline of [false, true]) {
    const f = fixture(), gate = held(); let visible = true, predicate!: () => boolean;
    const result = locateTimelineAssetUse(f.use, ({ read: f.read, isVisible: () => visible, confirm: (current: () => boolean) => { predicate = current; return gate.promise; }, reveal: () => assert.fail('No stale reveal') } as unknown as Parameters<typeof locateTimelineAssetUse>[1]));
    if (!decline) visible = false;
    assert.equal(predicate!(), decline); gate.resolve!(!decline); assert.equal(await result, false);
  }
});
test('stale row, unknown state or missing workspace identity do not even ask to discard', async () => {
  for (const change of [(f: Awaited<ReturnType<typeof fixture>>) => f.setReady(false), (f: Awaited<ReturnType<typeof fixture>>) => f.timeline.revision++, (f: Awaited<ReturnType<typeof fixture>>) => { f.state.workspaceScope = null; }]) {
    const f = fixture(); change(f);
    assert.equal(await locateTimelineAssetUse(f.use, { read: f.read, isVisible: () => true, confirm: () => assert.fail('No confirmation'), reveal: () => assert.fail('No reveal') }), false);
  }
});

test('viewport reveal is bounded to its exact child and both layout callbacks respect a later selection', () => {
  for (const invalidateAt of [0, 1, 2]) {
    let valid = true; const queued: (() => void)[] = [];
    const clip = { dataset: { testid: 'timeline-clip-' + id(5) }, getBoundingClientRect: () => ({ left: 900, right: 940, top: 700, bottom: 750 }) };
    const viewport = { scrollLeft: 0, scrollTop: 0, querySelectorAll: (selector: unknown) => { assert.equal(selector, '[data-testid]'); return [clip]; }, getBoundingClientRect: () => ({ left: 10, right: 500, top: 50, bottom: 300 }) };
    revealTimelineAssetUse(id(5), () => valid, () => viewport as unknown as HTMLElement, callback => queued.push(callback));
    if (invalidateAt === 0) valid = false; queued.shift()!();
    if (invalidateAt === 1) valid = false; queued.shift()?.();
    assert.equal(viewport.scrollLeft, invalidateAt === 2 ? 722 : 0); assert.equal(viewport.scrollTop, invalidateAt === 2 ? 642 : 0);
  }
});

const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const section = (start: string, end: string) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
const readySource = section('  function projectSessionReady()', '  const workbenchReady =');
const bridge = section('  function readAssetUsageNavigation()', '  function timelineFormatContext()');
function appHarness() {
  const f = fixture(), calls: unknown[][] = [], gate = held(); let predicate: (() => boolean) | undefined;
  const env = { msg, ...createI18nTestContext(), deriveTimelineAssetUsage, locateTimelineAssetUse, matchesTimelineAssetUse, canPublishProjectOpen,
    openedProject: { current: projectOpenAttempt(f.state.projectId, f.state.projectEpoch, f.state.workspaceScope!) as ReturnType<typeof projectOpenAttempt> | null },
    revealTimelineAssetUse: (...args: unknown[]) => calls.push(['scroll', ...args]),
    currentProject: { current: f.state.projectId }, dataRef: { current: { project: { id: f.state.projectId }, timeline: f.timeline, assets: f.assets } },
    importSession: { current: { active: true, selection: 0 } }, viewReady: { current: true }, projectEpoch: { current: 1 }, navigationEpoch: { current: 2 }, panelIntent: { current: 3 }, assetUsageAttempt: { current: 0 },
    workspaceRef: { current: { restored: false } as {restored: boolean; workspaceOrigin?: string} }, workspaceOriginScope: (value: { restored: unknown; workspaceOrigin: string; }) => value.restored ? 'restored:' + value.workspaceOrigin : 'normal', assetUsageAvailability: { current: { ready: true } }, isBusy: () => false,
    guardNavigation: (message: string|DisplayMessage|null|undefined, dirty: unknown, current: () => boolean) => { assert.match(renderCoreMessage('zh-Hans', message), /定位此素材/); assert.equal(dirty, false); predicate = current; return gate.promise; },
    setPropertiesPage: (value: unknown) => calls.push(['properties', value]), setRightDockTab: (value: unknown) => calls.push(['dock', value]),
    viewRef: { current: { activeMode: 'canvas', editing: {} as Partial<WorkspaceEditingState> } },
    updateView: (area: string, value: string) => { calls.push(['view', area, value]); if (area === 'activeMode') env.viewRef.current.activeMode = value; else Object.assign((env.viewRef.current[(area as keyof typeof env.viewRef.current)] as object), value); },
    setPanelOpen: (...args: unknown[]) => { calls.push(['panel', ...args]); env.panelIntent.current++; }, setMobilePanel: (value: unknown) => calls.push(['mobile', value]), geometry: { narrow: false },
    context: () => ({ epoch: env.navigationEpoch.current }), isCurrent: (captured: { epoch: number; }) => captured.epoch === env.navigationEpoch.current,
    document: {}, requestAnimationFrame: () => assert.fail('Scheduled by dedicated helper'),
  };
  const api = (Function(...Object.keys(env), `${readySource}\n${bridge}; return {readAssetUsageNavigation,locateAssetUse};`)(...Object.values(env)) as {readAssetUsageNavigation(): ReturnType<typeof f.read>; locateAssetUse(use: TimelineAssetUse, isVisible: () => boolean): Promise<boolean>});
  return { f, env, api, calls, gate, predicate: () => predicate! };
}
test('actual App bridge opens the chosen clip in Properties and saved timeline without business calls', async () => {
  const h = appHarness(), before = JSON.stringify(h.env.dataRef.current);
  const pending = h.api.locateAssetUse(h.f.use, () => true); assert.equal(h.predicate()(), true); h.gate.resolve!(true); assert.equal(await pending, true);
  assert.equal(h.env.viewRef.current.activeMode, 'editing'); assert.equal(h.env.viewRef.current.editing.selectedClipId, h.f.use.clipId); assert.equal(h.env.viewRef.current.editing.playhead, 90); assert.equal(h.env.viewRef.current.editing.timelineCollapsed, false);
  assert.ok(h.calls.some(call => call[0] === 'dock' && call[1] === 'properties')); assert.ok(h.calls.some(call => call[0] === 'panel' && call[1] === 'inspector' && call[2] === true));
  assert.equal(JSON.stringify(h.env.dataRef.current), before); assert.equal(h.calls.filter(call => call[0] === 'scroll').length, 1);
});
for (const key of ['projectEpoch', 'navigationEpoch', 'panelIntent', 'assetUsageAttempt']) test(`actual App bridge checks live ${key} after dirty confirmation`, async () => {
  const h = appHarness(), pending = h.api.locateAssetUse(h.f.use, () => true); h.env[(key as 'projectEpoch' | 'navigationEpoch' | 'panelIntent' | 'assetUsageAttempt')].current++; assert.equal(h.predicate()(), false); h.gate.resolve!(true);
  assert.equal(await pending, false); assert.deepEqual((h.calls as unknown), []);
});
test('actual App bridge refuses an unaccepted home session before or during discard confirmation', async () => {
  for (const timing of ['before', 'during']) {
    const h = appHarness();
    if (timing === 'before') h.env.openedProject.current = null;
    const pending = h.api.locateAssetUse(h.f.use, () => true);
    if (timing === 'during') {
      assert.equal(h.predicate()(), true);
      h.env.openedProject.current = null;
      assert.equal(h.predicate()(), false);
    } else assert.equal(h.predicate(), undefined, 'Home cannot even ask to discard a project draft');
    h.gate.resolve!(true);
    assert.equal(await pending, false); assert.deepEqual((h.calls as unknown), []);
    assert.equal(h.api.readAssetUsageNavigation().active, false);
  }
});
test('App passes the target fence through the actual clip discard boundary', async () => {
  const guard = section('  async function guardNavigation(', '  async function guardProjectNavigation(');
  let passed, dirty = true;
  const env = { nativeWindow: null, context: () => 'owner', isCurrent: () => true, subtitlesRef: { current: null }, shotTextRef: { current: null },
    clipDraftRef: { current: { capture: () => 'token', hasUnsaved: () => true, isCurrent: () => true, hasPendingComposition: () => false, discard: async (token: unknown, fence: unknown) => { assert.equal(token, 'token'); passed = fence; return false; } } },
    dirtyRef: { current: true }, confirm: async () => true, subjectsRef: { current: null },
    setShotDirty: () => assert.fail('No clear'), setClipDirty: () => { dirty = false; }, setSourceDirty: () => assert.fail('No clear'), setSubjectDirty: () => assert.fail('No clear'), setSubtitleDirty: () => assert.fail('No clear'), setInspectorEpoch: () => assert.fail('No clear') };
  const run = (Function(...Object.keys(env), `${guard}; return guardNavigation;`)(...Object.values(env)) as (message: string, dirty: boolean, current: () => boolean) => Promise<boolean>);
  const current = () => true; assert.equal(await run('Confirm', false, current), false); assert.equal(passed, current); assert.equal(dirty, true);
});
