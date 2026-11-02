import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {AppError} from '../../contracts/src/app-error.ts';
import {mediaFingerprintSchema, mediaReferenceSchema} from '../../contracts/src/media-reference.ts';
import type {MediaFingerprint, MediaReference, OutsideProjectLocation} from '../../contracts/src/media-reference.ts';
import type {AssetMediaLocation, AssetMediaState} from '../../contracts/src/asset-media.ts';
import {MEDIA_FINGERPRINT_TOKEN_VERSION} from '../../contracts/src/asset-media.ts';
import {mediaUnavailableError} from '../../contracts/src/media-reference-errors.ts';
import type {OutsidePathConfirmationStore} from './app-db/stores.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {
  admitMedia, checkMediaStatus, computeFullSha256, isFileInDirectory, isInsideRealDirectory, mediaReferenceError,
  mediaTypeOfName, outsideProjectLocations, readMediaBytes, referenceForFile, resolveReferencePath,
} from './media-reference/index.ts';
import type {MediaAccess, MediaFile, MediaStatusResult} from './media-reference/index.ts';

/** This foundation does not register operations, import files or change the
 * project's format. Only reference-bearing rows can use it; there is no
 * fallback to a managed relativePath or a client-supplied absolute path. */
export const PROJECT_ASSET_REFERENCE_LIMITS = Object.freeze({assetBytes: 16 * 1024, assets: 20_000, metadataBytes: 4 * 1024 * 1024});
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const fullHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Path and the lazily computed whole-file hash do not identify a cache
 * entry. A new mtime conservatively invalidates one, even for equal samples. */
export function mediaFingerprintToken(value: MediaFingerprint): string {
  const fingerprint = mediaFingerprintSchema.parse({sizeBytes: value.sizeBytes, mtimeMs: value.mtimeMs,
    sampledSha256: value.sampledSha256, fullSha256: value.fullSha256});
  return createHash('sha256').update(JSON.stringify([MEDIA_FINGERPRINT_TOKEN_VERSION, fingerprint.sizeBytes, fingerprint.mtimeMs, fingerprint.sampledSha256])).digest('hex');
}

export interface ProjectAssetReferenceOptions {
  /** A trusted application-library port, never a project-supplied grant. It
   * is read on every fence: revoking a directory takes effect immediately. */
  readonly outsidePaths: Pick<OutsidePathConfirmationStore, 'list'>;
}
export interface AssetReferenceReadOptions {
  readonly signal?: AbortSignal;
  readonly beforeEffect?: () => void;
  readonly expectedReferenceRevision?: number;
}
export interface AssetReferenceHashOptions extends AssetReferenceReadOptions {
  readonly maxBytes?: number;
  readonly onBytes?: (bytes: number) => void;
}
export interface PreparedAssetReference extends MediaFile {
  readonly assetId: string;
  readonly referenceRevision: number;
  readonly fingerprintToken: string;
}
export interface PreparedAssetHash extends PreparedAssetReference {
  readonly sha256: string;
}
export interface AssetReferenceBytes extends PreparedAssetHash {
  readonly bytes: Buffer;
}
export interface ProjectAssetReferenceServices {
  inspect(assetId: string, options?: AssetReferenceReadOptions): Promise<AssetMediaState>;
  location(assetId: string, options?: AssetReferenceReadOptions): Promise<AssetMediaLocation>;
  locations(options?: AssetReferenceReadOptions): Promise<OutsideProjectLocation[]>;
  resolve(assetId: string, options?: AssetReferenceReadOptions): Promise<PreparedAssetReference>;
  /** Returns a candidate and proof only. The caller must CAS its captured
   * reference revision before persisting it or freezing an execution. */
  prepareFullHash(assetId: string, options?: AssetReferenceHashOptions): Promise<PreparedAssetHash>;
  read(assetId: string, options: AssetReferenceHashOptions & {readonly maxBytes: number; readonly expectedSha256?: string}): Promise<AssetReferenceBytes>;
  /** The import handler must separately probe supported decoded streams,
   * obtain user confirmation and transactionally create an asset. This only
   * prepares its reference, hashing images/audio in full and sampling video. */
  referenceForImport(file: string, options?: Omit<AssetReferenceHashOptions, 'expectedReferenceRevision'>): Promise<MediaFile>;
}

interface AssetBasis {
  readonly id: string;
  readonly raw: string;
  readonly reference: MediaReference;
  readonly referenceRevision: number;
  readonly mimeType: string;
}
const PUBLIC_CODES = new Set(['MEDIA_MISSING', 'MEDIA_CHANGED', 'MEDIA_NOT_MEDIA', 'MEDIA_OUTSIDE_NOT_CONFIRMED', 'MEDIA_CHANGED_DURING_READ']);
function missing(): never {throw new AppError('NOT_FOUND', '找不到素材', 404);}
function invalid(assetId: string): never {throw mediaReferenceError('MEDIA_REFERENCE_INVALID', {assetId, reason: 'asset'});}
function checkedLimit(maxBytes: number | undefined): number | undefined {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new TypeError('A positive safe byte limit is required');
  return maxBytes;
}

export function createProjectAssetReferenceServices(store: ProjectStore, {outsidePaths}: ProjectAssetReferenceOptions): ProjectAssetReferenceServices {
  const owner = (): void => {
    if (!isProjectStore(store)) throw new TypeError('Asset references require the exact live project store');
  };
  owner();
  if (!outsidePaths || typeof outsidePaths.list !== 'function') throw new TypeError('A trusted outside-path reader is required');
  const columns = `id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${PROJECT_ASSET_REFERENCE_LIMITS.assetBytes} THEN data END AS data`;
  function decode(row: unknown, assetId: string): AssetBasis {
    if (!object(row) || row.id !== assetId || row.projectId !== store.projectId) missing();
    if (typeof row.data !== 'string') invalid(assetId);
    let value: unknown;
    try {value = JSON.parse(row.data);} catch {invalid(assetId);}
    if (!object(value) || value.id !== row.id || value.projectId !== row.projectId || typeof value.mimeType !== 'string' ||
      !Number.isSafeInteger(value.referenceRevision) || Number(value.referenceRevision) < 1) invalid(assetId);
    const parsed = mediaReferenceSchema.safeParse(value.reference);
    if (!parsed.success || value.sizeBytes !== parsed.data.sizeBytes || value.sha256 !== parsed.data.fullSha256 ||
      value.sha256 !== null && !fullHash(value.sha256) ||
      !['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'].includes(value.mimeType) ||
      mediaTypeOfName(parsed.data.path)?.mimeType !== value.mimeType) invalid(assetId);
    return {id: assetId, raw: row.data, reference: parsed.data, referenceRevision: Number(value.referenceRevision), mimeType: value.mimeType};
  }
  function readBasis(assetId: string): AssetBasis {
    owner();
    if (!uuid(assetId)) missing();
    return decode(store.db.prepare(`SELECT ${columns} FROM assets WHERE id=? LIMIT 1`).get(assetId), assetId);
  }
  const confirmed = (realFile: string): boolean => {
    owner();
    // Confirmation is to the exact real directory recorded by the trusted
    // chooser/confirmation handler, never descendants or a portable NFC alias.
    return outsidePaths.list(store.projectId).some(entry => entry.projectId === store.projectId && isFileInDirectory(entry.directory, realFile));
  };
  const access = (): MediaAccess => {
    owner();
    return {projectDir: store.projectDir, projectFile: store.projectFile, mayReadOutside: confirmed,
      isHeld: identity => isProjectFileHeld(identity) || isAppLibraryHeld(identity)};
  };
  const realProjectDirectory = (): string => {
    owner();
    try {return realpathSync(store.projectDir);}
    catch {throw mediaReferenceError('MEDIA_MISSING', {reason: 'project-directory'});}
  };

  function runOptions(options: AssetReferenceReadOptions, basis?: AssetBasis) {
    let effectFailure: unknown;
    let admittedFile: string | undefined;
    const fence = (): void => {
      owner();
      options.signal?.throwIfAborted();
      if (options.beforeEffect) {
        try {options.beforeEffect();} catch (error) {effectFailure = error; throw error;}
      }
      owner();
      options.signal?.throwIfAborted();
      if (basis) {
        const row = store.db.prepare(`SELECT ${columns} FROM assets WHERE id=? LIMIT 1`).get(basis.id);
        if (!row || row.id !== basis.id || row.projectId !== store.projectId || row.data !== basis.raw) {
          throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ', basis.id);
        }
      }
      // The kernel keeps the requested project path, while L1 returns real
      // file paths. Resolve the directory at every fence instead of comparing
      // an ancestor symlink/junction (or an on-disk spelling alias) literally,
      // and never keep a grant after that requested directory disappears.
      if (admittedFile !== undefined && !isInsideRealDirectory(realProjectDirectory(), admittedFile) && !confirmed(admittedFile)) {
        if (basis) throw mediaUnavailableError('MEDIA_OUTSIDE_NOT_CONFIRMED', basis.id);
        throw mediaReferenceError('MEDIA_OUTSIDE_NOT_CONFIRMED');
      }
    };
    const permissionFence = (realFile: string): void => {
      admittedFile = realFile;
      fence();
    };
    async function guarded<T>(read: () => Promise<T>): Promise<T> {
      try {fence(); const value = await read(); fence(); return value;}
      catch (error) {
        if (error === effectFailure) throw error;
        if (basis && error instanceof AppError && PUBLIC_CODES.has(error.code)) {
          const reason = object(error.details) ? error.details.reason : undefined;
          throw mediaUnavailableError(error.code as Parameters<typeof mediaUnavailableError>[0], basis.id, typeof reason === 'string' ? reason as Parameters<typeof mediaUnavailableError>[2] : undefined);
        }
        if (basis && error instanceof AppError && error.code === 'MEDIA_REFERENCE_INVALID') {
          throw mediaReferenceError('MEDIA_REFERENCE_INVALID', {assetId: basis.id,
            reason: object(error.details) && typeof error.details.reason === 'string' ? error.details.reason : 'schema'});
        }
        throw error;
      }
    }
    if (basis && options.expectedReferenceRevision !== undefined && options.expectedReferenceRevision !== basis.referenceRevision) {
      throw mediaUnavailableError('MEDIA_CHANGED_DURING_READ', basis.id);
    }
    return {fence, permissionFence, guarded};
  }
  const prepared = (basis: AssetBasis, media: MediaFile): PreparedAssetReference => ({...media, assetId: basis.id,
    referenceRevision: basis.referenceRevision, fingerprintToken: mediaFingerprintToken(media.reference)});
  async function admitted(basis: AssetBasis, options: AssetReferenceReadOptions, state: ReturnType<typeof runOptions>): Promise<MediaFile> {
    state.fence();
    const media = await admitMedia(access(), basis.reference, {signal: options.signal, beforeEffect: state.fence});
    state.permissionFence(media.file);
    if (media.type.mimeType !== basis.mimeType) throw mediaUnavailableError('MEDIA_CHANGED', basis.id, 'not-media');
    return media;
  }
  function statusView(basis: AssetBasis, status: MediaStatusResult): AssetMediaState {
    return {assetId: basis.id, referenceRevision: basis.referenceRevision, status: status.status, reason: status.reason,
      outside: status.outside, readable: status.readable, fingerprintToken: mediaFingerprintToken(status.reference)};
  }

  const service: ProjectAssetReferenceServices = {
    async inspect(assetId, options = {}) {
      const basis = readBasis(assetId), state = runOptions(options, basis);
      return state.guarded(async () => statusView(basis, await checkMediaStatus(access(), basis.reference, {signal: options.signal, beforeEffect: state.fence})));
    },
    async location(assetId, options = {}) {
      const basis = readBasis(assetId), state = runOptions(options, basis);
      return state.guarded(async () => {
        const status = await checkMediaStatus(access(), basis.reference, {signal: options.signal, beforeEffect: state.fence});
        return {assetId, displayPath: status.file ?? resolveReferencePath(store.projectDir, basis.reference) ?? basis.reference.path,
          pathForm: basis.reference.pathForm, volume: basis.reference.volume, outside: status.outside};
      });
    },
    async locations(options = {}) {
      let contentSequence: unknown;
      const sequence = (): unknown => store.db.prepare('SELECT contentSequence FROM project.project_file WHERE singleton=1').get()?.contentSequence;
      const state = runOptions({...options, beforeEffect: () => {
        options.beforeEffect?.();
        owner();
        if (contentSequence !== undefined && sequence() !== contentSequence) throw new AppError('REVISION_CONFLICT', '检查时项目内容已变化', 409);
      }});
      return state.guarded(async () => {
        contentSequence = sequence();
        const bases: AssetBasis[] = [];
        let bytes = 0;
        for (const row of store.db.prepare(`SELECT ${columns} FROM assets WHERE projectId=? ORDER BY id LIMIT ?`)
          .iterate(store.projectId, PROJECT_ASSET_REFERENCE_LIMITS.assets + 1)) {
          const basis = decode(row, String(row.id));
          bytes += Buffer.byteLength(basis.raw);
          if (bases.length >= PROJECT_ASSET_REFERENCE_LIMITS.assets || bytes > PROJECT_ASSET_REFERENCE_LIMITS.metadataBytes) {
            throw new AppError('INSPECTION_BUDGET_EXCEEDED', '素材检查超过上限', 429);
          }
          bases.push(basis);
        }
        const result = await outsideProjectLocations(access(), bases.map(basis => ({id: basis.id, reference: basis.reference})));
        // No writes took place; a result must still describe the same graph.
        for (const basis of bases) runOptions(options, basis).fence();
        return result;
      });
    },
    async resolve(assetId, options = {}) {
      const basis = readBasis(assetId), state = runOptions(options, basis);
      return state.guarded(async () => prepared(basis, await admitted(basis, options, state)));
    },
    async prepareFullHash(assetId, options = {}) {
      const maxBytes = checkedLimit(options.maxBytes), basis = readBasis(assetId), state = runOptions(options, basis);
      return state.guarded(async () => {
        if (maxBytes !== undefined && basis.reference.sizeBytes > maxBytes) throw mediaReferenceError('MEDIA_REFERENCE_INVALID', {assetId, reason: 'size-limit'});
        const media = await admitted(basis, options, state);
        const hash = await computeFullSha256(access(), basis.reference, {signal: options.signal, maxBytes,
          beforeEffect: () => state.permissionFence(media.file), onBytes: options.onBytes});
        state.permissionFence(media.file);
        return {...prepared(basis, {...media, reference: hash.reference}), sha256: hash.sha256};
      });
    },
    async read(assetId, options) {
      const maxBytes = checkedLimit(options.maxBytes);
      if (maxBytes === undefined) throw new TypeError('A byte limit is required');
      if (options.expectedSha256 !== undefined && !fullHash(options.expectedSha256)) throw new TypeError('An exact SHA-256 is required');
      const basis = readBasis(assetId), state = runOptions(options, basis);
      return state.guarded(async () => {
        if (basis.reference.sizeBytes > maxBytes) throw mediaReferenceError('MEDIA_REFERENCE_INVALID', {assetId, reason: 'size-limit'});
        const media = await admitted(basis, options, state);
        const read = await readMediaBytes(access(), basis.reference, {maxBytes, signal: options.signal, expectedSha256: options.expectedSha256,
          beforeEffect: () => state.permissionFence(media.file), onBytes: options.onBytes});
        state.permissionFence(media.file);
        return {...prepared(basis, read), bytes: read.bytes, sha256: read.sha256};
      });
    },
    async referenceForImport(file, options = {}) {
      checkedLimit(options.maxBytes);
      const state = runOptions(options);
      return state.guarded(async () => {
        const media = await referenceForFile(access(), file, {signal: options.signal, beforeEffect: state.fence, maxBytes: options.maxBytes});
        state.permissionFence(media.file);
        // Header admission is not a decoder/probe or a format expansion. The
        // existing asset importer supports this closed set of MIME types.
        if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'].includes(media.type.mimeType)) {
          throw mediaReferenceError('MEDIA_NOT_MEDIA', {reason: 'extension'});
        }
        if (media.type.kind === 'video') return media;
        const hash = await computeFullSha256(access(), media.reference, {signal: options.signal, maxBytes: options.maxBytes,
          beforeEffect: () => state.permissionFence(media.file), onBytes: options.onBytes});
        state.permissionFence(media.file);
        return {...media, reference: hash.reference};
      });
    },
  };
  return Object.freeze(service);
}
