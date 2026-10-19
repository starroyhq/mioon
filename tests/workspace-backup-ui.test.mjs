import * as i18n from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { WORKSPACE_BACKUP_LIMITS, isWorkspaceBackupInspection } from '@mioon/contracts';
import * as backup from '../apps/web/src/workspace-backup-ui.js';

const inspection = patch => ({ formatVersion: 1, scope: 'whole_workspace', captureReady: false, reason: 'BACKEND_RUNNING', databaseSchemaVersion: 24,
  counts: { projects: 2, assets: 5, videoTasks: 3, imageTasks: 4, frameTasks: 1, exports: 2 },
  unresolved: { videoTasks: 1, imageTasks: 0, frameTasks: 0, exports: 0, agentRuns: 0, agentProposals: 2, editTasks: 0 },
  limits: { ...WORKSPACE_BACKUP_LIMITS }, inspectionComplete: true, issues: [], ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  let live = { scope: 'project-a:1:1', connected: true, visible: true };
  const reads = [], pending = [], auth = [], changes = [];
  const controller = backup.createWorkspaceBackupController({ getContext: () => live,
    read(input, options) { const response = deferred(); reads.push({ input, options }); pending.push(response); return response.promise; },
    onChange: value => changes.push(value), onUnauthorized: () => auth.push(true), now: () => '2026-10-12T00:00:00.000Z' });
  controller.setContext(live);
  return { controller, reads, pending, auth, changes, state: () => controller.getState(),
    set(patch, commit = true) { live = { ...live, ...patch }; if (commit) controller.setContext(live); },
    async ready(result = inspection()) { const request = controller.inspect(); pending.at(-1).resolve(result); await request; return controller.getState(); } };
}

test('mount, expansion, reconnection and restored visibility never inspect automatically', async () => {
  const f = fixture();
  for (const patch of [{ visible: false }, { visible: true }, { connected: false }, { connected: true }, { scope: 'project-b:2:2' }]) f.set(patch);
  assert.equal(f.reads.length, 0);
  f.set({ visible: false }); assert.equal(await f.controller.inspect(), null);
  f.set({ visible: true, connected: false }); assert.equal(await f.controller.inspect(), null);
  assert.equal(f.reads.length, 0);
});

test('one explicit click reads only empty input with cancellation and duplicate clicks cannot overlap', async () => {
  const f = fixture(), waiting = f.controller.inspect(), value = inspection();
  assert.equal(f.state().phase, 'checking'); assert.equal(f.reads.length, 1);
  assert.deepEqual(f.reads[0].input, {}); assert.ok(f.reads[0].options.signal instanceof AbortSignal);
  assert.equal(await f.controller.inspect(), null); assert.equal(f.reads.length, 1);
  f.pending[0].resolve(value); await waiting;
  assert.equal(f.state().phase, 'checked'); assert.equal(f.state().report.captureReady, false);
  assert.equal(f.state().checkedAt, '2026-10-12T00:00:00.000Z');
  value.counts.projects = 99; assert.equal(f.state().report.counts.projects, 2, 'state owns its snapshot');
});

test('bounded incomplete counts remain unknown rather than inventing zeros', async () => {
  const f = fixture(), result = inspection({ inspectionComplete: false, counts: { ...inspection().counts, assets: null }, issues: ['ROW_LIMIT'] });
  assert.equal(isWorkspaceBackupInspection(result), true); await f.ready(result);
  assert.equal(f.state().phase, 'incomplete'); assert.equal(f.state().report.counts.assets, null);
  assert.equal(backup.workspaceBackupCount(null), '未知'); assert.equal(backup.workspaceBackupCount(undefined), '未知');
  assert.equal(backup.workspaceBackupCount(0), '0'); assert.equal(backup.workspaceBackupCount(20_000), '20,000');
  assert.equal(backup.workspaceBackupBytes(WORKSPACE_BACKUP_LIMITS.databaseBytes), '512 MiB');
  assert.equal(backup.workspaceBackupBytes(WORKSPACE_BACKUP_LIMITS.totalBytes), '64 GiB');
});

for (const patch of [
  { captureReady: true }, { scope: 'project' }, { reason: 'READY' }, { databaseSchemaVersion: 25 },
  { counts: {} }, { counts: { ...inspection().counts, assets: -1 } }, { limits: { ...WORKSPACE_BACKUP_LIMITS, fileCount: 99 } },
  { issues: ['SECRET_TOKEN=private'], inspectionComplete: false }, { token: 'private' },
  { inspectionComplete: true, unresolved: { ...inspection().unresolved, editTasks: null } },
]) test(`malformed read fails closed without rendering arbitrary data: ${Object.keys(patch).join(',')}`, async () => {
  const f = fixture(); await f.ready(inspection(patch));
  assert.equal(f.state().phase, 'error'); assert.equal(f.state().report, null);
  assert.match(f.state().error, /无法识别/); assert.doesNotMatch(f.state().error, /SECRET_TOKEN|private/);
});

for (const action of [{ visible: false }, { connected: false }, { scope: 'project-b:2:2' }]) {
  test(`context change aborts pending work and late success/auth cannot replace current state: ${JSON.stringify(action)}`, async () => {
    for (const fail of [false, true]) {
      const f = fixture(), waiting = f.controller.inspect(); f.set(action);
      assert.equal(f.reads[0].options.signal.aborted, true);
      if (fail) f.pending[0].reject(Object.assign(Error('private token'), { code: 'UNAUTHORIZED' })); else f.pending[0].resolve(inspection());
      await waiting; assert.equal(f.state().report, null); assert.equal(f.auth.length, 0); assert.equal(f.state().error, '');
    }
  });
}

test('live owner or visibility change before React commit fences late success and authentication errors', async () => {
  for (const patch of [{ scope: 'project-a:1:2' }, { visible: false }, { connected: false }]) for (const fail of [false, true]) {
    const f = fixture(), waiting = f.controller.inspect(); f.set(patch, false);
    if (fail) f.pending[0].reject(Object.assign(Error('private token'), { code: 'UNAUTHORIZED' })); else f.pending[0].resolve(inspection());
    await waiting; assert.equal(f.state().report, null); assert.equal(f.auth.length, 0);
  }
});

test('hidden or disconnected reports become stale and old click closures cannot revive after return', async () => {
  const f = fixture(); await f.ready(); const old = f.state();
  for (const patch of [{ visible: false }, { visible: true }, { connected: false }, { connected: true }]) f.set(patch);
  assert.equal(f.state().phase, 'stale'); assert.equal(f.reads.length, 1); assert.equal(f.state().report.counts.projects, 2);
  assert.equal(await f.controller.inspect(old.scope, old.version), null); assert.equal(f.reads.length, 1);
  await f.ready(); assert.equal(f.reads.length, 2); assert.equal(f.state().phase, 'checked');
});

test('newer navigation request wins even when cancelled reads ignore their abort signal', async () => {
  const f = fixture(), first = f.controller.inspect(); f.set({ scope: 'project-b:2:2' });
  const second = f.controller.inspect(); f.pending[1].resolve(inspection({ counts: { ...inspection().counts, projects: 7 } })); await second;
  f.pending[0].resolve(inspection()); await first;
  assert.equal(f.state().scope, 'project-b:2:2'); assert.equal(f.state().report.counts.projects, 7);
});

test('unmount aborts, suppresses late callbacks and cannot be revived by a retained click; explicit remount is supported', async () => {
  const f = fixture(), waiting = f.controller.inspect(), old = f.state(); f.controller.dispose();
  assert.equal(f.reads[0].options.signal.aborted, true);
  f.pending[0].reject(Object.assign(Error('private token'), { code: 'UNAUTHORIZED' })); await waiting;
  assert.equal(f.auth.length, 0); assert.equal(await f.controller.inspect(old.scope, old.version), null); assert.equal(f.reads.length, 1);
  f.controller.connect(); f.set({ scope: 'project-a:1:1' }); await f.ready(); assert.equal(f.reads.length, 2);
});

test('current errors use fixed safe messages and never expose server exception text, paths or tokens', async () => {
  for (const code of ['UNAUTHORIZED', 'NETWORK', 'BOGUS_SECRET']) {
    const f = fixture(), waiting = f.controller.inspect();
    f.pending[0].reject(Object.assign(Error('/private/workspace connection_token=abc'), { code })); await waiting;
    assert.equal(f.state().phase, 'error'); assert.doesNotMatch(f.state().error, /private|connection_token|abc|BOGUS/);
    assert.equal(f.auth.length, code === 'UNAUTHORIZED' ? 1 : 0);
  }
});

const element = (type, props, ...children) => ({ type, props: { ...props, children } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join('') : tree && typeof tree === 'object' ? textOf(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const read = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const primitive = new Proxy({ __esModule: true, default: 'Component' }, { get: (target, name) => target[name] ?? String(name) });
function component(visible = true) {
  const react = { createElement: element, useLayoutEffect() {}, useRef: current => ({ current }), useState: value => [value, () => {}] }; react.default = react;
  const module = { exports: {} };
  Function('module', 'exports', 'require', transformSync(read('WorkspaceBackupPanel.jsx'), { loader: 'jsx', format: 'cjs' }).code)(module, module.exports,
    key => key === './i18n/I18nProvider.tsx' ? i18n.i18nTestModule() : key === '../../../packages/i18n/src/index.ts' ? i18n : key === 'react' ? react : key === './workspace-backup-ui.js' ? backup : key === './workspace-visibility.jsx' ? { useWorkspaceVisibility: () => visible } : key.endsWith('.md?raw') ? { __esModule: true, default: 'Bundled offline backup guide' } : primitive);
  return module.exports;
}

test('actual compact component uses shared collapsible controls and never reads on mount', () => {
  const calls = [], Panel = component().default;
  const tree = Panel({ scope: 'a:1', getScope: () => 'a:1', connected: true, read: (...args) => calls.push(args) });
  assert.equal(tree.type, 'Collapsible'); assert.equal(tree.props.open, false);
  assert.equal(nodes(tree).find(node => node.type === 'CollapsibleContent').props.keepMounted, true);
  assert.equal(nodes(tree).find(node => node.type === 'CollapsibleContent').props.inert, true);
  assert.match(textOf(tree), /整工作区.*需先正常关闭应用/); assert.equal(calls.length, 0);
  const hidden = component(false).default({ scope: 'a:1', connected: true, read: () => assert.fail('Hidden panel must not read') });
  assert.equal(nodes(hidden).find(node => node.type === 'CollapsibleTrigger').props.render.props.disabled, true);
  const css = read('workspace-backup.css'); assert.match(css, /max-height: 52%/); assert.match(css, /overflow: auto/);
});

test('actual details truthfully describe SQLite scope, exclusions, readonly limits and exact local commands', async () => {
  const f = fixture(); await f.ready(); const Details = component().WorkspaceBackupDetails;
  const tree = Details({ state: f.state(), controller: f.controller }), text = textOf(tree);
  for (const label of ['整个工作区', '所有项目、聊天、提示词', 'SQLite 内的本地缓存', '不包含应用凭据与应用设置', '用户文本仍可能含密钥', '未逐一检查源文件', '没有创建备份或验证恢复', '正常关闭 Mioon 和所有使用同一工作区的后端', '不会自动恢复、提交或重试任务', '不表示可以安全恢复', '恢复需按离线指南写入全新目录', '受限功能和后续备份限制请先阅读指南']) assert.ok(text.includes(label), label);
  assert.equal(text.includes('本阶段不支持恢复'), false);
  assert.equal(textOf(nodes(tree).find(node => node.props['data-testid'] === 'workspace-backup-create-command')), backup.WORKSPACE_BACKUP_CREATE_COMMAND);
  assert.equal(textOf(nodes(tree).find(node => node.props['data-testid'] === 'workspace-backup-verify-command')), backup.WORKSPACE_BACKUP_VERIFY_COMMAND);
  const guide = nodes(tree).find(node => node.type === 'a');
  assert.equal(guide.props.href, '#workspace-backup-guide-text'); assert.equal(guide.props['aria-expanded'], false);
  let prevented = false; guide.props.onClick({ preventDefault() { prevented = true; } }); assert.equal(prevented, true, 'Guide expansion must not navigate or alter history');
  assert.equal(guide.props.target, undefined); assert.match(read('WorkspaceBackupPanel.jsx'), /WORKSPACE-BACKUP-GUIDE\.zh-CN\.md\?raw/);
  assert.doesNotMatch(read('WorkspaceBackupPanel.jsx'), /WORKSPACE-BACKUP\.md|window\.open|dangerouslySetInnerHTML/);
  assert.equal(nodes(tree).filter(node => node.type === 'Button').length, 1);
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'workspace-backup-count-projects').props.children[0], '2');
  assert.doesNotMatch(read('WorkspaceBackupPanel.jsx'), /<input|<select|<button|role="dialog"|setInterval|setTimeout|fetch\(|clipboard|localStorage|sessionStorage/);
});

test('actual details show bounded missing counts, issues, current error and no fake all-clear', async () => {
  const f = fixture(), Details = component().WorkspaceBackupDetails;
  await f.ready(inspection({ inspectionComplete: false, counts: { ...inspection().counts, assets: null }, unresolved: { ...inspection().unresolved, editTasks: null }, issues: ['ROW_LIMIT'] }));
  const tree = Details({ state: f.state(), controller: f.controller }), text = textOf(tree);
  assert.match(text, /未知数量不等于零/); assert.match(text, /记录数量超过/); assert.doesNotMatch(text, /未发现未解决记录/);
  assert.equal(textOf(nodes(tree).find(node => node.props['data-testid'] === 'workspace-backup-count-assets')), '未知');
  const error = Details({ state: { ...f.state(), phase: 'error', report: null, error: backup.workspaceBackupError({ code: 'NETWORK' }) }, controller: f.controller });
  assert.match(textOf(error), /核对失败/); assert.equal(nodes(error).find(node => node.props.role === 'alert').props.children[0], backup.workspaceBackupError({ code: 'NETWORK' }));
});

test('actual retained details handler cannot read when hidden or after the project epoch changed', async () => {
  const f = fixture(); await f.ready(); const Details = component().WorkspaceBackupDetails;
  const old = Details({ state: f.state(), controller: f.controller }), click = nodes(old).find(node => node.type === 'Button').props.onClick;
  f.set({ visible: false }); await click(); f.set({ visible: true, scope: 'project-b:2:2' }); await click();
  assert.equal(f.reads.length, 1);
});

test('workspace settings keep one backup owner with an exact read-only dispatch and inactive admission', async () => {
  const app = read('App.jsx'), jsx = app.match(/<WorkspaceBackupPanel\s[\s\S]*?\/>/)?.[0]; assert.ok(jsx);
  assert.equal((app.match(/<WorkspaceBackupPanel /g) || []).length, 1);
  const start = app.indexOf('export function SettingsConnectionForms('), end = app.indexOf('export default function App(');
  assert.ok(app.indexOf(jsx) > start && app.indexOf(jsx) < end);
  assert.match(app.slice(start, end), /<SettingsWorkspace active=\{visible && page === 'workspace'\}/);
  assert.match(app.slice(start, end), /<WorkspaceVisibilityProvider visible=\{visible && page === 'workspace'\}/);
  const calls = [];
  const render = (connectionsAvailable, visible, page) => {
    const module = { exports: {} };
    Function('module', 'React', 'WorkspaceBackupPanel', 'connectionsAvailable', 'visible', 'page', 'productionRpc',
      transformSync(`module.exports = ${jsx};`, { loader: 'jsx', format: 'cjs' }).code)(module, { createElement: element }, 'Backup', connectionsAvailable, visible, page,
      async (...args) => { calls.push(args); return inspection(); });
    return module.exports.props;
  };
  const props = render(true, true, 'workspace'); assert.equal(props.scope, 'settings:workspace'); assert.equal(props.getScope(), props.scope); assert.equal(props.connected, true);
  for (const values of [[false,true,'workspace'],[true,false,'workspace'],[true,true,'general']]) assert.equal(render(...values).connected, false);
  const options = { signal: new AbortController().signal }; await props.read({}, options);
  assert.deepEqual(calls, [['workspace.backup.inspect', {}, options]]);
  assert.doesNotMatch(jsx, /setSelected|setPropertiesPage|discardDraft|runDurable|requestId|setToast|setInspectorEpoch|confirm\(/);
  assert.match(app + readFileSync(new URL('../apps/web/src/TaskPopover.tsx', import.meta.url), 'utf8'), /data-testid="right-dock-tab-tasks"/);
  transformSync(app, { loader: 'jsx', format: 'esm' });
});
