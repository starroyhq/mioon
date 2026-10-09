import { findModelCapabilities, getGenerationIssue } from '@mioon/contracts';

export const providerStatus = provider => provider?.status || (!provider?.configured ? 'not_configured' : !provider?.enabled ? 'disabled' : 'available');
export const providerStatusLabel = provider => ({ available: '可用', disabled: '未启用', not_configured: '配置未完成' }[providerStatus(provider)] || '不可用');
export const providerAvailabilityIssue = provider => !provider ? '未找到生成服务商，请刷新工作台后重试。' : providerStatus(provider) === 'available' ? '' : `${provider.name || provider.id}：${providerStatusLabel(provider)}。请按下方服务器配置说明完成设置后重启服务。`;
export const inputModeLabel = mode => ({ text: '文生视频', image: '图生视频' }[mode] || mode);
export function providerModels(provider) {
  if (provider?.modelCapabilities?.length) return provider.modelCapabilities;
  return (provider?.models || []).map(model => typeof model === 'string' ? { id: model, name: model } : { ...model, id: model.id || model.name });
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

export function generationInputIssue(shot, provider, model, assets, inputMode) {
  if (!provider) return '未找到生成服务商，请刷新工作台后重试。';
  const references = (shot.referenceAssetIds || []).map(id => assets.find(asset => asset.id === id)).filter(Boolean);
  if (references.length !== (shot.referenceAssetIds || []).length) return '参考素材已不存在，请重新选择并保存。';
  if (inputMode === 'image' && !references.length) return '图生视频需要选择一张首帧参考图。';
  return getGenerationIssue({ ...shot, model, referenceAssets: references }, provider)?.message || '';
}
