import { defaultVideoModels, VIDEO_REGIONS, VIDEO_PROVIDER_NAMES, videoConnectionEndpoint, normalizeCompatibleVideoBaseUrl, isVideoCatalogProvider } from '../../../packages/contracts/src/video-providers.ts';
import type { CompatibleVideoCheck, CompatibleVideoCheckResult, VideoModelEntry, VideoProviderId } from '../../../packages/contracts/src/video-providers.ts';
import {compatibleVideoCheckResultV2Schema, compatibleVideoCheckV2Schema, videoSettingsSnapshotV2Schema, videoSettingsUpdateV2Schema} from '../../../packages/contracts/src/generation-video-settings.ts';
import type {VideoConnectionConfigurationV2, VideoSettingsSnapshotV2, VideoSettingsUpdateV2} from '../../../packages/contracts/src/generation-video-settings.ts';
import type { MessageKey } from '../../../packages/i18n/src/index.ts';

const clone = <T,>(value: T): T => structuredClone(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code = 'NETWORK') => Object.assign(new Error('Video connection settings could not be confirmed.'), { code });
const errorCode = (error: unknown): string => record(error) && typeof error.code === 'string' ? error.code : 'NETWORK';
/** Strict redacted response boundary: a server echo must never enter UI state. */
export function safeVideoSettings(value: unknown): VideoSettingsSnapshotV2 {
  const parsed = videoSettingsSnapshotV2Schema.safeParse(value);
  if (!parsed.success) throw fail('INVALID_RESPONSE');
  return parsed.data;
}
export interface VideoSettingsClient { read(signal?: AbortSignal): Promise<VideoSettingsSnapshotV2>; write(input: VideoSettingsUpdateV2, signal?: AbortSignal): Promise<VideoSettingsSnapshotV2>; check?(input: CompatibleVideoCheck, signal?: AbortSignal): Promise<CompatibleVideoCheckResult> }
/** The check reply is a closed enum plus an optional HTTP status; nothing else enters UI state. */
export function safeCompatibleCheck(value: unknown): CompatibleVideoCheckResult {
  const parsed = compatibleVideoCheckResultV2Schema.safeParse(value);
  if (!parsed.success) throw fail('INVALID_RESPONSE');
  return parsed.data;
}
export function createVideoSettingsClient({ fetchImpl = globalThis.fetch, timeoutMs = 12000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): VideoSettingsClient {
  async function request(method: 'GET' | 'PUT', input?: VideoSettingsUpdateV2, external?: AbortSignal): Promise<VideoSettingsSnapshotV2> {
    const parsed = input === undefined ? null : videoSettingsUpdateV2Schema.safeParse(input);
    if (parsed && !parsed.success) throw fail('VIDEO_SETTINGS_VALIDATION');
    const controller = new AbortController(), abort = () => controller.abort();
    external?.addEventListener('abort', abort, { once: true }); if (external?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const transport = (async () => {
      const response = await fetchImpl('/api/video-providers/settings', { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(parsed?.success ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) } : {}) });
      const body: unknown = await response.json();
      if (!record(body) || body.ok !== true || !response.ok) {
        const code = record(body) && record(body.error) && typeof body.error.code === 'string' ? body.error.code : 'NETWORK';
        throw fail(response.status === 401 ? 'UNAUTHORIZED' : /^VIDEO_[A-Z_]+$/.test(code) ? code : 'NETWORK');
      }
      return safeVideoSettings(body.data);
    })();
    try { return timeoutMs > 0 ? await Promise.race([transport, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail()); }, timeoutMs); })]) : await transport; }
    catch (error) { throw fail(errorCode(error)); }
    finally { clearTimeout(timer); external?.removeEventListener('abort', abort); }
  }
  async function check(input: CompatibleVideoCheck, external?: AbortSignal): Promise<CompatibleVideoCheckResult> {
    const parsed = compatibleVideoCheckV2Schema.safeParse(input); if (!parsed.success) throw fail('VIDEO_SETTINGS_VALIDATION');
    const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 20000));
    external?.addEventListener('abort', abort, { once: true }); if (external?.aborted) controller.abort();
    try {
      // The key is in this one request body only; it is never echoed or retained.
      const response = await fetchImpl('/api/video-providers/compatible-check', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) });
      const body: unknown = await response.json();
      if (!record(body) || body.ok !== true || !response.ok) { const code = record(body) && record(body.error) && typeof body.error.code === 'string' ? body.error.code : 'NETWORK'; throw fail(/^VIDEO_[A-Z_]+$/.test(code) ? code : 'NETWORK'); }
      return safeCompatibleCheck(body.data);
    } catch (error) { throw fail(errorCode(error)); }
    finally { clearTimeout(timer); external?.removeEventListener('abort', abort); }
  }
  return { read: signal => request('GET', undefined, signal), write: (input, signal) => request('PUT', input, signal), check };
}
export interface VideoSettingsState {
  phase: 'loading' | 'ready' | 'saving' | 'saved' | 'error' | 'load_error' | 'review' | 'blocked' | 'reconciling';
  snapshot: VideoSettingsSnapshotV2 | null; draft: VideoConnectionConfigurationV2 | null; baseline: VideoConnectionConfigurationV2 | null;
  secretAction: 'keep' | 'remove'; storage: '' | 'session' | 'persistent'; recovery: 'conflict' | 'unknown' | null; notice: MessageKey | null;
}
export const initialVideoSettingsState = (): VideoSettingsState => ({ phase: 'loading', snapshot: null, draft: null, baseline: null, secretAction: 'keep', storage: '', recovery: null, notice: null });
export const videoSettingsBusy = (state: VideoSettingsState): boolean => ['loading', 'saving', 'reconciling'].includes(state.phase);
export const videoSettingsDirty = (state: VideoSettingsState): boolean => Boolean(state.draft && (JSON.stringify(state.draft) !== JSON.stringify(state.baseline) || state.secretAction !== 'keep'));
export const videoSettingsCanSave = (state: VideoSettingsState): boolean => Boolean(state.draft && state.snapshot && !videoSettingsBusy(state) && !state.recovery && state.phase !== 'blocked');
const credentialStorage = (storage: string | undefined): VideoSettingsState['storage'] => storage === 'persistent' || storage === 'session' ? storage : '';
export function newVideoConnection(providerId: VideoProviderId): VideoConnectionConfigurationV2 {
  if (providerId === 'runway' || !isVideoCatalogProvider(providerId)) throw fail('VIDEO_SETTINGS_VALIDATION');
  return { id: crypto.randomUUID(), providerId, name: VIDEO_PROVIDER_NAMES[providerId], region: VIDEO_REGIONS[providerId][0]!, workspaceId: '', enabled: false, outputHosts: [], models: defaultVideoModels(providerId).filter(model => providerId !== 'wan' || model.templateId === 'wan30-v1'), ...(providerId === 'compatible' ? { baseUrl: '' } : {}) };
}
export function createVideoSettingsSession({ client = createVideoSettingsClient(), onChange = () => {} }: { client?: VideoSettingsClient; onChange?: (state: VideoSettingsState) => void } = {}) {
  let state = initialVideoSettingsState(), live = true, visible = true, epoch = 0, pending: AbortController | null = null;
  const emit = (patch: Partial<VideoSettingsState>) => { if (!live) return; state = { ...state, ...patch }; onChange(clone(state)); };
  const owned = (token: number) => live && token === epoch;
  const editable = () => live && visible && !videoSettingsBusy(state);
  const choose = (input: VideoConnectionConfigurationV2 | null) => { const configuration = input && isVideoCatalogProvider(input.providerId) ? input : null; const saved = state.snapshot?.connections.find(item => item.configuration.id === configuration?.id); emit({ draft: clone(configuration), baseline: clone(configuration), secretAction: 'keep', storage: credentialStorage(saved?.secret.storage), phase: 'ready', recovery: null, notice: null }); };
  async function read(recover = false): Promise<boolean> {
    if (!live || videoSettingsBusy(state) && state.phase !== 'loading') return false;
    pending?.abort(); pending = new AbortController(); const token = ++epoch;
    emit({ phase: recover ? 'reconciling' : 'loading', notice: null });
    try { const snapshot = safeVideoSettings(await client.read(pending.signal)); if (!owned(token)) return false;
      emit({ snapshot, phase: recover ? 'review' : 'ready', recovery: recover ? state.recovery || 'unknown' : null, notice: recover ? 'video.providers.unknown' : null });
      const available = snapshot.connections.filter(item => isVideoCatalogProvider(item.configuration.providerId));
      if (!recover) choose(available.find(item => item.configuration.id === state.draft?.id)?.configuration || available[0]?.configuration || null);
      return true;
    } catch { if (owned(token)) emit({ phase: recover ? 'blocked' : 'load_error', notice: recover ? 'video.providers.unknown' : 'video.providers.loadFailed' }); return false; }
  }
  async function save(value = ''): Promise<boolean> {
    if (!editable() || !videoSettingsCanSave(state) || !state.draft || !state.snapshot) return false;
    const configuration = clone(state.draft), expectedRevision = state.snapshot.revision;
    // A typed base URL is saved in its normalized form (lower-case host, no trailing slash).
    if (configuration.providerId === 'compatible') { try { configuration.baseUrl = normalizeCompatibleVideoBaseUrl(configuration.baseUrl); } catch { emit({ phase: 'error', notice: 'video.providers.baseUrlInvalid' }); return false; } }
    const secret = value ? { action: 'replace' as const, value, storage: state.storage } : { action: state.secretAction };
    const parsed = videoSettingsUpdateV2Schema.safeParse({ action: 'save', expectedRevision, configuration, secret });
    if (!parsed.success || parsed.data.action !== 'save' || value && state.storage === 'persistent' && !state.snapshot.storage.persistentAvailable) { emit({ phase: 'error', notice: 'video.providers.invalid' }); return false; }
    pending?.abort(); pending = new AbortController(); const token = ++epoch;
    emit({ phase: 'saving', secretAction: 'keep', notice: null });
    // The credential remains only in this one transport call; no state or retry body retains it.
    try { const snapshot = safeVideoSettings(await client.write(parsed.data, pending.signal)); if (!owned(token)) return false;
      if (snapshot.revision !== expectedRevision && snapshot.revision !== expectedRevision + 1) throw fail('INVALID_RESPONSE');
      const accepted = snapshot.connections.find(item => item.configuration.id === configuration.id); if (!accepted) throw fail('INVALID_RESPONSE');
      if (JSON.stringify(accepted.configuration) !== JSON.stringify(parsed.data.configuration)) throw fail('INVALID_RESPONSE');
      emit({ snapshot, draft: clone(accepted.configuration), baseline: clone(accepted.configuration), storage: credentialStorage(accepted.secret.storage), phase: 'saved', recovery: null, notice: 'video.providers.saved' }); return true;
    } catch (error) { return recoverWrite(error, token); }
  }
  async function recoverWrite(error: unknown, token: number): Promise<boolean> {
    if (!owned(token)) return false; const code = errorCode(error);
    if (['VIDEO_SETTINGS_VALIDATION', 'UNAUTHORIZED', 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE', 'VIDEO_SETTINGS_CAPACITY'].includes(code)) { emit({ phase: 'error', notice: code === 'VIDEO_SETTINGS_CAPACITY' ? 'video.providers.capacity' : 'video.providers.invalid' }); return false; }
    const recovery = code === 'VIDEO_SETTINGS_CONFLICT' || code === 'VIDEO_SETTINGS_DELETED' ? 'conflict' : 'unknown'; emit({ phase: 'reconciling', recovery, notice: recovery === 'conflict' ? 'video.providers.conflict' : 'video.providers.unknown' });
    try { const snapshot = safeVideoSettings(await client.read(pending!.signal)); if (owned(token)) emit({ snapshot, phase: 'review' }); }
    catch { if (owned(token)) emit({ phase: 'blocked' }); } return false;
  }
  async function remove(): Promise<boolean> {
    if (!editable() || state.recovery || !state.snapshot || !state.draft || state.draft.providerId !== 'compatible') return false;
    const connectionId = state.draft.id, expectedRevision = state.snapshot.revision;
    if (!state.snapshot.connections.some(item => item.configuration.id === connectionId && item.configuration.providerId === 'compatible')) return false;
    pending?.abort(); pending = new AbortController(); const token = ++epoch;
    emit({phase: 'saving', secretAction: 'keep', notice: null});
    try {
      const snapshot = safeVideoSettings(await client.write({action: 'delete', expectedRevision, connectionId}, pending.signal));
      if (!owned(token)) return false;
      if (snapshot.revision !== expectedRevision + 1 || snapshot.connections.some(item => item.configuration.id === connectionId)) throw fail('INVALID_RESPONSE');
      emit({snapshot}); choose(snapshot.connections[0]?.configuration || null); emit({phase: 'saved', notice: 'video.providers.deleted'}); return true;
    } catch (error) { return recoverWrite(error, token); }
  }
  return {
    getState: () => clone(state), load: () => read(), reload: () => read(Boolean(state.snapshot)), save, remove,
    select(id: string) { if (!editable() || videoSettingsDirty(state) || state.recovery) return false; const found = state.snapshot?.connections.find(item => item.configuration.id === id); if (!found || !isVideoCatalogProvider(found.configuration.providerId)) return false; choose(found.configuration); return true; },
    add(providerId: VideoProviderId) { if (!editable() || videoSettingsDirty(state) || state.recovery || !isVideoCatalogProvider(providerId)) return false; const existing = providerId === 'compatible' ? undefined : state.snapshot?.connections.find(item => item.configuration.providerId === providerId); choose(existing?.configuration || newVideoConnection(providerId)); if (!existing) emit({ baseline: null }); return true; },
    update(patch: Partial<VideoConnectionConfigurationV2>) { if (!editable() || state.recovery || !state.draft) return false; emit({ draft: { ...state.draft, ...clone(patch), id: state.draft.id, providerId: state.draft.providerId } }); return true; },
    setStorage(storage: '' | 'session' | 'persistent') { if (!editable() || storage === 'persistent' && !state.snapshot?.storage.persistentAvailable) return false; emit({ storage }); return true; },
    removeKey(remove: boolean) { if (!editable()) return false; emit({ secretAction: remove ? 'remove' : 'keep' }); return true; },
    discard() { if (!editable() || state.recovery) return false; choose(state.baseline); return true; },
    useLatest() { if (!editable() || !state.snapshot || state.phase === 'blocked') return false; choose(state.snapshot.connections.find(item => item.configuration.id === state.draft?.id)?.configuration || null); return true; },
    acknowledge() { if (!editable() || state.phase !== 'review') return false; emit({ recovery: null, phase: 'ready', notice: null }); return true; },
    setVisible(value: boolean) { visible = value; },
    dispose() { live = false; ++epoch; pending?.abort(); state = initialVideoSettingsState(); },
  };
}
export type VideoSettingsSession = ReturnType<typeof createVideoSettingsSession>;
export const videoSettingsEndpoint = (draft: VideoConnectionConfigurationV2 | null): string => { try { return draft ? videoConnectionEndpoint(draft) : ''; } catch { return ''; } };
/** Host of a compatible draft's base URL once it is valid; that host is always an output host. */
export const compatibleServiceHost = (draft: VideoConnectionConfigurationV2 | null): string => { if (draft?.providerId !== 'compatible') return ''; try { return new URL(normalizeCompatibleVideoBaseUrl(draft.baseUrl)).hostname; } catch { return ''; } };

export function videoModelPairMap(value: string): VideoModelEntry['durationResolutionMap'] {
  const groups = new Map<string, Set<number>>();
  for (const line of value.split(/[\n,]+/).filter(line => line.trim())) {
    const [duration, resolution = ''] = line.trim().split(':');
    const values = groups.get(resolution) || new Set<number>(); values.add(Number(duration)); groups.set(resolution, values);
  }
  return [...groups].map(([resolution, duration]) => ({ duration: [...duration], resolution: [resolution] }));
}
