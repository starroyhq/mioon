import React, { createContext, useContext } from 'react';
import type {ReactNode} from 'react';

const WorkspaceVisibilityContext = createContext(true);

// Panels stay mounted to retain drafts and scroll positions. Visibility is a
// separate, composable signal for work that must stop while a panel is hidden.
export function WorkspaceVisibilityProvider({ visible = true, children }: {visible?: boolean; children: ReactNode}) {
  const ancestorVisible = useWorkspaceVisibility();
  return <WorkspaceVisibilityContext.Provider value={ancestorVisible && Boolean(visible)}>{children}</WorkspaceVisibilityContext.Provider>;
}

export function useWorkspaceVisibility() {
  return useContext(WorkspaceVisibilityContext);
}
