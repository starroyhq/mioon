import React, { createContext, isValidElement, cloneElement, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';

/** Server-rendering stand-ins for `@mioon/ui/components/dialog` and
 * `@mioon/ui/components/dropdown-menu`. Base UI renders dialogs and menus into
 * a portal, so a server render would show nothing; these render in place and
 * keep `data-slot`, `role` and `aria-*`. Used by tests/helpers/project-file-ui.ts only. */
type Props = Record<string, unknown> & { readonly children?: ReactNode };
const BEHAVIOUR = new Set(['open', 'defaultOpen', 'onOpenChange', 'onOpenChangeComplete', 'modal', 'keepMounted', 'showCloseButton', 'initialFocus', 'finalFocus', 'render',
  'align', 'alignOffset', 'side', 'sideOffset', 'closeOnClick', 'inset', 'variant', 'disabled', 'checked', 'onCheckedChange', 'value', 'onValueChange', 'onClick', 'actionsRef', 'dismissible', 'openOnHover', 'delay']);
function dom(props: Props): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([name]) => name !== 'children' && !BEHAVIOUR.has(name)));
}
function slot(name: string, element: 'div' | 'span' | 'h2' | 'p' | 'button', extra: Record<string, unknown> = {}) {
  return function Slot(props: Props): ReactElement {
    return React.createElement(element, { ...dom(props), 'data-slot': name, ...extra }, props.children);
  };
}

const DialogOpen = createContext(false);
export function Dialog({ open, defaultOpen, children }: Props): ReactElement | null {
  const shown = Boolean(open ?? defaultOpen);
  return shown ? <DialogOpen.Provider value>{children}</DialogOpen.Provider> : null;
}
export function DialogContent(props: Props): ReactElement | null {
  return useContext(DialogOpen) ? <div {...dom(props)} role="dialog" aria-modal="true" data-slot="dialog-content">{props.children}</div> : null;
}
export const DialogTitle = slot('dialog-title', 'h2');
export const DialogDescription = slot('dialog-description', 'p');
export const DialogHeader = slot('dialog-header', 'div');
export const DialogFooter = slot('dialog-footer', 'div');
export const DialogClose = slot('dialog-close', 'button', { type: 'button' });
export const DialogTrigger = slot('dialog-trigger', 'button', { type: 'button' });
export function DialogPortal({ children }: Props): ReactElement { return <>{children}</>; }
export function DialogOverlay(): null { return null; }

const MenuOpen = createContext(false);
export function DropdownMenu({ open, defaultOpen, children }: Props): ReactElement {
  return <MenuOpen.Provider value={Boolean(open ?? defaultOpen)}>{children}</MenuOpen.Provider>;
}
export function DropdownMenuTrigger(props: Props): ReactElement {
  const expanded = useContext(MenuOpen);
  const attributes = { ...dom(props), 'data-slot': 'dropdown-menu-trigger', 'aria-haspopup': 'menu' as const, 'aria-expanded': expanded };
  return isValidElement(props.render) ? cloneElement(props.render as ReactElement<Record<string, unknown>>, attributes, props.children) : <button type="button" {...attributes}>{props.children}</button>;
}
export function DropdownMenuPortal({ children }: Props): ReactElement { return <>{children}</>; }
export function DropdownMenuContent(props: Props): ReactElement | null {
  return useContext(MenuOpen) ? <div {...dom(props)} role="menu" data-slot={typeof props['data-slot'] === 'string' ? props['data-slot'] : 'dropdown-menu-content'}>{props.children}</div> : null;
}
export const DropdownMenuGroup = slot('dropdown-menu-group', 'div', { role: 'group' });
export const DropdownMenuLabel = slot('dropdown-menu-label', 'div');
export function DropdownMenuItem(props: Props): ReactElement {
  return <div {...dom(props)} role="menuitem" data-slot="dropdown-menu-item" data-variant={props.variant as string | undefined} aria-disabled={props.disabled ? 'true' : undefined} data-disabled={props.disabled ? '' : undefined}>{props.children}</div>;
}
export function DropdownMenuSub({ open, defaultOpen, children }: Props): ReactElement {
  return <MenuOpen.Provider value={Boolean(open ?? defaultOpen)}><div data-slot="dropdown-menu-sub">{children}</div></MenuOpen.Provider>;
}
export function DropdownMenuSubTrigger(props: Props): ReactElement {
  const expanded = useContext(MenuOpen);
  return <div {...dom(props)} role="menuitem" data-slot="dropdown-menu-sub-trigger" aria-haspopup="menu" aria-expanded={expanded} aria-disabled={props.disabled ? 'true' : undefined}>{props.children}</div>;
}
export function DropdownMenuSubContent(props: Props): ReactElement | null {
  return useContext(MenuOpen) ? <div {...dom(props)} role="menu" data-slot="dropdown-menu-sub-content">{props.children}</div> : null;
}
export function DropdownMenuCheckboxItem(props: Props): ReactElement {
  return <div {...dom(props)} role="menuitemcheckbox" data-slot="dropdown-menu-checkbox-item" aria-checked={Boolean(props.checked)} aria-disabled={props.disabled ? 'true' : undefined}>{props.children}</div>;
}
export const DropdownMenuRadioGroup = slot('dropdown-menu-radio-group', 'div', { role: 'group' });
export function DropdownMenuRadioItem(props: Props): ReactElement {
  return <div {...dom(props)} role="menuitemradio" data-slot="dropdown-menu-radio-item" aria-disabled={props.disabled ? 'true' : undefined}>{props.children}</div>;
}
export const DropdownMenuSeparator = slot('dropdown-menu-separator', 'div', { role: 'separator' });
export const DropdownMenuShortcut = slot('dropdown-menu-shortcut', 'span');
