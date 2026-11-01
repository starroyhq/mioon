import { exportHistoryStatusMessage } from './export-display.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React, {useState} from 'react';
import type { ReactElement } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Badge } from '@mioon/ui/components/badge';
import Icon from './icons.tsx';
import { statusText } from './api.ts';
import { exportHistoryDelivery } from './export-settings-state.ts';
import { hasNamedTimelineDelivery } from './export-delivery-state.ts';
import { hasInvalidExportRangeHistory } from './export-range-state.ts';
import ExportRangeSummary from './ExportRangeSummary.tsx';
import TimelineDeliveryHistory from './TimelineDeliveryHistory.tsx';
import ExportFileActions from './ExportFileActions.tsx';
import ExportSamplePeak from './ExportSamplePeak.tsx';
import ExportLoudness from './ExportLoudness.tsx';
import type { ExportSamplePeakView } from './export-sample-peak-state.ts';
import type { ExportLoudnessView } from './export-loudness-state.ts';

export interface ExportHistoryItem {
  id: string;
  projectId?: string | null;
  status?: string;
  createdAt: string;
  error?: unknown;
  mode?: string;
  purpose?: string;
  timelineRevision?: number | null;
  orderedVersionIds?: readonly string[];
  snapshot?: Record<string, unknown> | null;
  url?: string | null;
  assetId?: string | null;
  [key: string]: unknown;
}
export interface ExportHistoryListProps {
  orderedExports: readonly ExportHistoryItem[];
  projectName?: string | null;
  projectId?: string | null;
  outputAssets?:readonly {readonly id:string;readonly projectId?:string|null;readonly sizeBytes?:number|null}[];
  timelineRevision?: number | null;
  heldExportIds?: readonly string[];
  samplePeak?: ExportSamplePeakView;
  loudness?: ExportLoudnessView;
  fileRecoveryEnabled?: boolean;
  onReexport?: (exportId: string) => void;
  onClose?:()=>void;
}

/** Presentation only. App owns ordering, project identity, right-dock lifetime and
 * navigation fences. Rows retain their original immutable export snapshots. */
export default function ExportHistoryList({ orderedExports, projectName, projectId,outputAssets=[], timelineRevision, heldExportIds = [], samplePeak, loudness, fileRecoveryEnabled = true, onReexport,onClose }: ExportHistoryListProps): ReactElement {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const [filterState,setFilterState]=useState<{projectId:string|null|undefined;value:'all'|'complete'|'failed'}>({projectId,value:'all'});
  const filter=filterState.projectId===projectId?filterState.value:'all',complete=(status:string|undefined)=>['succeeded','completed','ready'].includes(status??'');
  const cancelled=(item:ExportHistoryItem)=>Boolean(item.error&&typeof item.error==='object'&&'code' in item.error&&item.error.code==='EXPORT_CANCELLED');
  const items=orderedExports.filter(item=>filter==='all'||filter==='complete'&&complete(item.status)||filter==='failed'&&item.status==='failed'&&!cancelled(item));
  return <div className="export-history-table-view export-list">
    <header className="export-history-toolbar"><strong>{t('export.history.title')} <span>{orderedExports.length}</span></strong><div role="group" aria-label={t('export.history.title')}>{(['all','complete','failed'] as const).map(value=><Button key={value} variant="ghost" className="button small" aria-pressed={filter===value} data-testid={`export-history-filter-${value}`} onClick={()=>setFilterState({projectId,value})}>{t(value==='all'?'redesign.export.historyAll':value==='complete'?'redesign.export.historyComplete':'redesign.export.historyFailed')}</Button>)}</div></header>
    <div className="export-history-table-scroll"><table className="export-history-table"><thead><tr><th>{t('redesign.export.fileLabel')}</th><th>{t('redesign.export.historySpec')}</th><th>{t('redesign.export.historySize')}</th><th>{t('redesign.export.historyTime')}</th><th>{t('redesign.export.historyStatus')}</th><th>{t('redesign.export.historyActions')}</th></tr></thead><tbody>
    {items.length ? items.map(item => {
      const delivery = exportHistoryDelivery(item), held = heldExportIds.includes(item.id), invalidRange = hasInvalidExportRangeHistory(item);
      // File size is current owned asset metadata, never a change to the frozen
      // export receipt. A row from another project cannot borrow this listing.
      const outputAsset=projectId&&item.projectId===projectId&&item.assetId?outputAssets.find(asset=>asset.id===item.assetId&&asset.projectId===projectId):undefined;
      const sizeBytes=typeof outputAsset?.sizeBytes==='number'&&Number.isSafeInteger(outputAsset.sizeBytes)&&outputAsset.sizeBytes>0?outputAsset.sizeBytes:undefined;
      if (hasNamedTimelineDelivery(item)) return <TimelineDeliveryHistory tableRow sizeBytes={sizeBytes} key={item.id} item={item} samplePeak={samplePeak} loudness={loudness} frozenDelivery={delivery} timelineRevision={timelineRevision} statusLabel={exportHistoryStatusMessage(item.status, locale)} held={held} fileRecoveryEnabled={fileRecoveryEnabled} filmIcon={<Icon name="film" size={24} />} downloadIcon={<Icon name="download" size={15} />} onReexport={!held && onReexport ? () => onReexport(item.id) : undefined} />;
      return <tr className="export-history-row" key={item.id} data-status={cancelled(item)?'cancelled':item.status}><td><strong>{projectName||t('export.history.film')}.mp4</strong>{held&&<small data-testid="restored-export-held">{t('export.history.held')}</small>}{Boolean(item.error)&&<small className="job-error">{t('export.history.safeError')}</small>}<details className="export-history-diagnostics"><summary>{t('redesign.export.details')}</summary><small>{item.mode==='timeline'?t(item.purpose==='preview'?'export.history.previewRevision':'export.history.timelineRevision',{revision:item.timelineRevision??0,snapshot:item.timelineRevision!==timelineRevision?t('export.history.old'):t('export.history.current')}):t('export.history.storyboard',{count:item.orderedVersionIds?.length||0})}</small>{(samplePeak||loudness)&&<><ExportSamplePeak exportId={item.id} samplePeak={samplePeak}/><ExportLoudness exportId={item.id} loudness={loudness}/></>}</details></td><td>{delivery&&<span data-testid="export-history-settings">{t('redesign.export.pictureFormat',{dimensions:delivery.dimensions,fps:delivery.fps})}<small>{renderMessage(delivery.rateMessage)}{delivery.upscale?` · ${t('export.history.upscale')}`:''}</small></span>}{item.mode==='timeline'&&item.purpose==='export'&&<ExportRangeSummary input={item.snapshot} snapshot showWhole testId="export-history-range"/>}{invalidRange&&<small className="notice warning" data-testid="export-history-range-invalid">{t('export.history.invalidRange')}</small>}</td><td data-testid="export-history-size">{sizeBytes===undefined?'—':t('redesign.export.fileSize',{size:formatNumber(sizeBytes/1024/1024,{maximumFractionDigits:1})})}</td><td><time dateTime={item.createdAt}>{formatDate(item.createdAt,{dateStyle:'short',timeStyle:'short'})}</time></td><td><Badge className={`small-badge ${item.status==='failed'?'warn':'neutral'}`}>{cancelled(item)?t('redesign.export.cancelled'):exportHistoryStatusMessage(item.status,locale)}</Badge></td><td>        {!held && onReexport && ['failed', 'cancelled'].includes(item.status ?? '') && <Button variant="ghost" type="button" className="button small" data-testid="export-history-reexport" onClick={() => onReexport(item.id)}>{t('redesign.export.reexport')}</Button>}
        {invalidRange ? <Badge className="small-badge warn">{t('export.history.rangeUnavailable')}</Badge> : (item.url || item.assetId) && ['succeeded', 'completed', 'ready'].includes(item.status ?? '')
          ? <ExportFileActions projectId={(projectId||item.projectId) as string} exportId={item.id} downloadHref={(item.url || `/media/${item.assetId}`) as string} disabled={!fileRecoveryEnabled||held||item.mode==='timeline'&&item.purpose!=='export'}/>
          : held ? <Badge className="small-badge neutral">{t('export.history.retained')}</Badge> : item.status === 'failed'
            ? <Badge className="small-badge warn">{t('export.history.failed')}</Badge>
            : <span className="spinner" />}
</td></tr>; })
      : <tr><td colSpan={6}><div className="small-empty">
          <Icon name="download" size={29} />
          <h4>{t(orderedExports.length?'redesign.export.historyNoMatches':'export.history.empty')}</h4>
          <p>{t('export.history.emptyHelp')}</p>
        </div></td></tr>}
    </tbody></table></div><footer className="export-history-footer"><p>{t('redesign.export.historyRetained')}</p>{onClose&&<Button variant="ghost" className="button" onClick={onClose}>{t('redesign.export.close')}</Button>}</footer>
  </div>;
}
