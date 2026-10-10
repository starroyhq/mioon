import { findModelCapabilities, getGenerationIssue, INPUT_PROFILE_VERSION, GENERATION_INPUT_ROLES } from '@mioon/contracts';

export const providerStatus = provider => provider?.status || (!provider?.configured ? 'not_configured' : !provider?.enabled ? 'disabled' : 'available');
export const providerStatusLabel = provider => ({ available: '可用', disabled: '未启用', not_configured: '配置未完成' }[providerStatus(provider)] || '不可用');
export const providerAvailabilityIssue = provider => !provider ? '未找到生成服务商，请刷新工作台后重试。' : providerStatus(provider) === 'available' ? '' : `${provider.name || provider.id}：${providerStatusLabel(provider)}。请按下方服务器配置说明完成设置后重启服务。`;
export const inputModeLabel = mode => ({ text: '文生视频', image: '图生视频' }[mode] || mode);
export function providerModels(provider) {
  if (provider?.modelCapabilities?.length) return provider.modelCapabilities;
  return (provider?.models || []).map(model => typeof model === 'string' ? { id: model, name: model } : { ...model, id: model.id || model.name });
}

// Display only exact profiles and lifecycle evaluations received from the
// server. The browser never guesses a region or supplies its own clock.
export function generationProfileSelection(provider, model) {
  const region = typeof provider?.providerRegion === 'string' ? provider.providerRegion : '';
  const unavailable = (state, message) => ({ state, message, region, profile: null, evaluation: null, evaluatedAsOf: null });
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
  if (profile.profileVersion !== INPUT_PROFILE_VERSION || !profile.profileId || !profile.apiFamily || !countKnown(profile.inputs?.minReferences) || !countKnown(profile.inputs?.maxReferences) || !GENERATION_INPUT_ROLES.every(roleKnown)) return unavailable('incomplete_profile', '此模型的输入配置不完整，请刷新服务商信息后核对。');
  const date = provider.profileEvaluationDate;
  const evaluations = Array.isArray(provider.inputProfileEvaluations) ? provider.inputProfileEvaluations.filter(item => item?.profileId === profile.profileId) : [];
  const evaluation = evaluations[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || evaluations.length !== 1 || evaluation.evaluatedAsOf !== date || !Array.isArray(evaluation.issues) || !Array.isArray(evaluation.warnings) || evaluation.ok !== (evaluation.issues.length === 0)) return unavailable('missing_evaluation', '尚未取得服务器的输入配置评估，不能确认当前可提交；请刷新后核对。');
  return { state: evaluation.ok ? 'ready' : 'blocked', message: evaluation.issues[0]?.message || '', region, profile, evaluation, evaluatedAsOf: date };
}

// Provider capabilities are read-only metadata. Only the scalar UI choices belong
// in this session map; none are merged into a shot's persisted parameters.
export function generationSelection(providers, options = {}, shot = {}) {
  const provider = providers.find(item => item.id === options.providerId) || (!options.providerId ? providers.find(item => item.mock && providerStatus(item) === 'available') || providers[0] : undefined);
  const models = providerModels(provider);
  const model = options.model || models[0]?.id || '';
  const capabilities = provider ? findModelCapabilities(provider, model) : undefined;
  const inputMode = shot.referenceAssetIds?.length ? 'image' : options.inputMode || (capabilities?.inputModes?.includes('text') ? 'text' : 'image');
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
  INVALID_REFERENCE_COUNT: '当前适配器至多接入一张首帧参考图；Runway 必须提供一张。',
  UNSUPPORTED_REFERENCE_MIME: '当前 Mioon 适配器未接入此参考图片格式。',
  DUPLICATE_REFERENCE: '同一参考素材不能重复提交。',
  MODEL_LIFECYCLE_REVALIDATION_REQUIRED: '此模型已到生命周期复核日期，服务器已阻止新提交。请重新核验该精确模型；不会自动替换模型。',
};
export function generationIssueMessage(issue) {
  if (!issue) return '';
  return /^[\x00-\x7F]+$/.test(issue.message || '') && inputIssueMessages[issue.code] || issue.message || '';
}

export function generationInputIssue(shot, provider, model, assets, inputMode) {
  if (!provider) return '未找到生成服务商，请刷新工作台后重试。';
  const references = (shot.referenceAssetIds || []).map(id => assets.find(asset => asset.id === id)).filter(Boolean);
  if (references.length !== (shot.referenceAssetIds || []).length) return '参考素材已不存在，请重新选择并保存。';
  if (inputMode === 'image' && !references.length) return '图生视频需要选择一张首帧参考图。';
  return generationIssueMessage(getGenerationIssue({ ...shot, model, referenceAssets: references }, provider));
}
