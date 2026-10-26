import type {RootModule,RootControlledModules} from './helpers/strict-root-ui-types.ts';
import type {RootHook} from './helpers/strict-root-ui-types.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildSync, transformSync } from 'esbuild';
import { LANGUAGE_LABELS, LOCALES, translate, validateCatalogs, type DisplayMessage } from '../packages/i18n/src/index.ts';
import { shellMessages } from '../packages/i18n/src/catalogs/shell.ts';
import { settingsRedesignMessages } from '../packages/i18n/src/catalogs/settings-redesign.ts';
import { createI18nTestContext } from './helpers/i18n.ts';
import { createSettingsNavigationRegistry, type SettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { createWebSettingsNavigation } from '../apps/web/src/web-settings-navigation.ts';
import { hasOpenWorkbenchModal } from '../apps/web/src/workbench-modal-state.ts';
import { timelineSplitActionForKey, timelineHistoryActionForKey } from '../apps/web/src/timeline-keyboard.ts';
import {stripSourceTypes} from './helpers/eval-source.ts';
import type { ProjectWindowSettingsSlot } from '../apps/desktop/src/project-window-protocol.ts';
import type { SettingsPage } from '../apps/web/src/settings-window-state.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = (name: string) => readFileSync(join(root, 'apps/web/src', name), 'utf8');
const slots = ['agent', 'official', 'custom', 'comfy'];
const nodes = (value: RootTree) : RootNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const find = (tree: string|number|boolean|RootNode|RootTree[]|null|undefined, id: unknown) => { const node = nodes(tree).find(item => item.props?.['data-testid'] === id); assert.ok(node, id as string); return node; };
const text = (value: RootTree) : string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const htmlText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
function componentModule<File extends 'ProjectHomeConnections.tsx'|'workspace-visibility.tsx'|'WebSettingsCenter.tsx'>(filename: File, react: { createElement: ((type: string,props: Record<string,unknown>|null,...children: RootTree[]) => { type: string; props: { children: RootTree[]; }; })|((type: string,props: Record<string,unknown>|null,...children: RootTree[]) => { type: string; props: { children: RootTree[]; }; })|((type: string,props: Record<string,unknown>|null,...children: RootTree[]) => { type: string; props: { children: RootTree[]; }; }); Fragment?: string; useRef?: ((initial: unknown) => string|{ current: unknown; })|((initial: unknown) => RootHook); useId?: () => string; createContext?: (initial: unknown) => { Provider: string; initial: unknown; }; useContext?: () => boolean; useState?: (initial: unknown) => unknown[]; useEffect?: (effect: () => void|(() => void),deps: readonly unknown[]|undefined) => void; }, imports: Record<string,unknown>) {
  const module = { exports: {} as RootModule<RootControlledModules[File]> };
  Function('require', 'module', 'exports', transformSync(source(filename), { loader: filename.endsWith('.tsx') ? 'tsx' : 'jsx', format: 'cjs', jsx: 'transform' }).code)((name: string) => {
    if (name === 'react') return react;
    if (Object.hasOwn(imports, name)) return imports[name];
    if (name.endsWith('.css')) return {};
    assert.fail(`Unexpected dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}
// Execute the real shell while preserving its hook slots across page/language
// renders. Leaf form elements remain exact, distinguishable owner sentinels.
function shellHarness() {
  const hooks: (RootHook|string)[] = [], calls: unknown[][] = []; let cursor = 0, locale:import('../packages/i18n/src/index.ts').Locale = 'zh-Hans';
  const react = { createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }), Fragment: 'Fragment',
    useRef: (initial: unknown) => hooks[cursor++] ||= { current: initial },
    useId() { const index = cursor++; return hooks[index] ||= `settings-heading-${index}`; },
  }; (react as typeof react & {default?: unknown}).default = react;
  const Component = componentModule('ProjectHomeConnections.tsx', ((react) as unknown as Parameters<typeof componentModule>[1]), {
    './i18n/I18nProvider.tsx': { useI18n: () => createI18nTestContext(locale) },
    '@mioon/ui/components/button': { Button: 'Button' },
    '@mioon/ui/components/workbench-icons': {WorkbenchIcon:'WorkbenchIcon'},
    './LanguageControl.tsx': { __esModule: true, default: 'LanguageControl' },
    './icons.tsx': { __esModule: true, default: 'Icon' },
    './workspace-visibility.tsx': { WorkspaceVisibilityProvider: 'WorkspaceVisibilityProvider' },
    './settings-window-state.ts': { isSettingsConnectionPage: (page: string) => slots.includes(page) },
    './SettingsExtraPages.tsx': { SettingsAbout:'SettingsAbout', SettingsShortcuts:'SettingsShortcuts', SettingsModelServices:'SettingsModelServices' },
  }).default;
  const panes = Object.fromEntries(slots.map(slot => [slot, { type: `form:${slot}`, props: { 'data-testid': `owner-${slot}`, value: `retained-${slot}` } }]));
  const props = { selected: 'agent', page: 'agent', onSelect: (slot: unknown) => calls.push(['slot', slot]), onPage: (page: unknown) => calls.push(['page', page]), panes };
  return { calls, panes, render(patch: { page?: string|undefined; onPage?: undefined; selected?: string; active?: boolean; connectionsAvailable?: boolean; }|undefined = {}, nextLocale: import('../packages/i18n/src/index.ts').Locale|undefined = locale) { Object.assign(props, patch); locale = nextLocale; cursor = 0; return Component(props as unknown as Parameters<typeof Component>[0]); } };
}

test('settings shell has eight stable categories while connection owners retain four IPC slots', () => {
  const h = shellHarness(), categories = ['general','workspace','video-tools','models','agent','extensions','shortcuts','about'];
  for (const [page, category] of [['general','general'],['workspace','workspace'],['video-tools','video-tools'],['models','models'],['agent','agent'],['official','models'],['custom','extensions'],['comfy','extensions'],['shortcuts','shortcuts'],['about','about']]) {
    const tree = h.render({page});
    assert.equal(find(tree,'settings-center').props['data-page'],page);
    for(const id of categories) assert.equal(find(tree,`settings-category-${id}`).props['aria-current'],category===id?'page':undefined);
    for(const id of categories) assert.ok(find(tree,`settings-category-icon-${id}`));
    const nav=nodes(tree).find((node)=>node.props?.className==='settings-service-nav');
    const expected=category==='extensions'?['settings-service-custom','settings-service-comfy']:[];
    assert.equal((nav)!.props.hidden,!expected.length);assert.equal((nav)!.props.inert,!expected.length);
    assert.deepEqual(nodes(nav).filter((node)=>node.type==='Button').map(node=>node.props['data-testid']),expected);
  }
});

test('General derives its read-only number-format example from the current language without adding an editable setting', () => {
  const h = shellHarness();
  for (const locale of LOCALES) {
    const tree = h.render({ page: 'general' }, locale), example = find(tree, 'settings-number-format-example');
    assert.equal(example.type, 'output');
    assert.equal(example.props.onChange, undefined);
    assert.equal(text(example), createI18nTestContext(locale).formatNumber(12345.6));
    assert.ok(text(find(tree, 'settings-number-format')).includes(translate(locale, 'redesign.settings.followLanguage')));
  }
  assert.deepEqual((h.calls as unknown), []);
});
test('category and connection navigation delegates once without selecting a page locally',()=>{
 const h=shellHarness();let tree=h.render({page:'general'});find(tree,'settings-category-models').props.onClick();
 tree=h.render({page:'models'});(nodes(tree).find((node)=>node.type==='SettingsModelServices'))!.props.onOpenOfficial();find(tree,'settings-category-extensions').props.onClick();
 tree=h.render({page:'extensions'});find(tree,'settings-service-custom').props.onClick();find(tree,'settings-category-agent').props.onClick();
 assert.deepEqual(h.calls,[['page','models'],['page','official'],['page','extensions'],['page','custom'],['page','agent']]);assert.equal(find(tree,'settings-center').props['data-page'],'extensions');
});
test('legacy consumers can select connection slots but internal categories never become IPC slots',()=>{
 const h=shellHarness();let tree=h.render({page:undefined,onPage:undefined,selected:'official'});
 (nodes(tree).find((node)=>node.type==='SettingsModelServices'))!.props.onOpenOfficial();
 for(const id of ['general','workspace','models','extensions','shortcuts','about'])find(tree,`settings-category-${id}`).props.onClick();
 assert.deepEqual(h.calls,[['slot','official']]);
});

test('General does not mount unvisited connections and hiding visited forms retains exact keyed owners', () => {
  const h = shellHarness(); let tree = h.render({ page: 'general' });
  assert.equal(nodes(tree).filter(node => String(node.type).startsWith('form:')).length, 0);
  for (const page of slots) h.render({ page, selected: page });
  tree = h.render({ page: 'general' });
  const panes = nodes(tree).find((node) => node.props?.className === 'settings-connection-panes');
  assert.equal((panes)!.props.hidden, true); assert.equal((panes)!.props.inert, true);
  const provider = nodes(panes).find((node) => node.type === 'WorkspaceVisibilityProvider');
  assert.equal((provider)!.props.visible, false);
  const retained = nodes(provider).filter((node) => node.type === 'Fragment');
  assert.deepEqual(retained.map(node => node.props.key), slots);
  for (const slot of slots) assert.equal(find(tree, `owner-${slot}`), h.panes[slot]);
  for (const locale of LOCALES) {
    tree = h.render({ page: 'general' }, locale);
    for (const slot of slots) assert.equal(find(tree, `owner-${slot}`), h.panes[slot]);
  }
  tree = h.render({ page: 'official', selected: 'official' });
  assert.equal((nodes(tree).find((node) => node.type === 'WorkspaceVisibilityProvider'))!.props.visible, true);
  for (const slot of slots) assert.equal(find(tree, `owner-${slot}`), h.panes[slot]);
});

test('visibility composition hides descendants without dropping children or creating new form owners', () => {
  let ancestor = true;
  const react = { createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }),
    createContext: (initial: unknown) => ({ Provider: 'VisibilityContext', initial }), useContext: () => ancestor,
  }; (react as typeof react & {default?: unknown}).default = react;
  const { WorkspaceVisibilityProvider } = componentModule('workspace-visibility.tsx', react, {});
  const child = { type: 'form', props: { value: 'retained-draft' } };
  for (const parent of [true, false]) for (const visible of [true, false]) {
    ancestor = parent; const tree = WorkspaceVisibilityProvider({ visible, children: child } as unknown as Parameters<typeof WorkspaceVisibilityProvider>[0]);
    assert.equal(tree.props.value, parent && visible); assert.equal(tree.props.children[0], child);
  }
});

test('General language controls and category copy change in four locales without changing page or owner identity', () => {
  const h = shellHarness(); h.render({ page: 'custom', selected: 'custom' });
  const headings = new Set();
  for (const locale of LOCALES) {
    const tree = h.render({ page: 'general' }, locale), general = find(tree, 'settings-general');
    assert.equal(general.props.hidden, false); assert.equal(general.props.inert, false);
    assert.ok(text(general).includes(translate(locale, 'language.label')));
    assert.ok(text(general).includes(translate(locale, 'settings.languageHint')));
    assert.equal(nodes(general).filter((node) => node.type === 'LanguageControl').length, 1);
    for (const category of ['general','workspace','video-tools','models','agent','extensions','shortcuts','about']) assert.equal(text(find(tree, `settings-category-${category}`)), translate(locale, ((category === 'general' ? 'settings.general' : `redesign.settings.${category}`) as unknown as Parameters<typeof translate>[1])));
    headings.add(text(find(tree, 'settings-category-models')));
    assert.equal(find(tree, 'owner-custom'), h.panes.custom); assert.equal(find(tree, 'settings-center').props['data-page'], 'general');
    find(tree, 'settings-category-models').props.onClick();
  }
  assert.equal(headings.size, 4); assert.deepEqual(h.calls, LOCALES.map(() => ['page', 'models']));
});

test('retained language menu loses visibility when its page or settings owner is inactive', () => {
  const h = shellHarness();
  for (const active of [true, false]) for (const page of ['general', 'models']) {
    const general = find(h.render({ active, page }), 'settings-general');
    const language = nodes(general).find((node) => node.type === 'LanguageControl');
    assert.equal((language)!.props.visible, active && page === 'general');
  }
});

let presentation: (arg0: string,arg1: string) => unknown;
function renderPresentation(locale: string, page: string) {
  if (!presentation) {
    const fixture = `import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import ProjectHomeConnections from './src/ProjectHomeConnections.tsx';
      import { I18nProvider } from './src/i18n/I18nProvider.tsx';
      export function render(locale, page) {
        const snapshot = { ready: true, locale, preference: locale, persistence: 'saved', saving: false };
        const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, setPreference: async () => {} };
        const panes = Object.fromEntries(['agent', 'official', 'custom', 'comfy'].map(slot => [slot, <form data-owner={slot}><input defaultValue={'draft-' + slot} /></form>]));
        return renderToStaticMarkup(<I18nProvider store={store}><ProjectHomeConnections selected="agent" page={page} onSelect={() => {}} onPage={() => {}} panes={panes} /></I18nProvider>);
      }`;
    const built = buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: join(root, 'apps/web') }, bundle: true,
      platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
    const module = { exports: {} as {render(locale:string,page:string):string} }; Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
    presentation = module.exports.render;
  }
  return presentation(locale, page) as string;
}

test('actual shared controls render accessible four-language settings and one complete General language selector', () => {
  for (const locale of LOCALES) {
    const html = renderPresentation(locale, 'general');
    assert.ok(html.includes(`aria-label="${htmlText(translate(locale, 'settings.categories'))}"`));
    for (const key of ['settings.general', 'redesign.settings.models', 'redesign.settings.extensions', 'settings.languageHint']) assert.ok(html.includes(htmlText(translate(locale, ((key) as unknown as Parameters<typeof translate>[1])))), `${locale}/${key}`);
    assert.equal((html.match(/data-testid="language-select"/gu) || []).length, 1);
    assert.match(html, /role="combobox"/u);
    assert.ok(html.includes(`aria-label="${htmlText(translate(locale, 'language.label'))}"`));
    assert.ok(html.includes(htmlText(LANGUAGE_LABELS[locale])), `${locale} selected language`);
    assert.doesNotMatch(html, /data-owner=/u, 'Opening General must not mount connection forms or read provider settings');
    assert.doesNotMatch(html, /This message cannot be displayed right now\.|此提示暂时无法显示/u);
  }
  for (const slot of slots) assert.ok(renderPresentation('en', slot).includes(`data-owner="${slot}"`));
});

test('new settings copy has complete locale coverage and category identity remains outside native IPC', () => {
  const messages = Object.fromEntries(Object.entries(shellMessages).filter(([key]) => key.startsWith('settings.') || key === 'common.closeSettings'));
  assert.ok(Object.keys(messages).length >= 10); assert.deepEqual((validateCatalogs(messages) as unknown), []);
  assert.deepEqual((validateCatalogs(settingsRedesignMessages) as unknown), []);
  const desktop = readFileSync(join(root, 'apps/desktop/src/project-window-protocol.ts'), 'utf8');
  const slot = desktop.match(/export type ProjectWindowSettingsSlot\s*=\s*([^;]+);/u);
  assert.ok(slot); assert.doesNotMatch(slot[1], /general|models|extensions/u);
  for (const value of slots) assert.ok(slot[1].includes(`'${value}'`));
  for (const filename of ['ProjectHomeConnections.tsx', 'SettingsRoot.tsx', 'settings-window-state.ts'])
    assert.doesNotMatch(source(filename), /key=\{(?:locale|language|page|selected)\}/u, filename);
});

test('shared native center receives page routing and visibility without replacing existing close admission', () => {
  const native = source('SettingsRoot.tsx'), app = source('App.tsx');
  const main = app.slice(app.indexOf('export function SettingsConnectionForms('), app.indexOf('export default function App('));
  assert.match(native, /installNativeCloseAdmission/u); assert.match(native, /navigation\.selectPage/u);
  assert.match(native, /page:\s*navigation\.page/u); assert.match(native, /await requestClose\(\); return false/u);
  assert.match(main, /<ProjectHomeConnections\b/u); assert.match(main, /selected=\{selected\} page=\{page\}/u); assert.match(main, /slot="home:video-tools"/u);
  for (const slot of slots) assert.ok(main.includes(`page === '${slot}'`));
  assert.equal((main.match(/onRequestSelectSlot=\{onSelect(?: as[^}]*)?\}/gu) || []).length, 3);
  const recovery = native.indexOf('<details className="settings-workspace-status settings-workspace-status-global"');
  assert.ok(recovery >= 0 && recovery < native.indexOf("workspace === 'ready' ? renderSettings"), 'Native recovery status must remain outside category selection');
  assert.match(native, /<NativeLocatorStatus context=\{context\} bridge=\{bridge\} recovery/u);
  assert.match(native, /<ProjectHomeConnections selected="agent" page="general" connectionsAvailable=\{false\}/u);
  assert.match(native, /panes=\{\{ agent: null, official: null, custom: null, comfy: null \}\}/u);
  assert.doesNotMatch(native, /general:\s*<details/u);
  assert.doesNotMatch(native, /className="project-home-brand">Mioon<\/span>/u);
  assert.match(native, /className="native-settings-panel-title">\{t\('settings\.title'\)\}/u);
  assert.match(native, /data-testid="native-settings-panel-close"[^>]*onClick=\{\(\) => \{ void requestClose\(\); \}\}/u);
  assert.doesNotMatch(native, />mioon\.</u);
  assert.match(native, /className="native-settings-center-body"/u);
  const css = source('settings-center.css');
  assert.match(css, /:is\(\.web-settings-dialog, \.project-home-settings-window\) \.settings-center \{[^}]*flex: 1;[^}]*min-height: 0/u);
  assert.match(css, /:is\(\.web-settings-dialog, \.project-home-settings-window\) \.settings-appearance-actions \{ flex: none; position: static;/u);
  assert.match(css, /\.project-home-settings-window > \.project-home-settings \{[^}]*min-height: 0; overflow: hidden;/u);
  assert.match(css, /\.native-settings-center-body \{[^}]*flex: 1;[^}]*min-height: 0;[^}]*overflow: hidden;/u);
});

test('unavailable connections leave General usable while disabled categories and stale handlers cannot mount providers', () => {
  const h = shellHarness();
  for (const locale of LOCALES) {
    const tree = h.render({ page: 'general', connectionsAvailable: false }, locale);
    assert.notEqual(find(tree, 'settings-category-general').props.disabled, true);
    assert.equal(find(tree, 'settings-general').props.hidden, false);
    for (const category of ['models', 'agent', 'extensions']) {
      const button = find(tree, `settings-category-${category}`); assert.equal(button.props.disabled, true); button.props.onClick();
    }
    for (const page of ['models','extensions']) { const pane=h.render({page,connectionsAvailable:false},locale); for(const node of nodes(pane).filter((node)=>node.props?.['data-testid']?.startsWith('settings-service-'))) { assert.equal(node.props.disabled,true);node.props.onClick(); } }
    assert.equal(nodes(tree).filter(node => String(node.type).startsWith('form:')).length, 0);
  }
  assert.deepEqual((h.calls as unknown), []);
  find(h.render(), 'settings-category-general').props.onClick(); assert.deepEqual(h.calls, [['page', 'general']]);
});

function webHarness(confirm: { (): Promise<unknown>; (): Promise<unknown>; }|undefined = async () => true) {
  const hooks: RootHook[] = [], changes: unknown[] = [], controllers: { open: (next?: SettingsPage) => Promise<boolean>; selectPage: (next: SettingsPage) => Promise<boolean>; close: () => Promise<boolean>; activate(): void; dispose(): void; readonly opened: boolean; readonly page: SettingsPage; readonly selected: ProjectWindowSettingsSlot; readonly notice: ""|DisplayMessage; }[] = []; let cursor = 0, effects: (() => void)[] = [], locale = 'en';
  const registry = createSettingsNavigationRegistry();
  const react = { createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }),
    useRef: (initial: unknown) => hooks[cursor++] ||= { current: initial },
    useState(initial: unknown) { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, (next: unknown) => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next; }]; },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[] | undefined) { const index = cursor++, previous = hooks[index];
      if (!previous || deps!.some((value, i) => value !== previous.deps![i])) effects.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: effect() }; }); },
  }; (react as typeof react & {default?: unknown}).default = react;
  const Component = componentModule('WebSettingsCenter.tsx', react, {
    './i18n/I18nProvider.tsx': { useI18n: () => createI18nTestContext(((locale) as unknown as Parameters<typeof createI18nTestContext>[0])) },
    '@mioon/ui/components/dialog': { Dialog: 'Dialog', DialogContent: 'DialogContent', DialogTitle: 'DialogTitle' },
    '@mioon/ui/components/button': { Button: 'Button' },
    '@mioon/ui/components/workbench-icons': {WorkbenchIcon:'WorkbenchIcon'},
    '@mioon/ui/components/workbench-confirm': { useConfirmation: () => confirm },
    './web-settings-navigation.ts': { createWebSettingsNavigation: (options: { registry: SettingsNavigationRegistry; confirm: (message: DisplayMessage) => Promise<boolean>; onChange?: () => void; }) => { const navigation = createWebSettingsNavigation(options); controllers.push(navigation); return navigation; } },
  }).default;
  const props = { request: null, registry, onOpenChange: (opened: unknown) => changes.push(opened), renderSettings: (props: unknown) => ({ type: 'SettingsConnectionForms', props }) };
  return { registry, changes, controllers, render(patch: { request?: { page: string; }|{ page: string; }|{ page: string; }|{ page: string; resolve: (value: unknown) => number; }|{ page: string; resolve: (value: unknown) => number; }|{ page: string; resolve: (value: unknown) => number; }; connectionsAvailable?: boolean; }|undefined = {}, nextLocale: string|undefined = locale) { Object.assign(props, patch); locale = nextLocale; cursor = 0; effects = [];
    const tree = Component(props as unknown as Parameters<typeof Component>[0]); for (const effect of effects) effect(); return tree; },
    unmount() { for (const hook of hooks) hook.cleanup?.(); },
  };
}

test('web dialog retains its guarded controller and form shell while closed, reopened and relocalized', async () => {
  const h = webHarness(); let tree = h.render();
  let content = find(tree, 'web-settings-dialog');
  assert.equal(content.props.keepMounted, true); assert.equal(content.props.hidden, true); assert.equal(content.props.inert, true);
  assert.equal(nodes(tree).filter((node) => node.type === 'SettingsConnectionForms').length, 1, 'Closing hides rather than conditionally removing the forms shell');
  h.render({ request: { page: 'custom' } }); tree = h.render();
  assert.equal(tree.type, 'Dialog'); assert.equal(tree.props.open, true);
  content = find(tree, 'web-settings-dialog'); assert.equal(content.props.hidden, false); assert.equal(content.props.inert, false);
  const navigation = h.controllers[0];
  for (const locale of LOCALES) {
    tree = h.render({}, locale); const forms = nodes(tree).find((node) => node.type === 'SettingsConnectionForms');
    assert.equal((forms)!.props.registry, h.registry); assert.equal((forms)!.props.page, 'custom'); assert.equal((forms)!.props.visible, true);
    assert.equal(h.controllers.length, 1); assert.equal(h.controllers[0], navigation);
  }
  find(tree, 'settings-center-close').props.onClick(); tree = h.render();
  assert.equal(tree.props.open, false); assert.equal((nodes(tree).find((node) => node.type === 'SettingsConnectionForms'))!.props.visible, false);
  h.render({ request: { page: 'custom' } }); tree = h.render();
  assert.equal(tree.props.open, true); assert.equal(h.controllers[0], navigation); assert.equal(h.controllers.length, 1);
  h.unmount(); assert.equal(await navigation.open('general'), false);
});

test('web close button, dismissal and form Back all use the same exact dirty guard without clearing owners', async () => {
  for (const close of ['button', 'dismiss', 'back']) {
    const answer = Promise.withResolvers(), h = webHarness(() => answer.promise);
    h.render({ request: { page: 'agent' } }); const tree = h.render();
    const owner = h.registry.register('home:agent'); owner.update({ dirty: true, busy: false, blocked: false, version: 1 });
    const captured = h.registry.capture();
    if (close === 'button') find(tree, 'settings-center-close').props.onClick();
    else if (close === 'dismiss') tree.props.onOpenChange(false);
    else assert.equal(await (nodes(tree).find((node) => node.type === 'SettingsConnectionForms'))!.props.beforeClose!(), false, 'Form Back must not clear its own session before guard completion');
    assert.equal(h.controllers[0].opened, true); answer.resolve(false); await new Promise(setImmediate);
    assert.equal(h.render().props.open, true); assert.deepEqual(h.registry.capture(), captured);
    h.unmount();
  }
});

test('web open request reports guarded acceptance to its caller rather than treating a cancelled transition as open', async () => {
  const answer = Promise.withResolvers(), h = webHarness(() => answer.promise), accepted: unknown[] = [], rejected: unknown[] = [];
  h.render({ request: { page: 'agent', resolve: value => accepted.push(value) } }); await new Promise(setImmediate);
  assert.deepEqual(accepted, [true]);
  const owner = h.registry.register('home:agent'); owner.update({ dirty: true, busy: false, blocked: false, version: 1 });
  const captured = h.registry.capture();
  h.render({ request: { page: 'custom', resolve: value => rejected.push(value) } });
  assert.deepEqual((rejected as unknown), []); assert.equal(h.controllers[0].page, 'agent');
  answer.resolve(false); await new Promise(setImmediate); h.render();
  assert.deepEqual(rejected, [false]); assert.deepEqual(accepted, [true]);
  assert.equal(h.controllers[0].page, 'agent'); assert.deepEqual(h.registry.capture(), captured);
  h.unmount();
});

test('restored web requests normalize to General and cannot activate model pages through stale form callbacks', async () => {
  const h = webHarness(), results: unknown[] = [];
  h.render({ request: { page: 'custom', resolve: value => results.push(value) }, connectionsAvailable: false });
  await new Promise(setImmediate); const tree = h.render(), forms = nodes(tree).find((node) => node.type === 'SettingsConnectionForms');
  assert.deepEqual(results, [true]); assert.equal(tree.props.open, true); assert.equal((forms)!.props.page, 'general');
  assert.equal((forms)!.props.connectionsAvailable, false); assert.equal((forms)!.props.registry, h.registry);
  (forms)!.props.onSelect('custom'); (forms)!.props.onPage('comfy');
  assert.equal(h.controllers[0].page, 'general'); assert.deepEqual((h.registry.capture() as unknown), []);
  const app = source('App.tsx'); assert.match(app, /connectionsAvailable=\{!application && !restored\}/u);
  h.unmount();
});

test('web center stays first keyed sibling across home and workbench rather than replacing the editor tree', () => {
  const app = source('App.tsx');
  assert.match(app, /const webSettingsCenter = nativeWindow \? null : <WebSettingsCenter key="global-settings-center" request=\{webSettingsRequest\} registry=\{settingsNavigation\.current\}/u);
  assert.match(app, /if \(!workbenchReady && !retainWorkbenchForClip\) return <>\{webSettingsCenter\}<ProjectHome/u);
  assert.match(app, /return <>\{webSettingsCenter\}<main className=\{`workbench/u);
  assert.doesNotMatch(app, /webSettingsOpen\s*\?\s*<WebSettingsCenter|webSettingsOpen\s*&&\s*<WebSettingsCenter/u);
  const web = source('WebSettingsCenter.tsx');
  assert.match(web, /import \{ Dialog, DialogContent, DialogTitle \} from '@mioon\/ui\/components\/dialog'/u);
  assert.match(web, /<DialogContent keepMounted showCloseButton=\{false\} initialFocus=\{closeButton\}/u);
  assert.match(web, /hidden=\{!navigation\.opened\} inert=\{!navigation\.opened\}/u);
  assert.doesNotMatch(web, /navigation\.opened\s*&&\s*renderSettings|key=\{(?:locale|language|page|selected|request)/u);
});

function modalElement(attributes:Record<string,string|undefined> = {}, parent:import('./helpers/strict-root-ui-types.ts').RootModalElement|null = null):import('./helpers/strict-root-ui-types.ts').RootModalElement {
  return { attributes, parent,
    closest(selector: string) { for (let element:import('./helpers/strict-root-ui-types.ts').RootModalElement|null = this; element; element = element.parent) {
      if (selector.split(',').some((part) => { const match = part.trim().match(/^\[([\w-]+)(?:="([^"]*)")?\]$/u);
        return match && Object.hasOwn(element.attributes, match[1]) && (match[2] === undefined || element.attributes[match[1]] === match[2]); })) return element;
    } return null; },
  };
}
function modalDocument(dialogs:import('./helpers/strict-root-ui-types.ts').RootModalElement[]) { return { querySelectorAll(selector: unknown) {
  assert.equal(selector, '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'); return dialogs;
} }; }

test('only reachable modals block shortcuts, including hidden/inert/closed/aria-hidden ancestors', () => {
  assert.equal(hasOpenWorkbenchModal(((modalDocument([])) as unknown as Parameters<typeof hasOpenWorkbenchModal>[0])), false);
  for (const attribute of ['hidden', 'inert', 'data-closed', 'aria-hidden']) for (const inherited of [false, true]) {
    const blocked = { [attribute]: attribute === 'aria-hidden' ? 'true' : '' };
    const dialog = inherited ? modalElement({ role: 'dialog' }, modalElement(blocked)) : modalElement({ role: 'dialog', ...blocked });
    assert.equal(hasOpenWorkbenchModal(((modalDocument([dialog])) as unknown as Parameters<typeof hasOpenWorkbenchModal>[0])), false, `${attribute}, inherited=${inherited}`);
    assert.equal(hasOpenWorkbenchModal(((modalDocument([dialog, modalElement({ role: 'alertdialog' })])) as unknown as Parameters<typeof hasOpenWorkbenchModal>[0])), true, 'A separate open confirmation remains a blocker');
  }
  assert.equal(hasOpenWorkbenchModal(((modalDocument([modalElement({ role: 'dialog', 'aria-hidden': 'false' })])) as unknown as Parameters<typeof hasOpenWorkbenchModal>[0])), true);
});

test('actual App Ctrl+B and undo handlers work before settings opens and after close, but not with an open confirmation', () => {
  const app = source('App.tsx'), guards = app.indexOf('const guards = { modalOpen: hasOpenWorkbenchModal(document) }');
  assert.ok(guards >= 0); const start = app.lastIndexOf('    const onKeyDown = (event: KeyboardEvent) => {', guards), end = app.indexOf("    window.addEventListener('keydown', onKeyDown);", guards);
  assert.ok(start >= 0 && end > start);
  const settings = modalElement({ role: 'dialog', hidden: '' }), confirmation = modalElement({ role: 'alertdialog', 'data-closed': '' });
  const calls: unknown[] = [], env = { application:null, viewRef: { current: { activeMode: 'editing' } }, document: modalDocument([settings, confirmation]),
    hasOpenWorkbenchModal, timelineSplitActionForKey, timelineHistoryActionForKey, splitState: { canSplit: true }, historyState: { canUndo: true, canRedo: true },
    splitTimelineClip: () => calls.push('split'), changeTimelineHistory: (direction: unknown) => calls.push(direction),
  };
  const onKeyDown = Function('env', `with (env) { ${stripSourceTypes(app.slice(start, end))}; return onKeyDown; }`)(env);
  const press = (key: string) => { let prevented = false; onKeyDown({ key, ctrlKey: true, metaKey: false, target: { closest: () => null }, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(press('b'), true); assert.equal(press('z'), true); assert.deepEqual(calls, ['split', 'undo']);
  delete settings.attributes.hidden; assert.equal(press('b'), false); assert.equal(press('z'), false);
  settings.attributes['data-closed'] = ''; assert.equal(press('b'), true); assert.equal(press('z'), true);
  delete settings.attributes['data-closed']; assert.equal(press('b'), false);
  settings.attributes.inert = ''; delete confirmation.attributes['data-closed'];
  assert.equal(press('b'), false); assert.equal(press('z'), false);
  confirmation.attributes['aria-hidden'] = 'true'; assert.equal(press('b'), true); assert.equal(press('z'), true);
  assert.deepEqual(calls, ['split', 'undo', 'split', 'undo', 'split', 'undo']);
});

function composerSettingsHandler(kind: string, callback: { (): Promise<unknown>; (): Promise<unknown>; (): unknown; }) {
  const visibility: unknown[] = [], requests: string[] = [], owner = { projectId: 'synthetic-project', closed: false }, interaction = { id: 'current-interaction' };
  let reads = 0;
  const current = { setVisible(value: unknown) { visibility.push(value); if (value) reads++; },
    load: () => assert.fail('Opening settings cannot explicitly reload the composer'),
    generate: () => assert.fail('Opening settings cannot generate'), send: () => assert.fail('Opening settings cannot send'),
  };
  const env = { owner, interaction, projectId: owner.projectId, visible: true, composerVisible: true,
    lifetime: { current: owner }, session: { current }, interactionRef: { current: interaction }, visibilityRef: { current: true },
    document: { visibilityState: 'visible' }, nativeSettingsScope: null, comfy: false, custom: false,
    onClose: () => assert.fail('Opening settings cannot close the composer'),
    onSettings: () => { requests.push('agent'); return callback(); },
    onOpenSettings: (slot: string) => { requests.push(slot); return callback(); },
    setSettingsSlot: () => assert.fail('The independent center must not select a legacy inline slot'),
    setPage: () => assert.fail('The independent center must not show a legacy inline page'),
  };
  let click;
  if (kind === 'agent') {
    const code = source('AgentPanel.tsx'), start = code.indexOf('  const usable ='), end = code.indexOf('  const { snapshot, phase } = state;', start);
    assert.ok(start >= 0 && end > start);
    click = Function('env', `with (env) { ${stripSourceTypes(code.slice(start, end))}; return () => dismiss(true); }`)(env);
  } else {
    const code = source('ImageGeneration.tsx'), button = code.indexOf('data-testid="image-settings-open"');
    const start = code.indexOf('onClick={', button) + 'onClick={'.length, end = code.indexOf('})}><Icon name="settings"', start) + 2;
    assert.ok(button >= 0 && start > button && end > start);
    (env as typeof env&{run:(action:(session:typeof env.session.current)=>unknown)=>unknown}).run = (action: (arg0: { setVisible(value: unknown): void; load: () => never; generate: () => never; send: () => never; }) => unknown) => action(env.session.current);
    click = Function('env', `with (env) { return (${stripSourceTypes(code.slice(start, end)).replace(/;\s*$/u, '')}); }`)(env);
  }
  return { env, current, visibility, requests, click, get reads() { return reads; } };
}

for (const kind of ['agent', 'image']) {
  test(`${kind} rejected settings restores only current visibility, including hidden-document denial and thrown callbacks`, async () => {
    for (const hidden of [false, true]) for (const outcome of ['denied', 'throws', 'rejects']) {
      const answer = Promise.withResolvers();
      const h = composerSettingsHandler(kind, () => outcome === 'throws' ? (() => { throw Error('synthetic callback failure'); })() : outcome === 'rejects' ? Promise.reject(Error('synthetic callback rejection')) : answer.promise);
      assert.doesNotThrow(h.click, 'Synchronous callback failure must follow guarded rejection handling');
      assert.deepEqual(h.visibility, [false]); assert.equal(h.env.interactionRef.current, null);
      if (hidden) h.env.document.visibilityState = 'hidden';
      answer.resolve(false); await new Promise(setImmediate);
      assert.deepEqual(h.visibility, [false, !hidden], `${kind}/${outcome}/hidden=${hidden}`);
      assert.equal(h.env.interactionRef.current, h.env.interaction); assert.equal(h.reads, hidden ? 0 : 1);
      assert.deepEqual(h.requests, [kind === 'agent' ? 'agent' : 'official']);
    }
  });

  test(`${kind} late rejected settings cannot revive a superseded session, owner, interaction or hidden pane`, async () => {
    for (const transition of ['accepted', 'session', 'owner', 'closed', 'pane', 'interaction']) {
      const answer = Promise.withResolvers(), h = composerSettingsHandler(kind, () => answer.promise); h.click();
      if (transition === 'session') h.env.session.current = { setVisible: () => assert.fail('A replacement session cannot be touched') } as unknown as typeof h.env.session.current;
      if (transition === 'owner') h.env.lifetime.current = { projectId: 'replacement-project', closed: false };
      if (transition === 'closed') h.env.owner.closed = true;
      if (transition === 'pane') h.env.visibilityRef.current = false;
      if (transition === 'interaction') h.env.interactionRef.current = { id: 'newer-interaction' };
      const interaction = h.env.interactionRef.current;
      answer.resolve(transition === 'accepted'); await new Promise(setImmediate);
      assert.deepEqual(h.visibility, [false], `${kind}/${transition}`); assert.equal(h.reads, 0);
      assert.equal(h.env.interactionRef.current, interaction);
    }
  });
}
