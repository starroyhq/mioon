/** Processing rows belong to the format-6 execution history, not project content. */
export const FORMAT6_HISTORY_SCHEMA_VERSION = 14;
export const TIMELINE_PROCESSING_HISTORY_TABLES = ['timeline_processing_tasks', 'timeline_processing_retries'] as const;

export const TIMELINE_PROCESSING_HISTORY_SCHEMA = [
  `CREATE TABLE timeline_processing_tasks(
    id TEXT NOT NULL PRIMARY KEY CHECK(length(id)=36),
    projectId TEXT NOT NULL CHECK(length(projectId)=36),
    demandKey TEXT NOT NULL CHECK(length(demandKey)=64 AND demandKey NOT GLOB '*[^0-9a-f]*'),
    kind TEXT NOT NULL CHECK(kind IN ('reverse','optical')),
    state TEXT NOT NULL CHECK(state IN ('queued','running','ready','failed','cancelled')),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
    requestId TEXT NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200),
    input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB))<=65536),
    progress INTEGER CHECK(progress IS NULL OR (typeof(progress)='integer' AND progress BETWEEN 0 AND 100)),
    errorCode TEXT CHECK(errorCode IS NULL OR errorCode IN ('SOURCE_UNAVAILABLE','DISK_FULL','CACHE_LIMIT','UNSUPPORTED_FORMAT','PROCESSING_FAILED')),
    result TEXT CHECK(result IS NULL OR (json_valid(result) AND json_type(result)='object' AND length(CAST(result AS BLOB))<=16384)),
    updatedAt TEXT NOT NULL CHECK(length(updatedAt)=24),
    UNIQUE(projectId,demandKey)
  )`,
  `CREATE INDEX timeline_processing_tasks_state ON timeline_processing_tasks(projectId,state)`,
  `CREATE TABLE timeline_processing_retries(
    requestId TEXT NOT NULL PRIMARY KEY CHECK(length(requestId) BETWEEN 8 AND 200),
    taskId TEXT NOT NULL REFERENCES timeline_processing_tasks(id) ON DELETE CASCADE
  )`,
] as const;
