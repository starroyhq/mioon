import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function candidateUpdateFeedUrl(value: string): string {
  const url = URL.parse(value);
  const loopback = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url || value.length > 2048 || !/^https?:\/\//.test(value) || /[\s\u0000-\u001f\u007f\\?#'"]/u.test(value) || url.username || url.password ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) {
    throw new Error('Candidate update feed must be an HTTPS directory URL or local loopback HTTP URL without credentials, query or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

async function readMetadata(file: string): Promise<string[]> {
  const info = await lstat(file);
  if (!info.isFile() || info.size < 1 || info.size > 8192) throw new Error('Unexpected macOS update metadata file');
  return (await readFile(file, 'utf8')).trimEnd().split(/\r?\n/);
}

// electron-builder emits plain scalar keys and a single ZIP record. Accept that
// shape explicitly so YAML aliases, duplicate keys and alternative URLs fail.
function scalarFields(lines: string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of lines) {
    const entry = /^([A-Za-z][A-Za-z0-9]*): (?:'([^']+)'|([^\s'"]+))$/.exec(line);
    const key = entry?.[1];
    if (!key || !allowed.includes(key) || result.has(key)) throw new Error('Unexpected macOS update metadata fields');
    result.set(key, (entry[2] ?? entry[3])!);
  }
  return result;
}

export async function validateMacUpdateFeed(directory: string, version: string): Promise<void> {
  const zipName = `mioon-${version}-mac.zip`;
  const lines = await readMetadata(path.join(directory, 'latest-mac.yml'));
  const index = lines.indexOf('files:');
  if (index < 0 || !lines[index + 1]?.startsWith('  - ')) throw new Error('Missing macOS update ZIP entry');
  let end = index + 2;
  while (lines[end]?.startsWith('    ')) end++;
  const zip = scalarFields([lines[index + 1]!.slice(4), ...lines.slice(index + 2, end).map(line => line.slice(4))],
    ['url', 'sha512', 'size', 'blockMapSize']);
  const metadata = scalarFields([...lines.slice(0, index), ...lines.slice(end)], ['version', 'path', 'sha512', 'releaseDate']);
  if (metadata.get('version') !== version || metadata.get('path') !== zipName || zip.get('url') !== zipName) {
    throw new Error('macOS update metadata version or ZIP name differs from the final package');
  }
  const zipFile = path.join(directory, zipName);
  const [info, blockmap] = await Promise.all([lstat(zipFile), lstat(`${zipFile}.blockmap`)]);
  if (!info.isFile() || info.size < 1 || !blockmap.isFile() || blockmap.size < 1 || zip.get('size') !== String(info.size) ||
      zip.has('blockMapSize') && zip.get('blockMapSize') !== String(blockmap.size)) {
    throw new Error('macOS update ZIP size differs from its metadata or the blockmap is missing');
  }
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(zipFile)) hash.update(chunk as Buffer);
  const sha512 = hash.digest('base64');
  if (zip.get('sha512') !== sha512 || metadata.get('sha512') !== sha512) {
    throw new Error('macOS update ZIP SHA-512 differs from its metadata');
  }
}

export async function validateMacAppUpdateProvider(file: string, candidateUrl?: string): Promise<void> {
  const fields = scalarFields(await readMetadata(file), ['provider', 'url', 'owner', 'repo', 'releaseType', 'updaterCacheDirName']);
  const expected = candidateUrl
    ? {provider: 'generic', url: candidateUpdateFeedUrl(candidateUrl)}
    : {provider: 'github', owner: 'starroyhq', repo: 'mioon', releaseType: 'release'};
  if (fields.size !== Object.keys(expected).length + 1 || fields.get('updaterCacheDirName') !== 'mioon-desktop-updater' ||
      Object.entries(expected).some(([key, value]) => fields.get(key) !== value)) {
    throw new Error('Packaged macOS update provider differs from the expected provider');
  }
}

async function main(): Promise<void> {
  const [directory, version, inspectionReport] = process.argv.slice(2);
  if (!directory || !version || !inspectionReport || process.argv.length !== 5) {
    throw new Error('Usage: mac-update-feed.ts <package directory> <version> <inspection report>');
  }
  const report = JSON.parse(await readFile(inspectionReport, 'utf8')) as {ok?: boolean; executable?: string};
  if (report.ok !== true || typeof report.executable !== 'string') throw new Error('Verified macOS app required');
  const resources = path.resolve(path.dirname(report.executable), '../Resources');
  await validateMacAppUpdateProvider(path.join(resources, 'app-update.yml'), process.env.MIOON_RELEASE_UPDATE_FEED_URL);
  await validateMacUpdateFeed(directory, version);
  process.stdout.write('Verified the packaged macOS update provider and final ZIP metadata\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
