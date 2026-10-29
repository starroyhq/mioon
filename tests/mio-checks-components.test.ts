import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import type { AgentTaskSnapshot } from '../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskCheck, AgentTaskChecks } from '../packages/contracts/src/agent-task-checks-v2.ts';
import type { AgentTaskChecksViewState } from '../apps/web/src/agent-task-checks-state.ts';
import { visibleAgentTaskChecks } from '../apps/web/src/agent-task-checks-state.ts';
import * as presentation from '../apps/web/src/agent-task-presentation.ts';
import { createI18nTestContext, translate } from './helpers/i18n.ts';
import type { Locale } from '../packages/i18n/src/index.ts';

type Tree = string | number | boolean | null | undefined | Element | Tree[];
interface Element { type: unknown; props: Record<string, unknown> & { children?: Tree } }
const nodes = (tree: Tree): Element[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props.children)] : [];
const text = (tree: Tree): string => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const projectId = '10000000-0000-4000-8000-000000000001', runId = '20000000-0000-4000-8000-000000000001', targetId = '30000000-0000-4000-8000-000000000001', time = '2026-10-29T00:00:00.000Z';
const check = (id: string, patch: Partial<AgentTaskCheck> = {}): AgentTaskCheck => ({ id, source: 'host', type: 'generation_status', status: 'passed', target: { kind: 'job', id: targetId, name: '04 海岸航拍 · 横移' }, basis: [{ kind: 'job', id: targetId, revision: 1 }], ...patch });
const report = (items: AgentTaskCheck[]): AgentTaskChecks => ({ projectId, runId, runRevision: 1, groups: [{ id: 'export_render', items: [] }, { id: 'generation', items }, { id: 'timeline', items: [] }, { id: 'decomposition_frames', items: [] }] });
const state = (items: AgentTaskCheck[], patch: Partial<AgentTaskChecksViewState> = {}): AgentTaskChecksViewState => ({ report: report(items), loading: false, preflighting: false, error: false, justChecked: false, ...patch });
const snapshot = (status: AgentTaskSnapshot['run']['status'] = 'completed'): AgentTaskSnapshot => ({ run: { projectId, id: runId, requestId: 'synthetic-ui-round', text: '合成轮次', status, revision: 1, stepsUsed: 1, budget: 30, stepLimit: 30, configuration: {}, createdAt: time, updatedAt: time }, steps: [], changes: [] });

/** Exercise the real TSX render functions and handlers with the repository's
 * existing hook/tree approach. Browser evidence separately uses real React/DOM. */
function harness(viewState: AgentTaskChecksViewState, { locale = 'zh-Hans', readOnly = false, status = 'completed' }: { locale?: Locale; readOnly?: boolean; status?: AgentTaskSnapshot['run']['status'] } = {}) {
  const hooks: unknown[] = [viewState, true, true, undefined];
  let cursor = 0, refCursor = 0, rechecks = 0;
  const requests: string[] = [];
  const refs = [{ current: null }, { current: { recheck() { rechecks++; return Promise.resolve(); } } }];
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: Tree[]): Tree {
      const value = { ...props, children };
      return typeof type === 'function' ? (type as (props: typeof value) => Tree)(value) : { type, props: value };
    }, Fragment: 'fragment', useId: () => 'checks-test-content',
    useState(value: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof value === 'function' ? (value as () => unknown)() : value; return [hooks[index], (next: unknown) => { hooks[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(hooks[index]) : next; }]; },
    useRef: () => refs[refCursor++], useEffect() {}, useLayoutEffect() {},
  };
  const module: { exports: { default?: (props: Record<string, unknown>) => Tree } } = { exports: {} };
  const source = readFileSync(new URL('../apps/web/src/AgentTaskChecks.tsx', import.meta.url), 'utf8');
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)((id: string) => {
    if (id === 'react') return { ...react, default: react };
    if (id.includes('workbench-controls')) return { WorkbenchButton: 'button' };
    if (id.includes('workbench-tooltip')) return { WorkbenchTooltip: (props: { children: Tree }) => props.children };
    if (id === './i18n/I18nProvider.tsx') return { useI18n: () => createI18nTestContext(locale) };
    if (id === './agent-task-checks-state.ts') return { visibleAgentTaskChecks, createAgentTaskChecksView: () => assert.fail('Effects are not mounted in render-only checks') };
    if (id === './agent-task-presentation.ts') return presentation;
    if (id === './icons.tsx') return { __esModule: true, default: (props: Record<string, unknown>) => ({ type: 'svg', props }) };
    assert.fail(`Unexpected component dependency: ${id}`);
  }, module, module.exports);
  const render = () => { cursor = 0; refCursor = 0; return module.exports.default!({ scope: 'fixture', snapshot: snapshot(status), latest: true, visible: true, readOnly, onOpenRequests: (id: string) => requests.push(id) }); };
  return { render, requests, rechecks: () => rechecks, update(next: AgentTaskChecksViewState) { hooks[0] = next; } };
}

test('completion starts folded when passed, expands failures first within canonical groups, and can be toggled', () => {
  const h = harness(state([check('passed'), check('failed', { status: 'failed', reason: { code: 'TASK_FAILED' } })]));
  let tree = h.render(), toggle = nodes(tree).find(node => node.props['aria-controls'] === 'checks-test-content')!;
  assert.equal(toggle.props['aria-expanded'], true);
  assert.ok(String(toggle.props['aria-label']).includes('完成情况 2 项'));
  assert.ok(String(toggle.props['aria-label']).includes('1 项未通过'));
  assert.deepEqual(nodes(tree).filter(node => node.props['data-check-id']).map(node => node.props['data-check-id']), ['failed', 'passed']);
  const failureIcon = nodes(tree).find(node => node.props.role === 'img' && node.props['data-tone'] === 'danger');
  assert.ok(failureIcon);
  assert.ok(nodes(failureIcon).some(node => node.type === 'circle' && node.props.r === '9'), 'The approved failure icon has a circle around its cross');
  (toggle.props.onClick as () => void)(); tree = h.render(); assert.equal(nodes(tree).find(node => node.props.id === 'checks-test-content')!.props.hidden, true);
  const passed = harness(state([check('passed')])); tree = passed.render();
  assert.equal(nodes(tree).find(node => node.props.id === 'checks-test-content')!.props.hidden, true);
  assert.ok(text(tree).includes('全部通过'));
});

test('progress and active work spin, but charge and unavailable pending reasons stay still', () => {
  const h = harness(state([
    check('progress', { status: 'pending', progress: 62, reason: { code: 'TASK_PENDING' } }),
    check('charge', { type: 'generation_cost', status: 'pending', reason: { code: 'COST_SUBMITTED' } }),
    check('unavailable', { status: 'pending', reason: { code: 'RECORD_UNAVAILABLE' } }),
  ]));
  const tree = h.render(), rows = nodes(tree).filter(node => node.props['data-check-id']);
  assert.ok(text(tree).includes('生成中 62%'));
  assert.equal(nodes(rows[0]).filter(node => node.props.className === 'wb-spinner').length, 1);
  assert.equal(nodes(rows[1]).filter(node => node.props.className === 'wb-spinner').length, 0);
  assert.equal(nodes(rows[2]).filter(node => node.props.className === 'wb-spinner').length, 0);
});

test('initial reads render only a zero-height observation sentinel without loading or empty wording', () => {
  for (const loading of [false, true]) {
    const h = harness(state([], { report: null, loading })), tree = h.render();
    const sentinel = nodes(tree).find(node => node.props['data-testid'] === 'agent-task-checks-sentinel');
    assert.ok(sentinel); assert.equal(sentinel.type, 'section'); assert.equal(sentinel.props.className, 'mio-checks-sentinel'); assert.equal(sentinel.props['aria-hidden'], true);
    assert.ok(sentinel.props.ref); assert.equal(text(tree), ''); assert.equal(nodes(tree).filter(node => node.type === 'button').length, 0);
    assert.equal(nodes(tree).some(node => node.props.className === 'mio-check-heading'), false);
    h.update(state([check('ready')])); const loaded = h.render();
    assert.equal(nodes(loaded).find(node => node.props['data-testid'] === 'agent-task-checks')!.props.ref, sentinel.props.ref, 'The same observation root survives the first successful read');
  }
});

test('successful all-not-applicable or NOT_REQUESTED-only reports keep a sentinel without a zero-count title', () => {
  for (const items of [[], [check('not-applicable', { status: 'not_applicable' })], [check('preflight', { type: 'timeline_preflight', status: 'pending', reason: { code: 'PREFLIGHT_NOT_REQUESTED' } })]]) {
    const tree = harness(state(items)).render(), sentinel = nodes(tree).find(node => node.props['data-testid'] === 'agent-task-checks-sentinel');
    assert.ok(sentinel); assert.equal(sentinel.props['aria-hidden'], true); assert.equal(text(tree), '');
    assert.equal(nodes(tree).filter(node => node.props['data-check-id']).length, 0); assert.equal(nodes(tree).filter(node => node.type === 'button').length, 0);
    assert.equal(nodes(tree).some(node => node.props.className === 'mio-check-heading'), false);
  }
});

test('a first-read error keeps a title without a zero count, an error and a usable retry', () => {
  const h = harness(state([], { report: null, error: true })), tree = h.render();
  assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'agent-task-checks-sentinel'), false);
  assert.equal(text(nodes(tree).find(node => node.props.className === 'mio-check-heading')!), '完成情况');
  assert.doesNotMatch(text(tree), /0 项|没有适用的检查项|正在读取完成情况/u);
  assert.equal(text(nodes(tree).find(node => node.props.role === 'alert')!), translate('zh-Hans', 'agent.checks.readFailed'));
  const refresh = nodes(tree).find(node => node.props['aria-label'] === '重新检查')!;
  assert.equal(refresh.props.disabled, false); (refresh.props.onClick as () => void)(); assert.equal(h.rechecks(), 1);
});

test('not-applicable and not-requested checks do not count; running preflight has an active pending row', () => {
  const items = [check('not-applicable', { status: 'not_applicable' }), check('preflight', { type: 'timeline_preflight', status: 'pending', reason: { code: 'PREFLIGHT_NOT_REQUESTED' } })];
  const h = harness(state(items)); let tree = h.render();
  assert.equal(nodes(tree).filter(node => node.props['data-check-id']).length, 0);
  assert.ok(nodes(tree).some(node => node.props['data-testid'] === 'agent-task-checks-sentinel')); assert.equal(text(tree), '');
  h.update(state(items, { preflighting: true, loading: true })); tree = h.render();
  assert.equal(nodes(tree).filter(node => node.props['data-check-id']).length, 1);
  assert.ok(text(tree).includes('正在检查导出条件'));
  assert.equal(nodes(tree).find(node => node.props['aria-label'] === '重新检查')!.props.loading, true);
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'agent-task-check-summary')!.props['data-tone'], 'pending');
});

test('recheck and locate remain available in restored views with no execution controls, and refresh errors retain rows', () => {
  const h = harness(state([check('job')], { justChecked: true }), { readOnly: true }); let tree = h.render();
  const refresh = nodes(tree).find(node => node.props['aria-label'] === '重新检查')!;
  assert.equal(refresh.props.disabled, false); (refresh.props.onClick as () => void)(); assert.equal(h.rechecks(), 1);
  const locate = nodes(tree).find(node => node.props.className === 'mio-check-locate')!;
  assert.equal(locate.props.disabled, false); (locate.props.onClick as () => void)(); assert.deepEqual(h.requests, [targetId]);
  assert.ok(text(tree).includes('刚刚检查'));
  assert.equal(nodes(tree).filter(node => node.type === 'button').length, 3, 'Only expand, recheck and locate controls');
  h.update(state([check('job')], { error: true })); tree = h.render();
  assert.equal(nodes(tree).find(node => node.props.role === 'alert')!.props.className, 'mio-error');
  assert.equal(nodes(tree).filter(node => node.props['data-check-id']).length, 1);
});

test('English summaries use singular and plural with a separate dot and whole-summary failure color', () => {
  const h = harness(state([check('one', { status: 'failed', reason: { code: 'TASK_FAILED' } })]), { locale: 'en' });
  let tree = h.render(); assert.ok(text(tree).includes('Completion 1 check · 1 check failed'));
  let summary = nodes(tree).find(node => node.props['data-testid'] === 'agent-task-check-summary')!;
  assert.equal(summary.props['data-tone'], 'danger'); assert.equal(text(summary), '1 check failed');
  assert.equal(nodes(summary).filter(node => node.props['data-tone'] === 'danger').length, 1, 'The complete failure summary is styled, without a count-only semantic fragment');
  const toggle = nodes(tree).find(node => node.props['aria-controls'] === 'checks-test-content')!, ordered = nodes(toggle);
  const headingIndex = ordered.findIndex(node => node.props.className === 'mio-check-heading'), separatorIndex = ordered.findIndex(node => node.props.className === 'mio-check-separator'), summaryIndex = ordered.findIndex(node => node.props['data-testid'] === 'agent-task-check-summary');
  assert.ok(headingIndex < separatorIndex && separatorIndex < summaryIndex);
  assert.equal(text(ordered[separatorIndex]!), ' · '); assert.equal(String(ordered[separatorIndex]!.props['aria-hidden']), 'true');
  assert.equal(text(ordered[headingIndex]!), 'Completion 1 check'); assert.doesNotMatch(text(summary), /·/u);
  h.update(state([check('one', { status: 'failed' }), check('two', { status: 'failed' })])); tree = h.render();
  assert.ok(text(tree).includes(translate('en', 'agent.checks.titleCount', { count: 2 })));
  assert.ok(text(tree).includes('2 checks failed'));
  summary = nodes(tree).find(node => node.props['data-testid'] === 'agent-task-check-summary')!; assert.equal(summary.props['data-tone'], 'danger'); assert.equal(text(summary), '2 checks failed');
});

test('pending summaries use the body-text tone across the full localized summary', () => {
  const tree = harness(state([check('one', { status: 'pending', reason: { code: 'COST_PENDING' } }), check('two', { status: 'pending', reason: { code: 'COST_SUBMITTED' } })]), { locale: 'en' }).render();
  const summary = nodes(tree).find(node => node.props['data-testid'] === 'agent-task-check-summary')!;
  assert.equal(summary.props['data-tone'], 'pending'); assert.equal(text(summary), '2 checks pending');
});

test('sentinel dimensions and approved failure and pending colors use the existing theme tokens', () => {
  const css = readFileSync(new URL('../apps/web/src/agent-task-v2.css', import.meta.url), 'utf8');
  const rule = (selector: string) => { const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), found = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'u').exec(css); assert.ok(found, selector); return found[1]!.replace(/\s/gu, ''); };
  const sentinel = rule('.mio-checks-sentinel');
  for (const property of ['height', 'min-height', 'margin', 'padding']) assert.match(sentinel, new RegExp(`(?:^|;)${property}:0(?:px)?(?:;|$)`, 'u'));
  assert.doesNotMatch(sentinel, /display:none|visibility:hidden/u);
  assert.match(rule('.mio-check-summary[data-tone=danger]'), /(?:^|;)color:var\(--wb-danger\)(?:;|$)/u);
  assert.match(rule('.mio-check-summary[data-tone=pending]'), /(?:^|;)color:var\(--wb-text\)(?:;|$)/u);
  assert.match(rule('.mio-check-row[data-status=failed] .mio-check-reason'), /(?:^|;)color:var\(--wb-danger\)(?:;|$)/u);
});

test('unfinished, failed, stopped and reverted rounds do not render completion UI', () => {
  for (const status of ['accepted', 'running', 'awaiting_approval', 'paused', 'failed', 'stopped', 'reverted', 'interrupted'] as const) assert.equal(harness(state([check('one')]), { status }).render(), null, status);
});
