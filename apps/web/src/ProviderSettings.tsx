import { useI18n } from './i18n/I18nProvider.tsx';
import { providerDisplayName } from './creation-i18n.ts';
import React from 'react';
import type { ReactElement } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect, WorkbenchTooltip } from './WorkspaceControls.tsx';
import Icon from './icons.tsx';
import ProviderBrandIcon from './ProviderBrandIcon.tsx';
import GenerationInputSummary from './GenerationInputSummary.tsx';
import { generationProviderIdentity, isGenerationProviderCandidate, providerModels, providerStatus, providerStatusDescriptor } from './generation-settings.ts';
import type { GenerationProvider } from './generation-settings.ts';

export interface ProviderSettingsChange { providerId?: string; connectionId?: string; modelEntryId?: string; model?: string; inputMode?: string; parameters?: Record<string, unknown> }
export interface ProviderSettingsProps {
  providers: readonly GenerationProvider[];
  provider?: GenerationProvider | null;
  model: string;
  modelEntryId?: string;
  onChange: (change: ProviderSettingsChange) => unknown;
  showEnvironmentSetup?: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const providerPrefixes: Record<string, string> = { runway: 'RUNWAY', ark: 'ARK', veo: 'VEO', minimax: 'MINIMAX', vidu: 'VIDU' };
const uniqueConfiguration = (values: unknown): string[] => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()).map(value => (value as string).trim().split(' ')[0]).filter(value => /^[A-Z][A-Z0-9_]{0,95}$/.test(value)))];

export default function ProviderSettings({ providers, provider, model, modelEntryId, onChange, showEnvironmentSetup = false }: ProviderSettingsProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const available = providers.filter(isGenerationProviderCandidate);
  const models = providerModels(provider);
  const prefix = provider && Object.hasOwn(providerPrefixes, provider.id) ? providerPrefixes[provider.id] : undefined;
  const configuration = record(provider?.configuration) ? provider.configuration : null;
  const missing = uniqueConfiguration(configuration?.missing);
  const canShowEnvironmentSetup = showEnvironmentSetup && provider && !provider.mock && !provider.connectionId &&
    providerStatus(provider) !== 'available' && (prefix || missing.length > 0);

  return <section aria-label={t('generation.provider.settingsAria')} data-testid="provider-settings">
    <div className="shot-property-row">
      <Label className="field-label" htmlFor="provider">{t('generation.provider.provider')}</Label>
      <div className="shot-property-control">
        <WorkbenchSelect id="provider" data-testid="provider-select" value={generationProviderIdentity(provider)} renderOption={option => <span className="provider-brand-label"><ProviderBrandIcon providerId={available.find(item => generationProviderIdentity(item) === option.value)?.id} /><span>{option.label}</span></span>} onChange={e => { const next = available.find(item => generationProviderIdentity(item) === e.target.value); if (next) onChange({ providerId: next.id, connectionId: next.connectionId, modelEntryId: undefined, model: '', inputMode: undefined, parameters: undefined }); }}>
          {!provider && <option value="" disabled>{t('connections.generation.providerMissing')}</option>}
          {available.map(item => {
            const source = item.mock ? '' : item.connectionId ? item.providerRegion : t('video.providers.environment');
            return <option key={generationProviderIdentity(item)} value={generationProviderIdentity(item)}>{[providerDisplayName(item, t), renderMessage(providerStatusDescriptor(item)), source].filter(Boolean).join(' · ')}</option>;
          })}
        </WorkbenchSelect>
        {provider?.mock && <WorkbenchTooltip content={t('generation.provider.simulationWarning')}><Button type="button" variant="ghost" size="icon-sm" className="icon-button" aria-label={t('generation.provider.simulationWarning')}><Icon name="info" size={14} /></Button></WorkbenchTooltip>}
      </div>
    </div>
    {provider && <>
      <div className="shot-property-row">
        <Label className="field-label" htmlFor="model">{t('generation.provider.model')}</Label>
        <div className="shot-property-control">
          <WorkbenchSelect id="model" data-testid="model-select" value={modelEntryId || model} disabled={!models.length} onChange={e => { const next = models.find(item => (item.modelEntryId || item.id) === e.target.value); if (next) onChange({ model: next.id, modelEntryId: next.modelEntryId, inputMode: undefined, parameters: undefined }); }}>
            {models.map(item => <option key={item.modelEntryId || item.id} value={item.modelEntryId || item.id}>{item.name || item.id}</option>)}
            {model && !models.some(item => item.id === model) && <option value={model}>{model} · {t('generation.provider.unsupported')}</option>}
          </WorkbenchSelect>
          {provider.connectionId && model && <Badge className="small-badge neutral" data-testid="video-model-unverified">{t('video.providers.unverified')}</Badge>}
        </div>
      </div>
      <GenerationInputSummary provider={provider} model={model} />
      {canShowEnvironmentSetup && <Collapsible key={generationProviderIdentity(provider)} className="provider-details">
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="provider-details-toggle" data-testid="provider-details-toggle"><span>{t('generation.provider.viewInstructions')}</span><Icon name="down" size={13} /></CollapsibleTrigger>
        <CollapsibleContent className="provider-details-content" data-testid="provider-details-content">
          {missing.length > 0 && <div className="provider-missing" data-testid="provider-missing" aria-label={t('generation.provider.missingAria')}>{missing.map(name => <span className="config-name" key={name}>{name}</span>)}</div>}
          {prefix && <ul className="provider-requirements" data-testid="provider-requirements"><li>{t('generation.provider.assetsInstruction', { prefix })}</li>{['minimax', 'vidu'].includes(provider.id) && <li>{t('generation.provider.regionInstruction', { prefix })}</li>}{provider.id === 'vidu' && <li>{t('generation.provider.hostsInstruction')}</li>}</ul>}
        </CollapsibleContent>
      </Collapsible>}
    </>}
  </section>;
}
