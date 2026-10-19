import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createSourceRangeController } from './source-range-state.ts';
import type { SourceRangeAsset, SourceRangeReadInput, SourceRangeSaveInput, SourceRangeState } from './source-range-state.ts';
export type SourceRangeController=ReturnType<typeof createSourceRangeController>;

export interface UseSourceRangeOptions {
  scope: string|null;
  projectId: string|null|undefined;
  asset: SourceRangeAsset|null|undefined;
  read: (input: SourceRangeReadInput)=>Promise<unknown>;
  save: (input: SourceRangeSaveInput)=>Promise<unknown>;
  refreshGeneration: unknown;
  onDirtyChange?: (dirty: boolean)=>void;
}
export interface UseSourceRangeResult {state: SourceRangeState; controller: SourceRangeController}

export function useSourceRange({ scope, projectId, asset, read, save, refreshGeneration, onDirtyChange }: UseSourceRangeOptions): UseSourceRangeResult {
  const callbacks = useRef({ read, save, onDirtyChange });
  callbacks.current = { read, save, onDirtyChange };
  const [state, setState] = useState<SourceRangeState|null>(null);
  const controller = useRef<SourceRangeController|null>(null);
  if (!controller.current) controller.current = createSourceRangeController({
    read: (input: SourceRangeReadInput) => callbacks.current.read(input), save: (input: SourceRangeSaveInput) => callbacks.current.save(input),
    onChange: (next: SourceRangeState) => { setState(next); callbacks.current.onDirtyChange?.(next.dirty); },
  });
  useLayoutEffect(() => {
    controller.current!.setContext(asset && projectId ? { scope: scope ?? '', projectId, asset } : null);
    return () => { controller.current?.dispose(); };
  }, [scope, projectId, asset?.id]);
  const lastRefresh = useRef({ scope, generation: refreshGeneration });
  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = { scope, generation: refreshGeneration };
    if (previous.scope === scope && previous.generation !== refreshGeneration) void controller.current?.read();
  }, [scope, refreshGeneration]);
  return { state: state?.scope === scope ? state : controller.current.getState(), controller: controller.current };
}
