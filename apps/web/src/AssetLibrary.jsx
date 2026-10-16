import { useI18n } from './i18n/I18nProvider.tsx';
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

import './asset-annotations.css';
import AssetAnnotations from './AssetAnnotations.tsx';
import { annotationMatches, annotationTags, annotationRow } from './asset-annotation-state.ts';

const filterKeys = [['all', 'assets.all'], ['image', 'assets.image'], ['video', 'assets.video'], ['audio', 'assets.audio']];
export default function AssetLibrary({ mutationDisabled = false, assets, filter, onFilter, search, onSearch, onImport, onFiles, onPreview, onCanvas, onTimeline, busy, collapsed, onCollapse, project, mode = 'canvas', versions = [], shots = [], dispositions, dispositionBlocked, selectedAsset, inUseAssetIds = new Set(), onShowTasks, subjects, subjectBlocked, onInspectShot, timelineUsage, onLocateTimelineUse, annotations, annotationBlocked, restored, confirm }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
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
  const [tagChoice, setTagChoice] = useState({ scope: null, value: '' });
  const tagFilter = tagChoice.scope === annotations?.state?.ownerScope ? tagChoice.value : '';
  const tags = annotationTags(annotations?.state);
  const unknownAnnotations = annotations ? assets.filter(asset => asset.projectId === project?.id && !annotationRow(annotations.state, asset.id)).length : 0;
  const usageFilter = useAssetTimelineUsageFilter({ ...usageProps, assets: filterLibraryAssets(assets.filter(asset => asset.projectId === project?.id && annotationMatches(annotations?.state, asset.id, tagFilter)), { type: filter, search, disposition: dispositionFilter, state }) });
  const resetFilters = () => interaction.admit(() => { setLocalFilter({ scope: state.scope, value: 'all' }); usageFilter.reset(); setTagChoice({ scope: annotations?.state?.ownerScope, value: '' }); onFilter('all'); onSearch(''); });
  const visible = usageFilter.visibleAssets;
  const visibleIds = new Set(visible.map(asset => asset.id)), counts = dispositionCounts(state, assets);
  const failed = assets.filter(asset => state?.entries?.[asset.id]?.phase === 'error').length;
  const hiddenUsed = assets.filter(asset => inUseAssetIds.has(asset.id) && !visibleIds.has(asset.id)).length;
  const outsideSelected = selectedAsset && selectedAsset.projectId === project?.id && !visibleIds.has(selectedAsset.id) ? selectedAsset : null;
  const filtered = Boolean(tagFilter) || dispositionFilter !== 'all' || filter !== 'all' || Boolean(search) || usageFilter.filter !== 'all';

  return <Collapsible open={!collapsed} onOpenChange={open => { if (!open) onCollapse(); }} className={`asset-panel ${collapsed ? 'panel-collapsed' : ''}`} render={<aside aria-label={t('assets.indexedLibrary')} />} data-testid="asset-panel" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); if (mutationDisabled) e.dataTransfer.dropEffect = 'none'; } }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); if (!mutationDisabled && typeof onFiles === 'function') onFiles(Array.from(e.dataTransfer.files)); } }}>
    <div className="asset-panel-heading"><h2>{t('assets.library')}</h2><span>{assets.length}</span><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label={t('assets.collapse')} title={t('assets.collapse')} data-testid="toggle-assets" />}><Icon name="minus" size={16} /></CollapsibleTrigger></div>
    <CollapsibleContent keepMounted className="asset-panel-content">
      {subjects && <div className="library-view-tabs" role="tablist" aria-label={t('assets.assetsSubjects')}><Button variant="ghost" size="sm" role="tab" id="library-assets-tab" aria-controls="library-assets-pane" aria-selected={libraryView === 'assets'} data-testid="library-assets-tab" onClick={() => interaction.admit(() => setLibraryTab({ scope: libraryScope, value: 'assets' }))}>{t('assets.assets')}</Button><Button variant="ghost" size="sm" role="tab" id="library-subjects-tab" aria-controls="library-subjects-pane" aria-selected={libraryView === 'subjects'} data-testid="library-subjects-tab" onClick={() => interaction.admit(() => setLibraryTab({ scope: libraryScope, value: 'subjects' }))}>{t('subjects.subjects')}</Button></div>}
      <WorkspaceVisibilityProvider visible={libraryView === 'assets'}><div className="library-view-pane" id="library-assets-pane" role="tabpanel" aria-labelledby="library-assets-tab" hidden={libraryView !== 'assets'} inert={libraryView !== 'assets'}>
      <Button variant="outline" className="button import-button full" data-testid="import-button" title={editing ? t('assets.inspectEditHint') : t('assets.inspectCanvasHint')} disabled={mutationDisabled || busy.import || typeof onImport !== 'function'} onClick={onImport}>{busy.import ? <span className="spinner" /> : <Icon name="upload" size={15} />}{busy.import ? t('assets.importing') : t('assets.importMedia')}</Button>
      <p className="asset-drag-help">{mutationDisabled ? t('opacity.restored.assetsReadOnly') : editing ? t('assets.editHint') : t('assets.canvasHint')}</p>
      <div className="asset-search"><Input aria-label={t('assets.search')} placeholder={t('assets.searchPlaceholder')} value={search} onChange={e => onSearch(e.target.value)} /><Icon name="search" size={14} /></div>
      {dispositions && <><div className="asset-disposition-filter" role="group" aria-label={t('assets.markFilter')}>{dispositionFilters.map(([value, label]) => <Button variant="ghost" size="sm" type="button" key={value} data-testid={`asset-disposition-filter-${value}`} aria-pressed={dispositionFilter === value} disabled={!interaction.visible || !state?.scope} onClick={() => chooseDispositionFilter(value)}>{renderMessage(label)}<span>{counts[value]}</span></Button>)}</div>
      <div className="asset-disposition-summary" data-testid="asset-disposition-summary">
        <span role="status" title={t('assets.loadedCountHint')}>{t('assets.loadingSummary', { count: counts.all, read: counts.all - counts.unknown })}{state?.loading ? t('assets.readingSuffix') : failed ? t('assets.failedSuffix') : ''}</span>
        <Button variant="ghost" className="text-button" type="button" data-testid="asset-disposition-refresh" aria-label={t('assets.reloadMarks')} disabled={!interaction.visible || !state?.scope || state.loading || Boolean(state.savingAssetId)} onClick={() => interaction.admit(() => controller.read())}>{t('shell.refresh')}</Button>
        <Button variant="ghost" className="text-button" type="button" data-testid="asset-filter-reset" aria-label={t('assets.resetFilters')} disabled={!interaction.visible || !state?.scope} onClick={resetFilters}>{t('shell.reset')}</Button>
      </div></>}
      {annotations && <><label className="annotation-tag-filter" htmlFor="annotation-tag-filter">{t('annotations.filter')}<select id="annotation-tag-filter" data-testid="annotation-tag-filter" value={tagFilter} disabled={!interaction.visible || !annotations.state?.scope} onChange={event => { const value = event.target.value; interaction.admit(() => setTagChoice({ scope: annotations.state.ownerScope, value })); }}><option value="">{t('annotations.allTags')}</option>{[...new Set([...tags, ...(tagFilter ? [tagFilter] : [])])].map(tag => <option value={tag} key={tag}>{tag}</option>)}</select></label>{unknownAnnotations > 0 && <p className="annotation-unverified" role="status">{t('annotations.unknownCount', { count: unknownAnnotations })}</p>}</>}
      <Tabs value={filter} onValueChange={onFilter} className="asset-filter-surface">
        <TabsList variant="line" className="asset-tabs" aria-label={t('assets.type')}>{filterKeys.map(([value, label]) => <TabsTrigger key={value} value={value} className={filter === value ? 'active' : ''}>{t(label)}</TabsTrigger>)}</TabsList>
        <ScrollArea className="asset-scroll-area">
          <AssetTimelineUsageFilters {...usageProps} filter={usageFilter.filter} onFilter={usageFilter.choose} />
          <TabsContent value={filter} className="asset-list">
          {dispositions && (counts.unknown > 0 || failed > 0 || state?.mutationError || state?.uncertain || hiddenUsed > 0) && <div className="asset-disposition-details" data-testid="asset-disposition-details">
            {counts.unknown > 0 && <p data-testid="asset-disposition-unknown">{t('assets.unknownMarks', { count: counts.unknown })}</p>}
            {failed > 0 && <p role="alert">{t('assets.failedMarks', { count: failed })}</p>}
            {state?.mutationError && <p role="alert">{renderMessage(state.mutationError)}</p>}
            {state?.uncertain && <p role="alert">{t('assets.markPending')}</p>}
            {state?.uncertain && <Button variant="ghost" className="text-button" type="button" onClick={() => interaction.admit(() => onShowTasks?.())}>{t('assets.viewPending')}</Button>}
            {hiddenUsed > 0 && <p data-testid="asset-filter-hidden-used">{t('assets.hiddenUsed', { count: hiddenUsed })}</p>}
          </div>}
          {outsideSelected && <section className="asset-disposition-selected" data-testid="asset-filter-selected-outside" aria-label={t('assets.selectedHidden')}><strong title={outsideSelected.name}>{outsideSelected.name}</strong><p>{t('assets.selectedHiddenHint')}</p><Button variant="ghost" className="text-button" type="button" data-testid="asset-filter-show-selected" onClick={resetFilters}>{t('assets.showAllKeepSelection')}</Button><AssetDispositionControls asset={outsideSelected} state={state} controller={controller} blocked={dispositionBlocked} prefix="selected-asset" /></section>}
          {visible.map(asset => { const kind = assetKind(asset); const version = versions.find(item => item.assetId === asset.id); const shot = version ? shots.find(item => item.id === version.shotId) : null; return <div className={`asset-card ${kind}`} key={asset.id} data-testid={`asset-card-${asset.id}`} draggable={!mutationDisabled} onPointerDownCapture={event => { event.currentTarget.draggable = !mutationDisabled && !event.target.closest?.('[data-no-asset-drag]'); }} onPointerUp={event => { event.currentTarget.draggable = !mutationDisabled; }} onPointerCancel={event => { event.currentTarget.draggable = !mutationDisabled; }} onDragStart={e => { if (mutationDisabled || e.target.closest?.('[data-no-asset-drag]')) { e.preventDefault(); return; } dragAsset(e, asset.id); }}>
            <Button variant="ghost" className="asset-thumbnail" onClick={() => onPreview(asset)} aria-label={t('assets.previewNamed', { name: asset.name })}><Media asset={asset} /><span className="asset-kind"><Icon name={kind === 'video' ? 'play' : kind === 'audio' ? 'music' : 'image'} size={11} />{kind === 'image' ? t('assets.image') : `${kind === 'audio' ? t('assets.audio') : t('assets.video')} · ${asset.duration ? formatNumber(Number(asset.duration), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 's' : '—'}`}</span></Button>
            <div className="asset-card-meta"><div><strong title={asset.name}>{asset.name}</strong><span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : `${formatNumber(asset.sizeBytes / 1024, { maximumFractionDigits: 0 })} KB`}</span>{version && <span className="asset-generated-badge" data-testid={`generated-badge-${asset.id}`} title={t('assets.generatedVersion', { name: shot?.title || t('assets.generatedShot'), number: version.number })}><Icon name="sparkle" size={10} /><span>{shot?.title || t('assets.generatedShot')} · V{version.number}</span>{shot?.selectedVersionId === version.id && <b>{t('assets.selected')}</b>}</span>}</div></div>
            {annotations && !annotationRow(annotations.state, asset.id) && <p className="annotation-unverified" data-testid={`annotation-unverified-${asset.id}`}>{t('annotations.unknown')}</p>}
            {dispositions && <AssetDispositionControls asset={asset} state={state} controller={controller} blocked={dispositionBlocked} />}
            <AssetTimelineUsage {...usageProps} assetId={asset.id} assetName={asset.name} onLocate={onLocateTimelineUse} />
            <div className="asset-card-actions">{onCanvas && <WorkbenchTooltip content={t('assets.addCanvasHint')}><Button variant="ghost" className={!editing ? 'mode-primary-action' : ''} data-testid={`asset-to-canvas-${asset.id}`} aria-label={t('assets.addCanvasNamed', { name: asset.name })} onClick={() => onCanvas(kind, asset)}><Icon name="grid" size={12} />{t('assets.addToCanvas')}</Button></WorkbenchTooltip>}<WorkbenchTooltip content={t('assets.addTimelineHint')}><Button variant="ghost" className={editing ? 'mode-primary-action' : ''} aria-label={t('assets.addTimelineNamed', { name: asset.name })} data-testid={`asset-to-timeline-${asset.id}`} disabled={mutationDisabled || !project || busy.timeline || typeof onTimeline !== 'function'} onClick={() => { if (!mutationDisabled && typeof onTimeline === 'function') onTimeline(asset.id); }}><Icon name="plus" size={12} />{t('assets.addToEditing')}</Button></WorkbenchTooltip></div>
          </div>; })}
          {!visible.length && <div className="asset-empty"><div className="dashed-icon"><Icon name="folder" size={25} /></div><h4>{filtered ? t('assets.noMatches') : t('assets.emptyTitle')}</h4><p>{filtered ? t('assets.filterHint') : t('assets.emptyHint')}</p><span>PNG · JPG · MP4 · WAV · MP3</span></div>}
        </TabsContent></ScrollArea>
      </Tabs>
      {annotations && <AssetAnnotations visible={!collapsed && libraryView === 'assets'} asset={selectedAsset} state={annotations.state} controller={annotations.controller} blocked={annotationBlocked} restored={restored} onShowTasks={onShowTasks} confirm={confirm} />}
      <div className="asset-bottom"><Icon name="lock" size={12} /><span>{t('assets.localOnly')}</span></div>
      </div></WorkspaceVisibilityProvider>
      {subjects && <WorkspaceVisibilityProvider visible={libraryView === 'subjects'}><div className="library-view-pane" id="library-subjects-pane" role="tabpanel" aria-labelledby="library-subjects-tab" hidden={libraryView !== 'subjects'} inert={libraryView !== 'subjects'}><SubjectLibrary subjects={subjects} assets={assets} shots={shots} blocked={subjectBlocked} onShowTasks={onShowTasks} onInspectShot={onInspectShot} /></div></WorkspaceVisibilityProvider>}
    </CollapsibleContent>
  </Collapsible>;
}
