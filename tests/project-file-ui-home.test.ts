import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';
import type { MessageArguments, MessageKey } from '../packages/i18n/src/index.ts';
import { assertGroupEvidence, escapeHtml, projectFileScenes, tagOf } from './helpers/project-file-ui.ts';

// U1 group 1: home (12-01), new project (12-02) and the open failures (12-03 to 12-03d).
const ui = await projectFileScenes();
const html = (id: string) => ui.render(id, 'zh-Hans');
const text = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => escapeHtml(translate('zh-Hans', key, ...args));
const count = (value: string, pattern: RegExp) => (value.match(pattern) ?? []).length;
const disabled = (tag: string | null) => tag !== null && /\sdisabled=""/u.test(tag);
const title = (id: string) => /data-slot="dialog-title">([^<]*)</u.exec(html(id))?.[1];

test('every home scene renders in all four languages', () => {
  const scenes = ui.list.filter(scene => scene.group === 'home');
  assert.ok(scenes.length >= 20);
  for (const scene of scenes) for (const locale of LOCALES) assert.ok(ui.render(scene.id, locale).length > 200, `${scene.id}/${locale}`);
});

test('12-01 recent projects: cards, the missing card and the inbox notice', () => {
  const page = html('12-01');
  assert.equal(count(page, /data-availability="/gu), 6);
  const missing = page.slice(page.indexOf('data-availability="missing"'));
  assert.match(missing, /data-testid="pf-card-locate-[^"]+"[^>]*>定位…</u);
  assert.match(missing, new RegExp(`class="pf-card-meta" data-tone="danger"><span>${text('projectFile.home.missing')}</span><span>${text('projectFile.home.lastSeen', { place: '/Volumes/外接硬盘' })}</span>`, 'u'));
  assert.equal(count(page, /data-testid="pf-card-locate-/gu), 1);
  assert.equal(count(page, /class="pf-card-tag"/gu), 1);
  assert.match(page, /data-testid="pf-inbox"/u);
  assert.ok(page.includes(text('projectFile.home.inboxMissing', { count: 2, name: '访谈剪辑样片' })));
  assert.match(page, /data-testid="pf-inbox-locate-/u);
  assert.match(page, /~\/Movies\/Mioon\/UI 走查项目<\/span><span>今天 14:32<\/span>/u);
  assert.match(page, /<span class="pf-card-duration">00:42<\/span>/u);
  assert.doesNotMatch(html('12-01-inbox-none'), /data-testid="pf-inbox"/u);
});

test('12-01 locked, read-only and invalid cards say so; read-only is not called damaged', () => {
  const list = html('12-01-list');
  assert.match(list, /data-layout="list"/u);
  for (const state of ['locked', 'invalid', 'missing']) assert.match(list, new RegExp(`data-availability="${state}"`, 'u'));
  assert.ok(list.includes(text('projectFile.home.locked')));
  assert.ok(list.includes(text('projectFile.home.readOnly')));
  assert.equal(count(list, new RegExp(text('projectFile.home.invalid'), 'gu')), 1);
});

test('12-01 empty, loading and error states', () => {
  const empty = html('12-01-empty');
  assert.match(empty, /data-testid="pf-home-empty"/u);
  assert.match(empty, /data-testid="pf-home-create"/u);
  assert.match(empty, /data-testid="pf-home-open-file"/u);
  assert.doesNotMatch(empty, /data-availability=/u);
  const loading = html('12-01-loading');
  assert.match(loading, /role="status"[^>]*data-testid="pf-home-loading"|data-testid="pf-home-loading"[^>]*role="status"/u);
  assert.doesNotMatch(loading, /data-availability=/u);
  const error = html('12-01-error');
  assert.match(error, /role="alert"/u);
  assert.match(error, /data-testid="pf-home-retry"/u);
  assert.doesNotMatch(error, /data-availability=/u);
});

test('12-02 new project: name checks, path preview, creating, exists and web', () => {
  assert.equal(disabled(tagOf(html('12-02'), 'pf-create-submit')), false);
  assert.equal(disabled(tagOf(html('12-02-empty-name'), 'pf-create-submit')), true);
  const invalid = html('12-02-invalid-name');
  assert.equal(disabled(tagOf(invalid, 'pf-create-submit')), true);
  assert.ok(invalid.includes(text('projectFile.create.nameInvalid')));
  assert.ok(html('12-02').includes(text('projectFile.create.willCreateInFolder', { path: '~/Movies/Mioon/未命名项目/未命名项目.mioon' })));
  const flat = html('12-02-no-folder');
  assert.ok(flat.includes(text('projectFile.create.willCreate', { path: '~/Movies/Mioon/未命名项目.mioon' })));
  assert.doesNotMatch(flat, /未命名项目\/未命名项目\.mioon/u);
  const creating = html('12-02-creating');
  assert.match(tagOf(creating, 'pf-create-name') ?? '', /readOnly=""/u);
  assert.match(tagOf(creating, 'pf-create-description') ?? '', /readOnly=""/u);
  assert.equal(disabled(tagOf(creating, 'pf-create-cancel')), true);
  assert.match(tagOf(creating, 'pf-create-submit') ?? '', /aria-busy="true"/u);
  assert.ok(html('12-02-exists').includes(text('projectFile.create.exists')));
  assert.match(html('12-02'), /data-testid="pf-create-choose"/u);
  assert.doesNotMatch(html('12-02-web'), /data-testid="pf-create-choose"/u);
  assert.match(html('12-02'), /data-testid="pf-create-preset-portrait_1080" data-selected="true"|data-selected="true" data-testid="pf-create-preset-portrait_1080"/u);
});

test('12-03 the four open failures have distinct titles and the right buttons', () => {
  const titles = ['12-03', '12-03b', '12-03c', '12-03d'].map(title);
  assert.deepEqual(titles, ['找不到「访谈剪辑样片」', '「城市夜景短片」已在另一个 Mioon 中打开', text('projectFile.open.newer.title'), '无法打开「季节变换延时.mioon」']);
  const inbox = text('projectFile.open.missing.inbox', { count: 2 });
  assert.ok(html('12-03').includes(inbox));
  assert.ok(!html('12-03-no-inbox').includes(text('projectFile.open.missing.inbox', { count: 0 })));
  assert.doesNotMatch(html('12-03-no-inbox'), /data-testid="pf-open-inbox"/u);
  for (const id of ['pf-open-remove', 'pf-open-locate']) assert.ok(tagOf(html('12-03'), id), id);
  const locating = html('12-03-locating');
  assert.match(tagOf(locating, 'pf-open-locate') ?? '', /aria-busy="true"/u);
  assert.equal(disabled(tagOf(locating, 'pf-open-remove')), true);
  assert.ok(html('12-03-error').includes(text('projectFile.open.failed.locate')));
  assert.match(html('12-03-error'), /role="alert"/u);
  assert.ok(tagOf(html('12-03c'), 'pf-open-update'));
  assert.equal(tagOf(html('12-03c-history'), 'pf-open-update'), null);
  assert.ok(html('12-03c').includes(text('projectFile.open.newer.body', { format: 2, supported: 1 })));
  assert.ok(html('12-03c-history').includes(text('projectFile.open.newerRecords.body', { format: 2, supported: 1 })));
  assert.ok(!html('12-03c-history').includes(text('projectFile.open.newer.body', { format: 2, supported: 1 })));
  assert.match(tagOf(html('12-03d-restoring'), 'pf-open-restore') ?? '', /aria-busy="true"/u);
});

test('12-03d read-only keeps the layout and never calls the file damaged', () => {
  const readOnly = html('12-03d-read-only');
  assert.equal(title('12-03d-read-only'), '无法打开「产品演示 · 竖屏.mioon」');
  assert.ok(readOnly.includes(text('projectFile.open.readOnly.body')));
  assert.ok(!readOnly.includes(text('projectFile.open.invalid.body')));
  assert.ok(!readOnly.includes(text('projectFile.open.invalid.restore')));
  assert.equal(tagOf(readOnly, 'pf-open-restore'), null);
  assert.match(readOnly, /data-testid="pf-open-reveal"[^>]*>在 Finder 中显示</u);
  assert.ok(html('12-03d').includes(text('projectFile.open.invalid.body')));
});

test('home screenshots match the scene table', async () => {
  await assertGroupEvidence('home');
});
