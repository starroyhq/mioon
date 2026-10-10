import { isSubjectListResponse, isSubjectMutationResponse } from '@mioon/contracts';

export const subjectKinds = Object.freeze([['character', '角色'], ['product', '产品'], ['location', '场景'], ['look', '风格']]);
export const subjectKindLabel = kind => subjectKinds.find(([value]) => value === kind)?.[1] || kind;
export const subjectRole = kind => kind === 'look' ? 'style' : 'subject';
export const subjectPageSize = 20;
export const subjectImage = (asset, projectId) => Boolean(asset?.id && asset.projectId === projectId && ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType));
export const filterSubjects = (items, { kind = 'all', search = '' } = {}) => items.filter(item => (kind === 'all' || item.kind === kind) && item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
export const activeSubjectBindings = entry => (entry?.items || []).filter(row => row.subjectVersionId !== null);
export const subjectDraftDirty = state => Boolean(state?.createDraft && (state.createDraft.name || state.createDraft.assetId || state.createDraft.kind !== 'character') || Object.values(state?.versionDrafts || {}).some(draft => draft.assetId) || Object.values(state?.bindingDrafts || {}).some(draft => draft?.subjectId));
const page = () => ({ phase: 'idle', items: [], nextCursor: null, cursor: null, history: [], error: '' });
const createDraft = () => ({ name: '', kind: 'character', assetId: '', serial: 0 });
const initialState = () => ({ scope: null, projectId: null, assets: [], shotIds: [], list: page(), subjects: {}, selectedSubjectId: '', activeShotId: null, versions: {}, bindings: {}, uses: {}, createDraft: createDraft(), versionDrafts: {}, bindingDrafts: {}, saving: null, uncertain: false, mutationError: '' });
const message = error => error?.message || '读取失败，请重新读取。';
const protocolError = () => new Error('主体响应不完整或不匹配，当前状态尚未确认。请重新读取。');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const freeze = value => { const copy = structuredClone(value); const deep = item => { if (item && typeof item === 'object') { Object.values(item).forEach(deep); Object.freeze(item); } return item; }; return deep(copy); };

// The editable binding and the derived subject head have independent clocks.
// A historical receipt may confirm a binding while a later GET already knows
// a newer head. Keep both clocks monotonic without changing that receipt.
export function mergeSubjectBinding(previous, incoming) {
  if (!previous) return incoming;
  if (['id', 'projectId', 'shotId', 'subjectId', 'role', 'createdAt'].some(key => previous[key] !== incoming[key])) throw protocolError();
  if (previous.revision === incoming.revision && ['subjectVersionId', 'reviewedHeadVersionId', 'updatedAt'].some(key => previous[key] !== incoming[key])) throw protocolError();
  if (previous.subjectRevision === incoming.subjectRevision && previous.headVersionId !== incoming.headVersionId) throw protocolError();
  const binding = previous.revision >= incoming.revision ? previous : incoming;
  const head = previous.subjectRevision >= incoming.subjectRevision ? previous : incoming;
  const merged = { ...binding, subjectRevision: head.subjectRevision, headVersionId: head.headVersionId,
    needsReview: binding.subjectVersionId !== null && binding.reviewedHeadVersionId !== head.headVersionId };
  return same(previous, merged) ? previous : merged;
}

// Reads never acknowledge a write. Recovery owns the original durable operation
// identity; this controller only clears a draft for its exact validated ACK.
export function createSubjectController({ read, save, hasPending = () => false, canSave = () => true, requestId = () => crypto.randomUUID(), onChange = () => {} }) {
  let state = initialState(), epoch = 0;
  const generations = new Map();
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  const pending = (projectId = state.projectId) => { try { return Boolean(hasPending(projectId)); } catch { return true; } };
  const captured = () => ({ scope: state.scope, projectId: state.projectId, epoch });
  const current = owner => owner.scope === state.scope && owner.projectId === state.projectId && owner.epoch === epoch;
  const validScope = scope => Boolean(scope && scope === state.scope && state.projectId);
  const nextGeneration = key => { const value = (generations.get(key) || 0) + 1; generations.set(key, value); return value; };
  function mergeSubject(row, into = state.subjects) {
    const previous = into[row.id];
    if (previous && previous.revision === row.revision && !same(previous, row)) throw protocolError();
    return previous && previous.revision > row.revision ? previous : row;
  }
  function installSubjects(rows) {
    const subjects = { ...state.subjects };
    for (const row of rows) subjects[row.id] = mergeSubject(row, subjects);
    return subjects;
  }
  async function readPage(operation, target, options = {}) {
    if (!state.projectId || !state.scope) return null;
    const owner = captured(), key = `${operation}:${options.subjectFilter ? 'subject:' : ''}${target || ''}`, generation = nextGeneration(key);
    const isList = operation === 'subject.list', isVersions = operation === 'subject.version.list', isUses = Boolean(options.subjectFilter);
    const previous = isList ? state.list : (isVersions ? state.versions[target] : isUses ? state.uses[target] : state.bindings[target]) || page();
    const livePage = () => (isList ? state.list : isVersions ? state.versions[target] : isUses ? state.uses[target] : state.bindings[target]) || page();
    const cursor = options.cursor ?? null, history = options.history || [];
    const install = value => isList ? emit({ list: value }) : isVersions ? emit({ versions: { ...state.versions, [target]: value } }) : isUses ? emit({ uses: { ...state.uses, [target]: value } }) : emit({ bindings: { ...state.bindings, [target]: value } });
    install({ ...previous, phase: 'loading', error: '' });
    const input = { projectId: owner.projectId, ...(isVersions ? { subjectId: target } : !isList ? isUses ? { subjectId: target } : { shotId: target } : {}), limit: subjectPageSize, ...(cursor ? { cursor } : {}) };
    try {
      const result = await read(operation, input);
      if (!current(owner) || generations.get(key) !== generation) return null;
      if (!isSubjectListResponse(operation, input, result) || (cursor && result.nextCursor === cursor)) throw protocolError();
      const latest = livePage();
      let items = result.items;
      if (isList) {
        const subjects = installSubjects(items); emit({ subjects }); items = items.map(item => subjects[item.id]);
      } else if (isVersions) {
        const known = latest.known || {};
        if (items.some(item => known[item.id] && !same(known[item.id], item))) throw protocolError();
      } else {
        const known = latest.known || Object.fromEntries(latest.items.map(item => [item.id, item]));
        items = items.map(item => mergeSubjectBinding(known[item.id], item));
        if (options.append && items.some(item => latest.items.some(old => old.id === item.id))) throw protocolError();
        // Bindings are retained as tombstones, never removed. An older complete
        // page must not make a just-confirmed row disappear from the current UI.
        const allIds = new Set([...(options.append ? latest.items : []), ...items].map(item => item.id));
        if (!result.nextCursor && Object.keys(known).some(id => !allIds.has(id))) throw protocolError();
      }
      const value = { phase: 'ready', items: options.append ? [...latest.items, ...items] : items, nextCursor: result.nextCursor, cursor, history, error: '',
        ...(!isList ? { known: { ...latest.known, ...Object.fromEntries(items.map(item => [item.id, item])) } } : {}) };
      install(value); return value;
    } catch (error) {
      if (current(owner) && generations.get(key) === generation) install({ ...livePage(), phase: 'error', error: message(error) });
      return null;
    }
  }
  async function readBindings(shotId, scope = state.scope, more = false) {
    if (!validScope(scope) || !state.shotIds.includes(shotId)) return null;
    const entry = state.bindings[shotId];
    if (more && (!entry?.nextCursor || entry.phase !== 'ready')) return null;
    if (state.activeShotId !== shotId) emit({ activeShotId: shotId });
    return readPage('subject.binding.list', shotId, more ? { cursor: entry.nextCursor, append: true } : {});
  }
  async function refresh() {
    const owner = captured(), selected = state.selectedSubjectId;
    await readPage('subject.list', null, { cursor: state.list.cursor, history: state.list.history });
    if (!current(owner)) return;
    const activeShot = state.activeShotId;
    emit({ bindings: Object.fromEntries(Object.entries(state.bindings).map(([id, entry]) => [id, id === activeShot ? entry : { ...entry, phase: 'stale' }])) });
    await Promise.all([...(selected ? [readPage('subject.version.list', selected), readPage('subject.binding.list', selected, { subjectFilter: true })] : []), ...(activeShot && state.shotIds.includes(activeShot) ? [readBindings(activeShot)] : [])]);
    if (current(owner)) emit({ uncertain: pending() });
  }
  async function submit(operation, input, draftCurrent, clearDraft) {
    if (!state.scope || state.saving || pending() || !canSave() || !draftCurrent()) return null;
    const owner = captured(), exact = freeze({ ...input, requestId: requestId() });
    emit({ saving: operation, mutationError: '', uncertain: false });
    // Any earlier GET cannot install a pre-write view after the acknowledgement.
    for (const key of generations.keys()) nextGeneration(key);
    let acknowledged = null;
    try {
      const result = await save(operation, exact, { canExecute: () => current(owner) && draftCurrent() });
      if (!current(owner)) return null;
      if (!isSubjectMutationResponse(operation, exact, result)) {
        emit({ mutationError: '修改尚未获得完整确认，草稿仍保留。请在任务中心核对原请求。', uncertain: pending() });
      } else {
        if (operation !== 'subject.binding.set') emit({ subjects: installSubjects([result]) });
        else {
          const entry = state.bindings[exact.shotId];
          if (entry) {
            const merged = mergeSubjectBinding(entry.known?.[result.id] || entry.items.find(item => item.id === result.id), result);
            emit({ bindings: { ...state.bindings, [exact.shotId]: { ...entry, known: { ...entry.known, [result.id]: merged }, items: [...entry.items.filter(item => item.id !== result.id), merged] } } });
          }
        }
        if (draftCurrent()) clearDraft(result);
        acknowledged = result;
      }
    } catch (error) {
      if (current(owner)) emit({ mutationError: message(error), uncertain: pending() });
    } finally {
      if (current(owner)) { emit({ saving: null, uncertain: pending() }); await refresh(); }
    }
    return acknowledged;
  }
  const controller = {
    getState: () => state,
    setContext(context) {
      if (!context) {
        epoch++; generations.clear(); emit(initialState()); return;
      }
      const changed = context.scope !== state.scope || context.projectId !== state.projectId;
      if (changed) {
        epoch++; generations.clear(); state = initialState();
      }
      emit({ scope: context.scope, projectId: context.projectId, assets: context.assets || [], shotIds: context.shotIds || [], uncertain: pending(context.projectId) });
      if (changed) { void readPage('subject.list'); if (state.selectedSubjectId) void readPage('subject.version.list', state.selectedSubjectId); }
    },
    read: refresh,
    syncPending() { const uncertain = pending(); if (state.uncertain !== uncertain) emit({ uncertain, ...(!uncertain && !state.saving ? { mutationError: '' } : {}) }); },
    discardDrafts(scope = state.scope) { if (!validScope(scope)) return false; emit({ createDraft: createDraft(), versionDrafts: {}, bindingDrafts: {} }); return true; },
    updateCreate(patch, scope = state.scope) {
      if (!validScope(scope) || state.saving) return;
      const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => ['name', 'kind', 'assetId'].includes(key)));
      emit({ createDraft: { ...state.createDraft, ...allowed, serial: state.createDraft.serial + 1 } });
    },
    resetCreate(scope = state.scope) { if (validScope(scope) && !state.saving) emit({ createDraft: createDraft() }); },
    create(scope = state.scope) {
      const draft = state.createDraft;
      if (!validScope(scope) || !draft.name.trim() || draft.name.trim().length > 120 || !subjectKinds.some(([kind]) => kind === draft.kind) || !state.assets.some(asset => asset.id === draft.assetId && subjectImage(asset, state.projectId))) return Promise.resolve(null);
      return submit('subject.create', { projectId: state.projectId, kind: draft.kind, name: draft.name.trim(), assetId: draft.assetId }, () => state.createDraft === draft, result => emit({ createDraft: createDraft(), selectedSubjectId: result.id }));
    },
    selectSubject(subjectId, scope = state.scope) {
      if (!validScope(scope) || !state.subjects[subjectId]) return;
      emit({ selectedSubjectId: subjectId });
      if (state.versions[subjectId]?.phase !== 'ready') void readPage('subject.version.list', subjectId);
      if (state.uses[subjectId]?.phase !== 'ready') void readPage('subject.binding.list', subjectId, { subjectFilter: true });
    },
    subjectPage(direction, scope = state.scope) {
      if (!validScope(scope) || state.list.phase === 'loading') return;
      const entry = state.list;
      if (direction === 'next' && entry.nextCursor) return readPage('subject.list', null, { cursor: entry.nextCursor, history: [...entry.history, entry.cursor] });
      if (direction === 'previous' && entry.history.length) return readPage('subject.list', null, { cursor: entry.history.at(-1), history: entry.history.slice(0, -1) });
      if (direction === 'first') return readPage('subject.list');
    },
    readVersions(subjectId, scope = state.scope) { if (validScope(scope) && (state.subjects[subjectId] || Object.values(state.bindings).some(entry => entry.items.some(row => row.subjectId === subjectId)))) return readPage('subject.version.list', subjectId); },
    versionPage(subjectId, direction, scope = state.scope) {
      if (!validScope(scope)) return;
      const entry = state.versions[subjectId];
      if (!entry || entry.phase === 'loading') return;
      if (direction === 'next' && entry.nextCursor) return readPage('subject.version.list', subjectId, { cursor: entry.nextCursor, history: [...entry.history, entry.cursor] });
      if (direction === 'previous' && entry.history.length) return readPage('subject.version.list', subjectId, { cursor: entry.history.at(-1), history: entry.history.slice(0, -1) });
    },
    updateVersion(subjectId, assetId, scope = state.scope) {
      const subject = state.subjects[subjectId];
      if (!validScope(scope) || !subject || state.saving) return;
      emit({ versionDrafts: { ...state.versionDrafts, [subjectId]: { assetId, expectedRevision: subject.revision, headVersionId: subject.headVersionId } } });
    },
    addVersion(subjectId, scope = state.scope) {
      const draft = state.versionDrafts[subjectId], subject = state.subjects[subjectId];
      if (!validScope(scope) || !draft?.assetId || !subject || subject.revision !== draft.expectedRevision || !state.assets.some(asset => asset.id === draft.assetId && subjectImage(asset, state.projectId))) return Promise.resolve(null);
      return submit('subject.version.add', { projectId: state.projectId, subjectId, expectedRevision: draft.expectedRevision, assetId: draft.assetId }, () => state.versionDrafts[subjectId] === draft,
        () => emit({ versionDrafts: { ...state.versionDrafts, [subjectId]: { ...draft, assetId: '' } } }));
    },
    readBindings,
    readUses(subjectId, scope = state.scope, more = false) {
      if (!validScope(scope) || !state.subjects[subjectId]) return;
      const entry = state.uses[subjectId];
      if (more && (!entry?.nextCursor || entry.phase !== 'ready')) return;
      return readPage('subject.binding.list', subjectId, { subjectFilter: true, ...(more ? { cursor: entry.nextCursor, append: true } : {}) });
    },
    chooseBinding(shotId, subjectId, subjectVersionId, scope = state.scope) {
      const subject = state.subjects[subjectId], entry = state.bindings[shotId], version = subject?.headVersion.id === subjectVersionId ? subject.headVersion : state.versions[subjectId]?.known?.[subjectVersionId];
      if (!validScope(scope) || state.saving || !state.shotIds.includes(shotId) || !subject || !version || version.subjectId !== subjectId || entry?.phase !== 'ready' || entry.nextCursor) return;
      const binding = entry.items.find(item => item.subjectId === subjectId);
      emit({ bindingDrafts: { ...state.bindingDrafts, [shotId]: { subjectId, subjectVersionId, expectedRevision: binding?.revision || 0, expectedSubjectRevision: subject.revision, role: subjectRole(subject.kind) } } });
      if (!state.versions[subjectId]) void readPage('subject.version.list', subjectId);
    },
    resetBinding(shotId, scope = state.scope) { if (validScope(scope) && !state.saving) emit({ bindingDrafts: { ...state.bindingDrafts, [shotId]: null } }); },
    setBinding(shotId, scope = state.scope) {
      const draft = state.bindingDrafts[shotId], subject = state.subjects[draft?.subjectId], entry = state.bindings[shotId], existing = entry?.items.find(item => item.subjectId === draft?.subjectId);
      if (!validScope(scope) || !draft || !subject || !state.shotIds.includes(shotId) || entry?.phase !== 'ready' || entry.nextCursor || (existing?.revision || 0) !== draft.expectedRevision || subject.revision !== draft.expectedSubjectRevision || !existing?.subjectVersionId && activeSubjectBindings(entry).length >= 8) return Promise.resolve(null);
      return submit('subject.binding.set', { projectId: state.projectId, shotId, ...draft }, () => state.bindingDrafts[shotId] === draft,
        () => emit({ bindingDrafts: { ...state.bindingDrafts, [shotId]: null } }));
    },
    reviewBinding(binding, subjectVersionId, scope = state.scope) {
      const entry = state.bindings[binding?.shotId], live = entry?.items.find(item => item.id === binding?.id);
      if (!validScope(scope) || !live || live !== binding || entry.phase !== 'ready' || entry.nextCursor || !state.shotIds.includes(binding.shotId) || !binding.subjectVersionId || ![null, binding.subjectVersionId, binding.headVersionId].includes(subjectVersionId)) return Promise.resolve(null);
      const input = { projectId: state.projectId, shotId: binding.shotId, subjectId: binding.subjectId, role: binding.role, subjectVersionId, expectedRevision: binding.revision, expectedSubjectRevision: binding.subjectRevision };
      return submit('subject.binding.set', input, () => state.bindings[binding.shotId]?.items.includes(binding), () => {});
    },
    dispose() { epoch++; generations.clear(); state = initialState(); },
  };
  return controller;
}
