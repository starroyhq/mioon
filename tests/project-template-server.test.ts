import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {startServer, type InspectApplication, type InspectProject, type ServerOptions} from './helpers/test-server.ts';
import {serverAppDirectories, projectLocation} from '../apps/server/src/project-host/directories.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import type {ProjectTemplateCatalogEntry} from '../apps/server/src/project-host/templates.ts';
import {createProjectFile, inspectProjectFormatReadOnly} from '../packages/business/src/project-file/connection.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {isProjectFileHeld} from '../packages/business/src/project-file/held-files.ts';
import {FORMAT5_HISTORY_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_HISTORY_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {HISTORY_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {mediaMtimeMs} from '../packages/business/src/media-reference/fingerprint.ts';
import type {ProjectCopyResponse, ProjectTemplateInput} from '../packages/contracts/src/project-copies.ts';
import {projectCopyResponseSchema} from '../packages/contracts/src/project-copies.ts';
import type {MediaReference} from '../packages/contracts/src/media-reference.ts';
import {projectFormatUpgradeFromError} from '../packages/contracts/src/project-format-upgrade.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {readProjectState, changeMarks} from './helpers/project-state.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const token = 'synthetic-template-server-authentication';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface Wire<T> {ok: boolean; data?: T; error?: {code: string; details?: unknown}}
const snapshot = (db: DatabaseSync) => ({...readProjectState(db), marks: changeMarks(db)});
async function fixture(t: TestContext, format6 = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-template-server-')), directory = path.join(root, 'template'), target = path.join(root, 'targets'), dataDir = path.join(root, 'app');
  mkdirSync(directory); mkdirSync(target); mkdirSync(path.join(directory, 'media'));
  const projectFile = path.join(directory, 'template.mioon'), projectId = createProjectFile(projectFile), assetId = randomUUID();
  const bytes = png({width: 16, height: 16, rgba: false, tagged: false}), media = path.join(directory, 'media', 'scene.png'); writeFileSync(media, bytes);
  const reference: MediaReference = {pathForm: 'relative', path: 'media/scene.png', volume: null, sizeBytes: bytes.length,
    mtimeMs: mediaMtimeMs(lstatSync(media, {bigint: true})), sampledSha256: hash(bytes), fullSha256: hash(bytes)};
  const source = openProjectStore({projectFile, locate: () => ({localDir: path.join(root, 'private-history'), cacheDir: path.join(root, 'private-cache'), tempDir: path.join(root, 'private-tmp')})});
  ensureProjectRow(source, {name: 'Catalog source', description: 'Unchanged template'});
  source.put('assets', {id: assetId, projectId, reference, referenceRevision: 1, sha256: hash(bytes), sizeBytes: bytes.length, name: 'scene.png', mimeType: 'image/png'});
  source.db.prepare("INSERT INTO idempotency VALUES('template-only','untrusted-old-request','digest','resource')").run();
  source.close();
  const entry: ProjectTemplateCatalogEntry = {directory, manifest: {templateId: 'starter', version: 1,
    projectFile: {path: 'template.mioon', sizeBytes: readFileSync(projectFile).length, sha256: hash(readFileSync(projectFile))},
    assets: [{path: 'media/scene.png', sizeBytes: bytes.length, sha256: hash(bytes)}]}};
  const openSource = () => openProjectStore({projectFile, locate: () => ({localDir: path.join(root, 'private-history'), cacheDir: path.join(root, 'private-cache'), tempDir: path.join(root, 'private-tmp')})});
  let application!: InspectApplication, inspect!: InspectProject, boundary: ServerOptions['projectCopyActionBoundaryForTest'];
  let server: Awaited<ReturnType<typeof startServer>>;
  if (format6) setFormat6Environment(t, '1');
  const start = async () => startServer({dataDir, projectsDir: path.join(root, 'projects'), port: 0, token,
    ...(format6 ? {localDraftChannel: 'development' as const, projectFormatForTest: undefined} : {projectFormatForTest: FORMAT5_PROJECT_SCHEMA_VERSION}),
    projectTemplates: [entry],
    inspectApplication: value => {application = value;}, inspectProject: value => {inspect = value;}, projectCopyActionBoundaryForTest: (phase, input) => boundary?.(phase, input)});
  server = await start();
  t.after(async () => {await server.close(); rmSync(root, {recursive: true, force: true});});
  const input = (name = 'Instance'): ProjectTemplateInput => ({templateId: 'starter', templateVersion: 1, parentDir: target, name, requestId: randomUUID()});
  const rpc = async (input: unknown, authenticated = true): Promise<{status: number; body: Wire<ProjectCopyResponse>}> => {
    const result = await fetch(server.url + '/api/rpc', {method: 'POST', headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {})},
      body: JSON.stringify({operation: 'project.template.instantiate', input})});
    return {status: result.status, body: await result.json() as Wire<ProjectCopyResponse>};
  };
  const tree = () => ({project: readFileSync(projectFile), media: readFileSync(media), projectStat: lstatSync(projectFile, {bigint: true}), mediaStat: lstatSync(media, {bigint: true})});
  return {root, directory, target, dataDir, entry, projectId, projectFile, media, assetId, bytes, input, rpc, tree, openSource,
    application: <T>(read: (db: DatabaseSync) => T) => application(read),
    inspect: <T>(id: string, read: (db: DatabaseSync) => T) => inspect(id, read),
    get native() {return server.projectEntries;},
    setBoundary(value: typeof boundary) {boundary = value;},
    async restart() {await server.close(); boundary = undefined; server = await start();},
    targetStore(copy: ProjectCopyResponse) {assert.equal(isProjectFileHeld(copy.project.fileIdentity), false); return openProjectStore({
      projectFile: copy.project.projectFile, ...(format6 ? {allowFormat6: true as const} : {}),
      locate: id => projectLocation(serverAppDirectories(dataDir, {projectsDir: path.join(root, 'projects')}), id)});},
  };
}
const success = (result: {status: number; body: Wire<ProjectCopyResponse>}): ProjectCopyResponse => {
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true); return projectCopyResponseSchema.parse(result.body.data);
};

function setFormat6Environment(t: TestContext, value: string | undefined): void {
  const original = process.env.MIOON_FORMAT6_DEV;
  t.after(() => {
    if (original === undefined) delete process.env.MIOON_FORMAT6_DEV;
    else process.env.MIOON_FORMAT6_DEV = original;
  });
  if (value === undefined) delete process.env.MIOON_FORMAT6_DEV;
  else process.env.MIOON_FORMAT6_DEV = value;
}
const denied = (result: {status: number; body: Wire<unknown>}, status: number, code: string): void => {
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.ok, false); assert.equal(result.body.error?.code, code);
};

test('HTTP and trusted template entries create independent media and identities while preserving template bytes and records', async t => {
  const f = await fixture(t), original = f.tree(), firstInput = f.input('First'), secondInput = f.input('Second');
  const first = success(await f.rpc(firstInput));
  assert.ok(f.native.instantiateTemplate); const second = await f.native.instantiateTemplate(secondInput);
  assert.notEqual(first.project.projectId, second.project.projectId); assert.notEqual(first.project.projectId, f.projectId);
  assert.notEqual(first.contentToken, second.contentToken); assert.equal(first.versions, 0); assert.equal(second.versions, 0);
  assert.equal(first.project.projectFile, path.join(f.target, 'First', 'First.mioon'));
  assert.equal(second.project.projectFile, path.join(f.target, 'Second', 'Second.mioon'));
  const media = [first, second].map(copy => path.join(path.dirname(copy.project.projectFile), 'media', 'scene.png'));
  for (let index = 0; index < 2; index++) {
    const copy = [first, second][index], store = f.targetStore(copy);
    try {
      assert.equal(store.historyState, 'current'); assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()!.version, FORMAT5_HISTORY_SCHEMA_VERSION);
      const singletons = new Set(['canvas_receipt_window', 'editor_receipt_window', 'editor_storage_counters']);
      for (const table of HISTORY_TABLES.filter(name => name !== 'mio_storage_counters')) assert.equal(store.db.prepare(`SELECT count(*) n FROM main."${table}"`).get()!.n, singletons.has(table) ? 1 : 0, table);
      assert.deepEqual({...store.db.prepare('SELECT * FROM main.mio_storage_counters').get()}, {singleton: 1, bytes: 0, rows: 1});
      const asset = store.get('assets', f.assetId) as {projectId: string; reference: MediaReference};
      assert.equal(asset.projectId, copy.project.projectId); assert.equal(asset.reference.path, 'media/scene.png'); assert.equal(asset.reference.fullSha256, hash(f.bytes));
      assert.equal(asset.reference.mtimeMs, mediaMtimeMs(lstatSync(media[index], {bigint: true})));
    } finally {store.close();}
    assert.equal(lstatSync(media[index]).nlink, 1); assert.notEqual(lstatSync(media[index]).ino, lstatSync(f.media).ino);
  }
  assert.notEqual(lstatSync(media[0]).ino, lstatSync(media[1]).ino); writeFileSync(media[0], 'One instance alone changes');
  assert.deepEqual(readFileSync(media[1]), f.bytes); assert.deepEqual(f.tree(), original);
  assert.equal((await f.native.listRecent()).registered.length, 2);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE operation=?').get('project.template.instantiate')!.n), 2);
});

test('a development-channel template publishes format 6 atomically and replays under one target identity', async t => {
  const f = await fixture(t, true);
  const original = f.tree();
  const input = f.input('Format 6 example');
  f.setBoundary(phase => {if (phase === 'project-published') throw new Error('Synthetic interruption');});
  const interrupted = await f.rpc(input);
  assert.equal(interrupted.status, 500);
  await f.restart();
  const copied = success(await f.rpc(input));
  const again = success(await f.rpc(input));
  assert.deepEqual(again, copied);
  const target = f.targetStore(copied);
  try {
    assert.equal(target.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT6_PROJECT_SCHEMA_VERSION);
    assert.equal(target.db.prepare('SELECT version FROM main.schema_version').get()?.version, FORMAT6_HISTORY_SCHEMA_VERSION);
    assert.equal(target.db.prepare('SELECT count(*) AS count FROM timeline_processing_tasks').get()?.count, 0);
    assert.equal(target.historyState, 'current');
  } finally {target.close();}
  assert.deepEqual(f.tree(), original);
  assert.deepEqual(readFileSync(path.join(path.dirname(copied.project.projectFile), 'media', 'scene.png')), f.bytes);
});

test('only the development channel plus explicit environment opt-in admits format 6', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-format6-gate-'));
  const start = (localDraftChannel: NonNullable<ServerOptions['localDraftChannel']>) =>
    startServer({dataDir: path.join(root, 'app'), port: 0, token, localDraftChannel, projectFormatForTest: undefined});
  setFormat6Environment(t, '1');
  let server = await start('web');
  t.after(async () => {await server.close(); rmSync(root, {recursive: true, force: true});});
  const readSpeedCapability = async (projectId: string) => {
    const response = await fetch(server.url + projectRpcPath(projectId), {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify({operation: 'project.get', input: {projectId}})});
    const body = await response.json() as Wire<{timeline: {capabilities: {speed: boolean}}}>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    return body.data!.timeline.capabilities.speed;
  };
  const previous = await server.projectEntries.create({name: 'Previous format'});
  assert.equal((await server.projectEntries.listRecent()).newProjectFormatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
  assert.equal(inspectProjectFormatReadOnly(previous.projectFile).formatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
  await server.close();
  delete process.env.MIOON_FORMAT6_DEV;
  server = await start('development');
  const previousWindow = randomUUID();
  await server.projectEntries.acquire({projectId: previous.projectId, windowId: previousWindow});
  assert.equal((await server.projectEntries.listRecent()).newProjectFormatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
  assert.equal(await readSpeedCapability(previous.projectId), false);
  server.projectEntries.release({windowId: previousWindow});
  await server.close();
  assert.equal(inspectProjectFormatReadOnly(previous.projectFile).formatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
  process.env.MIOON_FORMAT6_DEV = '1';
  server = await start('development');
  assert.equal((await server.projectEntries.listRecent()).newProjectFormatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
  const fresh = await server.projectEntries.create({name: 'Opted-in format'});
  assert.equal(inspectProjectFormatReadOnly(fresh.projectFile, {allowFormat6: true}).formatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
  const upgradeWindow = randomUUID();
  let preview: NonNullable<ReturnType<typeof projectFormatUpgradeFromError>> | null = null;
  await assert.rejects(() => server.projectEntries.acquire({projectId: previous.projectId, windowId: upgradeWindow}),
    error => Boolean(preview = projectFormatUpgradeFromError(error)));
  assert.ok(preview);
  const observed = await server.projectEntries.observeFormat!({projectFile: previous.projectFile, preview});
  assert.equal((await server.projectEntries.readOnlyFormat!(observed)).projectVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
  await server.projectEntries.acquire({projectId: previous.projectId, expectedProjectFile: previous.projectFile,
    windowId: upgradeWindow, formatUpgrade: observed});
  assert.equal(await readSpeedCapability(previous.projectId), true);
  server.projectEntries.release({windowId: upgradeWindow});
  await server.close();
  assert.equal(inspectProjectFormatReadOnly(previous.projectFile, {allowFormat6: true}).formatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
  delete process.env.MIOON_FORMAT6_DEV;
  server = await start('development');
  await assert.rejects(() => server.projectEntries.acquire({projectId: fresh.projectId, windowId: randomUUID()}),
    error => (error as {code?: string}).code === 'PROJECT_FORMAT_NEWER' ||
      (error as {details?: {reason?: string}}).details?.reason === 'PROJECT_FORMAT_NEWER');
});

test('an existing target folder is never merged, even empty, and no registration is added', async t => {
  const f = await fixture(t), before = f.application(snapshot), original = f.tree();
  for (const name of ['Empty', 'Occupied']) {
    const input = f.input(name), directory = path.join(f.target, name); mkdirSync(directory);
    if (name === 'Occupied') writeFileSync(path.join(directory, 'keep.png'), f.bytes);
    denied(await f.rpc(input), 409, 'PROJECT_FILE_EXISTS');
    assert.deepEqual(readdirSync(directory), name === 'Empty' ? [] : ['keep.png']);
    if (name === 'Occupied') assert.deepEqual(readFileSync(path.join(directory, 'keep.png')), f.bytes);
  }
  assert.deepEqual(f.application(snapshot), before); assert.deepEqual(f.tree(), original); assert.equal((await f.native.listRecent()).registered.length, 0);
});

test('template request validation and catalog lookup cannot grant arbitrary template paths or private targets', async t => {
  const f = await fixture(t), input = f.input(), before = f.application(snapshot), original = f.tree();
  denied(await f.rpc(null, false), 401, 'UNAUTHORIZED');
  for (const invalid of [{...input, templateId: f.projectFile}, {...input, templateFile: f.projectFile}, {...input, parentDir: 'relative'}, {...input, templateVersion: 0}, {...input, name: '../escape'}])
    denied(await f.rpc(invalid), 400, 'VALIDATION_ERROR');
  denied(await f.rpc({...input, templateId: 'unknown'}), 404, 'PROJECT_TEMPLATE_NOT_FOUND');
  denied(await f.rpc({...input, templateVersion: 2}), 404, 'PROJECT_TEMPLATE_NOT_FOUND');
  denied(await f.rpc({...input, parentDir: f.dataDir}), 400, 'PROJECT_LOCATION_INVALID');
  assert.deepEqual(f.application(snapshot), before); assert.deepEqual(f.tree(), original); assert.deepEqual(readdirSync(f.target), []);
});

test('same-key replay preserves edited and held target content and writes one fixed receipt', async t => {
  const f = await fixture(t), input = f.input(), initial = await f.rpc(input), copy = success(initial), windowId = randomUUID();
  await f.native.acquire({projectId: copy.project.projectId, windowId});
  f.inspect(copy.project.projectId, db => {
    const row = db.prepare('SELECT data FROM project.projects WHERE id=?').get(copy.project.projectId)!;
    const data = JSON.parse(String(row.data)); data.description = 'Later template-instance edit'; data.revision++;
    db.prepare('UPDATE project.projects SET data=? WHERE id=?').run(JSON.stringify(data), copy.project.projectId);
  });
  const projectBefore = f.inspect(copy.project.projectId, snapshot), appBefore = f.application(snapshot);
  assert.deepEqual(await f.rpc(input), initial);
  assert.deepEqual(f.inspect(copy.project.projectId, snapshot), projectBefore); assert.deepEqual(f.application(snapshot), appBefore);
  denied(await f.rpc({...input, name: 'Different'}), 409, 'REQUEST_ID_REUSED');
  assert.deepEqual(f.inspect(copy.project.projectId, snapshot), projectBefore);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 1);
  f.native.release({windowId});
});

for (const bad of ['project-hash', 'asset-hash', 'asset-missing'] as const)
  test(`${bad} rejects template publication and startup cleans captured hidden stages without registering`, async t => {
    const f = await fixture(t), input = f.input(), project = readFileSync(f.projectFile);
    if (bad === 'project-hash') {const changed = Buffer.from(project); changed[changed.length - 1] ^= 1; writeFileSync(f.projectFile, changed);}
    if (bad === 'asset-hash') writeFileSync(f.media, Buffer.alloc(f.bytes.length));
    if (bad === 'asset-missing') rmSync(f.media);
    const before = f.application(snapshot), sourceAfterDamage = readFileSync(f.projectFile);
    denied(await f.rpc(input), 422, 'PROJECT_TEMPLATE_INVALID');
    assert.equal(existsSync(path.join(f.target, input.name)), false); assert.deepEqual(f.application(snapshot), before);
    assert.deepEqual(readFileSync(f.projectFile), sourceAfterDamage); assert.equal((await f.native.listRecent()).registered.length, 0);
    await f.restart();
    assert.deepEqual(readdirSync(f.target), []); assert.equal((await f.native.listRecent()).registered.length, 0);
    assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
  });

for (const phase of ['ready', 'directory-placeholder', 'project-published', 'registered'] as const)
  test(`template ${phase} interruption resumes the same ID, folder and single receipt after server restart`, async t => {
    const f = await fixture(t), input = f.input(), original = f.tree(), stopped = Error(`stop ${phase}`);
    f.setBoundary(boundary => {if (boundary === phase) throw stopped;});
    await assert.rejects(f.native.instantiateTemplate!(input), error => error === stopped);
    const records = path.join(f.dataDir, 'project-copy-actions', `project.template.instantiate-${input.requestId}.json`);
    const intent = JSON.parse(readFileSync(records, 'utf8')) as {projectId: string; contentToken: string; response: ProjectCopyResponse};
    assert.equal(intent.response.project.projectId, intent.projectId); assert.equal(intent.response.contentToken, intent.contentToken);
    if (phase === 'ready') assert.equal(existsSync(path.join(f.target, input.name)), false);
    await f.restart();
    const copy = success(await f.rpc(input)); assert.deepEqual(copy, intent.response);
    assert.equal(copy.project.projectId, intent.projectId); assert.equal(copy.contentToken, intent.contentToken);
    assert.equal((await f.native.listRecent()).registered.length, 1);
    assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 1);
    assert.deepEqual(readdirSync(f.target), [input.name]); assert.deepEqual(readFileSync(path.join(f.target, input.name, 'media', 'scene.png')), f.bytes);
    assert.deepEqual(f.tree(), original);
    assert.equal(JSON.parse(readFileSync(records, 'utf8')).phase, 'completed');
  });

test('a staged project moved alone into another folder cannot masquerade as a complete published template', async t => {
  const f = await fixture(t), input = f.input(), original = f.tree(), folder = path.join(f.target, input.name);
  f.setBoundary(phase => {
    if (phase !== 'ready') return;
    const stage = readdirSync(f.target).find(name => name.startsWith('.project-copy-')); assert.ok(stage);
    mkdirSync(folder); writeFileSync(path.join(folder, 'keep.txt'), 'another folder owner');
    renameSync(path.join(f.target, stage, input.name + '.mioon'), path.join(folder, input.name + '.mioon'));
  });
  await assert.rejects(f.native.instantiateTemplate!(input), {code: 'PROJECT_COPY_TARGET_CHANGED'});
  assert.equal((await f.native.listRecent()).registered.length, 0);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
  assert.equal(readFileSync(path.join(folder, 'keep.txt'), 'utf8'), 'another folder owner');
  assert.equal(existsSync(path.join(folder, 'media')), false); assert.deepEqual(f.tree(), original);
});

test('media corrupted after template preparation is rejected before exposing a project folder or registration', async t => {
  const f = await fixture(t), input = f.input(), original = f.tree();
  f.setBoundary(phase => {
    if (phase !== 'ready') return;
    const stage = readdirSync(f.target).find(name => name.startsWith('.project-copy-')); assert.ok(stage);
    writeFileSync(path.join(f.target, stage, 'media', 'scene.png'), Buffer.alloc(f.bytes.length));
  });
  await assert.rejects(f.native.instantiateTemplate!(input), {code: 'PROJECT_TEMPLATE_INVALID'});
  assert.equal(existsSync(path.join(f.target, input.name)), false); assert.equal((await f.native.listRecent()).registered.length, 0);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
  assert.deepEqual(f.tree(), original);
  await f.restart();
  assert.equal(existsSync(path.join(f.target, input.name)), false); assert.equal((await f.native.listRecent()).registered.length, 0);
  assert.deepEqual(f.tree(), original);
});

test('template capture is bound to the catalog-validated content pair even when its path and inode stay the same', async t => {
  const f = await fixture(t), input = f.input(), original = readFileSync(f.projectFile), before = lstatSync(f.projectFile, {bigint: true});
  let edited: Buffer | undefined, reachedCaptured = false;
  f.setBoundary(phase => {
    if (phase === 'prepared') {
      const store = f.openSource();
      try {
        const project = store.get('projects', f.projectId) as {id: string; description: string; revision: number};
        store.put('projects', {...project, description: 'A real same-inode edit after catalog validation', revision: project.revision + 1});
      } finally {store.close();}
      const actual = lstatSync(f.projectFile, {bigint: true}); assert.equal(actual.dev, before.dev); assert.equal(actual.ino, before.ino);
      edited = readFileSync(f.projectFile); assert.notDeepEqual(edited, original);
    }
    if (phase === 'captured') {
      reachedCaptured = true;
      // The old implementation accepted the newly edited snapshot, then
      // checked only this restored path. Its target held the non-catalog edit.
      writeFileSync(f.projectFile, original);
    }
  });
  await assert.rejects(f.native.instantiateTemplate!(input), {code: 'PROJECT_COPY_SOURCE_CHANGED'});
  assert.equal(reachedCaptured, false); assert.ok(edited); assert.deepEqual(readFileSync(f.projectFile), edited);
  assert.equal(existsSync(path.join(f.target, input.name)), false); assert.equal((await f.native.listRecent()).registered.length, 0);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
});

test('a source generation change cannot reuse the template signature with an unchanged content pair', async t => {
  const f = await fixture(t), input = f.input(), original = readFileSync(f.projectFile), before = lstatSync(f.projectFile, {bigint: true});
  let edited: Buffer | undefined;
  f.setBoundary(phase => {
    if (phase !== 'prepared') return;
    const source = new DatabaseSync(f.projectFile, {defensive: false});
    try {
      const beforePair = source.prepare('SELECT contentSequence,contentToken FROM project_file').get();
      const cookie = Number(source.prepare('PRAGMA schema_version').get()?.schema_version);
      // Format upgrades also preserve the content pair while changing bytes.
      source.exec(`PRAGMA schema_version=${cookie + 1}`);
      assert.deepEqual(source.prepare('SELECT contentSequence,contentToken FROM project_file').get(), beforePair);
    } finally {source.close();}
    const after = lstatSync(f.projectFile, {bigint: true});
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
    edited = readFileSync(f.projectFile); assert.notDeepEqual(edited, original);
  });
  await assert.rejects(f.native.instantiateTemplate!(input), {code: 'PROJECT_COPY_SOURCE_CHANGED'});
  assert.ok(edited); assert.deepEqual(readFileSync(f.projectFile), edited);
  assert.equal(existsSync(path.join(f.target, input.name)), false);
  assert.equal((await f.native.listRecent()).registered.length, 0);
});
