// Super-journals and journals written by hand in SQLite's format (pager.c), for
// the kernel's verdict on whether a super-journal is still in use. The files
// SIGKILL really leaves behind are checked in project-file-crash.test.ts.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isSuperJournalInUse, superJournalsIn} from '../packages/business/src/project-file/index.ts';
import {isHotJournal, isSuperJournalName, superJournalNamedBy} from '../packages/business/src/project-file/journals.ts';

const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-s0a-journals-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

const unsignedSum = (bytes: Buffer): number => bytes.reduce((sum, byte) => (sum + byte) >>> 0, 0);
const signedSum = (bytes: Buffer): number => bytes.reduce((sum, byte) => (sum + (byte < 0x80 ? byte : byte - 0x100)) >>> 0, 0);

interface JournalOptions {
  /** The header magic is written: SQLite synced the page records. */
  readonly hot?: boolean;
  /** The super-journal named at the end, as SQLite writes it before the header. */
  readonly names?: string;
  readonly checksum?: (name: Buffer) => number;
  readonly magicAtEnd?: boolean;
}
/** A rollback journal: a 512-byte header, one page record, and optionally the
 * super-journal record (page number, name, length, checksum, magic). */
function writeJournal(file: string, {hot = true, names, checksum = unsignedSum, magicAtEnd = true}: JournalOptions = {}): string {
  const header = Buffer.alloc(512);
  if (hot) {
    JOURNAL_MAGIC.copy(header, 0);
    header.writeUInt32BE(1, 8);
  }
  const record = Buffer.alloc(4 + 4096 + 4, 0x5a);
  const parts = [header, record];
  if (names !== undefined) {
    const name = Buffer.from(names, 'utf8');
    const tail = Buffer.alloc(16);
    tail.writeUInt32BE(name.length, 0);
    tail.writeUInt32BE(checksum(name), 4);
    if (magicAtEnd) JOURNAL_MAGIC.copy(tail, 8);
    parts.push(Buffer.from([0, 0, 0x40, 0x01]), name, tail);
  }
  writeFileSync(file, Buffer.concat(parts));
  return file;
}
/** A super-journal: the journals of the transaction, each NUL-terminated. */
function writeSuperJournal(file: string, journals: readonly string[]): string {
  writeFileSync(file, journals.map(journal => `${journal}\u0000`).join(''));
  return file;
}

test('super-journals are found by SQLite\'s name for the local records\' super-journal', t => {
  const localDir = scratch(t);
  const names = ['history.db-mj0DA3D190E', 'history.db-mjCAA6C6996', 'history.db-mj0da3d190e', 'history.db-mj0DA3D1A0E',
    'history.db-mj0DA3D190', 'cache.db-mj0DA3D190E', 'project.mioon-mj0DA3D190E', 'history.db', 'history.db-journal', 'xhistory.db-mj0DA3D190E'];
  for (const name of names) writeFileSync(path.join(localDir, name), '');
  assert.deepEqual(names.filter(isSuperJournalName), ['history.db-mj0DA3D190E', 'history.db-mjCAA6C6996']);
  assert.deepEqual(superJournalsIn(localDir), [path.join(localDir, 'history.db-mj0DA3D190E'), path.join(localDir, 'history.db-mjCAA6C6996')]);
  assert.deepEqual(superJournalsIn(path.join(localDir, 'missing')), []);
});

test('a journal is hot when its first byte is not 0', t => {
  const root = scratch(t);
  assert.equal(isHotJournal(writeJournal(path.join(root, 'hot-journal'))), true);
  assert.equal(isHotJournal(writeJournal(path.join(root, 'unsynced-journal'), {hot: false, names: '/x/history.db-mj0DA3D190E'})), false);
  writeFileSync(path.join(root, 'empty-journal'), '');
  assert.equal(isHotJournal(path.join(root, 'empty-journal')), false);
  assert.equal(isHotJournal(path.join(root, 'missing-journal')), false);
  mkdirSync(path.join(root, 'folder-journal'));
  assert.equal(isHotJournal(path.join(root, 'folder-journal')), false);
});

test('the super-journal a journal names at its end, checked like SQLite reads it', t => {
  const root = scratch(t);
  const name = path.join(root, 'records', 'history.db-mj0DA3D190E');
  assert.equal(superJournalNamedBy(writeJournal(path.join(root, 'a'), {names: name})), name);
  assert.equal(superJournalNamedBy(writeJournal(path.join(root, 'b'))), null, 'no super-journal record');
  assert.equal(superJournalNamedBy(writeJournal(path.join(root, 'c'), {names: name, magicAtEnd: false})), null);
  assert.equal(superJournalNamedBy(writeJournal(path.join(root, 'd'), {names: name, checksum: bytes => unsignedSum(bytes) + 1})), null, 'checksum mismatch');
  assert.equal(superJournalNamedBy(writeJournal(path.join(root, 'e'), {names: ''})), null, 'empty name');
  writeFileSync(path.join(root, 'f'), JOURNAL_MAGIC);
  assert.equal(superJournalNamedBy(path.join(root, 'f')), null, 'shorter than the record');
  // SQLite sums the name's bytes as `char`: signed on x86 and Apple arm64, unsigned on Linux arm64.
  const wide = path.join(root, '本机记录', 'history.db-mj0DA3D190E');
  assert.notEqual(signedSum(Buffer.from(wide)), unsignedSum(Buffer.from(wide)));
  assert.equal(superJournalNamedBy(writeJournal(path.join(root, 'g'), {names: wide, checksum: signedSum})), wide);
  assert.equal(superJournalNamedBy(writeJournal(path.join(root, 'h'), {names: wide, checksum: unsignedSum})), wide);
});

test('a super-journal is in use while a journal it lists is hot and names it', t => {
  const root = scratch(t);
  const localDir = path.join(root, 'records'), projectDir = path.join(root, 'Film');
  mkdirSync(localDir);
  mkdirSync(projectDir);
  const historyJournal = path.join(localDir, 'history.db-journal'), projectJournal = path.join(projectDir, 'project.mioon-journal');
  const superJournal = path.join(localDir, 'history.db-mj0DA3D190E');
  writeSuperJournal(superJournal, [historyJournal, projectJournal]);
  const verdict = (): boolean => isSuperJournalInUse(superJournal);

  assert.equal(verdict(), false, 'no journal exists');
  writeJournal(projectJournal, {hot: false});
  writeJournal(historyJournal, {hot: false});
  assert.equal(verdict(), false, 'killed while it was written: neither journal is hot');
  writeJournal(historyJournal, {hot: false, names: superJournal});
  assert.equal(verdict(), false, 'named, but the journal header is still zero');
  writeJournal(historyJournal, {names: superJournal});
  assert.equal(verdict(), true, 'the local records are hot and name it');
  writeJournal(historyJournal, {names: path.join(localDir, 'history.db-mjCAA6C6996')});
  assert.equal(verdict(), false, 'hot, but naming another super-journal');
  writeJournal(historyJournal);
  assert.equal(verdict(), false, 'hot, naming none');
  writeJournal(projectJournal, {names: superJournal});
  assert.equal(verdict(), true, 'the project file is hot and names it');
  rmSync(historyJournal);
  assert.equal(verdict(), true, 'one journal is enough, in any position');
  writeJournal(projectJournal, {names: superJournal, checksum: bytes => unsignedSum(bytes) ^ 1});
  assert.equal(verdict(), false, 'SQLite ignores a name whose checksum does not add up');
  writeFileSync(projectJournal, '');
  assert.equal(verdict(), false, 'cut to 0 bytes after the rollback');
  rmSync(projectJournal);
  assert.equal(verdict(), false);
  writeFileSync(superJournal, '');
  assert.equal(verdict(), false, 'an empty super-journal lists nothing');
});

test('a journal may name the super-journal by another path to the same file', t => {
  const root = scratch(t);
  const localDir = path.join(root, 'records');
  mkdirSync(localDir);
  symlinkSync(localDir, path.join(root, 'records-link'));
  const superJournal = path.join(localDir, 'history.db-mj0DA3D190E');
  const projectJournal = path.join(root, 'project.mioon-journal');
  writeSuperJournal(superJournal, [projectJournal]);
  writeJournal(projectJournal, {names: path.join(root, 'records-link', 'history.db-mj0DA3D190E')});
  assert.equal(isSuperJournalInUse(superJournal), true, 'through a symbolic link');
  linkSync(superJournal, path.join(localDir, 'history.db-mjCAA6C6996'));
  writeJournal(projectJournal, {names: path.join(localDir, 'history.db-mjCAA6C6996')});
  assert.equal(isSuperJournalInUse(superJournal), true, 'through a hard link');
  writeSuperJournal(path.join(localDir, 'history.db-mj0000009FF'), [projectJournal]);
  assert.equal(isSuperJournalInUse(path.join(localDir, 'history.db-mj0000009FF')), false, 'another file');
});
