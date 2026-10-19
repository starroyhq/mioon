import React, { useEffect, useRef, useState } from 'react';
import { createLastProjectController } from './last-project-state.ts';
import LastProjectStatus from './LastProjectStatus.tsx';
import { createNativeCloseRegistry, installNativeCloseAdmission } from './native-close-state.ts';
import { createSettingsNavigationRegistry } from './settings-navigation-state.ts';
import type { LauncherContractChecks, LauncherRpc } from './launcher-state.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
import { useNativeProjectEntry } from './native-project-entry.ts';
import ProjectEntry from './ProjectEntry.tsx';
import { createNativeLocatorOwner } from './native-locator-state.ts';
import type { NativeLocatorOwner } from './native-locator-state.ts';
export type { SettingsRenderProps as LauncherSettingsProps } from './SettingsRoot.tsx';
export interface LauncherRootProps { readonly context: ProjectWindowContext; readonly bridge: ProjectWindowBridge; readonly rpc: LauncherRpc; readonly contractChecks: LauncherContractChecks }
type LauncherWindow = Window & { __mioonFlushWorkspacePreferences?: () => Promise<boolean> };
/** Always-mounted project entry and the sole native locator writer. Global
 * connection forms live only in SettingsRoot, never in the hidden launcher. */
export default function LauncherRoot({ context, bridge, rpc, contractChecks }: LauncherRootProps) {
  const [, rerender] = useState(0);
  const mounted = useRef(false);
  const locatorOwner = useRef<NativeLocatorOwner | null>(null);
  const [locator] = useState(() => createLastProjectController({ onChange: () => { locatorOwner.current?.publish(); if (mounted.current) rerender(value => value + 1); } }));
  if (!locatorOwner.current) locatorOwner.current = createNativeLocatorOwner({ context, bridge, locator });
  const controller = useNativeProjectEntry({ context, bridge, rpc, contractChecks, locator });
  const native = useRef(createNativeCloseRegistry()).current, settings = useRef(createSettingsNavigationRegistry()).current;
  useEffect(() => {
    mounted.current = true;
    const owner = locatorOwner.current!; owner.activate();
    const releaseLocator = bridge.subscribe(owner.receive); owner.receive(context);
    const win = window as LauncherWindow;
    const cleanup = installNativeCloseAdmission(win as Parameters<typeof installNativeCloseAdmission>[0], { registry: native, settings,
      readScope: () => `${controller.getContext().backendId}:${controller.getContext().contextId}`,
      readAdditionalSnapshot: controller.readCloseSnapshot, readDocumentURL: () => window.location.href });
    const drain = async () => { const current = controller.readCloseSnapshot(); return !current.busy && !current.unknown && await locator.flush(); };
    win.__mioonFlushWorkspacePreferences = drain;
    return () => { mounted.current = false; releaseLocator(); owner.dispose(); cleanup(); if (win.__mioonFlushWorkspacePreferences === drain) delete win.__mioonFlushWorkspacePreferences; };
  }, [controller, locator, native, settings]);
  useEffect(() => locatorOwner.current?.receive(context), [context]);
  return <ProjectEntry controller={controller} onSettings={slot => { void bridge.showSettings(slot); }}
    status={<LastProjectStatus state={locator.getState()} controller={locator} restored={controller.getState().workspace?.restored} />} />;
}
