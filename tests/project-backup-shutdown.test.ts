import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import type {DatabaseSync} from 'node:sqlite';
import {startServer} from '../apps/server/src/index.ts';
import {createServerProject} from './helpers/project-database.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {serverAppDirectories, projectLocation} from '../apps/server/src/project-host/directories.ts';
import {openProjectStore,copyProjectBackup} from '../packages/business/src/project-file/index.ts';
import {openAppDatabase, isAppLibraryHeld} from '../packages/business/src/app-db/connection.ts';
import {acquireWorkspaceLock} from '../packages/business/src/workspace-lock.ts';
import type {ProjectBackupRestoreResponse, ProjectBackupSummary} from '../packages/contracts/src/project-backups.ts';

const token = 'synthetic-v2-backup-shutdown-token';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('HTTP force-close keeps application library and lock until an accepted backup restore drains', {timeout: 20_000}, async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'project-backup-shutdown-'));
  const seed = createServerProject(root, {name: 'Restore during shutdown'}), assetId = randomUUID();
  const source = path.join(seed.store.projectDir, 'media', `${assetId}.png`);
  fs.writeFileSync(source, png, {mode: 0o600});
  seed.store.put('assets', {id: assetId, projectId: seed.projectId, kind: 'image', name: 'Fixture image', mimeType: 'image/png',
    relativePath: `media/${assetId}.png`, sha256: createHash('sha256').update(png).digest('hex'), sizeBytes: png.length, width: 1, height: 1});
  seed.store.close();

  let appDb!: DatabaseSync;
  let server = await startServer({dataDir: root, port: 0, token});
  const gate = Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
  let blocked=false;
  let close: Promise<void> | undefined;
  t.after(async () => {
    gate.resolve(); t.mock.restoreAll(); syncBuiltinESMExports();
    await close?.catch(() => {}); await server.close().catch(() => {});
    fs.rmSync(root, {recursive: true, force: true});
  });
  const rpc = async <T>(operation: string, input: unknown, route = '/api/rpc'): Promise<T> => {
    const response = await fetch(server.url + route, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
    const result = await response.json() as {ok: boolean; data: T};
    assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.ok, true);
    return result.data;
  };
  // The normal host hooks make a real private backup containing the referenced
  // asset. Restart with every project closed before starting app-level recovery.
  await rpc('project.get', {projectId: seed.projectId}, projectRpcPath(seed.projectId));
  await server.close();
  server = await startServer({dataDir: root, port: 0, token, inspectApplication: inspect => {appDb = inspect(db => db);},projectBackupCopyForTest:async options=>{blocked=true;entered.resolve();await gate.promise;return copyProjectBackup(options);}});
  const list = await rpc<{backups: ProjectBackupSummary[]}>('project.backup.list', {projectId: seed.projectId});
  assert.ok(list.backups.length > 0);
  const targetDir = path.join(root, 'projects', 'Restored'); fs.mkdirSync(targetDir, {mode: 0o755});
  const input = {projectId: seed.projectId, backupId: list.backups[0]!.backupId, requestId: randomUUID(), projectFile: path.join(targetDir, 'Restored.mioon')};
  const socketClosed=Promise.withResolvers<void>(),originalTimer=globalThis.setTimeout;
  let forceCalls=0,closeFinished=false;const serverBudgets:number[]=[];
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof originalTimer>) => {
    const stack = new Error().stack?.replaceAll('\\', '/') ?? '';
    if (stack.includes('/apps/server/src/index.ts') && args[1] === 3000) {
      return originalTimer(() => {forceCalls++; Reflect.apply(args[0], globalThis, args.slice(2));}, 1);
    }
    if (stack.includes('/apps/server/src/index.ts') && stack.includes('boundedShutdown') && args[1] === 5000) serverBudgets.push(args[1]);
    return originalTimer(...args);
  });
  const request = fetch(server.url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation: 'project.backup.restore', input})})
    .then(async response => {await response.arrayBuffer();throw new Error('The blocked restore must lose its HTTP observer during force-close');}, error => {socketClosed.resolve(); return error as unknown;});
  await entered.promise;
  assert.equal(blocked, true);
  assert.equal(fs.existsSync(input.projectFile), false, 'copy is paused before target publication');
  close = server.close().then(() => {closeFinished = true;});
  await socketClosed.promise;
  assert.equal(forceCalls, 1, 'the actual server force-drain closes the request socket');
  const outcome = await Promise.race([close.then(() => 'closed'), new Promise<string>(resolve => originalTimer(() => resolve('pending'), 30))]);
  assert.equal(outcome, 'pending', 'socket drain does not finish an accepted application restore');
  assert.equal(closeFinished, false);
  assert.equal(appDb.isOpen, true);
  const appInfo = fs.lstatSync(path.join(root, 'app-library.db'), {bigint: true});
  assert.equal(isAppLibraryHeld({dev: String(appInfo.dev), ino: String(appInfo.ino)}, appDb), true);
  assert.throws(() => openAppDatabase(root), {code: 'APP_LIBRARY_LOCKED'});
  assert.throws(() => acquireWorkspaceLock(root), {code: 'WORKSPACE_BACKUP_LOCKED'});
  assert.equal(fs.existsSync(path.join(root, 'server.lock')), true);
  assert.deepEqual(serverBudgets, [5000], 'the application queue shares the unchanged five-second server drain budget');

  gate.resolve(); await close; await request;
  assert.equal(closeFinished, true); assert.equal(appDb.isOpen, false);
  assert.equal(isAppLibraryHeld({dev: String(appInfo.dev), ino: String(appInfo.ino)}), false);
  assert.equal(fs.existsSync(path.join(root, 'server.lock')), false);
  assert.deepEqual(serverBudgets, [5000, 5000], 'both normal server shutdown budgets remain unchanged');
  t.mock.restoreAll(); syncBuiltinESMExports(); close = undefined;

  server = await startServer({dataDir: root, port: 0, token});
  const restored = await rpc<ProjectBackupRestoreResponse>('project.backup.restore', input);
  assert.notEqual(restored.project.projectId, seed.projectId);
  assert.equal(restored.project.projectFile, input.projectFile);
  assert.deepEqual(await rpc('project.backup.restore', input), restored, 'lost response is recovered through the same durable intent');
  await server.close();
  const directories = serverAppDirectories(root), store = openProjectStore({projectFile: input.projectFile, locate: id => projectLocation(directories, id)});
  try {
    assert.equal(store.projectId, restored.project.projectId);
    const asset = store.get('assets', assetId) as {projectId: string; reference:{path:string}};
    assert.equal(asset.projectId, restored.project.projectId);
    assert.deepEqual(fs.readFileSync(path.resolve(targetDir, asset.reference.path)),png);assert.equal(fs.existsSync(path.join(targetDir,'media')),false);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM main.mio_runs').get()?.n), 0);
  } finally {store.close();}
});
