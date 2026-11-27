import React from 'react';
import { WorkbenchBadge, WorkbenchButton, WorkbenchProgress } from '@mioon/ui/components/workbench-controls';
import { useI18n } from './i18n/I18nProvider.tsx';
import { statusDescriptor, workspaceHeldDescriptor } from './creation-i18n.ts';
interface RenderRow {id:string;projectId:string;mode:string;purpose?:string;status:string;error?:unknown;progress?:number;snapshot?:{deliveryName?:string};source?:{clipName?:string}}
const isCancelled=(item:Pick<RenderRow,'status'|'error'>):boolean=>item.status==='cancelled'||Boolean(item.error&&typeof item.error==='object'&&'code' in item.error&&(item.error as {code?:unknown}).code==='EXPORT_CANCELLED');
const row=(value:unknown,projectId:string):value is RenderRow=>{
 if(!(value&&typeof value==='object'))return false;
 const item=value as {id?:unknown;projectId?:unknown;mode?:unknown;purpose?:unknown;status?:unknown};
 if(typeof item.id!=='string'||typeof item.projectId!=='string'||item.projectId!==projectId||typeof item.status!=='string')return false;
 // «Save clip sound» tasks share the exports channel; their detail card shows
 // the same live progress without entering the export history.
 return item.mode==='clip-audio'||item.mode==='timeline'&&(item.purpose==='preview'||item.purpose==='export');
};
export default function TaskRenderList({items,projectId,onHistory}:{items:readonly unknown[];projectId:string;onHistory?:()=>void}) {
 const {t,renderMessage}=useI18n();const records=items.filter((value):value is RenderRow=>row(value,projectId));if(!records.length)return null;
 const label=(item:RenderRow):string=>item.mode==='clip-audio'
  ? `${t('clipSound.saveAsAudio')}${typeof item.source?.clipName==='string'?` · ${item.source.clipName}`:''}`
  : typeof item.snapshot?.deliveryName==='string'?item.snapshot.deliveryName:t(item.purpose==='export'?'redesign.export.step4':'shell.preview');
 return <section className="task-render-list" data-testid="task-render-list"><h3>{t('redesign.tasks.rendering')}</h3>{records.map(item=>{const cancelled=isCancelled(item);return <article className="job-card" key={item.id}><div className="job-title"><strong data-text-selectable>{label(item)}</strong><WorkbenchBadge tone={item.status==='failed'&&!cancelled?'danger':item.status==='succeeded'?'success':'neutral'}>{cancelled?t('redesign.export.cancelled'):renderMessage(statusDescriptor(item.status))}</WorkbenchBadge></div>{['queued','running'].includes(item.status)&&<WorkbenchProgress value={typeof item.progress==='number'&&Number.isFinite(item.progress)?item.progress:0} label={t(item.mode==='clip-audio'?'clipSound.saveAsAudio':'redesign.tasks.rendering')}/>}{onHistory&&item.mode==='timeline'&&<WorkbenchButton variant="ghost" onClick={onHistory}>{t('export.workspace.history')}</WorkbenchButton>}</article>;})}</section>;
}
