import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseArguments, preflight, discoverTests, buildCommands, testCommand, executeCommand, toolingEnvironment} from './lib/local-tooling.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArguments(args);
    const {report, entries} = await preflight(root, {channel: options.channel, media: options.command === 'doctor'});
    if (options.command === 'doctor') {
      console.log(JSON.stringify(report, null, 2));
      return !report.prerequisitesReady ? 1 : options.nativeReady && !report.nativeReadiness.ready ? 2 : 0;
    }
    if (!report.buildReady) {console.error(JSON.stringify(report, null, 2)); return 1;}
    const commands = options.command === 'build' ? buildCommands(root, entries, options.channel)
      : [testCommand(root, await discoverTests(root, options), options.concurrency)];
    for (const command of commands) {
      const result = await executeCommand(command, {env: toolingEnvironment(process.env, {mediaPaths: options.command === 'test'})});
      if (result.code !== 0) return result.code;
    }
    return 0;
  } catch (error) {
    console.error(JSON.stringify({status: 'failed', code: error.code || 'TOOLING_FAILED',
      message: error.code ? error.message : 'Local tooling failed. Check the documented options and prerequisites.'}));
    return error.code === 'NATIVE_TEST_LANE_BLOCKED' ? 2 : 1;
  }
}
// Match Node's resolved module path even when argv retains a symlink or alias.
// Importers may have no resolvable entry file, so that case must not run the CLI.
const invokedFile = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedFile === fileURLToPath(import.meta.url)) process.exitCode = await main();
