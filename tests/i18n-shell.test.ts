import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import * as i18nRuntime from '../packages/i18n/src/index.ts';
import * as languagePreference from '../packages/i18n/src/preference.ts';
import { createLanguageStore } from '../apps/web/src/i18n/language-store.ts';
import { shellMessages } from '../packages/i18n/src/catalogs/shell.ts';
import { LOCALES, validateCatalogs, translate, message, renderMessage } from '../packages/i18n/src/index.ts';
import type { DisplayMessage, Locale, MessageKey } from '../packages/i18n/src/index.ts';
const tr = (locale: Locale, key: string, params: Record<string, unknown> = {}): string => translate(locale, key as MessageKey, params as never);
import { referenceSourceDetails, referenceTargetOptions, referenceAttachIssueDescriptor, canvasEdge } from '../apps/web/src/reference-connections.ts';
import { importFeedback, renderImportFeedback } from '../apps/web/src/import-feedback.ts';

import { lenientFunction, stripSourceTypes } from './helpers/eval-source.ts';
const Function = lenientFunction;
test('shell catalog has all four locales, exact placeholders, and no missing-key fallback', () => {
  assert.deepEqual(validateCatalogs(shellMessages), []);
  for (const [key, entry] of Object.entries(shellMessages)) {
    const template = typeof entry['zh-Hans'] === 'string' ? entry['zh-Hans'] : entry['zh-Hans'].other;
    const params = Object.fromEntries([...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(([, name]) => [name, name === 'count' ? 2 : '<literal 用户入力>']));
    for (const locale of LOCALES) {
      const rendered = tr(locale, key, params);
      assert.ok(rendered.length, `${key}/${locale}`);
      assert.doesNotMatch(rendered, /\{[A-Za-z][A-Za-z0-9_]*\}/u, `${key}/${locale}`);
      assert.notEqual(rendered, 'This message cannot be displayed right now');
    }
  }
  assert.equal(translate('en', 'shell.node.versionCount', { count: 1 }), '1 version');
  assert.equal(translate('en', 'shell.node.versionCount', { count: 2 }), '2 versions');
});

test('reference display changes language without changing record identity or full user names', () => {
  const projectId = 'project-a', name = '用户内容 <still literal>', node = { id: 'node-a', projectId, type: 'image', assetId: 'asset-a', label: name };
  const asset = { id: 'asset-a', projectId, mimeType: 'image/png', name: 'ファイル.png' };
  const shot = { id: 'shot-a', projectId, title: name, orderIndex: 0, referenceAssetIds: [] };
  const edge = { id: 'edge-a', kind: 'reference', role: 'first_frame', projectId, source: node.id, sourceAssetId: asset.id, target: shot.id };
  const before = structuredClone({ node, asset, shot, edge });
  const descriptions = new Set();
  for (const locale of LOCALES) {
    const details = referenceSourceDetails({ sourceId: node.id, assetId: asset.id, projectId, nodes: [node], assets: [asset], locale });
    descriptions.add(details.description); assert.equal(details.source, node); assert.equal(details.asset, asset);
    assert.ok(details.description.includes(name)); assert.ok(details.description.includes(asset.name));
    const targetOptions = referenceTargetOptions([shot], projectId, locale); assert.ok(targetOptions[0]); assert.equal(targetOptions[0].shot, shot);
    const shown = canvasEdge(edge, true, locale); assert.equal(shown.id, edge.id); assert.equal(shown.source, edge.source); assert.equal(shown.target, edge.target);
    assert.equal(shown.label, translate(locale, 'assets.reference.firstFrame'));
    const issue = referenceAttachIssueDescriptor({ source: node, shot, assets: [asset], edges: [edge], projectId });
    assert.ok(renderMessage(locale, issue as never));
  }
  assert.equal(descriptions.size, 4); assert.deepEqual({ node, asset, shot, edge }, before);
});

test('stored uncertainty notices re-render without changing filenames, outcomes, or request data', () => {
  const input = [{ name: '原始 <filename>.png' }, { name: 'second.png' }, { name: '未送信.png' }];
  const notice = importFeedback(input, 1, { kind: 'unknown' });
  const before = structuredClone(notice), outputs = new Set();
  for (const locale of LOCALES) {
    const text = renderImportFeedback(locale, notice); outputs.add(text);
    assert.ok(text.includes(input[0].name)); assert.ok(text.includes(input[1].name)); assert.ok(text.includes(input[2].name));
    assert.equal(renderMessage(locale, message('shell.confirm.switchProject')), translate(locale, 'shell.confirm.switchProject'));
  }
  assert.equal(outputs.size, 4); assert.deepEqual(notice, before);
});

test('shell component controllers are not keyed or reconstructed by locale', () => {
  for (const name of ['App.tsx', 'ProjectHome.tsx', 'ProjectEntry.tsx', 'SettingsRoot.tsx', 'Inspector.tsx', 'AssetLibrary.tsx', 'ReferenceConnections.tsx']) {
    const source = readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /key=\{locale\}|key=\{language\}/u, name);
  }
});

test('header actions and native settings remain reachable without locale or resize remount keys', () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const header = app.slice(app.indexOf('<WorkbenchTopbar'), app.indexOf('{showGuide && <section'));
  const shell = readFileSync(new URL('../apps/web/src/WorkbenchShell.tsx', import.meta.url), 'utf8');
  const task = readFileSync(new URL('../apps/web/src/TaskPopover.tsx', import.meta.url), 'utf8');
  const delivery = readFileSync(new URL('../apps/web/src/DeliveryWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(header, /data-testid="global-settings-open"[^>]+onClick=\{\(\) => openGlobalSettings\(\)\}/u);
  assert.doesNotMatch(header, /<LanguageControl \/>/u);
  const settingsCenter = readFileSync(new URL('../apps/web/src/ProjectHomeConnections.tsx', import.meta.url), 'utf8');
  assert.match(settingsCenter, /data-testid="settings-general"/u);
  assert.match(settingsCenter, /t\('settings\.languageHint'\).*<LanguageControl visible=\{active && page === 'general'\} \/>/u);
  const home = readFileSync(new URL('../apps/web/src/ProjectHome.tsx', import.meta.url), 'utf8');
  assert.match(home, /data-testid="project-home-page-settings"/u);
  assert.match(home, /onPage\('settings'\)/u); assert.doesNotMatch(home, /<LanguageControl \/>/u);
  for (const id of ['agent-chat-open', 'agent-settings-open', 'region-guide-toggle', 'jobs-button', 'export-history', 'export-button', 'export-timeline']) assert.ok((app + shell + task + delivery).includes(`data-testid="${id}"`), id);
  assert.match(app, /if \(value === 'agent'\) \{ setRightDockTab\('agent'\); setAgentPage\('chat'\);/);
  assert.match(shell, /data-testid="agent-chat-open"/);
  assert.match(app, /onOpenTasks=\{\(\) => openTasks\(\)\}/);
  assert.match(delivery, /value === 'history'\) onPage\(value\)/);
  assert.match(delivery, /<TabsTrigger[^>]+value="history"[^>]+data-testid="delivery-page-history"/);
  assert.match(app, /setShowExports\(page === 'history'\)/);
  assert.match(app, /data-testid="export-timeline" disabled=\{!canOpenExport\} onClick=\{openTimelineExport\}/u);
  assert.match(app, /data-testid="export-button" disabled=\{!data\.shots\.length \|\| selectedCount !== data\.shots\.length \|\| busy\.export\}/u);
  const settingsCss = readFileSync(new URL('../apps/web/src/project-home.css', import.meta.url), 'utf8');
  assert.match(settingsCss, /\.project-home-settings-window > \.project-home-settings \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/u);
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.dock-workbench\.dock-narrow \.topbar > \.language-control \{[^}]*grid-row: 1;[^}]*grid-column: 3 \/ span 2;/u);
});

test('known workspace/storage diagnostics retain actionable meaning without exposing raw server text', () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function readableError(error'), app.indexOf('function Modal('));
  const readableError = Function('msg', `${stripSourceTypes(source,{loader:'tsx'})}; return readableError;`)(message) as (error: { code?: string; message?: string; displayMessage?: DisplayMessage }) => { key: MessageKey; displayMessage?: DisplayMessage };
  const cases = {
    STORAGE_MIGRATION_BLOCKED: 'shell.error.storageMigration',
    WORKSPACE_INTENT_ALREADY_PINNED: 'shell.error.workspacePinned',
    LAST_PROJECT_SCOPE_MISMATCH: 'shell.error.lastProjectScope',
  };
  for (const [code, key] of Object.entries(cases)) {
    const error = { code, message: 'Raw provider diagnostic 私有內容' }, before = structuredClone(error), descriptor = readableError(error);
    assert.equal(descriptor.key, key);
    for (const locale of LOCALES) {
      assert.equal(renderMessage(locale, descriptor), translate(locale, key as MessageKey));
      assert.ok(!renderMessage(locale, descriptor).includes(error.message));
    }
    assert.deepEqual(error, before);
  }
  const pending = message('shell.error.workspacePinned');
  assert.equal(readableError({ displayMessage: pending }), pending, 'Existing exact sidecars retain precedence');
  assert.equal(readableError({ code: 'NEW_UNKNOWN', message: 'Secret backend details' }).key, 'shell.error.incomplete');
});

interface TitleDocumentFixture {
  title: string;
  documentElement: { lang: string };
  querySelector: (selector: string) => { setAttribute: (name: string, value: string) => void };
}
interface TitleModule {
  claimProjectDocumentTitle?: (document: TitleDocumentFixture, projectName: string) => () => void;
}
let documentTitleAuthority: TitleModule | undefined;
function titleSourceModule<T>(source: string, values: Record<string, unknown>, resolve: (id: string) => unknown = id => { throw new Error(`Unexpected title source import: ${id}`); }): T {
  const module: { exports: unknown } = { exports: {} };
  Function('module', 'exports', 'require', ...Object.keys(values), stripSourceTypes(source, { loader: 'tsx' }))(module, module.exports, resolve, ...Object.values(values));
  return module.exports as T;
}
function createDocumentTitleHarness(systemLanguages: string[]) {
  const writes: string[] = [];
  let title = 'Mioon', description = '';
  const document: TitleDocumentFixture = {
    get title() { return title; }, set title(value) { title = value; writes.push(value); },
    documentElement: { lang: '' },
    querySelector: selector => { assert.equal(selector, 'meta[name="description"]'); return { setAttribute: (name, value) => { assert.equal(name, 'content'); description = value; } }; },
  };
  const authorityFile = new URL('../apps/web/src/document-title.ts', import.meta.url);
  // The old implementation has no authority module; execute its real effects so
  // the regression fails on the observed title, rather than a missing import.
  const authority = documentTitleAuthority ??= existsSync(authorityFile) ? titleSourceModule<TitleModule>(readFileSync(authorityFile, 'utf8'), {}) : {};
  const store = createLanguageStore({ systemLanguages });
  let layoutEffects: (() => void)[] = [];
  // Only the React/DOM host is controlled. Locale state, the whole Provider and
  // App's selected title effect execute the actual production statements.
  const react = {
    createContext: () => ({ Provider: 'provider' }), createElement: () => null,
    useState: (initialize: () => unknown) => [initialize(), () => {}],
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useMemo: (compute: () => unknown) => compute(), useContext: () => { throw new Error('Unexpected context read'); },
    useEffect: () => {}, useLayoutEffect: (effect: () => void) => { layoutEffects.push(effect); },
  };
  const provider = titleSourceModule<{ I18nProvider: (props: { children: null; store: typeof store }) => unknown }>(
    readFileSync(new URL('../apps/web/src/i18n/I18nProvider.tsx', import.meta.url), 'utf8'), { document }, id => {
      if (id === 'react') return react;
      if (id === '../../../../packages/i18n/src/index.ts') return i18nRuntime;
      if (id === '../../../../packages/i18n/src/preference.ts') return languagePreference;
      if (id === './language-store.ts') return { createLanguageStore };
      if (id === '../document-title.ts') return authority;
      throw new Error(`Unexpected provider import: ${id}`);
    });
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) {
      const source = node.arguments[0].getText(ast);
      if (source.includes('data.project.name') && (source.includes('document.title') || source.includes('claimProjectDocumentTitle'))) effects.push(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.equal(effects.length, 1, 'Select the actual App title effect unambiguously');
  const renderProvider = () => { layoutEffects = []; provider.I18nProvider({ children: null, store }); for (const effect of layoutEffects) effect(); };
  const mountProject = (project: { id: string; name: string } | null, options: { native?: boolean; currentProjectId?: string } = {}) => {
    const { effect } = titleSourceModule<{ effect: () => (() => void) | undefined }>(`export const effect = ${effects[0]};`, {
      document, data: { project }, currentProject: { current: options.currentProjectId ?? project?.id ?? null },
      nativeWindow: options.native === false ? null : { context: { contextId: 'project-window' } },
      claimProjectDocumentTitle: authority.claimProjectDocumentTitle,
    });
    return effect();
  };
  renderProvider();
  return { document, writes, store, renderProvider, mountProject, description: () => description };
}

test('project document title survives real language-store changes without transient generic writes and releases to the current locale', async () => {
  const host = createDocumentTitleHarness(['zh-TW']);
  const project = { id: 'project-a', name: 'Q1 基本流程' }, expected = `${project.name} · Mioon`;
  assert.equal(host.document.title, translate('zh-Hant', 'app.title'));
  assert.equal(host.mountProject(project, { native: false }), undefined, 'Web title policy stays unchanged');
  assert.equal(host.mountProject(project, { currentProjectId: 'other-project' }), undefined, 'Only the owned project claims the native title');
  assert.equal(host.mountProject(null), undefined);
  assert.equal(host.document.title, translate('zh-Hant', 'app.title'));
  const release = host.mountProject(project); assert.equal(typeof release, 'function');
  assert.equal(host.document.title, expected);
  const verifyProject = (locale: Locale) => {
    host.renderProvider();
    assert.equal(host.document.title, expected, `Project identity survives ${locale}`);
    assert.deepEqual(host.writes, [], 'A locale update never writes a generic title, even transiently');
    assert.equal(host.document.documentElement.lang, locale);
    assert.equal(host.description(), translate(locale, 'app.description'));
  };
  host.writes.length = 0;
  await host.store.setPreference('en'); verifyProject('en');
  await host.store.setPreference('system'); verifyProject('zh-Hant');
  await host.store.updateSystemLanguages(['ja-JP']); verifyProject('ja');
  release?.();
  assert.equal(host.document.title, translate('ja', 'app.title'), 'Returning home uses the latest fallback, not the locale captured on project mount');
  assert.deepEqual(host.writes, [translate('ja', 'app.title')]);
  assert.equal(host.mountProject(null), undefined);
  await host.store.setPreference('zh-Hans'); host.renderProvider();
  assert.equal(host.document.title, translate('zh-Hans', 'app.title'));
  assert.equal(host.document.documentElement.lang, 'zh-Hans');
  host.store.dispose();
});

test('stale App title cleanup cannot release a newer same-name owner or affect another document', async () => {
  const first = createDocumentTitleHarness(['en-US']);
  const oldRelease = first.mountProject({ id: 'project-old', name: '同名项目' });
  const currentRelease = first.mountProject({ id: 'project-new', name: '同名项目' });
  const expected = '同名项目 · Mioon';
  first.writes.length = 0;
  oldRelease?.(); oldRelease?.();
  assert.equal(first.document.title, expected, 'Owner identity, not matching title text, controls cleanup');
  assert.deepEqual(first.writes, []);
  await first.store.setPreference('ja'); first.renderProvider();
  assert.equal(first.document.title, expected);
  assert.deepEqual(first.writes, []);
  const second = createDocumentTitleHarness(['zh-TW']);
  const secondRelease = second.mountProject({ id: 'project-other', name: '別の窓' });
  second.writes.length = 0;
  currentRelease?.(); currentRelease?.();
  assert.equal(first.document.title, translate('ja', 'app.title'));
  assert.deepEqual(first.writes, [translate('ja', 'app.title')], 'Release is idempotent and does not revive the old project title');
  assert.equal(second.document.title, '別の窓 · Mioon'); assert.deepEqual(second.writes, []);
  secondRelease?.();
  assert.equal(second.document.title, translate('zh-Hant', 'app.title'));
  assert.equal(first.document.title, translate('ja', 'app.title'));
  first.store.dispose(); second.store.dispose();
});
