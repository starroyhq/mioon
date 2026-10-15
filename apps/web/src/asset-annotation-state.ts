import { message as msg } from '../../../packages/i18n/src/index.ts';
import { ASSET_ANNOTATION_LIMITS, assetAnnotationSchemas, isAssetAnnotationListResponse, isAssetAnnotationResponse } from '../../../packages/contracts/src/asset-annotations.ts';
import type { AssetAnnotation, AssetAnnotationSetInput } from '../../../packages/contracts/src/asset-annotations.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';

export const ANNOTATION_DRAFT_LIMIT = 32;
export const annotationKey = (id: string) => `asset-annotation:${id}`;
type Draft = { tags: string[]; note: string; tagInput: string };
export type AnnotationEntry = { owner: string; projectId: string; assetId: string; row: AssetAnnotation | null; verified: boolean; draft: Draft | null; dirty: boolean; conflict: boolean; loading: boolean; saving: boolean; uncertain: boolean; error: DisplayMessage | null; version: number };
export type AnnotationState = { scope: string | null; ownerScope: string | null; projectId: string | null; assetIds: string[]; entries: Record<string, AnnotationEntry>; loading: boolean; retainedCount: number; dirtyCount: number; uncertainCount: number; version: number; error: DisplayMessage | null };
interface Context { scope: string; ownerScope: string; projectId: string; assetIds: string[] }
const empty = (): AnnotationState => ({ scope: null, ownerScope: null, projectId: null, assetIds: [], entries: {}, loading: false, retainedCount: 0, dirtyCount: 0, uncertainCount: 0, version: 0, error: null });
const sameValue = (a: { tags: string[]; note: string }, b: { tags: string[]; note: string }) => a.note === b.note && JSON.stringify(a.tags) === JSON.stringify(b.tags);
const draftFor = (row: AssetAnnotation): Draft => ({ tags: [...row.tags], note: row.note, tagInput: '' });
export function annotationError(error: any): DisplayMessage {
  return msg(error?.code === 'REVISION_CONFLICT' ? 'annotations.conflict' : error?.code === 'ANNOTATION_REVISION_LIMIT' ? 'annotations.revisionLimit' : error?.code === 'INVALID_ASSET_ANNOTATION_RECORD' ? 'annotations.corrupt' : error?.code === 'RESTORE_OPERATION_UNAVAILABLE' ? 'annotations.readOnly' : error?.code === 'VALIDATION_ERROR' ? 'annotations.invalid' : error?.code === 'IDEMPOTENCY_CONFLICT' ? 'annotations.requestConflict' : error?.code === 'NOT_FOUND' ? 'annotations.missing' : 'annotations.failed');
}
export const annotationRow = (state: AnnotationState | null | undefined, id: string) => { const e = state?.entries[id]; return e && e.verified ? e.row : null; };
export function annotationMatches(state: AnnotationState | null | undefined, id: string, tag: string): boolean { const row = annotationRow(state, id); return !tag || !row || row.tags.includes(tag); }
export function annotationTags(state: AnnotationState | null | undefined): string[] { return [...new Set(Object.keys(state?.entries || {}).flatMap(id => annotationRow(state, id)?.tags || []))].sort((a, b) => a.localeCompare(b)); }
export function createAssetAnnotationController({ read, save, canSave = () => true, hasPending = () => false, pendingAssetIds = () => [], newRequestId = () => globalThis.crypto.randomUUID(), onChange = () => {} }: {
  read(input: { projectId: string; assetIds: string[] }): Promise<unknown>;
  save(input: AssetAnnotationSetInput): Promise<{ result: unknown; failure?: { error: unknown; dispatched: boolean; rejected: boolean } }>;
  pendingAssetIds?(projectId: string, ownerScope: string): readonly string[];
  canSave(): boolean; hasPending(projectId: string, assetId?: string, ownerScope?: string): boolean; newRequestId?(): string; onChange?(state: AnnotationState): void;
}) {
  let state = empty(), generation = 0, active = true;
  const records = new Map<string, AnnotationEntry>();
  const pendingOwners = new Map<string, { projectId: string; ids: readonly string[] | null }>();
  const ownerPending = (projectId: string, owner: string) => { try { const ids = pendingAssetIds(projectId, owner); if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return null; return [...new Set(ids)].sort(); } catch { return null; } };
  function syncOwners() { let changed = false; for (const [owner, entry] of pendingOwners) { const ids = ownerPending(entry.projectId, owner); if (JSON.stringify(entry.ids) !== JSON.stringify(ids)) { entry.ids = ids; changed = true; } if (ids?.length === 0 && owner !== state.ownerScope) pendingOwners.delete(owner); } return changed; }
  function retainedOwners() { return new Set([...records.values()].filter(e => e.dirty || e.saving || e.uncertain).map(e => JSON.stringify([e.owner, e.assetId])).concat([...pendingOwners].flatMap(([owner, entry]) => (entry.ids || []).map(id => JSON.stringify([owner, id]))))); }
  let closeIdentity = '', closeVersion = 0;
  const closeState = () => {
    const retained = [...records.values()].filter(e => e.dirty || e.saving || e.uncertain);
    const identity = JSON.stringify([retained.map(e => [e.owner, e.assetId, e.draft, e.dirty, e.saving, e.uncertain]), [...pendingOwners].filter(([, e]) => e.ids === null || e.ids.length).map(([owner, e]) => [owner, e.ids])]);
    if (identity !== closeIdentity) { closeIdentity = identity; ++closeVersion; }
    return { dirty: retained.some(e => e.dirty), busy: retained.some(e => e.saving), blocked: retained.some(e => e.uncertain) || [...pendingOwners.values()].some(e => e.ids === null || e.ids.length > 0), version: closeVersion || 1 };
  };
  const corruptPending = () => [...pendingOwners.values()].some(entry => entry.ids === null);
  const key = (owner: string, id: string) => JSON.stringify([owner, id]);
  const pending = (projectId: string, id?: string, ownerScope = state.ownerScope) => { try { return hasPending(projectId, id, ownerScope || undefined); } catch { return true; } };
  const retained = (e: AnnotationEntry) => e.dirty || e.saving || e.uncertain;
  const current = (e: AnnotationEntry) => active && state.ownerScope === e.owner && state.projectId === e.projectId && state.assetIds.includes(e.assetId);
  function emit() {
    if (!active) return;
    const all = [...records.values()];
    state = { ...state, entries: Object.fromEntries(state.assetIds.map(id => [id, records.get(key(state.ownerScope!, id))!]).filter(([, value]) => value)), retainedCount: retainedOwners().size, dirtyCount: all.filter(e => e.dirty).length, uncertainCount: Math.max(all.filter(e => e.uncertain).length, [...pendingOwners.values()].reduce((count, entry) => count + (entry.ids?.length ?? 1), 0)), version: state.version + 1 };
    onChange(state);
  }
  function update(e: AnnotationEntry, patch: Partial<AnnotationEntry>) { Object.assign(e, patch, { version: e.version + 1 }); }
  function prune() { for (const [id, e] of records) if (!current(e) && !retained(e)) records.delete(id); }
  function install(e: AnnotationEntry, row: AssetAnnotation) {
    if (e.row && (row.revision < e.row.revision || row.revision === e.row.revision && !sameValue(row, e.row))) {
      if (row.revision < e.row.revision) { update(e, { loading: false }); return; }
      throw new Error('Contradictory annotation revision');
    }
    const changed = e.row && row.revision !== e.row.revision;
    update(e, { row, verified: true, loading: false, error: null, conflict: e.conflict || Boolean(e.dirty && changed), ...(!e.dirty && !e.uncertain && !e.saving ? { draft: draftFor(row), conflict: false } : {}) });
  }
  async function refresh() {
    if (!state.projectId || !state.ownerScope || !active) return;
    const token = ++generation, scope = state.scope, projectId = state.projectId, ids = [...state.assetIds];
    state = { ...state, loading: ids.length > 0 };
    for (const id of ids) { const e = state.entries[id]; if (e) update(e, { loading: true }); }
    emit();
    for (let at = 0; at < ids.length; at += ASSET_ANNOTATION_LIMITS.batch) {
      const batch = ids.slice(at, at + ASSET_ANNOTATION_LIMITS.batch), input = { projectId, assetIds: batch };
      try {
        const result = await read(input);
        if (!active || token !== generation || scope !== state.scope) return;
        if (!isAssetAnnotationListResponse(result, input)) throw new Error('Invalid annotation response');
        // Validate contradictions for the complete batch before installing any item.
        for (const row of result.items) { const old = state.entries[row.assetId]?.row; if (old?.revision === row.revision && !sameValue(old, row)) throw new Error('Contradictory annotation revision'); }
        for (const row of result.items) install(state.entries[row.assetId]!, row);
      } catch (error) {
        if (!active || token !== generation || scope !== state.scope) return;
        for (const id of batch) update(state.entries[id]!, { loading: false, verified: false, error: annotationError(error) });
      }
      emit();
    }
    if (active && token === generation) { state = { ...state, loading: false }; emit(); }
  }
  function editable(id: string, scope: string | null): AnnotationEntry | null {
    const e = state.entries[id];
    if (!active || !scope || scope !== state.scope || !canSave() || !e?.row || !e.draft || e.saving || e.uncertain || pending(e.projectId, id, e.owner)) return null;
    if (!e.dirty && (retainedOwners().size >= ANNOTATION_DRAFT_LIMIT || corruptPending())) { state = { ...state, error: msg('annotations.capacity') }; emit(); return null; }
    return e;
  }
  function change(e: AnnotationEntry, draft: Draft) {
    update(e, { draft, dirty: Boolean(draft.tagInput || !sameValue(draft, e.row!)), error: null });
    state = { ...state, error: null }; emit();
  }
  const controller = {
    getState: () => state,
    setContext(context: Context | null) {
      if (!active) return;
      const ids = context ? [...new Set(context.assetIds)] : [];
      if (context?.scope === state.scope && context?.ownerScope === state.ownerScope && context?.projectId === state.projectId && JSON.stringify(ids) === JSON.stringify(state.assetIds)) return;
      ++generation;
      state = { ...state, scope: context?.scope || null, ownerScope: context?.ownerScope || null, projectId: context?.projectId || null, assetIds: ids, entries: {}, loading: false, error: null };
      if (context) pendingOwners.set(context.ownerScope, { projectId: context.projectId, ids: ownerPending(context.projectId, context.ownerScope) });
      for (const assetId of ids) {
        const id = key(context!.ownerScope, assetId);
        if (!records.has(id)) records.set(id, { owner: context!.ownerScope, projectId: context!.projectId, assetId, row: null, verified: false, draft: null, dirty: false, conflict: false, loading: true, saving: false, uncertain: pending(context!.projectId, assetId, context!.ownerScope), error: null, version: 0 });
      }
      prune(); emit(); void refresh();
    },
    refresh,
    editNote(id: string, value: string, scope = state.scope) { const e = editable(id, scope); if (e && [...value].length <= ASSET_ANNOTATION_LIMITS.noteCodePoints && new TextEncoder().encode(value).length <= ASSET_ANNOTATION_LIMITS.noteBytes) change(e, { ...e.draft!, note: value }); },
    editTagInput(id: string, value: string, scope = state.scope) { const e = editable(id, scope); if (e && [...value].length <= ASSET_ANNOTATION_LIMITS.tagCodePoints && new TextEncoder().encode(value).length <= ASSET_ANNOTATION_LIMITS.tagBytes) change(e, { ...e.draft!, tagInput: value }); },
    addTag(id: string, scope = state.scope) {
      const e = editable(id, scope); if (!e) return;
      const tag = e.draft!.tagInput.trim().normalize('NFC'), tags = [...e.draft!.tags, tag];
      const input = { projectId: e.projectId, assetId: id, expectedRevision: e.row!.revision, requestId: 'validation', tags, note: e.draft!.note };
      if (!assetAnnotationSchemas['asset.annotation.set'].safeParse(input).success) { update(e, { error: msg('annotations.invalidTag') }); emit(); return; }
      change(e, { ...e.draft!, tags, tagInput: '' });
    },
    removeTag(id: string, tag: string, scope = state.scope) { const e = editable(id, scope); if (e) change(e, { ...e.draft!, tags: e.draft!.tags.filter(value => value !== tag) }); },
    clear(id: string, scope = state.scope) { const e = editable(id, scope); if (e) change(e, { tags: [], note: '', tagInput: '' }); },
    discard(id: string, scope = state.scope) { const e = state.entries[id]; if (!active || scope !== state.scope || !e?.row || e.saving || e.uncertain || pending(e.projectId, id, e.owner)) return; update(e, { draft: draftFor(e.row), dirty: false, conflict: false, error: null }); emit(); },
    // Explicitly abandons only local drafts, never an uncertain request.
    discardRetained(version: number) { if (version !== state.version) return false; for (const e of records.values()) if (e.dirty && !e.saving && !e.uncertain && !pending(e.projectId, e.assetId, e.owner)) update(e, { draft: e.row ? draftFor(e.row) : null, dirty: false, conflict: false, error: null }); prune(); emit(); return true; },
    syncPending() { let changed = syncOwners(); for (const e of records.values()) { const uncertain = pending(e.projectId, e.assetId, e.owner); if (!e.saving && e.uncertain !== uncertain) { update(e, { uncertain }); changed = true; } } if (changed) { prune(); emit(); } },
    async save(id: string, scope = state.scope) {
      const e = state.entries[id];
      if (!active || scope !== state.scope || !e?.row || !e.verified || !e.draft || !e.dirty || e.loading || e.saving || e.uncertain || e.conflict || pending(e.projectId) || !canSave()) return null;
      if (e.draft.tagInput) { update(e, { error: msg('annotations.addTagFirst') }); emit(); return null; }
      const input = { projectId: e.projectId, assetId: id, expectedRevision: e.row.revision, requestId: newRequestId(), tags: [...e.draft.tags], note: e.draft.note };
      if (!assetAnnotationSchemas['asset.annotation.set'].safeParse(input).success) { update(e, { error: msg('annotations.invalid') }); emit(); return null; }
      Object.freeze(input.tags); Object.freeze(input);
      update(e, { saving: true, error: null }); emit();
      let acknowledged: AssetAnnotation | null = null;
      try {
        const outcome = await save(input);
        if (!active) return null;
        const result = outcome.result;
        if (isAssetAnnotationResponse(result) && result.projectId === input.projectId && result.assetId === id && result.revision === input.expectedRevision + 1 && sameValue(result, input)) {
          acknowledged = result;
          const latest = e.row && e.row.revision > result.revision ? e.row : result;
          if (e.row?.revision === result.revision && !sameValue(e.row, result)) throw new Error('Contradictory annotation acknowledgement');
          update(e, { row: latest, verified: true, draft: draftFor(latest), dirty: false, conflict: false, uncertain: false });
        } else {
          const failure = outcome.failure;
          update(e, { uncertain: pending(e.projectId, id, e.owner) || Boolean(failure?.dispatched && !failure.rejected), error: failure ? annotationError(failure.error) : msg('annotations.unconfirmed'), conflict: e.conflict || Boolean((failure?.error as any)?.code === 'REVISION_CONFLICT') });
        }
      } catch (error) { if (active) update(e, { uncertain: pending(e.projectId, id, e.owner), error: annotationError(error) }); }
      finally { if (active) { update(e, { saving: false }); prune(); emit(); if (current(e)) await refresh(); } }
      return acknowledged;
    },
    getCloseState: closeState,
    activate() { if (!active) { active = true; emit(); void refresh(); } },
    dispose() { active = false; ++generation; },
  };
  return controller;
}
export type AssetAnnotationController = ReturnType<typeof createAssetAnnotationController>;
