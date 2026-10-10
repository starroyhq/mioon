-- Frozen from baseline 82c70f3 before image migration. Do not regenerate from image production DDL.
CREATE TABLE schema_version(version INTEGER PRIMARY KEY);
CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE assets(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE shots(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE nodes(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE edges(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE versions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),jobId TEXT NOT NULL UNIQUE REFERENCES jobs(id),data TEXT NOT NULL);
CREATE TABLE exports(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE timelines(id TEXT PRIMARY KEY,projectId TEXT NOT NULL UNIQUE REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE timeline_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE idempotency(scope TEXT NOT NULL,requestId TEXT NOT NULL,requestHash TEXT NOT NULL,resourceId TEXT NOT NULL,PRIMARY KEY(scope,requestId));
CREATE TABLE job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,jobId TEXT NOT NULL,event TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE timeline_history(
 id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),
 position INTEGER NOT NULL CHECK(position>0),operation TEXT NOT NULL,createdAt TEXT NOT NULL,
 beforeSnapshot TEXT NOT NULL,afterSnapshot TEXT NOT NULL,UNIQUE(projectId,position));
CREATE TABLE timeline_history_cursors(
 projectId TEXT PRIMARY KEY REFERENCES projects(id),position INTEGER NOT NULL CHECK(position>=0));
CREATE TABLE reference_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE workspace_preferences(
 projectId TEXT PRIMARY KEY REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(revision>0 AND revision<=9007199254740991),
 state TEXT NOT NULL CHECK(json_valid(state) AND length(CAST(state AS BLOB))<=16384));
CREATE TABLE agent_chat_threads(
 id TEXT PRIMARY KEY,projectId TEXT NOT NULL UNIQUE REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(revision>=0),nextPosition INTEGER NOT NULL CHECK(nextPosition>0));
CREATE TABLE agent_chat_requests(
 requestId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),
 threadId TEXT NOT NULL REFERENCES agent_chat_threads(id),runId TEXT NOT NULL UNIQUE,
 fingerprint TEXT NOT NULL,acceptance TEXT NOT NULL CHECK(json_valid(acceptance)),bytes INTEGER NOT NULL CHECK(bytes>=0));
CREATE TABLE agent_chat_runs(
 id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),
 threadId TEXT NOT NULL REFERENCES agent_chat_threads(id),requestId TEXT NOT NULL UNIQUE REFERENCES agent_chat_requests(requestId),
 position INTEGER NOT NULL CHECK(position>0),status TEXT NOT NULL CHECK(status IN ('running','completed','failed','stopped','interrupted')),
 data TEXT NOT NULL CHECK(json_valid(data)),bytes INTEGER NOT NULL CHECK(bytes>=0),UNIQUE(threadId,position));
CREATE TABLE agent_chat_events(
 runId TEXT NOT NULL REFERENCES agent_chat_runs(id),seq INTEGER NOT NULL CHECK(seq>0),
 data TEXT NOT NULL CHECK(json_valid(data)),bytes INTEGER NOT NULL CHECK(bytes>=0),PRIMARY KEY(runId,seq));
CREATE TABLE agent_chat_quota(
 id INTEGER PRIMARY KEY CHECK(id=1),runs INTEGER NOT NULL CHECK(runs>=0),
 bytes INTEGER NOT NULL CHECK(bytes>=0),reservedBytes INTEGER NOT NULL CHECK(reservedBytes>=0));
CREATE TABLE agent_chat_steps(
 id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES agent_chat_runs(id),
 projectId TEXT NOT NULL REFERENCES projects(id),position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 3),
 kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
 status TEXT NOT NULL CHECK(status IN ('not_started','intent','dispatch_started','completed','unknown')),
 data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=1048576),
 bytes INTEGER NOT NULL CHECK(bytes>=0),UNIQUE(runId,position));
CREATE TABLE mutation_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation IN ('shot.create','shot.update','shot.reorder','node.create','node.update','version.select')),
 projectId TEXT NOT NULL REFERENCES projects(id),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput)),
 response TEXT NOT NULL CHECK(json_valid(response)));
CREATE TABLE agent_edit_proposals(
 position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
 projectId TEXT NOT NULL REFERENCES projects(id),runId TEXT NOT NULL UNIQUE REFERENCES agent_chat_runs(id),shotId TEXT NOT NULL,
 digest TEXT NOT NULL,definition TEXT NOT NULL CHECK(json_valid(definition) AND length(CAST(definition AS BLOB))<=131072),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','dispatching','unknown','applied','failed','rejected','cancelled')),
 approval TEXT CHECK(approval IS NULL OR (json_valid(approval) AND length(CAST(approval AS BLOB))<=32768)),
 outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND length(CAST(outcome AS BLOB))<=1024)),
 createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 196608),
 CHECK((status IN ('pending','rejected','cancelled'))=(approval IS NULL)),
 CHECK((status IN ('applied','failed'))=(outcome IS NOT NULL)));
CREATE TABLE asset_ranges(
 assetId TEXT PRIMARY KEY REFERENCES assets(id),projectId TEXT NOT NULL REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 inFrame INTEGER NOT NULL CHECK(typeof(inFrame)='integer' AND inFrame BETWEEN 0 AND 9007199254740991),
 outFrame INTEGER NOT NULL CHECK(typeof(outFrame)='integer' AND outFrame>inFrame AND outFrame<=9007199254740991));
CREATE TABLE asset_range_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation='asset.range.set'),
 projectId TEXT NOT NULL REFERENCES projects(id),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput)),
 response TEXT NOT NULL CHECK(json_valid(response)));
CREATE TABLE asset_dispositions(
 assetId TEXT PRIMARY KEY REFERENCES assets(id),projectId TEXT NOT NULL REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 disposition TEXT NOT NULL CHECK(disposition IN ('neutral','favorite','rejected')));
CREATE TABLE asset_disposition_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation='asset.disposition.set'),
 projectId TEXT NOT NULL REFERENCES projects(id),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND length(CAST(canonicalInput AS BLOB))<=4096),
 response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB))<=4096));
CREATE TABLE waveform_cache(
 position INTEGER PRIMARY KEY AUTOINCREMENT,cacheKey TEXT NOT NULL UNIQUE CHECK(length(CAST(cacheKey AS BLOB))=64),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 sourceSha256 TEXT NOT NULL CHECK(length(CAST(sourceSha256 AS BLOB))=64),
 algorithm TEXT NOT NULL CHECK(length(CAST(algorithm AS BLOB)) BETWEEN 1 AND 100),
 status TEXT NOT NULL CHECK(status IN ('queued','running','ready','interrupted','error','unsupported')),
 attemptId TEXT NOT NULL CHECK(length(CAST(attemptId AS BLOB))=36),
 data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=393216),
 bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 393216),
 reservedBytes INTEGER NOT NULL CHECK(typeof(reservedBytes)='integer' AND reservedBytes BETWEEN 0 AND 393216),
 UNIQUE(projectId,sourceSha256,algorithm));
CREATE TABLE subjects(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),
 kind TEXT NOT NULL CHECK(kind IN ('character','product','location','look')),
 name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 480),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 headVersionId TEXT NOT NULL,createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(id,projectId),FOREIGN KEY(headVersionId,id,projectId) REFERENCES subject_versions(id,subjectId,projectId) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE subject_versions(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),subjectId TEXT NOT NULL,
 number INTEGER NOT NULL CHECK(typeof(number)='integer' AND number BETWEEN 1 AND 9007199254740991),
 assetId TEXT NOT NULL REFERENCES assets(id),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4096),
 UNIQUE(subjectId,number),UNIQUE(id,subjectId,projectId),FOREIGN KEY(subjectId,projectId) REFERENCES subjects(id,projectId),
 CHECK(json_type(data)='object' AND json_extract(data,'$.id') IS id AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.subjectId') IS subjectId AND json_extract(data,'$.number') IS number AND json_extract(data,'$.assetId') IS assetId));
CREATE TABLE subject_bindings(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),shotId TEXT NOT NULL REFERENCES shots(id),subjectId TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('subject','style')),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 subjectVersionId TEXT,reviewedHeadVersionId TEXT NOT NULL,
 createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(shotId,subjectId,role),FOREIGN KEY(subjectId,projectId) REFERENCES subjects(id,projectId),
 FOREIGN KEY(subjectVersionId,subjectId,projectId) REFERENCES subject_versions(id,subjectId,projectId),
 FOREIGN KEY(reviewedHeadVersionId,subjectId,projectId) REFERENCES subject_versions(id,subjectId,projectId));
CREATE TABLE subject_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation IN ('subject.create','subject.version.add','subject.binding.set')),
 projectId TEXT NOT NULL REFERENCES projects(id),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 8192 AND json_type(canonicalInput)='object' AND json_extract(canonicalInput,'$.projectId') IS projectId),
 response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB)) BETWEEN 1 AND 16384 AND json_type(response)='object' AND json_extract(response,'$.projectId') IS projectId));
CREATE TABLE "edit_tasks"(
 position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 operation TEXT NOT NULL CHECK(operation IN ('timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','subject.create','subject.version.add','subject.binding.set')),
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
CREATE UNIQUE INDEX agent_chat_one_active ON agent_chat_runs(projectId) WHERE status='running';
CREATE INDEX agent_chat_history ON agent_chat_runs(projectId,position DESC);
CREATE INDEX agent_chat_completed ON agent_chat_runs(projectId,status,position DESC);
CREATE INDEX inspection_versions_asset_id ON versions(CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND 65536
  THEN CASE WHEN json_valid(data) THEN CASE WHEN json_type(data,'$.assetId')='text' AND length(CAST(json_extract(data,'$.assetId') AS BLOB))=36
    THEN json_extract(data,'$.assetId') END END END,id);
CREATE INDEX inspection_assets_project_id ON assets(projectId,id);
CREATE INDEX inspection_shots_project_id ON shots(projectId,id);
CREATE INDEX inspection_nodes_project_id ON nodes(projectId,id);
CREATE INDEX inspection_edges_project_id ON edges(projectId,id);
CREATE INDEX inspection_jobs_project_id ON jobs(projectId,id);
CREATE INDEX inspection_versions_project_id ON versions(projectId,id);
CREATE INDEX inspection_exports_project_id ON exports(projectId,id);
CREATE INDEX inspection_timelines_project_id ON timelines(projectId,id);
CREATE INDEX agent_edit_project_page ON agent_edit_proposals(projectId,position DESC);
CREATE INDEX asset_ranges_project ON asset_ranges(projectId,assetId);
CREATE INDEX asset_dispositions_project ON asset_dispositions(projectId,assetId);
CREATE INDEX waveform_cache_terminal ON waveform_cache(status,position);
CREATE INDEX subjects_project_page ON subjects(projectId,id);
CREATE INDEX subject_versions_page ON subject_versions(projectId,subjectId,number);
CREATE INDEX subject_bindings_shot_page ON subject_bindings(projectId,shotId,id);
CREATE INDEX subject_bindings_subject_page ON subject_bindings(projectId,subjectId,id);
CREATE INDEX subject_bindings_active_shot ON subject_bindings(shotId) WHERE subjectVersionId IS NOT NULL;
CREATE UNIQUE INDEX edit_task_one_pending_lane ON edit_tasks(projectId,lane) WHERE acknowledged=0;
CREATE INDEX edit_tasks_project_page ON edit_tasks(projectId,position DESC);
CREATE INDEX edit_tasks_project_pending_page ON edit_tasks(projectId,acknowledged,position DESC);
CREATE TRIGGER immutable_versions BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'versions are immutable');END;
CREATE TRIGGER immutable_timeline_responses BEFORE UPDATE ON timeline_requests BEGIN SELECT RAISE(ABORT,'timeline request responses are immutable');END;
CREATE TRIGGER immutable_timeline_render_snapshot BEFORE UPDATE ON exports
 WHEN json_extract(OLD.data,'$.mode')='timeline' AND (
 json_extract(NEW.data,'$.mode') IS NOT 'timeline' OR
 json_extract(NEW.data,'$.snapshot') IS NOT json_extract(OLD.data,'$.snapshot') OR
 json_extract(NEW.data,'$.timelineRevision') IS NOT json_extract(OLD.data,'$.timelineRevision') OR
 json_extract(NEW.data,'$.purpose') IS NOT json_extract(OLD.data,'$.purpose'))
 BEGIN SELECT RAISE(ABORT,'timeline render snapshots are immutable');END;
CREATE TRIGGER immutable_timeline_history BEFORE UPDATE ON timeline_history
 BEGIN SELECT RAISE(ABORT,'timeline history entries are immutable');END;
CREATE TRIGGER immutable_reference_responses BEFORE UPDATE ON reference_requests
 BEGIN SELECT RAISE(ABORT,'reference request responses are immutable');END;
CREATE TRIGGER reject_reference_request_replacement BEFORE INSERT ON reference_requests
 WHEN EXISTS(SELECT 1 FROM reference_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'reference request responses are immutable');END;
CREATE TRIGGER retain_reference_requests BEFORE DELETE ON reference_requests
 BEGIN SELECT RAISE(ABORT,'reference request responses must be retained');END;
CREATE TRIGGER immutable_agent_chat_requests BEFORE UPDATE ON agent_chat_requests
 BEGIN SELECT RAISE(ABORT,'accepted chat requests are immutable');END;
CREATE TRIGGER retain_agent_chat_requests BEFORE DELETE ON agent_chat_requests
 BEGIN SELECT RAISE(ABORT,'accepted chat requests must be retained');END;
CREATE TRIGGER immutable_agent_chat_run_identity BEFORE UPDATE ON agent_chat_runs
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.threadId IS NOT OLD.threadId OR
 NEW.requestId IS NOT OLD.requestId OR NEW.position IS NOT OLD.position OR
 json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR
 json_extract(NEW.data,'$.requestId') IS NOT json_extract(OLD.data,'$.requestId') OR
 json_extract(NEW.data,'$.threadId') IS NOT json_extract(OLD.data,'$.threadId') OR
 json_extract(NEW.data,'$.projectId') IS NOT json_extract(OLD.data,'$.projectId') OR
 json_extract(NEW.data,'$.userText') IS NOT json_extract(OLD.data,'$.userText') OR
 json_extract(NEW.data,'$.configuration') IS NOT json_extract(OLD.data,'$.configuration') OR
 json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt') OR
 json_extract(NEW.data,'$.modelRequestId') IS NOT json_extract(OLD.data,'$.modelRequestId')
 BEGIN SELECT RAISE(ABORT,'accepted chat identity and configuration are immutable');END;
CREATE TRIGGER immutable_agent_chat_events BEFORE UPDATE ON agent_chat_events
 BEGIN SELECT RAISE(ABORT,'chat events are immutable');END;
CREATE TRIGGER retain_agent_chat_events BEFORE DELETE ON agent_chat_events
 BEGIN SELECT RAISE(ABORT,'chat events must be retained');END;
CREATE TRIGGER immutable_agent_chat_step_payload BEFORE UPDATE ON agent_chat_steps
 WHEN NEW.id IS NOT OLD.id OR NEW.runId IS NOT OLD.runId OR NEW.projectId IS NOT OLD.projectId OR
 NEW.position IS NOT OLD.position OR NEW.kind IS NOT OLD.kind OR
 json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR
 json_extract(NEW.data,'$.runId') IS NOT json_extract(OLD.data,'$.runId') OR
 json_extract(NEW.data,'$.projectId') IS NOT json_extract(OLD.data,'$.projectId') OR
 json_extract(NEW.data,'$.position') IS NOT json_extract(OLD.data,'$.position') OR
 json_extract(NEW.data,'$.kind') IS NOT json_extract(OLD.data,'$.kind') OR
 json_extract(NEW.data,'$.ordinal') IS NOT json_extract(OLD.data,'$.ordinal') OR
 json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt') OR
 json_extract(NEW.data,'$.requestId') IS NOT json_extract(OLD.data,'$.requestId') OR
 json_extract(NEW.data,'$.request') IS NOT json_extract(OLD.data,'$.request') OR
 json_extract(NEW.data,'$.modelStepId') IS NOT json_extract(OLD.data,'$.modelStepId') OR
 json_extract(NEW.data,'$.intent') IS NOT json_extract(OLD.data,'$.intent') OR
 (json_type(OLD.data,'$.output') IS NOT NULL AND json_extract(NEW.data,'$.output') IS NOT json_extract(OLD.data,'$.output')) OR
 (json_type(OLD.data,'$.observation') IS NOT NULL AND json_extract(NEW.data,'$.observation') IS NOT json_extract(OLD.data,'$.observation'))
 BEGIN SELECT RAISE(ABORT,'agent step payloads are immutable');END;
CREATE TRIGGER retain_agent_chat_steps BEFORE DELETE ON agent_chat_steps
 BEGIN SELECT RAISE(ABORT,'agent steps must be retained');END;
CREATE TRIGGER immutable_agent_chat_inspection_context BEFORE UPDATE ON agent_chat_runs
 WHEN json_extract(NEW.data,'$.contextMode') IS NOT json_extract(OLD.data,'$.contextMode') OR
 json_extract(NEW.data,'$.provenance') IS NOT json_extract(OLD.data,'$.provenance')
 BEGIN SELECT RAISE(ABORT,'accepted inspection context is immutable');END;
CREATE TRIGGER reject_mutation_request_replacement BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request responses are immutable');END;
CREATE TRIGGER immutable_mutation_requests BEFORE UPDATE ON mutation_requests
 BEGIN SELECT RAISE(ABORT,'mutation request responses are immutable');END;
CREATE TRIGGER retain_mutation_requests BEFORE DELETE ON mutation_requests
 BEGIN SELECT RAISE(ABORT,'mutation request responses must be retained');END;
CREATE TRIGGER reject_agent_edit_replacement BEFORE INSERT ON agent_edit_proposals
 WHEN EXISTS(SELECT 1 FROM agent_edit_proposals WHERE id=NEW.id OR runId=NEW.runId)
 BEGIN SELECT RAISE(ABORT,'agent edit identities are immutable');END;
CREATE TRIGGER immutable_agent_edit_intent BEFORE UPDATE ON agent_edit_proposals
 WHEN NEW.position IS NOT OLD.position OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR
 NEW.runId IS NOT OLD.runId OR NEW.shotId IS NOT OLD.shotId OR NEW.digest IS NOT OLD.digest OR
 NEW.definition IS NOT OLD.definition OR NEW.createdAt IS NOT OLD.createdAt OR NEW.bytes IS NOT OLD.bytes OR
 (OLD.approval IS NOT NULL AND NEW.approval IS NOT OLD.approval) OR
 (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
 BEGIN SELECT RAISE(ABORT,'agent edit intent and approval are immutable');END;
CREATE TRIGGER guard_agent_edit_transition BEFORE UPDATE ON agent_edit_proposals
 WHEN NEW.status IS NOT OLD.status AND NOT (
 (OLD.status='pending' AND NEW.status IN ('approved','rejected','cancelled')) OR
 (OLD.status='approved' AND NEW.status IN ('dispatching','unknown','applied')) OR
 (OLD.status='dispatching' AND NEW.status IN ('unknown','applied','failed')) OR
 (OLD.status='unknown' AND NEW.status IN ('dispatching','applied')))
 BEGIN SELECT RAISE(ABORT,'invalid agent edit transition');END;
CREATE TRIGGER retain_agent_edit_proposals BEFORE DELETE ON agent_edit_proposals
 BEGIN SELECT RAISE(ABORT,'agent edit proposals must be retained');END;
CREATE TRIGGER immutable_agent_chat_edit_target BEFORE UPDATE ON agent_chat_runs
 WHEN json_extract(NEW.data,'$.editTarget') IS NOT json_extract(OLD.data,'$.editTarget')
 BEGIN SELECT RAISE(ABORT,'accepted shot edit target is immutable');END;
CREATE TRIGGER immutable_asset_range_identity BEFORE UPDATE ON asset_ranges
 WHEN NEW.assetId IS NOT OLD.assetId OR NEW.projectId IS NOT OLD.projectId
 BEGIN SELECT RAISE(ABORT,'source range identity is immutable');END;
CREATE TRIGGER reject_asset_range_request_replacement BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'source range request responses are immutable');END;
CREATE TRIGGER immutable_asset_range_requests BEFORE UPDATE ON asset_range_requests
 BEGIN SELECT RAISE(ABORT,'source range request responses are immutable');END;
CREATE TRIGGER retain_asset_range_requests BEFORE DELETE ON asset_range_requests
 BEGIN SELECT RAISE(ABORT,'source range request responses must be retained');END;
CREATE TRIGGER reject_asset_range_cross_request BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
CREATE TRIGGER reject_mutation_cross_range_request BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
CREATE TRIGGER immutable_asset_disposition_identity BEFORE UPDATE ON asset_dispositions
 WHEN NEW.assetId IS NOT OLD.assetId OR NEW.projectId IS NOT OLD.projectId
 BEGIN SELECT RAISE(ABORT,'asset disposition identity is immutable');END;
CREATE TRIGGER reject_asset_disposition_request_replacement BEFORE INSERT ON asset_disposition_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'asset disposition request responses are immutable');END;
CREATE TRIGGER immutable_asset_disposition_requests BEFORE UPDATE ON asset_disposition_requests
 BEGIN SELECT RAISE(ABORT,'asset disposition request responses are immutable');END;
CREATE TRIGGER retain_asset_disposition_requests BEFORE DELETE ON asset_disposition_requests
 BEGIN SELECT RAISE(ABORT,'asset disposition request responses must be retained');END;
CREATE TRIGGER reject_asset_disposition_cross_request BEFORE INSERT ON asset_disposition_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId) OR
 EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
CREATE TRIGGER reject_mutation_cross_disposition_request BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
CREATE TRIGGER reject_asset_range_cross_disposition_request BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
CREATE TRIGGER immutable_subject_identity BEFORE UPDATE ON subjects
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.kind IS NOT OLD.kind OR NEW.name IS NOT OLD.name OR NEW.createdAt IS NOT OLD.createdAt OR NEW.revision IS NOT OLD.revision+1 OR NEW.headVersionId IS OLD.headVersionId
 BEGIN SELECT RAISE(ABORT,'subject identity is immutable and revisions must advance');END;
CREATE TRIGGER reject_subject_replacement BEFORE INSERT ON subjects WHEN EXISTS(SELECT 1 FROM subjects WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'subjects cannot be replaced');END;
CREATE TRIGGER immutable_subject_versions BEFORE UPDATE ON subject_versions BEGIN SELECT RAISE(ABORT,'subject versions are immutable');END;
CREATE TRIGGER retain_subject_versions BEFORE DELETE ON subject_versions BEGIN SELECT RAISE(ABORT,'subject versions must be retained');END;
CREATE TRIGGER reject_subject_version_replacement BEFORE INSERT ON subject_versions
 WHEN EXISTS(SELECT 1 FROM subject_versions WHERE id=NEW.id OR (subjectId=NEW.subjectId AND number=NEW.number))
 BEGIN SELECT RAISE(ABORT,'subject versions are immutable');END;
CREATE TRIGGER immutable_subject_binding_identity BEFORE UPDATE ON subject_bindings
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.shotId IS NOT OLD.shotId OR NEW.subjectId IS NOT OLD.subjectId OR NEW.role IS NOT OLD.role OR NEW.createdAt IS NOT OLD.createdAt OR NEW.revision IS NOT OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'subject binding identity is immutable and revisions must advance');END;
CREATE TRIGGER reject_subject_binding_replacement BEFORE INSERT ON subject_bindings
 WHEN EXISTS(SELECT 1 FROM subject_bindings WHERE id=NEW.id OR (shotId=NEW.shotId AND subjectId=NEW.subjectId AND role=NEW.role))
 BEGIN SELECT RAISE(ABORT,'subject binding tombstones must be retained');END;
CREATE TRIGGER retain_subject_bindings BEFORE DELETE ON subject_bindings BEGIN SELECT RAISE(ABORT,'subject binding tombstones must be retained');END;
CREATE TRIGGER immutable_subject_requests BEFORE UPDATE ON subject_requests BEGIN SELECT RAISE(ABORT,'subject request responses are immutable');END;
CREATE TRIGGER retain_subject_requests BEFORE DELETE ON subject_requests BEGIN SELECT RAISE(ABORT,'subject request responses must be retained');END;
CREATE TRIGGER reject_subject_request_replacement BEFORE INSERT ON subject_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'subject request responses are immutable');END;
CREATE TRIGGER reject_subject_cross_request BEFORE INSERT ON subject_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId) OR EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId) OR EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
CREATE TRIGGER reject_mutation_cross_subject_request BEFORE INSERT ON mutation_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
CREATE TRIGGER reject_asset_range_cross_subject_request BEFORE INSERT ON asset_range_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
CREATE TRIGGER reject_asset_disposition_cross_subject_request BEFORE INSERT ON asset_disposition_requests WHEN EXISTS(SELECT 1 FROM subject_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
CREATE TRIGGER reject_edit_task_replacement BEFORE INSERT ON edit_tasks
 WHEN EXISTS(SELECT 1 FROM edit_tasks WHERE id=NEW.id OR position=NEW.position OR (lane=NEW.lane AND requestId=NEW.requestId))
 BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END;
CREATE TRIGGER immutable_edit_task_identity BEFORE UPDATE ON edit_tasks
 WHEN NEW.position IS NOT OLD.position OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR
 NEW.operation IS NOT OLD.operation OR NEW.input IS NOT OLD.input OR NEW.requestId IS NOT OLD.requestId OR
 NEW.digest IS NOT OLD.digest OR NEW.lane IS NOT OLD.lane OR NEW.origin IS NOT OLD.origin OR
 NEW.createdAt IS NOT OLD.createdAt OR NEW.bytes IS NOT OLD.bytes
 BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END;
CREATE TRIGGER retain_edit_tasks BEFORE DELETE ON edit_tasks
 BEGIN SELECT RAISE(ABORT,'edit task identities must be retained');END;
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
INSERT INTO schema_version VALUES(1);
INSERT INTO schema_version VALUES(2);
INSERT INTO schema_version VALUES(3);
INSERT INTO schema_version VALUES(4);
INSERT INTO schema_version VALUES(5);
INSERT INTO schema_version VALUES(6);
INSERT INTO schema_version VALUES(7);
INSERT INTO schema_version VALUES(8);
INSERT INTO schema_version VALUES(9);
INSERT INTO schema_version VALUES(10);
INSERT INTO schema_version VALUES(11);
INSERT INTO schema_version VALUES(12);
INSERT INTO schema_version VALUES(13);
INSERT INTO schema_version VALUES(14);
INSERT INTO schema_version VALUES(15);
