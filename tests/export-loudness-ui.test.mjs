import * as i18n from './helpers/i18n.ts';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripSourceTypes } from './helpers/eval-source.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { isTimelineRenderRecord } from '@mioon/contracts';
import { pinNewWorkspaceIntent, workspaceOriginScope } from '../apps/web/src/workspace-origin.ts';
import * as loudnessState from '../apps/web/src/export-loudness-state.ts';
import { context, fixture, report, unready, row, asset, projectId } from './helpers/export-loudness-ui-fixture.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
let rendered;
before(async () => {
  const values = {};
  for (const name of ['idle','ready','range','custom','noConflict','silent','belowGate','tooShort','checking','busy','invalid','unsupported','incomplete','stale','cancelled','restored','offline']) {
    const short = row(); short.snapshot.timeline.durationFrames = 9; short.snapshot.timeline.clips[0].durationFrames = 9;
    const f = fixture(name === 'restored' ? { restored: true } : name === 'offline' ? { connected: false } : name === 'tooShort' ? { exports: [short], assets: [asset(short)] } : {});
    if (name === 'ready' || name === 'tooShort') await f.ready();
    if (name === 'range') await f.ready(undefined, 1);
    if (name === 'custom' || name === 'noConflict') { f.edit({ integratedLufs: name === 'custom' ? '-14' : '-24', truePeakCeilingDbtp: '-1' }); await f.ready(); }
    if (name === 'silent') await f.ready(report(f.target(), undefined, { state: 'digital_silence', integratedLufs: null, samplePeakLinear: 0, samplePeakDbfs: null, truePeakLinear: 0, truePeakDbtp: null, absoluteGatedBlockCount: 0, relativeGatedBlockCount: 0, relativeGateLufs: null }));
    if (name === 'belowGate') await f.ready(report(f.target(), undefined, { state: 'below_gate', integratedLufs: null, samplePeakLinear: 1e-6, samplePeakDbfs: -120, truePeakLinear: 1e-6, truePeakDbtp: -120, absoluteGatedBlockCount: 0, relativeGatedBlockCount: 0, relativeGateLufs: null }));
    if (name === 'checking' || name === 'busy') void f.measure();
    if (name === 'invalid') f.edit({ integratedLufs: '-14', truePeakCeilingDbtp: '' });
    if (name === 'unsupported') await f.ready(unready(f.target(), 'unsupported', 'NO_AUDIO'));
    if (name === 'incomplete') await f.ready(unready(f.target(), 'incomplete', 'TIMEOUT'));
    if (name === 'stale') await f.ready(unready(f.target(), 'stale', 'ARTIFACT_CHANGED'));
    if (name === 'cancelled') { void f.measure(); f.cancel(); }
    values[name] = { exportId: f.target(name === 'range' || name === 'busy' ? 1 : 0).exportId, state: f.state() };
  }
  const all = context(), previews = { ...row(20), purpose: 'preview' }, story = { ...row(21), mode: 'storyboard' }, pending = { ...row(22), status: 'running', assetId: null, url: null };
  const historyProps = { orderedExports: [...all.exports, previews, story, pending], projectName: '当前项目', timelineRevision: 99, state: values.idle.state };
  const fixtures = `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import ExportLoudness from './src/ExportLoudness.tsx';
    import ExportHistoryList from './src/ExportHistoryList.tsx';
    const values = ${JSON.stringify(values)}, props = ${JSON.stringify(historyProps)};
    const controller = { measure() { throw Error('Presentation may not decode'); }, setDraft() { throw Error('Presentation may not edit'); }, cancel() { throw Error('Presentation may not cancel'); } };
    export const html = Object.fromEntries(Object.entries(values).map(([name, {exportId,state}]) => [name, renderToStaticMarkup(<ExportLoudness exportId={exportId} loudness={{state,controller}} />)]));
    html.history = renderToStaticMarkup(<ExportHistoryList {...props} loudness={{state:props.state,controller}} />);
    html.withoutFeature = renderToStaticMarkup(<ExportHistoryList {...props} />);`;
  const script = `import {build} from 'esbuild';
    globalThis.fetch = () => {throw Error('History presentation must never request data');};
    const {outputFiles} = await build({stdin:{contents:${JSON.stringify(fixtures)},loader:'tsx',resolveDir:${JSON.stringify(path.join(root,'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,jsx:'transform',define:{'process.env.NODE_ENV':'"production"'}});
    const result = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));process.stdout.write(JSON.stringify(result.html), () => process.exit(0));`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
});
test('classic TSX shared controls render compact measure-only default, optional collapsed targets and honest limits', () => {
  assert.match(rendered.idle, /data-slot="button"/); assert.match(rendered.idle, /data-slot="input"/);
  assert.match(rendered.idle, /aria-label="测量已导出文件响度与真峰值"/); assert.match(rendered.idle, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(rendered.idle, /两项留空仅测量；不预设平台标准/); assert.match(rendered.idle, /不是标准认证、无削波证明或再次 AAC 编码的保证/); assert.match(rendered.idle, /建议不会修改音量/);
  assert.equal((rendered.idle.match(/value=""/g) || []).length, 2);
  assert.doesNotMatch(rendered.idle, /role="dialog"|aria-modal|<details[^>]* open|SHA-256|data-testid="export-loudness-advice"/);
});
test('ready keeps exact file/range/revision/profile/hashes inside collapsed details and shows distinct units', () => {
  assert.match(rendered.ready, /综合响度：-20.00 LUFS/); assert.match(rendered.ready, /真峰值估算：-4.44 dBTP/); assert.match(rendered.ready, /解码样本峰值：-6.02 dBFS/);
  assert.match(rendered.ready, /完整冻结时间线的已导出文件/); assert.match(rendered.range, /所选范围的已导出文件/); assert.doesNotMatch(rendered.range, /完整冻结时间线/);
  assert.match(rendered.ready, /<details><summary>测量文件与算法详情/); assert.match(rendered.ready, /SHA-256：a{64}/); assert.match(rendered.ready, /快照 SHA-256：d{64}/);
  assert.match(rendered.ready, /bs1770-5-48k-stereo-fir4x-v1/); assert.match(rendered.range, /冻结范围：第 15 帧（含）至第 45 帧（不含）/); assert.match(rendered.ready, /修订版 4/);
  assert.match(rendered.ready, /48 kHz · 双声道/); assert.doesNotMatch(rendered.ready, /data-testid="export-loudness-captured-target"|data-testid="export-loudness-advice"/);
});
test('custom target shows exact needed gain and peak-room conflict, never a clamped gain or application control', () => {
  assert.match(rendered.custom, /本次参考目标：-14 LUFS · 上限 -1 dBTP/); assert.match(rendered.custom, /所需增益（算术）：\+6.00 dB/); assert.match(rendered.custom, /可用余量（已预留0\.5 dB）：\+2.94 dB/);
  assert.match(rendered.custom, /两个目标存在冲突/); assert.match(rendered.custom, /未验证当前时间线/); assert.match(rendered.custom, /须重新导出并测量/);
  assert.match(rendered.custom, /0.5 dB 的应用参考预留，不保证编码安全/); assert.doesNotMatch(rendered.custom, />(应用|归一化|自动增益|确认达标)<|已达到|响度合格/);
  assert.match(rendered.noConflict, /所需增益（算术）：-4.00 dB/); assert.doesNotMatch(rendered.noConflict, /两个目标存在冲突/);
});
test('silence, short program, and below-gate measurements remain distinct from missing audio and failures', () => {
  assert.match(rendered.silent, /数字静音：综合响度不可用/); assert.match(rendered.silent, /−∞ dBTP（数字静音）/); assert.match(rendered.silent, /−∞ dBFS（数字静音）/);
  assert.match(rendered.tooShort, /短于 400 毫秒：综合响度不可用/); assert.match(rendered.belowGate, /低于绝对门限：综合响度不可用/);
  assert.match(rendered.unsupported, /没有音轨，不能当作数字静音/);
  for (const name of ['silent','tooShort','belowGate','unsupported','incomplete']) assert.doesNotMatch(rendered[name], /综合响度：null|NaN|Infinity|data-testid="export-loudness-advice"/);
  assert.doesNotMatch(rendered.unsupported, /data-testid="export-loudness-integrated"/);
});
test('pending makes all explicit actions busy, cancel is observer-only on owned row, drafts remain editable', () => {
  for (const html of [rendered.checking, rendered.busy]) assert.match(html.match(/<button[^>]*data-testid="export-loudness-measure"[^>]*>/)?.[0] || '', /disabled/);
  assert.match(rendered.checking, /取消本次观察/); assert.doesNotMatch(rendered.busy, /取消本次观察/); assert.match(rendered.busy, /另一文件正在测量/);
  assert.doesNotMatch(rendered.checking.match(/<input[^>]*data-testid="export-loudness-target-lufs"[^>]*>/)?.[0] || '', /\sdisabled(?:=|\s|>)/);
});
test('invalid draft, cancelled, nonready, restored and disconnected states remain explicit', () => {
  assert.match(rendered.invalid, /请同时填写/); assert.match(rendered.invalid, /aria-invalid="true"/);
  assert.match(rendered.invalid.match(/<button[^>]*data-testid="export-loudness-measure"[^>]*>/)?.[0] || '', /disabled/);
  for (const name of ['unsupported','incomplete','stale','cancelled']) { assert.match(rendered[name], /data-testid="export-loudness-not-ready"/); assert.match(rendered[name], />重新测量<\/button>/); }
  assert.match(rendered.restored, /恢复分支暂不支持/); assert.doesNotMatch(rendered.restored, /<button|<input/); assert.match(rendered.offline, /连接恢复后可明确发起测量/);
});
test('named and unnamed frozen exports share row control, other render kinds do not; download links stay unchanged', () => {
  assert.equal((rendered.history.match(/data-testid="export-loudness-measure"/g) || []).length, 2);
  assert.match(rendered.history, /冻结的成片 &lt;v1&gt;/); assert.match(rendered.history, /修订版 4 · 旧快照/);
  const links = html => html.match(/<a\b[^>]*data-testid="download-export"[^>]*>/g);
  assert.deepEqual(links(rendered.history), links(rendered.withoutFeature));
});
test('layout reuses existing bounded dock row, without global CSS or widening layout', () => {
  const s = source('ExportLoudness.tsx'); assert.match(s, /import React from 'react'/); assert.match(s, /export-sample-peak export-loudness/);
  assert.match(s, /minWidth: 0, maxWidth: '100%'/); assert.doesNotMatch(s, /:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck|localStorage|sessionStorage|dangerouslySetInnerHTML/);
  const css = source('styles.css'); assert.match(css, /\.delivery-workspace \.export-sample-peak\{[^}]*min-width:0;max-width:100%/); assert.match(css, /\.export-sample-peak-actions>\.button\{[^}]*height:auto[^}]*max-width:100%[^}]*min-width:0[^}]*white-space:normal/);
});
function component() {
  const tree = (type, props, ...children) => ({ type, props: { ...props, children } }), react = { createElement: tree }; react.default = react;
  const module = { exports: {} };
  Function('module','exports','require',transformSync(source('ExportLoudness.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module,module.exports,
    name => name === './i18n/I18nProvider.tsx' ? i18n.i18nTestModule() : name === '../../../packages/i18n/src/index.ts' ? i18n : name === 'react' ? react : name === '@mioon/ui/components/button' ? { Button: 'Button' } : name === '@mioon/ui/components/input' ? { Input: 'Input' } : loudnessState);
  return module.exports.default;
}
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children)] : [];
const byTest = (tree, id) => flatten(tree).find(item => item.props?.['data-testid'] === id);
test('actual component callbacks are passive until clicked, capture draft version, and prevent late result after input edit', async () => {
  const Component = component(), f = fixture(), render = (index = 0) => Component({ exportId: f.target(index).exportId, loudness: { state: f.state(), controller: f.controller } });
  let tree = render(); assert.equal(f.calls.length, 0);
  const oldMeasure = byTest(tree,'export-loudness-measure').props.onClick;
  byTest(tree,'export-loudness-target-lufs').props.onChange({ target: { value: '-14' } });
  tree = render(); byTest(tree,'export-loudness-target-peak').props.onChange({ target: { value: '-1' } }); oldMeasure(); assert.equal(f.calls.length, 0);
  tree = render(); byTest(tree,'export-loudness-measure').props.onClick(); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].input.target, { integratedLufs: -14, truePeakCeilingDbtp: -1 });
  tree = render(); byTest(tree,'export-loudness-target-lufs').props.onChange({ target: { value: '-18' } });
  assert.equal(f.calls[0].options.signal.aborted, true); f.reads[0].resolve(report(f.target(), f.calls[0].input.target)); await Promise.resolve(); await Promise.resolve(); assert.equal(f.state().report, null); assert.equal(f.state().draft.integratedLufs, '-18');
});
test('actual cancel callback is bound to its row/attempt and cannot cancel newer work', async () => {
  const Component = component(), f = fixture(), render = index => Component({ exportId: f.target(index).exportId, loudness: { state: f.state(), controller: f.controller } });
  byTest(render(0),'export-loudness-measure').props.onClick(); const oldCancel = byTest(render(0),'export-loudness-cancel').props.onClick; oldCancel();
  assert.equal(f.calls[0].options.signal.aborted, true); byTest(render(1),'export-loudness-measure').props.onClick(); oldCancel(); assert.equal(f.calls[1].options.signal.aborted, false);
  f.reads[1].resolve(report(f.target(1))); f.reads[0].resolve(report(f.target())); await Promise.resolve(); await Promise.resolve(); assert.equal(f.state().report.exportId, f.target(1).exportId);
});
test('actual App hook wiring uses accepted live ownership, pinned invocation and exact read-only operation', async () => {
  const app = source('App.tsx'), start = app.indexOf('  function exportSamplePeakContext()'), contextEnd = app.indexOf('  const exportSamplePeak =',start);
  const hookStart = app.indexOf('  const exportLoudness ='), hookEnd = app.indexOf('  function openTimelineExport()',hookStart);
  const block = app.slice(start,contextEnd) + app.slice(hookStart,hookEnd); assert.doesNotMatch(block, /timeline\?\.revision|refresh\(|setShowExports|setRightDockTab/); assert.match(app,/loudness=\{application \? undefined : exportLoudness\}/);
  const live = context(), calls = [], dataRef = { current: { project: { id: projectId }, exports: live.exports, assets: live.assets } }, currentProject = { current: projectId };
  const workspaceRef = { current: { restored: false } }, projectEpoch = { current: 1 }, navigationEpoch = { current: 0 }, panelIntent = { current: 0 }, viewRef = { current: { activeMode: 'editing' } };
  let controller;
  const env = { workspaceOriginScope,pinNewWorkspaceIntent,workspaceRef,currentProject,projectEpoch,navigationEpoch,panelIntent,viewRef,dataRef,
    projectSessionReady: () => true,workbenchReady: true, online: true,auth: true,loading: false,rightDockTab: 'delivery',showDelivery: true,showExports: true,panelVisible: () => true,isTimelineRenderRecord,
    setAuth() { assert.fail('unexpected auth change'); }, async rpc(operation,input,options) { calls.push({operation,input,options}); return report(controller.getState().targets.find(t => t.exportId === input.exportId),input.target); },
    useExportLoudness(options) { controller = loudnessState.createExportLoudnessController(options); controller.setContext(options.context); return { state: controller.getState(),controller }; } };
  const actual = Function(...Object.keys(env),`${stripSourceTypes(block,{loader:'tsx'})};return {exportLoudness,exportSamplePeakContext};`)(...Object.values(env)); assert.equal(calls.length,0);
  const target = controller.getState().targets[1]; await controller.measure(target,controller.getState().scope,controller.getState().draftVersion);
  assert.equal(calls[0].operation,'timeline.export.loudness'); assert.equal(calls[0].input.expectedArtifactSha256,target.artifact.sha256); assert.deepEqual(Object.keys(calls[0].options),['signal']);
  projectEpoch.current++; controller.setContext(actual.exportSamplePeakContext()); assert.equal(controller.getState().report,null);
  const closed = { ...env, projectSessionReady: () => false, workbenchReady: false };
  const unopened = Function(...Object.keys(closed),`${stripSourceTypes(app.slice(start,contextEnd),{loader:'tsx'})};return exportSamplePeakContext();`)(...Object.values(closed)); assert.equal(unopened.projectId,null); assert.equal(unopened.connected,false); assert.equal(unopened.visible,false);
});
