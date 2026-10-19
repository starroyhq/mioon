import { useLayoutEffect, useRef, useState } from 'react';
import { createExportPreflightController } from './export-preflight-state.ts';
import type { ExportPreflightContext, ExportPreflightController, ExportPreflightInvocation, ExportPreflightState } from './export-preflight-state.ts';

export interface UseExportPreflightOptions {
  scope: unknown;
  projectId: unknown;
  timelineId: unknown;
  revision: unknown;
  exportSettings: unknown;
  settingsVersion: unknown;
  deliveryName: unknown;
  deliveryNameVersion: unknown;
  exportRange: unknown;
  rangeVersion: unknown;
  connected: unknown;
  visible: boolean;
  read: (input: Record<string, unknown>,options: ExportPreflightInvocation & {signal?: AbortSignal})=>Promise<unknown>;
  readCapabilities: (input: Record<string, unknown>,options: ExportPreflightInvocation & {signal?: AbortSignal})=>Promise<unknown>;
  getContext?: ()=>ExportPreflightContext|null|undefined;
  getInvocation?: ()=>ExportPreflightInvocation;
  onUnauthorized?: ()=>void;
}
export interface UseExportPreflightResult {state: ExportPreflightState|null; controller: ExportPreflightController}

export function useExportPreflight({ scope, projectId, timelineId, revision, exportSettings, settingsVersion, deliveryName, deliveryNameVersion, exportRange, rangeVersion, connected, visible, read, readCapabilities, getContext, getInvocation, onUnauthorized }: UseExportPreflightOptions): UseExportPreflightResult {
  const callbacks = useRef<UseExportPreflightOptions|null>(null);
  callbacks.current = { scope, projectId, timelineId, revision, exportSettings, settingsVersion, deliveryName, deliveryNameVersion, exportRange, rangeVersion, connected, visible, read, readCapabilities, getContext, getInvocation, onUnauthorized };
  const [state, setState] = useState<ExportPreflightState|null>(null), controller = useRef<ExportPreflightController|null>(null);
  if (!controller.current) controller.current = createExportPreflightController({
    read: (input: Record<string, unknown>,options: ExportPreflightInvocation & {signal?: AbortSignal}) => callbacks.current!.read(input, options),
    readCapabilities: (input: Record<string, unknown>,options: ExportPreflightInvocation & {signal?: AbortSignal}) => callbacks.current!.readCapabilities(input, options), onChange: setState,
    getInvocation: () => callbacks.current?.getInvocation?.() ?? {},
    getContext: getContext ? () => callbacks.current?.getContext?.() : undefined,
    onUnauthorized: () => callbacks.current?.onUnauthorized?.(),
  });
  useLayoutEffect(() => {
    controller.current!.setContext({ scope, projectId, timelineId, revision, exportSettings, settingsVersion, deliveryName, deliveryNameVersion, exportRange, rangeVersion, connected });
  }, [scope, projectId, timelineId, revision, exportSettings, settingsVersion, deliveryName, deliveryNameVersion, exportRange, rangeVersion, connected]);
  useLayoutEffect(() => { controller.current!.setVisible(visible); }, [visible]);
  useLayoutEffect(() => () => controller.current?.dispose(), []);
  // Mount, visibility, mode changes and reconnect never start a check or export.
  return { state: state?.scope === scope && state?.projectId === projectId ? state : null, controller: controller.current };
}
