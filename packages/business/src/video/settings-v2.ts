import {randomUUID} from 'node:crypto';
import {VIDEO_SECRET_NAMESPACE, VIDEO_SETTINGS_LIMITS, parseVideoBinding, videoConnectionEndpoint, videoOutputHosts} from '../../../contracts/src/video-providers.ts';
import type {VideoExecutionBinding, VideoSecretUpdate} from '../../../contracts/src/video-providers.ts';
import {VIDEO_SETTINGS_V1_RESET_NOTICE, videoConnectionConfigurationV2Schema, videoExecutionBindingV2Schema, videoSettingsSelectionV2Schema, videoSettingsUpdateV2Schema, videoSettingsUuidV2Schema, videoStorageV2Schema} from '../../../contracts/src/generation-video-settings.ts';
import type {VideoConnectionConfigurationV2, VideoConnectionViewV2, VideoSettingsOperationV2, VideoSettingsSnapshotV2, VideoSettingsUpdateV2, VideoStorageV2} from '../../../contracts/src/generation-video-settings.ts';
import {VIDEO_SECRET_LIMITS, validateVideoSecretPlaintext, videoSettingsError} from './settings.ts';
import type {VideoSettingsEnvelope, VideoSettingsError, VideoSettingsOptions} from './settings.ts';
import {createVideoSettingsV2File} from './settings-v2-file.ts';
import type {VideoSettingsV2Persistence} from './settings-v2-file.ts';

interface RevisionV2 {configuration: VideoConnectionConfigurationV2; revision: number; credentialRef: string | null}
type Credential = VideoSettingsEnvelope['credentials'][number];
export interface VideoSettingsEnvelopeV2 {
  version: 2;
  namespace: typeof VIDEO_SECRET_NAMESPACE;
  revision: number;
  connections: RevisionV2[];
  history: RevisionV2[];
  credentials: Credential[];
  /** Only identities survive deletion: no address, model catalog or secret. */
  deletedConnectionIds: string[];
}
export interface VideoSettingsV2Options extends VideoSettingsOptions {persistence?: VideoSettingsV2Persistence}
export interface VideoSettingsV2Service {
  get(): Promise<VideoSettingsSnapshotV2>;
  put(input: unknown): Promise<VideoSettingsSnapshotV2>;
  list(): VideoConnectionViewV2[];
  select(connectionId: string, configurationRevision: number, modelEntryId: string): VideoExecutionBinding;
  assertBinding(binding: unknown): void;
  acquire(binding: unknown, signal?: AbortSignal): Promise<string>;
  acquireCompatible(connectionId: string, configurationRevision: number, signal?: AbortSignal): Promise<{endpoint: string; value: string}>;
  close(): Promise<void>;
}

export function videoSettingsV2Error(code = 'VIDEO_SETTINGS_VALIDATION'): VideoSettingsError {
  if (code === 'VIDEO_SETTINGS_CAPACITY') return Object.assign(new Error('视频服务设置已达到容量上限，未保存本次修改。'), {code, status: 507});
  if (code === 'VIDEO_SETTINGS_DELETED') return Object.assign(new Error('此视频服务已删除，原任务的密钥不可再用。'), {code, status: 409});
  if (code === 'VIDEO_SETTINGS_NOT_CONFIGURED') return Object.assign(new Error('此视频连接的凭据不可用，请重新配置以创建新的生成任务。'), {code, status: 409});
  return videoSettingsError(code);
}
export function sanitizeVideoSettingsV2Error(value: unknown): {code: string; message: string; status: number} {
  let code = 'VIDEO_SETTINGS_SAVE_FAILED';
  try {if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string') code = value.code;} catch {}
  const safe = videoSettingsV2Error(code);
  return {code: safe.code, message: safe.message, status: safe.status};
}
const fail = (code: string): never => {throw videoSettingsV2Error(code);};
const copy = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = (value: unknown): value is string => videoSettingsUuidV2Schema.safeParse(value).success;
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const validCiphertext = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= VIDEO_SECRET_LIMITS.ciphertextCharacters && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
const recipient = (configuration: VideoConnectionConfigurationV2) => [configuration.id, configuration.providerId, configuration.region, configuration.workspaceId, videoConnectionEndpoint(configuration)];
const credentialRecipient = (credential: Credential) => [credential.connectionId, credential.providerId, credential.region, credential.workspaceId, credential.endpoint];
export const emptyVideoSettingsV2Envelope = (): VideoSettingsEnvelopeV2 => ({version: 2, namespace: VIDEO_SECRET_NAMESPACE, revision: 0, connections: [], history: [], credentials: [], deletedConnectionIds: []});

function parseRevision(value: unknown): RevisionV2 {
  if (!exact(value, ['configuration', 'revision', 'credentialRef']) || !revision(value.revision) || !value.revision || value.credentialRef !== null && !uuid(value.credentialRef)) return fail('VIDEO_SETTINGS_CORRUPT');
  return {configuration: videoConnectionConfigurationV2Schema.parse(value.configuration), revision: value.revision, credentialRef: value.credentialRef as string | null};
}
function parseCredential(value: unknown): Credential {
  if (!exact(value, ['ref', 'connectionId', 'providerId', 'region', 'workspaceId', 'endpoint', 'encrypted']) || !uuid(value.ref) || !uuid(value.connectionId) || value.encrypted !== null && !validCiphertext(value.encrypted)) return fail('VIDEO_SETTINGS_CORRUPT');
  // The existing codec validator owns the exact v1 recipient rules. Validation
  // uses a fixed dummy value, and never decrypts persisted ciphertext.
  const metadata = validateVideoSecretPlaintext(JSON.stringify({version: 1, namespace: VIDEO_SECRET_NAMESPACE, credentialRef: value.ref, connectionId: value.connectionId, providerId: value.providerId, region: value.region, workspaceId: value.workspaceId, endpoint: value.endpoint, value: 'validation-only'}));
  return {ref: metadata.credentialRef, connectionId: metadata.connectionId, providerId: metadata.providerId, region: metadata.region, workspaceId: metadata.workspaceId, endpoint: metadata.endpoint, encrypted: value.encrypted as string | null};
}
export function validateVideoSettingsV2Envelope(value: unknown): VideoSettingsEnvelopeV2 {
  try {
    if (!exact(value, ['version', 'namespace', 'revision', 'connections', 'history', 'credentials', 'deletedConnectionIds']) || value.version !== 2 || value.namespace !== VIDEO_SECRET_NAMESPACE || !revision(value.revision) || !Array.isArray(value.connections) || value.connections.length > VIDEO_SETTINGS_LIMITS.connections || !Array.isArray(value.history) || !Array.isArray(value.credentials) || value.credentials.length > VIDEO_SETTINGS_LIMITS.credentials || !Array.isArray(value.deletedConnectionIds) || !value.deletedConnectionIds.every(uuid) || Buffer.byteLength(JSON.stringify(value)) > VIDEO_SETTINGS_LIMITS.fileBytes) throw Error();
    const connections = value.connections.map(parseRevision), history = value.history.map(parseRevision), credentials = value.credentials.map(parseCredential);
    const currentById = new Map(connections.map(entry => [entry.configuration.id, entry]));
    const historicalById = new Map(history.map(entry => [`${entry.configuration.id}:${entry.revision}`, entry]));
    const credentialByRef = new Map(credentials.map(credential => [credential.ref, credential]));
    const deleted = new Set(value.deletedConnectionIds as string[]);
    const builtins = connections.filter(entry => entry.configuration.providerId !== 'compatible').map(entry => entry.configuration.providerId);
    if (currentById.size !== connections.length || historicalById.size !== history.length || credentialByRef.size !== credentials.length || deleted.size !== value.deletedConnectionIds.length || new Set(builtins).size !== builtins.length || connections.some(entry => deleted.has(entry.configuration.id))) throw Error();
    for (const current of connections) {
      const versions = history.filter(entry => entry.configuration.id === current.configuration.id);
      if (!versions.length || Math.max(...versions.map(entry => entry.revision)) !== current.revision || !same(historicalById.get(`${current.configuration.id}:${current.revision}`), current)) throw Error();
    }
    for (const entry of history) {
      const current = currentById.get(entry.configuration.id);
      if (!current || current.configuration.providerId !== entry.configuration.providerId || entry.revision > value.revision) throw Error();
      if (entry.credentialRef) {
        const credential = credentialByRef.get(entry.credentialRef);
        if (!credential || !same(recipient(entry.configuration), credentialRecipient(credential))) throw Error();
      }
    }
    if (credentials.some(credential => !history.some(entry => entry.configuration.id === credential.connectionId && entry.credentialRef === credential.ref))) throw Error();
    return {version: 2, namespace: VIDEO_SECRET_NAMESPACE, revision: value.revision, connections, history, credentials, deletedConnectionIds: [...deleted]};
  } catch { return fail('VIDEO_SETTINGS_CORRUPT'); }
}

/** Candidate growth is an ordinary capacity failure, not evidence that the
 * currently persisted settings are corrupt. Account for the file newline too. */
export function assertVideoSettingsV2Capacity(value: VideoSettingsEnvelopeV2): void {
  if (value.connections.length > VIDEO_SETTINGS_LIMITS.connections || value.credentials.length > VIDEO_SETTINGS_LIMITS.credentials || Buffer.byteLength(JSON.stringify(value)) + 1 > VIDEO_SETTINGS_LIMITS.fileBytes) fail('VIDEO_SETTINGS_CAPACITY');
}

function validateStorage(value: unknown): VideoStorageV2 {
  const parsed = videoStorageV2Schema.safeParse(value);
  if (!parsed.success) return fail('VIDEO_SETTINGS_STORAGE_UNAVAILABLE');
  return parsed.data;
}
async function bounded<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (error: boolean, value?: T) => {if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(videoSettingsV2Error('VIDEO_SETTINGS_STORAGE_UNAVAILABLE')) : resolve(value as T);};
    const abort = () => finish(true), timer = setTimeout(abort, 5000);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(() => {if (done) throw Error(); return operation();}).then(value => finish(false, value), () => finish(true));
  });
}

/** An independent v2 engine; production continues to use createVideoSettings. */
export async function createVideoSettingsV2({directory, privateRoot = directory, secretCodec, storage = {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, signal, persistence = createVideoSettingsV2File({directory, privateRoot})}: VideoSettingsV2Options): Promise<VideoSettingsV2Service> {
  const lifetime = new AbortController(), activeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const operationSignal = (request?: AbortSignal) => request ? AbortSignal.any([activeSignal, request]) : activeSignal;
  let state = emptyVideoSettingsV2Envelope(), notice: VideoSettingsSnapshotV2['notice'] = null;
  let sessions = new Map<string, string>(), fault: VideoSettingsError | null = null, closing = false, pendingPuts = 0, storageBlocked = false, tail: Promise<unknown> = Promise.resolve();
  try {const loaded = await persistence.load(); if (loaded) {state = validateVideoSettingsV2Envelope(loaded.envelope); if (loaded.notice !== null && loaded.notice !== VIDEO_SETTINGS_V1_RESET_NOTICE) throw Error(); notice = loaded.notice;}} catch {fault = videoSettingsV2Error('VIDEO_SETTINGS_CORRUPT');}
  const check = () => {if (closing || activeSignal.aborted) fail('VIDEO_SETTINGS_CLOSED'); if (fault) throw fault;};
  const capabilities = (): VideoStorageV2 => {const value = validateStorage(typeof storage === 'function' ? storage() : storage); return storageBlocked || value.persistentAvailable && !secretCodec ? {...value, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'} : value;};
  const refresh = async (request?: AbortSignal) => {if (!secretCodec?.refreshStorage) return; try {await bounded(() => secretCodec.refreshStorage!(), operationSignal(request)); storageBlocked = false;} catch {storageBlocked = true;}};
  const schedule = <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (closing || activeSignal.aborted) return Promise.reject(videoSettingsV2Error('VIDEO_SETTINGS_CLOSED'));
    const next = tail.then(() => {check(); return operation();}).catch(error => {if (closing || activeSignal.aborted) throw videoSettingsV2Error('VIDEO_SETTINGS_CLOSED'); throw error;});
    tail = next.catch(() => {}); return next;
  };
  const ensureStable = () => {check(); if (pendingPuts) fail('VIDEO_SETTINGS_CONFLICT');};
  const material = (ref: string | null): VideoConnectionViewV2['secret']['storage'] => !ref ? 'none' : state.credentials.find(credential => credential.ref === ref)?.encrypted ? 'persistent' : sessions.has(ref) ? 'session' : 'none';
  const view = (entry: RevisionV2): VideoConnectionViewV2 => {const selected = material(entry.credentialRef); return {configuration: copy(entry.configuration), revision: entry.revision, secret: {configured: selected !== 'none', storage: selected}};};
  const snapshot = (): VideoSettingsSnapshotV2 => ({revision: state.revision, connections: state.connections.map(view), storage: capabilities(), notice});
  const binding = (entry: RevisionV2, modelEntryId: string): VideoExecutionBinding => {
    const model = entry.configuration.models.find(model => model.id === modelEntryId);
    if (!model || !entry.credentialRef) return fail('VIDEO_SETTINGS_NOT_CONFIGURED');
    const configuration = entry.configuration;
    return parseVideoBinding({version: 1, connectionId: configuration.id, configurationRevision: entry.revision, providerId: configuration.providerId, region: configuration.region, workspaceId: configuration.workspaceId, endpoint: videoConnectionEndpoint(configuration), credentialRef: entry.credentialRef, model: copy(model), outputHosts: copy(configuration.outputHosts)});
  };
  const assertBinding = (input: unknown): VideoExecutionBinding => {
    ensureStable(); let selected: VideoExecutionBinding;
    try {selected = parseVideoBinding(videoExecutionBindingV2Schema.parse(input));} catch {return fail('VIDEO_BINDING_INVALID');}
    if (state.deletedConnectionIds.includes(selected.connectionId)) return fail('VIDEO_SETTINGS_DELETED');
    const historical = state.history.find(entry => entry.configuration.id === selected.connectionId && entry.revision === selected.configurationRevision);
    if (!historical || !same(binding(historical, selected.model.id), selected)) return fail('VIDEO_BINDING_INVALID');
    if (material(selected.credentialRef) === 'none') return fail('VIDEO_SETTINGS_NOT_CONFIGURED');
    return selected;
  };
  async function secretOf(credential: Credential, request?: AbortSignal): Promise<string | undefined> {
    if (!credential.encrypted) return sessions.get(credential.ref);
    await refresh(request); check();
    if (!capabilities().persistentAvailable || !secretCodec) return fail('VIDEO_SETTINGS_STORAGE_UNAVAILABLE');
    const plaintext = validateVideoSecretPlaintext(await bounded(() => secretCodec.decrypt(credential.encrypted!), operationSignal(request)));
    check();
    if (plaintext.credentialRef !== credential.ref || !same(credentialRecipient(credential), [plaintext.connectionId, plaintext.providerId, plaintext.region, plaintext.workspaceId, plaintext.endpoint])) return fail('VIDEO_SETTINGS_CORRUPT');
    return plaintext.value;
  }
  async function storeSecret(nextSessions: Map<string, string>, credential: Credential, secret: Extract<VideoSecretUpdate, {action: 'replace'}>) {
    if (secret.storage === 'session') {nextSessions.set(credential.ref, secret.value); return;}
    await refresh(); check();
    if (!capabilities().persistentAvailable || !secretCodec) return fail('VIDEO_SETTINGS_STORAGE_UNAVAILABLE');
    const plaintext = JSON.stringify({version: 1, namespace: VIDEO_SECRET_NAMESPACE, credentialRef: credential.ref, connectionId: credential.connectionId, providerId: credential.providerId, region: credential.region, workspaceId: credential.workspaceId, endpoint: credential.endpoint, value: secret.value});
    validateVideoSecretPlaintext(plaintext);
    const encrypted = await bounded(() => secretCodec.encrypt(plaintext), activeSignal); check();
    if (!validCiphertext(encrypted)) return fail('VIDEO_SETTINGS_STORAGE_UNAVAILABLE');
    credential.encrypted = encrypted;
  }
  async function apply(candidate: VideoSettingsEnvelopeV2, nextSessions: Map<string, string>, operation: VideoSettingsOperationV2): Promise<boolean> {
    const id = operation.action === 'save' ? operation.configuration.id : operation.connectionId;
    if (candidate.deletedConnectionIds.includes(id)) return fail('VIDEO_SETTINGS_DELETED');
    const current = candidate.connections.find(entry => entry.configuration.id === id);
    if (operation.action === 'delete') {
      if (!current || current.configuration.providerId !== 'compatible') return fail('VIDEO_SETTINGS_VALIDATION');
      for (const credential of candidate.credentials) if (credential.connectionId === id) nextSessions.delete(credential.ref);
      candidate.connections = candidate.connections.filter(entry => entry.configuration.id !== id);
      candidate.history = candidate.history.filter(entry => entry.configuration.id !== id);
      candidate.credentials = candidate.credentials.filter(credential => credential.connectionId !== id);
      candidate.deletedConnectionIds.push(id); return true;
    }
    const {configuration, secret} = operation;
    if (current && current.configuration.providerId !== configuration.providerId || configuration.providerId !== 'compatible' && candidate.connections.some(entry => entry.configuration.id !== id && entry.configuration.providerId === configuration.providerId)) return fail('VIDEO_SETTINGS_VALIDATION');
    if (!current && candidate.connections.length >= VIDEO_SETTINGS_LIMITS.connections) return fail('VIDEO_SETTINGS_CAPACITY');
    let ref = current?.credentialRef ?? null;
    const sameRecipient = !current || same(recipient(current.configuration), recipient(configuration));
    const currentCredential = ref ? candidate.credentials.find(credential => credential.ref === ref) : undefined;
    let secretChanged = secret.action === 'remove' ? Boolean(currentCredential?.encrypted || ref && nextSessions.has(ref)) : secret.action === 'replace';
    if (secret.action === 'replace' && sameRecipient && currentCredential && material(ref) === secret.storage) {
      const existing = await secretOf(currentCredential);
      check(); secretChanged = existing !== secret.value;
    }
    if (current && same(current.configuration, configuration) && !secretChanged) return false;
    if (secret.action === 'remove' && ref && secretChanged) {
      candidate.credentials.find(credential => credential.ref === ref)!.encrypted = null; nextSessions.delete(ref);
    }
    // A regional/origin change detaches only this current key. Its old recipient
    // remains usable by frozen tasks, unlike an explicit key removal or deletion.
    if (!sameRecipient) ref = null;
    if (secret.action === 'replace' && secretChanged) {
      if (candidate.credentials.length >= VIDEO_SETTINGS_LIMITS.credentials) return fail('VIDEO_SETTINGS_CAPACITY');
      const credential: Credential = {ref: randomUUID(), connectionId: id, providerId: configuration.providerId, region: configuration.region, workspaceId: configuration.workspaceId, endpoint: videoConnectionEndpoint(configuration), encrypted: null};
      candidate.credentials.push(credential); ref = credential.ref; await storeSecret(nextSessions, credential, secret);
    }
    if (current?.revision === Number.MAX_SAFE_INTEGER) return fail('VIDEO_SETTINGS_CAPACITY');
    const entry: RevisionV2 = {configuration: copy(configuration), revision: (current?.revision ?? 0) + 1, credentialRef: ref};
    if (current) candidate.connections[candidate.connections.indexOf(current)] = entry; else candidate.connections.push(entry);
    candidate.history.push(copy(entry)); return true;
  }
  const service: VideoSettingsV2Service = {
    get: () => schedule(async () => {await refresh(); check(); return snapshot();}),
    list() {ensureStable(); return state.connections.map(view);},
    select(connectionId, configurationRevision, modelEntryId) {
      ensureStable(); if (!videoSettingsSelectionV2Schema.safeParse({connectionId, configurationRevision, modelEntryId}).success) return fail('VIDEO_SETTINGS_VALIDATION');
      if (state.deletedConnectionIds.includes(connectionId)) return fail('VIDEO_SETTINGS_DELETED');
      const entry = state.connections.find(entry => entry.configuration.id === connectionId);
      if (!entry || entry.revision !== configurationRevision) return fail('VIDEO_SETTINGS_CONFLICT');
      const model = entry.configuration.models.find(model => model.id === modelEntryId);
      if (!entry.configuration.enabled || !model?.enabled || model.archived) return fail('VIDEO_SETTINGS_DISABLED');
      const selected = binding(entry, modelEntryId);
      if (!videoOutputHosts(selected).length) return fail('VIDEO_SETTINGS_NOT_CONFIGURED');
      assertBinding(selected); return selected;
    },
    assertBinding(input) {assertBinding(input);},
    acquire(input, request) {return schedule(async () => {
      const selected = assertBinding(input), credential = state.credentials.find(credential => credential.ref === selected.credentialRef)!;
      if (request?.aborted) return fail('VIDEO_SETTINGS_CLOSED');
      const value = await secretOf(credential, request); assertBinding(selected);
      if (request?.aborted) return fail('VIDEO_SETTINGS_CLOSED');
      if (!value) return fail('VIDEO_SETTINGS_NOT_CONFIGURED'); return value;
    });},
    acquireCompatible(connectionId, configurationRevision, request) {return schedule(async () => {
      ensureStable(); if (!uuid(connectionId) || !revision(configurationRevision) || configurationRevision === 0) return fail('VIDEO_SETTINGS_VALIDATION');
      if (state.deletedConnectionIds.includes(connectionId)) return fail('VIDEO_SETTINGS_DELETED');
      const entry = state.connections.find(entry => entry.configuration.id === connectionId);
      if (!entry || entry.revision !== configurationRevision) return fail('VIDEO_SETTINGS_CONFLICT');
      if (entry.configuration.providerId !== 'compatible') return fail('VIDEO_SETTINGS_VALIDATION');
      const credential = state.credentials.find(credential => credential.ref === entry.credentialRef);
      if (!credential) return fail('VIDEO_SETTINGS_NOT_CONFIGURED');
      if (request?.aborted) return fail('VIDEO_SETTINGS_CLOSED');
      const value = await secretOf(credential, request); ensureStable();
      if (request?.aborted) return fail('VIDEO_SETTINGS_CLOSED');
      if (state.connections.find(current => current.configuration.id === connectionId)?.revision !== configurationRevision || credential.endpoint !== videoConnectionEndpoint(entry.configuration)) return fail('VIDEO_SETTINGS_CONFLICT');
      if (!value) return fail('VIDEO_SETTINGS_NOT_CONFIGURED'); return {endpoint: credential.endpoint, value};
    });},
    put(input) {
      let update: VideoSettingsUpdateV2;
      try {if (Buffer.byteLength(JSON.stringify(input)) > VIDEO_SETTINGS_LIMITS.updateBytes) throw Error(); update = videoSettingsUpdateV2Schema.parse(input);} catch {return Promise.reject(videoSettingsV2Error('VIDEO_SETTINGS_VALIDATION'));}
      pendingPuts++;
      return schedule(async () => {
        if (update.expectedRevision !== state.revision) return fail('VIDEO_SETTINGS_CONFLICT');
        const candidate = copy(state), nextSessions = new Map(sessions); let changed = false;
        for (const operation of update.action === 'batch' ? update.operations : [update]) changed = await apply(candidate, nextSessions, operation) || changed;
        check();
        if (!changed) {
          // A no-op still confirms ownership of the source. Another writer may
          // have changed a file whose stale in-memory configuration looks equal.
          try {
            const actual = await bounded(() => persistence.load(), activeSignal);
            if (!same(actual?.envelope ?? emptyVideoSettingsV2Envelope(), state)) throw Error();
          } catch {fault = videoSettingsV2Error('VIDEO_SETTINGS_SAVE_FAILED'); sessions.clear(); return fail('VIDEO_SETTINGS_SAVE_FAILED');}
          check(); return snapshot();
        }
        if (state.revision === Number.MAX_SAFE_INTEGER) return fail('VIDEO_SETTINGS_CAPACITY');
        candidate.revision++; assertVideoSettingsV2Capacity(candidate); validateVideoSettingsV2Envelope(candidate);
        try {await persistence.save(candidate, activeSignal);} catch {
          try {
            const actual = await bounded(() => persistence.load(), activeSignal);
            if (!same(actual?.envelope ?? emptyVideoSettingsV2Envelope(), state)) throw Error();
          } catch {fault = videoSettingsV2Error('VIDEO_SETTINGS_SAVE_FAILED'); sessions.clear();}
          return fail('VIDEO_SETTINGS_SAVE_FAILED');
        }
        check(); state = candidate; sessions = nextSessions; notice = null; return snapshot();
      }).finally(() => {pendingPuts--;});
    },
    async close() {closing = true; lifetime.abort(); await tail; sessions.clear();},
  };
  return Object.freeze(service);
}
