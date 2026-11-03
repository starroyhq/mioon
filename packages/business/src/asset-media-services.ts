import {createHash, randomUUID} from 'node:crypto';
import {realpathSync, lstatSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import {assetMediaPublicSchemas, trustedAssetMediaSchemas, isAssetMediaOperation, isTrustedAssetMediaOperation, toAssetMediaDto} from '../../contracts/src/asset-media.ts';
import type {MediaReference} from '../../contracts/src/media-reference.ts';
import {mediaReferenceSchema} from '../../contracts/src/media-reference.ts';
import {projectMediaPath} from '../../contracts/src/project-file.ts';
import {ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic} from '../../contracts/src/private-storage.ts';
import type {OutsidePathConfirmationStore} from './app-db/stores.ts';
import {createProjectAssetReferenceServices} from './project-asset-references.ts';
import {prepareProjectAssetFullHash} from './project-media-storage.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isFileInDirectory, isInsideRealDirectory} from './media-reference/paths.ts';
import {admitMedia, checkMediaStatus, computeFullSha256, relinkMedia, resolveReferencePath} from './media-reference/index.ts';
import {createReferencedAssetImportHandler} from './referenced-asset-import.ts';
import {checkpoint} from './operation-lifecycle.ts';
import {probe} from './media.ts';
import {mediaUnavailableError, mediaUnavailableErrorDetailsSchemas} from '../../contracts/src/media-reference-errors.ts';
import {EXPORT_PREFLIGHT_LIMITS} from '../../contracts/src/export-preflight.ts';

type Row = Record<string, unknown>;
function object(value: unknown): value is Row {return value !== null && typeof value === 'object' && !Array.isArray(value);}
function fail(code = 'REVISION_CONFLICT'): never {throw new AppError(code, '素材引用已改变，请重新读取后操作', 409);}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestLocks = new WeakMap<ProjectStore, Map<string, Promise<unknown>>>();

/** Ordinary operations never grant permission. The separate trusted entry is
 * only called by the authenticated user-action HTTP adapter, never RPC/MCP. */
export function createAssetMediaServices(store: ProjectStore, {outsidePaths, signal}: {outsidePaths: OutsidePathConfirmationStore; signal?: AbortSignal}) {
  const references = createProjectAssetReferenceServices(store, {outsidePaths});
  const locks = requestLocks.get(store) ?? new Map<string, Promise<unknown>>();
  requestLocks.set(store, locks);
  const directory = path.join(store.tempDir, 'asset-media');
  ensurePrivateDirectory(directory, {create: true});
  const fence = (): void => {checkpoint(signal); if (!isProjectStore(store)) throw new AppError('PROJECT_UNAVAILABLE', '项目已关闭', 409);};
  const access = () => ({projectDir: store.projectDir, projectFile: store.projectFile,
    mayReadOutside: (file: string) => outsidePaths.list(store.projectId).some(grant => isFileInDirectory(grant.directory, file)),
    isHeld: (identity: {dev: string; ino: string}) => isProjectFileHeld(identity) || isAppLibraryHeld(identity)});
  function record(assetId: string): Row {
    fence();
    const raw = store.db.prepare("SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM assets WHERE id=?").get(assetId);
    if (!raw || raw.projectId !== store.projectId || typeof raw.data !== 'string') throw new AppError('NOT_FOUND', '找不到素材', 404);
    const asset: unknown = JSON.parse(raw.data);
    if (!object(asset) || asset.id !== raw.id || asset.projectId !== raw.projectId || !mediaReferenceSchema.safeParse(asset.reference).success || !Number.isSafeInteger(asset.referenceRevision)) fail('MEDIA_REFERENCE_INVALID');
    return asset;
  }
  function saveToken(kind: string, data: Row): string {
    const token = randomUUID();
    writePrivateFileAtomic(path.join(directory, `${token}.json`), JSON.stringify({version: 1, kind, projectId: store.projectId, ...data}), {root: directory, maxBytes: 8 * 1024 * 1024});
    return token;
  }
  function token(value: string, kind: string): Row {
    const bytes = readPrivateFile(path.join(directory, `${value}.json`), {root: directory, allowMissing: true, encoding: 'utf8', maxBytes: 8 * 1024 * 1024});
    const data: unknown = bytes === null ? null : JSON.parse(String(bytes));
    if (!object(data) || data.version !== 1 || data.kind !== kind || data.projectId !== store.projectId) fail();
    return data;
  }
  function page(input: Row): {rows: Row[]; nextCursor: string | null} {
    const limit = typeof input.limit === 'number' ? input.limit : 100;
    const ids = Array.isArray(input.assetIds) ? new Set(input.assetIds) : null;
    const raw = store.db.prepare('SELECT id FROM assets WHERE projectId=? AND id>? ORDER BY id LIMIT 20001').all(store.projectId, typeof input.cursor === 'string' ? input.cursor : '');
    if (raw.length > 20_000) fail('MEDIA_REFERENCE_INVALID');
    const selected = raw.filter(row => !ids || ids.has(row.id)).slice(0, limit + 1);
    return {rows: selected.slice(0, limit).map(row => record(String(row.id))), nextCursor: selected.length > limit ? String(selected[limit - 1].id) : null};
  }
  const importer = createReferencedAssetImportHandler(store, {outsidePaths, signal, required: (_table, id) => {
    if (id !== store.projectId) throw new AppError('NOT_FOUND', '找不到项目', 404);
    return store.get('projects', id);
  }, now: () => new Date().toISOString(), guarded: true, effectFence: () => fence, unsafe: () => new AppError('MEDIA_CHANGED_DURING_READ', '素材已变化', 409), safeError: () => false});

  async function perform(op: string, input: Row, allowGrant = true): Promise<unknown> {
    fence(); if (input.projectId !== store.projectId) throw new AppError('NOT_FOUND', '找不到项目', 404);
    if (op === 'asset.media.status.list') {
      const selected = page(input), items = [];
      for (const asset of selected.rows) {items.push(await references.inspect(String(asset.id), {signal, beforeEffect: fence})); fence();}
      return {items, nextCursor: selected.nextCursor};
    }
    if (op === 'asset.media.prepare') {
      const timeout = AbortSignal.timeout(EXPORT_PREFLIGHT_LIMITS.timeoutMs);
      const prepareSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let totalBytes = 0;
      for (const wanted of input.assets as {assetId: string; referenceRevision: number}[]) {
        const old = record(wanted.assetId), reference = mediaReferenceSchema.parse(old.reference);
        if (old.referenceRevision !== wanted.referenceRevision) fail();
        totalBytes += reference.sizeBytes;
        if (reference.sizeBytes > EXPORT_PREFLIGHT_LIMITS.sourceBytes || totalBytes > EXPORT_PREFLIGHT_LIMITS.totalBytes) throw new AppError('PREFLIGHT_BUDGET', '素材完整哈希超出本次检查预算', 409);
      }
      const assets = [];
      try {
        for (const wanted of input.assets as {assetId: string; referenceRevision: number}[]) {
          const old = record(wanted.assetId); if (old.referenceRevision !== wanted.referenceRevision) fail();
          const prepared = await prepareProjectAssetFullHash(store.root, wanted.assetId, {signal: prepareSignal, beforeEffect: fence, maxBytes: EXPORT_PREFLIGHT_LIMITS.sourceBytes}); fence();
          assets.push(toAssetMediaDto(prepared));
        }
      } catch (error) {
        checkpoint(signal);
        if (timeout.aborted) throw new AppError('PREFLIGHT_BUDGET', '素材完整哈希检查已超时', 409);
        throw error;
      }
      return {assets};
    }
    if (op === 'asset.media.location.list') {
      const selected = page(input), assets = [];
      for (const asset of selected.rows) {assets.push(await references.location(String(asset.id), {signal, beforeEffect: fence})); fence();}
      const locations = [];
      for (const location of await references.locations({signal, beforeEffect: fence})) {
        fence(); const normalized = location.available ? realpathSync(location.directory) : location.directory;
        const info = location.available ? lstatSync(normalized) : null;
        const locationToken = saveToken('location', {directory: normalized, volume: location.volume, identity: info ? [String(info.dev), String(info.ino)] : null});
        locations.push({...location, locationToken, confirmed: outsidePaths.list(store.projectId).some(grant => grant.directory === normalized)});
      }
      return {assets, locations, nextCursor: selected.nextCursor};
    }
    if (op === 'asset.media.outside.confirm' || op === 'asset.media.outside.revoke') {
      const location = token(String(input.locationToken), 'location'), name = String(location.directory);
      if (op.endsWith('.confirm')) {
        const actual = lstatSync(realpathSync(name));
        if (!actual.isDirectory() || JSON.stringify([String(actual.dev), String(actual.ino)]) !== JSON.stringify(location.identity)) fail();
        outsidePaths.confirm({projectId: store.projectId, directory: name, confirmedAt: new Date().toISOString()});
      } else outsidePaths.revoke(store.projectId, name);
      return {confirmedDirectories: op.endsWith('.confirm') ? [name] : [], revokedDirectories: op.endsWith('.revoke') ? [name] : []};
    }
    if (op === 'asset.import.path') {
      if (!allowGrant) {const asset=await importer(input);if(!object(asset))fail();return {asset:toAssetMediaDto(asset),confirmedDirectories:[]};}
      let file: string;
      try {file = realpathSync(String(input.sourcePath));}
      catch {
        // Let the importer allocate the stable receipt/asset identity and
        // return its structured missing/permission error, never a raw fs path.
        const asset = await importer(input); if (!object(asset)) fail();
        return {asset: toAssetMediaDto(asset), confirmedDirectories: []};
      }
      const parent = path.dirname(file), confirmedDirectories: string[] = [];
      if (!isInsideRealDirectory(realpathSync(store.projectDir), file)) {
        outsidePaths.confirm({projectId: store.projectId, directory: parent, confirmedAt: new Date().toISOString()});
        confirmedDirectories.push(parent);
      }
      const asset = await importer(input); fence();
      if (!object(asset)) fail('MEDIA_REFERENCE_INVALID');
      return {asset: toAssetMediaDto(asset), confirmedDirectories};
    }
    if (op === 'asset.media.relink.preview') {
      const chosen = record(String(input.assetId)); if (chosen.referenceRevision !== input.expectedReferenceRevision) fail();
      const rows=store.db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM assets WHERE projectId=? ORDER BY id LIMIT 20001").all(store.projectId);
      if(rows.length>20000||rows.some(value=>typeof value.data!=='string')||rows.reduce((total,value)=>total+Buffer.byteLength(String(value.data)),0)>4*1024*1024)throw new AppError('INSPECTION_BUDGET_EXCEEDED','素材引用超出本次检查预算',409);
      const source=rows.map(value=>record(String(value.id))),sequence=store.db.prepare('SELECT contentSequence FROM project_file').get()?.contentSequence;
      const previewFence=():void=>{fence();if(store.db.prepare('SELECT contentSequence FROM project_file').get()?.contentSequence!==sequence)fail();};
      const result = await relinkMedia(access(), source.map(asset => ({id: String(asset.id), reference: mediaReferenceSchema.parse(asset.reference)})), {assetId: String(chosen.id), file: String(input.sourcePath)}, {signal,beforeEffect:previewFence}); previewFence();
      const changes = [result.chosen, ...result.found].map(value => ({assetId: value.assetId, reference: value.reference,
        expectedReferenceRevision: source.find(asset=>asset.id===value.assetId)?.referenceRevision}));
      const previewToken = saveToken('relink', {chosen: chosen.id, matches: result.chosen.matches, changes});
      return {previewToken, chosen: {assetId: chosen.id, matches: result.chosen.matches}, found: result.found.map(value => ({assetId: value.assetId})),
        mismatched: result.mismatched.map(value => ({assetId: value.assetId})), unverified: result.unverified.map(value => ({assetId: value.assetId}))};
    }
    if (op === 'asset.media.relink.apply') {
      const preview = token(String(input.previewToken), 'relink'); if (preview.matches !== true || !Array.isArray(preview.changes)) fail('MEDIA_CHANGED');
      const accepted = store.db.prepare('SELECT requestHash FROM idempotency WHERE scope=? AND requestId=?').get(op, String(input.requestId));
      if (accepted) {
        if (accepted.requestHash !== digest(input)) throw new AppError('IDEMPOTENCY_CONFLICT', '请求 ID 已用于不同内容', 409);
        return {assets: preview.changes.map(value => {if (!object(value)) fail(); return toAssetMediaDto(record(String(value.assetId)));})};
      }
      const changes: {old: Row; reference: MediaReference}[] = [];
      for (const value of preview.changes) {
        if (!object(value)) fail(); const old = record(String(value.assetId));
        if (old.referenceRevision !== value.expectedReferenceRevision) fail();
        const reference = mediaReferenceSchema.parse(value.reference);
        await admitMedia(access(), reference, {signal, beforeEffect: fence}); fence();
        if(reference.fullSha256)await computeFullSha256(access(),reference,{signal,beforeEffect:fence});fence();
        changes.push({old, reference});
      }
      return store.tx(() => {
        const assets = changes.map(({old, reference}) => {
          fence(); if (digest(record(String(old.id))) !== digest(old)) fail();
          return toAssetMediaDto(store.put('assets', {...old, reference, referenceRevision: Number(old.referenceRevision) + 1, sha256: reference.fullSha256, sizeBytes: reference.sizeBytes}));
        });
        store.db.prepare('INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES(?,?,?,?)').run(op, String(input.requestId), digest(input), String(assets[0].id));
        return {assets};
      });
    }
    if (op === 'asset.media.acceptChanged') {
      const accepted = store.db.prepare('SELECT requestHash,resourceId FROM idempotency WHERE scope=? AND requestId=?').get(op, String(input.requestId));
      if (accepted) {
        if (accepted.requestHash !== digest(input)) throw new AppError('IDEMPOTENCY_CONFLICT', '请求 ID 已用于不同内容', 409);
        return {asset: toAssetMediaDto(record(String(accepted.resourceId))), replacesAssetId: input.assetId};
      }
      const old = record(String(input.assetId)); if (old.referenceRevision !== input.expectedReferenceRevision) fail();
      const current = mediaReferenceSchema.parse(old.reference), file = resolveReferencePath(store.projectDir, current); if (!file) fail('MEDIA_MISSING');
      const prepared = await references.referenceForImport(file, {signal, beforeEffect: fence}); fence();
      const metadata=await probe(prepared.file,{signal,beforeEffect:fence});fence();
      const key=digest([store.projectId,op,input.requestId]),id=`${key.slice(0,8)}-${key.slice(8,12)}-5${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20,32)}`;
      const existing=store.get('assets',id);if(object(existing))return {asset:toAssetMediaDto(existing),replacesAssetId:old.id};
      const asset={id,projectId:store.projectId,name:old.name,mimeType:prepared.type.mimeType,width:metadata.width,height:metadata.height,duration:metadata.duration,hasAudio:metadata.hasAudio,hasVideo:metadata.hasVideo,provenance:'user-import',reference:prepared.reference,referenceRevision:1,sha256:prepared.reference.fullSha256,sizeBytes:prepared.reference.sizeBytes,url:projectMediaPath(store.projectId,id),createdAt:new Date().toISOString()};
      return store.tx(() => {
        fence(); if (digest(record(String(old.id))) !== digest(old)) fail();
        const result = toAssetMediaDto(store.put('assets', asset));
        store.db.prepare('INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES(?,?,?,?)').run(op, String(input.requestId), digest(input), id);
        return {asset: result, replacesAssetId: old.id};
      });
    }
    throw new AppError('NOT_FOUND', '找不到素材操作', 404);
  }
  async function execute(op: string, input: Row): Promise<unknown> {
    if (typeof input.requestId !== 'string') return perform(op, input);
    const file = path.join(directory, `request-${digest([op, input.requestId])}.json`), expected = digest(input);
    const existing = readPrivateFile(file, {root: directory, allowMissing: true, encoding: 'utf8', maxBytes: 8 * 1024 * 1024});
    if (existing !== null) {
      const saved: unknown = JSON.parse(String(existing));
      if (!object(saved) || saved.digest !== expected) throw new AppError('IDEMPOTENCY_CONFLICT', '请求 ID 已用于不同内容', 409);
      if (saved.phase === 'completed') return saved.result;
      // A crashed permission mutation must never regrant a directory which
      // the user has since revoked. A new explicit action uses a new key.
      if (op.includes('.outside.')) throw new AppError('REVISION_CONFLICT', '请重新读取位置状态', 409);
    }
    writePrivateFileAtomic(file, JSON.stringify({digest: expected, phase: 'intent'}), {root: directory, maxBytes: 8 * 1024 * 1024});
    const result = await perform(op, input, existing === null); fence();
    writePrivateFileAtomic(file, JSON.stringify({digest: expected, phase: 'completed', result}), {root: directory, maxBytes: 8 * 1024 * 1024});
    return result;
  }
  function invoke(op: string, input: Row): Promise<unknown> {
    if (typeof input.requestId !== 'string') return perform(op, input);
    const key = digest([op, input.requestId]), prior = locks.get(key);
    if (prior) return prior.then(() => execute(op, input));
    const result = execute(op, input); locks.set(key, result);
    void result.finally(() => {if (locks.get(key) === result) locks.delete(key);}).catch(() => {});
    return result;
  }
  return {
    async call(operation: string, input: unknown): Promise<unknown> {
      if (!isAssetMediaOperation(operation)) throw new AppError('NOT_FOUND', '找不到素材操作', 404);
      const parsed = assetMediaPublicSchemas[operation].safeParse(input);
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', '素材操作参数无效');
      try {return await invoke(operation, parsed.data);}
      catch (error) {
        if (!object(error) || !error.terminationUnconfirmed) checkpoint(signal);
        if (error instanceof AppError && Object.hasOwn(mediaUnavailableErrorDetailsSchemas, error.code)) {
          const code = error.code as keyof typeof mediaUnavailableErrorDetailsSchemas;
          const details = object(error.details) ? error.details : {};
          let assetId = typeof details.assetId === 'string' ? details.assetId : 'assetId' in parsed.data ? parsed.data.assetId : undefined;
          if (!assetId && operation === 'asset.media.relink.apply' && 'previewToken' in parsed.data) assetId = String(token(parsed.data.previewToken, 'relink').chosen);
          if (typeof assetId === 'string') {
            const supplied = mediaUnavailableErrorDetailsSchemas[code].safeParse({assetId, reason: details.reason});
            throw mediaUnavailableError(code, assetId, supplied.success ? supplied.data.reason : code === 'MEDIA_MISSING' ? 'not-found' : code === 'MEDIA_OUTSIDE_NOT_CONFIRMED' || code === 'MEDIA_CHANGED_DURING_READ' ? null : 'content');
          }
        }
        throw error;
      }
    },
    async trustedCall(operation: string, input: unknown): Promise<unknown> {
      if (!isTrustedAssetMediaOperation(operation)) throw new AppError('NOT_FOUND', '找不到素材操作', 404);
      const parsed = trustedAssetMediaSchemas[operation].safeParse(input);
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', '素材操作参数无效');
      try {return await invoke(operation, parsed.data);}
      catch (error) {
        if (!object(error) || !error.terminationUnconfirmed) checkpoint(signal);
        if (object(error) && typeof error.code === 'string' && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw new AppError('REVISION_CONFLICT', '文件位置已改变，请重新读取后确认', 409);
        throw error;
      }
    },
  };
}
