import type {DatabaseSync} from 'node:sqlite';
import {validateAgentTaskRowsV2} from './task-schema-v2.ts';

const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const invalid=():never=>{throw Object.assign(new Error('Invalid Agent conversation evidence'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});};
/** Additive schema54 metadata. Existing runs remain separate single-run
 * conversations; immutable historical events and request digests stay intact. */
export function installAgentConversationDefinitionsV2(db:DatabaseSync):void {
 db.exec("UPDATE agent_task_runs_v2 SET data=json_set(data,'$.conversationId',id) WHERE json_type(data,'$.conversationId') IS NULL");
 db.exec(`CREATE INDEX agent_task_conversation_v2 ON agent_task_runs_v2(projectId,json_extract(data,'$.conversationId'),json_extract(data,'$.createdAt'),id);
 CREATE TRIGGER agent_task_conversation_identity_v2 BEFORE UPDATE OF data ON agent_task_runs_v2
 WHEN json_extract(NEW.data,'$.conversationId') IS NOT json_extract(OLD.data,'$.conversationId')
 BEGIN SELECT RAISE(ABORT,'Agent conversation identity is immutable');END;
 CREATE TRIGGER agent_task_conversation_required_v2 BEFORE INSERT ON agent_task_runs_v2
 WHEN json_type(NEW.data,'$.conversationId') IS NOT 'text' OR length(json_extract(NEW.data,'$.conversationId'))!=36
 OR json_extract(NEW.data,'$.conversationId') NOT GLOB '????????-????-????-????-????????????'
 OR json_extract(NEW.data,'$.conversationId') GLOB '*[^a-fA-F0-9-]*'
 BEGIN SELECT RAISE(ABORT,'Agent conversation identity is required');END;`);
}
export function validateAgentConversationRowsV2(db:DatabaseSync):void {
 validateAgentTaskRowsV2(db,{allowConversations:true});
 for(const row of db.prepare("SELECT json_extract(data,'$.conversationId') AS conversationId FROM agent_task_runs_v2 LIMIT 20001").iterate())if(typeof row.conversationId!=='string'||!uuid.test(row.conversationId))invalid();
 if(db.prepare("SELECT 1 FROM agent_task_runs_v2 GROUP BY json_extract(data,'$.conversationId') HAVING count(DISTINCT projectId)>1 OR (sum(json_type(data,'$.diagnostic') IS NOT NULL)>0 AND count(*)>1) LIMIT 1").get())invalid();
}
