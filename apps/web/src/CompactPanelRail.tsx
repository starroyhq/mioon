import React, { useLayoutEffect, useMemo, useRef } from 'react';
import type { ComponentType, SVGProps } from 'react';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { Download, Images, Layers, PanelLeftOpen, PanelRightOpen, SlidersVertical, Sparkles, Users } from '@mioon/ui/components/workbench-icons';
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

type RailIconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
const glyphs: Record<CompactPanelRailIcon, RailIconComponent> = {
  assets: Images,
  subjects: Users,
  properties: SlidersVertical,
  versions: Layers,
  agent: Sparkles,
  import: Download,
};
function RailIcon({ icon, side }: { icon?: CompactPanelRailIcon; side?: 'assets' | 'inspector' }) {
  const Component = icon ? glyphs[icon] : side === 'assets' ? PanelLeftOpen : PanelRightOpen;
  return <Component size={16} aria-hidden="true" />;
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
