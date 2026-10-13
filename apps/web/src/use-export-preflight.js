import { useLayoutEffect, useRef, useState } from 'react';
import { createExportPreflightController } from './export-preflight-state.js';

export function useExportPreflight({ scope, projectId, timelineId, revision, exportSettings, settingsVersion, deliveryName, deliveryNameVersion, exportRange, rangeVersion, connected, visible, read, readCapabilities, getContext, getInvocation, onUnauthorized }) {
  const callbacks = useRef({ read, readCapabilities, getContext, getInvocation, onUnauthorized });
  callbacks.current = { read, readCapabilities, getContext, getInvocation, onUnauthorized };
  const [state, setState] = useState(null), controller = useRef(null);
  if (!controller.current) controller.current = createExportPreflightController({
    read: (input, options) => callbacks.current.read(input, options),
    readCapabilities: (input, options) => callbacks.current.readCapabilities(input, options), onChange: setState,
    getInvocation: () => callbacks.current.getInvocation?.() ?? {},
    getContext: getContext ? () => callbacks.current.getContext() : undefined,
    onUnauthorized: () => callbacks.current.onUnauthorized?.(),
  });
  useLayoutEffect(() => {
    controller.current.setContext({ scope, projectId, timelineId, revision, exportSettings, settingsVersion, deliveryName, deliveryNameVersion, exportRange, rangeVersion, connected });
  }, [scope, projectId, timelineId, revision, exportSettings, settingsVersion, deliveryName, deliveryNameVersion, exportRange, rangeVersion, connected]);
  useLayoutEffect(() => { controller.current.setVisible(visible); }, [visible]);
  useLayoutEffect(() => () => controller.current.dispose(), []);
  // Mount, visibility, mode changes and reconnect never start a check or export.
  return { state: state?.scope === scope && state?.projectId === projectId ? state : null, controller: controller.current };
}
