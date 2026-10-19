import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_UI_PREFERENCES, uiPreferencesSchema } from '../../../packages/contracts/src/ui-preferences.ts';
import type { UiPreferences, UiPreferencesPut, UiPreferencesResponse } from '../../../packages/contracts/src/ui-preferences.ts';
import { createUiPreferencesClient, UiPreferencesRequestError } from './ui-preferences-client.ts';
import type { UiPreferencesClient } from './ui-preferences-client.ts';
import { bindUiAppearance } from './ui-appearance.ts';
import type { ResolvedAppearance } from './ui-appearance.ts';
import { createUiPreferencesSync } from './ui-preferences-sync.ts';

type Phase = 'loading' | 'ready' | 'saving' | 'error' | 'conflict';
interface UiPreferencesContextValue {
  readonly preferences: Readonly<UiPreferences>;
  readonly resolvedTheme: ResolvedAppearance;
  readonly saved: UiPreferencesResponse | null;
  readonly phase: Phase;
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly recentError: boolean;
  readonly edit: (patch: Partial<UiPreferences>) => void;
  readonly save: () => Promise<boolean>;
  readonly discard: () => void;
  readonly reload: () => Promise<boolean>;
  readonly markOpened: (projectId: string) => Promise<void>;
}
const unavailable = async () => false;
const Context = createContext<UiPreferencesContextValue>({ preferences: DEFAULT_UI_PREFERENCES, resolvedTheme: 'dark', saved: null, phase: 'loading', dirty: false, pending: false, recentError: false,
  edit: () => {}, save: unavailable, discard: () => {}, reload: unavailable, markOpened: async () => {} });
const same = (left: Readonly<UiPreferences>, right: Readonly<UiPreferences>) => Object.keys(DEFAULT_UI_PREFERENCES).every(key => left[key as keyof UiPreferences] === right[key as keyof UiPreferences]);

/** Global display preferences are separate from project view state and language.
 * Failed writes retain their frozen request for an explicit same-request retry. */
export function UiPreferencesProvider({ children, client: supplied }: { children: React.ReactNode; client?: UiPreferencesClient }) {
  const [client] = useState(() => supplied ?? createUiPreferencesClient());
  const [saved, setSaved] = useState<UiPreferencesResponse | null>(null);
  const [preferences, setPreferences] = useState<UiPreferences>({ ...DEFAULT_UI_PREFERENCES });
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedAppearance>('dark');
  const [phase, setPhase] = useState<Phase>('loading');
  const [pending, setPending] = useState(false);
  const [recentError, setRecentError] = useState(false);
  const live = useRef(true), serial = useRef(0), busy = useRef(false), reading = useRef(false), editVersion = useRef(0);
  const frozen = useRef<UiPreferencesPut | null>(null);
  const sync = useRef<ReturnType<typeof createUiPreferencesSync> | null>(null);
  const current = useRef({ saved, preferences }); current.current = { saved, preferences };
  const dirty = saved !== null && !same(preferences, saved.preferences);
  const publish = (next: UiPreferencesResponse) => {
    if (current.current.saved && current.current.saved.revision > next.revision) return false;
    current.current.saved = next; setSaved(next); return true;
  };

  const reload = useCallback(async () => {
    if (busy.current) return false;
    const request = ++serial.current, version = editVersion.current;
    const hadDraft = current.current.saved !== null && !same(current.current.preferences, current.current.saved.preferences);
    reading.current = true;
    setPhase('loading');
    try {
      const next = await client.get();
      if (!live.current || request !== serial.current) return false;
      const accepted = publish(next);
      if (accepted && !hadDraft && version === editVersion.current) { current.current.preferences = next.preferences; setPreferences(next.preferences); }
      frozen.current = null; setPending(false); setPhase('ready'); return true;
    } catch {
      if (live.current && request === serial.current) setPhase('error');
      return false;
    } finally { if (request === serial.current) { reading.current = false; sync.current?.drain(); } }
  }, [client]);

  useEffect(() => {
    live.current = true; void reload();
    return () => { live.current = false; serial.current++; };
  }, [reload]);

  useEffect(() => {
    const owner = createUiPreferencesSync(window, {
      revision: () => current.current.saved?.revision ?? null,
      canRefresh: () => live.current && !busy.current && !reading.current && !frozen.current
        && !(current.current.saved && !same(current.current.preferences, current.current.saved.preferences)),
      refresh: () => { void reload(); },
    });
    sync.current = owner;
    return () => { owner.close(); if (sync.current === owner) sync.current = null; };
  }, [reload]);

  useLayoutEffect(() => {
    const appearance = preferences.theme;
    return bindUiAppearance(document.documentElement, appearance,
      typeof window.matchMedia === 'function' ? query => window.matchMedia(query) : null,
      () => current.current.preferences.theme === appearance, setResolvedTheme);
  }, [preferences.theme]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.density = preferences.density;
    root.dataset.timecodeFormat = preferences.timecodeFormat;
    root.dataset.reduceMotion = preferences.reduceMotion ? 'true' : 'false';
    root.style.setProperty('--mioon-ui-scale', String(preferences.scalePercent / 100));
    root.style.zoom = String(preferences.scalePercent / 100);
  }, [preferences]);

  const edit = useCallback((patch: Partial<UiPreferences>) => {
    if (busy.current || reading.current || frozen.current || !current.current.saved?.writable) return;
    const next = uiPreferencesSchema.safeParse({ ...current.current.preferences, ...patch });
    if (!next.success) return;
    editVersion.current++; current.current.preferences = next.data; setPreferences(next.data);
  }, []);

  const save = useCallback(async () => {
    const value = current.current;
    if (busy.current || reading.current || !value.saved?.writable) return false;
    const input = frozen.current ?? { expectedRevision: value.saved.revision, requestId: crypto.randomUUID(), preferences: { ...value.preferences } };
    if (!frozen.current && same(input.preferences, value.saved.preferences)) return true;
    frozen.current = input; busy.current = true; setPending(true); setPhase('saving');
    const request = ++serial.current;
    try {
      const next = await client.put(input);
      if (!live.current || request !== serial.current) return false;
      frozen.current = null; setPending(false); if (publish(next)) { current.current.preferences = next.preferences; setPreferences(next.preferences); sync.current?.announce(next.revision); } setPhase('ready'); return true;
    } catch (error) {
      if (live.current && request === serial.current) setPhase(error instanceof UiPreferencesRequestError && error.code.includes('CONFLICT') ? 'conflict' : 'error');
      return false;
    } finally { busy.current = false; sync.current?.drain(); }
  }, [client]);

  const discard = useCallback(() => {
    if (busy.current || frozen.current || !current.current.saved) return;
    editVersion.current++; current.current.preferences = current.current.saved.preferences; setPreferences(current.current.saved.preferences);
    sync.current?.drain();
  }, []);

  const markOpened = useCallback(async (projectId: string) => {
    const version = editVersion.current;
    const hadDraft = current.current.saved !== null && !same(current.current.preferences, current.current.saved.preferences);
    try {
      const next = await client.opened(projectId);
      if (live.current) {
        // A navigation acknowledgement can include another window's preference
        // save. It must not silently rebase an existing or newly edited draft.
        const hasDraft = current.current.saved !== null && !same(current.current.preferences, current.current.saved.preferences);
        if (hadDraft || hasDraft || version !== editVersion.current || frozen.current) sync.current?.hint(next.revision);
        else if (publish(next)) { current.current.preferences = next.preferences; setPreferences(next.preferences); }
        setRecentError(false);
      }
    } catch { if (live.current) setRecentError(true); }
  }, [client]);

  useEffect(() => {
    const owner = { reload, markOpened };
    const target = window as unknown as { __mioonUiPreferences?: unknown };
    target.__mioonUiPreferences = owner;
    return () => { if (target.__mioonUiPreferences === owner) delete target.__mioonUiPreferences; };
  }, [reload, markOpened]);

  return <Context.Provider value={{ preferences, resolvedTheme, saved, phase, dirty, pending, recentError, edit, save, discard, reload, markOpened }}>{children}</Context.Provider>;
}

export const useUiPreferences = (): UiPreferencesContextValue => useContext(Context);
