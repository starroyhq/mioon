import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import type {Stats} from 'node:fs';
import {lstat, mkdtemp, open, readdir, realpath, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CheckFailure, command, fail} from './media-environment.ts';

export interface MacDmgEvidence {name: string; sha256: string}
const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

/** Bind the report to the delivered image bytes without putting a runner path in it. */
export async function macDmgEvidence(file: string): Promise<MacDmgEvidence> {
  const name = path.basename(file);
  if (!path.isAbsolute(file) || !/^mioon-[0-9][0-9A-Za-z.+-]*-mac\.dmg$/.test(name)) fail('INVALID_MAC_DMG');
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.size <= 0) fail('INVALID_MAC_DMG');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      if (!sameFile(before, await handle.stat())) fail('DMG_CHANGED_DURING_VERIFICATION');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({autoClose: false})) hash.update(chunk as Buffer);
      if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(file))) fail('DMG_CHANGED_DURING_VERIFICATION');
      return {name, sha256: hash.digest('hex')};
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    fail('INVALID_MAC_DMG');
  }
}

export async function attachMacDmg(file: string): Promise<string> {
  const mount = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-ci-dmg-'));
  try {
    await command('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file], 'DMG_ATTACH_FAILED', {timeout: 120000});
    return mount;
  } catch (error) {
    // Only remove an empty directory when attach failed. Never traverse a volume.
    await rmdir(mount).catch(() => {});
    throw error;
  }
}

export async function detachMacDmg(mount: string): Promise<void> {
  try { await command('hdiutil', ['detach', mount], 'DMG_DETACH_FAILED'); }
  catch { await command('hdiutil', ['detach', '-force', mount], 'DMG_FORCE_DETACH_FAILED'); }
  try { await rmdir(mount); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') fail('DMG_MOUNT_CLEANUP_FAILED');
  }
}

export async function uniqueMacApp(directory: string): Promise<string> {
  const bundles = (await readdir(directory, {withFileTypes: true})).filter(entry => entry.name.endsWith('.app'));
  if (bundles.length !== 1 || !bundles[0].isDirectory()) fail('UNIQUE_MAC_APP_REQUIRED');
  return path.join(directory, bundles[0].name);
}

export async function macBundleExecutable(app: string): Promise<string> {
  const name = (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(app, 'Contents/Info.plist')],
    'PLIST_EXECUTABLE_FAILED')).trim();
  if (!name || name === '.' || name === '..' || /[\/\\\x00-\x1f\x7f]/.test(name)) fail('INVALID_BUNDLE_EXECUTABLE');
  return path.join(app, 'Contents/MacOS', name);
}
