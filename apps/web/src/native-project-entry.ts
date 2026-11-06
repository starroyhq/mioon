import { useEffect, useRef, useState } from 'react';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { createLauncherClient } from './launcher-state.ts';
import type { LauncherContractChecks, LauncherRpc } from './launcher-state.ts';
import { createProjectEntryController } from './project-entry-state.ts';
import type { ProjectEntryConsumption, ProjectEntryController } from './project-entry-state.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
import {createProjectEntryIdentityOwner, readProjectEntryIdentity} from './project-entry-identity.ts';
import type {ProjectEntryIdentityOwner} from './project-entry-identity.ts';
import {readProjectEntryDesktopClient} from './project-entry-desktop-client.ts';
import {createNativeProjectDesktopController} from './native-project-desktop-state.ts';
import type {NativeProjectDesktopController} from './native-project-desktop-state.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
export interface NativeProjectEntryActions {
  readonly desktop?: NativeProjectDesktopController | null;
  readonly identity: ProjectEntryIdentityOwner | null;
  readonly open: (projectId: string) => Promise<boolean>;
  readonly show: (mode: 'open' | 'new') => Promise<boolean>;
  readonly readCloseSnapshot: ProjectEntryController['readCloseSnapshot'];
}
type EntryWindow = Window & { __mioonProjectEntryAdmission?: { consume(token: string, projectId: string): ProjectEntryConsumption } };
export function useNativeProjectEntry({ context, bridge, rpc, contractChecks, identity: suppliedIdentity = null, manageIdentityLifecycle = true }: {
  context: ProjectWindowContext; bridge: ProjectWindowBridge; rpc: LauncherRpc; contractChecks: LauncherContractChecks;
  identity?: ProjectEntryIdentityOwner | null; manageIdentityLifecycle?: boolean;
}) {
  const confirm = useConfirmation();
  const {t} = useI18n();
  const translate = useRef(t); translate.current = t;
  const [, rerender] = useState(0);
  const [desktopClient] = useState(() => readProjectEntryDesktopClient(typeof window === 'undefined' ? null : window));
  const desktopRef = useRef<NativeProjectDesktopController | null>(null);
  const [identity] = useState(() => suppliedIdentity ?? createProjectEntryIdentityOwner({
    ...(contractChecks.readDirectory ? {read: () => contractChecks.readDirectory!()} : {}),
  }));
  const [controller] = useState(() => createProjectEntryController({ client: createLauncherClient(rpc, {...contractChecks,
    readDirectory: () => readProjectEntryIdentity(identity)}), context, bridge, identity, manageIdentityLifecycle,
    desktopClient, readAdditionalSnapshot: () => desktopRef.current?.readCloseSnapshot() ?? {dirty: false, busy: false, unknown: false, identity: []},
    onNativeOpenError: (error, id) => desktopRef.current?.observeError(error, 'open', id),
    readNativeDraftVersion: () => desktopRef.current?.getDraftVersion() ?? 0,
    explicitProjectId: context.role === 'launcher' ? new URLSearchParams(window.location.search).get('project') : null,
    confirm, onChange: () => rerender(value => value + 1) }));
  const [desktop] = useState(() => desktopClient ? createNativeProjectDesktopController({client: desktopClient, identity,
    beforeAction: async preserveDraft => await controller.prepareNativeResultDeparture(preserveDraft) ?? false, openCreated: async (id, grant) => {
      if (controller.getState().openUnknown) {await controller.reconcileOpen(); return !controller.getState().openUnknown && controller.getContext().entryReceipt?.result.ok === true;}
      if (grant && !grant()) return false;
      const permitted = grant ?? await controller.prepareNativeResultDeparture(false);
      return permitted ? controller.openNativeCreated(id, permitted) : false;
    },
    onOpened: controller.finishNativeOpen,
    isCurrent: controller.isNativeActionCurrent,
    canStart: controller.canStartNativeAction,
    message: () => translate.current('projectFile.storage.destinationMessage'), onChange: () => rerender(value => value + 1)}) : null);
  desktopRef.current = desktop;
  useEffect(() => {
    let effectActive = true;
    controller.activate();
    desktop?.activate();
    const releaseIdentity = identity.subscribe(() => rerender(value => value + 1));
    const win = window as EntryWindow, admission = { consume: controller.consume };
    win.__mioonProjectEntryAdmission = admission;
    const updateContext = (next: ProjectWindowContext) => {controller.updateContext(next); if (next.leaseRevoked || next.quitting) desktop?.retireOwner();};
    const release = bridge.subscribe(updateContext);
    let wasVisible = document.visibilityState !== 'hidden', bootPending = context.role === 'launcher';
    const visibility = () => {
      if (!effectActive) return;
      const visible = document.visibilityState !== 'hidden', returned = !wasVisible && visible;
      wasVisible = visible;
      controller.setVisible(visible);
      // Do not supersede boot's first catalog and initial choice. A launcher
      // that finished boot while hidden still refreshes on its first reveal.
      if (returned && context.role === 'launcher' && (!bootPending || controller.getState().catalogReady)) void controller.refresh().then(() => desktop?.resumeKnownOpen(false));
      else if (returned) void desktop?.resumeKnownOpen(context.role === 'editor');
      if (returned && desktop && !desktop.getState().capabilities) void desktop.initialize(context.role === 'editor');
    };
    const interaction = () => {if (effectActive) controller.interacted();};
    visibility(); updateContext(context);
    if (context.role === 'launcher') void controller.boot().then(() => {if (effectActive) return desktop?.initialize(false);}).finally(() => { bootPending = false; });
    else void desktop?.initialize(true);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('input', interaction, true); document.addEventListener('pointerdown', interaction, true); document.addEventListener('keydown', interaction, true);
    return () => {
      effectActive = false;
      release(); releaseIdentity(); desktop?.dispose(); controller.dispose();
      if (win.__mioonProjectEntryAdmission === admission) delete win.__mioonProjectEntryAdmission;
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('input', interaction, true); document.removeEventListener('pointerdown', interaction, true); document.removeEventListener('keydown', interaction, true);
    };
  }, [controller, bridge, identity, desktop]);
  useEffect(() => {controller.updateContext(context); if (context.leaseRevoked || context.quitting) desktop?.retireOwner();}, [controller, context, desktop]);
  return Object.assign(controller, {desktop});
}
