import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect, WorkbenchTooltip } from './WorkspaceControls.jsx';
import Icon from './icons.jsx';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { closeSettingsAfterPermission, createSettingsNavigationReporter } from './settings-navigation-state.ts';
import { AGENT_PROTOCOLS, agentEndpointPreview, agentBindingChanged, agentSettingsBusy, agentSettingsCanSave, agentSettingsDirty, agentSettingsEditable,
  agentPresetLabel, agentPlatformLabel, agentPresetNote, createAgentSettingsSession, initialAgentSettingsState } from './agent-settings.js';

const storageLabel = (mode, t) => ({ none: t('connections.storage.none'), session: t('connections.storage.session'), persistent: t('connections.storage.persistent') }[mode] || t('connections.storage.none'));
const storageReason = (storage, t) => ({
  WEB_SESSION_ONLY: t('connections.storage.webReason'),
  LINUX_BASIC_TEXT: t('connections.storage.basicReason'),
  OS_SECRET_STORE_UNAVAILABLE: t('connections.storage.unavailableReason'),
}[storage?.reasonCode] || (storage?.persistentAvailable ? t('connections.storage.availableReason') : t('connections.storage.fallbackReason')));

export default function AgentSettings({ onClose, beforeClose, closeLabel, onNavigationStateChange }) {
  const { t, renderMessage } = useI18n();
  const [state, setState] = useState(initialAgentSettingsState);
  const [hasKey, setHasKey] = useState(false);
  const [keyNotice, setKeyNotice] = useState('');
  const visible = useWorkspaceVisibility();
  const interaction = useMemo(() => ({ visible }), [visible]), interactionRef = useRef(interaction);
  const keyInput = useRef(null), session = useRef(null), dismissed = useRef(false), navigation = useRef(null);
  if (!navigation.current) navigation.current = createSettingsNavigationReporter();
  const navigationInput = next => ({ dirty: agentSettingsDirty(next) || Boolean(keyInput.current?.value), phase: next.phase, recovery: next.recovery });
  const reportNavigation = next => navigation.current.update(navigationInput(next));
  useLayoutEffect(() => {
    const owner = navigation.current.connect(onNavigationStateChange, navigationInput(session.current?.getState() || state));
    return () => navigation.current.disconnect(owner);
  }, [onNavigationStateChange]);
  // The password lives only in the mounted input, never in a saved React state,
  // snapshot, browser store, project, or recovery payload.
  const clearKey = () => { if (keyInput.current) keyInput.current.value = ''; setHasKey(false); reportNavigation(session.current?.getState() || state); };
  useLayoutEffect(() => {
    dismissed.current = false;
    const current = createAgentSettingsSession({ onChange: next => { if (!dismissed.current) { reportNavigation(next); setState(next); } } });
    session.current = current;
    void current.load();
    return () => { dismissed.current = true; if (keyInput.current) keyInput.current.value = ''; current.dispose(); if (session.current === current) session.current = null; };
  }, []);
  useLayoutEffect(() => {
    interactionRef.current = interaction; session.current?.setVisible(visible); reportNavigation(session.current?.getState() || state);
    if (!visible && keyInput.current?.value) { clearKey(); setKeyNotice(message('agent.settings.keyHidden')); }
  }, [interaction]);
  const usable = () => !dismissed.current && visible && interactionRef.current === interaction;
  const dismiss = () => {
    if (!usable()) return;
    const captured = interactionRef.current, version = navigation.current.getState().version;
    return closeSettingsAfterPermission(beforeClose, () => usable() && interactionRef.current === captured && navigation.current.getState().version === version, () => {
      if (keyInput.current?.value) setKeyNotice(message('agent.settings.keyLeft')); clearKey(); interactionRef.current = null; session.current?.setVisible(false); onClose();
    });
  };
  const withClearKey = action => { if (!usable()) return; clearKey(); action(); };
  const changeBinding = patch => withClearKey(() => session.current?.edit(patch));
  function submit(event) {
    event.preventDefault();
    if (!usable() || !agentSettingsCanSave(session.current?.getState() || state)) return;
    const value = keyInput.current?.value || '';
    clearKey(); // Clear the actual DOM synchronously, before dispatch or an await.
    void session.current?.save(value);
  }
  const { snapshot, draft, phase, recovery } = state;
  const busy = agentSettingsBusy(state), editable = visible && agentSettingsEditable(state);
  const preset = snapshot?.presets.find(item => item.id === draft?.presetId);
  const platform = preset?.platforms.find(item => item.id === draft?.platformId);
  const changedBinding = snapshot && draft && agentBindingChanged(snapshot.configuration, draft);
  const removesKey = state.secretAction === 'remove' || changedBinding;
  const dirty = agentSettingsDirty(state) || hasKey;
  const error = ['error', 'load_error', 'blocked', 'review'].includes(phase);
  const defaultsChanged = platform && (draft.baseUrl !== platform.baseUrl || draft.model !== platform.model || draft.protocol !== platform.defaultProtocol);
  const endpoint = agentEndpointPreview(draft);
  const modelHints = platform?.supportedModelHints?.[draft?.protocol] || [];
  const modelNeedsReview = modelHints.length > 0 && !modelHints.includes(draft.model);
  const protocolNote = draft?.protocol === 'responses' && draft?.presetId === 'qwen' ? t('agent.settings.presets.qwenResponses') : '';
  const statusMessage = state.displayMessages?.map(renderMessage).join(' ') || '';
  return <section className="agent-settings-page" data-testid="agent-settings-page" data-phase={phase} aria-label={t('agent.settings.title')} hidden={!visible} inert={!visible}>
      <header className="modal-header agent-settings-header">
        <div className="agent-settings-heading"><span className="agent-settings-symbol"><Icon name="sparkle" size={22} /></span><div>
          <div className="agent-settings-eyebrow">{t('agent.settings.eyebrow')}</div><h2>{t('agent.settings.title')}</h2>
          <p>{t('agent.settings.intro')}</p>
        </div></div>
        <Button type="button" variant="ghost" className="icon-button" aria-label={closeLabel ?? t('agent.settings.backAgent')} data-testid="agent-settings-back" disabled={!visible} onClick={dismiss}><Icon name="left" /></Button>
      </header>
      <form noValidate autoComplete="off" onSubmit={submit} className="agent-settings-form">
        <div className="agent-settings-body">
          <div className="agent-settings-disclosure"><Icon name="info" size={15} /><span>{t('agent.settings.saveScope')}</span><Badge className="small-badge neutral">{t('agent.settings.unverified')}</Badge></div>
          {!snapshot ? <div className="agent-settings-loading" role="status">{phase === 'loading' ? <><span className="spinner" />{t('agent.settings.loading')}</> : <><Icon name="info" size={24} /><p data-testid="agent-settings-error" role="alert">{statusMessage}</p><Button type="button" variant="ghost" className="button" data-testid="agent-settings-reload" onClick={() => { if (usable()) void session.current?.load(); }}>{t('connections.reload')}</Button></>}</div> : <>
            <section className="agent-settings-section" aria-labelledby="agent-connection-heading">
              <div className="agent-settings-section-title"><h3 id="agent-connection-heading">{t('agent.settings.modelService')}</h3><span>{t('agent.settings.presetHelp')}</span></div>
              <div className="agent-settings-grid">
                <div className="agent-settings-field"><Label htmlFor="agent-preset">{t('agent.settings.preset')}</Label>
                  <WorkbenchSelect id="agent-preset" data-testid="agent-settings-preset" value={draft.presetId} disabled={!editable} onChange={event => withClearKey(() => session.current?.selectPreset(event.target.value))}>
                    {snapshot.presets.map(item => <option key={item.id} value={item.id}>{agentPresetLabel(item, t)}</option>)}
                  </WorkbenchSelect>
                </div>
                <div className="agent-settings-field"><Label htmlFor="agent-platform">{t('agent.settings.platform')}</Label>
                  <WorkbenchSelect id="agent-platform" data-testid="agent-settings-platform" value={draft.platformId} disabled={!editable} onChange={event => withClearKey(() => session.current?.selectPlatform(event.target.value))}>
                    {(preset?.platforms || []).map(item => <option key={item.id} value={item.id}>{agentPlatformLabel(preset.id, item, t)}</option>)}
                  </WorkbenchSelect>
                </div>
                <div className="agent-settings-field agent-settings-full"><Label htmlFor="agent-protocol">{t('agent.settings.protocol')}</Label>
                  <WorkbenchSelect id="agent-protocol" data-testid="agent-settings-protocol" value={draft.protocol} disabled={!editable} onChange={event => { if (usable()) session.current?.edit({ protocol: event.target.value }); }}>
                    {(platform?.availableProtocols || []).map(protocol => <option key={protocol} value={protocol}>{AGENT_PROTOCOLS[protocol].label}</option>)}
                  </WorkbenchSelect>
                  <p className="agent-settings-help">{t('agent.settings.protocolHelp')}</p>
                </div>
                <div className="agent-settings-field agent-settings-full"><Label htmlFor="agent-base-url">{t('agent.settings.baseUrl')}{' '}<span>Base URL</span></Label>
                  <Input id="agent-base-url" data-testid="agent-settings-base-url" value={draft.baseUrl} onChange={event => changeBinding({ baseUrl: event.target.value })} disabled={!editable} maxLength={2048} placeholder={platform?.baseUrlTemplate || 'https://api.example.com/v1'} type="url" spellCheck={false} autoCapitalize="none" aria-describedby="agent-endpoint-help" />
                  <p id="agent-endpoint-help" className="agent-settings-help">{t('agent.settings.endpointHelp')}</p>
                </div>
                <div className="agent-settings-field agent-settings-full"><div className="agent-settings-label-row"><Label htmlFor="agent-model">{t('agent.settings.modelName')}{' '}<span>Model ID</span></Label><Button type="button" variant="ghost" className="text-button" data-testid="agent-settings-reset" disabled={!editable || !defaultsChanged} onClick={() => withClearKey(() => session.current?.edit({ baseUrl: platform.baseUrl, model: platform.model, protocol: platform.defaultProtocol }))}><Icon name="refresh" size={12} />{t('agent.settings.restorePreset')}</Button></div>
                  <Input id="agent-model" data-testid="agent-settings-model" value={draft.model} onChange={event => { if (usable()) session.current?.edit({ model: event.target.value }); }} disabled={!editable} maxLength={200} placeholder={t('agent.settings.modelPlaceholder')} spellCheck={false} autoCapitalize="none" />
                  {draft.protocol === 'responses' && <p className={`agent-settings-help ${modelNeedsReview ? 'agent-settings-model-warning' : ''}`} data-testid="agent-settings-model-guidance">{modelHints.length ? t(modelNeedsReview ? 'agent.settings.modelReview' : 'agent.settings.modelHints', { models: modelHints.join(', ') }) : t('agent.settings.responsesCustom')}{' '}{protocolNote || t('agent.settings.responsesScope')}</p>}
                </div>
                <div className="agent-settings-endpoint agent-settings-full" data-testid="agent-settings-endpoint"><span>{t('agent.settings.endpointPreview', { protocol: AGENT_PROTOCOLS[draft.protocol]?.label || draft.protocol })}</span><p>{endpoint || t('agent.settings.endpointEmpty')}</p></div>
              </div>
              <div className="agent-settings-preset-note" data-testid="agent-settings-preset-note"><p>{agentPresetNote(preset, platform, t)}</p><p>{t('agent.settings.presetWarning')}</p>{Boolean(platform?.sources.length) && <div className="agent-settings-sources">{platform.sources.map(source => snapshot.storage.sessionScope === 'app' ? <span className="agent-settings-source-reference" key={source.url}><span>{t('agent.settings.sourceCopy', { label: t('agent.settings.officialDocs') })}</span><span>{source.url}</span></span> : <a href={source.url} key={source.url} target="_blank" rel="noopener noreferrer">{t('agent.settings.officialDocs')}<Icon name="arrow" size={10} /></a>)}</div>}</div>
            </section>
            <section className="agent-settings-secret-section" aria-labelledby="agent-secret-heading">
              <div className="agent-settings-section-title"><h3 id="agent-secret-heading"><Icon name="lock" size={14} />{t('connections.apiKey')}</h3><span data-testid="agent-settings-secret-status" data-configured={snapshot.secret.configured} data-storage={snapshot.secret.storage}>{snapshot.secret.configured ? t('agent.settings.serverKey', { storage: storageLabel(snapshot.secret.storage, t) }) : t('agent.settings.noServerKey')}</span></div>
              <div className="agent-settings-field"><Label className="sr-only" htmlFor="agent-key">{snapshot.secret.configured ? t('agent.settings.replaceKey') : t('agent.settings.enterKey')}</Label>
                <Input ref={keyInput} id="agent-key" data-testid="agent-settings-key" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" disabled={!editable || state.secretAction === 'remove'} placeholder={state.secretAction === 'remove' ? t('agent.settings.removePlaceholder') : snapshot.secret.configured && !changedBinding ? t('agent.settings.keepPlaceholder') : t('agent.settings.newKeyPlaceholder')} maxLength={8192} onChange={event => { if (usable()) { setHasKey(Boolean(event.target.value)); reportNavigation(session.current?.getState() || state); setKeyNotice(''); } }} aria-describedby="agent-key-help" />
                <p id="agent-key-help" className="agent-settings-help">{t('agent.settings.keyHelp')}</p>
              </div>
              {keyNotice && <p className="agent-settings-binding-warning" role="status" data-testid="agent-settings-key-cleared">{renderMessage(keyNotice)}</p>}
              {changedBinding && <div className="agent-settings-binding-warning" data-testid="agent-settings-binding-warning"><Icon name="info" size={14} /><span>{t('agent.settings.bindingWarning')}</span></div>}
              <div className="agent-settings-key-actions"><div className="agent-settings-field"><Label htmlFor="agent-storage">{t('agent.settings.keyStorage')}</Label>
                <WorkbenchSelect id="agent-storage" data-testid="agent-settings-storage" value={state.storage} disabled={!editable || state.secretAction === 'remove'} onChange={event => { if (usable()) session.current?.setStorage(event.target.value); }}>
                  <option value="session">{t(snapshot.storage.sessionScope === 'app' ? 'connections.storage.appSession' : 'connections.storage.serverSession')}</option><option value="persistent" disabled={!snapshot.storage.persistentAvailable}>{t(snapshot.storage.persistentAvailable ? 'connections.storage.persistent' : 'connections.storage.persistentUnavailable')}</option>
                </WorkbenchSelect>
              </div>{snapshot.secret.configured && <WorkbenchTooltip content={state.secretAction === 'remove' ? t('agent.settings.undoRemoveHint') : t('agent.settings.removeHint')}><Button type="button" variant="ghost" className={`button small ${state.secretAction === 'remove' ? '' : 'danger-text'}`} data-testid="agent-settings-remove-key" aria-pressed={state.secretAction === 'remove'} disabled={!editable} onClick={() => withClearKey(() => session.current?.removeKey(state.secretAction !== 'remove'))}>{state.secretAction === 'remove' ? t('connections.undoRemove') : t('connections.removeKey')}</Button></WorkbenchTooltip>}</div>
              <p className="agent-settings-storage-note" data-testid="agent-settings-storage-status">{storageReason(snapshot.storage, t)} {!hasKey && snapshot.secret.configured && !removesKey ? t('agent.settings.reenterStorage') : ''}</p>
              <div className="agent-settings-key-intent" data-testid="agent-settings-key-intent">{hasKey ? t(snapshot.secret.configured ? 'connections.intentReplace' : 'connections.intentWrite', { storage: storageLabel(state.storage, t) }) : removesKey && snapshot.secret.configured ? t('connections.intentRemove') : snapshot.secret.configured ? t('connections.intentKeep') : draft.presetId === 'ollama' ? t('agent.settings.intentOllama') : t('agent.settings.intentNoKey')}</div>
            </section>
            {state.message && <div className={`agent-settings-message ${error ? 'is-warning' : phase === 'saved' ? 'is-success' : ''}`} role={error ? 'alert' : 'status'} data-testid={error ? 'agent-settings-error' : 'agent-settings-status'} data-phase={phase}><Icon name={phase === 'saved' ? 'check' : 'info'} size={15} /><div><p>{statusMessage}</p>{recovery && <>
              <div className="agent-settings-current" data-testid="agent-settings-current"><span>{t('connections.serverSettings')}</span><strong>{snapshot.configuration.model}</strong><span>{AGENT_PROTOCOLS[snapshot.configuration.protocol].label}</span><span>{agentEndpointPreview(snapshot.configuration)}</span><span>{snapshot.secret.configured ? t('connections.savedKey', { storage: storageLabel(snapshot.secret.storage, t) }) : t('connections.storage.none')}</span></div>
              <div className="agent-settings-recovery-actions">{phase === 'blocked' ? <Button type="button" variant="ghost" className="button small" data-testid="agent-settings-reload" onClick={() => { if (usable()) void session.current?.reload(); }}>{t('agent.settings.reloadState')}</Button> : <><Button type="button" variant="ghost" className="button small" data-testid="agent-settings-review" disabled={busy} onClick={() => { if (usable()) session.current?.acknowledge(); }}>{t('agent.settings.reviewDone')}</Button><Button type="button" variant="ghost" className="text-button" data-testid="agent-settings-use-latest" disabled={busy} onClick={() => withClearKey(() => session.current?.useLatest())}>{t('agent.settings.useServer')}</Button></>}</div>
            </>}</div></div>}
          </>}
        </div>
        <footer className="agent-settings-footer"><span>{phase === 'saving' ? t('agent.settings.leaveSaving', { action: closeLabel ?? t('agent.settings.backChat') }) : dirty ? t('connections.unsaved') : t('agent.settings.singleConnection')}</span><div><Button type="button" variant="ghost" className="button" data-testid="agent-settings-cancel" disabled={!visible} onClick={dismiss}>{closeLabel ?? t('agent.settings.backChat')}</Button><Button type="submit" variant="ghost" className="button primary" data-testid="agent-settings-save" disabled={!visible || !agentSettingsCanSave(state) || !dirty}>{phase === 'saving' ? <span className="spinner" /> : <Icon name="check" size={15} />}{phase === 'saving' ? t('agent.settings.saving') : t('agent.settings.save')}</Button></div></footer>
      </form>
  </section>;
}
