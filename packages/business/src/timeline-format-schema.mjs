// One guarded expression shared by the read boundary and its index. Legacy
// receipts are never parsed/re-serialized or backfilled during this migration.
export const TIMELINE_RECEIPT_PROJECT_EXPRESSION = `CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 4194304
 THEN CASE WHEN json_valid(response) THEN CASE WHEN json_type(response,'$.projectId')='text' AND length(CAST(json_extract(response,'$.projectId') AS BLOB))=36
 THEN json_extract(response,'$.projectId') END END END`;
export function migrateTimelineFormatSchema(db){
 if(!db.isTransaction)throw new Error('Timeline format migration requires a transaction');
 db.exec(`CREATE TABLE timeline_format_requests(
 requestId TEXT NOT NULL PRIMARY KEY REFERENCES timeline_requests(requestId) CHECK(length(requestId) BETWEEN 8 AND 200),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 input TEXT NOT NULL CHECK(typeof(input)='text' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 2048 AND json_valid(input) AND json_type(input)='object'),
 CHECK(json_extract(input,'$.projectId') IS projectId AND json_extract(input,'$.requestId') IS requestId));
 CREATE INDEX timeline_format_requests_project ON timeline_format_requests(projectId,requestId);
 CREATE INDEX timeline_requests_project ON timeline_requests(${TIMELINE_RECEIPT_PROJECT_EXPRESSION},requestId);
 CREATE TRIGGER immutable_timeline_format_requests BEFORE UPDATE ON timeline_format_requests
 BEGIN SELECT RAISE(ABORT,'timeline format requests are immutable');END;
 CREATE TRIGGER retain_timeline_format_requests BEFORE DELETE ON timeline_format_requests
 BEGIN SELECT RAISE(ABORT,'timeline format requests must be retained');END;
 CREATE TRIGGER reject_timeline_format_replacement BEFORE INSERT ON timeline_format_requests
 WHEN EXISTS(SELECT 1 FROM timeline_format_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'timeline format request identities are immutable');END;`);
}
