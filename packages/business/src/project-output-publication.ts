import {createHash, randomUUID} from 'node:crypto';
import {constants, lstatSync, openSync, fstatSync, closeSync, fsyncSync, realpathSync, mkdirSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {open, link, unlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import {ensurePrivateDirectory, validateManagedDirectory, validateManagedFile, readPrivateFile, writePrivateFileAtomic,getWindowsManagedFileIO} from '../../contracts/src/private-storage.ts';
import {mediaReferenceSchema} from '../../contracts/src/media-reference.ts';
import type {MediaReference} from '../../contracts/src/media-reference.ts';
import {PROJECT_OUTPUT_FOLDERS, projectOutputOwnerSchema, projectOutputPublicationProofSchema, projectOutputPublicationReceiptSchema as receiptSchema, projectOutputPublicationIndexSchema as indexSchema} from '../../contracts/src/project-output-publication.ts';
import type {ProjectOutputOwner, ProjectOutputPublicationProof, ProjectOutputPublicationReceipt as Receipt, ProjectOutputPublicationIndex} from '../../contracts/src/project-output-publication.ts';
import {projectIdSchema as uuid} from '../../contracts/src/project-file.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {referenceForPublishedMedia} from './project-media-storage.ts';
import {assertProjectOutputStore, outputFileIdentity, sameOutputIdentity,isProjectOutputAdmissionFailure} from './project-output-owner.ts';
import type {OutputFileIdentity} from './project-output-owner.ts';

export type {ProjectOutputOwner, ProjectOutputPublicationProof};
export interface ProjectOutputOptions {readonly signal?: AbortSignal; readonly beforeEffect?: () => void}
export interface ProjectOutputInput {
  readonly owner: ProjectOutputOwner; readonly assetId: string; readonly publicationId?: string;
  readonly targetKind: 'generated' | 'exports' | 'assets'; readonly stageFile: string;
  readonly mimeType: string; readonly sha256: string; readonly sizeBytes: number; readonly displayName?: string;
}
export interface PublishedProjectOutput {
  readonly reference: MediaReference; readonly referenceRevision: 1; readonly sha256: string;
  readonly sizeBytes: number; readonly relativePath: string; readonly publication: ProjectOutputPublicationProof;
}
export interface PublishedProjectOutputExpectation {
  readonly projectId: string; readonly assetId?: string;
  readonly owner: Pick<ProjectOutputOwner, 'kind' | 'id'> & Partial<Pick<ProjectOutputOwner, 'requestId' | 'inputHash'>>;
  readonly targetKind: ProjectOutputInput['targetKind']; readonly sha256?: string; readonly sizeBytes?: number; readonly mimeType?: string;
  readonly requireOriginalLocation?:boolean;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const extensions: Readonly<Record<string, string>> = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a'};
const inFlight = new WeakMap<ProjectStore, Map<string, Promise<PublishedProjectOutput>>>();
export interface ProjectOutputPublicationTestHooks {
  readonly forceCopy?: boolean;
  readonly fault?: (point: 'after_intent' | 'after_target_create' | 'after_target_identity' | 'after_copy_chunk' | 'after_final' | 'after_registered', proof: ProjectOutputPublicationProof) => void;
}
const testHooks = new WeakMap<ProjectStore, ProjectOutputPublicationTestHooks>();
const ownerFailures=new WeakSet<object>();
/** In-process fault injection only; never selected by an operation or env. */
export function setProjectOutputPublicationTestHooks(store: ProjectStore, hooks: ProjectOutputPublicationTestHooks): () => void {
  if (!isProjectStore(store)) throw new TypeError('An exact test project owner is required');
  testHooks.set(store, hooks); return () => {if (testHooks.get(store) === hooks) testHooks.delete(store);};
}
function invalid(): never {throw new AppError('INVALID_MEDIA', '本地产物或发布回执无法验证', 409);}
function conflict(): never {throw new AppError('IDEMPOTENCY_CONFLICT', '产物发布身份与原请求不一致', 409);}
class BytesMismatch extends AppError {constructor(){super('INVALID_MEDIA','本地产物的字节或身份已改变',409);}}
function fence(store: ProjectStore, options: ProjectOutputOptions): void {
  options.signal?.throwIfAborted();try{options.beforeEffect?.();}catch(error){if(record(error))ownerFailures.add(error);throw error;}assertProjectOutputStore(store);
}
function normalizeOutputIo(error:unknown):never{
  if(record(error)&&!ownerFailures.has(error)&&!isProjectOutputAdmissionFailure(error)&&typeof error.code==='string'&&typeof error.path==='string'){
    const unavailable=new AppError('INVALID_MEDIA','本地产物的位置或文件已不可用',409);Object.defineProperty(unavailable,'cause',{value:error});throw unavailable;
  }
  throw error;
}
function sameOwner(a: ProjectOutputOwner, b: ProjectOutputOwner): boolean {
  return a.kind === b.kind && a.id === b.id && a.requestId === b.requestId && a.inputHash === b.inputHash;
}
function keyFor(owner: ProjectOutputOwner, assetId: string): string {
  return createHash('sha256').update(JSON.stringify([owner.kind, owner.id, owner.requestId, owner.inputHash, assetId])).digest('hex');
}
function roots(store: ProjectStore, options: ProjectOutputOptions, create = false): {directory: string} {
  fence(store, options);
  const directory = path.join(store.tempDir, 'publications');
  if (create) {ensurePrivateDirectory(directory, {create: true});syncDirectory(store.tempDir);}
  if (!validateManagedDirectory(directory, {root: store.tempDir, private: true, allowMissing: !create})) return {directory};
  return {directory};
}
function syncDirectory(directory: string): void {
  if(process.platform==='win32'){getWindowsManagedFileIO().syncDirectory(directory,{root:directory,private:false});return;}
  const before = lstatSync(directory, {bigint: true}), fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, {bigint: true});
    if (!opened.isDirectory() || !sameOutputIdentity(outputFileIdentity(before), outputFileIdentity(opened))) invalid();
    fsyncSync(fd);
    if (!sameOutputIdentity(outputFileIdentity(opened), outputFileIdentity(lstatSync(directory, {bigint: true})))) invalid();
  } finally {closeSync(fd);}
}
function writeReceipt(store: ProjectStore, receipt: Receipt, options: ProjectOutputOptions): void {
  fence(store, options); const {directory} = roots(store, options, true);
  receiptSchema.parse(receipt);
  writePrivateFileAtomic(path.join(directory, `${receipt.proof.publicationId}.json`), JSON.stringify(receipt), {root: store.tempDir, maxBytes: 32768});
  syncDirectory(directory); fence(store, options);
}
function readReceipt(store: ProjectStore, owner: ProjectOutputOwner, assetId: string, options: ProjectOutputOptions): Receipt | null {
  projectOutputOwnerSchema.parse(owner); uuid.parse(assetId); fence(store, options);
  const {directory} = roots(store, options);
  if (!lstatSync(directory, {throwIfNoEntry:false})) return null;
  const raw = readPrivateFile(path.join(directory, `key-${keyFor(owner, assetId)}.json`), {root: store.tempDir, maxBytes: 4096, encoding: 'utf8', allowMissing: true});
  if (raw === null) return null;
  let index: ProjectOutputPublicationIndex;
  try {index = indexSchema.parse(JSON.parse(String(raw)));} catch {invalid();}
  if (index.projectId !== store.projectId || index.assetId !== assetId || !sameOwner(index.owner, owner)) conflict();
  const saved = readPrivateFile(path.join(directory, `${index.publicationId}.json`), {root: store.tempDir, maxBytes: 32768, encoding: 'utf8', allowMissing: true});
  if (saved === null) return null;
  let receipt: Receipt;
  try {receipt = receiptSchema.parse(JSON.parse(String(saved)));} catch {invalid();}
  if (receipt.proof.publicationId !== index.publicationId || receipt.proof.projectId !== store.projectId || receipt.proof.assetId !== assetId || !sameOwner(receipt.proof.owner, owner)) conflict();
  return receipt;
}
function safeName(value: string): string {
  let name = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/[. ]+$/gu, '').trim();
  let bounded = ''; for (const character of name) {if (Buffer.byteLength(bounded + character) > 80) break; bounded += character;}
  name = bounded || 'output'; if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `_${name}`;
  return name;
}
function outputPath(input: Pick<ProjectOutputInput, 'targetKind' | 'owner' | 'displayName' | 'mimeType'>, publicationId: string, attempt: number): string {
  const extension = extensions[input.mimeType]; if (!extension) invalid();
  const name = input.displayName ? safeName(input.displayName) : input.owner.kind;
  return `${PROJECT_OUTPUT_FOLDERS[input.targetKind]}/${name}-${input.owner.id}-${publicationId}-${attempt}.${extension}`;
}
function ordinaryDirectory(store: ProjectStore, targetKind: ProjectOutputInput['targetKind'], options: ProjectOutputOptions, create: boolean): {directory: string; identity: OutputFileIdentity} {
  fence(store, options); const directory = path.join(store.projectDir, PROJECT_OUTPUT_FOLDERS[targetKind]);
  if (create) {try {mkdirSync(directory, {mode: 0o755});} catch (error) {if (!record(error) || error.code !== 'EEXIST') throw error;} fence(store, options);}
  const info = lstatSync(directory, {bigint: true});
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) invalid();
  if (create) {syncDirectory(store.projectDir); syncDirectory(directory);}
  return {directory, identity: outputFileIdentity(info)};
}
function checkReceiptDirectories(store: ProjectStore, receipt: Receipt, options: ProjectOutputOptions): void {
  fence(store, options);
  if (!sameOutputIdentity(receipt.rootIdentity, assertProjectOutputStore(store)) ||
      !sameOutputIdentity(receipt.directoryIdentity, ordinaryDirectory(store, receipt.proof.targetKind, options, false).identity)) invalid();
}
function stagePath(store: ProjectStore, receipt: Pick<Receipt, 'stageRelativePath'>): string {
  const relative = receipt.stageRelativePath;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).some(part => !part || part === '.' || part === '..')) invalid();
  return path.join(store.tempDir, relative);
}
function fileMetadata(file: string, check: () => void): BigIntStats {
  check(); const info = lstatSync(file, {bigint: true});
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(file) !== file ||
      isProjectFileHeld(outputFileIdentity(info)) || isAppLibraryHeld(outputFileIdentity(info))) invalid();
  return info;
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return sameOutputIdentity(outputFileIdentity(a), outputFileIdentity(b)) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function hashFile(file: string, expected: {sha256: string; sizeBytes: number}, check: () => void, expectedIdentity?: OutputFileIdentity): Promise<BigIntStats> {
  const before = fileMetadata(file, check);
  if (Number(before.size) !== expected.sizeBytes || expectedIdentity && !sameOutputIdentity(expectedIdentity, outputFileIdentity(before))) throw new BytesMismatch();
  check(); const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check(); const opened = await handle.stat({bigint: true}); check();
    if (!unchanged(before, opened)) throw new BytesMismatch();
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0;
    while (offset < expected.sizeBytes) {
      if (!unchanged(opened, fileMetadata(file, check))) throw new BytesMismatch();
      check(); const result = await handle.read(buffer, 0, Math.min(buffer.length, expected.sizeBytes - offset), offset); check();
      if (!result.bytesRead) throw new BytesMismatch(); hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
    }
    check(); const after = await handle.stat({bigint: true}); check();
    if (!unchanged(opened, after) || !unchanged(after, fileMetadata(file, check)) || hash.digest('hex') !== expected.sha256) throw new BytesMismatch();
    return after;
  } finally {await handle.close();}
}
export function isPublishedProjectOutput(asset: unknown, expected: PublishedProjectOutputExpectation): boolean {
  if (!record(asset)) return false;
  const parsed = projectOutputPublicationProofSchema.safeParse(asset.publication), reference = mediaReferenceSchema.safeParse(asset.reference);
  if (!parsed.success || !reference.success) return false;
  const proof = parsed.data, owner = expected.owner;
  // Upload publication verifies complete bytes privately. Imported videos keep
  // S1's sampled public reference until revision-checked strong preparation.
  const hashMatches = proof.sha256 === asset.sha256 && proof.sha256 === reference.data.fullSha256 ||
    proof.owner.kind === 'import' && proof.targetKind === 'assets' && proof.mimeType.startsWith('video/') &&
    asset.sha256 === null && reference.data.fullSha256 === null;
  return asset.id === proof.assetId && asset.projectId === proof.projectId && proof.projectId === expected.projectId &&
    (expected.assetId === undefined || proof.assetId === expected.assetId) && proof.owner.kind === owner.kind && proof.owner.id === owner.id &&
    (owner.requestId === undefined || proof.owner.requestId === owner.requestId) && (owner.inputHash === undefined || proof.owner.inputHash === owner.inputHash) &&
    proof.targetKind === expected.targetKind && hashMatches &&
    proof.sizeBytes === asset.sizeBytes && proof.sizeBytes === reference.data.sizeBytes && proof.mimeType === asset.mimeType &&
    (!(expected.requireOriginalLocation??expected.targetKind==='exports')||reference.data.pathForm==='relative'&&reference.data.path===proof.relativePath&&reference.data.volume===null) &&
    (expected.sha256 === undefined || proof.sha256 === expected.sha256) && (expected.sizeBytes === undefined || proof.sizeBytes === expected.sizeBytes) &&
    (expected.mimeType === undefined || proof.mimeType === expected.mimeType);
}
async function verifiedFinal(store: ProjectStore, receipt: Receipt, options: ProjectOutputOptions): Promise<PublishedProjectOutput> {
  const check = (): void => checkReceiptDirectories(store, receipt, options);
  check(); const file = path.join(store.projectDir, receipt.proof.relativePath);
  const identity = receipt.targetIdentity ?? (receipt.mode === 'link' ? receipt.stageIdentity : undefined);
  if (!identity) invalid();
  const hashed=await hashFile(file, receipt.proof, check, identity); check();
  const reference = await referenceForPublishedMedia(store, file, {sha256: receipt.proof.sha256, signal: options.signal, beforeEffect: check}); check();
  const final=fileMetadata(file,check);if(!unchanged(hashed,final))throw new BytesMismatch();
  receipt.finalStats={mtimeNs:String(final.mtimeNs),ctimeNs:String(final.ctimeNs)};
  return {...reference, referenceRevision: 1, relativePath: receipt.proof.relativePath, publication: receipt.proof};
}
/** Short-transaction fence over the exact fully checked final inode. No file
 * bytes are read while SQLite owns the result registration transaction. */
export function assertPublishedProjectOutput(store:ProjectStore,proof:ProjectOutputPublicationProof,options:ProjectOutputOptions={}):void{
  const receipt=readReceipt(store,proof.owner,proof.assetId,options);
  if(!receipt||!receipt.finalStats||!receipt.targetIdentity||!['prepared','registered'].includes(receipt.phase)||JSON.stringify(receipt.proof)!==JSON.stringify(proof))invalid();
  checkReceiptDirectories(store,receipt,options);
  const info=fileMetadata(path.join(store.projectDir,proof.relativePath),()=>checkReceiptDirectories(store,receipt,options));
  if(!sameOutputIdentity(receipt.targetIdentity,outputFileIdentity(info))||Number(info.size)!==proof.sizeBytes||String(info.mtimeNs)!==receipt.finalStats.mtimeNs||String(info.ctimeNs)!==receipt.finalStats.ctimeNs)invalid();
}
export async function inspectProjectOutput(store: ProjectStore, input: {owner: ProjectOutputOwner; assetId: string}, options: ProjectOutputOptions = {}): Promise<PublishedProjectOutput | null> {
  const receipt = readReceipt(store, input.owner, input.assetId, options);
  if (!receipt) return null;
  const file = path.join(store.projectDir, receipt.proof.relativePath);
  checkReceiptDirectories(store, receipt, options);
  if (!lstatSync(file, {throwIfNoEntry: false})) return null;
  try {return await verifiedFinal(store, receipt, options);} catch (error) {if (error instanceof BytesMismatch && receipt.phase !== 'prepared' && receipt.phase !== 'registered') return null; throw error;}
}
export async function readPublishedProjectOutput(store: ProjectStore, input: {owner: ProjectOutputOwner; assetId: string}, options: ProjectOutputOptions & {maxBytes: number}): Promise<Buffer | null> {
  const output = await inspectProjectOutput(store, input, options);
  if (!output) return null;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < output.sizeBytes) invalid();
  const receipt = readReceipt(store, input.owner, input.assetId, options)!;
  const check = (): void => checkReceiptDirectories(store, receipt, options), file = path.join(store.projectDir, output.relativePath);
  const before = fileMetadata(file, check); const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened=await handle.stat({bigint:true});check();if(!unchanged(before,opened))invalid();
    const bytes = Buffer.alloc(output.sizeBytes); let offset = 0;
    while (offset < bytes.length) {check(); if (!unchanged(before, fileMetadata(file, check))) invalid(); const result = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset); check(); if (!result.bytesRead) invalid(); offset += result.bytesRead;}
    const after = await handle.stat({bigint: true}); check();
    if (!unchanged(before, after) || !unchanged(after, fileMetadata(file, check)) || createHash('sha256').update(bytes).digest('hex') !== output.sha256) invalid();
    return bytes;
  } finally {await handle.close();}
}
function nextAttempt(store: ProjectStore, receipt: Receipt, input: ProjectOutputInput, options: ProjectOutputOptions): Receipt {
  if (receipt.attempt >= 16 || receipt.abandoned.length >= 16) throw new AppError('INVALID_MEDIA', '本地产物发布重试已达上限，请检查项目目录', 409);
  const result: Receipt = {...receipt, proof: {...receipt.proof, relativePath: outputPath(input, receipt.proof.publicationId, receipt.attempt + 1)},
    attempt: receipt.attempt + 1, mode: 'link', phase: 'intent', targetIdentity: null, abandoned: [...receipt.abandoned, receipt.proof.relativePath]};
  writeReceipt(store, result, options); return result;
}
async function executePublication(store: ProjectStore, input: ProjectOutputInput, options: ProjectOutputOptions): Promise<PublishedProjectOutput> {
  projectOutputOwnerSchema.parse(input.owner); uuid.parse(input.assetId); if (store.db.isTransaction) throw new TypeError('Output I/O must run outside SQLite transactions');
  fence(store, options);
  let receipt = readReceipt(store, input.owner, input.assetId, options);
  if (receipt) {
    if (receipt.proof.targetKind !== input.targetKind || receipt.proof.sha256 !== input.sha256 || receipt.proof.sizeBytes !== input.sizeBytes || receipt.proof.mimeType !== input.mimeType || input.publicationId && receipt.proof.publicationId !== input.publicationId) conflict();
    checkReceiptDirectories(store, receipt, options);
  } else {
    const stageRelativePath = path.relative(store.tempDir, input.stageFile).split(path.sep).join('/');
    const file = stagePath(store, {stageRelativePath});
    validateManagedDirectory(path.dirname(file),{root:store.tempDir,private:true});
    validateManagedFile(file, {root: store.tempDir, private: true, maxBytes: input.sizeBytes});
    const stage = fileMetadata(file, () => fence(store, options));
    if (stage.nlink !== 1n) invalid();
    const checked=await hashFile(file, input, () => fence(store, options)); fence(store, options);
    const staged=await open(file,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const opened=await staged.stat({bigint:true});fence(store,options);if(!unchanged(checked,opened))invalid();await staged.sync();fence(store,options);if(!unchanged(opened,fileMetadata(file,()=>fence(store,options))))invalid();}finally{await staged.close();}
    syncDirectory(path.dirname(file));fence(store,options);
    const directory = ordinaryDirectory(store, input.targetKind, options, true), privateRoot = roots(store, options, true).directory;
    // The key is durable before intent. A crash between these writes reserves
    // the same publication ID without authorizing any final file.
    const keyFile = path.join(privateRoot, `key-${keyFor(input.owner, input.assetId)}.json`);
    const reserved = readPrivateFile(keyFile, {root: store.tempDir, maxBytes: 4096, encoding: 'utf8', allowMissing: true});
    const index = reserved === null ? {version: 1 as const, projectId: store.projectId, assetId: input.assetId, owner: input.owner, publicationId: input.publicationId ?? randomUUID()} : indexSchema.parse(JSON.parse(String(reserved)));
    if (index.projectId !== store.projectId || index.assetId !== input.assetId || !sameOwner(index.owner, input.owner) || input.publicationId && input.publicationId !== index.publicationId) conflict();
    indexSchema.parse(index);
    writePrivateFileAtomic(keyFile, JSON.stringify(index), {root: store.tempDir, maxBytes: 4096}); syncDirectory(privateRoot); fence(store, options);
    const proof = projectOutputPublicationProofSchema.parse({version: 1, publicationId: index.publicationId, projectId: store.projectId, assetId: input.assetId, owner: input.owner,
      targetKind: input.targetKind, relativePath: outputPath(input, index.publicationId, 1), sha256: input.sha256, sizeBytes: input.sizeBytes, mimeType: input.mimeType});
    receipt = {version: 1, proof, stageRelativePath, stageIdentity: outputFileIdentity(stage), rootIdentity: assertProjectOutputStore(store), directoryIdentity: directory.identity,
      mode: 'link', phase: 'intent', targetIdentity: null, attempt: 1, abandoned: []};
    writeReceipt(store, receipt, options); testHooks.get(store)?.fault?.('after_intent', proof); fence(store, options);
  }
  while (true) {
    const current = receipt, check = (): void => checkReceiptDirectories(store, current, options), file = path.join(store.projectDir, current.proof.relativePath);
    check(); const existing = lstatSync(file, {throwIfNoEntry: false, bigint: true});
    if (existing) {
      const identity = current.targetIdentity ?? (current.mode === 'link' ? current.stageIdentity : null);
      if (identity && sameOutputIdentity(identity, outputFileIdentity(existing))) {
        try {const result = await verifiedFinal(store, current, options); current.targetIdentity = identity; current.phase = current.phase === 'registered' ? 'registered' : 'prepared'; writeReceipt(store, current, options); return result;}
        catch (error) {if (!(error instanceof BytesMismatch) || current.phase === 'prepared' || current.phase === 'registered') throw error;}
      } else if (current.targetIdentity || current.phase === 'prepared' || current.phase === 'registered') invalid();
      receipt = nextAttempt(store, current, input, options); continue;
    }
    if (current.phase === 'registered') invalid();
    const stage = stagePath(store, current);
    validateManagedDirectory(path.dirname(stage),{root:store.tempDir,private:true});
    validateManagedFile(stage, {root: store.tempDir, private: true, maxBytes: current.proof.sizeBytes});
    await hashFile(stage, current.proof, check, current.stageIdentity); check();
    try {
      if (!testHooks.get(store)?.forceCopy) {
        try {
          check(); await link(stage, file); check();
          current.targetIdentity = current.stageIdentity; current.phase = 'prepared';
          writeReceipt(store, current, options);
        } catch (error) {
          if (!record(error) || !['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(String(error.code))) throw error;
          current.mode = 'copy'; writeReceipt(store, current, options);
        }
      } else {current.mode = 'copy'; writeReceipt(store, current, options);}
      if (current.mode === 'copy') {
        check(); const target = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        let source: FileHandle | undefined;
        try {
          testHooks.get(store)?.fault?.('after_target_create', current.proof); check();
          const created = await target.stat({bigint: true}); check();
          current.targetIdentity = outputFileIdentity(created); current.phase = 'copying'; writeReceipt(store, current, options);
          testHooks.get(store)?.fault?.('after_target_identity', current.proof); check();
          source = await open(stage, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); check();
          if (!sameOutputIdentity(current.stageIdentity, outputFileIdentity(await source.stat({bigint: true})))) invalid();
          const buffer = Buffer.alloc(65536); let offset = 0;
          while (offset < current.proof.sizeBytes) {
            check(); if (!sameOutputIdentity(current.stageIdentity, outputFileIdentity(fileMetadata(stage, check)))) invalid();
            const result = await source.read(buffer, 0, Math.min(buffer.length, current.proof.sizeBytes - offset), offset); check(); if (!result.bytesRead) invalid();
            let written = 0; while (written < result.bytesRead) {check(); const output = await target.write(buffer, written, result.bytesRead - written, offset + written); check(); if (!output.bytesWritten) invalid(); written += output.bytesWritten;}
            offset += result.bytesRead; testHooks.get(store)?.fault?.('after_copy_chunk', current.proof); check();
          }
          await target.sync(); check();
        } finally {if (source) await source.close(); await target.close();}
      }
      syncDirectory(path.dirname(file)); check();
      const result = await verifiedFinal(store, current, options); check(); current.phase = 'prepared'; writeReceipt(store, current, options);
      testHooks.get(store)?.fault?.('after_final', current.proof); check(); return result;
    } catch (error) {
      if (record(error) && error.code === 'EEXIST') {receipt = nextAttempt(store, current, input, options); continue;}
      throw error;
    }
  }
}
export async function publishProjectOutput(store: ProjectStore, input: ProjectOutputInput, options: ProjectOutputOptions = {}): Promise<PublishedProjectOutput> {
  try{
  fence(store, options); const key = keyFor(input.owner, input.assetId), running = inFlight.get(store) ?? new Map<string, Promise<PublishedProjectOutput>>(); inFlight.set(store, running);
  const previous = running.get(key), result = previous ? previous.then(() => executePublication(store, input, options)) : executePublication(store, input, options);
  running.set(key, result); void result.finally(() => {if (running.get(key) === result) running.delete(key);}).catch(() => {}); return await result;
  }catch(error){return normalizeOutputIo(error);}
}
export async function markProjectOutputRegistered(store: ProjectStore, proof: ProjectOutputPublicationProof, options: ProjectOutputOptions = {}): Promise<void> {
  fence(store, options); projectOutputPublicationProofSchema.parse(proof);
  const asset: unknown = store.get('assets', proof.assetId);
  if (!isPublishedProjectOutput(asset, {projectId: store.projectId, assetId: proof.assetId, owner: proof.owner, targetKind: proof.targetKind, sha256: proof.sha256, sizeBytes: proof.sizeBytes, mimeType: proof.mimeType}) || !record(asset) || JSON.stringify(asset.publication) !== JSON.stringify(proof)) invalid();
  const receipt = readReceipt(store, proof.owner, proof.assetId, options); if (!receipt || JSON.stringify(receipt.proof) !== JSON.stringify(proof)) invalid();
  await verifiedFinal(store, receipt, options); fence(store, options);
  receipt.phase = 'registered'; writeReceipt(store, receipt, options); testHooks.get(store)?.fault?.('after_registered', proof); fence(store, options);
  const stage = stagePath(store, receipt), info = lstatSync(stage, {throwIfNoEntry: false, bigint: true});
  if (info) {
    const current = fileMetadata(stage, () => checkReceiptDirectories(store, receipt, options));
    if (!sameOutputIdentity(receipt.stageIdentity, outputFileIdentity(current)) || current.nlink < 1n || current.nlink > 2n) invalid();
    await unlink(stage); fence(store, options); syncDirectory(path.dirname(stage));
    // Removing our hard link changes the ordinary final inode's ctime. Pin a
    // newly verified snapshot rather than persisting a known-stale fence.
    await verifiedFinal(store,receipt,options);writeReceipt(store,receipt,options);
  }
}
async function restoreProjectOutputInside(store: ProjectStore, input: {asset: Record<string, unknown>; stageFile: string}, options: ProjectOutputOptions): Promise<PublishedProjectOutput> {
  const proof = projectOutputPublicationProofSchema.parse(input.asset.publication);
  if (!isPublishedProjectOutput(input.asset, {projectId: store.projectId, assetId: proof.assetId, owner: proof.owner, targetKind: 'exports'})) invalid();
  const directory = ordinaryDirectory(store, 'exports', options, false), check = (): void => {
    fence(store, options); if (!sameOutputIdentity(directory.identity, ordinaryDirectory(store, 'exports', options, false).identity)) invalid();
    const current: unknown = store.get('assets', proof.assetId); if (!record(current) || JSON.stringify(current.publication) !== JSON.stringify(proof)||!isPublishedProjectOutput(current,{projectId:store.projectId,assetId:proof.assetId,owner:proof.owner,targetKind:'exports'})) invalid();
  };
  const targetFile = path.join(store.projectDir, proof.relativePath); check();
  if (lstatSync(targetFile, {throwIfNoEntry: false})) throw new AppError('IDEMPOTENCY_CONFLICT', '导出文件已经存在，不能覆盖', 409);
  const relative = path.relative(store.tempDir, input.stageFile).split(path.sep).join('/'), stage = stagePath(store, {stageRelativePath: relative});
  validateManagedDirectory(path.dirname(stage),{root:store.tempDir,private:true});
  validateManagedFile(stage, {root: store.tempDir, private: true, maxBytes: proof.sizeBytes}); const stageInfo=await hashFile(stage, proof, check); check();
  const privateDirectory=roots(store,options,true).directory,restoreFile=path.join(privateDirectory,`restore-${proof.publicationId}.json`);
  const saved=readPrivateFile(restoreFile,{root:store.tempDir,maxBytes:32768,encoding:'utf8',allowMissing:true});
  let previous:Receipt|null=null;if(saved!==null){try{previous=receiptSchema.parse(JSON.parse(String(saved)));}catch{invalid();}if(JSON.stringify(previous.proof)!==JSON.stringify(proof))conflict();}
  if(previous&&previous.attempt>=16)throw new AppError('INVALID_MEDIA','本地恢复重试已达上限，请检查导出目录',409);
  const receipt:Receipt={version:1,proof,stageRelativePath:relative,stageIdentity:outputFileIdentity(stageInfo),rootIdentity:assertProjectOutputStore(store),directoryIdentity:directory.identity,
    mode:'copy',phase:'intent',targetIdentity:null,finalStats:null,attempt:(previous?.attempt??0)+1,abandoned:previous?[...previous.abandoned,previous.proof.relativePath]:[]};
  const writeRestore=():void=>{check();receiptSchema.parse(receipt);writePrivateFileAtomic(restoreFile,JSON.stringify(receipt),{root:store.tempDir,maxBytes:32768});syncDirectory(privateDirectory);check();};
  writeRestore();testHooks.get(store)?.fault?.('after_intent',proof);check();
  // Restoration has one frozen destination. Exclusive copying cannot claim a
  // concurrently recreated file, even if it contains exactly the same bytes.
  const target = await open(targetFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  let source: FileHandle | undefined;
  try {
    testHooks.get(store)?.fault?.('after_target_create',proof);check();
    const created=await target.stat({bigint:true});check();if(!created.isFile()||isProjectFileHeld(outputFileIdentity(created))||isAppLibraryHeld(outputFileIdentity(created)))invalid();
    receipt.targetIdentity=outputFileIdentity(created);receipt.phase='copying';writeRestore();testHooks.get(store)?.fault?.('after_target_identity',proof);check();
    source = await open(stage, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); check();
    const opened=await source.stat({bigint:true});check();if(!unchanged(stageInfo,opened))invalid();
    const ioFence=():void=>{check();if(!unchanged(stageInfo,fileMetadata(stage,check))||!sameOutputIdentity(receipt.targetIdentity!,outputFileIdentity(fileMetadata(targetFile,check))))invalid();};
    const bytes = Buffer.alloc(65536); let offset = 0;
    while (offset < proof.sizeBytes) {
      ioFence(); const read = await source.read(bytes, 0, Math.min(bytes.length, proof.sizeBytes - offset), offset); ioFence(); if (!read.bytesRead) invalid();
      let written = 0; while (written < read.bytesRead) {ioFence(); const result = await target.write(bytes, written, read.bytesRead - written, offset + written); ioFence(); if (!result.bytesWritten) invalid(); written += result.bytesWritten;}
      offset += read.bytesRead;testHooks.get(store)?.fault?.('after_copy_chunk',proof);ioFence();
    }
    const after=await source.stat({bigint:true});ioFence();if(!unchanged(opened,after))invalid();
    await target.sync();ioFence();
  } finally {if (source) await source.close(); await target.close();}
  const hashed=await hashFile(targetFile, proof, check,receipt.targetIdentity!); syncDirectory(directory.directory); check();
  const reference = await referenceForPublishedMedia(store, targetFile, {sha256: proof.sha256, signal: options.signal, beforeEffect: check}); check();
  const final=fileMetadata(targetFile,check);if(!unchanged(hashed,final))invalid();
  receipt.phase='prepared';receipt.finalStats={mtimeNs:String(final.mtimeNs),ctimeNs:String(final.ctimeNs)};writeRestore();testHooks.get(store)?.fault?.('after_final',proof);check();
  if(!unchanged(final,fileMetadata(targetFile,check)))invalid();
  // The explicit missing-file restoration, unlike general publication, is
  // permitted to replace the old inode fact while retaining the frozen proof.
  const original=readReceipt(store,proof.owner,proof.assetId,options);
  if(original&&JSON.stringify(original.proof)===JSON.stringify(proof)){receipt.phase='registered';writeReceipt(store,receipt,options);}
  writeRestore();
  return {...reference, referenceRevision: 1, relativePath: proof.relativePath, publication: proof};
}
export async function restorePublishedProjectOutput(store:ProjectStore,input:{asset:Record<string,unknown>;stageFile:string},options:ProjectOutputOptions={}):Promise<PublishedProjectOutput>{
  try{return await restoreProjectOutputInside(store,input,options);}catch(error){return normalizeOutputIo(error);}
}
