import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

interface Lookup {
  readonly repository: string;
  readonly sha: string;
  readonly server: string;
}
interface RunEvidence {
  readonly runId: number;
  readonly attempt: number;
  readonly url: string;
}
type Decision = {mode: 'reuse'; run: RunEvidence} |
  {mode: 'full'; reason: 'forced' | 'workflow-differs' | 'no-match' | 'lookup-unavailable'};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function findSuccessfulMainCI(response: unknown, {repository, sha, server}: Lookup): RunEvidence | undefined {
  const runs = record(response)?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error('Invalid workflow run list');
  for (const candidate of runs) {
    const run = record(candidate);
    if (!run || run.path !== '.github/workflows/ci.yml' || run.name !== 'CI' ||
        run.head_sha !== sha || run.head_branch !== 'main' || run.event !== 'push' ||
        run.status !== 'completed' || run.conclusion !== 'success' ||
        record(run.repository)?.full_name !== repository || record(run.head_repository)?.full_name !== repository) continue;
    const {id, run_attempt: attempt} = run;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 ||
        typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) continue;
    const url = new URL(`/${repository}/actions/runs/${id}`, server).href;
    if (run.html_url === url) return {runId: id, attempt, url};
  }
  return undefined;
}

export async function decideChecks(lookup: Lookup, forceChecks: boolean, sameChecks: boolean,
  listRuns: () => Promise<unknown>): Promise<Decision> {
  if (forceChecks) return {mode: 'full', reason: 'forced'};
  if (!sameChecks) return {mode: 'full', reason: 'workflow-differs'};
  try {
    const run = findSuccessfulMainCI(await listRuns(), lookup);
    return run ? {mode: 'reuse', run} : {mode: 'full', reason: 'no-match'};
  } catch {
    // API/network/response errors must keep the complete checks on the release path.
    return {mode: 'full', reason: 'lookup-unavailable'};
  }
}

async function main(env = process.env): Promise<void> {
  const repository = env.GITHUB_REPOSITORY ?? '', sha = env.MIOON_RELEASE_SHA ?? '';
  const server = env.GITHUB_SERVER_URL ?? '', api = env.GITHUB_API_URL ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[a-f0-9]{40}$/u.test(sha) || !server.startsWith('https://')) {
    throw new Error('Invalid release CI lookup identity');
  }
  const decision = await decideChecks({repository, sha, server}, env.FORCE_CHECKS === 'true', env.SAME_CHECKS_WORKFLOW === 'true', async () => {
    const token = env.GH_TOKEN;
    if (!api.startsWith('https://') || !token) throw new Error('GitHub Actions read access unavailable');
    const url = new URL(`${api.replace(/\/$/u, '')}/repos/${repository}/actions/workflows/ci.yml/runs`);
    url.search = new URLSearchParams({branch: 'main', event: 'push', head_sha: sha, status: 'success', per_page: '100'}).toString();
    const response = await fetch(url, {headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`},
      redirect: 'error', signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw new Error('GitHub workflow lookup failed');
    return response.json() as Promise<unknown>;
  });
  const file = 'artifacts/preflight/release-ci-evidence.json';
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, `${JSON.stringify({sourceSha: sha, ...decision}, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `reuse_checks=${decision.mode === 'reuse'}\n`);
  const summary = decision.mode === 'reuse' ? `Reused main CI [${decision.run.runId}](${decision.run.url}), attempt ${decision.run.attempt}, source ${sha}.`
    : `Complete release checks required (${decision.reason}), source ${sha}.`;
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {console.error('Could not record release CI evidence'); process.exitCode = 1;});
}
