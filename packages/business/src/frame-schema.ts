import type {DatabaseSync} from 'node:sqlite';
import {FRAME_LIMITS,FRAME_PROFILE_ID,FRAME_SELECTION_RULE} from './workspace-schema-v24-constants.ts';
import {INSPECTION_VERSION_ASSET_EXPRESSION,INSPECTION_ROW_LIMITS} from './workspace-schema-v24-constants.ts';

// Schema20 only adds two retained tables and new indexes/triggers. The caller
// owns the transaction and marker; all pre-existing SQL and row bytes survive.
export function migrateFrameSchema(db: DatabaseSync): void{
 if(!db.isTransaction)throw new Error('Frame migration requires a transaction');
 db.exec(FRAME_SCHEMA_20_SQL);
}
const legacyOwner=(asset: string): string=>`EXISTS(SELECT 1 FROM versions WHERE ${INSPECTION_VERSION_ASSET_EXPRESSION}=${asset})
 OR EXISTS(SELECT 1 FROM versions WHERE length(CAST(data AS BLOB))>${INSPECTION_ROW_LIMITS.versions}
 AND CASE WHEN json_valid(data) THEN json_extract(data,'$.assetId') END=${asset})`;
const receiptAsset=(alias: string): string=>`CASE WHEN json_valid(${alias}.stagedReceipt) THEN json_extract(${alias}.stagedReceipt,'$.assetId') END`;
const taskOwner=(asset: string): string=>`EXISTS(SELECT 1 FROM frame_tasks WHERE assetId=${asset}
 OR CASE WHEN json_valid(stagedReceipt) THEN json_extract(stagedReceipt,'$.assetId') END=${asset})`;
const FRAME_SCHEMA_20_SQL=`
CREATE TABLE IF NOT EXISTS frame_tasks(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 requestId TEXT NOT NULL UNIQUE CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND ${FRAME_LIMITS.inputBytes}),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND json_type(snapshot)='object' AND length(CAST(snapshot AS BLOB)) BETWEEN 1 AND ${FRAME_LIMITS.snapshotBytes}),
 state TEXT NOT NULL CHECK(state IN ('queued','running','persisting','succeeded','cancelled_before_start','interrupted','local_result_error','failed')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 started INTEGER NOT NULL CHECK(started IN (0,1)),
 stagedReceipt TEXT CHECK(stagedReceipt IS NULL OR (json_valid(stagedReceipt) AND json_type(stagedReceipt)='object' AND length(CAST(stagedReceipt AS BLOB)) BETWEEN 1 AND ${FRAME_LIMITS.receiptBytes})),
 assetId TEXT UNIQUE REFERENCES assets(id),
 errorCode TEXT CHECK(errorCode IS NULL OR (length(errorCode) BETWEEN 1 AND 80 AND errorCode GLOB '[A-Z]*' AND errorCode NOT GLOB '*[^A-Z0-9_]*')),
 createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(id,projectId),
 FOREIGN KEY(requestId,id,projectId) REFERENCES frame_requests(requestId,taskId,projectId) DEFERRABLE INITIALLY DEFERRED,
 CHECK(json_extract(input,'$.projectId') IS projectId AND json_extract(input,'$.requestId') IS requestId),
 CHECK(json_type(input,'$.sourceAssetId') IS 'text' AND length(json_extract(input,'$.sourceAssetId'))=36),
 CHECK(json_type(input,'$.sourceHash') IS 'text' AND length(json_extract(input,'$.sourceHash'))=64 AND json_extract(input,'$.sourceHash') NOT GLOB '*[^a-f0-9]*'),
 CHECK(json_type(input,'$.sourceFrame') IS 'integer' AND json_extract(input,'$.sourceFrame') BETWEEN 0 AND 9007199254740991),
 CHECK(json_extract(snapshot,'$.schemaVersion') IS 1 AND json_extract(snapshot,'$.projectId') IS projectId AND json_extract(snapshot,'$.taskId') IS id),
 CHECK(json_extract(snapshot,'$.source.assetId') IS json_extract(input,'$.sourceAssetId') AND json_extract(snapshot,'$.source.sha256') IS json_extract(input,'$.sourceHash')),
 CHECK(json_extract(snapshot,'$.requested.sourceFrame') IS json_extract(input,'$.sourceFrame') AND json_extract(snapshot,'$.requested.fps') IS 30),
 CHECK(json_extract(snapshot,'$.profile.id') IS '${FRAME_PROFILE_ID}' AND json_extract(snapshot,'$.profile.selectionRule') IS '${FRAME_SELECTION_RULE}'),
 CHECK(json_extract(snapshot,'$.profile.maxEdge') IS ${FRAME_LIMITS.resultMaxEdge} AND json_extract(snapshot,'$.profile.mimeType') IS 'image/png' AND json_extract(snapshot,'$.profile.upscale') IS 0),
 CHECK(stagedReceipt IS NULL OR (json_extract(stagedReceipt,'$.schemaVersion') IS 1 AND json_extract(stagedReceipt,'$.projectId') IS projectId
 AND json_extract(stagedReceipt,'$.taskId') IS id AND json_extract(stagedReceipt,'$.inputHash') IS inputHash
 AND json_extract(stagedReceipt,'$.sourceAssetId') IS json_extract(input,'$.sourceAssetId') AND json_extract(stagedReceipt,'$.sourceHash') IS json_extract(input,'$.sourceHash')
 AND json_extract(stagedReceipt,'$.sourceFrame') IS json_extract(input,'$.sourceFrame') AND json_extract(stagedReceipt,'$.fps') IS 30
 AND json_extract(stagedReceipt,'$.profileId') IS '${FRAME_PROFILE_ID}' AND json_extract(stagedReceipt,'$.selectionRule') IS '${FRAME_SELECTION_RULE}'
 AND json_type(stagedReceipt,'$.assetId') IS 'text' AND length(json_extract(stagedReceipt,'$.assetId'))=36
 AND json_extract(stagedReceipt,'$.assetId') IS NOT json_extract(input,'$.sourceAssetId')
 AND json_type(stagedReceipt,'$.sha256') IS 'text' AND length(json_extract(stagedReceipt,'$.sha256'))=64 AND json_extract(stagedReceipt,'$.sha256') NOT GLOB '*[^a-f0-9]*'
 AND json_extract(stagedReceipt,'$.mimeType') IS 'image/png'
 AND json_type(stagedReceipt,'$.width') IS 'integer' AND json_extract(stagedReceipt,'$.width') BETWEEN 1 AND ${FRAME_LIMITS.resultMaxEdge}
 AND json_type(stagedReceipt,'$.height') IS 'integer' AND json_extract(stagedReceipt,'$.height') BETWEEN 1 AND ${FRAME_LIMITS.resultMaxEdge}
 AND json_type(stagedReceipt,'$.byteLength') IS 'integer' AND json_extract(stagedReceipt,'$.byteLength') BETWEEN 1 AND ${FRAME_LIMITS.resultBytes})),
 CHECK((state='succeeded')=(assetId IS NOT NULL)),
 CHECK(assetId IS NULL OR assetId IS json_extract(stagedReceipt,'$.assetId')),
 CHECK(state NOT IN ('queued','cancelled_before_start') OR (started=0 AND stagedReceipt IS NULL)),
 CHECK(state NOT IN ('running','persisting','succeeded','local_result_error') OR started=1),
 CHECK(state NOT IN ('persisting','succeeded','local_result_error') OR stagedReceipt IS NOT NULL),
 CHECK(state!='failed' OR stagedReceipt IS NULL),
 CHECK(state!='queued' OR revision=1),
 CHECK(length(CAST(input AS BLOB))+length(CAST(snapshot AS BLOB))+COALESCE(length(CAST(stagedReceipt AS BLOB)),0)+length(CAST(requestId AS BLOB))+1024<=${FRAME_LIMITS.taskBytes})
);
CREATE TABLE IF NOT EXISTS frame_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('frame.extract','frame.task.cancelQueued','frame.task.recoverResult')),
 projectId TEXT NOT NULL REFERENCES projects(id),taskId TEXT NOT NULL,
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND ${FRAME_LIMITS.inputBytes}),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND ${FRAME_LIMITS.responseBytes}),
 UNIQUE(requestId,taskId,projectId),FOREIGN KEY(taskId,projectId) REFERENCES frame_tasks(id,projectId),
 CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId),
 CHECK(json_extract(response,'$.projectId') IS projectId AND json_extract(response,'$.id') IS taskId),
 CHECK(json_type(response,'$.result') IS 'null'),
 CHECK((operation='frame.extract' AND json_extract(response,'$.requestId') IS requestId AND json_extract(response,'$.state') IS 'queued' AND json_extract(response,'$.revision') IS 1 AND json_extract(response,'$.started') IS 0)
 OR (operation='frame.task.cancelQueued' AND json_extract(response,'$.state') IS 'cancelled_before_start' AND json_extract(response,'$.started') IS 0
 AND json_extract(canonicalInput,'$.taskId') IS taskId AND json_extract(response,'$.revision') IS json_extract(canonicalInput,'$.expectedRevision')+1)
 OR (operation='frame.task.recoverResult' AND json_extract(response,'$.state') IS 'persisting' AND json_extract(response,'$.started') IS 1
 AND json_extract(canonicalInput,'$.taskId') IS taskId AND json_extract(response,'$.revision') IS json_extract(canonicalInput,'$.expectedRevision')+1)),
 CHECK(length(CAST(canonicalInput AS BLOB))+length(CAST(response AS BLOB))+length(CAST(requestId AS BLOB))+1024<=${FRAME_LIMITS.requestBytes})
);
CREATE INDEX IF NOT EXISTS frame_tasks_project_page ON frame_tasks(projectId,createdAt DESC,id DESC);
CREATE INDEX IF NOT EXISTS frame_tasks_state ON frame_tasks(state,projectId,id);
CREATE UNIQUE INDEX IF NOT EXISTS frame_tasks_receipt_asset ON frame_tasks(json_extract(stagedReceipt,'$.assetId')) WHERE stagedReceipt IS NOT NULL;
CREATE INDEX IF NOT EXISTS frame_requests_task ON frame_requests(taskId,requestId);
CREATE INDEX IF NOT EXISTS frame_requests_project ON frame_requests(projectId,requestId);
CREATE TRIGGER IF NOT EXISTS frame_task_insert_identity BEFORE INSERT ON frame_tasks
 WHEN NEW.state IS NOT 'queued' OR NEW.revision IS NOT 1 OR NEW.started IS NOT 0 OR NEW.stagedReceipt IS NOT NULL OR NEW.assetId IS NOT NULL OR NEW.errorCode IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'frame tasks must be accepted before execution');END;
CREATE TRIGGER IF NOT EXISTS immutable_frame_task_identity BEFORE UPDATE ON frame_tasks
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.requestId IS NOT OLD.requestId OR NEW.inputHash IS NOT OLD.inputHash
 OR NEW.input IS NOT OLD.input OR NEW.snapshot IS NOT OLD.snapshot OR NEW.createdAt IS NOT OLD.createdAt
 OR (OLD.stagedReceipt IS NOT NULL AND NEW.stagedReceipt IS NOT OLD.stagedReceipt)
 OR (OLD.assetId IS NOT NULL AND NEW.assetId IS NOT OLD.assetId)
 OR NEW.started<OLD.started OR (NEW.started IS NOT OLD.started AND NOT (OLD.state='queued' AND NEW.state='running' AND OLD.started=0 AND NEW.started=1))
 BEGIN SELECT RAISE(ABORT,'frame identity and durable result are immutable');END;
CREATE TRIGGER IF NOT EXISTS frame_task_state_transitions BEFORE UPDATE ON frame_tasks
 WHEN NEW.revision IS NOT OLD.revision+1 OR NOT (
 (OLD.state='queued' AND NEW.state IN ('running','interrupted','cancelled_before_start','failed')) OR
 (OLD.state='running' AND NEW.state IN ('persisting','interrupted','local_result_error','failed')) OR
 (OLD.state='persisting' AND NEW.state IN ('succeeded','interrupted','local_result_error')) OR
 (OLD.state='interrupted' AND OLD.started=0 AND OLD.stagedReceipt IS NULL AND NEW.state='cancelled_before_start') OR
 (OLD.state IN ('interrupted','local_result_error') AND OLD.started=1 AND NEW.state='persisting'))
 BEGIN SELECT RAISE(ABORT,'invalid frame task transition');END;
CREATE TRIGGER IF NOT EXISTS retain_frame_tasks BEFORE DELETE ON frame_tasks
 BEGIN SELECT RAISE(ABORT,'frame tasks must be retained');END;
CREATE TRIGGER IF NOT EXISTS reject_frame_task_replacement BEFORE INSERT ON frame_tasks
 WHEN EXISTS(SELECT 1 FROM frame_tasks WHERE id=NEW.id OR requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'frame tasks cannot be replaced');END;
CREATE TRIGGER IF NOT EXISTS frame_task_capacity BEFORE INSERT ON frame_tasks
 WHEN (SELECT COUNT(*) FROM frame_tasks)>=${FRAME_LIMITS.tasksGlobal}
 OR (SELECT COUNT(*) FROM frame_tasks WHERE projectId=NEW.projectId)>=${FRAME_LIMITS.tasksPerProject}
 BEGIN SELECT RAISE(ABORT,'frame retained task capacity exceeded');END;
CREATE TRIGGER IF NOT EXISTS frame_task_queue_capacity BEFORE INSERT ON frame_tasks
 WHEN (SELECT COUNT(*) FROM frame_tasks WHERE state='queued')>=${FRAME_LIMITS.queuedGlobal}
 OR (SELECT COUNT(*) FROM frame_tasks WHERE projectId=NEW.projectId AND state='queued')>=${FRAME_LIMITS.queuedPerProject}
 BEGIN SELECT RAISE(ABORT,'frame queued task capacity exceeded');END;
CREATE TRIGGER IF NOT EXISTS frame_task_active_capacity BEFORE UPDATE OF state ON frame_tasks
 WHEN NEW.state IN ('running','persisting') AND OLD.state NOT IN ('running','persisting')
 AND EXISTS(SELECT 1 FROM frame_tasks WHERE state IN ('running','persisting') AND id!=NEW.id)
 BEGIN SELECT RAISE(ABORT,'frame active task capacity exceeded');END;
CREATE TRIGGER IF NOT EXISTS frame_request_identity BEFORE INSERT ON frame_requests
 WHEN NOT EXISTS(SELECT 1 FROM frame_tasks t WHERE t.id=NEW.taskId AND t.projectId=NEW.projectId
 AND json_extract(NEW.response,'$.requestId') IS t.requestId
 AND json_extract(NEW.response,'$.sourceAssetId') IS json_extract(t.input,'$.sourceAssetId')
 AND json_extract(NEW.response,'$.sourceHash') IS json_extract(t.input,'$.sourceHash')
 AND json_extract(NEW.response,'$.sourceFrame') IS json_extract(t.input,'$.sourceFrame')
 AND json_extract(NEW.response,'$.fps') IS 30 AND json_extract(NEW.response,'$.profileId') IS '${FRAME_PROFILE_ID}'
 AND json_extract(NEW.response,'$.state') IS t.state AND json_extract(NEW.response,'$.revision') IS t.revision
 AND json_extract(NEW.response,'$.started') IS t.started
 AND json_extract(NEW.response,'$.errorCode') IS t.errorCode AND json_extract(NEW.response,'$.createdAt') IS t.createdAt AND json_extract(NEW.response,'$.updatedAt') IS t.updatedAt
 AND (NEW.operation!='frame.extract' OR (NEW.requestId=t.requestId AND NEW.inputHash=t.inputHash AND NEW.canonicalInput=t.input)))
 BEGIN SELECT RAISE(ABORT,'frame request must bind its original task acknowledgement');END;
CREATE TRIGGER IF NOT EXISTS immutable_frame_requests BEFORE UPDATE ON frame_requests
 BEGIN SELECT RAISE(ABORT,'frame request responses are immutable');END;
CREATE TRIGGER IF NOT EXISTS retain_frame_requests BEFORE DELETE ON frame_requests
 BEGIN SELECT RAISE(ABORT,'frame request responses must be retained');END;
CREATE TRIGGER IF NOT EXISTS reject_frame_request_replacement BEFORE INSERT ON frame_requests
 WHEN EXISTS(SELECT 1 FROM frame_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'frame request responses cannot be replaced');END;
CREATE TRIGGER IF NOT EXISTS frame_request_capacity BEFORE INSERT ON frame_requests
 WHEN (SELECT COUNT(*) FROM frame_requests WHERE taskId=NEW.taskId)>=${FRAME_LIMITS.requestsPerTask}
 BEGIN SELECT RAISE(ABORT,'frame retained request capacity exceeded');END;
CREATE TRIGGER IF NOT EXISTS frame_asset_project BEFORE UPDATE OF assetId ON frame_tasks
 WHEN NEW.assetId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assets WHERE id=NEW.assetId AND projectId=NEW.projectId)
 BEGIN SELECT RAISE(ABORT,'frame result must belong to its task project');END;
CREATE TRIGGER IF NOT EXISTS reject_frame_mixed_asset_owner BEFORE UPDATE OF stagedReceipt,assetId ON frame_tasks
 WHEN NEW.stagedReceipt IS NOT NULL AND (${legacyOwner(receiptAsset('NEW'))}
 OR EXISTS(SELECT 1 FROM image_versions WHERE assetId=${receiptAsset('NEW')}))
 BEGIN SELECT RAISE(ABORT,'frame asset already has an owner');END;
CREATE TRIGGER IF NOT EXISTS reject_legacy_frame_asset_owner BEFORE INSERT ON versions
 WHEN CASE WHEN json_valid(NEW.data) THEN ${taskOwner("json_extract(NEW.data,'$.assetId')")} ELSE 0 END
 BEGIN SELECT RAISE(ABORT,'frame asset already has an owner');END;
CREATE TRIGGER IF NOT EXISTS reject_image_frame_asset_owner BEFORE INSERT ON image_versions
 WHEN ${taskOwner('NEW.assetId')}
 BEGIN SELECT RAISE(ABORT,'frame asset already has an owner');END;
`;
