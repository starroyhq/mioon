import type {DatabaseSync} from 'node:sqlite';

// Exact static literals pinned to the independently retained ordinary24 catalog.
// The immutable through24 constructor unconditionally recreated these36 guards
// and active-chat uniqueness on every ordinary open. Restore that additive safety
// behavior without invoking its marker/quota writes or executing imported SQL.
// Missing/changed tables and quota state fail closed; no business row is rebuilt.
const TABLES = [
  {"name":"schema_version","sql":"CREATE TABLE schema_version(version INTEGER PRIMARY KEY)"},
  {"name":"projects","sql":"CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL)"},
  {"name":"assets","sql":"CREATE TABLE assets(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL)"},
  {"name":"shots","sql":"CREATE TABLE shots(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL)"},
  {"name":"nodes","sql":"CREATE TABLE nodes(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL)"},
  {"name":"edges","sql":"CREATE TABLE edges(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL)"},
  {"name":"jobs","sql":"CREATE TABLE jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL)"},
  {"name":"versions","sql":"CREATE TABLE versions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),jobId TEXT NOT NULL UNIQUE REFERENCES jobs(id),data TEXT NOT NULL)"},
  {"name":"exports","sql":"CREATE TABLE exports(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL)"},
  {"name":"timelines","sql":"CREATE TABLE timelines(id TEXT PRIMARY KEY,projectId TEXT NOT NULL UNIQUE REFERENCES projects(id),data TEXT NOT NULL)"},
  {"name":"timeline_requests","sql":"CREATE TABLE timeline_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL)"},
  {"name":"idempotency","sql":"CREATE TABLE idempotency(scope TEXT NOT NULL,requestId TEXT NOT NULL,requestHash TEXT NOT NULL,resourceId TEXT NOT NULL,PRIMARY KEY(scope,requestId))"},
  {"name":"job_events","sql":"CREATE TABLE job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,jobId TEXT NOT NULL,event TEXT NOT NULL,createdAt TEXT NOT NULL)"},
  {"name":"timeline_history","sql":"CREATE TABLE timeline_history(\n id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),\n position INTEGER NOT NULL CHECK(position>0),operation TEXT NOT NULL,createdAt TEXT NOT NULL,\n beforeSnapshot TEXT NOT NULL,afterSnapshot TEXT NOT NULL,UNIQUE(projectId,position))"},
  {"name":"timeline_history_cursors","sql":"CREATE TABLE timeline_history_cursors(\n projectId TEXT PRIMARY KEY REFERENCES projects(id),position INTEGER NOT NULL CHECK(position>=0))"},
  {"name":"reference_requests","sql":"CREATE TABLE reference_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL)"},
  {"name":"workspace_preferences","sql":"CREATE TABLE workspace_preferences(\n projectId TEXT PRIMARY KEY REFERENCES projects(id),\n revision INTEGER NOT NULL CHECK(revision>0 AND revision<=9007199254740991),\n state TEXT NOT NULL CHECK(json_valid(state) AND length(CAST(state AS BLOB))<=16384))"},
  {"name":"agent_chat_threads","sql":"CREATE TABLE agent_chat_threads(\n id TEXT PRIMARY KEY,projectId TEXT NOT NULL UNIQUE REFERENCES projects(id),\n revision INTEGER NOT NULL CHECK(revision>=0),nextPosition INTEGER NOT NULL CHECK(nextPosition>0))"},
  {"name":"agent_chat_requests","sql":"CREATE TABLE agent_chat_requests(\n requestId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),\n threadId TEXT NOT NULL REFERENCES agent_chat_threads(id),runId TEXT NOT NULL UNIQUE,\n fingerprint TEXT NOT NULL,acceptance TEXT NOT NULL CHECK(json_valid(acceptance)),bytes INTEGER NOT NULL CHECK(bytes>=0))"},
  {"name":"agent_chat_runs","sql":"CREATE TABLE agent_chat_runs(\n id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),\n threadId TEXT NOT NULL REFERENCES agent_chat_threads(id),requestId TEXT NOT NULL UNIQUE REFERENCES agent_chat_requests(requestId),\n position INTEGER NOT NULL CHECK(position>0),status TEXT NOT NULL CHECK(status IN ('running','completed','failed','stopped','interrupted')),\n data TEXT NOT NULL CHECK(json_valid(data)),bytes INTEGER NOT NULL CHECK(bytes>=0),UNIQUE(threadId,position))"},
  {"name":"agent_chat_events","sql":"CREATE TABLE agent_chat_events(\n runId TEXT NOT NULL REFERENCES agent_chat_runs(id),seq INTEGER NOT NULL CHECK(seq>0),\n data TEXT NOT NULL CHECK(json_valid(data)),bytes INTEGER NOT NULL CHECK(bytes>=0),PRIMARY KEY(runId,seq))"},
  {"name":"agent_chat_quota","sql":"CREATE TABLE agent_chat_quota(\n id INTEGER PRIMARY KEY CHECK(id=1),runs INTEGER NOT NULL CHECK(runs>=0),\n bytes INTEGER NOT NULL CHECK(bytes>=0),reservedBytes INTEGER NOT NULL CHECK(reservedBytes>=0))"},
  {"name":"agent_chat_steps","sql":"CREATE TABLE agent_chat_steps(\n id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES agent_chat_runs(id),\n projectId TEXT NOT NULL REFERENCES projects(id),position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 3),\n kind TEXT NOT NULL CHECK(kind IN ('model','tool')),\n status TEXT NOT NULL CHECK(status IN ('not_started','intent','dispatch_started','completed','unknown')),\n data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=1048576),\n bytes INTEGER NOT NULL CHECK(bytes>=0),UNIQUE(runId,position))"},
  {"name":"mutation_requests","sql":"CREATE TABLE mutation_requests(\n requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation IN ('shot.create','shot.update','shot.reorder','node.create','node.update','version.select')),\n projectId TEXT NOT NULL REFERENCES projects(id),\n canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput)),\n response TEXT NOT NULL CHECK(json_valid(response)))"},
  {"name":"agent_edit_proposals","sql":"CREATE TABLE \"agent_edit_proposals\"(\n position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,\n projectId TEXT NOT NULL REFERENCES projects(id),runId TEXT NOT NULL UNIQUE REFERENCES agent_chat_runs(id),shotId TEXT,\n targetKind TEXT NOT NULL DEFAULT 'shot',clipId TEXT,timelineId TEXT,\n digest TEXT NOT NULL,definition TEXT NOT NULL CHECK(json_valid(definition) AND length(CAST(definition AS BLOB))<=131072),\n status TEXT NOT NULL CHECK(status IN ('pending','approved','dispatching','unknown','applied','failed','rejected','cancelled')),\n approval TEXT CHECK(approval IS NULL OR (json_valid(approval) AND length(CAST(approval AS BLOB))<=32768)),\n outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND length(CAST(outcome AS BLOB))<=1024)),\n createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 196608),\n CHECK((status IN ('pending','rejected','cancelled'))=(approval IS NULL)),\n CHECK((status IN ('applied','failed'))=(outcome IS NOT NULL)),CONSTRAINT agent_edit_target_v24 CHECK(\n (targetKind='shot' AND typeof(shotId)='text' AND clipId IS NULL AND timelineId IS NULL) OR\n (targetKind='timeline_clip' AND shotId IS NULL AND typeof(clipId)='text' AND typeof(timelineId)='text')))"},
  {"name":"asset_ranges","sql":"CREATE TABLE asset_ranges(\n assetId TEXT PRIMARY KEY REFERENCES assets(id),projectId TEXT NOT NULL REFERENCES projects(id),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n inFrame INTEGER NOT NULL CHECK(typeof(inFrame)='integer' AND inFrame BETWEEN 0 AND 9007199254740991),\n outFrame INTEGER NOT NULL CHECK(typeof(outFrame)='integer' AND outFrame>inFrame AND outFrame<=9007199254740991))"},
  {"name":"asset_range_requests","sql":"CREATE TABLE asset_range_requests(\n requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation='asset.range.set'),\n projectId TEXT NOT NULL REFERENCES projects(id),\n canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput)),\n response TEXT NOT NULL CHECK(json_valid(response)))"},
  {"name":"asset_dispositions","sql":"CREATE TABLE asset_dispositions(\n assetId TEXT PRIMARY KEY REFERENCES assets(id),projectId TEXT NOT NULL REFERENCES projects(id),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n disposition TEXT NOT NULL CHECK(disposition IN ('neutral','favorite','rejected')))"},
  {"name":"asset_disposition_requests","sql":"CREATE TABLE asset_disposition_requests(\n requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation='asset.disposition.set'),\n projectId TEXT NOT NULL REFERENCES projects(id),\n canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND length(CAST(canonicalInput AS BLOB))<=4096),\n response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB))<=4096))"},
  {"name":"waveform_cache","sql":"CREATE TABLE waveform_cache(\n position INTEGER PRIMARY KEY AUTOINCREMENT,cacheKey TEXT NOT NULL UNIQUE CHECK(length(CAST(cacheKey AS BLOB))=64),\n projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),\n sourceSha256 TEXT NOT NULL CHECK(length(CAST(sourceSha256 AS BLOB))=64),\n algorithm TEXT NOT NULL CHECK(length(CAST(algorithm AS BLOB)) BETWEEN 1 AND 100),\n status TEXT NOT NULL CHECK(status IN ('queued','running','ready','interrupted','error','unsupported')),\n attemptId TEXT NOT NULL CHECK(length(CAST(attemptId AS BLOB))=36),\n data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=393216),\n bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 393216),\n reservedBytes INTEGER NOT NULL CHECK(typeof(reservedBytes)='integer' AND reservedBytes BETWEEN 0 AND 393216),\n UNIQUE(projectId,sourceSha256,algorithm))"}
] as const;
const PROTECTIONS = [
  {"type":"trigger","name":"immutable_versions","table":"versions","sql":"CREATE TRIGGER immutable_versions BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'versions are immutable');END"},
  {"type":"trigger","name":"immutable_timeline_responses","table":"timeline_requests","sql":"CREATE TRIGGER immutable_timeline_responses BEFORE UPDATE ON timeline_requests BEGIN SELECT RAISE(ABORT,'timeline request responses are immutable');END"},
  {"type":"trigger","name":"immutable_timeline_render_snapshot","table":"exports","sql":"CREATE TRIGGER immutable_timeline_render_snapshot BEFORE UPDATE ON exports\n WHEN json_extract(OLD.data,'$.mode')='timeline' AND (\n json_extract(NEW.data,'$.mode') IS NOT 'timeline' OR\n json_extract(NEW.data,'$.snapshot') IS NOT json_extract(OLD.data,'$.snapshot') OR\n json_extract(NEW.data,'$.timelineRevision') IS NOT json_extract(OLD.data,'$.timelineRevision') OR\n json_extract(NEW.data,'$.purpose') IS NOT json_extract(OLD.data,'$.purpose'))\n BEGIN SELECT RAISE(ABORT,'timeline render snapshots are immutable');END"},
  {"type":"trigger","name":"immutable_timeline_history","table":"timeline_history","sql":"CREATE TRIGGER immutable_timeline_history BEFORE UPDATE ON timeline_history\n BEGIN SELECT RAISE(ABORT,'timeline history entries are immutable');END"},
  {"type":"trigger","name":"immutable_reference_responses","table":"reference_requests","sql":"CREATE TRIGGER immutable_reference_responses BEFORE UPDATE ON reference_requests\n BEGIN SELECT RAISE(ABORT,'reference request responses are immutable');END"},
  {"type":"trigger","name":"reject_reference_request_replacement","table":"reference_requests","sql":"CREATE TRIGGER reject_reference_request_replacement BEFORE INSERT ON reference_requests\n WHEN EXISTS(SELECT 1 FROM reference_requests WHERE requestId=NEW.requestId)\n BEGIN SELECT RAISE(ABORT,'reference request responses are immutable');END"},
  {"type":"trigger","name":"retain_reference_requests","table":"reference_requests","sql":"CREATE TRIGGER retain_reference_requests BEFORE DELETE ON reference_requests\n BEGIN SELECT RAISE(ABORT,'reference request responses must be retained');END"},
  {"type":"trigger","name":"immutable_agent_chat_requests","table":"agent_chat_requests","sql":"CREATE TRIGGER immutable_agent_chat_requests BEFORE UPDATE ON agent_chat_requests\n BEGIN SELECT RAISE(ABORT,'accepted chat requests are immutable');END"},
  {"type":"trigger","name":"retain_agent_chat_requests","table":"agent_chat_requests","sql":"CREATE TRIGGER retain_agent_chat_requests BEFORE DELETE ON agent_chat_requests\n BEGIN SELECT RAISE(ABORT,'accepted chat requests must be retained');END"},
  {"type":"trigger","name":"immutable_agent_chat_run_identity","table":"agent_chat_runs","sql":"CREATE TRIGGER immutable_agent_chat_run_identity BEFORE UPDATE ON agent_chat_runs\n WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.threadId IS NOT OLD.threadId OR\n NEW.requestId IS NOT OLD.requestId OR NEW.position IS NOT OLD.position OR\n json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR\n json_extract(NEW.data,'$.requestId') IS NOT json_extract(OLD.data,'$.requestId') OR\n json_extract(NEW.data,'$.threadId') IS NOT json_extract(OLD.data,'$.threadId') OR\n json_extract(NEW.data,'$.projectId') IS NOT json_extract(OLD.data,'$.projectId') OR\n json_extract(NEW.data,'$.userText') IS NOT json_extract(OLD.data,'$.userText') OR\n json_extract(NEW.data,'$.configuration') IS NOT json_extract(OLD.data,'$.configuration') OR\n json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt') OR\n json_extract(NEW.data,'$.modelRequestId') IS NOT json_extract(OLD.data,'$.modelRequestId')\n BEGIN SELECT RAISE(ABORT,'accepted chat identity and configuration are immutable');END"},
  {"type":"trigger","name":"immutable_agent_chat_events","table":"agent_chat_events","sql":"CREATE TRIGGER immutable_agent_chat_events BEFORE UPDATE ON agent_chat_events\n BEGIN SELECT RAISE(ABORT,'chat events are immutable');END"},
  {"type":"trigger","name":"retain_agent_chat_events","table":"agent_chat_events","sql":"CREATE TRIGGER retain_agent_chat_events BEFORE DELETE ON agent_chat_events\n BEGIN SELECT RAISE(ABORT,'chat events must be retained');END"},
  {"type":"trigger","name":"immutable_agent_chat_step_payload","table":"agent_chat_steps","sql":"CREATE TRIGGER immutable_agent_chat_step_payload BEFORE UPDATE ON agent_chat_steps\n WHEN NEW.id IS NOT OLD.id OR NEW.runId IS NOT OLD.runId OR NEW.projectId IS NOT OLD.projectId OR\n NEW.position IS NOT OLD.position OR NEW.kind IS NOT OLD.kind OR\n json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR\n json_extract(NEW.data,'$.runId') IS NOT json_extract(OLD.data,'$.runId') OR\n json_extract(NEW.data,'$.projectId') IS NOT json_extract(OLD.data,'$.projectId') OR\n json_extract(NEW.data,'$.position') IS NOT json_extract(OLD.data,'$.position') OR\n json_extract(NEW.data,'$.kind') IS NOT json_extract(OLD.data,'$.kind') OR\n json_extract(NEW.data,'$.ordinal') IS NOT json_extract(OLD.data,'$.ordinal') OR\n json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt') OR\n json_extract(NEW.data,'$.requestId') IS NOT json_extract(OLD.data,'$.requestId') OR\n json_extract(NEW.data,'$.request') IS NOT json_extract(OLD.data,'$.request') OR\n json_extract(NEW.data,'$.modelStepId') IS NOT json_extract(OLD.data,'$.modelStepId') OR\n json_extract(NEW.data,'$.intent') IS NOT json_extract(OLD.data,'$.intent') OR\n (json_type(OLD.data,'$.output') IS NOT NULL AND json_extract(NEW.data,'$.output') IS NOT json_extract(OLD.data,'$.output')) OR\n (json_type(OLD.data,'$.observation') IS NOT NULL AND json_extract(NEW.data,'$.observation') IS NOT json_extract(OLD.data,'$.observation'))\n BEGIN SELECT RAISE(ABORT,'agent step payloads are immutable');END"},
  {"type":"trigger","name":"retain_agent_chat_steps","table":"agent_chat_steps","sql":"CREATE TRIGGER retain_agent_chat_steps BEFORE DELETE ON agent_chat_steps\n BEGIN SELECT RAISE(ABORT,'agent steps must be retained');END"},
  {"type":"trigger","name":"immutable_agent_chat_inspection_context","table":"agent_chat_runs","sql":"CREATE TRIGGER immutable_agent_chat_inspection_context BEFORE UPDATE ON agent_chat_runs\n WHEN json_extract(NEW.data,'$.contextMode') IS NOT json_extract(OLD.data,'$.contextMode') OR\n json_extract(NEW.data,'$.provenance') IS NOT json_extract(OLD.data,'$.provenance')\n BEGIN SELECT RAISE(ABORT,'accepted inspection context is immutable');END"},
  {"type":"trigger","name":"reject_mutation_request_replacement","table":"mutation_requests","sql":"CREATE TRIGGER reject_mutation_request_replacement BEFORE INSERT ON mutation_requests\n WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId)\n BEGIN SELECT RAISE(ABORT,'mutation request responses are immutable');END"},
  {"type":"trigger","name":"immutable_mutation_requests","table":"mutation_requests","sql":"CREATE TRIGGER immutable_mutation_requests BEFORE UPDATE ON mutation_requests\n BEGIN SELECT RAISE(ABORT,'mutation request responses are immutable');END"},
  {"type":"trigger","name":"retain_mutation_requests","table":"mutation_requests","sql":"CREATE TRIGGER retain_mutation_requests BEFORE DELETE ON mutation_requests\n BEGIN SELECT RAISE(ABORT,'mutation request responses must be retained');END"},
  {"type":"trigger","name":"reject_agent_edit_replacement","table":"agent_edit_proposals","sql":"CREATE TRIGGER reject_agent_edit_replacement BEFORE INSERT ON agent_edit_proposals\n WHEN EXISTS(SELECT 1 FROM agent_edit_proposals WHERE id=NEW.id OR runId=NEW.runId)\n BEGIN SELECT RAISE(ABORT,'agent edit identities are immutable');END"},
  {"type":"trigger","name":"immutable_agent_edit_intent","table":"agent_edit_proposals","sql":"CREATE TRIGGER immutable_agent_edit_intent BEFORE UPDATE ON agent_edit_proposals\n WHEN NEW.position IS NOT OLD.position OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR\n NEW.runId IS NOT OLD.runId OR NEW.shotId IS NOT OLD.shotId OR NEW.digest IS NOT OLD.digest OR\n NEW.definition IS NOT OLD.definition OR NEW.createdAt IS NOT OLD.createdAt OR NEW.bytes IS NOT OLD.bytes OR\n (OLD.approval IS NOT NULL AND NEW.approval IS NOT OLD.approval) OR\n (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)\n BEGIN SELECT RAISE(ABORT,'agent edit intent and approval are immutable');END"},
  {"type":"trigger","name":"guard_agent_edit_transition","table":"agent_edit_proposals","sql":"CREATE TRIGGER guard_agent_edit_transition BEFORE UPDATE ON agent_edit_proposals\n WHEN NEW.status IS NOT OLD.status AND NOT (\n (OLD.status='pending' AND NEW.status IN ('approved','rejected','cancelled')) OR\n (OLD.status='approved' AND NEW.status IN ('dispatching','unknown','applied')) OR\n (OLD.status='dispatching' AND NEW.status IN ('unknown','applied','failed')) OR\n (OLD.status='unknown' AND NEW.status IN ('dispatching','applied')))\n BEGIN SELECT RAISE(ABORT,'invalid agent edit transition');END"},
  {"type":"trigger","name":"retain_agent_edit_proposals","table":"agent_edit_proposals","sql":"CREATE TRIGGER retain_agent_edit_proposals BEFORE DELETE ON agent_edit_proposals\n BEGIN SELECT RAISE(ABORT,'agent edit proposals must be retained');END"},
  {"type":"trigger","name":"immutable_agent_chat_edit_target","table":"agent_chat_runs","sql":"CREATE TRIGGER immutable_agent_chat_edit_target BEFORE UPDATE ON agent_chat_runs\n WHEN json_extract(NEW.data,'$.editTarget') IS NOT json_extract(OLD.data,'$.editTarget')\n BEGIN SELECT RAISE(ABORT,'accepted shot edit target is immutable');END"},
  {"type":"trigger","name":"immutable_asset_range_identity","table":"asset_ranges","sql":"CREATE TRIGGER immutable_asset_range_identity BEFORE UPDATE ON asset_ranges\n WHEN NEW.assetId IS NOT OLD.assetId OR NEW.projectId IS NOT OLD.projectId\n BEGIN SELECT RAISE(ABORT,'source range identity is immutable');END"},
  {"type":"trigger","name":"reject_asset_range_request_replacement","table":"asset_range_requests","sql":"CREATE TRIGGER reject_asset_range_request_replacement BEFORE INSERT ON asset_range_requests\n WHEN EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)\n BEGIN SELECT RAISE(ABORT,'source range request responses are immutable');END"},
  {"type":"trigger","name":"immutable_asset_range_requests","table":"asset_range_requests","sql":"CREATE TRIGGER immutable_asset_range_requests BEFORE UPDATE ON asset_range_requests\n BEGIN SELECT RAISE(ABORT,'source range request responses are immutable');END"},
  {"type":"trigger","name":"retain_asset_range_requests","table":"asset_range_requests","sql":"CREATE TRIGGER retain_asset_range_requests BEFORE DELETE ON asset_range_requests\n BEGIN SELECT RAISE(ABORT,'source range request responses must be retained');END"},
  {"type":"trigger","name":"reject_asset_range_cross_request","table":"asset_range_requests","sql":"CREATE TRIGGER reject_asset_range_cross_request BEFORE INSERT ON asset_range_requests\n WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId)\n BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END"},
  {"type":"trigger","name":"reject_mutation_cross_range_request","table":"mutation_requests","sql":"CREATE TRIGGER reject_mutation_cross_range_request BEFORE INSERT ON mutation_requests\n WHEN EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)\n BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END"},
  {"type":"trigger","name":"immutable_asset_disposition_identity","table":"asset_dispositions","sql":"CREATE TRIGGER immutable_asset_disposition_identity BEFORE UPDATE ON asset_dispositions\n WHEN NEW.assetId IS NOT OLD.assetId OR NEW.projectId IS NOT OLD.projectId\n BEGIN SELECT RAISE(ABORT,'asset disposition identity is immutable');END"},
  {"type":"trigger","name":"reject_asset_disposition_request_replacement","table":"asset_disposition_requests","sql":"CREATE TRIGGER reject_asset_disposition_request_replacement BEFORE INSERT ON asset_disposition_requests\n WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)\n BEGIN SELECT RAISE(ABORT,'asset disposition request responses are immutable');END"},
  {"type":"trigger","name":"immutable_asset_disposition_requests","table":"asset_disposition_requests","sql":"CREATE TRIGGER immutable_asset_disposition_requests BEFORE UPDATE ON asset_disposition_requests\n BEGIN SELECT RAISE(ABORT,'asset disposition request responses are immutable');END"},
  {"type":"trigger","name":"retain_asset_disposition_requests","table":"asset_disposition_requests","sql":"CREATE TRIGGER retain_asset_disposition_requests BEFORE DELETE ON asset_disposition_requests\n BEGIN SELECT RAISE(ABORT,'asset disposition request responses must be retained');END"},
  {"type":"trigger","name":"reject_asset_disposition_cross_request","table":"asset_disposition_requests","sql":"CREATE TRIGGER reject_asset_disposition_cross_request BEFORE INSERT ON asset_disposition_requests\n WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId) OR\n EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)\n BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END"},
  {"type":"trigger","name":"reject_mutation_cross_disposition_request","table":"mutation_requests","sql":"CREATE TRIGGER reject_mutation_cross_disposition_request BEFORE INSERT ON mutation_requests\n WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)\n BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END"},
  {"type":"trigger","name":"reject_asset_range_cross_disposition_request","table":"asset_range_requests","sql":"CREATE TRIGGER reject_asset_range_cross_disposition_request BEFORE INSERT ON asset_range_requests\n WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)\n BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END"},
  {"type":"index","name":"agent_chat_one_active","table":"agent_chat_runs","sql":"CREATE UNIQUE INDEX agent_chat_one_active ON agent_chat_runs(projectId) WHERE status='running'"}
] as const;
const AUTO_INDEXES = [
  {"name":"sqlite_autoindex_agent_chat_events_1","table":"agent_chat_events"},
  {"name":"sqlite_autoindex_agent_chat_requests_1","table":"agent_chat_requests"},
  {"name":"sqlite_autoindex_agent_chat_requests_2","table":"agent_chat_requests"},
  {"name":"sqlite_autoindex_agent_chat_runs_1","table":"agent_chat_runs"},
  {"name":"sqlite_autoindex_agent_chat_runs_2","table":"agent_chat_runs"},
  {"name":"sqlite_autoindex_agent_chat_runs_3","table":"agent_chat_runs"},
  {"name":"sqlite_autoindex_agent_chat_steps_1","table":"agent_chat_steps"},
  {"name":"sqlite_autoindex_agent_chat_steps_2","table":"agent_chat_steps"},
  {"name":"sqlite_autoindex_agent_chat_threads_1","table":"agent_chat_threads"},
  {"name":"sqlite_autoindex_agent_chat_threads_2","table":"agent_chat_threads"},
  {"name":"sqlite_autoindex_agent_edit_proposals_1","table":"agent_edit_proposals"},
  {"name":"sqlite_autoindex_agent_edit_proposals_2","table":"agent_edit_proposals"},
  {"name":"sqlite_autoindex_asset_disposition_requests_1","table":"asset_disposition_requests"},
  {"name":"sqlite_autoindex_asset_dispositions_1","table":"asset_dispositions"},
  {"name":"sqlite_autoindex_asset_range_requests_1","table":"asset_range_requests"},
  {"name":"sqlite_autoindex_asset_ranges_1","table":"asset_ranges"},
  {"name":"sqlite_autoindex_assets_1","table":"assets"},
  {"name":"sqlite_autoindex_edges_1","table":"edges"},
  {"name":"sqlite_autoindex_exports_1","table":"exports"},
  {"name":"sqlite_autoindex_idempotency_1","table":"idempotency"},
  {"name":"sqlite_autoindex_jobs_1","table":"jobs"},
  {"name":"sqlite_autoindex_mutation_requests_1","table":"mutation_requests"},
  {"name":"sqlite_autoindex_nodes_1","table":"nodes"},
  {"name":"sqlite_autoindex_projects_1","table":"projects"},
  {"name":"sqlite_autoindex_reference_requests_1","table":"reference_requests"},
  {"name":"sqlite_autoindex_shots_1","table":"shots"},
  {"name":"sqlite_autoindex_timeline_history_1","table":"timeline_history"},
  {"name":"sqlite_autoindex_timeline_history_2","table":"timeline_history"},
  {"name":"sqlite_autoindex_timeline_history_cursors_1","table":"timeline_history_cursors"},
  {"name":"sqlite_autoindex_timeline_requests_1","table":"timeline_requests"},
  {"name":"sqlite_autoindex_timelines_1","table":"timelines"},
  {"name":"sqlite_autoindex_timelines_2","table":"timelines"},
  {"name":"sqlite_autoindex_versions_1","table":"versions"},
  {"name":"sqlite_autoindex_versions_2","table":"versions"},
  {"name":"sqlite_autoindex_waveform_cache_1","table":"waveform_cache"},
  {"name":"sqlite_autoindex_waveform_cache_2","table":"waveform_cache"},
  {"name":"sqlite_autoindex_workspace_preferences_1","table":"workspace_preferences"}
] as const;
const fold = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
const tableNames = new Set<string>(TABLES.map(table => table.name));
const reservedNames = new Set<string>([...tableNames, ...PROTECTIONS.map(object => object.name), ...AUTO_INDEXES.map(object => object.name)]);
interface SchemaObject {type: string; name: string; table: string; sql: string | null}

function unsupported(reason: string): never {
  throw Object.assign(new Error(`Ordinary receipt protection repair is unsupported: ${reason}`), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
}

function catalog(db: DatabaseSync, schema: 'main' | 'temp'): SchemaObject[] {
  const objects: SchemaObject[] = [];
  let bytes = 0;
  for (const value of db.prepare(`SELECT type,
    CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,
    CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name END AS tbl_name,
    CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql,
    length(CAST(sql AS BLOB)) AS bytes FROM ${schema}.sqlite_schema ORDER BY type,name LIMIT 1025`).iterate()) {
    if (objects.length >= 1024 || typeof value.type !== 'string' || typeof value.name !== 'string' ||
        typeof value.tbl_name !== 'string' || value.sql !== null && typeof value.sql !== 'string' ||
        value.bytes !== null && (typeof value.bytes !== 'number' || value.bytes > 131072 || (bytes += value.bytes) > 1048576)) {
      unsupported('schema catalog limit');
    }
    objects.push({type: value.type, name: value.name, table: value.tbl_name, sql: value.sql});
  }
  return objects;
}

/** Read-only preflight for historical additive safety dependencies. Run before
 * complete24 migration so malformed objects cannot leave a newly committed26.
 * Missing trusted guards are allowed; changed definitions and collisions are
 * not. Unrelated application/custom objects are neither run nor modified. */
export function validateWorkspaceReceiptProtections(db: DatabaseSync): void {
  // Performance-only indexes and unrelated custom triggers remain outside this
  // safety repair. Creating the fixed guards executes none of them. This is not
  // a complete ordinary catalog allowlist; non-colliding objects stay untouched.
  const relevant = (object: SchemaObject) => reservedNames.has(fold(object.name));
  // schema26 already validates main.schema_version and rejects executable TEMP
  // marker dependencies. Preserve its supported harmless TEMP marker-table
  // shadow: this repair never accesses that table through an unqualified name.
  if (catalog(db, 'temp').some(object => relevant(object) && fold(object.name) !== 'schema_version')) unsupported('temporary receipt object or shadow');
  const objects = catalog(db, 'main');
  for (const object of objects.filter(relevant)) {
    if (TABLES.some(known => object.type === 'table' && object.name === known.name && object.table === known.name && object.sql === known.sql)) continue;
    if (AUTO_INDEXES.some(known => object.type === 'index' && object.name === known.name && object.table === known.table && object.sql === null)) continue;
    if (PROTECTIONS.some(known => object.type === known.type && object.name === known.name && object.table === known.table && object.sql === known.sql)) continue;
    unsupported('unknown or changed receipt table, index, trigger or name collision');
  }
  for (const table of TABLES) {
    if (!objects.some(object => object.type === 'table' && object.name === table.name)) unsupported('missing receipt table');
  }
  for (const index of AUTO_INDEXES) {
    if (!objects.some(object => object.type === 'index' && object.name === index.name)) unsupported('missing receipt identity index');
  }
  if (!db.prepare('SELECT 1 FROM main.agent_chat_quota WHERE id=1').get()) unsupported('missing historical quota state');
  if (!objects.some(object => object.name === 'agent_chat_one_active') &&
      db.prepare("SELECT 1 FROM main.agent_chat_runs WHERE status='running' GROUP BY projectId HAVING COUNT(*)>1 LIMIT 1").get()) {
    unsupported('conflicting active chat runs');
  }
}

/** Internal fixed-schema hook. The ordinary26 initializer validates role/table
 * shape before calling this under its existing write transaction. Complete24
 * migration and all additive protections therefore commit or roll back together.
 * This helper never starts/commits a transaction or writes receipt/marker rows. */
export function repairWorkspaceReceiptProtectionsInTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) unsupported('receipt repair requires the ordinary schema transaction');
  validateWorkspaceReceiptProtections(db);
  const names = new Set(catalog(db, 'main').map(object => object.name));
  for (const protection of PROTECTIONS) {
    if (!names.has(protection.name)) db.exec(protection.sql.replace(/^(CREATE (?:UNIQUE )?(?:INDEX|TRIGGER) )/, '$1main.'));
  }
  validateWorkspaceReceiptProtections(db);
}

/** Marker-only migrations cannot repair safety objects as a side effect. Keep
 * the historical repair preflight unchanged, but require every trusted guard. */
export function assertCompleteWorkspaceReceiptProtections(db: DatabaseSync): void {
  validateWorkspaceReceiptProtections(db);
  const names = new Set(catalog(db, 'main').map(object => object.name));
  if (PROTECTIONS.some(protection => !names.has(protection.name))) unsupported('missing receipt protection');
}
