import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useState } from 'react';
import type { ChangeEvent, DragEvent, PointerEvent } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@mioon/ui/components/tabs';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchTooltip, WorkbenchSelect } from './WorkspaceControls.tsx';
import AssetContextMenu from './AssetContextMenu.tsx';
import Icon from './icons.tsx';
import SubjectLibrary from './SubjectLibrary.tsx';
import { WorkspaceVisibilityProvider } from './workspace-visibility.tsx';
import { Media } from './Nodes.tsx';
import { assetKind, dragAsset } from './Timeline.tsx';
import AssetDispositionControls, { useDispositionInteraction } from './AssetDispositionControls.tsx';
import type { DispositionController, DispositionState } from './AssetDispositionControls.tsx';
import { dispositionCounts, dispositionFilters, filterLibraryAssets } from './asset-disposition-state.ts';
import type { AssetDispositionController, AssetDispositionState, DispositionFilter } from './asset-disposition-state.ts';
import AssetTimelineUsage, { AssetTimelineUsageFilters, useAssetTimelineUsageFilter } from './AssetTimelineUsage.tsx';
import type { UsageSnapshot } from './timeline-asset-usage.ts';
import type { AppAsset, AppProject, AppShot, AppVersion, WorkspaceMode } from './App.tsx';
import type { DisplayMessage, MessageKey } from '../../../packages/i18n/src/index.ts';

import './asset-annotations.css';
import AssetLibraryToolbar, { useAssetLibraryLayout } from './AssetLibraryToolbar.tsx';
import './asset-library-redesign.css';
import './asset-library-cards.css';
import { annotationMatches, annotationTags, annotationRow } from './asset-annotation-state.ts';
import type { AnnotationState } from './asset-annotation-state.ts';
import type { TimelineAssetUse } from './timeline-asset-usage.ts';
import type { SubjectsBundle } from './SubjectLibrary.tsx';

type SelectChange = {target: {value: string}};
interface Dispositions {state: AssetDispositionState | null; controller: AssetDispositionController}
interface Annotations {state: AnnotationState | null}
type FilterChip = {key: string; label: string; remove: () => void};
export type AssetLibraryTab = 'assets' | 'subjects';
const filterKeys = [['all', 'assets.all'], ['image', 'assets.image'], ['video', 'assets.video'], ['audio', 'assets.audio']] as const;
// Asset disposition labels are already-localized descriptors from the typed state module.
const typedDispositionFilters = dispositionFilters as unknown as ReadonlyArray<readonly [string, DisplayMessage]>;
export interface AssetLibraryProps {
  activeTab?: AssetLibraryTab;
  onTabChange?: (tab: AssetLibraryTab) => void;
  assets: AppAsset[];
  filter: string;
  onFilter: (value: string) => void;
  search: string;
  onSearch: (value: string) => void;
  onImport?: (() => void) | undefined;
  onFiles?: ((files: File[]) => void) | undefined;
  onPreview: (asset: AppAsset) => void;
  onCanvas?: ((kind: string, asset: AppAsset) => void) | undefined;
  onTimeline?: ((assetId: string) => void) | undefined;
  /** Opens shot detection for a video; offered in the card's right-click menu. */
  onDetectScenes?: ((asset: AppAsset) => void) | undefined;
  busy: Readonly<Record<string, boolean>>;
  collapsed: boolean;
  onCollapse: () => void;
  project?: AppProject | null;
  mode?: WorkspaceMode;
  versions?: AppVersion[];
  shots?: AppShot[];
  dispositions?: Dispositions;
  dispositionBlocked?: boolean;
  selectedAsset?: AppAsset | null;
  inUseAssetIds?: ReadonlySet<string>;
  onShowTasks?: (() => void) | undefined;
  subjects?: SubjectsBundle | null;
  subjectBlocked?: boolean;
  onInspectShot?: ((shotId: string) => void) | undefined;
  onInspectSubject?: ((subjectId: string) => void) | undefined;
  inspectedSubjectId?: string | null;
  timelineUsage?: UsageSnapshot;
  onLocateTimelineUse?: ((use: TimelineAssetUse, isStillCurrent: () => boolean) => void) | undefined;
  annotations?: Annotations;
  annotationBlocked?: unknown;
  restored?: unknown;
  confirm?: unknown;
}
export default function AssetLibrary({ activeTab, onTabChange, assets, filter, onFilter, search, onSearch, onImport, onFiles, onPreview, onCanvas, onTimeline, onDetectScenes, busy, collapsed, onCollapse, project, mode = 'canvas', versions = [], shots = [], dispositions, dispositionBlocked, selectedAsset, inUseAssetIds = new Set<string>(), onShowTasks, subjects, subjectBlocked, onInspectShot, onInspectSubject, inspectedSubjectId, timelineUsage, onLocateTimelineUse, annotations, annotationBlocked, restored, confirm }: AssetLibraryProps) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const editing = mode === 'editing';
  const [libraryTab, setLibraryTab] = useState<{scope: string | undefined; value: AssetLibraryTab}>({ scope: undefined, value: 'assets' });
  const libraryScope = project?.id;
  const { layout, setLayout } = useAssetLibraryLayout(libraryScope);
  const requestedTab = activeTab ?? (libraryTab.scope === libraryScope ? libraryTab.value : 'assets');
  const libraryView = requestedTab === 'subjects' && subjects ? 'subjects' : 'assets';
  const state = dispositions?.state, controller = dispositions?.controller;
  // The validated controller scope is a string when set; other values stay null.
  const dispositionScope = typeof state?.scope === 'string' ? state.scope : null;
  const [localFilter, setLocalFilter] = useState<{scope: string | null | undefined; value: string}>({ scope: null, value: 'all' });
  const dispositionFilter = localFilter.scope === dispositionScope ? localFilter.value : 'all';
  const interaction = useDispositionInteraction(dispositionScope, controller as unknown as DispositionController | null | undefined);
  const chooseLibraryTab = (value: AssetLibraryTab) => interaction.admit(() => {
    if (value === 'subjects' && !subjects) return;
    if (activeTab === undefined) setLibraryTab({ scope: libraryScope, value });
    onTabChange?.(value);
  });
  const chooseDispositionFilter = (value: string) => interaction.admit(() => setLocalFilter({ scope: dispositionScope, value }));
  const usageProps = { projectId: project?.id, scope: dispositionScope || libraryScope, usage: timelineUsage, visible: interaction.visible && !collapsed && libraryView === 'assets' };
  const [tagChoice, setTagChoice] = useState<{scope: unknown; value: string}>({ scope: null, value: '' });
  const [menu, setMenu] = useState<{assetId: string; scope: string | undefined; x: number; y: number} | null>(null);
  const tagFilter = tagChoice.scope === annotations?.state?.ownerScope ? tagChoice.value : '';
  const tags = annotationTags(annotations?.state);
  const unknownAnnotations = annotations ? assets.filter(asset => asset.projectId === project?.id && !annotationRow(annotations.state, asset.id)).length : 0;
  const libraryFilters = { type: filter, search, disposition: dispositionFilter as DispositionFilter, state: state ?? undefined };
  const usageFilter = useAssetTimelineUsageFilter({ ...usageProps, assets: filterLibraryAssets(assets.filter(asset => asset.projectId === project?.id && annotationMatches(annotations?.state, asset.id, tagFilter)), libraryFilters) });
  const resetFilters = () => interaction.admit(() => { setLocalFilter({ scope: dispositionScope, value: 'all' }); usageFilter.reset(); setTagChoice({ scope: annotations?.state?.ownerScope, value: '' }); onFilter('all'); onSearch(''); });
  // The usage filter is generic over the asset identity; the filtered array is the
  // caller's own AppAsset records.
  const visible = usageFilter.visibleAssets as readonly AppAsset[];
  const visibleIds = new Set<string>(visible.map((asset: {id: string}) => asset.id)), counts = dispositionCounts(state, assets) as unknown as Readonly<Record<string, number>>;
  const failed = assets.filter(asset => state?.entries?.[asset.id]?.phase === 'error').length;
  const hiddenUsed = assets.filter(asset => inUseAssetIds.has(asset.id) && !visibleIds.has(asset.id)).length;
  const outsideSelected = selectedAsset && selectedAsset.projectId === project?.id && !visibleIds.has(selectedAsset.id) ? selectedAsset : null;
  const filtered = Boolean(tagFilter) || dispositionFilter !== 'all' || filter !== 'all' || Boolean(search) || usageFilter.filter !== 'all';
  // The right-click menu belongs to the project it opened in and to a card still listed.
  const menuAsset = menu && menu.scope === libraryScope && interaction.visible ? visible.find(asset => asset.id === menu.assetId) ?? null : null;

  return <Collapsible open={!collapsed} onOpenChange={open => { if (!open) onCollapse(); }} className={`asset-panel ${collapsed ? 'panel-collapsed' : ''}`} render={<aside aria-label={t('assets.indexedLibrary')} />} data-testid="asset-panel" onDragOver={(e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); } }} onDrop={(e: DragEvent) => { if (e.dataTransfer.files.length) { e.preventDefault(); if (typeof onFiles === 'function') onFiles(Array.from(e.dataTransfer.files)); } }}>
     {!subjects && <div className="asset-panel-heading"><h2>{t('assets.library')}</h2><span>{assets.length}</span><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label={t('assets.collapse')} title={t('assets.collapse')} data-testid="toggle-assets" />}><Icon name="minus" size={16} /></CollapsibleTrigger></div>}
     <CollapsibleContent keepMounted className="asset-panel-content">
       {subjects && <div className="library-view-tabs" role="tablist" aria-label={t('assets.assetsSubjects')}><Button variant="ghost" size="sm" role="tab" id="library-assets-tab" aria-controls="library-assets-pane" aria-selected={libraryView === 'assets'} data-testid="library-assets-tab" onClick={() => chooseLibraryTab('assets')}>{t('assets.assets')}</Button><Button variant="ghost" size="sm" role="tab" id="library-subjects-tab" aria-controls="library-subjects-pane" aria-selected={libraryView === 'subjects'} data-testid="library-subjects-tab" onClick={() => chooseLibraryTab('subjects')}>{t('subjects.subjects')}</Button><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label={t('assets.collapse')} title={t('assets.collapse')} data-testid="toggle-assets" />}><Icon name="minus" size={16} /></CollapsibleTrigger></div>}
       <WorkspaceVisibilityProvider visible={libraryView === 'assets'}><div className="library-view-pane" id="library-assets-pane" role="tabpanel" aria-labelledby="library-assets-tab" hidden={libraryView !== 'assets'} inert={libraryView !== 'assets'}>
       <Button variant="outline" className="button import-button full" data-testid="import-button" title={editing ? t('assets.inspectEditHint') : t('assets.inspectCanvasHint')} disabled={busy.import || typeof onImport !== 'function'} onClick={onImport}>{busy.import ? <span className="spinner" /> : <Icon name="upload" size={15} />}{busy.import ? t('assets.importing') : t('assets.importMedia')}</Button>
       <p className="asset-drag-help">{editing ? t('assets.editHint') : t('assets.canvasHint')}</p>
       <Tabs value={filter} onValueChange={onFilter} className="asset-filter-surface">
         <AssetLibraryToolbar scope={libraryScope} visible={interaction.visible && !collapsed && libraryView === 'assets'} count={visible.length} layout={layout} onLayout={setLayout} search={<div className="asset-search"><Input aria-label={t('assets.search')} placeholder={t('assets.searchPlaceholder')} value={search} onChange={(e: ChangeEvent<HTMLInputElement>) => onSearch(e.target.value)} /><Icon name="search" size={14} /></div>} chips={[
           ...(filter !== 'all' ? [{ key: 'type', label: t('redesign.library.typeFilter', { type: t(`assets.${filter}` as MessageKey) }), remove: () => onFilter('all') }] : []),
           ...(tagFilter ? [{ key: 'tag', label: t('redesign.library.tagFilter', { tag: tagFilter }), remove: () => interaction.admit(() => setTagChoice({ scope: annotations?.state?.ownerScope, value: '' })) }] : []),
           ...(dispositionFilter !== 'all' ? [{ key: 'mark', label: renderMessage(typedDispositionFilters.find(([value]) => value === dispositionFilter)?.[1]), remove: () => chooseDispositionFilter('all') }] : []),
           ...(usageFilter.filter !== 'all' ? [{ key: 'usage', label: t('assets.usage.unused'), remove: usageFilter.reset }] : []),
           ...(search ? [{ key: 'search', label: t('redesign.library.searchFilter', { query: search }), remove: () => onSearch('') }] : []),
         ] as FilterChip[]}>
       {dispositions && <><div className="asset-disposition-filter" role="group" aria-label={t('assets.markFilter')}>{typedDispositionFilters.map(([value, label]) => <Button variant="ghost" size="sm" type="button" key={value} data-testid={`asset-disposition-filter-${value}`} aria-pressed={dispositionFilter === value} disabled={!interaction.visible || !dispositionScope} onClick={() => chooseDispositionFilter(value)}>{renderMessage(label)}<span>{counts[value]}</span></Button>)}</div>
       <div className="asset-disposition-summary" data-testid="asset-disposition-summary">
         <span role="status" title={t('assets.loadedCountHint')}>{t('assets.loadingSummary', { count: counts.all, read: counts.all - counts.unknown })}{state?.loading ? t('assets.readingSuffix') : failed ? t('assets.failedSuffix') : ''}</span>
         <Button variant="ghost" className="text-button" type="button" data-testid="asset-disposition-refresh" aria-label={t('assets.reloadMarks')} disabled={!interaction.visible || !state?.scope || state.loading || Boolean(state.savingAssetId)} onClick={() => interaction.admit(() => controller!.read())}>{t('shell.refresh')}</Button>
         <Button variant="ghost" className="text-button" type="button" data-testid="asset-filter-reset" aria-label={t('assets.resetFilters')} disabled={!interaction.visible || !dispositionScope} onClick={resetFilters}>{t('shell.reset')}</Button>
       </div></>}
       {annotations && <><label className="annotation-tag-filter" htmlFor="annotation-tag-filter">{t('annotations.filter')}<WorkbenchSelect id="annotation-tag-filter" data-testid="annotation-tag-filter" value={tagFilter} disabled={!interaction.visible || !annotations.state?.scope} onChange={(event: SelectChange) => { const value = event.target.value; interaction.admit(() => setTagChoice({ scope: annotations.state!.ownerScope, value })); }}><option value="">{t('annotations.allTags')}</option>{[...new Set([...tags, ...(tagFilter ? [tagFilter] : [])])].map(tag => <option value={tag} key={tag}>{tag}</option>)}</WorkbenchSelect></label>{unknownAnnotations > 0 && <p className="annotation-unverified" role="status">{t('annotations.unknownCount', { count: unknownAnnotations })}</p>}</>}

        <TabsList variant="line" className="asset-tabs" aria-label={t('assets.type')}>{filterKeys.map(([value, label]) => <TabsTrigger key={value} value={value} className={filter === value ? 'active' : ''}>{t(label)}</TabsTrigger>)}</TabsList>

          <AssetTimelineUsageFilters {...usageProps} filter={usageFilter.filter} onFilter={usageFilter.choose} />
        </AssetLibraryToolbar>
        <ScrollArea className="asset-scroll-area">
          <TabsContent value={filter} className={`asset-list asset-layout-${layout}`} data-layout={layout}>
          {dispositions && (counts.unknown > 0 || failed > 0 || state?.mutationError || state?.uncertain || hiddenUsed > 0) && <div className="asset-disposition-details" data-testid="asset-disposition-details">
            {counts.unknown > 0 && <p data-testid="asset-disposition-unknown">{t('assets.unknownMarks', { count: counts.unknown })}</p>}
            {failed > 0 && <p role="alert">{t('assets.failedMarks', { count: failed })}</p>}
            {state?.mutationError && <p role="alert">{renderMessage(state.mutationError)}</p>}
            {state?.uncertain && <p role="alert">{t('assets.markPending')}</p>}
            {state?.uncertain && <Button variant="ghost" className="text-button" type="button" onClick={() => interaction.admit(() => onShowTasks?.())}>{t('assets.viewPending')}</Button>}
            {hiddenUsed > 0 && <p data-testid="asset-filter-hidden-used">{t('assets.hiddenUsed', { count: hiddenUsed })}</p>}
          </div>}
          {outsideSelected && <section className="asset-disposition-selected" data-testid="asset-filter-selected-outside" aria-label={t('assets.selectedHidden')}><strong title={outsideSelected.name}>{outsideSelected.name}</strong><p>{t('assets.selectedHiddenHint')}</p><Button variant="ghost" className="text-button" type="button" data-testid="asset-filter-show-selected" onClick={resetFilters}>{t('assets.showAllKeepSelection')}</Button><AssetDispositionControls asset={outsideSelected} state={state as unknown as Parameters<typeof AssetDispositionControls>[0]['state']} controller={controller as unknown as Parameters<typeof AssetDispositionControls>[0]['controller']} blocked={dispositionBlocked} prefix="selected-asset" /></section>}
          {visible.map((asset: AppAsset) => { const kind = assetKind(asset); const version = versions.find(item => item.assetId === asset.id); const shot = version ? shots.find(item => item.id === version.shotId) : null; return <div className={`asset-card ${kind} ${selectedAsset?.id === asset.id ? 'selected' : ''}`} key={asset.id} data-testid={`asset-card-${asset.id}`} onContextMenu={(event: React.MouseEvent<HTMLDivElement>) => { if (!interaction.visible || (event.target as Element).closest?.('input, textarea, [contenteditable="true"]')) return; event.preventDefault(); setMenu({ assetId: asset.id, scope: libraryScope, x: event.clientX, y: event.clientY }); }} draggable onPointerDownCapture={(event: PointerEvent<HTMLDivElement>) => { event.currentTarget.draggable = !(event.target as Element).closest?.('[data-no-asset-drag]'); }} onPointerUp={(event: PointerEvent<HTMLDivElement>) => { event.currentTarget.draggable = true; }} onPointerCancel={(event: PointerEvent<HTMLDivElement>) => { event.currentTarget.draggable = true; }} onDragStart={(e: DragEvent) => { if ((e.target as Element).closest?.('[data-no-asset-drag]')) { e.preventDefault(); return; } dragAsset(e, asset.id); }}>
            <Button variant="ghost" className="asset-thumbnail" onClick={() => onPreview(asset)} aria-label={t('assets.previewNamed', { name: asset.name })}>{kind === 'audio' && layout === 'grid' ? <div className="asset-audio-thumbnail" aria-hidden="true"><Icon name="music" size={24} /></div> : <Media asset={asset} />}<span className="asset-kind" title={t(`assets.${kind}` as MessageKey)}><Icon name={kind === 'video' ? 'play' : kind === 'audio' ? 'music' : 'image'} size={11} />{kind === 'image' ? t('assets.image') : `${kind === 'audio' ? t('assets.audio') : t('assets.video')} · ${asset.duration ? formatNumber(Number(asset.duration), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 's' : '—'}`}</span>{Number(asset.duration) > 0 && <span className="asset-duration">{formatNumber(Number(asset.duration), { maximumFractionDigits: 0 })}s</span>}</Button>
            <div className="asset-card-meta"><div><strong title={asset.name}>{asset.name}</strong><span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : `${formatNumber(asset.sizeBytes / 1024, { maximumFractionDigits: 0 })} KB`}</span>{version && <span className="asset-generated-badge" data-testid={`generated-badge-${asset.id}`} title={t('assets.generatedVersion', { name: shot?.title || t('assets.generatedShot'), number: version.number })}><Icon name="sparkle" size={10} /><span>{shot?.title || t('assets.generatedShot')} · V{version.number}</span>{shot?.selectedVersionId === version.id && <b>{t('assets.selected')}</b>}</span>}</div></div>
            {annotations && !annotationRow(annotations.state, asset.id) && <p className="annotation-unverified" data-testid={`annotation-unverified-${asset.id}`}>{t('annotations.unknown')}</p>}
            {dispositions && <AssetDispositionControls asset={asset} state={state as unknown as Parameters<typeof AssetDispositionControls>[0]['state']} controller={controller as unknown as Parameters<typeof AssetDispositionControls>[0]['controller']} blocked={dispositionBlocked} compact={layout === 'grid'} />}
            <AssetTimelineUsage {...usageProps} compact={layout === 'grid'} assetId={asset.id} assetName={asset.name} onLocate={onLocateTimelineUse} />
            <div className="asset-card-actions">{onCanvas && <WorkbenchTooltip content={t('assets.addCanvasHint')}><Button variant="ghost" className={!editing ? 'mode-primary-action' : ''} data-testid={`asset-to-canvas-${asset.id}`} aria-label={t('assets.addCanvasNamed', { name: asset.name })} onClick={() => onCanvas(kind, asset)}><Icon name="grid" size={12} />{t('assets.addToCanvas')}</Button></WorkbenchTooltip>}<WorkbenchTooltip content={t('assets.addTimelineHint')}><Button variant="ghost" className={editing ? 'mode-primary-action' : ''} aria-label={t('assets.addTimelineNamed', { name: asset.name })} data-testid={`asset-to-timeline-${asset.id}`} disabled={!project || busy.timeline || typeof onTimeline !== 'function'} onClick={() => { if (typeof onTimeline === 'function') onTimeline(asset.id); }}><Icon name="plus" size={12} />{t('assets.addToEditing')}</Button></WorkbenchTooltip></div>
          </div>; })}
          {!visible.length && <div className="asset-empty"><div className="dashed-icon"><Icon name="folder" size={25} /></div><h4>{filtered ? t('assets.noMatches') : t('assets.emptyTitle')}</h4><p>{filtered ? t('assets.filterHint') : t('assets.emptyHint')}</p><span>PNG · JPG · MP4 · WAV · MP3</span></div>}
        </TabsContent></ScrollArea>
      </Tabs>
      {menuAsset && menu && <AssetContextMenu asset={menuAsset} kind={assetKind(menuAsset)} anchor={menu} onClose={() => setMenu(null)} onCanvas={onCanvas ? () => onCanvas(assetKind(menuAsset), menuAsset) : undefined}
        onTimeline={typeof onTimeline !== 'function' ? undefined : () => onTimeline(menuAsset.id)} timelineDisabled={!project || Boolean(busy.timeline)} onPreview={() => onPreview(menuAsset)}
        onDetectScenes={onDetectScenes ? () => onDetectScenes(menuAsset) : undefined} />}
      <div className="asset-bottom"><Icon name="lock" size={12} /><span>{t('assets.localOnly')}</span></div>
      </div></WorkspaceVisibilityProvider>
      {subjects && <WorkspaceVisibilityProvider visible={libraryView === 'subjects'}><div className="library-view-pane" id="library-subjects-pane" role="tabpanel" aria-labelledby="library-subjects-tab" hidden={libraryView !== 'subjects'} inert={libraryView !== 'subjects'}><SubjectLibrary restored={Boolean(restored)} subjects={subjects} assets={assets} shots={shots} blocked={subjectBlocked} onShowTasks={onShowTasks} onInspectShot={onInspectShot} onInspectSubject={onInspectSubject} inspectedSubjectId={inspectedSubjectId} /></div></WorkspaceVisibilityProvider>}
    </CollapsibleContent>
  </Collapsible>;
}
