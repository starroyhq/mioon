import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {AppError} from '../../contracts/src/app-error.ts';
import {assetMediaRecordSchema, PROJECT_ASSETS_FOLDER} from '../../contracts/src/asset-media.ts';
import {projectMediaPath} from '../../contracts/src/project-file.ts';
import {validateManagedFile, validatePrivateDirectory} from '../../contracts/src/private-storage.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {mediaMtimeMs} from './media-reference/fingerprint.ts';
import {resolveReferencePath} from './media-reference/paths.ts';
import {checkpoint} from './operation-lifecycle.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';

export const PROJECT_UNPUBLISHED_MEDIA_LIMITS = Object.freeze({
  receipts: 256, receiptBytes: 32 * 1024, totalReceiptBytes: 1024 * 1024, directoryEntries: 4096,
});
export interface ProjectUnpublishedMediaSnapshot {
  readonly version: string;
  assertCurrent(): void;
  isExcluded(file: string, stats: BigIntStats): boolean;
}
export interface ProjectUnpublishedMediaOptions {
  readonly signal?: AbortSignal;
  readonly beforeEffect: () => void;
}

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const uuidPattern = new RegExp(`^${uuid}$`, 'u');
const receiptName = new RegExp(`^(?:[a-f0-9]{64}|${uuid})\\.json$`, 'u');
const stageName = new RegExp(`^${uuid}\\.(?:png|jpg|webp|mp4|webm|wav|mp3|m4a)$`, 'u');
const extensionForMime: Readonly<Record<string, string>> = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a'};
function invalid(): never {throw new AppError('MEDIA_LIST_PATH_INVALID', '无法安全读取项目素材列表', 400);}
function changed(): never {throw new AppError('MEDIA_CHANGED_DURING_READ', '读取期间项目素材已变化', 409);}
function io<T>(read: () => T): T {try {return read();} catch {return invalid();}}
function stat(file: string): BigIntStats | null {
  return io(() => lstatSync(file, {bigint: true, throwIfNoEntry: false}) ?? null);
}
function version(info: BigIntStats | null): string | null {
  return info && [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.uid, info.gid, info.mode, info.nlink].join(':');
}
function unheld(info: BigIntStats): void {
  const identity = {dev: String(info.dev), ino: String(info.ino)};
  // Closing an fs descriptor for an SQLite inode would release this process's
  // POSIX locks. This check must precede every receipt open, not just its read.
  if (isProjectFileHeld(identity) || isAppLibraryHeld(identity)) invalid();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

/** A bounded, read-only view of S1's local publication receipts. Version 1 did
 * not persist inode identities, and overwrote its latest attempt pathname.
 * Consequently it cannot prove an exclusion: any surviving unregistered or
 * historical attempt blocks the whole listing rather than hiding by name.
 * No recovery, removal, import retry or receipt-format change occurs here. */
export async function readProjectUnpublishedMediaSnapshot(store: ProjectStore,
  options: ProjectUnpublishedMediaOptions): Promise<ProjectUnpublishedMediaSnapshot> {
  if (!isProjectStore(store)) invalid();
  const fence = (): void => {
    checkpoint(options.signal); options.beforeEffect(); checkpoint(options.signal);
    if (!isProjectStore(store)) changed();
  };
  fence();
  const projectId = store.projectId;
  const projectStatement = store.db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM projects WHERE id=?");
  const project = projectStatement.get(projectId);
  let owner: unknown;
  try {owner = typeof project?.data === 'string' ? JSON.parse(project.data) as unknown : undefined;} catch {invalid();}
  if (!project || project.id !== projectId || !object(owner) || owner.id !== projectId || typeof project.data !== 'string') invalid();
  const projectRaw = project.data;
  const watched = new Map<string, string | null>(), assetRows = new Map<string, string | null>();
  const watch = (file: string): BigIntStats | null => {
    const info = stat(file), current = version(info);
    if (watched.has(file) && watched.get(file) !== current) changed();
    watched.set(file, current); return info;
  };
  const projectDir = io(() => realpathSync(store.projectDir));
  const projectInfo = watch(projectDir);
  if (!projectInfo?.isDirectory() || projectInfo.isSymbolicLink()) invalid();
  const receipts = path.join(store.tempDir, 'asset-imports');
  io(() => validatePrivateDirectory(store.tempDir));
  watch(store.tempDir);
  const receiptDirectory = io(() => validatePrivateDirectory(receipts, {allowMissing: true}));
  if (Boolean(watch(receipts)) !== Boolean(receiptDirectory)) changed();
  const assetsDirectory = path.join(projectDir, PROJECT_ASSETS_FOLDER);
  const assetDirectory = watch(assetsDirectory);
  if (assetDirectory && (!assetDirectory.isDirectory() || assetDirectory.isSymbolicLink() || io(() => realpathSync(assetsDirectory)) !== assetsDirectory)) invalid();
  const assetStatement = store.db.prepare("SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 32768 THEN data END AS data FROM assets WHERE id=?");
  const currentAsset = (id: string): unknown => {
    const row = assetStatement.get(id);
    const raw = typeof row?.data === 'string' ? row.data : null;
    assetRows.set(id, raw);
    if (!row) return null;
    if (row.id !== id || row.projectId !== projectId || raw === null) invalid();
    try {return JSON.parse(raw) as unknown;} catch {return invalid();}
  };
  const assetRecord = (value: unknown, id: string) => {
    if (!object(value) || value.id !== id || value.projectId !== projectId ||
      Object.hasOwn(value, 'url') && value.url !== projectMediaPath(projectId, id)) invalid();
    const parsed = assetMediaRecordSchema.safeParse(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'url')));
    if (!parsed.success) invalid();
    return parsed.data;
  };
  const assertCurrent = (): void => {
    fence();
    io(() => validatePrivateDirectory(store.tempDir));
    io(() => validatePrivateDirectory(receipts, {allowMissing: true}));
    if (io(() => realpathSync(store.projectDir)) !== projectDir || projectStatement.get(projectId)?.data !== projectRaw) changed();
    for (const [file, expected] of watched) if (version(stat(file)) !== expected) changed();
    for (const [id, expected] of assetRows) {
      const row = assetStatement.get(id);
      if ((typeof row?.data === 'string' ? row.data : null) !== expected ||
        row && (row.id !== id || row.projectId !== projectId || typeof row.data !== 'string')) changed();
    }
    checkpoint(options.signal);
    if (!isProjectStore(store)) changed();
  };
  const receiptHashes: string[] = [];
  let count = 0, totalBytes = 0;
  // Yield before enumeration and between receipts so cancellation and host
  // revocation cannot be starved by the bounded synchronous file reads.
  await yieldIO(); assertCurrent();
  if (receiptDirectory) {
    const directory = io(() => opendirSync(receipts));
    const names: string[] = [];
    try {
      for (;;) {
        fence();
        const entry = io(() => directory.readSync());
        if (!entry) break;
        if (names.length >= PROJECT_UNPUBLISHED_MEDIA_LIMITS.directoryEntries) invalid();
        if (!receiptName.test(entry.name) && !stageName.test(entry.name)) invalid();
        names.push(entry.name);
      }
    } finally {io(() => directory.closeSync());}
    assertCurrent();
    for (const name of names.sort()) {
      fence();
      const file = path.join(receipts, name), before = watch(file);
      if (!before?.isFile() || before.isSymbolicLink()) invalid();
      unheld(before);
      io(() => validateManagedFile(file, {root: receipts, private: true,
        ...(receiptName.test(name) ? {maxBytes: PROJECT_UNPUBLISHED_MEDIA_LIMITS.receiptBytes} : {})}));
      if (!receiptName.test(name)) continue; // Private staging media is never opened.
      if (++count > PROJECT_UNPUBLISHED_MEDIA_LIMITS.receipts || before.size > BigInt(PROJECT_UNPUBLISHED_MEDIA_LIMITS.receiptBytes)) invalid();
      totalBytes += Number(before.size);
      if (totalBytes > PROJECT_UNPUBLISHED_MEDIA_LIMITS.totalReceiptBytes) invalid();
      // Recheck after all admission work, immediately before openSync.
      const admitted = stat(file);
      if (!admitted || version(admitted) !== version(before)) changed();
      unheld(admitted);
      const fd = io(() => openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0)));
      let raw: Buffer;
      try {
        const opened = io(() => fstatSync(fd, {bigint: true}));
        if (!opened.isFile() || version(opened) !== version(before)) changed();
        const read = (): Buffer => {
          const buffer = Buffer.alloc(Number(before.size) + 1); let size = 0;
          for (;;) {
            checkpoint(options.signal);
            const n = io(() => readSync(fd, buffer, size, buffer.length - size, size));
            if (!n) break;
            size += n;
            if (size > Number(before.size)) changed();
          }
          if (size !== Number(before.size)) changed();
          return buffer.subarray(0, size);
        };
        raw = read();
        if (!raw.equals(read()) || version(io(() => fstatSync(fd, {bigint: true}))) !== version(before) || version(stat(file)) !== version(before)) changed();
      } finally {io(() => closeSync(fd));}
      let value: unknown;
      try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)) as unknown;} catch {invalid();}
      if (!object(value) || Object.keys(value).some(key => !['version', 'projectId', 'assetId', 'digest', 'attempt', 'phase', 'file', 'asset'].includes(key)) ||
        value.version !== 1 || value.projectId !== projectId || typeof value.assetId !== 'string' || !uuidPattern.test(value.assetId) ||
        typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest) || !Number.isSafeInteger(value.attempt) ||
        Number(value.attempt) < 0 || Number(value.attempt) > 16 || typeof value.phase !== 'string' ||
        !['intent', 'unpublished', 'prepared', 'registered'].includes(value.phase)) invalid();
      const id = value.assetId, attempt = Number(value.attempt);
      if (value.phase === 'intent') {
        if (attempt !== 0 || Object.hasOwn(value, 'file') || Object.hasOwn(value, 'asset')) invalid();
      } else {
        if (value.phase === 'unpublished' ? attempt === 0 || Object.hasOwn(value, 'asset') : !Object.hasOwn(value, 'asset')) invalid();
        const record = value.phase === 'unpublished' ? null : assetRecord(value.asset, id);
        // A terminal receipt records an already completed publication, not a
        // promise that its asset row or file can never be edited/relinked (or
        // removed by a later undo). Prepared uploads still need current DB proof.
        const registered = value.phase === 'registered' ? null : currentAsset(id);
        const published = value.phase === 'registered' ||
          record !== null && registered !== null && canonical(record) === canonical(assetRecord(registered, id));
        // A path-only preparation has no owned project-file publication. Its
        // transaction may roll back while this immutable S1 evidence remains;
        // treating the ordinary referenced source as a partial would then block
        // every later list/import. Upload attempts and S2 publication evidence
        // keep their existing completion requirements.
        const referenceOnly = attempt === 0 && !Object.hasOwn(value, 'file') && record !== null && record.publication === undefined;
        if (value.phase !== 'unpublished' && !published && !referenceOnly) invalid();
        if (attempt === 0) {
          if (Object.hasOwn(value, 'file')) invalid();
        } else {
          if (typeof value.file !== 'string') invalid();
          const match = new RegExp(`^${id}-${attempt}\\.(png|jpg|webp|mp4|webm|wav|mp3|m4a)$`, 'u').exec(path.basename(value.file));
          if (!match) invalid();
          const extension = match[1]!;
          const target = path.join(assetsDirectory, `${id}-${attempt}.${extension}`);
          if (value.file !== target || record && (extensionForMime[record.mimeType] !== extension || resolveReferencePath(projectDir, record.reference) !== target)) invalid();
          // v1 retained no identity for any prior attempt. A same-name user
          // replacement is equally unprovable: never treat it as an exclusion.
          for (let index = 1; index <= attempt; index++) {
            // The completed target is an ordinary candidate now. L1 owns its
            // current header, identity, held-file and private-directory checks.
            if (index === attempt && value.phase === 'registered') continue;
            const candidate = path.join(assetsDirectory, `${id}-${index}.${extension}`), info = watch(candidate);
            if (!info) continue;
            if (!published || index !== attempt || !record || !info.isFile() || info.isSymbolicLink()) invalid();
            unheld(info);
            if (info.size !== BigInt(record.sizeBytes) || mediaMtimeMs(info) !== record.reference.mtimeMs) invalid();
          }
        }
      }
      receiptHashes.push(createHash('sha256').update(raw).digest('hex'));
      await yieldIO(); assertCurrent();
    }
  }
  assertCurrent();
  const scopeVersion = createHash('sha256').update(JSON.stringify({projectId, projectRaw,
    files: [...watched], assetRows: [...assetRows], receipts: receiptHashes})).digest('hex');
  return Object.freeze({version: scopeVersion, assertCurrent,
    isExcluded(_file: string, _stats: BigIntStats): boolean {assertCurrent(); return false;}});
}
