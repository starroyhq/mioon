import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, renameSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { canonicalClipLutRecovery, clipLutRecoveryKey, ClipLutRecoveryError, decodeClipLutRecovery,
  parseClipLutRecoveryMetadata, sameClipLutRecovery } from '../../../packages/contracts/src/clip-lut-recovery.ts';
import type { ClipLutRecoveryIdentity, ClipLutRecoveryMetadata } from '../../../packages/contracts/src/clip-lut-recovery.ts';

export const DESKTOP_LUT_RECOVERY_LIMITS = Object.freeze({ records: 128, maxBytes: 264 * 1024 });
const filename = 'lut-import-pending-v1.json';
function fail(code: 'LUT_RECOVERY_UNAVAILABLE' | 'LUT_RECOVERY_CONFLICT' | 'LUT_RECOVERY_CORRUPT'): never {
  throw new ClipLutRecoveryError(code, 'The private LUT recovery record could not be safely accessed; existing evidence has been preserved.');
};
const sameFile = (a: Stats | null, b: Stats | null): boolean => a === null || b === null ? a === b : a.dev === b.dev && a.ino === b.ino;
const canonical = (records: ClipLutRecoveryMetadata[]): string => '{"version":1,"records":[' +
  [...records].sort((a, b) => { const left = clipLutRecoveryKey(a), right = clipLutRecoveryKey(b); return left < right ? -1 : left > right ? 1 : 0; })
    .map(canonicalClipLutRecovery).join(',') + ']}';

export interface DesktopLutRecoveryStore {
  read(identity: ClipLutRecoveryIdentity): ClipLutRecoveryMetadata | null;
  reserve(value: ClipLutRecoveryMetadata): void;
  verify(value: ClipLutRecoveryMetadata): void;
  complete(value: ClipLutRecoveryMetadata): void;
}
interface FileOptions {
  root: string;
  private?: boolean;
  allowMissing?: boolean;
  maxBytes: number;
  replace?: boolean;
}
export interface DesktopLutRecoveryStorage {
  readPrivateFile(file: string, options: FileOptions): Buffer | null;
  removePrivateFile(file: string, options: FileOptions): void;
  validateManagedFile(file: string, options: FileOptions): Stats | null;
  validatePrivateDirectory(directory: string): Stats | null;
  writePrivateFileAtomic(file: string, bytes: string, options: FileOptions): void;
}
interface Options {
  storage: DesktopLutRecoveryStorage;
  userData: string;
  guard: () => void;
  /** Trusted main-process fault-injection seam only. Never accepted over IPC. */
  beforePublish?: () => void;
}

/** Synchronous main-process operations are serialized by the host, whose existing
 * Electron single-instance lock excludes a second app writer. Like private-storage,
 * this protects against other OS users, not arbitrary same-account/root races. */
export function createDesktopLutRecoveryStore({ userData, guard, beforePublish, storage }: Options): DesktopLutRecoveryStore {
  const { readPrivateFile, removePrivateFile, validateManagedFile, validatePrivateDirectory, writePrivateFileAtomic } = storage;
  const file = path.join(userData, filename);
  let rootIdentity: Stats | undefined;
  function rootBoundary(): void {
    const current = validatePrivateDirectory(userData);
    if (!current) fail('LUT_RECOVERY_UNAVAILABLE');
    if (rootIdentity && !sameFile(rootIdentity, current)) fail('LUT_RECOVERY_UNAVAILABLE');
    rootIdentity ??= current;
  }
  function boundary(): void {
    guard();
    rootBoundary();
    guard();
  }
  function access<T>(action: () => T): T {
    try {
      boundary();
      const result = action();
      boundary();
      return result;
    } catch (error) {
      if (error instanceof ClipLutRecoveryError) throw error;
      if ((error as { reason?: string })?.reason === 'SIZE_LIMIT') fail('LUT_RECOVERY_CORRUPT');
      fail('LUT_RECOVERY_UNAVAILABLE');
    }
  }
  const options = { root: userData, private: true, allowMissing: true, maxBytes: DESKTOP_LUT_RECOVERY_LIMITS.maxBytes };
  function snapshot() {
    boundary();
    const identity = validateManagedFile(file, options) as Stats | null;
    const contents = readPrivateFile(file, options) as Buffer | null;
    const raw = contents === null ? null : contents.toString('utf8');
    boundary();
    if (contents !== null && !Buffer.from(raw!, 'utf8').equals(contents)) fail('LUT_RECOVERY_CORRUPT');
    if (!sameFile(identity, validateManagedFile(file, options) as Stats | null)) fail('LUT_RECOVERY_CONFLICT');
    let records: ClipLutRecoveryMetadata[] = [];
    if (raw !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { fail('LUT_RECOVERY_CORRUPT'); }
      const value = parsed as { version?: unknown; records?: unknown } | null;
      if (!value || value.version !== 1 || !Array.isArray(value.records) || value.records.length > DESKTOP_LUT_RECOVERY_LIMITS.records) fail('LUT_RECOVERY_CORRUPT');
      const keys = new Set<string>();
      records = value.records.map(item => {
        const metadata = parseClipLutRecoveryMetadata(item);
        const checked = decodeClipLutRecovery(canonicalClipLutRecovery(metadata), metadata)!;
        const key = clipLutRecoveryKey(checked);
        if (keys.has(key)) fail('LUT_RECOVERY_CORRUPT');
        keys.add(key); return checked;
      });
      if (canonical(records) !== raw) fail('LUT_RECOVERY_CORRUPT');
    }
    return { identity, raw, records };
  }
  function publish(previous: ReturnType<typeof snapshot>, records: ClipLutRecoveryMetadata[]): void {
    if (records.length > DESKTOP_LUT_RECOVERY_LIMITS.records) fail('LUT_RECOVERY_UNAVAILABLE');
    const raw = canonical(records);
    if (Buffer.byteLength(raw) > DESKTOP_LUT_RECOVERY_LIMITS.maxBytes) fail('LUT_RECOVERY_UNAVAILABLE');
    const staging = path.join(userData, `.${filename}.${randomUUID()}.pending`);
    let staged: Stats | null = null;
    let committed = false;
    try {
      boundary();
      writePrivateFileAtomic(staging, raw, { ...options, replace: false });
      rootBoundary();
      staged = validateManagedFile(staging, options) as Stats;
      boundary();
      beforePublish?.();
      boundary();
      const latest = snapshot();
      if (!sameFile(previous.identity, latest.identity) || previous.raw !== latest.raw) fail('LUT_RECOVERY_CONFLICT');
      if (!sameFile(staged, validateManagedFile(staging, options) as Stats | null)) fail('LUT_RECOVERY_CONFLICT');
      boundary();
      renameSync(staging, file);
      committed = true;
      boundary();
      if (!sameFile(staged, validateManagedFile(file, options) as Stats | null)) fail('LUT_RECOVERY_CONFLICT');
      // Best-effort directory durability, matching the private-storage helper.
      let fd: number | undefined;
      try {
        fd = openSync(userData, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!sameFile(rootIdentity!, fstatSync(fd))) fail('LUT_RECOVERY_UNAVAILABLE');
        boundary();
        try { fsyncSync(fd); } catch { /* Some supported filesystems cannot fsync directories. */ }
      }
      finally { if (fd !== undefined) closeSync(fd); }
      if (snapshot().raw !== raw) fail('LUT_RECOVERY_CONFLICT');
    } finally {
      if (!committed && staged) {
        try {
          // Revoking the request does not revoke cleanup of our own private
          // temporary file. Never clean through a replaced root or target.
          rootBoundary();
          if (sameFile(staged, validateManagedFile(staging, options) as Stats | null)) removePrivateFile(staging, options);
          rootBoundary();
        } catch { /* Never clean up through an ambiguous directory or file. */ }
      }
    }
  }
  function checked(value: ClipLutRecoveryMetadata): ClipLutRecoveryMetadata {
    const parsed = parseClipLutRecoveryMetadata(value);
    return decodeClipLutRecovery(canonicalClipLutRecovery(parsed), parsed)!;
  }
  function find(records: ClipLutRecoveryMetadata[], identity: ClipLutRecoveryIdentity) {
    const key = clipLutRecoveryKey(identity);
    return records.find(record => clipLutRecoveryKey(record) === key) ?? null;
  }
  // Pin the existing, prepared userData directory without creating or repairing it.
  try {
    const initial = validatePrivateDirectory(userData);
    if (!initial) fail('LUT_RECOVERY_UNAVAILABLE');
    rootIdentity = initial;
  }
  catch { fail('LUT_RECOVERY_UNAVAILABLE'); }
  return {
    read(identity) { return access(() => find(snapshot().records, identity)); },
    reserve(value) {
      access(() => {
        const record = checked(value), previous = snapshot(), existing = find(previous.records, record);
        if (existing) { if (!sameClipLutRecovery(existing, record)) fail('LUT_RECOVERY_CONFLICT'); return; }
        publish(previous, [...previous.records, record]);
      });
    },
    verify(value) {
      access(() => {
        const record = checked(value), existing = find(snapshot().records, record);
        if (!existing || !sameClipLutRecovery(existing, record)) fail('LUT_RECOVERY_CONFLICT');
      });
    },
    complete(value) {
      access(() => {
        const record = checked(value), previous = snapshot(), existing = find(previous.records, record);
        if (!existing) return;
        if (!sameClipLutRecovery(existing, record)) fail('LUT_RECOVERY_CONFLICT');
        publish(previous, previous.records.filter(item => clipLutRecoveryKey(item) !== clipLutRecoveryKey(record)));
      });
    }
  };
}
