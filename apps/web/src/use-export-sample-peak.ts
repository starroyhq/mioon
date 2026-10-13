import { useLayoutEffect, useRef, useState } from 'react';
import { createExportSamplePeakController, exportSamplePeakViewState } from './export-sample-peak-state.ts';
import type { ExportSamplePeakContext, ExportSamplePeakController, ExportSamplePeakControllerOptions, ExportSamplePeakState, ExportSamplePeakView } from './export-sample-peak-state.ts';

export function useExportSamplePeak(options: ExportSamplePeakControllerOptions & { context: ExportSamplePeakContext }): ExportSamplePeakView {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<ExportSamplePeakState | null>(null);
  const controller = useRef<ExportSamplePeakController | null>(null);
  if (!controller.current) controller.current = createExportSamplePeakController({
    read: (input, invocation) => callbacks.current.read(input, invocation),
    isRenderRecord: (value, input) => callbacks.current.isRenderRecord(value, input),
    getContext: () => callbacks.current.getContext?.() ?? callbacks.current.context,
    getInvocation: () => callbacks.current.getInvocation?.() ?? {},
    onUnauthorized: () => callbacks.current.onUnauthorized?.(), onChange: setState,
  });
  const owned = controller.current;
  useLayoutEffect(() => { owned.attach(callbacks.current.context); return () => owned.dispose(); }, [owned]);
  useLayoutEffect(() => { owned.setContext(options.context); });
  // Mount, new rows, polling, visibility and reconnect never call check().
  return { state: exportSamplePeakViewState(state ?? owned.getState(), options.context, options.isRenderRecord), controller: owned };
}
