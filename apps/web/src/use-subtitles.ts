import { useLayoutEffect, useRef, useState } from 'react';
import { createSubtitleController } from './subtitle-state.ts';

export function useSubtitles({ scope, projectId, timeline, connected, pending, visible, submit, createRequestId, getContext, onDirtyChange }) {
  const callbacks = useRef(); callbacks.current = { submit, createRequestId, getContext, onDirtyChange };
  const [state, setState] = useState(null), controller = useRef(null);
  if (!controller.current) controller.current = createSubtitleController({
    submit: intent => callbacks.current.submit(intent), createRequestId: () => callbacks.current.createRequestId(), getContext: () => callbacks.current.getContext(),
    onChange: next => { setState(next); callbacks.current.onDirtyChange(Boolean(next.dirty || next.submitting)); },
  });
  useLayoutEffect(() => { controller.current.activate(); return () => controller.current.dispose(); }, []);
  useLayoutEffect(() => { controller.current.setContext({ scope, projectId, timeline, connected, pending }); }, [scope, projectId, timeline, connected, pending]);
  useLayoutEffect(() => { controller.current.setVisible(visible); }, [visible]);
  return { state: state?.scope === scope && state?.projectId === projectId ? state : null, controller: controller.current };
}
