import React from 'react';
import {Popover as Primitive} from '@base-ui/react/popover';

export const WorkbenchPopover=Primitive.Root;
export const WorkbenchPopoverTrigger=Primitive.Trigger;
export const WorkbenchPopoverTitle=Primitive.Title;
export const WorkbenchPopoverClose=Primitive.Close;
export function WorkbenchPopoverContent({side='bottom',align='end',sideOffset=6,zIndex='var(--wb-z-popover, 80)',children,...props}:React.ComponentProps<typeof Primitive.Popup>&Pick<React.ComponentProps<typeof Primitive.Positioner>,'side'|'align'|'sideOffset'>&{zIndex?:React.CSSProperties['zIndex']}){
  return <Primitive.Portal><Primitive.Positioner side={side} align={align} sideOffset={sideOffset} style={{zIndex}}><Primitive.Popup {...props}>{children}</Primitive.Popup></Primitive.Positioner></Primitive.Portal>;
}
