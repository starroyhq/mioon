import { useLayoutEffect, useRef, useState } from 'react';
import { createTimelineFormatController } from './timeline-format-state.js';

export function useTimelineFormat({ scope, projectId, projectRevision, timelineId, timelineRevision, connected, pending, refreshKey, visible, read, submit, createRequestId, getContext, onUnauthorized }) {
  const callbacks = useRef(); callbacks.current = { read, submit, createRequestId, getContext, onUnauthorized };
  const [state, setState] = useState(null), controller = useRef(null);
  if (!controller.current) controller.current = createTimelineFormatController({
    read: (...args) => callbacks.current.read(...args), submit: intent => callbacks.current.submit(intent),
    createRequestId: () => callbacks.current.createRequestId(), getContext: () => callbacks.current.getContext(),
    onUnauthorized: () => callbacks.current.onUnauthorized?.(), onChange: setState,
  });
  useLayoutEffect(() => { controller.current.setContext({ scope, projectId, projectRevision, timelineId, timelineRevision, connected, pending }); }, [scope, projectId, projectRevision, timelineId, timelineRevision, connected, pending]);
  useLayoutEffect(() => { controller.current.setVisible(visible); }, [visible]);
  useLayoutEffect(() => { if (projectId && connected && visible) void controller.current.load(); }, [scope, projectId, projectRevision, timelineId, timelineRevision, connected, refreshKey, visible]);
  useLayoutEffect(() => () => controller.current.dispose(), []);
  return { state: state?.scope === scope && state?.projectId === projectId ? state : null, controller: controller.current };
}
