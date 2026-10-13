import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import ProjectHome from './ProjectHome.tsx';
import LastProjectStatus from './LastProjectStatus.tsx';
import { createLastProjectController } from './last-project-state.ts';
import { createSettingsNavigationRegistry } from './settings-navigation-state.ts';
import type { SettingsNavigationCapture, SettingsNavigationRegistry } from './settings-navigation-state.ts';
import { createNativeCloseRegistry, installNativeCloseAdmission } from './native-close-state.ts';
import { createLauncherClient, createLauncherCloseSettings, createLauncherController, launcherCreateDisabledReason } from './launcher-state.ts';
import type { LauncherContractChecks, LauncherCreateMetadata, LauncherRpc } from './launcher-state.ts';
import type { ProjectWindowBridge, ProjectWindowContext, ProjectWindowSettingsSlot } from './desktop-window-client.ts';

export interface LauncherSettingsProps {
  readonly selected: ProjectWindowSettingsSlot;
  readonly visible: boolean;
  readonly registry: SettingsNavigationRegistry;
  readonly onSelect: (slot: ProjectWindowSettingsSlot) => void;
  readonly beforeClose: () => Promise<boolean>;
  readonly onClose: () => void;
}
export interface LauncherRootProps {
  readonly context: ProjectWindowContext;
  readonly bridge: ProjectWindowBridge;
  readonly rpc: LauncherRpc;
  readonly contractChecks: LauncherContractChecks;
  readonly renderSettings: (props: LauncherSettingsProps) => ReactNode;
}
interface NavigationTicket { readonly settings: SettingsNavigationCapture; readonly serial: number; readonly localVersion: number }
type LifecycleWindow = Window & { __mioonFlushWorkspacePreferences?: () => Promise<boolean> };

/** Launcher owns only project entry, local creation and global settings. */
export default function LauncherRoot({ context, bridge, rpc, contractChecks, renderSettings }: LauncherRootProps) {
  const confirm = useConfirmation();
  const settings = useRef(createSettingsNavigationRegistry()).current;
  const native = useRef(createNativeCloseRegistry()).current;
  const metadata = useRef<LauncherCreateMetadata>({ dirty: false, busy: false, version: 0 });
  const localVersion = useRef(0), navigation = useRef(0), mounted = useRef(false);
  const [page, setPage] = useState<'projects' | 'settings'>('projects');
  const [selected, setSelected] = useState<ProjectWindowSettingsSlot>('agent');
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [notice, setNotice] = useState('');
  const [, rerender] = useState(0);
  const [locator] = useState(() => createLastProjectController({ onChange: () => { if (mounted.current) rerender(value => value + 1); } }));
  const [controller] = useState(() => createLauncherController({ client: createLauncherClient(rpc, contractChecks), context, bridge, locator,
    explicitProjectId: new URLSearchParams(window.location.search).get('project'),
    onChange: () => { localVersion.current++; if (mounted.current) rerender(value => value + 1); },
  }));
  const state = controller.getState();
  const latest = useRef({ context, page, selected, visible });
  latest.current = { context, page, selected, visible };
  const closePermission = useRef<NavigationTicket | null>(null);
  const seenSettingsVersion = useRef(0), observedSettingsVersion = useRef(0), intentOrder = useRef(0);
  const pendingHostIntent = useRef<{ version: number; order: number } | null>(null);
  function beginNavigationIntent() {
    intentOrder.current++; navigation.current++; closePermission.current = null;
  }
  function receiveContext(next: ProjectWindowContext) {
    const owner = controller.getContext();
    if (next.contextId !== owner.contextId || next.backendId !== owner.backendId || next.role !== 'launcher' || next.settingsVersion < observedSettingsVersion.current) return;
    if (next.settingsVersion > observedSettingsVersion.current) {
      // Fence older permission synchronously at IPC receipt, including when
      // React has not yet rendered the newer host-selected page or same slot.
      observedSettingsVersion.current = next.settingsVersion; beginNavigationIntent();
      pendingHostIntent.current = { version: next.settingsVersion, order: intentOrder.current };
    }
    controller.updateContext(next);
  }
  const reportCreate = useCallback((next: LauncherCreateMetadata) => {
    if (!Number.isSafeInteger(next.version) || next.version <= metadata.current.version) return;
    metadata.current = next; localVersion.current++;
  }, []);
  const readLocal = useCallback(() => ({ dirty: metadata.current.dirty, busy: metadata.current.busy || controller.getState().creating,
    blocked: false, version: localVersion.current }), [controller]);
  const [closeSettings] = useState(() => createLauncherCloseSettings(settings, readLocal));
  const sameOwner = (ticket: NavigationTicket) => mounted.current && !latest.current.context.quitting && ticket.serial === navigation.current &&
    ticket.localVersion === localVersion.current && !controller.getState().creating && !controller.getState().createUnknown;
  const stillCurrent = (ticket: NavigationTicket) => sameOwner(ticket) && settings.canLeave(ticket.settings);
  async function permission(includeCreate = false): Promise<NavigationTicket | null> {
    const ticket = { settings: settings.capture(), serial: navigation.current, localVersion: localVersion.current };
    if (!stillCurrent(ticket)) { setNotice('请先完成或核对当前设置与新建请求，再离开。'); return null; }
    if (settings.needsConfirmation(ticket.settings) || includeCreate && metadata.current.dirty) {
      if (!await confirm('当前输入尚未保存。继续离开当前页面？') || !stillCurrent(ticket)) return null;
    }
    return ticket;
  }
  async function changePage(next: 'projects' | 'settings', slot?: ProjectWindowSettingsSlot) {
    beginNavigationIntent(); controller.interacted();
    const ticket = await permission();
    if (!ticket || !stillCurrent(ticket)) return;
    navigation.current++; closePermission.current = null; setNotice('');
    if (slot) setSelected(slot);
    setPage(next);
  }
  function selectSettings(slot: ProjectWindowSettingsSlot) {
    if (latest.current.context.quitting) return;
    beginNavigationIntent(); controller.interacted(); setNotice(''); setSelected(slot);
  }
  async function open(projectId: string) {
    beginNavigationIntent(); controller.interacted();
    const ticket = await permission(true);
    if (!ticket || !stillCurrent(ticket)) return;
    navigation.current++; closePermission.current = null; setNotice('');
    await controller.open(projectId);
  }
  async function create(name: string, description: string): Promise<boolean> {
    beginNavigationIntent(); controller.interacted();
    const ticket = await permission();
    if (!ticket || !stillCurrent(ticket)) return false;
    navigation.current++; closePermission.current = null; setNotice('');
    return controller.create(name, description);
  }
  useEffect(() => {
    mounted.current = true; controller.activate();
    // Host navigation cancels startup synchronously, before React can defer a
    // context-prop render behind a completing project-list read.
    const releaseContext = bridge.subscribe(receiveContext);
    const win = window as LifecycleWindow;
    const cleanup = installNativeCloseAdmission(win, { registry: native, settings: closeSettings,
      readScope: () => `${controller.getContext().backendId}:${controller.getContext().contextId}:${navigation.current}`,
      readLegacySnapshot: () => ({ dirty: false, identity: [localVersion.current, navigation.current] }),
      readAdditionalSnapshot: () => {
        const current = controller.getState();
        return { dirty: false, busy: metadata.current.busy || current.creating, unknown: current.createUnknown,
          identity: [controller, current.version, localVersion.current, 'project.create'] };
      },
      readDocumentURL: () => window.location.href });
    const drain = async () => { const snapshot = closeSettings.capture(); return !controller.getState().createUnknown && closeSettings.canLeave(snapshot); };
    win.__mioonFlushWorkspacePreferences = drain;
    const interaction = () => controller.interacted();
    // Reading never chooses a second startup target after user input.
    document.addEventListener('input', interaction, true);
    document.addEventListener('pointerdown', interaction, true);
    document.addEventListener('keydown', interaction, true);
    const visibility = () => { navigation.current++; closePermission.current = null; setVisible(document.visibilityState !== 'hidden'); };
    document.addEventListener('visibilitychange', visibility);
    void controller.boot();
    return () => {
      mounted.current = false; releaseContext(); controller.dispose(); cleanup();
      if (win.__mioonFlushWorkspacePreferences === drain) delete win.__mioonFlushWorkspacePreferences;
      document.removeEventListener('input', interaction, true); document.removeEventListener('pointerdown', interaction, true); document.removeEventListener('keydown', interaction, true);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [controller, native, closeSettings, bridge]);
  useEffect(() => { receiveContext(context); }, [controller, context]);
  useEffect(() => {
    if (context.settingsVersion <= seenSettingsVersion.current || context.settingsVersion !== observedSettingsVersion.current || !state.workspace) return;
    seenSettingsVersion.current = context.settingsVersion;
    const pending = pendingHostIntent.current;
    // A local choice after this IPC was received wins even if this effect was
    // deferred. Consume denied/cancelled intents once; only a new host request
    // may ask again. Visibility changes alone do not replace user intent.
    if (!pending || pending.version !== context.settingsVersion || pending.order !== intentOrder.current) return;
    pendingHostIntent.current = null;
    if (context.settingsSlot === null) {
      if (latest.current.page !== 'projects') void changePage('projects');
      return;
    }
    if (state.workspace.restored) { setNotice('恢复分支不提供模型连接设置。'); return; }
    if (latest.current.page === 'settings') selectSettings(context.settingsSlot);
    else void changePage('settings', context.settingsSlot);
  }, [context.settingsVersion, context.settingsSlot, state.workspace]);
  const settingsPane = state.workspace?.restored ? <p role="status">恢复分支不提供模型连接设置。</p>
    : state.workspace ? renderSettings({ selected, visible: visible && page === 'settings', registry: settings,
      onSelect: selectSettings,
      beforeClose: async () => { beginNavigationIntent(); const ticket = await permission(); closePermission.current = ticket; return Boolean(ticket); },
      onClose: () => {
        const ticket = closePermission.current; closePermission.current = null;
        // The existing form rechecks its exact permission before synchronously
        // clearing secrets and reporting that cleanup, then invokes onClose.
        if (!ticket || !sameOwner(ticket) || !settings.canLeave(settings.capture())) return;
        navigation.current++; setPage('projects');
      },
    }) : <p role="status">正在核对工作区身份…</p>;
  return <ProjectHome projects={state.projects} phase={state.phase} openingName={state.projects.find(project => project.id === state.openingProjectId)?.name}
    error={state.error} notice={notice || state.notice} busy={state.creating || context.quitting} listBusy={state.listBusy} listError={state.listError}
    page={page} onPage={next => { void changePage(next); }} onOpen={projectId => { void open(projectId); }}
    onRetry={() => { if (state.openingProjectId) void open(state.openingProjectId); }} onRefresh={() => { controller.interacted(); void controller.refresh(); }}
    onCreate={create} createDisabledReason={launcherCreateDisabledReason(context, state)} onCreateStateChange={reportCreate}
    status={<><LastProjectStatus state={locator.getState()} controller={locator} restored={state.workspace?.restored} />
      {state.workspace?.restored && <span role="status">恢复分支：仅本地查看、编辑与导出</span>}</>} settings={settingsPane} />;
}
