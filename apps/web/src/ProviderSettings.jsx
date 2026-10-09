import React from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import Icon from './icons.jsx';
import { inputModeLabel, providerModels, providerStatus, providerStatusLabel } from './generation-settings.js';

const uniqueConfiguration = values => [...new Set((values || []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];

export default function ProviderSettings({ providers, provider, model, capabilities, onChange }) {
  const status = providerStatus(provider);
  const models = providerModels(provider);
  const missing = uniqueConfiguration(provider?.configuration?.missing);
  const requirements = uniqueConfiguration(provider?.configuration?.requirements);
  return <section className="generation-provider" aria-label="生成引擎设置" data-testid="provider-settings">
    <div className="section-heading"><span>生成引擎</span><Icon name="bolt" size={15} /></div>
    <Label className="sr-only" htmlFor="provider">生成服务商</Label>
    <WorkbenchSelect id="provider" data-testid="provider-select" value={provider?.id || ''} onChange={e => onChange({ providerId: e.target.value, model: '', inputMode: undefined })}>
      {providers.map(item => <option key={item.id} value={item.id}>{item.name || item.id} · {providerStatusLabel(item)}{item.mock ? ' · 本地模拟' : ''}</option>)}
    </WorkbenchSelect>
    <Label className="field-label" htmlFor="model">模型</Label>
    <WorkbenchSelect id="model" data-testid="model-select" value={model} disabled={!models.length} onChange={e => onChange({ model: e.target.value, inputMode: undefined })}>
      {models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
      {model && !models.some(item => item.id === model) && <option value={model}>{model} · 不支持</option>}
    </WorkbenchSelect>
    {capabilities && <div className="model-capabilities" data-testid="model-capabilities">
      <span>{capabilities.inputModes?.map(inputModeLabel).join(' / ')}</span>
      <span>{capabilities.durations?.join(' / ')} 秒</span>
      <span>{capabilities.aspectRatios?.join(' / ')}</span>
      {capabilities.resolutions?.length > 0 && <span>{capabilities.resolutions.join(' / ')}</span>}
    </div>}
    <div className={`provider-setup ${status !== 'available' ? 'unavailable' : ''}`} data-testid="provider-status" data-status={status}>
      <div className="provider-setup-heading"><Icon name={provider?.mock ? 'info' : status === 'available' ? 'check' : 'lock'} size={14} /><Badge className={`small-badge ${status === 'available' ? 'accent' : 'warn'}`}>{providerStatusLabel(provider)}</Badge><span>{provider?.mock ? '本地生成 MP4' : '服务器配置'}</span></div>
      <p data-testid="provider-readiness-summary">{provider?.mock ? '本地模拟用于验证流程，不调用付费 AI 服务。' : status === 'available' ? '已就绪。真实生成可能计费，提交前请确认发送内容。' : status === 'disabled' ? '真实调用未启用，请由服务器管理员启用并重启。' : missing.length ? `还需配置 ${missing.length} 项，完成后重启服务。` : '配置未完成，请由服务器管理员检查后重启。'}</p>
      {!provider?.mock && <>
        {missing.length > 0 && <div className="provider-missing" data-testid="provider-missing" aria-label="待配置的环境变量">{missing.map(name => <span className="config-name" key={name}>{name}</span>)}</div>}
        <p className="provider-security">API 密钥仅在服务器配置；勿填入提示词或浏览器。</p>
        <Collapsible key={provider?.id} className="provider-details">
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="provider-details-toggle" data-testid="provider-details-toggle"><span>查看配置说明</span><Icon name="down" size={13} /></CollapsibleTrigger>
          <CollapsibleContent className="provider-details-content" data-testid="provider-details-content">
            <p>启用前，请在服务商和服务器侧确认账户权限、生成预算与素材授权。</p>
            {requirements.length > 0 && <ul className="provider-requirements" data-testid="provider-requirements">{requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul>}
          </CollapsibleContent>
        </Collapsible>
      </>}
    </div>
  </section>;
}
