import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/db.ts';
import {createImageReviewServices, validateImageTaskReview, safeImageReviewError} from '../packages/business/src/images/reviews.ts';
import {migrateImageReviewSchema} from '../packages/business/src/images/review-schema.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, canonicalImageInput as canonical} from '../packages/contracts/src/images.ts';
import {IMAGE_REVIEW_DESTINATION, IMAGE_REVIEW_LIMITS, isImageReviewResponse} from '../packages/contracts/src/image-reviews.ts';
import {DatabaseSync} from 'node:sqlite';
import {errorView} from './helpers/test-error.ts';

interface ReviewInput {projectId: string; requestId: string; name: string; providerId: string; model: string; prompt: string;
  options: Record<string, unknown>; [key: string]: unknown}
interface ReviewRecord {id: string; revision: number; state: string; taskId: string | null; postAttempts: number; [key: string]: unknown}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (expected: string) => (error: unknown) => {const failure = errorView(error); return failure.code === expected && !JSON.stringify(error).includes('SYNTHETIC_PRIVATE_SENTINEL');};
const rows = (db: DatabaseSync) => JSON.stringify(db.prepare('SELECT * FROM image_reviews ORDER BY id').all());
const changes = (db: DatabaseSync) => (db.prepare('SELECT total_changes() AS n').get() as {n: number}).n;
const generation = (projectId: string, patch: Record<string, unknown> = {}): ReviewInput => ({projectId, requestId: randomUUID(), name: 'Reviewed synthetic image',
  providerId: 'openai', model: IMAGE_MODELS.openai, prompt: 'Synthetic fixture, no network transmission.', options: {...IMAGE_FIXED_OPTIONS}, ...patch});
type ReviewFixture = {root: string; projectId: string; otherProjectId: string; store: ReturnType<typeof openStore>;
  reviews: ReturnType<typeof createImageReviewServices>;
  input(patch?: Record<string, unknown>): ReviewInput;
  configure(patch: Record<string, unknown>): void;
  prepare(input: ReviewInput): ReviewRecord;
  get(value: {id: string}): ReviewRecord;
  approval(value: ReviewRecord): {projectId: string; reviewId: string; expectedRevision: number};
  restart(): void};
function fixture(t: import('node:test').TestContext, options: Record<string, unknown> = {}): ReviewFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-image-review-'));
  let store = openStore(root), settings = {revision: 1, enabled: true, destination: IMAGE_REVIEW_DESTINATION};
  store.tx(() => migrateImageReviewSchema(store.db));
  const projectId = randomUUID(), otherProjectId = randomUUID();
  for (const id of [projectId, otherProjectId]) store.put('projects', {id, name: 'Review fixture'});
  const getSettings = () => settings;
  let reviews = createImageReviewServices(store, {getSettings, ...options});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const f: ReviewFixture = {root, projectId, otherProjectId, get store() {return store;}, get reviews() {return reviews;},
    input: (patch: Record<string, unknown> = {}) => generation(projectId, patch), configure: (patch: Record<string, unknown>) => {settings = {...settings, ...patch};},
    prepare(input) {return reviews.handlers['image.review.prepare']({input: input as never, settingsRevision: settings.revision}) as unknown as ReviewRecord;},
    get(value) {return reviews.handlers['image.review.get']({projectId, reviewId: value.id}) as unknown as ReviewRecord;},
    approval(value) {return {projectId, reviewId: value.id, expectedRevision: value.revision};},
    restart() {store.close(); store = openStore(root); reviews = createImageReviewServices(store, {getSettings, ...options});},
  };
  return f;
}
function insertTask(f: ReturnType<typeof fixture>, input: ReviewInput, id: string = randomUUID()) {
  const {db} = f.store, groupId = randomUUID(), timestamp = new Date().toISOString();
  const snapshot = {schemaVersion: 1, projectId: input.projectId, groupId, taskId: id, name: input.name,
    prompt: input.prompt, providerId: input.providerId, model: input.model, options: input.options};
  db.prepare('INSERT INTO image_groups(id,projectId,name,revision,headVersionId,activeTaskId,createdAt,updatedAt) VALUES(?,?,?,1,NULL,?,?,?)')
    .run(groupId, input.projectId, input.name, id, timestamp, timestamp);
  db.prepare("INSERT INTO image_tasks(id,projectId,groupId,requestId,inputHash,input,snapshot,state,revision,dispatched,stagedReceipt,versionId,errorCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,?,?)")
    .run(id, input.projectId, groupId, input.requestId, hash(canonical(input)), canonical(input), canonical(snapshot), timestamp, timestamp);
  return {id, projectId: input.projectId, groupId, requestId: input.requestId, name: input.name, prompt: input.prompt,
    providerId: input.providerId, model: input.model, options: input.options, state: 'queued', revision: 1, dispatched: false,
    versionId: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp};
}
function approve(f: ReviewFixture, approval: {projectId: string; reviewId: string; expectedRevision: number}, fault: (stage: string) => void = () => {}) {
  const input = f.reviews.readForApproval(approval), db = f.store.db;
  const previous = db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(input.requestId);
  if (previous) {
    const response = JSON.parse(previous.response); f.reviews.verifyReplay(input, response.id, approval); return response;
  }
  return f.store.tx(() => {
    const response = insertTask(f, input);
    f.reviews.authorizeAcceptance(input, response.id, approval); fault('before_receipt');
    db.prepare('INSERT INTO image_requests(requestId,operation,projectId,inputHash,canonicalInput,response) VALUES(?,?,?,?,?,?)')
      .run(input.requestId, 'image.generate', input.projectId, hash(canonical(input)), canonical(input), JSON.stringify(response));
    return response;
  });
}
function dispatch(f: ReviewFixture, input: ReviewInput, taskId: string, fault: (stage: string) => void = () => {}) {
  f.store.tx(() => {
    f.reviews.beforeDispatch(input, taskId); fault('after_review_fence');
    f.store.db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=revision+1 WHERE id=?").run(taskId);
  });
}

test('prepare is retained exact local intent; no approval, task, receipt, or POST is produced', t => {
  const f = fixture(t), input = f.input(), value = f.prepare(input);
  assert.ok(isImageReviewResponse(value)); assert.equal(value.state, 'pending'); assert.equal(value.taskId, null); assert.equal(value.postAttempts, 0);
  assert.equal(value.policy.promptStorage, 'local-plaintext'); assert.equal(value.policy.price, 'usage-based-unknown');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_requests').get()!.n, 0);
  assert.deepEqual(f.prepare(input), value);
  const before = rows(f.store.db), count = changes(f.store.db);
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(f.get(value), value);
    assert.deepEqual(f.reviews.readForApproval(f.approval(value)), input);
    assert.equal(f.reviews.handlers['image.review.list']({projectId: f.projectId}).items.length, 1);
  }
  assert.equal(rows(f.store.db), before); assert.equal(changes(f.store.db), count);
  for (const patch of [{prompt: 'Changed intent'}, {projectId: f.otherProjectId}, {name: 'Changed name'}])
    assert.throws(() => f.prepare({...input, ...patch}), code('IMAGE_REVIEW_CONFLICT'));
  f.configure({revision: 2});
  assert.throws(() => f.prepare(input), code('IMAGE_REVIEW_CONFLICT'));
  assert.deepEqual(f.reviews.handlers['image.review.prepare']({input, settingsRevision: 1}), value);
  assert.equal(rows(f.store.db), before);
});

test('approval reservation, queued task and original ACK commit or roll back together', t => {
  const f = fixture(t), input = f.input(), value = f.prepare(input), approval = f.approval(value), before = rows(f.store.db);
  assert.throws(() => approve(f, approval, () => {throw new Error('Synthetic acceptance fault');}), /Synthetic/);
  assert.equal(rows(f.store.db), before);
  for (const table of ['image_groups', 'image_tasks', 'image_requests']) assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
  const ack = approve(f, approval), retained = f.get(value);
  assert.equal(retained.state, 'approved'); assert.equal(retained.taskId, ack.id); assert.equal(retained.postAttempts, 0);
  assert.deepEqual(f.reviews.getForTask(f.projectId, ack.id), retained);
  assert.deepEqual(validateImageTaskReview(f.store.db, f.projectId, ack.id, input), retained);
  assert.equal(f.store.db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(input.requestId)!.response, JSON.stringify(ack));
  assert.throws(() => f.reviews.authorizeAcceptance(input, ack.id, approval), /require the image transaction/);
  assert.throws(() => f.reviews.beforeDispatch(input, ack.id), /require the image transaction/);
});

test('lost confirmation ACK and exact repeated approvals recover original key before settings/CAS, without reexecution', t => {
  const f = fixture(t), input = f.input(), value = f.prepare(input), approval = f.approval(value), ack = approve(f, approval);
  const receipt = f.store.db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(input.requestId)!.response;
  f.configure({revision: 2, enabled: false});
  for (let index = 0; index < 3; index++) assert.deepEqual(approve(f, approval), ack);
  f.restart();
  assert.deepEqual(approve(f, approval), ack); assert.equal(f.get(value)!.state, 'approved');
  assert.equal(f.store.db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(input.requestId)!.response, receipt);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n, 1);
  assert.throws(() => f.reviews.verifyReplay({...input, prompt: 'Changed'}, ack.id, approval), code('IMAGE_REVIEW_CONFLICT'));
  assert.throws(() => f.reviews.verifyReplay(input, randomUUID(), approval), code('IMAGE_REVIEW_REQUIRED'));
  assert.throws(() => f.reviews.verifyReplay(input, ack.id, {...approval, expectedRevision: 2}), code('IMAGE_REVIEW_REQUIRED'));
});

test('only one POST fence is possible; unknown outcome and restart never release or replace reservation', t => {
  const f = fixture(t), input = f.input(), value = f.prepare(input), approval = f.approval(value), ack = approve(f, approval);
  let syntheticPosts = 0;
  dispatch(f, input, ack.id); syntheticPosts++;
  f.store.db.prepare("UPDATE image_tasks SET state='outcome_unknown',revision=revision+1,errorCode='IMAGE_OUTCOME_UNKNOWN' WHERE id=?").run(ack.id);
  assert.equal(f.get(value)!.postAttempts, 1); assert.equal(f.get(value)!.state, 'dispatched');
  assert.throws(() => dispatch(f, input, ack.id), code('IMAGE_REVIEW_STATE_CONFLICT'));
  f.restart();
  const before = rows(f.store.db), count = changes(f.store.db);
  assert.deepEqual(approve(f, approval), ack);
  assert.deepEqual(f.prepare(input), f.get(value));
  f.reviews.handlers['image.review.list']({projectId: f.projectId});
  assert.equal(changes(f.store.db), count); assert.equal(rows(f.store.db), before); assert.equal(syntheticPosts, 1);
  assert.throws(() => dispatch(f, input, ack.id), code('IMAGE_REVIEW_STATE_CONFLICT'));
  assert.throws(() => f.reviews.reject({...approval, expectedRevision: 3}), code('IMAGE_REVIEW_STATE_CONFLICT'));
});

test('dispatch review fence rolls back atomically with task fence on a synthetic pre-POST fault', t => {
  const f = fixture(t), input = f.input(), value = f.prepare(input), ack = approve(f, f.approval(value)), before = rows(f.store.db);
  assert.throws(() => dispatch(f, input, ack.id, () => {throw new Error('Synthetic before POST');}), /Synthetic/);
  assert.equal(rows(f.store.db), before); assert.equal(f.get(value)!.postAttempts, 0);
  assert.equal(f.store.db.prepare('SELECT dispatched FROM image_tasks WHERE id=?').get(ack.id)!.dispatched, 0);
  dispatch(f, input, ack.id); assert.equal(f.get(value)!.postAttempts, 1);
});

test('rejection wins approval race and accepted tasks use existing cancelQueued semantics', t => {
  const f = fixture(t), first = f.prepare(f.input()), approval = f.approval(first);
  const rejected = f.reviews.reject(approval); assert.equal(rejected.state, 'rejected');
  assert.deepEqual(f.reviews.reject(approval), rejected);
  assert.throws(() => approve(f, approval), code('IMAGE_REVIEW_REVISION_CONFLICT'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n, 0);
  const input = f.input(), value = f.prepare(input), ack = approve(f, f.approval(value));
  assert.throws(() => f.reviews.reject({...f.approval(value), expectedRevision: 2}), code('IMAGE_REVIEW_STATE_CONFLICT'));
  f.store.tx(() => {
    f.store.db.prepare("UPDATE image_tasks SET state='cancelled_before_dispatch',revision=2 WHERE id=?").run(ack.id);
    f.store.db.prepare('UPDATE image_groups SET activeTaskId=NULL,revision=revision+1 WHERE id=?').run(ack.groupId);
  });
  assert.equal(f.get(value)!.state, 'approved'); assert.equal(f.get(value)!.postAttempts, 0);
  assert.throws(() => dispatch(f, input, ack.id), code('IMAGE_REVIEW_STATE_CONFLICT'));
  assert.deepEqual(approve(f, f.approval(value)), ack);
});

test('changed revision, disabled settings and pending configuration fences block before acceptance/POST', t => {
  let pending = false;
  const f = fixture(t, {assertSettings() {if (pending) throw Object.assign(new Error('Configuration pending'), {code: 'SETTINGS_PENDING'}); return true;}});
  const input = f.input(), value = f.prepare(input), approval = f.approval(value);
  f.configure({revision: 2});
  assert.throws(() => approve(f, approval), code('IMAGE_REVIEW_SETTINGS_CHANGED'));
  assert.equal(f.get(value)!.state, 'pending');
  f.configure({revision: 1}); const ack = approve(f, approval);
  f.configure({enabled: false}); assert.throws(() => dispatch(f, input, ack.id), code('IMAGE_LIVE_DISABLED'));
  f.configure({enabled: true}); pending = true; assert.throws(() => dispatch(f, input, ack.id), code('SETTINGS_PENDING'));
  pending = false; f.configure({revision: 2}); assert.throws(() => dispatch(f, input, ack.id), code('IMAGE_REVIEW_SETTINGS_CHANGED'));
  assert.equal(f.get(value)!.postAttempts, 0);
});

test('stop and abort revoke future transmission; read-only history stays available', t => {
  const controller = new AbortController(), f = fixture(t, {signal: controller.signal});
  const input = f.input(), value = f.prepare(input), ack = approve(f, f.approval(value));
  controller.abort();
  assert.throws(() => dispatch(f, input, ack.id), code('IMAGE_SERVICE_STOPPED'));
  assert.equal(f.get(value)!.postAttempts, 0);
  const second = fixture(t), next = second.prepare(second.input()); second.reviews.stop();
  assert.throws(() => approve(second, second.approval(next)), code('IMAGE_SERVICE_STOPPED'));
  assert.equal(second.get(next)!.state, 'pending');
});

test('project isolation, cursor scope and restart expiration are read-only and bounded', t => {
  const f = fixture(t), created = Array.from({length: 4}, () => f.prepare(f.input())), query = {projectId: f.projectId, limit: 2};
  const page = f.reviews.handlers['image.review.list'](query); assert.equal(page.items.length, 2); assert.ok(page.nextCursor);
  const second = f.reviews.handlers['image.review.list']({...query, cursor: page.nextCursor});
  assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...page.items, ...second.items].map(value => value.id)).size, 4);
  const before = rows(f.store.db), count = changes(f.store.db);
  assert.throws(() => f.reviews.handlers['image.review.get']({projectId: f.otherProjectId, reviewId: created[0].id}), code('IMAGE_REVIEW_NOT_FOUND'));
  for (const patch of [{projectId: f.otherProjectId}, {limit: 1}, {cursor: `${page.nextCursor}x`}])
    assert.throws(() => f.reviews.handlers['image.review.list']({...query, cursor: page.nextCursor, ...patch}), code('INVALID_CURSOR'));
  assert.equal(rows(f.store.db), before); assert.equal(changes(f.store.db), count);
  f.restart(); assert.throws(() => f.reviews.handlers['image.review.list']({...query, cursor: page.nextCursor}), code('INVALID_CURSOR'));
  assert.deepEqual(f.get(created[0]), created[0]);
});

test('bounded retained capacity rejects new review but exact existing intent remains recoverable', t => {
  const f = fixture(t), input = f.input(), first = f.prepare(input);
  for (let index = 1; index < IMAGE_REVIEW_LIMITS.reviewsPerProject; index++) f.prepare(f.input());
  const before = rows(f.store.db);
  assert.throws(() => f.prepare(f.input()), code('IMAGE_REVIEW_CAPACITY'));
  assert.deepEqual(f.prepare(input), first); assert.equal(rows(f.store.db), before);
  const foreign = f.prepare(generation(f.otherProjectId)); assert.equal(foreign.projectId, f.otherProjectId);
});

for (const corruption of ['canonical-input', 'intent-hash', 'oversized-intent', 'state', 'reservation']) {
  test(`corrupt ${corruption} is rejected without prompt leakage, repair, or new work`, t => {
    const f = fixture(t), input = f.input(), value = f.prepare(input), db = f.store.db;
    db.exec('PRAGMA ignore_check_constraints=ON; DROP TRIGGER immutable_image_review_identity; DROP TRIGGER image_review_state_transitions; DROP TRIGGER image_review_task_binding;');
    if (corruption === 'canonical-input') db.prepare('UPDATE image_reviews SET canonicalInput=?').run(JSON.stringify({...input, prompt: 'SYNTHETIC_PRIVATE_SENTINEL'}));
    if (corruption === 'intent-hash') db.prepare('UPDATE image_reviews SET intentHash=?').run('b'.repeat(64));
    if (corruption === 'oversized-intent') db.prepare('UPDATE image_reviews SET canonicalIntent=?').run(JSON.stringify({private: 'SYNTHETIC_PRIVATE_SENTINEL'.repeat(3000)}));
    if (corruption === 'state') db.prepare('UPDATE image_reviews SET state=?').run('invented');
    if (corruption === 'reservation') db.prepare('UPDATE image_reviews SET postAttempts=1').run();
    const before = rows(db), count = changes(db);
    assert.throws(() => f.get(value), code('IMAGE_REVIEW_INVALID'));
    assert.throws(() => f.reviews.handlers['image.review.list']({projectId: f.projectId}), code('IMAGE_REVIEW_INVALID'));
    assert.equal(rows(db), before); assert.equal(changes(db), count);
  });
}

test('review identity, exact canonical intent and reservations cannot be replaced, deleted, or edited through SQL', t => {
  const f = fixture(t), input = f.input(), value = f.prepare(input), db = f.store.db, before = rows(db);
  for (const sql of ["UPDATE image_reviews SET inputHash='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'", 'DELETE FROM image_reviews',
    'INSERT OR REPLACE INTO image_reviews SELECT * FROM image_reviews', "UPDATE image_reviews SET state='approved',revision=2"])
    assert.throws(() => db.exec(sql));
  assert.equal(rows(db), before);
  const ack = approve(f, f.approval(value)); dispatch(f, input, ack.id);
  assert.throws(() => db.exec("UPDATE image_reviews SET state='approved',revision=4,postAttempts=0,dispatchedAt=NULL"));
});

test('non-owner may inspect but cannot prepare, approve, reject or consume a POST fence', t => {
  const f = fixture(t), input = f.input(), value = f.prepare(input), observer = openStore(f.root, {lock: false});
  t.after(() => observer.close());
  const service = createImageReviewServices(observer, {getSettings: () => ({revision: 1, enabled: true, destination: IMAGE_REVIEW_DESTINATION})});
  assert.deepEqual(service.handlers['image.review.get']({projectId: f.projectId, reviewId: value.id}), value);
  assert.throws(() => service.handlers['image.review.prepare']({input: f.input(), settingsRevision: 1}), code('IMAGE_OWNER_REQUIRED'));
  assert.throws(() => service.reject(f.approval(value)), code('IMAGE_OWNER_REQUIRED'));
  observer.tx(() => assert.throws(() => service.authorizeAcceptance(input, randomUUID(), f.approval(value)), code('IMAGE_OWNER_REQUIRED')));
});

test('async settings hooks and thenables cannot authorize acceptance or a POST', t => {
  const f = fixture(t);
  assert.throws(() => createImageReviewServices(f.store, {getSettings: async () => ({})}), /must be synchronous/);
  const service = createImageReviewServices(f.store, {getSettings: () => Promise.resolve({revision: 1, enabled: true, destination: IMAGE_REVIEW_DESTINATION})});
  assert.throws(() => service.handlers['image.review.prepare']({input: f.input(), settingsRevision: 1}), /synchronous values/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 0);
});

test('supplied settings assertions must synchronously return literal true, and HTTP errors are sanitized', t => {
  const f = fixture(t), getSettings = () => ({revision: 1, enabled: true, destination: IMAGE_REVIEW_DESTINATION});
  for (const value of [false, undefined, 1, {}]) {
    const service = createImageReviewServices(f.store, {getSettings, assertSettings: () => value});
    assert.throws(() => service.handlers['image.review.prepare']({input: f.input(), settingsRevision: 1}), code('IMAGE_REVIEW_SETTINGS_CHANGED'));
  }
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 0);
  const cause = Object.assign(new Error('SYNTHETIC_PRIVATE_SENTINEL'), {code: 'IMAGE_REVIEW_REQUIRED', status: 200,
    details: {apiKey: 'SYNTHETIC_PRIVATE_SENTINEL'}});
  assert.deepEqual(safeImageReviewError(cause), {code: 'IMAGE_REVIEW_REQUIRED', message: 'This exact live image request requires the user’s approval.', status: 403});
  assert.equal(safeImageReviewError(new Error('SYNTHETIC_PRIVATE_SENTINEL')).code, 'IMAGE_REVIEW_INVALID');
  assert.ok(!JSON.stringify(safeImageReviewError(cause)).includes('SYNTHETIC_PRIVATE_SENTINEL'));
});
