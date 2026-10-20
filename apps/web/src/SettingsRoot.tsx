import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { createSettingsNavigationRegistry } from './settings-navigation-state.ts';
import type { SettingsNavigationRegistry } from './settings-navigation-state.ts';
import { createNativeCloseRegistry, installNativeCloseAdmission } from './native-close-state.ts';
import { createLauncherClient } from './launcher-state.ts';
import type { LauncherContractChecks, LauncherRpc } from './launcher-state.ts';
import type { ProjectWindowBridge, ProjectWindowContext, ProjectWindowSettingsSlot } from './desktop-window-client.ts';
import ProjectHomeConnections from './ProjectHomeConnections.tsx';
import NativeLocatorStatus from './NativeLocatorStatus.tsx';
import type { SettingsPage } from './settings-window-state.ts';
import { createSettingsWindowNavigation } from './settings-window-state.ts';
export interface SettingsRenderProps {
  readonly selected: ProjectWindowSettingsSlot;
  readonly page: SettingsPage;
  readonly onPage: (page: SettingsPage) => void;
  readonly general: ReactNode;
  readonly connectionsAvailable?: boolean;
  readonly visible: boolean;
  readonly registry: SettingsNavigationRegistry;
  readonly onSelect: (slot: ProjectWindowSettingsSlot) => void;
  readonly beforeClose: () => Promise<boolean>;
  readonly onClose: () => void;
}
type SettingsWindow = Window & { __mioonFlushWorkspacePreferences?: () => Promise<boolean> };
/** The singleton owns the same settings forms for its entire document life.
 * Requesting editors have no handle capable of clearing or disposing them. */
export default function SettingsRoot({ context, bridge, rpc, contractChecks, renderSettings }: {
  context: ProjectWindowContext; bridge: ProjectWindowBridge; rpc: LauncherRpc; contractChecks: LauncherContractChecks;
  renderSettings: (props: SettingsRenderProps) => ReactNode;
}) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const confirm = useConfirmation();
  const registry = useRef(createSettingsNavigationRegistry()).current, native = useRef(createNativeCloseRegistry()).current;
  const [, rerender] = useState(0);
  const [navigation] = useState(() => createSettingsWindowNavigation({ context, registry, confirm, onChange: () => rerender(value => value + 1) }));
  const [workspace, setWorkspace] = useState<'pending' | 'ready' | 'restored' | 'failed'>('pending');
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    let active = true; navigation.activate();
    const release = bridge.subscribe(navigation.receive);
    const visibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', visibility);
    const win = window as SettingsWindow;
    const cleanup = installNativeCloseAdmission(win as Parameters<typeof installNativeCloseAdmission>[0], { registry: native, settings: registry,
      readScope: () => `${context.backendId}:${context.contextId}:${navigation.version}`, readDocumentURL: () => window.location.href });
    const drain = async () => registry.canLeave(registry.capture());
    win.__mioonFlushWorkspacePreferences = drain;
    void createLauncherClient(rpc, contractChecks).inspect().then(value => { if (active) setWorkspace(value.restored ? 'restored' : 'ready'); }, () => { if (active) setWorkspace('failed'); });
    return () => { active = false; release(); navigation.dispose(); cleanup(); document.removeEventListener('visibilitychange', visibility);
      if (win.__mioonFlushWorkspacePreferences === drain) delete win.__mioonFlushWorkspacePreferences; };
  }, [bridge, navigation, native, registry]);
  useEffect(() => navigation.receive(context), [navigation, context]);
  return <main className="project-home project-home-settings-window"><header className="project-home-header"><span className="project-home-brand">Mioon</span><span className="project-home-header-label">{t('settings.title')}</span>
      <details className="settings-workspace-status settings-workspace-status-global" open={workspace === 'failed' || workspace === 'restored'}><summary>{t('settings.workspaceStatus')}</summary><div><NativeLocatorStatus context={context} bridge={bridge} recovery /></div></details>
    </header>
    <section className="project-home-settings" aria-label={t('settings.title')}>
      {navigation.notice && <p role="status" className="project-home-notice">{renderMessage(navigation.notice)}</p>}
      <div className="native-settings-center-body">
      {workspace === 'ready' ? renderSettings({ selected: navigation.selected, page: navigation.page, visible, registry, onSelect: slot => { void navigation.select(slot); }, onPage: page => { void navigation.selectPage(page); },
        general: undefined,
        // Only native P0 decides actual closure. Returning false prevents the
        // form from clearing secrets before the native dialog has decided.
        beforeClose: async () => { window.close(); return false; }, onClose: () => {} })
        : <><p role="status" className="native-settings-unavailable">{workspace === 'pending' ? t('shell.checkingWorkspace') : workspace === 'restored' ? t('shell.restoredConnectionsUnavailable') : t('shell.workspaceUnconfirmed')}</p><ProjectHomeConnections selected="agent" page="general" connectionsAvailable={false} onSelect={() => {}} onPage={() => {}} panes={{ agent: null, official: null, custom: null, comfy: null }} /></>}
      </div>
    </section></main>;
}
