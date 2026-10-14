import { useLayoutEffect, useRef, useState } from 'react';
import { createExportLoudnessController, exportLoudnessViewState } from './export-loudness-state.ts';
import type { ExportLoudnessContext, ExportLoudnessController, ExportLoudnessControllerOptions, ExportLoudnessState, ExportLoudnessView } from './export-loudness-state.ts';

export function useExportLoudness(options: ExportLoudnessControllerOptions & { context: ExportLoudnessContext }): ExportLoudnessView {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<ExportLoudnessState | null>(null);
  const controller = useRef<ExportLoudnessController | null>(null);
  if (!controller.current) controller.current = createExportLoudnessController({
    read: (input, invocation) => callbacks.current.read(input, invocation),
    isRenderRecord: (value, input) => callbacks.current.isRenderRecord(value, input),
    getContext: () => callbacks.current.getContext?.() ?? callbacks.current.context,
    getInvocation: () => callbacks.current.getInvocation?.() ?? {},
    onUnauthorized: () => callbacks.current.onUnauthorized?.(), onChange: setState,
  });
  const owned = controller.current;
  useLayoutEffect(() => { owned.attach(callbacks.current.context); return () => owned.dispose(); }, [owned]);
  useLayoutEffect(() => { owned.setContext(options.context); });
  // Rendering, polling, history visibility and reconnect never start measurement.
  return { state: exportLoudnessViewState(state ?? owned.getState(), options.context, options.isRenderRecord), controller: owned };
}
