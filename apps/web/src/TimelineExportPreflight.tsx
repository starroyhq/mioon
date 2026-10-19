import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.tsx';
import { preflightErrorMessage, preflightIssueMessage, exportCapabilityMessage } from './export-preflight-state.ts';
import type { TimelineExportSettings as ExportSettings } from '@mioon/contracts/timeline-export-float';
import type { ReactNode } from 'react';
import type { DisplayMessage, MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';

type Translator = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
const pass = <T,>(value: unknown): T => value as T;
export interface PreflightIssueView { code: string; severity: string; assetId?: string | null; clipId?: string | null; [key: string]: unknown }
export interface PreflightSummaryView { deliveryName?: unknown; width?: number; height?: number; fps?: number; delivery?: { effective?: { width?: number; height?: number; fps?: number } } | null; exportRange?: unknown; durationFrames: number; trackCount?: number; clipCount?: number; assetCount?: number; visualClipCount?: number; audibleClipCount?: number; mutedTrackCount?: number; hiddenVideoTrackCount?: number; [key: string]: unknown }
export interface PreflightReportView { summary?: PreflightSummaryView | null; timelineRevision?: unknown; issues: readonly PreflightIssueView[]; checkedAt: string; checks: { subtitles?: { fontVerified?: boolean } | null; checkedAssets: number; totalAssets: number; bytesHashed: number }; [key: string]: unknown }
export interface PreflightStateView { phase?: string; report?: PreflightReportView | null; binding?: unknown; uncheckedIntent?: unknown; attempted?: boolean; capabilityPhase?: string; error?: boolean; errorCode?: string | null; checkingStep?: string; [key: string]: unknown }
export interface TimelineExportPreflightProps {
  preview: ReactNode; recovery: ReactNode; state?: PreflightStateView | null; projectName?: string | null;
  timeline?: { durationFrames?: number; clips?: readonly unknown[]; [key: string]: unknown } | null;
  exportSettings?: ExportSettings | null; settingsDisabled?: boolean; onSettingsChange: (value: ExportSettings) => unknown;
  deliveryName?: string; deliveryNameError?: unknown; deliveryNameDisabled?: boolean; onDeliveryNameChange: (value: string) => unknown;
  rangeDraft?: unknown; exportRange?: unknown; rangeError?: unknown; rangeDisabled?: boolean; onRangeChange: (value: unknown) => unknown;
  canCheck?: boolean; exportBusy?: boolean; pendingExport?: boolean; dirty?: boolean; onCheck: () => unknown;
  onExport: (binding: unknown) => unknown; onUncheckedExport: (intent: unknown) => unknown; renderRecord?: unknown;
  onTasks: () => unknown; downloadEnabled?: boolean; reviewVersion?: unknown;
}
const bytesLabel = (bytes: number): string => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

import ExportWorkflow, { ExportWorkflowSection } from './ExportWorkflow.tsx';
import ExportRangeControls from './ExportRangeControls.tsx';
import ExportRangeSummary from './ExportRangeSummary.tsx';
import TimelineExportSettings from './TimelineExportSettings.tsx';
import TimelineDeliveryName, { TimelineDeliveryNameSnapshot } from './TimelineDeliveryName.tsx';

// Presentation only: the parent owns the saved context, explicit read, and
// durable render submission. Hidden tabs retain this view without starting work.
export default function TimelineExportPreflight({ preview, recovery, state, projectName, timeline, exportSettings, settingsDisabled, onSettingsChange, deliveryName = '', deliveryNameError, deliveryNameDisabled, onDeliveryNameChange, rangeDraft, exportRange, rangeError, rangeDisabled, onRangeChange, canCheck, exportBusy, pendingExport, dirty, onCheck, onExport, onUncheckedExport, renderRecord, onTasks, downloadEnabled, reviewVersion }: TimelineExportPreflightProps): React.ReactElement {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const phase = state?.phase || 'idle', report = state?.report ?? null, summary = report?.summary;
  const oldReport = Boolean(report && ['checking', 'stale', 'error'].includes(phase));
  const canExport = Boolean(state?.binding && ['ready', 'incomplete'].includes(phase) && !exportBusy && !pendingExport && !state.attempted);
  const canExportUnchecked = Boolean(state?.uncheckedIntent && phase === 'incomplete' && !exportBusy && !pendingExport && !state.attempted);
  return <ExportWorkflow preview={preview} phase={phase} attempted={state?.attempted} exportBusy={exportBusy} pendingExport={pendingExport} record={pass(renderRecord)} onTasks={onTasks} onRecheck={onCheck} canCheck={canCheck} downloadEnabled={downloadEnabled} reviewVersion={pass(reviewVersion)}><aside className="export-preflight" data-testid="export-preflight" data-phase={phase} aria-label={t('export.preflight.label')}>
    <header className="export-preflight-heading"><div><h2>{t('export.preflight.title')}</h2><p title={projectName ?? undefined}>{projectName || t('export.preflight.selectProject')}</p></div><Icon name="info" size={15} /></header>
    <div className="export-preflight-body">
      <ExportWorkflowSection steps={[1, 2]}>{recovery}</ExportWorkflowSection>
      <ExportWorkflowSection steps={[2]}><TimelineDeliveryName value={deliveryName} error={pass(deliveryNameError)} disabled={deliveryNameDisabled || settingsDisabled || exportBusy || pendingExport} onChange={onDeliveryNameChange} />
      <ExportRangeControls draft={pass(rangeDraft)} value={pass(exportRange)} durationFrames={timeline?.durationFrames} error={pass(rangeError)} disabled={rangeDisabled || settingsDisabled || exportBusy || pendingExport} onChange={onRangeChange} />
      <TimelineExportSettings timeline={timeline} value={exportSettings} disabled={settingsDisabled || exportBusy || pendingExport} onChange={onSettingsChange} /></ExportWorkflowSection>
      <ExportWorkflowSection steps={[1, 3]}>
      {exportSettings && <div className={`export-capability-status is-${state?.capabilityPhase || 'idle'}`} data-testid="export-capability-status" data-status={state?.capabilityPhase || 'idle'} role="status" aria-live="polite"><strong>{t('export.preflight.capability')}</strong><p>{exportCapabilityMessage(state?.capabilityPhase || 'idle', locale)}</p></div>}
      <details className="export-preflight-scope" data-testid="preflight-scope-details"><summary>{t('export.preflight.scopeTitle')}</summary><p>{t('export.preflight.scope')}</p></details>
      {dirty && <p className="export-preflight-draft" data-testid="preflight-unsaved">{t('export.preflight.unsaved')}</p>}
      <div className={`export-preflight-status is-${phase}`} role="status" aria-live="polite"><span>{phase === 'checking' && <span className="spinner" />}{t(`export.preflight.phase.${phase}` as MessageKey)}</span>{report && <small>{t('export.preflight.snapshotRevision', { label: t(oldReport ? 'export.preflight.last' : 'export.preflight.snapshot'), revision: report.timelineRevision as string | number })}</small>}</div>
      {state?.error && <p className="notice error" role="alert">{preflightErrorMessage({ code: state.errorCode }, locale)}</p>}
      {Array.isArray(timeline?.clips) && timeline.clips.length === 0 && <p className="notice warning" data-testid="preflight-empty-timeline">{t('export.preflight.empty')}</p>}
      {phase === 'idle' && <p className="export-preflight-empty">{t('export.preflight.idleHelp')}</p>}
      {phase === 'stale' && <p className="notice warning">{t('export.preflight.stale')}</p>}
      {oldReport && <p className="export-preflight-note">{t('export.preflight.oldHelp')}</p>}
      {report && <div className={oldReport ? 'export-preflight-report is-old' : 'export-preflight-report'} data-testid="preflight-report">
        {report.issues.length > 0 && <><h3 className="sr-only">{t('export.preflight.attention')}</h3><ul className="export-preflight-issues" data-testid="preflight-issues">{report.issues.map((issue, index) => <li key={`${issue.code}:${issue.assetId || issue.clipId || index}`} className={`is-${issue.severity}`}><span>{issue.severity === 'error' ? t('export.preflight.blocking') : t('export.preflight.warning')}</span><p>{issue.code==='SUBTITLE_RESOURCE_UNAVAILABLE'?t('export.preflight.subtitleUnavailable'):preflightIssueMessage(issue, locale) as string}</p><small>{issue.code}{issue.assetId && t('export.preflight.assetRef', { id: issue.assetId.slice(0, 8) })}{issue.clipId && t('export.preflight.clipRef', { id: issue.clipId.slice(0, 8) })}</small></li>)}</ul></>}
        <p className="export-preflight-checked"><time dateTime={report.checkedAt}>{formatDate(report.checkedAt, { dateStyle: 'medium', timeStyle: 'medium' })}</time></p>
        {summary && <><h3>{t('export.preflight.output')}</h3><dl className="export-preflight-summary">
          <TimelineDeliveryNameSnapshot value={summary.deliveryName} />
          <div><dt>{t('export.preflight.composition')}</dt><dd>{summary.width} × {summary.height} · {summary.fps} fps</dd></div>
          {summary.delivery && <div><dt>{t('export.preflight.checkedOutput')}</dt><dd>{summary.delivery.effective?.width} × {summary.delivery.effective?.height} · {summary.delivery.effective?.fps} fps</dd></div>}
          <div><dt>{summary.exportRange ? t('export.preflight.fullDuration') : t('export.preflight.duration')}</dt><dd>{t('export.preflight.durationValue', { seconds: formatNumber(summary.durationFrames / (summary.fps as number), { minimumFractionDigits: 2, maximumFractionDigits: 2 }), frames: formatNumber(summary.durationFrames) })}</dd></div>
          <div><dt>{t('export.preflight.counts')}</dt><dd>{summary.trackCount} / {summary.clipCount} / {summary.assetCount}</dd></div>
          <div><dt>{t('export.preflight.enabled')}</dt><dd>{summary.visualClipCount} / {summary.audibleClipCount}</dd></div>
          <div><dt>{t('export.preflight.disabled')}</dt><dd>{summary.mutedTrackCount} / {summary.hiddenVideoTrackCount}</dd></div>
        </dl><ExportRangeSummary input={summary} durationFrames={summary.durationFrames} label={t('export.preflight.checkedRange')} testId="preflight-export-range" /></>}
        {report.checks.subtitles&&<p className="export-preflight-note" data-testid="preflight-subtitle-scope">{t('export.preflight.subtitleScope', { status: t(report.checks.subtitles.fontVerified ? 'export.preflight.fontVerified' : 'export.preflight.fontUnverified') })}</p>}
        {Boolean(summary?.exportRange) && <p className="export-preflight-note" data-testid="preflight-range-source-scope">{t('export.preflight.rangeScope')}</p>}
        <h3>{t('export.preflight.sourceScope')}</h3><p className="export-preflight-note">{t('export.preflight.checkedAssets', { checked: formatNumber(report.checks.checkedAssets), total: formatNumber(report.checks.totalAssets), bytes: bytesLabel(report.checks.bytesHashed) })}</p>
        <p className="export-preflight-note">{t('export.preflight.limitedChecks')}</p>

      </div>}
      {phase === 'incomplete' && <p className="notice warning" data-testid="preflight-incomplete-warning">{t('export.preflight.incompleteWarning')}{state?.binding ? t('export.preflight.tryBound') : state?.uncheckedIntent ? t('export.preflight.tryUnchecked') : t('export.preflight.noSnapshot')}</p>}
      {pendingExport && <p className="notice warning">{t('export.preflight.pending')}</p>}
      {Boolean(state?.attempted) && <p className="export-preflight-note" role="status">{t('export.preflight.attempted')}</p>}
      <p className="export-preflight-note">{t('export.preflight.encodingScope')}</p>
      <p className="export-preflight-note">{t('export.preflight.limits')}</p></ExportWorkflowSection>
    </div>
    <footer className="export-preflight-actions"><ExportWorkflowSection steps={[1, 2]}><Button variant="ghost" className="button" data-testid="preflight-check" disabled={!canCheck || Boolean(deliveryNameError) || Boolean(rangeError) || phase === 'checking' || exportBusy} onClick={onCheck}><Icon name="refresh" size={14} />{phase === 'checking' ? state?.checkingStep === 'capability' ? t('export.preflight.checkCapability') : t('export.preflight.checkAssets') : t('export.preflight.check')}</Button></ExportWorkflowSection><ExportWorkflowSection steps={[3]}>{!state?.uncheckedIntent && <Button variant="ghost" className={`button ${phase === 'incomplete' ? 'preflight-attempt' : 'primary'}`} data-testid="preflight-export" disabled={!canExport} onClick={() => onExport((state as PreflightStateView).binding)}><Icon name="download" size={14} />{exportBusy ? t('export.preflight.submitting') : phase === 'incomplete' ? t('export.preflight.attempt') : t('export.preflight.confirm')}</Button>}{Boolean(state?.uncheckedIntent) && <Button variant="ghost" className="button preflight-attempt" data-testid="preflight-export-unchecked" disabled={!canExportUnchecked} onClick={() => onUncheckedExport((state as PreflightStateView).uncheckedIntent)}><Icon name="download" size={14} />{t('export.preflight.unchecked')}</Button>}</ExportWorkflowSection></footer>
  </aside></ExportWorkflow>;
}
