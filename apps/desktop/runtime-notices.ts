// Electron runtime notice preservation for macOS packaging. Inputs are only the
// trusted electron-builder output context; no host Electron module is loaded.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requireExactVersion} from './build-metadata.ts';

export interface RuntimeNoticeFile {readonly source: string; readonly output: string; readonly maxBytes: number}
export const NOTICE_FILES: readonly RuntimeNoticeFile[] = Object.freeze([
  Object.freeze({ source: 'LICENSE', output: 'LICENSE.electron.txt', maxBytes: 256 * 1024 }),
  Object.freeze({ source: 'LICENSES.chromium.html', output: 'LICENSES.chromium.html', maxBytes: 32 * 1024 * 1024 })
]);
export const PLIST_MAX_BYTES = 1024 * 1024;
/** The electron-builder context fields these helpers consume. */
export interface RuntimeNoticeFramework {
  readonly version?: unknown;
  readonly distMacOsAppName?: unknown;
}
export interface RuntimeNoticePackager {
  readonly info?: {readonly framework?: RuntimeNoticeFramework};
  readonly config?: {readonly electronVersion?: unknown};
  readonly appInfo?: {readonly productFilename?: unknown};
}
export interface RuntimeNoticeContext {
  readonly electronPlatformName?: unknown;
  readonly arch?: unknown;
  readonly appOutDir?: unknown;
  readonly packager?: RuntimeNoticePackager;
}
export interface RuntimeNoticeTarget {
  readonly root: string;
  readonly platform: string;
  readonly arch: unknown;
  readonly electronVersion: string;
  readonly extractedApp: string;
  readonly packagedApp: string;
}
export interface RuntimeNoticeManifest extends RuntimeNoticeTarget {
  readonly files: Array<{readonly name: string; readonly bytes: number; readonly sha256: string}>;
}
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

function fail(message: string): never { throw new Error(`Electron runtime notices: ${message}`); }
function component(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\0]/.test(value)) fail(`invalid ${label}`);
  return value;
}

function macTarget(context: RuntimeNoticeContext, electronVersion: string): RuntimeNoticeTarget | null {
  const platform = context.electronPlatformName;
  if (platform === 'linux' || platform === 'win32') return null;
  if (platform !== 'darwin' && platform !== 'mas') fail('unsupported or missing target platform');
  requireExactVersion(electronVersion, 'Electron runtime notice pin');
  const framework = context.packager?.info?.framework;
  if (framework?.version !== electronVersion || context.packager?.config?.electronVersion !== electronVersion) {
    fail('target framework/config version does not match the pinned Electron version');
  }
  // electron-builder Arch.x64 === 1 and Arch.arm64 === 3; these are our Mac targets.
  if (context.arch !== 1 && context.arch !== 3) fail('unsupported or missing Mac target architecture');
  if (typeof context.appOutDir !== 'string' || !path.isAbsolute(context.appOutDir)) fail('target output directory must be absolute');
  const extractedApp = component(framework.distMacOsAppName, 'extracted bundle name');
  if (!extractedApp.endsWith('.app')) fail('extracted bundle name must end in .app');
  const packagedApp = `${component(context.packager?.appInfo?.productFilename, 'packaged product filename')}.app`;
  return { root: path.resolve(context.appOutDir), platform, arch: context.arch, electronVersion, extractedApp, packagedApp };
}

async function directory(root: string, components: readonly string[] = []): Promise<string> {
  let current = root;
  for (const part of [null, ...components]) {
    if (part !== null) current = path.join(current, component(part, 'directory component'));
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`expected a real directory: ${current}`);
  }
  return current;
}

// Fixed-size reads never follow a leaf symlink or allocate from an unbounded file.
// Parent directories are checked separately inside the trusted builder output root.
async function boundedRead(file: string, maxBytes: number): Promise<Buffer> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail(`expected a single-link regular file: ${file}`);
  if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes) fail(`file size outside 1..${maxBytes} bytes: ${file}`);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) {
      fail(`file changed before reading: ${file}`);
    }
    const bytes = Buffer.alloc(before.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      fail(`file changed while reading: ${file}`);
    }
    return bytes.subarray(0, total);
  } finally { await handle.close(); }
}

function targetPlistVersion(bytes: Uint8Array, expected: string): void {
  // Official Electron's original app plist is XML. Reject alternate/ambiguous
  // forms rather than silently substituting the host-installed runtime version.
  const xml = Buffer.from(bytes).toString('utf8').replace(/<!--[\s\S]*?-->/g, '');
  if (!/^\s*<\?xml\b/.test(xml) || !/<plist\b[^>]*>\s*<dict>/.test(xml) || !/<\/dict>\s*<\/plist>\s*$/.test(xml) || /<!--|<!\[CDATA\[|<!ENTITY/i.test(xml)) {
    fail('unsupported target Info.plist format');
  }
  const keys = [...xml.matchAll(/<key>\s*CFBundleShortVersionString\s*<\/key>/g)];
  const versions = [...xml.matchAll(/<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/g)];
  if (keys.length !== 1 || versions.length !== 1 || versions[0][1] !== expected) {
    fail('target Info.plist version does not match the pinned Electron version');
  }
}

export async function preserveMacRuntimeNotices(context: RuntimeNoticeContext, electronVersion: string): Promise<RuntimeNoticeManifest | null> {
  const target = macTarget(context, electronVersion);
  if (!target) return null;
  const contents = await directory(target.root, [target.extractedApp, 'Contents']);
  const resources = await directory(target.root, [target.extractedApp, 'Contents', 'Resources']);
  targetPlistVersion(await boundedRead(path.join(contents, 'Info.plist'), PLIST_MAX_BYTES), electronVersion);
  // Standard builder cleanup removes root/version before afterExtract. The
  // original bundle plist and builder context are the available version evidence.
  const sources: Array<RuntimeNoticeFile & {readonly bytes: Buffer}> = [];
  for (const file of NOTICE_FILES) sources.push({ ...file, bytes: await boundedRead(path.join(target.root, file.source), file.maxBytes) });
  const destination = path.join(resources, 'licenses');
  try { await fs.mkdir(destination); }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  await directory(target.root, [target.extractedApp, 'Contents', 'Resources', 'licenses']);
  // Never overwrite a runtime-provided file or follow an existing destination.
  for (const file of sources) {
    try { await fs.lstat(path.join(destination, file.output)); }
    catch (error) { if (errorCode(error) === 'ENOENT') continue; throw error; }
    fail(`notice destination already exists: ${file.output}`);
  }
  for (const file of sources) {
    const handle = await fs.open(path.join(destination, file.output), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(file.bytes); }
    finally { await handle.close(); }
  }
  const manifest: RuntimeNoticeManifest = { ...target, files: sources.map(file => ({ name: file.output, bytes: file.bytes.length, sha256: sha256(file.bytes) })) };
  await inspectMacRuntimeNotices(context, electronVersion, manifest, target.extractedApp);
  return manifest;
}

export async function inspectMacRuntimeNotices(context: RuntimeNoticeContext, electronVersion: string, manifest: RuntimeNoticeManifest | null | undefined, bundleName?: string): Promise<RuntimeNoticeManifest | null> {
  const target = macTarget(context, electronVersion);
  if (!target) return null;
  if (!manifest || (['root', 'platform', 'arch', 'electronVersion', 'extractedApp', 'packagedApp'] as const).some(key => manifest[key] !== target[key]) ||
      !Array.isArray(manifest.files) || manifest.files.length !== NOTICE_FILES.length) fail('missing or mismatched target notice provenance');
  const destination = await directory(target.root, [bundleName || target.packagedApp, 'Contents', 'Resources', 'licenses']);
  for (const file of NOTICE_FILES) {
    const original = manifest.files.find(entry => entry.name === file.output);
    const bytes = await boundedRead(path.join(destination, file.output), file.maxBytes);
    if (!original || bytes.length !== original.bytes || sha256(bytes) !== original.sha256) fail(`packaged notice differs from extracted target: ${file.output}`);
  }
  return manifest;
}

const runtimeNotices = Object.freeze({preserveMacRuntimeNotices, inspectMacRuntimeNotices, NOTICE_FILES, PLIST_MAX_BYTES});
export default runtimeNotices;
