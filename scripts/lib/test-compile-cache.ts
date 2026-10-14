/** Opt-in test tooling only. Never imported by packaged application code. */
import {mkdtemp, lstat, realpath, rm} from 'node:fs/promises';
import {lstatSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {getCompileCacheDir} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);
const ownerKey = 'MIOON_TEST_COMPILE_CACHE_ROOT';
const failed = (message: string) => Object.assign(Error(message), {code: 'TEST_COMPILE_CACHE_FAILED'});
type Report = (entry: Record<string, unknown>) => void;

async function withCacheSignalOwnership<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
  const onInterrupt = () => {interrupted ??= 'SIGINT'; controller.abort();};
  const onTerminate = () => {interrupted ??= 'SIGTERM'; controller.abort();};
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  let result: T | undefined, originalError: unknown, didFail = false;
  try {result = await run(controller.signal);} catch (error) {didFail = true; originalError = error;}
  finally {process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);}
  if (interrupted) throw Object.assign(Error(`Owned test compile cache interrupted by ${interrupted}.`, didFail ? {cause: originalError} : undefined),
    {code: 'TEST_COMPILE_CACHE_INTERRUPTED', exitCode: interrupted === 'SIGINT' ? 130 : 143,
      cacheCleanupFailed: Boolean(originalError && typeof originalError === 'object' && 'cacheCleanupFailed' in originalError && originalError.cacheCleanupFailed)});
  if (didFail) throw originalError;
  return result as T;
}

/** The incoming environment is already allowlisted by local-tooling. Only a
 * freshly owned path is added; caller-provided cache paths/loaders are ignored. */
export async function withOwnedTestCompileCache<T>(environment: NodeJS.ProcessEnv, run: (env: NodeJS.ProcessEnv) => Promise<T>,
  {source = process.env, report = (entry: Record<string, unknown>) => console.error(JSON.stringify(entry))}: {source?: NodeJS.ProcessEnv; report?: Report} = {}): Promise<T> {
  return withCacheSignalOwnership(async signal => {
  if (source.NODE_DISABLE_COMPILE_CACHE) {
    report({event: 'test-compile-cache', status: 'disabled-by-environment'});
    signal.throwIfAborted();
    return run({...environment, NODE_DISABLE_COMPILE_CACHE: '1'});
  }
  if (process.platform === 'win32') throw failed('Private test compile-cache ACL verification is not implemented on Windows.');
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-test-compile-cache-'));
  const owned = await lstat(root), cacheId = path.basename(root);
  const environmentWithCache = {...environment, NODE_COMPILE_CACHE: root, [ownerKey]: root};
  let result: T | undefined, originalError: unknown, didFail = false;
  try {
    if (!owned.isDirectory() || owned.isSymbolicLink() || ((owned.mode & 0o077) !== 0 || owned.uid !== process.getuid?.())) throw failed('Owned test compile cache is not private.');
    // Probe only Node's runtime cache status. No application import/prewarming.
    const probe = `const m=require('node:module'),p=require('node:path');const r=process.env.NODE_COMPILE_CACHE,a=m.getCompileCacheDir();if(!a||p.dirname(a)!==r)process.exitCode=1;`;
    report({event: 'test-compile-cache', status: 'preparing', cacheId});
    signal.throwIfAborted();
    const probing = execute(process.execPath, ['-e', probe], {env: environmentWithCache, timeout: 12000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 4096});
    const cancelProbe = () => {probing.child.kill('SIGKILL');};
    signal.addEventListener('abort', cancelProbe, {once: true});
    if (signal.aborted) cancelProbe();
    try {await probing;} finally {signal.removeEventListener('abort', cancelProbe);}
    signal.throwIfAborted();
    report({event: 'test-compile-cache', status: 'active', cacheId, privateOwned: true, node: process.versions.node, platform: process.platform, arch: process.arch});
    signal.throwIfAborted();
    result = await run(environmentWithCache);
  } catch (error) {didFail = true; originalError = error;}
  try {
    const current = await lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw failed('Owned test compile cache identity changed; refusing cleanup.');
    await rm(root, {recursive: true, force: false});
    report({event: 'test-compile-cache', status: 'removed', cacheId});
  } catch (cleanupError) {
    if (didFail) throw Object.assign(new AggregateError([originalError, cleanupError], 'Test compile cache execution and cleanup failed'), {cacheCleanupFailed: true});
    throw Object.assign(Error('Owned test compile cache cleanup failed.', {cause: cleanupError}), {code: 'TEST_COMPILE_CACHE_CLEANUP_FAILED', cacheCleanupFailed: true});
  }
  if (didFail) throw originalError;
  return result as T;
  });
}

/** Explicit propagation for owned test child allowlists. The marker is created
 * only by the opt-in runner; an arbitrary inherited NODE_COMPILE_CACHE alone is
 * not enough. Node still validates each entry against runtime and source bytes. */
export function inheritedTestCompileCache(): NodeJS.ProcessEnv {
  if (process.env.NODE_DISABLE_COMPILE_CACHE) return {NODE_DISABLE_COMPILE_CACHE: '1'};
  const root = process.env[ownerKey];
  if (!root) return {};
  const active = getCompileCacheDir();
  if (!active || process.env.NODE_COMPILE_CACHE !== root || path.dirname(active) !== root || realpathSync(root) !== root) throw failed('Expected owned test compile cache is not active.');
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw failed('Inherited test compile cache is not private.');
  return {NODE_COMPILE_CACHE: root, [ownerKey]: root};
}
