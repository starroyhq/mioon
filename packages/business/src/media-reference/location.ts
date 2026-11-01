import {execFile} from 'node:child_process';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import nodePath from 'node:path';
import {promisify} from 'node:util';
import {isInsideDirectory, parseLocalPath} from './paths.ts';
import type {PathApi} from './paths.ts';

// Where a project file may be kept (plan 8.2). A `.mioon` is refused on a
// network share, where SQLite's locks are not reliable, and when it is a
// symbolic link itself. In a cloud sync folder, and on a disk without
// permission bits (exFAT and the like), it is allowed with a warning; S6
// shows the second one once. What cannot be told allows it without a
// warning. Media and the files written into the project directory are
// allowed everywhere; reading media only treats a file a sync folder has not
// downloaded as missing (access.ts).

export const CLOUD_SYNC_PROVIDERS = Object.freeze(['icloud', 'dropbox', 'onedrive', 'google-drive', 'box', 'cloud-storage'] as const);
export type CloudSyncProvider = typeof CLOUD_SYNC_PROVIDERS[number];

/** One line of the mount table. */
export interface MountEntry {
  readonly mountPoint: string;
  readonly fileSystem: string;
  readonly network: boolean;
  /** Owners and permission bits are not kept: macOS `noowners`, FAT, exFAT, NTFS. */
  readonly ownersIgnored: boolean;
}
/** What is known about a place; null where it cannot be told. */
export interface LocationFacts {
  readonly fileSystem: string | null;
  readonly network: boolean | null;
  readonly permissionBits: boolean | null;
  readonly cloudSync: CloudSyncProvider | null;
  /** The file itself is a symbolic link. */
  readonly symbolicLink: boolean;
}

const MAC_NO_PERMISSION_BITS: ReadonlySet<string> = new Set(['exfat', 'msdos', 'ntfs']);
const LINUX_NETWORK: ReadonlySet<string> = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', '9p', 'afs', 'ceph', 'glusterfs', 'davfs', 'fuse.sshfs', 'fuse.rclone']);
const LINUX_NO_PERMISSION_BITS: ReadonlySet<string> = new Set(['vfat', 'msdos', 'exfat', 'fat', 'ntfs', 'ntfs3', 'fuseblk']);
const MOUNT_TIMEOUT_MS = 5000;
const MOUNT_OUTPUT_MAX_BYTES = 1024 * 1024;

/** macOS `/sbin/mount`: `<device> on <mount point> (<type>, <flags>…)`. The
 * device ends at the first ` on ` followed by `/`, since a device name may
 * hold ` on `; the type and flags are the last parenthesis, since a mount
 * point may hold one. Without the `local` flag a volume is on the network.
 * `statfs` types are numbered at boot on macOS, so the table is read instead. */
export function parseMacMounts(output: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd(), on = line.indexOf(' on /'), open = line.lastIndexOf(' (');
    if (on < 0 || open <= on || !line.endsWith(')')) continue;
    const [fileSystem = '', ...flags] = line.slice(open + 2, -1).split(',').map(part => part.trim());
    if (fileSystem === '') continue;
    entries.push({mountPoint: line.slice(on + 4, open), fileSystem, network: !flags.includes('local'),
      ownersIgnored: flags.includes('noowners') || MAC_NO_PERMISSION_BITS.has(fileSystem)});
  }
  return entries;
}

/** Linux `/proc/self/mountinfo`: the fifth field is the mount point, with
 * `\040`, `\011`, `\012` and `\134` for space, tab, newline and backslash; the
 * first field after ` - ` is the type. */
export function parseLinuxMountInfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(' '), [fileSystem = ''] = line.slice(separator + 3).split(' ');
    if (fields.length < 6 || fileSystem === '') continue;
    const mountPoint = fields[4].replace(/\\(040|011|012|134)/gu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
    entries.push({mountPoint, fileSystem, network: LINUX_NETWORK.has(fileSystem), ownersIgnored: LINUX_NO_PERMISSION_BITS.has(fileSystem)});
  }
  return entries;
}

/** The entry whose mount point holds `realPath` with the most names; of equal
 * ones the last, since a later mount covers an earlier one. */
export function mountFor(entries: readonly MountEntry[], realPath: string): MountEntry | null {
  let found: MountEntry | null = null, depth = -1;
  for (const entry of entries) {
    const parts = parseLocalPath(entry.mountPoint, nodePath.posix);
    if (parts === null || parts.segments.length < depth || !isInsideDirectory(entry.mountPoint, realPath, nodePath.posix)) continue;
    found = entry;
    depth = parts.segments.length;
  }
  return found;
}

function cloudStorageProvider(name: string): CloudSyncProvider {
  if (name.startsWith('dropbox')) return 'dropbox';
  if (name.startsWith('onedrive')) return 'onedrive';
  if (name.startsWith('googledrive')) return 'google-drive';
  if (name.startsWith('box')) return 'box';
  return 'cloud-storage';
}
/** The sync folder a real path is in, told by where it is below the home
 * folder: macOS `Library/Mobile Documents/` (iCloud) and
 * `Library/CloudStorage/<provider>…`, and the folders the apps create in the
 * home folder (`Dropbox`, `Dropbox (…)`, `Google Drive`, `OneDrive`,
 * `OneDrive - …`, `Box`, and `iCloudDrive` on Windows). macOS syncing Desktop
 * and Documents to iCloud cannot be told from the path. */
export function cloudSyncProviderOf(realPath: string, homeDir: string, pathApi: PathApi = nodePath): CloudSyncProvider | null {
  const home = parseLocalPath(homeDir, pathApi), file = parseLocalPath(realPath, pathApi);
  if (home === null || file === null || !isInsideDirectory(homeDir, realPath, pathApi)) return null;
  const windows = pathApi.sep === '\\';
  // Names are compared without case; Windows ignores it, and on a Mac the apps write them this way.
  const [first = '', second = '', third = ''] = file.segments.slice(home.segments.length).map(name => name.toLowerCase());
  if (first === 'library' && second === 'mobile documents' && !windows) return 'icloud';
  if (first === 'library' && second === 'cloudstorage' && third !== '' && !windows) return cloudStorageProvider(third);
  if (first === 'dropbox' || /^dropbox \(.+\)$/u.test(first)) return 'dropbox';
  if (first === 'google drive') return 'google-drive';
  if (first === 'onedrive' || first.startsWith('onedrive - ')) return 'onedrive';
  if (first === 'box') return 'box';
  if (first === 'iclouddrive' && windows) return 'icloud';
  return null;
}

/** The facts of a real path. On Windows only a UNC share is known to be on
 * the network: whether a drive letter is a mapped network drive, and its file
 * system, take the native module. */
export function locationFactsOf({realPath, symbolicLink, mounts, homeDir, pathApi = nodePath}: {
  readonly realPath: string; readonly symbolicLink: boolean; readonly mounts: readonly MountEntry[] | null; readonly homeDir: string;
  readonly pathApi?: PathApi;
}): LocationFacts {
  const cloudSync = cloudSyncProviderOf(realPath, homeDir, pathApi);
  if (pathApi.sep === '\\') {
    const share = parseLocalPath(realPath, pathApi)?.root.endsWith('\\') === false;
    return {fileSystem: null, network: share ? true : null, permissionBits: null, cloudSync, symbolicLink};
  }
  const mount = mounts === null ? null : mountFor(mounts, realPath);
  if (mount === null) return {fileSystem: null, network: null, permissionBits: null, cloudSync, symbolicLink};
  return {fileSystem: mount.fileSystem, network: mount.network, permissionBits: !mount.ownersIgnored, cloudSync, symbolicLink};
}

async function readSystemMounts(platform: NodeJS.Platform): Promise<readonly MountEntry[] | null> {
  try {
    if (platform === 'darwin') {
      const {stdout} = await promisify(execFile)('/sbin/mount', [], {encoding: 'utf8', timeout: MOUNT_TIMEOUT_MS, maxBuffer: MOUNT_OUTPUT_MAX_BYTES});
      return parseMacMounts(stdout);
    }
    if (platform === 'linux') return parseLinuxMountInfo(await readFile('/proc/self/mountinfo', 'utf8'));
    if (platform === 'win32') return [];
  } catch {
    // An unreadable table tells nothing.
  }
  return null;
}
async function realOrNull(file: string): Promise<string | null> {
  try {
    return await realpath(file);
  } catch {
    return null;
  }
}

/** The facts of a project file's place, which need not exist yet (a new
 * project): lstat of the file itself, the real path of its folder and of the
 * home folder, and the mount table. */
export async function inspectLocation(file: string, {platform = process.platform, homeDir = homedir(), readMounts}: {
  platform?: NodeJS.Platform; homeDir?: string; readMounts?: () => Promise<readonly MountEntry[] | null>;
} = {}): Promise<LocationFacts> {
  const pathApi = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  if (parseLocalPath(file, pathApi) === null) throw new TypeError('The project file must be an absolute path');
  let symbolicLink = false;
  try {
    symbolicLink = (await lstat(file)).isSymbolicLink();
  } catch {
    // Nothing there yet.
  }
  const folder = await realOrNull(pathApi.dirname(file));
  return locationFactsOf({
    realPath: folder === null ? file : pathApi.join(folder, pathApi.basename(file)),
    symbolicLink,
    mounts: await (readMounts ?? (() => readSystemMounts(platform)))(),
    homeDir: await realOrNull(homeDir) ?? homeDir,
    pathApi,
  });
}

export type ProjectFileLocationVerdict =
  | {readonly allowed: true; readonly warnings: readonly ('cloud-sync' | 'no-permission-bits')[]}
  | {readonly allowed: false; readonly reason: 'network' | 'symbolic-link'};
/** Plan 8.2 for a `.mioon`. */
export function projectFileLocationVerdict(facts: LocationFacts): ProjectFileLocationVerdict {
  if (facts.symbolicLink) return {allowed: false, reason: 'symbolic-link'};
  if (facts.network === true) return {allowed: false, reason: 'network'};
  const warnings: ('cloud-sync' | 'no-permission-bits')[] = [];
  if (facts.cloudSync !== null) warnings.push('cloud-sync');
  if (facts.permissionBits === false) warnings.push('no-permission-bits');
  return {allowed: true, warnings};
}
