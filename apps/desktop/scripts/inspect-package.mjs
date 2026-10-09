import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const dependencies = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = dependencies('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = dependencies('@electron/fuses');
const directory = path.join(root, 'release/desktop/linux-unpacked');
const archive = path.join(directory, 'resources/app.asar');
const binary = path.join(directory, 'video-workbench');
const files = asar.listPackage(archive);
assert.ok(files.length > 10);
assert.equal(files.some(file => file.startsWith('/node_modules')), false);
assert.equal(files.some(file => /\/(?:data|workspace|media|\.env|access-token|mcp-token|mcp-connection\.json|workbench\.sqlite)(?:\/|$)/.test(file)), false);
const allowed = new Set(['main.cjs', 'backend.cjs', 'package.json', 'web', 'licenses']);
for (const file of files) {
  assert.ok(allowed.has(file.split('/')[1]), `Unexpected ASAR entry: ${file}`);
  assert.equal(Boolean(asar.statFile(archive, file.slice(1), false).link), false, 'No packaged symlink');
}
for (const file of ['main.cjs', 'backend.cjs', 'package.json', 'web/index.html', 'licenses/shadcn-ui-LICENSE.md']) {
  assert.deepEqual(asar.extractFile(archive, file), await readFile(path.join(root, 'apps/desktop/build', file)), `Packaged ${file} must equal verified staging`);
}
const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.deepEqual(metadata.dependencies, {});
const wire = await getCurrentFuseWire(binary);
const disabled = ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'GrantFileProtocolExtraPrivileges'];
const enabled = ['EnableCookieEncryption', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar'];
for (const name of disabled) assert.equal(wire[FuseV1Options[name]], 48, `${name} must be disabled`);
for (const name of enabled) assert.equal(wire[FuseV1Options[name]], 49, `${name} must be enabled`);
await readFile(path.join(directory, 'LICENSE.electron.txt'));
await readFile(path.join(directory, 'LICENSES.chromium.html'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const tarball = path.join(root, 'release/desktop/video-workbench-0.3.0-linux-x64.tar.gz');
const exec = promisify(execFile);
await exec('gzip', ['-t', tarball]);
const { stdout: archivedAsar } = await exec('tar', ['-xOzf', tarball, 'video-workbench-0.3.0-linux-x64/resources/app.asar'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
assert.deepEqual(archivedAsar, await readFile(archive), 'Delivered tarball ASAR must match the native-tested app');
const tarBytes = await readFile(tarball);
const binarySha256 = sha256(await readFile(binary));
const archivedBinarySha256 = await new Promise((resolve, reject) => {
  const child = spawn('tar', ['-xOzf', tarball, 'video-workbench-0.3.0-linux-x64/video-workbench'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const hash = createHash('sha256');
  child.stdout.on('data', bytes => hash.update(bytes));
  child.stderr.resume();
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(hash.digest('hex')) : reject(new Error(`Archive binary extraction failed (${code})`)));
});
assert.equal(archivedBinarySha256, binarySha256, 'Delivered tarball executable must match the native-tested app');
const report = { ok: true, platform: 'linux-x64', asarEntries: files.length, noNodeModules: true, noSymlinks: true,
  noProjectDataOrCredentials: true, bundledDependencies: true, packagedFilesMatchVerifiedStaging: true,
  fuses: { disabled, enabled, integrityPlatformNote: 'Embedded ASAR integrity validation is supported on macOS/Windows; Linux is not a signed/tamper-proof release.' },
  electronNoticesPresent: true, shadcnLicensePresent: true,
  asarSha256: sha256(await readFile(archive)), binarySha256,
  tarballSha256: sha256(tarBytes), tarballBytes: tarBytes.length, gzipVerified: true, archivedAsarMatchesNativePackage: true,
  archivedBinaryMatchesNativePackage: true,
  rendererFiles: files.filter(file => file.startsWith('/web/assets/')), files };
const output = path.join(root, 'evidence/v3-desktop/package-inspection.json');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, files: undefined, reportFile: output }, null, 2));
