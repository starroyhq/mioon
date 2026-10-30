// Derived from the format-72 workspace schema by `node tests/helpers/project-file-schema-derivation.ts --write`.
// Foreign keys from tables in the local history or cache database to content tables in the project file.
// SQLite cannot enforce them across files; the kernel emulates each one with connection-level TEMP triggers.
// Schemas are the names on the kernel connection: history.db is main, the project file is attached as
// project and cache.db as cache. Columns are in key order; `nullable` is per child column (PRIMARY KEY
// columns count as NOT NULL).
export interface CrossFileRelation {
  readonly index: number;
  readonly child: {readonly schema: 'main' | 'cache'; readonly table: string; readonly columns: readonly string[]; readonly nullable: readonly boolean[]};
  readonly parent: {readonly schema: 'project'; readonly table: string; readonly columns: readonly string[]};
  /** Declared DEFERRABLE INITIALLY DEFERRED in format 72; the emulation checks immediately. */
  readonly originallyDeferred: boolean;
}
/** A format-72 foreign key from a content table to a process table in the local history database. Not enforced. */
export interface DroppedContentKey {
  readonly child: {readonly table: string; readonly columns: readonly string[]};
  readonly parent: {readonly table: string; readonly columns: readonly string[]};
  readonly originallyDeferred: boolean;
}
export const CROSS_FILE_RELATIONS: readonly CrossFileRelation[] = Object.freeze([
  {index: 1, child: {schema: "main", table: "agent_task_changes_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 2, child: {schema: "main", table: "agent_task_control_states_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 3, child: {schema: "main", table: "agent_task_controls_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 4, child: {schema: "main", table: "agent_task_conversation_policies_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 5, child: {schema: "main", table: "agent_task_conversation_policy_requests_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 6, child: {schema: "main", table: "agent_task_edit_claims_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 7, child: {schema: "main", table: "agent_task_edit_owners_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 8, child: {schema: "main", table: "agent_task_edit_receipts_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 9, child: {schema: "main", table: "agent_task_events_v2", columns: ["projectId"], nullable: [true]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 10, child: {schema: "main", table: "agent_task_imports_v2", columns: ["assetId"], nullable: [true]}, parent: {schema: "project", table: "assets", columns: ["id"]}, originallyDeferred: false},
  {index: 11, child: {schema: "main", table: "agent_task_imports_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 12, child: {schema: "main", table: "agent_task_job_origins_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 13, child: {schema: "main", table: "agent_task_runs_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 14, child: {schema: "main", table: "agent_task_steps_v2", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 15, child: {schema: "main", table: "asset_annotation_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 16, child: {schema: "main", table: "asset_disposition_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 17, child: {schema: "main", table: "asset_range_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 18, child: {schema: "main", table: "edit_tasks", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 19, child: {schema: "main", table: "exports", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 20, child: {schema: "main", table: "frame_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 21, child: {schema: "main", table: "frame_tasks", columns: ["assetId"], nullable: [true]}, parent: {schema: "project", table: "assets", columns: ["id"]}, originallyDeferred: false},
  {index: 22, child: {schema: "main", table: "frame_tasks", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 23, child: {schema: "main", table: "image_remote_observations", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 24, child: {schema: "main", table: "image_remote_runs", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 25, child: {schema: "main", table: "image_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 26, child: {schema: "main", table: "image_reviews", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 27, child: {schema: "main", table: "image_tasks", columns: ["versionId","id","groupId","projectId"], nullable: [true,false,false,false]}, parent: {schema: "project", table: "image_versions", columns: ["id","taskId","groupId","projectId"]}, originallyDeferred: true},
  {index: 28, child: {schema: "main", table: "image_tasks", columns: ["groupId","projectId"], nullable: [false,false]}, parent: {schema: "project", table: "image_groups", columns: ["id","projectId"]}, originallyDeferred: false},
  {index: 29, child: {schema: "main", table: "image_tasks", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 30, child: {schema: "main", table: "jobs", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 31, child: {schema: "main", table: "lut_import_requests", columns: ["resourceId","projectId"], nullable: [false,false]}, parent: {schema: "project", table: "project_lut_resources", columns: ["id","projectId"]}, originallyDeferred: false},
  {index: 32, child: {schema: "main", table: "lut_import_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 33, child: {schema: "main", table: "mutation_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 34, child: {schema: "main", table: "previs_requests", columns: ["nodeId"], nullable: [false]}, parent: {schema: "project", table: "nodes", columns: ["id"]}, originallyDeferred: false},
  {index: 35, child: {schema: "main", table: "previs_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 36, child: {schema: "cache", table: "previs_thumbnails", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 37, child: {schema: "cache", table: "previs_thumbnails", columns: ["nodeId"], nullable: [false]}, parent: {schema: "project", table: "nodes", columns: ["id"]}, originallyDeferred: false},
  {index: 38, child: {schema: "main", table: "project_mutation_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 39, child: {schema: "main", table: "scene_requests", columns: ["resultId","projectId"], nullable: [true,false]}, parent: {schema: "project", table: "scene_results", columns: ["id","projectId"]}, originallyDeferred: false},
  {index: 40, child: {schema: "main", table: "scene_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 41, child: {schema: "main", table: "scene_tasks", columns: ["resultId","projectId"], nullable: [true,false]}, parent: {schema: "project", table: "scene_results", columns: ["id","projectId"]}, originallyDeferred: true},
  {index: 42, child: {schema: "main", table: "scene_tasks", columns: ["sourceAssetId"], nullable: [false]}, parent: {schema: "project", table: "assets", columns: ["id"]}, originallyDeferred: false},
  {index: 43, child: {schema: "main", table: "scene_tasks", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 44, child: {schema: "main", table: "subject_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 45, child: {schema: "main", table: "subject_variant_batches", columns: ["sourceVersionId","subjectId","projectId"], nullable: [false,false,false]}, parent: {schema: "project", table: "subject_versions", columns: ["id","subjectId","projectId"]}, originallyDeferred: false},
  {index: 46, child: {schema: "main", table: "subject_variant_batches", columns: ["subjectId","projectId"], nullable: [false,false]}, parent: {schema: "project", table: "subjects", columns: ["id","projectId"]}, originallyDeferred: false},
  {index: 47, child: {schema: "main", table: "subject_variant_batches", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 48, child: {schema: "main", table: "subject_variant_items", columns: ["versionId"], nullable: [true]}, parent: {schema: "project", table: "subject_versions", columns: ["id"]}, originallyDeferred: false},
  {index: 49, child: {schema: "main", table: "subject_variant_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 50, child: {schema: "main", table: "task_disposition_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 51, child: {schema: "main", table: "task_dispositions", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 52, child: {schema: "main", table: "timeline_format_requests", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 53, child: {schema: "main", table: "timeline_history", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 54, child: {schema: "main", table: "timeline_history_cursors", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
  {index: 55, child: {schema: "cache", table: "waveform_cache", columns: ["projectId"], nullable: [false]}, parent: {schema: "project", table: "projects", columns: ["id"]}, originallyDeferred: false},
]);
export const DROPPED_CONTENT_KEYS: readonly DroppedContentKey[] = Object.freeze([
  {child: {table: "image_groups", columns: ["activeTaskId","id","projectId"]}, parent: {table: "image_tasks", columns: ["id","groupId","projectId"]}, originallyDeferred: true},
  {child: {table: "image_versions", columns: ["taskId","groupId","projectId"]}, parent: {table: "image_tasks", columns: ["id","groupId","projectId"]}, originallyDeferred: false},
  {child: {table: "scene_results", columns: ["requestId"]}, parent: {table: "scene_requests", columns: ["requestId"]}, originallyDeferred: true},
  {child: {table: "scene_results", columns: ["taskId","projectId"]}, parent: {table: "scene_tasks", columns: ["id","projectId"]}, originallyDeferred: false},
  {child: {table: "versions", columns: ["jobId"]}, parent: {table: "jobs", columns: ["id"]}, originallyDeferred: false},
]);
