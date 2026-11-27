import type {AgentTaskTarget} from '../../../contracts/src/agent-tasks-v2.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../project-file/schema/databases.ts';
import type {PreparedAgentTaskTool} from './task-tools-v2.ts';

export function supportsSequenceCoEditing({db}: ProjectStore): boolean {
  return Number(db.prepare('PRAGMA project.user_version').get()?.user_version) >= FORMAT5_PROJECT_SCHEMA_VERSION;
}

const audioFields = new Set(['gain', 'fadeInFrames', 'fadeOutFrames', 'muted', 'volumeEnvelope', 'audioRole']);
const visualFields = new Set(['rect', 'transform', 'opacity', 'blendMode', 'transition', 'transitionIn', 'colour', 'layout']);
const timingFields = new Set(['startFrame', 'durationFrames', 'sourceInFrame', 'sourceSpanFrames', 'trackId', 'anchor', 'timing']);

export function coEditingClipWriteKinds(fields: readonly string[]): string[] {
  if (!fields.length || fields.some(field => !audioFields.has(field) && !visualFields.has(field) && !timingFields.has(field))) return ['timeline_clip'];
  const kinds: string[] = [];
  if (fields.some(field => audioFields.has(field))) kinds.push('timeline_clip_audio');
  if (fields.some(field => visualFields.has(field))) kinds.push('timeline_clip_visual');
  if (fields.some(field => timingFields.has(field))) kinds.push('timeline_clip_timing');
  return kinds;
}

function clipWriteKinds({operation, input}: PreparedAgentTaskTool): string[] {
  if (['timeline.clip.setGains', 'timeline.clip.crossfade', 'timeline.loudness.apply'].includes(operation)) return ['timeline_clip_audio'];
  if (['timeline.clip.setTransform', 'timeline.clip.setTransition'].includes(operation)) return ['timeline_clip_visual'];
  const patch = input.patch;
  if (operation !== 'timeline.clip.update' || !patch || typeof patch !== 'object' || Array.isArray(patch)) return ['timeline_clip'];
  return coEditingClipWriteKinds(Object.keys(patch));
}

/** Scoped write identities are separate from the existing object-level CAS
 * targets. Unknown changes and whole-object operations keep the whole scope. */
export function coEditingWriteTargets(prepared: PreparedAgentTaskTool): AgentTaskTarget[] {
  if (prepared.risk === 'read_only') return [];
  if (prepared.writeTargets) return prepared.writeTargets;
  const clipKinds = clipWriteKinds(prepared);
  return prepared.targets.flatMap(target =>
    target.kind === 'timeline_clip' ? clipKinds.map(kind => ({...target, kind})) : [target]);
}
