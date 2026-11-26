import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {AppleStaplerFailure, notarizeApp, notarizeCliLauncher, runAppleStapler, verifyCliLauncherNotarization} from '../.github/scripts/apple-notarization.ts';
import type {AppleAppNotarizationReport, AppleCliLauncherNotarizationReport, AppleStaplerCommandResult, AppleStaplerDiagnostic, AppleStaplerExecutor, NotarizeAppDependencies} from '../.github/scripts/apple-notarization.ts';
import {CheckFailure, safeFailure} from '../.github/scripts/media-environment.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'release', 'desktop', 'production', 'mac', 'mioon.app');
const dmg = path.join(root, 'release', 'desktop', 'production', 'mioon-0.1.0-mac-x64.dmg');
const PRIVATE = 'SYNTHETIC_NOTARIZATION_SECRET_MUST_NOT_ESCAPE';
const network = `Domain is api.apple-cloudkit.com\nError Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." ${PRIVATE}`;
const result = (exitCode = 0, stderr = ''): AppleStaplerCommandResult => ({exitCode, signal: null, timedOut: false, stdout: '', stderr});
function executor(sequence: readonly AppleStaplerCommandResult[]) {
  const calls: Array<{file: string; args: readonly string[]; timeout: number}> = [];
  const execute: AppleStaplerExecutor = async (file, args, options) => {
    calls.push({file, args: [...args], timeout: options.timeout});
    const next = sequence[calls.length - 1]; assert.ok(next, 'must not execute more commands than the fixture allows'); return next;
  };
  return {execute, calls};
}
const waitRecorder = () => {const waits: number[] = []; return {waits, wait: async (milliseconds: number) => {waits.push(milliseconds);}};};
const syntheticEnv = (): NodeJS.ProcessEnv => ({MIOON_RELEASE_SHA: 'a'.repeat(40), MIOON_TARGET: 'macos-universal',
  MIOON_APPLE_NOTARIZATION_REPORT: path.join(root, 'artifacts', 'desktop-macos-universal', 'app-notarization.json'),
  APPLE_API_KEY_PATH: `/synthetic/${PRIVATE}.p8`, APPLE_API_KEY_ID: PRIVATE, APPLE_API_ISSUER: PRIVATE});
const context = () => ({electronPlatformName: 'darwin', arch: 4, appOutDir: path.dirname(app), packager: {appInfo: {productFilename: 'mioon'}}});
function appDependencies(sequence: readonly AppleStaplerCommandResult[], notarize: NonNullable<NotarizeAppDependencies['notarize']>) {
  const execution = executor(sequence), waiting = waitRecorder(), reports: AppleAppNotarizationReport[] = [];
  const dependencies: NotarizeAppDependencies = {env: syntheticEnv(), platform: 'darwin', notarize, execute: execution.execute, wait: waiting.wait,
    writeReport: async value => {reports.push(structuredClone(value));}};
  return {...execution, ...waiting, reports, dependencies};
}
function safeDiagnostics(value: unknown): void {
  const serialized = JSON.stringify(value); assert.equal(serialized.includes(PRIVATE), false); assert.equal(serialized.includes('api.apple-cloudkit.com'), false);
  assert.equal(serialized.includes('stdout'), false); assert.equal(serialized.includes('stderr'), false);
}

test('stapling retries only explicit transient ticket-service failures, with a five-attempt bound and safe diagnostics', async () => {
  const f = executor([result(68, network), result(68, network), result(68, network), result(68, network), result()]), w = waitRecorder(), diagnostics: AppleStaplerDiagnostic[] = [];
  const passed = await runAppleStapler('staple', dmg, {execute: f.execute, wait: w.wait, onDiagnostic: value => diagnostics.push(value)});
  assert.deepEqual(w.waits, [30000, 60000, 120000, 240000]); assert.equal(f.calls.length, 5);
  assert.deepEqual(diagnostics.map(value => [value.attempt, value.category, value.willRetry]), [[1, 'transient_network', true], [2, 'transient_network', true], [3, 'transient_network', true], [4, 'transient_network', true], [5, 'success', false]]);
  assert.deepEqual(diagnostics.map(value => value.nsUrlErrorCode), [-1005, -1005, -1005, -1005, undefined]);
  assert.equal(Object.hasOwn(diagnostics[4]!, 'nsUrlErrorCode'), false);
  assert.deepEqual(passed, diagnostics); safeDiagnostics(diagnostics);
  for (const call of f.calls) {assert.equal(call.file, 'xcrun'); assert.deepEqual(call.args, ['stapler', 'staple', '-v', dmg]); assert.equal(call.timeout, 60000);}
  assert.equal(f.calls.reduce((sum, call) => sum + call.timeout, 0) + w.waits.reduce((sum, wait) => sum + wait, 0), 750000);
});

test('exhausted transient failures keep the release gate failed and do not execute a sixth attempt', async () => {
  const f = executor([result(68, network), result(68, network), result(68, network), result(68, network), result(68, network)]), w = waitRecorder();
  await assert.rejects(runAppleStapler('validate', dmg, {execute: f.execute, wait: w.wait, failureCode: 'DMG_STAPLE_INVALID'}), error => {
    assert.ok(error instanceof AppleStaplerFailure && error instanceof CheckFailure); assert.equal(error.code, 'DMG_STAPLE_INVALID');
    assert.equal(error.diagnostics.length, 5); assert.equal(error.diagnostics[4]!.willRetry, false);
    assert.ok(error.diagnostics.every(value => value.nsUrlErrorCode === -1005)); safeDiagnostics(error); return true;
  });
  assert.equal(f.calls.length, 5); assert.deepEqual(w.waits, [30000, 60000, 120000, 240000]);
  assert.ok(f.calls.every(call => call.timeout === 60000));
});

test('only the five classified NSURL codes are recorded from stdout or stderr without raw ticket or path text', async () => {
  const codes = [-1001, -1003, -1004, -1005, -1009] as const;
  for (const code of codes) {
    for (const stream of ['stdout', 'stderr'] as const) {
      const raw = `CloudKit Error Domain=NSURLErrorDomain Code=${code} ${PRIVATE} /synthetic/private.p8 ticket-body=secret`;
      const failed = {...result(68), [stream]: raw}, f = executor([failed, result()]), w = waitRecorder();
      const diagnostics = await runAppleStapler('staple', dmg, {execute: f.execute, wait: w.wait});
      assert.equal(diagnostics[0]!.nsUrlErrorCode, code); assert.equal(diagnostics[0]!.category, 'transient_network');
      assert.equal(Object.hasOwn(diagnostics[1]!, 'nsUrlErrorCode'), false);
      assert.deepEqual(w.waits, [30000]); safeDiagnostics(diagnostics);
      assert.equal(JSON.stringify(diagnostics).includes('/synthetic/private.p8'), false);
      assert.equal(JSON.stringify(diagnostics).includes('ticket-body'), false);
    }
  }
  const f = executor([{...result(), stdout: network}]), w = waitRecorder();
  const successful = await runAppleStapler('validate', dmg, {execute: f.execute, wait: w.wait});
  assert.equal(Object.hasOwn(successful[0]!, 'nsUrlErrorCode'), false); assert.deepEqual(w.waits, []);
});

test('invalid tickets, unclassified exit 68, timeouts, signals and output limits are never hidden by retry', async () => {
  const cases: Array<{value: AppleStaplerCommandResult; category: AppleStaplerDiagnostic['category']}> = [
    {value: result(65, `Could not validate ticket: invalid ${PRIVATE}`), category: 'invalid_ticket'},
    {value: result(68, `unexpected CloudKit failure ${PRIVATE}`), category: 'command_failed'},
    {value: result(68, `Error Domain=NSURLErrorDomain Code=-1005 ${PRIVATE}`), category: 'command_failed'},
    {value: result(68, `CloudKit Error Domain=NSURLErrorDomain Code=-1200 ${PRIVATE}`), category: 'command_failed'},
    {value: result(68, `CloudKit Error Domain=NSURLErrorDomain Code=-1002 ${PRIVATE}`), category: 'command_failed'},
    {value: result(68, `CloudKit Error Domain=NSURLErrorDomain Code=-1006 ${PRIVATE}`), category: 'command_failed'},
    {value: result(68, `CloudKit Error Domain=NSURLErrorDomain Code=-10050 ${PRIVATE}`), category: 'command_failed'},
    {value: result(68, `CloudKit Error Domain=NSURLErrorDomain Code=-1005suffix ${PRIVATE}`), category: 'command_failed'},
    {value: result(1, network), category: 'command_failed'},
    {value: {...result(68, network), timedOut: true}, category: 'timeout'},
    {value: {...result(68, network), signal: 'SIGTERM'}, category: 'signal'},
    {value: {...result(68, network), outputLimitExceeded: true}, category: 'output_limit'},
    {value: result(68, `${network}\nCould not validate ticket`), category: 'invalid_ticket'},
  ];
  for (const scenario of cases) {
    const f = executor([scenario.value]), w = waitRecorder();
    await assert.rejects(runAppleStapler('validate', app, {execute: f.execute, wait: w.wait, failureCode: 'APP_STAPLE_INVALID'}), error => {
      assert.ok(error instanceof AppleStaplerFailure); assert.equal(error.code, 'APP_STAPLE_INVALID'); assert.equal(error.diagnostics[0]!.category, scenario.category);
      assert.equal(Object.hasOwn(error.diagnostics[0]!, 'nsUrlErrorCode'), false); safeDiagnostics(error); return true;
    });
    assert.equal(f.calls.length, 1); assert.deepEqual(w.waits, []);
  }
});

test('validate recovery repeats validation only and preserves exact safe exit details', async () => {
  const f = executor([result(68, network), result()]), w = waitRecorder();
  const diagnostics = await runAppleStapler('validate', dmg, {execute: f.execute, wait: w.wait});
  assert.ok(f.calls.every(call => call.args[1] === 'validate')); assert.equal(diagnostics[0]!.exitCode, 68);
  assert.equal(diagnostics[0]!.signal, null); assert.equal(diagnostics[0]!.timedOut, false); assert.equal(diagnostics[1]!.ok, true);
  assert.deepEqual(w.waits, [30000]);
});

test('unexpected executor failures and unsafe arguments cannot expose raw messages or invoke another command', async () => {
  let calls = 0;
  const execute: AppleStaplerExecutor = async () => {calls++; throw new Error(PRIVATE);};
  await assert.rejects(runAppleStapler('validate', app, {execute}), error => {
    assert.ok(error instanceof AppleStaplerFailure); assert.equal(error.diagnostics[0]!.category, 'command_failed'); safeDiagnostics(error); return true;
  });
  assert.equal(calls, 1);
  for (const artifact of ['relative.app', `${app}/../another.app`, `${app}\n`, app.replace('.app', '.zip')]) {
    await assert.rejects(runAppleStapler('validate', artifact, {execute}), {code: 'INVALID_APPLE_ARTIFACT'});
  }
  assert.equal(calls, 1);
});

test('successful notarization submits once, confirms the library staple and separately validates without leaking credentials', async () => {
  let notarizeCalls = 0;
  const f = appDependencies([result()], async options => {
    notarizeCalls++; assert.equal(options.appPath, app); assert.equal(options.appleApiKey, syntheticEnv().APPLE_API_KEY_PATH);
    assert.equal(options.appleApiKeyId, PRIVATE); assert.equal(options.appleApiIssuer, PRIVATE);
  });
  await notarizeApp(context(), f.dependencies);
  assert.equal(notarizeCalls, 1); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.args[1], 'validate');
  assert.deepEqual(f.waits, []);
  assert.deepEqual(f.reports.map(value => [value.ok, value.acceptedKnown, value.notarizeCalls, value.phase]), [[true, true, 1, 'complete']]);
  assert.deepEqual(f.reports[0]!.diagnostics.map(value => [value.operation, value.attempt]), [['staple', 1], ['validate', 1]]); safeDiagnostics(f.reports);
});

test('only a trusted post-Accepted network staple failure is recovered without a second notarization submission', async () => {
  let notarizeCalls = 0;
  const f = appDependencies([result(), result()], async () => {notarizeCalls++; throw new Error(`Failed to staple your application with code: 68\n\n${network}`);});
  await notarizeApp(context(), f.dependencies);
  assert.equal(notarizeCalls, 1); assert.deepEqual(f.calls.map(call => call.args[1]), ['staple', 'validate']); assert.deepEqual(f.waits, [30000]);
  assert.deepEqual(f.reports[0]!.diagnostics.map(value => [value.operation, value.attempt]), [['staple', 1], ['staple', 2], ['validate', 1]]);
  assert.equal(f.reports[0]!.acceptedKnown, true); assert.equal(f.reports[0]!.ok, true); safeDiagnostics(f.reports);
});

test('the library first failure counts toward the maximum five staple attempts', async () => {
  let notarizeCalls = 0;
  const f = appDependencies([result(68, network), result(68, network), result(68, network), result(68, network)], async () => {notarizeCalls++; throw new Error(`Failed to staple your application with code: 68\n\n${network}`);});
  await assert.rejects(notarizeApp(context(), f.dependencies), {code: 'APP_STAPLE_INVALID'});
  assert.equal(notarizeCalls, 1); assert.equal(f.calls.length, 4); assert.ok(f.calls.every(call => call.args[1] === 'staple'));
  assert.deepEqual(f.waits, [30000, 60000, 120000, 240000]);
  assert.deepEqual(f.reports[0]!.diagnostics.map(value => value.attempt), [1, 2, 3, 4, 5]); assert.equal(f.reports[0]!.acceptedKnown, true);
  assert.ok(f.reports[0]!.diagnostics.every(value => value.nsUrlErrorCode === -1005));
  assert.equal(f.reports[0]!.ok, false); assert.equal(f.reports[0]!.error, 'APP_STAPLE_INVALID'); safeDiagnostics(f.reports);
});

test('post-Accepted recovery can use its fifth staple and still validates without another notarization submission', async () => {
  let notarizeCalls = 0;
  const f = appDependencies([result(68, network), result(68, network), result(68, network), result(), result()], async () => {notarizeCalls++; throw new Error(`Failed to staple your application with code: 68\n\n${network}`);});
  await notarizeApp(context(), f.dependencies);
  assert.equal(notarizeCalls, 1); assert.deepEqual(f.calls.map(call => call.args[1]), ['staple', 'staple', 'staple', 'staple', 'validate']);
  assert.deepEqual(f.waits, [30000, 60000, 120000, 240000]);
  assert.deepEqual(f.reports[0]!.diagnostics.map(value => [value.operation, value.attempt]), [['staple', 1], ['staple', 2], ['staple', 3], ['staple', 4], ['staple', 5], ['validate', 1]]);
  assert.equal(f.reports[0]!.ok, true); assert.equal(f.reports[0]!.phase, 'complete'); safeDiagnostics(f.reports);
});

test('notarization rejection or malformed responses do not enter stapling recovery even if raw text contains a staple-looking phrase', async () => {
  for (const message of [PRIVATE, `Failed to notarize via notarytool\nstatus Invalid ${PRIVATE}`, `Failed to notarize via notarytool. Unexpected output: Failed to staple your application with code: 68\n\n${network}`]) {
    let calls = 0;
    const f = appDependencies([], async () => {calls++; throw new Error(message);});
    await assert.rejects(notarizeApp(context(), f.dependencies), {code: 'APPLE_NOTARIZATION_FAILED'});
    assert.equal(calls, 1); assert.equal(f.calls.length, 0); assert.equal(f.reports[0]!.acceptedKnown, false); assert.deepEqual(f.waits, []); safeDiagnostics(f.reports);
  }
});

test('a permanent post-Accepted staple rejection and a failed final validation both remain failed release gates', async () => {
  const permanent = appDependencies([], async () => {throw new Error(`Failed to staple your application with code: 65\n\nCould not validate ticket ${PRIVATE}`);});
  await assert.rejects(notarizeApp(context(), permanent.dependencies), {code: 'APP_STAPLE_INVALID'});
  assert.equal(permanent.calls.length, 0); assert.equal(permanent.reports[0]!.acceptedKnown, true); assert.equal(permanent.reports[0]!.ok, false);
  assert.deepEqual(permanent.waits, []);
  const invalid = appDependencies([result(65, `Could not validate ticket ${PRIVATE}`)], async () => {});
  await assert.rejects(notarizeApp(context(), invalid.dependencies), {code: 'APP_STAPLE_INVALID'});
  assert.equal(invalid.calls.length, 1); assert.equal(invalid.reports[0]!.phase, 'validate'); assert.equal(invalid.reports[0]!.ok, false); safeDiagnostics(invalid.reports);
  assert.deepEqual(invalid.waits, []);
});

test('release context, credentials and report location are validated before invoking notarization', async () => {
  const mutations: Array<(dependencies: NotarizeAppDependencies) => void> = [
    value => {value.platform = 'linux';},
    value => {value.env!.MIOON_RELEASE_SHA = 'not-a-release-sha';},
    value => {delete value.env!.APPLE_API_KEY_ID;},
    value => {value.env!.MIOON_APPLE_NOTARIZATION_REPORT = '/tmp/unowned.json';},
    value => {value.env!.MIOON_TARGET = 'linux-x64';},
  ];
  for (const mutate of mutations) {
    let calls = 0;
    const f = appDependencies([], async () => {calls++;}); mutate(f.dependencies);
    await assert.rejects(notarizeApp(context(), f.dependencies), error => {assert.ok(error instanceof CheckFailure); assert.notEqual(safeFailure(error), 'UNEXPECTED_CHECK_FAILURE'); return true;});
    assert.equal(calls, 0); assert.equal(f.calls.length, 0); safeDiagnostics(f.reports);
  }
  const f = appDependencies([], async () => assert.fail('bad app path cannot notarize'));
  await assert.rejects(notarizeApp({...context(), packager: {appInfo: {productFilename: '../outside'}}}, f.dependencies), {code: 'INVALID_APPLE_APP_CONTEXT'});
  await assert.rejects(notarizeApp({...context(), arch: 1}, f.dependencies), {code: 'INVALID_APPLE_APP_CONTEXT'});
  await assert.rejects(notarizeApp({...context(), arch: 3}, f.dependencies), {code: 'INVALID_APPLE_APP_CONTEXT'});
});

async function launcherFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-notarization-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const app = path.join(directory, 'mioon.app'), entry = 'Contents/Helpers/mioon', file = path.join(app, entry);
  await mkdir(path.dirname(file), {recursive: true});
  const bytes = Buffer.from('synthetic signed launcher bytes');
  await writeFile(file, bytes);
  await chmod(file, 0o755);
  const launcher = {entry, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
  const env: NodeJS.ProcessEnv = {...syntheticEnv(), MIOON_APPLE_CLI_LAUNCHER_REPORT: path.join(root, 'artifacts', 'desktop-macos-universal', 'cli-launcher-notarization.json')};
  return {directory, file, launcher, env};
}

test('standalone launcher notarization submits the exact signed binary once and binds acceptance to its digest', {skip: process.platform === 'win32'}, async t => {
  const fixture = await launcherFixture(t);
  const submissionId = '57e3438f-86aa-472a-94c3-a6ed1b8d5330';
  const accepted = {...result(), stdout: JSON.stringify({status: 'Accepted', id: submissionId, message: PRIVATE})};
  const {execute, calls} = executor([result(), result(), accepted]);
  const reports: AppleCliLauncherNotarizationReport[] = [];
  await notarizeCliLauncher(fixture.directory, {env: fixture.env, execute, platform: 'darwin', writeReport: async report => {reports.push(report);}});
  assert.deepEqual(calls.map(call => call.file), ['/usr/bin/codesign', '/usr/bin/ditto', '/usr/bin/xcrun']);
  assert.deepEqual(calls[0].args, ['--verify', '--strict', '--all-architectures', fixture.file]);
  const zip = calls[1].args.at(-1)!;
  assert.deepEqual(calls[1].args, ['-c', '-k', '--norsrc', fixture.file, zip]);
  assert.deepEqual(calls[2].args, ['notarytool', 'submit', zip, '--key', fixture.env.APPLE_API_KEY_PATH, '--key-id', PRIVATE,
    '--issuer', PRIVATE, '--wait', '--timeout', '30m', '--output-format', 'json']);
  assert.deepEqual(reports, [{version: 1, kind: 'cli-launcher-notarization', ok: true, status: 'Accepted', submissionId, launcher: fixture.launcher}]);
  verifyCliLauncherNotarization(reports[0], fixture.launcher);
  assert.throws(() => verifyCliLauncherNotarization(reports[0], {...fixture.launcher, sha256: '0'.repeat(64)}),
    {code: 'CLI_LAUNCHER_NOTARIZATION_MISMATCH'});
  await assert.rejects(readFile(path.dirname(zip)), {code: 'ENOENT'});
  safeDiagnostics(reports);
});

test('failed launcher verification or notarization cannot produce accepted evidence or retry submission', {skip: process.platform === 'win32'}, async t => {
  const fixture = await launcherFixture(t);
  const rejected = {...result(), stdout: JSON.stringify({status: 'Invalid', message: PRIVATE})};
  for (const {results, code} of [
    {results: [result(1, PRIVATE)], code: 'CLI_LAUNCHER_SIGNATURE_FAILED'},
    {results: [result(), result(), rejected], code: 'CLI_LAUNCHER_NOTARIZATION_FAILED'},
    {results: [result(), result(), {...result(), stdout: PRIVATE}], code: 'CLI_LAUNCHER_NOTARIZATION_FAILED'},
  ]) {
    const {execute, calls} = executor(results), reports: AppleCliLauncherNotarizationReport[] = [];
    await assert.rejects(notarizeCliLauncher(fixture.directory, {env: fixture.env, execute, platform: 'darwin',
      writeReport: async report => {reports.push(report);}}), {code});
    assert.equal(calls.length, results.length);
    assert.equal(reports[0].ok, false);
    assert.equal(reports[0].status, undefined);
    assert.throws(() => verifyCliLauncherNotarization(reports[0], fixture.launcher), {code: 'CLI_LAUNCHER_NOTARIZATION_MISMATCH'});
    safeDiagnostics(reports);
  }
});

test('electron-builder resolves the actual release-only CJS hook from its desktop working directory', async () => {
  const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder'));
  const libraryRoot = path.dirname(builder.resolve('app-builder-lib/package.json'));
  const {resolveFunction} = require(path.join(libraryRoot, 'out', 'util', 'resolve.js')) as {resolveFunction(type: string, executor: string, name: string, root: string): Promise<unknown>};
  const previous = process.cwd();
  try {
    process.chdir(path.join(root, 'apps', 'desktop'));
    const hook = await resolveFunction('module', '../../.github/scripts/notarize-app.cjs', 'afterSign', root);
    assert.equal(typeof hook, 'function');
    // This checks dynamic import of the TS implementation without accessing a
    // credential or invoking any macOS signing/notarization command.
    await assert.rejects((hook as (context: unknown) => Promise<void>)({electronPlatformName: 'linux'}), {code: 'APPLE_NOTARIZATION_RELEASE_ONLY'});
  } finally {process.chdir(previous);}
});
