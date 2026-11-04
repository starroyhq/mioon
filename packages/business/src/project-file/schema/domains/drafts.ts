/** Private UI recovery records. All references stay inside history; missing
 * content targets remain discoverable and are never removed by a cascade. */
export const DRAFT_TABLES = Object.freeze(['local_draft_states', 'local_clip_drafts', 'local_delivery_drafts', 'local_shot_text_drafts']);

const MAX = 9007199254740991;
const uuid = (name: string): string => `${name} TEXT NOT NULL CHECK(typeof(${name})='text' AND length(CAST(${name} AS BLOB))=36)`;
const revision = (name: string, minimum = 0): string => `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name} BETWEEN ${minimum} AND ${MAX})`;
const projected = (name: string, type: 'text' | 'integer'): string => `json_type(data,'$.${name}') IS '${type}' AND ${name} IS json_extract(data,'$.${name}')`;
const ordinal = revision('ordinal', 1) + ',UNIQUE(ordinal)';
const payload = (bytes: number): string => `data TEXT NOT NULL CHECK(typeof(data)='text' AND json_valid(data) AND json_type(data) IS 'object') CONSTRAINT local_draft_row_limit CHECK(length(CAST(data AS BLOB)) BETWEEN 1 AND ${bytes})`;

const clip = `CREATE TABLE local_clip_drafts(${uuid('projectId')},${uuid('timelineId')},${uuid('clipId')},${revision('revision', 1)},${payload(8192)},${ordinal},PRIMARY KEY(projectId,timelineId,clipId),CHECK(${['projectId', 'timelineId', 'clipId'].map(key => projected(key, 'text')).join(' AND ')} AND ${projected('revision', 'integer')} AND (json_type(data,'$.draft') IS 'object' OR json_type(data,'$.draft') IS 'null')))`;

function intentTable(table: string, shot: boolean): string {
  const keys = shot ? ['projectId', 'shotId'] : ['projectId'];
  const status = shot ? "'pending','applied','not_applied'" : "'pending','accepted','not_applied'";
  return `CREATE TABLE ${table}(${keys.map(key => uuid(key)).join(',')},${revision('draftRevision')},${revision('intentRevision')},intentId TEXT,requestId TEXT,intentStatus TEXT,${payload(shot ? 262144 : 8192)},${ordinal},PRIMARY KEY(${keys.join(',')}),${shot ? 'UNIQUE(shotId),' : ''}CHECK(${keys.map(key => projected(key, 'text')).join(' AND ')} AND ${projected('draftRevision', 'integer')} AND ${projected('intentRevision', 'integer')}),CHECK((json_type(data,'$.draft') IS 'object' OR json_type(data,'$.draft') IS 'null') AND (draftRevision>0 OR json_type(data,'$.draft') IS 'null')),CHECK(draftRevision>0 OR intentRevision>0),CHECK((intentRevision=0 AND json_type(data,'$.intent') IS 'null' AND intentId IS NULL AND requestId IS NULL AND intentStatus IS NULL) OR (intentRevision>0 AND json_type(data,'$.intent') IS 'object' AND typeof(intentId)='text' AND length(CAST(intentId AS BLOB))=36 AND typeof(requestId)='text' AND length(CAST(requestId AS BLOB)) BETWEEN 1 AND 800 AND typeof(intentStatus)='text' AND intentStatus IN (${status}) AND json_type(data,'$.intent.intentId') IS 'text' AND json_type(data,'$.intent.input.requestId') IS 'text' AND json_type(data,'$.intent.outcome.status') IS 'text' AND intentId IS json_extract(data,'$.intent.intentId') AND requestId IS json_extract(data,'$.intent.input.requestId') AND intentStatus IS json_extract(data,'$.intent.outcome.status'))))`;
}

interface SlotDefinition {
  table: string;
  kind: string;
  keys: readonly string[];
  revisions: readonly string[];
  bytes: number;
  intent?: boolean;
  shot?: boolean;
}

function guards({table, kind, keys, revisions, bytes, intent, shot}: SlotDefinition): string[] {
  const unique = [keys.map(key => `${key} IS NEW.${key}`).join(' AND '), 'ordinal IS NEW.ordinal', 'rowid IS NEW.rowid'];
  if (intent) unique.push('(NEW.intentId IS NOT NULL AND intentId IS NEW.intentId)', '(NEW.requestId IS NOT NULL AND requestId IS NEW.requestId)');
  if (shot) unique.push('shotId IS NEW.shotId', "(NEW.intentStatus='pending' AND intentStatus='pending' AND projectId IS NEW.projectId)");
  const statements: string[] = [];
  for (const operation of ['INSERT', 'UPDATE'] as const) {
    const excluding = operation === 'UPDATE' ? 'rowid IS NOT OLD.rowid AND ' : '';
    const unchanged = operation === 'UPDATE'
      ? `SELECT CASE WHEN ${[...keys, 'ordinal', 'rowid'].map(key => `NEW.${key} IS NOT OLD.${key}`).join(' OR ')} OR ${revisions.map(key => `NEW.${key}<OLD.${key}`).join(' OR ')} THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_IDENTITY') END;` : '';
    statements.push(`CREATE TRIGGER ${table}_guard_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN ${unchanged}SELECT CASE WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_PROJECT') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM local_draft_states WHERE kind='${kind}') THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE') END;SELECT CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${excluding}(${unique.join(' OR ')})) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CONFLICT') END;SELECT CASE WHEN (SELECT count(*) FROM ${table} ${operation === 'UPDATE' ? 'WHERE rowid IS NOT OLD.rowid' : ''})>=128 OR (SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM ${table} ${operation === 'UPDATE' ? 'WHERE rowid IS NOT OLD.rowid' : ''})+length(CAST(NEW.data AS BLOB))>${bytes} THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CAPACITY') END;END`);
  }
  // An unspecified rowid is -1 in BEFORE INSERT, so its positivity can only
  // be checked after SQLite assigns it. RAISE rolls back explicit negatives.
  statements.push(`CREATE TRIGGER ${table}_positive_rowid AFTER INSERT ON ${table} WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_IDENTITY');END`);
  if (intent) {
    for (const field of ['intentId', 'requestId']) statements.push(`CREATE UNIQUE INDEX ${table}_${field} ON ${table}(${field}) WHERE ${field} IS NOT NULL`);
  }
  if (shot) statements.push(`CREATE UNIQUE INDEX ${table}_pending ON ${table}(projectId) WHERE intentStatus='pending'`);
  return statements;
}

export const DRAFT_SCHEMA: readonly string[] = Object.freeze([
  "CREATE TABLE local_draft_states(kind TEXT PRIMARY KEY NOT NULL CHECK(kind IN ('clip','delivery','shot-text')),workspaceScope TEXT NOT NULL CHECK(typeof(workspaceScope)='text' AND length(workspaceScope)=64 AND length(CAST(workspaceScope AS BLOB))=64 AND workspaceScope NOT GLOB '*[^0-9a-f]*'))",
  "CREATE TRIGGER local_draft_states_guard_insert BEFORE INSERT ON local_draft_states WHEN EXISTS(SELECT 1 FROM local_draft_states WHERE kind IS NEW.kind OR rowid IS NEW.rowid) BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE');END",
  "CREATE TRIGGER local_draft_states_guard_update BEFORE UPDATE ON local_draft_states BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE');END",
  "CREATE TRIGGER local_draft_states_guard_delete BEFORE DELETE ON local_draft_states BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE');END",
  "CREATE TRIGGER local_draft_states_positive_rowid AFTER INSERT ON local_draft_states WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE');END",
  clip,
  intentTable('local_delivery_drafts', false),
  intentTable('local_shot_text_drafts', true),
  ...guards({table: 'local_clip_drafts', kind: 'clip', keys: ['projectId', 'timelineId', 'clipId'], revisions: ['revision'], bytes: 2097152}),
  ...guards({table: 'local_delivery_drafts', kind: 'delivery', keys: ['projectId'], revisions: ['draftRevision', 'intentRevision'], bytes: 2097152, intent: true}),
  ...guards({table: 'local_shot_text_drafts', kind: 'shot-text', keys: ['projectId', 'shotId'], revisions: ['draftRevision', 'intentRevision'], bytes: 16777216, intent: true, shot: true}),
]);
