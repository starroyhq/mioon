import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore, createProjectStore} from '../packages/business/src/project-file/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {validateTimelineColourBindings} from '../packages/business/src/timeline-colour-business.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';
import {durableWorkspaceState} from '../apps/web/src/workspace-preferences.ts';
import type {LutResource} from '../packages/contracts/src/lut-resources.ts';

function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-project-read-boundary-'));
  t.after(() => rmSync(root, {recursive: true, force: true})); return root;
}

test('direct TEST preferences use the one real app database without changing project content', async t => {
  const store = openStore(scratch(t)), services = createServices(store, new Map());
  t.after(async () => {await services.drain(); store.close();});
  await services.call('project.create', {name: 'Preferences'});
  const preferences = createWorkspacePreferences(store), library = testProjectAppLibrary(store); assert.ok(library);
  assert.deepEqual(preferences.get(store.projectId), {projectId: store.projectId, revision: 0, state: null});
  const before = store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const input = {expectedRevision: 0, state: durableWorkspaceState(defaultWorkspaceState())};
  const saved = preferences.put(store.projectId, input);
  assert.deepEqual(preferences.put(store.projectId, input), saved);
  assert.equal(library.db.prepare('SELECT revision FROM workspace_preferences WHERE projectId=?').get(store.projectId)?.revision, 1);
  assert.equal(store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='workspace_preferences'").get(), undefined);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.throws(() => preferences.get(randomUUID()), {code: 'NOT_FOUND'});
  assert.throws(() => createWorkspacePreferences({...store}), {name: 'TypeError', message: 'Project workspace preferences require the exact live project store'});
});

test('a production-layout project cannot silently construct preferences without an application port', t => {
  const root = scratch(t), directory = path.join(root, 'project'); mkdirSync(directory, {mode: 0o700});
  const store = createProjectStore({projectFile: path.join(directory, 'project.mioon'), locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')})});
  t.after(() => store.close());
  assert.throws(() => createWorkspacePreferences(store), {name: 'TypeError', message: 'Project workspace preferences require explicit application persistence'});
  assert.equal(testProjectAppLibrary(store), undefined);
});

test('services sharing one TEST application keep each caller environment admission', async t => {
  const store = openStore(scratch(t));
  const disabled = createServices(store, new Map(), {env: {}});
  const enabled = createServices(store, new Map(), {env: {MIOON_ENABLE_LIVE_PROVIDER: '1'}});
  t.after(async () => {await disabled.drain(); await enabled.drain(); store.close();});
  assert.equal(disabled.configuration.liveEnabled(), false);
  assert.equal(enabled.configuration.liveEnabled(), true);
  const library = testProjectAppLibrary(store); assert.ok(library);
  assert.equal(library.documents.read('workspace-settings-v1.json'), null, 'environment defaults do not overwrite app settings');
  assert.equal(disabled.configuration.root, library.dataDir); assert.equal(enabled.configuration.root, library.dataDir);
});

test('timeline look validation reads real project LUT content and preserves ownership, hash and zero-write checks', async t => {
  const store = openStore(scratch(t)), services = createServices(store, new Map());
  t.after(async () => {await services.drain(); store.close();});
  const projectId = store.projectId; await services.call('project.create', {name: 'LUT binding'});
  const bytes = Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  const {resource} = await services.call('lut.import', {projectId, requestId: randomUUID(), name: 'Identity', dataBase64: bytes.toString('base64')}) as {resource: LutResource};
  const assetId = randomUUID(), trackId = randomUUID();
  const colour = {profileId: 'mioon-rec709-sdr-clip-v1', source: null, look: {resourceId: resource.id, resourceSha256: resource.sha256, resourceProfile: resource.profile, purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: true, strength: 1}};
  const timeline = {projectId, tracks: [{id: trackId, kind: 'video'}], clips: [{id: randomUUID(), assetId, trackId, colour}]};
  const assets = new Map([[assetId, {id: assetId, projectId, sha256: 'a'.repeat(64), mimeType: 'video/mp4'}]]);
  const before = store.db.prepare('SELECT total_changes() AS n').get()!.n;
  validateTimelineColourBindings(store.db, timeline, assets);
  assert.throws(() => validateTimelineColourBindings(store.db, {...timeline, clips: [{...timeline.clips[0]!, colour: {...colour, look: {...colour.look, resourceSha256: '0'.repeat(64)}}}]}, assets), {code: 'TIMELINE_COLOUR_LOOK_UNAVAILABLE'});
  const foreign = randomUUID();
  assert.throws(() => validateTimelineColourBindings(store.db, {...timeline, projectId: foreign}, new Map([[assetId, {...assets.get(assetId)!, projectId: foreign}]])), {code: 'TIMELINE_COLOUR_LOOK_UNAVAILABLE'});
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
});
