import { message } from '../../../packages/i18n/src/index.ts';
import { isSubjectReference, findModelCapabilities, getGenerationIssue, INPUT_PROFILE_VERSION, FRAME_PAIR_PROFILE_VERSION, SUBJECT_REFERENCE_PROFILE_VERSION, GENERATION_INPUT_ROLES, getShotGenerationReferenceSelection } from '@mioon/contracts';
import { ARK_SUBJECT_MODEL, subjectVideoConflictIssue, subjectVideoReferenceIssue, subjectVideoSnapshot } from './subject-video.js';

export const providerStatus = provider => provider?.status || (!provider?.configured ? 'not_configured' : !provider?.enabled ? 'disabled' : 'available');
export const providerStatusLabel = provider => ({ available: '可用', disabled: '未启用', not_configured: '配置未完成' }[providerStatus(provider)] || '不可用');
export const providerAvailabilityIssue = provider => !provider ? '未找到生成服务商，请刷新工作台后重试。' : providerStatus(provider) === 'available' ? '' : `${provider.name || provider.id}：${providerStatusLabel(provider)}。请按下方服务器配置说明完成设置后重启服务。`;
export const inputModeLabel = mode => ({ text: '文生视频', image: '图生视频', subject: '主体图片视频' }[mode] || mode);
export function providerModels(provider) {
  if (provider?.modelCapabilities?.length) return provider.modelCapabilities;
  return (provider?.models || []).map(model => typeof model === 'string' ? { id: model, name: model } : { ...model, id: model.id || model.name });
}

// Display only exact profiles and lifecycle evaluations received from the
// server. The browser never guesses a region or supplies its own clock.
export function generationProfileSelection(provider, model) {
  const region = typeof provider?.providerRegion === 'string' ? provider.providerRegion : '';
  const unavailable = (state, diagnostic) => ({ state, message: diagnostic, displayMessage: message(profileStateKeys[state]), region, profile: null, evaluation: null, evaluatedAsOf: null });
  if (!provider) return unavailable('unloaded', '服务商信息未加载或不可用，输入限制尚未确认。');
  if (!model) return unavailable('unselected', '尚未选择模型，输入限制尚未确认。');
  if (!providerModels(provider).some(item => item.id === model)) return unavailable('unknown_model', '未识别所选精确模型，不能沿用其他模型的输入限制。');
  if (!region) return unavailable('unknown_region', '服务器未提供 API 区域，输入限制尚未确认。');
  if (provider.inputProfileVersion !== INPUT_PROFILE_VERSION) return unavailable('unknown_version', '输入配置版本缺失或无法识别，请刷新工作台后核对。');
  const matches = Array.isArray(provider.inputProfiles) ? provider.inputProfiles.filter(profile => profile?.providerId === provider.id && profile.model === model && Array.isArray(profile.regions) && profile.regions.includes(region)) : [];
  if (matches.length !== 1) return unavailable('missing_profile', '未取得此模型与 API 区域的唯一输入配置，不能推断支持情况。');
  const profile = matches[0];
  const countKnown = value => Number.isSafeInteger(value) && value >= 0;
  const roleKnown = role => {
    const rule = profile.inputs?.roles?.[role];
    return typeof rule?.implemented === 'boolean' && countKnown(rule.min) && countKnown(rule.max) && rule.min <= rule.max && (!rule.implemented || Array.isArray(rule.mimeTypes) && rule.mimeTypes.length > 0 && Number.isSafeInteger(rule.maxBytes) && rule.maxBytes > 0);
  };
  if (![INPUT_PROFILE_VERSION, FRAME_PAIR_PROFILE_VERSION, SUBJECT_REFERENCE_PROFILE_VERSION].includes(profile.profileVersion) || !profile.profileId || !profile.apiFamily || !countKnown(profile.inputs?.minReferences) || !countKnown(profile.inputs?.maxReferences) || !GENERATION_INPUT_ROLES.every(roleKnown)) return unavailable('incomplete_profile', '此模型的输入配置不完整，请刷新服务商信息后核对。');
  const date = provider.profileEvaluationDate;
  const evaluations = Array.isArray(provider.inputProfileEvaluations) ? provider.inputProfileEvaluations.filter(item => item?.profileId === profile.profileId) : [];
  const evaluation = evaluations[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || evaluations.length !== 1 || evaluation.evaluatedAsOf !== date || !Array.isArray(evaluation.issues) || !Array.isArray(evaluation.warnings) || evaluation.ok !== (evaluation.issues.length === 0)) return unavailable('missing_evaluation', '尚未取得服务器的输入配置评估，不能确认当前可提交；请刷新后核对。');
  return { state: evaluation.ok ? 'ready' : 'blocked', message: evaluation.issues[0]?.message || '', displayMessage: generationIssueDescriptor(evaluation.issues[0]), region, profile, evaluation, evaluatedAsOf: date };
}

export function subjectVideoProfileIssue(provider, model) {
  if (provider?.id !== 'mock' && !(provider?.id === 'ark' && model === ARK_SUBJECT_MODEL)) return '主体图片视频仅接入 Mock 与 Ark 的 doubao-seedance-2-5-260628，不会自动切换其他模型或服务商。';
  const selection = generationProfileSelection(provider, model);
  if (selection.state !== 'ready') return selection.message || '主体输入配置尚未确认，请刷新服务商信息。';
  if (selection.profile.profileVersion !== SUBJECT_REFERENCE_PROFILE_VERSION || !selection.profile.inputs.roles.subject_reference?.implemented || !selection.profile.inputs.combinations?.some(roles => roles.length === 1 && roles[0] === 'subject_reference')) return '当前精确模型与区域尚未开放单张主体图片输入，请核对服务器配置。';
  return providerAvailabilityIssue(provider);
}

// Provider capabilities are read-only metadata. Explicit session UI choices belong
// in this session map; none are merged into a shot's persisted parameters.
export function generationSelection(providers, options = {}, shot = {}) {
  const provider = providers.find(item => item.id === options.providerId) || (!options.providerId ? providers.find(item => item.mock && providerStatus(item) === 'available') || providers[0] : undefined);
  const models = providerModels(provider);
  const model = options.model || models[0]?.id || '';
  const capabilities = provider ? findModelCapabilities(provider, model) : undefined;
  const inputMode = options.inputMode === 'subject' ? 'subject' : shot.referenceAssetIds?.length || shot.lastFrameAssetId ? 'image' : options.inputMode || (capabilities?.inputModes?.includes('text') ? 'text' : 'image');
  return { provider, model, capabilities, inputMode, scenario: options.scenario || 'success' };
}

// Rich profile errors use stable codes across clients. Keep the established
// Chinese/legacy messages intact; localize new English diagnostics for the UI.
const inputIssueMessages = {
  REFERENCE_METADATA_UNAVAILABLE: '参考素材的文件大小元数据不可用，服务器核对后才能提交。',
  INVALID_REFERENCE_SIZE: '参考素材的文件大小元数据无效，请重新读取或导入素材。',
  INVALID_REFERENCE_HASH: '参考素材缺少有效的 SHA-256 校验值，请重新读取或导入素材。',
  REFERENCE_TOO_LARGE: '参考图片超过当前 Mioon 适配器的文件大小限制。',
  REFERENCE_DATA_URI_TOO_LARGE: '参考图片编码后的完整 data URI 超过当前适配器的大小限制。',
  INVALID_REFERENCE_DIMENSIONS: '参考图片尺寸缺失或超出当前 Mioon 适配器的范围。',
  REFERENCE_ASPECT_RATIO_MISMATCH: '参考图片必须与镜头画幅比例一致，不会自动裁剪。',
  UNSUPPORTED_INPUT_ROLE: 'Mioon 当前适配器未接入此参考角色，请查看输入限制。',
  UNKNOWN_INPUT_ROLE: '未识别此参考角色，不能自动推断用途。',
  UNSUPPORTED_ROLE_COMBINATION: '当前 Mioon 适配器未接入此参考组合，不会自动丢弃素材。',
  ROLE_COUNT_EXCEEDED: '所选参考角色的数量超过当前 Mioon 适配器限制。',
  INVALID_REFERENCE_COUNT: '参考图数量不符合当前模型限制；首尾帧组合仅接入 Ark 与 Mock。',
  UNSUPPORTED_REFERENCE_MIME: '当前 Mioon 适配器未接入此参考图片格式。',
  DUPLICATE_REFERENCE: '同一参考素材不能重复提交。',
  MODEL_LIFECYCLE_REVALIDATION_REQUIRED: '此模型已到生命周期复核日期，服务器已阻止新提交。请重新核验该精确模型；不会自动替换模型。',
};
export function generationIssueMessage(issue) {
  if (!issue) return '';
  return /^[\x00-\x7F]+$/.test(issue.message || '') && inputIssueMessages[issue.code] || issue.message || '';
}

// Frozen job IDs already contain the complete manifest. In particular, never
// expand a historical job from today's shot tail or infer roles by position.
export function generationReferences(shot, { frozen = false, subjectReference } = {}) {
  if (!frozen && subjectReference) return { ok: true, issues: [], references: [{ assetId: subjectReference.subjectVersion?.assetId, role: 'subject_reference' }] };
  if (!frozen) return getShotGenerationReferenceSelection(shot);
  const ids = shot.referenceAssetIds || [];
  if (!Array.isArray(ids) || ids.length > 8 || Object.keys(ids).length !== ids.length || ids.some(id => typeof id !== 'string')) return { ok: false, issues: [{ code: 'INVALID_REFERENCES', message: '冻结参考素材清单无效，不能自动修复或缩短。' }], references: [] };
  return { ok: true, issues: [], references: ids.map((assetId, index) => ({
    assetId, role: shot.referenceBindings?.[index]?.role || shot.referenceAssets?.[index]?.role || 'first_frame',
  })) };
}

export function generationReferencePreview(shot, assets, options = {}) {
  return generationReferences(shot, options).references.map(({ assetId, role }, index) => {
    const pinned = options.frozen ? shot.referenceAssets?.[index] : undefined;
    const current = assets.find(asset => asset.id === assetId);
    const unchanged = Boolean(current && (!pinned?.sha256 || pinned.sha256 === current.sha256));
    return { assetId, role, name: unchanged ? current.name : pinned?.name,
      sha256: pinned?.sha256 || current?.sha256, asset: unchanged ? current : null };
  });
}

// Bind paid confirmation to content identity, not a mutable count or thumbnail.
export function generationReferenceIdentity(shot, assets, options = {}) {
  return JSON.stringify(generationReferences(shot, options).references.map(({ assetId, role }) => {
    const asset = assets.find(item => item.id === assetId);
    return [assetId, role, ...['projectId', 'sha256', 'mimeType', 'width', 'height', 'sizeBytes', 'relativePath'].map(key => asset?.[key] ?? null)];
  }));
}

export function generationInputIssue(shot, provider, model, assets, inputMode, { frozen = false, subjectReference, boundReference = false, savedShot } = {}) {
  if (!provider) return '未找到生成服务商，请刷新工作台后重试。';
  if (!frozen && inputMode === 'subject') {
    const issue = subjectVideoConflictIssue(shot, { savedShot, boundReference }) || subjectVideoProfileIssue(provider, model) || subjectVideoReferenceIssue(subjectReference, assets, shot.projectId);
    if (issue) return issue;
    const selected = generationProfileSelection(provider, model);
    const snapshot = { ...subjectVideoSnapshot(shot, subjectReference, assets), providerId: provider.id, model,
      inputProfileId: selected.profile.profileId, inputProfileVersion: selected.profile.profileVersion, providerRegion: selected.region };
    return generationIssueMessage(getGenerationIssue(snapshot, provider));
  }
  if (frozen && shot.subjectReference) {
    const issue = subjectVideoProfileIssue(provider, model) || subjectVideoReferenceIssue(shot.subjectReference, assets, shot.projectId);
    if (issue) return issue;
  }
  const selection = generationReferences(shot, { frozen });
  if (!selection.ok) return generationIssueMessage(selection.issues[0]);
  const references = selection.references.map(({ assetId, role }, index) => {
    const asset = assets.find(item => item.id === assetId);
    if (!asset) return null;
    if (frozen) {
      const pinned = shot.referenceAssets?.[index];
      if (!pinned || pinned.id !== assetId) return null;
      return { ...pinned, ...(pinned.sizeBytes === undefined ? { sizeBytes: asset.sizeBytes } : {}) };
    }
    return { ...asset, ...(asset.role === undefined ? { role } : {}) };
  });
  if (references.some(asset => !asset)) return '参考素材已不存在或冻结清单不完整，请重新核对原始素材。';
  if (frozen && references.some((asset, index) => {
    const current = assets.find(item => item.id === selection.references[index].assetId);
    return ['sha256', 'mimeType', 'width', 'height', 'relativePath', 'sizeBytes'].some(key => Object.hasOwn(asset, key) && asset[key] !== current[key]);
  })) return '参考素材与原任务的冻结内容不一致，不能替换后重试。';
  if (inputMode === 'image' && !references.length) return '图生视频需要选择一张首帧参考图。';
  if (inputMode === 'text' && references.length) return '切换文生视频前须明确清除首帧与尾帧选择，不会自动丢弃参考图。';
  const snapshot = { ...shot, model, referenceAssetIds: selection.references.map(item => item.assetId), referenceAssets: references };
  if (!frozen && shot.lastFrameAssetId) snapshot.referenceBindings = selection.references.map(({ role, assetId }, index) => ({ role, assetId, sha256: references[index].sha256 }));
  return generationIssueMessage(getGenerationIssue(snapshot, provider));
}

// Presentation-only descriptors. Existing validation strings and frozen task data are unchanged.
const subjectContentKeys = ['sha256', 'mimeType', 'width', 'height'];
const profileStateKeys = Object.freeze({ unloaded: 'connections.generation.profileUnloaded', unselected: 'connections.generation.profileUnselected', unknown_model: 'connections.generation.profileUnknownModel', unknown_region: 'connections.generation.profileRegion', unknown_version: 'connections.generation.profileVersion', missing_profile: 'connections.generation.profileMissing', incomplete_profile: 'connections.generation.profileIncomplete', missing_evaluation: 'connections.generation.profileEvaluation' });
export const providerStatusDescriptor = provider => { const status = providerStatus(provider); return message(status === 'available' ? 'connections.generation.available' : status === 'disabled' ? 'connections.disabled' : status === 'not_configured' ? 'connections.generation.notConfigured' : 'connections.generation.unavailable'); };
export function providerAvailabilityDescriptor(provider) {
 if (!provider) return message('connections.generation.providerMissing');
 const status = providerStatus(provider);
 return status === 'available' ? null : message(status === 'disabled' ? 'connections.generation.providerDisabled' : status === 'not_configured' ? 'connections.generation.providerIncomplete' : 'connections.generation.providerUnavailable', { provider: provider.id || '—' });
}
export const inputModeDescriptor = mode => mode === 'text' ? message('connections.generation.textMode') : mode === 'image' ? message('connections.generation.imageMode') : mode === 'subject' ? message('connections.generation.subjectMode') : null;
const generationIssueKeys = Object.freeze({
  INVALID_INPUT: 'connections.generation.issue.inputRecord',
  UNSUPPORTED_MODEL: 'connections.generation.issue.modelUnsupported',
  UNSUPPORTED_PARAMETERS: 'connections.generation.issue.parametersUnsupported',
  UNSUPPORTED_ASPECT_RATIO: 'connections.generation.issue.parametersUnsupported',
  UNSUPPORTED_DURATION: 'connections.generation.issue.parametersUnsupported',
  UNSUPPORTED_INPUT: 'connections.generation.issue.inputUnsupported',
  INVALID_PROMPT: 'connections.generation.issue.promptInvalid',
  UNSUPPORTED_PARAMETER: 'connections.generation.issue.parameterInvalid',
  INVALID_PARAMETER: 'connections.generation.issue.parameterInvalid',
  INVALID_PARAMETERS: 'connections.generation.issue.parameterInvalid',
  INVALID_OPTIONS: 'connections.generation.issue.parameterInvalid',
  INVALID_SEED: 'connections.generation.issue.parameterInvalid',
  PROVIDER_REGION_CHANGED: 'connections.generation.issue.regionChanged',
  UNSUPPORTED_REGION: 'connections.generation.issue.regionUnsupported',
  UNKNOWN_INPUT_PROFILE: 'connections.generation.issue.profileUnknown',
  INVALID_ASSET_ID: 'connections.generation.issue.referenceInvalid',
  INVALID_REFERENCE: 'connections.generation.issue.referenceInvalid',
  INVALID_REFERENCE_MIME: 'connections.generation.issue.mime',
  INVALID_REFERENCE_ORDER: 'connections.generation.issue.bindingMismatch',
  REFERENCE_BINDING_MISMATCH: 'connections.generation.issue.bindingMismatch',
  REFERENCE_ASPECT_RATIO_OUT_OF_RANGE: 'connections.generation.issue.dimensions',
  REFERENCE_PAYLOAD_LIMIT: 'connections.generation.issue.tooLarge',
  UNSUPPORTED_REFERENCE_DURATION: 'connections.generation.issue.referenceInvalid',
  AS_OF_DATE_REQUIRED: 'connections.generation.issue.evaluationDate',
  INVALID_AS_OF_DATE: 'connections.generation.issue.evaluationDate',
  UNSUPPORTED_SCHEMA_VERSION: 'connections.generation.issue.schemaUnsupported',
  UNKNOWN_FIELD: 'connections.generation.issue.schemaUnsupported',
  UNKNOWN_PROVIDER: 'connections.generation.providerMissing',

  "REFERENCE_METADATA_UNAVAILABLE": "connections.generation.issue.metadataIncomplete",
  "INVALID_REFERENCE_SIZE": "connections.generation.issue.size",
  "INVALID_REFERENCE_HASH": "connections.generation.issue.hash",
  "REFERENCE_TOO_LARGE": "connections.generation.issue.tooLarge",
  "REFERENCE_DATA_URI_TOO_LARGE": "connections.generation.issue.dataUri",
  "INVALID_REFERENCE_DIMENSIONS": "connections.generation.issue.dimensions",
  "REFERENCE_ASPECT_RATIO_MISMATCH": "connections.generation.issue.aspect",
  "UNSUPPORTED_INPUT_ROLE": "connections.generation.issue.roleUnsupported",
  "UNKNOWN_INPUT_ROLE": "connections.generation.issue.roleUnknown",
  "UNSUPPORTED_ROLE_COMBINATION": "connections.generation.issue.combination",
  "ROLE_COUNT_EXCEEDED": "connections.generation.issue.roleCount",
  "INVALID_REFERENCE_COUNT": "connections.generation.issue.count",
  "UNSUPPORTED_REFERENCE_MIME": "connections.generation.issue.mime",
  "DUPLICATE_REFERENCE": "connections.generation.issue.duplicate",
  "MODEL_LIFECYCLE_REVALIDATION_REQUIRED": "connections.generation.issue.lifecycle",
  "INVALID_REFERENCES": "connections.generation.issue.referenceInvalid"
});
export function generationIssueDescriptor(issue) {
 if (!issue) return null;
 if (Array.isArray(issue.path) && issue.path.length === 1 && issue.path[0] === 'lastFrameAssetId') {
   if (issue.code === 'UNSUPPORTED_ROLE_COMBINATION') return message('generation.frame.tailNeedsFirst');
   if (issue.code === 'DUPLICATE_REFERENCE') return message('generation.frame.distinctFrames');
   if (issue.code === 'INVALID_LAST_FRAME') return message('generation.frame.invalidTail');
 }
 const key = Object.hasOwn(generationIssueKeys, issue.code) ? generationIssueKeys[issue.code] : null;
 return key ? message(key) : message('connections.generation.issue.unknown', { code: typeof issue.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(issue.code) ? issue.code : 'UNKNOWN' });
}
export function subjectVideoProfileDescriptor(provider, model) {
  if (provider?.id !== 'mock' && !(provider?.id === 'ark' && model === ARK_SUBJECT_MODEL)) return message('connections.generation.subjectProvider');
  const selection = generationProfileSelection(provider, model);
  if (selection.state !== 'ready') return selection.displayMessage || message('connections.generation.subjectProfile');
  if (selection.profile.profileVersion !== SUBJECT_REFERENCE_PROFILE_VERSION || !selection.profile.inputs.roles.subject_reference?.implemented || !selection.profile.inputs.combinations?.some(roles => roles.length === 1 && roles[0] === 'subject_reference')) return message('connections.generation.subjectUnsupported');
  return providerAvailabilityDescriptor(provider);
}

export function generationInputIssueDescriptor(shot, provider, model, assets, inputMode, { frozen = false, subjectReference, boundReference = false, savedShot } = {}) {
  if (!provider) return message('connections.generation.providerMissing');
  if (!frozen && inputMode === 'subject') {
    const issue = subjectVideoConflictDescriptor(shot, { savedShot, boundReference }) || subjectVideoProfileDescriptor(provider, model) || subjectVideoReferenceDescriptor(subjectReference, assets, shot.projectId);
    if (issue) return issue;
    const selected = generationProfileSelection(provider, model);
    const snapshot = { ...subjectVideoSnapshot(shot, subjectReference, assets), providerId: provider.id, model,
      inputProfileId: selected.profile.profileId, inputProfileVersion: selected.profile.profileVersion, providerRegion: selected.region };
    return generationIssueDescriptor(getGenerationIssue(snapshot, provider));
  }
  if (frozen && shot.subjectReference) {
    const issue = subjectVideoProfileDescriptor(provider, model) || subjectVideoReferenceDescriptor(shot.subjectReference, assets, shot.projectId);
    if (issue) return issue;
  }
  const selection = generationReferences(shot, { frozen });
  if (!selection.ok) return frozen ? message('connections.generation.issue.frozenInvalid') : generationIssueDescriptor(selection.issues[0]);
  const references = selection.references.map(({ assetId, role }, index) => {
    const asset = assets.find(item => item.id === assetId);
    if (!asset) return null;
    if (frozen) {
      const pinned = shot.referenceAssets?.[index];
      if (!pinned || pinned.id !== assetId) return null;
      return { ...pinned, ...(pinned.sizeBytes === undefined ? { sizeBytes: asset.sizeBytes } : {}) };
    }
    return { ...asset, ...(asset.role === undefined ? { role } : {}) };
  });
  if (references.some(asset => !asset)) return message('connections.generation.issue.referencesMissing');
  if (frozen && references.some((asset, index) => {
    const current = assets.find(item => item.id === selection.references[index].assetId);
    return ['sha256', 'mimeType', 'width', 'height', 'relativePath', 'sizeBytes'].some(key => Object.hasOwn(asset, key) && asset[key] !== current[key]);
  })) return message('connections.generation.issue.referencesChanged');
  if (inputMode === 'image' && !references.length) return message('connections.generation.issue.firstFrame');
  if (inputMode === 'text' && references.length) return message('connections.generation.issue.clearFrames');
  const snapshot = { ...shot, model, referenceAssetIds: selection.references.map(item => item.assetId), referenceAssets: references };
  if (!frozen && shot.lastFrameAssetId) snapshot.referenceBindings = selection.references.map(({ role, assetId }, index) => ({ role, assetId, sha256: references[index].sha256 }));
  return generationIssueDescriptor(getGenerationIssue(snapshot, provider));
}

export function subjectVideoConflictDescriptor(shot = {}, { savedShot = shot, boundReference = false } = {}) {
  if (boundReference) return message('connections.generation.issue.subjectBound');
  if ([shot, savedShot].some(value => value?.referenceAssetIds?.length || value?.lastFrameAssetId)) return message('connections.generation.issue.subjectFrames');
  return '';
}

export function subjectVideoReferenceDescriptor(reference, assets = [], projectId) {
  if (!reference) return message('connections.generation.issue.subjectMissing');
  if (!isSubjectReference(reference)) return message('connections.generation.issue.subjectInvalid');
  const version = reference.subjectVersion;
  if (projectId && version.projectId !== projectId) return message('connections.generation.issue.subjectProject');
  const asset = assets.find(item => item.id === version.assetId && item.projectId === version.projectId);
  if (!asset) return message('connections.generation.issue.subjectAssetMissing');
  if (subjectContentKeys.some(key => asset[key] !== version[key])) return message('connections.generation.issue.subjectAssetChanged');
  return '';
}
