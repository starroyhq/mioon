import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import LauncherRoot from './LauncherRoot.tsx';
import SettingsRoot from './SettingsRoot.tsx';
import NativeEditorRoot from './NativeEditorRoot.tsx';
import NativeSettingsBackdrop from './NativeSettingsBackdrop.tsx';
import type { NativeProjectEntryActions } from './native-project-entry.ts';
import type { LauncherSettingsProps } from './LauncherRoot.tsx';
import type { LauncherContractChecks, LauncherRpc } from './launcher-state.ts';
import { readDesktopWindowBridge } from './desktop-window-client.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';

export interface DesktopRootProps {
  readonly rpc: LauncherRpc;
  readonly contractChecks: LauncherContractChecks;
  readonly renderWeb: () => ReactNode;
  readonly renderEditor: (context: ProjectWindowContext, bridge: ProjectWindowBridge, entry: NativeProjectEntryActions) => ReactNode;
  readonly renderSettings: (props: LauncherSettingsProps) => ReactNode;
}
type HostState = { kind: 'web' } | { kind: 'pending'; bridge: ProjectWindowBridge } | { kind: 'failed' } |
  { kind: 'native'; bridge: ProjectWindowBridge; context: ProjectWindowContext };
function initialHost(): HostState {
  try { const bridge = readDesktopWindowBridge(window); return bridge ? { kind: 'pending', bridge } : { kind: 'web' }; }
  catch { return { kind: 'failed' }; }
}

/** Only the verified preload context chooses a native role. App is supplied as
 * a render callback so launcher never mounts the editor's controller graph. */
export default function DesktopRoot({ rpc, contractChecks, renderWeb, renderEditor, renderSettings }: DesktopRootProps) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const [host, setHost] = useState<HostState>(initialHost);
  const bridge = host.kind === 'pending' || host.kind === 'native' ? host.bridge : null;
  useEffect(() => {
    if (!bridge) return;
    let active = true, eventVersion = 0;
    let release: (() => void) | undefined;
    const failed = () => { if (active) setHost({ kind: 'failed' }); };
    try {
      release = bridge.subscribe(context => {
        if (!active) return;
        eventVersion++; setHost({ kind: 'native', context, bridge });
      });
      const version = eventVersion;
      void bridge.context().then(context => { if (active && version === eventVersion) setHost({ kind: 'native', context, bridge }); }, () => { if (version === eventVersion) failed(); });
    } catch { failed(); }
    return () => { active = false; release?.(); };
  }, [bridge]);
  if (host.kind === 'web') return <>{renderWeb()}</>;
  if (host.kind === 'failed') return <main className="boot-page" role="alert"><h1>{t('shell.windowUnconfirmed')}</h1><p>{t('shell.keepWindow')}</p></main>;
  if (host.kind === 'pending') return <main className="boot-page" role="status">{t('shell.checkingWindow')}</main>;
  if (host.context.role === 'settings') return <SettingsRoot key={host.context.contextId} context={host.context} bridge={host.bridge} rpc={rpc} contractChecks={contractChecks} renderSettings={renderSettings} />;
  return <NativeSettingsBackdrop key={host.context.contextId} blocked={host.context.settingsModalOpen === true}>
    {host.context.role === 'launcher'
      ? <LauncherRoot context={host.context} bridge={host.bridge} rpc={rpc} contractChecks={contractChecks} />
      : <NativeEditorRoot context={host.context} bridge={host.bridge} rpc={rpc} contractChecks={contractChecks} renderEditor={renderEditor} />}
  </NativeSettingsBackdrop>;
}
