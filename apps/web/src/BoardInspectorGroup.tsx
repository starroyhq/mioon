import React,{useState} from 'react';
import {Collapsible,CollapsibleTrigger,CollapsibleContent} from '@mioon/ui/components/collapsible';
import {ChevronDown} from '@mioon/ui/components/workbench-icons';
import {WorkspaceVisibilityProvider,useWorkspaceVisibility} from './workspace-visibility.jsx';
export default function BoardInspectorGroup({title,children,initialOpen=true}:{title:string;children:React.ReactNode;initialOpen?:boolean}){
  const [open,setOpen]=useState(initialOpen),visible=useWorkspaceVisibility();
  return <Collapsible open={open} onOpenChange={next=>{if(visible)setOpen(next);}} className="board-inspector-group"><CollapsibleTrigger className="board-inspector-group-heading" disabled={!visible}><ChevronDown size={13}/><span>{title}</span></CollapsibleTrigger><WorkspaceVisibilityProvider visible={open}><CollapsibleContent keepMounted inert={!open} className="board-inspector-group-content">{children}</CollapsibleContent></WorkspaceVisibilityProvider></Collapsible>;
}
