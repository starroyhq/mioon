const uuid = (column: string): string =>
  `length(${column})=36 AND ${column}=lower(${column}) AND substr(${column},9,1)='-' AND substr(${column},14,1)='-' AND substr(${column},19,1)='-' AND substr(${column},24,1)='-' AND length(replace(${column},'-',''))=32 AND replace(${column},'-','') NOT GLOB '*[^a-f0-9]*'`;
const time = (column: string): string => `length(${column})=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',${column}) IS ${column}`;
const revision = (column: string, first: number): string => `typeof(${column})='integer' AND ${column} BETWEEN ${first} AND 9007199254740991`;
const json = (column: string, bytes: number): string =>
  `CASE WHEN length(CAST(${column} AS BLOB)) BETWEEN 2 AND ${bytes} AND json_valid(${column}) THEN json_type(${column})='object' ELSE 0 END`;
const editOperations = "'archive','restore','move','paste','layout'";
export const FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION = 11;
/** 12 gives canvas receipts a bounded, replay-safe expiration window. */
export const FORMAT4_HISTORY_SCHEMA_VERSION = 12;

export const CANVAS_ARCHIVE_TABLES = ['shots', 'nodes', 'edges'] as const;
export type CanvasArchiveTable = typeof CANVAS_ARCHIVE_TABLES[number];
export const CANVAS_ARCHIVE_COLUMNS = ['archivedAt', 'archiveBatchId', 'archiveReason'] as const;

export function canvasArchiveColumnDefinitions(table: CanvasArchiveTable): readonly string[] {
  const reasons = table === 'edges' ? "'user-delete','undo-create','reference-source'" : "'user-delete','undo-create'";
  return ['archivedAt TEXT', 'archiveBatchId TEXT',
    `archiveReason TEXT CHECK((archivedAt IS NULL AND archiveBatchId IS NULL AND archiveReason IS NULL) OR (archivedAt IS NOT NULL AND archiveBatchId IS NOT NULL AND archiveReason IS NOT NULL AND ${time('archivedAt')} AND ${uuid('archiveBatchId')} AND archiveReason IN (${reasons})))`];
}

export const CANVAS_ARCHIVE_INDEXES = CANVAS_ARCHIVE_TABLES.map(table =>
  `CREATE INDEX canvas_archived_${table} ON ${table}(projectId,archivedAt,id) WHERE archivedAt IS NOT NULL`);

/** Only the three archive-aware UPDATE triggers change their target evidence. */
export function canvasArchiveRevisionStatements(content: readonly string[]): readonly string[] {
  return CANVAS_ARCHIVE_TABLES.map(table => {
    const prefix = `CREATE TRIGGER agent_target_${table}_update_v2 `;
    const statement = content.find(sql => sql.startsWith(prefix));
    if (!statement || !statement.includes(') BEGIN INSERT')) throw new Error(`Missing target revision trigger for ${table}`);
    const changed = CANVAS_ARCHIVE_COLUMNS.map(column => `NEW."${column}" IS NOT OLD."${column}"`).join(' OR ');
    return statement.replace(') BEGIN INSERT', ` OR ${changed}) BEGIN INSERT`);
  });
}

export const CANVAS_RECEIPT_ISSUED_AT = `issuedAt INTEGER CHECK(issuedAt IS NULL OR (${revision('issuedAt', 0)}))`;
export const CANVAS_RECEIPT_WINDOW_SCHEMA = Object.freeze([
  'CREATE INDEX canvas_requests_expiry ON canvas_requests(issuedAt,requestId)',
  `CREATE TABLE canvas_receipt_window(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 epoch TEXT NOT NULL CHECK(length(epoch)=32 AND epoch NOT GLOB '*[^0-9a-f]*'),
 floor INTEGER NOT NULL CHECK(${revision('floor', 0)}))`,
]);

/** Canvas receipts use their own expiry window, independent of the undo stack. */
export const CANVAS_HISTORY_SCHEMA: readonly string[] = Object.freeze([
  `CREATE TABLE canvas_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 projectId TEXT NOT NULL CHECK(${uuid('projectId')}),
 operation TEXT NOT NULL CHECK(operation IN (${editOperations},'undo','redo')),
 inputDigest TEXT NOT NULL CHECK(length(inputDigest)=64 AND inputDigest NOT GLOB '*[^a-f0-9]*'),
 response TEXT NOT NULL CHECK(${json('response', 65536)}),
 createdAt TEXT NOT NULL CHECK(${time('createdAt')}), ${CANVAS_RECEIPT_ISSUED_AT})`,
  "CREATE TRIGGER immutable_canvas_requests BEFORE UPDATE ON canvas_requests BEGIN SELECT RAISE(ABORT,'canvas request receipts are immutable');END",
  "CREATE TRIGGER reject_canvas_request_replacement BEFORE INSERT ON canvas_requests WHEN EXISTS(SELECT 1 FROM canvas_requests WHERE requestId=NEW.requestId) BEGIN SELECT RAISE(ABORT,'canvas request receipts cannot be replaced');END",
  `CREATE TABLE canvas_history_entries(
 id TEXT PRIMARY KEY NOT NULL CHECK(${uuid('id')}),
 projectId TEXT NOT NULL CHECK(${uuid('projectId')}),
 position INTEGER NOT NULL CHECK(${revision('position', 1)}),
 operation TEXT NOT NULL CHECK(operation IN (${editOperations})),
 beforePatch TEXT NOT NULL CHECK(${json('beforePatch', 1048576)}),
 afterPatch TEXT NOT NULL CHECK(${json('afterPatch', 1048576)}),
 createdAt TEXT NOT NULL CHECK(${time('createdAt')}),
 CHECK(length(CAST(beforePatch AS BLOB))+length(CAST(afterPatch AS BLOB))<=1048576),
 UNIQUE(projectId,position))`,
  `CREATE TABLE canvas_history_state(
 projectId TEXT PRIMARY KEY NOT NULL CHECK(${uuid('projectId')}),
 position INTEGER NOT NULL CHECK(${revision('position', 0)}),
 revision INTEGER NOT NULL CHECK(${revision('revision', 1)}),
 evidence TEXT NOT NULL CHECK(${json('evidence', 1048576)}))`,
  ...CANVAS_RECEIPT_WINDOW_SCHEMA,
]);
