/** Nightly gate: skip the macOS full-darwin run when main has not advanced
 * since the last successful nightly.
 *
 * The scheduled run compares the current `main` revision with the head revision
 * of the newest successful run of this workflow. Manual dispatches and branch
 * validation runs always execute; the gate only suppresses a redundant nightly.
 */
import {appendFile} from 'node:fs/promises';

export interface NightlyGateInput {
  readonly eventName: string;
  readonly currentMainSha: string;
  readonly latestSuccessSha: string | null;
}

export interface NightlyGateDecision {
  readonly run: boolean;
  readonly reason: string;
}

export function nightlyGate({eventName, currentMainSha, latestSuccessSha}: NightlyGateInput): NightlyGateDecision {
  if (!/^[a-f0-9]{40}$/u.test(currentMainSha)) throw new Error('INVALID_MAIN_SHA');
  if (eventName === 'workflow_dispatch' || eventName === 'push') {
    return {run: true, reason: `${eventName} runs the nightly unconditionally`};
  }
  if (eventName !== 'schedule') return {run: false, reason: `unsupported event ${eventName}`};
  if (latestSuccessSha === null) return {run: true, reason: 'no previous successful nightly run'};
  if (!/^[a-f0-9]{40}$/u.test(latestSuccessSha)) throw new Error('INVALID_SUCCESS_SHA');
  if (latestSuccessSha === currentMainSha) return {run: false, reason: `main ${currentMainSha} is unchanged since the last successful nightly run`};
  return {run: true, reason: `main advanced from ${latestSuccessSha} to ${currentMainSha}`};
}

function requireEnvironment(name: string): string {
  const value = process.env[name] ?? '';
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

async function api<T>(pathname: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('MISSING_GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com${pathname}`, {headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }});
  if (!response.ok) throw new Error(`GITHUB_API_${response.status}:${pathname}`);
  return await response.json() as T;
}

async function currentMainSha(repository: string): Promise<string> {
  const data = await api<{object?: {sha?: string}}>(`/repos/${repository}/git/ref/heads/main`);
  const sha = data.object?.sha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/u.test(sha)) throw new Error('INVALID_MAIN_SHA');
  return sha;
}

async function latestSuccessfulSha(repository: string, workflowFile: string): Promise<string | null> {
  if (!/^[a-z0-9-]+\.yml$/u.test(workflowFile)) throw new Error('INVALID_WORKFLOW_FILE');
  const data = await api<{workflow_runs?: {head_sha?: string}[]}>(`/repos/${repository}/actions/workflows/${workflowFile}/runs?status=success&per_page=1`);
  const sha = data.workflow_runs?.[0]?.head_sha;
  return typeof sha === 'string' ? sha : null;
}

function appendLines(file: string, lines: readonly string[]): Promise<void> {
  return appendFile(file, lines.join('')).catch(() => Promise.resolve());
}

async function main(): Promise<number> {
  const eventName = requireEnvironment('GITHUB_EVENT_NAME');
  const repository = requireEnvironment('GITHUB_REPOSITORY');
  const workflowFile = process.env.MACOS_NIGHTLY_WORKFLOW_FILE ?? 'macos-nightly.yml';
  const forceBranchRun = eventName !== 'schedule';
  const current = await currentMainSha(repository).catch(() => null);
  if (current === null) throw new Error('MAIN_REF_UNAVAILABLE');
  let latest: string | null = null;
  if (!forceBranchRun) latest = await latestSuccessfulSha(repository, workflowFile);
  const decision = nightlyGate({eventName, currentMainSha: current, latestSuccessSha: latest});
  const output = process.env.GITHUB_OUTPUT;
  if (output) await appendLines(output, [`run=${decision.run}\n`, `reason=${decision.reason}\n`]);
  const summary = `### macOS nightly gate\n\n- run: **${decision.run}**\n- reason: ${decision.reason}\n- main: ${current}\n- last successful nightly: ${latest ?? '(none)'}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendLines(process.env.GITHUB_STEP_SUMMARY, [summary]);
  process.stdout.write(summary);
  return 0;
}

if (process.argv[1]?.endsWith('macos-nightly-gate.ts')) {
  main().then(code => {process.exitCode = code;}).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'UNEXPECTED_FAILURE');
    process.exitCode = 1;
  });
}
