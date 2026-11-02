import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {AppError} from '../../contracts/src/app-error.ts';
import {projectNotesSetInputSchema, projectRenameInputSchema} from '../../contracts/src/project-lifecycle.ts';
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

/** Kernel-only project record edits. The app host owns rename admission and
 * registry updates; notes use the same project revision and exact ACK ledger. */
export function mutateProjectRecord(store: ProjectStore, operation: 'project.rename' | 'project.notes.set', value: unknown, {now = () => new Date().toISOString()}: {readonly now?: () => string} = {}): ProjectRecord {
  if (!isProjectStore(store)) throw new TypeError('Project record mutations require a live kernel store');
  if (!object(value) || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('VALIDATION_ERROR', 400);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('VALIDATION_ERROR', 400);
  }
  const parsed = operation === 'project.rename' ? projectRenameInputSchema.safeParse(value) : projectNotesSetInputSchema.safeParse(value);
  if (!parsed.success) fail('VALIDATION_ERROR', 400);
  const input = parsed.data;
  if (input.projectId !== store.projectId) fail('NOT_FOUND', 404);
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return store.tx(() => {
    const previous = store.db.prepare('SELECT projectId,digest,response FROM main.project_mutation_requests WHERE requestId=?').get(input.requestId);
    if (previous) {
      if (previous.projectId !== input.projectId || previous.digest !== digest) fail('IDEMPOTENCY_CONFLICT');
      return decoded(previous.response);
    }
    const current = store.get('projects', input.projectId);
    if (!object(current) || current.id !== input.projectId) fail('NOT_FOUND', 404);
    if (current.revision !== input.expectedRevision || input.expectedRevision === Number.MAX_SAFE_INTEGER) fail('REVISION_CONFLICT');
    const {notes: _previous, ...withoutNotes} = current;
    const updated: ProjectRecord = 'name' in input
      ? {...current, name: input.name, revision: input.expectedRevision + 1, updatedAt: now()}
      : {...withoutNotes, ...(input.notes.trim() ? {notes: input.notes} : {}), revision: input.expectedRevision + 1, updatedAt: now()};
    store.put('projects', updated);
    store.db.prepare('INSERT INTO main.project_mutation_requests(requestId,projectId,digest,response) VALUES(?,?,?,?)').run(input.requestId, input.projectId, digest, JSON.stringify(updated));
    return updated;
  });
}
