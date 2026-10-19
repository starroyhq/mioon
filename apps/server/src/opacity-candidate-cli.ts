/** Explicit internal development launcher for independent42 or exact existing
 *42/43 application admission. Historical profiles never migrate. */
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createFreshOpacityCandidateLaunch, createExistingOpacityCandidateLaunch, createRestoredOpacityCandidateLaunch,
  closeUnusedOpacityCandidateLaunch, assertOpacityCandidateBuild} from './opacity-candidate-launch.ts';

const require = createRequire(import.meta.url);
const defaultDist = fileURLToPath(new URL('../../web/dist-opacity-candidate', import.meta.url));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function parseOpacityCandidateArguments(args: readonly string[]) {
  let directory: string | undefined, port = 4319, mode: 'new' | 'open' | 'open-restored' | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !value || seen.has(key) || !['--new-workspace', '--open-workspace', '--open-restored-workspace', '--port'].includes(key)) throw new Error('Use exactly one --new-workspace, --open-workspace or --open-restored-workspace /absolute/directory [--port 4319].');
    seen.add(key);
    if (key === '--new-workspace' || key === '--open-workspace' || key === '--open-restored-workspace') {
      if (mode) throw new Error('Use exactly one --new-workspace, --open-workspace or --open-restored-workspace.');
      if (!path.isAbsolute(value)) throw new Error('The workspace path must be absolute.');
      directory = path.resolve(value); mode = key === '--new-workspace' ? 'new' : key === '--open-workspace' ? 'open' : 'open-restored';
    }
    else {if (!/^[0-9]{4,5}$/u.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('The loopback port must be 1024–65535.');port = Number(value);}
  }
  if (!directory) throw new Error('An explicit --new-workspace, --open-workspace or --open-restored-workspace /absolute/directory is required.');
  return Object.freeze({directory, port, mode});
}

export async function runOpacityCandidateDevelopment(args: readonly string[] = process.argv.slice(2)) {
  const {directory, port, mode} = parseOpacityCandidateArguments(args);
  assertOpacityCandidateBuild(defaultDist);
  const proof = mode === 'open-restored' ? createRestoredOpacityCandidateLaunch(directory)
    : mode === 'open' ? createExistingOpacityCandidateLaunch(directory) : createFreshOpacityCandidateLaunch(directory);
  try {
    const module: unknown = require('./index.ts');
    if (!object(module) || typeof module.startServer !== 'function') throw new Error('The local server runtime is unavailable.');
    const value: unknown = await Reflect.apply(module.startServer, module, [{opacityCandidateLaunch: proof, port, distDir: defaultDist, localDraftChannel: 'development'}]);
    if (!object(value) || typeof value.close !== 'function' || typeof value.url !== 'string' || typeof value.tokenFile !== 'string' || typeof value.dataDir !== 'string') throw new Error('The candidate server lifecycle is unavailable.');
    const close = value.close;
    return Object.freeze({url: value.url, tokenFile: value.tokenFile, dataDir: value.dataDir, close: async (): Promise<void> => {await Reflect.apply(close, value, []);}});
  } catch (error) {closeUnusedOpacityCandidateLaunch(proof);throw error;}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const service = await runOpacityCandidateDevelopment();
    console.log(`Mioon internal opacity candidate ready at ${service.url}; workspace: ${service.dataDir}; local token file: ${service.tokenFile}`);
    let closing: Promise<void> | undefined;
    const close = (): void => {closing ??= service.close().catch((error: unknown) => {console.error('Candidate shutdown failed:', object(error) && typeof error.code === 'string' ? error.code : 'SERVER_STOP_FAILED');process.exitCode = 1;});};
    process.on('SIGTERM', close);process.on('SIGINT', close);
  } catch (error) {console.error(object(error) && error instanceof Error ? error.message : 'The candidate launcher failed.');process.exitCode = 1;}
}
