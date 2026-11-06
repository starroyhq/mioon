import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';
import type { Locale, MessageArguments, MessageKey } from '../packages/i18n/src/index.ts';
import { assertGroupEvidence, escapeHtml, projectFileScenes, tagOf } from './helpers/project-file-ui.ts';
import {createProjectHistoryClient,ProjectHistoryError} from '../apps/web/src/project-history-client.ts';
import type {ProjectHistoryClient} from '../apps/web/src/project-history-client.ts';
import {createProjectHistoryRuntime} from '../apps/web/src/project-history-runtime.ts';
import type {ProjectHistoryRuntime} from '../apps/web/src/project-history-runtime.ts';
import type {ProjectHistoryDialogProps} from '../apps/web/src/project-file/ProjectHistoryDialog.tsx';
import type {RestoreVersionDialogProps} from '../apps/web/src/project-file/RestoreVersionDialog.tsx';
import {PROJECT_VERSION_DIFFERENCE_REASON_CODES} from '../packages/contracts/src/project-version-operations.ts';
import {NOW,RESTORE_PREVIEW,VERSIONS} from './fixtures/project-file-ui/fixtures.ts';

// U1 group 3: project menu (12-07), version history (12-08), restore (12-09) and packing (12-10, 12-11).
const ui = await projectFileScenes();
const html = (id: string) => ui.render(id, 'zh-Hans');
const text = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => escapeHtml(translate('zh-Hans', key, ...args));
const count = (value: string, pattern: RegExp) => (value.match(pattern) ?? []).length;
const disabled = (tag: string | null) => tag !== null && /\sdisabled=""/u.test(tag);
const busy = (tag: string | null) => tag !== null && /aria-busy="true"/u.test(tag);
const shortcuts = (markup: string) => [...markup.matchAll(/data-slot="dropdown-menu-shortcut"[^>]*>([^<]*)</gu)].map(match => match[1]);

/** Render the production container against actual controller snapshots. Only
 * portals, locale and the singleton lookup are adapted for server rendering. */
async function historyContainer() {
  const root=fileURLToPath(new URL('../',import.meta.url)),fixtures=join(root,'tests/fixtures/project-file-ui');
  const entry=`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
    import {ProjectHistoryDialog,NativeBackupFailure} from ${JSON.stringify(join(root,'apps/web/src/project-file/ProjectHistoryDialog.tsx'))};
    import {RestoreVersionDialog,historyErrorCode} from ${JSON.stringify(join(root,'apps/web/src/project-file/RestoreVersionDialog.tsx'))};
    import {setLocale} from ${JSON.stringify(join(fixtures,'ssr-i18n.tsx'))};import {setRuntime} from 'u2-ssr-runtime';
    export function render(runtime,props,locale){setRuntime(runtime);setLocale(locale);return renderToStaticMarkup(<ProjectHistoryDialog {...props}/>);}
    export function restore(props,locale){setLocale(locale);return renderToStaticMarkup(<RestoreVersionDialog {...props}/>);}
    export function nativeFailure(error,locale,action='choose'){setLocale(locale);return renderToStaticMarkup(<NativeBackupFailure code={historyErrorCode(error)} action={action}/>);}`;
  const result=await build({stdin:{contents:entry,loader:'tsx',resolveDir:join(root,'apps/web')},bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',
    loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},nodePaths:[join(root,'apps/web/node_modules')],plugins:[{name:'history-container-ssr',setup(build){
      build.onResolve({filter:/^@mioon\/ui\/components\/(?:dialog|dropdown-menu)$/},()=>({path:join(fixtures,'ssr-overlays.tsx')}));
      build.onResolve({filter:/\/i18n\/I18nProvider\.tsx$/},()=>({path:join(fixtures,'ssr-i18n.tsx')}));
      build.onResolve({filter:/(?:^u2-ssr-runtime$|\/project-history-runtime\.ts$)/},()=>({path:'runtime',namespace:'history-ssr'}));
      build.onLoad({filter:/.*/,namespace:'history-ssr'},()=>({contents:'let runtime;export function setRuntime(next){runtime=next;}export function projectHistoryRuntime(){return runtime;}',loader:'js'}));
    }}]});
  const module={exports:{}};Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  return module.exports as {render(runtime:ProjectHistoryRuntime,props:ProjectHistoryDialogProps,locale:Locale):string;restore(props:RestoreVersionDialogProps,locale:Locale):string;nativeFailure(error:unknown,locale:Locale,action?:'choose'|'reveal'):string};
}
const productionHistory=await historyContainer();
const historyProjectId=RESTORE_PREVIEW.projectId,historyVersion=VERSIONS[0];
function historyClient(patch:Partial<ProjectHistoryClient>={}):ProjectHistoryClient {
  return {...createProjectHistoryClient(async()=>assert.fail('Unexpected network in controlled SSR')),
    list:async()=>({projectId:historyProjectId,versions:[historyVersion.summary],nextCursor:null}),preview:async()=>RESTORE_PREVIEW,...patch};
}
const historyProps:ProjectHistoryDialogProps={open:true,projectId:historyProjectId,projectName:'SSR history',onClose:()=>{},onRestored:()=>{},onOpenProject:()=>{}};
async function settleHistory(){for(let turn=0;turn<25;turn++)await Promise.resolve();}

test('annotation identity copy preserves the row and clears only its label and note in every locale',()=>{
  const expected={'zh-Hans':'保留标注这一行，只把标签和备注恢复为空。','zh-Hant':'保留標註這一列，只把標籤和備註還原為空。',en:'Keep the annotation row and restore only its label and note to empty.',ja:'注釈の行は保持し、ラベルとメモだけを空に戻します。'};
  for(const locale of LOCALES)assert.equal(translate(locale,'projectHistory.reason.annotationIdentity'),expected[locale]);
});

test('bad-source backup subtitle describes backups instead of version history',async()=>{
  const runtime=createProjectHistoryRuntime(historyProjectId,historyClient({backups:async()=>({projectId:historyProjectId,backups:[]}),status:async()=>({projectId:historyProjectId,state:'idle',lastAttemptAt:null,lastCompletedAt:null,lastError:null})}),undefined,undefined,{backupsOnly:true});
  runtime.open();await settleHistory();
  try{for(const locale of LOCALES){
    const markup=productionHistory.render(runtime,{...historyProps,backupsOnly:true},locale);
    assert.equal(markup.includes(escapeHtml(translate(locale,'projectFile.versions.subtitle',{name:historyProps.projectName}))),false);
    assert.ok(markup.includes(historyProps.projectName));
  }}finally{runtime.close();}
});

test('completed restore reasons match only the original preview table/key and leave the persisted ACK shape untouched',async()=>{
  const known={...RESTORE_PREVIEW.changes[2]!,action:'keep-current' as const,reasonCode:'PROJECT_VERSION_FOREIGN_KEY_REFERENCE_CURRENT'};
  const {reasonCode:_code,...receiptKnown}=known,missing={...receiptKnown,key:'not-in-preview',reason:'Legacy reason without a code'};let raw='';
  const client=historyClient({preview:async input=>({...RESTORE_PREVIEW,version:{...RESTORE_PREVIEW.version,id:input.versionId},previewDigest:input.versionId===historyVersion.summary.id?RESTORE_PREVIEW.previewDigest:'f'.repeat(64),totalChanges:2,keptCurrentCount:2,changes:[known],nextCursor:'unread-preview-page'}),restore:async input=>{
    const result={projectId:input.projectId,requestId:input.requestId,versionId:input.versionId,beforeVersionId:randomUUID(),contentSequence:RESTORE_PREVIEW.contentSequence+1,contentToken:'c'.repeat(32),totalChanges:2,appliedChanges:[],keptCurrent:[receiptKnown,missing]};raw=JSON.stringify(result);return result;
  }});
  const runtime=createProjectHistoryRuntime(historyProjectId,client);runtime.open();await settleHistory();await runtime.select(historyVersion.summary.id);await runtime.restoreVersion();await settleHistory();
  try{
    for(const locale of LOCALES){
      const markup=productionHistory.render(runtime,historyProps,locale),kept=markup.match(/data-testid="pf-restore-kept-result"[^>]*>([\s\S]*?)<\/ul>/u)?.[1]??'';
      assert.ok(kept.includes(escapeHtml(translate(locale,'projectHistory.reason.foreignKey'))));
      assert.ok(kept.includes(escapeHtml(translate(locale,'projectHistory.reason.unknown'))));
      assert.ok(kept.includes('PROJECT_VERSION_REASON_UNAVAILABLE'),'a row absent from the loaded preview stays generic');
    }
    const attempt=runtime.snapshot().attempt;assert.equal(attempt?.kind,'version');assert.equal(JSON.stringify(attempt?.result),raw,'display metadata never modifies the restore ACK');
    await runtime.select(randomUUID());
    const changed=productionHistory.render(runtime,historyProps,'zh-Hans').match(/data-testid="pf-restore-kept-result"[^>]*>([\s\S]*?)<\/ul>/u)?.[1]??'';
    assert.ok(changed.includes(escapeHtml(translate('zh-Hans','projectHistory.reason.unknown'))));
    assert.equal(changed.includes(escapeHtml(translate('zh-Hans','projectHistory.reason.foreignKey'))),false,'another preview digest cannot relabel the original result');
  }finally{runtime.close();}
});

test('every versions and packing scene renders in all four languages', () => {
  const scenes = ui.list.filter(scene => scene.group === 'versions-pack');
  assert.ok(scenes.length >= 30);
  for (const scene of scenes) for (const locale of LOCALES) assert.ok(ui.render(scene.id, locale).length > 200, `${scene.id}/${locale}`);
});

test('12-07 menu: items, separators and shortcuts differ between Mac and Windows; the web shows none', () => {
  const mac = html('12-07');
  for (const id of ['newProject', 'open', 'recent', 'saveVersion', 'versionHistory', 'saveAs', 'pack', 'reveal', 'rules', 'exportStoryboard', 'view']) assert.match(mac, new RegExp(`data-testid="pf-menu-${id}"`, 'u'), id);
  assert.equal(count(mac, /data-slot="dropdown-menu-separator"/gu), 3);
  assert.deepEqual(shortcuts(mac), ['⌘N', '⌘O', '⌥⌘S', '⇧⌘S']);
  assert.match(mac, /data-testid="pf-menu-reveal"[\s\S]*?在 Finder 中显示/u);
  const windows = html('12-07-windows');
  assert.deepEqual(shortcuts(windows), ['Ctrl+N', 'Ctrl+O', 'Ctrl+Alt+S', 'Ctrl+Shift+S']);
  assert.match(windows, /data-testid="pf-menu-reveal"[\s\S]*?在资源管理器中显示/u);
  const web = html('12-07-web');
  assert.deepEqual(shortcuts(web), []);
  assert.doesNotMatch(web, /data-testid="pf-menu-(?:reveal|saveAs)"/u);
  assert.match(tagOf(html('12-07-disabled'), 'pf-menu-saveVersion') ?? '', /aria-disabled="true"/u);
  assert.doesNotMatch(tagOf(html('12-07-disabled'), 'pf-menu-open') ?? '', /aria-disabled/u);
  assert.doesNotMatch(mac, /data-testid="pf-menu-recent-list"/u);
});

test('12-07 recent projects submenu: ready, loading, empty and error', () => {
  assert.equal(count(html('12-07-recent'), /data-testid="pf-menu-recent-[0-9a-f-]{36}"/gu), 5);
  assert.match(html('12-07-recent-loading'), /data-testid="pf-menu-recent-list"[^>]*>[\s\S]*?role="status"/u);
  assert.ok(html('12-07-recent-empty').includes(text('projectFile.menu.recentEmpty')));
  const error = html('12-07-recent-error');
  assert.match(error, /role="alert"/u);
  assert.ok(tagOf(error, 'pf-menu-recent-retry'));
});

test('12-08 version history: days, titles, the manual tag, the comparison and the buttons', () => {
  const page = html('12-08');
  const rows = [...page.matchAll(/data-testid="pf-version-([^"]+)" data-trigger="([^"]+)"/gu)].map(match => match[2]);
  assert.deepEqual(rows, ['current', 'mio-turn', 'manual', 'mio-turn', 'daily-open', 'manual', 'mio-turn']);
  assert.match(page, /<h3>今天<\/h3>[\s\S]*<h3>昨天<\/h3>/u);
  for (const title of ['Mio 第 3 轮之前', '定稿前', '今天第一次打开', '初剪完成', 'Mio 第 1 轮之前']) assert.ok(page.includes(title), title);
  // Only manual versions carry the tag.
  assert.equal(count(page, /data-testid="pf-version-manual"/gu), 2);
  for (const match of page.matchAll(/data-trigger="([^"]+)"[\s\S]*?<\/button>/gu)) assert.equal(match[0].includes('pf-version-manual'), match[1] === 'manual', match[1]);
  assert.match(page, /aria-current="true"[^>]*data-testid="pf-version-e0c0ffee-0000-4000-8000-000000000001"|data-testid="pf-version-e0c0ffee-0000-4000-8000-000000000001"[^>]*aria-current="true"|aria-current="true"[^>]*data-selected="true"[^>]*data-testid="pf-version-e0c0ffee-0000-4000-8000-000000000001"/u);
  assert.ok(page.includes(text('projectFile.versions.conversation', { title: '把雨夜段落剪紧一点' })));
  assert.ok(page.includes(`${text('projectFile.versions.diff.clipsTrimmed', { count: 5 })}，${text('projectFile.versions.diff.clipsRemoved', { count: 1 })}`));
  assert.ok(page.includes(text('projectFile.versions.retention', { recent: 20, days: 7 })));
  assert.equal(disabled(tagOf(page, 'pf-version-restore')), false);
  assert.equal(disabled(tagOf(page, 'pf-version-compare')), false);
  assert.ok(tagOf(page, 'pf-versions-save'));
});

test('12-08 restoring and comparing are off while "current" is selected', () => {
  for (const id of ['12-08-current', '12-08-empty']) {
    const page = html(id);
    assert.equal(disabled(tagOf(page, 'pf-version-restore')), true, id);
    assert.equal(disabled(tagOf(page, 'pf-version-compare')), true, id);
    assert.ok(page.includes(text('projectFile.versions.currentHint')), id);
  }
  assert.ok(html('12-08-empty').includes(text('projectFile.versions.emptyTitle')));
});

test('12-08 other triggers, earlier days and the list and detail states', () => {
  const older = html('12-08-older');
  for (const key of ['projectFile.versions.beforeRestore', 'projectFile.versions.beforeBulkChange', 'projectFile.versions.dailyOpen', 'projectFile.versions.manualUnnamed', 'projectFile.versions.mioTurnUnknown'] as const) assert.ok(older.includes(text(key)), key);
  assert.match(older, /<h3>10月14日<\/h3>[\s\S]*<h3>10月12日<\/h3>[\s\S]*<h3>2025年12月30日<\/h3>/u);
  assert.equal(count(older, /data-testid="pf-version-manual"/gu), 1);
  assert.ok(older.includes(text('projectFile.versions.noDifference')));
  assert.match(tagOf(html('12-08-loading'), 'pf-versions-loading') ?? '', /role="status"/u);
  const error = html('12-08-error');
  assert.match(tagOf(error, 'pf-versions-error') ?? '', /role="alert"/u);
  assert.ok(tagOf(error, 'pf-versions-retry'));
  assert.match(tagOf(html('12-08-detail-loading'), 'pf-version-comparing') ?? '', /role="status"/u);
  const detailError = html('12-08-detail-error');
  assert.match(tagOf(detailError, 'pf-version-compare-error') ?? '', /role="alert"/u);
  assert.ok(tagOf(detailError, 'pf-version-compare-retry'));
});

test('12-09 restore: actual totals, attribution, retained reasons, pagination and the states', () => {
  const page = html('12-09');
  assert.ok(page.includes(text('projectFile.versions.restore.title', { name: 'Mio 第 3 轮之前' })));
  assert.ok(page.includes(text('projectHistory.plan', {count: 3, kept: 1})));
  assert.ok(page.includes('timeline-1'));
  assert.ok(page.includes(text('projectHistory.fields', {fields: '片段，字幕'})));
  assert.ok(page.includes(text('projectHistory.source.other')));
  assert.ok(page.includes(text('projectHistory.source.mio')));
  assert.ok(page.includes(text('projectHistory.action.keep-current')));
  assert.ok(page.includes('保留的结果仍引用此素材'));
  assert.ok(page.includes(text('projectHistory.undo')));
  assert.equal(page.includes('你改过时长'), false);
  assert.equal(page.includes('210 帧 → 180 帧'), false);
  assert.equal(tagOf(page, 'pf-restore-superseded'), null);
  assert.equal(tagOf(page, 'pf-restore-more'), null);
  const more = html('12-09-more');
  assert.ok(more.includes(text('projectHistory.plan', {count: 7, kept: 1})));
  assert.ok(tagOf(more, 'pf-restore-more'));
  assert.ok(more.includes('node-4'));
  const empty = html('12-09-empty');
  assert.ok(empty.includes(text('projectHistory.plan', {count: 0, kept: 0})));
  assert.equal(tagOf(empty, 'pf-restore-changes'), null);
  assert.equal(tagOf(empty, 'pf-restore-superseded'), null);
  assert.equal(disabled(tagOf(empty, 'pf-restore-confirm')), false);
  const loading = html('12-09-loading');
  assert.match(tagOf(loading, 'pf-restore-loading') ?? '', /role="status"/u);
  assert.equal(disabled(tagOf(loading, 'pf-restore-confirm')), true);
  const error = html('12-09-error');
  assert.match(tagOf(error, 'pf-restore-error') ?? '', /role="alert"/u);
  assert.ok(tagOf(error, 'pf-restore-retry'));
  assert.equal(disabled(tagOf(error, 'pf-restore-confirm')), true);
  const restoring = html('12-09-restoring');
  assert.equal(busy(tagOf(restoring, 'pf-restore-confirm')), true);
  assert.equal(disabled(tagOf(restoring, 'pf-restore-cancel')), true);
  assert.ok(html('12-09-restore-error').includes(text('projectHistory.error.busy')));
  assert.ok(html('12-09-restore-error').includes('PROJECT_HOST_BUSY'));
});

test('12-10 packing: the manifest, the missing warning only when media are missing, and the states', () => {
  const page = html('12-10');
  assert.match(tagOf(page, 'pf-pack-destination') ?? '', /value="~\/Desktop\/UI 走查项目（打包）"/u);
  assert.ok(page.includes(text('projectFile.pack.fileDetail', { file: 'UI 走查项目.mioon', size: '2.1 MB' })));
  assert.ok(page.includes(text('projectFile.pack.assets', { count: 21 })));
  assert.ok(page.includes(text('projectFile.pack.assetsOutside', { size: '4.1 GB', count: 6 })));
  assert.ok(tagOf(page, 'pf-pack-rules'));
  assert.ok(page.includes(text('projectFile.pack.missing', { count: 2 })));
  assert.ok(tagOf(page, 'pf-pack-relink'));
  assert.ok(page.includes(text('projectFile.pack.excludes')));
  assert.equal(disabled(tagOf(page, 'pf-pack-submit')), false);
  const empty = html('12-10-empty');
  assert.ok(empty.includes(text('projectFile.pack.noAssets')));
  assert.equal(tagOf(empty, 'pf-pack-missing'), null);
  assert.equal(tagOf(empty, 'pf-pack-rules'), null);
  const loading = html('12-10-loading');
  assert.match(tagOf(loading, 'pf-pack-loading') ?? '', /role="status"/u);
  assert.equal(disabled(tagOf(loading, 'pf-pack-submit')), true);
  const readError = html('12-10-read-error');
  assert.match(tagOf(readError, 'pf-pack-read-error') ?? '', /role="alert"/u);
  assert.ok(tagOf(readError, 'pf-pack-retry'));
  const packing = html('12-10-packing');
  assert.match(packing, /role="progressbar"[^>]*aria-valuenow="42"/u);
  assert.equal(busy(tagOf(packing, 'pf-pack-submit')), true);
  assert.equal(disabled(tagOf(packing, 'pf-pack-cancel')), true);
  assert.ok(html('12-10-error').includes(text('projectFile.pack.failed')));
});

test('12-11 packing finished: what was copied, and the missing media only when some are missing', () => {
  const page = html('12-11');
  assert.ok(page.includes(text('projectFile.pack.copiedWithRules', { file: 'AGENTS.md', count: 21, size: '4.1 GB' })));
  assert.ok(page.includes('~/Desktop/UI 走查项目（打包）/'));
  assert.equal(count(page, new RegExp(text('projectFile.pack.missingItem'), 'gu')), 2);
  assert.ok(page.includes(text('projectFile.pack.missingNote', { count: 2 })));
  assert.match(page, /data-testid="pf-pack-reveal"[^>]*>在 Finder 中显示</u);
  const all = html('12-11-all-copied');
  assert.equal(tagOf(all, 'pf-pack-missing-list'), null);
  assert.equal(tagOf(all, 'pf-pack-missing-note'), null);
});

test('versions and packing screenshots match the scene table', async () => {
  await assertGroupEvidence('versions-pack');
});

test('pending edits preserve real version reads and preview while save and both restore confirmations stay unavailable',async()=>{
  const runtime=createProjectHistoryRuntime(historyProjectId,historyClient());runtime.open();await settleHistory();await runtime.select(historyVersion.summary.id);
  try{
    const normal=productionHistory.render(runtime,historyProps,'zh-Hans');assert.ok(tagOf(normal,'pf-versions-save'));assert.equal(disabled(tagOf(normal,'pf-version-restore')),false);
    for(const locale of LOCALES){
      const markup=productionHistory.render(runtime,{...historyProps,pendingEdits:true},locale);
      assert.ok(tagOf(markup,`pf-version-${historyVersion.summary.id}`));assert.equal(disabled(tagOf(markup,`pf-version-${historyVersion.summary.id}`)),false,'history selection remains readable');
      assert.ok(tagOf(markup,'pf-version-runtime-diff'));assert.ok(markup.includes('timeline-1'));assert.equal(tagOf(markup,'pf-versions-save'),null);assert.equal(disabled(tagOf(markup,'pf-version-restore')),true);
      assert.match(tagOf(markup,'pf-history-pending-edits')??'',/data-tone="warning"/u);assert.ok(markup.includes(escapeHtml(translate(locale,'projectHistory.pendingEdits'))));
      const confirmation=productionHistory.restore({open:true,version:historyVersion,now:NOW,preview:{kind:'ready',value:RESTORE_PREVIEW},restore:{kind:'idle'},pendingEdits:true,onRestore:()=>assert.fail('SSR cannot mutate'),onRetry:()=>{},onClose:()=>{}},locale);
      assert.equal(disabled(tagOf(confirmation,'pf-restore-confirm')),true);assert.ok(confirmation.includes(escapeHtml(translate(locale,'projectHistory.pendingEdits'))));assert.ok(confirmation.includes('timeline-1'));
    }
    assert.equal(runtime.snapshot().attempt,null,'viewing under the dirty guard never starts a write');
  }finally{runtime.close();}
});

test('pending edits block an unknown original restore retry and preserve its exact input until edits are resolved',async()=>{
  const sent:unknown[]=[];let unknown=true;
  const runtime=createProjectHistoryRuntime(historyProjectId,historyClient({restore:async input=>{sent.push(structuredClone(input));if(unknown)throw new ProjectHistoryError('BACKEND_UNAVAILABLE');return{projectId:input.projectId,requestId:input.requestId,versionId:input.versionId,beforeVersionId:randomUUID(),contentSequence:RESTORE_PREVIEW.contentSequence+1,contentToken:'c'.repeat(32),totalChanges:0,appliedChanges:[],keptCurrent:[]};}}));
  runtime.open();await settleHistory();await runtime.select(historyVersion.summary.id);await runtime.restoreVersion();
  try{
    const original=structuredClone(runtime.snapshot().attempt);assert.equal(original?.phase,'unknown');assert.equal(original?.kind,'version');
    for(const locale of LOCALES){
      const markup=productionHistory.render(runtime,{...historyProps,pendingEdits:true},locale);
      assert.ok(tagOf(markup,'pf-history-retry-original'));assert.equal(disabled(tagOf(markup,'pf-history-retry-original')),true);assert.ok(markup.includes(escapeHtml(translate(locale,'projectHistory.retryOriginal'))));
      const confirmation=productionHistory.restore({open:true,version:historyVersion,now:NOW,preview:{kind:'ready',value:RESTORE_PREVIEW},restore:{kind:'error',action:'restore'},pendingEdits:true,unknown:true,onRestore:()=>{},onRetry:()=>{},onClose:()=>{}},locale);
      assert.equal(disabled(tagOf(confirmation,'pf-restore-confirm')),true);assert.ok(tagOf(confirmation,'pf-restore-unknown'));assert.ok(confirmation.includes(escapeHtml(translate(locale,'projectHistory.pendingEdits'))));
    }
    assert.deepEqual(runtime.snapshot().attempt,original,'rendering and pending edits preserve the request, pair and digest');assert.equal(sent.length,1);
    const ready=productionHistory.render(runtime,{...historyProps,pendingEdits:false},'en');assert.equal(disabled(tagOf(ready,'pf-history-retry-original')),false);
    const confirmation=productionHistory.restore({open:true,version:historyVersion,now:NOW,preview:{kind:'ready',value:RESTORE_PREVIEW},restore:{kind:'error',action:'restore'},pendingEdits:false,unknown:true,onRestore:()=>{},onRetry:()=>{},onClose:()=>{}},'en');assert.equal(disabled(tagOf(confirmation,'pf-restore-confirm')),false);
    unknown=false;await runtime.retry();assert.deepEqual(sent[1],original?.input);assert.deepEqual(sent[0],sent[1]);assert.equal(sent.length,2);assert.equal(runtime.snapshot().attempt?.phase,'complete');
  }finally{runtime.close();}
});

test('backup completion puts the four-language preserved-originals success notice below the real result path',async()=>{
  const backupId=randomUUID(),newProjectId=randomUUID(),projectFile='/projects/recovered.mioon',backup={projectId:historyProjectId,backupId,contentSequence:1,contentToken:'a'.repeat(32),createdAt:NOW.toISOString(),reason:'close' as const,sizeBytes:4096};
  const runtime=createProjectHistoryRuntime(historyProjectId,historyClient({backups:async()=>({projectId:historyProjectId,backups:[backup]}),status:async()=>({projectId:historyProjectId,state:'idle',lastAttemptAt:null,lastCompletedAt:null,lastError:null}),inspect:async()=>({...backup,projectName:'SSR history',sourceProjectDir:'/projects/original',tableCounts:{projects:1}}),
    restoreBackup:async input=>({requestId:input.requestId,sourceProjectId:input.projectId,backupId:input.backupId,project:{projectId:newProjectId,projectFile:input.projectFile,name:'Recovered',fileIdentity:{dev:'1',ino:'2'},summary:null,lastOpenedAt:null}})}));
  runtime.open('backups');await settleHistory();await runtime.inspect(backupId);await runtime.chooseBackup(async input=>({...input,projectFile}));
  try{for(const locale of LOCALES){
    const markup=productionHistory.render(runtime,{...historyProps,pendingEdits:true},locale),notice=tagOf(markup,'pf-backup-originals-preserved');
    assert.match(notice??'',/data-tone="success"/u);assert.ok(markup.includes(escapeHtml(translate(locale,'projectHistory.backup.originalsPreserved'))));
    assert.ok(markup.indexOf(projectFile)<markup.indexOf('data-testid="pf-backup-originals-preserved"'));assert.ok(markup.includes(projectFile));
    assert.equal(markup.includes(escapeHtml(translate(locale,'projectHistory.pendingEdits'))),false,'restoring a separate project is not blocked by current edits');
  }}finally{runtime.close();}
});


test('failed-source mode exposes only automatic backups and refuses every project-level runtime path',async()=>{
  const projectCalls:string[]=[],applicationCalls:string[]=[],backupId=randomUUID(),backup={projectId:historyProjectId,backupId,contentSequence:1,contentToken:'a'.repeat(32),createdAt:NOW.toISOString(),reason:'open' as const,sizeBytes:4096};
  const unexpected=(name:string)=>{projectCalls.push(name);assert.fail(`Failed-source backup viewer called project RPC ${name}`);};
  const runtime=createProjectHistoryRuntime(historyProjectId,historyClient({list:async()=>unexpected('list'),preview:async()=>unexpected('preview'),save:async()=>unexpected('save'),restore:async()=>unexpected('restore'),
    backups:async()=>{applicationCalls.push('backups');return{projectId:historyProjectId,backups:[backup]};},status:async()=>{applicationCalls.push('status');return{projectId:historyProjectId,state:'idle',lastAttemptAt:null,lastCompletedAt:null,lastError:null};},
    inspect:async()=>{applicationCalls.push('inspect');return{...backup,projectName:'Bad source',sourceProjectDir:'/projects/damaged',tableCounts:{projects:1}};}}),undefined,undefined,{backupsOnly:true});
  runtime.open('versions');await settleHistory();
  try{
    runtime.tab('versions');await runtime.loadVersions();await runtime.select(historyVersion.summary.id);await runtime.save('Must not open source');await runtime.restoreVersion();await runtime.retry();
    assert.equal(runtime.snapshot().tab,'backups');assert.deepEqual(projectCalls,[]);assert.deepEqual(applicationCalls,['backups','status']);
    await runtime.inspect(backupId);assert.deepEqual(applicationCalls,['backups','status','inspect']);
    for(const locale of LOCALES){
      const markup=productionHistory.render(runtime,{...historyProps,backupsOnly:true,initialTab:'versions',initialAction:'save'},locale);
      assert.ok(markup.includes(escapeHtml(translate(locale,'projectHistory.tabs.backups'))));assert.ok(tagOf(markup,'pf-backups'));
      assert.equal(tagOf(markup,'pf-versions-save'),null);assert.equal(tagOf(markup,'pf-version-restore'),null);assert.equal(tagOf(markup,'pf-restore-dialog'),null);
      assert.doesNotMatch(markup,/id="pf-save-name"/u);assert.doesNotMatch(markup,/role="tab"[^>]*value="versions"/u);
      const heading=[...markup.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gu)].map(match=>match[1]).find(title=>title.includes(escapeHtml(translate(locale,'projectHistory.backup.open'))));
      assert.ok(heading,`inspection title contains the reason in ${locale}`);assert.match(heading,/\d{2}:\d{2}/u,'inspection title includes the actual backup time');
    }
    assert.deepEqual(projectCalls,[]);assert.equal(runtime.snapshot().attempt,null);
  }finally{runtime.close();}
});

test('kept reasons and backup failures use four-language codes and never render server text',async()=>{
  const reasons={PROJECT_VERSION_ASSET_LOCATION_CURRENT:'assetLocation',PROJECT_VERSION_IMAGE_GROUP_FORWARD_ONLY:'imageGroup',PROJECT_VERSION_SUBJECT_VARIANT_HEAD:'subjectVariant',PROJECT_VERSION_IMAGE_GROUP_TASK_NOT_REPLAYED:'imageTask',PROJECT_VERSION_PROTECTED_RESULT_CURRENT:'protectedResult',PROJECT_VERSION_TIMELINE_HISTORY_CURRENT:'timelineHistory',PROJECT_VERSION_ANNOTATION_IDENTITY_CURRENT:'annotationIdentity',PROJECT_VERSION_BINDING_TOMBSTONE_CURRENT:'bindingTombstone',PROJECT_VERSION_PROCESS_REFERENCE_CURRENT:'processReference',PROJECT_VERSION_FOREIGN_KEY_REFERENCE_CURRENT:'foreignKey',PROJECT_VERSION_CONTENT_REFERENCE_CURRENT:'contentReference'} as const;
  assert.deepEqual(Object.keys(reasons),[...PROJECT_VERSION_DIFFERENCE_REASON_CODES]);
  const secret='服务端私密说明 /private/source 不应进入界面';
  for(const locale of LOCALES){
    for(const [reasonCode,key]of Object.entries(reasons)){
      const preview={...RESTORE_PREVIEW,changes:[{...RESTORE_PREVIEW.changes[2]!,reason:secret,reasonCode}]};
      const markup=productionHistory.restore({open:true,version:historyVersion,now:NOW,preview:{kind:'ready',value:preview},restore:{kind:'idle'},onRestore:()=>{},onRetry:()=>{},onClose:()=>{}},locale);
      assert.ok(markup.includes(escapeHtml(translate(locale,`projectHistory.reason.${key}`))));assert.equal(markup.includes(secret),false);
    }
    for(const reasonCode of [undefined,'PROJECT_VERSION_FUTURE_REASON','PROJECT_VERSION_'+'A'.repeat(96)]){
      const preview={...RESTORE_PREVIEW,changes:[{...RESTORE_PREVIEW.changes[2]!,reason:secret,reasonCode}]};
      const markup=productionHistory.restore({open:true,version:historyVersion,now:NOW,preview:{kind:'ready',value:preview},restore:{kind:'idle'},onRestore:()=>{},onRetry:()=>{},onClose:()=>{}},locale);
      assert.ok(markup.includes(escapeHtml(translate(locale,'projectHistory.reason.unknown'))));assert.ok(markup.includes(reasonCode??'PROJECT_VERSION_REASON_UNAVAILABLE'));assert.equal(markup.includes(secret),false);
    }
    for(const [code,key]of [['PROJECT_ACCESS_DENIED','permission'],['ENOSPC','space'],['PROJECT_BACKUP_INTERRUPTED','interrupted'],['PROJECT_BACKUP_FUTURE','other']] as const){
      const runtime=createProjectHistoryRuntime(historyProjectId,historyClient({backups:async()=>({projectId:historyProjectId,backups:[]}),status:async()=>({projectId:historyProjectId,state:'failed',lastAttemptAt:NOW.toISOString(),lastCompletedAt:null,lastError:{code,message:secret}})}));
      runtime.open('backups');await settleHistory();try{
        const markup=productionHistory.render(runtime,{...historyProps,initialTab:'backups'},locale);
        assert.ok(markup.includes(escapeHtml(translate(locale,`projectHistory.backup.failure.${key}`))));assert.ok(markup.includes(code));assert.equal(markup.includes(secret),false);
      }finally{runtime.close();}
    }
  }
});


test('native backup selection and reveal failures distinguish access, changed backup, location and generic errors in four languages',()=>{
  const cases=[['PROJECT_ACCESS_DENIED','permission'],['PROJECT_BACKUP_CHANGED','backupChanged'],['PROJECT_BACKUP_RESTORE_CHANGED','backupChanged'],['PROJECT_BACKUP_RESTORE_BUSY','busy'],['PROJECT_BACKUP_NOT_FOUND','missing'],['PROJECT_BACKUP_INDEX_INVALID','backupChanged'],['PROJECT_LOCATION_REJECTED','location'],['PROJECT_LOCATION_INVALID','location'],['WORKSPACE_NATIVE_UNAVAILABLE','nativeUnavailable']] as const;
  for(const locale of LOCALES){
    for(const [code,key]of cases){
      const markup=productionHistory.nativeFailure(Object.assign(new Error('Sensitive server message /private/source'),{code}),locale);
      assert.ok(tagOf(markup,'pf-backup-native-error'));assert.ok(markup.includes(escapeHtml(translate(locale,`projectHistory.error.${key}`))));assert.ok(markup.includes(code));assert.doesNotMatch(markup,/Sensitive server message|private\/source/u);
    }
    for(const error of [new Error('Sensitive chooser failure'),{code:'/private/invalid-code'}]){
      const markup=productionHistory.nativeFailure(error,locale);assert.ok(markup.includes('WORKSPACE_NATIVE_UNAVAILABLE'));assert.ok(markup.includes(escapeHtml(translate(locale,'projectHistory.error.nativeUnavailable'))));assert.doesNotMatch(markup,/Sensitive chooser failure|invalid-code/u);
    }
  }
});

test('Finder busy explains how to reveal the recovered project while restore and choose keep their own action guidance',()=>{
  const expected={'zh-Hans':'恢复出的项目已打开或正被占用。请先关闭它或释放占用，再在 Finder 中显示。','zh-Hant':'還原後的專案已開啟或正被占用。請先關閉它或解除占用，再在 Finder 中顯示。',en:'The recovered project is open or in use. Close it or release the lock, then show it in Finder.',ja:'復元したプロジェクトが開いているか使用中です。閉じるかロックを解除してから、Finder に表示してください。'};
  for(const locale of LOCALES){
    const busy={code:'PROJECT_BACKUP_RESTORE_BUSY'},reveal=productionHistory.nativeFailure(busy,locale,'reveal');
    assert.equal(reveal.includes(escapeHtml(translate(locale,'projectHistory.error.busy'))),false,'Finder failure must not tell the user to restore again');
    assert.ok(reveal.includes(escapeHtml(expected[locale])));assert.ok(reveal.includes(busy.code));
    const choose=productionHistory.nativeFailure(busy,locale,'choose');
    assert.ok(choose.includes(escapeHtml(translate(locale,'projectHistory.error.busy'))));assert.equal(choose.includes(escapeHtml(expected[locale])),false);
    assert.ok(productionHistory.nativeFailure({code:'PROJECT_ACCESS_DENIED'},locale,'reveal').includes(escapeHtml(translate(locale,'projectHistory.error.permission'))));
  }
});


test('an unknown manual-save retry also waits for current edits without changing its exact request',async()=>{
  const sent:unknown[]=[];let fail=true;
  const runtime=createProjectHistoryRuntime(historyProjectId,historyClient({save:async input=>{sent.push(structuredClone(input));if(fail)throw new ProjectHistoryError('BACKEND_UNAVAILABLE');return{projectId:input.projectId,requestId:input.requestId,version:historyVersion.summary};}}));
  runtime.open();await settleHistory();await runtime.save('Retained exact name');
  try{
    const original=structuredClone(runtime.snapshot().attempt);assert.equal(original?.kind,'save');assert.equal(original?.phase,'unknown');
    for(const locale of LOCALES){
      const dirty=productionHistory.render(runtime,{...historyProps,pendingEdits:true},locale);assert.equal(disabled(tagOf(dirty,'pf-history-retry-original')),true);assert.ok(dirty.includes(escapeHtml(translate(locale,'projectHistory.pendingEdits'))));
      const clean=productionHistory.render(runtime,{...historyProps,pendingEdits:false},locale);assert.equal(disabled(tagOf(clean,'pf-history-retry-original')),false);
    }
    assert.equal(sent.length,1);assert.deepEqual(runtime.snapshot().attempt,original);fail=false;await runtime.retry();assert.equal(sent.length,2);assert.deepEqual(sent[1],original?.input);assert.deepEqual(sent[0],sent[1]);assert.equal(runtime.snapshot().attempt?.phase,'complete');
  }finally{runtime.close();}
});
