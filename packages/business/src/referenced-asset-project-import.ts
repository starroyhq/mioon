import {createHash} from 'node:crypto';
import {lstatSync, realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {isAsyncFunction} from 'node:util/types';
import {AppError} from '../../contracts/src/app-error.ts';
import {assetPathImportSchema, assetMediaRecordSchema, assetMediaDtoSchema, assetUploadImportSchema, toAssetMediaDto} from '../../contracts/src/asset-media.ts';
import type {AssetImportInput, AssetMediaDto} from '../../contracts/src/asset-media.ts';
import {mediaReferenceSchema} from '../../contracts/src/media-reference.ts';
import type {MediaReference} from '../../contracts/src/media-reference.ts';
import {projectIdSchema, projectMediaPath} from '../../contracts/src/project-file.ts';
import {readPrivateFile, validatePrivateDirectory} from '../../contracts/src/private-storage.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {readMioTargetRevision} from './agent/mio-target-revisions.ts';
import {isInsideRealDirectory} from './media-reference/paths.ts';
import {checkpoint} from './operation-lifecycle.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {prepareReferencedAssetImportFile, withReferencedAssetProjectImportContext} from './referenced-asset-import.ts';
import type {ReferencedAssetProjectImportContext} from './referenced-asset-import.ts';

export type AssetPathImportInput = Extract<AssetImportInput, {sourcePath: string}>;
export interface ProjectAssetImportContext {readonly signal?: AbortSignal; readonly beforeEffect: () => void}
interface Identity {readonly dev: string; readonly ino: string; readonly birthtimeNs: string}
interface SourceIdentity extends Identity {readonly size: string; readonly mtimeNs: string; readonly ctimeNs: string}
interface Metadata {readonly width: number; readonly height: number; readonly duration: number; readonly hasVideo: boolean; readonly hasAudio: boolean}
export interface ProjectAssetImportPreparation {
  readonly version: 1; readonly input: AssetPathImportInput; readonly inputDigest: string; readonly ownerToken: string;
  readonly rootIdentity: Identity; readonly projectIdentity: Identity; readonly sourceIdentity: SourceIdentity;
  readonly file: string; readonly reference: MediaReference; readonly mimeType: string; readonly metadata: Metadata; readonly proofDigest: string;
}
export interface ProjectAssetImportReceiptProof {
  readonly version: 1; readonly projectId: string; readonly requestId: string; readonly receiptKey: string;
  readonly inputDigest: string; readonly assetId: string; readonly assetDigest: string;
}
export interface ProjectAssetImportCreationProof extends ProjectAssetImportReceiptProof {readonly assetRevision: number; readonly asset: AssetMediaDto}
export interface ProjectAssetImportExecution {
  readonly disposition: 'created' | 'reused'; readonly asset: AssetMediaDto; readonly receipt: ProjectAssetImportReceiptProof;
  readonly creation?: ProjectAssetImportCreationProof;
}
interface LookupSnapshot {assertCurrent(): void}
export type ProjectAssetImportLookup = LookupSnapshot & (
  {readonly outcome: 'not_applied'; readonly reason: string; readonly receipt?: ProjectAssetImportReceiptProof; readonly assetId?: string} |
  {readonly outcome: 'retired'; readonly receipt: ProjectAssetImportReceiptProof; readonly assetRevision: number} |
  {readonly outcome: 'applied'; readonly receipt: ProjectAssetImportReceiptProof; readonly asset: AssetMediaDto; readonly assetRevision: number; readonly currentAssetDigest: string; readonly changed: boolean} |
  {readonly outcome: 'unknown'; readonly reason: string}
);
type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Row, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && Object.keys(v).every(key => keys.includes(key));
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const decimal = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,39})$/u.test(v);
const noOutsidePaths = {list: () => []};
const fsRead = <T>(read: () => T): T => {try {return read();} catch (error) {if (error instanceof AppError) throw error; return changed();}};
function invalid(): never {throw new AppError('AGENT_TASK_INVALID_TARGET', '项目文件导入证明无效', 409);}
function changed(): never {throw new AppError('MEDIA_CHANGED_DURING_READ', '读取期间素材或项目身份已变化', 409);}
function unknown(): never {throw new AppError('AGENT_TASK_UNKNOWN_RESULT', '原请求的素材导入结果无法验证', 409);}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (object(v)) return '{' + Object.keys(v).filter(key => v[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(v[key])).join(',') + '}';
  const text = JSON.stringify(v); if (text === undefined) invalid(); return text;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) frozen(child); Object.freeze(value);}
  return value;
}
function identity(info: BigIntStats): Identity {return {dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs)};}
function sourceIdentity(info: BigIntStats): SourceIdentity {return {...identity(info), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs)};}
function stat(file: string): BigIntStats | null {return lstatSync(file, {bigint: true, throwIfNoEntry: false}) ?? null;}
function unheld(info: BigIntStats): void {
  if (isProjectFileHeld({dev: String(info.dev), ino: String(info.ino)}) || isAppLibraryHeld({dev: String(info.dev), ino: String(info.ino)})) invalid();
}
function inputValue(value: unknown): AssetPathImportInput {
  const parsed = assetPathImportSchema.safeParse(value); if (!parsed.success) invalid(); return parsed.data;
}
function identityValue(value: unknown, source = false): boolean {
  return object(value) && exact(value, source ? ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'] : ['dev', 'ino', 'birthtimeNs']) &&
    Object.values(value).every(decimal) && value.ino !== '0';
}
function metadataValue(value: unknown): value is Metadata {
  return object(value) && exact(value, ['width', 'height', 'duration', 'hasVideo', 'hasAudio']) &&
    ['width', 'height', 'duration'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && Number(value[key]) >= 0) &&
    Number.isSafeInteger(value.width) && Number(value.width) <= 100000 && Number.isSafeInteger(value.height) && Number(value.height) <= 100000 &&
    typeof value.hasVideo === 'boolean' && typeof value.hasAudio === 'boolean';
}
function metadata(value: Metadata): Metadata {return {width: value.width, height: value.height, duration: value.duration, hasVideo: value.hasVideo, hasAudio: value.hasAudio};}
function recordValue(value: unknown): Row {
  if (!object(value)) invalid();
  const parsed = assetMediaRecordSchema.safeParse(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'url')));
  if (!parsed.success || Object.hasOwn(value, 'url') && value.url !== projectMediaPath(parsed.data.projectId, parsed.data.id)) invalid();
  return value;
}
/** Same canonical complete persisted record used by creation, lookup and undo. */
export function projectAssetImportAssetDigest(value: unknown): string {return hash(canonical(recordValue(value)));}
function parsePreparation(value: unknown): ProjectAssetImportPreparation {
  if (!object(value) || !exact(value, ['version', 'input', 'inputDigest', 'ownerToken', 'rootIdentity', 'projectIdentity', 'sourceIdentity', 'file', 'reference', 'mimeType', 'metadata', 'proofDigest']) || value.version !== 1) invalid();
  const input = inputValue(value.input), reference = mediaReferenceSchema.safeParse(value.reference);
  if (!sha(value.inputDigest) || value.inputDigest !== hash(JSON.stringify(input)) || !sha(value.ownerToken) || !sha(value.proofDigest) ||
    !identityValue(value.rootIdentity) || !identityValue(value.projectIdentity) || !identityValue(value.sourceIdentity, true) ||
    typeof value.file !== 'string' || !path.isAbsolute(value.file) || path.resolve(value.file) !== value.file || value.file.includes('\0') ||
    !reference.success || !assetUploadImportSchema.shape.mimeType.safeParse(value.mimeType).success || !metadataValue(value.metadata)) invalid();
  if (!object(value.sourceIdentity) || BigInt(String(value.sourceIdentity.size)) !== BigInt(reference.data.sizeBytes)) invalid();
  const {proofDigest, ...basis} = value;
  if (hash(canonical(basis)) !== proofDigest) invalid();
  // Normalize to private JSON, preventing mutations of a saved approval while I/O awaits.
  return frozen(JSON.parse(JSON.stringify(value)) as ProjectAssetImportPreparation);
}
function parseReceiptProof(value: unknown): ProjectAssetImportReceiptProof {
  if (!object(value) || !exact(value, ['version', 'projectId', 'requestId', 'receiptKey', 'inputDigest', 'assetId', 'assetDigest']) || value.version !== 1 ||
    !projectIdSchema.safeParse(value.projectId).success || !projectIdSchema.safeParse(value.assetId).success || typeof value.requestId !== 'string' ||
    value.requestId.length < 8 || value.requestId.length > 200 || !sha(value.receiptKey) || value.receiptKey !== hash(value.requestId) || !sha(value.inputDigest) || !sha(value.assetDigest)) invalid();
  return frozen({...value}) as unknown as ProjectAssetImportReceiptProof;
}
function parseCreation(value: unknown): ProjectAssetImportCreationProof {
  if (!object(value) || !exact(value, ['version', 'projectId', 'requestId', 'receiptKey', 'inputDigest', 'assetId', 'assetDigest', 'assetRevision', 'asset'])) invalid();
  const {assetRevision, asset, ...receipt} = value, proof = parseReceiptProof(receipt), dto = assetMediaDtoSchema.safeParse(asset);
  if (!Number.isSafeInteger(assetRevision) || Number(assetRevision) < 1 || !dto.success || dto.data.id !== proof.assetId || dto.data.projectId !== proof.projectId) invalid();
  return frozen({...proof, assetRevision: Number(assetRevision), asset: dto.data});
}
function schema<T>(parse: (value: unknown) => T) {
  return Object.freeze({parse, safeParse(value: unknown): {success: true; data: T} | {success: false; error: unknown} {
    try {return {success: true, data: parse(value)};} catch (error) {return {success: false, error};}
  }});
}
export const projectAssetImportPreparationSchema = schema(parsePreparation);
export const projectAssetImportReceiptProofSchema = schema(parseReceiptProof);
export const projectAssetImportCreationProofSchema = schema(parseCreation);

function ownerBasis(store: ProjectStore) {
  if (!isProjectStore(store)) invalid();
  const root = fsRead(() => realpathSync(store.projectDir)), project = fsRead(() => realpathSync(store.projectFile)), rootInfo = fsRead(() => stat(root)), projectInfo = fsRead(() => stat(project));
  if (!rootInfo?.isDirectory() || !projectInfo?.isFile() || !isProjectFileHeld(identity(projectInfo))) invalid();
  const row = store.db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM projects WHERE id=?").get(store.projectId);
  let value: unknown; try {value = typeof row?.data === 'string' ? JSON.parse(row.data) as unknown : null;} catch {invalid();}
  if (!object(value) || row?.id !== store.projectId || value.id !== store.projectId) invalid();
  return {root, project, rootIdentity: identity(rootInfo), projectIdentity: identity(projectInfo), ownerToken: hash(canonical([value.id, Object.hasOwn(value, 'createdAt'), value.createdAt ?? null]))};
}
function sourceBasis(store: ProjectStore, input: AssetPathImportInput) {
  const owner = ownerBasis(store), file = fsRead(() => realpathSync(input.sourcePath)), info = fsRead(() => stat(file));
  if (!info?.isFile() || info.isSymbolicLink() || !isInsideRealDirectory(owner.root, file)) invalid(); unheld(info);
  return {...owner, file, sourceIdentity: sourceIdentity(info)};
}
function receiptProof(input: AssetPathImportInput, receipt: Row): ProjectAssetImportReceiptProof {
  if (receipt.version !== 1 || receipt.projectId !== input.projectId || receipt.digest !== hash(JSON.stringify(input)) || typeof receipt.assetId !== 'string' ||
    !object(receipt.asset) || receipt.asset.id !== receipt.assetId || receipt.asset.projectId !== input.projectId) unknown();
  return parseReceiptProof({version: 1, projectId: input.projectId, requestId: input.requestId, receiptKey: hash(input.requestId),
    inputDigest: receipt.digest, assetId: receipt.assetId, assetDigest: projectAssetImportAssetDigest(receipt.asset)});
}

export function createReferencedAssetProjectImport(store: ProjectStore, {importPath}: {
  readonly importPath: (input: AssetPathImportInput, context: ProjectAssetImportContext) => Promise<unknown>;
}) {
  if (!isProjectStore(store)) invalid();
  function fence(context: ProjectAssetImportContext): void {checkpoint(context.signal); context.beforeEffect(); checkpoint(context.signal); if (!isProjectStore(store)) changed();}
  async function prepare(raw: AssetPathImportInput, context: ProjectAssetImportContext): Promise<ProjectAssetImportPreparation> {
    const input = inputValue(raw); if (input.projectId !== store.projectId) invalid(); fence(context);
    const before = sourceBasis(store, input), check = (): void => {fence(context); if (!isDeepStrictEqual(sourceBasis(store, input), before)) changed();};
    const prepared = await prepareReferencedAssetImportFile(store, input.sourcePath, {assetId: store.projectId, outsidePaths: noOutsidePaths, signal: context.signal, beforeEffect: check}); check();
    const basis = {version: 1 as const, input, inputDigest: hash(JSON.stringify(input)), ownerToken: before.ownerToken,
      rootIdentity: before.rootIdentity, projectIdentity: before.projectIdentity, sourceIdentity: before.sourceIdentity,
      file: before.file, reference: prepared.media.reference, mimeType: prepared.media.type.mimeType, metadata: metadata(prepared.metadata)};
    return parsePreparation({...basis, proofDigest: hash(canonical(basis))});
  }
  async function execute(raw: ProjectAssetImportPreparation, context: ProjectAssetImportContext & {
    readonly recordCreatedInside: (proof: ProjectAssetImportCreationProof) => void;
  }): Promise<ProjectAssetImportExecution> {
    const prepared = parsePreparation(raw), input = prepared.input;
    if (input.projectId !== store.projectId || typeof context.recordCreatedInside !== 'function' || isAsyncFunction(context.recordCreatedInside)) invalid();
    const known = await lookup(input, context); known.assertCurrent();
    if (known.outcome === 'applied') return frozen({disposition: 'reused', asset: known.asset, receipt: known.receipt});
    if (known.outcome === 'retired') throw new AppError('IDEMPOTENCY_CONFLICT', '原请求的素材登记已移除，不能重新创建', 409);
    if (known.outcome === 'unknown') unknown();
    let result: ProjectAssetImportExecution | undefined;
    const check = (): void => {
      fence(context); const current = sourceBasis(store, input);
      if (current.ownerToken !== prepared.ownerToken || current.file !== prepared.file || !isDeepStrictEqual(current.rootIdentity, prepared.rootIdentity) ||
        !isDeepStrictEqual(current.projectIdentity, prepared.projectIdentity) || !isDeepStrictEqual(current.sourceIdentity, prepared.sourceIdentity)) changed();
    };
    const checkAsset = (asset: Row): void => {
      if (!isDeepStrictEqual(asset.reference, prepared.reference) || asset.mimeType !== prepared.mimeType || !isDeepStrictEqual(metadata(asset as unknown as Metadata), prepared.metadata)) changed();
    };
    const origin: ReferencedAssetProjectImportContext = {store, inputDigest: prepared.inputDigest, beforeEffect: check,
      preparedFile(value) {value.assertCurrent(); if (!isDeepStrictEqual(value.media.reference, prepared.reference) || value.media.type.mimeType !== prepared.mimeType || !isDeepStrictEqual(metadata(value.metadata), prepared.metadata)) changed();},
      preparedAsset: checkAsset,
      reused(asset, receipt) {
        const proof = receiptProof(input, receipt), value = recordValue(asset);
        if (value.id !== proof.assetId || value.projectId !== store.projectId || readMioTargetRevision(store.db, store.projectId, 'asset', proof.assetId) === undefined) unknown();
        result = frozen({disposition: 'reused', asset: toAssetMediaDto(value), receipt: proof});
      },
      createdInside(asset, receipt) {
        check(); if (!store.db.isTransaction) unknown();
        const proof = receiptProof(input, receipt), revision = readMioTargetRevision(store.db, store.projectId, 'asset', proof.assetId);
        if (revision === undefined) unknown();
        const creation = parseCreation({...proof, assetRevision: revision, asset: toAssetMediaDto(asset)});
        const returned: unknown = context.recordCreatedInside(creation);
        if (returned && typeof returned === 'object' && 'then' in returned) throw new TypeError('Creation recording must be synchronous');
        result = frozen({disposition: 'created', asset: creation.asset, receipt: proof, creation});
      },
    };
    check(); await withReferencedAssetProjectImportContext(origin, () => importPath(input, {signal: context.signal, beforeEffect: check}));
    if (!result) unknown(); return result;
  }
  async function lookup(raw: AssetPathImportInput, context: ProjectAssetImportContext): Promise<ProjectAssetImportLookup> {
    const input = inputValue(raw); if (input.projectId !== store.projectId) invalid(); fence(context);
    const owner = ownerBasis(store), directory = path.join(store.tempDir, 'asset-imports'), file = path.join(directory, hash(input.requestId) + '.json');
    const epochs = new Map<string, string | null>();
    const epoch = (p: string): string | null => {const info = stat(p); return info && canonical({...sourceIdentity(info), mode: String(info.mode), uid: String(info.uid), nlink: String(info.nlink)});};
    const watch = (p: string): void => {epochs.set(p, epoch(p));};
    watch(store.tempDir); watch(directory); watch(file);
    let assetId: string | undefined, rowRaw: string | null = null, revision: number | undefined;
    const rowStatement = store.db.prepare("SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 32768 THEN data END AS data FROM assets WHERE id=?");
    const assertCurrent = (): void => {
      fence(context); if (!isDeepStrictEqual(ownerBasis(store), owner)) changed();
      for (const [p, expected] of epochs) if (epoch(p) !== expected) changed();
      if (assetId) {
        const row = rowStatement.get(assetId);
        if ((typeof row?.data === 'string' ? row.data : null) !== rowRaw || row && (row.id !== assetId || row.projectId !== store.projectId || typeof row.data !== 'string') ||
          readMioTargetRevision(store.db, store.projectId, 'asset', assetId) !== revision) changed();
      }
    };
    await yieldIO(); assertCurrent();
    let saved: unknown;
    try {
      validatePrivateDirectory(store.tempDir); const present = validatePrivateDirectory(directory, {allowMissing: true});
      if (!present) return {outcome: 'not_applied', reason: 'receipt_absent', assertCurrent};
      const read = (): string | null => {
        const before = stat(file); if (before) unheld(before);
        const raw = readPrivateFile(file, {root: directory, allowMissing: true, maxBytes: 32768, encoding: 'utf8'});
        if (epoch(file) !== epochs.get(file)) changed(); return raw === null ? null : String(raw);
      };
      const text = read(); if (text !== read()) changed();
      if (text === null) return {outcome: 'not_applied', reason: 'receipt_absent', assertCurrent};
      saved = JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof AppError && error.code === 'MEDIA_CHANGED_DURING_READ') throw error;
      return {outcome: 'unknown', reason: 'invalid_receipt', assertCurrent};
    }
    if (!object(saved) || Object.keys(saved).some(key => !['version', 'projectId', 'assetId', 'digest', 'attempt', 'phase', 'asset'].includes(key)) || saved.version !== 1 || saved.projectId !== store.projectId ||
      !projectIdSchema.safeParse(saved.assetId).success || saved.digest !== hash(JSON.stringify(input)) || saved.attempt !== 0 || typeof saved.phase !== 'string' ||
      !['intent', 'prepared', 'registered'].includes(saved.phase)) return {outcome: 'unknown', reason: 'receipt_binding', assertCurrent};
    assetId = String(saved.assetId); const row = rowStatement.get(assetId); rowRaw = typeof row?.data === 'string' ? row.data : null;
    revision = readMioTargetRevision(store.db, store.projectId, 'asset', assetId);
    assertCurrent();
    if (saved.phase === 'intent') return !row && revision === undefined && !Object.hasOwn(saved, 'asset')
      ? {outcome: 'not_applied', reason: 'registration_absent', assetId, assertCurrent} : {outcome: 'unknown', reason: 'intent_conflict', assertCurrent};
    let proof: ProjectAssetImportReceiptProof;
    try {proof = receiptProof(input, saved);} catch {return {outcome: 'unknown', reason: 'invalid_receipt_asset', assertCurrent};}
    if (!row) return saved.phase === 'registered' || revision !== undefined
      ? {outcome: 'retired', receipt: proof, assetRevision: revision ?? 0, assertCurrent}
      : {outcome: 'not_applied', reason: 'registration_absent', receipt: proof, assetId, assertCurrent};
    if (row.id !== assetId || row.projectId !== store.projectId || rowRaw === null || revision === undefined) return {outcome: 'unknown', reason: 'registration_identity', assertCurrent};
    try {
      const value: unknown = JSON.parse(rowRaw), currentAssetDigest = projectAssetImportAssetDigest(value);
      if (!object(value) || value.id !== assetId || value.projectId !== store.projectId || saved.phase === 'prepared' && currentAssetDigest !== proof.assetDigest) unknown();
      return {outcome: 'applied', receipt: proof, asset: toAssetMediaDto(value), assetRevision: revision, currentAssetDigest, changed: currentAssetDigest !== proof.assetDigest, assertCurrent};
    } catch {return {outcome: 'unknown', reason: 'registration_content', assertCurrent};}
  }
  return Object.freeze({prepare, execute, lookup});
}
