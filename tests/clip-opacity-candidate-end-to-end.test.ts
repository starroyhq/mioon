import type {TestContext} from 'node:test';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {ClipDraftClient,DraftController} from './helpers/strict-timeline-ui-types.ts';
import type {RawOpacityEnvelope} from '../apps/web/src/clip-opacity-envelope-state.ts';
import type {OpacityEnvelope} from '../packages/contracts/src/timeline-opacity-envelope.ts';
import type {EditTaskClient,EditTaskEnvelope} from '../apps/web/src/edit-task-client.ts';
import type {MediaProcessEvent} from '../packages/business/src/media-processes.ts';
interface FixtureClip extends Record<string,unknown> {id:string;assetId:string;trackId:string;name:string;startFrame:number;durationFrames:number;sourceInFrame:number;rect:{x:number;y:number;width:number;height:number};gain:number;volumeEnvelope:{profileId:string;points:{frame:number;multiplier:number}[]};audioRole:string;colour:null;opacityEnvelope?:OpacityEnvelope|null}
interface FixtureTimeline extends Record<string,unknown> {id:string;projectId:string;revision:number;fps:number;width:number;height:number;tracks:{id:string;name:string;kind:string;orderIndex:number;hidden:boolean;muted:boolean}[];clips:FixtureClip[];durationFrames:number;createdAt:string;updatedAt:string}
type TaskReply = EditTaskEnvelope & {result:FixtureTimeline};
import type { TestNode, TestTree, TestElementProps, TestComponent, HookCell } from './helpers/strict-timeline-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {createOpacityCandidateEditorAssembly} from '../apps/server/src/opacity-candidate-editor-assembly.ts';
import {createEditTasksHttp} from '../apps/server/src/edit-tasks-http.ts';
import {openOpacityCandidateStore} from '../packages/business/src/opacity-candidate-store.ts';
import {openStore} from '../packages/business/src/db.ts';
import {installWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {OPACITY_CANDIDATE_LOCAL_DRAFT_FILENAME} from '../packages/business/src/opacity-candidate-local-drafts.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {captureClipDraftOpacityCandidateDiskV3} from '../packages/contracts/src/local-drafts-opacity-candidate.ts';
import {createClipDraftController, clipDraftRaw, clipDraftSource} from '../apps/web/src/clip-draft-state.ts';
import {createClipDraftClient, createOpacityCandidateClipDraftClient} from '../apps/web/src/clip-draft-client.ts';
import {rawOpacityEnvelopeFields} from '../apps/web/src/clip-opacity-envelope-state.ts';
import {createOpacityCandidateInspectorBinding, readOpacityCandidateInspectorBinding, opacityCandidateTimelineProjection}
  from '../apps/web/src/clip-opacity-candidate-assembly.ts';
import * as legacyContracts from '@mioon/contracts';
import {rpc} from '../apps/web/src/api.ts';
import {createEditTaskClient} from '../apps/web/src/edit-task-client.ts';
import {createEditTaskController} from '../apps/web/src/edit-task-controller.ts';
import {createOpacityCandidateApplication, readOpacityCandidateApplication} from '../apps/web/src/opacity-candidate-application.ts';

const stamp = '2026-10-16T00:00:00.000Z';
const profileId = 'mioon-clip-linear-opacity-v1';
const unfinished = (): RawOpacityEnvelope => ({profileId, points: [{frame: '0', opacity: '.'}, {frame: '3e', opacity: '1e-'}]});
const rawCurve = (): RawOpacityEnvelope => ({profileId, points: [{frame: '0', opacity: '0'}, {frame: '30', opacity: '.75'}]});
const curve = (): OpacityEnvelope => ({profileId, points: [{frame: 0, opacity: 0}, {frame: 30, opacity: .75}]});
const validateTimeline = (value: unknown, projectId: string) => {
  const projection = opacityCandidateTimelineProjection(value, projectId);
  return projection !== null && isTimelineRecord(projection, {projectId});
};
const application = (fetcher: typeof fetch) => {
  const token = createOpacityCandidateApplication({...legacyContracts, rpc, createEditTaskClient: createEditTaskClient as unknown as Parameters<typeof createOpacityCandidateApplication>[0]['createEditTaskClient']}, fetcher);
  return {token, ...readOpacityCandidateApplication(token)} as unknown as {token: typeof token} & Omit<NonNullable<ReturnType<typeof readOpacityCandidateApplication>>, 'taskClient'> & {taskClient: EditTaskClient};
};

/** In-memory transport only. Both handlers and all storage/business operations
 * below are real; no server, socket, browser, media process or provider starts. */
function transport(assembly: ReturnType<typeof createOpacityCandidateEditorAssembly>) {
  const calls: {method:string;pathname:string;body:Record<string,unknown>|undefined}[] = [], taskHttp = createEditTasksHttp({tasks: assembly.tasks as unknown as Parameters<typeof createEditTasksHttp>[0]['tasks']});
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://127.0.0.1'), method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : String(init.body), data = body === undefined ? undefined : Buffer.from(body);
    const headers = Object.fromEntries(new Headers(init.headers));
    if (data) headers['content-length'] = String(data.length);
    const req = Readable.from(data ? [data] : []);
    Object.assign(req, {method, url: url.pathname + url.search, headers});
    const res = {destroyed: false, writableEnded: false, headersSent: false, status: 0, headers: {} as Record<string,string>, body: '',
      setHeader(name: string, value: string) {this.headers[name] = value;},
      writeHead(status: number, responseHeaders: Record<string,string> = {}) {this.status = status;Object.assign(this.headers, responseHeaders);this.headersSent = true;},
      end(value = '') {this.body = String(value);this.writableEnded = true;},
      destroy() {this.destroyed = true;},
    };
    calls.push({method, pathname: url.pathname, body: body === undefined ? undefined : JSON.parse(body)});
    const handled = await assembly.localDraftHttp(req as unknown as IncomingMessage, res as unknown as ServerResponse, url) || await taskHttp(req as unknown as IncomingMessage, res as unknown as ServerResponse, url);
    assert.equal(handled, true, `Unexpected synthetic route ${url.pathname}`);
    assert.equal(res.destroyed, false);assert.equal(res.writableEnded, true);
    return new Response(res.body, {status: res.status, headers: res.headers});
  };
  return {fetcher, calls};
}
async function json(fetcher: typeof fetch, url: string, input: Record<string,unknown>): Promise<TaskReply> {
  const response = await fetcher(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)});
  const body = await response.json() as {ok:boolean;data:TaskReply;error:{message:string;code:string}};
  if (!body.ok) throw Object.assign(new Error(body.error.message), {code: body.error.code, status: response.status});
  return body.data;
}
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-opacity-editor-e2e-'));
  let store!: ReturnType<typeof openOpacityCandidateStore>, assembly!: ReturnType<typeof createOpacityCandidateEditorAssembly>, bridge!: ReturnType<typeof transport>;
  const controllers = new Set<DraftController>(), media: MediaProcessEvent[] = [], off = onMediaProcess(event => media.push(event));
  const project = {id: randomUUID(), name: 'Synthetic editor metadata', revision: 1, createdAt: stamp, updatedAt: stamp};
  const asset = {id: randomUUID(), projectId: project.id, name: 'No actual source file', mimeType: 'video/mp4', duration: 1,
    width: 720, height: 1280, hasVideo: true, hasAudio: true, sha256: 'a'.repeat(64), relativePath: 'media/never-opened.mp4', createdAt: stamp};
  const clip: FixtureClip = {id: randomUUID(), assetId: asset.id, trackId: randomUUID(), name: 'Synthetic clip', startFrame: 0, durationFrames: 30,
    sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1,
    volumeEnvelope: {profileId: 'mioon-clip-linear-attenuation-v1', points: [{frame: 0, multiplier: .5}, {frame: 30, multiplier: 1}]}, audioRole: 'human', colour: null};
  const timeline: FixtureTimeline = {id: randomUUID(), projectId: project.id, revision: 1, fps: 30, width: 720, height: 1280,
    tracks: [{id: clip.trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips: [clip],
    durationFrames: 30, createdAt: stamp, updatedAt: stamp};
  const key = {projectId: project.id, timelineId: timeline.id, clipId: clip.id};
  function open() {store = openOpacityCandidateStore(root);assembly = createOpacityCandidateEditorAssembly(store);bridge = transport(assembly);}
  open();store!.put('projects', project);store!.put('assets', asset);store!.put('timelines', timeline);
  const f = {root, project, asset, clip, timeline, key, file: path.join(root, OPACITY_CANDIDATE_LOCAL_DRAFT_FILENAME),
    get store() {return store;}, get assembly() {return assembly;}, get bridge() {return bridge;},
    mount({restored = false, client}: {restored?:boolean;client?:ClipDraftClient} = {}) {
      const current = store.get('timelines', timeline.id) as FixtureTimeline, saved = current.clips.find(value => value.id === clip.id);
      const binding = createOpacityCandidateInspectorBinding(bridge.fetcher), selected = client ?? readOpacityCandidateInspectorBinding(binding)!.client;
      const controller = createClipDraftController({client: selected, validateTimeline, delay: 60000,
        context: {...key, scope: `synthetic:${project.id}`, restored, connected: true, busy: false, visible: true,
          audioRoleEditable: true, volumeEnvelopeEditable: true, opacityEnvelopeEditable: true, timelineRevision: current.revision,
          source: clipDraftSource(saved!, asset), saved: {...clipDraftRaw(saved!), ...rawOpacityEnvelopeFields(saved!)}}});
      controllers.add(controller);return {controller, binding};
    },
    save(controller: DraftController, origin?: string) {
      return controller.save(async (clipId, patch, expectedRevision, options) => {
        if (!options.canExecute()) return null;
        const input = {projectId: project.id, clipId, patch, expectedRevision, requestId: randomUUID()};
        const context = origin ? {expectedWorkspaceOrigin: origin} : {};
        const prepared = await json(bridge.fetcher, '/api/tasks/prepare', {projectId: project.id, operation: 'timeline.clip.update', input, origin: 'new', ...context});
        if (!options.canExecute()) return null;
        const applied = await json(bridge.fetcher, `/api/tasks/${prepared.task.id}/execute`, {projectId: project.id, digest: prepared.task.digest, instanceId: prepared.instanceId, ...context});
        assert.equal(applied.task.status, 'applied');
        await json(bridge.fetcher, `/api/tasks/${prepared.task.id}/acknowledge`, {projectId: project.id, digest: prepared.task.digest,
          expectedRevision: applied.task.revision, status: 'applied', ...context});
        return applied.result;
      }) as Promise<FixtureTimeline | null>;
    },
    snapshot() {return JSON.stringify(['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests', 'edit_tasks']
      .map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));},
    disk() {return captureClipDraftOpacityCandidateDiskV3(JSON.parse(readFileSync(f.file, 'utf8'))).disk;},
    async close() {for (const controller of controllers) controller.dispose();controllers.clear();await assembly.drain();store.close();},
    async reopen() {await f.close();open();},
    async restore() {
      await f.close();const metadata = {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
        manifestHash: 'b'.repeat(64), sourceDbHash: 'c'.repeat(64), createdAt: stamp};
      const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
      try {db.exec('PRAGMA foreign_keys=ON;');installWorkspaceRestoreSchemaV43(db, metadata);} finally {db.close();}
      open();return metadata;
    },
  };
  t.after(async () => {try {await f.close();assert.deepEqual(media, []);} finally {off();rmSync(root, {recursive: true, force: true});}});
  return f;
}

test('exact candidate application client saves and acknowledges raw opacity through the actual durable controller and HTTP services', async t => {
  const f = fixture(t), app = application(f.bridge.fetcher), controller = createEditTaskController({client: app.taskClient});
  assert.equal(readOpacityCandidateApplication({...app.token}), null);
  assert.equal(readOpacityCandidateApplication(JSON.parse(JSON.stringify(app.token))), null);
  assert.equal((await controller.load(f.project.id)).phase, 'ready');
  const input = {projectId: f.project.id, clipId: f.clip.id, expectedRevision: 1, requestId: randomUUID(), patch: {opacityEnvelope: curve()}};
  const applied = await controller.submit({projectId: f.project.id, operation: 'timeline.clip.update', input: input as unknown as Parameters<typeof controller.submit>[0]['input']});
  assert.deepEqual((applied.result as FixtureTimeline).clips[0].opacityEnvelope, curve());
  assert.deepEqual(applied.task.input, input);assert.equal(controller.blocked(f.project.id, 'timeline:mutation'), true);
  await controller.acknowledge(applied.task);
  assert.equal(controller.blocked(f.project.id, 'timeline:mutation'), false);
  assert.equal(f.store.db.prepare('SELECT acknowledged FROM edit_tasks').get()!.acknowledged, 1);
  assert.deepEqual((f.store.get('timelines', f.timeline.id) as FixtureTimeline).clips[0].opacityEnvelope, curve());
});

test('default and copied task clients cannot select candidate ACK validation', async t => {
  for (const copied of [false, true] as const) {
    const f = fixture(t), app = application(f.bridge.fetcher);
    const client = copied ? {...app.taskClient} : createEditTaskClient({fetcher: f.bridge.fetcher, opacityBinding: {kind: 'internal-opacity-client'}});
    const controller = createEditTaskController({client});await controller.load(f.project.id);
    const input = {projectId: f.project.id, clipId: f.clip.id, expectedRevision: 1, requestId: randomUUID(), patch: {opacityEnvelope: curve()}};
    await assert.rejects(controller.submit({projectId: f.project.id, operation: 'timeline.clip.update', input: input as unknown as Parameters<typeof controller.submit>[0]['input']}), {code: 'BACKEND_PROTOCOL_ERROR'});
    assert.equal(f.store.db.prepare('SELECT status FROM edit_tasks').get()!.status, 'prepared');
    assert.equal(f.bridge.calls.some(call => call.pathname.endsWith('/execute')), false);
  }
});

test('lost candidate execute ACK retains exact unknown task and recovers by GET without replaying execution', async t => {
  const f = fixture(t);let lose = true;
  const app = application(async (url, init) => {
    const response = await f.bridge.fetcher(url, init);
    if (String(url).endsWith('/execute') && lose) {lose = false;throw new Error('Synthetic lost applied ACK');}
    return response;
  });
  const controller = createEditTaskController({client: app.taskClient});await controller.load(f.project.id);
  const input = {projectId: f.project.id, clipId: f.clip.id, expectedRevision: 1, requestId: randomUUID(), patch: {opacityEnvelope: curve()}};
  await assert.rejects(controller.submit({projectId: f.project.id, operation: 'timeline.clip.update', input: input as unknown as Parameters<typeof controller.submit>[0]['input']}), /lost applied ACK/);
  const pending = controller.getState(f.project.id).items[0];
  assert.deepEqual(pending.input, input);assert.deepEqual(controller.getState(f.project.id).uncertain, [pending.id]);
  const recovered = await controller.recover(pending);
  assert.equal(recovered!.task.status, 'applied');assert.equal(Object.hasOwn(recovered!, 'result'), false);
  assert.deepEqual((f.store.get('timelines', f.timeline.id) as FixtureTimeline).clips[0].opacityEnvelope, curve());
  assert.equal(f.bridge.calls.filter(call => call.pathname.endsWith('/execute')).length, 1);
  await controller.acknowledge(recovered!.task);
  assert.equal(controller.blocked(f.project.id, 'timeline:mutation'), false);
});

test('candidate malformed applied opacity cannot clear a task and late prepare cannot dispatch after navigation', async t => {
  const f = fixture(t);let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => {entered = resolve;}), hold = new Promise<void>(resolve => {release = resolve;});
  const app = application(async (url, init) => {
    const response = await f.bridge.fetcher(url, init);
    if (String(url) === '/api/tasks/prepare') {entered();await hold;}
    if (String(url).endsWith('/execute')) {const value = await response.json();delete value.data.result.clips[0].opacityEnvelope;return Response.json(value);}
    return response;
  });
  const controller = createEditTaskController({client: app.taskClient});await controller.load(f.project.id);
  let current = true;
  const input = {projectId: f.project.id, clipId: f.clip.id, expectedRevision: 1, requestId: randomUUID(), patch: {opacityEnvelope: null}};
  const pending = controller.submit({projectId: f.project.id, operation: 'timeline.clip.update', input: input as unknown as Parameters<typeof controller.submit>[0]['input']}, {canExecute: () => current});
  await ready;current = false;release!();const prepared = await pending;
  assert.equal(prepared.task.status, 'prepared');assert.equal(f.bridge.calls.some(call => call.pathname.endsWith('/execute')), false);
  await assert.rejects(controller.recover(prepared.task), {code: 'BACKEND_PROTOCOL_ERROR'});
  assert.equal(controller.getState(f.project.id).items[0].status, 'prepared');
  assert.equal(controller.blocked(f.project.id, 'timeline:mutation'), true);
  const recovered = await controller.recover(prepared.task);
  assert.equal(recovered!.task.status, 'applied');assert.equal(Object.hasOwn(recovered!, 'result'), false);
  assert.equal((f.store.get('timelines', f.timeline.id) as FixtureTimeline).clips[0].opacityEnvelope, null);
});

test('actual candidate controller preserves unfinished v3 text across reopen and saves through HTTP tasks into the existing transaction', async t => {
  const f = fixture(t), legacyFile = path.join(f.root, 'local-drafts-v1.json'), legacyBytes = Buffer.from('{"version":2,"untouched":"old companion"}\n');
  writeFileSync(legacyFile, legacyBytes, {mode: 0o600});
  let {controller} = f.mount();await controller.load();assert.equal(controller.getState().phase, 'ready');
  const before = f.snapshot();assert.equal(controller.editOpacityEnvelope(unfinished(), controller.capture()), true);
  await controller.flush();assert.equal(controller.getState().phase, 'saved');
  assert.deepEqual(f.disk().entries[0].draft!.raw.opacityEnvelope, unfinished());assert.equal(f.snapshot(), before);
  assert.equal(await f.save(controller), null);assert.equal(f.bridge.calls.some(call => call.pathname.startsWith('/api/tasks')), false);
  const originalDisk = readFileSync(f.file);await f.reopen();assert.deepEqual(readFileSync(f.file), originalDisk);
  ({controller} = f.mount());await controller.load();assert.deepEqual(controller.getState().candidate!.raw.opacityEnvelope, unfinished());
  assert.equal(controller.restore(), true);assert.deepEqual(controller.getState().raw.opacityEnvelope, unfinished());
  assert.equal(controller.edit('opacityEnvelope', rawCurve() as unknown as Parameters<DraftController['edit']>[1]), true);await controller.flush();
  const saved = await f.save(controller);assert.ok(saved);assert.equal(saved.revision, 2);
  assert.deepEqual(saved.clips[0].opacityEnvelope, curve());
  for (const field of ['volumeEnvelope', 'audioRole', 'colour'] as const) assert.deepEqual(saved.clips[0][field], f.clip[field]);
  assert.equal(controller.getState().dirty, false);assert.deepEqual(controller.getState().raw.opacityEnvelope, rawOpacityEnvelopeFields(saved.clips[0]).opacityEnvelope);
  assert.equal(f.disk().entries[0].draft, null);assert.deepEqual(readFileSync(legacyFile), legacyBytes);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_history').get()!.n, 1);
  assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests').get()!.response, JSON.stringify(saved));
  const task = f.store.db.prepare('SELECT operation,status,acknowledged,input FROM edit_tasks').get();
  assert.equal(task!.operation, 'timeline.clip.update');assert.equal(task!.status, 'applied');assert.equal(task!.acknowledged, 1);
  assert.deepEqual(JSON.parse(task!.input as string).patch.opacityEnvelope, curve());
  assert.ok(f.bridge.calls.some(call => call.pathname === '/api/tasks/prepare'));
  assert.ok(f.bridge.calls.some(call => call.pathname.endsWith('/execute')));
  await f.reopen();({controller} = f.mount());await controller.load();
  assert.equal(controller.getState().candidate, null);assert.deepEqual(controller.getState().raw.opacityEnvelope, rawOpacityEnvelopeFields(saved.clips[0]).opacityEnvelope);
  assert.deepEqual((f.store.get('timelines', f.timeline.id) as FixtureTimeline), saved);
});

test('candidate Cancel clears the native v3 record without a task, while explicit local abandonment keeps a recoverable record', async t => {
  const f = fixture(t);let {controller} = f.mount();await controller.load();const before = f.snapshot();
  controller.editOpacityEnvelope(unfinished(), controller.capture());await controller.flush();
  assert.equal(await controller.discard(controller.capture()), true);assert.equal(controller.getState().dirty, false);
  assert.equal(Object.hasOwn(controller.getState().raw, 'opacityEnvelope'), false);assert.equal(f.disk().entries[0].draft, null);
  assert.equal(f.snapshot(), before);assert.equal(f.bridge.calls.some(call => call.pathname.startsWith('/api/tasks')), false);
  controller.editOpacityEnvelope(unfinished(), controller.capture());await controller.flush();
  assert.equal(controller.abandonCurrentInput(controller.capture()), true);assert.equal(controller.getState().dirty, false);
  assert.deepEqual(f.disk().entries[0].draft!.raw.opacityEnvelope, unfinished());
  await f.reopen();({controller} = f.mount());await controller.load();assert.equal(controller.restore(), true);
  assert.deepEqual(controller.getState().raw.opacityEnvelope, unfinished());assert.equal(f.snapshot(), before);
});

test('default clients, copied clients and forged bindings never activate opacity despite advisory context flags', async t => {
  const f = fixture(t), candidate = createOpacityCandidateClipDraftClient(f.bridge.fetcher), binding = createOpacityCandidateInspectorBinding(f.bridge.fetcher);
  for (const fake of [{...binding}, Object.create(binding), {kind: 'internal-opacity-inspector'}, new Proxy(binding, {})] as const)
    assert.equal(readOpacityCandidateInspectorBinding(fake), null);
  const before = f.snapshot();
  for (const client of [createClipDraftClient(f.bridge.fetcher), {...candidate}, Object.create(candidate), new Proxy(candidate, {})] as const) {
    const {controller} = f.mount({client});await controller.load();
    assert.equal(controller.editOpacityEnvelope(rawCurve(), controller.capture()), false);
    assert.equal(controller.edit('opacityEnvelope', rawCurve() as unknown as Parameters<DraftController['edit']>[1]), false);
    assert.equal(controller.beginOpacityComposition(controller.capture()), null);
    assert.equal(controller.getState().dirty, false);controller.dispose();
  }
  assert.equal(f.snapshot(), before);assert.equal(existsSync(f.file), false);
  assert.throws(() => createOpacityCandidateEditorAssembly({...f.store}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  const ordinaryRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-opacity-editor-default-')), ordinary = openStore(ordinaryRoot);
  try {assert.throws(() => createOpacityCandidateEditorAssembly(ordinary), {code: 'RESTORE_OPERATION_UNAVAILABLE'});}
  finally {ordinary.close();rmSync(ordinaryRoot, {recursive: true, force: true});}
});

test('fixed43 editor keeps v3 drafts unsupported and untouched while an explicit-origin task saves opacity', async t => {
  const f = fixture(t);let {controller} = f.mount();await controller.load();controller.editOpacityEnvelope(unfinished(), controller.capture());await controller.flush();
  const companion = readFileSync(f.file), info = await f.restore();
  const client = createOpacityCandidateClipDraftClient(f.bridge.fetcher);
  assert.deepEqual(await client.get(f.key), {supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED'});
  ({controller} = f.mount({restored: true}));await controller.load();assert.equal(controller.getState().phase, 'unsupported');
  assert.equal(controller.editOpacityEnvelope(rawCurve(), controller.capture()), true);const before = f.snapshot();
  assert.equal(await f.save(controller), null);assert.equal(f.snapshot(), before);assert.equal(controller.getState().dirty, true);
  const saved = await f.save(controller, info.workspaceOrigin);assert.ok(saved);assert.deepEqual(saved.clips[0].opacityEnvelope, curve());
  assert.equal(controller.getState().dirty, false);assert.equal(controller.getState().phase, 'unsupported');
  assert.deepEqual(readFileSync(f.file), companion);
  await f.reopen();assert.deepEqual(readFileSync(f.file), companion);assert.deepEqual((f.store.get('timelines', f.timeline.id) as FixtureTimeline), saved);
});

test('draining the fixed editor revokes its HTTP, task and business entrypoints without closing or modifying the store', async t => {
  const f = fixture(t), before = f.snapshot(), {controller} = f.mount();await controller.load();
  assert.equal(Object.isFrozen(f.assembly), true);assert.equal(Object.isFrozen(f.assembly.tasks), true);assert.equal(Object.isFrozen(f.assembly.services), true);
  const first = f.assembly.drain();assert.equal(f.assembly.drain(), first);await first;
  const client = createOpacityCandidateClipDraftClient(f.bridge.fetcher);
  await assert.rejects(client.get(f.key), {code: 'LOCAL_DRAFT_STORAGE_UNAVAILABLE'});
  assert.throws(() => f.assembly.tasks.get({projectId: f.project.id, taskId: randomUUID()}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  await assert.rejects(f.assembly.services.call('timeline.get', {projectId: f.project.id}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(f.store.db.isOpen, true);assert.equal(f.snapshot(), before);assert.equal(existsSync(f.file), false);
});
