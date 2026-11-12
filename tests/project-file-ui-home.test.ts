import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build, transformSync} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';
import type { MessageArguments, MessageKey } from '../packages/i18n/src/index.ts';
import { assertGroupEvidence, escapeHtml, projectFileScenes, tagOf } from './helpers/project-file-ui.ts';
import { OPEN_FAILURES, PROJECT_IDS, RECENT_PROJECTS } from './fixtures/project-file-ui/fixtures.ts';
import {orderedRecentProjects, visibleWaitingProjects, waitingProjects} from '../apps/web/src/project-file/recent-project-view.ts';
import type {WaitingProject} from '../apps/web/src/project-file/recent-project-view.ts';
import type {ProjectEntry} from '../packages/contracts/src/project-entry.ts';
import {TIMELINE_CURRENT_OUTPUT_PRESETS} from '../packages/contracts/src/timeline-output-geometry.ts';
import {projectFilePathPreview, projectNameProblem, revealLabelKey, fileNameOf, stemOf} from '../apps/web/src/project-file/format.ts';

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
  assert.match(missing, new RegExp(`class="pf-card-meta" data-tone="danger"><span class="pf-card-status">${text('projectFile.home.missing')}</span><span>${text('projectFile.home.lastSeen', { place: '/Volumes/外接硬盘' })}</span>`, 'u'));
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
  return findElement([node.props?.children, node.props?.footer, node.props?.actions], id);
}
/** Execute the actual small view functions with deterministic hook cells. This
 * checks event closures and the image failure transition without a DOM shim. */
function homeFunction(name: string, end: string, bindings: Record<string, unknown>, file = '../apps/web/src/project-file/RecentProjects.tsx'): (props: Record<string, unknown>) => TestElement {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
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
  assert.ok(html('12-03').includes(text('projectFile.open.missing.body', {path: OPEN_FAILURES.missing.projectFile})));
  assert.doesNotMatch(html('12-03'), /data-testid="pf-open-inbox"|等待写入/u);
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

test('open failure descriptions keep complete English sentences and task plurals', () => {
  assert.ok(ui.render('12-03', 'en').includes('or its disk is not connected.'));
  assert.ok(ui.render('12-03d', 'en').includes('never opened. If this project was opened on this computer before, you can restore it from a local backup.'));
  const singular = translate('en', 'projectFile.open.missing.bodyWithTasks', {path: OPEN_FAILURES.missing.projectFile, count: 1});
  const plural = translate('en', 'projectFile.open.missing.bodyWithTasks', {path: OPEN_FAILURES.missing.projectFile, count: 2});
  assert.ok(singular.includes('not connected. There is 1 generation task waiting'));
  assert.ok(plural.includes('not connected. There are 2 generation tasks waiting'));
});

test('12-03d read-only keeps the layout and never calls the file damaged', () => {
  const readOnly = html('12-03d-read-only');
  assert.equal(title('12-03d-read-only'), '「产品演示 · 竖屏」是只读的');
  assert.ok(readOnly.includes(text('projectFile.open.readOnly.body')));
  assert.ok(!readOnly.includes(text('projectFile.open.invalid.body')));
  assert.ok(!readOnly.includes(text('projectFile.open.invalid.restore')));
  assert.equal(tagOf(readOnly, 'pf-open-restore'), null);
  assert.match(readOnly, /data-testid="pf-open-reveal"[^>]*>在 Finder 中显示</u);
  assert.ok(html('12-03d').includes(text('projectFile.open.invalid.body')));
});

test('P6 gallery keeps waiting counts, optional actions and create outcomes faithful in all four languages', () => {
  for(const locale of LOCALES) {
    const positive=ui.render('12-03',locale),zero=ui.render('12-03-no-inbox',locale),unknown=ui.render('12-03-tasks-unknown',locale);
    assert.ok(positive.includes(escapeHtml(translate(locale,'projectFile.open.missing.bodyWithTasks',{path:OPEN_FAILURES.missing.projectFile,count:2}))));
    assert.equal(disabled(tagOf(positive,'pf-open-remove')),true);assert.equal(disabled(tagOf(zero,'pf-open-remove')),false);
    assert.equal(disabled(tagOf(unknown,'pf-open-remove')),true);assert.equal(tagOf(unknown,'pf-open-waiting'),null);
    for(const id of ['12-02b-network','12-02b-checking','12-02b-unavailable']) assert.equal(disabled(tagOf(ui.render(id,locale),'pf-create-submit')),true,id);
    for(const id of ['12-02b-cloud','12-02b-exfat','12-02b-permissions']) assert.equal(disabled(tagOf(ui.render(id,locale),'pf-create-submit')),false,id);
    const web=ui.render('12-02-web',locale);assert.match(tagOf(web,'pf-create-folder')!,/checked=""/u);assert.equal(disabled(tagOf(web,'pf-create-folder')),true);
    for(const id of ['12-02-unknown','12-02-created','12-02-created-opening']) assert.equal(tagOf(ui.render(id,locale),'pf-create-submit'),null,id);
    assert.equal(disabled(tagOf(ui.render('12-02-unknown',locale),'pf-create-cancel')),true);
    const absent=ui.render('12-03e-no-capabilities',locale);assert.equal(tagOf(absent,'pf-open-adoptCopy'),null);assert.equal(tagOf(absent,'pf-open-openOriginal'),null);
    const adoption=ui.render('12-03e-unknown',locale);assert.equal(disabled(tagOf(adoption,'pf-open-adoptCopy')),true);assert.ok(tagOf(adoption,'pf-open-recheck'));
    assert.equal(tagOf(ui.render('12-03i-no-copy',locale),'pf-open-copyTo'),null);
    assert.doesNotMatch(ui.render('12-03-unknown',locale),/undefined|null|\/Users\/|\.mioon/u);
    for(const id of ['12-15-cloud','12-15-exfat','12-15-combined']) assert.ok(tagOf(ui.render(id,locale),'pf-location-banner'),id);
  }
});

/** Additional controlled props exercise defensive boundaries beyond the
 * fixed gallery table, including malformed facts and missing capabilities. */
const fixtureRoot = fileURLToPath(new URL('../', import.meta.url));
const controlledBundle = await build({stdin: {contents: `
  import React from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {NewProjectFileDialog} from './src/project-file/NewProjectFileDialog.tsx';
  import {ProjectOpenFailureDialog} from './src/project-file/ProjectOpenFailureDialog.tsx';
  import {ProjectLocationRiskNotice,ProjectLocationRiskBanner} from './src/project-file/ProjectLocationRisk.tsx';
  import {RecentProjectsView} from './src/project-file/RecentProjects.tsx';
  import {setLocale} from ${JSON.stringify(fixtureRoot + 'tests/fixtures/project-file-ui/ssr-i18n.tsx')};
  const components={create:NewProjectFileDialog,failure:ProjectOpenFailureDialog,risks:ProjectLocationRiskNotice,banner:ProjectLocationRiskBanner,recent:RecentProjectsView};
  export function render(kind,props,locale){setLocale(locale);return renderToStaticMarkup(React.createElement(components[kind],props));}
`, loader: 'tsx', resolveDir: fixtureRoot + 'apps/web'}, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}, nodePaths: [fixtureRoot + 'apps/web/node_modules'],
  plugins: [{name: 'controlled-open-flow', setup(builder) {
    builder.onResolve({filter: /^@mioon\/ui\/components\/(?:dialog|dropdown-menu)$/}, () => ({path: fixtureRoot + 'tests/fixtures/project-file-ui/ssr-overlays.tsx'}));
    builder.onResolve({filter: /\/i18n\/I18nProvider\.tsx$/}, () => ({path: fixtureRoot + 'tests/fixtures/project-file-ui/ssr-i18n.tsx'}));
  }}]});
const controlledModule: {exports: unknown} = {exports: {}};
Function('require', 'module', 'exports', controlledBundle.outputFiles[0]!.text)(createRequire(import.meta.url), controlledModule, controlledModule.exports);
const controlled = controlledModule.exports as {render(kind: 'create' | 'failure' | 'risks' | 'banner' | 'recent', props: Record<string, unknown>, locale: typeof LOCALES[number]): string};
const noAction = (): void => {};
const newProjectProps = {open: true, values: {name: '新项目', description: '', presetId: 'portrait_1080', createFolder: true}, location: {display: '/Users/example/Movies/Mioon'}, state: {kind: 'editing'}, onChange: noAction, onSubmit: noAction, onClose: noAction};
const openProps = {open: true, projectName: '访谈剪辑样片', failure: OPEN_FAILURES.missing, action: {kind: 'idle'}, platform: 'mac', onClose: noAction};

test('native rows and grid place their metadata next to the cover, keeping missing and waiting actions', () => {
  const homeDirectory = '/private/tmp/launcher-home';
  const projects = entries().map(entry => ({...entry, project: {...entry.project, projectFile: `${homeDirectory}/Projects/${entry.project.projectId}.mioon`}}));
  const missing = {...projects.at(-1)!, availability: {state: 'missing'} as const};
  const state = {kind: 'ready', value: [...projects.slice(0, -1), missing]};
  const waiting = {kind: 'ready', value: waitingProjects(state.value, [{projectId: missing.project.projectId, taskCount: 2, reasonCodes: ['PROJECT_MISSING']}])};
  const props = {state, waiting, homeDirectory, nativeLayout: true, sort: 'recent', now: new Date('2026-10-21T14:40:00+08:00'),
    onSortChange: noAction, onViewChange: noAction, onRetry: noAction, onOpen: noAction, onLocate: noAction};
  const firstCard = (page: string) => page.slice(page.indexOf(`data-testid="pf-card-${PROJECT_IDS.ui}"`)).split('</article>')[0]!;
  const listBeforeGrid = /data-testid="pf-home-view-list"[\s\S]+data-testid="pf-home-view-grid"/u;
  for (const locale of LOCALES) {
    const list = controlled.render('recent', {...props, view: 'list'}, locale);
    assert.match(tagOf(list, 'pf-recent-projects')!, /data-native-layout="true"/u);
    assert.match(tagOf(list, 'pf-home-list')!, /data-layout="list"/u);
    assert.match(list, listBeforeGrid);
    assert.equal(count(list, /data-testid="pf-card-open-/gu), projects.length);
    assert.match(firstCard(list), /class="pf-card-cover"[\s\S]+class="pf-card-name"[^>]*>[^<]+<\/span>[\s\S]+class="pf-card-meta"><span>~\/Projects<\/span><\/span><\/span><\/button>/u);
    assert.match(firstCard(list), /class="pf-card-list-info"><span class="pf-card-aspect">9:16<\/span><span class="pf-card-duration">00:42<\/span><span>[^<]+<\/span>/u);
    assert.ok(tagOf(list, `pf-waiting-action-${PROJECT_IDS.interview}`));
    const grid = controlled.render('recent', {...props, view: 'grid'}, locale);
    assert.match(tagOf(grid, 'pf-home-list')!, /data-layout="grid"/u);
    assert.match(firstCard(grid), /class="pf-card-cover"[\s\S]+class="pf-card-duration">00:42<\/span>[\s\S]+class="pf-card-grid-meta"><div class="pf-card-meta"><span>[^<]+<\/span><span class="pf-card-aspect">9:16<\/span>/u);
    assert.ok(!firstCard(grid).includes('~/Projects'));
    for (const [view, page] of [['list', list], ['grid', grid]] as const) {
      const missingCard = page.slice(page.indexOf(`data-testid="pf-card-${PROJECT_IDS.interview}"`)).split('</article>')[0]!;
      assert.match(missingCard, /class="pf-card-meta" data-tone="danger"/u);
      assert.ok(missingCard.includes(escapeHtml(translate(locale, 'projectFile.home.missing'))));
      assert.equal(missingCard.includes(escapeHtml(translate(locale, 'projectFile.home.lastSeen', {place: '~/Projects'}))), view === 'list');
      assert.ok(tagOf(missingCard, `pf-card-locate-${PROJECT_IDS.interview}`));
      assert.ok(tagOf(missingCard, `pf-card-waiting-${PROJECT_IDS.interview}`));
      assert.ok(tagOf(missingCard, `pf-card-menu-${PROJECT_IDS.interview}`));
    }
    const busy = controlled.render('recent', {...props, view: 'list', busy: true}, locale);
    assert.equal(disabled(tagOf(busy, `pf-card-open-${PROJECT_IDS.ui}`)), true);
    assert.equal(disabled(tagOf(busy, `pf-card-locate-${PROJECT_IDS.interview}`)), true);
  }
  assert.match(controlled.render('recent', {...props, nativeLayout: false, view: 'grid'}, 'en'), /data-testid="pf-home-view-grid"[\s\S]+data-testid="pf-home-view-list"/u);
});

test('custom launcher empty content appears only after an empty directory has loaded', () => {
  const props = {nativeLayout: true, view: 'list', sort: 'recent', now: new Date(), emptyContent: 'Custom empty content',
    onSortChange: noAction, onViewChange: noAction, onRetry: noAction, onOpen: noAction};
  const empty = controlled.render('recent', {...props, state: {kind: 'ready', value: []}}, 'en');
  assert.ok(tagOf(empty, 'pf-home-empty'));
  assert.match(empty, /Custom empty content/u);
  assert.doesNotMatch(empty, /pf-home-heading/u);
  for (const [state, query, expected] of [
    [{kind: 'loading'}, '', 'pf-home-loading'],
    [{kind: 'error', retryable: true}, '', 'pf-home-error'],
    [{kind: 'ready', value: entries()}, 'no matching project', 'pf-home-no-matches'],
  ] as const) {
    const page = controlled.render('recent', {...props, state, query}, 'en');
    assert.ok(tagOf(page, expected));
    assert.doesNotMatch(page, /Custom empty content/u);
  }
  const web = controlled.render('recent', {...props, nativeLayout: false, state: {kind: 'ready', value: []}}, 'en');
  assert.ok(tagOf(web, 'pf-home-empty'));
  assert.doesNotMatch(web, /data-native-layout|Custom empty content/u);
});

test('long project paths preserve distinct status labels and ordering in both home layouts and all languages', () => {
  const directory = `/private/tmp/P03/${'long-project-location-'.repeat(20)}`;
  const states: ProjectEntry['availability'][] = [{state: 'missing'}, {state: 'locked'}, {state: 'invalid', reason: 'read-only'}, {state: 'invalid', reason: 'corrupt'}];
  const statusKeys = ['projectFile.home.missing', 'projectFile.home.locked', 'projectFile.home.readOnly', 'projectFile.home.invalid'] as const;
  const projects: ProjectEntry[] = RECENT_PROJECTS.slice(0, 4).map((project, index) => ({project: {...project, name: `Status ${4 - index}`,
    projectFile: `${directory}/project-${index}.mioon`, lastOpenedAt: `2026-10-${20 + index}T00:00:00.000Z`,
    summary: project.summary ? {...project.summary, updatedAt: `2026-10-${20 + index}T00:00:00.000Z`} : null}, availability: states[index]!, coverUrl: null}));
  const original = structuredClone(projects);
  for (const locale of LOCALES) for (const view of ['grid', 'list'] as const) for (const sort of ['recent', 'updated', 'name'] as const) {
    const page = controlled.render('recent', {state: {kind: 'ready', value: projects}, sort, view, now: new Date('2026-10-24T00:00:00.000Z'),
      onSortChange: noAction, onViewChange: noAction, onRetry: noAction, onOpen: noAction}, locale);
    const cards = [...page.matchAll(/<article\b[^>]*data-testid="pf-card-([^"]+)"[^>]*>([\s\S]*?)<\/article>/gu)];
    assert.deepEqual(cards.map(card => card[1]), projects.toReversed().map(entry => entry.project.projectId), `${locale}/${view}/${sort}: availability must not reorder cards`);
    for (const [index, entry] of projects.entries()) {
      const card = cards.find(value => value[1] === entry.project.projectId)![2]!;
      const meta = /class="pf-card-meta"[^>]*>([\s\S]*?)<\/div>/u.exec(card)![1]!;
      const status = /<span class="pf-card-status"[^>]*>([^<]*)<\/span>/u.exec(meta);
      assert.ok(status, `${locale}/${view}/${sort}/${entry.availability.state}: status has its non-shrinking role`);
      assert.equal(status[1], escapeHtml(translate(locale, statusKeys[index]!)));
      assert.ok(meta.includes(directory), 'the original path remains available to render with ellipsis');
      assert.equal(meta.startsWith(status[0]), index !== 1, 'missing/invalid lead with their status; locked keeps its existing folder-then-status order');
    }
  }
  assert.deepEqual(projects, original);
});

test('12-02b shows only supplied location facts, blocks network/unknown locations and keeps positive warnings nonblocking', () => {
  for (const locale of LOCALES) {
    const plain = controlled.render('create', newProjectProps, locale);
    assert.doesNotMatch(plain, /data-testid="pf-location-risk-/u);
    assert.equal(disabled(tagOf(plain, 'pf-create-submit')), false);
    for (const kind of ['cloud', 'permissions']) {
      const page = controlled.render('create', {...newProjectProps, location: {...newProjectProps.location, risks: [{kind, ...(kind === 'cloud' ? {serviceName: 'iCloud 云盘'} : {fileSystem: 'exFAT'})}]}}, locale);
      assert.ok(tagOf(page, `pf-location-risk-${kind}`)); assert.equal(disabled(tagOf(page, 'pf-create-submit')), false);
    }
    const network = controlled.render('create', {...newProjectProps, location: {...newProjectProps.location, risks: [{kind: 'network'}]}}, locale);
    assert.match(network, /data-tone="danger"/u); assert.equal(disabled(tagOf(network, 'pf-create-submit')), true);
    for (const status of ['checking', 'unavailable']) {
      const page = controlled.render('create', {...newProjectProps, location: {...newProjectProps.location, status}}, locale);
      assert.ok(tagOf(page, `pf-create-location-${status}`)); assert.equal(disabled(tagOf(page, 'pf-create-submit')), true);
    }
    const fixedFolder = controlled.render('create', {...newProjectProps, folderMode: 'always', values: {...newProjectProps.values, createFolder: false}}, locale);
    assert.equal(disabled(tagOf(fixedFolder, 'pf-create-folder')), true);
    assert.match(tagOf(fixedFolder, 'pf-create-folder')!, /checked=""/u);
    assert.match(fixedFolder, /新项目\/新项目\.mioon/u);
    const noFolder = controlled.render('create', {...newProjectProps, folderMode: 'never'}, locale);
    assert.doesNotMatch(tagOf(noFolder, 'pf-create-folder')!, /checked=""/u);
    assert.doesNotMatch(noFolder, /新项目\/新项目\.mioon/u);
  }
  const unknownService = controlled.render('risks', {risks: [{kind: 'cloud'}, {kind: 'permissions', fileSystem: 'APFS'}]}, 'zh-Hans');
  assert.ok(unknownService.includes('云同步服务')); assert.doesNotMatch(unknownService, /Dropbox|exFAT/u);
});

test('12-02 unknown creation never offers another create; a known created project offers only reopening', () => {
  for (const locale of LOCALES) {
    const unknown = controlled.render('create', {...newProjectProps, state: {kind: 'unknown'}, onRecheck: noAction}, locale);
    assert.ok(tagOf(unknown, 'pf-create-unknown')); assert.equal(tagOf(unknown, 'pf-create-submit'), null);
    assert.equal(disabled(tagOf(unknown, 'pf-create-cancel')), true); assert.ok(tagOf(unknown, 'pf-create-recheck'));
    assert.match(tagOf(unknown, 'pf-create-name')!, /readOnly=""/u);
    const created = controlled.render('create', {...newProjectProps, state: {kind: 'created'}, onRetryOpen: noAction}, locale);
    assert.ok(tagOf(created, 'pf-create-created')); assert.ok(tagOf(created, 'pf-create-retry-open')); assert.equal(tagOf(created, 'pf-create-submit'), null);
    const noRetry = controlled.render('create', {...newProjectProps, state: {kind: 'created'}}, locale);
    assert.equal(tagOf(noRetry, 'pf-create-retry-open'), null);
  }
});

test('12-03 missing uses only verified waiting task counts and optional removal/locate capabilities', () => {
  for (const locale of LOCALES) {
    const base = {...openProps, onRemove: noAction, onLocate: noAction};
    const unknown = controlled.render('failure', base, locale);
    assert.equal(disabled(tagOf(unknown, 'pf-open-remove')), true);
    assert.equal(tagOf(unknown, 'pf-open-waiting'), null);
    const zero = controlled.render('failure', {...base, waitingTaskCount: 0}, locale);
    assert.equal(disabled(tagOf(zero, 'pf-open-remove')), false);
    const waiting = controlled.render('failure', {...base, waitingTaskCount: 2}, locale);
    assert.equal(disabled(tagOf(waiting, 'pf-open-remove')), true); assert.ok(tagOf(waiting, 'pf-open-waiting'));
    const absent = controlled.render('failure', openProps, locale);
    assert.equal(tagOf(absent, 'pf-open-remove'), null); assert.equal(tagOf(absent, 'pf-open-locate'), null); assert.ok(tagOf(absent, 'pf-open-close'));
  }
});

test('12-03e-i render complete translated issues while unprovided system and copy actions stay hidden', () => {
  const location = {projectFile: OPEN_FAILURES.missing.projectFile, projectId: PROJECT_IDS.interview};
  const copy = {...location, code: 'PROJECT_FILE_COPY', originalProjectId: PROJECT_IDS.interview, originalProjectFile: '/Users/example/原项目.mioon'};
  for (const locale of LOCALES) {
    const issueCases = [copy, {...location, code: 'PROJECT_ACCESS_DENIED'}, {...location, code: 'NETWORK_LOCATION'}, {...location, code: 'OPEN_UNAVAILABLE'}, OPEN_FAILURES.readOnly];
    for (const failure of issueCases) {
      const page = controlled.render('failure', {...openProps, failure}, locale);
      assert.match(page, /data-testid="pf-open-dialog"/u);
      for (const action of ['systemSettings', 'copyTo', 'adoptCopy', 'openOriginal', 'retry', 'chooseLocation']) assert.equal(tagOf(page, `pf-open-${action}`), null);
      assert.doesNotMatch(page, /projectFile\.(open|location)\./u);
    }
    const adoption = controlled.render('failure', {...openProps, failure: copy, onOpenOriginal: noAction, onAdoptCopy: noAction}, locale);
    assert.ok(adoption.includes('/Users/example/原项目.mioon')); assert.ok(tagOf(adoption, 'pf-open-adoptCopy')); assert.ok(tagOf(adoption, 'pf-open-openOriginal'));
    for (const failure of [copy, OPEN_FAILURES.readOnly, {...location, code: 'NETWORK_LOCATION'}]) {
      const expired = controlled.render('failure', {...openProps, failure, action: {kind: 'error', action: 'adoptCopy'}, notice: translate(locale, 'nativeEntry.requestExpired')}, locale);
      assert.ok(tagOf(expired, 'pf-open-notice'));
      assert.ok(expired.includes(escapeHtml(translate(locale, 'nativeEntry.requestExpired'))));
      assert.doesNotMatch(expired, /nativeEntry\.requestExpired/u);
      assert.equal(disabled(tagOf(expired, 'pf-open-close')), false);
      assert.equal(tagOf(expired, 'pf-open-unknown'), null);
    }
    for (const reason of ['missing', 'access-denied', 'disk-disconnected']) {
      const moved = controlled.render('failure', {...openProps, failure: {...location, code: 'PROJECT_FILE_MOVED', reason, writeRejected: true}, onCloseProject: noAction, onLocate: noAction}, locale);
      assert.ok(tagOf(moved, 'pf-open-closeProject')); assert.ok(tagOf(moved, 'pf-open-locate'));
      assert.ok(moved.length > 500);
    }
    const access = controlled.render('failure', {...openProps, failure: {...location, code: 'PROJECT_ACCESS_DENIED', context: 'create'}, onOpenSystemSettings: noAction, onChooseLocation: noAction}, locale);
    assert.ok(tagOf(access, 'pf-open-systemSettings')); assert.ok(tagOf(access, 'pf-open-chooseLocation')); assert.equal(tagOf(access, 'pf-open-retry'), null);
    const unavailable = controlled.render('failure', {...openProps, projectName: null, failure: {code: 'OPEN_UNAVAILABLE', projectId: null, projectFile: null}}, locale);
    assert.doesNotMatch(unavailable, /undefined|null|\/Users\/|\.mioon/u);
  }
  const malformedVersions = controlled.render('failure', {...openProps, failure: {...OPEN_FAILURES.newer, formatVersion: 0, supportedFormatVersion: 0}}, 'zh-Hans');
  assert.ok(malformedVersions.includes(translate('zh-Hans', 'projectFile.open.unavailable.body')));
  const noWriteProof = controlled.render('failure', {...openProps, failure: {...location, code: 'PROJECT_FILE_MOVED', reason: 'missing', writeRejected: false}}, 'zh-Hans');
  assert.doesNotMatch(noWriteProof, /刚才那一步修改没有写进/u);
  const unknown = controlled.render('failure', {...openProps, failure: copy, action: {kind: 'unknown', action: 'adoptCopy'}, onAdoptCopy: noAction, onRecheck: noAction}, 'zh-Hans');
  assert.equal(disabled(tagOf(unknown, 'pf-open-adoptCopy')), true); assert.equal(disabled(tagOf(unknown, 'pf-open-close')), true);
  assert.equal(disabled(tagOf(unknown, 'pf-open-recheck')), false);
});

test('12-15 is controlled by the current open session and makes no claim without positive facts', () => {
  for (const locale of LOCALES) {
    assert.equal(controlled.render('banner', {risks: [], onDismiss: noAction}, locale), '');
    const page = controlled.render('banner', {risks: [{kind: 'cloud', serviceName: 'iCloud 云盘'}, {kind: 'permissions', fileSystem: 'exFAT'}], onDismiss: noAction}, locale);
    assert.ok(tagOf(page, 'pf-location-banner')); assert.ok(tagOf(page, 'pf-location-dismiss'));
    assert.equal(count(page, /data-testid="pf-location-risk-/gu), 2);
  }
});

test('new project retained callbacks cannot change or repeat creation after its outcome becomes unknown or known', () => {
  const cell = {current: {}}, calls: string[] = [];
  const names = ['Dialog', 'WorkbenchDialogContent', 'WorkbenchButton', 'Label', 'Input', 'Textarea', 'Icon', 'Check', 'ProjectLocationRiskNotice', 'WorkbenchAlert'];
  const create = homeFunction('NewProjectFileDialog', 'EOF', {React: {createElement: element, Fragment: 'fragment'}, useRef: () => cell, useId: () => 'create',
    useI18n: () => ({t: (key: string) => key}), projectNameProblem, projectFilePathPreview, aspectLabel: () => '9:16', TIMELINE_CURRENT_OUTPUT_PRESETS, NEW_PROJECT_DESCRIPTION_MAX_LENGTH: 500,
    ...Object.fromEntries(names.map(name => [name, name]))}, '../apps/web/src/project-file/NewProjectFileDialog.tsx');
  const props = {...newProjectProps, onChange: () => calls.push('change'), onSubmit: () => calls.push('create'), onClose: () => calls.push('close'), onRetryOpen: () => calls.push('open'), onRecheck: () => calls.push('check')};
  const initial = create(props), edit = findElement(initial, 'pf-create-name')!.props.onChange as (event: unknown) => void;
  const submit = findElement(initial, 'pf-create-dialog')!.props.children[0] as TestElement;
  const runSubmit = submit.props.onSubmit as (event: {preventDefault(): void}) => void;
  create({...props, state: {kind: 'unknown'}}); edit({target: {value: 'another'}}); runSubmit({preventDefault() {}}); assert.deepEqual(calls, []);
  const created = create({...props, state: {kind: 'created'}}); runSubmit({preventDefault() {}});
  (findElement(created, 'pf-create-retry-open')!.props.onClick as () => void)(); assert.deepEqual(calls, ['open']);
  const checking = create({...props, location: {...props.location, status: 'checking'}}); runSubmit({preventDefault() {}}); assert.equal(disabledFromTree(findElement(checking, 'pf-create-submit')), true);
  create({...props, location: {...props.location, risks: [{kind: 'network'}]}}); runSubmit({preventDefault() {}}); assert.deepEqual(calls, ['open']);
});
function disabledFromTree(node: TestElement | null): boolean {return node?.props.disabled === true;}

test('retained failure actions recheck the issue, task state, capability and pending outcome before dispatch', () => {
  const cell = {current: {}}, calls: string[] = [];
  const names = ['Dialog', 'WorkbenchDialogContent', 'WorkbenchButton', 'WorkbenchAlert', 'WorkbenchIcon'];
  const failureView = homeFunction('ProjectOpenFailureDialog', 'EOF', {React: {createElement: element, Fragment: 'fragment'}, useRef: () => cell,
    useI18n: () => ({t: (key: string) => key}), revealLabelKey, fileNameOf, stemOf,
    ...Object.fromEntries(names.map(name => [name, name]))}, '../apps/web/src/project-file/ProjectOpenFailureDialog.tsx');
  const props = {...openProps, waitingTaskCount: 0, onRemove: () => calls.push('remove'), onLocate: () => calls.push('locate'), onRecheck: () => calls.push('check')};
  const initial = failureView(props);
  const remove = findElement(initial, 'pf-open-remove')!.props.onClick as () => void;
  const locate = findElement(initial, 'pf-open-locate')!.props.onClick as () => void;
  const close = findElement(initial, 'pf-open-close')!.props.onClick as () => void;
  failureView({...props, waitingTaskCount: undefined}); remove();
  failureView({...props, waitingTaskCount: 2}); remove();
  failureView({...props, onRemove: undefined, onLocate: undefined}); remove(); locate();
  failureView({...props, failure: {...OPEN_FAILURES.missing}}); remove(); locate();
  failureView({...props, action: {kind: 'working', action: 'locate'}}); remove(); locate(); close();
  const unknown = failureView({...props, action: {kind: 'unknown', action: 'locate'}}); remove(); locate(); close();
  assert.deepEqual(calls, []);
  (findElement(unknown, 'pf-open-recheck')!.props.onClick as () => void)(); assert.deepEqual(calls, ['check']);
  failureView(props); remove(); locate(); assert.deepEqual(calls, ['check', 'remove', 'locate']);
  failureView({...props, open: false}); remove(); locate(); assert.deepEqual(calls, ['check', 'remove', 'locate']);
});

test('home screenshots match the scene table', async () => {
  await assertGroupEvidence('home');
});
