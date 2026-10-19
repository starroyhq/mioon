import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {AppError,parse,IMAGE_LIMITS,imageSchemas,isImageMutationResponse,imageRequestResponseSchema} from '@mioon/contracts';
import {createImageOwnershipReader} from '../image-ownership.ts';
import {createOwnedMediaGraphReader} from '../inspection.ts';
import {imageEditFields} from './edit-source.ts';
import {validateImageTaskReview} from './reviews.ts';
import type {DatabaseSync, SQLInputValue} from 'node:sqlite';

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export const imageServiceMessages: Readonly<Record<string, string>> = Object.freeze({IMAGE_SOURCE_INVALID:'此项目的原始 PNG 无法安全核验；不会发送或重新生成。',IMAGE_NOT_FOUND:'找不到此项目的图像记录。',IMAGE_RECORD_INVALID:'图像记录无法安全核验，请保留原任务并检查本地数据。',IMAGE_LIVE_DISABLED:'OpenAI 图像调用尚未启用；请先配置独立图像设置。',IMAGE_REVIEW_REQUIRED:'当前付费图像请求需要用户明确确认；请先准备并查看原请求。',IMAGE_REQUEST_CONFLICT:'此图像请求 ID 已用于不同的操作、项目或内容。',IMAGE_REVISION_CONFLICT:'图像组或任务已有新状态，请重新读取后明确操作。',IMAGE_GROUP_BUSY:'此图像组仍有待处理或结果待确认的任务，请先查看原任务。',IMAGE_STATE_CONFLICT:'当前图像任务状态不允许此操作。',IMAGE_CAPACITY:'图像任务或回执保留容量已满，无法安全接受新操作；这不表示磁盘已满。',IMAGE_QUEUE_FULL:'本地图像队列已满，请稍后再明确提交。',IMAGE_OWNER_REQUIRED:'此操作需要当前工作区的独占后端，请连接运行中的后端。',IMAGE_SERVICE_STOPPED:'图像服务已停止，请重新打开后查看原任务。',IMAGE_RESULT_INVALID:'本地图像结果无法完整核验；不会重新调用供应商。',IMAGE_STORAGE_FAILED:'无法保存图像结果，请查看原任务；不会重新生成。'});
export const imageServiceError = (code: string, status = 409): AppError => new AppError(code, imageServiceMessages[code] || '图像操作未完成，请查看原任务。', status);
function fail(code: string, status?: number): never { throw imageServiceError(code, status); }
function missing(): never { fail('IMAGE_NOT_FOUND', 404); }
function invalid(): never { fail('IMAGE_RECORD_INVALID'); }
const bounded = (name: string, size: number | string, nullable = false): string => `CASE WHEN ${nullable ? `${name} IS NULL OR ` : ''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
const requestColumns = [bounded('requestId', 800), bounded('operation', 80), bounded('projectId', 36), bounded('inputHash', 64), bounded('canonicalInput', IMAGE_LIMITS.inputBytes), bounded('response', IMAGE_LIMITS.responseBytes)].join(',');

export interface ImageGenerationView {
  readonly projectId?: string; readonly requestId?: string; readonly name?: string; readonly groupId?: string; readonly expectedRevision?: number;
  readonly providerId: string; readonly model: string; readonly prompt?: string; readonly options: Record<string, unknown>;
  readonly purpose?: 'edit'; readonly inputImage?: {assetId?: unknown; sha256?: unknown}; readonly sourceImage?: Record<string, unknown>;
}
export interface ImageSnapshotView {
  readonly schemaVersion: number; readonly projectId: string; readonly groupId: string; readonly taskId: string; readonly name: string;
  readonly prompt: string; readonly providerId: string; readonly model: string; readonly options: Record<string, unknown>;
  readonly purpose?: 'edit'; readonly inputImage?: {assetId?: unknown; sha256?: unknown}; readonly sourceImage?: Record<string, unknown>;
}
export interface ImageTaskView {
  readonly id: string; readonly projectId: string; readonly groupId: string; readonly requestId: string; readonly name: string; readonly prompt: string;
  readonly providerId: string; readonly model: string; readonly options: Record<string, unknown>; readonly state: string; readonly revision: number;
  readonly dispatched: boolean; readonly versionId: string | null; readonly errorCode: string | null; readonly createdAt: string; readonly updatedAt: string;
}
export interface ImageGroupView {readonly id: string; readonly projectId: string; readonly name: string; readonly revision: number; readonly headVersionId: string | null; readonly activeTaskId: string | null; readonly createdAt: string; readonly updatedAt: string}
export interface ImageHistoryTask {
  row: Record<string, unknown> & {id: string; projectId: string; groupId: string; requestId: string; state: string; revision: number; inputHash: string; input: string; snapshot: string; dispatched: number; stagedReceipt: string | null; versionId: string | null};
  dto: ImageTaskView;
  snapshot: ImageSnapshotView;
  input: ImageGenerationView;
  receipt: unknown;
}
export interface ImageHistoryReader {
  task(id: string, options?: {shallow?: boolean}): ImageHistoryTask;
  group(id: string): ImageGroupView;
  imageVersion(id: string, asset?: unknown): unknown;
  version(id: string, asset?: unknown): unknown;
}
export interface ImageRequestReceipt {projectId: string; requestId: string; operation: string; response: ImageTaskView | null}
export interface ImageListPage {projectId: string; items: unknown[]; nextCursor: string | null}
export interface ImageHistoryReaders {
  handlers: Readonly<Record<string, (input: unknown) => unknown>>;
  schemaPresent(): boolean;
  project(projectId: string): unknown;
  reader(projectId: string): ImageHistoryReader;
  task(projectId: string, id: string, options?: {shallow?: boolean}): ImageHistoryTask;
  group(projectId: string, id: string): ImageGroupView;
  taskDto(projectId: string, id: string): ImageTaskView;
  reviewBinding(value: {row: {projectId: string; id: string}; input: unknown}): unknown;
  prior(operation: string, input: ImageGenerationView): ImageTaskView | null;
}

/** Saved metadata only. This factory does not construct a lifecycle, read files,
 * inspect settings/providers, reconcile records or grant execution authority.
 * The normal lifecycle reuses these exact readers and original receipt checks.
 * Internal readers below are also pure; only handlers are transport-facing. */
export function createImageHistoryReaders({db}: {db: DatabaseSync}): ImageHistoryReaders {
  const secret = randomBytes(32);
  const reviewBinding = (value: {row: {projectId: string; id: string}; input: unknown}): unknown => validateImageTaskReview(db, value.row.projectId, value.row.id, value.input);
  const schemaPresent = (): boolean => {
    const present = Number((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('image_groups','image_tasks','image_versions','image_requests')").get() as {n: number}).n);
    if (present === 4) return true;
    if (present || db.prepare('SELECT 1 FROM schema_version WHERE version=16').get()) invalid();
    return false;
  };
  function project(projectId: string): unknown {
    const row = db.prepare(`SELECT id,${bounded('data', 16384)} FROM projects WHERE id=? LIMIT 1`).get(projectId) as {data: string} | undefined;
    let value: unknown; try {value = JSON.parse(row?.data as string);} catch {missing();}
    const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
    if (record?.id !== projectId) missing();
    return value;
  }
  const reader = (projectId: string): ImageHistoryReader => createImageOwnershipReader(db, projectId, {fail: invalid}) as unknown as ImageHistoryReader;
  const readImageVersion = (projectId: string, id: string): unknown => (createOwnedMediaGraphReader(db, projectId) as unknown as {imageVersion(value: string): unknown}).imageVersion(id);
  function task(projectId: string, id: string, {shallow = false}: {shallow?: boolean} = {}): ImageHistoryTask {
    project(projectId);
    const row = db.prepare('SELECT id FROM image_tasks WHERE id=? AND projectId=?').get(id, projectId);
    if (!row) missing();
    return reader(projectId).task(id, {shallow});
  }
  function group(projectId: string, id: string): ImageGroupView {
    project(projectId); if (!db.prepare('SELECT id FROM image_groups WHERE id=? AND projectId=?').get(id, projectId)) missing();
    const read = reader(projectId), value = read.group(id);
    if (value.headVersionId) readImageVersion(projectId, value.headVersionId);
    if (value.activeTaskId) {const active = read.task(value.activeTaskId); reviewBinding(active);}
    return value;
  }
  function taskDto(projectId: string, id: string): ImageTaskView {
    const value = task(projectId, id); reviewBinding(value);
    if (value.dto.versionId) readImageVersion(projectId, value.dto.versionId);
    return value.dto;
  }
  // Disclosure of an original ACK is not approval, recovery or scheduling.
  function prior(operation: string, input: ImageGenerationView): ImageTaskView | null {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_remote_observations'").get() && db.prepare('SELECT 1 FROM image_remote_observations WHERE requestId=?').get(input.requestId as string)) fail('IMAGE_REQUEST_CONFLICT');
    const row = db.prepare(`SELECT ${requestColumns} FROM image_requests WHERE requestId=?`).get(input.requestId as string) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.projectId !== input.projectId || row.operation !== operation || row.inputHash !== hash(input) || row.canonicalInput !== canonical(input)) fail('IMAGE_REQUEST_CONFLICT');
    let response: unknown;
    try {response = JSON.parse(row.response as string);} catch {invalid();}
    if (!isImageMutationResponse(operation, input, response)) invalid();
    const receipt = response as ImageTaskView;
    const currentTask = task(input.projectId as string, receipt.id, {shallow: operation === 'image.task.cancelQueued'}); reviewBinding(currentTask);
    if (currentTask.row.requestId !== receipt.requestId || currentTask.row.groupId !== receipt.groupId || (currentTask.row.revision as number) < receipt.revision || currentTask.snapshot.prompt !== receipt.prompt || currentTask.snapshot.name !== receipt.name || currentTask.snapshot.providerId !== receipt.providerId || currentTask.snapshot.model !== receipt.model || !equal(currentTask.snapshot.options, receipt.options) || !equal(imageEditFields(currentTask.snapshot), imageEditFields(receipt))) invalid();
    if (currentTask.dto.versionId) readImageVersion(input.projectId as string, currentTask.dto.versionId);
    return receipt;
  }
  function requestGet(input: {projectId: string; requestId: string}): ImageRequestReceipt | null {
    project(input.projectId);
    const row = db.prepare(`SELECT ${requestColumns} FROM image_requests WHERE requestId=? AND projectId=?`).get(input.requestId, input.projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let original: unknown;
    try {original = JSON.parse(row.canonicalInput as string);} catch {invalid();}
    const operation = row.operation as string;
    const schema = (imageSchemas as unknown as Record<string, {safeParse(value: unknown): {success: boolean}}>)[operation];
    const originalRecord = original !== null && typeof original === 'object' ? original as Record<string, unknown> : null;
    if (!schema?.safeParse(original).success || originalRecord?.projectId !== input.projectId || originalRecord?.requestId !== input.requestId) invalid();
    const response = prior(operation, original as ImageGenerationView), value = {projectId: input.projectId, requestId: input.requestId, operation, response};
    if (!imageRequestResponseSchema.safeParse(value).success) invalid();
    return value;
  }
  const sign = (text: string): string => createHmac('sha256', secret).update(text).digest('base64url');
  function page(operation: string, input: {projectId: string; groupId?: string; limit?: number; cursor?: string}): ImageListPage {
    project(input.projectId); if (input.groupId) group(input.projectId, input.groupId);
    const limit = input.limit ?? IMAGE_LIMITS.pageSize, table = operation === 'image.task.list' ? 'image_tasks' : operation === 'image.group.list' ? 'image_groups' : 'image_versions', versions = table === 'image_versions';
    const scope = [operation, input.projectId, input.groupId ?? null, limit];
    let after: unknown = null;
    if (input.cursor) {
      try {
        const [body, mac, ...rest] = input.cursor.split('.');
        if (rest.length || mac.length !== 43 || !timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) throw Error();
        const decoded: unknown = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (!Array.isArray(decoded) || !equal(decoded.slice(0, 4), scope) || decoded.length !== 5) throw Error();
        after = decoded[4];
        if (Array.isArray(after)) {
          if (after.length !== 2 || typeof after[0] !== 'string' || after[0].length > 40 || !/^[-a-f0-9]{36}$/i.test(after[1])) throw Error();
        } else if (versions && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 1)) throw Error();
      } catch {throw new AppError('INVALID_CURSOR', '图像分页游标无效或已过期', 400);}
    }
    const where = ['projectId=?'], args: unknown[] = [input.projectId];
    if (input.groupId) {where.push('groupId=?'); args.push(input.groupId);}
    if (after !== null) {where.push(versions ? 'number<?' : '(createdAt<? OR (createdAt=? AND id<?))'); args.push(...(versions ? [after] : [(after as unknown[])[0], (after as unknown[])[0], (after as unknown[])[1]]));}
    const rows = db.prepare(`SELECT ${bounded('id', 36)},${versions ? 'number' : bounded('createdAt', 40)} FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${versions ? 'number DESC' : 'createdAt DESC,id DESC'} LIMIT ?`).all(...args as SQLInputValue[], limit + 1) as unknown as {id: string; number?: number; createdAt?: string}[];
    const selected = rows.slice(0, limit);
    const items = selected.map(row => versions ? readImageVersion(input.projectId, row.id) : table === 'image_tasks' ? taskDto(input.projectId, row.id) : group(input.projectId, row.id));
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const last = selected.at(-1)!, body = Buffer.from(JSON.stringify([...scope, versions ? last.number : [last.createdAt, last.id]])).toString('base64url');
      nextCursor = `${body}.${sign(body)}`;
    }
    return {projectId: input.projectId, items, nextCursor};
  }
  function snapshotRead<T>(read: (input: T) => unknown): (input: T) => unknown {
    return (input: T): unknown => {
      const outer = db.isTransaction;
      if (!outer) db.exec('BEGIN DEFERRED');
      try {return read(input);} finally {if (!outer && db.isTransaction) db.exec('COMMIT');}
    };
  }
  const readHandlers: Record<string, (input: unknown) => unknown> = {
    'image.request.get': requestGet as (input: unknown) => unknown,
    'image.task.get': ((input: {projectId: string; taskId: string}) => taskDto(input.projectId, input.taskId)) as (input: unknown) => unknown,
    'image.group.get': ((input: {projectId: string; groupId: string}) => group(input.projectId, input.groupId)) as (input: unknown) => unknown,
    ...Object.fromEntries(['image.task.list', 'image.group.list', 'image.version.list'].map(operation => [operation, ((input: {projectId: string; groupId?: string; limit?: number; cursor?: string}) => page(operation, input)) as (input: unknown) => unknown])),
  };
  const handlers = Object.freeze(Object.fromEntries(Object.entries(readHandlers).map(([operation, read]) => [operation, (input: unknown): unknown => {
    if (!schemaPresent()) fail('IMAGE_SCHEMA_REQUIRED', 503);
    return snapshotRead(read)(parse(operation as Parameters<typeof parse>[0], input));
  }])));
  return Object.freeze({handlers, schemaPresent, project, reader, task, group, taskDto, reviewBinding, prior});
}
