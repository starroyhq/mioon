import type {Hook as UiHook,Tree as UiTree,Module as UiModule,Element as UiElement,Props as UiProps} from './helpers/strict-workspace-ui-types.ts';
import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage, translate } from './helpers/i18n.ts';
import * as i18nCore from '../packages/i18n/src/index.ts';
import * as creationI18n from '../apps/web/src/creation-i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as contracts from '@mioon/contracts';
import { activeJob, assetUrl, versionUrl, mediaUrl } from '../apps/web/src/api.ts';
import { LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';
import * as exportSettings from '../apps/web/src/export-settings-state.ts';
import * as sourceRanges from '../apps/web/src/source-range-state.ts';
import * as speedRender from '../packages/contracts/src/timeline-speed-render.ts';
import * as previewPlayback from '../apps/web/src/preview-playback.ts';
import * as speedPreviewModel from '../apps/web/src/speed-preview/speed-preview-model.ts';
import {buildClipSpeedPreviewBinding} from '../apps/web/src/speed-preview/speed-preview-model.ts';
import type {ClipSpeedPreviewBinding} from '../apps/web/src/speed-preview/speed-preview-model.ts';
import type {UseSpeedPreviewMediaResult} from '../apps/web/src/speed-preview/use-speed-preview-media.ts';
import * as speedModel from '../apps/web/src/speed-ui/speed-model.ts';
import type {UseSpeedProcessingResult} from '../apps/web/src/speed-ui/use-speed-processing.ts';
import {timelineProcessingResponseSchemas} from '../packages/contracts/src/timeline-processing.ts';
import {timelinePreviewMediaPath} from '../packages/contracts/src/timeline-preview-media.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import {imageEditSourceIssueDescriptor} from '../apps/web/src/image-generation.ts';
import {generationParameters, providerStatus} from '../apps/web/src/generation-settings.ts';

// Exercise the real component functions with deterministic hook, ref, media,
// and animation-frame boundaries. These tests intentionally do not claim DOM
// or browser playback coverage; browser acceptance covers the integrated UI.
const componentCode = new Map(['workspace-visibility.tsx', 'Nodes.tsx', 'Preview.tsx', 'Inspector.tsx', 'speed-ui/use-speed-processing.ts',
  'speed-preview/use-speed-preview-media.ts'].map(file => [file,
  transformSync(readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', sourcefile: file }).code,
]));
const noop = () => {};
const renderProjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstRenderAssetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secondRenderAssetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function makeElement(src:unknown = null) {
  return {
    src, currentTime: 0, duration: 20, readyState: 1, paused: true, seeking: false, isConnected: true,
    plays: 0, pauses: 0, loads: 0, focuses: 0, scrolls: 0,
    getAttribute(name: string) { return name === 'src' ? this.src : null; },
    setAttribute(name: string, value: unknown) { if (name === 'src') this.src = value; },
    removeAttribute(name: string) { if (name === 'src') this.src = null; },
    async play() { this.paused = false; this.plays++; },
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
const treeText = (node: UiTree): string => Array.isArray(node) ? node.map(treeText).join('') : node && typeof node === 'object' ? treeText(node.props?.children) : node == null || typeof node === 'boolean' ? '' : String(node);
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
  function memoValue(factory: () => unknown, dependencies: readonly unknown[]) {
    const index = cursor++, previous = slots[index];
    if (previous && dependencies.length === previous.dependencies?.length &&
        dependencies.every((value, i) => Object.is(value, previous.dependencies![i]))) return previous.value;
    const value = factory();
    slots[index] = {dependencies, value};
    return value;
  }
  const react = {
    createElement(type: string, props: Partial<UiProps>|null, ...children: unknown[]) { return { type, props: { ...props, children: children.length === 1 ? children[0] : children } }; },
    createContext(value: unknown) { return { defaultValue: value, Provider: 'VisibilityProvider' }; },
    useContext(context: { defaultValue: unknown; }) { return h.ancestorVisible ?? context.defaultValue; },
    useRef(value: unknown) { const index = cursor++; return slots[index] ||= { current: value }; },
    useState(value: () => unknown) { const index = cursor++; slots[index] ||= { value: typeof value === 'function' ? value() : value }; return [slots[index].value, (next: (arg0: unknown) => unknown) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useMemo: memoValue,
    useCallback: (callback: unknown, dependencies: readonly unknown[]) => memoValue(() => callback, dependencies),
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
    './local-shot-text-state.ts': { useLocalShotText: ({ context }: {context:{connected:boolean}}) => {
      if (h.shotTextState) return { state: h.shotTextState, controller: {
        setContext() {}, getState: () => h.shotTextState, blocksLegacy: () => false, canPrepare: () => Boolean(h.canSaveShotText),
      } };
      assert.equal(context.connected, false, 'A standalone Inspector without an injected shot-text context has no connected persistence authority');
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
    './AspectFrameControls.tsx': { AspectFrameFeedback: 'AspectFrameFeedback', AspectFrameMenu: 'AspectFrameMenu', AspectFrameSuggestion: 'AspectFrameSuggestion' },
    './preview-playback.ts': previewPlayback,
    './speed-model.ts': speedModel,
    './speed-preview-model.ts': speedPreviewModel,
    '../../../../packages/contracts/src/timeline-processing.ts': {timelineProcessingResponseSchemas},
    '../../../packages/contracts/src/timeline-speed-render.ts': speedRender,
    './UiPreferencesProvider.tsx': {useUiPreferences:()=>({preferences:DEFAULT_UI_PREFERENCES})},
    './image-generation.ts': {imageEditSourceIssueDescriptor},
    './source-range-state.ts': sourceRanges,
    './export-settings-state.ts': exportSettings,
    '@xyflow/react': { Handle: 'Handle', Position: { Left: 'left', Right: 'right' } },
    './TimelineAudioPreview.tsx': { default: 'TimelineAudioPreview', __esModule: true },
    './ClipTransformBox.tsx': { default: 'ClipTransformBox', __esModule: true },
    './icons.tsx': { default: 'Icon', __esModule: true },
    './api.ts': { assetUrl, versionUrl, activeJob, mediaUrl, statusText: (value: unknown) => value, jobStatusText: (value: unknown) => value, outputReviewRequired: () => false },
    './Timeline.tsx': { assetKind: (asset: { mimeType: string; }) => asset?.mimeType?.split('/')[0], framesLabel: String, dragAsset: noop },
    './reference-connections.ts': { referenceForShot: () => null },
    './generation-settings.ts': { generationParameters, providerStatus, wanGenerationCapabilities: () => null, seedanceGenerationCapabilities: () => null, generationVideoInput: () => undefined, generationSelection: () => ({ provider: { id: 'mock', mock: true }, model: 'mock', capabilities: {}, inputMode: 'text', scenario: 'success' }), generationInputIssue: () => '', providerAvailabilityIssue: () => '', inputModeLabel: String, inputModeDescriptor: String, generationInputIssueDescriptor: () => '', providerAvailabilityDescriptor: () => '' },
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
      if (id === './project-media-read-gate.tsx') return {useProjectMediaReadGate: () => null, mediaReadIdentity: (asset: unknown, version?: {assetId?: string; projectId?: string}) => version ? {id: version.assetId, projectId: version.projectId} : asset, ProjectMediaImage: 'img'};
      if (id === './project-file/MediaStatus.tsx') return {MediaStatusBadge: 'MediaStatusBadge', MediaStatusNote: 'MediaStatusNote'};
      if (id === '../speed-ui/use-speed-processing.ts') return load('speed-ui/use-speed-processing.ts');
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
  const [exportKey, memberKey] = exportName.split('.');
  const exports = load(file);
  const Component = memberKey ? (exports[exportKey] as unknown as UiModule['exports'])[memberKey] : exports[exportKey];
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
const asset = (kind = 'video', id = firstRenderAssetId) => ({ id, projectId: renderProjectId, url: '/media/asset-one', mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}`, name: 'Fixture' });
const previewProps = <Patch extends Record<string,unknown>>(patch: Patch) => ({ visible: true, kind: 'source', asset: asset(), playhead: 0, onSeek: noop, ...patch });
const inspectorProps = (patch?: Record<string,unknown>) => ({
  shot: { id: 'shot-one', title: 'Fixture shot', prompt: 'Original', revision: 1, orderIndex: 0 },
  project: { id: 'project-one' }, assets: [], versions: [{ id: 'version-one', shotId: 'shot-one', number: 1, createdAt: '2026-10-09T12:00:00Z' }],
  jobs: [], providers: [], busy: {}, tab: 'versions', highlightedVersionId: 'version-one', onDirtyChange: noop,
  ...patch,
});

test('speed preview ignores ready processing rows from a previous timeline revision', async t => {
  const h = createHarness('speed-ui/use-speed-processing.ts', 'useSpeedProcessing');
  t.after(() => h.unmount());
  const requests: ((value: unknown) => void)[] = [];
  const clip = {id: secondRenderAssetId, timing: {profile: 'timeline-speed-v1', view: {direction: 'forward'},
    basis: {speed: {kind: 'constant'}}, interpolation: 'optical'}};
  const timeline = {capabilities: {speed: true}, clips: [clip], revision: 1};
  const props = {projectId: renderProjectId, online: true, authenticated: true,
    rpc: () => new Promise(resolve => requests.push(resolve))};
  const render = (revision: number, passive = true) =>
    h.render({...props, timeline: {...timeline, revision}}, {passive}) as unknown as UseSpeedProcessingResult;

  render(1);
  assert.equal(requests.length, 1);
  const old = {taskId: firstRenderAssetId, clipId: clip.id, kind: 'optical', status: 'ready'};
  requests[0]!({items: [old]});
  await Promise.resolve();
  assert.deepEqual(render(1).previewItems, [old]);

  const changed = render(2, false);
  assert.deepEqual(changed.items, [old]);
  assert.deepEqual(changed.previewItems, []);
  h.flushPassive();
  assert.equal(requests.length, 2);
  const next = {...old, taskId: renderProjectId, status: 'queued'};
  requests[1]!({items: [next]});
  await Promise.resolve();
  assert.deepEqual(render(2).previewItems, [next]);
});

test('speed preview holds the off proxy through the optical lookup and fences the saved revision', async t => {
  const h = createHarness('speed-preview/use-speed-preview-media.ts', 'useSpeedPreviewMedia');
  t.after(() => h.unmount());
  const requests: ((value: unknown) => void)[] = [];
  const projectId = renderProjectId, clipId = secondRenderAssetId, assetId = firstRenderAssetId;
  const clip = {id: clipId, timing: {profile: 'timeline-speed-v1', interpolation: 'optical'}};
  const props = {projectId, clip, asset: asset(), active: true, online: true, authenticated: true,
    rpc: () => new Promise(resolve => requests.push(resolve))};
  const readyOptical = {taskId: assetId, clipId, kind: 'optical', status: 'ready'};
  const proxy = (taskId: string) => ({mode: 'proxy', status: 'ready', durationFrames: 90,
    url: timelinePreviewMediaPath({projectId, assetId, clipId, taskId, digest: 'a'.repeat(64)})});
  const off = proxy(clipId), optical = proxy(assetId);
  const render = (revision: number, ready: boolean) => h.render({...props,
    timeline: {revision, capabilities: {speed: true}}, processingItems: ready ? [readyOptical] : [],
  }) as unknown as UseSpeedPreviewMediaResult;
  render(1, false);
  requests[0]!(off);
  await Promise.resolve();
  assert.deepEqual(render(1, true).media, off);
  requests[1]!({mode: 'proxy', status: 'queued', taskId: assetId});
  await Promise.resolve();
  const pending = render(1, true);
  assert.deepEqual(pending.media, off);
  assert.equal(pending.awaitingOpticalProxy, true);
  pending.refresh();
  requests[2]!(optical);
  await Promise.resolve();
  assert.deepEqual(render(1, true).media, optical);
  assert.equal(render(2, false).media, null);
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
    assert.equal(element.src, mediaUrl(props.asset.projectId, props.asset.id)); assert.equal(element.loads, 0);
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
    assert.equal(element.paused, true); assert.equal(element.loads, 0); assert.equal(element.src, mediaUrl(props.asset.projectId, props.asset.id));
    h.unmount(); assert.equal(element.loads, 1); assert.equal(element.src, null);
  });
}

test('retimed clip preview never binds the original video or an old timeline render', () => {
  const h = createHarness('Preview.tsx');
  const timing = {profile: 'timeline-freeze-v1', sourceFrame: 0, sourceVersionId: null, sourceSha256: 'a'.repeat(64)};
  const clip = {id: 'clip-one', sourceInFrame: 0, startFrame: 0, durationFrames: 60, timing};
  const timeline = {id: 'timeline-one', projectId: renderProjectId, fps: 30, width: 1920, height: 1080,
    revision: 2, durationFrames: 60, clips: [clip]};
  const job = {id: 'render-one', projectId: renderProjectId, assetId: firstRenderAssetId, status: 'succeeded',
    url: '/render', timelineRevision: 1};
  for (const kind of ['source', 'timeline']) {
    h.render(previewProps({kind, clip, timeline, job}));
    assert.equal(h.mediaNode(), undefined);
    assert.ok(h.nodes().some(node => node.props['data-error-code'] === 'SPEED_RENDER_NOT_READY'));
  }
  h.render(previewProps({kind: 'source', clip: null, timeline, job}));
  assert.ok(h.mediaNode(), 'standalone source playback has its own explicit source coordinates');
  const currentRender = {...job, timelineRevision: timeline.revision, snapshot: {timeline}};
  h.render(previewProps({kind: 'timeline', clip, timeline, job: currentRender}));
  assert.equal(h.mediaNode(), undefined, 'matching revision alone is not a speed-render result');
  h.render(previewProps({kind: 'timeline', clip, timeline, job: {...currentRender,
    snapshot: {...currentRender.snapshot, speedExport: {profileId: 'timeline-speed-export-v1'}}}}));
  assert.ok(h.mediaNode(), 'a current speed-render result can be played');
});

for (const kind of ['source', 'timeline'] as const) {
  test(`${kind} Preview cannot publish late playback or native-seek events while hidden`, () => {
    const h = createHarness('Preview.tsx'), seeks: unknown[] = [], props = previewProps({
      kind, onSeek: (value: unknown) => seeks.push(value), timeline: { revision: 1 },
      clip: { id: 'clip-one', sourceInFrame: 0, startFrame: 0, durationFrames: 300 },
      job: { id: 'render-one', projectId: renderProjectId, assetId: firstRenderAssetId, status: 'succeeded', url: '/render', timelineRevision: 1 },
    });
    h.render(props); const node = h.mediaNode(), element = node.props.ref.current;
    if (kind === 'timeline') assert.equal(element.src, mediaUrl(renderProjectId, firstRenderAssetId));
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

test('0.1×, 0.25× and 0.5× preview seek on heard PCM sample boundaries', async () => {
  const samplesPerFrame = 1600;
  const maxSampleError = 2 * samplesPerFrame;
  for (const denominator of [10, 4, 2]) {
    const h = createHarness('Preview.tsx');
    const startFrame = 300, sourceInFrame = 40, durationFrames = 120 * denominator;
    const clip = {id: 'clip-one', trackId: 'track-one', startFrame, sourceInFrame, durationFrames,
      timing: {profile: 'timeline-speed-v1', basis: {profile: 'timeline-speed-v1',
        sourceFps: {fpsNumerator: 30, fpsDenominator: 1}, outputFps: {fpsNumerator: 30, fpsDenominator: 1},
        sourceRange: {start: {kind: 'rational', numerator: '40', denominator: '1'}, end: {kind: 'rational', numerator: '160', denominator: '1'}},
        speed: {kind: 'constant', rate: {numerator: 1, denominator}}},
        view: {direction: 'forward', loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}},
        outputWindow: {fromFrame: 0, toFrame: durationFrames}, pitchShift: true, interpolation: 'off'}} as const;
    const timeline = {id: 'timeline', revision: 1, fps: 30, durationFrames: startFrame + durationFrames,
      capabilities: {speed: true}};
    const playhead = startFrame + 30 * denominator;
    let sample = playhead * samplesPerFrame;
    const speedPreview = buildClipSpeedPreviewBinding({timeline, clip, asset: asset(), sourceUrl: '/preview-source',
      media: null, fps: 30, processingItems: [], t: createI18nTestContext('zh-Hans').t,
      onPlaybackStateChange: async state => state.playing ? () => sample : undefined});
    assert.ok(speedPreview?.frameDrivenPlayback, `1/${denominator}× uses the shared audio clock`);
    h.render(previewProps({timeline, clip, speedPreview, playhead}));
    const element = h.mediaNode().props.ref.current;
    const controls = h.nodes().find(node => node.type === 'PreviewPlaybackControls')?.props.customPlayback as
      {toggle(): void;isPlaying(): boolean};
    assert.ok(controls);
    controls.toggle();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controls.isPlaying(), true);
    assert.equal(element.paused, true);
    for (let frame = 1; frame <= 4; frame++) {
      const transition = (playhead + frame * denominator) * samplesPerFrame;
      sample = transition - 1;
      h.flushFrames();
      assert.equal(Math.floor(element.currentTime * 30), sourceInFrame + 30 + frame - 1);
      sample = transition + samplesPerFrame / 2;
      h.flushFrames();
      const displayed = Math.floor(element.currentTime * 30);
      const expected = sourceInFrame + Math.floor((sample / samplesPerFrame - startFrame) / denominator);
      assert.equal(displayed, expected, 'The source frame matches the PCM position of the same animation tick');
      assert.ok(Math.abs(sample - (startFrame + (displayed - sourceInFrame) * denominator) * samplesPerFrame) <= maxSampleError,
        'Capture the transition within two output frames (3200 samples at 48 kHz)');
    }
    h.unmount();
  }
});

test('replaced Preview sources reject old callbacks and Strict Mode disposal restores the current source', () => {
  const h = createHarness('Preview.tsx'), seeks: unknown[] = [], props = previewProps({ kind: 'timeline', timeline: { revision: 1 }, job: { id: 'render-one', projectId: renderProjectId, assetId: firstRenderAssetId, status: 'succeeded', url: '/first', timelineRevision: 1 }, onSeek: (value: unknown) => seeks.push(value) });
  h.render(props); const old = h.mediaNode(), original = old.props.ref.current;
  h.render({ ...props, job: { ...props.job, id: 'render-two', assetId: secondRenderAssetId, url: '/second' } });
  const current = h.mediaNode().props.ref.current;
  assert.notEqual(original, current); assert.equal(original.loads, 1); assert.equal(original.src, null);
  original.currentTime = 4; original.paused = false;
  old.props.onTimeUpdate({ currentTarget: original }); old.props.onSeeked({ currentTarget: original }); old.props.onPlay({ currentTarget: original });
  assert.deepEqual(seeks, []); assert.equal(original.paused, true);
  h.replayEffects(); assert.equal(current.src, mediaUrl(renderProjectId, secondRenderAssetId)); assert.equal(current.paused, true);
});

for (const playing of [true, false]) {
  test(`the optical proxy takes over the same output frame while ${playing ? 'playing' : 'paused'}`, async t => {
    const h = createHarness('Preview.tsx');
    t.after(() => h.unmount());
    const clip = {id: 'optical-clip', startFrame: 12, durationFrames: 300, sourceInFrame: 0};
    const timeline = {id: 'timeline', revision: 1, fps: 30, durationFrames: 312};
    const audio: boolean[] = [];
    const seek = (frame: number) => (frame - clip.startFrame) / timeline.fps;
    const off: ClipSpeedPreviewBinding = {
      mode: 'proxy-ready', mediaUrl: '/off-proxy', mediaKey: 'off',
      playbackRate: 1, muteVideo: true, frameDrivenPlayback: false, silent: false,
      clipStartFrame: clip.startFrame, clipDurationFrames: clip.durationFrames, fps: timeline.fps, overlay: null,
      outputFrameToMediaSeconds: seek,
      mediaSecondsToOutputFrame: seconds => clip.startFrame + Math.round(seconds * timeline.fps),
      onPlaybackStateChange: ({playing}) => {audio.push(playing);},
    };
    const optical = {...off, mediaUrl: '/optical-proxy', mediaKey: 'optical'};
    const props = previewProps({timeline, clip, speedPreview: off, playhead: 50});
    h.render(props);
    const current = () => h.find('source-preview-video')!.props.ref.current as unknown as ReturnType<typeof makeElement>;
    const old = current();
    old.readyState = 4;
    if (playing) {
      const controls = h.nodes().find(node => node.type === 'PreviewPlaybackControls')!.props.customPlayback as {toggle(): void};
      controls.toggle();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(old.paused, false);
    }
    h.render({...props, speedPreview: optical});
    const candidate = h.nodes().find(node => node.props.className === 'preview-proxy-candidate')!
      .props.ref.current as unknown as ReturnType<typeof makeElement>;
    candidate.readyState = 1;
    h.flushFrames();
    const targetFrame = playing ? 53 : 50;
    assert.ok(Math.abs(candidate.currentTime - seek(targetFrame)) < 0.00001);
    assert.equal(current(), old, 'the old proxy stays visible while the candidate decodes');
    assert.equal(old.paused, !playing);
    old.currentTime = seek(targetFrame) + 0.000002;
    candidate.readyState = 4;
    candidate.seeking = true;
    h.flushFrames();
    assert.equal(current(), old, 'do not promote while the candidate seek is still pending');
    candidate.seeking = false;
    h.flushFrames();
    h.render({...props, speedPreview: optical});
    assert.equal(current(), candidate, 'reuse the decoded candidate element');
    assert.equal(candidate.paused, !playing);
    assert.equal(candidate.plays, playing ? 1 : 0);
    assert.equal(candidate.src, '/optical-proxy');
    assert.ok(Math.abs(candidate.currentTime - seek(targetFrame)) < 0.00001, 'replace at the same output frame');
    assert.equal(old.src, null);
    assert.deepEqual(audio, playing ? [true] : [], 'handoff neither stops nor starts another PCM session');
  });
}

test('an old render seeks and steps within its frozen duration, in either direction of the duration change', () => {
  const h = createHarness('Preview.tsx'), seeks: unknown[] = [];
  const frozen = { id: 'timeline', projectId: renderProjectId, revision: 2, fps: 30, width: 1280, height: 720, durationFrames: 300 };
  const live = { ...frozen, revision: 3, width: 720, height: 1280, durationFrames: 90 };
  const job = { id: 'old-render', projectId: renderProjectId, assetId: firstRenderAssetId, status: 'succeeded', purpose: 'preview', mode: 'timeline', timelineRevision: 2, snapshot: { timeline: frozen } };
  const props = previewProps({ kind: 'timeline', timeline: live, job, playhead: 150, onSeek: (frame: number) => seeks.push(frame) });
  const controls = () => h.nodes().find(node => node.type === 'PreviewPlaybackControls')!.props;
  const step = (delta: number) => (controls().onStep as (delta: number) => void)(delta);
  h.render(props);
  assert.equal(h.mediaNode().props.ref.current.currentTime, 5);
  assert.equal(controls().position, 150); assert.equal(controls().duration, 300);
  step(1); assert.deepEqual(seeks, [151]);
  const media = h.mediaNode().props.ref.current;
  media.duration = 10; media.currentTime = 9.9;
  h.mediaNode().props.onSeeked({currentTarget: media});
  assert.deepEqual(seeks, [151, 297]);

  h.render({ ...props, timeline: { ...live, durationFrames: 600 }, playhead: 500 });
  assert.equal(controls().position, 300); assert.equal(controls().duration, 300);
  assert.equal(media.currentTime, 9.999);
  step(-1); assert.deepEqual(seeks, [151, 297, 299]);
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
  for (const patch of [{ jobs: [{ id: 'unknown', shotId: 'shot-one', status: 'submission_unknown' }] }] as const) {
    const h = createHarness('Inspector.tsx'); h.render(inspectorProps({ tab: 'settings', onCancelJob: () => assert.fail('Must not cancel'), ...patch }));
    assert.equal(h.find('cancel-generation'), undefined); assert.equal(h.find('inspector-generation-progress'), undefined); h.unmount();
  }
});

test('shot node and Inspector replace stalled video progress with a short Keychain status', () => {
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
    const node = createHarness('Nodes.tsx', 'nodeTypes.shot'), inspector = createHarness('Inspector.tsx');
    node.locale = inspector.locale = locale;
    const job = {id: 'running-one', shotId: 'shot-one', status: 'running', progress: 0, providerJobId: 'provider-task'};
    const waiting = {...job, phase: 'connection_retrying', error: {code: 'VIDEO_CREDENTIAL_UNAVAILABLE', message: 'UNTRUSTED_PRIVATE_MESSAGE', diagnostic: {kind: 'video_credential', cause: 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE', recovery: 'automatic'}}};
    const data = {record: {id: job.shotId, title: 'Shot'}, index: 0, job: waiting, generationUnavailableReason: 'Unavailable', onInspect: noop, onGenerate: () => assert.fail('Must not generate')};
    const nodeView = node.render({data});
    inspector.render(inspectorProps({tab: 'settings', jobs: [waiting], highlightedVersionId: null}));
    const guidance = translate(locale, 'tasks.error.videoSecretStore');
    const continuation = translate(locale, 'tasks.error.videoKeychainContinues');
    const status = translate(locale, 'tasks.status.videoSecretStoreWaiting');
    assert.equal(node.find(`shot-connection-${job.shotId}`), undefined);
    const panel = inspector.find('inspector-generation-progress');
    assert.equal(treeNodes(panel).some(element => element.type === 'p'), false, 'Waiting on Keychain needs no secondary paragraph');
    for (const view of [nodeView, panel]) {
      assert.equal(treeText(view).split(status).length - 1, 1);
      assert.ok(!treeText(view).includes(guidance));
      assert.ok(!treeText(view).includes(continuation));
      assert.ok(!treeText(view).includes(translate(locale, 'tasks.error.videoOriginalTaskRetained')));
      assert.doesNotMatch(treeText(view), /0%|UNTRUSTED_PRIVATE_MESSAGE/);
      assert.equal(treeNodes(view).some(element => element.props.role === 'progressbar'), false);
    }
    assert.equal(node.nodes().find(element => element.props.className === 'node-generate nodrag')?.props.disabled, true);
    assert.equal(inspector.find('generate-shot').props.disabled, true);
    const configured: string[] = [];
    const configuredNode = node.render({data: {...data, configureGeneration: () => configured.push('node')}});
    inspector.render(inspectorProps({tab: 'settings', jobs: [waiting], highlightedVersionId: null, configureGeneration: () => configured.push('inspector')}));
    assert.ok(treeText(configuredNode).includes(status));
    assert.ok(treeText(inspector.find('inspector-generation-progress')).includes(status));
    const nodeConfigure = node.find(`shot-configure-generation-${job.shotId}`)!;
    const inspectorConfigure = inspector.find('video-generation-configure')!;
    for (const button of [nodeConfigure, inspectorConfigure]) {
      assert.ok(treeText(button).includes(translate(locale, 'generation.services.openSettings')) || button.props['aria-label'] === translate(locale, 'generation.services.openSettings'));
      button.props.onClick();
    }
    assert.deepEqual(configured, ['node', 'inspector']);
    assert.equal(inspector.find('generate-shot').props.disabled, true);
    const polling = {...job, progress: 45};
    node.render({data: {...data, job: polling, generationUnavailableReason: null}});
    inspector.render(inspectorProps({tab: 'settings', jobs: [polling], highlightedVersionId: null}));
    for (const harness of [node, inspector]) assert.ok(harness.nodes().some(element => element.props.role === 'progressbar' && element.props['aria-valuenow'] === 45));
    const pollingPanel = inspector.find('inspector-generation-progress');
    assert.equal(treeNodes(pollingPanel).some(element => element.type === 'p'), false, 'Normal progress needs no explanation');
    const deleted = {...job, phase: 'connection_required', error: {code: 'VIDEO_CREDENTIAL_UNAVAILABLE', diagnostic: {kind: 'video_credential', cause: 'VIDEO_SETTINGS_DELETED', recovery: 'user_action'}}};
    inspector.render(inspectorProps({tab: 'settings', jobs: [deleted], highlightedVersionId: null}));
    const blocked = inspector.find('inspector-generation-progress');
    assert.ok(treeText(blocked).includes(translate(locale, 'tasks.error.videoConnectionDeleted')));
    assert.ok(treeText(blocked).includes(translate(locale, 'tasks.error.videoResultAtProvider')));
    node.unmount(); inspector.unmount();
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
  const props = inspectorProps({ tab: 'settings', highlightedVersionId: null, shotTextContext: { scope: 'text', connected: true } });
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

test('asset previews show a playback error only for the current failed video and clear it on recovery', () => {
  const h = createHarness('Nodes.tsx', 'Media');
  const props = {asset: {...asset(), referenceRevision: 1}, showPlaybackError: true, onError: noop, onLoadedData: noop};
  const reportError = (node: UiElement, video = node.props.ref.current) => {
    const element = Object.assign(video, {error: {code: 4}});
    (node.props.onError as (event: {currentTarget: typeof element}) => void)({currentTarget: element});
  };
  const message = () => h.nodes().find(node => node.props['data-testid'] === 'asset-preview-unavailable');
  h.render(props);
  const original = h.mediaNode();
  const originalVideo = original.props.ref.current;
  assert.equal(message(), undefined);
  reportError(original);
  h.render(props);
  assert.equal(treeText(message()), '无法播放此媒体');
  assert.equal(h.mediaNode().props.ref.current, originalVideo);

  const rebound = {...props, asset: {...props.asset, referenceRevision: 2}};
  h.render(rebound);
  const updated = h.mediaNode();
  assert.notEqual(updated.props.ref.current, originalVideo);
  reportError(original, originalVideo);
  h.render(rebound);
  assert.equal(message(), undefined);
  reportError(updated);
  h.render(rebound);
  assert.ok(message());
  (updated.props.onLoadedData as (event: {currentTarget: unknown}) => void)({currentTarget: updated.props.ref.current});
  h.render(rebound);
  assert.equal(message(), undefined);
  h.unmount();
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
    assert.equal(element.currentTime, 7.125); assert.equal(element.src, mediaUrl(props.asset.projectId, props.asset.id)); assert.equal(element.paused, false);
    assert.equal(element.loads, baselineLoads); assert.equal(element.pauses, baselinePauses);
  }
});
