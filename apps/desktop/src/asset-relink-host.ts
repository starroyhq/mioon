import {randomUUID} from 'node:crypto';
import {
  NATIVE_ASSET_MEDIA_LIMITS, nativeAssetMediaRequestSchema, nativeRelinkCandidateInputSchema,
  nativeRelinkCandidateSchema, nativeRelinkPreviewSchema, nativeRelinkApplyResultSchema,
} from '../../../packages/contracts/src/asset-media-native.ts';
import type {NativeAssetMediaPort, NativeRelinkPreview, NativeRelinkApplyResult} from '../../../packages/contracts/src/asset-media-native.ts';
import {projectIdSchema} from '../../../packages/contracts/src/project-file.ts';

export interface AssetRelinkOwner<W = unknown> {
  readonly window: W;
  readonly windowId: string;
  readonly backendId: string;
  readonly contextId: string;
  readonly projectId: string;
  readonly key: object;
  isCurrent(): boolean;
}
interface Options<E, W> {
  ownerForEvent(event: E): AssetRelinkOwner<W> | null;
  readonly backend: NativeAssetMediaPort;
  chooseFile(owner: AssetRelinkOwner<W>): Promise<string | null>;
  confirmOutside(owner: AssetRelinkOwner<W>, input: {readonly displayPath: string}): Promise<boolean>;
  isReady?(): boolean;
  now?(): number;
}
interface OwnerRecord<W> {
  readonly owner: AssetRelinkOwner<W>;
  readonly token: string;
  readonly controllers: Set<AbortController>;
  active: boolean;
  applying?: {previewToken: string; requestId: string};
  unknown?: {previewToken: string; requestId: string};
}
interface PreviewTicket<W> {
  readonly owner: OwnerRecord<W>;
  readonly preview: NativeRelinkPreview;
  readonly expires: number;
  requestId?: string;
  pending?: Promise<NativeRelinkApplyResult>;
  result?: NativeRelinkApplyResult;
}
const failure = (code = 'ASSET_RELINK_UNAVAILABLE', status = 409) => Object.assign(new Error(code), {code, status});
function safeError(error: unknown): {code: string; status: number} {
  const value = error as {code?: unknown; status?: unknown} | null;
  const known = typeof value?.code === 'string' && /^(?:ASSET_RELINK_|ASSET_MEDIA_NATIVE_|MEDIA_|PROJECT_|REQUEST_ID_|VALIDATION_)[A-Z0-9_]+$/u.test(value.code) ||
    ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'PREFLIGHT_BUDGET', 'INSPECTION_BUDGET_EXCEEDED', 'NOT_FOUND'].includes(String(value?.code));
  return {code: known ? String(value!.code) : 'ASSET_RELINK_UNAVAILABLE',
    status: known && Number.isInteger(value?.status) && Number(value?.status) >= 400 && Number(value?.status) <= 599 ? Number(value!.status) : 409};
}
const bytes = (value: unknown): number => {try {return Buffer.byteLength(JSON.stringify(value));} catch {return Infinity;}};
function bounded<T>(value: T): T {
  if (bytes({ok: true, data: value}) > NATIVE_ASSET_MEDIA_LIMITS.responseBytes) throw failure('ASSET_RELINK_LIMIT');
  return value;
}

/** A system selection is not an import or directory grant. Main alone holds
 * the owner token and candidate path; renderer input can neither supply them
 * nor borrow a preview from a different document/window/backend/project. */
export function createAssetRelinkHost<E, W = unknown>(options: Options<E, W>) {
  const owners = new Set<OwnerRecord<W>>(), byKey = new WeakMap<object, OwnerRecord<W>>(), tickets = new Map<string, PreviewTicket<W>>();
  const now = options.now ?? Date.now;
  let disposed = false, choosing: object | null = null;
  const ready = (): boolean => {try {return !disposed && options.isReady?.() !== false;} catch {return false;}};
  const current = (record: OwnerRecord<W>): boolean => {
    try {return ready() && record.active && byKey.get(record.owner.key) === record && record.owner.isCurrent();} catch {return false;}
  };
  const scope = (record: OwnerRecord<W>) => ({projectId: record.owner.projectId, ownerToken: record.token});
  const discard = async (record: OwnerRecord<W>, token?: {candidateToken?: string; previewToken?: string}): Promise<void> => {
    try {await options.backend.discard({...scope(record), ...token});}
    catch { /* The retired main owner cannot reuse these private, expiring tokens. */ }
  };
  function retire(record: OwnerRecord<W>): void {
    if (!record.active) return;
    record.active = false;
    for (const controller of record.controllers) controller.abort();
    record.controllers.clear();
    for (const [token, ticket] of tickets) if (ticket.owner === record) tickets.delete(token);
    owners.delete(record);
    void discard(record);
  }
  function sweep(): void {
    for (const record of owners) if (!current(record)) retire(record);
    for (const [token, ticket] of tickets) if (ticket.expires <= now() && !ticket.pending && !ticket.requestId) {
      tickets.delete(token); void discard(ticket.owner, {previewToken: token});
    }
  }
  function ownerFor(event: E, projectId: string): OwnerRecord<W> {
    const owner = options.ownerForEvent(event);
    if (!ready() || !owner || owner.projectId !== projectId || !owner.key || typeof owner.key !== 'object' ||
        [owner.windowId, owner.backendId, owner.contextId, owner.projectId].some(value => !projectIdSchema.safeParse(value).success)) throw failure();
    let admitted = false; try {admitted = owner.isCurrent();} catch { /* Fail closed. */ }
    if (!admitted) throw failure();
    const known = byKey.get(owner.key);
    if (known && known.owner.windowId === owner.windowId && known.owner.backendId === owner.backendId &&
        known.owner.contextId === owner.contextId && known.owner.projectId === owner.projectId) {
      // The last tuple is a weak-keyed tombstone after explicit invalidation.
      // A briefly stale main currentness callback cannot mint it a new token.
      if (!known.active) throw failure();
      return known;
    }
    if (known) retire(known);
    if (owners.size >= NATIVE_ASSET_MEDIA_LIMITS.tickets) throw failure('ASSET_RELINK_LIMIT');
    const captured: AssetRelinkOwner<W> = Object.freeze({window: owner.window, windowId: owner.windowId, backendId: owner.backendId,
      contextId: owner.contextId, projectId: owner.projectId, key: owner.key, isCurrent: () => owner.isCurrent()});
    const record: OwnerRecord<W> = {owner: captured, token: randomUUID(), controllers: new Set(), active: true};
    byKey.set(owner.key, record); owners.add(record); return record;
  }
  function operation(record: OwnerRecord<W>) {
    const controller = new AbortController(); record.controllers.add(controller);
    const check = (): void => {if (controller.signal.aborted || !current(record)) {retire(record); throw failure();}};
    return {signal: controller.signal, check, finish: () => {record.controllers.delete(controller);}};
  }
  async function dispatch(event: E, raw: unknown): Promise<NativeRelinkPreview | NativeRelinkApplyResult | null | boolean> {
    if (bytes(raw) > NATIVE_ASSET_MEDIA_LIMITS.requestBytes) throw failure('ASSET_RELINK_INVALID', 400);
    const parsed = nativeAssetMediaRequestSchema.safeParse(raw); if (!parsed.success) throw failure('ASSET_RELINK_INVALID', 400);
    sweep();
    const input = parsed.data, record = ownerFor(event, input.projectId);
    if (input.action === 'discard') {
      const ticket = tickets.get(input.previewToken);
      if (!ticket || ticket.owner !== record || ticket.requestId) throw failure();
      tickets.delete(input.previewToken); await discard(record, {previewToken: input.previewToken}); return true;
    }
    if (input.action === 'apply') {
      if (record.unknown && (record.unknown.previewToken !== input.previewToken || record.unknown.requestId !== input.requestId)) throw failure('ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN');
      if (record.applying && (record.applying.previewToken !== input.previewToken || record.applying.requestId !== input.requestId)) throw failure('ASSET_RELINK_BUSY');
      const ticket = tickets.get(input.previewToken);
      if (!ticket || ticket.owner !== record || !ticket.requestId && ticket.expires <= now() || ticket.requestId && ticket.requestId !== input.requestId) throw failure();
      if (ticket.result) return bounded(ticket.result);
      if (ticket.pending) return ticket.pending;
      ticket.requestId = input.requestId;
      const intent = {previewToken: input.previewToken, requestId: input.requestId}; record.applying = intent;
      const active = operation(record);
      const pending = (async (): Promise<NativeRelinkApplyResult> => {
        active.check();
        let rawResult: unknown;
        try {rawResult = await options.backend.apply({...scope(record), previewToken: input.previewToken, requestId: input.requestId}, {signal: active.signal, beforeEffect: active.check});}
        catch (error) {
          if (active.signal.aborted || !current(record) || safeError(error).code === 'ASSET_RELINK_UNAVAILABLE') throw failure('ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN');
          throw error;
        }
        // Once dispatched, a late owner/cancellation observation cannot prove
        // that the mutation did not commit. Keep its original request key.
        if (active.signal.aborted || !current(record)) throw failure('ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN');
        const result = nativeRelinkApplyResultSchema.safeParse(rawResult);
        if (!result.success || result.data.status === 'applied' && result.data.assets.some(asset => asset.projectId !== input.projectId) ||
            bytes({ok: true, data: result.data}) > NATIVE_ASSET_MEDIA_LIMITS.responseBytes) throw failure('ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN');
        if (result.data.status === 'failed' && result.data.error.code === 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN') {record.unknown = intent; return result.data;}
        if (record.unknown?.previewToken === input.previewToken && record.unknown.requestId === input.requestId) record.unknown = undefined;
        ticket.result = result.data; return ticket.result;
      })();
      ticket.pending = pending;
      try {return await pending;}
      catch (error) {
        const code = safeError(error).code;
        if (code === 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN' || code === 'PROJECT_ENTRY_OUTCOME_UNKNOWN') record.unknown = intent;
        throw error;
      }
      finally {if (ticket.pending === pending) ticket.pending = undefined; if (record.applying === intent) record.applying = undefined; active.finish();}
    }
    if (record.unknown) throw failure('ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN');
    if (record.applying) throw failure('ASSET_RELINK_BUSY');
    if (choosing) throw failure('ASSET_RELINK_BUSY');
    if (tickets.size >= NATIVE_ASSET_MEDIA_LIMITS.tickets) throw failure('ASSET_RELINK_LIMIT');
    const flight = {}; choosing = flight;
    const active = operation(record);
    let candidateToken: string | undefined, previewToken: string | undefined, published = false;
    try {
      active.check();
      const sourcePath = await options.chooseFile(record.owner); active.check();
      if (sourcePath === null) return null;
      const candidateInput = nativeRelinkCandidateInputSchema.safeParse({...scope(record), assetId: input.assetId,
        expectedReferenceRevision: input.expectedReferenceRevision, sourcePath});
      if (!candidateInput.success) throw failure('ASSET_RELINK_INVALID', 400);
      const rawCandidate = await options.backend.candidate(candidateInput.data, {signal: active.signal, beforeEffect: active.check});
      active.check();
      const candidate = nativeRelinkCandidateSchema.safeParse(rawCandidate);
      if (!candidate.success || candidate.data.projectId !== input.projectId || candidate.data.assetId !== input.assetId ||
          candidate.data.expectedReferenceRevision !== input.expectedReferenceRevision || candidate.data.confirmationRequired && !candidate.data.outside) throw failure('ASSET_RELINK_PROTOCOL');
      candidateToken = candidate.data.candidateToken;
      let allowOutside = false;
      if (candidate.data.confirmationRequired) {
        allowOutside = await options.confirmOutside(record.owner, {displayPath: candidate.data.displayPath}); active.check();
        if (!allowOutside) return null;
      }
      const rawPreview = await options.backend.preview({...scope(record), candidateToken, allowOutside}, {signal: active.signal, beforeEffect: active.check});
      active.check();
      const preview = nativeRelinkPreviewSchema.safeParse(rawPreview);
      if (!preview.success || preview.data.projectId !== input.projectId || preview.data.assetId !== input.assetId ||
          preview.data.expectedReferenceRevision !== input.expectedReferenceRevision || preview.data.displayPath !== candidate.data.displayPath ||
          preview.data.outside !== candidate.data.outside || tickets.has(preview.data.previewToken)) throw failure('ASSET_RELINK_PROTOCOL');
      previewToken = preview.data.previewToken;
      bounded(preview.data);
      tickets.set(previewToken, {owner: record, preview: preview.data, expires: now() + NATIVE_ASSET_MEDIA_LIMITS.ticketMs});
      published = true; return preview.data;
    } finally {
      active.finish();
      if (!published && (candidateToken || previewToken)) await discard(record, {candidateToken, previewToken});
      if (choosing === flight) choosing = null;
    }
  }
  return {
    dispatch,
    async handle(event: E, raw: unknown): Promise<unknown> {
      try {return {ok: true, data: bounded(await dispatch(event, raw))};}
      catch (error) {return {ok: false, error: safeError(error)};}
    },
    invalidateWindow(windowId: string): void {for (const record of owners) if (record.owner.windowId === windowId) retire(record);},
    dispose(): void {if (disposed) return; disposed = true; for (const record of owners) retire(record); tickets.clear();},
  };
}
