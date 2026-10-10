import React from 'react';
import { Badge } from '@mioon/ui/components/badge';
import Icon from './icons.jsx';
import { statusText } from './api.js';

/** Presentation only. App owns ordering, project identity, dialog lifetime and
 * navigation fences. Rows retain their original immutable export snapshots. */
export default function ExportHistoryList({ orderedExports, projectName, timelineRevision }) {
  return <div className="export-list">
    {orderedExports.length ? orderedExports.map(item =>
      <div className="export-card" key={item.id}>
        <div className="export-icon"><Icon name="film" size={24} /></div>
        <div className="export-detail">
          <strong>{projectName || '成片'}.mp4</strong>
          <span>{statusText(item.status)} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span>
          {item.error && <p className="job-error">{typeof item.error === 'string' ? item.error : item.error.message}</p>}
          <small>{item.mode === 'timeline'
            ? `${item.purpose === 'preview' ? '时间线预览' : '时间线导出'} · rev ${item.timelineRevision}${item.timelineRevision !== timelineRevision ? ' · 旧快照' : ' · 当前'}`
            : `分镜顺序导出 · ${item.orderedVersionIds?.length || 0} 个镜头`}</small>
        </div>
        {(item.url || item.assetId) && ['succeeded', 'completed', 'ready'].includes(item.status)
          ? <a className="button primary small" href={item.url || `/media/${item.assetId}`}
              download={`${projectName || 'film'}.mp4`} data-testid="download-export">
              <Icon name="download" size={15} />下载
            </a>
          : item.status === 'failed'
            ? <Badge className="small-badge warn">失败</Badge>
            : <span className="spinner" />}
      </div>)
      : <div className="small-empty">
          <Icon name="download" size={29} />
          <h4>还没有导出记录</h4>
          <p>将媒体编排到时间线后导出，或为镜头选好版本后使用分镜导出。</p>
        </div>}
  </div>;
}
