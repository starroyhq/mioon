import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import type {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '@mioon/server';

const repo = fileURLToPath(new URL('../', import.meta.url));
const token = 'q2-synthetic-private-transport-token';
function environment(base: string, tokenFile: string) {
  return {PATH: process.env.PATH || '', HOME: tmpdir(), LANG: 'C.UTF-8',
    MIOON_ENABLE_LIVE_PROVIDER: '0', MIOON_BASE_URL: base, MIOON_TOKEN_FILE: tokenFile};
}
async function cli(env: { PATH: string; HOME: string; LANG: string; MIOON_ENABLE_LIVE_PROVIDER: string; MIOON_BASE_URL: string; MIOON_TOKEN_FILE: string; }, args: string[] = ['project', 'list']) {
  const child = spawn(process.execPath, ['apps/cli/src/index.ts', ...args], {cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  for (const [kind, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) stream.setEncoding('utf8').on('data', (bytes: string) => {
    if (kind === 'stdout') stdout += bytes; else stderr += bytes;
    if (stdout.length + stderr.length > 65536) child.kill();
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', resolve);});
    return {code, stdout, stderr, result: JSON.parse(stdout)};
  } finally {clearTimeout(timer);}
}
async function mcp(t: test.TestContext, env: { PATH: string; HOME: string; LANG: string; MIOON_ENABLE_LIVE_PROVIDER: string; MIOON_BASE_URL: string; MIOON_TOKEN_FILE: string; }) {
  const transport = new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'], cwd: repo, env, stderr: 'pipe'});
  let stderr = ''; (transport.stderr as Readable | null)?.setEncoding('utf8').on('data', (bytes: string) => {stderr += bytes;});
  const client = new Client({name: 'q2-private-storage-acceptance', version: '1.0.0'}, {capabilities: {}});
  t.after(() => client.close());
  await client.connect(transport);
  return {client, get stderr() {return stderr;}, async list() {
    const response = await client.callTool({name: 'project_list', arguments: {}});
    return {response, result: JSON.parse((response.content as Array<{type: string; text: string}>).find((item: { type: string; }) => item.type === 'text')!.text)};
  }};
}

test('Q2 actual HTTP, CLI and official MCP accept private files and refuse unsafe parents without writes', {timeout: 30000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-q2-transports-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const backend = await startServer({dataDir: path.join(root, 'workspace'), port: 0, token});
  t.after(() => backend.close());
  const safe = path.join(root, 'safe'), unsafe = path.join(root, 'unsafe');
  await mkdir(safe, {mode: 0o700}); await mkdir(unsafe, {mode: 0o755});
  const safeToken = path.join(safe, 'mcp-token'), unsafeToken = path.join(unsafe, 'mcp-token');
  for (const file of [safeToken, unsafeToken]) await writeFile(file, token, {mode: 0o600});
  const rpc = async (operation: string, input: { name?: string; }|undefined = {}) => {
    const response = await fetch(backend.url + '/api/rpc', {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify({operation, input})});
    const body = await response.json(); assert.equal(body.ok, true); return body.data;
  };
  const project = await rpc('project.create', {name: 'Q2 · preserved synthetic project'});
  const expected = await rpc('project.list'); assert.equal(expected.length, 1); assert.equal(expected[0].id, project.id);
  const acceptedCli = await cli(environment(backend.url, safeToken));
  assert.equal(acceptedCli.code, 0); assert.deepEqual(acceptedCli.result.data, expected);
  const safeMcp = await mcp(t, environment(backend.url, safeToken));
  assert.deepEqual((await safeMcp.list()).result.data, expected);

  const refusedCli = await cli(environment(backend.url, unsafeToken));
  assert.notEqual(refusedCli.code, 0); assert.equal(refusedCli.result.ok, false);
  assert.equal(refusedCli.result.error.code, 'CONNECTION_CONFIG_ERROR');
  const unsafeMcp = await mcp(t, environment(backend.url, unsafeToken));
  const listing = await unsafeMcp.client.listTools(); assert.ok(listing.tools.some(tool => tool.name === 'project_list'));
  const refusal = await unsafeMcp.list();
  assert.equal(refusal.response.isError, true); assert.equal(refusal.result.error.code, 'CONNECTION_CONFIG_ERROR');
  for (const output of [refusedCli.stdout + refusedCli.stderr, JSON.stringify(refusal), unsafeMcp.stderr]) {
    assert.ok(!output.includes(token)); assert.ok(!output.includes(unsafeToken));
  }
  assert.equal(await readFile(unsafeToken, 'utf8'), token);
  assert.deepEqual(await rpc('project.list'), expected);
});
