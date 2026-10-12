import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const date = '2026-10-10T12:34:56.000Z';
const row = (id, patch = {}) => ({id, createdAt: date, status: 'succeeded', assetId: `asset-${id}`, ...patch});
const fixtures = {
  empty: {orderedExports: []},
  statuses: {orderedExports: [row('queued', {status: 'queued'}), row('failed', {status: 'failed', error: '字符串失败 <unsafe>'}), row('unknown', {status: 'submission_unknown', error: {message: '对象失败 & detail'}}), row('no-output', {assetId: undefined})]},
  success: {projectName: '片名', orderedExports: [row('one', {url: '/media/explicit?download=1&name=%E7%89%87'}), row('two', {status: 'completed'}), row('three', {status: 'ready'})]},
  snapshots: {timelineRevision: 7, orderedExports: [row('preview', {mode: 'timeline', purpose: 'preview', timelineRevision: 7}), row('export', {mode: 'timeline', purpose: 'export', timelineRevision: 6}), row('strict', {mode: 'timeline', timelineRevision: '7'}), row('story', {orderedVersionIds: ['version-a', 'version-b']}), row('empty-story')]},
  fallbacks: {orderedExports: [row('fallback')]},
  escaped: {projectName: '片名 <script> " & 单引号\'', orderedExports: [row('escaped', {url: '/media/synthetic?download=1&label=%22%E4%B8%AD%22', error: '<img src=x onerror=alert(1)>'})]},
  order: {orderedExports: [row('first', {url: '/media/order-first', createdAt: '2020-01-01'}), row('second', {url: '/media/order-second', createdAt: '2030-01-01'})]},
};
let rendered;
before(() => {
  const fixture = `import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server.browser';
    import ExportHistoryList from './src/ExportHistoryList.jsx';
    const fixtures = ${JSON.stringify(fixtures)};
    function freeze(value) {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;}
    export const html = Object.fromEntries(Object.entries(fixtures).map(([name, props]) => [name, renderToStaticMarkup(<ExportHistoryList {...freeze(props)} />)]));`;
  // Same real React/Base UI browser-SSR path as ui-components.test.mjs. The
  // short-lived child avoids retaining browser-SSR scheduling handles in tests.
  const script = `import {build} from 'esbuild';
    globalThis.fetch = () => {throw Error('Pure presentation must not request data');};
    const {outputFiles} = await build({stdin: {contents: ${JSON.stringify(fixture)}, loader: 'jsx', resolveDir: ${JSON.stringify(path.join(root, 'apps/web'))}}, bundle: true, format: 'esm', platform: 'browser', write: false, define: {'process.env.NODE_ENV': '"production"'}});
    const result = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(result.html)); process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], {cwd: root, input: script, encoding: 'utf8', timeout: 30000}));
});

test('export history preserves its empty-state text and original single wrapper', () => {
  assert.match(rendered.empty, /^<div class="export-list"><div class="small-empty">/);
  assert.match(rendered.empty, /还没有导出记录/); assert.match(rendered.empty, /将媒体编排到时间线后导出，或为镜头选好版本后使用分镜导出。/);
  assert.doesNotMatch(rendered.empty, /download-export|role="dialog"|export-card/);
});
test('failed and pending outcomes keep the exact errors, badge and non-download behavior', () => {
  assert.match(rendered.statuses, /等待生成/); assert.match(rendered.statuses, /提交状态待确认/);
  assert.match(rendered.statuses, /字符串失败 &lt;unsafe&gt;/); assert.match(rendered.statuses, /对象失败 &amp; detail/);
  assert.equal((rendered.statuses.match(/class="spinner"/g) || []).length, 3);
  assert.match(rendered.statuses, /small-badge warn/); assert.doesNotMatch(rendered.statuses, /download-export/);
});
test('all three ready statuses preserve the URL precedence, asset fallback and download attributes', () => {
  assert.equal((rendered.success.match(/data-testid="download-export"/g) || []).length, 3);
  assert.match(rendered.success, /href="\/media\/explicit\?download=1&amp;name=%E7%89%87"/);
  assert.match(rendered.success, /href="\/media\/asset-two"/); assert.match(rendered.success, /href="\/media\/asset-three"/);
  assert.doesNotMatch(rendered.success, /href="\/media\/asset-one"/);
  assert.equal((rendered.success.match(/download="片名.mp4"/g) || []).length, 3);
  assert.ok(rendered.success.includes(new Date(date).toLocaleString('zh-CN')));
});
test('snapshot labels preserve preview/export/storyboard and strict revision comparison', () => {
  assert.match(rendered.snapshots, /时间线预览 · rev 7 · 当前/); assert.match(rendered.snapshots, /时间线导出 · rev 6 · 旧快照/);
  assert.match(rendered.snapshots, /时间线导出 · rev 7 · 旧快照/); assert.match(rendered.snapshots, /分镜顺序导出 · 2 个镜头/);
  assert.match(rendered.snapshots, /分镜顺序导出 · 0 个镜头/);
});
test('display and download fallback names remain intentionally different', () => {
  assert.match(rendered.fallbacks, /<strong>成片.mp4<\/strong>/); assert.match(rendered.fallbacks, /download="film.mp4"/);
});
test('project/error text and download attributes stay React-escaped without changing encoded media URLs', () => {
  assert.match(rendered.escaped, /&lt;script&gt;/); assert.match(rendered.escaped, /&quot; &amp; 单引号&#x27;/);
  assert.match(rendered.escaped, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(rendered.escaped, /<script>|<img src=x/);
  assert.match(rendered.escaped, /href="\/media\/synthetic\?download=1&amp;label=%22%E4%B8%AD%22"/);
});
test('presentation uses supplied order and never mutates frozen input rows', () => {
  assert.ok(rendered.order.indexOf('/media/order-first') < rendered.order.indexOf('/media/order-second'));
  const source = readFileSync(path.join(root, 'apps/web/src/ExportHistoryList.jsx'), 'utf8');
  assert.doesNotMatch(source, /useState|useEffect|useRef|\bfetch\s*\(|\brpc\s*\(|\.sort\s*\(|navigationEpoch|requestId/);
});
test('App keeps history inside the controlled visible right dock with project identity and ordering', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.jsx'), 'utf8');
  assert.match(app, /const orderedExports = \[\.\.\.data\.exports\]\.sort\(\(a, b\) => b\.createdAt\.localeCompare\(a\.createdAt\)\);/);
  assert.match(app, /<DeliveryWorkspace page=\{showExports \? 'history' : 'compose'\}/);
  assert.match(app, /<AgentDockPane id="delivery-history-pane" labelledBy="delivery-history-tab" visible=\{showExports\}/);
  assert.match(app, /<ExportHistoryList heldExportIds=\{data\.restore\?\.heldExportIds\} orderedExports=\{orderedExports\} projectName=\{data\.project\?\.name\} timelineRevision=\{timeline\?\.revision\} \/>/);
  assert.doesNotMatch(app, /showExports && <Modal|<Modal title="导出记录"/);
  // Other existing dialogs keep their accessible close behavior.
  assert.match(app, /<Dialog open onOpenChange=\{open => \{ if \(!open\) onClose\(\); \}\}>/);
  assert.match(app, /<DialogTitle>\{title\}<\/DialogTitle>/); assert.match(app, /aria-label="关闭对话框"/);
  assert.match(app, /setShowJobs\(false\); setShowExports\(false\); setComparisonId\(null\)/);
  assert.doesNotMatch(app, /className="export-card"/);
});
