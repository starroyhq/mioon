import type {DatabaseSync} from 'node:sqlite';
import {INSPECTION_VERSION_ASSET_EXPRESSION,INSPECTION_ROW_LIMITS} from './workspace-schema-v24-constants.ts';

// Schema16 is additive. The caller owns BEGIN/COMMIT and the version marker;
// no old table, JSON, receipt, index or trigger is replaced or rewritten.
export function migrateImageSchema(db: DatabaseSync): void{
 if(!db.isTransaction)throw new Error('Image migration requires a transaction');
 db.exec(`
 CREATE TABLE IF NOT EXISTS image_groups(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),
 name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 480),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 headVersionId TEXT,activeTaskId TEXT,createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(id,projectId),FOREIGN KEY(headVersionId,id,projectId) REFERENCES image_versions(id,groupId,projectId) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(activeTaskId,id,projectId) REFERENCES image_tasks(id,groupId,projectId) DEFERRABLE INITIALLY DEFERRED);
 CREATE TABLE IF NOT EXISTS image_tasks(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),groupId TEXT NOT NULL,
 requestId TEXT NOT NULL UNIQUE CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 24576),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND json_type(snapshot)='object' AND length(CAST(snapshot AS BLOB)) BETWEEN 1 AND 24576),
 state TEXT NOT NULL CHECK(state IN ('queued','interrupted_before_dispatch','dispatching','receiving','persisting','succeeded','cancelled_before_dispatch','failed','outcome_unknown','local_result_error')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 dispatched INTEGER NOT NULL CHECK(dispatched IN (0,1)),
 stagedReceipt TEXT CHECK(stagedReceipt IS NULL OR (json_valid(stagedReceipt) AND json_type(stagedReceipt)='object' AND length(CAST(stagedReceipt AS BLOB)) BETWEEN 1 AND 4096)),
 versionId TEXT,errorCode TEXT CHECK(errorCode IS NULL OR (length(errorCode) BETWEEN 1 AND 80 AND errorCode NOT GLOB '*[^A-Z0-9_]*')),
 createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(id,groupId,projectId),FOREIGN KEY(groupId,projectId) REFERENCES image_groups(id,projectId),
 FOREIGN KEY(versionId,id,groupId,projectId) REFERENCES image_versions(id,taskId,groupId,projectId) DEFERRABLE INITIALLY DEFERRED,
 CHECK(json_extract(input,'$.projectId') IS projectId AND json_extract(input,'$.requestId') IS requestId),
 CHECK(json_extract(snapshot,'$.schemaVersion') IS 1 AND json_extract(snapshot,'$.projectId') IS projectId AND json_extract(snapshot,'$.groupId') IS groupId AND json_extract(snapshot,'$.taskId') IS id),
 CHECK((state='succeeded')=(versionId IS NOT NULL)),
 CHECK(state NOT IN ('queued','interrupted_before_dispatch','cancelled_before_dispatch') OR dispatched=0),
 CHECK(state NOT IN ('dispatching','receiving','persisting','succeeded','outcome_unknown','local_result_error') OR dispatched=1),
 CHECK(state NOT IN ('persisting','succeeded','local_result_error') OR stagedReceipt IS NOT NULL));
 CREATE TABLE IF NOT EXISTS image_versions(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),groupId TEXT NOT NULL,taskId TEXT NOT NULL UNIQUE,
 number INTEGER NOT NULL CHECK(typeof(number)='integer' AND number BETWEEN 1 AND 9007199254740991),assetId TEXT NOT NULL UNIQUE REFERENCES assets(id),
 data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4096),
 UNIQUE(groupId,number),UNIQUE(id,groupId,projectId),UNIQUE(id,taskId,groupId,projectId),
 FOREIGN KEY(groupId,projectId) REFERENCES image_groups(id,projectId),FOREIGN KEY(taskId,groupId,projectId) REFERENCES image_tasks(id,groupId,projectId),
 CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.groupId') IS groupId AND json_extract(data,'$.taskId') IS taskId AND json_extract(data,'$.number') IS number AND json_extract(data,'$.assetId') IS assetId));
 CREATE TABLE IF NOT EXISTS image_requests(
 requestId TEXT PRIMARY KEY CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('image.generate','image.task.cancelQueued','image.task.recoverResult')),projectId TEXT NOT NULL REFERENCES projects(id),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 24576),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 32768),
 CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId AND json_extract(response,'$.projectId') IS projectId));
 CREATE INDEX IF NOT EXISTS image_groups_project_page ON image_groups(projectId,createdAt DESC,id DESC);
 CREATE INDEX IF NOT EXISTS image_tasks_project_page ON image_tasks(projectId,createdAt DESC,id DESC);
 CREATE INDEX IF NOT EXISTS image_tasks_group_page ON image_tasks(projectId,groupId,createdAt DESC,id DESC);
 CREATE INDEX IF NOT EXISTS image_tasks_state ON image_tasks(state,projectId,id);
 CREATE UNIQUE INDEX IF NOT EXISTS image_tasks_one_unresolved_group ON image_tasks(groupId) WHERE state IN ('queued','interrupted_before_dispatch','dispatching','receiving','persisting','outcome_unknown','local_result_error');
 CREATE INDEX IF NOT EXISTS image_versions_group_page ON image_versions(projectId,groupId,number DESC);
 CREATE TRIGGER IF NOT EXISTS immutable_image_group_identity BEFORE UPDATE ON image_groups
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.name IS NOT OLD.name OR NEW.createdAt IS NOT OLD.createdAt OR NEW.revision IS NOT OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'image group identity is immutable and revisions must advance');END;
 CREATE TRIGGER IF NOT EXISTS image_group_head_advances BEFORE UPDATE ON image_groups
 WHEN NEW.headVersionId IS NOT OLD.headVersionId AND (NEW.headVersionId IS NULL OR NOT EXISTS(
 SELECT 1 FROM image_versions WHERE id=NEW.headVersionId AND groupId=NEW.id AND projectId=NEW.projectId AND number=COALESCE((SELECT number FROM image_versions WHERE id=OLD.headVersionId),0)+1))
 BEGIN SELECT RAISE(ABORT,'image group head must advance one retained version');END;
 CREATE TRIGGER IF NOT EXISTS retain_image_groups BEFORE DELETE ON image_groups BEGIN SELECT RAISE(ABORT,'image groups must be retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_image_group_replacement BEFORE INSERT ON image_groups WHEN EXISTS(SELECT 1 FROM image_groups WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'image groups cannot be replaced');END;
 CREATE TRIGGER IF NOT EXISTS immutable_image_task_identity BEFORE UPDATE ON image_tasks
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.groupId IS NOT OLD.groupId OR NEW.requestId IS NOT OLD.requestId OR NEW.inputHash IS NOT OLD.inputHash OR NEW.input IS NOT OLD.input OR NEW.snapshot IS NOT OLD.snapshot OR NEW.createdAt IS NOT OLD.createdAt OR (OLD.stagedReceipt IS NOT NULL AND NEW.stagedReceipt IS NOT OLD.stagedReceipt) OR NEW.dispatched<OLD.dispatched
 BEGIN SELECT RAISE(ABORT,'image task identity and durable result are immutable');END;
 CREATE TRIGGER IF NOT EXISTS image_task_state_transitions BEFORE UPDATE ON image_tasks
 WHEN NEW.revision IS NOT OLD.revision+1 OR NOT (
 (OLD.state='queued' AND NEW.state IN ('dispatching','interrupted_before_dispatch','cancelled_before_dispatch','failed')) OR
 (OLD.state='interrupted_before_dispatch' AND NEW.state='cancelled_before_dispatch') OR
 (OLD.state='dispatching' AND NEW.state IN ('receiving','persisting','failed','outcome_unknown','local_result_error')) OR
 (OLD.state='receiving' AND NEW.state IN ('persisting','failed','outcome_unknown','local_result_error')) OR
 (OLD.state='persisting' AND NEW.state IN ('succeeded','outcome_unknown','local_result_error')) OR
 (OLD.state IN ('local_result_error','outcome_unknown') AND NEW.state='persisting'))
 BEGIN SELECT RAISE(ABORT,'invalid image task transition');END;
 CREATE TRIGGER IF NOT EXISTS retain_image_tasks BEFORE DELETE ON image_tasks BEGIN SELECT RAISE(ABORT,'image tasks must be retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_image_task_replacement BEFORE INSERT ON image_tasks WHEN EXISTS(SELECT 1 FROM image_tasks WHERE id=NEW.id OR requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image tasks cannot be replaced');END;
 CREATE TRIGGER IF NOT EXISTS immutable_image_versions BEFORE UPDATE ON image_versions BEGIN SELECT RAISE(ABORT,'image versions are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_image_versions BEFORE DELETE ON image_versions BEGIN SELECT RAISE(ABORT,'image versions must be retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_image_version_replacement BEFORE INSERT ON image_versions
 WHEN EXISTS(SELECT 1 FROM image_versions WHERE id=NEW.id OR taskId=NEW.taskId OR assetId=NEW.assetId OR (groupId=NEW.groupId AND number=NEW.number))
 BEGIN SELECT RAISE(ABORT,'image versions are immutable');END;
 CREATE TRIGGER IF NOT EXISTS image_version_number_advances BEFORE INSERT ON image_versions
 WHEN NEW.number IS NOT COALESCE((SELECT MAX(number) FROM image_versions WHERE groupId=NEW.groupId),0)+1
 BEGIN SELECT RAISE(ABORT,'image version number must advance');END;
 CREATE TRIGGER IF NOT EXISTS reject_image_legacy_asset_owner BEFORE INSERT ON image_versions
 WHEN EXISTS(SELECT 1 FROM versions WHERE ${INSPECTION_VERSION_ASSET_EXPRESSION}=NEW.assetId)
 OR EXISTS(SELECT 1 FROM versions WHERE length(CAST(data AS BLOB))>${INSPECTION_ROW_LIMITS.versions} AND CASE WHEN json_valid(data) THEN json_extract(data,'$.assetId') END=NEW.assetId)
 BEGIN SELECT RAISE(ABORT,'image asset already has an owner');END;
 CREATE TRIGGER IF NOT EXISTS reject_legacy_image_asset_owner BEFORE INSERT ON versions
 WHEN json_valid(NEW.data) AND EXISTS(SELECT 1 FROM image_versions WHERE assetId=json_extract(NEW.data,'$.assetId'))
 BEGIN SELECT RAISE(ABORT,'image asset already has an owner');END;
 CREATE TRIGGER IF NOT EXISTS immutable_image_requests BEFORE UPDATE ON image_requests BEGIN SELECT RAISE(ABORT,'image request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_image_requests BEFORE DELETE ON image_requests BEGIN SELECT RAISE(ABORT,'image request responses must be retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_image_request_replacement BEFORE INSERT ON image_requests WHEN EXISTS(SELECT 1 FROM image_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request responses are immutable');END;
 `);
}
