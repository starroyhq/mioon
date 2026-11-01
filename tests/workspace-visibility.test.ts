import type {Hook as UiHook,Tree as UiTree,Module as UiModule,Element as UiElement,Props as UiProps} from './helpers/strict-workspace-ui-types.ts';
import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage, translate } from './helpers/i18n.ts';
import * as i18nCore from '../packages/i18n/src/index.ts';
import * as creationI18n from '../apps/web/src/creation-i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as contracts from '@mioon/contracts';
import { activeJob } from '../apps/web/src/api.ts';
import { LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';
import * as exportSettings from '../apps/web/src/export-settings-state.ts';
import * as sourceRanges from '../apps/web/src/source-range-state.ts';
import * as previewPlayback from '../apps/web/src/preview-playback.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import {imageEditSourceIssueDescriptor} from '../apps/web/src/image-generation.ts';
import {generationParameters} from '../apps/web/src/generation-settings.ts';

// Exercise the real component functions with deterministic hook, ref, media,
// and animation-frame boundaries. These tests intentionally do not claim DOM
// or browser playback coverage; browser acceptance covers the integrated UI.
const componentCode = new Map(['workspace-visibility.tsx', 'Nodes.tsx', 'Preview.tsx', 'Inspector.tsx'].map(file => [file,
  transformSync(readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', sourcefile: file }).code,
]));
const noop = () => {};
function makeElement(src:unknown = null) {
  return {
    src, currentTime: 0, duration: 20, paused: true, seeking: false, isConnected: true,
    pauses: 0, loads: 0, focuses: 0, scrolls: 0,
    getAttribute(name: string) { return name === 'src' ? this.src : null; },
    setAttribute(name: string, value: unknown) { if (name === 'src') this.src = value; },
    removeAttribute(name: string) { if (name === 'src') this.src = null; },
    pause() { this.paused = true; this.pauses++; },
    load() { this.loads++; this.currentTime = 0; },
    focus() { this.focuses++; },
    scrollIntoView() { this.scrolls++; },
  };
}
function treeNodes(tree: UiTree): UiElement[] {
  if (Array.isArray(tree)) return tree.flatMap(treeNodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...treeNodes(tree.props?.children)];
}
function createHarness(file: string, exportName = 'default') {
  const slots: UiHook[] = [], frames = new Map<number,()=>void>(), elements = new Map<string,ReturnType<typeof makeElement>>(), modules = new Map<string,UiModule>();
  let cursor = 0, layouts: number[] = [], effects: number[] = [], nextFrame = 0, tree: UiTree;
  const h = { ancestorVisible: undefined, locale: 'zh-Hans' } as import('./helpers/strict-workspace-ui-types.ts').VisibilityHarness;
  function effect(kind: string, callback: ()=>void|(()=>void), dependencies: unknown[]) {
    const index = cursor++, previous = slots[index];
    if (previous && dependencies?.length === previous.dependencies?.length && dependencies.every((value: unknown, i) => Object.is(value, previous.dependencies![i]))) return;
    slots[index] = { dependencies, cleanup: previous?.cleanup, callback, kind };
    (kind === 'layout' ? layouts : effects).push(index);
  }
  const react = {
    createElement(type: string, props: Partial<UiProps>|null, ...children: unknown[]) { return { type, props: { ...props, children: children.length === 1 ? children[0] : children } }; },
    createContext(value: unknown) { return { defaultValue: value, Provider: 'VisibilityProvider' }; },
    useContext(context: { defaultValue: unknown; }) { return h.ancestorVisible ?? context.defaultValue; },
    useRef(value: unknown) { const index = cursor++; return slots[index] ||= { current: value }; },
    useState(value: () => unknown) { const index = cursor++; slots[index] ||= { value: typeof value === 'function' ? value() : value }; return [slots[index].value, (next: (arg0: unknown) => unknown) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useEffect: (callback: ()=>void|(()=>void), dependencies: unknown[]) => effect('effect', callback, dependencies),
    useLayoutEffect: (callback: ()=>void|(()=>void), dependencies: unknown[]) => effect('layout', callback, dependencies),
    memo: (component: unknown) => component,
    Fragment: 'Fragment',
  };
  (react as typeof react&{default?:unknown}).default = react;
  const ui = new Proxy({ useConfirmation: () => h.confirm || (async () => true) }, { get: (target, key) => (target as Record<PropertyKey,unknown>)[key] ?? String(key) });
  const mocks:Record<string,unknown> = {
    react,
    './i18n/I18nProvider.tsx': { useI18n: () => createI18nTestContext(h.locale) },
    '../../../packages/i18n/src/index.ts': i18nCore,
    './creation-i18n.ts': creationI18n,
    '@mioon/contracts': contracts,
    '@mioon/contracts/local-shot-text': { LOCAL_SHOT_TEXT_LIMITS },
    './local-shot-text-state.ts': { useLocalShotText: ({ context }: {context:{restored:boolean}}) => {
      if (h.shotTextState) return { state: h.shotTextState, controller: {
        setContext() {}, getState: () => h.shotTextState, blocksLegacy: () => false, canPrepare: () => Boolean(h.canSaveShotText),
      } };
      assert.equal(context.restored, true, 'This legacy Inspector fixture has no shot-text context');
      return { state: {}, controller: { setContext() {} } };
    }, mergeFreshShotTextAck: () => { assert.fail('No shot-text acknowledgement is expected in this fixture'); } },
    './ShotTextDraftRecovery.tsx': { default: 'ShotTextDraftRecovery', __esModule: true },
    './AssetAnnotations.tsx': { default: 'AssetAnnotations', __esModule: true },
    './CanvasOverview.tsx': { default: 'CanvasOverview', __esModule: true },
    './BoardInspectorGroup.tsx': { default: 'BoardInspectorGroup', __esModule: true },
    './VersionCardPreview.tsx': { default: 'VersionCardPreview', __esModule: true },
    './CompactNodePlayer.tsx': { default: 'CompactNodePlayer', __esModule: true },
    './previs/PrevisNode.tsx': { default: 'PrevisNode', __esModule: true },
    './PreviewPlaybackControls.tsx': { default: 'PreviewPlaybackControls', __esModule: true },
    './PreviewRenderProgress.tsx': { default: 'PreviewRenderProgress', __esModule: true },
    './preview-playback.ts': previewPlayback,
    './UiPreferencesProvider.tsx': {useUiPreferences:()=>({preferences:DEFAULT_UI_PREFERENCES})},
    './image-generation.ts': {imageEditSourceIssueDescriptor},
    './source-range-state.ts': sourceRanges,
    './export-settings-state.ts': exportSettings,
    '@xyflow/react': { Handle: 'Handle', Position: { Left: 'left', Right: 'right' } },
    './TimelineAudioPreview.tsx': { default: 'TimelineAudioPreview', __esModule: true },
    './ClipTransformBox.tsx': { default: 'ClipTransformBox', __esModule: true },
    './icons.tsx': { default: 'Icon', __esModule: true },
    './api.ts': { assetUrl: (asset: { url: unknown; }) => asset?.url || '', versionUrl: (version: { url: unknown; }) => version?.url || '', activeJob, statusText: (value: unknown) => value, jobStatusText: (value: unknown) => value, outputReviewRequired: () => false },
    './Timeline.tsx': { assetKind: (asset: { mimeType: string; }) => asset?.mimeType?.split('/')[0], framesLabel: String, dragAsset: noop },
    './reference-connections.ts': { referenceForShot: () => null },
    './generation-settings.ts': { generationParameters, wanGenerationCapabilities: () => null, seedanceGenerationCapabilities: () => null, generationVideoInput: () => undefined, generationSelection: () => ({ provider: { id: 'mock', mock: true }, model: 'mock', capabilities: {}, inputMode: 'text', scenario: 'success' }), generationInputIssue: () => '', providerAvailabilityIssue: () => '', inputModeLabel: String, inputModeDescriptor: String, generationInputIssueDescriptor: () => '', providerAvailabilityDescriptor: () => '' },
    './VideoFrameControls.tsx': { default: 'VideoFrameControls', VideoFrameSummary: 'VideoFrameSummary', __esModule: true },
    './ProviderSettings.tsx': { default: 'ProviderSettings', __esModule: true },
    './SubjectVideoSelection.tsx': { default: 'SubjectVideoSelection', __esModule: true },
    './SubjectVideoSummary.tsx': { default: 'SubjectVideoSummary', __esModule: true },
    './subject-video.ts': { subjectVideoConflictIssue: () => '', seedanceReferenceRules: () => null, subjectReferencePlan: () => null, subjectReferenceLabel: () => null },
    './ShotSubjectBindings.tsx': { default: 'ShotSubjectBindings', __esModule: true },
    './WorkspaceControls.tsx': { WorkbenchSelect: 'WorkbenchSelect', WorkbenchTooltip: 'WorkbenchTooltip' },
    './ReferenceConnections.tsx': { ReferenceSourcePanel: 'ReferenceSourcePanel', BoundReference: 'BoundReference' },
  };
  function load(filename: string) {
    if (modules.has(filename)) return modules.get(filename)!.exports;
    const module: UiModule = { exports: {} }; modules.set(filename, module);
    const require = (id: string) => {
      if (mocks[id]) return mocks[id];
      if (id.endsWith('.css')) return {};
      if (id.startsWith('@mioon/ui/')) return ui;
      if (componentCode.has(id.replace('./', ''))) return load(id.replace('./', ''));
      throw Error(`Unexpected component dependency: ${id}`);
    };
    Function('require', 'module', 'exports', 'requestAnimationFrame', 'cancelAnimationFrame', componentCode.get(filename)!)(
      require, module, module.exports,
(      callback: ()=>void|(()=>void)) => { frames.set(++nextFrame, callback); return nextFrame; },
(      id: unknown) => frames.delete((id as unknown as Parameters<typeof frames.delete>[0])),
    );
    return module.exports;
  }
  const Component = load(file)[exportName];
  function flush(queue: number[]) {
    for (const index of queue) { const slot = slots[index]; slot.cleanup?.(); slot.cleanup = slot.callback!(); }
  }
  Object.assign(h, {
    render(props: Record<string,unknown>, { passive = true } = {}) {
      cursor = 0; layouts = []; effects = [];
      tree = Component!(props);
      for (const node of treeNodes(tree!)) {
        if (node.props?.ref && typeof node.props.ref === 'object') {
          const key = `${node.type}:${node.props.key ?? node.props['data-testid'] ?? 'ref'}`;
          if (!elements.has(key)) elements.set(key, makeElement(node.props.src));
          node.props.ref.current = (elements.get(key) as unknown as import("./helpers/strict-workspace-ui-types.ts").MediaElement);
        }
      }
      flush(layouts); if (passive) this.flushPassive();
      return tree;
    },
    flushPassive() { const pending = effects; effects = []; flush(pending); },
    nodes: () => treeNodes(tree!),
    find: (testId: unknown) => treeNodes(tree!).find((node) => node.props?.['data-testid'] === testId),
    mediaNode: () => treeNodes(tree!).find((node) => ['audio', 'video'].includes(node.type)),
    pendingFrames: () => [...frames.values()],
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); for (const element of elements.values()) element.isConnected = false; },
    replayEffects() { for (const slot of slots) if (slot?.callback) { slot.cleanup?.(); slot.cleanup = slot.callback!(); } },
  });
  return h;
}
const asset = (kind = 'video', id = 'asset-one') => ({ id, url: `/media/${id}`, mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}`, name: 'Fixture' });
const previewProps = <Patch extends Record<string,unknown>>(patch: Patch) => ({ visible: true, kind: 'source', asset: asset(), playhead: 0, onSeek: noop, ...patch });
const inspectorProps = (patch?: Record<string,unknown>) => ({
  shot: { id: 'shot-one', title: 'Fixture shot', prompt: 'Original', revision: 1, orderIndex: 0 },
  project: { id: 'project-one' }, assets: [], versions: [{ id: 'version-one', shotId: 'shot-one', number: 1, createdAt: '2026-10-09T12:00:00Z' }],
  jobs: [], providers: [], busy: {}, tab: 'versions', highlightedVersionId: 'version-one', onDirtyChange: noop,
  ...patch,
});

test('visibility defaults to visible and nested visible panels cannot override a hidden ancestor', () => {
  const h = createHarness('workspace-visibility.tsx', 'WorkspaceVisibilityProvider');
  assert.equal(h.render({ children: 'content' }).props.value, true);
  assert.equal(h.render({ visible: false }).props.value, false);
  h.ancestorVisible = false;
  assert.equal(h.render({ visible: true }).props.value, false);
  h.ancestorVisible = true;
  assert.equal(h.render({ visible: true }).props.value, true);
});

for (const kind of ['video', 'audio'] as const) {
  test(`${kind} Media pauses before passive effects; hide/reopen preserves element, source and time`, () => {
    const h = createHarness('Nodes.tsx', 'Media'), events: unknown[] = [];
    const props = { asset: asset(kind), controls: true, onPlay: () => events.push('play'), onTimeUpdate: () => events.push('time') };
    h.render(props);
    const node = h.mediaNode(), element = node.props.ref.current;
    element.currentTime = 4.125; element.paused = false;
    h.ancestorVisible = false; h.render(props, { passive: false });
    assert.equal(element.paused, true); assert.equal(element.currentTime, 4.125);
    assert.equal(element.src, props.asset.url); assert.equal(element.loads, 0);
    for (const callback of ['onPlay', 'onPlaying', 'onTimeUpdate'] as const) {
      element.paused = false; node.props[callback]({ currentTarget: element });
      assert.equal(element.paused, true, `${callback} captured while visible must respect current hidden state`);
    }
    assert.deepEqual(events, []);
    h.ancestorVisible = true; h.render(props);
    assert.equal(h.mediaNode().props.ref.current, element); assert.equal(element.currentTime, 4.125);
    assert.equal(element.paused, true); assert.equal(element.loads, 0);
    h.unmount(); assert.equal(element.src, null); assert.equal(element.loads, 1);
  });

  test(`${kind} Preview ignores late hidden callbacks and does not seek or resume on reopen`, () => {
    const h = createHarness('Preview.tsx'), seeks: unknown[] = [], props = previewProps({ asset: asset(kind), onSeek: (value: unknown) => seeks.push(value) });
    h.render(props);
    const node = h.mediaNode(), element = node.props.ref.current;
    element.currentTime = 5.25; element.paused = false;
    h.render({ ...props, visible: false }, { passive: false });
    assert.equal(element.paused, true);
    for (const name of ['onPlay', 'onPlaying', 'onTimeUpdate', 'onSeeked', 'onLoadedMetadata'] as const) {
      if (['onPlay', 'onPlaying', 'onTimeUpdate'].includes(name)) element.paused = false;
      node.props[name]({ currentTarget: element });
      assert.equal(element.currentTime, 5.25);
      assert.equal(element.paused, true, `${name} cannot continue hidden playback`);
    }
    assert.deepEqual(seeks, []);
    h.render(props);
    assert.equal(h.mediaNode().props.ref.current, element); assert.equal(element.currentTime, 5.25);
    assert.equal(element.paused, true); assert.equal(element.loads, 0); assert.equal(element.src, props.asset.url);
    h.unmount(); assert.equal(element.loads, 1); assert.equal(element.src, null);
  });
}

for (const kind of ['source', 'timeline'] as const) {
  test(`${kind} Preview cannot publish late playback or native-seek events while hidden`, () => {
    const h = createHarness('Preview.tsx'), seeks: unknown[] = [], props = previewProps({
      kind, onSeek: (value: unknown) => seeks.push(value), timeline: { revision: 1 },
      clip: { id: 'clip-one', sourceInFrame: 0, startFrame: 0, durationFrames: 300 },
      job: { id: 'render-one', status: 'succeeded', url: '/render', timelineRevision: 1 },
    });
    h.render(props); const node = h.mediaNode(), element = node.props.ref.current;
    element.currentTime = 2; element.paused = false;
    node.props.onTimeUpdate({ currentTarget: element }); assert.deepEqual(seeks, [60]);
    h.render({ ...props, visible: false });
    element.currentTime = 3; element.paused = false;
    node.props.onTimeUpdate({ currentTarget: element }); node.props.onSeeked({ currentTarget: element });
    assert.deepEqual(seeks, [60]); assert.equal(element.paused, true);
  });
}

test('Preview applies a changed playhead deferred while hidden, without publishing that programmatic seek', () => {
  const h = createHarness('Preview.tsx'), seeks: unknown[] = [], props = previewProps({ clip: { id: 'clip-one', sourceInFrame: 30, startFrame: 60, durationFrames: 300 }, playhead: 90, onSeek: (value: unknown) => seeks.push(value) });
  h.render(props); const element = h.mediaNode().props.ref.current;
  assert.equal(element.currentTime, 2);
  h.ancestorVisible = false; h.render({ ...props, playhead: 180 });
  assert.equal(element.currentTime, 2); assert.equal(element.paused, true);
  h.ancestorVisible = true; h.render({ ...props, playhead: 180 });
  assert.equal(element.currentTime, 5);
  h.mediaNode().props.onSeeked({ currentTarget: element }); assert.deepEqual(seeks, []);
  element.currentTime = 6;
  h.mediaNode().props.onSeeked({ currentTarget: element }); assert.deepEqual(seeks, [210]);
});

test('replaced Preview sources reject old callbacks and Strict Mode disposal restores the current source', () => {
  const h = createHarness('Preview.tsx'), seeks: unknown[] = [], props = previewProps({ kind: 'timeline', timeline: { revision: 1 }, job: { id: 'render-one', status: 'succeeded', url: '/first', timelineRevision: 1 }, onSeek: (value: unknown) => seeks.push(value) });
  h.render(props); const old = h.mediaNode(), original = old.props.ref.current;
  h.render({ ...props, job: { ...props.job, id: 'render-two', url: '/second' } });
  const current = h.mediaNode().props.ref.current;
  assert.notEqual(original, current); assert.equal(original.loads, 1); assert.equal(original.src, null);
  original.currentTime = 4; original.paused = false;
  old.props.onTimeUpdate({ currentTarget: original }); old.props.onSeeked({ currentTarget: original }); old.props.onPlay({ currentTarget: original });
  assert.deepEqual(seeks, []); assert.equal(original.paused, true);
  h.replayEffects(); assert.equal(current.src, '/second'); assert.equal(current.paused, true);
});

test('Inspector version cards expose stable version numbers and keep frozen details collapsed without changing actions', () => {
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
    const h = createHarness('Inspector.tsx'), selections: unknown[] = [], additions: unknown[] = [], comparisons: unknown[] = [];
    h.locale = locale;
    const props = inspectorProps({ highlightedVersionId: null,
      versions: [{ id: 'version-one', shotId: 'shot-one', number: 1, assetId: 'asset-one', model: 'model-one',
        createdAt: '2026-10-09T12:00:00Z', snapshot: { prompt: 'Frozen prompt with full detail', duration: 4, aspectRatio: '9:16' } }],
      onSelectVersion: (shot: { id: unknown; }, versionId: unknown) => selections.push([shot.id, versionId]), onAddVersion: (assetId: unknown) => additions.push(assetId), onCompare: (shotId: unknown) => comparisons.push(shotId),
    });
    h.render(props);
    const card = h.find('version-card-version-one'), nodes = treeNodes(card);
    const number = nodes.find((node) => node.props?.className === 'version-number');
    assert.equal(number!.props.children, translate(locale, 'redesign.projects.versionBadge', { number: 1 }));
    assert.equal(number!.props['aria-label'].includes('1'), true);
    const details = h.find('version-metadata-version-one');
    assert.equal(details.type, 'details'); assert.equal(Boolean(details.props.open || details.props.defaultOpen), false);
    const prompt = treeNodes(details).find((node) => node.type === 'p');
    assert.equal(prompt!.props.children, 'Frozen prompt with full detail');
    assert.equal(nodes.filter((node) => node.type === 'p' && node.props.children === 'Frozen prompt with full detail').length, 1);
    const actions = nodes.filter((node) => node.type === 'Button');
    assert.equal(actions.length, 3);
    actions[0].props.onClick(); actions[1].props.onClick(); actions[2].props.onClick();
    assert.deepEqual(comparisons, ['shot-one']);
    assert.deepEqual(selections, [['shot-one', 'version-one']]); assert.deepEqual(additions, ['asset-one']);
    h.unmount();
  }
});

test('Wan history summaries prefer frozen generation duration and ratio with localized automatic values', () => {
  const treeText = (node: UiTree): string => Array.isArray(node) ? node.map(treeText).join('') : node && typeof node === 'object' ? treeText(node.props?.children) : node == null || typeof node === 'boolean' ? '' : String(node);
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
    const h = createHarness('Inspector.tsx'); h.locale = locale;
    const version = { id: 'version-one', shotId: 'shot-one', number: 1, model: 'wan3.0-video', createdAt: '2026-10-23T00:00:00Z',
      snapshot: { duration: 4, aspectRatio: '9:16', parameters: { durationSeconds: 30, aspectRatio: '21:9' } } };
    const props = inspectorProps({ versions: [version], highlightedVersionId: null });
    const specs = () => treeNodes(h.find('version-card-version-one')).find((node) => node.props?.className === 'version-generation-specs');
    h.render(props); assert.match(treeText(specs()), /30s.*21:9/); assert.doesNotMatch(treeText(specs()), /4s|9:16/);
    h.render({ ...props, versions: [{ ...version, snapshot: { ...version.snapshot, parameters: { durationSeconds: -1, aspectRatio: 'adaptive' } } }] });
    assert.ok(treeText(specs()).includes(translate(locale, 'video.wan.smartDuration'))); assert.ok(treeText(specs()).includes(translate(locale, 'video.wan.adaptive')));
    assert.doesNotMatch(treeText(specs()), /-1s|4s|9:16/); h.unmount();
  }
});

test('Inspector exposes real generation progress and cancellation only continues the exact visible job after approval', async () => {
  for (const change of ['none', 'hide', 'tab', 'project', 'snapshot', 'terminal', 'busy', 'unmount'] as const) {
    const h = createHarness('Inspector.tsx'), cancelled: unknown[] = [];
    let approve; h.confirm = () => new Promise(resolve => { approve = resolve; });
    const job = { id: 'running-one', shotId: 'shot-one', status: 'running', progress: 45, snapshot: { prompt: 'Frozen original' } };
    const props = inspectorProps({ tab: 'settings', highlightedVersionId: null, jobs: [job], onCancelJob: (value: { id: unknown; }, current: () => unknown) => cancelled.push([value.id, current()]) });
    h.render(props); assert.ok(h.find('inspector-generation-progress'));
    const work = h.find('cancel-generation').props.onClick(); assert.deepEqual(cancelled, []);
    if (change === 'hide') { h.ancestorVisible = false; h.render(props); h.ancestorVisible = true; h.render(props); }
    if (change === 'tab') { h.render({ ...props, tab: 'versions' }); h.render(props); }
    if (change === 'project') h.render({ ...props, project: { id: 'project-two' } });
    if (change === 'snapshot') h.render({ ...props, jobs: [{ ...job, snapshot: { prompt: 'Replaced snapshot' } }] });
    if (change === 'terminal') h.render({ ...props, jobs: [{ ...job, status: 'succeeded' }] });
    if (change === 'busy') h.render({ ...props, busy: { 'cancel:running-one': true } });
    if (change === 'unmount') h.unmount();
    approve!(true); await work;
    assert.deepEqual(cancelled, change === 'none' ? [['running-one', true]] : [], change);
    if (change !== 'unmount') h.unmount();
  }
  for (const patch of [{ jobs: [{ id: 'unknown', shotId: 'shot-one', status: 'submission_unknown' }] }, { restored: true }, { generationUnavailableReason: 'Unavailable' }] as const) {
    const h = createHarness('Inspector.tsx'); h.render(inspectorProps({ tab: 'settings', jobs: [{ id: 'running-one', shotId: 'shot-one', status: 'running' }], onCancelJob: () => assert.fail('Must not cancel'), ...patch }));
    assert.equal(h.find('cancel-generation'), undefined); assert.equal(h.find('inspector-generation-progress'), undefined); h.unmount();
  }
});

test('failed version attempts retry the original job and cannot duplicate an uncertain retry', () => {
  const h = createHarness('Inspector.tsx'), retried: unknown[] = [];
  const job = { id: 'failed-one', shotId: 'shot-one', status: 'failed', snapshot: { prompt: 'Original immutable retry' } };
  const props = inspectorProps({ jobs: [job], onRetryJob: (value: { id: unknown; }, current: () => unknown) => retried.push([value.id, current()]) });
  h.render(props); assert.ok(h.find('failed-version-failed-one'));
  const retry = h.find('retry-failed-version-failed-one').props.onClick; retry();
  assert.deepEqual(retried, [['failed-one', true]]);
  h.render({ ...props, jobs: [job, { id: 'retry-one', shotId: 'shot-one', status: 'submission_unknown', retryOfJobId: job.id }] });
  assert.equal(h.find('retry-failed-version-failed-one').props.disabled, true); retry(); assert.equal(retried.length, 1); h.unmount();
});

test('Inspector folds only passive synchronized text while every recovery or save state stays explicit', () => {
  const settled = { phase: 'ready', dirty: false, candidate: null, baselineConflict: false, autosavePaused: false,
    draftFailure: null, draftError: '', draftRetry: null, intentFailure: null, intentError: '', intentUncertain: false,
    pending: false, busy: false, retainedDraftWrite: null, retainedDeletion: null, retainedPreparation: null,
    projectPendingIntent: null, intentPhase: 'idle', intent: null };
  const props = inspectorProps({ tab: 'settings', highlightedVersionId: null, shotTextContext: { scope: 'text', connected: true, restored: false } });
  const attention = [
    { phase: 'loading' }, { phase: 'saving' }, { phase: 'error' }, { phase: 'unsupported' },
    { dirty: true }, { candidate: {} }, { baselineConflict: true }, { autosavePaused: true },
    { draftFailure: {} }, { draftError: 'failed' }, { draftRetry: 'same' }, { intentFailure: {} }, { intentError: 'failed' },
    { intentUncertain: true }, { pending: true }, { busy: true }, { retainedDraftWrite: {} }, { retainedDeletion: {} },
    { retainedPreparation: {} }, { projectPendingIntent: {} }, { intentPhase: 'preparing' }, { intentPhase: 'not_applied' },
    { intent: { outcome: { status: 'not_applied' } } },
  ];
  const h = createHarness('Inspector.tsx');
  for (const patch of [{}, { phase: 'saved', intentPhase: 'applied', intent: { outcome: { status: 'applied' } } }] as const) {
    h.shotTextState = { ...settled, ...patch }; h.render(props);
    const disclosure = h.find('shot-text-recovery-passive');
    assert.equal(disclosure.type, 'details'); assert.equal(Boolean(disclosure.props.open || disclosure.props.defaultOpen), false);
    assert.equal(h.find('shot-text-recovery-active'), undefined);
    assert.equal(treeNodes(disclosure).some((node) => node.type === 'ShotTextDraftRecovery'), true);
  }
  for (const patch of attention) {
    h.shotTextState = { ...settled, ...patch }; h.render(props);
    assert.ok(h.find('shot-text-recovery-active'), JSON.stringify(patch)); assert.equal(h.find('shot-text-recovery-passive'), undefined);
  }
  h.shotTextState = settled; h.canSaveShotText = true; h.render(props);
  assert.ok(h.find('shot-text-recovery-active'), 'An available save action cannot be folded');
  h.canSaveShotText = false; h.find('shot-prompt').props.onChange({ target: { value: 'New input before text hook catches up' } }); h.render(props);
  assert.ok(h.find('shot-text-recovery-active'), 'Current unsaved form text stays explicit even if the hook snapshot is still settled');
  h.unmount();
});

test('Inspector cancels pending highlight focus when hidden and does not refocus on reopening or refresh', () => {
  const h = createHarness('Inspector.tsx'), props = inspectorProps();
  h.render(props); const element = h.find('version-card-version-one').props.ref.current;
  const [queued] = h.pendingFrames(); assert.ok(queued);
  h.ancestorVisible = false; h.render(props);
  assert.equal(h.pendingFrames().length, 0);
  queued(); assert.equal(element.focuses, 0); assert.equal(element.scrolls, 0);
  h.ancestorVisible = true; h.render(props); h.flushFrames();
  h.render({ ...props, shot: { ...props.shot, revision: 2 }, versions: [...props.versions] }); h.flushFrames();
  assert.equal(element.focuses, 0);
  h.render({ ...props, highlightedVersionId: null });
  h.render(props); h.flushFrames(); assert.equal(element.focuses, 1); assert.equal(element.scrolls, 1);
});

test('Inspector never schedules hidden focus, and an unmounted pending callback is inert', () => {
  const h = createHarness('Inspector.tsx'), props = inspectorProps();
  h.ancestorVisible = false; h.render(props); assert.equal(h.pendingFrames().length, 0);
  h.ancestorVisible = true; h.render({ ...props, tab: 'settings' }); h.render(props);
  const [queued] = h.pendingFrames(), element = h.find('version-card-version-one').props.ref.current;
  h.unmount(); queued(); assert.equal(element.focuses, 0); assert.equal(element.scrolls, 0);
});

test('collapsing Inspector preserves the draft and an already requested save-and-generate continuation', async () => {
  const h = createHarness('Inspector.tsx'), generated: unknown[][] = [];
  let resolveSave: ((value:unknown)=>void)|undefined;
  const props = inspectorProps({ tab: 'settings', highlightedVersionId: null, onSave: () => new Promise(resolve => { resolveSave = resolve; }), onGenerate: (...args: unknown[]) => generated.push(args) });
  h.render(props); h.find('shot-prompt').props.onChange({ target: { value: 'Edited while visible' } }); h.render(props);
  const work = h.find('generate-shot').props.onClick(); assert.ok(resolveSave);
  h.ancestorVisible = false; h.render(props);
  assert.equal(h.find('shot-prompt').props.value, 'Edited while visible');
  resolveSave!({ ...props.shot, prompt: 'Edited while visible', revision: 2 }); await work;
  assert.equal(generated.length, 1); assert.equal((generated[0][0] as {prompt:string}).prompt, 'Edited while visible');
  h.render(props); assert.equal(h.find('shot-prompt').props.value, 'Edited while visible');
});

test('language-only updates preserve the exact media decoder, playback position and source identity', () => {
  const h = createHarness('Nodes.tsx', 'Media');
  const props = { asset: asset('video'), controls: true };
  h.render(props); const element = h.mediaNode().props.ref.current, originalKey = h.mediaNode().props.key;
  element.currentTime = 7.125; element.paused = false;
  const baselineLoads = element.loads, baselinePauses = element.pauses;
  for (const locale of i18nCore.LOCALES) {
    h.locale = locale; h.render(props);
    assert.equal(h.mediaNode().props.ref.current, element); assert.equal(h.mediaNode().props.key, originalKey);
    assert.equal(element.currentTime, 7.125); assert.equal(element.src, props.asset.url); assert.equal(element.paused, false);
    assert.equal(element.loads, baselineLoads); assert.equal(element.pauses, baselinePauses);
  }
});
