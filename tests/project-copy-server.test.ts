import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as pause} from 'node:timers/promises';
import {startServer, type InspectApplication, type InspectProject, type ServerOptions} from '../apps/server/src/index.ts';
import {serverAppDirectories, projectLocation} from '../apps/server/src/project-host/directories.ts';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {createProjectCopies} from '../apps/server/src/project-host/copies.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {openProjectStore, isProjectFileHeld} from '../packages/business/src/project-file/index.ts';
import {HISTORY_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {DRAFT_TABLES} from '../packages/business/src/project-file/schema/domains/drafts.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {projectCopyResponseSchema, type ProjectCopyInput, type ProjectCopyResponse} from '../packages/contracts/src/project-copies.ts';
import type {ProjectVersionSaveResponse, ProjectVersionPreviewResponse} from '../packages/contracts/src/project-version-operations.ts';
import type {ClipDraftEnvelope} from '../packages/contracts/src/local-drafts.ts';
import type {LocalDeliveryEnvelope} from '../packages/contracts/src/local-delivery.ts';
import type {LocalShotTextEnvelope} from '../packages/contracts/src/local-shot-text.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {readProjectState, changeMarks} from './helpers/project-state.ts';

interface Wire<T> {ok: boolean; data?: T; error?: {code: string; details?: unknown}}
const token = 'synthetic-project-copy-server-token';
const snapshot = (db: DatabaseSync) => ({...readProjectState(db), marks: changeMarks(db)});

async function eventually(check: () => boolean): Promise<void> {
  const limit = performance.now() + 10_000;
  while (!check()) {assert.ok(performance.now() < limit, 'the real host releases its file before a closed-source read'); await pause(5);}
}
function fileTree(directory: string): unknown {
  if (!existsSync(directory)) return null;
  return readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), info = lstatSync(file, {bigint: true});
    assert.equal(info.isSymbolicLink(), false);
    return {name, dev: String(info.dev), ino: String(info.ino), size: info.isDirectory() ? null : String(info.size),
      content: info.isDirectory() ? fileTree(file) : readFileSync(file).toString('base64')};
  });
}

async function occupyHistory(file: string): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    process.send('locked');
    process.once('message',()=>{db.exec('ROLLBACK');db.close();process.disconnect();});
  `, file], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(Error(`history holder exited before release: ${code}`)));
      child.once('message', message => {if (message === 'locked') resolve(); else reject(Error('unexpected holder message'));});
    });
  } catch (error) {child.kill('SIGKILL'); throw error;}
  return async () => {const ended = once(child, 'exit'); child.send('release'); const [code, signal] = await ended; assert.equal(code, 0); assert.equal(signal, null);};
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-copy-server-'));
  const dataDir = path.join(root, 'app'), projectsDir = path.join(root, 'projects'), targets = path.join(root, 'targets');
  mkdirSync(projectsDir); mkdirSync(targets);
  let application!: InspectApplication, inspect!: InspectProject;
  let boundary: ServerOptions['projectCopyBoundaryForTest'];
  const gates: Array<() => void> = [];
  const server = await startServer({dataDir, projectsDir, port: 0, token, inspectApplication: received => {application = received;},
    inspectProject: received => {inspect = received;}, projectCopyBoundaryForTest: (phase, input) => boundary?.(phase, input)});
  t.after(async () => {for (const release of gates) release(); await server.close(); rmSync(root, {recursive: true, force: true});});
  const native = server.projectEntries;
  assert.ok(native.duplicate); assert.ok(native.saveAs);
  const rpc = async <T = unknown>(operation: string, input: unknown, projectId?: string, authenticated = true) => {
    const response = await fetch(server.url + (projectId ? `/api/projects/${projectId}/rpc` : '/api/rpc'), {
      method: 'POST', headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {})},
      body: JSON.stringify({operation, input})});
    return {status: response.status, body: await response.json() as Wire<T>};
  };
  const source = await native.create({name: 'Source 🎬', projectFile: path.join(projectsDir, 'Source.mioon')});
  const windowId = randomUUID(); await native.acquire({projectId: source.projectId, windowId});
  const saved = await rpc<ProjectVersionSaveResponse>('project.version.save', {projectId: source.projectId, requestId: randomUUID(), name: 'Manual checkpoint'}, source.projectId);
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.ok, true); assert.ok(saved.body.data);
  // A real terminal execution row distinguishes carrying versions from copying
  // the source execution domain. It is not eligible for worker resumption.
  const jobId = randomUUID();
  inspect(source.projectId, db => db.prepare('INSERT INTO main.jobs(id,projectId,data) VALUES(?,?,?)').run(jobId, source.projectId,
    JSON.stringify({id: jobId, projectId: source.projectId, status: 'succeeded', phase: 'completed', createdAt: '2026-11-04T00:00:00.000Z'})));
  const sourceVersions = inspect(source.projectId, db => db.prepare('SELECT id,trigger,name,createdAt FROM project_versions ORDER BY id').all());
  assert.ok(sourceVersions.some(row => row.trigger === 'manual')); assert.ok(sourceVersions.some(row => row.trigger === 'daily-open'));
  const sourceStamp = inspect(source.projectId, readProjectContentStamp);
  native.release({windowId}); await eventually(() => !isProjectFileHeld(source.fileIdentity));
  const directories = serverAppDirectories(dataDir, {projectsDir});
  const local = projectLocation(directories, source.projectId);
  const sourceFiles = () => {
    assert.equal(isProjectFileHeld(source.fileIdentity), false);
    return {file: readFileSync(source.projectFile).toString('base64'), records: fileTree(local.localDir)};
  };
  const input = (name = 'Copy'): ProjectCopyInput => ({projectId: source.projectId, requestId: randomUUID(), projectFile: path.join(targets, `${name}.mioon`), name});
  const targetStore = (copy: ProjectCopyResponse) => {
    assert.equal(isProjectFileHeld(copy.project.fileIdentity), false);
    return openProjectStore({projectFile: copy.project.projectFile, locate: id => projectLocation(directories, id)});
  };
  const gate = () => {const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); gates.push(released.resolve); return {entered, released};};
  return {root, dataDir, targets, source, local, native, server, rpc, application, inspect, sourceVersions, sourceStamp,
    manualId: saved.body.data.version.id, sourceFiles, input, targetStore, gate, setBoundary: (value: typeof boundary) => {boundary = value;}};
}
function denied(result: {status: number; body: Wire<unknown>}, status: number, code: string): void {
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.ok, false); assert.equal(result.body.error?.code, code);
}

type CopyFixture = Awaited<ReturnType<typeof fixture>>;
const draftRows = (db: DatabaseSync) => Object.fromEntries(DRAFT_TABLES.map(table => [table, db.prepare(`SELECT rowid,* FROM main.${table} ORDER BY rowid`).all()]));
const authority = (value: {workspaceScope: string; instanceId: string}) => ({workspaceScope: value.workspaceScope, instanceId: value.instanceId});

async function seedS8Drafts(f: CopyFixture, keepWindow = false) {
  const projectId = f.source.projectId, windowId = randomUUID(); await f.native.acquire({projectId, windowId});
  const json = async <T>(tail: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${f.server.url}/api/projects/${projectId}${tail}`, {method,
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, body: await response.json() as Wire<T>};
  };
  const data = <T>(result: {status: number; body: Wire<T>}): T => {
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true); assert.ok(result.body.data); return result.body.data;
  };
  const asset = data(await f.rpc<{id: string; sha256: string}>('asset.import', {projectId, name: 'Draft source.png', mimeType: 'image/png',
    dataBase64: png({width: 16, height: 16, rgba: false, tagged: false}).toString('base64')}, projectId));
  type Timeline = {id: string; revision: number; tracks: Array<{id: string}>; clips: Array<{id: string; assetId: string}>};
  const initialTimeline = data(await f.rpc<Timeline>('timeline.get', {projectId}, projectId));
  const timeline = data(await f.rpc<Timeline>('timeline.clip.add', {projectId, requestId: randomUUID(), expectedRevision: initialTimeline.revision,
    assetId: asset.id, trackId: initialTimeline.tracks[0]!.id, startFrame: 0, durationFrames: 30}, projectId));
  const clip = timeline.clips.find(value => value.assetId === asset.id); assert.ok(clip);
  const shot = data(await f.rpc<{id: string; revision: number; title: string; prompt: string}>('shot.create', {projectId,
    title: 'Unchanged business title', prompt: 'Retained business prompt', requestId: randomUUID()}, projectId));
  data(await f.rpc<ProjectVersionSaveResponse>('project.version.save', {projectId, requestId: randomUUID(), name: 'S8 business checkpoint'}, projectId));
  const beforeContent = f.inspect(projectId, readProjectContentStamp);

  const key = {projectId, timelineId: timeline.id, clipId: clip.id}, query = new URLSearchParams(key).toString();
  const clipEnvelope = data(await json<ClipDraftEnvelope>(`/local-drafts/clip?${query}`)); assert.equal(clipEnvelope.supported, true);
  if (!clipEnvelope.supported) throw Error('Expected a current clip draft owner');
  const savedClip = data(await json<ClipDraftEnvelope>('/local-drafts/clip', 'PUT', {...authority(clipEnvelope), ...key,
    expectedRevision: 0, baseRevision: timeline.revision, source: {assetId: asset.id, assetSha256: asset.sha256},
    raw: {name: 'Unapplied clip text', trackId: timeline.tracks[0]!.id, startFrame: '4', durationFrames: '30', sourceInFrame: '0',
      rect: {x: '0', y: '0', width: '1080', height: '1920'}, gain: '1'}}));
  assert.equal(savedClip.supported, true); if (!savedClip.supported) throw Error('Expected a stored clip draft');
  assert.equal(savedClip.draft?.raw.name, 'Unapplied clip text');

  const delivery = data(await json<LocalDeliveryEnvelope>(`/local-delivery?projectId=${projectId}`)); assert.equal(delivery.supported, true);
  if (!delivery.supported) throw Error('Expected a current delivery draft owner');
  const savedDelivery = data(await json<LocalDeliveryEnvelope>('/local-delivery/draft', 'PUT', {...authority(delivery), projectId,
    expectedDraftRevision: 0, draftId: randomUUID(), timelineId: timeline.id, baseRevision: timeline.revision, raw: {deliveryName: 'Unapplied output draft'}}));
  assert.equal(savedDelivery.supported, true); if (!savedDelivery.supported) throw Error('Expected a stored delivery draft');
  assert.equal(savedDelivery.draft?.raw.deliveryName, 'Unapplied output draft');

  const initialShot = data(await json<LocalShotTextEnvelope>(`/local-shot-text?projectId=${projectId}&shotId=${shot.id}`)); assert.equal(initialShot.supported, true);
  if (!initialShot.supported) throw Error('Expected a current shot draft owner');
  const raw = {title: 'Pending title must not execute', prompt: shot.prompt}, draftId = randomUUID();
  const savedShot = data(await json<LocalShotTextEnvelope>('/local-shot-text/draft', 'PUT', {...authority(initialShot), projectId, shotId: shot.id,
    expectedDraftRevision: 0, draftId, baseRevision: shot.revision, baseText: {title: shot.title, prompt: shot.prompt}, raw}));
  assert.equal(savedShot.supported, true); if (!savedShot.supported) throw Error('Expected a stored shot draft');
  const pending = data(await json<LocalShotTextEnvelope>('/local-shot-text/prepare', 'POST', {...authority(savedShot), projectId, shotId: shot.id,
    expectedIntentRevision: 0, expectedIntentId: null, intentId: randomUUID(), baseRevision: shot.revision,
    baseText: {title: shot.title, prompt: shot.prompt}, draft: {draftId, revision: savedShot.draftRevision, raw},
    input: {requestId: randomUUID(), shotId: shot.id, expectedRevision: shot.revision, patch: {title: raw.title}}}));
  assert.equal(pending.supported, true); if (!pending.supported) throw Error('Expected a pending shot intent');
  assert.equal(pending.intent?.outcome.status, 'pending');
  const rows = f.inspect(projectId, draftRows);
  assert.equal(rows.local_draft_states.length, 3);
  for (const table of ['local_clip_drafts', 'local_delivery_drafts', 'local_shot_text_drafts']) assert.equal(rows[table].length, 1, table);
  assert.deepEqual(f.inspect(projectId, readProjectContentStamp), beforeContent, 'all three draft saves and preparation write only history');
  assert.equal(f.inspect(projectId, db => db.prepare('SELECT version FROM main.schema_version').get()!.version), 9);
  const versions = f.inspect(projectId, db => db.prepare('SELECT id,trigger,name,createdAt FROM project_versions ORDER BY id').all());
  const staleWrite = {...authority(pending), projectId, shotId: shot.id, expectedDraftRevision: pending.draftRevision, draftId,
    baseRevision: shot.revision, baseText: {title: shot.title, prompt: shot.prompt}, raw: {title: 'A stale owner cannot save this', prompt: shot.prompt}};
  if (!keepWindow) {f.native.release({windowId}); await eventually(() => !isProjectFileHeld(f.source.fileIdentity));}
  return {windowId, rows, versions, beforeContent, shot, pending, staleWrite, json};
}

for (const operation of ['project.duplicate', 'project.save-as'] as const)
  test(`history9 ${operation} carries versions without any of the source's nonempty S8 draft tables`, async t => {
    const f = await fixture(t), seeded = await seedS8Drafts(f), before = f.sourceFiles(), input = f.input('S8 copy');
    const result = await f.rpc<ProjectCopyResponse>(operation, input); assert.equal(result.status, 200, JSON.stringify(result.body));
    const copy = projectCopyResponseSchema.parse(result.body.data); assert.equal(copy.versions, seeded.versions.length);
    assert.deepEqual(f.sourceFiles(), before, 'closed-source history and all pending draft bytes remain unchanged');
    const target = f.targetStore(copy);
    try {
      assert.equal(target.historyState, 'current'); assert.equal(target.db.prepare('SELECT version FROM main.schema_version').get()!.version, 9);
      assert.deepEqual(readProjectContentStamp(target.db), {contentSequence: copy.contentSequence, contentToken: copy.contentToken});
      assert.deepEqual(target.db.prepare('SELECT id,trigger,name,createdAt FROM project_versions ORDER BY id').all(), seeded.versions);
      for (const table of DRAFT_TABLES) assert.deepEqual(target.db.prepare(`SELECT * FROM main.${table}`).all(), [], table);
      assert.equal((target.get('shots', seeded.shot.id) as {title: string}).title, seeded.shot.title);
      assert.equal(target.db.prepare('SELECT count(*) n FROM main.jobs').get()!.n, 0);
    } finally {target.close();}
    const windowId = randomUUID(); await f.native.acquire({projectId: copy.project.projectId, windowId});
    const current = f.inspect(copy.project.projectId, draftRows); for (const table of DRAFT_TABLES) assert.deepEqual(current[table], [], table);
    assert.equal(f.inspect(copy.project.projectId, db => JSON.parse(String(db.prepare('SELECT data FROM project.shots WHERE id=?').get(seeded.shot.id)!.data)).title), seeded.shot.title);
    assert.deepEqual(f.sourceFiles(), before, 'opening the copy does not resume or rewrite the source drafts');
    f.native.release({windowId});
  });

for (const failureMode of ['existing-target', 'capture-fault'] as const)
  test(`S8 pending drafts survive native save-as ${failureMode}, reopening rejects its old instance, and retry omits all drafts`, async t => {
    const f = await fixture(t), seeded = await seedS8Drafts(f, true), input = {...f.input('S8 failed'), windowId: seeded.windowId};
    const failure = Error('S8 captured copy failure');
    if (failureMode === 'existing-target') writeFileSync(input.projectFile, 'Keep the existing target', {flag: 'wx'});
    else f.setBoundary(phase => {if (phase === 'captured') throw failure;});
    await assert.rejects(f.native.saveAs!(input), error => failureMode === 'capture-fault' ? error === failure
      : Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'PROJECT_FILE_EXISTS'));
    f.setBoundary(undefined);
    const opened = await f.native.acquire({projectId: f.source.projectId, windowId: seeded.windowId}); assert.equal(opened.project.projectId, f.source.projectId);
    assert.deepEqual(f.inspect(f.source.projectId, draftRows), seeded.rows);
    assert.deepEqual(f.inspect(f.source.projectId, readProjectContentStamp), seeded.beforeContent);
    const read = await seeded.json<LocalShotTextEnvelope>(`/local-shot-text?projectId=${f.source.projectId}&shotId=${seeded.shot.id}`);
    assert.equal(read.status, 200); assert.ok(read.body.data?.supported);
    assert.equal(read.body.data.intent?.outcome.status, 'pending'); assert.notEqual(read.body.data.instanceId, seeded.pending.instanceId);
    const beforeStale = f.inspect(f.source.projectId, snapshot);
    denied(await seeded.json('/local-shot-text/draft', 'PUT', seeded.staleWrite), 409, 'LOCAL_SHOT_TEXT_STALE_INSTANCE');
    assert.deepEqual(f.inspect(f.source.projectId, snapshot), beforeStale, 'retired draft authority cannot write after the source reopens');

    const copied = await f.native.saveAs!({...f.input('S8 retry'), windowId: seeded.windowId});
    assert.equal(copied.window.windowId, seeded.windowId); assert.equal(copied.copy.versions, seeded.versions.length);
    assert.notEqual(copied.window.project.projectId, f.source.projectId); assert.equal(isProjectFileHeld(f.source.fileIdentity), false);
    const targetDrafts = f.inspect(copied.copy.project.projectId, draftRows); for (const table of DRAFT_TABLES) assert.deepEqual(targetDrafts[table], [], table);
    const stamp = f.inspect(copied.copy.project.projectId, db => ({file: readProjectContentStamp(db), seen: db.prepare('SELECT seenContentSequence,seenContentToken FROM history_state').get()}));
    assert.equal(stamp.seen?.seenContentSequence, stamp.file.contentSequence); assert.equal(stamp.seen?.seenContentToken, stamp.file.contentToken);
    assert.equal(f.inspect(copied.copy.project.projectId, db => JSON.parse(String(db.prepare('SELECT data FROM project.shots WHERE id=?').get(seeded.shot.id)!.data)).title), seeded.shot.title);
    const sourceHistory = new DatabaseSync(path.join(f.local.localDir, 'history.db'), {readOnly: true});
    try {assert.deepEqual(draftRows(sourceHistory), seeded.rows);} finally {sourceHistory.close();}
    if (failureMode === 'existing-target') assert.equal(readFileSync(input.projectFile, 'utf8'), 'Keep the existing target');
    f.native.release({windowId: seeded.windowId});
  });

for (const operation of ['project.duplicate', 'project.save-as'] as const)
  test(`authenticated ${operation} carries real manual/daily versions into a current project with an empty execution domain`, async t => {
    const f = await fixture(t), before = f.sourceFiles(), input = f.input();
    const result = await f.rpc<ProjectCopyResponse>(operation, input);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true);
    const copy = projectCopyResponseSchema.parse(result.body.data);
    assert.equal(copy.requestId, input.requestId); assert.equal(copy.sourceProjectId, f.source.projectId);
    assert.notEqual(copy.project.projectId, f.source.projectId); assert.notEqual(copy.contentToken, f.sourceStamp.contentToken);
    assert.equal(copy.project.projectFile, input.projectFile); assert.equal(copy.project.name, input.name); assert.equal(copy.project.lastOpenedAt, null);
    assert.equal(copy.versions, f.sourceVersions.length); assert.deepEqual(f.sourceFiles(), before);
    const store = f.targetStore(copy);
    try {
      assert.equal(store.historyState, 'current'); assert.deepEqual(readProjectContentStamp(store.db), {contentSequence: copy.contentSequence, contentToken: copy.contentToken});
      assert.equal((store.get('projects', copy.project.projectId) as {name: string}).name, input.name);
      const rows = store.db.prepare('SELECT id,trigger,name,createdAt FROM project_versions ORDER BY id').all();
      assert.deepEqual(rows, f.sourceVersions);
      assert.deepEqual(store.db.prepare('SELECT DISTINCT projectId FROM project_versions').all().map(row => row.projectId), [copy.project.projectId]);
      for (const table of HISTORY_TABLES.filter(name => !['project_versions', 'project_version_blobs', 'mio_storage_counters'].includes(name)))
        assert.equal(store.db.prepare(`SELECT count(*) n FROM main."${table}"`).get()!.n, 0, table);
      assert.deepEqual({...store.db.prepare('SELECT * FROM mio_storage_counters').get()}, {singleton: 1, bytes: 0, rows: 1});
      const preview = createProjectVersions(store).preview({projectId: copy.project.projectId, versionId: f.manualId});
      assert.equal(preview.restoreAvailable, false, 'the readonly kernel probe has no application mutation capability');
      assert.equal(preview.projectId, copy.project.projectId); assert.equal(preview.version.id, f.manualId);
    } finally {store.close();}
    const preview = await f.rpc<ProjectVersionPreviewResponse>('project.version.preview', {projectId: copy.project.projectId, versionId: f.manualId}, copy.project.projectId);
    assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.ok(preview.body.data);
    assert.equal(preview.body.data.restoreAvailable, true, JSON.stringify(preview.body));
    assert.equal(preview.body.data.projectId, copy.project.projectId); assert.equal(preview.body.data.version.id, f.manualId);
    assert.equal(f.native.listRecent().registered.filter(entry => entry.project.projectId === copy.project.projectId).length, 1);
  });

test('copy authenticates before validation and refuses malformed/private/existing targets without source or application writes', async t => {
  const f = await fixture(t), input = f.input(), before = f.sourceFiles(), app = f.application(snapshot);
  denied(await f.rpc('project.duplicate', null, undefined, false), 401, 'UNAUTHORIZED');
  for (const invalid of [undefined, {}, {...input, requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}, {...input, projectId: 'bad'},
    {...input, name: 'CON'}, {...input, projectFile: 'relative.mioon'}, {...input, projectFile: path.join(f.targets, '.hidden.mioon')}, {...input, includeHistory: true}])
    denied(await f.rpc('project.duplicate', invalid), 400, 'VALIDATION_ERROR');
  denied(await f.rpc('project.duplicate', {...input, projectFile: path.join(f.dataDir, 'records', 'private.mioon')}), 400, 'PROJECT_LOCATION_INVALID');
  writeFileSync(input.projectFile, 'Preserve existing target', {flag: 'wx'});
  denied(await f.rpc('project.duplicate', input), 409, 'PROJECT_FILE_EXISTS');
  assert.equal(readFileSync(input.projectFile, 'utf8'), 'Preserve existing target');
  assert.deepEqual(f.sourceFiles(), before); assert.deepEqual(f.application(snapshot), app);
});

test('duplicate refuses a source window without revoking it or cancelling the source runtime', async t => {
  const f = await fixture(t), windowId = randomUUID(), opened = await f.native.acquire({projectId: f.source.projectId, windowId});
  const events: unknown[] = []; const remove = f.native.onWindowRevoked(event => events.push(event)); t.after(remove);
  const before = f.inspect(f.source.projectId, snapshot), input = f.input();
  denied(await f.rpc('project.duplicate', input), 409, 'PROJECT_HOST_BUSY');
  await assert.rejects(f.native.duplicate!(input), {code: 'PROJECT_HOST_BUSY', status: 409});
  assert.deepEqual(await f.native.acquire({projectId: f.source.projectId, windowId}), opened);
  assert.deepEqual(f.inspect(f.source.projectId, snapshot), before); assert.deepEqual(events, []); assert.equal(existsSync(input.projectFile), false);
  f.native.release({windowId});
});

test('copy refuses foreign-platform absolute paths before interpreting them as local relative targets', async t => {
  const f = await fixture(t), input = f.input(), before = f.sourceFiles(), app = f.application(snapshot);
  const foreign = process.platform === 'win32' ? ['/projects/Copy.mioon'] : ['C:\\Projects\\Copy.mioon', '\\\\server\\share\\Copy.mioon'];
  for (const projectFile of foreign) for (const operation of ['project.duplicate', 'project.save-as'])
    denied(await f.rpc(operation, {...input, projectFile}), 400, 'VALIDATION_ERROR');
  assert.deepEqual(f.sourceFiles(), before); assert.deepEqual(f.application(snapshot), app);
  assert.equal(existsSync(path.join(f.dataDir, 'project-copies')), false);
  assert.deepEqual(readdirSync(f.targets), []);
});

test('native save-as moves the same window to the new project and replays without reopening its source', async t => {
  const f = await fixture(t), windowId = randomUUID(); await f.native.acquire({projectId: f.source.projectId, windowId});
  const input = {...f.input(), windowId}, result = await f.native.saveAs!(input);
  assert.equal(result.window.windowId, windowId); assert.equal(result.window.project.projectId, result.copy.project.projectId);
  assert.notEqual(result.window.project.projectId, f.source.projectId); assert.equal(result.copy.versions, f.sourceVersions.length);
  assert.equal(isProjectFileHeld(f.source.fileIdentity), false); assert.equal(isProjectFileHeld(result.copy.project.fileIdentity), true);
  const before = f.inspect(result.copy.project.projectId, snapshot);
  assert.deepEqual(await f.native.saveAs!(input), result);
  assert.deepEqual(f.inspect(result.copy.project.projectId, snapshot), before);
  assert.equal(isProjectFileHeld(f.source.fileIdentity), false);
  f.native.release({windowId});
});

test('save-as replay reuses a window reopened by target path and preserves the edited content pair', async t => {
  const f = await fixture(t), windowId = randomUUID(); await f.native.acquire({projectId: f.source.projectId, windowId});
  const input = {...f.input(), windowId}, first = await f.native.saveAs!(input), target = first.copy.project;
  const project = f.inspect(target.projectId, db => JSON.parse(String(db.prepare('SELECT data FROM project.projects WHERE id=?').get(target.projectId)!.data)) as {revision: number});
  const changed = await f.rpc('project.notes.set', {projectId: target.projectId, requestId: randomUUID(), expectedRevision: project.revision, notes: 'Edited before reopening by path'}, target.projectId);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const edited = f.inspect(target.projectId, readProjectContentStamp);
  assert.notEqual(edited.contentToken, first.copy.contentToken);
  f.native.release({windowId}); await eventually(() => !isProjectFileHeld(target.fileIdentity));
  const opened = await f.native.openPath({projectFile: target.projectFile, windowId});
  assert.equal(opened.project.projectId, target.projectId);
  const before = f.inspect(target.projectId, snapshot), result = await f.native.saveAs!(input);
  assert.deepEqual(result.copy, first.copy); assert.deepEqual(result.window, opened); assert.equal(result.window.windowId, windowId);
  assert.deepEqual(f.inspect(target.projectId, readProjectContentStamp), edited);
  assert.deepEqual(f.inspect(target.projectId, snapshot), before); assert.equal(isProjectFileHeld(f.source.fileIdentity), false);
  f.native.release({windowId});
});

for (const mode of ['existing-target', 'capture-fault'] as const) test(`native save-as reopens its source window after ${mode}`, async t => {
  const f = await fixture(t), windowId = randomUUID(); await f.native.acquire({projectId: f.source.projectId, windowId});
  const input = {...f.input(), windowId}, before = f.inspect(f.source.projectId, readProjectContentStamp), failure = Error('injected copy capture failure');
  if (mode === 'existing-target') writeFileSync(input.projectFile, 'Keep this target', {flag: 'wx'});
  else f.setBoundary(phase => {if (phase === 'captured') throw failure;});
  await assert.rejects(f.native.saveAs!(input), error => mode === 'capture-fault' ? error === failure
    : Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'PROJECT_FILE_EXISTS'));
  f.setBoundary(undefined);
  const reopened = await f.native.acquire({projectId: f.source.projectId, windowId});
  assert.equal(reopened.project.projectId, f.source.projectId); assert.equal(isProjectFileHeld(f.source.fileIdentity), true);
  assert.deepEqual(f.inspect(f.source.projectId, readProjectContentStamp), before);
  if (mode === 'existing-target') assert.equal(readFileSync(input.projectFile, 'utf8'), 'Keep this target');
  else assert.equal(existsSync(input.projectFile), false);
  f.native.release({windowId});
});

test('a registered save-as failure reopens its source, and the original key later opens the edited target without recopying', async t => {
  const f = await fixture(t), windowId = randomUUID(); await f.native.acquire({projectId: f.source.projectId, windowId});
  const input = {...f.input(), windowId}, failure = Error('registered copy acknowledgement was lost'); let registrations = 0;
  f.setBoundary(phase => {if (phase === 'registered') {registrations++; throw failure;}});
  await assert.rejects(f.native.saveAs!(input), error => error === failure);
  assert.equal((await f.native.acquire({projectId: f.source.projectId, windowId})).project.projectId, f.source.projectId);
  assert.equal(isProjectFileHeld(f.source.fileIdentity), true);
  const receipt = f.application(db => db.prepare('SELECT response FROM app_operation_receipts WHERE operation=? AND requestId=?').get('project.save-as', input.requestId));
  assert.ok(receipt); const committed = projectCopyResponseSchema.parse(JSON.parse(String(receipt.response)));
  assert.equal(committed.project.projectFile, input.projectFile);
  assert.notEqual(committed.project.projectId, f.source.projectId);
  const target = f.targetStore(committed);
  let later: ReturnType<typeof readProjectContentStamp>;
  try {
    const project = target.get('projects', committed.project.projectId) as {id: string; name: string; revision: number};
    target.tx(() => target.put('projects', {...project, name: 'Edited after lost save-as reply', revision: project.revision + 1}));
    later = readProjectContentStamp(target.db);
    assert.notEqual(later.contentToken, committed.contentToken);
  } finally {target.close();}
  const identity = lstatSync(input.projectFile, {bigint: true}), bytes = readFileSync(input.projectFile);
  f.setBoundary(phase => {if (phase === 'registered') registrations++;});
  const result = await f.native.saveAs!(input);
  assert.deepEqual(result.copy, committed); assert.equal(result.window.windowId, windowId);
  assert.equal(result.window.project.projectId, committed.project.projectId); assert.equal(registrations, 1);
  const actual = lstatSync(input.projectFile, {bigint: true}); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
  assert.deepEqual(f.inspect(committed.project.projectId, readProjectContentStamp), later);
  assert.equal(f.inspect(committed.project.projectId, db => JSON.parse(String(db.prepare('SELECT data FROM project.projects WHERE id=?').get(committed.project.projectId)!.data)).name), 'Edited after lost save-as reply');
  assert.equal(isProjectFileHeld(f.source.fileIdentity), false);
  f.native.release({windowId}); await eventually(() => !isProjectFileHeld(committed.project.fileIdentity));
  assert.deepEqual(readFileSync(input.projectFile), bytes);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE operation=? AND requestId=?').get('project.save-as', input.requestId)!.n), 1);
});

test('native save-as rejects a different owner and multiple source windows without releasing either owner', async t => {
  const f = await fixture(t), windowId = randomUUID(), otherWindow = randomUUID();
  const first = await f.native.acquire({projectId: f.source.projectId, windowId}), input = f.input();
  await assert.rejects(f.native.saveAs!({...input, windowId: randomUUID()}), {code: 'PROJECT_ENTRY_UNAVAILABLE', status: 503});
  const second = await f.native.acquire({projectId: f.source.projectId, windowId: otherWindow});
  const before = f.inspect(f.source.projectId, snapshot);
  await assert.rejects(f.native.saveAs!({...input, windowId}), {code: 'PROJECT_HOST_BUSY', status: 409});
  assert.deepEqual(await f.native.acquire({projectId: f.source.projectId, windowId}), first);
  assert.deepEqual(await f.native.acquire({projectId: f.source.projectId, windowId: otherWindow}), second);
  assert.deepEqual(f.inspect(f.source.projectId, snapshot), before); assert.equal(existsSync(input.projectFile), false);
  f.native.release({windowId}); f.native.release({windowId: otherWindow});
});

test('concurrent identical copy requests share one receipt while a competing key cannot overwrite their target', async t => {
  const f = await fixture(t), gate = f.gate(), input = f.input();
  f.setBoundary(async phase => {if (phase === 'prepared') {gate.entered.resolve(); await gate.released.promise;}});
  const first = f.rpc<ProjectCopyResponse>('project.duplicate', input);
  await Promise.race([gate.entered.promise, first.then(result => assert.fail('copy ended before preparation: ' + JSON.stringify(result)))]);
  const same = f.rpc<ProjectCopyResponse>('project.duplicate', input);
  try {denied(await f.rpc('project.duplicate', {...input, requestId: randomUUID()}), 409, 'PROJECT_COPY_BUSY');}
  finally {gate.released.resolve();}
  const [a, b] = await Promise.all([first, same]); assert.equal(a.status, 200, JSON.stringify(a.body)); assert.deepEqual(b, a);
  const copy = projectCopyResponseSchema.parse(a.body.data);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE operation=? AND requestId=?').get('project.duplicate', input.requestId)!.n), 1);
  assert.equal(f.native.listRecent().registered.filter(entry => entry.project.projectId === copy.project.projectId).length, 1);
});

test('a target installed after preparation is preserved and never registered as this copy', async t => {
  const f = await fixture(t), gate = f.gate(), input = f.input(), before = f.sourceFiles();
  f.setBoundary(async phase => {if (phase === 'ready') {gate.entered.resolve(); await gate.released.promise;}});
  const pending = f.rpc('project.duplicate', input);
  await Promise.race([gate.entered.promise, pending.then(result => assert.fail('copy ended before target preparation: ' + JSON.stringify(result)))]);
  writeFileSync(input.projectFile, 'External target won the race', {flag: 'wx'}); gate.released.resolve();
  denied(await pending, 409, 'PROJECT_COPY_TARGET_CHANGED');
  assert.equal(readFileSync(input.projectFile, 'utf8'), 'External target won the race'); assert.deepEqual(f.sourceFiles(), before);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
  assert.equal(f.native.listRecent().registered.length, 1);
});

test('copy replay preserves later edits on a held target and never regrants a revoked directory', async t => {
  const f = await fixture(t), input = f.input(), first = await f.rpc<ProjectCopyResponse>('project.duplicate', input);
  assert.equal(first.status, 200, JSON.stringify(first.body)); const copy = projectCopyResponseSchema.parse(first.body.data);
  const windowId = randomUUID(); await f.native.acquire({projectId: copy.project.projectId, windowId});
  const project = f.inspect(copy.project.projectId, db => JSON.parse(String(db.prepare('SELECT data FROM project.projects WHERE id=?').get(copy.project.projectId)!.data)) as {revision: number});
  const changed = await f.rpc('project.notes.set', {projectId: copy.project.projectId, requestId: randomUUID(), expectedRevision: project.revision, notes: 'Later target edit'}, copy.project.projectId);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const grants = () => f.application(db => db.prepare('SELECT * FROM outside_path_confirmations WHERE projectId=? ORDER BY directory').all(copy.project.projectId));
  assert.ok(grants().length > 0);
  f.application(db => db.prepare('DELETE FROM outside_path_confirmations WHERE projectId=?').run(copy.project.projectId)); assert.deepEqual(grants(), []);
  const before = f.inspect(copy.project.projectId, snapshot), app = f.application(snapshot);
  const replay = await f.rpc<ProjectCopyResponse>('project.duplicate', input);
  assert.deepEqual(replay, first); assert.deepEqual(f.inspect(copy.project.projectId, snapshot), before); assert.deepEqual(f.application(snapshot), app);
  assert.deepEqual(grants(), []); assert.equal(isProjectFileHeld(copy.project.fileIdentity), true);
  denied(await f.rpc('project.duplicate', {...input, name: 'A changed request'}), 409, 'REQUEST_ID_REUSED');
  assert.deepEqual(f.inspect(copy.project.projectId, snapshot), before);
  f.native.release({windowId});
});

test('a seen-token fork still copies the local versions while preserving the untouched source branch evidence', async t => {
  const f = await fixture(t), raw = new DatabaseSync(f.source.projectFile);
  try {raw.prepare("UPDATE projects SET data=json_set(data,'$.name','Externally edited branch','$.revision',2) WHERE id=?").run(f.source.projectId);} finally {raw.close();}
  const before = f.sourceFiles(), input = f.input(), result = await f.rpc<ProjectCopyResponse>('project.duplicate', input);
  assert.equal(result.status, 200, JSON.stringify(result.body)); const copy = projectCopyResponseSchema.parse(result.body.data);
  assert.equal(copy.versions, f.sourceVersions.length); assert.deepEqual(f.sourceFiles(), before);
  const store = f.targetStore(copy);
  try {assert.equal(store.historyState, 'current'); assert.equal(createProjectVersions(store).list({projectId: copy.project.projectId}).versions.some(version => version.id === f.manualId), true);}
  finally {store.close();}
  const history = new DatabaseSync(path.join(f.local.localDir, 'history.db'), {readOnly: true});
  try {assert.equal(history.prepare('SELECT seenContentToken FROM history_state').get()!.seenContentToken, f.sourceStamp.contentToken);} finally {history.close();}
});

for (const damage of ['corrupt', 'occupied'] as const) test(`${damage} source history refuses the whole copy instead of silently omitting versions`, async t => {
  const f = await fixture(t), input = f.input(), historyFile = path.join(f.local.localDir, 'history.db');
  let release: (() => Promise<void>) | undefined;
  if (damage === 'corrupt') writeFileSync(historyFile, 'not a valid SQLite history');
  const before = f.sourceFiles();
  if (damage === 'occupied') release = await occupyHistory(historyFile);
  let result: Awaited<ReturnType<typeof f.rpc>>;
  try {result = await f.rpc('project.duplicate', input);} finally {await release?.();}
  denied(result, damage === 'corrupt' ? 422 : 409, damage === 'corrupt' ? 'PROJECT_INVALID' : 'PROJECT_LOCKED');
  assert.equal(existsSync(input.projectFile), false); assert.deepEqual(f.sourceFiles(), before);
  assert.equal(f.application(db => db.prepare('SELECT count(*) n FROM app_operation_receipts WHERE requestId=?').get(input.requestId)!.n), 0);
  assert.equal(f.native.listRecent().registered.length, 1);
});

for (const mode of ['aborted', 'reopened-library'] as const) test(`the ${mode} application owner cannot write through its old copy capability`, async t => {
  const f = await fixture(t); await f.server.close();
  const directories = serverAppDirectories(f.dataDir), library = openAppLibrary({dataDir: f.dataDir});
  const owner = new AbortController(), application = createProjectServiceApplication(library, owner.signal);
  const manager = createProjectHostManager({directories, registry: library.registry, assertMutationAllowed: application.assertMutationAllowed,
    factory: async () => {assert.fail('closed-source copies must not compose a project runtime');}});
  const copies = createProjectCopies({manager, library, directories, signal: owner.signal, assertProjectFile: createApplicationFileGuard(directories)});
  let replacement: ReturnType<typeof openAppLibrary> | undefined;
  try {
    const reason = Error('application owner was stopped');
    if (mode === 'aborted') owner.abort(reason);
    else {library.close(); replacement = openAppLibrary({dataDir: f.dataDir});}
    const current = replacement ?? library, before = {source: f.sourceFiles(), app: snapshot(current.db), targets: fileTree(f.targets),
      intents: fileTree(path.join(f.dataDir, 'project-copies'))};
    for (const method of [copies.duplicate, copies.saveAs]) {
      const input = f.input();
      await assert.rejects(async () => method(input), error => {
        if (mode === 'aborted') assert.equal(error, reason);
        else {assert.ok(error instanceof TypeError); assert.equal(error.message, 'Project services require a live application library owner');}
        return true;
      });
      assert.equal(existsSync(input.projectFile), false);
      assert.deepEqual({source: f.sourceFiles(), app: snapshot(current.db), targets: fileTree(f.targets),
        intents: fileTree(path.join(f.dataDir, 'project-copies'))}, before);
    }
  } finally {await copies.drain(); await manager.closeAll(); library.close(); replacement?.close();}
});
