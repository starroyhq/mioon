import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createMacDesktopUpdateVerifier} from '../apps/desktop/src/desktop-update-mac-verify.ts';
import {verifyOfficialMacDesktopProcess} from '../apps/desktop/src/production-channel-signing.ts';
import {testEnv} from './helpers/test-env.ts';

const identity = 'org.example.mioon.synthetic',
  version = '0.2.1', currentVersion = '0.2.0', offer = {version, currentVersion, notes: []};

function signedApp(root: string, appName: string, version: string, identifier: string) {
  const app = path.join(root, appName), contents = path.join(app, 'Contents'), binaries = path.join(contents, 'MacOS');
  mkdirSync(binaries, {recursive: true});
  const executable = path.join(binaries, 'Synthetic');
  copyFileSync('/usr/bin/true', executable);
  chmodSync(executable, 0o755);
  writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Synthetic</string>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
</dict></plist>`);
  const resources = path.join(contents, 'Resources');
  mkdirSync(resources);
  writeFileSync(path.join(resources, 'payload.txt'), 'Signed resource');
  symlinkSync('payload.txt', path.join(resources, 'link.txt'));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', identifier,
    '-r', `=designated => identifier "${identifier}"`, app], {env: testEnv(), stdio: 'pipe'});
  return app;
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-mac-update-'));
  const applicationPath = signedApp(root, 'Installed copy.app', currentVersion, identity);
  const temporaryDirectory = path.join(root, 'work');
  mkdirSync(temporaryDirectory, {mode: 0o700});
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const verifier = createMacDesktopUpdateVerifier({applicationPath, temporaryDirectory, downloadCacheRoot: root, fileSystem});
  function archive(candidateName = 'mioon.app', candidateVersion = version, identifier = identity,
    change?: (file: string) => void) {
    const candidateRoot = mkdtempSync(path.join(root, 'candidate-'));
    const candidate = signedApp(candidateRoot, candidateName, candidateVersion, identifier);
    change?.(candidate);
    const zip = path.join(candidateRoot, `mioon-${version}-mac.zip`);
    execFileSync('/usr/bin/zip', ['-q', '-7', '-r', '-y', zip, candidateName], {cwd: candidateRoot, env: testEnv()});
    chmodSync(candidateRoot, 0o755); // The updater's pending directory uses the library's normal mkdir mode.
    const digest = createHash('sha512').update(readFileSync(zip)).digest('base64');
    return {zip, digest};
  }
  const verify = ({zip, digest}: ReturnType<typeof archive>) => verifier([zip], offer, new AbortController().signal, digest);
  const verifyFailed = async (input: ReturnType<typeof archive>) => {
    await assert.rejects(verify(input), {message: 'UPDATE_MAC_VERIFY_FAILED'});
    assert.deepEqual(readdirSync(temporaryDirectory), []);
  };
  return {archive, verify, verifyFailed, temporaryDirectory};
}

test('macOS verifies the release digest, bundle version and the current app’s real designated requirement', {
  skip: process.platform !== 'darwin' && 'Apple code signing is only available on macOS',
}, async t => {
  const {archive, verify, temporaryDirectory} = fixture(t);
  await verify(archive());
  assert.deepEqual(readdirSync(temporaryDirectory), []);
});

test('macOS discards verification scratch after an incorrect digest, version, signature or bundle shape', {
  skip: process.platform !== 'darwin' && 'Apple code signing is only available on macOS',
}, async t => {
  const {archive, verifyFailed} = fixture(t);
  const update = archive();
  await verifyFailed({...update, digest: createHash('sha512').update('different package').digest('base64')});
  await verifyFailed(archive('mioon.app', '0.2.2'));
  await verifyFailed(archive('mioon.app', version, 'org.example.mioon.different'));
  await verifyFailed(archive('Other.app'));
  await verifyFailed(archive('mioon.app', version, identity, candidate => {
    writeFileSync(path.join(candidate, 'Contents', 'Resources', 'payload.txt'), 'Changed after signing');
  }));
});

test('production startup pins the live PID to the signed identifier, Developer ID Application chain and release team', () => {
  const calls: unknown[] = [];
  assert.equal(verifyOfficialMacDesktopProcess((...args) => calls.push(args)), true);
  assert.deepEqual(calls, [[
    '/usr/bin/codesign',
    ['--verify', '--ignore-resources',
      '-R=identifier "app.starroy.mioon" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "A7C3K354YP"',
      String(process.pid)],
    {env: {}, stdio: 'ignore', timeout: 2000, killSignal: 'SIGKILL'},
  ]]);
});

test('production startup fails closed for an unsuitable signing certificate, process mismatch or unavailable verifier', () => {
  for (const [reason, failure] of [
    ['same identifier and team with an unsuitable certificate', {status: 3}],
    ['invalid dynamic signature', {status: 1}],
    ['missing system verifier', {code: 'ENOENT'}],
    ['verifier exceeded its deadline', {code: 'ETIMEDOUT', signal: 'SIGKILL'}],
  ] as const) {
    assert.equal(verifyOfficialMacDesktopProcess(() => {
      throw Object.assign(new Error('Signature verification failed'), failure);
    }), false, reason);
  }
});
