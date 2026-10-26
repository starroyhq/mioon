import type {ElementModule} from './helpers/strict-timeline-audio-harness-types.ts';
import type {ElementTree, ElementNode} from './helpers/strict-timeline-audio-harness-types.ts';
import {transformSync} from 'esbuild';
import {i18nTestModule} from './helpers/i18n.ts';
import * as settingsState from '../apps/web/src/export-settings-state.ts';
import * as deliveryState from '../apps/web/src/export-delivery-state.ts';
import * as rangeState from '../apps/web/src/export-range-state.ts';
import {exportHistoryStatusMessage} from '../apps/web/src/export-display.ts';
import { formatDate } from './helpers/i18n.ts';
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const date = '2026-10-10T12:34:56.000Z';
const row = (id: string, patch = {}) => ({id, projectId: 'original-project', createdAt: date, status: 'succeeded', assetId: `asset-${id}`, ...patch});
const fixtures = {
  empty: {orderedExports: []},
  statuses: {orderedExports: [row('queued', {status: 'queued'}), row('failed', {status: 'failed', error: '字符串失败 <unsafe>'}), row('unknown', {status: 'submission_unknown', error: {message: '对象失败 & detail'}}), row('no-output', {assetId: undefined})]},
  success: {projectId: 'current-project', projectName: '片名', orderedExports: [row('one', {url: '/media/explicit?download=1&name=%E7%89%87'}), row('two', {status: 'completed'}), row('three', {status: 'ready'})]},
  snapshots: {timelineRevision: 7, orderedExports: [row('preview', {mode: 'timeline', purpose: 'preview', timelineRevision: 7}), row('export', {mode: 'timeline', purpose: 'export', timelineRevision: 6}), row('strict', {mode: 'timeline', timelineRevision: '7'}), row('story', {orderedVersionIds: ['version-a', 'version-b']}), row('empty-story')]},
  fallbacks: {orderedExports: [row('fallback')]},
  recoveryDisabled: {fileRecoveryEnabled: false, orderedExports: [row('fallback')]},
  held: {heldExportIds: ['held'], orderedExports: [row('held')]},
  escaped: {projectName: '片名 <script> " & 单引号\'', orderedExports: [row('escaped', {url: '/media/synthetic?download=1&label=%22%E4%B8%AD%22', error: '<img src=x onerror=alert(1)>'})]},
  escapedDownload: {fileRecoveryEnabled: false, orderedExports: [row('escaped', {url: '/media/synthetic?download=1&label=%22%E4%B8%AD%22&quoted="<&name=片名'})]},
  order: {orderedExports: [row('first', {url: '/media/order-first', createdAt: '2020-01-01'}), row('second', {url: '/media/order-second', createdAt: '2030-01-01'})]},
  sizes:{projectId:'original-project',outputAssets:[{id:'owned-output',projectId:'original-project',sizeBytes:2*1024*1024},{id:'foreign-output',projectId:'other-project',sizeBytes:3*1024*1024}],orderedExports:[row('sized',{assetId:'owned-output',sizeBytes:99*1024*1024}),row('foreign-asset',{assetId:'foreign-output'}),row('foreign-row',{projectId:'other-project',assetId:'owned-output'}),row('missing-output',{sizeBytes:99*1024*1024})]},
  invalidSizes:{projectId:'original-project',outputAssets:[0,-1,1.5,Number.MAX_SAFE_INTEGER+1].map((sizeBytes,index)=>({id:`invalid-size-${index}`,projectId:'original-project',sizeBytes})),orderedExports:[0,1,2,3].map(index=>row(`bad-${index}`,{assetId:`invalid-size-${index}`}))},
};
let rendered: Record<string, string>, actions: Record<string, {downloadHref?: string; disabled?:boolean}[]>, fileActions: Record<string, string[]>, unchanged: Record<string, boolean>;
before(() => {
  const fixture = `import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server.browser';
    import ExportHistoryList from './src/ExportHistoryList.tsx';
    import ActualExportFileActions from 'test:actual-export-file-actions';
    const fixtures = ${JSON.stringify(fixtures)};
    function freeze(value) {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;}
    export const result = {html: {}, actions: {}, fileActions: {}, unchanged: {}};
    for (const [name, props] of Object.entries(fixtures)) {
      const original = JSON.stringify(props); globalThis.__capturedExportFileActions = [];
      result.html[name] = renderToStaticMarkup(<ExportHistoryList {...freeze(props)} />);
      result.actions[name] = globalThis.__capturedExportFileActions;
      result.fileActions[name] = result.actions[name].map(action => renderToStaticMarkup(<ActualExportFileActions {...freeze(action)} />));
      result.unchanged[name] = JSON.stringify(props) === original;
    }`;
  // Capture the composition boundary without inventing a checked file or a
  // download anchor. Render the real async leaf separately in its SSR state.
  const capture = `import React from 'react'; export default function CaptureExportFileActions(props) {
    globalThis.__capturedExportFileActions.push({...props});
    return React.createElement('span', {'data-testid':'captured-export-file-actions', 'data-export-id':props.exportId});
  }`;
  // Same real React/Base UI browser-SSR path as ui-components.test.mjs. The
  // short-lived child avoids retaining browser-SSR scheduling handles in tests.
  const script = `import {build} from 'esbuild';
    globalThis.fetch = () => {throw Error('Pure presentation must not request data');};
    const {outputFiles} = await build({stdin: {contents: ${JSON.stringify(fixture)}, loader: 'tsx', resolveDir: ${JSON.stringify(path.join(root, 'apps/web'))}}, bundle: true, format: 'esm', platform: 'browser', write: false, define: {'process.env.NODE_ENV': '"production"'}, plugins: [{name:'capture-file-action-props', setup(build) {
      build.onResolve({filter:/^test:actual-export-file-actions$/}, () => ({path:${JSON.stringify(path.join(root, 'apps/web/src/ExportFileActions.tsx'))}}));
      build.onResolve({filter:/ExportFileActions\\.tsx$/}, () => ({path:'capture', namespace:'file-action-capture'}));
      build.onLoad({filter:/.*/, namespace:'file-action-capture'}, () => ({contents:${JSON.stringify(capture)}, loader:'tsx', resolveDir:${JSON.stringify(path.join(root, 'apps/web'))}}));
    }}]});
    const result = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    await new Promise(resolve=>process.stdout.write(JSON.stringify(result.result),resolve)); process.exit(0);`;
  ({html: rendered, actions, fileActions, unchanged} = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], {cwd: root, input: script, encoding: 'utf8', timeout: 30000})));
});

test('export history preserves its empty-state text and original single wrapper', () => {
  assert.match(rendered.empty, /^<div class="export-history-table-view export-list">/); assert.match(rendered.empty, /<table class="export-history-table">/); assert.match(rendered.empty, /colSpan="6"/i);
  assert.match(rendered.empty, /还没有导出记录/); assert.match(rendered.empty, /将媒体编排到时间线后导出，或为镜头选好版本后使用分镜导出/);
  assert.doesNotMatch(rendered.empty, /download-export|role="dialog"|export-card/);
  assert.deepEqual((actions.empty as unknown), []);
});
test('failed and pending outcomes keep the exact errors, badge and non-download behavior', () => {
  assert.match(rendered.statuses, /排队中/); assert.match(rendered.statuses, /提交状态待确认/);
  assert.equal((rendered.statuses.match(/此导出遇到问题，请核对原记录与当前状态/g) || []).length, 2); assert.doesNotMatch(rendered.statuses, /字符串失败|对象失败|unsafe|&amp; detail/);
  assert.equal((rendered.statuses.match(/class="spinner"/g) || []).length, 3);
  assert.match(rendered.statuses, /small-badge warn/); assert.doesNotMatch(rendered.statuses, /download-export/);
  assert.deepEqual((actions.statuses as unknown), [], 'Failed, pending and output-less rows cannot request a file action');
});
test('ready rows pass exact URL precedence and identity to the async file check without claiming a download', () => {
  assert.deepEqual(actions.success, [
    {projectId:'current-project', exportId:'one', downloadHref:'/media/explicit?download=1&name=%E7%89%87', disabled:false},
    {projectId:'current-project', exportId:'two', downloadHref:'/media/asset-two', disabled:false},
    {projectId:'current-project', exportId:'three', downloadHref:'/media/asset-three', disabled:false},
  ]);
  assert.equal(fileActions.success.length, 3);
  for (const html of fileActions.success) {
    assert.match(html, /data-testid="export-file-check"/);
    assert.doesNotMatch(html, /download-export|href=|download=/);
  }
  assert.ok(rendered.success.includes(formatDate('zh-Hans', date, { dateStyle: 'short', timeStyle: 'short' })));
});
test('snapshot labels preserve preview/export/storyboard and strict revision comparison', () => {
  assert.match(rendered.snapshots, /时间线预览 · 修订版 7 · 当前/); assert.match(rendered.snapshots, /时间线导出 · 修订版 6 · 旧快照/);
  assert.match(rendered.snapshots, /时间线导出 · 修订版 7 · 旧快照/); assert.match(rendered.snapshots, /分镜顺序导出 · 2 个镜头/);
  assert.match(rendered.snapshots, /分镜顺序导出 · 0 个镜头/);
  assert.equal(actions.snapshots[0].disabled, true, 'Preview downloads bypass the export-only recovery API');
  assert.match(fileActions.snapshots[0], /href="\/media\/asset-preview"/);
  assert.match(fileActions.snapshots[0], /data-testid="download-export"/);
  assert.equal(actions.snapshots[1].disabled, false);
});
test('fallback display name stays local while download filenames remain server-owned', () => {
  assert.match(rendered.fallbacks, /<strong>成片.mp4<\/strong>/);
  assert.deepEqual(actions.fallbacks, [{projectId:'original-project', exportId:'fallback', downloadHref:'/media/asset-fallback', disabled:false}]);
  assert.deepEqual(actions.recoveryDisabled, [{...actions.fallbacks[0], disabled:true}]);
  assert.match(fileActions.recoveryDisabled[0], /href="\/media\/asset-fallback"/);
  assert.match(fileActions.recoveryDisabled[0], /download=""/);
  assert.doesNotMatch(fileActions.recoveryDisabled[0], /download="[^"\n]+"|film\.mp4|成片\.mp4|export-file-check/);
  assert.deepEqual(actions.held, [{projectId:'original-project', exportId:'held', downloadHref:'/media/asset-held', disabled:true}]);
  assert.match(fileActions.held[0], /data-testid="download-export"/);
});
test('project/error text and download attributes stay React-escaped without changing encoded media URLs', () => {
  assert.match(rendered.escaped, /&lt;script&gt;/); assert.match(rendered.escaped, /&quot; &amp; 单引号&#x27;/);
  assert.match(rendered.escaped, /此导出遇到问题，请核对原记录与当前状态/); assert.doesNotMatch(rendered.escaped, /onerror|src=x/); assert.doesNotMatch(rendered.escaped, /<script>|<img src=x/);
  assert.equal(actions.escaped[0].downloadHref, '/media/synthetic?download=1&label=%22%E4%B8%AD%22');
  assert.match(fileActions.escaped[0], /data-testid="export-file-check"/);
  assert.match(fileActions.escapedDownload[0], /href="\/media\/synthetic\?download=1&amp;label=%22%E4%B8%AD%22&amp;quoted=&quot;&lt;&amp;name=片名"/);
  assert.match(fileActions.escapedDownload[0], /download=""/);
});
test('presentation uses supplied order and never mutates frozen input rows', () => {
  assert.deepEqual(actions.order.map((action: { downloadHref?: string; }) => action.downloadHref), ['/media/order-first', '/media/order-second']);
  assert.ok(rendered.order.indexOf('data-export-id="first"') < rendered.order.indexOf('data-export-id="second"'));
  assert.ok(Object.values(unchanged).every(Boolean));
  const source = readFileSync(path.join(root, 'apps/web/src/ExportHistoryList.tsx'), 'utf8');
  assert.doesNotMatch(source, /useEffect|useRef|\bfetch\s*\(|\brpc\s*\(|\.sort\s*\(|navigationEpoch|requestId/);
});
test('history derives size only from the matching owned output asset without trusting receipt extras',()=>{
 const sizes=(html: string)=>[...html.matchAll(/data-testid="export-history-size">([^<]*)<\/td>/g)].map(match=>match[1]);
 assert.deepEqual(sizes(rendered.sizes),['2 MB','—','—','—']);
 assert.deepEqual(sizes(rendered.invalidSizes),['—','—','—','—']);
 assert.equal(unchanged.sizes,true);assert.equal(unchanged.invalidSizes,true);
});
test('App keeps history in the controlled export dialog with visibility, recovery and immutable identity inputs', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  // Typed App source spells the same frozen ordering formula with non-null assertions on the
  // already-parsed createdAt fields; keep asserting the exact descending-createdAt comparator.
  assert.match(app, /const orderedExports = \[\.\.\.data\.exports\]\.sort\(\(a, b\) => b\.createdAt!?\.localeCompare\(a\.createdAt!?\)\);/);
  assert.match(app, /<DeliveryWorkspace page=\{showExports \? 'history' : 'compose'\}/);
  assert.match(app, /<AgentDockPane id="delivery-history-pane" labelledBy="delivery-history-tab" visible=\{showExports\}/);
  const history = app.match(/<ExportHistoryList\s[\s\S]*?\/>/)?.[0];
  assert.ok(history);
  for (const expected of [
    'fileRecoveryEnabled={!restored && !application}', 'projectId={data.project?.id}',
    'candidateConnected={online && auth === true && workbenchReady && !loading}', 'opacityApplication={opacityApplication}',
    'samplePeak={application ? undefined : exportSamplePeak as never}', 'loudness={application ? undefined : exportLoudness as never}',
    'heldExportIds={data.restore?.heldExportIds}', 'orderedExports={orderedExports}', 'outputAssets={data.assets}',
    'projectName={data.project?.name}', 'timelineRevision={timeline?.revision}',
  ]) assert.ok(history.includes(expected), expected);
  assert.match(history, /onReexport=\{\(\) => \{ if \(clipDraftRef\.current\?\.hasPendingComposition\(\) \|\| !canOpenExport\) return; setDeliveryAttempt\(null\); setDeliveryReviewVersion\(value => value \+ 1\); openTimelineExport\(\); \}\}/);
  assert.match(app, /<Dialog open=\{showDelivery\} onOpenChange=\{open => \{ if \(!open\) \{ markPanelIntent\(\); setShowDelivery\(false\); exportPreviewPause\.current\?\.\(\); \} \}\}>/);
  assert.match(app, /keepMounted hidden=\{!showDelivery\} inert=\{!showDelivery\} data-testid="timeline-export-dialog"/);
  assert.doesNotMatch(app, /showExports && <Modal|<Modal title="导出记录"/);
  // Other existing dialogs keep their accessible close behavior.
  assert.match(app, /<Dialog open onOpenChange=\{open => \{ if \(!open\) onClose\(\); \}\}>/);
  assert.match(app, /<DialogTitle>\{title\}<\/DialogTitle>/); assert.match(app, /aria-label=\{t\('shell\.closeDialog'\)\}/);
  assert.match(app, /setShowTasks\(false\); setShowDelivery\(false\); setShowImage\(false\); setShowProjectChooser\(false\); setShowExports\(false\); setComparisonId\(null\)/);
  assert.doesNotMatch(app, /className="export-card"/);
});


test('history filters actual retained rows locally and a project switch discards the previous filter',()=>{
 const source=readFileSync(new URL('../apps/web/src/ExportHistoryList.tsx',import.meta.url),'utf8');
 let state: unknown,tree: ElementTree,props={projectId:'one',orderedExports:[row('done'),row('failed',{status:'failed'}),row('cancelled',{status:'failed',error:{code:'EXPORT_CANCELLED'}}),row('running',{status:'running'})]};
 const original=JSON.stringify(props.orderedExports),react={createElement:(type: unknown,props: Record<string, unknown> | null,...children: ElementTree[])=>({type,props:{...props,children}}),useState(initial: unknown){state??=initial;return[state,(next: (arg0: unknown) => unknown)=>{state=typeof next==='function'?next(state):next;}];}};
 const mod=({exports:{}} as ElementModule);Function('module','exports','require',transformSync(source,{loader:'tsx',format:'cjs'}).code)(mod,mod.exports,(name: string)=>{
  if(name==='react')return react;if(name.endsWith('I18nProvider.tsx'))return i18nTestModule();
  if(name.endsWith('export-settings-state.ts'))return settingsState;if(name.endsWith('export-delivery-state.ts'))return deliveryState;if(name.endsWith('export-range-state.ts'))return rangeState;if(name.endsWith('export-display.ts'))return{exportHistoryStatusMessage};
  if(name.endsWith('opacity-candidate-render-presentation.ts'))return{opacityCandidateRenderPresentation:()=>null};
  if(name==='@mioon/ui/components/button')return{Button:'Button'};if(name==='@mioon/ui/components/badge')return{Badge:'Badge'};
  return{__esModule:true,default:name};
 });
 const nodes=(value: ElementTree): ElementNode[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
 const render=(patch?: Record<string, unknown>)=>{props={...props,...patch};tree=mod.exports.default(props);return nodes(tree).filter((node: ElementNode)=>node.props.className==='export-history-row');};
 const filter=(value: string)=>nodes(tree).find((node: ElementNode)=>node.props['data-testid']===`export-history-filter-${value}`);
 assert.equal(render().length,4);filter('complete')!.props.onClick();assert.equal(render().length,1);filter('failed')!.props.onClick();let rows=render();assert.equal(rows.length,1);assert.equal(rows[0].props['data-status'],'failed');
 const old=filter('failed')!.props.onClick;render({projectId:'two'});old();assert.equal(render().length,4);assert.equal(filter('all')!.props['aria-pressed'],true);assert.equal(JSON.stringify(props.orderedExports),original);
});
