import type {RootModule,RootControlledModules} from './helpers/strict-root-ui-types.ts';
import type {RootHook} from './helpers/strict-root-ui-types.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { appendableShots, refreshSkipSentence, shotSyncErrorMessage, shotTimelineStatuses, sourceRefreshSkips, videoLaneLabel } from '../apps/web/src/timeline-source-freshness.ts';
import { touchesLockedTrack } from '../apps/web/src/timeline-track-locks.ts';
import * as preflightState from '../apps/web/src/export-preflight-state.ts';
import * as deliveryState from '../apps/web/src/export-delivery-state.ts';
import * as settingsState from '../apps/web/src/export-settings-state.ts';
import * as rangeState from '../apps/web/src/export-range-state.ts';
import * as removal from '../apps/web/src/timeline-removal.ts';
import { i18nTestModule, translate } from './helpers/i18n.ts';
import { lenientFunction } from './helpers/eval-source.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const shots = [
  { id: 's1', title: '开场', selectedVersionId: 'v2' },
  { id: 's2', title: '海面', selectedVersionId: 'w1' },
  { id: 's3', title: '夕阳', selectedVersionId: 'x1' },
  { id: 's4', title: '远景', selectedVersionId: null },
];
const versions = [{ id: 'v1', assetId: 'A1', shotId: 's1', number: 1 }, { id: 'v2', assetId: 'A2', shotId: 's1', number: 2 }, { id: 'w1', assetId: 'B1', shotId: 's2', number: 1 }, { id: 'x1', assetId: 'C1', shotId: 's3', number: 3 }];
const tracks = [{ id: 'T2', kind: 'video', name: 'Video 2', orderIndex: 1 }, { id: 'T1', kind: 'video', name: 'Video 1', orderIndex: 0 }, { id: 'A', kind: 'audio', name: 'Audio 1', orderIndex: 0 }, { id: 'T3', kind: 'video', name: '片尾字卡', orderIndex: 2 }];
// s1 is placed twice (one clip still on V1), s2 once through explicit provenance, and one clip is a plain import.
const clips = [
  { id: 'c-current', assetId: 'A2', trackId: 'T1', startFrame: 0 },
  { id: 'c-stale', assetId: 'A1', trackId: 'T2', startFrame: 300 },
  { id: 'c-pinned', assetId: 'B1', trackId: 'T1', startFrame: 120, versionId: 'w1', shotId: 's2' },
  { id: 'c-import', assetId: 'Z9', trackId: 'T1', startFrame: 400 },
];

test('shot statuses list every placement with stale clips first, and appendable shots keep storyboard order', () => {
  const statuses = shotTimelineStatuses(clips, shots, versions);
  assert.deepEqual([...statuses.keys()], ['s1', 's2']);
  assert.equal((statuses.get('s1'))!.stale, true); assert.equal((statuses.get('s2'))!.stale, false);
  assert.deepEqual((statuses.get('s1'))!.placements.map(item => [item.clipId, item.trackId, item.stale, item.versionNumber]), [['c-stale', 'T2', true, 1], ['c-current', 'T1', false, 2]]);
  assert.deepEqual(appendableShots(shots, statuses).map(shot => shot.id), ['s3'], 'placed shots and shots without a selected version are not appended');
  assert.deepEqual(appendableShots([...shots].reverse(), new Map()).map(shot => shot.id), ['s3', 's2', 's1']);
  assert.equal(shotTimelineStatuses([], shots, versions).size, 0);
});

test('lane labels match the timeline header names', () => {
  assert.equal(videoLaneLabel(tracks, 'T1'), 'V1 画面');
  assert.equal(videoLaneLabel(tracks, 'T2', 'en'), 'V2 Overlay');
  assert.equal(videoLaneLabel(tracks, 'T3'), 'V3 片尾字卡');
  assert.equal(videoLaneLabel(tracks, 'A'), null); assert.equal(videoLaneLabel(tracks, null), null);
});

test('skip reasons read as sentences in each language and never understate a shortfall', () => {
  const context = { clips: [{ id: 'c-import', name: 'import.mp4' }], shots, versions, fps: 30 };
  assert.equal(refreshSkipSentence({ clipId: 'c-stale', reason: 'SOURCE_TOO_SHORT', shotId: 's1', fromVersionId: 'v1', toVersionId: 'v2', shortByFrames: 36 }, context), '开场 · V2 比原片段短 1.2 秒，无法覆盖当前区间');
  assert.equal(refreshSkipSentence({ clipId: 'c-stale', reason: 'SOURCE_TOO_SHORT', shotId: 's1', toVersionId: 'v2', shortByFrames: 1 }, context, 'en'), '开场 · V2 is 0.1 s shorter than the clip and cannot cover its current range');
  assert.equal(refreshSkipSentence({ clipId: 'c', reason: 'NO_SELECTION', shotId: 's4' }, context), '远景 还没有选中版本');
  assert.equal(refreshSkipSentence({ clipId: 'c', reason: 'UP_TO_DATE', shotId: 's2' }, context, 'ja'), '海面 はすでに選択中のバージョンです');
  assert.equal(refreshSkipSentence({ clipId: 'c-import', reason: 'NOT_GENERATED' }, context, 'zh-Hant'), 'import.mp4 不是畫板產生的素材');
  assert.equal(refreshSkipSentence({ clipId: 'gone', reason: 'NO_SELECTION', shotId: 'gone' }, context), `${translate('zh-Hans', 'timeline.source.unnamedShot')} 还没有选中版本`);
});

test('refusal details are filtered before display and known codes get their own wording', () => {
  assert.deepEqual(sourceRefreshSkips([{ clipId: 'a', reason: 'SOURCE_TOO_SHORT', shortByFrames: 3 }, { clipId: 1, reason: 'NO_SELECTION' }, { clipId: 'b', reason: 'INVENTED' }, null, 'x']), [{ clipId: 'a', reason: 'SOURCE_TOO_SHORT', shortByFrames: 3 }]);
  assert.deepEqual((sourceRefreshSkips({ skipped: [] }) as unknown), []);
  assert.equal(sourceRefreshSkips(Array.from({ length: 150 }, (_, index) => ({ clipId: `c${index}`, reason: 'UP_TO_DATE' }))).length, 100);
  const key = (code: string) => shotSyncErrorMessage({ code })?.key ?? null;
  assert.deepEqual(['NOTHING_TO_REFRESH', 'NOTHING_TO_APPEND', 'TIMELINE_LIMIT', 'TRACK_NOT_FOUND', 'CLIP_NOT_FOUND', 'ASSET_HASH_MISMATCH', 'RESTORE_OPERATION_UNAVAILABLE'].map(key),
    ['timeline.sync.error.nothingToRefresh', 'timeline.sync.error.nothingToAppend', 'timeline.sync.error.limit', 'timeline.sync.error.noVideoTrack', 'timeline.sync.error.changed', 'timeline.sync.error.changed', 'timeline.sync.restoredUnavailable']);
  assert.equal(key('REVISION_CONFLICT'), null, 'shared codes keep the shell wording'); assert.equal(shotSyncErrorMessage(null), null);
  assert.equal(translate('en', 'timeline.sync.append.action', { count: 1 }), 'Append to timeline (1 shot)');
  assert.equal(translate('zh-Hant', 'timeline.sync.append.action', { count: 3 }), '附加到時間軸（3 個鏡頭）');
});

test('track locks cover the clips a refresh touches and the lane an append writes', () => {
  const timeline = { clips, tracks };
  assert.equal(touchesLockedTrack('timeline.clip.refreshSources', { clipIds: ['c-current', 'c-stale'] }, timeline, new Set(['T2'])), true);
  assert.equal(touchesLockedTrack('timeline.clip.refreshSources', { clipIds: ['c-current'] }, timeline, new Set(['T2'])), false);
  assert.equal(touchesLockedTrack('timeline.shots.append', {}, timeline, new Set(['T1'])), true, 'the lowest video track receives appended shots');
  assert.equal(touchesLockedTrack('timeline.shots.append', {}, timeline, new Set(['T2', 'A'])), false);
});

// Minimal element trees: components run with a one-pass useState so handlers can be exercised without a DOM.
const element = (type: string, props: Record<string,unknown>, ...children: unknown[]) => ({ type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } });
const nodes = (tree: RootTree) : RootNode[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = (tree: RootTree) : string => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const byTestId = (tree: string|number|boolean|RootNode|RootTree[]|null|undefined, id: unknown) => nodes(tree).find(node => node.props?.['data-testid'] === id);
const icons = { AlertTriangle: 'AlertTriangle', ChevronDown: 'ChevronDown', ChevronUp: 'ChevronUp', CornerUpLeft: 'CornerUpLeft', LocateFixed: 'LocateFixed', RefreshCw: 'RefreshCw', X: 'X' };
function load<File extends 'TimelineSourceBanner.tsx'|'TimelineExportPreflight.tsx'>(file:File, dependencies:Record<string,unknown>, react:unknown) {
  const module = { exports: {} as RootModule<RootControlledModules[File]> }, code = transformSync(read(file), { loader: 'tsx', format: 'cjs' }).code;
  lenientFunction('module', 'exports', 'require', code)(module, module.exports, (name: string) => {
    if (name === 'react') return react;
    if (name.endsWith('.css')) return {};
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected dependency ${name}`);
  });
  return module.exports.default;
}
function loadBanner(locale: import('../packages/i18n/src/index.ts').Locale|undefined = 'zh-Hans') {
  const states: RootHook[] = []; let cursor = 0;
  const react = { createElement: element, Fragment: 'Fragment', useState: (initial: unknown) => { const index = cursor++; if (!(index in states)) states[index] = initial as RootHook; return [states[index], (value: RootHook|((arg0: RootHook) => RootHook)) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } };
  (react as typeof react & {default?: unknown}).default = react;
  const Banner = load('TimelineSourceBanner.tsx', { './i18n/I18nProvider.tsx': i18nTestModule(locale), '@mioon/ui/components/workbench-controls': { WorkbenchButton: 'WorkbenchButton' }, '@mioon/ui/components/workbench-icons': icons }, ((react) as unknown as Parameters<typeof load>[2]));
  return (props: unknown) => { cursor = 0; return Banner(props as Parameters<typeof Banner>[0]); };
}

test('the stale banner selects each outdated clip in turn, updates them all and stays hidden until the set changes', () => {
  const render = loadBanner(), calls: unknown[] = [];
  const props = { staleClipIds: ['c1', 'c2'], outcome: null, describeSkip: () => '', onRefreshAll: (ids: unknown) => calls.push(['refresh', ids]), onSelectClip: (id: unknown) => calls.push(['select', id]), onUndo: () => calls.push(['undo']), onDismissOutcome: () => calls.push(['dismiss']) };
  const tree = render(props);
  assert.match(text(tree), /2 个片段的来源已有新版本/); assert.match(text(tree), /更新后保留入点、时长、音量和淡入淡出/);
  for (let index = 0; index < 3; index++) (byTestId(render(props), 'timeline-source-view'))!.props.onClick();
  (byTestId(render(props), 'timeline-source-refresh-all'))!.props.onClick();
  assert.deepEqual(calls, [['select', 'c1'], ['select', 'c2'], ['select', 'c1'], ['refresh', ['c1', 'c2']]]);
  (byTestId(render(props), 'timeline-source-dismiss'))!.props.onClick();
  assert.equal(render(props), null);
  assert.ok(byTestId(render({ ...props, staleClipIds: ['c1', 'c2', 'c3'] }), 'timeline-source-banner'), 'a newly outdated clip brings the banner back');
  const blocked = render({ ...props, staleClipIds: ['c9'], disabledReason: translate('zh-Hans', 'timeline.sync.restoredUnavailable') });
  assert.equal((byTestId(blocked, 'timeline-source-refresh-all'))!.props.disabled, true); assert.match(text(blocked), /恢复出的工作区暂不支持批量更新来源和追加镜头/);
  assert.equal((byTestId(render({ ...props, staleClipIds: ['c8'], busy: true }), 'timeline-source-refresh-all'))!.props.disabled, true);
  assert.equal(render({ ...props, staleClipIds: [] }), null);
});

test('the result banner reports updated and skipped clips, undoes the batch once and locates each skip', () => {
  const render = loadBanner(), calls: unknown[] = [];
  const outcome = { revision: 9, refreshed: [{ clipId: 'c1' }, { clipId: 'c2' }], skipped: [{ clipId: 'c3', reason: 'SOURCE_TOO_SHORT', shotId: 's', toVersionId: 'v', shortByFrames: 36 }] };
  const props = { staleClipIds: ['c3'], outcome, describeSkip: (skip: { clipId: unknown; }) => `skip:${skip.clipId}`, canUndo: true, onRefreshAll() {}, onSelectClip: (id: unknown) => calls.push(['select', id]), onUndo: () => calls.push(['undo']), onDismissOutcome: () => calls.push(['dismiss']) };
  const tree = render(props);
  assert.match(text(tree), /已更新 2 个片段，1 个跳过/); assert.match(text(tree), /撤销会一次恢复全部 2 个片段/); assert.match(text(tree), /跳过skip:c3定位/);
  assert.equal(byTestId(tree, 'timeline-source-banner'), undefined, 'the outcome replaces the stale banner');
  (byTestId(tree, 'timeline-source-undo'))!.props.onClick(); (byTestId(tree, 'timeline-source-locate-c3'))!.props.onClick(); (byTestId(tree, 'timeline-source-result-close'))!.props.onClick();
  assert.deepEqual(calls, [['undo'], ['select', 'c3'], ['dismiss']]);
  (byTestId(tree, 'timeline-source-skipped-toggle'))!.props.onClick();
  assert.equal(byTestId(render(props), 'timeline-source-skipped'), undefined, 'skips collapse on request');
  assert.equal((byTestId(render({ ...props, canUndo: false }), 'timeline-source-undo'))!.props.disabled, true, 'undo needs the batch to be the latest history entry');
  const none = render({ ...props, outcome: { revision: 9, refreshed: [], skipped: outcome.skipped } });
  assert.match(text(none), /没有片段被更新，1 个跳过/); assert.match(text(none), /时间线没有改动/); assert.equal(byTestId(none, 'timeline-source-undo'), undefined);
  assert.match(text(loadBanner('en')({ ...props, outcome: { ...outcome, refreshed: [{ clipId: 'c1' }] } })), /Updated 1 clip, 1 skipped/);
});

function loadPreflight() {
  const react = { createElement: element, Fragment: 'Fragment' }; (react as typeof react & {default?: unknown}).default = react;
  const Preflight = load('TimelineExportPreflight.tsx', {
    './i18n/I18nProvider.tsx': i18nTestModule(), './timeline-removal.ts': removal, './export-preflight-state.ts': preflightState, './export-delivery-state.ts': deliveryState,
    './export-settings-state.ts': settingsState, './export-range-state.ts': rangeState, './icons.tsx': { __esModule: true, default: 'Icon' }, '@mioon/ui/components/button': { Button: 'Button' },
    './ExportWorkflow.tsx': { __esModule: true, default: 'ExportWorkflow', ExportWorkflowSection: 'ExportWorkflowSection', ExportWorkflowBack: 'ExportWorkflowBack' },
    './ExportRangeControls.tsx': { __esModule: true, default: 'ExportRangeControls' }, './ExportRangeSummary.tsx': { __esModule: true, default: 'ExportRangeSummary' },
    './TimelineExportSettings.tsx': { __esModule: true, default: 'TimelineExportSettings' }, './TimelineDeliveryName.tsx': { __esModule: true, default: 'TimelineDeliveryName', TimelineDeliveryNameSnapshot: 'TimelineDeliveryNameSnapshot' },
  }, ((react) as unknown as Parameters<typeof load>[2]));
  return (props: Record<string,unknown>) => Preflight({ canCheck: true, onCheck() {}, onExport() {}, onUncheckedExport() {}, onSettingsChange() {}, onDeliveryNameChange() {}, onRangeChange() {}, onTasks() {}, preview: null, recovery: null, ...props });
}

test('the export dialog offers the timeline first and swaps its settings for a storyboard draft on request', () => {
  const render = loadPreflight(), timeline = { durationFrames: 720, fps: 30, clips: [{}, {}, {}], tracks: [{}, {}] }, changes: unknown[] = [], drafts: unknown[] = [];
  const plain = render({ timeline });
  assert.equal(byTestId(plain, 'export-content-choice'), undefined, 'without a choice (empty timeline) the dialog stays as it was');
  assert.equal(plain.props.nextAction, undefined);
  const choice = (value: string) => ({ value, onChange: (next: unknown) => changes.push(next), storyboardDisabledReason: null, storyboardBusy: false, onStoryboardExport: () => drafts.push(value) });
  const settings = (tree: string|number|boolean|RootNode|RootTree[]|null|undefined) => nodes(tree).find((node) => node.props?.className === 'export-timeline-settings');
  const first = render({ timeline, contentChoice: choice('timeline') }), group = byTestId(first, 'export-content-choice');
  assert.equal((group)!.props.role, 'radiogroup');
  assert.equal((byTestId(first, 'export-content-timeline'))!.props['aria-checked'], true); assert.equal((byTestId(first, 'export-content-storyboard'))!.props['aria-checked'], false);
  assert.match(text(group), /导出时间线/); assert.match(text(group), /3 个片段 · 2 条轨道 · 00:00:24:00/); assert.match(text(group), /按分镜导出分镜草稿/);
  assert.equal((settings(first))!.props.hidden, false); assert.equal(first.props.nextAction, undefined); assert.ok(first.props.settingsEstimate);
  (byTestId(first, 'export-content-storyboard'))!.props.onClick();
  assert.deepEqual(changes, ['storyboard']);
  const second = render({ timeline, contentChoice: choice('storyboard') });
  assert.equal((settings(second))!.props.hidden, true); assert.equal(second.props.settingsEstimate, null);
  assert.equal(second.props.checkAction.type, 'ExportWorkflowSection'); assert.deepEqual(second.props.checkAction.props.steps, [1], 'the timeline check stays on its own step');
  assert.equal(second.props.nextAction.props['data-testid'], 'export-storyboard-draft'); assert.equal(second.props.nextAction.props.disabled, false);
  second.props.nextAction.props.onClick(); assert.deepEqual(drafts, ['storyboard']);
  assert.match(text(byTestId(second, 'export-content-choice')), /导出后可在导出记录里查看/);
  const blocked = render({ timeline, contentChoice: { ...choice('storyboard'), storyboardDisabledReason: translate('zh-Hans', 'shell.generateAllShots') } });
  assert.equal(blocked.props.nextAction.props.disabled, true); assert.match(text(byTestId(blocked, 'export-content-choice')), /请先为每个镜头生成并选用一个版本/);
});

test('the storyboard strip renders the append action, its hint and each shot’s timeline status', () => {
  const strip = { shots: [{ id: 's1', title: '开场', duration: 4, selectedVersionId: 'v2' }, { id: 's2', title: '海面', duration: 5, selectedVersionId: 'w1' }, { id: 's3', title: '夕阳', duration: 6, selectedVersionId: null }], versions: [{ id: 'v2', number: 2 }, { id: 'w1', number: 1 }] };
  const fixture = `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server.browser'; import StoryboardStrip from './src/StoryboardStrip.tsx';
    const base = { scope: 's', open: true, onOpenChange() {}, ...${JSON.stringify(strip)}, selectedId: null, reordering: false, assetDragType: 'x', onSelect() {}, onReorder() {}, onAddShot() {}, renderThumbnail: () => null, onViewInEditing() {} };
    const statuses = new Map([['s1', { stale: true }], ['s2', { stale: false }]]);
    export const html = { ready: renderToStaticMarkup(<StoryboardStrip {...base} timelineStatuses={statuses} append={{ count: 1, onAppend() {} }} />),
      none: renderToStaticMarkup(<StoryboardStrip {...base} timelineStatuses={statuses} append={{ count: 0, onAppend() {} }} />),
      restored: renderToStaticMarkup(<StoryboardStrip {...base} append={{ count: 1, disabledReason: 'restored-reason', onAppend() {} }} />),
      plain: renderToStaticMarkup(<StoryboardStrip {...base} />) };`;
  // The markup is large; write it synchronously so exiting cannot truncate the pipe.
  const script = `import {build} from 'esbuild'; const {outputFiles} = await build({stdin:{contents:${JSON.stringify(fixture)},loader:'tsx',resolveDir:${JSON.stringify(path.join(root, 'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}}); const result = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64')); (await import('node:fs')).writeSync(1, JSON.stringify(result.html)); process.exit(0);`;
  const html = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
  const button = (source: string, id: string) => source.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>([\\s\\S]*?)</button>`));
  const append = button(html.ready, 'storyboard-append-timeline');
  const disabled = /\sdisabled=""|\sdata-disabled/;
  assert.ok(append); assert.match(append[1], /追加到时间线（1 个镜头）/); assert.doesNotMatch(append[0], disabled);
  assert.match(html.ready, /只追加未加入的镜头，已有片段不动/);
  assert.match((button(html.ready, 'storyboard-timeline-s1'))![1], /在时间线 · 已过期/); assert.match((button(html.ready, 'storyboard-timeline-s2'))![1], /在时间线</);
  assert.equal(button(html.ready, 'storyboard-timeline-s3'), null, 'a shot that is not placed shows no status');
  assert.match((button(html.none, 'storyboard-append-timeline'))![0], disabled); assert.match((button(html.none, 'storyboard-append-timeline'))![0], /title="没有可追加的镜头/);
  assert.match((button(html.restored, 'storyboard-append-timeline'))![0], /title="restored-reason"/);
  assert.equal(button(html.plain, 'storyboard-append-timeline'), null); assert.doesNotMatch(html.plain, /storyboard-timeline-/);
});

test('App, board and timeline wire the bridges through the ordinary timeline mutation path', () => {
  const app = read('App.tsx');
  assert.match(app, /mutateTimeline\('timeline\.clip\.refreshSources', \{ clipIds: clipIds\.slice\(0, TIMELINE_SHOT_SYNC_LIMITS\.clips\) \}, undefined, \{ errorMessage: shotSyncError, onFailure:/);
  assert.match(app, /mutateTimeline\('timeline\.shots\.append', \{\}, undefined, \{ errorMessage: shotSyncError \}\)/);
  assert.match(app, /refusal\?\.code === 'NOTHING_TO_REFRESH' && current\?\.id === timelineId\) setSourceRefresh\(\{ projectId, timelineId, revision: current\.revision, refreshed: \[\], skipped: sourceRefreshSkips\(refusal\.details\?\.skipped\) \}\)/);
  assert.match(app, /sourceRefresh\.revision === timeline\?\.revision \? sourceRefresh : null/, 'an outcome disappears with the next edit');
  assert.match(app, /notice=\{sourceBanner\}/); assert.match(app, /timelineStatuses=\{shotStatuses\}/); assert.match(app, /timelineStatus=\{shotTimelineView\(chosenShot\?\.id\)\}/);
  assert.match(app, /timelineStatus: shotStatuses\.get\(record\.id\) \?\? null, onViewInEditing: viewShotInEditing,/);
  assert.match(app, /contentChoice=\{!application && timeline\?\.clips\?\.length \? \{ value: exportContent,/);
  assert.match(app, /const bridgeUnavailable = application \|\| restored \? t\('timeline\.sync\.restoredUnavailable'\) : null;/);
  // Other tests evaluate App slices between neighbouring handlers; the bridge handlers stay outside all of them.
  const handlers = app.indexOf('  // Canvas → timeline bridges.');
  assert.ok(handlers > app.indexOf('  async function moveTimelineClip(') && handlers < app.indexOf('  function renderUncheckedTimeline('));
  const board = read('Nodes.tsx');
  assert.match(board, /const viewInEditing = \(event: React\.MouseEvent\) => \{ event\.stopPropagation\(\); data\.onViewInEditing\?\.\(record\.id\); \};/);
  assert.match(board, /data-testid=\{`shot-timeline-chip-\$\{record\.id\}`\}[^>]*onClick=\{viewInEditing\}/);
  assert.match(board, /data-testid=\{`shot-timeline-view-\$\{record\.id\}`\} onClick=\{viewInEditing\}/);
  assert.match(read('Inspector.tsx'), /data-testid="shot-timeline-view" onClick=\{\(\) => onViewInEditing\(shot!\.id\)\}/);
  assert.match(read('Timeline.tsx'), /\{notice\}<div className="timeline-scroll-frame"/);
  assert.match(read('Timeline.tsx'), /clip\.durationFrames \* pxFrame >= 96 \? <span className="clip-stale-mark is-labelled" aria-hidden="true">\{t\('timeline\.sync\.clipBadge'\)\}<\/span>/);
});
