/** macOS media toolchain helpers for the macOS media workflow.
 *
 * The workflow caches the Homebrew `ffmpeg-full` bottle by its published
 * SHA-256, re-hashes every cache hit before use, probes the installed tools
 * with the existing `media-environment.ts` checks and records the bottle
 * identity, cache state and tool bytes in one evidence file. Linux still uses
 * the prepared CI toolchain from `ffmpeg` above; this file is only imported by
 * the macOS workflow steps and their tests. */
import {createHash} from 'node:crypto';
import {lstat, readFile, writeFile, mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {argumentsFor, fail, isMain, safeFailure} from './media-environment.ts';

export const MEDIA_EVIDENCE_DIRECTORY = 'artifacts/macos-media-environment';
export const BOTTLE_SHA_PATTERN = /^[a-f0-9]{64}$/u;
export const CACHE_STATES = ['hit', 'miss', 'reused', 'unavailable', 'invalid'] as const;
export type CacheState = typeof CACHE_STATES[number];

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Read only the reviewed arm64 macOS 15 bottle identity from `brew info --json=v2`. */
export function bottleShaFromInfo(value: unknown): string {
  const formulae = recordOf(value)?.formulae;
  if (!Array.isArray(formulae)) fail('INVALID_BREW_INFO');
  for (const entry of formulae) {
    const formula = recordOf(entry);
    if (formula?.name !== 'ffmpeg-full') continue;
    const stable = recordOf(recordOf(formula.bottle)?.stable), files = recordOf(stable?.files), release = recordOf(files?.arm64_sequoia);
    const sha = release?.sha256;
    if (typeof sha !== 'string' || !BOTTLE_SHA_PATTERN.test(sha)) fail('FFMPEG_FULL_BOTTLE_NOT_FOUND');
    return sha;
  }
  fail('FFMPEG_FULL_BOTTLE_NOT_FOUND');
}

export async function sha256File(file: string): Promise<string> {
  const info = await lstat(file).catch(() => fail('MEDIA_EVIDENCE_TOOL_MISSING'));
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) fail('MEDIA_EVIDENCE_TOOL_INVALID');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Re-hash a cached bottle download; any mismatch or foreign file type fails. */
export async function verifyBottleArchive(archive: string, sha: string): Promise<void> {
  if (!BOTTLE_SHA_PATTERN.test(sha)) fail('INVALID_BOTTLE_SHA');
  const info = await lstat(archive).catch(() => fail('BOTTLE_ARCHIVE_UNAVAILABLE'));
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) fail('BOTTLE_ARCHIVE_INVALID');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk as Buffer);
  if (hash.digest('hex') !== sha) fail('BOTTLE_HASH_MISMATCH');
}

function cacheState(value: string): CacheState {
  if (!(CACHE_STATES as readonly string[]).includes(value)) fail('INVALID_CACHE_STATE');
  return value as CacheState;
}

interface MediaProbe {
  readonly ok: boolean;
  readonly platform: string;
  readonly tools: {readonly ffmpeg: string; readonly ffprobe: string};
  readonly versions: {readonly ffmpeg: string; readonly ffprobe: string};
  readonly capabilities: {readonly filters: Readonly<Record<string, boolean>>; readonly encoders: Readonly<Record<string, boolean>>};
  readonly cliCapabilities: Readonly<Record<string, boolean>>;
}

function readMediaProbe(value: unknown): MediaProbe {
  if (value === null || typeof value !== 'object') fail('INVALID_MEDIA_EVIDENCE');
  const probe = value as Partial<MediaProbe>;
  if (probe.ok !== true || probe.platform !== 'darwin') fail('MEDIA_PROBE_NOT_SUCCESSFUL');
  const tools = probe.tools as MediaProbe['tools'] | undefined;
  if (!tools || typeof tools.ffmpeg !== 'string' || typeof tools.ffprobe !== 'string') fail('INVALID_MEDIA_EVIDENCE');
  const versions = probe.versions as MediaProbe['versions'] | undefined;
  if (!versions || typeof versions.ffmpeg !== 'string' || typeof versions.ffprobe !== 'string') fail('INVALID_MEDIA_EVIDENCE');
  const capabilities = probe.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || !capabilities.filters || !capabilities.encoders) fail('INVALID_MEDIA_EVIDENCE');
  for (const group of [capabilities.filters, capabilities.encoders]) {
    const values = Object.values(group);
    if (!values.length || values.some(flag => flag !== true)) fail('MEDIA_CAPABILITY_MISSING');
  }
  const cli = probe.cliCapabilities;
  if (!cli || typeof cli !== 'object' || Object.values(cli).some(flag => flag !== true) || !Object.keys(cli).length) fail('MEDIA_CAPABILITY_MISSING');
  return probe as MediaProbe;
}

export interface ToolchainEvidenceOptions {
  readonly bottleSha: string;
  readonly cacheState: CacheState;
  readonly mediaFile: string;
  readonly output: string;
  readonly hash?: (file: string) => Promise<string>;
}

/** Combine the capability probe with tool bytes and the checked bottle identity. */
export async function writeToolchainEvidence({bottleSha, cacheState: state, mediaFile, output, hash = sha256File}: ToolchainEvidenceOptions): Promise<Record<string, unknown>> {
  if (bottleSha !== '' && !BOTTLE_SHA_PATTERN.test(bottleSha)) fail('INVALID_BOTTLE_SHA');
  const probe = readMediaProbe(JSON.parse(await readFile(mediaFile, 'utf8')) as unknown);
  const evidence = {
    schema: 1,
    platform: 'darwin',
    bottle: {sha256: bottleSha || null, cache: cacheState(state)},
    tools: {
      ffmpeg: {path: probe.tools.ffmpeg, sha256: await hash(probe.tools.ffmpeg)},
      ffprobe: {path: probe.tools.ffprobe, sha256: await hash(probe.tools.ffprobe)},
    },
    versions: probe.versions,
    capabilities: probe.capabilities,
    cliCapabilities: probe.cliCapabilities,
  };
  await mkdir(path.dirname(path.resolve(output)), {recursive: true});
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
  return evidence;
}

async function main(args: readonly string[]): Promise<number> {
  const [command, ...flags] = args;
  if (command === 'bottle-sha') {
    const {input} = argumentsFor(flags, ['input']);
    process.stdout.write(bottleShaFromInfo(JSON.parse(await readFile(input, 'utf8')) as unknown) + '\n');
    return 0;
  }
  if (command === 'verify-bottle') {
    const {archive, sha} = argumentsFor(flags, ['archive', 'sha']);
    await verifyBottleArchive(archive, sha);
    process.stdout.write('bottle=verified\n');
    return 0;
  }
  if (command === 'evidence') {
    const {cache, media, output, 'bottle-sha': bottleSha = ''} = argumentsFor(flags, ['cache', 'media', 'output'], ['bottle-sha']);
    await writeToolchainEvidence({bottleSha, cacheState: cacheState(cache), mediaFile: media, output});
    return 0;
  }
  fail('INVALID_ARGUMENTS');
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(code => {process.exitCode = code;}).catch((error: unknown) => {
    console.error(safeFailure(error)); process.exitCode = 1;
  });
}
