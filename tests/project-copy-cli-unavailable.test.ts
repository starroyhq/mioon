import {testEnv} from './helpers/test-env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';

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

function environment(directory: string) {
  const env = {...testEnv()};
  for (const key of Object.keys(env)) if (/^(?:MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|NODE_OPTIONS$|NODE_PATH$)/u.test(key)) delete env[key];
  env.MIOON_CONNECTION_FILE = path.join(directory, 'connection-must-not-be-read.json');
  env.MIOON_TOKEN_FILE = path.join(directory, 'token-must-not-be-read');
  return env;
}
async function run(args: string[], directory: string) {
  try {
    const {stdout, stderr} = await execute(process.execPath, ['--import', preload, cli, ...args],
      {cwd: repository, env: environment(directory), encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024});
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

test('CLI trash refuses before input IO, private storage initialization and backend lookup', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mioon-trash-cli-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const sentinel = path.join(directory, 'source.mioon'); writeFileSync(sentinel, 'Do not read or trash this source');
  const before = readdirSync(directory).sort(), bytes = readFileSync(sentinel);
  for (const args of [
    ['project', 'delete', '--input-file', path.join(directory, 'missing-input.json')],
    ['project.delete', '--input', '{invalid JSON'],
    ['rpc', 'project.delete', '--input', JSON.stringify({projectId:randomUUID(),requestId:randomUUID(),expectedRevision:1,projectFile:sentinel,fileIdentity:{dev:'1',ino:'2'},confirmTrash:true})],
    ['project', 'delete', '--input', JSON.stringify({confirmPermanentDeletion:true})],
  ]) {
    const result = await run(args, directory);
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {ok:false,error:{code:'PROJECT_TRASH_UNAVAILABLE',message:'Project trash commands are not available in this client yet.',details:{},retryable:false}});
    assert.match(result.stderr, /^PROJECT_TRASH_UNAVAILABLE: /u);
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_|FILE_READ_ERROR|INVALID_JSON|CONNECTION_CONFIG_ERROR|\uFFFD/u);
    assert.deepEqual(readdirSync(directory).sort(), before);
    assert.deepEqual(readFileSync(sentinel), bytes);
  }
  for(const args of [['project','delete','--help'],['schema','project.delete']]) {
    const result=await run(args,directory);
    assert.equal(result.code,0,result.stdout+result.stderr);
    assert.equal(JSON.parse(result.stdout).ok,true);
    assert.match(result.stdout,/confirmTrash/u);
    assert.doesNotMatch(result.stdout,/confirmPermanentDeletion|UNEXPECTED_|\uFFFD/u);
    assert.deepEqual(readdirSync(directory).sort(),before);
  }
});

test('MCP trash stays discoverable but refuses before storage or backend access', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mioon-trash-mcp-'));
  t.after(() => rmSync(directory, {recursive:true,force:true}));
  const sentinel=path.join(directory,'source.mioon');writeFileSync(sentinel,'Do not read or trash this source');
  const before=readdirSync(directory).sort(),bytes=readFileSync(sentinel);
  const client=new Client({name:'trash-unavailable-test',version:'1'},{capabilities:{}});
  const env=Object.fromEntries(Object.entries(environment(directory)).filter((pair):pair is [string,string]=>typeof pair[1]==='string'));
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',preload,path.join(repository,'apps/mcp/src/index.ts')],cwd:repository,env,stderr:'pipe'});
  let diagnostic='';(transport.stderr as import('node:stream').Readable|null)?.setEncoding('utf8').on('data',(text:string)=>{diagnostic+=text;});
  t.after(()=>client.close());await client.connect(transport);
  const listing=(await client.listTools()).tools,tool=listing.find(value=>value.name==='project_delete');
  assert.ok(tool);assert.equal(tool.annotations?.destructiveHint,true);assert.equal(tool.annotations?.idempotentHint,true);
  assert.ok(JSON.stringify(tool.inputSchema).includes('confirmTrash'));
  for(const input of [{},{confirmPermanentDeletion:true},
    {projectId:randomUUID(),requestId:randomUUID(),expectedRevision:1,projectFile:sentinel,fileIdentity:{dev:'1',ino:'2'},confirmTrash:true}]) {
    const result=await client.callTool({name:'project_delete',arguments:input}) as CallToolResult;
    const expected={ok:false,error:{code:'PROJECT_TRASH_UNAVAILABLE',message:'Project trash commands are not available in this client yet.',details:{},retryable:false}};
    assert.equal(result.isError,true);assert.deepEqual(result.structuredContent,expected);
    const text=result.content.find(value=>value.type==='text');assert.ok(text&&text.type==='text');assert.deepEqual(JSON.parse(text.text),expected);
    assert.deepEqual(readdirSync(directory).sort(),before);assert.deepEqual(readFileSync(sentinel),bytes);
  }
  const schema=await client.callTool({name:'mioon_schema',arguments:{operation:'project.delete'}}) as CallToolResult;
  assert.equal(Boolean(schema.isError),false);assert.equal(schema.structuredContent?.ok,true);
  assert.match(JSON.stringify(schema.structuredContent),/confirmTrash/u);
  assert.doesNotMatch(JSON.stringify(schema.structuredContent),/confirmPermanentDeletion/u);
  await client.close();assert.doesNotMatch(diagnostic,/UNEXPECTED_|CONNECTION_CONFIG_ERROR|\uFFFD/u);
  assert.deepEqual(readdirSync(directory).sort(),before);assert.deepEqual(readFileSync(sentinel),bytes);
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
