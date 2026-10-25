import {validateWorkspaceSchema60} from './workspace-schema-v60.ts';
import {validateWorkspaceRestoreSchemaV61} from './workspace-restore-schema-v61.ts';
import {validateWorkspaceStorageRestoreSchemaV59} from './workspace-storage-restore-schema-v59.ts';
import {validateWorkspaceSchema58} from './workspace-schema-v58.ts';
import {validateWorkspaceRestoreSchemaV59} from './workspace-restore-schema-v59.ts';
import {validateWorkspaceSchema56} from './workspace-schema-v56.ts';
import {validateWorkspaceRestoreSchemaV57} from './workspace-restore-schema-v57.ts';
import {validateWorkspaceSchema54} from './workspace-schema-v54.ts';
import {validateWorkspaceRestoreSchemaV55} from './workspace-restore-schema-v55.ts';
import type {DatabaseSync} from 'node:sqlite';
import {readCurrentWorkspaceRole} from './workspace-schema-dispatch.ts';
import {validateWorkspaceSchema52} from './workspace-schema-v52.ts';
import {validateWorkspaceRestoreSchemaV53} from './workspace-restore-schema-v53.ts';
import {TIMELINE_AUDIO_ROLE_PROFILE,type TimelineAudioRoleCapability} from '../../contracts/src/timeline-audio-role.ts';
/** A current read-only capability, not a persisted permission or an Agent grant. */
export function readTimelineAudioRoleCapability(db:DatabaseSync):TimelineAudioRoleCapability {
 const role=readCurrentWorkspaceRole(db);
 if(role==='ordinary-60')validateWorkspaceSchema60(db);
 else if(role==='restored-61-evidence')validateWorkspaceRestoreSchemaV61(db);
 else if(role==='storage-private-59-evidence')validateWorkspaceStorageRestoreSchemaV59(db);
 else if(role==='ordinary-58')validateWorkspaceSchema58(db);
 else if(role==='restored-59-evidence')validateWorkspaceRestoreSchemaV59(db);
 else if(role==='ordinary-56')validateWorkspaceSchema56(db);
 else if(role==='restored-57-evidence')validateWorkspaceRestoreSchemaV57(db);
 else if(role==='ordinary-54')validateWorkspaceSchema54(db);
 else if(role==='restored-55-evidence')validateWorkspaceRestoreSchemaV55(db);
 else if(role==='ordinary-52')validateWorkspaceSchema52(db);
 else if(role==='restored-53-evidence')validateWorkspaceRestoreSchemaV53(db);
 return {profileId:TIMELINE_AUDIO_ROLE_PROFILE,editable:role==='ordinary-60'||role==='restored-61-evidence'||role==='ordinary-38'||role==='restored-39-evidence'||role==='ordinary-40'||role==='restored-41-evidence'||role==='ordinary-44'||role==='restored-45-evidence'||role==='ordinary-48'||role==='restored-49-evidence'||role==='ordinary-50'||role==='restored-51-evidence'||role==='ordinary-58'||role==='restored-59-evidence'||role==='ordinary-56'||role==='restored-57-evidence'||role==='ordinary-54'||role==='restored-55-evidence'||role==='ordinary-52'||role==='restored-53-evidence'};
}
