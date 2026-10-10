import {DEFAULT_IMAGE_CONFIGURATION, IMAGE_SETTINGS_NAMESPACE, IMAGE_SETTINGS_LIMITS, imageConfigurationSchema,
  imageSettingsUpdateSchema, imageSettingsResultSchema, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, CUSTOM_IMAGE_SETTINGS_NAMESPACE,
  customImageConfigurationSchema, customImageSettingsUpdateSchema, customImageSettingsResultSchema,
  isCompleteCustomImageConfiguration} from '../../../contracts/src/image-settings.mjs';

const messages = Object.freeze({
  IMAGE_SETTINGS_VALIDATION: [400, '图像设置格式无效，请检查固定预设和密钥输入。'],
  IMAGE_SETTINGS_CONFLICT: [409, '图像设置已改变，请重新读取并确认当前请求。'],
  IMAGE_SETTINGS_DISABLED: [409, 'OpenAI 图像生成尚未启用。'],
  IMAGE_SETTINGS_NOT_CONFIGURED: [409, '请先配置独立的 OpenAI 图像密钥。'],
  IMAGE_SETTINGS_STORAGE_UNAVAILABLE: [409, '系统安全存储不可用，请明确选择仅本次会话保存。'],
  IMAGE_SETTINGS_SAVE_FAILED: [503, '图像设置未能保存；请重新读取当前设置后再试。'],
  IMAGE_SETTINGS_CORRUPT: [503, '图像设置文件不可读取或不安全；现有设置未被覆盖。'],
  IMAGE_SETTINGS_CLOSED: [503, '图像设置服务已关闭，请重新打开应用。'],
});
export function imageSettingsError(code = 'IMAGE_SETTINGS_VALIDATION') {
  const known = typeof code === 'string' && Object.hasOwn(messages, code), selected = known ? code : 'IMAGE_SETTINGS_SAVE_FAILED';
  return Object.assign(new Error(messages[selected][1]), {code: selected, status: messages[selected][0]});
}
export function sanitizeImageSettingsError(error) {
  const safe = imageSettingsError(error?.code ?? 'IMAGE_SETTINGS_SAVE_FAILED');
  return {code: safe.code, message: safe.message, status: safe.status};
}
const fail = code => { throw imageSettingsError(code); };
const exactObject = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameConfiguration = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// These descriptors are module-owned capabilities, never options supplied by a
// renderer, HTTP request, stored envelope or caller. There are exactly two slots.
const OFFICIAL_PROFILE = Object.freeze({namespace: IMAGE_SETTINGS_NAMESPACE, defaults: DEFAULT_IMAGE_CONFIGURATION,
  configurationSchema: imageConfigurationSchema, updateSchema: imageSettingsUpdateSchema, resultSchema: imageSettingsResultSchema,
  configurationKeys: ['enabled', 'providerId', 'profileId', 'baseUrl', 'model', 'options'], custom: false});
const CUSTOM_PROFILE = Object.freeze({namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE, defaults: DEFAULT_CUSTOM_IMAGE_CONFIGURATION,
  configurationSchema: customImageConfigurationSchema, updateSchema: customImageSettingsUpdateSchema, resultSchema: customImageSettingsResultSchema,
  configurationKeys: ['enabled', 'providerId', 'connectionId', 'profileId', 'baseUrl', 'model', 'options'], custom: true});
function parseConfiguration(value, profile) {
  if (!exactObject(value, profile.configurationKeys) || !exactObject(value.options, ['size', 'quality', 'outputFormat', 'background', 'n'])) fail('IMAGE_SETTINGS_VALIDATION');
  const parsed = profile.configurationSchema.safeParse(value);
  if (!parsed.success) fail('IMAGE_SETTINGS_VALIDATION');
  return parsed.data;
}
export const parseImageConfiguration = value => parseConfiguration(value, OFFICIAL_PROFILE);
export const parseCustomImageConfiguration = value => parseConfiguration(value, CUSTOM_PROFILE);
function parseSettingsUpdate(value, profile) {
  if (!exactObject(value, ['expectedRevision', 'configuration', 'secret'])) fail('IMAGE_SETTINGS_VALIDATION');
  const configuration = parseConfiguration(value.configuration, profile);
  const keys = value.secret?.action === 'replace' ? ['action', 'storage', 'value'] : ['action'];
  if (!exactObject(value.secret, keys)) fail('IMAGE_SETTINGS_VALIDATION');
  const parsed = profile.updateSchema.safeParse({...value, configuration});
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > IMAGE_SETTINGS_LIMITS.updateBytes ||
      (profile.custom && value.secret.action === 'replace' && !isCompleteCustomImageConfiguration(configuration))) fail('IMAGE_SETTINGS_VALIDATION');
  return parsed.data;
}
export const parseImageSettingsUpdate = value => parseSettingsUpdate(value, OFFICIAL_PROFILE);
export const parseCustomImageSettingsUpdate = value => parseSettingsUpdate(value, CUSTOM_PROFILE);
// Symbols are trusted-module capabilities, absent from string dispatch, renderer
// IPC, HTTP responses and the CLI/MCP tool catalog.
export const IMAGE_CREDENTIAL_ACQUIRE = Symbol('trusted OpenAI Images credential');
export const IMAGE_SETTINGS_ASSERT_CURRENT = Symbol('synchronous current OpenAI Images settings fence');
export const IMAGE_SETTINGS_READ_CURRENT = Symbol('synchronous safe OpenAI Images settings snapshot');
function parseCredentialRequest(value, profile) {
  if (!exactObject(value, ['expectedRevision', 'configuration']) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) fail('IMAGE_SETTINGS_VALIDATION');
  return {expectedRevision: value.expectedRevision, configuration: parseConfiguration(value.configuration, profile)};
}
export const parseImageCredentialRequest = value => parseCredentialRequest(value, OFFICIAL_PROFILE);
export const parseCustomImageCredentialRequest = value => parseCredentialRequest(value, CUSTOM_PROFILE);
function sanitizeCredentialResult(value, expected, profile) {
  expected = parseCredentialRequest(expected, profile);
  if (!exactObject(value, ['namespace', 'revision', 'configuration', 'apiKey']) || value.namespace !== profile.namespace ||
      value.revision !== expected.expectedRevision || !sameConfiguration(parseConfiguration(value.configuration, profile), expected.configuration)) fail('IMAGE_SETTINGS_CONFLICT');
  if (value.apiKey !== null) parseSettingsUpdate({expectedRevision: value.revision, configuration: expected.configuration,
    secret: {action: 'replace', storage: 'session', value: value.apiKey}}, profile);
  return {namespace: profile.namespace, revision: value.revision, configuration: structuredClone(expected.configuration), apiKey: value.apiKey};
}
export const sanitizeImageCredentialResult = (value, expected) => sanitizeCredentialResult(value, expected, OFFICIAL_PROFILE);
export const sanitizeCustomImageCredentialResult = (value, expected) => sanitizeCredentialResult(value, expected, CUSTOM_PROFILE);
function sanitizeSettingsResult(value, profile) {
  // An allowlist serializer, deliberately not an object spread of an envelope.
  const result = {revision: value?.revision, configuration: parseConfiguration(value?.configuration, profile),
    secret: {configured: value?.secret?.configured, storage: value?.secret?.storage},
    storage: {persistentAvailable: value?.storage?.persistentAvailable, sessionScope: value?.storage?.sessionScope, reasonCode: value?.storage?.reasonCode}};
  const parsed = profile.resultSchema.safeParse(result);
  if (!parsed.success || (profile.custom && result.secret.configured && !isCompleteCustomImageConfiguration(result.configuration))) fail('IMAGE_SETTINGS_CORRUPT');
  return parsed.data;
}
export const sanitizeImageSettingsResult = value => sanitizeSettingsResult(value, OFFICIAL_PROFILE);
export const sanitizeCustomImageSettingsResult = value => sanitizeSettingsResult(value, CUSTOM_PROFILE);
// The official binding encoding is unchanged. Custom credentials additionally
// bind the one explicit connection ID; neither slot can adopt another's key.
const credentialBinding = (configuration, profile) => JSON.stringify([profile.namespace, configuration.providerId,
  ...(profile.custom ? [configuration.connectionId] : []), configuration.profileId, configuration.baseUrl, configuration.model, configuration.options]);
function parseEnvelope(value, profile) {
  if (!exactObject(value, ['version', 'namespace', 'revision', 'configuration', 'secret']) || value.version !== 1 || value.namespace !== profile.namespace ||
      !Number.isSafeInteger(value.revision) || value.revision < 0) fail('IMAGE_SETTINGS_CORRUPT');
  let configuration;
  try { configuration = parseConfiguration(value.configuration, profile); } catch { fail('IMAGE_SETTINGS_CORRUPT'); }
  let secret = null;
  if (value.secret !== null) {
    if ((profile.custom && !isCompleteCustomImageConfiguration(configuration)) ||
        !exactObject(value.secret, ['binding', 'encrypted']) || value.secret.binding !== credentialBinding(configuration, profile) ||
        typeof value.secret.encrypted !== 'string' || !value.secret.encrypted || value.secret.encrypted.length > IMAGE_SETTINGS_LIMITS.ciphertextCharacters ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.secret.encrypted) ||
        Buffer.from(value.secret.encrypted, 'base64').toString('base64') !== value.secret.encrypted) fail('IMAGE_SETTINGS_CORRUPT');
    secret = {binding: value.secret.binding, encrypted: value.secret.encrypted};
  }
  return {version: 1, namespace: profile.namespace, revision: value.revision, configuration, secret};
}
// Private adapters accept only their own validated encrypted envelope, never a
// secret-update DTO or a plaintext value. These are not public settings getters.
export const validateImageSettingsEnvelope = value => parseEnvelope(value, OFFICIAL_PROFILE);
export const validateCustomImageSettingsEnvelope = value => parseEnvelope(value, CUSTOM_PROFILE);
function boundedCodec(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error) reject(imageSettingsError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE')); else resolve(value);
    };
    const aborted = () => finish(true), timer = setTimeout(aborted, 5000);
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, {once: true});
    Promise.resolve().then(() => { if (!settled) return operation(); }).then(value => finish(null, value), () => finish(true));
  });
}
export function validateImageSecretPlaintext(plaintext) {
  if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > IMAGE_SETTINGS_LIMITS.updateBytes) fail('IMAGE_SETTINGS_CORRUPT');
  let decoded;
  try { decoded = JSON.parse(plaintext); } catch { fail('IMAGE_SETTINGS_CORRUPT'); }
  if (!exactObject(decoded, ['version', 'namespace', 'binding', 'value']) || decoded.version !== 1 || typeof decoded.binding !== 'string') fail('IMAGE_SETTINGS_CORRUPT');
  const profile = decoded.namespace === IMAGE_SETTINGS_NAMESPACE ? OFFICIAL_PROFILE
    : decoded.namespace === CUSTOM_IMAGE_SETTINGS_NAMESPACE ? CUSTOM_PROFILE : null;
  if (!profile) fail('IMAGE_SETTINGS_CORRUPT');
  let configuration = profile.defaults;
  try {
    if (profile.custom) {
      const binding = JSON.parse(decoded.binding);
      if (!Array.isArray(binding) || binding.length !== 7 || binding[0] !== profile.namespace) fail('IMAGE_SETTINGS_CORRUPT');
      configuration = parseConfiguration({enabled: true, providerId: binding[1], connectionId: binding[2], profileId: binding[3],
        baseUrl: binding[4], model: binding[5], options: binding[6]}, profile);
    }
    if (decoded.binding !== credentialBinding(configuration, profile)) fail('IMAGE_SETTINGS_CORRUPT');
    parseSettingsUpdate({expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'persistent', value: decoded.value}}, profile);
  } catch { fail('IMAGE_SETTINGS_CORRUPT'); }
  return {version: 1, namespace: profile.namespace, binding: decoded.binding, value: decoded.value};
}
function decodeCredential(plaintext, binding, profile) {
  const decoded = validateImageSecretPlaintext(plaintext);
  if (decoded.namespace !== profile.namespace || decoded.binding !== binding) fail('IMAGE_SETTINGS_CORRUPT');
  return decoded.value;
}

/** Dedicated image settings and credential owner. No network activity, provider
 * probing, automatic fallback, Agent/video credential adoption or global env key.
 * Acquired plaintext is a revision-bound snapshot, not dispatch authorization:
 * same-engine callers must synchronously assert at the final fence, without an
 * intervening await. Cross-process callers need their own reservation protocol. */
export const createImageSettings = options => createSettings(options, OFFICIAL_PROFILE);
export const createCustomImageSettings = options => createSettings(options, CUSTOM_PROFILE);
async function createSettings({persistence, secretCodec, storage = {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}}, profile) {
  let state = {version: 1, namespace: profile.namespace, revision: 0, configuration: structuredClone(profile.defaults), secret: null};
  let durableExists = false;
  let session = null, fault = null, tail = Promise.resolve(), closing = false, pendingPuts = 0, vaultReadBlocked = false, refreshBlocked = false;
  async function refreshCapabilities(signal) {
    if (typeof secretCodec?.refreshStorage !== 'function') return;
    try { await boundedCodec(() => secretCodec.refreshStorage(), signal); refreshBlocked = false; }
    catch { refreshBlocked = true; }
  }
  function baseCapabilities() {
    let value;
    try {
      const supplied = typeof storage === 'function' ? storage() : storage;
      value = sanitizeSettingsResult({revision: 0, configuration: profile.defaults, secret: {configured: false, storage: 'none'}, storage: supplied}, profile).storage;
    } catch { fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
    return refreshBlocked || (value.persistentAvailable && (!secretCodec || typeof secretCodec.encrypt !== 'function' || typeof secretCodec.decrypt !== 'function'))
      ? {...value, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'} : value;
  }
  const capabilities = () => {
    const value = baseCapabilities();
    return vaultReadBlocked ? {...value, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'} : value;
  };
  try {
    if (!persistence || typeof persistence.load !== 'function' || typeof persistence.save !== 'function') fail('IMAGE_SETTINGS_CORRUPT');
    const loaded = await persistence.load();
    if (loaded !== null) { state = parseEnvelope(loaded, profile); durableExists = true; }
    await refreshCapabilities();
    if (state.secret) {
      if (!secretCodec) fail('IMAGE_SETTINGS_CORRUPT');
      if (baseCapabilities().persistentAvailable) {
        try { decodeCredential(await boundedCodec(() => secretCodec.decrypt(state.secret.encrypted)), state.secret.binding, profile); }
        catch { vaultReadBlocked = true; }
      }
    }
  } catch { fault = imageSettingsError('IMAGE_SETTINGS_CORRUPT'); }
  function schedule(operation) {
    if (closing) return Promise.reject(imageSettingsError('IMAGE_SETTINGS_CLOSED'));
    const result = tail.then(() => { if (closing) fail('IMAGE_SETTINGS_CLOSED'); if (fault) throw fault; return operation(); });
    tail = result.catch(() => {});
    return result;
  }
  const snapshot = () => sanitizeSettingsResult({revision: state.revision, configuration: state.configuration,
    secret: {configured: Boolean(state.secret || session), storage: state.secret ? 'persistent' : session ? 'session' : 'none'}, storage: capabilities()}, profile);
  function assertRevision(expected) {
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
    [IMAGE_SETTINGS_ASSERT_CURRENT](input) {
      const expected = parseCredentialRequest(input, profile);
      assertRevision(expected);
      if (pendingPuts) fail('IMAGE_SETTINGS_CONFLICT');
      if (!state.configuration.enabled) fail('IMAGE_SETTINGS_DISABLED');
      if (!state.secret && !session) fail('IMAGE_SETTINGS_NOT_CONFIGURED');
      if (state.secret && !capabilities().persistentAvailable) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
      const binding = credentialBinding(expected.configuration, profile);
      if ((state.secret || session).binding !== binding) fail('IMAGE_SETTINGS_CONFLICT');
      return true;
    },
    [IMAGE_CREDENTIAL_ACQUIRE](input, options = {}) {
      let expected;
      try { expected = parseCredentialRequest(input, profile); } catch (error) { return Promise.reject(error); }
      const signal = options.signal;
      return schedule(async () => {
        assertRevision(expected);
        if (signal?.aborted) fail('IMAGE_SETTINGS_CLOSED');
        const binding = credentialBinding(expected.configuration, profile);
        let apiKey = null;
        if (state.secret) {
          await refreshCapabilities(signal);
          assertRevision(expected);
          if (signal?.aborted) fail('IMAGE_SETTINGS_CLOSED');
          if (!capabilities().persistentAvailable || state.secret.binding !== binding) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
          try { apiKey = decodeCredential(await boundedCodec(() => secretCodec.decrypt(state.secret.encrypted), signal), binding, profile); }
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
    put(input) {
      let update;
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
        let nextSecret = sameBinding ? state.secret : null, nextSession = sameBinding ? session : null;
        if (update.secret.action === 'remove') { nextSecret = null; nextSession = null; }
        if (update.secret.action === 'replace') {
          nextSecret = null; nextSession = null;
          if (update.secret.storage === 'persistent') {
            await refreshCapabilities();
            if (closing) fail('IMAGE_SETTINGS_CLOSED');
            if (!baseCapabilities().persistentAvailable) fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
            let encrypted;
            try { encrypted = await boundedCodec(() => secretCodec.encrypt(JSON.stringify({version: 1, namespace: profile.namespace, binding, value: update.secret.value}))); }
            catch { fail('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
            nextSecret = {binding, encrypted};
          } else nextSession = {binding, value: update.secret.value};
        }
        if (closing) fail('IMAGE_SETTINGS_CLOSED');
        const candidate = {version: 1, namespace: profile.namespace, revision: state.revision + 1, configuration: update.configuration, secret: nextSecret};
        try { parseEnvelope(candidate, profile); } catch { fail('IMAGE_SETTINGS_SAVE_FAILED'); }
        try { await persistence.save(candidate); }
        catch {
          if (profile.custom) {
            // A custom persistence implementation may fail after an unknown
            // commit. Keep the admission fence up while bounded read-back proves
            // the exact previous envelope; otherwise latch closed until restart.
            try {
              const loaded = await boundedCodec(() => persistence.load());
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
    async close() { closing = true; await tail; session = null; },
  });
}
