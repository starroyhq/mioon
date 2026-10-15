import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter } from './creation-i18n.ts';
import React, { useLayoutEffect, useRef } from 'react';
import AgentPanel from './AgentPanel.jsx';
import AgentSettings from './AgentSettings.jsx';
import SettingsNavigationSlot from './SettingsNavigationSlot.tsx';
import { WorkspaceVisibilityProvider, useWorkspaceVisibility } from './workspace-visibility.jsx';

// A page switch hides interaction and portals, never the form's state.
export function AgentDockPane({ visible, children, id, labelledBy, fallbackFocus }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
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

export default function AgentWorkspace({ nativeSettingsScope, nativeCloseRegistry, navigationRegistry, projectId, projectName, selectedShot, selectedTimelineClip, timelineEditBlockedReason, timelineEditBlockedDescriptor, selectedTimelineGainClip, timelineGainBlockedReason, timelineGainBlockedDescriptor, onApplied, page, onPage, onCollapse, onDraftChange }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  // Settings are global and stay mounted within this dock; only chat is
  // project-keyed. App guards project departure before unmounting the dock.
  // Keys stay in the input and clear when hidden.
  const settingsOpened = useRef(false);
  if (page === 'settings') settingsOpened.current = true;
  return <div className="agent-workspace" data-testid="agent-workspace" data-page={page}>
    <AgentDockPane id="agent-chat-pane" visible={page === 'chat'} fallbackFocus="[data-testid=right-dock-tab-agent]">
      {projectId ? <AgentPanel nativeSettingsScope={nativeSettingsScope} nativeCloseRegistry={nativeCloseRegistry} key={projectId} projectId={projectId} projectName={projectName} selectedShot={selectedShot} selectedTimelineClip={selectedTimelineClip} timelineEditBlockedReason={timelineEditBlockedReason} timelineEditBlockedDescriptor={timelineEditBlockedDescriptor} selectedTimelineGainClip={selectedTimelineGainClip} timelineGainBlockedReason={timelineGainBlockedReason} timelineGainBlockedDescriptor={timelineGainBlockedDescriptor} onApplied={onApplied} onSettings={() => onPage('settings')} onClose={onCollapse} onDraftChange={onDraftChange} /> : <div className="agent-chat-empty"><h3>{t('agent.workspace.selectProject')}</h3><p>{t('agent.workspace.noImplicitProjectContent')}</p></div>}
    </AgentDockPane>
    <AgentDockPane id="agent-settings-pane" visible={page === 'settings'} fallbackFocus="[data-testid=right-dock-tab-agent]">
      {!nativeSettingsScope && settingsOpened.current && <SettingsNavigationSlot registry={navigationRegistry} slot="workbench:agent">{report => <AgentSettings onClose={() => onPage('chat')} onNavigationStateChange={report} />}</SettingsNavigationSlot>}
    </AgentDockPane>
  </div>;
}
