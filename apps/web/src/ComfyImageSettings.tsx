import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { closeSettingsAfterPermission, createSettingsNavigationReporter } from './settings-navigation-state.ts';
import { createComfyImageSettingsSession, initialComfyImageSettingsState, comfyImageSettingsEditable, comfyImageSettingsCanSave, comfyImageSettingsDirty, comfyImageDestination, comfyImageCheckDescriptor, comfyConnectorAvailable, comfyConnectorAvailabilityDescriptor } from './comfy-image-settings.ts';
import type { ComfyImageSettingsClient, ComfyImageSettingsSession, ComfyImageSettingsState } from './comfy-image-settings.ts';
import Icon from './icons.tsx';
import './image-settings.css';
import './comfy-image-settings.css';

const noop = (): void => {};
export interface ComfyImageSettingsProps {
  active?: boolean;
  contextKey?: unknown;
  client?: unknown;
  onSelectSlot?: (slot: string) => unknown;
  onRequestSelectSlot?: ((slot: string) => unknown) | null;
  onClose?: () => unknown;
  onSnapshot?: (snapshot: ComfyImageSettingsState['snapshot']) => unknown;
  onAvailability?: (availability: ComfyImageSettingsState['availability']) => unknown;
  onDirtyChange?: (dirty: boolean) => unknown;
  beforeClose?: (() => unknown) | undefined;
  closeLabel?: string;
  onNavigationStateChange?: Parameters<ReturnType<typeof createSettingsNavigationReporter>['connect']>[0];
}
interface ComfySettingsCallbacks { onSnapshot: NonNullable<ComfyImageSettingsProps['onSnapshot']>; onAvailability: NonNullable<ComfyImageSettingsProps['onAvailability']>; onDirtyChange: NonNullable<ComfyImageSettingsProps['onDirtyChange']> }

/** Independent local profile. Viewing and saving never check or start the runtime. */
export default function ComfyImageSettings({ active = false, contextKey, client, onSelectSlot = noop, onRequestSelectSlot, onClose = noop, onSnapshot = noop, onAvailability = noop, onDirtyChange = noop, beforeClose, closeLabel, onNavigationStateChange }: ComfyImageSettingsProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const [state, setState] = useState<ComfyImageSettingsState>(initialComfyImageSettingsState);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const ancestorVisible = useWorkspaceVisibility(), visible = ancestorVisible && active && pageVisible;
  const session = useRef<ComfyImageSettingsSession | null>(null), lifetime = useRef<{ closed: boolean } | null>(null), callbacks = useRef<ComfySettingsCallbacks>({ onSnapshot, onAvailability, onDirtyChange }), navigation = useRef<ReturnType<typeof createSettingsNavigationReporter> | null>(null);
  const interaction = useMemo(() => ({ visible, contextKey }), [visible, contextKey]), interactionRef = useRef<{ visible: boolean; contextKey: unknown } | null>(interaction);
  if (!navigation.current) navigation.current = createSettingsNavigationReporter();
  const nav = navigation.current;
  const navigationInput = (next: ComfyImageSettingsState) => ({ dirty: comfyImageSettingsDirty(next), phase: next.phase, recovery: next.recovery });
  const reportNavigation = (next: ComfyImageSettingsState): void => { nav.update(navigationInput(next)); };
  useLayoutEffect(() => {
    const owner = nav.connect(onNavigationStateChange, navigationInput(session.current?.getState() || state));
    return () => nav.disconnect(owner);
  }, [onNavigationStateChange]);
  useLayoutEffect(() => { callbacks.current = { onSnapshot, onAvailability, onDirtyChange }; });
  useLayoutEffect(() => {
    const owner = { closed: false }; lifetime.current = owner;
    const current = createComfyImageSettingsSession({ client: client as ComfyImageSettingsClient, onChange: next => { if (!owner.closed && lifetime.current === owner) { reportNavigation(next); setState(next); } }, onSnapshot: next => { if (!owner.closed && lifetime.current === owner) callbacks.current.onSnapshot(next); }, onAvailability: next => { if (!owner.closed && lifetime.current === owner) callbacks.current.onAvailability(next); } });
    session.current = current; void current.load();
    return () => { owner.closed = true; current.dispose(); if (session.current === current) session.current = null; callbacks.current.onDirtyChange(false); };
  }, [client]);
  useLayoutEffect(() => { interactionRef.current = interaction; session.current?.setVisible(visible); reportNavigation(session.current?.getState() || state); }, [interaction]);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const changed = () => { const shown = document.visibilityState !== 'hidden'; if (!shown) { interactionRef.current = null; session.current?.setVisible(false); reportNavigation(session.current?.getState() || state); } setPageVisible(shown); };
    document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useLayoutEffect(() => { callbacks.current.onDirtyChange(comfyImageSettingsDirty(state)); }, [state.snapshot, state.draft]);
  const owner = lifetime.current;
  const usable = (): boolean => Boolean(visible && interactionRef.current === interaction && owner && !owner.closed && lifetime.current === owner && (typeof document === 'undefined' || document.visibilityState !== 'hidden'));
  const leave = (action: () => unknown, permission: (() => unknown) | undefined): boolean | Promise<boolean> => {
    if (!usable()) return false;
    const captured = interactionRef.current, version = nav.getState().version;
    return closeSettingsAfterPermission(permission, () => usable() && interactionRef.current === captured && nav.getState().version === version, () => { interactionRef.current = null; session.current?.setVisible(false); action(); });
  };
  const { snapshot, draft, check } = state, editable = visible && comfyImageSettingsEditable(state);
  const checkedModels = check?.checkpoints || [], hasSavedModel = Boolean(draft?.model) && !checkedModels.includes(draft?.model ?? '');
  const statusMessage = state.displayMessages?.map(value => renderMessage(value as Parameters<typeof renderMessage>[0])).join(' ') || '';
  return <section className="image-settings-page comfy-image-settings-page" data-testid="comfy-image-settings-page" data-phase={state.phase} hidden={!visible} inert={!visible} aria-label={t('connections.comfy.aria')}>
    <header className="image-generation-heading"><div><span className="image-generation-eyebrow">{t('connections.comfy.eyebrow')}</span><h2>{t('image.settings.title')}</h2><p>{t('connections.comfy.subtitle')}</p></div><Button type="button" variant="ghost" className="button quiet" data-testid="comfy-image-settings-back" aria-label={closeLabel ?? t('connections.back')} disabled={!visible} onClick={() => leave(onClose, beforeClose)}><Icon name="left" size={14} />{closeLabel ?? t('connections.back')}</Button></header>
    <div className="image-settings-slots" role="group" aria-label={t('image.settings.slots')}>{([['official', t('image.settings.official')], ['custom', t('image.settings.custom')], ['comfy', t('image.settings.comfy')]] as const).map(([slot, label]) => <Button key={slot} type="button" variant="ghost" className="button" data-testid={`comfy-image-settings-slot-${slot}`} aria-pressed={slot === 'comfy'} disabled={!visible} onClick={() => { if (slot !== 'comfy') { if (onRequestSelectSlot) { if (usable()) onRequestSelectSlot(slot); } else leave(() => onSelectSlot(slot), undefined); } }}>{label}</Button>)}</div>
    <form className="image-settings-form" noValidate autoComplete="off" onSubmit={event => { event.preventDefault(); if (usable()) void session.current?.save(); }}>
      <p className="image-settings-help">{t('connections.comfy.scope')}</p>
      <div className="image-generation-notice" role="status" data-testid="comfy-image-settings-module" data-state={state.availability?.state || 'unknown'}><p>{renderMessage(comfyConnectorAvailabilityDescriptor(state.availability))}</p><span>{t('connections.comfy.moduleScope')}</span><Button type="button" variant="ghost" className="button" data-testid="comfy-image-settings-module-refresh" disabled={!editable || state.availabilityPhase === 'loading'} onClick={() => { if (usable()) void session.current?.refreshAvailability(); }}>{t('connections.comfy.reloadModule')}</Button></div>
      {!snapshot ? <div role="status"><p>{state.phase === 'loading' ? t('connections.comfy.loading') : statusMessage}</p>{state.phase !== 'loading' && <Button type="button" variant="ghost" className="button" data-testid="comfy-image-settings-load" disabled={!visible} onClick={() => { if (usable()) void session.current?.load(); }}>{t('connections.reload')}</Button>}</div> : <>
        <Label className="image-settings-enable" htmlFor="comfy-image-settings-enable"><Input id="comfy-image-settings-enable" data-testid="comfy-image-settings-enable" type="checkbox" checked={draft?.enabled} disabled={!editable} onChange={event => { if (usable()) session.current?.setEnabled(event.target.checked); }} /><span><strong>{t('connections.comfy.enable')}</strong><small>{t('connections.comfy.enableScope')}</small></span></Label>
        <Label htmlFor="comfy-image-settings-base-url">{t('connections.comfy.baseUrl')}</Label>
        <Input id="comfy-image-settings-base-url" data-testid="comfy-image-settings-base-url" type="text" value={draft?.baseUrl} maxLength={64} disabled={!editable} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="http://127.0.0.1:8188" onChange={event => { if (usable()) session.current?.setBaseUrl(event.target.value); }} />
        <p className="image-settings-help">{t('connections.comfy.endpointHelp')}</p>
        <Button type="button" variant="ghost" className="button" data-testid="comfy-image-settings-check" disabled={!editable || !comfyConnectorAvailable(state.availability) || !draft?.baseUrl || Boolean(state.recovery)} onClick={() => { if (usable()) void session.current?.checkConnection(); }}>{state.phase === 'checking' ? t('connections.comfy.checking') : t('connections.comfy.check')}</Button>
        <p className="image-settings-help">{t('connections.comfy.checkScope')}</p>
        <p className="image-generation-notice" role="status" data-testid="comfy-image-settings-readiness">{renderMessage(comfyImageCheckDescriptor(check))}</p>
        <Label htmlFor="comfy-image-settings-model">{t('connections.comfy.model')}</Label>
        <WorkbenchSelect id="comfy-image-settings-model" data-testid="comfy-image-settings-model" value={draft?.model} disabled={!editable || !check || !checkedModels.length} onChange={event => { if (usable()) session.current?.selectModel(event.target.value); }}><option value="">{t('connections.comfy.chooseModel')}</option>{hasSavedModel && draft && <option value={draft.model} disabled>{t('connections.comfy.savedModel', { model: draft.model })}</option>}{checkedModels.map(model => <option key={model} value={model}>{model}</option>)}</WorkbenchSelect>
        <p className="image-settings-help">{t('connections.comfy.modelScope')}</p>
        <div className="image-settings-fixed" data-testid="comfy-image-settings-fixed"><strong>{t('connections.comfy.workflow')}</strong><span>{String(draft?.profileId ?? '')}</span><span>{comfyImageDestination(draft) || t('image.settings.destinationEmpty')}</span><span>{t('connections.comfy.output')}</span><span>{t('connections.comfy.seed')}</span><Badge className="small-badge neutral">{t('connections.comfy.unsandboxed')}</Badge></div>
        <div className="image-settings-current"><span>{t(snapshot.configuration.enabled ? 'connections.comfy.savedEnabled' : 'connections.comfy.savedDisabled', { revision: snapshot.revision })}</span><span>{t('connections.comfy.saveScope')}</span></div>
        {state.recovery && <div className="image-generation-notice" data-testid="comfy-image-settings-recovery"><p>{t('connections.comfy.recovery')}</p><div className="image-generation-actions"><Button type="button" variant="ghost" className="button" disabled={!editable} onClick={() => { if (usable()) void session.current?.reload(); }}>{t('connections.reload')}</Button><Button type="button" variant="ghost" className="button" disabled={!editable || state.phase === 'blocked'} onClick={() => { if (usable()) session.current?.useLatest(); }}>{t('connections.useSaved')}</Button><Button type="button" variant="ghost" className="button" disabled={!editable || state.phase !== 'review'} onClick={() => { if (usable()) session.current?.acknowledge(); }}>{t('connections.keepDraft')}</Button></div></div>}
        <Button type="submit" variant="ghost" className="button primary" data-testid="comfy-image-settings-save" disabled={!visible || !comfyImageSettingsCanSave(state)}>{state.phase === 'saving' ? t('connections.saving') : t('connections.comfy.save')}</Button>
      </>}
      {snapshot && state.message && <p className="image-generation-notice" role="status" data-testid="comfy-image-settings-message">{statusMessage}</p>}
    </form>
  </section>;
}
