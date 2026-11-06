import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import type {NewProjectFileDialogProps} from '../apps/web/src/project-file/NewProjectFileDialog.tsx';
import type {ProjectOpenFailureDialogProps} from '../apps/web/src/project-file/ProjectOpenFailureDialog.tsx';
interface Element {type: unknown; props: Record<string, unknown> & {children?: unknown}}
interface Components {
  NewProjectFileDialog(props: NewProjectFileDialogProps): Element;
  ProjectOpenFailureDialog(props: ProjectOpenFailureDialogProps): Element;
  React: {__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {H: unknown}};
  html(which: 'create' | 'failure', props: unknown): string;
}
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({stdin: {contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
 import {NewProjectFileDialog} from './src/project-file/NewProjectFileDialog.tsx';
 import {ProjectOpenFailureDialog} from './src/project-file/ProjectOpenFailureDialog.tsx';
 export {React,NewProjectFileDialog,ProjectOpenFailureDialog};
 export const html=(which,props)=>renderToStaticMarkup(React.createElement(which==='create'?NewProjectFileDialog:ProjectOpenFailureDialog,props));`, resolveDir: root + 'apps/web', loader: 'tsx'},
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: {'.css': 'empty'}, nodePaths: [root + 'apps/web/node_modules'],
  define: {'process.env.NODE_ENV': '"production"'}, plugins: [{name: 'ssr-overlays', setup(builder) {
    builder.onResolve({filter: /^@mioon\/ui\/components\/dialog$/}, () => ({path: root + 'tests/fixtures/project-file-ui/ssr-overlays.tsx'}));
    builder.onResolve({filter: /\/i18n\/I18nProvider\.tsx$/}, () => ({path: root + 'tests/fixtures/project-file-ui/ssr-i18n.tsx'}));
  }}]});
const target = {exports: {}};
Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), target, target.exports);
const ui = target.exports as Components;
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...nodes(element.props.children), ...nodes(element.props.footer)];
}
function harness<T>(component: (props: T) => Element) {
  const slots: {current: unknown}[] = [];
  return (props: T) => {
    let cursor = 0; const internals = ui.React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, saved = internals.H;
    internals.H = {useId: () => 'native-form', useRef: (value: unknown) => slots[cursor++] ?? (slots[cursor - 1] = {current: value})};
    try {return component(props);} finally {internals.H = saved;}
  };
}
function button(tree: Element, id: string): Element {const value = nodes(tree).find(element => element.props['data-testid'] === id); assert.ok(value, id); return value;}

test('actual new-project Portal output is inert after identity blocking and stale callbacks retain all controlled input', () => {
  const calls: string[] = [], values = {name: 'Retained project', description: 'Retained description', presetId: 'portrait_1080' as const, createFolder: true};
  const props: NewProjectFileDialogProps = {open: true, values, location: {display: '/verified/selected', status: 'ready'}, state: {kind: 'editing'},
    onChange: () => {calls.push('change');}, onSubmit: () => {calls.push('submit');}, onClose: () => {calls.push('close');}, onChooseLocation: () => {calls.push('choose');}};
  const render = harness(ui.NewProjectFileDialog), old = render(props), blocked = render({...props, interactionBlocked: true});
  assert.equal(blocked.props.children && (blocked.props.children as Element).props.inert, true);
  const html = ui.html('create', {...props, interactionBlocked: true});
  assert.match(html, /inert=""/); assert.match(html, /value="Retained project"/); assert.match(html, /Retained description/);
  const input = button(old, 'pf-create-name'); (input.props.onChange as (event: unknown) => void)({target: {value: 'replacement'}});
  for (const id of ['pf-create-submit', 'pf-create-cancel', 'pf-create-choose']) {
    const element = button(old, id); if (typeof element.props.onClick === 'function') element.props.onClick();
  }
  const form = nodes(old).find(element => element.type === 'form'); assert.ok(form); (form.props.onSubmit as (event: unknown) => void)({preventDefault() {}});
  (old.props.onOpenChange as (open: boolean) => void)(false); assert.deepEqual(calls, []); assert.equal(props.values, values);
  render(props); (button(old, 'pf-create-cancel').props.onClick as () => void)(); assert.deepEqual(calls, ['close']);
  const unselected = ui.html('create', {...props, location: {display: '', status: 'unselected'}});
  assert.match(unselected, /<button[^>]*data-testid="pf-create-submit"[^>]*disabled/);
  assert.doesNotMatch(unselected, /data-testid="pf-create-location-unavailable"/);
});
test('actual failure Portal keeps exact unknown action but blocks old recheck/settings/close and primitive dismissal', () => {
  const calls: string[] = [];
  const props: ProjectOpenFailureDialogProps = {open: true, failure: {code: 'PROJECT_ACCESS_DENIED', projectId: null, projectFile: null}, projectName: 'Retained',
    platform: 'mac', action: {kind: 'unknown', action: 'copyTo'}, onClose: () => {calls.push('close');}, onRecheck: () => {calls.push('recheck');}, onOpenSystemSettings: () => {calls.push('settings');}};
  const render = harness(ui.ProjectOpenFailureDialog), old = render(props); render({...props, interactionBlocked: true});
  assert.match(ui.html('failure', {...props, interactionBlocked: true}), /inert=""/);
  for (const id of ['pf-open-recheck', 'pf-open-systemSettings', 'pf-open-close']) (button(old, id).props.onClick as () => void)();
  (old.props.onOpenChange as (open: boolean) => void)(false); assert.deepEqual(calls, []);
  render(props); (button(old, 'pf-open-recheck').props.onClick as () => void)(); assert.deepEqual(calls, ['recheck']);
});
test('invalid native save tickets give explicit reselect guidance while keeping the controlled input and a closable error', () => {
  const guidance = 'The selected save location is no longer valid. Choose a save location again.';
  const create: NewProjectFileDialogProps = {open: true, values: {name: 'Retained name', description: 'Retained description', presetId: 'portrait_1080', createFolder: false},
    location: {display: '', status: 'unavailable', message: guidance}, state: {kind: 'error', code: 'unknown'}, onChange() {}, onSubmit() {assert.fail('Reselect before submitting');}, onClose() {}, onChooseLocation() {}};
  const html = ui.html('create', create); assert.match(html, /Retained name/); assert.match(html, /Retained description/); assert.ok(html.includes(guidance));
  const tag = (markup: string, id: string) => {const match = markup.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`)); assert.ok(match); return match[0];};
  assert.match(tag(html, 'pf-create-submit'), /\sdisabled(?:=|[ >])/); assert.doesNotMatch(tag(html, 'pf-create-choose'), /\sdisabled(?:=|[ >])/); assert.doesNotMatch(tag(html, 'pf-create-cancel'), /\sdisabled(?:=|[ >])/);
  const failure: ProjectOpenFailureDialogProps = {open: true, failure: {code: 'OPEN_UNAVAILABLE', projectId: null, projectFile: null}, projectName: 'Original', platform: 'mac', action: {kind: 'error', action: 'copyTo'}, notice: guidance, onClose() {}};
  const failed = ui.html('failure', failure); assert.ok(failed.includes(guidance)); assert.match(failed, /data-testid="pf-open-notice"/); assert.doesNotMatch(tag(failed, 'pf-open-close'), /\sdisabled(?:=|[ >])/);
});
