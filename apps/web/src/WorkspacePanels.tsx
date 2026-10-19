import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator } from '@mioon/ui/components/dropdown-menu';
import { WorkspaceVisibilityProvider } from './workspace-visibility.tsx';
import { PANEL_BOUNDS, effectiveWorkspaceLayout } from './workspace-layout.ts';
import Icon from './icons.tsx';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(value)));
const CENTER_COMFORT_HEIGHT = 324, TIMELINE_FLOOR_HEIGHT = 160;
const pointerScale = element => {
  const logical = element?.offsetWidth, physical = element?.getBoundingClientRect?.().width;
  return Number.isFinite(logical) && logical > 0 && Number.isFinite(physical) && physical > 0 ? physical / logical : 1;
};

export function usePanelGeometry(surface, preferred, mode, scope, ready = true, presentationScope = scope) {
  const [size, setSize] = useState({ width: typeof window === 'undefined' ? 1200 : window.innerWidth, height: typeof window === 'undefined' ? 700 : window.innerHeight - 44, physicalWidth: typeof window === 'undefined' ? 1200 : window.innerWidth });
  const [live, setLive] = useState(null);
  const [pins, setPins] = useState(null), presentationOwner = useRef(null);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!ready || !element) return;
    const measure = () => setSize(previous => {
      const measured = element.getBoundingClientRect?.().width;
      const next = { width: element.clientWidth, height: element.clientHeight, physicalWidth: Number.isFinite(measured) && measured > 0 ? measured : element.clientWidth };
      return next.width === previous.width && next.height === previous.height && next.physicalWidth === previous.physicalWidth ? previous : next;
    });
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [surface, ready]);
  // A canceled gesture must never reappear when returning to its old mode.
  useLayoutEffect(() => { setLive(null); }, [scope]);
  const narrow = size.width <= 800 || size.height < 460;
  // Supported small desktop windows retain the editing surface between two
  // icon rails. The much smaller single-panel fallback remains independent.
  const compact = !narrow && size.physicalWidth < 1150;
  const owner = useMemo(() => ({ scope: presentationScope, compact }), [presentationScope, compact]);
  useLayoutEffect(() => { presentationOwner.current = owner; return () => { if (presentationOwner.current === owner) presentationOwner.current = null; }; }, [owner]);
  const current = live?.scope === scope ? { ...preferred, [live.field]: live.value } : preferred;
  const presented = compact ? { ...current, assetsCollapsed: !(pins?.owner === owner && pins.assets), inspectorCollapsed: !(pins?.owner === owner && pins.inspector) } : current;
  // The preview needs room for its header, footer and a watchable frame, so it keeps CENTER_COMFORT_HEIGHT
  // while the timeline can still show TIMELINE_FLOOR_HEIGHT (header, toolbar, ruler and one track).
  const effective = effectiveWorkspaceLayout(presented, { width: Math.max(0, size.width - 12), height: Math.max(0, size.height - 12), centerMinWidth: 320, centerMinHeight: 240, centerComfortHeight: CENTER_COMFORT_HEIGHT, timelineFloorHeight: TIMELINE_FLOOR_HEIGHT, collapsedWidth: 44, separatorSize: 6 });
  const maxima = {
    assetsWidth: Math.max(PANEL_BOUNDS.assetsWidth.min, Math.min(PANEL_BOUNDS.assetsWidth.max, size.width - 24 - 320 - (effective.inspectorCollapsed ? 44 : effective.inspectorWidth))),
    inspectorWidth: Math.max(PANEL_BOUNDS.inspectorWidth.min, Math.min(PANEL_BOUNDS.inspectorWidth.max, size.width - 24 - 320 - (effective.assetsCollapsed ? 44 : effective.assetsWidth))),
    timelineHeight: Math.max(PANEL_BOUNDS.timelineHeight.min, Math.min(PANEL_BOUNDS.timelineHeight.max, effective.timelineMaxHeight)),
  };
  return { narrow, compact, size, effective, maxima, preview: (field, value) => setLive(value === null ? null : { scope, field, value }),
    pinPanel: (name, open) => { if (!compact || presentationOwner.current !== owner || !['assets', 'inspector'].includes(name)) return false; setPins(previous => ({ ...(previous?.owner === owner ? previous : {}), owner, [name]: Boolean(open) })); return true; },
    resetPins: () => { if (presentationOwner.current === owner) setPins(null); },
    style: { '--dock-assets': `${effective.assetsWidth}px`, '--dock-inspector': `${effective.inspectorWidth}px`, '--dock-assets-preferred': `${current.assetsWidth}px`, '--dock-inspector-preferred': `${current.inspectorWidth}px`, '--dock-timeline': `${mode === 'editing' ? effective.timelineHeight : 0}px` } };
}

/** Keep forms and scroll containers alive, while hiding their interaction/media. */
export function PanelBoundary({ name, visible, scope, className = '', children, fallbackFocus }) {
  const root = useRef(null), scroll = useRef(new Map()), wasVisible = useRef(visible), focusInside = useRef(false);
  const current = useRef({ visible, scope, fallbackFocus }); current.current = { visible, scope, fallbackFocus };
  useLayoutEffect(() => { scroll.current.clear(); }, [scope]);
  useLayoutEffect(() => {
    const owner = scope;
    if (!visible && wasVisible.current && focusInside.current) {
      focusInside.current = false;
      document.querySelector(fallbackFocus)?.focus({ preventScroll: true });
    }
    wasVisible.current = visible;
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      if (!current.current.visible || current.current.scope !== owner) return;
      for (const [element, position] of scroll.current) if (element.isConnected && root.current?.contains(element)) { element.scrollLeft = position.left; element.scrollTop = position.top; }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, scope, fallbackFocus]);
  return <WorkspaceVisibilityProvider visible={visible}><div ref={root} id={`dock-${name}`} data-testid={`dock-${name}`} data-panel-key={name} data-panel-scope={scope} data-visible={visible ? 'true' : 'false'} className={`dock-panel dock-${name} ${className}`} inert={!visible} aria-hidden={!visible || undefined}
    onFocusCapture={() => { focusInside.current = true; }} onBlurCapture={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusInside.current = false; }}
    onScrollCapture={event => { if (current.current.visible && event.target instanceof HTMLElement) scroll.current.set(event.target, { left: event.target.scrollLeft, top: event.target.scrollTop }); }}>
    {children}
  </div></WorkspaceVisibilityProvider>;
}

export function PanelRecall({ name, label, icon, onClick, expanded = false }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <Button variant="ghost" className={`dock-recall recall-${name}`} data-testid={`reopen-${name}`} aria-label={t('shell.panel.expand', { label })} aria-controls={`dock-${name}`} aria-expanded={expanded} onClick={event => {
    const trigger = event.currentTarget, panel = document.getElementById(`dock-${name}`), owner = panel?.dataset.panelScope;
    onClick();
    requestAnimationFrame(() => {
      if (panel?.isConnected && panel.dataset.panelScope === owner && panel.dataset.visible === 'true' && (document.activeElement === document.body || document.activeElement === trigger)) panel.querySelector(`[data-testid=toggle-${name}]`)?.focus({ preventScroll: true });
    });
  }}><Icon name={icon} size={15} /><span>{label}</span><Icon name="plus" size={12} /></Button>;
}

export function PanelResizeHandle({ name, field, value, max, scope, enabled = true, onPreview, onCommit }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const bounds = PANEL_BOUNDS[field], horizontal = name === 'timeline', direction = name === 'assets' ? 1 : -1;
  const handle = useRef(null), gesture = useRef(null);
  const latest = useRef({ scope, enabled, onPreview, onCommit }); latest.current = { scope, enabled, onPreview, onCommit };
  function cancel() {
    const active = gesture.current; if (!active) return;
    gesture.current = null; latest.current.onPreview(field, null);
    if (handle.current?.hasPointerCapture(active.pointerId)) handle.current.releasePointerCapture(active.pointerId);
  }
  useEffect(() => { cancel(); }, [scope, enabled]);
  useEffect(() => {
    const key = event => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    const blur = () => cancel();
    window.addEventListener('keydown', key, true); window.addEventListener('blur', blur); window.addEventListener('pagehide', blur);
    return () => { gesture.current = null; window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur); window.removeEventListener('pagehide', blur); };
  }, []);
  const label = name === 'assets' ? t('shell.panel.assetsWidth') : name === 'inspector' ? t('shell.panel.inspectorWidth') : t('shell.panel.timelineHeight');
  function commit(next) { cancel(); if (latest.current.enabled) latest.current.onCommit(field, clamp(next, bounds.min, max)); }
  return <div ref={handle} className={`dock-resize resize-${name}`} data-testid={`resize-${name}`} role="separator" aria-label={t('shell.panel.resize', { label })} aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-controls={`dock-${name}`} aria-valuemin={bounds.min} aria-valuemax={Math.round(max)} aria-valuenow={clamp(value, bounds.min, max)} aria-valuetext={t('shell.panel.pixels', { count: clamp(value, bounds.min, max) })} tabIndex={enabled ? 0 : -1} title={t('shell.panel.resizeHint', { label })} hidden={!enabled}
    onPointerDown={event => { if (!enabled || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); gesture.current = { pointerId: event.pointerId, scope, origin: horizontal ? event.clientY : event.clientX, scale: pointerScale(event.currentTarget), initial: value, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { const active = gesture.current; if (!active || active.pointerId !== event.pointerId || active.scope !== latest.current.scope || !latest.current.enabled) return; const position = horizontal ? event.clientY : event.clientX; active.value = clamp(active.initial + direction * (position - active.origin) / active.scale, bounds.min, max); latest.current.onPreview(field, active.value); }}
    onPointerUp={event => { const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return; gesture.current = null; latest.current.onPreview(field, null); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (active.scope === latest.current.scope && latest.current.enabled && active.value !== active.initial) latest.current.onCommit(field, active.value); }}
    onPointerCancel={cancel} onLostPointerCapture={cancel} onDoubleClick={() => { cancel(); if (latest.current.enabled) latest.current.onCommit(field, bounds.default); }}
    onKeyDown={event => { const amount = event.shiftKey ? 50 : 10; let next;
      if (event.key === 'Home') next = bounds.min; else if (event.key === 'End') next = max;
      else if (event.key === (horizontal ? 'ArrowUp' : 'ArrowLeft')) next = value - direction * amount;
      else if (event.key === (horizontal ? 'ArrowDown' : 'ArrowRight')) next = value + direction * amount;
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); commit(next); }
    }}><span /></div>;
}

export function PanelsMenu({ mode, assetsCollapsed, inspectorCollapsed, timelineCollapsed, storyboardOpen, onPanel, onReset, disabled }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="button quiet panels-trigger" data-testid="panels-menu" disabled={disabled} />}><Icon name="grid" size={15} /><span>{t('shell.panel.menu')}</span></DropdownMenuTrigger><DropdownMenuContent align="end" className="workspace-panels-menu"><DropdownMenuGroup><DropdownMenuLabel>{mode === 'canvas' ? t('shell.panel.canvas') : t('shell.panel.editing')}</DropdownMenuLabel>
    <DropdownMenuCheckboxItem checked={!assetsCollapsed} data-testid="menu-panel-assets" onCheckedChange={open => onPanel('assets', open)}>{t('assets.library')}</DropdownMenuCheckboxItem>
    <DropdownMenuCheckboxItem checked={!inspectorCollapsed} data-testid="menu-panel-inspector" onCheckedChange={open => onPanel('inspector', open)}>{t('shell.properties')}</DropdownMenuCheckboxItem>
    {mode === 'editing' ? <DropdownMenuCheckboxItem checked={!timelineCollapsed} data-testid="menu-panel-timeline" onCheckedChange={open => onPanel('timeline', open)}>{t('shell.panel.multitrack')}</DropdownMenuCheckboxItem> : <DropdownMenuCheckboxItem checked={storyboardOpen} data-testid="menu-panel-storyboard" onCheckedChange={open => onPanel('storyboard', open)}>{t('storyboard.order')}</DropdownMenuCheckboxItem>}
    </DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuItem data-testid="reset-panel-layout" onClick={onReset}><Icon name="refresh" size={14} />{t('shell.panel.reset')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}
