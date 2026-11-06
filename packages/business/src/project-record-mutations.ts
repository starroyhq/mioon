import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {AppError} from '../../contracts/src/app-error.ts';
import {projectRenameInputSchema} from '../../contracts/src/project-lifecycle.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';

type ProjectRecord = Record<string, unknown>;
const object = (value: unknown): value is ProjectRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code = 'PROJECT_DELETE_UNAVAILABLE', status = 409): never {
  const messages: Record<string, string> = {NOT_FOUND: '项目不存在。', VALIDATION_ERROR: '项目操作参数无效。', REVISION_CONFLICT: '项目已变化，请刷新后重试。', IDEMPOTENCY_CONFLICT: '请求键已被其他项目操作使用。', PROJECT_DELETE_UNAVAILABLE: '当前项目状态不能执行此操作。'};
  throw new AppError(code, messages[code] ?? messages.PROJECT_DELETE_UNAVAILABLE!, status);
}
function decoded(value: unknown): ProjectRecord {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4 * 1024 * 1024) fail();
  let record: unknown;
  try { record = JSON.parse(value); } catch { fail(); }
  if (!object(record)) fail();
  return record;
}

/** Public reads omit retired notes without rewriting saved JSON or old ACKs. */
export function currentProjectRecord(record: unknown): ProjectRecord {
  if (!object(record)) throw new TypeError('A current project projection requires a saved record');
  const {notes: _retired, ...current} = record;
  return current;
}

/** Kernel-only rename. The app host owns admission and registry updates; old
 * notes JSON and immutable shared receipts remain stored exactly as before. */
export function mutateProjectRecord(store: ProjectStore, operation: 'project.rename', value: unknown, {now = () => new Date().toISOString()}: {readonly now?: () => string} = {}): ProjectRecord {
  if (!isProjectStore(store)) throw new TypeError('Project record mutations require a live kernel store');
  if (operation !== 'project.rename') throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
  if (!object(value) || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('VALIDATION_ERROR', 400);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('VALIDATION_ERROR', 400);
  }
  const parsed = projectRenameInputSchema.safeParse(value);
  if (!parsed.success) fail('VALIDATION_ERROR', 400);
  const input = parsed.data;
  if (input.projectId !== store.projectId) fail('NOT_FOUND', 404);
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return store.tx(() => {
    const previous = store.db.prepare('SELECT projectId,digest,response FROM main.project_mutation_requests WHERE requestId=?').get(input.requestId);
    if (previous) {
      if (previous.projectId !== input.projectId || previous.digest !== digest) fail('IDEMPOTENCY_CONFLICT');
      return currentProjectRecord(decoded(previous.response));
    }
    const current = store.get('projects', input.projectId);
    if (!object(current) || current.id !== input.projectId) fail('NOT_FOUND', 404);
    if (current.revision !== input.expectedRevision || input.expectedRevision === Number.MAX_SAFE_INTEGER) fail('REVISION_CONFLICT');
    const updated: ProjectRecord = {...current, name: input.name, revision: input.expectedRevision + 1, updatedAt: now()};
    store.put('projects', updated);
    store.db.prepare('INSERT INTO main.project_mutation_requests(requestId,projectId,digest,response) VALUES(?,?,?,?)').run(input.requestId, input.projectId, digest, JSON.stringify(updated));
    return currentProjectRecord(updated);
  });
}
