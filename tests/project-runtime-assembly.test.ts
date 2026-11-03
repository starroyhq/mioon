import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createServer as createHttpServer} from 'node:http';
import {createAgentClient} from '../packages/client/src/agent.ts';
import {mioStorageSnapshotSchema} from '../packages/contracts/src/mio-storage.ts';
import path from 'node:path';
import {composeProjectRuntime, ProjectRuntimeCleanupError, type ProjectRuntime, type ProjectRuntimeOptions} from '../apps/server/src/project-runtime.ts';
import {createProjectDeletionGate} from '../apps/server/src/project-deletion-gate.ts';
import {startServer} from '../apps/server/src/index.ts';
import {openStore, openLegacyWorkspaceStore, ownsStoreLock} from '../packages/business/src/db.ts';
import {createProjectStore, openProjectStore, isProjectStore, schemaObjects, foreignKeyCheck} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createAppCompanionDocuments} from '../packages/business/src/companion-scope.ts';
import type {ServiceApplicationPorts} from '../packages/business/src/services.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import type {DatabaseSync} from 'node:sqlite';
import {createImageSettings} from '../packages/business/src/images/settings.ts';

function temporary(): string {
  return mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-project-runtime-'));
}

/** Deliberately unavailable historical operations: this is a test app port,
 * not a shadow workspace or a production replacement for the S7 runtime. */
function testApplication(library: ReturnType<typeof openAppLibrary>): ServiceApplicationPorts {
  const unavailable = (): never => { throw new TypeError('Historical backup operations are unavailable in this kernel test'); };
  const configuration = createWorkspaceConfiguration({root: library.dataDir, documents: createAppCompanionDocuments(library)});
  const assertOwner = createProjectServiceApplication(library).assertMutationAllowed;
  return {configuration, outsidePaths: library.outsidePaths, assertMutationAllowed() { assertOwner(); assert.equal(library.db.isOpen, true, 'the real application connection must still own admission'); }, backups: {
    getStatus: unavailable, list: unavailable, create: unavailable, stageRestore: unavailable,
    exportBundle: unavailable, importBundle: unavailable, importDirectory: unavailable,
    isBusy: () => false,
    assertMutationAllowed() { assert.equal(library.db.isOpen, true, 'the real application connection must still own admission'); },
    start: unavailable,
    stop: () => assert.fail('a project cannot stop a borrowed app runtime'),
    drain: async () => assert.fail('a project cannot drain a borrowed app runtime'),
    tick: unavailable,
  }};
}

function fixture(t: TestContext, kernel: boolean) {
  const root = temporary(), shutdown = new AbortController();
  const library = kernel ? openAppLibrary({dataDir: path.join(root, 'app')}) : undefined;
  const projectDir = path.join(root, 'Film');
  if (kernel) mkdirSync(projectDir, {mode: 0o700});
  const store = kernel ? createProjectStore({projectFile: path.join(projectDir, 'Film.mioon'), projectId: randomUUID(),
    locate: id => ({localDir: path.join(root, 'app', 'records', id), cacheDir: path.join(root, 'cache', id), tempDir: path.join(root, 'tmp', id)})}) : openLegacyWorkspaceStore(projectDir);
  const deletionGate = createProjectDeletionGate({signal: shutdown.signal, subscribeMedia: onMediaProcess, busy: () => { throw new Error('project busy'); }});
  let runtime: ProjectRuntime | undefined, worker: ReturnType<ProjectRuntime['startWorker']> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    shutdown.abort(); runtime?.taskRuntimeV2?.close(); runtime?.taskHttpV2?.close();
    await worker?.stop(); await runtime?.serviceDrain(); await runtime?.editTasks.drain(); await runtime?.closeSettings();
    runtime?.taskToolsV2?.dispose(); store.close(); library?.close();
  };
  t.after(async () => { await close(); rmSync(root, {recursive: true, force: true}); });
  const options = {store, shutdown, deletionGate, baseRoot: projectDir, port: 4318, serverPort: () => 4318, listeningPort: () => 4318, comfyModule: 'skip' as const};
  return {root, store, library, shutdown, options, close,
    compose: async (overrides: Partial<Pick<ProjectRuntimeOptions, 'application' | 'serviceApplication' | 'settings'>> = {}) => runtime = await composeProjectRuntime({...options, ...(library ? {application: library, serviceApplication: testApplication(library)} : {}), ...overrides}),
    startWorker: () => worker = runtime!.startWorker(),
  };
}

test('the shared factory keeps legacy layout, random multi-project creation and worker ownership', async t => {
  const f = fixture(t, false), runtime = await f.compose();
  const first = await runtime.serviceCall('project.create', {name: 'First'}) as {id: string};
  const second = await runtime.serviceCall('project.create', {name: 'Second'}) as {id: string};
  assert.notEqual(first.id, second.id);
  assert.equal(existsSync(path.join(f.store.root, 'workbench.sqlite')), true);
  assert.equal(existsSync(path.join(f.store.root, 'project.mioon')), false);
  assert.equal(existsSync(path.join(f.store.root, 'app-library.db')), false);
  const worker = f.startWorker();
  assert.equal(runtime.startWorker(), worker, 'one factory cannot dispatch two workers');
  assert.equal(ownsStoreLock(f.store), true);
  await f.close();
  assert.equal(f.store.db.isOpen, false);
});

test('kernel assembly is opt-in and requires explicit app dependencies', async t => {
  const f = fixture(t, true);
  await assert.rejects(composeProjectRuntime(f.options), /requires application ports/);
  assert.equal(f.shutdown.signal.aborted, false);
  assert.equal(ownsStoreLock(f.store), true, 'the factory never takes ownership of opening or closing the store');
  assert.equal(existsSync(path.join(f.store.root, 'workbench.sqlite')), false);
});

test('the same factory assembles a real kernel with independent app policy, documents and project records', async t => {
  const f = fixture(t, true), library = f.library!;
  const before = schemaObjects(f.store.db), runtime = await f.compose();
  const project = await runtime.serviceCall('project.create', {name: 'Film'}) as {id: string};
  assert.equal(project.id, 'projectId' in f.store ? f.store.projectId : undefined);
  const projectFile = path.join(f.store.root, 'Film.mioon');
  const identity = library.projectFileIdentity(projectFile); assert.ok(identity);
  library.registry.upsert({projectId: project.id, projectFile, fileIdentity: identity, name: 'Film', lastOpenedAt: null, summary: null});
  await runtime.serviceCall('shot.create', {projectId: project.id, title: 'A shot'});
  assert.equal(f.store.list('shots', project.id).length, 1);
  assert.ok(await runtime.serviceCall('timeline.get', {projectId: project.id}));
  runtime.uiPreferences!.markOpened(project.id);
  assert.ok(library.documents.read('ui-preferences-v1.json'));
  assert.equal(existsSync(path.join(library.dataDir, 'ui-preferences-v1.json')), false);
  const policy = runtime.taskRuntimeV2!.policy();
  const updated = runtime.taskRuntimeV2!.updatePolicy({requestId: randomUUID(), expectedRevision: policy.revision, stepLimit: 12, modes: policy.modes});
  assert.deepEqual(library.agentPolicy.read(), updated);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name='agent_task_policy_v2'").get()?.n, 0);
  assert.equal(f.store.db.prepare('PRAGMA database_list').all().some(row => row.file === library.databaseFile), false);
  assert.deepEqual(schemaObjects(f.store.db), before, 'assembly never runs legacy DDL against the three databases or TEMP');
  assert.deepEqual(foreignKeyCheck(f.store.db), []);
  assert.equal(existsSync(path.join(f.store.root, 'workbench.sqlite')), false);
  assert.equal(existsSync(path.join(library.dataDir, 'workbench.sqlite')), false);
  const token=randomUUID(),http=createHttpServer((req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();return;}
    void runtime.agentDiagnosticsHttp!(req,res,new URL(req.url??'/','http://127.0.0.1')).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(()=>res.destroy());
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  try{
    const address=http.address();assert.ok(address&&typeof address!=='string');
    const client=createAgentClient({env:{MIOON_BASE_URL:`http://127.0.0.1:${address.port}`,MIOON_TOKEN:token}}),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    const doctor=await client.doctor({projectId:project.id});assert.ok(doctor.storage);const storage=mioStorageSnapshotSchema.parse(doctor.storage);
    assert.equal(storage.projectId,project.id);assert.equal(storage.version,3);assert.equal(storage.tables.length,20);assert.equal((await client.doctor()).storage,undefined);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  }finally{await new Promise<void>(resolve=>http.close(()=>resolve()));}
  const worker = f.startWorker(); assert.equal(runtime.startWorker(), worker);
  await f.close();
});

test('application startup failure preserves its error and releases the server lock for retry', async t => {
  const root = temporary(), marker = new Error('synthetic project factory failure');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  await assert.rejects(startServer({dataDir: root, port: 0, agentSecretCodecFactory: async () => { throw marker; }}), error => error === marker);
  const server = await startServer({dataDir: root, port: 0});
  await server.close();
});

test('a held library file cannot grant app scope to another live database connection', async t => {
  const f = fixture(t, true), other = openAppLibrary({dataDir: path.join(f.root, 'other-app')});
  try {
    const runtime = await f.compose({application: {...other, db: f.library!.db}, serviceApplication: testApplication(other)});
    await assert.rejects(runtime.agentAuthorizations!.list(), {code: 'AGENT_AUTHORIZATION_UNAVAILABLE'});
    assert.throws(() => runtime.uiPreferences!.get(), {code: 'UI_PREFERENCES_UNAVAILABLE'});
    await f.close();
  } finally { other.close(); }
});

test('project cleanup leaves borrowed settings owned and usable by the application', async t => {
  const f = fixture(t, false), image = await createImageSettings({persistence: {load: async () => null, save: async () => {}}});
  let closed = 0;
  try {
    await f.compose({settings: {image: {...image, async close() { closed++; await image.close(); }}}});
    await f.close();
    assert.equal(closed, 0);
    assert.ok(await image.get(), 'the app can still use its borrowed settings after project close');
  } finally { await image.close(); }
});

test('failed private kernel cleanup preserves both failures and cannot authorize closing its owned SQLite connection', async t => {
  const f=fixture(t,true),store=f.store,startupError=new Error('synthetic late settings failure'),cleanupError=new Error('synthetic codec close failure');
  assert.ok(isProjectStore(store));
  const settings:NonNullable<ProjectRuntimeOptions['settings']>={get image():never{throw startupError;}};
  const failure:unknown=await composeProjectRuntime({...f.options,application:f.library!,serviceApplication:testApplication(f.library!),settings,
    agentSecretCodecFactory: async () => ({secretCodec: {close: () => { throw cleanupError; }},
      storage: () => ({persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}), close() {}}),
  }).then(() => assert.fail('startup must fail'), error => error);
  assert.ok(failure instanceof ProjectRuntimeCleanupError);
  assert.equal(failure.cause, startupError);
  const errors: unknown[] = [...failure.errors];
  for (let index = 0; index < errors.length; index++) if (errors[index] instanceof AggregateError) errors.push(...(errors[index] as AggregateError).errors);
  assert.ok(errors.includes(cleanupError), 'cleanup rejection must not replace the original startup failure');
  assert.equal(store.db.isOpen, true, 'unconfirmed private cleanup cannot authorize SQLite close');
  assert.equal(ownsStoreLock(store),true);
  assert.throws(()=>openProjectStore({projectFile:store.projectFile,locate:()=>assert.fail('a second connection must fail before locating records')}),{code:'PROJECT_LOCKED'},'the original kernel lock remains held');
});
