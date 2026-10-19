import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '@mioon/contracts';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const projectId = '11111111-1111-4111-8111-111111111111';
const requestId = 'synthetic-transport-review-001';
const review = {input: {projectId, requestId, name: 'Synthetic review', prompt: 'Synthetic prompt',
  providerId: 'openai', model: IMAGE_MODELS.openai, options: IMAGE_FIXED_OPTIONS}, settingsRevision: 1};

async function fixture(t) {
  const requests = [];
  // This server only captures input and emits malformed JSON envelopes. It has
  // no business service, database, media, credential resolver or provider.
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, {'content-type': 'application/json'});
    response.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, {MIOON_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    MIOON_TOKEN: 'synthetic-cli-mcp-recovery-token-only', MIOON_ENABLE_LIVE_PROVIDER: '0'});
  return {requests, env};
}

function check(envelope, operation) {
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'BACKEND_PROTOCOL_ERROR');
  assert.equal(envelope.error.retryable, false);
  const details = envelope.error.details;
  assert.equal(details.operation, operation);
  if (operation === 'image.review.prepare') {
    assert.equal(details.requestId, requestId);
    assert.equal(details.submissionMayHaveSucceeded, true);
    assert.match(details.recovery, /exact original input.*same requestId/);
  } else {
    assert.equal(Object.hasOwn(details, 'submissionMayHaveSucceeded'), false);
    assert.equal(Object.hasOwn(details, 'recovery'), false);
  }
}

for (const operation of ['image.review.prepare', 'image.request.get']) {
  const input = operation === 'image.review.prepare' ? review : {projectId, requestId};
  test(`CLI preserves operation-specific recovery for ${operation}`, {timeout: 10000}, async t => {
    const f = await fixture(t);
    await assert.rejects(execute(process.execPath, ['apps/cli/src/index.ts', ...operation.split('.'), '--input', JSON.stringify(input)],
      {cwd: repo, env: f.env, timeout: 5000}), error => {
      assert.equal(error.code, 4);
      const lines = error.stdout.trim().split('\n');
      assert.equal(lines.length, 1);
      check(JSON.parse(lines[0]), operation);
      assert.equal(error.stdout.includes(f.env.MIOON_TOKEN), false);
      assert.equal(error.stderr.includes(f.env.MIOON_TOKEN), false);
      return true;
    });
    assert.deepEqual(f.requests, [{operation, input}]);
  });

  test(`MCP preserves operation-specific recovery for ${operation}`, {timeout: 10000}, async t => {
    const f = await fixture(t);
    const client = new Client({name: 'synthetic-recovery-test', version: '1.0.0'}, {capabilities: {}});
    const transport = new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'], cwd: repo, env: f.env, stderr: 'pipe'});
    t.after(() => client.close());
    await client.connect(transport);
    const result = await client.callTool({name: operation.replaceAll('.', '_'), arguments: input});
    assert.equal(result.isError, true);
    const envelope = JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.deepEqual(result.structuredContent, envelope);
    check(envelope, operation);
    assert.equal(JSON.stringify(result).includes(f.env.MIOON_TOKEN), false);
    assert.deepEqual(f.requests, [{operation, input}]);
  });
}
