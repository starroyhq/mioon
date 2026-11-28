import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import type {NewProjectFileDialogProps} from '../apps/web/src/project-file/NewProjectFileDialog.tsx';
import type {ProjectOpenFailureDialogProps} from '../apps/web/src/project-file/ProjectOpenFailureDialog.tsx';
import {createDesktopUpdateBridge} from '../apps/desktop/src/desktop-update-preload.ts';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import {createNativeProjectDesktopController} from '../apps/web/src/native-project-desktop-state.ts';
import type {NativeProjectDesktopController} from '../apps/web/src/native-project-desktop-state.ts';
import {createProjectEntryController} from '../apps/web/src/project-entry-state.ts';
import type {ProjectWindowBridge, ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
import {DESKTOP_UPDATE_CHANNEL} from '../packages/contracts/src/desktop-update.ts';
import {PROJECT_READER_UPDATE_REQUIRED} from '../packages/contracts/src/project-reader-requirements.ts';
import {projectEntryFixture, projectEntryOwnerFixture} from './helpers/project-entry-fixture.ts';
import {createI18nTestContext} from './helpers/i18n.ts';
import type {Locale} from '../packages/i18n/src/index.ts';
interface Element {type: unknown; props: Record<string, unknown> & {children?: unknown}}
interface Components {
  NewProjectFileDialog(props: NewProjectFileDialogProps): Element;
  ProjectOpenFailureDialog(props: ProjectOpenFailureDialogProps): Element;
  DesktopUpdateRoot(props: {blocked: boolean; children: unknown}): Element;
  NativeProjectEntryDialogs(props: {desktop: NativeProjectDesktopController}): Element | null;
  React: {__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {H: unknown}};
  setLocale(locale: Locale): void;
  html(which: 'create' | 'failure' | 'native' | 'native-with-update', props: unknown): string;
}
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({stdin: {contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
 import {NewProjectFileDialog} from './src/project-file/NewProjectFileDialog.tsx';
 import {ProjectOpenFailureDialog} from './src/project-file/ProjectOpenFailureDialog.tsx';
 import {NativeProjectEntryDialogs} from './src/NativeProjectEntryDialogs.tsx';
 import {DesktopUpdateRoot} from './src/DesktopUpdate.tsx';
 export {setLocale} from '../../tests/fixtures/project-file-ui/ssr-i18n.tsx';
 export {React,NewProjectFileDialog,ProjectOpenFailureDialog,DesktopUpdateRoot,NativeProjectEntryDialogs};
 export function html(which,props) {
   const dialog=React.createElement(which==='create'?NewProjectFileDialog:which.startsWith('native')?NativeProjectEntryDialogs:ProjectOpenFailureDialog,props);
   return renderToStaticMarkup(which==='native-with-update'?React.createElement(DesktopUpdateRoot,{blocked:false},dialog):dialog);
 }`, resolveDir: root + 'apps/web', loader: 'tsx'},
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
function harness<T, R extends Element | null>(component: (props: T) => R, context?: unknown) {
  const slots: {current: unknown}[] = [];
  return (props: T) => {
    let cursor = 0; const internals = ui.React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, saved = internals.H;
    internals.H = {useId: () => 'native-form', useRef: (value: unknown) => slots[cursor++] ?? (slots[cursor - 1] = {current: value}),
      useContext: () => context, useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect() {}, useCallback: (value: unknown) => value};
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

test('the native launcher renders the existing 12-25 recovery dialog for a diverged project failure', async t => {
  const id = (n: number) => `73000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const projectId = id(1);
  const rows = projectEntryFixture([{id: projectId}]), identity = projectEntryOwnerFixture(() => rows, []);
  const preload = createProjectEntriesDesktopBridge(async (_channel, value) => {
    const request = value as {action: string};
    if (request.action === 'capabilities') return {ok: true, data: {ready: true, create: false, open: true, saveAs: false, duplicate: false, copyTo: false, adoptCopy: false}};
    if (request.action === 'takePendingOpen') return {ok: true, data: null};
    return {ok: true, data: null};
  });
  const client = readProjectEntryDesktopClient({__mioonProjectEntries: preload}); assert.ok(client);
  const controller = createNativeProjectDesktopController({client, identity, beforeAction: async () => true, openCreated: async () => false, message: () => ''});
  controller.activate(); t.after(() => {controller.dispose(); identity.dispose();});
  await controller.initialize(false);
  controller.observeError({code: 'PROJECT_HISTORY_DIVERGED', status: 409, details: {projectId}}, 'open', projectId);
  const state = controller.getState(); assert.equal(state.failure?.issue.code, 'PROJECT_HISTORY_DIVERGED');
  const html = ui.html('native', {desktop: controller});
  assert.match(html, /data-testid="pf-history-recovery"/);
  assert.doesNotMatch(html, /data-testid="pf-open-dialog"/);
});

test('registered projects and selected files offer the same update action and dispatch only the trusted check', async t => {
  const requests: unknown[] = [];
  const mioonDesktopUpdate = createDesktopUpdateBridge({
    async invoke(channel, request) {
      requests.push([channel, request]);
      return {ok: true, data: {revision: 1, currentVersion: '0.5.0', state: {kind: 'idle'}, notice: null,
        activity: {exports: false, generations: false}}};
    },
    on() {},
    removeListener() {},
  });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {mioonDesktopUpdate}});
  t.after(() => {if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');});
  const id = (n: number) => `74000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const project = {id: id(1), name: 'Future clip'};
  for (const source of ['recent-card', 'editor-project-menu', 'file-picker'] as const) await t.test(source, async t => {
    requests.length = 0;
    const rows = projectEntryFixture([project]), identity = projectEntryOwnerFixture(() => rows);
    const preload = createProjectEntriesDesktopBridge(async (_channel, value) => {
      const action = (value as {action: string}).action;
      switch (action) {
        case 'capabilities': return {ok: true, data: {ready: true, create: false, open: true, saveAs: false, duplicate: false, copyTo: false, adoptCopy: false}};
        case 'takePendingOpen': return {ok: true, data: null};
        case 'openRecent': return {ok: true, data: {status: 'failed', reason: 'unavailable', failure: {code: PROJECT_READER_UPDATE_REQUIRED}}};
        case 'openSelectedFile': return {ok: false, error: {code: PROJECT_READER_UPDATE_REQUIRED, status: 409, details: {}}};
        default: assert.fail(`Unexpected project entry action ${action}`);
      }
    });
    const desktopClient = readProjectEntryDesktopClient({__mioonProjectEntries: preload});
    assert.ok(desktopClient);
    const desktop = createNativeProjectDesktopController({client: desktopClient, identity, beforeAction: async () => true,
      openCreated: async () => assert.fail('Update-required projects must not open'), message: () => ''});
    desktop.activate();
    t.after(() => {desktop.dispose(); identity.dispose();});
    const editor = source === 'editor-project-menu';
    await desktop.initialize(editor);
    if (source === 'file-picker') {
      assert.equal(await desktop.openFile(), false);
    } else {
      const context: ProjectWindowContext = {version: 2, role: editor ? 'editor' : 'launcher', windowId: id(2), contextId: id(3),
        backendId: id(4), initialProjectId: editor ? id(5) : null, autoOpen: false, editorProjectId: editor ? id(5) : null,
        editorPhase: editor ? 'ready' : 'none', editorCount: editor ? 1 : 0, entryMode: null, entryVersion: 0, entryReceipt: null,
        settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
      const unused = async () => assert.fail('The native recent open must use the project entry bridge');
      const bridge: ProjectWindowBridge = {context: async () => context, openProject: unused, publishLocatorStatus: unused,
        requestLocatorAction: unused, requestProjectEntry: unused, showProjects: unused, showSettings: unused, closeSettings: unused,
        editorStatus: unused, subscribe: () => () => {}};
      const entry = createProjectEntryController({client: {list: async () => [{...project, updatedAt: ''}], create: unused},
        bridge, context, identity, manageIdentityLifecycle: false, desktopClient,
        onNativeOpenError: (error, projectId) => desktop.observeError(error, 'open', projectId)});
      entry.activate();
      t.after(entry.dispose);
      assert.equal(await entry.open(project.id), false);
    }
    assert.equal(desktop.getState().failure?.issue.code, PROJECT_READER_UPDATE_REQUIRED);
    const html = ui.html('native-with-update', {desktop});
    assert.match(html, /需要更新 Mioon/);
    assert.match(html, /当前版本不支持/u);
    assert.match(html, /data-testid="pf-open-update"[^>]*>检查更新<\/button>/);
    assert.match(html, /data-testid="pf-open-close"[^>]*>知道了<\/button>/);
    assert.doesNotMatch(html, /data-testid="pf-open-(?:restore|retry)"/);

    const provider = harness(ui.DesktopUpdateRoot)({blocked: false, children: null});
    const tree = harness(ui.NativeProjectEntryDialogs, provider.props.value)({desktop});
    const dialog = nodes(tree).find(element => element.type === ui.ProjectOpenFailureDialog);
    assert.ok(dialog);
    const click = button(harness(ui.ProjectOpenFailureDialog)(dialog.props as unknown as ProjectOpenFailureDialogProps), 'pf-open-update');
    assert.equal(click.props.disabled, false);
    (click.props.onClick as () => void)();
    assert.deepEqual(requests, [[DESKTOP_UPDATE_CHANNEL, {kind: 'check'}]]);
    assert.equal(desktop.getState().failure, null);
  });
});
