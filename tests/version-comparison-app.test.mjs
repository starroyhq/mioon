import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedRequest, isAllowedDownload, isAllowedNavigation } from '../apps/desktop/src/security.ts';
import { captureComparison } from '../apps/web/src/version-comparison-state.ts';
import { lenientFunction } from './helpers/eval-source.mjs';
const Function = lenientFunction;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('exact comparison route inherits native same-origin media permission, not download/navigation/audio grants', () => {
  const binding = captureComparison({ scope: 'project:epoch', projectId: id(1), workspaceOrigin: 'normal', connected: true, visible: true, restored: false,
    shot: { id: id(2), projectId: id(1) }, versions: [{ id: id(3), projectId: id(1), shotId: id(2), assetId: id(4), sha256: 'a'.repeat(64), number: 1 }],
    assets: [{ id: id(4), projectId: id(1), sha256: 'a'.repeat(64), mimeType: 'video/mp4' }] }, id(3));
  const origin = 'http://127.0.0.1:43210', url = origin + binding.url;
  assert.equal(isAllowedRequest(url, origin), true);
  assert.equal(isAllowedRequest('http://127.0.0.1:43211' + binding.url, origin), false);
  assert.equal(isAllowedRequest('https://untrusted.invalid' + binding.url, origin), false);
  assert.equal(isAllowedRequest(url.replace('127.0.0.1', 'attacker@127.0.0.1'), origin), false);
  assert.equal(isAllowedDownload(url, origin), false);
  assert.equal(isAllowedNavigation(url, origin), false);
});

import { readFileSync } from 'node:fs';
import { comparisonCurrent } from '../apps/web/src/version-comparison-state.ts';
const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function execute(start, end, env) { const source = app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))); assert.ok(source); return Function(...Object.keys(env), `${source}; return ${/function (\w+)/.exec(source)[1]};`)(...Object.values(env)); }
test('actual App comparison opening and close synchronously fence context and pause owners', () => {
  const calls = [], comparisonIdRef = { current: null }, clipLoudnessEpoch = { current: 0 };
  const set = execute('  function setComparisonId(', '  function comparisonContext(', { clipLoudnessEpoch, projectSessionReady: () => true, dataRef: { current: { project: { id: id(1) }, shots: [{ id: id(2), projectId: id(1) }] } }, currentProject: { current: id(1) }, comparisonIdRef, comparisonPreviewPause: { current: () => calls.push('comparison') }, nativePreviewPause: { current: () => calls.push('main') }, exportPreviewPause: { current: () => calls.push('export') }, audioPreview: { controller: { revoke: () => calls.push('audio') } }, updateComparisonId: value => calls.push(value) });
  set(id(2)); assert.equal(clipLoudnessEpoch.current, 1); assert.equal(comparisonIdRef.current, id(2)); assert.deepEqual(calls, ['comparison', 'audio', 'main', 'export', id(2)]);
  calls.length = 0; set(null); assert.equal(clipLoudnessEpoch.current, 2); assert.equal(comparisonIdRef.current, null); assert.deepEqual(calls, ['comparison', null]);
});
test('actual App context binds live project/epoch/workspace and synchronous comparison identity', () => {
  const currentProject = { current: id(1) }, comparisonIdRef = { current: id(2) }, projectEpoch = { current: 1 }, workspaceRef = { current: { restored: false } };
  const dataRef = { current: { project: { id: id(1) }, shots: [{ id: id(2), projectId: id(1) }], versions: [], assets: [] } };
  const get = execute('  function comparisonContext(', '  function useComparedVersion(', { currentProject, comparisonIdRef, projectEpoch, workspaceRef, dataRef, workspaceOriginScope: w => w.restored ? 'restored:foreign' : 'normal', projectSessionReady: () => true, online: true, auth: true, loading: false, workbenchReady: true, webSettingsOpen: false });
  assert.equal(get().scope, `${id(1)}:1:normal`); assert.equal(get().shot.id, id(2)); assert.equal(get().visible, true);
  comparisonIdRef.current = null; assert.equal(get().visible, false); assert.equal(get().shot, null);
  currentProject.current = id(99); projectEpoch.current++; assert.equal(get().connected, false); assert.equal(get().scope, `${id(99)}:2:normal`);
});
test('actual App before-play callbacks deny background playback while comparison owns the surface', () => {
  const calls = [], comparisonIdRef = { current: id(2) }, env = { comparisonIdRef, comparisonPreviewPause: { current: () => calls.push('comparison') }, nativePreviewPause: { current: () => calls.push('main') }, exportPreviewPause: { current: () => calls.push('export') }, audioPreview: { controller: { revoke: () => calls.push('audio') } } };
  const main = execute('  function beforeMainPreviewPlay(', '  function beforeExportPreviewPlay(', env), exp = execute('  function beforeExportPreviewPlay(', '  function beforeTimelineAudioPlay(', env), audio = execute('  function beforeTimelineAudioPlay(', '  const registerExportPreviewPause', env);
  main(); exp(); audio(); assert.deepEqual(calls, ['main', 'export', 'audio']);
  calls.length = 0; comparisonIdRef.current = null; main(); exp(); audio(); assert.deepEqual(calls, ['comparison', 'export', 'comparison', 'audio', 'main', 'comparison', 'export', 'main']);
});
test('actual explicit Use revalidates binding before existing revision-aware selection, never timeline replacement', () => {
  const context = { scope: 'scope', projectId: id(1), workspaceOrigin: 'normal', connected: true, visible: true, restored: false,
    shot: { id: id(2), projectId: id(1), revision: 7 }, versions: [{ id: id(3), projectId: id(1), shotId: id(2), assetId: id(4), sha256: 'a'.repeat(64), number: 1 }], assets: [{ id: id(4), projectId: id(1), sha256: 'a'.repeat(64), mimeType: 'video/mp4' }] };
  const binding = captureComparison(context, id(3)), calls = [];
  const use = execute('  function useComparedVersion(', '  function beforeMainPreviewPlay(', { comparisonContext: () => context, comparisonCurrent, isBusy: () => false, selectVersion: (...args) => calls.push(args) });
  use(binding); assert.deepEqual(calls, [[context.shot, id(3)]]); context.visible = false; use(binding); assert.equal(calls.length, 1);
  assert.match(app, /'version.select', \{ shotId: shot.id, versionId, expectedRevision: shot.revision \}/);
});
test('background visibility, exact comparison ownership and four-locale catalog are wired without duplicate UI', () => {
  const background = app.indexOf('<WorkspaceVisibilityProvider visible={!comparisonId}>'), end = app.indexOf('</WorkspaceVisibilityProvider>', background), comparison = app.indexOf('<VersionComparison key=');
  assert.ok(background > 0 && end > background && comparison > end);
  for (const name of ['<Inspector ', '<Preview ', '<ExportPreview', '<Media asset={previewAsset}']) assert.ok(app.indexOf(name, background) < end);
  assert.match(app, /visible=\{!comparisonId && workbenchReady && showDelivery && !showExports\}/);
  assert.match(app, /onBeforePlay=\{beforeMainPreviewPlay\}/); assert.match(app, /onBeforePlay=\{beforeExportPreviewPlay\}/); assert.match(app, /onBeforePlay: beforeTimelineAudioPlay/);
  assert.doesNotMatch(app, /function Comparison\(/);
  const i18n = readFileSync(new URL('../packages/i18n/src/index.ts', import.meta.url), 'utf8'); assert.match(i18n, /assertNoDuplicateMessageKeys\([^)]*comparisonMessages[^)]*annotationMessages/);
});

test('retained invalid Compare opener has no state or media effects; null always closes', () => {
  for (const shots of [[], [{ id: id(2), projectId: id(99) }], [{ id: id(2), projectId: id(1) }, { id: id(2), projectId: id(1) }]]) {
    const calls = [], comparisonIdRef = { current: null }, clipLoudnessEpoch = { current: 0 };
    const set = execute('  function setComparisonId(', '  function comparisonContext(', { clipLoudnessEpoch, projectSessionReady: () => true, dataRef: { current: { project: { id: id(1) }, shots } }, currentProject: { current: id(1) }, comparisonIdRef,
      comparisonPreviewPause: { current: () => calls.push('comparison') }, nativePreviewPause: { current: () => calls.push('main') }, exportPreviewPause: { current: () => calls.push('export') }, audioPreview: { controller: { revoke: () => calls.push('audio') } }, updateComparisonId: value => calls.push(value) });
    set(id(2)); assert.equal(clipLoudnessEpoch.current, 0); assert.equal(comparisonIdRef.current, null); assert.deepEqual(calls, []);
    comparisonIdRef.current = id(2); set(null); assert.equal(clipLoudnessEpoch.current, 1); assert.equal(comparisonIdRef.current, null); assert.deepEqual(calls, ['comparison', null]);
  }
});

import { transformSync } from 'esbuild';
test('actual App conditional retains comparison after its shot disappears, leaving a close path', () => {
  const start = app.indexOf('{comparisonId && <VersionComparison'), end = app.indexOf('/>}', start) + 3;
  assert.ok(start > 0 && end > start);
  const code = transformSync(`module.exports = () => (${app.slice(start + 1, end - 1)});`, { loader: 'tsx', format: 'cjs' }).code;
  const module = { exports: {} }, calls = [];
  const env = { React: { createElement: (type, props) => ({ type, props }) }, comparisonId: id(2), VersionComparison: 'comparison', data: { project: { id: id(1) }, shots: [] }, projectEpoch: { current: 1 },
    comparisonContext: () => ({ shot: null }), setComparisonId: value => calls.push(value), useComparedVersion() {}, busy: {}, registerComparisonPreviewPause() {}, audioPreview: { controller: { revoke() {} } }, nativePreviewPause: { current: null }, exportPreviewPause: { current: null } };
  Function('module', ...Object.keys(env), code)(module, ...Object.values(env));
  const tree = module.exports(); assert.equal(tree.type, 'comparison'); assert.equal(tree.props.context.shot, null); tree.props.onClose(); assert.deepEqual(calls, [null]);
});
