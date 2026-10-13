import React from 'react';
import ExportSamplePeak from '../../apps/web/src/ExportSamplePeak.tsx';
import { createExportSamplePeakController } from '../../apps/web/src/export-sample-peak-state.ts';
import type { ExportSamplePeakContext, ExportSamplePeakView } from '../../apps/web/src/export-sample-peak-state.ts';
import { useExportSamplePeak } from '../../apps/web/src/use-export-sample-peak.ts';

function checkedConsumer(view: ExportSamplePeakView, context: ExportSamplePeakContext): void {
  const valid = <ExportSamplePeak exportId="verified-export-id" samplePeak={view} />;
  // @ts-expect-error Export identity is required.
  const missing = <ExportSamplePeak samplePeak={view} />;
  // @ts-expect-error The actual checked view cannot be replaced by a flag.
  const unchecked = <ExportSamplePeak exportId="id" samplePeak={true} />;
  // @ts-expect-error Context flags must be real booleans.
  const wrongContext: ExportSamplePeakContext = { ...context, connected: 'yes' };
  // @ts-expect-error A read must asynchronously return an unknown response for validation.
  createExportSamplePeakController({ isRenderRecord: () => true, read: () => ({ status: 'ready' }) });
  // @ts-expect-error Raw result assertions cannot bypass the lifecycle hook context.
  useExportSamplePeak({ read: async () => null, isRenderRecord: () => true });
  // @ts-expect-error Input contains only projectId and exportId, no file paths.
  createExportSamplePeakController({ isRenderRecord: () => true, read: async input => input.path });
  // @ts-expect-error State is immutable to render consumers.
  view.state.phase = 'ready';
  void valid; void missing; void unchecked; void wrongContext;
}
void checkedConsumer;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Assert<T extends true> = T;
export type CheckedView = Assert<IsAny<ReturnType<typeof useExportSamplePeak>> extends false ? true : false>;
export type CheckedController = Assert<IsAny<ReturnType<typeof createExportSamplePeakController>> extends false ? true : false>;
