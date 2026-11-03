import {closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {PrivateStorageError} from '@mioon/contracts/private-storage';
import type {ReadPrivateFileOptions, WritePrivateFileOptions, RemovePrivateFileOptions} from '@mioon/contracts/private-storage';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isProjectStore, commitProjectAssetHash} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {mediaReferenceSchema} from '../../contracts/src/media-reference.ts';
import type {MediaReference} from '../../contracts/src/media-reference.ts';
import {mediaUnavailableError} from '../../contracts/src/media-reference-errors.ts';
import type {OutsidePathConfirmationStore} from './app-db/stores.ts';
import {createProjectAssetReferenceServices} from './project-asset-references.ts';
import type {ProjectAssetReferenceServices} from './project-asset-references.ts';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {MediaUnavailableReason} from '../../contracts/src/media-reference-errors.ts';
import {computeFullSha256, isFileInDirectory, isInsideRealDirectory, isNotDownloaded, isProtectedName, mediaMtimeMs, mediaTypeOfName, referenceForFile, resolveReferencePath} from './media-reference/index.ts';
import type {MediaAccess} from './media-reference/index.ts';

export interface ProjectMediaRegistrationOptions {readonly outsidePaths?: Pick<OutsidePathConfirmationStore, 'list'>}
interface ProjectMediaRegistration {readonly owner: WeakRef<ProjectStore>; count: number; outsidePaths: Pick<OutsidePathConfirmationStore, 'list'>; references: ProjectAssetReferenceServices}
const noOutsidePaths: Pick<OutsidePathConfirmationStore, 'list'> = {list: () => []};
const admissions = new WeakMap<ProjectStore, Map<string, {raw: string; file: string; info: Stats}>>();
const sameStats = (a: Stats, b: Stats): boolean => (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).every(key => a[key] === b[key]);

const projects = new Map<string, ProjectMediaRegistration>();
/** A root string only selects an already proven, still-live kernel owner. */
export function registerProjectMediaStore(store: unknown, {outsidePaths = noOutsidePaths}: ProjectMediaRegistrationOptions = {}): () => void {
  if (!isProjectStore(store)) return () => {};
  const root = store.projectDir, prior = projects.get(root);
  const registration = prior?.owner.deref() === store ? prior : {owner: new WeakRef(store), count: 0, outsidePaths, references: createProjectAssetReferenceServices(store, {outsidePaths})};
  if (outsidePaths !== noOutsidePaths && registration.outsidePaths !== outsidePaths) {registration.outsidePaths = outsidePaths; registration.references = createProjectAssetReferenceServices(store, {outsidePaths});}
  registration.count++; projects.set(root, registration);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--registration.count === 0 && projects.get(root) === registration) projects.delete(root);
  };
}
/** Exact, live owners only. This registry is an in-process capability, never
 * a way to turn an arbitrary path or copied store into media authority. */
export function registeredProjectStore(root: string): ProjectStore | undefined {
  const store = projects.get(root)?.owner.deref();
  return store && isProjectStore(store) && store.projectDir === root ? store : undefined;
}
export function registeredProjectStoreForDatabase(db: DatabaseSync): ProjectStore | undefined {
  for (const registration of projects.values()) {const store = registration.owner.deref(); if (store && store.db === db && isProjectStore(store)) return store;}
  return undefined;
}
export function registeredProjectAssetReferences(root: string): ProjectAssetReferenceServices | undefined {
  return registeredProjectStore(root) ? projects.get(root)?.references : undefined;
}
export interface ProjectReferencedAsset {readonly id?: unknown; readonly assetId?: unknown; readonly projectId?: unknown; readonly reference?: unknown; readonly referenceRevision?: unknown; readonly sha256?: unknown}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Synchronous decoder fence: metadata only, before any pathname-only codec
 * open. A changed mtime is conservatively refused until async prepare checks
 * the samples; this function never hashes while a SQLite transaction is held. */
export function validatedProjectAssetSource(root: string, asset: ProjectReferencedAsset, {maxBytes = Infinity}: {maxBytes?: number} = {}): {file: string; info: Stats} {
  const store = registeredProjectStore(root), registration = projects.get(root);
  if (!store || !registration) throw new TypeError('Asset reads require the exact live project owner');
  const assetId = typeof asset.id === 'string' ? asset.id : typeof asset.assetId === 'string' ? asset.assetId : '';
  function unavailable(code: 'MEDIA_MISSING' | 'MEDIA_CHANGED' | 'MEDIA_NOT_MEDIA' | 'MEDIA_OUTSIDE_NOT_CONFIRMED', reason: MediaUnavailableReason): never {throw mediaUnavailableError(code, assetId, reason);}
  if (!/^[a-f0-9-]{36}$/u.test(assetId)) unavailable('MEDIA_MISSING', 'not-found');
  const current = store.get('assets', assetId);
  if (!object(current) || current.projectId !== store.projectId || asset.projectId !== undefined && asset.projectId !== store.projectId) unavailable('MEDIA_MISSING', 'not-found');
  const reference = mediaReferenceSchema.safeParse(asset.reference), persisted = mediaReferenceSchema.safeParse(current.reference);
  if (!reference.success || !persisted.success || !Number.isSafeInteger(asset.referenceRevision) || asset.referenceRevision !== current.referenceRevision || JSON.stringify(reference.data) !== JSON.stringify(persisted.data) || asset.sha256 !== current.sha256) unavailable('MEDIA_CHANGED', 'content');
  const requested = resolveReferencePath(store.projectDir, reference.data);
  if (!requested) unavailable('MEDIA_MISSING', 'other-platform');
  let real: string, directory: string, stats: Stats;
  try {real = realpathSync(requested); directory = realpathSync(store.projectDir); stats = lstatSync(real);} catch {unavailable('MEDIA_MISSING', 'not-found');}
  const identity = lstatSync(real!, {bigint: true}), type = mediaTypeOfName(real!);
  if (!stats!.isFile()) unavailable('MEDIA_MISSING', 'not-a-file');
  if (isProtectedName(path.basename(requested)) || isProtectedName(path.basename(real!)) || !type || !mediaTypeOfName(requested) ||
    isInsideRealDirectory(directory!, real!) && path.relative(directory!, real!).split(path.sep).some(part => part.startsWith('.')) ||
    isProjectFileHeld({dev: String(identity.dev), ino: String(identity.ino)}) || isAppLibraryHeld({dev: String(identity.dev), ino: String(identity.ino)})) unavailable('MEDIA_NOT_MEDIA', 'protected');
  if(type!.mimeType!==current.mimeType||mediaTypeOfName(requested)?.mimeType!==type!.mimeType)unavailable('MEDIA_NOT_MEDIA','extension');
  if (isNotDownloaded(identity)) unavailable('MEDIA_MISSING', 'not-downloaded');
  if (!isInsideRealDirectory(directory!, real!) && !registration.outsidePaths.list(store.projectId).some(value => value.projectId === store.projectId && isFileInDirectory(value.directory, real!))) unavailable('MEDIA_OUTSIDE_NOT_CONFIRMED', null);
  if (Number(identity.size) !== reference.data.sizeBytes) unavailable('MEDIA_CHANGED', 'size');
  if (mediaMtimeMs(identity) !== reference.data.mtimeMs) {
    const admitted = admissions.get(store)?.get(assetId);
    if (!admitted || admitted.raw !== JSON.stringify(current) || admitted.file !== real! || !sameStats(admitted.info, stats!)) unavailable('MEDIA_CHANGED', 'content');
  }
  if (stats!.size > maxBytes) throw Object.assign(new Error('The source exceeds its read budget'), {code: 'MANAGED_SOURCE_LIMIT'});
  return {file: real!, info: stats!};
}
/** Small immutable image proofs retain the original bounded synchronous
 * recheck at their transaction fence. Metadata/held/permission checks precede
 * every descriptor open and every chunk; no arbitrary file path is accepted. */
export function readProjectReferencedAssetBytes(store: ProjectStore, asset: ProjectReferencedAsset, {maxBytes}: {maxBytes: number}): Buffer {
  if (registeredProjectStore(store.projectDir) !== store || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new TypeError('A bounded exact project image source is required');
  const source = validatedProjectAssetSource(store.projectDir, asset, {maxBytes}), id = typeof asset.id === 'string' ? asset.id : String(asset.assetId);
  const fence = (): void => {const current = validatedProjectAssetSource(store.projectDir, asset, {maxBytes}); if (current.file !== source.file || !sameStats(current.info, source.info)) throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ', id);};
  fence();const fd = openSync(source.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd); fence();
    if (!sameStats(info, source.info)) throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ', id);
    const bytes = Buffer.alloc(info.size); let offset = 0;
    while (offset < bytes.length) {fence(); const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset); fence(); if (count < 1) throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ', id); offset += count;}
    fence();if (!sameStats(fstatSync(fd), info) || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw mediaUnavailableError('MEDIA_CHANGED', id, 'content');
    return bytes;
  } finally {closeSync(fd);}
}

/** Async L1 admission lets an unchanged sampled file with a new mtime be
 * read without silently rewriting the asset. Its exact stat/row proof is local
 * to this live owner and is invalidated by any later metadata or row change. */
export async function admitProjectAssetSource(root: string, assetId: string, options: {signal?: AbortSignal; beforeEffect?: () => void} = {}): Promise<{file: string; info: Stats; reference: MediaReference}> {
  const store = registeredProjectStore(root), references = registeredProjectAssetReferences(root);
  if (!store || !references) throw new TypeError('Media admission requires the exact live owner');
  const admitted = await references.resolve(assetId, options);
  options.signal?.throwIfAborted(); options.beforeEffect?.();
  const current = store.get('assets', assetId), info = lstatSync(admitted.file), big = lstatSync(admitted.file, {bigint: true});
  if (!object(current) || current.referenceRevision !== admitted.referenceRevision || Number(big.size) !== admitted.reference.sizeBytes || mediaMtimeMs(big) !== admitted.reference.mtimeMs) throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ', assetId);
  let proofs = admissions.get(store); if (!proofs) {proofs = new Map(); admissions.set(store, proofs);}
  proofs.set(assetId, {raw: JSON.stringify(current), file: admitted.file, info});
  return {...validatedProjectAssetSource(root, current), reference: admitted.reference};
}

/** Prepare outside SQLite, then CAS the exact stored locator. Completing a
 * lazy full hash does not change referenceRevision or a cache fingerprint. */
export async function prepareProjectAssetFullHash(root: string, assetId: string,
  options: {signal?: AbortSignal; beforeEffect?: () => void; maxBytes?: number; onBytes?: (bytes: number) => void} = {}): Promise<Record<string, unknown>> {
  const store = registeredProjectStore(root), references = registeredProjectAssetReferences(root);
  if (!store || !references) throw new TypeError('Hash preparation requires the exact live project owner');
  if (store.db.isTransaction) throw new TypeError('Hash preparation must run outside SQLite transactions');
  const row = store.db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM assets WHERE id=? AND projectId=?").get(assetId, store.projectId);
  if (!row) throw mediaUnavailableError('MEDIA_MISSING', assetId, 'not-found');
  if (typeof row.data !== 'string') throw mediaUnavailableError('MEDIA_CHANGED', assetId, 'content');
  const prepared = await references.prepareFullHash(assetId, options);
  const beforeCommit = (): void => {
    options.signal?.throwIfAborted(); options.beforeEffect?.();
    if (registeredProjectStore(root) !== store) throw new TypeError('The project owner is no longer live');
    let realFile: string, realProject: string;
    try {realFile = realpathSync(prepared.file); realProject = realpathSync(store.projectDir);}
    catch {throw mediaUnavailableError('MEDIA_MISSING', assetId, 'not-found');}
    if (realFile !== prepared.file) throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ', assetId);
    if (!isInsideRealDirectory(realProject, realFile) && !projects.get(root)?.outsidePaths.list(store.projectId).some(grant => isFileInDirectory(grant.directory, realFile))) throw mediaUnavailableError('MEDIA_OUTSIDE_NOT_CONFIRMED', assetId);
  };
  beforeCommit();
  return commitProjectAssetHash(store, {assetId, expectedRaw: row.data, reference: prepared.reference, sha256: prepared.sha256,
    beforeEffect: beforeCommit, signal: options.signal});
}

/** Existing producers use private staging, then register an ordinary project
 * file. Final locations remain their current output paths until S2; persisted
 * assets nevertheless have exactly one reference locator from S1 onward. */
export async function referenceForPublishedMedia(store: ProjectStore, file: string, {sha256, signal, beforeEffect}: {sha256?: string; signal?: AbortSignal; beforeEffect?: () => void} = {}): Promise<{reference: MediaReference; referenceRevision: number; sha256: string; sizeBytes: number}> {
  if (!isProjectStore(store)) throw new TypeError('Published media requires the exact live owner');
  const access: MediaAccess = {projectDir: store.projectDir, projectFile: store.projectFile, mayReadOutside: () => false,
    isHeld: identity => isProjectFileHeld(identity) || isAppLibraryHeld(identity)};
  const media = await referenceForFile(access, file, {signal, beforeEffect});
  const full = await computeFullSha256(access, {...media.reference, fullSha256: sha256 ?? media.reference.fullSha256}, {signal, beforeEffect});
  return {reference: full.reference, referenceRevision: 1, sha256: full.sha256, sizeBytes: full.reference.sizeBytes};
}

export function projectMediaDirectory(store: ProjectStore): string {
  if (!isProjectStore(store)) throw new TypeError('Project media requires the exact live project store');
  return path.join(store.projectDir, 'media');
}
export interface ProjectMediaFileOptions {allowMissing?: boolean; maxBytes?: number; private?: boolean}
/** Producer-only location, kept until S2 changes output directories. Asset
 * reads never use this pathname API: they require the registered reference. */
export function resolveProjectMediaFile(store: ProjectStore, relativePath: string, options: ProjectMediaFileOptions = {}): {file: string; info: Stats | null} {
  if (!isProjectStore(store)) throw new TypeError('Project output requires the exact live owner');
  if (typeof relativePath !== 'string' || relativePath.length > 4096 || /[\\\0]/u.test(relativePath) || !relativePath.startsWith('media/') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new PrivateStorageError('OUTSIDE_ROOT', 'Project output must name its fixed media location');
  const root = projectMediaDirectory(store), file = path.resolve(store.projectDir, relativePath);
  let directory = store.projectDir;
  for (const name of relativePath.split('/').slice(0, -1)) {
    directory = path.join(directory, name);
    const info = lstatSync(directory, {throwIfNoEntry: false});
    if (!info) {if (options.allowMissing) return {file, info: null}; throw new PrivateStorageError('MISSING', 'The project output directory is missing');}
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PrivateStorageError('SYMBOLIC_LINK', 'Project output cannot traverse an alias');
  }
  if (!file.startsWith(root + path.sep)) throw new PrivateStorageError('OUTSIDE_ROOT', 'Project output must remain in its fixed directory');
  const info = lstatSync(file, {throwIfNoEntry: false});
  if (!info) {if (options.allowMissing) return {file, info: null}; throw new PrivateStorageError('MISSING', 'The project output is missing');}
  if (info.isSymbolicLink() || !info.isFile()) throw new PrivateStorageError('FILE_TYPE', 'Project output must be a regular file');
  const identity = lstatSync(file, {bigint: true});
  if (isProjectFileHeld({dev: String(identity.dev), ino: String(identity.ino)}) || isAppLibraryHeld({dev: String(identity.dev), ino: String(identity.ino)})) throw new PrivateStorageError('HELD_DATABASE', 'A held database cannot be used as project media');
  if (options.maxBytes !== undefined && info.size > options.maxBytes) throw new PrivateStorageError('SIZE_LIMIT', 'The project output exceeds its byte limit');
  return {file, info};
}
export function ensureProjectOutputDirectory(store: ProjectStore): void {
  if (!isProjectStore(store)) throw new TypeError('Project output requires the exact live owner');
  const directory = projectMediaDirectory(store);
  try {mkdirSync(directory, {mode: 0o755});} catch (error) {if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;}
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new PrivateStorageError('SYMBOLIC_LINK', 'Project output directory is not an ordinary directory');
}
/** Compatibility for internal decoder APIs that already take root:string.
 * A copied store or arbitrary matching path never registers a capability. */
export function registeredProjectMediaFile(root: string, relativePath: string): {file: string; info: Stats | null} | undefined {
  const store = projects.get(root)?.owner.deref();
  if (!store || !isProjectStore(store) || store.projectDir !== root) {projects.delete(root); return undefined;}
  return resolveProjectMediaFile(store, relativePath);
}
export function readProjectMediaFile(store: ProjectStore, relativePath: string, options: Omit<ReadPrivateFileOptions, 'root'> = {}): Buffer | string | null {
  const {file, info} = resolveProjectMediaFile(store, relativePath, options);
  if (!info) return null;
  const maxBytes = options.maxBytes ?? 4096;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || info.size > maxBytes) throw new PrivateStorageError('SIZE_LIMIT', 'The project output exceeds its byte limit');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = fstatSync(fd);
    if (!sameStats(first, info)) throw new PrivateStorageError('FILE_CHANGED', 'The project output changed');
    const bytes = Buffer.alloc(first.size); let offset = 0;
    while (offset < bytes.length) {const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset); if (count === 0) throw new PrivateStorageError('FILE_CHANGED', 'The project output was truncated'); offset += count;}
    const current = resolveProjectMediaFile(store, relativePath, options).info;
    if (!current || !sameStats(first, fstatSync(fd)) || !sameStats(first, current)) throw new PrivateStorageError('FILE_CHANGED', 'The project output changed');
    return options.encoding ? bytes.toString(options.encoding) : bytes;
  } finally {closeSync(fd);}
}
export function writeProjectMediaFileAtomic(store: ProjectStore, relativePath: string, bytes: Buffer | string | Uint8Array, options: Omit<WritePrivateFileOptions, 'root'> = {}): void {
  ensureProjectOutputDirectory(store);
  const contents = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), maxBytes = options.maxBytes ?? 4096;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || contents.length > maxBytes) throw new PrivateStorageError('SIZE_LIMIT', 'The project output exceeds its byte limit');
  const {file, info} = resolveProjectMediaFile(store, relativePath, {allowMissing: true, maxBytes});
  if (info) throw new PrivateStorageError('ALREADY_EXISTS', 'Project media is never overwritten');
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {writeFileSync(fd, contents); fsyncSync(fd);} finally {closeSync(fd);}
}
export function removeProjectMediaFile(store: ProjectStore, relativePath: string, options: Omit<RemovePrivateFileOptions, 'root'> = {}): void {
  const {file, info} = resolveProjectMediaFile(store, relativePath, {allowMissing: true, maxBytes: options.maxBytes});
  if (info) unlinkSync(file);
}
