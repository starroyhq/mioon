import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {argumentsFor, cleanEnvironment, command, mediaCapabilities, mediaFailureReport, MediaCapabilityFailure, probeMediaCli, safeFailure, targetArch, targetPlatform, CheckFailure, report} from '../.github/scripts/media-environment.ts';
import {boundedPoll, extractedTarFor, mountedDmgFor, smokeEnvironment, smokeTimeouts, validateDiscovery} from '../.github/scripts/desktop-smoke.ts';
import {runMacInspectionCheck, validateArchitecture, validateMacStapledArtifact, validateTarListing, verifyPackagedProjectNotices, verifySigningIdentity} from '../.github/scripts/inspect-desktop.ts';
import type {MacStaplerDiagnostic} from '../.github/scripts/inspect-desktop.ts';
import {PROJECT_NOTICES} from '../apps/desktop/scripts/stage-project-notices.ts';

test('desktop helper CLI rejects missing, duplicate, unknown and multiline options', () => {
  assert.deepEqual(argumentsFor(['--platform=linux', '--output=result.json'], ['platform', 'output']), {platform: 'linux', output: 'result.json'});
  for (const args of [[], ['--platform=linux'], ['--platform=linux', '--platform=darwin', '--output=x'], ['--platform=linux', '--output=x', '--secret=value'], ['--platform=linux', '--output=x\ny']]) assert.throws(() => argumentsFor(args, ['platform', 'output']));
  assert.equal(targetPlatform('darwin'), 'darwin'); assert.equal(targetArch('arm64'), 'arm64');
  assert.throws(() => targetPlatform('win32')); assert.throws(() => targetArch('universal'));
});

test('Linux and macOS media admission require every application filter and encoder', () => {
  const filterNames = ['drawtext', 'subtitles', 'zscale', 'loudnorm', 'ebur128'], encoderNames = ['libx264', 'aac', 'libwebp', 'libwebp_anim'];
  const encoders = encoderNames.map(name => ` V....D ${name} fixture`).join('\n');
  for (const platform of ['linux', 'darwin'] as const) for (const flags of ['...', '..']) {
    const filters = filterNames.map(name => ` ${flags} ${name} V->V fixture`).join('\n');
    assert.deepEqual(mediaCapabilities(platform, filters, encoders), {
      filters: Object.fromEntries(filterNames.map(name => [name, true])), encoders: Object.fromEntries(encoderNames.map(name => [name, true])),
    });
    for (const name of filterNames) assert.equal(mediaCapabilities(platform, filters.replace(` ${name} `, ` ${name}_fake `), encoders).filters[name], false);
    for (const name of encoderNames) assert.equal(mediaCapabilities(platform, filters, encoders.replace(` ${name} `, ` ${name}_fake `)).encoders[name], false);
    const basic = mediaCapabilities(platform, '', ' V....D libx264 fixture\n A..... aac fixture');
    assert.ok(Object.values(basic.filters).every(value => value === false));
    assert.deepEqual(basic.encoders, {libx264: true, aac: true, libwebp: false, libwebp_anim: false});
  }
});

test('media parsing accepts FFmpeg 7.1 and 9 filter rows while retaining exact names and encoder columns', () => {
  const ffmpeg9 = ' .. ebur128           A->N       EBU R128 scanner.\n .. loudnorm          A->A       EBU R128 loudness normalization\n';
  const ffmpeg71 = ' ... ebur128           A->N       EBU R128 scanner.\n ... loudnorm          A->A       EBU R128 loudness normalization\n';
  for (const filters of [ffmpeg71, ffmpeg9]) {
    assert.deepEqual(mediaCapabilities('darwin', filters, ' V....D libx264 fixture\n A..... aac fixture'), {
      filters: {drawtext: false, subtitles: false, zscale: false, loudnorm: true, ebur128: true},
      encoders: {libx264: true, aac: true, libwebp: false, libwebp_anim: false},
    });
  }
  for (const filters of [' . loudnorm A->A', ' .... loudnorm A->A', ' ...... loudnorm A->A', ' .. loudnorm_fake A->A', ' prefix .. loudnorm A->A', ' ..\nloudnorm A->A']) assert.equal(mediaCapabilities('darwin', filters, '').filters.loudnorm, false);
  for (const encoders of [' .. libx264 fixture', ' ... libx264 fixture', ' V.... libx264 fixture', ' V.....D libx264 fixture', ' V....D libx264_fake fixture', ' prefix V....D libx264 fixture']) assert.equal(mediaCapabilities('darwin', '', encoders).encoders.libx264, false);
});

test('CLI capability probes keep scripts private and clean them after success and parser failure', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-cli-probe-test-'));
  try {
    const calls: string[] = [];
    const run: typeof command = async (_file, args, code) => {
      calls.push(code);
      for (const flag of ['-/filter:v', '-/filter_complex']) if (args.includes(flag)) {
        const file = args[args.indexOf(flag) + 1];
        assert.equal(await readFile(file, 'utf8'), flag === '-/filter:v' ? 'null' : '[0:v]null[outv]');
        assert.ok(path.basename(file).includes(' '), 'file argument must remain one argv element');
      }
      return '';
    };
    assert.deepEqual(await probeMediaCli('synthetic-tool', {temporaryRoot: directory, execute: run}), {filterArgumentFromFile: true, complexFilterArgumentFromFile: true, fpsModePassthrough: true, pngEncode: true, pngDecode: true});
    assert.equal(calls.length, 5); assert.deepEqual(await readdir(directory), []);
    await assert.rejects(probeMediaCli('synthetic-tool', {temporaryRoot: directory, execute: async () => { throw new CheckFailure('FFMPEG_FILTER_FILE_ARGUMENT_UNSUPPORTED'); }}), {message: 'FFMPEG_FILTER_FILE_ARGUMENT_UNSUPPORTED'});
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('native child environment cannot inherit provider, GitHub, Apple or Node injection secrets', () => {
  const source = {HOME: '/private/home', PATH: '/usr/bin', DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/private/bus', GH_TOKEN: 'private-gh', GITHUB_TOKEN: 'private-gh2', APPLE_API_PRIVATE_KEY: 'private-apple', GEMINI_API_KEY: 'private-provider', ARK_API_KEY: 'private-ark', NODE_OPTIONS: '--require malicious', ELECTRON_RUN_AS_NODE: '1', MIOON_ENABLE_LIVE_PROVIDER: '1'};
  const env = smokeEnvironment(source, '/private/synthetic', '/usr/bin/ffmpeg', '/usr/bin/ffprobe');
  assert.deepEqual(cleanEnvironment(source), {PATH: '/usr/bin', HOME: '/private/home', DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/private/bus'});
  assert.equal(env.MIOON_ENABLE_LIVE_PROVIDER, undefined); assert.equal(env.MIOON_DESKTOP_USER_DATA, '/private/synthetic');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'APPLE_API_PRIVATE_KEY', 'GEMINI_API_KEY', 'ARK_API_KEY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.equal(env[key], undefined);
});

test('private discovery is bound to production identity, loopback and exact owned token path', () => {
  const owned = path.join(tmpdir(), 'mioon-owned');
  const base = {appId: 'app.starroy.mioon', channel: 'production', url: 'http://127.0.0.1:55291', pid: 1234, tokenFile: path.join(owned, 'mcp-token')};
  assert.equal(validateDiscovery(base, owned).pid, 1234);
  for (const changed of [{channel: 'development'}, {appId: 'other'}, {pid: 1}, {tokenFile: '/private/unrelated/token'}, {url: 'https://127.0.0.1:55291'}, {url: 'http://example.com:55291'}, {url: 'http://secret@127.0.0.1:55291'}, {url: 'http://127.0.0.1:55291/path'}, {url: 'http://127.0.0.1:55291?secret=x'}]) assert.throws(() => validateDiscovery({...base, ...changed}, owned));
});

test('architecture inspection rejects wrong and universal artifacts', () => {
  validateArchitecture('arm64\n', 'darwin', 'arm64'); validateArchitecture('x86_64\n', 'darwin', 'x64');
  validateArchitecture('ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV)', 'linux', 'x64');
  assert.throws(() => validateArchitecture('arm64 x86_64', 'darwin', 'arm64'));
  assert.throws(() => validateArchitecture('arm64', 'darwin', 'x64'));
  assert.throws(() => validateArchitecture('ELF 64-bit LSB executable, ARM aarch64', 'linux', 'x64'));
});

test('codesign identity requires reviewed Developer ID, Team ID and hardened runtime', () => {
  const identity = 'Developer ID Application: Example Team (ABCDEFGHIJ)';
  const output = `Authority=${identity}\nAuthority=Apple Root CA\nTeamIdentifier=ABCDEFGHIJ\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1`;
  verifySigningIdentity(output, identity, 'ABCDEFGHIJ');
  for (const [body, name, team] of [[output, undefined, 'ABCDEFGHIJ'], [output, identity, undefined], [output.replace('flags=0x10000(runtime)', 'flags=0x0(none)'), identity, 'ABCDEFGHIJ'], [output.replace('TeamIdentifier=ABCDEFGHIJ', 'TeamIdentifier=KLMNOPQRST'), identity, 'ABCDEFGHIJ'], [output.replace(identity, 'Developer ID Application: Another Team (ABCDEFGHIJ)'), identity, 'ABCDEFGHIJ']] as const) assert.throws(() => verifySigningIdentity(body, name, team));
});

test('only controlled mounted DMG paths are candidates for teardown', () => {
  assert.equal(mountedDmgFor('/private/tmp/mioon-ci-dmg-abcd/Mioon.app/Contents/MacOS/Mioon'), '/private/tmp/mioon-ci-dmg-abcd');
  assert.equal(mountedDmgFor('/Applications/Mioon.app/Contents/MacOS/Mioon'), null);
  assert.equal(mountedDmgFor('/private/tmp/mioon-ci-dmg-abcd/random'), null);
});

test('only controlled delivered Linux extraction paths are candidates for teardown', () => {
  assert.equal(extractedTarFor('/tmp/mioon-ci-extract-ABC123/mioon-0.4.1-linux-x64/mioon'), '/tmp/mioon-ci-extract-ABC123');
  for (const file of ['/tmp/unrelated/mioon-0.4.1-linux-x64/mioon', '/tmp/mioon-ci-extract-user-work/mioon-0.4.1-linux-x64/mioon', '/tmp/mioon-ci-extract-ABC123/mioon-0.4.1-linux-x64/other']) assert.equal(extractedTarFor(file), null);
});

test('tar admission rejects traversal, hard links, escaping links, duplicate and symlink-parent entries', () => {
  const base = 'mioon-0.4.1-linux-x64';
  const listing = (rows: readonly [string, string, string?][]): [string, string] => [rows.map(row => row[1]).join('\n') + '\n', rows.map(([kind, name, target]) => `${kind}rwxr-xr-x 0/0 1 2026-10-20 01:00:00 ${name}${target ? ` -> ${target}` : ''}`).join('\n') + '\n'];
  validateTarListing(...listing([['d', `${base}/`], ['-', `${base}/mioon`], ['l', `${base}/lib.so`, 'lib.so.1'], ['-', `${base}/lib.so.1`]]), base);
  const sandbox = listing([['-', `${base}/chrome-sandbox`]]);
  validateTarListing(sandbox[0], sandbox[1].replace('-rwxr-xr-x', '-rwsr-xr-x'), base);
  for (const rows of [
    [['-', '/etc/passwd']], [['-', `${base}/../escape`]], [['h', `${base}/mioon`]],
    [['l', `${base}/lib.so`, '../../outside']], [['l', `${base}/lib.so`, '/etc/passwd']],
    [['d', `${base}/sub/`], ['l', `${base}/sub/lib.so`, '../lib.so.1']],
    [['d', `${base}/sub/`], ['l', `${base}/a`, 'sub'], ['l', `${base}/sub/k`, '../a'], ['l', `${base}/b`, 'a/k/k/../../../outside']],
    [['-', `${base}/mioon`], ['-', `${base}/mioon`]],
    [['l', `${base}/libs`, 'subdir'], ['-', `${base}/libs/file`]],
  ] as Array<Array<[string, string, string?]>>) assert.throws(() => validateTarListing(...listing(rows), base));
});

test('bounded polling honors completion, early exit and timeout without private error text', async () => {
  assert.equal(await boundedPoll(async () => 'ready', 100, 'POLL_TIMEOUT'), 'ready');
  await assert.rejects(boundedPoll(async () => false, 25, 'POLL_TIMEOUT'), {message: 'POLL_TIMEOUT'});
  await assert.rejects(boundedPoll(async () => new Promise<false>(() => {}), 25, 'POLL_TIMEOUT'), {message: 'POLL_TIMEOUT'});
  await assert.rejects(boundedPoll(async () => false, 100, 'POLL_TIMEOUT', () => true), {message: 'APP_EXITED_EARLY'});
  await assert.rejects(boundedPoll(async () => false, -1, 'POLL_TIMEOUT'), {message: 'INVALID_POLL_TIMEOUT'});
  assert.deepEqual(smokeTimeouts, {startup: 90000, render: 120000, exit: 30000});
});

test('command failure and timeout never reveal child output, arguments or environment', async () => {
  const secret = 'synthetic-must-never-appear';
  const failed = await command(process.execPath, ['-e', `console.error(${JSON.stringify(secret)});process.exit(9)`], 'EXPECTED_COMMAND_FAILURE').catch(error => error as unknown);
  assert.ok(failed instanceof CheckFailure); assert.equal(safeFailure(failed), 'EXPECTED_COMMAND_FAILURE'); assert.ok(!String(failed).includes(secret));
  const started = Date.now();
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 'EXPECTED_COMMAND_TIMEOUT', {timeout: 50}), {message: 'EXPECTED_COMMAND_TIMEOUT'});
  assert.ok(Date.now() - started < 5000);
  assert.equal(safeFailure(new Error(secret)), 'UNEXPECTED_CHECK_FAILURE');
});

test('machine-readable diagnostics retain fixed error code only', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-actions-helper-test-'));
  try {
    const output = path.join(directory, 'reports/result.json');
    await report(output, {ok: false, error: safeFailure(new Error('Bearer private-token'))});
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {ok: false, error: 'UNEXPECTED_CHECK_FAILURE'});
    assert.ok(!(await readFile(output, 'utf8')).includes('private-token'));
    const capabilities = mediaCapabilities('darwin', ' .. loudnorm A->A fixture', ' A..... aac fixture');
    await report(output, mediaFailureReport(new MediaCapabilityFailure(capabilities)));
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {ok: false, error: 'REQUIRED_MEDIA_CAPABILITY_MISSING', capabilities});
    assert.deepEqual(mediaFailureReport(Object.assign(new Error('Bearer private-token'), {capabilities: {secret: 'private-token'}})), {ok: false, error: 'UNEXPECTED_CHECK_FAILURE'});
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('Mac package subchecks expose only fixed phases and error codes', async () => {
  const cases = [
    ['asar-content', 'ASAR_STAGING_MISMATCH'], ['asar-metadata', 'ASAR_METADATA_MISMATCH'],
    ['asar-required-files', 'ASAR_REQUIRED_FILES_MISSING'], ['tray-resources', 'TRAY_RESOURCES_INVALID'],
    ['subtitle-resources', 'SUBTITLE_RESOURCES_INVALID'], ['fuses', 'FUSE_INSPECTION_FAILED'],
    ['runtime-notice-source', 'RUNTIME_NOTICE_PROVENANCE_INVALID'], ['runtime-notice-bytes', 'ELECTRON_NOTICE_MISMATCH'],
    ['codesign', 'CODESIGN_VERIFICATION_FAILED'], ['signing-identity', 'SIGNING_IDENTITY_MISMATCH'],
    ['app-staple', 'APP_STAPLE_INVALID'], ['app-gatekeeper', 'GATEKEEPER_REJECTED']
  ] as const;
  for (const scope of ['staged-mac-app', 'mounted-dmg-app'] as const) for (const [name, code] of cases) {
    const phases: string[] = [];
    const failure = await runMacInspectionCheck(scope, name, async () => { throw new Error('private source bytes/token'); }, phase => phases.push(phase)).catch(error => error as unknown);
    assert.ok(failure instanceof CheckFailure);
    assert.equal(safeFailure(failure), code);
    assert.deepEqual(phases, [`${scope}:${name}`]);
    assert.doesNotMatch(String(failure), /private|token/);
  }
  const fixed = new CheckFailure('FUSE_MUST_BE_DISABLED');
  await assert.rejects(runMacInspectionCheck('staged-mac-app', 'fuses', async () => { throw fixed; }), error => error === fixed);
  assert.equal(await runMacInspectionCheck('mounted-dmg-app', 'runtime-notice-source', async () => 'verified'), 'verified');
});

test('staged app, delivered app and DMG validation retain mandatory gates and safe terminal diagnostics', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-apple-inspection-'));
  const secret = 'synthetic-private-apple-output';
  const failures = [
    {exitCode: 66, signal: null, timedOut: false, category: 'invalid_ticket'},
    {exitCode: null, signal: 'SIGKILL', timedOut: true, category: 'timeout'},
    {exitCode: null, signal: 'SIGTERM', timedOut: false, category: 'signal'}
  ] as const;
  try {
    for (const scope of ['staged-mac-app', 'mounted-dmg-app', 'signed-dmg'] as const) for (const fixture of failures) {
      const diagnostics: MacStaplerDiagnostic[] = [], phases: string[] = [], commands: Array<{file: string; args: readonly string[]}> = [];
      const artifact = path.join(directory, `${secret}.${scope === 'signed-dmg' ? 'dmg' : 'app'}`);
      const validate = () => validateMacStapledArtifact(scope, artifact, {
        onDiagnostic: value => diagnostics.push(value),
        execute: async (file, args) => {
          commands.push({file, args});
          return {...fixture, stdout: `${secret}: ticket missing`, stderr: `${secret}: private command output`};
        },
        wait: async () => { assert.fail('permanent validation failure must not be retried'); }
      });
      const failure = await (scope === 'signed-dmg' ? validate()
        : runMacInspectionCheck(scope, 'app-staple', validate, phase => phases.push(phase))).catch(error => error as unknown);
      const code = scope === 'signed-dmg' ? 'DMG_STAPLE_INVALID' : 'APP_STAPLE_INVALID';
      assert.ok(failure instanceof CheckFailure); assert.equal(safeFailure(failure), code);
      assert.deepEqual(commands, [{file: 'xcrun', args: ['stapler', 'validate', '-v', artifact]}]);
      assert.deepEqual(phases, scope === 'signed-dmg' ? [] : [`${scope}:app-staple`]);
      assert.deepEqual(diagnostics, [{scope, operation: 'validate', artifactKind: scope === 'signed-dmg' ? 'dmg' : 'app',
        attempt: 1, ok: false, exitCode: fixture.exitCode, signal: fixture.signal, timedOut: fixture.timedOut,
        category: fixture.category, willRetry: false}]);
      const output = path.join(directory, 'inspection.json');
      await report(output, {ok: false, phase: scope === 'signed-dmg' ? scope : phases[0], error: safeFailure(failure), appleStaplerDiagnostics: diagnostics});
      const serialized = await readFile(output, 'utf8');
      assert.equal(JSON.parse(serialized).error, code);
      assert.deepEqual(JSON.parse(serialized).appleStaplerDiagnostics, diagnostics);
      assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes(artifact));
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('a recovered ticket validation keeps later Gatekeeper rejection mandatory', async () => {
  const diagnostics: MacStaplerDiagnostic[] = [], phases: string[] = [], waits: number[] = [];
  let commands = 0;
  const artifact = path.resolve('synthetic-release.app');
  await runMacInspectionCheck('staged-mac-app', 'app-staple', () => validateMacStapledArtifact('staged-mac-app', artifact, {
    onDiagnostic: value => diagnostics.push(value), wait: async milliseconds => { waits.push(milliseconds); },
    execute: async () => ++commands === 1
      ? {exitCode: 68, signal: null, timedOut: false, stdout: '', stderr: 'CloudKit NSURLErrorDomain Code=-1005 synthetic-private-output'}
      : {exitCode: 0, signal: null, timedOut: false, stdout: 'synthetic-private-output', stderr: ''}
  }), phase => phases.push(phase));
  assert.equal(commands, 2); assert.equal(waits.length, 1);
  assert.deepEqual(diagnostics.map(value => ({scope: value.scope, category: value.category, ok: value.ok, willRetry: value.willRetry})), [
    {scope: 'staged-mac-app', category: 'transient_network', ok: false, willRetry: true},
    {scope: 'staged-mac-app', category: 'success', ok: true, willRetry: false}
  ]);
  await assert.rejects(runMacInspectionCheck('staged-mac-app', 'app-gatekeeper', async () => {
    throw new CheckFailure('GATEKEEPER_REJECTED');
  }, phase => phases.push(phase)), {message: 'GATEKEEPER_REJECTED'});
  assert.deepEqual(phases, ['staged-mac-app:app-staple', 'staged-mac-app:app-gatekeeper']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-private-output/);
});

test('the packaged project license and notices must exist and match the checked source byte for byte', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-project-notice-inspection-'));
  const archive = path.join(directory, 'app.asar');
  const entries = new Map<string, Buffer>();
  const asar = {extractFile(selected: string, name: string): Buffer {
    assert.equal(selected, archive);
    const bytes = entries.get(name);
    if (!bytes) throw new Error('missing synthetic archive member');
    return bytes;
  }};
  try {
    for (const [index, file] of PROJECT_NOTICES.entries()) {
      const source = Buffer.from(`Synthetic ${file.source}\r\n声明 ${index}\n`, 'utf8');
      await writeFile(path.join(directory, file.source), source);
      entries.set(`licenses/${file.output}`, source);
    }
    await verifyPackagedProjectNotices(archive, asar, directory);
    for (const scope of ['staged-mac-app', 'mounted-dmg-app'] as const) for (const file of PROJECT_NOTICES) {
      const entry = `licenses/${file.output}`, source = entries.get(entry)!;
      for (const change of ['missing', 'modified', 'empty-source'] as const) {
        if (change === 'missing') entries.delete(entry);
        else if (change === 'modified') entries.set(entry, Buffer.concat([source, Buffer.from('tampered')]));
        else await writeFile(path.join(directory, file.source), '');
        const phases: string[] = [];
        await assert.rejects(runMacInspectionCheck(scope, 'asar-required-files', () => verifyPackagedProjectNotices(archive, asar, directory), phase => phases.push(phase)), {message: 'ASAR_REQUIRED_FILES_MISSING'});
        assert.deepEqual(phases, [`${scope}:asar-required-files`]);
        entries.set(entry, source); await writeFile(path.join(directory, file.source), source);
      }
    }
    await verifyPackagedProjectNotices(archive, asar, directory);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
