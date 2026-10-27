import type {DatabaseSync} from 'node:sqlite';
import {VOLUME_ENVELOPE_PROFILE} from '../../contracts/src/timeline-volume-envelope.ts';
import type {TimelineVolumeEnvelopeCapability} from '../../contracts/src/timeline-volume-envelope-capability.ts';
import {readCurrentWorkspaceRole,isWorkspaceRoleSince} from './workspace-schema-dispatch.ts';
import {validateFixedWorkspaceRole} from './workspace-role-validation.ts';
import {validateWorkspaceSchema40} from './workspace-schema-v40.ts';
import {requireWorkspaceEnvelopeRuntime} from './workspace-envelope-runtime.ts';

/** Validate the complete exact profile, not merely a marker chain. Restored
 * editability still requires the unchanged explicit origin/invocation guards. */
export function readTimelineVolumeEnvelopeCapability(db:DatabaseSync):TimelineVolumeEnvelopeCapability {
 let editable=false;
 try{
  const runtime=requireWorkspaceEnvelopeRuntime();
  const role=readCurrentWorkspaceRole(db);
  if(role==='ordinary-40'){
   const profile=runtime.classify40Or41(db);
   if(profile.schemaVersion===40&&profile.profile==='ordinary'){validateWorkspaceSchema40(db);editable=true;}
  }
  else if(role==='restored-41-evidence'){runtime.validateRestored41(db);editable=true;}
  // The private restore59 evidence is validated but never advertises editing.
  else if(role==='storage-private-59-evidence')validateFixedWorkspaceRole(db,role);
  else if(isWorkspaceRoleSince(role,44)){validateFixedWorkspaceRole(db,role);editable=true;}
 }catch{ /* Unknown, incomplete or corrupted profiles never advertise editing. */ }
 return {profileId:VOLUME_ENVELOPE_PROFILE,editable};
}
