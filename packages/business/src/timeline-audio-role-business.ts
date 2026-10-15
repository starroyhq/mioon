import type {DatabaseSync} from 'node:sqlite';
import {readCurrentWorkspaceRole} from './workspace-schema-dispatch.ts';
import {TIMELINE_AUDIO_ROLE_PROFILE,type TimelineAudioRoleCapability} from '../../contracts/src/timeline-audio-role.ts';
/** A current read-only capability, not a persisted permission or an Agent grant. */
export function readTimelineAudioRoleCapability(db:DatabaseSync):TimelineAudioRoleCapability {
 const role=readCurrentWorkspaceRole(db);
 return {profileId:TIMELINE_AUDIO_ROLE_PROFILE,editable:role==='ordinary-38'||role==='restored-39-evidence'};
}
