import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtempSync, rmSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore, ownsStoreLock} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {renderMockImagePng, validatePng} from '../packages/business/src/images/png.mjs';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, IMAGE_LIMITS, canonicalImageInput,
  isImageTaskResponse, isImageRequestResponse, isImageListResponse} from '../packages/contracts/src/images.mjs';

const code = expected => error => error.code === expected && !JSON.stringify(error).includes('PRIVATE_SENTINEL');
const inputFor = (projectId, patch = {}) => ({projectId, name: 'Frozen image name', providerId: 'mock',
  model: IMAGE_MODELS.mock, prompt: 'A synthetic, local-only acceptance test.', options: {...IMAGE_FIXED_OPTIONS},
  requestId: randomUUID(), ...patch});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let pngPromise;
const png = () => pngPromise ??= renderMockImagePng();
const tables = db => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
const rows = (db, names = tables(db)) => JSON.stringify(names.map(name => {
  const statement = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`); statement.setReadBigInts(true);
  return [name, statement.all()];
}), (_key, value) => typeof value === 'bigint' ? {sqliteInteger: String(value)} : value);
const changes = db => db.prepare('SELECT total_changes() AS n').get().n;
function privateFree(value) {
  const text = JSON.stringify(value);
  assert.ok(!/"(?:dataBase64|b64_json|bytes|relativePath|path|stagedReceipt|canonicalInput|snapshot|apiKey|authorization)"\s*:/.test(text));
  assert.ok(!text.includes('PRIVATE_SENTINEL'));
}
async function fixture(t, {autoRun = false, lock = true, generate, fault} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-image-business-'));
  const store = openStore(root, {lock});
  let calls = 0;
  const projections = [];
  const services = createServices(store, new Map(), {env: {}, imageOptions: {autoRun, fault, generate: async (input, options) => {
    calls++; projections.push(structuredClone(input));
    if (generate) return generate(input, options);
    options.beforeDispatch(); return {bytes: await png()};
  }}});
  t.after(async () => {try {await services.drain();} finally {store.close(); rmSync(root, {recursive: true, force: true});}});
  const project = await services.call('project.create', {name: 'Synthetic image project'});
  const other = await services.call('project.create', {name: 'Foreign project'});
  return {root, store, services, project, other, projections, get calls() {return calls;},
    input: patch => inputFor(project.id, patch), call: (op, input) => services.call(op, input),
    row: id => store.db.prepare('SELECT * FROM image_tasks WHERE id=?').get(id)};
}
async function settled(f, id, expected = 'succeeded') {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const value = await f.call('image.task.get', {projectId: f.project.id, taskId: id});
    if (value.state === expected) return value;
    if (['succeeded', 'failed', 'outcome_unknown', 'local_result_error'].includes(value.state)) assert.fail(`Expected ${expected}, got ${JSON.stringify(value)}`);
    await pause(5);
  }
  assert.fail(`Image task ${id} did not reach ${expected}`);
}

test('stable generation keys return the original ACK before CAS and reject changed operation, project and input', async t => {
  const f = await fixture(t), input = f.input(), accepted = await f.call('image.generate', input);
  assert.ok(isImageTaskResponse(accepted)); assert.equal(accepted.state, 'queued'); assert.equal(accepted.revision, 1);
  assert.equal(f.calls, 0);
  const cancelInput = {projectId: f.project.id, taskId: accepted.id, expectedRevision: 1, requestId: randomUUID()};
  const cancelled = await f.call('image.task.cancelQueued', cancelInput);
  assert.equal(cancelled.state, 'cancelled_before_dispatch'); assert.equal(cancelled.revision, 2);
  const before = rows(f.store.db);
  assert.deepEqual(await f.call('image.generate', input), accepted);
  assert.deepEqual(await f.call('image.task.cancelQueued', cancelInput), cancelled);
  const receipt = await f.call('image.request.get', {projectId: f.project.id, requestId: input.requestId});
  assert.ok(isImageRequestResponse(receipt)); assert.deepEqual(receipt.response, accepted);
  assert.deepEqual(await f.call('image.request.get', {projectId: f.other.id, requestId: input.requestId}), null);
  for (const patch of [{prompt: 'Different'}, {name: 'Different'}, {projectId: f.other.id}])
    await assert.rejects(f.call('image.generate', {...input, ...patch}), code('IMAGE_REQUEST_CONFLICT'));
  await assert.rejects(f.call('image.task.cancelQueued', {...cancelInput, requestId: input.requestId}), code('IMAGE_REQUEST_CONFLICT'));
  await assert.rejects(f.call('image.task.cancelQueued', {...cancelInput, requestId: randomUUID()}), code('IMAGE_REVISION_CONFLICT'));
  for (const op of ['image.task.get', 'image.task.cancelQueued']) {
    const foreign = {projectId: f.other.id, taskId: accepted.id, ...(op.endsWith('cancelQueued') ? {expectedRevision: 2, requestId: randomUUID()} : {})};
    await assert.rejects(f.call(op, foreign), code('IMAGE_NOT_FOUND'));
  }
  assert.equal(rows(f.store.db), before); assert.equal(f.calls, 0); privateFree(receipt);
});

test('V1 and V2 retain their original receipt and name without rewriting project, existing assets or video/history records', async t => {
  const f = await fixture(t, {autoRun: true});
  await f.call('project.get', {projectId: f.project.id});
  await f.call('shot.create', {projectId: f.project.id, title: 'Existing video shot'});
  const asset = f.store.put('assets', {id: randomUUID(), projectId: f.project.id, name: 'Existing import',
    mimeType: 'image/png', provenance: 'user-import', sha256: 'a'.repeat(64), createdAt: new Date().toISOString()});
  const job = f.store.put('jobs', {id: randomUUID(), projectId: f.project.id, status: 'queued', privateMarker: 'legacy video'});
  const unchangedNames = tables(f.store.db).filter(name => !name.startsWith('image_') && name !== 'assets');
  const before = rows(f.store.db, unchangedNames), originalAsset = JSON.stringify(f.store.get('assets', asset.id));
  const firstInput = f.input(), firstAck = await f.call('image.generate', firstInput), first = await settled(f, firstAck.id);
  let group = await f.call('image.group.get', {projectId: f.project.id, groupId: first.groupId});
  assert.equal(group.name, firstInput.name); assert.equal(group.headVersionId, first.versionId); assert.equal(group.activeTaskId, null);
  const secondInput = f.input({groupId: group.id, expectedRevision: group.revision, prompt: 'Another frozen prompt.'});
  await assert.rejects(f.call('image.generate', {...secondInput, name: 'Renamed group'}), code('IMAGE_STATE_CONFLICT'));
  const secondAck = await f.call('image.generate', secondInput), second = await settled(f, secondAck.id);
  assert.deepEqual(await f.call('image.generate', secondInput), secondAck, 'original ACK beats now-stale group CAS');
  assert.deepEqual(await f.call('image.generate', firstInput), firstAck);
  group = await f.call('image.group.get', {projectId: f.project.id, groupId: group.id});
  const input = {projectId: f.project.id, groupId: group.id};
  const versions = await f.call('image.version.list', input);
  assert.ok(isImageListResponse('image.version.list', input, versions));
  assert.deepEqual(versions.items.map(value => value.number), [2, 1]);
  assert.deepEqual(versions.items.map(value => value.id), [second.versionId, first.versionId]);
  assert.equal(group.headVersionId, second.versionId); assert.equal(group.name, firstInput.name);
  assert.equal(rows(f.store.db, unchangedNames), before); assert.equal(JSON.stringify(f.store.get('assets', asset.id)), originalAsset);
  assert.deepEqual(f.store.get('jobs', job.id), job); assert.equal(f.calls, 2);
  for (const projection of f.projections) assert.deepEqual(Object.keys(projection).sort(), ['model', 'options', 'prompt', 'providerId']);
  for (const version of versions.items) {
    const generated = f.store.get('assets', version.assetId), file = path.join(f.root, generated.relativePath), bytes = readFileSync(file);
    assert.equal(digest(bytes), version.sha256); assert.equal(bytes.length, version.byteLength);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(await validatePng(bytes), {mimeType: 'image/png', width: 1024, height: 1024, byteLength: bytes.length, sha256: digest(bytes)});
    assert.equal(generated.provenance, 'synthetic-mock'); privateFree(version);
  }
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_versions').get().n, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_requests').get().n, 2);
  const databaseText = rows(f.store.db);
  assert.ok(!databaseText.includes((await png()).toString('base64'))); assert.ok(!databaseText.includes('b64_json'));
});

test('OpenAI stays disabled before acceptance even with a trusted injected generator', async t => {
  const f = await fixture(t, {autoRun: true}), before = rows(f.store.db);
  const profiles = await f.call('image.profile.list', {});
  assert.equal(profiles.liveEnabled, false); assert.equal(profiles.items.find(value => value.providerId === 'openai').enabled, false);
  const input = f.input({providerId: 'openai', model: IMAGE_MODELS.openai});
  await assert.rejects(f.call('image.generate', input), error => {
    assert.equal(error.code, 'IMAGE_LIVE_DISABLED'); assert.equal(error.details?.imageOutcome?.status, 'not_accepted');
    assert.equal(error.details?.imageOutcome?.inputHash, digest(canonicalImageInput(input))); privateFree(error); return true;
  });
  assert.equal(rows(f.store.db), before); assert.equal(f.calls, 0);
});

test('strict server parsing rejects request-supplied adapters, paths, options and oversized or malformed inputs', async t => {
  const f = await fixture(t), before = rows(f.store.db);
  for (const patch of [{generate: () => {}}, {fault: 'after_acceptance'}, {autoRun: true}, {path: '/PRIVATE_SENTINEL'},
    {providerId: 'unknown'}, {model: IMAGE_MODELS.openai}, {prompt: 'x'.repeat(2001)}, {prompt: '\0'}, {name: ' '},
    {options: {...IMAGE_FIXED_OPTIONS, size: '512x512'}}, {options: {...IMAGE_FIXED_OPTIONS, n: 2}},
    {groupId: randomUUID()}, {expectedRevision: 1}, {requestId: 'short'}])
    await assert.rejects(f.call('image.generate', f.input(patch)), code('VALIDATION_ERROR'));
  assert.equal(rows(f.store.db), before); assert.equal(f.calls, 0);
});

test('one unresolved task locks its group while different groups remain independently queued', async t => {
  const f = await fixture(t), ack = await f.call('image.generate', f.input());
  const group = await f.call('image.group.get', {projectId: f.project.id, groupId: ack.groupId});
  await assert.rejects(f.call('image.generate', f.input({groupId: group.id, expectedRevision: group.revision})), code('IMAGE_GROUP_BUSY'));
  const other = await f.call('image.generate', f.input({name: 'Independent'})); assert.notEqual(other.groupId, group.id);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get().n, 2); assert.equal(f.calls, 0);
});

test('lock:false services cannot mutate or reconcile and image reads leave every row and total_changes untouched', async t => {
  const f = await fixture(t), ack = await f.call('image.generate', f.input());
  const observer = openStore(f.root, {lock: false});
  const services = createServices(observer, new Map(), {env: {}, imageOptions: {autoRun: true, generate: () => assert.fail('nonowner generator')}});
  t.after(async () => {await services.drain(); observer.close();});
  assert.equal(ownsStoreLock(f.store), true); assert.equal(ownsStoreLock(observer), false);
  const before = rows(observer.db), count = changes(observer.db);
  for (const [operation, input] of [
    ['image.generate', f.input()],
    ['image.task.cancelQueued', {projectId: f.project.id, taskId: ack.id, expectedRevision: 1, requestId: randomUUID()}],
    ['image.task.recoverResult', {projectId: f.project.id, taskId: ack.id, expectedRevision: 1, requestId: randomUUID()}],
  ]) await assert.rejects(services.call(operation, input), code('IMAGE_OWNER_REQUIRED'));
  for (const [operation, input] of [
    ['image.profile.list', {}], ['image.task.get', {projectId: f.project.id, taskId: ack.id}],
    ['image.request.get', {projectId: f.project.id, requestId: ack.requestId}],
    ['image.group.get', {projectId: f.project.id, groupId: ack.groupId}], ['image.task.list', {projectId: f.project.id}],
    ['image.group.list', {projectId: f.project.id}], ['image.version.list', {projectId: f.project.id, groupId: ack.groupId}],
  ]) privateFree(await services.call(operation, input));
  assert.equal(rows(observer.db), before); assert.equal(changes(observer.db), count); assert.equal(f.calls, 0);
});

for (const variant of ['input-hash', 'snapshot-identity', 'revision', 'oversized-input', 'oversized-snapshot', 'request-response', 'oversized-response', 'request-operation'])
  test(`corrupt ${variant} fails closed without receipts, private disclosure or read-time repair`, async t => {
    const f = await fixture(t), input = f.input(), ack = await f.call('image.generate', input), db = f.store.db;
    db.exec('PRAGMA ignore_check_constraints=ON; DROP TRIGGER immutable_image_task_identity; DROP TRIGGER image_task_state_transitions; DROP TRIGGER immutable_image_requests;');
    if (variant === 'input-hash') db.prepare('UPDATE image_tasks SET inputHash=?').run('b'.repeat(64));
    if (variant === 'snapshot-identity') db.prepare('UPDATE image_tasks SET snapshot=?').run(JSON.stringify({...JSON.parse(f.row(ack.id).snapshot), taskId: randomUUID()}));
    if (variant === 'revision') db.exec('UPDATE image_tasks SET revision=9007199254740992');
    if (variant === 'oversized-input') db.prepare('UPDATE image_tasks SET input=?').run(JSON.stringify({...input, private: 'PRIVATE_SENTINEL'.repeat(2000)}));
    if (variant === 'oversized-snapshot') db.prepare('UPDATE image_tasks SET snapshot=?').run(JSON.stringify({private: 'PRIVATE_SENTINEL'.repeat(2000)}));
    if (variant === 'request-response') db.prepare('UPDATE image_requests SET response=?').run(JSON.stringify({...ack, id: randomUUID()}));
    if (variant === 'oversized-response') db.prepare('UPDATE image_requests SET response=?').run(JSON.stringify({...ack, private: 'PRIVATE_SENTINEL'.repeat(3000)}));
    if (variant === 'request-operation') db.prepare('UPDATE image_requests SET operation=?').run('image.task.cancelQueued');
    const before = rows(db), count = changes(db);
    await assert.rejects(f.call('image.request.get', {projectId: f.project.id, requestId: input.requestId}), error => {
      assert.ok(['IMAGE_RECORD_INVALID', 'IMAGE_NOT_FOUND'].includes(error.code)); privateFree(error); return true;
    });
    await assert.rejects(f.call('image.generate', input), error => {
      assert.ok(['IMAGE_RECORD_INVALID', 'IMAGE_NOT_FOUND', 'IMAGE_REQUEST_CONFLICT'].includes(error.code)); privateFree(error); return true;
    });
    if (!variant.includes('response') && variant !== 'request-operation')
      await assert.rejects(f.call('image.task.list', {projectId: f.project.id}), code('IMAGE_RECORD_INVALID'));
    assert.equal(rows(db), before); assert.equal(changes(db), count); assert.equal(f.calls, 0);
  });

test('queue capacity is enforced per project and globally without dispatch or eviction', async t => {
  const f = await fixture(t), projects = [f.project, f.other];
  while (projects.length < 5) projects.push(await f.call('project.create', {name: `Queue project ${projects.length}`}));
  const first = [];
  for (const project of projects.slice(0, 4)) {
    for (let i = 0; i < IMAGE_LIMITS.queuedPerProject; i++) first.push(await f.call('image.generate', inputFor(project.id)));
    await assert.rejects(f.call('image.generate', inputFor(project.id)), code('IMAGE_QUEUE_FULL'));
  }
  assert.equal(first.length, IMAGE_LIMITS.queuedGlobal);
  const before = rows(f.store.db);
  await assert.rejects(f.call('image.generate', inputFor(projects[4].id)), code('IMAGE_QUEUE_FULL'));
  assert.equal(rows(f.store.db), before); assert.equal(f.calls, 0); assert.deepEqual(readdirSync(path.join(f.root, 'media')), []);
});

test('retained request capacity rejects new mutations but exact historical replay remains readable', async t => {
  const f = await fixture(t), input = f.input(), ack = await f.call('image.generate', input), db = f.store.db;
  // Compact, synthetic SQL rows exercise the admission count, without media or thousands of actual operations.
  const insert = db.prepare('INSERT INTO image_requests(requestId,operation,projectId,inputHash,canonicalInput,response) VALUES(?,?,?,?,?,?)');
  f.store.tx(() => {for (let i = 1; i < IMAGE_LIMITS.requestsPerProject; i++) {
    const requestId = `capacity-${String(i).padStart(6, '0')}`;
    insert.run(requestId, 'image.generate', f.project.id, 'a'.repeat(64), JSON.stringify({projectId: f.project.id, requestId}), JSON.stringify({projectId: f.project.id}));
  }});
  const before = rows(db);
  await assert.rejects(f.call('image.generate', f.input()), code('IMAGE_CAPACITY'));
  await assert.rejects(f.call('image.task.cancelQueued', {projectId: f.project.id, taskId: ack.id, expectedRevision: 1, requestId: randomUUID()}), code('IMAGE_CAPACITY'));
  assert.deepEqual(await f.call('image.generate', input), ack);
  assert.deepEqual((await f.call('image.request.get', {projectId: f.project.id, requestId: input.requestId})).response, ack);
  assert.equal(rows(db), before); assert.equal(f.calls, 0);
});

test('retained task capacity rejects admission without media allocation or deleting any retained task', async t => {
  const f = await fixture(t), db = f.store.db, timestamp = new Date().toISOString();
  const group = db.prepare('INSERT INTO image_groups(id,projectId,name,revision,headVersionId,activeTaskId,createdAt,updatedAt) VALUES(?,?,?,1,NULL,NULL,?,?)');
  const task = db.prepare("INSERT INTO image_tasks(id,projectId,groupId,requestId,inputHash,input,snapshot,state,revision,dispatched,stagedReceipt,versionId,errorCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'cancelled_before_dispatch',2,0,NULL,NULL,NULL,?,?)");
  // Retained terminal SQL fixtures exercise the hard cap without adapter calls,
  // file generation, queue pressure, or 1,000 public mutation round trips.
  f.store.tx(() => {for (let i = 0; i < IMAGE_LIMITS.tasksPerProject; i++) {
    const id = randomUUID(), groupId = randomUUID(), input = f.input();
    const frozen = {schemaVersion: 1, projectId: f.project.id, groupId, taskId: id,
      name: input.name, providerId: input.providerId, model: input.model, prompt: input.prompt, options: input.options};
    group.run(groupId, f.project.id, input.name, timestamp, timestamp);
    task.run(id, f.project.id, groupId, input.requestId, digest(canonicalImageInput(input)), canonicalImageInput(input), canonicalImageInput(frozen), timestamp, timestamp);
  }});
  const before = rows(db);
  await assert.rejects(f.call('image.generate', f.input()), code('IMAGE_CAPACITY'));
  assert.equal(rows(db), before); assert.equal(f.calls, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM image_tasks').get().n, IMAGE_LIMITS.tasksPerProject);
  assert.deepEqual(readdirSync(path.join(f.root, 'media')), []);
});

test('task list paging is bounded, authenticated and scoped to project, group, operation and requested limit', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await f.call('image.generate', f.input({name: `Image ${i}`}));
  const input = {projectId: f.project.id, limit: 2}, first = await f.call('image.task.list', input);
  assert.ok(isImageListResponse('image.task.list', input, first)); assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = await f.call('image.task.list', {...input, cursor: first.nextCursor});
  assert.equal(new Set([...first.items, ...second.items].map(value => value.id)).size, 4);
  const before = rows(f.store.db), count = changes(f.store.db);
  for (const [operation, patch] of [['image.task.list', {projectId: f.other.id}], ['image.task.list', {limit: 3}],
    ['image.group.list', {}], ['image.task.list', {groupId: first.items[0].groupId}], ['image.task.list', {cursor: first.nextCursor + 'x'}]])
    await assert.rejects(f.call(operation, {...input, cursor: first.nextCursor, ...patch}), code('INVALID_CURSOR'));
  assert.equal(rows(f.store.db), before); assert.equal(changes(f.store.db), count);
});
