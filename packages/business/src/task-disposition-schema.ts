import {isTaskDispositionMutationResponse} from '../../contracts/src/task-dispositions.ts';
import type {DatabaseSync} from 'node:sqlite';

/** These definitions are installed only by the reviewed ordinary workspace
 * migration. Domain services never create or repair schema at request time. */
export function installTaskDispositionDefinitions(db:DatabaseSync):void {
  if (!db.isTransaction) throw new Error('Task disposition installation requires a transaction');
  db.exec(`CREATE TABLE task_dispositions(
    projectId TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind IN ('generation','render','edit')),
    taskId TEXT NOT NULL CHECK(length(CAST(taskId AS BLOB))=36),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
    markedFailedAt TEXT,archivedAt TEXT,sourceStatus TEXT NOT NULL CHECK(length(CAST(sourceStatus AS BLOB)) BETWEEN 1 AND 40),
    sourceRequestId TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,
    CHECK(markedFailedAt IS NOT NULL OR archivedAt IS NOT NULL),PRIMARY KEY(projectId,kind,taskId));
    CREATE TABLE task_disposition_requests(
    requestId TEXT PRIMARY KEY CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
    projectId TEXT NOT NULL REFERENCES projects(id),operation TEXT NOT NULL CHECK(operation IN ('task.disposition.markFailed','task.disposition.archiveCompleted')),
    digest TEXT NOT NULL CHECK(length(CAST(digest AS BLOB))=64),response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB))<=131072));
    CREATE TRIGGER retain_task_disposition_replacement BEFORE INSERT ON task_dispositions
    WHEN EXISTS(SELECT 1 FROM task_dispositions WHERE rowid=NEW.rowid OR (projectId=NEW.projectId AND kind=NEW.kind AND taskId=NEW.taskId))
    BEGIN SELECT RAISE(ABORT,'task disposition history must not be replaced');END;
    CREATE TRIGGER retain_task_disposition_request_replacement BEFORE INSERT ON task_disposition_requests
    WHEN EXISTS(SELECT 1 FROM task_disposition_requests WHERE rowid=NEW.rowid OR requestId=NEW.requestId)
    BEGIN SELECT RAISE(ABORT,'task disposition responses must not be replaced');END;
    CREATE TRIGGER immutable_task_disposition_identity BEFORE UPDATE ON task_dispositions
    WHEN NEW.projectId IS NOT OLD.projectId OR NEW.kind IS NOT OLD.kind OR NEW.taskId IS NOT OLD.taskId OR NEW.createdAt IS NOT OLD.createdAt OR
      NEW.sourceRequestId IS NOT OLD.sourceRequestId OR NEW.revision!=OLD.revision+1 OR OLD.revision>=9007199254740991 OR
      (OLD.markedFailedAt IS NOT NULL AND NEW.markedFailedAt IS NOT OLD.markedFailedAt) OR (OLD.archivedAt IS NOT NULL AND NEW.archivedAt IS NOT OLD.archivedAt)
    BEGIN SELECT RAISE(ABORT,'task disposition identity and audit markers must be retained');END;
    CREATE TRIGGER retain_task_dispositions BEFORE DELETE ON task_dispositions
    WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='task_dispositions' AND rowId=OLD.rowid)
    BEGIN SELECT RAISE(ABORT,'task disposition history must be retained');END;
    CREATE TRIGGER immutable_task_disposition_requests BEFORE UPDATE ON task_disposition_requests
    BEGIN SELECT RAISE(ABORT,'task disposition responses are immutable');END;
    CREATE TRIGGER retain_task_disposition_requests BEFORE DELETE ON task_disposition_requests
    WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='task_disposition_requests' AND rowId=OLD.rowid)
    BEGIN SELECT RAISE(ABORT,'task disposition responses must be retained');END;`);
}

export function validateTaskDispositionRows(db:DatabaseSync):void {
  function invalid():never {throw Object.assign(new Error('Task disposition schema rows are invalid'), {code:'RESTORE_SCHEMA_UNSUPPORTED'});}
  if (db.prepare(`SELECT 1 FROM task_dispositions WHERE typeof(revision)!='integer' OR revision<1 OR revision>9007199254740991 OR
    length(CAST(projectId AS BLOB))!=36 OR length(CAST(taskId AS BLOB))!=36 OR kind NOT IN ('generation','render','edit') OR
    length(CAST(sourceStatus AS BLOB)) NOT BETWEEN 1 AND 40 OR (markedFailedAt IS NULL AND archivedAt IS NULL) OR
    length(CAST(createdAt AS BLOB)) NOT BETWEEN 20 AND 40 OR length(CAST(updatedAt AS BLOB)) NOT BETWEEN 20 AND 40 OR
    (markedFailedAt IS NOT NULL AND length(CAST(markedFailedAt AS BLOB)) NOT BETWEEN 20 AND 40) OR
    (archivedAt IS NOT NULL AND length(CAST(archivedAt AS BLOB)) NOT BETWEEN 20 AND 40) OR
    (sourceRequestId IS NOT NULL AND length(CAST(sourceRequestId AS BLOB)) NOT BETWEEN 8 AND 800) LIMIT 1`).get()) invalid();
  if (db.prepare(`SELECT 1 FROM task_disposition_requests WHERE length(CAST(projectId AS BLOB))!=36 OR
    length(CAST(requestId AS BLOB)) NOT BETWEEN 8 AND 800 OR length(CAST(digest AS BLOB))!=64 OR digest GLOB '*[^a-f0-9]*' OR
    operation NOT IN ('task.disposition.markFailed','task.disposition.archiveCompleted') OR NOT json_valid(response) OR
    length(CAST(response AS BLOB))>131072 LIMIT 1`).get()) invalid();
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const timestamp=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)&&Number.isFinite(Date.parse(value));
  for(const row of db.prepare('SELECT * FROM task_dispositions').iterate()){
    if(typeof row.sourceStatus!=='string'||typeof row.sourceRequestId!=='string'&&row.sourceRequestId!==null||typeof row.sourceRequestId==='string'&&(row.sourceRequestId.length<8||row.sourceRequestId.length>200||! /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(row.sourceRequestId))||typeof row.projectId!=='string'||!uuid.test(row.projectId)||typeof row.taskId!=='string'||!uuid.test(row.taskId)||!timestamp(row.createdAt)||!timestamp(row.updatedAt)||row.markedFailedAt!==null&&!timestamp(row.markedFailedAt)||row.archivedAt!==null&&!timestamp(row.archivedAt))invalid();
    const table=row.kind==='generation'?'jobs':row.kind==='render'?'exports':'edit_tasks';
    if(!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND projectId=?`).get(row.taskId,row.projectId))invalid();
  }
  for(const row of db.prepare('SELECT requestId,projectId,operation,response FROM task_disposition_requests').iterate()){
    let response:unknown;try{response=JSON.parse(String(row.response));}catch{invalid();}
    if(!isTaskDispositionMutationResponse(response)||response.requestId!==row.requestId||response.projectId!==row.projectId||response.operation!==row.operation)invalid();
    for(const item of response.items){const marker=db.prepare('SELECT revision,markedFailedAt,archivedAt,sourceRequestId FROM task_dispositions WHERE projectId=? AND kind=? AND taskId=?').get(item.projectId,item.kind,item.taskId);if(!marker||typeof marker.revision!=='number'||marker.revision<item.revision||item.markedFailed&&marker.markedFailedAt===null||item.archived&&marker.archivedAt===null||marker.sourceRequestId!==item.sourceRequestId)invalid();}
  }
}
