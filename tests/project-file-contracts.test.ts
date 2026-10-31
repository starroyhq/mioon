import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ServiceStore} from '../packages/business/src/services.ts';
import {
  DEFAULT_PROJECTS_DIRECTORY, DESKTOP_PROJECTS_FOLDER, PROJECT_ADDRESS_ERROR_CODES, PROJECT_API_PREFIX, PROJECT_BACKUPS_DIRECTORY,
  PROJECT_CACHE_DIRECTORY, PROJECT_CACHE_FILE, PROJECT_DATABASE_NAMES, PROJECT_EXPORTS_FOLDER, PROJECT_FILE_ERROR_CODES,
  PROJECT_FILE_EXISTS, PROJECT_FILE_EXTENSION, PROJECT_FILE_SINGLE_PROJECT, PROJECT_GENERATED_FOLDER, PROJECT_HISTORY_FILE, PROJECT_HISTORY_STATES,
  PROJECT_IMPORTS_DIRECTORY, PROJECT_INVALID_REASONS, PROJECT_OPEN_ERROR_CODES, PROJECT_RECORDS_DIRECTORY, PROJECT_RULES_FILE, SERVER_CACHE_DIRECTORY,
  SERVER_TEMP_DIRECTORY, TEST_STORE_DIRECTORY,
  TEST_STORE_LAYOUT, isProjectId, isProjectStoreInternalEntry, parseProjectApiPath, projectAddressErrorDetailsSchemas, projectApiPath,
  projectCacheDirSegments, projectLocalDirSegments, projectMediaPath, projectOpenFailureSchema, projectOpenResultSchema, projectRpcPath,
} from '../packages/contracts/src/project-file.ts';
import type {ForeignKeyViolation, ProjectInvalidReason, ProjectStore, SchemaObject} from '../packages/contracts/src/project-file.ts';
import {foreignKeyCheck, projectFileError, schemaObjects} from '../packages/business/src/project-file/index.ts';
import type {ProjectFileErrorDetails, ProjectFileErrorReason} from '../packages/business/src/project-file/index.ts';
import {
  MEDIA_PATH_FORMS, MEDIA_STATUSES, isNormalizedAbsolutePath, isPortableRelativePath, mediaFingerprintSchema, mediaReferenceSchema,
  outsideProjectLocationSchema,
} from '../packages/contracts/src/media-reference.ts';
import {
  BACKGROUND_TASK_KINDS, backgroundTaskIndexEntrySchema, localRecordsEntrySchema, outsidePathConfirmationSchema, projectInboxItemSchema,
  projectRulesTrustSchema, recentProjectSchema,
} from '../packages/contracts/src/project-registry.ts';
import {
  PROJECT_VERSION_TRIGGERS, projectPackResultSchema, projectRestorePreviewSchema, projectVersionSummarySchema,
} from '../packages/contracts/src/project-versions.ts';

const projectId = randomUUID(), assetId = randomUUID();
const projectFile = '/Users/me/Movies/Mioon/短片/短片.mioon', stamp = '2026-10-30T06:20:00.000Z';

test('file, folder and directory names are fixed, and the test store stays under root', () => {
  assert.equal(PROJECT_FILE_EXTENSION, '.mioon');
  assert.deepEqual([PROJECT_GENERATED_FOLDER, PROJECT_EXPORTS_FOLDER, PROJECT_RULES_FILE], ['生成', '导出', 'AGENTS.md']);
  assert.deepEqual([DEFAULT_PROJECTS_DIRECTORY, DESKTOP_PROJECTS_FOLDER], ['projects', 'Mioon']);
  assert.deepEqual([PROJECT_RECORDS_DIRECTORY, PROJECT_HISTORY_FILE, PROJECT_BACKUPS_DIRECTORY, PROJECT_IMPORTS_DIRECTORY], ['records', 'history.db', 'backups', 'imports']);
  assert.deepEqual([PROJECT_CACHE_DIRECTORY, PROJECT_CACHE_FILE], ['projects', 'cache.db']);
  assert.notEqual(PROJECT_RECORDS_DIRECTORY, DEFAULT_PROJECTS_DIRECTORY, 'local records never sit where web projects are created');
  assert.deepEqual([SERVER_CACHE_DIRECTORY, SERVER_TEMP_DIRECTORY], ['cache', 'tmp']);
  for (const name of [SERVER_CACHE_DIRECTORY, SERVER_TEMP_DIRECTORY])
    assert.ok(![DEFAULT_PROJECTS_DIRECTORY, PROJECT_RECORDS_DIRECTORY].includes(name), `${name} stays apart from projects and records under dataDir`);
  // The fixed local records are main: a crash in a cross-file commit followed by
  // moving the project folder still finds the super-journal beside them.
  assert.deepEqual(PROJECT_DATABASE_NAMES, {history: 'main', project: 'project', cache: 'cache'});
  assert.deepEqual(Object.keys(PROJECT_DATABASE_NAMES), ['history', 'project', 'cache']);
  assert.equal(TEST_STORE_DIRECTORY, '.mioon-store');
  assert.deepEqual(TEST_STORE_LAYOUT, {projectFile: ['project.mioon'], localDir: ['.mioon-store', 'local'], cacheDir: ['.mioon-store', 'cache'], tempDir: ['.mioon-store', 'tmp']});
  assert.ok([TEST_STORE_LAYOUT, ...Object.values(TEST_STORE_LAYOUT), PROJECT_DATABASE_NAMES].every(value => Object.isFrozen(value)));
  assert.deepEqual(projectLocalDirSegments(projectId), ['records', projectId]);
  assert.deepEqual(projectCacheDirSegments(projectId), ['projects', projectId]);
  for (const bad of ['', '..', 'not-a-uuid', projectId.toUpperCase(), `${projectId}/..`]) {
    assert.equal(isProjectId(bad), false, bad);
    assert.throws(() => projectLocalDirSegments(bad), TypeError);
    assert.throws(() => projectCacheDirSegments(bad), TypeError);
  }
});

test('ProjectStore over DatabaseSync is a business ServiceStore', () => {
  const asServiceStore = (store: ProjectStore<DatabaseSync>): ServiceStore => store;
  assert.equal(typeof asServiceStore, 'function');
});

test('the kernel reports with the contract types and the contract creation code', () => {
  // Type-level: the kernel's inspection functions return the contract's shapes.
  const objects: (db: DatabaseSync) => SchemaObject[] = schemaObjects;
  const violations: (db: DatabaseSync) => ForeignKeyViolation[] = foreignKeyCheck;
  assert.equal(typeof objects, 'function');
  assert.equal(typeof violations, 'function');
  const error = projectFileError(PROJECT_FILE_EXISTS, {database: 'project', reason: 'exists'});
  assert.equal(error.code, PROJECT_FILE_EXISTS);
  assert.equal(error.status, 409);
  assert.deepEqual(error.details, {database: 'project', reason: 'exists'});
});

test('states and error codes are the agreed strings', () => {
  assert.deepEqual(PROJECT_HISTORY_STATES, ['fresh', 'current', 'file-older', 'file-newer']);
  assert.deepEqual(PROJECT_OPEN_ERROR_CODES, ['PROJECT_MISSING', 'PROJECT_LOCKED', 'PROJECT_FORMAT_NEWER', 'PROJECT_INVALID']);
  assert.deepEqual(PROJECT_INVALID_REASONS, [
    'not-a-regular-file', 'not-a-project-file', 'journal-mode', 'encoding', 'application-id',
    'schema-version', 'schema', 'metadata', 'project-row', 'foreign-key', 'project-mismatch',
    'corrupt', 'read-only', 'unusable',
  ]);
  assert.ok(Object.isFrozen(PROJECT_INVALID_REASONS));
  // Type-level: the kernel's reasons are the contract's PROJECT_INVALID reasons and the four that go with other codes.
  const kernelReasons: readonly ProjectFileErrorReason[] = [...PROJECT_INVALID_REASONS, 'missing', 'locked', 'format-newer', 'exists'];
  const invalidReason = (reason: Exclude<ProjectFileErrorReason, 'missing' | 'locked' | 'format-newer' | 'exists'>): ProjectInvalidReason => reason;
  assert.equal(new Set(kernelReasons).size, kernelReasons.length);
  assert.equal(invalidReason('read-only'), 'read-only');
  assert.equal(PROJECT_FILE_SINGLE_PROJECT, 'PROJECT_FILE_SINGLE_PROJECT');
  assert.equal(PROJECT_FILE_EXISTS, 'PROJECT_FILE_EXISTS');
  assert.deepEqual(PROJECT_ADDRESS_ERROR_CODES, ['PROJECT_NOT_FOUND', 'PROJECT_ID_MISMATCH', 'PROJECT_UNAVAILABLE']);
  assert.deepEqual(PROJECT_FILE_ERROR_CODES, [...PROJECT_OPEN_ERROR_CODES, PROJECT_FILE_SINGLE_PROJECT, PROJECT_FILE_EXISTS, ...PROJECT_ADDRESS_ERROR_CODES]);
  assert.equal(new Set(PROJECT_FILE_ERROR_CODES).size, PROJECT_FILE_ERROR_CODES.length);
  assert.deepEqual(MEDIA_PATH_FORMS, ['relative', 'absolute']);
  assert.deepEqual(MEDIA_STATUSES, ['online', 'missing', 'changed']);
  assert.deepEqual(PROJECT_VERSION_TRIGGERS, ['manual', 'mio-turn', 'bulk-change', 'restore', 'daily-open']);
  assert.deepEqual(BACKGROUND_TASK_KINDS, ['job', 'export', 'edit_task', 'image_task', 'frame_task', 'scene_task', 'subject_variant_batch']);
});

test('project URLs are built from canonical IDs and parse back unchanged', () => {
  assert.equal(PROJECT_API_PREFIX, '/api/projects/');
  assert.equal(projectRpcPath(projectId), `/api/projects/${projectId}/rpc`);
  assert.equal(projectMediaPath(projectId, assetId), `/api/projects/${projectId}/media/${assetId}`);
  assert.deepEqual(parseProjectApiPath(projectRpcPath(projectId)), {kind: 'rpc', projectId});
  assert.deepEqual(parseProjectApiPath(projectMediaPath(projectId, assetId)), {kind: 'media', projectId, assetId});
  const other = projectApiPath(projectId, 'agent', 'tasks', 'v2', 'requests', 'req 1:é');
  assert.equal(other, `/api/projects/${projectId}/agent/tasks/v2/requests/req%201%3A%C3%A9`);
  assert.deepEqual(parseProjectApiPath(other), {kind: 'other', projectId, segments: ['agent', 'tasks', 'v2', 'requests', 'req 1:é']});
  // Media queries stay as they are on /media/ today; the parser reads only the pathname.
  for (const query of [`?preview=1&exportId=${randomUUID()}`, `?download=1&exportId=${randomUUID()}`, '?download'])
    assert.deepEqual(parseProjectApiPath(new URL(projectMediaPath(projectId, assetId) + query, 'http://127.0.0.1').pathname), {kind: 'media', projectId, assetId});
});

test('builders refuse IDs and segments that could not parse back', () => {
  for (const bad of ['', 'not-a-uuid', projectId.toUpperCase(), `../${projectId}`, `${projectId}/x`]) {
    assert.throws(() => projectRpcPath(bad), TypeError, bad);
    assert.throws(() => projectApiPath(bad, 'rpc'), TypeError, bad);
  }
  for (const bad of ['a.mp4', '../x', assetId.toUpperCase(), `${assetId}/x`]) assert.throws(() => projectMediaPath(projectId, bad), TypeError, bad);
  for (const segment of ['', '.', '..', 'a/b', 'a\\b', 'a\u0000b']) assert.throws(() => projectApiPath(projectId, segment), TypeError, JSON.stringify(segment));
});

test('the parser refuses traversal, encoded separators and loose shapes', () => {
  const base = `/api/projects/${projectId}`;
  for (const pathname of [
    '/api/rpc', `/media/${assetId}`, '/api/projects/', base, `${base}/`, `/API/projects/${projectId}/rpc`,
    `/api/projects/${projectId.toUpperCase()}/rpc`, '/api/projects/not-a-uuid/rpc', `/api/projects/${projectId}x/rpc`,
    `/api/projects/%2e%2e/${projectId}/rpc`, `/api/projects/..%2F${projectId}/rpc`,
    `${base}/../rpc`, `${base}/./rpc`, `${base}/%2e%2e/rpc`, `${base}/.%2E/rpc`, `${base}/%2E/rpc`,
    `${base}/agent%2Ftasks`, `${base}/agent%2ftasks`, `${base}/agent%5Ctasks`, `${base}/agent\\tasks`, `${base}/x%00y`, `${base}/%E0%A4%A`,
    `${base}//rpc`, `${base}/rpc/`, `${base}/rpc/x`, `${base}/rpc?x=1`, `${base}/rpc#x`,
    `${base}/media`, `${base}/media/`, `${base}/media/${assetId}/x`, `${base}/media/${assetId.toUpperCase()}`, `${base}/media/a.mp4`,
    `${base}/media/..%2F..%2Fworkbench.sqlite`, `${base}/media/${assetId}%2F..`,
  ]) assert.equal(parseProjectApiPath(pathname), null, pathname);
});

test('storage-internal entries are recognised for directory snapshots', () => {
  // Super-journal names as observed from Node 24's SQLite during commits spanning attached files.
  // With the local records as main it is created beside history.db, inside .mioon-store/ in the test layout.
  for (const entry of ['.mioon-store', '.mioon-store/local/history.db', '.mioon-store\\tmp\\frame.png', './.mioon-store/cache',
    '.mioon-store/local/history.db-mj0DA3D190E', '.mioon-store/local/history.db-journal',
    'project.mioon-journal', '短片.mioon-journal', 'project.mioon-mj0DA3D190E', '短片.mioon-mjCAA6C6996'])
    assert.equal(isProjectStoreInternalEntry(entry), true, entry);
  for (const entry of ['project.mioon', 'AGENTS.md', '生成', '生成/clip.mp4', '导出/成片.mp4', 'sub/.mioon-store', 'clip-mj.mp4',
    'project.mioon-mj', 'project.mioon-mj0da3d190e', 'project.mioon-mj0DA3D1A0E', 'project.mioon-journal.mp4'])
    assert.equal(isProjectStoreInternalEntry(entry), false, entry);
});

test('open results and addressing details are validated', () => {
  const opened = {ok: true, projectId, projectFile, projectDir: '/Users/me/Movies/Mioon/短片', historyState: 'fresh'};
  assert.ok(projectOpenResultSchema.safeParse(opened).success);
  assert.equal(projectOpenResultSchema.safeParse({...opened, historyState: 'stale'}).success, false);
  const newer = {code: 'PROJECT_FORMAT_NEWER', projectFile, projectId: null, database: 'project', formatVersion: 2, supportedFormatVersion: 1};
  assert.ok(projectOpenResultSchema.safeParse({ok: false, error: newer}).success);
  assert.equal(projectOpenFailureSchema.safeParse({...newer, formatVersion: 1}).success, false);
  assert.equal(projectOpenFailureSchema.safeParse({...newer, database: 'app'}).success, false);
  for (const code of ['PROJECT_MISSING', 'PROJECT_LOCKED'] as const) {
    assert.ok(projectOpenFailureSchema.safeParse({code, projectFile, projectId}).success, code);
    assert.equal(projectOpenFailureSchema.safeParse({code, projectFile, projectId: projectId.toUpperCase()}).success, false, code);
    assert.equal(projectOpenFailureSchema.safeParse({code, projectFile, projectId, reason: 'read-only'}).success, false, code);
  }
  // PROJECT_INVALID carries the kernel's reason, so a read-only place is not shown as a damaged file (12-03d).
  for (const reason of PROJECT_INVALID_REASONS) {
    assert.ok(projectOpenFailureSchema.safeParse({code: 'PROJECT_INVALID', projectFile, projectId, reason}).success, reason);
  }
  assert.equal(projectOpenFailureSchema.safeParse({code: 'PROJECT_INVALID', projectFile, projectId}).success, false, 'the reason is required');
  assert.equal(projectOpenFailureSchema.safeParse({code: 'PROJECT_INVALID', projectFile, projectId: projectId.toUpperCase(), reason: 'corrupt'}).success, false);
  // The reasons that go with the other codes are not PROJECT_INVALID reasons.
  for (const reason of ['missing', 'locked', 'format-newer', 'exists', 'damaged']) {
    assert.equal(projectOpenFailureSchema.safeParse({code: 'PROJECT_INVALID', projectFile, projectId, reason}).success, false, reason);
  }
  assert.equal(projectOpenFailureSchema.safeParse({code: 'PROJECT_NOT_FOUND', projectFile, projectId}).success, false);
  // The kernel's details fill it in: reason and projectId as they are, projectFile from the caller.
  const kernel = projectFileError('PROJECT_INVALID', {database: 'project', reason: 'read-only', projectId});
  const {reason} = kernel.details as ProjectFileErrorDetails;
  assert.ok(projectOpenFailureSchema.safeParse({code: kernel.code, projectFile, projectId, reason}).success);
  assert.ok(projectAddressErrorDetailsSchemas.PROJECT_UNAVAILABLE.safeParse({projectId, reason: 'PROJECT_LOCKED'}).success);
  assert.equal(projectAddressErrorDetailsSchemas.PROJECT_UNAVAILABLE.safeParse({projectId, reason: 'PROJECT_NOT_FOUND'}).success, false);
  assert.ok(projectAddressErrorDetailsSchemas.PROJECT_NOT_FOUND.safeParse({projectId}).success);
  assert.equal(projectAddressErrorDetailsSchemas.PROJECT_ID_MISMATCH.safeParse({projectId: 'x'}).success, false);
});

test('media references fix the path form, volume and fingerprint fields once', () => {
  const fingerprint = {sizeBytes: 1024, mtimeMs: 1761805200000.5, sampledSha256: 'a'.repeat(64), fullSha256: null};
  assert.deepEqual(mediaFingerprintSchema.parse(fingerprint), fingerprint);
  const relative = {pathForm: 'relative', path: '../素材/访谈/a.mp4', volume: null, ...fingerprint};
  assert.deepEqual(Object.keys(mediaReferenceSchema.parse(relative)), ['pathForm', 'path', 'volume', 'sizeBytes', 'mtimeMs', 'sampledSha256', 'fullSha256']);
  assert.ok(mediaReferenceSchema.safeParse({...relative, pathForm: 'absolute', path: 'D:\\素材\\a.mp4', volume: 'Media', fullSha256: 'b'.repeat(64)}).success);
  for (const patch of [{path: '/Volumes/素材盘/a.mp4'}, {path: 'a/../b.mp4'}, {path: './a.mp4'}, {path: 'a//b.mp4'}, {path: 'a\\b.mp4'},
    {path: 'C:a.mp4'}, {path: '..'}, {volume: 'Media'}, {fullSha256: 'A'.repeat(64)}, {sizeBytes: -1}, {pathForm: 'managed'}, {extra: true}])
    assert.equal(mediaReferenceSchema.safeParse({...relative, ...patch}).success, false, JSON.stringify(patch));
  assert.equal(mediaReferenceSchema.safeParse({...relative, pathForm: 'absolute'}).success, false);
  for (const path of ['a.mp4', '生成/clip.mp4', '../../素材/a.mp4']) assert.equal(isPortableRelativePath(path), true, path);
  for (const path of ['/Volumes/素材盘/a.mp4', 'C:\\Media\\a.mp4', 'C:/Media/a.mp4', '\\\\nas\\share\\a.mp4', '/'])
    assert.equal(isNormalizedAbsolutePath(path), true, path);
  for (const path of ['', 'relative/a.mp4', 'C:relative.mp4', '/a/../b.mp4', '/a/./b.mp4', '/a//b.mp4', '/a/', '\\\\nas', '\\\\?\\C:\\a.mp4',
    '\\\\.\\PhysicalDrive0', '/a\u0000b']) assert.equal(isNormalizedAbsolutePath(path), false, JSON.stringify(path));
  const location = {directory: '/Volumes/素材盘/访谈/0912', volume: '素材盘', assetCount: 12, available: true};
  assert.ok(outsideProjectLocationSchema.safeParse(location).success);
  assert.equal(outsideProjectLocationSchema.safeParse({...location, directory: '../素材'}).success, false);
  assert.equal(outsideProjectLocationSchema.safeParse({...location, assetCount: 0}).success, false);
});

test('registry records keep project IDs, identities and paths strict', () => {
  const recent = {projectId, projectFile, fileIdentity: {dev: '16777234', ino: '340282366920938463463374607431768211455'}, name: '短片', lastOpenedAt: null, summary: null};
  assert.ok(recentProjectSchema.safeParse(recent).success);
  const summary = {description: '', revision: 3, createdAt: stamp, updatedAt: stamp, fps: 30, width: 1080, height: 1920, presetId: 'vertical-1080x1920',
    shotCount: 4, durationFrames: 1260, cover: {assetId, mimeType: 'image/png'}};
  assert.ok(recentProjectSchema.safeParse({...recent, lastOpenedAt: stamp, summary}).success);
  for (const patch of [{fileIdentity: {dev: 1, ino: 2}}, {fileIdentity: {dev: '01', ino: '2'}}, {projectFile: '短片.mioon'}, {projectId: projectId.toUpperCase()},
    {summary: {...summary, cover: {assetId, mimeType: 'image/gif'}}}, {extra: true}])
    assert.equal(recentProjectSchema.safeParse({...recent, ...patch}).success, false, JSON.stringify(patch));
  assert.ok(backgroundTaskIndexEntrySchema.safeParse({projectId, projectFile, kind: 'image_task', taskId: randomUUID(), indexedAt: stamp}).success);
  const inbox = {id: randomUUID(), projectId, taskKind: 'job', taskId: randomUUID(), receivedAt: stamp,
    stagedMedia: [{fileName: `${randomUUID()}.mp4`, mimeType: 'video/mp4', sizeBytes: 10, sha256: 'c'.repeat(64)}]};
  assert.ok(projectInboxItemSchema.safeParse(inbox).success);
  assert.equal(projectInboxItemSchema.safeParse({...inbox, stagedMedia: [{...inbox.stagedMedia[0], fileName: '../x.mp4'}]}).success, false);
  assert.ok(projectRulesTrustSchema.safeParse({projectId, sha256: 'd'.repeat(64), trustedAt: stamp}).success);
  assert.ok(outsidePathConfirmationSchema.safeParse({projectId, directory: '/Volumes/素材盘/访谈/0912', confirmedAt: stamp}).success);
  assert.equal(outsidePathConfirmationSchema.safeParse({projectId, directory: '../素材', confirmedAt: stamp}).success, false);
  assert.ok(localRecordsEntrySchema.safeParse({projectId, sizeBytes: 0, hasSuperJournal: false}).success);
  assert.ok(localRecordsEntrySchema.safeParse({projectId, sizeBytes: 4096, hasSuperJournal: true}).success);
  for (const entry of [{projectId, sizeBytes: 0}, {projectId, sizeBytes: 0, hasSuperJournal: 'no'}, {projectId, sizeBytes: 0, hasSuperJournal: false, projectFile}])
    assert.equal(localRecordsEntrySchema.safeParse(entry).success, false, JSON.stringify(entry));
});

test('version summaries, restore previews and pack results', () => {
  const version = {id: randomUUID(), projectId, trigger: 'mio-turn', name: null, mioRunId: randomUUID(), contentSequence: 3, createdAt: stamp};
  assert.ok(projectVersionSummarySchema.safeParse(version).success);
  assert.ok(projectVersionSummarySchema.safeParse({...version, trigger: 'manual', name: '定稿前', mioRunId: null}).success);
  assert.ok(projectVersionSummarySchema.safeParse({...version, trigger: 'manual', mioRunId: null}).success);
  for (const patch of [{mioRunId: null}, {name: '定稿前'}, {trigger: 'manual'}, {trigger: 'daily-open'}, {contentSequence: -1}])
    assert.equal(projectVersionSummarySchema.safeParse({...version, ...patch}).success, false, JSON.stringify(patch));
  const preview = {version, manualChanges: [
    {kind: 'timeline_clip', id: randomUUID(), name: 'scene-b.mp4', fields: [{property: 'durationFrames', before: 210, after: 180}]},
    {kind: 'timeline_subtitle', id: randomUUID(), name: '镜头缓慢推进', fields: [{property: 'subtitleText'}]},
  ], manualChangeCount: 2, supersededMioChanges: 4};
  assert.ok(projectRestorePreviewSchema.safeParse(preview).success);
  assert.equal(projectRestorePreviewSchema.safeParse({...preview, manualChangeCount: 1}).success, false);
  assert.equal(projectRestorePreviewSchema.safeParse({...preview, manualChanges: [{...preview.manualChanges[0], kind: 'workspace'}]}).success, false);
  const packed = {directory: '/Users/me/Desktop/短片（打包）', projectFile: '/Users/me/Desktop/短片（打包）/短片.mioon', rulesFileCopied: true,
    copiedAssets: 21, copiedBytes: 4_100_000_000, missingAssetIds: [randomUUID(), randomUUID()]};
  assert.ok(projectPackResultSchema.safeParse(packed).success);
  assert.equal(projectPackResultSchema.safeParse({...packed, directory: '短片（打包）'}).success, false);
});
