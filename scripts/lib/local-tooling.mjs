import path from 'node:path';
import {constants} from 'node:os';
import {createRequire} from 'node:module';
import {readFile, realpath, readdir, stat} from 'node:fs/promises';
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

export async function preflight(root, {channel = 'development', media = false, probe = runMedia,
  nodeVersion = process.versions.node, platform = process.platform, arch = process.arch} = {}) {
  const checks = [], entries = {};
  const check = async (name, fn) => {
    try {const detail = await fn(); checks.push({name, status: 'passed', ...detail});}
    catch (error) {checks.push({name, status: 'failed', code: error.code || 'PREREQUISITE_FAILED',
      message: ['BUILD_METADATA_INVALID', 'BUILD_VERSION_MISMATCH', 'LOCAL_DEPENDENCY_INVALID', 'LOCAL_DEPENDENCY_MISSING', 'NODE_VERSION_REQUIRED'].includes(error.code) ? error.message : 'Local prerequisite check failed; see the documented requirement.'});}
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
    prerequisitesReady: checks.every(item => item.status === 'passed'), nativeReadiness: nativeReadiness(platform, arch)}, entries, metadata};
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
