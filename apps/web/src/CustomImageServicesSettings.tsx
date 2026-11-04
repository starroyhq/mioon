import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {Input} from '@mioon/ui/components/input';
import {Label} from '@mioon/ui/components/label';
import {useConfirmation} from '@mioon/ui/components/workbench-confirm';
import {message} from '../../../packages/i18n/src/index.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_LIMITS} from '../../../packages/contracts/src/generation-image-settings.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import {useWorkspaceVisibility} from './workspace-visibility.tsx';
import {WorkbenchSelect} from './WorkspaceControls.tsx';
import {closeSettingsAfterPermission, createSettingsNavigationReporter} from './settings-navigation-state.ts';
import type {SettingsNavigationState} from './settings-navigation-state.ts';
import {createCustomImageServicesSession, initialCustomImageServicesState, customImageServicesBusy, customImageServicesDirty, customImageServicesCanSave, customImageServiceDestination} from './custom-image-services-settings.ts';
import type {CustomImageServicesClient, CustomImageServicesSession, CustomImageServicesState, CustomImageServicesSnapshot} from './custom-image-services-settings.ts';
import type {CustomImageConfigurationV2} from '../../../packages/contracts/src/generation-image-settings.ts';
import './image-settings.css';

export interface CustomImageServicesSettingsProps {
  active?: boolean; contextKey?: unknown; client?: CustomImageServicesClient; closeLabel?: string;
  onClose?: () => void; beforeClose?: () => unknown; onSelectSlot?: (slot: string) => void; onRequestSelectSlot?: (slot: string) => void;
  onNavigationStateChange?: (state: SettingsNavigationState) => void; onDirtyChange?: (dirty: boolean) => void; onSnapshot?: (snapshot: CustomImageServicesSnapshot) => void;
}
/** G1a retains the existing form layout. Each temporary password stays in its DOM input. */
export default function CustomImageServicesSettings({active = false, contextKey, client, closeLabel, onClose = () => {}, beforeClose, onSelectSlot = () => {}, onRequestSelectSlot, onNavigationStateChange, onDirtyChange, onSnapshot}: CustomImageServicesSettingsProps) {
  const {t} = useI18n(), confirm = useConfirmation(), ancestor = useWorkspaceVisibility();
  const [state, setState] = useState<CustomImageServicesState>(initialCustomImageServicesState), [hasKey, setHasKey] = useState(false), [legacyDismissed, setLegacyDismissed] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const shown = active && ancestor && pageVisible, session = useRef<CustomImageServicesSession | null>(null), keyInput = useRef<HTMLInputElement | null>(null), owner = useRef<object | null>(null);
  const reporter = useRef(createSettingsNavigationReporter()).current, callbacks = useRef({onDirtyChange, onSnapshot}); callbacks.current = {onDirtyChange, onSnapshot};
  const interaction = useMemo(() => ({shown, contextKey, id: state.draft?.connectionId}), [shown, contextKey, state.draft?.connectionId]), currentInteraction = useRef<typeof interaction | null>(interaction);
  const report = (next: CustomImageServicesState) => reporter.update({phase: next.phase, dirty: customImageServicesDirty(next) || Boolean(keyInput.current?.value), recovery: next.recovery});
  const clearKey = () => {if (keyInput.current) keyInput.current.value = ''; setHasKey(false); if (session.current) report(session.current.getState());};
  useLayoutEffect(() => {const registration = reporter.connect(onNavigationStateChange, {phase: 'loading', dirty: false}); return () => reporter.disconnect(registration);}, [reporter, onNavigationStateChange]);
  useLayoutEffect(() => {
    const lifetime = {}; owner.current = lifetime;
    const current = createCustomImageServicesSession({client, onChange: next => {if (owner.current !== lifetime) return; report(next); setState(next); if (next.snapshot) callbacks.current.onSnapshot?.(next.snapshot);}});
    session.current = current; void current.load();
    return () => {owner.current = null; if (keyInput.current) keyInput.current.value = ''; current.dispose(); if (session.current === current) session.current = null; callbacks.current.onDirtyChange?.(false);};
  }, [client]);
  useLayoutEffect(() => {const previous = currentInteraction.current; currentInteraction.current = interaction; session.current?.setVisible(shown); if (!shown || previous?.contextKey !== contextKey) clearKey();}, [interaction]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const changed = () => {const visible = document.visibilityState !== 'hidden'; if (!visible) {currentInteraction.current = null; session.current?.setVisible(false); clearKey();} setPageVisible(visible);};
    document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useLayoutEffect(() => {callbacks.current.onDirtyChange?.(customImageServicesDirty(state) || hasKey);}, [state, hasKey]);
  const lifetime = owner.current;
  const usable = () => !customImageServicesBusy(session.current?.getState() ?? state) && shown && owner.current === lifetime && lifetime !== null && currentInteraction.current === interaction && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const busy = customImageServicesBusy(state), editable = shown && !busy && !state.recovery, draft = state.draft;
  const saved = state.snapshot?.connections.find(item => item.connectionId === draft?.connectionId);
  const guardSwitch = async (action: () => void) => {
    const version = reporter.getState().version, captured = interaction;
    if (!usable() || !editable) return;
    if ((customImageServicesDirty(state) || keyInput.current?.value) && !await confirm(message('video.providers.discardConfirm'))) return;
    if (!usable() || currentInteraction.current !== captured || reporter.getState().version !== version) return;
    session.current?.discard(); clearKey(); action();
  };
  const change = (configuration: Partial<CustomImageConfigurationV2>) => {if (!usable()) return; if (configuration.baseUrl !== undefined && configuration.baseUrl !== draft?.configuration.baseUrl) clearKey(); session.current?.edit({}, configuration);};
  const close = () => {const version = reporter.getState().version; if (usable()) void closeSettingsAfterPermission(beforeClose, () => usable() && reporter.getState().version === version, () => {clearKey(); onClose();});};
  const switchSlot = (next: string) => {if (!usable()) return; if (onRequestSelectSlot) onRequestSelectSlot(next); else void guardSwitch(() => onSelectSlot(next));};
  const remove = async () => {
    if (!usable() || !editable || !draft) return;
    const id = draft.connectionId, version = reporter.getState().version;
    if (!await confirm(message('image.settings.services.deleteConfirm', {name: draft.name}))) return;
    if (!usable() || session.current?.getState().draft?.connectionId !== id || reporter.getState().version !== version) return;
    clearKey(); void session.current?.remove();
  };
  return <section className="image-settings-page" data-testid="custom-image-services-page" data-phase={state.phase} hidden={!shown} inert={!shown}>
    <header className="image-generation-heading"><h2>{t('image.settings.services.title')}</h2><Button type="button" variant="ghost" disabled={!shown} onClick={close}>{closeLabel ?? t('connections.back')}</Button></header>
    <div className="image-settings-slots" role="group" aria-label={t('image.settings.slots')}><Button type="button" disabled={!shown} onClick={() => switchSlot('official')}>{t('image.settings.official')}</Button><Button type="button" aria-pressed disabled={!shown}>{t('image.settings.custom')}</Button><Button type="button" disabled={!shown} onClick={() => switchSlot('comfy')}>{t('image.settings.comfy')}</Button></div>
    {state.snapshot?.notice && !legacyDismissed && <p role="status" data-testid="custom-image-services-legacy-notice">{t('image.settings.services.resetLegacy')}<Button type="button" variant="ghost" aria-label={t('common.close')} onClick={() => {if (usable()) setLegacyDismissed(true);}}>{t('common.close')}</Button></p>}
    {!state.snapshot ? <p role="status">{t(state.notice ?? 'image.settings.loading')}</p> : <>
      <Label htmlFor="custom-image-service-select">{t('image.settings.services.choose')}</Label><WorkbenchSelect id="custom-image-service-select" data-testid="custom-image-service-select" value={draft?.connectionId ?? ''} disabled={!editable} onChange={event => {const id = event.target.value; void guardSwitch(() => {session.current?.select(id);});}}><option value="">{t('image.settings.services.choose')}</option>{state.snapshot.connections.map(item => <option key={item.connectionId} value={item.connectionId}>{item.name}</option>)}{draft && !saved && <option value={draft.connectionId}>{draft.name}</option>}</WorkbenchSelect>
      <Button type="button" data-testid="custom-image-service-add" disabled={!editable || state.snapshot.connections.length >= CUSTOM_IMAGE_SETTINGS_V2_LIMITS.connections} onClick={() => {void guardSwitch(() => {session.current?.add(t('image.settings.services.defaultName'));});}}>{t('image.settings.services.add')}</Button>
      {!draft && <p>{t(state.snapshot.connections.length ? 'image.settings.services.choose' : 'image.settings.services.empty')}</p>}
      {draft && <form className="image-settings-form" autoComplete="off" onSubmit={event => {event.preventDefault(); if (!usable() || !customImageServicesCanSave(state)) return; const value = keyInput.current?.value ?? ''; clearKey(); void session.current?.save(value);}}>
        <Label htmlFor="custom-image-service-name">{t('image.settings.services.name')}</Label><Input id="custom-image-service-name" data-testid="custom-image-service-name" value={draft.name} maxLength={120} disabled={!editable} onChange={event => {if (usable()) session.current?.edit({name: event.target.value});}} />
        <Label htmlFor="custom-image-settings-enable"><Input id="custom-image-settings-enable" data-testid="custom-image-settings-enable" type="checkbox" checked={draft.configuration.enabled} disabled={!editable} onChange={event => change({enabled: event.target.checked})} />{t('image.settings.enableCustom')}</Label>
        <Label htmlFor="custom-image-settings-base-url">{t('image.settings.baseUrl')}</Label><Input id="custom-image-settings-base-url" data-testid="custom-image-settings-base-url" value={draft.configuration.baseUrl} maxLength={500} disabled={!editable} spellCheck={false} onChange={event => change({baseUrl: event.target.value})} />
        <Label htmlFor="custom-image-settings-model">{t('image.settings.model')}</Label><Input id="custom-image-settings-model" data-testid="custom-image-settings-model" value={draft.configuration.model} maxLength={120} disabled={!editable} spellCheck={false} onChange={event => change({model: event.target.value})} />
        <p>{t('image.settings.compatibility')}</p><output data-testid="custom-image-settings-destination">{customImageServiceDestination(draft)}</output>
        <Label htmlFor="custom-image-settings-key">{t('image.settings.key')}</Label><Input ref={keyInput} id="custom-image-settings-key" data-testid="custom-image-settings-key" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={CUSTOM_IMAGE_SETTINGS_V2_LIMITS.secretBytes} disabled={!editable || state.secretAction === 'remove'} placeholder={saved?.secret.configured ? t('image.settings.keepPlaceholder') : t('image.settings.customKeyPlaceholder')} onChange={() => {if (!usable() && keyInput.current) keyInput.current.value = ''; setHasKey(Boolean(keyInput.current?.value)); report(session.current!.getState());}} />
        <p>{t('image.settings.keyHelp')}</p><Label htmlFor="custom-image-settings-storage">{t('image.settings.keyStorage')}</Label><WorkbenchSelect id="custom-image-settings-storage" data-testid="custom-image-settings-storage" value={state.storage} disabled={!editable || state.secretAction === 'remove'} onChange={event => {if (usable()) session.current?.setStorage(event.target.value as CustomImageServicesState['storage']);}}><option value="">{t('image.settings.storageChoose')}</option><option value="session">{t('image.settings.storageSession')}</option><option value="persistent" disabled={!state.snapshot?.storage.persistentAvailable}>{t('connections.storage.persistent')}</option></WorkbenchSelect>
        <p>{t('connections.sessionLoss')}</p><p>{saved?.secret.configured ? t('image.settings.currentKey', {storage: t(saved.secret.storage === 'persistent' ? 'connections.storage.persistent' : 'image.settings.storageSession')}) : t('connections.notConfigured')}</p>
        {saved?.secret.configured && <Button type="button" disabled={!editable} onClick={() => {if (usable()) {clearKey(); session.current?.removeKey(state.secretAction !== 'remove');}}}>{t(state.secretAction === 'remove' ? 'image.settings.undoRemove' : 'image.settings.removeKey')}</Button>}
        <Button type="submit" data-testid="custom-image-settings-save" disabled={!editable || !customImageServicesCanSave(state) || hasKey && !state.storage}>{t(busy ? 'connections.saving' : 'image.settings.save')}</Button><Button type="button" data-testid="custom-image-service-delete" disabled={!editable} onClick={() => {void remove();}}>{t('image.settings.services.delete')}</Button>
      </form>}
    </>}
    {state.notice && state.snapshot && <p role={state.recovery ? 'alert' : 'status'}>{t(state.notice)}</p>}
    {state.recovery && <div className="image-generation-actions"><Button type="button" disabled={!shown || busy} onClick={() => {if (usable()) {clearKey(); void session.current?.reload();}}}>{t('connections.reload')}</Button><Button type="button" disabled={!shown || busy || state.phase === 'blocked'} onClick={() => {if (usable()) {clearKey(); session.current?.useLatest();}}}>{t('connections.useSaved')}</Button><Button type="button" disabled={!shown || state.phase !== 'review'} onClick={() => {if (usable()) {clearKey(); session.current?.acknowledge();}}}>{t('connections.keepDraft')}</Button></div>}
    {state.phase === 'load_error' && <Button type="button" disabled={!shown} onClick={() => {if (usable()) void session.current?.load();}}>{t('connections.reload')}</Button>}
  </section>;
}
