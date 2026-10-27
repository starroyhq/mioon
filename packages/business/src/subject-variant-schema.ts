import type {DatabaseSync} from 'node:sqlite';

// Schema62 subject angle/lighting batches, their items and receipts, plus the
// relaxed subject identity guard: a version that carries a variant advances the
// revision without replacing the head, and a variant can never become the head.
// Every bound is a literal because restore profiles compare this exact SQL.
// Retention guards carry the project-deletion exemption of schema48. A variant
// version whose batch is not in this workspace (an imported project) keeps its
// label; one that names a local batch must match it while it is active.
const retained=(table: string,message: string): string=>`CREATE TRIGGER retain_${table} BEFORE DELETE ON ${table}
 WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='${table}' AND rowId=OLD.rowid)
 BEGIN SELECT RAISE(ABORT,'${message}');END;`;
const SUBJECT_VARIANT_SCHEMA_62_SQL=`
DROP TRIGGER immutable_subject_identity;
CREATE TRIGGER immutable_subject_identity_v62 BEFORE UPDATE ON subjects
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.kind IS NOT OLD.kind OR NEW.name IS NOT OLD.name OR NEW.createdAt IS NOT OLD.createdAt OR NEW.revision IS NOT OLD.revision+1
 OR (NEW.headVersionId IS OLD.headVersionId AND NOT EXISTS(SELECT 1 FROM subject_versions WHERE subjectId=NEW.id AND projectId=NEW.projectId AND number=NEW.revision AND json_type(data,'$.variant') IS 'object'))
 OR (NEW.headVersionId IS NOT OLD.headVersionId AND EXISTS(SELECT 1 FROM subject_versions WHERE id=NEW.headVersionId AND json_type(data,'$.variant') IS NOT NULL))
 BEGIN SELECT RAISE(ABORT,'subject identity is immutable and revisions must advance');END;
CREATE TABLE subject_variant_batches(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 subjectId TEXT NOT NULL CHECK(length(CAST(subjectId AS BLOB))=36),
 sourceVersionId TEXT NOT NULL CHECK(length(CAST(sourceVersionId AS BLOB))=36),
 kind TEXT NOT NULL CHECK(kind IN ('angle','light')),
 requestId TEXT NOT NULL UNIQUE CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 8192),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND json_type(snapshot)='object' AND length(CAST(snapshot AS BLOB)) BETWEEN 1 AND 49152),
 state TEXT NOT NULL CHECK(state IN ('active','undone')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(id,projectId),
 FOREIGN KEY(subjectId,projectId) REFERENCES subjects(id,projectId),
 FOREIGN KEY(sourceVersionId,subjectId,projectId) REFERENCES subject_versions(id,subjectId,projectId),
 CHECK(json_extract(input,'$.projectId') IS projectId AND json_extract(input,'$.requestId') IS requestId AND json_extract(input,'$.subjectId') IS subjectId
 AND json_extract(input,'$.sourceVersionId') IS sourceVersionId AND json_extract(input,'$.kind') IS kind),
 CHECK(json_extract(snapshot,'$.schemaVersion') IS 1 AND json_extract(snapshot,'$.batchId') IS id AND json_extract(snapshot,'$.projectId') IS projectId
 AND json_extract(snapshot,'$.subjectId') IS subjectId AND json_extract(snapshot,'$.sourceVersionId') IS sourceVersionId AND json_extract(snapshot,'$.kind') IS kind
 AND json_type(snapshot,'$.items') IS 'array' AND json_array_length(snapshot,'$.items') BETWEEN 1 AND 8),
 CHECK(state!='active' OR revision>=1)
);
CREATE TABLE subject_variant_items(
 batchId TEXT NOT NULL CHECK(length(CAST(batchId AS BLOB))=36),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 1 AND 8),
 attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt BETWEEN 1 AND 64),
 imageRequestId TEXT NOT NULL UNIQUE CHECK(imageRequestId IS 'subject-variant:'||batchId||':'||position||':'||attempt),
 versionId TEXT UNIQUE CHECK(versionId IS NULL OR length(CAST(versionId AS BLOB))=36),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 PRIMARY KEY(batchId,position),
 FOREIGN KEY(batchId,projectId) REFERENCES subject_variant_batches(id,projectId),
 FOREIGN KEY(versionId) REFERENCES subject_versions(id)
);
CREATE TABLE subject_variant_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('subject.variants.create','subject.variants.retry','subject.variants.undo')),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 batchId TEXT NOT NULL CHECK(length(CAST(batchId AS BLOB))=36),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 8192),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 65536),
 FOREIGN KEY(batchId,projectId) REFERENCES subject_variant_batches(id,projectId),
 CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId),
 CHECK(json_extract(response,'$.projectId') IS projectId AND json_extract(response,'$.id') IS batchId),
 CHECK(operation!='subject.variants.create' OR (json_extract(response,'$.requestId') IS requestId AND json_extract(response,'$.state') IS 'active' AND json_extract(response,'$.revision') IS 1)),
 CHECK(operation='subject.variants.create' OR (json_extract(canonicalInput,'$.batchId') IS batchId
 AND json_extract(response,'$.revision') IS json_extract(canonicalInput,'$.expectedRevision')+1)),
 CHECK(operation!='subject.variants.undo' OR json_extract(response,'$.state') IS 'undone')
);
CREATE INDEX subject_variant_batches_subject_page ON subject_variant_batches(projectId,subjectId,createdAt DESC,id DESC);
CREATE INDEX subject_variant_batches_source ON subject_variant_batches(sourceVersionId);
CREATE INDEX subject_variant_requests_batch ON subject_variant_requests(batchId,requestId);
CREATE TRIGGER subject_variant_batch_insert_identity BEFORE INSERT ON subject_variant_batches
 WHEN NEW.state IS NOT 'active' OR NEW.revision IS NOT 1 OR NEW.updatedAt IS NOT NEW.createdAt
 OR NOT EXISTS(SELECT 1 FROM subjects WHERE id=NEW.subjectId AND projectId=NEW.projectId AND kind IN ('character','product'))
 BEGIN SELECT RAISE(ABORT,'subject variant batches must start active for a character or product');END;
CREATE TRIGGER immutable_subject_variant_batch_identity BEFORE UPDATE ON subject_variant_batches
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.subjectId IS NOT OLD.subjectId OR NEW.sourceVersionId IS NOT OLD.sourceVersionId
 OR NEW.kind IS NOT OLD.kind OR NEW.requestId IS NOT OLD.requestId OR NEW.inputHash IS NOT OLD.inputHash OR NEW.input IS NOT OLD.input
 OR NEW.snapshot IS NOT OLD.snapshot OR NEW.createdAt IS NOT OLD.createdAt OR NEW.revision IS NOT OLD.revision+1
 OR NOT (NEW.state IS OLD.state OR (OLD.state='active' AND NEW.state='undone'))
 BEGIN SELECT RAISE(ABORT,'subject variant batch identity is immutable and revisions must advance');END;
${retained('subject_variant_batches','subject variant batches must be retained')}
CREATE TRIGGER reject_subject_variant_batch_replacement BEFORE INSERT ON subject_variant_batches
 WHEN EXISTS(SELECT 1 FROM subject_variant_batches WHERE id=NEW.id OR requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'subject variant batches cannot be replaced');END;
CREATE TRIGGER subject_variant_batch_capacity BEFORE INSERT ON subject_variant_batches
 WHEN (SELECT COUNT(*) FROM subject_variant_batches)>=8192 OR (SELECT COUNT(*) FROM subject_variant_batches WHERE projectId=NEW.projectId)>=1024
 BEGIN SELECT RAISE(ABORT,'subject variant batch capacity exceeded');END;
CREATE TRIGGER subject_variant_item_insert_identity BEFORE INSERT ON subject_variant_items
 WHEN NEW.attempt IS NOT 1 OR NEW.versionId IS NOT NULL OR NEW.revision IS NOT 1
 OR NOT EXISTS(SELECT 1 FROM subject_variant_batches b WHERE b.id=NEW.batchId AND b.projectId=NEW.projectId AND b.state='active' AND b.revision=1
 AND NEW.position<=json_array_length(b.snapshot,'$.items') AND b.updatedAt IS NEW.updatedAt)
 BEGIN SELECT RAISE(ABORT,'subject variant items start with their batch');END;
CREATE TRIGGER immutable_subject_variant_item_identity BEFORE UPDATE ON subject_variant_items
 WHEN NEW.batchId IS NOT OLD.batchId OR NEW.projectId IS NOT OLD.projectId OR NEW.position IS NOT OLD.position OR NEW.revision IS NOT OLD.revision+1
 OR (OLD.versionId IS NOT NULL AND NEW.versionId IS NOT OLD.versionId)
 OR NOT ((NEW.attempt IS OLD.attempt AND OLD.versionId IS NULL AND NEW.versionId IS NOT NULL)
 OR (NEW.attempt IS OLD.attempt+1 AND OLD.versionId IS NULL AND NEW.versionId IS NULL))
 OR NOT EXISTS(SELECT 1 FROM subject_variant_batches WHERE id=NEW.batchId AND projectId=NEW.projectId AND state='active')
 BEGIN SELECT RAISE(ABORT,'subject variant items only gain a version or a new attempt');END;
CREATE TRIGGER subject_variant_item_version BEFORE UPDATE OF versionId ON subject_variant_items
 WHEN NEW.versionId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subject_versions v JOIN subject_variant_batches b ON b.id=NEW.batchId
 WHERE v.id=NEW.versionId AND v.projectId=NEW.projectId AND v.subjectId=b.subjectId AND json_extract(v.data,'$.variant.batchId') IS NEW.batchId)
 BEGIN SELECT RAISE(ABORT,'subject variant item version must be its own result');END;
${retained('subject_variant_items','subject variant items must be retained')}
CREATE TRIGGER subject_variant_version_binding BEFORE INSERT ON subject_versions
 WHEN json_type(NEW.data,'$.variant') IS NOT NULL AND EXISTS(SELECT 1 FROM subject_variant_batches WHERE id=json_extract(NEW.data,'$.variant.batchId'))
 AND NOT EXISTS(SELECT 1 FROM subject_variant_batches b WHERE b.id=json_extract(NEW.data,'$.variant.batchId')
 AND b.projectId=NEW.projectId AND b.subjectId=NEW.subjectId AND b.state='active' AND b.kind=json_extract(NEW.data,'$.variant.kind')
 AND b.sourceVersionId=json_extract(NEW.data,'$.variant.sourceVersionId'))
 BEGIN SELECT RAISE(ABORT,'subject variant versions must belong to an active batch');END;
CREATE TRIGGER subject_variant_request_identity BEFORE INSERT ON subject_variant_requests
 WHEN NOT EXISTS(SELECT 1 FROM subject_variant_batches b WHERE b.id=NEW.batchId AND b.projectId=NEW.projectId
 AND json_extract(NEW.response,'$.subjectId') IS b.subjectId AND json_extract(NEW.response,'$.kind') IS b.kind AND json_extract(NEW.response,'$.revision') IS b.revision
 AND json_extract(NEW.response,'$.state') IS b.state AND json_extract(NEW.response,'$.createdAt') IS b.createdAt AND json_extract(NEW.response,'$.updatedAt') IS b.updatedAt
 AND (NEW.operation!='subject.variants.create' OR (NEW.requestId=b.requestId AND NEW.inputHash=b.inputHash AND NEW.canonicalInput=b.input)))
 BEGIN SELECT RAISE(ABORT,'subject variant request must bind its original acknowledgement');END;
CREATE TRIGGER immutable_subject_variant_requests BEFORE UPDATE ON subject_variant_requests
 BEGIN SELECT RAISE(ABORT,'subject variant request responses are immutable');END;
${retained('subject_variant_requests','subject variant request responses must be retained')}
CREATE TRIGGER reject_subject_variant_request_replacement BEFORE INSERT ON subject_variant_requests
 WHEN EXISTS(SELECT 1 FROM subject_variant_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'subject variant request responses cannot be replaced');END;
CREATE TRIGGER subject_variant_request_capacity BEFORE INSERT ON subject_variant_requests
 WHEN (SELECT COUNT(*) FROM subject_variant_requests WHERE batchId=NEW.batchId)>=128
 OR (SELECT COUNT(*) FROM subject_variant_requests WHERE projectId=NEW.projectId)>=4096 OR (SELECT COUNT(*) FROM subject_variant_requests)>=32768
 BEGIN SELECT RAISE(ABORT,'subject variant request capacity exceeded');END;
`;

/** Trusted construction only: the schema62 migration and fixed restore
 * profiles. The caller owns the transaction and the schema marker. */
export function installSubjectVariantDefinitions(db: DatabaseSync): void {
 if(!db.isTransaction)throw Object.assign(new Error('Subject variant schema installation requires a transaction'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec(SUBJECT_VARIANT_SCHEMA_62_SQL);
}

/** Bounded row sanity for classification. The DDL itself is compared exactly
 * by the fixed profiles; record contents are verified by the readers. */
export function validateSubjectVariantRows(db: DatabaseSync): void {
 const invalid=(): never=>{throw Object.assign(new Error('Subject variant rows are invalid'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});};
 const count=(table: string,cap: number): number=>Number(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ${cap+1})`).get()!.n);
 if(count('subject_variant_batches',8192)>8192||count('subject_variant_items',65536)>65536||count('subject_variant_requests',32768)>32768)invalid();
 // Every batch has exactly the items its snapshot plans.
 if(db.prepare(`SELECT 1 FROM subject_variant_batches b WHERE json_array_length(b.snapshot,'$.items')!=(SELECT count(*) FROM subject_variant_items i WHERE i.batchId=b.id) LIMIT 1`).get())invalid();
}
