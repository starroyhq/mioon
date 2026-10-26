import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import AgentAuthorizations from './AgentAuthorizations.tsx';
import AgentConnectionTest from './AgentConnectionTest.tsx';
import AgentTaskPolicy from './AgentTaskPolicy.tsx';
import type { AgentTaskPolicyController, AgentTaskPolicyNavigation } from './AgentTaskPolicy.tsx';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchBadge, WorkbenchButton, WorkbenchTabs } from '@mioon/ui/components/workbench-controls';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import Icon from './icons.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { closeSettingsAfterPermission, createSettingsNavigationReporter } from './settings-navigation-state.ts';
import { AGENT_PROTOCOLS, agentEndpointPreview, agentBindingChanged, agentSettingsBusy, agentSettingsCanSave, agentSettingsDirty, agentSettingsEditable,
  agentPresetLabel, agentPlatformLabel, agentPresetNote, createAgentSettingsSession, initialAgentSettingsState } from './agent-settings.ts';
import type { AgentConfiguration, AgentSettingsSnapshot, AgentSettingsState, SecretStorage, Translate } from './agent-settings.ts';
import type { AgentProtocol } from '../../../packages/contracts/src/agent-protocol.ts';

type AgentSettingsSession = ReturnType<typeof createAgentSettingsSession>;
type NavigationReporter = ReturnType<typeof createSettingsNavigationReporter>;
type NavigationInput = Parameters<NavigationReporter['update']>[0];
type AgentStorage = AgentSettingsSnapshot['storage'];
interface AgentSettingsProps {
  onClose: () => void;
  beforeClose?: Parameters<typeof closeSettingsAfterPermission>[0];
  closeLabel?: string;
  onNavigationStateChange?: Parameters<NavigationReporter['connect']>[0];
  /** The project the settings were opened from; the connection test runs there when it is set. */
  projectId?: string | null;
}
const storageLabels: Readonly<Record<string, string>> = {none: 'connections.storage.none', session: 'connections.storage.session', persistent: 'connections.storage.persistent'};
const storageLabel = (mode: SecretStorage | string, t: Translate): string => t((storageLabels[mode] ?? 'connections.storage.none') as Parameters<Translate>[0]);
const storageReasons: Readonly<Record<string, string>> = {
  WEB_SESSION_ONLY: 'connections.storage.webReason',
  LINUX_BASIC_TEXT: 'connections.storage.basicReason',
  OS_SECRET_STORE_UNAVAILABLE: 'connections.storage.unavailableReason',
};
const storageReason = (storage: AgentStorage | null | undefined, t: Translate): string => {
  const key = storage?.reasonCode === null || storage?.reasonCode === undefined ? undefined : storageReasons[storage.reasonCode];
  return key === undefined
    ? t(storage?.persistentAvailable ? 'connections.storage.availableReason' : 'connections.storage.fallbackReason')
    : t(key as Parameters<Translate>[0]);
};

/** Settings › Mio (07-09, 07-10). The settings center supplies the frame, title and close control. This page owns
 * the model connection, execution policy, step limit and authorized destinations, saved together from one footer. */
export default function AgentSettings({ onNavigationStateChange, projectId = null }: AgentSettingsProps) {
  const { t, renderMessage } = useI18n();
  const [state, setState] = useState<AgentSettingsState>(initialAgentSettingsState);
  const [hasKey, setHasKey] = useState(false);
  const [keyNotice, setKeyNotice] = useState<DisplayMessage | string>('');
  const visible = useWorkspaceVisibility();
  const interaction = useMemo(() => ({ visible }), [visible]), interactionRef = useRef<{visible: boolean} | null>(interaction);
  const keyInput = useRef<HTMLInputElement | null>(null), session = useRef<AgentSettingsSession | null>(null), dismissed = useRef(false), navigation = useRef<NavigationReporter | null>(null);
  const policyNavigation = useRef<AgentTaskPolicyNavigation>({dirty:false,busy:false,unknown:false}), policy = useRef<AgentTaskPolicyController | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [policyState, setPolicyState] = useState<AgentTaskPolicyNavigation>({dirty:false,busy:false,unknown:false});
  if (!navigation.current) navigation.current = createSettingsNavigationReporter();
  const navigationInput = (next: AgentSettingsState): NavigationInput => ({ dirty: agentSettingsDirty(next) || Boolean(keyInput.current?.value) || policyNavigation.current.dirty, phase: policyNavigation.current.busy ? 'saving' : next.phase, recovery: policyNavigation.current.unknown ? 'unknown' : next.recovery });
  const reportNavigation = (next: AgentSettingsState): void => { navigation.current!.update(navigationInput(next)); };
  useLayoutEffect(() => {
    const owner = navigation.current!.connect(onNavigationStateChange, navigationInput(session.current?.getState() || state));
    return () => navigation.current!.disconnect(owner);
  }, [onNavigationStateChange]);
  // The password lives only in the mounted input, never in a saved React state,
  // snapshot, browser store, project, or recovery payload.
  const clearKey = () => { if (keyInput.current) keyInput.current.value = ''; setHasKey(false); reportNavigation(session.current?.getState() || state); };
  useLayoutEffect(() => {
    dismissed.current = false;
    const current = createAgentSettingsSession({ onChange: (next: AgentSettingsState) => { if (!dismissed.current) { reportNavigation(next); setState(next); } } });
    session.current = current;
    void current.load();
    return () => { dismissed.current = true; if (keyInput.current) keyInput.current.value = ''; current.dispose(); if (session.current === current) session.current = null; };
  }, []);
  useLayoutEffect(() => {
    interactionRef.current = interaction; session.current?.setVisible(visible); reportNavigation(session.current?.getState() || state);
    if (!visible && keyInput.current?.value) { clearKey(); setKeyNotice(message('agent.settings.keyHidden')); }
  }, [interaction]);
  const usable = () => !dismissed.current && visible && interactionRef.current === interaction;
  const withClearKey = (action: () => void) => { if (!usable()) return; clearKey(); action(); };
  const changeBinding = (patch: Partial<AgentConfiguration>) => withClearKey(() => session.current?.edit(patch));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!usable()) return;
    const current = session.current?.getState() || state;
    if (agentSettingsDirty(current) || keyInput.current?.value) {
      if (!agentSettingsCanSave(current)) return;
      const value = keyInput.current?.value || '';
      clearKey(); // Clear the actual DOM synchronously, before dispatch or an await.
      setReplacing(false);
      void session.current?.save(value);
    }
    if (policyNavigation.current.dirty) void policy.current?.save();
  }
  function discard() {
    withClearKey(() => { setReplacing(false); if (agentSettingsDirty(session.current?.getState() || state)) session.current?.useLatest(); policy.current?.discard(); });
  }
  const { snapshot, draft, phase, recovery } = state;
  const busy = agentSettingsBusy(state), editable = visible && agentSettingsEditable(state);
  const preset = snapshot?.presets.find(item => item.id === draft?.presetId);
  const platform = preset?.platforms.find(item => item.id === draft?.platformId);
  const changedBinding = snapshot && draft && agentBindingChanged(snapshot.configuration, draft);
  const removesKey = state.secretAction === 'remove' || changedBinding;
  const connectionDirty = agentSettingsDirty(state) || hasKey, dirty = connectionDirty || policyState.dirty;
  const error = ['error', 'load_error', 'blocked', 'review'].includes(phase);
  const defaultsChanged = Boolean(platform && draft && (draft.baseUrl !== platform.baseUrl || draft.model !== platform.model || draft.protocol !== platform.defaultProtocol));
  const endpoint = agentEndpointPreview(draft as AgentConfiguration);
  const modelHints = draft ? platform?.supportedModelHints?.[draft.protocol] ?? [] : [];
  const modelNeedsReview = Boolean(draft && modelHints.length > 0 && !modelHints.includes(draft.model));
  const protocolNote = draft?.protocol === 'responses' && draft.presetId === 'qwen' ? t('agent.settings.presets.qwenResponses') : '';
  const statusMessage = state.displayMessages?.map(descriptor => renderMessage(descriptor)).join(' ') || '';
  // A saved key stays behind its status until the user chooses to replace it; a new destination needs a new key.
  const keyEntry = Boolean(snapshot && (!snapshot.secret.configured || replacing || changedBinding)) && state.secretAction !== 'remove';
  const saving = phase === 'saving' || policyState.busy, attention = error || policyState.unknown;
  const status = saving ? 'mio.settings.footer.saving' : attention ? 'mio.settings.footer.review' : dirty ? 'mio.settings.footer.unsaved' : 'mio.settings.footer.saved';
  const canSave = visible && !saving && (connectionDirty ? agentSettingsCanSave(state) : policyState.dirty);
  return <section className="agent-settings-page mio-settings" data-testid="agent-settings-page" data-phase={phase} aria-label={t('agent.settings.title')} hidden={!visible} inert={!visible}>
      <form noValidate autoComplete="off" onSubmit={submit} className="agent-settings-form">
        <div className="agent-settings-body">
          {!snapshot || !draft ? <div className="agent-settings-loading" role="status">{phase === 'loading' ? <><span className="spinner" />{t('agent.settings.loading')}</> : <><Icon name="info" size={24} /><p data-testid="agent-settings-error" role="alert">{statusMessage}</p><WorkbenchButton type="button" data-testid="agent-settings-reload" onClick={() => { if (usable()) void session.current?.load(); }}>{t('connections.reload')}</WorkbenchButton></>}</div> : <>
            <section className="mio-settings-section" aria-labelledby="agent-connection-heading">
              <header className="mio-settings-section-head"><h2 id="agent-connection-heading">{t('mio.settings.connection.title')}</h2><p>{t('agent.task.connectionIntro')}</p></header>
              <div className="mio-settings-rows">
                <div className="mio-settings-row"><Label htmlFor="agent-preset">{t('agent.settings.preset')}</Label><div className="mio-settings-control">
                  <WorkbenchSelect id="agent-preset" data-testid="agent-settings-preset" value={draft.presetId} disabled={!editable} onChange={(event: {target: {value: string}}) => withClearKey(() => session.current?.selectPreset(event.target.value))}>
                    {snapshot.presets.map(item => <option key={item.id} value={item.id}>{agentPresetLabel(item, t)}</option>)}
                  </WorkbenchSelect>
                  <p className="agent-settings-help" data-testid="agent-settings-preset-note">{agentPresetNote(preset, platform, t)}</p>
                  {Boolean(platform?.sources.length) && <div className="agent-settings-sources">{platform!.sources.map(source => snapshot.storage.sessionScope === 'app' ? <span className="agent-settings-source-reference" key={source.url}><span>{t('agent.settings.sourceCopy', { label: t('agent.settings.officialDocs') })}</span><span>{source.url}</span></span> : <a href={source.url} key={source.url} target="_blank" rel="noopener noreferrer">{t('agent.settings.officialDocs')}<Icon name="arrow" size={10} /></a>)}</div>}
                </div></div>
                {(preset?.platforms.length ?? 0) > 1 && <div className="mio-settings-row"><Label htmlFor="agent-platform">{t('agent.settings.platform')}</Label><div className="mio-settings-control">
                  <WorkbenchSelect id="agent-platform" data-testid="agent-settings-platform" value={draft.platformId} disabled={!editable} onChange={(event: {target: {value: string}}) => withClearKey(() => session.current?.selectPlatform(event.target.value))}>
                    {preset!.platforms.map(item => <option key={item.id} value={item.id}>{agentPlatformLabel(preset!.id, item, t)}</option>)}
                  </WorkbenchSelect>
                </div></div>}
                <div className="mio-settings-row"><Label htmlFor="agent-base-url">{t('mio.settings.label.baseUrl')}</Label><div className="mio-settings-control">
                  <Input id="agent-base-url" data-testid="agent-settings-base-url" value={draft.baseUrl} onChange={(event: ChangeEvent<HTMLInputElement>) => changeBinding({ baseUrl: event.target.value })} disabled={!editable} maxLength={2048} placeholder={platform?.baseUrlTemplate || 'https://api.example.com/v1'} type="url" spellCheck={false} autoCapitalize="none" aria-describedby="agent-endpoint-help" />
                  <p id="agent-endpoint-help" className="agent-settings-help">{t(draft.protocol === 'anthropic_messages' ? 'agent.settings.anthropicEndpointHelp' : 'agent.settings.endpointHelp')}</p>
                </div></div>
                <div className="mio-settings-row"><span className="mio-settings-label">{t('mio.settings.label.protocol')}</span><div className="mio-settings-control">
                  <WorkbenchTabs data-testid="agent-settings-protocol" value={draft.protocol} label={t('mio.settings.label.protocol')} onValueChange={(value: string) => { if (usable()) session.current?.edit({ protocol: value }); }}
                    options={Object.entries(AGENT_PROTOCOLS).map(([protocol, definition]) => ({ value: protocol, label: definition.label, disabled: !editable, testId: `agent-settings-protocol-${protocol}` }))} />
                  <p className="agent-settings-help" data-testid="agent-settings-endpoint">{t('agent.settings.endpointPreview', { protocol: AGENT_PROTOCOLS[draft.protocol as AgentProtocol]?.label || draft.protocol })} {endpoint || t('agent.settings.endpointEmpty')}</p>
                  <p className="agent-settings-help" data-testid="agent-settings-protocol-help">{t('agent.settings.protocolHelp')}</p>
                </div></div>
                <div className="mio-settings-row"><Label htmlFor="agent-model">{t('mio.settings.label.model')}</Label><div className="mio-settings-control">
                  <div className="mio-settings-inline"><Input id="agent-model" data-testid="agent-settings-model" value={draft.model} onChange={(event: ChangeEvent<HTMLInputElement>) => { if (usable()) session.current?.edit({ model: event.target.value }); }} disabled={!editable} maxLength={200} placeholder={t('agent.settings.modelPlaceholder')} spellCheck={false} autoCapitalize="none" />
                    {defaultsChanged && <WorkbenchButton type="button" variant="ghost" size="compact" data-testid="agent-settings-reset" disabled={!editable} onClick={() => withClearKey(() => session.current?.edit({ baseUrl: platform!.baseUrl, model: platform!.model, protocol: platform!.defaultProtocol }))}><Icon name="refresh" size={12} />{t('agent.settings.restorePreset')}</WorkbenchButton>}</div>
                  {draft.protocol === 'responses' && <p className={`agent-settings-help ${modelNeedsReview ? 'agent-settings-model-warning' : ''}`} data-testid="agent-settings-model-guidance">{modelHints.length ? t(modelNeedsReview ? 'agent.settings.modelReview' : 'agent.settings.modelHints', { models: modelHints.join(', ') }) : t('agent.settings.responsesCustom')}{' '}{protocolNote || t('agent.task.protocolScope')}</p>}
                  {draft.protocol === 'anthropic_messages' && <p className="agent-settings-help" data-testid="agent-settings-anthropic-guidance">{t('agent.settings.anthropicScope')}</p>}
                </div></div>
                <div className="mio-settings-row"><span className="mio-settings-label" id="agent-secret-heading">{t('mio.settings.label.key')}</span><div className="mio-settings-control" role="group" aria-labelledby="agent-secret-heading">
                  <div className="mio-settings-inline">
                    <WorkbenchBadge tone={state.secretAction === 'remove' ? 'warning' : snapshot.secret.configured && !changedBinding ? 'success' : 'neutral'} data-testid="agent-settings-secret-status" data-configured={snapshot.secret.configured} data-storage={snapshot.secret.storage}>{state.secretAction === 'remove' ? t('mio.settings.key.clearing') : snapshot.secret.configured && !changedBinding ? <><Icon name="check" size={12} />{t('mio.settings.key.configured')}</> : t('mio.settings.key.missing')}</WorkbenchBadge>
                    {snapshot.secret.configured && !changedBinding && state.secretAction !== 'remove' && !replacing && <WorkbenchButton type="button" variant="ghost" size="compact" data-testid="agent-settings-replace-key" disabled={!editable} onClick={() => { if (usable()) setReplacing(true); }}>{t('mio.settings.key.replace')}</WorkbenchButton>}
                    {replacing && <WorkbenchButton type="button" variant="ghost" size="compact" data-testid="agent-settings-cancel-replace" disabled={!editable} onClick={() => withClearKey(() => setReplacing(false))}>{t('common.cancel')}</WorkbenchButton>}
                    {snapshot.secret.configured && <WorkbenchButton type="button" variant={state.secretAction === 'remove' ? 'ghost' : 'danger-ghost'} size="compact" data-testid="agent-settings-remove-key" aria-pressed={state.secretAction === 'remove'} disabled={!editable} onClick={() => withClearKey(() => { setReplacing(false); session.current?.removeKey(state.secretAction !== 'remove'); })}>{state.secretAction === 'remove' ? t('connections.undoRemove') : t('mio.settings.key.clear')}</WorkbenchButton>}
                  </div>
                  {keyEntry && <div className="mio-settings-key-entry"><Label className="sr-only" htmlFor="agent-key">{snapshot.secret.configured ? t('agent.settings.replaceKey') : t('agent.settings.enterKey')}</Label>
                    <Input ref={keyInput} id="agent-key" data-testid="agent-settings-key" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" disabled={!editable} placeholder={snapshot.secret.configured && !changedBinding ? t('agent.settings.keepPlaceholder') : t('agent.settings.newKeyPlaceholder')} maxLength={8192} onChange={(event: ChangeEvent<HTMLInputElement>) => { if (usable()) { setHasKey(Boolean(event.target.value)); reportNavigation(session.current?.getState() || state); setKeyNotice(''); } }} aria-describedby="agent-key-help" />
                    <WorkbenchSelect id="agent-storage" data-testid="agent-settings-storage" aria-label={t('agent.settings.keyStorage')} value={state.storage} disabled={!editable} onChange={(event: {target: {value: string}}) => { if (usable()) session.current?.setStorage(event.target.value as 'session' | 'persistent'); }}>
                      <option value="session">{t(snapshot.storage.sessionScope === 'app' ? 'connections.storage.appSession' : 'connections.storage.serverSession')}</option><option value="persistent" disabled={!snapshot.storage.persistentAvailable}>{t(snapshot.storage.persistentAvailable ? 'connections.storage.persistent' : 'connections.storage.persistentUnavailable')}</option>
                    </WorkbenchSelect>
                    <p id="agent-key-help" className="agent-settings-help">{t('agent.settings.keyHelp')} <span data-testid="agent-settings-storage-status">{storageReason(snapshot.storage, t)} {!hasKey && snapshot.secret.configured && !removesKey ? t('agent.settings.reenterStorage') : ''}</span></p>
                  </div>}
                  {keyNotice && <p className="agent-settings-binding-warning" role="status" data-testid="agent-settings-key-cleared">{renderMessage(keyNotice)}</p>}
                  {changedBinding && <p className="agent-settings-binding-warning" data-testid="agent-settings-binding-warning"><Icon name="info" size={14} /><span>{t('agent.settings.bindingWarning')}</span></p>}
                  <p className="agent-settings-help" data-testid="agent-settings-key-intent">{hasKey ? t(snapshot.secret.configured ? 'connections.intentReplace' : 'connections.intentWrite', { storage: storageLabel(state.storage, t) }) : removesKey && snapshot.secret.configured ? t('connections.intentRemove') : snapshot.secret.configured ? t('agent.settings.serverKey', { storage: storageLabel(snapshot.secret.storage, t) }) : draft.presetId === 'ollama' ? t('agent.settings.intentOllama') : t('agent.settings.intentNoKey')}</p>
                </div></div>
                <div className="mio-settings-row"><span className="mio-settings-label">{t('mio.settings.label.test')}</span><div className="mio-settings-control">
                  <AgentConnectionTest visible={visible} configuration={snapshot.configuration} settingsRevision={snapshot.revision} blocked={connectionDirty || busy} projectId={projectId} />
                </div></div>
              </div>
              {state.message && <div className={`agent-settings-message ${error ? 'is-warning' : phase === 'saved' ? 'is-success' : ''}`} role={error ? 'alert' : 'status'} data-testid={error ? 'agent-settings-error' : 'agent-settings-status'} data-phase={phase}><Icon name={phase === 'saved' ? 'check' : 'info'} size={15} /><div><p>{statusMessage}</p>{recovery && <>
                <div className="agent-settings-current" data-testid="agent-settings-current"><span>{t('connections.serverSettings')}</span><strong>{snapshot.configuration.model}</strong><span>{AGENT_PROTOCOLS[snapshot.configuration.protocol].label}</span><span>{agentEndpointPreview(snapshot.configuration)}</span><span>{snapshot.secret.configured ? t('connections.savedKey', { storage: storageLabel(snapshot.secret.storage, t) }) : t('connections.storage.none')}</span></div>
                <div className="agent-settings-recovery-actions">{phase === 'blocked' ? <WorkbenchButton type="button" size="compact" data-testid="agent-settings-reload" onClick={() => { if (usable()) void session.current?.reload(); }}>{t('agent.settings.reloadState')}</WorkbenchButton> : <><WorkbenchButton type="button" size="compact" data-testid="agent-settings-review" disabled={busy} onClick={() => { if (usable()) session.current?.acknowledge(); }}>{t('agent.settings.reviewDone')}</WorkbenchButton><WorkbenchButton type="button" variant="ghost" size="compact" data-testid="agent-settings-use-latest" disabled={busy} onClick={() => withClearKey(() => session.current?.useLatest())}>{t('agent.settings.useServer')}</WorkbenchButton></>}</div>
              </>}</div></div>}
            </section>
            <AgentTaskPolicy visible={visible} controller={policy} onNavigationChange={next => {policyNavigation.current=next;setPolicyState(next);reportNavigation(session.current?.getState() || state);}}/>
            <AgentAuthorizations visible={visible}/>
          </>}
        </div>
        <footer className="settings-page-actions mio-settings-actions"><WorkbenchBadge dot tone={attention ? 'warning' : dirty || saving ? 'neutral' : 'success'} data-testid="agent-settings-footer-status">{t(status)}</WorkbenchBadge><div className="mio-settings-footer-buttons">
          <WorkbenchButton type="button" data-testid="agent-settings-cancel" disabled={!visible || saving || !dirty} onClick={discard}>{t('mio.settings.discard')}</WorkbenchButton>
          <WorkbenchButton type="submit" variant="primary" data-testid="agent-settings-save" loading={saving} disabled={!canSave}>{t('mio.settings.save')}</WorkbenchButton>
        </div></footer>
      </form>
  </section>;
}
