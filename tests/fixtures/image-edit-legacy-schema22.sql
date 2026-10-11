-- Frozen schema22 from baseline 07ee1910f00822607a739df6b543bb92a3f7d7b5.
-- Independent migration input: never construct with the current schema23 migration.
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
CREATE TABLE image_groups(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),
 name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 480),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 headVersionId TEXT,activeTaskId TEXT,createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 UNIQUE(id,projectId),FOREIGN KEY(headVersionId,id,projectId) REFERENCES image_versions(id,groupId,projectId) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(activeTaskId,id,projectId) REFERENCES image_tasks(id,groupId,projectId) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE image_tasks(
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
CREATE TABLE image_versions(
 id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),projectId TEXT NOT NULL REFERENCES projects(id),groupId TEXT NOT NULL,taskId TEXT NOT NULL UNIQUE,
 number INTEGER NOT NULL CHECK(typeof(number)='integer' AND number BETWEEN 1 AND 9007199254740991),assetId TEXT NOT NULL UNIQUE REFERENCES assets(id),
 data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4096),
 UNIQUE(groupId,number),UNIQUE(id,groupId,projectId),UNIQUE(id,taskId,groupId,projectId),
 FOREIGN KEY(groupId,projectId) REFERENCES image_groups(id,projectId),FOREIGN KEY(taskId,groupId,projectId) REFERENCES image_tasks(id,groupId,projectId),
 CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.groupId') IS groupId AND json_extract(data,'$.taskId') IS taskId AND json_extract(data,'$.number') IS number AND json_extract(data,'$.assetId') IS assetId));
CREATE TABLE image_requests(
 requestId TEXT PRIMARY KEY CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('image.generate','image.task.cancelQueued','image.task.recoverResult')),projectId TEXT NOT NULL REFERENCES projects(id),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 24576),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 32768),
 CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId AND json_extract(response,'$.projectId') IS projectId));
CREATE TABLE "image_reviews"(
      id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),
      projectId TEXT NOT NULL REFERENCES projects(id),
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
      CONSTRAINT image_review_intent_v19 CHECK(
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
      ),
      CHECK(json_extract(canonicalIntent,'$.policy.maxPostAttempts') IS 1 AND json_extract(canonicalIntent,'$.policy.automaticRetry') IS 0),
      CHECK((taskId IS NOT NULL)=(state IN ('approved','dispatched')) AND (approvedAt IS NOT NULL)=(state IN ('approved','dispatched'))),
      CHECK((rejectedAt IS NOT NULL)=(state='rejected') AND (dispatchedAt IS NOT NULL)=(state='dispatched')),
      CHECK(postAttempts=(state='dispatched') AND revision=CASE state WHEN 'pending' THEN 1 WHEN 'dispatched' THEN 3 ELSE 2 END),
      CHECK(length(CAST(canonicalInput AS BLOB))+length(CAST(canonicalIntent AS BLOB))+length(CAST(requestId AS BLOB))+512<=65536)
    );
CREATE TABLE image_remote_runs(
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
CREATE TABLE image_remote_observations(
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
CREATE TABLE frame_tasks(
 id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 requestId TEXT NOT NULL UNIQUE CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 4096),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND json_type(snapshot)='object' AND length(CAST(snapshot AS BLOB)) BETWEEN 1 AND 4096),
 state TEXT NOT NULL CHECK(state IN ('queued','running','persisting','succeeded','cancelled_before_start','interrupted','local_result_error','failed')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 started INTEGER NOT NULL CHECK(started IN (0,1)),
 stagedReceipt TEXT CHECK(stagedReceipt IS NULL OR (json_valid(stagedReceipt) AND json_type(stagedReceipt)='object' AND length(CAST(stagedReceipt AS BLOB)) BETWEEN 1 AND 4096)),
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
CREATE TABLE frame_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('frame.extract','frame.task.cancelQueued','frame.task.recoverResult')),
 projectId TEXT NOT NULL REFERENCES projects(id),taskId TEXT NOT NULL,
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
CREATE TABLE timeline_format_requests(
 requestId TEXT NOT NULL PRIMARY KEY REFERENCES timeline_requests(requestId) CHECK(length(requestId) BETWEEN 8 AND 200),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 input TEXT NOT NULL CHECK(typeof(input)='text' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 2048 AND json_valid(input) AND json_type(input)='object'),
 CHECK(json_extract(input,'$.projectId') IS projectId AND json_extract(input,'$.requestId') IS requestId));
CREATE TABLE "edit_tasks"(
 position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 operation TEXT NOT NULL CHECK(operation IN ('timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','timeline.format.set','subject.create','subject.version.add','subject.binding.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove')),
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
CREATE INDEX image_groups_project_page ON image_groups(projectId,createdAt DESC,id DESC);
CREATE INDEX image_tasks_project_page ON image_tasks(projectId,createdAt DESC,id DESC);
CREATE INDEX image_tasks_group_page ON image_tasks(projectId,groupId,createdAt DESC,id DESC);
CREATE INDEX image_tasks_state ON image_tasks(state,projectId,id);
CREATE UNIQUE INDEX image_tasks_one_unresolved_group ON image_tasks(groupId) WHERE state IN ('queued','interrupted_before_dispatch','dispatching','receiving','persisting','outcome_unknown','local_result_error');
CREATE INDEX image_versions_group_page ON image_versions(projectId,groupId,number DESC);
CREATE INDEX image_reviews_project_page ON image_reviews(projectId,createdAt DESC,id DESC);
CREATE INDEX image_remote_runs_project ON image_remote_runs(projectId,taskId);
CREATE INDEX image_remote_observations_task ON image_remote_observations(projectId,taskId,createdAt DESC,id DESC);
CREATE UNIQUE INDEX image_remote_observations_one_active ON image_remote_observations(taskId) WHERE state IN ('queued','running');
CREATE INDEX frame_tasks_project_page ON frame_tasks(projectId,createdAt DESC,id DESC);
CREATE INDEX frame_tasks_state ON frame_tasks(state,projectId,id);
CREATE UNIQUE INDEX frame_tasks_receipt_asset ON frame_tasks(json_extract(stagedReceipt,'$.assetId')) WHERE stagedReceipt IS NOT NULL;
CREATE INDEX frame_requests_task ON frame_requests(taskId,requestId);
CREATE INDEX frame_requests_project ON frame_requests(projectId,requestId);
CREATE INDEX timeline_format_requests_project ON timeline_format_requests(projectId,requestId);
CREATE INDEX timeline_requests_project ON timeline_requests(CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 4194304
 THEN CASE WHEN json_valid(response) THEN CASE WHEN json_type(response,'$.projectId')='text' AND length(CAST(json_extract(response,'$.projectId') AS BLOB))=36
 THEN json_extract(response,'$.projectId') END END END,requestId);
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
CREATE TRIGGER immutable_image_group_identity BEFORE UPDATE ON image_groups
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.name IS NOT OLD.name OR NEW.createdAt IS NOT OLD.createdAt OR NEW.revision IS NOT OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'image group identity is immutable and revisions must advance');END;
CREATE TRIGGER image_group_head_advances BEFORE UPDATE ON image_groups
 WHEN NEW.headVersionId IS NOT OLD.headVersionId AND (NEW.headVersionId IS NULL OR NOT EXISTS(
 SELECT 1 FROM image_versions WHERE id=NEW.headVersionId AND groupId=NEW.id AND projectId=NEW.projectId AND number=COALESCE((SELECT number FROM image_versions WHERE id=OLD.headVersionId),0)+1))
 BEGIN SELECT RAISE(ABORT,'image group head must advance one retained version');END;
CREATE TRIGGER retain_image_groups BEFORE DELETE ON image_groups BEGIN SELECT RAISE(ABORT,'image groups must be retained');END;
CREATE TRIGGER reject_image_group_replacement BEFORE INSERT ON image_groups WHEN EXISTS(SELECT 1 FROM image_groups WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'image groups cannot be replaced');END;
CREATE TRIGGER immutable_image_task_identity BEFORE UPDATE ON image_tasks
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.groupId IS NOT OLD.groupId OR NEW.requestId IS NOT OLD.requestId OR NEW.inputHash IS NOT OLD.inputHash OR NEW.input IS NOT OLD.input OR NEW.snapshot IS NOT OLD.snapshot OR NEW.createdAt IS NOT OLD.createdAt OR (OLD.stagedReceipt IS NOT NULL AND NEW.stagedReceipt IS NOT OLD.stagedReceipt) OR NEW.dispatched<OLD.dispatched
 BEGIN SELECT RAISE(ABORT,'image task identity and durable result are immutable');END;
CREATE TRIGGER retain_image_tasks BEFORE DELETE ON image_tasks BEGIN SELECT RAISE(ABORT,'image tasks must be retained');END;
CREATE TRIGGER reject_image_task_replacement BEFORE INSERT ON image_tasks WHEN EXISTS(SELECT 1 FROM image_tasks WHERE id=NEW.id OR requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image tasks cannot be replaced');END;
CREATE TRIGGER immutable_image_versions BEFORE UPDATE ON image_versions BEGIN SELECT RAISE(ABORT,'image versions are immutable');END;
CREATE TRIGGER retain_image_versions BEFORE DELETE ON image_versions BEGIN SELECT RAISE(ABORT,'image versions must be retained');END;
CREATE TRIGGER reject_image_version_replacement BEFORE INSERT ON image_versions
 WHEN EXISTS(SELECT 1 FROM image_versions WHERE id=NEW.id OR taskId=NEW.taskId OR assetId=NEW.assetId OR (groupId=NEW.groupId AND number=NEW.number))
 BEGIN SELECT RAISE(ABORT,'image versions are immutable');END;
CREATE TRIGGER image_version_number_advances BEFORE INSERT ON image_versions
 WHEN NEW.number IS NOT COALESCE((SELECT MAX(number) FROM image_versions WHERE groupId=NEW.groupId),0)+1
 BEGIN SELECT RAISE(ABORT,'image version number must advance');END;
CREATE TRIGGER reject_image_legacy_asset_owner BEFORE INSERT ON image_versions
 WHEN EXISTS(SELECT 1 FROM versions WHERE CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND 65536
  THEN CASE WHEN json_valid(data) THEN CASE WHEN json_type(data,'$.assetId')='text' AND length(CAST(json_extract(data,'$.assetId') AS BLOB))=36
    THEN json_extract(data,'$.assetId') END END END=NEW.assetId)
 OR EXISTS(SELECT 1 FROM versions WHERE length(CAST(data AS BLOB))>65536 AND CASE WHEN json_valid(data) THEN json_extract(data,'$.assetId') END=NEW.assetId)
 BEGIN SELECT RAISE(ABORT,'image asset already has an owner');END;
CREATE TRIGGER reject_legacy_image_asset_owner BEFORE INSERT ON versions
 WHEN json_valid(NEW.data) AND EXISTS(SELECT 1 FROM image_versions WHERE assetId=json_extract(NEW.data,'$.assetId'))
 BEGIN SELECT RAISE(ABORT,'image asset already has an owner');END;
CREATE TRIGGER immutable_image_requests BEFORE UPDATE ON image_requests BEGIN SELECT RAISE(ABORT,'image request responses are immutable');END;
CREATE TRIGGER retain_image_requests BEFORE DELETE ON image_requests BEGIN SELECT RAISE(ABORT,'image request responses must be retained');END;
CREATE TRIGGER reject_image_request_replacement BEFORE INSERT ON image_requests WHEN EXISTS(SELECT 1 FROM image_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request responses are immutable');END;
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
CREATE TRIGGER reject_image_review_replacement BEFORE INSERT ON image_reviews
      WHEN EXISTS(SELECT 1 FROM image_reviews WHERE id=NEW.id OR requestId=NEW.requestId)
      BEGIN SELECT RAISE(ABORT,'image reviews cannot be replaced'); END;
CREATE TRIGGER retain_image_reviews BEFORE DELETE ON image_reviews
      BEGIN SELECT RAISE(ABORT,'image reviews must be retained'); END;
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
CREATE TRIGGER retain_image_remote_runs BEFORE DELETE ON image_remote_runs
 BEGIN SELECT RAISE(ABORT,'remote image identities must be retained');END;
CREATE TRIGGER reject_image_remote_run_replacement BEFORE INSERT ON image_remote_runs
 WHEN EXISTS(SELECT 1 FROM image_remote_runs WHERE taskId=NEW.taskId OR reviewId=NEW.reviewId OR promptId=NEW.promptId OR outputNonce=NEW.outputNonce)
 BEGIN SELECT RAISE(ABORT,'remote image identities cannot be replaced');END;
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
CREATE TRIGGER retain_image_remote_observations BEFORE DELETE ON image_remote_observations
 BEGIN SELECT RAISE(ABORT,'remote observations must be retained');END;
CREATE TRIGGER reject_image_remote_observation_replacement BEFORE INSERT ON image_remote_observations
 WHEN EXISTS(SELECT 1 FROM image_remote_observations WHERE requestId=NEW.requestId OR id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'remote observations cannot be replaced');END;
CREATE TRIGGER reject_image_observation_cross_request BEFORE INSERT ON image_remote_observations
 WHEN EXISTS(SELECT 1 FROM image_requests WHERE requestId=NEW.requestId) OR EXISTS(SELECT 1 FROM image_reviews WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request identity is already retained');END;
CREATE TRIGGER reject_image_request_cross_observation BEFORE INSERT ON image_requests
 WHEN EXISTS(SELECT 1 FROM image_remote_observations WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request identity is already retained');END;
CREATE TRIGGER reject_image_review_cross_observation BEFORE INSERT ON image_reviews
 WHEN EXISTS(SELECT 1 FROM image_remote_observations WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'image request identity is already retained');END;
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
CREATE TRIGGER retain_frame_tasks BEFORE DELETE ON frame_tasks
 BEGIN SELECT RAISE(ABORT,'frame tasks must be retained');END;
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
CREATE TRIGGER retain_frame_requests BEFORE DELETE ON frame_requests
 BEGIN SELECT RAISE(ABORT,'frame request responses must be retained');END;
CREATE TRIGGER reject_frame_request_replacement BEFORE INSERT ON frame_requests
 WHEN EXISTS(SELECT 1 FROM frame_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'frame request responses cannot be replaced');END;
CREATE TRIGGER frame_request_capacity BEFORE INSERT ON frame_requests
 WHEN (SELECT COUNT(*) FROM frame_requests WHERE taskId=NEW.taskId)>=16
 BEGIN SELECT RAISE(ABORT,'frame retained request capacity exceeded');END;
CREATE TRIGGER frame_asset_project BEFORE UPDATE OF assetId ON frame_tasks
 WHEN NEW.assetId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assets WHERE id=NEW.assetId AND projectId=NEW.projectId)
 BEGIN SELECT RAISE(ABORT,'frame result must belong to its task project');END;
CREATE TRIGGER reject_frame_mixed_asset_owner BEFORE UPDATE OF stagedReceipt,assetId ON frame_tasks
 WHEN NEW.stagedReceipt IS NOT NULL AND (EXISTS(SELECT 1 FROM versions WHERE CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND 65536
  THEN CASE WHEN json_valid(data) THEN CASE WHEN json_type(data,'$.assetId')='text' AND length(CAST(json_extract(data,'$.assetId') AS BLOB))=36
    THEN json_extract(data,'$.assetId') END END END=CASE WHEN json_valid(NEW.stagedReceipt) THEN json_extract(NEW.stagedReceipt,'$.assetId') END)
 OR EXISTS(SELECT 1 FROM versions WHERE length(CAST(data AS BLOB))>65536
 AND CASE WHEN json_valid(data) THEN json_extract(data,'$.assetId') END=CASE WHEN json_valid(NEW.stagedReceipt) THEN json_extract(NEW.stagedReceipt,'$.assetId') END)
 OR EXISTS(SELECT 1 FROM image_versions WHERE assetId=CASE WHEN json_valid(NEW.stagedReceipt) THEN json_extract(NEW.stagedReceipt,'$.assetId') END))
 BEGIN SELECT RAISE(ABORT,'frame asset already has an owner');END;
CREATE TRIGGER reject_legacy_frame_asset_owner BEFORE INSERT ON versions
 WHEN CASE WHEN json_valid(NEW.data) THEN EXISTS(SELECT 1 FROM frame_tasks WHERE assetId=json_extract(NEW.data,'$.assetId')
 OR CASE WHEN json_valid(stagedReceipt) THEN json_extract(stagedReceipt,'$.assetId') END=json_extract(NEW.data,'$.assetId')) ELSE 0 END
 BEGIN SELECT RAISE(ABORT,'frame asset already has an owner');END;
CREATE TRIGGER reject_image_frame_asset_owner BEFORE INSERT ON image_versions
 WHEN EXISTS(SELECT 1 FROM frame_tasks WHERE assetId=NEW.assetId
 OR CASE WHEN json_valid(stagedReceipt) THEN json_extract(stagedReceipt,'$.assetId') END=NEW.assetId)
 BEGIN SELECT RAISE(ABORT,'frame asset already has an owner');END;
CREATE TRIGGER immutable_timeline_format_requests BEFORE UPDATE ON timeline_format_requests
 BEGIN SELECT RAISE(ABORT,'timeline format requests are immutable');END;
CREATE TRIGGER retain_timeline_format_requests BEFORE DELETE ON timeline_format_requests
 BEGIN SELECT RAISE(ABORT,'timeline format requests must be retained');END;
CREATE TRIGGER reject_timeline_format_replacement BEFORE INSERT ON timeline_format_requests
 WHEN EXISTS(SELECT 1 FROM timeline_format_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'timeline format request identities are immutable');END;
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
CREATE TRIGGER retain_edit_tasks BEFORE DELETE ON edit_tasks
 BEGIN SELECT RAISE(ABORT,'edit task identities must be retained');END;
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
INSERT INTO schema_version VALUES(16);
INSERT INTO schema_version VALUES(17);
INSERT INTO schema_version VALUES(18);
INSERT INTO schema_version VALUES(19);
INSERT INTO schema_version VALUES(20);
INSERT INTO schema_version VALUES(21);
INSERT INTO schema_version VALUES(22);
