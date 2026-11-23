import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.tsx';
import { preflightErrorMessage, preflightIssueMessage, exportCapabilityMessage } from './export-preflight-state.ts';
import type { TimelineExportSettings as ExportSettings } from '@mioon/contracts/timeline-export-float';
import type { TimelineOutputRatio } from '../../../packages/contracts/src/timeline-output-geometry.ts';
import type { ReactNode } from 'react';
import type { DisplayMessage, MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';

type Translator = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
const pass = <T,>(value: unknown): T => value as T;
export interface PreflightIssueView { code: string; severity: string; assetId?: string | null; clipId?: string | null; [key: string]: unknown }
export interface PreflightSummaryView { deliveryName?: unknown; width?: number; height?: number; fps?: number; delivery?: { effective?: { width?: number; height?: number; fps?: number } } | null; exportRange?: unknown; durationFrames: number; trackCount?: number; clipCount?: number; assetCount?: number; visualClipCount?: number; audibleClipCount?: number; mutedTrackCount?: number; hiddenVideoTrackCount?: number; [key: string]: unknown }
export interface PreflightReportView { summary?: PreflightSummaryView | null; timelineRevision?: unknown; issues: readonly PreflightIssueView[]; checkedAt: string; checks: { subtitles?: { fontVerified?: boolean } | null; checkedAssets: number; totalAssets: number; bytesHashed: number }; [key: string]: unknown }
export interface PreflightStateView { phase?: string; report?: PreflightReportView | null; binding?: unknown; uncheckedIntent?: unknown; attempted?: boolean; capabilityPhase?: string; error?: boolean; errorCode?: string | null; checkingStep?: string; [key: string]: unknown }
export interface PendingExportCheckView { kind: 'not_executed' | 'not_executed_reason' | 'timeline_changed' | 'unavailable'; errorCode?: string }
/** The settings step's content choice, offered once the timeline has clips. App owns the value; this view stays stateless. */
export interface ExportContentChoice { value: 'timeline' | 'storyboard'; onChange: (value: 'timeline' | 'storyboard') => unknown; storyboardDisabledReason?: string | null; storyboardBusy?: boolean; onStoryboardExport: () => unknown }
export interface TimelineExportPreflightProps {
  contentChoice?: ExportContentChoice | null;
  preview: ReactNode; recovery: ReactNode; recoveryRequired?:boolean; loudness?:ReactNode; state?: PreflightStateView | null; projectName?: string | null;
  timeline?: { durationFrames?: number; clips?: readonly unknown[]; [key: string]: unknown } | null;
  exportSettings?: ExportSettings | null; settingsDisabled?: boolean; onSettingsChange: (value: ExportSettings) => unknown;
  aspectFrameRatio?: TimelineOutputRatio | null;
  deliveryName?: string; deliveryNameError?: unknown; deliveryNameDisabled?: boolean; onDeliveryNameChange: (value: string) => unknown;
  rangeDraft?: unknown; exportRange?: unknown; rangeError?: unknown; rangeDisabled?: boolean; onRangeChange: (value: unknown) => unknown;
  canCheck?: boolean; exportBusy?: boolean; pendingExport?: boolean; dirty?: boolean; onCheck: () => unknown;
  onExport: (binding: unknown) => unknown; onUncheckedExport: (intent: unknown) => unknown; renderRecord?: unknown;
  onTasks: () => unknown; downloadEnabled?: boolean; fileRecoveryEnabled?:boolean; reviewVersion?: unknown;
  projectId?:string|null; activity?:ExportActivity|null; output?:ExportOutput|null; onCancel?:()=>unknown; cancelBusy?:boolean; onClose?:()=>void; onHistory?:()=>void; onReexport?:()=>void; onLocateClip?:(clipId:string)=>void;
  pendingExportCheck?: PendingExportCheckView | null; onContinuePending?: ()=>unknown; onDiscardPending?: ()=>unknown; onRetryPending?: ()=>unknown;
}
import ExportWorkflow, { ExportWorkflowSection, ExportWorkflowBack } from './ExportWorkflow.tsx';
import ExportRangeControls from './ExportRangeControls.tsx';
import TimelineExportSettings from './TimelineExportSettings.tsx';
import ExportRangeSummary from './ExportRangeSummary.tsx';
import TimelineDeliveryName from './TimelineDeliveryName.tsx';
import { namedTimelineDeliveryHistory } from './export-delivery-state.ts';
import type {ExportActivity,ExportOutput} from '../../../packages/contracts/src/export-controls.ts';
import { exportRangeDescription } from './export-range-state.ts';
import { selectedExportDelivery } from './export-settings-state.ts';
import { exportHistoryDelivery, exportHistoryPicture } from './export-settings-state.ts';
import { displayTimelineFrame } from './timeline-removal.ts';
import './export-content-choice.css';

// Presentation only: the parent owns the saved context, explicit read, and
// durable render submission. Hidden tabs retain this view without starting work.
export default function TimelineExportPreflight({ contentChoice = null, preview, recovery,recoveryRequired=true,loudness, state, projectName, timeline, exportSettings, settingsDisabled, aspectFrameRatio, onSettingsChange, deliveryName = '', deliveryNameError, deliveryNameDisabled, onDeliveryNameChange, rangeDraft, exportRange, rangeError, rangeDisabled, onRangeChange, canCheck, exportBusy, pendingExport, dirty, onCheck, onExport, onUncheckedExport, renderRecord, onTasks, downloadEnabled,fileRecoveryEnabled, reviewVersion,projectId,activity,output,onCancel,cancelBusy,onClose,onHistory,onReexport,onLocateClip,pendingExportCheck,onContinuePending,onDiscardPending,onRetryPending }: TimelineExportPreflightProps): React.ReactElement {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const phase = state?.phase || 'idle', report = state?.report ?? null, summary = report?.summary;
  const oldReport = Boolean(report && ['checking', 'stale', 'error'].includes(phase));
  const canExport = Boolean(state?.binding && ['ready', 'incomplete'].includes(phase) && !exportBusy && !pendingExport && !state.attempted);
  const canExportUnchecked = Boolean(state?.uncheckedIntent && phase === 'incomplete' && !exportBusy && !pendingExport && !state.attempted);
  const resultRecord = renderRecord && typeof renderRecord === 'object' && !Array.isArray(renderRecord) ? renderRecord as Record<string, unknown> : null;
  const completedPicture = exportHistoryPicture(resultRecord);
  const completedDelivery = namedTimelineDeliveryHistory(resultRecord, exportHistoryDelivery(resultRecord));
  const draftOutput=selectedExportDelivery(timeline,exportSettings),range=exportRangeDescription({exportRange},timeline?.durationFrames);
  const durationSeconds=range?range.frames/30:(timeline?.durationFrames??0)/30;
  const estimatedSize=exportSettings?.rateControl.mode==='bitrate'&&durationSeconds>0?t('redesign.export.estimatedSize',{size:formatNumber((exportSettings.rateControl.targetKbps+128)*1000/8*durationSeconds/1024/1024,{maximumFractionDigits:1})}):t('redesign.export.sizeUnknown');
  const filename=typeof summary?.deliveryName==='string'?summary.deliveryName:deliveryName||t('recovery.delivery.defaultName');
  const checkAction=<Button variant="ghost" className="button" data-testid="preflight-check" disabled={!canCheck || Boolean(deliveryNameError) || Boolean(rangeError) || phase === 'checking' || exportBusy} onClick={onCheck}><Icon name="refresh" size={14} />{phase === 'checking' ? state?.checkingStep === 'capability' ? t('export.preflight.checkCapability') : t('export.preflight.checkAssets') : t('export.preflight.check')}</Button>;
  const settingsEstimate=<p className="export-estimate-inline" data-testid="export-estimate">{t('redesign.export.estimate')} {estimatedSize}</p>;
  // A storyboard draft skips the timeline settings, the timeline check and its estimate.
  const storyboard=contentChoice?.value==='storyboard',trackCount=Array.isArray(timeline?.tracks)?timeline.tracks.length:0,fps=typeof timeline?.fps==='number'?timeline.fps:30;
  // Two option cards in a radiogroup; the shared Button carries the radio role (no native radio input).
  const option=(value:'timeline'|'storyboard',children:ReactNode)=>contentChoice&&<Button variant="ghost" role="radio" aria-checked={(value==='storyboard')===storyboard} className={`export-content-option ${(value==='storyboard')===storyboard?'is-selected':''}`} data-testid={`export-content-${value}`} disabled={exportBusy||pendingExport} onClick={()=>contentChoice.onChange(value)}><span className="export-content-radio" aria-hidden="true" /><span className="export-content-copy">{children}</span></Button>;
  const choice=contentChoice&&<div className="export-content-choice" role="radiogroup" aria-label={t('export.content.title')} data-testid="export-content-choice"><h3>{t('export.content.title')}</h3>
    {option('timeline',<><strong><Icon name="film" size={14} />{t('export.content.timeline')}</strong><small>{t('export.content.timelineMeta',{count:timeline?.clips?.length??0,tracks:trackCount,duration:displayTimelineFrame(timeline?.durationFrames??0,fps)})}</small></>)}
    {option('storyboard',<><strong>{t('export.content.storyboard')}<span className="export-content-tag">{t('export.content.storyboardTag')}</span></strong>{storyboard&&contentChoice.storyboardDisabledReason&&<small className="is-blocked">{contentChoice.storyboardDisabledReason}</small>}</>)}
  </div>;
  const pendingReason = (code?: string): string => code === 'REVISION_CONFLICT' || code === 'PREFLIGHT_STALE' ? t('export.pending.reasonConflict')
    : code === 'EXPORT_BLOCKED' || code === 'PLACEHOLDER_CLIP' || code === 'EXPORT_RANGE_BOUNDS' ? t('export.pending.reasonBlocked')
      : t('export.pending.reasonGeneric');
  const pendingBanner = pendingExportCheck ? (() => {
    const kind = pendingExportCheck.kind;
    const title = kind === 'timeline_changed' ? t('export.pending.timelineChanged')
      : kind === 'unavailable' ? t('export.pending.unavailable')
        : kind === 'not_executed_reason' ? t('export.pending.notExecuted', {reason: pendingReason(pendingExportCheck.errorCode)})
          : t('export.pending.notStarted');
    return <div className="notice warning export-pending-export" data-testid="export-pending-recovery" data-kind={kind} role="status" aria-live="polite">
      <strong>{title}</strong>
      <div className="export-pending-actions">
        {kind === 'not_executed' && onContinuePending && <Button type="button" variant="outline" size="sm" data-testid="continue-pending-export" disabled={exportBusy} onClick={() => onContinuePending()}>{t('export.pending.continue')}</Button>}
        {(kind === 'not_executed' || kind === 'timeline_changed') && onDiscardPending && <Button type="button" variant="ghost" size="sm" data-testid="discard-pending-export" disabled={exportBusy} onClick={() => onDiscardPending()}>{t('export.pending.discard')}</Button>}
        {kind === 'unavailable' && onRetryPending && <Button type="button" variant="outline" size="sm" data-testid="retry-pending-export" disabled={exportBusy} onClick={() => onRetryPending()}>{t('export.pending.retry')}</Button>}
      </div>
    </div>;
  })() : null;
  const storyboardAction=contentChoice&&<Button variant="ghost" className="button primary" data-testid="export-storyboard-draft" disabled={Boolean(contentChoice.storyboardDisabledReason)||Boolean(contentChoice.storyboardBusy)} title={contentChoice.storyboardDisabledReason??undefined} onClick={()=>contentChoice.onStoryboardExport()}><Icon name="download" size={14} />{t('export.content.storyboardAction')}</Button>;
  return <ExportWorkflow nextAction={storyboard?storyboardAction:undefined} checkAction={storyboard?<ExportWorkflowSection steps={[1]}>{checkAction}</ExportWorkflowSection>:checkAction} settingsEstimate={storyboard?null:settingsEstimate} projectId={projectId} activity={activity} output={output} onCancel={onCancel} cancelBusy={cancelBusy} onClose={onClose} onHistory={onHistory} onReexport={onReexport} preview={preview} phase={phase} attempted={state?.attempted} exportBusy={exportBusy} pendingExport={pendingExport} record={pass(renderRecord)} resultDetails={resultRecord && <><strong>{completedDelivery?.name || t('recovery.delivery.defaultName')}</strong>{completedPicture && <span>{completedPicture.ratio} · {t('redesign.export.resultFormat', completedPicture)}</span>}</>} onTasks={onTasks} downloadEnabled={downloadEnabled} fileRecoveryEnabled={fileRecoveryEnabled} reviewVersion={pass(reviewVersion)}><aside className="export-preflight" data-testid="export-preflight" data-phase={phase} aria-label={t('export.preflight.label')}>
    <header className="export-preflight-heading"><div><h2>{t('export.preflight.title')}</h2><p title={projectName ?? undefined}>{projectName || t('export.preflight.selectProject')}</p></div><Icon name="info" size={15} /></header>
    <div className="export-preflight-body">
      <ExportWorkflowSection steps={[2]} className="export-settings-primary">{choice}<div className="export-timeline-settings" hidden={storyboard} inert={storyboard}><TimelineDeliveryName value={deliveryName} error={pass(deliveryNameError)} disabled={deliveryNameDisabled || settingsDisabled || exportBusy || pendingExport} onChange={onDeliveryNameChange} />
      <div className="export-settings-field export-destination-row"><label>{t('redesign.export.saveTo')}</label><output>{t('redesign.export.managedLocation')}</output></div>
      <TimelineExportSettings timeline={timeline} value={exportSettings} aspectFrameRatio={aspectFrameRatio} disabled={settingsDisabled || exportBusy || pendingExport} onChange={onSettingsChange} />
      <ExportRangeControls draft={pass(rangeDraft)} value={pass(exportRange)} durationFrames={timeline?.durationFrames} error={pass(rangeError)} disabled={rangeDisabled || settingsDisabled || exportBusy || pendingExport} onChange={onRangeChange} />
      {loudness&&<div className="export-settings-field export-loudness-row" data-testid="export-loudness-row"><span>{t('redesign.export.loudnessLabel')}</span><div>{loudness}</div></div>}</div></ExportWorkflowSection>
      <ExportWorkflowSection steps={[2]} className="export-settings-recovery"><details open={recoveryRequired} data-testid="export-recovery-details"><summary>{t('recovery.delivery.label')}</summary>{recovery}</details></ExportWorkflowSection>
      <ExportWorkflowSection steps={[1]}>
      {pendingBanner}
      <div className="export-check-result" data-state={phase} data-testid="export-check-result"><Icon name={phase==='ready'?'check':phase==='checking'?'refresh':'info'} size={17}/><strong>{t(`export.preflight.phase.${phase}` as MessageKey)}</strong>{report&&<span>{t('redesign.export.attentionCount',{count:report.issues.length})}</span>}</div>
      <h3 className="export-check-group-title">{t('redesign.export.encodingChecks')}</h3>
      {exportSettings && <div className={`export-capability-status is-${state?.capabilityPhase || 'idle'}`} data-testid="export-capability-status" data-status={state?.capabilityPhase || 'idle'} role="status" aria-live="polite"><strong>{t('export.preflight.capability')}</strong>{exportCapabilityMessage(state?.capabilityPhase || 'idle', locale) && <p>{exportCapabilityMessage(state?.capabilityPhase || 'idle', locale)}</p>}</div>}
      <div className="export-check-row"><Icon name="film" size={15}/><strong>{t('redesign.export.videoCodec')}</strong></div><div className="export-check-row"><Icon name="volume" size={15}/><strong>{t('redesign.export.audioCodec')}</strong></div>
      <h3 className="export-check-group-title">{t('redesign.export.mediaChecks')}</h3>
      {report&&<div className="export-check-row"><Icon name={report.checks.checkedAssets===report.checks.totalAssets?'check':'info'} size={15}/><strong>{t('redesign.export.assetCheckCount',{checked:report.checks.checkedAssets,total:report.checks.totalAssets})}</strong></div>}
      {dirty && <p className="export-preflight-draft" data-testid="preflight-unsaved">{t('export.preflight.unsaved')}</p>}
      <div className={`export-preflight-status is-${phase}`} role="status" aria-live="polite"><span>{phase === 'checking' && <span className="spinner" />}{t(`export.preflight.phase.${phase}` as MessageKey)}</span>{report && report.timelineRevision != null && <small>{t('export.preflight.snapshotRevision', { label: t(oldReport ? 'export.preflight.last' : 'export.preflight.snapshot'), revision: report.timelineRevision as string | number })}</small>}</div>
      {state?.error && <p className="notice error" role="alert">{preflightErrorMessage({ code: state.errorCode }, locale)}</p>}
      {Array.isArray(timeline?.clips) && timeline.clips.length === 0 && <p className="notice warning" data-testid="preflight-empty-timeline">{t('export.preflight.empty')}</p>}
      {phase === 'stale' && <p className="notice warning">{t('export.preflight.stale')}</p>}
      {report && <div className={oldReport ? 'export-preflight-report is-old' : 'export-preflight-report'} data-testid="preflight-report">
        {report.issues.length > 0 && <><h3 className="sr-only">{t('export.preflight.attention')}</h3><ul className="export-preflight-issues" data-testid="preflight-issues">{report.issues.map((issue, index) => <li key={`${issue.code}:${issue.assetId || issue.clipId || index}`} className={`is-${issue.severity}`}><span>{issue.severity === 'error' ? t('export.preflight.blocking') : t('export.preflight.warning')}</span><p>{issue.code==='SUBTITLE_RESOURCE_UNAVAILABLE'?t('export.preflight.subtitleUnavailable'):preflightIssueMessage(issue, locale) as string}</p>{issue.clipId&&onLocateClip&&<Button variant="ghost" className="button small" data-testid="preflight-locate-clip" onClick={()=>onLocateClip(issue.clipId as string)}>{t('redesign.export.locateClip')}</Button>}<small>{issue.code}{issue.assetId && t('export.preflight.assetRef', { id: issue.assetId.slice(0, 8) })}{issue.clipId && t('export.preflight.clipRef', { id: issue.clipId.slice(0, 8) })}</small></li>)}</ul></>}
        <p className="export-preflight-checked"><time dateTime={report.checkedAt}>{formatDate(report.checkedAt, { dateStyle: 'medium', timeStyle: 'medium' })}</time></p>
      </div>}
      {phase === 'incomplete' && <p className="notice warning" data-testid="preflight-incomplete-warning">{t('export.preflight.incompleteWarning')}{state?.binding ? t('export.preflight.tryBound') : state?.uncheckedIntent ? t('export.preflight.tryUnchecked') : t('export.preflight.noSnapshot')}</p>}
      {Boolean(state?.attempted) && <p className="export-preflight-note" role="status">{t('export.preflight.attempted')}</p>}
      </ExportWorkflowSection>
      <ExportWorkflowSection steps={[3]} className="export-confirmation">
        <div className="export-confirmation-metrics" data-testid="export-confirmation-metrics"><div><span>{t('redesign.export.sizeLabel')}</span><strong>{estimatedSize}</strong></div><div><span>{t('redesign.export.timeLabel')}</span><strong>—</strong></div><div><span>{t('export.preflight.duration')}</span><strong>{t('redesign.export.secondsShort',{seconds:formatNumber(durationSeconds,{maximumFractionDigits:2})})}</strong></div></div>
        <dl className="export-confirmation-details"><div><dt>{t('redesign.export.fileLabel')}</dt><dd>{filename}</dd></div><div><dt>{t('redesign.export.saveTo')}</dt><dd>{t('redesign.export.managedLocation')}</dd></div><div><dt>{t('redesign.export.formatLabel')}</dt><dd>{t('redesign.export.codecFormat')}</dd></div><div><dt>{t('export.settings.output')}</dt><dd>{summary?.delivery?.effective?t('redesign.export.pictureFormat',{dimensions:`${summary.delivery.effective.width} × ${summary.delivery.effective.height}`,fps:summary.delivery.effective.fps??30}):draftOutput?t('redesign.export.pictureFormat',{dimensions:draftOutput.dimensions,fps:30}):t('export.history.frozenUnavailable')}</dd></div><div><dt>{t('export.range.title')}</dt><dd><ExportRangeSummary input={summary??{exportRange}} durationFrames={summary?.durationFrames??timeline?.durationFrames} showWhole label={t('export.range.label')} testId="export-confirmation-range" /></dd></div><div><dt>{t('redesign.export.audioLabel')}</dt><dd>{t('redesign.export.audioCodec')}</dd></div></dl>
        {report&&report.issues.length>0&&<div className="export-confirmation-warnings" role="status">{report.issues.map((issue,index)=><div key={index}><Icon name="warning" size={15}/><p>{issue.code==='SUBTITLE_RESOURCE_UNAVAILABLE'?t('export.preflight.subtitleUnavailable'):preflightIssueMessage(issue,locale) as string}</p>{issue.clipId&&onLocateClip&&<Button variant="ghost" className="button small" onClick={()=>onLocateClip(issue.clipId as string)}>{t('redesign.export.locateClip')}</Button>}</div>)}</div>}
        {phase==='incomplete'&&<p className="notice warning">{t('export.preflight.incompleteWarning')}{state?.binding?t('export.preflight.tryBound'):state?.uncheckedIntent?t('export.preflight.tryUnchecked'):t('export.preflight.noSnapshot')}</p>}{phase==='stale'&&<p className="notice warning">{t('export.preflight.stale')}</p>}
      </ExportWorkflowSection>
    </div>
    <footer className="export-preflight-actions"><ExportWorkflowSection steps={[3]}><ExportWorkflowBack/>{!state?.uncheckedIntent && <Button variant="ghost" className={`button ${phase === 'incomplete' ? 'preflight-attempt' : 'primary'}`} data-testid="preflight-export" disabled={!canExport} onClick={() => onExport((state as PreflightStateView).binding)}><Icon name="download" size={14} />{exportBusy ? t('export.preflight.submitting') : phase === 'incomplete' ? t('export.preflight.attempt') : t('redesign.export.start')}</Button>}{Boolean(state?.uncheckedIntent) && <Button variant="ghost" className="button preflight-attempt" data-testid="preflight-export-unchecked" disabled={!canExportUnchecked} onClick={() => onUncheckedExport((state as PreflightStateView).uncheckedIntent)}><Icon name="download" size={14} />{t('export.preflight.unchecked')}</Button>}</ExportWorkflowSection></footer>
  </aside></ExportWorkflow>;
}
