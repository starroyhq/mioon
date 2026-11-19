import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '@mioon/contracts';
import {TIMELINE_RECEIPT_PROJECT_EXPRESSION} from './timeline-receipt-project.ts';

/** Read-only union of the immutable request receipts a lost response can leave
 * behind. A receipt inside this project proves that the named request was
 * accepted and applied; a missing receipt proves nothing, so callers must keep
 * their retained request unless a receipt is found. */
export interface RequestOutcome {readonly applied: boolean; readonly operation: string | null}

export const REQUEST_OUTCOME_LIMITS = Object.freeze({requestIdChars: 200, requestIdBytes: 800, operationChars: 80, urlBytes: 2048, referenceResponseBytes: 128 * 1024});

const PROJECT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const REQUEST_ID = /^[\x21-\x7e]{8,200}$/u;
const RECEIPT_OPERATION = /^[A-Za-z][A-Za-z0-9._:-]{0,79}$/u;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (): AppError => new AppError('VALIDATION_ERROR', '请求编号或项目地址无效', 400);
const unavailable = (): AppError => new AppError('REQUEST_OUTCOME_UNAVAILABLE', '无法读取请求结果，请稍后再试。', 503);
const operation = (value: unknown): string | null => typeof value === 'string' && RECEIPT_OPERATION.test(value) ? value : null;

interface ReceiptQuery {
  readonly sql: string;
  readonly parameters: (projectId: string,requestId: string)=>readonly string[];
  readonly operation?: string;
}

// Every query binds both the immutable request ID and the project that owns
// the row, so a coincident ID from another project can never read as applied.
// timeline_requests carries no project column and is scoped by the existing
// bounded owner expression rather than by a local JSON re-implementation.
// The reference receipt has no project column either; its bounded response is
// checked for the owning project before it can count as applied.
const RECEIPT_QUERIES: readonly ReceiptQuery[] = Object.freeze([
  {sql: 'SELECT operation FROM mutation_requests WHERE requestId=? AND projectId=? LIMIT 1', parameters: (_project,request)=>[request,_project]},
  {sql: 'SELECT operation FROM asset_range_requests WHERE requestId=? AND projectId=? LIMIT 1', parameters: (_project,request)=>[request,_project]},
  {sql: 'SELECT operation FROM asset_disposition_requests WHERE requestId=? AND projectId=? LIMIT 1', parameters: (_project,request)=>[request,_project]},
  {sql: 'SELECT operation FROM asset_annotation_requests WHERE requestId=? AND projectId=? LIMIT 1', parameters: (_project,request)=>[request,_project]},
  {sql: 'SELECT operation FROM subject_requests WHERE requestId=? AND projectId=? LIMIT 1', parameters: (_project,request)=>[request,_project]},
  {sql: 'SELECT operation FROM task_disposition_requests WHERE requestId=? AND projectId=? LIMIT 1', parameters: (_project,request)=>[request,_project]},
  {sql: 'SELECT operation FROM project_version_requests WHERE projectId=? AND requestId=? LIMIT 1', parameters: (project,request)=>[project,request]},
  {sql: 'SELECT 1 AS applied FROM project_mutation_requests WHERE requestId=? AND projectId=? LIMIT 1', parameters: (_project,request)=>[request,_project]},
  {sql: 'SELECT 1 AS applied FROM timeline_format_requests WHERE requestId=? AND projectId=? LIMIT 1', parameters: (_project,request)=>[request,_project], operation: 'timeline.format.set'},
  {sql: `SELECT CASE WHEN json_valid(response) THEN json_extract(response,'$.operation') END AS operation FROM timeline_requests WHERE requestId=? AND (${TIMELINE_RECEIPT_PROJECT_EXPRESSION})=? LIMIT 1`,
    parameters: (project,request)=>[request,project]},
  {sql: 'SELECT response FROM reference_requests WHERE requestId=? LIMIT 1', parameters: (_project,request)=>[request]},
]);

function referenceOwner(row: Record<string, unknown>,projectId: string): RequestOutcome | null {
  const raw = row.response;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > REQUEST_OUTCOME_LIMITS.referenceResponseBytes) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!object(value)) return null;
  const edge = object(value.edge) ? value.edge : null, shot = object(value.shot) ? value.shot : null;
  const owners = [edge?.projectId, shot?.projectId].filter((owner): owner is string => typeof owner === 'string');
  if (owners.length === 0 || owners.some(owner => owner !== projectId)) return null;
  return {applied: true, operation: value.detached === true ? 'reference.detach' : 'reference.attach'};
}

function readTransaction<T>(db: DatabaseSync,callback: ()=>T): T {
  if (db.isTransaction) return callback();
  db.exec('BEGIN');
  try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* the original failure is authoritative */ } throw error; }
}

/** Bounded read-only lookup. Any storage failure becomes an opaque retryable
 * error: the caller keeps its retained request and never treats the failure as
 * evidence that the write did not happen. */
export function readRequestOutcome(db: DatabaseSync,projectId: string,requestId: string): RequestOutcome {
  if (!PROJECT_ID.test(projectId) || !REQUEST_ID.test(requestId) || Buffer.byteLength(requestId) > REQUEST_OUTCOME_LIMITS.requestIdBytes) throw invalid();
  return readTransaction(db,()=>{
    try {
      for (const query of RECEIPT_QUERIES) {
        const row = db.prepare(query.sql).get(...query.parameters(projectId,requestId)) as Record<string, unknown> | undefined;
        if (!row) continue;
        if (query.sql.includes('FROM reference_requests')) {
          const outcome = referenceOwner(row,projectId);
          if (outcome) return outcome;
          continue;
        }
        return {applied: true, operation: query.operation ?? operation(row.operation)};
      }
      return {applied: false, operation: null};
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  });
}
