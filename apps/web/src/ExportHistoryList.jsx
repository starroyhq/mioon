import React from 'react';
import { Badge } from '@mioon/ui/components/badge';
import Icon from './icons.jsx';
import { statusText } from './api.js';
import { exportHistoryDelivery } from './export-settings-state.js';
import { hasNamedTimelineDelivery } from './export-delivery-state.ts';
import { hasInvalidExportRangeHistory } from './export-range-state.ts';
import ExportRangeSummary from './ExportRangeSummary.tsx';
import TimelineDeliveryHistory from './TimelineDeliveryHistory.tsx';
import ExportSamplePeak from './ExportSamplePeak.tsx';

/** Presentation only. App owns ordering, project identity, right-dock lifetime and
 * navigation fences. Rows retain their original immutable export snapshots. */
export default function ExportHistoryList({ orderedExports, projectName, timelineRevision, heldExportIds = [], samplePeak }) {
  return <div className="export-list">
    {orderedExports.length ? orderedExports.map(item => {
      const delivery = exportHistoryDelivery(item), held = heldExportIds.includes(item.id), invalidRange = hasInvalidExportRangeHistory(item);
      if (hasNamedTimelineDelivery(item)) return <TimelineDeliveryHistory key={item.id} item={item} samplePeak={samplePeak} frozenDelivery={delivery} timelineRevision={timelineRevision} statusLabel={statusText(item.status)} held={held} filmIcon={<Icon name="film" size={24} />} downloadIcon={<Icon name="download" size={15} />} />;
      return <div className="export-card" key={item.id}>
        <div className="export-icon"><Icon name="film" size={24} /></div>
        <div className="export-detail">
          <strong>{projectName || '成片'}.mp4</strong>
          {held && <span className="restored-held-label" data-testid="restored-export-held">历史记录 · 暂停执行，原状态保留</span>}
          <span>{statusText(item.status)} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span>
          {item.error && <p className="job-error">{typeof item.error === 'string' ? item.error : item.error.message}</p>}
          <small>{item.mode === 'timeline'
            ? `${item.purpose === 'preview' ? '时间线预览' : '时间线导出'} · rev ${item.timelineRevision}${item.timelineRevision !== timelineRevision ? ' · 旧快照' : ' · 当前'}`
            : `分镜顺序导出 · ${item.orderedVersionIds?.length || 0} 个镜头`}</small>
          {item.mode === 'timeline' && item.purpose === 'export' && <ExportRangeSummary input={item.snapshot} snapshot testId="export-history-range" />}
          {invalidRange && <p className="notice warning" data-testid="export-history-range-invalid">范围记录不完整，暂时不能下载。</p>}
          <ExportSamplePeak exportId={item.id} samplePeak={samplePeak} />
          {delivery && <small className="export-frozen-settings" data-testid="export-history-settings">成片 · {delivery.dimensions} · {delivery.fps} fps · {delivery.rate}{delivery.upscale ? ' · 放大输出，不增加细节' : ''} · AAC 128 kb/s</small>}
        </div>
        {invalidRange ? <Badge className="small-badge warn">范围不可用</Badge> : (item.url || item.assetId) && ['succeeded', 'completed', 'ready'].includes(item.status)
          ? <a className="button primary small" href={item.url || `/media/${item.assetId}`}
              download={`${projectName || 'film'}.mp4`} data-testid="download-export">
              <Icon name="download" size={15} />下载
            </a>
          : held ? <Badge className="small-badge neutral">已保留 · 暂停</Badge> : item.status === 'failed'
            ? <Badge className="small-badge warn">失败</Badge>
            : <span className="spinner" />}
      </div>; })
      : <div className="small-empty">
          <Icon name="download" size={29} />
          <h4>还没有导出记录</h4>
          <p>将媒体编排到时间线后导出，或为镜头选好版本后使用分镜导出。</p>
        </div>}
  </div>;
}
