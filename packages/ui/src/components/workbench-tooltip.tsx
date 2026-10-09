import * as React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@video-workbench/ui/components/tooltip'

function WorkbenchTooltip({ children, content }: { children: React.ReactElement, content: React.ReactNode }) {
  return <Tooltip><TooltipTrigger render={children} /><TooltipContent>{content}</TooltipContent></Tooltip>
}
export { WorkbenchTooltip }
