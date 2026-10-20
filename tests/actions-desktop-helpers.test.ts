import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {argumentsFor, cleanEnvironment, command, mediaCapabilities, probeMediaCli, safeFailure, targetArch, targetPlatform, CheckFailure, report} from '../.github/scripts/media-environment.ts';
import {boundedPoll, extractedTarFor, mountedDmgFor, smokeEnvironment, smokeTimeouts, validateDiscovery} from '../.github/scripts/desktop-smoke.ts';
import {validateArchitecture, validateTarListing, verifySigningIdentity} from '../.github/scripts/inspect-desktop.ts';

test('desktop helper CLI rejects missing, duplicate, unknown and multiline options', () => {
  assert.deepEqual(argumentsFor(['--platform=linux', '--output=result.json'], ['platform', 'output']), {platform: 'linux', output: 'result.json'});
  for (const args of [[], ['--platform=linux'], ['--platform=linux', '--platform=darwin', '--output=x'], ['--platform=linux', '--output=x', '--secret=value'], ['--platform=linux', '--output=x\ny']]) assert.throws(() => argumentsFor(args, ['platform', 'output']));
  assert.equal(targetPlatform('darwin'), 'darwin'); assert.equal(targetArch('arm64'), 'arm64');
  assert.throws(() => targetPlatform('win32')); assert.throws(() => targetArch('universal'));
});

test('strict Linux media admission requires every named filter and encoder', () => {
  const filters = ['drawtext', 'subtitles', 'zscale', 'loudnorm', 'ebur128'].map(name => ` ... ${name} V->V fixture`).join('\n');
  const encoders = ['libx264', 'aac', 'libwebp', 'libwebp_anim'].map(name => ` V....D ${name} fixture`).join('\n');
  const complete = mediaCapabilities('linux', filters, encoders);
  assert.ok(Object.values(complete.filters).every(Boolean)); assert.ok(Object.values(complete.encoders).every(Boolean));
  assert.equal(mediaCapabilities('linux', filters.replace(' subtitles ', ' unavailable '), encoders).filters.subtitles, false);
  assert.equal(mediaCapabilities('linux', filters, encoders.replace(' libwebp_anim ', ' libwebp_anim_fake ')).encoders.libwebp_anim, false);
  assert.deepEqual(mediaCapabilities('darwin', '', ' V....D libx264 fixture\n A..... aac fixture'), {filters: {}, encoders: {libx264: true, aac: true}});
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
  assert.equal(env.MIOON_ENABLE_LIVE_PROVIDER, '0'); assert.equal(env.MIOON_DESKTOP_USER_DATA, '/private/synthetic');
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
  } finally { await rm(directory, {recursive: true, force: true}); }
});
