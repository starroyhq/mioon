import {measureSettingsRead} from './settings-diagnostics.ts';
import React, {useCallback, useLayoutEffect, useRef, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {Badge} from '@mioon/ui/components/badge';
import {useConfirmation} from '@mioon/ui/components/workbench-confirm';
import {message} from '../../../packages/i18n/src/index.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import SettingsServicesLayout from './SettingsServicesLayout.tsx';
import type {SettingsServicesGroup} from './SettingsServicesLayout.tsx';
import {useGenerationVideoServices} from './GenerationVideoServices.tsx';
import {useGenerationOfficialImageService, useGenerationCustomImageServices, useGenerationComfyService} from './GenerationImageServices.tsx';
import {saveGenerationServiceDomains} from './generation-services-settings.ts';
import type {GenerationServiceDetail, GenerationServiceDomain, GenerationSaveResult} from './generation-services-settings.ts';
import {createSettingsNavigationReporter} from './settings-navigation-state.ts';
import type {SettingsNavigationState} from './settings-navigation-state.ts';
import type {SettingsPage} from './settings-window-state.ts';
import {browserRpc} from './browser-rpc.ts';
import ProviderBrandIcon from './ProviderBrandIcon.tsx';
import Icon from './icons.tsx';
import './generation-services-settings.css';

const environmentVariables = {ark: 'ARK_API_KEY', veo: 'GEMINI_API_KEY', minimax: 'MINIMAX_API_KEY', vidu: 'VIDU_API_KEY'} as const;
const intentKey = (page: SettingsPage) => page === 'official' ? 'image:official' : page === 'comfy' ? 'image:comfy' : page === 'custom' ? 'image:custom' : 'general';
type DomainId = 'video' | 'custom' | 'official' | 'comfy';

/** One retained owner for all generation settings. The shared X6 layout alone
 * owns the middle column, retained detail panels and the single page footer. */
export default function GenerationServicesSettings({active, page = 'models', entryVersion, onNavigationStateChange}: {
  active: boolean; page?: SettingsPage; entryVersion?: number; onNavigationStateChange?: (state: SettingsNavigationState) => void;
}) {
  const {t} = useI18n(), confirm = useConfirmation();
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const pageVisible = active && documentVisible;
  const [selected, setSelected] = useState(() => intentKey(page));
  const [saving, setSaving] = useState(false), [result, setResult] = useState<GenerationSaveResult | null>(null), [, redraw] = useState(0);
  const [environment, setEnvironment] = useState<Record<string, boolean> | null>(null);
  const reporter = useRef(createSettingsNavigationReporter()).current;
  const reports = useRef(new Map<DomainId, SettingsNavigationState>()), domains = useRef<readonly GenerationServiceDomain[]>([]);
  const owner = useRef({mounted: true, active: pageVisible, saving: false, selectionVersion: 0});
  owner.current.active = pageVisible;
  const publish = useCallback(() => {
    const values = [...reports.current.values()];
    const busy = owner.current.saving || values.some(value => value.busy);
    const blocked = values.some(value => value.blocked);
    const dirty = values.some(value => value.dirty);
    reporter.update({phase: busy ? 'saving' : blocked ? 'blocked' : 'ready', dirty, recovery: blocked ? 'review' : null});
    if (owner.current.mounted) redraw(value => value + 1);
  }, [reporter]);
  const reportVideo = useCallback((state: SettingsNavigationState) => {reports.current.set('video', state); publish();}, [publish]);
  const reportCustom = useCallback((state: SettingsNavigationState) => {reports.current.set('custom', state); publish();}, [publish]);
  const reportOfficial = useCallback((state: SettingsNavigationState) => {reports.current.set('official', state); publish();}, [publish]);
  const reportComfy = useCallback((state: SettingsNavigationState) => {reports.current.set('comfy', state); publish();}, [publish]);
  const select = useCallback((key: string) => {
    if (!owner.current.mounted || !owner.current.active || owner.current.saving || typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    owner.current.selectionVersion++; setSelected(key); publish();
  }, [publish]);
  const interactionAllowed = useCallback(() => owner.current.mounted && owner.current.active && !owner.current.saving && (typeof document === 'undefined' || document.visibilityState !== 'hidden'), []);
  const video = useGenerationVideoServices({pageVisible, interactionAllowed, onNavigationStateChange: reportVideo, onSelect: select});
  const custom = useGenerationCustomImageServices({pageVisible, interactionAllowed, onNavigationStateChange: reportCustom, onSelect: select});
  const official = useGenerationOfficialImageService({pageVisible, interactionAllowed, onNavigationStateChange: reportOfficial, onSelect: select});
  const comfy = useGenerationComfyService({pageVisible, interactionAllowed, onNavigationStateChange: reportComfy, onSelect: select});
  domains.current = [video, custom, official, comfy];
  const services = [...video.services, ...official.services, ...comfy.services, ...custom.services];
  const navigation = reporter.getState();
  const ready = domains.current.every(domain => domain.ready);
  const serviceKeys = services.map(service => service.key).join('|');

  useLayoutEffect(() => {
    const token = reporter.connect(onNavigationStateChange, {phase: 'ready', dirty: false}); publish();
    return () => reporter.disconnect(token);
  }, [onNavigationStateChange, reporter, publish]);
  useLayoutEffect(() => {
    owner.current.mounted = true;
    return () => {owner.current.mounted = false; for (const domain of domains.current) domain.clearKeys();};
  }, []);
  useLayoutEffect(() => {
    if (!pageVisible) for (const domain of domains.current) domain.clearKeys();
  }, [pageVisible]);
  useLayoutEffect(() => {if (active) {setSelected(intentKey(page)); owner.current.selectionVersion++;}}, [active, page, entryVersion]);
  useLayoutEffect(() => {
    if (ready && selected !== 'general' && selected !== 'image:custom' && !services.some(service => service.key === selected)) {
      setSelected('general'); owner.current.selectionVersion++;
    }
  }, [ready, selected, serviceKeys]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const changed = () => {
      const visible = document.visibilityState !== 'hidden';
      if (!visible) {owner.current.active = false; for (const domain of domains.current) domain.clearKeys();}
      setDocumentVisible(visible);
    };
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useLayoutEffect(() => {
    if (!pageVisible) return;
    let current = true; const abort = new AbortController();
    void measureSettingsRead('generation-provider-list', () => browserRpc('provider.list', {}, {signal: abort.signal})).then(value => {
      if (!current || !Array.isArray(value)) return;
      const next: Record<string, boolean> = {};
      for (const provider of value) if (provider && typeof provider === 'object' && typeof provider.id === 'string' && Object.hasOwn(environmentVariables, provider.id) && typeof provider.configured === 'boolean') next[provider.id] = provider.configured;
      setEnvironment(next);
    }).catch(() => {if (current) setEnvironment(null);});
    return () => {current = false; abort.abort();};
  }, [pageVisible]);

  const allowed = () => owner.current.mounted && owner.current.active && !owner.current.saving && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const save = () => {
    if (!allowed() || !ready || navigation.busy || navigation.blocked || !navigation.dirty) return;
    owner.current.saving = true; setSaving(true); setResult(null); publish();
    void saveGenerationServiceDomains(domains.current).then(outcome => {
      if (owner.current.mounted) setResult(outcome);
    }).finally(() => {owner.current.saving = false; if (owner.current.mounted) {setSaving(false); publish();}});
  };
  const discard = async () => {
    if (!allowed() || navigation.busy || navigation.blocked || !navigation.dirty) return;
    const version = reporter.getState().version, selection = owner.current.selectionVersion;
    if (!await confirm(message('generation.services.discardConfirm'))) return;
    if (!allowed() || version !== reporter.getState().version || selection !== owner.current.selectionVersion) return;
    for (const domain of domains.current) {domain.clearKeys(); domain.discard();}
    setResult(null); publish();
  };
  const countLabel = (items: readonly GenerationServiceDetail[]) => items.some(item => item.available === null) ? t('redesign.settings.statusUnknown') : t('generation.services.availableCount', {count: items.filter(item => item.available).length});
  const serviceIcon = (service: GenerationServiceDetail, size: number) => service.kind === 'image' ? <Icon name="image" size={size} style={{color: 'var(--wb-image-edge)'}} /> : <ProviderBrandIcon providerId={service.providerId} size={size} />;
  const item = (service: GenerationServiceDetail) => ({key: service.key, label: service.label, icon: serviceIcon(service, 18),
    badge: service.configured === true ? <span className="generation-service-dot" aria-label={t('redesign.settings.configured')} /> : undefined,
    testId: `generation-service-${service.key}`});
  const videoServices = services.filter(service => service.kind === 'video'), imageServices = services.filter(service => service.kind === 'image');
  const add = (domain: GenerationServiceDomain) => {if (allowed()) {const key = domain.add?.(); if (key) select(key);}};
  const groups: SettingsServicesGroup[] = [
    {key: 'general', items: [{key: 'general', label: t('generation.services.general'), icon: <Icon name="settings" size={16} />} ]},
    {key: 'video', title: <span className="generation-service-group-title" data-kind="video">{t('generation.services.videoGroup')}<small>{countLabel(videoServices)}</small></span>, items: videoServices.filter(service => !service.custom).map(item)},
    {key: 'custom-video', title: t('generation.services.customGroup'), items: videoServices.filter(service => service.custom).map(item), action: {label: t('video.providers.addCustom'), testId: 'generation-add-video', disabled: !video.ready || video.navigation.busy || video.navigation.blocked || saving, onAction: () => add(video)}},
    {key: 'image', title: <span className="generation-service-group-title" data-kind="image">{t('generation.services.imageGroup')}<small>{countLabel(imageServices)}</small></span>, items: imageServices.filter(service => !service.custom).map(item)},
    {key: 'custom-image', title: t('generation.services.customGroup'), items: [{key: 'image:custom', label: t('generation.services.customImages')}, ...imageServices.filter(service => service.custom).map(item)], action: {label: t('image.settings.services.add'), testId: 'generation-add-image', disabled: !custom.ready || custom.navigation.busy || custom.navigation.blocked || saving, onAction: () => add(custom)}},
  ];
  const availableCard = (kind: 'video' | 'image', items: readonly GenerationServiceDetail[]) => <section className="generation-available-card" data-testid={`generation-available-${kind}`}>
    <h3>{t(kind === 'video' ? 'generation.services.videoGroup' : 'generation.services.imageGroup')}<small>{countLabel(items)}</small></h3>
    {items.some(service => service.available === null) && <p>{t('generation.services.readFailed')}</p>}
    {items.filter(service => service.available === true).map(service => <Button key={service.key} type="button" variant="ghost" onClick={() => select(service.key)}><span className="generation-service-dot" />{service.label}</Button>)}
    {!items.some(service => service.available) && items.every(service => service.available !== null) && <p>{t('generation.services.noneAvailable')}</p>}
    {items.filter(service => service.available === false).length > 0 && <small>{t('generation.services.unavailableCount', {count: items.filter(service => service.available === false).length})}</small>}
  </section>;
  const general = <div className="generation-services-general">
    {domains.current.map((domain, index) => domain.notice && <React.Fragment key={index}>{domain.notice}</React.Fragment>)}
    <h3>{t('generation.services.availableTitle')}</h3><p>{t('generation.services.generalIntro')}</p>
    <div className="generation-available-cards">{availableCard('video', videoServices)}{availableCard('image', imageServices)}</div>
    <p className="generation-services-isolation"><Icon name="lock" size={14} />{t('generation.services.separateKeys')}</p>
  </div>;
  const footerState = saving ? 'saving' : result && result.state !== 'saved' ? result.state : navigation.blocked ? 'blocked' : !ready ? navigation.busy ? 'saving' : 'error' : navigation.dirty ? 'dirty' : 'saved';
  const footerMessage = footerState === 'saving' && !saving ? 'generation.services.reading'
    : footerState === 'dirty' ? 'settings.draftKey.footer' : `generation.services.${footerState}` as const;
  return <SettingsServicesLayout title={t('redesign.settings.models')} description={t('redesign.settings.modelsHint')} className="generation-services" testId="generation-services-settings"
    pageVisible={pageVisible} selectedKey={selected} onSelect={select} groups={groups}
    panels={[{key: 'general', content: general}, {key: 'image:custom', content: <div className="generation-services-custom-overview">{custom.notice}<p>{t('image.settings.services.choose')}</p>{imageServices.filter(service => service.custom).map(service => <Button key={service.key} type="button" variant="outline" onClick={() => select(service.key)}>{service.label}</Button>)}</div>},
      ...services.map(service => ({key: service.key, content: <div className="generation-service-detail" data-kind={service.kind}>
        <header className="generation-service-heading">{serviceIcon(service, 24)}<h3>{service.label}</h3><Badge>{t(service.custom ? service.kind === 'video' ? 'generation.services.customVideo' : 'generation.services.customImage' : service.kind === 'video' ? 'generation.services.videoGroup' : 'generation.services.imageGroup')}</Badge><span className="generation-service-configured"><Badge>{t(service.configured === null ? 'redesign.settings.statusUnknown' : service.configured ? 'redesign.settings.configured' : 'redesign.settings.notConfigured')}</Badge>{service.dirty && <Badge variant="outline" className="generation-service-unsaved" data-testid="generation-service-unsaved">{t('settings.draftKey.unsaved')}</Badge>}</span></header>
        <fieldset className="generation-service-fields" disabled={saving}>{service.content}</fieldset>
        {service.kind === 'video' && environment?.[service.providerId] && Object.hasOwn(environmentVariables, service.providerId) && <p className="generation-services-environment"><span>{t('generation.services.environment')}</span><code>{environmentVariables[service.providerId as keyof typeof environmentVariables]}</code></p>}
      </div>}))]}
    footer={{state: footerState, status: t(footerMessage), save: {label: t('generation.services.save'), testId: 'generation-services-save', busy: saving, disabled: !ready || navigation.busy || navigation.blocked || !navigation.dirty, onAction: save},
      discard: {label: t('generation.services.discard'), testId: 'generation-services-discard', disabled: saving || navigation.busy || navigation.blocked || !navigation.dirty, onAction: () => {void discard();}}}} />;
}
