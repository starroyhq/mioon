import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('the canvas fit options are one stable object, so a re-render never replaces the options of a waiting fit', () => {
  assert.match(app, /^const CANVAS_INITIAL_FIT: FitViewOptions = \{ padding: 0\.16, minZoom: \.65, maxZoom: 1 \};$/m);
  assert.match(app, /fitViewOptions=\{CANVAS_INITIAL_FIT\}/);
  assert.doesNotMatch(app, /fitViewOptions=\{\{/);
  // Selecting from the storyboard strip frames the shot with the strip's own options.
  assert.match(app, /onSelect=\{async shotId => \{ if \(!await inspect\(shotId\)\) return; flow\.fitView\(\{ nodes: \[\{ id: shotId \}\]/);
});

test('the canvas editing control floats over the canvas and only the control takes pointer input', () => {
  assert.match(css, /\.agent-editing-canvas\{position:absolute;inset:0;pointer-events:none\}/);
  assert.match(css, /\.agent-editing-canvas>\.agent-editing-protection\{position:absolute;z-index:5;[^}]*;pointer-events:auto\}/);
  assert.doesNotMatch(css, /\.agent-editing-canvas\{position:relative/, 'the boundary no longer wraps the canvas');
});
