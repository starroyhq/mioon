import assert from 'node:assert/strict';
import test from 'node:test';
import {canvasSelectionTargets, canvasShortcut, supportsCanvasEditing, toggleCanvasSelection} from '../apps/web/src/canvas-selection.ts';
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
