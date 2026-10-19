/** Keep the original mounted input owner through external interruptions. This
 * retains presentation only; it never grants mutation or redirects a callback. */
export type ClipInspectorSnapshot = { key: string; scope: string; projectId: string; timeline: any; clip: any; asset: any; restored: boolean; workspaceOrigin?: string };
export type ClipInspectorRetention = { snapshot: ClipInspectorSnapshot | null; retained: boolean };
export function retainClipInspector(previous: ClipInspectorRetention, next: ClipInspectorSnapshot | null, state: { pending: boolean; dirty: boolean; connected: boolean }): ClipInspectorRetention {
  const old = previous.snapshot;
  const sameOwner = !!old && !!next && old.key === next.key && old.scope === next.scope && old.workspaceOrigin === next.workspaceOrigin && old.timeline.id === next.timeline.id && old.clip.assetId === next.clip.assetId && old.asset?.sha256 === next.asset?.sha256;
  const interrupted = !state.connected || !sameOwner;
  if (old && (state.pending || state.dirty && (previous.retained || interrupted))) {
    return { snapshot: old, retained: previous.retained || interrupted || state.pending && (old.timeline.revision !== next?.timeline.revision || JSON.stringify(old.clip) !== JSON.stringify(next?.clip)) };
  }
  return { snapshot: next, retained: false };
}
export function retainClipWorkbench(snapshot: ClipInspectorSnapshot | null, pending: boolean, dirty: boolean): boolean {
  return Boolean(snapshot && (pending || dirty));
}
