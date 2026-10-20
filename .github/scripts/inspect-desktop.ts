import {createRequire} from 'node:module';
import {readFile, readdir, readlink, lstat, mkdtemp, realpath, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import desktopIdentity from '../../apps/desktop/identity.ts';
import {verifySubtitleResources} from '../../apps/desktop/subtitle-resources.ts';
import {argumentsFor, CheckFailure, command, fail, isMain, report, safeFailure, targetArch, targetPlatform} from './media-environment.ts';
import type {TargetArch, TargetPlatform} from './media-environment.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
interface Asar {listPackage(file: string): string[]; statFile(file: string, entry: string, follow: false): {link?: string; files?: unknown}; extractFile(file: string, entry: string): Buffer}
interface Fuses {getCurrentFuseWire(file: string): Promise<Record<number, number>>; FuseV1Options: Record<string, number>}
interface Inspection {ok: boolean; platform: TargetPlatform; arch: TargetArch; checks: Array<{name: string; ok: boolean}>; phase: string; executable?: string; packagePath?: string; mountPoint?: string; extractRoot?: string; error?: string; cleanupError?: string}
class DesktopInspectionFailure extends CheckFailure {
  readonly inspection: Inspection;
  constructor(inspection: Inspection) { super(inspection.error ?? 'PACKAGE_INSPECTION_FAILED'); this.inspection = inspection; }
}
class MountedInspectionFailure extends CheckFailure {
  readonly mountPoint: string;
  constructor(mountPoint: string) { super('DMG_DETACH_FAILED'); this.mountPoint = mountPoint; }
}
function dependencies(): {asar: Asar; fuses: Fuses} {
  const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder')), libs = createRequire(builder.resolve('app-builder-lib'));
  return {asar: libs('@electron/asar') as Asar, fuses: libs('@electron/fuses') as Fuses};
}
export function validateArchitecture(output: string, platform: TargetPlatform, arch: TargetArch): void {
  if (platform === 'darwin') {
    if (output.trim() !== (arch === 'x64' ? 'x86_64' : 'arm64')) fail('PACKAGE_ARCHITECTURE_MISMATCH');
  } else if (arch !== 'x64' || !/ELF 64-bit.*x86-64/.test(output)) fail('PACKAGE_ARCHITECTURE_MISMATCH');
}
export function verifySigningIdentity(output: string, identity: string | undefined, team: string | undefined): void {
  if (!identity || !/^Developer ID Application: [^\r\n]+$/.test(identity) || !team || !/^[A-Z0-9]{10}$/.test(team)) fail('SIGNING_IDENTITY_REQUIRED');
  const lines = output.split(/\r?\n/);
  if (!lines.includes(`Authority=${identity}`) || !lines.includes(`TeamIdentifier=${team}`) || !/flags=.*\bruntime\b/.test(output)) fail('SIGNING_IDENTITY_MISMATCH');
}
/** GNU tar's literal listing is restricted to the generated package's simple
 * names. Reject ambiguous names and links before allowing extraction at all. */
export function validateTarListing(names: string, verbose: string, artifactBase: string): void {
  if (!/^mioon-[0-9A-Za-z.+-]+-linux-x64$/.test(artifactBase)) fail('INVALID_TARBALL_ROOT');
  const entries = names.trimEnd().split('\n'), details = verbose.trimEnd().split('\n');
  if (!entries.length || entries.length !== details.length) fail('AMBIGUOUS_TARBALL_LISTING');
  const known = new Set<string>(), symlinks = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i].replace(/\/$/, '');
    if (!name || /[\s\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.' || !part) ||
        (name !== artifactBase && !name.startsWith(`${artifactBase}/`)) || known.has(name)) fail('UNSAFE_TARBALL_PATH');
    known.add(name);
    const detail = /^([-dl])[rwxStTs-]{9}\s+\d+\/\d+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(.+)$/.exec(details[i]);
    if (!detail) fail('UNSUPPORTED_TARBALL_ENTRY');
    if (detail[1] === 'l') {
      const prefix = `${entries[i]} -> `;
      if (!detail[2].startsWith(prefix)) fail('AMBIGUOUS_TARBALL_LINK');
      const target = detail[2].slice(prefix.length);
      // Lexical containment alone is insufficient when another archive link
      // changes how a target's parent segments resolve. Flat Electron library
      // links remain supported; upward traversal is deliberately fail-closed.
      if (!target || path.posix.isAbsolute(target) || target.split('/').includes('..') || /[\s\\\x00-\x1f\x7f]/.test(target)) fail('UNSAFE_TARBALL_LINK');
      const resolved = path.posix.resolve('/', path.posix.dirname(name), target);
      if (!resolved.startsWith(`/${artifactBase}/`)) fail('UNSAFE_TARBALL_LINK');
      symlinks.add(name);
    } else if (detail[2] !== entries[i]) fail('AMBIGUOUS_TARBALL_ENTRY');
  }
  for (const name of known) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') { if (symlinks.has(parent)) fail('TARBALL_SYMLINK_PARENT'); parent = path.posix.dirname(parent); }
  }
}
async function treeDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(relative: string): Promise<void> {
    const file = path.join(directory, relative), info = await lstat(file);
    if (info.isSymbolicLink()) hash.update(`link:${relative}\0${await readlink(file)}\0`);
    else if (info.isDirectory()) { hash.update(`dir:${relative}\0`); for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name)); }
    else if (info.isFile()) hash.update(`file:${relative}\0${createHash('sha256').update(await readFile(file)).digest('hex')}\0${info.mode & 0o7777}\0`);
    else fail('UNEXPECTED_PACKAGE_FILE');
  }
  await visit(''); return hash.digest('hex');
}
async function inspectAsar(resources: string): Promise<void> {
  const {asar} = dependencies(), archive = path.join(resources, 'app.asar'), files = asar.listPackage(archive);
  if (files.length < 10) fail('ASAR_CONTENT_MISSING');
  const allowed = new Set(['main.cjs', 'backend.cjs', 'preload.cjs', 'package.json', 'web', 'licenses', 'icons']);
  for (const raw of files) {
    const entry = raw.replace(/^\//, '');
    if (!allowed.has(entry.split('/')[0]) || entry.split('/').some(part => part === '..' || part === '.') || /(?:^|\/)(?:data|workspace|media|\.env|access-token|mcp-token|mcp-connection\.json|workbench\.sqlite)(?:\/|$)/.test(entry)) fail('ASAR_UNEXPECTED_CONTENT');
    const stat = asar.statFile(archive, entry, false);
    if (stat.link) fail('ASAR_SYMLINK_REJECTED');
    if (!stat.files) assert.deepEqual(asar.extractFile(archive, entry), await readFile(path.join(root, 'apps/desktop/build', entry)), 'ASAR_STAGING_MISMATCH');
  }
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString()) as {name?: unknown; version?: unknown; dependencies?: unknown; mioonDesktop?: unknown};
  const rootMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {version: string};
  assert.equal(metadata.name, 'mioon-desktop'); assert.equal(metadata.version, rootMetadata.version);
  assert.deepEqual(metadata.dependencies, {}); assert.deepEqual(metadata.mioonDesktop, desktopIdentity.identityForChannel('production'));
  for (const name of ['main.cjs', 'backend.cjs', 'preload.cjs', 'package.json', 'web/index.html', 'icons/icon.png', 'licenses/shadcn-ui-LICENSE.md']) asar.extractFile(archive, name);
  await verifySubtitleResources(path.join(resources, 'subtitles'));
}
async function inspectFuses(binary: string): Promise<void> {
  const {fuses} = dependencies(), wire = await fuses.getCurrentFuseWire(binary);
  for (const name of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'GrantFileProtocolExtraPrivileges']) if (wire[fuses.FuseV1Options[name]] !== 48) fail('FUSE_MUST_BE_DISABLED');
  for (const name of ['EnableCookieEncryption', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) if (wire[fuses.FuseV1Options[name]] !== 49) fail('FUSE_MUST_BE_ENABLED');
}
async function macApp(app: string, arch: TargetArch): Promise<string> {
  const executable = path.join(app, 'Contents/MacOS/Mioon');
  // CFBundleExecutable is generated by electron-builder and must be checked,
  // rather than relying on product name/executable-name casing conventions.
  const plist = path.join(app, 'Contents/Info.plist');
  const actualName = (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], 'PLIST_EXECUTABLE_FAILED')).trim();
  if (!actualName || /[\/\\\0]/.test(actualName)) fail('INVALID_BUNDLE_EXECUTABLE');
  const binary = path.join(path.dirname(executable), actualName);
  validateArchitecture(await command('lipo', ['-archs', binary], 'MACHO_PROBE_FAILED'), 'darwin', arch);
  const version = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {version: string}).version;
  if ((await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], 'PLIST_VERSION_FAILED')).trim() !== version ||
      (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], 'PLIST_ID_FAILED')).trim() !== desktopIdentity.identityForChannel('production').appId) fail('BUNDLE_IDENTITY_MISMATCH');
  await inspectAsar(path.join(app, 'Contents/Resources')); await inspectFuses(binary);
  const electronRoot = path.dirname(createRequire(import.meta.url).resolve('electron/package.json'));
  for (const [name, source] of [['LICENSE.electron.txt', 'LICENSE'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    assert.deepEqual(await readFile(path.join(app, 'Contents/Resources/licenses', name)), await readFile(path.join(electronRoot, 'dist', source)), 'ELECTRON_NOTICE_MISMATCH');
  }
  await command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], 'CODESIGN_VERIFICATION_FAILED');
  verifySigningIdentity(await command('codesign', ['--display', '--verbose=4', app], 'CODESIGN_IDENTITY_FAILED'), process.env.APPLE_SIGNING_IDENTITY, process.env.APPLE_TEAM_ID);
  await command('xcrun', ['stapler', 'validate', app], 'APP_STAPLE_INVALID');
  await command('spctl', ['--assess', '--type', 'execute', '--verbose=4', app], 'GATEKEEPER_REJECTED');
  return binary;
}
export async function inspectDesktop(platform: TargetPlatform, arch: TargetArch, packageDir: string): Promise<Inspection> {
  if (process.platform !== platform) fail('INSPECTION_HOST_MISMATCH');
  const expected = path.join(root, 'release/desktop/production');
  if (path.resolve(packageDir) !== expected) fail('INVALID_PACKAGE_DIRECTORY');
  const result: Inspection = {ok: false, platform, arch, checks: [], phase: 'package-preflight'};
  const check = (name: string): void => { result.checks.push({name, ok: true}); };
  try {
  if (platform === 'linux') {
    result.phase = 'linux-package';
    if (process.getuid?.() === 0) fail('NON_ROOT_LINUX_RUNNER_REQUIRED');
    if (arch !== 'x64') fail('UNSUPPORTED_LINUX_ARCHITECTURE');
    await command(process.execPath, ['apps/desktop/scripts/inspect-package.ts', '--channel=production'], 'LINUX_PACKAGE_INSPECTION_FAILED', {cwd: root, timeout: 180000});
    const binary = path.join(expected, 'linux-unpacked/mioon');
    validateArchitecture(await command('file', ['-b', binary], 'ELF_PROBE_FAILED'), platform, arch);
    await inspectAsar(path.join(expected, 'linux-unpacked/resources'));
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {version: string};
    const artifactBase = `mioon-${metadata.version}-linux-x64`, tarball = path.join(expected, `${artifactBase}.tar.gz`);
    result.phase = 'delivered-linux-tarball';
    const beforeHash = createHash('sha256').update(await readFile(tarball)).digest('hex');
    const names = await command('tar', ['--list', '--gzip', '--quoting-style=literal', '--file', tarball], 'TARBALL_LIST_FAILED');
    const details = await command('tar', ['--list', '--verbose', '--numeric-owner', '--full-time', '--gzip', '--quoting-style=literal', '--file', tarball], 'TARBALL_METADATA_FAILED');
    validateTarListing(names, details, artifactBase);
    const extractRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-ci-extract-')); result.extractRoot = extractRoot;
    await command('tar', ['--extract', '--gzip', '--no-same-owner', '--same-permissions', '--delay-directory-restore', '--no-overwrite-dir', '--keep-old-files', '--file', tarball, '--directory', extractRoot], 'TARBALL_EXTRACTION_FAILED', {timeout: 180000});
    if (createHash('sha256').update(await readFile(tarball)).digest('hex') !== beforeHash) fail('TARBALL_CHANGED_DURING_INSPECTION');
    const delivered = path.join(extractRoot, artifactBase);
    if (await treeDigest(path.join(expected, 'linux-unpacked')) !== await treeDigest(delivered)) fail('DELIVERED_LINUX_TREE_MISMATCH');
    result.executable = path.join(delivered, 'mioon'); result.packagePath = tarball;
    check('current-production-package-inspector'); check('all-asar-files-match-verified-staging'); check('x64-elf');
    check('safe-tarball-extraction-and-complete-delivered-tree-match');
  } else {
    result.phase = 'staged-mac-app';
    const suffix = arch === 'arm64' ? 'mac-arm64' : 'mac';
    const candidates = (await readdir(path.join(expected, suffix))).filter(name => name.endsWith('.app'));
    if (candidates.length !== 1) fail('UNIQUE_APP_REQUIRED');
    const app = path.join(expected, suffix, candidates[0]);
    await macApp(app, arch); check('staged-signed-app-identity-architecture-asar-licenses-subtitles-fuses');
    const dmgs = (await readdir(expected)).filter(name => name.endsWith(`-mac-${arch}.dmg`));
    if (dmgs.length !== 1) fail('UNIQUE_DMG_REQUIRED');
    result.phase = 'signed-dmg';
    const dmg = path.join(expected, dmgs[0]);
    await command('xcrun', ['stapler', 'validate', dmg], 'DMG_STAPLE_INVALID');
    await command('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg], 'DMG_GATEKEEPER_REJECTED');
    const canonicalTemp = await realpath(tmpdir()), mount = await mkdtemp(path.join(canonicalTemp, 'mioon-ci-dmg-'));
    let mounted = false;
    try {
      result.phase = 'mounted-dmg-app';
      await command('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], 'DMG_ATTACH_FAILED'); mounted = true;
      const mountedApps = (await readdir(mount)).filter(name => name.endsWith('.app'));
      if (mountedApps.length !== 1) fail('UNIQUE_MOUNTED_APP_REQUIRED');
      const delivered = path.join(mount, mountedApps[0]);
      if (await treeDigest(app) !== await treeDigest(delivered)) fail('DMG_APP_MISMATCH');
      result.executable = await macApp(delivered, arch); result.packagePath = dmg; result.mountPoint = mount;
      check('read-only-dmg-app-exactly-matches-staged-app'); check('dmg-and-delivered-app-signature-notarization-gatekeeper');
    } catch (error) {
      if (mounted) {
        try { await command('hdiutil', ['detach', mount], 'DMG_DETACH_FAILED'); }
        catch {
          try { await command('hdiutil', ['detach', '-force', mount], 'DMG_FORCE_DETACH_FAILED'); }
          catch { throw new MountedInspectionFailure(mount); }
        }
      }
      await rm(mount, {recursive: true, force: true}).catch(() => {}); throw error;
    }
  }
  result.ok = true; result.phase = 'complete'; return result;
  } catch (error) {
    result.error = safeFailure(error);
    result.checks.push({name: result.phase, ok: false});
    if (error instanceof MountedInspectionFailure) result.mountPoint = error.mountPoint;
    if (result.extractRoot) {
      try { await rm(result.extractRoot, {recursive: true, force: true}); delete result.extractRoot; }
      catch { result.cleanupError = 'EXTRACT_CLEANUP_FAILED'; }
    }
    throw new DesktopInspectionFailure(result);
  }
}
if (isMain(import.meta.url)) {
  let output: string | undefined;
  try {
    const args = argumentsFor(process.argv.slice(2), ['platform', 'arch', 'package-dir', 'output']); output = args.output;
    await report(output, await inspectDesktop(targetPlatform(args.platform), targetArch(args.arch), args['package-dir']));
  } catch (error) {
    if (output) await report(output, error instanceof DesktopInspectionFailure ? error.inspection : {ok: false, error: safeFailure(error)});
    console.error(safeFailure(error)); process.exitCode = 1;
  }
}
