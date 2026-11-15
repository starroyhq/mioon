import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import type {DatabaseSync} from 'node:sqlite';
import {startServer, type InspectApplication, type InspectProject, type ServerOptions} from './test-server.ts';
import {serverAppDirectories, projectLocation} from '../../apps/server/src/project-host/directories.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createProjectVersions} from '../../packages/business/src/project-versions/service.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {agentChatHttpError} from '../../packages/business/src/agent/chat-errors.ts';
import type {TaskGateway} from '../../packages/business/src/agent/task-gateway-v2.ts';
import {openClosedProjectSnapshotConnection} from '../../packages/business/src/project-file/connection.ts';
import {createProjectBackup} from '../../packages/business/src/project-file/backup.ts';
import {isProjectFileHeld} from '../../packages/business/src/project-file/held-files.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {AGENT_TASK_POLICY_PRESETS} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {ProjectDeleteInput} from '../../packages/contracts/src/project-lifecycle.ts';
import type {ProjectTrashPort, ProjectTrashRequest} from '../../packages/contracts/src/project-trash-native.ts';
import type {RecentProject} from '../../packages/contracts/src/project-registry.ts';
import {createServerProject} from './project-database.ts';
import {createTestAuthorizations, authorizeTestScope} from './agent-authorizations.ts';
import {putTestAgentConfiguration, testAgentExecution} from './agent-settings-fixture.ts';
import {defaultTestAgentConfiguration} from './agent-preset-configurations.ts';
import {png} from './timeline-image-fixtures.ts';

export const token = 'synthetic-project-trash-server-token';
export interface Wire<T = unknown> {status: number; body: {ok: boolean; data?: T; error?: {code: string; details?: unknown}}}
export const data = <T>(value: Wire<T>): T => {
  assert.equal(value.status, 200, JSON.stringify(value.body)); assert.equal(value.body.ok, true); assert.ok(value.body.data); return value.body.data;
};
export const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export function logicalState(db: DatabaseSync, databases: readonly (readonly [string, string])[]) {
  return databases.map(([logical, schema]) => {
    const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM ${quote(schema)}.sqlite_schema ORDER BY type,name`).all();
    const tables = objects.filter(item => item.type === 'table').map(item => ({name: item.name,
      rows: db.prepare(`SELECT rowid,* FROM ${quote(schema)}.${quote(String(item.name))} ORDER BY rowid`).all()}));
    return {database: logical, objects, tables};
  });
}
/** Files are read only after their real kernel owner has closed. */
export function fileTree(directory: string): unknown {
  if (!existsSync(directory)) return null;
  return readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), info = lstatSync(file, {bigint: true});
    assert.equal(info.isSymbolicLink(), false); assert.equal(isProjectFileHeld({dev: String(info.dev), ino: String(info.ino)}), false);
    return {name, dev: String(info.dev), ino: String(info.ino),
      size: info.isDirectory() ? null : String(info.size), mtimeNs: info.isDirectory() ? null : String(info.mtimeNs),
      sha256: info.isDirectory() ? null : createHash('sha256').update(readFileSync(file)).digest('hex'),
      children: info.isDirectory() ? fileTree(file) : null};
  });
}

export async function seedMio(store: ProjectStore, services: ReturnType<typeof createServices>, shotId: string,
  mode: 'completed' | 'awaiting_answer' | 'awaiting_approval', bury = false) {
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  await putTestAgentConfiguration(settings, {expectedRevision: 0, configuration: defaultTestAgentConfiguration('chat_completions'),
    secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_TRASH_ACCEPTANCE_ONLY'}});
  const authorizations = createTestAuthorizations(store, settings); await authorizeTestScope(authorizations, 'project_agent');
  const queued: AgentTaskToolCall[][] = mode === 'awaiting_answer'
    ? [[{id: randomUUID(), name: 'mioon_ask', arguments: {question: 'Which opening?', options: [{label: 'Wide'}, {label: 'Close'}]}}]]
    : mode === 'awaiting_approval'
      ? [[{id: randomUUID(), name: 'mioon_tools_load', arguments: {names: ['mioon_shot_update']}}],
        [{id: randomUUID(), name: 'mioon_shot_update', arguments: {shotId, expectedRevision: 1, patch: {title: 'Must wait for approval'}}}]] : [];
  let modelCalls = 0, failFirstModel = bury;
  const gateway: TaskGateway = async function* () {
    modelCalls++;
    if (failFirstModel) {failFirstModel=false;throw agentChatHttpError(429);}
    const calls = queued.shift() ?? [];
    yield {type: 'done', output: {text: calls.length ? '' : 'Done locally', toolCalls: calls,
      providerOutput: {role: 'assistant', content: calls.length ? null : 'Done locally',
        ...(calls.length ? {tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {})}}};
  };
  const tools = createAgentTaskTools({store, services});
  const runtime = createAgentTaskRuntime({store, agentSettings: settings, authorizations, tools, gateway, selfPort: () => 4318});
  try {
    const sent = await runtime.send(store.projectId, {requestId: randomUUID(), text: 'Preserve my real Mio state',
      expectedSettingsRevision: testAgentExecution(await settings.get()).revision, policy: {modes: AGENT_TASK_POLICY_PRESETS.step}});
    await runtime.drain(); let settled = runtime.get(store.projectId, sent.run.id);
    assert.equal(settled.run.status, bury ? 'failed' : mode); assert.equal(runtime.isBusy(), false);
    assert.ok(store.db.prepare('SELECT 1 FROM mio_conversation_policies WHERE projectId=?').get(store.projectId));
    if (bury) {
      // A live wait prevents a newer run. Fail the first model through the real
      // gateway, create later completed runs, then retry the original model.
      // This leaves a real waiting run outside journal.list's last 100 rows.
      store.tx(()=>{for (let index = 0; index < 101; index++) {
        const run = runtime.journal.create({projectId: store.projectId, requestId: randomUUID(), text: `Later terminal run ${index}`,
          configuration: {protocol: 'chat_completions', model: 'synthetic'}}).run;
        const step = runtime.journal.beginModelStep(run.id, {request: {body: JSON.stringify({model: 'synthetic', stream: true, messages: []}), history: []}}, []);
        runtime.journal.markDispatch(run.id, step.id);
        runtime.journal.completeStep(run.id, step.id, {result: {text: 'Terminal history', toolCalls: [], providerOutput: {role: 'assistant', content: 'Terminal history'}}});
        runtime.journal.transition(run.id, runtime.journal.run(run.id).revision, 'completed');
      }});
      await runtime.action(store.projectId, settled.run.id, {requestId: randomUUID(),expectedRevision:settled.run.revision,action:'retry'});
      await runtime.drain();settled=runtime.get(store.projectId,sent.run.id);
      assert.equal(settled.run.status,mode);assert.equal(runtime.isBusy(),false);
      assert.equal(runtime.journal.list(store.projectId).length, 100);
      assert.equal(runtime.journal.list(store.projectId).some(run => run.id === settled.run.id), false, 'the real waiting run is older than the bounded list');
      assert.equal(runtime.get(store.projectId, settled.run.id).run.status, mode);
    }
    if (mode !== 'completed') assert.ok(settled.steps.some(step => step.status === mode));
    runtime.close(); await runtime.drain();
    assert.equal(runtime.journal.run(settled.run.id).status, mode, 'close never substitutes interrupt for waiting admission');
    return {runId: settled.run.id, modelCalls, state: logicalState(store.db, [['project', 'project'], ['history', 'main']])};
  } finally {runtime.close(); await runtime.drain(); tools.dispose(); await settings.close();}
}

export async function trashFixture(t: TestContext, options: {mode?: 'completed' | 'awaiting_answer' | 'awaiting_approval'; bury?: boolean; headless?: boolean} = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-trash-server-')), dataDir = path.join(root, 'app'), bin = path.join(root, 'fake-trash');
  let active: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {await active?.close(); rmSync(root, {recursive: true, force: true});});
  mkdirSync(bin); const directories = serverAppDirectories(dataDir);
  const source = createServerProject(dataDir, {name: 'Trash only this file'}), services = createServices(source.store, new Map());
  let seeded!: Awaited<ReturnType<typeof seedMio>>, asset!: Record<string, unknown>, shot!: Record<string, unknown>, revision!: number;
  const sourceFile = source.store.projectFile, sourceDir = source.store.projectDir, location = projectLocation(directories, source.projectId);
  const backupFile = path.join(location.localDir, 'backups', 'fixture-kept', 'project.mioon');
  try {
    asset = record(await services.call('asset.import', {projectId: source.projectId, requestId: randomUUID(), name: 'Retained source.png', mimeType: 'image/png',
      dataBase64: png({width: 16, height: 16, rgba: false, tagged: false}).toString('base64')}));
    shot = record(await services.call('shot.create', {projectId: source.projectId, title: 'Saved title', prompt: 'Retain this business content'}));
    const timeline = record(await services.call('timeline.get', {projectId: source.projectId}));
    const track = record((timeline.tracks as unknown[])[0]);
    await services.call('timeline.clip.add', {projectId: source.projectId, requestId: randomUUID(), expectedRevision: timeline.revision,
      assetId: asset.id, trackId: track.id, startFrame: 0, durationFrames: 30});
    const saved = createProjectVersions(source.store).save({projectId: source.projectId, requestId: randomUUID(), name: 'Retained version'});
    assert.ok(saved.version.id);
    seeded = await seedMio(source.store, services, String(shot.id), options.mode ?? 'completed', options.bury);
    mkdirSync(path.dirname(backupFile), {recursive:true,mode:0o700});
    const backup=await createProjectBackup(source.store,backupFile);assert.equal(backup.projectId,source.projectId);
    revision = Number(record(source.store.get('projects', source.projectId)).revision);
  } finally {await services.drain(); source.store.close();}
  for (const [name, content] of [['backups/keep.backup', 'Keep backup'], ['imports/keep.import', 'Keep imports'], ['v5-archive/keep.record', 'Keep fork archive']]) {
    const file = path.join(location.localDir, name!); mkdirSync(path.dirname(file), {recursive: true,mode:0o700}); writeFileSync(file, content!,{mode:0o600});
  }
  const other = createServerProject(dataDir, {name: 'Other project stays'}), otherFile = other.store.projectFile,
    otherDir = other.store.projectDir, otherLocal = projectLocation(directories, other.projectId).localDir;
  other.store.close();
  const calls: ProjectTrashRequest[] = [], reservations: string[] = [], releases: string[] = [];
  const port: ProjectTrashPort = {async reserve(input) {
    reservations.push(input.requestId); let released = false;
    return {async trash(request) {
      assert.equal(released, false); assert.equal(request.requestId, input.requestId); assert.equal(request.projectId, input.projectId);
      assert.equal(isProjectFileHeld(request.fileIdentity), false, 'the OS receives only a closed project file');
      calls.push(request); renameSync(request.projectFile, path.join(bin, request.requestId + '.mioon'));
    }, release() {assert.equal(released, false); released = true; releases.push(input.requestId);}};
  }};
  let inspect!: InspectProject, application!: InspectApplication;
  const serverOptions: ServerOptions = {dataDir, port: 0, token,
    ...(options.headless ? {} : {projectTrash: port}), inspectProject: read => {inspect = read;}, inspectApplication: read => {application = read;}};
  const server = await startServer(serverOptions); active = server;
  const registration = server.projectEntries.listRecent().registered.find(entry => entry.project.projectId === source.projectId)!.project;
  assert.equal(isProjectFileHeld(registration.fileIdentity), false);
  const input = (): ProjectDeleteInput => ({requestId: randomUUID(), projectId: source.projectId, projectFile: sourceFile,
    fileIdentity: {...registration.fileIdentity}, expectedRevision: revision, confirmTrash: true});
  const rpc = async <T = unknown>(operation: string, value: unknown, authenticated = true): Promise<Wire<T>> => {
    const response = await fetch(server.url + '/api/rpc', {method: 'POST', headers: {'content-type': 'application/json',
      ...(authenticated ? {authorization: `Bearer ${token}`} : {})}, body: JSON.stringify({operation, input: value})});
    return {status: response.status, body: await response.json() as Wire<T>['body']};
  };
  const closedState = (file = sourceFile) => {
    assert.equal(isProjectFileHeld(registration.fileIdentity), false);
    const connection = openClosedProjectSnapshotConnection({projectFile: file, historyFile: path.join(location.localDir, 'history.db')});
    try {
      connection.db.exec('BEGIN');const value=logicalState(connection.db, [['project', 'main'], ['history', 'history']]);connection.db.exec('COMMIT');return value;
    } finally {connection.close();}
  };
  const appState = () => application(db => logicalState(db, [['application', 'main']]));
  const retained = () => ({source: fileTree(sourceDir), local: fileTree(location.localDir), cache: fileTree(location.cacheDir),
    other: fileTree(otherDir), otherLocal: fileTree(otherLocal)});
  return {root, dataDir, bin, server, native: server.projectEntries, registration, sourceId: source.projectId, sourceFile, sourceDir,
    location, backupFile, otherId: other.projectId, otherFile, otherDir, otherLocal, seeded, asset, shot, input, rpc, closedState, retained,
    appState, inspect: <T>(read: (db: DatabaseSync) => T) => inspect(source.projectId, read), calls, reservations, releases};
}

export async function awaitClosed(project: RecentProject): Promise<void> {
  const until = performance.now() + 10_000;
  while (isProjectFileHeld(project.fileIdentity)) {assert.ok(performance.now() < until, 'project host closes after its last window'); await pause(5);}
}
