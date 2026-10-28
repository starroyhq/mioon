import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { IMAGE_MODELS, SUBJECT_VARIANT_LIMITS, SUBJECT_VARIANT_MUTATION_OPERATIONS, canonicalSubjectVariantInput, imageEditOutputSize, imageEditProfile, imageEditSourceIssue,
  isImageMutationResponse, isImageReviewPreparationResponse, isImageReviewResponse, isSubjectVariantBatch, isSubjectVariantListResponse, isSubjectVariantMutationResponse,
  subjectVariantSchemas } from '@mioon/contracts';
import type { ImageReviewResponse, SubjectVariantBatch, SubjectVariantItem, SubjectVariantSpec } from '@mioon/contracts';
import type { SubjectVersionResponse } from '../../../packages/contracts/src/subjects.ts';
import { ApiError } from './api.ts';

// Angle and lighting batches (C7c). A batch is recorded first; each of its images
// is then submitted as an ordinary image edit whose request ID the batch fixed, so
// submitting an image again is an exact replay, never a second image. Nothing here
// retries on its own: an unknown outcome stays visible until the user reads again
// or resends the identical request.
export type SubjectVariantProviderId = 'mock' | 'openai';
export type SubjectVariantKind = 'angle' | 'light';
export interface SubjectVariantList { phase: 'idle' | 'loading' | 'ready' | 'error'; items: SubjectVariantBatch[]; error: DisplayMessage | null }
export interface SubjectVariantPending { operation: string; input: Readonly<Record<string, unknown>>; subjectId: string; attempt?: number }
export interface SubjectVariantState {
  scope: string | null;
  projectId: string | null;
  lists: Record<string, SubjectVariantList>;
  /** Single-batch reads; only these carry undo availability. */
  live: Record<string, SubjectVariantBatch>;
  /** The write or submission in flight: an operation name or `submit:<batchId>`. */
  busy: string | null;
  /** A write whose outcome is unknown. No other write starts until it is resolved. */
  pending: SubjectVariantPending | null;
  notice: DisplayMessage | null;
  /** Why an image of a batch was not submitted, keyed `<batchId>:<position>`. */
  issues: Record<string, DisplayMessage>;
}
export interface SubjectVariantDraft { subjectId: string; sourceVersionId: string; kind: SubjectVariantKind; items: SubjectVariantSpec[]; providerId: SubjectVariantProviderId; model: string }
export interface SubjectVariantOptions {
  read: (operation: string, input: Record<string, unknown>) => Promise<unknown>;
  write: (operation: string, input: Record<string, unknown>) => Promise<unknown>;
  /** `image.generate` for the mock service, `image.review.prepare` for GPT Image. */
  image: (operation: string, input: Record<string, unknown>) => Promise<unknown>;
  /** The private approval endpoint; it starts one prepared paid image. */
  approve: (review: ImageReviewResponse) => Promise<unknown>;
  /** The official image settings: a paid review is bound to their revision. */
  settings: () => Promise<unknown>;
  requestId?: () => string;
  onChange?: (state: SubjectVariantState) => void;
  /** New versions were linked to this subject, or a batch's versions were hidden
   * (`hidden`); the subject's version list is stale. */
  onVersions?: (subjectId: string, hidden: readonly string[]) => void;
}

export const SUBJECT_VARIANT_POLL_MS = 2500;
const SHOWN_BATCHES = 3;
const SETTLED = new Set(['succeeded', 'undone']);
const freeze = <T>(value: T): T => { const copy = structuredClone(value); const deep = (item: unknown): unknown => { if (item && typeof item === 'object') { Object.values(item as Record<string, unknown>).forEach(deep); Object.freeze(item); } return item; }; return deep(copy) as T; };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const codeOf = (error: unknown): string => error instanceof ApiError && typeof error.code === 'string' ? error.code : '';
const initial = (): SubjectVariantState => ({ scope: null, projectId: null, lists: {}, live: {}, busy: null, pending: null, notice: null, issues: {} });
const latest = (batch: SubjectVariantBatch, live: Readonly<Record<string, SubjectVariantBatch>>): SubjectVariantBatch => live[batch.id] && live[batch.id]!.revision >= batch.revision ? live[batch.id]! : batch;

/** The batch rows a subject shows: the newest active batch and any unfinished active one, at most three. */
export function shownSubjectVariantBatches(list: SubjectVariantList | null | undefined, live: Readonly<Record<string, SubjectVariantBatch>> = {}): SubjectVariantBatch[] {
  const batches = (list?.items ?? []).map(batch => latest(batch, live)).filter(batch => batch.state === 'active');
  return batches.filter((batch, index) => index === 0 || batch.items.some(item => !SETTLED.has(item.status))).slice(0, SHOWN_BATCHES);
}
export interface SubjectVariantProgress { total: number; done: number; running: number; pending: number; failed: number; unknown: number }
export function subjectVariantProgress(batch: SubjectVariantBatch): SubjectVariantProgress {
  const count = (statuses: readonly string[]): number => batch.items.filter(item => statuses.includes(item.status)).length;
  return { total: batch.items.length, done: count(['succeeded']), running: count(['running']), pending: count(['pending']), failed: count(['failed', 'cancelled']), unknown: count(['unknown', 'recoverable', 'interrupted']) };
}
/** Only an image the provider refused, or one cancelled before it was sent, can be retried. */
export const subjectVariantRetryable = (item: SubjectVariantItem): boolean => item.status === 'failed' || item.status === 'cancelled';
/** An item with no image request yet; submitting it again is an exact replay. */
export const subjectVariantUnsubmitted = (item: SubjectVariantItem): boolean => item.status === 'pending' && item.image === null;

// Mirrors the backend's edit-source rule: imports, image results and captured
// frames, never a video result or an export. Opacity is checked from pixels.
const EDIT_ORIGINS = new Set(['user-import', 'generated', 'synthetic-mock', 'extracted-frame']);
export type SubjectVariantSourceIssue = 'format' | 'bytes' | 'dimensions' | 'origin' | 'missing' | 'transparent';
export interface SubjectVariantSourceAsset { id?: string; projectId?: string; sizeBytes?: unknown; [key: string]: unknown }
export function subjectVariantSourceIssue(version: SubjectVersionResponse | null | undefined, asset: SubjectVariantSourceAsset | null | undefined, providerId: SubjectVariantProviderId): Exclude<SubjectVariantSourceIssue, 'transparent'> | null {
  const profile = imageEditProfile(providerId, IMAGE_MODELS[providerId]);
  if (!version || !asset || asset.id !== version.assetId || asset.projectId !== version.projectId || !profile) return 'missing';
  const provenance = version.provenance, ids = [provenance.versionId, provenance.shotId, provenance.jobId];
  const origin = EDIT_ORIGINS.has(provenance.kind) && ids.every(value => value === null) && (provenance.kind !== 'user-import' || provenance.imageSource === undefined && provenance.frameSource === undefined) &&
    (!['generated', 'synthetic-mock'].includes(provenance.kind) || provenance.imageSource !== undefined) && (provenance.kind !== 'extracted-frame' || provenance.frameSource !== undefined);
  if (!origin) return 'origin';
  return imageEditSourceIssue(profile, { mimeType: version.mimeType, byteLength: asset.sizeBytes, width: version.width, height: version.height });
}
/** The output size a batch from this source will have: the source's ratio, long edge 1536. */
export function subjectVariantOutputSize(version: Pick<SubjectVersionResponse, 'width' | 'height'> | null | undefined, providerId: SubjectVariantProviderId): string | null {
  const profile = imageEditProfile(providerId, IMAGE_MODELS[providerId]);
  if (!profile || !version) return null;
  try { return imageEditOutputSize(profile, version.width, version.height); } catch { return null; }
}
export interface SubjectVariantModel { providerId: SubjectVariantProviderId; model: string; available: boolean; paid: boolean; settingsRevision: number | null }
/** GPT Image needs an enabled official connection with a saved key; the mock service always works. */
export function subjectVariantModels(settings: unknown): SubjectVariantModel[] {
  const official = record(settings) && Number.isSafeInteger(settings.revision) && record(settings.configuration) && record(settings.secret) ? settings : null;
  const openai = Boolean(official && (official.configuration as Record<string, unknown>).enabled === true && (official.secret as Record<string, unknown>).configured === true);
  return [
    { providerId: 'openai', model: IMAGE_MODELS.openai, available: openai, paid: true, settingsRevision: openai ? official!.revision as number : null },
    { providerId: 'mock', model: IMAGE_MODELS.mock, available: true, paid: false, settingsRevision: null },
  ];
}

const refusalStatus: Readonly<Record<string, number>> = Object.freeze({ SUBJECT_VARIANT_REVISION_CONFLICT: 409, SUBJECT_VARIANT_STATE_CONFLICT: 409, SUBJECT_VARIANT_KIND_UNSUPPORTED: 409,
  SUBJECT_VARIANT_SOURCE_UNSUPPORTED: 409, SUBJECT_VARIANT_QUEUE_FULL: 409, SUBJECT_VARIANT_RETRY_UNAVAILABLE: 409, SUBJECT_VARIANT_UNDO_BLOCKED: 409, SUBJECT_VERSION_HIDDEN: 409, SUBJECT_VARIANT_CAPACITY: 507 });
/** True only for a refusal whose proof binds this exact operation, project, request and input. */
export async function subjectVariantRequestNotAccepted(error: unknown, operation: string, input: unknown): Promise<boolean> {
  if (!(error instanceof ApiError) || !(SUBJECT_VARIANT_MUTATION_OPERATIONS as readonly string[]).includes(operation)) return false;
  const code = codeOf(error), proof = record(error.details) ? error.details.subjectVariantOutcome : null, request = record(input) ? input : {};
  const schema = (subjectVariantSchemas as Record<string, { safeParse(value: unknown): { success: boolean } }>)[operation];
  if (!Object.hasOwn(refusalStatus, code) || error.status !== refusalStatus[code] || !record(proof) || !schema?.safeParse(input).success ||
    Object.keys(proof).sort().join(',') !== 'inputHash,operation,projectId,requestId,status' || proof.status !== 'not_accepted' || proof.operation !== operation ||
    proof.projectId !== request.projectId || proof.requestId !== request.requestId || typeof proof.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.inputHash)) return false;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalSubjectVariantInput(input)));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') === proof.inputHash;
  } catch { return false; }
}
type RefusalKey = 'subjects.variants.refused.queueFull' | 'subjects.variants.refused.source' | 'subjects.variants.refused.kind' | 'subjects.variants.refused.changed' | 'subjects.variants.refused.undoBlocked' | 'subjects.variants.refused.retry' | 'subjects.variants.refused.hidden' | 'subjects.variants.refused.capacity';
const refusalKeys: Readonly<Record<string, RefusalKey>> = Object.freeze({
  SUBJECT_VARIANT_QUEUE_FULL: 'subjects.variants.refused.queueFull', SUBJECT_VARIANT_SOURCE_UNSUPPORTED: 'subjects.variants.refused.source', SUBJECT_VARIANT_KIND_UNSUPPORTED: 'subjects.variants.refused.kind',
  SUBJECT_VARIANT_REVISION_CONFLICT: 'subjects.variants.refused.changed', SUBJECT_VARIANT_STATE_CONFLICT: 'subjects.variants.refused.changed', SUBJECT_VARIANT_UNDO_BLOCKED: 'subjects.variants.refused.undoBlocked',
  SUBJECT_VARIANT_RETRY_UNAVAILABLE: 'subjects.variants.refused.retry', SUBJECT_VERSION_HIDDEN: 'subjects.variants.refused.hidden', SUBJECT_VARIANT_CAPACITY: 'subjects.variants.refused.capacity' });
const refusalMessage = (error: unknown): DisplayMessage => message(refusalKeys[codeOf(error)] ?? 'subjects.variants.refused.changed');
// Refused before anything started: nothing was sent or charged.
const settingsRefusals = new Set(['IMAGE_SETTINGS_CHANGED', 'IMAGE_SETTINGS_DISABLED', 'IMAGE_SETTINGS_NOT_CONFIGURED', 'IMAGE_REVIEW_SETTINGS_CHANGED', 'IMAGE_SETTINGS_CONFLICT']);
const imageIssue = (error: unknown): DisplayMessage => {
  const code = codeOf(error);
  if (code === 'IMAGE_QUEUE_FULL' || code === 'IMAGE_GROUP_BUSY') return message('subjects.variants.submit.queueFull');
  if (code === 'IMAGE_SOURCE_INVALID') return message('subjects.variants.submit.sourceInvalid');
  if (settingsRefusals.has(code)) return message('subjects.variants.submit.settings');
  return message('subjects.variants.submit.unknown');
};

export function createSubjectVariantController({ read, write, image, approve, settings, requestId = () => crypto.randomUUID(), onChange = () => {}, onVersions = () => {} }: SubjectVariantOptions) {
  let state = initial(), epoch = 0, timer: ReturnType<typeof setTimeout> | null = null, visible = true, watched: string | null = null;
  const generations = new Map<string, number>();
  // Version IDs already reflected in the subject's version list, and those of
  // undone batches already reported hidden.
  const seen = new Set<string>(), gone = new Set<string>();
  const emit = (patch: Partial<SubjectVariantState>): void => { state = { ...state, ...patch }; onChange(state); };
  const owner = () => ({ scope: state.scope, projectId: state.projectId, epoch });
  const current = (captured: ReturnType<typeof owner>): boolean => captured.scope === state.scope && captured.projectId === state.projectId && captured.epoch === epoch;
  const next = (key: string): number => { const value = (generations.get(key) ?? 0) + 1; generations.set(key, value); return value; };
  const stop = (): void => { if (timer) clearTimeout(timer); timer = null; };
  const reset = (): void => { epoch++; generations.clear(); seen.clear(); gone.clear(); stop(); watched = null; state = initial(); };
  const known = (batchId: string, subjectId: string): boolean => Boolean(state.live[batchId] || state.lists[subjectId]?.items.some(item => item.id === batchId));
  /** Records linked and hidden versions. A batch seen before reports a change
   * once, with the versions it hid; null when there is nothing to report. */
  function observe(batch: SubjectVariantBatch, report: boolean): string[] | null {
    let fresh = false;
    const hidden: string[] = [];
    for (const item of batch.items) {
      if (!item.versionId) continue;
      if (batch.state === 'undone') { if (!gone.has(item.versionId)) { gone.add(item.versionId); hidden.push(item.versionId); } }
      else if (!seen.has(item.versionId)) { seen.add(item.versionId); fresh = true; }
    }
    return report && (fresh || hidden.length > 0) ? hidden : null;
  }
  function install(batch: SubjectVariantBatch, withUndo: boolean): void {
    const change = observe(batch, known(batch.id, batch.subjectId)), list = state.lists[batch.subjectId];
    const items = list ? (list.items.some(item => item.id === batch.id) ? list.items.map(item => item.id === batch.id ? batch : item) : [batch, ...list.items]) : [batch];
    // A server-side image request supersedes a local submission note.
    const issues = Object.fromEntries(Object.entries(state.issues).filter(([key]) => { const [id, position] = key.split(':'); return id !== batch.id || batch.items[Number(position) - 1]?.image === null; }));
    emit({ lists: { ...state.lists, [batch.subjectId]: { phase: list?.phase === 'loading' ? 'loading' : 'ready', items, error: list?.error ?? null } }, issues,
      ...(withUndo || state.live[batch.id] ? { live: { ...state.live, [batch.id]: batch } } : {}) });
    if (change) onVersions(batch.subjectId, change);
  }
  function schedule(): void {
    stop();
    if (!visible || !watched || !state.projectId) return;
    const moving = shownSubjectVariantBatches(state.lists[watched], state.live).filter(batch => batch.items.some(item => item.status === 'running'));
    if (!moving.length) return;
    const captured = owner(), subjectId = watched;
    timer = setTimeout(() => { if (current(captured) && watched === subjectId) void Promise.all(moving.map(batch => readBatch(batch.id))).then(() => { if (current(captured)) schedule(); }); }, SUBJECT_VARIANT_POLL_MS);
  }
  async function readBatch(batchId: string): Promise<SubjectVariantBatch | null> {
    if (!state.projectId) return null;
    const captured = owner(), key = `get:${batchId}`, generation = next(key), input = { projectId: state.projectId, batchId };
    try {
      const result = await read('subject.variants.get', input);
      if (!current(captured) || generations.get(key) !== generation) return null;
      if (!isSubjectVariantBatch(result) || result.id !== batchId || result.projectId !== input.projectId || result.undo === null) throw Error('Invalid subject variant batch');
      const batch = freeze(result);
      install(batch, true); return batch;
    } catch { return null; }
  }
  async function readSubject(subjectId: string): Promise<SubjectVariantList | null> {
    if (!state.projectId || !state.scope) return null;
    const captured = owner(), key = `list:${subjectId}`, generation = next(key), input = { projectId: state.projectId, subjectId, limit: SUBJECT_VARIANT_LIMITS.pageSize };
    const before = state.lists[subjectId];
    emit({ lists: { ...state.lists, [subjectId]: { phase: 'loading', items: before?.items ?? [], error: null } } });
    try {
      const result = await read('subject.variants.list', input);
      if (!current(captured) || generations.get(key) !== generation) return null;
      if (!isSubjectVariantListResponse(input, result)) throw Error('Invalid subject variant list');
      const items = freeze((result as { items: SubjectVariantBatch[] }).items);
      let report = false;
      const hidden: string[] = [];
      for (const batch of items) { const change = observe(batch, known(batch.id, subjectId)); if (change) { report = true; hidden.push(...change); } }
      const value: SubjectVariantList = { phase: 'ready', items, error: null };
      emit({ lists: { ...state.lists, [subjectId]: value } });
      if (report) onVersions(subjectId, hidden);
      await Promise.all(shownSubjectVariantBatches(value, state.live).map(batch => readBatch(batch.id)));
      return state.lists[subjectId] ?? value;
    } catch {
      if (current(captured) && generations.get(key) === generation) emit({ lists: { ...state.lists, [subjectId]: { phase: 'error', items: before?.items ?? [], error: message('subjects.variants.readFailed') } } });
      return null;
    } finally { if (current(captured)) schedule(); }
  }
  async function readSettings(): Promise<SubjectVariantModel[]> {
    try { return subjectVariantModels(await settings()); } catch { return subjectVariantModels(null); }
  }
  /** Submits each listed image that has no request yet, in order, and stops at the first failure. */
  async function submit(batch: SubjectVariantBatch, positions: readonly number[] = batch.items.filter(subjectVariantUnsubmitted).map(item => item.position)): Promise<boolean> {
    if (!state.projectId || batch.projectId !== state.projectId || batch.state !== 'active' || state.busy) return false;
    const captured = owner(), issues = { ...state.issues };
    for (const position of positions) delete issues[`${batch.id}:${position}`];
    emit({ busy: `submit:${batch.id}`, issues });
    let complete = true;
    try {
      const revision = batch.providerId === 'openai' ? (await readSettings()).find(model => model.providerId === 'openai')?.settingsRevision ?? null : null;
      for (const position of positions) {
        const item = batch.items[position - 1];
        if (!current(captured)) return false;
        if (!item || !subjectVariantUnsubmitted(item)) continue;
        try {
          if (batch.providerId === 'mock') {
            const result = await image('image.generate', item.imageInput as Record<string, unknown>);
            if (!isImageMutationResponse('image.generate', item.imageInput, result)) throw Error('Unconfirmed image request');
          } else {
            if (revision === null) throw new ApiError('GPT Image is not connected.', 'IMAGE_SETTINGS_NOT_CONFIGURED', undefined, true);
            const input = { input: item.imageInput, settingsRevision: revision };
            const review = await image('image.review.prepare', input);
            if (!isImageReviewPreparationResponse(input, review) || !isImageReviewResponse(review)) throw Error('Unconfirmed image review');
            if (review.state === 'rejected') throw new ApiError('The image review was rejected.', 'IMAGE_REVIEW_REJECTED', undefined, true);
            if (review.state === 'pending') {
              if (!current(captured)) return false;
              const result = await approve(review);
              if (!isImageMutationResponse('image.generate', review.input, result)) throw Error('Unconfirmed image approval');
            }
          }
        } catch (error) {
          complete = false;
          if (current(captured)) emit({ issues: { ...state.issues, [`${batch.id}:${position}`]: codeOf(error) === 'IMAGE_REVIEW_REJECTED' ? message('subjects.variants.submit.rejected') : imageIssue(error) } });
          break;
        }
      }
    } finally {
      if (current(captured)) { emit({ busy: null }); await readBatch(batch.id); schedule(); }
    }
    return complete;
  }
  async function mutate(operation: string, input: Readonly<Record<string, unknown>>, subjectId: string, attempt?: number): Promise<SubjectVariantBatch | null> {
    const captured = owner();
    emit({ busy: operation, notice: null });
    try {
      const result = await write(operation, input as Record<string, unknown>);
      if (!current(captured)) return null;
      if (!isSubjectVariantMutationResponse(operation, input, result)) { emit({ pending: { operation, input, subjectId, ...(attempt ? { attempt } : {}) }, notice: message('subjects.variants.unconfirmed') }); return null; }
      const batch = freeze(result as SubjectVariantBatch);
      emit({ pending: null });
      install(batch, false);
      return batch;
    } catch (error) {
      if (!current(captured)) return null;
      if (await subjectVariantRequestNotAccepted(error, operation, input)) emit({ pending: null, notice: refusalMessage(error) });
      else emit({ pending: { operation, input, subjectId, ...(attempt ? { attempt } : {}) }, notice: message('subjects.variants.unconfirmed') });
      return null;
    } finally {
      if (current(captured)) { emit({ busy: null }); await readSubject(subjectId); }
    }
  }
  const writable = (): boolean => Boolean(state.projectId && state.scope && !state.busy && !state.pending);
  // A recorded batch, or a retried item, still needs its image request.
  const unsubmittedNotice = (batch: SubjectVariantBatch): DisplayMessage | null => batch.state === 'active' && batch.items.some(subjectVariantUnsubmitted) ? message('subjects.variants.recoveredUnsubmitted') : null;
  return {
    getState: (): SubjectVariantState => state,
    setContext(context: { scope: string | null; projectId: string | null } | null): void {
      if (!context || context.scope !== state.scope || context.projectId !== state.projectId) reset();
      emit(context ? { scope: context.scope, projectId: context.projectId } : {});
    },
    setVisible(value: boolean): void { visible = value; if (visible) schedule(); else stop(); },
    /** The subject whose batches the pane shows; read now and polled while its images move. */
    watch(subjectId: string | null): Promise<SubjectVariantList | null> | null { watched = subjectId; stop(); return subjectId ? readSubject(subjectId) : null; },
    readSubject,
    readBatch,
    readSettings,
    /** Records a batch and then submits its images; resolves once the batch is recorded. */
    async create(draft: SubjectVariantDraft): Promise<SubjectVariantBatch | null> {
      if (!writable()) return null;
      const input = freeze({ projectId: state.projectId, subjectId: draft.subjectId, sourceVersionId: draft.sourceVersionId, kind: draft.kind, items: draft.items.map(item => ({ ...item })), providerId: draft.providerId, model: draft.model, requestId: requestId() });
      if (!subjectVariantSchemas['subject.variants.create'].safeParse(input).success) return null;
      const batch = await mutate('subject.variants.create', input, draft.subjectId);
      if (batch) void submit(batch);
      return batch;
    },
    /** Submits images that have no request yet, such as after a reload. */
    submit: (batch: SubjectVariantBatch, positions?: readonly number[]): Promise<boolean> => writable() ? submit(batch, positions) : Promise.resolve(false),
    async retry(batch: SubjectVariantBatch, position: number): Promise<SubjectVariantBatch | null> {
      const item = batch.items[position - 1];
      if (!writable() || batch.projectId !== state.projectId || batch.state !== 'active' || !item || !subjectVariantRetryable(item)) return null;
      const result = await mutate('subject.variants.retry', freeze({ projectId: state.projectId, batchId: batch.id, position, expectedRevision: batch.revision, requestId: requestId() }), batch.subjectId, item.attempt + 1);
      if (result) void submit(result, [position]);
      return result;
    },
    /** Hides the batch's versions; the images stay in the library. */
    undo(batch: SubjectVariantBatch): Promise<SubjectVariantBatch | null> {
      if (!writable() || batch.projectId !== state.projectId || batch.state !== 'active' || !batch.undo?.available) return Promise.resolve(null);
      return mutate('subject.variants.undo', freeze({ projectId: state.projectId, batchId: batch.id, expectedRevision: batch.revision, requestId: requestId() }), batch.subjectId);
    },
    /** Reads whether an unknown write took effect and resolves it only on evidence. */
    async reconcile(): Promise<boolean> {
      const pending = state.pending;
      if (!pending || state.busy) return false;
      const captured = owner();
      if (pending.operation === 'subject.variants.create') {
        const list = await readSubject(pending.subjectId), batch = list?.items.find(item => item.requestId === pending.input.requestId);
        if (!current(captured) || state.pending !== pending || !batch) return false;
        emit({ pending: null, notice: unsubmittedNotice(batch) });
        return true;
      }
      const batch = await readBatch(pending.input.batchId as string);
      if (!current(captured) || state.pending !== pending || !batch) return false;
      const applied = pending.operation === 'subject.variants.undo' ? batch.state === 'undone' : (batch.items[(pending.input.position as number) - 1]?.attempt ?? 0) >= (pending.attempt ?? Number.MAX_SAFE_INTEGER);
      if (!applied) return false;
      emit({ pending: null, notice: pending.operation === 'subject.variants.retry' ? unsubmittedNotice(batch) : null });
      return true;
    },
    /** Sends the identical unknown write again; the backend replays one it
     * accepted. A recorded batch or retry then submits its images, as the
     * original write would have. */
    async resend(): Promise<SubjectVariantBatch | null> {
      const pending = state.pending;
      if (!pending || state.busy) return null;
      const batch = await mutate(pending.operation, pending.input, pending.subjectId, pending.attempt);
      if (batch && pending.operation === 'subject.variants.create') void submit(batch);
      if (batch && pending.operation === 'subject.variants.retry') void submit(batch, [pending.input.position as number]);
      return batch;
    },
    clearNotice(): void { if (state.notice && !state.pending) emit({ notice: null }); },
    dispose: reset,
  };
}
export type SubjectVariantController = ReturnType<typeof createSubjectVariantController>;
