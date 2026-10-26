import type {ElementProps as UiProps,Tree as UiTree,Element as UiElement} from './helpers/strict-agent-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import ts from 'typescript';
import * as contracts from '@mioon/contracts';
import {createEditTaskClient} from '../apps/web/src/edit-task-client.ts';
import {createOpacityCandidateApplication, readOpacityCandidateApplication, type OpacityCandidateApplicationRuntime} from '../apps/web/src/opacity-candidate-application.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const source = readFileSync(new URL('../apps/web/src/main.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const element = (type: import('./helpers/strict-agent-ui-types.ts').ElementType, props: Partial<UiProps>|null, ...children: UiTree[]) => (({type, props: {...props, children}}) as unknown as UiElement);
const nodes = (value?: UiTree): UiElement[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];

function entry(candidate: boolean) {
  let rendered:UiTree, calls = 0, token:ReturnType<typeof createOpacityCandidateApplication>|undefined;
  const rpc = async () => {throw Error('Entry must not issue RPC while rendering.');};
  const react = {createElement: element, StrictMode: 'StrictMode'};
  const code = transformSync(source, {loader: 'tsx', format: 'cjs', define: {__MIOON_INTERNAL_OPACITY_CANDIDATE__: String(candidate)}}).code;
  const module = {exports: {}};
  Function('require', 'module', 'exports', 'document', 'navigator', code)((name: string) => {
    if (name === 'react') return {...react, default: react};
    if (name === 'react-dom/client') return {createRoot: () => ({render: (value: import('./helpers/strict-agent-ui-types.ts').Tree) => {rendered = value;}})};
    if (name === '@mioon/contracts') return contracts;
    if (name.endsWith('/api.ts')) return {rpc, ApiError: class extends Error {}};
    if (name.endsWith('/edit-task-client.ts')) return {createEditTaskClient};
    if (name.endsWith('/opacity-candidate-application.ts')) return {createOpacityCandidateApplication(runtime: OpacityCandidateApplicationRuntime) {calls++; token = createOpacityCandidateApplication(runtime);return token;}};
    if (name.endsWith('/App.tsx')) return {__esModule: true, default: 'App', SettingsConnectionForms: 'SettingsConnectionForms'};
    if (name.endsWith('/DesktopRoot.tsx')) return {__esModule: true, default: 'DesktopRoot'};
    if (name.endsWith('/desktop-frame.ts')) return {desktopFrame: () => null};
    if (name.includes('I18nProvider.tsx')) return {I18nProvider: 'I18nProvider', useI18n: () => ({t: (key: unknown) => key, renderMessage: String})};
    if (name.includes('workspace-restore.mjs')) return {workspaceRestoreInspectionSchema: {parse: (value: unknown) => value}};
    return new Proxy({}, {get: (_, key) => String(key)});
  }, module, module.exports, {documentElement: {classList: {add() {}}, dataset: {}}, getElementById: () => ({})}, {userAgent: 'synthetic'});
  const localized = nodes(rendered).find((value) => typeof value.type === 'function' && value.type.name === 'LocalizedApplication');
  assert.ok(localized);
  return {tree: (localized.type as ()=>UiTree)(), calls, token};
}

test('ordinary compiled entry creates no opacity capability and retains the desktop/web entry', () => {
  const result = entry(false);
  assert.equal(result.calls, 0);
  const root = nodes(result.tree).find((value) => value.type === 'DesktopRoot') as (UiElement&{props:{renderWeb():UiElement;renderEditor(...args:unknown[]):UiElement}})|undefined;assert.ok(root);
  assert.equal(root.props.renderWeb().type, 'App');
  assert.equal(root.props.renderWeb().props.opacityApplication, undefined);
  assert.equal(root.props.renderEditor({}, {}, {}).props.opacityApplication, undefined);
});

test('isolated compiled entry mounts the same App with its exact private application and no launcher owner', () => {
  const result = entry(true);
  assert.equal(result.calls, 1);
  const mounted = nodes(result.tree).find((value) => value.type === 'App');assert.ok(mounted);
  assert.equal(mounted.props.opacityApplication, result.token);
  assert.ok((readOpacityCandidateApplication(mounted.props.opacityApplication) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityApplication|null));
  assert.equal(nodes(result.tree).some((value) => value.type === 'DesktopRoot'), false);
  assert.equal((readOpacityCandidateApplication({...result.token}) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityApplication|null), null);
  assert.equal((readOpacityCandidateApplication(JSON.parse((JSON.stringify(result.token) as string))) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityApplication|null), null);
});

test('actual App pins its original entry capability and defaults reject copied metadata', () => {
  const first = app.indexOf('  const requestedApplication =');
  const last = app.indexOf('  const { locale, t,', first);
  assert.ok(first > 0 && last > first);
  const selection = Function('env', `with (env) { ${app.slice(first, last)};return {application,rpc,schemas,isTimelineMutationResponse,isTimelineRenderRecord}; }`);
  const actual = entry(true).token;
  const productionRpc = () => {}, productionSchemas = {}, productionTimelineMutationResponse = () => false, productionTimelineRenderRecord = () => false;
  const env = {readOpacityCandidateApplication, opacityApplication: actual, useRef: (value: unknown) => ({current: value}), productionRpc, productionSchemas, productionTimelineMutationResponse, productionTimelineRenderRecord};
  const selected = selection(env) as {application:unknown;rpc:unknown;schemas:unknown}, original = (readOpacityCandidateApplication(actual) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityApplication|null);
  assert.equal(selected.application, original);assert.equal(selected.rpc, original!.rpc);assert.equal(selected.schemas, original!.schemas);
  for (const value of [null, {...actual}, JSON.parse((JSON.stringify(actual) as string)), {profileId: 'mioon-workspace-v42'}] as const) {
    const result = selection({...env, opacityApplication: value}) as {application:unknown;rpc:unknown};assert.equal(result.application, null);assert.equal(result.rpc, productionRpc);
  }
  assert.throws(() => selection({...env, opacityApplication: null, useRef: () => ({current: original})}), /cannot change/);
});

test('candidate App binds the actual task lane, Inspector v3 client and render readers while unsupported editors remain unavailable', () => {
  assert.match(app, /createEditTaskController\(\{ \.\.\.\(application \? \{ client: application\.taskClient \}/);
  assert.match(app, /opacityCandidate=\{application\?\.inspectorBinding\}/);
  assert.match(app, /application && !application\.validateProjectSnapshot\(next, projectId\)/);
  assert.match(app, /const editorView = application \? \{ \.\.\.restored, activeMode: 'editing' \}/);
  assert.match(app, /<Preview[^>]*opacityApplication=\{opacityApplication(?: as never)?\}/);
  assert.match(app, /onCanvas=\{application \? undefined : \(\) => changeMode\('canvas'\)\}/);
  const history = app.match(/<ExportHistoryList\s[\s\S]*?\/>/)?.[0];
  assert.ok(history, 'The actual history composition remains in App');
  for (const prop of [
    /opacityApplication=\{opacityApplication\}/, /projectId=\{data\.project\?\.id\}/,
    /fileRecoveryEnabled=\{!restored && !application\}/,
    /candidateConnected=\{online && auth === true && workbenchReady && !loading\}/,
  ] as const) assert.match(history, prop);
  assert.match(app, /onReplaceSource=\{application \? undefined : replaceTimelineClipSource(?: as never)?\}/);
  const parsed=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),timelines:ts.JsxSelfClosingElement[]=[];
  function visit(node: ts.Node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(parsed)==='Timeline')timelines.push(((((node as unknown as Parameters<typeof timelines.push>[0])))));ts.forEachChild(node,visit);}
  visit(parsed);assert.equal(timelines.length,1,'Inspect the actual Timeline composition, independently of prop order');
  const attribute=timelines[0].attributes.properties.find((value)=>ts.isJsxAttribute(value)&&value.name.getText(parsed)==='basicEditingOnly') as ts.JsxAttribute|undefined;
  assert.ok(attribute&&ts.isJsxAttribute((attribute as unknown as Parameters<typeof ts.isJsxAttribute>[0]))&&attribute.initializer&&ts.isJsxExpression(attribute.initializer));
  assert.equal(attribute.initializer.expression?.getText(parsed),'Boolean(application)');
  assert.match(app, /!application && <AgentWorkspace/);
  assert.match(app, /!application && <ImageGeneration/);
  assert.match(app, /!application && workbenchReady \? data\.project\?\.id : null/);
});

test('candidate Inspector describes saved preview/export behavior in all supported languages', () => {
  const inspector = readFileSync(new URL('../apps/web/src/TimelineInspector.tsx', import.meta.url), 'utf8');
  assert.match(inspector, /t\('opacity\.envelope\.renderSaved'\)/);
  assert.doesNotMatch(inspector, /t\('opacity\.envelope\.renderPending'\)/);
  for (const locale of LOCALES) {
    const value = translate(locale, 'opacity.envelope.renderSaved');assert.notEqual(value, 'opacity.envelope.renderSaved');assert.ok(value.length > 15);
  }
});

test('actual candidate Return to source keeps editing and uses the shared source-preview navigation guard', async () => {
  const first = app.indexOf('  async function returnToSource(assetId: string): Promise<void> {');
  const last = app.indexOf('  async function moveTimelineClip(', first);
  assert.ok(first > 0 && last > first);
  const calls: unknown[] = [], asset = {id: 'source'};
  const env = {application: {}, sourceForAsset: () => ({asset}), dataRef: {current: {}},
    previewSource: async (value: unknown) => {calls.push(['previewSource', value]);return true;},
    updateView: (...args: unknown[]) => calls.push(['updateView', ...args]),
    guardNavigation: async () => {assert.fail('Candidate must use previewSource\'s own navigation guard.');}};
  const run = Function('env', `with (env) { ${app.slice(first, last)};return returnToSource; }`)(env) as (assetId:string)=>Promise<boolean>;
  assert.equal(await run(asset.id), true);
  assert.deepEqual(calls, [['previewSource', asset]]);
});
