import path from 'node:path';
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
