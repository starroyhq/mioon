import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createSourceRangeController } from './source-range-state.js';

export function useSourceRange({ scope, projectId, asset, read, save, refreshGeneration, onDirtyChange }) {
  const callbacks = useRef({ read, save, onDirtyChange });
  callbacks.current = { read, save, onDirtyChange };
  const [state, setState] = useState(null);
  const controller = useRef(null);
  if (!controller.current) controller.current = createSourceRangeController({
    read: input => callbacks.current.read(input), save: input => callbacks.current.save(input),
    onChange: next => { setState(next); callbacks.current.onDirtyChange(next.dirty); },
  });
  useLayoutEffect(() => {
    controller.current.setContext(asset && projectId ? { scope, projectId, asset } : null);
    return () => { controller.current.dispose(); };
  }, [scope, projectId, asset?.id]);
  const lastRefresh = useRef({ scope, generation: refreshGeneration });
  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = { scope, generation: refreshGeneration };
    if (previous.scope === scope && previous.generation !== refreshGeneration) void controller.current.read();
  }, [scope, refreshGeneration]);
  return { state: state?.scope === scope ? state : controller.current.getState(), controller: controller.current };
}
