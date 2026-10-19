/** Explicitly invoked, synthetic candidate qualification only. This is not a
 * renderer, provider, project-media lane or generic subprocess API. */
import {constants, accessSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import type {ChildProcessByStdio} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';
import {OPACITY_ENVELOPE_PROFILE} from '../../contracts/src/timeline-opacity-envelope.ts';
import {compileTimelineOpacityFilterCandidate} from './timeline-opacity-filter-candidate.ts';
import type {TimelineOpacityAlphaModeCandidate} from './timeline-opacity-filter-candidate.ts';

export const TIMELINE_OPACITY_PIXEL_PROBE_LIMITS_CANDIDATE = Object.freeze({
  width: 2, height: 2, frames: 3, fps: 30, inputBytes: 48, stdoutBytes: 48,
  stderrBytes: 65536, executionMs: 5000, terminationGraceMs: 2000, terminationReapMs: 1000,
  channelTolerance: 1,
} as const);
type ProbeId = 'straight-identity' | 'straight-curve' | 'premultiplied-identity' | 'premultiplied-curve';
type ProbeChild = ChildProcessByStdio<Writable, Readable, Readable>;
type Termination = 'exited' | 'unowned' | 'unconfirmed';
export interface TimelineOpacityPixelProbeDependenciesCandidate {
  resolveFfmpeg(): string;
  spawnMedia(command: string, args: readonly string[], options: {stdio: ['pipe', 'pipe', 'pipe']}, owner: {kind: string}): ProbeChild;
  terminateMediaProcess(child: ProbeChild, options: {interrupted: boolean}): Promise<{status: Termination; forced: boolean}>;
  onMediaInterruption(child: ProbeChild, observer: () => void): () => unknown;
}
export interface TimelineOpacityPixelProbeResultCandidate {
  readonly id: ProbeId;
  readonly status: 'passed' | 'failed' | 'uncertain' | 'not-run';
  readonly failureCode: string | null;
  readonly inputBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly inputFinished: boolean;
  readonly stdoutEnded: boolean;
  readonly stderrEnded: boolean;
  readonly closeObserved: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly termination: Termination | null;
  readonly maxChannelError: number | null;
}
export interface TimelineOpacityPixelProbeReportCandidate {
  readonly executable: string | null;
  readonly failureCode: string | null;
  readonly complete: boolean;
  readonly limits: typeof TIMELINE_OPACITY_PIXEL_PROBE_LIMITS_CANDIDATE;
  readonly results: readonly TimelineOpacityPixelProbeResultCandidate[];
}
interface ProbeCase {
  readonly id: ProbeId;
  readonly argv: readonly string[];
  readonly input: Buffer;
  readonly expected: Buffer;
}
const LIMITS = TIMELINE_OPACITY_PIXEL_PROBE_LIMITS_CANDIDATE;
const require = createRequire(import.meta.url);
const failure = (code: string): Error & {code: string} => Object.assign(new Error('Synthetic opacity pixel qualification could not complete.'), {code});

function pixels(values: readonly (readonly number[])[]): Buffer {
  const result = Buffer.alloc(LIMITS.inputBytes);
  for (let frame = 0; frame < LIMITS.frames; frame++) {
    const pixel = values[frame]!;
    for (let index = 0; index < LIMITS.width * LIMITS.height; index++) result.set(pixel, (frame * 4 + index) * 4);
  }
  return result;
}
function cases(): readonly ProbeCase[] {
  const result: ProbeCase[] = [];
  for (const alphaMode of ['straight', 'premultiplied'] as const satisfies readonly TimelineOpacityAlphaModeCandidate[]) {
    const source = alphaMode === 'straight' ? [200, 100, 24, 128] : [100, 50, 12, 128];
    for (const curve of [false, true]) {
      const points = curve ? [{frame: 0, opacity: 0}, {frame: 1, opacity: 0.5}, {frame: 2, opacity: 1}] : [{frame: 0, opacity: 1}];
      const stage = compileTimelineOpacityFilterCandidate({durationFrames: 3,
        opacityEnvelope: {profileId: OPACITY_ENVELOPE_PROFILE, points}}, 0, 3, alphaMode);
      const argv = Object.freeze(['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
        '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '2x2', '-framerate', '30', '-i', 'pipe:0',
        '-vf', stage.filter, '-frames:v', '3', '-an', '-threads:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1']);
      const expected = !curve ? [source, source, source] : alphaMode === 'straight' ?
        [[200, 100, 24, 0], [200, 100, 24, 64], source] : [[0, 0, 0, 0], [50, 25, 6, 64], source];
      result.push({id: `${alphaMode}-${curve ? 'curve' : 'identity'}`, argv,
        input: pixels([source, source, source]), expected: pixels(expected)});
    }
  }
  return result;
}
function notRun(id: ProbeId): TimelineOpacityPixelProbeResultCandidate {
  return {id, status: 'not-run', failureCode: null, inputBytes: 0, stdoutBytes: 0, stderrBytes: 0,
    inputFinished: false, stdoutEnded: false, stderrEnded: false, closeObserved: false,
    exitCode: null, signal: null, termination: null, maxChannelError: null};
}

/** Testable lifecycle core; the production entry point below supplies fixed
 * owned-child dependencies. Callers cannot provide argv, pixels, filters,
 * timeouts, limits, child PIDs, output files or a process-wide stop operation. */
export function createTimelineOpacityPixelProbeCandidate(runtime: TimelineOpacityPixelProbeDependenciesCandidate): () => Promise<TimelineOpacityPixelProbeReportCandidate> {
  return async (): Promise<TimelineOpacityPixelProbeReportCandidate> => {
    const probes = cases(), results: TimelineOpacityPixelProbeResultCandidate[] = [];
    let executable: string;
    try {executable = runtime.resolveFfmpeg();}
    catch {return {executable: null, failureCode: 'OPACITY_PROBE_FFMPEG_UNAVAILABLE', complete: false, limits: LIMITS,
      results: probes.map(probe => notRun(probe.id))};}
    for (const probe of probes) {
      if (results.some(result => result.status !== 'passed')) {results.push(notRun(probe.id)); continue;}
      results.push(await runOne(runtime, executable, probe));
    }
    return {executable, failureCode: results.find(result => result.failureCode)?.failureCode ?? null,
      complete: results.every(result => result.status === 'passed'), limits: LIMITS, results};
  };
}

function runOne(runtime: TimelineOpacityPixelProbeDependenciesCandidate, executable: string, probe: ProbeCase): Promise<TimelineOpacityPixelProbeResultCandidate> {
  return new Promise(resolve => {
    let child: ProbeChild;
    try {child = runtime.spawnMedia(executable, probe.argv, {stdio: ['pipe', 'pipe', 'pipe']}, {kind: 'ffmpeg-opacity-pixel-probe-candidate'});}
    catch (error) {
      const uncertain = typeof error === 'object' && error !== null && 'terminationUnconfirmed' in error && error.terminationUnconfirmed === true;
      resolve({...notRun(probe.id), status: uncertain ? 'uncertain' : 'failed',
        failureCode: uncertain ? 'OPACITY_PROBE_TERMINATION_UNCONFIRMED' : 'OPACITY_PROBE_SPAWN_FAILED'}); return;
    }
    const output = Buffer.alloc(LIMITS.stdoutBytes);
    let inputBytes = 0, stdoutBytes = 0, stderrBytes = 0, failureCode: string | null = null;
    let inputFinished = false, stdoutEnded = false, stderrEnded = false, closeObserved = false, settled = false;
    let exitCode: number | null = null, signal: NodeJS.Signals | null = null, termination: Termination | null = null;
    let stopping = false, stopComplete = false, uncertain = false;
    let removeObserver: (() => unknown) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled || stopping && !stopComplete || !closeObserved && !stopComplete) return;
      settled = true; clearTimeout(timer); removeObserver?.();
      let maxChannelError: number | null = null;
      if (!failureCode) {
        if (exitCode !== 0 || signal !== null) failureCode = 'OPACITY_PROBE_EXIT_FAILED';
        else if (!inputFinished || inputBytes !== LIMITS.inputBytes || !stdoutEnded || !stderrEnded) failureCode = 'OPACITY_PROBE_PIPE_INCOMPLETE';
        else if (stdoutBytes !== LIMITS.stdoutBytes) failureCode = 'OPACITY_PROBE_OUTPUT_SIZE';
        else {
          maxChannelError = 0;
          for (let index = 0; index < LIMITS.stdoutBytes; index++) maxChannelError = Math.max(maxChannelError, Math.abs(output[index]! - probe.expected[index]!));
          if (maxChannelError > LIMITS.channelTolerance) failureCode = 'OPACITY_PROBE_PIXEL_MISMATCH';
        }
      }
      resolve({id: probe.id, status: uncertain ? 'uncertain' : failureCode ? 'failed' : 'passed', failureCode,
        inputBytes, stdoutBytes, stderrBytes, inputFinished, stdoutEnded, stderrEnded, closeObserved,
        exitCode, signal, termination, maxChannelError});
    };
    const stop = (code: string): void => {
      if (settled || stopping) return;
      stopping = true; failureCode ??= code; clearTimeout(timer);
      // Release the sole bounded stdin write before joining this exact owned
      // child's existing 2s+1s stop protocol. No global stop or PID lookup exists.
      child.stdin.destroy();
      void Promise.resolve().then(() => runtime.terminateMediaProcess(child, {interrupted: false})).then(result => {
        termination = result.status;
        if (result.status !== 'exited') {uncertain = true; failureCode = 'OPACITY_PROBE_TERMINATION_UNCONFIRMED';}
      }, () => {uncertain = !closeObserved; failureCode = uncertain ? 'OPACITY_PROBE_TERMINATION_UNCONFIRMED' : failureCode;}).finally(() => {
        child.stdout.destroy(); child.stderr.destroy(); stopComplete = true; finish();
      });
    };
    child.stdin.on('error', () => stop('OPACITY_PROBE_STDIN_FAILED'));
    child.stdin.once('finish', () => {inputFinished = true; inputBytes = LIMITS.inputBytes;});
    child.stdout.on('data', (chunk: unknown) => {
      if (stopping || settled) return;
      if (!Buffer.isBuffer(chunk)) {stop('OPACITY_PROBE_BINARY_OUTPUT_REQUIRED'); return;}
      if (chunk.length > LIMITS.stdoutBytes - stdoutBytes) {stdoutBytes += chunk.length; stop('OPACITY_PROBE_STDOUT_LIMIT'); return;}
      chunk.copy(output, stdoutBytes); stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: unknown) => {
      if (stopping || settled) return;
      if (!Buffer.isBuffer(chunk)) {stop('OPACITY_PROBE_BINARY_OUTPUT_REQUIRED'); return;}
      if (chunk.length > LIMITS.stderrBytes - stderrBytes) {stderrBytes += chunk.length; stop('OPACITY_PROBE_STDERR_LIMIT'); return;}
      stderrBytes += chunk.length;
    });
    child.stdout.once('end', () => {stdoutEnded = true;});
    child.stderr.once('end', () => {stderrEnded = true;});
    child.stdout.on('error', () => stop('OPACITY_PROBE_STDOUT_FAILED'));
    child.stderr.on('error', () => stop('OPACITY_PROBE_STDERR_FAILED'));
    child.on('error', () => stop(child.pid ? 'OPACITY_PROBE_PROCESS_FAILED' : 'OPACITY_PROBE_SPAWN_FAILED'));
    child.once('close', (code: number | null, closedSignal: NodeJS.Signals | null) => {
      closeObserved = true; exitCode = code; signal = closedSignal; finish();
    });
    timer = setTimeout(() => stop('OPACITY_PROBE_TIMEOUT'), LIMITS.executionMs);
    removeObserver = runtime.onMediaInterruption(child, () => stop('OPACITY_PROBE_INTERRUPTED'));
    if (!stopping) {try {child.stdin.end(probe.input);} catch {stop('OPACITY_PROBE_STDIN_FAILED');}}
  });
}

/** Resolve only the already installed tool selected by the existing trusted
 * locator. No shell, installer, environment overlay or downloaded binary. */
export function resolveTimelineOpacityPixelProbeFfmpegCandidate(): string {
  const environment: unknown = require('./media-environment.ts');
  if (!environment || typeof environment !== 'object') throw failure('OPACITY_PROBE_FFMPEG_UNAVAILABLE');
  const locator: unknown = Reflect.get(environment, 'mediaExecutable');
  const reducedEnvironment: unknown = Reflect.get(environment, 'mediaEnvironment');
  if (typeof locator !== 'function' || typeof reducedEnvironment !== 'function') throw failure('OPACITY_PROBE_FFMPEG_UNAVAILABLE');
  const selected: unknown = Reflect.apply(locator, undefined, ['ffmpeg']);
  const reduced: unknown = Reflect.apply(reducedEnvironment, undefined, []);
  if (typeof selected !== 'string' || !selected || selected.includes('\0') || !reduced || typeof reduced !== 'object') throw failure('OPACITY_PROBE_FFMPEG_UNAVAILABLE');
  const searchPath: unknown = Reflect.get(reduced, 'PATH');
  const candidates = path.isAbsolute(selected) ? [selected] : selected === 'ffmpeg' && typeof searchPath === 'string' ?
    searchPath.split(path.delimiter).filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, selected)) : [];
  for (const candidate of candidates) {
    try {
      const actual = realpathSync(candidate);
      if (!statSync(actual).isFile()) continue;
      accessSync(actual, constants.X_OK); return actual;
    } catch { /* A missing PATH entry never installs or selects another tool. */ }
  }
  throw failure('OPACITY_PROBE_FFMPEG_UNAVAILABLE');
}

/** Exactly four serial synthetic cases, stopping after the first failure. */
export async function runTimelineOpacityPixelProbeCandidate(): Promise<TimelineOpacityPixelProbeReportCandidate> {
  const processRuntime: unknown = require('./media-processes.ts');
  if (!processRuntime || typeof processRuntime !== 'object') throw failure('OPACITY_PROBE_RUNTIME_UNAVAILABLE');
  const spawn: unknown = Reflect.get(processRuntime, 'spawnMedia'), stop: unknown = Reflect.get(processRuntime, 'terminateMediaProcess'),
    observe: unknown = Reflect.get(processRuntime, 'onMediaInterruption'), policy: unknown = Reflect.get(processRuntime, 'MEDIA_TERMINATION_POLICY');
  if (typeof spawn !== 'function' || typeof stop !== 'function' || typeof observe !== 'function' ||
      !policy || typeof policy !== 'object' || Reflect.get(policy, 'graceMs') !== LIMITS.terminationGraceMs ||
      Reflect.get(policy, 'reapMs') !== LIMITS.terminationReapMs) throw failure('OPACITY_PROBE_RUNTIME_UNAVAILABLE');
  return createTimelineOpacityPixelProbeCandidate({resolveFfmpeg: resolveTimelineOpacityPixelProbeFfmpegCandidate,
    spawnMedia: (command, args, options, owner) => Reflect.apply(spawn, undefined, [command, args, options, owner]) as ProbeChild,
    terminateMediaProcess: (child, options) => Reflect.apply(stop, undefined, [child, options]) as ReturnType<TimelineOpacityPixelProbeDependenciesCandidate['terminateMediaProcess']>,
    onMediaInterruption: (child, observer) => Reflect.apply(observe, undefined, [child, observer]) as () => unknown,
  })();
}
