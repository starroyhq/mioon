import type {DatabaseSync} from 'node:sqlite';
import {readCurrentWorkspaceRole,isWorkspaceRoleSince} from './workspace-schema-dispatch.ts';
import {validateFixedWorkspaceRole} from './workspace-role-validation.ts';
import {TIMELINE_AUDIO_ROLE_PROFILE,type TimelineAudioRoleCapability} from '../../contracts/src/timeline-audio-role.ts';
/** A current read-only capability, not a persisted permission or an Agent grant. */
export function readTimelineAudioRoleCapability(db:DatabaseSync):TimelineAudioRoleCapability {
 const role=readCurrentWorkspaceRole(db);
 // Roles from schema52 on, and the private restore59 evidence, must first pass
 // their complete fixed profile. Audio roles are editable from schema38 on;
 // the private storage roles never edit them.
 if(isWorkspaceRoleSince(role,52)||role==='storage-private-59-evidence')validateFixedWorkspaceRole(db,role);
 return {profileId:TIMELINE_AUDIO_ROLE_PROFILE,editable:isWorkspaceRoleSince(role,38)};
}
