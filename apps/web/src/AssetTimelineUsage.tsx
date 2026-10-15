import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@mioon/ui/components/button';
import type { TimelineAssetUse, UsageSnapshot } from './timeline-asset-usage.ts';

export type TimelineUsageFilter = 'all' | 'unused';
type UsageScope = Readonly<{
  projectId: string | null | undefined;
  scope: string | null | undefined;
  // App retains the reference across semantically identical polling snapshots.
  usage?: UsageSnapshot;
  visible: boolean;
}>;

/** Absence, a foreign project, and an omitted asset are never evidence of zero. */
export function assetTimelineUses(usage: UsageSnapshot | undefined, projectId: string | null | undefined, assetId: string): readonly TimelineAssetUse[] | null {
  if (!projectId || usage?.status !== 'ready' || usage.projectId !== projectId || !Object.hasOwn(usage.usesByAssetId, assetId)) return null;
  return usage.usesByAssetId[assetId] ?? null;
}

function useUsageInteraction({ projectId, scope, usage, visible }: UsageScope, target?: string) {
  const token = useMemo(() => ({ projectId, scope, usage, visible, target }), [projectId, scope, usage, visible, target]);
  const live = useRef<typeof token | null>(null);
  useLayoutEffect(() => { live.current = token; return () => { live.current = null; }; }, [token]);
  const isCurrent = () => Boolean(visible && projectId && scope && live.current === token);
  return { isCurrent, admit: (action: () => void) => { if (isCurrent()) action(); } };
}

/** Only this session's view changes. Source selection and range drafts are not inputs. */
export function useAssetTimelineUsageFilter<T extends { readonly id: string }>(props: UsageScope & { assets: readonly T[] }) {
  const { assets, scope, usage, projectId } = props;
  const [selection, setSelection] = useState<{ scope: UsageScope['scope']; value: TimelineUsageFilter }>({ scope, value: 'all' });
  // Reset immediately on each project epoch, including A → B → A without a click.
  if (selection.scope !== scope) setSelection({ scope, value: 'all' });
  const filter = selection.scope === scope ? selection.value : 'all';
  const { admit } = useUsageInteraction(props);
  const choose = (value: TimelineUsageFilter) => admit(() => setSelection({ scope, value }));
  const visibleAssets = filter === 'all' ? assets : assets.filter(asset => {
    const uses = assetTimelineUses(usage, projectId, asset.id);
    return uses === null || uses.length === 0;
  });
  return { filter, choose, reset: () => choose('all'), visibleAssets };
}

export function AssetTimelineUsageFilters(props: UsageScope & { filter: TimelineUsageFilter; onFilter: (value: TimelineUsageFilter) => void }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const { projectId, usage, filter, onFilter, visible } = props;
  const { admit } = useUsageInteraction(props);
  const ready = Boolean(projectId && usage?.status === 'ready' && usage.projectId === projectId);
  return <div data-testid="asset-timeline-usage-filters">
    <div className="asset-disposition-filter" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }} role="group" aria-label={t('assets.usage.filter')}>
      <Button variant="ghost" size="sm" type="button" aria-label={t('assets.usage.showAll')} data-testid="asset-usage-filter-all" aria-pressed={filter === 'all'} disabled={!visible || !projectId} onClick={() => admit(() => onFilter('all'))}>{t('assets.all')}</Button>
      <Button variant="ghost" size="sm" type="button" data-testid="asset-usage-filter-unused" aria-pressed={filter === 'unused'} disabled={!visible || !projectId} onClick={() => admit(() => onFilter('unused'))}>{t('assets.usage.unused')}</Button>
    </div>
    <div className="asset-disposition-summary" style={{ minHeight: 0 }}>
      <span role="status" data-testid="asset-usage-snapshot-status">{ready ? t('assets.usage.savedRevision', { revision: usage?.timelineRevision ?? '' }) : t('assets.usage.unavailable')}</span>
    </div>
  </div>;
}

const destinationStyle: CSSProperties = { width: '100%', minWidth: 0, height: 'auto', padding: '5px 4px', flexDirection: 'column', alignItems: 'flex-start', gap: 2, whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left', fontSize: 10, lineHeight: 1.45 };

export interface AssetTimelineUsageProps extends UsageScope {
  assetId: string;
  assetName: string;
  onLocate?: (use: TimelineAssetUse, isStillCurrent: () => boolean) => void;
}

export default function AssetTimelineUsage(props: AssetTimelineUsageProps) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const { assetId, assetName, projectId, scope, usage, visible, onLocate } = props;
  const uses = assetTimelineUses(usage, projectId, assetId);
  const [expanded, setExpanded] = useState({ scope, usage, assetId, open: false });
  const same = expanded.scope === scope && expanded.usage === usage && expanded.assetId === assetId;
  if (!same) setExpanded({ scope, usage, assetId, open: false });
  const open = same && expanded.open;
  const { admit, isCurrent } = useUsageInteraction(props, `${assetId}:${open}`);
  const listId = useId();
  return <div className="asset-disposition-controls" data-testid={`asset-timeline-usage-${assetId}`} data-no-asset-drag draggable={false}
    onPointerDown={event => event.stopPropagation()} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}>
    {uses === null ? <span className="asset-disposition-label unknown" role="status">{t('assets.usage.unknown')}</span>
      : uses.length === 0 ? <span className="asset-disposition-label" role="status">{t('assets.usage.zero')}</span>
        : <Button variant="ghost" size="sm" type="button" draggable={false} className="text-button" style={{ height: 'auto', justifyContent: 'flex-start', padding: 0, fontSize: 10, whiteSpace: 'normal', textAlign: 'left' }}
          data-testid={`asset-usage-expand-${assetId}`} aria-label={t(open ? 'assets.usage.collapseLabel' : 'assets.usage.expandLabel', { name: assetName, count: uses.length })} aria-expanded={open} aria-controls={listId} disabled={!visible}
          onClick={event => { event.stopPropagation(); admit(() => setExpanded({ scope, usage, assetId, open: !open })); }}>
          {t(open ? 'assets.usage.collapseSummary' : 'assets.usage.expandSummary', { count: uses.length })}
        </Button>}
    {uses !== null && uses.length > 0 && <ul id={listId} hidden={!open} aria-label={t('assets.usage.locations', { name: assetName })} style={{ listStyle: 'none', margin: 0, padding: 0, minWidth: 0 }}>
      {uses.map(use => <li key={use.clipId}>
        <Button variant="ghost" size="sm" type="button" draggable={false} style={destinationStyle} data-testid={`asset-usage-locate-${use.clipId}`}
          aria-label={t('assets.usage.locate', { clip: use.clipNameMissing ? t('assets.usage.unnamedClip') : use.clipName, track: use.trackName, frame: use.startFrame })} disabled={!visible || !open || !onLocate}
          title={t('assets.usage.locationDetails', { clip: use.clipNameMissing ? t('assets.usage.unnamedClip') : use.clipName, track: use.trackName, frame: use.startFrame, duration: use.durationFrames, revision: use.timelineRevision })}
          onClick={event => { event.stopPropagation(); if (open && onLocate) admit(() => onLocate(use, isCurrent)); }}>
          <span>{use.clipNameMissing ? t('assets.usage.unnamedClip') : use.clipName}</span><span className="asset-disposition-label">{t('assets.usage.start', { track: use.trackName, frame: use.startFrame })}</span>
        </Button>
      </li>)}
    </ul>}
  </div>;
}
