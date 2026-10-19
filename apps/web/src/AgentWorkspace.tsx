import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useLayoutEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import AgentPanel from './AgentPanel.tsx';
import AgentSettings from './AgentSettings.tsx';
import SettingsNavigationSlot from './SettingsNavigationSlot.tsx';
import { WorkspaceVisibilityProvider, useWorkspaceVisibility } from './workspace-visibility.tsx';
import type { SettingsNavigationRegistry } from './settings-navigation-state.ts';
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
  selectedShot?: unknown;
  selectedTimelineClip?: unknown;
  timelineEditBlockedReason?: string;
  timelineEditBlockedDescriptor?: DisplayMessage | null;
  selectedTimelineGainClip?: unknown;
  timelineGainBlockedReason?: string;
  timelineGainBlockedDescriptor?: DisplayMessage | null;
  onApplied?: (projectId: string) => unknown;
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

export default function AgentWorkspace({ onOpenSettings, settingsOverlayOpen = false, nativeSettingsScope, nativeCloseRegistry, navigationRegistry, projectId, projectName, selectedShot, selectedTimelineClip, timelineEditBlockedReason, timelineEditBlockedDescriptor, selectedTimelineGainClip, timelineGainBlockedReason, timelineGainBlockedDescriptor, onApplied, page, onPage, onCollapse, onDraftChange }: AgentWorkspaceProps): ReactElement {
  const { t } = useI18n();
  // Settings are global and stay mounted within this dock; only chat is
  // project-keyed. App guards project departure before unmounting the dock.
  // Keys stay in the input and clear when hidden.
  const settingsOpened = useRef(false);
  if (page === 'settings') settingsOpened.current = true;
  return <div className="agent-workspace" data-testid="agent-workspace" data-page={page}>
    <AgentDockPane id="agent-chat-pane" visible={page === 'chat' && !settingsOverlayOpen} fallbackFocus="[data-testid=right-dock-tab-agent]">
      {projectId ? <AgentPanel nativeSettingsScope={nativeSettingsScope} nativeCloseRegistry={nativeCloseRegistry} key={projectId} projectId={projectId} projectName={projectName} selectedShot={pass(selectedShot)} selectedTimelineClip={pass(selectedTimelineClip)} timelineEditBlockedReason={timelineEditBlockedReason} timelineEditBlockedDescriptor={pass(timelineEditBlockedDescriptor)} selectedTimelineGainClip={pass(selectedTimelineGainClip)} timelineGainBlockedReason={timelineGainBlockedReason} timelineGainBlockedDescriptor={pass(timelineGainBlockedDescriptor)} onApplied={onApplied} onSettings={() => onOpenSettings ? onOpenSettings('agent') : onPage('settings')} onClose={onCollapse} onDraftChange={onDraftChange as (() => void) | undefined} /> : <div className="agent-chat-empty"><h3>{t('agent.workspace.selectProject')}</h3><p>{t('agent.workspace.noImplicitProjectContent')}</p></div>}
    </AgentDockPane>
    <AgentDockPane id="agent-settings-pane" visible={page === 'settings'} fallbackFocus="[data-testid=right-dock-tab-agent]">
      {!nativeSettingsScope && !onOpenSettings && settingsOpened.current && <SettingsNavigationSlot registry={navigationRegistry} slot="workbench:agent">{report => <AgentSettings onClose={() => onPage('chat')} onNavigationStateChange={pass(report)} />}</SettingsNavigationSlot>}
    </AgentDockPane>
  </div>;
}
