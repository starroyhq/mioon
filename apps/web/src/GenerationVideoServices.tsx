import React, {useLayoutEffect, useRef, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {Input} from '@mioon/ui/components/input';
import {Textarea} from '@mioon/ui/components/textarea';
import {useConfirmation} from '@mioon/ui/components/workbench-confirm';
import {message} from '../../../packages/i18n/src/index.ts';
import type {MessageKey} from '../../../packages/i18n/src/index.ts';
import {VIDEO_PROVIDER_NAMES, VIDEO_REGIONS, defaultVideoModels} from '../../../packages/contracts/src/video-providers.ts';
import type {DraftServiceProbeResult} from '../../../packages/contracts/src/draft-service-probe.ts';
import type {VideoModelsListInput} from '../../../packages/contracts/src/generation-video-settings.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import {WorkbenchSelect} from './WorkspaceControls.tsx';
import {ModelEditor} from './VideoProviderSettings.tsx';
import {useSettingsServicesPanel} from './SettingsServicesLayout.tsx';
import {createSettingsNavigationReporter} from './settings-navigation-state.ts';
import {compatibleServiceHost, createVideoSettingsClient, videoDraftProbeInput, videoSettingsRequestEndpoint} from './video-settings.ts';
import type {VideoSettingsClient} from './video-settings.ts';
import {createGenerationVideoServicesSession, generationVideoAvailable, generationVideoBusy, generationVideoDirty, generationVideoDraftDirty, initialGenerationVideoState} from './generation-video-services.ts';
import type {GenerationVideoDraft, GenerationVideoServicesSession, GenerationVideoState} from './generation-video-services.ts';
import type {GenerationServiceDomain, GenerationServiceDomainOptions} from './generation-services-settings.ts';
import './video-settings.css';

const regions: Record<string, MessageKey> = {global: 'video.providers.region.global', 'cn-beijing': 'video.providers.region.beijing', 'ap-southeast-1': 'video.providers.region.singapore', cn: 'video.providers.region.cn', custom: 'video.providers.region.custom'};
const documentVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
type ProbeOperation = VideoModelsListInput['operation'];
interface ProbeDisplay {operation: ProbeOperation; draft: boolean; result: DraftServiceProbeResult}
interface DetailProps {
  draft: GenerationVideoDraft;
  state: GenerationVideoState;
  session: GenerationVideoServicesSession | null;
  client: VideoSettingsClient;
  registerKey(key: string, element: HTMLInputElement | null): void;
  registerCheckCancel(key: string, cancel: (() => void) | null): void;
  clearKey(key: string): void;
  clearAllKeys(): void;
  onCheckBusy(key: string, value: boolean): void;
  interactionAllowed(): boolean;
  onDeleted(): void;
}
function VideoServiceDetail(props: DetailProps) {
  const {t} = useI18n(), confirm = useConfirmation(), panel = useSettingsServicesPanel();
  const {draft, state, session} = props, configuration = draft.configuration;
  const keyInput = useRef<HTMLInputElement | null>(null), mounted = useRef(false), current = useRef(props), active = useRef(false), checkEpoch = useRef(0), abort = useRef<AbortController | null>(null);
  const [checking, setChecking] = useState(false), [check, setCheck] = useState<ProbeDisplay | null>(null);
  const checkText = ({operation, result}: ProbeDisplay): string => {
    const status = String(result.httpStatus ?? '');
    switch (result.result) {
      case 'ok': return operation === 'models' ? result.models?.length
        ? t('settings.draftKey.modelCount', {count: result.models.length}) : t('settings.draftKey.modelsEmpty') : t('settings.draftKey.success');
      case 'unauthorized': return status ? t('video.providers.check.unauthorized', {status}) : t('settings.draftKey.unauthorized');
      case 'unsupported': return t(operation === 'models' ? 'settings.draftKey.listUnsupported' : 'settings.draftKey.unavailable');
      case 'denied': return t('video.providers.check.denied');
      case 'unreachable': return t('video.providers.check.unreachable');
      case 'http_error': return t('video.providers.check.httpError', {status});
      default: return t('settings.draftKey.failed');
    }
  };
  current.current = props; active.current = panel.active;
  const interactionAllowed = () => mounted.current && active.current && documentVisible() && current.current.session === session && current.current.interactionAllowed();
  const usable = () => interactionAllowed() && Boolean(current.current.session?.canEdit());
  const invalidate = () => {++checkEpoch.current; abort.current?.abort(); abort.current = null; setChecking(false); setCheck(null); current.current.onCheckBusy(draft.key, false);};
  useLayoutEffect(() => {mounted.current = true; props.registerCheckCancel(draft.key, invalidate); return () => {mounted.current = false; ++checkEpoch.current; abort.current?.abort(); current.current.registerCheckCancel(draft.key, null); current.current.onCheckBusy(draft.key, false);};}, []);
  useLayoutEffect(() => {if (!panel.active) invalidate();}, [panel.active]);
  useLayoutEffect(() => {invalidate();}, [state.phase, state.editorEpoch, configuration.region, configuration.workspaceId, configuration.baseUrl]);
  const change = (patch: Partial<typeof configuration>) => {
    if (!usable()) return; invalidate();
    if (patch.region !== undefined || patch.workspaceId !== undefined || patch.baseUrl !== undefined) props.clearKey(draft.key);
    session?.update(draft.key, patch);
  };
  const saved = state.snapshot?.connections.find(view => view.configuration.id === configuration.id);
  const probeAvailable = draft.hasKey || Boolean(videoDraftProbeInput('check', configuration, draft.secretAction, '', saved, state.snapshot?.storage.persistentAvailable));
  const checkable = panel.active && documentVisible() && props.interactionAllowed() && Boolean(session?.canEdit())
    && !checking && Boolean(videoSettingsRequestEndpoint(configuration)) && probeAvailable;
  const canCheck = Boolean(props.client.modelsList || configuration.providerId === 'compatible' && props.client.check);
  const runProbe = async (operation: ProbeOperation): Promise<DraftServiceProbeResult | null> => {
    const latest = current.current, owner = latest.session;
    if (!usable() || abort.current || !owner) return null;
    const observed = owner.getState();
    const selected = observed.drafts.find(entry => entry.key === latest.draft.key);
    if (!selected) return null;
    const savedView = observed.snapshot?.connections.find(view => view.configuration.id === selected.configuration.id);
    const input = videoDraftProbeInput(operation, selected.configuration, selected.secretAction,
      keyInput.current?.value ?? '', savedView, observed.snapshot?.storage.persistentAvailable);
    if (!input) return null;
    const probe = latest.client.modelsList;
    const legacy = !probe && operation === 'check' && input.providerId === 'compatible' ? latest.client.check : undefined;
    if (!probe && !legacy) return null;
    const token = ++checkEpoch.current, controller = new AbortController();
    abort.current = controller;
    setCheck(null); setChecking(true); props.onCheckBusy(draft.key, true);
    const publishable = () => interactionAllowed() && current.current.session === owner && token === checkEpoch.current && abort.current === controller;
    try {
      const result = probe ? await probe(input, controller.signal) : await legacy!(input.source === 'draft'
        ? {source: 'draft', baseUrl: input.baseUrl!, value: input.value}
        : {source: 'saved', connectionId: input.connectionId, configurationRevision: input.configurationRevision}, controller.signal);
      if (!publishable()) return null;
      setCheck({operation, draft: input.source === 'draft', result});
      return result;
    } catch {
      if (publishable()) setCheck({operation, draft: input.source === 'draft', result: {result: 'failed'}});
      return null;
    } finally {
      if (abort.current === controller) {
        abort.current = null; setChecking(false); current.current.onCheckBusy(draft.key, false);
      }
    }
  };
  const remove = async () => {
    if (!usable() || configuration.providerId !== 'compatible') return;
    const owner = session, version = state.version;
    if (!await confirm(message('generation.services.video.deleteConfirm', {name: configuration.name}))) return;
    if (!usable() || current.current.session !== owner || current.current.state.version !== version) return;
    invalidate(); props.clearKey(draft.key);
    if (owner?.stageDelete(draft.key)) props.onDeleted();
  };
  const editable = panel.active && props.interactionAllowed() && !generationVideoBusy(state) && !state.recovery && Boolean(state.snapshot);
  return <div className="video-provider-settings generation-video-detail" data-testid="generation-video-detail" data-service-key={draft.key}>
    {state.snapshot?.notice && <p role="status" data-testid="video-settings-legacy-notice">{t('video.providers.resetLegacy')}</p>}
    {state.notice && <p role={state.recovery || state.phase === 'error' || state.phase === 'load_error' ? 'alert' : 'status'}>{t(state.notice)}</p>}
    {state.deletedIds.length > 0 && <p role="status" data-testid="video-delete-pending">{t('generation.services.video.deletePending')}</p>}
    {state.phase === 'load_error' && <Button type="button" data-testid="video-domain-reload" disabled={!panel.active || !props.interactionAllowed()} onClick={() => {if (interactionAllowed()) void session?.load();}}>{t('video.providers.reload')}</Button>}
    {state.recovery && <div className="video-recovery"><Button type="button" disabled={!panel.active || !props.interactionAllowed() || generationVideoBusy(state)} onClick={() => {if (interactionAllowed()) {props.clearKey(draft.key); void session?.reload();}}}>{t('video.providers.reload')}</Button><Button type="button" disabled={!panel.active || !props.interactionAllowed() || generationVideoBusy(state) || state.phase === 'blocked'} onClick={() => {if (interactionAllowed()) {props.clearAllKeys(); session?.useLatest();}}}>{t('video.providers.useLatest')}</Button><Button type="button" disabled={!panel.active || !props.interactionAllowed() || state.phase !== 'review'} onClick={() => {if (interactionAllowed()) session?.acknowledge();}}>{t('video.providers.reviewDraft')}</Button></div>}
    <fieldset disabled={!editable}>
      {configuration.providerId === 'compatible' && <label>{t('video.providers.name')}<Input data-testid="video-connection-name" value={configuration.name} onChange={event => change({name: event.target.value})}/></label>}
      {configuration.providerId === 'compatible' ? <><label>{t('video.providers.baseUrl')}<Input data-testid="video-connection-base-url" value={configuration.baseUrl ?? ''} inputMode="url" autoComplete="off" spellCheck={false} placeholder={t('video.providers.baseUrlPlaceholder')} onChange={event => change({baseUrl: event.target.value})}/></label><p className="helper muted">{t('video.providers.baseUrlHint')}</p></> : <><label>{t('video.providers.region')}<WorkbenchSelect data-testid="video-connection-region" value={configuration.region} onChange={event => change({region: event.target.value})}>{VIDEO_REGIONS[configuration.providerId].map(region => <option key={region} value={region}>{regions[region] ? t(regions[region]) : region}</option>)}</WorkbenchSelect></label>{configuration.providerId === 'wan' && <label>{t('video.providers.workspace')}<Input data-testid="video-connection-workspace" value={configuration.workspaceId} onChange={event => change({workspaceId: event.target.value})}/></label>}</>}
      <label>{t('generation.services.requestAddress')}<output data-testid="video-connection-endpoint">{videoSettingsRequestEndpoint(configuration)}</output></label>
      <label>{t('video.providers.key')}<Input ref={element => {keyInput.current = element; props.registerKey(draft.key, element);}} data-testid="video-connection-key" data-key-owner={draft.key} type="password" autoComplete="new-password" onChange={() => {if (!usable()) {if (keyInput.current) keyInput.current.value = ''; return;} invalidate(); session?.keyEdited(draft.key, Boolean(keyInput.current?.value));}}/></label>
      <p className="helper muted">{t('video.providers.keyHint')}</p>
      {canCheck && <div className="video-compatible-check">
        <Button type="button" data-testid="video-compatible-check" disabled={!checkable} onClick={() => {void runProbe('check');}}>{t(checking ? 'settings.draftKey.checking' : 'settings.draftKey.check')}</Button>
      </div>}
      {check && <div>
        <p role={check.result.result === 'ok' ? 'status' : 'alert'} data-testid="video-compatible-check-result" data-result={check.result.result} className={`video-compatible-check-result ${check.result.result === 'ok' ? 'ok' : 'failed'}`}>{checkText(check)}</p>
        {check.draft && <p className="helper muted">{t('settings.draftKey.resultHint')}</p>}
      </div>}
      <p>{t(saved?.secret.configured ? 'video.providers.configured' : 'video.providers.unconfigured')}</p>
      {saved?.secret.storage === 'persistent' && state.snapshot?.storage.reasonCode === 'OS_SECRET_STORE_UNAVAILABLE' && <p className="helper muted" role="status" data-testid="video-key-storage-unavailable">{t('tasks.error.videoSecretStore')}</p>}
      {draft.secretAction === 'replace' && !draft.hasKey && <p role="status" data-testid="video-key-required">{t('generation.services.video.keyRequired')}</p>}
      <label>{t('video.providers.storage')}<WorkbenchSelect data-testid="video-key-storage" value={draft.storage} onChange={event => {if (usable()) session?.setStorage(draft.key, event.target.value as GenerationVideoDraft['storage']);}}><option value="">{t('video.providers.chooseStorage')}</option><option value="session">{t('video.providers.session')}</option><option value="persistent" disabled={!state.snapshot?.storage.persistentAvailable}>{t('video.providers.persistent')}</option></WorkbenchSelect></label><p className="helper muted">{t('connections.sessionLoss')}</p>
      <label className="video-check"><input type="checkbox" data-testid="video-remove-key" checked={draft.secretAction === 'remove'} onChange={event => {if (usable()) {invalidate(); props.clearKey(draft.key); session?.removeKey(draft.key, event.target.checked);}}}/>{t('video.providers.removeKey')}</label>
      <label className="video-check"><input type="checkbox" data-testid="video-connection-enabled" checked={configuration.enabled} onChange={event => change({enabled: event.target.checked})}/>{t('video.providers.enabled')}</label>
      <details className="generation-video-models"><summary data-testid="video-models-summary">{t('generation.services.video.modelsCount', {count: configuration.models.length})}</summary>
        <div className="video-catalog-heading"><h3>{t('video.providers.models')}</h3>{props.client.modelsList && <Button type="button" data-testid="video-fetch-models" disabled={!checkable} onClick={() => {void runProbe('models');}}>{t('settings.draftKey.list')}</Button>}<Button type="button" data-testid="video-add-model" onClick={() => {const base = defaultVideoModels(configuration.providerId)[0]!; change({models: [...configuration.models, {...base, id: crypto.randomUUID(), modelId: '', name: ''}]});}}>{t('video.providers.addModel')}</Button></div>
        {configuration.models.map((model, index) => <ModelEditor key={model.id} menuActions resetEpoch={state.editorEpoch} model={model} providerId={configuration.providerId} index={index} count={configuration.models.length} onChange={patch => change({models: configuration.models.map(item => item.id === model.id ? {...item, ...patch} : item)})} onMove={offset => {const models = [...configuration.models]; [models[index], models[index + offset]] = [models[index + offset]!, models[index]!]; change({models});}}/>)}
      </details>
      <details><summary>{t('video.providers.advanced')}</summary>{configuration.providerId === 'compatible' && <p data-testid="video-compatible-service-host">{compatibleServiceHost(configuration) ? t('video.providers.serviceHost', {host: compatibleServiceHost(configuration)}) : t('video.providers.serviceHostPending')}</p>}<label>{t(configuration.providerId === 'compatible' ? 'video.providers.extraHosts' : 'video.providers.hosts')}<Textarea data-testid="video-output-hosts" value={configuration.outputHosts.join('\n')} onChange={event => change({outputHosts: event.target.value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean)})}/></label><p className="helper muted">{t('video.providers.extraHostsHint')}</p></details>
      {configuration.providerId === 'compatible' && <><p role="note" className="notice warning">{t('video.providers.compatibleCost')}</p><Button type="button" data-testid="video-delete-connection" onClick={() => {void remove();}}>{t('video.providers.delete')}</Button></>}
    </fieldset>
  </div>;
}

/** Owns only video drafts and retained detail nodes; the parent owns the one shell/footer. */
export function useGenerationVideoServices(options: GenerationServiceDomainOptions & {client?: VideoSettingsClient}): GenerationServiceDomain {
  const {t} = useI18n();
  const [state, setState] = useState(initialGenerationVideoState), [checkVersion, setCheckVersion] = useState(0);
  const session = useRef<GenerationVideoServicesSession | null>(null), keys = useRef(new Map<string, HTMLInputElement>()), checks = useRef(new Set<string>()), checkCancels = useRef(new Map<string, () => void>()), reporter = useRef(createSettingsNavigationReporter()).current;
  const latest = useRef(options), currentState = useRef(state), fallback = useRef<VideoSettingsClient | null>(null), alive = useRef(false);
  latest.current = options; currentState.current = state;
  const client = options.client ?? (fallback.current ??= createVideoSettingsClient());
  const interactionAllowed = () => latest.current.interactionAllowed?.() !== false;
  const report = (next = currentState.current) => reporter.update({phase: checks.current.size ? 'checking' : next.phase, dirty: generationVideoDirty(next), recovery: next.recovery});
  const cancelChecks = (key?: string) => {for (const [owner, cancel] of checkCancels.current) if (!key || owner === key) cancel();};
  const clearKeys = (key?: string) => {cancelChecks(key); for (const [owner, input] of keys.current) if (!key || owner === key) input.value = ''; session.current?.keysCleared(key);};
  useLayoutEffect(() => {const owner = reporter.connect(options.onNavigationStateChange, {phase: 'loading', dirty: false}); return () => reporter.disconnect(owner);}, [reporter, options.onNavigationStateChange]);
  useLayoutEffect(() => {
    alive.current = true;
    const owner = createGenerationVideoServicesSession({client, onChange(next) {if (!alive.current || session.current !== owner) return; currentState.current = next; setState(next); report(next);}});
    session.current = owner; owner.setVisible(latest.current.pageVisible); currentState.current = owner.getState(); setState(currentState.current); report();
    if (latest.current.pageVisible) void owner.load();
    return () => {alive.current = false; for (const input of keys.current.values()) input.value = ''; owner.dispose(); if (session.current === owner) session.current = null;};
  }, [client]);
  useLayoutEffect(() => {const owner = session.current; owner?.setVisible(options.pageVisible); if (!options.pageVisible) clearKeys(); else if (owner && !owner.getState().snapshot && owner.getState().phase !== 'loading') void owner.load();}, [options.pageVisible]);
  useLayoutEffect(() => {
    const changed = () => {if (document.visibilityState === 'hidden') {clearKeys(); session.current?.setVisible(false);} else {const owner = session.current; owner?.setVisible(latest.current.pageVisible); if (latest.current.pageVisible && owner && !owner.getState().snapshot) void owner.load();}};
    if (typeof document === 'undefined') return; document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  // A changing locale rerenders labels, not the session owner or password nodes.
  void checkVersion;
  const onCheckBusy = (key: string, value: boolean) => {const before = checks.current.has(key); if (value) checks.current.add(key); else checks.current.delete(key); if (before !== value && alive.current) {setCheckVersion(version => version + 1); report();}};
  const navigation = reporter.getState();
  return {
    services: state.drafts.map(draft => ({key: draft.key, providerId: draft.configuration.providerId, kind: 'video', custom: draft.configuration.providerId === 'compatible', label: draft.configuration.providerId === 'compatible' ? draft.configuration.name : VIDEO_PROVIDER_NAMES[draft.configuration.providerId], configured: state.snapshot ? Boolean(state.snapshot.connections.find(view => view.configuration.id === draft.configuration.id)?.secret.configured) : null, available: generationVideoAvailable(state.snapshot, draft.configuration), dirty: generationVideoDraftDirty(draft), content: <VideoServiceDetail key={draft.key} draft={draft} state={state} session={session.current} client={client} interactionAllowed={interactionAllowed} registerKey={(key, input) => {if (input) keys.current.set(key, input); else keys.current.delete(key);}} registerCheckCancel={(key, cancel) => {if (cancel) checkCancels.current.set(key, cancel); else checkCancels.current.delete(key);}} clearKey={clearKeys} clearAllKeys={clearKeys} onCheckBusy={onCheckBusy} onDeleted={() => latest.current.onSelect?.('general')}/> })),
    ready: Boolean(state.snapshot) && !generationVideoBusy(state) && !state.recovery && !checks.current.size,
    navigation,
    prepareSave() {cancelChecks(); if (!session.current || !latest.current.pageVisible || !documentVisible()) {clearKeys(); throw Error('Video settings are not ready to save.');} return session.current.prepareSave(key => keys.current.get(key)?.value ?? '', clearKeys);},
    clearKeys,
    discard() {if (!latest.current.pageVisible || !documentVisible() || !interactionAllowed()) return; clearKeys(); if (session.current?.discard()) latest.current.onSelect?.('general');},
    add() {if (!latest.current.pageVisible || !documentVisible() || !interactionAllowed()) return null; const key = session.current?.add() ?? null; if (key) latest.current.onSelect?.(key); return key;},
  };
}
