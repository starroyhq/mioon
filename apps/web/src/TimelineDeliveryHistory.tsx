import { exportHistoryStatusMessage } from './export-display.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import type { ReactNode } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { hasInvalidExportRangeHistory } from './export-range-state.ts';
import ExportRangeSummary from './ExportRangeSummary.tsx';
import { exportHistoryPicture } from './export-settings-state.ts';
import { namedTimelineDeliveryHistory } from './export-delivery-state.ts';
import ExportSamplePeak from './ExportSamplePeak.tsx';
import type { ExportSamplePeakView } from './export-sample-peak-state.ts';
import ExportLoudness from './ExportLoudness.tsx';
import ExportFileActions from './ExportFileActions.tsx';
import type { ExportLoudnessView } from './export-loudness-state.ts';

export interface TimelineDeliveryHistoryProps {
  item: unknown;
  samplePeak?: ExportSamplePeakView;
  loudness?: ExportLoudnessView;
  frozenDelivery?: unknown;
  timelineRevision?: unknown;
  statusLabel: string;
  downloadEnabled?: boolean;
  fileRecoveryEnabled?: boolean;
  filmIcon?: ReactNode;
  downloadIcon?: ReactNode;
  onReexport?: () => void;
  reexportDisabled?: boolean;
  tableRow?:boolean;
  sizeBytes?:number;
}

/** Frozen timeline rows stay independent of today's project title/settings. */
export default function TimelineDeliveryHistory({ item, samplePeak, loudness, frozenDelivery, timelineRevision, statusLabel, downloadEnabled = true, fileRecoveryEnabled = true, filmIcon, downloadIcon, onReexport, reexportDisabled,tableRow=false,sizeBytes }: TimelineDeliveryHistoryProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const delivery = namedTimelineDeliveryHistory(item, frozenDelivery);
  if ((!delivery || hasInvalidExportRangeHistory(item))&&tableRow)return <tr data-testid="named-delivery-invalid"><td colSpan={6}><p className="notice warning">{t('export.history.invalidDelivery')}</p></td></tr>;
  if (!delivery || hasInvalidExportRangeHistory(item)) return <div className="export-card" data-testid="named-delivery-invalid"><div className="export-icon">{filmIcon}</div><div className="export-detail"><strong>{t('export.history.title')}</strong><p className="notice warning">{t('export.history.invalidDelivery')}</p></div></div>;
  const output = delivery.output;
  const picture = exportHistoryPicture(item as Record<string, unknown>);
  const sourceError=item&&typeof item==='object'&&'error' in item?item.error:null;
  const cancelled=Boolean(sourceError&&typeof sourceError==='object'&&'code' in sourceError&&sourceError.code==='EXPORT_CANCELLED');
  const projectId=item!==null&&typeof item==='object'&&'projectId' in item&&typeof item.projectId==='string'?item.projectId:'';
  const snapshot = item !== null && typeof item === 'object' && 'snapshot' in item ? item.snapshot : undefined;
  const reexport = onReexport && ['succeeded','failed','cancelled'].includes(delivery.status)
    ? <Button variant="ghost" className="button small" data-testid="export-history-reexport" disabled={reexportDisabled} onClick={onReexport}>{t('redesign.export.reexport')}</Button> : null;
  if(tableRow)return <tr className="export-history-row" data-testid="named-delivery-history" data-status={cancelled?'cancelled':delivery.status}><td><strong title={delivery.name} data-testid="delivery-history-name">{delivery.name}</strong>{delivery.error&&<small className="job-error">{t('export.history.safeError')}</small>}<details className="export-history-diagnostics"><summary>{t('redesign.export.details')}</summary><small>{t('export.history.timelineRevision',{revision:delivery.revision,snapshot:t(delivery.revision!==timelineRevision?'export.history.old':'export.history.current')})}</small>{output&&<small data-testid="export-history-encoding-details">{t(snapshot&&typeof snapshot==='object'&&Object.hasOwn(snapshot,'delivery')?'export.history.output':'export.history.legacyOutput',{dimensions:output.dimensions,fps:output.fps,rate:renderMessage(output.rateMessage)||t('export.history.legacyRate'),upscale:output.upscale?t('export.history.upscale'):''})}</small>}{(samplePeak||loudness)&&<><ExportSamplePeak exportId={delivery.id} samplePeak={samplePeak}/><ExportLoudness exportId={delivery.id} loudness={loudness}/></>}</details></td><td>{picture?<span data-testid="export-history-settings">{t('redesign.export.frozenPictureFormat',picture)}<small>{renderMessage(output?.rateMessage)}{output?.upscale?` · ${t('export.history.upscale')}`:''}</small></span>:<span>{t('export.history.frozenUnavailable')}</span>}<ExportRangeSummary input={snapshot} snapshot showWhole testId="export-history-range"/></td><td data-testid="export-history-size">{typeof sizeBytes==='number'&&Number.isSafeInteger(sizeBytes)&&sizeBytes>0?t('redesign.export.fileSize',{size:formatNumber(sizeBytes/1024/1024,{maximumFractionDigits:1})}):'—'}</td><td><time dateTime={delivery.createdAt}>{formatDate(delivery.createdAt,{dateStyle:'short',timeStyle:'short'})}</time></td><td><Badge className={`small-badge ${delivery.status==='failed'?'warn':'neutral'}`}>{cancelled?t('redesign.export.cancelled'):statusLabel}</Badge></td><td>{downloadEnabled&&delivery.downloadHref?<ExportFileActions projectId={projectId} exportId={delivery.id} downloadHref={delivery.downloadHref} disabled={!fileRecoveryEnabled||!projectId}/>:!reexport&&delivery.status!=='failed'?<span className="spinner"/>:null}{reexport}</td></tr>;
  return <div className="export-card" data-testid="named-delivery-history">
    <div className="export-icon">{filmIcon}</div>
    <div className="export-detail">
      <strong title={delivery.name} data-testid="delivery-history-name">{delivery.name}</strong>

      <span>{exportHistoryStatusMessage(delivery.status, locale)} · <time dateTime={delivery.createdAt}>{formatDate(delivery.createdAt, { dateStyle: 'medium', timeStyle: 'medium' })}</time></span>
      {delivery.error && <p className="job-error">{t('export.history.safeError')}</p>}
      <small>{t('export.history.timelineRevision', { revision: delivery.revision, snapshot: t(delivery.revision !== timelineRevision ? 'export.history.old' : 'export.history.current') })}</small>
      {(samplePeak || loudness) && <details className="export-history-diagnostics"><summary>{t('redesign.export.audioChecks')}</summary><ExportSamplePeak exportId={delivery.id} samplePeak={samplePeak} /><ExportLoudness exportId={delivery.id} loudness={loudness} /></details>}
      <ExportRangeSummary input={snapshot} snapshot testId="export-history-range" />
      {output ? <small className="export-frozen-settings" data-testid="export-history-settings">{t(snapshot && typeof snapshot === 'object' && Object.hasOwn(snapshot, 'delivery') ? 'export.history.output' : 'export.history.legacyOutput', { dimensions: output.dimensions, fps: output.fps, rate: renderMessage(output.rateMessage) || t('export.history.legacyRate'), upscale: output.upscale ? t('export.history.upscale') : '' })}</small> : <small>{t('export.history.frozenUnavailable')}</small>}
      {picture&&<small data-testid="export-history-picture">{t('redesign.export.frozenPictureFormat',picture)}</small>}
    </div>
    {reexport}
    {downloadEnabled && delivery.downloadHref
      ? <ExportFileActions projectId={projectId} exportId={delivery.id} downloadHref={delivery.downloadHref} disabled={!fileRecoveryEnabled||!projectId}/>
      : delivery.status === 'failed' ? <Badge className="small-badge warn">{t('export.history.failed')}</Badge> : <span className="spinner" />}
  </div>;
}
