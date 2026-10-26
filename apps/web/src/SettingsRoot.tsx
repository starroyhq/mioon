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
import type { SettingsConnectionPage, SettingsPage } from './settings-window-state.ts';
import { createSettingsWindowNavigation } from './settings-window-state.ts';
import { Button } from '@mioon/ui/components/button';
import { WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
import { useUiPreferences } from './UiPreferencesProvider.tsx';
export interface SettingsRenderProps {
  readonly selected: SettingsConnectionPage;
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
  const { pauseObservation } = useUiPreferences();
  const registry = useRef(createSettingsNavigationRegistry()).current, native = useRef(createNativeCloseRegistry()).current;
  const [, rerender] = useState(0);
  const [navigation] = useState(() => createSettingsWindowNavigation({ context, registry, confirm, onChange: () => rerender(value => value + 1) }));
  const [workspace, setWorkspace] = useState<'pending' | 'ready' | 'restored' | 'failed'>('pending');
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [closeFailed, setCloseFailed] = useState(false);
  const active = useRef(true), closeRequest = useRef<Promise<void> | null>(null);
  const requestClose = (): Promise<void> => {
    if (!active.current) return Promise.resolve();
    if (closeRequest.current) return closeRequest.current;
    setCloseFailed(false);
    // Browser window.close() can be stopped by renderer beforeunload before
    // main gets a close event. Ask main to close this verified settings owner
    // so its native admission runs before any renderer leave decision.
    const request = Promise.resolve().then(() => active.current ? bridge.closeSettings() : false).then(accepted => {
      if (active.current && !accepted) setCloseFailed(true);
    }, () => { if (active.current) setCloseFailed(true); }).finally(() => { if (closeRequest.current === request) closeRequest.current = null; });
    closeRequest.current = request;
    return request;
  };
  useEffect(() => {
    let current = true; active.current = true; navigation.activate();
    const release = bridge.subscribe(navigation.receive);
    const visibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', visibility);
    const win = window as SettingsWindow;
    const cleanup = installNativeCloseAdmission(win as Parameters<typeof installNativeCloseAdmission>[0], { registry: native, settings: registry,
      onObservationPause: pauseObservation,
      readScope: () => `${context.backendId}:${context.contextId}:${navigation.version}`, readDocumentURL: () => window.location.href });
    const drain = async () => registry.canLeave(registry.capture());
    win.__mioonFlushWorkspacePreferences = drain;
    void createLauncherClient(rpc, contractChecks).inspect().then(value => { if (current) setWorkspace(value.restored ? 'restored' : 'ready'); }, () => { if (current) setWorkspace('failed'); });
    return () => { current = false; active.current = false; release(); navigation.dispose(); cleanup(); pauseObservation(false); document.removeEventListener('visibilitychange', visibility);
      if (win.__mioonFlushWorkspacePreferences === drain) delete win.__mioonFlushWorkspacePreferences; };
  }, [bridge, navigation, native, registry, pauseObservation]);
  useEffect(() => navigation.receive(context), [navigation, context]);
  return <main className="project-home project-home-settings-window native-settings-panel"><header className="native-settings-panel-header"><span className="native-settings-panel-title">{t('settings.title')}</span>
      <details className="settings-workspace-status settings-workspace-status-global" open={workspace === 'failed' || workspace === 'restored'}><summary>{t('settings.workspaceStatus')}</summary><div><NativeLocatorStatus context={context} bridge={bridge} recovery /></div></details>
      <Button type="button" variant="ghost" className="native-settings-panel-close" data-testid="native-settings-panel-close" aria-label={t('common.closeSettings')} title={t('common.closeSettings')} onClick={() => { void requestClose(); }}><WorkbenchIcon name="close" /></Button>
    </header>
    <section className="project-home-settings" aria-label={t('settings.title')}>
      {closeFailed && <p role="alert" className="project-home-notice" data-testid="native-settings-close-failed">{t('native.leaveUnverified')}</p>}
      {navigation.notice && <p role="status" className="project-home-notice">{renderMessage(navigation.notice)}</p>}
      <div className="native-settings-center-body">
      {workspace === 'ready' ? renderSettings({ selected: navigation.selected, page: navigation.page, visible, registry, onSelect: slot => { void navigation.select(slot); }, onPage: page => { void navigation.selectPage(page); },
        general: undefined,
        // Only native P0 decides actual closure. Returning false prevents the
        // form from clearing secrets before the native dialog has decided.
        beforeClose: async () => { await requestClose(); return false; }, onClose: () => {} })
        : <><p role="status" className="native-settings-unavailable">{workspace === 'pending' ? t('shell.checkingWorkspace') : workspace === 'restored' ? t('shell.restoredConnectionsUnavailable') : t('shell.workspaceUnconfirmed')}</p><ProjectHomeConnections selected="agent" page="general" connectionsAvailable={false} onSelect={() => {}} onPage={() => {}} panes={{ agent: null, official: null, custom: null, comfy: null }} /></>}
      </div>
    </section></main>;
}
