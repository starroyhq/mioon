import {spawn} from 'node:child_process';

export const CLI_PROCESS_TIMEOUT_MS = 10_000;
const stages = new Set(['preloaded', 'compile-cache-active', 'compile-cache-disabled', 'fetch-start', 'fetch-headers', 'fetch-rejected']);

export class InspectionProcessError extends Error {
  constructor(diagnostics, options) {
    super(`Inspection CLI ${diagnostics.reason}: ${JSON.stringify(diagnostics)}`, options);
    this.name = 'InspectionProcessError';
    this.diagnostics = diagnostics;
  }
}

// Observe the exact child and all of its pipes. A result envelope, OS exit and
// stdio close are separate milestones; none substitutes for normal completion.
export async function runInspectionProcess(args, {cwd, env, signal, timeoutMs = CLI_PROCESS_TIMEOUT_MS,
  executable = process.execPath} = {}) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let stdout = '', stderr = '', trace = '', envelopeAtMs = null, spawnedAtMs = null;
  let exit = null, close = null, spawnErrorCode = null;
  const observations = [];
  const child = spawn(executable, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe']});
  let closed;
  const closedPromise = new Promise(resolve => { closed = resolve; });
  child.once('spawn', () => { spawnedAtMs = elapsed(); });
  child.once('exit', (code, signal) => { exit = {code, signal, elapsedMs: elapsed()}; });
  child.once('close', (code, signal) => { close = {code, signal, elapsedMs: elapsed()}; closed(); });
  child.once('error', error => {
    // Spawn errors can contain executable paths. Keep only a bounded code.
    if (spawnedAtMs === null) spawnErrorCode = /^[A-Z0-9_]{1,32}$/.test(error.code || '') ? error.code : 'SPAWN_ERROR';
  });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
    if (envelopeAtMs !== null || !stdout.includes('\n')) return;
    try { if (typeof JSON.parse(stdout).ok === 'boolean') envelopeAtMs = elapsed(); } catch {}
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const stream = child.stdio[3];
  stream.setEncoding('utf8').on('data', chunk => {
    // This dedicated pipe accepts fixed stage names only, never child payloads.
    trace = (trace + chunk).slice(-2048);
    let newline;
    while ((newline = trace.indexOf('\n')) !== -1) {
      const stage = trace.slice(0, newline); trace = trace.slice(newline + 1);
      if (stages.has(stage) && observations.length < 12) observations.push({stage, elapsedMs: elapsed()});
    }
  });
  let timer, cancel;
  const failure = new Promise(resolve => {
    timer = setTimeout(() => resolve('process-deadline'), timeoutMs);
    cancel = () => resolve('outer-test-abort');
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
  });
  const snapshot = reason => ({reason, timeoutFired: reason === 'process-deadline', deadlineMs: timeoutMs, elapsedMs: elapsed(), spawnedAtMs,
    phase: exit ? 'stdio-close' : envelopeAtMs !== null ? 'process-exit' :
      observations.some(value => value.stage === 'fetch-headers') ? 'response-body-or-envelope' :
      observations.some(value => value.stage === 'fetch-start') ? 'request' :
      observations.some(value => value.stage === 'preloaded') ? 'command' : 'startup',
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    envelopeAtMs, observations: observations.map(value => ({...value})), exit, close, spawnErrorCode});
  let reason;
  try { reason = await Promise.race([closedPromise.then(() => null), failure]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  if (!reason && !spawnErrorCode && !close.signal) return {stdout, stderr, code: close.code, signal: close.signal,
    diagnostics: snapshot('completed')};

  // Freeze failure evidence before cleanup: SIGKILL is recovery, not evidence
  // that a child had failed to exit before the original deadline.
  const diagnostics = snapshot(reason || (spawnErrorCode ? 'spawn-error' : 'process-signal'));
  const cleanup = {killSent: false, reaped: false, pipesDestroyed: false};
  if (!close) {
    if (!exit && !spawnErrorCode) cleanup.killSent = child.kill('SIGKILL');
    // A child can exit while a descendant retains its inherited stdout. Close
    // this owner's pipe handles too; a close event alone would hide that cause.
    if (exit) {
      for (const pipe of child.stdio) pipe?.destroy();
      cleanup.pipesDestroyed = true;
    }
    let cleanupTimer;
    try {
      await Promise.race([closedPromise, new Promise(resolve => {
        cleanupTimer = setTimeout(resolve, 1000);
      })]);
    } finally { clearTimeout(cleanupTimer); }
    if (!close) {
      for (const pipe of child.stdio) pipe?.destroy();
      cleanup.pipesDestroyed = true;
    }
  }
  cleanup.reaped = Boolean(exit || spawnErrorCode);
  diagnostics.cleanup = cleanup;
  throw new InspectionProcessError(diagnostics, reason === 'outer-test-abort' ? {cause: signal.reason} : undefined);
}
