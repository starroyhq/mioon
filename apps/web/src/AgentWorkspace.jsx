import React, { useLayoutEffect, useRef } from 'react';
import AgentPanel from './AgentPanel.jsx';
import AgentSettings from './AgentSettings.jsx';
import SettingsNavigationSlot from './SettingsNavigationSlot.tsx';
import { WorkspaceVisibilityProvider, useWorkspaceVisibility } from './workspace-visibility.jsx';

// A page switch hides interaction and portals, never the form's state.
export function AgentDockPane({ visible, children, id, labelledBy, fallbackFocus }) {
  const ancestorVisible = useWorkspaceVisibility(), shown = ancestorVisible && visible;
  const root = useRef(null), hadFocus = useRef(false), wasVisible = useRef(shown);
  useLayoutEffect(() => {
    if (wasVisible.current && !shown && hadFocus.current) {
      hadFocus.current = false;
      const document = root.current?.ownerDocument, active = document?.activeElement;
      if (active === document?.body || root.current?.contains(active)) document?.querySelector(fallbackFocus)?.focus({ preventScroll: true });
    }
    wasVisible.current = shown;
  }, [shown, fallbackFocus]);
  return <WorkspaceVisibilityProvider visible={visible}><div ref={root} id={id} className="right-dock-page" role={labelledBy ? 'tabpanel' : undefined} aria-labelledby={labelledBy} hidden={!shown} inert={!shown} aria-hidden={!shown || undefined} data-visible={shown ? 'true' : 'false'}
    onFocusCapture={() => { hadFocus.current = true; }} onBlurCapture={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) hadFocus.current = false; }}>
    {children}
  </div></WorkspaceVisibilityProvider>;
}

export default function AgentWorkspace({ nativeCloseRegistry, navigationRegistry, projectId, projectName, selectedShot, selectedTimelineClip, timelineEditBlockedReason, selectedTimelineGainClip, timelineGainBlockedReason, onApplied, page, onPage, onCollapse, onDraftChange }) {
  // Settings are global and stay mounted within this dock; only chat is
  // project-keyed. App guards project departure before unmounting the dock.
  // Keys stay in the input and clear when hidden.
  const settingsOpened = useRef(false);
  if (page === 'settings') settingsOpened.current = true;
  return <div className="agent-workspace" data-testid="agent-workspace" data-page={page}>
    <AgentDockPane id="agent-chat-pane" visible={page === 'chat'} fallbackFocus="[data-testid=right-dock-tab-agent]">
      {projectId ? <AgentPanel nativeCloseRegistry={nativeCloseRegistry} key={projectId} projectId={projectId} projectName={projectName} selectedShot={selectedShot} selectedTimelineClip={selectedTimelineClip} timelineEditBlockedReason={timelineEditBlockedReason} selectedTimelineGainClip={selectedTimelineGainClip} timelineGainBlockedReason={timelineGainBlockedReason} onApplied={onApplied} onSettings={() => onPage('settings')} onClose={onCollapse} onDraftChange={onDraftChange} /> : <div className="agent-chat-empty"><h3>选择一个项目开始对话</h3><p>聊天文字不会自动包含项目内容。</p></div>}
    </AgentDockPane>
    <AgentDockPane id="agent-settings-pane" visible={page === 'settings'} fallbackFocus="[data-testid=right-dock-tab-agent]">
      {settingsOpened.current && <SettingsNavigationSlot registry={navigationRegistry} slot="workbench:agent">{report => <AgentSettings onClose={() => onPage('chat')} onNavigationStateChange={report} />}</SettingsNavigationSlot>}
    </AgentDockPane>
  </div>;
}
