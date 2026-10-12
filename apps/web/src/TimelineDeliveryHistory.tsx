import React from 'react';
import type { ReactNode } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { namedTimelineDeliveryHistory } from './export-delivery-state.ts';

export interface TimelineDeliveryHistoryProps {
  item: unknown;
  frozenDelivery?: unknown;
  timelineRevision?: unknown;
  statusLabel: string;
  held?: boolean;
  filmIcon?: ReactNode;
  downloadIcon?: ReactNode;
}

/** Frozen timeline rows stay independent of today's project title/settings. */
export default function TimelineDeliveryHistory({ item, frozenDelivery, timelineRevision, statusLabel, held = false, filmIcon, downloadIcon }: TimelineDeliveryHistoryProps) {
  const delivery = namedTimelineDeliveryHistory(item, frozenDelivery);
  if (!delivery) return <div className="export-card" data-testid="named-delivery-invalid"><div className="export-icon">{filmIcon}</div><div className="export-detail"><strong>时间线导出记录</strong><p className="notice warning">成片记录不完整，暂时不能下载。</p>{held && <span className="restored-held-label" data-testid="restored-export-held">历史记录 · 暂停执行，原状态保留</span>}</div></div>;
  const output = delivery.output;
  return <div className="export-card" data-testid="named-delivery-history">
    <div className="export-icon">{filmIcon}</div>
    <div className="export-detail">
      <strong title={delivery.name} data-testid="delivery-history-name">{delivery.name}</strong>
      {held && <span className="restored-held-label" data-testid="restored-export-held">历史记录 · 暂停执行，原状态保留</span>}
      <span>{statusLabel} · <time dateTime={delivery.createdAt}>{new Date(delivery.createdAt).toLocaleString('zh-CN')}</time></span>
      {delivery.error && <p className="job-error">{delivery.error}</p>}
      <small>时间线导出 · rev {delivery.revision}{delivery.revision !== timelineRevision ? ' · 旧快照' : ' · 当前'}</small>
      {output ? <small className="export-frozen-settings" data-testid="export-history-settings">成片 · {output.dimensions} · {output.fps} fps · {output.rate}{output.upscale ? ' · 放大输出，不增加细节' : ''}{output.rate !== '原有编码设置' ? ' · AAC 128 kb/s' : ''}</small> : <small>冻结成片规格不可用</small>}
    </div>
    {delivery.downloadHref
      ? <Button variant="ghost" className="button primary small" render={<a href={delivery.downloadHref} download data-testid="download-export" />}>{downloadIcon}下载</Button>
      : held ? <Badge className="small-badge neutral">已保留 · 暂停</Badge>
        : delivery.status === 'failed' ? <Badge className="small-badge warn">失败</Badge> : <span className="spinner" />}
  </div>;
}
