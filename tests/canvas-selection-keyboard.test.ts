import assert from 'node:assert/strict';
import test from 'node:test';
import {canvasGroupMoves, canvasOwnsShortcutFocus, canvasSelectionTargets, canvasShortcut, supportsCanvasEditing, toggleCanvasSelection} from '../apps/web/src/canvas-selection.ts';
import type {CanvasEditBase} from '../packages/contracts/src/canvas-editing.ts';

const base = {contentSequence: 5, contentToken: 'a'.repeat(32), targets: [
  {kind: 'shot', id: 'shot', revision: 1},
  {kind: 'node', id: 'image', revision: 2},
  {kind: 'node', id: 'text', revision: 3},
  {kind: 'edge', id: 'decor', revision: 0},
]} satisfies CanvasEditBase;

test('the selection requires both format 4 and canvas edit capability', () => {
  assert.equal(supportsCanvasEditing(3, base), false);
  assert.equal(supportsCanvasEditing(4, undefined), false);
  assert.equal(supportsCanvasEditing(undefined, base), false);
  assert.equal(supportsCanvasEditing(4, base), true);
});

test('Shift toggles across card types without mutating the prior selection or admitting deleted records', () => {
  const selected = new Set(['shot']);
  const withImage = toggleCanvasSelection(selected, 'image');
  const withText = toggleCanvasSelection(withImage, 'text');
  assert.deepEqual([...selected], ['shot']);
  assert.deepEqual([...withText], ['shot', 'image', 'text']);
  assert.deepEqual([...toggleCanvasSelection(withText, 'image')], ['shot', 'text']);
  assert.deepEqual(canvasSelectionTargets(base, new Set([...withText, 'hidden']), null),
    [{kind: 'shot', id: 'shot'}, {kind: 'node', id: 'image'}, {kind: 'node', id: 'text'}]);
  assert.deepEqual(canvasSelectionTargets(base, new Set(), 'decor'), [{kind: 'edge', id: 'decor'}]);
});

const ready = {blocked: false, composing: false, textFocus: false, nativeHistory: false};
const event = (key: string, more: Partial<Parameters<typeof canvasShortcut>[0]> = {}) => ({
  key, defaultPrevented: false, repeat: false, isComposing: false, keyCode: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...more,
});

test('both platform modifier keys work, and native menus own desktop undo and redo', () => {
  for (const modifier of [{ctrlKey: true}, {metaKey: true}]) {
    assert.equal(canvasShortcut(event('a', modifier), ready), 'all');
    assert.equal(canvasShortcut(event('z', modifier), ready), 'undo');
    assert.equal(canvasShortcut(event('Z', {...modifier, shiftKey: true}), ready), 'redo');
    assert.equal(canvasShortcut(event('L', {...modifier, shiftKey: true}), ready), 'tidy');
    assert.equal(canvasShortcut(event('z', modifier), {...ready, nativeHistory: true}), undefined);
    assert.equal(canvasShortcut(event('c', modifier), ready), undefined);
    assert.equal(canvasShortcut(event('v', modifier), ready), undefined);
    assert.equal(canvasShortcut(event('d', modifier), ready), undefined);
  }
  assert.equal(canvasShortcut(event('Backspace'), ready), 'archive');
  assert.equal(canvasShortcut(event('Delete'), ready), 'archive');
  assert.equal(canvasShortcut(event('Escape'), ready), 'clear');
});

test('text, composition and modal focus keep all canvas shortcuts unhandled', () => {
  const keys = [event('a', {ctrlKey: true}), event('Z', {metaKey: true, shiftKey: true}),
    event('L', {metaKey: true, shiftKey: true}), event('Delete'), event('Escape')];
  for (const key of keys) {
    for (const gate of [{blocked: true}, {composing: true}, {textFocus: true}]) {
      assert.equal(canvasShortcut(key, {...ready, ...gate}), undefined);
    }
    for (const patch of [{keyCode: 229}, {isComposing: true}, {repeat: true}, {defaultPrevented: true}]) {
      assert.equal(canvasShortcut({...key, ...patch}, ready), undefined);
    }
  }
});

test('the App suppresses Delete while a newer selection is pending or still unpainted', async () => {
  const {readFileSync} = await import('node:fs');
  const {transformSync} = await import('esbuild');
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const selectionStart = source.indexOf('  function beginCanvasSelection()');
  const selectionEnd = source.indexOf('  function canvasNodesChange(', selectionStart);
  const archiveStart = source.indexOf('  async function archiveCanvasSelection()');
  const archiveEnd = source.indexOf('  async function tidyCanvas()', archiveStart);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart && archiveStart >= 0 && archiveEnd > archiveStart);
  const calls: unknown[] = [];
  const gate = Promise.withResolvers<boolean>();
  const code = transformSync(source.slice(selectionStart, selectionEnd) + source.slice(archiveStart, archiveEnd),
    {loader: 'ts', format: 'cjs'}).code;
  // Mirror the App's state publication so the old event handler can be invoked
  // before the click settles and again while React still displays its old view.
  const fixture = Function('base', 'gate', 'calls', `
    let renderedCanvasSelection = 0, canvasTargets = [{kind:'shot', id:'shot'}];
    const canvasSelectionIntent = {current:0}, canvasSelectionPending = {current:null},
      canvasSelectionRevision = {current:0}, canvasBox = {current:null};
    const dataRef = {current:{canvasEditBase:base}}, viewRef = {current:{activeMode:'canvas'}};
    const canvasEditingWritable = true, selectedCanvasEdge = null, selectedDecorEdge = null, dragging = {current:false};
    const canvasOwner = {isCurrent:() => true}, canvasEditing = {archiveSelection: targets => calls.push(targets)};
    const guardNavigation = () => gate.promise, msg = value => value;
    const setCanvasGroup = () => {}, setStoryboardBatch = () => {}, setCanvasContextMenu = () => {};
    const setPropertiesPage = () => {}, setRightDockTab = () => {}, leaveReferencePage = () => {}, updateView = () => {};
    const canvasEditingScope = '', navigationEpoch = {current:0};
    function commitCanvasSelection() {canvasSelectionRevision.current++;}
    ${code}
    return {selectCanvasCards, archiveCanvasSelection, render(ids) {
      canvasTargets = [...ids].map(id => ({kind:id === 'shot' ? 'shot' : 'node', id}));
      renderedCanvasSelection = canvasSelectionRevision.current;
    }};
  `)(base, gate, calls) as {
    selectCanvasCards(ids: Set<string>): Promise<boolean>; archiveCanvasSelection(): Promise<void>; render(ids: Set<string>): void;
  };
  const nextIds = new Set(['shot', 'image']);
  const pending = fixture.selectCanvasCards(nextIds);
  await fixture.archiveCanvasSelection();
  assert.deepEqual(calls, []);
  gate.resolve(true);
  assert.equal(await pending, true);
  await fixture.archiveCanvasSelection();
  assert.deepEqual(calls, []);
  fixture.render(nextIds);
  await fixture.archiveCanvasSelection();
  assert.deepEqual(calls, [[{kind:'shot', id:'shot'}, {kind:'node', id:'image'}]]);
});


test('canvas shortcuts yield to other panels and to an open archive popover', () => {
  const body = {}, html = {}, node = {}, outsideButton = {};
  let focus: unknown = null, popovers: unknown[] = [];
  const area = {contains: (element: unknown) => element === node} as HTMLElement;
  const doc = {body, documentElement: html, get activeElement() { return focus; }, querySelectorAll: () => popovers} as unknown as Document;
  for (const element of [null, body, html, node]) {
    focus = element;
    assert.equal(canvasOwnsShortcutFocus(area, doc), true);
  }
  focus = outsideButton;
  assert.equal(canvasOwnsShortcutFocus(area, doc), false);
  focus = body;
  popovers = [{closest: () => null}];
  assert.equal(canvasOwnsShortcutFocus(area, doc), false);
  popovers = [{closest: () => ({})}];
  assert.equal(canvasOwnsShortcutFocus(area, doc), true);
});

test('group drag translates every selected target by the same amount and refuses partial movement', () => {
  const targets = [{kind: 'shot', id: 'shot'}, {kind: 'node', id: 'image'}] as const;
  const starting = new Map([['shot', {x: 12.2, y: 24.2}], ['image', {x: 30.6, y: 45.4}]]);
  const moved = [{id: 'shot', position: {x: 24.2, y: 48.2}}, {id: 'image', position: {x: 43, y: 69}}];
  assert.deepEqual(canvasGroupMoves(targets, starting, moved, 'shot'), [
    {kind: 'shot', id: 'shot', position: {x: 24.2, y: 48.2}},
    {kind: 'node', id: 'image', position: {x: 42.6, y: 69.4}},
  ]);
  assert.deepEqual(canvasGroupMoves(targets, starting, [moved[0]!], 'shot'), []);
  assert.deepEqual(canvasGroupMoves(targets, starting, moved, 'removed'), []);
});

test('the format 3 renderer keeps ordinary click, pan and edge keys without exposing canvas editing gestures', async () => {
  const {readSource, evaluateExpression} = await import('./helpers/eval-source.ts');
  const {fileURLToPath} = await import('node:url');
  const ts = (await import('typescript')).default;
  const source = readSource(fileURLToPath(new URL('../apps/web/src/App.tsx', import.meta.url)));
  const syntax = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expectedProps = new Set([
    'onNodeClick', 'onNodeContextMenu', 'onSelectionContextMenu', 'onSelectionStart', 'onSelectionEnd',
    'selectionOnDrag', 'panOnDrag', 'deleteKeyCode', 'disableKeyboardA11y',
  ]);
  let propsSource = '';
  function find(node: import('typescript').Node): void {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(syntax) === 'ReactFlow') {
      propsSource = node.attributes.properties.filter(prop =>
        ts.isJsxAttribute(prop) && expectedProps.has(prop.name.getText(syntax))).map(prop => prop.getText(syntax)).join('\n');
    }
    ts.forEachChild(node, find);
  }
  find(syntax);
  assert.equal(propsSource.split('\n').filter(line => /^\w+=/.test(line)).length, expectedProps.size);
  const clicks: unknown[] = [];
  const reject = () => assert.fail('Format 3 entered a format 4 gesture');
  type CanvasProps = {
    onNodeClick(event: {shiftKey: boolean}, node: {id: string}): void; onNodeContextMenu?: unknown;
    onSelectionContextMenu?: unknown; onSelectionStart?: unknown; onSelectionEnd?: unknown;
    selectionOnDrag: boolean; panOnDrag: boolean; deleteKeyCode: readonly string[]; disableKeyboardA11y: boolean;
  };
  const props = evaluateExpression<{props: CanvasProps}>('', `<ReactFlow ${propsSource} />`,
    ['React', 'ReactFlow', 'canvasEditingEnabled', 'previsOpen', 'inspect', 'selectCanvasCards', 'openCanvasMenu'],
    [{createElement: (_name: string, props: CanvasProps) => ({props})}, 'ReactFlow', supportsCanvasEditing(3, base), false,
      (id: string) => clicks.push(id), reject, reject]).props;
  props.onNodeClick({shiftKey: false}, {id: 'first'});
  props.onNodeClick({shiftKey: true}, {id: 'second'});
  assert.deepEqual(clicks, ['first', 'second']);
  assert.equal(props.onNodeContextMenu, undefined);
  assert.equal(props.onSelectionContextMenu, undefined);
  assert.equal(props.onSelectionStart, undefined);
  assert.equal(props.onSelectionEnd, undefined);
  assert.equal(props.selectionOnDrag, false);
  assert.equal(props.panOnDrag, true);
  assert.deepEqual(props.deleteKeyCode, ['Backspace', 'Delete']);
  assert.equal(props.disableKeyboardA11y, false);
});
