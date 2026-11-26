import {execFileSync} from 'node:child_process';
import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {jsonFile, object, releaseVersion, sourceSha} from './release-common.ts';
import {candidateUpdateFeedUrl} from './mac-update-feed.ts';

export const APPLE_SECRET_FLAGS = [
  'HAS_APPLE_CERTIFICATE', 'HAS_APPLE_CERTIFICATE_PASSWORD', 'HAS_APPLE_SIGNING_IDENTITY',
  'HAS_APPLE_TEAM_ID', 'HAS_APPLE_API_ISSUER', 'HAS_APPLE_API_KEY', 'HAS_APPLE_API_PRIVATE_KEY'
] as const;
export function requireAppleSecrets(environment: NodeJS.ProcessEnv): void {
  const missing = APPLE_SECRET_FLAGS.filter(name => environment[name] !== 'true');
  if (missing.length > 0) throw new Error(`Missing macOS release credentials: ${missing.map(name => name.slice(4)).join(', ')}`);
}
export function pushedTagForEvent(environment: NodeJS.ProcessEnv): string {
  return environment.GITHUB_EVENT_NAME === 'push' && environment.GITHUB_REF_TYPE === 'tag'
    ? environment.GITHUB_REF_NAME ?? '' : '';
}
function isBranchDispatch(environment: NodeJS.ProcessEnv): boolean {
  return environment.GITHUB_EVENT_NAME === 'workflow_dispatch' && environment.GITHUB_REF_TYPE === 'branch';
}
const UPDATE_FEED_CANDIDATE_BRANCH = 'howard/mac-universal-update-feed';
const CLI_PACKAGING_CANDIDATE_BRANCH = 'howard/k2c-packaging';
const CLI_PACKAGING_CANDIDATE_VERSION = '0.4.0-k2c.1';
type CandidateBranch = typeof UPDATE_FEED_CANDIDATE_BRANCH | typeof CLI_PACKAGING_CANDIDATE_BRANCH;

export function frozenBranchCandidate(environment: NodeJS.ProcessEnv, checkoutSha: string): CandidateBranch | undefined {
  const ref = environment.GITHUB_REF_NAME;
  if (!isBranchDispatch(environment) || environment.GITHUB_SHA !== checkoutSha) return undefined;
  return ref === UPDATE_FEED_CANDIDATE_BRANCH || ref === CLI_PACKAGING_CANDIDATE_BRANCH ? ref : undefined;
}
function candidateVersionOverride(value: unknown, branch?: CandidateBranch): string {
  const version = releaseVersion(value);
  if (branch === CLI_PACKAGING_CANDIDATE_BRANCH && version === CLI_PACKAGING_CANDIDATE_VERSION) return version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Candidate override must be a stable version or the reviewed K2-C version');
  return version;
}
export interface ReleasePreflightInput {
  rootVersion: unknown;
  desktopVersion: unknown;
  checkoutSha: unknown;
  manualTag?: string;
  pushedTag?: string;
  candidateBranch?: CandidateBranch;
  updateFeedUrl?: string;
  versionOverride?: string;
  resolveTag: (tag: string) => string;
  isOnMain: (sha: string) => boolean;
}
export interface ReleasePreflightResult {
  release_sha: string;
  version: string;
  release_tag: string;
  should_publish: boolean;
  prerelease: boolean;
}
export function resolvePreflight(input: ReleasePreflightInput): ReleasePreflightResult {
  const sourceVersion = releaseVersion(input.rootVersion), sha = sourceSha(input.checkoutSha);
  if (input.desktopVersion !== sourceVersion) throw new Error('Root and desktop package versions differ');
  const manual = input.manualTag?.trim() ?? '', pushed = input.pushedTag?.trim() ?? '';
  if (manual && pushed && manual !== pushed) throw new Error('Manual and pushed release tags differ');
  const tag = pushed || manual;
  if (tag && tag !== `v${sourceVersion}`) throw new Error('Release tag must equal v followed by the package version');
  if (tag && sourceSha(input.resolveTag(tag)) !== sha) throw new Error('Release tag does not point to the checked-out source SHA');
  if ((tag || !input.candidateBranch) && !input.isOnMain(sha)) throw new Error('Release source is not contained in origin/main');
  const version = !tag && input.versionOverride ? candidateVersionOverride(input.versionOverride, input.candidateBranch) : sourceVersion;
  if (!tag && input.updateFeedUrl) candidateUpdateFeedUrl(input.updateFeedUrl);
  if (tag && sourceVersion.split('+')[0]!.includes('-')) throw new Error('Prerelease desktop releases are not supported');
  return {release_sha: sha, version, release_tag: tag, should_publish: Boolean(tag), prerelease: version.split('+')[0]!.includes('-')};
}
export function gitText(args: string[], cwd = process.cwd()): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}
async function candidateInputs(environment: NodeJS.ProcessEnv): Promise<{updateFeedUrl?: string; versionOverride?: string}> {
  if (!isBranchDispatch(environment) || environment.MIOON_RELEASE_TAG || !environment.GITHUB_EVENT_PATH) return {};
  const event = object(await jsonFile(environment.GITHUB_EVENT_PATH));
  const inputs = object(event.inputs ?? {});
  const url = inputs.update_feed_url, version = inputs.version_override;
  if (url !== undefined && typeof url !== 'string' || version !== undefined && typeof version !== 'string') {
    throw new Error('Invalid candidate workflow inputs');
  }
  return {updateFeedUrl: url, versionOverride: version};
}
export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.argv.includes('--candidate-update-feed-url')) {
    const {updateFeedUrl} = await candidateInputs(environment);
    if (updateFeedUrl) process.stdout.write(candidateUpdateFeedUrl(updateFeedUrl));
    return;
  }
  if (process.argv.includes('--apply-candidate-version')) {
    if (!isBranchDispatch(environment) || environment.MIOON_RELEASE_TAG) throw new Error('Version override requires a candidate branch dispatch');
    const checkoutSha = gitText(['rev-parse', 'HEAD']);
    const version = candidateVersionOverride(environment.MIOON_RELEASE_VERSION, frozenBranchCandidate(environment, checkoutSha));
    for (const file of ['package.json', 'apps/desktop/package.json']) {
      const manifest = object(await jsonFile(file));
      await writeFile(file, `${JSON.stringify({...manifest, version}, null, 2)}\n`);
    }
    return;
  }
  if (process.argv.includes('--require-apple-secrets')) requireAppleSecrets(environment);
  const root = object(await jsonFile('package.json'));
  const desktop = object(await jsonFile('apps/desktop/package.json'));
  const checkoutSha = gitText(['rev-parse', 'HEAD']);
  // workflow_dispatch keeps GITHUB_SHA at the workflow ref even when checking out
  // an older release tag. The checkout, rather than the workflow ref, is frozen.
  if (environment.MIOON_CHECKOUT_SHA && sourceSha(environment.MIOON_CHECKOUT_SHA) !== checkoutSha) throw new Error('MIOON_CHECKOUT_SHA differs from the checked-out source SHA');
  const result = resolvePreflight({
    rootVersion: root.version, desktopVersion: desktop.version, checkoutSha,
    manualTag: environment.MIOON_RELEASE_TAG, pushedTag: pushedTagForEvent(environment),
    candidateBranch: frozenBranchCandidate(environment, checkoutSha),
    ...await candidateInputs(environment),
    resolveTag: tag => gitText(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]),
    isOnMain: sha => {
      try {execFileSync('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'], {stdio: 'ignore'}); return true;}
      catch {return false;}
    }
  });
  await mkdir('artifacts', {recursive: true});
  await writeFile(path.join('artifacts', 'release-preflight.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${String(value)}\n`).join(''));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;});
}
