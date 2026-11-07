/** Operations which append an editable snapshot, not every client mutation.
 * Writers use this literal type and readers share this exact vocabulary. */
export const TIMELINE_HISTORY_OPERATIONS = Object.freeze([
  'timeline.track.add', 'timeline.track.update',
  'timeline.clip.add', 'timeline.clip.update', 'timeline.clip.replaceSource',
  'timeline.clip.remove', 'timeline.clip.rippleRemove', 'timeline.clip.split',
  'timeline.clip.splitAtScenes', 'timeline.clip.crossfade', 'timeline.clip.setGains',
  'timeline.clip.setTransform', 'timeline.clip.setTransition', 'timeline.clip.refreshSources',
  'timeline.seed', 'timeline.shots.append',
  'timeline.subtitle.add', 'timeline.subtitle.update', 'timeline.subtitle.remove',
  'timeline.loudness.apply', 'agent.task.undo', 'project.version.restore',
] as const);

export type TimelineHistoryOperation = typeof TIMELINE_HISTORY_OPERATIONS[number];
