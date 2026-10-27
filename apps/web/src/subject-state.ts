import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { isSubjectListResponse, isSubjectMutationResponse } from '@mioon/contracts';
import type { SubjectBindingResponse, SubjectResponse, SubjectVersionResponse } from '../../../packages/contracts/src/subjects.ts';
import type { SubjectVersionVariant } from '../../../packages/contracts/src/subject-variants.ts';

export type SubjectKind = 'character' | 'product' | 'location' | 'look';
export interface SubjectAsset {
  id?: string;
  projectId?: string;
  mimeType?: string;
  name?: string;
  sha256?: string;
  [key: string]: unknown;
}
export interface SubjectPage<T> {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'stale';
  items: T[];
  nextCursor: string | null;
  cursor: string | null;
  history: (string | null)[];
  error: DisplayMessage | null;
  diagnostic: string;
  known?: Record<string, T>;
}
export type SubjectPageEntry = SubjectPage<SubjectResponse> | SubjectPage<SubjectVersionResponse> | SubjectPage<SubjectBindingResponse>;
export interface SubjectCreateDraft { name: string; kind: string; assetId: string; serial: number }
export interface SubjectVersionDraft { assetId: string; expectedRevision: number; headVersionId: string }
export interface SubjectBindingDraft { subjectId: string; subjectVersionId: string | null; expectedRevision: number; expectedSubjectRevision: number; role: string }
export interface SubjectState {
  scope: string | null;
  projectId: string | null;
  assets: SubjectAsset[];
  shotIds: string[];
  list: SubjectPage<SubjectResponse>;
  subjects: Record<string, SubjectResponse>;
  selectedSubjectId: string;
  activeShotId: string | null;
  versions: Record<string, SubjectPage<SubjectVersionResponse>>;
  bindings: Record<string, SubjectPage<SubjectBindingResponse>>;
  uses: Record<string, SubjectPage<SubjectBindingResponse>>;
  createDraft: SubjectCreateDraft;
  versionDrafts: Record<string, SubjectVersionDraft>;
  bindingDrafts: Record<string, SubjectBindingDraft | null>;
  saving: string | null;
  uncertain: boolean;
  mutationError: DisplayMessage | null;
  mutationDiagnostic: string;
}
export interface SubjectContext { scope: string | null; projectId: string | null; assets?: readonly SubjectAsset[]; shotIds?: readonly string[] }
export interface SubjectPageReadOptions { subjectFilter?: boolean; cursor?: string | null; history?: (string | null)[]; append?: boolean }
export interface SubjectReadInput { projectId: string | null; subjectId?: string; shotId?: string; limit: number; cursor?: string }
export interface SubjectOwner { scope: string | null; projectId: string | null; epoch: number }
export interface SubjectControllerOptions {
  read: (operation: string, input: SubjectReadInput) => Promise<unknown>;
  save: (operation: string, input: Record<string, unknown>, options: { canExecute: () => boolean }) => Promise<unknown>;
  hasPending?: (projectId?: string | null) => boolean;
  canSave?: () => boolean;
  requestId?: () => string;
  onChange?: (state: SubjectState) => void;
}

export const subjectKinds = Object.freeze([['character', '角色'], ['product', '产品'], ['location', '场景'], ['look', '风格']] as const);
export const subjectKindLabel = (kind: string): string => subjectKinds.find(([value]) => value === kind)?.[1] || kind;
const subjectKindKeys = Object.freeze({ character: 'subjects.kind.character', product: 'subjects.kind.product', location: 'subjects.kind.location', look: 'subjects.kind.look' });
export const subjectKindDescriptor = (kind: string): DisplayMessage | string => Object.hasOwn(subjectKindKeys, kind) ? message(subjectKindKeys[kind as keyof typeof subjectKindKeys]) : kind;
export const subjectRole = (kind: string): 'style' | 'subject' => kind === 'look' ? 'style' : 'subject';
// Version labels. Ordinary versions carry no angle tag; a variant shows what it
// re-shot: the camera position and focal length, or the light quality.
const angleKeys = Object.freeze({ front: 'subjects.angle.front', 'front-left': 'subjects.angle.frontLeft', left: 'subjects.angle.left', 'back-left': 'subjects.angle.backLeft', back: 'subjects.angle.back', 'back-right': 'subjects.angle.backRight', right: 'subjects.angle.right', 'front-right': 'subjects.angle.frontRight', high: 'subjects.angle.high', low: 'subjects.angle.low' } as const);
const lightKeys = Object.freeze({ soft: 'subjects.light.soft', hard: 'subjects.light.hard', back: 'subjects.light.back' } as const);
export const subjectAngleDescriptor = (position: string): DisplayMessage | string => Object.hasOwn(angleKeys, position) ? message(angleKeys[position as keyof typeof angleKeys]) : position;
export const subjectLightDescriptor = (quality: string): DisplayMessage | string => Object.hasOwn(lightKeys, quality) ? message(lightKeys[quality as keyof typeof lightKeys]) : quality;
/** The parts of a variant's tag, shown joined by " · "; null for an ordinary version. */
export function subjectVariantTagParts(variant: SubjectVersionVariant | null | undefined): (DisplayMessage | string)[] | null {
  if (!variant) return null;
  if (variant.kind === 'angle') return variant.focal === 'wide' ? [subjectAngleDescriptor(variant.position), message('subjects.angle.wide')] : [subjectAngleDescriptor(variant.position)];
  return [subjectLightDescriptor(variant.quality)];
}
/** What a shot's version filter groups variants by: the camera position and focal length, or the light quality. */
export const subjectVariantKey = (variant: SubjectVersionVariant | null | undefined): string | null => !variant ? null : variant.kind === 'angle' ? `angle:${variant.position}:${variant.focal}` : `light:${variant.quality}`;
// Filters read from the front around to the back, then the heights, standard
// before wide; lighting comes after the angles.
const angleOrder: readonly string[] = ['front', 'front-left', 'front-right', 'left', 'right', 'back-left', 'back-right', 'back', 'high', 'low'];
const lightOrder: readonly string[] = ['soft', 'hard', 'back'];
/** The distinct variant tags among versions, each with one variant that labels it. */
export function subjectVariantFilters(versions: readonly Pick<SubjectVersionResponse, 'variant'>[]): { key: string; variant: SubjectVersionVariant }[] {
  const found = new Map<string, SubjectVersionVariant>();
  for (const version of versions) { const key = subjectVariantKey(version.variant); if (key && version.variant && !found.has(key)) found.set(key, version.variant); }
  const rank = (variant: SubjectVersionVariant): number => variant.kind === 'angle' ? angleOrder.indexOf(variant.position) * 2 + (variant.focal === 'wide' ? 1 : 0) : angleOrder.length * 2 + lightOrder.indexOf(variant.quality);
  return [...found].map(([key, variant]) => ({ key, variant })).sort((a, b) => rank(a.variant) - rank(b.variant));
}
const originKeys = Object.freeze({ 'user-import': 'subjects.origin.import', generated: 'subjects.origin.generated', 'synthetic-mock': 'subjects.origin.mock', export: 'subjects.origin.export', 'extracted-frame': 'subjects.origin.frame' } as const);
/** Where a version's image came from. Variants are made only by GPT Image or
 * the mock service, so a generated or mock variant names its model instead. */
export function subjectVersionOriginDescriptor(version: Pick<SubjectVersionResponse, 'provenance' | 'variant'>): DisplayMessage | string {
  const kind = version.provenance.kind;
  if (version.variant && kind === 'generated') return message('subjects.variant.modelOpenAI');
  if (version.variant && kind === 'synthetic-mock') return message('subjects.variant.modelMock');
  return Object.hasOwn(originKeys, kind) ? message(originKeys[kind]) : kind;
}
export const subjectPageSize = 20;
export const subjectImage = (asset: SubjectAsset | null | undefined, projectId: string | null): boolean => Boolean(asset?.id && asset.projectId === projectId && ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType ?? ''));
export const filterSubjects = (items: readonly SubjectResponse[], { kind = 'all', search = '' }: { kind?: string; search?: string } = {}): SubjectResponse[] => items.filter(item => (kind === 'all' || item.kind === kind) && item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
export const activeSubjectBindings = (entry: Pick<SubjectPage<SubjectBindingResponse>, 'items'> | null | undefined): SubjectBindingResponse[] => (entry?.items || []).filter(row => row.subjectVersionId !== null);
export const subjectDraftDirty = (state: SubjectState | null | undefined): boolean => {
  if (!state) return false;
  return Boolean(state.createDraft && (state.createDraft.name || state.createDraft.assetId || state.createDraft.kind !== 'character') || Object.values(state.versionDrafts).some(draft => Boolean(draft.assetId)) || Object.values(state.bindingDrafts).some(draft => Boolean(draft?.subjectId)));
};
const emptyPage = <T>(): SubjectPage<T> => ({ phase: 'idle', items: [], nextCursor: null, cursor: null, history: [], error: null, diagnostic: '' });
const createDraft = (): SubjectCreateDraft => ({ name: '', kind: 'character', assetId: '', serial: 0 });
const initialState = (): SubjectState => ({ scope: null, projectId: null, assets: [], shotIds: [], list: emptyPage(), subjects: {}, selectedSubjectId: '', activeShotId: null, versions: {}, bindings: {}, uses: {}, createDraft: createDraft(), versionDrafts: {}, bindingDrafts: {}, saving: null, uncertain: false, mutationError: null, mutationDiagnostic: '' });
const failureCode = (error: unknown): string | undefined => error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
const diagnostic = (error: unknown): string => error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '';
const readErrorDescriptor = (error: unknown): DisplayMessage => message(failureCode(error) === 'SUBJECT_RESPONSE_INVALID' ? 'subjects.read.protocol' : 'subjects.read.failed');
const protocolError = (): Error => Object.assign(new Error('主体响应不完整或不匹配，当前状态尚未确认。请重新读取。'), { code: 'SUBJECT_RESPONSE_INVALID' });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const freeze = <T>(value: T): T => { const copy = structuredClone(value); const deep = (item: unknown): unknown => { if (item && typeof item === 'object') { Object.values(item as Record<string, unknown>).forEach(deep); Object.freeze(item); } return item; }; return deep(copy) as T; };

// The editable binding and the derived subject head have independent clocks.
// A historical receipt may confirm a binding while a later GET already knows
// a newer head. Keep both clocks monotonic without changing that receipt.
export function mergeSubjectBinding(previous: SubjectBindingResponse | null | undefined, incoming: SubjectBindingResponse): SubjectBindingResponse {
  if (!previous) return incoming;
  const prev = previous as unknown as Record<string, unknown>, next = incoming as unknown as Record<string, unknown>;
  if (['id', 'projectId', 'shotId', 'subjectId', 'role', 'createdAt'].some(key => prev[key] !== next[key])) throw protocolError();
  if (previous.revision === incoming.revision && ['subjectVersionId', 'reviewedHeadVersionId', 'updatedAt'].some(key => prev[key] !== next[key])) throw protocolError();
  if (previous.subjectRevision === incoming.subjectRevision && previous.headVersionId !== incoming.headVersionId) throw protocolError();
  const binding = previous.revision >= incoming.revision ? previous : incoming;
  const head = previous.subjectRevision >= incoming.subjectRevision ? previous : incoming;
  const merged: SubjectBindingResponse = { ...binding, subjectRevision: head.subjectRevision, headVersionId: head.headVersionId,
    needsReview: binding.subjectVersionId !== null && binding.reviewedHeadVersionId !== head.headVersionId };
  return same(previous, merged) ? previous : merged;
}

// Reads never acknowledge a write. Recovery owns the original durable operation
// identity; this controller only clears a draft for its exact validated ACK.
export function createSubjectController({ read, save, hasPending = () => false, canSave = () => true, requestId = () => crypto.randomUUID(), onChange = () => {} }: SubjectControllerOptions) {
  let state = initialState(), epoch = 0;
  const generations = new Map<string, number>();
  const emit = (patch: Partial<SubjectState>): void => { state = { ...state, ...patch }; onChange(state); };
  const pending = (projectId: string | null = state.projectId): boolean => { try { return Boolean(hasPending(projectId)); } catch { return true; } };
  const captured = (): SubjectOwner => ({ scope: state.scope, projectId: state.projectId, epoch });
  const current = (owner: SubjectOwner): boolean => owner.scope === state.scope && owner.projectId === state.projectId && owner.epoch === epoch;
  const validScope = (scope: string | null): boolean => Boolean(scope && scope === state.scope && state.projectId);
  const nextGeneration = (key: string): number => { const value = (generations.get(key) || 0) + 1; generations.set(key, value); return value; };
  function mergeSubject<R extends { id: string; revision: number }>(row: R, into: Record<string, R>): R {
    const previous = into[row.id];
    if (previous && previous.revision === row.revision && !same(previous, row)) throw protocolError();
    return previous && previous.revision > row.revision ? previous : row;
  }
  function installSubjects(rows: readonly SubjectResponse[]): Record<string, SubjectResponse> {
    const subjects: Record<string, SubjectResponse> = { ...state.subjects };
    for (const row of rows) subjects[row.id] = mergeSubject(row, subjects);
    return subjects;
  }
  async function readPage(operation: string, target: string | null = null, options: SubjectPageReadOptions = {}): Promise<SubjectPageEntry | null> {
    if (!state.projectId || !state.scope) return null;
    const owner = captured(), key = `${operation}:${options.subjectFilter ? 'subject:' : ''}${target || ''}`, generation = nextGeneration(key);
    const targetId = target ?? '';
    const isList = operation === 'subject.list', isVersions = operation === 'subject.version.list', isUses = Boolean(options.subjectFilter);
    const previous: SubjectPageEntry = (isList ? state.list : isVersions ? state.versions[targetId] : isUses ? state.uses[targetId] : state.bindings[targetId]) || emptyPage();
    const livePage = (): SubjectPageEntry => (isList ? state.list : isVersions ? state.versions[targetId] : isUses ? state.uses[targetId] : state.bindings[targetId]) || emptyPage();
    const cursor = options.cursor ?? null, history = options.history || [];
    const install = (value: SubjectPageEntry): void => isList ? emit({ list: value as SubjectPage<SubjectResponse> }) : isVersions ? emit({ versions: { ...state.versions, [targetId]: value as SubjectPage<SubjectVersionResponse> } }) : isUses ? emit({ uses: { ...state.uses, [targetId]: value as SubjectPage<SubjectBindingResponse> } }) : emit({ bindings: { ...state.bindings, [targetId]: value as SubjectPage<SubjectBindingResponse> } });
    install({ ...previous, phase: 'loading', error: null, diagnostic: '' });
    const input: SubjectReadInput = { projectId: owner.projectId, ...(isVersions ? { subjectId: targetId } : !isList ? isUses ? { subjectId: targetId } : { shotId: targetId } : {}), limit: subjectPageSize, ...(cursor ? { cursor } : {}) };
    try {
      const result = await read(operation, input);
      if (!current(owner) || generations.get(key) !== generation) return null;
      if (!isSubjectListResponse(operation, input, result) || !result || typeof result !== 'object') throw protocolError();
      const pageResult = result as { items: (SubjectResponse | SubjectVersionResponse | SubjectBindingResponse)[]; nextCursor: string | null };
      if (cursor && pageResult.nextCursor === cursor) throw protocolError();
      const latest = livePage();
      const valueBase = { phase: 'ready' as const, nextCursor: pageResult.nextCursor || null, cursor, history, error: null, diagnostic: '' };
      if (isList) {
        const subjects = installSubjects(pageResult.items as SubjectResponse[]); emit({ subjects });
        const items = (pageResult.items as SubjectResponse[]).map(item => subjects[item.id]);
        const value: SubjectPage<SubjectResponse> = { ...valueBase, items };
        install(value); return value;
      }
      if (isVersions) {
        const latestVersions = latest as SubjectPage<SubjectVersionResponse>, known = latestVersions.known || {};
        const versionItems = pageResult.items as SubjectVersionResponse[];
        if (versionItems.some(item => known[item.id] && !same(known[item.id], item))) throw protocolError();
        const items = options.append ? [...latestVersions.items, ...versionItems] : versionItems;
        const value: SubjectPage<SubjectVersionResponse> = { ...valueBase, items, known: { ...known, ...Object.fromEntries(versionItems.map(item => [item.id, item])) } };
        install(value); return value;
      }
      const latestBindings = latest as SubjectPage<SubjectBindingResponse>;
      const known = latestBindings.known || Object.fromEntries(latestBindings.items.map(item => [item.id, item]));
      const items = (pageResult.items as SubjectBindingResponse[]).map(item => mergeSubjectBinding(known[item.id], item));
      if (options.append && items.some(item => latestBindings.items.some(old => old.id === item.id))) throw protocolError();
      // Bindings are retained as tombstones, never removed. An older complete
      // page must not make a just-confirmed row disappear from the current UI.
      const allIds = new Set([...(options.append ? latestBindings.items : []), ...items].map(item => item.id));
      if (!pageResult.nextCursor && Object.keys(known).some(id => !allIds.has(id))) throw protocolError();
      const allItems = options.append ? [...latestBindings.items, ...items] : items;
      const value: SubjectPage<SubjectBindingResponse> = { ...valueBase, items: allItems, known: { ...known, ...Object.fromEntries(items.map(item => [item.id, item])) } };
      install(value); return value;
    } catch (error) {
      if (current(owner) && generations.get(key) === generation) install({ ...livePage(), phase: 'error', error: readErrorDescriptor(error), diagnostic: diagnostic(error) });
      return null;
    }
  }
  async function readBindings(shotId: string, scope: string | null = state.scope, more = false): Promise<SubjectPageEntry | null> {
    if (!validScope(scope) || !state.shotIds.includes(shotId)) return null;
    const entry = state.bindings[shotId];
    if (more && (!entry?.nextCursor || entry.phase !== 'ready')) return null;
    if (state.activeShotId !== shotId) emit({ activeShotId: shotId });
    return readPage('subject.binding.list', shotId, more ? { cursor: entry.nextCursor, append: true } : {});
  }
  async function refresh(): Promise<void> {
    const owner = captured(), selected = state.selectedSubjectId;
    await readPage('subject.list', null, { cursor: state.list.cursor, history: state.list.history });
    if (!current(owner)) return;
    const activeShot = state.activeShotId;
    emit({ bindings: Object.fromEntries(Object.entries(state.bindings).map(([id, entry]) => [id, id === activeShot ? entry : { ...entry, phase: 'stale' as const }])) as Record<string, SubjectPage<SubjectBindingResponse>> });
    await Promise.all([...(selected ? [readPage('subject.version.list', selected), readPage('subject.binding.list', selected, { subjectFilter: true })] : []), ...(activeShot && state.shotIds.includes(activeShot) ? [readBindings(activeShot)] : [])]);
    if (current(owner)) emit({ uncertain: pending() });
  }
  async function submit(operation: string, input: Record<string, unknown>, draftCurrent: () => boolean, clearDraft: (result: SubjectResponse | SubjectBindingResponse) => void): Promise<SubjectResponse | SubjectBindingResponse | null> {
    if (!state.scope || state.saving || pending() || !canSave() || !draftCurrent()) return null;
    const owner = captured(), exact: Record<string, unknown> = freeze({ ...input, requestId: requestId() });
    emit({ saving: operation, mutationError: null, mutationDiagnostic: '', uncertain: false });
    // Any earlier GET cannot install a pre-write view after the acknowledgement.
    for (const key of generations.keys()) nextGeneration(key);
    let acknowledged: SubjectResponse | SubjectBindingResponse | null = null;
    try {
      const result = await save(operation, exact, { canExecute: () => current(owner) && draftCurrent() });
      if (!current(owner)) return null;
      if (!isSubjectMutationResponse(operation, exact, result)) {
        emit({ mutationError: message('subjects.mutation.unconfirmed'), uncertain: pending() });
      } else {
        if (operation !== 'subject.binding.set') emit({ subjects: installSubjects([result as SubjectResponse]) });
        else {
          const shotId = typeof exact.shotId === 'string' ? exact.shotId : '';
          const entry = state.bindings[shotId];
          if (entry) {
            const bindingResult = result as SubjectBindingResponse;
            const merged = mergeSubjectBinding(entry.known?.[bindingResult.id] || entry.items.find(item => item.id === bindingResult.id), bindingResult);
            emit({ bindings: { ...state.bindings, [shotId]: { ...entry, known: { ...entry.known, [bindingResult.id]: merged }, items: [...entry.items.filter(item => item.id !== bindingResult.id), merged] } } });
          }
        }
        if (draftCurrent()) clearDraft(result as SubjectResponse | SubjectBindingResponse);
        acknowledged = result as SubjectResponse | SubjectBindingResponse;
      }
    } catch (error) {
      if (current(owner)) emit({ mutationError: message('subjects.mutation.failed'), mutationDiagnostic: diagnostic(error), uncertain: pending() });
    } finally {
      if (current(owner)) { emit({ saving: null, uncertain: pending() }); await refresh(); }
    }
    return acknowledged;
  }
  const controller = {
    getState: (): SubjectState => state,
    setContext(context: SubjectContext | null): void {
      if (!context) {
        epoch++; generations.clear(); emit(initialState()); return;
      }
      const changed = context.scope !== state.scope || context.projectId !== state.projectId;
      if (changed) {
        epoch++; generations.clear(); state = initialState();
      }
      emit({ scope: context.scope, projectId: context.projectId, assets: [...(context.assets || [])], shotIds: [...(context.shotIds || [])], uncertain: pending(context.projectId) });
      if (changed) { void readPage('subject.list'); if (state.selectedSubjectId) void readPage('subject.version.list', state.selectedSubjectId); }
    },
    read: refresh,
    syncPending(): void { const uncertain = pending(); if (state.uncertain !== uncertain) emit({ uncertain, ...(!uncertain && !state.saving ? { mutationError: null, mutationDiagnostic: '' } : {}) }); },
    discardDrafts(scope: string | null = state.scope): boolean { if (!validScope(scope)) return false; emit({ createDraft: createDraft(), versionDrafts: {}, bindingDrafts: {} }); return true; },
    updateCreate(patch: Record<string, unknown>, scope: string | null = state.scope): void {
      if (!validScope(scope) || state.saving) return;
      const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => ['name', 'kind', 'assetId'].includes(key)));
      emit({ createDraft: { ...state.createDraft, ...allowed, serial: state.createDraft.serial + 1 } as SubjectCreateDraft });
    },
    resetCreate(scope: string | null = state.scope): void { if (validScope(scope) && !state.saving) emit({ createDraft: createDraft() }); },
    create(scope: string | null = state.scope): Promise<SubjectResponse | SubjectBindingResponse | null> {
      const draft = state.createDraft;
      if (!validScope(scope) || !draft.name.trim() || draft.name.trim().length > 120 || !subjectKinds.some(([kind]) => kind === draft.kind) || !state.assets.some(asset => asset.id === draft.assetId && subjectImage(asset, state.projectId))) return Promise.resolve(null);
      return submit('subject.create', { projectId: state.projectId, kind: draft.kind, name: draft.name.trim(), assetId: draft.assetId }, () => state.createDraft === draft, result => emit({ createDraft: createDraft(), selectedSubjectId: result.id }));
    },
    selectSubject(subjectId: string, scope: string | null = state.scope): void {
      if (!validScope(scope) || !state.subjects[subjectId]) return;
      emit({ selectedSubjectId: subjectId });
      if (state.versions[subjectId]?.phase !== 'ready') void readPage('subject.version.list', subjectId);
      if (state.uses[subjectId]?.phase !== 'ready') void readPage('subject.binding.list', subjectId, { subjectFilter: true });
    },
    subjectPage(direction: string, scope: string | null = state.scope): Promise<SubjectPageEntry | null> | void {
      if (!validScope(scope) || state.list.phase === 'loading') return;
      const entry = state.list;
      if (direction === 'next' && entry.nextCursor) return readPage('subject.list', null, { cursor: entry.nextCursor, history: [...entry.history, entry.cursor] });
      if (direction === 'previous' && entry.history.length) return readPage('subject.list', null, { cursor: entry.history.at(-1), history: entry.history.slice(0, -1) });
      if (direction === 'first') return readPage('subject.list');
    },
    readVersions(subjectId: string, scope: string | null = state.scope): Promise<SubjectPageEntry | null> | void { if (validScope(scope) && (state.subjects[subjectId] || Object.values(state.bindings).some(entry => entry.items.some(row => row.subjectId === subjectId)))) return readPage('subject.version.list', subjectId); },
    /** Drops versions an undone variant batch hid: a hidden version can no
     * longer be chosen for a shot, so neither it nor a draft choosing it is kept. */
    forgetVersions(subjectId: string, versionIds: readonly string[]): void {
      const entry = state.versions[subjectId], hidden = new Set(versionIds);
      const drafts = Object.entries(state.bindingDrafts).filter(([, draft]) => draft?.subjectId === subjectId && hidden.has(draft.subjectVersionId ?? ''));
      if (!hidden.size || !entry?.items.some(item => hidden.has(item.id)) && !Object.keys(entry?.known || {}).some(id => hidden.has(id)) && !drafts.length) return;
      emit({ ...(entry ? { versions: { ...state.versions, [subjectId]: { ...entry, items: entry.items.filter(item => !hidden.has(item.id)), known: Object.fromEntries(Object.entries(entry.known || {}).filter(([id]) => !hidden.has(id))) } } } : {}),
        ...(drafts.length ? { bindingDrafts: { ...state.bindingDrafts, ...Object.fromEntries(drafts.map(([shotId]) => [shotId, null])) } } : {}) });
    },
    versionPage(subjectId: string, direction: string, scope: string | null = state.scope): Promise<SubjectPageEntry | null> | void {
      if (!validScope(scope)) return;
      const entry = state.versions[subjectId];
      if (!entry || entry.phase === 'loading') return;
      if (direction === 'next' && entry.nextCursor) return readPage('subject.version.list', subjectId, { cursor: entry.nextCursor, history: [...entry.history, entry.cursor] });
      if (direction === 'previous' && entry.history.length) return readPage('subject.version.list', subjectId, { cursor: entry.history.at(-1), history: entry.history.slice(0, -1) });
    },
    updateVersion(subjectId: string, assetId: string, scope: string | null = state.scope): void {
      const subject = state.subjects[subjectId];
      if (!validScope(scope) || !subject || state.saving) return;
      emit({ versionDrafts: { ...state.versionDrafts, [subjectId]: { assetId, expectedRevision: subject.revision, headVersionId: subject.headVersionId } } });
    },
    addVersion(subjectId: string, scope: string | null = state.scope): Promise<SubjectResponse | SubjectBindingResponse | null> {
      const draft = state.versionDrafts[subjectId], subject = state.subjects[subjectId];
      if (!validScope(scope) || !draft?.assetId || !subject || subject.revision !== draft.expectedRevision || !state.assets.some(asset => asset.id === draft.assetId && subjectImage(asset, state.projectId))) return Promise.resolve(null);
      return submit('subject.version.add', { projectId: state.projectId, subjectId, expectedRevision: draft.expectedRevision, assetId: draft.assetId }, () => state.versionDrafts[subjectId] === draft,
        () => emit({ versionDrafts: { ...state.versionDrafts, [subjectId]: { ...draft, assetId: '' } } }));
    },
    readBindings,
    readUses(subjectId: string, scope: string | null = state.scope, more = false): Promise<SubjectPageEntry | null> | void {
      if (!validScope(scope) || !state.subjects[subjectId]) return;
      const entry = state.uses[subjectId];
      if (more && (!entry?.nextCursor || entry.phase !== 'ready')) return;
      return readPage('subject.binding.list', subjectId, { subjectFilter: true, ...(more ? { cursor: entry.nextCursor, append: true } : {}) });
    },
    chooseBinding(shotId: string, subjectId: string, subjectVersionId: string | null, scope: string | null = state.scope): void {
      const subject = state.subjects[subjectId], entry = state.bindings[shotId], version = subject?.headVersion.id === subjectVersionId ? subject.headVersion : state.versions[subjectId]?.known?.[subjectVersionId ?? ''];
      if (!validScope(scope) || state.saving || !state.shotIds.includes(shotId) || !subject || !version || version.subjectId !== subjectId || entry?.phase !== 'ready' || entry.nextCursor) return;
      const binding = entry.items.find(item => item.subjectId === subjectId);
      emit({ bindingDrafts: { ...state.bindingDrafts, [shotId]: { subjectId, subjectVersionId, expectedRevision: binding?.revision || 0, expectedSubjectRevision: subject.revision, role: subjectRole(subject.kind) } } });
      if (!state.versions[subjectId]) void readPage('subject.version.list', subjectId);
    },
    resetBinding(shotId: string, scope: string | null = state.scope): void { if (validScope(scope) && !state.saving) emit({ bindingDrafts: { ...state.bindingDrafts, [shotId]: null } }); },
    setBinding(shotId: string, scope: string | null = state.scope): Promise<SubjectResponse | SubjectBindingResponse | null> {
      const draft = state.bindingDrafts[shotId], subject = state.subjects[draft?.subjectId ?? ''], entry = state.bindings[shotId], existing = entry?.items.find(item => item.subjectId === draft?.subjectId);
      if (!validScope(scope) || !draft || !subject || !state.shotIds.includes(shotId) || entry?.phase !== 'ready' || entry.nextCursor || (existing?.revision || 0) !== draft.expectedRevision || subject.revision !== draft.expectedSubjectRevision || !existing?.subjectVersionId && activeSubjectBindings(entry).length >= 8) return Promise.resolve(null);
      return submit('subject.binding.set', { projectId: state.projectId, shotId, ...draft }, () => state.bindingDrafts[shotId] === draft,
        () => emit({ bindingDrafts: { ...state.bindingDrafts, [shotId]: null } }));
    },
    reviewBinding(binding: SubjectBindingResponse | null | undefined, subjectVersionId: string | null, scope: string | null = state.scope): Promise<SubjectResponse | SubjectBindingResponse | null> {
      const entry = state.bindings[binding?.shotId ?? ''], live = entry?.items.find(item => item.id === binding?.id);
      if (!validScope(scope) || !live || live !== binding || entry.phase !== 'ready' || entry.nextCursor || !state.shotIds.includes(binding?.shotId ?? '') || !binding?.subjectVersionId || ![null, binding.subjectVersionId, binding.headVersionId].includes(subjectVersionId)) return Promise.resolve(null);
      const input = { projectId: state.projectId, shotId: binding.shotId, subjectId: binding.subjectId, role: binding.role, subjectVersionId, expectedRevision: binding.revision, expectedSubjectRevision: binding.subjectRevision };
      return submit('subject.binding.set', input, () => Boolean(state.bindings[binding?.shotId ?? '']?.items.includes(binding as SubjectBindingResponse)), () => {});
    },
    dispose(): void { epoch++; generations.clear(); state = initialState(); },
  };
  return controller;
}
