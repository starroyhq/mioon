import React, { createContext, useContext } from 'react';

const WorkspaceVisibilityContext = createContext(true);

// Panels stay mounted to retain drafts and scroll positions. Visibility is a
// separate, composable signal for work that must stop while a panel is hidden.
/** @param {{ visible?: boolean, children: import('react').ReactNode }} props */
export function WorkspaceVisibilityProvider({ visible = true, children }) {
  const ancestorVisible = useWorkspaceVisibility();
  return <WorkspaceVisibilityContext.Provider value={ancestorVisible && Boolean(visible)}>{children}</WorkspaceVisibilityContext.Provider>;
}

export function useWorkspaceVisibility() {
  return useContext(WorkspaceVisibilityContext);
}
