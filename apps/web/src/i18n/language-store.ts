import { isLanguagePreference, resolveLocale } from '../../../../packages/i18n/src/locale.ts';
import { LANGUAGE_STORAGE_KEY, isLanguageSnapshot, parseLanguagePreference, serializeLanguagePreference } from '../../../../packages/i18n/src/preference.ts';
import type { LanguageBridge, LanguageSnapshot } from '../../../../packages/i18n/src/preference.ts';
import type { LanguagePreference } from '../../../../packages/i18n/src/types.ts';
export interface LanguageStoreState extends LanguageSnapshot { readonly ready: boolean; readonly saving: boolean }
interface Options { systemLanguages: readonly string[]; storage?: () => Pick<Storage, 'getItem' | 'setItem'>; bridge?: LanguageBridge | null }
export function createLanguageStore({ systemLanguages, storage, bridge = null }: Options) {
  systemLanguages = [...systemLanguages];
  let preference: LanguagePreference = 'system', persistence: LanguageSnapshot['persistence'] = 'saved';
  if (!bridge) try { const raw = storage?.().getItem(LANGUAGE_STORAGE_KEY); if (raw != null) preference = parseLanguagePreference(raw); }
  catch { persistence = 'read-failed'; }
  let state: LanguageStoreState = Object.freeze({ version: 1, revision: 0, preference, locale: resolveLocale(preference, systemLanguages), persistence, ready: !bridge, saving: false });
  const listeners = new Set<() => void>(); let disposed = false, initialized = false, generation = 0, pending = 0, release: (() => void) | null = null;
  const publish = (next: LanguageStoreState) => { if (disposed) return; state = Object.freeze(next); for (const listener of listeners) listener(); };
  const accept = (next: LanguageSnapshot) => { if (isLanguageSnapshot(next) && next.revision >= state.revision) publish({ ...next, ready: true, saving: pending > 0 }); };
  async function initialize() {
    if (initialized || disposed) return; initialized = true;
    if (!bridge) return;
    const owner = ++generation;
    try { release = bridge.subscribe(next => { if (owner === generation) accept(next); }); const next = await bridge.read(); if (owner === generation) accept(next); }
    catch { if (owner === generation && !state.ready) publish({ ...state, ready: true, persistence: 'host-unavailable' }); }
  }
  async function setPreference(next: LanguagePreference) {
    if (!isLanguagePreference(next) || disposed) throw new TypeError('Invalid language preference.');
    if (bridge) {
      pending++; publish({ ...state, saving: true });
      try { accept(await bridge.set(next)); }
      catch { publish({ ...state, ready: true, persistence: 'host-unavailable' }); }
      finally { pending--; publish({ ...state, saving: pending > 0 }); }
    } else {
      let saved = true; try { if (!storage) throw new Error(); storage().setItem(LANGUAGE_STORAGE_KEY, serializeLanguagePreference(next)); } catch { saved = false; }
      publish({ version: 1, revision: state.revision + 1, preference: next, locale: resolveLocale(next, systemLanguages), persistence: saved ? 'saved' : 'session', ready: true, saving: false });
    }
  }
  function receiveStorage(raw: string | null) {
    if (bridge || disposed) return;
    try { const next = raw === null ? 'system' : parseLanguagePreference(raw); publish({ version: 1, revision: state.revision + 1, preference: next, locale: resolveLocale(next, systemLanguages), persistence: 'saved', ready: true, saving: false }); }
    catch { publish({ ...state, persistence: 'read-failed' }); }
  }
  async function updateSystemLanguages(values: readonly string[]) {
    systemLanguages = [...values];
    if (bridge) { try { accept(await bridge.read()); } catch { /* Keep the last verified language without changing business state. */ } }
    else if (state.preference === 'system') publish({ ...state, locale: resolveLocale('system', systemLanguages) });
  }
  return { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, initialize, updateSystemLanguages, connect: () => { void initialize(); return () => { generation++; initialized = false; release?.(); release = null; }; }, setPreference, receiveStorage,
    dispose: () => { disposed = true; release?.(); release = null; listeners.clear(); } };
}
