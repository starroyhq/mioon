import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repository, 'apps/cli/src/index.ts');
const preload = 'data:text/javascript,' + encodeURIComponent(`
  import {registerHooks} from 'node:module';
  registerHooks({resolve(specifier,context,nextResolve){
    if(specifier==='@mioon/node-host/private-storage-bootstrap')throw Error('UNEXPECTED_STORAGE_INITIALIZATION');
    return nextResolve(specifier,context);
  }});
  globalThis.fetch=()=>{throw Error('UNEXPECTED_NETWORK_ACCESS');};
`);

async function run(args: string[], directory: string) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(?:MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|NODE_OPTIONS$|NODE_PATH$)/u.test(key)) delete env[key];
  env.MIOON_CONNECTION_FILE = path.join(directory, 'connection-must-not-be-read.json');
  env.MIOON_TOKEN_FILE = path.join(directory, 'token-must-not-be-read');
  try {
    const {stdout, stderr} = await execute(process.execPath, ['--import', preload, cli, ...args],
      {cwd: repository, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024});
    return {code: 0, stdout, stderr};
  } catch (error) {
    assert.ok(error instanceof Error);
    const failure = error as Error & {code?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown};
    assert.equal(failure.signal, null);
    assert.ok(typeof failure.code === 'number');
    assert.ok(typeof failure.stdout === 'string');
    assert.ok(typeof failure.stderr === 'string');
    return {code: failure.code, stdout: failure.stdout, stderr: failure.stderr};
  }
}

test('CLI duplicate refuses before input IO, private storage initialization and backend lookup', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mioon-copy-cli-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const sentinel = path.join(directory, 'source.mioon'); writeFileSync(sentinel, 'Do not read or change this source');
  const before = readdirSync(directory).sort(), bytes = readFileSync(sentinel);
  for (const args of [
    ['project', 'duplicate', '--input-file', path.join(directory, 'missing-input.json')],
    ['project.duplicate', '--input', '{invalid JSON'],
    ['rpc', 'project.duplicate', '--input', '{"projectId":"not-a-project"}'],
  ]) {
    const result = await run(args, directory);
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {ok: false, error: {code: 'PROJECT_COPY_UNAVAILABLE', message: 'Project copy commands are not available in this client yet.', details: {}, retryable: false}});
    assert.match(result.stderr, /^PROJECT_COPY_UNAVAILABLE: /u);
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_|FILE_READ_ERROR|INVALID_JSON|CONNECTION_CONFIG_ERROR|\uFFFD/u);
    assert.deepEqual(readdirSync(directory).sort(), before);
    assert.deepEqual(readFileSync(sentinel), bytes);
  }
});

test('help and schema remain available without private storage or network and do not discover S5 operations', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mioon-copy-cli-help-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  for (const args of [['project', 'duplicate', '--help'], ['schema']]) {
    const result = await run(args, directory);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const body = JSON.parse(result.stdout) as {ok: boolean; data: {operations: Array<string | {operation: string}>}};
    assert.equal(body.ok, true);
    assert.ok(body.data.operations.length > 0);
    const operations = body.data.operations.map(value => typeof value === 'string' ? value : value.operation);
    assert.equal(operations.includes('project.duplicate'), false);
    assert.equal(operations.includes('project.save-as'), false);
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_|\uFFFD/u);
    assert.deepEqual(readdirSync(directory), []);
  }
});
