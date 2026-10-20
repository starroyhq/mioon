import { useI18n } from './i18n/I18nProvider.tsx';
import { providerDisplayName } from './creation-i18n.ts';
import React from 'react';
import type { ReactElement } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import Icon from './icons.tsx';
import ProviderBrandIcon from './ProviderBrandIcon.tsx';
import GenerationInputSummary from './GenerationInputSummary.tsx';
import { generationProviderIdentity, inputModeDescriptor, providerModels, providerStatus, providerStatusDescriptor } from './generation-settings.ts';
import type { GenerationProvider } from './generation-settings.ts';

export interface ProviderSettingsChange { providerId?: string; connectionId?: string; modelEntryId?: string; model?: string; inputMode?: string; parameters?: Record<string, unknown> }
export interface ProviderSettingsProps {
  providers: readonly GenerationProvider[];
  provider?: GenerationProvider | null;
  model: string;
  modelEntryId?: string;
  capabilities?: Record<string, unknown> | null;
  onChange: (change: ProviderSettingsChange) => unknown;
  compact?: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const providerPrefixes: Record<string, string> = { runway: 'RUNWAY', ark: 'ARK', veo: 'VEO', minimax: 'MINIMAX', vidu: 'VIDU' };
const uniqueConfiguration = (values: unknown): string[] => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()).map(value => (value as string).trim().split(' ')[0]).filter(value => /^[A-Z][A-Z0-9_]{0,95}$/.test(value)))];

export default function ProviderSettings({ providers, provider, model, modelEntryId, capabilities, onChange, compact = false }: ProviderSettingsProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const available = providers.filter(item => item.id !== 'runway');
  const prefix = typeof provider?.id === 'string' && Object.hasOwn(providerPrefixes, provider.id) ? providerPrefixes[provider.id] : undefined;
  const status = providerStatus(provider);
  const models = providerModels(provider);
  const configuration = record(provider?.configuration) ? provider.configuration : null;
  const missing = uniqueConfiguration(configuration?.missing);

  const details = <>
    {capabilities && <div className="model-capabilities" data-testid="model-capabilities">
      <span>{stringList(capabilities.inputModes).map(mode => renderMessage(inputModeDescriptor(mode))).join(' / ')}</span>
      <span>{t('generation.provider.seconds', { values: stringList(capabilities.durations).join(' / ') })}</span>
      <span>{stringList(capabilities.aspectRatios).join(' / ')}</span>
      {stringList(capabilities.resolutions).length > 0 && <span>{stringList(capabilities.resolutions).join(' / ')}</span>}
    </div>}
    <GenerationInputSummary provider={provider} model={model} />
    <div className={`provider-setup ${status !== 'available' ? 'unavailable' : ''}`} data-testid="provider-status" data-status={status}>
      <div className="provider-setup-heading"><Icon name={provider?.mock ? 'info' : status === 'available' ? 'check' : 'lock'} size={14} /><Badge className={`small-badge ${status === 'available' ? 'accent' : 'warn'}`}>{renderMessage(providerStatusDescriptor(provider))}</Badge><span>{provider?.mock ? t('generation.provider.localMp4') : provider?.connectionId ? t('video.providers.connection') : t('generation.provider.serverConfiguration')}</span></div>
      <p data-testid="provider-readiness-summary">{provider?.mock ? t('generation.provider.simulationWarning') : provider?.connectionId ? status === 'available' ? t('generation.provider.readyWarning') : t('video.providers.incomplete') : status === 'available' ? t('generation.provider.readyWarning') : status === 'disabled' ? t('generation.provider.disabledWarning') : missing.length ? t('generation.provider.missingCount', { count: missing.length }) : t('generation.provider.incomplete')}</p>
      {!provider?.mock && !provider?.connectionId && <>
        {missing.length > 0 && <div className="provider-missing" data-testid="provider-missing" aria-label={t('generation.provider.missingAria')}>{missing.map(name => <span className="config-name" key={name}>{name}</span>)}</div>}
        <p className="provider-security">{t('generation.provider.security')}</p>
        <Collapsible key={generationProviderIdentity(provider)} className="provider-details">
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="provider-details-toggle" data-testid="provider-details-toggle"><span>{t('generation.provider.viewInstructions')}</span><Icon name="down" size={13} /></CollapsibleTrigger>
          <CollapsibleContent className="provider-details-content" data-testid="provider-details-content">
            <p>{t('generation.provider.verifyBeforeEnabling')}</p>
            {prefix ? <ul className="provider-requirements" data-testid="provider-requirements"><li>{t('generation.provider.enableInstruction')}</li><li>{t('generation.provider.assetsInstruction', { prefix })}</li>{['minimax', 'vidu'].includes(provider?.id ?? '') && <li>{t('generation.provider.regionInstruction', { prefix })}</li>}{provider?.id === 'vidu' && <li>{t('generation.provider.hostsInstruction')}</li>}<li>{t('generation.provider.approvalInstruction')}</li></ul> : <p>{t('generation.provider.unknownInstructions')}</p>}
          </CollapsibleContent>
        </Collapsible>
      </>}
    </div>
  </>;

  return <section className="generation-provider" aria-label={t('generation.provider.settingsAria')} data-testid="provider-settings">
    <div className="section-heading"><span>{t('generation.provider.heading')}</span><Icon name="bolt" size={15} /></div>
    <Label className="sr-only" htmlFor="provider">{t('generation.provider.provider')}</Label>
    <WorkbenchSelect id="provider" data-testid="provider-select" value={generationProviderIdentity(provider)} renderOption={option => <span className="provider-brand-label"><ProviderBrandIcon providerId={available.find(item => generationProviderIdentity(item) === option.value)?.id} /><span>{option.label}</span></span>} onChange={e => { const next = available.find(item => generationProviderIdentity(item) === e.target.value); if (next) onChange({ providerId: next.id, connectionId: next.connectionId, modelEntryId: undefined, model: '', inputMode: undefined, parameters: undefined }); }}>
      {available.map(item => <option key={generationProviderIdentity(item)} value={generationProviderIdentity(item)}>{providerDisplayName(item, t)} · {renderMessage(providerStatusDescriptor(item))}{item.mock ? ` · ${t('generation.provider.localSimulation')}` : item.connectionId ? ` · ${item.providerRegion || ''}` : ` · ${t('video.providers.environment')}`}</option>)}
    </WorkbenchSelect>
    <Label className="field-label" htmlFor="model">{t('generation.provider.model')}</Label>
    <WorkbenchSelect id="model" data-testid="model-select" value={modelEntryId || model} disabled={!models.length} onChange={e => { const next = models.find(item => (item.modelEntryId || item.id) === e.target.value); if (next) onChange({ model: next.id, modelEntryId: next.modelEntryId, inputMode: undefined, parameters: undefined }); }}>
      {models.map(item => <option key={item.modelEntryId || item.id} value={item.modelEntryId || item.id}>{item.name || item.id}{provider?.connectionId ? ` · ${t('video.providers.unverified')}` : ''}</option>)}
      {model && !models.some(item => item.id === model) && <option value={model}>{model} · {t('generation.provider.unsupported')}</option>}
    </WorkbenchSelect>
    {provider?.connectionId && model && <p className="helper muted" data-testid="video-model-unverified"><Badge className="small-badge neutral">{t('video.providers.unverified')}</Badge> {t('video.providers.unverifiedHint')}</p>}
    {compact ? <Collapsible key={`${generationProviderIdentity(provider)}:${status}`} defaultOpen={status !== 'available'} className="provider-compact-information"><CollapsibleTrigger render={<Button variant="ghost" size="sm" />}><Icon name="info" size={13} />{t('generation.provider.viewInstructions')}</CollapsibleTrigger><CollapsibleContent keepMounted>{details}</CollapsibleContent></Collapsible> : details}
  </section>;
}
