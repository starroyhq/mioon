import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {argument, hashFile, jsonFile, manifestName, object, RELEASE_TARGETS, sourceSha, validateAsset} from './release-common.ts';
import type {ReleaseAsset} from './release-common.ts';

export interface UploadFile {name: string; file: string; bytes: number; sha256: string}
export interface ReleaseBundle {sourceSha: string; version: string; files: UploadFile[]; manifestSha256: string; manifest: {schema: 1; sourceSha: string; version: string; assets: ReleaseAsset[]}}
export interface RemoteAsset {id: number; name: string; size: number; digest?: string | null}
export interface DraftRelease {id: number; tag_name: string; target_commitish: string; draft: boolean; body: string | null}
export interface PublishTransport {
  remoteTagSha: (tag: string) => Promise<string>;
  loadRelease: (tag: string) => Promise<DraftRelease | undefined>;
  createDraft: (input: {tag: string; sha: string; body: string; prerelease: boolean}) => Promise<DraftRelease>;
  assets: (releaseId: number) => Promise<RemoteAsset[]>;
  upload: (tag: string, file: UploadFile) => Promise<void>;
  digest: (asset: RemoteAsset) => Promise<{bytes: number; sha256: string}>;
  publish: (releaseId: number, prerelease: boolean) => Promise<void>;
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
  const assets: ReleaseAsset[] = [], uploads: UploadFile[] = [];
  let version: string | undefined;
  const expectedNames = new Set(['release-manifest.json', 'SHA256SUMS']);
  for (const target of RELEASE_TARGETS) {
    const manifestFile = byName.get(`manifest-${target}.json`);
    if (!manifestFile) throw new Error(`Missing target manifest: ${target}`);
    const asset = validateAsset(await jsonFile(manifestFile));
    if (`${asset.platform}-${asset.arch}` !== target || manifestName(asset) !== path.basename(manifestFile)) throw new Error('Target manifest does not match its filename');
    if (asset.sourceSha !== sha || (version !== undefined && version !== asset.version)) throw new Error('Release target source SHA or version differs');
    version = asset.version;
    const file = byName.get(asset.name);
    if (!file) throw new Error(`Missing package: ${asset.name}`);
    const actual = await hashFile(file);
    if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) throw new Error(`Package size or SHA256 differs: ${asset.name}`);
    assets.push(asset);
    uploads.push({file, name: asset.name, bytes: actual.bytes, sha256: actual.sha256});
    expectedNames.add(asset.name);
    expectedNames.add(manifestName(asset));
  }
  if (assets.length !== 3 || !version) throw new Error('Exactly three release targets are required');
  for (const name of byName.keys()) if (!expectedNames.has(name)) throw new Error(`Unexpected release input: ${name}`);
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
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.tag_name !== tag || release.target_commitish !== bundle.sourceSha) throw new Error('Draft release tag or source SHA differs');
  const markers = release.body?.split('\n').filter(line => line.startsWith('<!-- mioon-release:')) ?? [];
  if (markers.length !== 1 || markers[0] !== ownershipMarker(tag, bundle)) throw new Error('Draft release is not owned by this exact tag, source SHA and artifact manifest');
}
export async function publishRelease(bundle: ReleaseBundle, tag: string, transport: PublishTransport): Promise<void> {
  if (tag !== `v${bundle.version}`) throw new Error('Release tag does not match package version');
  const prerelease = bundle.version.split('+')[0]!.includes('-');
  const assertTag = async (): Promise<void> => {
    if (sourceSha(await transport.remoteTagSha(tag)) !== bundle.sourceSha) throw new Error('Remote release tag moved or does not match the frozen source SHA');
  };
  await assertTag();
  let release = await transport.loadRelease(tag);
  if (!release) {
    // A create conflict must fail rather than adopting an unverified release.
    release = await transport.createDraft({tag, sha: bundle.sourceSha, prerelease, body: `Mioon ${bundle.version}\n\n${ownershipMarker(tag, bundle)}`});
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
  await transport.publish(ownedRelease.id, prerelease);
}
function remoteRelease(value: unknown): DraftRelease {
  const data = object(value);
  if (typeof data.id !== 'number' || typeof data.tag_name !== 'string' || typeof data.target_commitish !== 'string' || typeof data.draft !== 'boolean' || (data.body !== null && typeof data.body !== 'string')) throw new Error('Invalid GitHub release response');
  return {id: data.id, tag_name: data.tag_name, target_commitish: data.target_commitish, draft: data.draft, body: data.body};
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
    publish: async (releaseId, prerelease) => {api(`${endpoint}/releases/${releaseId}`, 'PATCH', {draft: false, prerelease, make_latest: prerelease ? 'false' : 'true'});}
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
