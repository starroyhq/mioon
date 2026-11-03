import type {IncomingMessage, ServerResponse} from 'node:http';
import {
  MIO_RULES_ERROR_STATUS, projectRulesSaveInputSchema, projectRulesEnableInputSchema,
  projectRulesSnapshotSchema, projectRulesRequestLookupSchema, rulesRequestIdSchema,
  userRulesSaveInputSchema, userRulesSnapshotSchema, userRulesRequestLookupSchema,
} from '../../../packages/contracts/src/mio-rules.ts';
import type {
  MioRulesErrorCode, ProjectRulesSaveInput, ProjectRulesEnableInput, ProjectRulesSnapshot,
  ProjectRulesRequestLookup, UserRulesSaveInput, UserRulesSnapshot, UserRulesRequestLookup,
} from '../../../packages/contracts/src/mio-rules.ts';
import {projectApiPath} from '../../../packages/contracts/src/project-file.ts';

type Awaitable<T> = T | Promise<T>;
export interface ProjectRulesPort {
  read(): Awaitable<ProjectRulesSnapshot>;
  save(input: ProjectRulesSaveInput): Awaitable<ProjectRulesSnapshot>;
  enable(input: ProjectRulesEnableInput): Awaitable<ProjectRulesSnapshot>;
  lookup(requestId: string): Awaitable<ProjectRulesRequestLookup>;
  reconcile(requestId: string): Awaitable<ProjectRulesRequestLookup>;
}
export interface UserRulesPort {
  read(): Awaitable<UserRulesSnapshot>;
  save(input: UserRulesSaveInput): Awaitable<UserRulesSnapshot>;
  lookup(requestId: string): Awaitable<UserRulesRequestLookup>;
}
interface HttpContext {req: IncomingMessage; res: ServerResponse; url: URL; signal?: AbortSignal}
interface Schema<T> {safeParse(value: unknown): {success: true; data: T} | {success: false}}
const HTTP_BYTES = 64 * 1024;
const messages: Record<MioRulesErrorCode, string> = {
  MIO_RULES_INVALID: '规范请求无效。', MIO_RULES_TOO_LARGE: '规范请求超过大小上限。',
  MIO_RULES_CONFLICT: '规范已变更，请读取最新内容。', MIO_RULES_REQUEST_CONFLICT: '请求标识已用于另一项操作。',
  MIO_RULES_PENDING: '规范写入尚未完成，请查询原请求。', MIO_RULES_NOT_FOUND: '找不到规范请求。',
  MIO_RULES_UNAVAILABLE: '规范暂不可用。', MIO_RULES_WRITE_UNCERTAIN: '规范写入结果待查证，请查询原请求。',
  MIO_RULES_READ_ONLY: '当前项目不能修改规范。',
};
function failure(code: MioRulesErrorCode): never {throw Object.assign(new Error(code), {code});}
function send(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {res.destroy(); return;}
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
}
function reject(res: ServerResponse, error: unknown): void {
  const raw = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof raw === 'string' && Object.hasOwn(MIO_RULES_ERROR_STATUS, raw) ? raw as MioRulesErrorCode : 'MIO_RULES_UNAVAILABLE';
  send(res, MIO_RULES_ERROR_STATUS[code], {ok: false, error: {code, message: messages[code], details: {}, retryable: false}});
}
function active(signal?: AbortSignal): void {if (signal?.aborted) failure('MIO_RULES_UNAVAILABLE');}
function parsed<T>(schema: Schema<T>, input: unknown, code: MioRulesErrorCode = 'MIO_RULES_INVALID'): T {
  const result = schema.safeParse(input); return result.success ? result.data : failure(code);
}
function method(res: ServerResponse, current: string | undefined, allowed: string[]): boolean {
  if (allowed.includes(current ?? '')) return true;
  res.setHeader('Allow', allowed.join(', '));
  send(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '此接口不支持该请求方法。', details: {}, retryable: false}});
  return false;
}
async function input({req, res, signal}: HttpContext): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') failure('MIO_RULES_INVALID');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || !Number.isSafeInteger(Number(length)))) failure('MIO_RULES_INVALID');
  const oversized = (): never => {res.setHeader('Connection', 'close'); req.resume(); return failure('MIO_RULES_TOO_LARGE');};
  if (length !== undefined && Number(length) > HTTP_BYTES) oversized();
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    active(signal); const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += part.length; if (bytes > HTTP_BYTES) oversized(); chunks.push(part);
  }
  active(signal);
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(Buffer.concat(chunks))) as unknown;}
  catch {return failure('MIO_RULES_INVALID');}
}
function requestId(segment: string): string {
  let value: string; try {value = decodeURIComponent(segment);} catch {return failure('MIO_RULES_INVALID');}
  return parsed(rulesRequestIdSchema, value);
}

/** The authenticated project dispatcher supplies its acquired project's port.
 * GET is an observation; only the explicit POST can reconcile a pending write. */
export async function handleMioRulesHttp(context: HttpContext & {projectId: string; rules: ProjectRulesPort}): Promise<boolean> {
  const {req, res, url, rules, projectId, signal} = context, prefix = projectApiPath(projectId, 'rules');
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
  try {
    active(signal); if (url.search || url.hash) failure('MIO_RULES_INVALID');
    const route = url.pathname.slice(prefix.length); let result: ProjectRulesSnapshot | ProjectRulesRequestLookup;
    if (route === '') {
      if (!method(res, req.method, ['GET', 'PUT'])) return true;
      result = req.method === 'GET' ? await rules.read() : await rules.save(parsed(projectRulesSaveInputSchema, await input(context)));
      result = parsed(projectRulesSnapshotSchema, result, 'MIO_RULES_UNAVAILABLE');
    } else if (route === '/enable') {
      if (!method(res, req.method, ['POST'])) return true;
      result = parsed(projectRulesSnapshotSchema, await rules.enable(parsed(projectRulesEnableInputSchema, await input(context))), 'MIO_RULES_UNAVAILABLE');
    } else {
      const match = /^\/requests\/([^/]+)(\/reconcile)?$/u.exec(route); if (!match) failure('MIO_RULES_NOT_FOUND');
      if (!method(res, req.method, [match[2] ? 'POST' : 'GET'])) return true;
      const id = requestId(match[1]!);
      // Reconciliation takes its identity only from the address, not an extra
      // caller-authored body carrying trust or an asserted publication result.
      if (match[2]) {
        const body = await input(context);
        if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) failure('MIO_RULES_INVALID');
        active(signal);
      }
      const lookup = parsed(projectRulesRequestLookupSchema, await (match[2] ? rules.reconcile(id) : rules.lookup(id)), 'MIO_RULES_UNAVAILABLE');
      if (lookup.requestId !== id) failure('MIO_RULES_UNAVAILABLE');
      result = lookup;
    }
    if (result.projectId !== projectId) failure('MIO_RULES_UNAVAILABLE');
    send(res, 200, {ok: true, data: result});
  } catch (error) {reject(res, error);}
  return true;
}

/** Application-scoped user rules never acquire or discover a project. */
export async function handleUserRulesHttp(context: HttpContext & {rules: UserRulesPort}): Promise<boolean> {
  const {req, res, url, rules, signal} = context, prefix = '/api/user-rules';
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
  try {
    active(signal); if (url.search || url.hash) failure('MIO_RULES_INVALID');
    const route = url.pathname.slice(prefix.length); let result: UserRulesSnapshot | UserRulesRequestLookup;
    if (route === '') {
      if (!method(res, req.method, ['GET', 'PUT'])) return true;
      result = parsed(userRulesSnapshotSchema, req.method === 'GET' ? await rules.read() : await rules.save(parsed(userRulesSaveInputSchema, await input(context))), 'MIO_RULES_UNAVAILABLE');
    } else {
      const match = /^\/requests\/([^/]+)$/u.exec(route); if (!match) failure('MIO_RULES_NOT_FOUND');
      if (!method(res, req.method, ['GET'])) return true;
      const id = requestId(match[1]!);
      const lookup = parsed(userRulesRequestLookupSchema, await rules.lookup(id), 'MIO_RULES_UNAVAILABLE');
      if (lookup.requestId !== id) failure('MIO_RULES_UNAVAILABLE');
      result = lookup;
    }
    send(res, 200, {ok: true, data: result});
  } catch (error) {reject(res, error);}
  return true;
}
