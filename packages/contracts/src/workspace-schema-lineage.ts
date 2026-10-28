/** The ordinary workspace schema lineage, oldest first, with the fixed restore
 * pair of each entry. This is the one production list of workspace schema
 * versions: version sets elsewhere derive from it, and a new ordinary schema
 * is added here explicitly together with its initializer and restore profile.
 *
 * Membership is exact. Nothing widens by numeric range, so dormant or unknown
 * versions (such as the opacity candidate 42/43) are never implied, and restore
 * profile names keep their historical, non-contiguous numbering. Ordinary
 * versions 1–23 predate the lineage; they are backup sources only.
 *
 * A new ordinary schema N (restored N+1) adds its entry here, then wires its own
 * modules: the role classifier, restore profile and upgrade initializer row in
 * business workspace-schema-dispatch.ts, its two fixed validators in
 * workspace-role-validation.ts and its backup branch in
 * workspace-backup-schema-versions.ts. Version sets elsewhere follow. */
const entry = <const Ordinary extends number, const Restored extends number, const Profile extends string>(
  ordinary: Ordinary, restored: Restored, profile: Profile,
) => Object.freeze({ordinary, restored, profile});

export const WORKSPACE_SCHEMA_LINEAGE = Object.freeze([
  entry(24, 25, 'restored-local-v1'),
  entry(26, 27, 'restored-local-v2'),
  entry(28, 29, 'restored-local-v3'),
  entry(30, 31, 'restored-local-v4'),
  entry(32, 33, 'restored-local-v5'),
  entry(34, 35, 'restored-local-v6'),
  entry(36, 37, 'restored-local-v7'),
  entry(38, 39, 'restored-local-v8'),
  entry(40, 41, 'restored-local-v9'),
  entry(44, 45, 'restored-local-v11'),
  entry(48, 49, 'restored-local-v13'),
  entry(50, 51, 'restored-local-v14'),
  entry(52, 53, 'restored-local-v15'),
  entry(54, 55, 'restored-local-v16'),
  entry(56, 57, 'restored-local-v17'),
  entry(58, 59, 'restored-local-v18'),
  entry(60, 61, 'restored-local-v19'),
  entry(62, 63, 'restored-local-v20'),
  entry(64, 65, 'restored-local-v21'),
] as const);

export type WorkspaceSchemaLineageEntry = typeof WORKSPACE_SCHEMA_LINEAGE[number];
export type WorkspaceOrdinarySchema = WorkspaceSchemaLineageEntry['ordinary'];
export type WorkspaceRestoredSchema = WorkspaceSchemaLineageEntry['restored'];
export type WorkspaceRestoreProfileId = WorkspaceSchemaLineageEntry['profile'];

export const WORKSPACE_ORDINARY_SCHEMAS: readonly WorkspaceOrdinarySchema[] = Object.freeze(WORKSPACE_SCHEMA_LINEAGE.map(item => item.ordinary));
export const WORKSPACE_RESTORED_SCHEMAS: readonly WorkspaceRestoredSchema[] = Object.freeze(WORKSPACE_SCHEMA_LINEAGE.map(item => item.restored));
export const WORKSPACE_RESTORE_PROFILES: readonly WorkspaceRestoreProfileId[] = Object.freeze(WORKSPACE_SCHEMA_LINEAGE.map(item => item.profile));

// A capability starts at the ordinary schema that introduced it. That schema
// must be a lineage version; anything else is a programming error.
function lineagePosition(since: number): number {
  const position = WORKSPACE_ORDINARY_SCHEMAS.indexOf(since as WorkspaceOrdinarySchema);
  if (position < 0) throw new TypeError(`Workspace schema ${String(since)} is not an ordinary lineage version.`);
  return position;
}

/** Ordinary lineage versions from `since` on, oldest first. */
export function workspaceSchemasSince(since: WorkspaceOrdinarySchema): readonly WorkspaceOrdinarySchema[] {
  return Object.freeze(WORKSPACE_ORDINARY_SCHEMAS.slice(lineagePosition(since)));
}

/** Restored versions whose source is `since` or a later lineage version, oldest first. */
export function restoredWorkspaceSchemasSince(since: WorkspaceOrdinarySchema): readonly WorkspaceRestoredSchema[] {
  return Object.freeze(WORKSPACE_RESTORED_SCHEMAS.slice(lineagePosition(since)));
}

/** True only for an exact ordinary lineage version at or after `since`. */
export function isWorkspaceSchemaSince(since: WorkspaceOrdinarySchema, version: unknown): boolean {
  return WORKSPACE_ORDINARY_SCHEMAS.indexOf(version as WorkspaceOrdinarySchema) >= lineagePosition(since);
}

/** True only for an exact restored version whose source is `since` or later. */
export function isRestoredWorkspaceSchemaSince(since: WorkspaceOrdinarySchema, version: unknown): boolean {
  return WORKSPACE_RESTORED_SCHEMAS.indexOf(version as WorkspaceRestoredSchema) >= lineagePosition(since);
}
