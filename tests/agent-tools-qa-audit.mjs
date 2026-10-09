/** Read-only bounded QA projection of durable evidence, never an execution log.
 * A completed tool observation is not itself proof of dispatcher-call count. */
import {createHash} from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
function projectedJson(value) { if (value === null) return null; try { return JSON.parse(value); } catch { throw Error('Malformed synthetic ledger audit'); } }
export function readToolsQaAudit(db) {
  const present = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  if (!present('agent_chat_runs')) return {runs: [], truncated: false};
  const rows = db.prepare(`SELECT id,projectId,status,
    CASE WHEN length(CAST(data AS BLOB))<=1048576 AND json_valid(data) THEN json_extract(data,'$.contextMode') END AS contextMode,
    CASE WHEN length(CAST(data AS BLOB))<=1048576 AND json_valid(data) THEN json_extract(data,'$.provenance') END AS provenance,
    CASE WHEN length(CAST(data AS BLOB))<=1048576 AND json_valid(data) THEN json_extract(data,'$.modelRequestState') END AS modelRequestState
    FROM agent_chat_runs ORDER BY position DESC LIMIT 201`).all();
  let truncated = rows.length > 200;
  const hasSteps = present('agent_chat_steps');
  const runs = rows.slice(0, 200).map(row => {
    const steps = hasSteps ? db.prepare(`SELECT id,kind,status,position,
      CASE WHEN length(CAST(data AS BLOB))<=1048576 AND json_valid(data) THEN json_extract(data,'$.ordinal') END AS ordinal,
      CASE WHEN length(CAST(data AS BLOB))<=1048576 AND json_valid(data) THEN json_extract(data,'$.request.body') END AS body,
      CASE WHEN length(CAST(data AS BLOB))<=1048576 AND json_valid(data) THEN json_extract(data,'$.observation.resultJson') END AS resultJson
      FROM agent_chat_steps WHERE runId=? ORDER BY position LIMIT 4`).all(row.id) : [];
    if (steps.length > 3) truncated = true;
    return {id: row.id, projectId: row.projectId, status: row.status, contextMode: row.contextMode || 'typed_chat_only',
      provenance: projectedJson(row.provenance), modelRequestState: row.modelRequestState, steps: steps.slice(0, 3).map(step => {
        if (step.body !== null && (typeof step.body !== 'string' || Buffer.byteLength(step.body) > 128 * 1024) ||
          step.resultJson !== null && (typeof step.resultJson !== 'string' || Buffer.byteLength(step.resultJson) > 8192)) throw Error('Oversized synthetic ledger audit');
        return {id: step.id, kind: step.kind, status: step.status, position: step.position, ordinal: step.ordinal,
          ...(step.body !== null ? {bodyHash: hash(step.body), bodyBytes: Buffer.byteLength(step.body)} : {}),
          ...(step.resultJson !== null ? {resultHash: hash(step.resultJson), resultBytes: Buffer.byteLength(step.resultJson)} : {})};
      })};
  });
  return {runs, truncated};
}
