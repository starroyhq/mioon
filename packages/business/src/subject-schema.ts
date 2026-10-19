// Additive only. The caller owns the migration transaction and schema version.
// Never recreate an old table, rewrite legacy JSON, or alter older receipts.
export function migrateSubjectSchema(db){
 db.exec(`
 CREATE TABLE IF NOT EXISTS subjects(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),
 kind TEXT NOT NULL CHECK(kind IN ('character','product','location','look')),
 name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 480),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 headVersionId TEXT NOT NULL,createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(id,projectId),FOREIGN KEY(headVersionId,id,projectId) REFERENCES subject_versions(id,subjectId,projectId) DEFERRABLE INITIALLY DEFERRED);
 CREATE TABLE IF NOT EXISTS subject_versions(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),subjectId TEXT NOT NULL,
 number INTEGER NOT NULL CHECK(typeof(number)='integer' AND number BETWEEN 1 AND 9007199254740991),
 assetId TEXT NOT NULL REFERENCES assets(id),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4096),
 UNIQUE(subjectId,number),UNIQUE(id,subjectId,projectId),FOREIGN KEY(subjectId,projectId) REFERENCES subjects(id,projectId),
 CHECK(json_type(data)='object' AND json_extract(data,'$.id') IS id AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.subjectId') IS subjectId AND json_extract(data,'$.number') IS number AND json_extract(data,'$.assetId') IS assetId));
 CREATE TABLE IF NOT EXISTS subject_bindings(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),shotId TEXT NOT NULL REFERENCES shots(id),subjectId TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('subject','style')),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 subjectVersionId TEXT,reviewedHeadVersionId TEXT NOT NULL,
 createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(shotId,subjectId,role),FOREIGN KEY(subjectId,projectId) REFERENCES subjects(id,projectId),
 FOREIGN KEY(subjectVersionId,subjectId,projectId) REFERENCES subject_versions(id,subjectId,projectId),
 FOREIGN KEY(reviewedHeadVersionId,subjectId,projectId) REFERENCES subject_versions(id,subjectId,projectId));
 CREATE TABLE IF NOT EXISTS subject_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation IN ('subject.create','subject.version.add','subject.binding.set')),
 projectId TEXT NOT NULL REFERENCES projects(id),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 8192 AND json_type(canonicalInput)='object' AND json_extract(canonicalInput,'$.projectId') IS projectId),
 response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB)) BETWEEN 1 AND 16384 AND json_type(response)='object' AND json_extract(response,'$.projectId') IS projectId));
 CREATE INDEX IF NOT EXISTS subjects_project_page ON subjects(projectId,id);
 CREATE INDEX IF NOT EXISTS subject_versions_page ON subject_versions(projectId,subjectId,number);
 CREATE INDEX IF NOT EXISTS subject_bindings_shot_page ON subject_bindings(projectId,shotId,id);
 CREATE INDEX IF NOT EXISTS subject_bindings_subject_page ON subject_bindings(projectId,subjectId,id);
 CREATE INDEX IF NOT EXISTS subject_bindings_active_shot ON subject_bindings(shotId) WHERE subjectVersionId IS NOT NULL;
 CREATE TRIGGER IF NOT EXISTS immutable_subject_identity BEFORE UPDATE ON subjects
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.kind IS NOT OLD.kind OR NEW.name IS NOT OLD.name OR NEW.createdAt IS NOT OLD.createdAt OR NEW.revision IS NOT OLD.revision+1 OR NEW.headVersionId IS OLD.headVersionId
 BEGIN SELECT RAISE(ABORT,'subject identity is immutable and revisions must advance');END;
 CREATE TRIGGER IF NOT EXISTS reject_subject_replacement BEFORE INSERT ON subjects WHEN EXISTS(SELECT 1 FROM subjects WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'subjects cannot be replaced');END;
 CREATE TRIGGER IF NOT EXISTS immutable_subject_versions BEFORE UPDATE ON subject_versions BEGIN SELECT RAISE(ABORT,'subject versions are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_subject_versions BEFORE DELETE ON subject_versions BEGIN SELECT RAISE(ABORT,'subject versions must be retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_subject_version_replacement BEFORE INSERT ON subject_versions
 WHEN EXISTS(SELECT 1 FROM subject_versions WHERE id=NEW.id OR (subjectId=NEW.subjectId AND number=NEW.number))
 BEGIN SELECT RAISE(ABORT,'subject versions are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_subject_binding_identity BEFORE UPDATE ON subject_bindings
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.shotId IS NOT OLD.shotId OR NEW.subjectId IS NOT OLD.subjectId OR NEW.role IS NOT OLD.role OR NEW.createdAt IS NOT OLD.createdAt OR NEW.revision IS NOT OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'subject binding identity is immutable and revisions must advance');END;
 CREATE TRIGGER IF NOT EXISTS reject_subject_binding_replacement BEFORE INSERT ON subject_bindings
 WHEN EXISTS(SELECT 1 FROM subject_bindings WHERE id=NEW.id OR (shotId=NEW.shotId AND subjectId=NEW.subjectId AND role=NEW.role))
 BEGIN SELECT RAISE(ABORT,'subject binding tombstones must be retained');END;
 CREATE TRIGGER IF NOT EXISTS retain_subject_bindings BEFORE DELETE ON subject_bindings BEGIN SELECT RAISE(ABORT,'subject binding tombstones must be retained');END;
 CREATE TRIGGER IF NOT EXISTS immutable_subject_requests BEFORE UPDATE ON subject_requests BEGIN SELECT RAISE(ABORT,'subject request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_subject_requests BEFORE DELETE ON subject_requests BEGIN SELECT RAISE(ABORT,'subject request responses must be retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_subject_request_replacement BEFORE INSERT ON subject_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'subject request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS reject_subject_cross_request BEFORE INSERT ON subject_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId) OR EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId) OR EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_mutation_cross_subject_request BEFORE INSERT ON mutation_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_asset_range_cross_subject_request BEFORE INSERT ON asset_range_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_asset_disposition_cross_subject_request BEFORE INSERT ON asset_disposition_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 `);
}
