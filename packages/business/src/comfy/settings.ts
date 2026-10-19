import path from 'node:path';
import {ensurePrivateDirectory, validateManagedDirectory, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION, COMFY_SETTINGS_NAMESPACE, COMFY_SETTINGS_LIMITS,
  comfyImageConfigurationSchema, comfyImageSettingsUpdateSchema, comfyImageSettingsResultSchema,
  comfyImageBaseUrlSchema, comfyImageCheckResultSchema, isCompleteComfyImageConfiguration} from '../../../contracts/src/comfy-images.ts';
import {resolveComfyDestination} from './network.ts';

type ComfyConfiguration = ReturnType<typeof comfyImageConfigurationSchema.parse>;
type ComfySettingsUpdate = ReturnType<typeof comfyImageSettingsUpdateSchema.parse>;
type ComfySettingsResult = ReturnType<typeof comfyImageSettingsResultSchema.parse>;
type ComfyCheckResult = ReturnType<typeof comfyImageCheckResultSchema.parse>;
export interface ComfySettingsEnvelope {version: number; namespace: string; revision: number; configuration: ComfyConfiguration}
export interface ComfySettingsError extends Error {code: string; status: number}
export interface ComfySettingsPersistence {load(): Promise<unknown>; save(value: unknown): Promise<unknown>}
export interface ComfySettingsFileOptions {directory?: string; privateRoot?: string}
export interface ComfySettingsOptions extends ComfySettingsFileOptions {persistence?: ComfySettingsPersistence; reservedPorts?: unknown}
const messages: Readonly<Record<string, readonly [number, string]>> = Object.freeze({
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
export function comfySettingsError(code = 'COMFY_SETTINGS_VALIDATION'): ComfySettingsError {
  const selected = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'COMFY_SETTINGS_SAVE_FAILED';
  return Object.assign(new Error(messages[selected][1]), {code: selected, status: messages[selected][0]});
}
export function sanitizeComfySettingsError(error: unknown): {code: string; message: string; status: number} {
  let code = 'COMFY_SETTINGS_SAVE_FAILED';
  try { if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') code = error.code; } catch {}
  const safe = comfySettingsError(code);
  return {code: safe.code, message: safe.message, status: safe.status};
}
function fail(code: string): never { throw comfySettingsError(code); }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exactObject = (value: unknown, keys: readonly string[]): boolean => record(value) !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value as object).length === keys.length &&
  keys.every(key => Object.hasOwn(value as object, key));
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const bounded = (value: unknown, limit: number): boolean => Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
const configurationKeys = ['enabled', 'providerId', 'connectionId', 'profileId', 'baseUrl', 'model', 'options', 'comfyVersion'];
const optionKeys = ['size', 'steps', 'cfg', 'sampler', 'scheduler', 'denoise', 'n'];

export function parseComfyConfiguration(value: unknown): ComfyConfiguration {
  try {
    if (!exactObject(value, configurationKeys) || !exactObject((value as Record<string, unknown>).options, optionKeys)) fail('COMFY_SETTINGS_VALIDATION');
    const parsed = comfyImageConfigurationSchema.safeParse(value);
    if (!parsed.success) fail('COMFY_SETTINGS_VALIDATION');
    return parsed.data;
  } catch { fail('COMFY_SETTINGS_VALIDATION'); }
}
export function parseComfySettingsUpdate(value: unknown): ComfySettingsUpdate {
  try {
    if (!exactObject(value, ['expectedRevision', 'configuration'])) fail('COMFY_SETTINGS_VALIDATION');
    const source = value as Record<string, unknown>;
    const parsed = comfyImageSettingsUpdateSchema.safeParse({expectedRevision: source.expectedRevision,
      configuration: parseComfyConfiguration(source.configuration)});
    if (!parsed.success || !bounded(parsed.data, COMFY_SETTINGS_LIMITS.updateBytes)) fail('COMFY_SETTINGS_VALIDATION');
    return parsed.data;
  } catch { fail('COMFY_SETTINGS_VALIDATION'); }
}
export function sanitizeComfySettingsResult(value: unknown) {
  // Only the public pair is returned: no path, envelope namespace or credentials.
  try {
    const source = record(value);
    const readiness = record(source?.readiness);
    const parsed = comfyImageSettingsResultSchema.safeParse({revision: source?.revision,
      configuration: parseComfyConfiguration(source?.configuration),
      readiness: {checked: readiness?.checked, checkedAt: readiness?.checkedAt}});
    if (!parsed.success) fail('COMFY_SETTINGS_CORRUPT');
    return parsed.data;
  } catch { fail('COMFY_SETTINGS_CORRUPT'); }
}
export function validateComfySettingsEnvelope(value: unknown): ComfySettingsEnvelope {
  try {
    if (!exactObject(value, ['version', 'namespace', 'revision', 'configuration'])) fail('COMFY_SETTINGS_CORRUPT');
    const source = value as Record<string, unknown>, revision = source.revision;
    if (source.version !== 1 || source.namespace !== COMFY_SETTINGS_NAMESPACE || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) fail('COMFY_SETTINGS_CORRUPT');
    const parsed: ComfySettingsEnvelope = {version: 1, namespace: COMFY_SETTINGS_NAMESPACE, revision,
      configuration: parseComfyConfiguration(source.configuration)};
    if (!bounded(parsed, COMFY_SETTINGS_LIMITS.envelopeBytes)) fail('COMFY_SETTINGS_CORRUPT');
    return parsed;
  } catch { fail('COMFY_SETTINGS_CORRUPT'); }
}

/** Dedicated no-credential envelope. Existing paths are checked, never repaired;
 * the shared private-storage helpers supply bounded no-follow reads and atomic
 * private publication. Reading a missing slot must not create any directory. */
export function createComfySettingsFile({directory, privateRoot = directory}: ComfySettingsFileOptions = {}) {
  if (typeof directory !== 'string' || typeof privateRoot !== 'string' || !path.isAbsolute(directory) ||
      !path.isAbsolute(privateRoot) || directory.includes('\0') || privateRoot.includes('\0')) fail('COMFY_SETTINGS_CORRUPT');
  const root = path.resolve(directory), boundary = path.resolve(privateRoot), relative = path.relative(boundary, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('COMFY_SETTINGS_CORRUPT');
  const file = path.join(root, 'settings.json');
  return Object.freeze({
    async load(): Promise<ComfySettingsEnvelope | null> {
      try {
        if (!ensurePrivateDirectory(boundary, {allowMissing: true})) return null;
        if (!validateManagedDirectory(root, {root: boundary, private: true, allowMissing: true})) return null;
        const contents = readPrivateFile(file, {root, maxBytes: COMFY_SETTINGS_LIMITS.envelopeBytes, allowMissing: true, encoding: 'utf8'} as Parameters<typeof readPrivateFile>[1]);
        return typeof contents !== 'string' ? null : validateComfySettingsEnvelope(JSON.parse(contents));
      } catch { fail('COMFY_SETTINGS_CORRUPT'); }
    },
    async save(value: unknown): Promise<void> {
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
function boundedReadBack(persistence: ComfySettingsPersistence): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: unknown): void => {
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
export async function createComfySettings({directory, privateRoot = directory, persistence, reservedPorts}: ComfySettingsOptions = {}) {
  let state: ComfySettingsEnvelope = {version: 1, namespace: COMFY_SETTINGS_NAMESPACE, revision: 0,
    configuration: structuredClone(DEFAULT_COMFY_IMAGE_CONFIGURATION)};
  let durable: ComfySettingsPersistence | undefined = persistence;
  let durableExists = false, fault: string | null = null, tail: Promise<unknown> = Promise.resolve(), closing = false, pendingPuts = 0;
  let checked: {result: ComfyCheckResult; at: string} | null = null, checkAttempt: {baseUrl: string; token: symbol} | null = null;
  try {
    durable ??= createComfySettingsFile({directory, privateRoot});
    if (typeof durable?.load !== 'function' || typeof durable?.save !== 'function') fail('COMFY_SETTINGS_CORRUPT');
    const loaded = await durable.load();
    if (loaded !== null) { state = validateComfySettingsEnvelope(loaded); durableExists = true; }
  } catch { fault = 'COMFY_SETTINGS_CORRUPT'; }
  function assertAvailable(): void {
    if (closing) fail('COMFY_SETTINGS_CLOSED');
    if (fault) fail(fault);
  }
  function schedule<T>(operation: () => T | Promise<T>): Promise<T> {
    if (closing) return Promise.reject(comfySettingsError('COMFY_SETTINGS_CLOSED'));
    const result = tail.then(() => { assertAvailable(); return operation(); });
    tail = result.catch(() => {});
    return result;
  }
  function assertDestination(configuration: {baseUrl: unknown}): void {
    if (!configuration.baseUrl) return;
    // This is only a literal-address/port check. It never opens a socket.
    try { resolveComfyDestination(configuration.baseUrl, {reservedPorts}); }
    catch { fail('COMFY_SETTINGS_DESTINATION_DENIED'); }
  }
  function isReady(configuration: ComfyConfiguration = state.configuration): boolean {
    if (closing || fault || pendingPuts || !checked) return false;
    try {
      const parsed = parseComfyConfiguration(configuration);
      return parsed.enabled && isCompleteComfyImageConfiguration(parsed) && parsed.baseUrl === checked.result.baseUrl &&
        parsed.comfyVersion === checked.result.comfyVersion && checked.result.checkpoints.includes(parsed.model);
    } catch { return false; }
  }
  const snapshot = (): ComfySettingsResult => {
    // An admitted put fences dispatch, but its public successful result still
    // reports the new configuration's check evidence before admission releases.
    const ready = checked && state.configuration.enabled && state.configuration.baseUrl === checked.result.baseUrl &&
      state.configuration.comfyVersion === checked.result.comfyVersion && checked.result.checkpoints.includes(state.configuration.model);
    return sanitizeComfySettingsResult({...state, readiness: {checked: !!ready, checkedAt: ready && checked ? checked.at : null}});
  };
  function clearCheck(baseUrl: unknown): symbol {
    assertAvailable();
    if (pendingPuts) fail('COMFY_SETTINGS_CONFLICT');
    try { if (typeof baseUrl !== 'string' || !comfyImageBaseUrlSchema.safeParse(baseUrl).success) fail('COMFY_SETTINGS_VALIDATION'); }
    catch { fail('COMFY_SETTINGS_VALIDATION'); }
    // An explicit re-check revokes prior evidence for this endpoint before any
    // I/O. The single opaque attempt token also supersedes outstanding checks,
    // so an older response cannot reinstate readiness after a later failure.
    if (checked?.result.baseUrl === baseUrl) checked = null;
    checkAttempt = {baseUrl: baseUrl as string, token: Symbol('local ComfyUI connection check attempt')};
    assertDestination({baseUrl});
    return checkAttempt.token;
  }
  function parseCheckResult(value: unknown): ComfyCheckResult {
    try {
      const parsed = comfyImageCheckResultSchema.safeParse(value);
      if (!parsed.success) fail('COMFY_SETTINGS_VALIDATION');
      return parsed.data;
    } catch { fail('COMFY_SETTINGS_VALIDATION'); }
  }
  function recordCheck(value: unknown, token: symbol) {
    assertAvailable();
    if (pendingPuts) fail('COMFY_SETTINGS_CONFLICT');
    if (!checkAttempt || token !== checkAttempt.token) fail('COMFY_SETTINGS_CONFLICT');
    const attempt = checkAttempt;
    checkAttempt = null;
    const result = parseCheckResult(value);
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
  function assertCurrent(input: unknown): true {
    assertAvailable();
    const expected = parseComfySettingsUpdate(input);
    if (pendingPuts || state.revision !== expected.expectedRevision || !same(state.configuration, expected.configuration)) fail('COMFY_SETTINGS_CONFLICT');
    if (!state.configuration.enabled) fail('COMFY_SETTINGS_DISABLED');
    if (!isCompleteComfyImageConfiguration(state.configuration)) fail('COMFY_SETTINGS_NOT_CONFIGURED');
    assertDestination(state.configuration);
    if (!isReady()) fail('COMFY_SETTINGS_CHECK_REQUIRED');
    return true;
  }
  function putParsed(update: ComfySettingsUpdate) {
    // Parse makes an owned copy before admission. Caller mutation cannot
    // change the candidate while it waits behind another persistence write.
    pendingPuts++;
    const result = schedule(async () => {
      if (update.expectedRevision !== state.revision) fail('COMFY_SETTINGS_CONFLICT');
      assertDestination(update.configuration);
      if (state.revision === Number.MAX_SAFE_INTEGER) fail('COMFY_SETTINGS_SAVE_FAILED');
      const candidate = validateComfySettingsEnvelope({version: 1, namespace: COMFY_SETTINGS_NAMESPACE,
        revision: state.revision + 1, configuration: update.configuration});
      try { await durable!.save(structuredClone(candidate)); }
      catch {
        // A throwing adapter can already have committed. Never publish a
        // candidate or revive stale RAM on an ambiguous outcome. Only proof
        // of the exact old durable envelope (or previously absent file) can
        // keep this owner usable. Never retry the save automatically.
        try {
          const loaded = await boundedReadBack(durable!);
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
  }
  return Object.freeze({
    get() { return schedule(snapshot); },
    readCurrent, assertCurrent, clearCheck, recordCheck, isReady,
    [COMFY_SETTINGS_READ_CURRENT]: readCurrent,
    [COMFY_SETTINGS_ASSERT_CURRENT]: assertCurrent,
    put(input: unknown) {
      try { assertAvailable(); return putParsed(parseComfySettingsUpdate(input)); }
      catch (error) { return Promise.reject(error); }
    },
    async close(): Promise<void> { closing = true; checked = null; checkAttempt = null; await tail; },
  });
}
