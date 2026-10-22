import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useLayoutEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import AgentTaskPanel from './AgentTaskPanel.tsx';
import type { AgentTaskChange, AgentTaskSnapshot } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import AgentSettings from './AgentSettings.tsx';
import SettingsNavigationSlot from './SettingsNavigationSlot.tsx';
import { WorkspaceVisibilityProvider, useWorkspaceVisibility } from './workspace-visibility.tsx';
import type { SettingsNavigationRegistry } from './settings-navigation-state.ts';
import type { TaskDisplayLookup } from './agent-task-presentation.ts';
const pass = <T,>(value: unknown): T => value as T;

export interface AgentDockPaneProps { visible: boolean; children?: ReactNode; id?: string; labelledBy?: string; fallbackFocus?: string }
export interface AgentWorkspaceProps {
  onOpenSettings?: ((page: string) => unknown) | null;
  settingsOverlayOpen?: boolean;
  nativeSettingsScope?: unknown;
  nativeCloseRegistry?: unknown;
  navigationRegistry?: SettingsNavigationRegistry;
  projectId?: string | null;
  projectName?: string;
  targetName?: TaskDisplayLookup;
  workspaceScope?: string;
  selectedShot?: unknown;
  selectedTimelineClip?: unknown;
  timelineEditBlockedReason?: string;
  timelineEditBlockedDescriptor?: DisplayMessage | null;
  selectedTimelineGainClip?: unknown;
  timelineGainBlockedReason?: string;
  timelineGainBlockedDescriptor?: DisplayMessage | null;
  onApplied?: (projectId: string) => unknown;
  onTaskApplied?: (projectId: string, snapshot: AgentTaskSnapshot) => unknown;
  onTaskOpenRequests?: (selectedId?: string) => unknown;
  onTaskLocate?: (change: AgentTaskChange) => unknown;
  page: string;
  onPage: (page: string) => unknown;
  onCollapse: () => unknown;
  onDraftChange?: (dirty: boolean) => unknown;
}

// A page switch hides interaction and portals, never the form's state.
export function AgentDockPane({ visible, children, id, labelledBy, fallbackFocus }: AgentDockPaneProps): ReactElement {
  const ancestorVisible = useWorkspaceVisibility(), shown = ancestorVisible && visible;
  const root = useRef<HTMLDivElement | null>(null), hadFocus = useRef(false), wasVisible = useRef(shown);
  useLayoutEffect(() => {
    if (wasVisible.current && !shown && hadFocus.current) {
      hadFocus.current = false;
      const document = root.current?.ownerDocument, active = document?.activeElement;
      if (fallbackFocus && (active === document?.body || (active ? root.current?.contains(active) : false))) document?.querySelector<HTMLElement>(fallbackFocus)?.focus({ preventScroll: true });
    }
    wasVisible.current = shown;
  }, [shown, fallbackFocus]);
  return <WorkspaceVisibilityProvider visible={visible}><div ref={root} id={id} className="right-dock-page" role={labelledBy ? 'tabpanel' : undefined} aria-labelledby={labelledBy} hidden={!shown} inert={!shown} aria-hidden={!shown || undefined} data-visible={shown ? 'true' : 'false'}
    onFocusCapture={() => { hadFocus.current = true; }} onBlurCapture={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) hadFocus.current = false; }}>
    {children}
  </div></WorkspaceVisibilityProvider>;
}

export default function AgentWorkspace({ onOpenSettings, settingsOverlayOpen = false, nativeSettingsScope, nativeCloseRegistry, navigationRegistry, projectId, workspaceScope = 'normal', projectName, targetName, onApplied, onTaskApplied, onTaskLocate, onTaskOpenRequests, page, onPage, onCollapse, onDraftChange }: AgentWorkspaceProps): ReactElement {
  const { t } = useI18n();
  // Settings are global and stay mounted within this dock; only chat is
  // project-keyed. App guards project departure before unmounting the dock.
  // Keys stay in the input and clear when hidden.
  const settingsOpened = useRef(false);
  if (page === 'settings') settingsOpened.current = true;
  return <div className="agent-workspace" data-testid="agent-workspace" data-page={page}>
    <AgentDockPane id="agent-chat-pane" visible={page === 'chat' && !settingsOverlayOpen} fallbackFocus="[data-testid=right-dock-tab-agent]">
      {projectId ? <AgentTaskPanel nativeCloseRegistry={nativeCloseRegistry} key={`${workspaceScope}:${projectId}`} workspaceScope={workspaceScope} projectId={projectId} projectName={projectName} targetName={targetName} onApplied={onTaskApplied ?? onApplied} onLocate={onTaskLocate} onOpenRequests={onTaskOpenRequests} onSettings={target => onOpenSettings ? onOpenSettings(target ?? 'agent') : onPage('settings')} onClose={onCollapse} onDraftChange={onDraftChange} /> : <div className="agent-chat-empty"><h3>{t('agent.workspace.selectProject')}</h3><p>{t('agent.workspace.noImplicitProjectContent')}</p></div>}
    </AgentDockPane>
    <AgentDockPane id="agent-settings-pane" visible={page === 'settings'} fallbackFocus="[data-testid=right-dock-tab-agent]">
      {!nativeSettingsScope && !onOpenSettings && settingsOpened.current && <SettingsNavigationSlot registry={navigationRegistry} slot="workbench:agent">{report => <AgentSettings onClose={() => onPage('chat')} onNavigationStateChange={pass(report)} />}</SettingsNavigationSlot>}
    </AgentDockPane>
  </div>;
}
