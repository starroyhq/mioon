/** Audio planning may inspect video/audio sources. Image-only and empty clips
 * have no audio bytes; an unresolved asset cannot be treated as an empty clip. */
export function timelineAudioMediaReadable(
  timeline: {readonly clips: readonly {readonly assetId?: string | null}[]} | null | undefined,
  assets: readonly {readonly id: string; readonly mimeType: string}[],
  canRead: (asset: unknown) => boolean,
): boolean {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return !timeline || timeline.clips.every(clip => {
    if (!clip.assetId) return true;
    const asset = byId.get(clip.assetId);
    return Boolean(asset && (asset.mimeType.startsWith('image/') || canRead(asset)));
  });
}
