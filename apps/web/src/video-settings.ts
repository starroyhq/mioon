import { videoConnectionConfigurationSchema, videoSettingsUpdateSchema, defaultVideoModels, VIDEO_REGIONS, VIDEO_PROVIDER_NAMES, videoConnectionEndpoint, normalizeCompatibleVideoBaseUrl, isVideoCatalogProvider, compatibleVideoCheckSchema, COMPATIBLE_VIDEO_CHECK_RESULTS } from '../../../packages/contracts/src/video-providers.ts';
import type { CompatibleVideoCheck, CompatibleVideoCheckResult, VideoConnectionConfiguration, VideoConnectionView, VideoCredentialView, VideoModelEntry, VideoProviderId, VideoSettingsSnapshot, VideoSettingsUpdate } from '../../../packages/contracts/src/video-providers.ts';
import type { MessageKey } from '../../../packages/i18n/src/index.ts';

const clone = <T,>(value: T): T => structuredClone(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => record(value) && Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const fail = (code = 'NETWORK') => Object.assign(new Error('Video connection settings could not be confirmed.'), { code });
const errorCode = (error: unknown): string => record(error) && typeof error.code === 'string' ? error.code : 'NETWORK';
/** Strict redacted response boundary: a server echo must never enter UI state. */
export function safeVideoSettings(value: unknown): VideoSettingsSnapshot {
  if (!exact(value, ['revision', 'connections', 'storage']) || !integer(value.revision) || !Array.isArray(value.connections) || !exact(value.storage, ['persistentAvailable', 'sessionScope', 'reasonCode']) || typeof value.storage.persistentAvailable !== 'boolean' || !['app', 'server'].includes(String(value.storage.sessionScope)) || value.storage.reasonCode !== null && typeof value.storage.reasonCode !== 'string') throw fail('INVALID_RESPONSE');
  for (const connection of value.connections) {
    if (!exact(connection, ['configuration', 'revision', 'credentialRef', 'secret', 'credentials']) || !videoConnectionConfigurationSchema.safeParse(connection.configuration).success || !integer(connection.revision) || !exact(connection.secret, ['configured', 'storage']) || typeof connection.secret.configured !== 'boolean' || !['none', 'session', 'persistent'].includes(String(connection.secret.storage)) || connection.credentialRef !== null && typeof connection.credentialRef !== 'string' || !Array.isArray(connection.credentials)) throw fail('INVALID_RESPONSE');
    for (const credential of connection.credentials) if (!exact(credential, ['ref', 'region', 'endpoint', 'configured', 'storage']) || typeof credential.ref !== 'string' || typeof credential.region !== 'string' || typeof credential.endpoint !== 'string' || typeof credential.configured !== 'boolean' || !['none', 'session', 'persistent'].includes(String(credential.storage))) throw fail('INVALID_RESPONSE');
  }
  return clone(value) as unknown as VideoSettingsSnapshot;
}
export interface VideoSettingsClient { read(signal?: AbortSignal): Promise<VideoSettingsSnapshot>; write(input: VideoSettingsUpdate, signal?: AbortSignal): Promise<VideoSettingsSnapshot>; check?(input: CompatibleVideoCheck, signal?: AbortSignal): Promise<CompatibleVideoCheckResult> }
/** The check reply is a closed enum plus an optional HTTP status; nothing else enters UI state. */
export function safeCompatibleCheck(value: unknown): CompatibleVideoCheckResult {
  if (!exact(value, ['result', 'httpStatus']) || !(COMPATIBLE_VIDEO_CHECK_RESULTS as readonly string[]).includes(String(value.result)) || value.httpStatus !== undefined && !(Number.isInteger(value.httpStatus) && Number(value.httpStatus) >= 100 && Number(value.httpStatus) <= 599)) throw fail('INVALID_RESPONSE');
  return value.httpStatus === undefined ? { result: value.result as CompatibleVideoCheckResult['result'] } : { result: value.result as CompatibleVideoCheckResult['result'], httpStatus: Number(value.httpStatus) };
}
export function createVideoSettingsClient({ fetchImpl = globalThis.fetch, timeoutMs = 12000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): VideoSettingsClient {
  async function request(method: 'GET' | 'PUT', input?: VideoSettingsUpdate, external?: AbortSignal): Promise<VideoSettingsSnapshot> {
    const controller = new AbortController(), abort = () => controller.abort();
    external?.addEventListener('abort', abort, { once: true }); if (external?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const transport = (async () => {
      const response = await fetchImpl('/api/video-providers/settings', { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) });
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
    const parsed = compatibleVideoCheckSchema.safeParse(input); if (!parsed.success) throw fail('VIDEO_SETTINGS_VALIDATION');
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
  snapshot: VideoSettingsSnapshot | null; draft: VideoConnectionConfiguration | null; baseline: VideoConnectionConfiguration | null;
  secretAction: 'keep' | 'remove'; storage: '' | 'session' | 'persistent'; restoreRef: string | null; recovery: 'conflict' | 'unknown' | null; notice: MessageKey | null;
}
export const initialVideoSettingsState = (): VideoSettingsState => ({ phase: 'loading', snapshot: null, draft: null, baseline: null, secretAction: 'keep', storage: '', restoreRef: null, recovery: null, notice: null });
export const videoSettingsBusy = (state: VideoSettingsState): boolean => ['loading', 'saving', 'reconciling'].includes(state.phase);
export const videoSettingsDirty = (state: VideoSettingsState): boolean => Boolean(state.draft && (JSON.stringify(state.draft) !== JSON.stringify(state.baseline) || state.secretAction !== 'keep' || state.restoreRef));
export const videoSettingsCanSave = (state: VideoSettingsState): boolean => Boolean(state.draft && state.snapshot && !videoSettingsBusy(state) && !state.recovery && state.phase !== 'blocked');
/** Restoring the current missing reference resumes its tasks without rotating their binding. */
export const restorableVideoCredentials = (saved: VideoConnectionView | undefined, storage?: VideoSettingsSnapshot['storage']): VideoCredentialView[] => saved?.credentials.filter(credential => credential.ref !== saved.credentialRef || !credential.configured || credential.storage === 'persistent' && storage?.persistentAvailable === false) || [];
const credentialStorage = (storage: VideoCredentialView['storage'] | undefined): VideoSettingsState['storage'] => storage === 'persistent' || storage === 'session' ? storage : '';
export function newVideoConnection(providerId: VideoProviderId): VideoConnectionConfiguration {
  if (!isVideoCatalogProvider(providerId)) throw fail('VIDEO_SETTINGS_VALIDATION');
  return { id: crypto.randomUUID(), providerId, name: VIDEO_PROVIDER_NAMES[providerId], region: VIDEO_REGIONS[providerId][0]!, workspaceId: '', enabled: false, archived: false, outputHosts: [], models: defaultVideoModels(providerId).filter(model => providerId !== 'wan' || model.templateId === 'wan30-v1'), ...(providerId === 'compatible' ? { baseUrl: '' } : {}) };
}
export function createVideoSettingsSession({ client = createVideoSettingsClient(), onChange = () => {} }: { client?: VideoSettingsClient; onChange?: (state: VideoSettingsState) => void } = {}) {
  let state = initialVideoSettingsState(), live = true, visible = true, epoch = 0, pending: AbortController | null = null;
  const emit = (patch: Partial<VideoSettingsState>) => { if (!live) return; state = { ...state, ...patch }; onChange(clone(state)); };
  const owned = (token: number) => live && token === epoch;
  const editable = () => live && visible && !videoSettingsBusy(state);
  const choose = (input: VideoConnectionConfiguration | null) => { const configuration = input && isVideoCatalogProvider(input.providerId) ? input : null; const saved = state.snapshot?.connections.find(item => item.configuration.id === configuration?.id); emit({ draft: clone(configuration), baseline: clone(configuration), secretAction: 'keep', storage: credentialStorage(saved?.secret.storage), restoreRef: null, phase: 'ready', recovery: null, notice: null }); };
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
    const configuration = clone(state.draft), expectedRevision = state.snapshot.revision, restoring = state.restoreRef !== null;
    // A typed base URL is saved in its normalized form (lower-case host, no trailing slash).
    if (configuration.providerId === 'compatible') { try { configuration.baseUrl = normalizeCompatibleVideoBaseUrl(configuration.baseUrl); } catch { emit({ phase: 'error', notice: 'video.providers.baseUrlInvalid' }); return false; } }
    const saved = state.snapshot.connections.find(item => item.configuration.id === configuration.id);
    if (restoring && !restorableVideoCredentials(saved, state.snapshot.storage).some(credential => credential.ref === state.restoreRef)) { emit({ phase: 'error', notice: 'video.providers.invalid' }); return false; }
    const secret = value ? { action: 'replace' as const, value, storage: state.storage } : { action: state.secretAction };
    const input = state.restoreRef ? { action: 'restoreCredential', expectedRevision, connectionId: configuration.id, credentialRef: state.restoreRef, secret } : { action: 'save', expectedRevision, configuration, secret };
    const parsed = videoSettingsUpdateSchema.safeParse(input);
    if (!parsed.success || value && state.storage === 'persistent' && !state.snapshot.storage.persistentAvailable) { emit({ phase: 'error', notice: 'video.providers.invalid' }); return false; }
    pending?.abort(); pending = new AbortController(); const token = ++epoch;
    emit({ phase: 'saving', secretAction: 'keep', restoreRef: null, notice: null });
    // The credential remains only in this one transport call; no state or retry body retains it.
    try { const snapshot = safeVideoSettings(await client.write(parsed.data, pending.signal)); if (!owned(token)) return false;
      if (snapshot.revision !== expectedRevision + 1) throw fail('INVALID_RESPONSE');
      const accepted = snapshot.connections.find(item => item.configuration.id === configuration.id); if (!accepted) throw fail('INVALID_RESPONSE');
      // Credential restoration does not submit the editable connection or model catalog.
      // Keep those edits visible and dirty until their own explicit configuration save.
      const draft = restoring ? configuration : clone(accepted.configuration);
      const dirty = JSON.stringify(draft) !== JSON.stringify(accepted.configuration);
      emit({ snapshot, draft, baseline: clone(accepted.configuration), storage: credentialStorage(accepted.secret.storage), phase: restoring && dirty ? 'ready' : 'saved', recovery: null, notice: restoring ? dirty ? 'video.providers.credentialRestoredDraft' : 'video.providers.credentialRestored' : 'video.providers.saved' }); return true;
    } catch (error) { if (!owned(token)) return false; const code = errorCode(error);
      if (['VIDEO_SETTINGS_VALIDATION', 'UNAUTHORIZED', 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE'].includes(code)) { emit({ phase: 'error', notice: 'video.providers.invalid' }); return false; }
      const recovery = code === 'VIDEO_SETTINGS_CONFLICT' ? 'conflict' : 'unknown'; emit({ phase: 'reconciling', recovery, notice: recovery === 'conflict' ? 'video.providers.conflict' : 'video.providers.unknown' });
      try { const snapshot = safeVideoSettings(await client.read(pending!.signal)); if (owned(token)) emit({ snapshot, phase: 'review' }); }
      catch { if (owned(token)) emit({ phase: 'blocked' }); } return false;
    }
  }
  return {
    getState: () => clone(state), load: () => read(), reload: () => read(Boolean(state.snapshot)), save,
    select(id: string) { if (!editable() || videoSettingsDirty(state) || state.recovery) return false; const found = state.snapshot?.connections.find(item => item.configuration.id === id); if (!found || !isVideoCatalogProvider(found.configuration.providerId)) return false; choose(found.configuration); return true; },
    add(providerId: VideoProviderId) { if (!editable() || videoSettingsDirty(state) || state.recovery || !isVideoCatalogProvider(providerId)) return false; choose(newVideoConnection(providerId)); emit({ baseline: null }); return true; },
    update(patch: Partial<VideoConnectionConfiguration>) { if (!editable() || state.recovery || !state.draft) return false; emit({ draft: { ...state.draft, ...clone(patch), id: state.draft.id } }); return true; },
    setStorage(storage: '' | 'session' | 'persistent') { if (!editable() || storage === 'persistent' && !state.snapshot?.storage.persistentAvailable) return false; emit({ storage }); return true; },
    removeKey(remove: boolean) { if (!editable()) return false; emit({ secretAction: remove ? 'remove' : 'keep', restoreRef: null }); return true; },
    restoreCredential(ref: string | null) {
      if (!editable() || state.recovery || !state.draft) return false;
      const saved = state.snapshot?.connections.find(item => item.configuration.id === state.draft?.id), credential = restorableVideoCredentials(saved, state.snapshot?.storage).find(item => item.ref === ref);
      if (ref !== null && !credential) return false;
      const unavailable = ref !== null && credential?.storage === 'persistent' && state.snapshot?.storage.persistentAvailable === false;
      emit({ restoreRef: ref, secretAction: 'keep', storage: unavailable ? '' : credentialStorage(ref === null ? saved?.secret.storage : credential?.storage) }); return true;
    },
    discard() { if (!editable() || state.recovery) return false; choose(state.baseline); return true; },
    useLatest() { if (!editable() || !state.snapshot || state.phase === 'blocked') return false; choose(state.snapshot.connections.find(item => item.configuration.id === state.draft?.id)?.configuration || null); return true; },
    acknowledge() { if (!editable() || state.phase !== 'review') return false; emit({ recovery: null, phase: 'ready', notice: null }); return true; },
    setVisible(value: boolean) { visible = value; },
    dispose() { live = false; ++epoch; pending?.abort(); state = initialVideoSettingsState(); },
  };
}
export type VideoSettingsSession = ReturnType<typeof createVideoSettingsSession>;
export const videoSettingsEndpoint = (draft: VideoConnectionConfiguration | null): string => { try { return draft ? videoConnectionEndpoint(draft) : ''; } catch { return ''; } };
/** Host of a compatible draft's base URL once it is valid; that host is always an output host. */
export const compatibleServiceHost = (draft: VideoConnectionConfiguration | null): string => { if (draft?.providerId !== 'compatible') return ''; try { return new URL(normalizeCompatibleVideoBaseUrl(draft.baseUrl)).hostname; } catch { return ''; } };

export function videoModelPairMap(value: string): VideoModelEntry['durationResolutionMap'] {
  const groups = new Map<string, Set<number>>();
  for (const line of value.split(/[\n,]+/).filter(line => line.trim())) {
    const [duration, resolution = ''] = line.trim().split(':');
    const values = groups.get(resolution) || new Set<number>(); values.add(Number(duration)); groups.set(resolution, values);
  }
  return [...groups].map(([resolution, duration]) => ({ duration: [...duration], resolution: [resolution] }));
}
