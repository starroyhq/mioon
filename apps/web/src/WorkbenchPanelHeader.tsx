import React from 'react';
import { CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import { TabsList } from '@mioon/ui/components/tabs';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import Icon from './icons.tsx';
import './workbench-panel-header.css';

type PanelTabListProps = Omit<React.ComponentProps<typeof TabsList>, 'variant'>;

export function WorkbenchPanelTabList({ className, activateOnFocus = false, ...props }: PanelTabListProps) {
  return <TabsList {...props} variant="line" activateOnFocus={activateOnFocus}
    className={['workbench-panel-tablist', className].filter(Boolean).join(' ')} />;
}

interface WorkbenchPanelHeaderProps {
  readonly children: React.ReactNode;
  readonly collapseLabel: string;
  readonly collapseTestId: string;
  readonly className?: string;
}

export function WorkbenchPanelHeader({ children, collapseLabel, collapseTestId, className }: WorkbenchPanelHeaderProps) {
  return <header className={['workbench-panel-header', className].filter(Boolean).join(' ')}>
    {children}
    <CollapsibleTrigger render={<WorkbenchButton type="button" variant="icon" size="compact"
      className="workbench-panel-collapse" aria-label={collapseLabel} title={collapseLabel} data-testid={collapseTestId} />}>
      <Icon name="minus" size={16} aria-hidden="true" />
    </CollapsibleTrigger>
  </header>;
}
