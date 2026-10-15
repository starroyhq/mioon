import type {DatabaseSync} from 'node:sqlite';
import {VOLUME_ENVELOPE_PROFILE} from '../../contracts/src/timeline-volume-envelope.mjs';
import type {TimelineVolumeEnvelopeCapability} from '../../contracts/src/timeline-volume-envelope-capability.ts';
import {readCurrentWorkspaceRole} from './workspace-schema-dispatch.ts';
import {validateWorkspaceSchema40} from './workspace-schema-v40.ts';
import {createWorkspaceRestoreProfileV41} from './workspace-restore-schema-v41.ts';
import {initializeWorkspaceSchemaThrough24} from './workspace-fixed-schema.mjs';

const restored41=createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24);
/** Validate the complete exact profile, not merely a marker chain. Restored
 * editability still requires the unchanged explicit origin/invocation guards. */
export function readTimelineVolumeEnvelopeCapability(db:DatabaseSync):TimelineVolumeEnvelopeCapability {
 let editable=false;
 try{
  const role=readCurrentWorkspaceRole(db);
  if(role==='ordinary-40'){
   const profile=restored41.classifyWorkspaceSchemaV40V41(db);
   if(profile.schemaVersion===40&&profile.profile==='ordinary'){validateWorkspaceSchema40(db);editable=true;}
  }
  else if(role==='restored-41-evidence'){restored41.validateWorkspaceRestoreSchemaV41(db);editable=true;}
 }catch{ /* Unknown, incomplete or corrupted profiles never advertise editing. */ }
 return {profileId:VOLUME_ENVELOPE_PROFILE,editable};
}
