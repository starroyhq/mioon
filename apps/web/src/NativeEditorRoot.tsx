import React from 'react';
import type { ReactNode } from 'react';
import ProjectEntry from './ProjectEntry.tsx';
import { useNativeProjectEntry } from './native-project-entry.ts';
import type { NativeProjectEntryActions } from './native-project-entry.ts';
import type { LauncherContractChecks, LauncherRpc } from './launcher-state.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
export default function NativeEditorRoot({ context, bridge, rpc, contractChecks, renderEditor }: {
  context: ProjectWindowContext; bridge: ProjectWindowBridge; rpc: LauncherRpc; contractChecks: LauncherContractChecks;
  renderEditor: (context: ProjectWindowContext, bridge: ProjectWindowBridge, entry: NativeProjectEntryActions) => ReactNode;
}) {
  const entry = useNativeProjectEntry({ context, bridge, rpc, contractChecks });
  return <>{renderEditor(context, bridge, entry)}<ProjectEntry controller={entry} editor onSettings={slot => { void bridge.showSettings(slot); }} /></>;
}
