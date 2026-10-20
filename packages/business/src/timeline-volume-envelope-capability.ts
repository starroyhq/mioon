import {validateWorkspaceSchema50} from './workspace-schema-v50.ts';
import {validateWorkspaceRestoreSchemaV51} from './workspace-restore-schema-v51.ts';
import {validateWorkspaceSchema52} from './workspace-schema-v52.ts';
import {validateWorkspaceRestoreSchemaV53} from './workspace-restore-schema-v53.ts';
import {validateWorkspaceSchema48} from './workspace-schema-v48.ts';
import {validateWorkspaceRestoreSchemaV49} from './workspace-restore-schema-v49.ts';
import type {DatabaseSync} from 'node:sqlite';
import {VOLUME_ENVELOPE_PROFILE} from '../../contracts/src/timeline-volume-envelope.ts';
import type {TimelineVolumeEnvelopeCapability} from '../../contracts/src/timeline-volume-envelope-capability.ts';
import {readCurrentWorkspaceRole} from './workspace-schema-dispatch.ts';
import {validateWorkspaceSchema40} from './workspace-schema-v40.ts';
import {requireWorkspaceEnvelopeRuntime} from './workspace-envelope-runtime.ts';
import {validateWorkspaceSchema44} from './workspace-schema-v44.ts';
import {validateWorkspaceRestoreSchemaV45} from './workspace-restore-schema-v45.ts';

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
  else if(role==='ordinary-52'){validateWorkspaceSchema52(db);editable=true;}
  else if(role==='restored-53-evidence'){validateWorkspaceRestoreSchemaV53(db);editable=true;}
  else if(role==='ordinary-50'){validateWorkspaceSchema50(db);editable=true;}
  else if(role==='restored-51-evidence'){validateWorkspaceRestoreSchemaV51(db);editable=true;}
  else if(role==='ordinary-48'){validateWorkspaceSchema48(db);editable=true;}
  else if(role==='restored-49-evidence'){validateWorkspaceRestoreSchemaV49(db);editable=true;}
  else if(role==='ordinary-44'){validateWorkspaceSchema44(db);editable=true;}
  else if(role==='restored-45-evidence'){validateWorkspaceRestoreSchemaV45(db);editable=true;}
 }catch{ /* Unknown, incomplete or corrupted profiles never advertise editing. */ }
 return {profileId:VOLUME_ENVELOPE_PROFILE,editable};
}
