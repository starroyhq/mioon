import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {evaluateExpression, extractBetween} from './helpers/eval-source.ts';
import {i18nTestModule, translate} from './helpers/i18n.ts';
import type {ComponentProps} from 'react';
import type {CanvasEditToast, CanvasSelectionMenu} from '../apps/web/src/CanvasEditingControls.tsx';
import type {Locale} from '../packages/i18n/src/index.ts';

const read = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const app = read('App.tsx'), css = read('agent-task-v2.css'), scale = read('viewport-scale.css');

test('the canvas stays outside the editing boundary keyed by the selection, so selecting never remounts it', () => {
  const start = app.indexOf('<div className="flow-wrap" data-testid="canvas-drop-zone"'), end = app.indexOf('</ReactFlow>', start);
  assert.ok(start > 0 && end > start, 'the canvas drop zone renders the canvas');
  const canvas = app.slice(start, end);
  // The boundary renders only its editing control, before the canvas so the control keeps its place in the tab order.
  assert.match(canvas, /<AgentEditingBoundary [^\n]*controlsOnly[^\n]*>\{null\}<\/AgentEditingBoundary><ReactFlow key=\{data\.project\?\.id \|\| 'empty'\}/);
  assert.doesNotMatch(canvas, /\{\(\) => <ReactFlow/, 'a canvas rendered by the boundary would be keyed with it');
  assert.ok(app.startsWith('</ReactFlow>\n', end), 'the canvas closes as a direct child of the drop zone');
  // The inverse UI-scale zoom only reaches the canvas as a direct child of the drop zone.
  assert.match(scale, /\.flow-wrap > \.react-flow \{ zoom: calc\(1 \/ var\(--mioon-ui-scale\)\); \}/);
});

test('the initial fit waits for measured nodes and saved viewports bypass it', () => {
  assert.match(app, /const measured = useNodesInitialized\(\)/);
  assert.match(app, /if \(fitted.current \|\| !measured \|\| !flow.viewportInitialized\) return/);
  assert.match(app, /flow.setViewport\(getViewportForBounds\(bounds, pane.offsetWidth, pane.offsetHeight, 0\.2, 1,/);
  assert.match(app, /defaultViewport=\{view.canvas.viewport \|\| \{ x: 0, y: 0, zoom: 1 \}\}/);
  assert.match(app, /const fitted = useRef\(!hasContent\)/);
  assert.match(app, /\{!view.canvas.viewport && <InitialCanvasFit nodes=\{nodes\} hasContent=\{data.shots.length \+ data.nodes.length > 0\} \/>\}/);
  assert.doesNotMatch(app, /fitViewOptions=|\bfitView=|\bonInit=\{instance/);
  // Selecting from the storyboard strip frames the shot with the strip's own options.
  assert.match(app, /onSelect=\{async shotId => \{ if \(!await inspect\(shotId\)\) return; flow\.fitView\(\{ nodes: \[\{ id: shotId \}\]/);
});

test('the canvas editing control floats over the canvas and only the control takes pointer input', () => {
  assert.match(css, /\.agent-editing-canvas\{position:absolute;inset:0;pointer-events:none\}/);
  assert.match(css, /\.agent-editing-canvas>\.agent-editing-protection\{position:absolute;z-index:5;[^}]*;pointer-events:auto\}/);
  assert.doesNotMatch(css, /\.agent-editing-canvas\{position:relative/, 'the boundary no longer wraps the canvas');
});

interface ControlElement {
  readonly type: string;
  readonly props: {readonly disabled?: boolean; readonly content?: string; readonly 'data-testid'?: string;
    readonly onClick?: (event: ControlEvent) => void; readonly onKeyDown?: (event: ControlEvent) => void};
  readonly children: readonly ControlChild[];
}
type ControlChild = ControlElement | string | readonly ControlChild[] | null;
interface ControlEvent {
  readonly nativeEvent: Pick<Event, 'isTrusted'>;
  readonly key?: string;
  readonly repeat?: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
function elements(child: ControlChild): ControlElement[] {
  if (child === null || typeof child !== 'object') return [];
  if (!('type' in child)) return child.flatMap(elements);
  return [child, ...child.children.flatMap(elements)];
}
function controls(locale: Locale) {
  const source = read('CanvasEditingControls.tsx');
  const menu = extractBetween(source, 'export function CanvasSelectionMenu(', 'export function CanvasDeleteDialog(');
  const toast = source.slice(source.indexOf('export function CanvasEditToast('));
  const components = ['WorkbenchContextMenu', 'DropdownMenuItem', 'DropdownMenuSeparator', 'WorkbenchTooltip',
    'WorkbenchButton', 'Copy', 'ClipboardPaste', 'CopyPlus', 'Grid2X2', 'Trash2', 'X'];
  const react = {createElement: (type: string, props: ControlElement['props'] | null, ...children: ControlChild[]) => ({type, props: props ?? {}, children})};
  return evaluateExpression<{CanvasSelectionMenu(props: ComponentProps<typeof CanvasSelectionMenu>): ControlElement;
    CanvasEditToast(props: ComponentProps<typeof CanvasEditToast>): ControlElement}>(
    menu.replace('export ', '') + toast.replace('export ', ''), '{CanvasSelectionMenu, CanvasEditToast}',
    ['React', 'useI18n', 'useId', 'canvasEditMacShortcuts', 'useStoryboardClearance', ...components],
    [react, i18nTestModule(locale).useI18n, () => 'reason', () => false, () => ({}), ...components]);
}

test('canvas clipboard menu passes trusted click and keyboard gestures once and shows the disabled reason', () => {
  const {CanvasSelectionMenu: menu} = controls('zh-Hans');
  const calls: string[] = [];
  const blocked = translate('zh-Hans', 'canvas.edit.clipboard.linksOnly');
  const tree = menu({
    anchor: {x: 0, y: 0}, onClose: () => calls.push('close'), onArchive() {}, onTidy() {}, canArchive: true, canTidy: true,
    copy: () => calls.push('copy'), paste: () => calls.push('paste'), duplicate: () => calls.push('duplicate'),
    duplicateDisabledReason: blocked,
  });
  const items = elements(tree), item = (name: string) => items.find(node => node.props['data-testid'] === `canvas-menu-${name}`)!;
  const gesture = (isTrusted: boolean, key?: string): ControlEvent => ({
    nativeEvent: {isTrusted}, key, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, stopPropagation() {},
  });
  assert.equal(item('duplicate').props.disabled, true);
  const hint = items.find(node => node.type === 'WorkbenchTooltip' && node.props.content === blocked);
  assert.ok(hint?.children.includes(item('duplicate')));
  item('duplicate').props.onClick?.(gesture(true));
  item('copy').props.onClick?.(gesture(false));
  item('copy').props.onClick?.(gesture(true));
  const enter = gesture(true, 'Enter');
  item('paste').props.onKeyDown?.(enter);
  assert.equal(enter.defaultPrevented, true);
  item('paste').props.onClick?.(gesture(false));
  assert.deepEqual(calls, ['close', 'copy', 'close', 'paste']);
});

test('clipboard result text follows all four locales and only paste and duplicate offer Undo', () => {
  const locales = ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const;
  const toasts = {copy: 'canvas.edit.copiedToast', paste: 'canvas.edit.pastedToast', duplicate: 'canvas.edit.duplicatedToast'} as const;
  for (const locale of locales) {
    const {CanvasEditToast: toast} = controls(locale);
    for (const kind of ['copy', 'paste', 'duplicate'] as const) {
      const tree = toast({kind, count: 2, placement: 'canvas', canUndo: true, onUndo() {}, onClose() {}});
      const nodes = elements(tree);
      assert.ok(nodes.some(node => node.children.includes(translate(locale, toasts[kind], {count: 2}))));
      assert.equal(nodes.some(node => node.props['data-testid'] === 'canvas-edit-toast-undo'), kind !== 'copy');
    }
  }
});
