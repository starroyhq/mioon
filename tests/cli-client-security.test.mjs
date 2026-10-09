import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createClient} from '@mioon/client';
import {downloadAsset} from '@mioon/client/download';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}
async function credentials(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-client-security-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const tokenFile = path.join(root, 'token');
  const token = 'synthetic-client-security-token-only';
  await writeFile(tokenFile, token, {mode:0o600});
  return {root, tokenFile, token};
}

test('shared direct token-file client re-reads credentials between calls without logging them', async t => {
  const {tokenFile, token} = await credentials(t);
  let expected = token, authenticated = 0;
  const base = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${expected}`);
    authenticated++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ok:true,data:[]}));
  });
  const client = createClient({env:{MIOON_BASE_URL:base,MIOON_TOKEN_FILE:tokenFile}});
  assert.deepEqual(await client.rpc('project.list'), []);
  expected = token + '-rotated'; await writeFile(tokenFile, expected);
  assert.deepEqual(await client.rpc('project.list'), []);
  assert.equal(authenticated, 2);
});

test('watch deadline bounds a hanging get and never dispatches job.cancel', async t => {
  const {tokenFile} = await credentials(t), operations = [];
  const base = await fixture(t, async (req, _res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    operations.push(JSON.parse(Buffer.concat(chunks).toString()).operation);
    // Intentionally leave the response open until the client's watch deadline.
  });
  const client = createClient({env:{MIOON_BASE_URL:base, MIOON_TOKEN_FILE:tokenFile}});
  const start = Date.now();
  await assert.rejects(client.watch('job', {jobId:randomUUID()}, {timeoutMs:100,intervalMs:20}), {code:'WATCH_TIMEOUT',exitCode:5});
  assert.ok(Date.now() - start < 1500, 'watch must not inherit the full 30-second HTTP timeout');
  assert.deepEqual(operations, ['job.get']);
});

test('RPC and download refuse redirects without forwarding credentials or keeping partial output', async t => {
  const {root, tokenFile} = await credentials(t);
  let redirectedRequests = 0;
  const destination = await fixture(t, (_req, res) => {redirectedRequests++;res.end('must not be fetched');});
  const base = await fixture(t, (_req, res) => {res.writeHead(302,{location:destination});res.end();});
  const env = {MIOON_BASE_URL:base,MIOON_TOKEN_FILE:tokenFile};
  await assert.rejects(createClient({env}).rpc('project.list'), {code:'BACKEND_UNAVAILABLE'});
  const output = path.join(root, 'must-not-remain.mp4');
  await assert.rejects(downloadAsset({assetId:randomUUID()},output,{env}), {code:'BACKEND_UNAVAILABLE'});
  assert.equal(redirectedRequests, 0);
  await assert.rejects(readFile(output), {code:'ENOENT'});
});

test('interrupted media stream closes only the client and removes its partial output', async t => {
  const {root,tokenFile} = await credentials(t);
  let started;
  const ready = new Promise(resolve => {started = resolve;});
  const base = await fixture(t, (_req,res) => {res.writeHead(200,{'content-type':'video/mp4'});res.write(Buffer.alloc(16));started();});
  const controller = new AbortController(), output = path.join(root,'interrupted.mp4');
  const result = downloadAsset({assetId:randomUUID()},output,{env:{MIOON_BASE_URL:base,MIOON_TOKEN_FILE:tokenFile},signal:controller.signal});
  const rejected = assert.rejects(result, {code:'INTERRUPTED',exitCode:130});
  await ready; controller.abort(); await rejected;
  await assert.rejects(readFile(output), {code:'ENOENT'});
});
