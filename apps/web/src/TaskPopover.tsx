import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorkbenchPopover, WorkbenchPopoverContent, WorkbenchPopoverTitle, WorkbenchPopoverTrigger } from '@mioon/ui/components/workbench-popover';
import { WorkbenchBadge, WorkbenchButton, WorkbenchProgress } from '@mioon/ui/components/workbench-controls';
import { Clock } from '@mioon/ui/components/workbench-icons';
import { useI18n } from './i18n/I18nProvider.tsx';
import './task-overview.css';
export interface TaskOverviewItem { readonly id: string; readonly label: string; readonly status: string; readonly progress?: number; readonly tone?: 'neutral'|'warning'|'danger'|'success' }
export default function TaskPopover({scope,visible,count,uncertain,items,onOpenTasks}:{scope:string;visible:boolean;count:number;uncertain:boolean;items:readonly TaskOverviewItem[];onOpenTasks:()=>void}) {
 const {t}=useI18n(),[open,setOpen]=useState(false),token=useMemo(()=>({scope,visible}),[scope,visible]),current=useRef<typeof token|null>(token);
 useLayoutEffect(()=>{current.current=token;setOpen(false);return()=>{current.current=null;};},[token]);
 const allowed=()=>visible&&Boolean(scope)&&current.current===token;
 return <WorkbenchPopover open={visible&&open} onOpenChange={next=>{if(allowed())setOpen(next);}}><WorkbenchPopoverTrigger render={<WorkbenchButton variant="ghost" className="workbench-task-trigger" id="right-dock-tasks-tab" data-testid="jobs-button" aria-label={t('shell.tasks')} title={t('shell.tasks')} disabled={!visible}/> }><span data-testid="right-dock-tab-tasks"><Clock size={16}/></span>{count>0&&<WorkbenchBadge>{count}</WorkbenchBadge>}{uncertain&&<span aria-label={t('shell.recoveryUnchecked')}>…</span>}</WorkbenchPopoverTrigger>
 <WorkbenchPopoverContent className="task-overview" hidden={!visible} inert={!visible} finalFocus={visible?undefined:false}><header><WorkbenchPopoverTitle>{t('shell.tasks')}</WorkbenchPopoverTitle><WorkbenchBadge>{count}</WorkbenchBadge></header>
 <div className="task-overview-items">{uncertain&&<p className="task-overview-warning">{t('redesign.tasks.unknownHint')}</p>}{items.length?items.slice(0,5).map(item=><article key={item.id}><div><strong title={item.label}>{item.label}</strong><WorkbenchBadge tone={item.tone}>{item.status}</WorkbenchBadge></div>{item.progress!==undefined&&<WorkbenchProgress value={item.progress} label={item.label}/>}</article>):<p>{t('tasks.center.noGenerationTasks')}</p>}</div>
 <footer><WorkbenchButton variant="ghost" data-testid="task-overview-all" onClick={()=>{if(!allowed())return;setOpen(false);onOpenTasks();}}>{t('redesign.tasks.viewAll')}</WorkbenchButton></footer></WorkbenchPopoverContent></WorkbenchPopover>;
}
