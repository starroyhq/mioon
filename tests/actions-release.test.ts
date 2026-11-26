import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {APPLE_SECRET_FLAGS, frozenBranchCandidate, pushedTagForEvent, requireAppleSecrets, resolvePreflight} from '../.github/scripts/release-preflight.ts';
import {collectMacosEvidence, decideChecks, findDesktopGroupEvidence, findSuccessfulMainCI, findSuccessfulMacosNightly, renderMacosEvidence} from '../.github/scripts/release-ci-evidence.ts';
import {stageRelease, validateCliSmokeReport, validatePackageReport} from '../.github/scripts/stage-release.ts';
import {collectReleaseBundle, ownershipMarker, publishRelease, validateDraft} from '../.github/scripts/publish-release.ts';
import type {DraftRelease, PublishTransport, ReleaseBundle, RemoteAsset, UploadFile} from '../.github/scripts/publish-release.ts';
import type {ReleaseArch, ReleasePlatform} from '../.github/scripts/release-common.ts';
import {macArtifactNames, manifestName, validateAsset} from '../.github/scripts/release-common.ts';

const sha = '1'.repeat(40), changedSha = '2'.repeat(40), version = '0.4.1', tag = `v${version}`;
const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const names = macArtifactNames(version);
const dmgContents = 'synthetic universal DMG', zipContents = 'synthetic universal ZIP';
const stopped = {durationMs: 15, exitCode: 4, errorCode: 'CLI_RUNTIME_UNAVAILABLE'};
const cliSmoke = {
  schemaVersion: 1, channel: 'production', version, installLayout: 'copied-from-final-dmg', latencyBudgetMs: 1000,
  quarantine: {sourceApp: true, installedApp: true, launcher: false},
  firstStopped: {...stopped, withinBudget: true}, warmStoppedMs: [10, 12, 14],
  running: {versionMs: 18, doctorMs: 19, projectListMs: 20, mcpInitializeMs: 21, mcpToolsListMs: 22, mcpToolCount: 1},
  stoppedAfterQuit: stopped,
};
const report = (arch: ReleaseArch | 'arm64' | 'x64') => ({
  ok: true, platform: 'darwin', arch, package: {name: names.dmg, sha256: hash(dmgContents)},
  ...(arch === 'universal' ? {} : {cliLauncher: cliSmoke}),
});
const preflight = {rootVersion: version, desktopVersion: version, checkoutSha: sha, resolveTag: () => sha, isOnMain: () => true};

const ciLookup = {repository: 'owner/repo', sha, server: 'https://github.com'};
const ciRun = {
  id: 42, run_attempt: 1, html_url: 'https://github.com/owner/repo/actions/runs/42',
  head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
  name: 'CI', path: '.github/workflows/ci.yml', repository: {full_name: ciLookup.repository}, head_repository: {full_name: ciLookup.repository},
};

test('only a successful main push CI for the exact release source can supply reuse evidence', () => {
  const invalid = [
    {head_sha: changedSha}, {head_branch: 'other'}, {event: 'pull_request'}, {event: 'workflow_dispatch'},
    {status: 'in_progress'}, {conclusion: 'failure'}, {conclusion: 'cancelled'},
    {path: '.github/workflows/release-desktop.yml'}, {name: 'Other'}, {repository: {full_name: 'owner/other'}},
    {head_repository: {full_name: 'fork/repo'}}, {id: '42'}, {run_attempt: 0}, {html_url: 'https://example.test/actions/runs/42'},
  ].map(patch => ({...ciRun, ...patch}));
  assert.equal(findSuccessfulMainCI({workflow_runs: invalid}, ciLookup), undefined);
  assert.deepEqual(findSuccessfulMainCI({workflow_runs: [...invalid, {...ciRun, run_attempt: 2}]}, ciLookup),
    {runId: 42, attempt: 2, url: ciRun.html_url}, 'a successful rerun still proves the same frozen source');
});

test('forced, unmatched, incompatible or unavailable evidence requires full checks', async () => {
  const unused = async (): Promise<never> => assert.fail('the lookup must not be called');
  assert.deepEqual(await decideChecks(ciLookup, true, true, unused), {mode: 'full', reason: 'forced'});
  assert.deepEqual(await decideChecks(ciLookup, false, false, unused), {mode: 'full', reason: 'workflow-differs'});
  assert.deepEqual(await decideChecks(ciLookup, false, true, async () => ({workflow_runs: []})), {mode: 'full', reason: 'no-match'});
  assert.deepEqual(await decideChecks(ciLookup, false, true, async () => ({})), {mode: 'full', reason: 'lookup-unavailable'});
  assert.deepEqual(await decideChecks(ciLookup, false, true, async () => {throw Error('temporary API error');}),
    {mode: 'full', reason: 'lookup-unavailable'});
  assert.deepEqual(await decideChecks(ciLookup, false, true, async () => ({workflow_runs: [ciRun]})),
    {mode: 'reuse', run: {runId: 42, attempt: 1, url: ciRun.html_url}});
});

const nightlyRun = {
  id: 77, run_attempt: 1, html_url: 'https://github.com/owner/repo/actions/runs/77',
  head_sha: sha, head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success',
  name: 'macOS nightly full', path: '.github/workflows/macos-nightly.yml',
  repository: {full_name: ciLookup.repository}, head_repository: {full_name: ciLookup.repository},
};
const desktopJob = {
  id: 4242, name: 'Source checks / macOS portable and desktop checks', conclusion: 'success',
  html_url: 'https://github.com/owner/repo/actions/runs/42/job/4242',
};
const reuseDecision = {mode: 'reuse' as const, run: {runId: 42, attempt: 1, url: ciRun.html_url}};
const fullDecision = {mode: 'full' as const, reason: 'no-match' as const};

test('only a successful main-branch nightly for the exact source can supply macOS evidence', () => {
  const invalid = [
    {path: '.github/workflows/ci.yml'}, {name: 'CI'}, {head_sha: changedSha}, {head_branch: 'release'},
    {status: 'in_progress'}, {conclusion: 'failure'}, {conclusion: 'cancelled'},
    {repository: {full_name: 'owner/other'}}, {head_repository: {full_name: 'fork/repo'}},
    {id: '77'}, {run_attempt: 0}, {html_url: 'https://example.test/actions/runs/77'},
  ].map(patch => ({...nightlyRun, ...patch}));
  assert.equal(findSuccessfulMacosNightly({workflow_runs: invalid}, ciLookup), undefined);
  assert.deepEqual(findSuccessfulMacosNightly({workflow_runs: [...invalid, {...nightlyRun, run_attempt: 2}]}, ciLookup),
    {runId: 77, attempt: 2, url: nightlyRun.html_url});
});

test('the reused main CI desktop group is recorded from its exact job', () => {
  assert.deepEqual(findDesktopGroupEvidence({jobs: [desktopJob]}, ciLookup, reuseDecision.run), {
    route: 'desktop-group', source: 'main-ci', status: 'completed',
    jobName: 'Source checks / macOS portable and desktop checks', conclusion: 'success', url: desktopJob.html_url,
  });
  const invalid = [
    {name: 'Other job'}, {conclusion: 'mystery'}, {html_url: 'https://example.test/job/4242'}, {id: '4242'},
  ].map(patch => ({...desktopJob, ...patch}));
  assert.equal(findDesktopGroupEvidence({jobs: invalid}, ciLookup, reuseDecision.run), undefined);
  assert.throws(() => findDesktopGroupEvidence({}, ciLookup, reuseDecision.run), /Invalid workflow job list/);
});

test('macOS evidence prefers the nightly then falls back to the desktop group without new blocking', async () => {
  const unused = async (): Promise<never> => assert.fail('the desktop lookup must not be called');
  assert.deepEqual(await collectMacosEvidence(ciLookup, reuseDecision, async () => ({workflow_runs: [nightlyRun]}), unused),
    {route: 'nightly', runId: 77, attempt: 1, url: nightlyRun.html_url});
  assert.deepEqual(await collectMacosEvidence(ciLookup, reuseDecision, async () => ({workflow_runs: []}),
    async () => ({jobs: [desktopJob]})), {route: 'desktop-group', source: 'main-ci', status: 'completed',
    jobName: desktopJob.name, conclusion: 'success', url: desktopJob.html_url});
  assert.deepEqual(await collectMacosEvidence(ciLookup, fullDecision, async () => ({workflow_runs: []}), unused),
    {route: 'desktop-group', source: 'release-checks', status: 'pending'});
  assert.deepEqual(await collectMacosEvidence(ciLookup, fullDecision, async () => ({workflow_runs: [nightlyRun]}), unused),
    {route: 'nightly', runId: 77, attempt: 1, url: nightlyRun.html_url});
});

test('macOS evidence lookup failures degrade to recorded fallbacks, never to a new failure', async () => {
  assert.deepEqual(await collectMacosEvidence(ciLookup, reuseDecision, async () => {throw Error('nightly API error');},
    async () => ({jobs: [desktopJob]})), {route: 'desktop-group', source: 'main-ci', status: 'completed',
    jobName: desktopJob.name, conclusion: 'success', url: desktopJob.html_url});
  assert.deepEqual(await collectMacosEvidence(ciLookup, reuseDecision, async () => ({workflow_runs: []}),
    async () => {throw Error('jobs API error');}), {route: 'desktop-group', source: 'main-ci', status: 'unavailable'});
  assert.deepEqual(await collectMacosEvidence(ciLookup, reuseDecision, async () => {throw Error('nightly API error');},
    async () => ({jobs: []})), {route: 'desktop-group', source: 'main-ci', status: 'unavailable'});
  assert.deepEqual(await collectMacosEvidence(ciLookup, fullDecision, async () => {throw Error('nightly API error');}, async () => {throw Error('jobs');}),
    {route: 'desktop-group', source: 'release-checks', status: 'pending'});
});

test('macOS evidence summaries name the route, run, attempt and desktop job', () => {
  assert.match(renderMacosEvidence({route: 'nightly', runId: 77, attempt: 2, url: nightlyRun.html_url}), /nightly .*77.*attempt 2/i);
  assert.match(renderMacosEvidence({route: 'desktop-group', source: 'main-ci', status: 'completed',
    jobName: desktopJob.name, conclusion: 'success', url: desktopJob.html_url}), /desktop group from reused main CI job.*success.*job\/4242/i);
  assert.match(renderMacosEvidence({route: 'desktop-group', source: 'main-ci', status: 'unavailable'}), /unavailable/i);
  assert.match(renderMacosEvidence({route: 'desktop-group', source: 'release-checks', status: 'pending'}), /this release's complete checks/i);
});

test('release preflight freezes a valid release tag and main SHA', () => {
  assert.deepEqual(resolvePreflight({...preflight, pushedTag: tag}), {release_sha: sha, version, release_tag: tag, should_publish: true, prerelease: false});
  assert.equal(resolvePreflight({...preflight, manualTag: tag}).should_publish, true);
  assert.throws(() => resolvePreflight({...preflight, rootVersion: '1.2.0-rc.1+build', desktopVersion: '1.2.0-rc.1+build', manualTag: 'v1.2.0-rc.1+build'}), /Prerelease desktop releases are not supported/);
});
test('manual artifact-only run does not invent a tag or publish', () => {
  assert.deepEqual(resolvePreflight(preflight), {release_sha: sha, version, release_tag: '', should_publish: false, prerelease: false});
});
test('frozen candidate branch permits artifact verification before merge and validates candidate inputs', () => {
  const environment = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_NAME: 'howard/mac-universal-update-feed',
    GITHUB_SHA: sha,
  };
  assert.equal(frozenBranchCandidate(environment, sha), 'howard/mac-universal-update-feed');
  assert.equal(frozenBranchCandidate(environment, changedSha), undefined);
  assert.equal(frozenBranchCandidate({...environment, GITHUB_REF_NAME: 'other-branch'}, sha), undefined);
  assert.equal(frozenBranchCandidate({...environment, GITHUB_REF_TYPE: 'tag'}, sha), undefined);
  assert.equal(frozenBranchCandidate({...environment, GITHUB_EVENT_NAME: 'push'}, sha), undefined);
  const input = {...preflight, isOnMain: () => false, candidateBranch: frozenBranchCandidate(environment, sha)};
  assert.deepEqual(resolvePreflight({...input, updateFeedUrl: 'http://127.0.0.1:8080/updates', versionOverride: '0.4.2'}),
    {release_sha: sha, version: '0.4.2', release_tag: '', should_publish: false, prerelease: false});
  assert.throws(() => resolvePreflight({...input, updateFeedUrl: 'http://example.test/updates'}), /Candidate update feed/);
  assert.throws(() => resolvePreflight({...input, versionOverride: '0.4.2-rc.1'}), /stable version/);
  assert.throws(() => resolvePreflight({...input, pushedTag: tag}), /origin\/main/);
});
test('the exact K2-C prerelease is allowed only on its frozen artifact-only branch', () => {
  const environment = {GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_NAME: 'howard/k2c-packaging', GITHUB_SHA: sha};
  const candidateBranch = frozenBranchCandidate(environment, sha);
  assert.equal(candidateBranch, 'howard/k2c-packaging');
  const candidate = {...preflight, candidateBranch, isOnMain: () => false, versionOverride: '0.4.0-k2c.1'};
  assert.deepEqual(resolvePreflight(candidate),
    {release_sha: sha, version: '0.4.0-k2c.1', release_tag: '', should_publish: false, prerelease: true});
  assert.throws(() => resolvePreflight({...candidate, manualTag: tag}), /origin\/main/);
  assert.throws(() => resolvePreflight({...candidate, versionOverride: '0.4.0-k2c.2'}), /stable version/);
  assert.throws(() => resolvePreflight({...preflight, versionOverride: candidate.versionOverride}), /stable version/);
  assert.equal(frozenBranchCandidate(environment, changedSha), undefined);
});
test('tag builds ignore candidate feed and version inputs, keeping the exact tagged package version', () => {
  const inputs = {...preflight, updateFeedUrl: 'invalid candidate URL', versionOverride: 'invalid candidate version'};
  const expected = {release_sha: sha, version, release_tag: tag, should_publish: true, prerelease: false};
  assert.deepEqual(resolvePreflight({...inputs, pushedTag: tag}), expected);
  assert.deepEqual(resolvePreflight({...inputs, manualTag: tag}), expected);
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
function packageInput(f: {packageDirectory: string; output: string}) {
  return {
    platform: 'darwin' as const,
    arch: 'universal' as const,
    packageDirectory: f.packageDirectory,
    output: path.join(f.output, 'darwin-universal'),
    sha,
    version,
    inspectionReport: report('universal'),
    smokeReport: report('arm64'),
    intelSmokeReport: report('x64'),
  };
}
async function writePackages(packageDirectory: string, {dmgBlockmap = false, feedContents = zipContents} = {}): Promise<void> {
  const zipHash = createHash('sha512').update(feedContents).digest('base64');
  const update = [
    `version: ${version}`, 'files:', `  - url: ${names.zip}`, `    sha512: ${zipHash}`,
    `    size: ${Buffer.byteLength(feedContents)}`, `path: ${names.zip}`, `sha512: ${zipHash}`,
    "releaseDate: '2026-11-16T00:00:00.000Z'", '',
  ].join('\n');
  await writeFile(path.join(packageDirectory, names.dmg), dmgContents);
  await writeFile(path.join(packageDirectory, names.zip), zipContents);
  await writeFile(path.join(packageDirectory, names.zipBlockmap), 'synthetic ZIP blockmap');
  await writeFile(path.join(packageDirectory, names.update), update);
  if (dmgBlockmap) await writeFile(path.join(packageDirectory, names.dmgBlockmap), 'synthetic DMG blockmap');
}
async function stageTarget(f: {packageDirectory: string; output: string}, dmgBlockmap = false): Promise<void> {
  await writePackages(f.packageDirectory, {dmgBlockmap});
  await stageRelease(packageInput(f));
}
async function completeBundle(t: TestContext, dmgBlockmap = false): Promise<{bundle: ReleaseBundle; output: string; target: string}> {
  const f = await fixture(t);
  await stageTarget(f, dmgBlockmap);
  return {bundle: await collectReleaseBundle(f.output, sha), output: f.output, target: packageInput(f).output};
}
test('staging needs passing universal inspection and both native smoke reports for the exact DMG', async t => {
  const f = await fixture(t);
  const input = packageInput(f);
  assert.throws(() => validatePackageReport({...report('x64'), ok: false}, report('x64')), /reports must pass/);
  assert.throws(() => validatePackageReport(report('arm64'), report('x64')), /exact target/);
  await assert.rejects(stageRelease(input), /Missing release asset/);
  await writePackages(f.packageDirectory);
  await assert.rejects(stageRelease({...input, inspectionReport: report('arm64')}), /exact target: darwin-universal/);
  await assert.rejects(stageRelease({...input, smokeReport: {...report('arm64'), ok: false}}), /reports must pass/);
  await assert.rejects(stageRelease({...input, intelSmokeReport: report('arm64')}), /exact target: darwin-x64/);
  const intelOnOtherDmg = {...report('x64'), package: {name: names.dmg, sha256: hash('foreign DMG')}};
  await assert.rejects(stageRelease({...input, intelSmokeReport: intelOnOtherDmg}), /exact DMG/);
  await assert.rejects(stageRelease({...input, intelSmokeReport: {...report('x64'), cliLauncher: undefined}}), /CLI launcher smoke evidence is required: darwin-x64/);
  const assets = await stageRelease(input);
  const required = [names.dmg, names.zip, names.zipBlockmap, names.update];
  assert.deepEqual(assets.map(asset => asset.name), required);
  assert.deepEqual((await readdir(input.output)).sort(), [...required, ...required.map(manifestName)].sort());
});
test('staging requires matching CLI timing and failure evidence but preserves measured slow candidates', () => {
  const firstStopped = {...stopped, durationMs: 1300, withinBudget: false};
  assert.throws(() => validateCliSmokeReport({cliLauncher: {...cliSmoke, firstStopped}}, version, 'arm64'), /Invalid CLI launcher smoke evidence/);
  const slow = {...cliSmoke, firstStopped, slowFirstLaunch: {systemLog: 'no-launch-specific-events'}};
  validateCliSmokeReport({cliLauncher: slow}, version, 'arm64');
  for (const override of [
    {version: '0.4.0'}, {firstStopped: {...firstStopped, withinBudget: true}}, {warmStoppedMs: [10]},
    {running: {...cliSmoke.running, mcpToolCount: 0}}, {stoppedAfterQuit: {...stopped, exitCode: 0}},
  ]) assert.throws(() => validateCliSmokeReport({cliLauncher: {...slow, ...override}}, version, 'arm64'), /Invalid CLI launcher smoke evidence/);
});
test('staging rejects symlink packages and nonempty staging outputs', async t => {
  const f = await fixture(t), input = packageInput(f), dmg = path.join(f.packageDirectory, names.dmg);
  await writePackages(f.packageDirectory);
  await writeFile(path.join(f.root, 'outside'), 'outside');
  // File symlinks need elevated privileges on Windows and are separately covered
  // on Unix; the same lstat rejection runs on every platform in production.
  if (process.platform !== 'win32') {
    await rm(dmg);
    await symlink(path.join(f.root, 'outside'), dmg);
    await assert.rejects(stageRelease(input), /regular release file/);
    await rm(dmg);
    await writeFile(dmg, dmgContents);
  }
  await mkdir(input.output);
  await writeFile(path.join(input.output, 'unexpected'), 'unrelated existing output');
  await assert.rejects(stageRelease(input), /must be empty/);
});
test('bundle assembly includes one macOS target, all update assets, per-asset manifests and checksums', async t => {
  const {bundle, output} = await completeBundle(t, true);
  const expected = [names.dmg, names.dmgBlockmap, names.zip, names.zipBlockmap, names.update];
  assert.equal(bundle.files.length, 12);
  assert.deepEqual(bundle.files.map(file => file.name).sort(), ['SHA256SUMS', 'release-manifest.json', ...expected, ...expected.map(manifestName)].sort());
  assert.deepEqual([...new Set(bundle.manifest.assets.map(asset => `${asset.platform}-${asset.arch}`))], ['darwin-universal']);
  assert.deepEqual(bundle.manifest.assets.map(asset => asset.name).sort(), expected.sort());
  for (const asset of bundle.manifest.assets) {
    const sidecar = bundle.files.find(file => file.name === manifestName(asset.name))!;
    assert.deepEqual(asset.manifest, {name: sidecar.name, bytes: sidecar.bytes, sha256: sidecar.sha256});
  }
  const sums = await readFile(path.join(output, 'SHA256SUMS'), 'utf8');
  for (const file of bundle.files.filter(file => file.name !== 'SHA256SUMS')) assert.ok(sums.includes(`${file.sha256}  ${file.name}\n`));
  assert.deepEqual(await collectReleaseBundle(output, sha), bundle, 'retry deterministically reuses generated files');
});
test('bundle assembly rejects missing target, wrong source, hashes and extra files', async t => {
  const f = await fixture(t);
  await assert.rejects(collectReleaseBundle(f.output, sha), /Missing asset manifest for the darwin-universal target/);
  await stageTarget(f);
  await assert.rejects(collectReleaseBundle(f.output, changedSha), /source SHA or version differs/);
  const target = path.join(packageInput(f).output, names.dmg);
  const bytes = await readFile(target); await writeFile(target, 'changed');
  await assert.rejects(collectReleaseBundle(f.output, sha), /size or SHA256 differs/);
  await writeFile(target, bytes);
  await writeFile(path.join(f.output, 'unintended-database.sqlite'), 'not a release artifact');
  await assert.rejects(collectReleaseBundle(f.output, sha), /Unexpected release input/);
});
test('required update files must all be staged while a DMG blockmap is optional', async t => {
  const f = await fixture(t);
  await stageTarget(f);
  const bundle = await collectReleaseBundle(f.output, sha);
  assert.ok(!bundle.files.some(file => file.name === names.dmgBlockmap || file.name === manifestName(names.dmgBlockmap)));
  for (const name of [names.dmg, names.zip, names.zipBlockmap, names.update]) {
    const staged = path.join(packageInput(f).output, name), original = await readFile(staged);
    await rm(staged);
    await assert.rejects(collectReleaseBundle(f.output, sha), /Missing release asset/);
    await writeFile(staged, original);
  }
});
test('single-architecture and Linux packages are refused at every release boundary', async t => {
  const f = await fixture(t), linux = {sourceSha: sha, version, platform: 'linux', arch: 'x64', name: `mioon-${version}-linux-x64.tar.gz`, bytes: 10, sha256: hash('linux-only')};
  assert.throws(() => validateAsset(linux), /Only macOS/);
  for (const arch of ['arm64', 'x64']) {
    assert.throws(() => validateAsset({...linux, platform: 'darwin', arch}), /expected universal/);
    await assert.rejects(stageRelease({...packageInput(f), arch: arch as ReleaseArch}), /expected universal/);
  }
  await assert.rejects(stageRelease({...packageInput(f), platform: 'linux' as ReleasePlatform}), /Only macOS/);
  const {output, target} = await completeBundle(t);
  const manifestFile = path.join(target, manifestName(names.dmg));
  const original = await readFile(manifestFile, 'utf8');
  await writeFile(manifestFile, JSON.stringify(linux));
  await assert.rejects(collectReleaseBundle(output, sha), /Only macOS/);
  await writeFile(manifestFile, original);
  await writeFile(path.join(output, linux.name), 'linux-only');
  await assert.rejects(collectReleaseBundle(output, sha), /Unexpected release input/);
});
test('bundle assembly refuses split macOS targets, mismatched asset sidecars and a same-size DMG hash mismatch', async t => {
  const {output, target} = await completeBundle(t);
  const dmgManifest = path.join(target, manifestName(names.dmg));
  const zipManifest = path.join(target, manifestName(names.zip));
  const original = await readFile(dmgManifest, 'utf8');
  await writeFile(dmgManifest, await readFile(zipManifest));
  await assert.rejects(collectReleaseBundle(output, sha), /Asset manifest does not match/);
  await writeFile(dmgManifest, original);
  const otherTarget = path.join(output, 'another-target');
  await mkdir(otherTarget);
  await rename(zipManifest, path.join(otherTarget, manifestName(names.zip)));
  await assert.rejects(collectReleaseBundle(output, sha), /Exactly one macOS release target/);
  await rename(path.join(otherTarget, manifestName(names.zip)), zipManifest);
  const dmg = path.join(target, names.dmg), bytes = await readFile(dmg);
  bytes[0] ^= 1;
  await writeFile(dmg, bytes);
  await assert.rejects(collectReleaseBundle(output, sha), /size or SHA256 differs/);
});
test('bundle assembly rejects path traversal, duplicate manifests and symbolic links', async t => {
  const {output, target} = await completeBundle(t);
  const sidecar = manifestName(names.dmg), manifestFile = path.join(target, sidecar);
  const manifest: Record<string, unknown> = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
  await writeFile(manifestFile, JSON.stringify({...manifest, name: `../${names.dmg}`}));
  await assert.rejects(collectReleaseBundle(output, sha), /Invalid package asset name/);
  await writeFile(manifestFile, JSON.stringify(manifest));
  await mkdir(path.join(output, 'duplicate'));
  await writeFile(path.join(output, 'duplicate', sidecar), JSON.stringify(manifest));
  await assert.rejects(collectReleaseBundle(output, sha), /Duplicate release input name/);
  await rm(path.join(output, 'duplicate'), {recursive: true});
  if (process.platform !== 'win32') {
    await symlink(manifestFile, path.join(output, 'unexpected-link'));
    await assert.rejects(collectReleaseBundle(output, sha), /symbolic links/);
  }
});

test('staging and collection both reject metadata generated for a different ZIP', async t => {
  const f = await fixture(t);
  await writePackages(f.packageDirectory, {feedContents: 'an earlier ZIP'});
  await assert.rejects(stageRelease(packageInput(f)), /ZIP|sha512/i);
  const {output, target} = await completeBundle(t);
  await writePackages(target, {feedContents: 'an earlier ZIP'});
  const manifestFile = path.join(target, manifestName(names.update));
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
  const metadata = await readFile(path.join(target, names.update));
  await writeFile(manifestFile, JSON.stringify({...manifest, bytes: metadata.length, sha256: hash(metadata)}));
  await assert.rejects(collectReleaseBundle(output, sha), /ZIP|sha512/i);
});

function fakeTransport(bundle: ReleaseBundle, initial?: DraftRelease): {transport: PublishTransport; state: {release: DraftRelease | undefined; assets: RemoteAsset[]; uploaded: string[]; published: boolean; prerelease: boolean | undefined; tagSha: string; hashFallbacks: number}} {
  const state = {release: initial, assets: [] as RemoteAsset[], uploaded: [] as string[], published: false, prerelease: undefined as boolean | undefined, tagSha: bundle.sourceSha, hashFallbacks: 0};
  const transport: PublishTransport = {
    remoteTagSha: async () => state.tagSha,
    loadRelease: async () => state.release,
    createDraft: async input => {
      assert.equal(state.release, undefined);
      assert.equal(input.prerelease, false);
      state.release = {id: 41, tag_name: input.tag, target_commitish: input.sha, draft: true, prerelease: input.prerelease, body: input.body};
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
  return {id: 41, tag_name: `v${bundle.version}`, target_commitish: bundle.sourceSha, draft: true, prerelease: false, body: `Notes\n${ownershipMarker(`v${bundle.version}`, bundle)}`};
}
test('publication creates an owned draft, verifies all staged files and publishes stable latest', async t => {
  const {bundle} = await completeBundle(t), f = fakeTransport(bundle);
  await publishRelease(bundle, tag, f.transport);
  assert.equal(f.state.published, true); assert.equal(f.state.prerelease, false);
  assert.deepEqual(f.state.uploaded, bundle.files.map(file => file.name));
  validateDraft(f.state.release!, tag, bundle);
});
test('publication resumes only the same owned draft and verifies existing asset bytes', async t => {
  const {bundle} = await completeBundle(t), f = fakeTransport(bundle, ownedDraft(bundle));
  const first = bundle.files[0]!;
  f.state.assets.push({id: 1, name: first.name, size: first.bytes, digest: null});
  await publishRelease(bundle, tag, f.transport);
  assert.equal(f.state.uploaded.length, bundle.files.length - 1); assert.equal(f.state.hashFallbacks, 2); assert.equal(f.state.published, true);
});
test('publication rejects public releases and drafts with different ownership', async t => {
  const {bundle} = await completeBundle(t);
  for (const release of [{...ownedDraft(bundle), draft: false}, {...ownedDraft(bundle), prerelease: true}, {...ownedDraft(bundle), target_commitish: changedSha}, {...ownedDraft(bundle), body: 'unowned draft'}, {...ownedDraft(bundle), body: ownershipMarker(tag, {...bundle, manifestSha256: '0'.repeat(64)})}]) {
    const f = fakeTransport(bundle, release);
    await assert.rejects(publishRelease(bundle, tag, f.transport), /public|Prerelease|differs|not owned/);
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
test('publication rejects a prerelease before reading or creating a draft', async t => {
  const {bundle} = await completeBundle(t);
  const candidate: ReleaseBundle = {...bundle, version: '0.4.1-rc.1'};
  const f = fakeTransport(candidate);
  f.transport.loadRelease = async () => assert.fail('prerelease should fail before remote draft access');
  await assert.rejects(publishRelease(candidate, 'v0.4.1-rc.1', f.transport), /Prerelease desktop releases are not supported/);
  assert.equal(f.state.published, false); assert.equal(f.state.release, undefined);
  assert.equal(hash(await readFile(bundle.files[0]!.file)), bundle.files[0]!.sha256);
});
