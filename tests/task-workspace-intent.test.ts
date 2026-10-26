import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTaskWorkspaceIntent, navigateTaskShot, type TaskWorkspaceContext, type TaskShotTarget, type TaskShotNavigationActions } from '../apps/web/src/task-workspace-intent.ts';

type Mutable<T> = {-readonly [K in keyof T]: T[K]};
type FixtureContext = Mutable<Omit<TaskWorkspaceContext, 'workspaceScope'>> & {workspaceScope: string | null};
interface Fixture {
  state: FixtureContext | null; visible: boolean; target: Mutable<TaskShotTarget>;
  jobs: {id: string; projectId: string; shots: {id: string}[]}[];
  calls: ('guard' | TaskShotTarget)[]; discarded: number; predicate: (() => boolean) | null;
  gate: ReturnType<typeof held>; actions: TaskShotNavigationActions;
}
const context = () => ({ active: true, projectId: 'project-a', projectEpoch: 0, navigationEpoch: 0, panelIntent: 0, workspaceScope: 'normal' });
const shot = (): Mutable<TaskShotTarget> => ({ projectId: 'project-a', jobId: 'job-a', shotId: 'shot-a', tab: 'settings' });
const held = () => { let resolve!: (value: boolean) => void; const promise = new Promise<boolean>(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture() {
  const f = { state: context(), visible: true, target: shot(), jobs: [
    { id: 'job-a', projectId: 'project-a', shots: [{ id: 'shot-a' }] },
    { id: 'job-b', projectId: 'project-a', shots: [{ id: 'shot-b' }] },
  ], calls: [], discarded: 0, predicate: null, gate: held() } as unknown as Fixture;
  f.actions = {
    readContext: () => f.state as TaskWorkspaceContext,
    isVisible: () => f.visible,
    hasTarget: (target: { projectId: string; jobId: string; shotId: string; }) => f.jobs.some(job => job.projectId === target.projectId && job.id === target.jobId && job.shots.some(item => item.id === target.shotId)),
    guard: async canNavigate => {
      f.calls.push('guard'); f.predicate = canNavigate;
      if (!await f.gate.promise || !canNavigate()) return false;
      f.discarded++;
      return true;
    },
    reveal: target => f.calls.push(target),
  };
  return f;
}

test('capture retains a fixed value snapshot even when the reader reuses a mutable object', () => {
  const state = context(), before = structuredClone(state), current = captureTaskWorkspaceIntent(() => state);
  assert.equal(typeof current, 'function'); assert.equal((current)!(), true);
  assert.deepEqual(state, before); assert.equal(Object.isFrozen(state), false);
  state.panelIntent++; assert.equal((current)!(), false);
});

test('equal replacement context preserves authority and every declared field participates', () => {
  let state = context(); const current = captureTaskWorkspaceIntent(() => state);
  state = { ...state }; assert.equal((current)!(), true);
  for (const [field, value] of Object.entries({ active: false, projectId: 'project-b', projectEpoch: 1,
    navigationEpoch: 1, panelIntent: 1, workspaceScope: 'restored:other' })) {
    state = { ...context(), [field]: value }; assert.equal((current)!(), false, field);
  }
});

test('capture rejects missing, inactive and malformed context without granting a callback', () => {
  const invalid: unknown[] = [null, undefined, [], {}, 'project-a', { ...context(), active: false }, { ...context(), active: 'true' }];
  for (const field of Object.keys(context())) {
    const value = context(); delete (value as Record<string, unknown>)[field]; invalid.push(value);
  }
  for (const field of ['projectId', 'workspaceScope']) {
    for (const value of ['', ' \t ', null, undefined, 1]) invalid.push({ ...context(), [field]: value });
  }
  for (const field of ['projectEpoch', 'navigationEpoch', 'panelIntent']) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) invalid.push({ ...context(), [field]: value });
  }
  for (const value of invalid) assert.equal(captureTaskWorkspaceIntent((() => value) as () => TaskWorkspaceContext), null);
});

test('a previously captured callback refuses an unavailable or malformed live reader result', () => {
  let state: unknown = context(); const current = captureTaskWorkspaceIntent((() => state) as () => TaskWorkspaceContext);
  for (const value of [null, undefined, {}, { ...context(), active: false }, { ...context(), workspaceScope: null }, { ...context(), navigationEpoch: NaN }]) {
    state = value; assert.equal((current)!(), false);
  }
});

for (const tab of ['settings', 'versions'] as const) test(`valid ${tab} navigation discards and synchronously reveals its immutable copied target exactly once`, async () => {
  const f = fixture(); f.target.tab = tab;
  const before = structuredClone({ state: f.state, jobs: f.jobs, target: f.target });
  const pending = navigateTaskShot(f.target, f.actions);
  assert.equal((f.predicate)!(), true); assert.deepEqual(f.calls, ['guard']);
  (f.gate.resolve)!(true); assert.equal(await pending, true);
  assert.equal(f.discarded, 1); assert.equal(f.calls.length, 2);
  const revealed = f.calls[1]; assert.deepEqual(revealed, f.target); assert.notStrictEqual(revealed, f.target);
  assert.equal(Object.isFrozen(revealed), true);
  assert.throws(() => { (revealed as {tab: string}).tab = 'other'; }, TypeError);
  assert.deepEqual({ state: f.state, jobs: f.jobs, target: f.target }, before);
});

test('cancelled confirmation neither discards nor reveals and is never retried', async () => {
  const f = fixture(), pending = navigateTaskShot(f.target, f.actions);
  (f.gate.resolve)!(false); assert.equal(await pending, false);
  assert.equal(f.discarded, 0); assert.deepEqual(f.calls, ['guard']);
});

const invalidations: [string, (f: Fixture) => void][] = [
  ['unmount or inactive view', (f) => { f.state!.active = false; }],
  ['new project', (f) => { f.state!.projectId = 'project-b'; }],
  ['project epoch', (f) => { f.state!.projectEpoch++; }],
  ['project A to B to A', (f) => { f.state!.projectId = 'project-b'; f.state!.projectEpoch++; f.state!.projectId = 'project-a'; f.state!.projectEpoch++; }],
  ['new navigation choice', (f) => { f.state!.navigationEpoch++; }],
  ['panel choice', (f) => { f.state!.panelIntent++; }],
  ['collapsed Tasks panel', (f) => { f.visible = false; f.state!.panelIntent++; }],
  ['hidden Tasks tab', (f) => { f.visible = false; }],
  ['Tasks tab hide and return', (f) => { f.visible = false; f.state!.panelIntent++; f.visible = true; f.state!.panelIntent++; }],
  ['workspace identity', (f) => { f.state!.workspaceScope = 'restored:other'; }],
  ['missing live workspace', (f) => { f.state!.workspaceScope = null; }],
  ['missing live context', (f) => { f.state = null; }],
  ['removed job', (f) => { f.jobs = []; }],
  ['removed shot', (f) => { f.jobs[0]!.shots = []; }],
  ['shot reassigned to another job', f => { f.jobs[1]!.shots.push(f.jobs[0]!.shots.pop()!); }],
  ['job reassigned to another project', (f) => { f.jobs[0]!.projectId = 'project-b'; }],
];
for (const [label, change] of invalidations) test(`held confirmation fences ${label} before the discard boundary and before reveal`, async () => {
  const f = fixture(), pending = navigateTaskShot(f.target, f.actions);
  assert.equal((f.predicate)!(), true); change(f); assert.equal((f.predicate)!(), false);
  (f.gate.resolve)!(true); assert.equal(await pending, false);
  assert.equal(f.discarded, 0, 'the confirmation predicate must be checked before deleting a draft');
  assert.deepEqual(f.calls, ['guard']);
});

test('preflight rejects a hidden view, missing relation or foreign target without invoking guard', async () => {
  for (const change of [(f: Fixture) => { f.visible = false; }, (f: Fixture) => { f.jobs = []; }, (f: Fixture) => { f.state!.active = false; },
(f: Fixture) => { f.state!.workspaceScope = ''; }, (f: Fixture) => { f.target.projectId = 'project-b'; },
(f: Fixture) => { f.target.jobId = 'job-b'; }, (f: Fixture) => { f.target.shotId = 'shot-b'; },
(f: Fixture) => { f.jobs[0]!.projectId = 'project-b'; }]) {
    const f = fixture(); change(f);
    assert.equal(await navigateTaskShot(f.target, f.actions), false);
    assert.equal(f.discarded, 0); assert.deepEqual((f.calls as unknown), []);
  }
});

test('malformed targets are refused before reading context or asking to discard', async () => {
  const invalid: unknown[] = [null, undefined, [], {}, 'shot-a', { ...shot(), tab: 'other' }, { ...shot(), tab: null }];
  for (const field of Object.keys(shot())) { const target = shot(); delete (target as unknown as Record<string, unknown>)[field]; invalid.push(target); }
  for (const field of ['projectId', 'jobId', 'shotId']) {
    for (const value of ['', ' \n ', null, undefined, 1]) invalid.push({ ...shot(), [field]: value });
  }
  for (const target of invalid) {
    const f = fixture(); f.actions.readContext = () => assert.fail('Invalid target must not read context');
    assert.equal(await navigateTaskShot(target as TaskShotTarget, f.actions), false); assert.deepEqual((f.calls as unknown), []);
  }
});

test('caller mutation cannot redirect a pending choice to another job, shot or inspector tab', async () => {
  const f = fixture(), expected = { ...f.target }, pending = navigateTaskShot(f.target, f.actions);
  Object.assign(f.target, { projectId: 'project-b', jobId: 'job-b', shotId: 'shot-b', tab: 'versions' });
  assert.equal((f.predicate)!(), true); (f.gate.resolve)!(true); assert.equal(await pending, true);
  assert.deepEqual(f.calls, ['guard', expected]); assert.equal(f.discarded, 1);
});

for (const [label, change] of invalidations) test(`a guard returning true cannot bypass the final ${label} check`, async () => {
  const f = fixture();
  f.actions.guard = async (canNavigate: () => unknown) => { f.calls.push('guard'); assert.equal(canNavigate(), true); change(f); return true; };
  assert.equal(await navigateTaskShot(f.target, f.actions), false); assert.deepEqual(f.calls, ['guard']);
});

test('a newer held choice wins even if both confirmations eventually return true', async () => {
  const f = fixture(), firstGate = f.gate, first = navigateTaskShot(f.target, f.actions), firstPredicate = f.predicate;
  f.state!.navigationEpoch++; f.gate = held();
  const secondTarget: TaskShotTarget = { ...shot(), jobId: 'job-b', shotId: 'shot-b', tab: 'versions' };
  const second = navigateTaskShot(secondTarget, f.actions);
  assert.equal((firstPredicate)!(), false); assert.equal((f.predicate)!(), true);
  (f.gate.resolve)!(true); assert.equal(await second, true);
  (firstGate.resolve)!(true); assert.equal(await first, false);
  assert.equal(f.discarded, 1); assert.deepEqual(f.calls, ['guard', 'guard', secondTarget]);
});

test('guard failure is propagated without a reveal or automatic retry', async () => {
  const f = fixture(), failure = new Error('Confirmation unavailable');
  f.actions.guard = async () => { f.calls.push('guard'); throw failure; };
  await assert.rejects(navigateTaskShot(f.target, f.actions), error => error === failure);
  assert.deepEqual(f.calls, ['guard']);
});
