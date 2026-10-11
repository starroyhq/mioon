import { useLayoutEffect, useRef, useState } from 'react';
import { createExportSettingsController } from './export-settings-state.js';

export function useExportSettings({ scope, enabled, getContext }) {
  const callbacks = useRef({ getContext }); callbacks.current = { getContext };
  const [state, setState] = useState(null), controller = useRef(null);
  if (!controller.current) controller.current = createExportSettingsController({ onChange: setState,
    getContext: () => callbacks.current.getContext() });
  useLayoutEffect(() => { controller.current.setContext({ scope, enabled }); }, [scope, enabled]);
  return { scope, version: state?.scope === scope ? state.version : controller.current.getVersion(scope), value: state?.scope === scope ? state.exportSettings : controller.current.getSettings(scope), controller: controller.current };
}
