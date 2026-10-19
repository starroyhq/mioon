import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mioon/ui/components/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mioon/ui/components/tooltip';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';

// Portals are outside a panel's inert DOM subtree. Close only their ephemeral
// UI state while the owning form and its pending work remain mounted.
function useVisiblePopupState() {
  const visible = useWorkspaceVisibility();
  const [open, setOpen] = useState(false);
  const visibility = useMemo(() => ({ visible }), [visible]);
  const current = useRef(visibility);
  const returnFocusAllowed = useRef(false);
  useLayoutEffect(() => {
    current.current = visibility;
    if (!visible) { setOpen(false); returnFocusAllowed.current = false; }
    return () => { current.current = null; returnFocusAllowed.current = false; };
  }, [visibility]);
  // An old callback must stay obsolete even after the panel is shown again.
  const canInteract = () => visible && current.current === visibility;
  return { visible, open: visible && open, canInteract, canReturnFocus: () => returnFocusAllowed.current && canInteract(), onOpenChange: next => {
    if (canInteract()) {
      if (next) returnFocusAllowed.current = true;
      setOpen(Boolean(next));
    }
  } };
}

export function WorkbenchSelect({ children, value, onChange, className, disabled, required, name, ...props }) {
  const popup = useVisiblePopupState();
  const trigger = useRef(null), content = useRef(null);
  const finalFocus = () => {
    if (!popup.canReturnFocus()) return false;
    const document = trigger.current?.ownerDocument, active = document?.activeElement;
    // Preserve newer focus outside the popup instead of making a controlled
    // final-focus callback override Base UI's normal outside-click behavior.
    return Boolean(trigger.current?.isConnected && (!active || active === document.body || active === trigger.current || content.current?.contains(active)));
  };
  const options = React.Children.toArray(children).filter(React.isValidElement).map(option => {
    const label = React.Children.toArray(option.props.children).join('');
    return { value: String(option.props.value ?? label), label, disabled: Boolean(option.props.disabled) };
  });
  return <Select value={value == null ? null : String(value)} items={options} disabled={disabled || !popup.visible} required={required} name={name}
    open={popup.open} onOpenChange={popup.onOpenChange} onValueChange={next => {
      if (next !== null && !disabled && popup.canInteract()) onChange?.({ target: { value: String(next) } });
    }}>
    <SelectTrigger {...props} ref={trigger} className={['workbench-select', className].filter(Boolean).join(' ')}><SelectValue /></SelectTrigger>
    <SelectContent ref={content} align="start" alignItemWithTrigger={false} className="workbench-select-popup" finalFocus={popup.visible ? finalFocus : false}
      hidden={!popup.visible} inert={!popup.visible} aria-hidden={!popup.visible || undefined}>
      {options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}

export function WorkbenchTooltip({ children, content }) {
  const popup = useVisiblePopupState();
  return <Tooltip open={popup.open} onOpenChange={popup.onOpenChange} disabled={!popup.visible}>
    <TooltipTrigger render={children} />
    <TooltipContent hidden={!popup.visible} inert={!popup.visible} aria-hidden={!popup.visible || undefined}>{content}</TooltipContent>
  </Tooltip>;
}
