import { useI18n } from './i18n/I18nProvider.tsx';
import { message, translate } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage, MessageKey } from '../../../packages/i18n/src/index.ts';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { closeSettingsAfterPermission, createSettingsNavigationReporter } from './settings-navigation-state.ts';
import { IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_ENDPOINT_LIMIT, imageSettingsBindingChanged, imageSettingsDestination, createImageSettingsSession, imageSettingsCanSave, imageSettingsDirty, imageSettingsEditable, initialImageSettingsState } from './image-settings.ts';
import type { ImageSettingsClient, ImageSettingsSession, ImageSettingsState } from './image-settings.ts';
import Icon from './icons.tsx';
import './image-settings.css';

type TranslateFn = (key: MessageKey) => string;
type NavigationReporter = ReturnType<typeof createSettingsNavigationReporter>;
type NavigationInput = Parameters<NavigationReporter['update']>[0];
type ImageStorageState = {reasonCode?: string | null; persistentAvailable?: boolean} | null | undefined;
const noop = () => {};
const storageLabels: Readonly<Record<string, string>> = { none: 'image.settings.storageNone', session: 'image.settings.storageSession', persistent: 'connections.storage.persistent' };
const storageLabel = (value: string, t: TranslateFn): string => t((storageLabels[value] ?? 'image.settings.storageChoose') as MessageKey);
const storageReasons: Readonly<Record<string, string>> = { WEB_SESSION_ONLY: 'image.settings.storageWeb', LINUX_BASIC_TEXT: 'image.settings.storageBasic', OS_SECRET_STORE_UNAVAILABLE: 'image.settings.storageUnavailable' };
export const imageStorageReason = (storage: ImageStorageState, t: TranslateFn = (key) => translate('zh-Hans', key)): string => {
  const key = typeof storage?.reasonCode === 'string' ? storageReasons[storage.reasonCode] : undefined;
  return t((key ?? 'image.settings.storageAvailable') as MessageKey);
};
export interface ImageSettingsProps {
  active?: boolean;
  contextKey?: unknown;
  client?: ImageSettingsClient;
  slot?: 'official' | 'custom';
  onSelectSlot?: (slot: string) => void;
  onRequestSelectSlot?: (slot: string) => void;
  onClose?: () => void;
  onSnapshot?: (snapshot: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
  beforeClose?: (() => unknown) | undefined;
  closeLabel?: string;
  onNavigationStateChange?: Parameters<NavigationReporter['connect']>[0];
}

/** Mounted across dock navigation. Only the write-only input ever holds a key. */
export default function ImageSettings({ active = false, contextKey, client, slot = 'official', onSelectSlot = noop, onRequestSelectSlot, onClose = noop, onSnapshot = noop, onDirtyChange = noop, beforeClose, closeLabel, onNavigationStateChange }: ImageSettingsProps) {
  const { t, renderMessage } = useI18n();
  if (!['official', 'custom'].includes(slot)) throw new TypeError('Unknown image settings slot');
  const custom = slot === 'custom', prefix = custom ? 'custom-image-settings' : 'image-settings';
  const [state, setState] = useState<ImageSettingsState>(initialImageSettingsState), [hasKey, setHasKey] = useState(false), [keyNotice, setKeyNotice] = useState<DisplayMessage | string>('');
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const ancestorVisible = useWorkspaceVisibility(), visible = ancestorVisible && active && pageVisible;
  const keyInput = useRef<HTMLInputElement | null>(null), session = useRef<ImageSettingsSession | null>(null), lifetime = useRef<{closed: boolean} | null>(null), callbacks = useRef<{onSnapshot: (snapshot: unknown) => void; onDirtyChange: (dirty: boolean) => void}>({ onSnapshot, onDirtyChange }), navigation = useRef<NavigationReporter | null>(null);
  const interaction = useMemo(() => ({ visible, contextKey }), [visible, contextKey]), interactionRef = useRef<{visible: boolean; contextKey: unknown} | null>(interaction);
  if (!navigation.current) navigation.current = createSettingsNavigationReporter();
  const navigationInput = (next: ImageSettingsState): NavigationInput => ({ dirty: imageSettingsDirty(next) || Boolean(keyInput.current?.value), phase: next.phase, recovery: next.recovery });
  const reportNavigation = (next: ImageSettingsState): void => { navigation.current!.update(navigationInput(next)); };
  useLayoutEffect(() => {
    const owner = navigation.current!.connect(onNavigationStateChange, navigationInput(session.current?.getState() || state));
    return () => navigation.current!.disconnect(owner);
  }, [onNavigationStateChange]);
  const clearKey = () => { if (keyInput.current) keyInput.current.value = ''; setHasKey(false); reportNavigation(session.current?.getState() || state); };
  useLayoutEffect(() => { callbacks.current = { onSnapshot, onDirtyChange }; });
  useLayoutEffect(() => {
    const owner = { closed: false }; lifetime.current = owner;
    const current = createImageSettingsSession({ client, slot, onChange: (next?: ImageSettingsState) => { if (!next || !owner.closed && lifetime.current !== owner) return; reportNavigation(next); setState(next); }, onSnapshot: (next?: unknown) => { if (!owner.closed && lifetime.current === owner) callbacks.current.onSnapshot(next); } });
    session.current = current; void current.load();
    return () => { owner.closed = true; if (keyInput.current) keyInput.current.value = ''; current.dispose(); if (session.current === current) session.current = null; callbacks.current.onDirtyChange(false); };
  }, [client, slot]);
  useLayoutEffect(() => {
    interactionRef.current = interaction; session.current?.setVisible(visible); reportNavigation(session.current?.getState() || state);
    if (keyInput.current?.value) { clearKey(); setKeyNotice(message('image.settings.keyHidden')); }
  }, [interaction]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const changed = () => { const shown = document.visibilityState !== 'hidden'; if (!shown) { interactionRef.current = null; session.current?.setVisible(false); reportNavigation(session.current?.getState() || state); if (keyInput.current?.value) { clearKey(); setKeyNotice(message('image.settings.keyPageHidden')); } } setPageVisible(shown); };
    document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useLayoutEffect(() => { callbacks.current.onDirtyChange(imageSettingsDirty(state) || hasKey); }, [state.snapshot, state.draft, state.secretAction, hasKey]);
  const owner = lifetime.current;
  const usable = () => Boolean(visible && interactionRef.current === interaction && owner && !owner.closed && lifetime.current === owner && (typeof document === 'undefined' || document.visibilityState !== 'hidden'));
  const close = () => {
    if (!usable()) return;
    const captured = interactionRef.current, version = navigation.current!.getState().version;
    return closeSettingsAfterPermission(beforeClose, () => usable() && interactionRef.current === captured && navigation.current!.getState().version === version, () => {
      if (keyInput.current?.value) setKeyNotice(message('image.settings.keyLeft')); clearKey(); interactionRef.current = null; session.current?.setVisible(false); onClose();
    });
  };
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!usable() || !imageSettingsCanSave(session.current?.getState() || state)) return; const value = keyInput.current?.value || ''; clearKey(); void session.current?.save(value); }
  const { snapshot, draft } = state, editable = visible && imageSettingsEditable(state), destination = imageSettingsDestination(draft), bindingChanged = imageSettingsBindingChanged(state);
  const selectSlot = (next: string) => { if (!usable() || next === slot) return; if (onRequestSelectSlot) { onRequestSelectSlot(next); return; } if (keyInput.current?.value) setKeyNotice(message('image.settings.keySwitched')); clearKey(); interactionRef.current = null; session.current?.setVisible(false); onSelectSlot(next); };
  const statusMessage = state.displayMessages?.map(descriptor => renderMessage(descriptor)).join(' ') || '';
  return <section className="image-settings-page" data-testid={`${prefix}-page`} data-phase={state.phase} hidden={!visible} inert={!visible} aria-label={t('image.settings.aria')}>
    <header className="image-generation-heading"><div><span className="image-generation-eyebrow">{t('image.settings.eyebrow')}</span><h2>{t('image.settings.title')}</h2><p>{t('image.settings.subtitle')}</p></div><Button type="button" variant="ghost" className="button quiet" data-testid={`${prefix}-back`} aria-label={closeLabel ?? t('image.settings.backWorkshop')} disabled={!visible} onClick={close}><Icon name="left" size={14} />{closeLabel ?? t('connections.back')}</Button></header>
    <div className="image-settings-slots" role="group" aria-label={t('image.settings.slots')}><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-slot-official`} aria-pressed={!custom} disabled={!visible} onClick={() => selectSlot('official')}>{t('image.settings.official')}</Button><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-slot-custom`} aria-pressed={custom} disabled={!visible} onClick={() => selectSlot('custom')}>{t('image.settings.custom')}</Button><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-slot-comfy`} aria-pressed={false} disabled={!visible} onClick={() => selectSlot('comfy')}>{t('image.settings.comfy')}</Button></div>
    <form className="image-settings-form" noValidate autoComplete="off" onSubmit={submit}>
      <p className="image-settings-help">{t('image.settings.saveScope')}</p>
      {!snapshot || !draft ? <div role="status"><p>{state.phase === 'loading' ? t('image.settings.loading') : statusMessage}</p>{state.phase !== 'loading' && <Button type="button" variant="ghost" className="button" data-testid={`${prefix}-load`} disabled={!visible} onClick={() => { if (usable()) void session.current?.load(); }}>{t('connections.reload')}</Button>}</div> : <>
        <Label className="image-settings-enable" htmlFor={`${prefix}-enable`}><Input id={`${prefix}-enable`} data-testid={`${prefix}-enable`} type="checkbox" checked={draft.enabled} disabled={!editable} onChange={(event: ChangeEvent<HTMLInputElement>) => { if (usable()) session.current?.setEnabled(event.target.checked); }} /><span><strong>{custom ? t('image.settings.enableCustom') : t('image.settings.enableOpenai')}</strong><small>{t('image.settings.enableScope')}</small></span></Label>
        {custom && <>
          <Label htmlFor={`${prefix}-base-url`}>{t('image.settings.baseUrl')}</Label>
          <Input id={`${prefix}-base-url`} data-testid={`${prefix}-base-url`} type="text" value={draft.baseUrl} maxLength={CUSTOM_IMAGE_ENDPOINT_LIMIT} disabled={!editable} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://images.example.com/v1" onChange={(event: ChangeEvent<HTMLInputElement>) => { if (usable()) session.current?.setConfigurationField('baseUrl', event.target.value); }} />
          <p className="image-settings-help">{t('image.settings.baseUrlHelp')}</p>
          <Label htmlFor={`${prefix}-model`}>{t('image.settings.model')}</Label>
          <Input id={`${prefix}-model`} data-testid={`${prefix}-model`} type="text" value={draft.model} maxLength={120} disabled={!editable} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={t('image.settings.modelPlaceholder')} onChange={(event: ChangeEvent<HTMLInputElement>) => { if (usable()) session.current?.setConfigurationField('model', event.target.value); }} />
          <p className="image-settings-help">{t('image.settings.compatibility')}</p>
          {bindingChanged && snapshot.secret.configured && <p className="image-generation-notice" role="alert" data-testid={`${prefix}-binding-warning`}>{t('image.settings.bindingWarning')}</p>}
        </>}
        <div className="image-settings-fixed" data-testid={`${prefix}-fixed`}><strong>{custom ? t('image.settings.customFormat') : 'OpenAI · Images'}</strong><span data-testid={`${prefix}-destination`}>{destination || t('image.settings.destinationEmpty')}</span><span>{draft.model || t('image.settings.modelEmpty')}</span><span>{t('image.settings.fixedOutput')}</span><Badge className="small-badge neutral">{t('image.settings.unverified')}</Badge></div>
        <Label htmlFor={`${prefix}-key`}>{t('image.settings.key')}</Label>
        <Input ref={keyInput} id={`${prefix}-key`} data-testid={`${prefix}-key`} type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={IMAGE_SETTINGS_LIMITS.secretBytes} disabled={!editable || state.secretAction === 'remove'} placeholder={state.secretAction === 'remove' ? t('image.settings.removePlaceholder') : snapshot.secret.configured ? t('image.settings.keepPlaceholder') : custom ? t('image.settings.customKeyPlaceholder') : t('image.settings.openaiKeyPlaceholder')} onChange={(event: ChangeEvent<HTMLInputElement>) => { if (usable()) { setHasKey(Boolean(event.target.value)); reportNavigation(session.current?.getState() || state); setKeyNotice(''); } else if (keyInput.current) keyInput.current.value = ''; }} aria-describedby={`${prefix}-key-help`} />
        <p id={`${prefix}-key-help`} className="image-settings-help">{t('image.settings.keyHelp')}</p>
        <Label htmlFor={`${prefix}-storage`}>{t('image.settings.keyStorage')}</Label>
        <WorkbenchSelect id={`${prefix}-storage`} data-testid={`${prefix}-storage`} value={state.storage} disabled={!editable || state.secretAction === 'remove'} onChange={(event: {target: {value: string}}) => { if (usable()) session.current?.setStorage(event.target.value); }}><option value="" disabled>{t('image.settings.storageChoose')}</option><option value="session">{t('image.settings.storageSession')}</option><option value="persistent" disabled={!snapshot.storage.persistentAvailable}>{t(snapshot.storage.persistentAvailable ? 'connections.storage.persistent' : 'image.settings.persistentUnavailable')}</option></WorkbenchSelect>
        <p className="image-settings-help" data-testid={`${prefix}-storage-status`}>{imageStorageReason(snapshot.storage, t)}{snapshot.secret.configured && !hasKey ? t('image.settings.reenterStorage') : ''}</p>
        <div className="image-settings-current" data-testid={`${prefix}-current`}><span>{t('image.settings.currentState', { state: t(snapshot.configuration.enabled ? 'connections.enabled' : 'connections.disabled') })}</span><span>{t('image.settings.currentKey', { storage: snapshot.secret.configured ? storageLabel(snapshot.secret.storage, t) : t('connections.notConfigured') })}</span><span>{t('image.settings.revision', { revision: snapshot.revision })}</span></div>
        {snapshot.secret.configured && <Button type="button" variant="ghost" className="button" data-testid={`${prefix}-remove-key`} aria-pressed={state.secretAction === 'remove'} disabled={!editable} onClick={() => { if (usable()) { clearKey(); session.current?.removeKey(state.secretAction !== 'remove'); } }}>{state.secretAction === 'remove' ? t('image.settings.undoRemove') : t('image.settings.removeKey')}</Button>}
        <p className="image-settings-help" data-testid={`${prefix}-intent`}>{hasKey ? t(snapshot.secret.configured ? 'connections.intentReplace' : 'connections.intentWrite', { storage: storageLabel(state.storage, t) }) : t(state.secretAction === 'remove' ? 'connections.intentRemove' : snapshot.secret.configured ? 'connections.intentKeep' : 'image.settings.intentNoneFull')}</p>
        {state.recovery && <div className="image-generation-notice" data-testid={`${prefix}-recovery`}><p>{t('image.settings.recovery')}</p><div className="image-generation-actions"><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-reload`} disabled={!editable} onClick={() => { if (usable()) { clearKey(); void session.current?.reload(); } }}>{t('connections.reload')}</Button><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-use-latest`} disabled={!editable || state.phase === 'blocked'} onClick={() => { if (usable()) { clearKey(); session.current?.useLatest(); } }}>{t('connections.useSaved')}</Button><Button type="button" variant="ghost" className="button" data-testid={`${prefix}-keep-draft`} disabled={!editable || state.phase !== 'review'} onClick={() => { if (usable()) { clearKey(); session.current?.acknowledge(); } }}>{t('connections.keepDraft')}</Button></div></div>}
        <Button type="submit" variant="ghost" className="button primary" data-testid={`${prefix}-save`} disabled={!visible || !imageSettingsCanSave(state) || hasKey && !state.storage || bindingChanged && snapshot.secret.configured && !hasKey && state.secretAction !== 'remove'}>{state.phase === 'saving' ? t('connections.saving') : t('image.settings.save')}</Button>
      </>}
      {keyNotice && <p className="image-generation-notice" role="status" data-testid={`${prefix}-key-notice`}>{renderMessage(keyNotice)}</p>}
      {snapshot && state.message && <p className="image-generation-notice" role="status" data-testid={`${prefix}-message`}>{statusMessage}</p>}
    </form>
  </section>;
}
