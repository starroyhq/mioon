import React,{useState} from 'react';
import {Collapsible,CollapsibleTrigger,CollapsibleContent} from '@mioon/ui/components/collapsible';
import {ChevronDown} from '@mioon/ui/components/workbench-icons';
import {WorkspaceVisibilityProvider,useWorkspaceVisibility} from './workspace-visibility.tsx';
// meta is a short count beside the title; actions sit at the heading's end,
// outside the toggle, so they never collapse the group.
export default function BoardInspectorGroup({title,children,initialOpen=true,meta,actions,titleAction,'data-testid':testId}:{title:string;children:React.ReactNode;initialOpen?:boolean;meta?:React.ReactNode;actions?:React.ReactNode;titleAction?:React.ReactNode;'data-testid'?:string}){
  const [open,setOpen]=useState(initialOpen),visible=useWorkspaceVisibility();
  const trigger=<CollapsibleTrigger className="board-inspector-group-heading" disabled={!visible}><ChevronDown size={13}/><span>{title}</span>{meta!=null&&meta!==''&&<small className="board-inspector-group-meta">{meta}</small>}</CollapsibleTrigger>;
  return <Collapsible open={open} onOpenChange={next=>{if(visible)setOpen(next);}} className="board-inspector-group" data-testid={testId}>{actions || titleAction ? <div className={`board-inspector-group-header${titleAction ? ' has-title-action' : ''}`}>{trigger}<div className="board-inspector-group-actions">{titleAction}{actions}</div></div>:trigger}<WorkspaceVisibilityProvider visible={open}><CollapsibleContent keepMounted inert={!open} className="board-inspector-group-content">{children}</CollapsibleContent></WorkspaceVisibilityProvider></Collapsible>;
}
