import type {ProjectOpenAttempt, ProjectOpenObservation} from '../apps/web/src/project-open-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, hasProjectResponseOriginMismatch, projectOpenFailureKind } from '../apps/web/src/project-open-state.ts';

const projectA = '00000000-0000-4000-8000-000000000001';
const projectB = '00000000-0000-4000-8000-000000000002';
const workspaceA = `normal:${'a'.repeat(64)}`;
const workspaceB = `normal:${'b'.repeat(64)}`;
const attempt = (patch: Partial<ProjectOpenAttempt> = {}) => projectOpenAttempt(patch.projectId ?? projectA, patch.epoch ?? 3, patch.workspaceScope ?? workspaceA);
const observation = (patch: Record<string, unknown> = {}) => ({ active: true, currentProjectId: projectA, epoch: 3,
  workspaceScope: workspaceA, preferencesReady: true, dataProjectId: projectA, loading: false, ...patch } as {-readonly [K in keyof ProjectOpenObservation]: ProjectOpenObservation[K]});

test('project-open captures an immutable project, epoch, and workspace identity', () => {
  const ticket = attempt();
  assert.deepEqual(ticket, { projectId: projectA, epoch: 3, workspaceScope: workspaceA });
  assert.equal(Object.isFrozen(ticket), true);
  for (const [key, value] of [['projectId', projectB], ['epoch', 4], ['workspaceScope', workspaceB]] as const) {
    assert.throws(() => { (ticket as unknown as Record<string, unknown>)[key] = value; }, TypeError);
  }
  assert.equal(canPublishProjectOpen(ticket, observation()), true);
  assert.equal(projectOpenAttempt(projectA, 0, 'normal').epoch, 0);
  assert.equal(projectOpenAttempt(projectA, Number.MAX_SAFE_INTEGER, `restored:${projectB}`).epoch, Number.MAX_SAFE_INTEGER);
});

test('project-open rejects malformed project IDs, unsafe epochs, and missing workspace scopes', () => {
  for (const projectId of ['', ' ', 'project-a', `${projectA} `, '00000000-0000-0000-8000-000000000001', null, undefined, 1]) {
    assert.throws(() => projectOpenAttempt(projectId as string, 3, workspaceA), TypeError);
  }
  for (const epoch of [-1, 0.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined]) {
    assert.throws(() => projectOpenAttempt(projectA, epoch as number, workspaceA), RangeError);
  }
  for (const workspaceScope of ['', ' ', '\t\n', null, undefined, 1]) {
    assert.throws(() => projectOpenAttempt(projectA, 3, workspaceScope as string), TypeError);
  }
});

test('project-open requires active rendering, ready preferences, and a settled load together', () => {
  const ticket = attempt();
  for (const active of [false, true]) {
    for (const preferencesReady of [false, true]) {
      for (const loading of [false, true]) {
        assert.equal(canPublishProjectOpen(ticket, observation({ active, preferencesReady, loading })),
          active && preferencesReady && !loading, JSON.stringify({ active, preferencesReady, loading }));
      }
    }
  }
  for (const patch of [{ active: 1 }, { preferencesReady: 'ready' }, { loading: 0 }, { loading: undefined }]) {
    assert.equal(canPublishProjectOpen(ticket, observation(patch)), false);
  }
});

test('preferences and assigned current project cannot publish before matching validated data arrives', () => {
  const ticket = attempt();
  const state = observation({ currentProjectId: null, preferencesReady: false, dataProjectId: null, loading: true });
  assert.equal(canPublishProjectOpen(ticket, state), false);
  state.currentProjectId = projectA;
  state.preferencesReady = true;
  assert.equal(canPublishProjectOpen(ticket, state), false);
  state.loading = false;
  assert.equal(canPublishProjectOpen(ticket, state), false, 'A completed empty response is not a project.');
  state.dataProjectId = projectB;
  assert.equal(canPublishProjectOpen(ticket, state), false, 'Previous-project data is not the requested project.');
  state.dataProjectId = projectA;
  state.loading = true;
  assert.equal(canPublishProjectOpen(ticket, state), false);
  state.loading = false;
  assert.equal(canPublishProjectOpen(ticket, state), true);
});

test('every project, epoch, and workspace identity must match the captured attempt exactly', () => {
  const ticket = attempt();
  for (const patch of [
    { currentProjectId: null }, { currentProjectId: projectB }, { dataProjectId: null }, { dataProjectId: projectB },
    { dataProjectId: 'project-a' }, { epoch: 2 }, { epoch: 4 }, { epoch: '3' }, { epoch: Number.NaN },
    { workspaceScope: workspaceB }, { workspaceScope: '' }, { workspaceScope: `${workspaceA} ` },
  ]) assert.equal(canPublishProjectOpen(ticket, observation(patch)), false, JSON.stringify(patch));
  const mixedCaseId = 'ABCDEF00-0000-4000-8000-000000000001';
  const mixedCaseTicket = attempt({ projectId: mixedCaseId });
  assert.equal(canPublishProjectOpen(mixedCaseTicket, observation({ currentProjectId: mixedCaseId, dataProjectId: mixedCaseId })), true);
  assert.equal(canPublishProjectOpen(mixedCaseTicket, observation({ currentProjectId: mixedCaseId, dataProjectId: mixedCaseId.toLowerCase() })), false);
});

test('late callbacks cannot publish after same-project reopen, workspace replacement, or unmount', () => {
  const earlier = attempt();
  const reopened = attempt({ epoch: 4 });
  const reopenedState = observation({ epoch: 4 });
  assert.equal(canPublishProjectOpen(earlier, reopenedState), false, 'The same ID in a later epoch is a different attempt.');
  assert.equal(canPublishProjectOpen(reopened, reopenedState), true);
  const replacedWorkspace = observation({ workspaceScope: workspaceB });
  assert.equal(canPublishProjectOpen(earlier, replacedWorkspace), false, 'The same ID and epoch in another workspace is stale.');
  assert.equal(canPublishProjectOpen(attempt({ workspaceScope: workspaceB }), replacedWorkspace), true);
  assert.equal(canPublishProjectOpen(earlier, observation({ active: false })), false);
  assert.equal(canPublishProjectOpen(reopened, observation({ epoch: 4, active: false })), false);
});

test('missing or runtime-invalid tickets fail closed even if the observation copies their values', () => {
  assert.equal(canPublishProjectOpen(null, observation()), false);
  assert.equal(canPublishProjectOpen(undefined as unknown as ProjectOpenAttempt, observation()), false);
  for (const patch of [{ projectId: '' }, { projectId: 'project-a' }, { epoch: -1 }, { epoch: Infinity }, { workspaceScope: ' ' }]) {
    const ticket = { ...attempt(), ...patch };
    assert.equal(canPublishProjectOpen(ticket, observation({ currentProjectId: ticket.projectId, dataProjectId: ticket.projectId,
      epoch: ticket.epoch, workspaceScope: ticket.workspaceScope })), false);
  }
});

test('checking project-open eligibility is deterministic and does not mutate either input', () => {
  const ticket = attempt();
  const state = Object.freeze(observation());
  const before = structuredClone({ ticket, state });
  for (let count = 0; count < 3; count++) assert.equal(canPublishProjectOpen(ticket, state), true);
  assert.deepEqual({ ticket, state }, before);
});

test('project response identity requires a project object with the exact valid requested UUID', () => {
  const project = Object.freeze({ id: projectA });
  const response = Object.freeze({ project });
  assert.equal(projectResponseMatches(response, projectA), true);
  for (const value of [null, undefined, true, projectA, 1, [], {}, { project: null }, { project: [] },
    { project: projectA }, { project: {} }, { project: { id: null } }, { project: { id: projectB } },
    { project: { id: 'project-a' } }, { project: { id: `${projectA} ` } },
    Object.assign([], { project }), { project: Object.assign([], { id: projectA }) }]) {
    assert.equal(projectResponseMatches(value, projectA), false);
  }
  for (const expected of ['', 'project-a', projectB, null, undefined]) {
    assert.equal(projectResponseMatches(response, expected as string), false);
  }
  const mixedCaseId = 'ABCDEF00-0000-4000-8000-000000000001';
  assert.equal(projectResponseMatches({ project: { id: mixedCaseId } }, mixedCaseId), true);
  assert.equal(projectResponseMatches({ project: { id: mixedCaseId } }, mixedCaseId.toLowerCase()), false);
  assert.deepEqual(response, { project: { id: projectA } });
});

test('project-open failures keep authentication and workspace identity failures distinct', () => {
  assert.equal(projectOpenFailureKind({ code: 'UNAUTHORIZED' }), 'auth');
  assert.equal(projectOpenFailureKind(Object.assign(new Error('session expired'), { code: 'UNAUTHORIZED' })), 'auth');
  for (const code of ['WORKSPACE_ORIGIN_UNVERIFIED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH',
    'LAST_PROJECT_SCOPE_MISMATCH', 'LAST_PROJECT_STALE_INSTANCE']) {
    assert.equal(projectOpenFailureKind(Object.freeze({ code, message: 'identity changed' })), 'identity', code);
  }
  for (const error of [null, undefined, 'UNAUTHORIZED', [], new Error('UNAUTHORIZED'), {},
    { code: 'NOT_FOUND' }, { code: 'FORBIDDEN' }, { code: 'NETWORK_ERROR' }, { code: 'unauthorized' },
    { code: 'UNAUTHORIZED ' }, { code: null }, { code: 401 }, { error: { code: 'UNAUTHORIZED' } }]) {
    assert.equal(projectOpenFailureKind(error), 'project');
  }
});

test('restore-origin mismatch distinguishes an explicit foreign origin from malformed response structure', () => {
  const matching = Object.freeze({ restore: Object.freeze({ workspaceOrigin: projectA }) });
  assert.equal(hasProjectResponseOriginMismatch(matching, projectA), false);
  assert.equal(hasProjectResponseOriginMismatch({ restore: { workspaceOrigin: projectB } }, projectA), true);
  for (const value of [null, undefined, [], {}, { restore: null }, { restore: [] }, { restore: {} },
    { restore: { workspaceOrigin: null } }, { restore: { workspaceOrigin: 7 } },
    Object.assign([], { restore: { workspaceOrigin: projectB } })]) {
    assert.equal(hasProjectResponseOriginMismatch(value, projectA), false);
  }
  for (const expected of ['', 'not-an-origin', null, undefined]) {
    assert.equal(hasProjectResponseOriginMismatch({ restore: { workspaceOrigin: projectB } }, expected as string), false);
  }
  assert.deepEqual(matching, { restore: { workspaceOrigin: projectA } });
});
