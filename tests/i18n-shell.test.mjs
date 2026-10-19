import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shellMessages } from '../packages/i18n/src/catalogs/shell.ts';
import { LOCALES, validateCatalogs, translate, message, renderMessage } from '../packages/i18n/src/index.ts';
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
      const rendered = translate(locale, key, params);
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
    assert.equal(referenceTargetOptions([shot], projectId, locale)[0].shot, shot);
    const shown = canvasEdge(edge, true, locale); assert.equal(shown.id, edge.id); assert.equal(shown.source, edge.source); assert.equal(shown.target, edge.target);
    assert.equal(shown.label, translate(locale, 'assets.reference.firstFrame'));
    const issue = referenceAttachIssueDescriptor({ source: node, shot, assets: [asset], edges: [edge], projectId });
    assert.ok(renderMessage(locale, issue));
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
  assert.match(settingsCenter, /t\('settings\.languageHint'\).*<LanguageControl \/>/u);
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
  assert.match(app, /data-testid="export-button" disabled=\{Boolean\(application\) \|\| !data\.shots\.length \|\| selectedCount !== data\.shots\.length \|\| busy\.export\}/u);
  const settingsCss = readFileSync(new URL('../apps/web/src/project-home.css', import.meta.url), 'utf8');
  assert.match(settingsCss, /\.project-home-settings-window > \.project-home-settings \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/u);
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.dock-workbench\.dock-narrow \.topbar > \.language-control \{[^}]*grid-row: 1;[^}]*grid-column: 3 \/ span 2;/u);
});

test('known workspace/storage diagnostics retain actionable meaning without exposing raw server text', () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function readableError(error'), app.indexOf('function Modal('));
  const readableError = Function('msg', `${stripSourceTypes(source,{loader:'tsx'})}; return readableError;`)(message);
  const cases = {
    STORAGE_MIGRATION_BLOCKED: 'shell.error.storageMigration', WORKSPACE_ORIGIN_UNVERIFIED: 'tasks.unverifiedWorkspace',
    RESTORED_RECORD_HELD: 'tasks.heldReason', RESTORE_WORKSPACE_ORIGIN_MISMATCH: 'shell.error.workspaceChanged',
    WORKSPACE_INTENT_ALREADY_PINNED: 'shell.error.workspacePinned', RESTORE_OPERATION_UNAVAILABLE: 'recovery.restored.disabledReason',
    RESTORE_BACKUP_UNAVAILABLE: 'recovery.restored.backupReason', LAST_PROJECT_SCOPE_MISMATCH: 'shell.error.lastProjectScope',
  };
  for (const [code, key] of Object.entries(cases)) {
    const error = { code, message: 'Raw provider diagnostic 私有內容' }, before = structuredClone(error), descriptor = readableError(error);
    assert.equal(descriptor.key, key);
    for (const locale of LOCALES) {
      assert.equal(renderMessage(locale, descriptor), translate(locale, key));
      assert.ok(!renderMessage(locale, descriptor).includes(error.message));
    }
    assert.deepEqual(error, before);
  }
  const pending = message('shell.error.workspacePinned');
  assert.equal(readableError({ displayMessage: pending }), pending, 'Existing exact sidecars retain precedence');
  assert.equal(readableError({ code: 'NEW_UNKNOWN', message: 'Secret backend details' }).key, 'shell.error.incomplete');
});
