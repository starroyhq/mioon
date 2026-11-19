/** Classification for the "job was not acquired" retry plan.
 *
 * Drill phase: this script only classifies real workflow runs and writes the
 * evidence. It never calls a rerun API; the automatic rerun path stays disabled
 * until the coordinator approves the drill results.
 *
 * The plan only retries a run when `run_attempt === 1` and every non-aggregate
 * failed job was never assigned a runner (no steps, no runner name) and its
 * check-run annotation carries GitHub's "not acquired" message. A mixed run
 * (queue failures plus real failures), a real test failure, a second attempt or
 * anything the classifier cannot attribute is never retried.
 */
import {appendFile, readFile} from 'node:fs/promises';

export const NOT_ACQUIRED_ANNOTATION = 'The job was not acquired by Runner of type hosted even after multiple attempts';
export const AGGREGATE_GATE_JOB = 'CI';
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);

export interface RunJob {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly runner_name: string;
  readonly steps: readonly {readonly name: string; readonly conclusion: string | null}[];
  readonly check_run_url: string | null;
}

export type RetryVerdict = 'rerun' | 'skip-real-failure' | 'skip-mixed' | 'skip-unknown' | 'skip-not-first-attempt' | 'skip-no-failure';

export interface RetryClassification {
  readonly runId: number;
  readonly attempt: number;
  readonly verdict: RetryVerdict;
  readonly reason: string;
  readonly notAcquired: readonly string[];
  readonly realFailures: readonly string[];
  readonly unknownFailures: readonly string[];
  readonly gateFailures: readonly string[];
}

function isFailed(job: RunJob): boolean {
  return job.conclusion !== null && FAILED_CONCLUSIONS.has(job.conclusion);
}

/** A job that never reached a runner has no steps, no runner and the exact annotation. */
function isNotAcquired(job: RunJob, annotations: ReadonlyMap<number, readonly string[]>): boolean {
  return job.steps.length === 0 && job.runner_name === '' && (annotations.get(job.id) ?? []).some(message => message.includes(NOT_ACQUIRED_ANNOTATION));
}

export function classifyRunAttempt({runId, attempt, jobs, annotations}: {
  readonly runId: number;
  readonly attempt: number;
  readonly jobs: readonly RunJob[];
  readonly annotations: ReadonlyMap<number, readonly string[]>;
}): RetryClassification {
  const failed = jobs.filter(isFailed);
  const gateFailures = failed.filter(job => job.name === AGGREGATE_GATE_JOB).map(job => job.name);
  const candidates = failed.filter(job => job.name !== AGGREGATE_GATE_JOB);
  const notAcquired: string[] = [], realFailures: string[] = [], unknownFailures: string[] = [];
  for (const job of candidates) {
    if (isNotAcquired(job, annotations)) notAcquired.push(job.name);
    else if (job.steps.length > 0 || job.runner_name !== '') realFailures.push(job.name);
    else unknownFailures.push(job.name);
  }
  const base = {runId, attempt, notAcquired, realFailures, unknownFailures, gateFailures};
  if (attempt !== 1) return {...base, verdict: 'skip-not-first-attempt', reason: `attempt ${attempt} is not the first attempt; at most one retry per run`};
  if (!failed.length) return {...base, verdict: 'skip-no-failure', reason: 'the run has no failed jobs'};
  if (!candidates.length) return {...base, verdict: 'skip-unknown', reason: 'only the aggregate gate job failed; nothing can be attributed'};
  if (unknownFailures.length) return {...base, verdict: 'skip-unknown', reason: `cannot attribute ${unknownFailures.join(', ')}`};
  if (realFailures.length && notAcquired.length) return {...base, verdict: 'skip-mixed', reason: 'queue failures are mixed with real failures; rerunning would rerun real failures too'};
  if (realFailures.length) return {...base, verdict: 'skip-real-failure', reason: `real failure(s): ${realFailures.join(', ')}`};
  return {...base, verdict: 'rerun', reason: `every failed job was not acquired (${notAcquired.join(', ')})`};
}

interface ApiRun {readonly run_attempt: number}
interface ApiJobs {readonly total_count: number; readonly jobs: RunJob[]}
interface ApiAnnotation {readonly message: string}

function requireToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('MISSING_GITHUB_TOKEN');
  return token;
}

async function api<T>(pathname: string): Promise<T> {
  const response = await fetch(`https://api.github.com${pathname}`, {headers: {
    Authorization: `Bearer ${requireToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }});
  if (!response.ok) throw new Error(`GITHUB_API_${response.status}:${pathname}`);
  return await response.json() as T;
}

async function fetchAttemptJobs(repository: string, runId: number, attempt: number): Promise<RunJob[]> {
  const jobs: RunJob[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await api<ApiJobs>(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
    jobs.push(...data.jobs);
    if (jobs.length >= data.total_count || data.jobs.length < 100) break;
  }
  return jobs;
}

async function fetchAnnotations(job: RunJob): Promise<readonly string[]> {
  if (!job.check_run_url) return [];
  const pathname = new URL(job.check_run_url).pathname;
  const annotations = await api<ApiAnnotation[]>(`${pathname}/annotations?per_page=100`);
  return annotations.map(annotation => annotation.message);
}

export async function classifyRealRun(repository: string, runId: number, attempt: number): Promise<RetryClassification> {
  const run = await api<ApiRun>(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`);
  if (run.run_attempt !== attempt) throw new Error(`ATTEMPT_MISMATCH:${run.run_attempt}`);
  const jobs = await fetchAttemptJobs(repository, runId, attempt);
  const annotations = new Map<number, readonly string[]>();
  for (const job of jobs) {
    if (isFailed(job) && job.name !== AGGREGATE_GATE_JOB) annotations.set(job.id, await fetchAnnotations(job));
  }
  return classifyRunAttempt({runId, attempt, jobs, annotations});
}

export function renderSummary(classification: RetryClassification, expected?: string): string {
  const lines = [
    `### retry-not-acquired drill: run ${classification.runId} attempt ${classification.attempt}`,
    '',
    `- verdict: **${classification.verdict}**`,
    `- reason: ${classification.reason}`,
    `- not acquired: ${classification.notAcquired.length ? classification.notAcquired.join(', ') : '(none)'}`,
    `- real failures: ${classification.realFailures.length ? classification.realFailures.join(', ') : '(none)'}`,
    `- unknown failures: ${classification.unknownFailures.length ? classification.unknownFailures.join(', ') : '(none)'}`,
    `- aggregate gate failures: ${classification.gateFailures.length ? classification.gateFailures.join(', ') : '(none)'}`,
  ];
  if (expected) lines.push(`- expected: **${expected}** (${classification.verdict === expected ? 'PASS' : 'MISMATCH'})`);
  lines.push('- rerun API: **not called** (drill only)');
  return lines.join('\n') + '\n';
}

function repositoryFromEnvironment(): string {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('MISSING_GITHUB_REPOSITORY');
  return repository;
}

interface DrillEntry {readonly run_id: number; readonly attempt: number; readonly expect?: string}

async function appendSummary(text: string): Promise<void> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) await appendFile(target, text);
}

async function main(args: readonly string[]): Promise<number> {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z][a-z-]*)=(.+)$/u.exec(arg);
    if (match) values.set(match[1]!, match[2]!);
  }
  const repository = repositoryFromEnvironment();
  const drillFile = values.get('drill-file');
  const entries: DrillEntry[] = drillFile
    ? JSON.parse(await readFile(drillFile, 'utf8')) as DrillEntry[]
    : [{run_id: Number(values.get('run-id')), attempt: Number(values.get('attempt') ?? '1')}];
  if (!entries.length || entries.some(entry => !Number.isSafeInteger(entry.run_id) || !Number.isSafeInteger(entry.attempt))) throw new Error('INVALID_DRILL_INPUT');
  const classifications = [];
  for (const entry of entries) {
    const classification = await classifyRealRun(repository, entry.run_id, entry.attempt);
    classifications.push(classification);
    const summary = renderSummary(classification, entry.expect);
    await appendSummary(summary + '\n');
    process.stdout.write(JSON.stringify(classification) + '\n');
  }
  return classifications.length ? 0 : 2;
}

if (process.argv[1]?.endsWith('retry-not-acquired.ts')) {
  main(process.argv.slice(2)).then(code => {process.exitCode = code;}).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'UNEXPECTED_FAILURE');
    process.exitCode = 1;
  });
}
