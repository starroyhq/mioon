import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import type {NewProjectFileDialogProps} from '../apps/web/src/project-file/NewProjectFileDialog.tsx';
import type {ProjectOpenFailureDialogProps} from '../apps/web/src/project-file/ProjectOpenFailureDialog.tsx';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import {createNativeProjectDesktopController} from '../apps/web/src/native-project-desktop-state.ts';
import {projectEntryFixture, projectEntryOwnerFixture} from './helpers/project-entry-fixture.ts';
import {createI18nTestContext} from './helpers/i18n.ts';
import type {Locale} from '../packages/i18n/src/index.ts';
interface Element {type: unknown; props: Record<string, unknown> & {children?: unknown}}
interface Components {
  NewProjectFileDialog(props: NewProjectFileDialogProps): Element;
  ProjectOpenFailureDialog(props: ProjectOpenFailureDialogProps): Element;
  React: {__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {H: unknown}};
  setLocale(locale: Locale): void;
  html(which: 'create' | 'failure' | 'native', props: unknown): string;
}
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({stdin: {contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
 import {NewProjectFileDialog} from './src/project-file/NewProjectFileDialog.tsx';
 import {ProjectOpenFailureDialog} from './src/project-file/ProjectOpenFailureDialog.tsx';
 import {NativeProjectEntryDialogs} from './src/NativeProjectEntryDialogs.tsx';
 export {setLocale} from '../../tests/fixtures/project-file-ui/ssr-i18n.tsx';
 export {React,NewProjectFileDialog,ProjectOpenFailureDialog};
 export const html=(which,props)=>renderToStaticMarkup(React.createElement(which==='create'?NewProjectFileDialog:which==='native'?NativeProjectEntryDialogs:ProjectOpenFailureDialog,props));`, resolveDir: root + 'apps/web', loader: 'tsx'},
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
test('expired COPY and read-only actions keep the actual native dialog closable with four-language guidance', async t => {
  const id = (n: number) => `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const facts = {fileSystem: 'apfs', isLocal: true, volumeReadOnly: false, permissionBits: true, cloud: 'not-reported'} as const;
  for (const kind of ['copy', 'read-only'] as const) for (const dismissal of ['button', 'primitive'] as const) await t.test(`${kind}/${dismissal}`, async t => {
    const rows = projectEntryFixture([]), identity = projectEntryOwnerFixture(() => rows, []);
    const requests: string[] = [];
    const preload = createProjectEntriesDesktopBridge(async (_channel, value) => {
      const request = value as {action: string}; requests.push(request.action);
      const defaults: Record<string, unknown> = {
        capabilities: {ready: true, create: false, open: true, saveAs: false, duplicate: false, copyTo: true, adoptCopy: true, openOriginal: true},
        takePendingOpen: null,
        openSelectedFile: kind === 'copy' ? {status: 'copy', token: id(1), name: 'Retained COPY', original: {name: 'Original', displayPath: '/original.mioon'}}
          : {status: 'copy-source', token: id(1), name: 'Retained read-only', displayPath: '/source.mioon', reason: 'read-only', facts},
        chooseLocation: {token: id(2), displayPath: '/selected/copy.mioon', facts},
      };
      if (request.action === 'adoptCopy' || request.action === 'copyTo') return {ok: false, error: {code: 'PROJECT_ENTRY_TICKET_EXPIRED', status: 409, details: {}}};
      return {ok: true, data: defaults[request.action]};
    });
    const client = readProjectEntryDesktopClient({__mioonProjectEntries: preload}); assert.ok(client);
    const controller = createNativeProjectDesktopController({client, identity, beforeAction: async () => true, openCreated: async () => {assert.fail('Expired ticket cannot open a created project');}, message: () => 'Select location'});
    controller.activate(); t.after(() => {controller.dispose(); identity.dispose(); ui.setLocale('zh-Hans');}); await controller.initialize(false);
    await controller.openFile(); await (kind === 'copy' ? controller.adoptCopy() : controller.copyTo());
    const state = controller.getState(); assert.ok(state.failure); assert.equal(state.failure.entryExpired, true); assert.equal(state.action.kind, 'error');
    for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
      ui.setLocale(locale); const html = ui.html('native', {desktop: controller});
      const expected = createI18nTestContext(locale).t('nativeEntry.requestExpired'); assert.ok(html.includes(expected), `${locale}: native wiring must show expired-request guidance`);
      assert.match(html, /data-testid="pf-open-notice"/); assert.doesNotMatch(html, /data-testid="pf-open-unknown"/);
      assert.doesNotMatch(html, /data-testid="pf-open-(?:adoptCopy|openOriginal|copyTo)"/);
      const close = html.match(/<button[^>]*data-testid="pf-open-close"[^>]*>/); assert.ok(close); assert.doesNotMatch(close[0], /\sdisabled(?:=|[ >])/);
    }
    const props: ProjectOpenFailureDialogProps = {open: true, failure: state.failure.issue, projectName: state.failure.name, platform: 'mac', action: state.action,
      notice: 'Expired; reopen the file', onClose: controller.closeFailure};
    const rendered = harness(ui.ProjectOpenFailureDialog)(props);
    if (dismissal === 'button') (button(rendered, 'pf-open-close').props.onClick as () => void)();
    else (rendered.props.onOpenChange as (open: boolean) => void)(false);
    assert.equal(controller.getState().failure, null); assert.equal(controller.readCloseSnapshot().unknown, false);
    assert.equal(requests.filter(action => action === (kind === 'copy' ? 'adoptCopy' : 'copyTo')).length, 1);
  });
});
