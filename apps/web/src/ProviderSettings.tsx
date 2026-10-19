import { useI18n } from './i18n/I18nProvider.tsx';
import { providerDisplayName } from './creation-i18n.ts';
import React from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import Icon from './icons.tsx';
import GenerationInputSummary from './GenerationInputSummary.tsx';
import { inputModeDescriptor, providerModels, providerStatus, providerStatusDescriptor } from './generation-settings.ts';

const uniqueConfiguration = values => [...new Set((values || []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().split(' ')[0]).filter(value => /^[A-Z][A-Z0-9_]{0,95}$/.test(value)))];

export default function ProviderSettings({ providers, provider, model, capabilities, onChange, compact = false }) {
  const { t, renderMessage } = useI18n();
  const prefix = ({ __proto__: null, runway: 'RUNWAY', ark: 'ARK', veo: 'VEO', minimax: 'MINIMAX', vidu: 'VIDU' })[provider?.id];
  const status = providerStatus(provider);
  const models = providerModels(provider);
  const missing = uniqueConfiguration(provider?.configuration?.missing);

  const details = <>
    {capabilities && <div className="model-capabilities" data-testid="model-capabilities">
      <span>{capabilities.inputModes?.map(mode => renderMessage(inputModeDescriptor(mode))).join(' / ')}</span>
      <span>{t('generation.provider.seconds', { values: capabilities.durations?.join(' / ') || '' })}</span>
      <span>{capabilities.aspectRatios?.join(' / ')}</span>
      {capabilities.resolutions?.length > 0 && <span>{capabilities.resolutions.join(' / ')}</span>}
    </div>}
    <GenerationInputSummary provider={provider} model={model} />
    <div className={`provider-setup ${status !== 'available' ? 'unavailable' : ''}`} data-testid="provider-status" data-status={status}>
      <div className="provider-setup-heading"><Icon name={provider?.mock ? 'info' : status === 'available' ? 'check' : 'lock'} size={14} /><Badge className={`small-badge ${status === 'available' ? 'accent' : 'warn'}`}>{renderMessage(providerStatusDescriptor(provider))}</Badge><span>{provider?.mock ? t('generation.provider.localMp4') : t('generation.provider.serverConfiguration')}</span></div>
      <p data-testid="provider-readiness-summary">{provider?.mock ? t('generation.provider.simulationWarning') : status === 'available' ? t('generation.provider.readyWarning') : status === 'disabled' ? t('generation.provider.disabledWarning') : missing.length ? t('generation.provider.missingCount', { count: missing.length }) : t('generation.provider.incomplete')}</p>
      {!provider?.mock && <>
        {missing.length > 0 && <div className="provider-missing" data-testid="provider-missing" aria-label={t('generation.provider.missingAria')}>{missing.map(name => <span className="config-name" key={name}>{name}</span>)}</div>}
        <p className="provider-security">{t('generation.provider.security')}</p>
        <Collapsible key={provider?.id} className="provider-details">
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="provider-details-toggle" data-testid="provider-details-toggle"><span>{t('generation.provider.viewInstructions')}</span><Icon name="down" size={13} /></CollapsibleTrigger>
          <CollapsibleContent className="provider-details-content" data-testid="provider-details-content">
            <p>{t('generation.provider.verifyBeforeEnabling')}</p>
            {prefix ? <ul className="provider-requirements" data-testid="provider-requirements"><li>{t('generation.provider.enableInstruction')}</li><li>{t('generation.provider.assetsInstruction', { prefix })}</li>{['minimax', 'vidu'].includes(provider.id) && <li>{t('generation.provider.regionInstruction', { prefix })}</li>}{provider.id === 'vidu' && <li>{t('generation.provider.hostsInstruction')}</li>}<li>{t('generation.provider.approvalInstruction')}</li></ul> : <p>{t('generation.provider.unknownInstructions')}</p>}
          </CollapsibleContent>
        </Collapsible>
      </>}
    </div>
  </>;

  return <section className="generation-provider" aria-label={t('generation.provider.settingsAria')} data-testid="provider-settings">
    <div className="section-heading"><span>{t('generation.provider.heading')}</span><Icon name="bolt" size={15} /></div>
    <Label className="sr-only" htmlFor="provider">{t('generation.provider.provider')}</Label>
    <WorkbenchSelect id="provider" data-testid="provider-select" value={provider?.id || ''} onChange={e => onChange({ providerId: e.target.value, model: '', inputMode: undefined })}>
      {providers.map(item => <option key={item.id} value={item.id}>{providerDisplayName(item, t)} · {renderMessage(providerStatusDescriptor(item))}{item.mock ? ` · ${t('generation.provider.localSimulation')}` : ''}</option>)}
    </WorkbenchSelect>
    <Label className="field-label" htmlFor="model">{t('generation.provider.model')}</Label>
    <WorkbenchSelect id="model" data-testid="model-select" value={model} disabled={!models.length} onChange={e => onChange({ model: e.target.value, inputMode: undefined })}>
      {models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
      {model && !models.some(item => item.id === model) && <option value={model}>{model} · {t('generation.provider.unsupported')}</option>}
    </WorkbenchSelect>
    {compact ? <Collapsible key={`${provider?.id}:${status}`} defaultOpen={status !== 'available'} className="provider-compact-information"><CollapsibleTrigger render={<Button variant="ghost" size="sm" />}><Icon name="info" size={13} />{t('generation.provider.viewInstructions')}</CollapsibleTrigger><CollapsibleContent keepMounted>{details}</CollapsibleContent></Collapsible> : details}
  </section>;
}
