import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openAppLibrary, isAppLibraryHeld, projectFileIdentity} from '../packages/business/src/app-db/index.ts';
import {createProjectFile, openProjectStore} from '../packages/business/src/project-file/index.ts';
import {ownsStoreLock} from '../packages/business/src/store-runtime.ts';
import {createUiPreferences, UI_PREFERENCES_FILENAME} from '../packages/business/src/ui-preferences.ts';
import {createLastProject, LAST_PROJECT_FILENAME} from '../packages/business/src/last-project.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.ts';
import {createAppCompanionDocuments} from '../packages/business/src/companion-scope.ts';
import {createAgentAuthorizations} from '../packages/business/src/agent/authorizations.ts';
import {createLocalDrafts, LOCAL_DRAFT_FILENAME} from '../packages/business/src/local-drafts.ts';
import {createLocalDelivery, LOCAL_DELIVERY_FILENAME} from '../packages/business/src/local-delivery.ts';
import {createLocalShotText, LOCAL_SHOT_TEXT_FILENAME} from '../packages/business/src/local-shot-text.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';
import {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile} from '../packages/contracts/src/private-storage.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';

const storage = {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile};

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-companion-ports-'));
  const dataDir = path.join(root, 'data'), projectDir = path.join(root, 'project');
  mkdirSync(projectDir);
  const library = openAppLibrary({dataDir});
  const projectFile = path.join(projectDir, 'project.mioon'), projectId = createProjectFile(projectFile);
  const localDir = path.join(dataDir, 'records', projectId);
  const store = openProjectStore({projectFile, locate: () => ({localDir, cacheDir: path.join(dataDir, 'cache', projectId), tempDir: path.join(dataDir, 'tmp', projectId)})});
  store.tx(() => store.put('projects', {id: projectId, name: 'Companion project', description: '', revision: 1, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z'}));
  const identity = projectFileIdentity(projectFile);
  assert.ok(identity);
  library.registry.upsert({projectId, projectFile, fileIdentity: identity, name: 'Companion project', lastOpenedAt: null, summary: null});
  const ownsApp = () => {
    const current = projectFileIdentity(library.databaseFile);
    return current !== null && isAppLibraryHeld(current);
  };
  t.after(() => { store.close(); library.close(); rmSync(root, {recursive: true, force: true}); });
  return {root, library, store, projectId, dataDir, projectDir, localDir, ownsApp};
}

test('app companions use B1 documents and app identity without creating legacy JSON files or opening a project', t => {
  const f = fixture(t), checked: string[] = [];
  const appStorage = {...storage,
    validateManagedFile: (file: string, options: Parameters<typeof validateManagedFile>[1]) => { checked.push(file); return validateManagedFile(file, options); },
    readPrivateFile: () => { throw Error('App documents must not read legacy companion files'); },
    writePrivateFileAtomic: () => { throw Error('App documents must not write legacy companion files'); },
  };
  const common = {root: f.dataDir, databaseFile: f.library.databaseFile, documents: createAppCompanionDocuments(f.library), storage: appStorage};
  const ui = createUiPreferences({...common, guards: {ownsLock: f.ownsApp, isReadOnly: () => false, hasProject: id => f.library.registry.get(id) !== null}});
  const first = ui.get();
  const write = {expectedRevision: first.revision, requestId: randomUUID(), preferences: {...DEFAULT_UI_PREFERENCES, theme: 'light' as const}};
  const saved = ui.put(write);
  assert.deepEqual(ui.put(write), saved);
  ui.markOpened(f.projectId);
  assert.equal(ui.get().preferences.theme, 'light');
  assert.ok(f.library.documents.read(UI_PREFERENCES_FILENAME));

  const last = createLastProject({...common, guards: {ownsLock: f.ownsApp, readProject: id => f.library.registry.get(id) ? {id} : null}});
  const initial = last.get(); assert.equal(initial.supported, true); if (!initial.supported) return;
  const lastInput = {workspaceScope: initial.workspaceScope, instanceId: initial.instanceId, expectedRevision: initial.revision, projectId: f.projectId};
  assert.throws(() => f.library.tx(() => last.put(lastInput)), {code: 'LAST_PROJECT_STORAGE_UNAVAILABLE'}, 'A companion cannot ACK a write held by an outer app transaction');
  assert.equal(f.library.documents.read(LAST_PROJECT_FILENAME), null);
  const next = last.put(lastInput);
  assert.equal(next.supported, true); if (!next.supported) return;
  assert.equal(next.projectId, f.projectId);
  assert.ok(f.library.documents.read(LAST_PROJECT_FILENAME));

  const configuration = createWorkspaceConfiguration({root: f.dataDir, documents: common.documents, env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}});
  const before = configuration.get();
  configuration.set({expectedRevision: before.revision, liveGeneration: true});
  assert.equal(configuration.environment().MIOON_ENABLE_LIVE_PROVIDER, '1');
  assert.ok(f.library.documents.read('workspace-settings-v1.json'));
  for (const name of [UI_PREFERENCES_FILENAME, LAST_PROJECT_FILENAME, 'workspace-settings-v1.json', 'workbench.sqlite']) assert.equal(existsSync(path.join(f.dataDir, name)), false);
  assert.ok(checked.length > 0); assert.ok(checked.every(file => file === f.library.databaseFile));
  assert.throws(() => createUiPreferences({...common, databaseFile: undefined, guards: {ownsLock: f.ownsApp, isReadOnly: () => false, hasProject: () => true}}).get(), {code: 'UI_PREFERENCES_UNAVAILABLE'}, 'An explicit documents port does not silently switch the scope database');

  f.store.close();
  assert.equal(ui.get().preferences.theme, 'light');
  assert.equal(last.get().supported, true, 'App state survives closing the project');
  f.library.close();
  assert.throws(() => ui.get(), {code: 'UI_PREFERENCES_UNAVAILABLE'});
  assert.throws(() => last.get(), {code: 'LAST_PROJECT_OWNER_REQUIRED'});
  assert.throws(() => configuration.get(), {code: 'APP_LIBRARY_CLOSED'});
});

test('authorization scope uses the held app library and keeps exact target, receipt and guard checks', async t => {
  const f = fixture(t), target = {destination: 'https://api.example.test/v1/responses', model: 'synthetic-model', settingsRevision: 1};
  const options = {root: f.dataDir, databaseFile: f.library.databaseFile, storage,
    guards: {ownsLock: f.ownsApp, isRestored: () => false}, readCurrentTarget: async () => target};
  const authorizations = createAgentAuthorizations(options);
  const before = await authorizations.list(), input = {requestId: randomUUID(), expectedRevision: before.revision, expectedSettingsRevision: target.settingsRevision, destination: target.destination, model: target.model, scope: 'project_agent'};
  const accepted = await authorizations.grant(input);
  assert.deepEqual(await authorizations.grant(input), accepted);
  authorizations.assertAuthorized({destination: target.destination, model: target.model, scope: 'project_agent'});
  assert.throws(() => authorizations.assertAuthorized({destination: target.destination, model: 'different', scope: 'project_agent'}), {code: 'AGENT_AUTHORIZATION_REQUIRED'});
  f.store.close();
  assert.equal((await createAgentAuthorizations(options).list()).revision, accepted.revision);
  f.library.close();
  await assert.rejects(authorizations.list(), {code: 'AGENT_AUTHORIZATION_UNAVAILABLE'});
});

test('three project SQL drafts bind to localDir/history.db and retain cross-scope and ownership fences', t => {
  const f = fixture(t), timelineId = randomUUID(), clipId = randomUUID(), assetId = randomUUID(), shotId = randomUUID();
  const timeline = {id: timelineId, projectId: f.projectId, revision: 1, clips: [{id: clipId, assetId}]};
  const shot = {id: shotId, projectId: f.projectId, revision: 1, title: 'Original', prompt: 'Prompt'};
  const common = {store: f.store};
  const owned = {ownsLock: () => ownsStoreLock(f.store), isRestored: () => false};
  const drafts = createLocalDrafts({...common, guards: {...owned, readTimeline: () => timeline, readClipAsset: () => ({id: assetId, projectId: f.projectId, sha256: 'a'.repeat(64)})}});
  const key = {projectId: f.projectId, timelineId, clipId}, initial = drafts.get(key);
  assert.equal(initial.supported, true); if (!initial.supported) return;
  const directory = validatePrivateDirectory(f.localDir), db = validateManagedFile(path.join(f.localDir, 'history.db'), {root: f.localDir}); assert.ok(directory); assert.ok(db);
  const expectedScope = calculateWorkspaceScope({channel: 'web', root: f.localDir, directory, db});
  assert.equal(initial.workspaceScope, expectedScope);
  const saved = drafts.put({...key, workspaceScope: initial.workspaceScope, instanceId: initial.instanceId, expectedRevision: 0, baseRevision: 1, source: {assetId, assetSha256: 'a'.repeat(64)}, raw: {name: 'Raw draft', trackId: randomUUID(), startFrame: '0', durationFrames: '', sourceInFrame: '0', rect: {x: '0', y: '0', width: '720', height: '1280'}, gain: '1'}});
  assert.equal(saved.supported, true);

  const delivery = createLocalDelivery({...common, guards: {...owned, readTimeline: () => timeline, readReceipt: () => null,
    isRenderInput: value => schemas['timeline.render'].safeParse(value).success, isRenderResponse: () => false, isNotApplied: () => false, render: async () => { throw Error('No dispatch'); }}});
  const exportDraft = delivery.get({projectId: f.projectId}); assert.equal(exportDraft.supported, true); if (!exportDraft.supported) return;
  assert.equal(exportDraft.workspaceScope, expectedScope);
  delivery.put({projectId: f.projectId, workspaceScope: exportDraft.workspaceScope, instanceId: exportDraft.instanceId, expectedDraftRevision: 0, draftId: randomUUID(), timelineId, baseRevision: 1, raw: {deliveryName: 'Raw delivery'}});

  const text = createLocalShotText({...common, guards: {...owned, readShot: () => shot, readReceipt: () => null,
    isShotUpdateInput: value => schemas['shot.update'].safeParse(value).success, isNotApplied: () => false, update: async () => { throw Error('No dispatch'); }}});
  const textDraft = text.get({projectId: f.projectId, shotId}); assert.equal(textDraft.supported, true); if (!textDraft.supported) return;
  assert.equal(textDraft.workspaceScope, expectedScope);
  text.put({projectId: f.projectId, shotId, workspaceScope: textDraft.workspaceScope, instanceId: textDraft.instanceId, expectedDraftRevision: 0, draftId: randomUUID(), baseRevision: 1, baseText: {title: shot.title, prompt: shot.prompt}, raw: {title: '', prompt: 'Unsubmitted'}});
  for (const [name, kind, table] of [[LOCAL_DRAFT_FILENAME, 'clip', 'local_clip_drafts'], [LOCAL_DELIVERY_FILENAME, 'delivery', 'local_delivery_drafts'], [LOCAL_SHOT_TEXT_FILENAME, 'shot-text', 'local_shot_text_drafts']]) {
    assert.equal(f.store.db.prepare('SELECT workspaceScope FROM main.local_draft_states WHERE kind=?').get(kind)?.workspaceScope, expectedScope);
    assert.equal(existsSync(path.join(f.projectDir, name)), false);
    assert.equal(existsSync(path.join(f.localDir, name)), false);
    assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM main.${table}`).get()?.n, 1);
  }
  assert.throws(() => delivery.put({projectId: f.projectId, workspaceScope: 'b'.repeat(64), instanceId: exportDraft.instanceId, expectedDraftRevision: 1, draftId: randomUUID(), timelineId, baseRevision: 1, raw: {deliveryName: 'Foreign'}}), {code: 'LOCAL_DELIVERY_SCOPE_MISMATCH'});
  f.store.close();
  assert.throws(() => drafts.get(key), {code: 'LOCAL_DRAFT_OWNER_REQUIRED'});
  assert.throws(() => delivery.get({projectId: f.projectId}), {code: 'LOCAL_DELIVERY_OWNER_REQUIRED'});
  assert.throws(() => text.get({projectId: f.projectId, shotId}), {code: 'LOCAL_SHOT_TEXT_OWNER_REQUIRED'});
});

test('application workspace preferences use only the app SQL/registry port and keep project CAS isolated', t => {
  const f = fixture(t), foreignId = randomUUID();
  const preferences = createWorkspacePreferences(f.store, {application: {db: f.library.db, tx: f.library.tx, hasProject: id => f.library.registry.get(id) !== null}});
  const state = defaultWorkspaceState(); delete (state.shared as Partial<typeof state.shared>).assetSearch;
  assert.deepEqual(preferences.get(f.projectId), {projectId: f.projectId, revision: 0, state: null});
  const input = {expectedRevision: 0, state}, saved = preferences.put(f.projectId, input);
  assert.deepEqual(preferences.put(f.projectId, input), saved);
  assert.equal(f.library.db.prepare('SELECT revision FROM workspace_preferences WHERE projectId=?').get(f.projectId)?.revision, 1);
  assert.equal(f.store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='workspace_preferences'").get(), undefined);
  assert.throws(() => preferences.get(foreignId), {code: 'NOT_FOUND'});
  assert.throws(() => preferences.put(f.projectId, {...input, state: {...state, activeMode: 'editing'}}), {code: 'PREFERENCES_CONFLICT'});
  f.store.close();
  assert.equal(preferences.get(f.projectId).revision, 1, 'Application state does not acquire or require an open project');
  f.library.close();
  assert.throws(() => preferences.get(f.projectId), {code: 'APP_LIBRARY_CLOSED'});
});

test('scope database injection cannot leave the private companion root', t => {
  const f = fixture(t), ui = createUiPreferences({root: f.localDir, databaseFile: f.library.databaseFile, storage,
    guards: {ownsLock: () => true, isReadOnly: () => false, hasProject: () => true}});
  assert.throws(() => ui.get(), {code: 'UI_PREFERENCES_UNAVAILABLE'});
});
