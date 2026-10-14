import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {transformSync} from 'esbuild';
import {mediaEnvironment} from '../packages/business/src/media-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceName = 'packages/contracts/src/agent-protocol.ts';
const shimName = 'packages/contracts/src/agent-protocol.mjs';
const consumerName = 'tests/typecheck/agent-protocol.consumer.mts';
const configName = 'tests/typecheck/tsconfig.foundation.json';

// Exact implementation from 8552803c1fb6ade99b6f6ee8f4d6ec8a80764b5c.
// Keep independent of the migrated source so changing runtime statements fails.
const frozenBaselineSource = [
  "// Browser-safe protocol vocabulary. This module never performs I/O, selects a",
  "// provider, or infers a protocol from a model, URL, or failed request.",
  "export const AGENT_PROTOCOLS = Object.freeze({",
  "  chat_completions: Object.freeze({label: 'Chat Completions', path: '/chat/completions'}),",
  "  responses: Object.freeze({label: 'Responses', path: '/responses'}),",
  "});",
  "",
  "/** Derive a fixed request endpoint from already-canonical configuration. This is",
  " * not destination authorization: backend configuration and network policy must",
  " * still validate the provider, local scope, DNS answers and connection peer. */",
  "export function deriveAgentEndpoint(configuration) {",
  "  const protocol = configuration?.protocol, baseUrl = configuration?.baseUrl;",
  "  if (typeof protocol !== 'string' || !Object.hasOwn(AGENT_PROTOCOLS, protocol) ||",
  "      typeof baseUrl !== 'string' || !baseUrl || baseUrl.length > 2048 ||",
  "      /[\\s\\\\%?#@\\u0000-\\u001f\\u007f-\\u009f]/u.test(baseUrl)) throw new TypeError('Invalid Agent endpoint configuration');",
  "  let url;",
  "  try { url = new URL(baseUrl); } catch { throw new TypeError('Invalid Agent endpoint configuration'); }",
  "  const pathname = url.pathname.replace(/\\/+$/, '');",
  "  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||",
  "      (pathname && (!/^\\/[A-Za-z0-9/_~.\\-]*$/.test(pathname) || /\\/{2}|(?:^|\\/)\\.{1,2}(?:\\/|$)/.test(pathname))) ||",
  "      `${url.origin}${pathname}` !== baseUrl) throw new TypeError('Invalid Agent endpoint configuration');",
  "  return `${baseUrl}${AGENT_PROTOCOLS[protocol].path}`;",
  "}",
  '',
].join('\n');

function executableSource(source, loader) {
  // Parse real source, remove comments/types, and print without bundling or
  // minification. This compares executable structure rather than source spelling.
  return transformSync(source, {loader, target: 'es2022', format: 'esm',
    legalComments: 'none', minify: false, sourcemap: false, treeShaking: false}).code;
}

test('typed protocol preserves the frozen baseline executable and explicit compatibility exports', async () => {
  assert.equal(createHash('sha256').update(frozenBaselineSource).digest('hex'), 'd83f1f42d8a46c0740179a86a927e88a8288568942ae3dc10de44e3342e2e673');
  const source = await readFile(path.join(root, sourceName), 'utf8');
  const shim = await readFile(path.join(root, shimName), 'utf8');
  assert.equal(executableSource(source, 'ts'), executableSource(frozenBaselineSource, 'js'));
  assert.equal(executableSource(shim, 'js'), executableSource(
    "export {AGENT_PROTOCOLS, deriveAgentEndpoint} from './agent-protocol.ts';", 'js'));
  assert.doesNotMatch(source, /@ts-(?:ignore|nocheck|expect-error)\b|\bany\b/);
  const barrel = await readFile(path.join(root, 'packages/contracts/src/index.mjs'), 'utf8');
  assert.ok(barrel.includes("export {AGENT_PROTOCOLS, deriveAgentEndpoint} from './agent-protocol.mjs';"));
});

test('native Node package barrel, compatibility module and real TS implementation share identity', async () => {
  const direct = await import('../packages/contracts/src/agent-protocol.ts');
  const compatibility = await import('../packages/contracts/src/agent-protocol.mjs');
  const barrel = await import('@mioon/contracts');
  assert.deepEqual(Object.keys(direct).sort(), ['AGENT_PROTOCOLS', 'deriveAgentEndpoint']);
  assert.deepEqual(Object.keys(compatibility).sort(), Object.keys(direct).sort());
  for (const entry of [compatibility, barrel]) {
    assert.equal(entry.AGENT_PROTOCOLS, direct.AGENT_PROTOCOLS);
    assert.equal(entry.deriveAgentEndpoint, direct.deriveAgentEndpoint);
  }
  assert.ok(Object.isFrozen(direct.AGENT_PROTOCOLS));
  for (const [protocol, definition] of Object.entries(direct.AGENT_PROTOCOLS)) {
    assert.ok(Object.isFrozen(definition));
    assert.equal(direct.deriveAgentEndpoint({protocol, baseUrl: 'https://api.example.com/v1'}),
      `https://api.example.com/v1${definition.path}`);
  }
  for (const configuration of [undefined, null, {}, {protocol: 'auto', baseUrl: 'https://api.example.com/v1'},
    {protocol: 'responses', baseUrl: 123}, {protocol: 'responses', baseUrl: 'https://api.example.com/v1/'},
    {protocol: '__proto__', baseUrl: 'https://api.example.com/v1'}]) {
    assert.throws(() => direct.deriveAgentEndpoint(configuration), TypeError);
  }
});

test('foundation configuration strictly checks the real contract and automatically admits new non-browser TS', async () => {
  const configuration = JSON.parse(await readFile(path.join(root, configName), 'utf8'));
  assert.deepEqual(configuration.files, [
    '../../packages/contracts/src/agent-protocol.ts',
    '../../packages/contracts/src/agent-protocol.mjs',
    './agent-protocol.consumer.mts',
    './agent-timeline-gain.consumer.mts',
    './export-sample-peak.consumer.mts',
    './float-checked-export.consumer.mts',
    './native-close.consumer.mts',
    './timeline-audio-preview.consumer.mts',
    './export-loudness.consumer.mts',
  ]);
  assert.deepEqual(configuration.include, ['../../packages/*/src/**/*.ts', '../../apps/*/src/**/*.ts']);
  assert.deepEqual(configuration.exclude, ['../../packages/ui/**', '../../apps/web/**']);
  assert.equal(configuration.extends, undefined);
  const options = configuration.compilerOptions;
  for (const flag of ['strict', 'allowJs', 'checkJs', 'noEmit', 'allowImportingTsExtensions',
    'erasableSyntaxOnly', 'verbatimModuleSyntax', 'isolatedModules', 'forceConsistentCasingInFileNames']) {
    assert.equal(options[flag], true, `${flag} must remain enabled`);
  }
  assert.equal(options.skipLibCheck, false);
  assert.equal(options.target, 'ES2022');
  assert.equal(options.module, 'NodeNext');
  assert.equal(options.moduleResolution, 'NodeNext');
  assert.deepEqual(options.lib, ['ES2022', 'DOM']);
  assert.deepEqual(options.types, ['node']);
  assert.equal(options.paths, undefined);
});

async function localCompiler() {
  // Resolve only the declared repository-local compiler. No global tsc, PATH,
  // package-manager shim, downloader, or ambient compiler can make this green.
  const declared = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(declared.devDependencies.typescript, '6.0.3');
  const modules = await realpath(path.join(root, 'node_modules'));
  const repository = await realpath(root);
  const isInside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  assert.ok(isInside(repository, modules), 'node_modules must be repository-local');
  const packageFile = await realpath(path.join(root, 'node_modules/typescript/package.json'));
  assert.ok(isInside(modules, packageFile), 'TypeScript package must be repository-local');
  const installed = JSON.parse(await readFile(packageFile, 'utf8'));
  assert.equal(installed.name, 'typescript');
  assert.equal(installed.version, declared.devDependencies.typescript);
  assert.equal(installed.bin.tsc, './bin/tsc');
  const entry = await realpath(path.join(path.dirname(packageFile), 'bin/tsc'));
  assert.ok(isInside(path.dirname(packageFile), entry), 'Compiler entry must belong to the verified package');
  return entry;
}

async function snapshotFiles(directory) {
  const snapshot = {};
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(await snapshotFiles(file))) snapshot[path.join(entry.name, name)] = hash;
    } else {
      assert.ok(entry.isFile(), 'The isolated compiler fixture contains only directories and regular files');
      snapshot[entry.name] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  return snapshot;
}

async function compileWithoutEmitting(directory, compiler) {
  const before = await snapshotFiles(directory);
  const result = spawnSync(process.execPath, [compiler, '--project', path.join(directory, configName), '--pretty', 'false', '--noEmit'], {
    cwd: directory, env: {...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER: '0'},
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.deepEqual(await snapshotFiles(directory), before, 'noEmit must not create or modify any fixture file');
  return result;
}

test('genuine compiler checks copied real source, fails an unsuppressed source mutation, and recovers without emit', async t => {
  const compiler = await localCompiler();
  // Keep this owned temporary copy beneath the repository so real @types/node
  // and its dependencies resolve normally from the pinned local installation.
  // The existing ignored evidence directory keeps the fixture out of staging.
  // Remove only this newly created directory, including on compilation failure.
  const temporaryParent = path.join(await realpath(root), 'evidence');
  await mkdir(temporaryParent, {recursive: true, mode: 0o700});
  const directory = await mkdtemp(path.join(temporaryParent, 'typecheck-test-中-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const name of [sourceName, shimName, consumerName,
    'tests/typecheck/agent-timeline-gain.consumer.mts', 'tests/typecheck/export-sample-peak.consumer.mts',
    'tests/typecheck/export-loudness.consumer.mts', 'packages/contracts/src/export-loudness.ts',
    'tests/typecheck/float-checked-export.consumer.mts', 'packages/contracts/src/timeline-export-float.ts',
    'tests/typecheck/native-close.consumer.mts', 'apps/desktop/src/native-close.ts',
    'tests/typecheck/timeline-audio-preview.consumer.mts', 'packages/contracts/src/timeline-audio-preview.ts', 'packages/contracts/src/timeline-segments.ts',
    'packages/contracts/src/native-audio-preview.ts', 'apps/desktop/src/native-audio-preview-protocol.ts',
    'apps/desktop/src/native-audio-preview-host.ts', 'apps/desktop/src/native-audio-preview-broker.ts', 'apps/desktop/src/native-audio-preview-preload.ts',
    'apps/desktop/src/project-window-host.ts', 'apps/desktop/src/project-window-protocol.ts', 'apps/desktop/src/project-window-preload.ts',
    'packages/contracts/src/agent-timeline-gain.ts', 'packages/contracts/src/export-sample-peak.ts',
    'packages/contracts/src/timeline-delivery.ts', 'packages/contracts/src/timeline-export-range.ts',
    'packages/contracts/src/local-delivery.ts',
    configName, 'packages/contracts/package.json']) {
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), {recursive: true});
    await writeFile(destination, await readFile(path.join(root, name)));
  }
  // Like @types/node, the desktop consumer resolves the real repository-local
  // Electron declarations. Its relative native-close import uses this copy.
  // The sample-peak consumer checks the public package subpath. Resolve it to
  // these real copied sources, never the ancestor working-tree workspace link.
  // Copy the installed Zod dependency unchanged so its genuine declarations are
  // checked too. Regular-file copies keep the noEmit snapshot fully observable.
  await cp(path.join(directory, 'packages/contracts'), path.join(directory, 'node_modules/@mioon/contracts'), {recursive: true});
  await cp(await realpath(path.join(root, 'packages/contracts/node_modules/zod')),
    path.join(directory, 'node_modules/zod'), {recursive: true});
  const good = await compileWithoutEmitting(directory, compiler);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.equal(good.stdout + good.stderr, '');

  const file = path.join(directory, sourceName);
  const source = await readFile(file, 'utf8');
  const original = 'deriveAgentEndpoint(configuration: AgentEndpointConfiguration): string {';
  assert.equal(source.split(original).length, 2, 'The mutation must target exactly the real function signature');
  await writeFile(file, source.replace(original, 'deriveAgentEndpoint(configuration: AgentEndpointConfiguration): number {'));
  const bad = await compileWithoutEmitting(directory, compiler);
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.match(bad.stdout + bad.stderr, /agent-protocol\.ts\(\d+,\d+\): error TS2322:/,
    'The compiler must diagnose the actual implementation return, not just a synthetic fixture');

  await writeFile(file, source);
  const recovered = await compileWithoutEmitting(directory, compiler);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(recovered.stdout + recovered.stderr, '');

  // Prove the public-subpath consumer resolves the isolated package copy. The
  // original workspace and the relative-source copy retain this real export.
  const publicFile = path.join(directory, 'node_modules/@mioon/contracts/src/export-sample-peak.ts');
  const publicSource = await readFile(publicFile, 'utf8');
  const publicExport = 'export const EXPORT_SAMPLE_PEAK_ALGORITHM =';
  assert.equal(publicSource.split(publicExport).length, 2, 'The mutation must target exactly the real public export');
  await writeFile(publicFile, publicSource.replace(publicExport, 'const EXPORT_SAMPLE_PEAK_ALGORITHM ='));
  const missingExport = await compileWithoutEmitting(directory, compiler);
  assert.equal(missingExport.status, 2, missingExport.stdout + missingExport.stderr);
  assert.match(missingExport.stdout + missingExport.stderr,
    /export-sample-peak\.consumer\.mts\(\d+,\d+\): error TS2724: [^\n]*EXPORT_SAMPLE_PEAK_ALGORITHM/,
    'The real public-subpath consumer must fail when its isolated copied module stops exporting the algorithm');

  await writeFile(publicFile, publicSource);
  const publicRecovered = await compileWithoutEmitting(directory, compiler);
  assert.equal(publicRecovered.status, 0, publicRecovered.stdout + publicRecovered.stderr);
  assert.equal(publicRecovered.stdout + publicRecovered.stderr, '');
});
