import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {APPLE_SECRET_FLAGS, pushedTagForEvent, requireAppleSecrets, resolvePreflight} from '../.github/scripts/release-preflight.ts';
import {stageRelease, validatePackageReport} from '../.github/scripts/stage-release.ts';
import {collectReleaseBundle, ownershipMarker, publishRelease, validateDraft} from '../.github/scripts/publish-release.ts';
import type {DraftRelease, PublishTransport, ReleaseBundle, RemoteAsset, UploadFile} from '../.github/scripts/publish-release.ts';
import type {ReleaseArch, ReleasePlatform} from '../.github/scripts/release-common.ts';

const sha = '1'.repeat(40), changedSha = '2'.repeat(40), version = '0.4.1', tag = `v${version}`;
const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const preflight = {rootVersion: version, desktopVersion: version, checkoutSha: sha, resolveTag: () => sha, isOnMain: () => true};

test('release preflight freezes a valid release tag and main SHA', () => {
  assert.deepEqual(resolvePreflight({...preflight, pushedTag: tag}), {release_sha: sha, version, release_tag: tag, should_publish: true, prerelease: false});
  assert.equal(resolvePreflight({...preflight, manualTag: tag}).should_publish, true);
  assert.equal(resolvePreflight({...preflight, rootVersion: '1.2.0-rc.1+build', desktopVersion: '1.2.0-rc.1+build', manualTag: 'v1.2.0-rc.1+build'}).prerelease, true);
});
test('manual artifact-only run does not invent a tag or publish', () => {
  assert.deepEqual(resolvePreflight(preflight), {release_sha: sha, version, release_tag: '', should_publish: false, prerelease: false});
});
test('only a pushed tag can implicitly publish; dispatch on a tag stays artifact-only', () => {
  for (const event of [
    {name: 'push', refType: 'tag', refName: tag, shouldPublish: true},
    {name: 'push', refType: 'branch', refName: 'main', shouldPublish: false},
    {name: 'workflow_dispatch', refType: 'tag', refName: tag, shouldPublish: false},
    {name: 'workflow_dispatch', refType: 'branch', refName: 'main', shouldPublish: false},
    {name: 'pull_request', refType: 'tag', refName: tag, shouldPublish: false}
  ]) {
    const environment = {GITHUB_EVENT_NAME: event.name, GITHUB_REF_TYPE: event.refType, GITHUB_REF_NAME: event.refName, MIOON_PUSHED_TAG: tag};
    const pushedTag = pushedTagForEvent(environment);
    assert.equal(resolvePreflight({...preflight, pushedTag}).should_publish, event.shouldPublish, `${event.name}/${event.refType}`);
  }
  assert.equal(resolvePreflight({...preflight, manualTag: tag, pushedTag: pushedTagForEvent({GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag})}).should_publish, true, 'an explicit release_tag still authorizes dispatch publication');
});
test('release preflight rejects mismatched package versions, tags, moved tags and non-main sources', () => {
  assert.throws(() => resolvePreflight({...preflight, desktopVersion: '0.4.2'}), /versions differ/);
  assert.throws(() => resolvePreflight({...preflight, pushedTag: 'v0.4.2'}), /tag must equal/);
  assert.throws(() => resolvePreflight({...preflight, pushedTag: tag, manualTag: 'v0.4.2'}), /tags differ/);
  assert.throws(() => resolvePreflight({...preflight, pushedTag: tag, resolveTag: () => changedSha}), /checked-out/);
  assert.throws(() => resolvePreflight({...preflight, isOnMain: () => false}), /origin\/main/);
  assert.throws(() => resolvePreflight({...preflight, pushedTag: tag, isOnMain: () => false}), /origin\/main/);
  for (const invalid of ['04.1.2', '1.0', '1.0.0-01', '1.0.0\n', 'v1.0.0']) assert.throws(() => resolvePreflight({...preflight, rootVersion: invalid, desktopVersion: invalid}), /version/);
});
test('Apple credential gate accepts only explicit boolean flags and never echoes their values', () => {
  const environment: NodeJS.ProcessEnv = Object.fromEntries(APPLE_SECRET_FLAGS.map(name => [name, 'true']));
  requireAppleSecrets(environment);
  for (const name of APPLE_SECRET_FLAGS) {
    assert.throws(() => requireAppleSecrets({...environment, [name]: 'synthetic-never-print-this-secret'}), error => error instanceof Error && error.message.includes(name.slice(4)) && !error.message.includes('synthetic-never-print-this-secret'));
  }
});

async function fixture(t: TestContext): Promise<{root: string; packageDirectory: string; output: string}> {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-actions-release-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packageDirectory = path.join(root, 'packages'), output = path.join(root, 'release');
  await mkdir(packageDirectory);
  await mkdir(output);
  return {root, packageDirectory, output};
}
async function stageTarget(f: {packageDirectory: string; output: string}, platform: ReleasePlatform, arch: ReleaseArch): Promise<void> {
  const name = `mioon-${version}-${platform === 'darwin' ? 'mac' : 'linux'}-${arch}.${platform === 'darwin' ? 'dmg' : 'tar.gz'}`;
  await writeFile(path.join(f.packageDirectory, name), `synthetic ${platform}-${arch} package`);
  const report = {ok: true, platform, arch};
  await stageRelease({platform, arch, packageDirectory: f.packageDirectory, output: path.join(f.output, `${platform}-${arch}`), sha, version, inspectionReport: report, smokeReport: report});
}
async function completeBundle(t: TestContext): Promise<{bundle: ReleaseBundle; output: string}> {
  const f = await fixture(t);
  await stageTarget(f, 'darwin', 'arm64');
  await stageTarget(f, 'darwin', 'x64');
  await stageTarget(f, 'linux', 'x64');
  return {bundle: await collectReleaseBundle(f.output, sha), output: f.output};
}
test('staging needs passing inspection and smoke reports for the exact target', async t => {
  const f = await fixture(t);
  const report = {ok: true, platform: 'linux', arch: 'x64'};
  assert.throws(() => validatePackageReport({...report, ok: false}, {platform: 'linux', arch: 'x64'}), /reports must pass/);
  assert.throws(() => validatePackageReport({...report, arch: 'arm64'}, {platform: 'linux', arch: 'x64'}), /exact target/);
  await assert.rejects(stageRelease({platform: 'linux', arch: 'x64', packageDirectory: f.packageDirectory, output: f.output, sha, version, inspectionReport: report, smokeReport: {...report, ok: false}}), /reports must pass/);
  await assert.rejects(stageRelease({platform: 'linux', arch: 'x64', packageDirectory: f.packageDirectory, output: f.output, sha, version, inspectionReport: report, smokeReport: report}), /exactly one package/);
  await stageTarget(f, 'linux', 'x64');
  const files = await readdir(path.join(f.output, 'linux-x64'));
  assert.deepEqual(files.sort(), ['manifest-linux-x64.json', 'mioon-0.4.1-linux-x64.tar.gz']);
});
test('staging rejects symlink packages and nonempty staging outputs', async t => {
  const f = await fixture(t), report = {ok: true, platform: 'linux', arch: 'x64'};
  const name = 'mioon-0.4.1-linux-x64.tar.gz';
  await writeFile(path.join(f.root, 'outside'), 'outside');
  // File symlinks need elevated privileges on Windows and are separately covered
  // on Unix; the same lstat rejection runs on every platform in production.
  if (process.platform !== 'win32') {
    await symlink(path.join(f.root, 'outside'), path.join(f.packageDirectory, name));
    await assert.rejects(stageRelease({platform: 'linux', arch: 'x64', packageDirectory: f.packageDirectory, output: f.output, sha, version, inspectionReport: report, smokeReport: report}), /regular release file/);
    await rm(path.join(f.packageDirectory, name));
  }
  await writeFile(path.join(f.packageDirectory, name), 'package');
  await writeFile(path.join(f.output, 'unexpected'), 'unrelated existing output');
  await assert.rejects(stageRelease({platform: 'linux', arch: 'x64', packageDirectory: f.packageDirectory, output: f.output, sha, version, inspectionReport: report, smokeReport: report}), /must be empty/);
});
test('bundle assembly includes only three packages, aggregate manifest and checksums', async t => {
  const {bundle, output} = await completeBundle(t);
  assert.equal(bundle.files.length, 5);
  assert.deepEqual(bundle.files.map(file => file.name).sort(), ['SHA256SUMS', 'mioon-0.4.1-linux-x64.tar.gz', 'mioon-0.4.1-mac-arm64.dmg', 'mioon-0.4.1-mac-x64.dmg', 'release-manifest.json'].sort());
  const sums = await readFile(path.join(output, 'SHA256SUMS'), 'utf8');
  for (const file of bundle.files.filter(file => file.name !== 'SHA256SUMS')) assert.ok(sums.includes(`${file.sha256}  ${file.name}\n`));
  assert.deepEqual(await collectReleaseBundle(output, sha), bundle, 'retry deterministically reuses generated files');
});
test('bundle assembly rejects missing targets, wrong source, hashes and extra files', async t => {
  const f = await fixture(t);
  await stageTarget(f, 'linux', 'x64');
  await assert.rejects(collectReleaseBundle(f.output, sha), /Missing target manifest/);
  await stageTarget(f, 'darwin', 'arm64'); await stageTarget(f, 'darwin', 'x64');
  await assert.rejects(collectReleaseBundle(f.output, changedSha), /source SHA or version differs/);
  const target = path.join(f.output, 'linux-x64', 'mioon-0.4.1-linux-x64.tar.gz');
  const bytes = await readFile(target); await writeFile(target, 'changed');
  await assert.rejects(collectReleaseBundle(f.output, sha), /size or SHA256 differs/);
  await writeFile(target, bytes);
  await writeFile(path.join(f.output, 'unintended-database.sqlite'), 'not a release artifact');
  await assert.rejects(collectReleaseBundle(f.output, sha), /Unexpected release input/);
});
test('bundle assembly rejects path traversal, duplicate manifests and symbolic links', async t => {
  const {output} = await completeBundle(t);
  const manifestFile = path.join(output, 'linux-x64', 'manifest-linux-x64.json');
  const manifest: Record<string, unknown> = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
  await writeFile(manifestFile, JSON.stringify({...manifest, name: '../mioon-0.4.1-linux-x64.tar.gz'}));
  await assert.rejects(collectReleaseBundle(output, sha), /Invalid package asset name/);
  await writeFile(manifestFile, JSON.stringify(manifest));
  await mkdir(path.join(output, 'duplicate'));
  await writeFile(path.join(output, 'duplicate', 'manifest-linux-x64.json'), JSON.stringify(manifest));
  await assert.rejects(collectReleaseBundle(output, sha), /Duplicate release input name/);
  await rm(path.join(output, 'duplicate'), {recursive: true});
  if (process.platform !== 'win32') {
    await symlink(manifestFile, path.join(output, 'unexpected-link'));
    await assert.rejects(collectReleaseBundle(output, sha), /symbolic links/);
  }
});

function fakeTransport(bundle: ReleaseBundle, initial?: DraftRelease): {transport: PublishTransport; state: {release: DraftRelease | undefined; assets: RemoteAsset[]; uploaded: string[]; published: boolean; prerelease: boolean | undefined; tagSha: string; hashFallbacks: number}} {
  const state = {release: initial, assets: [] as RemoteAsset[], uploaded: [] as string[], published: false, prerelease: undefined as boolean | undefined, tagSha: bundle.sourceSha, hashFallbacks: 0};
  const transport: PublishTransport = {
    remoteTagSha: async () => state.tagSha,
    loadRelease: async () => state.release,
    createDraft: async input => {
      assert.equal(state.release, undefined);
      state.release = {id: 41, tag_name: input.tag, target_commitish: input.sha, draft: true, body: input.body};
      return state.release;
    },
    assets: async () => state.assets,
    upload: async (_tag: string, file: UploadFile) => {state.uploaded.push(file.name); state.assets.push({id: state.assets.length + 1, name: file.name, size: file.bytes, digest: `sha256:${file.sha256}`});},
    digest: async asset => {state.hashFallbacks += 1; const file = bundle.files.find(file => file.name === asset.name)!; return {bytes: file.bytes, sha256: file.sha256};},
    publish: async (_id, prerelease) => {state.published = true; state.prerelease = prerelease;}
  };
  return {transport, state};
}
function ownedDraft(bundle: ReleaseBundle): DraftRelease {
  return {id: 41, tag_name: `v${bundle.version}`, target_commitish: bundle.sourceSha, draft: true, body: `Notes\n${ownershipMarker(`v${bundle.version}`, bundle)}`};
}
test('publication creates an owned draft, verifies five assets and publishes stable latest', async t => {
  const {bundle} = await completeBundle(t), f = fakeTransport(bundle);
  await publishRelease(bundle, tag, f.transport);
  assert.equal(f.state.published, true); assert.equal(f.state.prerelease, false); assert.equal(f.state.uploaded.length, 5);
  validateDraft(f.state.release!, tag, bundle);
});
test('publication resumes only the same owned draft and verifies existing asset bytes', async t => {
  const {bundle} = await completeBundle(t), f = fakeTransport(bundle, ownedDraft(bundle));
  const first = bundle.files[0]!;
  f.state.assets.push({id: 1, name: first.name, size: first.bytes, digest: null});
  await publishRelease(bundle, tag, f.transport);
  assert.equal(f.state.uploaded.length, 4); assert.equal(f.state.hashFallbacks, 2); assert.equal(f.state.published, true);
});
test('publication rejects public releases and drafts with different ownership', async t => {
  const {bundle} = await completeBundle(t);
  for (const release of [{...ownedDraft(bundle), draft: false}, {...ownedDraft(bundle), target_commitish: changedSha}, {...ownedDraft(bundle), body: 'unowned draft'}, {...ownedDraft(bundle), body: ownershipMarker(tag, {...bundle, manifestSha256: '0'.repeat(64)})}]) {
    const f = fakeTransport(bundle, release);
    await assert.rejects(publishRelease(bundle, tag, f.transport), /public|differs|not owned/);
    assert.equal(f.state.uploaded.length, 0); assert.equal(f.state.published, false);
  }
});
test('publication rejects moved tags before creation and immediately before publication', async t => {
  const {bundle} = await completeBundle(t), f = fakeTransport(bundle);
  f.state.tagSha = changedSha;
  await assert.rejects(publishRelease(bundle, tag, f.transport), /tag moved/);
  assert.equal(f.state.release, undefined);
  f.state.tagSha = sha;
  const upload = f.transport.upload;
  f.transport.upload = async (tag, file) => {await upload(tag, file); f.state.tagSha = changedSha;};
  await assert.rejects(publishRelease(bundle, tag, f.transport), /tag moved/);
  assert.equal(f.state.published, false);
});
test('publication rejects unexpected assets and corrupt remote assets without clobbering', async t => {
  const {bundle} = await completeBundle(t), first = bundle.files[0]!;
  for (const asset of [{id: 1, name: 'foreign.txt', size: 1}, {id: 1, name: first.name, size: first.bytes + 1}, {id: 1, name: first.name, size: first.bytes, digest: `sha256:${'f'.repeat(64)}`}]) {
    const f = fakeTransport(bundle, ownedDraft(bundle)); f.state.assets.push(asset);
    await assert.rejects(publishRelease(bundle, tag, f.transport), /unexpected|size differs|SHA256 differs/);
    assert.equal(f.state.uploaded.length, 0); assert.equal(f.state.published, false);
  }
});
test('publication refuses a lost upload, changed draft and wrong release tag', async t => {
  const {bundle} = await completeBundle(t);
  const missing = fakeTransport(bundle); missing.transport.upload = async () => undefined;
  await assert.rejects(publishRelease(bundle, tag, missing.transport), /missing uploaded assets/);
  assert.equal(missing.state.published, false);
  const changed = fakeTransport(bundle);
  const upload = changed.transport.upload;
  changed.transport.upload = async (tag, file) => {await upload(tag, file); if (changed.state.release) changed.state.release.body = 'changed';};
  await assert.rejects(publishRelease(bundle, tag, changed.transport), /not owned/);
  assert.equal(changed.state.published, false);
  await assert.rejects(publishRelease(bundle, 'v0.4.2', fakeTransport(bundle).transport), /tag does not match/);
});
test('prerelease publication never requests stable latest', async t => {
  const {bundle} = await completeBundle(t);
  const candidate: ReleaseBundle = {...bundle, version: '0.4.1-rc.1'};
  const f = fakeTransport(candidate);
  await publishRelease(candidate, 'v0.4.1-rc.1', f.transport);
  assert.equal(f.state.published, true); assert.equal(f.state.prerelease, true);
  assert.equal(hash(await readFile(bundle.files[0]!.file)), bundle.files[0]!.sha256);
});
