import React, { useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@mioon/ui/components/tabs';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchTooltip } from './WorkspaceControls.jsx';
import Icon from './icons.jsx';
import SubjectLibrary from './SubjectLibrary.jsx';
import { WorkspaceVisibilityProvider } from './workspace-visibility.jsx';
import { Media } from './Nodes.jsx';
import { assetKind, dragAsset } from './Timeline.jsx';
import AssetDispositionControls, { useDispositionInteraction } from './AssetDispositionControls.jsx';
import { dispositionCounts, dispositionFilters, filterLibraryAssets } from './asset-disposition-state.js';
import AssetTimelineUsage, { AssetTimelineUsageFilters, useAssetTimelineUsageFilter } from './AssetTimelineUsage.tsx';

const filters = [['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频']];
export default function AssetLibrary({ assets, filter, onFilter, search, onSearch, onImport, onFiles, onPreview, onCanvas, onTimeline, busy, collapsed, onCollapse, project, mode = 'canvas', versions = [], shots = [], dispositions, dispositionBlocked, selectedAsset, inUseAssetIds = new Set(), onShowTasks, subjects, subjectBlocked, onInspectShot, timelineUsage, onLocateTimelineUse }) {
  const editing = mode === 'editing';
  const [libraryTab, setLibraryTab] = useState({ scope: null, value: 'assets' });
  const libraryScope = project?.id;
  const libraryView = libraryTab.scope === libraryScope ? libraryTab.value : 'assets';
  const state = dispositions?.state, controller = dispositions?.controller;
  const [localFilter, setLocalFilter] = useState({ scope: null, value: 'all' });
  const dispositionFilter = localFilter.scope === state?.scope ? localFilter.value : 'all';
  const interaction = useDispositionInteraction(state?.scope, controller);
  const chooseDispositionFilter = value => interaction.admit(() => setLocalFilter({ scope: state.scope, value }));
  const usageProps = { projectId: project?.id, scope: state?.scope || libraryScope, usage: timelineUsage, visible: interaction.visible && !collapsed && libraryView === 'assets' };
  const usageFilter = useAssetTimelineUsageFilter({ ...usageProps, assets: filterLibraryAssets(assets, { type: filter, search, disposition: dispositionFilter, state }) });
  const resetFilters = () => interaction.admit(() => { setLocalFilter({ scope: state.scope, value: 'all' }); usageFilter.reset(); onFilter('all'); onSearch(''); });
  const visible = usageFilter.visibleAssets;
  const visibleIds = new Set(visible.map(asset => asset.id)), counts = dispositionCounts(state, assets);
  const failed = assets.filter(asset => state?.entries?.[asset.id]?.phase === 'error').length;
  const hiddenUsed = assets.filter(asset => inUseAssetIds.has(asset.id) && !visibleIds.has(asset.id)).length;
  const outsideSelected = selectedAsset && selectedAsset.projectId === project?.id && !visibleIds.has(selectedAsset.id) ? selectedAsset : null;
  const filtered = dispositionFilter !== 'all' || filter !== 'all' || Boolean(search) || usageFilter.filter !== 'all';

  return <Collapsible open={!collapsed} onOpenChange={open => { if (!open) onCollapse(); }} className={`asset-panel ${collapsed ? 'panel-collapsed' : ''}`} render={<aside aria-label="01 素材库" />} data-testid="asset-panel" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); onFiles(Array.from(e.dataTransfer.files)); } }}>
    <div className="asset-panel-heading"><h2>素材库</h2><span>{assets.length}</span><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label="收起素材库" title="收起素材库" data-testid="toggle-assets" />}><Icon name="minus" size={16} /></CollapsibleTrigger></div>
    <CollapsibleContent keepMounted className="asset-panel-content">
      {subjects && <div className="library-view-tabs" role="tablist" aria-label="素材与主体"><Button variant="ghost" size="sm" role="tab" id="library-assets-tab" aria-controls="library-assets-pane" aria-selected={libraryView === 'assets'} data-testid="library-assets-tab" onClick={() => interaction.admit(() => setLibraryTab({ scope: libraryScope, value: 'assets' }))}>素材</Button><Button variant="ghost" size="sm" role="tab" id="library-subjects-tab" aria-controls="library-subjects-pane" aria-selected={libraryView === 'subjects'} data-testid="library-subjects-tab" onClick={() => interaction.admit(() => setLibraryTab({ scope: libraryScope, value: 'subjects' }))}>主体</Button></div>}
      <WorkspaceVisibilityProvider visible={libraryView === 'assets'}><div className="library-view-pane" id="library-assets-pane" role="tabpanel" aria-labelledby="library-assets-tab" hidden={libraryView !== 'assets'} inert={libraryView !== 'assets'}>
      <Button variant="outline" className="button import-button full" data-testid="import-button" disabled={busy.import} onClick={onImport}>{busy.import ? <span className="spinner" /> : <Icon name="upload" size={15} />}{busy.import ? '正在导入…' : '导入图片 / 视频 / 音频'}</Button>
      <p className="asset-drag-help">{editing ? '点击查看源素材 · 拖到时间线编排' : '点击快速预览 · 拖到画板构思'}</p>
      <div className="asset-search"><Input aria-label="搜索素材" placeholder="搜索素材…" value={search} onChange={e => onSearch(e.target.value)} /><span>⌕</span></div>
      <div className="asset-disposition-filter" role="group" aria-label="素材标记筛选">{dispositionFilters.map(([value, label]) => <Button variant="ghost" size="sm" type="button" key={value} data-testid={`asset-disposition-filter-${value}`} aria-pressed={dispositionFilter === value} disabled={!interaction.visible || !state?.scope} onClick={() => chooseDispositionFilter(value)}>{label}<span>{counts[value]}</span></Button>)}</div>
      <div className="asset-disposition-summary" data-testid="asset-disposition-summary">
        <span role="status" title="数量仅统计已加载素材">已加载 {counts.all} · 已读 {counts.all - counts.unknown}{state?.loading ? ' · 读取中' : failed ? ' · 有失败' : ''}</span>
        <Button variant="ghost" className="text-button" type="button" data-testid="asset-disposition-refresh" aria-label="重新读取标记" disabled={!interaction.visible || !state?.scope || state.loading || Boolean(state.savingAssetId)} onClick={() => interaction.admit(() => controller.read())}>刷新</Button>
        <Button variant="ghost" className="text-button" type="button" data-testid="asset-filter-reset" aria-label="重置全部筛选" disabled={!interaction.visible || !state?.scope} onClick={resetFilters}>重置</Button>
      </div>
      <Tabs value={filter} onValueChange={onFilter} className="asset-filter-surface">
        <TabsList variant="line" className="asset-tabs" aria-label="素材类型">{filters.map(([value, label]) => <TabsTrigger key={value} value={value} className={filter === value ? 'active' : ''}>{label}</TabsTrigger>)}</TabsList>
        <ScrollArea className="asset-scroll-area">
          <AssetTimelineUsageFilters {...usageProps} filter={usageFilter.filter} onFilter={usageFilter.choose} />
          <TabsContent value={filter} className="asset-list">
          {(counts.unknown > 0 || failed > 0 || state?.mutationError || state?.uncertain || hiddenUsed > 0) && <div className="asset-disposition-details" data-testid="asset-disposition-details">
            {counts.unknown > 0 && <p data-testid="asset-disposition-unknown">{counts.unknown} 个状态未知，在标记筛选中仍显示。</p>}
            {failed > 0 && <p role="alert">{failed} 个素材标记读取失败，请重新读取。已确认的其他批次仍可使用。</p>}
            {state?.mutationError && <p role="alert">{state.mutationError}</p>}
            {state?.uncertain && <p role="alert">有修改结果待确认，请在任务面板恢复同一请求。</p>}
            {state?.uncertain && <Button variant="ghost" className="text-button" type="button" onClick={() => interaction.admit(() => onShowTasks?.())}>查看待确认任务</Button>}
            {hiddenUsed > 0 && <p data-testid="asset-filter-hidden-used">筛选隐藏了 {hiddenUsed} 个已用于画板或时间线的素材，已有引用和片段保持不变。</p>}
          </div>}
          {outsideSelected && <section className="asset-disposition-selected" data-testid="asset-filter-selected-outside" aria-label="当前源素材未显示在筛选中"><strong title={outsideSelected.name}>{outsideSelected.name}</strong><p>当前源素材不在筛选结果中，当前选择与未保存范围仍保留。</p><Button variant="ghost" className="text-button" type="button" data-testid="asset-filter-show-selected" onClick={resetFilters}>显示全部素材，保留当前选择</Button><AssetDispositionControls asset={outsideSelected} state={state} controller={controller} blocked={dispositionBlocked} prefix="selected-asset" /></section>}
          {visible.map(asset => { const kind = assetKind(asset); const version = versions.find(item => item.assetId === asset.id); const shot = version ? shots.find(item => item.id === version.shotId) : null; return <div className={`asset-card ${kind}`} key={asset.id} data-testid={`asset-card-${asset.id}`} draggable onPointerDownCapture={event => { event.currentTarget.draggable = !event.target.closest?.('[data-no-asset-drag]'); }} onPointerUp={event => { event.currentTarget.draggable = true; }} onPointerCancel={event => { event.currentTarget.draggable = true; }} onDragStart={e => { if (e.target.closest?.('[data-no-asset-drag]')) { e.preventDefault(); return; } dragAsset(e, asset.id); }}>
            <Button variant="ghost" className="asset-thumbnail" onClick={() => onPreview(asset)} aria-label={`预览 ${asset.name}`}><Media asset={asset} /><span className="asset-kind"><Icon name={kind === 'video' ? 'play' : kind === 'audio' ? 'music' : 'image'} size={11} />{kind === 'image' ? '图片' : `${kind === 'audio' ? '音频' : '视频'} · ${asset.duration ? Number(asset.duration).toFixed(1) + 's' : '—'}`}</span></Button>
            <div className="asset-card-meta"><div><strong title={asset.name}>{asset.name}</strong><span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : `${(asset.sizeBytes / 1024).toFixed(0)} KB`}</span>{version && <span className="asset-generated-badge" data-testid={`generated-badge-${asset.id}`} title={`${shot?.title || '生成镜头'} · 版本 ${version.number}`}><Icon name="sparkle" size={10} /><span>{shot?.title || '生成镜头'} · V{version.number}</span>{shot?.selectedVersionId === version.id && <b>已选用</b>}</span>}</div></div>
            <AssetDispositionControls asset={asset} state={state} controller={controller} blocked={dispositionBlocked} />
            <AssetTimelineUsage {...usageProps} assetId={asset.id} assetName={asset.name} onLocate={onLocateTimelineUse} />
            <div className="asset-card-actions"><WorkbenchTooltip content="以独立节点加入画布"><Button variant="ghost" className={!editing ? 'mode-primary-action' : ''} data-testid={`asset-to-canvas-${asset.id}`} aria-label={`添加 ${asset.name} 到画布`} onClick={() => onCanvas(kind, asset)}><Icon name="grid" size={12} />加入画板</Button></WorkbenchTooltip><WorkbenchTooltip content="在首个兼容轨道末尾加入固定素材片段"><Button variant="ghost" className={editing ? 'mode-primary-action' : ''} aria-label={`添加 ${asset.name} 到时间线`} data-testid={`asset-to-timeline-${asset.id}`} disabled={!project || busy.timeline} onClick={() => onTimeline(asset.id)}><Icon name="plus" size={12} />加入剪辑</Button></WorkbenchTooltip></div>
          </div>; })}
          {!visible.length && <div className="asset-empty"><div className="dashed-icon"><Icon name="folder" size={25} /></div><h4>{filtered ? '没有匹配的素材' : '故事，从素材开始'}</h4><p>{filtered ? '试试其他筛选，或重置全部筛选。' : '拖入本地素材，或点击上方导入。'}</p><span>PNG · JPG · MP4 · WAV · MP3</span></div>}
        </TabsContent></ScrollArea>
      </Tabs>
      <div className="asset-bottom"><Icon name="lock" size={12} /><span>导入仅保存在本地</span></div>
      </div></WorkspaceVisibilityProvider>
      {subjects && <WorkspaceVisibilityProvider visible={libraryView === 'subjects'}><div className="library-view-pane" id="library-subjects-pane" role="tabpanel" aria-labelledby="library-subjects-tab" hidden={libraryView !== 'subjects'} inert={libraryView !== 'subjects'}><SubjectLibrary subjects={subjects} assets={assets} shots={shots} blocked={subjectBlocked} onShowTasks={onShowTasks} onInspectShot={onInspectShot} /></div></WorkspaceVisibilityProvider>}
    </CollapsibleContent>
  </Collapsible>;
}
