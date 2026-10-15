import { message as msg } from '../../../packages/i18n/src/index.ts';
import { ASSET_DISPOSITIONS, ASSET_DISPOSITION_BATCH_LIMIT, isAssetDispositionResponse, isAssetDispositionListResponse } from '@mioon/contracts';

export const dispositionLabels = Object.freeze({ neutral: msg('assets.mark.neutral'), favorite: msg('assets.mark.favorite'), rejected: msg('assets.mark.rejected') });
export const dispositionFilters = Object.freeze([['all', msg('assets.all')], ['favorite', msg('assets.mark.favorite')], ['rejected', msg('assets.mark.rejected')], ['neutral', msg('assets.mark.neutral')]]);
export const dispositionKey = assetId => `asset-disposition:${assetId}`;
export function dispositionRow(state, assetId) {
  const entry = state?.entries?.[assetId];
  return entry?.phase === 'ready' ? entry.row : null;
}
export function dispositionCounts(state, assets) {
  const counts = { all: assets.length, neutral: 0, favorite: 0, rejected: 0, unknown: 0 };
  for (const asset of assets) { const row = dispositionRow(state, asset.id); counts[row?.disposition || 'unknown']++; }
  return counts;
}
// Unknown rows stay visible under every disposition filter, with an explicit
// unknown label. Missing metadata is never silently interpreted as neutral.
export function matchesDisposition(state, assetId, filter) {
  const row = dispositionRow(state, assetId);
  return filter === 'all' || !row || row.disposition === filter;
}
export function filterLibraryAssets(assets, { type = 'all', search = '', disposition = 'all', state } = {}) {
  return assets.filter(asset => (type === 'all' || asset.mimeType?.startsWith(`${type}/`)) && asset.name.toLowerCase().includes(search.toLowerCase()) && matchesDisposition(state, asset.id, disposition));
}
const initialState = () => ({ scope: null, projectId: null, assetIds: [], entries: {}, loading: false, savingAssetId: null, mutationError: '', uncertain: false });
const readError = error => error?.displayMessage || msg('assets.mark.readError');
const protocolError = () => Object.assign(new Error('标记响应不完整或不匹配；此批状态未知，请重新读取。'), { displayMessage: msg('assets.mark.protocolError') });

// All asynchronous results are bound to a project epoch; read generations and
// independent per-asset revisions prevent late GETs or ACKs from going backward.
export function createAssetDispositionController({ read, save, hasPending = () => false, canSave = () => true, onChange = () => {} }) {
  let state = initialState(), epoch = 0, readGeneration = 0;
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  const pending = () => { try { return Boolean(hasPending(state.projectId)); } catch { return true; } };
  const current = captured => captured.epoch === epoch && captured.scope === state.scope && captured.projectId === state.projectId;
  const capture = () => ({ epoch, scope: state.scope, projectId: state.projectId });
  function install(assetId, row) {
    const previous = state.entries[assetId]?.row;
    if (previous && previous.revision === row.revision && previous.disposition !== row.disposition) throw protocolError();
    return { phase: 'ready', row: previous && previous.revision > row.revision ? previous : row, error: '' };
  }
  async function readCurrent({ clearMutationError = true } = {}) {
    if (!state.projectId || !state.scope) return;
    const captured = capture(), generation = ++readGeneration, ids = [...state.assetIds];
    emit({ loading: ids.length > 0, uncertain: pending(), entries: Object.fromEntries(ids.map(id => [id, { ...state.entries[id], phase: 'loading', error: '' }])) });
    for (let offset = 0; offset < ids.length; offset += ASSET_DISPOSITION_BATCH_LIMIT) {
      if (!current(captured) || generation !== readGeneration) return;
      const batch = ids.slice(offset, offset + ASSET_DISPOSITION_BATCH_LIMIT), input = { projectId: captured.projectId, assetIds: batch };
      try {
        const result = await read(input);
        if (!current(captured) || generation !== readGeneration) return;
        if (!isAssetDispositionListResponse(result, input)) throw protocolError();
        // Validate the whole batch before installing any row from it.
        const next = Object.fromEntries(result.items.map(row => [row.assetId, install(row.assetId, row)]));
        emit({ entries: { ...state.entries, ...next } });
      } catch (error) {
        if (!current(captured) || generation !== readGeneration) return;
        emit({ entries: { ...state.entries, ...Object.fromEntries(batch.map(id => [id, { ...state.entries[id], phase: 'error', error: readError(error) }])) } });
      }
    }
    if (current(captured) && generation === readGeneration) emit({ loading: false, uncertain: pending(), ...(clearMutationError && !pending() ? { mutationError: '' } : {}) });
  }
  const controller = {
    getState: () => state,
    setContext(context) {
      if (!context) { epoch++; readGeneration++; emit(initialState()); return; }
      const ids = [...new Set(context.assetIds)];
      if (context.scope === state.scope && context.projectId === state.projectId && JSON.stringify(ids) === JSON.stringify(state.assetIds)) return;
      const changedProject = context.scope !== state.scope || context.projectId !== state.projectId;
      if (changedProject) { epoch++; readGeneration++; state = initialState(); }
      emit({ scope: context.scope, projectId: context.projectId, assetIds: ids, entries: Object.fromEntries(ids.map(id => [id, state.entries[id] || { phase: 'loading', row: null, error: '' }])) });
      void readCurrent();
    },
    read: readCurrent,
    syncPending() { const uncertain = pending(); if (state.uncertain !== uncertain) emit({ uncertain, ...(!uncertain ? { mutationError: '' } : {}) }); },
    async set(assetId, disposition, scope = state.scope) {
      const row = dispositionRow(state, assetId);
      if (!scope || scope !== state.scope || !ASSET_DISPOSITIONS.includes(disposition) || !row || row.disposition === disposition || state.savingAssetId || pending() || !canSave()) return null;
      const captured = capture(), input = { projectId: state.projectId, assetId, expectedRevision: row.revision, disposition };
      emit({ savingAssetId: assetId, mutationError: '', uncertain: false });
      let acknowledged = null;
      try {
        const result = await save(input);
        if (!current(captured) || !state.assetIds.includes(assetId)) return null;
        if (!isAssetDispositionResponse(result) || result.projectId !== input.projectId || result.assetId !== assetId || result.revision !== input.expectedRevision + 1 || result.disposition !== disposition) {
          emit({ mutationError: msg('assets.mark.unconfirmed'), uncertain: pending() });
        } else {
          emit({ entries: { ...state.entries, [assetId]: install(assetId, result) } });
          acknowledged = result;
        }
      } catch (error) {
        if (current(captured)) emit({ mutationError: error?.displayMessage || msg('assets.mark.unconfirmed'), uncertain: pending() });
      } finally {
        if (current(captured)) {
          emit({ savingAssetId: null });
          // This is a latest-state GET, never a replay or a new mutation key.
          await readCurrent({ clearMutationError: false });
        }
      }
      return acknowledged;
    },
    dispose() { epoch++; readGeneration++; state = initialState(); },
  };
  return controller;
}
