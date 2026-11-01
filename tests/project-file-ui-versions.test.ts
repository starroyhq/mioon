import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';
import type { MessageArguments, MessageKey } from '../packages/i18n/src/index.ts';
import { assertGroupEvidence, escapeHtml, projectFileScenes, tagOf } from './helpers/project-file-ui.ts';

// U1 group 3: project menu (12-07), version history (12-08), restore (12-09) and packing (12-10, 12-11).
const ui = await projectFileScenes();
const html = (id: string) => ui.render(id, 'zh-Hans');
const text = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => escapeHtml(translate('zh-Hans', key, ...args));
const count = (value: string, pattern: RegExp) => (value.match(pattern) ?? []).length;
const disabled = (tag: string | null) => tag !== null && /\sdisabled=""/u.test(tag);
const busy = (tag: string | null) => tag !== null && /aria-busy="true"/u.test(tag);
const shortcuts = (markup: string) => [...markup.matchAll(/data-slot="dropdown-menu-shortcut"[^>]*>([^<]*)</gu)].map(match => match[1]);

test('every versions and packing scene renders in all four languages', () => {
  const scenes = ui.list.filter(scene => scene.group === 'versions-pack');
  assert.ok(scenes.length >= 30);
  for (const scene of scenes) for (const locale of LOCALES) assert.ok(ui.render(scene.id, locale).length > 200, `${scene.id}/${locale}`);
});

test('12-07 menu: items, separators and shortcuts differ between Mac and Windows; the web shows none', () => {
  const mac = html('12-07');
  for (const id of ['newProject', 'open', 'recent', 'saveVersion', 'versionHistory', 'saveAs', 'pack', 'reveal', 'rules', 'exportStoryboard', 'view']) assert.match(mac, new RegExp(`data-testid="pf-menu-${id}"`, 'u'), id);
  assert.equal(count(mac, /data-slot="dropdown-menu-separator"/gu), 3);
  assert.deepEqual(shortcuts(mac), ['⌘N', '⌘O', '⌥⌘S', '⇧⌘S', '⇧⌘E']);
  assert.match(mac, /data-testid="pf-menu-reveal"[\s\S]*?在 Finder 中显示/u);
  const windows = html('12-07-windows');
  assert.deepEqual(shortcuts(windows), ['Ctrl+N', 'Ctrl+O', 'Ctrl+Alt+S', 'Ctrl+Shift+S', 'Ctrl+Shift+E']);
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

test('12-09 restore: what is undone, "N more", Mio\'s superseded changes and the states', () => {
  const page = html('12-09');
  assert.ok(page.includes(text('projectFile.versions.restore.title', { name: 'Mio 第 3 轮之前' })));
  assert.ok(page.includes(text('projectFile.versions.restore.body', { count: 2 })));
  assert.ok(page.includes('片段 scene-b.mp4'));
  assert.ok(page.includes('你改过时长：210 帧 → 180 帧'));
  assert.ok(page.includes('字幕「镜头缓慢推进」'));
  assert.ok(page.includes(text('projectFile.versions.restore.changedField', { property: '字幕文字' })));
  assert.ok(page.includes(text('projectFile.versions.restore.supersededTurn')));
  assert.equal(tagOf(page, 'pf-restore-more'), null);
  const more = html('12-09-more');
  assert.ok(more.includes(text('projectFile.versions.restore.more', { count: 4 })));
  assert.ok(more.includes(text('projectFile.versions.restore.changedFields', { count: 2 })));
  assert.ok(more.includes('镜头 雨夜街道'));
  const empty = html('12-09-empty');
  assert.ok(empty.includes(text('projectFile.versions.restore.bodyNoManual')));
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
  assert.ok(html('12-09-restore-error').includes(text('projectFile.versions.restore.failed')));
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
