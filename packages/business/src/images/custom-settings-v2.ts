import {canonicalImageInput} from '../../../contracts/src/images.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE, CUSTOM_IMAGE_SETTINGS_V2_NOTICE, CUSTOM_IMAGE_SETTINGS_V2_LIMITS,
  customImageConnectionIdV2Schema, isCompleteCustomImageConfigurationV2,
  customImageSecretUpdateV2Schema, customImageStorageV2Schema, customImageSettingsV2ResultSchema,
  customImageCreateV2Schema, customImagePutV2Schema, customImageRemoveV2Schema, customImageBatchV2Schema,
  customImageCredentialRequestV2Schema, customImageEncryptedV2Schema, customImageStoredConnectionV2Schema,
  customImageSettingsV2EnvelopeSchema, customImageSecretPlaintextV2Schema} from '../../../contracts/src/generation-image-settings.ts';
import type {CustomImageConfigurationV2, CustomImageConnectionV2, CustomImageSettingsV2Result,
  CustomImageCredentialRequestV2} from '../../../contracts/src/generation-image-settings.ts';
import {validateCustomImageSettingsEnvelope} from './settings.ts';
import {IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_PROFILE_ID} from '../../../contracts/src/image-settings.ts';
import {customImageBaseUrlSchema} from '../../../contracts/src/image-compatible.ts';
import type {ImageSettingsPersistence, ImageSettingsSecretCodec, ImageSettingsStorageCapability} from './settings.ts';

const limits = CUSTOM_IMAGE_SETTINGS_V2_LIMITS;
const namespace = CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE;
const messages: Readonly<Record<string, readonly [number, string]>> = Object.freeze({
  IMAGE_SETTINGS_VALIDATION: [400, '自定义图片服务设置格式无效。'],
  IMAGE_SETTINGS_CONFLICT: [409, '自定义图片服务设置已改变，请重新读取后确认。'],
  IMAGE_SETTINGS_SELECTION_REQUIRED: [409, '有多个自定义图片服务，请在生成面板里选择。'],
  IMAGE_SETTINGS_NOT_FOUND: [409, '此自定义图片服务已删除或不存在。'],
  IMAGE_SETTINGS_DISABLED: [409, '此自定义图片服务尚未启用。'],
  IMAGE_SETTINGS_NOT_CONFIGURED: [409, '请先配置此自定义图片服务及其独立密钥。'],
  IMAGE_SETTINGS_CAPACITY: [409, '自定义图片服务设置已达到容量限制。'],
  IMAGE_SETTINGS_STORAGE_UNAVAILABLE: [409, '系统安全存储不可用，请明确选择仅本次运行。'],
  IMAGE_SETTINGS_SAVE_FAILED: [503, '自定义图片服务设置未能保存，请重新读取后再试。'],
  IMAGE_SETTINGS_CORRUPT: [503, '自定义图片服务设置不可读取或不安全，现有文件未被覆盖。'],
  IMAGE_SETTINGS_CLOSED: [503, '自定义图片服务设置已关闭，请重新打开应用。'],
});
export function customImageSettingsV2Error(code: string): Error & {code: string; status: number} {
  const selected = Object.hasOwn(messages, code) ? code : 'IMAGE_SETTINGS_SAVE_FAILED';
  return Object.assign(new Error(messages[selected][1]), {code: selected, status: messages[selected][0]});
}
export function sanitizeCustomImageSettingsV2Error(error: unknown): {code: string; message: string; status: number} {
  let code = 'IMAGE_SETTINGS_SAVE_FAILED';
  try {if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') code = error.code;} catch {}
  const safe = customImageSettingsV2Error(code);
  return {code: safe.code, message: safe.message, status: safe.status};
}
function fail(code: string): never {throw customImageSettingsV2Error(code);}
function plain(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (!value || typeof value !== 'object') return true;
  if (Array.isArray(value)) return Reflect.ownKeys(value).length === value.length + 1 && value.every(item => plain(item, depth + 1));
  return [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    'value' in Object.getOwnPropertyDescriptor(value, key)! && plain((value as Record<string, unknown>)[key], depth + 1));
}
interface Schema<T> {safeParse(input: unknown): {success: true; data: T} | {success: false}}
function parse<T>(schema: Schema<T>, input: unknown, code = 'IMAGE_SETTINGS_VALIDATION'): T {
  try {if (!plain(input)) fail(code); const parsed = schema.safeParse(input); if (!parsed.success) fail(code); return parsed.data;}
  catch {fail(code);}
}
const bounded = (value: unknown, bytes: number): boolean => Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes;
const same = (left: unknown, right: unknown): boolean => canonicalImageInput(left) === canonicalImageInput(right);
export type CustomImageSettingsV2Envelope = ReturnType<typeof customImageSettingsV2EnvelopeSchema.parse>;
type StoredConnection = ReturnType<typeof customImageStoredConnectionV2Schema.parse>;
type SecretUpdate = ReturnType<typeof customImageSecretUpdateV2Schema.parse>;
type Session = {binding: string; value: string};
type Storage = ReturnType<typeof customImageStorageV2Schema.parse>;
export interface CustomImageSettingsV2Options {
  persistence: ImageSettingsPersistence;
  secretCodec?: ImageSettingsSecretCodec;
  storage?: ImageSettingsStorageCapability | (() => ImageSettingsStorageCapability);
}
export interface AcquiredCustomImageCredentialV2 extends CustomImageCredentialRequestV2 {namespace: string; apiKey: string | null}
export function customImageCredentialBindingV2(connectionId: string, configuration: Pick<CustomImageConfigurationV2, 'providerId' | 'profileId' | 'baseUrl'>): string {
  return JSON.stringify([namespace, configuration.providerId, connectionId, configuration.profileId,
    configuration.baseUrl]);
}
export function validateCustomImageSettingsV2Envelope(input: unknown): CustomImageSettingsV2Envelope {
  const value = parse(customImageSettingsV2EnvelopeSchema, input, 'IMAGE_SETTINGS_CORRUPT');
  for (const item of value.connections) if (item.secret && (!isCompleteCustomImageConfigurationV2(item.configuration) ||
    item.secret.binding !== customImageCredentialBindingV2(item.connectionId, item.configuration) ||
    Buffer.from(item.secret.encrypted, 'base64').toString('base64') !== item.secret.encrypted)) fail('IMAGE_SETTINGS_CORRUPT');
  if (!bounded(value, limits.envelopeBytes - 1)) fail('IMAGE_SETTINGS_CORRUPT');
  return value;
}
/** Only the exact recognized old custom envelope is discardable. Validation
 * neither decrypts it nor publishes its configuration or ciphertext in v2. */
export function validateCustomImageSettingsV2Stored(input: unknown): unknown {
  if (!plain(input)) fail('IMAGE_SETTINGS_CORRUPT');
  if (input && typeof input === 'object' && 'version' in input && input.version === 1) {
    if (!bounded(input, IMAGE_SETTINGS_LIMITS.envelopeBytes)) fail('IMAGE_SETTINGS_CORRUPT');
    validateCustomImageSettingsEnvelope(input);
    return input;
  }
  return validateCustomImageSettingsV2Envelope(input);
}
export function validateCustomImageSecretPlaintextV2(plaintext: unknown): ReturnType<typeof customImageSecretPlaintextV2Schema.parse> {
  if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > limits.updateBytes) fail('IMAGE_SETTINGS_CORRUPT');
  let decoded: unknown; try {decoded = JSON.parse(plaintext);} catch {fail('IMAGE_SETTINGS_CORRUPT');}
  const value = parse(customImageSecretPlaintextV2Schema, decoded, 'IMAGE_SETTINGS_CORRUPT');
  let binding: unknown; try {binding = JSON.parse(value.binding);} catch {fail('IMAGE_SETTINGS_CORRUPT');}
  if (!Array.isArray(binding) || binding.length !== 5 || binding[0] !== namespace || binding[1] !== 'openai-compatible' ||
    binding[2] !== value.connectionId || binding[3] !== CUSTOM_IMAGE_PROFILE_ID) fail('IMAGE_SETTINGS_CORRUPT');
  const baseUrl = parse(customImageBaseUrlSchema, binding[4], 'IMAGE_SETTINGS_CORRUPT');
  if (value.binding !== customImageCredentialBindingV2(value.connectionId, {providerId: 'openai-compatible', profileId: CUSTOM_IMAGE_PROFILE_ID, baseUrl})) fail('IMAGE_SETTINGS_CORRUPT');
  return value;
}
function boundedOperation<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: boolean, value?: T): void => {if (settled) return; settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort); if (error) reject(customImageSettingsV2Error('IMAGE_SETTINGS_STORAGE_UNAVAILABLE')); else resolve(value as T);};
    const abort = (): void => finish(true), timer = setTimeout(abort, 5000);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(() => {if (!settled) return operation();}).then(value => finish(false, value), () => finish(true));
  });
}

/** Independent v2 owner. The collection CAS serializes disk
 * publication; authorization fences are per connection, so editing B cannot
 * revoke A. An acquired key is only a snapshot: assertCurrent must run at the
 * final dispatch boundary synchronously, without an intervening await. */
export async function createCustomImageSettingsV2({persistence, secretCodec, storage = {
  persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}}: CustomImageSettingsV2Options) {
  let state: CustomImageSettingsV2Envelope = {version: 2, namespace, revision: 0, connections: [], deletedConnectionIds: []};
  let baseline: string | null = null, notice: typeof CUSTOM_IMAGE_SETTINGS_V2_NOTICE | null = null;
  let fault: string | null = null, closed = false, refreshBlocked = false;
  let tail: Promise<unknown> = Promise.resolve();
  const sessions = new Map<string, Session>(), pending = new Map<string, number>();
  try {
    if (!persistence || typeof persistence.load !== 'function' || typeof persistence.save !== 'function') fail('IMAGE_SETTINGS_CORRUPT');
    const loaded = await persistence.load();
    if (loaded !== null) {
      const validated = validateCustomImageSettingsV2Stored(loaded);
      baseline = canonicalImageInput(validated);
      if ((validated as {version: number}).version === 1) notice = CUSTOM_IMAGE_SETTINGS_V2_NOTICE;
      else state = validateCustomImageSettingsV2Envelope(validated);
    }
  } catch {fault = 'IMAGE_SETTINGS_CORRUPT';}
  function available(): void {if (closed) fail('IMAGE_SETTINGS_CLOSED'); if (fault) fail(fault);}
  async function refresh(signal?: AbortSignal): Promise<void> {
    if (!secretCodec?.refreshStorage) return;
    try {await boundedOperation(() => secretCodec.refreshStorage!(), signal); refreshBlocked = false;}
    catch {refreshBlocked = true;}
  }
  function capabilities(): Storage {
    let value: Storage;
    try {value = parse(customImageStorageV2Schema, typeof storage === 'function' ? storage() : storage,
      'IMAGE_SETTINGS_STORAGE_UNAVAILABLE');} catch {fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');}
    return refreshBlocked || value.persistentAvailable && (!secretCodec?.encrypt || !secretCodec.decrypt)
      ? {...value, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'} : value;
  }
  function canUseVault() {
    const value = capabilities();
    return Boolean(secretCodec?.encrypt && secretCodec.decrypt && (value.persistentAvailable || value.reasonCode === 'OS_SECRET_STORE_PENDING'));
  }
  function view(item: StoredConnection): CustomImageConnectionV2 {
    return {connectionId: item.connectionId, name: item.name, configurationRevision: item.configurationRevision,
      configuration: structuredClone(item.configuration), secret: {configured: Boolean(item.secret || sessions.has(item.connectionId)),
        storage: item.secret ? 'persistent' : sessions.has(item.connectionId) ? 'session' : 'none'}};
  }
  const snapshot = (): CustomImageSettingsV2Result => parse(customImageSettingsV2ResultSchema, {
    revision: state.revision, connections: state.connections.map(view), storage: capabilities(), notice}, 'IMAGE_SETTINGS_CORRUPT');
  function schedule<T>(operation: () => T | Promise<T>): Promise<T> {
    if (closed) return Promise.reject(customImageSettingsV2Error('IMAGE_SETTINGS_CLOSED'));
    const result = tail.then(() => {available(); return operation();}); tail = result.catch(() => {}); return result;
  }
  function connection(id: string): StoredConnection {
    const selected = state.connections.find(item => item.connectionId === id);
    if (!selected) fail('IMAGE_SETTINGS_NOT_FOUND'); return selected;
  }
  function checkExpected(expected: CustomImageCredentialRequestV2): StoredConnection {
    available(); if (pending.has(expected.connectionId)) fail('IMAGE_SETTINGS_CONFLICT');
    const item = connection(expected.connectionId);
    if (item.configurationRevision !== expected.configurationRevision || !same(item.configuration, expected.configuration)) fail('IMAGE_SETTINGS_CONFLICT');
    return item;
  }
  function assertCurrent(raw: unknown): true {
    const expected = parse(customImageCredentialRequestV2Schema, raw), item = checkExpected(expected);
    if (!item.configuration.enabled) fail('IMAGE_SETTINGS_DISABLED');
    if (!isCompleteCustomImageConfigurationV2(item.configuration) || !item.secret && !sessions.has(item.connectionId)) fail('IMAGE_SETTINGS_NOT_CONFIGURED');
    if (item.secret && !canUseVault()) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
    const secret = item.secret ?? sessions.get(item.connectionId);
    if (secret?.binding !== customImageCredentialBindingV2(item.connectionId, item.configuration)) fail('IMAGE_SETTINGS_CONFLICT');
    return true;
  }
  function parseWrite<T>(schema: Schema<T>, raw: unknown): T {
    const update = parse(schema, raw); if (!bounded(update, limits.updateBytes)) fail('IMAGE_SETTINGS_VALIDATION'); return update;
  }
  async function replacement(id: string, configuration: CustomImageConfigurationV2, secret: SecretUpdate,
    previous?: StoredConnection): Promise<{secret: StoredConnection['secret']; session: Session | undefined}> {
    const binding = customImageCredentialBindingV2(id, configuration), sameBinding = previous && binding === customImageCredentialBindingV2(id, previous.configuration);
    // A new recipient must never inherit this connection's old credential.
    // Keeping after an address change saves the configuration with no key.
    if (secret.action === 'replace') {
      if (!isCompleteCustomImageConfigurationV2(configuration)) fail('IMAGE_SETTINGS_VALIDATION');
      if (secret.storage === 'session') return {secret: null, session: {binding, value: secret.value}};
      await refresh(); available();
      if (!canUseVault()) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
      const encrypted = await boundedOperation(() => secretCodec!.encrypt!(JSON.stringify({version: 2, namespace, connectionId: id, binding, value: secret.value})));
      available();
      const ciphertext = parse(customImageEncryptedV2Schema, encrypted, 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
      if (Buffer.from(ciphertext, 'base64').toString('base64') !== ciphertext) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
      return {secret: {binding, encrypted: ciphertext}, session: undefined};
    }
    return secret.action === 'keep' && sameBinding ? {secret: previous!.secret, session: sessions.get(id)} : {secret: null, session: undefined};
  }
  async function commit(candidate: CustomImageSettingsV2Envelope, applySession: () => void): Promise<CustomImageSettingsV2Result> {
    available();
    if (!bounded(candidate, limits.envelopeBytes - 1)) fail('IMAGE_SETTINGS_CAPACITY');
    validateCustomImageSettingsV2Envelope(candidate);
    try {await persistence.save(structuredClone(candidate));}
    catch {
      // A throwing save may already have committed. Only proof of the exact
      // previous envelope (including a recognized v1 file) reopens the fence.
      try {
        const loaded = await boundedOperation(() => persistence.load());
        const current = loaded === null ? null : canonicalImageInput(validateCustomImageSettingsV2Stored(loaded));
        if (current !== baseline) throw Error();
      } catch {fault = 'IMAGE_SETTINGS_SAVE_FAILED'; sessions.clear();}
      fail('IMAGE_SETTINGS_SAVE_FAILED');
    }
    state = candidate; baseline = canonicalImageInput(candidate); notice = null;
    // A save that was already in flight may commit while closing. Retain its
    // durable revision, but never revive session credentials in a closed owner.
    if (!closed) applySession();
    return snapshot();
  }
  function admit<T>(ids: string[], operation: () => Promise<T>): Promise<T> {
    available(); for (const id of ids) pending.set(id, (pending.get(id) ?? 0) + 1);
    return schedule(operation).finally(() => {for (const id of ids) {const n = pending.get(id)! - 1; if (n) pending.set(id, n); else pending.delete(id);}});
  }
  function nextRevision(): number {if (state.revision === Number.MAX_SAFE_INTEGER) fail('IMAGE_SETTINGS_CAPACITY'); return state.revision + 1;}
  function assertCollection(revision: number): void {if (state.revision !== revision) fail('IMAGE_SETTINGS_CONFLICT');}
  function batch(raw: unknown): Promise<CustomImageSettingsV2Result> {
    try {
      const input = parseWrite(customImageBatchV2Schema, raw);
      const ids = input.operations.map(item => item.connectionId);
      return admit(ids, async () => {
        assertCollection(input.expectedRevision);
        const candidate = structuredClone(state), nextSessions = new Map(sessions);
        candidate.revision = nextRevision();
        for (const operation of input.operations) {
          if (operation.action === 'create') {
            const id = operation.connectionId;
            if (candidate.deletedConnectionIds.includes(id) || candidate.connections.some(item => item.connectionId === id)) fail('IMAGE_SETTINGS_CONFLICT');
            if (candidate.connections.length + candidate.deletedConnectionIds.length >= limits.connectionIds) fail('IMAGE_SETTINGS_CAPACITY');
            const credentials = await replacement(id, operation.configuration, operation.secret); available();
            candidate.connections.push({connectionId: id, name: operation.name, configurationRevision: 1,
              configuration: operation.configuration, secret: credentials.secret});
            if (credentials.session) nextSessions.set(id, credentials.session);
          } else {
            const previous = connection(operation.connectionId);
            if (previous.configurationRevision !== operation.expectedConfigurationRevision) fail('IMAGE_SETTINGS_CONFLICT');
            if (operation.action === 'remove') {
              candidate.connections = candidate.connections.filter(item => item.connectionId !== operation.connectionId);
              candidate.deletedConnectionIds.push(operation.connectionId); nextSessions.delete(operation.connectionId);
            } else {
              if (previous.configurationRevision === Number.MAX_SAFE_INTEGER) fail('IMAGE_SETTINGS_CAPACITY');
              const credentials = await replacement(operation.connectionId, operation.configuration, operation.secret, previous); available();
              const item: StoredConnection = {connectionId: operation.connectionId, name: operation.name,
                configurationRevision: previous.configurationRevision + 1, configuration: operation.configuration, secret: credentials.secret};
              candidate.connections = candidate.connections.map(value => value.connectionId === operation.connectionId ? item : value);
              nextSessions.delete(operation.connectionId); if (credentials.session) nextSessions.set(operation.connectionId, credentials.session);
            }
          }
        }
        if (candidate.connections.length > limits.connections) fail('IMAGE_SETTINGS_CAPACITY');
        return commit(candidate, () => {sessions.clear(); for (const [id, value] of nextSessions) sessions.set(id, value);});
      });
    } catch (error) {return Promise.reject(error);}
  }
  return Object.freeze({
    async get(): Promise<CustomImageSettingsV2Result> {
      available(); await refresh(); available();
      return snapshot();
    },
    readCurrent(): CustomImageSettingsV2Result {available(); if (pending.size) fail('IMAGE_SETTINGS_CONFLICT'); return snapshot();},
    select(connectionId?: string): CustomImageConnectionV2 {
      available();
      if (connectionId === undefined) {
        if (state.connections.length > 1) fail('IMAGE_SETTINGS_SELECTION_REQUIRED');
        if (!state.connections.length) fail('IMAGE_SETTINGS_NOT_CONFIGURED');
        connectionId = state.connections[0].connectionId;
      }
      const id = parse(customImageConnectionIdV2Schema, connectionId);
      if (pending.has(id)) fail('IMAGE_SETTINGS_CONFLICT'); return view(connection(id));
    },
    assertCurrent,
    acquire(raw: unknown, {signal}: {signal?: AbortSignal} = {}): Promise<AcquiredCustomImageCredentialV2> {
      let expected: CustomImageCredentialRequestV2;
      try {expected = parse(customImageCredentialRequestV2Schema, raw); checkExpected(expected);} catch (error) {return Promise.reject(error);}
      return schedule(async () => {
        const item = checkExpected(expected); if (signal?.aborted) fail('IMAGE_SETTINGS_CLOSED');
        let apiKey: string | null = null;
        if (item.secret) {
          await refresh(signal); checkExpected(expected); if (signal?.aborted) fail('IMAGE_SETTINGS_CLOSED');
          if (!canUseVault()) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
          const plaintext = await boundedOperation(() => secretCodec!.decrypt!(item.secret!.encrypted), signal);
          checkExpected(expected); if (signal?.aborted) fail('IMAGE_SETTINGS_CLOSED');
          const decoded = validateCustomImageSecretPlaintextV2(plaintext);
          if (decoded.connectionId !== item.connectionId || decoded.binding !== item.secret.binding) fail('IMAGE_SETTINGS_CORRUPT');
          apiKey = decoded.value;
        } else apiKey = sessions.get(item.connectionId)?.value ?? null;
        checkExpected(expected); if (signal?.aborted) fail('IMAGE_SETTINGS_CLOSED');
        return {...structuredClone(expected), namespace, apiKey};
      });
    },
    batch,
    create(raw: unknown): Promise<CustomImageSettingsV2Result> {
      try {const {expectedRevision, ...operation} = parseWrite(customImageCreateV2Schema, raw);
        return batch({expectedRevision, operations: [{...operation, action: 'create'}]});}
      catch (error) {return Promise.reject(error);}
    },
    put(raw: unknown): Promise<CustomImageSettingsV2Result> {
      try {
        const {expectedRevision, ...operation} = parseWrite(customImagePutV2Schema, raw);
        return batch({expectedRevision, operations: [{...operation, action: 'put'}]});
      } catch (error) {return Promise.reject(error);}
    },
    remove(raw: unknown): Promise<CustomImageSettingsV2Result> {
      try {
        const {expectedRevision, ...operation} = parseWrite(customImageRemoveV2Schema, raw);
        return batch({expectedRevision, operations: [{...operation, action: 'remove'}]});
      } catch (error) {return Promise.reject(error);}
    },
    async close(): Promise<void> {closed = true; sessions.clear(); await tail; sessions.clear();},
  });
}
