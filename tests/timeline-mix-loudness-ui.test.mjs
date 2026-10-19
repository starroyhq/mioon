import * as i18n from './helpers/i18n.ts';
import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import * as stateModule from '../apps/web/src/timeline-mix-loudness-state.ts';
import { timelineAudioPreviewSourceIdentity } from '../apps/web/src/use-timeline-audio-preview.ts';
import { workspaceOriginScope, pinNewWorkspaceIntent } from '../apps/web/src/workspace-origin.ts';
import { fixture, context, input, report, draft, id, projectId, timelineId, sourceId } from './helpers/timeline-mix-loudness-ui-fixture.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children)] : [];
const byTest = (tree, id) => flatten(tree).find(item => item.props?.['data-testid'] === id);
function component() {
  const tree = (type, props, ...children) => ({ type, props: { ...props, children } }), react = { createElement: tree }; react.default = react;
  const module = { exports: {} };
  Function('module','exports','require',transformSync(source('TimelineMixLoudness.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module,module.exports,
    name => name === './i18n/I18nProvider.tsx' ? i18n.i18nTestModule() : name === '../../../packages/i18n/src/index.ts' ? i18n : name === 'react' ? react : name === '@mioon/ui/components/button' ? { Button: 'Button' } : name === '@mioon/ui/components/input' ? { Input: 'Input' } : stateModule);
  return module.exports.default;
}
let rendered;
before(async () => {
  const values = {};
  for (const name of ['idle','ready','conflict','silent','tooShort','outOfRange','preparing','invalid','cancelled','error','hidden','offline','restored','dirty','pending']) {
    const patches = { hidden: { visible: false }, offline: { connected: false }, restored: { restored: true }, dirty: { hasUnsavedDrafts: true }, pending: { pending: true }, tooShort: { durationFrames: 9 } };
    const f = fixture(patches[name]);
    if (['ready','conflict','silent','tooShort','outOfRange','preparing','cancelled','error'].includes(name)) f.edit(name === 'outOfRange' ? { ...draft, integratedLufs: '-5' } : name === 'conflict' ? { ...draft, integratedLufs: '-14' } : draft);
    if (['ready','conflict','tooShort'].includes(name)) await f.ready();
    if (name === 'silent') await f.ready(report(input(), context(), { silence: true }));
    if (name === 'outOfRange') await f.ready(report(input({ integratedLufs: -5, truePeakCeilingDbtp: -1 }), context(), { outOfRange: true }));
    if (name === 'preparing' || name === 'cancelled') void f.prepare();
    if (name === 'cancelled') f.cancel();
    if (name === 'invalid') f.edit({ ...draft, truePeakCeilingDbtp: '' });
    if (name === 'error') { const wait = f.prepare(); f.reads[0].reject({ code: 'TIMELINE_MIX_LOUDNESS_BUSY' }); await wait; }
    values[name] = f.state();
  }
  const fixtures = `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server.browser';
    import TimelineMixLoudness from './src/TimelineMixLoudness.tsx';
    const values = ${JSON.stringify(values)};
    const controller = {prepare(){throw Error('No automatic read');},setDraft(){throw Error('No automatic edit');},cancel(){throw Error('No automatic cancellation');}};
    export const html=Object.fromEntries(Object.entries(values).map(([name,state])=>[name,renderToStaticMarkup(<TimelineMixLoudness loudness={{state,controller}}/>)]));`;
  const script = `import {build} from 'esbuild'; const {outputFiles}=await build({stdin:{contents:${JSON.stringify(fixtures)},loader:'tsx',resolveDir:${JSON.stringify(path.join(root,'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,jsx:'transform',define:{'process.env.NODE_ENV':'"production"'}});
    const result=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));process.stdout.write(JSON.stringify(result.html));process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
});
test('compact collapsed card reuses shared controls and requires blank explicit target without opening or applying', () => {
  assert.match(rendered.idle, /<details[^>]*data-testid="timeline-mix-loudness"/); assert.doesNotMatch(rendered.idle, /<details[^>]* open|role="dialog"|aria-modal/);
  assert.match(rendered.idle, /当前整片浮点混音与固定增益候选/); assert.match(rendered.idle, /data-slot="button"/); assert.match(rendered.idle, /data-slot="input"/);
  assert.equal((rendered.idle.match(/value=""/g) || []).length, 2); assert.match(rendered.idle.match(/<button[^>]*data-testid="timeline-mix-loudness-prepare"[^>]*>/)[0], /disabled/);
  assert.match(rendered.idle, /不预设平台标准/); assert.match(rendered.idle, /始终测量整片，不使用本次所选导出范围/);
  assert.match(rendered.idle, /编码前浮点混音，不是已导出文件/); assert.match(rendered.idle, /不会修改音量或创建导出任务/); assert.match(rendered.idle, /不代表已实现逐段响度统一/);
  assert.doesNotMatch(rendered.idle, />(应用|统一响度|自动增益|导出候选)<|data-testid="timeline-mix-loudness-target-error"/);
});
test('original and actual rerendered candidate remain distinct with measured target/peak comparison and explicit 0.5dB reserve', () => {
  assert.match(rendered.ready, /原始整片浮点混音：-20.00 LUFS/); assert.match(rendered.ready, /重新渲染的固定增益候选：-24.00 LUFS/);
  assert.match(rendered.ready, /单一固定增益：-4.00 dB/); assert.match(rendered.ready, /覆盖 1 个可听片段/);
  assert.match(rendered.ready, /本次目标：-24 LUFS · 上限 -1 dBTP；额外预留 0.5 dB/);
  assert.match(rendered.ready, /真峰值含 0.5 dB 预留后满足上限：是/); assert.match(rendered.conflict, /真峰值含 0.5 dB 预留后满足上限：否/);
  assert.match(rendered.conflict, /未同时满足两个参考目标，未降低目标或限幅/); assert.doesNotMatch(rendered.ready, /data-testid="timeline-mix-loudness-conflict"/);
  assert.match(rendered.ready, /<details><summary>本次快照、来源与增益详情/); assert.match(rendered.ready, /快照 SHA-256：b{64}/);
  assert.match(rendered.ready, /报告不授予应用权限/); assert.match(rendered.ready, /不保证 AAC 编码后的峰值/);
});
test('unavailable, preparing, cancelled and failed observations never display a fabricated candidate', () => {
  assert.match(rendered.silent, /数字静音：综合响度不可用/); assert.match(rendered.silent, /原混音没有可用的综合响度/); assert.match(rendered.silent, /−∞ dBTP/);
  assert.match(rendered.tooShort, /短于 400 毫秒：综合响度不可用/); assert.match(rendered.outOfRange, /超出支持范围，未夹紧或修改增益/);
  assert.match(rendered.preparing, /取消本次观察/); assert.match(rendered.cancelled, /只读观察已取消/); assert.match(rendered.error, /本次未排队/);
  assert.match(rendered.invalid, /aria-invalid="true"/); assert.match(rendered.invalid, /role="alert"/);
  for (const name of ['silent','tooShort','outOfRange','preparing','cancelled','error']) assert.doesNotMatch(rendered[name], /data-testid="timeline-mix-loudness-candidate"|NaN|Infinity/);
  for (const name of ['hidden','offline','restored','dirty','pending']) assert.equal(rendered[name], '');
});
test('actual component callbacks capture targets/context/version and invalidate late results after target edits', async () => {
  const Component = component(), f = fixture(), render = () => Component({ loudness: { state: f.state(), controller: f.controller } });
  let tree = render(), oldPrepare = byTest(tree,'timeline-mix-loudness-prepare').props.onClick; assert.equal(f.calls.length, 0);
  byTest(tree,'timeline-mix-loudness-target-lufs').props.onChange({ target: { value: '-24' } });
  tree = render(); byTest(tree,'timeline-mix-loudness-target-peak').props.onChange({ target: { value: '-1' } }); oldPrepare(); assert.equal(f.calls.length, 0);
  tree = render(); byTest(tree,'timeline-mix-loudness-prepare').props.onClick(); assert.deepEqual(f.calls[0].input, input());
  tree = render(); byTest(tree,'timeline-mix-loudness-target-lufs').props.onChange({ target: { value: '-18' } });
  f.reads[0].resolve(report(f.calls[0].input)); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state().report, null); assert.equal(f.state().draft.integratedLufs, '-18');
});
test('actual component cancel/navigation/project/revision/source callbacks cannot affect a new observation', async () => {
  const Component = component();
  for (const patch of [{ visible: false }, { executionScope: 'navigate' }, { projectId: id(98) }, { revision: 5 }, { sourceIdentity: 'new-source' }]) {
    const f = fixture(); f.edit(); const tree = Component({ loudness: { state: f.state(), controller: f.controller } });
    f.set(patch, false); byTest(tree,'timeline-mix-loudness-prepare').props.onClick(); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.edit(); let tree = Component({ loudness: { state: f.state(), controller: f.controller } });
  byTest(tree,'timeline-mix-loudness-prepare').props.onClick(); tree = Component({ loudness: { state: f.state(), controller: f.controller } });
  const oldCancel = byTest(tree,'timeline-mix-loudness-cancel').props.onClick; oldCancel();
  tree = Component({ loudness: { state: f.state(), controller: f.controller } }); byTest(tree,'timeline-mix-loudness-prepare').props.onClick(); oldCancel();
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.calls[1].options.signal.aborted, false); f.controller.dispose();
});
test('actual details close clears a report or pending observation, and reopening never prepares', async () => {
  const Component = component(), f = fixture(); f.edit(); await f.ready();
  let tree = Component({ loudness: { state: f.state(), controller: f.controller } });
  tree.props.onToggle({ currentTarget: { open: false } }); assert.equal(f.state().report, null);
  tree.props.onToggle({ currentTarget: { open: true } }); assert.equal(f.calls.length, 1);
  const pending = f.prepare(); tree = Component({ loudness: { state: f.state(), controller: f.controller } });
  tree.props.onToggle({ currentTarget: { open: false } }); assert.equal(f.calls[1].options.signal.aborted, true);
  f.reads[1].resolve(report(f.calls[1].input)); await pending; assert.equal(f.state().report, null);
});
test('actual App wiring reads saved snapshot, pinned workspace and live draft controllers without crossing export extractor markers', async () => {
  const app = source('App.tsx'), first = app.indexOf('  function timelineMixLoudnessContext()'), end = app.indexOf('  const nativePreviewPause =', first);
  assert.ok(first > 0 && end > first); assert.ok(end < app.indexOf('  function checkTimelineExport('));
  assert.match(app, /<TimelineMixLoudness loudness=\{timelineMixLoudness\} /);
  const saved = { id: timelineId, projectId, revision: 4, durationFrames: 60, fps: 30,
    tracks: [{ id: id(7), kind: 'audio', orderIndex: 0, muted: false, hidden: false }],
    clips: [{ id: id(4), trackId: id(7), assetId: sourceId, startFrame: 0, sourceInFrame: 0, durationFrames: 60, gain: .5 }] };
  const dataRef = { current: { project: { id: projectId }, timeline: saved, assets: [{ id: sourceId, projectId, sha256: 'a'.repeat(64), sizeBytes: 128, mimeType: 'audio/wav', hasAudio: true }] } };
  let dirty = false, controller; const calls = [];
  const env = { application: null, showDelivery: false, workspaceOriginScope, pinNewWorkspaceIntent, timelineAudioPreviewSourceIdentity, dataRef,
    workspaceRef: { current: { restored: false } }, currentProject: { current: projectId }, projectEpoch: { current: 1 }, navigationEpoch: { current: 0 }, panelIntent: { current: 0 }, viewRef: { current: { activeMode: 'editing' } },
    projectSessionReady: () => true, workbenchReady: true, online: true, auth: true, loading: false, rightDockTab: 'delivery', showExports: false, panelVisible: () => true,
    clipDirty: false, subtitleDirty: false, formatDirty: false, timelineBusy: false, isBusy: () => false,
    clipDraftRef: { current: { hasUnsaved: () => dirty, getState: () => ({ candidate: null }) } }, subtitlesRef: { current: null }, timelineFormatRef: { current: null }, setAuth() { assert.fail('Unexpected auth change'); },
    async rpc(operation, input, options) { calls.push({ operation, input, options }); return report(input); },
    useTimelineMixLoudness(options) { controller = stateModule.createTimelineMixLoudnessController(options); controller.attach(options.context); return { state: controller.getState(), controller }; } };
  const actual = Function(...Object.keys(env), `${app.slice(first,end)};return {timelineMixLoudness,timelineMixLoudnessContext};`)(...Object.values(env));
  assert.equal(calls.length, 0); controller.setDraft(draft, controller.getState()); await controller.prepare(controller.getState());
  assert.equal(calls[0].operation, 'timeline.loudness.prepare'); assert.deepEqual(calls[0].input, input()); assert.deepEqual(Object.keys(calls[0].options), ['signal']);
  dirty = true; assert.equal(await controller.prepare(controller.getState()), null); assert.equal(controller.getState().report, null);
  dirty = false; controller.setContext(actual.timelineMixLoudnessContext()); dataRef.current.assets[0].sha256 = 'c'.repeat(64);
  assert.notEqual(actual.timelineMixLoudnessContext().sourceIdentity, controller.getState().sourceIdentity);
  const unopened = { ...env, projectSessionReady: () => false, workbenchReady: false };
  const onlyContext = app.slice(first, app.indexOf('  const timelineMixLoudness =', first));
  const unavailable = Function(...Object.keys(unopened), `${onlyContext};return timelineMixLoudnessContext();`)(...Object.values(unopened));
  assert.equal(unavailable.projectId, null); assert.equal(unavailable.connected, false); assert.equal(unavailable.visible, false);
});
