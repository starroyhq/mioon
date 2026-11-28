import {AsyncResource} from 'node:async_hooks';
import {createHash, randomUUID} from 'node:crypto';
import {constants, lstatSync, mkdirSync, openSync, closeSync, realpathSync, rmSync, statfsSync, writeFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {AppError} from '../../contracts/src/app-error.ts';
import {fcpExportGetOutputSchema, fcpExportResultSchema} from '../../contracts/src/fcp-export.ts';
import type {FcpExportError, FcpExportStartInput, FcpExportGetInput, FcpExportGetOutput, FcpExportPreviewInput, FcpExportCancelOutput, FcpExportCancelInput, FcpExportProgress, FcpExportResult} from '../../contracts/src/fcp-export.ts';
import {FCPXML_EXPORT_TASK_KIND} from '../../contracts/src/project-registry.ts';
import type {FcpExportTask} from '../../contracts/src/project-registry.ts';
import type {AppOperationReceiptStore, OutsidePathConfirmationStore} from './app-db/stores.ts';
import {assertAgentTaskJobEffect, assertTaskEffectOrigin, bindAgentTaskJobInside, taskEffectOrigin} from './agent/task-effects-v2.ts';
import {fcpDisplayPath, fcpFileIdentity, FcpExportFailure, fcpMissingMarkdown, fcpSafeName, fcpSourceIdentity, planFcpExport} from './fcp-export-plan.ts';
import type {FcpMediaCopy, FcpSource} from './fcp-export-plan.ts';
import {serializeFcpXml} from './fcp-xml.ts';
import type {FcpXmlAsset} from './fcp-xml.ts';
import {discloseFcpExportTask, FCPXML_EXPORT_TASK_SQL} from './fcpxml-export-task.ts';
import {createProjectAssetReferenceServices} from './project-asset-references.ts';
import {createPreparedMediaFileFence} from './prepared-media-file.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import type {ProjectStore} from './project-file/store.ts';
import {isFormat5Project} from './sequence-edit.ts';

type Row = FcpExportTask & Pick<FcpExportGetOutput, 'result' | 'error'> & {cleanupPending?: true};
type FileIdentity = {path: string; device: string; inode: string; stamp: string};
type Destination = {directory: FileIdentity; expires: number};
const zeroProgress = (): FcpExportProgress => ({files: 0, totalFiles: 0, bytes: 0, totalBytes: 0});
type Allocation = {parent: FileIdentity; bundle: FileIdentity};
type Publication = Allocation & {xml: FileIdentity; result: FcpExportResult};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fileIdentity(value: unknown): value is FileIdentity {
  return record(value) && typeof value.path === 'string' && path.isAbsolute(value.path) &&
    typeof value.device === 'string' && typeof value.inode === 'string' && typeof value.stamp === 'string';
}
function allocationShape(value: unknown): value is Allocation {
  return record(value) && fileIdentity(value.parent) && fileIdentity(value.bundle) &&
    path.dirname(value.bundle.path) === value.parent.path && path.extname(value.bundle.path) === '.fcpxmld';
}
function publicationShape(value: unknown): value is Publication {
  if (!record(value)) return false;
  const {xml, result} = value;
  return allocationShape(value) && fileIdentity(xml) &&
    xml.path === path.join(value.bundle.path, 'Info.fcpxml') && fcpExportResultSchema.safeParse(result).success;
}
const allocated = 'fcpxml.bundle.allocated';
const published = 'fcpxml.bundle.published';
const sameId = (a: FileIdentity, b: FileIdentity): boolean => a.path === b.path && a.stamp === b.stamp;
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = (): AppError => new AppError('NOT_FOUND', '找不到 Final Cut Pro 导出任务。', 404);
const invalidDestination = (): AppError => new AppError('NOT_WRITABLE', '导出位置已失效，请重新选择。', 409);
const failed = (code: FcpExportError['code']): FcpExportFailure => new FcpExportFailure({code});

function inspect(file: string, kind: 'directory' | 'file'): FileIdentity {
  const info = lstatSync(file, {bigint: true});
  if ((kind === 'directory' ? !info.isDirectory() : !info.isFile()) || realpathSync(file) !== file) {
    throw failed('NOT_WRITABLE');
  }
  return {path: file, device: String(info.dev), inode: String(info.ino), stamp: fcpFileIdentity(info)};
}

function assertDirectory(expected: FileIdentity): void {
  try {if (sameId(inspect(expected.path, 'directory'), expected)) return;} catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(errno(error) ?? '') && !(error instanceof FcpExportFailure)) throw error;
  }
  throw failed('NOT_WRITABLE');
}

function ensureProjectDestination(projectRoot: FileIdentity): FileIdentity {
  assertDirectory(projectRoot);
  const directory = path.join(projectRoot.path, '导出');
  try {mkdirSync(directory, {mode: 0o755});} catch (error) {if (errno(error) !== 'EEXIST') throw error;}
  assertDirectory(projectRoot);
  return inspect(directory, 'directory');
}

function reserveBundle(parent: FileIdentity, title: string): Allocation {
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    assertDirectory(parent);
    const bundle = path.join(parent.path, title + (suffix === 1 ? '' : ' ' + suffix) + '.fcpxmld');
    try {mkdirSync(bundle, {mode: 0o700});} catch (error) {
      if (errno(error) === 'EEXIST') continue;
      throw error;
    }
    return {parent, bundle: inspect(bundle, 'directory')};
  }
  throw failed('NOT_WRITABLE');
}

function fileRoom(directory: string, remaining: number): number {
  const {bavail, bsize} = statfsSync(directory, {bigint: true});
  const deficit = BigInt(remaining) - bavail * bsize;
  return deficit > 0n ? Number(deficit) : 0;
}

function errorView(error: unknown, parent: FileIdentity | undefined, remaining: number): FcpExportError {
  if (error instanceof FcpExportFailure) return error.detail;
  switch (errno(error)) {
    case 'ENOSPC': case 'EDQUOT': {
      let shortBytes: number | undefined;
      try {if (parent) shortBytes = fileRoom(parent.path, remaining) || undefined;} catch { /* The disk might have disappeared. */ }
      return {code: 'DISK_FULL', ...(shortBytes !== undefined && {values: {shortBytes}})};
    }
    case 'EACCES': case 'EPERM': case 'EROFS': case 'ENOTDIR': case 'ENOENT':
      return {code: 'NOT_WRITABLE'};
    default: return {code: 'EXPORT_FAILED'};
  }
}

const sourceFailure = (source: FcpSource): FcpExportFailure =>
  new FcpExportFailure({code: 'MEDIA_UNREADABLE', values: {file: path.basename(source.name.replaceAll('\\', '/'))}});

async function copyFcpMedia(copy: FcpMediaCopy, destination: FileIdentity, buffer: Buffer, fence: () => void, sourceFence: () => void, written: (bytes: number) => void): Promise<void> {
  const {source} = copy;
  let input: FileHandle | undefined;
  let output: number | undefined;
  try {
    fence();
    sourceFence();
    try {
      input = await open(source.reference.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stats = await input.stat({bigint: true});
      if (!stats.isFile() || fcpSourceIdentity(stats) !== source.identity) throw sourceFailure(source);
    } catch {throw sourceFailure(source);}
    fence();
    sourceFence();
    assertDirectory(destination);
    output = openSync(path.join(destination.path, copy.fileName), 'wx', 0o644);
    const hash = createHash('sha256');
    let left = source.reference.reference.sizeBytes;
    while (left > 0) {
      fence();
      sourceFence();
      const read = await input.read(buffer, 0, Math.min(left, buffer.length), null).catch(() => {throw sourceFailure(source);});
      if (!read.bytesRead) throw sourceFailure(source);
      fence();
      sourceFence();
      assertDirectory(destination);
      const bytes = buffer.subarray(0, read.bytesRead);
      hash.update(bytes);
      writeFileSync(output, bytes);
      written(read.bytesRead);
      left -= read.bytesRead;
    }
    const last = await input.stat({bigint: true}).catch(() => {throw sourceFailure(source);});
    if (fcpSourceIdentity(last) !== source.identity || hash.digest('hex') !== copy.sha256) throw sourceFailure(source);
  } finally {
    try {if (output !== undefined) closeSync(output);} finally {await input?.close();}
  }
}

export function createFcpExportServices(store: ProjectStore, options: {
  outsidePaths: Pick<OutsidePathConfirmationStore, 'list'>;
  receipts: AppOperationReceiptStore;
  assertMutationAllowed(): void;
  signal?: AbortSignal;
  freeSpaceShortfall?: typeof fileRoom;
}) {
  const references = createProjectAssetReferenceServices(store, {outsidePaths: options.outsidePaths});
  const active = new Map<string, {controller: AbortController; done: Promise<void>}>();
  const destinations = new Map<string, Destination>();
  const {db, projectId} = store;
  const owner = new AsyncResource('MioonFcpExport');
  let closing = false;
  const now = (): string => new Date().toISOString();
  const receiptKey = (id: string): string => projectId + ':' + id;
  const receiptDigest = (id: string): string => digest([store.projectFile, projectId, id]);
  const readAsset = (id: string): Record<string, unknown> | undefined => {
    const asset = store.get('assets', id) as Record<string, unknown> | null;
    return asset?.id === id && asset.projectId === projectId ? asset : undefined;
  };
  function scope(id: string): void {
    if (id !== projectId) throw missing();
    if (!isFormat5Project(store)) throw new AppError('UNKNOWN_OPERATION', 'Final Cut Pro 导出仅适用于格式 5 项目。', 404);
  }
  function timelineBasis() {
    const timeline = readFormat5TimelineRecord(db, 'project');
    if (!timeline || timeline.projectId !== projectId) throw new AppError('NOT_FOUND', '找不到项目时间线。', 404);
    const project = store.get('projects', projectId) as {name?: unknown} | null;
    const projectName = typeof project?.name === 'string' ? project.name.replace(/\.fcpxmld$/iu, '') : 'Final Cut Pro';
    const destination = path.join(store.projectDir, '导出');
    return {timeline, projectName, destination};
  }
  const progressUpdate = (row: Row): void => {
    row.revision++;
    row.updatedAt = now();
    store.put('exports', row);
  };
  function readRow(id: string): Row {
    const value = store.get('exports', id);
    const task = discloseFcpExportTask(value, {id, projectId});
    if (!task) throw missing();
    const {result, error, cleanupPending} = value as Row;
    const output = fcpExportGetOutputSchema.safeParse({
      status: task.status, progress: task.progress,
      ...(task.status === 'done' ? {result} : task.status === 'failed' ? {error} : {}),
    });
    if (!output.success || task.status === 'done' && !output.data.result || task.status === 'failed' && !output.data.error) {
      throw new AppError('EXPORT_FAILED', '无法读取 Final Cut Pro 导出任务。', 409);
    }
    return {...task, ...output.data, ...(cleanupPending === true && {cleanupPending})};
  }
  function remember<T>(operation: string, id: string, response: T): void {
    options.receipts.write({operation, requestId: receiptKey(id), digest: receiptDigest(id), response, createdAt: now()});
  }
  function retained<T>(operation: string, id: string, shape: (value: unknown) => value is T): T | undefined {
    const receipt = options.receipts.read(operation, receiptKey(id));
    if (!receipt || receipt.digest !== receiptDigest(id)) return;
    return shape(receipt.response) ? receipt.response : undefined;
  }
  function removeIncomplete(allocation: Allocation): boolean {
    try {
      assertDirectory(allocation.parent);
      if (!lstatSync(allocation.bundle.path, {throwIfNoEntry: false})) return true;
      assertDirectory(allocation.bundle);
      rmSync(allocation.bundle.path, {recursive: true, force: true});
      return true;
    } catch {
      // The original volume may have disappeared. Retain the app-owned
      // receipt and try again when the exact directory becomes visible.
      return false;
    }
  }
  function finish(row: Row, terminal: {result: FcpExportResult} | {error: FcpExportError} | {cancelled: true}): void {
    row.status = 'result' in terminal ? 'done' : 'error' in terminal ? 'failed' : 'cancelled';
    if ('result' in terminal) row.result = terminal.result;
    if ('error' in terminal) row.error = terminal.error;
    progressUpdate(row);
  }

  async function run(row: Row, basis: ReturnType<typeof timelineBasis>, copyMedia: boolean, selected: FileIdentity | undefined, signal: AbortSignal): Promise<void> {
    let parent: FileIdentity | undefined;
    let allocation: Allocation | undefined;
    let retainedPublication = false;
    const fence = (): void => {
      signal.throwIfAborted();
      options.assertMutationAllowed();
      assertAgentTaskJobEffect(db, 'export', row.id);
    };
    try {
      fence();
      const root = inspect(store.projectDir, 'directory');
      const plan = await planFcpExport({...basis, copyMedia, references, readAsset, signal, beforeEffect: fence});
      row.progress = {files: 0, totalFiles: plan.preview.mediaFiles, bytes: 0, totalBytes: plan.preview.mediaBytes};
      progressUpdate(row);
      fence();
      parent = selected ?? ensureProjectDestination(root);
      assertDirectory(parent);
      const shortBytes = (options.freeSpaceShortfall ?? fileRoom)(parent.path, row.progress.totalBytes);
      if (shortBytes > 0) throw new FcpExportFailure({code: 'DISK_FULL', values: {shortBytes}});
      allocation = reserveBundle(parent, row.title);
      remember(allocated, row.id, allocation);
      const {bundle} = allocation;
      const bundleFence = (): void => {fence(); assertDirectory(parent!); assertDirectory(bundle);};
      const assets = new Map<string, FcpXmlAsset>();
      const sourceFences = new Map<string, () => void>();
      for (const [id, asset] of plan.assets) {
        if (!asset.source) continue;
        const source = asset.source;
        const makeFence = () => createPreparedMediaFileFence(store, source.reference.file,
          {assetId: id, outsidePaths: options.outsidePaths, beforeEffect: fence});
        let checkFile: () => void;
        try {checkFile = makeFence();} catch {fence(); throw sourceFailure(source);}
        const check = (): void => {
          try {
            checkFile();
            if (readAsset(id)?.referenceRevision !== source.reference.referenceRevision ||
                fcpSourceIdentity(lstatSync(source.reference.file, {bigint: true})) !== source.identity) throw sourceFailure(source);
          } catch {fence(); throw sourceFailure(source);}
        };
        check();
        sourceFences.set(id, check);
      }
      const buffer = Buffer.allocUnsafe(plan.copies.length ? 1024 * 1024 : 0);
      if (copyMedia) {
        bundleFence();
        const media = path.join(bundle.path, 'Media');
        mkdirSync(media, {mode: 0o755});
        const destination = inspect(media, 'directory');
        let lastProgress = Date.now();
        for (const copy of plan.copies) {
          await copyFcpMedia(copy, destination, buffer, bundleFence, sourceFences.get(copy.source.reference.assetId)!, bytes => {
            row.progress.bytes += bytes;
            if (Date.now() - lastProgress >= 250) {lastProgress = Date.now(); progressUpdate(row);}
          });
          row.progress.files++;
          progressUpdate(row);
        }
      }
      for (const [id, asset] of plan.assets) {
        const file = asset.bundleRelativePath ? path.join(bundle.path, asset.bundleRelativePath) : asset.source!.reference.file;
        assets.set(id, {...asset.metadata, fileUrl: pathToFileURL(file).href});
      }
      bundleFence();
      for (const check of sourceFences.values()) check();
      const manifest = {
        version: 1, fcpxmlVersion: '1.13', copyMedia, timeline: plan.preview.timeline,
        media: plan.copies.map(copy => ({file: 'Media/' + copy.fileName, sha256: copy.sha256, bytes: copy.source.reference.reference.sizeBytes})),
        missing: plan.preview.missing, approximations: plan.preview.approximations,
      };
      const write = (name: string, text: string): number => {
        bundleFence();
        writeFileSync(path.join(bundle.path, name), text, {flag: 'wx', mode: 0o644});
        return Buffer.byteLength(text);
      };
      const written = write('missing.md', fcpMissingMarkdown(plan.preview))
        + write('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
        + write('Info.fcpxml', serializeFcpXml({timeline: basis.timeline, projectName: row.title, assets}));
      const result = {bundleName: path.basename(bundle.path), displayPath: fcpDisplayPath(bundle.path),
        bytes: written + row.progress.totalBytes, missingCount: plan.preview.missing.length};
      const xml = inspect(path.join(bundle.path, 'Info.fcpxml'), 'file');
      remember(published, row.id, {...allocation, xml, result});
      retainedPublication = true;
      finish(row, {result});
    } catch (error) {
      // A terminal receipt protects a completed package even if the project
      // database failed to acknowledge its final status.
      if (retainedPublication) throw error;
      if (allocation && !removeIncomplete(allocation)) {
        row.cleanupPending = true;
        finish(row, {error: {code: 'NOT_WRITABLE'}});
        return;
      }
      if (signal.aborted) finish(row, {cancelled: true});
      else finish(row, {error: errorView(error, parent, row.progress.totalBytes - row.progress.bytes)});
    }
  }

  function recover(): void {
    if (!isFormat5Project(store)) return;
    for (const record of db.prepare(`SELECT id FROM exports WHERE projectId=? AND (${FCPXML_EXPORT_TASK_SQL})
        AND CASE WHEN json_valid(data) THEN json_extract(data,'$.status')='running' OR json_extract(data,'$.cleanupPending')=1 END`).all(projectId)) {
      const id = String(record.id);
      if (active.has(id)) continue;
      const row = readRow(id);
      const complete = retained(published, id, publicationShape);
      if (complete) {finish(row, {result: complete.result}); continue;}
      const partial = retained(allocated, id, allocationShape);
      const cleaned = !partial || removeIncomplete(partial);
      if (cleaned) delete row.cleanupPending;
      else row.cleanupPending = true;
      if (row.status === 'running') finish(row, {error: {code: cleaned ? 'EXPORT_FAILED' : 'NOT_WRITABLE'}});
      else if (cleaned) progressUpdate(row);
    }
  }

  function chooseDestination(input: {projectId: string; token: string; directory: string; device: string; inode: string}) {
    scope(input.projectId);
    let directory: FileIdentity;
    try {directory = inspect(input.directory, 'directory');} catch {throw invalidDestination();}
    if (directory.device !== input.device || directory.inode !== input.inode) throw invalidDestination();
    const time = Date.now();
    for (const [key, existing] of destinations) if (existing.expires <= time) destinations.delete(key);
    if (destinations.size >= 64) destinations.delete(destinations.keys().next().value!);
    destinations.set(input.token, {directory, expires: time + 30 * 60 * 1000});
    return {token: input.token, displayPath: fcpDisplayPath(directory.path)};
  }

  function completedBundle(input: FcpExportGetInput) {
    scope(input.projectId);
    if (readRow(input.exportId).status !== 'done') return null;
    const complete = retained(published, input.exportId, publicationShape);
    if (!complete) return null;
    try {
      assertDirectory(complete.parent);
      assertDirectory(complete.bundle);
      if (!sameId(inspect(complete.xml.path, 'file'), complete.xml)) return null;
    } catch {return null;}
    const {path: bundlePath, device, inode} = complete.bundle;
    return {path: bundlePath, device, inode};
  }

  async function preview(input: FcpExportPreviewInput, signal?: AbortSignal) {
    scope(input.projectId);
    const plan = await planFcpExport({...timelineBasis(), copyMedia: input.copyMedia, references, readAsset, signal, beforeEffect: assertTaskEffectOrigin});
    return plan.preview;
  }
  function start(input: FcpExportStartInput) {
    scope(input.projectId);
    if (input.requestId.length > 200 || input.name.length > 512) throw new AppError('VALIDATION_ERROR', '导出参数过长。', 400);
    if (closing || options.signal?.aborted) throw new AppError('EXPORT_FAILED', '项目正在关闭。', 503);
    if (taskEffectOrigin() && input.destination.kind !== 'project') throw new AppError('VALIDATION_ERROR', 'Mio 只能导出到项目的导出文件夹。', 400);
    const requestHash = digest([input.name, input.copyMedia, input.destination.kind, input.destination.kind === 'chosen' ? input.destination.token : null]);
    const accepted = db.prepare("SELECT resourceId,requestHash FROM idempotency WHERE scope='export.fcpxml.start' AND requestId=?").get(input.requestId);
    if (accepted) {
      if (accepted.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', '同一请求 ID 已用于不同内容。', 409);
      return {exportId: readRow(String(accepted.resourceId)).id};
    }
    const selected = input.destination.kind === 'chosen' ? destinations.get(input.destination.token) : undefined;
    if (input.destination.kind === 'chosen' && (!selected || selected.expires <= Date.now())) throw invalidDestination();
    if (active.size >= 4) throw new AppError('PROJECT_HOST_BUSY', '请等待正在运行的 Final Cut Pro 导出。', 409);
    const basis = timelineBasis();
    const id = randomUUID();
    const title = fcpSafeName(input.name.replace(/\.fcpxmld$/iu, ''), fcpSafeName(basis.projectName, 'Final Cut Pro'));
    const time = now();
    const row: Row = {id, projectId, requestId: input.requestId, title, mode: FCPXML_EXPORT_TASK_KIND,
      kind: FCPXML_EXPORT_TASK_KIND, status: 'running', progress: zeroProgress(), createdAt: time, updatedAt: time, revision: 1};
    let indexFailure: AppError | undefined;
    try {
      store.tx(() => {
        assertTaskEffectOrigin();
        store.put('exports', row);
        db.prepare("INSERT INTO idempotency VALUES('export.fcpxml.start',?,?,?)").run(input.requestId, requestHash, id);
        bindAgentTaskJobInside(db, 'export', id);
        return {exportId: id};
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'BACKGROUND_TASK_INDEX_UNCERTAIN' ||
          db.prepare("SELECT resourceId FROM idempotency WHERE scope='export.fcpxml.start' AND requestId=?").get(input.requestId)?.resourceId !== id) throw error;
      // The project transaction committed, so the recorded task remains the
      // sole owner of this request even when the app index did not acknowledge it.
      indexFailure = error;
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const done = owner.runInAsyncScope(() => new Promise<void>(resolve => setImmediate(resolve))
      .then(() => run(row, basis, input.copyMedia, selected?.directory, signal)).finally(() => active.delete(id)));
    // The task's own terminal row is its outcome. Cancellation and drain
    // still await this exact promise when the storage owner fails.
    void done.catch(() => {});
    active.set(id, {controller, done});
    if (indexFailure) throw indexFailure;
    return {exportId: id};
  }
  function get(input: FcpExportGetInput): FcpExportGetOutput {
    scope(input.projectId);
    const {status, progress, result, error} = readRow(input.exportId);
    return {status, progress, ...(result && {result}), ...(error && {error})};
  }
  async function cancel(input: FcpExportCancelInput): Promise<FcpExportCancelOutput> {
    scope(input.projectId);
    const task = active.get(input.exportId);
    task?.controller.abort();
    await task?.done;
    const row = readRow(input.exportId);
    if (row.status === 'running') throw new AppError('EXPORT_FAILED', '导出任务的状态尚未恢复。', 409);
    return {status: row.status};
  }
  return {preview, start, get, cancel, chooseDestination, completedBundle, recover,
    isBusy: () => active.size > 0,
    async drain() {
      closing = true;
      const pending = [...active.values()];
      for (const task of pending) task.controller.abort();
      const results = await Promise.allSettled(pending.map(task => task.done));
      owner.emitDestroy();
      for (const outcome of results) if (outcome.status === 'rejected') throw outcome.reason;
    },
  };
}
