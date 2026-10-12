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
  const { projectId, usage, filter, onFilter, visible } = props;
  const { admit } = useUsageInteraction(props);
  const ready = Boolean(projectId && usage?.status === 'ready' && usage.projectId === projectId);
  return <div data-testid="asset-timeline-usage-filters">
    <div className="asset-disposition-filter" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }} role="group" aria-label="当前时间线使用筛选">
      <Button variant="ghost" size="sm" type="button" aria-label="显示全部时间线使用状态" data-testid="asset-usage-filter-all" aria-pressed={filter === 'all'} disabled={!visible || !projectId} onClick={() => admit(() => onFilter('all'))}>全部</Button>
      <Button variant="ghost" size="sm" type="button" data-testid="asset-usage-filter-unused" aria-pressed={filter === 'unused'} disabled={!visible || !projectId} onClick={() => admit(() => onFilter('unused'))}>未用于本时间线</Button>
    </div>
    <div className="asset-disposition-summary" style={{ minHeight: 0 }}>
      <span role="status" data-testid="asset-usage-snapshot-status">{ready ? `当前时间线 · 已保存 rev ${usage?.timelineRevision}` : '当前时间线使用情况暂不可用，筛选仍保留未知素材。'}</span>
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
    {uses === null ? <span className="asset-disposition-label unknown" role="status">当前时间线 · 使用情况未知</span>
      : uses.length === 0 ? <span className="asset-disposition-label" role="status">当前时间线 · 0 次使用</span>
        : <Button variant="ghost" size="sm" type="button" draggable={false} className="text-button" style={{ height: 'auto', justifyContent: 'flex-start', padding: 0, fontSize: 10, whiteSpace: 'normal', textAlign: 'left' }}
          data-testid={`asset-usage-expand-${assetId}`} aria-label={`${assetName} 在当前时间线使用 ${uses.length} 次，${open ? '收起' : '查看'}片段位置`} aria-expanded={open} aria-controls={listId} disabled={!visible}
          onClick={event => { event.stopPropagation(); admit(() => setExpanded({ scope, usage, assetId, open: !open })); }}>
          当前时间线 · {uses.length} 次使用 · {open ? '收起' : '展开'}
        </Button>}
    {uses !== null && uses.length > 0 && <ul id={listId} hidden={!open} aria-label={`${assetName} 的时间线片段位置`} style={{ listStyle: 'none', margin: 0, padding: 0, minWidth: 0 }}>
      {uses.map(use => <li key={use.clipId}>
        <Button variant="ghost" size="sm" type="button" draggable={false} style={destinationStyle} data-testid={`asset-usage-locate-${use.clipId}`}
          aria-label={`定位片段 ${use.clipName}，轨道 ${use.trackName}，起点 ${use.startFrame} 帧`} disabled={!visible || !open || !onLocate}
          title={`${use.clipName} · ${use.trackName} · 起点 ${use.startFrame} 帧 · 长度 ${use.durationFrames} 帧 · 已保存 rev ${use.timelineRevision}`}
          onClick={event => { event.stopPropagation(); if (open && onLocate) admit(() => onLocate(use, isCurrent)); }}>
          <span>{use.clipName}</span><span className="asset-disposition-label">{use.trackName} · 起点 {use.startFrame} 帧</span>
        </Button>
      </li>)}
    </ul>}
  </div>;
}
