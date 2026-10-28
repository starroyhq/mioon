import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod, lstat, open, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import type {MediaToolsInstallPhase, MediaToolsOffer, MediaToolsProgress, ToolPaths} from '../../../packages/contracts/src/workspace-info.ts';

export type MediaToolsTarget = 'darwin-arm64' | 'darwin-x64';
export interface MediaToolsAsset {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly unpackedSha256: string;
  readonly unpackedBytes: number;
}
export interface MediaToolsBuild {readonly ffmpeg: MediaToolsAsset; readonly ffprobe: MediaToolsAsset}
export interface MediaToolsRelease {
  readonly version: string;
  readonly ffmpegVersion: string;
  readonly license: string;
  readonly baseUrl: string;
  readonly sourceUrl: string;
  readonly builds: Readonly<Partial<Record<MediaToolsTarget, MediaToolsBuild>>>;
}
/**
 * The FFmpeg / ffprobe pair Mioon offers for download. The executables are built,
 * signed and notarized by .github/workflows/media-tools.yml and published as
 * release assets; every byte is pinned here, so a changed or substituted file is
 * rejected regardless of which server or redirect delivered it. See docs/MEDIA-TOOLS.md.
 */
export const MEDIA_TOOLS_RELEASE: MediaToolsRelease = Object.freeze({
  version: '7.1.5-1',
  ffmpegVersion: '7.1.5',
  license: 'GPL-2.0-or-later',
  baseUrl: 'https://github.com/starroyhq/mioon/releases/download/media-tools-7.1.5-1/',
  sourceUrl: 'https://github.com/starroyhq/mioon/releases/tag/media-tools-7.1.5-1',
  builds: Object.freeze({}),
});
const TOOLS = ['ffmpeg', 'ffprobe'] as const;
type Tool = typeof TOOLS[number];
const MAXIMUM_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAXIMUM_UNPACKED_BYTES = 256 * 1024 * 1024;
const ACTIVE_PHASES: ReadonlySet<MediaToolsInstallPhase> = new Set(['downloading', 'verifying', 'installing', 'checking']);

export function mediaToolsTarget(platform: string, arch: string): MediaToolsTarget | null {
  if (platform !== 'darwin') return null;
  return arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x64' : null;
}
export function mediaToolsBuild(release: MediaToolsRelease, platform: string, arch: string): MediaToolsBuild | null {
  const target = mediaToolsTarget(platform, arch);
  return target ? release.builds[target] ?? null : null;
}
const hex64 = /^[0-9a-f]{64}$/u;
/** Rejects a catalog entry that could not be downloaded and verified safely. */
export function assertMediaToolsRelease(release: MediaToolsRelease): void {
  const base = new URL(release.baseUrl);
  if (base.protocol !== 'https:' || !release.baseUrl.endsWith('/') || base.search || base.hash || base.username || base.password) throw new Error('Invalid media tools base URL.');
  if (new URL(release.sourceUrl).protocol !== 'https:') throw new Error('Invalid media tools source URL.');
  if (!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?-[0-9]+$/u.test(release.version) || !release.version.startsWith(`${release.ffmpegVersion}-`)) throw new Error('Invalid media tools version.');
  for (const [target, build] of Object.entries(release.builds)) {
    if (!['darwin-arm64', 'darwin-x64'].includes(target) || !build) throw new Error('Invalid media tools target.');
    for (const tool of TOOLS) {
      const asset = build[tool];
      if (!/^[a-z0-9.-]+\.gz$/u.test(asset.file) || !asset.file.includes(tool) || !hex64.test(asset.sha256) || !hex64.test(asset.unpackedSha256) ||
        !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > MAXIMUM_DOWNLOAD_BYTES ||
        !Number.isSafeInteger(asset.unpackedBytes) || asset.unpackedBytes <= 0 || asset.unpackedBytes > MAXIMUM_UNPACKED_BYTES) throw new Error('Invalid media tools asset.');
    }
  }
}

type Fetch = (url: string, init: {signal: AbortSignal; redirect: 'follow'; cache: 'no-store'}) => Promise<Response>;
export interface MediaToolsInstallerOptions {
  /** `<userData>/media-tools`; one subdirectory per pinned version. */
  readonly root: string;
  readonly release?: MediaToolsRelease;
  readonly platform?: string;
  readonly arch?: string;
  readonly fetch: Fetch;
  /** Creates or validates the private root before any file is written. */
  readonly prepareRoot: (root: string) => void;
  /** Creates a private, empty staging directory inside the root. */
  readonly createStaging: (root: string) => string;
  /** Runs the same executable checks as a user-selected pair before installation. */
  readonly validate: (paths: ToolPaths, signal: AbortSignal) => Promise<unknown>;
  readonly timeoutMs?: number;
}
export type MediaToolsInstallOutcome = {readonly ok: true; readonly paths: ToolPaths} | {readonly ok: false; readonly code: string};

class InstallFailure extends Error {
  readonly code: string;
  constructor(code: string) {super(code); this.code = code;}
}
const failure = (code: string): never => {throw new InstallFailure(code);};
const idle = (): MediaToolsProgress => ({phase: 'idle', receivedBytes: 0, totalBytes: 0, code: null});

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function regularExecutable(file: string, bytes: number): Promise<boolean> {
  const info = await lstat(file).catch(() => null);
  return Boolean(info?.isFile() && !info.isSymbolicLink() && info.size === bytes && (info.mode & 0o100));
}

export function createMediaToolsInstaller(options: MediaToolsInstallerOptions) {
  const release = options.release ?? MEDIA_TOOLS_RELEASE;
  assertMediaToolsRelease(release);
  const build = mediaToolsBuild(release, options.platform ?? process.platform, options.arch ?? process.arch);
  const target = mediaToolsTarget(options.platform ?? process.platform, options.arch ?? process.arch);
  const directory = path.join(options.root, release.version);
  const installedPaths: ToolPaths = {ffmpeg: path.join(directory, 'ffmpeg'), ffprobe: path.join(directory, 'ffprobe')};
  const totalBytes = build ? build.ffmpeg.bytes + build.ffprobe.bytes : 0;
  let progress = idle(), controller: AbortController | null = null, running: Promise<MediaToolsInstallOutcome> | null = null;
  const listeners = new Set<(progress: MediaToolsProgress) => void>();
  const report = (next: MediaToolsProgress): void => {
    progress = next;
    for (const listener of listeners) {try {listener(next);} catch {/* A closing progress view cannot stop the install. */}}
  };

  async function installed(verifyContents: boolean): Promise<boolean> {
    if (!build) return false;
    for (const tool of TOOLS) {
      if (!await regularExecutable(installedPaths[tool], build[tool].unpackedBytes)) return false;
      if (verifyContents && await sha256(installedPaths[tool]) !== build[tool].unpackedSha256) return false;
    }
    return true;
  }

  async function download(tool: Tool, staging: string, signal: AbortSignal, already: number): Promise<number> {
    const asset = build![tool];
    let response: Response;
    try {response = await options.fetch(new URL(asset.file, release.baseUrl).href, {signal, redirect: 'follow', cache: 'no-store'});}
    catch {return failure(signal.aborted ? 'MEDIA_TOOLS_ABORTED' : 'MEDIA_TOOLS_DOWNLOAD_NETWORK');}
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      return failure(`MEDIA_TOOLS_DOWNLOAD_HTTP_${response.status}`);
    }
    // Redirects are followed for the release CDN, but never to plain HTTP.
    if (response.url && new URL(response.url).protocol !== 'https:') {await response.body.cancel().catch(() => {}); return failure('MEDIA_TOOLS_DOWNLOAD_INSECURE');}
    const advertised = Number(response.headers.get('content-length'));
    if (response.headers.has('content-length') && advertised !== asset.bytes) {await response.body.cancel().catch(() => {}); return failure('MEDIA_TOOLS_SIZE_MISMATCH');}
    const compressed = createHash('sha256'), unpacked = createHash('sha256');
    let received = 0, written = 0;
    const file = path.join(staging, tool);
    const handle = await open(file, 'wx', 0o700);
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
        new Transform({transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > asset.bytes) return callback(new InstallFailure('MEDIA_TOOLS_SIZE_MISMATCH'));
          compressed.update(chunk);
          report({phase: 'downloading', receivedBytes: already + received, totalBytes, code: null});
          callback(null, chunk);
        }}),
        createGunzip(),
        new Transform({transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          if (written > asset.unpackedBytes) return callback(new InstallFailure('MEDIA_TOOLS_SIZE_MISMATCH'));
          unpacked.update(chunk);
          callback(null, chunk);
        }}),
        handle.createWriteStream({flush: true}),
        {signal},
      );
    } catch (error) {
      if (error instanceof InstallFailure) throw error;
      if (signal.aborted) failure('MEDIA_TOOLS_ABORTED');
      // zlib reports corrupt or truncated archives; anything else is local IO.
      const code = error !== null && typeof error === 'object' ? (error as {code?: unknown}).code : undefined;
      failure(typeof code === 'string' && code.startsWith('Z_') ? 'MEDIA_TOOLS_ARCHIVE_INVALID' : 'MEDIA_TOOLS_INSTALL_FAILED');
    } finally {await handle.close().catch(() => {});}
    report({phase: 'verifying', receivedBytes: already + received, totalBytes, code: null});
    if (received !== asset.bytes || written !== asset.unpackedBytes) failure('MEDIA_TOOLS_SIZE_MISMATCH');
    if (compressed.digest('hex') !== asset.sha256 || unpacked.digest('hex') !== asset.unpackedSha256) failure('MEDIA_TOOLS_CHECKSUM_MISMATCH');
    await chmod(file, 0o700);
    return received;
  }

  async function perform(owned: AbortController): Promise<MediaToolsInstallOutcome> {
    const signal = AbortSignal.any([owned.signal, AbortSignal.timeout(options.timeoutMs ?? 15 * 60 * 1000)]);
    let staging: string | null = null, previous: string | null = null;
    try {
      try {options.prepareRoot(options.root);} catch {failure('MEDIA_TOOLS_STORAGE_UNAVAILABLE');}
      if (await installed(true)) {
        report({phase: 'checking', receivedBytes: totalBytes, totalBytes, code: null});
        try {await options.validate(installedPaths, signal);} catch {failure(signal.aborted ? 'MEDIA_TOOLS_ABORTED' : 'MEDIA_TOOLS_CHECK_FAILED');}
        return {ok: true, paths: {...installedPaths}};
      }
      try {staging = options.createStaging(options.root);} catch {failure('MEDIA_TOOLS_STORAGE_UNAVAILABLE');}
      report({phase: 'downloading', receivedBytes: 0, totalBytes, code: null});
      let received = 0;
      for (const tool of TOOLS) received += await download(tool, staging!, signal, received);
      report({phase: 'checking', receivedBytes: totalBytes, totalBytes, code: null});
      try {await options.validate({ffmpeg: path.join(staging!, 'ffmpeg'), ffprobe: path.join(staging!, 'ffprobe')}, signal);}
      catch {failure(signal.aborted ? 'MEDIA_TOOLS_ABORTED' : 'MEDIA_TOOLS_CHECK_FAILED');}
      if (signal.aborted) failure('MEDIA_TOOLS_ABORTED');
      report({phase: 'installing', receivedBytes: totalBytes, totalBytes, code: null});
      // Replacing an earlier, damaged copy keeps it until the new one is in place.
      if (await lstat(directory).catch(() => null)) {
        previous = path.join(options.root, `.previous-${randomUUID()}`);
        await rename(directory, previous);
      }
      await rename(staging!, directory);
      staging = null;
      return {ok: true, paths: {...installedPaths}};
    } catch (error) {
      if (previous && !await lstat(directory).catch(() => null)) {await rename(previous, directory).catch(() => {}); previous = null;}
      const code = error instanceof InstallFailure ? error.code : 'MEDIA_TOOLS_INSTALL_FAILED';
      if (code !== 'MEDIA_TOOLS_ABORTED') return {ok: false, code};
      return {ok: false, code: owned.signal.aborted ? 'MEDIA_TOOLS_CANCELLED' : 'MEDIA_TOOLS_DOWNLOAD_TIMEOUT'};
    } finally {
      // Both directories were created inside the private root by this attempt.
      if (staging) await rm(staging, {recursive: true, force: true}).catch(() => {});
      if (previous) await rm(previous, {recursive: true, force: true}).catch(() => {});
    }
  }

  return {
    offer(): MediaToolsOffer | null {
      if (!build || !target) return null;
      return {version: release.version, ffmpegVersion: release.ffmpegVersion, arch: target === 'darwin-arm64' ? 'arm64' : 'x64',
        downloadBytes: totalBytes, license: release.license, sourceUrl: release.sourceUrl};
    },
    progress: (): MediaToolsProgress => ({...progress}),
    busy: (): boolean => running !== null,
    /** A size and permission check; full contents are verified before use. */
    installedPaths: async (): Promise<ToolPaths | null> => await installed(false) ? {...installedPaths} : null,
    subscribe(listener: (progress: MediaToolsProgress) => void): () => void {
      listeners.add(listener);
      return () => {listeners.delete(listener);};
    },
    install(): Promise<MediaToolsInstallOutcome> {
      if (!build) return Promise.resolve({ok: false, code: 'MEDIA_TOOLS_UNAVAILABLE'});
      if (running) return Promise.resolve({ok: false, code: 'MEDIA_TOOLS_BUSY'});
      const owned = controller = new AbortController();
      // Replace a previous outcome at once, so status never shows a stale failure.
      report({phase: 'downloading', receivedBytes: 0, totalBytes, code: null});
      running = perform(owned).then(outcome => {
        report(outcome.ok ? {phase: 'completed', receivedBytes: totalBytes, totalBytes, code: null}
          : {phase: outcome.code === 'MEDIA_TOOLS_CANCELLED' ? 'cancelled' : 'failed', receivedBytes: progress.receivedBytes, totalBytes, code: outcome.code});
        return outcome;
      }).finally(() => {running = null; if (controller === owned) controller = null;});
      return running;
    },
    cancel(): boolean {
      // The final rename is short and must not be interrupted halfway.
      if (!controller || controller.signal.aborted || !ACTIVE_PHASES.has(progress.phase) || progress.phase === 'installing') return false;
      controller.abort();
      return true;
    },
  };
}
export type MediaToolsInstaller = ReturnType<typeof createMediaToolsInstaller>;
