import {closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync} from 'node:fs';
import path from 'node:path';
import {PROJECT_HISTORY_FILE} from '../../../contracts/src/project-file.ts';

// Rollback journals and super-journals, read with fs. SQLite locks database
// files, never journals, so reading these does not drop any lock. Formats as
// in SQLite's pager.c (hasHotJournal, writeSuperJournal, readSuperJournal).

/** The first 8 bytes of a journal header and the last 8 bytes of a journal
 * that names a super-journal. */
const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
/** A longer super-journal name is not one SQLite wrote (its mxPathname is 512
 * on POSIX and 1040 on Windows). */
const MAX_NAME_BYTES = 4096;

/** SQLite names the super-journal of a commit that spans attached databases
 * `<main database>-mj` + 6 hex digits + `9` + 2 hex digits. The local records
 * are the main database, so a project's super-journals sit beside history.db. */
const SUPER_JOURNAL_NAME = new RegExp(`^${PROJECT_HISTORY_FILE.replace(/[.]/g, '\\.')}-mj[0-9A-F]{6}9[0-9A-F]{2}$`, 'u');
export const isSuperJournalName = (name: string): boolean => SUPER_JOURNAL_NAME.test(name);

/** The super-journals of the local records in `localDir`, as absolute paths.
 * None when the directory does not exist. */
export function superJournalsIn(localDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(localDir);
  } catch (error) {
    if ((error as {code?: unknown}).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(isSuperJournalName).sort().map(name => path.join(path.resolve(localDir), name));
}

function readAt(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

/** True when `journal` is a regular file whose first byte is not 0: SQLite
 * writes the header magic only after the page records are synced, and it rolls
 * such a journal back unless a process holds the database's lock. A journal
 * cut to 0 bytes after a commit, or one whose header is still zero, is not hot. */
export function isHotJournal(journal: string): boolean {
  const info = lstatSync(journal, {throwIfNoEntry: false});
  if (!info?.isFile() || info.size === 0) return false;
  const fd = openSync(journal, 'r');
  try {
    const first = readAt(fd, 1, 0);
    return first.length === 1 && first[0] !== 0;
  } finally {
    closeSync(fd);
  }
}

/** The super-journal a journal names at its end: the name, its length (4
 * bytes), the sum of its bytes as char (4 bytes) and the journal magic (8
 * bytes), all big-endian. Null when there is none or it does not check out.
 * SQLite sums `char`, which is signed on some platforms and unsigned on
 * others; either sum is accepted. */
export function superJournalNamedBy(journal: string): string | null {
  const fd = openSync(journal, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < 16) return null;
    const tail = readAt(fd, 16, size - 16);
    if (tail.length !== 16 || !tail.subarray(8).equals(JOURNAL_MAGIC)) return null;
    const length = tail.readUInt32BE(0), checksum = tail.readUInt32BE(4);
    if (length === 0 || length > MAX_NAME_BYTES || length > size - 16) return null;
    const name = readAt(fd, length, size - 16 - length);
    if (name.length !== length) return null;
    let unsigned = 0, signed = 0;
    for (const byte of name) {
      unsigned = (unsigned + byte) >>> 0;
      signed = (signed + (byte < 0x80 ? byte : byte - 0x100)) >>> 0;
    }
    return checksum === unsigned || checksum === signed ? name.toString('utf8') : null;
  } finally {
    closeSync(fd);
  }
}

/** The journals a super-journal lists: NUL-terminated paths. */
function journalsListedBy(superJournal: string): string[] {
  return readFileSync(superJournal).toString('utf8').split('\u0000').filter(name => name !== '');
}

const identity = (file: string): string | undefined => {
  const info = statSync(file, {bigint: true, throwIfNoEntry: false});
  return info?.ino ? `${info.dev}:${info.ino}` : undefined;
};
/** `named` (as SQLite wrote it) is the file `superJournal`: the same path, or
 * the same file by device and inode. */
function namesFile(named: string | null, superJournal: string): boolean {
  if (named === null) return false;
  if (named === superJournal) return true;
  const target = identity(superJournal);
  return target !== undefined && path.isAbsolute(named) && identity(named) === target;
}

/** Whether SQLite still needs a super-journal to roll back a crashed commit:
 * at least one journal it lists still exists, is hot, and names this
 * super-journal at its end. Then deleting it would make SQLite take that hot
 * journal as committed. Any other super-journal is never read again, for
 * example one left by a process killed while it wrote the super-journal,
 * before any journal was hot.
 *
 * Only meaningful while no process holds the project: during a commit the
 * super-journal exists before the journals are hot. Reads the super-journal
 * and the journals with fs, never a database file. Throws when they cannot be
 * read; keep the super-journal then. */
export function isSuperJournalInUse(superJournal: string): boolean {
  const file = path.resolve(superJournal);
  for (const journal of journalsListedBy(file)) {
    try {
      if (isHotJournal(journal) && namesFile(superJournalNamedBy(journal), file)) return true;
    } catch (error) {
      const code = (error as {code?: unknown}).code;
      // Gone, or not a file a journal could be: SQLite would find no journal there either.
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') continue;
      throw error;
    }
  }
  return false;
}
