-- Frozen from baseline 9d75f5e; independent schema10 proposal DDL.
 CREATE TABLE IF NOT EXISTS agent_edit_proposals(
 position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
 projectId TEXT NOT NULL REFERENCES projects(id),runId TEXT NOT NULL UNIQUE REFERENCES agent_chat_runs(id),shotId TEXT NOT NULL,
 digest TEXT NOT NULL,definition TEXT NOT NULL CHECK(json_valid(definition) AND length(CAST(definition AS BLOB))<=131072),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','dispatching','unknown','applied','failed','rejected','cancelled')),
 approval TEXT CHECK(approval IS NULL OR (json_valid(approval) AND length(CAST(approval AS BLOB))<=32768)),
 outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND length(CAST(outcome AS BLOB))<=1024)),
 createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 196608),
 CHECK((status IN ('pending','rejected','cancelled'))=(approval IS NULL)),
 CHECK((status IN ('applied','failed'))=(outcome IS NOT NULL)));
 CREATE INDEX IF NOT EXISTS agent_edit_project_page ON agent_edit_proposals(projectId,position DESC);
 CREATE TRIGGER IF NOT EXISTS reject_agent_edit_replacement BEFORE INSERT ON agent_edit_proposals
 WHEN EXISTS(SELECT 1 FROM agent_edit_proposals WHERE id=NEW.id OR runId=NEW.runId)
 BEGIN SELECT RAISE(ABORT,'agent edit identities are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_agent_edit_intent BEFORE UPDATE ON agent_edit_proposals
 WHEN NEW.position IS NOT OLD.position OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR
 NEW.runId IS NOT OLD.runId OR NEW.shotId IS NOT OLD.shotId OR NEW.digest IS NOT OLD.digest OR
 NEW.definition IS NOT OLD.definition OR NEW.createdAt IS NOT OLD.createdAt OR NEW.bytes IS NOT OLD.bytes OR
 (OLD.approval IS NOT NULL AND NEW.approval IS NOT OLD.approval) OR
 (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
 BEGIN SELECT RAISE(ABORT,'agent edit intent and approval are immutable');END;
 CREATE TRIGGER IF NOT EXISTS guard_agent_edit_transition BEFORE UPDATE ON agent_edit_proposals
 WHEN NEW.status IS NOT OLD.status AND NOT (
 (OLD.status='pending' AND NEW.status IN ('approved','rejected','cancelled')) OR
 (OLD.status='approved' AND NEW.status IN ('dispatching','unknown','applied')) OR
 (OLD.status='dispatching' AND NEW.status IN ('unknown','applied','failed')) OR
 (OLD.status='unknown' AND NEW.status IN ('dispatching','applied')))
 BEGIN SELECT RAISE(ABORT,'invalid agent edit transition');END;
 CREATE TRIGGER IF NOT EXISTS retain_agent_edit_proposals BEFORE DELETE ON agent_edit_proposals
 BEGIN SELECT RAISE(ABORT,'agent edit proposals must be retained');END;
