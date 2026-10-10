import {randomUUID, randomBytes, createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {isAsyncFunction, isPromise} from 'node:util/types';
import {AppError} from '@mioon/contracts';
import {canonicalImageInput as canonical, IMAGE_LIMITS, imageSchemas} from '../../../contracts/src/images.mjs';
import {IMAGE_REVIEW_DESTINATION, IMAGE_REVIEW_POLICY, IMAGE_REVIEW_LIMITS, imageReviewSchemas,
  imageReviewApprovalSchema, imageReviewRejectionSchema, imageReviewIntentSchema, imageReviewResponseSchema} from '../../../contracts/src/image-reviews.mjs';
import {createImageOwnershipReader} from '../image-ownership.mjs';
import {ownsStoreLock} from '../db.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const messages = Object.freeze({
  IMAGE_REVIEW_INVALID: 'The retained image review could not be verified.',
  IMAGE_REVIEW_NOT_FOUND: 'This project has no matching image review.',
  IMAGE_REVIEW_CONFLICT: 'This image request already has a different immutable review.',
  IMAGE_REVIEW_REQUIRED: 'This exact live image request requires the user’s approval.',
  IMAGE_REVIEW_STATE_CONFLICT: 'This image review cannot be approved, rejected, or dispatched in its current state.',
  IMAGE_REVIEW_REVISION_CONFLICT: 'This image review has changed. Read the original review again.',
  IMAGE_REVIEW_SETTINGS_CHANGED: 'Image settings changed after this review was prepared. This review cannot authorize a different configuration.',
  IMAGE_REVIEW_CAPACITY: 'Retained image review capacity is full. Existing reviews have not been removed.',
  IMAGE_OWNER_REQUIRED: 'An image review mutation requires the current exclusive backend owner.',
  IMAGE_SERVICE_STOPPED: 'The image service is stopped. Read the original request after reopening.',
  IMAGE_LIVE_DISABLED: 'Live image generation is not enabled.',
});
const fail = (code, status = 409) => {throw new AppError(code, messages[code] || 'Image review input is invalid.', status);};
const invalid = () => fail('IMAGE_REVIEW_INVALID');
export function safeImageReviewError(cause) {
  const selected = typeof cause?.code === 'string' && Object.hasOwn(messages, cause.code) ? cause.code : 'IMAGE_REVIEW_INVALID';
  const statuses = {IMAGE_REVIEW_NOT_FOUND: 404, IMAGE_REVIEW_REQUIRED: 403, IMAGE_OWNER_REQUIRED: 403,
    IMAGE_LIVE_DISABLED: 403, IMAGE_REVIEW_CAPACITY: 507, IMAGE_SERVICE_STOPPED: 503};
  if (cause?.code === 'VALIDATION_ERROR') return {code: 'VALIDATION_ERROR', message: 'Image review input is invalid.', status: 400};
  return {code: selected, message: messages[selected], status: statuses[selected] ?? 409};
}
const textColumn = (name, size, nullable = false) => `CASE WHEN ${nullable ? `${name} IS NULL OR ` : ''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
const columns = ['id', 'projectId'].map(name => textColumn(name, 36)).concat(textColumn('requestId', 800),
  textColumn('inputHash', 64), textColumn('canonicalInput', IMAGE_LIMITS.inputBytes), textColumn('intentHash', 64),
  textColumn('canonicalIntent', IMAGE_REVIEW_LIMITS.intentBytes), textColumn('state', 20),
  "CASE WHEN typeof(revision)='integer' AND revision BETWEEN 1 AND 3 THEN revision ELSE 0 END AS revision",
  textColumn('taskId', 36, true), "CASE WHEN typeof(postAttempts)='integer' AND postAttempts IN (0,1) THEN postAttempts ELSE -1 END AS postAttempts",
  textColumn('createdAt', 40), textColumn('updatedAt', 40), ...['approvedAt', 'rejectedAt', 'dispatchedAt'].map(name => textColumn(name, 40, true))).join(',');

function decodeReviewRow(row) {
  if (!row || Buffer.byteLength(JSON.stringify(row)) > IMAGE_REVIEW_LIMITS.rowBytes) invalid();
  let input, intent;
  try {input = JSON.parse(row.canonicalInput); intent = JSON.parse(row.canonicalIntent);} catch {invalid();}
  if (!imageSchemas['image.generate'].safeParse(input).success || !imageReviewIntentSchema.safeParse(intent).success ||
      canonical(input) !== row.canonicalInput || canonical(intent) !== row.canonicalIntent || digest(row.canonicalInput) !== row.inputHash || digest(row.canonicalIntent) !== row.intentHash ||
      canonical(intent.input) !== row.canonicalInput || intent.reviewId !== row.id || input.projectId !== row.projectId || input.requestId !== row.requestId) invalid();
  const dto = {id: row.id, projectId: row.projectId, requestId: row.requestId, input,
    inputHash: row.inputHash, settingsRevision: intent.settingsRevision, destination: intent.destination, policy: intent.policy,
    state: row.state, revision: row.revision, taskId: row.taskId, postAttempts: row.postAttempts, createdAt: row.createdAt, updatedAt: row.updatedAt,
    approvedAt: row.approvedAt, rejectedAt: row.rejectedAt, dispatchedAt: row.dispatchedAt};
  if (!imageReviewResponseSchema.safeParse(dto).success) invalid();
  return {row, intent, dto};
}

/** Safe for the image ownership reader: validates only the review/task binding,
 * never calls that reader recursively, opens files, or changes either record.
 * Legacy Mock tasks have no review and deliberately return null. */
export function validateImageTaskReview(db, projectId, taskId, input) {
  if (!imageSchemas['image.generate'].safeParse(input).success || input.projectId !== projectId) invalid();
  if (input.providerId === 'mock') return null;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_reviews'").get()) invalid();
  const canonicalInput = canonical(input);
  const row = db.prepare(`SELECT ${columns} FROM image_reviews WHERE taskId=? AND projectId=? LIMIT 1`).get(taskId, projectId);
  const value = decodeReviewRow(row);
  if (!['approved', 'dispatched'].includes(value.row.state) || value.row.projectId !== projectId || value.row.taskId !== taskId ||
      value.row.canonicalInput !== canonicalInput || value.row.inputHash !== digest(canonicalInput)) invalid();
  const task = db.prepare(`SELECT ${textColumn('id', 36)},${textColumn('projectId', 36)},${textColumn('requestId', 800)},
    ${textColumn('inputHash', 64)},${textColumn('input', IMAGE_LIMITS.inputBytes)},
    CASE WHEN typeof(dispatched)='integer' AND dispatched IN (0,1) THEN dispatched ELSE -1 END AS dispatched
    FROM image_tasks WHERE id=? AND projectId=? LIMIT 1`).get(taskId, projectId);
  if (!task || task.id !== taskId || task.projectId !== projectId || task.requestId !== input.requestId || task.inputHash !== value.row.inputHash ||
      task.input !== canonicalInput || task.dispatched !== value.row.postAttempts) invalid();
  return value.dto;
}

/** Main/backend-only authority. Public handlers prepare/read only. None of the
 * hooks performs I/O, queues work, opens a transaction, or approves a later
 * changed request. The image lifecycle owns task acceptance and dispatch txs. */
export function createImageReviewServices(store, {getSettings, assertSettings, signal, fault = () => {}} = {}) {
  const {db, tx} = store, cursorSecret = randomBytes(32);
  let stopped = false;
  for (const callback of [getSettings, assertSettings, fault]) {
    if (callback !== undefined && (typeof callback !== 'function' || isAsyncFunction(callback))) throw new TypeError('Image review hooks must be synchronous');
  }
  function synchronous(callback, ...args) {
    const result = callback(...args);
    if (result && typeof result.then === 'function') {
      if (isPromise(result)) result.catch(() => {});
      throw new TypeError('Image review hooks must return synchronous values');
    }
    return result;
  }
  function owner() {
    if (stopped || signal?.aborted) fail('IMAGE_SERVICE_STOPPED', 503);
    if (!ownsStoreLock(store)) fail('IMAGE_OWNER_REQUIRED', 403);
  }
  function transactionRequired() {
    owner();
    if (!db.isTransaction) throw new TypeError('Image review acceptance and dispatch require the image transaction');
  }
  function parse(schema, input) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) fail('VALIDATION_ERROR', 400);
    return parsed.data;
  }
  function project(projectId) {
    const row = db.prepare(`SELECT id,${textColumn('data', 16384)} FROM projects WHERE id=? LIMIT 1`).get(projectId);
    let value; try {value = JSON.parse(row?.data);} catch {fail('IMAGE_REVIEW_NOT_FOUND', 404);}
    if (!value || value.id !== projectId) fail('IMAGE_REVIEW_NOT_FOUND', 404);
  }
  function settings(settingsRevision) {
    if (typeof getSettings !== 'function') fail('IMAGE_LIVE_DISABLED', 403);
    const current = synchronous(getSettings);
    if (!current || !Number.isSafeInteger(current.revision) || current.revision < 1 || current.destination !== IMAGE_REVIEW_DESTINATION) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
    if (current.revision !== settingsRevision) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
    if (current.enabled !== true) fail('IMAGE_LIVE_DISABLED', 403);
    if (assertSettings && synchronous(assertSettings, {revision: settingsRevision, destination: IMAGE_REVIEW_DESTINATION}) !== true) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
    return current;
  }
  function boundTask(value, taskId = value.row.taskId) {
    if (!taskId) invalid();
    const task = createImageOwnershipReader(db, value.row.projectId, {fail: invalid}).task(taskId);
    if (task.row.projectId !== value.row.projectId || task.row.requestId !== value.row.requestId || task.row.inputHash !== value.row.inputHash ||
        task.row.input !== value.row.canonicalInput || canonical(task.input) !== value.row.canonicalInput || task.input.providerId !== 'openai') invalid();
    return task;
  }
  function decode(row, {verifyTask = true} = {}) {
    const value = decodeReviewRow(row);
    if (row.taskId && verifyTask) {
      const task = boundTask(value);
      if ((row.postAttempts === 1) !== task.dto.dispatched) invalid();
    }
    return value;
  }
  function review(projectId, reviewId) {
    project(projectId);
    const row = db.prepare(`SELECT ${columns} FROM image_reviews WHERE id=? AND projectId=? LIMIT 1`).get(reviewId, projectId);
    if (!row) fail('IMAGE_REVIEW_NOT_FOUND', 404);
    return decode(row);
  }
  function getForTask(projectId, taskId) {
    project(projectId);
    const task = createImageOwnershipReader(db, projectId, {fail: invalid}).task(taskId);
    if (task.input.providerId !== 'openai') fail('IMAGE_REVIEW_NOT_FOUND', 404);
    return validateImageTaskReview(db, projectId, taskId, task.input);
  }
  function capacity(projectId) {
    for (const [where, args, cap] of [['', [], IMAGE_REVIEW_LIMITS.reviewsGlobal], [' WHERE projectId=?', [projectId], IMAGE_REVIEW_LIMITS.reviewsPerProject]]) {
      if (db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM image_reviews${where} LIMIT ?)`).get(...args, cap + 1).n >= cap) fail('IMAGE_REVIEW_CAPACITY', 507);
    }
  }
  function prepare(raw) {
    const input = parse(imageReviewSchemas['image.review.prepare'], raw), generation = input.input;
    const canonicalInput = canonical(generation);
    if (Buffer.byteLength(canonicalInput) > IMAGE_LIMITS.inputBytes) fail('IMAGE_REVIEW_CAPACITY', 507);
    return tx(() => {
      owner(); project(generation.projectId);
      const previous = db.prepare(`SELECT ${columns} FROM image_reviews WHERE requestId=? LIMIT 1`).get(generation.requestId);
      if (previous) {
        // A conflicting project gets no prompt or other retained review data.
        if (previous.projectId !== generation.projectId || previous.canonicalInput !== canonicalInput) fail('IMAGE_REVIEW_CONFLICT');
        const original = decode(previous);
        if (original.intent.settingsRevision !== input.settingsRevision) fail('IMAGE_REVIEW_CONFLICT');
        return original.dto; // Exact history survives setting changes, restarts, rejection, and dispatch.
      }
      if (db.prepare('SELECT 1 FROM image_requests WHERE requestId=? LIMIT 1').get(generation.requestId)) fail('IMAGE_REVIEW_CONFLICT');
      if (generation.groupId) createImageOwnershipReader(db, generation.projectId, {fail: invalid}).group(generation.groupId);
      settings(input.settingsRevision); capacity(generation.projectId);
      const id = randomUUID(), timestamp = now();
      const intent = {schemaVersion: 1, reviewId: id, input: generation, settingsRevision: input.settingsRevision,
        destination: IMAGE_REVIEW_DESTINATION, policy: IMAGE_REVIEW_POLICY}, canonicalIntent = canonical(intent);
      if (Buffer.byteLength(canonicalIntent) > IMAGE_REVIEW_LIMITS.intentBytes) fail('IMAGE_REVIEW_CAPACITY', 507);
      db.prepare(`INSERT INTO image_reviews(id,projectId,requestId,inputHash,canonicalInput,intentHash,canonicalIntent,state,revision,taskId,postAttempts,createdAt,updatedAt,approvedAt,rejectedAt,dispatchedAt)
        VALUES(?,?,?,?,?,?,?,'pending',1,NULL,0,?,?,NULL,NULL,NULL)`).run(id, generation.projectId, generation.requestId, digest(canonicalInput), canonicalInput, digest(canonicalIntent), canonicalIntent, timestamp, timestamp);
      synchronous(fault, 'after_review_prepare', {reviewId: id});
      return review(generation.projectId, id).dto;
    });
  }
  function readForApproval(raw) {
    const approval = parse(imageReviewApprovalSchema, raw);
    // Reading pending intent is never approval. The image acceptance transaction
    // does all fresh CAS/settings checks; accepted exact replay is checked first.
    return structuredClone(review(approval.projectId, approval.reviewId).dto.input);
  }
  function matchingReview(input, rawApproval) {
    const approval = parse(imageReviewApprovalSchema, rawApproval);
    if (approval.projectId !== input.projectId) fail('IMAGE_REVIEW_REQUIRED', 403);
    const value = review(input.projectId, approval.reviewId);
    if (canonical(input) !== value.row.canonicalInput || digest(canonical(input)) !== value.row.inputHash) fail('IMAGE_REVIEW_CONFLICT');
    return {approval, value};
  }
  function verifyReplay(input, taskId, rawApproval) {
    const {approval, value} = matchingReview(input, rawApproval);
    if (!['approved', 'dispatched'].includes(value.row.state) || value.row.taskId !== taskId || approval.expectedRevision !== 1) fail('IMAGE_REVIEW_REQUIRED', 403);
    boundTask(value, taskId);
    return true;
  }
  function authorizeAcceptance(input, taskId, rawApproval) {
    transactionRequired();
    const {approval, value} = matchingReview(input, rawApproval);
    if (value.row.revision !== approval.expectedRevision) fail('IMAGE_REVIEW_REVISION_CONFLICT');
    if (value.row.state !== 'pending' || value.row.taskId !== null || value.row.postAttempts !== 0) fail('IMAGE_REVIEW_STATE_CONFLICT');
    settings(value.intent.settingsRevision);
    const task = boundTask(value, taskId);
    if (task.row.state !== 'queued' || task.row.revision !== 1 || task.dto.dispatched) fail('IMAGE_REVIEW_STATE_CONFLICT');
    const timestamp = now();
    const result = db.prepare("UPDATE image_reviews SET state='approved',revision=2,taskId=?,approvedAt=?,updatedAt=? WHERE id=? AND projectId=? AND revision=1 AND state='pending'")
      .run(taskId, timestamp, timestamp, value.row.id, value.row.projectId);
    if (result.changes !== 1) fail('IMAGE_REVIEW_REVISION_CONFLICT');
    synchronous(fault, 'after_review_reservation', {reviewId: value.row.id, taskId});
    return true;
  }
  function beforeDispatch(input, taskId) {
    transactionRequired(); project(input.projectId);
    const row = db.prepare(`SELECT ${columns} FROM image_reviews WHERE requestId=? AND projectId=? LIMIT 1`).get(input.requestId, input.projectId);
    if (!row) fail('IMAGE_REVIEW_REQUIRED', 403);
    const value = decode(row);
    if (canonical(input) !== value.row.canonicalInput || value.row.taskId !== taskId) fail('IMAGE_REVIEW_CONFLICT');
    if (value.row.state !== 'approved' || value.row.postAttempts !== 0) fail('IMAGE_REVIEW_STATE_CONFLICT');
    settings(value.intent.settingsRevision);
    const task = boundTask(value, taskId);
    if (task.row.state !== 'queued' || task.dto.dispatched) fail('IMAGE_REVIEW_STATE_CONFLICT');
    const timestamp = now();
    const result = db.prepare("UPDATE image_reviews SET state='dispatched',revision=3,postAttempts=1,dispatchedAt=?,updatedAt=? WHERE id=? AND projectId=? AND revision=2 AND state='approved' AND postAttempts=0")
      .run(timestamp, timestamp, value.row.id, value.row.projectId);
    if (result.changes !== 1) fail('IMAGE_REVIEW_REVISION_CONFLICT');
    synchronous(fault, 'after_review_dispatch_fence', {reviewId: value.row.id, taskId});
    // The caller MUST advance image_tasks.dispatched in this same transaction.
    return true;
  }
  function reject(raw) {
    const input = parse(imageReviewRejectionSchema, raw);
    return tx(() => {
      owner(); const value = review(input.projectId, input.reviewId);
      // A repeated exact pending-review rejection has no additional effect.
      if (value.row.state === 'rejected' && input.expectedRevision === 1) return value.dto;
      if (value.row.revision !== input.expectedRevision) fail('IMAGE_REVIEW_REVISION_CONFLICT');
      if (value.row.state !== 'pending') fail('IMAGE_REVIEW_STATE_CONFLICT');
      const timestamp = now();
      const result = db.prepare("UPDATE image_reviews SET state='rejected',revision=2,rejectedAt=?,updatedAt=? WHERE id=? AND projectId=? AND revision=1 AND state='pending'")
        .run(timestamp, timestamp, input.reviewId, input.projectId);
      if (result.changes !== 1) fail('IMAGE_REVIEW_REVISION_CONFLICT');
      synchronous(fault, 'after_review_rejection', {reviewId: input.reviewId});
      return review(input.projectId, input.reviewId).dto;
    });
  }
  const sign = body => createHmac('sha256', cursorSecret).update(body).digest('base64url');
  function list(input) {
    project(input.projectId);
    const limit = input.limit ?? IMAGE_REVIEW_LIMITS.pageSize, scope = ['image.review.list', input.projectId, limit];
    let after = null;
    if (input.cursor) {
      try {
        const [body, mac, ...rest] = input.cursor.split('.');
        if (rest.length || !body || mac?.length !== 43 || !timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) throw new Error();
        const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 4 || canonical(decoded.slice(0, 3)) !== canonical(scope)) throw new Error();
        after = decoded[3];
        if (!Array.isArray(after) || after.length !== 2 || typeof after[0] !== 'string' || after[0].length > 40 || !Number.isFinite(Date.parse(after[0])) || !/^[a-f0-9-]{36}$/i.test(after[1])) throw new Error();
      } catch {throw new AppError('INVALID_CURSOR', 'The image review cursor is invalid or expired.', 400);}
    }
    const args = after ? [input.projectId, after[0], after[0], after[1], limit + 1] : [input.projectId, limit + 1];
    const rows = db.prepare(`SELECT ${columns} FROM image_reviews WHERE projectId=?${after ? ' AND (createdAt<? OR (createdAt=? AND id<?))' : ''} ORDER BY createdAt DESC,id DESC LIMIT ?`).all(...args);
    const selected = rows.slice(0, limit), items = selected.map(row => decode(row).dto);
    let nextCursor = null;
    if (rows.length > limit) {
      const last = selected.at(-1), body = Buffer.from(JSON.stringify([...scope, [last.createdAt, last.id]])).toString('base64url');
      nextCursor = `${body}.${sign(body)}`;
    }
    return {projectId: input.projectId, items, nextCursor};
  }
  const snapshotRead = read => (...args) => {
    const outer = db.isTransaction;
    if (!outer) db.exec('BEGIN DEFERRED');
    try {return read(...args);} finally {if (!outer && db.isTransaction) db.exec('COMMIT');}
  };
  const handlers = Object.freeze({
    'image.review.prepare': prepare,
    'image.review.get': snapshotRead(raw => {const input = parse(imageReviewSchemas['image.review.get'], raw); return review(input.projectId, input.reviewId).dto;}),
    'image.review.list': snapshotRead(raw => list(parse(imageReviewSchemas['image.review.list'], raw))),
  });
  return Object.freeze({handlers, readForApproval: snapshotRead(readForApproval), authorizeAcceptance, verifyReplay: snapshotRead(verifyReplay),
    getForTask: snapshotRead(getForTask), beforeDispatch, reject, stop() {stopped = true;}});
}
