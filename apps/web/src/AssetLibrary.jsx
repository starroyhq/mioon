import React from 'react';
import { Button } from '@video-workbench/ui/components/button';
import { Input } from '@video-workbench/ui/components/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@video-workbench/ui/components/tabs';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@video-workbench/ui/components/collapsible';
import { ScrollArea } from '@video-workbench/ui/components/scroll-area';
import { WorkbenchTooltip } from '@video-workbench/ui/components/workbench-tooltip';
import Icon from './icons.jsx';
import { Media } from './Nodes.jsx';
import { assetKind, dragAsset } from './Timeline.jsx';

const filters = [['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频']];
export default function AssetLibrary({ assets, filter, onFilter, search, onSearch, onImport, onFiles, onPreview, onCanvas, onTimeline, busy, collapsed, onCollapse, project }) {
  const visible = assets.filter(a => (filter === 'all' || assetKind(a) === filter) && a.name.toLowerCase().includes(search.toLowerCase()));
  return <Collapsible open={!collapsed} onOpenChange={open => { if (!open) onCollapse(); }} className={`asset-panel ${collapsed ? 'panel-collapsed' : ''}`} render={<aside aria-label="01 素材库" />} data-testid="asset-panel" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); onFiles(Array.from(e.dataTransfer.files)); } }}>
    <div className="asset-panel-heading"><h2><span className="region-index">01</span>素材库</h2><span>{assets.length}</span><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label="收起素材库" title="收起素材库" data-testid="toggle-assets" />}><Icon name="left" size={16} /></CollapsibleTrigger></div>
    <CollapsibleContent keepMounted className="asset-panel-content">
      <Button variant="outline" className="button import-button full" data-testid="import-button" disabled={busy.import} onClick={onImport}>{busy.import ? <span className="spinner" /> : <Icon name="upload" size={15} />}{busy.import ? '正在导入…' : '导入图片 / 视频 / 音频'}</Button>
      <p className="asset-drag-help">拖到画布构思 · 拖到时间线编排</p>
      <div className="asset-search"><Input aria-label="搜索素材" placeholder="搜索素材…" value={search} onChange={e => onSearch(e.target.value)} /><span>⌕</span></div>
      <Tabs value={filter} onValueChange={onFilter} className="asset-filter-surface">
        <TabsList variant="line" className="asset-tabs" aria-label="素材类型">{filters.map(([value, label]) => <TabsTrigger key={value} value={value} className={filter === value ? 'active' : ''}>{label}</TabsTrigger>)}</TabsList>
        <ScrollArea className="asset-scroll-area"><TabsContent value={filter} className="asset-list">
          {visible.map(asset => { const kind = assetKind(asset); return <div className={`asset-card ${kind}`} key={asset.id} data-testid={`asset-card-${asset.id}`} draggable onDragStart={e => dragAsset(e, asset.id)}>
            <Button variant="ghost" className="asset-thumbnail" onClick={() => onPreview(asset)} aria-label={`预览 ${asset.name}`}><Media asset={asset} /><span className="asset-kind"><Icon name={kind === 'video' ? 'play' : kind === 'audio' ? 'music' : 'image'} size={11} />{kind === 'image' ? '图片' : `${kind === 'audio' ? '音频' : '视频'} · ${asset.duration ? Number(asset.duration).toFixed(1) + 's' : '—'}`}</span></Button>
            <div className="asset-card-meta"><div><strong title={asset.name}>{asset.name}</strong><span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : `${(asset.sizeBytes / 1024).toFixed(0)} KB`}</span></div></div>
            <div className="asset-card-actions"><WorkbenchTooltip content="以独立节点加入画布"><Button variant="ghost" aria-label={`添加 ${asset.name} 到画布`} onClick={() => onCanvas(kind, asset)}><Icon name="grid" size={12} />画布</Button></WorkbenchTooltip><WorkbenchTooltip content="在首个兼容轨道末尾加入固定素材片段"><Button variant="ghost" aria-label={`添加 ${asset.name} 到时间线`} data-testid={`asset-to-timeline-${asset.id}`} disabled={!project || busy.timeline} onClick={() => onTimeline(asset.id)}><Icon name="plus" size={12} />时间线</Button></WorkbenchTooltip></div>
          </div>; })}
          {!visible.length && <div className="asset-empty"><div className="dashed-icon"><Icon name="folder" size={25} /></div><h4>{search ? '没有匹配的素材' : filter === 'audio' ? '给故事加入声音' : '故事，从素材开始'}</h4><p>{search ? '试试其他关键词。' : '拖入本地素材，或点击上方导入。'}</p><span>PNG · JPG · MP4 · WAV · MP3</span></div>}
        </TabsContent></ScrollArea>
      </Tabs>
      <div className="asset-bottom"><Icon name="lock" size={12} /><span>导入仅保存在本地</span></div>
    </CollapsibleContent>
  </Collapsible>;
}
