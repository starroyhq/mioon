// Node-only storage policy. Keep this out of the browser/default contracts export.
// The facade dispatches to the POSIX policy or an explicitly composed complete
// Windows backend. The boundary is other ordinary OS users; this account and
// administrators remain trusted, including for SQLite's pathname-only API.
// No chmod/chown, ACL repair or destructive repair is performed here.
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {constants, lstatSync, mkdirSync, mkdtempSync, openSync, fstatSync, readSync, writeFileSync, fsyncSync, closeSync, renameSync, linkSync, unlinkSync, type Stats} from 'node:fs';

const recovery = 'Choose a canonical, private directory owned by your account. Review its permissions and links before retrying; existing data has not been repaired or removed.';
export class PrivateStorageError extends Error {
  declare code: string;
  declare reason: string;
  declare recovery: string;
  constructor(reason: string, message: string, code = 'STORAGE_PRIVATE_REQUIRED') {
    super(message);
    this.name = 'PrivateStorageError';
    this.code = code;
    this.reason = reason;
    this.recovery = code === 'STORAGE_PRIVACY_UNAVAILABLE'
      ? 'Use a supported POSIX local filesystem. Windows storage requires an implemented and natively verified current-user ACL backend.'
      : recovery;
  }
}
function fail(reason: string, message: string): never { throw new PrivateStorageError(reason, message); }
const safe = <T>(fn: () => T): T => {
  try { return fn(); }
  catch (error) {
    if (error instanceof PrivateStorageError) throw error;
    const code = (error as {code?: unknown} | null | undefined)?.code;
    if (code === 'ENOENT') fail('MISSING', 'The private storage directory or file is missing.');
    if (code === 'EEXIST') fail('ALREADY_EXISTS', 'The private storage file already exists; it was not replaced.');
    fail('IO_ERROR', 'Cannot safely access private storage. Check its ownership, permissions and availability.');
  }
};

export interface StoragePrivacyCapability {
  available: boolean;
  backend: 'posix-owner-mode' | 'windows-current-user-acl' | 'unavailable';
  code: 'STORAGE_PRIVACY_UNAVAILABLE' | null;
  reason: 'WINDOWS_ACL_UNIMPLEMENTED' | 'PLATFORM_UNSUPPORTED' | null;
}
/** Informational only: a platform argument can never change operational checks. */
export function getStoragePrivacyCapability(platform: string = process.platform): StoragePrivacyCapability {
  if (platform === 'win32' && process.platform === 'win32' && windowsBackend) return Object.freeze({available:true,backend:'windows-current-user-acl',code:null,reason:null});
  const available = ['linux', 'darwin', 'freebsd', 'openbsd', 'netbsd', 'aix', 'sunos'].includes(platform);
  return Object.freeze({available, backend: available ? 'posix-owner-mode' : 'unavailable',
    code: available ? null : 'STORAGE_PRIVACY_UNAVAILABLE',
    reason: available ? null : platform === 'win32' ? 'WINDOWS_ACL_UNIMPLEMENTED' : 'PLATFORM_UNSUPPORTED'});
}

export interface PrivateStoragePolicyOptions {windowsAclVerifier?: () => unknown}
export interface WalkAncestorsOptions {create?: boolean; allowMissing?: boolean; privateLeaf?: boolean}
export interface PrivateDirectoryOptions {create?: boolean; allowMissing?: boolean}
export interface ManagedDirectoryOptions {root?: string; allowMissing?: boolean; private?: boolean}
export interface ManagedFileOptions {root?: string; allowMissing?: boolean; private?: boolean; maxBytes?: number}
export interface ReadPrivateFileOptions {root?: string; allowMissing?: boolean; maxBytes?: number; private?: boolean; encoding?: BufferEncoding}
export interface WritePrivateFileOptions {root?: string; maxBytes?: number; replace?: boolean}
export interface RemovePrivateFileOptions {root?: string; maxBytes?: number; private?: boolean}

/** Legacy informational Windows readiness seam. An ACL verifier alone cannot
 * enable this POSIX factory: the complete native backend is registered separately.
 * Neither configuration, environment variables nor caller platform strings can
 * turn this release's Windows gate into a successful POSIX-mode assertion. */
export function createPrivateStoragePolicy({windowsAclVerifier}: PrivateStoragePolicyOptions = {}) {
  const platform = process.platform;
  function assertStoragePrivacyAvailable(): void {
    const capability = getStoragePrivacyCapability(platform);
    if (!capability.available || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW) {
      if (platform === 'win32' && typeof windowsAclVerifier === 'function') {
        // This readiness result deliberately cannot authorize file operations.
        try { windowsAclVerifier(); } catch {}
      }
      throw new PrivateStorageError(capability.reason || 'PRIVACY_PRIMITIVES_UNAVAILABLE',
        'Private storage protection is unavailable on this platform.', 'STORAGE_PRIVACY_UNAVAILABLE');
    }
  }
  const absolute = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.includes('\0')) fail('INVALID_PATH', 'A valid private storage path is required.');
    return path.resolve(value);
  };
  const metadata = (file: string): Stats | null => {
    try { return lstatSync(file); }
    catch (error) { if ((error as {code?: unknown} | null | undefined)?.code === 'ENOENT') return null; throw error; }
  };
  const same = (a: Stats | null, b: Stats | null): boolean => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
  const owner = (info: Stats): void => {
    if (info.uid !== process.getuid!()) fail('FOREIGN_OWNER', 'Private storage must be owned by the current account.');
  };
  const directoryType = (info: Stats): void => {
    if (info.isSymbolicLink()) fail('SYMBOLIC_LINK', 'Private storage cannot traverse symbolic links. Select a canonical directory path.');
    if (!info.isDirectory()) fail('DIRECTORY_TYPE', 'Private storage requires a regular directory.');
  };
  const directoryPermissions = (info: Stats, privateMode: boolean): void => {
    directoryType(info); owner(info);
    if (info.mode & (privateMode ? 0o077 : 0o022)) fail('DIRECTORY_PERMISSIONS', privateMode
      ? 'The private storage directory must allow access only to its owner (0700).'
      : 'Managed storage directories must not be writable by other accounts.');
  };
  const ancestor = (info: Stats): void => {
    directoryType(info);
    // Even mode 0755 lets its owner rename children or change permissions.
    if (![0, process.getuid!()].includes(info.uid)) fail('FOREIGN_ANCESTOR', 'Storage ancestors must be owned by the current account or the system administrator.');
    // Ordinary 0755 ancestors are fine. Sticky shared temporary directories are
    // fine only when owned by this account or root; other writable ancestors
    // could let another OS user replace the supposedly private root itself.
    if ((info.mode & 0o022) && !((info.mode & 0o1000) && [0, process.getuid!()].includes(info.uid))) {
      fail('UNSAFE_ANCESTOR', 'A storage ancestor is writable by other accounts without a trusted sticky-directory boundary.');
    }
  };
  function walkAncestors(directory: string, {create = false, allowMissing = false, privateLeaf = true}: WalkAncestorsOptions = {}): Stats | null {
    let current = path.parse(directory).root;
    ancestor(metadata(current)!);
    const parts = directory.slice(current.length).split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let info = metadata(current);
      if (!info) {
        if (!create) {
          if (allowMissing) return null;
          fail('MISSING', 'The private storage directory is missing.');
        }
        // All existing ancestors have been checked before the first mkdir.
        try { mkdirSync(current, {mode: 0o700}); }
        catch (error) { if ((error as {code?: unknown} | null | undefined)?.code !== 'EEXIST') throw error; }
        info = metadata(current);
        directoryPermissions(info!, true);
      }
      if (index === parts.length - 1 && privateLeaf) directoryPermissions(info!, true);
      else ancestor(info!);
    }
    const result = metadata(directory);
    if (privateLeaf) directoryPermissions(result!, true); else ancestor(result!);
    return result;
  }
  function ensurePrivateDirectory(directory: string, {create = false, allowMissing = false}: PrivateDirectoryOptions = {}): Stats | null {
    return safe(() => { assertStoragePrivacyAvailable(); return walkAncestors(absolute(directory), {create, allowMissing}); });
  }
  function validatePrivateDirectory(directory: string, options: PrivateDirectoryOptions = {}): Stats | null {
    return ensurePrivateDirectory(directory, {...options, create: false});
  }
  function createPrivateTemporaryDirectory(parent: string, prefix = 'mioon-private-'): string {
    return safe(() => {
      assertStoragePrivacyAvailable();
      if (typeof prefix !== 'string' || !/^[a-zA-Z0-9.-]{1,80}$/.test(prefix)) fail('INVALID_PATH', 'A safe temporary directory prefix is required.');
      const directory = absolute(parent);
      walkAncestors(directory, {privateLeaf: false});
      const created = mkdtempSync(path.join(directory, prefix));
      validatePrivateDirectory(created);
      return created;
    });
  }
  function managed(file: string, root: string, allowMissing: boolean, includeLeaf: boolean): {target: string; missing: boolean} {
    const target = absolute(file), base = absolute(root);
    const relative = path.relative(base, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('OUTSIDE_ROOT', 'Managed storage must stay inside its private root.');
    if (!validatePrivateDirectory(base, {allowMissing})) return {target, missing: true};
    const parts = relative.split(path.sep).filter(Boolean);
    let current = base;
    for (const part of includeLeaf ? parts : parts.slice(0, -1)) {
      current = path.join(current, part);
      const info = metadata(current);
      if (!info) {
        if (allowMissing) return {target, missing: true};
        fail('MISSING', 'A managed storage directory is missing.');
      }
      directoryPermissions(info, false);
    }
    return {target, missing: false};
  }
  function validateManagedDirectory(directory: string, {root = path.dirname(directory), allowMissing = false, private: privateMode = false}: ManagedDirectoryOptions = {}): Stats | null {
    return safe(() => {
      assertStoragePrivacyAvailable();
      const {target, missing} = managed(directory, root, allowMissing, true);
      if (missing) return null;
      const info = metadata(target); directoryPermissions(info!, privateMode);
      return info;
    });
  }
  const limit = (maxBytes: unknown): void => {
    if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024)) fail('INVALID_LIMIT', 'A safe storage byte limit is required.');
  };
  const fileMetadata = (info: Stats, {private: privateMode = false, maxBytes}: {private?: boolean; maxBytes?: number} = {}): Stats => {
    if (info.isSymbolicLink()) fail('SYMBOLIC_LINK', 'Managed storage files must not be symbolic links.');
    if (!info.isFile()) fail('FILE_TYPE', 'Managed storage requires a regular file.');
    owner(info);
    if (info.nlink !== 1) fail('HARD_LINK', 'Managed storage files must have exactly one filesystem link.');
    if (info.mode & (privateMode ? 0o077 : 0o022)) fail('FILE_PERMISSIONS', privateMode
      ? 'Private storage files must allow access only to their owner (0600).'
      : 'Managed storage files must not be writable by other accounts.');
    if (maxBytes !== undefined && info.size > maxBytes) fail('SIZE_LIMIT', 'The private storage file exceeds its safe size limit.');
    return info;
  };
  function validateManagedFile(file: string, {root = path.dirname(file), allowMissing = false, private: privateMode = false, maxBytes}: ManagedFileOptions = {}): Stats | null {
    return safe(() => {
      assertStoragePrivacyAvailable(); limit(maxBytes);
      const {target, missing} = managed(file, root, allowMissing, false);
      if (missing) return null;
      const info = metadata(target);
      if (!info) {
        if (allowMissing) return null;
        fail('MISSING', 'The private storage file is missing.');
      }
      return fileMetadata(info, {private: privateMode, maxBytes});
    });
  }
  function readPrivateFile(file: string, {root = path.dirname(file), allowMissing = false, maxBytes = 4096, private: privateMode = true, encoding}: ReadPrivateFileOptions = {}): Buffer | string | null {
    return safe(() => {
      const before = validateManagedFile(file, {root, allowMissing, private: privateMode, maxBytes});
      if (!before) return null;
      let fd: number | undefined;
      try {
        // NONBLOCK avoids hanging if a same-user race substitutes a FIFO.
        fd = openSync(absolute(file), constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
        const opened = fileMetadata(fstatSync(fd), {private: privateMode, maxBytes});
        if (!same(before, opened)) fail('FILE_CHANGED', 'The private storage file changed while opening. Retry after checking it.');
        const buffer = Buffer.alloc(maxBytes + 1);
        let size = 0;
        while (size < buffer.length) {
          const count = readSync(fd, buffer, size, buffer.length - size, size);
          if (!count) break;
          size += count;
        }
        if (size > maxBytes) fail('SIZE_LIMIT', 'The private storage file exceeds its safe size limit.');
        fileMetadata(fstatSync(fd), {private: privateMode, maxBytes});
        const after = validateManagedFile(file, {root, private: privateMode, maxBytes});
        if (!same(opened, after)) fail('FILE_CHANGED', 'The private storage file changed while reading. Retry after checking it.');
        const result = buffer.subarray(0, size);
        return encoding ? result.toString(encoding) : result;
      } finally { if (fd !== undefined) closeSync(fd); }
    });
  }
  function writePrivateFileAtomic(file: string, bytes: Buffer | string | Uint8Array, {root = path.dirname(file), maxBytes = 4096, replace = true}: WritePrivateFileOptions = {}): void {
    return safe(() => {
      assertStoragePrivacyAvailable(); limit(maxBytes);
      const contents = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (contents.length > maxBytes) fail('SIZE_LIMIT', 'The private storage file exceeds its safe size limit.');
      const before = validateManagedFile(file, {root, allowMissing: true, private: true, maxBytes});
      // Writers never implicitly create a missing root or managed parent.
      const target = absolute(file), parent = path.dirname(target);
      validateManagedDirectory(parent, {root});
      if (!replace && before) fail('ALREADY_EXISTS', 'The private storage file already exists; it was not replaced.');
      const temporary = path.join(parent, `.${path.basename(target)}.${randomBytes(16).toString('hex')}.tmp`);
      let fd: number | undefined, created: Stats | undefined, committed = false;
      try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = fileMetadata(fstatSync(fd), {private: true, maxBytes});
        writeFileSync(fd, contents); fsyncSync(fd);
        fileMetadata(fstatSync(fd), {private: true, maxBytes});
        closeSync(fd); fd = undefined;
        validateManagedDirectory(parent, {root});
        const staged = validateManagedFile(temporary, {root, private: true, maxBytes});
        if (!same(created, staged)) fail('FILE_CHANGED', 'The private storage temporary file changed before saving. Retry after checking it.');
        const latest = validateManagedFile(target, {root, allowMissing: true, private: true, maxBytes});
        if (before ? !same(before, latest) : latest !== null) fail('FILE_CHANGED', 'The private storage destination changed before saving. Retry after checking it.');
        if (replace) renameSync(temporary, target);
        else linkSync(temporary, target); // Atomic no-clobber publication.
        committed = true;
        if (!replace) { try { if (same(created, metadata(temporary))) unlinkSync(temporary); } catch {} }
        // A successful commit must not be reported as a failed save because a
        // filesystem does not support directory fsync.
        let directoryFd: number | undefined;
        try { directoryFd = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW); fsyncSync(directoryFd); }
        catch {} finally { if (directoryFd !== undefined) { try { closeSync(directoryFd); } catch {} } }
      } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
        if (!committed && created) {
          try { validateManagedDirectory(parent, {root}); if (same(created, metadata(temporary))) unlinkSync(temporary); } catch {}
        }
      }
    });
  }
  function removePrivateFile(file: string, {root = path.dirname(file), maxBytes = 4096, private: privateMode = true}: RemovePrivateFileOptions = {}): void {
    return safe(() => {
      const before = validateManagedFile(file, {root, allowMissing: true, private: privateMode, maxBytes});
      if (!before) return;
      const after = validateManagedFile(file, {root, private: privateMode, maxBytes});
      if (!same(before, after)) fail('FILE_CHANGED', 'The private storage file changed before removal. Retry after checking it.');
      unlinkSync(absolute(file));
    });
  }
  return Object.freeze({assertStoragePrivacyAvailable, ensurePrivateDirectory, validatePrivateDirectory, createPrivateTemporaryDirectory, validateManagedDirectory, validateManagedFile, readPrivateFile, writePrivateFileAtomic, removePrivateFile});
}

export type PrivateStoragePolicy = ReturnType<typeof createPrivateStoragePolicy>;
export interface WindowsManagedFileHandle {
  metadata():Stats;
  read(size:number):Buffer;
  write(bytes:Uint8Array):void;
  flush():void;
  close():void;
}
export interface WindowsManagedDirectoryHandle {metadata():Stats; next():string|null; close():void}
export interface WindowsManagedFileIO {
  openFile(file:string,options:{root:string;private:boolean;maxBytes?:number;mode:'read'|'create'|'flush';expected?:Stats}):WindowsManagedFileHandle;
  createDirectoryNew(directory:string,options:{root?:string}):Stats;
  openDirectory(directory:string,options:{root:string;private:boolean}):WindowsManagedDirectoryHandle;
  syncDirectory(directory:string,options:{root?:string;private:boolean}):void;
  renameNoReplace(source:string,destination:string,options:{root:string;expected:Stats}):Stats;
  removeOwnedFile(file:string,options:{root:string;expected:Stats;maxBytes?:number}):void;
  removeOwnedDirectory(directory:string,options:{root:string;expected:Stats}):void;
}
export interface WindowsPrivateStorageBackend extends PrivateStoragePolicy {readonly apiVersion:1; readonly platform:'win32'; readonly managedFileIO?:WindowsManagedFileIO}
let windowsBackend: WindowsPrivateStorageBackend | undefined;
const windowsIdentities = new WeakMap<object,string>();
/** Trusted Node-host seam. An ACL verifier or caller platform string is never
 * sufficient: every operation must be implemented by the registered backend. */
export function registerWindowsPrivateStorageBackend(backend:WindowsPrivateStorageBackend):void {
  const methods:readonly (keyof PrivateStoragePolicy)[]=['assertStoragePrivacyAvailable','ensurePrivateDirectory','validatePrivateDirectory','createPrivateTemporaryDirectory','validateManagedDirectory','validateManagedFile','readPrivateFile','writePrivateFileAtomic','removePrivateFile'];
  if(process.platform!=='win32'||windowsBackend||backend?.platform!=='win32'||backend.apiVersion!==1||methods.some(name=>typeof backend[name]!=='function'))throw new PrivateStorageError('WINDOWS_BACKEND_INVALID','A complete, single Windows private storage backend is required.','STORAGE_PRIVACY_UNAVAILABLE');
  backend.assertStoragePrivacyAvailable();windowsBackend=Object.freeze(backend);
}
/** Restricted, opaque native leases for the Node-only backup implementation. */
export function getWindowsManagedFileIO():WindowsManagedFileIO {
  const io=process.platform==='win32'?windowsBackend?.managedFileIO:undefined;
  if(!io)throw new PrivateStorageError('WINDOWS_MANAGED_IO_UNAVAILABLE','Windows managed streaming storage is unavailable.','STORAGE_PRIVACY_UNAVAILABLE');
  return io;
}
/** Bind only metadata obtained while the native walk pins and revalidates the
 * same filesystem object throughout the trusted Node metadata callback.
 * No Windows uid/mode or truncated Node dev/ino is used as security evidence. */
export function bindWindowsPrivateStorageIdentity(metadata:object,volume:string,fileId:string):void {
  if(process.platform!=='win32'||! /^[a-f0-9]{16}$/u.test(volume)||! /^[a-f0-9]{32}$/u.test(fileId)||windowsIdentities.has(metadata))throw new PrivateStorageError('FILE_IDENTITY','Invalid full Windows file identity.');
  windowsIdentities.set(metadata,`windows:${volume}:${fileId}`);
}
export function privateStorageIdentity(info:{dev:number|bigint;ino:number|bigint}):string {
  const native=windowsIdentities.get(info);if(native)return native;
  if(process.platform==='win32')throw new PrivateStorageError('FILE_IDENTITY_UNVERIFIED','Windows metadata requires a validated full file identity.');
  return `posix:${String(info.dev)}:${String(info.ino)}`;
}
export function samePrivateStorageIdentity(a:{dev:number|bigint;ino:number|bigint}|null|undefined,b:{dev:number|bigint;ino:number|bigint}|null|undefined):boolean {
  return Boolean(a&&b&&privateStorageIdentity(a)===privateStorageIdentity(b));
}
const posixPolicy=createPrivateStoragePolicy();
const activePolicy=():PrivateStoragePolicy=>process.platform==='win32'&&windowsBackend?windowsBackend:posixPolicy;
// Stable functions also cover importers evaluated before Node-host bootstrap.
// Contracts deliberately never import or discover a native binary themselves.
export const assertStoragePrivacyAvailable:PrivateStoragePolicy['assertStoragePrivacyAvailable']=(...args)=>activePolicy().assertStoragePrivacyAvailable(...args);
export const ensurePrivateDirectory:PrivateStoragePolicy['ensurePrivateDirectory']=(...args)=>activePolicy().ensurePrivateDirectory(...args);
export const validatePrivateDirectory:PrivateStoragePolicy['validatePrivateDirectory']=(...args)=>activePolicy().validatePrivateDirectory(...args);
export const createPrivateTemporaryDirectory:PrivateStoragePolicy['createPrivateTemporaryDirectory']=(...args)=>activePolicy().createPrivateTemporaryDirectory(...args);
export const validateManagedDirectory:PrivateStoragePolicy['validateManagedDirectory']=(...args)=>activePolicy().validateManagedDirectory(...args);
export const validateManagedFile:PrivateStoragePolicy['validateManagedFile']=(...args)=>activePolicy().validateManagedFile(...args);
export const readPrivateFile:PrivateStoragePolicy['readPrivateFile']=(...args)=>activePolicy().readPrivateFile(...args);
export const writePrivateFileAtomic:PrivateStoragePolicy['writePrivateFileAtomic']=(...args)=>activePolicy().writePrivateFileAtomic(...args);
export const removePrivateFile:PrivateStoragePolicy['removePrivateFile']=(...args)=>activePolicy().removePrivateFile(...args);
