import {createHash, randomUUID} from 'node:crypto';
import {lstatSync, readdirSync, renameSync, rmSync, statfsSync, utimesSync} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {createPrivateTemporaryDirectory, ensurePrivateDirectory, privateStorageIdentity, readPrivateFile,
  validateManagedDirectory, validateManagedFile, validatePrivateDirectory, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {projectIdSchema} from '../../../contracts/src/project-file.ts';
import {processingDigestSchema as digest, processingCacheReceiptSchema as receiptSchema, processingProxyResultSchema as proxyResultSchema,
  processingCachePinsSchema as pinSchema, PROCESSING_CACHE_MAX_ENTRIES as maxEntries} from '../../../contracts/src/timeline-processing-storage.ts';
import type {ProcessingCacheReceipt as Receipt, ProcessingProxyProfile} from '../../../contracts/src/timeline-processing-storage.ts';
import type {SpeedProcessingReason} from '../../../contracts/src/timeline-speed.ts';
import {sameFile, streamFile} from '../managed-file-io.ts';
import {createProcessingStageJournal, processingStageName} from './cache-stage.ts';
import type {ProcessingStageContext, ProcessingStageWriterTracking} from './cache-stage.ts';

export const PROCESSING_CACHE_LIMIT_BYTES = 10 * 1024 ** 3;
const manifestName = 'receipt.json';
const manifestLimit = 16384;
const clockLimit = 64 * 1024;
const pinLimit = maxEntries * 67 + 3;

export class ProcessingFailure extends Error {
  readonly code: SpeedProcessingReason;
  constructor(code: SpeedProcessingReason, options?: ErrorOptions) {super(code, options); this.code = code;}
}
export interface ProcessingCacheEntry extends Receipt {
  readonly directory: string;
  readonly usedBytes: number;
}
export function processingReceiptDigest({version, projectId, cacheKey, result}: ProcessingCacheEntry): string {
  return createHash('sha256').update(JSON.stringify({version, projectId, cacheKey, result})).digest('hex');
}
export interface ProcessingCacheProof {
  readonly entry: ProcessingCacheEntry;
  readonly digest: string;
  readonly clock: Buffer;
}
export interface ProcessingCacheLease extends ProcessingCacheProof {
  verify(): void;
  release(): void;
}
interface CacheLeaseOptions {
  readonly expectedDigest?: string;
  readonly signal?: AbortSignal;
  readonly beforeEffect?: () => void;
}
interface OwnedEntry extends ProcessingCacheEntry {
  readonly complete: boolean;
  readonly identity: string;
  readonly receiptIdentity: Stats;
  readonly usedAt: number;
}
interface Stage {
  readonly directory: string;
  readonly writer?: ProcessingStageWriterTracking;
  grow(requiredBytes: number): void;
  publish(result: unknown): ProcessingCacheEntry;
  discard(): void;
  /** Keep on-disk evidence when the owned writer cannot be confirmed gone. */
  retain(): void;
}
function occupied(): never { throw new ProcessingFailure('CACHE_LIMIT'); }
const notEnoughSpace = (): never => { throw new ProcessingFailure('DISK_FULL'); };
const privateOptions = {private: true};
const identity = (info: Stats): string => privateStorageIdentity(info);

export function createProcessingCache(parent: string, {limitBytes = PROCESSING_CACHE_LIMIT_BYTES,
  freeBytes = (root: string): bigint => {
    const filesystem = statfsSync(root, {bigint: true}); return filesystem.bavail * filesystem.bsize;
  }}: {limitBytes?: number; freeBytes?: (root: string) => bigint} = {}) {
  if (!path.isAbsolute(parent) || !Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new TypeError('Invalid processing cache');
  const root = path.join(parent, 'timeline-processing');
  const stages = createProcessingStageJournal(root);
  const reservations = new Map<string, number>(), activePins = new Map<string, number>();
  let rootIdentity: string | undefined;
  const ensureRoot = (create = false): boolean => {
    if (rootIdentity === undefined) {
      const present = validatePrivateDirectory(root, {allowMissing: true});
      if (!present && !create) return false;
      const ready = present ?? ensurePrivateDirectory(root, {create: true});
      if (!ready) occupied();
      rootIdentity = identity(ready);
    } else if (identity(validatePrivateDirectory(root)!) !== rootIdentity) occupied();
    return true;
  };
  const readJson = (file: string, maxBytes: number, allowMissing = false): unknown => {
    const bytes = readPrivateFile(file, {root, maxBytes, allowMissing, encoding: 'utf8'});
    return bytes === null ? null : JSON.parse(String(bytes));
  };
  function readPayload(directory: string, result: Receipt['result'], withReceipt: boolean): {bytes: number; complete: boolean} {
    const names = new Set(result.files.map(file => file.fileName as string));
    if (withReceipt) names.add(manifestName);
    const actual = readdirSync(directory);
    if (actual.some(name => !names.has(name))) occupied();
    let bytes = 0, complete = actual.length === names.size;
    for (const {fileName, bytes: expected} of result.files) {
      const info = validateManagedFile(path.join(directory, fileName), {root, allowMissing: true, ...privateOptions});
      if (info?.size !== expected) complete = false;
      bytes += info?.size ?? 0;
      if (!Number.isSafeInteger(bytes)) occupied();
    }
    if (withReceipt) bytes += validateManagedFile(path.join(directory, manifestName), {root, ...privateOptions, maxBytes: manifestLimit})!.size;
    return {bytes, complete};
  }
  function readEntry(cacheKey: string): OwnedEntry | null {
    const directory = path.join(root, digest.parse(cacheKey));
    const info = validateManagedDirectory(directory, {root, allowMissing: true, ...privateOptions});
    if (!info) return null;
    const manifest = path.join(directory, manifestName);
    const receiptIdentity = validateManagedFile(manifest, {root, ...privateOptions, maxBytes: manifestLimit})!;
    const receipt = receiptSchema.parse(readJson(manifest, manifestLimit));
    if (receipt.cacheKey !== cacheKey || !sameFile(receiptIdentity,
      validateManagedFile(manifest, {root, ...privateOptions, maxBytes: manifestLimit}))) occupied();
    const {bytes, complete} = readPayload(directory, receipt.result, true);
    return {...receipt, directory, complete, usedBytes: bytes, identity: identity(info), receiptIdentity, usedAt: info.mtimeMs};
  }
  function inventory() {
    const names = ensureRoot() ? readdirSync(root) : [];
    if (names.length > maxEntries * 2) occupied();
    const entries: OwnedEntry[] = [], pins = new Set(activePins.keys());
    const ownedStages: NonNullable<ReturnType<typeof stages.evidence>>[] = [];
    let retainedBytes = 0, writtenReservedBytes = 0;
    for (const name of names) {
      if (digest.safeParse(name).success) {
        const entry = readEntry(name);
        if (entry) entries.push(entry);
      } else if (/^pins-[0-9a-f-]{36}\.json$/u.test(name)) {
        for (const key of pinSchema.parse(readJson(path.join(root, name), pinLimit))) pins.add(key);
      } else if (processingStageName.test(name)) {
        const stage = stages.contents(name);
        if (!stage) continue;
        const reservation = reservations.get(name);
        if (reservation === undefined) retainedBytes += stage.bytes;
        else writtenReservedBytes += Math.min(reservation, stage.bytes);
        if (!Number.isSafeInteger(retainedBytes + writtenReservedBytes)) occupied();
        const owned = stages.evidence(stage, rootIdentity!);
        if (owned) ownedStages.push(owned);
      }
    }
    return {entries, pins, retainedBytes, writtenReservedBytes, ownedStages};
  }
  function remove(entry: OwnedEntry, beforeEffect: () => void): void {
    beforeEffect();
    if (!ensureRoot()) occupied();
    const current = readEntry(entry.cacheKey);
    if (!current || current.identity !== entry.identity || current.projectId !== entry.projectId) occupied();
    rmSync(current.directory, {recursive: true});
  }
  function lookupEntry(projectId: string, cacheKey: string, expectedProfile?: ProcessingProxyProfile): OwnedEntry | null {
    if (!ensureRoot()) return null;
    try {
      const entry = readEntry(cacheKey);
      return entry?.complete && entry.projectId === projectId &&
        (expectedProfile === undefined || entry.result.profileId === expectedProfile) ? entry : null;
    } catch { return null; }
  }
  const lookup = (projectId: string, cacheKey: string, expectedProfile?: ProcessingProxyProfile): ProcessingCacheEntry | null =>
    lookupEntry(projectId, cacheKey, expectedProfile);
  const pin = (cacheKey: string): (() => void) => {
    digest.parse(cacheKey);
    activePins.set(cacheKey, (activePins.get(cacheKey) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (activePins.get(cacheKey) ?? 1) - 1;
      if (remaining > 0) activePins.set(cacheKey, remaining); else activePins.delete(cacheKey);
    };
  };
  const changed = () => new ProcessingFailure('PROCESSING_FAILED');
  function checkEntry(entry: OwnedEntry): void {
    if (!ensureRoot()) throw changed();
    const directory = validateManagedDirectory(entry.directory, {root, ...privateOptions});
    if (!directory || identity(directory) !== entry.identity || !sameFile(entry.receiptIdentity,
      validateManagedFile(path.join(entry.directory, manifestName), {root, ...privateOptions, maxBytes: manifestLimit}))) throw changed();
  }
  function readProof(entry: OwnedEntry): ProcessingCacheProof {
    const record = entry.result.files.find(file => file.fileName === 'clock.json');
    if (!record || record.bytes < 1 || record.bytes > clockLimit) throw changed();
    const clock = readPrivateFile(path.join(entry.directory, record.fileName), {root, maxBytes: record.bytes});
    if (!Buffer.isBuffer(clock) || clock.length !== record.bytes || createHash('sha256').update(clock).digest('hex') !== record.sha256) throw changed();
    checkEntry(entry);
    return {entry, digest: processingReceiptDigest(entry), clock};
  }
  /** The clock is bounded and verified, while the remaining payloads are identified
   * only by the receipt here. Use a lease before serving or decoding bytes. */
  function lookupWithClock(projectId: string, cacheKey: string, expectedProfile: ProcessingProxyProfile): ProcessingCacheProof | null {
    try {
      const entry = lookupEntry(projectId, cacheKey, expectedProfile);
      return entry ? readProof(entry) : null;
    } catch { return null; }
  }
  async function acquire(projectId: string, cacheKey: string, expectedProfile: ProcessingProxyProfile,
    {expectedDigest, signal, beforeEffect}: CacheLeaseOptions = {}): Promise<ProcessingCacheLease | null> {
    let authorityFailure: {error: unknown} | undefined;
    const check = (): void => {
      try {signal?.throwIfAborted(); beforeEffect?.(); signal?.throwIfAborted();}
      catch (error) {authorityFailure = {error}; throw error;}
    };
    check();
    let unpin: (() => void) | undefined, acquired = false;
    try {
      const entry = lookupEntry(projectId, cacheKey, expectedProfile);
      if (!entry || entry.usedBytes > limitBytes || expectedDigest !== undefined && processingReceiptDigest(entry) !== expectedDigest) return null;
      const releasePin = pin(cacheKey);
      unpin = releasePin;
      const files = entry.result.files.map(({fileName, bytes, sha256}) => {
        const file = path.join(entry.directory, fileName);
        const info = validateManagedFile(file, {root, ...privateOptions, maxBytes: bytes});
        if (info?.size !== bytes) throw changed();
        return {file, bytes, sha256, info};
      });
      const proof = readProof(entry);
      let released = false;
      const verify = (): void => {
        check();
        try {
          if (released) throw changed();
          checkEntry(entry);
          for (const {file, bytes, info} of files) {
            if (!sameFile(info, validateManagedFile(file, {root, ...privateOptions, maxBytes: bytes}))) throw changed();
          }
        } catch (cause) {throw new ProcessingFailure('PROCESSING_FAILED', {cause});}
      };
      // The pin is already held while the descriptor readers yield. Each reader
      // hashes that exact file generation from start to finish, without buffering media.
      for (const {file, bytes, sha256, info} of files) {
        const media = await streamFile({file, root, expected: info, maxBytes: bytes, ...privateOptions, signal, check});
        if (media.bytes !== bytes || media.sha256 !== sha256) throw changed();
      }
      verify();
      acquired = true;
      return {...proof, verify, release() {
        if (released) return;
        released = true;
        releasePin();
      }};
    } catch {
      if (authorityFailure) throw authorityFailure.error;
      signal?.throwIfAborted();
      return null;
    } finally {if (!acquired) unpin?.();}
  }
  function setPins(projectId: string, keys: readonly string[], beforeEffect: () => void): void {
    beforeEffect();
    if (!ensureRoot(keys.length > 0)) return;
    const file = path.join(root, `pins-${projectIdSchema.parse(projectId)}.json`);
    const next = pinSchema.parse([...new Set(keys)].sort());
    const existing = readJson(file, pinLimit, true);
    if (JSON.stringify(next) === JSON.stringify(existing) || next.length === 0 && existing === null) return;
    writePrivateFileAtomic(file, JSON.stringify(next), {root, maxBytes: pinLimit});
  }
  function stats(projectId: string) {
    const {entries, ownedStages} = inventory();
    const published = entries.filter(entry => entry.projectId === projectId).reduce((total, entry) => total + entry.usedBytes, 0);
    const staging = ownedStages.filter(stage => stage.ownership.projectId === projectId).reduce((total, stage) => total + stage.bytes, 0);
    return {usedBytes: published + staging, limitBytes};
  }
  function reapOwned(projectId: string, beforeEffect: () => void, {ownedStages}: ReturnType<typeof inventory>): number {
    let bytes = 0;
    for (const stage of ownedStages) {
      if (stage.ownership.projectId !== projectId || reservations.has(stage.name)) continue;
      if (!ensureRoot()) occupied();
      bytes += stages.reap(stage, rootIdentity!, beforeEffect);
    }
    return bytes;
  }
  function reap(projectId: string, beforeEffect: () => void) {
    projectIdSchema.parse(projectId);
    return {freedBytes: reapOwned(projectId, beforeEffect, inventory())};
  }
  function clear(projectId: string, beforeEffect: () => void) {
    const snapshot = inventory();
    const {entries, pins} = snapshot;
    let freedBytes = reapOwned(projectId, beforeEffect, snapshot);
    for (const entry of entries) if (entry.projectId === projectId && !pins.has(entry.cacheKey)) {
      remove(entry, beforeEffect); freedBytes += entry.usedBytes;
    }
    return {freedBytes};
  }
  function reserve(estimatedBytes: number, beforeEffect: () => void): void {
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 1 || estimatedBytes > limitBytes) occupied();
    const {entries, pins, retainedBytes, writtenReservedBytes} = inventory();
    const reserved = [...reservations.values()].reduce((sum, value) => sum + value, 0);
    let used = entries.reduce((sum, entry) => sum + entry.usedBytes, 0) + reserved + retainedBytes;
    const oldest = entries.filter(entry => !pins.has(entry.cacheKey))
      .sort((a, b) => a.usedAt - b.usedAt || a.cacheKey.localeCompare(b.cacheKey));
    // Determine whether the reservation can fit before removing anything.
    const disposable = oldest.reduce((sum, entry) => sum + entry.usedBytes, 0);
    if (used - disposable + estimatedBytes > limitBytes) occupied();
    // Existing stage files have already reduced statfs's free space. Only the
    // unspent portion of an active reservation still needs available blocks.
    const needed = BigInt(estimatedBytes + reserved - writtenReservedBytes);
    if (freeBytes(root) + BigInt(disposable) < needed) notEnoughSpace();
    for (const entry of oldest) {
      if (used + estimatedBytes <= limitBytes && freeBytes(root) >= needed) break;
      remove(entry, beforeEffect); used -= entry.usedBytes;
    }
    if (freeBytes(root) < needed) notEnoughSpace();
  }
  function stage(projectId: string, cacheKey: string, estimatedBytes: number, beforeEffect: () => void, context?: ProcessingStageContext): Stage {
    projectIdSchema.parse(projectId); digest.parse(cacheKey);
    beforeEffect();
    ensureRoot(true);
    const previous = readEntry(cacheKey);
    if (previous && !previous.complete && previous.projectId === projectId && !activePins.has(cacheKey)) {
      remove(previous, beforeEffect);
    }
    reserve(estimatedBytes, beforeEffect);
    const token = randomUUID();
    const directory = createPrivateTemporaryDirectory(root, `stage-${token}-`);
    const directoryInfo = validateManagedDirectory(directory, {root, ...privateOptions})!;
    const ownedIdentity = identity(directoryInfo);
    const name = path.basename(directory);
    let settled = false;
    let reservedBytes = estimatedBytes;
    const assertStage = (): void => {
      if (!ensureRoot()) occupied();
      const current = validateManagedDirectory(directory, {root, ...privateOptions});
      if (!current || identity(current) !== ownedIdentity) occupied();
    };
    let ownership: ReturnType<typeof stages.issue> | undefined;
    try {if (context) ownership = stages.issue(name, directoryInfo, rootIdentity!, projectId, cacheKey, context);}
    catch (error) {assertStage(); rmSync(directory, {recursive: true}); throw error;}
    const unpin = pin(cacheKey);
    reservations.set(name, reservedBytes);
    const settle = (): void => { settled = true; reservations.delete(name); unpin(); };
    function grow(requiredBytes: number): void {
      if (settled || !Number.isSafeInteger(requiredBytes) || requiredBytes < 1 || requiredBytes > limitBytes) occupied();
      if (requiredBytes <= reservedBytes) return;
      beforeEffect();
      assertStage();
      reserve(requiredBytes - reservedBytes, beforeEffect);
      reservations.set(name, requiredBytes);
      reservedBytes = requiredBytes;
    }
    function discard(): void {
      if (settled) return;
      try {
        assertStage();
        ownership?.assertIdle();
        rmSync(directory, {recursive: true});
        ownership?.removeMarker();
      }
      finally {settle();}
    }
    function publish(value: unknown): ProcessingCacheEntry {
      if (settled) occupied();
      beforeEffect();
      assertStage();
      ownership?.assertIdle();
      const result = proxyResultSchema.parse(value);
      const receipt: Receipt = {version: 1, projectId, cacheKey, result};
      const encoded = JSON.stringify(receipt);
      const {bytes, complete} = readPayload(directory, result, false);
      if (!complete || bytes + Buffer.byteLength(encoded) > reservedBytes) occupied();
      const target = path.join(root, cacheKey);
      if (lstatSync(target, {throwIfNoEntry: false})) occupied();
      writePrivateFileAtomic(path.join(directory, manifestName), encoded, {root, maxBytes: manifestLimit, replace: false});
      beforeEffect();
      assertStage();
      renameSync(directory, target);
      settle();
      ownership?.removeMarker();
      return readEntry(cacheKey)!;
    }
    return {directory, writer: ownership?.writer, grow, publish, discard, retain: settle};
  }
  function touch(entry: ProcessingCacheEntry, beforeEffect: () => void): void {
    beforeEffect();
    const current = lookup(entry.projectId, entry.cacheKey);
    if (!current || current.directory !== entry.directory) occupied();
    const timestamp = new Date();
    utimesSync(current.directory, timestamp, timestamp);
  }
  function invalidate(entry: ProcessingCacheEntry, beforeEffect: () => void): void {
    if (activePins.has(entry.cacheKey)) occupied();
    const current = readEntry(entry.cacheKey);
    if (!current || current.projectId !== entry.projectId || current.directory !== entry.directory) occupied();
    remove(current, beforeEffect);
  }
  return {stats, reap, clear, setPins, lookup, lookupWithClock, acquire, pin, stage, touch, invalidate};
}
export type ProcessingCache = ReturnType<typeof createProcessingCache>;
