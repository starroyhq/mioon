import { useLayoutEffect, useRef, useState } from 'react';
import { createExportPreflightController } from './export-preflight-state.js';

export function useExportPreflight({ scope, projectId, timelineId, revision, connected, visible, read, getContext, onUnauthorized }) {
  const callbacks = useRef({ read, getContext, onUnauthorized });
  callbacks.current = { read, getContext, onUnauthorized };
  const [state, setState] = useState(null), controller = useRef(null);
  if (!controller.current) controller.current = createExportPreflightController({
    read: (input, options) => callbacks.current.read(input, options), onChange: setState,
    getContext: getContext ? () => callbacks.current.getContext() : undefined,
    onUnauthorized: () => callbacks.current.onUnauthorized?.(),
  });
  useLayoutEffect(() => {
    controller.current.setContext({ scope, projectId, timelineId, revision, connected });
  }, [scope, projectId, timelineId, revision, connected]);
  useLayoutEffect(() => { controller.current.setVisible(visible); }, [visible]);
  useLayoutEffect(() => () => controller.current.dispose(), []);
  // Mount, visibility, mode changes and reconnect never start a check or export.
  return { state: state?.scope === scope && state?.projectId === projectId ? state : null, controller: controller.current };
}
