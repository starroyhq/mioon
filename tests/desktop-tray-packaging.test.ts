import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {finished} from 'node:stream/promises';
import type {Writable} from 'node:stream';
import {createRequire} from 'node:module';
import {TRAY_RESOURCE_FILES, stageTrayResources, verifyPackagedTrayResources} from '../apps/desktop/tray-resources.ts';

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve('electron-builder'));
const libraries = createRequire(builder.resolve('app-builder-lib'));
const asar = libraries('@electron/asar') as {
  createPackage(source: string, destination: string): Promise<Writable>;
  listPackage(file: string): string[];
  statFile(file: string, entry: string, follow: false): {link?: string; files?: unknown};
  extractFile(file: string, entry: string): Buffer;
};
const readSource = (relative: string) => readFile(new URL(relative, import.meta.url), 'utf8');

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-tray-package-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = path.join(directory, 'source'), staging = path.join(directory, 'staging'), input = path.join(directory, 'archive-input');
  await mkdir(source);
  for (const name of TRAY_RESOURCE_FILES) await writeFile(path.join(source, name), Buffer.from(`synthetic final resource: ${name}`));
  // Real source folders also contain documentation and generation inputs. None
  // of these are runtime resources, even when their extension looks like PNG.
  for (const name of ['README.md', 'manifest.json', 'body-master.png', 'imagegen-diagnostic.png']) await writeFile(path.join(source, name), 'synthetic source only');
  await stageTrayResources(source, path.join(staging, 'icons/tray'));
  await cp(staging, input, {recursive: true});
  let serial = 0;
  return {source, staging, input,
    async pack() {
      const archive = path.join(directory, `package-${++serial}.asar`);
      // The pinned ASAR 3.x API resolves with out.end(), before the archive's
      // final buffered writes finish. Inspection must wait for that real stream.
      const output = await asar.createPackage(input, archive); await finished(output);
      return archive;
    },
  };
}

test('desktop staging copies only the five fixed-name final tray images, preserving both density representations', async t => {
  const f = await fixture(t), output = path.join(f.staging, 'icons/tray');
  assert.deepEqual(TRAY_RESOURCE_FILES, ['trayTemplate.png', 'trayTemplate@2x.png', 'tray.ico', 'tray-color.png', 'tray-color@2x.png']);
  assert.deepEqual((await readdir(output)).sort(), [...TRAY_RESOURCE_FILES].sort());
  for (const name of TRAY_RESOURCE_FILES) assert.deepEqual(await readFile(path.join(output, name)), await readFile(path.join(f.source, name)));
  await rm(path.join(f.source, 'trayTemplate@2x.png'));
  await assert.rejects(stageTrayResources(f.source, path.join(f.staging, 'missing-density')));
});

test('the delivered real ASAR contains every runtime tray image with the verified staging bytes', async t => {
  const f = await fixture(t), archive = await f.pack();
  await verifyPackagedTrayResources(archive, asar, f.staging);
  assert.deepEqual(asar.listPackage(archive).filter(name => name.startsWith('/icons/tray/')).sort(), TRAY_RESOURCE_FILES.map(name => `/icons/tray/${name}`).sort());
});

for (const name of TRAY_RESOURCE_FILES) test(`real ASAR inspection rejects an omitted ${name} even if the other densities exist`, async t => {
  const f = await fixture(t);
  await rm(path.join(f.input, 'icons/tray', name));
  await assert.rejects(verifyPackagedTrayResources(await f.pack(), asar, f.staging));
});

for (const name of TRAY_RESOURCE_FILES) test(`real ASAR inspection rejects changed bytes in ${name}`, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.input, 'icons/tray', name), 'synthetic replaced icon');
  await assert.rejects(verifyPackagedTrayResources(await f.pack(), asar, f.staging), /must equal verified staging/u);
});

for (const name of ['README.md', 'manifest.json', 'body-master.png', 'diagnostics/candidate.png']) test(`real ASAR inspection rejects accidentally packaged tray source ${name}`, async t => {
  const f = await fixture(t), file = path.join(f.input, 'icons/tray', name);
  await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, 'synthetic source only');
  // Even matching staging cannot make an extra source or diagnostic admissible.
  const staged = path.join(f.staging, 'icons/tray', name);
  await mkdir(path.dirname(staged), {recursive: true}); await writeFile(staged, 'synthetic source only');
  await assert.rejects(verifyPackagedTrayResources(await f.pack(), asar, f.staging), /Unexpected packaged tray resource/u);
});

test('a required image cannot be replaced by an empty ASAR directory', async t => {
  const f = await fixture(t), file = path.join(f.input, 'icons/tray/tray.ico');
  await rm(file); await mkdir(file);
  await assert.rejects(verifyPackagedTrayResources(await f.pack(), asar, f.staging), /must be regular files/u);
});

test('both current package inspectors use delivered tray validation while the frozen historical V3 branch does not', async () => {
  const build = await readSource('../apps/desktop/scripts/build.ts');
  assert.match(build, /await stageTrayResources\(path\.join\(desktop, 'resources\/tray'\), path\.join\(output, 'icons\/tray'\)\)/u);
  assert.doesNotMatch(build, /cp\([^\n]*'resources\/tray'[^\n]*recursive/u);
  const local = await readSource('../apps/desktop/scripts/inspect-package.ts');
  const guard = local.match(/^if \(!historicalV3\) await verifyPackagedTrayResources\(archive, asar, path\.join\(root, 'apps\/desktop\/build'\)\);$/mu)?.[0];
  assert.ok(guard);
  const run = Function('historicalV3', 'verifyPackagedTrayResources', 'archive', 'asar', 'path', 'root', `return (async () => { ${guard} })();`) as
    (historical: boolean, verify: (...args: unknown[]) => Promise<void>, archive: string, archiveAPI: unknown, paths: typeof path, root: string) => Promise<void>;
  const calls: unknown[][] = [], verify = async (...args: unknown[]) => { calls.push(args); };
  await run(true, verify, '/synthetic/historical.asar', asar, path, '/synthetic/root'); assert.equal(calls.length, 0);
  await run(false, verify, '/synthetic/current.asar', asar, path, '/synthetic/root');
  assert.deepEqual(calls, [['/synthetic/current.asar', asar, '/synthetic/root/apps/desktop/build']]);
  const ci = await readSource('../.github/scripts/inspect-desktop.ts');
  const phaseGuard = ci.match(/^  await run\('tray-resources', \(\) => verifyPackagedTrayResources\(archive, asar, path\.join\(root, 'apps\/desktop\/build'\)\)\);$/mu)?.[0];
  assert.ok(phaseGuard);
  const runCI = Function('run', 'verifyPackagedTrayResources', 'archive', 'asar', 'path', 'root', `return (async () => { ${phaseGuard} })();`) as
    (phase: (name: string, action: () => Promise<void>) => Promise<void>, verify: (...args: unknown[]) => Promise<void>, archive: string, archiveAPI: unknown, paths: typeof path, root: string) => Promise<void>;
  const phases: string[] = []; calls.length = 0;
  const phase = async (name: string, action: () => Promise<void>) => { phases.push(name); await action(); };
  await runCI(phase, verify, '/synthetic/current.asar', asar, path, '/synthetic/root');
  assert.deepEqual(phases, ['tray-resources']);
  assert.deepEqual(calls, [['/synthetic/current.asar', asar, '/synthetic/root/apps/desktop/build']]);
  const failure = new Error('synthetic tray verification failure');
  await assert.rejects(runCI(phase, async () => { throw failure; }, '/synthetic/current.asar', asar, path, '/synthetic/root'), failure);
});
