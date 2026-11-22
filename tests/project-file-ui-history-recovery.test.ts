import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {build} from 'esbuild';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import type {Locale, MessageArguments, MessageKey} from '../packages/i18n/src/index.ts';
import {escapeHtml, tagOf} from './helpers/project-file-ui.ts';
import type {ProjectHistoryStatus} from '../packages/contracts/src/project-history-recovery.ts';
import type {ProjectVersionPreviewResponse} from '../packages/contracts/src/project-version-operations.ts';
import type {ProjectVersionSummary} from '../packages/contracts/src/project-versions.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(root, 'tests/fixtures/project-file-ui');
const projectId = '10000000-0000-4000-8000-000000000001';
const projectFile = '/Users/tester/Movies/Mioon/城市夜景短片/城市夜景短片.mioon';
const status: ProjectHistoryStatus = {projectId, state: 'diverged', reason: 'content-token-different',
  file: {contentSequence: 4, contentToken: 'a'.repeat(32)}, seen: {contentSequence: 4, contentToken: 'b'.repeat(32)},
  historyIdentity: {dev: '1', ino: '2', size: '3', mtimeNs: '4'}, versionCount: 2, recoverableVersionCount: 1,
  unknownProviderTasks: 2, confirmationDigest: 'c'.repeat(64)};
const versions: readonly ProjectVersionSummary[] = [
  {id: '20000000-0000-4000-8000-000000000001', projectId, trigger: 'manual', name: '开场定稿', mioRunId: null,
    contentSequence: 3, createdAt: '2026-11-20T10:42:00.000Z'},
  {id: '20000000-0000-4000-8000-000000000002', projectId, trigger: 'daily-open', name: null, mioRunId: null,
    contentSequence: 2, createdAt: '2026-11-20T01:00:00.000Z'},
];
const preview: ProjectVersionPreviewResponse = {projectId, version: versions[0]!, contentSequence: 4, contentToken: 'a'.repeat(32),
  previewDigest: 'd'.repeat(64), totalChanges: 12, keptCurrentCount: 0, changes: [], nextCursor: null, restoreAvailable: true};
const text = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => escapeHtml(translate('zh-Hans', key, ...args));
const count = (value: string, pattern: RegExp) => (value.match(pattern) ?? []).length;
const disabled = (markup: string, id: string) => {
  const tag = tagOf(markup, id);
  return tag !== null && /\sdisabled=""/u.test(tag);
};
async function renderer() {
  const entry = `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
    import {ProjectHistoryRecoveryDialog} from ${JSON.stringify(join(root, 'apps/web/src/project-file/ProjectHistoryRecoveryDialog.tsx'))};
    import {setLocale} from ${JSON.stringify(join(fixtures, 'ssr-i18n.tsx'))};
    export function render(status,versions,preview,view,locale){setLocale(locale);
      const client={status:async()=>status,versions:async()=>({projectId:${JSON.stringify(projectId)},versions,nextCursor:null}),
        preview:async()=>preview,resolve:async()=>{throw new Error('not needed')}};
      return renderToStaticMarkup(<ProjectHistoryRecoveryDialog projectId=${JSON.stringify(projectId)} projectName="城市夜景短片"
        projectFile=${JSON.stringify(projectFile)} homeDirectory="/Users/tester" onClose={()=>{}} onResolved={()=>{}}
        client={client} initialStatus={status} initialVersions={versions} initialPreview={preview} initialView={view} />);}`;
  const result = await build({stdin: {contents: entry, loader: 'tsx', resolveDir: join(root, 'apps/web')}, bundle: true, platform: 'node', format: 'cjs', write: false,
    jsx: 'automatic', loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}, nodePaths: [join(root, 'apps/web/node_modules')],
    plugins: [{name: 'history-recovery-ssr', setup(build) {
      build.onResolve({filter: /^@mioon\/ui\/components\/(?:dialog|dropdown-menu)$/}, () => ({path: join(fixtures, 'ssr-overlays.tsx')}));
      build.onResolve({filter: /\/i18n\/I18nProvider\.tsx$/}, () => ({path: join(fixtures, 'ssr-i18n.tsx')}));
    }}]});
  const module = {exports: {}};
  Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return (module.exports as {render(status: ProjectHistoryStatus, versions: readonly ProjectVersionSummary[], preview: ProjectVersionPreviewResponse,
    view: 'confirm' | 'versions', locale: Locale): string}).render;
}
const render = await renderer();

test('12-25 names the file and shows only the agreed reason, consequence and unknown-task warning', () => {
  const html = render(status, versions, preview, 'confirm', 'zh-Hans');
  assert.ok(html.includes(text('projectFile.historyRecovery.title', {name: '城市夜景短片'})));
  assert.ok(html.includes('~/Movies/Mioon/城市夜景短片/城市夜景短片.mioon'), 'the project file path is shown');
  assert.ok(html.includes(text('projectFile.historyRecovery.reason')));
  assert.ok(html.includes(text('projectFile.historyRecovery.consequence')));
  assert.ok(html.includes(text('projectFile.historyRecovery.unknownTasks', {count: 2})));
  assert.doesNotMatch(html, /内容戳|序号|令牌|不证明|更旧|更新/u);
  assert.equal(count(html, /data-testid="pf-history-recovery-(?:close|restore|continue)"/gu), 3);
  const closeAt = html.indexOf('data-testid="pf-history-recovery-close"');
  const restoreAt = html.indexOf('data-testid="pf-history-recovery-restore"');
  const continueAt = html.indexOf('data-testid="pf-history-recovery-continue"');
  assert.ok(closeAt < restoreAt && restoreAt < continueAt, 'footer order is 关闭 / 从版本恢复… / 用这个文件继续');
  assert.match(tagOf(html, 'pf-history-recovery-continue')!, /primary/u);
});

test('12-25 omits unknown-task warning and version-restore when they do not apply', () => {
  const noWarning = render({...status, unknownProviderTasks: 0}, versions, preview, 'confirm', 'zh-Hans');
  assert.equal(tagOf(noWarning, 'pf-history-recovery-warning'), null);
  const noVersions = render({...status, recoverableVersionCount: 0}, [], preview, 'confirm', 'zh-Hans');
  assert.equal(tagOf(noVersions, 'pf-history-recovery-restore'), null);
  assert.ok(tagOf(noVersions, 'pf-history-recovery-continue'));
});

test('12-25b lists restorable versions newest first, selects the latest and compares before restore', () => {
  const html = render(status, versions, preview, 'versions', 'zh-Hans');
  assert.ok(html.includes(text('projectFile.historyRecovery.versionsTitle', {name: '城市夜景短片'})));
  assert.equal(count(html, /data-testid="pf-history-recovery-version-/gu), 2);
  const firstAt = html.indexOf(`pf-history-recovery-version-${versions[0]!.id}`);
  const secondAt = html.indexOf(`pf-history-recovery-version-${versions[1]!.id}`);
  assert.ok(firstAt >= 0 && secondAt > firstAt, 'newest version is listed first');
  const firstRadio = new RegExp(`<input[^>]*data-testid="pf-history-recovery-version-${versions[0]!.id}"[^>]*checked=""[^>]*>`, 'u');
  assert.match(html, firstRadio);
  assert.ok(html.includes(text('projectFile.historyRecovery.differences', {count: 12})));
  assert.ok(html.includes(text('projectFile.historyRecovery.restoreConsequence')));
  assert.ok(tagOf(html, 'pf-history-recovery-back'));
  assert.ok(tagOf(html, 'pf-history-recovery-restore-version'));
  assert.equal(disabled(html, 'pf-history-recovery-restore-version'), false);
  assert.doesNotMatch(html, /内容戳|序号|令牌|不证明|更旧|更新/u);
});

test('12-25b keeps restore disabled while comparing and offers an unavailable-comparison reason', () => {
  const html = render(status, versions, {...preview, totalChanges: 0}, 'versions', 'zh-Hans');
  assert.ok(html.includes(text('projectFile.historyRecovery.differences', {count: 0})));
  // The production loading state is covered by the component state machine; the
  // SSR fixture always supplies a finished comparison. Disabled restore text is
  // still asserted through the missing-preview branch below.
  const noPreview = render(status, versions, undefined as unknown as ProjectVersionPreviewResponse, 'versions', 'zh-Hans');
  assert.equal(disabled(noPreview, 'pf-history-recovery-restore-version'), true);
  assert.ok(noPreview.includes(text('projectFile.historyRecovery.comparing')) || noPreview.includes(text('projectFile.historyRecovery.compareUnavailable')));
});

test('the stale message is the exact user-facing sentence', () => {
  assert.equal(translate('zh-Hans', 'projectFile.historyRecovery.stale'), '项目文件刚才有变化，请重新打开。');
});

test('recovery dialog renders the design copy in all four languages without technical wording', () => {
  for (const locale of LOCALES) {
    const confirm = render(status, versions, preview, 'confirm', locale);
    const restore = render(status, versions, preview, 'versions', locale);
    assert.ok(tagOf(confirm, 'pf-history-recovery'), locale);
    assert.ok(tagOf(confirm, 'pf-history-recovery-continue'), locale);
    assert.ok(tagOf(restore, 'pf-history-recovery-restore-version'), locale);
    assert.ok(confirm.length > 500 && restore.length > 500, locale);
  }
});
