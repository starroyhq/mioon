/** Application-same FFmpeg 7.1.5 for the SP-I0 prototype. Downloads the public
 * media-tools release asset and verifies its pinned manifest, gzip and unpacked
 * hashes; MIOON_FFMPEG_PATH may point at an already-provisioned pair. */
import {gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const BASE_URL = 'https://github.com/starroyhq/mioon/releases/download/media-tools-7.1.5-1/';
const MANIFEST = 'mioon-media-tools-7.1.5-1-darwin-arm64.json';
const MANIFEST_SHA256 = '0b3800df8247d70d3fa86dde74f798b6057ffd203b435bc811892589598fa7cb';
const MANIFEST_BYTES = 7578;
const ASSETS = {
  ffmpeg: {file: 'mioon-ffmpeg-7.1.5-1-darwin-arm64.gz', bytes: 12_303_879,
    sha256: 'f58c9b8a6bf9c3016ea3be6cc45d7165e62035ec6a653819742862bf9071db36',
    unpackedBytes: 24_702_784, unpackedSha256: 'ffb7ed43b084f81a140c23fdf1451342ac969c48405897a3036d0f2823b10a0d'},
  ffprobe: {file: 'mioon-ffprobe-7.1.5-1-darwin-arm64.gz', bytes: 12_244_087,
    sha256: '4ce84d3b38aa2e4a0869705638ead01ce9f9bc44e242f7d93db555bdff4c168b',
    unpackedBytes: 24_627_520, unpackedSha256: '56da274d23c045a0a46c8364675ac18a33e8fa9a48d83044fd9d1f361e5bfb6e'},
};
const sha256 = data => createHash('sha256').update(data).digest('hex');
function curl(url, maxBytes) {
  const done = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https',
    '--proto-redir', '=https', '--connect-timeout', '30', '--max-time', '180', '--max-filesize', String(maxBytes), url],
    {maxBuffer: maxBytes, timeout: 200_000});
  if (done.error || done.status !== 0) throw new Error(`PUBLIC_ASSET_DOWNLOAD_FAILED: ${url}`);
  return done.stdout;
}
function verifyBytes(name, body, expectedBytes, expectedHash) {
  if (body.length !== expectedBytes) throw new Error(`PUBLIC_ASSET_SIZE_MISMATCH: ${name}`);
  if (sha256(body) !== expectedHash) throw new Error(`PUBLIC_ASSET_HASH_MISMATCH: ${name}`);
}
function versionOf(binary) {
  const done = spawnSync(binary, ['-version'], {encoding: 'utf8', timeout: 30_000});
  if (done.error || done.status !== 0) throw new Error('MEDIA_TOOL_VERSION_PROBE_FAILED');
  return done.stdout.split('\n')[0] ?? '';
}
export function resolveTools(root) {
  const envFfmpeg = process.env.MIOON_FFMPEG_PATH, envFfprobe = process.env.MIOON_FFPROBE_PATH;
  if (envFfmpeg && envFfprobe) {
    const version = versionOf(envFfmpeg);
    if (!version.includes('7.1.5')) throw new Error(`MIOON_FFMPEG_PATH is not the pinned 7.1.5 build: ${version}`);
    return {ffmpeg: envFfmpeg, ffprobe: envFfprobe, version, source: 'MIOON_FFMPEG_PATH'};
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('NO_APPLICATION_SAME_MEDIA_TOOL: only the darwin-arm64 release is published; set MIOON_FFMPEG_PATH');
  }
  const dir = path.join(root, 'media-tools');
  mkdirSync(dir, {recursive: true});
  const manifest = JSON.parse(curl(BASE_URL + MANIFEST, MANIFEST_BYTES + 1).toString('utf8'));
  if (manifest.version !== '7.1.5-1' || manifest.arch !== 'arm64') throw new Error('MANIFEST_IDENTITY_MISMATCH');
  for (const [name, asset] of Object.entries(ASSETS)) {
    const remote = manifest.assets?.[name];
    for (const key of ['file', 'bytes', 'sha256', 'unpackedBytes', 'unpackedSha256']) {
      if (remote?.[key] !== asset[key]) throw new Error(`MANIFEST_ASSET_MISMATCH: ${name}.${key}`);
    }
  }
  const paths = {};
  for (const [name, asset] of Object.entries(ASSETS)) {
    const compressed = curl(BASE_URL + asset.file, asset.bytes + 1);
    verifyBytes(asset.file, compressed, asset.bytes, asset.sha256);
    const data = gunzipSync(compressed);
    verifyBytes(name, data, asset.unpackedBytes, asset.unpackedSha256);
    const file = path.join(dir, name);
    writeFileSync(file, data);
    chmodSync(file, 0o700);
    paths[name] = file;
  }
  const version = versionOf(paths.ffmpeg);
  if (!version.includes('7.1.5')) throw new Error(`UNEXPECTED_MEDIA_TOOL_VERSION: ${version}`);
  return {...paths, version, source: 'media-tools-7.1.5-1'};
}
