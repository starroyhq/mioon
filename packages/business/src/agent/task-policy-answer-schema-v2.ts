import type {DatabaseSync} from 'node:sqlite';
import {agentTaskAnswerSchema,agentTaskConversationPolicySchema,agentTaskPolicyModesSchema,agentTaskQuestionSchema} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentTaskStep} from '../../../contracts/src/agent-tasks-v2.ts';
import {validateAgentInteractionRowsV2} from './task-interaction-schema-v2.ts';
import {AGENT_TASK_STORAGE_BYTES_V58} from './task-storage-schema-v2.ts';

// Schema66 adds per-conversation confirmation modes (C1) and Mio's questions
// awaiting the user's answer (C3). Every bound is a literal because restore
// profiles compare this exact SQL. Receipts carry the project-deletion
// exemption of schema48; a conversation keeps one policy row whose revision
// only advances, so clearing an override (modes null) keeps the row.
export const AGENT_TASK_POLICY_ANSWER_TABLES=Object.freeze(['agent_task_conversation_policies_v2','agent_task_conversation_policy_requests_v2'] as const);
const AGENT_POLICY_ANSWER_SCHEMA_66_SQL=`
CREATE TABLE agent_task_conversation_policies_v2(
 conversationId TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(conversationId AS BLOB))=36 AND conversationId GLOB '????????-????-????-????-????????????' AND conversationId NOT GLOB '*[^a-fA-F0-9-]*'),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4096),
 CHECK(json_extract(data,'$.conversationId') IS conversationId AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.revision') IS revision AND json_type(data,'$.modes') IN ('object','null'))
);
CREATE TABLE agent_task_conversation_policy_requests_v2(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 conversationId TEXT NOT NULL CHECK(length(CAST(conversationId AS BLOB))=36),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 8192),
 UNIQUE(conversationId,revision),
 CHECK(json_extract(response,'$.conversationId') IS conversationId AND json_extract(response,'$.projectId') IS projectId AND json_extract(response,'$.revision') IS revision)
);
CREATE INDEX agent_task_conversation_policies_project_v2 ON agent_task_conversation_policies_v2(projectId);
CREATE INDEX agent_task_conversation_policy_requests_project_v2 ON agent_task_conversation_policy_requests_v2(projectId,conversationId);
CREATE TRIGGER agent_task_conversation_policy_owner_v2 BEFORE INSERT ON agent_task_conversation_policies_v2
 WHEN EXISTS(SELECT 1 FROM agent_task_runs_v2 WHERE projectId IS NOT NEW.projectId AND json_extract(data,'$.conversationId') IS NEW.conversationId)
 BEGIN SELECT RAISE(ABORT,'Agent conversation policies belong to their project');END;
CREATE TRIGGER agent_task_conversation_policy_update_v2 BEFORE UPDATE ON agent_task_conversation_policies_v2
 WHEN NEW.conversationId IS NOT OLD.conversationId OR NEW.projectId IS NOT OLD.projectId OR NEW.revision<=OLD.revision
 BEGIN SELECT RAISE(ABORT,'Agent conversation policy revisions only advance');END;
CREATE TRIGGER agent_task_conversation_policy_delete_v2 BEFORE DELETE ON agent_task_conversation_policies_v2
 WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='agent_task_conversation_policies_v2' AND rowId=OLD.rowid)
 BEGIN SELECT RAISE(ABORT,'Agent conversation policies must be retained');END;
CREATE TRIGGER agent_task_conversation_policy_capacity_v2 BEFORE INSERT ON agent_task_conversation_policies_v2
 WHEN (SELECT count(*) FROM agent_task_conversation_policies_v2)>=20000
 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;
CREATE TRIGGER agent_task_conversation_policy_request_identity_v2 BEFORE INSERT ON agent_task_conversation_policy_requests_v2
 WHEN NOT EXISTS(SELECT 1 FROM agent_task_conversation_policies_v2 WHERE conversationId=NEW.conversationId AND projectId=NEW.projectId AND revision=NEW.revision)
 BEGIN SELECT RAISE(ABORT,'Agent conversation policy receipts bind their saved revision');END;
CREATE TRIGGER agent_task_conversation_policy_request_immutable_v2 BEFORE UPDATE ON agent_task_conversation_policy_requests_v2
 BEGIN SELECT RAISE(ABORT,'Agent conversation policy receipts are immutable');END;
CREATE TRIGGER agent_task_conversation_policy_request_retain_v2 BEFORE DELETE ON agent_task_conversation_policy_requests_v2
 WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='agent_task_conversation_policy_requests_v2' AND rowId=OLD.rowid)
 BEGIN SELECT RAISE(ABORT,'Agent conversation policy receipts must be retained');END;
CREATE TRIGGER agent_task_conversation_policy_request_capacity_v2 BEFORE INSERT ON agent_task_conversation_policy_requests_v2
 WHEN (SELECT count(*) FROM agent_task_conversation_policy_requests_v2)>=20000
 BEGIN SELECT RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT');END;
`;
/** Trusted construction only: the schema66 migration and fixed restore
 * profiles. The caller owns the transaction and the schema marker. Existing
 * runs, steps and receipts are not rewritten. */
export function installAgentPolicyAnswerDefinitionsV2(db:DatabaseSync):void {
 if(!db.isTransaction)throw Object.assign(new Error('Agent policy schema installation requires a transaction'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec(AGENT_POLICY_ANSWER_SCHEMA_66_SQL);
}
/** Schema66 storage profile: the historical families plus conversation
 * policies, and runs or questions waiting for an answer. Older profiles keep
 * rejecting `awaiting_answer` (see validateAgentTaskRowsV2). */
export function validateAgentPolicyAnswerRowsV2(db:DatabaseSync):void {
 validateAgentInteractionRowsV2(db,{allowRequestReferences:true,allowAnswers:true,maxBytes:AGENT_TASK_STORAGE_BYTES_V58});
 const invalid=():never=>{throw Object.assign(new Error('Invalid Agent policy or answer evidence'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});};
 const count=(table:string):number=>Number(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} LIMIT 20001)`).get()!.n);
 if(count('agent_task_conversation_policies_v2')>20000||count('agent_task_conversation_policy_requests_v2')>20000)invalid();
 for(const row of db.prepare('SELECT conversationId,projectId,revision,data FROM agent_task_conversation_policies_v2 LIMIT 20001').iterate()){
  const value=JSON.parse(String(row.data)) as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['conversationId','projectId','revision','modes','updatedAt'].includes(key))||value.modes!==null&&!agentTaskPolicyModesSchema.safeParse(value.modes).success)invalid();
  if(typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt)))invalid();
  // A conversation's runs and its policy share one project.
  if(db.prepare("SELECT 1 FROM agent_task_runs_v2 WHERE projectId IS NOT ? AND json_extract(data,'$.conversationId') IS ? LIMIT 1").get(row.projectId,row.conversationId))invalid();
 }
 for(const row of db.prepare('SELECT response FROM agent_task_conversation_policy_requests_v2 LIMIT 20001').iterate())if(!agentTaskConversationPolicySchema.safeParse(JSON.parse(String(row.response))).success)invalid();
 if(db.prepare('SELECT 1 FROM agent_task_conversation_policy_requests_v2 r LEFT JOIN agent_task_conversation_policies_v2 p ON p.conversationId=r.conversationId WHERE p.conversationId IS NULL OR p.projectId IS NOT r.projectId OR r.revision>p.revision LIMIT 1').get())invalid();
 // A question waits as a step of an unfinished run: the run waits for it,
 // or was stopped, interrupted or failed before the answer. An answer is the
 // completed result of a valid question.
 for(const row of db.prepare("SELECT data FROM agent_task_steps_v2 WHERE json_extract(data,'$.toolCall.name') IS 'mioon_ask' AND status IN ('awaiting_answer','completed') LIMIT 20001").iterate()){
  const step=JSON.parse(String(row.data)) as AgentTaskStep;
  if(!agentTaskQuestionSchema.safeParse(step.toolCall?.arguments).success)invalid();
  if(step.status==='completed'){const result=step.result as Record<string,unknown>|undefined;if(!result||typeof result!=='object'||!agentTaskAnswerSchema.safeParse(result.answer).success)invalid();}
 }
 if(db.prepare("SELECT 1 FROM agent_task_steps_v2 s JOIN agent_task_runs_v2 r ON r.id=s.runId WHERE s.status='awaiting_answer' AND (json_extract(s.data,'$.kind') IS NOT 'tool' OR json_extract(s.data,'$.toolCall.name') IS NOT 'mioon_ask' OR r.status IN ('accepted','completed')) LIMIT 1").get())invalid();
 if(db.prepare("SELECT 1 FROM agent_task_steps_v2 WHERE status='awaiting_answer' GROUP BY runId HAVING count(*)>1 LIMIT 1").get())invalid();
 if(db.prepare("SELECT 1 FROM agent_task_runs_v2 r WHERE r.status='awaiting_answer' AND NOT EXISTS(SELECT 1 FROM agent_task_steps_v2 s WHERE s.runId=r.id AND s.status='awaiting_answer') LIMIT 1").get())invalid();
}
