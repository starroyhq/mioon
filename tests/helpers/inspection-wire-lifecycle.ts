import {spawn} from 'node:child_process';
import type {Readable} from 'node:stream';

export const CLI_PROCESS_TIMEOUT_MS = 10_000;
const stages = new Set(['preloaded', 'compile-cache-active', 'compile-cache-disabled', 'fetch-start', 'fetch-headers', 'fetch-rejected']);

export interface InspectionStageObservation {readonly stage: string; readonly elapsedMs: number}
export interface InspectionExit {
  readonly code: number|null;
  readonly signal: NodeJS.Signals|null;
  readonly elapsedMs: number;
}
export interface InspectionCleanup {killSent: boolean; reaped: boolean; pipesDestroyed: boolean}
export interface InspectionDiagnostics {
  readonly reason: string;
  readonly timeoutFired: boolean;
  readonly deadlineMs: number;
  readonly elapsedMs: number;
  readonly spawnedAtMs: number|null;
  readonly phase: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly envelopeAtMs: number|null;
  readonly observations: InspectionStageObservation[];
  readonly exit: InspectionExit|null;
  readonly close: InspectionExit|null;
  readonly spawnErrorCode: string|null;
  cleanup?: InspectionCleanup;
}
export interface InspectionRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly executable?: string;
}
export interface InspectionRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number|null;
  readonly signal: NodeJS.Signals|null;
  readonly diagnostics: InspectionDiagnostics;
}
export class InspectionProcessError extends Error {
  readonly diagnostics: InspectionDiagnostics;
  constructor(diagnostics: InspectionDiagnostics, options?: ErrorOptions) {
    super(`Inspection CLI ${diagnostics.reason}: ${JSON.stringify(diagnostics)}`, options);
    this.name = 'InspectionProcessError';
    this.diagnostics = diagnostics;
  }
}

// Observe the exact child and all of its pipes. A result envelope, OS exit and
// stdio close are separate milestones; none substitutes for normal completion.
export async function runInspectionProcess(args: readonly string[], {
  cwd, env, signal, timeoutMs = CLI_PROCESS_TIMEOUT_MS, executable = process.execPath,
}: InspectionRunOptions = {}): Promise<InspectionRunResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let stdout = '', stderr = '', trace = '', envelopeAtMs: number|null = null, spawnedAtMs: number|null = null;
  let exit: InspectionExit|null = null, close: InspectionExit|null = null, spawnErrorCode: string|null = null;
  const observations: InspectionStageObservation[] = [];
  const child = spawn(executable, [...args], {cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe']});
  let closed: (()=>void)|null = null;
  const closedPromise = new Promise<void>(resolve => { closed = resolve; });
  child.once('spawn', () => { spawnedAtMs = elapsed(); });
  child.once('exit', (code, signalValue) => { exit = {code, signal: signalValue, elapsedMs: elapsed()}; });
  child.once('close', (code, signalValue) => { close = {code, signal: signalValue, elapsedMs: elapsed()}; closed?.(); });
  child.once('error', (error: Error) => {
    // Spawn errors can contain executable paths. Keep only a bounded code.
    const code = (error as {code?: unknown}).code;
    if (spawnedAtMs === null) spawnErrorCode = typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'SPAWN_ERROR';
  });
  const childStdout = child.stdout as unknown as Readable, childStderr = child.stderr as unknown as Readable;
  childStdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (envelopeAtMs !== null || !stdout.includes('\n')) return;
    try { if (typeof JSON.parse(stdout).ok === 'boolean') envelopeAtMs = elapsed(); } catch { /* not an envelope yet */ }
  });
  childStderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const stream = child.stdio[3] as unknown as Readable;
  stream.setEncoding('utf8').on('data', (chunk: string) => {
    // This dedicated pipe accepts fixed stage names only, never child payloads.
    trace = (trace + chunk).slice(-2048);
    let newline;
    while ((newline = trace.indexOf('\n')) !== -1) {
      const stage = trace.slice(0, newline); trace = trace.slice(newline + 1);
      if (stages.has(stage) && observations.length < 12) observations.push({stage, elapsedMs: elapsed()});
    }
  });
  let timer: ReturnType<typeof setTimeout>|undefined, cancel: (()=>void)|undefined;
  const failure = new Promise<string>(resolve => {
    timer = setTimeout(() => resolve('process-deadline'), timeoutMs);
    cancel = () => resolve('outer-test-abort');
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
  });
  const snapshot = (reason: string): InspectionDiagnostics => ({reason, timeoutFired: reason === 'process-deadline', deadlineMs: timeoutMs, elapsedMs: elapsed(), spawnedAtMs,
    phase: exit ? 'stdio-close' : envelopeAtMs !== null ? 'process-exit' :
      observations.some(value => value.stage === 'fetch-headers') ? 'response-body-or-envelope' :
      observations.some(value => value.stage === 'fetch-start') ? 'request' :
      observations.some(value => value.stage === 'preloaded') ? 'command' : 'startup',
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    envelopeAtMs, observations: observations.map(value => ({...value})), exit, close, spawnErrorCode});
  let reason: string|null;
  try { reason = await Promise.race([closedPromise.then(() => null), failure]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
  if (!reason && !spawnErrorCode && !(close as InspectionExit|null)?.signal) { const finished = close as InspectionExit|null; return {stdout, stderr, code: finished?.code ?? null, signal: finished?.signal ?? null,
    diagnostics: snapshot('completed')}; }

  // Freeze failure evidence before cleanup: SIGKILL is recovery, not evidence
  // that a child had failed to exit before the original deadline.
  const diagnostics = snapshot(reason || (spawnErrorCode ? 'spawn-error' : 'process-signal'));
  const cleanup: InspectionCleanup = {killSent: false, reaped: false, pipesDestroyed: false};
  if (!close) {
    if (!exit && !spawnErrorCode) cleanup.killSent = child.kill('SIGKILL');
    // A child can exit while a descendant retains its inherited stdout. Close
    // this owner's pipe handles too; a close event alone would hide that cause.
    if (exit) {
      for (const pipe of child.stdio) pipe?.destroy();
      cleanup.pipesDestroyed = true;
    }
    let cleanupTimer: ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([closedPromise, new Promise<void>(resolve => {
        cleanupTimer = setTimeout(resolve, 1000);
      })]);
    } finally { if (cleanupTimer !== undefined) clearTimeout(cleanupTimer); }
    if (!close) {
      for (const pipe of child.stdio) pipe?.destroy();
      cleanup.pipesDestroyed = true;
    }
  }
  cleanup.reaped = Boolean(exit || spawnErrorCode);
  diagnostics.cleanup = cleanup;
  throw new InspectionProcessError(diagnostics, reason === 'outer-test-abort' && signal ? {cause: (signal as AbortSignal).reason} : undefined);
}
