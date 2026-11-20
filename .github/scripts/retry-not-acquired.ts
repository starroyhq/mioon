/**
 * Classification and retry for the "job was not acquired" retry plan.
 *
 * The manual `workflow_dispatch` path only classifies and writes evidence
 * (read-only token). The automatic `workflow_run` path may call
 * `rerun-failed-jobs`, but only for a run whose `run_attempt` is 1 and where
 * every non-aggregate failed job was never assigned a runner (no steps, no
 * runner name) and its check-run annotation carries GitHub's "not acquired"
 * message. A mixed run (queue failures plus real failures), a real test
 * failure, a second attempt or anything the classifier cannot attribute is
 * never retried.
 *
 * The run id and attempt arrive through validated environment variables, never
 * through shell interpolation, and this file always runs from the default
 * branch checkout.
 */
import {appendFile} from 'node:fs/promises';

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

export interface RerunOutcome {
  readonly called: boolean;
  readonly error?: string;
}

export interface SummaryOptions {
  readonly execute: boolean;
  readonly outcome: RerunOutcome;
  readonly expected?: string;
}

export function renderSummary(classification: RetryClassification, {execute, outcome, expected}: SummaryOptions): string {
  const lines = [
    `### retry-not-acquired: run ${classification.runId} attempt ${classification.attempt}`,
    '',
    `- verdict: **${classification.verdict}**`,
    `- reason: ${classification.reason}`,
    `- not acquired: ${classification.notAcquired.length ? classification.notAcquired.join(', ') : '(none)'}`,
    `- real failures: ${classification.realFailures.length ? classification.realFailures.join(', ') : '(none)'}`,
    `- unknown failures: ${classification.unknownFailures.length ? classification.unknownFailures.join(', ') : '(none)'}`,
    `- aggregate gate failures: ${classification.gateFailures.length ? classification.gateFailures.join(', ') : '(none)'}`,
  ];
  if (expected) lines.push(`- expected: **${expected}** (${classification.verdict === expected ? 'PASS' : 'MISMATCH'})`);
  const rerun = outcome.called
    ? '**called** (rerun-failed-jobs accepted)'
    : outcome.error
      ? `**failed** (${outcome.error})`
      : execute
        ? `**not called** (${classification.verdict})`
        : '**not called** (manual read-only drill)';
  lines.push(`- rerun API: ${rerun}`);
  return lines.join('\n') + '\n';
}

export async function maybeRerun(classification: RetryClassification, {execute, repository, rerunFailedJobs}: {
  readonly execute: boolean;
  readonly repository: string;
  readonly rerunFailedJobs: (repository: string, runId: number) => Promise<void>;
}): Promise<RerunOutcome> {
  if (!execute || classification.verdict !== 'rerun') return {called: false};
  try {
    await rerunFailedJobs(repository, classification.runId);
    return {called: true};
  } catch (error) {
    return {called: false, error: error instanceof Error ? error.message : 'RERUN_FAILED'};
  }
}

/** Digits-only validation for ids that arrive through the environment. */
export function parsePositiveInteger(name: string, raw: string | undefined): number {
  if (raw === undefined || !/^[1-9][0-9]*$/u.test(raw)) throw new Error(`INVALID_${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`INVALID_${name}`);
  return value;
}

function repositoryFromEnvironment(): string {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('MISSING_GITHUB_REPOSITORY');
  return repository;
}

async function rerunFailedJobs(repository: string, runId: number): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/rerun-failed-jobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Length': '0',
    },
  });
  if (response.status !== 201) throw new Error(`RERUN_FAILED_${response.status}`);
}

async function appendSummary(text: string): Promise<void> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) await appendFile(target, text);
}

async function main(args: readonly string[]): Promise<number> {
  const execute = args.includes('--execute');
  const repository = repositoryFromEnvironment();
  const runId = parsePositiveInteger('RETRY_RUN_ID', process.env.RETRY_RUN_ID);
  const attempt = parsePositiveInteger('RETRY_RUN_ATTEMPT', process.env.RETRY_RUN_ATTEMPT);
  const classification = await classifyRealRun(repository, runId, attempt);
  const outcome = await maybeRerun(classification, {execute, repository, rerunFailedJobs});
  const summary = renderSummary(classification, {execute, outcome});
  await appendSummary(summary + '\n');
  process.stdout.write(summary + '\n');
  process.stdout.write(JSON.stringify({...classification, rerun: outcome}) + '\n');
  if (outcome.error) throw new Error(outcome.error);
  return 0;
}

if (process.argv[1]?.endsWith('retry-not-acquired.ts')) {
  main(process.argv.slice(2)).then(code => {process.exitCode = code;}).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'UNEXPECTED_FAILURE');
    process.exitCode = 1;
  });
}
