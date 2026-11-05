import React, { useLayoutEffect, useRef, useState } from 'react';
import type { MessageKey } from '../../../packages/i18n/src/index.ts';
import { message } from '../../../packages/i18n/src/index.ts';
import { VIDEO_PROVIDER_NAMES, VIDEO_REGIONS, VIDEO_TEMPLATES, defaultVideoModels, isVideoCatalogProvider } from '../../../packages/contracts/src/video-providers.ts';
import type { VideoModelEntry, VideoProviderId, VideoTemplate } from '../../../packages/contracts/src/video-providers.ts';
import { Button } from '@mioon/ui/components/button';
import { Badge } from '@mioon/ui/components/badge';
import { Input } from '@mioon/ui/components/input';
import { Textarea } from '@mioon/ui/components/textarea';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { useI18n } from './i18n/I18nProvider.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import ProviderBrandIcon from './ProviderBrandIcon.tsx';
import { createSettingsNavigationReporter } from './settings-navigation-state.ts';
import type { SettingsNavigationState } from './settings-navigation-state.ts';
import { compatibleServiceHost, createVideoSettingsClient, createVideoSettingsSession, initialVideoSettingsState, videoSettingsBusy, videoSettingsCanSave, videoSettingsDirty, videoSettingsEndpoint, videoModelPairMap } from './video-settings.ts';
import { normalizeCompatibleVideoBaseUrl } from '../../../packages/contracts/src/video-providers.ts';
import type { CompatibleVideoCheckResult } from '../../../packages/contracts/src/video-providers.ts';
import type { VideoSettingsClient, VideoSettingsSession } from './video-settings.ts';
import {VIDEO_BUILTIN_PROVIDER_IDS} from '../../../packages/contracts/src/generation-video-settings.ts';
import type {VideoConnectionConfigurationV2 as VideoConnectionConfiguration} from '../../../packages/contracts/src/generation-video-settings.ts';
import './video-settings.css';

const modeKey = { text: 'video.providers.text', image: 'video.providers.image', frames: 'video.providers.frames', subject: 'video.providers.subject', reference: 'video.wan.reference' } as const;
const regionKey: Record<string, MessageKey> = { global: 'video.providers.region.global', 'cn-beijing': 'video.providers.region.beijing', 'ap-southeast-1': 'video.providers.region.singapore', cn: 'video.providers.region.cn', custom: 'video.providers.region.custom' };
type CheckState = CompatibleVideoCheckResult | { result: 'failed' };
const sameOrigin = (draft: string | undefined, saved: string | undefined): boolean => { try { return Boolean(saved) && normalizeCompatibleVideoBaseUrl(draft) === saved; } catch { return false; } };
const pairText = (model: VideoModelEntry): string => model.durationResolutionMap.flatMap(pair => pair.duration.flatMap(duration => pair.resolution.map(resolution => `${duration}:${resolution}`))).join('\n');

export function ModelEditor({ model, providerId, onChange, onMove, index, count, menuActions = false, resetEpoch = 0 }: { model: VideoModelEntry; providerId: VideoProviderId; onChange: (patch: Partial<VideoModelEntry>) => void; onMove: (offset: number) => void; index: number; count: number; menuActions?: boolean; resetEpoch?: number }) {
  const { t } = useI18n(), template = VIDEO_TEMPLATES.find(item => item.id === model.templateId)!;
  const [pairs, setPairs] = useState(() => pairText(model));
  useLayoutEffect(() => {setPairs(pairText(model));}, [resetEpoch]);
  const changeTemplate = (selected: VideoTemplate) => { const resolutions = selected.providerId === 'minimax' ? selected.resolutions.filter(resolution => resolution === '2K') : selected.resolutions; setPairs(selected.durations.flatMap(duration => resolutions.map(resolution => `${duration}:${resolution}`)).join('\n')); onChange({ templateId: selected.id, inputModes: [...selected.inputModes], aspectRatios: [...selected.aspectRatios] as VideoModelEntry['aspectRatios'], durationResolutionMap: [{ duration: [...selected.durations], resolution: [...resolutions] }], audio: selected.audio[0], seed: selected.seed }); };
  return <article className="video-model-editor" data-testid="video-model-entry" data-entry-id={model.id}>
    <header><strong>{model.name || model.modelId}</strong><Badge className="small-badge warn" data-testid="video-model-verification">{t('video.providers.unverified')}</Badge>{menuActions ? <details className="video-model-actions"><summary aria-label={t('video.providers.advanced')}>⋯</summary><div><Button type="button" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)}>{t('video.providers.up')}</Button><Button type="button" variant="ghost" disabled={index === count - 1} onClick={() => onMove(1)}>{t('video.providers.down')}</Button><Button type="button" variant="ghost" onClick={() => onChange({ archived: !model.archived })}>{t(model.archived ? 'video.providers.restore' : 'video.providers.archive')}</Button></div></details> : <><Button type="button" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)}>{t('video.providers.up')}</Button><Button type="button" variant="ghost" disabled={index === count - 1} onClick={() => onMove(1)}>{t('video.providers.down')}</Button><Button type="button" variant="ghost" onClick={() => onChange({ archived: !model.archived })}>{t(model.archived ? 'video.providers.restore' : 'video.providers.archive')}</Button></>}</header>
    <p className="helper muted">{t('video.providers.unverifiedHint')}</p>
    <label>{t('video.providers.modelName')}<Input value={model.name} onChange={event => onChange({ name: event.target.value })} /></label>
    <label>{t('video.providers.modelId')}<Input data-testid="video-model-id" value={model.modelId} onChange={event => onChange({ modelId: event.target.value })} /></label>
    <label>{t('video.providers.template')}<WorkbenchSelect value={model.templateId} onChange={event => { const selected = VIDEO_TEMPLATES.find(item => item.id === event.target.value && item.providerId === providerId); if (selected) changeTemplate(selected); }}>{VIDEO_TEMPLATES.filter(item => item.providerId === providerId).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</WorkbenchSelect></label><p className="helper muted">{t('video.providers.templateHint')}</p>
    <label className="video-check"><input type="checkbox" checked={model.enabled} onChange={event => onChange({ enabled: event.target.checked })} />{t('video.providers.enabledModel')}</label>
    <fieldset><legend>{t('video.providers.modes')}</legend>{template.inputModes.map(mode => <label className="video-check" key={mode}><input type="checkbox" checked={model.inputModes.includes(mode)} onChange={event => onChange({ inputModes: event.target.checked ? [...model.inputModes, mode] : model.inputModes.filter(item => item !== mode) })} />{t(modeKey[mode])}</label>)}</fieldset>
    <fieldset><legend>{t('video.providers.ratios')}</legend>{template.aspectRatios.map(ratio => <label className="video-check" key={ratio}><input type="checkbox" checked={model.aspectRatios.includes(ratio as VideoModelEntry['aspectRatios'][number])} onChange={event => onChange({ aspectRatios: (event.target.checked ? [...model.aspectRatios, ratio] : model.aspectRatios.filter(item => item !== ratio)) as VideoModelEntry['aspectRatios'] })} />{ratio}</label>)}</fieldset>
    <label>{t('video.providers.combinations')}<Textarea data-testid="video-model-combinations" rows={4} value={pairs} onChange={event => { setPairs(event.target.value); onChange({ durationResolutionMap: videoModelPairMap(event.target.value) }); }} /></label><p className="helper muted">{t('video.providers.combinationHint')}</p>
    <label>{t('video.providers.audio')}<WorkbenchSelect value={model.audio} onChange={event => onChange({ audio: event.target.value as VideoModelEntry['audio'] })}>{template.audio.map(audio => <option key={audio} value={audio}>{t(`video.providers.audio.${audio}`)}</option>)}</WorkbenchSelect></label>
    <label className="video-check"><input type="checkbox" disabled={!template.seed} checked={model.seed} onChange={event => onChange({ seed: event.target.checked })} />{t('video.providers.seed')}</label>
  </article>;
}
export default function VideoProviderSettings({ active, client, onNavigationStateChange }: { active: boolean; client?: VideoSettingsClient; onNavigationStateChange?: (state: SettingsNavigationState) => void }) {
  const { t } = useI18n(), confirm = useConfirmation();
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const ancestorVisible = useWorkspaceVisibility(), shown = active && ancestorVisible && pageVisible;
  const [state, setState] = useState(initialVideoSettingsState), [hasKey, setHasKey] = useState(false), [legacyDismissed, setLegacyDismissed] = useState(false), [editorEpoch, setEditorEpoch] = useState(0);
  const keyInput = useRef<HTMLInputElement | null>(null), session = useRef<VideoSettingsSession | null>(null), visible = useRef(shown), reporter = useRef(createSettingsNavigationReporter()).current;
  const checkEpoch = useRef(0), fallbackClient = useRef<VideoSettingsClient | null>(null), checkAbort = useRef<AbortController | null>(null), [check, setCheck] = useState<CheckState | null>(null), [checking, setChecking] = useState(false);
  const providerLabel = (id: VideoProviderId): string => id === 'compatible' ? t('video.providers.compatible') : VIDEO_PROVIDER_NAMES[id];
  visible.current = shown;
  const report = (next = session.current?.getState() || state) => reporter.update({ phase: !next.snapshot && !visible.current ? 'ready' : next.phase, dirty: videoSettingsDirty(next) || Boolean(keyInput.current?.value), recovery: next.recovery });
  useLayoutEffect(() => { const owner = reporter.connect(onNavigationStateChange, { phase: 'ready', dirty: false }); return () => reporter.disconnect(owner); }, [reporter, onNavigationStateChange]);
  useLayoutEffect(() => {
    let live = true;
    const current = createVideoSettingsSession({ client, onChange: next => { if (!live) return; setState(next); report(next); } }); session.current = current; current.setVisible(visible.current);
    return () => { live = false; current.dispose(); if (keyInput.current) keyInput.current.value = ''; if (session.current === current) session.current = null; };
  }, [client]);
  useLayoutEffect(() => { const current = session.current; current?.setVisible(shown); if (!shown && keyInput.current?.value) { keyInput.current.value = ''; setHasKey(false); } if (shown && !current?.getState().snapshot) void current?.load(); report(); }, [shown]);
  useLayoutEffect(() => { if (typeof document === 'undefined') return; const changed = () => { const next = document.visibilityState !== 'hidden'; if (!next) { visible.current = false; session.current?.setVisible(false); if (keyInput.current) keyInput.current.value = ''; setHasKey(false); report(); } setPageVisible(next); }; document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed); }, []);
  const clearKey = () => { if (keyInput.current) keyInput.current.value = ''; setHasKey(false); report(); };
  useLayoutEffect(() => { checkAbort.current?.abort(); checkAbort.current = null; setChecking(false); setCheck(null); }, [state.draft?.id, shown]);
  useLayoutEffect(() => () => checkAbort.current?.abort(), []);
  const dirty = videoSettingsDirty(state) || hasKey, busy = videoSettingsBusy(state), editable = shown && !busy && !state.recovery;
  const invalidateCheck = () => { ++checkEpoch.current; checkAbort.current?.abort(); checkAbort.current = null; setChecking(false); setCheck(null); };
  const change = (patch: Partial<VideoConnectionConfiguration>) => { if (visible.current) { invalidateCheck(); if (patch.region !== undefined || patch.workspaceId !== undefined || patch.baseUrl !== undefined) clearKey(); session.current?.update(patch); } };
  const switchTo = async (action: () => void) => {
    const owner = session.current, capture = reporter.getState().version;
    if (!visible.current || busy || state.recovery) return;
    if (dirty && !await confirm(message('video.providers.discardConfirm'))) return;
    if (!visible.current || owner !== session.current || reporter.getState().version !== capture) return;
    if (dirty) { owner?.discard(); clearKey(); } action(); setEditorEpoch(value => value + 1);
  };
  const save = () => { if (!visible.current || !videoSettingsCanSave(state)) return; invalidateCheck(); const value = keyInput.current?.value || ''; clearKey(); void session.current?.save(value); };
  const draft = state.draft, saved = state.snapshot?.connections.find(item => item.configuration.id === draft?.id);
  const connections = state.snapshot?.connections.filter(item => isVideoCatalogProvider(item.configuration.providerId)) || [];
  const serviceHost = compatibleServiceHost(draft);
  const savedCheckable = Boolean(draft && saved?.secret.configured && sameOrigin(draft.baseUrl, saved.configuration.baseUrl));
  const canCheck = Boolean(draft?.providerId === 'compatible' && editable && !checking && serviceHost && (hasKey || savedCheckable));
  const runCheck = async () => {
    if (!visible.current || !draft || !canCheck) return;
    const checker = client ?? (fallbackClient.current ??= createVideoSettingsClient());
    const typed = keyInput.current?.value || '', owner = draft.id, capturedEpoch = ++checkEpoch.current;
    if (!checker.check || !typed && !saved) return;
    checkAbort.current?.abort(); const controller = new AbortController(); checkAbort.current = controller;
    setChecking(true); setCheck(null);
    try {
      const result = await checker.check(typed ? { source: 'draft', baseUrl: draft.baseUrl ?? '', value: typed } : { source: 'saved', connectionId: owner, configurationRevision: saved!.revision }, controller.signal);
      if (visible.current && capturedEpoch === checkEpoch.current && checkAbort.current === controller && session.current?.getState().draft?.id === owner) setCheck(result);
    } catch { if (visible.current && capturedEpoch === checkEpoch.current && checkAbort.current === controller) setCheck({ result: 'failed' }); }
    finally { if (checkAbort.current === controller) { checkAbort.current = null; setChecking(false); } }
  };
  const checkText = (value: CheckState): string => {
    const status = 'httpStatus' in value && value.httpStatus !== undefined ? String(value.httpStatus) : '';
    switch (value.result) {
      case 'ok': return t('video.providers.check.ok');
      case 'unauthorized': return t('video.providers.check.unauthorized', { status });
      case 'unsupported': return t('video.providers.check.unsupported', { status });
      case 'http_error': return t('video.providers.check.httpError', { status });
      case 'denied': return t('video.providers.check.denied');
      case 'unreachable': return t('video.providers.check.unreachable');
      default: return t('video.providers.check.failed');
    }
  };
  return <section className="video-provider-settings" data-testid="video-provider-settings" aria-label={t('video.providers.title')}>
    <h2>{t('video.providers.title')}</h2><p>{t('video.providers.hint')}</p>
    {state.snapshot?.notice && !legacyDismissed && <p role="status" data-testid="video-settings-legacy-notice">{t('video.providers.resetLegacy')}<Button type="button" variant="ghost" aria-label={t('common.close')} disabled={!active} onClick={() => {if (visible.current) setLegacyDismissed(true);}}>{t('common.close')}</Button></p>}
    {state.notice && <p role={state.recovery || state.phase === 'error' || state.phase === 'load_error' ? 'alert' : 'status'}>{t(state.notice)}</p>}
    {busy && <p role="status">{t(state.phase === 'saving' ? 'video.providers.saving' : 'video.providers.loading')}</p>}
    {state.recovery && <div className="video-recovery"><Button type="button" disabled={!active || busy} onClick={() => { clearKey(); void session.current?.reload(); }}>{t('video.providers.reload')}</Button><Button type="button" disabled={!active || busy || state.phase === 'blocked'} onClick={() => { clearKey(); session.current?.useLatest(); setEditorEpoch(value => value + 1); }}>{t('video.providers.useLatest')}</Button><Button type="button" disabled={!active || state.phase !== 'review'} onClick={() => session.current?.acknowledge()}>{t('video.providers.reviewDraft')}</Button></div>}
    {state.phase === 'load_error' && <Button type="button" disabled={!active} onClick={() => { void session.current?.load(); }}>{t('video.providers.reload')}</Button>}
    <div className="video-connections-layout"><aside className="video-connections-list">
      {VIDEO_BUILTIN_PROVIDER_IDS.map(providerId => { const saved = connections.find(item => item.configuration.providerId === providerId); return <Button type="button" key={providerId} title={providerLabel(providerId)} disabled={!active || busy || Boolean(state.recovery)} aria-current={draft?.providerId === providerId ? 'true' : undefined} data-testid={`video-builtin-${providerId}`} onClick={() => { void switchTo(() => session.current?.add(providerId)); }}><span className="video-connection-identity"><ProviderBrandIcon providerId={providerId} size={24} /><span>{providerLabel(providerId)}{saved?.secret.configured ? ` · ${t('video.providers.configured')}` : ''}</span></span></Button>; })}
      {connections.filter(item => item.configuration.providerId === 'compatible').map(item => <Button type="button" key={item.configuration.id} title={item.configuration.name} disabled={!active || busy || Boolean(state.recovery)} aria-current={draft?.id === item.configuration.id ? 'true' : undefined} data-testid="video-connection-select" onClick={() => { void switchTo(() => session.current?.select(item.configuration.id)); }}><span className="video-connection-identity"><ProviderBrandIcon providerId={item.configuration.providerId} size={24} /><span className="video-connection-caption"><span>{item.configuration.name}</span><small>{compatibleServiceHost(item.configuration)}</small></span></span></Button>)}
      <Button type="button" data-testid="video-add-connection" disabled={!editable} onClick={() => {void switchTo(() => session.current?.add('compatible'));}}>{t('video.providers.addCustom')}</Button>
    </aside>{draft && <form className="video-connection-form" onSubmit={event => { event.preventDefault(); save(); }}><fieldset disabled={!editable}>
      <label>{t('video.providers.name')}<Input data-testid="video-connection-name" disabled={!editable || draft.providerId !== 'compatible'} value={draft.name} onChange={event => change({ name: event.target.value })} /></label><p className="provider-brand-label"><ProviderBrandIcon providerId={draft.providerId} size={24} /><span>{providerLabel(draft.providerId)}</span></p>
      {draft.providerId === 'compatible' ? <><label>{t('video.providers.baseUrl')}<Input data-testid="video-connection-base-url" inputMode="url" spellCheck={false} autoComplete="off" placeholder={t('video.providers.baseUrlPlaceholder')} value={draft.baseUrl ?? ''} onChange={event => { change({ baseUrl: event.target.value }); setCheck(null); }} /></label><p className="helper muted">{t('video.providers.baseUrlHint')}</p></> : <>
      <label>{t('video.providers.region')}<WorkbenchSelect data-testid="video-connection-region" value={draft.region} onChange={event => change({ region: event.target.value })}>{VIDEO_REGIONS[draft.providerId].map(region => <option key={region} value={region}>{regionKey[region] ? t(regionKey[region]) : region}</option>)}</WorkbenchSelect></label>
      {draft.providerId === 'wan' && <label>{t('video.providers.workspace')}<Input value={draft.workspaceId} onChange={event => change({ workspaceId: event.target.value })} /></label>}
      <label>{t('video.providers.endpoint')}<output data-testid="video-connection-endpoint">{videoSettingsEndpoint(draft)}</output></label></>}
      <label className="video-check"><input data-testid="video-connection-enabled" type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />{t('video.providers.enabled')}</label>
      <label>{t('video.providers.key')}<Input ref={keyInput} data-testid="video-connection-key" type="password" autoComplete="new-password" onChange={() => { invalidateCheck(); if (!visible.current && keyInput.current) keyInput.current.value = ''; setHasKey(Boolean(keyInput.current?.value)); report(); }} /></label><p className="helper muted">{t('video.providers.keyHint')}</p><p>{t(saved?.secret.configured ? 'video.providers.configured' : 'video.providers.unconfigured')}</p>
      <label>{t('video.providers.storage')}<WorkbenchSelect data-testid="video-key-storage" value={state.storage} onChange={event => session.current?.setStorage(event.target.value as '' | 'session' | 'persistent')}><option value="">{t('video.providers.chooseStorage')}</option><option value="session">{t('video.providers.session')}</option><option value="persistent" disabled={!state.snapshot?.storage.persistentAvailable}>{t('video.providers.persistent')}</option></WorkbenchSelect></label>
      <p>{t('connections.sessionLoss')}</p>
      <label className="video-check"><input type="checkbox" checked={state.secretAction === 'remove'} onChange={event => { clearKey(); session.current?.removeKey(event.target.checked); }} />{t('video.providers.removeKey')}</label>
      {draft.providerId === 'compatible' ? <div className="video-compatible-hosts"><p data-testid="video-compatible-service-host">{serviceHost ? t('video.providers.serviceHost', { host: serviceHost }) : t('video.providers.serviceHostPending')}</p><label>{t('video.providers.extraHosts')}<Textarea data-testid="video-output-hosts" value={draft.outputHosts.join('\n')} onChange={event => change({ outputHosts: event.target.value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean) })} /></label><p className="helper muted">{t('video.providers.extraHostsHint')}</p>
        <div className="video-compatible-check"><Button type="button" data-testid="video-compatible-check" disabled={!active || !canCheck} onClick={() => { void runCheck(); }}>{t(checking ? 'video.providers.checking' : 'video.providers.check')}</Button><span className="helper muted">{t('video.providers.checkHint')}</span></div>
        {check && <p role={check.result === 'ok' ? 'status' : 'alert'} className={`video-compatible-check-result ${check.result === 'ok' ? 'ok' : 'failed'}`} data-testid="video-compatible-check-result" data-result={check.result}>{checkText(check)}</p>}
        <p role="note" className="notice warning" data-testid="video-compatible-cost">{t('video.providers.compatibleCost')}</p></div>
      : <>{!draft.outputHosts.length && draft.models.some(model => model.enabled && !model.archived && !VIDEO_TEMPLATES.find(item => item.id === model.templateId)?.defaultOutputHosts.length) && <p role="status" className="notice warning">{t('video.providers.hostsRequired')}</p>}<details><summary>{t('video.providers.advanced')}</summary><label>{t('video.providers.hosts')}<Textarea data-testid="video-output-hosts" value={draft.outputHosts.join('\n')} onChange={event => change({ outputHosts: event.target.value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean) })} /></label></details></>}
      <div className="video-catalog-heading"><h3>{t('video.providers.models')}</h3><Button type="button" data-testid="video-add-model" onClick={() => { const base = defaultVideoModels(draft.providerId)[0]!; change({ models: [...draft.models, { ...base, id: crypto.randomUUID(), modelId: '', name: '' }] }); }}>{t('video.providers.addModel')}</Button></div>
      {draft.models.map((model, index) => <ModelEditor key={`${draft.id}:${model.id}:${editorEpoch}:${state.phase === 'saved' ? state.snapshot?.revision : ''}`} model={model} providerId={draft.providerId} index={index} count={draft.models.length} onChange={patch => change({ models: draft.models.map(item => item.id === model.id ? { ...item, ...patch } : item) })} onMove={offset => { const models = [...draft.models]; [models[index], models[index + offset]] = [models[index + offset]!, models[index]!]; change({ models }); }} />)}
      {draft.providerId === 'compatible' && <Button type="button" data-testid="video-delete-connection" onClick={async () => {const id = draft.id, version = reporter.getState().version; if (!visible.current || !editable || !await confirm(message('video.providers.deleteConfirm', {name: draft.name}))) return; if (!visible.current || session.current?.getState().draft?.id !== id || reporter.getState().version !== version) return; invalidateCheck(); clearKey(); void session.current?.remove();}}>{t('video.providers.delete')}</Button>}
    </fieldset><footer><Button data-testid="video-settings-save" type="submit" disabled={!active || !videoSettingsCanSave(state)}>{t('video.providers.save')}</Button><Button type="button" variant="ghost" disabled={!editable} onClick={() => { void switchTo(() => { session.current?.discard(); clearKey(); }); }}>{t('video.providers.cancel')}</Button></footer></form>}</div>
  </section>;
}
