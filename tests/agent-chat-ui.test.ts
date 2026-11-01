import type {ElementType, ElementProps, Tree, Element, Hook, Module} from './helpers/strict-agent-ui-types.ts';
import { createI18nTestContext, message } from './helpers/i18n.ts';
import { creationTestDependency } from './helpers/creation-i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripSourceTypes } from './helpers/eval-source.ts';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { workspaceOriginScope, type WorkspaceIdentity } from '../apps/web/src/workspace-origin.ts';
import { projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, projectOpenFailureKind } from '../apps/web/src/project-open-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { readAgentChatSSE, type AgentChatFrame } from '../apps/web/src/agent-sse.ts';

const projectId = 'project-one';
const deferred = () => { let resolve!: (value?: unknown)=>void, reject!: (reason?: unknown)=>void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const element = (type: ElementType, props: Partial<ElementProps>|null = {}, ...children: Tree[]) => { const properties = { ...props, children: children.length === 1 ? children[0] : children }; return { type, props: properties }; };
const nodes = (tree: Tree): Element[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const depsEqual = (a: readonly unknown[]|undefined, b: readonly unknown[]|undefined) => a?.length === b?.length && a!.every((value: unknown, i) => Object.is(value, b![i]));

test('SSE parser handles every UTF-8 byte split, CRLF, comments and duplicate frames as data', async () => {
  const data = { id: 2, type: 'delta', projectId, text: '你好 🎬' }; const wire = new TextEncoder().encode(`: keepalive\r\n\r\nid: 2\r\nevent: delta\r\ndata: ${JSON.stringify(data)}\r\n\r\n`);
  const frames: AgentChatFrame[] = [], body = new ReadableStream({ start(controller) { for (const byte of wire) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  await readAgentChatSSE(body, value => frames.push(value)); assert.equal(frames.length, 1); assert.equal((frames[0].data as {text:string}).text, '你好 🎬');
  const broken = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"x":1}\n')); controller.close(); } });
  await assert.rejects(readAgentChatSSE(broken, () => assert.fail('incomplete frame dispatched')));
});
test('real shared Input preserves accessible native checkbox markup, checked state and disabling', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fixture = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { Input } from './src/components/input.tsx';
    import { Label } from './src/components/label.tsx';
    export const html = renderToStaticMarkup(<Label htmlFor="consent-runtime"><Input id="consent-runtime" data-testid="agent-chat-consent" type="checkbox" checked disabled onChange={() => {}} />Confirm sending typed chat</Label>);
  `;
  const script = `
    import { build } from 'esbuild';
    import assert from 'node:assert/strict';
    const { outputFiles } = await build({ stdin: { contents: ${JSON.stringify(fixture)}, loader: 'tsx', resolveDir: ${JSON.stringify(root + '/packages/ui')} }, bundle: true, format: 'esm', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '\"production\"' } });
    const { html } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    for (const expected of ['for="consent-runtime"', 'id="consent-runtime"', 'data-slot="input"', 'type="checkbox"', 'checked=""', 'disabled=""', 'Confirm sending typed chat']) assert.ok(html.includes(expected), 'Missing shared checkbox markup: ' + expected);
    process.stdout.write('Shared consent checkbox verified'); process.exit(0);
  `;
  assert.match((execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }) as string), /Shared consent checkbox verified/);
});

const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const actualFunction = (begin: string, end: string) => { const start = appSource.indexOf(begin), stop = appSource.indexOf(end, start); assert.ok(start >= 0 && stop > start); return appSource.slice(start, stop).trim(); };
const guardSource = actualFunction('  async function guardNavigation(', '  async function guardProjectNavigation(');
const projectGuardSource = actualFunction('  async function guardProjectNavigation(', '  async function prepareSettingsDeparture(');
const settingsDepartureSource = actualFunction('  async function prepareSettingsDeparture()', '  async function changeHomePage(');
const sessionReadySource = actualFunction('  function projectSessionReady()', '  const workbenchReady =');
const projectSource = actualFunction('  async function selectProject(', '  async function showProjectHome(');
const navigationProjectId = '77000000-0000-4000-8000-000000000001', navigationNextId = '77000000-0000-4000-8000-000000000002', navigationLaterId = '77000000-0000-4000-8000-000000000003';
function projectNavigation({ draft = true, imageDraft = false, dirty = false, confirmation = true }: {draft?:boolean;imageDraft?:boolean;dirty?:boolean;confirmation?:boolean|Promise<unknown>} = {}) {
  const calls: [string,...unknown[]][] = [], currentProject = { current: navigationProjectId }, navigationEpoch = { current: 0 }, projectEpoch = { current: 0 }, dirtyRef = { current: dirty }, formatState = {}, workspaceRef = { current: { restored: false } };
  const context = () => ({ projectId: currentProject.current, epoch: navigationEpoch.current, workspace: workspaceRef.current });
  const guardEnv = { message, msg: message, ...createI18nTestContext(), nativeWindow: null, localDeliveryRef: { current: null }, shotTextRef: { current: null }, clipDraftRef: { current: null }, deliveryNameRef: { current: null }, subtitlesRef: { current: { controller: { getState: () => null, hasUnsaved: () => false, discardDraft: () => calls.push(['discardSubtitles']) } } }, setSubtitleDirty: (value: unknown) => calls.push(['subtitleDirty', value]), context, dirtyRef, timelineFormatRef: { current: { controller: { getState: () => formatState, hasUnsaved: () => false, discardDraft: () => calls.push(['discardFormat']) } } }, confirm: async (message: unknown) => { calls.push(['confirm', message]); return confirmation; }, isCurrent: (captured: { projectId: string; epoch: number; workspace: WorkspaceIdentity|null|undefined; }) => captured.projectId === currentProject.current && captured.epoch === navigationEpoch.current && workspaceOriginScope(captured.workspace) === workspaceOriginScope(workspaceRef.current),
    setShotDirty: (value: unknown) => calls.push(['shotDirty', value]), setClipDirty: (value: unknown) => calls.push(['clipDirty', value]), setSourceDirty: (value: unknown) => calls.push(['sourceDirty', value]), setSubjectDirty: (value: unknown) => calls.push(['subjectDirty', value]), subjectsRef: { current: { state: { scope: 'fixture-subject-scope' }, controller: { discardDrafts: (scope: unknown) => calls.push(['discardSubjects', scope]) } } }, setInspectorEpoch: () => calls.push(['inspectorEpoch']) };
  const { guardNavigation, guardProjectNavigation } = Function(...Object.keys(guardEnv), `${stripSourceTypes(guardSource,{loader:'tsx'})}\n${stripSourceTypes(projectGuardSource,{loader:'tsx'})}\nreturn { guardNavigation, guardProjectNavigation };`)(...Object.values(guardEnv));
  const restored = { activeMode: 'canvas', canvas: { selectedId: null, viewport: { zoom: 1 } } };
  const env = ({ message, msg: message, ...createI18nTestContext(), application: null, nativeWindow: null, nativeProjectEntry: null, workspaceRef, workspaceOriginScope, projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, projectOpenFailureKind,
    context, isCurrent: guardEnv.isCurrent, confirm: guardEnv.confirm, notify: (...args: unknown[]) => calls.push(['notify', ...args]), readableError: (error: { message: unknown; }) => error.message,
    openedProject: { current: projectOpenAttempt(navigationProjectId, 0, 'normal') }, settingsNavigation: { current: createSettingsNavigationRegistry() },
    loading: false, importSession: { current: { active: true, selection: 0 } }, lastProjectRef: { current: { invalidateNavigation: () => {}, rememberOpened: () => {} } }, tasksRef: { current: { getState: () => ({ phase: 'idle', items: [] }), load: async (id: unknown) => { calls.push(['loadTasks', id]); } } }, currentProject, agentDraft: { current: draft }, imageDraft: { current: imageDraft }, guardNavigation, guardProjectNavigation, navigationEpoch, projectEpoch, requestCounter: { current: 0 }, preferencesRef: { current: { flush: () => calls.push(['flush']), load: async (id: unknown) => { calls.push(['load', id]); return restored; }, getStatus: () => ({ phase: 'ready' }) } }, viewReady: { current: true }, dataRef: { current: { project: { id: navigationProjectId } } }, emptyData: {}, pendingForProject: () => [], dragging: { current: false }, viewRef: { current: restored }, updateView: () => {}, URL,
    window: { location: { href: 'https://workbench.example.com/' }, history: { pushState: () => calls.push(['history']), replaceState: () => calls.push(['history']) } }, localStorage: { setItem: () => {} }, ...Object.fromEntries(['setProjectOpening', 'setHomePage', 'setAuth', 'setPropertiesPage', 'setTaskState', 'setSelectedTaskId', 'setPreferenceStatus', 'setPending', 'setShowProjects', 'setData', 'setNodes', 'setLoading', 'setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch', 'setRightDockTab', 'setShowExports', 'setPanelOverlay', 'setShowTasks', 'setShowDelivery', 'setShowImage', 'setShowProjectChooser', 'setComparisonId', 'setPreviewAsset', 'setRealConfirm', 'setToast', 'setMobilePanel', 'setView', 'setZoom'].map(name => [name, (value: unknown) => calls.push([name, value])])) } as unknown as import('./helpers/strict-agent-ui-types.ts').AppNavigationEnv);
  env.refresh = async (id: unknown, _quiet: unknown, options: { opening: unknown; }) => { assert.equal(options?.opening, true); env.dataRef.current = { project: { id }, shots: [], nodes: [] }; return env.dataRef.current; };
  env.prepareSettingsDeparture = () => Function(...Object.keys(env), `${stripSourceTypes(settingsDepartureSource,{loader:'tsx'})}\nreturn prepareSettingsDeparture();`)(...Object.values(env));
  env.projectSessionReady = () => Function(...Object.keys(env), `${stripSourceTypes(sessionReadySource,{loader:'tsx'})}\nreturn projectSessionReady();`)(...Object.values(env));
  const selectProject = Function(...Object.keys(env), `return (${stripSourceTypes(projectSource,{loader:'tsx'})});`)(...Object.values(env));
  return { selectProject, guardNavigation, calls, currentProject, navigationEpoch, env };
}

test('actual App project guard Cancel retains unsent chat and current project without clearing any panel', async () => {
  const f = projectNavigation({ confirmation: false }); assert.equal(await f.selectProject(navigationNextId), false);
  assert.equal(f.currentProject.current, navigationProjectId); assert.equal(f.env.agentDraft.current, true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'confirm'); assert.match((createI18nTestContext().renderMessage((f.calls[0][1] as unknown as Parameters<ReturnType<typeof createI18nTestContext>['renderMessage']>[0])) as string), /未发送的草稿/); assert.match((createI18nTestContext().renderMessage((f.calls[0][1] as unknown as Parameters<ReturnType<typeof createI18nTestContext>['renderMessage']>[0])) as string), /已发送的回复可能继续/);
});

test('actual App project guard Confirm permits project-key isolation; no draft or merely running reply needs no prompt', async () => {
  const f = projectNavigation(); assert.equal(await f.selectProject(navigationNextId), true); assert.equal(f.currentProject.current, navigationNextId); assert.equal(f.env.projectSessionReady(), true);
  assert.equal(f.calls.filter(call => call[0] === 'confirm').length, 1); assert.equal(f.calls.filter(call => call[0] === 'setData').length, 1);
  assert.deepEqual(f.calls.filter(call => call[0] === 'setSourceDirty'), [['setSourceDirty', false]]);
  assert.deepEqual(f.calls.filter(call => call[0] === 'setSelectedTaskId'), [['setSelectedTaskId', undefined]]);
  const g = projectNavigation({ draft: false }); assert.equal(await g.selectProject(navigationNextId), true); assert.equal(g.calls.some(call => call[0] === 'confirm'), false);
  assert.doesNotMatch((projectSource as string), /activeAgentChatRun|\.stop\(|setRightDockTab\((?!value => value === 'tasks' \? 'properties' : value\))/);
  const resetTab = (f.calls.find(call => call[0] === 'setRightDockTab')![1] as unknown as (tab:string)=>string);
  assert.equal(resetTab('agent'), 'agent'); assert.equal(resetTab('tasks'), 'properties');
});

test('actual App image draft guard Cancel preserves project and Confirm changes it without stopping accepted work', async () => {
  const cancelled = projectNavigation({ draft: false, imageDraft: true, confirmation: false });
  assert.equal(await cancelled.selectProject(navigationNextId), false); assert.equal(cancelled.currentProject.current, navigationProjectId); assert.equal(cancelled.env.imageDraft.current, true);
  assert.equal(cancelled.calls.length, 1); assert.match((createI18nTestContext().renderMessage((cancelled.calls[0][1] as unknown as Parameters<ReturnType<typeof createI18nTestContext>['renderMessage']>[0])) as string), /图像工坊有未发送的草稿/);
  const confirmed = projectNavigation({ draft: false, imageDraft: true }); assert.equal(await confirmed.selectProject(navigationNextId), true); assert.equal(confirmed.currentProject.current, navigationNextId); assert.equal(confirmed.calls.filter(call => call[0] === 'confirm').length, 1);
  assert.deepEqual(confirmed.calls.filter(call => call[0] === 'setSelectedTaskId'), [['setSelectedTaskId', undefined]]);
  const both = projectNavigation({ imageDraft: true, confirmation: false }); await both.selectProject(navigationNextId); assert.match((createI18nTestContext().renderMessage((both.calls[0][1] as unknown as Parameters<ReturnType<typeof createI18nTestContext>['renderMessage']>[0])) as string), /Mio 和图像工坊都有未发送的草稿/);
  assert.doesNotMatch((projectSource as string), /image\.task\.|image\.generate|setRightDockTab\((?!value => value === 'tasks' \? 'properties' : value\))/);
  assert.equal((confirmed.calls.find(call => call[0] === 'setRightDockTab')![1] as (tab:string)=>string)('image'), 'image');
});

test('actual App dirty-panel guard retains source drafts on Cancel and clears dirty state only after Confirm', async () => {
  const cancelled = projectNavigation({ draft: false, dirty: true, confirmation: false });
  assert.equal(await cancelled.guardNavigation(), false);
  assert.equal(cancelled.calls.length, 1); assert.equal(cancelled.calls[0][0], 'confirm');
  const confirmed = projectNavigation({ draft: false, dirty: true });
  assert.equal(await confirmed.guardNavigation(), true);
  assert.deepEqual(confirmed.calls.filter(call => ['shotDirty', 'clipDirty', 'sourceDirty', 'subjectDirty', 'subtitleDirty'].includes(call[0])),
    [['shotDirty', false], ['clipDirty', false], ['sourceDirty', false], ['subjectDirty', false], ['subtitleDirty', false]]);
  assert.deepEqual(confirmed.calls.filter(call => call[0] === 'discardSubtitles'), [['discardSubtitles']]);
  assert.deepEqual(confirmed.calls.filter(call => call[0] === 'discardSubjects'), [['discardSubjects', 'fixture-subject-scope']]);
  assert.equal(confirmed.calls.filter(call => call[0] === 'inspectorEpoch').length, 1);
});

test('actual App navigation rejects late discard confirmation after a newer project and mode switches ignore chat draft', async () => {
  const held = deferred(), f = projectNavigation({ confirmation: held.promise }); const pending = f.selectProject(navigationNextId);
  await flush(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'confirm');
  f.currentProject.current = navigationLaterId; f.navigationEpoch.current++; held.resolve!(true); assert.equal(await pending, false); assert.equal(f.currentProject.current, navigationLaterId); assert.equal(f.calls.length, 1);
  const g = projectNavigation(); assert.equal(await g.guardNavigation(), true); assert.equal(g.calls.length, 0, 'Mode navigation only consults existing Inspector dirty state');
  const mode = actualFunction('  async function changeMode(', '  function revealCanvas('); assert.match((mode as string), /await guardNavigation\(\)/); assert.doesNotMatch((mode as string), /agentDraft|setRightDockTab|setAgentPage/);
});

const workspaceSource = readFileSync(new URL('../apps/web/src/AgentWorkspace.tsx', import.meta.url), 'utf8');
function workspaceHarness(exportName = 'default') {
  const slots: Hook[] = []; let cursor = 0, effects: number[] = [], visible = true;
  const react = { createElement: (type: string, props?: {}|undefined, ...children: ((arg0: () => void) => unknown)[]) => type === 'SettingsNavigationSlot' ? children[0](() => {}) : element(type, props, ...children), useRef: (value: unknown) => slots[cursor++] ||= { current: value }, useLayoutEffect(callback: ()=>void|(()=>void), deps: readonly unknown[]) { const i = cursor++, old = slots[i]; if (old && depsEqual(deps, old.deps)) return; slots[i] = { deps, callback }; effects.push(i); } }; (react as typeof react & {default?: unknown}).default = react;
  const module: Module = { exports: {} } as Module;
  Function('module', 'exports', 'require', transformSync(workspaceSource, { loader: 'tsx', format: 'cjs' }).code)(module, module.exports, (id: string) => creationTestDependency(id) || (id === 'react' ? react : id === './AgentTaskPanel.tsx' ? { __esModule: true, default: 'AgentTaskPanel' } : id === './AgentSettings.tsx' ? { __esModule: true, default: 'AgentSettings' } : id === './SettingsNavigationSlot.tsx' ? { __esModule: true, default: 'SettingsNavigationSlot' } : { useWorkspaceVisibility: () => visible, WorkspaceVisibilityProvider: 'VisibilityProvider' }));
  return { render(props: { projectId?: string|undefined; projectName?: string; page?: string; onPage?: () => void; onCollapse?: () => void; onDraftChange?: () => void; workspaceScope?: string; visible?: boolean; id?: string; labelledBy?: string; children?: unknown; }) { cursor = 0; effects = []; const tree: Tree = module.exports[exportName]!(props); for (const i of effects) slots[i].callback!(); return tree; }, setAncestorVisible(value: boolean) { visible = value; } };
}

test('actual dock workspace keeps chat and globally scoped settings mounted through page and project changes', () => {
  const h = workspaceHarness(), props = { projectId, projectName: 'Local label', page: 'chat', onPage() {}, onCollapse() {}, onDraftChange() {} };
  let tree = h.render(props); assert.equal(nodes(tree).filter((node) => node.type === 'AgentTaskPanel').length, 1); assert.equal(nodes(tree).some((node) => node.type === 'AgentSettings'), false);
  tree = h.render({ ...props, page: 'settings' }); const chat = nodes(tree).find((node) => node.type === 'AgentTaskPanel'), settingsPage = nodes(tree).find((node) => node.type === 'AgentSettings');
  assert.equal(chat!.props.key, `normal:${projectId}`); assert.ok(settingsPage); assert.equal(nodes(tree).find((node) => node.props.id === 'agent-chat-pane')!.props.visible, false);
  tree = h.render(props); assert.equal(nodes(tree).filter((node) => node.type === 'AgentTaskPanel').length, 1); assert.equal(nodes(tree).filter((node) => node.type === 'AgentSettings').length, 1);
  tree = h.render({ ...props, projectId: undefined }); assert.equal(nodes(tree).some((node) => node.type === 'AgentTaskPanel'), false); assert.equal(nodes(tree).filter((node) => node.type === 'AgentSettings').length, 1);
  tree = h.render({ ...props, projectId: 'project-two' }); assert.equal(nodes(tree).find((node) => node.type === 'AgentTaskPanel')!.props.key, 'normal:project-two'); assert.equal(nodes(tree).find((node) => node.type === 'AgentSettings')!.props.key, undefined);
  tree = h.render({ ...props, workspaceScope: 'restored:other-origin' }); assert.equal(nodes(tree).find((node) => node.type === 'AgentTaskPanel')!.props.key, `restored:other-origin:${projectId}`);
  assert.doesNotMatch((workspaceSource as string), /Dialog|localStorage|sessionStorage/);
});

test('actual nested dock page combines ancestor visibility, keeps children and marks hidden content inert', () => {
  const h = workspaceHarness('AgentDockPane'), child = element('Inspector', { draft: 'unchanged' });
  const props = { visible: true, id: 'right-dock-properties', labelledBy: 'right-dock-properties-tab', children: child };
  let tree = h.render(props), panel = nodes(tree).find((node) => node.props.id === props.id); assert.equal(panel!.props.hidden, false); assert.equal(panel!.props.role, 'tabpanel'); assert.equal(panel!.props['aria-labelledby'], props.labelledBy);
  h.setAncestorVisible(false); tree = h.render(props); panel = nodes(tree).find((node) => node.props.id === props.id); assert.equal(panel!.props.hidden, true); assert.equal(panel!.props.inert, true); assert.equal(panel!.props.children, child);
  h.setAncestorVisible(true); tree = h.render({ ...props, visible: false }); panel = nodes(tree).find((node) => node.props.id === props.id); assert.equal(panel!.props.hidden, true); assert.equal(panel!.props.children, child);
});

test('App right-dock tabs preserve existing layout, resize and Inspector subtree and ordinary selection never changes tabs', () => {
  assert.match((appSource as string), /rightDockTab, setRightDockTabState\] = useState\('properties'\)/); assert.match((appSource as string), /const setRightDockTab = \(value: string(?: \| \(\(previous: string\) => string\))?\) => \{ if \(!clipDraftRef\.current\?\.hasPendingComposition\(\)\) setRightDockTabState\(value\); \}/);
  for (const id of ['right-dock-tab-properties', 'right-dock-tab-agent', 'right-dock-tab-image'] as const) assert.ok((appSource + readFileSync(new URL('../apps/web/src/WorkbenchShell.tsx', import.meta.url), 'utf8') + readFileSync(new URL('../apps/web/src/CanvasToolbar.tsx', import.meta.url), 'utf8')).includes(`data-testid="${id}"`));
  assert.match((appSource as string), /<AgentDockPane id="right-dock-properties"[^>]+visible={rightDockTab === 'properties'}/);
  assert.match((appSource as string), /<AgentDockPane id="right-dock-agent"[^>]+visible={rightDockTab === 'agent'}/);
  assert.match((appSource as string), /<AgentDockPane id="right-dock-image"[^>]+visible={showImage}/);
  assert.match((appSource as string), /resizeHandle\('inspector', 'inspectorWidth'\)/);
  const inspectStart = appSource.indexOf('  async function inspect('), inspectEnd = appSource.indexOf('\n  async function ', inspectStart + 1);
  assert.ok(inspectStart > 0 && inspectEnd > inspectStart); assert.doesNotMatch((appSource.slice(inspectStart, inspectEnd) as string), /setRightDockTab|setAgentPage/);
  assert.equal((appSource.match(/<AgentWorkspace /g) || []).length, 1); assert.doesNotMatch((appSource as string), /showAgentSettings|showAgentChat/);
  assert.equal((appSource.match(/<ImageGeneration /g) || []).length, 1);
});
