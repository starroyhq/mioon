import React from 'react';
import {createContext,useContext,useState,type ReactNode} from 'react';
import {ChevronRight} from '@mioon/ui/components/workbench-icons';
const Context=createContext<{open:ReadonlySet<string>;toggle(key:string):void}|null>(null);
export function InspectorGroups({defaultOpen,children}:{defaultOpen:readonly string[];children:ReactNode}) {
  const [open,setOpen]=useState<ReadonlySet<string>>(()=>new Set(defaultOpen));
  const toggle=(key:string)=>setOpen(current=>current.has(key)?new Set([...current].filter(value=>value!==key)):new Set([key]));
  return <Context.Provider value={{open,toggle}}>{children}</Context.Provider>;
}
export default function InspectorGroup({title, children, initialOpen = false, className = '', groupKey = ''}: {title: string; children: ReactNode; initialOpen?: boolean; className?: string; groupKey?: string}) {
  const group=useContext(Context),[localOpen,setLocalOpen] = useState(initialOpen),open=group?group.open.has(groupKey):localOpen;
  return <section className={`edit-inspector-group ${className} ${open?'is-open':''}`}><button type="button" className="edit-inspector-group-heading" aria-expanded={open} onClick={() => group?group.toggle(groupKey):setLocalOpen(!localOpen)}><ChevronRight size={13} /><span>{title}</span></button><div className="edit-inspector-group-content" hidden={!open}>{children}</div></section>;
}
