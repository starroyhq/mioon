import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECT_INVALID_REASONS} from '../packages/contracts/src/project-file.ts';
import type {RecentProject, RecentProjectSummary} from '../packages/contracts/src/project-registry.ts';
import {PROJECT_ENTRY_ERROR_STATUS, PROJECT_ENTRY_LIMITS, projectEntriesResponseSchema, projectEntrySchema} from '../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse, ProjectEntry} from '../packages/contracts/src/project-entry.ts';
import {projectEntryAcquireInputSchema, projectEntryCreateInputSchema, projectEntryOpenPathInputSchema,
  projectEntryReleaseInputSchema, projectEntryWindowRevokedSchema, projectEntryWindowSchema} from '../packages/contracts/src/project-entry-native.ts';

const id = (number: number): string => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const project = (change: Partial<RecentProject> = {}): RecentProject => ({projectId: id(1), projectFile: '/projects/Project/Project.mioon',
  fileIdentity: {dev: '1', ino: '2'}, name: 'Project', lastOpenedAt: null, summary: null, ...change});
const entry = (change: Partial<ProjectEntry> = {}): ProjectEntry => ({project: project(), availability: {state: 'available'}, coverUrl: null, ...change});
const catalog = (registered: ProjectEntry[] = [entry()]): ProjectEntriesResponse => ({version: 1, appLibraryScope: 'a'.repeat(64), instanceId: id(2), registered});
const summary: RecentProjectSummary = {description: '', revision: 1, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
  fps: 30, width: 1080, height: 1920, presetId: 'portrait_1080', shotCount: 0, durationFrames: 0, cover: {assetId: id(3), mimeType: 'image/png'}};

test('catalog preserves empty summaries and every host availability without granting additional authority', () => {
  for (const state of ['open', 'busy', 'available', 'locked', 'missing'] as const) {
    const value = catalog([entry({availability: {state}})]);
    assert.deepEqual(projectEntriesResponseSchema.parse(value), value);
  }
  for (const reason of PROJECT_INVALID_REASONS) {
    const value = catalog([entry({availability: {state: 'invalid', reason}})]);
    assert.deepEqual(projectEntriesResponseSchema.parse(value), value);
  }
  assert.deepEqual(projectEntriesResponseSchema.parse(catalog([])).registered, []);
  for (const availability of [{state: 'invalid'}, {state: 'invalid', reason: 'PRIVATE_UNKNOWN'}, {state: 'available', reason: 'read-only'}, {state: 'deleted'}]) {
    assert.equal(projectEntriesResponseSchema.safeParse({...catalog(), registered: [{...entry(), availability}]}).success, false);
  }
});

test('a cover belongs to this exact project summary and uses the cache-only application address', () => {
  const value = entry({project: project({summary}), coverUrl: '/api/project-covers/' + id(1)});
  assert.deepEqual(projectEntrySchema.parse(value), value);
  for (const coverUrl of [null, '/media/' + id(3), '/api/project-covers/' + id(2), 'https://external.invalid/cover', '/api/project-covers/' + id(1) + '?path=secret']) {
    assert.equal(projectEntrySchema.safeParse({...value, coverUrl}).success, false);
  }
  assert.equal(projectEntrySchema.safeParse(entry({coverUrl: '/api/project-covers/' + id(1)})).success, false);
  assert.equal(projectEntrySchema.safeParse({...value, coverBytes: 'not-a-catalog-field'}).success, false);
});

test('catalog identity is strict, project IDs are unique, and the complete B1 registry fits', () => {
  const value = catalog();
  for (const patch of [{version: 2}, {appLibraryScope: 'A'.repeat(64)}, {appLibraryScope: 'a'.repeat(63)}, {instanceId: 'not-an-instance'},
    {scope: 'desktop'}, {mode: 'all'}, {candidates: []}, {nextCursor: null}, {registered: [entry(), entry()]}]) {
    assert.equal(projectEntriesResponseSchema.safeParse({...value, ...patch}).success, false);
  }
  const registered = Array.from({length: PROJECT_ENTRY_LIMITS.maxEntries}, (_unused, index) => entry({project: project({projectId: id(index + 1)})}));
  assert.equal(projectEntriesResponseSchema.parse(catalog(registered)).registered.length, 8192);
  assert.equal(projectEntriesResponseSchema.safeParse(catalog([...registered, entry({project: project({projectId: id(8193)})})])).success, false);
  assert.deepEqual(PROJECT_ENTRY_ERROR_STATUS, {PROJECT_ENTRY_SCOPE_MISMATCH: 409, PROJECT_ENTRY_UNAVAILABLE: 503, PROJECT_ENTRY_WINDOW_CONFLICT: 409, PROJECT_ENTRY_LIMIT: 413});
});

test('trusted creation accepts one explicit location and shares the UI/server name policy', () => {
  const input = {name: '新项目', description: 'Direction', timelinePresetId: 'landscape_1080', parentDir: '/projects'};
  assert.deepEqual(projectEntryCreateInputSchema.parse(input), input);
  assert.equal(projectEntryCreateInputSchema.safeParse({name: '新项目', projectFile: '/projects/新项目.mioon'}).success, true);
  assert.equal(projectEntryCreateInputSchema.safeParse({name: 'Project', description: 'x'.repeat(2000)}).success, true);
  for (const patch of [{name: ''}, {name: 'CON.txt'}, {name: 'a/b'}, {name: 'a'.repeat(151)}, {description: 'x'.repeat(2001)},
    {parentDir: 'relative'}, {parentDir: '/projects/../elsewhere'}, {projectFile: '/projects/new.sqlite'},
    {parentDir: '/projects', projectFile: '/projects/new.mioon'}, {leaseKind: 'task'}, {approved: true}, {sourcePath: '/private'}]) {
    assert.equal(projectEntryCreateInputSchema.safeParse({name: 'Project', ...patch}).success, false);
  }
});

test('window controls use opaque UUID owners, fixed kinds, and strict responses and revocation events', () => {
  const windowId = id(4), opened = {windowId, project: project()};
  assert.deepEqual(projectEntryOpenPathInputSchema.parse({windowId, projectFile: '/projects/Project.mioon'}), {windowId, projectFile: '/projects/Project.mioon'});
  assert.deepEqual(projectEntryAcquireInputSchema.parse({windowId, projectId: id(1)}), {windowId, projectId: id(1)});
  assert.deepEqual(projectEntryReleaseInputSchema.parse({windowId}), {windowId});
  assert.deepEqual(projectEntryWindowSchema.parse(opened), opened);
  assert.deepEqual(projectEntryWindowRevokedSchema.parse({windowId, projectId: id(1)}), {windowId, projectId: id(1)});
  for (const windowId of [1, '', '1', 'not-an-owner']) assert.equal(projectEntryReleaseInputSchema.safeParse({windowId}).success, false);
  for (const patch of [{kind: 'request'}, {leaseKind: 'task'}, {sql: 'select 1'}, {projectFile: '/private'}]) {
    assert.equal(projectEntryAcquireInputSchema.safeParse({windowId, projectId: id(1), ...patch}).success, false);
  }
  assert.equal(projectEntryOpenPathInputSchema.safeParse({windowId, projectFile: 'relative.mioon'}).success, false);
  assert.equal(projectEntryWindowSchema.safeParse({...opened, lease: {release: true}}).success, false);
  assert.equal(projectEntryWindowRevokedSchema.safeParse({windowId, projectId: id(1), reason: 'unreviewed'}).success, false);
});
