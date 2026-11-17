import {execFile} from 'node:child_process';
import {lstat, mkdtemp, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

export class MacUpdatePackageFailure extends Error {
  readonly code: string;
  readonly entry: string | undefined;
  constructor(code: string, entry?: string) {
    super(entry ? `${code}: ${JSON.stringify(entry)}` : code);
    this.code = code;
    this.entry = entry;
  }
}
function fail(code: string, entry?: string): never { throw new MacUpdatePackageFailure(code, entry); }
const exec = promisify(execFile);
async function command(tool: string, args: string[], errorCode: string): Promise<string> {
  try {
    const {stdout} = await exec(tool, args, {encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: {LC_ALL: 'C'}});
    return stdout;
  } catch { fail(errorCode); }
}

export async function verifyMacAppPermissions(bundle: string): Promise<void> {
  async function visit(relative: string): Promise<void> {
    const file = path.join(bundle, relative);
    const info = await lstat(file).catch(() => fail('MAC_PACKAGE_ENTRY_UNREADABLE'));
    // Check framework aliases without following them. ShipIt clears the
    // quarantine attribute on the link itself as well as on its target.
    if (!info.isDirectory() && (!relative || !info.isFile() && !info.isSymbolicLink())) fail('MAC_PACKAGE_ENTRY_INVALID');
    if (!(info.mode & 0o200)) fail('MAC_PACKAGE_OWNER_WRITE_MISSING', relative || '.');
    if (info.isDirectory()) {
      const names = await readdir(file).catch(() => fail('MAC_PACKAGE_ENTRY_UNREADABLE'));
      for (const name of names.sort()) await visit(relative ? `${relative}/${name}` : name);
    }
  }
  await visit('');
}

/** Native zip preserves Unix mode metadata for the symlink-capable Mac target.
 * Inspect that metadata before extraction can normalize permissions. */
export function verifyMacZipPermissions(listing: string, appName: string): void {
  const [archive, header, ...entries] = listing.trimEnd().split('\n');
  const count = /^Zip file size: \d+ bytes, number of entries: (\d+)$/.exec(header ?? '')?.[1];
  const totals = /^(\d+) files?, /.exec(entries.pop() ?? '')?.[1];
  if (!archive?.startsWith('Archive: ') || !count || count !== totals || Number(count) !== entries.length || !entries.length) fail('MAC_ZIP_PERMISSION_LIST_INVALID');
  for (const entry of entries) {
    const mode = /^([-dl][rwxStTs-]{9})\s+[\d.]+\s+unx\s+\d+\s+\S+\s+\d+\s+\S+\s+\d{8}\.\d{6}\s+(.+)$/.exec(entry);
    if (!mode) fail('MAC_ZIP_PERMISSION_LIST_INVALID');
    const [, permissions, member] = mode, name = member.replace(/\/$/, '');
    if ((name !== appName && !name.startsWith(`${appName}/`)) || /[\\\x00-\x1f\x7f]/.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..')) fail('MAC_ZIP_PERMISSION_LIST_INVALID');
    if (permissions[2] !== 'w') fail('MAC_PACKAGE_OWNER_WRITE_MISSING', name.slice(appName.length + 1) || '.');
  }
}

export async function withMacUpdateZip<T>(zip: string, appName: string, inspect: (bundle: string) => Promise<T>): Promise<T> {
  verifyMacZipPermissions(await command('/usr/bin/zipinfo', ['-lT', zip], 'MAC_ZIP_PERMISSION_LIST_FAILED'), appName);
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-mac-zip-'));
  try {
    await command('/usr/bin/ditto', ['-x', '-k', zip, root], 'MAC_ZIP_EXTRACT_FAILED');
    return await inspect(path.join(root, appName));
  } finally {await rm(root, {recursive: true, force: true});}
}
