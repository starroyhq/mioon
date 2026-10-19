import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import * as legacy from '../packages/contracts/src/index.ts';
import {openNewOpacityCandidateApplicationStore} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createExistingOpacityCandidateLaunch} from '../apps/server/src/opacity-candidate-launch.ts';
import {createOpacityCandidateRequestApplication} from '../apps/server/src/index.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createOpacityCandidateApplication, readOpacityCandidateApplication} from '../apps/web/src/opacity-candidate-application.ts';
import {readOpacityCandidateInspectorBinding} from '../apps/web/src/clip-opacity-candidate-assembly.ts';
import {createClipDraftController, clipDraftRaw, clipDraftSource} from '../apps/web/src/clip-draft-state.ts';
import {rawOpacityEnvelopeFields, validateRawOpacityEnvelope} from '../apps/web/src/clip-opacity-envelope-state.ts';
import {createEditTaskClient} from '../apps/web/src/edit-task-client.ts';
import {createEditTaskController} from '../apps/web/src/edit-task-controller.ts';
import {pinNewWorkspaceIntent} from '../apps/web/src/workspace-origin.ts';
import {rpc} from '../apps/web/src/api.ts';
import {createLanguageStore} from '../apps/web/src/i18n/language-store.ts';
import {LANGUAGE_STORAGE_KEY, parseLanguagePreference} from '../packages/i18n/src/preference.ts';
import {LOCALES, translate, renderMessage} from '../packages/i18n/src/index.ts';
import {restoredApplicationFixture, request, restoredApplicationToken} from './helpers/opacity-restored-application-fixture.ts';
import {hash} from './helpers/opacity-backup-fixture.ts';

// Shared HTTP, actual candidate clients/controller, real42 stores and cold43
// restoration. The only browser facility represented in memory is localStorage;
// this is neither native GUI nor IME acceptance. Media/provider/listen effects
// are forbidden, including effects that might be safely caught by a caller.
let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++; throw Error('No listener, native media, provider or external fetch is permitted.');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
mock.method(globalThis, 'fetch', forbidden); syncBuiltinESMExports();
const mediaEvents = [], off = onMediaProcess(event => mediaEvents.push(event));
after(() => {off(); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenAttempts, 0); assert.deepEqual(mediaEvents, []);});

const curve = opacity => ({profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity}, {frame: 30, opacity: 1}]});
const rawCurve = opacity => ({profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: '0', opacity}, {frame: '30', opacity: '1'}]});
const tableNames = ['projects', 'assets', 'exports', 'timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests', 'edit_tasks', 'workspace_preferences'];
const restoredTables = ['workspace_restoration', 'workspace_restore_holds', 'workspace_restore_evidence', 'workspace_restore_timeline_history', 'workspace_restore_timeline_cursors'];
const rows = (f, tables = tableNames) => f.readDb(db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
const memoryStorage = () => {
  const values = new Map();
  return {values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value))};
};
const language = storage => createLanguageStore({systemLanguages: ['en-US'], storage: () => storage});
const rootOf = f => f.destination ?? f.root;
const draftFile = f => path.join(rootOf(f), f.destination ? 'local-drafts-restored43-v1.json' : 'local-drafts-v3.json');
const draftBytes = f => fs.existsSync(draftFile(f)) ? fs.readFileSync(draftFile(f)) : null;

async function ordinaryApplicationFixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-opacity-language-'));
  const root = path.join(base, 'ordinary42'), dist = path.join(base, 'dist'), store = openNewOpacityCandidateApplicationStore(root);
  const services = createOpacityCandidateApplicationServices(store);
  let app, project, asset, timeline;
  t.after(async () => {try {await app?.close(); await services.drain(); store.close();} finally {fs.rmSync(base, {recursive: true, force: true});}});
  try {
    project = await services.call('project.create', {name: 'Owned language-session fixture 日本語 界'});
    timeline = await services.call('timeline.get', {projectId: project.id});
    const id = randomUUID(), bytes = Buffer.from('OWNED_SYNTHETIC_LANGUAGE_SESSION_SOURCE\0');
    asset = {id, projectId: project.id, name: 'User content stays unchanged 界', mimeType: 'video/mp4', provenance: 'user-import',
      relativePath: `media/${id}.mp4`, sha256: hash(bytes), sizeBytes: bytes.length, duration: 1, width: 720, height: 1280,
      hasVideo: true, hasAudio: false, createdAt: '2026-10-16T00:00:00.000Z'};
    store.put('assets', asset); fs.writeFileSync(path.join(root, asset.relativePath), bytes, {mode: 0o600, flag: 'wx'});
    timeline = await services.call('timeline.clip.add', {projectId: project.id, requestId: randomUUID(), expectedRevision: timeline.revision,
      assetId: id, trackId: timeline.tracks.find(track => track.kind === 'video').id, startFrame: 0, durationFrames: 30, opacityEnvelope: curve(.25)});
  } finally {await services.drain(); store.close();}
  fs.mkdirSync(dist, {mode: 0o700});
  fs.writeFileSync(path.join(dist, 'mioon-opacity-candidate-entry.json'), JSON.stringify({schemaVersion: 1, profileId: 'mioon-workspace-v42', entry: 'opacity-candidate.html'}));
  fs.writeFileSync(path.join(dist, 'opacity-candidate.html'), '<html>owned language session</html>');
  const close = async () => {await app?.close();};
  const reopen = async () => {
    await close(); app = await createOpacityCandidateRequestApplication({opacityCandidateLaunch: createExistingOpacityCandidateLaunch(root),
      distDir: dist, port: 4319, token: restoredApplicationToken});
  };
  await reopen();
  return {root, projectId: project.id, assetId: asset.id, timelineId: timeline.id, clipId: timeline.clips[0].id, relativePath: asset.relativePath, mediaBytes: fs.readFileSync(path.join(root, asset.relativePath)),
    get app() {return app;}, close, reopen,
    readDb(callback) {const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true}); try {return callback(db);} finally {db.close();}},
  };
}

async function editorSession(t, f) {
  const requests = [];
  const fetcher = async (url, options = {}) => {
    const address = new URL(url, 'http://127.0.0.1:4319'), input = options.body ? JSON.parse(options.body) : undefined;
    requests.push({path: address.pathname, method: options.method ?? 'GET', input: structuredClone(input)});
    const sent = await request(f.app, address.pathname + address.search, {method: options.method ?? 'GET', input});
    return new Response(sent.bytes, {status: sent.status, headers: sent.headers});
  };
  const application = readOpacityCandidateApplication(createOpacityCandidateApplication({...legacy, rpc, createEditTaskClient}, fetcher));
  const workspace = await application.rpc('workspace.restore.inspect');
  let page = await application.rpc('project.get', {projectId: f.projectId});
  const tasks = createEditTaskController({client: application.taskClient, getWorkspace: () => workspace});
  assert.equal((await tasks.load(f.projectId)).phase, 'ready');
  const context = () => ({scope: `${workspace.restored ? workspace.workspaceOrigin : 'ordinary42'}:${f.projectId}:inspector`,
    projectId: f.projectId, timelineId: f.timelineId, clipId: f.clipId, restored: workspace.restored, workspaceOrigin: workspace.workspaceOrigin, connected: true, visible: true, busy: false,
    opacityEnvelopeEditable: true, timelineRevision: page.timeline.revision, source: clipDraftSource(page.timeline.clips[0], page.assets[0]),
    saved: {...clipDraftRaw(page.timeline.clips[0]), ...rawOpacityEnvelopeFields(page.timeline.clips[0])}});
  const controller = createClipDraftController({context: context(), client: readOpacityCandidateInspectorBinding(application.inspectorBinding).client,
    delay: 60000, validateTimeline: (value, projectId) => application.isTimelineRecord(value, {projectId})});
  t.after(() => controller.dispose()); await controller.load();
  return {application, workspace, tasks, requests, controller, context, get page() {return page;},
    async reload() {page = await application.rpc('project.get', {projectId: f.projectId}); controller.setContext(context()); return page;},
    async save() {
      const result = await controller.save(async (clipId, patch, expectedRevision, options) => {
        const intent = pinNewWorkspaceIntent({projectId: f.projectId, operation: 'timeline.clip.update', input: {projectId: f.projectId,
          requestId: randomUUID(), expectedRevision, clipId, patch}}, workspace);
        const applied = await tasks.submit(intent, options); assert.equal(applied.task.status, 'applied');
        await tasks.acknowledge(applied.task); return applied.result;
      });
      if (result) await this.reload();
      return result;
    },
  };
}

for (const profile of [42, 43]) test(`real${profile} language sessions preserve typed/raw/business boundaries across Save, Cancel and close/reopen`, async t => {
  const f = profile === 42 ? await ordinaryApplicationFixture(t) : await restoredApplicationFixture(t);
  const storage = memoryStorage(), held = profile === 43 ? rows(f, restoredTables) : null;
  const capturedTask = profile === 43 ? f.readDb(db => db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(f.taskId)) : null;
  let languages = language(storage), current = await editorSession(t, f);
  t.after(() => languages.dispose());
  const savedAsset = current.page.assets[0], projectName = current.page.project.name;
  for (const [index, locale] of LOCALES.entries()) {
    const beforeLanguage = rows(f), beforeDraft = draftBytes(f), beforeRequests = current.requests.length;
    await languages.setPreference(locale);
    assert.equal(languages.getSnapshot().locale, locale); assert.equal(parseLanguagePreference(storage.getItem(LANGUAGE_STORAGE_KEY)), locale);
    const verified = languages.getSnapshot();
    await assert.rejects(languages.setPreference('zh-TW'), TypeError);
    assert.deepEqual(languages.getSnapshot(), verified);
    languages.receiveStorage('{'); assert.equal(languages.getSnapshot().persistence, 'read-failed'); assert.equal(languages.getSnapshot().locale, locale);
    assert.ok(translate(locale, 'language.readFailed').length > 10);
    await languages.setPreference(locale);
    assert.deepEqual([...storage.values.keys()], [LANGUAGE_STORAGE_KEY]);
    assert.deepEqual(rows(f), beforeLanguage); assert.deepEqual(draftBytes(f), beforeDraft); assert.equal(current.requests.length, beforeRequests);

    // Incomplete numeric text is a recoverable raw draft, never a domain
    // opacity value. Translating feedback cannot make this a valid Save.
    assert.equal(current.controller.editOpacityEnvelope(rawCurve('.'), current.controller.capture()), true);
    assert.equal(validateRawOpacityEnvelope(current.controller.getState().raw, 30).valid, false);
    const invalidRaw = structuredClone(current.controller.getState().raw), beforeInvalid = rows(f), requestCount = current.requests.length;
    assert.equal(await current.controller.save(() => assert.fail('Incomplete opacity text cannot dispatch a business Save')), null);
    assert.equal(current.requests.length, requestCount); assert.deepEqual(rows(f), beforeInvalid);
    assert.ok(translate(locale, 'opacity.envelope.bounds', {duration: 30}).length > 10);
    assert.deepEqual(current.controller.getState().raw, invalidRaw);
    const canClose = await current.controller.flushForClose();
    assert.equal(canClose, true);
    assert.deepEqual(rows(f), beforeInvalid, 'close only drains raw drafts, never a business Save or a43 task');
    current.controller.dispose(); languages.dispose(); await f.close(); await f.reopen();
    languages = language(storage); assert.equal(languages.getSnapshot().locale, locale);
    current = await editorSession(t, f);
    assert.deepEqual(rows(f), beforeInvalid); assert.equal(current.page.project.name, projectName); assert.deepEqual(current.page.assets[0], savedAsset);
    assert.deepEqual(current.controller.getState().candidate.raw, invalidRaw);
    assert.notDeepEqual(current.controller.getState().raw, invalidRaw, 'reopen does not silently adopt an unfinished draft');
    assert.equal(current.controller.restore(), true);
    assert.deepEqual(current.controller.getState().raw, invalidRaw);
    assert.equal(await current.controller.save(() => assert.fail('Recovered incomplete text still cannot execute')), null);
    assert.equal(await current.controller.discard(current.controller.capture()), true);
    if (profile === 43) {
      assert.equal(current.controller.supportsRestoredPersistence(current.workspace.workspaceOrigin), true);
      assert.equal(current.workspace.workspaceOrigin, f.restored.workspaceOrigin);
      assert.deepEqual(rows(f, restoredTables), held);
      assert.deepEqual(f.readDb(db => db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(f.taskId)), capturedTask);
    }
    assert.equal(current.controller.hasUnsaved(), false); assert.deepEqual(rows(f), beforeInvalid);

    const opacity = [.4, .5, .6, .7][index], beforeSave = rows(f);
    assert.equal(current.controller.editOpacityEnvelope(rawCurve(String(opacity)), current.controller.capture()), true);
    const result = await current.save(); assert.ok(result);
    assert.deepEqual(result.clips[0].opacityEnvelope, curve(opacity)); assert.equal(current.controller.hasUnsaved(), false);
    const afterSave = rows(f);
    assert.equal(afterSave.timeline_requests.length, beforeSave.timeline_requests.length + 1);
    assert.equal(afterSave.timeline_history.length, beforeSave.timeline_history.length + 1);
    const prepare = current.requests.findLast(row => row.path === '/api/tasks/prepare').input;
    assert.equal(typeof prepare.input.patch.opacityEnvelope.points[0].opacity, 'number');
    assert.equal(Object.hasOwn(prepare.input, 'locale'), false); assert.equal(Object.hasOwn(prepare.input, 'language'), false);
    assert.equal(prepare.expectedWorkspaceOrigin, profile === 43 ? f.restored.workspaceOrigin : undefined);
    assert.equal(afterSave.workspace_preferences.length, 0, 'app language never becomes a workspace preference');
    assert.equal(current.controller.editOpacityEnvelope(rawCurve('.9'), current.controller.capture()), true);
    assert.equal(await current.controller.discard(current.controller.capture()), true);
    assert.deepEqual(rows(f), afterSave, 'Cancel cannot undo the accepted opacity save');
    assert.equal(await current.controller.flushForClose(), true);
    current.controller.dispose(); languages.dispose(); await f.close(); await f.reopen();
    languages = language(storage); current = await editorSession(t, f);
    assert.equal(languages.getSnapshot().locale, locale); assert.deepEqual(rows(f), afterSave);
    assert.deepEqual(current.page.timeline.clips[0].opacityEnvelope, curve(opacity)); assert.equal(current.controller.getState().candidate, null);
    if (profile === 43) {
      assert.deepEqual(rows(f, restoredTables), held);
      assert.deepEqual(f.readDb(db => db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(f.taskId)), capturedTask);
      const epochs = f.readDb(db => db.prepare('SELECT DISTINCT executionEpoch FROM edit_tasks WHERE id<>?').all(f.taskId));
      assert.deepEqual(epochs.map(row => row.executionEpoch), [f.restored.workspaceOrigin]);
      assert.equal(current.requests.some(row => /local-delivery/u.test(row.path)), false);
      assert.ok(current.requests.some(row => row.path === '/api/local-drafts/restored43/clip'));
      assert.equal(current.requests.some(row => row.path === '/api/local-drafts/clip'), false);
    }
  }
  const names = f.readDb(db => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE '%language%' OR name LIKE '%locale%')").all());
  assert.deepEqual(names, []); assert.deepEqual(current.page.assets[0], savedAsset);
  assert.deepEqual(fs.readFileSync(path.join(rootOf(f), f.relativePath)), f.mediaBytes);
  assert.ok(renderMessage('zh-Hant', {key: 'opacity.envelope.bounds', params: {duration: 30}}).includes('關鍵幀'));
  current.controller.dispose(); await f.close(); assert.equal(fs.existsSync(path.join(rootOf(f), 'server.lock')), false);
});
