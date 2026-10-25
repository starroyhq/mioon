import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
import { WorkbenchButton, WorkbenchProgress } from '@mioon/ui/components/workbench-controls';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { message } from '../../../packages/i18n/src/index.ts';
import type { ExportActivity, ExportOutput } from '../../../packages/contracts/src/export-controls.ts';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import ExportFileActions from './ExportFileActions.tsx';
import './export-workflow.css';

type Step = 1 | 2 | 3 | 4 | 5;
export interface ExportWorkflowRecord { readonly id: string; readonly status: string; readonly progress?: number; readonly url?: string; readonly assetId?: string; readonly snapshot?: unknown; readonly error?: unknown }
const WorkflowContext = createContext<Step>(1);
const WorkflowNavigateContext=createContext<(step:Step)=>void>(()=>{});
const WorkflowMediaContext = createContext<{record: ExportWorkflowRecord | null; enabled: boolean}>({record:null,enabled:false});
export function ExportWorkflowBack(){const navigate=useContext(WorkflowNavigateContext),{t}=useI18n();return <WorkbenchButton variant="ghost" onClick={()=>navigate(2)} data-testid="export-workflow-back">{t('redesign.export.previous')}</WorkbenchButton>;}
export const useExportWorkflowStep = () => useContext(WorkflowContext);
export const useExportWorkflowMedia = () => useContext(WorkflowMediaContext);
export function ExportWorkflowSection({ steps, children, className = '' }: { steps: readonly Step[]; children: ReactNode; className?: string }) {
  const step = useContext(WorkflowContext), visible = steps.includes(step);
  return <div className={`export-workflow-section ${className}`} hidden={!visible} inert={!visible}>{children}</div>;
}
export interface ExportWorkflowProps {
  preview?: ReactNode; children: ReactNode; resultDetails?: ReactNode; phase: string; attempted?: boolean; exportBusy?: boolean; pendingExport?: boolean;
  checkAction?:ReactNode; settingsEstimate?:ReactNode;
  /** Replaces the settings step's Next button, e.g. when the settings choose a different kind of export. */
  nextAction?:ReactNode;
  record?: ExportWorkflowRecord | null; projectId?: string | null; activity?: ExportActivity | null; output?: ExportOutput | null;
  onTasks?: () => void; onRecheck?: () => void; canCheck?: boolean; downloadEnabled?: boolean; fileRecoveryEnabled?:boolean; reviewVersion?: number;
  onCancel?: () => unknown; cancelBusy?: boolean; onClose?: () => void; onHistory?: () => void; onReexport?: () => void;
}
/** This shell retains presentation only. App owns the exact preflight binding,
 * fixed export identity, observations, cancellation and durable receipt. */
export default function ExportWorkflow({ preview, children, phase, attempted, exportBusy, pendingExport, record, projectId, activity, output, resultDetails, onTasks, onRecheck, canCheck, downloadEnabled = true, fileRecoveryEnabled=true, reviewVersion = 0, onCancel, cancelBusy, onClose, onHistory, onReexport,checkAction,settingsEstimate,nextAction }: ExportWorkflowProps) {
  const { t, formatNumber } = useI18n(), confirm = useConfirmation(), visible=useWorkspaceVisibility();
  const [step, setStep] = useState<Step>(1), [confirming,setConfirming]=useState(false);
  const owner=useMemo(()=>({}),[projectId,record?.id,visible]);
  const previousReview = useRef(reviewVersion), cancelFlight=useRef(false), alive=useRef(true);
  const current = useRef({ phase, attempted, exportBusy, pendingExport, record, projectId, visible, cancelBusy,owner,onCancel }); current.current = { phase, attempted, exportBusy, pendingExport, record, projectId, visible, cancelBusy,owner,onCancel };
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const active = attempted || Boolean(record), succeeded = Boolean(record&&['succeeded','completed','ready'].includes(record.status));
  const failed=record?.status==='failed'||record?.status==='cancelled';
  const cancelled=record?.status==='cancelled'||Boolean(record?.error&&typeof record.error==='object'&&'code' in record.error&&record.error.code==='EXPORT_CANCELLED');
  const observed=activity&&activity.exportId===record?.id&&activity.projectId===projectId?activity:null;
  const ownedOutput=downloadEnabled&&output&&output.exportId===record?.id&&output.projectId===projectId?output:null;
  const progress=observed?.progress??null, stages=['queued','preparing','encoding','finalizing'] as const;
  const stage=stages.find(value=>value===observed?.stage)??(record?.status==='queued'?'queued':null), stageIndex=stages.findIndex(value=>value===stage);
  useEffect(()=>{setStep(1);},[projectId]);
  useEffect(() => { if (active) setStep(succeeded ? 5 : 4); }, [active, succeeded, record?.id]);
  useEffect(() => { if (!active && phase === 'checking') setStep(1); }, [active, phase]);
  useEffect(() => { if (previousReview.current !== reviewVersion) { previousReview.current = reviewVersion; setStep(1); } }, [reviewVersion]);
  useEffect(() => { if (!active && phase === 'stale' && step === 3) setStep(2); }, [active, phase, step]);
  const checked = phase === 'ready' || phase === 'incomplete';
  const choose = (next: Step) => { const state = current.current; if (state.exportBusy || state.pendingExport || state.attempted) return; if (next < 3 || next === 3 && ['ready', 'incomplete'].includes(state.phase)) setStep(next); };
  async function cancel(){
    const captured=current.current;
    if(captured.owner!==owner||!captured.onCancel||!captured.visible||!captured.record||!['queued','running'].includes(captured.record.status)||captured.cancelBusy||cancelFlight.current)return;
    cancelFlight.current=true;setConfirming(true);
    try{
      if(!await confirm(message('redesign.export.cancelConfirmation')))return;
      const latest=current.current;
      if(alive.current&&latest.owner===captured.owner&&latest.visible&&latest.projectId===captured.projectId&&latest.record?.id===captured.record.id&&['queued','running'].includes(latest.record.status)&&!latest.cancelBusy&&latest.onCancel)await latest.onCancel();
    }finally{cancelFlight.current=false;if(alive.current)setConfirming(false);}
  }
  const downloadable=downloadEnabled&&succeeded&&record&&(record.url||record.assetId);
  return <WorkflowContext.Provider value={step}><WorkflowNavigateContext.Provider value={choose}><WorkflowMediaContext.Provider value={{record:record??null,enabled:Boolean(downloadable)}}><div className="export-workflow" data-testid="export-workflow" data-step={step}>
    <aside className="export-workflow-preview">{preview}</aside>
    <div className="export-workflow-main">
      <ol className="export-workflow-steps" aria-label={t('redesign.export.steps')}>
        {([1, 2, 3, 4, 5] as const).map(value => <li key={value} data-current={value === step} data-complete={value < step}><button type="button" aria-current={value === step ? 'step' : undefined} disabled={Boolean(active || exportBusy || pendingExport) || value > 3 || value === 3 && !checked} onClick={() => choose(value)}><span>{value < step ? <WorkbenchIcon name="check" size={12} /> : value}</span>{t(`redesign.export.step${value}`)}</button></li>)}
      </ol>
      <div className="export-workflow-retained" hidden={step > 3} inert={step > 3}>{children}</div>
      <section className={`export-workflow-result ${succeeded?'is-complete':''}`} hidden={step < 4} inert={step < 4} data-testid="export-workflow-result" aria-live="polite">
        <div className="export-workflow-result-body">
          <div className={`export-workflow-result-heading ${succeeded?'is-complete':''}`}><span className={`export-workflow-result-symbol ${succeeded ? 'is-success' : ''}`} aria-hidden="true"><WorkbenchIcon name={succeeded ? 'check' : failed ? 'warning' : 'upload'} size={24} /></span><div><h2>{t(succeeded ? 'redesign.export.complete' : cancelled?'redesign.export.cancelled':failed ? 'redesign.export.failed' : pendingExport && !record ? 'redesign.export.unknown' : 'redesign.export.running')}</h2>{resultDetails&&<div className="export-workflow-result-details" data-testid="export-workflow-result-details">{resultDetails}</div>}</div></div>
          {!succeeded&&!failed&&<div className="export-workflow-activity" data-testid="export-workflow-activity"><div className="export-progress-heading"><span>{stage?t(`redesign.export.stage.${stage}`):t('redesign.export.processing')}</span><output data-testid="export-workflow-progress">{progress===null?t('redesign.export.indeterminate'):t('redesign.export.progress',{progress:Math.round(progress)})}</output></div>{progress===null?<div className="export-indeterminate-progress" role="progressbar" aria-label={t('redesign.export.step4')} data-testid="export-workflow-indeterminate"><span/></div>:<WorkbenchProgress value={progress} label={t('redesign.export.step4')} />}{observed&&<p>{t('redesign.export.elapsed',{seconds:formatNumber(Math.floor(observed.elapsedSeconds))})}</p>}<ol className="export-stage-list">{stages.map((value,index)=><li key={value} data-state={stageIndex<0?'pending':index<stageIndex?'complete':index===stageIndex?'active':'pending'}><span className={index===stageIndex?'spinner':''}>{index<stageIndex?<WorkbenchIcon name="check" size={14}/>:null}</span><strong>{t(`redesign.export.stage.${value}`)}</strong><small>{t(index<stageIndex?'redesign.export.stageDone':index===stageIndex?'redesign.export.processing':'redesign.export.stageWaiting')}</small></li>)}</ol></div>}
          <p className="export-workflow-background-note">{t(succeeded?'redesign.export.completeHelp':cancelled?'redesign.export.cancelledHelp':'redesign.export.closeKeepsTask')}</p>
          {succeeded&&ownedOutput&&<p className="export-completed-specs">{t('redesign.export.fileSize',{size:formatNumber(ownedOutput.sizeBytes/1024/1024,{maximumFractionDigits:1})})}{observed?` · ${t('redesign.export.elapsed',{seconds:formatNumber(Math.floor(observed.elapsedSeconds))})}`:''}</p>}
          {downloadable&&record&&projectId?<ExportFileActions projectId={projectId} exportId={record.id} downloadHref={record.url||`/media/${record.assetId}`} output={ownedOutput} disabled={!fileRecoveryEnabled} detailed/>:downloadable&&record?<a className="wb-button wb-button-primary" href={record.url||`/media/${record.assetId}`} download data-testid="export-workflow-download">{t('export.history.download')}</a>:null}
          {!succeeded&&onTasks&&<WorkbenchButton onClick={onTasks} data-testid="export-workflow-tasks">{t('redesign.export.viewTasks')}</WorkbenchButton>}
        </div>
        <footer className="export-workflow-result-actions">
          {succeeded?<>{onHistory&&<WorkbenchButton variant="ghost" onClick={onHistory} data-testid="export-workflow-history">{t('export.workspace.history')}</WorkbenchButton>}{onReexport&&<WorkbenchButton variant="ghost" onClick={onReexport} data-testid="export-workflow-another">{t('redesign.export.another')}</WorkbenchButton>}{onClose&&<WorkbenchButton onClick={onClose}>{t('redesign.export.close')}</WorkbenchButton>}</>:<>{onCancel&&!failed&&record&&<WorkbenchButton variant="danger-ghost" disabled={Boolean(cancelBusy||confirming)||!['queued','running'].includes(record.status)} onClick={()=>{void cancel();}} data-testid="export-workflow-cancel">{t('redesign.export.cancel')}</WorkbenchButton>}{onClose&&!failed&&<WorkbenchButton onClick={onClose} data-testid="export-workflow-background">{t('redesign.export.background')}</WorkbenchButton>}{onRecheck&&failed&&<WorkbenchButton variant="ghost" disabled={!canCheck||Boolean(exportBusy||pendingExport)} onClick={()=>{setStep(1);onRecheck();}} data-testid="export-workflow-recheck">{t('export.preflight.check')}</WorkbenchButton>}</>}
        </footer>
      </section>
      <footer className="export-workflow-navigation" hidden={step > 2} inert={step > 2}>
        {step===2&&settingsEstimate}{checkAction&&<div className="export-workflow-check-action">{checkAction}</div>}
        {step===1&&onClose&&<WorkbenchButton variant="ghost" onClick={onClose}>{t('redesign.export.close')}</WorkbenchButton>}{step === 2 && <WorkbenchButton variant="ghost" onClick={() => choose(1)}>{t('redesign.export.previous')}</WorkbenchButton>}
        {step === 2 && nextAction ? nextAction : <WorkbenchButton variant="primary" disabled={!checked || Boolean(active || exportBusy || pendingExport)} onClick={() => choose(step === 1 ? 2 : 3)} data-testid="export-workflow-next">{t(step === 1 ? 'redesign.export.nextSettings' : 'redesign.export.nextConfirm')}</WorkbenchButton>}
      </footer>
    </div>
  </div></WorkflowMediaContext.Provider></WorkflowNavigateContext.Provider></WorkflowContext.Provider>;
}
