import {DEFAULT_IMAGE_CONFIGURATION, IMAGE_SETTINGS_NAMESPACE, IMAGE_SETTINGS_LIMITS, imageConfigurationSchema,
  imageSettingsUpdateSchema, imageSettingsResultSchema, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, CUSTOM_IMAGE_SETTINGS_NAMESPACE,
  customImageConfigurationSchema, customImageSettingsUpdateSchema, customImageSettingsResultSchema,
  isCompleteCustomImageConfiguration} from '../../../contracts/src/image-settings.ts';

type OfficialConfiguration = ReturnType<typeof imageConfigurationSchema.parse>;
type CustomConfiguration = ReturnType<typeof customImageConfigurationSchema.parse>;
export type ImageConfiguration = OfficialConfiguration | CustomConfiguration;
type OfficialSettingsUpdate = ReturnType<typeof imageSettingsUpdateSchema.parse>;
type CustomSettingsUpdate = ReturnType<typeof customImageSettingsUpdateSchema.parse>;
export type ImageSettingsUpdate = OfficialSettingsUpdate | CustomSettingsUpdate;
type OfficialSettingsResult = ReturnType<typeof imageSettingsResultSchema.parse>;
type CustomSettingsResult = ReturnType<typeof customImageSettingsResultSchema.parse>;
export type ImageSettingsResult = OfficialSettingsResult | CustomSettingsResult;
export type ImageSettingsSecret = ImageSettingsUpdate['secret'];
export type ImageSettingsSecretEnvelope = {binding: string; encrypted: string};
export type ImageSettingsSession = {binding: string; value: string};
export type ImageSettingsStorageView = OfficialSettingsResult['storage'];
export interface ImageSettingsEnvelope {version: number; namespace: string; revision: number; configuration: ImageConfiguration; secret: ImageSettingsSecretEnvelope | null}
export interface ImageSettingsError extends Error {code: string; status: number}
export interface AcquiredImageCredential {namespace: string; revision: number; configuration: ImageConfiguration; apiKey: string | null}
export interface ImageCredentialRequest {expectedRevision: number; configuration: ImageConfiguration}
export interface ImageSettingsPersistence {load(): Promise<unknown> | unknown; save(value: unknown): Promise<unknown> | unknown}
export interface ImageSettingsSecretCodec {refreshStorage?(): Promise<unknown> | unknown; encrypt?(plaintext: string): Promise<unknown> | unknown; decrypt?(ciphertext: string): Promise<unknown> | unknown}
export interface ImageSettingsStorageCapability {persistentAvailable: boolean; sessionScope: string; reasonCode: string | null}
export interface ImageSettingsOptions {
  persistence?: ImageSettingsPersistence;
  secretCodec?: ImageSettingsSecretCodec;
  storage?: ImageSettingsStorageCapability | (() => ImageSettingsStorageCapability);
}
interface BaseProfile {namespace: string; configurationKeys: readonly string[]}
interface OfficialProfile extends BaseProfile {custom: false; defaults: OfficialConfiguration; configurationSchema: typeof imageConfigurationSchema; updateSchema: typeof imageSettingsUpdateSchema; resultSchema: typeof imageSettingsResultSchema}
interface CustomProfile extends BaseProfile {custom: true; defaults: CustomConfiguration; configurationSchema: typeof customImageConfigurationSchema; updateSchema: typeof customImageSettingsUpdateSchema; resultSchema: typeof customImageSettingsResultSchema}
type ImageProfile = OfficialProfile | CustomProfile;

const messages: Readonly<Record<string, readonly [number, string]>> = Object.freeze({
  IMAGE_SETTINGS_VALIDATION: [400, '图像设置格式无效，请检查固定预设和密钥输入。'],
  IMAGE_SETTINGS_CONFLICT: [409, '图像设置已改变，请重新读取并确认当前请求。'],
  IMAGE_SETTINGS_DISABLED: [409, 'OpenAI 图像生成尚未启用。'],
  IMAGE_SETTINGS_NOT_CONFIGURED: [409, '请先配置独立的 OpenAI 图像密钥。'],
  IMAGE_SETTINGS_STORAGE_UNAVAILABLE: [409, '系统安全存储不可用，请明确选择仅本次会话保存。'],
  IMAGE_SETTINGS_SAVE_FAILED: [503, '图像设置未能保存；请重新读取当前设置后再试。'],
  IMAGE_SETTINGS_CORRUPT: [503, '图像设置文件不可读取或不安全；现有设置未被覆盖。'],
  IMAGE_SETTINGS_CLOSED: [503, '图像设置服务已关闭，请重新打开应用。'],
});
export function imageSettingsError(code: unknown = 'IMAGE_SETTINGS_VALIDATION'): ImageSettingsError {
  const known = typeof code === 'string' && Object.hasOwn(messages, code), selected = known ? code as string : 'IMAGE_SETTINGS_SAVE_FAILED';
  return Object.assign(new Error(messages[selected][1]), {code: selected, status: messages[selected][0]});
}
export function sanitizeImageSettingsError(error: unknown): {code: string; message: string; status: number} {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : 'IMAGE_SETTINGS_SAVE_FAILED';
  const safe = imageSettingsError(code ?? 'IMAGE_SETTINGS_SAVE_FAILED');
  return {code: safe.code, message: safe.message, status: safe.status};
}
function fail(code: string): never { throw imageSettingsError(code); }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exactObject = (value: unknown, keys: readonly string[]): boolean => record(value) !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value as object)) && Object.keys(value as object).length === keys.length && keys.every(key => Object.hasOwn(value as object, key));
const sameConfiguration = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
// These descriptors are module-owned capabilities, never options supplied by a
// renderer, HTTP request, stored envelope or caller. There are exactly two slots.
const OFFICIAL_PROFILE: OfficialProfile = Object.freeze({namespace: IMAGE_SETTINGS_NAMESPACE, defaults: DEFAULT_IMAGE_CONFIGURATION,
  configurationSchema: imageConfigurationSchema, updateSchema: imageSettingsUpdateSchema, resultSchema: imageSettingsResultSchema,
  configurationKeys: ['enabled', 'providerId', 'profileId', 'baseUrl', 'model', 'options'], custom: false});
const CUSTOM_PROFILE: CustomProfile = Object.freeze({namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE, defaults: DEFAULT_CUSTOM_IMAGE_CONFIGURATION,
  configurationSchema: customImageConfigurationSchema, updateSchema: customImageSettingsUpdateSchema, resultSchema: customImageSettingsResultSchema,
  configurationKeys: ['enabled', 'providerId', 'connectionId', 'profileId', 'baseUrl', 'model', 'options'], custom: true});
function parseConfiguration(value: unknown, profile: ImageProfile): ImageConfiguration {
  if (!exactObject(value, profile.configurationKeys) || !exactObject(record(value)?.options, ['size', 'quality', 'outputFormat', 'background', 'n'])) fail('IMAGE_SETTINGS_VALIDATION');
  if (profile.custom) {
    const parsed = customImageConfigurationSchema.safeParse(value);
    if (!parsed.success) fail('IMAGE_SETTINGS_VALIDATION');
    return parsed.data;
  }
  const parsed = imageConfigurationSchema.safeParse(value);
  if (!parsed.success) fail('IMAGE_SETTINGS_VALIDATION');
  return parsed.data;
}
export const parseImageConfiguration = (value: unknown): OfficialConfiguration => parseConfiguration(value, OFFICIAL_PROFILE) as OfficialConfiguration;
export const parseCustomImageConfiguration = (value: unknown): CustomConfiguration => parseConfiguration(value, CUSTOM_PROFILE) as CustomConfiguration;
function parseSettingsUpdate(value: unknown, profile: ImageProfile): ImageSettingsUpdate {
  if (!exactObject(value, ['expectedRevision', 'configuration', 'secret'])) fail('IMAGE_SETTINGS_VALIDATION');
  const source = value as Record<string, unknown>;
  const configuration = parseConfiguration(source.configuration, profile);
  const secret = record(source.secret);
  const keys = secret?.action === 'replace' ? ['action', 'storage', 'value'] : ['action'];
  if (!exactObject(source.secret, keys)) fail('IMAGE_SETTINGS_VALIDATION');
  if (profile.custom) {
    const parsed = customImageSettingsUpdateSchema.safeParse({...source, configuration});
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > IMAGE_SETTINGS_LIMITS.updateBytes ||
        (secret?.action === 'replace' && !isCompleteCustomImageConfiguration(configuration))) fail('IMAGE_SETTINGS_VALIDATION');
    return parsed.data;
  }
  const parsed = imageSettingsUpdateSchema.safeParse({...source, configuration});
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > IMAGE_SETTINGS_LIMITS.updateBytes) fail('IMAGE_SETTINGS_VALIDATION');
  return parsed.data;
}
export const parseImageSettingsUpdate = (value: unknown): ImageSettingsUpdate => parseSettingsUpdate(value, OFFICIAL_PROFILE);
export const parseCustomImageSettingsUpdate = (value: unknown): ImageSettingsUpdate => parseSettingsUpdate(value, CUSTOM_PROFILE);
// Symbols are trusted-module capabilities, absent from string dispatch, renderer
// IPC, HTTP responses and the CLI/MCP tool catalog.
export const IMAGE_CREDENTIAL_ACQUIRE = Symbol('trusted OpenAI Images credential');
export const IMAGE_SETTINGS_ASSERT_CURRENT = Symbol('synchronous current OpenAI Images settings fence');
export const IMAGE_SETTINGS_READ_CURRENT = Symbol('synchronous safe OpenAI Images settings snapshot');
function parseCredentialRequest(value: unknown, profile: ImageProfile): ImageCredentialRequest {
  const source = record(value), revision = source?.expectedRevision;
  if (!exactObject(value, ['expectedRevision', 'configuration']) || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) fail('IMAGE_SETTINGS_VALIDATION');
  return {expectedRevision: revision, configuration: parseConfiguration((source as Record<string, unknown>).configuration, profile)};
}
export const parseImageCredentialRequest = (value: unknown): ImageCredentialRequest => parseCredentialRequest(value, OFFICIAL_PROFILE);
export const parseCustomImageCredentialRequest = (value: unknown): ImageCredentialRequest => parseCredentialRequest(value, CUSTOM_PROFILE);
function sanitizeCredentialResult(value: unknown, expectedInput: unknown, profile: ImageProfile): AcquiredImageCredential {
  const expected = parseCredentialRequest(expectedInput, profile), source = record(value);
  if (!exactObject(value, ['namespace', 'revision', 'configuration', 'apiKey']) || source!.namespace !== profile.namespace ||
      source!.revision !== expected.expectedRevision || !sameConfiguration(parseConfiguration(source!.configuration, profile), expected.configuration)) fail('IMAGE_SETTINGS_CONFLICT');
  if (source!.apiKey !== null) parseSettingsUpdate({expectedRevision: source!.revision, configuration: expected.configuration,
    secret: {action: 'replace', storage: 'session', value: source!.apiKey}}, profile);
  return {namespace: profile.namespace, revision: source!.revision as number, configuration: structuredClone(expected.configuration) as ImageConfiguration, apiKey: source!.apiKey as string | null};
}
export const sanitizeImageCredentialResult = (value: unknown, expected: unknown): AcquiredImageCredential => sanitizeCredentialResult(value, expected, OFFICIAL_PROFILE);
export const sanitizeCustomImageCredentialResult = (value: unknown, expected: unknown): AcquiredImageCredential => sanitizeCredentialResult(value, expected, CUSTOM_PROFILE);
function sanitizeSettingsResult(value: unknown, profile: ImageProfile): ImageSettingsResult {
  // An allowlist serializer, deliberately not an object spread of an envelope.
  const source = record(value), secret = record(source?.secret), storage = record(source?.storage);
  const result = {revision: source?.revision, configuration: parseConfiguration(source?.configuration, profile),
    secret: {configured: secret?.configured, storage: secret?.storage},
    storage: {persistentAvailable: storage?.persistentAvailable, sessionScope: storage?.sessionScope, reasonCode: storage?.reasonCode}};
  if (profile.custom) {
    const parsed = customImageSettingsResultSchema.safeParse(result);
    if (!parsed.success || (result.secret.configured && !isCompleteCustomImageConfiguration(result.configuration as CustomConfiguration))) fail('IMAGE_SETTINGS_CORRUPT');
    return parsed.data;
  }
  const parsed = imageSettingsResultSchema.safeParse(result);
  if (!parsed.success) fail('IMAGE_SETTINGS_CORRUPT');
  return parsed.data;
}
export const sanitizeImageSettingsResult = (value: unknown): ImageSettingsResult => sanitizeSettingsResult(value, OFFICIAL_PROFILE);
export const sanitizeCustomImageSettingsResult = (value: unknown): ImageSettingsResult => sanitizeSettingsResult(value, CUSTOM_PROFILE);
// The official binding encoding is unchanged. Custom credentials additionally
// bind the one explicit connection ID; neither slot can adopt another's key.
const credentialBinding = (configuration: ImageConfiguration, profile: ImageProfile): string => JSON.stringify([profile.namespace, configuration.providerId,
  ...(profile.custom && 'connectionId' in configuration ? [(configuration as CustomConfiguration).connectionId] : []), configuration.profileId, configuration.baseUrl, configuration.model, configuration.options]);
function parseEnvelope(value: unknown, profile: ImageProfile): ImageSettingsEnvelope {
  const source = record(value), revision = source?.revision;
  if (!exactObject(value, ['version', 'namespace', 'revision', 'configuration', 'secret']) || source!.version !== 1 || source!.namespace !== profile.namespace ||
      typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) fail('IMAGE_SETTINGS_CORRUPT');
  let configuration: ImageConfiguration;
  try { configuration = parseConfiguration(source!.configuration, profile); } catch { fail('IMAGE_SETTINGS_CORRUPT'); }
  let secret: ImageSettingsSecretEnvelope | null = null;
  if (source!.secret !== null) {
    const encryptedSecret = record(source!.secret);
    if ((profile.custom && !isCompleteCustomImageConfiguration(configuration)) ||
        !exactObject(source!.secret, ['binding', 'encrypted']) || encryptedSecret!.binding !== credentialBinding(configuration, profile) ||
        typeof encryptedSecret!.encrypted !== 'string' || !encryptedSecret!.encrypted || encryptedSecret!.encrypted.length > IMAGE_SETTINGS_LIMITS.ciphertextCharacters ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encryptedSecret!.encrypted) ||
        Buffer.from(encryptedSecret!.encrypted, 'base64').toString('base64') !== encryptedSecret!.encrypted) fail('IMAGE_SETTINGS_CORRUPT');
    secret = {binding: encryptedSecret!.binding as string, encrypted: encryptedSecret!.encrypted};
  }
  return {version: 1, namespace: profile.namespace, revision: revision as number, configuration, secret};
}
// Private adapters accept only their own validated encrypted envelope, never a
// secret-update DTO or a plaintext value. These are not public settings getters.
export const validateImageSettingsEnvelope = (value: unknown): ImageSettingsEnvelope => parseEnvelope(value, OFFICIAL_PROFILE);
export const validateCustomImageSettingsEnvelope = (value: unknown): ImageSettingsEnvelope => parseEnvelope(value, CUSTOM_PROFILE);
function boundedCodec(operation: () => unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: unknown): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error) reject(imageSettingsError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE')); else resolve(value);
    };
    const aborted = (): void => finish(true), timer = setTimeout(aborted, 5000);
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, {once: true});
    Promise.resolve().then(() => { if (!settled) return operation(); }).then(value => finish(null, value), () => finish(true));
  });
}
export function validateImageSecretPlaintext(plaintext: unknown): {version: number; namespace: string; binding: string; value: string} {
  if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > IMAGE_SETTINGS_LIMITS.updateBytes) fail('IMAGE_SETTINGS_CORRUPT');
  let decoded: unknown;
  try { decoded = JSON.parse(plaintext); } catch { fail('IMAGE_SETTINGS_CORRUPT'); }
  const source = record(decoded);
  if (!exactObject(decoded, ['version', 'namespace', 'binding', 'value']) || source!.version !== 1 || typeof source!.binding !== 'string') fail('IMAGE_SETTINGS_CORRUPT');
  const profile: ImageProfile | null = source!.namespace === IMAGE_SETTINGS_NAMESPACE ? OFFICIAL_PROFILE
    : source!.namespace === CUSTOM_IMAGE_SETTINGS_NAMESPACE ? CUSTOM_PROFILE : null;
  if (!profile) fail('IMAGE_SETTINGS_CORRUPT');
  let configuration: ImageConfiguration = profile.defaults;
  try {
    if (profile.custom) {
      const binding: unknown = JSON.parse(source!.binding as string);
      if (!Array.isArray(binding) || binding.length !== 7 || binding[0] !== profile.namespace) fail('IMAGE_SETTINGS_CORRUPT');
      configuration = parseConfiguration({enabled: true, providerId: binding[1], connectionId: binding[2], profileId: binding[3],
        baseUrl: binding[4], model: binding[5], options: binding[6]}, profile);
    }
    if (source!.binding !== credentialBinding(configuration, profile)) fail('IMAGE_SETTINGS_CORRUPT');
    parseSettingsUpdate({expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'persistent', value: source!.value}}, profile);
  } catch { fail('IMAGE_SETTINGS_CORRUPT'); }
  return {version: 1, namespace: profile.namespace, binding: source!.binding as string, value: source!.value as string};
}
function decodeCredential(plaintext: unknown, binding: string, profile: ImageProfile): string {
  const decoded = validateImageSecretPlaintext(plaintext);
  if (decoded.namespace !== profile.namespace || decoded.binding !== binding) fail('IMAGE_SETTINGS_CORRUPT');
  return decoded.value;
}

/** Dedicated image settings and credential owner. No network activity, provider
 * probing, automatic fallback, Agent/video credential adoption or global env key.
 * Acquired plaintext is a revision-bound snapshot, not dispatch authorization:
 * same-engine callers must synchronously assert at the final fence, without an
 * intervening await. Cross-process callers need their own reservation protocol. */
export const createImageSettings = (options: ImageSettingsOptions = {}) => createSettings(options, OFFICIAL_PROFILE);
export const createCustomImageSettings = (options: ImageSettingsOptions = {}) => createSettings(options, CUSTOM_PROFILE);
async function createSettings({persistence, secretCodec, storage = {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}}: ImageSettingsOptions, profile: ImageProfile) {
  let state: ImageSettingsEnvelope = {version: 1, namespace: profile.namespace, revision: 0, configuration: structuredClone(profile.defaults) as ImageConfiguration, secret: null};
  let durableExists = false;
  let session: ImageSettingsSession | null = null, fault: ImageSettingsError | null = null;
  let tail: Promise<unknown> = Promise.resolve(), closing = false, pendingPuts = 0, vaultReadBlocked = false, refreshBlocked = false;
  async function refreshCapabilities(signal?: AbortSignal): Promise<void> {
    if (typeof secretCodec?.refreshStorage !== 'function') return;
    try { await boundedCodec(() => (secretCodec as ImageSettingsSecretCodec).refreshStorage!(), signal); refreshBlocked = false; }
    catch { refreshBlocked = true; }
  }
  function baseCapabilities(): ImageSettingsStorageView {
    let value: ImageSettingsStorageView;
    try {
      const supplied = typeof storage === 'function' ? storage() : storage;
      const parsed = sanitizeSettingsResult({revision: 0, configuration: profile.defaults, secret: {configured: false, storage: 'none'}, storage: supplied}, profile);
      value = parsed.storage;
    } catch { fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
    return refreshBlocked || (value.persistentAvailable && (!secretCodec || typeof secretCodec.encrypt !== 'function' || typeof secretCodec.decrypt !== 'function'))
      ? {...value, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'} : value;
  }
  const capabilities = (): ImageSettingsStorageView => {
    const value = baseCapabilities();
    return vaultReadBlocked ? {...value, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'} : value;
  };
  try {
    if (!persistence || typeof persistence.load !== 'function' || typeof persistence.save !== 'function') fail('IMAGE_SETTINGS_CORRUPT');
    const loaded = await persistence.load();
    if (loaded !== null) { state = parseEnvelope(loaded, profile); durableExists = true; }
    await refreshCapabilities();
    if (state.secret) {
      const secret = state.secret;
      if (!secretCodec) fail('IMAGE_SETTINGS_CORRUPT');
      if (baseCapabilities().persistentAvailable) {
        try { decodeCredential(await boundedCodec(() => (secretCodec as ImageSettingsSecretCodec).decrypt!(secret.encrypted)), state.secret.binding, profile); }
        catch { vaultReadBlocked = true; }
      }
    }
  } catch { fault = imageSettingsError('IMAGE_SETTINGS_CORRUPT'); }
  function schedule<T>(operation: () => T | Promise<T>): Promise<T> {
    if (closing) return Promise.reject(imageSettingsError('IMAGE_SETTINGS_CLOSED'));
    const result = tail.then(() => { if (closing) fail('IMAGE_SETTINGS_CLOSED'); if (fault) throw fault; return operation(); });
    tail = result.catch(() => {});
    return result;
  }
  const snapshot = (): ImageSettingsResult => sanitizeSettingsResult({revision: state.revision, configuration: state.configuration,
    secret: {configured: Boolean(state.secret || session), storage: state.secret ? 'persistent' : session ? 'session' : 'none'}, storage: capabilities()}, profile);
  function assertRevision(expected: ImageCredentialRequest): void {
    if (closing) fail('IMAGE_SETTINGS_CLOSED');
    if (fault) throw fault;
    if (state.revision !== expected.expectedRevision || !sameConfiguration(state.configuration, expected.configuration)) fail('IMAGE_SETTINGS_CONFLICT');
  }
  return Object.freeze({
    get() { return schedule(async () => { await refreshCapabilities(); if (closing) fail('IMAGE_SETTINGS_CLOSED'); return snapshot(); }); },
    [IMAGE_SETTINGS_READ_CURRENT]() {
      if (closing) fail('IMAGE_SETTINGS_CLOSED');
      if (fault) throw fault;
      if (pendingPuts) fail('IMAGE_SETTINGS_CONFLICT');
      return snapshot();
    },
    [IMAGE_SETTINGS_ASSERT_CURRENT](input: unknown): boolean {
      const expected = parseCredentialRequest(input, profile);
      assertRevision(expected);
      if (pendingPuts) fail('IMAGE_SETTINGS_CONFLICT');
      if (!state.configuration.enabled) fail('IMAGE_SETTINGS_DISABLED');
      if (!state.secret && !session) fail('IMAGE_SETTINGS_NOT_CONFIGURED');
      if (state.secret && !capabilities().persistentAvailable) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
      const binding = credentialBinding(expected.configuration, profile);
      const storedSecret = state.secret ?? session;
      if (!storedSecret || storedSecret.binding !== binding) fail('IMAGE_SETTINGS_CONFLICT');
      return true;
    },
    [IMAGE_CREDENTIAL_ACQUIRE](input: unknown, options: {signal?: AbortSignal} = {}): Promise<AcquiredImageCredential> {
      let expected: ImageCredentialRequest;
      try { expected = parseCredentialRequest(input, profile); } catch (error) { return Promise.reject(error); }
      const signal = options.signal;
      return schedule(async () => {
        assertRevision(expected);
        if (signal?.aborted) fail('IMAGE_SETTINGS_CLOSED');
        const binding = credentialBinding(expected.configuration, profile);
        let apiKey: string | null = null;
        const secret = state.secret;
        if (secret) {
          await refreshCapabilities(signal);
          assertRevision(expected);
          if (signal?.aborted) fail('IMAGE_SETTINGS_CLOSED');
          if (!capabilities().persistentAvailable || secret.binding !== binding) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
          try { apiKey = decodeCredential(await boundedCodec(() => (secretCodec as ImageSettingsSecretCodec).decrypt!(secret.encrypted), signal), binding, profile); }
          catch { fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
        } else if (session) {
          if (session.binding !== binding) fail('IMAGE_SETTINGS_CONFLICT');
          apiKey = session.value;
        }
        assertRevision(expected);
        if (signal?.aborted) fail('IMAGE_SETTINGS_CLOSED');
        return sanitizeCredentialResult({namespace: profile.namespace, revision: state.revision, configuration: state.configuration, apiKey}, expected, profile);
      });
    },
    put(input: unknown) {
      let update: ImageSettingsUpdate;
      try { update = parseSettingsUpdate(input, profile); } catch (error) { return Promise.reject(error); }
      // Admission invalidates previously acquired snapshots before any async work.
      pendingPuts++;
      const result = schedule(async () => {
        if (update.expectedRevision !== state.revision) fail('IMAGE_SETTINGS_CONFLICT');
        if (state.revision === Number.MAX_SAFE_INTEGER) fail('IMAGE_SETTINGS_SAVE_FAILED');
        const binding = credentialBinding(update.configuration, profile), sameBinding = binding === credentialBinding(state.configuration, profile);
        // Changing the recipient or model cannot silently reuse or discard a
        // configured custom key. The user must explicitly remove or replace it.
        if (profile.custom && !sameBinding && (state.secret || session) && update.secret.action === 'keep') fail('IMAGE_SETTINGS_CONFLICT');
        let nextSecret: ImageSettingsSecretEnvelope | null = sameBinding ? state.secret : null, nextSession: ImageSettingsSession | null = sameBinding ? session : null;
        if (update.secret.action === 'remove') { nextSecret = null; nextSession = null; }
        if (update.secret.action === 'replace') {
          const replacement = update.secret, replacementValue = replacement.value;
          nextSecret = null; nextSession = null;
          if (replacement.storage === 'persistent') {
            await refreshCapabilities();
            if (closing) fail('IMAGE_SETTINGS_CLOSED');
            if (!baseCapabilities().persistentAvailable) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
            let encrypted: string;
            try { encrypted = await boundedCodec(() => (secretCodec as ImageSettingsSecretCodec).encrypt!(JSON.stringify({version: 1, namespace: profile.namespace, binding, value: replacementValue}))) as string; }
            catch { fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
            nextSecret = {binding, encrypted};
          } else nextSession = {binding, value: replacementValue};
        }
        if (closing) fail('IMAGE_SETTINGS_CLOSED');
        const candidate: ImageSettingsEnvelope = {version: 1, namespace: profile.namespace, revision: state.revision + 1, configuration: update.configuration, secret: nextSecret};
        try { parseEnvelope(candidate, profile); } catch { fail('IMAGE_SETTINGS_SAVE_FAILED'); }
        try { await (persistence as ImageSettingsPersistence).save(candidate); }
        catch {
          if (profile.custom) {
            // A custom persistence implementation may fail after an unknown
            // commit. Keep the admission fence up while bounded read-back proves
            // the exact previous envelope; otherwise latch closed until restart.
            try {
              const loaded = await boundedCodec(() => (persistence as ImageSettingsPersistence).load());
              if (durableExists ? loaded === null || !sameConfiguration(parseEnvelope(loaded, profile), state) : loaded !== null) throw Error();
            } catch { fault = imageSettingsError('IMAGE_SETTINGS_SAVE_FAILED'); session = null; }
          }
          fail('IMAGE_SETTINGS_SAVE_FAILED');
        }
        // RAM changes only after atomic persistence commits. Even a simultaneous
        // close must retain the durable revision; close then clears session RAM.
        state = candidate; durableExists = true; session = nextSession;
        if (update.secret.action !== 'keep' || !sameBinding) vaultReadBlocked = false;
        return snapshot();
      });
      return result.finally(() => { pendingPuts--; });
    },
    async close(): Promise<void> { closing = true; await tail; session = null; },
  });
}
