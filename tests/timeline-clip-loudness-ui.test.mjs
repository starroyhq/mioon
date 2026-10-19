import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import * as i18n from './helpers/i18n.ts';
import * as stateModule from '../apps/web/src/timeline-clip-loudness-state.ts';
import * as contract from '@mioon/contracts/timeline-clip-loudness';
import { fixture, context, report, silentClipLoudness, id } from './helpers/timeline-clip-loudness-ui-fixture.ts';
import { savedClipLoudnessFields } from '../apps/web/src/timeline-clip-loudness-context.ts';
import { clipLoudnessMessages } from '../packages/i18n/src/catalogs/clip-loudness.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children)] : [];
const byTest = (tree, id) => flatten(tree).find(item => item.props?.['data-testid'] === id);
function component(locale = 'zh-Hans') {
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }; react.default = react;
  const module = { exports: {} };
  Function('module','exports','require',transformSync(source('TimelineClipLoudness.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module,module.exports,
    name => name.includes('I18nProvider') ? i18n.i18nTestModule(locale) : name === 'react' ? react : name.includes('/button') ? { Button: 'Button' } : name.startsWith('@mioon/contracts') ? contract : stateModule);
  return module.exports.default;
}
let rendered;
before(async () => {
  const values = {};
  const patches = { hidden: { visible: false }, offline: { connected: false }, restored: { restored: true }, dirty: { hasUnsavedDrafts: true }, pending: { pending: true },
    muted: { muted: true }, zero: { gain: 0 }, noAudio: { audioSupported: false }, long: { durationFrames: contract.TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames + 1 } };
  for (const name of ['idle','ready','silent','tooShort','belowGate','preparing','cancelled','error',...Object.keys(patches)]) {
    const f = fixture(name === 'tooShort' ? { durationFrames: 9 } : patches[name]);
    if (name === 'ready') await f.ready();
    if (name === 'silent') await f.ready(silentClipLoudness());
    if (name === 'tooShort' || name === 'belowGate') {
      const value = report();
      Object.assign(value.measurement, { integratedLufs: null, absoluteGatedBlockCount: 0, relativeGatedBlockCount: 0, relativeGateLufs: null, state: name === 'tooShort' ? 'too_short' : 'below_gate' });
      if (name === 'tooShort') {
        Object.assign(value.identity, { durationFrames: 9, measurementEndFrame: 9 });
        Object.assign(value.measurement, { sampleFrames: 14400, decodedDurationSeconds: .3, gatingBlockCount: 0 });
        Object.assign(value.checks, { pcmBytes: 115200, decodeWorkFrames: 10 });
      }
      await f.ready(value);
    }
    if (name === 'preparing' || name === 'cancelled') void f.prepare();
    if (name === 'cancelled') f.cancel();
    if (name === 'error') { const wait = f.prepare(); f.reads[0].reject({ code: 'TIMELINE_CLIP_LOUDNESS_BUSY' }); await wait; }
    values[name] = f.state();
  }
  const fixtures = `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server.browser';
    import TimelineClipLoudness from './src/TimelineClipLoudness.tsx';
    const values = ${JSON.stringify(values)};
    const controller = {prepare(){throw Error('No automatic read');},cancel(){throw Error('No automatic cancellation');},revoke(){throw Error('No automatic revoke');}};
    export const html=Object.fromEntries(Object.entries(values).map(([name,state])=>[name,renderToStaticMarkup(<TimelineClipLoudness loudness={{state,controller}}/>)]));`;
  const script = `import {build} from 'esbuild'; const {outputFiles}=await build({stdin:{contents:${JSON.stringify(fixtures)},loader:'tsx',resolveDir:${JSON.stringify(path.join(root,'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,jsx:'transform',define:{'process.env.NODE_ENV':'"production"'}});
    const result=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));process.stdout.write(JSON.stringify(result.html));process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
});
test('actual SSR card is collapsed, opt-in, saved-only and has no target/gain suggestion/apply controls', () => {
  assert.match(rendered.idle, /<details[^>]*data-testid="timeline-clip-loudness"/); assert.doesNotMatch(rendered.idle, /<details[^>]* open|<input|role="dialog"/);
  assert.match(rendered.idle, /最长 60 秒/); assert.match(rendered.idle, /不会自动裁短或替换范围/);
  assert.match(rendered.idle, /不是整片混音或已导出文件/); assert.match(rendered.idle, /不修改音量/); assert.match(rendered.idle, /未实现逐段响度统一/);
  assert.match(rendered.idle, /报告仅临时显示/); assert.match(rendered.idle, /估算真峰值不保证混音或 AAC 编码后的峰值/);
  assert.doesNotMatch(rendered.idle.match(/<button[^>]*data-testid="clip-loudness-analyze"[^>]*>/)[0], /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(rendered.idle, /data-testid="[^"]*(?:apply|target|candidate)/);
});
test('measured report displays existing units/status and exact saved ranges/gain/fades/profile', () => {
  assert.match(rendered.ready, /-20.00 LUFS/); assert.match(rendered.ready, /-4.44 dBTP/); assert.match(rendered.ready, /-6.02 dBFS/);
  assert.match(rendered.ready, /\[17, 47\)/); assert.match(rendered.ready, /\[6, 36\)/); assert.match(rendered.ready, /\[0, 30\)/);
  assert.match(rendered.ready, /增益 ×0.75/); assert.match(rendered.ready, /淡入 3 帧，淡出 4 帧/);
  assert.match(rendered.ready, /isolated_clip_post_gain_fades_pre_mix/); assert.match(rendered.ready, /bs1770-5-48k-stereo-fir4x-v1/);
  assert.match(rendered.ready, /timeline-isolated-clip-float-v1/); assert.match(rendered.ready, /48000 个样本帧/); assert.match(rendered.ready, /-30.00 LUFS/); assert.match(rendered.ready, /7/);
  assert.match(rendered.silent, /数字静音/); assert.match(rendered.silent, /−∞ dBTP/); assert.doesNotMatch(rendered.silent, /NaN|Infinity/);
  assert.match(rendered.tooShort, /短于 400 毫秒/); assert.match(rendered.belowGate, /门限/);
  for (const name of ['tooShort', 'belowGate']) { assert.doesNotMatch(rendered[name], /-20.00 LUFS|NaN|Infinity/); assert.match(rendered[name], /-4.44 dBTP/); }
});
test('disabled saved-only cases explain why without reporting a fabricated silence; hidden unmounts UI', () => {
  assert.equal(rendered.hidden, '');
  for (const name of ['offline','restored','dirty','pending','muted','zero','noAudio','long']) {
    assert.match(rendered[name].match(/<button[^>]*data-testid="clip-loudness-analyze"[^>]*>/)[0], /\sdisabled(?:=|\s|>)/);
    assert.doesNotMatch(rendered[name], /data-testid="clip-loudness-measurement"/);
  }
  assert.match(rendered.preparing, /data-testid="clip-loudness-cancel"/); assert.match(rendered.cancelled, /只读观察已取消/);
  assert.match(rendered.error, /本次未排队/);
});
test('actual component Analyze and Cancel callbacks retain captured selection/version and cannot revive A→B→A', async () => {
  const C = component(), f = fixture(), render = () => C({ loudness: { state: f.state(), controller: f.controller } });
  const first = render(), oldAnalyze = byTest(first, 'clip-loudness-analyze').props.onClick;
  assert.equal(f.calls.length, 0); oldAnalyze(); const oldCancel = byTest(render(), 'clip-loudness-cancel').props.onClick;
  const oldId = f.state().clipId; f.set({ clipId: id(8), executionScope: '2' }); f.set({ clipId: oldId, executionScope: '3' });
  oldAnalyze(); assert.equal(f.calls.length, 1); byTest(render(), 'clip-loudness-analyze').props.onClick(); oldCancel(); assert.equal(f.calls[1].options.signal.aborted, false);
  f.reads[0].resolve(report()); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state().report, null);
  f.reads[1].resolve(report()); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state().phase, 'ready');
  render().props.onToggle({ currentTarget: { open: false } }); assert.equal(f.state().report, null);
});
test('four locale component labels/statuses and placeholders are present, zh-Hant is region-neutral', () => {
  for (const locale of ['zh-Hans','zh-Hant','en','ja']) {
    const C = component(locale), f = fixture(), tree = C({ loudness: { state: f.state(), controller: f.controller } });
    assert.equal(byTest(tree, 'clip-loudness-analyze').props.children[0], i18n.translate(locale, 'audio.loudness.clip.analyze'));
    for (const [key, entry] of Object.entries(clipLoudnessMessages)) {
      assert.ok(entry[locale].trim(), key); assert.deepEqual([...entry[locale].matchAll(/\{(\w+)\}/g)].map(v => v[1]).sort(), [...entry.en.matchAll(/\{(\w+)\}/g)].map(v => v[1]).sort(), key);
    }
  }
});
test('actual host binds selected saved clip and shared RPC; comparison/source overlays and draft conflicts fence analysis', () => {
  const app = source('App.tsx'), inspector = source('TimelineInspector.tsx'), api = source('api.ts');
  assert.match(app, /savedClipLoudnessFields\(saved, dataRef.current!.assets, editing.selectedClipId\)/);
  assert.match(app, /clipLoudnessEpoch.current\+\+/); assert.match(app, /!previewAssetRef.current && !comparisonIdRef.current && !webSettingsOpen/);
  assert.match(app, /loudnessContext=\{clipLoudnessContext(?: as never)?\}/); assert.match(app, /loudnessInvocation=\{\(\) => pinNewWorkspaceIntent\(\{\}, workspaceRef.current\)\}/);
  assert.match(inspector, /<ClipAudioControls[^>]*\/>/); assert.match(inspector, /\{!opacity && loudnessContext && <ClipLoudnessObservation/);
  assert.match(inspector, /clipLoudnessDraftContext\(pass\(scopedContext\(\)\) as never, draftController\.getState\(\), visible\)/);
  assert.match(inspector, /rpc\('timeline.clip.loudness', input, options\)/);
  assert.match(api, /readTimelineClipLoudnessRpc\(input, \{ \.\.\.invocation, signal, fetch: fetcher \} as TimelineClipLoudnessWireOptions\)/);
  assert.doesNotMatch(source('TimelineClipLoudness.tsx'), /localStorage|sessionStorage|timeline\.loudness\.apply|nativeAdmission|setDraft/);
});

test('actual Analyze callback admits false/unknown video metadata and displays only authoritative backend failure', async () => {
  const C = component();
  for (const hasAudio of [false, undefined]) {
    const i = report().identity, saved = savedClipLoudnessFields({ id: report().timelineId, revision: 4,
      clips: [{ id: report().clipId, ...i }], tracks: [{ id: i.trackId, muted: false }] },
      [{ id: i.assetId, sha256: i.assetSha256, mimeType: 'video/mp4', hasAudio }], report().clipId);
    const f = fixture(saved), tree = C({ loudness: { state: f.state(), controller: f.controller } });
    const button = byTest(tree, 'clip-loudness-analyze'); assert.equal(button.props.disabled, false); assert.equal(f.calls.length, 0);
    button.props.onClick(); assert.equal(f.calls.length, 1);
    f.reads[0].reject({ code: hasAudio === false ? 'TIMELINE_CLIP_LOUDNESS_NO_AUDIO' : 'TIMELINE_CLIP_LOUDNESS_UNAVAILABLE' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state().report, null); const failed = C({ loudness: { state: f.state(), controller: f.controller } });
    const text = byTest(failed, 'clip-loudness-status').props.children.join('');
    if (hasAudio === false) assert.match(text, /后端确认.*没有可测音轨/); else assert.doesNotMatch(text, /后端确认.*没有可测音轨/);
  }
});
