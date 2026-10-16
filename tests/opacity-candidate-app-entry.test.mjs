import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import * as contracts from '@mioon/contracts';
import {createEditTaskClient} from '../apps/web/src/edit-task-client.js';
import {createOpacityCandidateApplication, readOpacityCandidateApplication} from '../apps/web/src/opacity-candidate-application.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';

const source = readFileSync(new URL('../apps/web/src/main.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const element = (type, props, ...children) => ({type, props: {...props, children}});
const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];

function entry(candidate) {
  let rendered, calls = 0, token;
  const rpc = async () => {throw Error('Entry must not issue RPC while rendering.');};
  const react = {createElement: element, StrictMode: 'StrictMode'};
  const code = transformSync(source, {loader: 'jsx', format: 'cjs', define: {__MIOON_INTERNAL_OPACITY_CANDIDATE__: String(candidate)}}).code;
  const module = {exports: {}};
  Function('require', 'module', 'exports', 'document', 'navigator', code)(name => {
    if (name === 'react') return {...react, default: react};
    if (name === 'react-dom/client') return {createRoot: () => ({render: value => {rendered = value;}})};
    if (name === '@mioon/contracts') return contracts;
    if (name.endsWith('/api.js')) return {rpc, ApiError: class extends Error {}};
    if (name.endsWith('/edit-task-client.js')) return {createEditTaskClient};
    if (name.endsWith('/opacity-candidate-application.ts')) return {createOpacityCandidateApplication(runtime) {calls++; token = createOpacityCandidateApplication(runtime);return token;}};
    if (name.endsWith('/App.jsx')) return {__esModule: true, default: 'App', SettingsConnectionForms: 'SettingsConnectionForms'};
    if (name.endsWith('/DesktopRoot.tsx')) return {__esModule: true, default: 'DesktopRoot'};
    if (name.endsWith('/desktop-frame.ts')) return {desktopFrame: () => null};
    if (name.includes('I18nProvider.tsx')) return {I18nProvider: 'I18nProvider', useI18n: () => ({t: key => key, renderMessage: String})};
    if (name.includes('workspace-restore.mjs')) return {workspaceRestoreInspectionSchema: {parse: value => value}};
    return new Proxy({}, {get: (_, key) => String(key)});
  }, module, module.exports, {documentElement: {classList: {add() {}}, dataset: {}}, getElementById: () => ({})}, {userAgent: 'synthetic'});
  const localized = nodes(rendered).find(value => typeof value.type === 'function' && value.type.name === 'LocalizedApplication');
  assert.ok(localized);
  return {tree: localized.type(), calls, token};
}

test('ordinary compiled entry creates no opacity capability and retains the desktop/web entry', () => {
  const result = entry(false);
  assert.equal(result.calls, 0);
  const root = nodes(result.tree).find(value => value.type === 'DesktopRoot');assert.ok(root);
  assert.equal(root.props.renderWeb().type, 'App');
  assert.equal(root.props.renderWeb().props.opacityApplication, undefined);
  assert.equal(root.props.renderEditor({}, {}, {}).props.opacityApplication, undefined);
});

test('isolated compiled entry mounts the same App with its exact private application and no launcher owner', () => {
  const result = entry(true);
  assert.equal(result.calls, 1);
  const mounted = nodes(result.tree).find(value => value.type === 'App');assert.ok(mounted);
  assert.equal(mounted.props.opacityApplication, result.token);
  assert.ok(readOpacityCandidateApplication(mounted.props.opacityApplication));
  assert.equal(nodes(result.tree).some(value => value.type === 'DesktopRoot'), false);
  assert.equal(readOpacityCandidateApplication({...result.token}), null);
  assert.equal(readOpacityCandidateApplication(JSON.parse(JSON.stringify(result.token))), null);
});

test('actual App pins its original entry capability and defaults reject copied metadata', () => {
  const first = app.indexOf('  const requestedApplication =');
  const last = app.indexOf('  const { locale, t,', first);
  assert.ok(first > 0 && last > first);
  const selection = Function('env', `with (env) { ${app.slice(first, last)};return {application,rpc,schemas,isTimelineMutationResponse,isTimelineRenderRecord}; }`);
  const actual = entry(true).token;
  const productionRpc = () => {}, productionSchemas = {}, productionTimelineMutationResponse = () => false, productionTimelineRenderRecord = () => false;
  const env = {readOpacityCandidateApplication, opacityApplication: actual, useRef: value => ({current: value}), productionRpc, productionSchemas, productionTimelineMutationResponse, productionTimelineRenderRecord};
  const selected = selection(env), original = readOpacityCandidateApplication(actual);
  assert.equal(selected.application, original);assert.equal(selected.rpc, original.rpc);assert.equal(selected.schemas, original.schemas);
  for (const value of [null, {...actual}, JSON.parse(JSON.stringify(actual)), {profileId: 'mioon-workspace-v42'}]) {
    const result = selection({...env, opacityApplication: value});assert.equal(result.application, null);assert.equal(result.rpc, productionRpc);
  }
  assert.throws(() => selection({...env, opacityApplication: null, useRef: () => ({current: original})}), /cannot change/);
});

test('candidate App binds the actual task lane, Inspector v3 client and render readers while unsupported editors remain unavailable', () => {
  assert.match(app, /createEditTaskController\(\{ \.\.\.\(application \? \{ client: application\.taskClient \}/);
  assert.match(app, /opacityCandidate=\{application\?\.inspectorBinding\}/);
  assert.match(app, /application && !application\.validateProjectSnapshot\(next, projectId\)/);
  assert.match(app, /const editorView = application \? \{ \.\.\.restored, activeMode: 'editing' \}/);
  assert.match(app, /<Preview[^>]*opacityApplication=\{opacityApplication\}/);
  assert.match(app, /<ExportHistoryList[^>]*opacityApplication=\{opacityApplication\} projectId=\{data\.project\?\.id\}/);
  assert.match(app, /onReplaceSource=\{application \? undefined : replaceTimelineClipSource\}/);
  assert.match(app, /<Timeline basicEditingOnly=\{Boolean\(application\)\}/);
  assert.match(app, /!application && <AgentWorkspace/);
  assert.match(app, /!application && <ImageGeneration/);
  assert.match(app, /!application && workbenchReady \? data\.project\?\.id : null/);
});

test('candidate Inspector describes saved preview/export behavior in all supported languages', () => {
  const inspector = readFileSync(new URL('../apps/web/src/TimelineInspector.jsx', import.meta.url), 'utf8');
  assert.match(inspector, /t\('opacity\.envelope\.renderSaved'\)/);
  assert.doesNotMatch(inspector, /t\('opacity\.envelope\.renderPending'\)/);
  for (const locale of LOCALES) {
    const value = translate(locale, 'opacity.envelope.renderSaved');assert.notEqual(value, 'opacity.envelope.renderSaved');assert.ok(value.length > 15);
  }
});

test('actual candidate Return to source keeps editing and uses the shared source-preview navigation guard', async () => {
  const first = app.indexOf('  async function returnToSource(assetId) {');
  const last = app.indexOf('  async function moveTimelineClip(', first);
  assert.ok(first > 0 && last > first);
  const calls = [], asset = {id: 'source'};
  const env = {application: {}, sourceForAsset: () => ({asset}), dataRef: {current: {}},
    previewSource: async value => {calls.push(['previewSource', value]);return true;},
    updateView: (...args) => calls.push(['updateView', ...args]),
    guardNavigation: async () => {assert.fail('Candidate must use previewSource\'s own navigation guard.');}};
  const run = Function('env', `with (env) { ${app.slice(first, last)};return returnToSource; }`)(env);
  assert.equal(await run(asset.id), true);
  assert.deepEqual(calls, [['previewSource', asset]]);
});
