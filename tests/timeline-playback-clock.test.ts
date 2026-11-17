import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createTimelinePlaybackClock} from '../apps/web/src/timeline-playback-clock.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';
import {evaluateExpression} from './helpers/eval-source.ts';

function appExpression<T>(source: string, expression: string, env: Record<string, unknown>): T {
  return evaluateExpression<T>(source, expression, Object.keys(env), Object.values(env));
}

const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function appSection(start: string, end: string): string {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

test('subscriptions follow one active media binding and skip duplicate or retired frames', () => {
  const clock = createTimelinePlaybackClock(), first = {}, replacement = {};
  const frames: (number | null)[] = [];
  const unsubscribe = clock.subscribe(() => frames.push(clock.getSnapshot()));
  clock.start(first, 10);
  clock.tick(first, 10);
  clock.tick(first, 12);
  clock.start(replacement, 12);
  clock.tick(first, 13);
  assert.equal(clock.stop(first), false);
  clock.tick(replacement, 14);
  assert.equal(clock.stop(replacement), true);
  assert.equal(clock.stop(replacement), false);
  clock.start(first, 22);
  clock.seek(0, true);
  assert.equal(clock.getSeekRevision(), 0, 'a destination media binding is restored through saved state');
  assert.equal(clock.getSeekFrame(), null);
  assert.equal(clock.stop(first), false, 'the previous media cannot settle after a binding-changing seek');
  unsubscribe();
  clock.start(replacement, 23);
  assert.deepEqual(frames, [10, 12, 14, null, 22, null]);
});

test('actual App only writes back when the native playhead settles or the user seeks', () => {
  const clock = createTimelinePlaybackClock(), owner = {};
  const currentProject = {current: 'project'}, projectEpoch = {current: 1};
  const viewRef = {current: defaultWorkspaceState()};
  const viewWrites: number[] = [], prefs: {frame: number; immediate: boolean}[] = [];
  const app = appExpression<{seek(frame: number): void; settle(frame: number): void; locate(frame: number): void}>(
    appSection('  const updateView = useCallback(', '  const { selectedId,'),
    `({seek: field("editing", "playhead"), settle: field("editing", "playhead", true),
      locate: playhead => updateView("editing", {playhead, previewKind: "source", selectedClipId: "clip"})})`, {
      useCallback: (fn: unknown) => fn, playbackClock: clock, currentProject, projectEpoch, viewRef,
      viewReady: {current: true}, dataRef: {current: {project: {id: 'project'}}},
      clipDraftRef: {current: null}, clipLoudnessEpoch: {current: 0},
      setView: (view: ReturnType<typeof defaultWorkspaceState>) => viewWrites.push(view.editing.playhead),
      preferencesRef: {current: {update(project: string, view: ReturnType<typeof defaultWorkspaceState>, {immediate}: {immediate: boolean}) {
        assert.equal(project, 'project');
        prefs.push({frame: view.editing.playhead, immediate});
      }}},
    });
  clock.start(owner, 0);
  for (let frame = 1; frame <= 77; frame++) clock.tick(owner, frame);
  assert.deepEqual(viewWrites, []);
  assert.deepEqual(prefs, []);
  assert.equal(clock.getSeekRevision(), 0);

  if (clock.stop(owner)) app.settle(79);
  if (clock.stop(owner)) app.settle(79);
  assert.deepEqual(viewWrites, [79]);
  assert.deepEqual(prefs, [{frame: 79, immediate: false}]);
  assert.equal(clock.getSeekRevision(), 0, 'pause has no native seek echo');

  clock.start(owner, 79);
  clock.tick(owner, 90);
  app.seek(79);
  assert.equal(clock.getSnapshot(), 79);
  assert.equal(clock.getSeekFrame(), 79);
  assert.equal(clock.getSeekRevision(), 1, 'seeking to the saved frame still reaches the live player');
  app.seek(120);
  assert.deepEqual(viewWrites, [79, 120]);
  assert.deepEqual(prefs, [{frame: 79, immediate: false}, {frame: 120, immediate: false}]);
  app.locate(150);
  assert.equal(clock.getSnapshot(), null);
  assert.deepEqual(prefs.at(-1), {frame: 150, immediate: false}, 'the viewport scroll and locate share the debounce');
  projectEpoch.current++;
  app.settle(151);
  assert.equal(viewRef.current.editing.playhead, 150, 'a retired preview cannot save into a reopened project');
});

test('pending workspace preferences stay out of the topbar draft state', () => {
  const status = appSection('  const saveIsDirty=', '  const saveFailed=');
  for (const pending of [false, true]) {
    for (const contentDirty of ['inspector', 'format', 'annotations', null]) {
      const result = appExpression(status, '({saveIsDirty, historyHasPendingEdits})', {
        inspectorDirty: contentDirty === 'inspector', formatDirty: contentDirty === 'format',
        annotations: {state: {dirtyCount: Number(contentDirty === 'annotations')}},
        preferenceStatus: {pending},
      });
      assert.deepEqual(result, {saveIsDirty: contentDirty !== null, historyHasPendingEdits: contentDirty !== null || pending});
    }
  }
});
