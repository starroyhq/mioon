import path from 'node:path';
import {constants} from 'node:os';
import {constants as fsConstants} from 'node:fs';
import type {Stats} from 'node:fs';
import {createRequire} from 'node:module';
import {access, readFile, realpath, readdir, stat, lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import desktopIdentity from '../../apps/desktop/identity.ts';
import type {DesktopChannel} from '../../apps/desktop/identity.ts';
import buildMetadata from '../../apps/desktop/build-metadata.ts';
import type {BuildMetadata} from '../../apps/desktop/build-metadata.ts';
import {mediaEnvironment} from '../../packages/business/src/media-environment.ts';
import {run as runMedia} from '../../packages/business/src/media-runtime.ts';

export type ToolingCommand = 'doctor' | 'build' | 'test' | 'typecheck';
export interface ParsedArguments {
  readonly command: ToolingCommand;
  channel: DesktopChannel;
  concurrency: number;
  suite: 'portable' | 'full';
  files: string[];
  nativeReady: boolean;
  reporter?: 'tap' | 'spec';
  compileCache?: boolean;
  timings?: string;
  [key: string]: unknown;
}
export interface NativeReadiness {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly status: 'blocked' | 'unverified';
  readonly ready: false;
  readonly blocker: string;
  readonly note: string;
}
export interface InstalledPackage {readonly version: string; readonly entry: string}
export interface PackageManagerObservation {
  readonly name: 'pnpm';
  readonly status: 'unverified' | 'matched' | 'mismatch' | 'missing';
  readonly requiredVersion: string | null;
  readonly observedVersion: string | null;
  readonly source: 'package-metadata' | null;
  readonly code?: string;
  readonly nextStep?: string;
}
export interface CommandSpec {readonly command: string; readonly args: string[]; readonly cwd?: string}
export interface CommandResult {readonly code: number; readonly signal: string | null}
export interface NativeReadinessInput {readonly platform?: NodeJS.Platform; readonly arch?: string}
export interface ToolingEnvironmentOptions {readonly platform?: NodeJS.Platform; readonly mediaPaths?: boolean}
export interface PackageManagerInspectionOptions {readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform}
export interface PreflightCheck {readonly name: string; readonly status: 'passed' | 'failed' | 'not-run'; readonly code?: string; [key: string]: unknown}
export interface PreflightReport {
  readonly schemaVersion: 1;
  readonly scope: 'local-prerequisites';
  readonly checks: PreflightCheck[];
  readonly buildReady: boolean;
  readonly prerequisitesReady: boolean;
  readonly nativeReadiness: NativeReadiness;
  readonly packageManager?: PackageManagerObservation;
  readonly note?: string;
}
export interface PreflightResult {
  readonly report: PreflightReport;
  readonly entries: Record<string, InstalledPackage>;
  readonly metadata: Readonly<BuildMetadata> | undefined;
}
export interface PreflightOptions {
  channel?: DesktopChannel;
  media?: boolean;
  probe?: typeof runMedia;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  packageManagerEnvironment?: NodeJS.ProcessEnv;
}
export interface DiscoverTestsOptions {suite?: 'portable' | 'full'; files?: readonly string[]; platform?: NodeJS.Platform}
export interface ExecuteCommandOptions {
  env?: NodeJS.ProcessEnv;
  spawnChild?: typeof spawn;
  signalSource?: NodeJS.Process;
}
interface CodedError extends Error { code: string }

const fail = (code: string, message: string): CodedError => Object.assign(new Error(message), {code});
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const localPackages: readonly {readonly name: string; readonly scope: string; readonly entry: string}[] = [
  {name: 'vite', scope: 'apps/web', entry: 'bin/vite.js'},
  {name: 'esbuild', scope: '', entry: 'lib/main.js'},
  {name: 'electron', scope: '', entry: 'index.js'},
];
export const PORTABLE_TEST_FILES: readonly string[] = Object.freeze([
  'agent-protocol.test.mjs', 'mutation-contracts.test.mjs',
  'workspace-layout.test.mjs', 'workspace-state.test.mjs', 'workspace-panel-intent.test.mjs',
  'desktop-build-metadata.test.mjs', 'local-tooling.test.mjs',
  'typecheck-contract.test.mjs', 'typecheck-tooling.test.mjs',
]);
/** Per-file test timings may only be written under the repository's artifacts directory. */
export const TIMINGS_PATH = /^artifacts(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)+\.json$/;
export function parseArguments(args: readonly string[]): ParsedArguments {
  const [command, ...flags] = args;
  if (!['doctor', 'build', 'test', 'typecheck'].includes(command)) throw fail('TOOLING_USAGE', 'Usage: tooling.ts doctor|build|test|typecheck [documented options]');
  if (command === 'typecheck' && flags.length) throw fail('TOOLING_USAGE', 'The typecheck command accepts no options or compiler arguments.');
  const result: ParsedArguments = {command: command as ToolingCommand, channel: 'development', concurrency: 1, suite: 'portable', files: [], nativeReady: false};
  const seen = new Set<string>();
  for (const flag of flags) {
    const [key, ...parts] = flag.split('='), value = parts.join('=');
    if (key !== '--file' && seen.has(key)) throw fail('TOOLING_USAGE', 'Duplicate tooling option.');
    seen.add(key);
    if (key === '--channel' && command !== 'test') result.channel = desktopIdentity.identityForChannel(value).channel;
    else if (key === '--native-ready' && flag === key && command === 'doctor') result.nativeReady = true;
    else if (key === '--reporter' && command === 'test' && ['tap', 'spec'].includes(value)) result.reporter = value as 'tap' | 'spec';
    else if (key === '--compile-cache' && flag === key && command === 'test') result.compileCache = true;
    else if (key === '--timings' && command === 'test' && TIMINGS_PATH.test(value)) result.timings = value;
    else if (key === '--concurrency' && command === 'test' && /^[1-4]$/.test(value)) result.concurrency = Number(value);
    else if (key === '--suite' && command === 'test' && ['portable', 'full'].includes(value)) result.suite = value as 'portable' | 'full';
    else if (key === '--file' && command === 'test' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.test\.(?:mjs|ts)$/.test(value) && !result.files.includes(value)) result.files.push(value);
    else throw fail('TOOLING_USAGE', 'Unknown or invalid tooling option. See docs/PORTABLE-TOOLING.md.');
  }
  // The timing reporter runs beside the chosen one; Node needs every reporter's destination named.
  if (result.timings !== undefined && result.reporter === undefined) throw fail('TOOLING_USAGE', 'Test timings require an explicit --reporter.');
  return result;
}

export function nativeReadiness(platform: NodeJS.Platform = process.platform, arch: string = process.arch): NativeReadiness {
  const blocker = platform === 'win32' ? 'WINDOWS_ACL_UNIMPLEMENTED'
    : platform === 'darwin' ? 'MACOS_NATIVE_SIGNING_QA_UNVERIFIED'
      : platform === 'linux' ? 'EXACT_ARTIFACT_NATIVE_QA_REQUIRED' : 'UNSUPPORTED_NATIVE_PLATFORM';
  return {platform, arch, status: platform === 'win32' ? 'blocked' : 'unverified', ready: false, blocker,
    note: 'Prerequisite checks and a successful source build do not verify private storage, packaging, signing, native UI or release readiness.'};
}

// The same explicit OS/temp/locale allowlist as media processes, with only the
// two deliberately selected executable overrides added for local tests.
export function toolingEnvironment(source: NodeJS.ProcessEnv = process.env, {platform = process.platform, mediaPaths = false}: ToolingEnvironmentOptions = {}): Record<string, string> {
  const result = mediaEnvironment(source, {platform});
  result.MIOON_ENABLE_LIVE_PROVIDER = '0';
  if (mediaPaths) for (const key of ['MIOON_FFMPEG_PATH', 'MIOON_FFPROBE_PATH']) {
    if (typeof source[key] === 'string' && source[key]) result[key] = source[key];
  }
  return result;
}

export function isContainedPath(parent: string, child: string, paths: typeof path = path): boolean {
  const relative = paths.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}
export async function installedPackages(root: string): Promise<Record<string, InstalledPackage>> {
  const modules = await realpath(path.join(root, 'node_modules')).catch(() => {throw fail('LOCAL_DEPENDENCY_MISSING', 'Install the repository lockfile dependencies through the approved package-manager workflow first.');});
  const repository = await realpath(root);
  if (!isContainedPath(repository, modules)) throw fail('LOCAL_DEPENDENCY_INVALID', 'Repository node_modules must resolve inside the repository; external dependency fallbacks are not executed.');
  const result: Record<string, InstalledPackage> = {};
  for (const definition of localPackages) {
    try {
      const manifestPath = path.join(root, definition.scope, 'package.json');
      const declared = recordOf(JSON.parse(await readFile(manifestPath, 'utf8')));
      const devDependencies = recordOf(declared?.devDependencies), dependencies = recordOf(declared?.dependencies);
      const expected = buildMetadata.requireExactVersion(devDependencies?.[definition.name] ?? dependencies?.[definition.name], 'Local dependency version');
      const require = createRequire(manifestPath);
      const packageFile = await realpath(require.resolve(`${definition.name}/package.json`));
      if (!isContainedPath(modules, packageFile)) throw Error();
      const actual = recordOf(JSON.parse(await readFile(packageFile, 'utf8')));
      if (actual?.name !== definition.name || actual.version !== expected) throw Error();
      const entry = await realpath(path.join(path.dirname(packageFile), definition.entry));
      if (!isContainedPath(path.dirname(packageFile), entry) || !(await stat(entry)).isFile()) throw Error();
      if (definition.name === 'vite' && recordOf(actual.bin)?.vite !== definition.entry) throw Error();
      result[definition.name] = {version: expected, entry};
    } catch {
      throw fail('LOCAL_DEPENDENCY_INVALID', `Installed ${definition.name} must match its exact local manifest pin and expected entrypoint; restore dependencies from the reviewed lockfile.`);
    }
  }
  return result;
}

// Resolve only the explicitly declared classic JavaScript compiler in this
// repository. Never consult PATH, global packages, package-manager shims or an
// ancestor node_modules. Normal pnpm links into this local tree remain valid.
export async function installedTypeScript(root: string): Promise<{readonly version: string; readonly entry: string}> {
  let repository: string, modules: string;
  try {
    repository = await realpath(root);
    modules = await realpath(path.join(repository, 'node_modules'));
  } catch {
    throw fail('TYPECHECK_DEPENDENCY_MISSING', 'Repository-local TypeScript is missing. Prepare the reviewed lockfile dependencies explicitly before typechecking; no installation was attempted.');
  }
  try {
    if (!isContainedPath(repository, modules) || !(await stat(modules)).isDirectory()) throw Error();
    const rootManifest = path.join(repository, 'package.json');
    if (await realpath(rootManifest) !== rootManifest || !(await stat(rootManifest)).isFile()) throw Error();
    const declared = recordOf(JSON.parse(await readFile(rootManifest, 'utf8')));
    const expected = buildMetadata.requireExactVersion(recordOf(declared?.devDependencies)?.typescript, 'Local TypeScript version');
    const packageRoot = await realpath(path.join(modules, 'typescript'));
    if (!isContainedPath(modules, packageRoot) || !(await stat(packageRoot)).isDirectory()) throw Error();
    const packageFile = path.join(packageRoot, 'package.json');
    if (await realpath(packageFile) !== packageFile || !(await stat(packageFile)).isFile()) throw Error();
    const actual = recordOf(JSON.parse(await readFile(packageFile, 'utf8')));
    if (actual?.name !== 'typescript' || actual.version !== expected || recordOf(actual.bin)?.tsc !== './bin/tsc') throw Error();
    // These exact regular paths are the reviewed JS compiler layout. A symlink
    // to another entry, including one elsewhere inside the package, is invalid.
    for (const relative of ['bin/tsc', 'lib/tsc.js', 'lib/_tsc.js']) {
      const entry = path.join(packageRoot, relative);
      if (await realpath(entry) !== entry || !(await stat(entry)).isFile()) throw Error();
    }
    return {version: expected, entry: path.join(packageRoot, 'lib/tsc.js')};
  } catch {
    throw fail('TYPECHECK_DEPENDENCY_INVALID', 'Installed TypeScript must match the exact root devDependency pin, expected JavaScript compiler entries and repository-local paths. Restore the reviewed lockfile dependencies explicitly; no installation or repair was attempted.');
  }
}

export async function typecheckCommands(root: string, execPath: string = process.execPath): Promise<CommandSpec[]> {
  await verifySourceLanguages(root);
  const compiler = await installedTypeScript(root);
  return ['tests/typecheck/tsconfig.foundation.json', 'tests/typecheck/tsconfig.browser.json', 'tests/tsconfig.tests.json'].map(project => ({
    command: execPath, args: [compiler.entry, '--project', project, '--noEmit', '--pretty', 'false'], cwd: root,
  }));
}

// Runtime application source is TypeScript-only. The empty checked allowlist is
// retained as a fail-closed policy marker: any legacy JavaScript path, including
// a stale allowlist entry, is rejected rather than silently grandfathered.
export async function verifySourceLanguages(root: string): Promise<void> {
  let legacy: unknown;
  try {
    legacy = JSON.parse(await readFile(path.join(root, 'config/typecheck-legacy-sources.json'), 'utf8'));
    if (!Array.isArray(legacy) || legacy.length !== 0) throw Error();
  } catch {
    throw fail('TYPECHECK_SOURCE_POLICY_INVALID', 'The runtime JavaScript allowlist must be present and empty; application source is TypeScript-only.');
  }
  let examined = 0;
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
      if (++examined > 20000) throw fail('TYPECHECK_SOURCE_POLICY_INVALID', 'Runtime source traversal exceeded the reviewed 20000-entry bound.');
      const file = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw fail('TYPECHECK_SOURCE_POLICY_INVALID', 'Runtime source symlinks are not followed by the language guard.');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(?:js|jsx|mjs|cjs)$/.test(entry.name)) {
        throw fail('TYPECHECK_NEW_JAVASCRIPT', `Runtime application source must use .ts/.tsx: ${file}`);
      } else if (entry.isFile() && /\.tsx$/.test(entry.name) && !/^(?:apps\/web|packages\/ui)\/src\//.test(file)) {
        throw fail('TYPECHECK_UNSUPPORTED_TSX', `TSX source is only supported in the browser build: ${file}`);
      } else if (entry.isFile() && /\.(?:mts|cts)$/.test(entry.name)) {
        throw fail('TYPECHECK_SOURCE_POLICY_INVALID', 'Runtime TypeScript source must use the checked .ts/.tsx extensions.');
      }
    }
  };
  for (const group of ['apps', 'packages']) {
    const directory = path.join(root, group);
    const groupInfo: Stats | null = await lstat(directory).catch(error => {if (errorCode(error) === 'ENOENT') return null; throw error;});
    if (!groupInfo) continue;
    if (!groupInfo.isDirectory() || groupInfo.isSymbolicLink()) throw fail('TYPECHECK_SOURCE_POLICY_INVALID', 'Runtime source groups must be repository-local directories.');
    for (const workspace of await readdir(directory, {withFileTypes: true})) {
      if (++examined > 20000) throw fail('TYPECHECK_SOURCE_POLICY_INVALID', 'Runtime source traversal exceeded the reviewed 20000-entry bound.');
      if (workspace.isSymbolicLink()) throw fail('TYPECHECK_SOURCE_POLICY_INVALID', 'Runtime workspace symlinks are not followed by the language guard.');
      if (!workspace.isDirectory()) continue;
      const relative = `${group}/${workspace.name}/src`;
      const source: Stats | null = await lstat(path.join(root, relative)).catch(error => {if (errorCode(error) === 'ENOENT') return null; throw error;});
      if (!source) continue;
      if (!source.isDirectory() || source.isSymbolicLink()) throw fail('TYPECHECK_SOURCE_POLICY_INVALID', 'Runtime source roots must be repository-local directories.');
      await visit(relative);
    }
  }
}

// Advisory only: running even `pnpm --version` can download the project's pinned
// manager. Inspect a recognizable POSIX installation, never execute a shim or
// skip an unknown first candidate to report a different command's version.
export async function inspectPackageManager(root: string, {env = process.env, platform = process.platform}: PackageManagerInspectionOptions = {}): Promise<PackageManagerObservation> {
  let requiredVersion: string;
  try {
    const manifest = recordOf(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')));
    requiredVersion = buildMetadata.requireExactVersion(typeof manifest?.packageManager === 'string' ? /^pnpm@(.+)$/.exec(manifest.packageManager)?.[1] : undefined, 'pnpm version');
  } catch {
    return {name: 'pnpm', status: 'unverified', requiredVersion: null, observedVersion: null, source: null,
      code: 'PNPM_DECLARATION_INVALID', nextStep: 'Check the exact pnpm pin in package.json before preparing dependencies.'};
  }
  const result = (status: PackageManagerObservation['status'], observedVersion: string | null = null): PackageManagerObservation => ({name: 'pnpm', status, requiredVersion, observedVersion,
    source: observedVersion === null ? null : 'package-metadata',
    ...(status === 'matched' ? {} : {code: `PNPM_${status.toUpperCase()}`,
      nextStep: `Prepare pnpm ${requiredVersion} before installing dependencies. This is a static observation; no pnpm command was executed. Unknown shims or wrappers require separate verification.`})});
  // Windows shims/standalone executables and implicit/relative PATH lookup have
  // no reliable package metadata mapping here. Unknown is not missing or passed.
  const searchPath = env.PATH;
  if (platform === 'win32' || typeof searchPath !== 'string' || !searchPath) return result('unverified');
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) return result('unverified');
    let executable: string;
    try {
      executable = await realpath(path.join(directory, 'pnpm'));
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, fsConstants.X_OK);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(errorCode(error) ?? '')) continue;
      return result('unverified');
    }
    try {
      const packageRoot = path.dirname(path.dirname(executable));
      const packageFile = await realpath(path.join(packageRoot, 'package.json'));
      const packageInfo = await stat(packageFile);
      if (path.dirname(packageFile) !== packageRoot || !packageInfo.isFile() || packageInfo.size > 64 * 1024) throw Error();
      const metadata = recordOf(JSON.parse(await readFile(packageFile, 'utf8')));
      if (metadata?.name !== 'pnpm' || typeof recordOf(metadata.bin)?.pnpm !== 'string' || path.isAbsolute(recordOf(metadata.bin)?.pnpm as string)) throw Error();
      const version = buildMetadata.requireExactVersion(metadata.version, 'Installed pnpm version');
      const declaredEntry = path.resolve(packageRoot, recordOf(metadata.bin)?.pnpm as string);
      if (!isContainedPath(packageRoot, declaredEntry) || await realpath(declaredEntry) !== executable) throw Error();
      return result(version === requiredVersion ? 'matched' : 'mismatch', version);
    } catch { return result('unverified'); }
  }
  return result('missing');
}

function prerequisiteFailure(name: string, error: unknown): PreflightCheck {
  const failures: Readonly<Record<string, readonly [string, string]>> = {
    NODE_VERSION_REQUIRED: ['Node.js 24 or newer is required.', 'Select Node.js >=24 and rerun this command.'],
    BUILD_METADATA_INVALID: ['Root and desktop application versions or the Electron pin are invalid.', 'Check the root and desktop package.json versions and exact Electron pin before rebuilding.'],
    LOCAL_DEPENDENCY_MISSING: ['Repository node_modules is missing or cannot be resolved.', 'Prepare the package.json-pinned pnpm, then explicitly run pnpm install --frozen-lockfile. No installation was attempted.'],
    LOCAL_DEPENDENCY_INVALID: ['Local Vite, esbuild or Electron metadata, entrypoint or path containment failed validation.', 'Check repository-local dependency paths and exact pins; restore lockfile dependencies with the pinned pnpm after resolving the path issue.'],
    MEDIA_INVALID_CONFIGURATION: ['The media executable override is invalid.', 'Use an absolute executable path for the corresponding MIOON_FFMPEG_PATH or MIOON_FFPROBE_PATH override.'],
    MEDIA_SPAWN_FAILED: ['The selected media tool could not be started; it may be missing, inaccessible or incompatible.', 'Check PATH or the corresponding MIOON_FFMPEG_PATH / MIOON_FFPROBE_PATH override, executable permission and OS/CPU compatibility.'],
    MEDIA_TIMEOUT: ['The media version probe timed out.', 'Check that the selected executable can return -version promptly; no application or media operation was started.'],
    MEDIA_EXIT_FAILED: ['The media version probe exited unsuccessfully.', 'Check the selected executable and its required libraries using -version; no installation or repair was attempted.'],
    MEDIA_VERSION_INVALID: ['The executable did not return the expected media version header.', 'Select the actual ffmpeg or ffprobe executable, rather than another binary or wrapper.'],
    MEDIA_OUTPUT_LIMIT: ['The media version probe exceeded its output limit.', 'Check that the override selects the actual ffmpeg or ffprobe executable.'],
    MEDIA_PROCESS_FAILED: ['The media probe process or its output stream failed.', 'Check the selected executable and local runtime, then rerun doctor.'],
    MEDIA_CANCELLED: ['The media version probe was interrupted.', 'Rerun doctor after the interruption is resolved.'],
    MEDIA_TERMINATION_UNCONFIRMED: ['A previous media probe has not confirmed its exit.', 'Check the owned probe process before rerunning doctor; no replacement process was started.'],
  };
  const candidate = errorCode(error);
  const code = candidate !== undefined && Object.hasOwn(failures, candidate) ? candidate : 'PREREQUISITE_FAILED';
  const [message, nextStep] = failures[code] || ['Local prerequisite check failed.',
    name === 'sqliteMemory' ? 'Check that this Node runtime provides working node:sqlite support; no workspace database was opened.'
      : 'Check the documented local prerequisite. Raw errors and tool output are intentionally omitted.'];
  return {name, status: 'failed', code, message, nextStep};
}

export async function preflight(root: string, {channel = 'development', media = false, probe = runMedia,
  nodeVersion = process.versions.node, platform = process.platform, arch = process.arch,
  packageManagerEnvironment = process.env}: PreflightOptions = {}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [], entries: Record<string, InstalledPackage> = {};
  const check = async (name: string, fn: () => object | Promise<object>): Promise<void> => {
    try {const detail = await fn(); checks.push({name, status: 'passed', ...detail});}
    catch (error) {checks.push(prerequisiteFailure(name, error));}
  };
  await check('node', async () => {
    if (!/^\d+\./.test(nodeVersion) || Number(nodeVersion.split('.')[0]) < 24) throw fail('NODE_VERSION_REQUIRED', 'Node.js 24 or newer is required.');
    return {version: nodeVersion};
  });
  let metadata: Readonly<BuildMetadata> | undefined;
  await check('buildIdentity', async () => {try {metadata = buildMetadata.readBuildMetadata(root);} catch {throw fail('BUILD_METADATA_INVALID', 'Root and desktop package.json must be readable, have matching exact application versions, and pin an exact root Electron version. Update the source manifests before rebuilding; existing staging is preserved.');} return {appVersion: metadata.appVersion, electronVersion: metadata.electronVersion, identity: desktopIdentity.identityForChannel(channel)};});
  await check('installedDependencies', async () => {Object.assign(entries, await installedPackages(root)); return {versions: Object.fromEntries(Object.entries(entries).map(([name, item]) => [name, item.version]))};});
  if (checks[0].status === 'passed') await check('sqliteMemory', async () => {
    const {DatabaseSync} = await import('node:sqlite'); const db = new DatabaseSync(':memory:');
    try {return {version: (db.prepare('SELECT sqlite_version() AS version').get() as {version?: unknown}).version};} finally {db.close();}
  });
  else checks.push({name: 'sqliteMemory', status: 'not-run', code: 'NODE_VERSION_REQUIRED'});
  const buildReady = checks.every(item => item.status === 'passed');
  if (media) for (const name of ['ffmpeg', 'ffprobe']) await check(name, async () => {
    const output = await probe(name, ['-version'], {timeout: 10000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024});
    const match = new RegExp(`^${name} version ([A-Za-z0-9._+\\-]{1,100})(?:\\s|$)`).exec(output);
    if (!match) throw fail('MEDIA_VERSION_INVALID', 'Unexpected local media version response.');
    return {version: match[1]};
  });
  return {report: {schemaVersion: 1, scope: 'local-prerequisites', checks, buildReady,
    prerequisitesReady: checks.every(item => item.status === 'passed'), nativeReadiness: nativeReadiness(platform, arch),
    ...(media ? {packageManager: await inspectPackageManager(root, {env: packageManagerEnvironment, platform}),
      note: 'buildReady checks installed source-build prerequisites, not a completed build. prerequisitesReady also includes media version probes. The pnpm observation is advisory for dependency installation and does not change these flags or exit codes. Native release verification is separate.'} : {})}, entries, metadata};
}

export async function discoverTests(root: string, {suite = 'portable', files = [], platform = process.platform}: DiscoverTestsOptions = {}): Promise<string[]> {
  if (!['portable', 'full'].includes(suite)) throw fail('TOOLING_USAGE', 'Unknown test suite.');
  if (suite === 'full' && platform !== 'linux') throw fail('NATIVE_TEST_LANE_BLOCKED', 'The full suite contains Linux/native storage assumptions. Run the reviewed portable lane; native platform validation remains required.');
  // Transitional dual discovery: `.test.mjs` files are migrated to `.test.ts`
  // wave by wave. A reviewed portable or explicit name is resolved to the file
  // that currently exists; an unknown or duplicated selection still fails.
  const available = (await readdir(path.join(root, 'tests'), {withFileTypes: true}))
    .filter(item => item.isFile() && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.test\.(?:mjs|ts)$/.test(item.name)).map(item => item.name).sort();
  const resolve = (file: string): string | null => {
    if (available.includes(file)) return file;
    const migrated = file.replace(/\.mjs$/, '.ts');
    return available.includes(migrated) ? migrated : null;
  };
  const allowed: readonly string[] = suite === 'portable' ? PORTABLE_TEST_FILES : available;
  const selected = files.length ? files : allowed;
  const resolved = selected.map(resolve);
  if (!selected.length || selected.length > 2048 || new Set(resolved).size !== resolved.length ||
      selected.some((file, index) => !allowed.includes(file) || resolved[index] === null)) throw fail('TEST_SELECTION_INVALID', 'Test selection is missing, duplicated, or outside the chosen reviewed suite.');
  const result = (resolved as string[]).sort().map(file => `tests/${file}`);
  if (result.join(' ').length > 131072) throw fail('TEST_SELECTION_LIMIT', 'Test command exceeds the reviewed argument budget; select a smaller explicit file group.');
  return result;
}
export function buildCommands(root: string, entries: Record<string, InstalledPackage>, channel: DesktopChannel, execPath: string = process.execPath): CommandSpec[] {
  desktopIdentity.identityForChannel(channel);
  return [
    {command: execPath, args: ['--max-old-space-size=768', entries.vite.entry, 'build'], cwd: path.join(root, 'apps/web')},
    {command: execPath, args: [path.join(root, 'apps/desktop/scripts/build.ts'), `--channel=${channel}`], cwd: root},
  ];
}
export function testCommand(root: string, files: readonly string[], concurrency = 1, execPath: string = process.execPath, reporter?: 'tap' | 'spec', timings?: string): CommandSpec {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw fail('TOOLING_USAGE', 'Test concurrency must be between 1 and 4.');
  if (reporter !== undefined && !['tap', 'spec'].includes(reporter)) throw fail('TOOLING_USAGE', 'Test reporter must be tap or spec.');
  if (timings !== undefined && (reporter === undefined || !TIMINGS_PATH.test(timings))) throw fail('TOOLING_USAGE', 'Test timings need an explicit reporter and a JSON path under artifacts/.');
  const reporters = timings === undefined ? (reporter ? [`--test-reporter=${reporter}`] : [])
    : [`--test-reporter=${reporter}`, '--test-reporter-destination=stdout', `--test-reporter=${path.join(root, 'scripts/lib/test-timing-reporter.ts')}`, `--test-reporter-destination=${path.join(root, ...timings.split('/'))}`];
  return {command: execPath, args: ['--test', ...reporters, `--test-concurrency=${concurrency}`, ...files], cwd: root};
}

// Owned direct child only; never a shell, numeric PID signal, or automatic retry.
export function executeCommand(spec: CommandSpec, {env = toolingEnvironment(), spawnChild = spawn, signalSource = process}: ExecuteCommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess, settled = false, forwardedSignal: NodeJS.Signals | undefined;
    const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    const forward = (signal: NodeJS.Signals) => {if (!settled) {forwardedSignal ||= signal; try {child.kill(signal);} catch { /* close/error determines outcome */ }}};
    const listeners = signals.map(signal => [signal, () => forward(signal)] as const);
    const cleanup = () => {for (const [signal, fn] of listeners) signalSource.off(signal, fn);};
    try {child = spawnChild(spec.command, spec.args, {cwd: spec.cwd, env, shell: false, windowsHide: true, stdio: 'inherit'});}
    catch {reject(fail('TOOL_START_FAILED', 'Could not start the verified local tooling entrypoint.')); return;}
    for (const [signal, fn] of listeners) signalSource.on(signal, fn);
    child.once('error', () => {if (!settled) {settled = true; cleanup(); reject(fail('TOOL_START_FAILED', 'Could not start the verified local tooling entrypoint.'));}});
    child.once('close', (code, signal) => {if (!settled) {settled = true; cleanup(); const terminalSignal = forwardedSignal || signal; resolve({code: terminalSignal ? 128 + ((constants.signals as Readonly<Record<string, number>>)[terminalSignal] || 1) : Number.isInteger(code) ? code as number : 1, signal: terminalSignal || null});}});
  });
}
