import type { TimelineAssetUse, UsageSnapshot } from './timeline-asset-usage.ts';

export interface AssetUseNavigationContext {
  readonly active: boolean;
  readonly projectId: string;
  readonly projectEpoch: number;
  readonly navigationEpoch: number;
  readonly panelIntent: number;
  readonly attempt: number;
  readonly workspaceScope: string | null;
  readonly usage: UsageSnapshot;
}
export interface AssetUseNavigation {
  read(): AssetUseNavigationContext;
  isVisible(): boolean;
  confirm(canDiscard: () => boolean): Promise<boolean>;
  reveal(use: TimelineAssetUse): void;
}
const fields = ['projectId', 'timelineId', 'timelineRevision', 'assetId', 'clipId', 'trackId', 'clipName', 'trackName', 'startFrame', 'durationFrames', 'sourceInFrame', 'sourceIdentity'] as const;
/** The display snapshot is only a read identity, never permission to edit. */
export function matchesTimelineAssetUse(snapshot: UsageSnapshot, use: TimelineAssetUse): boolean {
  return snapshot.status === 'ready' && snapshot.projectId === use.projectId && snapshot.timelineId === use.timelineId &&
    snapshot.timelineRevision === use.timelineRevision && Object.hasOwn(snapshot.usesByAssetId, use.assetId) &&
    snapshot.usesByAssetId[use.assetId]!.some(current => fields.every(key => current[key] === use[key]));
}
const sameOwner = (before: AssetUseNavigationContext, after: AssetUseNavigationContext): boolean =>
  before.projectId === after.projectId && before.projectEpoch === after.projectEpoch && before.navigationEpoch === after.navigationEpoch &&
  before.panelIntent === after.panelIntent && before.attempt === after.attempt && before.workspaceScope !== null && before.workspaceScope === after.workspaceScope;

/** A single explicit location choice. Re-check before every permitted discard and
 * after confirmation; refresh, new navigation, hiding and unmount invalidate it. */
export async function locateTimelineAssetUse(input: TimelineAssetUse, actions: AssetUseNavigation): Promise<boolean> {
  const target = Object.freeze({ ...input }), captured = actions.read();
  const current = (): boolean => {
    const latest = actions.read();
    return latest.active && actions.isVisible() && sameOwner(captured, latest) && latest.projectId === target.projectId && matchesTimelineAssetUse(latest.usage, target);
  };
  if (!current() || !await actions.confirm(current) || !current()) return false;
  actions.reveal(target);
  return true;
}

/** Scroll only the already-rendered timeline viewport. No selector is built from
 * source text; delayed layout callbacks cannot override a newer selection. */
export function revealTimelineAssetUse(
  clipId: string,
  current: () => boolean,
  getViewport: () => HTMLElement | null,
  nextFrame: (callback: () => void) => unknown,
): void {
  nextFrame(() => {
    if (!current()) return;
    nextFrame(() => {
      if (!current()) return;
      const viewport = getViewport();
      const clip = viewport && Array.from(viewport.querySelectorAll<HTMLElement>('[data-testid]')).find(element => element.dataset.testid === `timeline-clip-${clipId}`);
      if (!viewport || !clip) return;
      const bounds = viewport.getBoundingClientRect(), target = clip.getBoundingClientRect();
      if (target.left < bounds.left + 160 || target.right > bounds.right) viewport.scrollLeft += target.left - bounds.left - 168;
      if (target.top < bounds.top || target.bottom > bounds.bottom) viewport.scrollTop += target.top - bounds.top - 8;
    });
  });
}
