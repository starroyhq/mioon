import path from 'node:path';
import {ensurePrivateDirectory, validateManagedDirectory, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION, COMFY_SETTINGS_NAMESPACE, COMFY_SETTINGS_LIMITS,
  comfyImageConfigurationSchema, comfyImageSettingsUpdateSchema, comfyImageSettingsResultSchema,
  comfyImageBaseUrlSchema, comfyImageCheckResultSchema, isCompleteComfyImageConfiguration} from '../../../contracts/src/comfy-images.ts';
import {resolveComfyDestination} from './network.ts';

const messages = Object.freeze({
  COMFY_SETTINGS_VALIDATION: [400, 'Local ComfyUI settings do not match the supported fixed image profile.'],
  COMFY_SETTINGS_CONFLICT: [409, 'Local ComfyUI settings have changed. Read and review the current settings again.'],
  COMFY_SETTINGS_DISABLED: [409, 'Local ComfyUI image generation is not enabled.'],
  COMFY_SETTINGS_NOT_CONFIGURED: [409, 'Select a local ComfyUI connection and checkpoint before generating an image.'],
  COMFY_SETTINGS_CHECK_REQUIRED: [409, 'Check the selected local ComfyUI connection and checkpoint before generating an image.'],
  COMFY_SETTINGS_DESTINATION_DENIED: [400, 'The local ComfyUI destination is not allowed.'],
  COMFY_SETTINGS_SAVE_FAILED: [503, 'Local ComfyUI settings could not be saved safely. Reopen the application if they remain unavailable.'],
  COMFY_SETTINGS_CORRUPT: [503, 'Local ComfyUI settings cannot be read safely. Existing settings have not been replaced.'],
  COMFY_SETTINGS_CLOSED: [503, 'The local ComfyUI settings service is closed. Reopen the application.'],
});
export function comfySettingsError(code = 'COMFY_SETTINGS_VALIDATION') {
  const selected = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'COMFY_SETTINGS_SAVE_FAILED';
  return Object.assign(new Error(messages[selected][1]), {code: selected, status: messages[selected][0]});
}
export function sanitizeComfySettingsError(error) {
  let code = 'COMFY_SETTINGS_SAVE_FAILED';
  try { if (typeof error?.code === 'string') code = error.code; } catch {}
  const safe = comfySettingsError(code);
  return {code: safe.code, message: safe.message, status: safe.status};
}
const fail = code => { throw comfySettingsError(code); };
const exactObject = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const bounded = (value, limit) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
const configurationKeys = ['enabled', 'providerId', 'connectionId', 'profileId', 'baseUrl', 'model', 'options', 'comfyVersion'];
const optionKeys = ['size', 'steps', 'cfg', 'sampler', 'scheduler', 'denoise', 'n'];

export function parseComfyConfiguration(value) {
  try {
    if (!exactObject(value, configurationKeys) || !exactObject(value.options, optionKeys)) fail('COMFY_SETTINGS_VALIDATION');
    const parsed = comfyImageConfigurationSchema.safeParse(value);
    if (!parsed.success) fail('COMFY_SETTINGS_VALIDATION');
    return parsed.data;
  } catch { fail('COMFY_SETTINGS_VALIDATION'); }
}
export function parseComfySettingsUpdate(value) {
  try {
    if (!exactObject(value, ['expectedRevision', 'configuration'])) fail('COMFY_SETTINGS_VALIDATION');
    const parsed = comfyImageSettingsUpdateSchema.safeParse({expectedRevision: value.expectedRevision,
      configuration: parseComfyConfiguration(value.configuration)});
    if (!parsed.success || !bounded(parsed.data, COMFY_SETTINGS_LIMITS.updateBytes)) fail('COMFY_SETTINGS_VALIDATION');
    return parsed.data;
  } catch { fail('COMFY_SETTINGS_VALIDATION'); }
}
export function sanitizeComfySettingsResult(value) {
  // Only the public pair is returned: no path, envelope namespace or credentials.
  try {
    const parsed = comfyImageSettingsResultSchema.safeParse({revision: value?.revision,
      configuration: parseComfyConfiguration(value?.configuration),
      readiness: {checked: value?.readiness?.checked, checkedAt: value?.readiness?.checkedAt}});
    if (!parsed.success) fail('COMFY_SETTINGS_CORRUPT');
    return parsed.data;
  } catch { fail('COMFY_SETTINGS_CORRUPT'); }
}
export function validateComfySettingsEnvelope(value) {
  try {
    if (!exactObject(value, ['version', 'namespace', 'revision', 'configuration']) || value.version !== 1 ||
        value.namespace !== COMFY_SETTINGS_NAMESPACE || !Number.isSafeInteger(value.revision) || value.revision < 0) fail('COMFY_SETTINGS_CORRUPT');
    const parsed = {version: 1, namespace: COMFY_SETTINGS_NAMESPACE, revision: value.revision,
      configuration: parseComfyConfiguration(value.configuration)};
    if (!bounded(parsed, COMFY_SETTINGS_LIMITS.envelopeBytes)) fail('COMFY_SETTINGS_CORRUPT');
    return parsed;
  } catch { fail('COMFY_SETTINGS_CORRUPT'); }
}

/** Dedicated no-credential envelope. Existing paths are checked, never repaired;
 * the shared private-storage helpers supply bounded no-follow reads and atomic
 * private publication. Reading a missing slot must not create any directory. */
export function createComfySettingsFile({directory, privateRoot = directory} = {}) {
  if (typeof directory !== 'string' || typeof privateRoot !== 'string' || !path.isAbsolute(directory) ||
      !path.isAbsolute(privateRoot) || directory.includes('\0') || privateRoot.includes('\0')) fail('COMFY_SETTINGS_CORRUPT');
  const root = path.resolve(directory), boundary = path.resolve(privateRoot), relative = path.relative(boundary, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('COMFY_SETTINGS_CORRUPT');
  const file = path.join(root, 'settings.json');
  return Object.freeze({
    async load() {
      try {
        if (!ensurePrivateDirectory(boundary, {allowMissing: true})) return null;
        if (!validateManagedDirectory(root, {root: boundary, private: true, allowMissing: true})) return null;
        const contents = readPrivateFile(file, {root, maxBytes: COMFY_SETTINGS_LIMITS.envelopeBytes, allowMissing: true, encoding: 'utf8'});
        return contents === null ? null : validateComfySettingsEnvelope(JSON.parse(contents));
      } catch { fail('COMFY_SETTINGS_CORRUPT'); }
    },
    async save(value) {
      try {
        const contents = JSON.stringify(validateComfySettingsEnvelope(value)) + '\n';
        if (Buffer.byteLength(contents, 'utf8') > COMFY_SETTINGS_LIMITS.envelopeBytes) fail('COMFY_SETTINGS_SAVE_FAILED');
        ensurePrivateDirectory(boundary, {create: true});
        ensurePrivateDirectory(root, {create: true});
        writePrivateFileAtomic(file, contents, {root, maxBytes: COMFY_SETTINGS_LIMITS.envelopeBytes});
      } catch { fail('COMFY_SETTINGS_SAVE_FAILED'); }
    },
  });
}

// Trusted same-process capabilities, not string-routed HTTP/CLI/MCP operations.
export const COMFY_SETTINGS_READ_CURRENT = Symbol('synchronous safe local ComfyUI settings snapshot');
export const COMFY_SETTINGS_ASSERT_CURRENT = Symbol('synchronous current local ComfyUI settings fence');
const READ_BACK_TIMEOUT_MS = 5000;
function boundedReadBack(persistence) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(comfySettingsError('COMFY_SETTINGS_SAVE_FAILED')); else resolve(value);
    };
    const timer = setTimeout(() => finish(true), READ_BACK_TIMEOUT_MS);
    Promise.resolve().then(() => persistence.load()).then(value => finish(null, value), () => finish(true));
  });
}

/** One backend-owned connection, independent of Agent/Images credentials. No
 * network probe, environment key, vault or settings migration is involved.
 * Persistence and reservedPorts are trusted construction seams, never request
 * data. All puts share one serial queue and block the synchronous final fence
 * from admission through save/read-back. Call assertCurrent immediately before
 * dispatch without an intervening await; a snapshot is not authorization. */
export async function createComfySettings({directory, privateRoot = directory, persistence, reservedPorts} = {}) {
  let state = {version: 1, namespace: COMFY_SETTINGS_NAMESPACE, revision: 0,
    configuration: structuredClone(DEFAULT_COMFY_IMAGE_CONFIGURATION)};
  let durableExists = false, fault = null, tail = Promise.resolve(), closing = false, pendingPuts = 0, checked = null, checkAttempt = null;
  try {
    persistence ??= createComfySettingsFile({directory, privateRoot});
    if (typeof persistence?.load !== 'function' || typeof persistence?.save !== 'function') fail('COMFY_SETTINGS_CORRUPT');
    const loaded = await persistence.load();
    if (loaded !== null) { state = validateComfySettingsEnvelope(loaded); durableExists = true; }
  } catch { fault = 'COMFY_SETTINGS_CORRUPT'; }
  function assertAvailable() {
    if (closing) fail('COMFY_SETTINGS_CLOSED');
    if (fault) fail(fault);
  }
  function schedule(operation) {
    if (closing) return Promise.reject(comfySettingsError('COMFY_SETTINGS_CLOSED'));
    const result = tail.then(() => { assertAvailable(); return operation(); });
    tail = result.catch(() => {});
    return result;
  }
  function assertDestination(configuration) {
    if (!configuration.baseUrl) return;
    // This is only a literal-address/port check. It never opens a socket.
    try { resolveComfyDestination(configuration.baseUrl, {reservedPorts}); }
    catch { fail('COMFY_SETTINGS_DESTINATION_DENIED'); }
  }
  function isReady(configuration = state.configuration) {
    if (closing || fault || pendingPuts || !checked) return false;
    try {
      const parsed = parseComfyConfiguration(configuration);
      return parsed.enabled && isCompleteComfyImageConfiguration(parsed) && parsed.baseUrl === checked.result.baseUrl &&
        parsed.comfyVersion === checked.result.comfyVersion && checked.result.checkpoints.includes(parsed.model);
    } catch { return false; }
  }
  const snapshot = () => {
    // An admitted put fences dispatch, but its public successful result still
    // reports the new configuration's check evidence before admission releases.
    const ready = checked && state.configuration.enabled && state.configuration.baseUrl === checked.result.baseUrl &&
      state.configuration.comfyVersion === checked.result.comfyVersion && checked.result.checkpoints.includes(state.configuration.model);
    return sanitizeComfySettingsResult({...state, readiness: {checked: !!ready, checkedAt: ready ? checked.at : null}});
  };
  function clearCheck(baseUrl) {
    assertAvailable();
    if (pendingPuts) fail('COMFY_SETTINGS_CONFLICT');
    try { if (!comfyImageBaseUrlSchema.safeParse(baseUrl).success) fail('COMFY_SETTINGS_VALIDATION'); }
    catch { fail('COMFY_SETTINGS_VALIDATION'); }
    // An explicit re-check revokes prior evidence for this endpoint before any
    // I/O. The single opaque attempt token also supersedes outstanding checks,
    // so an older response cannot reinstate readiness after a later failure.
    if (checked?.result.baseUrl === baseUrl) checked = null;
    checkAttempt = {baseUrl, token: Symbol('local ComfyUI connection check attempt')};
    assertDestination({baseUrl});
    return checkAttempt.token;
  }
  function recordCheck(value, token) {
    assertAvailable();
    if (pendingPuts) fail('COMFY_SETTINGS_CONFLICT');
    if (!checkAttempt || token !== checkAttempt.token) fail('COMFY_SETTINGS_CONFLICT');
    const attempt = checkAttempt;
    checkAttempt = null;
    let result;
    try {
      const parsed = comfyImageCheckResultSchema.safeParse(value);
      if (!parsed.success) fail('COMFY_SETTINGS_VALIDATION');
      result = parsed.data;
    } catch { fail('COMFY_SETTINGS_VALIDATION'); }
    if (result.baseUrl !== attempt.baseUrl) fail('COMFY_SETTINGS_CONFLICT');
    assertDestination(result);
    // Only the trusted server calls this after its actual connector check. No
    // HTTP settings DTO can set check evidence, and none is written to disk.
    checked = {result, at: new Date().toISOString()};
    return snapshot();
  }
  function readCurrent() {
    assertAvailable();
    if (pendingPuts) fail('COMFY_SETTINGS_CONFLICT');
    return snapshot();
  }
  function assertCurrent(input) {
    assertAvailable();
    const expected = parseComfySettingsUpdate(input);
    if (pendingPuts || state.revision !== expected.expectedRevision || !same(state.configuration, expected.configuration)) fail('COMFY_SETTINGS_CONFLICT');
    if (!state.configuration.enabled) fail('COMFY_SETTINGS_DISABLED');
    if (!isCompleteComfyImageConfiguration(state.configuration)) fail('COMFY_SETTINGS_NOT_CONFIGURED');
    assertDestination(state.configuration);
    if (!isReady()) fail('COMFY_SETTINGS_CHECK_REQUIRED');
    return true;
  }
  return Object.freeze({
    get() { return schedule(snapshot); },
    readCurrent, assertCurrent, clearCheck, recordCheck, isReady,
    [COMFY_SETTINGS_READ_CURRENT]: readCurrent,
    [COMFY_SETTINGS_ASSERT_CURRENT]: assertCurrent,
    put(input) {
      let update;
      try { assertAvailable(); update = parseComfySettingsUpdate(input); }
      catch (error) { return Promise.reject(error); }
      // Parse makes an owned copy before admission. Caller mutation cannot
      // change the candidate while it waits behind another persistence write.
      pendingPuts++;
      const result = schedule(async () => {
        if (update.expectedRevision !== state.revision) fail('COMFY_SETTINGS_CONFLICT');
        assertDestination(update.configuration);
        if (state.revision === Number.MAX_SAFE_INTEGER) fail('COMFY_SETTINGS_SAVE_FAILED');
        const candidate = validateComfySettingsEnvelope({version: 1, namespace: COMFY_SETTINGS_NAMESPACE,
          revision: state.revision + 1, configuration: update.configuration});
        try { await persistence.save(structuredClone(candidate)); }
        catch {
          // A throwing adapter can already have committed. Never publish a
          // candidate or revive stale RAM on an ambiguous outcome. Only proof
          // of the exact old durable envelope (or previously absent file) can
          // keep this owner usable. Never retry the save automatically.
          try {
            const loaded = await boundedReadBack(persistence);
            if (durableExists ? loaded === null || !same(validateComfySettingsEnvelope(loaded), state) : loaded !== null) throw Error();
          } catch { fault = 'COMFY_SETTINGS_SAVE_FAILED'; checked = null; checkAttempt = null; }
          fail('COMFY_SETTINGS_SAVE_FAILED');
        }
        // Retain a successful durable revision even when close was requested
        // during the save. Closed owners cannot authorize subsequent dispatch.
        state = candidate; durableExists = true;
        if (checked && state.configuration.baseUrl !== checked.result.baseUrl) checked = null;
        return snapshot();
      });
      return result.finally(() => { pendingPuts--; });
    },
    async close() { closing = true; checked = null; checkAttempt = null; await tail; },
  });
}
