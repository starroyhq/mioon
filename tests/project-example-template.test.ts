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
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {createProjectCopies} from '../apps/server/src/project-host/copies.ts';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
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
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {CONTENT_TABLES, HISTORY_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {isProjectFileHeld} from '../packages/business/src/project-file/held-files.ts';
import {resolveReferencePath} from '../packages/business/src/media-reference/paths.ts';
import {generateProjectFileExample} from '../scripts/create-project-file-example.ts';
import {deriveTimelineAssetUsage} from '../apps/web/src/timeline-asset-usage.ts';
import {isTimelineRenderRecord} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {clipDraftEnvelopeSchema, clipDraftListSchema} from '../packages/contracts/src/local-drafts.ts';
import {createLocalDeliverySchemas} from '../packages/contracts/src/local-delivery.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {probe} from '../packages/business/src/media.ts';
import {LOCALES} from '../packages/i18n/src/locale.ts';

const token = 'synthetic-s6d-example-acceptance';
const sourceRoot = fileURLToPath(new URL('../examples/project-file-v1/', import.meta.url));
const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const maxBytes = 5 * 1024 * 1024;
interface Wire<T> {ok: boolean; data?: T; error?: {code: string}}
interface Asset {id: string; projectId: string; reference: MediaReference; sha256: string; sizeBytes: number; name: string; mimeType: string; duration: number | null; width?: number | null; height?: number | null}
interface ReadableAsset extends Omit<Asset, 'width' | 'height'> {url: string; width?: number; height?: number}
interface Timeline {id: string; projectId: string; revision: number; durationFrames: number; tracks: Array<{id: string; kind: string}>; clips: Array<{id: string; trackId: string; assetId: string}>}
interface ReadableProject {project: {id: string}; assets: ReadableAsset[]; timeline: Timeline}
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
    async get<T>(projectId: string, suffix: string) {
      assert.ok(server); const response = await fetch(server.url + `/api/projects/${projectId}/${suffix}`, {headers: {authorization: `Bearer ${token}`}});
      return {status: response.status, body: await response.json() as Wire<T>};
    },
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

test('the shipped format 3 example produces a format 4 candidate without changing the signed resources', async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 's6d-example-format4-'));
  const installed = path.join(root, 'installed'), targets = path.join(root, 'targets');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(targets);
  await stageProjectExampleResources(sourceRoot, installed);
  const entries = verifyProjectExampleResources(installed), entry = entries[0]!, original = tree(installed);
  const source = await sourceContent(entry.directory, entry.manifest);
  assert.equal(source.identity.formatVersion, PROJECT_FILE_SCHEMA_VERSION);
  const directories = serverAppDirectories(path.join(root, 'app'));
  const library = openAppLibrary({dataDir: directories.dataDir});
  try {
    const manager = createProjectHostManager({directories, registry: library.registry,
      factory: async () => assert.fail('template instantiation must not open the source or target runtime')});
    const copies = createProjectCopies({manager, library, directories, projectTemplates: entries, targetFormat: FORMAT4_PROJECT_SCHEMA_VERSION,
      assertProjectFile: createApplicationFileGuard(directories), signal: new AbortController().signal});
    const copy = await copies.instantiateTemplate({templateId: entry.manifest.templateId, templateVersion: entry.manifest.version,
      parentDir: targets, name: 'Format 4 example', requestId: randomUUID()});
    const target = openProjectStore({projectFile: copy.project.projectFile, locate: id => projectLocation(directories, id), format4: {}});
    try {
      assert.equal(target.db.prepare('SELECT version FROM project.schema_version').get()?.version, FORMAT4_PROJECT_SCHEMA_VERSION);
      assert.equal(target.db.prepare('SELECT version FROM main.schema_version').get()?.version, FORMAT4_HISTORY_SCHEMA_VERSION);
      assert.equal(target.historyState, 'current');
      assert.equal(target.db.prepare('SELECT contentToken FROM project.project_file').get()?.contentToken, copy.contentToken);
      assert.notEqual(copy.project.projectId, source.identity.projectId);
      const timelines = target.db.prepare('SELECT data FROM project.timelines ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Timeline);
      assert.deepEqual(timelines.map(timeline => ({...timeline, projectId: source.identity.projectId})), source.timelines);
      for (const item of entry.manifest.assets) {
        const file = path.join(target.projectDir, item.path);
        assert.equal(sha(readFileSync(file)), item.sha256);
        assert.equal(lstatSync(file).nlink, 1);
        assert.notEqual(lstatSync(file).ino, lstatSync(path.join(entry.directory, item.path)).ino);
      }
    } finally {target.close();}
    await copies.drain();
  } finally {library.close();}
  assert.deepEqual(tree(installed), original);
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
  assert.deepEqual((await f.native().listRecent()).registered.map(value => value.project.projectId).sort(), [first.project.projectId, second.project.projectId].sort());
  const oldLocation = projectLocation(serverAppDirectories(f.dataDir, {projectsDir: f.projectsDir}), f.content.identity.projectId);
  assert.equal(existsSync(oldLocation.localDir), false);
});

test('a shipped example instance stores the requested four-language display text and retains its verified media', async t => {
  const f = await fixture(t);
  const labels = {
    'zh-Hans': ['时间线入门', '一段原创的十秒钟时间线，展示剪切、空白、画中画和独立音频。', '晨光 · 画面', '夜色 · 画面与声音', '星形卡片 · 透明叠加', '合成音 · 独立音频'],
    'zh-Hant': ['時間軸入門', '一段原創的十秒鐘時間軸，展示剪接、空白、子母畫面和獨立音訊。', '晨光 · 畫面', '夜色 · 畫面與聲音', '星形卡片 · 透明疊加', '合成音 · 獨立音訊'],
    en: ['Timeline basics', 'An original ten-second study of cuts, a gap, picture-in-picture and independent audio.', 'First light · picture', 'After hours · picture and sound', 'Star card · transparent overlay', 'Synthesised tone · independent audio'],
    ja: ['タイムラインの基本', 'カット、空白、ピクチャーインピクチャー、独立した音声を使った、オリジナルの10秒間の作例です。', '朝の光 · 映像', '夜のひととき · 映像と音声', '星のカード · 透過オーバーレイ', '合成音 · 独立した音声'],
  } as const;
  const media = ['media/scene-a.mp4', 'media/scene-b.mp4', 'media/overlay-star.png', 'media/sound-bed.wav'];
  const old = await f.instantiate(f.input('Older example'));
  f.withTarget(old, store => {
    const project = store.get('projects', old.project.projectId) as {description: string};
    assert.equal(project.description, f.content.project.description);
    assert.deepEqual(f.content.assets.map(asset => (store.get('assets', asset.id) as Asset).name), f.content.assets.map(asset => asset.name));
  });
  const original = tree(path.dirname(old.project.projectFile));
  const native = f.native(); assert.ok(native.instantiateTemplate);
  const invalid = f.input('Unsupported locale');
  assert.equal((await f.rpc('project.template.instantiate', {...invalid, locale: 'system'})).status, 400);
  assert.equal(existsSync(path.join(f.targets, invalid.name)), false);
  for (const locale of LOCALES) {
    const [name, description, ...assetNames] = labels[locale];
    const input = {...f.input(name), locale};
    const copy = await native.instantiateTemplate(input);
    assert.equal(copy.project.name, name);
    f.withTarget(copy, store => {
      const project = store.get('projects', copy.project.projectId) as {name: string; description: string};
      assert.equal(project.name, name);
      assert.equal(project.description, description);
      for (const [index, relative] of media.entries()) {
        const source = f.content.assets.find(asset => asset.reference.path === relative); assert.ok(source);
        const asset = store.get('assets', source.id) as Asset;
        assert.equal(asset.name, assetNames[index], relative);
        assert.equal(asset.reference.path, relative);
        assert.equal(asset.reference.fullSha256, source.reference.fullSha256);
        assert.equal(sha(readFileSync(path.join(store.projectDir, relative))), source.reference.fullSha256);
      }
    });
    assert.deepEqual(await f.instantiate(input), copy);
    const changedLocale = await f.rpc<ProjectCopyResponse>('project.template.instantiate', {...input, locale: locale === 'en' ? 'ja' : 'en'});
    assert.equal(changedLocale.status, 409);
    assert.equal(changedLocale.body.error?.code, 'REQUEST_ID_REUSED');
  }
  assert.deepEqual(tree(path.dirname(old.project.projectFile)), original);
  assert.deepEqual(tree(f.installed), f.original);
});

test('legacy-null instances reopen and serve all media offline without rewriting their metadata', async t => {
  const f = await fixture(t), copies = [await f.instantiate(f.input('Offline A')), await f.instantiate(f.input('Offline B'))];
  const assetRows = new Map(copies.map(copy => [copy.project.projectId, f.withTarget(copy, store => {
    // Preserve Q07's old-instance regression after the shipped data is fixed.
    store.tx(() => {
      for (const row of store.db.prepare('SELECT data FROM project.assets').all()) {
        const asset = JSON.parse(String(row.data)) as Asset;
        if (asset.mimeType.startsWith('audio/')) store.put('assets', {...asset, width: null, height: null});
        if (asset.mimeType.startsWith('image/')) store.put('assets', {...asset, duration: null});
      }
    });
    const rows = store.db.prepare('SELECT data FROM project.assets ORDER BY id').all().map(row => String(row.data));
    const audio = rows.filter(row => (JSON.parse(row) as Asset).mimeType.startsWith('audio/'));
    assert.equal(audio.length, 1);
    assert.equal((JSON.parse(audio[0]!) as Asset).width, null);
    assert.equal((JSON.parse(audio[0]!) as Asset).height, null);
    assert.equal((JSON.parse(rows.find(row => (JSON.parse(row) as Asset).mimeType.startsWith('image/'))!) as Asset).duration, null);
    return rows;
  })]));
  const readable = async (copy: ProjectCopyResponse) => {
    const projectId = copy.project.projectId;
    const aggregate = await f.rpc<ReadableProject>('project.get', {projectId}, projectId);
    const listed = await f.rpc<ReadableAsset[]>('asset.list', {projectId}, projectId);
    assert.deepEqual({projectGet: aggregate.status, assetList: listed.status}, {projectGet: 200, assetList: 200}, JSON.stringify({aggregate: aggregate.body, listed: listed.body}));
    assert.equal(aggregate.body.ok, true); assert.equal(listed.body.ok, true);
    assert.equal(aggregate.body.data?.project.id, projectId);
    const assets = listed.body.data!;
    assert.equal(assets.length, 4);
    assert.deepEqual([...aggregate.body.data!.assets].sort((a, b) => a.id.localeCompare(b.id)), [...assets].sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(assets.map(asset => asset.id).sort(), f.content.assets.map(asset => asset.id).sort());
    for (const asset of assets) {
      const original = f.content.assets.find(value => value.id === asset.id)!;
      assert.equal(asset.projectId, projectId); assert.equal(asset.name, original.name); assert.equal(asset.mimeType, original.mimeType);
      assert.equal(asset.sha256, original.sha256); assert.equal(asset.sizeBytes, original.sizeBytes);
      assert.equal(asset.url, projectMediaPath(projectId, asset.id));
      if (asset.mimeType.startsWith('audio/')) {
        assert.equal(Object.hasOwn(asset, 'width'), false); assert.equal(Object.hasOwn(asset, 'height'), false);
      }
    }
    const timeline = aggregate.body.data!.timeline;
    assert.equal(timeline.projectId, projectId); assert.equal(timeline.tracks.length, 3); assert.equal(timeline.clips.length, 5); assert.equal(timeline.durationFrames, 300);
    assert.deepEqual(timeline.clips.map(clip => clip.assetId).sort(), f.content.timelines[0]!.clips.map(clip => clip.assetId).sort());
    const usage = deriveTimelineAssetUsage({projectId, assets, timeline, ready: true});
    assert.equal(usage.status, 'ready');
    assert.deepEqual(f.content.assets.map(asset => usage.usesByAssetId[asset.id]?.length ?? 0), [1, 1, 1, 2]);
    const persisted = f.inspect(projectId, db => db.prepare('SELECT data FROM project.assets ORDER BY id').all().map(row => String(row.data)));
    assert.deepEqual(persisted, assetRows.get(projectId), 'reading legacy metadata must not rewrite the project or require a rebuilt instance');
  };
  for (const copy of copies) await readable(copy);
  renameSync(f.installed, f.installed + '-unavailable'); assert.equal(existsSync(f.installed), false);
  await f.restart();
  for (const copy of copies) {
    const windowId = randomUUID(), opened = await f.native().acquire({projectId: copy.project.projectId, windowId});
    assert.equal(opened.project.projectId, copy.project.projectId);
    await readable(copy);
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

test('a newly instantiated shipped example passes strict readers and real preview and export rendering', async t => {
  const f = await fixture(t), copy = await f.instantiate(f.input('Render the shipped example'));
  const projectId = copy.project.projectId, windowId = randomUUID();
  await f.native().acquire({projectId, windowId});
  t.after(() => f.native().release({windowId}));
  const aggregate = await f.rpc<ReadableProject>('project.get', {projectId}, projectId);
  assert.equal(aggregate.status, 200); assert.ok(aggregate.body.data);
  const {assets, timeline} = aggregate.body.data;
  const usage = deriveTimelineAssetUsage({projectId, assets, timeline, ready: true});
  assert.equal(usage.status, 'ready');
  assert.deepEqual(f.content.assets.map(asset => usage.usesByAssetId[asset.id]?.length ?? 0), [1, 1, 1, 2]);
  for (const asset of assets) {
    if (asset.mimeType.startsWith('image/')) assert.equal(asset.duration, 0);
    if (asset.mimeType.startsWith('audio/')) {assert.equal(asset.width, 0); assert.equal(asset.height, 0);}
  }
  for (const operation of ['project.inspect', 'timeline.inspect', 'timeline.export.preflight']) {
    const input = operation === 'timeline.export.preflight' ? {projectId, expectedRevision: timeline.revision} : {projectId};
    const result = await f.rpc<{status?: string}>(operation, input, projectId);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (operation === 'timeline.export.preflight') assert.equal(result.body.data?.status, 'ready');
  }
  const drafts = await f.get(projectId, `local-drafts?projectId=${projectId}`);
  assert.equal(drafts.status, 200); assert.ok(clipDraftListSchema.parse(drafts.body.data).supported);
  for (const clip of timeline.clips) {
    const draft = await f.get(projectId, `local-drafts/clip?projectId=${projectId}&timelineId=${timeline.id}&clipId=${clip.id}`);
    assert.equal(draft.status, 200); assert.ok(clipDraftEnvelopeSchema.parse(draft.body.data).supported);
  }
  const delivery = await f.get(projectId, `local-delivery?projectId=${projectId}`);
  assert.equal(delivery.status, 200);
  const deliverySchema = createLocalDeliverySchemas(value => schemas['timeline.render'].safeParse(value).success);
  assert.ok(deliverySchema.envelope.parse(delivery.body.data).supported);
  const before = f.inspect(projectId, db => db.prepare('SELECT data FROM project.assets ORDER BY id').all().map(row => String(row.data)));
  interface Render {id: string; status: string; assetId: string | null; snapshot: {assets: Array<Record<string, unknown>>}}
  for (const purpose of ['preview', 'export'] as const) {
    const input = {projectId, expectedRevision: timeline.revision, requestId: randomUUID(), purpose};
    const submitted = await f.rpc<Render>('timeline.render', input, projectId);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body)); assert.ok(submitted.body.data);
    const id = submitted.body.data.id;
    const raw = () => f.inspect(projectId, db => JSON.parse(String(db.prepare('SELECT data FROM exports WHERE id=?').get(id)!.data)) as Render);
    assert.ok(isTimelineRenderRecord(raw(), input));
    const deadline = performance.now() + 180_000;
    let rendered = submitted.body.data;
    while (!['succeeded', 'failed'].includes(rendered.status)) {
      assert.ok(performance.now() < deadline, `the real ${purpose} render finishes`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const result = await f.rpc<Render>('export.get', {exportId: id}, projectId);
      assert.equal(result.status, 200); assert.ok(result.body.data); rendered = result.body.data;
    }
    assert.equal(rendered.status, 'succeeded', JSON.stringify(rendered)); assert.ok(rendered.assetId);
    const saved = raw(); assert.ok(isTimelineRenderRecord(saved, input));
    assert.ok(saved.snapshot.assets.every(asset => ['duration', 'width', 'height'].every(key => asset[key] !== null)));
    const bytes = await f.readMedia(projectId, rendered.assetId); assert.ok(bytes.length > 1024);
    const output = path.join(f.root, `${purpose}-verified.mp4`); writeFileSync(output, bytes);
    const media = await probe(output); assert.equal(media.hasVideo, true); assert.equal(media.hasAudio, true);
    assert.ok(media.duration >= 9.9 && media.duration <= 10.1);
  }
  const after = f.inspect(projectId, db => db.prepare('SELECT data FROM project.assets WHERE id IN (?,?,?,?) ORDER BY id').all(...f.content.assets.map(asset => asset.id)).map(row => String(row.data)));
  assert.deepEqual(after, before, 'rendering never repairs the source metadata');
  assert.deepEqual(tree(f.installed), f.original);
});

test('real-example target conflicts preserve both empty and populated existing folders and add no registration', async t => {
  const f = await fixture(t), originalRegistry = await f.native().listRecent();
  for (const name of ['Existing empty', 'Existing populated']) {
    const input = f.input(name), target = path.join(f.targets, name); mkdirSync(target);
    if (name === 'Existing populated') writeFileSync(path.join(target, 'user.txt'), 'keep user content');
    const before = tree(target), response = await f.rpc('project.template.instantiate', input);
    assert.equal(response.status, 409); assert.equal(response.body.error?.code, 'PROJECT_FILE_EXISTS'); assert.deepEqual(tree(target), before);
  }
  assert.deepEqual(await f.native().listRecent(), originalRegistry); assert.deepEqual(tree(f.installed), f.original);
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
