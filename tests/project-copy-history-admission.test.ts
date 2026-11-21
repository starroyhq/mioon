import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
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
    const store = createProjectStore({projectId, projectFile, format5: true, locate: () => location});
    ensureProjectRow(store, {name: 'Copied project'}); store.close();
    const historyFile = path.join(location.localDir, 'history.db'), oldHistory = path.join(a, 'old-history.db');
    copyFileSync(historyFile, oldHistory);
    const reopened = openProjectStore({projectFile, format5: true, locate: () => location});
    const row = reopened.get('projects', projectId) as Record<string, unknown>; reopened.put('projects', {...row, name: 'Edited after copy', revision: 2}); reopened.close();
    const copied = path.join(privateRoot(b, 'projects', 'copy'), 'copy.mioon');
    copyFileSync(projectFile, copied);
    if (existsSync(path.join(path.dirname(projectFile), 'media'))) cpSync(path.join(path.dirname(projectFile), 'media'), path.join(path.dirname(copied), 'media'), {recursive: true});
    if (staleHistory) {const target = path.join(b, 'records', projectId, 'history.db'); mkdirSync(path.dirname(target), {recursive: true, mode: 0o700}); copyFileSync(oldHistory, target);}
    return {projectId, projectFile: copied};
  }
  const created = createServerProject(a, {name: 'Copied project', projectFormat: format as ProjectFileFormat});
  const {projectId, store} = created; const sourceProjectFile = store.projectFile;
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
  return {projectId, projectFile: copied};
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
test('copying the project file with stale local history enters recovery and resolves (formats 3/4 real server)', async t => {
  for (const format of [3, 4] as const) await t.test(`format ${format}`, async () => {
    const base = root(), a = path.join(base, 'a'), b = path.join(base, 'b'); privateRoot(a); privateRoot(b);
    t.after(() => rmSync(base, {recursive: true, force: true}));
    const copied = prepareCopiedProject(a, b, format, true);
    await withServer(b, format, async url => {
      const blocked = await projectGet(url, copied.projectId);
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
      assert.equal(blocked.body.error?.code, 'PROJECT_HISTORY_DIVERGED');
      const status = await historyStatus(url, copied.projectId);
      assert.equal(status.status, 200);
      assert.equal(status.body.data?.state, 'diverged');
      const data = status.body.data!;
      const response = await fetch(`${url}/api/projects/${copied.projectId}/history/resolve`, {method: 'POST', headers,
        body: JSON.stringify({projectId: copied.projectId, requestId: randomUUID(), action: 'continue', expected: data.file,
          historyIdentity: data.historyIdentity, confirmationDigest: data.confirmationDigest})});
      assert.equal(response.status, 200, await response.text());
      const reopened = await projectGet(url, copied.projectId);
      assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    });
  });
});
test('format 5 copied project opens fresh, and stale history enters the real host recovery session', async () => {
  const runtime = {handle: async () => false, isBusy: () => false, interrupt() {}, drain: async () => {}, dispose() {}};
  for (const stale of [false, true]) {
    const base = root(), a = path.join(base, 'a'), b = path.join(base, 'b'); privateRoot(a); privateRoot(b);
    try {
      const copied = prepareCopiedProject(a, b, 5, stale);
      const registry = createMemoryProjectRegistry();
      registry.upsert({projectId: copied.projectId, projectFile: copied.projectFile, fileIdentity: statProjectFileIdentity(copied.projectFile)!, name: 'Copied project', lastOpenedAt: null, summary: null});
      const runtime = {handle: async () => false, isBusy: () => false, interrupt() {}, drain: async () => {}, dispose() {}};
      const manager = createProjectHostManager({directories: serverAppDirectories(b), registry, format5: true,
        factory: async () => runtime, assertMutationAllowed: () => {}});
      try {
        const lease = await manager.acquire(copied.projectId, 'window');
        if (!stale) {
          assert.equal(lease.host.store.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT5_PROJECT_SCHEMA_VERSION);
          assert.equal(lease.host.store.historyState, 'fresh'); lease.release();
        } else {
          const status = lease.host.recovery?.status();
          assert.ok(status, 'stale history must yield a recovery session');
          assert.equal(status.state, 'diverged');
          lease.release();
          const result = await manager.resolveHistory({projectId: copied.projectId, requestId: randomUUID(), action: 'continue', expected: status.file,
            historyIdentity: status.historyIdentity, confirmationDigest: status.confirmationDigest});
          assert.equal(result.activation, 'pending');
          const reopened = await manager.acquire(copied.projectId, 'window');
          assert.equal(reopened.host.store.historyState, 'current'); reopened.release();
        }
        await manager.close(copied.projectId);
      } finally {await manager.closeAll();}
    } finally {rmSync(base, {recursive: true, force: true});}
  }
});
