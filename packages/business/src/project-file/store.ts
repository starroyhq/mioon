import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {isAsyncFunction, isPromise} from 'node:util/types';
import type {ProjectStore as ProjectStoreContract} from '../../../contracts/src/project-file.ts';
import type {Store} from '../store-contract.ts';
import {createProjectFile, isProjectDatabase, openProjectConnection, openStagedProjectConnection} from './connection.ts';
import type {CreateProjectFileOptions, OpenProjectConnectionOptions, ProjectConnection, StagedProjectConnectionOptions} from './connection.ts';
import {mediaReferenceSchema} from '../../../contracts/src/media-reference.ts';
import type {MediaReference} from '../../../contracts/src/media-reference.ts';
import {AppError} from '../../../contracts/src/app-error.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION, isSequenceProjectFormat} from './schema/databases.ts';
import {assertProjectReaderRequirements, readProjectReaderState} from './reader-requirements.ts';
import {TIMELINE_FPS_READER_FEATURE} from '../../../contracts/src/project-reader-requirements.ts';
import {isTimelineFps, type TimelineFps} from '../../../contracts/src/timeline-fps.ts';
import {fenceFormat5ProjectContent} from './format5-content.ts';
import {putFormat5TimelineInside, readFormat5TimelineRecord} from './format5-timeline.ts';
import {readProjectContentStamp, sameContentStamp} from './content-stamp.ts';
import {mediaUnavailableError} from '../../../contracts/src/media-reference-errors.ts';
import {markBackgroundTaskChanged, flushBackgroundTaskChanges, discardBackgroundTaskChanges, closeBackgroundTaskEvents,
  validateBackgroundTaskAdmission, validateBackgroundTaskChanges} from '../background-task-events.ts';

/** The contract's project store with the read and write surface of today's
 * Store (same tables, columns, errors and transaction rules; tx
 * begins with a deferred BEGIN, and tx and put refuse to write once the
 * project file alone was moved, see below). */
export interface ProjectStore extends Store, ProjectStoreContract<DatabaseSync> {}

// Only the exact store returned by this kernel has this capability. Copying
// its public fields (even the native connection) must not manufacture a store
// identity for the workspace compatibility boundary.
const verifiedStores = new WeakMap<object, {readonly connection: ReturnType<typeof openProjectConnection>; readonly isClosed: () => boolean}>();
export function isProjectStore(value: unknown): value is ProjectStore {
  if (value === null || typeof value !== 'object') return false;
  const verified = verifiedStores.get(value);
  if (!verified || verified.isClosed()) return false;
  const store = value as ProjectStore, connection = verified.connection;
  return isProjectDatabase(connection.db) && store.db === connection.db && store.root === connection.projectDir
    && store.projectId === connection.projectId && store.projectFile === connection.projectFile && store.projectDir === connection.projectDir
    && store.localDir === connection.localDir && store.cacheDir === connection.cacheDir && store.tempDir === connection.tempDir;
}

type TimelineFpsChangeMode = 'edit' | 'history';
const timelineFpsWrites = new WeakMap<ProjectStore, {from: TimelineFps; to?: TimelineFps}>();

type TimelineFpsLockReason = 'TIMELINE_NOT_EMPTY' | 'TIMELINE_CONTENT_PREVIOUSLY_EXISTS' | 'FROZEN_TIMELINE_OUTPUT';
function timelineFpsLocked(reason: TimelineFpsLockReason): never {
  const message = reason === 'TIMELINE_NOT_EMPTY' ? '有片段或字幕的时间线不能修改帧率。'
    : reason === 'FROZEN_TIMELINE_OUTPUT' ? '已有使用当前帧率的导出记录，不能修改帧率。' : '时间线曾经放入片段或字幕，帧率已经固定。';
  throw new AppError('TIMELINE_FPS_LOCKED', message, 409, {reason});
}

function hasTimelineContent(store: ProjectStore): boolean {
  return !!store.db.prepare(`SELECT 1 FROM project.timeline_clips WHERE projectId=?
    UNION ALL SELECT 1 FROM project.timeline_cues WHERE projectId=? LIMIT 1`).get(store.projectId, store.projectId);
}

export function format6TimelineFpsChangeBlock(store: ProjectStore, mode: TimelineFpsChangeMode): TimelineFpsLockReason | 'FORMAT_REQUIRED' | undefined {
  if (process.env.MIOON_FORMAT6_DEV !== '1' || store.db.prepare('PRAGMA project.user_version').get()?.user_version !== FORMAT6_PROJECT_SCHEMA_VERSION) {
    return 'FORMAT_REQUIRED';
  }
  if (hasTimelineContent(store)) return 'TIMELINE_NOT_EMPTY';
  // Clip and cue revision rows survive normal removal and undo.
  if (mode === 'edit' && store.db.prepare(`SELECT 1 FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind IN ('timeline_clip','timeline_subtitle') LIMIT 1`).get(store.projectId)) {
    return 'TIMELINE_CONTENT_PREVIOUSLY_EXISTS';
  }
  // History may pass through the empty pre-content state. Retained exports
  // and their replay receipts still reference the clock in effect at acceptance.
  if (store.db.prepare(`SELECT 1 FROM main.exports
    WHERE projectId=? AND CASE WHEN json_valid(data) THEN json_extract(data,'$.mode') END IN ('timeline','clip-audio')
    UNION ALL SELECT 1 FROM main.timeline_requests
    WHERE CASE WHEN json_valid(response) THEN json_extract(response,'$.mode') END='timeline'
      AND CASE WHEN json_valid(response) THEN json_extract(response,'$.projectId') END=? LIMIT 1`).get(store.projectId, store.projectId)) {
    return 'FROZEN_TIMELINE_OUTPUT';
  }
}

export function assertFormat6TimelineFpsEditable(store: ProjectStore, mode: TimelineFpsChangeMode = 'edit'): void {
  const reason = format6TimelineFpsChangeBlock(store, mode);
  if (reason === 'FORMAT_REQUIRED') {
    throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '修改帧率只适用于启用开发开关的格式 6 项目。', 409, {reason});
  }
  if (reason) timelineFpsLocked(reason);
}

/** The sequence edit/history path owns the only clock transition after creation. */
export function setEmptyFormat6TimelineFpsInside(store: ProjectStore, fps: TimelineFps, mode: TimelineFpsChangeMode): number {
  assertFormat6TimelineFpsEditable(store, mode);
  const write = timelineFpsWrites.get(store);
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!write || write.to !== undefined || !timeline || timeline.fps !== write.from || !isTimelineFps(fps) || fps === timeline.fps) {
    throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', '时间线帧率变更无效。', 409);
  }
  const reader = readProjectReaderState(store.db, 'project', FORMAT6_PROJECT_SCHEMA_VERSION);
  if (fps !== 30 && reader && !reader.features.includes(TIMELINE_FPS_READER_FEATURE)) {
    const project = store.get('projects', store.projectId);
    if (!project) throw new AppError('PROJECT_INVALID', '项目缺少元数据。', 422, {database: 'project', reason: 'metadata'});
    store.put('projects', {...project, requiredReaderFeatures: [...reader.features, TIMELINE_FPS_READER_FEATURE]});
  }
  const revision = timeline.revision + 1;
  store.put('timelines', {...timeline, fps, revision, updatedAt: new Date().toISOString()});
  write.to = fps;
  return revision;
}

/** Narrow metadata assertion over this exact kernel capability. A copied
 * store or a different held database cannot provide its history identity. */
export function heldProjectHistoryIdentity(value: unknown): ReturnType<ReturnType<typeof openProjectConnection>['historyIdentity']> {
  if (!isProjectStore(value)) throw Object.assign(new TypeError('Project store identity is not verified'), {code: 'PROJECT_STORE_UNVERIFIED'});
  return verifiedStores.get(value)!.connection.historyIdentity();
}

/** Backend-owned transaction fences run first inside every store transaction,
 * observers last before its commit; an observer failure rolls back both domain
 * rows and its own writes. The same rules as db.ts's workspace registrations,
 * kept per connection. */
const transactionFences = new WeakMap<DatabaseSync, Set<() => void>>();
export function registerProjectTransactionFence(db: DatabaseSync, fence: () => void): () => void {
  let fences = transactionFences.get(db);
  if (!fences) {
    fences = new Set();
    transactionFences.set(db, fences);
  }
  fences.add(fence);
  return () => { fences?.delete(fence); };
}
const transactionObservers = new WeakMap<DatabaseSync, Set<(result: unknown) => void>>();
export function registerProjectTransactionObserver(db: DatabaseSync, observer: (result: unknown) => void): () => void {
  let observers = transactionObservers.get(db);
  if (!observers) {
    observers = new Set();
    transactionObservers.set(db, observers);
  }
  observers.add(observer);
  return () => { observers?.delete(observer); };
}

export interface CommitProjectAssetHashOptions {
  readonly assetId: string;
  /** Exact persisted JSON captured before asynchronous full-file hashing. */
  readonly expectedRaw: string;
  readonly reference: MediaReference;
  readonly sha256: string;
  readonly beforeEffect?: () => void;
  readonly signal?: AbortSignal;
}

/** Commit only derived full-hash/observed-mtime metadata. This is deliberately
 * separate from domain transactions: it must retain every ownership/effect
 * fence without manufacturing a domain mutation receipt for hash preparation.
 * There is no general observer bypass or caller-supplied mutation callback. */
export function commitProjectAssetHash(store: ProjectStore, options: CommitProjectAssetHashOptions): Record<string, unknown> {
  const verified = verifiedStores.get(store);
  if (!verified || !isProjectStore(store)) throw new TypeError('Hash metadata requires the exact live project owner');
  if (typeof options.expectedRaw !== 'string' || typeof options.assetId !== 'string' || !/^[a-f0-9-]{36}$/u.test(options.assetId)) throw new TypeError('An exact asset JSON identity is required');
  function changed(): never {throw mediaUnavailableError('MEDIA_CHANGED', options.assetId, 'content');}
  const reference = mediaReferenceSchema.safeParse(options.reference);
  if (!reference.success || !/^[a-f0-9]{64}$/u.test(options.sha256) || reference.data.fullSha256 !== options.sha256) changed();
  const db = store.db, connection = verified.connection;
  if (db.isTransaction) throw new Error('Nested transactions are not supported');
  const fence = (): void => {
    options.signal?.throwIfAborted();
    options.beforeEffect?.();
    options.signal?.throwIfAborted();
    if (!isProjectStore(store)) throw new TypeError('The project owner is no longer live');
    connection.throwIfMoved();
  };
  fence();
  db.exec('BEGIN');
  try {
    for (const transactionFence of transactionFences.get(db) ?? []) transactionFence();
    fence();
    const persisted = db.prepare('SELECT id,projectId,data FROM project.assets WHERE id=?').get(options.assetId);
    if (!persisted || persisted.id !== options.assetId || persisted.projectId !== store.projectId || persisted.data !== options.expectedRaw) changed();
    const current: unknown = JSON.parse(options.expectedRaw);
    if (current === null || typeof current !== 'object' || Array.isArray(current)) changed();
    const row = current as Record<string, unknown>;
    const oldReference = mediaReferenceSchema.safeParse(row.reference);
    if (row.id !== options.assetId || row.projectId !== store.projectId || !Number.isSafeInteger(row.referenceRevision) || Number(row.referenceRevision) < 1 ||
      Object.hasOwn(row, 'relativePath') || !oldReference.success || row.sizeBytes !== oldReference.data.sizeBytes || row.sha256 !== oldReference.data.fullSha256 ||
      row.sha256 !== null && row.sha256 !== options.sha256) changed();
    const old = oldReference.data, next = reference.data;
    if (old.pathForm !== next.pathForm || old.path !== next.path || old.volume !== next.volume || old.sizeBytes !== next.sizeBytes || old.sampledSha256 !== next.sampledSha256) changed();
    // Preserve every original field and its ordering, including unknown domain
    // metadata. The validated candidate can change only these three leaves.
    const metadataChanged = row.sha256 !== options.sha256 || old.mtimeMs !== next.mtimeMs;
    const result = metadataChanged ? {...row, sha256: options.sha256, reference: {...row.reference as Record<string, unknown>, fullSha256: options.sha256, mtimeMs: next.mtimeMs}} : row;
    const resultRaw = metadataChanged ? JSON.stringify(result) : options.expectedRaw;
    if (resultRaw !== options.expectedRaw) {
      connection.throwIfMoved();
      const update = db.prepare('UPDATE project.assets SET data=? WHERE id=? AND projectId=? AND data=?').run(resultRaw, options.assetId, store.projectId, options.expectedRaw);
      if (Number(update.changes) !== 1) changed();
    }
    fence();
    // A backend fence may observe current metadata but may never replace the
    // asset that this hash was prepared for, even immediately before COMMIT.
    if (db.prepare('SELECT data FROM project.assets WHERE id=? AND projectId=?').get(options.assetId, store.projectId)?.data !== resultRaw) changed();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

const TABLES = new Set(['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines']);
const parseRowData = (data: unknown): unknown => JSON.parse(typeof data === 'string' ? data : String(data));
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as {then?: unknown}).then === 'function';
const sqlValue = (value: unknown): SQLInputValue => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  throw new TypeError('Workspace row values must be SQLite primitives');
};

/** Opens a project file (openProjectConnection) as a store. `root` is the
 * project directory. */
export function openProjectStore(options: OpenProjectConnectionOptions): ProjectStore {
  return storeFromConnection(openProjectConnection(options));
}
export function openStagedProjectStore(options: StagedProjectConnectionOptions): ProjectStore {
  return storeFromConnection(openStagedProjectConnection(options));
}
function storeFromConnection(connection: ProjectConnection): ProjectStore {
  const database = connection.db;
  const notificationFailed = (): never => {
    throw new AppError('BACKGROUND_TASK_INDEX_UNCERTAIN', '任务已经记录，但后台索引尚未确认。请重新打开项目检查，不要重复提交生成。', 503,
      {projectId: connection.projectId, mutationOutcome: 'unknown'});
  };
  const table = (t: string): string => {
    if (!TABLES.has(t)) throw Error('Unknown table');
    return t;
  };
  const format5 = (): boolean => isSequenceProjectFormat(database.prepare('PRAGMA project.user_version').get()?.user_version);
  const get = (t: string, id: string): unknown => {
    table(t);
    if (t === 'timelines' && format5()) {
      const record = readFormat5TimelineRecord(database, 'project');
      return record && record.id === id ? record : null;
    }
    const row = database.prepare(`SELECT data FROM ${table(t)} WHERE id=?`).get(id);
    return row ? parseRowData(row.data) : null;
  };
  const list = (t: string, projectId?: string): unknown[] => {
    table(t);
    if (t === 'timelines' && format5()) {
      const record = readFormat5TimelineRecord(database, 'project');
      return record && (projectId === undefined || record.projectId === projectId) ? [record] : [];
    }
    const rows = projectId ? database.prepare(`SELECT data FROM ${table(t)} WHERE projectId=?`).all(projectId) : database.prepare(`SELECT data FROM ${table(t)}`).all();
    return rows.map(row => parseRowData(row.data));
  };
  const put = <T extends object>(t: string, value: T): T => {
    table(t);
    if (!database.isTransaction && format5()) {
      return tx(() => put(t, value));
    }
    if (connection.historyState === 'diverged') throw new AppError('PROJECT_HISTORY_DIVERGED','项目内容与本机记录不一致，请先确认处置。',409,{projectId:connection.projectId});
    if (t === 'timelines' && format5()) {
      connection.throwIfMoved();
      putFormat5TimelineInside(database, 'project', value, connection.projectId);
      return value;
    }
    const columns = t === 'projects' ? ['id', 'data'] : t === 'versions' ? ['id', 'projectId', 'jobId', 'data'] : ['id', 'projectId', 'data'];
    const record = value as Readonly<Record<string, unknown>>;
    const values = columns.map(column => column === 'data' ? JSON.stringify(value) : sqlValue(record[column]));
    connection.throwIfMoved();
    if ((t === 'jobs' || t === 'exports') && typeof record.id === 'string' && !database.isTransaction) {
      validateBackgroundTaskAdmission(database, [{kind: t === 'jobs' ? 'job' : 'export', taskId: record.id}]);
    }
    database.prepare(`INSERT INTO ${t}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(...values);
    if ((t === 'jobs' || t === 'exports') && typeof record.id === 'string') {
      // Inside a transaction this only records an identity. An autocommit put
      // has already committed, so its synchronous notification cannot roll back.
      try { markBackgroundTaskChanged(database, t === 'jobs' ? 'job' : 'export', record.id); }
      catch { notificationFailed(); }
    }
    return value;
  };
  // A transaction owns its complete synchronous callback. Never commit before
  // asynchronous work, or let a nested caller roll back an outer transaction.
  // The one intended difference from db.ts: a plain (deferred) BEGIN instead
  // of BEGIN IMMEDIATE. The connection holds every file's lock already, so
  // IMMEDIATE takes no lock earlier; it would put all three databases in the
  // write transaction, and every commit would create, sync and delete a
  // super-journal. With BEGIN only the databases written join it: a commit of
  // local records alone does not touch the project file.
  // Once the project file alone has been renamed or moved, tx (before BEGIN)
  // and put (before its statement, inside a transaction too) throw
  // PROJECT_FILE_MOVED and write nothing (connection.throwIfMoved).
  const tx = <T>(callback: () => T): T => {
    if (typeof callback !== 'function' || isAsyncFunction(callback)) throw new TypeError('Transactions require a synchronous callback');
    if (database.isTransaction) throw new Error('Nested transactions are not supported');
    connection.throwIfMoved();
    database.exec('BEGIN');
    let result!: T;
    try {
      const formatBefore = database.prepare('PRAGMA project.user_version').get()?.user_version;
      const readerBefore = typeof formatBefore === 'number' ? readProjectReaderState(database, 'project', formatBefore) : undefined;
      if (readerBefore?.fps !== undefined) timelineFpsWrites.set(store, {from: readerBefore.fps});
      const format5Content = isSequenceProjectFormat(formatBefore) ? readProjectContentStamp(database) : undefined;
      const schemaBefore = format5Content ? database.prepare('PRAGMA project.schema_version').get()?.schema_version : undefined;
      for (const fence of transactionFences.get(database) ?? []) fence();
      result = callback();
      if (isThenable(result)) {
        if (isPromise(result)) Promise.resolve(result).catch(() => {});
        throw new TypeError('Transactions require a synchronous result');
      }
      if (readerBefore) {
        const readerAfter = readProjectReaderState(database, 'project', FORMAT6_PROJECT_SCHEMA_VERSION)!;
        const write = timelineFpsWrites.get(store);
        if (write && readerAfter.fps !== (write.to ?? write.from)) {
          throw new AppError('TIMELINE_FORMAT_LOCKED', '项目帧率只能在空时间线的帧率操作中修改。', 409);
        }
        if (write?.to !== undefined && hasTimelineContent(store)) timelineFpsLocked('TIMELINE_NOT_EMPTY');
        // A 30 fps header can still have non-30 fps history or receipts.
        if (readerBefore.features.includes(TIMELINE_FPS_READER_FEATURE) &&
            !readerAfter.features.includes(TIMELINE_FPS_READER_FEATURE)) {
          throw new AppError('TIMELINE_FORMAT_LOCKED', '项目仍需支持时间线帧率的读取器。', 409);
        }
      }
      for (const observer of transactionObservers.get(database) ?? []) observer(result);
      const formatAfter = database.prepare('PRAGMA project.user_version').get()?.user_version;
      if (isSequenceProjectFormat(formatAfter) &&
          (!format5Content || !sameContentStamp(format5Content, readProjectContentStamp(database)) ||
           schemaBefore !== database.prepare('PRAGMA project.schema_version').get()?.schema_version)) {
        assertProjectReaderRequirements(database, 'project', formatAfter);
        fenceFormat5ProjectContent(database, 'project');
      }
      // A pure quota check prevents a committed task from exceeding the
      // discovery bound. It never writes a prepared app-library record.
      validateBackgroundTaskChanges(database);
      database.exec('COMMIT');
    } catch (error) {
      try { if (database.isTransaction) database.exec('ROLLBACK'); }
      finally { discardBackgroundTaskChanges(database); }
      throw error;
    } finally {
      timelineFpsWrites.delete(store);
    }
    // App-library indexing follows the actual project COMMIT. Its failure is
    // uncertain acknowledgement, never evidence that the domain rolled back.
    try { flushBackgroundTaskChanges(database); }
    catch { notificationFailed(); }
    return result;
  };
  let closed = false;
  const close = (): void => {
    if (closed) return;
    connection.close();
    closeBackgroundTaskEvents(database);
    closed = true;
  };
  const store: ProjectStore = {
    db: database, root: connection.projectDir,
    projectId: connection.projectId, projectFile: connection.projectFile, projectDir: connection.projectDir,
    localDir: connection.localDir, cacheDir: connection.cacheDir, tempDir: connection.tempDir, historyState: connection.historyState, historyAdmission: connection.historyAdmission,
    get, list, put, tx, close,
  };
  verifiedStores.set(store, {connection, isClosed: () => closed});
  return store;
}

/** Creates the project file (never replacing one), then opens it. */
export function createProjectStore(options: OpenProjectConnectionOptions & CreateProjectFileOptions): ProjectStore {
  createProjectFile(options.projectFile, {projectId: options.projectId, contentToken: options.contentToken, format4: options.format4, targetFormat: options.targetFormat});
  return openProjectStore(options);
}
