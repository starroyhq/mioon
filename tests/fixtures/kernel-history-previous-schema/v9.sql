-- Frozen canonical history 9 from merged main 91611b9aa2d266eb1d0ccc290fe62f57dd62a270.

CREATE TABLE schema_version(version INTEGER PRIMARY KEY);

CREATE TABLE history_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),seenContentSequence INTEGER NOT NULL CHECK(typeof(seenContentSequence)='integer' AND seenContentSequence BETWEEN 0 AND 9007199254740991),seenContentToken TEXT CHECK(seenContentToken IS NULL OR (typeof(seenContentToken)='text' AND length(seenContentToken)=32 AND seenContentToken NOT GLOB '*[^a-f0-9]*')));

CREATE TRIGGER history_state_guard_insert BEFORE INSERT ON history_state WHEN EXISTS(SELECT 1 FROM history_state) BEGIN SELECT RAISE(ABORT,'HISTORY_STATE_EXISTS');END;

CREATE TRIGGER history_state_guard_delete BEFORE DELETE ON history_state BEGIN SELECT RAISE(ABORT,'HISTORY_STATE_REQUIRED');END;

CREATE TRIGGER history_state_guard_identity BEFORE UPDATE OF singleton,projectId ON history_state WHEN NEW.singleton IS NOT OLD.singleton OR NEW.projectId IS NOT OLD.projectId BEGIN SELECT RAISE(ABORT,'HISTORY_STATE_IDENTITY_IMMUTABLE');END;

CREATE TABLE project_history_resolution(singleton INTEGER PRIMARY KEY CHECK(singleton=1),requestId TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)));

CREATE TABLE idempotency(scope TEXT NOT NULL,requestId TEXT NOT NULL,requestHash TEXT NOT NULL,resourceId TEXT NOT NULL,PRIMARY KEY(scope,requestId));

CREATE TABLE mutation_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation IN ('shot.create','shot.update','shot.reorder','node.create','node.update','version.select')),
 projectId TEXT NOT NULL,
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput)),
 response TEXT NOT NULL CHECK(json_valid(response)));

CREATE TRIGGER reject_mutation_request_replacement BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request responses are immutable');END;

CREATE TRIGGER immutable_mutation_requests BEFORE UPDATE ON mutation_requests
 BEGIN SELECT RAISE(ABORT,'mutation request responses are immutable');END;

CREATE TRIGGER reject_mutation_cross_range_request BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_mutation_cross_disposition_request BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_mutation_cross_subject_request BEFORE INSERT ON mutation_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_mutation_requests_cross_annotation BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM asset_annotation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER retain_mutation_requests BEFORE DELETE ON mutation_requests BEGIN SELECT RAISE(ABORT,'mutation request responses must be retained');END;

CREATE TABLE project_mutation_requests(requestId TEXT PRIMARY KEY,projectId TEXT NOT NULL,digest TEXT NOT NULL CHECK(length(digest)=64),response TEXT NOT NULL CHECK(json_valid(response)));

CREATE TRIGGER immutable_project_mutation_requests BEFORE UPDATE ON project_mutation_requests BEGIN SELECT RAISE(ABORT,'project responses are immutable');END;

CREATE TRIGGER retain_project_mutation_requests BEFORE DELETE ON project_mutation_requests BEGIN SELECT RAISE(ABORT,'project responses must be retained');END;

CREATE TABLE asset_annotation_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(typeof(requestId)='text' AND length(CAST(requestId AS BLOB)) BETWEEN 8 AND 800),
 operation TEXT NOT NULL CHECK(operation='asset.annotation.set'),
 projectId TEXT NOT NULL,
 canonicalInput TEXT NOT NULL CHECK(typeof(canonicalInput)='text' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 24576 AND json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND json_extract(canonicalInput,'$.projectId') IS projectId),
 response TEXT NOT NULL CHECK(typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 24576 AND json_valid(response) AND json_type(response)='object' AND json_extract(response,'$.projectId') IS projectId));

CREATE TRIGGER reject_asset_annotation_request_replacement BEFORE INSERT ON asset_annotation_requests
 WHEN EXISTS(SELECT 1 FROM asset_annotation_requests WHERE requestId=NEW.requestId OR rowid=NEW.rowid)
 BEGIN SELECT RAISE(ABORT,'asset annotation request responses are immutable');END;

CREATE TRIGGER immutable_asset_annotation_requests BEFORE UPDATE ON asset_annotation_requests
 BEGIN SELECT RAISE(ABORT,'asset annotation request responses are immutable');END;

CREATE TRIGGER reject_annotation_cross_mutation_requests BEFORE INSERT ON asset_annotation_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_annotation_cross_asset_range_requests BEFORE INSERT ON asset_annotation_requests
 WHEN EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_annotation_cross_asset_disposition_requests BEFORE INSERT ON asset_annotation_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_annotation_cross_subject_requests BEFORE INSERT ON asset_annotation_requests
 WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER retain_asset_annotation_requests BEFORE DELETE ON asset_annotation_requests BEGIN SELECT RAISE(ABORT,'asset annotation request responses must be retained');END;

CREATE TABLE asset_disposition_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation='asset.disposition.set'),
 projectId TEXT NOT NULL,
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND length(CAST(canonicalInput AS BLOB))<=4096),
 response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB))<=4096));

CREATE TRIGGER reject_asset_disposition_request_replacement BEFORE INSERT ON asset_disposition_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'asset disposition request responses are immutable');END;

CREATE TRIGGER immutable_asset_disposition_requests BEFORE UPDATE ON asset_disposition_requests
 BEGIN SELECT RAISE(ABORT,'asset disposition request responses are immutable');END;

CREATE TRIGGER reject_asset_disposition_cross_request BEFORE INSERT ON asset_disposition_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId) OR
 EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_asset_disposition_cross_subject_request BEFORE INSERT ON asset_disposition_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_asset_disposition_requests_cross_annotation BEFORE INSERT ON asset_disposition_requests
 WHEN EXISTS(SELECT 1 FROM asset_annotation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER retain_asset_disposition_requests BEFORE DELETE ON asset_disposition_requests BEGIN SELECT RAISE(ABORT,'asset disposition request responses must be retained');END;

CREATE TABLE asset_range_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation='asset.range.set'),
 projectId TEXT NOT NULL,
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput)),
 response TEXT NOT NULL CHECK(json_valid(response)));

CREATE TRIGGER reject_asset_range_request_replacement BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'source range request responses are immutable');END;

CREATE TRIGGER immutable_asset_range_requests BEFORE UPDATE ON asset_range_requests
 BEGIN SELECT RAISE(ABORT,'source range request responses are immutable');END;

CREATE TRIGGER reject_asset_range_cross_request BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_asset_range_cross_disposition_request BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_asset_range_cross_subject_request BEFORE INSERT ON asset_range_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_asset_range_requests_cross_annotation BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM asset_annotation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER retain_asset_range_requests BEFORE DELETE ON asset_range_requests BEGIN SELECT RAISE(ABORT,'source range request responses must be retained');END;

CREATE TABLE timeline_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);

CREATE INDEX timeline_requests_project ON timeline_requests(CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 4194304
 THEN CASE WHEN json_valid(response) THEN CASE WHEN json_type(response,'$.projectId')='text' AND length(CAST(json_extract(response,'$.projectId') AS BLOB))=36
 THEN json_extract(response,'$.projectId') END END END,requestId);

CREATE TRIGGER immutable_timeline_responses BEFORE UPDATE ON timeline_requests BEGIN SELECT RAISE(ABORT,'timeline request responses are immutable');END;

CREATE TABLE timeline_format_requests(
 requestId TEXT NOT NULL PRIMARY KEY REFERENCES timeline_requests(requestId) CHECK(length(requestId) BETWEEN 8 AND 200),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),
 input TEXT NOT NULL CHECK(typeof(input)='text' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 2048 AND json_valid(input) AND json_type(input)='object'),
 CHECK(json_extract(input,'$.projectId') IS projectId AND json_extract(input,'$.requestId') IS requestId));

CREATE INDEX timeline_format_requests_project ON timeline_format_requests(projectId,requestId);

CREATE TRIGGER immutable_timeline_format_requests BEFORE UPDATE ON timeline_format_requests
 BEGIN SELECT RAISE(ABORT,'timeline format requests are immutable');END;

CREATE TRIGGER reject_timeline_format_replacement BEFORE INSERT ON timeline_format_requests
 WHEN EXISTS(SELECT 1 FROM timeline_format_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'timeline format request identities are immutable');END;

CREATE TRIGGER retain_timeline_format_requests BEFORE DELETE ON timeline_format_requests BEGIN SELECT RAISE(ABORT,'timeline format requests must be retained');END;

CREATE TABLE reference_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);

CREATE TRIGGER immutable_reference_responses BEFORE UPDATE ON reference_requests
 BEGIN SELECT RAISE(ABORT,'reference request responses are immutable');END;

CREATE TRIGGER reject_reference_request_replacement BEFORE INSERT ON reference_requests
 WHEN EXISTS(SELECT 1 FROM reference_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'reference request responses are immutable');END;

CREATE TRIGGER retain_reference_requests BEFORE DELETE ON reference_requests BEGIN SELECT RAISE(ABORT,'reference request responses must be retained');END;

CREATE TABLE image_requests(
 requestId TEXT PRIMARY KEY CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('image.generate','image.task.cancelQueued','image.task.recoverResult')),projectId TEXT NOT NULL,
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 24576),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 32768),
 CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId AND json_extract(response,'$.projectId') IS projectId));

CREATE TRIGGER immutable_image_requests BEFORE UPDATE ON image_requests BEGIN SELECT RAISE(ABORT,'image request responses are immutable');END;

CREATE TRIGGER reject_image_request_replacement BEFORE INSERT ON image_requests WHEN EXISTS(SELECT 1 FROM image_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request responses are immutable');END;

CREATE TRIGGER reject_image_request_cross_observation BEFORE INSERT ON image_requests
 WHEN EXISTS(SELECT 1 FROM image_remote_observations WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request identity is already retained');END;

CREATE TRIGGER retain_image_requests BEFORE DELETE ON image_requests BEGIN SELECT RAISE(ABORT,'image request responses must be retained');END;

CREATE TABLE frame_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('frame.extract','frame.task.cancelQueued','frame.task.recoverResult')),
 projectId TEXT NOT NULL,taskId TEXT NOT NULL,
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 4096),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 4096),
 UNIQUE(requestId,taskId,projectId),FOREIGN KEY(taskId,projectId) REFERENCES frame_tasks(id,projectId),
 CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId),
 CHECK(json_extract(response,'$.projectId') IS projectId AND json_extract(response,'$.id') IS taskId),
 CHECK(json_type(response,'$.result') IS 'null'),
 CHECK((operation='frame.extract' AND json_extract(response,'$.requestId') IS requestId AND json_extract(response,'$.state') IS 'queued' AND json_extract(response,'$.revision') IS 1 AND json_extract(response,'$.started') IS 0)
 OR (operation='frame.task.cancelQueued' AND json_extract(response,'$.state') IS 'cancelled_before_start' AND json_extract(response,'$.started') IS 0
 AND json_extract(canonicalInput,'$.taskId') IS taskId AND json_extract(response,'$.revision') IS json_extract(canonicalInput,'$.expectedRevision')+1)
 OR (operation='frame.task.recoverResult' AND json_extract(response,'$.state') IS 'persisting' AND json_extract(response,'$.started') IS 1
 AND json_extract(canonicalInput,'$.taskId') IS taskId AND json_extract(response,'$.revision') IS json_extract(canonicalInput,'$.expectedRevision')+1)),
 CHECK(length(CAST(canonicalInput AS BLOB))+length(CAST(response AS BLOB))+length(CAST(requestId AS BLOB))+1024<=12288)
);

CREATE INDEX frame_requests_task ON frame_requests(taskId,requestId);

CREATE INDEX frame_requests_project ON frame_requests(projectId,requestId);

CREATE TRIGGER frame_request_identity BEFORE INSERT ON frame_requests
 WHEN NOT EXISTS(SELECT 1 FROM frame_tasks t WHERE t.id=NEW.taskId AND t.projectId=NEW.projectId
 AND json_extract(NEW.response,'$.requestId') IS t.requestId
 AND json_extract(NEW.response,'$.sourceAssetId') IS json_extract(t.input,'$.sourceAssetId')
 AND json_extract(NEW.response,'$.sourceHash') IS json_extract(t.input,'$.sourceHash')
 AND json_extract(NEW.response,'$.sourceFrame') IS json_extract(t.input,'$.sourceFrame')
 AND json_extract(NEW.response,'$.fps') IS 30 AND json_extract(NEW.response,'$.profileId') IS 'local-png-1024-v1'
 AND json_extract(NEW.response,'$.state') IS t.state AND json_extract(NEW.response,'$.revision') IS t.revision
 AND json_extract(NEW.response,'$.started') IS t.started
 AND json_extract(NEW.response,'$.errorCode') IS t.errorCode AND json_extract(NEW.response,'$.createdAt') IS t.createdAt AND json_extract(NEW.response,'$.updatedAt') IS t.updatedAt
 AND (NEW.operation!='frame.extract' OR (NEW.requestId=t.requestId AND NEW.inputHash=t.inputHash AND NEW.canonicalInput=t.input)))
 BEGIN SELECT RAISE(ABORT,'frame request must bind its original task acknowledgement');END;

CREATE TRIGGER immutable_frame_requests BEFORE UPDATE ON frame_requests
 BEGIN SELECT RAISE(ABORT,'frame request responses are immutable');END;

CREATE TRIGGER reject_frame_request_replacement BEFORE INSERT ON frame_requests
 WHEN EXISTS(SELECT 1 FROM frame_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'frame request responses cannot be replaced');END;

CREATE TRIGGER frame_request_capacity BEFORE INSERT ON frame_requests
 WHEN (SELECT COUNT(*) FROM frame_requests WHERE taskId=NEW.taskId)>=16
 BEGIN SELECT RAISE(ABORT,'frame retained request capacity exceeded');END;

CREATE TRIGGER retain_frame_requests BEFORE DELETE ON frame_requests BEGIN SELECT RAISE(ABORT,'frame request responses must be retained');END;

CREATE TABLE scene_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('scene.detect','scene.task.cancel','scene.cuts.save','scene.shots.create','scene.shots.undo')),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),
 taskId TEXT CHECK(taskId IS NULL OR length(CAST(taskId AS BLOB))=36),
 resultId TEXT CHECK(resultId IS NULL OR length(CAST(resultId AS BLOB))=36),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 16384),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 16384),
 UNIQUE(requestId,taskId,projectId),
 FOREIGN KEY(taskId,projectId) REFERENCES scene_tasks(id,projectId),
 CHECK((operation='scene.cuts.save')=(resultId IS NOT NULL)),
 CHECK((operation='scene.cuts.save')=(taskId IS NULL)),
 CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId),
 CHECK(json_extract(response,'$.projectId') IS projectId AND json_extract(response,'$.id') IS COALESCE(taskId,resultId)),
 CHECK(operation!='scene.detect' OR (json_extract(response,'$.requestId') IS requestId AND json_extract(response,'$.state') IS 'queued'
 AND json_extract(response,'$.revision') IS 1 AND json_extract(response,'$.started') IS 0)),
 CHECK(operation!='scene.task.cancel' OR (json_extract(canonicalInput,'$.taskId') IS taskId
 AND json_extract(response,'$.revision') IS json_extract(canonicalInput,'$.expectedRevision')+1
 AND (json_extract(response,'$.state') IS 'cancelled_before_start' OR json_extract(response,'$.state') IS 'cancelling'))),
 CHECK(operation!='scene.cuts.save' OR (json_extract(response,'$.requestId') IS requestId AND json_extract(response,'$.origin') IS 'manual'
 AND json_extract(response,'$.basedOnResultId') IS json_extract(canonicalInput,'$.expectedResultId'))),
 CHECK(length(CAST(canonicalInput AS BLOB))+length(CAST(response AS BLOB))+length(CAST(requestId AS BLOB))+1024<=49152)
);

CREATE INDEX scene_requests_task ON scene_requests(taskId,requestId);

CREATE INDEX scene_requests_project ON scene_requests(projectId,requestId);

CREATE TRIGGER immutable_scene_requests BEFORE UPDATE ON scene_requests
 BEGIN SELECT RAISE(ABORT,'scene request responses are immutable');END;

CREATE TRIGGER retain_scene_requests BEFORE DELETE ON scene_requests
 BEGIN SELECT RAISE(ABORT,'scene request responses must be retained');END;

CREATE TRIGGER reject_scene_request_replacement BEFORE INSERT ON scene_requests
 WHEN EXISTS(SELECT 1 FROM scene_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'scene request responses cannot be replaced');END;

CREATE TRIGGER scene_request_capacity BEFORE INSERT ON scene_requests
 WHEN (NEW.taskId IS NOT NULL AND (SELECT COUNT(*) FROM scene_requests WHERE taskId=NEW.taskId)>=16)
 OR (SELECT COUNT(*) FROM scene_requests WHERE projectId=NEW.projectId)>=4096 OR (SELECT COUNT(*) FROM scene_requests)>=32768
 BEGIN SELECT RAISE(ABORT,'scene retained request capacity exceeded');END;

CREATE TABLE subject_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation IN ('subject.create','subject.version.add','subject.binding.set')),
 projectId TEXT NOT NULL,
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 8192 AND json_type(canonicalInput)='object' AND json_extract(canonicalInput,'$.projectId') IS projectId),
 response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB)) BETWEEN 1 AND 16384 AND json_type(response)='object' AND json_extract(response,'$.projectId') IS projectId));

CREATE TRIGGER immutable_subject_requests BEFORE UPDATE ON subject_requests BEGIN SELECT RAISE(ABORT,'subject request responses are immutable');END;

CREATE TRIGGER reject_subject_request_replacement BEFORE INSERT ON subject_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'subject request responses are immutable');END;

CREATE TRIGGER reject_subject_cross_request BEFORE INSERT ON subject_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId) OR EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId) OR EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER reject_subject_requests_cross_annotation BEFORE INSERT ON subject_requests
 WHEN EXISTS(SELECT 1 FROM asset_annotation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;

CREATE TRIGGER retain_subject_requests BEFORE DELETE ON subject_requests BEGIN SELECT RAISE(ABORT,'subject request responses must be retained');END;

CREATE TABLE subject_variant_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('subject.variants.create','subject.variants.retry','subject.variants.undo')),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),
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

CREATE INDEX subject_variant_requests_batch ON subject_variant_requests(batchId,requestId);

CREATE TRIGGER subject_variant_request_identity BEFORE INSERT ON subject_variant_requests
 WHEN NOT EXISTS(SELECT 1 FROM subject_variant_batches b WHERE b.id=NEW.batchId AND b.projectId=NEW.projectId
 AND json_extract(NEW.response,'$.subjectId') IS b.subjectId AND json_extract(NEW.response,'$.kind') IS b.kind AND json_extract(NEW.response,'$.revision') IS b.revision
 AND json_extract(NEW.response,'$.state') IS b.state AND json_extract(NEW.response,'$.createdAt') IS b.createdAt AND json_extract(NEW.response,'$.updatedAt') IS b.updatedAt
 AND (NEW.operation!='subject.variants.create' OR (NEW.requestId=b.requestId AND NEW.inputHash=b.inputHash AND NEW.canonicalInput=b.input)))
 BEGIN SELECT RAISE(ABORT,'subject variant request must bind its original acknowledgement');END;

CREATE TRIGGER immutable_subject_variant_requests BEFORE UPDATE ON subject_variant_requests
 BEGIN SELECT RAISE(ABORT,'subject variant request responses are immutable');END;

CREATE TRIGGER retain_subject_variant_requests BEFORE DELETE ON subject_variant_requests
 BEGIN SELECT RAISE(ABORT,'subject variant request responses must be retained');END;

CREATE TRIGGER reject_subject_variant_request_replacement BEFORE INSERT ON subject_variant_requests
 WHEN EXISTS(SELECT 1 FROM subject_variant_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'subject variant request responses cannot be replaced');END;

CREATE TRIGGER subject_variant_request_capacity BEFORE INSERT ON subject_variant_requests
 WHEN (SELECT COUNT(*) FROM subject_variant_requests WHERE batchId=NEW.batchId)>=128
 OR (SELECT COUNT(*) FROM subject_variant_requests WHERE projectId=NEW.projectId)>=4096 OR (SELECT COUNT(*) FROM subject_variant_requests)>=32768
 BEGIN SELECT RAISE(ABORT,'subject variant request capacity exceeded');END;

CREATE TABLE previs_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('previs.create','previs.scene.set')),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),
 nodeId TEXT NOT NULL CHECK(length(CAST(nodeId AS BLOB))=36),
 sceneRevision INTEGER NOT NULL CHECK(typeof(sceneRevision)='integer' AND sceneRevision BETWEEN 1 AND 9007199254740991),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 24576),
 UNIQUE(nodeId,operation,sceneRevision),
 CHECK(json_extract(response,'$.id') IS nodeId AND json_extract(response,'$.projectId') IS projectId AND json_extract(response,'$.type') IS 'previs'
 AND json_extract(response,'$.sceneRevision') IS sceneRevision AND json_type(response,'$.scene') IS 'object'),
 CHECK(operation!='previs.create' OR (sceneRevision=1 AND json_extract(response,'$.revision') IS 1))
);

CREATE INDEX previs_requests_project ON previs_requests(projectId,operation);

CREATE TRIGGER immutable_previs_requests BEFORE UPDATE ON previs_requests
 BEGIN SELECT RAISE(ABORT,'previs request responses are immutable');END;

CREATE TRIGGER retain_previs_requests BEFORE DELETE ON previs_requests
 WHEN NOT (OLD.operation='previs.scene.set' AND (SELECT count(*) FROM previs_requests r
 WHERE r.nodeId=OLD.nodeId AND r.operation='previs.scene.set' AND r.sceneRevision>OLD.sceneRevision)>=3)
 BEGIN SELECT RAISE(ABORT,'previs request responses must be retained');END;

CREATE TRIGGER reject_previs_request_replacement BEFORE INSERT ON previs_requests
 WHEN EXISTS(SELECT 1 FROM previs_requests WHERE requestId=NEW.requestId OR (nodeId=NEW.nodeId AND operation=NEW.operation AND sceneRevision=NEW.sceneRevision))
 BEGIN SELECT RAISE(ABORT,'previs request responses cannot be replaced');END;

CREATE TRIGGER previs_request_capacity BEFORE INSERT ON previs_requests
 WHEN (SELECT count(*) FROM previs_requests WHERE nodeId=NEW.nodeId)>=5 OR (SELECT count(*) FROM previs_requests)>=8192
 OR (NEW.operation='previs.create' AND ((SELECT count(*) FROM previs_requests WHERE projectId=NEW.projectId AND operation='previs.create')>=256
 OR (SELECT count(*) FROM previs_requests WHERE operation='previs.create')>=1024))
 BEGIN SELECT RAISE(ABORT,'previs request capacity exceeded');END;

CREATE TABLE lut_import_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(typeof(requestId)='text' AND length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 projectId TEXT NOT NULL CHECK(typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36),
 inputHash TEXT NOT NULL CHECK(typeof(inputHash)='text' AND length(CAST(inputHash AS BLOB))=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 resourceId TEXT NOT NULL UNIQUE CHECK(typeof(resourceId)='text' AND length(CAST(resourceId AS BLOB))=36));

CREATE TRIGGER immutable_lut_import_requests BEFORE UPDATE ON lut_import_requests
 BEGIN SELECT RAISE(ABORT,'LUT_IMPORT_RECEIPT_IMMUTABLE');END;

CREATE TRIGGER reject_lut_import_request_replacement BEFORE INSERT ON lut_import_requests
 WHEN EXISTS(SELECT 1 FROM lut_import_requests WHERE requestId=NEW.requestId OR resourceId=NEW.resourceId OR rowid=NEW.rowid)
 BEGIN SELECT RAISE(ABORT,'LUT_IMPORT_RECEIPT_IMMUTABLE');END;

CREATE TRIGGER bound_lut_import_requests BEFORE INSERT ON lut_import_requests
 WHEN (SELECT count(*) FROM lut_import_requests)>=4096
 BEGIN SELECT RAISE(ABORT,'LUT_IMPORT_RECEIPT_LIMIT');END;

CREATE TRIGGER retain_lut_import_requests BEFORE DELETE ON lut_import_requests BEGIN SELECT RAISE(ABORT,'LUT_IMPORT_RECEIPT_IMMUTABLE');END;

CREATE TABLE task_disposition_requests(
    requestId TEXT PRIMARY KEY CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
    projectId TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN ('task.disposition.markFailed','task.disposition.archiveCompleted')),
    digest TEXT NOT NULL CHECK(length(CAST(digest AS BLOB))=64),response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB))<=131072));

CREATE TRIGGER retain_task_disposition_request_replacement BEFORE INSERT ON task_disposition_requests
    WHEN EXISTS(SELECT 1 FROM task_disposition_requests WHERE rowid=NEW.rowid OR requestId=NEW.requestId)
    BEGIN SELECT RAISE(ABORT,'task disposition responses must not be replaced');END;

CREATE TRIGGER immutable_task_disposition_requests BEFORE UPDATE ON task_disposition_requests
    BEGIN SELECT RAISE(ABORT,'task disposition responses are immutable');END;

CREATE TRIGGER retain_task_disposition_requests BEFORE DELETE ON task_disposition_requests
    BEGIN SELECT RAISE(ABORT,'task disposition responses must be retained');END;

CREATE TABLE jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL);

CREATE INDEX inspection_jobs_project_id ON jobs(projectId,id);

CREATE TABLE job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,jobId TEXT NOT NULL,event TEXT NOT NULL,createdAt TEXT NOT NULL);

CREATE TABLE exports(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL);

CREATE INDEX inspection_exports_project_id ON exports(projectId,id);

CREATE TRIGGER immutable_timeline_render_snapshot BEFORE UPDATE ON exports
 WHEN json_extract(OLD.data,'$.mode')='timeline' AND (
 json_extract(NEW.data,'$.mode') IS NOT 'timeline' OR
 json_extract(NEW.data,'$.snapshot') IS NOT json_extract(OLD.data,'$.snapshot') OR
 json_extract(NEW.data,'$.timelineRevision') IS NOT json_extract(OLD.data,'$.timelineRevision') OR
 json_extract(NEW.data,'$.purpose') IS NOT json_extract(OLD.data,'$.purpose'))
 BEGIN SELECT RAISE(ABORT,'timeline render snapshots are immutable');END;

CREATE TABLE "edit_tasks"(
 position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),
 operation TEXT NOT NULL CHECK(operation IN ('timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.rippleRemove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','timeline.format.set','subject.create','subject.version.add','subject.binding.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove','timeline.loudness.apply')),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 8192),
 requestId TEXT NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 digest TEXT NOT NULL CHECK(length(CAST(digest AS BLOB))=64),
 lane TEXT NOT NULL CHECK(lane IN ('timeline:mutation','reference:mutation','subject:mutation')),
 origin TEXT NOT NULL CHECK(origin IN ('new','legacy_session')),
 status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','unknown','applied','not_applied')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)),
 claim TEXT CHECK(claim IS NULL OR length(CAST(claim AS BLOB))=36),
 claimInstance TEXT CHECK(claimInstance IS NULL OR length(CAST(claimInstance AS BLOB))=36),
 receiptDigest TEXT CHECK(receiptDigest IS NULL OR length(CAST(receiptDigest AS BLOB))=64),
 errorCode TEXT CHECK(errorCode IS NULL OR length(CAST(errorCode AS BLOB)) BETWEEN 1 AND 80),
 createdAt TEXT NOT NULL CHECK(length(CAST(createdAt AS BLOB)) BETWEEN 1 AND 40),
 updatedAt TEXT NOT NULL CHECK(length(CAST(updatedAt AS BLOB)) BETWEEN 1 AND 40),
 bytes INTEGER NOT NULL CHECK(bytes=16384),UNIQUE(lane,requestId),
 CHECK(json_extract(input,'$.projectId')=projectId AND json_extract(input,'$.requestId')=requestId),
 CHECK((operation LIKE 'timeline.%' AND lane='timeline:mutation') OR (operation LIKE 'reference.%' AND lane='reference:mutation') OR (operation IN ('subject.create','subject.version.add','subject.binding.set') AND lane='subject:mutation')),
 CHECK((status='applied')=(receiptDigest IS NOT NULL)),CHECK((status='not_applied')=(errorCode IS NOT NULL)),
 CHECK((claim IS NULL)=(claimInstance IS NULL)),CHECK(status!='dispatching' OR claim IS NOT NULL),
 CHECK(status!='prepared' OR (origin='new' AND claim IS NULL)),CHECK(acknowledged=0 OR status IN ('applied','not_applied')));

CREATE UNIQUE INDEX edit_task_one_pending_lane ON edit_tasks(projectId,lane) WHERE acknowledged=0;

CREATE INDEX edit_tasks_project_page ON edit_tasks(projectId,position DESC);

CREATE INDEX edit_tasks_project_pending_page ON edit_tasks(projectId,acknowledged,position DESC);

CREATE TRIGGER edit_task_state_transitions BEFORE UPDATE ON edit_tasks
 WHEN NEW.revision!=OLD.revision+1 OR OLD.revision>=9007199254740991 OR
 NOT ((OLD.status='prepared' AND NEW.status IN ('dispatching','applied')) OR
      (OLD.status='unknown' AND NEW.status IN ('dispatching','applied')) OR
      (OLD.status='dispatching' AND NEW.status IN ('unknown','applied','not_applied')) OR
      (OLD.status IN ('applied','not_applied') AND NEW.status=OLD.status AND OLD.acknowledged=0 AND NEW.acknowledged=1)) OR
 (OLD.status NOT IN ('applied','not_applied') AND NEW.acknowledged!=0) OR
 (OLD.status IN ('applied','not_applied') AND (NEW.receiptDigest IS NOT OLD.receiptDigest OR NEW.errorCode IS NOT OLD.errorCode)) OR
 (NEW.status!='dispatching' AND (NEW.claim IS NOT OLD.claim OR NEW.claimInstance IS NOT OLD.claimInstance)) OR
 (NEW.status='dispatching' AND (NEW.claim IS NULL OR NEW.claim IS OLD.claim))
 BEGIN SELECT RAISE(ABORT,'invalid edit task transition');END;

CREATE TRIGGER immutable_edit_task_identity BEFORE UPDATE ON edit_tasks
 WHEN NEW.position IS NOT OLD.position OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR
 NEW.operation IS NOT OLD.operation OR NEW.input IS NOT OLD.input OR NEW.requestId IS NOT OLD.requestId OR
 NEW.digest IS NOT OLD.digest OR NEW.lane IS NOT OLD.lane OR NEW.origin IS NOT OLD.origin OR
 NEW.createdAt IS NOT OLD.createdAt OR NEW.bytes IS NOT OLD.bytes
 BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END;

CREATE TRIGGER reject_edit_task_replacement BEFORE INSERT ON edit_tasks
 WHEN EXISTS(SELECT 1 FROM edit_tasks WHERE id=NEW.id OR position=NEW.position OR (lane=NEW.lane AND requestId=NEW.requestId))
 BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END;

CREATE TRIGGER retain_edit_tasks BEFORE DELETE ON edit_tasks BEGIN SELECT RAISE(ABORT,'edit task identities must be retained');END;

CREATE TABLE image_tasks(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL,groupId TEXT NOT NULL,
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
 UNIQUE(id,groupId,projectId),
 CHECK(json_extract(input,'$.projectId') IS projectId AND json_extract(input,'$.requestId') IS requestId),
 CHECK(json_extract(snapshot,'$.schemaVersion') IS 1 AND json_extract(snapshot,'$.projectId') IS projectId AND json_extract(snapshot,'$.groupId') IS groupId AND json_extract(snapshot,'$.taskId') IS id),
 CHECK((state='succeeded')=(versionId IS NOT NULL)),
 CHECK(state NOT IN ('queued','interrupted_before_dispatch','cancelled_before_dispatch') OR dispatched=0),
 CHECK(state NOT IN ('dispatching','receiving','persisting','succeeded','outcome_unknown','local_result_error') OR dispatched=1),
 CHECK(state NOT IN ('persisting','succeeded','local_result_error') OR stagedReceipt IS NOT NULL));

CREATE INDEX image_tasks_project_page ON image_tasks(projectId,createdAt DESC,id DESC);

CREATE INDEX image_tasks_group_page ON image_tasks(projectId,groupId,createdAt DESC,id DESC);

CREATE INDEX image_tasks_state ON image_tasks(state,projectId,id);

CREATE UNIQUE INDEX image_tasks_one_unresolved_group ON image_tasks(groupId) WHERE state IN ('queued','interrupted_before_dispatch','dispatching','receiving','persisting','outcome_unknown','local_result_error');

CREATE TRIGGER immutable_image_task_identity BEFORE UPDATE ON image_tasks
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.groupId IS NOT OLD.groupId OR NEW.requestId IS NOT OLD.requestId OR NEW.inputHash IS NOT OLD.inputHash OR NEW.input IS NOT OLD.input OR NEW.snapshot IS NOT OLD.snapshot OR NEW.createdAt IS NOT OLD.createdAt OR (OLD.stagedReceipt IS NOT NULL AND NEW.stagedReceipt IS NOT OLD.stagedReceipt) OR NEW.dispatched<OLD.dispatched
 BEGIN SELECT RAISE(ABORT,'image task identity and durable result are immutable');END;

CREATE TRIGGER reject_image_task_replacement BEFORE INSERT ON image_tasks WHEN EXISTS(SELECT 1 FROM image_tasks WHERE id=NEW.id OR requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image tasks cannot be replaced');END;

CREATE TRIGGER image_task_state_transitions BEFORE UPDATE ON image_tasks
 WHEN NEW.revision IS NOT OLD.revision+1 OR NOT (
 (OLD.state='queued' AND NEW.state IN ('dispatching','interrupted_before_dispatch','cancelled_before_dispatch','failed')) OR
 (OLD.state='interrupted_before_dispatch' AND NEW.state='cancelled_before_dispatch') OR
 (OLD.state='dispatching' AND NEW.state IN ('receiving','persisting','failed','outcome_unknown','local_result_error')) OR
 (OLD.state='receiving' AND NEW.state IN ('persisting','failed','outcome_unknown','local_result_error')) OR
 (OLD.state='persisting' AND NEW.state IN ('succeeded','outcome_unknown','local_result_error')) OR
 (OLD.state IN ('local_result_error','outcome_unknown') AND NEW.state='persisting') OR
 (OLD.state='outcome_unknown' AND NEW.state='failed' AND json_extract(OLD.input,'$.providerId')='comfy-local'
 AND EXISTS(SELECT 1 FROM image_remote_runs r JOIN image_remote_observations o ON o.taskId=r.taskId AND o.projectId=r.projectId
 WHERE r.taskId=OLD.id AND r.projectId=OLD.projectId AND r.state='failed' AND r.contentVerified=1
 AND o.state='running' AND r.revision>o.remoteRevision)))
 BEGIN SELECT RAISE(ABORT,'invalid image task transition');END;

CREATE TRIGGER retain_image_tasks BEFORE DELETE ON image_tasks BEGIN SELECT RAISE(ABORT,'image tasks must be retained');END;

CREATE TABLE "image_reviews"(
      id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),
      projectId TEXT NOT NULL,
      requestId TEXT NOT NULL UNIQUE CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
      inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
      canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 24576),
      intentHash TEXT NOT NULL CHECK(length(intentHash)=64 AND intentHash NOT GLOB '*[^a-f0-9]*'),
      canonicalIntent TEXT NOT NULL CHECK(json_valid(canonicalIntent) AND json_type(canonicalIntent)='object' AND length(CAST(canonicalIntent AS BLOB)) BETWEEN 1 AND 32768),
      state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','dispatched')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 3),
      taskId TEXT UNIQUE REFERENCES image_tasks(id) DEFERRABLE INITIALLY DEFERRED,
      postAttempts INTEGER NOT NULL CHECK(typeof(postAttempts)='integer' AND postAttempts IN (0,1)),
      createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),
      updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
      approvedAt TEXT CHECK(approvedAt IS NULL OR length(approvedAt) BETWEEN 1 AND 40),
      rejectedAt TEXT CHECK(rejectedAt IS NULL OR length(rejectedAt) BETWEEN 1 AND 40),
      dispatchedAt TEXT CHECK(dispatchedAt IS NULL OR length(dispatchedAt) BETWEEN 1 AND 40),

      CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId),
      CHECK(json_extract(canonicalIntent,'$.reviewId') IS id AND json_extract(canonicalIntent,'$.input') IS json(canonicalInput)),
      CHECK(json_type(canonicalIntent,'$.settingsRevision') IS 'integer' AND json_extract(canonicalIntent,'$.settingsRevision') BETWEEN 1 AND 9007199254740991),
      CONSTRAINT image_review_intent_s2 CHECK(
        (json_extract(canonicalIntent,'$.schemaVersion') IS 1 AND json_extract(canonicalInput,'$.providerId') IS 'openai'
          AND json_extract(canonicalInput,'$.model') IS 'gpt-image-2.5-flare-2026-09-08'
          AND json_extract(canonicalIntent,'$.destination') IS 'https://api.openai.com/v1/images/generations'
          AND json_type(canonicalIntent,'$.configuration') IS NULL)
        OR
        (json_extract(canonicalIntent,'$.schemaVersion') IS 2 AND json_extract(canonicalInput,'$.providerId') IS 'openai-compatible'
          AND json_type(canonicalIntent,'$.configuration') IS 'object'
          AND json_type(canonicalIntent,'$.configuration.enabled') IS 'true'
          AND json_extract(canonicalIntent,'$.configuration.providerId') IS 'openai-compatible'
          AND json_extract(canonicalIntent,'$.configuration.connectionId') IS 'custom'
          AND json_extract(canonicalIntent,'$.configuration.profileId') IS 'openai-images-json-png-v1'
          AND json_type(canonicalIntent,'$.configuration.baseUrl') IS 'text'
          AND length(json_extract(canonicalIntent,'$.configuration.baseUrl')) BETWEEN 1 AND 2029
          AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),1,8) IS 'https://'
          AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),-1,1) IS NOT '/'
          AND json_type(canonicalInput,'$.model') IS 'text'
          AND length(CAST(json_extract(canonicalInput,'$.model') AS BLOB)) BETWEEN 1 AND 120
          AND json_extract(canonicalInput,'$.model') NOT GLOB '*[^!-~]*'
          AND json_extract(canonicalIntent,'$.configuration.model') IS json_extract(canonicalInput,'$.model')
          AND json_type(canonicalIntent,'$.configuration.options') IS 'object'
          AND json_extract(canonicalIntent,'$.configuration.options') IS json_extract(canonicalInput,'$.options')
          AND json_extract(canonicalIntent,'$.destination') IS json_extract(canonicalIntent,'$.configuration.baseUrl')||'/images/generations')

        OR
        (json_extract(canonicalIntent,'$.schemaVersion') IS 3 AND json_extract(canonicalInput,'$.providerId') IS 'comfy-local'
          AND json_type(canonicalIntent,'$.configuration') IS 'object'
          AND json_type(canonicalIntent,'$.configuration.enabled') IS 'true'
          AND json_extract(canonicalIntent,'$.configuration.providerId') IS 'comfy-local'
          AND json_extract(canonicalIntent,'$.configuration.connectionId') IS 'comfy-local'
          AND json_extract(canonicalIntent,'$.configuration.profileId') IS 'comfy-t2i-png-v1'
          AND json_extract(canonicalIntent,'$.configuration.comfyVersion') IS '0.39.0'
          AND json_type(canonicalIntent,'$.configuration.baseUrl') IS 'text'
          AND ((json_extract(canonicalIntent,'$.configuration.baseUrl') GLOB 'http://127.0.0.1:[1-9]*'
            AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),18) NOT GLOB '*[^0-9]*'
            AND CAST(substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),18) AS INTEGER) BETWEEN 1 AND 65535)
            OR (substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),1,13) IS 'http://[::1]:'
            AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),14,1) GLOB '[1-9]'
            AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),14) NOT GLOB '*[^0-9]*'
            AND CAST(substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),14) AS INTEGER) BETWEEN 1 AND 65535))
          AND json_type(canonicalInput,'$.model') IS 'text'
          AND length(CAST(json_extract(canonicalInput,'$.model') AS BLOB)) BETWEEN 1 AND 240
          AND json_extract(canonicalIntent,'$.configuration.model') IS json_extract(canonicalInput,'$.model')
          AND json_type(canonicalIntent,'$.configuration.options') IS 'object'
          AND json_extract(canonicalIntent,'$.configuration.options') IS json_extract(canonicalInput,'$.options')
          AND json_extract(canonicalInput,'$.options.size') IS '512x512'
          AND json_extract(canonicalInput,'$.options.steps') IS 20 AND json_extract(canonicalInput,'$.options.cfg') IS 8
          AND json_extract(canonicalInput,'$.options.sampler') IS 'euler' AND json_extract(canonicalInput,'$.options.scheduler') IS 'normal'
          AND json_extract(canonicalInput,'$.options.denoise') IS 1 AND json_extract(canonicalInput,'$.options.n') IS 1
          AND json_extract(canonicalIntent,'$.destination') IS json_extract(canonicalIntent,'$.configuration.baseUrl')||'/prompt'
          AND json_extract(canonicalIntent,'$.policy.price') IS 'local-compute-unknown'
          AND json_extract(canonicalIntent,'$.policy.promptStorage') IS 'local-plaintext'
          AND json_type(canonicalIntent,'$.execution') IS 'object'
          AND json_extract(canonicalIntent,'$.execution.workflowId') IS 'comfy-t2i-png-v1'
          AND json_extract(canonicalIntent,'$.execution.workflowVersion') IS 1
          AND json_extract(canonicalIntent,'$.execution.comfyVersion') IS '0.39.0'
          AND json_type(canonicalIntent,'$.execution.seed') IS 'integer'
          AND json_extract(canonicalIntent,'$.execution.seed') BETWEEN 0 AND 9007199254740991
          AND length(json_extract(canonicalIntent,'$.execution.promptId')) IS 36
          AND length(json_extract(canonicalIntent,'$.execution.clientId')) IS 36
          AND length(json_extract(canonicalIntent,'$.execution.outputNonce')) IS 36
          AND json_extract(canonicalIntent,'$.execution.filenamePrefix') IS 'mioon_'||json_extract(canonicalIntent,'$.execution.outputNonce')
          AND length(json_extract(canonicalIntent,'$.execution.graphHash')) IS 64
          AND json_type(canonicalIntent,'$.execution.graph') IS 'object'
          AND length(CAST(json_extract(canonicalIntent,'$.execution.graph') AS BLOB)) BETWEEN 1 AND 32768
          AND json_extract(canonicalIntent,'$.execution.graph."1".inputs.ckpt_name') IS json_extract(canonicalInput,'$.model')
          AND json_extract(canonicalIntent,'$.execution.graph."3".inputs.text') IS json_extract(canonicalInput,'$.prompt')
          AND json_extract(canonicalIntent,'$.execution.graph."5".inputs.seed') IS json_extract(canonicalIntent,'$.execution.seed')
          AND json_extract(canonicalIntent,'$.execution.graph."7".inputs.filename_prefix') IS json_extract(canonicalIntent,'$.execution.filenamePrefix'))

        OR
        (json_extract(canonicalIntent,'$.schemaVersion') IS 4
          AND json_extract(canonicalInput,'$.providerId') IS 'openai'
          AND json_extract(canonicalInput,'$.model') IS 'gpt-image-2.5-flare-2026-09-08'
          AND json_extract(canonicalInput,'$.purpose') IS 'edit'
          AND json_extract(canonicalIntent,'$.destination') IS 'https://api.openai.com/v1/images/edits'
          AND json_type(canonicalIntent,'$.configuration') IS NULL AND json_type(canonicalIntent,'$.execution') IS NULL
          AND json_remove(canonicalIntent,'$.schemaVersion','$.reviewId','$.input','$.settingsRevision','$.destination','$.policy','$.sourceImage') IS '{}'
          AND json_type(canonicalIntent,'$.policy') IS 'object'
          AND json_remove(json_extract(canonicalIntent,'$.policy'),'$.maxPostAttempts','$.automaticRetry','$.price','$.promptStorage') IS '{}'
          AND json_type(canonicalIntent,'$.policy.maxPostAttempts') IS 'integer' AND json_extract(canonicalIntent,'$.policy.maxPostAttempts') IS 1
          AND json_type(canonicalIntent,'$.policy.automaticRetry') IS 'false'
          AND json_extract(canonicalIntent,'$.policy.price') IS 'usage-based-unknown' AND json_extract(canonicalIntent,'$.policy.promptStorage') IS 'local-plaintext'
          AND json_remove(canonicalInput,'$.projectId','$.requestId','$.name','$.providerId','$.model','$.prompt','$.options','$.groupId','$.expectedRevision','$.purpose','$.inputImage') IS '{}'
          AND json_type(canonicalInput,'$.inputImage') IS 'object'
          AND json_remove(json_extract(canonicalInput,'$.inputImage'),'$.assetId','$.sha256') IS '{}'
          AND json_type(canonicalInput,'$.inputImage.assetId') IS 'text' AND length(json_extract(canonicalInput,'$.inputImage.assetId')) IS 36
          AND json_type(canonicalInput,'$.inputImage.sha256') IS 'text' AND length(json_extract(canonicalInput,'$.inputImage.sha256')) IS 64
          AND json_extract(canonicalInput,'$.inputImage.sha256') NOT GLOB '*[^a-f0-9]*'
          AND json_type(canonicalInput,'$.options') IS 'object'
          AND json_remove(json_extract(canonicalInput,'$.options'),'$.size','$.quality','$.outputFormat','$.background','$.n') IS '{}'
          AND json_extract(canonicalInput,'$.options.size') IS '1024x1024' AND json_extract(canonicalInput,'$.options.quality') IS 'low'
          AND json_extract(canonicalInput,'$.options.outputFormat') IS 'png' AND json_extract(canonicalInput,'$.options.background') IS 'opaque'
          AND json_type(canonicalInput,'$.options.n') IS 'integer' AND json_extract(canonicalInput,'$.options.n') IS 1
          AND json_type(canonicalIntent,'$.sourceImage') IS 'object'
          AND json_remove(json_extract(canonicalIntent,'$.sourceImage'),'$.assetId','$.sha256','$.mimeType','$.byteLength','$.width','$.height','$.name','$.origin') IS '{}'
          AND json_extract(canonicalIntent,'$.sourceImage.assetId') IS json_extract(canonicalInput,'$.inputImage.assetId')
          AND json_extract(canonicalIntent,'$.sourceImage.sha256') IS json_extract(canonicalInput,'$.inputImage.sha256')
          AND json_extract(canonicalIntent,'$.sourceImage.mimeType') IS 'image/png'
          AND json_type(canonicalIntent,'$.sourceImage.byteLength') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.byteLength') BETWEEN 1 AND 8388608
          AND json_type(canonicalIntent,'$.sourceImage.width') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.width') BETWEEN 1 AND 1024
          AND json_type(canonicalIntent,'$.sourceImage.height') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.height') BETWEEN 1 AND 1024
          AND json_extract(canonicalIntent,'$.sourceImage.width')*json_extract(canonicalIntent,'$.sourceImage.height')<=1048576
          AND json_type(canonicalIntent,'$.sourceImage.name') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.name')) BETWEEN 1 AND 200
          AND length(trim(json_extract(canonicalIntent,'$.sourceImage.name')))>0
          AND length(CAST(json_extract(canonicalIntent,'$.sourceImage.name') AS BLOB)) BETWEEN 1 AND 800
          AND json_type(canonicalIntent,'$.sourceImage.origin') IS 'object'
          AND (
            (json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'user-import'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind') IS '{}')
            OR
            ((json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'generated' OR json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'synthetic-mock')
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind','$.imageSource') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource') IS 'object'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource'),'$.imageGroupId','$.imageTaskId','$.imageVersionId') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource.imageGroupId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource.imageGroupId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource.imageTaskId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource.imageTaskId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource.imageVersionId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource.imageVersionId')) IS 36)
            OR
            (json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'extracted-frame'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind','$.frameSource') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource') IS 'object'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource'),'$.frameTaskId','$.sourceAssetId','$.sourceHash','$.sourceFrame','$.fps','$.profileId','$.selectionRule') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.frameTaskId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.frameTaskId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.sourceAssetId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceAssetId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.sourceHash') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceHash')) IS 64
              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceHash') NOT GLOB '*[^a-f0-9]*'
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.sourceFrame') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceFrame') BETWEEN 0 AND 9007199254740991
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.fps') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.fps') IS 30
              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.profileId') IS 'local-png-1024-v1'
              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.selectionRule') IS 'first-pts-at-or-after-v1')
          ))
        OR
        (json_extract(canonicalIntent,'$.schemaVersion') IS 5
          AND json_extract(canonicalInput,'$.providerId') IS 'openai'
          AND json_extract(canonicalInput,'$.model') IS 'gpt-image-2.5-flare-2026-09-08'
          AND json_extract(canonicalInput,'$.purpose') IS 'edit'
          AND json_extract(canonicalIntent,'$.destination') IS 'https://api.openai.com/v1/images/edits'
          AND json_type(canonicalIntent,'$.configuration') IS NULL AND json_type(canonicalIntent,'$.execution') IS NULL
          AND json_remove(canonicalIntent,'$.schemaVersion','$.reviewId','$.input','$.settingsRevision','$.destination','$.policy','$.sourceImage') IS '{}'
          AND json_type(canonicalIntent,'$.policy') IS 'object'
          AND json_remove(json_extract(canonicalIntent,'$.policy'),'$.maxPostAttempts','$.automaticRetry','$.price','$.promptStorage') IS '{}'
          AND json_type(canonicalIntent,'$.policy.maxPostAttempts') IS 'integer' AND json_extract(canonicalIntent,'$.policy.maxPostAttempts') IS 1
          AND json_type(canonicalIntent,'$.policy.automaticRetry') IS 'false'
          AND json_extract(canonicalIntent,'$.policy.price') IS 'usage-based-unknown' AND json_extract(canonicalIntent,'$.policy.promptStorage') IS 'local-plaintext'
          AND json_remove(canonicalInput,'$.projectId','$.requestId','$.name','$.providerId','$.model','$.prompt','$.options','$.groupId','$.expectedRevision','$.purpose','$.inputImage') IS '{}'
          AND json_type(canonicalInput,'$.inputImage') IS 'object'
          AND json_remove(json_extract(canonicalInput,'$.inputImage'),'$.assetId','$.sha256') IS '{}'
          AND json_type(canonicalInput,'$.inputImage.assetId') IS 'text' AND length(json_extract(canonicalInput,'$.inputImage.assetId')) IS 36
          AND json_type(canonicalInput,'$.inputImage.sha256') IS 'text' AND length(json_extract(canonicalInput,'$.inputImage.sha256')) IS 64
          AND json_extract(canonicalInput,'$.inputImage.sha256') NOT GLOB '*[^a-f0-9]*'
          AND json_type(canonicalInput,'$.options') IS 'object'
          AND json_remove(json_extract(canonicalInput,'$.options'),'$.size','$.quality','$.outputFormat','$.background','$.n') IS '{}'
          AND json_type(canonicalInput,'$.options.size') IS 'text' AND length(json_extract(canonicalInput,'$.options.size')) BETWEEN 7 AND 9
          AND json_extract(canonicalInput,'$.options.size') GLOB '[1-9]*x[1-9]*' AND json_extract(canonicalInput,'$.options.size') NOT GLOB '*[^0-9x]*' AND json_extract(canonicalInput,'$.options.quality') IS 'low'
          AND json_extract(canonicalInput,'$.options.outputFormat') IS 'png' AND json_extract(canonicalInput,'$.options.background') IS 'opaque'
          AND json_type(canonicalInput,'$.options.n') IS 'integer' AND json_extract(canonicalInput,'$.options.n') IS 1
          AND json_type(canonicalIntent,'$.sourceImage') IS 'object'
          AND json_remove(json_extract(canonicalIntent,'$.sourceImage'),'$.assetId','$.sha256','$.mimeType','$.byteLength','$.width','$.height','$.name','$.origin') IS '{}'
          AND json_extract(canonicalIntent,'$.sourceImage.assetId') IS json_extract(canonicalInput,'$.inputImage.assetId')
          AND json_extract(canonicalIntent,'$.sourceImage.sha256') IS json_extract(canonicalInput,'$.inputImage.sha256')
          AND json_extract(canonicalIntent,'$.sourceImage.mimeType') IN ('image/png','image/jpeg','image/webp')
          AND json_type(canonicalIntent,'$.sourceImage.byteLength') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.byteLength') BETWEEN 1 AND 52428799
          AND json_type(canonicalIntent,'$.sourceImage.width') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.width') BETWEEN 1 AND 4096
          AND json_type(canonicalIntent,'$.sourceImage.height') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.height') BETWEEN 1 AND 4096
          AND json_extract(canonicalIntent,'$.sourceImage.width')*json_extract(canonicalIntent,'$.sourceImage.height')<=16777216
          AND json_type(canonicalIntent,'$.sourceImage.name') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.name')) BETWEEN 1 AND 200
          AND length(trim(json_extract(canonicalIntent,'$.sourceImage.name')))>0
          AND length(CAST(json_extract(canonicalIntent,'$.sourceImage.name') AS BLOB)) BETWEEN 1 AND 800
          AND json_type(canonicalIntent,'$.sourceImage.origin') IS 'object'
          AND (
            (json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'user-import'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind') IS '{}')
            OR
            ((json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'generated' OR json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'synthetic-mock')
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind','$.imageSource') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource') IS 'object'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource'),'$.imageGroupId','$.imageTaskId','$.imageVersionId') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource.imageGroupId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource.imageGroupId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource.imageTaskId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource.imageTaskId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource.imageVersionId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource.imageVersionId')) IS 36)
            OR
            (json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'extracted-frame'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind','$.frameSource') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource') IS 'object'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource'),'$.frameTaskId','$.sourceAssetId','$.sourceHash','$.sourceFrame','$.fps','$.profileId','$.selectionRule') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.frameTaskId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.frameTaskId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.sourceAssetId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceAssetId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.sourceHash') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceHash')) IS 64
              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceHash') NOT GLOB '*[^a-f0-9]*'
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.sourceFrame') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceFrame') BETWEEN 0 AND 9007199254740991
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.fps') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.fps') IS 30
              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.profileId') IS 'local-png-1024-v1'
              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.selectionRule') IS 'first-pts-at-or-after-v1')
            OR
            (json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'scene-keyframe'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind','$.sceneKeyframe') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe') IS 'object'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe'),'$.sceneTaskId','$.sourceAssetId','$.sourceHash','$.segment','$.sourceFrame') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sceneTaskId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sceneTaskId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceAssetId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceAssetId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceHash') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceHash')) IS 64
              AND json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceHash') NOT GLOB '*[^a-f0-9]*'
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.segment') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.segment') BETWEEN 1 AND 1501
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceFrame') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceFrame') BETWEEN 0 AND 18000)
            OR
            (json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'previs-output'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind','$.previsOutput','$.publicationId') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.previsOutput') IS 'object'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput'),'$.projectId','$.nodeId','$.keyframeId','$.sceneRevision','$.requestId','$.name','$.sha256','$.width','$.height') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.previsOutput.projectId') IS 'text' AND json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.projectId') IS projectId
              AND json_type(canonicalIntent,'$.sourceImage.origin.publicationId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.publicationId')) IS 36
              AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.publicationId'),9,1) IS '-' AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.publicationId'),14,1) IS '-' AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.publicationId'),19,1) IS '-' AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.publicationId'),24,1) IS '-'
              AND length(replace(json_extract(canonicalIntent,'$.sourceImage.origin.publicationId'),'-','')) IS 32 AND replace(json_extract(canonicalIntent,'$.sourceImage.origin.publicationId'),'-','') NOT GLOB '*[^a-f0-9]*'
              AND json_type(canonicalIntent,'$.sourceImage.origin.previsOutput.nodeId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.nodeId')) IS 36
              AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.nodeId'),9,1) IS '-' AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.nodeId'),14,1) IS '-' AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.nodeId'),19,1) IS '-' AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.nodeId'),24,1) IS '-'
              AND length(replace(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.nodeId'),'-','')) IS 32 AND replace(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.nodeId'),'-','') NOT GLOB '*[^a-f0-9]*'
              AND json_type(canonicalIntent,'$.sourceImage.origin.previsOutput.keyframeId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.keyframeId')) BETWEEN 2 AND 5 AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.keyframeId'),1,1) IS 'k' AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.keyframeId'),2,1) GLOB '[1-9]' AND substr(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.keyframeId'),2) NOT GLOB '*[^0-9]*'
              AND json_type(canonicalIntent,'$.sourceImage.origin.previsOutput.sceneRevision') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.sceneRevision') BETWEEN 1 AND 9007199254740991
              AND json_type(canonicalIntent,'$.sourceImage.origin.previsOutput.requestId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.requestId')) BETWEEN 8 AND 200 AND length(CAST(json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.requestId') AS BLOB))<=800
              AND json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.name') IS json_extract(canonicalIntent,'$.sourceImage.name')
              AND json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.sha256') IS json_extract(canonicalIntent,'$.sourceImage.sha256')
              AND json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.width') IS json_extract(canonicalIntent,'$.sourceImage.width')
              AND json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.height') IS json_extract(canonicalIntent,'$.sourceImage.height')
              AND json_type(canonicalIntent,'$.sourceImage.origin.previsOutput.width') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.width') BETWEEN 1 AND 4096
              AND json_type(canonicalIntent,'$.sourceImage.origin.previsOutput.height') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.previsOutput.height') BETWEEN 1 AND 4096)
          ))
      ),
      CONSTRAINT image_review_edit_separation_v62 CHECK(
        json_extract(canonicalIntent,'$.schemaVersion') IS 4 OR json_extract(canonicalIntent,'$.schemaVersion') IS 5 OR
        (json_type(canonicalInput,'$.purpose') IS NULL AND json_type(canonicalInput,'$.inputImage') IS NULL AND json_type(canonicalIntent,'$.sourceImage') IS NULL)),
      CHECK(json_extract(canonicalIntent,'$.policy.maxPostAttempts') IS 1 AND json_extract(canonicalIntent,'$.policy.automaticRetry') IS 0),
      CHECK((taskId IS NOT NULL)=(state IN ('approved','dispatched')) AND (approvedAt IS NOT NULL)=(state IN ('approved','dispatched'))),
      CHECK((rejectedAt IS NOT NULL)=(state='rejected') AND (dispatchedAt IS NOT NULL)=(state='dispatched')),
      CHECK(postAttempts=(state='dispatched') AND revision=CASE state WHEN 'pending' THEN 1 WHEN 'dispatched' THEN 3 ELSE 2 END),
      CHECK(length(CAST(canonicalInput AS BLOB))+length(CAST(canonicalIntent AS BLOB))+length(CAST(requestId AS BLOB))+512<=65536)
    );

CREATE INDEX image_reviews_project_page ON image_reviews(projectId,createdAt DESC,id DESC);

CREATE TRIGGER image_review_insert_pending BEFORE INSERT ON image_reviews
      WHEN NEW.state IS NOT 'pending' OR NEW.revision IS NOT 1 OR NEW.taskId IS NOT NULL OR NEW.postAttempts IS NOT 0
      BEGIN SELECT RAISE(ABORT,'image reviews must start pending'); END;

CREATE TRIGGER image_review_state_transitions BEFORE UPDATE ON image_reviews
      WHEN NEW.revision IS NOT OLD.revision+1 OR NOT (
        (OLD.state='pending' AND NEW.state IN ('approved','rejected')) OR
        (OLD.state='approved' AND NEW.state='dispatched'))
      BEGIN SELECT RAISE(ABORT,'invalid image review transition'); END;

CREATE TRIGGER image_review_task_binding BEFORE UPDATE ON image_reviews
      WHEN NEW.taskId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM image_tasks WHERE id=NEW.taskId AND projectId=NEW.projectId AND requestId=NEW.requestId AND inputHash=NEW.inputHash AND input=NEW.canonicalInput)
      BEGIN SELECT RAISE(ABORT,'image review task binding mismatch'); END;

CREATE TRIGGER immutable_image_review_identity BEFORE UPDATE ON image_reviews
      WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.requestId IS NOT OLD.requestId OR
        NEW.inputHash IS NOT OLD.inputHash OR NEW.canonicalInput IS NOT OLD.canonicalInput OR
        NEW.intentHash IS NOT OLD.intentHash OR NEW.canonicalIntent IS NOT OLD.canonicalIntent OR NEW.createdAt IS NOT OLD.createdAt OR
        (OLD.taskId IS NOT NULL AND NEW.taskId IS NOT OLD.taskId) OR
        (OLD.approvedAt IS NOT NULL AND NEW.approvedAt IS NOT OLD.approvedAt) OR
        (OLD.rejectedAt IS NOT NULL AND NEW.rejectedAt IS NOT OLD.rejectedAt) OR
        (OLD.dispatchedAt IS NOT NULL AND NEW.dispatchedAt IS NOT OLD.dispatchedAt) OR NEW.postAttempts<OLD.postAttempts
      BEGIN SELECT RAISE(ABORT,'image review identity and reservation are immutable'); END;

CREATE TRIGGER reject_image_review_cross_observation BEFORE INSERT ON image_reviews
 WHEN EXISTS(SELECT 1 FROM image_remote_observations WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request identity is already retained');END;

CREATE TRIGGER reject_image_review_replacement BEFORE INSERT ON image_reviews
      WHEN EXISTS(SELECT 1 FROM image_reviews WHERE id=NEW.id OR requestId=NEW.requestId)
      BEGIN SELECT RAISE(ABORT,'image reviews cannot be replaced'); END;

CREATE TRIGGER retain_image_reviews BEFORE DELETE ON image_reviews BEGIN SELECT RAISE(ABORT,'image reviews must be retained'); END;

CREATE TABLE image_remote_runs(
 taskId TEXT PRIMARY KEY NOT NULL REFERENCES image_tasks(id) CHECK(length(CAST(taskId AS BLOB))=36),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),reviewId TEXT NOT NULL UNIQUE REFERENCES image_reviews(id) CHECK(length(CAST(reviewId AS BLOB))=36),
 promptId TEXT NOT NULL UNIQUE CHECK(length(CAST(promptId AS BLOB))=36),
 clientId TEXT NOT NULL CHECK(length(CAST(clientId AS BLOB))=36),
 outputNonce TEXT NOT NULL UNIQUE CHECK(length(CAST(outputNonce AS BLOB))=36),
 filenamePrefix TEXT NOT NULL CHECK(filenamePrefix='mioon_'||outputNonce),
 workflowId TEXT NOT NULL CHECK(workflowId='comfy-t2i-png-v1'),workflowVersion INTEGER NOT NULL CHECK(workflowVersion=1),
 comfyVersion TEXT NOT NULL CHECK(comfyVersion='0.39.0'),
 seed INTEGER NOT NULL CHECK(typeof(seed)='integer' AND seed BETWEEN 0 AND 9007199254740991),
 baseUrl TEXT NOT NULL CHECK(length(CAST(baseUrl AS BLOB)) BETWEEN 1 AND 64),
 graphHash TEXT NOT NULL CHECK(length(graphHash)=64 AND graphHash NOT GLOB '*[^a-f0-9]*'),
 rawGraph TEXT NOT NULL CHECK(json_valid(rawGraph) AND json_type(rawGraph)='object' AND length(CAST(rawGraph AS BLOB)) BETWEEN 1 AND 32768),
 state TEXT NOT NULL CHECK(state IN ('prepared','submitted','submission_unknown','queued','running','completed','failed','unavailable')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 contentVerified INTEGER NOT NULL CHECK(contentVerified IN (0,1)),
 outputDescriptor TEXT CHECK(outputDescriptor IS NULL OR (json_valid(outputDescriptor) AND json_type(outputDescriptor)='object' AND length(CAST(outputDescriptor AS BLOB)) BETWEEN 1 AND 4096)),
 resultSha256 TEXT CHECK(resultSha256 IS NULL OR (length(resultSha256)=64 AND resultSha256 NOT GLOB '*[^a-f0-9]*')),
 resultBytes INTEGER CHECK(resultBytes IS NULL OR (typeof(resultBytes)='integer' AND resultBytes BETWEEN 1 AND 31457280)),
 errorCode TEXT CHECK(errorCode IS NULL OR (length(errorCode) BETWEEN 1 AND 80 AND errorCode NOT GLOB '*[^A-Z0-9_]*')),
 createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 lastObservedAt TEXT CHECK(lastObservedAt IS NULL OR length(lastObservedAt) BETWEEN 1 AND 40),
 CHECK(contentVerified=(state IN ('completed','failed'))),
 CHECK((outputDescriptor IS NOT NULL)=(state='completed') AND (resultSha256 IS NOT NULL)=(state='completed') AND (resultBytes IS NOT NULL)=(state='completed')),
 CHECK(length(CAST(rawGraph AS BLOB))+COALESCE(length(CAST(outputDescriptor AS BLOB)),0)+length(CAST(baseUrl AS BLOB))+2048<=65536)
);

CREATE INDEX image_remote_runs_project ON image_remote_runs(projectId,taskId);

CREATE TRIGGER immutable_image_remote_run_identity BEFORE UPDATE ON image_remote_runs
 WHEN NEW.taskId IS NOT OLD.taskId OR NEW.projectId IS NOT OLD.projectId OR NEW.reviewId IS NOT OLD.reviewId OR
 NEW.promptId IS NOT OLD.promptId OR NEW.clientId IS NOT OLD.clientId OR NEW.outputNonce IS NOT OLD.outputNonce OR
 NEW.filenamePrefix IS NOT OLD.filenamePrefix OR NEW.workflowId IS NOT OLD.workflowId OR NEW.workflowVersion IS NOT OLD.workflowVersion OR
 NEW.comfyVersion IS NOT OLD.comfyVersion OR NEW.seed IS NOT OLD.seed OR NEW.baseUrl IS NOT OLD.baseUrl OR NEW.graphHash IS NOT OLD.graphHash OR
 NEW.rawGraph IS NOT OLD.rawGraph OR NEW.createdAt IS NOT OLD.createdAt OR NEW.contentVerified<OLD.contentVerified OR
 (OLD.outputDescriptor IS NOT NULL AND NEW.outputDescriptor IS NOT OLD.outputDescriptor) OR
 (OLD.resultSha256 IS NOT NULL AND NEW.resultSha256 IS NOT OLD.resultSha256) OR (OLD.resultBytes IS NOT NULL AND NEW.resultBytes IS NOT OLD.resultBytes)
 BEGIN SELECT RAISE(ABORT,'remote image execution identity is immutable');END;

CREATE TRIGGER image_remote_run_transition BEFORE UPDATE ON image_remote_runs
 WHEN NEW.revision IS NOT OLD.revision+1 OR (OLD.state IN ('completed','failed') AND NEW.state IS NOT OLD.state) OR
 (OLD.state IS NOT 'prepared' AND NEW.state='prepared')
 BEGIN SELECT RAISE(ABORT,'invalid remote image transition');END;

CREATE TRIGGER reject_image_remote_run_replacement BEFORE INSERT ON image_remote_runs
 WHEN EXISTS(SELECT 1 FROM image_remote_runs WHERE taskId=NEW.taskId OR reviewId=NEW.reviewId OR promptId=NEW.promptId OR outputNonce=NEW.outputNonce)
 BEGIN SELECT RAISE(ABORT,'remote image identities cannot be replaced');END;

CREATE TRIGGER retain_image_remote_runs BEFORE DELETE ON image_remote_runs BEGIN SELECT RAISE(ABORT,'remote image identities must be retained');END;

CREATE TRIGGER image_remote_run_insert_identity BEFORE INSERT ON image_remote_runs
 WHEN NEW.state IS NOT 'prepared' OR NEW.revision IS NOT 1 OR NEW.contentVerified IS NOT 0 OR NEW.outputDescriptor IS NOT NULL OR
 NOT EXISTS(SELECT 1 FROM image_tasks t JOIN image_reviews r ON r.taskId=t.id
 WHERE t.id=NEW.taskId AND t.projectId=NEW.projectId AND r.id=NEW.reviewId AND r.projectId=NEW.projectId
 AND json_extract(t.input,'$.providerId')='comfy-local' AND json_extract(r.canonicalIntent,'$.schemaVersion')=3
 AND json_extract(r.canonicalIntent,'$.execution.promptId') IS NEW.promptId
 AND json_extract(r.canonicalIntent,'$.execution.clientId') IS NEW.clientId
 AND json_extract(r.canonicalIntent,'$.execution.outputNonce') IS NEW.outputNonce
 AND json_extract(r.canonicalIntent,'$.execution.filenamePrefix') IS NEW.filenamePrefix
 AND json_extract(r.canonicalIntent,'$.execution.graphHash') IS NEW.graphHash
 AND json_extract(r.canonicalIntent,'$.execution.graph') IS json(NEW.rawGraph)
 AND json_extract(r.canonicalIntent,'$.execution.seed') IS NEW.seed
 AND json_extract(r.canonicalIntent,'$.configuration.baseUrl') IS NEW.baseUrl)
 BEGIN SELECT RAISE(ABORT,'remote image identity must bind an approved local review');END;

CREATE TABLE image_remote_observations(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 id TEXT NOT NULL UNIQUE CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),taskId TEXT NOT NULL REFERENCES image_remote_runs(taskId) CHECK(length(CAST(taskId AS BLOB))=36),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 4096),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 8192),
 state TEXT NOT NULL CHECK(state IN ('queued','running','finished','interrupted')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 remoteRevision INTEGER NOT NULL CHECK(typeof(remoteRevision)='integer' AND remoteRevision BETWEEN 2 AND 9007199254740991),
 errorCode TEXT CHECK(errorCode IS NULL OR (length(errorCode) BETWEEN 1 AND 80 AND errorCode NOT GLOB '*[^A-Z0-9_]*')),
 createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.taskId') IS taskId AND json_extract(canonicalInput,'$.requestId') IS requestId),
 CHECK(json_extract(canonicalInput,'$.expectedRevision')+1 IS remoteRevision),
 CHECK(json_extract(response,'$.id') IS id AND json_extract(response,'$.projectId') IS projectId AND json_extract(response,'$.taskId') IS taskId AND json_extract(response,'$.requestId') IS requestId),
 CHECK(json_extract(response,'$.remoteRevision') IS remoteRevision AND json_extract(response,'$.state') IS 'queued' AND json_extract(response,'$.revision') IS 1 AND json_extract(response,'$.createdAt') IS createdAt),
 CHECK(length(CAST(canonicalInput AS BLOB))+length(CAST(response AS BLOB))+length(CAST(requestId AS BLOB))+1024<=16384)
);

CREATE INDEX image_remote_observations_task ON image_remote_observations(projectId,taskId,createdAt DESC,id DESC);

CREATE UNIQUE INDEX image_remote_observations_one_active ON image_remote_observations(taskId) WHERE state IN ('queued','running');

CREATE TRIGGER image_remote_observation_admission BEFORE INSERT ON image_remote_observations
 WHEN NEW.state IS NOT 'queued' OR NEW.revision IS NOT 1 OR NEW.errorCode IS NOT NULL OR
 NOT EXISTS(SELECT 1 FROM image_remote_runs WHERE taskId=NEW.taskId AND projectId=NEW.projectId AND revision=NEW.remoteRevision)
 BEGIN SELECT RAISE(ABORT,'remote observation must bind its durable claim');END;

CREATE TRIGGER immutable_image_remote_observation BEFORE UPDATE ON image_remote_observations
 WHEN NEW.requestId IS NOT OLD.requestId OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.taskId IS NOT OLD.taskId OR
 NEW.inputHash IS NOT OLD.inputHash OR NEW.canonicalInput IS NOT OLD.canonicalInput OR NEW.response IS NOT OLD.response OR
 NEW.remoteRevision IS NOT OLD.remoteRevision OR NEW.createdAt IS NOT OLD.createdAt
 BEGIN SELECT RAISE(ABORT,'remote observation request and acknowledgement are immutable');END;

CREATE TRIGGER image_remote_observation_transition BEFORE UPDATE ON image_remote_observations
 WHEN NEW.revision IS NOT OLD.revision+1 OR NOT ((OLD.state='queued' AND NEW.state IN ('running','interrupted')) OR (OLD.state='running' AND NEW.state IN ('finished','interrupted')))
 BEGIN SELECT RAISE(ABORT,'invalid remote observation transition');END;

CREATE TRIGGER reject_image_remote_observation_replacement BEFORE INSERT ON image_remote_observations
 WHEN EXISTS(SELECT 1 FROM image_remote_observations WHERE requestId=NEW.requestId OR id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'remote observations cannot be replaced');END;

CREATE TRIGGER retain_image_remote_observations BEFORE DELETE ON image_remote_observations BEGIN SELECT RAISE(ABORT,'remote observations must be retained');END;

CREATE TRIGGER reject_image_observation_cross_request BEFORE INSERT ON image_remote_observations
 WHEN EXISTS(SELECT 1 FROM image_requests WHERE requestId=NEW.requestId) OR EXISTS(SELECT 1 FROM image_reviews WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request identity is already retained');END;

CREATE TABLE frame_tasks(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),
 requestId TEXT NOT NULL UNIQUE CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 4096),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND json_type(snapshot)='object' AND length(CAST(snapshot AS BLOB)) BETWEEN 1 AND 4096),
 state TEXT NOT NULL CHECK(state IN ('queued','running','persisting','succeeded','cancelled_before_start','interrupted','local_result_error','failed')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 started INTEGER NOT NULL CHECK(started IN (0,1)),
 stagedReceipt TEXT CHECK(stagedReceipt IS NULL OR (json_valid(stagedReceipt) AND json_type(stagedReceipt)='object' AND length(CAST(stagedReceipt AS BLOB)) BETWEEN 1 AND 4096)),
 assetId TEXT UNIQUE,
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
 CHECK(json_extract(snapshot,'$.profile.id') IS 'local-png-1024-v1' AND json_extract(snapshot,'$.profile.selectionRule') IS 'first-pts-at-or-after-v1'),
 CHECK(json_extract(snapshot,'$.profile.maxEdge') IS 1024 AND json_extract(snapshot,'$.profile.mimeType') IS 'image/png' AND json_extract(snapshot,'$.profile.upscale') IS 0),
 CHECK(stagedReceipt IS NULL OR (json_extract(stagedReceipt,'$.schemaVersion') IS 1 AND json_extract(stagedReceipt,'$.projectId') IS projectId
 AND json_extract(stagedReceipt,'$.taskId') IS id AND json_extract(stagedReceipt,'$.inputHash') IS inputHash
 AND json_extract(stagedReceipt,'$.sourceAssetId') IS json_extract(input,'$.sourceAssetId') AND json_extract(stagedReceipt,'$.sourceHash') IS json_extract(input,'$.sourceHash')
 AND json_extract(stagedReceipt,'$.sourceFrame') IS json_extract(input,'$.sourceFrame') AND json_extract(stagedReceipt,'$.fps') IS 30
 AND json_extract(stagedReceipt,'$.profileId') IS 'local-png-1024-v1' AND json_extract(stagedReceipt,'$.selectionRule') IS 'first-pts-at-or-after-v1'
 AND json_type(stagedReceipt,'$.assetId') IS 'text' AND length(json_extract(stagedReceipt,'$.assetId'))=36
 AND json_extract(stagedReceipt,'$.assetId') IS NOT json_extract(input,'$.sourceAssetId')
 AND json_type(stagedReceipt,'$.sha256') IS 'text' AND length(json_extract(stagedReceipt,'$.sha256'))=64 AND json_extract(stagedReceipt,'$.sha256') NOT GLOB '*[^a-f0-9]*'
 AND json_extract(stagedReceipt,'$.mimeType') IS 'image/png'
 AND json_type(stagedReceipt,'$.width') IS 'integer' AND json_extract(stagedReceipt,'$.width') BETWEEN 1 AND 1024
 AND json_type(stagedReceipt,'$.height') IS 'integer' AND json_extract(stagedReceipt,'$.height') BETWEEN 1 AND 1024
 AND json_type(stagedReceipt,'$.byteLength') IS 'integer' AND json_extract(stagedReceipt,'$.byteLength') BETWEEN 1 AND 4194304)),
 CHECK((state='succeeded')=(assetId IS NOT NULL)),
 CHECK(assetId IS NULL OR assetId IS json_extract(stagedReceipt,'$.assetId')),
 CHECK(state NOT IN ('queued','cancelled_before_start') OR (started=0 AND stagedReceipt IS NULL)),
 CHECK(state NOT IN ('running','persisting','succeeded','local_result_error') OR started=1),
 CHECK(state NOT IN ('persisting','succeeded','local_result_error') OR stagedReceipt IS NOT NULL),
 CHECK(state!='failed' OR stagedReceipt IS NULL),
 CHECK(state!='queued' OR revision=1),
 CHECK(length(CAST(input AS BLOB))+length(CAST(snapshot AS BLOB))+COALESCE(length(CAST(stagedReceipt AS BLOB)),0)+length(CAST(requestId AS BLOB))+1024<=16384)
);

CREATE INDEX frame_tasks_project_page ON frame_tasks(projectId,createdAt DESC,id DESC);

CREATE INDEX frame_tasks_state ON frame_tasks(state,projectId,id);

CREATE UNIQUE INDEX frame_tasks_receipt_asset ON frame_tasks(json_extract(stagedReceipt,'$.assetId')) WHERE stagedReceipt IS NOT NULL;

CREATE TRIGGER frame_task_insert_identity BEFORE INSERT ON frame_tasks
 WHEN NEW.state IS NOT 'queued' OR NEW.revision IS NOT 1 OR NEW.started IS NOT 0 OR NEW.stagedReceipt IS NOT NULL OR NEW.assetId IS NOT NULL OR NEW.errorCode IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'frame tasks must be accepted before execution');END;

CREATE TRIGGER immutable_frame_task_identity BEFORE UPDATE ON frame_tasks
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.requestId IS NOT OLD.requestId OR NEW.inputHash IS NOT OLD.inputHash
 OR NEW.input IS NOT OLD.input OR NEW.snapshot IS NOT OLD.snapshot OR NEW.createdAt IS NOT OLD.createdAt
 OR (OLD.stagedReceipt IS NOT NULL AND NEW.stagedReceipt IS NOT OLD.stagedReceipt)
 OR (OLD.assetId IS NOT NULL AND NEW.assetId IS NOT OLD.assetId)
 OR NEW.started<OLD.started OR (NEW.started IS NOT OLD.started AND NOT (OLD.state='queued' AND NEW.state='running' AND OLD.started=0 AND NEW.started=1))
 BEGIN SELECT RAISE(ABORT,'frame identity and durable result are immutable');END;

CREATE TRIGGER frame_task_state_transitions BEFORE UPDATE ON frame_tasks
 WHEN NEW.revision IS NOT OLD.revision+1 OR NOT (
 (OLD.state='queued' AND NEW.state IN ('running','interrupted','cancelled_before_start','failed')) OR
 (OLD.state='running' AND NEW.state IN ('persisting','interrupted','local_result_error','failed')) OR
 (OLD.state='persisting' AND NEW.state IN ('succeeded','interrupted','local_result_error')) OR
 (OLD.state='interrupted' AND OLD.started=0 AND OLD.stagedReceipt IS NULL AND NEW.state='cancelled_before_start') OR
 (OLD.state IN ('interrupted','local_result_error') AND OLD.started=1 AND NEW.state='persisting'))
 BEGIN SELECT RAISE(ABORT,'invalid frame task transition');END;

CREATE TRIGGER reject_frame_task_replacement BEFORE INSERT ON frame_tasks
 WHEN EXISTS(SELECT 1 FROM frame_tasks WHERE id=NEW.id OR requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'frame tasks cannot be replaced');END;

CREATE TRIGGER frame_task_capacity BEFORE INSERT ON frame_tasks
 WHEN (SELECT COUNT(*) FROM frame_tasks)>=2048
 OR (SELECT COUNT(*) FROM frame_tasks WHERE projectId=NEW.projectId)>=256
 BEGIN SELECT RAISE(ABORT,'frame retained task capacity exceeded');END;

CREATE TRIGGER frame_task_queue_capacity BEFORE INSERT ON frame_tasks
 WHEN (SELECT COUNT(*) FROM frame_tasks WHERE state='queued')>=8
 OR (SELECT COUNT(*) FROM frame_tasks WHERE projectId=NEW.projectId AND state='queued')>=2
 BEGIN SELECT RAISE(ABORT,'frame queued task capacity exceeded');END;

CREATE TRIGGER frame_task_active_capacity BEFORE UPDATE OF state ON frame_tasks
 WHEN NEW.state IN ('running','persisting') AND OLD.state NOT IN ('running','persisting')
 AND EXISTS(SELECT 1 FROM frame_tasks WHERE state IN ('running','persisting') AND id!=NEW.id)
 BEGIN SELECT RAISE(ABORT,'frame active task capacity exceeded');END;

CREATE TRIGGER retain_frame_tasks BEFORE DELETE ON frame_tasks BEGIN SELECT RAISE(ABORT,'frame tasks must be retained');END;

CREATE TABLE scene_tasks(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),
 kind TEXT NOT NULL CHECK(kind IN ('detect','shots')),
 sourceAssetId TEXT NOT NULL CHECK(length(CAST(sourceAssetId AS BLOB))=36),
 requestId TEXT NOT NULL UNIQUE CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 16384),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND json_type(snapshot)='object' AND length(CAST(snapshot AS BLOB)) BETWEEN 1 AND 8192),
 state TEXT NOT NULL CHECK(state IN ('queued','running','cancelling','persisting','succeeded','cancelled_before_start','cancelled','interrupted','local_result_error','failed','undone')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 started INTEGER NOT NULL CHECK(started IN (0,1)),
 resultId TEXT UNIQUE CHECK(resultId IS NULL OR length(CAST(resultId AS BLOB))=36),
 stagedReceipt TEXT CHECK(stagedReceipt IS NULL OR (json_valid(stagedReceipt) AND json_type(stagedReceipt)='object' AND length(CAST(stagedReceipt AS BLOB)) BETWEEN 1 AND 32768)),
 outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND json_type(outcome)='object' AND length(CAST(outcome AS BLOB)) BETWEEN 1 AND 16384)),
 errorCode TEXT CHECK(errorCode IS NULL OR (length(errorCode) BETWEEN 1 AND 80 AND errorCode GLOB '[A-Z]*' AND errorCode NOT GLOB '*[^A-Z0-9_]*')),
 createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(id,projectId),
 FOREIGN KEY(requestId,id,projectId) REFERENCES scene_requests(requestId,taskId,projectId) DEFERRABLE INITIALLY DEFERRED,
 CHECK(json_extract(input,'$.projectId') IS projectId AND json_extract(input,'$.requestId') IS requestId AND json_extract(input,'$.sourceAssetId') IS sourceAssetId),
 CHECK(json_type(input,'$.sourceHash') IS 'text' AND length(json_extract(input,'$.sourceHash'))=64 AND json_extract(input,'$.sourceHash') NOT GLOB '*[^a-f0-9]*'),
 CHECK(json_extract(snapshot,'$.schemaVersion') IS 1 AND json_extract(snapshot,'$.projectId') IS projectId AND json_extract(snapshot,'$.taskId') IS id AND json_extract(snapshot,'$.kind') IS kind),
 CHECK(json_extract(snapshot,'$.source.assetId') IS sourceAssetId AND json_extract(snapshot,'$.source.sha256') IS json_extract(input,'$.sourceHash')),
 CHECK(kind!='detect' OR (stagedReceipt IS NULL AND outcome IS NULL AND (state='succeeded')=(resultId IS NOT NULL) AND state NOT IN ('persisting','local_result_error','undone'))),
 CHECK(kind!='shots' OR (resultId IS NULL AND (state IN ('succeeded','undone'))=(outcome IS NOT NULL))),
 CHECK(state NOT IN ('queued','cancelled_before_start') OR (started=0 AND stagedReceipt IS NULL)),
 CHECK(state NOT IN ('running','cancelling','persisting','succeeded','cancelled','local_result_error','undone') OR started=1),
 CHECK(state NOT IN ('persisting','local_result_error') OR stagedReceipt IS NOT NULL),
 CHECK((state IN ('interrupted','failed','local_result_error'))=(errorCode IS NOT NULL)),
 CHECK(state!='queued' OR revision=1),
 CHECK(length(CAST(input AS BLOB))+length(CAST(snapshot AS BLOB))+COALESCE(length(CAST(stagedReceipt AS BLOB)),0)+COALESCE(length(CAST(outcome AS BLOB)),0)+length(CAST(requestId AS BLOB))+1024<=81920)
);

CREATE INDEX scene_tasks_project_page ON scene_tasks(projectId,createdAt DESC,id DESC);

CREATE INDEX scene_tasks_asset_page ON scene_tasks(projectId,sourceAssetId,createdAt DESC,id DESC);

CREATE INDEX scene_tasks_state ON scene_tasks(state,projectId,id);

CREATE TRIGGER immutable_scene_task_identity BEFORE UPDATE ON scene_tasks
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.kind IS NOT OLD.kind OR NEW.sourceAssetId IS NOT OLD.sourceAssetId
 OR NEW.requestId IS NOT OLD.requestId OR NEW.inputHash IS NOT OLD.inputHash OR NEW.input IS NOT OLD.input OR NEW.snapshot IS NOT OLD.snapshot OR NEW.createdAt IS NOT OLD.createdAt
 OR (OLD.resultId IS NOT NULL AND NEW.resultId IS NOT OLD.resultId) OR (OLD.stagedReceipt IS NOT NULL AND NEW.stagedReceipt IS NOT OLD.stagedReceipt)
 OR (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
 OR NEW.started<OLD.started OR (NEW.started IS NOT OLD.started AND NOT (OLD.state='queued' AND NEW.state='running' AND OLD.started=0 AND NEW.started=1))
 BEGIN SELECT RAISE(ABORT,'scene task identity and durable results are immutable');END;

CREATE TRIGGER scene_task_state_transitions BEFORE UPDATE ON scene_tasks
 WHEN NEW.revision IS NOT OLD.revision+1 OR NOT (
 (OLD.state='queued' AND NEW.state IN ('running','interrupted','cancelled_before_start','failed')) OR
 (OLD.state='running' AND NEW.state IN ('cancelling','persisting','succeeded','interrupted','local_result_error','failed')) OR
 (OLD.state='cancelling' AND NEW.state='cancelled') OR
 (OLD.state='persisting' AND NEW.state IN ('succeeded','interrupted','local_result_error')) OR
 (OLD.state='interrupted' AND OLD.started=0 AND OLD.stagedReceipt IS NULL AND NEW.state='cancelled_before_start') OR
 (OLD.state IN ('interrupted','local_result_error') AND OLD.started=1 AND OLD.stagedReceipt IS NOT NULL AND NEW.state='persisting') OR
 (OLD.state='succeeded' AND OLD.kind='shots' AND NEW.state='undone'))
 BEGIN SELECT RAISE(ABORT,'invalid scene task transition');END;

CREATE TRIGGER retain_scene_tasks BEFORE DELETE ON scene_tasks
 BEGIN SELECT RAISE(ABORT,'scene tasks must be retained');END;

CREATE TRIGGER reject_scene_task_replacement BEFORE INSERT ON scene_tasks
 WHEN EXISTS(SELECT 1 FROM scene_tasks WHERE id=NEW.id OR requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'scene tasks cannot be replaced');END;

CREATE TRIGGER scene_task_capacity BEFORE INSERT ON scene_tasks
 WHEN (SELECT COUNT(*) FROM scene_tasks)>=2048 OR (SELECT COUNT(*) FROM scene_tasks WHERE projectId=NEW.projectId)>=256
 BEGIN SELECT RAISE(ABORT,'scene retained task capacity exceeded');END;

CREATE TRIGGER scene_task_queue_capacity BEFORE INSERT ON scene_tasks
 WHEN (SELECT COUNT(*) FROM scene_tasks WHERE state='queued')>=8 OR (SELECT COUNT(*) FROM scene_tasks WHERE projectId=NEW.projectId AND state='queued')>=2
 BEGIN SELECT RAISE(ABORT,'scene queued task capacity exceeded');END;

CREATE TRIGGER scene_task_active_capacity BEFORE UPDATE OF state ON scene_tasks
 WHEN NEW.state IN ('running','cancelling','persisting') AND OLD.state NOT IN ('running','cancelling','persisting')
 AND EXISTS(SELECT 1 FROM scene_tasks WHERE state IN ('running','cancelling','persisting') AND id!=NEW.id)
 BEGIN SELECT RAISE(ABORT,'scene active task capacity exceeded');END;

CREATE TABLE subject_variant_batches(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),
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
 CHECK(json_extract(input,'$.projectId') IS projectId AND json_extract(input,'$.requestId') IS requestId AND json_extract(input,'$.subjectId') IS subjectId
 AND json_extract(input,'$.sourceVersionId') IS sourceVersionId AND json_extract(input,'$.kind') IS kind),
 CHECK(json_extract(snapshot,'$.schemaVersion') IS 1 AND json_extract(snapshot,'$.batchId') IS id AND json_extract(snapshot,'$.projectId') IS projectId
 AND json_extract(snapshot,'$.subjectId') IS subjectId AND json_extract(snapshot,'$.sourceVersionId') IS sourceVersionId AND json_extract(snapshot,'$.kind') IS kind
 AND json_type(snapshot,'$.items') IS 'array' AND json_array_length(snapshot,'$.items') BETWEEN 1 AND 8),
 CHECK(state!='active' OR revision>=1)
);

CREATE INDEX subject_variant_batches_subject_page ON subject_variant_batches(projectId,subjectId,createdAt DESC,id DESC);

CREATE INDEX subject_variant_batches_source ON subject_variant_batches(sourceVersionId);

CREATE TRIGGER immutable_subject_variant_batch_identity BEFORE UPDATE ON subject_variant_batches
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.subjectId IS NOT OLD.subjectId OR NEW.sourceVersionId IS NOT OLD.sourceVersionId
 OR NEW.kind IS NOT OLD.kind OR NEW.requestId IS NOT OLD.requestId OR NEW.inputHash IS NOT OLD.inputHash OR NEW.input IS NOT OLD.input
 OR NEW.snapshot IS NOT OLD.snapshot OR NEW.createdAt IS NOT OLD.createdAt OR NEW.revision IS NOT OLD.revision+1
 OR NOT (NEW.state IS OLD.state OR (OLD.state='active' AND NEW.state='undone'))
 BEGIN SELECT RAISE(ABORT,'subject variant batch identity is immutable and revisions must advance');END;

CREATE TRIGGER retain_subject_variant_batches BEFORE DELETE ON subject_variant_batches
 BEGIN SELECT RAISE(ABORT,'subject variant batches must be retained');END;

CREATE TRIGGER reject_subject_variant_batch_replacement BEFORE INSERT ON subject_variant_batches
 WHEN EXISTS(SELECT 1 FROM subject_variant_batches WHERE id=NEW.id OR requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'subject variant batches cannot be replaced');END;

CREATE TRIGGER subject_variant_batch_capacity BEFORE INSERT ON subject_variant_batches
 WHEN (SELECT COUNT(*) FROM subject_variant_batches)>=8192 OR (SELECT COUNT(*) FROM subject_variant_batches WHERE projectId=NEW.projectId)>=1024
 BEGIN SELECT RAISE(ABORT,'subject variant batch capacity exceeded');END;

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
 FOREIGN KEY(batchId,projectId) REFERENCES subject_variant_batches(id,projectId)
);

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

CREATE TRIGGER retain_subject_variant_items BEFORE DELETE ON subject_variant_items
 BEGIN SELECT RAISE(ABORT,'subject variant items must be retained');END;

CREATE TABLE task_dispositions(
    projectId TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('generation','render','edit')),
    taskId TEXT NOT NULL CHECK(length(CAST(taskId AS BLOB))=36),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
    markedFailedAt TEXT,archivedAt TEXT,sourceStatus TEXT NOT NULL CHECK(length(CAST(sourceStatus AS BLOB)) BETWEEN 1 AND 40),
    sourceRequestId TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,
    CHECK(markedFailedAt IS NOT NULL OR archivedAt IS NOT NULL),PRIMARY KEY(projectId,kind,taskId));

CREATE TRIGGER retain_task_disposition_replacement BEFORE INSERT ON task_dispositions
    WHEN EXISTS(SELECT 1 FROM task_dispositions WHERE rowid=NEW.rowid OR (projectId=NEW.projectId AND kind=NEW.kind AND taskId=NEW.taskId))
    BEGIN SELECT RAISE(ABORT,'task disposition history must not be replaced');END;

CREATE TRIGGER immutable_task_disposition_identity BEFORE UPDATE ON task_dispositions
    WHEN NEW.projectId IS NOT OLD.projectId OR NEW.kind IS NOT OLD.kind OR NEW.taskId IS NOT OLD.taskId OR NEW.createdAt IS NOT OLD.createdAt OR
      NEW.sourceRequestId IS NOT OLD.sourceRequestId OR NEW.revision!=OLD.revision+1 OR OLD.revision>=9007199254740991 OR
      (OLD.markedFailedAt IS NOT NULL AND NEW.markedFailedAt IS NOT OLD.markedFailedAt) OR (OLD.archivedAt IS NOT NULL AND NEW.archivedAt IS NOT OLD.archivedAt)
    BEGIN SELECT RAISE(ABORT,'task disposition identity and audit markers must be retained');END;

CREATE TRIGGER retain_task_dispositions BEFORE DELETE ON task_dispositions
    BEGIN SELECT RAISE(ABORT,'task disposition history must be retained');END;

CREATE TABLE mock_provider_tasks (
      provider_job_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, scenario TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, ready_at_ms INTEGER NOT NULL,
      poll_count INTEGER NOT NULL DEFAULT 0, download_attempts INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE mock_provider_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
      job_id TEXT, provider_job_id TEXT, created_at_ms INTEGER NOT NULL, outcome TEXT NOT NULL
    );

CREATE INDEX mock_provider_submissions_request ON mock_provider_submissions(request_id);

CREATE TABLE timeline_history(
 id TEXT PRIMARY KEY,projectId TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position>0),operation TEXT NOT NULL,createdAt TEXT NOT NULL,
 beforeSnapshot TEXT NOT NULL,afterSnapshot TEXT NOT NULL,UNIQUE(projectId,position));

CREATE TRIGGER immutable_timeline_history BEFORE UPDATE ON timeline_history
 BEGIN SELECT RAISE(ABORT,'timeline history entries are immutable');END;

CREATE TABLE timeline_history_cursors(
 projectId TEXT PRIMARY KEY,position INTEGER NOT NULL CHECK(position>=0));

CREATE TABLE mio_storage_counters(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 0 AND 9007199254740991),rows INTEGER NOT NULL CHECK(typeof(rows)='integer' AND rows BETWEEN 1 AND 9007199254740991));

CREATE TRIGGER mio_storage_counters_insert BEFORE INSERT ON mio_storage_counters WHEN EXISTS(SELECT 1 FROM mio_storage_counters) BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT');END;

CREATE TRIGGER mio_storage_counters_delete BEFORE DELETE ON mio_storage_counters BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT');END;

CREATE TRIGGER mio_storage_counters_identity BEFORE UPDATE OF singleton ON mio_storage_counters WHEN NEW.singleton IS NOT OLD.singleton BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT');END;

CREATE TABLE mio_blobs(sha256 TEXT NOT NULL CHECK((length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*')),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 0 AND 9007199254740991),content TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(sha256),CHECK(bytes=length(CAST(content AS BLOB)) AND bytes<=2097152));

CREATE TABLE mio_conversations(id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 200),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(projectId,id));

CREATE INDEX mio_conversations_page ON mio_conversations(projectId,updatedAt,id);

CREATE TABLE mio_runs(id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 200),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),conversationId TEXT NOT NULL,requestId TEXT NOT NULL UNIQUE,digest TEXT NOT NULL CHECK((length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*')),status TEXT NOT NULL CHECK(status IN ('accepted','running','paused','awaiting_approval','completed','failed','stopped','interrupted','reverted','awaiting_answer')),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),stepLimit INTEGER NOT NULL CHECK(typeof(stepLimit)='integer' AND stepLimit BETWEEN 1 AND 9007199254740991),budget INTEGER NOT NULL CHECK(typeof(budget)='integer' AND budget BETWEEN 1 AND 9007199254740991),stepsUsed INTEGER NOT NULL CHECK(typeof(stepsUsed)='integer' AND stepsUsed BETWEEN 0 AND 9007199254740991),locale TEXT NOT NULL CHECK(locale IN ('zh-Hans','zh-Hant','en','ja')),configurationBlobHash TEXT CHECK(configurationBlobHash IS NULL OR (length(configurationBlobHash)=64 AND configurationBlobHash NOT GLOB '*[^a-f0-9]*')) REFERENCES mio_blobs(sha256),settingsRevision INTEGER CHECK(settingsRevision IS NULL OR (typeof(settingsRevision)='integer' AND settingsRevision BETWEEN 0 AND 9007199254740991)),rulesSnapshotHash TEXT CHECK(rulesSnapshotHash IS NULL OR (length(rulesSnapshotHash)=64 AND rulesSnapshotHash NOT GLOB '*[^a-f0-9]*')) REFERENCES mio_blobs(sha256),usageSummary TEXT CHECK(usageSummary IS NULL OR (json_valid(usageSummary) AND length(CAST(usageSummary AS BLOB))<=2097152)),createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(projectId,id),UNIQUE(projectId,conversationId,id),FOREIGN KEY(projectId,conversationId) REFERENCES mio_conversations(projectId,id),CHECK(stepsUsed<=budget));

CREATE INDEX mio_runs_conversation ON mio_runs(conversationId,createdAt,id);

CREATE INDEX mio_runs_status ON mio_runs(projectId,status);

CREATE TABLE mio_entries(id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 200),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),conversationId TEXT NOT NULL,runId TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),kind TEXT NOT NULL CHECK(kind IN ('user_message','note','model_output','tool_result','answer','host_state','host_hint','compaction','repair','model_summary','request_reassembled','partial_output','rules_snapshot')),payloadJson TEXT CHECK(payloadJson IS NULL OR (json_valid(payloadJson) AND length(CAST(payloadJson AS BLOB))<=2097152)),payloadBlobHash TEXT CHECK(payloadBlobHash IS NULL OR (length(payloadBlobHash)=64 AND payloadBlobHash NOT GLOB '*[^a-f0-9]*')) REFERENCES mio_blobs(sha256),createdAt TEXT NOT NULL,UNIQUE(runId,sequence),UNIQUE(runId,id),FOREIGN KEY(projectId,conversationId,runId) REFERENCES mio_runs(projectId,conversationId,id),CHECK((payloadJson IS NULL)!=(payloadBlobHash IS NULL)));

CREATE INDEX mio_entries_conversation ON mio_entries(conversationId,runId,sequence);

CREATE TABLE mio_steps(id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 200),runId TEXT NOT NULL,projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 1 AND 9007199254740991),kind TEXT NOT NULL CHECK(kind IN ('model','tool','wait')),status TEXT NOT NULL CHECK(status IN ('intent','awaiting_approval','dispatch_started','completed','denied','rejected','failed','unknown','awaiting_answer')),tier TEXT CHECK(tier IS NULL OR tier IN ('read_only','local_reversible','local_irreversible','paid')),createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,currentRequestId TEXT,sourceEntryId TEXT,sourceCallIndex INTEGER CHECK(sourceCallIndex IS NULL OR (typeof(sourceCallIndex)='integer' AND sourceCallIndex BETWEEN 0 AND 29)),resultEntryId TEXT,partialText TEXT CHECK(partialText IS NULL OR length(CAST(partialText AS BLOB))<=2097152),data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=2097152),UNIQUE(runId,position),UNIQUE(projectId,runId,id),FOREIGN KEY(projectId,runId) REFERENCES mio_runs(projectId,id),FOREIGN KEY(runId,sourceEntryId) REFERENCES mio_entries(runId,id),FOREIGN KEY(runId,resultEntryId) REFERENCES mio_entries(runId,id),FOREIGN KEY(id,currentRequestId) REFERENCES mio_requests(stepId,id),CHECK((sourceEntryId IS NULL)=(sourceCallIndex IS NULL)));

CREATE TABLE mio_requests(id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 200),stepId TEXT NOT NULL REFERENCES mio_steps(id),assemblyNumber INTEGER NOT NULL CHECK(typeof(assemblyNumber)='integer' AND assemblyNumber BETWEEN 1 AND 9007199254740991),assemblerVersion INTEGER NOT NULL CHECK(typeof(assemblerVersion)='integer' AND assemblerVersion BETWEEN 1 AND 9007199254740991),protocol TEXT NOT NULL CHECK(protocol IN ('chat_completions','responses','anthropic_messages')),bodySha256 TEXT NOT NULL CHECK((length(bodySha256)=64 AND bodySha256 NOT GLOB '*[^a-f0-9]*')),bodyBytes INTEGER NOT NULL CHECK(typeof(bodyBytes)='integer' AND bodyBytes BETWEEN 1 AND 9007199254740991),state TEXT NOT NULL CHECK(state IN ('intent','dispatch_started','completed','failed','unknown','superseded')),originalBody TEXT CHECK(originalBody IS NULL OR length(CAST(originalBody AS BLOB))=bodyBytes),inputManifest TEXT NOT NULL CHECK(json_valid(inputManifest) AND length(CAST(inputManifest AS BLOB)) BETWEEN 1 AND 2097152),firstEntry TEXT REFERENCES mio_entries(id),lastEntry TEXT REFERENCES mio_entries(id),assembledAt TEXT NOT NULL,dispatchStartedAt TEXT,completedAt TEXT,previousRequestId TEXT,assemblyReason TEXT NOT NULL,UNIQUE(stepId,assemblyNumber),UNIQUE(stepId,id),FOREIGN KEY(stepId,previousRequestId) REFERENCES mio_requests(stepId,id),CHECK(bodyBytes<=524288));

CREATE INDEX mio_requests_pending ON mio_requests(state,stepId);

CREATE TABLE mio_changes(id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 200),runId TEXT NOT NULL,stepId TEXT NOT NULL,projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB)) BETWEEN 1 AND 2097152),FOREIGN KEY(projectId,runId) REFERENCES mio_runs(projectId,id),FOREIGN KEY(projectId,runId,stepId) REFERENCES mio_steps(projectId,runId,id));

CREATE INDEX mio_changes_run ON mio_changes(runId,id);

CREATE TABLE mio_controls(requestId TEXT PRIMARY KEY NOT NULL,runId TEXT NOT NULL,projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),digest TEXT NOT NULL CHECK((length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*')),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB)) BETWEEN 1 AND 2097152),UNIQUE(projectId,runId,requestId),FOREIGN KEY(projectId,runId) REFERENCES mio_runs(projectId,id));

CREATE TABLE mio_control_states(requestId TEXT PRIMARY KEY NOT NULL,runId TEXT NOT NULL,projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB)) BETWEEN 1 AND 2097152),FOREIGN KEY(projectId,runId,requestId) REFERENCES mio_controls(projectId,runId,requestId));

CREATE TABLE mio_imports(id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 200),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),requestId TEXT NOT NULL UNIQUE,name TEXT NOT NULL CHECK(length(CAST(name AS BLOB))<=800),mimeType TEXT NOT NULL CHECK(length(mimeType) BETWEEN 1 AND 200),relativePath TEXT NOT NULL CHECK(length(CAST(relativePath AS BLOB))<=512),sha256 TEXT NOT NULL CHECK((length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*')),status TEXT NOT NULL CHECK(length(status) BETWEEN 1 AND 100),assetId TEXT,resourceId TEXT,createdAt TEXT NOT NULL);

CREATE TABLE mio_job_origins(kind TEXT NOT NULL CHECK(kind IN ('job','export','image','frame','scene')),jobId TEXT NOT NULL,runId TEXT NOT NULL,stepId TEXT NOT NULL,projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),requestId TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(kind,jobId),FOREIGN KEY(projectId,runId) REFERENCES mio_runs(projectId,id),FOREIGN KEY(projectId,runId,stepId) REFERENCES mio_steps(projectId,runId,id));

CREATE TABLE mio_edit_claims(id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 200),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),ownerId TEXT NOT NULL,kind TEXT NOT NULL,targetId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),state TEXT NOT NULL CHECK(state IN ('active','uncertain')),createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(projectId,ownerId,kind,targetId));

CREATE INDEX mio_edit_claims_target ON mio_edit_claims(kind,targetId);

CREATE TABLE mio_edit_owners(ownerId TEXT NOT NULL,projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 0 AND 9007199254740991),PRIMARY KEY(projectId,ownerId));

CREATE TABLE mio_edit_receipts(requestId TEXT PRIMARY KEY NOT NULL,projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),ownerId TEXT NOT NULL,digest TEXT NOT NULL CHECK((length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*')),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB)) BETWEEN 1 AND 65536));

CREATE TABLE mio_conversation_policies(conversationId TEXT PRIMARY KEY NOT NULL,projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4096),UNIQUE(projectId,conversationId),FOREIGN KEY(projectId,conversationId) REFERENCES mio_conversations(projectId,id));

CREATE INDEX mio_conversation_policies_project ON mio_conversation_policies(projectId);

CREATE TABLE mio_conversation_policy_requests(requestId TEXT PRIMARY KEY NOT NULL,projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),conversationId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),inputHash TEXT NOT NULL CHECK((length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*')),response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB)) BETWEEN 1 AND 8192),UNIQUE(conversationId,revision),FOREIGN KEY(projectId,conversationId) REFERENCES mio_conversations(projectId,id));

CREATE INDEX mio_policy_requests_project ON mio_conversation_policy_requests(projectId,conversationId);

CREATE TABLE mio_events(runId TEXT NOT NULL REFERENCES mio_runs(id),sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),createdAt TEXT NOT NULL,PRIMARY KEY(runId,sequence));

CREATE TABLE mio_process_target_revisions(projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),kind TEXT NOT NULL CHECK(kind IN ('job','export','image_task','frame_task')),targetId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),PRIMARY KEY(projectId,kind,targetId));

CREATE TABLE mio_rule_writes(requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),actor TEXT NOT NULL CHECK(actor IN ('manual','mio')),runId TEXT,stepId TEXT,digest TEXT NOT NULL CHECK((length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*')),approvalReceiptId TEXT,expectedExists INTEGER NOT NULL CHECK(typeof(expectedExists)='integer' AND expectedExists IN (0,1)),beforeHash TEXT CHECK(beforeHash IS NULL OR (length(beforeHash)=64 AND beforeHash NOT GLOB '*[^a-f0-9]*')),afterHash TEXT NOT NULL CHECK((length(afterHash)=64 AND afterHash NOT GLOB '*[^a-f0-9]*')),beforeBlobHash TEXT CHECK(beforeBlobHash IS NULL OR (length(beforeBlobHash)=64 AND beforeBlobHash NOT GLOB '*[^a-f0-9]*')) REFERENCES mio_blobs(sha256),afterBlobHash TEXT NOT NULL CHECK((length(afterBlobHash)=64 AND afterBlobHash NOT GLOB '*[^a-f0-9]*')) REFERENCES mio_blobs(sha256),fixedRelativeName TEXT NOT NULL CHECK(fixedRelativeName='AGENTS.md'),fileIdentity TEXT CHECK(fileIdentity IS NULL OR (json_valid(fileIdentity) AND length(CAST(fileIdentity AS BLOB))<=16384)),state TEXT NOT NULL CHECK(state IN ('prepared','publication_unknown','published','trust_pending','completed','not_applied')),createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,FOREIGN KEY(projectId,runId) REFERENCES mio_runs(projectId,id),FOREIGN KEY(projectId,runId,stepId) REFERENCES mio_steps(projectId,runId,id),FOREIGN KEY(projectId,runId,approvalReceiptId) REFERENCES mio_controls(projectId,runId,requestId),CHECK((actor='manual' AND runId IS NULL AND stepId IS NULL AND approvalReceiptId IS NULL) OR (actor='mio' AND runId IS NOT NULL AND stepId IS NOT NULL AND approvalReceiptId IS NOT NULL)),CHECK((expectedExists=1 AND beforeHash IS NOT NULL AND beforeBlobHash IS beforeHash) OR (expectedExists=0 AND beforeHash IS NULL AND beforeBlobHash IS NULL)),CHECK(afterBlobHash IS afterHash),CHECK(fileIdentity IS NULL OR (json_extract(fileIdentity,'$.version') IS 1 AND json_extract(fileIdentity,'$.fixedRelativeName') IS fixedRelativeName AND json_extract(fileIdentity,'$.expectedExists') IS expectedExists AND json_extract(fileIdentity,'$.beforeHash') IS beforeHash AND json_extract(fileIdentity,'$.afterHash') IS afterHash)),CHECK(state NOT IN ('published','trust_pending','completed') OR (fileIdentity IS NOT NULL AND json_type(fileIdentity,'$.candidateIdentity') IS 'object' AND json_type(fileIdentity,'$.publishedIdentity') IS 'object' AND json_extract(fileIdentity,'$.phase') IN ('published','before_cleanup','completed'))));

CREATE INDEX mio_rule_writes_pending ON mio_rule_writes(projectId,state,createdAt,requestId);

CREATE TRIGGER retain_mio_rule_writes BEFORE DELETE ON mio_rule_writes BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER identity_mio_rule_writes BEFORE UPDATE ON mio_rule_writes WHEN NEW.requestId IS NOT OLD.requestId OR NEW.projectId IS NOT OLD.projectId OR NEW.actor IS NOT OLD.actor OR NEW.runId IS NOT OLD.runId OR NEW.stepId IS NOT OLD.stepId OR NEW.digest IS NOT OLD.digest OR NEW.approvalReceiptId IS NOT OLD.approvalReceiptId OR NEW.expectedExists IS NOT OLD.expectedExists OR NEW.beforeHash IS NOT OLD.beforeHash OR NEW.afterHash IS NOT OLD.afterHash OR NEW.beforeBlobHash IS NOT OLD.beforeBlobHash OR NEW.afterBlobHash IS NOT OLD.afterBlobHash OR NEW.fixedRelativeName IS NOT OLD.fixedRelativeName OR NEW.createdAt IS NOT OLD.createdAt BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER mio_rule_write_insert BEFORE INSERT ON mio_rule_writes WHEN NEW.state!='prepared' OR (NEW.actor='mio' AND NOT EXISTS(SELECT 1 FROM mio_steps WHERE projectId=NEW.projectId AND runId=NEW.runId AND id=NEW.stepId AND kind='tool')) BEGIN SELECT RAISE(ABORT,'Mio rule write must start with a bound prepared intent');END;

CREATE TRIGGER mio_rule_write_terminal BEFORE UPDATE ON mio_rule_writes WHEN OLD.state IN ('completed','not_applied') BEGIN SELECT RAISE(ABORT,'Mio rule write receipt is immutable');END;

CREATE TRIGGER mio_rule_write_state BEFORE UPDATE ON mio_rule_writes WHEN NEW.state IS NOT OLD.state AND NOT ((OLD.state='prepared' AND NEW.state IN ('publication_unknown','published','not_applied')) OR (OLD.state='publication_unknown' AND NEW.state IN ('published','not_applied')) OR (OLD.state='published' AND NEW.state IN ('trust_pending','completed')) OR (OLD.state='trust_pending' AND NEW.state='completed')) BEGIN SELECT RAISE(ABORT,'Mio rule write state cannot be replayed');END;

CREATE TRIGGER immutable_mio_blobs BEFORE UPDATE ON mio_blobs BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER retain_mio_blobs BEFORE DELETE ON mio_blobs BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER immutable_mio_entries BEFORE UPDATE ON mio_entries BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER retain_mio_entries BEFORE DELETE ON mio_entries BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER immutable_mio_controls BEFORE UPDATE ON mio_controls BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER retain_mio_controls BEFORE DELETE ON mio_controls BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER immutable_mio_job_origins BEFORE UPDATE ON mio_job_origins BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER retain_mio_job_origins BEFORE DELETE ON mio_job_origins BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER immutable_mio_edit_receipts BEFORE UPDATE ON mio_edit_receipts BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER retain_mio_edit_receipts BEFORE DELETE ON mio_edit_receipts BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER immutable_mio_conversation_policy_requests BEFORE UPDATE ON mio_conversation_policy_requests BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER retain_mio_conversation_policy_requests BEFORE DELETE ON mio_conversation_policy_requests BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER immutable_mio_events BEFORE UPDATE ON mio_events BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER retain_mio_events BEFORE DELETE ON mio_events BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER retain_mio_conversations BEFORE DELETE ON mio_conversations BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER retain_mio_runs BEFORE DELETE ON mio_runs BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER retain_mio_steps BEFORE DELETE ON mio_steps BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER retain_mio_requests BEFORE DELETE ON mio_requests BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER retain_mio_changes BEFORE DELETE ON mio_changes BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER retain_mio_control_states BEFORE DELETE ON mio_control_states BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER retain_mio_imports BEFORE DELETE ON mio_imports BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER retain_mio_conversation_policies BEFORE DELETE ON mio_conversation_policies BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER retain_mio_process_target_revisions BEFORE DELETE ON mio_process_target_revisions BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END;

CREATE TRIGGER identity_mio_conversations BEFORE UPDATE ON mio_conversations WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.createdAt IS NOT OLD.createdAt BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER identity_mio_runs BEFORE UPDATE ON mio_runs WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.conversationId IS NOT OLD.conversationId OR NEW.requestId IS NOT OLD.requestId OR NEW.digest IS NOT OLD.digest OR NEW.locale IS NOT OLD.locale OR NEW.configurationBlobHash IS NOT OLD.configurationBlobHash OR NEW.settingsRevision IS NOT OLD.settingsRevision OR NEW.rulesSnapshotHash IS NOT OLD.rulesSnapshotHash OR NEW.createdAt IS NOT OLD.createdAt BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER identity_mio_steps BEFORE UPDATE ON mio_steps WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.runId IS NOT OLD.runId OR NEW.position IS NOT OLD.position OR NEW.kind IS NOT OLD.kind OR NEW.sourceEntryId IS NOT OLD.sourceEntryId OR NEW.sourceCallIndex IS NOT OLD.sourceCallIndex OR NEW.createdAt IS NOT OLD.createdAt BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER identity_mio_changes BEFORE UPDATE ON mio_changes WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.runId IS NOT OLD.runId OR NEW.stepId IS NOT OLD.stepId BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER identity_mio_control_states BEFORE UPDATE ON mio_control_states WHEN NEW.requestId IS NOT OLD.requestId OR NEW.projectId IS NOT OLD.projectId OR NEW.runId IS NOT OLD.runId BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER identity_mio_imports BEFORE UPDATE ON mio_imports WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.requestId IS NOT OLD.requestId OR NEW.name IS NOT OLD.name OR NEW.mimeType IS NOT OLD.mimeType OR NEW.relativePath IS NOT OLD.relativePath OR NEW.sha256 IS NOT OLD.sha256 OR NEW.createdAt IS NOT OLD.createdAt BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER identity_mio_conversation_policies BEFORE UPDATE ON mio_conversation_policies WHEN NEW.conversationId IS NOT OLD.conversationId OR NEW.projectId IS NOT OLD.projectId BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER identity_mio_requests BEFORE UPDATE ON mio_requests WHEN NEW.id IS NOT OLD.id OR NEW.stepId IS NOT OLD.stepId OR NEW.assemblyNumber IS NOT OLD.assemblyNumber OR NEW.assemblerVersion IS NOT OLD.assemblerVersion OR NEW.protocol IS NOT OLD.protocol OR NEW.bodySha256 IS NOT OLD.bodySha256 OR NEW.bodyBytes IS NOT OLD.bodyBytes OR NEW.inputManifest IS NOT OLD.inputManifest OR NEW.firstEntry IS NOT OLD.firstEntry OR NEW.lastEntry IS NOT OLD.lastEntry OR NEW.assembledAt IS NOT OLD.assembledAt OR NEW.previousRequestId IS NOT OLD.previousRequestId OR NEW.assemblyReason IS NOT OLD.assemblyReason BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END;

CREATE TRIGGER mio_step_source BEFORE INSERT ON mio_steps WHEN NEW.sourceEntryId IS NOT NULL AND (NEW.kind!='tool' OR NOT EXISTS(SELECT 1 FROM mio_entries WHERE id=NEW.sourceEntryId AND runId=NEW.runId AND kind='model_output')) BEGIN SELECT RAISE(ABORT,'Mio tool source must be its model output');END;

CREATE TRIGGER mio_runs_revision BEFORE UPDATE ON mio_runs WHEN NEW.revision<OLD.revision OR NEW.stepsUsed<OLD.stepsUsed BEGIN SELECT RAISE(ABORT,'Mio run counters cannot decrease');END;

CREATE TRIGGER mio_policy_revision BEFORE UPDATE ON mio_conversation_policies WHEN NEW.revision<=OLD.revision BEGIN SELECT RAISE(ABORT,'Mio conversation policy revisions only advance');END;

CREATE TRIGGER mio_policy_receipt_revision BEFORE INSERT ON mio_conversation_policy_requests WHEN NOT EXISTS(SELECT 1 FROM mio_conversation_policies WHERE projectId=NEW.projectId AND conversationId=NEW.conversationId AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT,'Mio policy receipt must bind its saved revision');END;

CREATE TRIGGER mio_request_insert BEFORE INSERT ON mio_requests WHEN NEW.state!='intent' OR NEW.originalBody IS NULL OR NOT EXISTS(SELECT 1 FROM mio_steps WHERE id=NEW.stepId AND kind='model') BEGIN SELECT RAISE(ABORT,'Mio request must start as an unsent model intent');END;

CREATE TRIGGER mio_request_body BEFORE UPDATE OF originalBody ON mio_requests WHEN NEW.originalBody IS NOT OLD.originalBody AND NOT (OLD.originalBody IS NOT NULL AND NEW.originalBody IS NULL AND EXISTS(SELECT 1 FROM mio_steps s WHERE s.id=NEW.stepId AND s.status='completed' AND ((NEW.state='completed' AND s.currentRequestId=NEW.id) OR (OLD.state='superseded' AND EXISTS(SELECT 1 FROM mio_requests r WHERE r.id=s.currentRequestId AND r.state='completed'))))) BEGIN SELECT RAISE(ABORT,'Mio request body can only be cleared after durable completion');END;

CREATE TRIGGER mio_request_dispatch BEFORE UPDATE ON mio_requests WHEN OLD.dispatchStartedAt IS NOT NULL AND NEW.dispatchStartedAt IS NOT OLD.dispatchStartedAt BEGIN SELECT RAISE(ABORT,'Mio dispatch evidence is immutable');END;

CREATE TRIGGER mio_request_state BEFORE UPDATE ON mio_requests WHEN OLD.state IS NOT NEW.state AND NOT ((OLD.state='intent' AND NEW.state IN ('dispatch_started','failed','superseded')) OR (OLD.state='dispatch_started' AND NEW.state IN ('completed','failed','unknown'))) BEGIN SELECT RAISE(ABORT,'Mio request state cannot be replayed');END;

CREATE TRIGGER mio_request_sent BEFORE UPDATE ON mio_requests WHEN (NEW.state IN ('dispatch_started','completed','unknown') AND NEW.dispatchStartedAt IS NULL) OR (NEW.state='superseded' AND NEW.dispatchStartedAt IS NOT NULL) OR (NEW.state='completed' AND (NEW.completedAt IS NULL OR NOT EXISTS(SELECT 1 FROM mio_steps WHERE id=NEW.stepId AND status='completed' AND currentRequestId=NEW.id))) BEGIN SELECT RAISE(ABORT,'Mio request must retain its dispatch and completion evidence');END;

CREATE TRIGGER mio_process_revision BEFORE UPDATE ON mio_process_target_revisions WHEN NEW.projectId IS NOT OLD.projectId OR NEW.kind IS NOT OLD.kind OR NEW.targetId IS NOT OLD.targetId OR NEW.revision<=OLD.revision BEGIN SELECT RAISE(ABORT,'Mio process revisions only advance');END;

CREATE TRIGGER project_mio_conversations_insert BEFORE INSERT ON mio_conversations WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_conversations_update BEFORE UPDATE ON mio_conversations WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_runs_insert BEFORE INSERT ON mio_runs WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_runs_update BEFORE UPDATE ON mio_runs WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_entries_insert BEFORE INSERT ON mio_entries WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_entries_update BEFORE UPDATE ON mio_entries WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_steps_insert BEFORE INSERT ON mio_steps WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_steps_update BEFORE UPDATE ON mio_steps WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_changes_insert BEFORE INSERT ON mio_changes WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_changes_update BEFORE UPDATE ON mio_changes WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_controls_insert BEFORE INSERT ON mio_controls WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_controls_update BEFORE UPDATE ON mio_controls WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_control_states_insert BEFORE INSERT ON mio_control_states WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_control_states_update BEFORE UPDATE ON mio_control_states WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_imports_insert BEFORE INSERT ON mio_imports WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_imports_update BEFORE UPDATE ON mio_imports WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_job_origins_insert BEFORE INSERT ON mio_job_origins WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_job_origins_update BEFORE UPDATE ON mio_job_origins WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_edit_claims_insert BEFORE INSERT ON mio_edit_claims WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_edit_claims_update BEFORE UPDATE ON mio_edit_claims WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_edit_owners_insert BEFORE INSERT ON mio_edit_owners WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_edit_owners_update BEFORE UPDATE ON mio_edit_owners WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_edit_receipts_insert BEFORE INSERT ON mio_edit_receipts WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_edit_receipts_update BEFORE UPDATE ON mio_edit_receipts WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_conversation_policies_insert BEFORE INSERT ON mio_conversation_policies WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_conversation_policies_update BEFORE UPDATE ON mio_conversation_policies WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_conversation_policy_requests_insert BEFORE INSERT ON mio_conversation_policy_requests WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_conversation_policy_requests_update BEFORE UPDATE ON mio_conversation_policy_requests WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_process_target_revisions_insert BEFORE INSERT ON mio_process_target_revisions WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_process_target_revisions_update BEFORE UPDATE ON mio_process_target_revisions WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_rule_writes_insert BEFORE INSERT ON mio_rule_writes WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER project_mio_rule_writes_update BEFORE UPDATE ON mio_rule_writes WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END;

CREATE TRIGGER agent_target_jobs_insert_v2 AFTER INSERT ON jobs BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(NEW.projectId,'job',NEW.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_jobs_update_v2 AFTER UPDATE ON jobs WHEN (NEW."id" IS NOT OLD."id" OR NEW."projectId" IS NOT OLD."projectId" OR NEW."data" IS NOT OLD."data") BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(NEW.projectId,'job',NEW.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_jobs_delete_v2 AFTER DELETE ON jobs BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(OLD.projectId,'job',OLD.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_exports_insert_v2 AFTER INSERT ON exports BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(NEW.projectId,'export',NEW.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_exports_update_v2 AFTER UPDATE ON exports WHEN (NEW."id" IS NOT OLD."id" OR NEW."projectId" IS NOT OLD."projectId" OR NEW."data" IS NOT OLD."data") BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(NEW.projectId,'export',NEW.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_exports_delete_v2 AFTER DELETE ON exports BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(OLD.projectId,'export',OLD.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_image_tasks_insert_v2 AFTER INSERT ON image_tasks BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(NEW.projectId,'image_task',NEW.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_image_tasks_update_v2 AFTER UPDATE ON image_tasks WHEN (NEW."id" IS NOT OLD."id" OR NEW."projectId" IS NOT OLD."projectId" OR NEW."groupId" IS NOT OLD."groupId" OR NEW."requestId" IS NOT OLD."requestId" OR NEW."inputHash" IS NOT OLD."inputHash" OR NEW."input" IS NOT OLD."input" OR NEW."snapshot" IS NOT OLD."snapshot" OR NEW."state" IS NOT OLD."state" OR NEW."revision" IS NOT OLD."revision" OR NEW."dispatched" IS NOT OLD."dispatched" OR NEW."stagedReceipt" IS NOT OLD."stagedReceipt" OR NEW."versionId" IS NOT OLD."versionId" OR NEW."errorCode" IS NOT OLD."errorCode" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."updatedAt" IS NOT OLD."updatedAt") BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(NEW.projectId,'image_task',NEW.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_image_tasks_delete_v2 AFTER DELETE ON image_tasks BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(OLD.projectId,'image_task',OLD.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_frame_tasks_insert_v2 AFTER INSERT ON frame_tasks BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(NEW.projectId,'frame_task',NEW.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_frame_tasks_update_v2 AFTER UPDATE ON frame_tasks WHEN (NEW."id" IS NOT OLD."id" OR NEW."projectId" IS NOT OLD."projectId" OR NEW."requestId" IS NOT OLD."requestId" OR NEW."inputHash" IS NOT OLD."inputHash" OR NEW."input" IS NOT OLD."input" OR NEW."snapshot" IS NOT OLD."snapshot" OR NEW."state" IS NOT OLD."state" OR NEW."revision" IS NOT OLD."revision" OR NEW."started" IS NOT OLD."started" OR NEW."stagedReceipt" IS NOT OLD."stagedReceipt" OR NEW."assetId" IS NOT OLD."assetId" OR NEW."errorCode" IS NOT OLD."errorCode" OR NEW."createdAt" IS NOT OLD."createdAt" OR NEW."updatedAt" IS NOT OLD."updatedAt") BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(NEW.projectId,'frame_task',NEW.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER agent_target_frame_tasks_delete_v2 AFTER DELETE ON frame_tasks BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(OLD.projectId,'frame_task',OLD.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;

CREATE TRIGGER row_mio_conversations_insert BEFORE INSERT ON mio_conversations WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_conversations_update BEFORE UPDATE ON mio_conversations WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_runs_insert BEFORE INSERT ON mio_runs WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.locale AS BLOB)),0)+COALESCE(length(CAST(NEW.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(NEW.usageSummary AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_runs_update BEFORE UPDATE ON mio_runs WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.locale AS BLOB)),0)+COALESCE(length(CAST(NEW.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(NEW.usageSummary AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_entries_insert BEFORE INSERT ON mio_entries WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadJson AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_entries_update BEFORE UPDATE ON mio_entries WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadJson AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_blobs_insert BEFORE INSERT ON mio_blobs WHEN COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.content AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_blobs_update BEFORE UPDATE ON mio_blobs WHEN COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.content AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_steps_insert BEFORE INSERT ON mio_steps WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.tier AS BLOB)),0)+COALESCE(length(CAST(NEW.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.partialText AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_steps_update BEFORE UPDATE ON mio_steps WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.tier AS BLOB)),0)+COALESCE(length(CAST(NEW.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.partialText AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_requests_insert BEFORE INSERT ON mio_requests WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.protocol AS BLOB)),0)+COALESCE(length(CAST(NEW.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.originalBody AS BLOB)),0)+COALESCE(length(CAST(NEW.inputManifest AS BLOB)),0)+COALESCE(length(CAST(NEW.firstEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.lastEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.assembledAt AS BLOB)),0)+COALESCE(length(CAST(NEW.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.completedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.assemblyReason AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_requests_update BEFORE UPDATE ON mio_requests WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.protocol AS BLOB)),0)+COALESCE(length(CAST(NEW.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.originalBody AS BLOB)),0)+COALESCE(length(CAST(NEW.inputManifest AS BLOB)),0)+COALESCE(length(CAST(NEW.firstEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.lastEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.assembledAt AS BLOB)),0)+COALESCE(length(CAST(NEW.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.completedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.assemblyReason AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_changes_insert BEFORE INSERT ON mio_changes WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_changes_update BEFORE UPDATE ON mio_changes WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_controls_insert BEFORE INSERT ON mio_controls WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_controls_update BEFORE UPDATE ON mio_controls WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_control_states_insert BEFORE INSERT ON mio_control_states WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_control_states_update BEFORE UPDATE ON mio_control_states WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_imports_insert BEFORE INSERT ON mio_imports WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.name AS BLOB)),0)+COALESCE(length(CAST(NEW.mimeType AS BLOB)),0)+COALESCE(length(CAST(NEW.relativePath AS BLOB)),0)+COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.assetId AS BLOB)),0)+COALESCE(length(CAST(NEW.resourceId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_imports_update BEFORE UPDATE ON mio_imports WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.name AS BLOB)),0)+COALESCE(length(CAST(NEW.mimeType AS BLOB)),0)+COALESCE(length(CAST(NEW.relativePath AS BLOB)),0)+COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.assetId AS BLOB)),0)+COALESCE(length(CAST(NEW.resourceId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_job_origins_insert BEFORE INSERT ON mio_job_origins WHEN COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.jobId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.operation AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_job_origins_update BEFORE UPDATE ON mio_job_origins WHEN COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.jobId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.operation AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_edit_claims_insert BEFORE INSERT ON mio_edit_claims WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_edit_claims_update BEFORE UPDATE ON mio_edit_claims WHEN COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_edit_owners_insert BEFORE INSERT ON mio_edit_owners WHEN COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_edit_owners_update BEFORE UPDATE ON mio_edit_owners WHEN COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_edit_receipts_insert BEFORE INSERT ON mio_edit_receipts WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_edit_receipts_update BEFORE UPDATE ON mio_edit_receipts WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_conversation_policies_insert BEFORE INSERT ON mio_conversation_policies WHEN COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_conversation_policies_update BEFORE UPDATE ON mio_conversation_policies WHEN COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_conversation_policy_requests_insert BEFORE INSERT ON mio_conversation_policy_requests WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.inputHash AS BLOB)),0)+COALESCE(length(CAST(NEW.response AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_conversation_policy_requests_update BEFORE UPDATE ON mio_conversation_policy_requests WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.inputHash AS BLOB)),0)+COALESCE(length(CAST(NEW.response AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_events_insert BEFORE INSERT ON mio_events WHEN COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_events_update BEFORE UPDATE ON mio_events WHEN COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_process_target_revisions_insert BEFORE INSERT ON mio_process_target_revisions WHEN COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_process_target_revisions_update BEFORE UPDATE ON mio_process_target_revisions WHEN COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_rule_writes_insert BEFORE INSERT ON mio_rule_writes WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.actor AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterHash AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(NEW.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER row_mio_rule_writes_update BEFORE UPDATE ON mio_rule_writes WHEN COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.actor AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterHash AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(NEW.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0)>2097152 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;

CREATE TRIGGER quota_mio_conversations_insert AFTER INSERT ON mio_conversations BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_conversations_update AFTER UPDATE ON mio_conversations BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_conversations_delete AFTER DELETE ON mio_conversations BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_runs_insert AFTER INSERT ON mio_runs BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.locale AS BLOB)),0)+COALESCE(length(CAST(NEW.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(NEW.usageSummary AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.locale AS BLOB)),0)+COALESCE(length(CAST(NEW.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(NEW.usageSummary AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_runs_update AFTER UPDATE ON mio_runs BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.locale AS BLOB)),0)+COALESCE(length(CAST(NEW.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(NEW.usageSummary AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.locale AS BLOB)),0)+COALESCE(length(CAST(OLD.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(OLD.usageSummary AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.locale AS BLOB)),0)+COALESCE(length(CAST(NEW.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(NEW.usageSummary AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.locale AS BLOB)),0)+COALESCE(length(CAST(OLD.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(OLD.usageSummary AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_runs_delete AFTER DELETE ON mio_runs BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.locale AS BLOB)),0)+COALESCE(length(CAST(OLD.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(OLD.usageSummary AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.locale AS BLOB)),0)+COALESCE(length(CAST(OLD.configurationBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.rulesSnapshotHash AS BLOB)),0)+COALESCE(length(CAST(OLD.usageSummary AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_entries_insert AFTER INSERT ON mio_entries BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadJson AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadJson AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_entries_update AFTER UPDATE ON mio_entries BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadJson AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.payloadJson AS BLOB)),0)+COALESCE(length(CAST(OLD.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadJson AS BLOB)),0)+COALESCE(length(CAST(NEW.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.payloadJson AS BLOB)),0)+COALESCE(length(CAST(OLD.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_entries_delete AFTER DELETE ON mio_entries BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.payloadJson AS BLOB)),0)+COALESCE(length(CAST(OLD.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.payloadJson AS BLOB)),0)+COALESCE(length(CAST(OLD.payloadBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_blobs_insert AFTER INSERT ON mio_blobs BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.content AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.content AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_blobs_update AFTER UPDATE ON mio_blobs BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.content AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.sha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.content AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.content AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.sha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.content AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_blobs_delete AFTER DELETE ON mio_blobs BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.sha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.content AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.sha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.content AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_steps_insert AFTER INSERT ON mio_steps BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.tier AS BLOB)),0)+COALESCE(length(CAST(NEW.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.partialText AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.tier AS BLOB)),0)+COALESCE(length(CAST(NEW.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.partialText AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_steps_update AFTER UPDATE ON mio_steps BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.tier AS BLOB)),0)+COALESCE(length(CAST(NEW.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.partialText AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.tier AS BLOB)),0)+COALESCE(length(CAST(OLD.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(OLD.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(OLD.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(OLD.partialText AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.tier AS BLOB)),0)+COALESCE(length(CAST(NEW.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(NEW.partialText AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.tier AS BLOB)),0)+COALESCE(length(CAST(OLD.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(OLD.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(OLD.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(OLD.partialText AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_steps_delete AFTER DELETE ON mio_steps BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.tier AS BLOB)),0)+COALESCE(length(CAST(OLD.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(OLD.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(OLD.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(OLD.partialText AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.tier AS BLOB)),0)+COALESCE(length(CAST(OLD.currentRequestId AS BLOB)),0)+COALESCE(length(CAST(OLD.sourceEntryId AS BLOB)),0)+COALESCE(length(CAST(OLD.resultEntryId AS BLOB)),0)+COALESCE(length(CAST(OLD.partialText AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_requests_insert AFTER INSERT ON mio_requests BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.protocol AS BLOB)),0)+COALESCE(length(CAST(NEW.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.originalBody AS BLOB)),0)+COALESCE(length(CAST(NEW.inputManifest AS BLOB)),0)+COALESCE(length(CAST(NEW.firstEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.lastEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.assembledAt AS BLOB)),0)+COALESCE(length(CAST(NEW.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.completedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.assemblyReason AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.protocol AS BLOB)),0)+COALESCE(length(CAST(NEW.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.originalBody AS BLOB)),0)+COALESCE(length(CAST(NEW.inputManifest AS BLOB)),0)+COALESCE(length(CAST(NEW.firstEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.lastEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.assembledAt AS BLOB)),0)+COALESCE(length(CAST(NEW.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.completedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.assemblyReason AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_requests_update AFTER UPDATE ON mio_requests BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.protocol AS BLOB)),0)+COALESCE(length(CAST(NEW.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.originalBody AS BLOB)),0)+COALESCE(length(CAST(NEW.inputManifest AS BLOB)),0)+COALESCE(length(CAST(NEW.firstEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.lastEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.assembledAt AS BLOB)),0)+COALESCE(length(CAST(NEW.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.completedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.assemblyReason AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.protocol AS BLOB)),0)+COALESCE(length(CAST(OLD.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.originalBody AS BLOB)),0)+COALESCE(length(CAST(OLD.inputManifest AS BLOB)),0)+COALESCE(length(CAST(OLD.firstEntry AS BLOB)),0)+COALESCE(length(CAST(OLD.lastEntry AS BLOB)),0)+COALESCE(length(CAST(OLD.assembledAt AS BLOB)),0)+COALESCE(length(CAST(OLD.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(OLD.completedAt AS BLOB)),0)+COALESCE(length(CAST(OLD.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(OLD.assemblyReason AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.protocol AS BLOB)),0)+COALESCE(length(CAST(NEW.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.originalBody AS BLOB)),0)+COALESCE(length(CAST(NEW.inputManifest AS BLOB)),0)+COALESCE(length(CAST(NEW.firstEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.lastEntry AS BLOB)),0)+COALESCE(length(CAST(NEW.assembledAt AS BLOB)),0)+COALESCE(length(CAST(NEW.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.completedAt AS BLOB)),0)+COALESCE(length(CAST(NEW.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(NEW.assemblyReason AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.protocol AS BLOB)),0)+COALESCE(length(CAST(OLD.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.originalBody AS BLOB)),0)+COALESCE(length(CAST(OLD.inputManifest AS BLOB)),0)+COALESCE(length(CAST(OLD.firstEntry AS BLOB)),0)+COALESCE(length(CAST(OLD.lastEntry AS BLOB)),0)+COALESCE(length(CAST(OLD.assembledAt AS BLOB)),0)+COALESCE(length(CAST(OLD.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(OLD.completedAt AS BLOB)),0)+COALESCE(length(CAST(OLD.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(OLD.assemblyReason AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_requests_delete AFTER DELETE ON mio_requests BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.protocol AS BLOB)),0)+COALESCE(length(CAST(OLD.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.originalBody AS BLOB)),0)+COALESCE(length(CAST(OLD.inputManifest AS BLOB)),0)+COALESCE(length(CAST(OLD.firstEntry AS BLOB)),0)+COALESCE(length(CAST(OLD.lastEntry AS BLOB)),0)+COALESCE(length(CAST(OLD.assembledAt AS BLOB)),0)+COALESCE(length(CAST(OLD.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(OLD.completedAt AS BLOB)),0)+COALESCE(length(CAST(OLD.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(OLD.assemblyReason AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.protocol AS BLOB)),0)+COALESCE(length(CAST(OLD.bodySha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.originalBody AS BLOB)),0)+COALESCE(length(CAST(OLD.inputManifest AS BLOB)),0)+COALESCE(length(CAST(OLD.firstEntry AS BLOB)),0)+COALESCE(length(CAST(OLD.lastEntry AS BLOB)),0)+COALESCE(length(CAST(OLD.assembledAt AS BLOB)),0)+COALESCE(length(CAST(OLD.dispatchStartedAt AS BLOB)),0)+COALESCE(length(CAST(OLD.completedAt AS BLOB)),0)+COALESCE(length(CAST(OLD.previousRequestId AS BLOB)),0)+COALESCE(length(CAST(OLD.assemblyReason AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_changes_insert AFTER INSERT ON mio_changes BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_changes_update AFTER UPDATE ON mio_changes BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_changes_delete AFTER DELETE ON mio_changes BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_controls_insert AFTER INSERT ON mio_controls BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_controls_update AFTER UPDATE ON mio_controls BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_controls_delete AFTER DELETE ON mio_controls BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_control_states_insert AFTER INSERT ON mio_control_states BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_control_states_update AFTER UPDATE ON mio_control_states BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_control_states_delete AFTER DELETE ON mio_control_states BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_imports_insert AFTER INSERT ON mio_imports BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.name AS BLOB)),0)+COALESCE(length(CAST(NEW.mimeType AS BLOB)),0)+COALESCE(length(CAST(NEW.relativePath AS BLOB)),0)+COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.assetId AS BLOB)),0)+COALESCE(length(CAST(NEW.resourceId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.name AS BLOB)),0)+COALESCE(length(CAST(NEW.mimeType AS BLOB)),0)+COALESCE(length(CAST(NEW.relativePath AS BLOB)),0)+COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.assetId AS BLOB)),0)+COALESCE(length(CAST(NEW.resourceId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_imports_update AFTER UPDATE ON mio_imports BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.name AS BLOB)),0)+COALESCE(length(CAST(NEW.mimeType AS BLOB)),0)+COALESCE(length(CAST(NEW.relativePath AS BLOB)),0)+COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.assetId AS BLOB)),0)+COALESCE(length(CAST(NEW.resourceId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.name AS BLOB)),0)+COALESCE(length(CAST(OLD.mimeType AS BLOB)),0)+COALESCE(length(CAST(OLD.relativePath AS BLOB)),0)+COALESCE(length(CAST(OLD.sha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.assetId AS BLOB)),0)+COALESCE(length(CAST(OLD.resourceId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.name AS BLOB)),0)+COALESCE(length(CAST(NEW.mimeType AS BLOB)),0)+COALESCE(length(CAST(NEW.relativePath AS BLOB)),0)+COALESCE(length(CAST(NEW.sha256 AS BLOB)),0)+COALESCE(length(CAST(NEW.status AS BLOB)),0)+COALESCE(length(CAST(NEW.assetId AS BLOB)),0)+COALESCE(length(CAST(NEW.resourceId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.name AS BLOB)),0)+COALESCE(length(CAST(OLD.mimeType AS BLOB)),0)+COALESCE(length(CAST(OLD.relativePath AS BLOB)),0)+COALESCE(length(CAST(OLD.sha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.assetId AS BLOB)),0)+COALESCE(length(CAST(OLD.resourceId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_imports_delete AFTER DELETE ON mio_imports BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.name AS BLOB)),0)+COALESCE(length(CAST(OLD.mimeType AS BLOB)),0)+COALESCE(length(CAST(OLD.relativePath AS BLOB)),0)+COALESCE(length(CAST(OLD.sha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.assetId AS BLOB)),0)+COALESCE(length(CAST(OLD.resourceId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.name AS BLOB)),0)+COALESCE(length(CAST(OLD.mimeType AS BLOB)),0)+COALESCE(length(CAST(OLD.relativePath AS BLOB)),0)+COALESCE(length(CAST(OLD.sha256 AS BLOB)),0)+COALESCE(length(CAST(OLD.status AS BLOB)),0)+COALESCE(length(CAST(OLD.assetId AS BLOB)),0)+COALESCE(length(CAST(OLD.resourceId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_job_origins_insert AFTER INSERT ON mio_job_origins BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.jobId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.operation AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.jobId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.operation AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_job_origins_update AFTER UPDATE ON mio_job_origins BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.jobId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.operation AS BLOB)),0))-(COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.jobId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.operation AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.jobId AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.operation AS BLOB)),0))-(COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.jobId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.operation AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_job_origins_delete AFTER DELETE ON mio_job_origins BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.jobId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.operation AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.jobId AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.operation AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_edit_claims_insert AFTER INSERT ON mio_edit_claims BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_edit_claims_update AFTER UPDATE ON mio_edit_claims BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.targetId AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.id AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.targetId AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_edit_claims_delete AFTER DELETE ON mio_edit_claims BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.targetId AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.id AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.targetId AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_edit_owners_insert AFTER INSERT ON mio_edit_owners BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_edit_owners_update AFTER UPDATE ON mio_edit_owners BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0))-(COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0))-(COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_edit_owners_delete AFTER DELETE ON mio_edit_owners BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_edit_receipts_insert AFTER INSERT ON mio_edit_receipts BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_edit_receipts_update AFTER UPDATE ON mio_edit_receipts BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.ownerId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_edit_receipts_delete AFTER DELETE ON mio_edit_receipts BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.ownerId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_conversation_policies_insert AFTER INSERT ON mio_conversation_policies BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_conversation_policies_update AFTER UPDATE ON mio_conversation_policies BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0))-(COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_conversation_policies_delete AFTER DELETE ON mio_conversation_policies BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.data AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_conversation_policy_requests_insert AFTER INSERT ON mio_conversation_policy_requests BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.inputHash AS BLOB)),0)+COALESCE(length(CAST(NEW.response AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.inputHash AS BLOB)),0)+COALESCE(length(CAST(NEW.response AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_conversation_policy_requests_update AFTER UPDATE ON mio_conversation_policy_requests BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.inputHash AS BLOB)),0)+COALESCE(length(CAST(NEW.response AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.inputHash AS BLOB)),0)+COALESCE(length(CAST(OLD.response AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.conversationId AS BLOB)),0)+COALESCE(length(CAST(NEW.inputHash AS BLOB)),0)+COALESCE(length(CAST(NEW.response AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.inputHash AS BLOB)),0)+COALESCE(length(CAST(OLD.response AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_conversation_policy_requests_delete AFTER DELETE ON mio_conversation_policy_requests BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.inputHash AS BLOB)),0)+COALESCE(length(CAST(OLD.response AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.conversationId AS BLOB)),0)+COALESCE(length(CAST(OLD.inputHash AS BLOB)),0)+COALESCE(length(CAST(OLD.response AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_events_insert AFTER INSERT ON mio_events BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_events_update AFTER UPDATE ON mio_events BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_events_delete AFTER DELETE ON mio_events BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;SELECT CASE WHEN bytes>268435456 OR rows>65536 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END FROM mio_storage_counters WHERE singleton=1;END;

CREATE TRIGGER quota_mio_process_target_revisions_insert AFTER INSERT ON mio_process_target_revisions BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_process_target_revisions_update AFTER UPDATE ON mio_process_target_revisions BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0))-(COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.targetId AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.kind AS BLOB)),0)+COALESCE(length(CAST(NEW.targetId AS BLOB)),0))-(COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.targetId AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_process_target_revisions_delete AFTER DELETE ON mio_process_target_revisions BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.targetId AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.kind AS BLOB)),0)+COALESCE(length(CAST(OLD.targetId AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_rule_writes_insert AFTER INSERT ON mio_rule_writes BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.actor AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterHash AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(NEW.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.actor AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterHash AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(NEW.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))),rows=rows+(1) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_rule_writes_update AFTER UPDATE ON mio_rule_writes BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.actor AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterHash AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(NEW.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.actor AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(OLD.beforeHash AS BLOB)),0)+COALESCE(length(CAST(OLD.afterHash AS BLOB)),0)+COALESCE(length(CAST(OLD.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(OLD.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(0) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+((COALESCE(length(CAST(NEW.requestId AS BLOB)),0)+COALESCE(length(CAST(NEW.projectId AS BLOB)),0)+COALESCE(length(CAST(NEW.actor AS BLOB)),0)+COALESCE(length(CAST(NEW.runId AS BLOB)),0)+COALESCE(length(CAST(NEW.stepId AS BLOB)),0)+COALESCE(length(CAST(NEW.digest AS BLOB)),0)+COALESCE(length(CAST(NEW.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterHash AS BLOB)),0)+COALESCE(length(CAST(NEW.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(NEW.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(NEW.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(NEW.state AS BLOB)),0)+COALESCE(length(CAST(NEW.createdAt AS BLOB)),0)+COALESCE(length(CAST(NEW.updatedAt AS BLOB)),0))-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.actor AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(OLD.beforeHash AS BLOB)),0)+COALESCE(length(CAST(OLD.afterHash AS BLOB)),0)+COALESCE(length(CAST(OLD.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(OLD.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(0) WHERE singleton=1;END;

CREATE TRIGGER quota_mio_rule_writes_delete AFTER DELETE ON mio_rule_writes BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mio_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END;SELECT CASE WHEN bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.actor AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(OLD.beforeHash AS BLOB)),0)+COALESCE(length(CAST(OLD.afterHash AS BLOB)),0)+COALESCE(length(CAST(OLD.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(OLD.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))) NOT BETWEEN 0 AND 9007199254740991 OR rows+(-1) NOT BETWEEN 1 AND 9007199254740991 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_CORRUPT') END FROM mio_storage_counters WHERE singleton=1;UPDATE mio_storage_counters SET bytes=bytes+(-(COALESCE(length(CAST(OLD.requestId AS BLOB)),0)+COALESCE(length(CAST(OLD.projectId AS BLOB)),0)+COALESCE(length(CAST(OLD.actor AS BLOB)),0)+COALESCE(length(CAST(OLD.runId AS BLOB)),0)+COALESCE(length(CAST(OLD.stepId AS BLOB)),0)+COALESCE(length(CAST(OLD.digest AS BLOB)),0)+COALESCE(length(CAST(OLD.approvalReceiptId AS BLOB)),0)+COALESCE(length(CAST(OLD.beforeHash AS BLOB)),0)+COALESCE(length(CAST(OLD.afterHash AS BLOB)),0)+COALESCE(length(CAST(OLD.beforeBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.afterBlobHash AS BLOB)),0)+COALESCE(length(CAST(OLD.fixedRelativeName AS BLOB)),0)+COALESCE(length(CAST(OLD.fileIdentity AS BLOB)),0)+COALESCE(length(CAST(OLD.state AS BLOB)),0)+COALESCE(length(CAST(OLD.createdAt AS BLOB)),0)+COALESCE(length(CAST(OLD.updatedAt AS BLOB)),0))),rows=rows+(-1) WHERE singleton=1;END;

CREATE TABLE project_version_blobs(hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^a-f0-9]*'),profile INTEGER NOT NULL CHECK(profile=1),codec TEXT NOT NULL CHECK(codec='gzip'),rawBytes INTEGER NOT NULL CHECK(typeof(rawBytes)='integer' AND rawBytes BETWEEN 0 AND 134217728),compressedBytes INTEGER NOT NULL CHECK(typeof(compressedBytes)='integer' AND compressedBytes BETWEEN 0 AND 67108864),payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=compressedBytes AND compressedBytes>0));

CREATE TRIGGER immutable_project_version_blobs BEFORE UPDATE ON project_version_blobs BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TRIGGER reject_project_version_blobs_replacement BEFORE INSERT ON project_version_blobs WHEN EXISTS(SELECT 1 FROM project_version_blobs WHERE hash=NEW.hash OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TABLE project_versions(id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),projectId TEXT NOT NULL CHECK(typeof(projectId)='text' AND length(projectId)=36),trigger TEXT NOT NULL CHECK(trigger IN ('manual','mio-turn','bulk-change','restore','daily-open')),name TEXT CHECK(name IS NULL OR (length(name) BETWEEN 1 AND 150)),mioRunId TEXT,contentSequence INTEGER NOT NULL CHECK(typeof(contentSequence)='integer' AND contentSequence BETWEEN 0 AND 9007199254740991),createdAt TEXT NOT NULL CHECK(length(createdAt)=24),blobHash TEXT NOT NULL REFERENCES project_version_blobs(hash),mioChangeRowid INTEGER NOT NULL CHECK(typeof(mioChangeRowid)='integer' AND mioChangeRowid BETWEEN 0 AND 9007199254740991),CHECK(trigger='manual' OR name IS NULL),CHECK((trigger='mio-turn' AND mioRunId IS NOT NULL) OR (trigger<>'mio-turn' AND mioRunId IS NULL)),UNIQUE(projectId,id));

CREATE INDEX project_versions_page ON project_versions(projectId,createdAt DESC,id DESC);

CREATE UNIQUE INDEX project_versions_run ON project_versions(projectId,mioRunId) WHERE mioRunId IS NOT NULL;

CREATE TRIGGER immutable_project_versions BEFORE UPDATE ON project_versions BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TRIGGER reject_project_versions_replacement BEFORE INSERT ON project_versions WHEN EXISTS(SELECT 1 FROM project_versions WHERE id=NEW.id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TRIGGER retain_manual_project_versions BEFORE DELETE ON project_versions WHEN OLD.trigger='manual' BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_MANUAL_RETAINED');END;

CREATE TABLE project_version_requests(projectId TEXT NOT NULL CHECK(typeof(projectId)='text' AND length(projectId)=36),requestId TEXT NOT NULL CHECK(length(requestId)=36),operation TEXT NOT NULL CHECK(operation IN ('project.version.save','project.version.restore')),inputDigest TEXT NOT NULL CHECK(length(inputDigest)=64 AND inputDigest NOT GLOB '*[^a-f0-9]*'),response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB)) BETWEEN 1 AND 65536),PRIMARY KEY(projectId,requestId));

CREATE TRIGGER immutable_project_version_requests BEFORE UPDATE ON project_version_requests BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TRIGGER reject_project_version_requests_replacement BEFORE INSERT ON project_version_requests WHEN EXISTS(SELECT 1 FROM project_version_requests WHERE (projectId=NEW.projectId AND requestId=NEW.requestId) OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TRIGGER retain_project_version_requests BEFORE DELETE ON project_version_requests BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TABLE project_version_capture_marks(projectId TEXT NOT NULL CHECK(typeof(projectId)='text' AND length(projectId)=36),kind TEXT NOT NULL CHECK(kind IN ('mio-turn','daily-open')),key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 200),createdAt TEXT NOT NULL,PRIMARY KEY(projectId,kind,key));

CREATE TRIGGER immutable_project_version_capture_marks BEFORE UPDATE ON project_version_capture_marks BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TRIGGER reject_project_version_capture_marks_replacement BEFORE INSERT ON project_version_capture_marks WHEN EXISTS(SELECT 1 FROM project_version_capture_marks WHERE (projectId=NEW.projectId AND kind=NEW.kind AND key=NEW.key) OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TRIGGER retain_project_version_capture_marks BEFORE DELETE ON project_version_capture_marks BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END;

CREATE TABLE local_draft_states(kind TEXT PRIMARY KEY NOT NULL CHECK(kind IN ('clip','delivery','shot-text')),workspaceScope TEXT NOT NULL CHECK(typeof(workspaceScope)='text' AND length(workspaceScope)=64 AND length(CAST(workspaceScope AS BLOB))=64 AND workspaceScope NOT GLOB '*[^0-9a-f]*'));

CREATE TRIGGER local_draft_states_guard_insert BEFORE INSERT ON local_draft_states WHEN EXISTS(SELECT 1 FROM local_draft_states WHERE kind IS NEW.kind OR rowid IS NEW.rowid) BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE');END;

CREATE TRIGGER local_draft_states_guard_update BEFORE UPDATE ON local_draft_states BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE');END;

CREATE TRIGGER local_draft_states_guard_delete BEFORE DELETE ON local_draft_states BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE');END;

CREATE TRIGGER local_draft_states_positive_rowid AFTER INSERT ON local_draft_states WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE');END;

CREATE TABLE local_clip_drafts(projectId TEXT NOT NULL CHECK(typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36),timelineId TEXT NOT NULL CHECK(typeof(timelineId)='text' AND length(CAST(timelineId AS BLOB))=36),clipId TEXT NOT NULL CHECK(typeof(clipId)='text' AND length(CAST(clipId AS BLOB))=36),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),data TEXT NOT NULL CHECK(typeof(data)='text' AND json_valid(data) AND json_type(data) IS 'object') CONSTRAINT local_draft_row_limit CHECK(length(CAST(data AS BLOB)) BETWEEN 1 AND 8192),ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 1 AND 9007199254740991),UNIQUE(ordinal),PRIMARY KEY(projectId,timelineId,clipId),CHECK(json_type(data,'$.projectId') IS 'text' AND projectId IS json_extract(data,'$.projectId') AND json_type(data,'$.timelineId') IS 'text' AND timelineId IS json_extract(data,'$.timelineId') AND json_type(data,'$.clipId') IS 'text' AND clipId IS json_extract(data,'$.clipId') AND json_type(data,'$.revision') IS 'integer' AND revision IS json_extract(data,'$.revision') AND (json_type(data,'$.draft') IS 'object' OR json_type(data,'$.draft') IS 'null')));

CREATE TABLE local_delivery_drafts(projectId TEXT NOT NULL CHECK(typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36),draftRevision INTEGER NOT NULL CHECK(typeof(draftRevision)='integer' AND draftRevision BETWEEN 0 AND 9007199254740991),intentRevision INTEGER NOT NULL CHECK(typeof(intentRevision)='integer' AND intentRevision BETWEEN 0 AND 9007199254740991),intentId TEXT,requestId TEXT,intentStatus TEXT,data TEXT NOT NULL CHECK(typeof(data)='text' AND json_valid(data) AND json_type(data) IS 'object') CONSTRAINT local_draft_row_limit CHECK(length(CAST(data AS BLOB)) BETWEEN 1 AND 8192),ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 1 AND 9007199254740991),UNIQUE(ordinal),PRIMARY KEY(projectId),CHECK(json_type(data,'$.projectId') IS 'text' AND projectId IS json_extract(data,'$.projectId') AND json_type(data,'$.draftRevision') IS 'integer' AND draftRevision IS json_extract(data,'$.draftRevision') AND json_type(data,'$.intentRevision') IS 'integer' AND intentRevision IS json_extract(data,'$.intentRevision')),CHECK((json_type(data,'$.draft') IS 'object' OR json_type(data,'$.draft') IS 'null') AND (draftRevision>0 OR json_type(data,'$.draft') IS 'null')),CHECK(draftRevision>0 OR intentRevision>0),CHECK((intentRevision=0 AND json_type(data,'$.intent') IS 'null' AND intentId IS NULL AND requestId IS NULL AND intentStatus IS NULL) OR (intentRevision>0 AND json_type(data,'$.intent') IS 'object' AND typeof(intentId)='text' AND length(CAST(intentId AS BLOB))=36 AND typeof(requestId)='text' AND length(CAST(requestId AS BLOB)) BETWEEN 1 AND 800 AND typeof(intentStatus)='text' AND intentStatus IN ('pending','accepted','not_applied') AND json_type(data,'$.intent.intentId') IS 'text' AND json_type(data,'$.intent.input.requestId') IS 'text' AND json_type(data,'$.intent.outcome.status') IS 'text' AND intentId IS json_extract(data,'$.intent.intentId') AND requestId IS json_extract(data,'$.intent.input.requestId') AND intentStatus IS json_extract(data,'$.intent.outcome.status'))));

CREATE TABLE local_shot_text_drafts(projectId TEXT NOT NULL CHECK(typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36),shotId TEXT NOT NULL CHECK(typeof(shotId)='text' AND length(CAST(shotId AS BLOB))=36),draftRevision INTEGER NOT NULL CHECK(typeof(draftRevision)='integer' AND draftRevision BETWEEN 0 AND 9007199254740991),intentRevision INTEGER NOT NULL CHECK(typeof(intentRevision)='integer' AND intentRevision BETWEEN 0 AND 9007199254740991),intentId TEXT,requestId TEXT,intentStatus TEXT,data TEXT NOT NULL CHECK(typeof(data)='text' AND json_valid(data) AND json_type(data) IS 'object') CONSTRAINT local_draft_row_limit CHECK(length(CAST(data AS BLOB)) BETWEEN 1 AND 262144),ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 1 AND 9007199254740991),UNIQUE(ordinal),PRIMARY KEY(projectId,shotId),UNIQUE(shotId),CHECK(json_type(data,'$.projectId') IS 'text' AND projectId IS json_extract(data,'$.projectId') AND json_type(data,'$.shotId') IS 'text' AND shotId IS json_extract(data,'$.shotId') AND json_type(data,'$.draftRevision') IS 'integer' AND draftRevision IS json_extract(data,'$.draftRevision') AND json_type(data,'$.intentRevision') IS 'integer' AND intentRevision IS json_extract(data,'$.intentRevision')),CHECK((json_type(data,'$.draft') IS 'object' OR json_type(data,'$.draft') IS 'null') AND (draftRevision>0 OR json_type(data,'$.draft') IS 'null')),CHECK(draftRevision>0 OR intentRevision>0),CHECK((intentRevision=0 AND json_type(data,'$.intent') IS 'null' AND intentId IS NULL AND requestId IS NULL AND intentStatus IS NULL) OR (intentRevision>0 AND json_type(data,'$.intent') IS 'object' AND typeof(intentId)='text' AND length(CAST(intentId AS BLOB))=36 AND typeof(requestId)='text' AND length(CAST(requestId AS BLOB)) BETWEEN 1 AND 800 AND typeof(intentStatus)='text' AND intentStatus IN ('pending','applied','not_applied') AND json_type(data,'$.intent.intentId') IS 'text' AND json_type(data,'$.intent.input.requestId') IS 'text' AND json_type(data,'$.intent.outcome.status') IS 'text' AND intentId IS json_extract(data,'$.intent.intentId') AND requestId IS json_extract(data,'$.intent.input.requestId') AND intentStatus IS json_extract(data,'$.intent.outcome.status'))));

CREATE TRIGGER local_clip_drafts_guard_insert BEFORE INSERT ON local_clip_drafts BEGIN SELECT CASE WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_PROJECT') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM local_draft_states WHERE kind='clip') THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE') END;SELECT CASE WHEN EXISTS(SELECT 1 FROM local_clip_drafts WHERE (projectId IS NEW.projectId AND timelineId IS NEW.timelineId AND clipId IS NEW.clipId OR ordinal IS NEW.ordinal OR rowid IS NEW.rowid)) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CONFLICT') END;SELECT CASE WHEN (SELECT count(*) FROM local_clip_drafts )>=128 OR (SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM local_clip_drafts )+length(CAST(NEW.data AS BLOB))>2097152 THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CAPACITY') END;END;

CREATE TRIGGER local_clip_drafts_guard_update BEFORE UPDATE ON local_clip_drafts BEGIN SELECT CASE WHEN NEW.projectId IS NOT OLD.projectId OR NEW.timelineId IS NOT OLD.timelineId OR NEW.clipId IS NOT OLD.clipId OR NEW.ordinal IS NOT OLD.ordinal OR NEW.rowid IS NOT OLD.rowid OR NEW.revision<OLD.revision THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_IDENTITY') END;SELECT CASE WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_PROJECT') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM local_draft_states WHERE kind='clip') THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE') END;SELECT CASE WHEN EXISTS(SELECT 1 FROM local_clip_drafts WHERE rowid IS NOT OLD.rowid AND (projectId IS NEW.projectId AND timelineId IS NEW.timelineId AND clipId IS NEW.clipId OR ordinal IS NEW.ordinal OR rowid IS NEW.rowid)) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CONFLICT') END;SELECT CASE WHEN (SELECT count(*) FROM local_clip_drafts WHERE rowid IS NOT OLD.rowid)>=128 OR (SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM local_clip_drafts WHERE rowid IS NOT OLD.rowid)+length(CAST(NEW.data AS BLOB))>2097152 THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CAPACITY') END;END;

CREATE TRIGGER local_clip_drafts_positive_rowid AFTER INSERT ON local_clip_drafts WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_IDENTITY');END;

CREATE TRIGGER local_delivery_drafts_guard_insert BEFORE INSERT ON local_delivery_drafts BEGIN SELECT CASE WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_PROJECT') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM local_draft_states WHERE kind='delivery') THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE') END;SELECT CASE WHEN EXISTS(SELECT 1 FROM local_delivery_drafts WHERE (projectId IS NEW.projectId OR ordinal IS NEW.ordinal OR rowid IS NEW.rowid OR (NEW.intentId IS NOT NULL AND intentId IS NEW.intentId) OR (NEW.requestId IS NOT NULL AND requestId IS NEW.requestId))) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CONFLICT') END;SELECT CASE WHEN (SELECT count(*) FROM local_delivery_drafts )>=128 OR (SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM local_delivery_drafts )+length(CAST(NEW.data AS BLOB))>2097152 THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CAPACITY') END;END;

CREATE TRIGGER local_delivery_drafts_guard_update BEFORE UPDATE ON local_delivery_drafts BEGIN SELECT CASE WHEN NEW.projectId IS NOT OLD.projectId OR NEW.ordinal IS NOT OLD.ordinal OR NEW.rowid IS NOT OLD.rowid OR NEW.draftRevision<OLD.draftRevision OR NEW.intentRevision<OLD.intentRevision THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_IDENTITY') END;SELECT CASE WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_PROJECT') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM local_draft_states WHERE kind='delivery') THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE') END;SELECT CASE WHEN EXISTS(SELECT 1 FROM local_delivery_drafts WHERE rowid IS NOT OLD.rowid AND (projectId IS NEW.projectId OR ordinal IS NEW.ordinal OR rowid IS NEW.rowid OR (NEW.intentId IS NOT NULL AND intentId IS NEW.intentId) OR (NEW.requestId IS NOT NULL AND requestId IS NEW.requestId))) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CONFLICT') END;SELECT CASE WHEN (SELECT count(*) FROM local_delivery_drafts WHERE rowid IS NOT OLD.rowid)>=128 OR (SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM local_delivery_drafts WHERE rowid IS NOT OLD.rowid)+length(CAST(NEW.data AS BLOB))>2097152 THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CAPACITY') END;END;

CREATE TRIGGER local_delivery_drafts_positive_rowid AFTER INSERT ON local_delivery_drafts WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_IDENTITY');END;

CREATE UNIQUE INDEX local_delivery_drafts_intentId ON local_delivery_drafts(intentId) WHERE intentId IS NOT NULL;

CREATE UNIQUE INDEX local_delivery_drafts_requestId ON local_delivery_drafts(requestId) WHERE requestId IS NOT NULL;

CREATE TRIGGER local_shot_text_drafts_guard_insert BEFORE INSERT ON local_shot_text_drafts BEGIN SELECT CASE WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_PROJECT') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM local_draft_states WHERE kind='shot-text') THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE') END;SELECT CASE WHEN EXISTS(SELECT 1 FROM local_shot_text_drafts WHERE (projectId IS NEW.projectId AND shotId IS NEW.shotId OR ordinal IS NEW.ordinal OR rowid IS NEW.rowid OR (NEW.intentId IS NOT NULL AND intentId IS NEW.intentId) OR (NEW.requestId IS NOT NULL AND requestId IS NEW.requestId) OR shotId IS NEW.shotId OR (NEW.intentStatus='pending' AND intentStatus='pending' AND projectId IS NEW.projectId))) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CONFLICT') END;SELECT CASE WHEN (SELECT count(*) FROM local_shot_text_drafts )>=128 OR (SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM local_shot_text_drafts )+length(CAST(NEW.data AS BLOB))>16777216 THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CAPACITY') END;END;

CREATE TRIGGER local_shot_text_drafts_guard_update BEFORE UPDATE ON local_shot_text_drafts BEGIN SELECT CASE WHEN NEW.projectId IS NOT OLD.projectId OR NEW.shotId IS NOT OLD.shotId OR NEW.ordinal IS NOT OLD.ordinal OR NEW.rowid IS NOT OLD.rowid OR NEW.draftRevision<OLD.draftRevision OR NEW.intentRevision<OLD.intentRevision THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_IDENTITY') END;SELECT CASE WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_PROJECT') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM local_draft_states WHERE kind='shot-text') THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_STATE') END;SELECT CASE WHEN EXISTS(SELECT 1 FROM local_shot_text_drafts WHERE rowid IS NOT OLD.rowid AND (projectId IS NEW.projectId AND shotId IS NEW.shotId OR ordinal IS NEW.ordinal OR rowid IS NEW.rowid OR (NEW.intentId IS NOT NULL AND intentId IS NEW.intentId) OR (NEW.requestId IS NOT NULL AND requestId IS NEW.requestId) OR shotId IS NEW.shotId OR (NEW.intentStatus='pending' AND intentStatus='pending' AND projectId IS NEW.projectId))) THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CONFLICT') END;SELECT CASE WHEN (SELECT count(*) FROM local_shot_text_drafts WHERE rowid IS NOT OLD.rowid)>=128 OR (SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM local_shot_text_drafts WHERE rowid IS NOT OLD.rowid)+length(CAST(NEW.data AS BLOB))>16777216 THEN RAISE(ABORT,'LOCAL_DRAFT_SQL_CAPACITY') END;END;

CREATE TRIGGER local_shot_text_drafts_positive_rowid AFTER INSERT ON local_shot_text_drafts WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'LOCAL_DRAFT_SQL_IDENTITY');END;

CREATE UNIQUE INDEX local_shot_text_drafts_intentId ON local_shot_text_drafts(intentId) WHERE intentId IS NOT NULL;

CREATE UNIQUE INDEX local_shot_text_drafts_requestId ON local_shot_text_drafts(requestId) WHERE requestId IS NOT NULL;

CREATE UNIQUE INDEX local_shot_text_drafts_pending ON local_shot_text_drafts(projectId) WHERE intentStatus='pending';

PRAGMA application_id=1298755400;
INSERT INTO schema_version VALUES(9);
