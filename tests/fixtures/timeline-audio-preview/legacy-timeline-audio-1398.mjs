// The render graph is segmented at every clip edge, including other tracks.
// afade uses its input PTS as the sample position. Give it clip-relative integer
// sample timestamps, then let the caller reset PTS for the segment's mixer.
// Fixed 30 fps / 48 kHz output has exactly 1600 samples per timeline frame.
export function timelineAudioFadeFilters(clip, segmentStartFrame) {
  const fadeIn = clip.fadeInFrames ?? 0, fadeOut = clip.fadeOutFrames ?? 0;
  if (fadeIn === 0 && fadeOut === 0) return '';
  const offsetSamples = (segmentStartFrame - clip.startFrame) * 1600;
  const filters = ['asettb=1/48000', `asetpts=N+${offsetSamples}`];
  if (fadeIn > 0) filters.push(`afade=t=in:ss=0:ns=${fadeIn * 1600}:curve=tri`);
  if (fadeOut > 0) filters.push(`afade=t=out:ss=${(clip.durationFrames - fadeOut) * 1600}:ns=${fadeOut * 1600}:curve=tri`);
  return filters.join(',') + ',';
}
