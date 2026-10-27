import React,{useState} from 'react';
import {Collapsible,CollapsibleTrigger,CollapsibleContent} from '@mioon/ui/components/collapsible';
import {ChevronDown} from '@mioon/ui/components/workbench-icons';
import {WorkspaceVisibilityProvider,useWorkspaceVisibility} from './workspace-visibility.tsx';
// meta is a short count beside the title; actions sit at the heading's end,
// outside the toggle, so they never collapse the group.
export default function BoardInspectorGroup({title,children,initialOpen=true,meta,actions}:{title:string;children:React.ReactNode;initialOpen?:boolean;meta?:React.ReactNode;actions?:React.ReactNode}){
  const [open,setOpen]=useState(initialOpen),visible=useWorkspaceVisibility();
  const trigger=<CollapsibleTrigger className="board-inspector-group-heading" disabled={!visible}><ChevronDown size={13}/><span>{title}</span>{meta!=null&&meta!==''&&<small className="board-inspector-group-meta">{meta}</small>}</CollapsibleTrigger>;
  return <Collapsible open={open} onOpenChange={next=>{if(visible)setOpen(next);}} className="board-inspector-group">{actions?<div className="board-inspector-group-header">{trigger}<div className="board-inspector-group-actions">{actions}</div></div>:trigger}<WorkspaceVisibilityProvider visible={open}><CollapsibleContent keepMounted inert={!open} className="board-inspector-group-content">{children}</CollapsibleContent></WorkspaceVisibilityProvider></Collapsible>;
}
