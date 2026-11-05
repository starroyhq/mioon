import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import type {DatabaseSync} from 'node:sqlite';
import {startServer, type InspectApplication, type InspectProject} from '../apps/server/src/index.ts';
import {serverAppDirectories, projectLocation} from '../apps/server/src/project-host/directories.ts';
import {stageProjectExampleResources, verifyProjectExampleResources} from '../packages/business/src/project-example-resources.ts';
import {projectTemplateManifestSchema} from '../packages/contracts/src/project-template-manifest.ts';
import type {ProjectTemplateManifest} from '../packages/contracts/src/project-template-manifest.ts';
import {projectCopyResponseSchema} from '../packages/contracts/src/project-copies.ts';
import type {ProjectCopyResponse, ProjectTemplateInput} from '../packages/contracts/src/project-copies.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import type {MediaReference} from '../packages/contracts/src/media-reference.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {captureClosedProjectSnapshot} from '../packages/business/src/project-file/closed-copy.ts';
import {openProjectBackup} from '../packages/business/src/project-file/backup.ts';
import {HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {CONTENT_TABLES, HISTORY_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {isProjectFileHeld} from '../packages/business/src/project-file/held-files.ts';
import {resolveReferencePath} from '../packages/business/src/media-reference/paths.ts';
import {generateProjectFileExample} from '../scripts/create-project-file-example.ts';

const token = 'synthetic-s6d-example-acceptance';
const sourceRoot = fileURLToPath(new URL('../examples/project-file-v1/', import.meta.url));
const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const maxBytes = 5 * 1024 * 1024;
interface Wire<T> {ok: boolean; data?: T; error?: {code: string}}
interface Asset {id: string; projectId: string; reference: MediaReference; sha256: string; sizeBytes: number}
interface Timeline {id: string; projectId: string; durationFrames: number; tracks: Array<{id: string; kind: string}>; clips: Array<{id: string; trackId: string; assetId: string}>}
type FileEvidence = {path: string; dev: string; ino: string; bytes: number; mtime: string; ctime: string; sha256: string};
function tree(directory: string, prefix = ''): FileEvidence[] {
  return readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name), relative = prefix + name, info = lstatSync(file, {bigint: true});
    assert.equal(info.isSymbolicLink(), false, relative);
    return info.isDirectory() ? tree(file, relative + '/') : [{path: relative, dev: String(info.dev), ino: String(info.ino), bytes: Number(info.size),
      mtime: String(info.mtimeNs), ctime: String(info.ctimeNs), sha256: sha(readFileSync(file))}];
  });
}
function manifest(directory: string): ProjectTemplateManifest {
  return projectTemplateManifestSchema.parse(JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')));
}
async function sourceContent(directory: string, input: ProjectTemplateManifest) {
  const snapshot = mkdtempSync(path.join(realpathSync(tmpdir()), 's6d-source-read-'));
  let reader: ReturnType<typeof openProjectBackup> | undefined;
  try {
    const captured = await captureClosedProjectSnapshot({projectFile: path.join(directory, input.projectFile.path),
      historyFile: () => path.join(snapshot, 'no-template-history'), directory: path.join(snapshot, 'captured')});
    reader = openProjectBackup(captured.projectFile); const db = reader.db;
    const project = JSON.parse(String(db.prepare('SELECT data FROM projects').get()!.data)) as {description: string};
    const assets = db.prepare('SELECT data FROM assets ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Asset);
    const timelines = db.prepare('SELECT data FROM timelines ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Timeline);
    const entityIds: Record<string, unknown[]> = {}, rowCounts: Record<string, number> = {};
    for (const table of CONTENT_TABLES.filter(name => name !== 'projects')) {
      rowCounts[table] = Number(db.prepare(`SELECT count(*) n FROM "${table}"`).get()!.n);
      if (db.prepare(`PRAGMA table_info("${table}")`).all().some(row => row.name === 'id')) {
        entityIds[table] = db.prepare(`SELECT id FROM "${table}" ORDER BY id`).all().map(row => row.id);
      }
    }
    return {identity: captured.identity, project, assets, timelines, entityIds, rowCounts};
  } finally {reader?.close(); rmSync(snapshot, {recursive: true, force: true});}
}
async function fixture(t: TestContext, channel: 'desktop' | 'web' = 'desktop') {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 's6d-example-')), distDir = path.join(root, 'web');
  const installed = channel === 'web' ? path.join(distDir, 'project-examples') : path.join(root, 'resources', 'examples');
  const dataDir = path.join(root, 'app'), projectsDir = path.join(root, 'projects'), targets = path.join(root, 'created');
  let server: Awaited<ReturnType<typeof startServer>> | undefined, inspect!: InspectProject, application!: InspectApplication;
  t.after(async () => {await server?.close(); rmSync(root, {recursive: true, force: true});});
  mkdirSync(path.dirname(installed)); mkdirSync(targets);
  await stageProjectExampleResources(sourceRoot, installed);
  const entries = verifyProjectExampleResources(installed); assert.equal(entries.length, 1);
  const entry = entries[0]!, original = tree(installed), content = await sourceContent(entry.directory, entry.manifest);
  const start = async () => startServer({dataDir, projectsDir, ...(channel === 'web' ? {distDir} : {projectTemplatesDir: installed}), port: 0, token,
    inspectProject: value => {inspect = value;}, inspectApplication: value => {application = value;}});
  server = await start();
  const input = (name: string): ProjectTemplateInput => ({templateId: 'timeline-basics', templateVersion: 1, parentDir: targets, name, requestId: randomUUID()});
  const rpc = async <T>(operation: string, value: unknown, projectId?: string): Promise<{status: number; body: Wire<T>}> => {
    assert.ok(server);
    const response = await fetch(server.url + (projectId ? `/api/projects/${projectId}/rpc` : '/api/rpc'), {
      method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation, input: value})});
    return {status: response.status, body: await response.json() as Wire<T>};
  };
  const instantiate = async (value: ProjectTemplateInput) => {
    const result = await rpc<ProjectCopyResponse>('project.template.instantiate', value);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true);
    return projectCopyResponseSchema.parse(result.body.data);
  };
  const withTarget = <T>(copy: ProjectCopyResponse, read: (store: ReturnType<typeof openProjectStore>) => T): T => {
    assert.equal(isProjectFileHeld(copy.project.fileIdentity), false);
    const directories = serverAppDirectories(dataDir, {projectsDir});
    const store = openProjectStore({projectFile: copy.project.projectFile, locate: id => projectLocation(directories, id)});
    try {return read(store);} finally {store.close();}
  };
  return {root, installed, targets, entry, original, content, input, rpc, instantiate, withTarget, dataDir, projectsDir,
    native: () => {assert.ok(server); return server.projectEntries;},
    inspect: <T>(id: string, read: (db: DatabaseSync) => T) => inspect(id, read),
    application: <T>(read: (db: DatabaseSync) => T) => application(read),
    async restart() {await server?.close(); server = undefined; server = await start();},
    async readMedia(projectId: string, assetId: string) {
      assert.ok(server); const response = await fetch(server.url + projectMediaPath(projectId, assetId), {headers: {authorization: `Bearer ${token}`}});
      assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer());
    },
  };
}

test('the shipped timeline example is current, bounded, licensed and contains only portable content and its declared media', async () => {
  const entries = verifyProjectExampleResources(sourceRoot); assert.equal(entries.length, 1);
  const entry = entries[0]!, input = manifest(entry.directory), files = tree(entry.directory), content = await sourceContent(entry.directory, input);
  assert.equal(input.templateId, 'timeline-basics'); assert.equal(input.version, 1);
  assert.ok(files.reduce((sum, file) => sum + file.bytes, 0) <= maxBytes);
  assert.deepEqual(files.map(value => value.path).sort(), ['manifest.json', 'README.md', 'SOURCE.md', 'LICENSE', input.projectFile.path, ...input.assets.map(value => value.path)].sort());
  for (const item of [input.projectFile, ...input.assets]) {
    const bytes = readFileSync(path.join(entry.directory, item.path)); assert.equal(bytes.length, item.sizeBytes); assert.equal(sha(bytes), item.sha256);
  }
  assert.match(readFileSync(path.join(entry.directory, 'LICENSE'), 'utf8'), /Apache License/u);
  assert.match(readFileSync(path.join(entry.directory, 'SOURCE.md'), 'utf8'), /create-timeline-fixtures\.py/u);
  assert.equal(content.identity.formatVersion, PROJECT_FILE_SCHEMA_VERSION);
  assert.equal(content.assets.length, 4); assert.equal(content.timelines.length, 1);
  assert.equal(content.timelines[0]!.tracks.length, 3); assert.equal(content.timelines[0]!.clips.length, 5);
  for (const asset of content.assets) {
    assert.equal(asset.projectId, content.identity.projectId); assert.equal(asset.reference.pathForm, 'relative');
    assert.ok(input.assets.some(item => item.path === asset.reference.path));
    assert.equal(asset.reference.fullSha256, input.assets.find(item => item.path === asset.reference.path)!.sha256);
  }
});

test('the default web build resources create two new identities with intact timeline content and no carried local execution records', async t => {
  const f = await fixture(t, 'web'), firstInput = f.input('First example'), first = await f.instantiate(firstInput);
  const native = f.native(); assert.ok(native.instantiateTemplate); const second = await native.instantiateTemplate(f.input('Second example'));
  assert.notEqual(first.project.projectId, second.project.projectId); assert.notEqual(first.project.projectId, f.content.identity.projectId);
  assert.notEqual(first.contentToken, second.contentToken); assert.equal(first.versions, 0); assert.equal(second.versions, 0);
  const mediaIdentities: string[][] = [];
  for (const copy of [first, second]) {
    const ids = f.withTarget(copy, store => {
      assert.equal(store.historyState, 'current'); assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()!.version, HISTORY_SCHEMA_VERSION);
      assert.equal(store.db.prepare('SELECT version FROM project.schema_version').get()!.version, PROJECT_FILE_SCHEMA_VERSION);
      for (const table of HISTORY_TABLES.filter(name => name !== 'mio_storage_counters')) assert.equal(store.db.prepare(`SELECT count(*) n FROM main."${table}"`).get()!.n, 0, table);
      assert.deepEqual({...store.db.prepare('SELECT * FROM main.mio_storage_counters').get()}, {singleton: 1, bytes: 0, rows: 1});
      const assets = store.db.prepare('SELECT data FROM project.assets ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Asset);
      assert.deepEqual(assets.map(asset => asset.id), f.content.assets.map(asset => asset.id));
      const timelines = store.db.prepare('SELECT data FROM project.timelines ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Timeline);
      assert.deepEqual(timelines.map(value => ({...value, projectId: f.content.identity.projectId})), f.content.timelines);
      for (const [table, ids] of Object.entries(f.content.entityIds)) assert.deepEqual(store.db.prepare(`SELECT id FROM project."${table}" ORDER BY id`).all().map(row => row.id), ids, table);
      for (const [table, count] of Object.entries(f.content.rowCounts)) assert.equal(store.db.prepare(`SELECT count(*) n FROM project."${table}"`).get()!.n, count, table);
      return assets.map(asset => {
        const reference = mediaReferenceSchema.parse(asset.reference); assert.equal(asset.projectId, copy.project.projectId); assert.equal(reference.pathForm, 'relative');
        const file = resolveReferencePath(store.projectDir, reference); assert.ok(file); assert.ok(file.startsWith(store.projectDir + path.sep));
        assert.equal(file.includes(f.installed), false); const item = f.entry.manifest.assets.find(value => value.path === reference.path); assert.ok(item);
        assert.equal(sha(readFileSync(file)), item.sha256); const info = lstatSync(file); assert.equal(info.nlink, 1);
        assert.notEqual(info.ino, lstatSync(path.join(f.entry.directory, item.path)).ino); return String(info.dev) + ':' + String(info.ino);
      });
    });
    mediaIdentities.push(ids);
    const local = projectLocation(serverAppDirectories(f.dataDir, {projectsDir: f.projectsDir}), copy.project.projectId).localDir;
    assert.equal(existsSync(path.join(local, 'backups')), false); assert.equal(existsSync(path.join(local, 'imports')), false);
  }
  for (let index = 0; index < mediaIdentities[0]!.length; index++) assert.notEqual(mediaIdentities[0]![index], mediaIdentities[1]![index]);
  assert.deepEqual(await f.instantiate(firstInput), first); assert.deepEqual(tree(f.installed), f.original);
  assert.deepEqual(f.native().listRecent().registered.map(value => value.project.projectId).sort(), [first.project.projectId, second.project.projectId].sort());
  const oldLocation = projectLocation(serverAppDirectories(f.dataDir, {projectsDir: f.projectsDir}), f.content.identity.projectId);
  assert.equal(existsSync(oldLocation.localDir), false);
});

test('both instances reopen and serve all media offline after installed examples are removed and the backend restarts', async t => {
  const f = await fixture(t), copies = [await f.instantiate(f.input('Offline A')), await f.instantiate(f.input('Offline B'))];
  renameSync(f.installed, f.installed + '-unavailable'); assert.equal(existsSync(f.installed), false);
  await f.restart();
  for (const copy of copies) {
    const windowId = randomUUID(), opened = await f.native().acquire({projectId: copy.project.projectId, windowId});
    assert.equal(opened.project.projectId, copy.project.projectId);
    const assets = f.inspect(copy.project.projectId, db => db.prepare('SELECT data FROM project.assets ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Asset));
    assert.equal(assets.length, f.entry.manifest.assets.length);
    for (const asset of assets) {
      const item = f.entry.manifest.assets.find(value => value.path === asset.reference.path); assert.ok(item);
      assert.equal(asset.reference.pathForm, 'relative'); assert.equal(JSON.stringify(asset).includes(f.installed), false);
      const bytes = await f.readMedia(copy.project.projectId, asset.id); assert.equal(bytes.length, item.sizeBytes); assert.equal(sha(bytes), item.sha256);
    }
    const timeline = await f.rpc<Timeline>('timeline.get', {projectId: copy.project.projectId}, copy.project.projectId);
    assert.equal(timeline.status, 200); assert.equal(timeline.body.data?.tracks.length, 3); assert.equal(timeline.body.data?.clips.length, 5);
    assert.equal(timeline.body.data?.durationFrames, 300);
    f.native().release({windowId});
  }
  const unavailable = await f.rpc('project.template.instantiate', f.input('No template now'));
  assert.equal(unavailable.status, 404); assert.equal(unavailable.body.error?.code, 'PROJECT_TEMPLATE_NOT_FOUND');
  assert.deepEqual(tree(f.installed + '-unavailable'), f.original);
});

test('real-example target conflicts preserve both empty and populated existing folders and add no registration', async t => {
  const f = await fixture(t), originalRegistry = f.native().listRecent();
  for (const name of ['Existing empty', 'Existing populated']) {
    const input = f.input(name), target = path.join(f.targets, name); mkdirSync(target);
    if (name === 'Existing populated') writeFileSync(path.join(target, 'user.txt'), 'keep user content');
    const before = tree(target), response = await f.rpc('project.template.instantiate', input);
    assert.equal(response.status, 409); assert.equal(response.body.error?.code, 'PROJECT_FILE_EXISTS'); assert.deepEqual(tree(target), before);
  }
  assert.deepEqual(f.native().listRecent(), originalRegistry); assert.deepEqual(tree(f.installed), f.original);
  assert.equal(f.application(db => db.prepare("SELECT count(*) n FROM app_operation_receipts WHERE operation='project.template.instantiate'").get()!.n), 0);
});

test('editing one real example leaves the second instance and installation template unchanged', async t => {
  const f = await fixture(t), first = await f.instantiate(f.input('Editable A')), second = await f.instantiate(f.input('Editable B'));
  const secondBefore = tree(path.dirname(second.project.projectFile));
  const firstMedia = f.withTarget(first, store => {
    const project = store.get('projects', first.project.projectId) as {id: string; name: string; description: string; revision: number};
    store.put('projects', {...project, description: 'Only this instance changes', revision: project.revision + 1});
    const asset = JSON.parse(String(store.db.prepare('SELECT data FROM project.assets ORDER BY id LIMIT 1').get()!.data)) as Asset;
    const file = resolveReferencePath(store.projectDir, asset.reference); assert.ok(file); return file;
  });
  writeFileSync(firstMedia, 'Only this instance media changes');
  assert.deepEqual(tree(path.dirname(second.project.projectFile)), secondBefore); assert.deepEqual(tree(f.installed), f.original);
  assert.equal(f.withTarget(second, store => (store.get('projects', second.project.projectId) as {description: string}).description), f.content.project.description);
});

test('the offline generator rebuilds a valid portable example and refuses an existing output without changing it', async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 's6d-rebuild-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const output = path.join(root, 'timeline-basics'); await generateProjectFileExample(output);
  const input = manifest(output), content = await sourceContent(output, input), before = tree(output);
  assert.equal(content.identity.formatVersion, PROJECT_FILE_SCHEMA_VERSION); assert.equal(content.assets.length, 4);
  assert.equal(content.timelines[0]!.tracks.length, 3); assert.equal(content.timelines[0]!.clips.length, 5);
  assert.ok(before.reduce((sum, file) => sum + file.bytes, 0) <= maxBytes);
  for (const file of [input.projectFile, ...input.assets]) assert.equal(sha(readFileSync(path.join(output, file.path))), file.sha256);
  const contentEvidence = (files: FileEvidence[]) => files.map(file => ({path: file.path, bytes: file.bytes, sha256: file.sha256}));
  assert.deepEqual(contentEvidence(before), contentEvidence(tree(path.join(sourceRoot, 'timeline-basics'))));
  await assert.rejects(generateProjectFileExample(output)); assert.deepEqual(tree(output), before);
});
