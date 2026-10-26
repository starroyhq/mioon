import type {RootModule,RootControlledModules} from './helpers/strict-root-ui-types.ts';
import type {RootHook} from './helpers/strict-root-ui-types.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as targetMarks from '../apps/web/src/target-marks.ts';

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
  assert.match(app, /onTaskApplied=\{\(projectId, snapshot, landed = \[\]\) => \{ if \(currentProject\.current === projectId\) \{ const fresh = changeMarks\.accept\(snapshot, landed\); void refresh\(projectId\)\.then\(\(\) => \{ if \(currentProject\.current === projectId\) changeMarks\.show\(fresh\); \}\); \} \}\}/);
  const handler = section(app, 'onTaskApplied={', 'onTaskOpenRequests=');
  assert.doesNotMatch(((handler) as unknown as Parameters<typeof assert.doesNotMatch>[0]), /locate|changeMode|scrollIntoView|fitView|setRightDockTab/, 'a new change never moves the view');
  assert.doesNotMatch(app, /highlightAgentTaskChanges|agent-ai-highlight/);
  assert.match(app, /locateAgentTaskChange\(change, changeMarks\);/);
  assert.match(app, /useLayoutEffect\(\(\) => \{ changeMarks\.reset\(\); setTaskReveal\(null\); \}, \[changeMarks, data\.project\?\.id\]\);/);
  assert.match(app, /useLayoutEffect\(\(\) => \{ changeMarks\.clear\(\); \}, \[changeMarks, workspaceMode\]\);/);
  assert.match(app, /useEffect\(\(\) => \(\) => changeMarks\.reset\(\), \[changeMarks\]\);/);
  assert.match(app, /<TargetMarkLayer marks=\{changeMarks\.marks\} label=\{t\('agent\.mark\.label'\)\} ariaLabel=\{t\('agent\.mark\.open'\)\} onActivate=\{revealTaskChange\} \/>/);
  assert.match(app, /taskReveal=\{taskReveal\}/);
});

test('clicking a label opens the Mio tab and asks for its change row without touching selection or the inspector', () => {
  const source = section(app, '  function revealTaskChange(', '  // Reset, not dispose');
  assert.doesNotMatch(((source) as unknown as Parameters<typeof assert.doesNotMatch>[0]), /setSelected|inspect\(|setTab\(|setPropertiesPage|setQuickAssetId|changeMode/);
  const compile = (env: { [s: string]: unknown; }|ArrayLike<unknown>) => Function(...Object.keys(env), `${transformSync(((source) as unknown as Parameters<typeof transformSync>[0]), { loader: 'ts' }).code}\nreturn revealTaskChange;`)(...Object.values(env)) as (target:unknown)=>unknown;
  const run = ({ collapsed = false, narrow = false, application = null, composing = false }: {collapsed?:boolean;narrow?:boolean;application?:{id:string}|null;composing?:boolean} = {}) => {
    const calls: unknown[][] = [], updates: ((previous:{nonce:number;changeId?:string}|null)=>{changeId:string;nonce:number})[] = [];
    const reveal = compile({ application, clipDraftRef: { current: composing ? { hasPendingComposition: () => true } : null }, inspectorCollapsed: collapsed, geometry: { narrow },
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
  for (const blocked of [run({ application: { id: 'candidate' } }), run({ composing: true })]) { assert.deepEqual((blocked.calls as unknown), []); assert.deepEqual((blocked.updates as unknown), []); }
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
