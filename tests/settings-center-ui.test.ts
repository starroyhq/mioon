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
import {createProjectEntryIdentityOwner} from '../apps/web/src/project-entry-identity.ts';
import { timelineSplitActionForKey, timelineHistoryActionForKey } from '../apps/web/src/timeline-keyboard.ts';
import {stripSourceTypes} from './helpers/eval-source.ts';
import type { ProjectWindowSettingsSlot } from '../apps/desktop/src/project-window-protocol.ts';
import { isProjectWindowSettingsSlot } from '../apps/desktop/src/project-window-protocol.ts';
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
    './GenerationLiveGateNotice.tsx': {__esModule: true, default: 'GenerationLiveGateNotice'},
    './LanguageControl.tsx': { __esModule: true, default: 'LanguageControl' },
    './icons.tsx': { __esModule: true, default: 'Icon' },
    './workspace-visibility.tsx': { WorkspaceVisibilityProvider: 'WorkspaceVisibilityProvider' },
    './settings-window-state.ts': { isSettingsConnectionPage: (page: string) => slots.includes(page), normalizeSettingsPage: (page: string) => page === 'extensions' ? 'models' : page },
    './SettingsExtraPages.tsx': { SettingsAbout:'SettingsAbout', SettingsShortcuts:'SettingsShortcuts', SettingsModelServices:'SettingsModelServices' },
  }).default;
  const panes = {agent: {type: 'form:agent', props: {'data-testid': 'owner-agent', value: 'retained-agent'}}};
  const generationServices = {type: 'form:generation', props: {'data-testid': 'owner-generation', value: 'retained-generation'}};
  const props = { selected: 'agent', page: 'agent', onSelect: (slot: unknown) => calls.push(['slot', slot]), onPage: (page: unknown) => calls.push(['page', page]), panes, generationServices };
  return { calls, panes, generationServices, render(patch: { page?: string|undefined; onPage?: undefined; selected?: string; active?: boolean; connectionsAvailable?: boolean; }|undefined = {}, nextLocale: import('../packages/i18n/src/index.ts').Locale|undefined = locale) { Object.assign(props, patch); locale = nextLocale; cursor = 0; return Component(props as unknown as Parameters<typeof Component>[0]); } };
}

test('settings shell has seven categories and every fixed generation intention uses one services page without a second navigation', () => {
  const h = shellHarness(), categories = ['general','workspace','video-tools','models','agent','shortcuts','about'];
  for (const [page, category] of [['general','general'],['workspace','workspace'],['video-tools','video-tools'],['models','models'],['agent','agent'],['official','models'],['custom','models'],['comfy','models'],['extensions','models'],['shortcuts','shortcuts'],['about','about']]) {
    const tree = h.render({page});
    assert.equal(find(tree,'settings-center').props['data-page'],page==='extensions'?'models':page);
    for(const id of categories) assert.equal(find(tree,`settings-category-${id}`).props['aria-current'],category===id?'page':undefined);
    for(const id of categories) assert.ok(find(tree,`settings-category-icon-${id}`));
    assert.equal(nodes(tree).some(node => node.props?.className === 'settings-service-nav' || node.props?.className === 'settings-service-back'), false);
    assert.equal(nodes(tree).some(node => node.type === 'SettingsModelServices'), false);
    if (category === 'models') {
      assert.equal(find(tree, 'owner-generation'), h.generationServices);
      const provider = nodes(tree).find(node => node.type === 'WorkspaceVisibilityProvider' && nodes(node).some(child => Object.is(child, h.generationServices)));
      assert.equal(provider!.props.visible, true);
    }
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
test('category navigation delegates once without creating a second service navigation or selecting a page locally',()=>{
 const h=shellHarness();let tree=h.render({page:'general'});find(tree,'settings-category-models').props.onClick();
 tree=h.render({page:'models'});assert.equal(find(tree,'owner-generation'),h.generationServices);
 tree=h.render({page:'extensions'});find(tree,'settings-category-agent').props.onClick();
 assert.deepEqual(h.calls,[['page','models'],['page','agent']]);assert.equal(find(tree,'settings-center').props['data-page'],'models');
});
test('fixed legacy image intentions enter the retained generation owner while internal categories never become IPC slots',()=>{
 const h=shellHarness();let tree=h.render({page:undefined,onPage:undefined,selected:'official'});
 assert.equal(find(tree,'owner-generation'),h.generationServices);
 for(const id of ['general','workspace','models','shortcuts','about'])find(tree,`settings-category-${id}`).props.onClick();
 assert.deepEqual(h.calls,[]);find(tree,'settings-category-agent').props.onClick();assert.deepEqual(h.calls,[['slot','agent']]);
});

test('General does not mount unvisited services and hiding or switching visited categories retains their exact owners', () => {
  const h = shellHarness(); let tree = h.render({ page: 'general' });
  assert.equal(nodes(tree).filter(node => String(node.type).startsWith('form:')).length, 0);
  for (const page of ['agent', 'models', 'official', 'custom', 'comfy', 'extensions']) h.render({ page });
  tree = h.render({ page: 'general' });
  const panes = nodes(tree).find((node) => node.props?.className === 'settings-connection-panes');
  assert.equal((panes)!.props.hidden, true); assert.equal((panes)!.props.inert, true);
  const providers = nodes(panes).filter(node => node.type === 'WorkspaceVisibilityProvider');
  assert.equal(providers.length, 2); assert.ok(providers.every(provider => provider.props.visible === false));
  assert.equal(find(tree, 'owner-agent'), h.panes.agent); assert.equal(find(tree, 'owner-generation'), h.generationServices);
  for (const locale of LOCALES) {
    tree = h.render({ page: 'general' }, locale);
    assert.equal(find(tree, 'owner-agent'), h.panes.agent); assert.equal(find(tree, 'owner-generation'), h.generationServices);
  }
  tree = h.render({ page: 'official', selected: 'official' });
  assert.equal((nodes(tree).find(node => node.type === 'WorkspaceVisibilityProvider' && nodes(node).some(child => Object.is(child, h.generationServices))))!.props.visible, true);
  assert.equal(find(tree, 'owner-agent'), h.panes.agent); assert.equal(find(tree, 'owner-generation'), h.generationServices);
  tree = h.render({active: false});
  assert.ok(nodes(tree).filter(node => node.type === 'WorkspaceVisibilityProvider').every(provider => provider.props.visible === false));
  assert.equal(find(tree, 'owner-generation'), h.generationServices);
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
    for (const category of ['general','workspace','video-tools','models','agent','shortcuts','about']) assert.equal(text(find(tree, `settings-category-${category}`)), translate(locale, ((category === 'general' ? 'settings.general' : `redesign.settings.${category}`) as unknown as Parameters<typeof translate>[1])));
    headings.add(text(find(tree, 'settings-category-models')));
    assert.equal(find(tree, 'owner-generation'), h.generationServices); assert.equal(find(tree, 'settings-center').props['data-page'], 'general');
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
        const panes = {agent: <form data-owner="agent"><input defaultValue="draft-agent" /></form>};
        const generationServices = <form data-owner="generation"><input defaultValue="draft-generation" /></form>;
        return renderToStaticMarkup(<I18nProvider store={store}><ProjectHomeConnections selected="agent" page={page} onSelect={() => {}} onPage={() => {}} panes={panes} generationServices={generationServices} /></I18nProvider>);
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
    for (const key of ['settings.general', 'redesign.settings.models', 'settings.languageHint']) assert.ok(html.includes(htmlText(translate(locale, ((key) as unknown as Parameters<typeof translate>[1])))), `${locale}/${key}`);
    assert.equal((html.match(/data-testid="language-select"/gu) || []).length, 1);
    assert.match(html, /role="combobox"/u);
    assert.ok(html.includes(`aria-label="${htmlText(translate(locale, 'language.label'))}"`));
    assert.ok(html.includes(htmlText(LANGUAGE_LABELS[locale])), `${locale} selected language`);
    assert.doesNotMatch(html, /data-owner=/u, 'Opening General must not mount connection forms or read provider settings');
    assert.doesNotMatch(html, /This message cannot be displayed right now\.|此提示暂时无法显示/u);
  }
  for (const slot of [...slots, 'models', 'extensions']) assert.ok(renderPresentation('en', slot).includes(`data-owner="${slot === 'agent' ? 'agent' : 'generation'}"`));
});

test('settings copy has complete locale coverage and native page intentions use a fixed allowlist', () => {
  const messages = Object.fromEntries(Object.entries(shellMessages).filter(([key]) => key.startsWith('settings.') || key === 'common.closeSettings'));
  assert.ok(Object.keys(messages).length >= 10); assert.deepEqual((validateCatalogs(messages) as unknown), []);
  assert.deepEqual((validateCatalogs(settingsRedesignMessages) as unknown), []);
  for (const value of [...slots, 'general', 'workspace', 'video-tools', 'models', 'extensions', 'shortcuts', 'about'])
    assert.equal(isProjectWindowSettingsSlot(value), true);
  for (const value of ['admin', 'reload', '../general', {page: 'general'}, undefined])
    assert.equal(isProjectWindowSettingsSlot(value), false);
  for (const filename of ['ProjectHomeConnections.tsx', 'SettingsRoot.tsx', 'settings-window-state.ts'])
    assert.doesNotMatch(source(filename), /key=\{(?:locale|language|page|selected)\}/u, filename);
});

test('shared native center receives page routing and visibility without replacing existing close admission', () => {
  const native = source('SettingsRoot.tsx'), app = source('App.tsx');
  const main = app.slice(app.indexOf('export function SettingsConnectionForms('), app.indexOf('export default function App('));
  assert.match(native, /installNativeCloseAdmission/u); assert.match(native, /navigation\.selectPage/u);
  assert.match(native, /page:\s*navigation\.page/u); assert.match(native, /await requestClose\(\); return false/u);
  assert.match(main, /<ProjectHomeConnections\b/u); assert.match(main, /selected=\{selected\} page=\{page\}/u); assert.match(main, /slot="home:video-tools"/u);
  assert.match(main, /\['models', 'extensions', 'official', 'custom', 'comfy'\]\.includes\(page\)/u);
  assert.match(main, /slot="home:generation-services"/u); assert.match(main, /<GenerationServicesSettings active=\{visible && connectionsAvailable && generationCategory\} page=\{page\}/u);
  assert.doesNotMatch(main, /home:(?:video-models|official|custom|comfy)|<VideoProviderSettings|<ImageSettings|<CustomImageServicesSettings|<ComfyImageSettings/u);
  const recovery = native.indexOf('<details className="settings-workspace-status settings-workspace-status-global"');
  assert.ok(recovery >= 0 && recovery < native.indexOf("workspace === 'ready' ? renderSettings"), 'Native recovery status must remain outside category selection');
  assert.match(native, /<ProjectEntryIdentityStatus owner=\{identity\}/u);
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

test('actual parent composition supplies one generation registry owner and keeps every fixed target inside that page', () => {
  const app = source('App.tsx'), start = app.indexOf('export function SettingsConnectionForms('), end = app.indexOf('export default function App(');
  assert.ok(start >= 0 && end > start);
  const React = {createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({type, props: {...props, children}}), Fragment: 'Fragment'};
  const dependencies = {React, useI18n: () => createI18nTestContext('en'), ProjectHomeConnections: 'ProjectHomeConnections',
    SettingsWorkspace: 'SettingsWorkspace', SettingsNavigationSlot: 'SettingsNavigationSlot', SettingsVideoTools: 'SettingsVideoTools',
    GenerationServicesSettings: 'GenerationServicesSettings', SettingsAppearance: 'SettingsAppearance', AgentDockPane: 'AgentDockPane', AgentSettings: 'AgentSettings'};
  const module: {exports: {SettingsConnectionForms?: (props: Record<string, unknown>) => RootNode}} = {exports: {}};
  Function('module', 'exports', ...Object.keys(dependencies), transformSync(app.slice(start, end), {loader: 'tsx', format: 'cjs'}).code)(module, module.exports, ...Object.values(dependencies));
  const registry = createSettingsNavigationRegistry(), report = () => {}, forms = module.exports.SettingsConnectionForms;
  assert.ok(forms);
  for (const page of ['general','workspace','video-tools','models','extensions','official','custom','comfy','agent'] as const) for (const visible of [true, false]) for (const connectionsAvailable of [true, false]) {
    const tree = forms({selected: 'agent', page, entryVersion: 37, visible, registry, onSelect: () => {}, onPage: () => {}, general: null, connectionsAvailable});
    assert.equal(tree.type, 'ProjectHomeConnections'); assert.equal(tree.props.page, page); assert.equal(tree.props.active, visible);
    assert.deepEqual(Object.keys(tree.props.panes as object), ['agent']);
    const slot = tree.props.generationServices as RootNode;
    assert.equal(slot.type, 'SettingsNavigationSlot'); assert.equal(slot.props.slot, 'home:generation-services'); assert.equal(slot.props.registry, registry);
    const render = slot.props.children[0] as unknown as (callback: typeof report) => RootNode, generation = render(report);
    assert.equal(generation.type, 'GenerationServicesSettings'); assert.equal(generation.props.page, page); assert.equal(generation.props.entryVersion, 37); assert.equal(generation.props.onNavigationStateChange, report);
    assert.equal(generation.props.active, visible && connectionsAvailable && ['models','extensions','official','custom','comfy'].includes(page));
    assert.equal('videoModels' in tree.props, false);
  }
});

test('unavailable connections leave General usable while disabled categories and stale handlers cannot mount providers', () => {
  const h = shellHarness();
  for (const locale of LOCALES) {
    const tree = h.render({ page: 'general', connectionsAvailable: false }, locale);
    assert.notEqual(find(tree, 'settings-category-general').props.disabled, true);
    assert.equal(find(tree, 'settings-general').props.hidden, false);
    for (const category of ['models', 'agent']) {
      const button = find(tree, `settings-category-${category}`); assert.equal(button.props.disabled, true); button.props.onClick();
    }
    for (const page of ['models','extensions','official','custom','comfy']) {
      const pane=h.render({page,connectionsAvailable:false},locale);
      assert.equal(nodes(pane).filter(node => String(node.type).startsWith('form:')).length, 0);
    }
    assert.equal(nodes(tree).filter(node => String(node.type).startsWith('form:')).length, 0);
  }
  assert.deepEqual((h.calls as unknown), []);
  find(h.render(), 'settings-category-general').props.onClick(); assert.deepEqual(h.calls, [['page', 'general']]);
});

function webHarness(confirm: { (): Promise<unknown>; (): Promise<unknown>; }|undefined = async () => true) {
  const hooks: RootHook[] = [], changes: unknown[] = [], controllers: { open: (next?: SettingsPage) => Promise<boolean>; selectPage: (next: SettingsPage) => Promise<boolean>; close: () => Promise<boolean>; activate(): void; dispose(): void; readonly opened: boolean; readonly page: SettingsPage; readonly selected: ProjectWindowSettingsSlot; readonly notice: ""|DisplayMessage; }[] = []; let cursor = 0, effects: (() => void)[] = [], locale = 'en';
  const registry = createSettingsNavigationRegistry(), effectCallbacks = new Map<number, () => void | (() => void)>();
  const password = {value: 'SYNTHETIC_RETAINED_WEB_KEY'}, input = {type: 'input', props: {'data-testid': 'retained-web-key', ref: {current: password}}};
  const react = { createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }),
    useRef: (initial: unknown) => hooks[cursor++] ||= { current: initial },
    useState(initial: unknown) { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, (next: unknown) => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next; }]; },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[] | undefined) { const index = cursor++, previous = hooks[index];
      if (!previous || deps!.some((value, i) => value !== previous.deps![i])) effects.push(() => { previous?.cleanup?.(); effectCallbacks.set(index, effect); hooks[index] = { deps, cleanup: effect() }; }); },
  }; (react as typeof react & {default?: unknown}).default = react;
  const Component = componentModule('WebSettingsCenter.tsx', react, {
    './i18n/I18nProvider.tsx': { useI18n: () => createI18nTestContext(((locale) as unknown as Parameters<typeof createI18nTestContext>[0])) },
    '@mioon/ui/components/dialog': { Dialog: 'Dialog', DialogContent: 'DialogContent', DialogTitle: 'DialogTitle' },
    '@mioon/ui/components/button': { Button: 'Button' },
    '@mioon/ui/components/workbench-icons': {WorkbenchIcon:'WorkbenchIcon'},
    '@mioon/ui/components/workbench-confirm': { useConfirmation: () => confirm },
    './web-settings-navigation.ts': { createWebSettingsNavigation: (options: { registry: SettingsNavigationRegistry; confirm: (message: DisplayMessage) => Promise<boolean>; onChange?: () => void; }) => { const navigation = createWebSettingsNavigation(options); controllers.push(navigation); return navigation; } },
  }).default;
  const props = { request: null, registry, onOpenChange: (opened: unknown) => changes.push(opened), renderSettings: (props: unknown) => ({ type: 'SettingsConnectionForms', props: {...props as Record<string, unknown>, children: [input]} }) };
  return { registry, changes, controllers, password, input, render(patch: { request?: { page: string; }|{ page: string; }|{ page: string; }|{ page: string; resolve: (value: unknown) => number; }|{ page: string; resolve: (value: unknown) => number; }|{ page: string; resolve: (value: unknown) => number; }; connectionsAvailable?: boolean; interactionBlocked?: boolean; }|undefined = {}, nextLocale: string|undefined = locale) { Object.assign(props, patch); locale = nextLocale; cursor = 0; effects = [];
    const tree = Component(props as unknown as Parameters<typeof Component>[0]); for (const effect of effects) effect(); return tree; },
    unmount() { for (const hook of hooks) hook.cleanup?.(); },
    strictReplay() {for (const [index, callback] of effectCallbacks) {hooks[index].cleanup?.(); hooks[index].cleanup = callback();}},
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

test('blocked Web portal rejects stale navigation, close and DOM save/input events without hiding or clearing its owners', async () => {
  const h = webHarness(), rejected: unknown[] = [];
  h.render({request: {page: 'agent'}}); await new Promise(setImmediate); const before = h.render();
  const forms = nodes(before).find(node => node.type === 'SettingsConnectionForms')!, body = find(before, 'web-settings-body');
  const owner = h.registry.register('home:agent'); owner.update({dirty: true, busy: false, blocked: false, version: 1});
  const retained = h.registry.capture(), version = forms.props.entryVersion, closes = h.changes.length;
  let blocked = h.render({interactionBlocked: true, request: {page: 'custom', resolve: value => rejected.push(value)}});
  forms.props.onSelect('custom'); forms.props.onPage('about'); assert.equal(await forms.props.beforeClose(), false);
  find(before, 'settings-center-close').props.onClick(); let cancelled = 0;
  before.props.onOpenChange(false, {cancel() {cancelled++;}});
  assert.equal(cancelled, 1); assert.equal(find(blocked, 'settings-center-close').props.disabled, true);
  assert.equal(find(blocked, 'web-settings-body').props.inert, true); assert.ok(find(blocked, 'web-settings-identity-blocked'));
  let saves = 0, edits = 0;
  for (const [handler, action] of [['onClickCapture', () => saves++], ['onSubmitCapture', () => saves++], ['onInputCapture', () => {edits++; h.password.value = 'changed';}], ['onChangeCapture', () => edits++], ['onKeyDownCapture', () => edits++], ['onPointerDownCapture', () => edits++]] as const) {
    let prevented = false, stopped = false; const capture = body.props[handler]; assert.equal(typeof capture, 'function');
    if (typeof capture !== 'function') assert.fail(handler);
    capture({preventDefault() {prevented = true;}, stopPropagation() {stopped = true;}});
    if (!stopped) action(); assert.equal(prevented, true); assert.equal(stopped, true);
  }
  await new Promise(setImmediate); blocked = h.render();
  assert.equal(saves, 0); assert.equal(edits, 0); assert.deepEqual(rejected, [false]);
  assert.equal(h.controllers[0].opened, true); assert.equal(h.controllers[0].page, 'agent'); assert.equal(h.changes.length, closes);
  const kept = nodes(blocked).find(node => node.type === 'SettingsConnectionForms')!;
  assert.equal(kept.props.visible, true); assert.equal(kept.props.connectionsAvailable, true); assert.equal(kept.props.entryVersion, version);
  assert.equal(find(blocked, 'retained-web-key'), h.input); assert.equal(h.password.value, 'SYNTHETIC_RETAINED_WEB_KEY'); assert.deepEqual(h.registry.capture(), retained);
  owner.update({dirty: true, busy: false, blocked: true, version: 2}); const unknown = h.registry.capture();
  h.render({interactionBlocked: false}); await new Promise(setImmediate); const recovered = h.render();
  assert.equal(find(recovered, 'web-settings-body').props.inert, false); assert.equal(h.controllers[0].page, 'agent', 'Rejected request is not automatically replayed');
  assert.deepEqual(rejected, [false]); assert.deepEqual(h.registry.capture(), unknown); assert.equal(find(recovered, 'retained-web-key'), h.input);
  h.unmount();
});

test('identity blocking revokes already-pending Web navigation or close confirmation before it can discard or advance an entry', async () => {
  for (const action of ['request', 'close']) {
    const answer = Promise.withResolvers<boolean>(), h = webHarness(() => answer.promise), rejected: unknown[] = [];
    h.render({request: {page: 'agent'}}); await new Promise(setImmediate); const before = h.render();
    const owner = h.registry.register('home:agent'); owner.update({dirty: true, busy: false, blocked: false, version: 1});
    const retained = h.registry.capture(), version = nodes(before).find(node => node.type === 'SettingsConnectionForms')!.props.entryVersion;
    if (action === 'request') h.render({request: {page: 'custom', resolve: value => rejected.push(value)}});
    else find(before, 'settings-center-close').props.onClick();
    h.render({interactionBlocked: true}); answer.resolve(true); await new Promise(setImmediate); const after = h.render();
    assert.equal(h.controllers[0].opened, true); assert.equal(h.controllers[0].page, 'agent'); assert.deepEqual(h.registry.capture(), retained);
    assert.equal(nodes(after).find(node => node.type === 'SettingsConnectionForms')!.props.entryVersion, version);
    if (action === 'request') assert.deepEqual(rejected, [false]);
    assert.equal(find(after, 'retained-web-key'), h.input); assert.equal(h.password.value, 'SYNTHETIC_RETAINED_WEB_KEY'); h.unmount();
  }
});

test('Web settings keeps the same input through ordinary identity errors and cannot unblock a sticky scope or instance replacement', async () => {
  for (const replacement of [{appLibraryScope: 'b'.repeat(64)}, {instanceId: '92000000-0000-4000-8000-000000000902'}]) {
    const initial = {version: 1, appLibraryScope: 'a'.repeat(64), instanceId: '92000000-0000-4000-8000-000000000901', registered: []};
    let value: unknown = initial;
    const identity = createProjectEntryIdentityOwner({read: async () => {if (value instanceof Error) throw value; return value;}}); identity.activate(); await identity.discover();
    const h = webHarness(); h.render({request: {page: 'agent'}}); await new Promise(setImmediate); const before = h.render();
    value = Error('ordinary read failure'); await identity.refresh(); const failed = h.render({interactionBlocked: identity.getState().identityBlocked});
    assert.equal(find(failed, 'web-settings-body').props.inert, false); assert.equal(find(failed, 'retained-web-key'), h.input);
    value = initial; await identity.refresh(); const recovered = h.render({interactionBlocked: identity.getState().identityBlocked});
    assert.equal(find(recovered, 'retained-web-key'), h.input); assert.equal(h.password.value, 'SYNTHETIC_RETAINED_WEB_KEY');
    value = {...initial, ...replacement}; await identity.refresh(); h.render({interactionBlocked: identity.getState().identityBlocked});
    value = initial; await identity.refresh(); const blocked = h.render({interactionBlocked: identity.getState().identityBlocked});
    assert.equal(find(blocked, 'web-settings-body').props.inert, true); assert.equal(find(blocked, 'retained-web-key'), find(before, 'retained-web-key'));
    assert.equal(identity.getVerifiedScope(), null); assert.equal(h.password.value, 'SYNTHETIC_RETAINED_WEB_KEY'); h.unmount(); identity.dispose();
  }
});

test('Web opening request has one accepted entry across StrictMode effect replay and a blocked initial request is never replayed', async () => {
  const accepted: unknown[] = [], h = webHarness();
  h.render({request: {page: 'agent', resolve: value => accepted.push(value)}}); h.strictReplay(); await new Promise(setImmediate); const tree = h.render();
  assert.deepEqual(accepted, [true]); assert.equal(nodes(tree).find(node => node.type === 'SettingsConnectionForms')!.props.entryVersion, 1); h.unmount();
  const rejected: unknown[] = [], blocked = webHarness(); blocked.render({interactionBlocked: true, request: {page: 'custom', resolve: value => rejected.push(value)}});
  blocked.strictReplay(); await new Promise(setImmediate); assert.deepEqual(rejected, [false]);
  blocked.render({interactionBlocked: false}); await new Promise(setImmediate); assert.equal(blocked.render().props.open, false);
  assert.deepEqual(rejected, [false]); blocked.unmount();
});

test('accepted Web same-slot requests advance only the entry version while cancelled requests and locale changes retain the exact input', async () => {
  let allow = false;
  const h = webHarness(async () => allow), forms = (tree: RootNode) => nodes(tree).find(node => node.type === 'SettingsConnectionForms')!;
  h.render({request: {page: 'official'}}); await new Promise(setImmediate); let tree = h.render();
  const first = forms(tree).props.entryVersion as number, owner = h.registry.register('home:generation-services');
  owner.update({dirty: true, busy: false, blocked: false, version: 1}); const retained = h.registry.capture();
  assert.equal(first, 1); assert.equal(find(tree, 'retained-web-key'), h.input); assert.equal(h.password.value, 'SYNTHETIC_RETAINED_WEB_KEY');
  h.render({request: {page: 'official'}}); await new Promise(setImmediate); tree = h.render();
  assert.equal(forms(tree).props.entryVersion, first + 1); assert.equal(forms(tree).props.page, 'official'); assert.deepEqual(h.registry.capture(), retained);
  for (const locale of LOCALES) {tree = h.render({}, locale); assert.equal(forms(tree).props.entryVersion, first + 1); assert.equal(find(tree, 'retained-web-key'), h.input);}
  find(tree, 'settings-center-close').props.onClick(); await new Promise(setImmediate); tree = h.render();
  assert.equal(tree.props.open, true); assert.equal(forms(tree).props.entryVersion, first + 1);
  h.render({request: {page: 'custom'}}); await new Promise(setImmediate); tree = h.render();
  assert.equal(forms(tree).props.page, 'official'); assert.equal(forms(tree).props.entryVersion, first + 1);
  allow = true; assert.equal(await h.controllers[0].selectPage('custom'), true); tree = h.render();
  assert.equal(forms(tree).props.page, 'custom'); assert.equal(forms(tree).props.entryVersion, first + 1, 'Later manual navigation cannot accept the earlier cancelled entry');
  assert.equal(find(tree, 'retained-web-key'), h.input); assert.equal(h.password.value, 'SYNTHETIC_RETAINED_WEB_KEY'); assert.deepEqual(h.registry.capture(), retained);
  h.unmount();
});

test('a superseded Web same-page acknowledgement cannot advance a newer rejected request', async () => {
  const answer = Promise.withResolvers<boolean>(), h = webHarness(() => answer.promise);
  h.render({request: {page: 'official'}}); await new Promise(setImmediate); let tree = h.render();
  const forms = () => nodes(tree).find(node => node.type === 'SettingsConnectionForms')!, before = forms().props.entryVersion;
  const owner = h.registry.register('home:generation-services'); owner.update({dirty: true, busy: false, blocked: false, version: 1});
  h.render({request: {page: 'official'}});
  h.render({request: {page: 'custom'}}); await new Promise(setImmediate); tree = h.render();
  assert.equal(forms().props.entryVersion, before); answer.resolve(false); await new Promise(setImmediate); tree = h.render();
  assert.equal(forms().props.entryVersion, before); assert.equal(forms().props.page, 'official'); assert.equal(find(tree, 'retained-web-key'), h.input);
  h.unmount();
});

test('web close button, dismissal and form Back all use the same exact dirty guard without clearing owners', async () => {
  for (const [page, slot] of [['agent', 'home:agent'], ['models', 'home:generation-services']]) for (const close of ['button', 'dismiss', 'back']) {
    const answer = Promise.withResolvers(), h = webHarness(() => answer.promise);
    h.render({ request: { page } }); const tree = h.render();
    const owner = h.registry.register(slot); owner.update({ dirty: true, busy: false, blocked: false, version: 1 });
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

test('unavailable connection requests normalize to General and cannot activate model pages through stale form callbacks', async () => {
  const h = webHarness(), results: unknown[] = [];
  h.render({ request: { page: 'custom', resolve: value => results.push(value) }, connectionsAvailable: false });
  await new Promise(setImmediate); const tree = h.render(), forms = nodes(tree).find((node) => node.type === 'SettingsConnectionForms');
  assert.deepEqual(results, [true]); assert.equal(tree.props.open, true); assert.equal((forms)!.props.page, 'general');
  assert.equal((forms)!.props.connectionsAvailable, false); assert.equal((forms)!.props.registry, h.registry);
  (forms)!.props.onSelect('custom'); (forms)!.props.onPage('comfy');
  assert.equal(h.controllers[0].page, 'general'); assert.deepEqual((h.registry.capture() as unknown), []);
  const app = source('App.tsx'); assert.doesNotMatch(app, /connectionsAvailable=\{!restored\}/u);
  h.unmount();
});

test('web center stays first keyed sibling across home and workbench rather than replacing the editor tree', () => {
  const app = source('App.tsx');
  assert.match(app, /const webSettingsCenter = nativeWindow \? null : <WebSettingsCenter key="global-settings-center" request=\{webSettingsRequest\} registry=\{settingsNavigation\.current\}/u);
  assert.match(app, /if \(!workbenchReady && !retainWorkbenchForClip && !retainWorkbenchForIdentity && !nativeLeaseRevoked\.current\) return <>\{webSettingsCenter\}\{historyLayer\}<ProjectHome/u);
  assert.match(app, /return <ProjectMediaProvider media=\{projectMedia\}>\{webSettingsCenter\}[\s\S]*?<main inert=\{retainWorkbenchForIdentity \|\| undefined\} className=\{`workbench/u);
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
  const calls: unknown[] = [], env = { nativeMenuBridge: null as object | null, viewRef: { current: { activeMode: 'editing' } }, document: modalDocument([settings, confirmation]),
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
  env.nativeMenuBridge = {}; assert.equal(press('b'), false); assert.equal(press('z'), false);
  assert.deepEqual(calls, ['split', 'undo', 'split', 'undo', 'split', 'undo'], 'Desktop menu accelerators retain a single owner');
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
  const code = source('ImageGeneration.tsx'), button = code.indexOf('data-testid="image-settings-open"');
  const start = code.indexOf('onClick={', button) + 'onClick={'.length, end = code.indexOf('})}><Icon name="settings"', start) + 2;
  assert.ok(button >= 0 && start > button && end > start);
  (env as typeof env&{run:(action:(session:typeof env.session.current)=>unknown)=>unknown}).run = (action: (arg0: { setVisible(value: unknown): void; load: () => never; generate: () => never; send: () => never; }) => unknown) => action(env.session.current);
  const click = Function('env', `with (env) { return (${stripSourceTypes(code.slice(start, end)).replace(/;\s*$/u, '')}); }`)(env);
  return { env, current, visibility, requests, click, get reads() { return reads; } };
}

for (const kind of ['image']) {
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
