// Fades use the 30fps timeline clock. Missing keys are legacy zeroes; this
// validator never normalizes or mutates clips, snapshots, or caller inputs.
export const TIMELINE_FADE_MAX_FRAMES = 18000;
export function getTimelineFadeIssue(clip, asset) {
  const fadeInFrames = clip.fadeInFrames === undefined ? 0 : clip.fadeInFrames;
  const fadeOutFrames = clip.fadeOutFrames === undefined ? 0 : clip.fadeOutFrames;
  const details = {clipId: clip.id, durationFrames: clip.durationFrames, fadeInFrames, fadeOutFrames};
  for (const [field, value] of Object.entries({fadeInFrames, fadeOutFrames})) {
    if (!Number.isInteger(value) || value < 0 || value > TIMELINE_FADE_MAX_FRAMES)
      return {code: 'INVALID_FADE', message: '音频淡入和淡出必须为 0–18000 之间的整数帧', details: {...details, field}};
  }
  if (fadeInFrames > clip.durationFrames || fadeOutFrames > clip.durationFrames || fadeInFrames + fadeOutFrames > clip.durationFrames)
    return {code: 'INVALID_FADE', message: '淡入与淡出的帧数之和不能超过片段时长；请同时调整淡入、淡出或时长', details};
  if ((fadeInFrames > 0 || fadeOutFrames > 0) &&
      (asset?.hasAudio !== true || !/^(audio|video)\//.test(asset?.mimeType || '')))
    return {code: 'FADE_AUDIO_UNSUPPORTED', message: '只有已确认包含音频的音频或视频素材才支持非零淡入淡出', details: {...details, assetId: asset?.id}};
  return null;
}
