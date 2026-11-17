import Icon from './icons.tsx';
import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {Input} from '@mioon/ui/components/input';
import {Label} from '@mioon/ui/components/label';
import {Switch} from '@mioon/ui/components/switch';
import {useConfirmation} from '@mioon/ui/components/workbench-confirm';
import {message} from '../../../packages/i18n/src/index.ts';
import type {MessageKey} from '../../../packages/i18n/src/index.ts';
import {customImageModelSchema, getCustomImageDestination, normalizeCustomImageBaseUrl} from '../../../packages/contracts/src/image-compatible.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import {WorkbenchSelect, WorkbenchTooltip} from './WorkspaceControls.tsx';
import ModelPickerDialog from './ModelPickerDialog.tsx';
import {useSettingsServicesPanel} from './SettingsServicesLayout.tsx';
import {imageStorageReason} from './ImageSettings.tsx';
import {comfyConnectorAvailabilityDescriptor, comfyImageCheckDescriptor} from './comfy-image-settings.ts';
import {createGenerationImageServicesOwner} from './generation-image-services-settings.ts';
import type {GenerationImageDomainKind, GenerationImageDomainState, GenerationImageServicesClient, GenerationImageServicesOwner} from './generation-image-services-settings.ts';
import type {GenerationServiceDomain, GenerationServiceDomainOptions} from './generation-services-settings.ts';
import type {SettingsNavigationState} from './settings-navigation-state.ts';
import './image-settings.css';
import './comfy-image-settings.css';

export interface GenerationImageServiceOptions extends GenerationServiceDomainOptions {client?: GenerationImageServicesClient}
const documentVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Hooks keep one owner per persisted domain. Locale and selected detail never
 * participate in owner construction, so every UUID keeps its own password DOM. */
function useImageDomain(kind: GenerationImageDomainKind, options: GenerationImageServiceOptions): GenerationServiceDomain {
  const {t} = useI18n(), [, render] = useState(0), current = useRef(options), mounted = useRef<GenerationImageServicesOwner | null>(null);
  const [legacyDismissed, dismissLegacy] = useState(false);
  const serial = useRef(0), navigation = useRef<SettingsNavigationState>({dirty: false, busy: true, blocked: true, version: 0});
  current.current = options;
  useLayoutEffect(() => {
    // StrictMode replays setup/cleanup. Construct a fresh owner for every setup;
    // an already disposed owner is never revived or reused by a memo.
    const created = createGenerationImageServicesOwner(kind, {client: current.current.client, interactionAllowed: () => current.current.interactionAllowed?.() !== false, onChange: () => {
      if (mounted.current !== created) return;
      navigation.current = {...created.navigation(), version: ++serial.current};
      current.current.onNavigationStateChange?.(navigation.current); render(value => value + 1);
    }});
    mounted.current = created; navigation.current = {...created.navigation(), version: ++serial.current}; render(value => value + 1);
    created.setPageVisible(current.current.pageVisible && documentVisible());
    if (current.current.pageVisible && documentVisible()) void created.load();
    return () => {if (mounted.current === created) mounted.current = null; created.dispose();};
  }, [kind, options.client]);
  useLayoutEffect(() => {mounted.current?.setPageVisible(options.pageVisible && documentVisible());}, [options.pageVisible]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const changed = () => mounted.current?.setPageVisible(current.current.pageVisible && documentVisible());
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useLayoutEffect(() => {options.onNavigationStateChange?.(navigation.current);}, [options.onNavigationStateChange]);
  const owner = mounted.current;
  if (!owner) return {services: [], ready: false, navigation: navigation.current, prepareSave() {throw Error('Image settings are loading.');}, clearKeys() {}, discard() {}};
  const state = owner.getState(), ids = kind === 'custom' ? state.drafts.map(item => item.id) : [kind === 'official' ? 'image:official' : 'image:comfy'];
  const services = ids.map(id => {
    const draft = state.drafts.find(item => item.id === id), snapshot = state.snapshot;
    const stored = snapshot && 'connections' in snapshot ? snapshot.connections.find(item => item.connectionId === id) : snapshot && !('connections' in snapshot) ? snapshot : null;
    const configured = !snapshot ? null : kind === 'comfy' ? !!stored?.configuration.baseUrl && !!stored.configuration.model : !!owner.savedSecret(id)?.configured;
    const secret = owner.savedSecret(id), storage = snapshot && 'storage' in snapshot ? snapshot.storage : null;
    const available = !snapshot || kind === 'comfy' && !state.availability ? null : !!stored?.configuration.enabled && (kind === 'comfy'
      ? 'readiness' in snapshot && snapshot.readiness.checked && state.availability?.state === 'available'
      : !!secret?.configured && (secret.storage === 'session' || !!storage?.persistentAvailable));
    return {key: kind === 'custom' ? `image:${id}` : id, label: kind === 'custom' ? draft!.name : t(kind === 'official' ? 'image.settings.official' : 'image.settings.comfy'),
      providerId: kind === 'official' ? 'openai' : kind === 'custom' ? 'openai-compatible' : 'comfy-local', kind: 'image' as const, custom: kind === 'custom', configured, available, dirty: owner.isDirty(id),
      content: <GenerationImageServiceDetail key={id} id={id} kind={kind} owner={owner} state={state} onSelect={key => current.current.onSelect?.(key)} />};
  });
  const notice = kind === 'custom' && state.snapshot && 'notice' in state.snapshot && state.snapshot.notice && !legacyDismissed
    ? <p role="status" data-testid="generation-custom-image-legacy-notice">{t('image.settings.services.resetLegacy')} <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={() => {if (owner.interactionAllowed()) dismissLegacy(true);}}>{t('common.close')}</Button></p> : undefined;
  return {services, notice, ready: !!state.snapshot && state.phase !== 'load_error' && state.phase !== 'loading', navigation: navigation.current, prepareSave: owner.prepareSave,
    clearKeys: owner.clearKeys, discard: owner.discard,
    ...(kind === 'custom' ? {add: () => {const id = owner.add(t('image.settings.services.defaultName')); if (id) current.current.onSelect?.(`image:${id}`); return id ? `image:${id}` : null;}} : {})};
}
export const useGenerationOfficialImageService = (options: GenerationImageServiceOptions): GenerationServiceDomain => useImageDomain('official', options);
export const useGenerationCustomImageServices = (options: GenerationImageServiceOptions): GenerationServiceDomain => useImageDomain('custom', options);
export const useGenerationComfyService = (options: GenerationImageServiceOptions): GenerationServiceDomain => useImageDomain('comfy', options);

/** Detail-only content: the shared parent owns title, navigation and Save. */
function GenerationImageServiceDetail({id, kind, owner, state, onSelect}: {id: string; kind: GenerationImageDomainKind; owner: GenerationImageServicesOwner; state: GenerationImageDomainState; onSelect: (key: string) => void}) {
  const {t, renderMessage} = useI18n(), confirm = useConfirmation(), visibility = useSettingsServicesPanel();
  const [picker, setPicker] = useState<symbol | null>(null);
  const activePicker = useRef<typeof picker>(null), pickerTrigger = useRef<HTMLElement | null>(null);
  const inputRef = useMemo(() => (input: HTMLInputElement | null) => owner.registerKey(id, input), [owner, id]);
  const interaction = useMemo(() => ({id, active: visibility.active, version: state.version}), [id, visibility.active, state.version]);
  const current = useRef(interaction); current.current = interaction;
  const usable = () => current.current === interaction && visibility.active && documentVisible() && owner.interactionAllowed();
  function closePicker() {
    if (!activePicker.current) return;
    activePicker.current = null;
    setPicker(null);
    owner.cancelCheck(id);
  }
  useLayoutEffect(() => {
    if (!visibility.active) {
      closePicker();
      if (!visibility.selected) owner.cancelCheck(id);
    }
  }, [id, owner, visibility.active, visibility.selected]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {if (!documentVisible()) closePicker();};
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [id, owner]);
  const draft = state.drafts.find(item => item.id === id), busy = ['loading', 'saving', 'reconciling', 'checking'].includes(state.phase);
  const editable = visibility.active && !busy && !state.recovery, snapshot = state.snapshot, secret = owner.savedSecret(id);
  const storage = snapshot && 'storage' in snapshot ? snapshot.storage : null;
  const storagePending = storage?.reasonCode === 'OS_SECRET_STORE_PENDING';
  const probe = state.probe?.id === id ? state.probe : null;
  const listing = probe?.operation === 'models' ? probe.result : null;
  const pickerStatus = !listing ? 'loading' : listing.result === 'ok'
    ? listing.models?.length ? 'ready' : 'empty' : listing.result === 'unsupported' ? 'empty' : 'error';
  const probeable = editable && owner.canProbe(id);
  const probeMessage = probe?.result.result === 'ok'
    ? t('settings.draftKey.success')
    : probe?.result.result === 'unauthorized' ? t('settings.draftKey.unauthorized')
      : probe?.result.result === 'unsupported' ? t(probe.operation === 'models' ? 'settings.draftKey.listUnsupported' : 'settings.draftKey.unavailable')
        : t('settings.draftKey.failed');
  let destination = '';
  try {if (draft?.configuration.baseUrl) destination = kind === 'custom' ? getCustomImageDestination(normalizeCustomImageBaseUrl(draft.configuration.baseUrl)) : `${draft.configuration.baseUrl}/images/generations`;} catch {}
  const prefix = id.replaceAll(':', '-'), edit = (patch: Parameters<typeof owner.edit>[1], configuration: Parameters<typeof owner.edit>[2] = {}) => {if (usable()) owner.edit(id, patch, configuration);};
  function openPicker(trigger: HTMLElement) {
    if (kind !== 'custom' || !usable() || !probeable || activePicker.current || !draft) return;
    const next = Symbol();
    activePicker.current = next;
    pickerTrigger.current = trigger;
    setPicker(next);
    void owner.checkCredential(id, 'models');
  }
  function chooseModel(ids: readonly string[]) {
    if (!usable() || !picker || activePicker.current !== picker || kind !== 'custom' || ids.length !== 1) return;
    const model = ids[0];
    const result = owner.getState().probe;
    if (result?.id !== id || result.operation !== 'models' || !result.result.models?.some(item => item.id === model)
        || !customImageModelSchema.safeParse(model).success) return;
    if (owner.edit(id, {}, {model})) closePicker();
  }
  const remove = async () => {
    if (!usable() || !editable || !draft) return;
    const version = owner.getState().version;
    if (!await confirm(message('image.settings.services.deleteConfirm', {name: draft.name}))) return;
    if (usable() && owner.remove(id, version)) onSelect('general');
  };
  if (!draft) return <div className="image-settings-form" data-testid={`${prefix}-detail`}><p role="status">{t((state.notice ?? 'image.settings.loading') as MessageKey)}</p>{state.phase === 'load_error' && <Button type="button" disabled={!visibility.active} onClick={() => {if (usable()) void owner.load();}}>{t('connections.reload')}</Button>}</div>;
  const currentModel = draft.configuration.model;
  const pickerItems = kind === 'custom' && picker ? [
    ...(currentModel ? [{id: currentModel, added: true, unavailable: false}] : []),
    ...(listing?.models ?? []).filter(item => item.id !== currentModel).map(item => ({id: item.id, added: false,
      unavailable: !customImageModelSchema.safeParse(item.id).success})),
  ] : [];
  const officialModelReturned = listing?.result === 'ok' && listing.models?.some(item => item.id === currentModel) === true;
  const showProbeResult = kind === 'official' ? Boolean(listing) : probe?.operation === 'check';
  const probeSucceeded = kind === 'official' ? officialModelReturned : probe?.result.result === 'ok';
  const checkLabel = kind === 'official' && state.phase === 'checking' ? 'settings.draftKey.checking'
    : kind === 'official' && listing && !officialModelReturned ? 'settings.draftKey.recheck' : 'settings.draftKey.check';
  return <div className="image-settings-form" data-testid={`${prefix}-detail`} data-phase={state.phase}>
    {kind === 'custom' && <><Label htmlFor={`${prefix}-name`}>{t('image.settings.services.name')}</Label><Input id={`${prefix}-name`} data-testid={`${prefix}-name`} value={draft.name} maxLength={120} disabled={!editable} onChange={event => edit({name: event.target.value})} />
      <Button type="button" disabled={!editable} data-testid={`${prefix}-delete`} onClick={() => {void remove();}}>{t('image.settings.services.delete')}</Button></>}
    {kind !== 'official' && <><div className="settings-with-help"><Label htmlFor={`${prefix}-base-url`}>{t(kind === 'comfy' ? 'connections.comfy.baseUrl' : 'image.settings.baseUrl')}</Label><WorkbenchTooltip content={t(kind === 'comfy' ? 'connections.comfy.endpointHelp' : 'image.settings.baseUrlHelp')}><Button type="button" variant="ghost" size="icon-sm" aria-label={t(kind === 'comfy' ? 'connections.comfy.baseUrl' : 'image.settings.baseUrl')}><Icon name="info" size={14} /></Button></WorkbenchTooltip></div><Input id={`${prefix}-base-url`} data-testid={`${prefix}-base-url`} value={draft.configuration.baseUrl} maxLength={kind === 'comfy' ? 64 : 500} disabled={!editable} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => edit({}, {baseUrl: event.target.value})} /></>}
    {kind === 'comfy' ? <>
      <p role="status">{renderMessage(comfyConnectorAvailabilityDescriptor(state.availability))}</p>
      <div className="image-generation-actions"><Button type="button" data-testid={`${prefix}-check`} disabled={!editable || state.availability?.state !== 'available' || !draft.configuration.baseUrl} onClick={() => {if (usable()) void owner.checkConnection();}}>{t(state.phase === 'checking' ? 'connections.comfy.checking' : 'connections.comfy.check')}</Button><WorkbenchTooltip content={t('connections.comfy.checkScope')}><Button type="button" variant="ghost" size="icon-sm" aria-label={t('connections.comfy.check')}><Icon name="info" size={14} /></Button></WorkbenchTooltip></div><p role="status">{renderMessage(comfyImageCheckDescriptor(state.check))}</p>
      <div className="settings-with-help"><Label htmlFor={`${prefix}-model`}>{t('connections.comfy.model')}</Label><WorkbenchTooltip content={t('connections.comfy.modelScope')}><Button type="button" variant="ghost" size="icon-sm" aria-label={t('connections.comfy.model')}><Icon name="info" size={14} /></Button></WorkbenchTooltip></div><WorkbenchSelect id={`${prefix}-model`} data-testid={`${prefix}-model`} value={draft.configuration.model} disabled={!editable || !state.check?.checkpoints.length} onChange={event => edit({}, {model: event.target.value})}>
        <option value="">{t('connections.comfy.chooseModel')}</option>{draft.configuration.model && !state.check?.checkpoints.includes(draft.configuration.model) && <option value={draft.configuration.model} disabled>{t('connections.comfy.savedModel', {model: draft.configuration.model})}</option>}{state.check?.checkpoints.map(model => <option key={model} value={model}>{model}</option>)}
      </WorkbenchSelect>
      <div className="image-settings-fixed"><strong>{t('connections.comfy.workflow')}</strong><span>{draft.configuration.profileId}</span><span>{t('connections.comfy.output')}</span><span>{t('connections.comfy.unsandboxed')}</span></div>
    </> : <>
      {kind === 'custom' && <><div className="settings-with-help"><Label htmlFor={`${prefix}-model`}>{t('image.settings.model')}</Label><WorkbenchTooltip content={t('image.settings.compatibility')}><Button type="button" variant="ghost" size="icon-sm" aria-label={t('image.settings.model')}><Icon name="info" size={14} /></Button></WorkbenchTooltip></div><Input id={`${prefix}-model`} data-testid={`${prefix}-model`} value={draft.configuration.model} maxLength={120} disabled={!editable} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => edit({}, {model: event.target.value})} /></>}
      <div className="image-settings-fixed">{destination && <span>{destination}</span>}<span>{draft.configuration.model || t('image.settings.modelEmpty')}</span><span>{t('image.settings.fixedOutput')}</span></div>
      <div className="settings-with-help"><Label htmlFor={`${prefix}-key`}>{t('image.settings.key')}</Label><WorkbenchTooltip content={t('image.settings.keyHelp')}><Button type="button" variant="ghost" size="icon-sm" aria-label={t('image.settings.key')}><Icon name="info" size={14} /></Button></WorkbenchTooltip></div><Input ref={inputRef} id={`${prefix}-key`} data-testid={`${prefix}-key`} type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={4096} disabled={!editable || draft.secretAction === 'remove'} onChange={() => {if (usable()) owner.keyChanged(id);}} />
      <div className="image-generation-actions">
        <Button type="button" data-testid={`${prefix}-key-check`} disabled={!probeable} onClick={() => {if (usable()) void owner.checkCredential(id, kind === 'official' ? 'models' : 'check');}}>{t(checkLabel)}</Button>
        {kind === 'custom' && <Button type="button" data-testid={`${prefix}-model-list`} disabled={!probeable} onClick={event => openPicker(event.currentTarget)}>{t('settings.draftKey.list')}</Button>}
      </div>
      {kind === 'custom' && state.phase === 'checking' && !picker && <p role="status">{t('settings.draftKey.checking')}</p>}
      {showProbeResult && <p role={probeSucceeded ? 'status' : 'alert'} data-testid={`${prefix}-probe-result`}>
        {kind === 'official' && listing?.result === 'ok'
          ? t(officialModelReturned ? 'image.settings.officialCheckAvailable' : 'image.settings.officialCheckMissing', {model: currentModel})
          : probeMessage}
      </p>}
      {kind === 'custom' && visibility.active && picker && <ModelPickerDialog mode="single"
        serviceName={draft.name} unavailableLabel={t('image.settings.modelIdFormatUnsupported')}
        status={pickerStatus} statusMessage={listing?.result === 'unsupported' || pickerStatus === 'error' ? probeMessage : undefined}
        items={pickerItems} returnedModelCount={listing?.models?.length}
        triggerRef={pickerTrigger} onClose={closePicker} onAdd={chooseModel} />}
      <div className="settings-with-help"><Label htmlFor={`${prefix}-storage`}>{t('image.settings.keyStorage')}</Label><WorkbenchTooltip content={t('connections.sessionLoss')}><Button type="button" variant="ghost" size="icon-sm" aria-label={t('image.settings.keyStorage')}><Icon name="info" size={14} /></Button></WorkbenchTooltip></div><WorkbenchSelect id={`${prefix}-storage`} data-testid={`${prefix}-storage`} value={draft.storage} disabled={!editable || draft.secretAction === 'remove'} onChange={event => {if (event.target.value === 'session' || event.target.value === 'persistent') edit({storage: event.target.value});}}><option value="" disabled>{t('image.settings.storageChoose')}</option><option value="session">{t('image.settings.storageSession')}</option><option value="persistent" disabled={!storage?.persistentAvailable}>{t('connections.storage.persistent')}</option></WorkbenchSelect>
      {draft.needsKey && !draft.hasKey && <p role="status">{t('image.settings.notice.keyCleared')}</p>}
      {(!storagePending || state.keychainWaitConfirmed) && <p className="image-settings-help" role={storagePending ? 'status' : undefined}>{imageStorageReason(storage, t)}</p>}
      {secret?.configured && <Button type="button" disabled={!editable} aria-pressed={draft.secretAction === 'remove'} onClick={() => edit({secretAction: draft.secretAction === 'remove' ? 'keep' : 'remove'})}>{t(draft.secretAction === 'remove' ? 'image.settings.undoRemove' : 'image.settings.removeKey')}</Button>}
    </>}
    <div className="settings-with-help"><Label className="generation-image-enable" htmlFor={`${prefix}-enabled`}><Switch id={`${prefix}-enabled`} data-testid={`${prefix}-enabled`} checked={draft.configuration.enabled} disabled={!editable} onCheckedChange={enabled => edit({}, {enabled})} /><span>{t(kind === 'official' ? 'image.settings.enableOpenai' : kind === 'custom' ? 'image.settings.enableCustom' : 'connections.comfy.enable')}</span></Label><WorkbenchTooltip content={t(kind === 'comfy' ? 'connections.comfy.enableScope' : 'image.settings.enableScope')}><Button type="button" variant="ghost" size="icon-sm" aria-label={t('redesign.shell.help')}><Icon name="info" size={14} /></Button></WorkbenchTooltip></div>
    {state.notice && <p role={state.recovery ? 'alert' : 'status'}>{t(state.notice as MessageKey)}</p>}
    {state.recovery && <div className="image-generation-actions"><Button type="button" disabled={!visibility.active || busy} onClick={() => {if (usable()) void owner.reload();}}>{t('connections.reload')}</Button><Button type="button" disabled={!visibility.active || busy || state.phase === 'blocked'} onClick={() => {if (usable()) owner.discard();}}>{t('connections.useSaved')}</Button><Button type="button" disabled={!visibility.active || state.phase !== 'review'} onClick={() => {if (usable()) owner.acknowledge();}}>{t('connections.keepDraft')}</Button></div>}
  </div>;
}
