import type {RootModule,RootControlledModules} from './helpers/strict-root-ui-types.ts';
import type {RootHook} from './helpers/strict-root-ui-types.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as targetMarks from '../apps/web/src/target-marks.ts';
import { mioFollowColor } from '../apps/web/src/mio-follow.ts';
import type { MioFollowFocus } from '../apps/web/src/mio-follow.ts';

const read = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const app = read('App.tsx'), layerSource = read('TargetMarkLayer.tsx'), css = read('target-marks.css');
const nodes = (value: RootTree) : RootNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const section = (source: string, start: string, end: string) => { const from = source.indexOf(start), to = source.indexOf(end, from); assert.ok(from >= 0 && to > from, `${start} … ${end}`); return source.slice(from, to); };

function layerHarness(props: unknown) {
  const hooks: RootHook[] = [], frames: (()=>void)[] = [], cancelled: number[] = []; let cursor = 0, pending: number[] = [];
  const react = {
    createElement: (type: string, elementProps: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...elementProps, children } }), Fragment: 'fragment',
    useRef: (value: unknown) => hooks[cursor++] ??= { current: value },
    useSyncExternalStore: (subscribe: (arg0: () => void) => unknown, get: () => unknown) => { const index = cursor++; hooks[index] ??= { unsubscribe: subscribe(() => {}) }; return get(); },
    useLayoutEffect: (callback: () => void | (() => void), deps: readonly unknown[] | undefined) => { const index = cursor++, old = hooks[index]; if (old && deps!.every((value, key) => Object.is(value, old.deps![key]))) return; old?.cleanup?.(); hooks[index] = { deps, callback }; pending.push(index); },
  };
  (react as typeof react & {default?: unknown}).default = react;
  const module = { exports: {} as RootModule<RootControlledModules['TargetMarkLayer.tsx']> };
  Function('module', 'exports', 'require', transformSync(layerSource, { loader: 'tsx', format: 'cjs' }).code)(module, module.exports, (id: string) =>
    id === 'react' ? react : id === 'react-dom' ? { createPortal: (child: unknown, container: unknown) => ({ type: 'portal', props: { container, children: [child] } }) } : id === './icons.tsx' ? { __esModule: true, default: 'Icon' } : id === '@mioon/ui/components/workbench-controls' ? { WorkbenchButton: 'button' } : id === './i18n/I18nProvider.tsx' ? { useI18n: () => ({ t: (key: unknown) => `t:${key}` }) } : id === './target-marks.ts' ? targetMarks : {});
  const previous = { document: globalThis.document, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.document = { body: { name: 'body' } } as unknown as Document;
  globalThis.requestAnimationFrame = callback => frames.push(callback as ()=>void);
  globalThis.cancelAnimationFrame = id => { cancelled.push(id); };
  return {
    frames, cancelled,
    render() { cursor = 0; pending = []; return module.exports.default(props as Parameters<typeof module.exports.default>[0]); },
    commit() { for (const index of pending) hooks[index].cleanup = hooks[index].callback!() ?? undefined; pending = []; },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); Object.assign(globalThis, { document: previous.document, requestAnimationFrame: previous.raf, cancelAnimationFrame: previous.caf }); },
  };
}

test('the mark layer renders one keyboard-reachable label per labelled mark, follows its target and never takes focus', () => {
  const calls: unknown[] = [], activated: unknown[] = [];
  let list = [
    { key: 'timeline_clip:a', target: { kind: 'timeline_clip', id: 'a' }, owner: 'change-a', label: true, phase: 'shown', held: false },
    { key: 'timeline_clip:b', target: { kind: 'timeline_clip', id: 'b' }, owner: 'change-b', label: false, phase: 'shown', held: false },
  ];
  const marks = { subscribe: () => () => {}, list: () => list, hold: (key: unknown, held: unknown) => calls.push(['hold', key, held]), sync: (measure: (arg0: string) => unknown) => { calls.push(['sync', measure('timeline_clip:a')]); return [{ key: 'timeline_clip:a', x: 10.4, y: 20.6, visible: true }]; } };
  const h = layerHarness({ marks, label: 'Mio 修改', ariaLabel: 'Mio 修改，查看这处变化', onActivate: (owner: unknown) => activated.push(owner) });
  try {
    const tree = h.render()!;
    assert.equal(tree.type, 'portal'); assert.equal(tree.props.container, globalThis.document.body);
    const layer = tree.props.children[0] as RootNode;
    assert.equal(layer.props[targetMarks.MARK_LAYER_ATTRIBUTE], '');
    const buttons = nodes(tree).filter((node) => node.type === 'button');
    assert.equal(buttons.length, 1, 'a glow without a label renders no button');
    const [button] = buttons;
    assert.equal(button.props.type, 'button'); assert.equal(button.props.variant, 'primary'); assert.equal(button.props['aria-label'], 'Mio 修改，查看这处变化');
    assert.equal(button.props['data-placed'], 'false', 'a label stays hidden until it is placed');
    assert.equal(button.props.autoFocus, undefined);
    assert.ok(nodes(button).some((node) => node.type === 'Icon' && node.props.name === 'sparkle' && node.props.size === 11));
    assert.ok(nodes(button).some((node) => node.type === 'span' && node.props.children.includes('Mio 修改')));
    const element = { offsetWidth: 66, offsetHeight: 18, style: {} as Record<string,string>, dataset: {} as Record<string,string> };
    (button.props.ref as (element:import('./helpers/strict-root-ui-types.ts').RootMediaElement|null)=>void)(element); h.commit();
    assert.deepEqual(calls.shift(), ['sync', { width: 66, height: 18 }]);
    assert.equal(element.style.transform, 'translate(10px, 21px)'); assert.equal(element.dataset.placed, 'true');
    assert.equal(h.frames.length, 1, 'it keeps following the target on the next frame');
    (h.frames.shift)!()!(); assert.deepEqual(calls.shift(), ['sync', { width: 66, height: 18 }]);
    button.props.onClick(); assert.deepEqual(activated, ['change-a']);
    button.props.onPointerEnter(); button.props.onPointerLeave(); button.props.onFocus(); button.props.onBlur();
    assert.deepEqual(calls, [['hold', 'timeline_clip:a', true], ['hold', 'timeline_clip:a', false], ['hold', 'timeline_clip:a', true], ['hold', 'timeline_clip:a', false]]);
    list = [];
    assert.equal(h.render(), null); h.commit();
    assert.equal(h.cancelled.length, 1, 'the frame loop stops when no mark is left');
  } finally { h.unmount(); }
  assert.doesNotMatch(layerSource, /\.focus\(|autoFocus/);
});

test('the mark label defaults to the Mio wording and takes the label a later caller passes', () => {
  const list = [{ key: 'shot:a', target: { kind: 'shot', id: 'a' }, owner: 'change-a', label: true, phase: 'shown', held: false }];
  const marks = { subscribe: () => () => {}, list: () => list, hold() {}, sync: () => [] };
  for (const [props, text, name] of [[{}, 't:agent.mark.label', 't:agent.mark.open'], [{ label: '待核对' }, '待核对', '待核对'], [{ label: '待核对', ariaLabel: '待核对，打开清单' }, '待核对', '待核对，打开清单']] as const) {
    const h = layerHarness({ marks, onActivate() {}, ...props });
    try {
      const button = nodes(h.render()).find((node) => node.type === 'button');
      assert.equal((button)!.props['aria-label'], name);
      assert.ok(nodes(button).some((node) => node.type === 'span' && node.props.children.includes(text)));
    } finally { h.unmount(); }
  }
});

test('App marks only newly saved Mio changes after refreshing, and clears marks on project and mode switches', () => {
  const handler = section(app, 'onTaskApplied={', 'onTaskOpenRequests=');
  assert.match(handler, /if \(currentProject\.current === projectId\) \{ const fresh = changeMarks\.accept\(snapshot, landed\); const epoch = projectEpoch\.current;/);
  assert.match(handler, /refresh\(projectId\)\.then\(next => \{ if \(next && currentProject\.current === projectId && projectEpoch\.current === epoch\) changeMarks\.show\(fresh\);/);
  assert.doesNotMatch(handler, /locate|changeMode|scrollIntoView|fitView|setRightDockTab/, 'painting a timed mark never moves the view');
  assert.doesNotMatch(app, /highlightAgentTaskChanges|agent-ai-highlight/);
  assert.match(app, /locateAgentTaskChange\(change, changeMarks\);/);
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*changeMarks\.reset\(\); setTaskReveal\(null\);\s*mioFollowCandidate\.current = null; setMioFollow\(null\);\s*\}, \[changeMarks, data\.project\?\.id\]\);/);
  assert.match(app, /useLayoutEffect\(\(\) => \{ changeMarks\.clear\(\); \}, \[changeMarks, workspaceMode\]\);/);
  assert.match(app, /useEffect\(\(\) => \(\) => changeMarks\.reset\(\), \[changeMarks\]\);/);
  assert.match(app, /<TargetMarkLayer marks=\{changeMarks\.marks\} label=\{t\('agent\.mark\.label'\)\} ariaLabel=\{t\('agent\.mark\.open'\)\} onActivate=\{revealTaskChange\} \/>/);
  assert.match(app, /taskReveal=\{taskReveal\}/);
});

test('clicking a label opens the Mio tab and asks for its change row without touching selection or the inspector', () => {
  const source = section(app, '  function revealTaskChange(', '  // Reset, not dispose');
  assert.doesNotMatch(((source) as unknown as Parameters<typeof assert.doesNotMatch>[0]), /setSelected|inspect\(|setTab\(|setPropertiesPage|setQuickAssetId|changeMode/);
  const compile = (env: { [s: string]: unknown; }|ArrayLike<unknown>) => Function(...Object.keys(env), `${transformSync(((source) as unknown as Parameters<typeof transformSync>[0]), { loader: 'ts' }).code}\nreturn revealTaskChange;`)(...Object.values(env)) as (target:unknown)=>unknown;
  const run = ({ collapsed = false, narrow = false, composing = false }: {collapsed?:boolean;narrow?:boolean;composing?:boolean} = {}) => {
    const calls: unknown[][] = [], updates: ((previous:{nonce:number;changeId?:string}|null)=>{changeId:string;nonce:number})[] = [];
    const reveal = compile({ clipDraftRef: { current: composing ? { hasPendingComposition: () => true } : null }, inspectorCollapsed: collapsed, geometry: { narrow },
      showCompactInspector: (page: unknown) => calls.push(['overlay', page]), markPanelIntent: () => calls.push(['intent']), setRightDockTab: (value: unknown) => calls.push(['tab', value]), setAgentPage: (value: unknown) => calls.push(['page', value]),
      setMobilePanel: (value: unknown) => calls.push(['mobile', value]), setTaskReveal: (update:(previous:{nonce:number}|null)=>{changeId:string;nonce:number}) => updates.push(update) });
    reveal('change-a');
    return { calls, updates };
  };
  const docked = run();
  assert.deepEqual(docked.calls, [['intent'], ['tab', 'agent'], ['page', 'chat']]);
  assert.deepEqual(docked.updates.map(update => update(null)), [{ changeId: 'change-a', nonce: 1 }]);
  assert.deepEqual(docked.updates[0]((({ changeId: 'older', nonce: 4 }) as unknown as Parameters<typeof docked.updates[0]>[0])), { changeId: 'change-a', nonce: 5 }, 'clicking the same label again reveals the row again');
  assert.deepEqual(run({ collapsed: true }).calls, [['overlay', 'agent']], 'a collapsed inspector opens Mio as an overlay');
  assert.deepEqual(run({ narrow: true }).calls.at(-1), ['mobile', 'inspector']);
  for (const blocked of [run({ composing: true })]) { assert.deepEqual((blocked.calls as unknown), []); assert.deepEqual((blocked.updates as unknown), []); }
});

test('the Mio panel opens a requested change row once it is visible, closing the history overlay first', () => {
  const panel = read('AgentTaskPanel.tsx');
  const effect = section(panel, '  const revealed = useRef(0);', '  const formatOptions=');
  assert.match(((effect) as unknown as Parameters<typeof assert.match>[0]), /if \(!reveal \|\| !visible \|\| reveal\.nonce === revealed\.current\) return;/);
  assert.match(((effect) as unknown as Parameters<typeof assert.match>[0]), /if \(historyOpen\) \{ closeHistory\(\); return; \}/);
  assert.match(((effect) as unknown as Parameters<typeof assert.match>[0]), /revealAgentTaskChangeRow\(log\.current, reveal\.changeId\)/);
  assert.match(((effect) as unknown as Parameters<typeof assert.match>[0]), /follow\.current = shown\.following; setFollowing\(shown\.following\);/);
  assert.match(((effect) as unknown as Parameters<typeof assert.match>[0]), /\}, \[reveal, visible, historyOpen\]\);/);
  assert.match(panel, /onChangeApplied: \(next, landed\) => callbacks\.current\.onApplied\?\.\(projectId, next, landed\)/);
  assert.match(read('AgentWorkspace.tsx'), /onLocate=\{onTaskLocate\} reveal=\{taskReveal\}/);
});

test('mark styles keep selection outlines, respect reduced motion and keep the text and pointer floors', () => {
  const glow = css.match(/\[data-mio-mark\] \{([^}]*)\}/u)?.[1];
  assert.ok(glow);
  assert.match(glow, /box-shadow: [^;]*!important;/);
  assert.doesNotMatch(glow, /outline|border/, 'the glow never replaces a selection outline or border');
  assert.match(css, /\.react-flow__node \.canvas-node\.is-selected\[data-mio-mark\] \{ --mio-mark-selection: 0 0 0 1px var\(--wb-accent-line\);/);
  assert.match(css, /\[data-mio-mark="fading"\] \{ --mio-mark-ring: transparent; --mio-mark-glow: transparent; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \[data-mio-mark\], \.mio-mark-layer \.mio-mark\.wb-button \{ animation: none; transition: none; \}\n\}/);
  assert.match(css, /\.mio-mark-layer \.mio-mark\.wb-button \{[^}]*min-width: 0; min-height: 0; height: 18px;[^}]*font-size: 10px;/, 'the shared button is reduced to the 18px pill');
  assert.match(css, /\.mio-mark > svg \{ flex: none; width: 11px; height: 11px; \}/);
  assert.match(css, /\.mio-mark::after \{ content: ""; position: absolute; inset: -3px -2px; \}/, '18px label plus 3px above and below reaches the 24px pointer floor');
  assert.match(css, /background: var\(--wb-accent\); color: var\(--wb-accent-foreground\);/);
  assert.match(css, /\.mio-mark-layer \{ position: fixed; inset: 0; z-index: 30; overflow: hidden; pointer-events: none; \}/);
  assert.doesNotMatch(read('agent-task-v2.css'), /agent-ai-highlight|agent-ai-flash/);
  assert.match(read('agent-task-v2.css'), /\.mio-panel \.mio-change\[data-revealed\]\{/);
});

type FollowProps = Parameters<typeof import('../apps/web/src/MioFollowLayer.tsx').default>[0];
const followSource = transformSync(read('MioFollowLayer.tsx'), { loader: 'tsx', format: 'cjs' }).code;
const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height });

class FollowElement {
  readonly dataset: Record<string, string> = { placed: 'false' };
  readonly attributes = new Map<string, string>();
  readonly styles = new Map<string, string>();
  readonly style = {
    transform: '', maxWidth: '', setProperty: (key: string, value: string) => this.styles.set(key, value),
    removeProperty: (key: string) => this.styles.delete(key),
  };
  isConnected = true;
  visible = true;
  rows: FollowElement[] = [];
  rect: ReturnType<typeof box>;
  constructor(rect: ReturnType<typeof box>) { this.rect = rect; }
  get offsetWidth() { return this.rect.width; }
  get offsetHeight() { return this.rect.height; }
  getBoundingClientRect() { return this.rect; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return this.rows; }
  getAttribute(key: string) { return this.attributes.get(key); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
}

function followHarness() {
  const hooks: RootHook[] = [], frames = new Map<number, (time: number) => void>();
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  const canvas = new FollowElement(box(100, 60, 800, 520)), timeline = new FollowElement(box(100, 600, 800, 260));
  const panel = new FollowElement(box(905, 60, 320, 800)), row = new FollowElement(box(910, 320, 280, 24));
  row.setAttribute('data-step-id', 'observe'); panel.rows = [row];
  const pointer = new FollowElement(box(0, 0, 20, 21)), label = new FollowElement(box(0, 0, 110, 58));
  const locator = new FollowElement(box(0, 0, 110, 28)), targets = new Map<string, FollowElement>();
  const revealed: Array<[string, ScrollBehavior]> = [];
  let index = 0, nextFrame = 0, now = 0, reduced = false, revealSucceeds = true;
  let pending: number[] = [];
  const view = {
    innerWidth: 1280, innerHeight: 900, performance: { now: () => now }, matchMedia: () => ({ matches: reduced }),
    addEventListener(name: string, listener: (event?: unknown) => void) {
      const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group);
    },
    removeEventListener(name: string, listener: (event?: unknown) => void) { listeners.get(name)?.delete(listener); },
    requestAnimationFrame(callback: (time: number) => void) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  };
  const doc = {
    defaultView: view, body: {}, activeElement: null, hidden: false,
    querySelector(selector: string) { return selector.includes('agent-task-panel') ? panel : selector.includes('timeline-scroll') ? timeline : canvas; },
  };
  const react = {
    createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }),
    useId: () => 'test-follow-gradient',
    useRef: (value: unknown) => hooks[index++] ??= { current: value },
    useLayoutEffect(callback: () => void | (() => void), deps: readonly unknown[]) {
      const slot = index++, old = hooks[slot];
      if (old && deps.every((value, key) => Object.is(value, old.deps![key]))) return;
      old?.cleanup?.(); hooks[slot] = { deps, callback }; pending.push(slot);
    },
  };
  const module = { exports: {} as RootModule<typeof import('../apps/web/src/MioFollowLayer.tsx')> };
  Function('module', 'exports', 'require', followSource)(module, module.exports, (id: string) => {
    switch (id) {
      case 'react': return react;
      case 'react-dom': return { createPortal: (child: RootTree) => child };
      case './canvas-fit.ts': return { coveredInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }), measuredOverlays: () => [] };
      case './icons.tsx': return 'Icon';
      case './i18n/I18nProvider.tsx': return { useI18n: () => ({ t: (key: string, input?: { target: string }) => key === 'agent.task.title' ? 'Mio' : `Mio 在 ${input?.target}` }) };
      case './mio-follow.ts': return { mioFollowColor };
      case './target-marks.ts': return {
        MARK_LAYER_ATTRIBUTE: targetMarks.MARK_LAYER_ATTRIBUTE,
        markTargetElements: (target: { id: string }) => targets.has(target.id) ? [targets.get(target.id)] : [],
        markTargetVisible: (node: FollowElement) => node.visible,
      };
      default: return {};
    }
  });
  const previous = { document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  Object.assign(globalThis, { document: doc, HTMLElement: FollowElement });
  const onReveal: FollowProps['onReveal'] = (target, behavior) => {
    revealed.push([target.id, behavior]); return revealSucceeds;
  };
  function render(focus: MioFollowFocus | null, more: Partial<Omit<FollowProps, 'focus'>> = {}) {
    index = 0; pending = [];
    const tree = module.exports.default({ focus, mode: 'canvas', enabled: true, reduceMotion: false, onReveal, ...more });
    for (const node of nodes(tree)) {
      const element = node.props['data-testid'] === 'mio-follow-cursor' ? pointer
        : node.props['data-testid'] === 'mio-follow-locator' ? locator : node.props.className === 'mio-follow-cursor-label' ? label : null;
      if (element && node.props.ref && typeof node.props.ref === 'object') node.props.ref.current = element;
    }
    for (const slot of pending) hooks[slot].cleanup = hooks[slot].callback!() ?? undefined;
    return tree;
  }
  return {
    render, targets, pointer, locator, revealed,
    frame(time: number) { now = time; const queued = [...frames.values()]; frames.clear(); for (const callback of queued) callback(time); },
    event(name: string, event?: unknown) { for (const listener of listeners.get(name) ?? []) listener(event); },
    reduce() { reduced = true; },
    setRevealResult(value: boolean) { revealSucceeds = value; },
    unmount() { for (const hook of hooks) hook.cleanup?.(); Object.assign(globalThis, previous); },
  };
}

const followFocus = (id: string, kind: NonNullable<MioFollowFocus['target']>['kind'] = 'shot'): MioFollowFocus => ({
  runId: 'stable-round', stepId: `step-${id}`, text: `修正 ${id}`, target: { id, kind, name: `镜头 ${id}` },
});

test('Mio positions and colors its pointer, and only the newest step receives the highlight', () => {
  const h = followHarness();
  const first = new FollowElement(box(220, 160, 200, 100)), newest = new FollowElement(box(500, 300, 200, 100));
  h.targets.set('01', first); h.targets.set('03', newest);
  try {
    h.render(followFocus('01'));
    const tree = h.render(followFocus('03'));
    h.frame(0);
    assert.equal(h.pointer.dataset.placed, 'true');
    assert.equal(h.pointer.style.transform, 'translate(576px, 320px)');
    assert.equal(first.getAttribute('data-mio-follow-highlight'), undefined);
    assert.equal(newest.getAttribute('data-mio-follow-highlight'), 'canvas');
    assert.equal(newest.styles.get('--mio-follow-color'), mioFollowColor('stable-round'));
    assert.equal(tree?.props.style['--mio-follow-color'], mioFollowColor('stable-round'));
    assert.ok(nodes(tree).some(node => node.props['data-testid'] === 'mio-follow-bubble' && node.props.children.includes('修正 03')));
    assert.equal(h.render(followFocus('03'), { mode: 'editing' }), null);
    assert.equal(newest.getAttribute('data-mio-follow-highlight'), undefined);
    assert.deepEqual(h.revealed, []);
  } finally { h.unmount(); }
});

test('Mio keeps observations at the panel edge and does not move either view', () => {
  const h = followHarness();
  try {
    const tree = h.render({ runId: 'stable-round', stepId: 'observe', text: '正在查看可用的影片模型' });
    h.frame(0);
    assert.equal(h.pointer.dataset.side, 'left');
    assert.equal(h.pointer.style.transform, 'translate(887px, 328px)');
    assert.ok(nodes(tree).some(node => node.props['data-testid'] === 'mio-follow-bubble' && node.props.children.includes('正在查看可用的影片模型')));
    assert.ok(!nodes(tree).some(node => node.props['data-testid'] === 'mio-follow-locator'));
    assert.deepEqual(h.revealed, []);
  } finally { h.unmount(); }
});

test('Mio leaves the viewport alone during a pointer hold and two seconds after the last input', () => {
  const h = followHarness();
  const outside = new FollowElement(box(1000, 200, 200, 100)); outside.visible = false;
  h.targets.set('03', outside);
  try {
    h.render(null);
    h.event('pointerdown', { pointerId: 3 });
    h.render(followFocus('03'));
    h.frame(6000);
    assert.equal(h.pointer.dataset.placed, 'false');
    assert.equal(h.locator.dataset.placed, 'true');
    assert.equal(h.locator.style.transform, 'translate(778px, 236px)');
    h.event('pointerup', { pointerId: 3 });
    h.frame(7999);
    assert.deepEqual(h.revealed, []);
    h.event('wheel');
    h.frame(9998);
    assert.deepEqual(h.revealed, []);
    h.event('input');
    h.frame(11997);
    assert.deepEqual(h.revealed, []);
    h.frame(11998);
    assert.deepEqual(h.revealed, [['03', 'smooth']]);
    h.frame(13000);
    assert.deepEqual(h.revealed, [['03', 'smooth']], 'a successful reveal never repeats for the same step');
  } finally { h.unmount(); }
});

test('Mio offers an explicit reveal while follow is off and places reduced-motion highlights without animation', () => {
  const h = followHarness();
  const clip = new FollowElement(box(960, 660, 140, 42)); clip.visible = false;
  h.targets.set('clip', clip);
  try {
    h.reduce();
    const focus = followFocus('clip', 'timeline_clip');
    const tree = h.render(focus, { mode: 'editing', enabled: false, reduceMotion: true });
    h.frame(0);
    assert.equal(tree?.props['data-reduced-motion'], 'true');
    assert.deepEqual(h.revealed, []);
    assert.equal(h.locator.dataset.placed, 'true');
    const button = nodes(tree).find(node => node.props['data-testid'] === 'mio-follow-locator');
    assert.equal(button?.type, 'button');
    button?.props.onClick();
    assert.deepEqual(h.revealed, [['clip', 'auto']]);
    clip.rect = box(560, 660, 140, 42); clip.visible = true;
    h.frame(1);
    assert.equal(h.pointer.style.transform, 'translate(628px, 677px)');
    assert.equal(clip.getAttribute('data-mio-follow-highlight'), 'editing');
    assert.equal(h.locator.dataset.placed, 'false');
    const followCss = read('mio-follow-layer.css');
    assert.match(followCss, /\.mio-follow-layer \{[^}]*pointer-events: none;/u);
    assert.match(followCss, /\.mio-follow-layer\[data-reduced-motion="true"\] \.mio-follow-cursor \{ transition: none; \}/u);
    assert.match(followCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none;/u);
  } finally { h.unmount(); }
});

test('Mio retries a reveal that could not yet reach its target', () => {
  const h = followHarness();
  try {
    h.setRevealResult(false);
    h.render(followFocus('03'));
    h.frame(0); h.frame(159);
    assert.deepEqual(h.revealed, [['03', 'smooth']]);
    h.setRevealResult(true);
    h.frame(160); h.frame(400);
    assert.deepEqual(h.revealed, [['03', 'smooth'], ['03', 'smooth']]);
  } finally { h.unmount(); }
});
