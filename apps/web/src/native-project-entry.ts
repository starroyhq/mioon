import { useEffect, useState } from 'react';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { createLauncherClient } from './launcher-state.ts';
import type { LauncherContractChecks, LauncherRpc } from './launcher-state.ts';
import { createProjectEntryController } from './project-entry-state.ts';
import type { ProjectEntryConsumption, ProjectEntryController } from './project-entry-state.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
import {createProjectEntryIdentityOwner, readProjectEntryIdentity} from './project-entry-identity.ts';
import type {ProjectEntryIdentityOwner} from './project-entry-identity.ts';
export interface NativeProjectEntryActions {
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
  const [, rerender] = useState(0);
  const [identity] = useState(() => suppliedIdentity ?? createProjectEntryIdentityOwner({
    ...(contractChecks.readDirectory ? {read: () => contractChecks.readDirectory!()} : {}),
  }));
  const [controller] = useState(() => createProjectEntryController({ client: createLauncherClient(rpc, {...contractChecks,
    readDirectory: () => readProjectEntryIdentity(identity)}), context, bridge, identity, manageIdentityLifecycle,
    explicitProjectId: context.role === 'launcher' ? new URLSearchParams(window.location.search).get('project') : null,
    confirm, onChange: () => rerender(value => value + 1) }));
  useEffect(() => {
    controller.activate();
    const releaseIdentity = identity.subscribe(() => rerender(value => value + 1));
    const win = window as EntryWindow, admission = { consume: controller.consume };
    win.__mioonProjectEntryAdmission = admission;
    const release = bridge.subscribe(controller.updateContext);
    let wasVisible = document.visibilityState !== 'hidden', bootPending = context.role === 'launcher';
    const visibility = () => {
      const visible = document.visibilityState !== 'hidden', returned = !wasVisible && visible;
      wasVisible = visible;
      controller.setVisible(visible);
      // Do not supersede boot's first catalog and initial choice. A launcher
      // that finished boot while hidden still refreshes on its first reveal.
      if (returned && context.role === 'launcher' && (!bootPending || controller.getState().catalogReady)) void controller.refresh();
    };
    const interaction = () => controller.interacted();
    visibility(); controller.updateContext(context); if (context.role === 'launcher') void controller.boot().finally(() => { bootPending = false; });
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('input', interaction, true); document.addEventListener('pointerdown', interaction, true); document.addEventListener('keydown', interaction, true);
    return () => {
      release(); releaseIdentity(); controller.dispose();
      if (win.__mioonProjectEntryAdmission === admission) delete win.__mioonProjectEntryAdmission;
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('input', interaction, true); document.removeEventListener('pointerdown', interaction, true); document.removeEventListener('keydown', interaction, true);
    };
  }, [controller, bridge, identity]);
  useEffect(() => controller.updateContext(context), [controller, context]);
  return controller;
}
