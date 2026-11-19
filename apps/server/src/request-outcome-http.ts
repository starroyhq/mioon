import type {IncomingMessage,ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '@mioon/contracts';
import {readRequestOutcome,REQUEST_OUTCOME_LIMITS} from '@mioon/business/request-outcome';
import type {RequestOutcome} from '@mioon/business/request-outcome';
import type {ProjectAddress} from './project-host/request.ts';

export interface RequestOutcomeHttpOptions {
  readonly db: DatabaseSync;
  readonly signal?: AbortSignal;
  /** Trusted runtime check that the project connection is still held. */
  readonly assertAvailable?: ()=>void;
}

const json = (res: ServerResponse,status: number,value: unknown): void => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status,{'Content-Type': 'application/json; charset=utf-8','Cache-Control': 'no-store','X-Content-Type-Options': 'nosniff'});
  res.end(JSON.stringify(value));
};
const validation = (): AppError => new AppError('VALIDATION_ERROR','请求编号无效',400);
const projectUnavailable = (): AppError => new AppError('PROJECT_UNAVAILABLE','项目当前不可用',409);
const unavailable = (): AppError => new AppError('REQUEST_OUTCOME_UNAVAILABLE','无法读取请求结果，请稍后再试。',503);

/** Response contract of one receipt read. Format 3/4 keeps the fixed two-field
 * body; a format-5 editor receipt adds `status`/`code` only in the one shape it
 * can honestly mean, and any inconsistent combination stays unavailable. */
function outcomeData(outcome: RequestOutcome): Record<string, unknown> {
  const data: Record<string, unknown> = {applied: outcome.applied,operation: outcome.operation};
  if (outcome.status === undefined) {
    if (outcome.code !== undefined) throw unavailable();
    return data;
  }
  if (outcome.status === 'applied') {
    if (outcome.applied !== true || outcome.code !== null) throw unavailable();
    return {...data,status: 'applied',code: null};
  }
  if (outcome.applied !== false || typeof outcome.code !== 'string' || outcome.code.length < 1 || outcome.code.length > 200) throw unavailable();
  return {...data,status: 'not_applied',code: outcome.code};
}

/** Read-only receipt lookup for retained requests whose response was lost.
 * It runs only behind the project host's existing Host/Origin, token and lease
 * checks; it never dispatches, replays or mutates a request. The response body
 * is a bounded outcome: two fields for format 3/4 receipts, two fields plus
 * `status`/`code` for a format-5 editor receipt. */
export function createRequestOutcomeHttp({db,signal,assertAvailable=()=>{}}: RequestOutcomeHttpOptions) {
  return async function handle(req: IncomingMessage,res: ServerResponse,url: URL,address?: ProjectAddress): Promise<boolean> {
    if (url.pathname !== '/api/request-outcome') return false;
    try {
      assertAvailable();
      if (signal?.aborted || !db.isOpen) throw projectUnavailable();
      if (Buffer.byteLength(req.url ?? '', 'utf8') > REQUEST_OUTCOME_LIMITS.urlBytes) throw validation();
      if (req.method !== 'GET') {
        res.setHeader('Allow','GET');
        json(res,405,{ok: false,error: {code: 'METHOD_NOT_ALLOWED',message: '请使用 GET',details: {},retryable: false}});
        return true;
      }
      if (!address) throw projectUnavailable();
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== 'requestId' || url.searchParams.getAll('requestId').length !== 1) throw validation();
      const requestId = url.searchParams.get('requestId');
      if (requestId === null) throw validation();
      json(res,200,{ok: true,data: outcomeData(readRequestOutcome(db,address.projectId,requestId))});
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      if (res.headersSent) { res.destroy(); return true; }
      const failure = error instanceof AppError ? error : new AppError('REQUEST_OUTCOME_UNAVAILABLE','无法读取请求结果，请稍后再试。',503);
      json(res,failure.status,{ok: false,error: {code: failure.code,message: failure.message,details: failure.details ?? {},retryable: false}});
    }
    return true;
  };
}
