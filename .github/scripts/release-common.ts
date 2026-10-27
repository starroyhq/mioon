import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';

export type ReleasePlatform = 'darwin';
export type ReleaseArch = 'arm64' | 'x64';
export interface ReleaseAsset {
  sourceSha: string;
  version: string;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  name: string;
  bytes: number;
  sha256: string;
}
export const RELEASE_TARGETS = ['darwin-arm64', 'darwin-x64'] as const;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function releaseVersion(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !versionPattern.test(value)) throw new Error('Invalid release version');
  return value;
}
export function sourceSha(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 40 || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Expected a full lowercase source SHA');
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
export async function jsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}
export function manifestName(asset: Pick<ReleaseAsset, 'platform' | 'arch'>): string {
  return `manifest-${asset.platform}-${asset.arch}.json`;
}
export function validateAsset(value: unknown): ReleaseAsset {
  const data = object(value);
  const sha = sourceSha(data.sourceSha), version = releaseVersion(data.version);
  const platform = data.platform, arch = data.arch;
  if (platform !== 'darwin') throw new Error('Only macOS release packages are supported');
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('Invalid package architecture');
  const name = data.name;
  const suffix = `-${version}-mac-${arch}.dmg`;
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(name) || path.basename(name) !== name || !name.endsWith(suffix)) throw new Error('Invalid package asset name');
  if (typeof data.bytes !== 'number' || !Number.isSafeInteger(data.bytes) || data.bytes <= 0) throw new Error('Invalid package byte count');
  if (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('Invalid package SHA256');
  return {sourceSha: sha, version, platform, arch, name, bytes: data.bytes, sha256: data.sha256};
}
export async function hashFile(file: string): Promise<{bytes: number; sha256: string}> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular release file: ${path.basename(file)}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return {bytes, sha256: hash.digest('hex')};
}
export function argument(name: string, args = process.argv.slice(2)): string | undefined {
  const matches = args.filter(item => item.startsWith(`--${name}=`));
  if (matches.length > 1) throw new Error(`Duplicate --${name}`);
  return matches[0]?.slice(name.length + 3);
}
