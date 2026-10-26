import type {ExportSamplePeakController,ExportSamplePeakContext,ExportSamplePeakState,ExportSamplePeakReadOptions} from '../apps/web/src/export-sample-peak-state.ts';
import type {ElementModule} from './helpers/strict-timeline-audio-harness-types.ts';
import type {ElementTree, ElementNode} from './helpers/strict-timeline-audio-harness-types.ts';
import * as i18n from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const app = () => readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
test('App wires one explicit historical-file observer with live project/workspace/navigation fences', () => {
  const source = app();
  assert.equal(source.includes('useExportSamplePeak'), true, 'App must wire the explicit history observer');
  assert.match(source, /rpc\('timeline\.export\.samplePeak', input, options as never\)/);
  assert.match(source, /samplePeak=\{application \? undefined : exportSamplePeak(?: as never)?\}/);
});

import { before } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { isTimelineRenderRecord } from '@mioon/contracts';
import { pinNewWorkspaceIntent, workspaceOriginScope } from '../apps/web/src/workspace-origin.ts';
import { createExportSamplePeakController, EXPORT_SAMPLE_PEAK_LABEL, type ExportSamplePeakControllerOptions } from '../apps/web/src/export-sample-peak-state.ts';
import {context,fixture,row,report} from './helpers/strict-export-sample-peak-types.ts';
import {asset,unready,projectId,id} from './helpers/export-sample-peak-ui-fixture.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
let rendered: Record<string,string>, fileActions: {history:unknown[];withoutFeature:unknown[]}, actualFileActions: string[];
before(async () => {
  const values:Record<string,{exportId:string;state:ExportSamplePeakState}> = {};
  for (const name of ['idle', 'ready', 'silent', 'over', 'checking', 'busy', 'unsupported', 'incomplete', 'stale', 'cancelled', 'restored', 'offline']) {
    const f = fixture(name === 'restored' ? { restored: true } : name === 'offline' ? { connected: false } : {});
    if (name === 'ready') await f.ready();
    if (name === 'silent') await f.ready(report(f.target(), 0, 0));
    if (name === 'over') await f.ready(report(f.target(), 1.25, 0.5));
    if (name === 'checking' || name === 'busy') void f.check();
    if (name === 'unsupported') await f.ready(unready(f.target(), 'unsupported', 'UNSUPPORTED_FORMAT'));
    if (name === 'incomplete') await f.ready(unready(f.target(), 'incomplete', 'TIMEOUT'));
    if (name === 'stale') await f.ready(unready(f.target(), 'stale', 'ARTIFACT_CHANGED'));
    if (name === 'cancelled') { void f.check(); f.controller.cancel(); }
    values[name] = { exportId: f.target(name === 'busy' ? 1 : 0).exportId, state: f.state() };
  }
  const all = context();
  const previews = { ...row(20), purpose: 'preview' }, story = { ...row(21), mode: 'storyboard' }, running = { ...row(22), status: 'running', assetId: null, url: null };
  const historyProps = { orderedExports: [...all.exports, previews, story, running], projectName: '当前项目新名称', timelineRevision: 99, state: values.idle.state };
  const fixtures = `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import ExportSamplePeak from './src/ExportSamplePeak.tsx';
    import ExportHistoryList from './src/ExportHistoryList.tsx';
    import ActualExportFileActions from 'test:actual-export-file-actions';
    const values = ${JSON.stringify(values)}, props = ${JSON.stringify(historyProps)};
    const controller = { check() { throw Error('Rendering may not dispatch a check'); }, cancel() { throw Error('Rendering may not cancel a render'); } };
    export const html = Object.fromEntries(Object.entries(values).map(([name, {exportId,state}]) => [name, renderToStaticMarkup(<ExportSamplePeak exportId={exportId} samplePeak={{state,controller}} />)]));
    globalThis.__capturedExportFileActions = [];
    html.history = renderToStaticMarkup(<ExportHistoryList {...props} samplePeak={{ state: props.state, controller }} />);
    export const actions = {history:globalThis.__capturedExportFileActions};
    globalThis.__capturedExportFileActions = [];
    html.withoutFeature = renderToStaticMarkup(<ExportHistoryList {...props} />);
    actions.withoutFeature = globalThis.__capturedExportFileActions;
    export const actualFileActions = actions.history.map(props => renderToStaticMarkup(<ActualExportFileActions {...props} />));`;
  // Observe only the history-to-file-action handoff. A separate real SSR
  // render proves no enabled file is already claimed present at this boundary.
  const capture = `import React from 'react'; export default function Capture(props) {
    globalThis.__capturedExportFileActions.push({...props});
    return React.createElement('span', {'data-testid':'captured-export-file-actions'});
  }`;
  const script = `import {build} from 'esbuild';
    globalThis.fetch = () => {throw Error('History presentation must never request data');};
    const {outputFiles} = await build({stdin:{contents:${JSON.stringify(fixtures)},loader:'tsx',resolveDir:${JSON.stringify(path.join(root, 'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,jsx:'transform',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'capture-file-action-props',setup(build){
      build.onResolve({filter:/^test:actual-export-file-actions$/},()=>({path:${JSON.stringify(path.join(root,'apps/web/src/ExportFileActions.tsx'))}}));
      build.onResolve({filter:/ExportFileActions\\.tsx$/},()=>({path:'capture',namespace:'file-action-capture'}));
      build.onLoad({filter:/.*/,namespace:'file-action-capture'},()=>({contents:${JSON.stringify(capture)},loader:'tsx',resolveDir:${JSON.stringify(path.join(root,'apps/web'))}}));
    }}]});
    const result = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));process.stdout.write(JSON.stringify({html:result.html,actions:result.actions,actualFileActions:result.actualFileActions}));process.exit(0);`;
  ({html:rendered, actions:fileActions, actualFileActions} = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 })));
});

test('classic TSX real shared controls show exact feature name with compact explicit action and polite status', () => {
  assert.match(rendered.idle, /data-slot="button"/); assert.match(rendered.idle, /aria-label="检查已导出文件解码样本峰值"/); assert.match(rendered.idle, />检查<\/button>/);
  assert.match(rendered.idle, /role="status" aria-live="polite" aria-atomic="true"/); assert.match(rendered.idle, /不是响度或真峰值/); assert.match(rendered.idle, /不能证明源音频或混音未削波/);
  assert.doesNotMatch(rendered.idle, /role="dialog"|aria-modal|已解码检查此成片|dBFS|安全|无削波|响度合格/);
});
test('ready shows overall and distinct left/right decoded peaks plus verified hash and timestamp', () => {
  assert.match(rendered.ready, /总体：-6.0206 dBFS/); assert.match(rendered.ready, /左声道：-6.0206 dBFS/); assert.match(rendered.ready, /右声道：-12.0412 dBFS/);
  assert.match(rendered.ready, /已解码检查此成片/); assert.match(rendered.ready, /<time dateTime="2026-10-13T04:20:00.000Z"/); assert.match(rendered.ready, /SHA-256：a{64}/);
  assert.match(rendered.ready, /总体 0.5；左 0.5；右 0.25/); assert.match(rendered.ready, /冻结修订版：4/); assert.match(rendered.ready, /<details><summary>检查文件详情/);
});
test('silence uses explicit minus-infinity while over-one warning remains advisory and textual', () => {
  assert.equal((rendered.silent.match(/−∞ dBFS（数字静音）/g) || []).length, 3); assert.doesNotMatch(rendered.silent, /null|Infinity|NaN/);
  assert.match(rendered.over, /总体：\+1.9382 dBFS/); assert.match(rendered.over, /样本峰值超过 0 dBFS；可能存在过载风险/); assert.match(rendered.over, /不能证明源音频或混音未削波/);
  assert.doesNotMatch(rendered.over, /削波次数|data-testid="download-export"/);
});
test('all row actions reflect busy; cancel is explicit and only appears on the checked row', () => {
  for (const html of [rendered.checking, rendered.busy]) assert.match(html.match(/<button[^>]*data-testid="export-sample-peak-check"[^>]*>/)?.[0] || '', /disabled/);
  assert.match(rendered.checking, /正在检查已导出文件解码样本峰值/); assert.match(rendered.checking, /取消本次检查/);
  assert.match(rendered.busy, /另一文件正在检查/); assert.doesNotMatch(rendered.busy, /取消本次检查/);
});
test('nonready statuses keep numeric claims absent and explicit recheck available', () => {
  for (const name of ['unsupported', 'incomplete', 'stale', 'cancelled']) {
    const html = rendered[name]; assert.match(html, /data-testid="export-sample-peak-not-ready"/); assert.match(html, />重新检查<\/button>/);
    assert.doesNotMatch(html, /data-testid="export-sample-peak-overall"|已解码检查此成片|SHA-256/);
  }
  assert.match(rendered.offline, /连接恢复后可明确发起检查/); assert.match(rendered.offline, /disabled/);
  assert.match(rendered.restored, /恢复分支暂不支持已导出文件解码样本峰值检查/); assert.doesNotMatch(rendered.restored, /<button/);
});
test('historical peak actions leave immutable file inspection inputs intact while preview keeps its original download', () => {
  assert.equal((rendered.history.match(/data-testid="export-sample-peak-check"/g) || []).length, 2);
  assert.equal(fileActions.history.length, 4);
  assert.match(rendered.history, /冻结的成片 &lt;v1&gt;/); assert.match(rendered.history, /修订版 4 · 旧快照/); assert.match(rendered.history, /export-history-range/);
  assert.deepEqual(fileActions.history, fileActions.withoutFeature, 'Peak observation cannot change file ownership, URL or recovery admission');
  assert.deepEqual(fileActions.history, [
    {projectId, exportId:id(10), downloadHref:`/media/${id(110)}`, disabled:false},
    {projectId, exportId:id(11), downloadHref:`/media/${id(111)}?download=1&exportId=${id(11)}`, disabled:false},
    {projectId, exportId:id(20), downloadHref:`/media/${id(120)}`, disabled:true},
    {projectId, exportId:id(21), downloadHref:`/media/${id(121)}`, disabled:false},
  ]);
  assert.doesNotMatch(rendered.history, /data-testid="download-export"/);
  for (const [index, html] of actualFileActions.entries()) {
    if (index === 2) {
      assert.match(html, new RegExp(`href="/media/${id(120)}"`));
      assert.match(html, /data-testid="download-export"/); assert.match(html, /download=""/);
      assert.doesNotMatch(html, /export-file-check/);
    } else {
      assert.match(html, /data-testid="export-file-check"/);
      assert.doesNotMatch(html, /download-export|href=|download=/);
    }
  }
});
test('new TSX imports React explicitly and scopes wrapping to narrow existing delivery dock', () => {
  const source = readFileSync(new URL('../apps/web/src/ExportSamplePeak.tsx', import.meta.url), 'utf8');
  assert.match(source, /import React from 'react'/); assert.doesNotMatch(source, /:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck|localStorage|sessionStorage/);
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.export-sample-peak-actions>\.button\{[^}]*height:auto[^}]*max-width:100%[^}]*min-width:0[^}]*white-space:normal[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.export-sample-peak summary:focus-visible\{outline:2px/);
});
test('actual App context uses current refs, transport option shape, and frozen rows rather than current timeline', async () => {
  const source = app(), start = source.indexOf('  function exportSamplePeakContext()'), end = source.indexOf('  function checkTimelineExport(', start), block = source.slice(start, end);
  assert.doesNotMatch(block, /timeline\?\.revision|setRightDockTab|setShowExports|refresh\(/);
  const live = context(), calls: {operation:string;input:{projectId:string;exportId:string};options:ExportSamplePeakReadOptions}[] = [], dataRef = { current: { project: { id: projectId }, exports: live.exports, assets: live.assets } }, currentProject = { current: projectId };
  const workspaceRef = { current:{restored:false} as {restored:boolean;workspaceOrigin?:string} }, projectEpoch = { current: 1 }, navigationEpoch = { current: 0 }, panelIntent = { current: 0 }, viewRef = { current: { activeMode: 'editing' } };
  let controller:ExportSamplePeakController;
  const environment = { workspaceOriginScope, pinNewWorkspaceIntent, workspaceRef, currentProject, projectEpoch, navigationEpoch, panelIntent, viewRef, dataRef,
    projectSessionReady: () => true, workbenchReady: true,
    online: true, auth: true, loading: false, showDelivery: true, showExports: true, isTimelineRenderRecord,
    setAuth() { assert.fail('unexpected auth mutation'); }, async rpc(operation:string,input:{projectId:string;exportId:string},options:ExportSamplePeakReadOptions) { calls.push({ operation, input, options }); return report(controller.getState().targets.find((target: { exportId: unknown; }) => target.exportId === input.exportId)!); },
    useExportSamplePeak(options:ExportSamplePeakControllerOptions&{context:ExportSamplePeakContext}) { controller = createExportSamplePeakController(options); controller.setContext(options.context); return { state: controller.getState(), controller }; } };
  const actual = (Function(...Object.keys(environment), `${block};return {exportSamplePeak,exportSamplePeakContext};`)(...Object.values(environment)) as {exportSamplePeakContext():ExportSamplePeakContext});
  assert.equal(calls.length, 0); assert.equal(actual.exportSamplePeakContext().scope, `${projectId}:1:normal`);
  const target = controller!.getState().targets[1]; await controller!.check(target, controller!.getState().scope);
  assert.equal(calls[0].operation, 'timeline.export.samplePeak'); assert.deepEqual(calls[0].input, { projectId, exportId: target.exportId }); assert.deepEqual(Object.keys(calls[0].options), ['signal']);
  assert.equal(controller!.getState().report!.artifact!.deliveryName, '冻结的成片 <v1>');
  const contextBlock = block.slice(0, block.indexOf('  const exportSamplePeak ='));
  for (const closed of [{showDelivery:false}, {showExports:false}]) {
    const hiddenEnvironment = {...environment, ...closed};
    const hidden = (Function(...Object.keys(hiddenEnvironment), `${contextBlock};return exportSamplePeakContext();`)(...Object.values(hiddenEnvironment)) as ExportSamplePeakContext);
    assert.equal(hidden.visible, false);
    const blocked = createExportSamplePeakController(({getContext:() => hidden, isRenderRecord:isTimelineRenderRecord, read() {assert.fail('A closed history cannot start a retained file check');}} as unknown as Parameters<typeof createExportSamplePeakController>[0]));
    blocked.setContext((hidden as unknown as Parameters<typeof blocked.setContext>[0])); await blocked.check(target, hidden.scope); assert.equal(calls.length, 1);
  }
  const unopenedEnvironment = { ...environment, projectSessionReady: () => false, workbenchReady: false };
  const unopened = (Function(...Object.keys(unopenedEnvironment), `${contextBlock};return exportSamplePeakContext();`)(...Object.values(unopenedEnvironment)) as ExportSamplePeakContext);
  assert.equal(unopened.projectId, null); assert.equal(unopened.connected, false); assert.equal(unopened.visible, false);
  const blocked = createExportSamplePeakController(({ getContext: () => unopened, isRenderRecord: isTimelineRenderRecord,
    read() { assert.fail('Unaccepted project data cannot start historical-file observation'); } } as unknown as Parameters<typeof createExportSamplePeakController>[0]));
  blocked.setContext((unopened as unknown as Parameters<typeof blocked.setContext>[0])); await blocked.check(target, unopened.scope); assert.equal(calls.length, 1);
  projectEpoch.current++; controller!.setContext(actual.exportSamplePeakContext()); assert.equal(controller!.getState().report, null);
  workspaceRef.current = { restored: true, workspaceOrigin: id(88) }; controller!.setContext(actual.exportSamplePeakContext());
  await controller!.check(controller!.getState().targets[0], controller!.getState().scope); assert.equal(calls.length, 1);
});
test('actual action and cancel callbacks do no work until clicked and retain checked target/scope', () => {
  const source = readFileSync(new URL('../apps/web/src/ExportSamplePeak.tsx', import.meta.url), 'utf8');
  const tree = (type: unknown, props:Record<string,unknown>|null, ...children: ElementTree[]) => ({ type, props: { ...props, children } });
  const react = { createElement: tree }; (react as typeof react & {default: unknown}).default = react; const module = ({ exports: {} } as ElementModule);
  Function('module', 'exports', 'require', transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module, module.exports,
(    name: string) => name === './i18n/I18nProvider.tsx' ? i18n.i18nTestModule() : name === '../../../packages/i18n/src/index.ts' ? i18n : name === 'react' ? react : name === '@mioon/ui/components/button' ? { Button: 'Button' } : { EXPORT_SAMPLE_PEAK_LABEL, EXPORT_SAMPLE_PEAK_LIMITATION: 'limitation', EXPORT_SAMPLE_PEAK_RESTORED: 'restored', exportSamplePeakStatusMessage: () => 'checking' });
  const f = fixture(), calls: (unknown[] | string[])[] = []; const state = { ...f.state(), phase: 'checking', targetId: f.target().exportId, targetKey: f.target().key };
  const result = module.exports.default({ exportId: f.target().exportId, samplePeak: { state, controller: { check: (...args: unknown[]) => calls.push(['check', ...args]), cancel: () => calls.push(['cancel']) } } });
  const flatten = (value: ElementTree): ElementNode[] => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children)] : [];
  const buttons = flatten(result).filter((item:ElementNode) => item.type === 'Button'); assert.equal(calls.length, 0);
  buttons.find((item:ElementNode) => item.props['data-testid'] === 'export-sample-peak-check')!.props.onClick();
  buttons.find((item:ElementNode) => item.props['data-testid'] === 'export-sample-peak-cancel')!.props.onClick();
  assert.deepEqual(calls, [['check', f.target(), state.scope], ['cancel']]);
});
