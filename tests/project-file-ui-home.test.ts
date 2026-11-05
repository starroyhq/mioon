import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';
import type { MessageArguments, MessageKey } from '../packages/i18n/src/index.ts';
import { assertGroupEvidence, escapeHtml, projectFileScenes, tagOf } from './helpers/project-file-ui.ts';
import { ACCESS_DENIED_PROJECT_ENTRY, HOME, NOW, OPEN_FAILURES, PROJECT_IDS, RECENT_PROJECTS } from './fixtures/project-file-ui/fixtures.ts';
import {aspectLabel, clockTime, displayPath, folderOf, lastSeenLabel} from '../apps/web/src/project-file/format.ts';
import {orderedRecentProjects, visibleWaitingProjects, waitingProjects} from '../apps/web/src/project-file/recent-project-view.ts';
import type {WaitingProject} from '../apps/web/src/project-file/recent-project-view.ts';
import type {ProjectEntry} from '../packages/contracts/src/project-entry.ts';

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

test('12-01 recent projects show unfinished tasks waiting for the missing project', () => {
  const page = html('12-01');
  assert.equal(count(page, /data-availability="/gu), 6);
  const missing = page.slice(page.indexOf('data-availability="missing"'));
  assert.match(missing, /data-testid="pf-card-locate-[^"]+"[^>]*>定位…</u);
  assert.match(missing, new RegExp(`class="pf-card-meta" data-tone="danger"><span>${text('projectFile.home.missing')}</span><span>${text('projectFile.home.lastSeen', { place: '/Volumes/外接硬盘' })}</span>`, 'u'));
  assert.equal(count(page, /data-testid="pf-card-locate-/gu), 1);
  assert.equal(count(page, /class="pf-card-tag"/gu), 1);
  assert.match(page, /data-testid="pf-waiting"/u);
  assert.ok(page.includes(text('projectFile.home.waitingVolume', { count: 2, name: '访谈剪辑样片', volume: '外接硬盘' })));
  assert.match(page, /data-testid="pf-waiting-action-/u);
  assert.ok(page.includes(text('projectFile.home.waitingCard', {count: 2})));
  assert.ok(page.includes(text('projectFile.home.waitingRetention')));
  assert.doesNotMatch(page, /等待写入的生成结果|找到项目后会自动写入/u);
  assert.match(page, /~\/Movies\/Mioon\/UI 走查项目<\/span><span>今天 14:32<\/span>/u);
  assert.match(page, /<span class="pf-card-duration">00:42<\/span>/u);
  assert.doesNotMatch(html('12-01-inbox-none'), /data-testid="pf-waiting"|data-testid="pf-card-waiting-/u);
});

const entries = (): ProjectEntry[] => RECENT_PROJECTS.map(project => ({project, availability: {state: 'available'}, coverUrl: null}));
test('recent directory ordering and search preserve missing summaries, null opened times and stable identities', () => {
  const projects = entries().slice(0, 3).map((entry, index) => ({...entry, project: {...entry.project, name: ['Film 10', 'Ｆｉｌｍ 2', 'Film 2'][index]!,
    lastOpenedAt: index === 0 ? null : '2026-10-20T00:00:00.000Z', summary: index === 0 ? null : entry.project.summary}}));
  const original = structuredClone(projects);
  for (const locale of LOCALES) {
    const byName = orderedRecentProjects(projects, ' film ', 'name', locale);
    assert.equal(byName.length, 3);
    assert.equal(byName.at(-1)!.project.name, 'Film 10');
    assert.equal(orderedRecentProjects(projects, '', 'recent', locale).at(-1)!.project.summary, null);
    assert.equal(orderedRecentProjects(projects, '', 'updated', locale).at(-1)!.project.lastOpenedAt, null);
    assert.deepEqual(orderedRecentProjects(projects, 'no match', 'recent', locale), []);
    assert.equal(orderedRecentProjects(projects, 'Ｆｉｌｍ 10', 'recent', locale).length, 1);
  }
  assert.deepEqual(projects, original);
  const same = [projects[1]!, {...projects[2]!, project: {...projects[2]!.project, name: projects[1]!.project.name}}];
  assert.deepEqual(orderedRecentProjects(same.toReversed(), '', 'recent', 'en').map(entry => entry.project.projectId), same.map(entry => entry.project.projectId).sort());
});

test('waiting projects join only the current directory, prioritize reasons and retain exact task counts', () => {
  const projects = entries();
  const tasks = projects.map((entry, index) => ({projectId: entry.project.projectId, taskCount: index + 1,
    reasonCodes: [
      ['PROJECT_INVALID'], ['PROJECT_ACCESS_DENIED', 'PROJECT_LOCKED'], ['PROJECT_LOCKED', 'PROJECT_READONLY'],
      ['PROJECT_READ_ONLY', 'PROJECT_FILE_MOVED'], ['PROJECT_MISSING', 'PROJECT_INVALID'], ['PROJECT_LOCKED', 'PROJECT_MISSING'],
    ][index]!}));
  const result = waitingProjects(projects.toReversed(), Object.freeze([...tasks.toReversed(), {projectId: 'outside', taskCount: 1, reasonCodes: ['PROJECT_MISSING']}]));
  assert.deepEqual(result.map(project => project.projectId), projects.map(entry => entry.project.projectId));
  assert.deepEqual(result.map(project => project.reason), ['unavailable', 'locked', 'read-only', 'missing', 'missing', 'missing-volume']);
  assert.deepEqual(result.map(project => project.taskCount), [1, 2, 3, 4, 5, 6]);
  assert.equal(result.at(-1)!.volumeName, '外接硬盘');
  assert.equal(waitingProjects(projects, [{...tasks[0]!, reasonCodes: ['PROJECT_ACCESS_DENIED']}])[0]!.reason, 'access-denied');
  assert.equal(waitingProjects(projects, [{...tasks[0]!, reasonCodes: ['PROJECT_HISTORY_DIVERGED']}])[0]!.reason, 'unavailable');
  const neverOpened = projects.map(entry => ({...entry, project: {...entry.project, lastOpenedAt: null}}));
  assert.deepEqual(waitingProjects(neverOpened, tasks.toReversed()).map(project => project.projectId), tasks.map(task => task.projectId).sort());
});

test('12-24 collapses only beyond three projects, shows two rows plus the exact remainder, and expands all', () => {
  const data: WaitingProject[] = entries().map(entry => ({projectId: entry.project.projectId, projectName: entry.project.name, taskCount: 1, reason: 'unavailable', lastOpenedAt: entry.project.lastOpenedAt}));
  for (const size of [0, 1, 2, 3]) {
    const result = visibleWaitingProjects(data.slice(0, size), false);
    assert.equal(result.shown.length, size); assert.equal(result.remaining, 0);
  }
  assert.deepEqual(visibleWaitingProjects(data, false), {shown: data.slice(0, 2), remaining: 4});
  assert.deepEqual(visibleWaitingProjects(data, true), {shown: data, remaining: 0});
  const page = html('12-24');
  assert.equal(count(page, /data-testid="pf-waiting-[0-9a-f-]+"/gu), 2);
  assert.ok(page.includes(text('projectFile.home.waitingMore', {count: 4})));
  assert.ok(tagOf(page, 'pf-waiting-show-all'));
  const reasons = html('12-24-reasons');
  for (const key of ['waitingReason', 'waitingHelp', 'waitingOpen', 'locateProject'] as const) assert.ok(reasons.includes(text(`projectFile.home.${key}`)));
  assert.ok(reasons.includes(text('projectFile.home.menu.revealMac')));
  assert.match(html('12-24-error'), /data-testid="pf-waiting-error"/u);
  assert.doesNotMatch(html('12-24-error'), /data-testid="pf-card-waiting-/u);
  assert.ok(ui.render('12-24-reasons', 'en').includes('1 generation task is waiting'));
});

test('12-21 menus expose capabilities, distinguish real windows and prohibit forgetting unknown or waiting tasks', () => {
  const menuDisabled = (page: string, action: string, projectId: string = PROJECT_IDS.city) => /aria-disabled="true"/u.test(tagOf(page, `pf-menu-${action}-${projectId}`) ?? '');
  const regular = html('12-21');
  for (const action of ['open', 'copy', 'reveal', 'trash']) assert.ok(tagOf(regular, `pf-menu-${action}-${PROJECT_IDS.city}`));
  assert.equal(menuDisabled(regular, 'copy'), false, 'runtime availability=open alone does not imply an editor window');
  const opened = html('12-21-open');
  assert.equal(menuDisabled(opened, 'copy'), true); assert.equal(menuDisabled(opened, 'trash'), true); assert.equal(menuDisabled(opened, 'open'), false);
  assert.ok(opened.includes(text('projectFile.home.menu.closeHelp')));
  const missing = html('12-21-missing');
  assert.ok(tagOf(missing, `pf-menu-locate-${PROJECT_IDS.interview}`));
  assert.equal(menuDisabled(missing, 'forget', PROJECT_IDS.interview), false);
  for (const action of ['open', 'copy', 'reveal', 'trash']) assert.equal(tagOf(missing, `pf-menu-${action}-${PROJECT_IDS.interview}`), null);
  assert.equal(menuDisabled(html('12-21-waiting'), 'forget', PROJECT_IDS.interview), true);
  assert.equal(menuDisabled(html('12-21-unknown'), 'forget', PROJECT_IDS.interview), true);
  assert.ok(html('12-21-waiting').includes(text('projectFile.home.menu.waitingHelp')));
  const web = html('12-21-web');
  assert.equal(count(web, /role="menuitem"/gu), 1);
  assert.ok(tagOf(web, `pf-menu-open-${PROJECT_IDS.city}`));
});

test('no summary or successful open shows a cover placeholder without invented duration, aspect or last-opened tag', () => {
  const page = html('12-01-no-summary');
  assert.ok(tagOf(page, `pf-card-placeholder-${PROJECT_IDS.ui}`));
  assert.doesNotMatch(page, /class="pf-card-duration"|class="pf-card-aspect"|class="pf-card-tag"|<img/u);
  assert.match(html('12-01-no-matches'), /data-testid="pf-home-no-matches"/u);
  assert.doesNotMatch(html('12-01-no-matches'), /data-testid="pf-home-empty"/u);
});

interface TestElement {type: unknown; props: Record<string, unknown> & {children: unknown[]}}
function element(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): TestElement {return {type, props: {...props, children}};}
function findElement(tree: unknown, id: string): TestElement | null {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {for (const child of tree) {const found = findElement(child, id); if (found) return found;} return null;}
  const node = tree as TestElement;
  if (node.props?.['data-testid'] === id) return node;
  return findElement(node.props?.children, id);
}
/** Execute the actual small view functions with deterministic hook cells. This
 * checks event closures and the image failure transition without a DOM shim. */
function homeFunction(name: string, end: string, bindings: Record<string, unknown>): (props: Record<string, unknown>) => TestElement {
  const source = readFileSync(new URL('../apps/web/src/project-file/RecentProjects.tsx', import.meta.url), 'utf8');
  const start = source.indexOf(`export function ${name}(`), stop = end === 'EOF' ? source.length : source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start);
  const code = transformSync(source.slice(start, stop).replace('export function', 'function'), {loader: 'tsx', jsx: 'transform', target: 'es2023'}).code;
  return Function(...Object.keys(bindings), code + `\nreturn ${name};`)(...Object.values(bindings)) as (props: Record<string, unknown>) => TestElement;
}
test('a failed cached cover switches to its placeholder without another image or content request', () => {
  let failed = false;
  const cover = homeFunction('ProjectCover', '\ninterface RecentProjectMenuProps', {React: {createElement: element}, Icon: 'icon', useState: () => [failed, (next: boolean) => {failed = next;}]});
  const image = cover({coverUrl: '/api/project-covers/cached', projectId: PROJECT_IDS.ui});
  assert.equal(image.type, 'img');
  (image.props.onError as () => void)();
  const fallback = cover({coverUrl: '/api/project-covers/cached', projectId: PROJECT_IDS.ui});
  assert.equal(fallback.type, 'span'); assert.equal(fallback.props['data-testid'], `pf-card-placeholder-${PROJECT_IDS.ui}`);
});

test('retained menu callbacks observe busy state, removed capabilities and newly waiting tasks before dispatch', () => {
  const cell = {current: {}}, calls: string[] = [];
  const names = ['DropdownMenu', 'DropdownMenuTrigger', 'WorkbenchButton', 'WorkbenchIcon', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuSeparator', 'ProjectFileIcon', 'Icon', 'Trash2'];
  const menu = homeFunction('RecentProjectMenu', '\ninterface ProjectWaitingNoticeProps', {React: {createElement: element, Fragment: 'fragment'},
    useRef: () => cell, useI18n: () => ({t: (key: string) => key}), ...Object.fromEntries(names.map(name => [name, name]))});
  const props = {item: entries()[0]!, onOpen: () => calls.push('open'), onCopy: () => calls.push('copy'), onForget: () => calls.push('forget'), waitingKnown: true};
  const first = menu(props), open = findElement(first, `pf-menu-open-${PROJECT_IDS.ui}`)!.props.onClick as () => void;
  const copy = findElement(first, `pf-menu-copy-${PROJECT_IDS.ui}`)!.props.onClick as () => void;
  menu({...props, busy: true}); open(); copy(); assert.deepEqual(calls, []);
  menu({...props, onCopy: undefined}); copy(); assert.deepEqual(calls, []);
  menu({...props, openedInWindow: true}); copy(); assert.deepEqual(calls, []);
  menu(props); open(); assert.deepEqual(calls, ['open']);
  const missingProps = {...props, item: {...props.item, availability: {state: 'missing'}}};
  const forget = findElement(menu(missingProps), `pf-menu-forget-${PROJECT_IDS.ui}`)!.props.onClick as () => void;
  menu({...missingProps, waitingKnown: false}); forget();
  menu({...missingProps, waitingProject: {taskCount: 2}}); forget(); assert.deepEqual(calls, ['open']);
  menu(missingProps); forget(); assert.deepEqual(calls, ['open', 'forget']);
});

test('show all expands the live waiting rows and retained actions cannot open a changed, removed or busy project', () => {
  let expanded = false;
  const cell = {current: {}}, calls: string[] = [];
  const names = ['WorkbenchButton', 'ProjectFileIcon', 'Icon'];
  const notice = homeFunction('ProjectWaitingNotice', 'EOF', {React: {createElement: element},
    useState: () => [expanded, (value: boolean) => {expanded = value;}], useRef: () => cell,
    useI18n: () => ({t: (key: string) => key}), visibleWaitingProjects, ...Object.fromEntries(names.map(name => [name, name]))});
  const data: WaitingProject[] = entries().map(entry => ({projectId: entry.project.projectId, projectName: entry.project.name, taskCount: 1, reason: 'unavailable', lastOpenedAt: entry.project.lastOpenedAt}));
  const props = {entries: data, onOpen: (projectId: string) => calls.push(projectId)};
  const collapsed = notice(props), showAll = findElement(collapsed, 'pf-waiting-show-all')!.props.onClick as () => void;
  notice({...props, busy: true}); showAll(); assert.equal(expanded, false);
  notice(props); showAll(); assert.equal(expanded, true);
  const all = notice(props);
  assert.equal(findElement(all, 'pf-waiting-more'), null);
  for (const project of data) assert.ok(findElement(all, `pf-waiting-${project.projectId}`));
  const open = findElement(all, `pf-waiting-action-${PROJECT_IDS.ui}`)!.props.onClick as () => void;
  notice({...props, busy: true}); open();
  notice({...props, entries: data.slice(1)}); open();
  notice({...props, entries: [{...data[0]!, reason: 'read-only'}]}); open();
  assert.deepEqual(calls, []);
  notice(props); open(); assert.deepEqual(calls, [PROJECT_IDS.ui]);
});

test('12-01 locked, read-only and invalid cards say so; read-only is not called damaged', () => {
  const list = html('12-01-list');
  assert.match(list, /data-layout="list"/u);
  for (const state of ['locked', 'invalid', 'missing']) assert.match(list, new RegExp(`data-availability="${state}"`, 'u'));
  assert.ok(list.includes(text('projectFile.home.locked')));
  assert.ok(list.includes(text('projectFile.home.readOnly')));
  assert.equal(count(list, new RegExp(text('projectFile.home.invalid'), 'gu')), 1);
});

test('an access-denied recent card has its own warning in every locale without waiting tasks or extra capabilities', () => {
  for (const locale of LOCALES) {
    const names = ['WorkbenchButton', 'ProjectCover', 'RecentProjectMenu'];
    const t = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => translate(locale, key, ...args);
    const card = homeFunction('RecentProjectCard', '\n/** A failed cached image', {React: {createElement: element, Fragment: 'fragment'},
      useRef: () => ({current: {}}), useI18n: () => ({t}),
      useProjectFileDisplay: () => ({when: () => 'SYNTHETIC_LAST_OPENED_TIME'}),
      aspectLabel, clockTime, displayPath, folderOf, lastSeenLabel, ...Object.fromEntries(names.map(name => [name, name]))});
    const projectId = ACCESS_DENIED_PROJECT_ENTRY.project.projectId;
    const tree = card({item: ACCESS_DENIED_PROJECT_ENTRY, latest: false, sort: 'recent', layout: 'grid', now: NOW, homeDirectory: HOME, onOpen: () => {}});
    const badge = findElement(tree, `pf-card-access-denied-${projectId}`);
    assert.ok(badge, locale); assert.equal(badge.props['data-tone'], 'warning');
    assert.deepEqual(badge.props.children, [translate(locale, 'projectFile.home.accessDenied')]);
    assert.equal(findElement(tree, `pf-card-waiting-${projectId}`), null);
    assert.equal(findElement(tree, `pf-card-locate-${projectId}`), null);
    assert.doesNotMatch(JSON.stringify(tree), /SYNTHETIC_LAST_OPENED_TIME/u);
    for (const key of ['projectFile.home.missing', 'projectFile.home.readOnly', 'projectFile.home.invalid'] as const) {
      assert.equal(JSON.stringify(tree).includes(translate(locale, key)), false, `${locale}/${key}`);
    }
  }
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
  const inbox = text('projectFile.open.missing.bodyWithInbox', { path: OPEN_FAILURES.missing.projectFile, count: 2 });
  assert.ok(html('12-03').includes(inbox));
  assert.ok(html('12-03-no-inbox').includes(text('projectFile.open.missing.body', { path: OPEN_FAILURES.missing.projectFile })));
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

test('open failure descriptions keep complete English sentences and inbox plurals', () => {
  assert.ok(ui.render('12-03', 'en').includes('not connected. Once it is found, the 2 waiting generated results are written to it.'));
  assert.ok(ui.render('12-03d', 'en').includes('never opened. If this project was opened on this computer before, you can restore it from a local backup.'));
  const singular = translate('en', 'projectFile.open.missing.bodyWithInbox', { path: OPEN_FAILURES.missing.projectFile, count: 1 });
  assert.ok(singular.includes('not connected. Once it is found, the 1 waiting generated result is written to it.'));
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
