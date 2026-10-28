import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {classifyCurrentWorkspaceSchema} from '../../packages/business/src/db.ts';
import {readCurrentWorkspaceRole} from '../../packages/business/src/workspace-schema-dispatch.ts';

// The one test-side pin for the current workspace schema. These values are
// independent expectations, not imports from production code: a schema bump
// changes them here, together with a new reviewed delta layer in
// reviewed-schema-layers.ts, instead of in every test. A test that is about a
// particular historical version keeps that version as a literal.
export const CURRENT_ORDINARY_SCHEMA = 66;
export const CURRENT_RESTORED_SCHEMA = 67;
export const CURRENT_RESTORE_PROFILE = 'restored-local-v22';
export const CURRENT_ORDINARY_ROLE = 'ordinary-66';
export const CURRENT_RESTORED_ROLE = 'restored-67-evidence';
/** The first version above the current one; no build accepts it yet. */
export const NEXT_ORDINARY_SCHEMA = CURRENT_ORDINARY_SCHEMA + 2;

/** Ordinary versions after the 1–24 baseline markers, in order. 42 and 46
 * were candidate profiles and never joined this lineage. */
export const ORDINARY_SCHEMA_LINEAGE = Object.freeze([24, 26, 28, 30, 32, 34, 36, 38, 40, 44, 48, 50, 52, 54, 56, 58, 60, 62, 64, 66] as const);
/** Every marker row of a fresh current ordinary workspace. */
export const CURRENT_MARKER_CHAIN = Object.freeze([...Array.from({length: 24}, (_, index) => index + 1), ...ORDINARY_SCHEMA_LINEAGE.slice(1)]);
/** Ordinary versions that carry the Agent task v2 tables (schema52 onward). */
export const AGENT_TASK_ORDINARY_SCHEMAS = Object.freeze(ORDINARY_SCHEMA_LINEAGE.filter(version => version >= 52));
/** Each restore profile with its source and restored database versions. */
export const RESTORE_PROFILE_PAIRS = Object.freeze([
  ['restored-local-v1', 24, 25], ['restored-local-v2', 26, 27], ['restored-local-v3', 28, 29], ['restored-local-v4', 30, 31],
  ['restored-local-v5', 32, 33], ['restored-local-v6', 34, 35], ['restored-local-v7', 36, 37], ['restored-local-v8', 38, 39],
  ['restored-local-v9', 40, 41], ['restored-local-v11', 44, 45], ['restored-local-v13', 48, 49], ['restored-local-v14', 50, 51],
  ['restored-local-v15', 52, 53], ['restored-local-v16', 54, 55], ['restored-local-v17', 56, 57], ['restored-local-v18', 58, 59],
  ['restored-local-v19', 60, 61], ['restored-local-v20', 62, 63], ['restored-local-v21', 64, 65],
  ['restored-local-v22', 66, 67],
] as const);
assert.deepEqual(RESTORE_PROFILE_PAIRS.at(-1), [CURRENT_RESTORE_PROFILE, CURRENT_ORDINARY_SCHEMA, CURRENT_RESTORED_SCHEMA]);
assert.equal(ORDINARY_SCHEMA_LINEAGE.at(-1), CURRENT_ORDINARY_SCHEMA);
assert.equal(CURRENT_ORDINARY_ROLE, `ordinary-${CURRENT_ORDINARY_SCHEMA}`);
assert.equal(CURRENT_RESTORED_ROLE, `restored-${CURRENT_RESTORED_SCHEMA}-evidence`);

/** The fresh or upgraded workspace is exactly the current ordinary profile. */
export function assertCurrentOrdinaryWorkspace(db: DatabaseSync): void {
  assert.equal(readCurrentWorkspaceRole(db), CURRENT_ORDINARY_ROLE);
  assert.deepEqual(classifyCurrentWorkspaceSchema(db), {schemaVersion: CURRENT_ORDINARY_SCHEMA, profile: 'ordinary'});
}
