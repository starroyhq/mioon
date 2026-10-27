import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_SCHEMA_LINEAGE, WORKSPACE_ORDINARY_SCHEMAS, WORKSPACE_RESTORED_SCHEMAS, WORKSPACE_RESTORE_PROFILES,
  workspaceSchemasSince, restoredWorkspaceSchemasSince, isWorkspaceSchemaSince, isRestoredWorkspaceSchemaSince,
} from '../packages/contracts/src/workspace-schema-lineage.ts';
import type {WorkspaceOrdinarySchema} from '../packages/contracts/src/workspace-schema-lineage.ts';
import {
  workspaceBackupSourceSchemaVersion, workspaceRestorationPairSchema, workspaceRestoreProfile,
  workspaceRestoreSourceVersion, workspaceRestoreDatabaseVersion,
} from '../packages/contracts/src/workspace-schema-profiles.ts';
import {isWorkspaceRoleSince, isPrivateStorageWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import type {CurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {validateFixedWorkspaceRole} from '../packages/business/src/workspace-role-validation.ts';
import {DatabaseSync} from 'node:sqlite';

// Expectations here derive from the lineage itself or from versions that can
// never join it (the lineage only appends after its newest entry), so a new
// schema version needs no edit in this file.
const neverLineage = [0, 1, 23, 42, 43, 46, 47, 26.5, '26', null, undefined] as const;
const ordinaryRole = (version: number) => (version === 24 ? 'ordinary-through-24' : `ordinary-${version}`) as CurrentWorkspaceRole;
const restoredRole = (version: number) => `restored-${version}-evidence` as CurrentWorkspaceRole;

test('the lineage is explicit, ordered and pairs each ordinary schema with the next restored version', () => {
  assert.deepEqual(WORKSPACE_SCHEMA_LINEAGE[0], {ordinary: 24, restored: 25, profile: 'restored-local-v1'});
  assert.equal(Object.isFrozen(WORKSPACE_SCHEMA_LINEAGE), true);
  for (const [index, entry] of WORKSPACE_SCHEMA_LINEAGE.entries()) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(entry.restored, entry.ordinary + 1);
    assert.match(entry.profile, /^restored-local-v[1-9][0-9]*$/);
    if (index > 0) {
      const previous = WORKSPACE_SCHEMA_LINEAGE[index - 1]!;
      assert.ok(entry.ordinary > previous.ordinary && entry.ordinary % 2 === 0, `${entry.ordinary} follows ${previous.ordinary}`);
      assert.ok(Number(entry.profile.slice('restored-local-v'.length)) > Number(previous.profile.slice('restored-local-v'.length)), `${entry.profile} follows ${previous.profile}`);
    }
  }
  assert.deepEqual(WORKSPACE_ORDINARY_SCHEMAS, WORKSPACE_SCHEMA_LINEAGE.map(entry => entry.ordinary));
  assert.deepEqual(WORKSPACE_RESTORED_SCHEMAS, WORKSPACE_SCHEMA_LINEAGE.map(entry => entry.restored));
  assert.deepEqual(WORKSPACE_RESTORE_PROFILES, WORKSPACE_SCHEMA_LINEAGE.map(entry => entry.profile));
  for (const value of [42, 43, 46, 47]) assert.equal([...WORKSPACE_ORDINARY_SCHEMAS, ...WORKSPACE_RESTORED_SCHEMAS].includes(value as never), false);
});

test('since helpers are exact lineage suffixes and refuse versions outside the lineage', () => {
  for (const [index, {ordinary}] of WORKSPACE_SCHEMA_LINEAGE.entries()) {
    assert.deepEqual(workspaceSchemasSince(ordinary), WORKSPACE_ORDINARY_SCHEMAS.slice(index));
    assert.deepEqual(restoredWorkspaceSchemasSince(ordinary), WORKSPACE_RESTORED_SCHEMAS.slice(index));
    assert.equal(Object.isFrozen(workspaceSchemasSince(ordinary)), true);
    for (const [other, entry] of WORKSPACE_SCHEMA_LINEAGE.entries()) {
      assert.equal(isWorkspaceSchemaSince(ordinary, entry.ordinary), other >= index);
      assert.equal(isRestoredWorkspaceSchemaSince(ordinary, entry.restored), other >= index);
      // Ordinary and restored numbers never stand in for each other.
      assert.equal(isWorkspaceSchemaSince(ordinary, entry.restored), false);
      assert.equal(isRestoredWorkspaceSchemaSince(ordinary, entry.ordinary), false);
    }
    for (const value of neverLineage) {
      assert.equal(isWorkspaceSchemaSince(ordinary, value), false, String(value));
      assert.equal(isRestoredWorkspaceSchemaSince(ordinary, value), false, String(value));
    }
  }
  for (const since of [25, 42, 61, 1000] as unknown as WorkspaceOrdinarySchema[]) {
    assert.throws(() => workspaceSchemasSince(since), TypeError);
    assert.throws(() => isRestoredWorkspaceSchemaSince(since, 63), TypeError);
  }
});

test('contract unions accept exactly the lineage and its fixed restore pairs', () => {
  for (let version = 1; version <= 24; version++) assert.equal(workspaceBackupSourceSchemaVersion.safeParse(version).success, true);
  for (const version of WORKSPACE_ORDINARY_SCHEMAS) {
    assert.equal(workspaceBackupSourceSchemaVersion.safeParse(version).success, true);
    assert.equal(workspaceRestoreSourceVersion.safeParse(version).success, true);
    assert.equal(workspaceRestoreDatabaseVersion.safeParse(version).success, false);
  }
  for (const version of WORKSPACE_RESTORED_SCHEMAS) {
    assert.equal(workspaceBackupSourceSchemaVersion.safeParse(version).success, false);
    assert.equal(workspaceRestoreSourceVersion.safeParse(version).success, false);
    assert.equal(workspaceRestoreDatabaseVersion.safeParse(version).success, true);
  }
  for (const value of [0, 42, 43, 46, 47, 26.5, '26'])
    for (const schema of [workspaceBackupSourceSchemaVersion, workspaceRestoreSourceVersion, workspaceRestoreDatabaseVersion])
      assert.equal(schema.safeParse(value).success, false, String(value));
  assert.deepEqual(workspaceRestoreProfile.options, WORKSPACE_RESTORE_PROFILES);
  for (const entry of WORKSPACE_SCHEMA_LINEAGE) {
    const pair = {profile: entry.profile, sourceSchema: entry.ordinary, databaseSchemaVersion: entry.restored};
    assert.equal(workspaceRestorationPairSchema.safeParse(pair).success, true, entry.profile);
    assert.equal(workspaceRestorationPairSchema.safeParse({...pair, extra: true}).success, false);
    for (const other of WORKSPACE_SCHEMA_LINEAGE) if (other !== entry) {
      assert.equal(workspaceRestorationPairSchema.safeParse({...pair, sourceSchema: other.ordinary}).success, false);
      assert.equal(workspaceRestorationPairSchema.safeParse({...pair, databaseSchemaVersion: other.restored}).success, false);
      assert.equal(workspaceRestorationPairSchema.safeParse({...pair, profile: other.profile}).success, false);
    }
  }
  assert.equal(workspaceRestorationPairSchema.safeParse({profile: 'restored-local-v10', sourceSchema: 42, databaseSchemaVersion: 43}).success, false);
});

test('role capabilities follow the lineage and never extend to private storage or unknown roles', () => {
  for (const [index, {ordinary, restored}] of WORKSPACE_SCHEMA_LINEAGE.entries()) {
    for (const [sinceIndex, {ordinary: since}] of WORKSPACE_SCHEMA_LINEAGE.entries()) {
      assert.equal(isWorkspaceRoleSince(ordinaryRole(ordinary), since), index >= sinceIndex);
      assert.equal(isWorkspaceRoleSince(restoredRole(restored), since), index >= sinceIndex);
      assert.equal(isWorkspaceRoleSince(ordinaryRole(ordinary), since, 'ordinary'), index >= sinceIndex);
      assert.equal(isWorkspaceRoleSince(ordinaryRole(ordinary), since, 'restored'), false);
      assert.equal(isWorkspaceRoleSince(restoredRole(restored), since, 'restored'), index >= sinceIndex);
      assert.equal(isWorkspaceRoleSince(restoredRole(restored), since, 'ordinary'), false);
    }
    assert.equal(isPrivateStorageWorkspaceRole(ordinaryRole(ordinary)), false);
    assert.equal(isPrivateStorageWorkspaceRole(restoredRole(restored)), false);
  }
  for (const role of ['storage-private-58', 'storage-private-59-evidence'] as const) {
    assert.equal(isPrivateStorageWorkspaceRole(role), true);
    for (const since of WORKSPACE_ORDINARY_SCHEMAS) assert.equal(isWorkspaceRoleSince(role, since), false);
  }
  for (const role of ['ordinary-24', 'ordinary-42', 'restored-43-evidence', 'restored-25', 'ordinary-25', 'restored-26-evidence', '']) {
    assert.equal(isWorkspaceRoleSince(role as CurrentWorkspaceRole, 24), false, role);
    assert.equal(isPrivateStorageWorkspaceRole(role as CurrentWorkspaceRole), false, role);
  }
});

test('every lineage role from schema44 on has a fixed profile validator; other roles fail closed', () => {
  const db = new DatabaseSync(':memory:');
  const missing = {code: 'RESTORE_SCHEMA_UNSUPPORTED', message: 'Workspace schema role has no fixed profile validator'};
  try {
    for (const role of ['ordinary-through-24', 'restored-25-evidence', 'ordinary-40', 'restored-41-evidence', 'storage-private-58', 'ordinary-42'])
      assert.throws(() => validateFixedWorkspaceRole(db, role as CurrentWorkspaceRole), missing, role);
    // An empty database is never a complete fixed profile, so each registered
    // validator runs and rejects it with its own error.
    const registered = WORKSPACE_SCHEMA_LINEAGE.filter(entry => entry.ordinary >= 44)
      .flatMap(({ordinary, restored}) => [ordinaryRole(ordinary), restoredRole(restored)]);
    for (const role of [...registered, 'storage-private-59-evidence'] as const)
      assert.throws(() => validateFixedWorkspaceRole(db, role), (error: Error) => error.message !== missing.message, role);
    assert.equal(db.prepare('SELECT count(*) AS count FROM sqlite_schema').get()?.count, 0, 'validation never writes');
  } finally { db.close(); }
});
