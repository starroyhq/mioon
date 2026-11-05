import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {startServer, type InspectApplication} from '../apps/server/src/index.ts';
import {createLocalRecordRpc} from '../apps/server/src/local-record-rpc.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createLocalRecords} from '../packages/business/src/app-db/local-records.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createProjectFile} from '../packages/business/src/project-file/index.ts';
import {projectRpcPath, PROJECT_RECORDS_DIRECTORY} from '../packages/contracts/src/project-file.ts';
import {localRecordsDeleteResponseSchema, localRecordsListResponseSchema} from '../packages/contracts/src/local-record-operations.ts';
import type {LocalRecordsIdentity, LocalRecordsListResponse} from '../packages/contracts/src/local-record-operations.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';

const TOKEN = 'synthetic-local-records-http-token';
type Server = Awaited<ReturnType<typeof startServer>>;
interface Reply {status: number; body: {ok: boolean; data?: unknown; error?: {code: string; details: unknown}}}
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-local-records-http-')), servers: Server[] = [];
  t.after(async () => {for (const server of servers.reverse()) await server.close(); rmSync(root, {recursive: true, force: true});});
  const start = async (dataDir = path.join(root, 'app'), port = 0) => {
    let inspect!: InspectApplication;
    const server = await startServer({dataDir, port, token: TOKEN, inspectApplication: value => {inspect = value;}});
    servers.push(server);
    return {server, application: <T>(read: (db: DatabaseSync) => T): T => inspect(read)};
  };
  return {root, start};
}
function records(dataDir: string, projectId: string, text = 'not a SQLite history database'): string {
  const folder = path.join(dataDir, PROJECT_RECORDS_DIRECTORY, projectId);
  mkdirSync(folder, {recursive: true, mode: 0o700}); writeFileSync(path.join(folder, 'history.db'), text, {mode: 0o600});
  return folder;
}
function tombstone(dataDir: string): string {
  const folder = path.join(dataDir, PROJECT_RECORDS_DIRECTORY, `.deleting-${randomUUID()}-${randomUUID()}`);
  mkdirSync(folder, {recursive: true, mode: 0o700}); writeFileSync(path.join(folder, 'keep'), 'previous confirmed removal', {mode: 0o600});
  return folder;
}
function tree(directory: string): unknown {
  if (!existsSync(directory)) return null;
  return Object.fromEntries(readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = lstatSync(file);
    return [name, stat.isDirectory() ? tree(file) : {mode: stat.mode, bytes: readFileSync(file).toString('base64')}];
  }));
}
async function rpc(server: Server, operation: string, input: unknown, {route = '/api/rpc', auth = true, origin}: {route?: string; auth?: boolean; origin?: string} = {}): Promise<Reply> {
  const response = await fetch(server.url + route, {method: 'POST', headers: {'content-type': 'application/json',
    ...(auth ? {authorization: `Bearer ${TOKEN}`} : {}), ...(origin ? {origin} : {})}, body: JSON.stringify({operation, input})});
  return {status: response.status, body: await response.json() as Reply['body']};
}
const deletion = (identity: LocalRecordsIdentity, projectId: string) => ({projectId,
  expectedAppLibraryScope: identity.appLibraryScope, expectedInstanceId: identity.instanceId});
async function list(server: Server): Promise<LocalRecordsListResponse> {
  const reply = await rpc(server, 'local.records.list', {});
  assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(reply.body.ok, true);
  return localRecordsListResponseSchema.parse(reply.body.data);
}
function refused(reply: Reply, status: number, code: string): void {
  assert.equal(reply.status, status, JSON.stringify(reply.body)); assert.equal(reply.body.ok, false);
  assert.equal(reply.body.error?.code, code);
}
function hotSuperJournal(folder: string): void {
  const magic = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
  const superFile = path.join(folder, 'history.db-mj0DA3D190E'), journal = path.join(folder, 'history.db-journal');
  const name = Buffer.from(superFile, 'utf8'), header = Buffer.alloc(512), tail = Buffer.alloc(16);
  magic.copy(header); header.writeUInt32BE(1, 8); tail.writeUInt32BE(name.length);
  tail.writeUInt32BE(name.reduce((sum, byte) => (sum + byte) >>> 0, 0), 4); magic.copy(tail, 8);
  writeFileSync(journal, Buffer.concat([header, Buffer.alloc(4 + 4096 + 4, 0x5a), Buffer.from([0, 0, 0x40, 0x01]), name, tail]));
  writeFileSync(superFile, `${journal}\0`);
}

test('application list/delete use real orphan records without opening their invalid history or any project', async t => {
  const f = fixture(t), dataDir = path.join(f.root, 'app'), orphan = randomUUID(), registered = randomUUID();
  records(dataDir, orphan); records(dataDir, registered, 'registered old history');
  const library = openAppLibrary({dataDir}), missingFile = path.join(f.root, 'missing', 'Named.mioon');
  library.registry.upsert({projectId: registered, projectFile: missingFile, fileIdentity: {dev: '1', ino: '9999999999999'},
    name: 'Named project', lastOpenedAt: null, summary: null}); library.close();
  const unrelated = path.join(f.root, 'unrelated.mioon'); writeFileSync(unrelated, 'do not touch');
  const {server} = await f.start(dataDir), before = tree(path.join(dataDir, PROJECT_RECORDS_DIRECTORY));
  const snapshot = await list(server), catalog = await fetch(server.url + '/api/project-entries', {headers: {authorization: `Bearer ${TOKEN}`}}).then(value => value.json());
  assert.equal(snapshot.appLibraryScope, catalog.data.appLibraryScope); assert.equal(snapshot.instanceId, catalog.data.instanceId);
  assert.deepEqual(snapshot.records.map(row => row.projectId), [orphan, registered].sort());
  assert.deepEqual(snapshot.records.find(row => row.projectId === orphan), {projectId: orphan,
    sizeBytes: Buffer.byteLength('not a SQLite history database'), hasSuperJournal: false, hasUnfinishedTasks: false, name: null, projectFile: null});
  assert.equal(snapshot.records.find(row => row.projectId === registered)?.name, 'Named project');
  assert.equal(snapshot.records.find(row => row.projectId === registered)?.projectFile, missingFile);
  assert.deepEqual(tree(path.join(dataDir, PROJECT_RECORDS_DIRECTORY)), before);
  const result = await rpc(server, 'local.records.delete', deletion(snapshot, orphan));
  assert.equal(result.status, 200); assert.deepEqual(localRecordsDeleteResponseSchema.parse(result.body.data),
    {projectId: orphan, deleted: true, appLibraryScope: snapshot.appLibraryScope, instanceId: snapshot.instanceId});
  assert.equal(existsSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY, orphan)), false);
  assert.equal(readFileSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY, registered, 'history.db'), 'utf8'), 'registered old history');
  assert.equal(readFileSync(unrelated, 'utf8'), 'do not touch');
  refused(await rpc(server, 'local.records.delete', deletion(snapshot, orphan)), 404, 'LOCAL_RECORDS_NOT_FOUND');
  assert.deepEqual((await list(server)).records.map(row => row.projectId), [registered]);
});

test('strict input, authentication, origin and both expected identities reject before even sweeping a tombstone', async t => {
  const f = fixture(t), dataDir = path.join(f.root, 'app'), projectId = randomUUID(); records(dataDir, projectId);
  const {server} = await f.start(dataDir), identity = await list(server), input = deletion(identity, projectId);
  tombstone(dataDir); const before = tree(path.join(dataDir, PROJECT_RECORDS_DIRECTORY));
  for (const invalid of [undefined, null, false, [], {projectId}, {...input, path: '/tmp/arbitrary'}, {...input, expectedInstanceId: 'bad'}]) {
    refused(await rpc(server, 'local.records.delete', invalid), 400, 'VALIDATION_ERROR');
  }
  for (const invalid of [undefined, null, false, [], {path: '/tmp/arbitrary'}]) refused(await rpc(server, 'local.records.list', invalid), 400, 'VALIDATION_ERROR');
  refused(await rpc(server, 'local.records.delete', input, {auth: false}), 401, 'UNAUTHORIZED');
  refused(await rpc(server, 'local.records.delete', input, {origin: 'https://untrusted.invalid'}), 403, 'ORIGIN_REJECTED');
  refused(await rpc(server, 'local.records.delete', {...input, expectedAppLibraryScope: 'f'.repeat(64)}), 409, 'LOCAL_RECORDS_IDENTITY_CHANGED');
  refused(await rpc(server, 'local.records.delete', {...input, expectedInstanceId: randomUUID()}), 409, 'LOCAL_RECORDS_IDENTITY_CHANGED');
  assert.deepEqual(tree(path.join(dataDir, PROJECT_RECORDS_DIRECTORY)), before);
});

test('the same origin/token after a same-library restart rejects the old instance before any file effect', async t => {
  const f = fixture(t), dataDir = path.join(f.root, 'app'), projectId = randomUUID(); records(dataDir, projectId);
  const first = await f.start(dataDir), old = await list(first.server), port = first.server.port;
  await first.server.close(); const {server} = await f.start(dataDir, port);
  tombstone(dataDir); const before = tree(path.join(dataDir, PROJECT_RECORDS_DIRECTORY));
  refused(await rpc(server, 'local.records.delete', deletion(old, projectId)), 409, 'LOCAL_RECORDS_IDENTITY_CHANGED');
  assert.deepEqual(tree(path.join(dataDir, PROJECT_RECORDS_DIRECTORY)), before);
  const current = await list(server); assert.equal(current.appLibraryScope, old.appLibraryScope); assert.notEqual(current.instanceId, old.instanceId);
  const result = await rpc(server, 'local.records.delete', deletion(current, projectId)); assert.equal(result.status, 200);
  assert.equal(existsSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY, projectId)), false);
});

test('a replacement library on the identical origin/token cannot execute an old confirmation for its same project ID', async t => {
  const f = fixture(t), dataA = path.join(f.root, 'app-a'), dataB = path.join(f.root, 'app-b'), projectId = randomUUID();
  records(dataA, projectId, 'A only'); records(dataB, projectId, 'B only');
  const first = await f.start(dataA), old = await list(first.server), port = first.server.port;
  await first.server.close(); const {server} = await f.start(dataB, port);
  tombstone(dataB); const beforeA = tree(dataA), beforeB = tree(path.join(dataB, PROJECT_RECORDS_DIRECTORY));
  refused(await rpc(server, 'local.records.delete', deletion(old, projectId)), 409, 'LOCAL_RECORDS_IDENTITY_CHANGED');
  assert.deepEqual(tree(dataA), beforeA); assert.deepEqual(tree(path.join(dataB, PROJECT_RECORDS_DIRECTORY)), beforeB);
  const current = await list(server); assert.notEqual(current.appLibraryScope, old.appLibraryScope); assert.notEqual(current.instanceId, old.instanceId);
  assert.equal((await rpc(server, 'local.records.delete', deletion(current, projectId))).status, 200);
  assert.equal(readFileSync(path.join(dataA, PROJECT_RECORDS_DIRECTORY, projectId, 'history.db'), 'utf8'), 'A only');
});

test('list retains the existing confirmed-tombstone recovery effect without removing normal records', async t => {
  const f = fixture(t), dataDir = path.join(f.root, 'app'), id = randomUUID(), folder = records(dataDir, id), old = tombstone(dataDir);
  const {server} = await f.start(dataDir); assert.equal(existsSync(old), true);
  assert.deepEqual((await list(server)).records.map(row => row.projectId), [id]);
  assert.equal(existsSync(old), false); assert.equal(readFileSync(path.join(folder, 'history.db'), 'utf8'), 'not a SQLite history database');
});

test('task and hot-super-journal protection coexist in the real HTTP list and retain exact refusal priority', async t => {
  const f = fixture(t), dataDir = path.join(f.root, 'app'), id = randomUUID(), journalOnly = randomUUID();
  hotSuperJournal(records(dataDir, id)); hotSuperJournal(records(dataDir, journalOnly));
  const library = openAppLibrary({dataDir});
  library.taskIndex.upsert({projectId: id, projectFile: path.join(f.root, 'unavailable.mioon'), kind: 'job', taskId: randomUUID(),
    indexedAt: '2026-11-04T00:00:00.000Z', phase: 'blocked', reason: 'SOURCE_UNAVAILABLE'}); library.close();
  const {server, application} = await f.start(dataDir), current = await list(server), before = tree(path.join(dataDir, PROJECT_RECORDS_DIRECTORY));
  const index = application(db => db.prepare('SELECT data FROM background_task_index ORDER BY projectId,kind,taskId').all());
  const row = current.records.find(item => item.projectId === id)!;
  assert.deepEqual([row.hasUnfinishedTasks, row.hasSuperJournal], [true, true]);
  assert.deepEqual([current.records.find(item => item.projectId === journalOnly)?.hasUnfinishedTasks,
    current.records.find(item => item.projectId === journalOnly)?.hasSuperJournal], [false, true]);
  refused(await rpc(server, 'local.records.delete', deletion(current, id)), 409, 'LOCAL_RECORDS_IN_USE');
  refused(await rpc(server, 'local.records.delete', deletion(current, journalOnly)), 409, 'LOCAL_RECORDS_SUPER_JOURNAL');
  assert.deepEqual(tree(path.join(dataDir, PROJECT_RECORDS_DIRECTORY)), before);
  assert.deepEqual(application(db => db.prepare('SELECT data FROM background_task_index ORDER BY projectId,kind,taskId').all()), index);
});

test('a local-record operation at a project address is rejected before project/history creation', async t => {
  const f = fixture(t), dataDir = path.join(f.root, 'app'), projectFile = path.join(f.root, 'Film.mioon');
  const id = createProjectFile(projectFile), library = openAppLibrary({dataDir});
  library.registry.upsert({projectId: id, projectFile, fileIdentity: library.projectFileIdentity(projectFile)!, name: 'Film', lastOpenedAt: null, summary: null}); library.close();
  const {server} = await f.start(dataDir), identity = await list(server), before = tree(dataDir), bytes = readFileSync(projectFile);
  refused(await rpc(server, 'local.records.list', {}, {route: projectRpcPath(id)}), 400, 'VALIDATION_ERROR');
  refused(await rpc(server, 'local.records.delete', deletion(identity, id), {route: projectRpcPath(id)}), 400, 'VALIDATION_ERROR');
  assert.deepEqual(tree(dataDir), before); assert.deepEqual(readFileSync(projectFile), bytes);
  assert.equal(existsSync(path.join(dataDir, PROJECT_RECORDS_DIRECTORY, id)), false);
});

test('an uncertain deletion result cannot be fabricated as not-found, not-applied or successful receipt', async t => {
  const f = fixture(t), dataDir = path.join(f.root, 'app'), id = randomUUID(), folder = records(dataDir, id);
  const library = openAppLibrary({dataDir}); t.after(() => library.close());
  const identity = {appLibraryScope: 'a'.repeat(64), instanceId: randomUUID()}; let calls = 0;
  const service = createLocalRecordRpc({readIdentity: () => identity, assertMutationAllowed: createProjectServiceApplication(library).assertMutationAllowed,
    store: {list: library.localRecords.list, delete: async projectId => {calls++; await library.localRecords.delete(projectId); throw Error('synthetic delivery lost after real deletion');}}});
  await assert.rejects(service.call('local.records.delete', deletion(identity, id)), error => {
    assert.ok(error instanceof AppError); assert.equal(error.code, 'LOCAL_RECORDS_DELETE_UNCERTAIN'); assert.equal(error.status, 503);
    assert.deepEqual(error.details, {...identity, projectId: id, mutationOutcome: 'unknown'}); return true;
  });
  assert.equal(calls, 1); assert.equal(existsSync(folder), false);
  const reconciled = localRecordsListResponseSchema.parse(await service.call('local.records.list', {}));
  assert.deepEqual(reconciled.records, []); assert.equal(calls, 1, 'reconciliation never reissues delete or synthesizes an ACK');
});

test('owner retirement after rename refuses rm and reports unknown while the confirmed tombstone remains recoverable', async t => {
  const f = fixture(t), dataDir = path.join(f.root, 'app'), id = randomUUID(), folder = records(dataDir, id, 'retain until recovery');
  const library = openAppLibrary({dataDir}); t.after(() => library.close());
  const owner = createProjectServiceApplication(library).assertMutationAllowed;
  const identity = {appLibraryScope: 'a'.repeat(64), instanceId: randomUUID()}; let guards = 0;
  const store = createLocalRecords({dataDir, registry: library.registry, identity: library.projectFileIdentity,
    isProjectOpen: () => false, isProjectBackgroundBusy: () => false,
    assertMutationAllowed: () => {if (++guards === 3) library.close(); owner();}});
  const service = createLocalRecordRpc({store, readIdentity: () => identity, assertMutationAllowed: owner});
  await assert.rejects(service.call('local.records.delete', deletion(identity, id)), error => {
    assert.ok(error instanceof AppError); assert.equal(error.code, 'LOCAL_RECORDS_DELETE_UNCERTAIN');
    assert.deepEqual(error.details, {...identity, projectId: id, mutationOutcome: 'unknown'}); return true;
  });
  assert.equal(guards, 3); assert.equal(existsSync(folder), false);
  const remaining = readdirSync(path.dirname(folder)); assert.equal(remaining.length, 1);
  assert.match(remaining[0]!, new RegExp(`^\\.deleting-${id}-[0-9a-f-]{36}$`, 'u'));
  assert.equal(readFileSync(path.join(path.dirname(folder), remaining[0]!, 'history.db'), 'utf8'), 'retain until recovery');
  await assert.rejects(service.call('local.records.list', {}));
  const reopened = openAppLibrary({dataDir}); t.after(() => reopened.close());
  assert.deepEqual(await reopened.localRecords.list(), []); assert.deepEqual(readdirSync(path.dirname(folder)), []);
  assert.equal(guards, 3, 'new-owner recovery continues only the tombstone, never replays the old delete');
});
