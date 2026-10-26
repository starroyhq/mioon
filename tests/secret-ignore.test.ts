import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';

const SYNTHETIC_SECRET = 'synthetic-private-storage-packaging-sentinel-only';
const nonce = '0123456789abcdef0123456789abcdef';
const runtimeNames = [
  'access-token', 'desktop-token', 'mcp-token', 'server.lock', 'mcp-connection.json',
  'desktop-config.json', 'desktop-identity.json', 'credentials.json', 'secrets.json',
  'access-token.tmp', 'desktop-token.tmp', 'mcp-token.tmp', 'mcp-connection.json.tmp', 'desktop-config.json.tmp',
  `.access-token.${nonce}.tmp`, `.desktop-token.${nonce}.tmp`, `.mcp-token.${nonce}.tmp`,
  `.mcp-connection.json.${nonce}.tmp`, `.desktop-config.json.${nonce}.tmp`, `.desktop-identity.json.${nonce}.tmp`,
  'agent-settings/settings.json', `agent-settings/.settings-${nonce}.tmp`, `agent-settings/.settings.json.${nonce}.tmp`,
];

async function temporaryDirectory(t: test.TestContext, prefix: string) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), prefix));
  t.after(() => rm(root, {recursive:true, force:true}));
  return root;
}

async function writeFixture(root: string, file: string, contents: string|NodeJS.ArrayBufferView<ArrayBufferLike>|Iterable<string|NodeJS.ArrayBufferView<ArrayBufferLike>>|AsyncIterable<string|NodeJS.ArrayBufferView<ArrayBufferLike>>) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), {recursive:true, mode:0o700});
  await writeFile(target, contents, {mode:0o600});
}

test('git ignores exact runtime credential/discovery/settings fixtures at custom repository locations', async t => {
  const root = await temporaryDirectory(t, 'wb-secret-ignore-');
  await writeFixture(root, '.gitignore', await readFile(new URL('../.gitignore', import.meta.url), 'utf8'));
  await writeFixture(root, '.empty-excludes', '');
  // A fresh synthetic repository avoids reading the real index, credentials or
  // unrelated local files. No hooks, global ignores or user Git config apply.
  const env: NodeJS.ProcessEnv = {PATH:process.env.PATH, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:path.join(root, '.empty-excludes')};
  for (const key of ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const options = {cwd:root, encoding:'utf8' as const, env, timeout:10_000, maxBuffer:1024 * 1024};
  execFileSync('git', ['init', '--quiet', '--template='], options);
  const secretFiles = ['', 'local-profile/', 'apps/desktop/custom-user-data/'].flatMap(prefix => runtimeNames.map(name => prefix + name));
  const sourceFiles = [
    '.env.example', 'apps/server/.env.example', 'docs/mcp-token.md', 'packages/client/src/connection.ts',
    'tests/client-storage.test.mjs', 'tests/fixtures/mcp-connection.example.json', 'tests/fixtures/settings.json',
    'tests/fixtures/agent-settings/settings.example.json', 'tests/fixtures/source.tmp', 'apps/web/src/settings.js',
  ];
  for (const file of secretFiles) await writeFixture(root, file, SYNTHETIC_SECRET);
  for (const file of sourceFiles) await writeFixture(root, file, 'synthetic source fixture\n');
  const candidates = [...secretFiles, ...sourceFiles];
  const ignored = execFileSync('git', ['-c', `core.excludesFile=${path.join(root, '.empty-excludes')}`, '-c', 'core.ignoreCase=false',
    'check-ignore', '--no-index', '-z', '--stdin'], {...options, input:candidates.join('\0') + '\0'}).split('\0').filter(Boolean);
  assert.deepEqual(ignored.sort(), [...secretFiles].sort(), 'only the named runtime files should be ignored');
  const visible = execFileSync('git', ['-c', `core.excludesFile=${path.join(root, '.empty-excludes')}`,
    'ls-files', '--others', '--exclude-standard', '-z'], options).split('\0').filter(Boolean);
  for (const file of secretFiles) assert.equal(visible.includes(file), false, 'synthetic runtime secret must not enter the source file set');
  for (const file of sourceFiles) assert.equal(visible.includes(file), true, `source fixture remains eligible: ${file}`);
});

test('desktop packaging allowlist excludes synthetic custom userData without scanning real secrets or building', async t => {
  const root = await temporaryDirectory(t, 'wb-secret-package-');
  const { builderConfig: buildConfig } = createRequire(import.meta.url)('../apps/desktop/builder-config.ts');
  const packageFiles = ['main.cjs', 'backend.cjs', 'preload.cjs', 'package.json', 'web/index.html', 'web/assets/app.js', 'icons/icon.png', 'licenses/NOTICE.md'];
  const secretFiles = runtimeNames.flatMap(name => [name, `custom-user-data/${name}`, `custom-user-data/workspace/${name}`]);
  const excludedFiles = [...secretFiles, '.env', 'custom-user-data/workspace/workbench.sqlite', 'node_modules/synthetic/index.js'];
  for (const file of packageFiles) await writeFixture(root, file, `synthetic package source: ${file}\n`);
  for (const file of excludedFiles) await writeFixture(root, file, SYNTHETIC_SECRET);
  for (const channel of ['development', 'production']) {
    const config = buildConfig(channel);
    assert.deepEqual(config.files, ['main.cjs', 'backend.cjs', 'preload.cjs', 'package.json', 'web/**/*', 'icons/**/*', 'licenses/**/*', '!node_modules/**/*']);
    const includes = config.files.filter((pattern: string) => !pattern.startsWith('!'));
    const excludes = config.files.filter((pattern: string) => pattern.startsWith('!')).map((pattern: string) => pattern.slice(1));
    const selected = [...packageFiles, ...excludedFiles].filter(file => includes.some((pattern: string) => path.matchesGlob(file, pattern)) && !excludes.some((pattern: string) => path.matchesGlob(file, pattern)));
    assert.deepEqual(selected.sort(), [...packageFiles].sort());
    for (const file of selected) assert.equal((await readFile(path.join(root, file), 'utf8')).includes(SYNTHETIC_SECRET), false);
    assert.equal(config.publish, null);
  }
  // This is a source/configuration fixture gate, not evidence of a built or
  // inspected installer, native ACLs, or the contents of a live userData path.
});
