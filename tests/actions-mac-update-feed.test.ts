import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {candidateUpdateFeedUrl, validateMacAppUpdateProvider, validateMacUpdateFeed} from '../.github/scripts/mac-update-feed.ts';
import {frozenBranchCandidate, resolvePreflight} from '../.github/scripts/release-preflight.ts';

test('the signed release step passes the final DMG as an absolute path to the stapler', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8');
  assert.match(workflow, /dmg="\$GITHUB_WORKSPACE\/release\/desktop\/production\/mioon-\$\{MIOON_RELEASE_VERSION\}-mac\.dmg"/);
  assert.match(workflow, /apple-notarization\.ts --operation=staple --artifact="\$dmg"/);
});

test('the arm64 release smoke measures first use after CLI notarization and before Gatekeeper inspection', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8');
  const notarization = workflow.indexOf('name: Notarize the signed CLI launcher separately');
  const smoke = workflow.indexOf('name: Smoke test the final DMG on Apple silicon');
  const inspection = workflow.indexOf('name: Inspect final package, signatures and resources');
  assert.ok(notarization >= 0 && notarization < smoke && smoke < inspection);
});

test('Intel can verify the signed DMG after an arm64 smoke failure, which still prevents release staging', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id: smoke\n[^\n]*\n\s*continue-on-error: true/);
  assert.match(workflow, /signed_package_available: \$\{\{ steps\.transfer\.outcome == 'success' \}\}/);
  const transfer = workflow.indexOf('id: transfer');
  const smokeGate = workflow.indexOf("if: steps.smoke.outcome == 'failure'");
  assert.ok(transfer >= 0 && transfer < smokeGate);
  assert.match(workflow, /needs\.desktop\.outputs\.signed_package_available == 'true'/);
  assert.match(workflow, /needs\.desktop\.result == 'success' && needs\.intel-smoke\.result == 'success'/);
});

test('candidate URLs use a safe directory base and allow local loopback HTTP', () => {
  assert.equal(candidateUpdateFeedUrl('https://example.test/updates'), 'https://example.test/updates/');
  assert.equal(candidateUpdateFeedUrl('http://127.0.0.1:8420/feed'), 'http://127.0.0.1:8420/feed/');
  assert.equal(candidateUpdateFeedUrl('http://[::1]:8420/'), 'http://[::1]:8420/');
  for (const url of [
    'http://example.test/feed', 'https:example.test', 'file:///tmp/feed', 'https://u:p@example.test/feed',
    'https://example.test/feed?key=value', 'https://example.test/#fragment', 'https://example.test/\nfeed',
    'https://example.test\\feed', ' https://example.test/feed',
  ]) assert.throws(() => candidateUpdateFeedUrl(url), /Candidate update feed must/);
});

test('candidate inputs cannot affect a tagged build or let an off-main tag publish', () => {
  const sha = 'a'.repeat(40), version = '0.2.0';
  const preflight = {rootVersion: version, desktopVersion: version, checkoutSha: sha, resolveTag: () => sha};
  const event = {GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_NAME: 'howard/mac-universal-update-feed', GITHUB_SHA: sha};
  const candidateBranch = frozenBranchCandidate(event, sha);
  assert.equal(candidateBranch, 'howard/mac-universal-update-feed');
  assert.equal(frozenBranchCandidate({...event, GITHUB_REF_NAME: 'some-other-branch'}, sha), undefined);
  assert.equal(frozenBranchCandidate({...event, GITHUB_REF_TYPE: 'tag'}, sha), undefined);
  assert.equal(frozenBranchCandidate(event, 'b'.repeat(40)), undefined);
  const candidate = resolvePreflight({...preflight, isOnMain: () => false, candidateBranch,
    updateFeedUrl: 'http://127.0.0.1:8420/feed', versionOverride: '0.3.0'});
  assert.equal(candidate.version, '0.3.0');
  assert.equal(candidate.should_publish, false);
  assert.throws(() => resolvePreflight({...preflight, isOnMain: () => false, candidateBranch,
    pushedTag: 'v0.2.0', versionOverride: '0.3.0'}), /origin\/main/);
  for (const tag of [{pushedTag: 'v0.2.0'}, {manualTag: 'v0.2.0'}]) {
    const tagged = resolvePreflight({...preflight, ...tag, isOnMain: () => true,
      updateFeedUrl: 'invalid URL', versionOverride: 'invalid version'});
    assert.equal(tagged.version, version);
    assert.equal(tagged.should_publish, true);
  }
  assert.throws(() => resolvePreflight({...preflight, isOnMain: () => true, versionOverride: '0.3.0-rc.1'}), /stable version/);
});

test('stapled ZIP feed binds the single plain ZIP name, length and both hashes to the packaged bytes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-update-feed-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const zip = 'mioon-0.2.0-mac.zip', metadata = path.join(directory, 'latest-mac.yml');
  const contents = Buffer.from('synthetic signed ZIP for feed integrity');
  const sha512 = createHash('sha512').update(contents).digest('base64');
  await writeFile(path.join(directory, zip), contents);
  await writeFile(path.join(directory, `${zip}.blockmap`), 'blockmap');
  const source = `version: 0.2.0\nfiles:\n  - url: ${zip}\n    sha512: ${sha512}\n    size: ${contents.length}\npath: ${zip}\nsha512: ${sha512}\nreleaseDate: '2026-11-16T00:00:00.000Z'\n`;
  await writeFile(metadata, source);
  await validateMacUpdateFeed(directory, '0.2.0');
  for (const invalid of [
    source.replace(zip, `../${zip}`), source.replace('version: 0.2.0', 'version: 0.2.1'),
    source.replace(`size: ${contents.length}`, 'size: 9999'), source.replace(`path: ${zip}`, 'path: https://example.test/file.zip'),
    source.replace(sha512, 'incorrect'), source.replace(`\nsha512: ${sha512}`, '\nsha512: wrong'),
    source.replace('  - url:', '  - url: extra.zip\n  - url:'), source + 'version: 0.2.0\n',
  ]) {
    await writeFile(metadata, invalid);
    await assert.rejects(validateMacUpdateFeed(directory, '0.2.0'));
  }
  await writeFile(metadata, source);
  await writeFile(path.join(directory, zip), Buffer.alloc(contents.length));
  await assert.rejects(validateMacUpdateFeed(directory, '0.2.0'), /SHA-512/);
});

test('a packaged updater has exactly the expected fixed GitHub or candidate provider', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-update-provider-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'app-update.yml');
  const stable = 'provider: github\nowner: starroyhq\nrepo: mioon\nreleaseType: release\nupdaterCacheDirName: mioon-desktop-updater\n';
  await writeFile(file, stable);
  await validateMacAppUpdateProvider(file);
  for (const invalid of [
    stable.replace('releaseType: release', 'releaseType: draft'), stable.replace('owner: starroyhq', 'owner: other'),
    stable + 'url: https://example.test/\n', stable + 'channel: beta\n', stable + 'provider: generic\n',
  ]) {
    await writeFile(file, invalid);
    await assert.rejects(validateMacAppUpdateProvider(file));
  }
  await writeFile(file, 'provider: generic\nurl: http://127.0.0.1:8420/\nupdaterCacheDirName: mioon-desktop-updater\n');
  await validateMacAppUpdateProvider(file, 'http://127.0.0.1:8420');
  await assert.rejects(validateMacAppUpdateProvider(file), /expected provider/);
});
