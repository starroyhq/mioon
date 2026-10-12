import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTimelineExportDelivery, TIMELINE_EXPORT_DEFAULT_SETTINGS } from '@mioon/contracts';

const root = fileURLToPath(new URL('../', import.meta.url));
const id = n => `bc000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const timeline = { id: id(2), projectId: id(1), revision: 4, width: 720, height: 1280, fps: 30 };
const delivery = resolveTimelineExportDelivery(timeline, { ...TIMELINE_EXPORT_DEFAULT_SETTINGS, resolution: 'short_1080', rateControl: { mode: 'bitrate', targetKbps: 8000 } });
const createdAt = '2026-10-12T06:01:02.000Z';
const row = (n, patch = {}) => ({ id: id(n), projectId: id(1), assetId: id(n + 10), mode: 'timeline', purpose: 'export', timelineRevision: 4, status: 'succeeded', createdAt,
  url: '/media/untrusted-row-url?filename=forged.mp4', snapshot: { timeline, deliveryName: '冻结名称 <script> " & / .mp4', delivery }, ...patch });
const fixtures = {
  blank: { component: 'name', props: { value: '' } },
  namedInput: { component: 'name', props: { value: '  中文 <第一版>  ' } },
  invalidInput: { component: 'name', props: { value: 'x'.repeat(121) } },
  disabledInput: { component: 'name', props: { value: '暂停中的草稿', disabled: true } },
  named: { component: 'history', props: { orderedExports: [row(3)], projectName: '项目已改名', timelineRevision: 9 } },
  renamedAgain: { component: 'history', props: { orderedExports: [row(3)], projectName: '另一个新名称', timelineRevision: 10 } },
  twoExports: { component: 'history', props: { orderedExports: [row(3), row(4, { snapshot: { timeline, deliveryName: '第二份', delivery: resolveTimelineExportDelivery(timeline, TIMELINE_EXPORT_DEFAULT_SETTINGS) } })], projectName: 'current', timelineRevision: 4 } },
  heldSuccess: { component: 'history', props: { orderedExports: [row(3)], heldExportIds: [id(3)], timelineRevision: 4 } },
  heldFailure: { component: 'history', props: { orderedExports: [row(3, { status: 'failed', assetId: null, url: null, error: { message: '<unsafe failure>' } })], heldExportIds: [id(3)] } },
  namedDefault: { component: 'history', props: { orderedExports: [row(3, { snapshot: { timeline, deliveryName: '仅命名，沿用原有编码' } })] } },
  legacy: { component: 'history', props: { projectName: '旧项目默认', timelineRevision: 4, orderedExports: [row(3, { url: '/media/original-file', snapshot: { timeline } })] } },
  legacyQuality: { component: 'history', props: { projectName: '旧项目默认', timelineRevision: 4, orderedExports: [row(3, { url: '/media/original-file', snapshot: { timeline, delivery } })] } },
  storyboard: { component: 'history', props: { projectName: '分镜默认', orderedExports: [row(3, { mode: 'storyboard', purpose: undefined, orderedVersionIds: [id(20)], url: '/media/story-original' })] } },
  invalidName: { component: 'history', props: { orderedExports: [row(3, { snapshot: { timeline, deliveryName: null } })] } },
  invalidStatus: { component: 'history', props: { orderedExports: [row(3, { status: 'ready' })] } },
  invalidId: { component: 'history', props: { orderedExports: [row(3, { id: `${id(3)}\n` })] } },
};
let rendered;
before(() => {
  const fixture = `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import TimelineDeliveryName from './src/TimelineDeliveryName.tsx';
    import ExportHistoryList from './src/ExportHistoryList.jsx';
    const fixtures = ${JSON.stringify(fixtures)};
    function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
    export const html = Object.fromEntries(Object.entries(fixtures).map(([name, entry]) => [name, renderToStaticMarkup(entry.component === 'name' ? <TimelineDeliveryName {...freeze(entry.props)} /> : <ExportHistoryList {...freeze(entry.props)} />)]));`;
  const script = `import {build} from 'esbuild';
    globalThis.fetch = () => { throw Error('Delivery presentation must never fetch'); };
    const {outputFiles} = await build({stdin: {contents: ${JSON.stringify(fixture)}, loader: 'jsx', resolveDir: ${JSON.stringify(path.join(root, 'apps/web'))}}, bundle: true, format: 'esm', platform: 'browser', write: false, jsx: 'automatic', define: {'process.env.NODE_ENV': '"production"'}});
    const result = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(result.html)); process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
});

test('actual shared Input is controlled, labelled and explicit about blank legacy omission', () => {
  assert.match(rendered.blank, /data-slot="input"/); assert.match(rendered.blank, /data-testid="delivery-name-input"/);
  assert.match(rendered.blank, /本次成片名称/); assert.match(rendered.blank, /留空使用默认文件名/); assert.match(rendered.blank, /value=""/);
  assert.match(rendered.blank, /不会保存一个新名称/); assert.match(rendered.blank, /aria-describedby=/);
  assert.doesNotMatch(rendered.blank, /role="dialog"|delivery-name-error/);
  assert.match(rendered.namedInput, /value="  中文 &lt;第一版&gt;  "/);
  assert.match(rendered.disabledInput, /disabled=""/); assert.match(rendered.disabledInput, /value="暂停中的草稿"/);
});

test('invalid visible text remains exact and emits an accessible bounded validation message', () => {
  assert.ok(rendered.invalidInput.includes(`value="${'x'.repeat(121)}"`));
  assert.match(rendered.invalidInput, /aria-invalid="true"/); assert.match(rendered.invalidInput, /role="alert"/);
  assert.match(rendered.invalidInput, /1–120/); assert.doesNotMatch(rendered.invalidInput, /maxlength=/);
});

test('named history shows frozen title/time/revision/dimensions/quality after project rename and revision change', () => {
  for (const html of [rendered.named, rendered.renamedAgain]) {
    assert.match(html, /冻结名称 &lt;script&gt; &quot; &amp; \/ .mp4/);
    assert.match(html, /rev 4 · 旧快照/); assert.match(html, /1080 × 1920/); assert.match(html, /平均目标 8 Mb\/s/); assert.match(html, /AAC 128 kb\/s/);
    assert.ok(html.includes(createdAt)); assert.ok(html.includes(new Date(createdAt).toLocaleString('zh-CN')));
    assert.doesNotMatch(html, /项目已改名|另一个新名称|<script>|filename=forged/);
  }
  assert.equal(rendered.named, rendered.renamedAgain);
});

test('named downloads use only managed IDs plus exportId and no renderer filename override', () => {
  assert.match(rendered.named, new RegExp(`href="/media/${id(13)}\\?download=1&amp;exportId=${id(3)}"`));
  assert.match(rendered.named, /data-slot="button"/); assert.match(rendered.named, /download=""/);
  assert.doesNotMatch(rendered.named, /download="[^"\n]+"|untrusted-row-url|name=|filename=/);
  assert.equal((rendered.twoExports.match(/data-testid="named-delivery-history"/g) || []).length, 2);
  assert.match(rendered.twoExports, /第二份/); assert.match(rendered.twoExports, /标准 · CRF 23/); assert.match(rendered.twoExports, /720 × 1280/);
});

test('held restored rows retain historical labels, successful managed downloads and blocked failed execution', () => {
  assert.match(rendered.heldSuccess, /历史记录 · 暂停执行，原状态保留/); assert.match(rendered.heldSuccess, /download-export/);
  assert.match(rendered.heldFailure, /历史记录 · 暂停执行，原状态保留/); assert.match(rendered.heldFailure, /已保留 · 暂停/);
  assert.match(rendered.heldFailure, /&lt;unsafe failure&gt;/); assert.doesNotMatch(rendered.heldFailure, /download-export/);
});

test('name-only rows use frozen timeline geometry without inventing a quality profile', () => {
  assert.match(rendered.namedDefault, /仅命名，沿用原有编码/); assert.match(rendered.namedDefault, /720 × 1280/); assert.match(rendered.namedDefault, /原有编码设置/);
  assert.doesNotMatch(rendered.namedDefault, /CRF|AAC|平均目标/);
});

test('unnamed legacy rows and storyboard retain their original default display and download behavior', () => {
  assert.match(rendered.legacy, /<strong>旧项目默认.mp4<\/strong>/); assert.match(rendered.legacy, /href="\/media\/original-file"/); assert.match(rendered.legacy, /download="旧项目默认.mp4"/);
  assert.doesNotMatch(rendered.legacy, /named-delivery-history|delivery-history-name|冻结名称|CRF|AAC/);
  assert.match(rendered.legacyQuality, /平均目标 8 Mb\/s/); assert.match(rendered.legacyQuality, /1080 × 1920/);
  assert.match(rendered.storyboard, /分镜顺序导出 · 1 个镜头/); assert.match(rendered.storyboard, /href="\/media\/story-original"/); assert.match(rendered.storyboard, /download="分镜默认.mp4"/);
  assert.doesNotMatch(rendered.storyboard, /named-delivery-history/);
});

test('malformed named metadata is visibly unavailable without borrowing a project title or download URL', () => {
  for (const html of [rendered.invalidName, rendered.invalidStatus, rendered.invalidId]) {
    assert.match(html, /named-delivery-invalid/); assert.match(html, /记录不完整/); assert.doesNotMatch(html, /download-export|href=|forged/);
  }
});

test('typed components import real shared controls and no unchecked barrel or legacy icon graph', () => {
  const input = readFileSync(path.join(root, 'apps/web/src/TimelineDeliveryName.tsx'), 'utf8');
  const history = readFileSync(path.join(root, 'apps/web/src/TimelineDeliveryHistory.tsx'), 'utf8');
  const state = readFileSync(path.join(root, 'apps/web/src/export-delivery-state.ts'), 'utf8');
  assert.match(input, /@mioon\/ui\/components\/input/); assert.match(history, /@mioon\/ui\/components\/button/);
  assert.match(state, /@mioon\/contracts\/timeline-delivery/);
  for (const source of [input, history, state]) assert.doesNotMatch(source, /from ['"]@mioon\/contracts['"]|icons\.jsx|:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck/);
});
