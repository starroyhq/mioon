import {testEnv} from './helpers/test-env.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as pause} from 'node:timers/promises';
import {startServer, type InspectApplication, type InspectProject, type ServerOptions} from './helpers/test-server.ts';
import {serverAppDirectories, projectLocation} from '../apps/server/src/project-host/directories.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import {createProjectCopies} from '../apps/server/src/project-host/copies.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {openProjectStore, isProjectFileHeld} from '../packages/business/src/project-file/index.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {HISTORY_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {projectCopyResponseSchema} from '../packages/contracts/src/project-copies.ts';
import type {ProjectCopyResponse, ProjectCopyToInput} from '../packages/contracts/src/project-copies.ts';
import type {ProjectVersionSaveResponse} from '../packages/contracts/src/project-version-operations.ts';
import {readProjectState, changeMarks} from './helpers/project-state.ts';

const token = 'synthetic-s5b-copy-to-token';
interface Wire<T> {ok: boolean; data?: T; error?: {code: string; details?: unknown}}
const snapshot = (db: DatabaseSync) => ({...readProjectState(db), marks: changeMarks(db)});
function tree(directory: string): unknown {
  if (!existsSync(directory)) return null;
  return readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), info = lstatSync(file, {bigint: true});
    assert.equal(info.isSymbolicLink(), false);
    return {name, dev: String(info.dev), ino: String(info.ino), bytes: info.isDirectory() ? tree(file) : readFileSync(file).toString('base64')};
  });
}
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-s5b-copy-to-'));
  const dataDir = path.join(root, 'app'), targets = path.join(root, 'targets'); mkdirSync(targets);
  let inspect!: InspectProject, application!: InspectApplication;
  let boundary: ServerOptions['projectCopyActionBoundaryForTest'];
  const server = await startServer({dataDir, token, port: 0, inspectProject: value => {inspect = value;}, inspectApplication: value => {application = value;},
    projectCopyActionBoundaryForTest: (phase, input) => boundary?.(phase, input)});
  t.after(async () => {await server.close(); rmSync(root, {recursive: true, force: true});});
  const rpc = async <T = unknown>(operation: string, input: unknown, projectId?: string) => {
    const response = await fetch(server.url + (projectId ? `/api/projects/${projectId}/rpc` : '/api/rpc'), {
      method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
    return {status: response.status, body: await response.json() as Wire<T>};
  };
  const source = await server.projectEntries.create({name: 'Closed source'}), windowId = randomUUID();
  await server.projectEntries.acquire({projectId: source.projectId, windowId});
  const saved = await rpc<ProjectVersionSaveResponse>('project.version.save', {projectId: source.projectId, requestId: randomUUID(), name: 'Portable checkpoint'}, source.projectId);
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.ok(saved.body.data);
  const versions = inspect(source.projectId, db => db.prepare('SELECT id FROM project_versions ORDER BY id').all().map(row => String(row.id)));
  assert.ok(versions.length >= 2);
  const stamp = inspect(source.projectId, readProjectContentStamp);
  server.projectEntries.release({windowId});
  const deadline = performance.now() + 10_000;
  while (isProjectFileHeld(source.fileIdentity)) {assert.ok(performance.now() < deadline); await pause(5);}
  const selected = path.join(root, 'Read only candidate.mioon'); copyFileSync(source.projectFile, selected);
  const directories = serverAppDirectories(dataDir), local = projectLocation(directories, source.projectId);
  const input = (): ProjectCopyToInput => {
    const info = lstatSync(selected, {bigint: true});
    return {sourceProjectId: source.projectId, sourceFile: selected, sourceIdentity: {dev: String(info.dev), ino: String(info.ino)},
      sourceStamp: stamp, requestId: randomUUID(), projectFile: path.join(targets, 'Copied.mioon')};
  };
  const sourceFiles = () => ({source: readFileSync(source.projectFile).toString('base64'), selected: readFileSync(selected).toString('base64'), records: tree(local.localDir)});
  return {root, dataDir, targets, server, rpc, source, selected, directories, local, stamp, input, versions, manualId: saved.body.data.version.id,
    sourceFiles, application, setBoundary: (value: typeof boundary) => {boundary = value;},
    registrations: () => server.projectEntries.listRecent().registered.map(value => value.project)};
}
function denied(result: {status: number; body: Wire<unknown>}, status: number, code: string): void {
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.ok, false); assert.equal(result.body.error?.code, code);
}

for (const [systemCode, status, code] of [
  ['EACCES', 403, 'EACCES'], ['EPERM', 403, 'EPERM'], ['EROFS', 422, 'PROJECT_INVALID'],
  ['ENOSPC', 507, 'PROJECT_COPY_CAPACITY'], ['EDQUOT', 507, 'PROJECT_COPY_CAPACITY'],
  ['ENOENT', 400, 'PROJECT_LOCATION_INVALID'], ['ENOTDIR', 400, 'PROJECT_LOCATION_INVALID'], ['EEXIST', 409, 'PROJECT_FILE_EXISTS'],
] as const) test(`copy-to reports ${systemCode} precisely without source writes or a published outcome`, async t => {
  const f = await fixture(t), input = f.input(), before = f.sourceFiles(), registered = f.registrations();
  f.setBoundary(phase => {if (phase === 'prepared') throw Object.assign(Error('synthetic filesystem failure'), {code: systemCode});});
  const result = await f.rpc('project.copy-to', input); denied(result, status, code);
  if (systemCode === 'EROFS') assert.deepEqual(result.body.error?.details, {database: 'project', reason: 'read-only'});
  assert.deepEqual(f.sourceFiles(), before); assert.deepEqual(f.registrations(), registered); assert.deepEqual(readdirSync(f.targets), []);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
});
async function occupyHistory(file: string): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA locking_mode=EXCLUSIVE;BEGIN EXCLUSIVE');process.send('locked');
    process.once('message',()=>{db.exec('ROLLBACK');db.close();process.disconnect();});
  `, file], {env: testEnv(), stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => reject(Error(`history holder ended before release: ${code}`)));
      child.once('message', message => {if (message === 'locked') resolve(); else reject(Error('unexpected history holder message'));});
    });
  } catch (error) {child.kill('SIGKILL'); throw error;}
  return async () => {const ended = once(child, 'exit'); child.send('release'); const [code, signal] = await ended; assert.equal(code, 0); assert.equal(signal, null);};
}

for (const state of ['current', 'diverged'] as const) test(`copy-to reads all ${state} local versions without changing source, registration or execution records`, async t => {
  const f = await fixture(t);
  if (state === 'diverged') {
    // Simulate a legitimate later file edit; persisted triggers change its
    // content identity while the old local history remains untouched.
    const raw = new DatabaseSync(f.selected);
    try {raw.prepare("UPDATE projects SET data=json_set(data,'$.name','Selected branch','$.revision',2) WHERE id=?").run(f.source.projectId);} finally {raw.close();}
  }
  const input = f.input();
  if (state === 'diverged') {
    const raw = new DatabaseSync(f.selected, {readOnly: true});
    try {input.sourceStamp = readProjectContentStamp(raw, 'main');} finally {raw.close();}
    assert.notDeepEqual(input.sourceStamp, f.stamp);
  }
  const before = f.sourceFiles(), registrations = f.registrations();
  const result = await f.rpc<ProjectCopyResponse>('project.copy-to', input);
  assert.equal(result.status, 200, JSON.stringify(result.body)); const copy = projectCopyResponseSchema.parse(result.body.data);
  assert.equal(copy.versions, f.versions.length); assert.deepEqual(f.sourceFiles(), before);
  assert.deepEqual(f.registrations().find(value => value.projectId === f.source.projectId), registrations[0]);
  const store = openProjectStore({projectFile: copy.project.projectFile, locate: id => projectLocation(f.directories, id)});
  try {
    assert.equal(store.historyState, 'current'); assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()!.version, HISTORY_SCHEMA_VERSION);
    assert.deepEqual(createProjectVersions(store).list({projectId: copy.project.projectId}).versions.map(value => value.id).sort(), [...f.versions].sort());
    assert.equal(createProjectVersions(store).list({projectId: copy.project.projectId}).versions.some(value => value.id === f.manualId), true);
    for (const table of HISTORY_TABLES.filter(name => !['project_versions', 'project_version_blobs', 'mio_storage_counters'].includes(name)))
      assert.equal(store.db.prepare(`SELECT count(*) n FROM main.${table}`).get()!.n, table === 'history_state' ? 1 : 0, table);
    assert.deepEqual(readProjectContentStamp(store.db), {contentSequence: copy.contentSequence, contentToken: copy.contentToken});
  } finally {store.close();}
  assert.deepEqual((await f.rpc('project.copy-to', input)).body.data, copy);
  assert.deepEqual(f.sourceFiles(), before);
});

test('trusted copy-to stages format 4 with retained named versions from either source format', async t => {
  const f = await fixture(t);
  await f.server.close();
  const before = f.sourceFiles(), input = f.input();
  const library = openAppLibrary({dataDir: f.dataDir}), owner = new AbortController();
  const manager = createProjectHostManager({directories: f.directories, registry: library.registry,
    factory: async () => assert.fail('closed-source copy must not create a project runtime')});
  const copies = createProjectCopies({manager, library, directories: f.directories, signal: owner.signal,
    targetFormat: FORMAT4_PROJECT_SCHEMA_VERSION, assertProjectFile: createApplicationFileGuard(f.directories)});
  try {
    const copied = await copies.copyTo(input);
    assert.equal(copied.versions, f.versions.length);
    assert.deepEqual(await copies.copyTo(input), copied);
    const store = openProjectStore({projectFile: copied.project.projectFile, locate: id => projectLocation(f.directories, id), format4: {}});
    let firstEpoch: unknown;
    try {
      assert.equal(store.historyState, 'current');
      assert.equal(store.db.prepare('SELECT version FROM project.schema_version').get()?.version, FORMAT4_PROJECT_SCHEMA_VERSION);
      assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()?.version, FORMAT4_HISTORY_SCHEMA_VERSION);
      assert.deepEqual(createProjectVersions(store).list({projectId: copied.project.projectId}).versions.map(value => value.id).sort(), [...f.versions].sort());
      assert.deepEqual(readProjectContentStamp(store.db), {contentSequence: copied.contentSequence, contentToken: copied.contentToken});
      firstEpoch = store.db.prepare('SELECT epoch FROM main.canvas_receipt_window').get()?.epoch;
      assert.match(String(firstEpoch), /^[0-9a-f]{32}$/u);
    } finally {store.close();}
    const next = await copies.copyTo({sourceProjectId: copied.project.projectId, sourceFile: copied.project.projectFile,
      sourceIdentity: copied.project.fileIdentity, sourceStamp: {contentSequence: copied.contentSequence, contentToken: copied.contentToken},
      requestId: randomUUID(), projectFile: path.join(f.targets, 'Second copy.mioon')});
    assert.equal(next.versions, f.versions.length);
    const second = openProjectStore({projectFile: next.project.projectFile, locate: id => projectLocation(f.directories, id), format4: {}});
    try {
      assert.equal(second.historyState, 'current');
      assert.equal(second.db.prepare('SELECT version FROM project.schema_version').get()?.version, FORMAT4_PROJECT_SCHEMA_VERSION);
      assert.equal(second.db.prepare('SELECT version FROM main.schema_version').get()?.version, FORMAT4_HISTORY_SCHEMA_VERSION);
      const window = second.db.prepare('SELECT epoch,floor FROM main.canvas_receipt_window').get();
      assert.match(String(window?.epoch), /^[0-9a-f]{32}$/u);
      assert.notEqual(window?.epoch, firstEpoch);
      assert.equal(window?.floor, 0);
    } finally {second.close();}
    assert.deepEqual(f.sourceFiles(), before);
  } finally {await copies.drain(); await manager.closeAll(); library.close();}
});

test('copy-to without local history creates only target records and does not create source records', async t => {
  const f = await fixture(t); rmSync(f.local.localDir, {recursive: true});
  const before = f.sourceFiles(), input = f.input();
  const result = await f.rpc<ProjectCopyResponse>('project.copy-to', input);
  assert.equal(result.status, 200, JSON.stringify(result.body)); const copy = projectCopyResponseSchema.parse(result.body.data);
  assert.equal(copy.versions, 0); assert.equal(existsSync(f.local.localDir), false); assert.deepEqual(f.sourceFiles(), before);
  assert.equal(existsSync(projectLocation(f.directories, copy.project.projectId).localDir), true);
});

for (const damage of ['corrupt', 'occupied'] as const) test(`copy-to with ${damage} local history rejects the whole request without publishing or silently dropping versions`, async t => {
  const f = await fixture(t), history = path.join(f.local.localDir, 'history.db'), input = f.input();
  if (damage === 'corrupt') writeFileSync(history, 'corrupt local history');
  const recordsRoot = path.dirname(f.local.localDir);
  const before = f.sourceFiles(), registered = f.registrations(), recordsBefore = readdirSync(recordsRoot).sort();
  let release: (() => Promise<void>) | undefined, result: Awaited<ReturnType<typeof f.rpc>>;
  if (damage === 'occupied') release = await occupyHistory(history);
  try {result = await f.rpc('project.copy-to', input);} finally {await release?.();}
  denied(result, damage === 'corrupt' ? 422 : 409, damage === 'corrupt' ? 'PROJECT_INVALID' : 'PROJECT_LOCKED');
  assert.deepEqual(f.sourceFiles(), before); assert.deepEqual(f.registrations(), registered); assert.deepEqual(readdirSync(f.targets), []);
  assert.deepEqual(readdirSync(recordsRoot).sort(), recordsBefore);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
});

test('copy-to rechecks selected inode after preparation even when a replacement has the exact same project and content pair', async t => {
  const f = await fixture(t), input = f.input(), before = f.sourceFiles(), registered = f.registrations();
  const recordsRoot = path.dirname(f.local.localDir), recordsBefore = readdirSync(recordsRoot).sort();
  f.setBoundary(phase => {
    if (phase !== 'prepared') return;
    const alternate = path.join(f.root, 'Same pair other inode.mioon');
    copyFileSync(f.selected, alternate); renameSync(alternate, f.selected);
  });
  denied(await f.rpc('project.copy-to', input), 409, 'PROJECT_COPY_SOURCE_CHANGED');
  assert.notEqual(lstatSync(f.selected, {bigint: true}).ino.toString(), input.sourceIdentity.ino);
  assert.deepEqual(f.sourceFiles(), before); assert.deepEqual(f.registrations(), registered);
  assert.deepEqual(readdirSync(f.targets), []); assert.deepEqual(readdirSync(recordsRoot).sort(), recordsBefore);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
});

test('copy-to refuses a source host opened after preparation without closing its new window or creating a target', async t => {
  const f = await fixture(t), input = f.input(), windowId = randomUUID();
  const selectedBefore = readFileSync(f.selected).toString('base64');
  let opened: Awaited<ReturnType<typeof f.server.projectEntries.acquire>> | undefined;
  f.setBoundary(async phase => {if (phase === 'prepared') opened = await f.server.projectEntries.acquire({projectId: f.source.projectId, windowId});});
  try {
    denied(await f.rpc('project.copy-to', input), 409, 'PROJECT_HOST_BUSY');
    assert.ok(opened); assert.deepEqual(await f.server.projectEntries.acquire({projectId: f.source.projectId, windowId}), opened);
    assert.equal(isProjectFileHeld(f.source.fileIdentity), true);
    assert.equal(existsSync(input.projectFile), false); assert.deepEqual(readdirSync(f.targets), []);
    assert.deepEqual(f.registrations().map(value => value.projectId), [f.source.projectId]);
    assert.equal(readFileSync(f.selected).toString('base64'), selectedBefore);
    assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
  } finally {f.server.projectEntries.release({windowId});}
});

for (const mode of ['aborted', 'reopened-library'] as const) test(`the ${mode} application owner cannot use any S5-B write capability`, async t => {
  const f = await fixture(t); await f.server.close();
  const library = openAppLibrary({dataDir: f.dataDir}), owner = new AbortController();
  const application = createProjectServiceApplication(library, owner.signal);
  const manager = createProjectHostManager({directories: f.directories, registry: library.registry, assertMutationAllowed: application.assertMutationAllowed,
    factory: async () => {assert.fail('a selected closed file must not compose a source runtime');}});
  const copies = createProjectCopies({manager, library, directories: f.directories, signal: owner.signal, assertProjectFile: createApplicationFileGuard(f.directories)});
  let replacement: ReturnType<typeof openAppLibrary> | undefined;
  try {
    const reason = Error('application owner aborted');
    if (mode === 'aborted') owner.abort(reason); else {library.close(); replacement = openAppLibrary({dataDir: f.dataDir});}
    const current = replacement ?? library;
    const before = {source: f.sourceFiles(), app: snapshot(current.db), targets: tree(f.targets), intents: tree(path.join(f.dataDir, 'project-copy-actions'))};
    const {projectFile: _target, ...adopt} = f.input();
    for (const call of [() => copies.copyTo(f.input()), () => copies.adoptCopy(adopt),
      () => copies.instantiateTemplate({templateId: 'not-configured', templateVersion: 1, parentDir: f.targets, name: 'No write', requestId: randomUUID()})]) {
      await assert.rejects(call, error => {
        if (mode === 'aborted') assert.equal(error, reason);
        else {assert.ok(error instanceof TypeError); assert.equal(error.message, 'Project services require a live application library owner');}
        return true;
      });
      assert.deepEqual({source: f.sourceFiles(), app: snapshot(current.db), targets: tree(f.targets), intents: tree(path.join(f.dataDir, 'project-copy-actions'))}, before);
    }
  } finally {await copies.drain(); await manager.closeAll(); library.close(); replacement?.close();}
});
