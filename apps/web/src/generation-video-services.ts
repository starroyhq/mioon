import {VIDEO_BUILTIN_PROVIDER_IDS, videoSettingsUpdateV2Schema} from '../../../packages/contracts/src/generation-video-settings.ts';
import type {VideoConnectionConfigurationV2, VideoSettingsOperationV2, VideoSettingsSnapshotV2, VideoSettingsUpdateV2} from '../../../packages/contracts/src/generation-video-settings.ts';
import {normalizeCompatibleVideoBaseUrl, VIDEO_SETTINGS_LIMITS, videoBindingCapabilities, videoConnectionEndpoint} from '../../../packages/contracts/src/video-providers.ts';
import type {MessageKey} from '../../../packages/i18n/src/index.ts';
import {createVideoSettingsClient, newVideoConnection, safeVideoSettings} from './video-settings.ts';
import type {VideoSettingsClient} from './video-settings.ts';
import type {GenerationSaveTicket} from './generation-services-settings.ts';

const clone = <T,>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const safeError = () => Object.assign(Error('Video settings are not ready to save.'), {code: 'VIDEO_SETTINGS_VALIDATION'});
const errorCode = (value: unknown): string => value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : 'NETWORK';
export const videoServiceKey = (configuration: VideoConnectionConfigurationV2): string => `video:${configuration.providerId === 'compatible' ? configuration.id : configuration.providerId}`;
export interface GenerationVideoDraft {
  key: string;
  configuration: VideoConnectionConfigurationV2;
  baseline: VideoConnectionConfigurationV2 | null;
  touched: boolean;
  storage: '' | 'session' | 'persistent';
  secretAction: 'keep' | 'remove' | 'replace';
  hasKey: boolean;
}
export interface GenerationVideoState {
  phase: 'loading' | 'ready' | 'saving' | 'saved' | 'error' | 'load_error' | 'review' | 'blocked' | 'reconciling';
  snapshot: VideoSettingsSnapshotV2 | null;
  drafts: GenerationVideoDraft[];
  deletedIds: string[];
  recovery: 'conflict' | 'unknown' | null;
  notice: MessageKey | null;
  version: number;
  editorEpoch: number;
}
export const generationVideoBusy = (state: GenerationVideoState): boolean => ['loading', 'saving', 'reconciling'].includes(state.phase);
export const generationVideoDraftDirty = (draft: GenerationVideoDraft): boolean => draft.secretAction !== 'keep' || draft.touched && !same(draft.configuration, draft.baseline);
export const generationVideoDirty = (state: GenerationVideoState): boolean => state.deletedIds.length > 0 || state.drafts.some(generationVideoDraftDirty);
export const initialGenerationVideoState = (): GenerationVideoState => ({phase: 'loading', snapshot: null, drafts: VIDEO_BUILTIN_PROVIDER_IDS.map(id => {const configuration = newVideoConnection(id); return {key: videoServiceKey(configuration), configuration, baseline: null, touched: false, storage: '', secretAction: 'keep', hasKey: false};}), deletedIds: [], recovery: null, notice: null, version: 0, editorEpoch: 0});
/** Uses only saved, redacted facts and the existing local capability validator. */
export function generationVideoAvailable(snapshot: VideoSettingsSnapshotV2 | null, configuration: VideoConnectionConfigurationV2): boolean | null {
  if (!snapshot) return null;
  const saved = snapshot.connections.find(view => view.configuration.id === configuration.id);
  if (!saved || !saved.secret.configured || !saved.configuration.enabled || saved.secret.storage === 'persistent' && !snapshot.storage.persistentAvailable) return false;
  return saved.configuration.models.some(model => {
    if (!model.enabled || model.archived) return false;
    try {
      const capabilities = videoBindingCapabilities({version: 1, connectionId: saved.configuration.id, configurationRevision: saved.revision, providerId: saved.configuration.providerId, region: saved.configuration.region, workspaceId: saved.configuration.workspaceId, endpoint: videoConnectionEndpoint(saved.configuration), credentialRef: '00000000-0000-4000-8000-000000000000', outputHosts: saved.configuration.outputHosts, model});
      return capabilities.status === 'available' && capabilities.inputProfileEvaluations.every(evaluation => evaluation.ok);
    } catch {return false;}
  });
}
export function createGenerationVideoServicesSession({client = createVideoSettingsClient(), onChange = () => {}}: {client?: VideoSettingsClient; onChange?: (state: GenerationVideoState) => void} = {}) {
  let state = initialGenerationVideoState();
  let live = true, visible = true, epoch = 0, pending: AbortController | null = null;
  const tickets = new Set<() => void>();
  const emit = (patch: Partial<GenerationVideoState>) => {if (live) {state = {...state, ...patch, version: state.version + 1}; onChange(clone(state));}};
  const owned = (token: number) => live && visible && epoch === token;
  const editable = () => live && visible && !generationVideoBusy(state) && !state.recovery;
  const fromSnapshot = (snapshot: VideoSettingsSnapshotV2): GenerationVideoDraft[] => {
    const configurations = [...VIDEO_BUILTIN_PROVIDER_IDS.map(id => snapshot.connections.find(view => view.configuration.providerId === id)?.configuration ?? newVideoConnection(id)), ...snapshot.connections.filter(view => view.configuration.providerId === 'compatible').map(view => view.configuration)];
    return configurations.map(configuration => {const saved = snapshot.connections.find(view => view.configuration.id === configuration.id); return {key: videoServiceKey(configuration), configuration: clone(configuration), baseline: saved ? clone(configuration) : null, touched: false, storage: saved?.secret.storage === 'none' || !saved ? '' : saved.secret.storage, secretAction: 'keep', hasKey: false};});
  };
  async function load(recover = false): Promise<boolean> {
    if (!live || !visible || generationVideoBusy(state) && state.phase !== 'loading') return false;
    pending?.abort(); pending = new AbortController(); const token = ++epoch;
    emit({phase: recover ? 'reconciling' : 'loading', notice: null});
    try {
      const snapshot = safeVideoSettings(await client.read(pending.signal)); if (!owned(token)) return false;
      emit(recover ? {snapshot, phase: 'review', recovery: state.recovery ?? 'unknown', notice: 'video.providers.unknown'} : {snapshot, drafts: fromSnapshot(snapshot), deletedIds: [], phase: 'ready', recovery: null, editorEpoch: state.editorEpoch + 1}); return true;
    } catch {if (owned(token)) emit({phase: recover ? 'blocked' : 'load_error', notice: recover ? 'video.providers.unknown' : 'video.providers.loadFailed'}); return false;}
  }
  function prepareSave(readKey: (key: string) => string, clearKeys: () => void): GenerationSaveTicket | null {
    let operations: VideoSettingsOperationV2[] = [];
    try {
      if (!editable() || !state.snapshot) throw safeError();
      for (const draft of state.drafts) {
        const value = readKey(draft.key);
        if (!generationVideoDraftDirty(draft) && !value) continue;
        const configuration = clone(draft.configuration);
        if (configuration.providerId === 'compatible') {try {configuration.baseUrl = normalizeCompatibleVideoBaseUrl(configuration.baseUrl);} catch {emit({phase: 'error', notice: 'video.providers.baseUrlInvalid'}); throw safeError();}}
        if (draft.secretAction === 'replace' && !value || value && !draft.storage || value && draft.storage === 'persistent' && !state.snapshot.storage.persistentAvailable) {emit({phase: 'error', notice: 'video.providers.invalid'}); throw safeError();}
        operations.push({action: 'save', configuration, secret: value ? {action: 'replace', value, storage: draft.storage === 'persistent' ? 'persistent' : 'session'} : {action: draft.secretAction === 'remove' ? 'remove' : 'keep'}});
      }
      // Remove first inside the same atomic batch so replacing a service at
      // capacity does not briefly exceed the unchanged connection budget.
      operations = [...state.deletedIds.map(connectionId => ({action: 'delete' as const, connectionId})), ...operations];
    } finally {clearKeys();}
    if (!operations.length) return null;
    const parsed = videoSettingsUpdateV2Schema.safeParse({action: 'batch', expectedRevision: state.snapshot!.revision, operations});
    operations = [];
    if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > VIDEO_SETTINGS_LIMITS.updateBytes) {emit({phase: 'error', notice: 'video.providers.invalid'}); throw safeError();}
    let request: VideoSettingsUpdateV2 | null = parsed.data, used = false, finished = false;
    const release = () => {request = null;}; tickets.add(release);
    const expectedRevision = parsed.data.expectedRevision;
    const accepted = parsed.data.action === 'batch' ? parsed.data.operations.map(operation => operation.action === 'save' ? {action: 'save' as const, configuration: clone(operation.configuration), secret: operation.secret.action, storage: operation.secret.action === 'replace' ? operation.secret.storage : null} : {action: 'delete' as const, connectionId: operation.connectionId}) : [];
    const token = ++epoch; pending?.abort(); const controller = new AbortController(); pending = controller;
    emit({phase: 'saving', notice: null});
    return {
      async run() {
        if (used || !request || !owned(token)) return 'blocked';
        used = true; let input: VideoSettingsUpdateV2 | null = request; request = null; tickets.delete(release);
        try {
          let writing: Promise<VideoSettingsSnapshotV2>;
          try {writing = client.write(input, controller.signal);} finally {input = null;}
          const snapshot = safeVideoSettings(await writing);
          if (!owned(token)) return 'blocked';
          if (snapshot.revision !== expectedRevision && snapshot.revision !== expectedRevision + 1 || accepted.some(operation => operation.action === 'delete' ? snapshot.connections.some(view => view.configuration.id === operation.connectionId) : !snapshot.connections.some(view => same(view.configuration, operation.configuration) && (operation.secret !== 'remove' || !view.secret.configured) && (operation.secret !== 'replace' || view.secret.configured && view.secret.storage === operation.storage)))) throw Object.assign(Error('Video settings response could not be confirmed.'), {code: 'INVALID_RESPONSE'});
          // Keep untouched built-in draft UUIDs stable across collection commits.
          const drafts = fromSnapshot(snapshot).map(next => {
            const previous = state.drafts.find(draft => draft.key === next.key);
            return !next.baseline && previous ? {...next, configuration: clone(previous.configuration)} : next;
          });
          finished = true; emit({snapshot, drafts, deletedIds: [], phase: 'saved', recovery: null, notice: 'video.providers.saved', editorEpoch: state.editorEpoch + 1}); return 'saved';
        } catch (error) {
          if (!owned(token)) return 'blocked';
          const code = errorCode(error);
          if (['VIDEO_SETTINGS_VALIDATION', 'UNAUTHORIZED', 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE', 'VIDEO_SETTINGS_CAPACITY'].includes(code)) {finished = true; emit({phase: 'error', notice: code === 'VIDEO_SETTINGS_CAPACITY' ? 'video.providers.capacity' : 'video.providers.invalid'}); return 'error';}
          const recovery = ['VIDEO_SETTINGS_CONFLICT', 'VIDEO_SETTINGS_DELETED'].includes(code) ? 'conflict' : 'unknown';
          emit({phase: 'reconciling', recovery, notice: recovery === 'conflict' ? 'video.providers.conflict' : 'video.providers.unknown'});
          try {const snapshot = safeVideoSettings(await client.read(controller.signal)); if (owned(token)) emit({snapshot, phase: 'review'});} catch {if (owned(token)) emit({phase: 'blocked'});}
          finished = true; return recovery === 'unknown' ? 'unknown' : 'blocked';
        }
      },
      dispose() {release(); tickets.delete(release); if (!used && !finished && owned(token)) {finished = true; emit({phase: 'ready'});}},
    };
  }
  return {
    getState: () => clone(state), canEdit: editable, load: () => load(), reload: () => load(Boolean(state.snapshot)), prepareSave,
    update(key: string, patch: Partial<VideoConnectionConfigurationV2>) {
      if (!editable()) return false;
      const drafts = state.drafts.map(draft => draft.key === key ? {...draft, touched: true, configuration: {...draft.configuration, ...clone(patch), id: draft.configuration.id, providerId: draft.configuration.providerId}} : draft);
      if (!drafts.some(draft => draft.key === key)) return false; emit({drafts, phase: 'ready', notice: null}); return true;
    },
    keyEdited(key: string, hasKey: boolean) {if (!editable()) return false; emit({drafts: state.drafts.map(draft => draft.key === key ? {...draft, hasKey, secretAction: hasKey ? 'replace' : 'keep'} : draft), phase: 'ready', notice: null}); return true;},
    keysCleared(key?: string) {if (state.drafts.some(draft => draft.hasKey && (!key || key === draft.key))) emit({drafts: state.drafts.map(draft => !key || key === draft.key ? {...draft, hasKey: false} : draft)});},
    setStorage(key: string, storage: GenerationVideoDraft['storage']) {if (!editable() || storage === 'persistent' && !state.snapshot?.storage.persistentAvailable) return false; emit({drafts: state.drafts.map(draft => draft.key === key ? {...draft, storage} : draft)}); return true;},
    removeKey(key: string, remove: boolean) {if (!editable()) return false; emit({drafts: state.drafts.map(draft => draft.key === key ? {...draft, hasKey: false, secretAction: remove ? 'remove' : 'keep'} : draft)}); return true;},
    add(): string | null {
      if (!editable() || !state.snapshot || state.drafts.filter(draft => draft.configuration.providerId === 'compatible').length >= 26) return null;
      const configuration = newVideoConnection('compatible'), key = videoServiceKey(configuration);
      emit({drafts: [...state.drafts, {key, configuration, baseline: null, touched: true, storage: '', secretAction: 'keep', hasKey: false}], phase: 'ready', notice: null}); return key;
    },
    stageDelete(key: string) {if (!editable()) return false; const found = state.drafts.find(draft => draft.key === key); if (found?.configuration.providerId !== 'compatible') return false; emit({drafts: state.drafts.filter(draft => draft.key !== key), deletedIds: found.baseline ? [...state.deletedIds, found.configuration.id] : state.deletedIds, phase: 'ready', notice: null}); return true;},
    discard() {if (!editable() || !state.snapshot) return false; const defaults = state.drafts; emit({drafts: fromSnapshot(state.snapshot).map(next => !next.baseline ? {...next, configuration: {...next.configuration, id: defaults.find(draft => draft.key === next.key)?.configuration.id ?? next.configuration.id}} : next), deletedIds: [], phase: 'ready', notice: null, editorEpoch: state.editorEpoch + 1}); return true;},
    useLatest() {if (!live || !visible || generationVideoBusy(state) || !state.snapshot || state.phase === 'blocked') return false; emit({drafts: fromSnapshot(state.snapshot), deletedIds: [], phase: 'ready', recovery: null, notice: null, editorEpoch: state.editorEpoch + 1}); return true;},
    acknowledge() {if (!live || !visible || state.phase !== 'review') return false; emit({phase: 'ready', recovery: null, notice: null}); return true;},
    setVisible(value: boolean) {
      if (visible === value) return; visible = value; ++epoch; pending?.abort(); pending = null;
      if (!value) {for (const release of tickets) release(); tickets.clear();}
      if (!value && generationVideoBusy(state) && state.phase !== 'loading') emit({phase: 'blocked', recovery: 'unknown', notice: 'video.providers.unknown'});
      else if (!value && state.phase === 'loading') emit({phase: 'ready'});
    },
    dispose() {live = false; ++epoch; pending?.abort(); for (const release of tickets) release(); tickets.clear();},
  };
}
export type GenerationVideoServicesSession = ReturnType<typeof createGenerationVideoServicesSession>;
