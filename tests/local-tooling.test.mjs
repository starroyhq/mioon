import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArguments, nativeReadiness, toolingEnvironment, installedPackages, inspectPackageManager, preflight, discoverTests,
  PORTABLE_TEST_FILES, isContainedPath, buildCommands, testCommand, executeCommand} from '../scripts/lib/local-tooling.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function runToolingNode(args) {
  const result = spawnSync(process.execPath, args, {cwd: root, env: toolingEnvironment(),
    encoding: 'utf8', timeout: 5000, shell: false, windowsHide: true});
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test('tooling CLI entry handles canonical and aliased script paths identically', async t => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon tooling entry 中 '));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const alias = path.join(directory, 'scripts alias 中');
  await symlink(path.join(root, 'scripts'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const canonical = await realpath(path.join(root, 'scripts/tooling.mjs'));
  const entries = [canonical, path.join(alias, 'tooling.mjs')];
  // Windows uses the directory junction above; file symlinks can require privileges.
  if (process.platform !== 'win32') {
    const scriptAlias = path.join(directory, 'tooling alias 中.mjs');
    await symlink(canonical, scriptAlias);
    entries.push(scriptAlias);
  }
  for (const entry of entries) {
    // Invalid usage must reach the CLI parser without executing any preflight.
    const result = runToolingNode([entry, '__audit_invalid_command__']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'TOOLING_USAGE');
  }
});

test('tooling module import does not run the CLI for unrelated or missing entry paths', () => {
  const moduleUrl = new URL('../scripts/tooling.mjs', import.meta.url).href;
  for (const entry of [undefined, path.join(root, 'package.json'), path.join(root, 'scripts/tooling.mjs', 'missing')]) {
    const source = `process.argv[1] = ${JSON.stringify(entry)}; await import(${JSON.stringify(moduleUrl)}); process.stdout.write('imported\\n');`;
    const result = runToolingNode(['--input-type=module', '-e', source]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'imported\n');
    assert.equal(result.stderr, '');
  }
});

async function fixture(t) {
  // Canonicalize only this newly owned synthetic fixture, not a user data path.
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon tooling 中 '));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const json = async (name, value) => {await mkdir(path.dirname(path.join(directory, name)), {recursive: true}); await writeFile(path.join(directory, name), JSON.stringify(value));};
  await json('package.json', {version: '0.4.1', packageManager: 'pnpm@11.25.0', devDependencies: {esbuild: '0.27.7', electron: '44.7.0'}});
  await json('apps/desktop/package.json', {version: '0.4.1'});
  await json('apps/web/package.json', {devDependencies: {vite: '7.3.1'}});
  for (const [name, version, entry] of [['vite', '7.3.1', 'bin/vite.js'], ['esbuild', '0.27.7', 'lib/main.js'], ['electron', '44.7.0', 'index.js']]) {
    await json(`node_modules/${name}/package.json`, {name, version, ...(name === 'vite' ? {bin: {vite: entry}} : {})});
    await mkdir(path.dirname(path.join(directory, 'node_modules', name, entry)), {recursive: true});
    await writeFile(path.join(directory, 'node_modules', name, entry), '// Synthetic entrypoint; not executed.');
  }
  await mkdir(path.join(directory, 'tests'));
  for (const name of [...PORTABLE_TEST_FILES, 'z-native.test.mjs', 'a-full.test.mjs', 'not-a-test.mjs']) await writeFile(path.join(directory, 'tests', name), '');
  return {directory, json};
}

async function managerFixture(t, version = '11.25.0') {
  const state = await fixture(t), {directory, json} = state;
  const bin = path.join(directory, 'manager/bin'), sentinel = path.join(directory, 'must-not-execute');
  await json('manager/package.json', {name: 'pnpm', version, bin: {pnpm: 'bin/pnpm'}});
  await mkdir(bin);
  await writeFile(path.join(bin, 'pnpm'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`, {mode: 0o755});
  // Exercise metadata recognition using a synthetic POSIX command layout even
  // on Windows; the actual Windows observation remains explicitly unverified.
  return {...state, bin, sentinel, options: {env: {PATH: bin}, platform: 'linux'}};
}

test('pnpm metadata observation distinguishes exact pin and mismatch without executing the command', async t => {
  for (const version of ['11.25.0', '10.8.1']) {
    const {directory, options, sentinel} = await managerFixture(t, version);
    const observation = await inspectPackageManager(directory, options);
    assert.equal(observation.status, version === '11.25.0' ? 'matched' : 'mismatch');
    assert.equal(observation.requiredVersion, '11.25.0'); assert.equal(observation.observedVersion, version);
    assert.equal(observation.source, 'package-metadata');
    assert.doesNotMatch(JSON.stringify(observation), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await assert.rejects(readFile(sentinel), {code: 'ENOENT'});
  }
});
test('missing and unrecognized pnpm remain distinct; the first wrapper shadows a later installation', async t => {
  const {directory, bin, options, sentinel} = await managerFixture(t);
  const empty = path.join(directory, 'empty'), wrapper = path.join(directory, 'wrapper');
  await mkdir(empty); await mkdir(wrapper);
  assert.equal((await inspectPackageManager(directory, {...options, env: {PATH: empty}})).status, 'missing');
  await writeFile(path.join(wrapper, 'pnpm'), '#!/bin/sh\nexit 99\n', {mode: 0o755});
  const observation = await inspectPackageManager(directory, {...options, env: {PATH: `${wrapper}${path.delimiter}${bin}`}});
  assert.equal(observation.status, 'unverified'); assert.equal(observation.observedVersion, null);
  for (const PATH of [undefined, '', '.', `${path.delimiter}${bin}`]) {
    assert.equal((await inspectPackageManager(directory, {...options, env: {PATH}})).status, 'unverified');
  }
  assert.equal((await inspectPackageManager(directory, {...options, platform: 'win32'})).status, 'unverified');
  await assert.rejects(readFile(sentinel), {code: 'ENOENT'});
});
test('Corepack, invalid versions and mismatched bin declarations never masquerade as verified pnpm', async t => {
  const {directory, json, options} = await managerFixture(t);
  for (const metadata of [
    {name: 'corepack', version: '11.25.0', bin: {pnpm: 'bin/pnpm'}},
    {name: 'pnpm', version: 'SYNTHETIC_SECRET', bin: {pnpm: 'bin/pnpm'}},
    {name: 'pnpm', version: '11.25.0', bin: {pnpm: 'other-entry.cjs'}},
    {name: 'pnpm', version: '11.25.0', bin: {pnpm: '../outside.cjs'}},
  ]) {
    await json('manager/package.json', metadata);
    const observation = await inspectPackageManager(directory, options);
    assert.equal(observation.status, 'unverified'); assert.equal(observation.observedVersion, null);
    assert.doesNotMatch(JSON.stringify(observation), /SYNTHETIC_SECRET/);
  }
  await json('package.json', {packageManager: 'pnpm@latest'});
  assert.equal((await inspectPackageManager(directory, options)).code, 'PNPM_DECLARATION_INVALID');
});
test('doctor observes pnpm separately without changing direct Node build prerequisites or native gates', async t => {
  const {directory, options} = await managerFixture(t, '10.8.1');
  const probe = async name => `${name} version 7.1.5 Copyright`;
  const result = await preflight(directory, {media: true, nodeVersion: '26.9.0', platform: 'linux', probe, packageManagerEnvironment: options.env});
  assert.equal(result.report.packageManager.status, 'mismatch');
  assert.equal(result.report.buildReady, true); assert.equal(result.report.prerequisitesReady, true);
  assert.equal(result.report.nativeReadiness.ready, false);
  await rm(path.join(directory, 'manager'), {recursive: true});
  const direct = await preflight(directory, {packageManagerEnvironment: {get PATH() { assert.fail('Build/test must not inspect pnpm'); }}});
  assert.equal(direct.report.buildReady, true); assert.equal(direct.report.prerequisitesReady, true);
  assert.equal(Object.hasOwn(direct.report, 'packageManager'), false);
  await rm(path.join(directory, 'node_modules'), {recursive: true});
  const missing = await preflight(directory, {media: true, platform: 'linux', probe, packageManagerEnvironment: options.env});
  assert.equal(missing.report.buildReady, false); assert.equal(missing.report.packageManager.status, 'missing');
  assert.match(missing.report.checks.find(row => row.name === 'installedDependencies').nextStep, /--frozen-lockfile/);
});

test('tooling options are explicit and bounded; no shell or arbitrary command arguments', () => {
  assert.equal(parseArguments(['test']).suite, 'portable');
  assert.equal(parseArguments(['test']).concurrency, 1);
  assert.equal(parseArguments(['test']).compileCache, undefined);
  assert.equal(parseArguments(['test']).reporter, undefined);
  assert.equal(parseArguments(['test', '--reporter=tap']).reporter, 'tap');
  assert.equal(parseArguments(['test', '--reporter=spec']).reporter, 'spec');
  for (const args of [['test', '--reporter=other'], ['test', '--reporter=tap', '--reporter=spec'], ['build', '--reporter=tap']]) assert.throws(() => parseArguments(args));
  assert.throws(() => testCommand('.', [], 1, process.execPath, 'outside'));
  assert.ok(testCommand('.', [], 1, process.execPath, 'tap').args.includes('--test-reporter=tap'));
  assert.equal(parseArguments(['test', '--compile-cache']).compileCache, true);
  for (const args of [['build', '--compile-cache'], ['doctor', '--compile-cache'], ['test', '--compile-cache=yes'], ['test', '--compile-cache', '--compile-cache']]) assert.throws(() => parseArguments(args));
  assert.deepEqual(parseArguments(['test', '--suite=full', '--concurrency=2', '--file=a.test.mjs']).files, ['a.test.mjs']);
  assert.equal(parseArguments(['doctor', '--channel=production', '--native-ready']).nativeReady, true);
  for (const args of [[], ['exec'], ['build', '--file=a.test.mjs'], ['test', '--concurrency=0'], ['test', '--concurrency=5'], ['test', '--file=../bad.test.mjs'], ['test', '--file=a.test.mjs;echo x'], ['test', '--file=a.test.mjs', '--file=a.test.mjs'], ['doctor', '--native-ready=yes'], ['test', '--suite=all'], ['build', '--channel=production', '--channel=development']]) assert.throws(() => parseArguments(args));
});
test('native readiness never conflates prerequisite success with OS release verification', () => {
  for (const platform of ['linux', 'darwin', 'win32', 'freebsd']) assert.equal(nativeReadiness(platform, 'arm64').ready, false);
  assert.equal(nativeReadiness('win32').blocker, 'WINDOWS_ACL_UNIMPLEMENTED');
  assert.equal(nativeReadiness('darwin').status, 'unverified');
  assert.equal(nativeReadiness('linux').blocker, 'EXACT_ARTIFACT_NATIVE_QA_REQUIRED');
});
test('child environment excludes secrets/proxies/loader injection and supports Windows aliases', () => {
  const source = {Path: 'C:\\tools 中', SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\A', TEMP: 'C:\\tmp',
    API_KEY: 'SYNTHETIC_SECRET', UnfamiliarCredential: 'SYNTHETIC_SECRET', HTTPS_PROXY: 'SYNTHETIC_PROXY', NODE_OPTIONS: '--require=unsafe', NODE_PATH: 'outside',
    MIOON_FFMPEG_PATH: 'C:\\tools 中\\ffmpeg.exe', MIOON_FFPROBE_PATH: 'C:\\tools 中\\ffprobe.exe'};
  const env = toolingEnvironment(source, {platform: 'win32', mediaPaths: true});
  assert.equal(env.PATH, source.Path); assert.equal(env.SystemRoot, source.SYSTEMROOT); assert.equal(env.USERPROFILE, source.USERPROFILE);
  assert.equal(env.MIOON_ENABLE_LIVE_PROVIDER, '0');
  assert.equal(env.MIOON_FFMPEG_PATH, source.MIOON_FFMPEG_PATH);
  assert.doesNotMatch(JSON.stringify(env), /SYNTHETIC|unsafe|outside/);
  assert.equal(toolingEnvironment(source, {platform: 'win32'}).MIOON_FFMPEG_PATH, undefined);
});
test('installed packages verify exact metadata and fixed regular entrypoints in local node_modules', async t => {
  const {directory} = await fixture(t); const entries = await installedPackages(directory);
  assert.equal(entries.vite.version, '7.3.1'); assert.equal(entries.vite.entry, path.join(directory, 'node_modules/vite/bin/vite.js'));
});
test('installed dependency version mismatch and unexpected Vite entrypoint fail before execution', async t => {
  const {directory, json} = await fixture(t);
  await json('node_modules/vite/package.json', {name: 'vite', version: '9.0.0', bin: {vite: 'bin/vite.js'}});
  await assert.rejects(installedPackages(directory), {code: 'LOCAL_DEPENDENCY_INVALID'});
  await json('node_modules/vite/package.json', {name: 'vite', version: '7.3.1', bin: {vite: '../../outside.js'}});
  await assert.rejects(installedPackages(directory), {code: 'LOCAL_DEPENDENCY_INVALID'});
});
test('missing dependency and declaration ranges fail actionably without install fallback', async t => {
  const {directory, json} = await fixture(t);
  await json('apps/web/package.json', {devDependencies: {vite: '^7.3.1'}});
  await assert.rejects(installedPackages(directory), {code: 'LOCAL_DEPENDENCY_INVALID'});
  await rm(path.join(directory, 'node_modules'), {recursive: true});
  await assert.rejects(installedPackages(directory), {code: 'LOCAL_DEPENDENCY_MISSING'});
});
test('preflight checks SQLite only in memory and separates native and build readiness', async t => {
  const {directory} = await fixture(t); const calls = [];
  const result = await preflight(directory, {platform: 'win32', media: true, packageManagerEnvironment: {}, probe: async (...args) => {calls.push(args); return `${args[0]} version 7.1.5 Copyright`;}});
  assert.equal(result.report.buildReady, true); assert.equal(result.report.prerequisitesReady, true);
  assert.equal(result.report.nativeReadiness.status, 'blocked'); assert.equal(calls.length, 2);
  for (const [name, args, options] of calls) {assert.ok(['ffmpeg', 'ffprobe'].includes(name)); assert.deepEqual(args, ['-version']); assert.equal(options.timeout, 10000); assert.equal(options.maxStdoutBytes, 65536);}
});
test('media probe failure is sanitized and cannot become a build or native success claim', async t => {
  const {directory} = await fixture(t);
  const result = await preflight(directory, {media: true, packageManagerEnvironment: {}, probe: async () => {throw Error('SYNTHETIC_SECRET path');}});
  assert.equal(result.report.buildReady, true); assert.equal(result.report.prerequisitesReady, false);
  assert.doesNotMatch(JSON.stringify(result.report), /SYNTHETIC_SECRET/);
});
test('doctor identifies each media failure and provides safe next steps without hiding the other tool', async t => {
  const {directory} = await fixture(t);
  for (const code of ['MEDIA_SPAWN_FAILED', 'MEDIA_TIMEOUT', 'MEDIA_EXIT_FAILED', 'MEDIA_INVALID_CONFIGURATION', 'MEDIA_OUTPUT_LIMIT',
    'MEDIA_PROCESS_FAILED', 'MEDIA_CANCELLED', 'MEDIA_TERMINATION_UNCONFIRMED', 'SYNTHETIC_SECRET']) {
    const {report} = await preflight(directory, {media: true, packageManagerEnvironment: {}, probe: async name => {
      if (name === 'ffmpeg') throw Object.assign(new Error('SYNTHETIC_SECRET /private/path'), {code});
      return 'ffprobe version 7.1.5 Copyright';
    }});
    const failed = report.checks.find(row => row.name === 'ffmpeg');
    assert.equal(failed.code, code === 'SYNTHETIC_SECRET' ? 'PREREQUISITE_FAILED' : code);
    assert.ok(failed.message); assert.ok(failed.nextStep);
    assert.equal(report.checks.find(row => row.name === 'ffprobe').status, 'passed');
    assert.equal(report.buildReady, true); assert.equal(report.prerequisitesReady, false);
    assert.equal(report.nativeReadiness.ready, false);
    assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET|\/private\/path/);
    if (code === 'MEDIA_SPAWN_FAILED') assert.match(failed.message, /inaccessible or incompatible/);
  }
  const invalid = await preflight(directory, {media: true, packageManagerEnvironment: {}, probe: async () => 'unexpected SYNTHETIC_SECRET'});
  assert.equal(invalid.report.checks.find(row => row.name === 'ffprobe').code, 'MEDIA_VERSION_INVALID');
  assert.doesNotMatch(JSON.stringify(invalid.report), /SYNTHETIC_SECRET/);
});
test('old Node and mismatched application versions fail preflight', async t => {
  const {directory, json} = await fixture(t);
  await json('apps/desktop/package.json', {version: '0.3.0'});
  const result = await preflight(directory, {nodeVersion: '22.1.0'});
  assert.equal(result.report.buildReady, false);
  assert.equal(result.report.checks.find(row => row.name === 'node').status, 'failed');
  assert.equal(result.report.checks.find(row => row.name === 'buildIdentity').status, 'failed');
});
test('portable manifest is explicit, sorted, present and not broadened by filename guesses', async t => {
  const {directory} = await fixture(t);
  assert.deepEqual(await discoverTests(directory, {platform: 'win32'}), [...PORTABLE_TEST_FILES].sort().map(name => `tests/${name}`));
  await assert.rejects(discoverTests(directory, {files: ['z-native.test.mjs']}), {code: 'TEST_SELECTION_INVALID'});
  assert.equal((await discoverTests(directory, {suite: 'full', platform: 'linux'})).at(-1), 'tests/z-native.test.mjs');
  await assert.rejects(discoverTests(directory, {suite: 'full', platform: 'win32'}), {code: 'NATIVE_TEST_LANE_BLOCKED'});
  await assert.rejects(discoverTests(directory, {suite: 'full', platform: 'darwin'}), {code: 'NATIVE_TEST_LANE_BLOCKED'});
});
test('missing portable test fails rather than silently skipping it', async t => {
  const {directory} = await fixture(t); await rm(path.join(directory, 'tests', PORTABLE_TEST_FILES[0]));
  await assert.rejects(discoverTests(directory), {code: 'TEST_SELECTION_INVALID'});
});
test('build and test plans retain spaces, Unicode and Windows executable path as exact argv', () => {
  const executable = 'C:\\Program Files\\Node 中\\node.exe';
  const commands = buildCommands('/repo 中 space', {vite: {entry: 'C:\\repo 中\\node_modules\\vite\\bin\\vite.js'}}, 'production', executable);
  assert.equal(commands[0].command, executable); assert.equal(commands[0].args[1], 'C:\\repo 中\\node_modules\\vite\\bin\\vite.js');
  assert.equal(commands[1].args.at(-1), '--channel=production');
  const testPlan = testCommand('/repo', ['tests/z.test.mjs', 'tests/a.test.mjs'], 2, executable);
  assert.deepEqual(testPlan.args, ['--test', '--test-concurrency=2', 'tests/z.test.mjs', 'tests/a.test.mjs']);
  assert.throws(() => testCommand('/repo', [], 10));
});
test('launcher forwards owned-child signals, latches interruption and removes handlers after close', async () => {
  const signals = new EventEmitter(), child = new EventEmitter(), kills = []; child.kill = signal => kills.push(signal);
  let spec;
  const pending = executeCommand({command: '/node', args: ['entry.js'], cwd: '/repo'}, {env: {PATH: '/tools'}, signalSource: signals,
    spawnChild: (...args) => {spec = args; return child;}});
  signals.emit('SIGINT'); child.emit('close', 0, null);
  assert.deepEqual(await pending, {code: 130, signal: 'SIGINT'}); assert.deepEqual(kills, ['SIGINT']);
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(spec[2].shell, false); assert.equal(spec[2].windowsHide, true); assert.equal(spec[2].stdio, 'inherit');
});
test('launcher preserves nonzero child exit and safely rejects spawn failure', async () => {
  const signals = new EventEmitter(), child = new EventEmitter();
  const pending = executeCommand({command: '/node', args: [], cwd: '/'}, {signalSource: signals, spawnChild: () => child});
  child.emit('close', 7, null); assert.deepEqual(await pending, {code: 7, signal: null});
  await assert.rejects(executeCommand({}, {spawnChild: () => {throw Error('SYNTHETIC_SECRET');}}), error => error.code === 'TOOL_START_FAILED' && !error.message.includes('SYNTHETIC_SECRET'));
});
test('real shell-free Node child handles a spaced Unicode script path and nonzero exit', async t => {
  const {directory} = await fixture(t); const script = path.join(directory, 'child 空格.mjs');
  await writeFile(script, "if (process.argv[2] !== 'one argument ; & 中') process.exit(9); process.exit(3);\n");
  const result = await executeCommand({command: process.execPath, args: [script, 'one argument ; & 中'], cwd: directory});
  assert.deepEqual(result, {code: 3, signal: null});
});
test('tooling preserves compatibility protocol values and does not invoke packaging or network setup', async () => {
  const source = await readFile(path.join(root, 'scripts/tooling.mjs'), 'utf8');
  assert.doesNotMatch(source, /electron-builder|npm install|pnpm install|https?:\/\/|access-token|desktop-config|chmod|chown/);
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).scripts['test:local'], 'node scripts/tooling.mjs test');
});

test('dependency containment is segment-aware for POSIX and Windows drive/case rules', () => {
  assert.equal(isContainedPath('/repo/node_modules', '/repo/node_modules/.pnpm/vite/package.json', path.posix), true);
  assert.equal(isContainedPath('/repo/node_modules', '/repo/node_modules-escape/entry.js', path.posix), false);
  assert.equal(isContainedPath('C:\\Repo\\node_modules', 'c:\\repo\\node_modules\\vite\\bin\\vite.js', path.win32), true);
  assert.equal(isContainedPath('C:\\Repo\\node_modules', 'D:\\Repo\\node_modules\\entry.js', path.win32), false);
  assert.equal(isContainedPath('C:\\Repo\\node_modules', 'C:\\Repo\\elsewhere\\entry.js', path.win32), false);
});

test('real child receives only the explicit environment and live calls remain disabled', async t => {
  const {directory} = await fixture(t); const script = path.join(directory, 'environment.mjs');
  await writeFile(script, "if (process.env.SYNTHETIC_UNFAMILIAR_SECRET || process.env.HTTPS_PROXY || process.env.NODE_OPTIONS || process.env.MIOON_ENABLE_LIVE_PROVIDER !== '0') process.exit(9);\n");
  const result = await executeCommand({command: process.execPath, args: [script], cwd: directory}, {env: toolingEnvironment({SYNTHETIC_UNFAMILIAR_SECRET: 'sentinel', HTTPS_PROXY: 'sentinel', NODE_OPTIONS: '--bad'})});
  assert.equal(result.code, 0);
});

test('launcher preserves spontaneous signal termination and cleans up asynchronous spawn failures', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const source = new EventEmitter(), child = new EventEmitter(); const kills = []; child.kill = value => kills.push(value);
    const pending = executeCommand({command: '/node', args: [], cwd: '/'}, {signalSource: source, spawnChild: () => child});
    if (signal === 'SIGTERM') source.emit(signal);
    child.emit('close', null, signal);
    assert.deepEqual(await pending, {code: signal === 'SIGTERM' ? 143 : 130, signal});
    assert.deepEqual(kills, signal === 'SIGTERM' ? ['SIGTERM'] : []);
    assert.equal(source.listenerCount('SIGTERM'), 0);
  }
  const source = new EventEmitter(), child = new EventEmitter();
  const pending = executeCommand({command: '/missing', args: [], cwd: '/'}, {signalSource: source, spawnChild: () => child});
  child.emit('error', Error('synthetic spawn error'));
  await assert.rejects(pending, {code: 'TOOL_START_FAILED'});
  assert.equal(source.listenerCount('SIGINT'), 0); assert.equal(source.listenerCount('SIGTERM'), 0);
  child.emit('close', -2, null);
});
test('dependency pins share strict SemVer validation with application build metadata', async t => {
  const {directory, json} = await fixture(t);
  for (const version of ['07.3.1', '7.3.1-rc..1', '^7.3.1']) {
    await json('apps/web/package.json', {devDependencies: {vite: version}});
    await assert.rejects(installedPackages(directory), {code: 'LOCAL_DEPENDENCY_INVALID'});
  }
  await json('apps/web/package.json', {devDependencies: {vite: '7.3.1+fixture'}});
  await json('node_modules/vite/package.json', {name: 'vite', version: '7.3.1+fixture', bin: {vite: 'bin/vite.js'}});
  assert.equal((await installedPackages(directory)).vite.version, '7.3.1+fixture');
});
