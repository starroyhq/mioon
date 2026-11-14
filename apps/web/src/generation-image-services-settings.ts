import {measureSettingsRead} from './settings-diagnostics.ts';
import {canonicalImageInput} from '../../../packages/contracts/src/images.ts';
import {imageSettingsResultSchema, imageSettingsUpdateSchema} from '../../../packages/contracts/src/image-settings.ts';
import {normalizeCustomImageBaseUrl} from '../../../packages/contracts/src/image-compatible.ts';
import {customImageProbeSchema, officialImageProbeSchema} from '../../../packages/contracts/src/draft-image-probe.ts';
import type {CustomImageProbe, OfficialImageProbe} from '../../../packages/contracts/src/draft-image-probe.ts';
import {draftServiceProbeResultSchema} from '../../../packages/contracts/src/draft-service-probe.ts';
import type {DraftServiceProbeResult} from '../../../packages/contracts/src/draft-service-probe.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_LIMITS, DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, customImageBatchV2Schema, customImageSettingsV2ResultSchema} from '../../../packages/contracts/src/generation-image-settings.ts';
import type {CustomImageConfigurationV2, CustomImageSettingsV2Result} from '../../../packages/contracts/src/generation-image-settings.ts';
import {comfyImageSettingsResultSchema, comfyImageSettingsUpdateSchema, comfyImageCheckResultSchema, normalizeComfyImageBaseUrl} from '../../../packages/contracts/src/comfy-images.ts';
import {comfyConnectorAvailabilitySchema} from '@mioon/contracts';
import type {ImageSettingsResult} from './image-settings.ts';
import type {ComfyImageSettingsResult, ComfyImageCheckResult, ComfyConnectorAvailability} from './comfy-image-settings.ts';
import {settingsNavigationState} from './settings-navigation-state.ts';
import type {GenerationDomainOutcome, GenerationSaveTicket} from './generation-services-settings.ts';
import {watchPendingSecretStorage} from './settings-secret-storage.ts';

export type GenerationImageDomainKind = 'official' | 'custom' | 'comfy';
export interface GenerationImageServicesClient {
  read(signal?: AbortSignal): Promise<unknown>;
  write(input: unknown, signal?: AbortSignal): Promise<unknown>;
  readAvailability?(signal?: AbortSignal): Promise<unknown>;
  check?(input: {baseUrl: string; model: string}, signal?: AbortSignal): Promise<unknown>;
  probe?(input: OfficialImageProbe | CustomImageProbe, signal?: AbortSignal): Promise<unknown>;
}
export type GenerationImageSnapshot = ImageSettingsResult | CustomImageSettingsV2Result | ComfyImageSettingsResult;
type EditableConfiguration<T> = T extends object ? Omit<T, 'enabled' | 'baseUrl' | 'model'> & {enabled: boolean; baseUrl: string; model: string} : never;
type Configuration = EditableConfiguration<ImageSettingsResult['configuration'] | CustomImageConfigurationV2 | ComfyImageSettingsResult['configuration']>;
export interface GenerationImageDraft {
  id: string; name: string; configuration: Configuration;
  storage: '' | 'session' | 'persistent'; secretAction: 'keep' | 'remove'; hasKey: boolean; needsKey: boolean;
}
export interface GenerationImageDomainState {
  phase: 'loading' | 'ready' | 'saving' | 'saved' | 'reconciling' | 'review' | 'blocked' | 'load_error' | 'error' | 'checking';
  snapshot: GenerationImageSnapshot | null; drafts: GenerationImageDraft[]; deleted: string[];
  recovery: 'conflict' | 'unknown' | null; notice: string | null; version: number;
  availability: ComfyConnectorAvailability | null; check: ComfyImageCheckResult | null;
  probe: {id: string; operation: 'check' | 'models'; result: DraftServiceProbeResult} | null;
}
const copy = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => canonicalImageInput(a) === canonicalImageInput(b);
const invalid = () => Object.assign(new Error('Image settings need review.'), {code: 'IMAGE_SETTINGS_VALIDATION'});
const invalidResponse = () => Object.assign(new Error('Image settings confirmation could not be verified.'), {code: 'INVALID_RESPONSE'});
const documentVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'NETWORK';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const routeFor = (kind: GenerationImageDomainKind) => kind === 'official' ? '/api/images/settings' : kind === 'custom' ? '/api/images/custom-settings' : '/api/images/comfy-settings';

/** Dedicated existing HTTP protocols; external abort also settles a fetch double
 * that ignores AbortSignal. An aborted PUT is always treated as uncertain. */
export function createGenerationImageServicesClient(kind: GenerationImageDomainKind, fetchImpl: typeof fetch = globalThis.fetch): GenerationImageServicesClient {
  async function request(route: string, method: string, input?: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, rejectAbort: (() => void) | undefined;
    const abort = () => {controller.abort(); rejectAbort?.();};
    const cancelled = new Promise<never>((_, reject) => {rejectAbort = () => reject(Object.assign(new Error('Image settings request did not complete.'), {code: 'NETWORK'}));});
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    timer = setTimeout(abort, route.endsWith('comfy-check') ? 45000 : 12000);
    try {
      const transport = (async () => {
        if (controller.signal.aborted) throw invalid();
        const response = await fetchImpl(route, {method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          ...(input === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)})});
        const value: unknown = await response.json();
        if (!response.ok || !isRecord(value) || value.ok !== true) {
          const code = isRecord(value) && isRecord(value.error) && typeof value.error.code === 'string' ? value.error.code : 'NETWORK';
          throw Object.assign(new Error('Image settings request failed.'), {code: response.status === 401 ? 'UNAUTHORIZED' : /^(?:IMAGE_SETTINGS|COMFY_[A-Z_]+)_[A-Z_]+$/.test(code) ? code : 'NETWORK'});
        }
        return value.data;
      })();
      return await Promise.race([transport, cancelled]);
    } catch (error) {
      const code = codeOf(error);
      throw Object.assign(new Error('Image settings request did not complete.'), {code: code === 'UNAUTHORIZED' || /^(?:IMAGE_SETTINGS|COMFY_[A-Z_]+)_[A-Z_]+$/.test(code) ? code : 'NETWORK'});
    } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort);}
  }
  const readStage = kind === 'comfy' ? 'generation-comfy' : kind === 'official' ? 'generation-image-official' : 'generation-image-custom';
  return {read: signal => measureSettingsRead(readStage, () => request(routeFor(kind), 'GET', undefined, signal)), write: (input, signal) => request(routeFor(kind), 'PUT', input, signal),
    readAvailability: signal => measureSettingsRead('generation-comfy-availability', () => request('/api/images/comfy-availability', 'GET', undefined, signal)),
    ...(kind === 'comfy'
      ? {check: (input, signal) => request('/api/images/comfy-check', 'POST', input, signal)}
      : {probe: (input, signal) => request(routeFor(kind), 'POST', input, signal)})};
}

function safeSnapshot(kind: GenerationImageDomainKind, value: unknown): GenerationImageSnapshot {
  const result = kind === 'custom' ? customImageSettingsV2ResultSchema.safeParse(value) : kind === 'official' ? imageSettingsResultSchema.safeParse(value) : comfyImageSettingsResultSchema.safeParse(value);
  if (!result.success) throw invalidResponse();
  return copy(result.data);
}
function draftsFor(snapshot: GenerationImageSnapshot): GenerationImageDraft[] {
  if ('connections' in snapshot) return snapshot.connections.map(item => ({id: item.connectionId, name: item.name, configuration: copy(item.configuration), storage: item.secret.storage === 'none' ? '' : item.secret.storage, secretAction: 'keep', hasKey: false, needsKey: false}));
  return [{id: 'readiness' in snapshot ? 'image:comfy' : 'image:official', name: '', configuration: copy(snapshot.configuration),
    storage: 'secret' in snapshot && snapshot.secret.storage !== 'none' ? snapshot.secret.storage : '', secretAction: 'keep', hasKey: false, needsKey: false}];
}

/** One owner per file, never one owner per selected panel. State contains only
 * redacted drafts; the refs map holds DOM nodes and never copied passwords. */
export function createGenerationImageServicesOwner(kind: GenerationImageDomainKind, {client = createGenerationImageServicesClient(kind), onChange = () => {}, interactionAllowed = () => true}: {client?: GenerationImageServicesClient; onChange?: (state: GenerationImageDomainState) => void; interactionAllowed?: () => boolean} = {}) {
  let state: GenerationImageDomainState = {phase: 'loading', snapshot: null, drafts: [], deleted: [], recovery: null, notice: null, version: 0, availability: null, check: null, probe: null};
  let live = true, pageVisible = true, pageEpoch = 0, requestEpoch = 0, checkEpoch = 0, draftVersion = 0, prepared: GenerationSaveTicket | null = null;
  let probeOwner: string | null = null;
  let pending: AbortController | null = null, checking: AbortController | null = null, availabilityPending: AbortController | null = null;
  const inputs = new Map<string, Pick<HTMLInputElement, 'value'>>();
  const watchStorage = watchPendingSecretStorage(async signal => {
    const before = state.snapshot;
    if (!before || !('storage' in before)) return;
    const next = safeSnapshot(kind, await client.read(signal));
    if (!signal.aborted && state.snapshot === before && 'storage' in next && next.storage.reasonCode !== 'OS_SECRET_STORE_PENDING') {
      publish({snapshot: {...before, storage: next.storage}});
    }
  });
  const observeStorage = () => watchStorage(live && pageVisible && !!state.snapshot && 'storage' in state.snapshot && state.snapshot.storage.reasonCode === 'OS_SECRET_STORE_PENDING');
  const publish = (patch: Partial<GenerationImageDomainState>) => {if (live) {state = {...state, ...patch, version: state.version + 1}; observeStorage(); onChange(copy(state));}};
  const baseline = () => state.snapshot ? draftsFor(state.snapshot) : [];
  const draftDirty = (draft: GenerationImageDraft) => {
    const before = baseline().find(item => item.id === draft.id);
    return !before || before.name !== draft.name || !same(before.configuration, draft.configuration) || draft.secretAction !== 'keep' || draft.hasKey || draft.needsKey;
  };
  const dirty = () => !!state.recovery || state.deleted.length > 0 || state.drafts.some(draftDirty);
  const busy = () => ['loading', 'saving', 'reconciling', 'checking'].includes(state.phase);
  const canInteract = () => live && pageVisible && documentVisible() && interactionAllowed();
  const editable = () => canInteract() && !busy() && !state.recovery && !prepared;
  const clearKeys = (id?: string) => {
    for (const [key, input] of inputs) if (!id || key === id) input.value = '';
    if (state.drafts.some(item => item.hasKey && (!id || item.id === id))) {++draftVersion; publish({drafts: state.drafts.map(item => !id || item.id === id ? {...item, hasKey: false} : item)});}
  };
  const receive = (snapshot: GenerationImageSnapshot) => publish({snapshot});
  const savedSecret = (id: string) => {
    const snapshot = state.snapshot;
    return snapshot && 'connections' in snapshot ? snapshot.connections.find(item => item.connectionId === id)?.secret : snapshot && 'secret' in snapshot ? snapshot.secret : undefined;
  };
  function cancelCheck(id?: string) {
    if (id && probeOwner !== id && state.probe?.id !== id && (kind !== 'comfy' || id !== 'image:comfy')) return;
    ++checkEpoch; checking?.abort(); checking = null; probeOwner = null;
    if (state.phase === 'checking') publish({phase: 'ready', check: null, probe: null});
    else if (state.probe) publish({probe: null});
  }
  function savedProbeTarget(draft: GenerationImageDraft) {
    const saved = savedSecret(draft.id);
    if (draft.secretAction !== 'keep' || draft.needsKey || !saved?.configured || !state.snapshot) return null;
    if (saved.storage === 'persistent' && (!('storage' in state.snapshot) || !state.snapshot.storage.persistentAvailable)) return null;
    if ('connections' in state.snapshot) {
      const saved = state.snapshot.connections.find(item => item.connectionId === draft.id);
      if (!saved) return null;
      try {
        if (normalizeCustomImageBaseUrl(draft.configuration.baseUrl) !== saved.configuration.baseUrl) return null;
      } catch {return null;}
      return {source: 'saved' as const, connectionId: draft.id, configurationRevision: saved.configurationRevision};
    }
    return {source: 'saved' as const, configurationRevision: state.snapshot.revision};
  }
  function canProbe(id: string): boolean {
    if (kind === 'comfy' || !editable() || !client.probe) return false;
    const draft = state.drafts.find(item => item.id === id);
    if (!draft || draft.secretAction === 'remove') return false;
    if (!inputs.get(id)?.value) return !!savedProbeTarget(draft);
    try {return kind === 'official' || Boolean(normalizeCustomImageBaseUrl(draft.configuration.baseUrl));}
    catch {return false;}
  }
  async function checkCredential(id: string, operation: 'check' | 'models'): Promise<DraftServiceProbeResult | null> {
    if (!canProbe(id) || !client.probe) return null;
    const draft = state.drafts.find(item => item.id === id)!;
    const value = inputs.get(id)?.value ?? '';
    const credential = value ? {source: 'draft' as const, value} : savedProbeTarget(draft);
    const parsed = kind === 'official'
      ? officialImageProbeSchema.safeParse({operation, credential})
      : customImageProbeSchema.safeParse({operation, credential, baseUrl: normalizeCustomImageBaseUrl(draft.configuration.baseUrl)});
    if (!parsed.success) {
      publish({probe: {id, operation, result: {result: 'failed'}}});
      return null;
    }
    const controller = new AbortController();
    checking = controller; probeOwner = id;
    const token = ++checkEpoch;
    const current = () => canInteract() && token === checkEpoch && checking === controller;
    publish({phase: 'checking', probe: null});
    try {
      if (!current()) return null;
      const response = await client.probe(parsed.data, controller.signal);
      if (!current()) return null;
      const result = draftServiceProbeResultSchema.parse(response);
      if ((result.result === 'ok' && operation === 'models' && !result.models) ||
          (operation === 'check' && result.models !== undefined) ||
          (value && result.models?.some(model => model.id.includes(value)))) throw invalidResponse();
      publish({phase: 'ready', probe: {id, operation, result}});
      return result;
    } catch {
      if (current()) publish({phase: 'ready', probe: {id, operation, result: {result: 'failed'}}});
      return null;
    } finally {
      if (checking === controller) {checking = null; probeOwner = null;}
    }
  }
  async function read(recover = false): Promise<boolean> {
    if (!live || !pageVisible || prepared || state.phase === 'saving') return false;
    cancelCheck();
    pending?.abort(); pending = new AbortController(); const signal = pending.signal, token = ++requestEpoch, page = pageEpoch;
    publish({phase: recover ? 'reconciling' : 'loading', notice: null});
    if (kind === 'comfy' && client.readAvailability) {
      availabilityPending?.abort(); availabilityPending = new AbortController();
      void client.readAvailability(availabilityPending.signal).then(value => {
        if (!live || page !== pageEpoch) return;
        const parsed = comfyConnectorAvailabilitySchema.safeParse(value); publish({availability: parsed.success ? parsed.data : null});
      }, () => {if (live && page === pageEpoch) publish({availability: null});});
    }
    try {
      const snapshot = safeSnapshot(kind, await client.read(signal));
      if (!live || token !== requestEpoch || page !== pageEpoch || !pageVisible) return false;
      publish({snapshot, drafts: recover ? state.drafts : draftsFor(snapshot), deleted: recover ? state.deleted : [], check: null, probe: null,
        phase: recover ? 'review' : 'ready', recovery: recover ? state.recovery ?? 'unknown' : null,
        notice: recover ? 'image.settings.notice.review' : null}); return true;
    } catch {if (live && token === requestEpoch && page === pageEpoch) publish({phase: recover ? 'blocked' : 'load_error', notice: 'image.settings.notice.loadError'}); return false;}
  }
  function prepareSave(): GenerationSaveTicket | null {
    // Capture every own field even on a validation failure; no caller needs to
    // retain or inspect a credential to clear the rest of the page.
    const values = new Map<string, string>();
    for (const [id, input] of inputs) {values.set(id, input.value); input.value = '';}
    // Browser autofill may not emit a change event. Preserve only its replacement
    // intent after capture so a skipped ticket cannot silently become "keep".
    if (state.drafts.some(item => !!values.get(item.id) && !item.needsKey)) {
      ++draftVersion; publish({drafts: state.drafts.map(item => values.get(item.id) ? {...item, hasKey: true, needsKey: true} : item)});
    }
    const changed = state.drafts.filter(item => draftDirty(item) || !!values.get(item.id));
    clearKeys();
    if (!live || !pageVisible || !documentVisible() || !state.snapshot || busy() || state.recovery || prepared) {values.clear(); throw invalid();}
    if (!changed.length && !state.deleted.length) {values.clear(); return null;}
    const before = copy(state.snapshot), drafts = copy(changed), deleted = [...state.deleted];
    let body: string | undefined;
    const secretFor = (draft: GenerationImageDraft) => {
      const value = values.get(draft.id);
      if (draft.needsKey && !value && draft.secretAction !== 'remove') throw invalid();
      if (!value) return {action: draft.secretAction};
      if (!['session', 'persistent'].includes(draft.storage) || draft.storage === 'persistent' && (!('storage' in before) || !before.storage.persistentAvailable)) throw invalid();
      return {action: 'replace', storage: draft.storage, value};
    };
    try {
      let input: unknown;
      if (kind === 'custom' && 'connections' in before) {
        const operations: unknown[] = drafts.map(draft => {
          const previous = before.connections.find(item => item.connectionId === draft.id), configuration = {...draft.configuration,
            baseUrl: draft.configuration.baseUrl ? normalizeCustomImageBaseUrl(draft.configuration.baseUrl) : ''};
          return {action: previous ? 'put' : 'create', connectionId: draft.id, name: draft.name, configuration, secret: secretFor(draft), ...(previous ? {expectedConfigurationRevision: previous.configurationRevision} : {})};
        });
        for (const id of deleted) {const previous = before.connections.find(item => item.connectionId === id); if (!previous) throw invalid(); operations.push({action: 'remove', connectionId: id, expectedConfigurationRevision: previous.configurationRevision});}
        const parsed = customImageBatchV2Schema.safeParse({expectedRevision: before.revision, operations}); if (!parsed.success) throw invalid();
        input = {action: 'batch', ...parsed.data};
      } else if (kind === 'official' && !('connections' in before)) {
        const parsed = imageSettingsUpdateSchema.safeParse({expectedRevision: before.revision, configuration: drafts[0]!.configuration, secret: secretFor(drafts[0]!)}); if (!parsed.success) throw invalid(); input = parsed.data;
      } else if (kind === 'comfy' && !('connections' in before)) {
        const configuration = {...drafts[0]!.configuration, baseUrl: drafts[0]!.configuration.baseUrl ? normalizeComfyImageBaseUrl(drafts[0]!.configuration.baseUrl) : ''};
        const parsed = comfyImageSettingsUpdateSchema.safeParse({expectedRevision: before.revision, configuration}); if (!parsed.success) throw invalid(); input = parsed.data;
      } else throw invalid();
      body = JSON.stringify(input);
      if (new TextEncoder().encode(body).length > (kind === 'custom' ? CUSTOM_IMAGE_SETTINGS_V2_LIMITS.updateBytes : 16 * 1024)) throw invalid();
    } catch {body = undefined; publish({phase: 'error', notice: 'image.settings.error.validation'}); throw invalid();}
    finally {values.clear();}
    // ACK expectations contain no replacement values, even while another file
    // is saving. Clearing/disposal releases all unsent transport material.
    const expected = JSON.parse(body) as Record<string, unknown>;
    const stripSecrets = (value: Record<string, unknown>) => {if (isRecord(value.secret)) {const {value: _credential, ...redacted} = value.secret; value.secret = redacted;}};
    stripSecrets(expected); if (Array.isArray(expected.operations)) for (const operation of expected.operations) if (isRecord(operation)) stripSecrets(operation);
    publish({phase: 'saving', notice: null, probe: null});
    const version = draftVersion, page = pageEpoch; let used = false, disposed = false, started = false;
    const current = () => live && pageVisible && documentVisible() && page === pageEpoch && draftVersion === version && prepared === ticket;
    const ticket: GenerationSaveTicket = {
      async run(): Promise<GenerationDomainOutcome> {
        if (used || disposed || !body || !current()) return 'blocked';
        used = true; started = true; const input: unknown = JSON.parse(body); body = undefined;
        pending = new AbortController(); const signal = pending.signal, token = ++requestEpoch;
        try {
          const snapshot = safeSnapshot(kind, await client.write(input, signal));
          if (!live || !pageVisible || page !== pageEpoch || token !== requestEpoch) return 'unknown';
          assertAcknowledgement(kind, before, snapshot, expected);
          prepared = null; publish({snapshot, drafts: draftsFor(snapshot), deleted: [], recovery: null, phase: 'saved', notice: 'image.settings.services.saved'}); return 'saved';
        } catch (error) {
          if (!live || page !== pageEpoch || token !== requestEpoch) return 'unknown';
          const code = codeOf(error), rejected = ['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION', 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE', 'IMAGE_SETTINGS_CAPACITY', 'COMFY_SETTINGS_VALIDATION', 'COMFY_ENDPOINT_INVALID', 'COMFY_ENDPOINT_DENIED', 'COMFY_SETTINGS_DESTINATION_DENIED'].includes(code);
          prepared = null;
          if (rejected) {publish({phase: 'error', notice: 'image.settings.error.validation'}); return 'error';}
          publish({phase: 'reconciling', recovery: code.endsWith('_CONFLICT') ? 'conflict' : 'unknown', notice: 'image.settings.notice.review'});
          try {const snapshot = safeSnapshot(kind, await client.read(signal)); if (live && page === pageEpoch && token === requestEpoch) publish({snapshot, phase: 'review'});}
          catch {if (live && page === pageEpoch && token === requestEpoch) publish({phase: 'blocked'});}
          return state.phase === 'blocked' ? 'blocked' : 'unknown';
        }
      },
      dispose() {disposed = true; body = undefined; if (prepared === ticket) {prepared = null; if (!started) publish({phase: 'ready', notice: 'image.settings.services.staged'});}},
    };
    prepared = ticket; return ticket;
  }
  return {
    getState: () => copy(state), navigation: () => settingsNavigationState({dirty: dirty(), phase: state.phase, recovery: state.recovery}, state.version),
    load: () => read(), reload: () => canInteract() ? read(!!state.snapshot) : Promise.resolve(false), prepareSave, clearKeys, savedSecret, canProbe, checkCredential, interactionAllowed: canInteract,
    isDirty(id: string) {const draft = state.drafts.find(item => item.id === id); return !!draft && draftDirty(draft);},
    registerKey(id: string, input: Pick<HTMLInputElement, 'value'> | null) {const previous = inputs.get(id); if (previous && previous !== input) previous.value = ''; if (input) inputs.set(id, input); else inputs.delete(id);},
    keyChanged(id: string) {if (!editable()) return; ++draftVersion; publish({drafts: state.drafts.map(item => item.id === id ? {...item, hasKey: !!inputs.get(id)?.value, needsKey: !!inputs.get(id)?.value} : item), probe: state.probe?.id === id ? null : state.probe});},
    edit(id: string, patch: Partial<Pick<GenerationImageDraft, 'name' | 'storage' | 'secretAction'>>, configuration: Partial<Pick<Configuration, 'enabled' | 'baseUrl' | 'model'>> = {}) {
      if (!editable()) return false; const draft = state.drafts.find(item => item.id === id); if (!draft) return false;
      if (configuration.baseUrl !== undefined && configuration.baseUrl !== draft.configuration.baseUrl) {clearKeys(id); cancelCheck(); if (kind === 'comfy') configuration = {...configuration, model: ''};}
      if (kind === 'comfy' && configuration.model && !state.check?.checkpoints.includes(configuration.model)) return false;
      if (patch.secretAction === 'remove') {clearKeys(id); publish({drafts: state.drafts.map(item => item.id === id ? {...item, needsKey: false} : item)});}
      ++draftVersion;
      publish({drafts: state.drafts.map(item => item.id === id ? {...item, ...patch, configuration: {...item.configuration, ...configuration}} : item), check: configuration.baseUrl !== undefined ? null : state.check, probe: state.probe?.id === id ? null : state.probe, notice: 'image.settings.services.staged'}); return true;
    },
    add(name: string): string | null {if (kind !== 'custom' || !editable() || !state.snapshot || state.drafts.length >= CUSTOM_IMAGE_SETTINGS_V2_LIMITS.connections) return null;
      const id = crypto.randomUUID().toLowerCase(); ++draftVersion; publish({drafts: [...state.drafts, {id, name, configuration: copy(DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2), storage: '', secretAction: 'keep', hasKey: false, needsKey: false}], notice: 'image.settings.services.staged'}); return id;},
    remove(id: string, version: number): boolean {if (kind !== 'custom' || !editable() || state.version !== version || !state.drafts.some(item => item.id === id)) return false;
      clearKeys(id); ++draftVersion; const stored = baseline().some(item => item.id === id); publish({drafts: state.drafts.filter(item => item.id !== id), deleted: stored ? [...state.deleted, id] : state.deleted, notice: 'image.settings.services.staged'}); return true;},
    discard() {if (!canInteract() || busy()) return; clearKeys(); ++draftVersion; if (state.snapshot) publish({drafts: draftsFor(state.snapshot), deleted: [], recovery: null, phase: 'ready', notice: null, check: null, probe: null});},
    acknowledge() {if (canInteract() && state.phase === 'review') publish({recovery: null, phase: 'ready', notice: 'image.settings.services.staged'});},
    async checkConnection(): Promise<boolean> {
      if (kind !== 'comfy' || !editable() || !client.check || state.availability?.state !== 'available') return false;
      const draft = state.drafts[0]; if (!draft) return false; let baseUrl: string;
      try {baseUrl = normalizeComfyImageBaseUrl(draft.configuration.baseUrl);} catch {publish({notice: 'connections.comfy.issue.endpoint'}); return false;}
      checking?.abort(); checking = new AbortController(); const signal = checking.signal, token = ++checkEpoch, page = pageEpoch; publish({phase: 'checking', check: null});
      try {const check = comfyImageCheckResultSchema.parse(await client.check({baseUrl, model: draft.configuration.model}, signal)); if (check.baseUrl !== baseUrl) throw invalid();
        if (!live || page !== pageEpoch || token !== checkEpoch || !pageVisible || !documentVisible()) return false;
        const snapshot = safeSnapshot(kind, await client.read(signal));
        if (!live || page !== pageEpoch || token !== checkEpoch || !pageVisible) return false;
        const changed = !state.snapshot || 'connections' in snapshot || 'connections' in state.snapshot || snapshot.revision !== state.snapshot.revision || !same(snapshot.configuration, state.snapshot.configuration); receive(snapshot); publish({phase: changed ? 'review' : 'ready', recovery: changed ? 'conflict' : null, check, notice: 'connections.comfy.notice.checked'}); return true;
      } catch {if (live && page === pageEpoch && token === checkEpoch) publish({phase: 'error', check: null, notice: 'connections.comfy.notice.checkError'}); return false;}
    },
    cancelCheck,
    setPageVisible(visible: boolean) {if (visible === pageVisible) return; pageVisible = visible; observeStorage(); ++pageEpoch; ++requestEpoch; pending?.abort(); availabilityPending?.abort(); cancelCheck(); clearKeys();
      if (!visible) {prepared?.dispose(); if (state.phase === 'saving' || state.phase === 'reconciling') publish({phase: 'blocked', recovery: 'unknown', notice: 'image.settings.notice.review'});}
      else if (!state.snapshot) void read();},
    dispose() {clearKeys(); live = false; watchStorage(false); ++pageEpoch; ++requestEpoch; ++checkEpoch; pending?.abort(); checking?.abort(); availabilityPending?.abort(); prepared?.dispose(); inputs.clear();},
  };
}
export type GenerationImageServicesOwner = ReturnType<typeof createGenerationImageServicesOwner>;

function assertAcknowledgement(kind: GenerationImageDomainKind, before: GenerationImageSnapshot, after: GenerationImageSnapshot, expected: Record<string, unknown>): void {
  if (after.revision !== before.revision + 1) throw invalidResponse();
  const checkSecret = (value: {configured: boolean; storage: string}, operation: Record<string, unknown>, previous?: {configured: boolean; storage: string}, addressChanged = false) => {
    if (!isRecord(operation.secret)) throw invalidResponse();
    const secret = operation.secret, wanted = secret.action === 'replace' ? {configured: true, storage: secret.storage} : secret.action === 'remove' || addressChanged ? {configured: false, storage: 'none'} : previous;
    if (!wanted || !same(value, wanted)) throw invalidResponse();
  };
  if (kind === 'custom' && 'connections' in before && 'connections' in after && Array.isArray(expected.operations)) {
    const remaining = new Map(before.connections.map(item => [item.connectionId, item]));
    for (const raw of expected.operations) {
      if (!isRecord(raw) || typeof raw.connectionId !== 'string') throw invalidResponse();
      const previous = remaining.get(raw.connectionId), accepted = after.connections.find(item => item.connectionId === raw.connectionId);
      if (raw.action === 'remove') {if (accepted) throw invalidResponse(); remaining.delete(raw.connectionId); continue;}
      if (!accepted || accepted.name !== raw.name || !same(accepted.configuration, raw.configuration) || accepted.configurationRevision !== (previous ? previous.configurationRevision + 1 : 1)) throw invalidResponse();
      checkSecret(accepted.secret, raw, previous?.secret ?? {configured: false, storage: 'none'}, !!previous && previous.configuration.baseUrl !== accepted.configuration.baseUrl);
      remaining.delete(raw.connectionId);
    }
    const touched = new Set(expected.operations.map(item => isRecord(item) ? item.connectionId : null));
    const untouched = after.connections.filter(item => !touched.has(item.connectionId));
    if (!same(untouched, [...remaining.values()]) || after.connections.length !== untouched.length + expected.operations.filter(item => isRecord(item) && item.action !== 'remove').length) throw invalidResponse();
  } else if (!('connections' in before) && !('connections' in after)) {
    if (!same(after.configuration, expected.configuration)) throw invalidResponse();
    if ('secret' in before && 'secret' in after) checkSecret(after.secret, expected, before.secret);
  } else throw invalidResponse();
}
