import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from './helpers/test-server.ts';
import {createServerProject, openServerProject} from './helpers/project-database.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import type {ProjectFileFormat} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import {createMemoryProjectRegistry} from '../apps/server/src/project-host/stand-ins.ts';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {statProjectFileIdentity} from '../apps/server/src/project-host/index.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import type {ProjectHistoryStatus} from '../packages/contracts/src/project-history-recovery.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';

const root = (): string => mkdtempSync(path.join(realpathSync(tmpdir()), 'copy-history-admission-'));
const token = 'copy-history-admission-token-2026';
const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
function privateRoot(base: string, ...parts: string[]): string {
  const value = path.join(base, ...parts); mkdirSync(value, {recursive: true, mode: 0o700}); return value;
}
/** Prepare a project in data A, keep a copy of the history from before an edit,
 * and copy only the project file plus its media directory into data B. */
function prepareCopiedProject(a: string, b: string, format: 3 | 4 | 5, staleHistory: boolean) {
  if (format === 5) {
    const projectId = randomUUID(), projectFile = path.join(privateRoot(a, 'projects', 'orig'), 'orig.mioon');
    const location = {localDir: path.join(a, 'records', projectId), cacheDir: path.join(a, 'cache', projectId), tempDir: path.join(a, 'tmp', projectId)};
    const store = createProjectStore({projectId, projectFile, targetFormat: 5, locate: () => location});
    ensureProjectRow(store, {name: 'Copied project'});
    const versionId = createProjectVersions(store).save({projectId, requestId: randomUUID(), name: 'Before edit'}).version.id;
    store.close();
    const historyFile = path.join(location.localDir, 'history.db'), oldHistory = path.join(a, 'old-history.db');
    copyFileSync(historyFile, oldHistory);
    const reopened = openProjectStore({projectFile, locate: () => location});
    const row = reopened.get('projects', projectId) as Record<string, unknown>; reopened.put('projects', {...row, name: 'Edited after copy', revision: 2}); reopened.close();
    const copied = path.join(privateRoot(b, 'projects', 'copy'), 'copy.mioon');
    copyFileSync(projectFile, copied);
    if (existsSync(path.join(path.dirname(projectFile), 'media'))) cpSync(path.join(path.dirname(projectFile), 'media'), path.join(path.dirname(copied), 'media'), {recursive: true});
    if (staleHistory) {const target = path.join(b, 'records', projectId, 'history.db'); mkdirSync(path.dirname(target), {recursive: true, mode: 0o700}); copyFileSync(oldHistory, target);}
    return {projectId, projectFile: copied, versionId};
  }
  const created = createServerProject(a, {name: 'Copied project', projectFormat: format as ProjectFileFormat});
  const {projectId, store} = created; const sourceProjectFile = store.projectFile;
  const versionId = createProjectVersions(store).save({projectId, requestId: randomUUID(), name: 'Before edit'}).version.id;
  const historyFile = path.join(projectLocation(serverAppDirectories(a), projectId).localDir, 'history.db');
  const oldHistory = path.join(a, 'old-history.db'); copyFileSync(historyFile, oldHistory);
  const row = store.get('projects', projectId) as Record<string, unknown>; store.put('projects', {...row, name: 'Edited after copy', revision: 2}); store.close();
  const copiedFolder = privateRoot(b, 'projects', 'copy'); const copied = path.join(copiedFolder, 'copy.mioon');
  copyFileSync(sourceProjectFile, copied);
  const sourceMedia = path.join(path.dirname(sourceProjectFile), 'media');
  if (existsSync(sourceMedia)) cpSync(sourceMedia, path.join(copiedFolder, 'media'), {recursive: true});
  if (staleHistory) {
    const target = path.join(projectLocation(serverAppDirectories(b), projectId).localDir, 'history.db');
    mkdirSync(path.dirname(target), {recursive: true, mode: 0o700}); copyFileSync(oldHistory, target);
  }
  const library = openAppLibrary({dataDir: b});
  try {library.registry.upsert({projectId, projectFile: copied, fileIdentity: library.projectFileIdentity(copied)!, name: 'Copied project', lastOpenedAt: null, summary: null});}
  finally {library.close();}
  return {projectId, projectFile: copied, versionId};
}
async function withServer<T>(dataDir: string, format: 3 | 4, body: (url: string) => Promise<T>): Promise<T> {
  privateRoot(path.join(dataDir, '..'), 'dist');
  const server = await startServer({dataDir, port: 0, token, distDir: path.join(dataDir, '..', 'dist'),
    ...(format === 3 ? {projectFormatForTest: PROJECT_FILE_SCHEMA_VERSION} : {})});
  try {return await body(server.url);} finally {await server.close();}
}
async function projectGet(url: string, projectId: string) {
  const response = await fetch(`${url}/api/projects/${projectId}/rpc`, {method: 'POST', headers,
    body: JSON.stringify({operation: 'project.get', input: {projectId}})});
  return {status: response.status, body: await response.json() as {ok: boolean; data?: unknown; error?: {code?: string}}};
}
const historyStatus = async (url: string, projectId: string) => {
  const response = await fetch(`${url}/api/projects/${projectId}/history/status`, {headers});
  return {status: response.status, body: await response.json() as {ok: boolean; data?: ProjectHistoryStatus; error?: {code?: string}}};
};
test('copying only the project file and media into a fresh data directory opens it as a new project (formats 3/4)', async t => {
  for (const format of [3, 4] as const) await t.test(`format ${format}`, async () => {
    const base = root(), a = path.join(base, 'a'), b = path.join(base, 'b'); privateRoot(a); privateRoot(b);
    t.after(() => rmSync(base, {recursive: true, force: true}));
    const copied = prepareCopiedProject(a, b, format, false);
    await withServer(b, format, async url => {
      const result = await projectGet(url, copied.projectId);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.ok, true);
    });
  });
});
test('stale history resolves with continue or restore-version (formats 3/4 real server)', async t => {
  for (const format of [3, 4] as const) await t.test(`format ${format}`, async () => {
    for (const action of ['continue', 'restore-version'] as const) {
      const base = root(), a = path.join(base, 'a'), b = path.join(base, 'b'); privateRoot(a); privateRoot(b);
      try {
        const copied = prepareCopiedProject(a, b, format, true);
        await withServer(b, format, async url => {
          const blocked = await projectGet(url, copied.projectId);
          assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
          assert.equal(blocked.body.error?.code, 'PROJECT_HISTORY_DIVERGED');
          const status = await historyStatus(url, copied.projectId);
          assert.equal(status.status, 200); assert.equal(status.body.data?.state, 'diverged');
          const data = status.body.data!;
          let input: Record<string, unknown> = {projectId: copied.projectId, requestId: randomUUID(), action, expected: data.file,
            historyIdentity: data.historyIdentity, confirmationDigest: data.confirmationDigest};
          if (action === 'restore-version') {
            const versions = await (await fetch(`${url}/api/projects/${copied.projectId}/history/versions`, {headers})).json() as
              {data: {versions: {id: string}[]}};
            assert.ok(versions.data.versions.some(version => version.id === copied.versionId), 'the saved version is carried');
            const preview = await (await fetch(`${url}/api/projects/${copied.projectId}/history/preview?versionId=${copied.versionId}`, {headers})).json() as
              {data: {previewDigest: string; restoreAvailable: boolean}};
            assert.equal(preview.data.restoreAvailable, true);
            input = {...input, versionId: copied.versionId, previewDigest: preview.data.previewDigest};
          }
          const response = await fetch(`${url}/api/projects/${copied.projectId}/history/resolve`, {method: 'POST', headers, body: JSON.stringify(input)});
          assert.equal(response.status, 200, await response.text());
          const reopened = await projectGet(url, copied.projectId);
          assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
          if (action === 'restore-version') assert.equal((reopened.body.data as {project: {name: string}}).project.name, 'Copied project');
        });
      } finally {rmSync(base, {recursive: true, force: true});}
    }
  });
});
test('a project change between status and confirmation refuses the action and keeps every file (format 4)', async () => {
  const base = root(), a = path.join(base, 'a'), b = path.join(base, 'b'); privateRoot(a); privateRoot(b);
  try {
    const copied = prepareCopiedProject(a, b, 4, true);
    let data: ProjectHistoryStatus | undefined;
    // Reading status may leave the idle host open, so close the server before
    // changing the file the way another program would.
    await withServer(b, 4, async url => {
      const status = await historyStatus(url, copied.projectId);
      assert.equal(status.status, 200); data = status.body.data!;
    });
    const raw = new DatabaseSync(copied.projectFile);
    try {raw.prepare("UPDATE projects SET data=json_set(data,'$.name','Changed after status','$.revision',3)").run();} finally {raw.close();}
    await withServer(b, 4, async url => {
      const response = await fetch(`${url}/api/projects/${copied.projectId}/history/resolve`, {method: 'POST', headers,
        body: JSON.stringify({projectId: copied.projectId, requestId: randomUUID(), action: 'continue', expected: data!.file,
          historyIdentity: data!.historyIdentity, confirmationDigest: data!.confirmationDigest})});
      const body = await response.json() as {error?: {code?: string}};
      assert.equal(response.status, 409); assert.equal(body.error?.code, 'PROJECT_HISTORY_BASELINE_CHANGED');
      const stillBlocked = await projectGet(url, copied.projectId);
      assert.equal(stillBlocked.status, 409);
      assert.ok(existsSync(path.join(projectLocation(serverAppDirectories(b), copied.projectId).localDir, 'history.db')));
    });
  } finally {rmSync(base, {recursive: true, force: true});}
});
test('format 5 copied project opens fresh, and stale history resolves with continue or restore-version', async t => {
  for (const stale of [false, true]) for (const action of stale ? ['continue', 'restore-version'] as const : ['continue'] as const) {
    await t.test(`${stale ? 'stale' : 'fresh'} ${action}`, async () => {
      const base = root(), a = path.join(base, 'a'), b = path.join(base, 'b'); privateRoot(a); privateRoot(b);
      try {
        const copied = prepareCopiedProject(a, b, 5, stale);
        const registry = createMemoryProjectRegistry();
        registry.upsert({projectId: copied.projectId, projectFile: copied.projectFile, fileIdentity: statProjectFileIdentity(copied.projectFile)!, name: 'Copied project', lastOpenedAt: null, summary: null});
        const runtime = {handle: async () => false, isBusy: () => false, interrupt() {}, drain: async () => {}, dispose() {}};
        const manager = createProjectHostManager({directories: serverAppDirectories(b), registry, targetFormat: 5,
          factory: async () => runtime, assertMutationAllowed: () => {}});
        try {
          const lease = await manager.acquire(copied.projectId, 'window');
          if (!stale) {
            assert.equal(lease.host.store.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT5_PROJECT_SCHEMA_VERSION);
            assert.equal(lease.host.store.historyState, 'fresh'); lease.release();
          } else {
            const recovery = lease.host.recovery;
            assert.ok(recovery, 'stale history must yield a recovery session');
            const status = recovery.status();
            assert.equal(status.state, 'diverged');
            let input: Record<string, unknown> = {projectId: copied.projectId, requestId: randomUUID(), action, expected: status.file,
              historyIdentity: status.historyIdentity, confirmationDigest: status.confirmationDigest};
            if (action === 'restore-version') {
              assert.ok(recovery.listVersions({projectId: copied.projectId}).versions.some(version => version.id === copied.versionId));
              const preview = recovery.previewVersion({projectId: copied.projectId, versionId: copied.versionId});
              assert.equal(preview.restoreAvailable, true);
              input = {...input, versionId: copied.versionId, previewDigest: preview.previewDigest};
            }
            lease.release();
            const result = await manager.resolveHistory(input as never);
            assert.equal(result.activation, 'pending');
            const reopened = await manager.acquire(copied.projectId, 'window');
            assert.equal(reopened.host.store.historyState, 'current');
            if (action === 'restore-version') assert.equal((reopened.host.store.get('projects', copied.projectId) as {name?: string} | null)?.name, 'Copied project');
            reopened.release();
          }
          await manager.close(copied.projectId);
        } finally {await manager.closeAll();}
      } finally {rmSync(base, {recursive: true, force: true});}
    });
  }
});
