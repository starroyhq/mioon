import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { timelineHistoryState } from '../apps/web/src/timeline-history.js';
import { timelineHistoryActionForKey } from '../apps/web/src/timeline-keyboard.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = (id, operation = 'timeline.clip.update') => ({ id, operation, createdAt: '2026-10-09T12:00:00.000Z' });
const fixture = () => ({
  projectId: 'project-one', timeline: { id: 'timeline-one', revision: 7 },
  history: { projectId: 'project-one', timelineId: 'timeline-one', revision: 7, cursor: 2, length: 3, canUndo: true, canRedo: true, undoEntry: entry('undo'), redoEntry: entry('redo', 'timeline.clip.remove') },
});
const keyEvent = patch => ({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false, target: null, ...patch });
// DOM-like targets keep shortcut classification testable without browser globals.
const targetMatching = expected => ({ closest(selector) { assert.ok(selector.includes(expected), expected); return this; } });

test('coherent history exposes current counts and operation labels', () => {
  assert.deepEqual(timelineHistoryState(fixture()), { synced: true, cursor: 2, length: 3, canUndo: true, canRedo: true, undoLabel: '修改片段', redoLabel: '移除片段', blockedReason: '' });
});

test('beginning and end of history enable only possible traversal', () => {
  const state = fixture();
  Object.assign(state.history, { cursor: 0, canUndo: false, undoEntry: null });
  assert.equal(timelineHistoryState(state).canUndo, false);
  assert.equal(timelineHistoryState(state).canRedo, true);
  Object.assign(state.history, { cursor: 3, canUndo: true, undoEntry: entry('undo'), canRedo: false, redoEntry: null });
  assert.equal(timelineHistoryState(state).canUndo, true);
  assert.equal(timelineHistoryState(state).canRedo, false);
});

test('empty timelines and projects without a timeline have inert, readable history', () => {
  const state = fixture();
  Object.assign(state.history, { cursor: 0, length: 0, canUndo: false, canRedo: false, undoEntry: null, redoEntry: null });
  assert.equal(timelineHistoryState(state).synced, true);
  assert.equal(timelineHistoryState(state).canUndo, false);
  state.timeline = null;
  Object.assign(state.history, { timelineId: null, revision: null });
  assert.equal(timelineHistoryState(state).synced, true);
  assert.equal(timelineHistoryState(state).canRedo, false);
  assert.equal(timelineHistoryState({ ...state, projectId: null }).synced, false);
});

test('missing, cross-project, cross-timeline, stale and malformed history fail closed', () => {
  for (const patch of [null, { projectId: 'another-project' }, { timelineId: 'another-timeline' }, { revision: 6 }, { revision: 8 }, { revision: '7' }, { cursor: -1 }, { cursor: 4 }, { cursor: 1.5 }, { length: NaN }, { length: Infinity }, { length: Number.MAX_SAFE_INTEGER + 1 }, { canUndo: false }, { canRedo: false }, { undoEntry: null }, { redoEntry: null }]) {
    const state = fixture();
    state.history = patch === null ? null : { ...state.history, ...patch };
    const result = timelineHistoryState(state);
    assert.equal(result.synced, false, JSON.stringify(patch));
    assert.equal(result.canUndo, false);
    assert.equal(result.canRedo, false);
    assert.equal(result.cursor, null);
    assert.equal(result.length, null);
  }
});

test('mutation, uncertain recovery, unsaved drafts and offline state disable both controls', () => {
  for (const [patch, message] of [[{ busy: true }, /正在同步/], [{ pending: true }, /待确认/], [{ dirty: true }, /保存或放弃/], [{ online: false }, /连接中断/]]) {
    const result = timelineHistoryState({ ...fixture(), ...patch });
    assert.equal(result.synced, true);
    assert.equal(result.cursor, 2);
    assert.equal(result.canUndo, false);
    assert.equal(result.canRedo, false);
    assert.match(result.blockedReason, message);
  }
});

test('unknown operation labels remain readable without surfacing raw operation names', () => {
  const state = fixture();
  state.history.undoEntry.operation = 'future.operation';
  assert.equal(timelineHistoryState(state).undoLabel, '时间线编辑');
});

test('keyboard shortcuts support Control/Command Z, shifted Z and Control Y', () => {
  assert.equal(timelineHistoryActionForKey(keyEvent()), 'undo');
  assert.equal(timelineHistoryActionForKey(keyEvent({ ctrlKey: false, metaKey: true })), 'undo');
  assert.equal(timelineHistoryActionForKey(keyEvent({ key: 'Z', shiftKey: true })), 'redo');
  assert.equal(timelineHistoryActionForKey(keyEvent({ key: 'Z', ctrlKey: false, metaKey: true, shiftKey: true })), 'redo');
  assert.equal(timelineHistoryActionForKey(keyEvent({ key: 'y' })), 'redo');
  assert.equal(timelineHistoryActionForKey(keyEvent({ key: 'Y' })), 'redo');
});

test('unrelated, repeated, composing, modified or already-handled keys are ignored', () => {
  for (const patch of [{ key: 'x' }, { key: 'Enter' }, { key: undefined }, { ctrlKey: false }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { key: 'y', ctrlKey: false, metaKey: true }, { key: 'y', shiftKey: true }]) {
    assert.equal(timelineHistoryActionForKey(keyEvent(patch)), null, JSON.stringify(patch));
  }
  assert.equal(timelineHistoryActionForKey(keyEvent(), { modalOpen: true }), null);
});

test('native input, editable, popup and modal targets retain their own keyboard actions', () => {
  for (const selector of ['input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])', '[role="textbox"]', '[role="searchbox"]', '[role="spinbutton"]', '[role="combobox"]', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[role="menu"]', '[role="listbox"]']) {
    assert.equal(timelineHistoryActionForKey(keyEvent({ target: targetMatching(selector) })), null, selector);
  }
  assert.equal(timelineHistoryActionForKey(keyEvent({ target: { isContentEditable: true } })), null);
  assert.equal(timelineHistoryActionForKey(keyEvent({ target: { parentElement: targetMatching('textarea') } })), null);
  assert.equal(timelineHistoryActionForKey(keyEvent({ target: { closest: () => null } })), 'undo');
});

test('shadow DOM paths and focused editors are guarded even when the event target is a host', () => {
  assert.equal(timelineHistoryActionForKey(keyEvent({ composedPath: () => [{ isContentEditable: true }, {}] })), null);
  assert.equal(timelineHistoryActionForKey(keyEvent({ target: { ownerDocument: { activeElement: targetMatching('input') } } })), null);
});

test('history controls render shared Base UI buttons with disabled states, labels and shortcuts', () => {
  const fixtureSource = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import TimelineHistoryControls from './src/TimelineHistoryControls.jsx';
    export const ready = renderToStaticMarkup(<TimelineHistoryControls state={${JSON.stringify(timelineHistoryState(fixture()))}} onHistory={() => {}} />);
    export const pending = renderToStaticMarkup(<TimelineHistoryControls state={${JSON.stringify(timelineHistoryState({ ...fixture(), pending: true }))}} busy onHistory={() => {}} />);
  `;
  const script = `
    import { build } from 'esbuild';
    import assert from 'node:assert/strict';
    const { outputFiles } = await build({ stdin: { contents: ${JSON.stringify(fixtureSource)}, loader: 'jsx', resolveDir: ${JSON.stringify(resolve(root, 'apps/web'))} }, bundle: true, format: 'esm', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '\"production\"' } });
    const { ready, pending } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    assert.equal((ready.match(/<button/g) || []).length, 2);
    assert.equal((ready.match(/data-slot="button"/g) || []).length, 2);
    assert.ok(ready.includes('aria-label="撤销时间线：修改片段"'));
    assert.ok(ready.includes('aria-label="重做时间线：移除片段"'));
    assert.ok(ready.includes('aria-keyshortcuts="Control+Z Meta+Z"'));
    assert.ok(ready.includes('aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"'));
    assert.ok(ready.includes('时间线历史：已应用 2 步，共 3 步'));
    assert.ok(!ready.includes(' disabled=""'));
    assert.equal((pending.match(/ disabled=""/g) || []).length, 2);
    assert.ok(pending.includes('aria-busy="true"'));
    assert.ok(pending.includes('上一条时间线操作待确认'));
    process.stdout.write('Timeline history controls verified'); process.exit(0);
  `;
  assert.match(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30_000 }), /controls verified/);
});

test('App invalidates history around mutation dispatch and uses the common refresh/recovery path', () => {
  const source = readFileSync(resolve(root, 'apps/web/src/App.jsx'), 'utf8');
  assert.match(source, /invalidateHistory\(\);\s*dispatched = true;\s*const result = await rpc\(operation, input\);\s*invalidateHistory\(\);/);
  assert.match(source, /if \(dispatched\) invalidateHistory\(\);/);
  assert.match(source, /\+\+requestCounter\.current;\s*dataRef\.current = \{ \.\.\.dataRef\.current, timelineHistory: null \}/);
  assert.match(source, /return mutateTimeline\(`timeline\.\$\{direction\}`\)/);
  assert.match(source, /history: data\.timelineHistory/);
  assert.match(source, /document\.querySelector\('\[role="dialog"\], \[role="alertdialog"\], \[aria-modal="true"\]'\)/);
});
