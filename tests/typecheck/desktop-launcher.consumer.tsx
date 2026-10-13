import React from 'react';
import DesktopRoot from '../../apps/web/src/DesktopRoot.tsx';
import type { DesktopRootProps } from '../../apps/web/src/DesktopRoot.tsx';
import type { LauncherRpc, LauncherContractChecks } from '../../apps/web/src/launcher-state.ts';
import { createLauncherClient } from '../../apps/web/src/launcher-state.ts';
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Assert<T extends true> = T;
export type RpcUnknown = Assert<IsAny<Awaited<ReturnType<LauncherRpc>>> extends false ? true : false>;
export type SettingsTyped = Assert<IsAny<Parameters<DesktopRootProps['renderSettings']>[0]> extends false ? true : false>;
export function checkLauncherBoundary(props: DesktopRootProps, rpc: LauncherRpc, checks: LauncherContractChecks) {
  const valid = <DesktopRoot {...props} />;
  // @ts-expect-error Role is assigned by verified preload, never an external prop.
  const forgedRole = <DesktopRoot {...props} role="launcher" />;
  // @ts-expect-error Contract parsers are required at the old JavaScript boundary.
  createLauncherClient(rpc);
  // @ts-expect-error Launcher cannot dispatch arbitrary business mutations.
  void rpc('generation.submit', {});
  // @ts-expect-error Unknown schema output cannot be treated as a project record.
  const name = checks.parseCreateInput({}).name;
  void valid; void forgedRole; void name;
}
