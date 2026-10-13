import React, { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import LauncherRoot from './LauncherRoot.tsx';
import type { LauncherSettingsProps } from './LauncherRoot.tsx';
import type { LauncherContractChecks, LauncherRpc } from './launcher-state.ts';
import { readDesktopWindowBridge } from './desktop-window-client.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';

export interface DesktopRootProps {
  readonly rpc: LauncherRpc;
  readonly contractChecks: LauncherContractChecks;
  readonly renderWeb: () => ReactNode;
  readonly renderEditor: (context: ProjectWindowContext, bridge: ProjectWindowBridge) => ReactNode;
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
  if (host.kind === 'failed') return <main className="boot-page" role="alert"><h1>窗口身份未确认</h1><p>请保留当前窗口，重新启动前先核对是否有未完成的输入。</p></main>;
  if (host.kind === 'pending') return <main className="boot-page" role="status">正在核对桌面窗口…</main>;
  return host.context.role === 'launcher'
    ? <LauncherRoot key={host.context.contextId} context={host.context} bridge={host.bridge} rpc={rpc} contractChecks={contractChecks} renderSettings={renderSettings} />
    : <>{renderEditor(host.context, host.bridge)}</>;
}
