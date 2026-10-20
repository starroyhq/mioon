import React, { useEffect, useState } from 'react';
import { WorkbenchBadge, WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { useI18n } from './i18n/I18nProvider.tsx';
import { readWorkspaceInfo } from './workspace-info-client.ts';
import type { WorkspaceInfo } from '../../../packages/contracts/src/workspace-info.ts';
import { browserRpc } from './browser-rpc.ts';

const services = [
  { id: 'ark', label: 'Ark', variable: 'ARK_API_KEY' },
  { id: 'veo', label: 'Gemini', variable: 'GEMINI_API_KEY' }, { id: 'minimax', label: 'MiniMax', variable: 'MINIMAX_API_KEY' },
  { id: 'vidu', label: 'Vidu', variable: 'VIDU_API_KEY' },
] as const;
export function SettingsModelServices({ active }: { active: boolean }) {
  const { t } = useI18n(), [status, setStatus] = useState<Readonly<Record<string, boolean>> | null>(null), [failed, setFailed] = useState(false), [version, refresh] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true; const abort = new AbortController(); setFailed(false);
    void browserRpc('provider.list', {}, { signal: abort.signal }).then((response: unknown) => {
      if (!Array.isArray(response)) throw new TypeError('Invalid service status.');
      const next: Record<string, boolean> = {};
      for (const entry of response) if (entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.configured === 'boolean' && services.some(service => service.id === entry.id)) next[entry.id] = entry.configured;
      if (live) setStatus(next);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; abort.abort(); };
  }, [active, version]);
  return <section className="settings-services" data-testid="settings-model-services"><h3>{t('video.providers.environment')}</h3><p className="settings-appearance-hint">{t('redesign.settings.serverOnly')}</p>
    {failed && <p role="alert">{t('redesign.settings.statusFailed')}</p>}
    <dl>{services.map(service => <div key={service.id}><dt>{service.label}<code>{service.variable}</code></dt><dd><WorkbenchBadge tone={status?.[service.id] ? 'success' : 'neutral'}>{status ? t(status[service.id] ? 'redesign.settings.configured' : 'redesign.settings.notConfigured') : t('projects.loadingList')}</WorkbenchBadge></dd></div>)}</dl>
    <WorkbenchButton variant="ghost" disabled={!active} onClick={() => { if (active) refresh(value => value + 1); }}>{t('projects.refreshList')}</WorkbenchButton>
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
