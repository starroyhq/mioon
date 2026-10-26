import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {mkdtemp, realpath, mkdir, writeFile, readFile, rm, rename, symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArguments, installedTypeScript, typecheckCommands, verifySourceLanguages, executeCommand, toolingEnvironment} from '../scripts/lib/local-tooling.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '6.0.3';
const metadata = {name: 'typescript', version, bin: {tsc: './bin/tsc', tsserver: './bin/tsserver'}};
const projects = ['tests/typecheck/tsconfig.foundation.json', 'tests/typecheck/tsconfig.browser.json', 'tests/tsconfig.tests.json'];
const directoryLink = (target: string, link: string) => symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

async function fixture(t: TestContext, compiler = "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n") {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon typecheck 中 '));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = async (name: string, contents: string) => {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, contents);
  };
  const json = (name: string, value: unknown) => file(name, JSON.stringify(value));
  await json('package.json', {type: 'module', devDependencies: {typescript: version}});
  await json('config/typecheck-legacy-sources.json', []);
  await json('node_modules/typescript/package.json', metadata);
  // Only the verified lib entry should run; this bin is inspected, not invoked.
  await file('node_modules/typescript/bin/tsc', "throw Error('UNEXPECTED_BIN_EXECUTION');\n");
  await file('node_modules/typescript/lib/tsc.js', compiler);
  await file('node_modules/typescript/lib/_tsc.js', '// Synthetic implementation; the official tsc.js shim requires this file.\n');
  return {directory, file, json};
}

async function fixtureCli(t: TestContext, compiler = "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n") {
  const state = await fixture(t, compiler);
  await state.file('scripts/tooling.ts', await readFile(path.join(root, 'scripts/tooling.ts'), 'utf8'));
  await directoryLink(path.join(root, 'scripts/lib'), path.join(state.directory, 'scripts/lib'));
  return state;
}

function runCli(directory: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, ['scripts/tooling.ts', ...args], {
    cwd: directory, env: toolingEnvironment(), encoding: 'utf8', timeout: 10000, shell: false, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test('typecheck accepts no channels, selections, duplicates, project overrides or passthrough arguments', () => {
  assert.equal(parseArguments(['typecheck']).command, 'typecheck');
  for (const flags of [
    ['--channel=development'], ['--suite=portable'], ['--file=agent-protocol.test.mjs'], ['--concurrency=1'], ['--native-ready'],
    ['--project=other.json'], ['--project', 'other.json'], ['--pretty=false'], ['--max-old-space-size=8192'], ['--'], ['--', '--help'], ['--noEmit', '--noEmit'], ['exec'],
  ]) assert.throws(() => parseArguments(['typecheck', ...flags]), {code: 'TOOLING_USAGE'});
});

test('local TypeScript requires the exact declared metadata and reviewed JavaScript entry paths', async t => {
  const {directory} = await fixture(t);
  assert.deepEqual(await installedTypeScript(directory), {version, entry: path.join(directory, 'node_modules/typescript/lib/tsc.js')});
  assert.deepEqual(await typecheckCommands(directory), projects.map(project => ({command: process.execPath,
    args: ['--max-old-space-size=4096', path.join(directory, 'node_modules/typescript/lib/tsc.js'), '--project', project, '--noEmit', '--pretty', 'false'], cwd: directory})));
});

test('normal pnpm package links remain within the repository and use the canonical compiler entry', async t => {
  const {directory} = await fixture(t);
  const linked = path.join(directory, 'node_modules/typescript');
  const canonical = path.join(directory, 'node_modules/.pnpm/typescript@6.0.3/node_modules/typescript');
  await mkdir(path.dirname(canonical), {recursive: true});
  await rename(linked, canonical);
  await directoryLink(canonical, linked);
  assert.equal((await installedTypeScript(directory)).entry, path.join(canonical, 'lib/tsc.js'));
});

test('missing local compiler fails without an ancestor, global or package-manager fallback', async t => {
  const {directory} = await fixture(t);
  await rm(path.join(directory, 'node_modules/typescript'), {recursive: true});
  await assert.rejects(installedTypeScript(directory), {code: 'TYPECHECK_DEPENDENCY_INVALID'});
  await rm(path.join(directory, 'node_modules'), {recursive: true});
  await assert.rejects(installedTypeScript(directory), {code: 'TYPECHECK_DEPENDENCY_MISSING'});
});

test('declaration ranges, missing declarations, package substitutions and wrong bin metadata fail closed', async t => {
  const {directory, json} = await fixture(t);
  for (const declared of [undefined, '^6.0.3', 'latest', '06.0.3', '6.0.3-rc..1']) {
    await json('package.json', {devDependencies: {typescript: declared}});
    await assert.rejects(installedTypeScript(directory), {code: 'TYPECHECK_DEPENDENCY_INVALID'});
  }
  await json('package.json', {type: 'module', devDependencies: {typescript: version}});
  for (const installed of [
    {...metadata, name: '@typescript/native-preview'}, {...metadata, version: '6.0.2'},
    {...metadata, bin: {tsc: '../../outside.js'}}, {...metadata, bin: {tsc: 'lib/tsc.js'}}, {...metadata, bin: 'bin/tsc'}, {...metadata, bin: {tsc: 'bin/tsc'}},
  ]) {
    await json('node_modules/typescript/package.json', installed);
    await assert.rejects(installedTypeScript(directory), {code: 'TYPECHECK_DEPENDENCY_INVALID'});
  }
});

test('outside node_modules and outside package links cannot become verified local compilers', async t => {
  const local = await fixture(t), outside = await fixture(t);
  await rm(path.join(local.directory, 'node_modules'), {recursive: true});
  await directoryLink(path.join(outside.directory, 'node_modules'), path.join(local.directory, 'node_modules'));
  await assert.rejects(installedTypeScript(local.directory), {code: 'TYPECHECK_DEPENDENCY_INVALID'});
  await rm(path.join(local.directory, 'node_modules'), {recursive: true});
  await mkdir(path.join(local.directory, 'node_modules'));
  await directoryLink(path.join(outside.directory, 'node_modules/typescript'), path.join(local.directory, 'node_modules/typescript'));
  await assert.rejects(installedTypeScript(local.directory), {code: 'TYPECHECK_DEPENDENCY_INVALID'});
});

test('missing or non-file bin and compiler entries are rejected before execution', async t => {
  for (const entry of ['bin/tsc', 'lib/tsc.js', 'lib/_tsc.js']) {
    const {directory} = await fixture(t);
    const target = path.join(directory, 'node_modules/typescript', entry);
    await rm(target);
    await assert.rejects(installedTypeScript(directory), {code: 'TYPECHECK_DEPENDENCY_INVALID'});
    await mkdir(target);
    await assert.rejects(installedTypeScript(directory), {code: 'TYPECHECK_DEPENDENCY_INVALID'});
  }
});

test('entry directory links to outside or alternative in-package locations fail canonical layout checks', async t => {
  for (const relative of ['bin', 'lib']) {
    const local = await fixture(t), outside = await fixture(t);
    const entry = path.join(local.directory, 'node_modules/typescript', relative);
    const alternate = `${entry}-alternate`;
    await rename(entry, alternate);
    await directoryLink(alternate, entry);
    await assert.rejects(installedTypeScript(local.directory), {code: 'TYPECHECK_DEPENDENCY_INVALID'});
    await rm(entry, {recursive: true});
    await directoryLink(path.join(outside.directory, 'node_modules/typescript', relative), entry);
    await assert.rejects(installedTypeScript(local.directory), {code: 'TYPECHECK_DEPENDENCY_INVALID'});
  }
});

test('runtime JavaScript paths are rejected while .ts/.tsx source is accepted', async t => {
  const {directory, file, json} = await fixture(t);
  await json('config/typecheck-legacy-sources.json', []);
  await verifySourceLanguages(directory);
  for (const extension of ['js', 'jsx', 'mjs', 'cjs']) {
    const relative = `apps/web/src/new-feature.${extension}`;
    await file(relative, '');
    await assert.rejects(verifySourceLanguages(directory), {code: 'TYPECHECK_NEW_JAVASCRIPT'});
    await rm(path.join(directory, relative));
  }
  await file('apps/web/src/new-feature.tsx', '');
  await file('packages/contracts/src/new-feature.ts', '');
  await verifySourceLanguages(directory);
});

test('missing, duplicate, non-empty and escaping allowlists cannot disable the language guard', async t => {
  const {directory, json} = await fixture(t);
  for (const policy of [{}, ['apps/server/src/index.ts'], ['apps/server/src/index.ts', 'apps/server/src/index.ts'], ['../outside.js'], ['apps/server/src/../outside.js']]) {
    await json('config/typecheck-legacy-sources.json', policy);
    await assert.rejects(verifySourceLanguages(directory), {code: 'TYPECHECK_SOURCE_POLICY_INVALID'});
  }
  await rm(path.join(directory, 'config/typecheck-legacy-sources.json'));
  await assert.rejects(verifySourceLanguages(directory), {code: 'TYPECHECK_SOURCE_POLICY_INVALID'});
});

test('runtime TSX outside the browser and unchecked alternate TypeScript extensions are rejected', async t => {
  const {directory, file} = await fixture(t);
  for (const [relative, code] of [
    ['apps/server/src/new-view.tsx', 'TYPECHECK_UNSUPPORTED_TSX'],
    ['packages/contracts/src/new-view.tsx', 'TYPECHECK_UNSUPPORTED_TSX'],
    ['apps/server/src/new-feature.mts', 'TYPECHECK_SOURCE_POLICY_INVALID'],
    ['apps/server/src/new-feature.cts', 'TYPECHECK_SOURCE_POLICY_INVALID'],
  ]) {
    await file(relative, '');
    await assert.rejects(verifySourceLanguages(directory), {code});
    await rm(path.join(directory, relative));
  }
});

test('fixed compiler projects cover all runtime TypeScript without legacy browser exclusions', async () => {
  const foundation = JSON.parse(await readFile(path.join(root, projects[0]), 'utf8'));
  const browser = JSON.parse(await readFile(path.join(root, projects[1]), 'utf8'));
  const testsProject = JSON.parse(await readFile(path.join(root, projects[2]), 'utf8'));
  assert.deepEqual(foundation.include, ['../../.github/scripts/**/*.ts', '../../packages/*/src/**/*.ts', '../../apps/*/src/**/*.ts', '../../apps/desktop/*.ts', '../../apps/desktop/scripts/**/*.ts', '../../server/**/*.ts', '../../scripts/**/*.ts']);
  assert.deepEqual(foundation.exclude, ['../../packages/ui/**', '../../apps/web/**']);
  assert.deepEqual(browser.include, ['../../packages/ui/src/**/*.ts', '../../packages/ui/src/**/*.tsx', '../../apps/web/src/**/*.ts', '../../apps/web/src/**/*.tsx', 'browser.consumer.tsx', 'export-sample-peak.consumer.tsx', 'desktop-launcher.consumer.tsx', 'timeline-audio-preview.consumer.tsx', 'export-loudness.consumer.tsx', 'timeline-mix-loudness.consumer.tsx', 'timeline-clip-loudness.consumer.tsx', 'timeline-loudness-apply.consumer.tsx']);
  assert.deepEqual(browser.exclude, []);
  assert.deepEqual(testsProject.include, ['./**/*.ts', './**/*.tsx', '../apps/web/src/style-modules.d.ts']);
  // Frozen historical evidence fixtures stay excluded; `.mjs`-sourced helper and
  // fixture modules are removed from this list as their owning test waves add
  // strict types.
  assert.ok(testsProject.exclude.includes('./typecheck/**'));
  assert.ok(testsProject.exclude.includes('./fixtures/workspace-restore-legacy/**'));
  assert.ok(testsProject.exclude.includes('./fixtures/workspace-restore-v27/legacy-contracts/**'));
  for (const config of [foundation, browser, testsProject]) {
    assert.equal(config.compilerOptions.strict, true); assert.equal(config.compilerOptions.noEmit, true);
    assert.equal(config.compilerOptions.erasableSyntaxOnly, true); assert.equal(config.compilerOptions.skipLibCheck, false);
  }
  assert.deepEqual(testsProject.compilerOptions.lib, ['ES2022', 'ES2023.Array', 'ES2024.Promise', 'ES2024.String', 'DOM', 'DOM.Iterable']);
  assert.equal(testsProject.compilerOptions.jsx, 'react-jsx');
  assert.deepEqual(testsProject.compilerOptions.types, ['node', 'react', 'react-dom']);
});

test('source symlink directories cannot hide new JavaScript from the language guard', async t => {
  const local = await fixture(t), outside = await fixture(t);
  await local.file('apps/web/src/existing.ts', '');
  await outside.file('unreviewed/new-feature.mjs', '');
  await directoryLink(path.join(outside.directory, 'unreviewed'), path.join(local.directory, 'apps/web/src/linked'));
  await assert.rejects(verifySourceLanguages(local.directory), {code: 'TYPECHECK_SOURCE_POLICY_INVALID'});
});

test('actual standalone typecheck CLI runs three fixed checks without application/build/media prerequisites', async t => {
  const {directory} = await fixtureCli(t);
  const result = runCli(directory, ['typecheck']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)),
    projects.map(project => ['--project', project, '--noEmit', '--pretty', 'false']));
});

test('actual compiler children use a fixed bounded heap without caller-provided Node options', async t => {
  const {directory} = await fixtureCli(t, "import {getHeapStatistics} from 'node:v8'; process.stdout.write(JSON.stringify({project:process.argv[3],execArgv:process.execArgv,heap:getHeapStatistics().heap_size_limit}) + '\\n');\n");
  const result = runCli(directory, ['typecheck']);
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as {project: string; execArgv: string[]; heap: number});
  assert.deepEqual(rows.map(row => row.project), projects);
  for (const row of rows) {
    assert.deepEqual(row.execArgv, ['--max-old-space-size=4096']);
    // V8 adds platform-dependent young-generation headroom to the old-space cap.
    assert.ok(row.heap >= 4096 * 1024 * 1024 && row.heap <= 4608 * 1024 * 1024, `compiler heap: ${row.heap}`);
  }
});

test('actual CLI rejects flags and invalid metadata without running a compiler', async t => {
  const {directory, json} = await fixtureCli(t, "process.stdout.write('COMPILER_RAN');\n");
  for (const args of [['typecheck', '--project=elsewhere.json'], ['typecheck', '--channel=production']]) {
    const result = runCli(directory, args);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'TOOLING_USAGE');
  }
  await json('node_modules/typescript/package.json', {...metadata, version: '6.0.2'});
  const result = runCli(directory, ['typecheck']);
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, 'TYPECHECK_DEPENDENCY_INVALID');
});

test('actual compiler failure propagates and prevents the second check', async t => {
  const {directory} = await fixtureCli(t, "process.stdout.write('first-check\\n'); process.exit(7);\n");
  const result = runCli(directory, ['typecheck']);
  assert.equal(result.status, 7); assert.equal(result.stdout, 'first-check\n'); assert.equal(result.stderr, '');
});

test('typecheck reuses the shell-free reduced environment and existing interruption outcomes', async t => {
  const {directory} = await fixture(t);
  const [spec] = await typecheckCommands(directory);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as Array<[NodeJS.Signals, number]>) {
    const source = new EventEmitter(), child = new EventEmitter() as EventEmitter & {kill: (value: string) => void};
    const killed: string[] = []; child.kill = (value: string) => killed.push(value);
    const result = executeCommand(spec, {signalSource: source as unknown as NodeJS.Process,
      env: toolingEnvironment({NODE_OPTIONS: '--require=untrusted', NODE_PATH: 'outside', HTTPS_PROXY: 'secret', MIOON_FFMPEG_PATH: 'outside'}),
      spawnChild: ((command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
        assert.equal(command, process.execPath); assert.deepEqual(args, spec.args);
        assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.stdio, 'inherit');
        assert.equal(options.env?.MIOON_ENABLE_LIVE_PROVIDER, '0');
        for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'HTTPS_PROXY', 'MIOON_FFMPEG_PATH']) assert.equal(options.env?.[key], undefined);
        return child;
      }) as never});
    source.emit(signal); child.emit('close', 0, null);
    assert.deepEqual(await result, {code, signal}); assert.deepEqual(killed, [signal]);
    assert.equal(source.listenerCount('SIGINT'), 0); assert.equal(source.listenerCount('SIGTERM'), 0);
  }
});

test('build command places both typechecks before the existing build command sequence', async () => {
  const source = await readFile(path.join(root, 'scripts/tooling.ts'), 'utf8');
  assert.match(source, /\[\.\.\.await typecheckCommands\(root\), \.\.\.buildCommands\(root, entries, options\.channel\)\]/);
  assert.doesNotMatch(source, /npm install|pnpm install|npx |tsgo|electron-builder/);
});
