import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, writeFile, rename, unlink, realpath, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import desktopBuildMetadata from '../apps/desktop/build-metadata.cjs';

const root = new URL('../', import.meta.url);
const clientFile = new URL('packages/client/src/index.ts', root);
const clientSource = await readFile(clientFile, 'utf8');
const applicationPackage = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

// Execute the actual production import/declaration in a synthetic source tree.
// This does not initialize the full client, CLI, MCP SDK or a desktop bundle.
function versionSlice() {
  const imports = [...clientSource.matchAll(/^import (\w+) from ['"]([^'"]+\/package\.json)['"] with\s*\{\s*type:\s*['"]json['"]\s*\};$/gm)];
  assert.equal(imports.length, 1, 'one static application-manifest import');
  const declaration = clientSource.match(/^export const VERSION = (\w+)\.version;$/m);
  assert.ok(declaration, 'VERSION must come from an imported manifest');
  assert.equal(declaration[1], imports[0][1]);
  assert.equal(new URL(imports[0][2], clientFile).href, new URL('package.json', root).href);
  return `${imports[0][0]}\n${declaration[0]}\n`;
}

async function fixture(t, manifest = applicationPackage) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-client-version-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const sourceRoot = path.join(directory, 'source');
  const cwd = path.join(directory, 'unrelated cwd');
  await mkdir(path.join(sourceRoot, 'packages/client/src'), {recursive: true});
  await mkdir(cwd);
  await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(sourceRoot, 'packages/client/package.json'), JSON.stringify({type: 'module', version: '88.0.0'}));
  await writeFile(path.join(sourceRoot, 'packages/client/src/index.ts'), versionSlice());
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({version: '99.0.0'}));
  return {directory, sourceRoot, cwd};
}

function runVersion(sourceRoot, cwd) {
  const moduleUrl = pathToFileURL(path.join(sourceRoot, 'packages/client/src/index.ts')).href;
  return spawnSync(process.execPath, ['--input-type=module', '--eval',
    `import {VERSION} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(VERSION));`],
  {cwd, env: {}, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024});
}

function assertVersion(result, expected) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), expected);
}

test('client version import resolves to the existing desktop application-version authority', () => {
  versionSlice();
  assert.equal(applicationPackage.version, desktopBuildMetadata.readBuildMetadata(fileURLToPath(root)).appVersion);
});

test('production version slice loads the current root manifest independently of cwd and client package version', async t => {
  const {sourceRoot, cwd} = await fixture(t);
  assertVersion(runVersion(sourceRoot, cwd), applicationPackage.version);
});

test('a root-only version update is reflected on the next process start, including prerelease and build metadata', async t => {
  const {sourceRoot, cwd} = await fixture(t, {version: '1.2.3', type: 'module'});
  assertVersion(runVersion(sourceRoot, cwd), '1.2.3');
  await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({version: '7.8.9-rc.2+build.01', type: 'module'}));
  assertVersion(runVersion(sourceRoot, cwd), '7.8.9-rc.2+build.01');
});

test('version resolution survives relocation of the complete synthetic source layout', async t => {
  const {directory, sourceRoot, cwd} = await fixture(t);
  const movedRoot = path.join(directory, '搬迁后的项目 with spaces');
  await rename(sourceRoot, movedRoot);
  assertVersion(runVersion(movedRoot, cwd), applicationPackage.version);
});

test('missing root manifest fails instead of falling back to cwd or client metadata', async t => {
  const {sourceRoot, cwd} = await fixture(t);
  await unlink(path.join(sourceRoot, 'package.json'));
  const result = runVersion(sourceRoot, cwd);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.equal(result.stdout, '');
});

test('source wiring keeps CLI, MCP, schema discovery and doctor on the shared VERSION export', async () => {
  const cli = await readFile(new URL('apps/cli/src/index.ts', root), 'utf8');
  const mcp = await readFile(new URL('apps/mcp/src/index.ts', root), 'utf8');
  for (const source of [cli, mcp]) {
    assert.ok(/import\s*\{[^}]*\bVERSION\b[^}]*\}\s*from\s*['"]@mioon\/client['"]/.test(source), 'consumer imports VERSION from the shared client');
  }
  assert.ok(/function help\(operation\)\s*\{\s*return\s*\{name:\s*'mioon',\s*version:\s*VERSION/.test(cli), 'CLI help uses VERSION');
  assert.ok(/if\s*\(options\.version\)\s*data\s*=\s*\{name:\s*'mioon',\s*version:\s*VERSION\}/.test(cli), 'CLI --version uses VERSION');
  assert.ok(/new Server\(\{name:\s*'mioon',\s*version:\s*VERSION\}/.test(mcp), 'MCP server metadata uses VERSION');
  assert.ok(/return parsed\.operation\s*\?[^;]+:\s*\{version:\s*VERSION,/.test(clientSource), 'schema discovery uses VERSION');
  assert.ok(/clientVersion:\s*VERSION,/.test(clientSource), 'doctor reports VERSION as clientVersion');
});

test('full client VERSION and schema discovery match the root when workspace dependencies are initialized', async t => {
  const require = createRequire(clientFile);
  const missing = [];
  for (const dependency of ['@mioon/contracts', 'zod', 'zod-to-json-schema']) {
    try { require.resolve(dependency); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      missing.push(dependency);
    }
  }
  if (missing.length) {
    t.skip(`Workspace dependencies are not initialized: ${missing.join(', ')}; full client was not imported`);
    return;
  }
  // Import/runtime errors after the explicit dependency preflight must fail.
  const client = await import(clientFile.href);
  assert.equal(client.VERSION, applicationPackage.version);
  assert.equal(client.discoverSchema().version, applicationPackage.version);
});

function hasRuntimeDependencies(t, dependencies) {
  const require = createRequire(clientFile);
  for (const dependency of dependencies) {
    try { require.resolve(dependency); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      t.skip(`Workspace dependency not initialized: ${dependency}; runtime check was not executed`);
      return false;
    }
  }
  return true;
}
const clientDependencies = ['@mioon/contracts', 'zod', 'zod-to-json-schema'];

test('actual CLI startup reports the application version from unrelated cwd without backend configuration', async t => {
  if (!hasRuntimeDependencies(t, clientDependencies)) return;
  const {cwd} = await fixture(t);
  for (const args of [['--version'], ['--help'], ['schema']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('apps/cli/src/index.ts', root)), ...args],
      {cwd, env: {}, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024});
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true); assert.equal(envelope.data.version, applicationPackage.version);
    if (args[0] === 'schema') assert.ok(envelope.data.operations.some(item => item.operation === 'image.task.observeRemote'));
  }
});

test('official MCP initialization separates application serverInfo from negotiated wire protocol', {timeout: 15_000}, async t => {
  if (!hasRuntimeDependencies(t, [...clientDependencies, '@modelcontextprotocol/sdk/client/index.js'])) return;
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport} = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const {SUPPORTED_PROTOCOL_VERSIONS} = await import('@modelcontextprotocol/sdk/types.js');
  const client = new Client({name: 'synthetic-client-version-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [fileURLToPath(new URL('apps/mcp/src/index.ts', root))], cwd: fileURLToPath(root),
    env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}, stderr: 'pipe'});
  let stderr = ''; transport.stderr.setEncoding('utf8').on('data', bytes => { stderr += bytes; });
  const messages = [];
  const wire = {
    onmessage: undefined, onerror: undefined, onclose: undefined,
    async start() {
      transport.onmessage = message => { messages.push(message); wire.onmessage?.(message); };
      transport.onerror = error => wire.onerror?.(error); transport.onclose = () => wire.onclose?.();
      await transport.start();
    },
    send: (message, options) => transport.send(message, options), close: () => transport.close(),
    get sessionId() { return transport.sessionId; },
  };
  t.after(() => client.close());
  await client.connect(wire);
  assert.deepEqual(client.getServerVersion(), {name: 'mioon', version: applicationPackage.version});
  const initialized = messages.find(message => message.result?.serverInfo)?.result;
  assert.ok(initialized); assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(initialized.protocolVersion));
  assert.match(initialized.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(initialized.protocolVersion, applicationPackage.version);
  const listing = await client.listTools();
  assert.ok(listing.tools.some(tool => tool.name === 'image_task_observeRemote'));
  const schema = await client.callTool({name: 'mioon_schema', arguments: {}});
  assert.equal(schema.isError, false); assert.equal(schema.structuredContent.data.version, applicationPackage.version);
  assert.equal(stderr, '');
});

test('doctor preserves distinct backend version rather than rewriting it to application identity', async t => {
  if (!hasRuntimeDependencies(t, clientDependencies)) return;
  const {createClient} = await import(clientFile.href);
  const calls = [];
  const client = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:45678', MIOON_TOKEN: 'synthetic-version-test-never-live'},
    fetchImpl: async (url, options) => {
      calls.push({url, method: options.method});
      if (url.endsWith('/health')) return new Response(JSON.stringify({ok: true, service: 'mioon', version: 'backend-compatibility-fixture', sqlite: true}));
      assert.equal(JSON.parse(options.body).operation, 'provider.list');
      return new Response(JSON.stringify({ok: true, data: []}));
    }});
  const result = await client.doctor();
  assert.equal(result.clientVersion, applicationPackage.version);
  assert.equal(result.backend.version, 'backend-compatibility-fixture');
  assert.deepEqual(calls.map(item => item.method), ['GET', 'POST']);
});
