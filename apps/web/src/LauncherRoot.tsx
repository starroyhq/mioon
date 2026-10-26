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
import {createDesktopMenuController, readDesktopMenuBridge, launcherMenuView, nativeMenuTextFocus} from './desktop-menu-client.ts';
import type {MenuHelpControl} from './desktop-menu-client.ts';
import {hasOpenWorkbenchModal} from './workbench-modal-state.ts';
export type { SettingsRenderProps as LauncherSettingsProps } from './SettingsRoot.tsx';
export interface LauncherRootProps { readonly context: ProjectWindowContext; readonly bridge: ProjectWindowBridge; readonly rpc: LauncherRpc; readonly contractChecks: LauncherContractChecks }
type LauncherWindow = Window & { __mioonFlushWorkspacePreferences?: () => Promise<boolean> };
/** Always-mounted project entry and the sole native locator writer. Global
 * connection forms live only in SettingsRoot, never in the hidden launcher. */
export default function LauncherRoot({ context, bridge, rpc, contractChecks }: LauncherRootProps) {
  const [, rerender] = useState(0);
  const mounted = useRef(false);
  const menuSession = useRef<ReturnType<typeof createDesktopMenuController> | null>(null), menuHelp = useRef<MenuHelpControl | null>(null), composing = useRef(false);
  const [menuBridge] = useState(() => {try {return typeof window === 'undefined' ? null : readDesktopMenuBridge(window);} catch {return null;}});
  const refreshMenu = useRef(() => menuSession.current?.refresh()).current;
  const registerMenuHelp = useRef((control: MenuHelpControl) => {
    menuHelp.current = control; refreshMenu();
    return () => {if (menuHelp.current === control) {menuHelp.current = null; refreshMenu();}};
  }).current;
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
  useEffect(() => {
    if (!menuBridge) return;
    const read = () => {
      const owner = controller.getContext(), state = controller.getState(), close = controller.readCloseSnapshot();
      return launcherMenuView({ready: mounted.current && !owner.quitting && !owner.settingsModalOpen && owner.editorCount === 0 && state.shown && state.phase !== 'opening' && !state.creating && !state.sealed && !state.createUnknown && !state.openUnknown && !close.dirty && !close.busy && !close.unknown,
        visible: document.visibilityState !== 'hidden', modalOpen: hasOpenWorkbenchModal(document), composing: composing.current,
        textFocus: nativeMenuTextFocus(document.activeElement), canHelp: Boolean(menuHelp.current?.available())});
    };
    const session = createDesktopMenuController({bridge: menuBridge, identity: {...context, version: 1}, current: () => mounted.current,
      scope: () => JSON.stringify([controller.getContext().entryVersion, controller.readCloseSnapshot()]),
      read, execute: command => command === 'show-help' && read().commands['show-help'] && menuHelp.current?.open()});
    menuSession.current = session;
    const refresh = () => session.refresh(), start = () => {composing.current = true; refresh();}, end = () => {composing.current = false; refresh();};
    document.addEventListener('focusin', refresh); document.addEventListener('focusout', refresh); document.addEventListener('visibilitychange', refresh);
    document.addEventListener('compositionstart', start); document.addEventListener('compositionend', end);
    const observer = new MutationObserver(refresh); observer.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'aria-modal', 'data-state']});
    return () => {session.dispose(); if (menuSession.current === session) menuSession.current = null;
      document.removeEventListener('focusin', refresh); document.removeEventListener('focusout', refresh); document.removeEventListener('visibilitychange', refresh);
      document.removeEventListener('compositionstart', start); document.removeEventListener('compositionend', end); observer.disconnect();};
  }, [menuBridge, controller, context.windowId, context.contextId]);
  useEffect(() => {refreshMenu();});
  const entryState = controller.getState(), locatorState = locator.getState();
  const locatorStatus = <LastProjectStatus state={locatorState} controller={locator} restored={entryState.workspace?.restored} />;
  const quietEmpty = entryState.projects.length === 0 && !entryState.workspace?.restored && !entryState.listBusy && !entryState.listError && entryState.phase === 'home'
    && (locatorState.phase === 'idle' || locatorState.phase === 'saved') && !locatorState.uncertain && !locatorState.identityBlocked && locatorState.targetStatus !== 'missing';
  return <ProjectEntry controller={controller} onSettings={slot => { void bridge.showSettings(slot); }} onRegisterMenuHelp={registerMenuHelp} onMenuHelpStateChange={refreshMenu}
    status={quietEmpty ? undefined : locatorStatus} help={locatorStatus} />;
}
