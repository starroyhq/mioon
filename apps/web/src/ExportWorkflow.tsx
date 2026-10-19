import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
import { WorkbenchButton, WorkbenchProgress } from '@mioon/ui/components/workbench-controls';
import { useI18n } from './i18n/I18nProvider.tsx';
import './export-workflow.css';

type Step = 1 | 2 | 3 | 4 | 5;
interface RecordView { readonly id: string; readonly status: string; readonly progress?: number; readonly url?: string; readonly assetId?: string }
const WorkflowContext = createContext<Step>(1);
export function ExportWorkflowSection({ steps, children, className = '' }: { steps: readonly Step[]; children: ReactNode; className?: string }) {
  const step = useContext(WorkflowContext), visible = steps.includes(step);
  return <div className={`export-workflow-section ${className}`} hidden={!visible} inert={!visible}>{children}</div>;
}
/** This shell only chooses which retained presentation is visible. Checks and
 * submissions still use App's exact preflight binding and durable receipt. */
export default function ExportWorkflow({ preview, children, phase, attempted, exportBusy, pendingExport, record, onTasks, onRecheck, canCheck, downloadEnabled = true, reviewVersion = 0 }: {
  preview?: ReactNode; children: ReactNode; phase: string; attempted?: boolean; exportBusy?: boolean; pendingExport?: boolean;
  record?: RecordView | null; onTasks?: () => void; onRecheck?: () => void; canCheck?: boolean; downloadEnabled?: boolean; reviewVersion?: number;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>(1);
  const previousReview = useRef(reviewVersion);
  const current = useRef({ phase, attempted, exportBusy, pendingExport }); current.current = { phase, attempted, exportBusy, pendingExport };
  const active = exportBusy || pendingExport || attempted;
  const succeeded = record?.status === 'succeeded' || record?.status === 'completed' || record?.status === 'ready';
  useEffect(() => { if (active) setStep(succeeded ? 5 : 4); }, [active, succeeded, record?.id]);
  useEffect(() => { if (!active && phase === 'checking') setStep(1); }, [active, phase]);
  useEffect(() => { if (previousReview.current !== reviewVersion) { previousReview.current = reviewVersion; setStep(1); } }, [reviewVersion]);
  useEffect(() => { if (!active && phase === 'stale' && step === 3) setStep(2); }, [active, phase, step]);
  const checked = phase === 'ready' || phase === 'incomplete';
  const choose = (next: Step) => { const state = current.current; if (state.exportBusy || state.pendingExport || state.attempted) return; if (next < 3 || next === 3 && ['ready', 'incomplete'].includes(state.phase)) setStep(next); };
  return <WorkflowContext.Provider value={step}><div className="export-workflow" data-testid="export-workflow" data-step={step}>
    <aside className="export-workflow-preview">{preview}</aside>
    <div className="export-workflow-main">
      <ol className="export-workflow-steps" aria-label={t('redesign.export.steps')}>
        {([1, 2, 3, 4, 5] as const).map(value => <li key={value} data-current={value === step} data-complete={value < step}><button type="button" aria-current={value === step ? 'step' : undefined} disabled={Boolean(active) || value > 3 || value === 3 && !checked} onClick={() => choose(value)}><span>{value < step ? <WorkbenchIcon name="check" size={12} /> : value}</span>{t(`redesign.export.step${value}`)}</button></li>)}
      </ol>
      <div className="export-workflow-retained" hidden={step > 3} inert={step > 3}>{children}</div>
      <section className="export-workflow-result" hidden={step < 4} inert={step < 4} data-testid="export-workflow-result" aria-live="polite">
        <span className={`export-workflow-result-symbol ${succeeded ? 'is-success' : ''}`} aria-hidden="true">{<WorkbenchIcon name={succeeded ? 'check' : record?.status === 'failed' ? 'warning' : 'upload'} size={24} />}</span>
        <h2>{t(succeeded ? 'redesign.export.complete' : record?.status === 'failed' ? 'redesign.export.failed' : pendingExport && !record ? 'redesign.export.unknown' : 'redesign.export.running')}</h2>
        {!succeeded && record?.status !== 'failed' && <WorkbenchProgress value={record?.progress ?? 0} label={t('redesign.export.step4')} />}
        <p>{t('redesign.export.closeKeepsTask')}</p>
        {downloadEnabled && succeeded && record && (record.url || record.assetId) && <a className="wb-button wb-button-primary" href={record.url || `/media/${record.assetId}`} download data-testid="export-workflow-download">{t('export.history.download')}</a>}
        {onTasks && <WorkbenchButton onClick={onTasks} data-testid="export-workflow-tasks">{t('redesign.export.viewTasks')}</WorkbenchButton>}
        {onRecheck && <WorkbenchButton variant="ghost" disabled={!canCheck || Boolean(exportBusy || pendingExport) || Boolean(record && !['failed', 'succeeded', 'completed', 'ready', 'cancelled'].includes(record.status))} onClick={() => { setStep(1); onRecheck(); }} data-testid="export-workflow-recheck">{t('export.preflight.check')}</WorkbenchButton>}
      </section>
      <footer className="export-workflow-navigation" hidden={step > 2} inert={step > 2}>
        {step === 2 && <WorkbenchButton variant="ghost" onClick={() => choose(1)}>{t('redesign.export.previous')}</WorkbenchButton>}
        <WorkbenchButton variant="primary" disabled={!checked || Boolean(active)} onClick={() => choose(step === 1 ? 2 : 3)} data-testid="export-workflow-next">{t(step === 1 ? 'redesign.export.nextSettings' : 'redesign.export.nextConfirm')}</WorkbenchButton>
      </footer>
    </div>
  </div></WorkflowContext.Provider>;
}
