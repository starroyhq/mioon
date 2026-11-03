import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {AppError} from '../../contracts/src/app-error.ts';
import {validateManagedFile, validatePrivateDirectory} from '../../contracts/src/private-storage.ts';
import {projectOutputPublicationIndexSchema, projectOutputPublicationProofSchema, projectOutputPublicationReceiptSchema} from '../../contracts/src/project-output-publication.ts';
import type {ProjectOutputPublicationIndex, ProjectOutputPublicationReceipt} from '../../contracts/src/project-output-publication.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {checkpoint} from './operation-lifecycle.ts';
import {outputFileIdentity, sameOutputIdentity} from './project-output-owner.ts';
import type {OutputFileIdentity} from './project-output-owner.ts';
import {isPublishedProjectOutput} from './project-output-publication.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import type {ProjectUnpublishedMediaOptions, ProjectUnpublishedMediaSnapshot} from './referenced-asset-unpublished.ts';

export const PROJECT_OUTPUT_UNPUBLISHED_LIMITS = Object.freeze({
  publications: 256, directoryEntries: 1024, receiptBytes: 32768, indexBytes: 4096, totalBytes: 1024 * 1024,
});
type Receipt = ProjectOutputPublicationReceipt;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const mainName = new RegExp(`^(${uuid})\\.json$`, 'u'), restoreName = new RegExp(`^restore-(${uuid})\\.json$`, 'u');
const keyName = /^key-([a-f0-9]{64})\.json$/u;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalid(): never {throw new AppError('MEDIA_LIST_PATH_INVALID', '无法安全读取项目素材列表', 400);}
function changed(): never {throw new AppError('MEDIA_CHANGED_DURING_READ', '读取期间项目素材已变化', 409);}
function io<T>(fn: () => T): T {try {return fn();} catch {return invalid();}}
function stat(file: string): BigIntStats | null {return io(() => lstatSync(file, {bigint: true, throwIfNoEntry: false}) ?? null);}
function epoch(info: BigIntStats | null): string | null {
  return info && [info.dev, info.ino, info.birthtimeNs, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.uid, info.gid, info.nlink].join(':');
}
function identityKey(identity: OutputFileIdentity): string {return [identity.dev, identity.ino, identity.birthtimeNs].join(':');}
function unheld(info: BigIntStats): void {
  if (isProjectFileHeld(outputFileIdentity(info)) || isAppLibraryHeld(outputFileIdentity(info))) invalid();
}
function validIdentity(value: OutputFileIdentity): boolean {
  return /^(?:0|[1-9][0-9]{0,39})$/u.test(value.dev) && /^[1-9][0-9]{0,39}$/u.test(value.ino) &&
    /^(?:0|[1-9][0-9]{0,39})$/u.test(value.birthtimeNs);
}
function privatePath(relative: string): boolean {
  // S2's safeName preserves DEL/C1, unlike model-navigable candidate names.
  // Keep producer bookkeeping valid without granting those names to the model.
  // The authoritative proof schema separately fixes two non-escaping segments.
  return !/[\u0000-\u001f<>:"|?*]/u.test(relative);
}
function keyFor(index: ProjectOutputPublicationIndex): string {
  const owner = index.owner;
  return createHash('sha256').update(JSON.stringify([owner.kind, owner.id, owner.requestId, owner.inputHash, index.assetId])).digest('hex');
}

/** Reads only bounded private JSON and filesystem metadata. No publisher,
 * recovery, media reader or media hash participates in discovery. */
export async function readProjectOutputUnpublishedSnapshot(store: ProjectStore,
  options: ProjectUnpublishedMediaOptions): Promise<ProjectUnpublishedMediaSnapshot> {
  if (!isProjectStore(store)) invalid();
  const fence = (): void => {checkpoint(options.signal); options.beforeEffect(); checkpoint(options.signal); if (!isProjectStore(store)) changed();};
  fence();
  const projectId = store.projectId, root = io(() => realpathSync(store.projectDir));
  const rootInfo = stat(root), projectFile = io(() => realpathSync(store.projectFile)), projectInfo = stat(projectFile);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || !projectInfo?.isFile() || projectInfo.isSymbolicLink() || !isProjectFileHeld(outputFileIdentity(projectInfo))) invalid();
  const rootIdentity = outputFileIdentity(rootInfo), projectIdentity = outputFileIdentity(projectInfo);
  const ownerStatement = store.db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM projects WHERE id=?");
  const owner = ownerStatement.get(projectId); let ownerValue: unknown;
  try {ownerValue = typeof owner?.data === 'string' ? JSON.parse(owner.data) as unknown : null;} catch {invalid();}
  if (!owner || owner.id !== projectId || !object(ownerValue) || ownerValue.id !== projectId || typeof owner.data !== 'string') invalid();
  const ownerRaw = owner.data;
  const watched = new Map<string, string | null>(), rows = new Map<string, string | null>(), excluded = new Set<string>();
  const watch = (file: string): BigIntStats | null => {
    const info = stat(file), value = epoch(info);
    if (watched.has(file) && watched.get(file) !== value) changed();
    watched.set(file, value); return info;
  };
  const directory = path.join(store.tempDir, 'publications');
  io(() => validatePrivateDirectory(store.tempDir)); watch(store.tempDir);
  const present = io(() => validatePrivateDirectory(directory, {allowMissing: true}));
  if (Boolean(watch(directory)) !== Boolean(present)) changed();
  const assets = store.db.prepare("SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 32768 THEN data END AS data FROM assets WHERE id=?");
  const assertCurrent = (): void => {
    fence();
    io(() => validatePrivateDirectory(store.tempDir)); io(() => validatePrivateDirectory(directory, {allowMissing: true}));
    const nowRoot = stat(root), nowProject = stat(projectFile);
    if (io(() => realpathSync(store.projectDir)) !== root || io(() => realpathSync(store.projectFile)) !== projectFile ||
      !nowRoot?.isDirectory() || !nowProject?.isFile() || !sameOutputIdentity(rootIdentity, outputFileIdentity(nowRoot)) ||
      !sameOutputIdentity(projectIdentity, outputFileIdentity(nowProject)) || ownerStatement.get(projectId)?.data !== ownerRaw) changed();
    for (const [file, expected] of watched) if (epoch(stat(file)) !== expected) changed();
    for (const [id, expected] of rows) {
      const row = assets.get(id);
      if ((typeof row?.data === 'string' ? row.data : null) !== expected || row && (row.id !== id || row.projectId !== projectId || typeof row.data !== 'string')) changed();
    }
    checkpoint(options.signal); if (!isProjectStore(store)) changed();
  };
  const indexes = new Map<string, ProjectOutputPublicationIndex>(), receipts = new Map<string, Receipt>(), restores = new Map<string, Receipt>();
  const hashes: string[] = []; let bytes = 0;
  await yieldIO(); assertCurrent();
  if (present) {
    const names: string[] = [], listing = io(() => opendirSync(directory));
    try {
      for (;;) {
        fence(); const entry = io(() => listing.readSync()); if (!entry) break;
        if (names.length >= PROJECT_OUTPUT_UNPUBLISHED_LIMITS.directoryEntries || !keyName.test(entry.name) && !mainName.test(entry.name) && !restoreName.test(entry.name)) invalid();
        names.push(entry.name);
      }
    } finally {io(() => listing.closeSync());}
    assertCurrent();
    for (const name of names.sort()) {
      fence();
      const file = path.join(directory, name), info = watch(file), limit = keyName.test(name) ? PROJECT_OUTPUT_UNPUBLISHED_LIMITS.indexBytes : PROJECT_OUTPUT_UNPUBLISHED_LIMITS.receiptBytes;
      if (!info?.isFile() || info.isSymbolicLink() || info.size > BigInt(limit)) invalid();
      unheld(info); io(() => validateManagedFile(file, {root: directory, private: true, maxBytes: limit}));
      bytes += Number(info.size); if (bytes > PROJECT_OUTPUT_UNPUBLISHED_LIMITS.totalBytes) invalid();
      const admitted = stat(file); if (!admitted || epoch(admitted) !== epoch(info)) changed(); unheld(admitted);
      const fd = io(() => openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0))); let raw: Buffer;
      try {
        if (epoch(io(() => fstatSync(fd, {bigint: true}))) !== epoch(info)) changed();
        const read = (): Buffer => {
          const buffer = Buffer.alloc(Number(info.size) + 1); let size = 0;
          for (;;) {
            checkpoint(options.signal); const n = io(() => readSync(fd, buffer, size, buffer.length - size, size)); if (!n) break;
            size += n; if (size > Number(info.size)) changed();
          }
          if (size !== Number(info.size)) changed(); return buffer.subarray(0, size);
        };
        raw = read();
        if (!raw.equals(read()) || epoch(io(() => fstatSync(fd, {bigint: true}))) !== epoch(info) || epoch(stat(file)) !== epoch(info)) changed();
      } finally {io(() => closeSync(fd));}
      let value: unknown; try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)) as unknown;} catch {invalid();}
      const key = keyName.exec(name), main = mainName.exec(name), restore = restoreName.exec(name);
      if (key) {
        const parsed = projectOutputPublicationIndexSchema.safeParse(value); if (!parsed.success || parsed.data.projectId !== projectId || keyFor(parsed.data) !== key[1] || indexes.has(parsed.data.publicationId)) invalid();
        indexes.set(parsed.data.publicationId, parsed.data);
        if (indexes.size > PROJECT_OUTPUT_UNPUBLISHED_LIMITS.publications) invalid();
      } else {
        const parsed = projectOutputPublicationReceiptSchema.safeParse(value);
        if (!parsed.success || parsed.data.proof.projectId !== projectId || parsed.data.proof.publicationId !== (main?.[1] ?? restore?.[1])) invalid();
        const receipt = parsed.data;
        if (!privatePath(receipt.proof.relativePath) || receipt.abandoned.some(relative => !privatePath(relative))) invalid();
        if (![receipt.stageIdentity, receipt.rootIdentity, receipt.directoryIdentity, ...(receipt.targetIdentity ? [receipt.targetIdentity] : [])].every(validIdentity) ||
          path.isAbsolute(receipt.stageRelativePath) || /[\\\0]/u.test(receipt.stageRelativePath) || receipt.stageRelativePath.split('/').some(part => !part || part === '.' || part === '..') ||
          receipt.finalStats && ![receipt.finalStats.mtimeNs, receipt.finalStats.ctimeNs].every(v => /^(?:0|[1-9][0-9]{0,39})$/u.test(v))) invalid();
        if (receipt.phase === 'registered' && (!receipt.targetIdentity || !receipt.finalStats)) invalid();
        (restore ? restores : receipts).set(receipt.proof.publicationId, receipt);
        if (receipts.size > PROJECT_OUTPUT_UNPUBLISHED_LIMITS.publications || restores.size > PROJECT_OUTPUT_UNPUBLISHED_LIMITS.publications) invalid();
      }
      hashes.push(createHash('sha256').update(raw).digest('hex')); await yieldIO(); assertCurrent();
    }
  }
  function currentAsset(receipt: Receipt): boolean {
    const proof = receipt.proof, row = assets.get(proof.assetId), raw = typeof row?.data === 'string' ? row.data : null;
    rows.set(proof.assetId, raw); if (!row) return false;
    if (row.id !== proof.assetId || row.projectId !== projectId || raw === null) invalid();
    let asset: unknown; try {asset = JSON.parse(raw) as unknown;} catch {invalid();}
    return object(asset) && isDeepStrictEqual(asset.publication, proof) && isPublishedProjectOutput(asset, {projectId, assetId: proof.assetId,
      owner: proof.owner, targetKind: proof.targetKind, sha256: proof.sha256, sizeBytes: proof.sizeBytes, mimeType: proof.mimeType, requireOriginalLocation: true});
  }
  function ordinaryDirectory(receipt: Receipt, requireOriginal: boolean): string {
    const targetDirectory = path.join(root, receipt.proof.relativePath.split('/')[0]!);
    const info = watch(targetDirectory);
    if (info && (!info.isDirectory() || info.isSymbolicLink() || io(() => realpathSync(targetDirectory)) !== targetDirectory)) invalid();
    if (requireOriginal && (!info || !sameOutputIdentity(rootIdentity, receipt.rootIdentity) || !sameOutputIdentity(outputFileIdentity(info), receipt.directoryIdentity))) invalid();
    return targetDirectory;
  }
  function target(receipt: Receipt): BigIntStats | null {
    ordinaryDirectory(receipt, true); const file = path.join(root, receipt.proof.relativePath), info = watch(file);
    if (info && (!info.isFile() || info.isSymbolicLink() || io(() => realpathSync(file)) !== file)) invalid();
    if (info) unheld(info); return info;
  }
  function identity(receipt: Receipt): OutputFileIdentity | null {return receipt.targetIdentity ?? (receipt.mode === 'link' ? receipt.stageIdentity : null);}
  function complete(receipt: Receipt, info: BigIntStats): boolean {
    return receipt.phase === 'prepared' && receipt.targetIdentity !== null && receipt.finalStats != null &&
      sameOutputIdentity(receipt.targetIdentity, outputFileIdentity(info)) && info.size === BigInt(receipt.proof.sizeBytes) &&
      String(info.mtimeNs) === receipt.finalStats.mtimeNs && String(info.ctimeNs) === receipt.finalStats.ctimeNs;
  }
  function partial(receipt: Receipt, info: BigIntStats | null): void {
    const expected = identity(receipt);
    // A missing canonical name does not erase a durable inode proof: the
    // unfinished file may have been moved elsewhere inside the project. A copy
    // without that proof is ambiguous even when its original name is absent.
    if (!expected || info && !sameOutputIdentity(expected, outputFileIdentity(info))) invalid();
    excluded.add(identityKey(expected));
  }
  function abandoned(receipt: Receipt, restoredIdentity?: OutputFileIdentity | null): void {
    for (const relative of receipt.abandoned) {
      if (!projectOutputPublicationProofSchema.safeParse({...receipt.proof, relativePath: relative}).success) invalid();
      ordinaryDirectory(receipt, false);
      const file = path.join(root, relative), info = watch(file);
      if (info && restoredIdentity && relative === receipt.proof.relativePath) {
        if (!info.isFile() || info.isSymbolicLink() || io(() => realpathSync(file)) !== file || !sameOutputIdentity(restoredIdentity, outputFileIdentity(info))) invalid();
        unheld(info); continue;
      }
      if (info) invalid();
    }
  }
  for (const [id, receipt] of receipts) {
    fence();
    const index = indexes.get(id), proof = receipt.proof;
    if (!index || index.assetId !== proof.assetId || !isDeepStrictEqual(index.owner, proof.owner)) invalid();
    const restore = restores.get(id);
    if (!restore && watch(path.join(directory, `restore-${id}.json`))) changed();
    if (restore) {
      if (proof.targetKind !== 'exports' || !isDeepStrictEqual(restore.proof, proof)) invalid();
      if (restore.phase === 'registered') {
        if (receipt.phase !== 'registered' || !restore.targetIdentity || !receipt.targetIdentity || !restore.finalStats || !receipt.finalStats ||
          !sameOutputIdentity(receipt.targetIdentity, restore.targetIdentity) || !isDeepStrictEqual(receipt.finalStats, restore.finalStats)) invalid();
        abandoned(receipt, restore.targetIdentity); abandoned(restore, restore.targetIdentity);
      } else {
        const info = target(restore);
        if (!(info && complete(restore, info) && currentAsset(restore))) partial(restore, info);
        abandoned(receipt, identity(restore)); abandoned(restore, identity(restore));
      }
    } else if (receipt.phase === 'registered') {
      // Terminal history grants no access and excludes nothing. Later edits,
      // relinks, deletion or directory recreation belong to ordinary L1 rules.
      abandoned(receipt);
    } else {
      const info = target(receipt);
      if (!(info && complete(receipt, info) && currentAsset(receipt))) partial(receipt, info);
      abandoned(receipt);
    }
    await yieldIO(); assertCurrent();
  }
  for (const id of restores.keys()) if (!receipts.has(id)) invalid();
  // A valid durable reservation may precede intent creation. It identifies no
  // pathname and therefore neither hides nor guesses a possible user file.
  for (const id of indexes.keys()) if (!receipts.has(id) && watch(path.join(directory, `${id}.json`))) changed();
  assertCurrent();
  const version = createHash('sha256').update(JSON.stringify({projectId, ownerRaw, root: rootIdentity, files: [...watched], rows: [...rows], hashes})).digest('hex');
  return Object.freeze({version, assertCurrent, isExcluded(_file: string, info: BigIntStats): boolean {
    assertCurrent(); return excluded.has(identityKey(outputFileIdentity(info)));
  }});
}
