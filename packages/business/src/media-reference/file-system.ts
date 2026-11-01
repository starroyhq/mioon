import {constants} from 'node:fs';
import type {BigIntStats, Dirent} from 'node:fs';
import {lstat, open, opendir, realpath} from 'node:fs/promises';
import nodePath from 'node:path';

// Every file system call of the media reference layer goes through this
// port, so tests can count what was opened. Paths are checked with realpath
// and lstat before anything is opened (access.ts).

/** A descriptor opened read-only. */
export interface MediaFileHandle {
  /** fstat, with bigint fields. */
  stat(): Promise<BigIntStats>;
  /** Reads up to `buffer.length` bytes at `position`; the number read, 0 at the end. */
  read(buffer: Uint8Array, position: number): Promise<number>;
  close(): Promise<void>;
}
export interface MediaDirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
}
export interface MediaFileSystem {
  /** bigint lstat; null when nothing is at the path or a parent is not a directory. Other errors are thrown. */
  lstat(file: string): Promise<BigIntStats | null>;
  /** fs.promises.realpath, which also gives the case the disk has on macOS;
   * null when nothing is at the path, a parent is not a directory or links
   * loop. Other errors, such as EACCES, are thrown. */
  realpath(file: string): Promise<string | null>;
  /** O_RDONLY | O_NOFOLLOW | O_NONBLOCK: a link is never followed and a FIFO
   * never blocks the open. Constants Windows lacks count as 0. */
  open(file: string): Promise<MediaFileHandle>;
  /** At most `limit` entries, or null when the directory cannot be read. */
  readDirectory(directory: string, limit: number): Promise<readonly MediaDirectoryEntry[] | null>;
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const errorCode = (error: unknown): unknown => (error as {code?: unknown} | null | undefined)?.code;
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);

async function kindOf(directory: string, entry: Dirent): Promise<MediaDirectoryEntry['kind']> {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice()) return 'other';
  // The file system reported no type; lstat never follows a link.
  try {
    const info = await lstat(nodePath.join(directory, entry.name));
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other';
  } catch {
    return 'other';
  }
}

export const NODE_MEDIA_FILE_SYSTEM: MediaFileSystem = Object.freeze({
  async lstat(file: string): Promise<BigIntStats | null> {
    try {
      return await lstat(file, {bigint: true});
    } catch (error) {
      if (NOT_THERE.has(errorCode(error) as string)) return null;
      throw error;
    }
  },
  async realpath(file: string): Promise<string | null> {
    try {
      return await realpath(file);
    } catch (error) {
      if (NOT_THERE.has(errorCode(error) as string) || errorCode(error) === 'ELOOP') return null;
      throw error;
    }
  },
  async open(file: string): Promise<MediaFileHandle> {
    const handle = await open(file, OPEN_FLAGS);
    return {
      stat: () => handle.stat({bigint: true}),
      read: async (buffer, position) => (await handle.read(buffer, 0, buffer.length, position)).bytesRead,
      close: () => handle.close(),
    };
  },
  async readDirectory(directory: string, limit: number): Promise<readonly MediaDirectoryEntry[] | null> {
    const entries: MediaDirectoryEntry[] = [];
    try {
      const listing = await opendir(directory);
      // Leaving the loop early closes the directory.
      for await (const entry of listing) {
        if (entries.length >= limit) break;
        entries.push({name: entry.name, kind: await kindOf(directory, entry)});
      }
    } catch {
      return null;
    }
    return entries;
  },
});
