import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV41} from './workspace-restore-schema-v41.ts';
import {migrateRippleTaskSchema} from './workspace-ripple-schema.ts';
import {classifyWorkspaceSchemaV44V45} from './workspace-restore-schema-v45.ts';
import {assertNoRippleWorkspaceOpacity} from './workspace-ripple-evidence.ts';

export function validateWorkspaceSchema44(db: DatabaseSync): void {
  const profile = classifyWorkspaceSchemaV44V45(db);
  if (profile.schemaVersion !== 44 || profile.profile !== 'ordinary')
    throw Object.assign(new Error('Expected ordinary44.'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
}

/** Ordinary44 descends directly from40. It never constructs or admits opacity
 * candidate42/43; version numbers do not define a contiguous capability chain. */
export function initializeWorkspaceSchema44(db: DatabaseSync, initializeThrough24: (db: DatabaseSync) => void): void {
  const source = createWorkspaceRestoreProfileV41(initializeThrough24);
  migrateRippleTaskSchema(db, 44, connection => {
    let profile;
    try {
      profile = source.classifyWorkspaceSchemaV40V41(connection);
    } catch (strictFailure) {
      // Ordinary startup must keep upgrading long-retained archives that carry
      // unknown, application-unmanaged tables. The tolerant pass re-proves the
      // complete fixed catalog, markers and row validators; fixed restore and
      // candidate classification remain strict.
      try { profile = source.classifyWorkspaceSchemaV40V41AllowingUnknown(connection); }
      catch { throw strictFailure; }
    }
    if (profile.schemaVersion !== 40 || profile.profile !== 'ordinary')
      throw Object.assign(new Error('Ripple migration requires ordinary40.'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
    assertNoRippleWorkspaceOpacity(connection);
  });
}
