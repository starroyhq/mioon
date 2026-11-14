import React, { useEffect, useState } from 'react';
import { useI18n } from './i18n/I18nProvider.tsx';
import { readWorkspaceInfo } from './workspace-info-client.ts';
import type { WorkspaceMetadata } from '../../../packages/contracts/src/workspace-info.ts';
import {MENU_COMMAND_ACCELERATORS, MENU_COMMAND_LOCAL_SHORTCUTS, MENU_COMMAND_WINDOWS_REDO_SHORTCUT} from '../../desktop/src/menu-command-protocol.ts';

export function SettingsShortcuts() {
  const { t } = useI18n();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const format = (value: string) => value === 'Space' ? t('redesign.settings.space') : mac
    ? value.replace('CmdOrCtrl+Shift+', '⇧⌘').replace('CmdOrCtrl+', '⌘').replace('Shift+', '⇧').replace('Backspace', '⌫')
    : value.replace('CmdOrCtrl', 'Ctrl').replace('Backspace', '⌫');
  const shortcuts = [
    ['redesign.settings.undo', format(MENU_COMMAND_ACCELERATORS['edit-undo'])],
    ['redesign.settings.redo', `${format(MENU_COMMAND_ACCELERATORS['edit-redo'])}${mac ? '' : ` / ${format(MENU_COMMAND_WINDOWS_REDO_SHORTCUT)}`}`],
    ['redesign.settings.split', format(MENU_COMMAND_ACCELERATORS['clip-split'])],
    ['redesign.settings.remove', format(MENU_COMMAND_LOCAL_SHORTCUTS['clip-remove'])],
    ['redesign.settings.ripple', format(MENU_COMMAND_LOCAL_SHORTCUTS['clip-ripple-remove'])],
    ['redesign.settings.play', format(MENU_COMMAND_LOCAL_SHORTCUTS['playback-toggle'])],
    ['assets.importLocal', format(MENU_COMMAND_ACCELERATORS['import-media'])],
    ['redesign.shell.export', format(MENU_COMMAND_ACCELERATORS.export)],
  ] as const;
  return <dl className="settings-shortcuts" data-testid="settings-shortcuts">{shortcuts.map(([label, keys]) => <div key={label}><dt>{t(label)}</dt><dd><kbd className="wb-shortcut">{keys}</kbd></dd></div>)}</dl>;
}
export function SettingsAbout({ active }: { active: boolean }) {
  const { t } = useI18n(), [info, setInfo] = useState<WorkspaceMetadata | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => { if (!active) return; let live = true; const abort = new AbortController(); void readWorkspaceInfo(abort.signal,'metadata').then(value => { if (live) { setInfo(value); setFailed(false); } }).catch(() => { if (live) setFailed(true); }); return () => { live = false; abort.abort(); }; }, [active]);
  return <section className="settings-about" data-testid="settings-about"><h2>Mioon</h2><dl><div><dt>{t('redesign.settings.version')}</dt><dd>{info?.version ?? '—'}</dd></div><div><dt>{t('redesign.settings.channel')}</dt><dd>{info ? t(info.channel === 'development' ? 'redesign.settings.development' : 'redesign.settings.stable') : '—'}</dd></div></dl>
    {failed && <p role="status">{t('workspace.info.failed')}</p>}<p>{info?.dataDirectory}</p><h3>{t('redesign.settings.licenses')}</h3><p>React · MIT<br />Base UI · MIT<br />React Flow · MIT<br />Tailwind CSS · MIT<br />Electron · MIT</p><p>{t('redesign.settings.ffmpegNotice')}</p>
  </section>;
}
