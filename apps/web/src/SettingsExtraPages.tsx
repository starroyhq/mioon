import React, { useEffect, useRef, useState } from 'react';
import { WorkbenchBadge, WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { Switch } from '@mioon/ui/components/switch';
import { Label } from '@mioon/ui/components/label';
import { useI18n } from './i18n/I18nProvider.tsx';
import { readWorkspaceInfo } from './workspace-info-client.ts';
import type { WorkspaceInfo } from '../../../packages/contracts/src/workspace-info.ts';
import { browserRpc } from './browser-rpc.ts';
import {readWorkspaceSettings,saveWorkspaceSettings} from './workspace-settings-client.ts';
import type {WorkspaceSettings} from '../../../packages/contracts/src/workspace-configuration.ts';

const services = [
  { id: 'ark', label: 'Seedance 2.5', variable: 'ARK_API_KEY' },
  { id: 'veo', label: 'Veo 3.1', variable: 'GEMINI_API_KEY' }, { id: 'minimax', label: 'MiniMax', variable: 'MINIMAX_API_KEY' },
  { id: 'vidu', label: 'Vidu', variable: 'VIDU_API_KEY' },
] as const;
export function SettingsModelServices({ active,onOpenOfficial }: { active: boolean;onOpenOfficial?:()=>void }) {
  const { t } = useI18n(), [status, setStatus] = useState<Readonly<Record<string, boolean>> | null>(null), [settings,setSettings]=useState<WorkspaceSettings|null>(null), [simulation, setSimulation] = useState<boolean | null>(null), [failed, setFailed] = useState(false), [checking, setChecking] = useState(false), [saving,setSaving]=useState(false),[saveError,setSaveError]=useState<string|null>(null), [version, refresh] = useState(0);
  const current=useRef({active,saving,settings}),mounted=useRef(true);current.current={active,saving,settings};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(() => {
    if (!active) return;
    let live = true; const abort = new AbortController(); setFailed(false); setChecking(true);
    void Promise.allSettled([browserRpc('provider.list', {}, { signal: abort.signal }),readWorkspaceSettings(abort.signal)]).then(results=>{
      const [providers,configuration]=results;
      if(live&&configuration.status==='fulfilled')setSettings(configuration.value);
      if(configuration.status==='rejected'&&live)setSettings(null);
      if(providers.status==='rejected')throw providers.reason;
      const response:unknown=providers.value;
      if (!Array.isArray(response)) throw new TypeError('Invalid service status.');
      const next: Record<string, boolean> = {};
      for (const entry of response) if (entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.configured === 'boolean' && services.some(service => service.id === entry.id)) next[entry.id] = entry.configured;
      const local = response.find(entry => entry && typeof entry === 'object' && entry.id === 'mock' && typeof entry.enabled === 'boolean');
      if (live) { setStatus(next); setSimulation(local?.enabled ?? null);if(configuration.status==='rejected')setFailed(true); }
    }).catch(() => { if (live) { setFailed(true); setStatus(null); setSimulation(null); } }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; abort.abort(); };
  }, [active, version]);
  const changeLive=async(enabled:boolean)=>{
    const captured=current.current;if(!captured.active||captured.saving||!captured.settings)return;
    current.current={...captured,saving:true};setSaving(true);setSaveError(null);
    try{const next=await saveWorkspaceSettings({expectedRevision:captured.settings.revision,liveGeneration:enabled});if(mounted.current){setSettings(next);refresh(value=>value+1);}}
    catch(error){if(mounted.current)setSaveError((error as {code?:string})?.code??'NETWORK');}
    finally{if(mounted.current)setSaving(false);current.current={...current.current,saving:false};}
  };
  return <section className="settings-services" data-testid="settings-model-services"><div className="settings-services-body">
    <div className="settings-live-generation"><div><Label htmlFor="settings-live-generation">{t('redesign.settings.liveGeneration')}</Label><p id="settings-live-generation-help">{t('workspace.settings.liveHelp')}</p></div><Switch id="settings-live-generation" data-testid="settings-live-generation" checked={settings?.liveGeneration===true} disabled={!active||!settings||saving||checking} onCheckedChange={enabled=>void changeLive(enabled)} aria-describedby="settings-live-generation-help" />{!settings && <WorkbenchBadge>{t('redesign.settings.statusUnknown')}</WorkbenchBadge>}</div>
    {saveError&&<p role="alert">{t(saveError==='WORKSPACE_SETTINGS_CONFLICT'?'workspace.settings.conflict':'workspace.settings.failed')}</p>}
    {failed && <p role="alert">{t('redesign.settings.statusFailed')}</p>}
    <h2 className="settings-section-title">{t('video.providers.environment')}</h2><p className="settings-appearance-hint">{t('redesign.settings.serverOnly')}</p>
    <dl>{services.map(service => <div key={service.id}><dt>{service.label}<code>{service.variable}</code></dt><dd><WorkbenchBadge tone={status?.[service.id] ? 'success' : 'neutral'}>{status && Object.hasOwn(status, service.id) ? t(status[service.id] ? 'redesign.settings.configured' : 'redesign.settings.notConfigured') : t('redesign.settings.statusUnknown')}</WorkbenchBadge><WorkbenchButton variant="ghost" data-testid={`settings-service-check-${service.id}`} aria-label={`${t('redesign.settings.detect')} ${service.label}`} disabled={!active || checking} loading={checking} onClick={() => { if (current.current.active && !checking) refresh(value => value + 1); }}>{t('redesign.settings.detect')}</WorkbenchButton></dd></div>)}<div><dt>{t('shell.openaiImage')}</dt><dd><WorkbenchButton variant="ghost" data-testid="settings-service-official" disabled={!active||!onOpenOfficial} onClick={()=>{if(current.current.active)onOpenOfficial?.();}}>{t('workspace.settings.open')}</WorkbenchButton></dd></div><div><dt>{t('redesign.settings.localSimulation')}</dt><dd><WorkbenchBadge tone={simulation ? 'success' : 'neutral'}>{t(simulation === null ? 'redesign.settings.statusUnknown' : simulation ? 'workspace.tools.supported' : 'workspace.tools.missing')}</WorkbenchBadge></dd></div></dl>
    </div><footer className="settings-page-actions settings-services-actions"><WorkbenchBadge tone={saveError||failed?'warning':settings?'success':'neutral'} dot>{t(saving?'workspace.settings.saving':saveError||failed?'workspace.settings.unconfirmed':checking?'workspace.settings.reading':settings?'workspace.settings.instant':'workspace.settings.reading')}</WorkbenchBadge><WorkbenchButton disabled={!active||saving||checking} onClick={()=>{if(current.current.active&&!current.current.saving)refresh(value=>value+1);}}>{t('agent.authorization.refresh')}</WorkbenchButton></footer>
  </section>;
}
export function SettingsShortcuts() {
  const { t } = useI18n();
  const command = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const shortcuts = [['undo', `${command}Z`], ['redo', `⇧${command}Z`], ['split', `${command}B`], ['remove', '⌫'], ['ripple', '⇧⌫'], ['play', t('redesign.settings.space')]] as const;
  return <dl className="settings-shortcuts" data-testid="settings-shortcuts">{shortcuts.map(([name, keys]) => <div key={name}><dt>{t(`redesign.settings.${name}`)}</dt><dd><kbd className="wb-shortcut">{keys}</kbd></dd></div>)}</dl>;
}
export function SettingsAbout({ active }: { active: boolean }) {
  const { t } = useI18n(), [info, setInfo] = useState<WorkspaceInfo | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => { if (!active) return; let live = true; const abort = new AbortController(); void readWorkspaceInfo(abort.signal).then(value => { if (live) { setInfo(value); setFailed(false); } }).catch(() => { if (live) setFailed(true); }); return () => { live = false; abort.abort(); }; }, [active]);
  return <section className="settings-about" data-testid="settings-about"><h2>Mioon</h2><dl><div><dt>{t('redesign.settings.version')}</dt><dd>{info?.version ?? '—'}</dd></div><div><dt>{t('redesign.settings.channel')}</dt><dd>{info ? t(info.channel === 'development' ? 'redesign.settings.development' : 'redesign.settings.stable') : '—'}</dd></div></dl>
    {failed && <p role="status">{t('workspace.info.failed')}</p>}<p>{info?.dataDirectory}</p><h3>{t('redesign.settings.licenses')}</h3><p>React · MIT<br />Base UI · MIT<br />React Flow · MIT<br />Tailwind CSS · MIT<br />Electron · MIT</p><p>{t('redesign.settings.ffmpegNotice')}</p>
  </section>;
}
