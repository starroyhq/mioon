import {getWorkspaceRestoreContext} from '../workspace-restore-schema.ts';
import {workspaceRestoreError} from '../workspace-restore-policy.ts';
import {randomUUID, randomInt, randomBytes, createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {isAsyncFunction, isPromise} from 'node:util/types';
import {AppError} from '@mioon/contracts';
import {canonicalImageInput as canonical, IMAGE_LIMITS, imageSchemas} from '../../../contracts/src/images.ts';
import {IMAGE_EDIT_REVIEW_DESTINATION, IMAGE_REVIEW_DESTINATION, IMAGE_REVIEW_POLICY, IMAGE_REVIEW_LIMITS, imageReviewSchemas,
  imageReviewApprovalSchema, imageReviewRejectionSchema, imageReviewIntentSchema, imageReviewResponseSchema} from '../../../contracts/src/image-reviews.ts';
import {createImageEditSourceResolver} from './edit-source.ts';
import {createImageOwnershipReader} from '../image-ownership.ts';
import {customImageConfigurationSchema, isCompleteCustomImageConfiguration, getCustomImageDestination} from '../../../contracts/src/image-settings.ts';
import {ownsStoreLock} from '../db.ts';
import type {DatabaseSync} from 'node:sqlite';
import {COMFY_IMAGE_POLICY, COMFY_IMAGE_PROFILE_ID, COMFY_IMAGE_VERSION, comfyImageConfigurationSchema, isCompleteComfyImageConfiguration, getComfyImageDestination} from '../../../contracts/src/comfy-images.ts';
import {buildComfyWorkflow, hashComfyWorkflow, validateComfyExecution} from '../comfy/workflow.ts';

export type ImageGenerationInput = ReturnType<(typeof imageSchemas)['image.generate']['parse']>;
export type ImageReviewIntent = ReturnType<typeof imageReviewIntentSchema.parse>;
export type ImageReviewDto = ReturnType<typeof imageReviewResponseSchema.parse>;
export interface ImageStore {readonly db: DatabaseSync; readonly root: string; tx<T>(callback: () => T): T}
export interface ImageReviewRow {
  id: string; projectId: string; requestId: string; inputHash: string; canonicalInput: string; intentHash: string; canonicalIntent: string;
  state: string; revision: number; taskId: string | null; postAttempts: number; createdAt: string; updatedAt: string;
  approvedAt: string | null; rejectedAt: string | null; dispatchedAt: string | null;
}
export interface ExpectedImageSettings {revision: number; destination: string; configuration?: unknown}
export interface ImageReviewHooks {
  getSettings?: (providerId: string) => unknown;
  assertSettings?: (expected: ExpectedImageSettings, providerId: string) => unknown;
  signal?: AbortSignal;
  fault?: (stage: string, details?: Record<string, unknown>) => unknown;
}
export interface OwnedImageTask {
  row: {id: string; projectId: string; requestId: string; inputHash: string; input: string; state: string; revision: number};
  dto: {dispatched: boolean};
  input: ImageGenerationInput;
  snapshot: {sourceImage?: unknown};
}
interface EditSourceResolver {
  verify(input: ImageGenerationInput, expected?: unknown): Promise<{descriptor: unknown; bytes: Buffer}>;
  assertOwned(input: ImageGenerationInput, expected?: unknown): unknown;
  assertCurrent(input: ImageGenerationInput, verified: {descriptor: unknown; bytes: Buffer}): true;
}
interface ReviewTaskRow {id: string; projectId: string; requestId: string; inputHash: string; input: string; snapshot: string; dispatched: number}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const now = (): string => new Date().toISOString();
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
const messages: Readonly<Record<string, string>> = Object.freeze({
  IMAGE_SOURCE_INVALID: 'The managed PNG source could not be verified.',
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
const statuses: Readonly<Record<string, number>> = Object.freeze({IMAGE_REVIEW_NOT_FOUND: 404, IMAGE_REVIEW_REQUIRED: 403, IMAGE_OWNER_REQUIRED: 403,
  IMAGE_LIVE_DISABLED: 403, IMAGE_REVIEW_CAPACITY: 507, IMAGE_SERVICE_STOPPED: 503});
function fail(code: string, status = 409): never { throw new AppError(code, messages[code] || 'Image review input is invalid.', status); }
function invalid(): never { fail('IMAGE_REVIEW_INVALID'); }
export function safeImageReviewError(cause: unknown): {code: string; message: string; status: number} {
  const source = object(cause), code = source?.code;
  const selected = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'IMAGE_REVIEW_INVALID';
  if (code === 'VALIDATION_ERROR') return {code: 'VALIDATION_ERROR', message: 'Image review input is invalid.', status: 400};
  return {code: selected, message: messages[selected], status: statuses[selected] ?? 409};
}
const textColumn = (name: string, size: number, nullable = false): string => `CASE WHEN ${nullable ? `${name} IS NULL OR ` : ''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
const columns = ['id', 'projectId'].map(name => textColumn(name, 36)).concat(textColumn('requestId', 800),
  textColumn('inputHash', 64), textColumn('canonicalInput', IMAGE_LIMITS.inputBytes), textColumn('intentHash', 64),
  textColumn('canonicalIntent', IMAGE_REVIEW_LIMITS.intentBytes), textColumn('state', 20),
  "CASE WHEN typeof(revision)='integer' AND revision BETWEEN 1 AND 3 THEN revision ELSE 0 END AS revision",
  textColumn('taskId', 36, true), "CASE WHEN typeof(postAttempts)='integer' AND postAttempts IN (0,1) THEN postAttempts ELSE -1 END AS postAttempts",
  textColumn('createdAt', 40), textColumn('updatedAt', 40), ...['approvedAt', 'rejectedAt', 'dispatchedAt'].map(name => textColumn(name, 40, true))).join(',');

function decodeReviewRow(row: ImageReviewRow | undefined) {
  if (!row || Buffer.byteLength(JSON.stringify(row)) > IMAGE_REVIEW_LIMITS.rowBytes) invalid();
  let inputValue: unknown, intentValue: unknown;
  try {inputValue = JSON.parse(row!.canonicalInput); intentValue = JSON.parse(row!.canonicalIntent);} catch {invalid();}
  const input = imageSchemas['image.generate'].safeParse(inputValue), intent = imageReviewIntentSchema.safeParse(intentValue);
  if (!input.success || !intent.success ||
      canonical(input.data) !== row!.canonicalInput || canonical(intent.data) !== row!.canonicalIntent || digest(row!.canonicalInput) !== row!.inputHash || digest(row!.canonicalIntent) !== row!.intentHash ||
      canonical(intent.data.input) !== row!.canonicalInput || intent.data.reviewId !== row!.id || input.data.projectId !== row!.projectId || input.data.requestId !== row!.requestId) invalid();
  const generation = input.data, frozenIntent = intent.data;
  const dto: Record<string, unknown> = {id: row!.id, projectId: row!.projectId, requestId: row!.requestId, input: generation,
    inputHash: row!.inputHash, settingsRevision: frozenIntent.settingsRevision, destination: frozenIntent.destination, policy: frozenIntent.policy,
    state: row!.state, revision: row!.revision, taskId: row!.taskId, postAttempts: row!.postAttempts, createdAt: row!.createdAt, updatedAt: row!.updatedAt,
    approvedAt: row!.approvedAt, rejectedAt: row!.rejectedAt, dispatchedAt: row!.dispatchedAt,
    ...(frozenIntent.schemaVersion === 2 || frozenIntent.schemaVersion === 3 ? {configuration: frozenIntent.configuration} : {}),
    ...(frozenIntent.schemaVersion === 4 ? {sourceImage: frozenIntent.sourceImage} : {}),
    ...(frozenIntent.schemaVersion === 3 ? {execution: frozenIntent.execution} : {})};
  const parsed = imageReviewResponseSchema.safeParse(dto);
  if (!parsed.success) invalid();
  if (frozenIntent.schemaVersion === 3) { try { validateComfyExecution(frozenIntent.execution, {prompt: generation.prompt, checkpoint: generation.model}); } catch { invalid(); } }
  return {row: row as ImageReviewRow, intent: frozenIntent, dto: parsed.data};
}

/** Safe for the image ownership reader: validates only the review/task binding,
 * never calls that reader recursively, opens files, or changes either record.
 * Legacy Mock tasks have no review and deliberately return null. */
export function validateImageTaskReview(db: DatabaseSync, projectId: string, taskId: string, input: unknown, {consume = (): void => {}}: {consume?: (value: string) => void} = {}): ImageReviewDto | null {
  const parsed = imageSchemas['image.generate'].safeParse(input);
  if (!parsed.success || parsed.data.projectId !== projectId) invalid();
  const generation = parsed.data;
  if (generation.providerId === 'mock') return null;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_reviews'").get()) invalid();
  const canonicalInput = canonical(generation);
  const row = db.prepare(`SELECT ${columns} FROM image_reviews WHERE taskId=? AND projectId=? LIMIT 1`).get(taskId, projectId);
  if (row) consume(JSON.stringify(row));
  const value = decodeReviewRow(row as ImageReviewRow | undefined);
  if (!['approved', 'dispatched'].includes(value.row.state) || value.row.projectId !== projectId || value.row.taskId !== taskId ||
      value.row.canonicalInput !== canonicalInput || value.row.inputHash !== digest(canonicalInput)) invalid();
  const task = db.prepare(`SELECT ${textColumn('id', 36)},${textColumn('projectId', 36)},${textColumn('requestId', 800)},
    ${textColumn('inputHash', 64)},${textColumn('input', IMAGE_LIMITS.inputBytes)},${textColumn('snapshot', IMAGE_LIMITS.snapshotBytes)},
    CASE WHEN typeof(dispatched)='integer' AND dispatched IN (0,1) THEN dispatched ELSE -1 END AS dispatched
    FROM image_tasks WHERE id=? AND projectId=? LIMIT 1`).get(taskId, projectId) as ReviewTaskRow | undefined;
  if (task) consume(JSON.stringify(task));
  if (!task || task.id !== taskId || task.projectId !== projectId || task.requestId !== generation.requestId || task.inputHash !== value.row.inputHash ||
      task.input !== canonicalInput || task.dispatched !== value.row.postAttempts) invalid();
  if (purposeOf(generation) === 'edit') { let snapshot: unknown; try { snapshot = JSON.parse(task.snapshot); } catch { invalid(); } if (canonical(object(snapshot)?.sourceImage) !== canonical('sourceImage' in value.intent ? value.intent.sourceImage : undefined)) invalid(); }
  return value.dto;
}

/** Main/backend-only authority. Public handlers prepare/read only. None of the
 * hooks performs I/O, queues work, opens a transaction, or approves a later
 * changed request. The image lifecycle owns task acceptance and dispatch txs. */
export function createImageReviewServices(store: ImageStore, {getSettings, assertSettings, signal, fault = (): void => {}}: ImageReviewHooks = {}) {
  if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();
  const {db, tx} = store, cursorSecret = randomBytes(32);
  const editSources = createImageEditSourceResolver(store, {signal}) as EditSourceResolver;
  let stopped = false;
  for (const callback of [getSettings, assertSettings, fault]) {
    if (callback !== undefined && (typeof callback !== 'function' || isAsyncFunction(callback))) throw new TypeError('Image review hooks must be synchronous');
  }
  function synchronous<A extends readonly unknown[], R>(callback: (...args: A) => R, ...args: A): R {
    const result = callback(...args);
    if (result && typeof (result as {then?: unknown}).then === 'function') {
      if (isPromise(result)) (result as Promise<unknown>).catch(() => {});
      throw new TypeError('Image review hooks must return synchronous values');
    }
    return result;
  }
  function owner(): void {
    if (stopped || signal?.aborted) fail('IMAGE_SERVICE_STOPPED', 503);
    if (!ownsStoreLock(store)) fail('IMAGE_OWNER_REQUIRED', 403);
  }
  function transactionRequired(): void {
    owner();
    if (!db.isTransaction) throw new TypeError('Image review acceptance and dispatch require the image transaction');
  }
  function parse<T>(schema: {safeParse(input: unknown): {success: true; data: T} | {success: false; error: unknown}}, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) fail('VALIDATION_ERROR', 400);
    return parsed.data;
  }
  function project(projectId: string): void {
    const row = db.prepare(`SELECT id,${textColumn('data', 16384)} FROM projects WHERE id=? LIMIT 1`).get(projectId) as {data: string} | undefined;
    let value: unknown; try {value = JSON.parse(row?.data as string);} catch {fail('IMAGE_REVIEW_NOT_FOUND', 404);}
    if (object(value)?.id !== projectId) fail('IMAGE_REVIEW_NOT_FOUND', 404);
  }
  function settings(settingsRevision: number, generation: ImageGenerationInput, frozenIntent?: ImageReviewIntent): ExpectedImageSettings {
    if (typeof getSettings !== 'function') fail('IMAGE_LIVE_DISABLED', 403);
    const current = object(synchronous(getSettings, generation.providerId));
    if (!current || typeof current.revision !== 'number' || !Number.isSafeInteger(current.revision) || current.revision < 1 || current.revision !== settingsRevision) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
    if (current.enabled !== true) fail('IMAGE_LIVE_DISABLED', 403);
    let expected: ExpectedImageSettings = {revision: settingsRevision, destination: purposeOf(generation) === 'edit' ? IMAGE_EDIT_REVIEW_DESTINATION : IMAGE_REVIEW_DESTINATION};
    if (generation.providerId === 'openai-compatible') {
      const parsed = customImageConfigurationSchema.safeParse(current.configuration);
      if (!parsed.success || !parsed.data.enabled || !isCompleteCustomImageConfiguration(parsed.data) ||
          parsed.data.model !== generation.model || canonical(parsed.data.options) !== canonical(generation.options)) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
      const configuration = parsed.data, destination = getCustomImageDestination(configuration.baseUrl);
      if (current.destination !== destination || frozenIntent && (frozenIntent.schemaVersion !== 2 ||
          frozenIntent.destination !== destination || canonical(frozenIntent.configuration) !== canonical(configuration))) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
      expected = {revision: settingsRevision, destination, configuration};
    } else if (generation.providerId === 'comfy-local') {
      const parsed = comfyImageConfigurationSchema.safeParse(current.configuration);
      if (!parsed.success || !parsed.data.enabled || !isCompleteComfyImageConfiguration(parsed.data) || parsed.data.model !== generation.model || canonical(parsed.data.options) !== canonical(generation.options)) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
      const configuration = parsed.data, destination = getComfyImageDestination(configuration.baseUrl);
      if (current.destination !== destination || frozenIntent && (frozenIntent.schemaVersion !== 3 || frozenIntent.destination !== destination || canonical(frozenIntent.configuration) !== canonical(configuration))) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
      expected = {revision: settingsRevision, destination, configuration};
    } else if (generation.providerId !== 'openai' || current.destination !== IMAGE_REVIEW_DESTINATION ||
        frozenIntent && (frozenIntent.schemaVersion !== (purposeOf(generation) === 'edit' ? 4 : 1) || frozenIntent.destination !== expected.destination)) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
    if (assertSettings && synchronous(assertSettings, expected, generation.providerId) !== true) fail('IMAGE_REVIEW_SETTINGS_CHANGED');
    return expected;
  }
  function ownedTask(projectId: string, taskId: string): OwnedImageTask {
    return createImageOwnershipReader(db, projectId, {fail: invalid}).task(taskId, {shallow: true}) as OwnedImageTask;
  }
  function boundTask(value: {row: ImageReviewRow; intent: ImageReviewIntent}, taskId: string | null = value.row.taskId): OwnedImageTask {
    if (!taskId) invalid();
    const task = createImageOwnershipReader(db, value.row.projectId, {fail: invalid}).task(taskId, {shallow: true}) as OwnedImageTask;
    if (task.row.projectId !== value.row.projectId || task.row.requestId !== value.row.requestId || task.row.inputHash !== value.row.inputHash ||
        task.row.input !== value.row.canonicalInput || canonical(task.input) !== value.row.canonicalInput || task.input.providerId !== value.intent.input.providerId || task.input.providerId === 'mock' || canonical(task.snapshot.sourceImage) !== canonical('sourceImage' in value.intent ? value.intent.sourceImage : undefined)) invalid();
    return task;
  }
  function decode(row: ImageReviewRow, {verifyTask = true, verifySource = true}: {verifyTask?: boolean; verifySource?: boolean} = {}) {
    const value = decodeReviewRow(row);
    if (verifySource && value.intent.schemaVersion === 4) editSources.assertOwned(value.intent.input, value.intent.sourceImage);
    if (row.taskId && verifyTask) {
      const task = boundTask(value);
      if ((row.postAttempts === 1) !== task.dto.dispatched) invalid();
    }
    return value;
  }
  function review(projectId: string, reviewId: string, options?: {verifyTask?: boolean; verifySource?: boolean}) {
    project(projectId);
    const row = db.prepare(`SELECT ${columns} FROM image_reviews WHERE id=? AND projectId=? LIMIT 1`).get(reviewId, projectId) as ImageReviewRow | undefined;
    if (!row) fail('IMAGE_REVIEW_NOT_FOUND', 404);
    return decode(row!, options);
  }
  function getForTask(projectId: string, taskId: string): ImageReviewDto | null {
    project(projectId);
    const task = ownedTask(projectId, taskId);
    if (task.input.providerId === 'mock') fail('IMAGE_REVIEW_NOT_FOUND', 404);
    return validateImageTaskReview(db, projectId, taskId, task.input);
  }
  function capacity(projectId: string): void {
    for (const [where, args, cap] of [['', [], IMAGE_REVIEW_LIMITS.reviewsGlobal], [' WHERE projectId=?', [projectId], IMAGE_REVIEW_LIMITS.reviewsPerProject]] as const) {
      if (Number((db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM image_reviews${where} LIMIT ?)`).get(...args, cap + 1) as {n: number}).n) >= cap) fail('IMAGE_REVIEW_CAPACITY', 507);
    }
  }
  function prepare(raw: unknown): ImageReviewDto | Promise<ImageReviewDto> {
    const input = parse(imageReviewSchemas['image.review.prepare'], raw);
    if (purposeOf(input.input) !== 'edit') return prepareVerified(input);
    const replay = prepareReplay(input); if (replay) return replay;
    return editSources.verify(input.input).then(verified => {editSources.assertCurrent(input.input, verified); return prepareVerified(input, verified);});
  }
  function prepareReplay(input: {input: ImageGenerationInput; settingsRevision: number}): ImageReviewDto | null {
    owner(); project(input.input.projectId);
    const previous = db.prepare(`SELECT ${columns} FROM image_reviews WHERE requestId=? LIMIT 1`).get(input.input.requestId) as ImageReviewRow | undefined;
    if (!previous) return null;
    if (previous.projectId !== input.input.projectId || previous.canonicalInput !== canonical(input.input)) fail('IMAGE_REVIEW_CONFLICT');
    const original = decode(previous); if (original.intent.settingsRevision !== input.settingsRevision) fail('IMAGE_REVIEW_CONFLICT'); return original.dto;
  }
  function prepareVerified(raw: unknown, verified?: {descriptor: unknown; bytes: Buffer}): ImageReviewDto {
    const input = parse(imageReviewSchemas['image.review.prepare'], raw), generation = input.input;
    const canonicalInput = canonical(generation);
    if (Buffer.byteLength(canonicalInput) > IMAGE_LIMITS.inputBytes) fail('IMAGE_REVIEW_CAPACITY', 507);
    return tx(() => {
      owner(); project(generation.projectId);
      const previous = db.prepare(`SELECT ${columns} FROM image_reviews WHERE requestId=? LIMIT 1`).get(generation.requestId) as ImageReviewRow | undefined;
      if (previous) {
        // A conflicting project gets no prompt or other retained review data.
        if (previous.projectId !== generation.projectId || previous.canonicalInput !== canonicalInput) fail('IMAGE_REVIEW_CONFLICT');
        const original = decode(previous);
        if (original.intent.settingsRevision !== input.settingsRevision) fail('IMAGE_REVIEW_CONFLICT');
        return original.dto; // Exact history survives setting changes, restarts, rejection, and dispatch.
      }
      if (db.prepare('SELECT 1 FROM image_requests WHERE requestId=? LIMIT 1').get(generation.requestId) || db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_remote_observations'").get() && db.prepare('SELECT 1 FROM image_remote_observations WHERE requestId=? LIMIT 1').get(generation.requestId)) fail('IMAGE_REVIEW_CONFLICT');
      if (verified) editSources.assertOwned(generation, verified.descriptor);
      const groupId = 'groupId' in generation ? generation.groupId : undefined;
      if (groupId) {const group = createImageOwnershipReader(db, generation.projectId, {fail: invalid}).group(groupId) as {revision: number; activeTaskId: string | null; name: string}; if (verified && (group.revision !== generation.expectedRevision || group.activeTaskId !== null || group.name !== generation.name)) fail('IMAGE_REVIEW_CONFLICT');}
      const selected = settings(input.settingsRevision, generation); capacity(generation.projectId);
      const id = randomUUID(), timestamp = now();
      let execution;
      if (generation.providerId === 'comfy-local') {const seed = randomInt(0, 2 ** 48 - 1), promptId = randomUUID(), clientId = randomUUID(), outputNonce = randomUUID(); const graph = buildComfyWorkflow({prompt: generation.prompt, checkpoint: generation.model, seed, outputNonce}); execution = {workflowId: COMFY_IMAGE_PROFILE_ID, workflowVersion: 1 as const, comfyVersion: COMFY_IMAGE_VERSION, seed, promptId, clientId, outputNonce, filenamePrefix: `mioon_${outputNonce}`, graphHash: hashComfyWorkflow(graph), graph};}
      const intent: Record<string, unknown> = {schemaVersion: purposeOf(generation) === 'edit' ? 4 : generation.providerId === 'comfy-local' ? 3 : generation.providerId === 'openai-compatible' ? 2 : 1, reviewId: id, input: generation, settingsRevision: input.settingsRevision,
        ...(verified ? {sourceImage: verified.descriptor} : {}), destination: selected.destination, policy: generation.providerId === 'comfy-local' ? COMFY_IMAGE_POLICY : IMAGE_REVIEW_POLICY,
        ...(['openai-compatible', 'comfy-local'].includes(generation.providerId) ? {configuration: selected.configuration} : {}), ...(execution ? {execution} : {})};
      if (!imageReviewIntentSchema.safeParse(intent).success) invalid();
      const canonicalIntent = canonical(intent);
      if (Buffer.byteLength(canonicalIntent) > IMAGE_REVIEW_LIMITS.intentBytes) fail('IMAGE_REVIEW_CAPACITY', 507);
      db.prepare(`INSERT INTO image_reviews(id,projectId,requestId,inputHash,canonicalInput,intentHash,canonicalIntent,state,revision,taskId,postAttempts,createdAt,updatedAt,approvedAt,rejectedAt,dispatchedAt)
        VALUES(?,?,?,?,?,?,?,'pending',1,NULL,0,?,?,NULL,NULL,NULL)`).run(id, generation.projectId, generation.requestId, digest(canonicalInput), canonicalInput, digest(canonicalIntent), canonicalIntent, timestamp, timestamp);
      synchronous(fault, 'after_review_prepare', {reviewId: id});
      return review(generation.projectId, id).dto;
    });
  }
  function readForApproval(raw: unknown) {
    const approval = parse(imageReviewApprovalSchema, raw);
    // Reading pending intent is never approval. The image acceptance transaction
    // does all fresh CAS/settings checks; accepted exact replay is checked first.
    return structuredClone(review(approval.projectId, approval.reviewId).dto.input);
  }
  function matchingReview(input: ImageGenerationInput, rawApproval: unknown) {
    const approval = parse(imageReviewApprovalSchema, rawApproval);
    if (approval.projectId !== input.projectId) fail('IMAGE_REVIEW_REQUIRED', 403);
    const value = review(input.projectId, approval.reviewId);
    if (canonical(input) !== value.row.canonicalInput || digest(canonical(input)) !== value.row.inputHash) fail('IMAGE_REVIEW_CONFLICT');
    return {approval, value};
  }
  function verifyReplay(input: ImageGenerationInput, taskId: string, rawApproval: unknown): true {
    const {approval, value} = matchingReview(input, rawApproval);
    if (!['approved', 'dispatched'].includes(value.row.state) || value.row.taskId !== taskId || approval.expectedRevision !== 1) fail('IMAGE_REVIEW_REQUIRED', 403);
    boundTask(value, taskId);
    return true;
  }
  function sourceForApproval(raw: unknown) {
    const approval = parse(imageReviewApprovalSchema, raw);
    const intent = review(approval.projectId, approval.reviewId).intent;
    if (!('sourceImage' in intent)) invalid();
    return structuredClone(intent.sourceImage);
  }
  function authorizeAcceptance(input: ImageGenerationInput, taskId: string, rawApproval: unknown, verified?: {descriptor: unknown}): true {
    transactionRequired();
    const {approval, value} = matchingReview(input, rawApproval);
    if (value.row.revision !== approval.expectedRevision) fail('IMAGE_REVIEW_REVISION_CONFLICT');
    if (value.row.state !== 'pending' || value.row.taskId !== null || value.row.postAttempts !== 0) fail('IMAGE_REVIEW_STATE_CONFLICT');
    settings(value.intent.settingsRevision, input, value.intent);
    if (purposeOf(input) === 'edit') {if (!verified || canonical(verified.descriptor) !== canonical('sourceImage' in value.intent ? value.intent.sourceImage : undefined)) fail('IMAGE_REVIEW_CONFLICT'); if ('sourceImage' in value.intent) editSources.assertOwned(input, value.intent.sourceImage);}
    const task = boundTask(value, taskId);
    if (task.row.state !== 'queued' || task.row.revision !== 1 || task.dto.dispatched) fail('IMAGE_REVIEW_STATE_CONFLICT');
    const timestamp = now();
    const result = db.prepare("UPDATE image_reviews SET state='approved',revision=2,taskId=?,approvedAt=?,updatedAt=? WHERE id=? AND projectId=? AND revision=1 AND state='pending'")
      .run(taskId, timestamp, timestamp, value.row.id, value.row.projectId);
    if (result.changes !== 1) fail('IMAGE_REVIEW_REVISION_CONFLICT');
    synchronous(fault, 'after_review_reservation', {reviewId: value.row.id, taskId});
    return true;
  }
  function beforeDispatch(input: ImageGenerationInput, taskId: string): true {
    transactionRequired(); project(input.projectId);
    const row = db.prepare(`SELECT ${columns} FROM image_reviews WHERE requestId=? AND projectId=? LIMIT 1`).get(input.requestId, input.projectId) as ImageReviewRow | undefined;
    if (!row) fail('IMAGE_REVIEW_REQUIRED', 403);
    const value = decode(row);
    if (canonical(input) !== value.row.canonicalInput || value.row.taskId !== taskId) fail('IMAGE_REVIEW_CONFLICT');
    if (value.row.state !== 'approved' || value.row.postAttempts !== 0) fail('IMAGE_REVIEW_STATE_CONFLICT');
    settings(value.intent.settingsRevision, input, value.intent);
    if (purposeOf(input) === 'edit' && 'sourceImage' in value.intent) editSources.assertOwned(input, value.intent.sourceImage);
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
  function reject(raw: unknown): ImageReviewDto {
    const input = parse(imageReviewRejectionSchema, raw);
    return tx(() => {
      owner(); const value = review(input.projectId, input.reviewId, {verifySource: false});
      // A repeated exact pending-review rejection has no additional effect.
      if (value.row.state === 'rejected' && input.expectedRevision === 1) return value.dto;
      if (value.row.revision !== input.expectedRevision) fail('IMAGE_REVIEW_REVISION_CONFLICT');
      if (value.row.state !== 'pending') fail('IMAGE_REVIEW_STATE_CONFLICT');
      const timestamp = now();
      const result = db.prepare("UPDATE image_reviews SET state='rejected',revision=2,rejectedAt=?,updatedAt=? WHERE id=? AND projectId=? AND revision=1 AND state='pending'")
        .run(timestamp, timestamp, input.reviewId, input.projectId);
      if (result.changes !== 1) fail('IMAGE_REVIEW_REVISION_CONFLICT');
      synchronous(fault, 'after_review_rejection', {reviewId: input.reviewId});
      return review(input.projectId, input.reviewId, {verifySource: false}).dto;
    });
  }
  const sign = (body: string): string => createHmac('sha256', cursorSecret).update(body).digest('base64url');
  function list(input: ReturnType<(typeof imageReviewSchemas)['image.review.list']['parse']>) {
    project(input.projectId);
    const limit = input.limit ?? IMAGE_REVIEW_LIMITS.pageSize, scope = ['image.review.list', input.projectId, limit];
    let after: [string, string] | null = null;
    if (input.cursor) {
      try {
        const [body, mac, ...rest] = input.cursor.split('.');
        if (rest.length || !body || mac?.length !== 43 || !timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) throw new Error();
        const decoded: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 4 || canonical(decoded.slice(0, 3)) !== canonical(scope)) throw new Error();
        const cursor = decoded[3];
        if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || cursor[0].length > 40 || !Number.isFinite(Date.parse(cursor[0])) || !/^[a-f0-9-]{36}$/i.test(cursor[1])) throw new Error();
        after = [cursor[0], cursor[1]];
      } catch {throw new AppError('INVALID_CURSOR', 'The image review cursor is invalid or expired.', 400);}
    }
    const args = after ? [input.projectId, after[0], after[0], after[1], limit + 1] : [input.projectId, limit + 1];
    const rows = db.prepare(`SELECT ${columns} FROM image_reviews WHERE projectId=?${after ? ' AND (createdAt<? OR (createdAt=? AND id<?))' : ''} ORDER BY createdAt DESC,id DESC LIMIT ?`).all(...args) as unknown as ImageReviewRow[];
    const selected = rows.slice(0, limit), items = selected.map(row => decode(row).dto);
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const last = selected.at(-1)!, body = Buffer.from(JSON.stringify([...scope, [last.createdAt, last.id]])).toString('base64url');
      nextCursor = `${body}.${sign(body)}`;
    }
    return {projectId: input.projectId, items, nextCursor};
  }
  function snapshotRead<A extends readonly unknown[], R>(read: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const outer = db.isTransaction;
      if (!outer) db.exec('BEGIN DEFERRED');
      try {return read(...args);} finally {if (!outer && db.isTransaction) db.exec('COMMIT');}
    };
  }
  const handlers = Object.freeze({
    'image.review.prepare': prepare,
    'image.review.get': snapshotRead((raw: unknown) => {const input = parse(imageReviewSchemas['image.review.get'], raw); return review(input.projectId, input.reviewId).dto;}),
    'image.review.list': snapshotRead((raw: unknown) => list(parse(imageReviewSchemas['image.review.list'], raw))),
  });
  return Object.freeze({handlers, readForApproval: snapshotRead(readForApproval), authorizeAcceptance, verifyReplay: snapshotRead(verifyReplay),
    getForTask: snapshotRead(getForTask), sourceForApproval: snapshotRead(sourceForApproval), beforeDispatch, reject, stop() {stopped = true;}});
}
function purposeOf(generation: ImageGenerationInput): 'edit' | undefined { return 'purpose' in generation ? generation.purpose : undefined; }
