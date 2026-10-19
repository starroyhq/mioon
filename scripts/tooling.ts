import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseArguments, preflight, discoverTests, buildCommands, testCommand, typecheckCommands, executeCommand, toolingEnvironment} from './lib/local-tooling.ts';

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

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number | undefined> {
  try {
    const options = parseArguments(args);
    if (options.command === 'typecheck') {
      for (const command of await typecheckCommands(root)) {
        const result = await executeCommand(command, {env: toolingEnvironment()});
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
      : [testCommand(root, await discoverTests(root, options), options.concurrency, process.execPath, options.reporter)];
    for (const command of commands) {
      const env = toolingEnvironment(process.env, {mediaPaths: options.command === 'test'});
      const result = options.command === 'test' && options.compileCache
        ? await (await import('./lib/test-compile-cache.ts')).withOwnedTestCompileCache(env, cachedEnv => executeCommand(command, {env: cachedEnv}))
        : await executeCommand(command, {env});
      if (result.code !== 0) return result.code;
    }
    return 0;
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
