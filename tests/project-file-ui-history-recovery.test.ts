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
import type {ProjectVersionListResponse} from '../packages/contracts/src/project-version-operations.ts';
import type {ProjectHistoryRecoveryClient} from '../apps/web/src/project-history-recovery-client.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(root, 'tests/fixtures/project-file-ui');
const projectId = '10000000-0000-4000-8000-000000000001';
const status: ProjectHistoryStatus = {projectId, state: 'diverged', reason: 'content-token-different',
  file: {contentSequence: 4, contentToken: 'a'.repeat(32)}, seen: {contentSequence: 4, contentToken: 'b'.repeat(32)},
  historyIdentity: {dev: '1', ino: '2', size: '3', mtimeNs: '4'}, versionCount: 2, recoverableVersionCount: 1,
  unknownProviderTasks: 1, confirmationDigest: 'c'.repeat(64)};
const versions: ProjectVersionListResponse = {projectId, versions: [{id: '20000000-0000-4000-8000-000000000001', projectId,
  trigger: 'manual', name: 'Saved version', mioRunId: null, contentSequence: 3, createdAt: '2026-11-20T00:00:00.000Z'}], nextCursor: null};
async function renderer() {
  const entry = `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
    import {ProjectHistoryRecoveryDialog} from ${JSON.stringify(join(root, 'apps/web/src/project-file/ProjectHistoryRecoveryDialog.tsx'))};
    import {setLocale} from ${JSON.stringify(join(fixtures, 'ssr-i18n.tsx'))};
    export function render(status,versions,locale){setLocale(locale);
      const client={status:async()=>status,versions:async()=>versions,preview:async()=>{throw new Error('not needed')},resolve:async()=>{throw new Error('not needed')}};
      return renderToStaticMarkup(<ProjectHistoryRecoveryDialog projectId=${JSON.stringify(projectId)} projectName="Copied project"
        onClose={()=>{}} onResolved={()=>{}} client={client} initialStatus={status} initialVersions={versions} />);}`;
  const result = await build({stdin: {contents: entry, loader: 'tsx', resolveDir: join(root, 'apps/web')}, bundle: true, platform: 'node', format: 'cjs', write: false,
    jsx: 'automatic', loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}, nodePaths: [join(root, 'apps/web/node_modules')],
    plugins: [{name: 'history-recovery-ssr', setup(build) {
      build.onResolve({filter: /^@mioon\/ui\/components\/(?:dialog|dropdown-menu)$/}, () => ({path: join(fixtures, 'ssr-overlays.tsx')}));
      build.onResolve({filter: /\/i18n\/I18nProvider\.tsx$/}, () => ({path: join(fixtures, 'ssr-i18n.tsx')}));
    }}]});
  const module = {exports: {}};
  Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return (module.exports as {render(status: ProjectHistoryStatus, versions: ProjectVersionListResponse, locale: Locale): string}).render;
}
const render = await renderer();
const text = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => escapeHtml(translate('zh-Hans', key, ...args));

test('history recovery dialog exposes the disposal entry instead of an empty error', () => {
  const html = render(status, versions, 'zh-Hans');
  assert.ok(tagOf(html, 'pf-history-recovery'), 'the dialog must render for a diverged project');
  assert.ok(html.includes(text('projectFile.historyRecovery.title', {name: 'Copied project'})));
  assert.ok(html.includes(text('projectFile.historyRecovery.body')));
  assert.ok(html.includes(text('projectFile.historyRecovery.reason.content-token-different')));
  assert.ok(tagOf(html, 'pf-history-recovery-continue'), 'continue must be available');
  assert.ok(tagOf(html, 'pf-history-recovery-restore'), 'restore must be available');
  assert.ok(tagOf(html, 'pf-history-recovery-close'), 'close must be available');
  assert.ok(html.includes(text('projectFile.historyRecovery.unknownTasks', {count: 1})));
  assert.ok(html.includes(text('projectFile.historyRecovery.archive')));
  assert.match(tagOf(html, 'pf-history-recovery-continue')!, /<(button|div)[^>]*>/u);
});

test('history recovery dialog renders in all four languages without losing the entry', () => {
  for (const locale of LOCALES) {
    const html = render(status, versions, locale);
    assert.ok(tagOf(html, 'pf-history-recovery'), locale);
    assert.ok(tagOf(html, 'pf-history-recovery-continue'), locale);
    assert.ok(html.length > 500, locale);
  }
});
