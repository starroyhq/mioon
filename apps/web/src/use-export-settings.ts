import { useLayoutEffect, useRef, useState } from 'react';
import { createExportSettingsController } from './export-settings-state.ts';

export type ExportSettingsController=ReturnType<typeof createExportSettingsController>;
export interface UseExportSettingsOptions {
  scope: string|null;
  enabled: unknown;
  getContext: ()=>unknown;
}
export interface UseExportSettingsState {scope: string|null; version: unknown; value: unknown; controller: ExportSettingsController}
interface ExportSettingsSnapshot {scope?: unknown; version?: unknown; exportSettings?: unknown}

export function useExportSettings({ scope, enabled, getContext }: UseExportSettingsOptions): UseExportSettingsState {
  const callbacks = useRef({ getContext }); callbacks.current = { getContext };
  const [state, setState] = useState<ExportSettingsSnapshot|null>(null), controller = useRef<ExportSettingsController|null>(null);
  if (!controller.current) controller.current = createExportSettingsController({ onChange: ((next: unknown) => setState(next as ExportSettingsSnapshot)) as unknown as ()=>void,
    getContext: () => callbacks.current.getContext() } as never);
  useLayoutEffect(() => { controller.current!.setContext({ scope, enabled }); }, [scope, enabled]);
  return { scope, version: state?.scope === scope ? state.version : controller.current.getVersion(scope), value: state?.scope === scope ? state.exportSettings : controller.current.getSettings(scope), controller: controller.current };
}
