import {createHash, randomUUID} from 'node:crypto';
import {realpathSync, lstatSync} from 'node:fs';
import {open, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import {assetImportSchema, assetMediaRecordSchema, PROJECT_ASSETS_FOLDER, toAssetMediaDto} from '../../contracts/src/asset-media.ts';
import {projectMediaPath} from '../../contracts/src/project-file.ts';
import {ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic} from '../../contracts/src/private-storage.ts';
import {createProjectAssetReferenceServices} from './project-asset-references.ts';
import type {OutsidePathConfirmationStore} from './app-db/stores.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {probe} from './media.ts';
import {decodeMediaUpload} from './media-upload.ts';
import {checkMediaStatus, computeFullSha256} from './media-reference/index.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isFileInDirectory, isInsideRealDirectory, resolveReferencePath} from './media-reference/paths.ts';
import {taskEffectOrigin} from './agent/task-effects-v2.ts';
import {mioTable} from './agent/mio-table-layout.ts';
import {checkpoint} from './operation-lifecycle.ts';
import type {ManagedAssetImportOptions} from './managed-asset-import.ts';

type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const extensions: Readonly<Record<string, string>> = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a'};
function conflict(): never {throw new AppError('IDEMPOTENCY_CONFLICT', '同一请求 ID 已用于不同内容', 409);}

/** Project imports have one location: a reference. Upload publications are
 * exclusive and are never removed on failure; only registered assets are served.
 * The private receipt binds a request before any project-file effect. */
export function createReferencedAssetImportHandler(store: ProjectStore, options: ManagedAssetImportOptions & {outsidePaths: OutsidePathConfirmationStore}) {
  const references = createProjectAssetReferenceServices(store, options);
  const receipts = path.join(store.tempDir, 'asset-imports');
  ensurePrivateDirectory(receipts, {create: true});
  const running = new Map<string, Promise<unknown>>();
  return (raw: Row, context: {signal?: AbortSignal} = {}): Promise<unknown> => {
    const input = assetImportSchema.parse(raw);
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const importOrigin = taskEffectOrigin();
    const replayKey = input.requestId ?? (importOrigin?.importHandle ? `selected:${importOrigin.importHandle}` : undefined);
    const key = replayKey ? createHash('sha256').update(replayKey).digest('hex') : randomUUID();
    let activeAssetId: string | undefined;
    let effectFailure: unknown;
    const normalize = (error: unknown): never => {
      if (error === effectFailure && effectFailure !== undefined) throw error;
      if (error instanceof AppError) {
        if (activeAssetId && ['MEDIA_MISSING', 'MEDIA_CHANGED', 'MEDIA_NOT_MEDIA', 'MEDIA_OUTSIDE_NOT_CONFIRMED', 'MEDIA_CHANGED_DURING_READ'].includes(error.code)) {
          const details = object(error.details) ? error.details : {};
          const reason = error.code === 'MEDIA_OUTSIDE_NOT_CONFIRMED' || error.code === 'MEDIA_CHANGED_DURING_READ' ? null :
            typeof details.reason === 'string' ? details.reason : error.code === 'MEDIA_MISSING' ? 'not-found' : 'content';
          throw new AppError(error.code, error.message, error.status, {assetId: activeAssetId, reason});
        }
        throw error;
      }
      if (options.safeError(error) || object(error) && (error.terminationUnconfirmed || typeof error.code === 'string' && error.code.startsWith('AGENT_TASK_'))) throw error;
      checkpoint(context.signal ?? options.signal);
      throw new AppError('INVALID_MEDIA', '无法读取或解码素材，请检查文件');
    };
    const execute = async (): Promise<unknown> => {
      const signal = context.signal ?? options.signal, origin = importOrigin, invocationFence = options.effectFence();
      const fence = (): void => {
        checkpoint(signal);
        try {invocationFence?.(); origin?.beforeEffect();}
        catch (error) {effectFailure = error; throw error;}
        if (!isProjectStore(store) || store.projectId !== input.projectId) throw new AppError('NOT_FOUND', '找不到项目', 404);
        options.required('projects', input.projectId);
      };
      fence();
      const receiptFile = path.join(receipts, `${key}.json`);
      const saved = readPrivateFile(receiptFile, {root: receipts, allowMissing: true, maxBytes: 32 * 1024, encoding: 'utf8'});
      let receipt: Row;
      if (saved !== null) {
        const value: unknown = JSON.parse(String(saved));
        if (!object(value)) conflict();
        if (value.version !== 1 || value.projectId !== store.projectId || typeof value.assetId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.assetId) || !Number.isSafeInteger(value.attempt) || Number(value.attempt)<0 || Number(value.attempt)>16 || value.digest !== digest) conflict();
        receipt = value;
      } else {
        receipt = {version: 1, projectId: store.projectId, assetId: randomUUID(), digest, attempt: 0, phase: 'intent'};
        writePrivateFileAtomic(receiptFile, JSON.stringify(receipt), {root: receipts, maxBytes: 32 * 1024});
      }
      const assetId = String(receipt.assetId);
      activeAssetId = assetId;
      const existing: unknown = store.get('assets', assetId);
      if (existing) {
        if (!object(existing) || existing.projectId !== store.projectId) conflict();
        return existing;
      }
      let asset: Row;
      if (object(receipt.asset)) {
        asset = receipt.asset;
        const reference = assetMediaRecordSchema.parse(Object.fromEntries(Object.entries(asset).filter(([key]) => key !== 'url'))).reference;
        const local = resolveReferencePath(store.projectDir, reference);
        if (!local) throw new AppError('MEDIA_MISSING', '素材文件不可用', 404, {assetId, reason: 'other-platform'});
        const permission = (): void => {
          fence();
          if (!isInsideRealDirectory(realpathSync(store.projectDir), realpathSync(local)) &&
              !options.outsidePaths.list(store.projectId).some(value => isFileInDirectory(value.directory, realpathSync(local)))) throw new AppError('MEDIA_OUTSIDE_NOT_CONFIRMED', '素材目录尚未确认', 403, {assetId, reason: null});
        };
        const access = {projectDir: store.projectDir, projectFile: store.projectFile,
          mayReadOutside: (candidate: string) => options.outsidePaths.list(store.projectId).some(value => isFileInDirectory(value.directory, candidate)),
          isHeld: (identity: {dev: string; ino: string}) => isProjectFileHeld(identity) || isAppLibraryHeld(identity)};
        const state = await checkMediaStatus(access, reference, {signal, beforeEffect: permission}); permission();
        if (state.status !== 'online' || !state.readable) throw new AppError('MEDIA_CHANGED', '素材与已接受的导入不一致', 409, {assetId, reason: 'content'});
        if (reference.fullSha256) await computeFullSha256(access, reference, {signal, beforeEffect: permission});
      } else {
        let file: string;
        let declared: string | undefined;
        if ('sourcePath' in input) file = input.sourcePath;
        else {
          declared = input.mimeType;
          const bytes = decodeMediaUpload(input.dataBase64, declared);
          if(Number(receipt.attempt)>=16)throw new AppError('INVALID_MEDIA','导入重试已达上限，请检查项目目录后重新发起');
          const stage = path.join(receipts, `${assetId}.${extensions[declared]}`);
          writePrivateFileAtomic(stage, bytes, {root: receipts, maxBytes: 30 * 1024 * 1024});
          const decoded=await probe(stage,{signal,beforeEffect:fence});fence();
          if(declared.startsWith('audio/')?(!decoded.hasAudio||decoded.hasVideo||!(decoded.duration>0)):!decoded.hasVideo)throw new AppError('INVALID_MEDIA','无法解码素材或媒体类型不符');
          const directory = path.join(realpathSync(store.projectDir), PROJECT_ASSETS_FOLDER);
          await mkdir(directory, {recursive: true}); fence();
          const directoryInfo = lstatSync(directory);
          if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || realpathSync(directory) !== directory) throw new AppError('INVALID_MEDIA', '素材目录不可用');
          // Bind each attempt before exclusive creation. A partial target is
          // retained and the next attempt uses another name, never overwrites it.
          receipt.attempt = Number(receipt.attempt) + 1;
          file = path.join(directory, `${assetId}-${receipt.attempt}.${extensions[declared]}`);
          receipt.phase = 'unpublished'; receipt.file = file;
          writePrivateFileAtomic(receiptFile, JSON.stringify(receipt), {root: receipts, maxBytes: 32 * 1024});
          const target = await open(file, 'wx');
          try {fence(); await target.writeFile(bytes); fence(); await target.sync(); fence();}
          finally {await target.close();}
        }
        const prepared = await references.referenceForImport(file, {signal, beforeEffect: fence}); fence();
        if (declared && declared !== prepared.type.mimeType) throw new AppError('INVALID_MEDIA', '文件类型与实际内容不符');
        const initial = lstatSync(prepared.file, {bigint: true});
        const sourceFence = (): void => {
          fence();
          const actual = lstatSync(prepared.file, {bigint: true}), identity = {dev: String(actual.dev), ino: String(actual.ino)};
          if (!actual.isFile() || isProjectFileHeld(identity) || isAppLibraryHeld(identity) ||
              realpathSync(prepared.file) !== prepared.file || actual.dev !== initial.dev || actual.ino !== initial.ino || actual.size !== initial.size || actual.mtimeNs !== initial.mtimeNs || actual.ctimeNs !== initial.ctimeNs) throw new AppError('MEDIA_CHANGED_DURING_READ', '读取期间素材已变化', 409, {assetId, reason: null});
          const project = realpathSync(store.projectDir);
          if (!isInsideRealDirectory(project, prepared.file) && !options.outsidePaths.list(store.projectId).some(value => isFileInDirectory(value.directory, prepared.file))) throw new AppError('MEDIA_OUTSIDE_NOT_CONFIRMED', '素材目录尚未确认', 403, {assetId, reason: null});
        };
        sourceFence();
        const access = {projectDir: store.projectDir, projectFile: store.projectFile,
          mayReadOutside: (candidate: string) => options.outsidePaths.list(store.projectId).some(value => isFileInDirectory(value.directory, candidate)),
          isHeld: (identity: {dev: string; ino: string}) => isProjectFileHeld(identity) || isAppLibraryHeld(identity)};
        const metadata = await probe(prepared.file, {signal, beforeEffect: sourceFence}); sourceFence();
        const status = await checkMediaStatus(access, prepared.reference, {signal, beforeEffect: sourceFence}); sourceFence();
        if (status.status !== 'online' || !status.readable) throw new AppError('MEDIA_CHANGED_DURING_READ', '读取期间素材已变化', 409, {assetId, reason: null});
        if (prepared.reference.fullSha256) await computeFullSha256(access, prepared.reference, {signal, beforeEffect: sourceFence});
        fence();
        if (prepared.type.kind === 'audio' ? (!metadata.hasAudio || metadata.hasVideo || !(metadata.duration > 0)) : !metadata.hasVideo) throw new AppError('INVALID_MEDIA', '无法解码素材或媒体类型不符');
        asset = {id: assetId, projectId: store.projectId, name: input.name ?? path.basename(file).slice(0,200).replace(/[\uD800-\uDBFF]$/u,''), mimeType: prepared.type.mimeType,
          reference: prepared.reference, referenceRevision: 1, sizeBytes: prepared.reference.sizeBytes, sha256: prepared.reference.fullSha256,
          width: metadata.width, height: metadata.height, duration: metadata.duration, hasVideo: metadata.hasVideo, hasAudio: metadata.hasAudio,
          url: projectMediaPath(store.projectId, assetId), provenance: 'user-import', createdAt: options.now()};
        receipt.asset = asset; receipt.phase = 'prepared';
        writePrivateFileAtomic(receiptFile, JSON.stringify(receipt), {root: receipts, maxBytes: 32 * 1024});
      }
      const {url: _url, ...record} = asset;
      assetMediaRecordSchema.parse(record);
      if (asset.id !== assetId || asset.projectId !== store.projectId) conflict();
      fence();
      const result = store.tx(() => {
        fence(); const value = store.put('assets', asset);
        if (origin?.importHandle) {
          const changed = store.db.prepare(`UPDATE ${mioTable(store.db, 'imports')} SET status='imported',assetId=? WHERE id=? AND projectId=? AND status='importing'`).run(assetId, origin.importHandle, store.projectId);
          if (changed.changes !== 1) throw new AppError('AGENT_TASK_UNKNOWN_RESULT', '导入受理记录已改变', 409);
        }
        // The Mio transaction observer records this result before the outer
        // RPC projection. Give it the same path-free asset DTO, not a reference
        // whose path its older narrow projector would merely remove.
        return origin?.importHandle ? toAssetMediaDto(value) : value;
      });
      receipt.phase = 'registered';
      writePrivateFileAtomic(receiptFile, JSON.stringify(receipt), {root: receipts, maxBytes: 32 * 1024});
      return result;
    };
    const pending = running.get(key);
    if (pending) return pending.then(() => execute()).catch(normalize);
    const operation = execute().catch(normalize); running.set(key, operation);
    void operation.finally(() => {if (running.get(key) === operation) running.delete(key);}).catch(() => {});
    return operation;
  };
}
