import React, { createContext, useContext, useId, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import './SettingsServicesLayout.css';

export interface SettingsServicesAction {
  label: ReactNode;
  onAction: () => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  testId?: string;
}
export interface SettingsServicesItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  testId?: string;
}
export interface SettingsServicesGroup {
  key: string;
  title?: ReactNode;
  items: readonly SettingsServicesItem[];
  action?: SettingsServicesAction;
}
export interface SettingsServicesPanel { key: string; content: ReactNode }
export interface SettingsServicesFooter {
  state?: 'saved' | 'dirty' | 'saving' | 'unknown' | 'blocked' | 'error' | 'partial';
  status: ReactNode;
  save: SettingsServicesAction;
  discard?: SettingsServicesAction;
}
export interface SettingsServicesLayoutProps {
  title: string;
  description?: string;
  groups: readonly SettingsServicesGroup[];
  selectedKey: string;
  onSelect: (key: string) => void;
  panels: readonly SettingsServicesPanel[];
  pageVisible: boolean;
  onPageVisibilityChange?: (visible: boolean) => void;
  footer: SettingsServicesFooter;
  className?: string;
  testId?: string;
}

export interface SettingsServicesPanelVisibility {
  selected: boolean;
  pageVisible: boolean;
  active: boolean;
}
const PanelVisibility = createContext<SettingsServicesPanelVisibility>({ selected: false, pageVisible: false, active: false });
export const useSettingsServicesPanel = (): SettingsServicesPanelVisibility => useContext(PanelVisibility);

/** Shared settings frame. The caller owns drafts, credentials, save admission,
 * and any multi-file outcome; this component only arranges retained panels. */
export default function SettingsServicesLayout(props: SettingsServicesLayoutProps) {
  const id = useId(), buttons = useRef(new Map<string, HTMLButtonElement>());
  const lifetime = useRef({ active: false, props, notified: false });
  useLayoutEffect(() => {
    const previous = lifetime.current;
    lifetime.current = { active: true, props, notified: true };
    if (!previous.notified || previous.props.pageVisible !== props.pageVisible) props.onPageVisibilityChange?.(props.pageVisible);
  });
  useLayoutEffect(() => () => {
    const owner = lifetime.current;
    owner.active = false;
    if (owner.props.pageVisible) owner.props.onPageVisibilityChange?.(false);
  }, []);

  const current = () => lifetime.current.active && lifetime.current.props.pageVisible;
  function choose(key: string) {
    const latest = lifetime.current.props;
    if (!current() || !latest.groups.some(group => group.items.some(item => item.key === key && !item.disabled))) return;
    latest.onSelect(key);
  }
  function move(event: KeyboardEvent<HTMLButtonElement>, key: string) {
    if (!current() || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = lifetime.current.props.groups.flatMap(group => group.items).filter(item => !item.disabled);
    if (!items.length) return;
    const from = items.findIndex(item => item.key === key);
    if (from < 0) return;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (from + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    const next = items[index]!;
    event.preventDefault();
    choose(next.key);
    buttons.current.get(next.key)?.focus();
  }
  function groupAction(key: string) {
    const action = lifetime.current.props.groups.find(group => group.key === key)?.action;
    if (current() && action && !action.disabled && !action.busy) action.onAction();
  }
  function footerAction(kind: 'save' | 'discard') {
    const action = lifetime.current.props.footer[kind];
    if (current() && action && !action.disabled && !action.busy) action.onAction();
  }
  const panelId = (key: string) => `${id}-panel-${props.panels.findIndex(panel => panel.key === key)}`;
  const tabId = (key: string) => `${id}-tab-${props.panels.findIndex(panel => panel.key === key)}`;
  const navigationActions = props.groups.filter(group => group.action);
  const available = props.groups.flatMap(group => group.items).filter(item => !item.disabled);
  const focusKey = available.find(item => item.key === props.selectedKey)?.key ?? available[0]?.key;
  return <section className={`settings-services-layout${props.className ? ` ${props.className}` : ''}`} hidden={!props.pageVisible} inert={!props.pageVisible}
    aria-label={props.title} data-testid={props.testId ?? 'settings-services-layout'}>
    <header className="settings-services-heading"><h2>{props.title}</h2>{props.description && <p>{props.description}</p>}</header>
    <div className="settings-services-layout-body">
      <nav className="settings-services-navigation" aria-label={props.title}>
        <div className="settings-services-groups" role="tablist" aria-orientation="vertical" aria-label={props.title}>
          {props.groups.map(group => <div className="settings-services-group" key={group.key}>
            {group.title && <div className="settings-services-group-title">{group.title}</div>}
            {group.items.map(item => <Button type="button" variant="ghost" className="settings-services-item" key={item.key}
              ref={element => { if (element) buttons.current.set(item.key, element); else buttons.current.delete(item.key); }}
              id={tabId(item.key)} role="tab" aria-selected={props.selectedKey === item.key} aria-controls={panelId(item.key)}
              tabIndex={focusKey === item.key ? 0 : -1} disabled={!props.pageVisible || item.disabled}
              data-testid={item.testId ?? `settings-services-item-${item.key}`} onClick={() => choose(item.key)} onKeyDown={event => move(event, item.key)}>
              {item.icon && <span className="settings-services-item-icon">{item.icon}</span>}<span className="settings-services-item-label">{item.label}</span>
              {item.badge && <span className="settings-services-item-badge">{item.badge}</span>}
            </Button>)}
          </div>)}
        </div>
        {navigationActions.length > 0 && <div className="settings-services-navigation-actions">{navigationActions.map(group => {
          const action = group.action!;
          return <Button key={group.key} type="button" variant="outline" disabled={!props.pageVisible || action.disabled || action.busy}
            aria-busy={action.busy || undefined} title={action.title} data-testid={action.testId} onClick={() => groupAction(group.key)}>{action.label}</Button>;
        })}</div>}
      </nav>
      <div className="settings-services-panels">
        {props.panels.map(panel => {
          const selected = panel.key === props.selectedKey;
          return <section key={panel.key} id={panelId(panel.key)} role="tabpanel" aria-labelledby={tabId(panel.key)}
            hidden={!selected} inert={!selected || !props.pageVisible} className="settings-services-panel" data-service-panel={panel.key}>
            <PanelVisibility.Provider value={{ selected, pageVisible: props.pageVisible, active: selected && props.pageVisible }}>{panel.content}</PanelVisibility.Provider>
          </section>;
        })}
      </div>
    </div>
    <footer className="settings-services-footer" data-state={props.footer.state}>
      <div className="settings-services-footer-status" role="status" aria-live="polite">{props.footer.status}</div>
      <div className="settings-services-footer-actions">
        {props.footer.discard && <Button type="button" variant="ghost" disabled={!props.pageVisible || props.footer.discard.disabled || props.footer.discard.busy}
          aria-busy={props.footer.discard.busy || undefined} title={props.footer.discard.title} data-testid={props.footer.discard.testId} onClick={() => footerAction('discard')}>{props.footer.discard.label}</Button>}
        <Button type="button" disabled={!props.pageVisible || props.footer.save.disabled || props.footer.save.busy} aria-busy={props.footer.save.busy || undefined}
          title={props.footer.save.title} data-testid={props.footer.save.testId} onClick={() => footerAction('save')}>{props.footer.save.label}</Button>
      </div>
    </footer>
  </section>;
}
