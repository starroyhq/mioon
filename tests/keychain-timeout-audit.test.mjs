import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile, mkdtemp, realpath, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import builderConfig from '../apps/desktop/builder-config.cjs';

// Historical regression evidence only. These immutable 9e9598d source bytes
// intentionally reproduce the old synchronous defect. Current macOS async
// success/responsiveness is tested against live modules in desktop-async-secrets.
const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureFile = new URL('./fixtures/keychain-sync-9e9598d.json', import.meta.url);
const raw = await readFile(fixtureFile);
const fixture = JSON.parse(raw);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = ['tests/keychain-timeout-audit.test.mjs', 'apps/desktop/identity.ts',
  ...['secret-store', 'image-secret-store', 'image-secret-broker', 'secret-broker', 'security', 'shutdown', 'supervisor']
    .map(name => `apps/desktop/src/${name}.ts`)];

function verifyFixture() {
  assert.equal(digest(raw), 'db061a98ebd36429230efd92af12a2e053adb5a09cafc1e7ba18f82540012b6f');
  assert.equal(fixture.baseline, '9e9598d887b21b8e1b7dc742e5d15c66a3ff93d4');
  assert.deepEqual(fixture.files.map(file => file.path), expected);
  for (const file of fixture.files) {
    assert.equal(typeof file.content, 'string');
    assert.equal(digest(Buffer.from(file.content, 'utf8')), file.sha256, file.path);
  }
  assert.equal(fixture.files[0].sha256, 'c8da3aef5577cd47fb1e049ee5ac4a14f82220e6bb0f4ce732c00171cd6e8863');
}

test('historical 9e synchronous Keychain snapshot preserves original audit and eight source dependencies byte-for-byte', () => {
  verifyFixture();
});

test('historical 9e synchronous defect still reproduces its original seven synthetic assertions; this is not current macOS behavior', {timeout: 45000}, async t => {
  verifyFixture();
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-historical-keychain-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const file of fixture.files) {
    const target = path.join(directory, file.path);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, file.content, {encoding: 'utf8', flag: 'wx'});
    assert.equal(digest(await readFile(target)), file.sha256);
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
      path.join(directory, 'tests/keychain-timeout-audit.test.mjs')], {cwd: directory, env: {}, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', oversized = false;
    const timer = setTimeout(() => child.kill(), 35000);
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.setEncoding('utf8').on('data', bytes => {
      if (name === 'stdout') stdout += bytes; else stderr += bytes;
      if (stdout.length + stderr.length > 2 * 1024 * 1024) {oversized = true; child.kill();}
    });
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', (code, signal) => {clearTimeout(timer); resolve({code, signal, stdout, stderr, oversized});});
  });
  assert.equal(result.oversized, false);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# tests 7$/m);
  assert.match(result.stdout, /^# pass 7$/m);
  assert.match(result.stdout, /^# fail 0$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
  t.diagnostic('Only the immutable historical 9e source was exercised: 7/7 original synthetic assertions. Current async behavior has a separate suite.');
});

test('historical Keychain fixture is outside production staging and package allowlists', async () => {
  for (const channel of ['development', 'production']) {
    assert.deepEqual(builderConfig(channel).files, ['main.cjs', 'backend.cjs', 'preload.cjs', 'package.json', 'web/**/*', 'icons/**/*', 'licenses/**/*', '!node_modules/**/*']);
  }
  const build = await readFile(path.join(root, 'apps/desktop/scripts/build.ts'), 'utf8');
  assert.match(build, /for \(const name of \['main', 'backend'\]\)/);
  assert.doesNotMatch(build, /keychain-sync-9e9598d|tests\/fixtures/);
  for (const name of ['main', 'secret-store', 'image-secret-store', 'image-secret-broker', 'secret-broker']) {
    const source = await readFile(path.join(root, `apps/desktop/src/${name}.ts`), 'utf8');
    assert.doesNotMatch(source, /keychain-sync-9e9598d|tests\/fixtures/);
  }
});
