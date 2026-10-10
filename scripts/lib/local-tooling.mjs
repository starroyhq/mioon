import path from 'node:path';
import {constants} from 'node:os';
import {constants as fsConstants} from 'node:fs';
import {createRequire} from 'node:module';
import {access, readFile, realpath, readdir, stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import desktopIdentity from '../../apps/desktop/identity.cjs';
import buildMetadata from '../../apps/desktop/build-metadata.cjs';
import {mediaEnvironment} from '../../packages/business/src/media-environment.mjs';
import {run as runMedia} from '../../packages/business/src/media-runtime.mjs';

const fail = (code, message) => Object.assign(new Error(message), {code});
const localPackages = [
  {name: 'vite', scope: 'apps/web', entry: 'bin/vite.js'},
  {name: 'esbuild', scope: '', entry: 'lib/main.js'},
  {name: 'electron', scope: '', entry: 'index.js'},
];
export const PORTABLE_TEST_FILES = Object.freeze([
  'agent-protocol.test.mjs', 'mutation-contracts.test.mjs',
  'workspace-layout.test.mjs', 'workspace-state.test.mjs', 'workspace-panel-intent.test.mjs',
  'desktop-build-metadata.test.mjs', 'local-tooling.test.mjs',
]);
export function parseArguments(args) {
  const [command, ...flags] = args;
  if (!['doctor', 'build', 'test'].includes(command)) throw fail('TOOLING_USAGE', 'Usage: tooling.mjs doctor|build|test [documented options]');
  const result = {command, channel: 'development', concurrency: 1, suite: 'portable', files: [], nativeReady: false};
  const seen = new Set();
  for (const flag of flags) {
    const [key, ...parts] = flag.split('='), value = parts.join('=');
    if (key !== '--file' && seen.has(key)) throw fail('TOOLING_USAGE', 'Duplicate tooling option.');
    seen.add(key);
    if (key === '--channel' && command !== 'test') result.channel = desktopIdentity.identityForChannel(value).channel;
    else if (key === '--native-ready' && flag === key && command === 'doctor') result.nativeReady = true;
    else if (key === '--concurrency' && command === 'test' && /^[1-4]$/.test(value)) result.concurrency = Number(value);
    else if (key === '--suite' && command === 'test' && ['portable', 'full'].includes(value)) result.suite = value;
    else if (key === '--file' && command === 'test' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.test\.mjs$/.test(value) && !result.files.includes(value)) result.files.push(value);
    else throw fail('TOOLING_USAGE', 'Unknown or invalid tooling option. See docs/PORTABLE-TOOLING.md.');
  }
  return result;
}

export function nativeReadiness(platform = process.platform, arch = process.arch) {
  const blocker = platform === 'win32' ? 'WINDOWS_ACL_UNIMPLEMENTED'
    : platform === 'darwin' ? 'MACOS_NATIVE_SIGNING_QA_UNVERIFIED'
      : platform === 'linux' ? 'EXACT_ARTIFACT_NATIVE_QA_REQUIRED' : 'UNSUPPORTED_NATIVE_PLATFORM';
  return {platform, arch, status: platform === 'win32' ? 'blocked' : 'unverified', ready: false, blocker,
    note: 'Prerequisite checks and a successful source build do not verify private storage, packaging, signing, native UI or release readiness.'};
}

// The same explicit OS/temp/locale allowlist as media processes, with only the
// two deliberately selected executable overrides added for local tests.
export function toolingEnvironment(source = process.env, {platform = process.platform, mediaPaths = false} = {}) {
  const result = mediaEnvironment(source, {platform});
  result.MIOON_ENABLE_LIVE_PROVIDER = '0';
  if (mediaPaths) for (const key of ['MIOON_FFMPEG_PATH', 'MIOON_FFPROBE_PATH']) {
    if (typeof source[key] === 'string' && source[key]) result[key] = source[key];
  }
  return result;
}

export function isContainedPath(parent, child, paths = path) {
  const relative = paths.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}
export async function installedPackages(root) {
  const modules = await realpath(path.join(root, 'node_modules')).catch(() => {throw fail('LOCAL_DEPENDENCY_MISSING', 'Install the repository lockfile dependencies through the approved package-manager workflow first.');});
  const repository = await realpath(root);
  if (!isContainedPath(repository, modules)) throw fail('LOCAL_DEPENDENCY_INVALID', 'Repository node_modules must resolve inside the repository; external dependency fallbacks are not executed.');
  const result = {};
  for (const definition of localPackages) {
    try {
      const manifestPath = path.join(root, definition.scope, 'package.json');
      const declared = JSON.parse(await readFile(manifestPath, 'utf8'));
      const expected = declared.devDependencies?.[definition.name] ?? declared.dependencies?.[definition.name];
      buildMetadata.requireExactVersion(expected, 'Local dependency version');
      const require = createRequire(manifestPath);
      const packageFile = await realpath(require.resolve(`${definition.name}/package.json`));
      if (!isContainedPath(modules, packageFile)) throw Error();
      const actual = JSON.parse(await readFile(packageFile, 'utf8'));
      if (actual.name !== definition.name || actual.version !== expected) throw Error();
      const entry = await realpath(path.join(path.dirname(packageFile), definition.entry));
      if (!isContainedPath(path.dirname(packageFile), entry) || !(await stat(entry)).isFile()) throw Error();
      if (definition.name === 'vite' && actual.bin?.vite !== definition.entry) throw Error();
      result[definition.name] = {version: actual.version, entry};
    } catch {
      throw fail('LOCAL_DEPENDENCY_INVALID', `Installed ${definition.name} must match its exact local manifest pin and expected entrypoint; restore dependencies from the reviewed lockfile.`);
    }
  }
  return result;
}

// Advisory only: running even `pnpm --version` can download the project's pinned
// manager. Inspect a recognizable POSIX installation, never execute a shim or
// skip an unknown first candidate to report a different command's version.
export async function inspectPackageManager(root, {env = process.env, platform = process.platform} = {}) {
  let requiredVersion;
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    requiredVersion = buildMetadata.requireExactVersion(/^pnpm@(.+)$/.exec(manifest.packageManager)?.[1], 'pnpm version');
  } catch {
    return {name: 'pnpm', status: 'unverified', requiredVersion: null, observedVersion: null, source: null,
      code: 'PNPM_DECLARATION_INVALID', nextStep: 'Check the exact pnpm pin in package.json before preparing dependencies.'};
  }
  const result = (status, observedVersion = null) => ({name: 'pnpm', status, requiredVersion, observedVersion,
    source: observedVersion === null ? null : 'package-metadata',
    ...(status === 'matched' ? {} : {code: `PNPM_${status.toUpperCase()}`,
      nextStep: `Prepare pnpm ${requiredVersion} before installing dependencies. This is a static observation; no pnpm command was executed. Unknown shims or wrappers require separate verification.`})});
  // Windows shims/standalone executables and implicit/relative PATH lookup have
  // no reliable package metadata mapping here. Unknown is not missing or passed.
  if (platform === 'win32' || typeof env.PATH !== 'string' || !env.PATH) return result('unverified');
  for (const directory of env.PATH.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) return result('unverified');
    let executable;
    try {
      executable = await realpath(path.join(directory, 'pnpm'));
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, fsConstants.X_OK);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) continue;
      return result('unverified');
    }
    try {
      const packageRoot = path.dirname(path.dirname(executable));
      const packageFile = await realpath(path.join(packageRoot, 'package.json'));
      const packageInfo = await stat(packageFile);
      if (path.dirname(packageFile) !== packageRoot || !packageInfo.isFile() || packageInfo.size > 64 * 1024) throw Error();
      const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
      if (metadata.name !== 'pnpm' || typeof metadata.bin?.pnpm !== 'string' || path.isAbsolute(metadata.bin.pnpm)) throw Error();
      buildMetadata.requireExactVersion(metadata.version, 'Installed pnpm version');
      const declaredEntry = path.resolve(packageRoot, metadata.bin.pnpm);
      if (!isContainedPath(packageRoot, declaredEntry) || await realpath(declaredEntry) !== executable) throw Error();
      return result(metadata.version === requiredVersion ? 'matched' : 'mismatch', metadata.version);
    } catch { return result('unverified'); }
  }
  return result('missing');
}

function prerequisiteFailure(name, error) {
  const failures = {
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
  const code = Object.hasOwn(failures, error?.code) ? error.code : 'PREREQUISITE_FAILED';
  const [message, nextStep] = failures[code] || ['Local prerequisite check failed.',
    name === 'sqliteMemory' ? 'Check that this Node runtime provides working node:sqlite support; no workspace database was opened.'
      : 'Check the documented local prerequisite. Raw errors and tool output are intentionally omitted.'];
  return {name, status: 'failed', code, message, nextStep};
}

export async function preflight(root, {channel = 'development', media = false, probe = runMedia,
  nodeVersion = process.versions.node, platform = process.platform, arch = process.arch,
  packageManagerEnvironment = process.env} = {}) {
  const checks = [], entries = {};
  const check = async (name, fn) => {
    try {const detail = await fn(); checks.push({name, status: 'passed', ...detail});}
    catch (error) {checks.push(prerequisiteFailure(name, error));}
  };
  await check('node', async () => {
    if (!/^\d+\./.test(nodeVersion) || Number(nodeVersion.split('.')[0]) < 24) throw fail('NODE_VERSION_REQUIRED', 'Node.js 24 or newer is required.');
    return {version: nodeVersion};
  });
  let metadata;
  await check('buildIdentity', async () => {try {metadata = buildMetadata.readBuildMetadata(root);} catch {throw fail('BUILD_METADATA_INVALID', 'Root and desktop package.json must be readable, have matching exact application versions, and pin an exact root Electron version. Update the source manifests before rebuilding; existing staging is preserved.');} return {appVersion: metadata.appVersion, electronVersion: metadata.electronVersion, identity: desktopIdentity.identityForChannel(channel)};});
  await check('installedDependencies', async () => {Object.assign(entries, await installedPackages(root)); return {versions: Object.fromEntries(Object.entries(entries).map(([name, item]) => [name, item.version]))};});
  if (checks[0].status === 'passed') await check('sqliteMemory', async () => {
    const {DatabaseSync} = await import('node:sqlite'); const db = new DatabaseSync(':memory:');
    try {return {version: db.prepare('SELECT sqlite_version() AS version').get().version};} finally {db.close();}
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

export async function discoverTests(root, {suite = 'portable', files = [], platform = process.platform} = {}) {
  if (!['portable', 'full'].includes(suite)) throw fail('TOOLING_USAGE', 'Unknown test suite.');
  if (suite === 'full' && platform !== 'linux') throw fail('NATIVE_TEST_LANE_BLOCKED', 'The full suite contains Linux/native storage assumptions. Run the reviewed portable lane; native platform validation remains required.');
  const available = (await readdir(path.join(root, 'tests'), {withFileTypes: true}))
    .filter(item => item.isFile() && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.test\.mjs$/.test(item.name)).map(item => item.name).sort();
  const allowed = suite === 'portable' ? PORTABLE_TEST_FILES : available;
  const selected = files.length ? files : allowed;
  if (!selected.length || selected.length > 512 || new Set(selected).size !== selected.length || selected.some(file => !allowed.includes(file) || !available.includes(file))) throw fail('TEST_SELECTION_INVALID', 'Test selection is missing, duplicated, or outside the chosen reviewed suite.');
  const result = [...selected].sort().map(file => `tests/${file}`);
  if (result.join(' ').length > 24000) throw fail('TEST_SELECTION_LIMIT', 'Test command exceeds the portable argument budget; select a smaller explicit file group.');
  return result;
}
export function buildCommands(root, entries, channel, execPath = process.execPath) {
  desktopIdentity.identityForChannel(channel);
  return [
    {command: execPath, args: ['--max-old-space-size=768', entries.vite.entry, 'build'], cwd: path.join(root, 'apps/web')},
    {command: execPath, args: [path.join(root, 'apps/desktop/scripts/build.mjs'), `--channel=${channel}`], cwd: root},
  ];
}
export function testCommand(root, files, concurrency = 1, execPath = process.execPath) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw fail('TOOLING_USAGE', 'Test concurrency must be between 1 and 4.');
  return {command: execPath, args: ['--test', `--test-concurrency=${concurrency}`, ...files], cwd: root};
}

// Owned direct child only; never a shell, numeric PID signal, or automatic retry.
export function executeCommand(spec, {env = toolingEnvironment(), spawnChild = spawn, signalSource = process} = {}) {
  return new Promise((resolve, reject) => {
    let child, settled = false, forwardedSignal;
    const signals = ['SIGINT', 'SIGTERM'];
    const forward = signal => {if (!settled) {forwardedSignal ||= signal; try {child.kill(signal);} catch { /* close/error determines outcome */ }}};
    const listeners = signals.map(signal => [signal, () => forward(signal)]);
    const cleanup = () => {for (const [signal, fn] of listeners) signalSource.off(signal, fn);};
    try {child = spawnChild(spec.command, spec.args, {cwd: spec.cwd, env, shell: false, windowsHide: true, stdio: 'inherit'});}
    catch {reject(fail('TOOL_START_FAILED', 'Could not start the verified local tooling entrypoint.')); return;}
    for (const [signal, fn] of listeners) signalSource.on(signal, fn);
    child.once('error', () => {if (!settled) {settled = true; cleanup(); reject(fail('TOOL_START_FAILED', 'Could not start the verified local tooling entrypoint.'));}});
    child.once('close', (code, signal) => {if (!settled) {settled = true; cleanup(); const terminalSignal = forwardedSignal || signal; resolve({code: terminalSignal ? 128 + (constants.signals[terminalSignal] || 1) : Number.isInteger(code) ? code : 1, signal: terminalSignal || null});}});
  });
}
