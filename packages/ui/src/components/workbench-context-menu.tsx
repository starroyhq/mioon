import React from 'react';
import { Menu as Primitive } from '@base-ui/react/menu';
import { cn } from '@mioon/ui/lib/utils';

export interface WorkbenchPointerAnchor { readonly x: number; readonly y: number }
/** A right-click menu opened at the pointer, so the element it belongs to keeps
 * its own layout. Its items are ordinary Menu parts: DropdownMenuItem and
 * DropdownMenuSeparator render inside it. */
export function WorkbenchContextMenu({ anchor, onClose, className, children, ...props }: Omit<React.ComponentProps<typeof Primitive.Popup>, 'children'> & {
  anchor: WorkbenchPointerAnchor | null
  onClose: () => void
  children: React.ReactNode
}) {
  const x = anchor?.x, y = anchor?.y;
  const point = React.useMemo(() => x === undefined || y === undefined ? null : { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) }, [x, y]);
  return <Primitive.Root open={point !== null} onOpenChange={open => { if (!open) onClose(); }}>
    <Primitive.Portal><Primitive.Positioner className="isolate z-50 outline-none" anchor={point} side="bottom" align="start" sideOffset={2}>
      <Primitive.Popup data-slot="dropdown-menu-content" className={cn('cn-menu-target cn-menu-translucent z-50 max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95', className)} {...props}>{children}</Primitive.Popup>
    </Primitive.Positioner></Primitive.Portal>
  </Primitive.Root>;
}
