import React from 'react';
import {createContext,useContext,useLayoutEffect,useState,type ReactNode} from 'react';
import {ChevronRight} from '@mioon/ui/components/workbench-icons';
import {MioEditingBadge} from './MioCoEditingControls.tsx';
const Context=createContext<{open:ReadonlySet<string>;toggle(key:string):void}|null>(null);
export function InspectorGroups({defaultOpen,children,requestedOpen}:{defaultOpen:readonly string[];children:ReactNode;requestedOpen?:{key:string;version:number}}) {
  const [open,setOpen]=useState<ReadonlySet<string>>(()=>new Set(defaultOpen));
  useLayoutEffect(() => {if(requestedOpen)setOpen(new Set([requestedOpen.key]));},[requestedOpen]);
  const toggle=(key:string)=>setOpen(current=>current.has(key)?new Set([...current].filter(value=>value!==key)):new Set([key]));
  return <Context.Provider value={{open,toggle}}>{children}</Context.Provider>;
}
/** One collapsible inspector group. `headerAction` renders beside the title and
 * stays available while collapsed; `footer` renders under the group content
 * (format-5 audio group: mute switch + separate/save buttons). Co-editing
 * props (`mioEditing`, `conflict`, `hasConflict`) are purely additive. */
export default function InspectorGroup({title, children, initialOpen = false, className = '', groupKey = '', headerAction, footer, mioEditing = null, conflict = null, hasConflict = false}: {title: string; children: ReactNode; initialOpen?: boolean; className?: string; groupKey?: string; headerAction?: ReactNode; footer?: ReactNode; mioEditing?: {color: string; badgeTestId?: string} | null; conflict?: ReactNode; hasConflict?: boolean}) {
  const group=useContext(Context),[localOpen,setLocalOpen] = useState(initialOpen),open=hasConflict || Boolean(mioEditing) || (group?group.open.has(groupKey):localOpen);
  const badge = mioEditing ? <MioEditingBadge color={mioEditing.color} testId={mioEditing.badgeTestId} /> : null;
  const heading = <button type="button" className="edit-inspector-group-heading" aria-expanded={open} onClick={() => group?group.toggle(groupKey):setLocalOpen(!localOpen)}><ChevronRight size={13} /><span>{title}</span>{badge}</button>;
  const body = <>{children}{footer !== undefined && <div className="edit-inspector-group-footer">{footer}</div>}</>;
  return <section className={`edit-inspector-group ${className} ${open?'is-open':''}`} data-mio-editing={mioEditing ? 'true' : undefined} data-coedit-conflict={hasConflict && !mioEditing ? 'true' : undefined} style={mioEditing ? {'--mio-coedit-color': mioEditing.color} as React.CSSProperties : undefined}>
    {headerAction === undefined ? heading
      : <div className="edit-inspector-group-heading-row" data-testid={`inspector-group-heading-${groupKey}`}>{heading}<div className="edit-inspector-group-action">{headerAction}</div></div>}
    <div className="edit-inspector-group-content" hidden={!open}>{conflict}{mioEditing ? <fieldset className="mio-coedit-lock-fieldset" disabled>{body}</fieldset> : body}</div>
  </section>;
}
