import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorkbenchPopover, WorkbenchPopoverContent, WorkbenchPopoverTitle, WorkbenchPopoverTrigger } from '@mioon/ui/components/workbench-popover';
import { WorkbenchBadge, WorkbenchButton, WorkbenchProgress } from '@mioon/ui/components/workbench-controls';
import { Clock, RotateCcw, X } from '@mioon/ui/components/workbench-icons';
import { useI18n } from './i18n/I18nProvider.tsx';
import './task-overview.css';
export interface TaskOverviewItem { readonly id: string; readonly label: string; readonly status: string; readonly progress?: number; readonly phase?:'active'|'attention'; readonly tone?: 'neutral'|'warning'|'danger'|'success';
 /** A second line under the progress bar, for a status too long for the badge. */
 readonly detail?: string;
 /** Opens the item's own view instead of the task center, e.g. a shot detection dialog. */
 readonly onOpen?: () => void;
 /** Stops the task from the popover; cancelLabel names it for assistive technology. */
 readonly onCancel?: () => void; readonly cancelLabel?: string;
 /** Starts the same work again, e.g. a storyboard that built nothing; retryLabel names it. */
 readonly onRetry?: () => void; readonly retryLabel?: string }
export default function TaskPopover({scope,visible,count,uncertain,items,onOpenTasks}:{scope:string;visible:boolean;count:number;uncertain:boolean;items:readonly TaskOverviewItem[];onOpenTasks:(selectedTaskId?:string)=>void}) {
 const {t}=useI18n(),[open,setOpen]=useState(false),token=useMemo(()=>({scope,visible}),[scope,visible]),current=useRef<typeof token|null>(token);
 useLayoutEffect(()=>{current.current=token;setOpen(false);return()=>{current.current=null;};},[token]);
 const listed=items.filter(item=>item.phase==='active'||item.phase==='attention'||item.progress!==undefined||item.tone==='warning');
 const groups=[{key:'active',label:t('redesign.tasks.active'),items:listed.filter(item=>item.phase==='active'||!item.phase&&item.tone!=='warning')},{key:'attention',label:t('redesign.tasks.needsAttention'),items:listed.filter(item=>item.phase==='attention'||!item.phase&&item.tone==='warning')}];
 const displayCount=listed.length;
 const allowed=()=>visible&&Boolean(scope)&&current.current===token;
 return <WorkbenchPopover open={visible&&open} onOpenChange={next=>{if(allowed())setOpen(next);}}><WorkbenchPopoverTrigger render={<WorkbenchButton variant="ghost" className="workbench-task-trigger" id="right-dock-tasks-tab" data-testid="jobs-button" aria-label={t('shell.tasks')} title={t('shell.tasks')} disabled={!visible}/> }><span data-testid="right-dock-tab-tasks"><Clock size={16}/><span className="workbench-task-label">{t('shell.tasks')}</span></span><WorkbenchBadge>{displayCount}</WorkbenchBadge>{uncertain&&<span aria-label={t('shell.recoveryUnchecked')}>…</span>}</WorkbenchPopoverTrigger>
 <WorkbenchPopoverContent className="task-overview" hidden={!visible} inert={!visible} finalFocus={visible?undefined:false}><header><WorkbenchPopoverTitle>{t('shell.tasks')}</WorkbenchPopoverTitle><WorkbenchBadge>{displayCount}</WorkbenchBadge></header>
 <div className="task-overview-items">{uncertain&&<p className="task-overview-warning">{t('redesign.tasks.unknownHint')}</p>}{listed.length?groups.filter(group=>group.items.length).map(group=><section className="task-overview-group" key={group.key}><h3>{group.label}<span>{group.items.length}</span></h3>{group.items.map(item=><article key={item.id} data-tone={item.tone}><div><strong title={item.label}>{item.label}</strong><WorkbenchBadge tone={item.tone}>{item.status}</WorkbenchBadge>{item.onCancel&&<WorkbenchButton variant="icon" size="compact" className="task-overview-cancel" data-testid={`task-overview-cancel-${item.id}`} aria-label={item.cancelLabel} title={item.cancelLabel} onClick={()=>{if(allowed())item.onCancel?.();}}><X size={14}/></WorkbenchButton>}{item.onRetry&&<WorkbenchButton variant="secondary" size="compact" className="task-overview-retry" data-testid={`task-overview-retry-${item.id}`} aria-label={item.retryLabel} title={item.retryLabel} onClick={()=>{if(!allowed())return;setOpen(false);item.onRetry?.();}}><RotateCcw size={13}/>{t('shell.retry')}</WorkbenchButton>}</div>{item.progress!==undefined&&<WorkbenchProgress value={item.progress} label={item.label}/>}{item.detail&&<p className="task-overview-detail">{item.detail}</p>}{<WorkbenchButton variant="ghost" className="task-overview-inspect" data-testid={`task-overview-inspect-${item.id}`} onClick={()=>{if(!allowed())return;setOpen(false);if(item.onOpen)item.onOpen();else onOpenTasks(item.id);}}>{t('shell.details')}</WorkbenchButton>}</article>)}</section>):<p>{t('tasks.center.noGenerationTasks')}</p>}</div>
 <footer><WorkbenchButton variant="ghost" data-testid="task-overview-all" onClick={()=>{if(!allowed())return;setOpen(false);onOpenTasks();}}>{t('redesign.tasks.viewAll')}</WorkbenchButton></footer></WorkbenchPopoverContent></WorkbenchPopover>;
}
