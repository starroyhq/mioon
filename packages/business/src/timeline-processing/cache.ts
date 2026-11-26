import {randomUUID} from 'node:crypto';
import {lstatSync, readdirSync, renameSync, rmSync, statfsSync, utimesSync} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {createPrivateTemporaryDirectory, ensurePrivateDirectory, privateStorageIdentity, readPrivateFile,
  validateManagedDirectory, validateManagedFile, validatePrivateDirectory, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {projectIdSchema} from '../../../contracts/src/project-file.ts';
import {processingDigestSchema as digest, processingCacheReceiptSchema as receiptSchema, processingProxyResultSchema as proxyResultSchema,
  processingCachePinsSchema as pinSchema, PROCESSING_CACHE_MAX_ENTRIES as maxEntries} from '../../../contracts/src/timeline-processing-storage.ts';
import type {ProcessingCacheReceipt as Receipt} from '../../../contracts/src/timeline-processing-storage.ts';
import type {SpeedProcessingReason} from '../../../contracts/src/timeline-speed.ts';

export const PROCESSING_CACHE_LIMIT_BYTES = 10 * 1024 ** 3;
const manifestName = 'receipt.json';
const manifestLimit = 16384;
const pinLimit = maxEntries * 67 + 3;
const stageName = /^stage-[0-9a-f-]{36}-[a-zA-Z0-9]{6}$/u;

export class ProcessingFailure extends Error {
  readonly code: SpeedProcessingReason;
  constructor(code: SpeedProcessingReason, options?: ErrorOptions) {super(code, options); this.code = code;}
}
export interface ProcessingCacheEntry extends Receipt {
  readonly directory: string;
  readonly usedBytes: number;
}
interface OwnedEntry extends ProcessingCacheEntry {
  readonly complete: boolean;
  readonly identity: string;
  readonly usedAt: number;
}
interface Stage {
  readonly directory: string;
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
    const receipt = receiptSchema.parse(readJson(path.join(directory, manifestName), manifestLimit));
    if (receipt.cacheKey !== cacheKey) occupied();
    const {bytes, complete} = readPayload(directory, receipt.result, true);
    return {...receipt, directory, complete, usedBytes: bytes, identity: identity(info), usedAt: info.mtimeMs};
  }
  function inventory(): {entries: OwnedEntry[]; pins: Set<string>; retainedBytes: number} {
    const names = ensureRoot() ? readdirSync(root) : [];
    if (names.length > maxEntries * 2) occupied();
    const entries: OwnedEntry[] = [], pins = new Set(activePins.keys());
    let retainedBytes = 0;
    for (const name of names) {
      if (digest.safeParse(name).success) {
        const entry = readEntry(name);
        if (entry) entries.push(entry);
      } else if (/^pins-[0-9a-f-]{36}\.json$/u.test(name)) {
        for (const key of pinSchema.parse(readJson(path.join(root, name), pinLimit))) pins.add(key);
      } else if (stageName.test(name) && !reservations.has(name)) {
        // An earlier owner could not prove its writer was gone. Account for
        // the private staging files without taking ownership of them.
        const directory = path.join(root, name);
        validateManagedDirectory(directory, {root, ...privateOptions});
        const files = readdirSync(directory);
        if (files.length > 16) occupied();
        for (const fileName of files) {
          const info = validateManagedFile(path.join(directory, fileName), {root, ...privateOptions});
          if (!info || !Number.isSafeInteger(retainedBytes + info.size)) occupied();
          retainedBytes += info.size;
        }
      }
    }
    return {entries, pins, retainedBytes};
  }
  function remove(entry: OwnedEntry, beforeEffect: () => void): void {
    beforeEffect();
    if (!ensureRoot()) occupied();
    const current = readEntry(entry.cacheKey);
    if (!current || current.identity !== entry.identity || current.projectId !== entry.projectId) occupied();
    rmSync(current.directory, {recursive: true});
  }
  const lookup = (projectId: string, cacheKey: string): ProcessingCacheEntry | null => {
    if (!ensureRoot()) return null;
    try {
      const entry = readEntry(cacheKey);
      return entry?.complete && entry.projectId === projectId ? entry : null;
    } catch { return null; }
  };
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
    const {entries} = inventory();
    return {usedBytes: entries.filter(entry => entry.projectId === projectId).reduce((total, entry) => total + entry.usedBytes, 0), limitBytes};
  }
  function clear(projectId: string, beforeEffect: () => void) {
    const {entries, pins} = inventory();
    let freedBytes = 0;
    for (const entry of entries) if (entry.projectId === projectId && !pins.has(entry.cacheKey)) {
      remove(entry, beforeEffect); freedBytes += entry.usedBytes;
    }
    return {freedBytes};
  }
  function reserve(estimatedBytes: number, beforeEffect: () => void): void {
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 1 || estimatedBytes > limitBytes) occupied();
    const {entries, pins, retainedBytes} = inventory();
    const reserved = [...reservations.values()].reduce((sum, value) => sum + value, 0);
    let used = entries.reduce((sum, entry) => sum + entry.usedBytes, 0) + reserved + retainedBytes;
    const oldest = entries.filter(entry => !pins.has(entry.cacheKey))
      .sort((a, b) => a.usedAt - b.usedAt || a.cacheKey.localeCompare(b.cacheKey));
    // Determine whether the reservation can fit before removing anything.
    const disposable = oldest.reduce((sum, entry) => sum + entry.usedBytes, 0);
    if (used - disposable + estimatedBytes > limitBytes) occupied();
    if (freeBytes(root) + BigInt(disposable) < BigInt(estimatedBytes + reserved)) notEnoughSpace();
    for (const entry of oldest) {
      if (used + estimatedBytes <= limitBytes && freeBytes(root) >= BigInt(estimatedBytes + reserved)) break;
      remove(entry, beforeEffect); used -= entry.usedBytes;
    }
    if (freeBytes(root) < BigInt(estimatedBytes + reserved)) notEnoughSpace();
  }
  function stage(projectId: string, cacheKey: string, estimatedBytes: number, beforeEffect: () => void): Stage {
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
    const ownedIdentity = identity(validateManagedDirectory(directory, {root, ...privateOptions})!);
    const unpin = pin(cacheKey);
    const name = path.basename(directory);
    reservations.set(name, estimatedBytes);
    let settled = false;
    const assertStage = (): void => {
      if (!ensureRoot()) occupied();
      const current = validateManagedDirectory(directory, {root, ...privateOptions});
      if (!current || identity(current) !== ownedIdentity) occupied();
    };
    const settle = (): void => { settled = true; reservations.delete(name); unpin(); };
    function discard(): void {
      if (settled) return;
      try {assertStage(); rmSync(directory, {recursive: true});}
      finally {settle();}
    }
    function publish(value: unknown): ProcessingCacheEntry {
      if (settled) occupied();
      beforeEffect();
      assertStage();
      const result = proxyResultSchema.parse(value);
      const receipt: Receipt = {version: 1, projectId, cacheKey, result};
      const encoded = JSON.stringify(receipt);
      const {bytes, complete} = readPayload(directory, result, false);
      if (!complete || bytes + Buffer.byteLength(encoded) > estimatedBytes) occupied();
      const target = path.join(root, cacheKey);
      if (lstatSync(target, {throwIfNoEntry: false})) occupied();
      writePrivateFileAtomic(path.join(directory, manifestName), encoded, {root, maxBytes: manifestLimit, replace: false});
      beforeEffect();
      assertStage();
      renameSync(directory, target);
      settle();
      return readEntry(cacheKey)!;
    }
    return {directory, publish, discard, retain: settle};
  }
  function touch(entry: ProcessingCacheEntry, beforeEffect: () => void): void {
    beforeEffect();
    const current = lookup(entry.projectId, entry.cacheKey);
    if (!current || current.directory !== entry.directory) occupied();
    const timestamp = new Date();
    utimesSync(current.directory, timestamp, timestamp);
  }
  return {stats, clear, setPins, lookup, pin, stage, touch};
}
export type ProcessingCache = ReturnType<typeof createProcessingCache>;
