// The caller owns one transaction including review rebuild and schema marker.
// Legacy rows and request journals remain byte-exact. One lifecycle trigger
// gains only the verified, explicitly observed local-Comfy failure branch.
export function migrateComfyImageSchema(db) {
  if(!db.isTransaction)throw new Error('Comfy image migration requires a transaction');
  db.exec(COMFY_IMAGE_SCHEMA_19_SQL);
  const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='image_task_state_transitions'").get();
  if(!trigger)throw new Error('Comfy image migration requires image lifecycle schema');
  if(!trigger.sql.includes('image_remote_observations')){
    const old="(OLD.state IN ('local_result_error','outcome_unknown') AND NEW.state='persisting'))";
    if(!trigger.sql.includes(old))throw new Error('Unrecognized image lifecycle transition trigger');
    const narrowed=`(OLD.state IN ('local_result_error','outcome_unknown') AND NEW.state='persisting') OR
 (OLD.state='outcome_unknown' AND NEW.state='failed' AND json_extract(OLD.input,'$.providerId')='comfy-local'
 AND EXISTS(SELECT 1 FROM image_remote_runs r JOIN image_remote_observations o ON o.taskId=r.taskId AND o.projectId=r.projectId
 WHERE r.taskId=OLD.id AND r.projectId=OLD.projectId AND r.state='failed' AND r.contentVerified=1
 AND o.state='running' AND r.revision>o.remoteRevision)))`;
    db.exec('DROP TRIGGER image_task_state_transitions');
    db.exec(trigger.sql.replace(old,narrowed));
  }
}
const COMFY_IMAGE_SCHEMA_19_SQL=`
CREATE TABLE IF NOT EXISTS image_remote_runs(
 taskId TEXT PRIMARY KEY NOT NULL REFERENCES image_tasks(id) CHECK(length(CAST(taskId AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),reviewId TEXT NOT NULL UNIQUE REFERENCES image_reviews(id) CHECK(length(CAST(reviewId AS BLOB))=36),
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
CREATE INDEX IF NOT EXISTS image_remote_runs_project ON image_remote_runs(projectId,taskId);
CREATE TRIGGER IF NOT EXISTS image_remote_run_insert_identity BEFORE INSERT ON image_remote_runs
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
CREATE TRIGGER IF NOT EXISTS immutable_image_remote_run_identity BEFORE UPDATE ON image_remote_runs
 WHEN NEW.taskId IS NOT OLD.taskId OR NEW.projectId IS NOT OLD.projectId OR NEW.reviewId IS NOT OLD.reviewId OR
 NEW.promptId IS NOT OLD.promptId OR NEW.clientId IS NOT OLD.clientId OR NEW.outputNonce IS NOT OLD.outputNonce OR
 NEW.filenamePrefix IS NOT OLD.filenamePrefix OR NEW.workflowId IS NOT OLD.workflowId OR NEW.workflowVersion IS NOT OLD.workflowVersion OR
 NEW.comfyVersion IS NOT OLD.comfyVersion OR NEW.seed IS NOT OLD.seed OR NEW.baseUrl IS NOT OLD.baseUrl OR NEW.graphHash IS NOT OLD.graphHash OR
 NEW.rawGraph IS NOT OLD.rawGraph OR NEW.createdAt IS NOT OLD.createdAt OR NEW.contentVerified<OLD.contentVerified OR
 (OLD.outputDescriptor IS NOT NULL AND NEW.outputDescriptor IS NOT OLD.outputDescriptor) OR
 (OLD.resultSha256 IS NOT NULL AND NEW.resultSha256 IS NOT OLD.resultSha256) OR (OLD.resultBytes IS NOT NULL AND NEW.resultBytes IS NOT OLD.resultBytes)
 BEGIN SELECT RAISE(ABORT,'remote image execution identity is immutable');END;
CREATE TRIGGER IF NOT EXISTS image_remote_run_transition BEFORE UPDATE ON image_remote_runs
 WHEN NEW.revision IS NOT OLD.revision+1 OR (OLD.state IN ('completed','failed') AND NEW.state IS NOT OLD.state) OR
 (OLD.state IS NOT 'prepared' AND NEW.state='prepared')
 BEGIN SELECT RAISE(ABORT,'invalid remote image transition');END;
CREATE TRIGGER IF NOT EXISTS retain_image_remote_runs BEFORE DELETE ON image_remote_runs
 BEGIN SELECT RAISE(ABORT,'remote image identities must be retained');END;
CREATE TRIGGER IF NOT EXISTS reject_image_remote_run_replacement BEFORE INSERT ON image_remote_runs
 WHEN EXISTS(SELECT 1 FROM image_remote_runs WHERE taskId=NEW.taskId OR reviewId=NEW.reviewId OR promptId=NEW.promptId OR outputNonce=NEW.outputNonce)
 BEGIN SELECT RAISE(ABORT,'remote image identities cannot be replaced');END;
CREATE TABLE IF NOT EXISTS image_remote_observations(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 id TEXT NOT NULL UNIQUE CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),taskId TEXT NOT NULL REFERENCES image_remote_runs(taskId) CHECK(length(CAST(taskId AS BLOB))=36),
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
CREATE INDEX IF NOT EXISTS image_remote_observations_task ON image_remote_observations(projectId,taskId,createdAt DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS image_remote_observations_one_active ON image_remote_observations(taskId) WHERE state IN ('queued','running');
CREATE TRIGGER IF NOT EXISTS image_remote_observation_admission BEFORE INSERT ON image_remote_observations
 WHEN NEW.state IS NOT 'queued' OR NEW.revision IS NOT 1 OR NEW.errorCode IS NOT NULL OR
 NOT EXISTS(SELECT 1 FROM image_remote_runs WHERE taskId=NEW.taskId AND projectId=NEW.projectId AND revision=NEW.remoteRevision)
 BEGIN SELECT RAISE(ABORT,'remote observation must bind its durable claim');END;
CREATE TRIGGER IF NOT EXISTS immutable_image_remote_observation BEFORE UPDATE ON image_remote_observations
 WHEN NEW.requestId IS NOT OLD.requestId OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.taskId IS NOT OLD.taskId OR
 NEW.inputHash IS NOT OLD.inputHash OR NEW.canonicalInput IS NOT OLD.canonicalInput OR NEW.response IS NOT OLD.response OR
 NEW.remoteRevision IS NOT OLD.remoteRevision OR NEW.createdAt IS NOT OLD.createdAt
 BEGIN SELECT RAISE(ABORT,'remote observation request and acknowledgement are immutable');END;
CREATE TRIGGER IF NOT EXISTS image_remote_observation_transition BEFORE UPDATE ON image_remote_observations
 WHEN NEW.revision IS NOT OLD.revision+1 OR NOT ((OLD.state='queued' AND NEW.state IN ('running','interrupted')) OR (OLD.state='running' AND NEW.state IN ('finished','interrupted')))
 BEGIN SELECT RAISE(ABORT,'invalid remote observation transition');END;
CREATE TRIGGER IF NOT EXISTS retain_image_remote_observations BEFORE DELETE ON image_remote_observations
 BEGIN SELECT RAISE(ABORT,'remote observations must be retained');END;
CREATE TRIGGER IF NOT EXISTS reject_image_remote_observation_replacement BEFORE INSERT ON image_remote_observations
 WHEN EXISTS(SELECT 1 FROM image_remote_observations WHERE requestId=NEW.requestId OR id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'remote observations cannot be replaced');END;
CREATE TRIGGER IF NOT EXISTS reject_image_observation_cross_request BEFORE INSERT ON image_remote_observations
 WHEN EXISTS(SELECT 1 FROM image_requests WHERE requestId=NEW.requestId) OR EXISTS(SELECT 1 FROM image_reviews WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request identity is already retained');END;
CREATE TRIGGER IF NOT EXISTS reject_image_request_cross_observation BEFORE INSERT ON image_requests
 WHEN EXISTS(SELECT 1 FROM image_remote_observations WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request identity is already retained');END;
CREATE TRIGGER IF NOT EXISTS reject_image_review_cross_observation BEFORE INSERT ON image_reviews
 WHEN EXISTS(SELECT 1 FROM image_remote_observations WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request identity is already retained');END;
`;
