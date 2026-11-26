import React from 'react';
import { useI18n } from './i18n/I18nProvider.tsx';
import ProjectHomeConnections from './ProjectHomeConnections.tsx';
import SettingsWorkspace from './SettingsWorkspace.tsx';
import SettingsVideoTools from './SettingsVideoTools.tsx';
import SettingsAppearance from './SettingsAppearance.tsx';
import GenerationServicesSettings from './GenerationServicesSettings.tsx';
import SettingsNavigationSlot from './SettingsNavigationSlot.tsx';
import AgentSettings from './AgentSettings.tsx';
import { AgentDockPane } from './AgentWorkspace.tsx';
import ExternalAgentsSettings from './ExternalAgentsSettings.tsx';
import { hasExternalAgentsBridge } from './external-agents-client.ts';
import type { HomeConnectionSlot } from './ProjectHomeConnections.tsx';
import type { SettingsPage } from './settings-window-state.ts';
import type { SettingsNavigationRegistry } from './settings-navigation-state.ts';

export interface SettingsConnectionFormsProps {
  selected: HomeConnectionSlot; page: SettingsPage; entryVersion?: number; visible: boolean; registry: SettingsNavigationRegistry;
  onSelect: (slot: HomeConnectionSlot) => void; onPage: (page: SettingsPage) => void; general: React.ReactNode;
  connectionsAvailable?: boolean; beforeClose?: () => unknown; onClose?: () => void;
  /** The open project, where the Mio connection test runs; absent in the home screen and the settings window. */
  projectId?: string | null;
}

export function SettingsConnectionForms({ selected, page, entryVersion, visible, registry, onSelect, onPage, general, connectionsAvailable = true, beforeClose, onClose, projectId = null }: SettingsConnectionFormsProps) {
  const { t } = useI18n();
  const generationCategory = ['models', 'extensions', 'official', 'custom', 'comfy'].includes(page);
  const externalAgentsAvailable = hasExternalAgentsBridge();
  return <ProjectHomeConnections active={visible} workspace={<SettingsWorkspace active={visible && page === 'workspace'} />}
    videoTools={<SettingsNavigationSlot registry={registry} slot="home:video-tools">{report => <SettingsVideoTools active={visible && page === 'video-tools'} onNavigationStateChange={report} />}</SettingsNavigationSlot>}
    generationServices={<SettingsNavigationSlot registry={registry} slot="home:generation-services">{report => <GenerationServicesSettings active={visible && connectionsAvailable && generationCategory} page={page} entryVersion={entryVersion} onNavigationStateChange={report} />}</SettingsNavigationSlot>}
    externalAgentsAvailable={externalAgentsAvailable}
    externalAgents={externalAgentsAvailable ? <ExternalAgentsSettings active={visible && page === 'external-agents'} /> : undefined}
    selected={selected} page={page} connectionsAvailable={connectionsAvailable} onSelect={onSelect} onPage={onPage}
    general={<>{general}<SettingsNavigationSlot registry={registry} slot="home:appearance">{report => <SettingsAppearance active={visible && page === 'general'} onNavigationStateChange={report} />}</SettingsNavigationSlot></>}
    panes={{agent: <AgentDockPane visible={visible && connectionsAvailable && page === 'agent'}><SettingsNavigationSlot registry={registry} slot="home:agent">{report => <AgentSettings closeLabel={t('common.closeSettings')} beforeClose={beforeClose as unknown as () => void} onClose={onClose as unknown as () => void} onNavigationStateChange={report} projectId={projectId} />}</SettingsNavigationSlot></AgentDockPane>}} />;
}
