import React from 'react';
import type {Ref} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {WorkbenchButton, WorkbenchDialogContent} from '@mioon/ui/components/workbench-controls';
import type {MioRunUsage} from '../../../packages/contracts/src/mio-run-usage.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import type {MioUsageView} from './mio-usage-state.ts';
import './mio-usage.css';

type Field = keyof MioRunUsage['knownTotals'];
function tokenValue(usage:MioRunUsage,field:Field,number:(value:number)=>string):string {
  const coverage=usage.coverage.fields[field],value=usage.knownTotals[field];
  return coverage.overflow||value===null?'—':`${coverage.missingSteps>0?'≥':''}${number(value)}`;
}
export interface MioUsageRowProps {readonly runId:string; readonly view?:MioUsageView; readonly disabled?:boolean; readonly onOpen:()=>void; readonly triggerRef?:Ref<HTMLButtonElement>}
export function MioUsageRow({runId,view,disabled,onOpen,triggerRef}:MioUsageRowProps) {
  const {t,formatNumber}=useI18n(),usage=view?.value;
  const compact=(value:number)=>value>=1_000_000?`${formatNumber(value/1_000_000,{maximumFractionDigits:1})}M`:value>=1000?`${formatNumber(value/1000,{maximumFractionDigits:value>=10_000?0:1})}k`:formatNumber(value);
  return <WorkbenchButton type="button" ref={triggerRef} variant="ghost" size="compact" className="mio-usage-line" disabled={disabled} onClick={onOpen} data-testid={`mio-usage-${runId}`} aria-label={t('mioUsage.title')}>
    {usage?<><span>{t('mioUsage.input')} {tokenValue(usage,'inputTokens',compact)}</span><span aria-hidden="true">·</span><span>{t('mioUsage.output')} {tokenValue(usage,'outputTokens',compact)}</span>
      {usage.cacheReadRate!==null&&<><span aria-hidden="true">·</span><span>{t('mioUsage.cacheRate',{rate:formatNumber(usage.cacheReadRate,{style:'percent',maximumFractionDigits:0})})}</span></>}
      {usage.cacheReadRate===null&&usage.coverage.fields.cacheReadTokens.reportedSteps>0&&<><span aria-hidden="true">·</span><span>{t('mioUsage.cacheRead')} {tokenValue(usage,'cacheReadTokens',compact)}</span></>}
      {(view.stale||view.phase==='error')&&<span className="mio-usage-unconfirmed">{t('mioUsage.stale')}</span>}
    </>:t(view?.phase==='error'?'mioUsage.error':'mioUsage.loading')}<span aria-hidden="true" className="mio-usage-arrow">›</span>
  </WorkbenchButton>;
}
export interface MioUsageDetailsProps {readonly open:boolean; readonly runId:string|null; readonly view?:MioUsageView; readonly onClose:()=>void; readonly onRetry:()=>void}
export function MioUsageDetails({open,runId,view,onClose,onRetry}:MioUsageDetailsProps) {
  const {t,formatNumber}=useI18n(),usage=view?.value;
  const explanation=(field:Field)=>{
    if(!usage)return null;
    const coverage=usage.coverage.fields[field];
    // Canonical aggregates have no terminal usage for an in-flight request.
    // Keep it pending, rather than calling it a provider reporting omission.
    const missing=Math.max(0,coverage.missingSteps-usage.modelOutcomes.inflight);
    return usage.dispatchedModelSteps===0?null:coverage.overflow?t('mioUsage.overflow'):missing===0?null:coverage.reportedSteps===0?t('mioUsage.notReported'):t('mioUsage.missing',{count:missing});
  };
  const field=(name:Field,label:'mioUsage.input'|'mioUsage.output'|'mioUsage.cacheRead'|'mioUsage.cacheWrite')=>usage&&<div data-field={name}><dt>{t(label)}</dt><dd><span className="mio-usage-number">{usage.knownTotals[name]===null?'—':t('mioUsage.tokenValue',{count:usage.knownTotals[name],prefix:usage.coverage.fields[name].missingSteps>0?'≥':''})}</span>{explanation(name)&&<p className="mio-usage-note">{explanation(name)}</p>}</dd></div>;
  return <Dialog open={open} onOpenChange={next=>{if(!next)onClose();}}><WorkbenchDialogContent title={t('mioUsage.title')} className="mio-usage-dialog" data-testid="mio-usage-details" data-run-id={runId??undefined} finalFocus={false}
    footer={<><WorkbenchButton type="button" variant="ghost" disabled={view?.phase==='loading'} onClick={onRetry}>{t('mioUsage.retry')}</WorkbenchButton><WorkbenchButton type="button" onClick={onClose}>{t('mioUsage.close')}</WorkbenchButton></>}>
    {view?.phase==='loading'&&!usage&&<p role="status">{t('mioUsage.loading')}</p>}
    {view?.phase==='error'&&<p role="alert" className="mio-usage-unconfirmed">{t('mioUsage.error')}</p>}
    {view?.stale&&usage&&<p role="status" className="mio-usage-unconfirmed">{t('mioUsage.stale')}</p>}
    {usage&&<><p className="mio-usage-requests">{t('mioUsage.requests',{count:usage.dispatchedModelSteps,completed:formatNumber(usage.modelOutcomes.completed),failed:formatNumber(usage.modelOutcomes.failed)})}
      {usage.modelOutcomes.unknown>0&&<> · {t('mioUsage.unknown',{count:usage.modelOutcomes.unknown})}</>}{usage.modelOutcomes.inflight>0&&<> · {t('mioUsage.inflight',{count:usage.modelOutcomes.inflight})}</>}</p>
      {usage.dispatchedModelSteps===0&&<p className="mio-usage-note">{t('mioUsage.noRequests')}</p>}
      <dl className="mio-usage-fields">{field('inputTokens','mioUsage.input')}
        {usage.cacheReadRate!==null?<div className="mio-usage-cache-within"><dt className="sr-only">{t('mioUsage.cacheRead')}</dt><dd>{t('mioUsage.cachedWithin',{count:usage.knownTotals.cacheReadTokens!,rate:formatNumber(usage.cacheReadRate,{style:'percent',maximumFractionDigits:0})})}</dd></div>:<>{field('cacheReadTokens','mioUsage.cacheRead')}{usage.coverage.fields.cacheReadTokens.reportedSteps>0&&<div><dt/><dd><p className="mio-usage-note">{t('mioUsage.cacheIndependent')}</p></dd></div>}</>}
        {field('outputTokens','mioUsage.output')}{usage.coverage.fields.cacheWriteTokens.reportedSteps>0&&field('cacheWriteTokens','mioUsage.cacheWrite')}</dl>
      {usage.modelOutcomes.inflight>0&&<p className="mio-usage-note">{t('mioUsage.changing')}</p>}</>}
    <p className="mio-usage-note mio-usage-footer">{t('mioUsage.footer')}</p>
  </WorkbenchDialogContent></Dialog>;
}
