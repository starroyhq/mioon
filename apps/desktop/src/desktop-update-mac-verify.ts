import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants, createWriteStream} from 'node:fs';
import type * as nodeFileSystem from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import electronUpdater from 'electron-updater';
import type {AutoUpdater} from 'electron';
import {createPrivateTemporaryDirectory, validateManagedFile, validatePrivateDirectory} from '../../../packages/contracts/src/private-storage.ts';
import type {DesktopUpdateVerifier} from './desktop-update.ts';
import desktopIdentity from '../identity.ts';

const run = promisify(execFile);
const maxZipBytes = 1024 ** 3;
const maxExpandedBytes = 2 * 1024 ** 3;
const maxEntries = 16_384;
const maxDirectoryBytes = 8 * 1024 ** 2;
const maxEndRecordBytes = 22 + 65_535;
const decode = new TextDecoder('utf-8', {fatal: true});
const invalid = () => new Error('UPDATE_MAC_VERIFY_FAILED');
type ArchiveFileSystem = Pick<typeof nodeFileSystem, 'lstat' | 'mkdir' | 'open' | 'readdir' | 'realpath' | 'rm'>;

class DesktopMacUpdater extends electronUpdater.MacUpdater {
  private readonly squirrel: Pick<AutoUpdater, 'checkForUpdates' | 'once' | 'removeListener'>;

  constructor(squirrel: Pick<AutoUpdater, 'checkForUpdates' | 'once' | 'removeListener'>) {
    super();
    this.squirrel = squirrel;
    // The previous update ZIP is a second cache when differential is enabled.
    // Retain only the library's pending copy that its discard operation owns.
    this.disableDifferentialDownload = true;
  }

  async discardDownload(): Promise<void> {
    await this.downloadedUpdateHelper?.clear();
  }

  get cacheRoot(): string { return this.app.baseCachePath; }

  stageForInstall(): Promise<void> {
    // Starting Squirrel can apply the update on the next launch. The
    // caller reaches this only after consent and project close admission.
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(failed, 180_000);
      const detach = () => {
        clearTimeout(timeout);
        this.squirrel.removeListener('update-downloaded', downloaded);
        this.squirrel.removeListener('update-not-available', failed);
        this.squirrel.removeListener('error', failed);
      };
      function downloaded() { detach(); resolve(); }
      function failed() { detach(); reject(invalid()); }
      this.squirrel.once('update-downloaded', downloaded);
      this.squirrel.once('update-not-available', failed);
      this.squirrel.once('error', failed);
      try { this.squirrel.checkForUpdates(); } catch { failed(); }
    });
  }
}

export function createMacDesktopUpdater(squirrel: Pick<AutoUpdater, 'checkForUpdates' | 'once' | 'removeListener'>) {
  return new DesktopMacUpdater(squirrel);
}

async function readAt(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const {bytesRead} = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw invalid();
  return buffer;
}

async function inspectArchive(zip: string, appName: string, signal: AbortSignal, fileSystem: ArchiveFileSystem): Promise<void> {
  const file = await fileSystem.open(zip, 'r');
  try {
    const {size} = await file.stat();
    const tail = await readAt(file, Math.min(size, maxEndRecordBytes), Math.max(0, size - maxEndRecordBytes));
    let end = tail.length - 22;
    for (; end >= 0; end--) {
      if (tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length) break;
    }
    if (end < 0 || tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) throw invalid();
    const entries = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), start = tail.readUInt32LE(end + 16);
    if (entries < 1 || entries > maxEntries || entries !== tail.readUInt16LE(end + 8) || length > maxDirectoryBytes ||
        start + length !== size - tail.length + end) throw invalid();
    const directory = await readAt(file, length, start);
    const names = new Set<string>();
    let offset = 0, expanded = 0;
    for (let i = 0; i < entries; i++) {
      signal.throwIfAborted();
      if (offset + 46 > length || directory.readUInt32LE(offset) !== 0x02014b50) throw invalid();
      const flags = directory.readUInt16LE(offset + 8), method = directory.readUInt16LE(offset + 10);
      const compressed = directory.readUInt32LE(offset + 20), uncompressed = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28), extra = directory.readUInt16LE(offset + 30), comment = directory.readUInt16LE(offset + 32);
      const mode = directory.readUInt32LE(offset + 38) >>> 16, local = directory.readUInt32LE(offset + 42);
      const nameStart = offset + 46;
      offset = nameStart + nameLength + extra + comment;
      const kind = mode & 0o170000;
      expanded += uncompressed;
      if (offset > length || nameLength === 0 || nameLength > 2048 || flags & 1 || method !== 0 && method !== 8 ||
          kind !== 0 && kind !== 0o100000 && kind !== 0o040000 && kind !== 0o120000 ||
          absoluteBadSize(compressed, uncompressed, expanded) || local + 30 + nameLength + compressed > start) throw invalid();
      const member = directory.subarray(nameStart, nameStart + nameLength);
      const name = decode.decode(member).replace(/\/$/u, '');
      const parts = name.split('/');
      const normalized = name.normalize('NFC').toLowerCase();
      if (parts[0] !== appName || parts.some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f\x7f]/u.test(part)) || names.has(normalized)) throw invalid();
      names.add(normalized);
      // Libarchive reads local headers too. Both ZIP indexes must identify
      // the same file and stay inside the validated data region.
      const header = await readAt(file, 30 + nameLength, local);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== flags ||
          header.readUInt16LE(8) !== method || header.readUInt16LE(26) !== nameLength ||
          !header.subarray(30).equals(member) || local + header.length + header.readUInt16LE(28) + compressed > start) throw invalid();
    }
    if (offset !== length) throw invalid();
  } finally { await file.close(); }
}

function absoluteBadSize(compressed: number, uncompressed: number, expanded: number): boolean {
  return compressed > maxZipBytes || uncompressed > maxExpandedBytes || expanded > maxExpandedBytes;
}

function contained(base: string, file: string): boolean {
  const relative = path.relative(base, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function verifyExtractedTree(app: string, signal: AbortSignal, fileSystem: ArchiveFileSystem): Promise<void> {
  if (!(await fileSystem.lstat(app)).isDirectory()) throw invalid();
  let entries = 0, expanded = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await fileSystem.readdir(directory, {withFileTypes: true})) {
      signal.throwIfAborted();
      if (++entries > maxEntries) throw invalid();
      const file = path.join(directory, entry.name);
      const info = await fileSystem.lstat(file);
      if (info.isDirectory()) await visit(file);
      else if (info.isSymbolicLink()) {
        if (!contained(app, await fileSystem.realpath(file))) throw invalid();
      } else {
        expanded += info.size;
        if (!info.isFile() || info.nlink !== 1 || expanded > maxExpandedBytes) throw invalid();
      }
    }
  }
  await visit(app);
}

async function copyCheckedZip(source: string, zip: string, digest: string, signal: AbortSignal, fileSystem: ArchiveFileSystem, root?: string): Promise<void> {
  const before = validateManagedFile(source, {root});
  if (!before || before.size > maxZipBytes) throw invalid();
  const file = await fileSystem.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat(), hash = createHash('sha512');
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw invalid();
    let total = 0;
    const calculateHash = new Transform({transform(chunk: Buffer, _encoding, result) {
      total += chunk.length;
      if (total > before.size) return result(invalid());
      hash.update(chunk);
      result(null, chunk);
    }});
    await pipeline(file.createReadStream({autoClose: false}), calculateHash, createWriteStream(zip, {flags: 'wx', mode: 0o600}), {signal});
    if (total !== before.size || hash.digest('base64') !== digest) throw invalid();
  } finally { await file.close(); }
}

export function createMacDesktopUpdateVerifier({applicationPath, temporaryDirectory, downloadCacheRoot, fileSystem}: {
  readonly applicationPath: string;
  readonly temporaryDirectory: string;
  readonly downloadCacheRoot?: string;
  readonly fileSystem: ArchiveFileSystem;
}): DesktopUpdateVerifier {
  const bundleName = `${desktopIdentity.identityForChannel('production').executableName}.app`;
  return async (files, offer, signal, expectedSha512) => {
    if (files.length !== 1 || path.basename(files[0]!) !== `mioon-${offer.version}-mac.zip`) throw invalid();
    const scratch = createPrivateTemporaryDirectory(temporaryDirectory, 'mioon-update-');
    const owned = validatePrivateDirectory(scratch);
    try {
      const zip = path.join(scratch, 'update.zip'), tree = path.join(scratch, 'app');
      await copyCheckedZip(files[0]!, zip, expectedSha512, signal, fileSystem, downloadCacheRoot);
      await inspectArchive(zip, bundleName, signal, fileSystem);
      await fileSystem.mkdir(tree, {mode: 0o700});
      const options = {signal, timeout: 120_000, maxBuffer: 1024 ** 2};
      // bsdtar's default extraction rejects writes through symlinks and
      // traversal. Never pass -P, which would disable those path protections.
      await run('/usr/bin/tar', ['-xf', zip, '--no-same-owner', '--no-same-permissions', '--no-acls',
        '--no-xattrs', '--no-fflags', '-C', tree], options);
      const application = path.join(tree, bundleName);
      if ((await fileSystem.readdir(tree)).length !== 1) throw invalid();
      await verifyExtractedTree(application, signal, fileSystem);
      const version = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
        path.join(application, 'Contents', 'Info.plist')], options);
      if (version.stdout.trim() !== offer.version) throw invalid();
      const current = await run('/usr/bin/codesign', ['-d', '-r-', applicationPath], options);
      const requirement = /^designated => (.+)$/mu.exec(current.stdout)?.[1];
      if (!requirement || requirement.length > 4096) throw invalid();
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R=' + requirement, application], options);
    } catch { throw invalid(); }
    finally {
      const current = validatePrivateDirectory(scratch, {allowMissing: true});
      if (current && owned && current.dev === owned.dev && current.ino === owned.ino) await fileSystem.rm(scratch, {recursive: true, force: true});
    }
  };
}
