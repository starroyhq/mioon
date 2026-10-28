import type {ImageReviewResponse, SubjectVariantBatch, SubjectVariantSpec} from '@mioon/contracts';
import type {SubjectBindingResponse, SubjectResponse, SubjectVersionResponse} from '../packages/contracts/src/subjects.ts';
import type {SubjectVariantController, SubjectVariantDraft, SubjectVariantOptions, SubjectVariantState} from '../apps/web/src/subject-variant-state.ts';
import type {ElementNode, ElementTree, HookSlot} from './helpers/strict-timeline-audio-harness-types.ts';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {transformSync} from 'esbuild';
import * as contracts from '@mioon/contracts';
import * as i18nIndex from '../packages/i18n/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import * as subjectState from '../apps/web/src/subject-state.ts';
import * as variantState from '../apps/web/src/subject-variant-state.ts';
import {ApiError} from '../apps/web/src/api.ts';
import {i18nTestModule, translate} from './helpers/i18n.ts';

type Row = Record<string, unknown>;
type Call = {kind: 'read' | 'write' | 'image'; operation: string; input: Row};
type Wrap = (operation: string, input: Row, next: () => Promise<unknown>) => Promise<unknown>;
const zh = (key: string, params: Record<string, string | number> = {}): string => translate('zh-Hans', key as never, params as never);
const angle = (position: string, focal = 'standard'): SubjectVariantSpec => ({kind: 'angle', position, focal} as SubjectVariantSpec);
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const flush = async (): Promise<void> => { for (let index = 0; index < 25; index++) await Promise.resolve(); };
const settle = async (): Promise<void> => { for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve)); };
const defer = <T = unknown>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise, resolve}; };

// ---- Controller against the real business services (mock provider) ----

async function services(t: TestContext, {autoRun = true}: {autoRun?: boolean} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-subject-variants-ui-'));
  const store = openStore(root), service = createServices(store, new Map(), {imageOptions: {autoRun}});
  const call = <T = Row>(operation: string, input: unknown): Promise<T> => service.call(operation, input) as Promise<T>;
  // The browser sees JSON over HTTP, and a refusal as an ApiError with its status and details.
  const wire = async (operation: string, input: unknown): Promise<unknown> => {
    try { return JSON.parse(JSON.stringify(await call(operation, input))); }
    catch (error) { const failure = error as {message?: string; code?: string; details?: unknown; status?: number}; throw new ApiError(failure.message || 'Refused', failure.code, failure.details === undefined ? undefined : JSON.parse(JSON.stringify(failure.details)), (failure.status ?? 500) < 500, failure.status); }
  };
  const project = await call<{id: string}>('project.create', {name: 'Subject variants UI'}), projectId = project.id;
  async function asset(): Promise<{id: string; sha256: string; width: number; height: number; sizeBytes: number}> {
    const bytes = await renderMockImagePng({width: 768, height: 1024}), id = randomUUID();
    const value = {id, projectId, name: 'Lin.png', mimeType: 'image/png', provenance: 'user-import', sha256: sha(bytes), width: 768, height: 1024, sizeBytes: bytes.length, relativePath: `media/${id}.png`, url: `/media/${id}`, createdAt: new Date().toISOString()};
    store.put('assets', value); writeFileSync(path.join(root, value.relativePath), bytes, {mode: 0o600});
    return value;
  }
  const source = await asset();
  const subject = await call<SubjectResponse>('subject.create', {projectId, kind: 'character', name: '林夏', assetId: source.id, requestId: randomUUID()});
  t.after(async () => { await service.drain?.(); store.close(); rmSync(root, {recursive: true, force: true}); });
  return {projectId, subject, source, call, wire, asset};
}
type Services = Awaited<ReturnType<typeof services>>;
const draft = (f: Services, items: SubjectVariantSpec[], patch: Partial<SubjectVariantDraft> = {}): SubjectVariantDraft =>
  ({subjectId: f.subject.id, sourceVersionId: f.subject.headVersionId, kind: items[0]!.kind, items, providerId: 'mock', model: contracts.IMAGE_MODELS.mock, ...patch});

function variants(t: TestContext, f: Services, {read, write, image, approve, settings}: {read?: Wrap; write?: Wrap; image?: Wrap; approve?: SubjectVariantOptions['approve']; settings?: SubjectVariantOptions['settings']} = {}) {
  const calls: Call[] = [], changes: {subjectId: string; hidden: string[]}[] = [];
  let serial = 0;
  const through = (kind: Call['kind'], wrap?: Wrap) => (operation: string, input: Row): Promise<unknown> => {
    calls.push({kind, operation, input});
    return wrap ? wrap(operation, input, () => f.wire(operation, input)) : f.wire(operation, input);
  };
  const controller = variantState.createSubjectVariantController({
    read: through('read', read), write: through('write', write), image: through('image', image),
    approve: approve ?? (async () => assert.fail('A mock batch needs no approval')), settings: settings ?? (async () => ({})),
    requestId: () => `variant-request-${++serial}`,
    onVersions: (subjectId, hidden) => { changes.push({subjectId, hidden: [...hidden]}); },
  });
  // Tests read on their own; polling is covered separately.
  controller.setVisible(false);
  controller.setContext({scope: 'scope-1', projectId: f.projectId});
  t.after(() => controller.dispose());
  const of = (kind: Call['kind']): Call[] => calls.filter(call => call.kind === kind);
  return {controller, calls, changes, writes: () => of('write'), images: () => of('image')};
}
type Variants = ReturnType<typeof variants>;
async function idle(v: Variants): Promise<void> {
  for (let attempt = 0; attempt < 400 && v.controller.getState().busy; attempt++) await pause(5);
  assert.equal(v.controller.getState().busy, null, 'the controller became idle');
}
async function until(read: () => Promise<SubjectVariantBatch | null>, done: (batch: SubjectVariantBatch) => boolean): Promise<SubjectVariantBatch> {
  for (let attempt = 0; attempt < 300; attempt++) { const batch = await read(); if (batch && done(batch)) return batch; await pause(20); }
  throw new Error('The batch did not reach the expected state');
}
const allSucceeded = (batch: SubjectVariantBatch): boolean => batch.items.every(item => item.status === 'succeeded');

test('a batch is recorded once, then each image is submitted in order as its exact edit request', async t => {
  const f = await services(t), v = variants(t, f);
  assert.equal((await v.controller.watch(f.subject.id))?.items.length, 0);
  const batch = await v.controller.create(draft(f, [angle('left'), angle('right', 'wide')]));
  assert.ok(batch);
  assert.deepEqual(v.writes().map(call => [call.operation, call.input]), [['subject.variants.create', {projectId: f.projectId, subjectId: f.subject.id, sourceVersionId: f.subject.headVersionId,
    kind: 'angle', items: [angle('left'), angle('right', 'wide')], providerId: 'mock', model: contracts.IMAGE_MODELS.mock, requestId: 'variant-request-1'}]]);
  assert.equal(Object.isFrozen(v.writes()[0]!.input), true);
  await idle(v);
  assert.deepEqual(v.images().map(call => [call.operation, call.input]), batch.items.map(item => ['image.generate', item.imageInput]));
  const done = await until(() => v.controller.readBatch(batch.id), allSucceeded);
  assert.ok(v.changes.length > 0 && v.changes.every(change => change.subjectId === f.subject.id && change.hidden.length === 0), 'new versions are reported for the subject');
  const versions = (await f.call<{items: SubjectVersionResponse[]}>('subject.version.list', {projectId: f.projectId, subjectId: f.subject.id})).items;
  assert.deepEqual(versions.filter(version => version.variant).map(version => version.id).sort(), done.items.map(item => item.versionId).sort());
  const subject = (await f.call<{items: SubjectResponse[]}>('subject.list', {projectId: f.projectId})).items[0]!;
  assert.equal(subject.headVersionId, f.subject.headVersionId, 'a variant never becomes the default version');
  const reported = v.changes.length;
  await v.controller.readBatch(batch.id); await v.controller.readSubject(f.subject.id);
  assert.equal(v.changes.length, reported, 'versions already reported are not reported again');
  assert.equal(v.writes().length, 1);
});

test('submission stops at the first image that is not accepted and continues only when asked', async t => {
  const f = await services(t, {autoRun: false});
  let refuse = true;
  const v = variants(t, f, {image: async (_operation, _input, next) => { if (refuse) { refuse = false; throw new ApiError('Queue full', 'IMAGE_QUEUE_FULL', undefined, true, 409); } return next(); }});
  const batch = (await v.controller.create(draft(f, [angle('left'), angle('back'), angle('high')])))!;
  await idle(v);
  assert.equal(v.images().length, 1, 'the second and third images were not submitted');
  assert.deepEqual(v.controller.getState().issues[`${batch.id}:1`], i18nIndex.message('subjects.variants.submit.queueFull'));
  const listed = variantState.shownSubjectVariantBatches(v.controller.getState().lists[f.subject.id], v.controller.getState().live)[0]!;
  assert.deepEqual(listed.items.map(item => item.status), ['pending', 'pending', 'pending']);
  assert.equal(await v.controller.submit(listed), true);
  assert.deepEqual(v.images().slice(1).map(call => call.input.requestId), [1, 2, 3].map(position => contracts.subjectVariantImageRequestId(batch.id, position, 1)));
  assert.deepEqual(v.controller.getState().issues, {});
  const running = (await v.controller.readBatch(batch.id))!;
  assert.deepEqual(running.items.map(item => item.status), ['running', 'running', 'running']);
  assert.equal(await v.controller.submit(running), true, 'nothing is left to submit');
  assert.equal(v.images().length, 4);
});

test('an unconfirmed create holds every write until a read finds the batch, and submits nothing by itself', async t => {
  const f = await services(t, {autoRun: false});
  let lose = true;
  const v = variants(t, f, {write: async (_operation, _input, next) => { const result = await next(); if (lose) { lose = false; throw new ApiError('Lost', 'NETWORK'); } return result; }});
  assert.equal(await v.controller.create(draft(f, [angle('left'), angle('right')])), null);
  let state = v.controller.getState();
  assert.equal(state.pending?.operation, 'subject.variants.create');
  assert.deepEqual(state.notice, i18nIndex.message('subjects.variants.unconfirmed'));
  assert.equal(await v.controller.create(draft(f, [angle('back')])), null);
  assert.equal(v.writes().length, 1); assert.equal(v.images().length, 0);
  assert.equal(await v.controller.reconcile(), true);
  state = v.controller.getState();
  assert.equal(state.pending, null);
  assert.deepEqual(state.notice, i18nIndex.message('subjects.variants.recoveredUnsubmitted'));
  const [batch] = variantState.shownSubjectVariantBatches(state.lists[f.subject.id], state.live);
  assert.equal(batch?.requestId, 'variant-request-1');
  assert.equal(v.images().length, 0, 'a recovered batch waits for an explicit submit');
  assert.equal(await v.controller.submit(batch!), true);
  assert.equal(v.images().length, 2);
});

test('resending an unconfirmed create replays the same batch and then submits its images', async t => {
  const f = await services(t, {autoRun: false});
  let lose = true;
  const v = variants(t, f, {write: async (_operation, _input, next) => { const result = await next(); if (lose) { lose = false; throw new ApiError('Lost', 'NETWORK'); } return result; }});
  await v.controller.create(draft(f, [angle('left'), angle('right')]));
  const batch = await v.controller.resend();
  assert.ok(batch);
  const [first, second] = v.writes();
  assert.equal(second!.input, first!.input, 'the identical frozen request is sent again');
  assert.equal(v.controller.getState().pending, null);
  await idle(v);
  assert.deepEqual(v.images().map(call => call.input.requestId), batch.items.map(item => item.imageInput.requestId));
  const listed = (await f.call<{items: SubjectVariantBatch[]}>('subject.variants.list', {projectId: f.projectId, subjectId: f.subject.id})).items;
  assert.deepEqual(listed.map(item => item.id), [batch.id]);
});

test('a refusal is final only with a proof for this exact request', async t => {
  const f = await services(t), location = await f.asset();
  const scene = await f.call<SubjectResponse>('subject.create', {projectId: f.projectId, kind: 'location', name: '雨夜街口', assetId: location.id, requestId: randomUUID()});
  const proven = variants(t, f);
  assert.equal(await proven.controller.create(draft(f, [angle('left')], {subjectId: scene.id, sourceVersionId: scene.headVersionId})), null);
  assert.equal(proven.controller.getState().pending, null);
  assert.deepEqual(proven.controller.getState().notice, i18nIndex.message('subjects.variants.refused.kind'));
  const tampered = variants(t, f, {write: async (_operation, _input, next) => {
    try { return await next(); } catch (error) {
      const failure = error as ApiError, details = structuredClone(failure.details) as {subjectVariantOutcome: Row};
      details.subjectVariantOutcome.inputHash = sha('another request');
      throw new ApiError(failure.message, failure.code, details, true, failure.status);
    }
  }});
  assert.equal(await tampered.controller.create(draft(f, [angle('left')], {subjectId: scene.id, sourceVersionId: scene.headVersionId})), null);
  assert.equal(tampered.controller.getState().pending?.operation, 'subject.variants.create');
  assert.deepEqual(tampered.controller.getState().notice, i18nIndex.message('subjects.variants.unconfirmed'));
});

test('only a cancelled or refused image can be retried, and the retry submits just that image', async t => {
  const f = await services(t, {autoRun: false}), v = variants(t, f);
  const batch = (await v.controller.create(draft(f, [angle('left'), angle('right')])))!;
  await idle(v);
  const running = (await v.controller.readBatch(batch.id))!;
  assert.deepEqual(running.items.map(item => item.status), ['running', 'running']);
  assert.equal(await v.controller.retry(running, 1), null, 'a moving image cannot be retried');
  await f.call('image.task.cancelQueued', {projectId: f.projectId, taskId: running.items[0]!.image!.taskId, expectedRevision: 1, requestId: randomUUID()});
  const cancelled = (await v.controller.readBatch(batch.id))!;
  assert.equal(cancelled.items[0]!.status, 'cancelled');
  const before = v.images().length, retried = await v.controller.retry(cancelled, 1);
  assert.ok(retried);
  assert.deepEqual(v.writes().at(-1)!.input, {projectId: f.projectId, batchId: batch.id, position: 1, expectedRevision: cancelled.revision, requestId: 'variant-request-2'});
  assert.equal(retried.items[0]!.attempt, 2);
  await idle(v);
  assert.deepEqual(v.images().slice(before).map(call => call.input.requestId), [contracts.subjectVariantImageRequestId(batch.id, 1, 2)]);
});

test('undo needs a live read that allows it; a bound version blocks it and the hidden versions are reported', async t => {
  const f = await services(t), v = variants(t, f);
  const batch = (await v.controller.create(draft(f, [angle('left'), angle('back')])))!;
  await idle(v);
  const done = await until(() => v.controller.readBatch(batch.id), value => allSucceeded(value) && value.undo?.available === true);
  assert.equal(await v.controller.undo(batch), null, 'a receipt does not say whether undo is possible');
  const shot = await f.call<{id: string}>('shot.create', {projectId: f.projectId, title: 'Shot', requestId: randomUUID()});
  const revision = (await f.call<{items: SubjectResponse[]}>('subject.list', {projectId: f.projectId})).items[0]!.revision;
  const bound = await f.call<{revision: number}>('subject.binding.set', {projectId: f.projectId, shotId: shot.id, subjectId: f.subject.id, role: 'subject', subjectVersionId: done.items[0]!.versionId, expectedRevision: 0, expectedSubjectRevision: revision, requestId: randomUUID()});
  const blocked = (await v.controller.readBatch(batch.id))!;
  assert.deepEqual(blocked.undo, {available: false, blockers: [{code: 'BOUND', position: 1, shotId: shot.id}]});
  const writes = v.writes().length;
  assert.equal(await v.controller.undo(blocked), null);
  assert.equal(v.writes().length, writes);
  await f.call('subject.binding.set', {projectId: f.projectId, shotId: shot.id, subjectId: f.subject.id, role: 'subject', subjectVersionId: null, expectedRevision: bound.revision, expectedSubjectRevision: revision, requestId: randomUUID()});
  const open = (await v.controller.readBatch(batch.id))!;
  const undone = await v.controller.undo(open);
  assert.equal(undone?.state, 'undone');
  assert.deepEqual(v.changes.at(-1), {subjectId: f.subject.id, hidden: done.items.map(item => item.versionId!)});
  const versions = (await f.call<{items: SubjectVersionResponse[]}>('subject.version.list', {projectId: f.projectId, subjectId: f.subject.id})).items;
  assert.deepEqual(versions.map(version => version.id), [f.subject.headVersionId]);
  assert.deepEqual(variantState.shownSubjectVariantBatches(v.controller.getState().lists[f.subject.id], v.controller.getState().live), [], 'an undone batch has no row');
});

test('GPT Image items are prepared with the settings revision and approved one at a time', async t => {
  const f = await services(t, {autoRun: false}), order: string[] = [], prepared: Row[] = [];
  const review = (input: Row, settingsRevision: number): ImageReviewResponse => {
    const at = new Date().toISOString();
    return {id: randomUUID(), projectId: input.projectId, requestId: input.requestId, input, inputHash: sha(contracts.canonicalImageInput(input)), settingsRevision,
      destination: contracts.IMAGE_EDIT_REVIEW_DESTINATION, policy: {...contracts.IMAGE_REVIEW_POLICY}, state: 'pending', revision: 1, taskId: null, postAttempts: 0,
      createdAt: at, updatedAt: at, approvedAt: null, rejectedAt: null, dispatchedAt: null,
      sourceImage: {assetId: f.source.id, sha256: f.source.sha256, mimeType: 'image/png', byteLength: f.source.sizeBytes, width: f.source.width, height: f.source.height, name: 'Lin.png', origin: {kind: 'user-import'}}} as unknown as ImageReviewResponse;
  };
  const task = (value: ImageReviewResponse): Row => {
    const input = value.input as Row, at = new Date().toISOString();
    return {id: randomUUID(), projectId: input.projectId, groupId: randomUUID(), requestId: input.requestId, name: input.name, providerId: input.providerId, model: input.model, prompt: input.prompt,
      options: input.options, purpose: 'edit', inputImage: input.inputImage, sourceImage: (value as unknown as Row).sourceImage, state: 'queued', revision: 1, dispatched: false, versionId: null, errorCode: null, createdAt: at, updatedAt: at};
  };
  let failApproval = false;
  // The synthetic review and task must be ones the client accepts; checked
  // after the run because the controller turns any thrown error into an issue.
  const synthetic: [string, boolean][] = [];
  const v = variants(t, f, {
    settings: async () => ({revision: 7, configuration: {enabled: true}, secret: {configured: true}}),
    image: async (operation, input) => {
      prepared.push(input); order.push(`${operation === 'image.review.prepare' ? 'prepare' : operation}:${(input.input as Row).requestId}`);
      const value = review(input.input as Row, input.settingsRevision as number);
      synthetic.push(['review', contracts.isImageReviewPreparationResponse(input, value) && contracts.isImageReviewResponse(value)]);
      return value;
    },
    approve: async value => {
      order.push(`approve:${value.requestId}`);
      if (failApproval) throw new ApiError('Lost', 'NETWORK');
      const result = task(value);
      synthetic.push(['task', contracts.isImageMutationResponse('image.generate', value.input, result)]);
      return result;
    },
  });
  const batch = (await v.controller.create(draft(f, [angle('left'), angle('right')], {providerId: 'openai', model: contracts.IMAGE_MODELS.openai})))!;
  await idle(v);
  assert.deepEqual(synthetic, [['review', true], ['task', true], ['review', true], ['task', true]]);
  const ids = batch.items.map(item => item.imageInput.requestId as string);
  assert.deepEqual(order, [`prepare:${ids[0]}`, `approve:${ids[0]}`, `prepare:${ids[1]}`, `approve:${ids[1]}`]);
  assert.deepEqual(v.controller.getState().issues, {});
  assert.deepEqual(prepared, batch.items.map(item => ({input: item.imageInput, settingsRevision: 7})));
  // An unconfirmed approval stops the batch; nothing is resent on its own.
  order.length = 0; failApproval = true;
  const second = (await v.controller.create(draft(f, [angle('back'), angle('high')], {providerId: 'openai', model: contracts.IMAGE_MODELS.openai})))!;
  await idle(v);
  const next = second.items.map(item => item.imageInput.requestId as string);
  assert.deepEqual(order, [`prepare:${next[0]}`, `approve:${next[0]}`]);
  assert.deepEqual(v.controller.getState().issues[`${second.id}:1`], i18nIndex.message('subjects.variants.submit.unknown'));
});

test('without a connected GPT Image nothing is prepared and the first image says why', async t => {
  const f = await services(t, {autoRun: false});
  const v = variants(t, f, {settings: async () => ({revision: 7, configuration: {enabled: false}, secret: {configured: true}}), image: async () => assert.fail('Nothing is prepared')});
  const batch = (await v.controller.create(draft(f, [angle('left')], {providerId: 'openai', model: contracts.IMAGE_MODELS.openai})))!;
  await idle(v);
  assert.equal(v.images().length, 0);
  assert.deepEqual(v.controller.getState().issues[`${batch.id}:1`], i18nIndex.message('subjects.variants.submit.settings'));
});

test('an answer for an earlier project is ignored and starts nothing', async t => {
  const f = await services(t), hold = defer<void>();
  const v = variants(t, f, {write: async (_operation, _input, next) => { await hold.promise; return next(); }});
  const writing = v.controller.create(draft(f, [angle('left')]));
  v.controller.setContext({scope: 'scope-2', projectId: randomUUID()});
  hold.resolve();
  assert.equal(await writing, null);
  await settle();
  assert.equal(v.images().length, 0);
  assert.deepEqual(v.controller.getState().lists, {});
  assert.equal(v.controller.getState().busy, null);
});

test('the shown subject is polled only while its images move and the pane is visible', async t => {
  const f = await services(t, {autoRun: false}), v = variants(t, f);
  await v.controller.create(draft(f, [angle('left')]));
  await idle(v);
  t.mock.timers.enable({apis: ['setTimeout']});
  v.controller.setVisible(true);
  await v.controller.watch(f.subject.id);
  const polls = (): number => v.calls.filter(call => call.operation === 'subject.variants.get').length, before = polls();
  t.mock.timers.tick(variantState.SUBJECT_VARIANT_POLL_MS - 1); await settle();
  assert.equal(polls(), before);
  t.mock.timers.tick(1); await settle();
  assert.equal(polls(), before + 1);
  v.controller.setVisible(false);
  t.mock.timers.tick(variantState.SUBJECT_VARIANT_POLL_MS * 4); await settle();
  assert.equal(polls(), before + 1, 'a hidden pane polls nothing');
  v.controller.setVisible(true);
  t.mock.timers.tick(variantState.SUBJECT_VARIANT_POLL_MS); await settle();
  assert.equal(polls(), before + 2);
  v.controller.watch(null);
  t.mock.timers.tick(variantState.SUBJECT_VARIANT_POLL_MS * 4); await settle();
  assert.equal(polls(), before + 2, 'an unwatched subject is not polled');
});

// ---- Pure helpers ----

const id = (kind: number, n = 1): string => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), shotId = id(2), subjectId = id(3), versionId = (n: number): string => id(5, n), batchId = id(7);
const date = '2026-10-27T09:00:00.000Z';
const imageInfo = (n: number, patch: Row = {}): Row => ({id: id(4, n), projectId, name: `Image ${n}`, mimeType: 'image/jpeg', sizeBytes: 4096, ...patch});
const versionOf = (number: number, patch: Row = {}): SubjectVersionResponse => ({id: versionId(number), projectId, subjectId, number, assetId: id(4, number), sha256: 'a'.repeat(64), mimeType: 'image/jpeg', width: 1024, height: 1536,
  provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}, createdAt: date, ...patch}) as unknown as SubjectVersionResponse;
const variantOf = (position: string, focal = 'standard'): Row => ({kind: 'angle', position, focal, batchId, sourceVersionId: versionId(1)});
const subjectOf = (kind: string, revision: number): SubjectResponse => ({id: subjectId, projectId, kind, name: '林夏', revision, headVersionId: versionId(1), headVersion: versionOf(1), createdAt: date, updatedAt: date}) as unknown as SubjectResponse;
const itemOf = (position: number, spec: Row, status: string, patch: Row = {}): Row => ({position, spec, attempt: 1, imageInput: {requestId: `subject-variant:${batchId}:${position}:1`}, versionId: null,
  image: status === 'pending' ? null : {taskId: id(8, position), state: status === 'running' ? 'dispatching' : status === 'cancelled' ? 'cancelled_before_dispatch' : 'failed', dispatched: status !== 'cancelled', errorCode: null}, status, ...patch});
const batchOf = (patch: Row = {}): SubjectVariantBatch => ({id: batchId, projectId, subjectId, sourceVersionId: versionId(1), kind: 'angle', requestId: 'variant-request-1', providerId: 'mock', model: contracts.IMAGE_MODELS.mock,
  size: '1024x1536', state: 'active', revision: 1, items: [itemOf(1, angle('left'), 'succeeded', {versionId: versionId(2)})], undo: null, createdAt: date, updatedAt: date, ...patch}) as unknown as SubjectVariantBatch;
const listOf = (...items: SubjectVariantBatch[]): variantState.SubjectVariantList => ({phase: 'ready', items, error: null});

test('a subject shows its newest batch and any unfinished one, at most three', () => {
  const batch = (n: number, status: string, patch: Row = {}): SubjectVariantBatch => batchOf({id: id(7, n), items: [itemOf(1, angle('left'), status, status === 'succeeded' ? {versionId: versionId(n)} : {})], ...patch});
  const newest = batch(1, 'succeeded'), moving = batch(2, 'running'), undone = batch(3, 'undone', {state: 'undone'}), old = batch(4, 'succeeded'), failed = batch(5, 'failed'), waiting = batch(6, 'pending');
  assert.deepEqual(variantState.shownSubjectVariantBatches(listOf(newest, moving, undone, old, failed, waiting)).map(item => item.id), [newest.id, moving.id, failed.id]);
  assert.deepEqual(variantState.shownSubjectVariantBatches(listOf(undone, old)).map(item => item.id), [old.id], 'an undone batch is never the newest row');
  const live = {...moving, revision: 2, undo: {available: false, blockers: [{code: 'IN_PROGRESS', position: 1}]}} as unknown as SubjectVariantBatch;
  assert.equal(variantState.shownSubjectVariantBatches(listOf(newest, moving), {[moving.id]: live})[1], live, 'a live read at least as new wins');
  assert.equal(variantState.shownSubjectVariantBatches(listOf(newest, live), {[moving.id]: moving})[1], live, 'an older live read loses');
  const finished = {...moving, items: [itemOf(1, angle('left'), 'succeeded', {versionId: versionId(9)})]} as unknown as SubjectVariantBatch;
  assert.deepEqual(variantState.shownSubjectVariantBatches(listOf(newest, moving), {[moving.id]: finished}).map(item => item.id), [newest.id], 'a batch that finished leaves the rows');
  const mixed = batchOf({items: [itemOf(1, angle('left'), 'succeeded', {versionId: versionId(2)}), itemOf(2, angle('right'), 'running'), itemOf(3, angle('back'), 'pending'), itemOf(4, angle('high'), 'failed'),
    itemOf(5, angle('low'), 'cancelled'), itemOf(6, angle('front'), 'unknown'), itemOf(7, angle('back-left'), 'recoverable'), itemOf(8, angle('back-right'), 'interrupted')]});
  assert.deepEqual(variantState.subjectVariantProgress(mixed), {total: 8, done: 1, running: 1, pending: 1, failed: 2, unknown: 3});
  assert.deepEqual(mixed.items.filter(variantState.subjectVariantRetryable).map(item => item.position), [4, 5]);
  assert.deepEqual(mixed.items.filter(variantState.subjectVariantUnsubmitted).map(item => item.position), [3]);
});

test('GPT Image needs an enabled connection with a saved key, and outputs follow the source ratio', () => {
  const [openai, mock] = variantState.subjectVariantModels(null);
  assert.deepEqual([openai!.available, mock!.available, mock!.paid, openai!.paid], [false, true, false, true]);
  assert.deepEqual(variantState.subjectVariantModels({revision: 4, configuration: {enabled: true}, secret: {configured: true}})[0], {providerId: 'openai', model: contracts.IMAGE_MODELS.openai, available: true, paid: true, settingsRevision: 4});
  for (const settings of [{revision: 4, configuration: {enabled: false}, secret: {configured: true}}, {revision: 4, configuration: {enabled: true}, secret: {configured: false}}, {configuration: {enabled: true}, secret: {configured: true}}])
    assert.equal(variantState.subjectVariantModels(settings)[0]!.available, false);
  assert.equal(variantState.subjectVariantOutputSize({width: 1024, height: 1536}, 'mock'), '1024x1536');
  assert.equal(variantState.subjectVariantOutputSize({width: 768, height: 1024}, 'openai'), '1152x1536');
  assert.equal(variantState.subjectVariantOutputSize({width: 4000, height: 100}, 'mock'), '1536x512', 'extreme ratios are clamped to 3:1');
  const source = versionOf(1, {mimeType: 'image/png'}), asset = imageInfo(1);
  assert.equal(variantState.subjectVariantSourceIssue(source, asset, 'mock'), null);
  assert.equal(variantState.subjectVariantSourceIssue(versionOf(1, {provenance: {kind: 'export', versionId: null, shotId: null, jobId: null}}), asset, 'mock'), 'origin');
  assert.equal(variantState.subjectVariantSourceIssue(versionOf(1, {provenance: {kind: 'generated', versionId: id(9), shotId: id(9, 2), jobId: id(9, 3)}}), asset, 'mock'), 'origin', 'a video result cannot be edited');
  assert.equal(variantState.subjectVariantSourceIssue(source, imageInfo(1, {sizeBytes: 60 * 1024 * 1024}), 'openai'), 'bytes');
  assert.equal(variantState.subjectVariantSourceIssue(versionOf(1, {width: 5000}), asset, 'mock'), 'dimensions');
  assert.equal(variantState.subjectVariantSourceIssue(source, imageInfo(2), 'mock'), 'missing');
  assert.equal(variantState.subjectVariantSourceIssue(source, null, 'mock'), 'missing');
});

test('shot filters group variants by camera then light, standard before wide', () => {
  const versions = [versionOf(1), versionOf(2, {variant: variantOf('back')}), versionOf(3, {variant: variantOf('right', 'wide')}), versionOf(4, {variant: variantOf('front-left')}),
    versionOf(5, {variant: {kind: 'light', azimuth: 45, elevation: 30, quality: 'back', kelvin: 4800, batchId, sourceVersionId: versionId(1)}}), versionOf(6, {variant: variantOf('right')}), versionOf(7, {variant: variantOf('back')})];
  assert.deepEqual(subjectState.subjectVariantFilters(versions).map(item => item.key), ['angle:front-left:standard', 'angle:right:standard', 'angle:right:wide', 'angle:back:standard', 'light:back']);
  assert.equal(subjectState.subjectVariantKey(undefined), null);
});

// ---- Components ----

const nodes = (value: ElementTree): ElementNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const deep = (value: ElementTree): ElementNode[] => nodes(value).flatMap(node => [node, ...(node.props?.actions ? deep(node.props.actions as ElementTree) : [])]);
const byId = (tree: ElementTree, testId: string): ElementNode | undefined => deep(tree).find(node => node.props?.['data-testid'] === testId);
const byType = (tree: ElementTree, type: string): ElementNode[] => deep(tree).filter(node => node.type === type);
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ElementNode).props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const click = (node: ElementNode | undefined): unknown => { assert.ok(node, 'the control exists'); return (node.props.onClick as () => unknown)(); };

function harness(file: string) {
  const slots: HookSlot[] = [];
  let cursor = 0, effects: number[] = [];
  const h = {visible: true, answer: true, confirmations: [] as unknown[]};
  const react = {
    Fragment: 'Fragment',
    createElement: (type: unknown, props: Row | null, ...children: ElementTree[]) => ({type, props: {...props, children}}),
    useRef: (value: unknown) => { const index = cursor++; return slots[index] ||= {current: value}; },
    useState: (value: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = {value: typeof value === 'function' ? (value as () => unknown)() : value}; const slot = slots[index]!; return [slot.value, (next: unknown) => { slot.value = typeof next === 'function' ? (next as (value: unknown) => unknown)(slot.value) : next; }]; },
    useMemo: (fn: () => unknown, deps: readonly unknown[]) => { const index = cursor++; if (!slots[index] || deps.some((value, at) => value !== slots[index]!.deps![at])) slots[index] = {value: fn(), deps}; return slots[index]!.value; },
    useLayoutEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const index = cursor++; if (!slots[index] || deps.some((value, at) => value !== slots[index]!.deps![at])) { slots[index] = {fn, deps, cleanup: slots[index]?.cleanup}; effects.push(index); } },
    useEffect: () => { cursor++; },
  };
  const modules: Record<string, Row> = {};
  function load(name: string): Row {
    if (modules[name]) return modules[name]!;
    const source = readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8'), module = {exports: {} as Row};
    const code = transformSync(source, {loader: name.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs'}).code;
    Function('require', 'module', 'exports', code)((request: string) => {
      if (request === 'react') return {...react, default: react};
      if (request === './i18n/I18nProvider.tsx') return {useI18n: () => i18nTestModule('zh-Hans').useI18n()};
      if (request.endsWith('subject-variant-state.ts')) return variantState;
      if (request.endsWith('subject-state.ts')) return subjectState;
      if (request.endsWith('packages/i18n/src/index.ts')) return i18nIndex;
      if (request === '@mioon/contracts') return contracts;
      if (request === '@mioon/ui/components/workbench-confirm') return {useConfirmation: () => async (value: unknown) => { h.confirmations.push(value); return h.answer; }};
      if (request.endsWith('workspace-visibility.tsx')) return {useWorkspaceVisibility: () => h.visible};
      if (request.endsWith('use-subjects.ts')) return load('use-subjects.ts');
      if (request === './api.ts') return {assetUrl: (asset: {id: unknown}) => `/media/${String(asset.id)}`};
      if (['./SubjectVariantDialog.tsx', './BoardInspectorGroup.tsx', './AgentEditingBoundary.tsx'].includes(request)) return {__esModule: true, default: request.slice(2, -4)};
      return new Proxy({}, {get: (_, key) => String(key)});
    }, module, module.exports);
    return modules[name] = module.exports;
  }
  const component = load(file);
  const render = (props: Row, name = 'default'): ElementTree => {
    cursor = 0; effects = [];
    const tree = (component[name] as (props: Row) => ElementTree)(props);
    for (const index of effects) { const slot = slots[index]!; if (typeof slot.cleanup === 'function') slot.cleanup(); slot.cleanup = slot.fn!(); }
    return tree;
  };
  return {h, module: component, render};
}

function fakeVariants(patch: Partial<SubjectVariantState> = {}) {
  const calls: unknown[][] = [];
  const state: SubjectVariantState = {scope: `${projectId}:1`, projectId, lists: {}, live: {}, busy: null, pending: null, notice: null, issues: {}, ...patch};
  const record = (name: string) => (...args: unknown[]): Promise<null> => { calls.push([name, ...args]); return Promise.resolve(null); };
  const controller = {getState: () => state, watch: record('watch'), setVisible: record('setVisible'), readBatch: record('readBatch'), readSubject: record('readSubject'),
    readSettings: async () => variantState.subjectVariantModels(null), create: record('create'), submit: record('submit'), retry: record('retry'), undo: record('undo'),
    reconcile: record('reconcile'), resend: record('resend'), clearNotice: record('clearNotice'), setContext: record('setContext'), dispose: record('dispose')} as unknown as SubjectVariantController;
  return {state, controller, calls, named: (name: string) => calls.filter(call => call[0] === name)};
}
async function subjectsFor(kind: string, versions: SubjectVersionResponse[], bindings: SubjectBindingResponse[] = []) {
  const controller = subjectState.createSubjectController({
    read: async (operation: string) => ({projectId, items: operation === 'subject.list' ? [subjectOf(kind, versions.length)] : operation === 'subject.version.list' ? versions : bindings, nextCursor: null}),
    save: async () => null,
  });
  controller.setContext({scope: `${projectId}:1`, projectId, assets: versions.map(version => imageInfo(version.number)), shotIds: [shotId]});
  await flush();
  controller.selectSubject(subjectId);
  await flush();
  return controller;
}
const admit = (action: () => unknown): unknown => action();

test('the dialog builds one camera batch from the chosen source and confirms it once', async () => {
  const {h, render} = harness('SubjectVariantDialog.tsx');
  const fake = fakeVariants(), versions = [versionOf(1), versionOf(2, {variant: variantOf('left')})];
  let closed = 0;
  const props = {subject: subjectOf('character', 2), versions, initialSourceId: versionId(1), assets: [imageInfo(1), imageInfo(2)], controller: fake.controller, blocked: false, notice: null, onClose: () => { closed++; }};
  let tree = render(props);
  assert.equal(text(byId(tree, 'subject-variant-source-check')), `JPEG · 1024×1536 · ${zh('subjects.variants.sourceUsable')}`);
  assert.match(text(tree), /每张 1024×1536，跟随源图比例 · 不会成为默认版本/);
  assert.equal(byId(tree, 'subject-variant-generate')!.props.disabled, true, 'nothing is chosen yet');
  assert.match(text(byId(tree, 'subject-variant-position-left')), /已有/);
  click(byId(tree, 'subject-variant-position-left'));
  tree = render(props); click(byId(tree, 'subject-variant-position-front-right'));
  tree = render(props);
  assert.match(text(tree), /左 · 广角/, 'a position already shot at standard takes the wide lens');
  assert.equal(text(byId(tree, 'subject-variant-generate')), '生成 2 张');
  assert.match(text(tree), /会产生费用|模拟服务不产生费用/);
  click(byId(tree, 'subject-variant-generate')); await flush();
  assert.deepEqual(h.confirmations, [i18nIndex.message('subjects.variants.confirmMock', {count: 2, name: '林夏'})]);
  assert.deepEqual(fake.named('create').map(call => call[1]), [{subjectId, sourceVersionId: versionId(1), kind: 'angle', items: [angle('left', 'wide'), angle('front-right')], providerId: 'mock', model: contracts.IMAGE_MODELS.mock}]);
  assert.equal(closed, 0, 'an unrecorded batch keeps the dialog open');
  (fake.controller as unknown as {create: () => Promise<SubjectVariantBatch>}).create = async () => batchOf();
  tree = render(props); click(byId(tree, 'subject-variant-generate')); await flush();
  assert.equal(closed, 1);
  h.answer = false;
  tree = render(props); click(byId(tree, 'subject-variant-generate')); await flush();
  assert.equal(closed, 1, 'a declined confirmation records nothing');
});

test('the dialog explains an unusable source and makes lighting one image', async () => {
  const {render} = harness('SubjectVariantDialog.tsx');
  const fake = fakeVariants(), exported = versionOf(1, {provenance: {kind: 'export', versionId: null, shotId: null, jobId: null}});
  const props = {subject: subjectOf('product', 1), versions: [exported], initialSourceId: versionId(1), assets: [imageInfo(1)], controller: fake.controller, blocked: false, onClose: () => {}};
  let tree = render(props);
  assert.match(text(byId(tree, 'subject-variant-source-issue')), /不能用于图片编辑.*视频生成结果和导出素材不能用于图片编辑/);
  click(byId(tree, 'subject-variant-position-back'));
  tree = render(props);
  assert.equal(byId(tree, 'subject-variant-generate')!.props.disabled, true);
  assert.match(text(tree), /源图不可用，换一张后才能生成/);
  const usable = harness('SubjectVariantDialog.tsx'), light = {...props, versions: [versionOf(1)]};
  tree = usable.render(light);
  const tabs = deep(tree).find(node => node.props?.label === zh('subjects.variants.tabs'))!;
  (tabs.props.onValueChange as (value: string) => void)('light');
  tree = usable.render(light);
  assert.equal(text(byId(tree, 'subject-variant-generate')), '生成');
  (byId(tree, 'subject-variant-azimuth')!.props.onChange as (event: unknown) => void)({target: {value: '200'}});
  tree = usable.render(light);
  assert.equal(byId(tree, 'subject-variant-azimuth')!.props.value, 180, 'the azimuth is clamped to the sphere');
  click(byId(tree, 'subject-variant-generate')); await flush();
  assert.deepEqual(usable.h.confirmations, [i18nIndex.message('subjects.variants.confirmMock', {count: 1, name: '林夏'})]);
  assert.deepEqual(fake.named('create').at(-1)?.[1], {subjectId, sourceVersionId: versionId(1), kind: 'light', items: [{kind: 'light', azimuth: 180, elevation: 30, quality: 'soft', kelvin: 4800}], providerId: 'mock', model: contracts.IMAGE_MODELS.mock});
});

test('camera choices keep at most eight positions and the light sphere maps back to its angles', () => {
  const {module} = harness('SubjectVariantDialog.tsx');
  type Choice = {position: string; focal: string};
  const toggle = module.toggleAngle as (choices: readonly Choice[], position: string, existing: ReadonlyMap<string, ReadonlySet<string>>) => Choice[];
  const existing = new Map([['left', new Set(['standard'])], ['back', new Set(['standard', 'wide'])]]);
  let choices = toggle([], 'left', existing);
  assert.deepEqual(choices, [{position: 'left', focal: 'wide'}]);
  choices = toggle(choices, 'back', existing);
  assert.deepEqual(choices.at(-1), {position: 'back', focal: 'standard'});
  assert.deepEqual(toggle(choices, 'left', existing), [{position: 'back', focal: 'standard'}]);
  for (const position of ['front', 'front-left', 'front-right', 'right', 'back-left', 'back-right']) choices = toggle(choices, position, existing);
  assert.equal(choices.length, 8);
  assert.equal(toggle(choices, 'high', existing).length, 8, 'a batch has at most eight images');
  assert.deepEqual((module.existingAngles as (versions: SubjectVersionResponse[]) => Map<string, Set<string>>)([versionOf(1), versionOf(2, {variant: variantOf('left', 'wide')})]), new Map([['left', new Set(['wide'])]]));
  assert.deepEqual((module.lightSpecs as (light: Row) => Row[])({azimuth: 44.6, elevation: -10.2, quality: 'hard', kelvin: 4849}), [{kind: 'light', azimuth: 45, elevation: -10, quality: 'hard', kelvin: 4800}]);
  const point = module.lightPoint as (light: {azimuth: number; elevation: number}) => {x: number; y: number; behind: boolean};
  const back = module.lightFromPoint as (x: number, y: number) => {azimuth: number; elevation: number};
  for (const azimuth of [-80, -30, 0, 45, 80]) for (const elevation of [-60, 0, 30, 60]) {
    const {x, y, behind} = point({azimuth, elevation});
    assert.equal(behind, false);
    assert.deepEqual(back(x, y), {azimuth, elevation});
  }
  assert.equal(point({azimuth: 135, elevation: 0}).behind, true);
  assert.deepEqual(back(3, 0), {azimuth: 90, elevation: 0}, 'a drag outside the sphere is clamped onto it');
});

test('a batch row shows progress and every reason it cannot be undone yet', () => {
  const {render} = harness('SubjectVariantRows.tsx'), fake = fakeVariants();
  const batch = batchOf({items: [itemOf(1, angle('left'), 'succeeded', {versionId: versionId(2)}), itemOf(2, angle('right', 'wide'), 'running'), itemOf(3, angle('back'), 'failed'), itemOf(4, angle('high'), 'unknown')],
    undo: {available: false, blockers: [{code: 'IN_PROGRESS', position: 2}, {code: 'UNKNOWN', position: 4}, {code: 'BOUND', position: 1, shotId}, {code: 'BOUND', position: 1, shotId: id(2, 9)}, {code: 'GENERATED', position: 1}, {code: 'SOURCE', position: 1, batchId: id(7, 2)}]}});
  let tasks = 0;
  const tree = render({batch, shots: [{id: shotId, title: '霓虹特写', orderIndex: 2}, {id: id(2, 5), title: '城市夜景', orderIndex: 0}], submitting: false, issues: {[`${batch.id}:3`]: i18nIndex.message('subjects.variants.submit.queueFull')},
    controller: fake.controller, versions: {[versionId(2)]: versionOf(2, {variant: variantOf('left')})}, disabled: false, admit, onShowTasks: () => { tasks++; }}, 'SubjectVariantBatchRow');
  assert.equal(text(deep(tree).find(node => node.type === 'strong')), '补角度 · 1/4 已完成 · 1 张失败 · 1 张结果未知');
  assert.equal(byId(tree, `subject-variant-undo-${batch.id}`)!.props.disabled, true);
  assert.deepEqual(nodes(byId(tree, `subject-variant-blocked-${batch.id}`)!).filter(node => node.type === 'p').map(text), ['暂时不能撤销本批', '右 · 广角 还在生成，完成后再撤销', '俯拍 的结果未知，先到任务中心核对',
    'V2 已被镜头 02 霓虹特写 选用，先在镜头里换成别的版本', 'V2 已被镜头选用，先在镜头里换成别的版本', 'V2 已用于生成视频，不能撤销这批', 'V2 是另一批的源图，先撤销那一批']);
  assert.match(text(tree), /图片队列已满，这张没有提交/);
  assert.match(text(tree), /不会自动重发，请到任务中心核对原请求/);
  click(byId(tree, `subject-variant-tasks-${batch.id}`)); assert.equal(tasks, 1);
  click(byId(tree, `subject-variant-reread-${batch.id}`)); assert.deepEqual(fake.named('readBatch'), [['readBatch', batch.id]]);
  assert.equal(byId(tree, `subject-variant-continue-${batch.id}`), undefined, 'nothing is waiting to be submitted');
});

test('row and tile actions confirm once and act on the batch that was shown', async () => {
  const {h, render} = harness('SubjectVariantRows.tsx'), fake = fakeVariants();
  const waiting = batchOf({providerId: 'openai', model: contracts.IMAGE_MODELS.openai, items: [itemOf(1, angle('left'), 'succeeded', {versionId: versionId(2)}), itemOf(2, angle('right'), 'pending'), itemOf(3, angle('back'), 'pending')], undo: {available: true, blockers: []}});
  const row = (batch: SubjectVariantBatch, patch: Row = {}): ElementTree => render({batch, shots: [], submitting: false, issues: {}, controller: fake.controller, versions: {}, disabled: false, admit, ...patch}, 'SubjectVariantBatchRow');
  let tree = row(waiting);
  assert.equal(text(deep(tree).find(node => node.type === 'strong')), '补角度 · 1/3 已完成 · 2 张未提交');
  click(byId(tree, `subject-variant-continue-${waiting.id}`)); await flush();
  assert.deepEqual(h.confirmations.at(-1), i18nIndex.message('subjects.variants.continueConfirmPaid', {total: 2}));
  assert.deepEqual(fake.named('submit'), [['submit', waiting]]);
  click(byId(tree, `subject-variant-undo-${waiting.id}`)); await flush();
  assert.deepEqual(h.confirmations.at(-1), i18nIndex.message('subjects.variants.undoConfirm', {total: 1}));
  assert.deepEqual(fake.named('undo'), [['undo', waiting]]);
  h.answer = false;
  click(byId(tree, `subject-variant-undo-${waiting.id}`)); await flush();
  assert.equal(fake.named('undo').length, 1, 'a declined confirmation does nothing');
  h.answer = true;
  tree = row(waiting, {submitting: true});
  assert.equal(byId(tree, `subject-variant-continue-${waiting.id}`)!.props.disabled, true);
  tree = row(waiting, {disabled: true});
  assert.equal(byId(tree, `subject-variant-undo-${waiting.id}`)!.props.disabled, true);
  const failed = batchOf({items: [itemOf(1, angle('left', 'wide'), 'failed'), itemOf(2, angle('right'), 'cancelled'), itemOf(3, angle('back'), 'running'), itemOf(4, angle('high'), 'running', {image: {taskId: id(8, 4), state: 'queued', dispatched: false, errorCode: null}}), itemOf(5, angle('low'), 'pending')]});
  const tile = (position: number, patch: Row = {}): ElementTree => render({batch: failed, item: failed.items[position - 1], submitting: false, controller: fake.controller, versions: {}, disabled: false, admit, ...patch}, 'SubjectVariantItemTile');
  tree = tile(1);
  assert.equal(text(tree), '失败重试左 · 广角服务商拒绝了请求');
  assert.match(text(tree), /服务商拒绝了请求/);
  click(byId(tree, `subject-variant-retry-${failed.id}-1`)); await flush();
  assert.deepEqual(h.confirmations.at(-1), i18nIndex.message('subjects.variants.retryConfirmMock'));
  assert.deepEqual(fake.named('retry'), [['retry', failed, 1]]);
  assert.match(text(tile(2)), /未发出就取消了/);
  assert.equal(byId(tile(3), `subject-variant-retry-${failed.id}-3`), undefined, 'a moving image has no retry');
  assert.match(text(tile(3)), /生成中/);
  assert.match(text(tile(4)), /排队中/);
  assert.match(text(tile(5)), /未提交/);
  assert.match(text(tile(5, {submitting: true})), /提交中/);
});

test('the pane offers new angles for characters and products, with batch rows and pending images in the grid', async () => {
  const versions = [versionOf(1), versionOf(2, {variant: variantOf('left'), provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}})];
  const subjects = await subjectsFor('character', versions);
  const batch = batchOf({items: [itemOf(1, angle('left'), 'succeeded', {versionId: versionId(2)}), itemOf(2, angle('right', 'wide'), 'running'), itemOf(3, angle('back'), 'failed')], undo: {available: false, blockers: [{code: 'IN_PROGRESS', position: 2}]}});
  const fake = fakeVariants({lists: {[subjectId]: listOf(batch)}, live: {[batch.id]: batch}});
  const {render} = harness('SubjectInspector.tsx');
  const props = () => ({subjects: {state: subjects.getState(), controller: subjects}, variants: {state: fake.state, controller: fake.controller}, subjectId, assets: versions.map(version => imageInfo(version.number)), shots: [{id: shotId, title: '霓虹特写', orderIndex: 0}]});
  let tree = render(props());
  const open = byId(tree, 'subject-variant-open')!;
  assert.equal(open.props.disabled, false);
  assert.deepEqual(byType(tree, 'SubjectVariantBatchRow').map(node => (node.props.batch as SubjectVariantBatch).id), [batch.id]);
  assert.deepEqual(byType(tree, 'SubjectVariantItemTile').map(node => (node.props.item as {position: number}).position), [2, 3], 'images without a version stand in the grid');
  assert.equal(text(deep(tree).filter(node => node.props?.className === 'subject-version-new')), '新', 'the newest batch marks its versions');
  assert.equal(byType(tree, 'SubjectVariantDialog').length, 0);
  click(open);
  tree = render(props());
  const dialog = byType(tree, 'SubjectVariantDialog')[0]!;
  assert.equal(dialog.props.initialSourceId, versionId(1), 'the dialog starts from the shown version');
  assert.deepEqual((dialog.props.versions as SubjectVersionResponse[]).map(version => version.id), [versionId(1), versionId(2)]);
  assert.deepEqual(fake.named('clearNotice').length, 1, 'an earlier notice does not carry into the dialog');
  // One write at a time: an unknown outcome blocks the entry and every row.
  const pending = fakeVariants({lists: {[subjectId]: listOf(batch)}, live: {[batch.id]: batch}, pending: {operation: 'subject.variants.undo', input: {}, subjectId}, notice: i18nIndex.message('subjects.variants.unconfirmed')});
  tree = render({...props(), variants: {state: pending.state, controller: pending.controller}});
  assert.equal(byId(tree, 'subject-variant-open')!.props.disabled, true);
  assert.match(text(deep(tree).find(node => node.type === 'WorkbenchTooltip' && text(node).includes('上一个补角度请求'))), /上一个补角度请求的结果未确认/);
  assert.equal(byType(tree, 'SubjectVariantBatchRow')[0]!.props.disabled, true);
  assert.equal(byType(tree, 'SubjectVariantNotice')[0]!.props.disabled, false, 'the unknown write itself can still be resolved');
  const scene = await subjectsFor('location', [versionOf(1)]), {render: renderScene} = harness('SubjectInspector.tsx'), none = fakeVariants();
  tree = renderScene({subjects: {state: scene.getState(), controller: scene}, variants: {state: none.state, controller: none.controller}, subjectId, assets: [imageInfo(1)]});
  assert.equal(byId(tree, 'subject-variant-open')!.props.disabled, true);
  assert.match(text(deep(tree).find(node => node.type === 'WorkbenchTooltip' && text(node).includes('补角度只用于'))), /补角度只用于角色和产品/);
  const plain = harness('SubjectInspector.tsx');
  assert.equal(byId(plain.render({subjects: {state: subjects.getState(), controller: subjects}, subjectId, assets: []}), 'subject-variant-open'), undefined, 'without batches the pane offers no new angles');
});

test('a shot chooses a version by angle, starting from the angle it uses', async () => {
  const versions = [versionOf(1), versionOf(2, {variant: variantOf('front-left')}), versionOf(3, {variant: variantOf('right')}), versionOf(4, {variant: variantOf('back')}), versionOf(5, {variant: variantOf('high')})];
  const row = {id: id(6), projectId, shotId, subjectId, role: 'subject', revision: 1, subjectVersionId: versionId(3), reviewedHeadVersionId: versionId(1), headVersionId: versionId(1), subjectRevision: 5, needsReview: false, createdAt: date, updatedAt: date} as unknown as SubjectBindingResponse;
  const subjects = await subjectsFor('character', versions, [row]);
  await subjects.readBindings(shotId); await subjects.readVersions(subjectId);
  const {render} = harness('ShotSubjectBindings.tsx');
  const props = () => { const state = subjects.getState(); return {binding: state.bindings[shotId]!.items[0], state, controller: subjects, assets: versions.map(version => imageInfo(version.number)), disabled: false, scope: state.scope}; };
  let tree = render(props(), 'BoundSubject');
  const chips = deep(byId(tree, `shot-subject-variants-${row.id}`)).filter(node => node.props?.['aria-pressed'] !== undefined && String(node.props['data-testid']).startsWith('shot-subject-angle-'));
  assert.deepEqual(chips.map(text), ['全部', '左前', '右', '背', '俯拍']);
  assert.deepEqual(chips.map(node => node.props['aria-pressed']), [false, false, true, false, false], 'the filter starts at the angle the shot uses');
  const picks = (value: ElementTree): ElementNode[] => deep(value).filter(node => String(node.props?.['data-testid']).startsWith(`shot-subject-pick-${row.id}-`));
  assert.deepEqual(picks(tree).map(node => node.props['aria-label']), ['选用 V3']);
  assert.ok(byId(tree, `shot-subject-uses-${row.id}`), 'the version the shot uses is marked');
  assert.match(text(tree), /右只有这一张。换角度请在上方筛选。/);
  click(byId(tree, `shot-subject-angle-${row.id}-all`));
  tree = render(props(), 'BoundSubject');
  assert.deepEqual(picks(tree).map(node => node.props['aria-label']), [1, 2, 3, 4, 5].map(number => `选用 V${number}`));
  click(byId(tree, `shot-subject-pick-${row.id}-${versionId(4)}`));
  assert.equal(subjects.getState().bindingDrafts[shotId]?.subjectVersionId, versionId(4), 'a pick is a binding draft saved below');
  tree = render(props(), 'BoundSubject');
  assert.equal(byId(tree, `shot-subject-pick-${row.id}-${versionId(4)}`)!.props['aria-pressed'], true);
  assert.equal(byId(tree, `shot-subject-uses-${row.id}`), undefined);
  const plain = await subjectsFor('character', [versionOf(1)], [{...row, subjectVersionId: versionId(1), subjectRevision: 1} as SubjectBindingResponse]);
  await plain.readBindings(shotId);
  const state = plain.getState();
  assert.equal(byId(harness('ShotSubjectBindings.tsx').render({binding: state.bindings[shotId]!.items[0], state, controller: plain, assets: [imageInfo(1)], disabled: false, scope: state.scope}, 'BoundSubject'), `shot-subject-variants-${row.id}`), undefined, 'a subject without variants has no angle filter');
});

test('hidden versions leave the subject versions and any shot draft that chose them', async () => {
  const versions = [versionOf(1), versionOf(2, {variant: variantOf('left')}), versionOf(3, {variant: variantOf('right')})];
  const subjects = await subjectsFor('character', versions);
  await subjects.readBindings(shotId);
  subjects.chooseBinding(shotId, subjectId, versionId(2));
  assert.equal(subjects.getState().bindingDrafts[shotId]?.subjectVersionId, versionId(2));
  subjects.forgetVersions(subjectId, [versionId(2)]);
  const state = subjects.getState();
  assert.deepEqual(state.versions[subjectId]!.items.map(version => version.id), [versionId(1), versionId(3)]);
  assert.equal(state.versions[subjectId]!.known?.[versionId(2)], undefined);
  assert.equal(state.bindingDrafts[shotId], null);
  const before = subjects.getState();
  subjects.forgetVersions(subjectId, [versionId(9)]);
  assert.equal(subjects.getState(), before, 'an unknown version changes nothing');
});
