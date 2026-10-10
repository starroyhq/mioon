import { CAPABILITY_PROFILES, INPUT_ROLES, PROFILE_VERSION, deepFreeze, getCapabilityProfile, getGenerationProfileRegion } from './generation-input-profiles.mjs';
const requestKeys = ['schemaVersion', 'providerId', 'model', 'region', 'prompt', 'aspectRatio', 'duration', 'references', 'parameters'];
const referenceKeys = ['role', 'assetId', 'mimeType', 'sizeBytes', 'sha256', 'width', 'height', 'durationSeconds'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const dataProperties = value => !Object.getOwnPropertySymbols(value).length && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => !d.get && !d.set && d.enumerable);
const referenceArray = value => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 8) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  return keys.length === value.length + 1 && keys.every(key => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length && !descriptors[key].get && !descriptors[key].set && descriptors[key].enumerable));
};
const safePositiveInteger = value => Number.isSafeInteger(value) && value > 0;
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const copy = value => Array.isArray(value) ? value.map(copy) : record(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value;
/** Exact byte length of an ASCII image data URI, without reading/encoding any bytes. */
export function encodedImageDataUriBytes(mimeType, sizeBytes) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) || !safePositiveInteger(sizeBytes)) return null;
  const length = `data:${mimeType};base64,`.length + 4 * Math.ceil(sizeBytes / 3);
  return Number.isSafeInteger(length) ? length : null;
}
/**
 * Pure, metadata-only validation. Caller must supply trusted managed-asset metadata.
 * Not proof of bytes, authorization, provider availability, or current lifecycle status.
 * asOf is explicit deterministic context and required for lifecycle-limited models.
 * Omission never pretends that the frozen review date is the current date.
 */
export function validateGenerationInput(input, options = {}) {
  const issues = [], warnings = [];
  const add = (code, path, message) => issues.push({ code, path, message });
  const unknown = (value, allowed, path) => {
    for (const key of Object.keys(value).sort()) if (!allowed.includes(key)) add('UNKNOWN_FIELD', [...path, key], 'This field is not supported; it will not be ignored.');

  };
  const finish = (profile, value) => deepFreeze({ ok: issues.length === 0, profileVersion: PROFILE_VERSION,
    ...(profile ? { profileId: profile.profileId } : {}), evaluatedAsOf: asOf,
    issues, warnings, ...(issues.length === 0 && value ? { value } : {}) });
  let asOf = null;
  if (!record(options) || !dataProperties(options)) { add('INVALID_OPTIONS', [], 'Options must be an object.'); return finish(); }
  unknown(options, ['asOf'], ['options']);
  if (own(options, 'asOf')) asOf = options.asOf;
  if (own(options, 'asOf') && !dateValid(asOf)) { add('INVALID_AS_OF_DATE', ['options', 'asOf'], 'Use an actual YYYY-MM-DD calendar date.'); asOf = null; }
  if (!record(input) || !dataProperties(input)) { add('INVALID_INPUT', [], 'Input must be a plain object.'); return finish(); }
  unknown(input, requestKeys, []);
  if (own(input, 'schemaVersion') && input.schemaVersion !== 1) add('UNSUPPORTED_SCHEMA_VERSION', ['schemaVersion'], 'Only schemaVersion 1 is supported.');
  if (!CAPABILITY_PROFILES.some(p => p.providerId === input.providerId)) add('UNKNOWN_PROVIDER', ['providerId'], 'Choose an implemented provider explicitly.');
  else if (!CAPABILITY_PROFILES.some(p => p.providerId === input.providerId && p.model === input.model)) add('UNSUPPORTED_MODEL', ['model'], 'Choose the exact implemented model explicitly.');
  else if (!getCapabilityProfile(input.providerId, input.model, input.region)) add('UNSUPPORTED_REGION', ['region'], 'Choose an explicit implemented account/API region; there is no fallback.');
  const profile = getCapabilityProfile(input.providerId, input.model, input.region);
  if (!Array.isArray(input.references)) add('INVALID_REFERENCES', ['references'], 'An explicit references array is required, including for text-only input.');
  else if (input.references.length > 8) add('REFERENCE_PAYLOAD_LIMIT', ['references'], 'At most eight reference records may be inspected.');
  else if (!referenceArray(input.references)) add('INVALID_REFERENCES', ['references'], 'References must be a plain dense array of data properties without extra keys.');
  if (input.parameters !== undefined && (!record(input.parameters) || !dataProperties(input.parameters))) add('INVALID_PARAMETERS', ['parameters'], 'Parameters must be a plain object.');
  if (typeof input.prompt !== 'string') add('INVALID_PROMPT', ['prompt'], 'Prompt must be a string.');
  if (!profile) return finish();
  if (typeof input.prompt === 'string' && ((profile.prompt.required && !input.prompt.trim()) || input.prompt.length > profile.prompt.maxCodeUnits)) add('INVALID_PROMPT', ['prompt'], 'Prompt is blank or exceeds the adapter UTF-16 code-unit limit.');
  if (!profile.aspectRatios.includes(input.aspectRatio)) add('UNSUPPORTED_ASPECT_RATIO', ['aspectRatio'], 'Choose an implemented aspect ratio.');
  if (!profile.durationsSeconds.includes(input.duration)) add('UNSUPPORTED_DURATION', ['duration'], 'Choose an implemented output duration in seconds.');
  if (record(input.parameters) && dataProperties(input.parameters)) {
    unknown(input.parameters, Object.keys(profile.parameters), ['parameters']);
    for (const [key, rule] of Object.entries(profile.parameters)) if (own(input.parameters, key)) {
      const value = input.parameters[key];
      if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.min || value > rule.max)) add('INVALID_PARAMETER', ['parameters', key], 'Parameter must be an integer within the implemented range.');
      if (rule.type === 'enum' && !rule.values.includes(value)) add('INVALID_PARAMETER', ['parameters', key], 'Parameter value is not implemented.');
    }
  }
  if (referenceArray(input.references)) {
    const refs = input.references, seen = new Set(), counts = new Map();
    if (refs.length < profile.inputs.minReferences || refs.length > profile.inputs.maxReferences) add('INVALID_REFERENCE_COUNT', ['references'], 'The current route accepts at most one first-frame image; Runway requires one.');
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index], path = ['references', index];
      if (!record(ref) || !dataProperties(ref)) { add('INVALID_REFERENCE', path, 'Every reference must be a plain object.'); continue; }
      unknown(ref, referenceKeys, path);
      if (!INPUT_ROLES.includes(ref.role)) add('UNKNOWN_INPUT_ROLE', [...path, 'role'], 'Unknown reference role; roles are never inferred.');
      else {
        counts.set(ref.role, (counts.get(ref.role) ?? 0) + 1);
        if (!profile.inputs.roles[ref.role].implemented) add('UNSUPPORTED_INPUT_ROLE', [...path, 'role'], 'This reference role is not implemented in the selected Mioon adapter.');
      }
      if (typeof ref.assetId !== 'string' || !ref.assetId.trim() || ref.assetId.length > 200) add('INVALID_ASSET_ID', [...path, 'assetId'], 'A bounded managed asset identity is required.');
      else if (seen.has(ref.assetId)) add('DUPLICATE_REFERENCE', [...path, 'assetId'], 'A reference asset cannot be repeated.');
      else seen.add(ref.assetId);
      if (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(ref.sha256)) add('INVALID_REFERENCE_HASH', [...path, 'sha256'], 'A managed-asset SHA-256 is required.');
      if (!own(ref, 'sizeBytes') || ref.sizeBytes === undefined || ref.sizeBytes === null) add('REFERENCE_METADATA_UNAVAILABLE', [...path, 'sizeBytes'], 'Managed reference byte size is unavailable; the server must resolve it before submission.');
      else if (!safePositiveInteger(ref.sizeBytes)) add('INVALID_REFERENCE_SIZE', [...path, 'sizeBytes'], 'Reference byte size must be a positive safe integer.');
      if (typeof ref.mimeType !== 'string') add('INVALID_REFERENCE_MIME', [...path, 'mimeType'], 'Exact MIME type is required.');
      for (const dimension of ['width', 'height']) if (own(ref, dimension) && !safePositiveInteger(ref[dimension])) add('INVALID_REFERENCE_DIMENSIONS', [...path, dimension], 'Image dimensions must be positive safe integers.');
      // All currently enabled roles are still images, never duration-bearing clips.
      if (own(ref, 'durationSeconds')) add('UNSUPPORTED_REFERENCE_DURATION', [...path, 'durationSeconds'], 'Reference clip durations are not accepted by any current route.');
      const constraints = INPUT_ROLES.includes(ref.role) ? profile.inputs.roles[ref.role] : null;
      if (!constraints?.implemented) continue;
      if (!constraints.mimeTypes.includes(ref.mimeType)) add('UNSUPPORTED_REFERENCE_MIME', [...path, 'mimeType'], 'Reference MIME type is not implemented for this role.');
      if (safePositiveInteger(ref.sizeBytes) && ref.sizeBytes > constraints.maxBytes) add('REFERENCE_TOO_LARGE', [...path, 'sizeBytes'], 'Reference exceeds the current Mioon input byte limit.');
      const encoded = encodedImageDataUriBytes(ref.mimeType, ref.sizeBytes);
      if (constraints.maxDataUriBytes && encoded !== null && encoded > constraints.maxDataUriBytes) add('REFERENCE_DATA_URI_TOO_LARGE', [...path, 'sizeBytes'], 'The full encoded data URI exceeds the adapter limit.');
      const dims = constraints.dimensions;
      if (dims) {
        if (![ref.width, ref.height].every(value => safePositiveInteger(value) && value >= dims.min && (dims.max === null || value <= dims.max))) add('INVALID_REFERENCE_DIMENSIONS', path, 'Reference dimensions are missing or outside the implemented range.');
        if (dims.matchAspectRatio && profile.aspectRatios.includes(input.aspectRatio) && [ref.width, ref.height].every(safePositiveInteger)) {
          const [width, height] = input.aspectRatio.split(':').map(BigInt);
          if (BigInt(ref.width) * height !== BigInt(ref.height) * width) add('REFERENCE_ASPECT_RATIO_MISMATCH', path, 'Reference dimensions must exactly match the selected aspect ratio; no automatic crop occurs.');
        }
      }
    }
    for (const [role, count] of counts) if (count > profile.inputs.roles[role].max) add('ROLE_COUNT_EXCEEDED', ['references'], 'A role exceeds its implemented count limit.');
    const selectedRoles = refs.map(ref => record(ref) && dataProperties(ref) && typeof ref.role === 'string' ? ref.role : null).sort();
    if (!profile.inputs.combinations.some(combination => combination.length === selectedRoles.length && [...combination].sort().every((role, index) => role === selectedRoles[index]))) add('UNSUPPORTED_ROLE_COMBINATION', ['references'], 'The complete reference combination is unsupported; no references will be dropped.');
    if (profile.simulationOnly) warnings.push({ code: 'MOCK_REFERENCE_NOT_RENDERED', message: 'Mock preserves reference metadata for workflow simulation. Its moving test pattern does not depict the image or prompt.' });
  }
  const lifecycle = evaluateCapabilityLifecycle(profile, own(options, 'asOf') ? { asOf: options.asOf } : {});
  // Invalid dates were already reported above.
  issues.push(...lifecycle.issues.filter(issue => issue.code !== 'INVALID_AS_OF_DATE'));
  warnings.push(...lifecycle.warnings);
  return finish(profile, issues.length ? undefined : copy({ ...input, parameters: input.parameters ?? {} }));
}
/** Pure bridge for existing first-frame-only adapters. No managed paths or network. */
export function buildAdapterPlan(input, options) {
  const result = validateGenerationInput(input, options);
  if (!result.ok) return result;
  const value = result.value;
  return deepFreeze({ ...result,
    selection: { providerId: value.providerId, model: value.model, region: value.region },
    referenceBindings: value.references.map(ref => ({ role: ref.role, assetId: ref.assetId, sha256: ref.sha256 })),
    adapterSnapshot: {
      model: value.model, prompt: value.prompt, aspectRatio: value.aspectRatio, duration: value.duration, parameters: copy(value.parameters),
      referenceAssets: value.references.map(({ role, assetId, ...metadata }) => ({ id: assetId, ...metadata })),
    },
  });
}

/** Advisory only: authoritative callers provide their current trusted UTC date. */
export function evaluateCapabilityLifecycle(profile, options = {}) {
  const issues = [], warnings = [];
  const add = (code, path, message) => issues.push({ code, path, message });
  let evaluatedAsOf = null;
  if (!record(options) || !dataProperties(options)) add('INVALID_OPTIONS', ['options'], 'Options must be a plain object.');
  else {
    for (const key of Object.keys(options)) if (key !== 'asOf') add('UNKNOWN_FIELD', ['options', key], 'This field is not supported; it will not be ignored.');
    if (own(options, 'asOf')) {
      if (dateValid(options.asOf)) evaluatedAsOf = options.asOf;
      else add('INVALID_AS_OF_DATE', ['options', 'asOf'], 'Use an actual YYYY-MM-DD calendar date.');
    }
  }
  // Accept only a canonical profile: arbitrary vendor metadata cannot add routes.
  const known = record(profile) && dataProperties(profile) ? CAPABILITY_PROFILES.find(item => item.profileId === profile.profileId && profile.profileVersion === PROFILE_VERSION && item.providerId === profile.providerId && item.model === profile.model) : null;
  if (!known) add('UNKNOWN_INPUT_PROFILE', ['profile'], 'An exact implemented Mioon input profile is required.');
  else if (known.lifecycle) {
    if (!record(options) || !own(options, 'asOf')) add('AS_OF_DATE_REQUIRED', ['options', 'asOf'], 'Supply the current server UTC date when checking a lifecycle-limited model.');
    warnings.push({ code: 'MODEL_LIFECYCLE_WARNING', message: 'The implemented Veo preview is listed for retirement no earlier than 2026-10-22. New submissions require profile review from that date; no model is substituted.', source: known.lifecycle.source, checkedOn: known.lifecycle.checkedOn });
    if (evaluatedAsOf && evaluatedAsOf >= known.lifecycle.earliestShutdownDate) add('MODEL_LIFECYCLE_REVALIDATION_REQUIRED', ['model'], 'The documented earliest retirement date has arrived. Revalidate and revise the profile before new submission; no automatic model replacement.');
  }
  return deepFreeze({ ok: issues.length === 0, evaluatedAsOf, issues, warnings });
}

/**
 * Bridge for existing shot/snapshot callers. This does not look up assets and
 * never shortens a requested selection. Backend callers still resolve ownership
 * and frozen identity before invoking the pure canonical validator.
 */
export function getGenerationProfileIssue(snapshot, capabilities) {
  const issue = (code, message, path = []) => ({ code, message, path });
  if (!record(snapshot) || !dataProperties(snapshot) || !record(capabilities) || !dataProperties(capabilities)) return issue('INVALID_INPUT', '生成输入和供应商能力必须为普通数据对象');
  if (capabilities.inputProfileVersion !== PROFILE_VERSION) return issue('UNKNOWN_INPUT_PROFILE', '供应商输入配置版本缺失或不受支持');
  if (!dateValid(capabilities.profileEvaluationDate)) return issue('INVALID_AS_OF_DATE', '缺少有效的服务器 UTC 输入检查日期');
  if (!referenceArray(capabilities.inputProfiles)) return issue('UNKNOWN_INPUT_PROFILE', '供应商输入配置缺失或无效');
  const model = snapshot.model;
  const region = getGenerationProfileRegion(capabilities.id, capabilities);
  if (!region || capabilities.providerRegion !== region) return issue('UNSUPPORTED_REGION', '供应商服务器区域缺失或不受支持');
  if (snapshot.providerId !== undefined && snapshot.providerId !== capabilities.id) return issue('UNKNOWN_PROVIDER', '任务供应商与所选供应商不一致');
  if (snapshot.providerRegion !== undefined && snapshot.providerRegion !== region) return issue('PROVIDER_REGION_CHANGED', '供应商账户区域已更改，请恢复此任务原有区域后继续');
  const profile = getCapabilityProfile(capabilities.id, model, region);
  const advertised = capabilities.inputProfiles.find(item => record(item) && dataProperties(item) && item.profileId === profile?.profileId && item.profileVersion === PROFILE_VERSION && item.providerId === capabilities.id && item.model === model && referenceArray(item.regions) && item.regions.includes(region));
  if (!profile || !advertised) return issue('UNKNOWN_INPUT_PROFILE', '所选模型和服务器区域没有已实现的输入配置');
  if (snapshot.inputProfileVersion !== undefined && snapshot.inputProfileVersion !== PROFILE_VERSION || snapshot.inputProfileId !== undefined && snapshot.inputProfileId !== profile.profileId) return issue('UNKNOWN_INPUT_PROFILE', '冻结任务的输入配置已不受支持');
  const assets = snapshot.referenceAssets ?? [];
  if (!referenceArray(assets)) return issue('INVALID_REFERENCES', '参考素材必须为完整且有界的数组', ['referenceAssets']);
  const ids = snapshot.referenceAssetIds === undefined ? assets.map(asset => record(asset) && dataProperties(asset) ? asset.id : undefined) : snapshot.referenceAssetIds;
  if (!referenceArray(ids)) return issue('INVALID_REFERENCES', '参考素材 ID 必须为完整且有界的数组', ['referenceAssetIds']);
  if (ids.length !== assets.length || assets.some((asset, index) => !record(asset) || !dataProperties(asset) || asset.id !== ids[index])) return issue('REFERENCE_METADATA_UNAVAILABLE', '参考素材元数据缺失或与完整选择不一致，无法提交', ['referenceAssets']);
  const bindings = snapshot.referenceBindings;
  if (bindings !== undefined && (!referenceArray(bindings) || bindings.length !== ids.length || bindings.some((binding, index) => !record(binding) || !dataProperties(binding) || binding.assetId !== ids[index] || binding.sha256 !== assets[index].sha256 || Object.keys(binding).some(key => !['role', 'assetId', 'sha256'].includes(key))))) return issue('REFERENCE_BINDING_MISMATCH', '冻结参考角色与完整素材选择不一致', ['referenceBindings']);
  const connections = snapshot.referenceConnections;
  if (connections !== undefined && (!referenceArray(connections) || connections.length > 1 || connections.some(connection => !record(connection) || !dataProperties(connection) || connection.role !== 'first_frame' || ids.length !== 1 || connection.sourceAssetId !== ids[0]))) return issue('REFERENCE_BINDING_MISMATCH', '首帧连线与完整素材选择不一致', ['referenceConnections']);
  if (bindings && assets.some((asset, index) => own(asset, 'role') && asset.role !== bindings[index].role)) return issue('REFERENCE_BINDING_MISMATCH', '参考素材角色与冻结绑定不一致', ['referenceBindings']);
  const input = {
    providerId: capabilities.id, model, region,
    prompt: snapshot.prompt, aspectRatio: snapshot.aspectRatio, duration: snapshot.duration,
    parameters: snapshot.parameters ?? {},
    references: assets.map((asset, index) => ({
      role: bindings ? bindings[index].role : own(asset, 'role') ? asset.role : 'first_frame',
      assetId: ids[index], mimeType: asset.mimeType, sha256: asset.sha256,
      ...(own(asset, 'durationSeconds') || own(asset, 'duration') && asset.duration !== 0 ? { durationSeconds: asset.durationSeconds ?? asset.duration } : {}),
      ...(asset.sizeBytes === undefined ? {} : { sizeBytes: asset.sizeBytes }),
      ...(asset.width === undefined ? {} : { width: asset.width }),
      ...(asset.height === undefined ? {} : { height: asset.height }),
    })),
  };
  return validateGenerationInput(input, { asOf: capabilities.profileEvaluationDate }).issues[0] ?? null;
}
