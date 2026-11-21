import {readFileSync} from 'node:fs';
import {mkdir, realpath, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArguments, preflight, discoverTests, buildCommands, testCommand, typecheckCommands, executeCommand, testEnvironment, toolingEnvironment} from './lib/local-tooling.ts';
import {BUILD_COMMAND_TIMING_STAGES, DESKTOP_TYPECHECK_TIMING_STAGES, hasDesktopTypecheckTiming, heapEvidence, measureBuildStage} from './lib/build-timings.ts';
import type {BuildHeapEvidence} from './lib/build-timings.ts';
import {createTypecheckEvidence, removeTypecheckEvidence, type OwnedTypecheckEvidence} from './lib/typecheck-evidence.ts';

interface ToolingFailure {
  readonly code?: string;
  readonly message?: string;
  readonly cacheCleanupFailed?: boolean;
  readonly exitCode?: number;
}
function failureOf(error: unknown): ToolingFailure {
  return error !== null && typeof error === 'object' ? error as ToolingFailure : {};
}
const root = fileURLToPath(new URL('../', import.meta.url));

/** The web bundle is the only stage with a heap probe; a missing or corrupt
 * evidence file is reported as an absent measurement, never as a pass. */
function readWebBundleHeap(file: string): BuildHeapEvidence | undefined {
  let value: Record<string, unknown>;
  try { value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return undefined; }
  const peak = value.peakOldSpaceBytes, limit = value.maxOldSpaceBytes;
  if (typeof peak !== 'number' || typeof limit !== 'number') return undefined;
  try {
    const evidence = heapEvidence({peakOldSpaceBytes: peak, maxOldSpaceBytes: limit,
      ...(typeof value.peakHeapUsedBytes === 'number' ? {peakHeapUsedBytes: value.peakHeapUsedBytes} : {}),
      ...(typeof value.peakRssBytes === 'number' ? {peakRssBytes: value.peakRssBytes} : {})});
    if (evidence.warning) {
      console.log(`::warning title=web-bundle heap::peak old space ${(evidence.peakOldSpaceBytes / 1048576).toFixed(1)} MB is ${evidence.percent}% of the ${(evidence.maxOldSpaceBytes / 1048576).toFixed(0)} MB limit`);
    }
    return evidence;
  } catch { return undefined; }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number | undefined> {
  try {
    const options = parseArguments(args);
    if (options.command === 'typecheck') {
      for (const [index, command] of (await typecheckCommands(root)).entries()) {
        const run = () => executeCommand(command, {env: toolingEnvironment()});
        const result = hasDesktopTypecheckTiming()
          ? await measureBuildStage(DESKTOP_TYPECHECK_TIMING_STAGES[index]!, run, {exitCode: value => value.code})
          : await run();
        if (result.code !== 0) return result.code;
      }
      return 0;
    }
    const {report, entries} = await preflight(root, {channel: options.channel, media: options.command === 'doctor'});
    if (options.command === 'doctor') {
      console.log(JSON.stringify(report, null, 2));
      return !report.prerequisitesReady ? 1 : options.nativeReady && !report.nativeReadiness.ready ? 2 : 0;
    }
    if (!report.buildReady) {console.error(JSON.stringify(report, null, 2)); return 1;}
    const commands = options.command === 'build' ? [...await typecheckCommands(root), ...buildCommands(root, entries, options.channel)]
      : [testCommand(root, await discoverTests(root, options), options.concurrency, process.execPath, options.reporter, options.timings)];
    if (options.command === 'test' && options.timings) await mkdir(path.dirname(path.join(root, ...options.timings.split('/'))), {recursive: true});
    // The staging script is the last build command. Hand it private evidence
    // that this process checked the same sources: the normal build then
    // typechecks once, while a standalone staging run still checks itself.
    const stagingIndex = options.command === 'build' ? commands.length - 1 : -1;
    let typecheckEvidence: OwnedTypecheckEvidence | undefined;
    try {
      for (const [index, command] of commands.entries()) {
        if (index === stagingIndex) {
          typecheckEvidence = await createTypecheckEvidence(root).catch(() => {
            console.error(JSON.stringify({event: 'desktop-typecheck-evidence', status: 'unavailable'}));
            return undefined;
          });
        }
        const stage = options.command === 'build' ? BUILD_COMMAND_TIMING_STAGES[index]! : undefined;
        const heapPath = stage === 'web-bundle' ? path.join(root, 'artifacts', 'build', 'web-bundle-heap.json') : undefined;
        if (heapPath) { await mkdir(path.dirname(heapPath), {recursive: true}); await rm(heapPath, {force: true}).catch(() => {}); }
        const env = {...(options.command === 'test' ? testEnvironment(process.env) : toolingEnvironment(process.env)),
          ...(heapPath ? {MIOON_BUILD_HEAP_EVIDENCE: heapPath} : {}),
          ...(index === stagingIndex && typecheckEvidence ? typecheckEvidence.environment : {})};
        const run = async () => options.command === 'test' && options.compileCache
          ? await (await import('./lib/test-compile-cache.ts')).withOwnedTestCompileCache(env, cachedEnv => executeCommand(command, {env: cachedEnv}))
          : await executeCommand(command, {env});
        const heap = heapPath ? () => readWebBundleHeap(heapPath) : undefined;
        const result = options.command === 'build'
          ? await measureBuildStage(stage!, run, {exitCode: value => value.code, ...(heap ? {heap} : {})})
          : await run();
        if (result.code !== 0) return result.code;
      }
      return 0;
    } finally {
      if (typecheckEvidence) await removeTypecheckEvidence(typecheckEvidence);
    }
  } catch (error) {
    const failure = failureOf(error);
    console.error(JSON.stringify({status: 'failed', code: failure.code || 'TOOLING_FAILED',
      message: failure.code ? failure.message : 'Local tooling failed. Check the documented options and prerequisites.',
      ...(failure.cacheCleanupFailed ? {cacheCleanupFailed: true} : {})}));
    if (failure.code === 'TEST_COMPILE_CACHE_INTERRUPTED') return failure.exitCode;
    return failure.code === 'NATIVE_TEST_LANE_BLOCKED' ? 2 : 1;
  }
}
// Match Node's resolved module path even when argv retains a symlink or alias.
// Importers may have no resolvable entry file, so that case must not run the CLI.
const invokedFile = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedFile === fileURLToPath(import.meta.url)) process.exitCode = await main();
