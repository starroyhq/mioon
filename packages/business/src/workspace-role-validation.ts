import type {DatabaseSync} from 'node:sqlite';
import type {CurrentWorkspaceRole} from './workspace-schema-dispatch.ts';
import {validateWorkspaceSchema44} from './workspace-schema-v44.ts';
import {validateWorkspaceRestoreSchemaV45} from './workspace-restore-schema-v45.ts';
import {validateWorkspaceSchema48} from './workspace-schema-v48.ts';
import {validateWorkspaceRestoreSchemaV49} from './workspace-restore-schema-v49.ts';
import {validateWorkspaceSchema50} from './workspace-schema-v50.ts';
import {validateWorkspaceRestoreSchemaV51} from './workspace-restore-schema-v51.ts';
import {validateWorkspaceSchema52} from './workspace-schema-v52.ts';
import {validateWorkspaceRestoreSchemaV53} from './workspace-restore-schema-v53.ts';
import {validateWorkspaceSchema54} from './workspace-schema-v54.ts';
import {validateWorkspaceRestoreSchemaV55} from './workspace-restore-schema-v55.ts';
import {validateWorkspaceSchema56} from './workspace-schema-v56.ts';
import {validateWorkspaceRestoreSchemaV57} from './workspace-restore-schema-v57.ts';
import {validateWorkspaceSchema58} from './workspace-schema-v58.ts';
import {validateWorkspaceRestoreSchemaV59} from './workspace-restore-schema-v59.ts';
import {validateWorkspaceStorageRestoreSchemaV59} from './workspace-storage-restore-schema-v59.ts';
import {validateWorkspaceSchema60} from './workspace-schema-v60.ts';
import {validateWorkspaceRestoreSchemaV61} from './workspace-restore-schema-v61.ts';
import {validateWorkspaceSchema62} from './workspace-schema-v62.ts';
import {validateWorkspaceRestoreSchemaV63} from './workspace-restore-schema-v63.ts';
import {validateWorkspaceSchema64} from './workspace-schema-v64.ts';
import {validateWorkspaceRestoreSchemaV65} from './workspace-restore-schema-v65.ts';

/** The standalone complete fixed-profile validator of each role from schema44
 * on. Capability readers validate a role here instead of keeping their own
 * role chains, so a new schema registers its ordinary and restored validators
 * once. A role without an entry fails closed. */
const validators: Readonly<Partial<Record<CurrentWorkspaceRole, (db: DatabaseSync) => unknown>>> = Object.freeze({
  'ordinary-44': db => validateWorkspaceSchema44(db), 'restored-45-evidence': db => validateWorkspaceRestoreSchemaV45(db),
  'ordinary-48': db => validateWorkspaceSchema48(db), 'restored-49-evidence': db => validateWorkspaceRestoreSchemaV49(db),
  'ordinary-50': db => validateWorkspaceSchema50(db), 'restored-51-evidence': db => validateWorkspaceRestoreSchemaV51(db),
  'ordinary-52': db => validateWorkspaceSchema52(db), 'restored-53-evidence': db => validateWorkspaceRestoreSchemaV53(db),
  'ordinary-54': db => validateWorkspaceSchema54(db), 'restored-55-evidence': db => validateWorkspaceRestoreSchemaV55(db),
  'ordinary-56': db => validateWorkspaceSchema56(db), 'restored-57-evidence': db => validateWorkspaceRestoreSchemaV57(db),
  'ordinary-58': db => validateWorkspaceSchema58(db), 'restored-59-evidence': db => validateWorkspaceRestoreSchemaV59(db),
  'storage-private-59-evidence': db => validateWorkspaceStorageRestoreSchemaV59(db),
  'ordinary-60': db => validateWorkspaceSchema60(db), 'restored-61-evidence': db => validateWorkspaceRestoreSchemaV61(db),
  'ordinary-62': db => validateWorkspaceSchema62(db), 'restored-63-evidence': db => validateWorkspaceRestoreSchemaV63(db),
  'ordinary-64': db => validateWorkspaceSchema64(db), 'restored-65-evidence': db => validateWorkspaceRestoreSchemaV65(db),
});

/** Validates the complete fixed profile of `role`; never grants a capability. */
export function validateFixedWorkspaceRole(db: DatabaseSync, role: CurrentWorkspaceRole): void {
  const validate = Object.hasOwn(validators, role) ? validators[role] : undefined;
  if (!validate) throw Object.assign(new Error('Workspace schema role has no fixed profile validator'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  validate(db);
}
