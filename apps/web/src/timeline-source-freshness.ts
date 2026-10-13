// A timeline clip freezes the generated version it was created from. When its shot later selects another version the
// clip keeps playing the old one, so the storyboard export and the timeline export silently disagree. These helpers
// find such clips so the timeline and inspector can say so; nothing here changes a clip.
export interface FreshnessClip { id: string; assetId?: string | null; shotId?: string | null; versionId?: string | null }
export interface FreshnessShot { id: string; title?: string; selectedVersionId?: string | null }
export interface FreshnessVersion { id: string; assetId?: string | null; shotId?: string; number?: number }
export interface StaleClipSource {
  clipId: string; shotId: string; shotTitle: string;
  versionId: string; versionNumber: number | null;
  selectedVersionId: string; selectedVersionNumber: number | null;
}

// Clips created from the storyboard or the library carry only the asset they froze, not the version they came from,
// so the version is found through that asset (every generated version owns its own asset). Explicit provenance wins.
export function clipVersionOf(clip: FreshnessClip, versions: readonly FreshnessVersion[]): { versionId: string; shotId: string } | null {
  const version = clip.versionId ? versions.find(item => item.id === clip.versionId) : clip.assetId ? versions.find(item => item.assetId === clip.assetId) : undefined;
  const versionId = clip.versionId ?? version?.id, shotId = clip.shotId ?? version?.shotId;
  return versionId && shotId ? { versionId, shotId } : null;
}

export function staleClipSources(clips: readonly FreshnessClip[], shots: readonly FreshnessShot[], versions: readonly FreshnessVersion[]): Map<string, StaleClipSource> {
  const stale = new Map<string, StaleClipSource>();
  if (!clips.length || !shots.length) return stale;
  const shotById = new Map(shots.map(shot => [shot.id, shot] as const));
  const numberOf = (id: string) => { const number = versions.find(version => version.id === id)?.number; return typeof number === 'number' ? number : null; };
  for (const clip of clips) {
    const origin = clipVersionOf(clip, versions);
    if (!origin) continue;
    const shot = shotById.get(origin.shotId);
    if (!shot?.selectedVersionId || shot.selectedVersionId === origin.versionId) continue;
    stale.set(clip.id, { clipId: clip.id, shotId: shot.id, shotTitle: shot.title || '镜头',
      versionId: origin.versionId, versionNumber: numberOf(origin.versionId),
      selectedVersionId: shot.selectedVersionId, selectedVersionNumber: numberOf(shot.selectedVersionId) });
  }
  return stale;
}

export function staleSourceSentence(stale: StaleClipSource): string {
  const label = (number: number | null) => number === null ? '其他版本' : `V${number}`;
  return `镜头「${stale.shotTitle}」已改选 ${label(stale.selectedVersionNumber)}，此片段仍是 ${label(stale.versionNumber)}。`;
}
