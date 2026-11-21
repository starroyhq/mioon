import React from 'react';
import {createContext,useContext,useLayoutEffect,useState,type ReactNode} from 'react';
import {ChevronRight} from '@mioon/ui/components/workbench-icons';
const Context=createContext<{open:ReadonlySet<string>;toggle(key:string):void}|null>(null);
export function InspectorGroups({defaultOpen,children,requestedOpen}:{defaultOpen:readonly string[];children:ReactNode;requestedOpen?:{key:string;version:number}}) {
  const [open,setOpen]=useState<ReadonlySet<string>>(()=>new Set(defaultOpen));
  useLayoutEffect(() => {if(requestedOpen)setOpen(new Set([requestedOpen.key]));},[requestedOpen]);
  const toggle=(key:string)=>setOpen(current=>current.has(key)?new Set([...current].filter(value=>value!==key)):new Set([key]));
  return <Context.Provider value={{open,toggle}}>{children}</Context.Provider>;
}
/** One collapsible inspector group. `headerAction` renders beside the title and
 * stays available while collapsed; `footer` renders under the group content
 * (format-5 audio group: mute switch + separate/save buttons). Both are purely
 * additive: every existing group keeps its exact DOM. */
export default function InspectorGroup({title, children, initialOpen = false, className = '', groupKey = '', headerAction, footer}: {title: string; children: ReactNode; initialOpen?: boolean; className?: string; groupKey?: string; headerAction?: ReactNode; footer?: ReactNode}) {
  const group=useContext(Context),[localOpen,setLocalOpen] = useState(initialOpen),open=group?group.open.has(groupKey):localOpen;
  const heading = <button type="button" className="edit-inspector-group-heading" aria-expanded={open} onClick={() => group?group.toggle(groupKey):setLocalOpen(!localOpen)}><ChevronRight size={13} /><span>{title}</span></button>;
  return <section className={`edit-inspector-group ${className} ${open?'is-open':''}`}>
    {headerAction === undefined ? heading
      : <div className="edit-inspector-group-heading-row" data-testid={`inspector-group-heading-${groupKey}`}>{heading}<div className="edit-inspector-group-action">{headerAction}</div></div>}
    <div className="edit-inspector-group-content" hidden={!open}>{children}{footer !== undefined && <div className="edit-inspector-group-footer">{footer}</div>}</div>
  </section>;
}
