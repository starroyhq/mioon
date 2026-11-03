import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {argumentsFor, CheckFailure, cleanEnvironment, isMain, report, safeFailure} from './media-environment.ts';

export type AppleStaplerOperation = 'staple' | 'validate';
export interface AppleStaplerDiagnostic {
  operation: AppleStaplerOperation;
  artifactKind: 'app' | 'dmg';
  attempt: number;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  category: 'success' | 'transient_network' | 'invalid_ticket' | 'timeout' | 'signal' | 'output_limit' | 'command_failed';
  willRetry: boolean;
}
export interface AppleStaplerCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputLimitExceeded?: boolean;
}
export type AppleStaplerExecutor = (file: string, args: readonly string[], options: {timeout: number; env: NodeJS.ProcessEnv}) => Promise<AppleStaplerCommandResult>;
export type AppleStaplerFailureCode = 'APP_STAPLE_INVALID' | 'DMG_STAPLE_INVALID' | 'APPLE_STAPLER_FAILED';
export interface AppleStaplerOptions {
  failureCode?: AppleStaplerFailureCode;
  onDiagnostic?(diagnostic: AppleStaplerDiagnostic): void;
  execute?: AppleStaplerExecutor;
  wait?(milliseconds: number): Promise<void>;
  /** Only the app hook uses this: the library already made the first attempt. */
  attemptsUsed?: 1;
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ATTEMPTS = 3, COMMAND_TIMEOUT = 60000, OUTPUT_LIMIT = 256 * 1024;
const BACKOFF = [5000, 15000] as const;
export class AppleStaplerFailure extends CheckFailure {
  readonly diagnostics: readonly AppleStaplerDiagnostic[];
  constructor(code: AppleStaplerFailureCode, diagnostics: readonly AppleStaplerDiagnostic[]) {
    super(code); this.diagnostics = diagnostics.map(value => ({...value}));
  }
}
function artifactKind(artifact: string): 'app' | 'dmg' {
  if (typeof artifact !== 'string' || !path.isAbsolute(artifact) || path.resolve(artifact) !== artifact || /[\0\r\n]/.test(artifact)) throw new CheckFailure('INVALID_APPLE_ARTIFACT');
  if (artifact.endsWith('.app')) return 'app';
  if (artifact.endsWith('.dmg')) return 'dmg';
  throw new CheckFailure('INVALID_APPLE_ARTIFACT');
}
const executeCommand: AppleStaplerExecutor = (file, args, options) => new Promise(resolve => {
  execFile(file, [...args], {encoding: 'utf8', timeout: options.timeout, killSignal: 'SIGKILL', maxBuffer: OUTPUT_LIMIT, env: options.env}, (error, stdout, stderr) => {
    const failure = error as (Error & {code?: string | number; signal?: string; killed?: boolean}) | null;
    const outputLimitExceeded = failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    resolve({exitCode: error ? typeof failure?.code === 'number' ? failure.code : null : 0,
      signal: typeof failure?.signal === 'string' ? failure.signal : null,
      timedOut: Boolean(failure?.killed && failure.signal === 'SIGKILL' && !outputLimitExceeded),
      stdout: String(stdout), stderr: String(stderr), outputLimitExceeded});
  });
});
function diagnostic(operation: AppleStaplerOperation, kind: 'app' | 'dmg', attempt: number, result: AppleStaplerCommandResult): AppleStaplerDiagnostic {
  const exitCode = Number.isSafeInteger(result.exitCode) && result.exitCode !== null && result.exitCode >= 0 && result.exitCode <= 255 ? result.exitCode : null;
  const signal = typeof result.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(result.signal) ? result.signal : null;
  const text = `${result.stdout}\n${result.stderr}`;
  const ok = exitCode === 0 && !signal && !result.timedOut && !result.outputLimitExceeded;
  let category: AppleStaplerDiagnostic['category'];
  if (ok) category = 'success';
  else if (result.outputLimitExceeded) category = 'output_limit';
  else if (result.timedOut) category = 'timeout';
  else if (signal) category = 'signal';
  // A missing/bad ticket is a failed release gate, never a network retry.
  else if (/ticket[^\r\n]*(?:invalid|not valid|not found|missing)|could not validate ticket/i.test(text)) category = 'invalid_ticket';
  // Code 68 alone also covers permanent failures. Only explicit URL-loading
  // errors from Apple's ticket service qualify for this bounded recovery.
  else if (exitCode === 68 && /(?:api\.apple-cloudkit\.com|CloudKit)/i.test(text) && /NSURLErrorDomain\s+Code=-(?:1001|1003|1004|1005|1009)\b/.test(text)) category = 'transient_network';
  else category = 'command_failed';
  return {operation, artifactKind: kind, attempt, ok, exitCode, signal, timedOut: Boolean(result.timedOut), category, willRetry: category === 'transient_network' && attempt < ATTEMPTS};
}
/** Only xcrun stapler is repeated; notarization submission and signing are not. */
export async function runAppleStapler(operation: AppleStaplerOperation, artifact: string, options: AppleStaplerOptions = {}): Promise<readonly AppleStaplerDiagnostic[]> {
  if (operation !== 'staple' && operation !== 'validate') throw new CheckFailure('INVALID_APPLE_OPERATION');
  const kind = artifactKind(artifact), diagnostics: AppleStaplerDiagnostic[] = [];
  if (!options.execute && process.platform !== 'darwin') throw new CheckFailure('APPLE_STAPLER_HOST_MISMATCH');
  if (options.attemptsUsed !== undefined && options.attemptsUsed !== 1) throw new CheckFailure('INVALID_APPLE_ATTEMPT_COUNT');
  const execute = options.execute ?? executeCommand, wait = options.wait ?? (milliseconds => delay(milliseconds));
  for (let attempt = (options.attemptsUsed ?? 0) + 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await wait(BACKOFF[attempt - 2]!);
    let result: AppleStaplerCommandResult;
    try { result = await execute('xcrun', ['stapler', operation, '-v', artifact], {timeout: COMMAND_TIMEOUT, env: cleanEnvironment()}); }
    catch { result = {exitCode: null, signal: null, timedOut: false, stdout: '', stderr: ''}; }
    const outcome = diagnostic(operation, kind, attempt, result);
    diagnostics.push(outcome); options.onDiagnostic?.({...outcome});
    if (outcome.ok) return diagnostics;
    if (!outcome.willRetry) break;
  }
  throw new AppleStaplerFailure(options.failureCode ?? 'APPLE_STAPLER_FAILED', diagnostics);
}

export interface AppleAppNotarizationReport {
  version: 1;
  kind: 'app-notarization';
  operation: 'notarize-app';
  ok: boolean;
  phase: 'preflight' | 'notarize' | 'staple' | 'validate' | 'complete';
  acceptedKnown: boolean;
  notarizeCalls: 0 | 1;
  diagnostics: AppleStaplerDiagnostic[];
  error?: string;
}
export interface NotarizeAppContext {electronPlatformName?: unknown; appOutDir?: unknown; packager?: {appInfo?: {productFilename?: unknown}}}
interface NotarizeOptions {appPath: string; appleApiKey: string; appleApiKeyId: string; appleApiIssuer: string}
export interface NotarizeAppDependencies {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  notarize?(options: NotarizeOptions): Promise<void>;
  execute?: AppleStaplerExecutor;
  wait?(milliseconds: number): Promise<void>;
  writeReport?(value: AppleAppNotarizationReport): Promise<void>;
}
function installedNotarize(): (options: NotarizeOptions) => Promise<void> {
  const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder')), libs = createRequire(builder.resolve('app-builder-lib'));
  const module = libs('@electron/notarize') as {notarize?: (options: NotarizeOptions) => Promise<void>};
  if (typeof module.notarize !== 'function') throw new CheckFailure('APPLE_NOTARIZATION_UNAVAILABLE');
  return module.notarize;
}
function reportPath(env: NodeJS.ProcessEnv): string {
  if (!['macos-x64', 'macos-arm64'].includes(env.MIOON_TARGET ?? '')) throw new CheckFailure('INVALID_APPLE_RELEASE_TARGET');
  const output = env.MIOON_APPLE_NOTARIZATION_REPORT;
  if (!output || /[\0\r\n]/.test(output)) throw new CheckFailure('APPLE_NOTARIZATION_REPORT_REQUIRED');
  const resolved = path.resolve(root, output), directory = path.join(root, 'artifacts', `desktop-${env.MIOON_TARGET}`);
  if (path.dirname(resolved) !== directory || !/^[a-z][a-z0-9-]*\.json$/.test(path.basename(resolved))) throw new CheckFailure('INVALID_APPLE_NOTARIZATION_REPORT');
  return resolved;
}
export async function notarizeApp(context: NotarizeAppContext, dependencies: NotarizeAppDependencies = {}): Promise<void> {
  const env = dependencies.env ?? process.env, result: AppleAppNotarizationReport = {version: 1, kind: 'app-notarization', operation: 'notarize-app', ok: false, phase: 'preflight', acceptedKnown: false, notarizeCalls: 0, diagnostics: []};
  let output: string | undefined;
  try {
    if (context.electronPlatformName !== 'darwin' || (dependencies.platform ?? process.platform) !== 'darwin' || !/^[a-f0-9]{40}$/.test(env.MIOON_RELEASE_SHA ?? '')) throw new CheckFailure('APPLE_NOTARIZATION_RELEASE_ONLY');
    output = reportPath(env);
    const filename = context.packager?.appInfo?.productFilename;
    if (typeof context.appOutDir !== 'string' || !path.isAbsolute(context.appOutDir) || path.resolve(context.appOutDir) !== context.appOutDir || /[\0\r\n]/.test(context.appOutDir) || typeof filename !== 'string' || !filename || /[\/\\\0\r\n]/.test(filename) || filename === '.' || filename === '..') throw new CheckFailure('INVALID_APPLE_APP_CONTEXT');
    const appPath = path.join(context.appOutDir, `${filename}.app`); artifactKind(appPath);
    const appleApiKey = env.APPLE_API_KEY_PATH ?? env.APPLE_API_KEY, appleApiKeyId = env.APPLE_API_KEY_ID, appleApiIssuer = env.APPLE_API_ISSUER;
    if (!appleApiKey || !path.isAbsolute(appleApiKey) || /[\0\r\n]/.test(appleApiKey) || !appleApiKeyId || /[\0\r\n]/.test(appleApiKeyId) || !appleApiIssuer || /[\0\r\n]/.test(appleApiIssuer)) throw new CheckFailure('APPLE_NOTARIZATION_CREDENTIALS_REQUIRED');
    const record = (value: AppleStaplerDiagnostic) => { result.diagnostics.push({...value}); };
    const stapler = {execute: dependencies.execute, wait: dependencies.wait, failureCode: 'APP_STAPLE_INVALID' as const, onDiagnostic: record};
    result.phase = 'notarize';
    const notarize = dependencies.notarize ?? installedNotarize();
    result.notarizeCalls = 1;
    try {
      await notarize({appPath, appleApiKey, appleApiKeyId, appleApiIssuer});
      result.acceptedKnown = true;
      record(diagnostic('staple', 'app', 1, {exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: ''}));
    } catch (error) {
      // In the pinned library this prefix is constructed only after notarytool
      // returned status Accepted. A notarization/signature failure never enters
      // stapling recovery, and no raw library message enters the public report.
      const match = error instanceof Error ? /^Failed to staple your application with code: (\d+)\n\n([\s\S]*)$/.exec(error.message) : null;
      if (!match) throw new CheckFailure('APPLE_NOTARIZATION_FAILED');
      result.acceptedKnown = true; result.phase = 'staple';
      const first = diagnostic('staple', 'app', 1, {exitCode: Number(match[1]), signal: null, timedOut: false, stdout: match[2]!, stderr: ''}); record(first);
      if (!first.willRetry) throw new AppleStaplerFailure('APP_STAPLE_INVALID', [first]);
      await runAppleStapler('staple', appPath, {...stapler, attemptsUsed: 1});
    }
    result.phase = 'validate'; await runAppleStapler('validate', appPath, stapler);
    result.ok = true; result.phase = 'complete';
  } catch (error) {
    result.error = error instanceof CheckFailure ? safeFailure(error) : 'APPLE_NOTARIZATION_FAILED';
    throw new CheckFailure(result.error);
  } finally {
    try {
      if (dependencies.writeReport) await dependencies.writeReport(result);
      else if (output) await report(output, result);
    } catch { throw new CheckFailure('APPLE_NOTARIZATION_REPORT_FAILED'); }
  }
}

if (isMain(import.meta.url)) {
  let output: string | undefined;
  const diagnostics: AppleStaplerDiagnostic[] = [];
  try {
    const args = argumentsFor(process.argv.slice(2), ['operation', 'artifact'], ['output']); output = args.output;
    if (args.operation !== 'staple' && args.operation !== 'validate') throw new CheckFailure('INVALID_APPLE_OPERATION');
    await runAppleStapler(args.operation, args.artifact, {onDiagnostic: value => diagnostics.push(value)});
    const result = {ok: true, operation: args.operation, diagnostics};
    if (output) {try {await report(output, result);} catch {throw new CheckFailure('APPLE_STAPLER_REPORT_FAILED');}}
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = {ok: false, error: safeFailure(error), diagnostics};
    if (output) {try {await report(output, result);} catch {result.error = 'APPLE_STAPLER_REPORT_FAILED';}}
    console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
