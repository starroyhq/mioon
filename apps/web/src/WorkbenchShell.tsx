import React from 'react';
import { Tabs, TabsList, TabsTrigger } from '@mioon/ui/components/tabs';

export interface WorkbenchTopbarProps {
  readonly brand: React.ReactNode;
  readonly projectMenu: React.ReactNode;
  readonly modeSwitch: React.ReactNode;
  readonly status: React.ReactNode;
  readonly actions: React.ReactNode;
}

/** Passive shell: App retains navigation, drafts, authority and request identity. */
export function WorkbenchTopbar({ brand, projectMenu, modeSwitch, status, actions }: WorkbenchTopbarProps) {
  return <header className="topbar workbench-topbar" data-text-selectable={false}>
    <div className="workbench-topbar-project">{brand}{projectMenu}</div>
    <div className="workbench-topbar-mode">{modeSwitch}</div>
    <div className="topbar-actions">{status}{actions}</div>
  </header>;
}

export interface WorkbenchInspectorTabsProps {
  readonly mode: 'canvas' | 'editing';
  readonly value: 'properties' | 'versions' | 'agent';
  readonly onValueChange: (value: 'properties' | 'versions' | 'agent') => void;
  readonly agentDisabled: boolean;
  readonly labels: Readonly<{ workspace: string; properties: string; versions: string; agent: string }>;
}

export function WorkbenchInspectorTabs({ mode, value, onValueChange, agentDisabled, labels }: WorkbenchInspectorTabsProps) {
  return <Tabs value={value} onValueChange={next => {
    if (next === 'properties' || next === 'versions' && mode === 'canvas' || next === 'agent' && !agentDisabled) onValueChange(next);
  }} className="right-dock-tabs workbench-inspector-tabs">
    <TabsList aria-label={labels.workspace} variant="line" activateOnFocus={false}>
      <TabsTrigger id="right-dock-properties-tab" value="properties" data-testid="right-dock-tab-properties" aria-controls="right-dock-properties">{labels.properties}</TabsTrigger>
      {mode === 'canvas' && <TabsTrigger id="right-dock-versions-tab" value="versions" data-testid="right-dock-tab-versions" aria-controls="right-dock-properties">{labels.versions}</TabsTrigger>}
      <TabsTrigger id="right-dock-agent-tab" value="agent" disabled={agentDisabled} data-testid="right-dock-tab-agent" aria-controls="right-dock-agent"><span data-testid="agent-chat-open">{labels.agent}</span></TabsTrigger>
    </TabsList>
  </Tabs>;
}
