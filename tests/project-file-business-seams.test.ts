import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createProjectStore, openStore as openProjectStore} from '../packages/business/src/project-file/index.ts';
import {schemaObjects, foreignKeyCheck} from '../packages/business/src/project-file/cross-file/inspect.ts';
import {openLegacyWorkspaceStore as openWorkspaceStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {ServiceApplicationPorts} from '../packages/business/src/services.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {hasStoreTable, isProjectLayout, storeDirectories, storeTableSchema} from '../packages/business/src/store-layout.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {usesAssetAnnotationSchema, usesPrevisSchema, usesAgentPolicyAnswerSchema} from '../packages/business/src/workspace-schema-dispatch.ts';
import {readTimelineAudioRoleCapability} from '../packages/business/src/timeline-audio-role-business.ts';
import {readTimelineVolumeEnvelopeCapability} from '../packages/business/src/timeline-volume-envelope-capability.ts';
import {migrateSizedImageEditReviewSchema} from '../packages/business/src/images/review-schema-v62.ts';
import {migrateSceneKeyframeEditReviewSchema} from '../packages/business/src/images/review-schema-v68.ts';
import {installProjectLifecycleDefinitions, migrateProjectLifecycleSchema} from '../packages/business/src/project-lifecycle-schema.ts';
import {readLutResource} from '../packages/business/src/project-lut-reader.ts';
import type {LutResource} from '../packages/contracts/src/lut-resources.ts';

type Row = Record<string, unknown>;
function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-p2-business-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
function application(root: string) {
  const calls = {stop: 0, drain: 0};
  const unavailable = (): never => {throw new TypeError('Test application refuses legacy workspace backup operations.');};
  // A test-owned application port, not another workspace database. Business
  // edits are admitted, but no backup/import/restore can execute the old chain.
  const backups: ServiceApplicationPorts['backups'] = {
    getStatus: unavailable, list: unavailable, create: unavailable, stageRestore: unavailable,
    exportBundle: unavailable, importBundle: unavailable, importDirectory: unavailable,
    isBusy: () => false, assertMutationAllowed: () => {}, start: unavailable, tick: unavailable,
    stop: () => {calls.stop++;}, drain: async () => {calls.drain++;},
  };
  mkdirSync(root, {mode: 0o700});
  return {ports: {configuration: createWorkspaceConfiguration({root, env: {}}), outsidePaths:{list:()=>[],confirm:()=>{throw Error('This standalone app fixture cannot grant outside media');},revoke:()=>{throw Error('This standalone app fixture cannot revoke outside media');}},backups}, calls};
}
async function fixture(t: TestContext) {
  const root = scratch(t), store = openProjectStore(path.join(root, 'project'));
  t.after(() => store.close());
  const app = application(path.join(root, 'app'));
  const structure = schemaObjects(store.db);
  const providers = createProviderRegistry({db: store.db, root: store.root, env: {}});
  const services = createServices(store, providers, {
    env: {}, application: app.ports, imageOptions: {autoRun: false}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false},
  });
  t.after(() => services.drain());
  assert.deepEqual(schemaObjects(store.db), structure, 'composition does not install workspace DDL');
  const project = await services.call('project.create', {name: 'Kernel business'}) as Row;
  return {store, services, project, app, structure};
}

test('layout and table capabilities require the real live kernel, not an attached schema or copied directory fields', t => {
  const store = openProjectStore(scratch(t));
  t.after(() => store.close());
  assert.equal(isProjectLayout(store.db), true);
  assert.equal(storeTableSchema(store.db, 'image_groups'), 'project');
  assert.equal(storeTableSchema(store.db, 'image_tasks'), 'main');
  assert.equal(storeTableSchema(store.db, 'schema_version'), 'main');
  assert.equal(storeTableSchema(store.db, 'waveform_cache'), 'cache');
  assert.equal(hasStoreTable(store.db, 'project_deletion_scope'), false);
  assert.deepEqual(storeDirectories(store), {projectDir: store.projectDir, localDir: store.localDir, cacheDir: store.cacheDir, tempDir: store.tempDir});
  assert.deepEqual(storeDirectories({...store}), {projectDir: store.root, localDir: store.root, cacheDir: store.root, tempDir: store.root});
  const fake = new DatabaseSync(':memory:');
  t.after(() => fake.close());
  fake.exec("CREATE TABLE image_groups(x); ATTACH ':memory:' AS project; CREATE TABLE project.image_tasks(x)");
  assert.equal(isProjectLayout(fake), false);
  assert.equal(storeTableSchema(fake, 'image_groups'), 'main');
  assert.equal(hasStoreTable(fake, 'image_tasks'), false);
  store.close();
  assert.equal(isProjectLayout(store.db), false);
});

test('kernel services require explicit application ports and borrow their lifecycle', async t => {
  const root = scratch(t), store = createProjectStore({projectFile: path.join(root, 'Production.mioon'), locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')})});
  t.after(() => store.close());
  const structure = schemaObjects(store.db);
  assert.throws(() => createServices(store, new Map()), /explicit application/u);
  assert.deepEqual(schemaObjects(store.db), structure);
  const f = await fixture(t);
  assert.throws(() => f.services.setProjectDeletionCompanions({
    assertDeletable: () => assert.fail('legacy deletion must not inspect project companions'),
    removeProject: () => assert.fail('legacy deletion must not remove project companions'),
  }), /application project host/u);
  await assert.rejects(f.services.call('workspace.backup.create', {requestId: randomUUID()}), /refuses legacy workspace backup/u);
  await f.services.drain();
  assert.deepEqual(f.app.calls, {stop: 0, drain: 0});
});

test('real project services create their own project and retain shot, timeline and generation receipts across the three databases', async t => {
  const f = await fixture(t), projectId = f.store.projectId;
  assert.equal(f.project.id, projectId);
  await assert.rejects(f.services.call('project.create', {name: 'Second'}), {code: 'PROJECT_FILE_SINGLE_PROJECT'});
  const shot = await f.services.call('shot.create', {projectId, title: 'Opening', prompt: 'Offline receipt', requestId: randomUUID()}) as Row;
  const timeline = await f.services.call('timeline.get', {projectId}) as Row;
  assert.equal(timeline.projectId, projectId);
  assert.equal(usesAssetAnnotationSchema(f.store.db), true);
  assert.equal(usesPrevisSchema(f.store.db), true);
  assert.equal(usesAgentPolicyAnswerSchema(f.store.db), true);
  assert.equal(readTimelineAudioRoleCapability(f.store.db).editable, true);
  assert.equal(readTimelineVolumeEnvelopeCapability(f.store.db).editable, true);
  const input = {shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'mock'};
  const job = await f.services.call('generation.submit', input) as Row;
  assert.equal(job.status, 'queued');
  assert.deepEqual(await f.services.call('generation.submit', input), job);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.jobs').get()?.n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project.shots').get()?.n, 1);
  const imageInput = {projectId, requestId: randomUUID(), name: 'Image', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Local mock', options: {...IMAGE_FIXED_OPTIONS}};
  const image = await f.services.call('image.generate', imageInput) as Row;
  assert.equal(image.state, 'queued');
  assert.deepEqual(await f.services.call('image.generate', imageInput), image);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.image_tasks').get()?.n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project.image_groups').get()?.n, 1);
  await f.services.call('frame.task.list', {projectId});
  await f.services.call('scene.task.list', {projectId});
  assert.deepEqual(schemaObjects(f.store.db), f.structure);
  assert.deepEqual(foreignKeyCheck(f.store.db), []);
});

test('an image group from another computer reads idle and replaces its missing local task on the next exact CAS generation', async t => {
  const f = await fixture(t), projectId = f.store.projectId, groupId = randomUUID(), foreignTask = randomUUID(), timestamp = new Date().toISOString();
  f.store.tx(() => f.store.db.prepare('INSERT INTO image_groups(id,projectId,name,revision,headVersionId,activeTaskId,createdAt,updatedAt) VALUES(?,?,?,1,NULL,?,?,?)').run(groupId, projectId, 'Foreign group', foreignTask, timestamp, timestamp));
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
  const group = await f.services.call('image.group.get', {projectId, groupId}) as Row;
  assert.equal(group.activeTaskId, null);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n, before, 'read does not heal content');
  const input = {projectId, groupId, expectedRevision: 1, requestId: randomUUID(), name: 'Foreign group', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'New local task', options: {...IMAGE_FIXED_OPTIONS}};
  const accepted = await f.services.call('image.generate', input) as Row;
  assert.equal(f.store.db.prepare('SELECT activeTaskId FROM image_groups WHERE id=?').get(groupId)?.activeTaskId, accepted.id);
  assert.deepEqual(await f.services.call('image.generate', input), accepted);
});

test('a project image group cannot claim another local group task as its active owner', async t => {
  const f = await fixture(t), projectId = f.store.projectId;
  const input = {projectId, providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Local ownership', options: {...IMAGE_FIXED_OPTIONS}};
  const a = await f.services.call('image.generate', {...input, name: 'A', requestId: randomUUID()}) as Row;
  const b = await f.services.call('image.generate', {...input, name: 'B', requestId: randomUUID()}) as Row;
  // Content deliberately has no FK to another computer's task journal. A
  // present local task must still obey the original composite ownership rule.
  f.store.tx(() => f.store.db.prepare('UPDATE image_groups SET activeTaskId=?,revision=revision+1 WHERE id=?').run(String(b.id), String(a.groupId)));
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
  await assert.rejects(f.services.call('image.group.get', {projectId, groupId: a.groupId}), {code: 'IMAGE_RECORD_INVALID'});
  await assert.rejects(f.services.call('image.generate', {...input, name: 'A', groupId: a.groupId, expectedRevision: 2, requestId: randomUUID()}), {code: 'IMAGE_RECORD_INVALID'});
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n, before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()?.n, 2);
});

test('a missing active ID does not disguise an unfinished local group task as foreign work', async t => {
  const f = await fixture(t), projectId = f.store.projectId;
  const input = {projectId, name: 'A', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Local ownership', options: {...IMAGE_FIXED_OPTIONS}};
  const first = await f.services.call('image.generate', {...input, requestId: randomUUID()}) as Row, missing = randomUUID();
  f.store.tx(() => f.store.db.prepare('UPDATE image_groups SET activeTaskId=?,revision=revision+1 WHERE id=?').run(missing, String(first.groupId)));
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
  await assert.rejects(f.services.call('image.group.get', {projectId, groupId: first.groupId}), {code: 'IMAGE_RECORD_INVALID'});
  await assert.rejects(f.services.call('image.generate', {...input, groupId: first.groupId, expectedRevision: 2, requestId: randomUUID()}), {code: 'IMAGE_RECORD_INVALID'});
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n, before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()?.n, 1);
  assert.equal(f.store.db.prepare('SELECT activeTaskId FROM image_groups WHERE id=?').get(String(first.groupId))?.activeTaskId, missing);
});

test('runtime lifecycle and later migration seams refuse a kernel without touching persistent or TEMP objects', t => {
  const store = openProjectStore(scratch(t));
  t.after(() => store.close());
  const before = schemaObjects(store.db), changes = store.db.prepare('SELECT total_changes() AS n').get()?.n;
  // Frozen historical constructors remain byte-exact and are not runtime
  // entrypoints for a project. Composition above proves none of them runs.
  for (const migrate of [migrateSizedImageEditReviewSchema, migrateSceneKeyframeEditReviewSchema, installProjectLifecycleDefinitions]) {
    assert.throws(() => migrate(store.db), /Legacy workspace schema installers/u);
  }
  assert.throws(() => migrateProjectLifecycleSchema(store.db, () => assert.fail('legacy classifier must not run')), /Legacy workspace schema installers/u);
  assert.deepEqual(schemaObjects(store.db), before);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()?.n, changes);
});

test('the kernel LUT reader uses project content and the existing strict Cube, ownership and hash validators', async t => {
  const f = await fixture(t), projectId = f.store.projectId;
  const bytes = Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  const {resource} = await f.services.call('lut.import', {projectId, requestId: randomUUID(), name: 'Identity', dataBase64: bytes.toString('base64')}) as {resource: LutResource};
  assert.deepEqual(readLutResource(f.store.db, projectId, resource.id, true), resource);
  assert.throws(() => readLutResource(f.store.db, randomUUID(), resource.id, true), {code: 'LUT_NOT_FOUND'});
  const invalidId = randomUUID();
  f.store.tx(() => f.store.db.prepare('INSERT INTO project.project_lut_resources(id,projectId,name,sha256,sizeBytes,profile,metadata,content,createdAt) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(invalidId, projectId, 'Invalid hash', '0'.repeat(64), bytes.length, resource.profile, JSON.stringify(resource.metadata), bytes, resource.createdAt));
  assert.throws(() => readLutResource(f.store.db, projectId, invalidId, true), {code: 'LUT_RESOURCE_INVALID'});
  assert.deepEqual(schemaObjects(f.store.db), f.structure);
});

test('default legacy services still create independent random project IDs in the same workspace', async t => {
  const store = openWorkspaceStore(scratch(t));
  t.after(() => store.close());
  const services = createServices(store, new Map(), {env: {}});
  t.after(() => services.drain());
  const a = await services.call('project.create', {name: 'A'}) as Row, b = await services.call('project.create', {name: 'B'}) as Row;
  assert.notEqual(a.id, b.id);
  assert.equal(isProjectLayout(store.db), false);
  assert.equal(usesAssetAnnotationSchema(store.db), true);
  assert.equal(storeTableSchema(store.db, 'image_groups'), 'main');
});
