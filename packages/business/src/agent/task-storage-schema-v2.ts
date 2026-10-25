import type {DatabaseSync} from 'node:sqlite';
import {AGENT_TASK_TABLES} from './task-schema-v2.ts';
import {validateAgentInteractionRowsV2} from './task-interaction-schema-v2.ts';

export const AGENT_TASK_STORAGE_BYTES_V58=256*1024*1024;

const quotaTables=AGENT_TASK_TABLES.filter(table=>!['agent_task_target_revisions_v2','agent_task_edit_claims_v2','agent_task_edit_owners_v2','agent_task_edit_receipts_v2'].includes(table));
const counts=quotaTables.map(table=>`(SELECT count(*) FROM ${table})`).join('+');
const bytes=['agent_task_runs_v2','agent_task_steps_v2','agent_task_changes_v2','agent_task_events_v2','agent_task_controls_v2','agent_task_control_states_v2','agent_task_policy_v2','agent_task_policy_requests_v2','agent_task_edit_receipts_v2'].map(table=>`(SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM ${table})`).join('+');

/** Schema58 alone acquires the larger bounded journal and immutable request
 * originals. Historical constructors keep their exact64MiB catalogue. No
 * existing evidence row is rewritten or removed by this installation. */
export function installAgentTaskStorageDefinitionsV2(db:DatabaseSync):void {
 for(const table of quotaTables)for(const event of ['INSERT','UPDATE'])db.exec(`DROP TRIGGER agent_quota_${table}_${event.toLowerCase()};
 CREATE TRIGGER agent_quota_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN SELECT CASE WHEN ${counts}>20000 OR ${bytes}>${AGENT_TASK_STORAGE_BYTES_V58} THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END;END;`);
 db.exec(`CREATE TRIGGER agent_task_model_request_update_v58 BEFORE UPDATE ON agent_task_steps_v2
 WHEN json_extract(OLD.data,'$.kind')='model' AND (NEW.id IS NOT OLD.id OR NEW.runId IS NOT OLD.runId OR NEW.projectId IS NOT OLD.projectId
 OR json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR json_extract(NEW.data,'$.runId') IS NOT json_extract(OLD.data,'$.runId')
 OR json_extract(NEW.data,'$.kind') IS NOT 'model' OR json_extract(NEW.data,'$.request') IS NOT json_extract(OLD.data,'$.request'))
 BEGIN SELECT RAISE(ABORT,'Agent model request evidence is immutable');END;
 CREATE TRIGGER agent_task_model_request_delete_v58 BEFORE DELETE ON agent_task_steps_v2
 WHEN json_extract(OLD.data,'$.kind')='model' AND NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='agent_task_steps_v2' AND rowId=OLD.rowid)
 BEGIN SELECT RAISE(ABORT,'Agent model request evidence must be retained');END;
 CREATE TRIGGER agent_task_model_request_replace_v58 BEFORE INSERT ON agent_task_steps_v2
 WHEN EXISTS(SELECT 1 FROM agent_task_steps_v2 previous WHERE (previous.id=NEW.id OR previous.rowid=NEW.rowid OR previous.runId=NEW.runId AND previous.position=NEW.position) AND json_extract(previous.data,'$.kind')='model')
 BEGIN SELECT RAISE(ABORT,'Agent model request evidence must not be replaced');END;`);
}

export function validateAgentTaskStorageRowsV2(db:DatabaseSync):void {
 // Match the historical row families. Manual editing receipts deliberately
 // remain writable even after the execution quota is exhausted; counting
 // them again here would turn a valid manual edit into a startup failure.
 validateAgentInteractionRowsV2(db,{allowRequestReferences:true,maxBytes:AGENT_TASK_STORAGE_BYTES_V58});
}
