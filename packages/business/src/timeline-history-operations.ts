/** Operations which append a legacy editable snapshot. The native sequence
 * history has its own shared vocabulary in the sequence edit contract. */
export const TIMELINE_HISTORY_OPERATIONS = Object.freeze([
  'timeline.track.add', 'timeline.track.update',
  'timeline.clip.add', 'timeline.clip.update', 'timeline.clip.replaceSource',
  'timeline.clip.remove', 'timeline.clip.rippleRemove', 'timeline.clip.split',
  'timeline.clip.splitAtScenes', 'timeline.clip.crossfade', 'timeline.clip.setGains',
  'timeline.clip.setTransform', 'timeline.clip.setTransition', 'timeline.clip.refreshSources',
  'timeline.seed', 'timeline.shots.append',
  'timeline.subtitle.add', 'timeline.subtitle.update', 'timeline.subtitle.remove',
  'timeline.loudness.apply', 'agent.task.undo', 'project.version.restore', 'timeline.format.set',
] as const);

export type TimelineHistoryOperation = typeof TIMELINE_HISTORY_OPERATIONS[number];
