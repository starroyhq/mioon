import { formatDate } from './helpers/i18n.ts';
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const date = '2026-10-10T12:34:56.000Z';
const row = (id, patch = {}) => ({id, projectId: 'original-project', createdAt: date, status: 'succeeded', assetId: `asset-${id}`, ...patch});
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
};
let rendered, actions, fileActions, unchanged;
before(() => {
  const fixture = `import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server.browser';
    import ExportHistoryList from './src/ExportHistoryList.jsx';
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
    const {outputFiles} = await build({stdin: {contents: ${JSON.stringify(fixture)}, loader: 'jsx', resolveDir: ${JSON.stringify(path.join(root, 'apps/web'))}}, bundle: true, format: 'esm', platform: 'browser', write: false, define: {'process.env.NODE_ENV': '"production"'}, plugins: [{name:'capture-file-action-props', setup(build) {
      build.onResolve({filter:/^test:actual-export-file-actions$/}, () => ({path:${JSON.stringify(path.join(root, 'apps/web/src/ExportFileActions.tsx'))}}));
      build.onResolve({filter:/ExportFileActions\\.tsx$/}, () => ({path:'capture', namespace:'file-action-capture'}));
      build.onLoad({filter:/.*/, namespace:'file-action-capture'}, () => ({contents:${JSON.stringify(capture)}, loader:'jsx', resolveDir:${JSON.stringify(path.join(root, 'apps/web'))}}));
    }}]});
    const result = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(result.result)); process.exit(0);`;
  ({html: rendered, actions, fileActions, unchanged} = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], {cwd: root, input: script, encoding: 'utf8', timeout: 30000})));
});

test('export history preserves its empty-state text and original single wrapper', () => {
  assert.match(rendered.empty, /^<div class="export-list"><div class="small-empty">/);
  assert.match(rendered.empty, /还没有导出记录/); assert.match(rendered.empty, /将媒体编排到时间线后导出，或为镜头选好版本后使用分镜导出/);
  assert.doesNotMatch(rendered.empty, /download-export|role="dialog"|export-card/);
  assert.deepEqual(actions.empty, []);
});
test('failed and pending outcomes keep the exact errors, badge and non-download behavior', () => {
  assert.match(rendered.statuses, /排队中/); assert.match(rendered.statuses, /提交状态待确认/);
  assert.equal((rendered.statuses.match(/此导出遇到问题，请核对原记录与当前状态/g) || []).length, 2); assert.doesNotMatch(rendered.statuses, /字符串失败|对象失败|unsafe|&amp; detail/);
  assert.equal((rendered.statuses.match(/class="spinner"/g) || []).length, 3);
  assert.match(rendered.statuses, /small-badge warn/); assert.doesNotMatch(rendered.statuses, /download-export/);
  assert.deepEqual(actions.statuses, [], 'Failed, pending and output-less rows cannot request a file action');
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
  assert.ok(rendered.success.includes(formatDate('zh-Hans', date, { dateStyle: 'medium', timeStyle: 'medium' })));
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
  assert.deepEqual(actions.order.map(action => action.downloadHref), ['/media/order-first', '/media/order-second']);
  assert.ok(rendered.order.indexOf('data-export-id="first"') < rendered.order.indexOf('data-export-id="second"'));
  assert.ok(Object.values(unchanged).every(Boolean));
  const source = readFileSync(path.join(root, 'apps/web/src/ExportHistoryList.tsx'), 'utf8');
  assert.doesNotMatch(source, /useState|useEffect|useRef|\bfetch\s*\(|\brpc\s*\(|\.sort\s*\(|navigationEpoch|requestId/);
});
test('App keeps history in the controlled export dialog with visibility, recovery and immutable identity inputs', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  assert.match(app, /const orderedExports = \[\.\.\.data\.exports\]\.sort\(\(a, b\) => b\.createdAt\.localeCompare\(a\.createdAt\)\);/);
  assert.match(app, /<DeliveryWorkspace page=\{showExports \? 'history' : 'compose'\}/);
  assert.match(app, /<AgentDockPane id="delivery-history-pane" labelledBy="delivery-history-tab" visible=\{showExports\}/);
  const history = app.match(/<ExportHistoryList\s[\s\S]*?\/>/)?.[0];
  assert.ok(history);
  for (const expected of [
    'fileRecoveryEnabled={!restored && !application}', 'projectId={data.project?.id}',
    'candidateConnected={online && auth === true && workbenchReady && !loading}', 'opacityApplication={opacityApplication}',
    'samplePeak={application ? undefined : exportSamplePeak}', 'loudness={application ? undefined : exportLoudness}',
    'heldExportIds={data.restore?.heldExportIds}', 'orderedExports={orderedExports}',
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
