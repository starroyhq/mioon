import { CAPABILITY_PROFILES, ARCHIVED_CAPABILITY_PROFILES, INPUT_ROLES, PROFILE_VERSION, deepFreeze, getCapabilityProfile, getGenerationProfileRegion, type GenerationInputProfile, type ImplementedGenerationInputRole } from './generation-input-profiles.ts';
import {getSubjectGenerationSnapshotIssue, type SubjectGenerationIssue} from './subject-generation.ts';
export interface GenerationValidationIssue {code: string; path: (string | number)[]; message: string}
export interface GenerationValidationWarning {code: string; message: string; source?: string; checkedOn?: string}
export interface GenerationReferenceInput {role: string; assetId: string; mimeType: string; sha256: string; sizeBytes?: number; width?: number; height?: number; durationSeconds?: number}
export interface ValidatedGenerationInput {
  schemaVersion?: number;
  providerId: string;
  model: string;
  region: string;
  prompt: string;
  aspectRatio: string;
  duration: number;
  references: GenerationReferenceInput[];
  parameters: Record<string, unknown>;
}
export interface GenerationValidationFailure {
  ok: false;
  profileVersion: string;
  profileId?: string;
  evaluatedAsOf: string | null;
  issues: GenerationValidationIssue[];
  warnings: GenerationValidationWarning[];
}
export interface GenerationValidationSuccess {
  ok: true;
  profileVersion: string;
  profileId?: string;
  evaluatedAsOf: string | null;
  issues: GenerationValidationIssue[];
  warnings: GenerationValidationWarning[];
  value: ValidatedGenerationInput;
}
export type GenerationValidationResult = GenerationValidationSuccess | GenerationValidationFailure;
export interface AdapterSelection {providerId: string; model: string; region: string}
export interface AdapterReferenceBinding {role: string; assetId: string; sha256: string}
export interface AdapterSnapshot {
  model: string;
  prompt: string;
  aspectRatio: string;
  duration: number;
  parameters: Record<string, unknown>;
  referenceAssets: Record<string, unknown>[];
}
export interface AdapterPlanSuccess extends GenerationValidationSuccess {
  selection: AdapterSelection;
  referenceBindings: AdapterReferenceBinding[];
  adapterSnapshot: AdapterSnapshot;
}
export type AdapterPlanResult = AdapterPlanSuccess | GenerationValidationFailure;
export interface LifecycleEvaluation {
  ok: boolean;
  evaluatedAsOf: string | null;
  issues: GenerationValidationIssue[];
  warnings: GenerationValidationWarning[];
}
export interface GenerationProfileIssue {code: string; message: string; path: (string | number)[]}

const requestKeys = ['schemaVersion', 'providerId', 'model', 'region', 'prompt', 'aspectRatio', 'duration', 'references', 'parameters'];
const referenceKeys = ['role', 'assetId', 'mimeType', 'sizeBytes', 'sha256', 'width', 'height', 'durationSeconds'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value: unknown, key: PropertyKey): boolean => Object.hasOwn(value as object, key);
const dataProperties = (value: unknown): boolean => !Object.getOwnPropertySymbols(value as object).length && Object.values(Object.getOwnPropertyDescriptors(value as object)).every(d => !d.get && !d.set && d.enumerable);
const referenceArray = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 8) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  return keys.length === value.length + 1 && keys.every(key => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length && !descriptors[key].get && !descriptors[key].set && descriptors[key].enumerable));
};
const safePositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const dateValid = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const copy = (value: unknown): unknown => Array.isArray(value) ? (value as unknown[]).map((item: unknown) => copy(item)) : record(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value;
const imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];
/** Exact byte length of an ASCII image data URI, without reading/encoding any bytes. */
export function encodedImageDataUriBytes(mimeType: unknown, sizeBytes: unknown): number | null {
  if (typeof mimeType !== 'string' || !imageMimeTypes.includes(mimeType) || !safePositiveInteger(sizeBytes)) return null;
  const length = `data:${mimeType};base64,`.length + 4 * Math.ceil(sizeBytes / 3);
  return Number.isSafeInteger(length) ? length : null;
}
/**
 * Pure, metadata-only validation. Caller must supply trusted managed-asset metadata.
 * Not proof of bytes, authorization, provider availability, or current lifecycle status.
 * asOf is explicit deterministic context and required for lifecycle-limited models.
 * Omission never pretends that the frozen review date is the current date.
 */
export function validateGenerationInput(input: unknown, options: unknown = {}): GenerationValidationResult {
  const issues: GenerationValidationIssue[] = [], warnings: GenerationValidationWarning[] = [];
  const add = (code: string, path: (string | number)[], message: string) => { issues.push({ code, path, message }); };
  const unknown = (value: unknown, allowed: readonly string[], path: (string | number)[]) => {
    for (const key of Object.keys(value as object).sort()) if (!allowed.includes(key)) add('UNKNOWN_FIELD', [...path, key], 'This field is not supported; it will not be ignored.');

  };
  const finish = (profile?: GenerationInputProfile | null, value?: ValidatedGenerationInput): GenerationValidationResult => deepFreeze({ ok: issues.length === 0, profileVersion: profile?.profileVersion ?? PROFILE_VERSION,
    ...(profile ? { profileId: profile.profileId } : {}), evaluatedAsOf: asOf,
    issues, warnings, ...(issues.length === 0 && value ? { value } : {}) }) as GenerationValidationResult;
  let asOf: string | null = null;
  if (!record(options) || !dataProperties(options)) { add('INVALID_OPTIONS', [], 'Options must be an object.'); return finish(); }
  const optionRecord = options as Record<string, unknown>;
  unknown(optionRecord, ['asOf', 'profileId', 'profileVersion'], ['options']);
  const hasPin = own(optionRecord, 'profileId') || own(optionRecord, 'profileVersion');
  const pin = hasPin ? { profileId: optionRecord.profileId, profileVersion: optionRecord.profileVersion } : undefined;
  if (hasPin && (!own(optionRecord, 'profileId') || !own(optionRecord, 'profileVersion'))) add('UNKNOWN_INPUT_PROFILE', ['options'], 'An exact complete profile identity and version are required.');
  if (own(optionRecord, 'asOf')) asOf = (optionRecord.asOf ?? null) as string | null;
  if (own(optionRecord, 'asOf') && !dateValid(asOf)) { add('INVALID_AS_OF_DATE', ['options', 'asOf'], 'Use an actual YYYY-MM-DD calendar date.'); asOf = null; }
  if (!record(input) || !dataProperties(input)) { add('INVALID_INPUT', [], 'Input must be a plain object.'); return finish(); }
  const request = input as Record<string, unknown>;
  unknown(request, requestKeys, []);
  if (own(request, 'schemaVersion') && request.schemaVersion !== 1) add('UNSUPPORTED_SCHEMA_VERSION', ['schemaVersion'], 'Only schemaVersion 1 is supported.');
  if (!CAPABILITY_PROFILES.some(p => p.providerId === request.providerId)) add('UNKNOWN_PROVIDER', ['providerId'], 'Choose an implemented provider explicitly.');
  else if (!CAPABILITY_PROFILES.some(p => p.providerId === request.providerId && p.model === request.model)) add('UNSUPPORTED_MODEL', ['model'], 'Choose the exact implemented model explicitly.');
  else if (!getCapabilityProfile(request.providerId, request.model, request.region)) add('UNSUPPORTED_REGION', ['region'], 'Choose an explicit implemented account/API region; there is no fallback.');
  const profile = getCapabilityProfile(request.providerId, request.model, request.region, pin);
  if (hasPin && !profile) add('UNKNOWN_INPUT_PROFILE', ['options'], 'The exact frozen input profile is not supported; no current-profile fallback is allowed.');
  if (!Array.isArray(request.references)) add('INVALID_REFERENCES', ['references'], 'An explicit references array is required, including for text-only input.');
  else if ((request.references as unknown[]).length > 8) add('REFERENCE_PAYLOAD_LIMIT', ['references'], 'At most eight reference records may be inspected.');
  else if (!referenceArray(request.references)) add('INVALID_REFERENCES', ['references'], 'References must be a plain dense array of data properties without extra keys.');
  if (request.parameters !== undefined && (!record(request.parameters) || !dataProperties(request.parameters))) add('INVALID_PARAMETERS', ['parameters'], 'Parameters must be a plain object.');
  if (typeof request.prompt !== 'string') add('INVALID_PROMPT', ['prompt'], 'Prompt must be a string.');
  if (!profile) return finish();
  if (typeof request.prompt === 'string' && ((profile.prompt.required && !request.prompt.trim()) || request.prompt.length > profile.prompt.maxCodeUnits)) add('INVALID_PROMPT', ['prompt'], 'Prompt is blank or exceeds the adapter UTF-16 code-unit limit.');
  if (!profile.aspectRatios.includes(request.aspectRatio as string)) add('UNSUPPORTED_ASPECT_RATIO', ['aspectRatio'], 'Choose an implemented aspect ratio.');
  if (!profile.durationsSeconds.includes(request.duration as number)) add('UNSUPPORTED_DURATION', ['duration'], 'Choose an implemented output duration in seconds.');
  if (record(request.parameters) && dataProperties(request.parameters)) {
    unknown(request.parameters, Object.keys(profile.parameters), ['parameters']);
    for (const [key, rule] of Object.entries(profile.parameters)) if (own(request.parameters, key)) {
      const value = request.parameters[key];
      if (rule.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < rule.min || value > rule.max)) add('INVALID_PARAMETER', ['parameters', key], 'Parameter must be an integer within the implemented range.');
      if (rule.type === 'enum' && !rule.values.includes(value as string)) add('INVALID_PARAMETER', ['parameters', key], 'Parameter value is not implemented.');
    }
  }
  if (referenceArray(request.references)) {
    const refs = request.references, seen = new Set<string>(), counts = new Map<string, number>();
    const typedTail = refs.some(ref => record(ref) && dataProperties(ref) && ref.role === 'last_frame');
    const framePairs = profile.inputs.roles.last_frame.implemented;
    const maxReferences = framePairs && !typedTail ? 1 : profile.inputs.maxReferences;
    if (refs.length < profile.inputs.minReferences || refs.length > maxReferences) add('INVALID_REFERENCE_COUNT', ['references'], typedTail && framePairs ? 'This route accepts text, one first-frame image, or one first-frame and one last-frame image.' : 'The current route accepts at most one first-frame image; Runway requires one.');
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index], path = ['references', index];
      if (!record(ref) || !dataProperties(ref)) { add('INVALID_REFERENCE', path, 'Every reference must be a plain object.'); continue; }
      const reference = ref as Record<string, unknown>;
      unknown(reference, referenceKeys, path);
      if (!(INPUT_ROLES as readonly string[]).includes(reference.role as string)) add('UNKNOWN_INPUT_ROLE', [...path, 'role'], 'Unknown reference role; roles are never inferred.');
      else {
        const role = reference.role as string;
        counts.set(role, (counts.get(role) ?? 0) + 1);
        if (!profile.inputs.roles[role].implemented) add('UNSUPPORTED_INPUT_ROLE', [...path, 'role'], 'This reference role is not implemented in the selected Mioon adapter.');
      }
      if (typeof reference.assetId !== 'string' || !reference.assetId.trim() || reference.assetId.length > 200) add('INVALID_ASSET_ID', [...path, 'assetId'], 'A bounded managed asset identity is required.');
      else if (seen.has(reference.assetId)) add('DUPLICATE_REFERENCE', [...path, 'assetId'], 'A reference asset cannot be repeated.');
      else seen.add(reference.assetId);
      if (typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(reference.sha256)) add('INVALID_REFERENCE_HASH', [...path, 'sha256'], 'A managed-asset SHA-256 is required.');
      if (!own(reference, 'sizeBytes') || reference.sizeBytes === undefined || reference.sizeBytes === null) add('REFERENCE_METADATA_UNAVAILABLE', [...path, 'sizeBytes'], 'Managed reference byte size is unavailable; the server must resolve it before submission.');
      else if (!safePositiveInteger(reference.sizeBytes)) add('INVALID_REFERENCE_SIZE', [...path, 'sizeBytes'], 'Reference byte size must be a positive safe integer.');
      if (typeof reference.mimeType !== 'string') add('INVALID_REFERENCE_MIME', [...path, 'mimeType'], 'Exact MIME type is required.');
      for (const dimension of ['width', 'height']) if (own(reference, dimension) && !safePositiveInteger(reference[dimension])) add('INVALID_REFERENCE_DIMENSIONS', [...path, dimension], 'Image dimensions must be positive safe integers.');
      // All currently enabled roles are still images, never duration-bearing clips.
      if (own(reference, 'durationSeconds')) add('UNSUPPORTED_REFERENCE_DURATION', [...path, 'durationSeconds'], 'Reference clip durations are not accepted by any current route.');
      const constraints = (INPUT_ROLES as readonly string[]).includes(reference.role as string) ? profile.inputs.roles[reference.role as string] : null;
      if (!constraints?.implemented) continue;
      const limits = constraints as ImplementedGenerationInputRole;
      if (!limits.mimeTypes.includes(reference.mimeType as string)) add('UNSUPPORTED_REFERENCE_MIME', [...path, 'mimeType'], 'Reference MIME type is not implemented for this role.');
      if (safePositiveInteger(reference.sizeBytes) && reference.sizeBytes > limits.maxBytes) add('REFERENCE_TOO_LARGE', [...path, 'sizeBytes'], 'Reference exceeds the current Mioon input byte limit.');
      const encoded = encodedImageDataUriBytes(reference.mimeType, reference.sizeBytes);
      if (limits.maxDataUriBytes && encoded !== null && encoded > limits.maxDataUriBytes) add('REFERENCE_DATA_URI_TOO_LARGE', [...path, 'sizeBytes'], 'The full encoded data URI exceeds the adapter limit.');
      const dims = limits.dimensions;
      if (dims) {
        if (![reference.width, reference.height].every(value => safePositiveInteger(value) && value >= dims.min && (dims.max === null || value <= dims.max))) add('INVALID_REFERENCE_DIMENSIONS', path, 'Reference dimensions are missing or outside the implemented range.');
        if (dims.matchAspectRatio && profile.aspectRatios.includes(request.aspectRatio as string) && [reference.width, reference.height].every(safePositiveInteger)) {
          const [width, height] = (request.aspectRatio as string).split(':').map(BigInt);
          if (BigInt(reference.width as number) * height !== BigInt(reference.height as number) * width) add('REFERENCE_ASPECT_RATIO_MISMATCH', path, 'Reference dimensions must exactly match the selected aspect ratio; no automatic crop occurs.');
        }
        if ([reference.width, reference.height].every(safePositiveInteger) &&
            (dims.minAspectRatio !== undefined && (reference.width as number) / (reference.height as number) < dims.minAspectRatio || dims.maxAspectRatio !== undefined && (reference.width as number) / (reference.height as number) > dims.maxAspectRatio)) add('REFERENCE_ASPECT_RATIO_OUT_OF_RANGE', path, 'Reference image aspect ratio is outside the implemented range.');
      }
    }
    for (const [role, count] of counts) if (count > profile.inputs.roles[role].max) add('ROLE_COUNT_EXCEEDED', ['references'], 'A role exceeds its implemented count limit.');
    const selectedRoles = refs.map(ref => record(ref) && dataProperties(ref) && typeof ref.role === 'string' ? ref.role : null).sort();
    if (!profile.inputs.combinations.some(combination => combination.length === selectedRoles.length && [...combination].sort().every((role, index) => role === selectedRoles[index]))) add('UNSUPPORTED_ROLE_COMBINATION', ['references'], 'The complete reference combination is unsupported; no references will be dropped.');
    if (refs.length === 2 && selectedRoles.includes('last_frame') && refs.every(ref => record(ref) && dataProperties(ref)) && ((refs[0] as Record<string, unknown>).role !== 'first_frame' || (refs[1] as Record<string, unknown>).role !== 'last_frame')) add('INVALID_REFERENCE_ORDER', ['references'], 'The complete frame manifest must be ordered first_frame, then last_frame; role labels are required.');
    if (profile.simulationOnly) warnings.push({ code: 'MOCK_REFERENCE_NOT_RENDERED', message: 'Mock preserves reference metadata for workflow simulation. Its moving test pattern does not depict the image or prompt.' });
  }
  const lifecycle = evaluateCapabilityLifecycle(profile, own(optionRecord, 'asOf') ? { asOf: optionRecord.asOf } : {});
  // Invalid dates were already reported above.
  issues.push(...lifecycle.issues.filter(issue => issue.code !== 'INVALID_AS_OF_DATE'));
  warnings.push(...lifecycle.warnings);
  return finish(profile, issues.length ? undefined : copy({ ...request, parameters: request.parameters ?? {} }) as ValidatedGenerationInput);
}
/** Pure exact-profile bridge. New frame roles remain explicit; legacy bytes stay unchanged. */
export function buildAdapterPlan(input: unknown, options?: unknown): AdapterPlanResult {
  const result = validateGenerationInput(input, options);
  if (!result.ok) return result;
  const value = result.value;
  return deepFreeze({ ...result,
    selection: { providerId: value.providerId, model: value.model, region: value.region },
    referenceBindings: value.references.map(ref => ({ role: ref.role, assetId: ref.assetId, sha256: ref.sha256 })),
    adapterSnapshot: {
      model: value.model, prompt: value.prompt, aspectRatio: value.aspectRatio, duration: value.duration, parameters: copy(value.parameters) as Record<string, unknown>,
      referenceAssets: value.references.map(({ role, assetId, ...metadata }) => ({ id: assetId, ...(result.profileVersion !== PROFILE_VERSION ? { role } : {}), ...metadata })),
    },
  }) as AdapterPlanSuccess;
}

/** Advisory only: authoritative callers provide their current trusted UTC date. */
export function evaluateCapabilityLifecycle(profile: unknown, options: unknown = {}): LifecycleEvaluation {
  const issues: GenerationValidationIssue[] = [], warnings: GenerationValidationWarning[] = [];
  const add = (code: string, path: (string | number)[], message: string) => { issues.push({ code, path, message }); };
  let evaluatedAsOf: string | null = null;
  if (!record(options) || !dataProperties(options)) add('INVALID_OPTIONS', ['options'], 'Options must be a plain object.');
  else {
    const optionRecord = options as Record<string, unknown>;
    for (const key of Object.keys(optionRecord)) if (key !== 'asOf') add('UNKNOWN_FIELD', ['options', key], 'This field is not supported; it will not be ignored.');
    if (own(optionRecord, 'asOf')) {
      if (dateValid(optionRecord.asOf)) evaluatedAsOf = optionRecord.asOf;
      else add('INVALID_AS_OF_DATE', ['options', 'asOf'], 'Use an actual YYYY-MM-DD calendar date.');
    }
  }
  // Accept only a canonical profile: arbitrary vendor metadata cannot add routes.
  const known = record(profile) && dataProperties(profile) ? [...CAPABILITY_PROFILES, ...ARCHIVED_CAPABILITY_PROFILES].find(item => item.profileId === profile.profileId && profile.profileVersion === item.profileVersion && item.providerId === profile.providerId && item.model === profile.model) : null;
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
export function getGenerationProfileIssue(snapshot: unknown, capabilities: unknown): GenerationProfileIssue | null {
  const issue = (code: string, message: string, path: (string | number)[] = []): GenerationProfileIssue => ({ code, message, path });
  if (!record(snapshot) || !dataProperties(snapshot) || !record(capabilities) || !dataProperties(capabilities)) return issue('INVALID_INPUT', '生成输入和供应商能力必须为普通数据对象');
  const frozen = snapshot as Record<string, unknown>, caps = capabilities as Record<string, unknown>;
  const subjectIssue = getSubjectGenerationSnapshotIssue(frozen);
  if (subjectIssue) return subjectIssue;
  if (caps.inputProfileVersion !== PROFILE_VERSION) return issue('UNKNOWN_INPUT_PROFILE', '供应商输入配置版本缺失或不受支持');
  if (!dateValid(caps.profileEvaluationDate)) return issue('INVALID_AS_OF_DATE', '缺少有效的服务器 UTC 输入检查日期');
  if (!referenceArray(caps.inputProfiles)) return issue('UNKNOWN_INPUT_PROFILE', '供应商输入配置缺失或无效');
  const inputProfiles = caps.inputProfiles;
  const model = frozen.model;
  const region = getGenerationProfileRegion(caps.id, caps);
  if (!region || caps.providerRegion !== region) return issue('UNSUPPORTED_REGION', '供应商服务器区域缺失或不受支持');
  if (frozen.providerId !== undefined && frozen.providerId !== caps.id) return issue('UNKNOWN_PROVIDER', '任务供应商与所选供应商不一致');
  if (frozen.providerRegion !== undefined && frozen.providerRegion !== region) return issue('PROVIDER_REGION_CHANGED', '供应商账户区域已更改，请恢复此任务原有区域后继续');
  const active = getCapabilityProfile(caps.id, model, region);
  const advertised = inputProfiles.filter(item => record(item) && dataProperties(item) && item.providerId === caps.id && item.model === model && referenceArray(item.regions) && item.regions.includes(region));
  const advertisedMatch = advertised[0] as Record<string, unknown> | undefined;
  if (!active || advertised.length !== 1 || !advertisedMatch || advertisedMatch.profileId !== active.profileId || advertisedMatch.profileVersion !== active.profileVersion) return issue('UNKNOWN_INPUT_PROFILE', '所选模型和服务器区域没有唯一已实现的输入配置');
  const hasPin = own(frozen, 'inputProfileVersion') || own(frozen, 'inputProfileId');
  if (hasPin && !['inputProfileVersion', 'inputProfileId', 'providerRegion', 'referenceBindings'].every(key => own(frozen, key))) return issue('UNKNOWN_INPUT_PROFILE', '冻结任务必须包含完整的输入配置身份、区域和角色');
  const profile = hasPin ? getCapabilityProfile(caps.id, model, region, {profileId:frozen.inputProfileId, profileVersion:frozen.inputProfileVersion}) : active;
  if (!profile) return issue('UNKNOWN_INPUT_PROFILE', '冻结任务的输入配置已不受支持');
  const assets = frozen.referenceAssets ?? [];
  if (!referenceArray(assets)) return issue('INVALID_REFERENCES', '参考素材必须为完整且有界的数组', ['referenceAssets']);
  const referenceIds = frozen.referenceAssetIds;
  const ids = referenceIds === undefined ? assets.map(asset => record(asset) && dataProperties(asset) ? asset.id : undefined) : referenceIds;
  if (!referenceArray(ids)) return issue('INVALID_REFERENCES', '参考素材 ID 必须为完整且有界的数组', ['referenceAssetIds']);
  if (ids.length !== assets.length || assets.some((asset, index) => !record(asset) || !dataProperties(asset) || asset.id !== ids[index])) return issue('REFERENCE_METADATA_UNAVAILABLE', '参考素材元数据缺失或与完整选择不一致，无法提交', ['referenceAssets']);
  const bindings = frozen.referenceBindings;
  if (bindings !== undefined && (!referenceArray(bindings) || bindings.length !== ids.length || bindings.some((binding, index) => !record(binding) || !dataProperties(binding) || binding.assetId !== ids[index] || binding.sha256 !== (assets[index] as Record<string, unknown>).sha256 || Object.keys(binding).some(key => !['role', 'assetId', 'sha256'].includes(key))))) return issue('REFERENCE_BINDING_MISMATCH', '冻结参考角色与完整素材选择不一致', ['referenceBindings']);
  const boundBindings = bindings as Record<string, unknown>[] | undefined;
  const connections = frozen.referenceConnections;
  const completePair = boundBindings?.length === 2 && boundBindings[0].role === 'first_frame' && boundBindings[1].role === 'last_frame';
  if (connections !== undefined && (!referenceArray(connections) || connections.length > 1 || connections.some(connection => !record(connection) || !dataProperties(connection) || connection.role !== 'first_frame' || (ids.length !== 1 && !completePair) || connection.sourceAssetId !== ids[0] || (boundBindings !== undefined && boundBindings[0]?.role !== 'first_frame')))) return issue('REFERENCE_BINDING_MISMATCH', '首帧连线与完整素材选择不一致', ['referenceConnections']);
  const assetRecords = assets as Record<string, unknown>[];
  if (boundBindings && assetRecords.some((asset, index) => own(asset, 'role') && asset.role !== boundBindings[index].role)) return issue('REFERENCE_BINDING_MISMATCH', '参考素材角色与冻结绑定不一致', ['referenceBindings']);
  if (hasPin && profile.inputs.roles.subject_reference.implemented && assetRecords.some((asset,index) => !own(asset,'role') || asset.role !== boundBindings![index].role)) return issue('REFERENCE_BINDING_MISMATCH', 'v3 冻结参考素材必须显式包含与绑定一致的角色', ['referenceAssets']);
  // A pair must carry complete typed bindings. A second array element never
  // acquires last-frame semantics merely from its position.
  const pair = assetRecords.some((asset, index) => (boundBindings ? boundBindings[index].role : asset.role) === 'last_frame');
  if (pair && (!boundBindings || boundBindings.length !== 2 || boundBindings[0].role !== 'first_frame' || boundBindings[1].role !== 'last_frame')) return issue('REFERENCE_BINDING_MISMATCH', '首尾帧必须包含完整且按首尾顺序固定的角色绑定', ['referenceBindings']);
  if (own(frozen, 'lastFrameAssetId') && frozen.lastFrameAssetId !== null && (!pair || frozen.lastFrameAssetId !== ids[1])) return issue('REFERENCE_BINDING_MISMATCH', '尾帧选择与完整冻结角色不一致', ['lastFrameAssetId']);
  if (own(frozen, 'lastFrameAssetId') && frozen.lastFrameAssetId === null && pair) return issue('REFERENCE_BINDING_MISMATCH', '已清除的尾帧不能出现在冻结角色中', ['lastFrameAssetId']);
  const input = {
    providerId: caps.id, model, region,
    prompt: frozen.prompt, aspectRatio: frozen.aspectRatio, duration: frozen.duration,
    parameters: frozen.parameters ?? {},
    references: assetRecords.map((asset, index) => ({
      role: boundBindings ? boundBindings[index].role : own(asset, 'role') ? asset.role : 'first_frame',
      assetId: ids[index], mimeType: asset.mimeType, sha256: asset.sha256,
      ...(own(asset, 'durationSeconds') || own(asset, 'duration') && asset.duration !== 0 ? { durationSeconds: asset.durationSeconds ?? asset.duration } : {}),
      ...(asset.sizeBytes === undefined ? {} : { sizeBytes: asset.sizeBytes }),
      ...(asset.width === undefined ? {} : { width: asset.width }),
      ...(asset.height === undefined ? {} : { height: asset.height }),
    })),
  };
  return validateGenerationInput(input, { asOf: caps.profileEvaluationDate, profileId:profile.profileId, profileVersion:profile.profileVersion }).issues[0] ?? null;
}
