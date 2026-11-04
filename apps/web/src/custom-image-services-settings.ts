import {CUSTOM_IMAGE_SETTINGS_V2_LIMITS, DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, customImageSettingsV2ResultSchema, customImageCreateV2Schema, customImagePutV2Schema, customImageRemoveV2Schema} from '../../../packages/contracts/src/generation-image-settings.ts';
import type {CustomImageConfigurationV2, CustomImageSettingsV2Result} from '../../../packages/contracts/src/generation-image-settings.ts';
import {normalizeCustomImageBaseUrl, getCustomImageDestination} from '../../../packages/contracts/src/image-compatible.ts';
import {canonicalImageInput} from '../../../packages/contracts/src/images.ts';
import type {MessageKey} from '../../../packages/i18n/src/index.ts';

export type CustomImageServicesSnapshot = CustomImageSettingsV2Result;
export interface CustomImageServiceDraft {connectionId: string; name: string; configuration: CustomImageConfigurationV2}
type Create = ReturnType<typeof customImageCreateV2Schema.parse>;
type Put = ReturnType<typeof customImagePutV2Schema.parse>;
type Remove = ReturnType<typeof customImageRemoveV2Schema.parse>;
export type CustomImageServicesWrite = ({action: 'create'} & Create) | ({action: 'put'} & Put) | ({action: 'remove'} & Remove);
export interface CustomImageServicesClient {
  read(signal?: AbortSignal): Promise<CustomImageServicesSnapshot>;
  write(input: CustomImageServicesWrite, signal?: AbortSignal): Promise<CustomImageServicesSnapshot>;
}
const copy = <T>(value: T): T => structuredClone(value);
const failure = (code = 'NETWORK'): Error & {code: string} => Object.assign(new Error('Custom image settings could not be confirmed.'), {code});
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorCode = (value: unknown): string => record(value) && typeof value.code === 'string' ? value.code : 'NETWORK';
export function safeCustomImageServices(value: unknown): CustomImageServicesSnapshot {
  const parsed = customImageSettingsV2ResultSchema.safeParse(value);
  if (!parsed.success) throw failure('INVALID_RESPONSE');
  return copy(parsed.data);
}
export function createCustomImageServicesClient({fetchImpl = globalThis.fetch, timeoutMs = 12000}: {fetchImpl?: typeof fetch; timeoutMs?: number} = {}): CustomImageServicesClient {
  async function request(input?: CustomImageServicesWrite, external?: AbortSignal): Promise<CustomImageServicesSnapshot> {
    const controller = new AbortController(), abort = () => controller.abort();
    external?.addEventListener('abort', abort, {once: true}); if (external?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const transport = (async () => {
      const response = await fetchImpl('/api/images/custom-settings', {method: input ? 'PUT' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(input ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)} : {})});
      const body: unknown = await response.json();
      if (!record(body) || !response.ok || body.ok !== true) {
        const code = record(body) && record(body.error) ? errorCode(body.error) : 'NETWORK';
        throw failure(response.status === 401 ? 'UNAUTHORIZED' : /^IMAGE_SETTINGS_[A-Z_]+$/.test(code) ? code : 'NETWORK');
      }
      return safeCustomImageServices(body.data);
    })();
    try {return timeoutMs > 0 ? await Promise.race([transport, new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(failure());}, timeoutMs);})]) : await transport;}
    catch (error) {throw failure(errorCode(error));}
    finally {clearTimeout(timer); external?.removeEventListener('abort', abort);}
  }
  return {read: signal => request(undefined, signal), write: (input, signal) => request(input, signal)};
}
export interface CustomImageServicesState {
  phase: 'loading' | 'ready' | 'saved' | 'saving' | 'reconciling' | 'review' | 'blocked' | 'load_error' | 'error';
  snapshot: CustomImageServicesSnapshot | null; draft: CustomImageServiceDraft | null; baseline: CustomImageServiceDraft | null;
  storage: '' | 'session' | 'persistent'; secretAction: 'keep' | 'remove'; recovery: 'conflict' | 'unknown' | null; notice: MessageKey | null;
}
export const initialCustomImageServicesState = (): CustomImageServicesState => ({phase: 'loading', snapshot: null, draft: null, baseline: null, storage: '', secretAction: 'keep', recovery: null, notice: null});
export const customImageServicesBusy = (state: CustomImageServicesState): boolean => ['loading', 'saving', 'reconciling'].includes(state.phase);
export const customImageServicesDirty = (state: CustomImageServicesState): boolean => Boolean(state.draft && (canonicalImageInput(state.draft) !== canonicalImageInput(state.baseline) || state.secretAction !== 'keep'));
export const customImageServicesCanSave = (state: CustomImageServicesState): boolean => Boolean(state.draft && state.snapshot && !customImageServicesBusy(state) && !state.recovery && state.phase !== 'blocked');
export function customImageServiceDestination(draft: CustomImageServiceDraft | null): string {
  try {return draft?.configuration.baseUrl ? getCustomImageDestination(normalizeCustomImageBaseUrl(draft.configuration.baseUrl)) : ''; } catch {return '';}
}
export function createCustomImageServicesSession({client = createCustomImageServicesClient(), onChange = () => {}}: {client?: CustomImageServicesClient; onChange?: (state: CustomImageServicesState) => void} = {}) {
  let state = initialCustomImageServicesState(), live = true, visible = true, epoch = 0, pending: AbortController | null = null;
  const publish = (patch: Partial<CustomImageServicesState>) => {if (live) {state = {...state, ...patch}; onChange(copy(state));}};
  const current = (token: number) => live && token === epoch;
  const editable = () => live && visible && !customImageServicesBusy(state);
  const choose = (draft: CustomImageServiceDraft | null) => {
    const saved = state.snapshot?.connections.find(item => item.connectionId === draft?.connectionId);
    const storage = saved?.secret.storage;
    ++epoch; publish({draft: copy(draft), baseline: copy(draft), storage: storage === 'session' || storage === 'persistent' ? storage : '', secretAction: 'keep', recovery: null, phase: 'ready', notice: null});
  };
  const fromSaved = (id: string) => {const item = state.snapshot?.connections.find(item => item.connectionId === id); return item ? {connectionId: item.connectionId, name: item.name, configuration: copy(item.configuration)} : null;};
  async function read(recover = false): Promise<boolean> {
    if (!live || customImageServicesBusy(state) && state.phase !== 'loading') return false;
    pending?.abort(); pending = new AbortController(); const token = ++epoch;
    publish({phase: recover ? 'reconciling' : 'loading', notice: null});
    try {
      const snapshot = safeCustomImageServices(await client.read(pending.signal)); if (!current(token)) return false;
      publish({snapshot, phase: recover ? 'review' : 'ready', recovery: recover ? state.recovery ?? 'unknown' : null, notice: recover ? 'image.settings.notice.review' : null});
      if (!recover) choose(state.draft && fromSaved(state.draft.connectionId) || (snapshot.connections.length === 1 ? fromSaved(snapshot.connections[0]!.connectionId) : null));
      return true;
    } catch {if (current(token)) publish({phase: recover ? 'blocked' : 'load_error', notice: 'image.settings.notice.loadError'}); return false;}
  }
  async function write(input: CustomImageServicesWrite, id: string, remove = false): Promise<boolean> {
    pending?.abort(); pending = new AbortController(); const token = ++epoch, revision = state.snapshot!.revision;
    publish({phase: 'saving', secretAction: 'keep', notice: null});
    try {
      const snapshot = safeCustomImageServices(await client.write(input, pending.signal)); if (!current(token)) return false;
      const accepted = snapshot.connections.find(item => item.connectionId === id);
      if (snapshot.revision !== revision + 1 || (remove ? Boolean(accepted) : !accepted)) throw failure('INVALID_RESPONSE');
      if (input.action !== 'remove') {
        if (!accepted || accepted.name !== input.name || canonicalImageInput(accepted.configuration) !== canonicalImageInput(input.configuration) || accepted.configurationRevision !== (input.action === 'create' ? 1 : input.expectedConfigurationRevision + 1)) throw failure('INVALID_RESPONSE');
        if (input.secret.action === 'replace' && (!accepted.secret.configured || accepted.secret.storage !== input.secret.storage) || input.secret.action === 'remove' && accepted.secret.configured) throw failure('INVALID_RESPONSE');
      }
      publish({snapshot}); choose(remove ? null : fromSaved(id)); publish({phase: 'saved', notice: remove ? 'image.settings.services.deleted' : 'image.settings.services.saved'}); return true;
    } catch (error) {
      if (!current(token)) return false;
      const code = errorCode(error);
      if (['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION', 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE', 'IMAGE_SETTINGS_CAPACITY'].includes(code)) {publish({phase: 'error', notice: code === 'IMAGE_SETTINGS_CAPACITY' ? 'image.settings.services.capacity' : 'image.settings.error.validation'}); return false;}
      publish({phase: 'reconciling', recovery: code === 'IMAGE_SETTINGS_CONFLICT' ? 'conflict' : 'unknown', notice: 'image.settings.notice.review'});
      try {const snapshot = safeCustomImageServices(await client.read(pending!.signal)); if (current(token)) publish({snapshot, phase: 'review'});} catch {if (current(token)) publish({phase: 'blocked'});}
      return false;
    }
  }
  return {
    getState: () => copy(state), load: () => read(), reload: () => read(Boolean(state.snapshot)),
    select(id: string) {if (!editable() || state.recovery || customImageServicesDirty(state)) return false; const selected = fromSaved(id); if (!selected) return false; choose(selected); return true;},
    add(name: string) {
      if (!editable() || !state.snapshot || state.recovery || customImageServicesDirty(state) || state.snapshot.connections.length >= CUSTOM_IMAGE_SETTINGS_V2_LIMITS.connections) return false;
      choose({connectionId: crypto.randomUUID().toLowerCase(), name, configuration: copy(DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2) as CustomImageConfigurationV2}); publish({baseline: null}); return true;
    },
    edit(patch: Partial<Pick<CustomImageServiceDraft, 'name'>>, configuration: Partial<CustomImageConfigurationV2> = {}) {if (!editable() || state.recovery || !state.draft) return false; ++epoch; publish({draft: {...state.draft, ...copy(patch), configuration: {...state.draft.configuration, ...copy(configuration)}}}); return true;},
    setStorage(storage: CustomImageServicesState['storage']) {if (!editable() || state.recovery || storage === 'persistent' && !state.snapshot?.storage.persistentAvailable) return false; publish({storage}); return true;},
    removeKey(remove: boolean) {if (!editable() || state.recovery) return false; publish({secretAction: remove ? 'remove' : 'keep'}); return true;},
    async save(value = '') {
      if (!editable() || !customImageServicesCanSave(state)) return false;
      const draft = copy(state.draft!), previous = state.snapshot!.connections.find(item => item.connectionId === draft.connectionId);
      try {if (draft.configuration.baseUrl) draft.configuration.baseUrl = normalizeCustomImageBaseUrl(draft.configuration.baseUrl);} catch {publish({phase: 'error', notice: 'image.settings.error.validation'}); return false;}
      const common = {...draft, expectedRevision: state.snapshot!.revision, secret: value ? {action: 'replace', storage: state.storage, value} : {action: state.secretAction}};
      const parsed = previous ? customImagePutV2Schema.safeParse({...common, expectedConfigurationRevision: previous.configurationRevision}) : customImageCreateV2Schema.safeParse(common);
      if (!parsed.success || value && state.storage === 'persistent' && !state.snapshot!.storage.persistentAvailable) {publish({phase: 'error', notice: 'image.settings.error.validation'}); return false;}
      return write({...parsed.data, action: previous ? 'put' : 'create'} as CustomImageServicesWrite, draft.connectionId);
    },
    async remove() {
      if (!editable() || state.recovery || !state.snapshot || !state.draft) return false;
      const selected = state.snapshot.connections.find(item => item.connectionId === state.draft!.connectionId);
      if (!selected) {choose(null); return true;}
      return write({action: 'remove', expectedRevision: state.snapshot.revision, connectionId: selected.connectionId, expectedConfigurationRevision: selected.configurationRevision}, selected.connectionId, true);
    },
    discard() {if (!editable() || state.recovery) return false; choose(state.baseline); return true;},
    useLatest() {if (!editable() || !state.snapshot || state.phase === 'blocked') return false; choose(state.draft ? fromSaved(state.draft.connectionId) : null); return true;},
    acknowledge() {if (!editable() || state.phase !== 'review') return false; ++epoch; publish({phase: 'ready', recovery: null, notice: null}); return true;},
    setVisible(value: boolean) {visible = value;},
    dispose() {live = false; ++epoch; pending?.abort(); state = initialCustomImageServicesState();},
  };
}
export type CustomImageServicesSession = ReturnType<typeof createCustomImageServicesSession>;
