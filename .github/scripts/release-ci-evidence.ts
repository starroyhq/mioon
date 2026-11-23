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

/** One successful macOS nightly run for the exact release source. */
export interface MacosNightlyEvidence {
  readonly route: 'nightly';
  readonly runId: number;
  readonly attempt: number;
  readonly url: string;
}
/** Desktop-group fallback: from the reused main CI run, or from the complete
 * checks this release run is about to execute itself. Missing job evidence is
 * recorded as unavailable; it never changes the checks decision. */
export interface MacosDesktopEvidence {
  readonly route: 'desktop-group';
  readonly source: 'main-ci' | 'release-checks';
  readonly status: 'completed' | 'pending' | 'unavailable';
  readonly jobName?: string;
  readonly conclusion?: string;
  readonly url?: string;
}
export type MacosEvidence = MacosNightlyEvidence | MacosDesktopEvidence;

const MACOS_NIGHTLY_PATH = '.github/workflows/macos-nightly.yml';
const MACOS_NIGHTLY_NAME = 'macOS nightly full';
const desktopGroupJobName = /(?:^|\/ )macOS portable and desktop checks$/u;
const jobConclusions = new Set(['success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required']);

/** Same repository, main branch, exact SHA, completed successfully. */
export function findSuccessfulMacosNightly(response: unknown, {repository, sha, server}: Lookup): RunEvidence | undefined {
  const runs = record(response)?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error('Invalid workflow run list');
  for (const candidate of runs) {
    const run = record(candidate);
    if (!run || run.path !== MACOS_NIGHTLY_PATH || run.name !== MACOS_NIGHTLY_NAME ||
        run.head_sha !== sha || run.head_branch !== 'main' ||
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

/** The macOS desktop-group job inside one main CI run/attempt. */
export function findDesktopGroupEvidence(response: unknown, {repository, server}: Lookup, run: RunEvidence): MacosDesktopEvidence | undefined {
  const jobs = record(response)?.jobs;
  if (!Array.isArray(jobs)) throw new Error('Invalid workflow job list');
  for (const candidate of jobs) {
    const job = record(candidate);
    if (!job || typeof job.name !== 'string' || !desktopGroupJobName.test(job.name)) continue;
    if (typeof job.conclusion !== 'string' || !jobConclusions.has(job.conclusion)) continue;
    const id = job.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) continue;
    const url = new URL(`/${repository}/actions/runs/${run.runId}/job/${id}`, server).href;
    if (job.html_url !== url) continue;
    return {route: 'desktop-group', source: 'main-ci', status: 'completed', jobName: job.name, conclusion: job.conclusion, url};
  }
  return undefined;
}

/** Prefer the same-SHA nightly; otherwise record the desktop group without
 * changing any blocking behaviour. Any lookup error degrades to the fallback. */
export async function collectMacosEvidence(lookup: Lookup, decision: Decision,
  listNightly: () => Promise<unknown>, listDesktopJobs: (run: RunEvidence) => Promise<unknown>): Promise<MacosEvidence> {
  try {
    const nightly = findSuccessfulMacosNightly(await listNightly(), lookup);
    if (nightly) return {route: 'nightly', ...nightly};
  } catch { /* Fall back to the desktop group. */ }
  if (decision.mode === 'reuse') {
    try {
      const evidence = findDesktopGroupEvidence(await listDesktopJobs(decision.run), lookup, decision.run);
      if (evidence) return evidence;
    } catch { /* Evidence is informational; keep the existing checks decision. */ }
    return {route: 'desktop-group', source: 'main-ci', status: 'unavailable'};
  }
  return {route: 'desktop-group', source: 'release-checks', status: 'pending'};
}

export function renderMacosEvidence(evidence: MacosEvidence): string {
  if (evidence.route === 'nightly') return `macOS test evidence: nightly [${evidence.runId}](${evidence.url}), attempt ${evidence.attempt}.`;
  if (evidence.source === 'release-checks') return `macOS test evidence: desktop group from this release's complete checks.`;
  if (evidence.status === 'completed' && evidence.jobName && evidence.url) {
    return `macOS test evidence: desktop group from reused main CI job "${evidence.jobName}" (${evidence.conclusion}) [job](${evidence.url})`;
  }
  return 'macOS test evidence: desktop group from reused main CI (job evidence unavailable).';
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
  const token = env.GH_TOKEN;
  const lookupIdentity = {repository, sha, server};
  const fetchWorkflowRuns = async (workflow: string, params: Record<string, string>): Promise<unknown> => {
    if (!api.startsWith('https://') || !token) throw new Error('GitHub Actions read access unavailable');
    const url = new URL(`${api.replace(/\/$/u, '')}/repos/${repository}/actions/workflows/${workflow}/runs`);
    url.search = new URLSearchParams(params).toString();
    const response = await fetch(url, {headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`},
      redirect: 'error', signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw new Error('GitHub workflow lookup failed');
    return response.json() as Promise<unknown>;
  };
  const fetchRunJobs = async (run: RunEvidence): Promise<unknown> => {
    if (!api.startsWith('https://') || !token) throw new Error('GitHub Actions read access unavailable');
    const url = new URL(`${api.replace(/\/$/u, '')}/repos/${repository}/actions/runs/${run.runId}/attempts/${run.attempt}/jobs`);
    url.search = new URLSearchParams({per_page: '100'}).toString();
    const response = await fetch(url, {headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`},
      redirect: 'error', signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw new Error('GitHub workflow lookup failed');
    return response.json() as Promise<unknown>;
  };
  const decision = await decideChecks(lookupIdentity, env.FORCE_CHECKS === 'true', env.SAME_CHECKS_WORKFLOW === 'true',
    () => fetchWorkflowRuns('ci.yml', {branch: 'main', event: 'push', head_sha: sha, status: 'success', per_page: '100'}));
  const macos = await collectMacosEvidence(lookupIdentity, decision,
    () => fetchWorkflowRuns('macos-nightly.yml', {status: 'success', per_page: '100'}),
    run => fetchRunJobs(run));
  const file = 'artifacts/preflight/release-ci-evidence.json';
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, `${JSON.stringify({sourceSha: sha, ...decision, macos}, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `reuse_checks=${decision.mode === 'reuse'}\n`);
  const summary = decision.mode === 'reuse' ? `Reused main CI [${decision.run.runId}](${decision.run.url}), attempt ${decision.run.attempt}, source ${sha}.`
    : `Complete release checks required (${decision.reason}), source ${sha}.`;
  const macosSummary = renderMacosEvidence(macos);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n${macosSummary}\n`);
  console.log(`${summary}\n${macosSummary}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {console.error('Could not record release CI evidence'); process.exitCode = 1;});
}
