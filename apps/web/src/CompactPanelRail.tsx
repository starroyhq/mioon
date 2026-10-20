import React, { useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { WorkbenchTooltip } from './WorkspaceControls.tsx';
import { WorkspaceVisibilityProvider } from './workspace-visibility.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import './compact-panel-rail.css';

export type CompactPanelRailIcon = 'assets' | 'subjects' | 'properties' | 'versions' | 'agent' | 'import';
export interface CompactPanelRailAction {
  readonly id: string;
  readonly label: string;
  readonly icon: CompactPanelRailIcon;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly focusSelector?: string;
}
export interface CompactPanelRailProps {
  readonly name: 'assets' | 'inspector';
  readonly label: string;
  readonly scope: string;
  readonly visible?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly actions: readonly CompactPanelRailAction[];
  readonly bottomAction?: CompactPanelRailAction;
  readonly disabled?: boolean;
}

const glyphs: Record<CompactPanelRailIcon, ReactNode> = {
  assets: <><rect x="5" y="3" width="16" height="16" rx="2" /><path d="M3 7H2v15h15v-1M6 15l4-4 3 3 3-5 4 6" /><circle cx="10" cy="7" r="1" /></>,
  subjects: <><circle cx="10" cy="8" r="4" /><path d="M2 22v-3a8 8 0 0 1 16 0v3M17 4a4 4 0 0 1 0 8M22 22v-3a7 7 0 0 0-4-6" /></>,
  properties: <><path d="M5 3v18M12 3v18M19 3v18M2 8h6m1 9h6m1-10h6" /></>,
  versions: <><path d="m12 3 10 6-10 6L2 9Zm-9 11 9 5 9-5M3 18l9 5 9-5" /></>,
  agent: <><path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z" /><path d="m20 2 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z" /></>,
  import: <><path d="M12 3v12m-5-5 5 5 5-5M4 14v7h16v-7" /></>,
};
function RailIcon({ icon, side }: { icon?: CompactPanelRailIcon; side?: 'assets' | 'inspector' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {icon ? glyphs[icon] : <><rect x="3" y="3" width="18" height="18" rx="2" /><path d={side === 'assets' ? 'M9 3v18m4-13 4 4-4 4' : 'M15 3v18m-4-13-4 4 4 4'} /></>}
  </svg>;
}

/** View-only rail. The caller owns pane selection, overlay admission and pinning. */
export default function CompactPanelRail({ name, label, scope, visible = true, expanded, onToggle, actions, bottomAction, disabled = false }: CompactPanelRailProps) {
  const { t } = useI18n();
  const owner = useMemo(() => ({ scope, visible, name }), [scope, visible, name]);
  const authority = useRef<typeof owner | null>(owner);
  const latest = useRef({ disabled, onToggle, actions, bottomAction });
  latest.current = { disabled, onToggle, actions, bottomAction };
  useLayoutEffect(() => { authority.current = owner; return () => { authority.current = null; }; }, [owner]);
  const admitted = () => visible && authority.current === owner && !latest.current.disabled;
  function activate(trigger: HTMLButtonElement, id?: string) {
    if (!admitted()) return;
    const action = id === undefined ? null : [...latest.current.actions, ...(latest.current.bottomAction ? [latest.current.bottomAction] : [])].find(item => item.id === id);
    if (id !== undefined && (!action || action.disabled)) return;
    const panel = document.getElementById(`dock-${name}`), panelScope = panel?.dataset.panelScope;
    if (action) action.onClick(); else latest.current.onToggle();
    // Import opens the native file picker and keeps its own focus lifecycle.
    if (action && !action.focusSelector) return;
    requestAnimationFrame(() => {
      if (!admitted() || !panel?.isConnected || panel.dataset.panelScope !== panelScope || panel.dataset.visible !== 'true') return;
      if (document.activeElement !== document.body && document.activeElement !== trigger) return;
      const target = action?.focusSelector ? panel.querySelector<HTMLElement>(action.focusSelector)
        : panel.querySelector<HTMLElement>(`[data-testid=pin-${name}]`) ?? panel.querySelector<HTMLElement>(`[data-testid=toggle-${name}]`);
      target?.focus({ preventScroll: true });
    });
  }
  const renderAction = (action: CompactPanelRailAction, bottom = false) => <WorkbenchTooltip key={action.id} content={action.label}>
    <WorkbenchButton type="button" variant="icon" className={bottom ? 'compact-panel-rail-bottom' : undefined} data-testid={`rail-${name}-${action.id}`} aria-label={action.label} aria-controls={action.focusSelector ? `dock-${name}` : undefined} aria-pressed={action.selected === undefined ? undefined : expanded && action.selected} disabled={!visible || disabled || action.disabled} onClick={event => activate(event.currentTarget, action.id)}><RailIcon icon={action.icon} /></WorkbenchButton>
  </WorkbenchTooltip>;
  const expandLabel = t('shell.panel.expand', { label });
  return <WorkspaceVisibilityProvider visible={visible}><nav className={`dock-recall recall-${name} compact-panel-rail`} data-testid={`compact-panel-rail-${name}`} aria-label={label} hidden={!visible} inert={!visible}>
    <WorkbenchTooltip content={expandLabel}><WorkbenchButton type="button" variant="icon" data-testid={`reopen-${name}`} aria-label={expandLabel} aria-controls={`dock-${name}`} aria-expanded={expanded} disabled={!visible || disabled} onClick={event => activate(event.currentTarget)}><RailIcon side={name} /></WorkbenchButton></WorkbenchTooltip>
    <div className="compact-panel-rail-divider" aria-hidden="true" />
    {actions.map(action => renderAction(action))}
    {bottomAction && renderAction(bottomAction, true)}
  </nav></WorkspaceVisibilityProvider>;
}
