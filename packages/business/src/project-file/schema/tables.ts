/** Where every format-72 workspace table lives in the project-file layout.
 * Content tables are stored in the project file, process records in the local
 * history database and rebuildable data in the cache database. Application
 * tables belong to the application database, which this kernel never builds;
 * removed tables are not built anywhere. `schema_version` exists in each of the
 * three databases and is defined in databases.ts. */
export type TablePlacement = 'project' | 'history' | 'cache' | 'app' | 'removed';
export type HistoryDomain = 'receipts' | 'tasks' | 'timelineHistory' | 'mio';

export const CONTENT_TABLES: readonly string[] = Object.freeze([
  'projects', 'assets', 'asset_annotations', 'asset_dispositions', 'asset_ranges', 'shots', 'nodes', 'edges', 'versions',
  'timelines', 'subjects', 'subject_versions', 'subject_bindings', 'image_groups', 'image_versions', 'scene_results',
  'project_lut_resources', 'agent_task_target_revisions_v2',
]);

export const HISTORY_TABLES_BY_DOMAIN: Readonly<Record<HistoryDomain, readonly string[]>> = Object.freeze({
  receipts: Object.freeze([
    'idempotency', 'mutation_requests', 'project_mutation_requests', 'asset_annotation_requests', 'asset_disposition_requests',
    'asset_range_requests', 'timeline_requests', 'timeline_format_requests', 'reference_requests', 'image_requests',
    'frame_requests', 'scene_requests', 'subject_requests', 'subject_variant_requests', 'previs_requests',
    'lut_import_requests', 'task_disposition_requests',
  ]),
  tasks: Object.freeze([
    'jobs', 'job_events', 'exports', 'edit_tasks', 'image_tasks', 'image_reviews', 'image_remote_runs',
    'image_remote_observations', 'frame_tasks', 'scene_tasks', 'subject_variant_batches', 'subject_variant_items',
    'task_dispositions',
  ]),
  timelineHistory: Object.freeze(['timeline_history', 'timeline_history_cursors']),
  mio: Object.freeze([
    'agent_task_runs_v2', 'agent_task_steps_v2', 'agent_task_events_v2', 'agent_task_changes_v2', 'agent_task_controls_v2',
    'agent_task_control_states_v2', 'agent_task_imports_v2', 'agent_task_job_origins_v2', 'agent_task_edit_claims_v2',
    'agent_task_edit_owners_v2', 'agent_task_edit_receipts_v2', 'agent_task_conversation_policies_v2',
    'agent_task_conversation_policy_requests_v2',
  ]),
});

export const HISTORY_TABLES: readonly string[] = Object.freeze([
  ...HISTORY_TABLES_BY_DOMAIN.receipts, ...HISTORY_TABLES_BY_DOMAIN.tasks,
  ...HISTORY_TABLES_BY_DOMAIN.timelineHistory, ...HISTORY_TABLES_BY_DOMAIN.mio,
]);

export const CACHE_TABLES: readonly string[] = Object.freeze(['waveform_cache', 'previs_thumbnails']);

/** Handed over to the application database; not built by the project-file kernel. */
export const APP_DATABASE_TABLES: readonly string[] = Object.freeze([
  'agent_task_policy_v2', 'agent_task_policy_requests_v2', 'workspace_preferences',
]);

/** Format-72 tables that the project-file layout does not keep. */
export const REMOVED_TABLES: readonly string[] = Object.freeze([
  'agent_chat_threads', 'agent_chat_requests', 'agent_chat_runs', 'agent_chat_steps', 'agent_chat_events', 'agent_chat_quota',
  'agent_edit_proposals', 'project_deletion_receipts', 'project_deletion_scope', 'project_deletion_cleanup',
]);

const placements = new Map<string, TablePlacement>();
for (const [placement, tables] of [
  ['project', CONTENT_TABLES], ['history', HISTORY_TABLES], ['cache', CACHE_TABLES],
  ['app', APP_DATABASE_TABLES], ['removed', REMOVED_TABLES],
] as const) {
  for (const table of tables) placements.set(table, placement);
}

/** Placement of a format-72 table; throws for any table the layout does not know. */
export function databaseOf(table: string): TablePlacement {
  const placement = placements.get(table);
  if (placement === undefined) throw new Error(`Unknown project-file table: ${table}`);
  return placement;
}
