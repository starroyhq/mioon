// Owner: C lane. Current Mio records are not derived from the format-72 workspace.
// R1 resets pre-release development records; released formats must migrate losslessly.
import {HISTORY_TABLES_BY_DOMAIN} from '../tables.ts';
import {AGENT_TASK_STATUSES,AGENT_TASK_STEP_STATUSES} from '../../../../../contracts/src/agent-tasks-v2.ts';
import {MIO_ENTRY_KINDS} from '../../../../../contracts/src/mio-records.ts';

export const MIO_PROCESS_TARGET_KINDS=Object.freeze(['job','export','image_task','frame_task'] as const);
export const MIO_STORAGE_LIMITS=Object.freeze({bytes:256*1024*1024,rows:20000,rowBytes:2*1024*1024});
const integer=(name:string,min=0):string=>`${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name} BETWEEN ${min} AND 9007199254740991)`;
const json=(name:string,limit=2097152):string=>`${name} TEXT NOT NULL CHECK(json_valid(${name}) AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${limit})`;
const optionalJson=(name:string):string=>`${name} TEXT CHECK(${name} IS NULL OR (json_valid(${name}) AND length(CAST(${name} AS BLOB))<=2097152))`;
const hash=(name:string,optional=false):string=>`${name} TEXT ${optional?'':'NOT NULL '}CHECK(${optional?`${name} IS NULL OR `:''}(length(${name})=64 AND ${name} NOT GLOB '*[^a-f0-9]*'))`;
const projectId="projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36)";
const id="id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 200)";
const timestamps='createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL';
const oneOf=(values:readonly string[]):string=>values.map(value=>`'${value}'`).join(',');
const runFk='FOREIGN KEY(projectId,runId) REFERENCES mio_runs(projectId,id)';
const stepFk='FOREIGN KEY(projectId,runId,stepId) REFERENCES mio_steps(projectId,runId,id)';
const immutable=(table:string):string[]=>[
 `CREATE TRIGGER immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END`,
 `CREATE TRIGGER retain_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END`,
];
const identity=(table:string,columns:readonly string[]):string=>`CREATE TRIGGER identity_${table} BEFORE UPDATE ON ${table} WHEN ${columns.map(c=>`NEW.${c} IS NOT OLD.${c}`).join(' OR ')} BEGIN SELECT RAISE(ABORT,'Mio evidence is immutable');END`;
const keep=(table:string):string=>`CREATE TRIGGER retain_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Mio evidence must be retained');END`;

/** Count all retained content, including unique blobs and protected records.
 * A full execution quota must not block manual-edit receipts or background
 * revision bookkeeping; their occupancy still counts against the next run. */
const byteColumns:Readonly<Record<string,readonly string[]>>={
 mio_conversations:['id','projectId','createdAt','updatedAt'],
 mio_runs:['id','projectId','conversationId','requestId','digest','status','locale','configurationBlobHash','rulesSnapshotHash','usageSummary','createdAt','updatedAt'],
 mio_entries:['id','projectId','conversationId','runId','kind','payloadJson','payloadBlobHash','createdAt'],
 mio_blobs:['sha256','content','createdAt'],
 mio_steps:['id','runId','projectId','kind','status','tier','currentRequestId','sourceEntryId','resultEntryId','partialText','data','createdAt','updatedAt'],
 mio_requests:['id','stepId','protocol','bodySha256','state','originalBody','inputManifest','firstEntry','lastEntry','assembledAt','dispatchStartedAt','completedAt','previousRequestId','assemblyReason'],
 mio_changes:['id','runId','stepId','projectId','data'],mio_controls:['requestId','runId','projectId','digest','data'],
 mio_control_states:['requestId','runId','projectId','data'],
 mio_imports:['id','projectId','requestId','name','mimeType','relativePath','sha256','status','assetId','resourceId','createdAt'],
 mio_job_origins:['kind','jobId','runId','stepId','projectId','requestId','operation'],
 mio_edit_claims:['id','projectId','ownerId','kind','targetId','state','createdAt','updatedAt'],
 mio_edit_owners:['ownerId','projectId'],mio_edit_receipts:['requestId','projectId','ownerId','digest','data'],
 mio_conversation_policies:['conversationId','projectId','data'],mio_conversation_policy_requests:['requestId','projectId','conversationId','inputHash','response'],
 mio_events:['runId','createdAt'],mio_process_target_revisions:['projectId','kind','targetId'],
};
export const MIO_QUOTA_BYTES_SQL=HISTORY_TABLES_BY_DOMAIN.mio.map(table=>`(SELECT COALESCE(sum(${byteColumns[table]!.map(c=>`COALESCE(length(CAST(${c} AS BLOB)),0)`).join('+')}),0) FROM ${table})`).join('+');
export const MIO_QUOTA_ROWS_SQL=HISTORY_TABLES_BY_DOMAIN.mio.filter(table=>table!=='mio_edit_receipts').map(table=>`(SELECT count(*) FROM ${table})`).join('+');
const rowTriggers=HISTORY_TABLES_BY_DOMAIN.mio.flatMap(table=>['INSERT','UPDATE'].map(operation=>`CREATE TRIGGER row_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN ${byteColumns[table]!.map(column=>`COALESCE(length(CAST(NEW.${column} AS BLOB)),0)`).join('+')}>${MIO_STORAGE_LIMITS.rowBytes} BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END`));
const quotaTables=HISTORY_TABLES_BY_DOMAIN.mio.filter(table=>!['mio_edit_claims','mio_edit_owners','mio_edit_receipts','mio_process_target_revisions'].includes(table));
const quotaTriggers=quotaTables.flatMap(table=>['INSERT','UPDATE'].map(operation=>`CREATE TRIGGER quota_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN SELECT CASE WHEN ${MIO_QUOTA_ROWS_SQL}>${MIO_STORAGE_LIMITS.rows} OR ${MIO_QUOTA_BYTES_SQL}>${MIO_STORAGE_LIMITS.bytes} THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END;END`));

/** Exact UPDATE columns preserve the existing revision-trigger semantics. */
const processTables=[
 {table:'jobs',kind:'job',columns:['id','projectId','data']},
 {table:'exports',kind:'export',columns:['id','projectId','data']},
 {table:'image_tasks',kind:'image_task',columns:['id','projectId','groupId','requestId','inputHash','input','snapshot','state','revision','dispatched','stagedReceipt','versionId','errorCode','createdAt','updatedAt']},
 {table:'frame_tasks',kind:'frame_task',columns:['id','projectId','requestId','inputHash','input','snapshot','state','revision','started','stagedReceipt','assetId','errorCode','createdAt','updatedAt']},
] as const;
const processTriggers=processTables.flatMap(({table,kind,columns})=>['insert','update','delete'].map(operation=>{
 const row=operation==='delete'?'OLD':'NEW';
 const when=operation==='update'?` WHEN (${columns.map(c=>`NEW.\"${c}\" IS NOT OLD.\"${c}\"`).join(' OR ')})`:'';
 return `CREATE TRIGGER agent_target_${table}_${operation}_v2 AFTER ${operation.toUpperCase()} ON ${table}${when} BEGIN INSERT INTO mio_process_target_revisions(projectId,kind,targetId,revision) VALUES(${row}.projectId,'${kind}',${row}.id,1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END`;
}));

export const MIO_SCHEMA:readonly string[]=Object.freeze([
 `CREATE TABLE mio_blobs(${hash('sha256')},${integer('bytes')},content TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(sha256),CHECK(bytes=length(CAST(content AS BLOB)) AND bytes<=2097152))`,
 `CREATE TABLE mio_conversations(${id},${projectId},${timestamps},UNIQUE(projectId,id))`,
 `CREATE INDEX mio_conversations_page ON mio_conversations(projectId,updatedAt,id)`,
 `CREATE TABLE mio_runs(${id},${projectId},conversationId TEXT NOT NULL,requestId TEXT NOT NULL UNIQUE,${hash('digest')},status TEXT NOT NULL CHECK(status IN (${oneOf(AGENT_TASK_STATUSES)})),${integer('revision',1)},${integer('stepLimit',1)},${integer('budget',1)},${integer('stepsUsed')},locale TEXT NOT NULL CHECK(locale IN ('zh-Hans','zh-Hant','en','ja')),${hash('configurationBlobHash',true)} REFERENCES mio_blobs(sha256),settingsRevision INTEGER CHECK(settingsRevision IS NULL OR (typeof(settingsRevision)='integer' AND settingsRevision BETWEEN 0 AND 9007199254740991)),${hash('rulesSnapshotHash',true)} REFERENCES mio_blobs(sha256),${optionalJson('usageSummary')},${timestamps},UNIQUE(projectId,id),UNIQUE(projectId,conversationId,id),FOREIGN KEY(projectId,conversationId) REFERENCES mio_conversations(projectId,id),CHECK(stepsUsed<=budget))`,
 `CREATE INDEX mio_runs_conversation ON mio_runs(conversationId,createdAt,id)`,
 `CREATE INDEX mio_runs_status ON mio_runs(projectId,status)`,
 `CREATE TABLE mio_entries(${id},${projectId},conversationId TEXT NOT NULL,runId TEXT NOT NULL,${integer('sequence',1)},kind TEXT NOT NULL CHECK(kind IN (${oneOf(MIO_ENTRY_KINDS)})),${optionalJson('payloadJson')},${hash('payloadBlobHash',true)} REFERENCES mio_blobs(sha256),createdAt TEXT NOT NULL,UNIQUE(runId,sequence),UNIQUE(runId,id),FOREIGN KEY(projectId,conversationId,runId) REFERENCES mio_runs(projectId,conversationId,id),CHECK((payloadJson IS NULL)!=(payloadBlobHash IS NULL)))`,
 `CREATE INDEX mio_entries_conversation ON mio_entries(conversationId,runId,sequence)`,
 `CREATE TABLE mio_steps(${id},runId TEXT NOT NULL,${projectId},${integer('position',1)},kind TEXT NOT NULL CHECK(kind IN ('model','tool','wait')),status TEXT NOT NULL CHECK(status IN (${oneOf(AGENT_TASK_STEP_STATUSES)})),tier TEXT CHECK(tier IS NULL OR tier IN ('read_only','local_reversible','local_irreversible','paid')),${timestamps},currentRequestId TEXT,sourceEntryId TEXT,sourceCallIndex INTEGER CHECK(sourceCallIndex IS NULL OR (typeof(sourceCallIndex)='integer' AND sourceCallIndex BETWEEN 0 AND 29)),resultEntryId TEXT,partialText TEXT CHECK(partialText IS NULL OR length(CAST(partialText AS BLOB))<=2097152),data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=2097152),UNIQUE(runId,position),UNIQUE(projectId,runId,id),${runFk},FOREIGN KEY(runId,sourceEntryId) REFERENCES mio_entries(runId,id),FOREIGN KEY(runId,resultEntryId) REFERENCES mio_entries(runId,id),FOREIGN KEY(id,currentRequestId) REFERENCES mio_requests(stepId,id),CHECK((sourceEntryId IS NULL)=(sourceCallIndex IS NULL)))`,
 `CREATE TABLE mio_requests(${id},stepId TEXT NOT NULL REFERENCES mio_steps(id),${integer('assemblyNumber',1)},${integer('assemblerVersion',1)},protocol TEXT NOT NULL CHECK(protocol IN ('chat_completions','responses','anthropic_messages')),${hash('bodySha256')},${integer('bodyBytes',1)},state TEXT NOT NULL CHECK(state IN ('intent','dispatch_started','completed','failed','unknown','superseded')),originalBody TEXT CHECK(originalBody IS NULL OR length(CAST(originalBody AS BLOB))=bodyBytes),${json('inputManifest')},firstEntry TEXT REFERENCES mio_entries(id),lastEntry TEXT REFERENCES mio_entries(id),assembledAt TEXT NOT NULL,dispatchStartedAt TEXT,completedAt TEXT,previousRequestId TEXT,assemblyReason TEXT NOT NULL,UNIQUE(stepId,assemblyNumber),UNIQUE(stepId,id),FOREIGN KEY(stepId,previousRequestId) REFERENCES mio_requests(stepId,id),CHECK(bodyBytes<=524288))`,
 `CREATE INDEX mio_requests_pending ON mio_requests(state,stepId)`,
 `CREATE TABLE mio_changes(${id},runId TEXT NOT NULL,stepId TEXT NOT NULL,${projectId},${json('data')},${runFk},${stepFk})`,
 `CREATE INDEX mio_changes_run ON mio_changes(runId,id)`,
 `CREATE TABLE mio_controls(requestId TEXT PRIMARY KEY NOT NULL,runId TEXT NOT NULL,${projectId},${hash('digest')},${json('data')},UNIQUE(projectId,runId,requestId),${runFk})`,
 `CREATE TABLE mio_control_states(requestId TEXT PRIMARY KEY NOT NULL,runId TEXT NOT NULL,${projectId},${json('data')},FOREIGN KEY(projectId,runId,requestId) REFERENCES mio_controls(projectId,runId,requestId))`,
 `CREATE TABLE mio_imports(${id},${projectId},requestId TEXT NOT NULL UNIQUE,name TEXT NOT NULL CHECK(length(CAST(name AS BLOB))<=800),mimeType TEXT NOT NULL CHECK(length(mimeType) BETWEEN 1 AND 200),relativePath TEXT NOT NULL CHECK(length(CAST(relativePath AS BLOB))<=512),${hash('sha256')},status TEXT NOT NULL CHECK(length(status) BETWEEN 1 AND 100),assetId TEXT,resourceId TEXT,createdAt TEXT NOT NULL)`,
 `CREATE TABLE mio_job_origins(kind TEXT NOT NULL CHECK(kind IN ('job','export','image','frame','scene')),jobId TEXT NOT NULL,runId TEXT NOT NULL,stepId TEXT NOT NULL,${projectId},requestId TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(kind,jobId),${runFk},${stepFk})`,
 `CREATE TABLE mio_edit_claims(${id},${projectId},ownerId TEXT NOT NULL,kind TEXT NOT NULL,targetId TEXT NOT NULL,${integer('revision')},state TEXT NOT NULL CHECK(state IN ('active','uncertain')),${timestamps},UNIQUE(projectId,ownerId,kind,targetId))`,
 `CREATE INDEX mio_edit_claims_target ON mio_edit_claims(kind,targetId)`,
 `CREATE TABLE mio_edit_owners(ownerId TEXT NOT NULL,${projectId},${integer('generation')},${integer('sequence')},PRIMARY KEY(projectId,ownerId))`,
 `CREATE TABLE mio_edit_receipts(requestId TEXT PRIMARY KEY NOT NULL,${projectId},ownerId TEXT NOT NULL,${hash('digest')},${json('data',65536)})`,
 `CREATE TABLE mio_conversation_policies(conversationId TEXT PRIMARY KEY NOT NULL,${projectId},${integer('revision',1)},${json('data',4096)},UNIQUE(projectId,conversationId),FOREIGN KEY(projectId,conversationId) REFERENCES mio_conversations(projectId,id))`,
 `CREATE INDEX mio_conversation_policies_project ON mio_conversation_policies(projectId)`,
 `CREATE TABLE mio_conversation_policy_requests(requestId TEXT PRIMARY KEY NOT NULL,${projectId},conversationId TEXT NOT NULL,${integer('revision',1)},${hash('inputHash')},${json('response',8192)},UNIQUE(conversationId,revision),FOREIGN KEY(projectId,conversationId) REFERENCES mio_conversations(projectId,id))`,
 `CREATE INDEX mio_policy_requests_project ON mio_conversation_policy_requests(projectId,conversationId)`,
 `CREATE TABLE mio_events(runId TEXT NOT NULL REFERENCES mio_runs(id),${integer('sequence',1)},createdAt TEXT NOT NULL,PRIMARY KEY(runId,sequence))`,
 `CREATE TABLE mio_process_target_revisions(${projectId},kind TEXT NOT NULL CHECK(kind IN ('job','export','image_task','frame_task')),targetId TEXT NOT NULL,${integer('revision',1)},PRIMARY KEY(projectId,kind,targetId))`,
 ...['mio_blobs','mio_entries','mio_controls','mio_job_origins','mio_edit_receipts','mio_conversation_policy_requests','mio_events'].flatMap(immutable),
 ...['mio_conversations','mio_runs','mio_steps','mio_requests','mio_changes','mio_control_states','mio_imports','mio_conversation_policies','mio_process_target_revisions'].map(keep),
 identity('mio_conversations',['id','projectId','createdAt']),
 identity('mio_runs',['id','projectId','conversationId','requestId','digest','locale','configurationBlobHash','settingsRevision','rulesSnapshotHash','createdAt']),
 identity('mio_steps',['id','projectId','runId','position','kind','sourceEntryId','sourceCallIndex','createdAt']),
 identity('mio_changes',['id','projectId','runId','stepId']),
 identity('mio_control_states',['requestId','projectId','runId']),
 identity('mio_imports',['id','projectId','requestId','name','mimeType','relativePath','sha256','createdAt']),
 identity('mio_conversation_policies',['conversationId','projectId']),
 identity('mio_requests',['id','stepId','assemblyNumber','assemblerVersion','protocol','bodySha256','bodyBytes','inputManifest','firstEntry','lastEntry','assembledAt','previousRequestId','assemblyReason']),
 `CREATE TRIGGER mio_step_source BEFORE INSERT ON mio_steps WHEN NEW.sourceEntryId IS NOT NULL AND (NEW.kind!='tool' OR NOT EXISTS(SELECT 1 FROM mio_entries WHERE id=NEW.sourceEntryId AND runId=NEW.runId AND kind='model_output')) BEGIN SELECT RAISE(ABORT,'Mio tool source must be its model output');END`,
 `CREATE TRIGGER mio_runs_revision BEFORE UPDATE ON mio_runs WHEN NEW.revision<OLD.revision OR NEW.stepsUsed<OLD.stepsUsed BEGIN SELECT RAISE(ABORT,'Mio run counters cannot decrease');END`,
 `CREATE TRIGGER mio_policy_revision BEFORE UPDATE ON mio_conversation_policies WHEN NEW.revision<=OLD.revision BEGIN SELECT RAISE(ABORT,'Mio conversation policy revisions only advance');END`,
 `CREATE TRIGGER mio_policy_receipt_revision BEFORE INSERT ON mio_conversation_policy_requests WHEN NOT EXISTS(SELECT 1 FROM mio_conversation_policies WHERE projectId=NEW.projectId AND conversationId=NEW.conversationId AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT,'Mio policy receipt must bind its saved revision');END`,
 `CREATE TRIGGER mio_request_insert BEFORE INSERT ON mio_requests WHEN NEW.state!='intent' OR NEW.originalBody IS NULL OR NOT EXISTS(SELECT 1 FROM mio_steps WHERE id=NEW.stepId AND kind='model') BEGIN SELECT RAISE(ABORT,'Mio request must start as an unsent model intent');END`,
 `CREATE TRIGGER mio_request_body BEFORE UPDATE OF originalBody ON mio_requests WHEN NEW.originalBody IS NOT OLD.originalBody AND NOT (OLD.originalBody IS NOT NULL AND NEW.originalBody IS NULL AND EXISTS(SELECT 1 FROM mio_steps s WHERE s.id=NEW.stepId AND s.status='completed' AND ((NEW.state='completed' AND s.currentRequestId=NEW.id) OR (OLD.state='superseded' AND EXISTS(SELECT 1 FROM mio_requests r WHERE r.id=s.currentRequestId AND r.state='completed'))))) BEGIN SELECT RAISE(ABORT,'Mio request body can only be cleared after durable completion');END`,
 `CREATE TRIGGER mio_request_dispatch BEFORE UPDATE ON mio_requests WHEN OLD.dispatchStartedAt IS NOT NULL AND NEW.dispatchStartedAt IS NOT OLD.dispatchStartedAt BEGIN SELECT RAISE(ABORT,'Mio dispatch evidence is immutable');END`,
 `CREATE TRIGGER mio_request_state BEFORE UPDATE ON mio_requests WHEN OLD.state IS NOT NEW.state AND NOT ((OLD.state='intent' AND NEW.state IN ('dispatch_started','failed','superseded')) OR (OLD.state='dispatch_started' AND NEW.state IN ('completed','failed','unknown'))) BEGIN SELECT RAISE(ABORT,'Mio request state cannot be replayed');END`,
 `CREATE TRIGGER mio_request_sent BEFORE UPDATE ON mio_requests WHEN (NEW.state IN ('dispatch_started','completed','unknown') AND NEW.dispatchStartedAt IS NULL) OR (NEW.state='superseded' AND NEW.dispatchStartedAt IS NOT NULL) OR (NEW.state='completed' AND (NEW.completedAt IS NULL OR NOT EXISTS(SELECT 1 FROM mio_steps WHERE id=NEW.stepId AND status='completed' AND currentRequestId=NEW.id))) BEGIN SELECT RAISE(ABORT,'Mio request must retain its dispatch and completion evidence');END`,
 `CREATE TRIGGER mio_process_revision BEFORE UPDATE ON mio_process_target_revisions WHEN NEW.projectId IS NOT OLD.projectId OR NEW.kind IS NOT OLD.kind OR NEW.targetId IS NOT OLD.targetId OR NEW.revision<=OLD.revision BEGIN SELECT RAISE(ABORT,'Mio process revisions only advance');END`,
 ...HISTORY_TABLES_BY_DOMAIN.mio.filter(table=>!['mio_blobs','mio_requests','mio_events'].includes(table)).flatMap(table=>['INSERT','UPDATE'].map(operation=>`CREATE TRIGGER project_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN NEW.projectId IS NOT (SELECT projectId FROM history_state WHERE singleton=1) BEGIN SELECT RAISE(ABORT,'Mio record belongs to another project');END`)),
 ...processTriggers,
 ...rowTriggers,
 ...quotaTriggers,
]);
