import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {cleanEnvironment} from '../.github/scripts/media-environment.ts';
import {WINDOWS_SMOKE_TIMEOUT_MS, launchWindowsPackage, parseWindowsSmokeArguments, runWindowsDevelopmentSmoke,
  readWindowsPackageMetadata, smokeFailureCode, terminateOwnedWindowsTree, validateWindowsDevelopmentPackage,
  validateWindowsLaunchReport, windowsDevelopmentPackageExpectation, windowsSmokeEnvironment} from '../.github/scripts/windows-desktop-smoke.ts';

const binary = 'C:\\package\\win-unpacked\\mioon-dev.exe', workspace = 'C:\\smoke\\attempt', output = 'C:\\evidence\\smoke.json';
const args = [`--binary=${binary}`, `--output=${output}`, `--workspace=${workspace}`];
const expected = {appVersion: '0.2.0', electron: '44.7.0', license: 'Apache-2.0', description: 'Synthetic development package'};
const archive = 'C:\\package\\win-unpacked\\resources\\app.asar';
function metadata() {
  return {name: 'mioon-desktop', version: '0.2.0', private: true, license: expected.license, desktopName: 'app.starroy.mioon.dev.desktop',
    description: expected.description, author: 'Mioon', main: 'main.cjs', dependencies: {},
    mioonDesktop: {channel: 'development', appId: 'app.starroy.mioon.dev', productName: 'Mioon Dev', executableName: 'mioon-dev'}};
}
const names = ['packaged-development-identity', 'bundled-utility-node-sqlite', 'renderer-sandbox-and-origin', 'secure-memory-cookie',
  'loopback-rpc-and-anonymous-denial', 'renderer-network-window-permission-fences', 'private-discovery-acl',
  'configured-windows-media-tools', 'dpapi-app-scoped-roundtrip', 'packaged-example-resources', 'launcher-ui-ready'];
function report() {
  const checks: Array<{name: string; status: string; code?: string}> = [...names.map(name => ({name, status: 'passed'})),
    {name: 'native-project-location', status: 'blocked', code: 'PROJECT_LOCATION_INVALID'},
    {name: 'native-project-core-flows', status: 'blocked', code: 'WINDOWS_PROJECT_LOCATION_UNAVAILABLE'},
    {name: 'live-mio-and-generation', status: 'blocked', code: 'LIVE_CREDENTIALS_NOT_CONFIGURED'}];
  return {schemaVersion: 1, scope: 'windows-development-launch', ok: true, channel: 'development', platform: 'win32', arch: 'x64',
    isPackaged: true, appVersion: '0.2.0', runtime: {node: '24.21.0', electron: '44.7.0'},
    checks};
}
type Services = NonNullable<Parameters<typeof runWindowsDevelopmentSmoke>[1]>;
function fixture() {
  const files = new Map<string, {file: boolean; directory: boolean; link: boolean; size: number; canonical: string; text?: string}>();
  const calls: Array<{binary: string; environment: NodeJS.ProcessEnv; workspace: string}> = [];
  const reads: string[] = [], created: Array<{directory: string; recursive: boolean}> = [];
  const writes: Array<{file: string; value: unknown}> = [];
  const file = (name: string, text = '') => files.set(name, {file: true, directory: false, link: false, size: Buffer.byteLength(text), canonical: name, text});
  file(binary); file(archive, 'Synthetic archive'); file('C:\\tools\\ffmpeg.exe'); file('C:\\tools\\ffprobe.exe');
  const environment = {SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', TEMP: 'C:\\Temp',
    MIOON_FFMPEG_PATH: 'C:\\tools\\ffmpeg.exe', MIOON_FFPROBE_PATH: 'C:\\tools\\ffprobe.exe',
    NODE_OPTIONS: '--require=synthetic-injection', ELECTRON_RUN_AS_NODE: '1', ARK_API_KEY: 'synthetic-provider-secret'};
  const services: Services = {
    platform: 'win32', arch: 'x64', environment,
    async inspect(name) {const info = files.get(name); if (!info) throw Object.assign(new Error('Synthetic absent file'), {code: 'ENOENT'}); return info;},
    async mkdir(directory, recursive) {
      created.push({directory, recursive});
      if (files.has(directory)) {
        if (!recursive || !files.get(directory)!.directory) throw Object.assign(new Error('Synthetic existing workspace'), {code: 'EEXIST'});
        return;
      }
      files.set(directory, {file: false, directory: true, link: false, size: 0, canonical: directory});
    },
    async read(name) {reads.push(name); return files.get(name)?.text ?? '';},
    async write(name, value) {if (files.has(name)) throw Error('Synthetic existing evidence'); writes.push({file: name, value}); file(name, JSON.stringify(value));},
    async expected() {return expected;},
    async packagedMetadata(fileName) {assert.equal(fileName, archive); return metadata();},
    async launch(fileName, env, work) {calls.push({binary: fileName, environment: env, workspace: work}); file(path.win32.join(work, 'result.json'), JSON.stringify(report()));},
  };
  return {services, files, calls, reads, created, writes, file};
}

test('Windows CLI arguments accept only an absolute delivered x64 executable, evidence, and isolated workspace', () => {
  assert.deepEqual(parseWindowsSmokeArguments(args), {binary, output, workspace});
  for (const invalid of [[], [...args, '--output=C:\\other.json'], [...args, '--remote-debugging-port=9222'],
    args.map(value => value.startsWith('--binary=') ? '--binary=relative.exe' : value),
    args.map(value => value.startsWith('--binary=') ? '--binary=C:\\package\\mioon.exe' : value),
    args.map(value => value.startsWith('--binary=') ? '--binary=\\\\server\\share\\win-unpacked\\mioon-dev.exe' : value),
    args.map(value => value.startsWith('--workspace=') ? '--workspace=C:relative' : value),
    args.map(value => value.startsWith('--output=') ? `--output=${workspace}\\result.json` : value),
    args.map(value => value.startsWith('--output=') ? '--output=C:\\evidence\\smoke.json\nmalformed' : value),
  ]) assert.throws(() => parseWindowsSmokeArguments(invalid), error => smokeFailureCode(error) === 'WINDOWS_SMOKE_INVALID_ARGUMENTS');
});

test('the app environment preserves Windows prerequisites but excludes provider, Node, Electron and caller smoke injection', () => {
  const result = windowsSmokeEnvironment({Path: 'SyntheticPath', SYSTEMROOT: 'C:\\Windows', LOCALAPPDATA: 'C:\\Local', APPDATA: 'C:\\Roaming',
    USERPROFILE: 'C:\\SyntheticProfile', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', node_options: 'synthetic', ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: 'synthetic', ARK_API_KEY: 'synthetic', OPENAI_API_KEY: 'synthetic', HTTPS_PROXY: 'synthetic',
    MIOON_ENABLE_LIVE_PROVIDER: '1', MIOON_DESKTOP_USER_DATA: 'C:\\untrusted', MIOON_DESKTOP_SMOKE_OUTPUT: 'C:\\untrusted.json'},
  workspace, 'C:\\tools\\ffmpeg.exe', 'C:\\tools\\ffprobe.exe');
  assert.equal(result.PATH, 'SyntheticPath'); assert.equal(result.SystemRoot, 'C:\\Windows');
  for (const key of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'TEMP', 'TMP']) assert.ok(result[key]);
  for (const key of ['node_options', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ARK_API_KEY', 'OPENAI_API_KEY', 'HTTPS_PROXY', 'MIOON_ENABLE_LIVE_PROVIDER']) assert.equal(result[key], undefined);
  assert.equal(result.MIOON_DESKTOP_WINDOWS_SMOKE, '1');
  assert.equal(result.MIOON_DESKTOP_USER_DATA, `${workspace}\\user-data`);
  assert.equal(result.MIOON_DESKTOP_SMOKE_OUTPUT, `${workspace}\\result.json`);
});

test('package expectation comes from the staged desktop manifest and the root version/electron pins', () => {
  const root = {version: '0.2.0', license: 'MIT', description: 'Synthetic root description', devDependencies: {electron: '44.7.0'}};
  const desktop = {version: '0.2.0', license: 'Apache-2.0', description: 'Mioon secure Electron desktop host'};
  assert.deepEqual(windowsDevelopmentPackageExpectation(root, desktop),
    {appVersion: '0.2.0', electron: '44.7.0', license: 'Apache-2.0', description: 'Mioon secure Electron desktop host'});
  for (const [invalidRoot, invalidDesktop] of [
    [null, desktop], [{version: '0.2.0', devDependencies: {}}, desktop], [{devDependencies: {electron: '44.7.0'}}, desktop],
    [root, null], [root, {license: 1, description: 'Synthetic'}], [root, {license: 'Apache-2.0', description: 7}],
  ] as Array<[unknown, unknown]>) {
    assert.throws(() => windowsDevelopmentPackageExpectation(invalidRoot, invalidDesktop), error => smokeFailureCode(error) === 'WINDOWS_SMOKE_PACKAGE_IDENTITY_INVALID');
  }
});

test('embedded ASAR identity is bounded and refuses production, unknown identities, raw fields and external metadata before launch', async () => {
  validateWindowsDevelopmentPackage(metadata(), expected);
  const bytes = Buffer.from(JSON.stringify(metadata()));
  const read: NonNullable<Parameters<typeof readWindowsPackageMetadata>[1]> = {
    statFile(fileName, entry, follow) {assert.equal(fileName, archive); assert.equal(entry, 'package.json'); assert.equal(follow, false); return {size: bytes.length};},
    extractFile() {return bytes;},
  };
  assert.deepEqual(readWindowsPackageMetadata(archive, read), metadata());
  for (const info of [{size: 0}, {size: 32769}, {size: bytes.length, unpacked: true}, {size: bytes.length, link: 'external'}, {size: bytes.length, files: {}}]) {
    assert.throws(() => readWindowsPackageMetadata(archive, {...read, statFile: () => info}), error => smokeFailureCode(error) === 'WINDOWS_SMOKE_PACKAGE_IDENTITY_INVALID');
  }
  const invalid: unknown[] = [
    {...metadata(), mioonDesktop: {...metadata().mioonDesktop, channel: 'production', appId: 'app.starroy.mioon'}},
    {...metadata(), mioonDesktop: {...metadata().mioonDesktop, channel: 'unknown'}},
    {...metadata(), mioonDesktop: {...metadata().mioonDesktop, productName: 'Mioon'}},
    {...metadata(), version: '0.2.1'}, {...metadata(), secret: 'synthetic-private'},
    {...metadata(), mioonDesktop: {...metadata().mioonDesktop, path: 'C:\\private'}},
    {...metadata(), dependencies: {untrusted: '1.0.0'}}, undefined,
  ];
  for (const value of invalid) {
    const f = fixture(); f.services.packagedMetadata = async () => value;
    const result = await runWindowsDevelopmentSmoke(args, f.services);
    assert.equal(result.ok, false); assert.equal(f.calls.length, 0); assert.equal(f.created.some(item => item.directory === workspace), false);
    assert.equal(/synthetic-private|C:\\\\private/.test(JSON.stringify(f.writes)), false);
  }
  const absent = fixture(); absent.files.delete(archive);
  const result = await runWindowsDevelopmentSmoke(args, absent.services);
  assert.equal(result.ok, false); assert.equal(absent.calls.length, 0);
});

test('report validation requires all eleven hard checks and preserves known blocked work as blocked', () => {
  const value = report(), validated = validateWindowsLaunchReport(value, expected);
  assert.deepEqual(validated, value); assert.notEqual(validated, value); assert.notEqual(validated.runtime, value.runtime);
  assert.equal(validated.checks.filter(check => check.status === 'passed').length, 11);
  assert.deepEqual(validated.checks.filter(check => check.status === 'blocked').map(check => check.code),
    ['PROJECT_LOCATION_INVALID', 'WINDOWS_PROJECT_LOCATION_UNAVAILABLE', 'LIVE_CREDENTIALS_NOT_CONFIGURED']);
  const probePassed = report();
  probePassed.checks[11] = {name: 'native-project-location', status: 'passed'};
  probePassed.checks[12].code = 'WINDOWS_PROJECT_CORE_FLOWS_NOT_VERIFIED';
  assert.equal(validateWindowsLaunchReport(probePassed, expected).checks[11].status, 'passed');
});

test('foreign identity, partial or duplicate checks, secrets, unknown fields, arbitrary codes and forged passing blockers are rejected', () => {
  const mutate: Array<(value: ReturnType<typeof report>) => unknown> = [
    value => ({...value, schemaVersion: 2}), value => ({...value, channel: 'production'}), value => ({...value, platform: 'darwin'}),
    value => ({...value, arch: 'arm64'}), value => ({...value, isPackaged: false}), value => ({...value, appVersion: '0.2.1'}),
    value => ({...value, runtime: {...value.runtime, electron: '44.7.1'}}), value => ({...value, runtime: {...value.runtime, node: '23.0.0'}}),
    value => ({...value, runtime: {...value.runtime, node: 'C:\\private\\runtime'}}), value => ({...value, token: 'synthetic-private-token'}),
    value => ({...value, runtime: {...value.runtime, pid: 42}}), value => ({...value, checks: value.checks.slice(1)}),
    value => ({...value, checks: value.checks.slice(0, 11)}),
    value => ({...value, checks: [...value.checks.slice(0, -1), value.checks[0]]}),
    value => ({...value, checks: [{...value.checks[0], path: 'C:\\private'}, ...value.checks.slice(1)]}),
    value => ({...value, checks: value.checks.map((check, index) => index === 0 ? {...check, status: 'blocked', code: 'PROJECT_LOCATION_INVALID'} : check)}),
    value => ({...value, checks: value.checks.map((check, index) => index === 11 ? {...check, code: 'SYNTHETIC_PRIVATE_VALUE'} : check)}),
    value => ({...value, checks: value.checks.map((check, index) => index === 13 ? {name: check.name, status: 'passed'} : check)}),
    value => ({...value, checks: value.checks.map((check, index) => index === 13 ? {...check, name: 'unknown-check'} : check)}),
  ];
  for (const change of mutate) assert.throws(() => validateWindowsLaunchReport(change(report()), expected), error => smokeFailureCode(error) === 'WINDOWS_SMOKE_REPORT_INVALID');
});

test('injected Windows launch flow creates only a fresh workspace, leaves user-data to native ACL creation, and writes trusted evidence', async () => {
  const f = fixture(), result = await runWindowsDevelopmentSmoke(args, f.services);
  assert.equal(result.ok, true); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls.map(call => ({binary: call.binary, workspace: call.workspace})), [{binary, workspace}]);
  assert.ok(f.created.some(call => call.directory === workspace && !call.recursive));
  assert.equal(f.created.some(call => call.directory === `${workspace}\\user-data`), false);
  assert.deepEqual(f.reads, [`${workspace}\\result.json`]);
  assert.deepEqual(f.writes, [{file: output, value: report()}]);
  assert.equal(f.calls[0].environment.NODE_OPTIONS, undefined);
  assert.equal(JSON.stringify(f.writes[0].value).includes('synthetic-provider-secret'), false);
});

test('wrong host, reused workspace, relative or missing tools, and binary symlinks fail before app dispatch', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const f = fixture(); f.services.platform = platform;
    assert.deepEqual(await runWindowsDevelopmentSmoke(args, f.services), {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_REQUIRES_WIN32_X64'});
    assert.equal(f.created.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
  }
  const variants: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => {f.services.arch = 'arm64';}, f => {f.file(workspace);},
    f => {f.services.environment.MIOON_FFMPEG_PATH = 'ffmpeg.exe';}, f => {delete f.services.environment.MIOON_FFPROBE_PATH;},
    f => {f.files.get(binary)!.link = true;}, f => {f.files.delete('C:\\tools\\ffprobe.exe');},
  ];
  for (const change of variants) {const f = fixture(); change(f); const result = await runWindowsDevelopmentSmoke(args, f.services); assert.equal(result.ok, false); assert.equal(f.calls.length, 0);}
});

test('missing, changed, oversized or invalid reports and launch errors produce fixed failure evidence without local details', async () => {
  const scenarios: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => {f.services.launch = async () => {};},
    f => {f.services.launch = async () => {f.file(`${workspace}\\result.json`, 'malformed synthetic private text');};},
    f => {f.services.launch = async () => {f.file(`${workspace}\\result.json`, ' '.repeat(32769));};},
    f => {f.services.launch = async () => {f.file(`${workspace}\\result.json`, JSON.stringify({...report(), secret: 'synthetic-private'}));};},
    f => {f.services.launch = async () => {f.file(`${workspace}\\result.json`, JSON.stringify(report())); f.files.get(`${workspace}\\result.json`)!.link = true;};},
    f => {f.services.launch = async () => {throw new Error('C:\\private\\synthetic-credential');};},
  ];
  for (const change of scenarios) {
    const f = fixture(); change(f); const result = await runWindowsDevelopmentSmoke(args, f.services);
    assert.equal(result.ok, false); assert.equal(f.writes.length, 1);
    assert.equal(/private|credential|malformed/i.test(JSON.stringify(f.writes)), false);
    assert.deepEqual(Object.keys(f.writes[0].value as object).sort(), ['code', 'ok', 'schemaVersion', 'scope']);
  }
});

test('a valid report cannot pass before zero exit, and an existing evidence file is never replaced', async () => {
  const f = fixture(), launched = childFixture();
  f.services.launch = async (file, env, work) => {f.file(`${workspace}\\result.json`, JSON.stringify(report())); await launchWindowsPackage(file, env, work, launched.transport);};
  const pending = runWindowsDevelopmentSmoke(args, f.services);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launched.invocations.length, 1); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
  launched.emitter.emit('exit', 1, null); launched.emitter.emit('close', 1, null);
  const failed = await pending;
  assert.equal(failed.ok, false);
  assert.deepEqual(f.writes[0].value, {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_APP_EXIT_FAILED'});
  assert.deepEqual(f.reads, []);
  const reused = fixture(); reused.file(output, 'Synthetic retained evidence');
  assert.deepEqual(await runWindowsDevelopmentSmoke(args, reused.services), {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_OUTPUT_FAILED'});
  assert.equal(reused.files.get(output)!.text, 'Synthetic retained evidence'); assert.equal(reused.writes.length, 0);
});

function childFixture() {
  const emitter = new EventEmitter(), killed: string[] = [], terminated: number[] = [];
  const child = Object.assign(emitter, {pid: 42, exitCode: null, signalCode: null, kill(signal: string) {killed.push(signal); return true;}, unref() {}}) as unknown as ChildProcess;
  const invocations: Array<{file: string; args: readonly string[]; options: unknown}> = [];
  let deadline: (() => void) | undefined, cancelled = 0;
  const transport: NonNullable<Parameters<typeof launchWindowsPackage>[3]> = {
    spawn(file, commandArgs, options) {invocations.push({file, args: commandArgs, options}); return child;},
    schedule(callback, milliseconds) {assert.equal(milliseconds, 180000); deadline = callback; return {} as ReturnType<typeof setTimeout>;},
    cancel() {cancelled++;}, async terminate(pid) {terminated.push(pid);},
  };
  return {child, emitter, killed, terminated, invocations, transport, expire() {deadline!();}, cancelled: () => cancelled};
}

test('packaged launch uses no shell, debug flags or sandbox bypass and requires actual zero exit', async () => {
  const f = childFixture(), environment = {SystemRoot: 'C:\\Windows'};
  const pending = launchWindowsPackage(binary, environment, workspace, f.transport);
  assert.equal(WINDOWS_SMOKE_TIMEOUT_MS, 180000);
  assert.deepEqual(f.invocations, [{file: binary, args: [], options: {env: environment, cwd: workspace, shell: false, windowsHide: false, stdio: 'ignore'}}]);
  f.emitter.emit('exit', 0, null); f.emitter.emit('close', 0, null); await pending;
  assert.equal(f.cancelled(), 1); assert.deepEqual(f.terminated, []);
  const rejected = childFixture(), failure = launchWindowsPackage(binary, environment, workspace, rejected.transport);
  rejected.emitter.emit('exit', 1, null); rejected.emitter.emit('close', 1, null);
  await assert.rejects(failure, error => smokeFailureCode(error) === 'WINDOWS_SMOKE_APP_EXIT_FAILED');
});

test('the Windows termination command targets only a validated owned PID through System32 and never an image name', async () => {
  const calls: unknown[] = [], environment = {SystemRoot: 'C:\\Windows'};
  const execute: NonNullable<Parameters<typeof terminateOwnedWindowsTree>[2]> = async (file, commandArgs, options) => {calls.push({file, args: commandArgs, options});};
  await terminateOwnedWindowsTree(42, environment, execute);
  assert.deepEqual(calls, [{file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '42', '/T', '/F'],
    options: {env: environment, windowsHide: true, timeout: 10000, shell: false}}]);
  for (const pid of [0, 1, -42, Number.NaN, Number.POSITIVE_INFINITY]) await assert.rejects(terminateOwnedWindowsTree(pid, environment, execute), error => smokeFailureCode(error) === 'WINDOWS_SMOKE_APP_STOP_UNCONFIRMED');
  await assert.rejects(terminateOwnedWindowsTree(42, {SystemRoot: 'relative'}, execute), error => smokeFailureCode(error) === 'WINDOWS_SMOKE_APP_STOP_UNCONFIRMED');
  assert.equal(calls.length, 1);
});

test('timeout termination authority is only this live child PID and an exited child is never signalled', async () => {
  const f = childFixture(), pending = launchWindowsPackage(binary, {SystemRoot: 'C:\\Windows'}, workspace, f.transport);
  f.expire(); await assert.rejects(pending, error => smokeFailureCode(error) === 'WINDOWS_SMOKE_APP_TIMEOUT');
  assert.deepEqual(f.terminated, [42]); assert.deepEqual(f.killed, []);
  const exited = childFixture(), completed = launchWindowsPackage(binary, {}, workspace, exited.transport);
  exited.emitter.emit('exit', 0, null); exited.expire(); exited.emitter.emit('close', 0, null); await completed;
  assert.deepEqual(exited.terminated, []);
  const unavailable = childFixture(); unavailable.transport.terminate = async () => {throw Error('synthetic raw error');};
  const stopped = launchWindowsPackage(binary, {}, workspace, unavailable.transport); unavailable.expire();
  await assert.rejects(stopped, error => smokeFailureCode(error) === 'WINDOWS_SMOKE_APP_STOP_UNCONFIRMED');
  assert.deepEqual(unavailable.killed, ['SIGKILL']);
});

test('the actual CLI emits only its fixed failure code for unsupported host or malformed arguments', () => {
  const script = fileURLToPath(new URL('../.github/scripts/windows-desktop-smoke.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--unexpected'], {env: cleanEnvironment(), encoding: 'utf8', shell: false, timeout: 10000});
  assert.equal(result.status, 1); assert.equal(result.error, undefined);
  assert.equal(result.stdout.length, 0);
  const expectedCode = process.platform === 'win32' && process.arch === 'x64' ? 'WINDOWS_SMOKE_INVALID_ARGUMENTS' : 'WINDOWS_SMOKE_REQUIRES_WIN32_X64';
  assert.equal(result.stderr.trim() === expectedCode, true, 'CLI must not print raw error details or local paths');
});
