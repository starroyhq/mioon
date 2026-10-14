import React from 'react';
import ExportLoudness from '../../apps/web/src/ExportLoudness.tsx';
import {createExportLoudnessController} from '../../apps/web/src/export-loudness-state.ts';
import type {ExportLoudnessContext,ExportLoudnessView} from '../../apps/web/src/export-loudness-state.ts';
import {useExportLoudness} from '../../apps/web/src/use-export-loudness.ts';
function consume(view: ExportLoudnessView, context: ExportLoudnessContext): void {
  const valid = <ExportLoudness exportId="owned-export" loudness={view}/>;
  // @ts-expect-error This UI always identifies one owned completed export.
  const missing = <ExportLoudness loudness={view}/>;
  // @ts-expect-error A view is checked state, not an enable flag.
  const flag = <ExportLoudness exportId="id" loudness={true}/>;
  // @ts-expect-error No caller-controlled media file path.
  createExportLoudnessController({read:async input=>input.path,isRenderRecord:()=>true});
  // @ts-expect-error The hook requires actual project/visibility/ownership context.
  useExportLoudness({read:async()=>null,isRenderRecord:()=>true});
  // @ts-expect-error Read-only ephemeral report state cannot be mutated by consumers.
  view.state.phase='ready';
  const connected: boolean=context.connected;
  void [valid,missing,flag,connected];
}
void consume;
type IsAny<T> = 0 extends (1&T) ? true:false;
type Expect<T extends false> = T;
export type CheckedView = Expect<IsAny<ReturnType<typeof useExportLoudness>>>;
