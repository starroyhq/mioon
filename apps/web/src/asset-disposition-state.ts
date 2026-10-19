import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { ASSET_DISPOSITIONS, ASSET_DISPOSITION_BATCH_LIMIT, isAssetDispositionResponse, isAssetDispositionListResponse } from '@mioon/contracts';
export type AssetDisposition=(typeof ASSET_DISPOSITIONS)[number];
export interface AssetDispositionResponse {id: string; assetId: string; projectId: string; revision: number; disposition: AssetDisposition}
export interface AssetDispositionListInput {projectId: string; assetIds: string[]}

export type DispositionFilter='all'|'favorite'|'rejected'|'neutral';
export interface AssetDispositionRow extends AssetDispositionResponse {}
export interface DispositionEntry {phase: string; row: AssetDispositionRow|null; error: unknown}
export interface AssetDispositionState {
  scope: unknown;
  projectId: string|null;
  assetIds: string[];
  entries: Record<string,DispositionEntry>;
  loading: boolean;
  savingAssetId: string|null;
  mutationError: DisplayMessage|string;
  uncertain: boolean;
}
export interface AssetDispositionContext {readonly scope?: unknown; readonly projectId?: string; readonly assetIds: readonly string[]}
export interface AssetDispositionControllerOptions {
  read: (input: AssetDispositionListInput)=>Promise<unknown>;
  save: (input: {projectId: string; assetId: string; expectedRevision: number; disposition: AssetDisposition; requestId?: string})=>Promise<unknown>;
  hasPending?: (projectId: string|null)=>boolean;
  canSave?: ()=>boolean;
  onChange?: (state: AssetDispositionState)=>void;
}
export interface AssetDispositionController {
  getState(): AssetDispositionState;
  setContext(context: AssetDispositionContext|null|undefined): void;
  read(options?: {clearMutationError?: boolean}): Promise<void>;
  syncPending(): void;
  set(assetId: string, disposition: AssetDisposition, scope?: unknown): Promise<AssetDispositionResponse|null>;
  dispose(): void;
}
export interface LibraryAsset {readonly id: string; readonly name: string; readonly mimeType?: string; readonly [key: string]: unknown}
export interface FilterLibraryAssetsOptions {type?: string; search?: string; disposition?: DispositionFilter; state?: AssetDispositionState}

export const dispositionLabels: Readonly<Record<AssetDisposition,DisplayMessage>> = Object.freeze({ neutral: msg('assets.mark.neutral'), favorite: msg('assets.mark.favorite'), rejected: msg('assets.mark.rejected') });
export const dispositionFilters: readonly (readonly [DispositionFilter,DisplayMessage])[] = Object.freeze([['all', msg('assets.all')], ['favorite', msg('assets.mark.favorite')], ['rejected', msg('assets.mark.rejected')], ['neutral', msg('assets.mark.neutral')]]);
export const dispositionKey=(assetId: string): string=>`asset-disposition:${assetId}`;
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const errorDisplayMessage=(error: unknown): DisplayMessage|undefined=>{const value=property(error,'displayMessage');return isRecord(value)&&typeof value.key==='string'?value as unknown as DisplayMessage:undefined;};
export function dispositionRow(state: AssetDispositionState|null|undefined,assetId: string): AssetDispositionRow|null {
  const entry = state?.entries?.[assetId];
  return entry?.phase === 'ready' ? entry.row : null;
}
export function dispositionCounts(state: AssetDispositionState|null|undefined,assets: readonly LibraryAsset[]) {
  const counts: Record<string,number> = { all: assets.length, neutral: 0, favorite: 0, rejected: 0, unknown: 0 };
  for (const asset of assets) { const row = dispositionRow(state, asset.id); counts[row?.disposition || 'unknown'] = (counts[row?.disposition || 'unknown'] ?? 0) + 1; }
  return counts;
}
// Unknown rows stay visible under every disposition filter, with an explicit
// unknown label. Missing metadata is never silently interpreted as neutral.
export function matchesDisposition(state: AssetDispositionState|null|undefined,assetId: string,filter: DispositionFilter): boolean {
  const row = dispositionRow(state, assetId);
  return filter === 'all' || !row || row.disposition === filter;
}
export function filterLibraryAssets(assets: readonly LibraryAsset[],{ type = 'all', search = '', disposition = 'all', state }: FilterLibraryAssetsOptions = {}): LibraryAsset[] {
  return assets.filter(asset => (type === 'all' || String(asset.mimeType ?? '').startsWith(`${type}/`)) && asset.name.toLowerCase().includes(search.toLowerCase()) && matchesDisposition(state, asset.id, disposition));
}
const initialState=(): AssetDispositionState => ({ scope: null, projectId: null, assetIds: [], entries: {}, loading: false, savingAssetId: null, mutationError: '', uncertain: false });
const readError=(error: unknown): DisplayMessage => errorDisplayMessage(error) || msg('assets.mark.readError');
const protocolError=(): Error&{displayMessage: DisplayMessage} => Object.assign(new Error('标记响应不完整或不匹配；此批状态未知，请重新读取。'), { displayMessage: msg('assets.mark.protocolError') });
const entry=(state: AssetDispositionState,id: string,fallback: DispositionEntry): DispositionEntry => state.entries[id] ?? fallback;

// All asynchronous results are bound to a project epoch; read generations and
// independent per-asset revisions prevent late GETs or ACKs from going backward.
export function createAssetDispositionController({ read, save, hasPending = () => false, canSave = () => true, onChange = () => {} }: AssetDispositionControllerOptions): AssetDispositionController {
  let state = initialState(), epoch = 0, readGeneration = 0;
  const emit = (patch: Partial<AssetDispositionState>): void => { state = { ...state, ...patch }; onChange(state); };
  const pending = (): boolean => { try { return Boolean(hasPending(state.projectId)); } catch { return true; } };
  const current = (captured: {epoch: number;scope: unknown;projectId: string|null}): boolean => captured.epoch === epoch && captured.scope === state.scope && captured.projectId === state.projectId;
  const capture = (): {epoch: number;scope: unknown;projectId: string|null} => ({ epoch, scope: state.scope, projectId: state.projectId });
  function install(assetId: string,row: AssetDispositionRow): DispositionEntry {
    const previous = state.entries[assetId]?.row;
    if (previous && previous.revision === row.revision && previous.disposition !== row.disposition) throw protocolError();
    return { phase: 'ready', row: previous && previous.revision > row.revision ? previous : row, error: '' };
  }
  async function readCurrent({ clearMutationError = true }: {clearMutationError?: boolean} = {}): Promise<void> {
    if (!state.projectId || !state.scope) return;
    const captured = capture(), generation = ++readGeneration, ids = [...state.assetIds];
    emit({ loading: ids.length > 0, uncertain: pending(), entries: Object.fromEntries(ids.map(id => [id, { ...entry(state,id,{phase:'loading',row:null,error:''}), phase: 'loading', error: '' }])) });
    for (let offset = 0; offset < ids.length; offset += ASSET_DISPOSITION_BATCH_LIMIT) {
      if (!current(captured) || generation !== readGeneration) return;
      const batch = ids.slice(offset, offset + ASSET_DISPOSITION_BATCH_LIMIT), input: AssetDispositionListInput = { projectId: state.projectId, assetIds: batch };
      try {
        const result = await read(input);
        if (!current(captured) || generation !== readGeneration) return;
        if (!isAssetDispositionListResponse(result, input)) throw protocolError();
        const next = Object.fromEntries(result.items.map(row => [row.assetId, install(row.assetId, row)]));
        emit({ entries: { ...state.entries, ...next } });
      } catch (error) {
        if (!current(captured) || generation !== readGeneration) return;
        emit({ entries: { ...state.entries, ...Object.fromEntries(batch.map(id => [id, { ...entry(state,id,{phase:'loading',row:null,error:''}), phase: 'error', error: readError(error) }])) } });
      }
    }
    if (current(captured) && generation === readGeneration) emit({ loading: false, uncertain: pending(), ...(clearMutationError && !pending() ? { mutationError: '' } : {}) });
  }
  const controller: AssetDispositionController = {
    getState: () => state,
    setContext(context: AssetDispositionContext|null|undefined) {
      if (!context) { epoch++; readGeneration++; emit(initialState()); return; }
      const ids = [...new Set(context.assetIds)];
      if (context.scope === state.scope && context.projectId === state.projectId && JSON.stringify(ids) === JSON.stringify(state.assetIds)) return;
      const changedProject = context.scope !== state.scope || context.projectId !== state.projectId;
      if (changedProject) { epoch++; readGeneration++; state = initialState(); }
      emit({ scope: context.scope, projectId: context.projectId ?? null, assetIds: ids, entries: Object.fromEntries(ids.map(id => [id, entry(state,id,{ phase: 'loading', row: null, error: '' }) ])) });
      void readCurrent();
    },
    read: readCurrent,
    syncPending() { const uncertain = pending(); if (state.uncertain !== uncertain) emit({ uncertain, ...(!uncertain ? { mutationError: '' } : {}) }); },
    async set(assetId: string,disposition: AssetDisposition,scope: unknown = state.scope): Promise<AssetDispositionResponse|null> {
      const row = dispositionRow(state, assetId);
      if (!scope || scope !== state.scope || !(ASSET_DISPOSITIONS as readonly string[]).includes(disposition) || !row || row.disposition === disposition || state.savingAssetId || pending() || !canSave() || !state.projectId) return null;
      const captured = capture(), input = { projectId: state.projectId, assetId, expectedRevision: row.revision, disposition };
      emit({ savingAssetId: assetId, mutationError: '', uncertain: false });
      let acknowledged: AssetDispositionResponse|null = null;
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
        if (current(captured)) emit({ mutationError: errorDisplayMessage(error) || msg('assets.mark.unconfirmed'), uncertain: pending() });
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
