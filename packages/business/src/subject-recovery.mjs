import {AppError, schemas, SUBJECT_MUTATION_OPERATIONS} from '@mioon/contracts';
import {canonical, hash} from './services.mjs';

const bounded = (column, bytes) => `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END AS ${column}`;
const invalid = () => { throw new AppError('INVALID_SUBJECT_RECORD', '主体记录或关联状态不可用，请先检查项目', 409); };
const conflict = () => { throw new AppError('EDIT_TASK_CONFLICT', '编辑任务的请求编号已用于不同操作、项目或内容', 409); };

// An explicit companion adapter for the shared eleven-operation local key
// namespace. Receipt existence reserves a key even when its bytes are corrupt.
// Ownership is checked by the caller before reading any retained response.
export function readSubjectReceipt(db, input, operation) {
  if (!SUBJECT_MUTATION_OPERATIONS.includes(operation) || !schemas[operation].safeParse(input).success) invalid();
  const fields = [bounded('operation', 80), bounded('projectId', 36), bounded('canonicalInput', 8192), bounded('response', 16384)].join(',');
  const rows = db.prepare(`
    SELECT 'mutation_requests' AS receiptTable,${fields} FROM mutation_requests WHERE requestId=?
    UNION ALL SELECT 'asset_range_requests' AS receiptTable,${fields} FROM asset_range_requests WHERE requestId=?
    UNION ALL SELECT 'asset_disposition_requests' AS receiptTable,${fields} FROM asset_disposition_requests WHERE requestId=?
    UNION ALL SELECT 'subject_requests' AS receiptTable,${fields} FROM subject_requests WHERE requestId=?
  `).all(input.requestId, input.requestId, input.requestId, input.requestId);
  if (rows.length > 1) conflict();
  const row = rows[0];
  if (!row) return null;
  if (row.receiptTable !== 'subject_requests' || row.operation !== operation || row.projectId !== input.projectId) conflict();
  if (typeof row.canonicalInput !== 'string' || typeof row.response !== 'string') invalid();
  const {requestId, ...intent} = input;
  if (row.canonicalInput !== canonical(intent)) conflict();
  let response;
  try { response = JSON.parse(row.response); } catch { invalid(); }
  return {requestHash: hash({operation: row.operation, input: {...JSON.parse(row.canonicalInput), requestId}}), response};
}
