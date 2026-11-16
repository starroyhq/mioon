import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateMacUpdateFeed} from './mac-update-feed.ts';
import {argument, hashFile, jsonFile, MAC_UPDATE_MANIFEST, manifestName, object, releaseAssetNames, releaseVersion, RELEASE_TARGET, sourceSha, validateAsset} from './release-common.ts';
import type {ReleaseAsset} from './release-common.ts';

export interface UploadFile {name: string; file: string; bytes: number; sha256: string}
type ManifestedAsset = ReleaseAsset & {manifest: Omit<UploadFile, 'file'>};
export interface ReleaseBundle {sourceSha: string; version: string; files: UploadFile[]; manifestSha256: string; manifest: {schema: 1; sourceSha: string; version: string; assets: ManifestedAsset[]}}
export interface RemoteAsset {id: number; name: string; size: number; digest?: string | null}
export interface DraftRelease {id: number; tag_name: string; target_commitish: string; draft: boolean; prerelease: boolean; body: string | null}
export interface PublishTransport {
  remoteTagSha: (tag: string) => Promise<string>;
  loadRelease: (tag: string) => Promise<DraftRelease | undefined>;
  createDraft: (input: {tag: string; sha: string; body: string; prerelease: false}) => Promise<DraftRelease>;
  assets: (releaseId: number) => Promise<RemoteAsset[]>;
  upload: (tag: string, file: UploadFile) => Promise<void>;
  digest: (asset: RemoteAsset) => Promise<{bytes: number; sha256: string}>;
  publish: (releaseId: number, prerelease: false) => Promise<void>;
}
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release inputs must not contain symbolic links');
    if (entry.isDirectory()) files.push(...await filesBelow(file));
    else if (entry.isFile()) files.push(file);
    else throw new Error('Release inputs must be regular files');
  }
  return files;
}
async function generatedFile(file: string, content: string): Promise<UploadFile> {
  try {await writeFile(file, content, {flag: 'wx'});}
  catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (!(await lstat(file)).isFile() || await readFile(file, 'utf8') !== content) throw new Error(`Existing generated release file differs: ${path.basename(file)}`);
  }
  return {file, name: path.basename(file), bytes: Buffer.byteLength(content), sha256: sha256(content)};
}
export async function collectReleaseBundle(directory: string, expectedSha: string): Promise<ReleaseBundle> {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Release input must be a real directory');
  const sha = sourceSha(expectedSha), allFiles = await filesBelow(directory);
  const byName = new Map<string, string>();
  for (const file of allFiles) {
    const name = path.basename(file);
    if (byName.has(name)) throw new Error(`Duplicate release input name: ${name}`);
    byName.set(name, file);
  }
  const updateManifest = byName.get(manifestName(MAC_UPDATE_MANIFEST));
  if (!updateManifest) throw new Error(`Missing asset manifest for the ${RELEASE_TARGET} target: ${MAC_UPDATE_MANIFEST}`);
  const targetDirectory = path.dirname(updateManifest);
  const {version} = validateAsset(await jsonFile(updateManifest));
  const names = releaseAssetNames(version, new Set(byName.keys()));
  const assets: ManifestedAsset[] = [], uploads: UploadFile[] = [];
  const expectedNames = new Set(['release-manifest.json', 'SHA256SUMS']);
  for (const name of names) {
    const sidecarName = manifestName(name), manifestFile = byName.get(sidecarName);
    const file = byName.get(name)!;
    if (!manifestFile) throw new Error(`Missing asset manifest: ${name}`);
    if (path.dirname(manifestFile) !== targetDirectory || path.dirname(file) !== targetDirectory) {
      throw new Error(`Exactly one macOS release target is required: ${RELEASE_TARGET}`);
    }
    const asset = validateAsset(await jsonFile(manifestFile));
    if (asset.sourceSha !== sha || asset.version !== version) throw new Error('Release asset source SHA or version differs');
    if (asset.name !== name) throw new Error('Asset manifest does not match its filename');
    const actual = await hashFile(file);
    if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) throw new Error(`Release asset size or SHA256 differs: ${name}`);
    const sidecar = {name: sidecarName, ...await hashFile(manifestFile)};
    assets.push({...asset, manifest: sidecar});
    uploads.push({file, name, ...actual}, {file: manifestFile, ...sidecar});
    expectedNames.add(name);
    expectedNames.add(sidecarName);
  }
  for (const [name, file] of byName) {
    if (!expectedNames.has(name) || ((name === 'release-manifest.json' || name === 'SHA256SUMS') && file !== path.join(directory, name))) {
      throw new Error(`Unexpected release input: ${name}`);
    }
  }
  await validateMacUpdateFeed(targetDirectory, version);
  assets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const manifest = {schema: 1 as const, sourceSha: sha, version, assets};
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestUpload = await generatedFile(path.join(directory, 'release-manifest.json'), manifestText);
  uploads.push(manifestUpload);
  const sums = `${[...uploads].sort((a, b) => a.name.localeCompare(b.name, 'en')).map(file => `${file.sha256}  ${file.name}`).join('\n')}\n`;
  uploads.push(await generatedFile(path.join(directory, 'SHA256SUMS'), sums));
  return {sourceSha: sha, version, files: uploads, manifestSha256: manifestUpload.sha256, manifest};
}
export function ownershipMarker(tag: string, bundle: Pick<ReleaseBundle, 'sourceSha' | 'manifestSha256'>): string {
  return `<!-- mioon-release:${JSON.stringify({schema: 1, tag, sourceSha: bundle.sourceSha, manifestSha256: bundle.manifestSha256})} -->`;
}
export function validateDraft(release: DraftRelease, tag: string, bundle: ReleaseBundle): void {
  if (!release.draft) throw new Error('Release is already public; refusing to overwrite it');
  if (release.prerelease) throw new Error('Prerelease desktop releases are not supported');
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.tag_name !== tag || release.target_commitish !== bundle.sourceSha) throw new Error('Draft release tag or source SHA differs');
  const markers = release.body?.split('\n').filter(line => line.startsWith('<!-- mioon-release:')) ?? [];
  if (markers.length !== 1 || markers[0] !== ownershipMarker(tag, bundle)) throw new Error('Draft release is not owned by this exact tag, source SHA and artifact manifest');
}
export async function publishRelease(bundle: ReleaseBundle, tag: string, transport: PublishTransport): Promise<void> {
  const version = releaseVersion(bundle.version);
  if (tag !== `v${version}`) throw new Error('Release tag does not match package version');
  if (version.split('+')[0]!.includes('-')) throw new Error('Prerelease desktop releases are not supported');
  const assertTag = async (): Promise<void> => {
    if (sourceSha(await transport.remoteTagSha(tag)) !== bundle.sourceSha) throw new Error('Remote release tag moved or does not match the frozen source SHA');
  };
  await assertTag();
  let release = await transport.loadRelease(tag);
  if (!release) {
    // A create conflict must fail rather than adopting an unverified release.
    release = await transport.createDraft({tag, sha: bundle.sourceSha, prerelease: false, body: `Mioon ${version}\n\n${ownershipMarker(tag, bundle)}`});
  }
  validateDraft(release, tag, bundle);
  const ownedRelease = release;
  const expected = new Map(bundle.files.map(file => [file.name, file]));
  const verifyAssets = async (complete: boolean): Promise<Set<string>> => {
    const existing = await transport.assets(ownedRelease.id), seen = new Set<string>();
    for (const asset of existing) {
      const wanted = expected.get(asset.name);
      if (!wanted || seen.has(asset.name)) throw new Error('Draft release contains an unexpected or duplicate asset');
      seen.add(asset.name);
      if (asset.size !== wanted.bytes) throw new Error(`Remote asset size differs: ${asset.name}`);
      const actual = asset.digest?.startsWith('sha256:') ? {bytes: asset.size, sha256: asset.digest.slice(7)} : await transport.digest(asset);
      if (actual.bytes !== wanted.bytes || actual.sha256 !== wanted.sha256) throw new Error(`Remote asset SHA256 differs: ${asset.name}`);
    }
    if (complete && seen.size !== expected.size) throw new Error('Draft release is missing uploaded assets');
    return seen;
  };
  const existing = await verifyAssets(false);
  for (const file of bundle.files) if (!existing.has(file.name)) await transport.upload(tag, file);
  await verifyAssets(true);
  // Re-read both ownership and tag immediately before the irreversible publication.
  const current = await transport.loadRelease(tag);
  if (!current || current.id !== ownedRelease.id) throw new Error('Draft release changed during upload');
  validateDraft(current, tag, bundle);
  await assertTag();
  await transport.publish(ownedRelease.id, false);
}
function remoteRelease(value: unknown): DraftRelease {
  const data = object(value);
  if (typeof data.id !== 'number' || typeof data.tag_name !== 'string' || typeof data.target_commitish !== 'string' ||
      typeof data.draft !== 'boolean' || typeof data.prerelease !== 'boolean' || (data.body !== null && typeof data.body !== 'string')) throw new Error('Invalid GitHub release response');
  return {id: data.id, tag_name: data.tag_name, target_commitish: data.target_commitish, draft: data.draft, prerelease: data.prerelease, body: data.body};
}
function remoteAsset(value: unknown): RemoteAsset {
  const data = object(value);
  if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.name !== 'string' || typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0 || (data.digest !== undefined && data.digest !== null && typeof data.digest !== 'string')) throw new Error('Invalid GitHub release asset response');
  return {id: data.id, name: data.name, size: data.size, digest: data.digest as string | null | undefined};
}
export function githubTransport(repository: string): PublishTransport {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const endpoint = `repos/${repository}`;
  const api = (route: string, method = 'GET', body?: unknown): unknown => {
    const args = ['api', '--method', method, '-H', 'X-GitHub-Api-Version: 2022-11-28', route];
    if (body !== undefined) args.push('--input', '-');
    return JSON.parse(execFileSync('gh', args, {encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 8 * 1024 * 1024, timeout: 120000})) as unknown;
  };
  const pages = (route: string): unknown[] => {
    const response: unknown = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', '-H', 'X-GitHub-Api-Version: 2022-11-28', route], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000}));
    if (!Array.isArray(response) || response.some(page => !Array.isArray(page))) throw new Error('Invalid GitHub pagination response');
    return (response as unknown[][]).flat();
  };
  return {
    remoteTagSha: async tag => {
      const lines = execFileSync('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {encoding: 'utf8', timeout: 60000}).trim().split('\n').map(line => line.split(/\s+/));
      const peeled = lines.find(line => line[1] === `refs/tags/${tag}^{}`) ?? lines.find(line => line[1] === `refs/tags/${tag}`);
      return sourceSha(peeled?.[0]);
    },
    loadRelease: async tag => {
      const matches = pages(`${endpoint}/releases?per_page=100`).map(remoteRelease).filter(release => release.tag_name === tag);
      if (matches.length > 1) throw new Error('Multiple GitHub releases use the same tag');
      return matches[0];
    },
    createDraft: async input => remoteRelease(api(`${endpoint}/releases`, 'POST', {tag_name: input.tag, target_commitish: input.sha, name: `Mioon ${input.tag}`, body: input.body, draft: true, prerelease: input.prerelease, make_latest: 'false'})),
    assets: async releaseId => pages(`${endpoint}/releases/${releaseId}/assets?per_page=100`).map(remoteAsset),
    upload: async (tag, file) => {execFileSync('gh', ['release', 'upload', tag, file.file, '--repo', repository], {stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000});},
    digest: async asset => new Promise((resolve, reject) => {
      const child = spawn('gh', ['api', '-H', 'Accept: application/octet-stream', `${endpoint}/releases/assets/${asset.id}`], {stdio: ['ignore', 'pipe', 'pipe']});
      const hash = createHash('sha256'); let bytes = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
      child.stdout.on('data', (chunk: Buffer) => {bytes += chunk.length; if (bytes > asset.size) child.kill('SIGKILL'); hash.update(chunk);});
      // Consume stderr without retaining it: asset downloads never need secrets in diagnostics.
      child.stderr.resume();
      child.on('error', error => {clearTimeout(timer); reject(error);});
      child.on('close', code => {clearTimeout(timer); if (code !== 0) reject(new Error(`GitHub asset download failed: ${asset.name}`)); else resolve({bytes, sha256: hash.digest('hex')});});
    }),
    publish: async (releaseId, prerelease) => {
      const release = remoteRelease(api(`${endpoint}/releases/${releaseId}`, 'PATCH', {draft: false, prerelease, make_latest: 'true'}));
      if (release.id !== releaseId || release.draft || release.prerelease) throw new Error('GitHub did not confirm a public stable desktop release');
    }
  };
}
export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!environment.GH_TOKEN || !environment.GITHUB_REPOSITORY || !environment.MIOON_RELEASE_TAG || !environment.MIOON_RELEASE_SHA) throw new Error('GH_TOKEN, GITHUB_REPOSITORY, MIOON_RELEASE_TAG and MIOON_RELEASE_SHA are required');
  const bundle = await collectReleaseBundle(argument('input') ?? 'artifacts/release', environment.MIOON_RELEASE_SHA);
  await publishRelease(bundle, environment.MIOON_RELEASE_TAG, githubTransport(environment.GITHUB_REPOSITORY));
  process.stdout.write(`Published ${environment.MIOON_RELEASE_TAG} from ${bundle.sourceSha} with ${bundle.files.length} verified assets\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;});
}
