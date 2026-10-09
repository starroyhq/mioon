import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {startServer} from '@video-workbench/server';

const token = 'synthetic-server-lifecycle-test-token';
const rpc = async (service, operation, input = {}, headers = {}) => {
  const response = await fetch(service.url + '/api/rpc', {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,...headers},body:JSON.stringify({operation,input})});
  return {status:response.status,body:await response.json()};
};

test('exported server supports ephemeral loopback port, independent lifecycle and durable data', async () => {
  const root = await mkdtemp('/tmp/wb-lifecycle-');
  const dist = path.join(root,'renderer');
  await mkdir(dist);await writeFile(path.join(dist,'index.html'),'<html>isolated renderer fixture</html>');
  let service = await startServer({dataDir:path.join(root,'data'),port:0,token,distDir:dist});
  try {
    assert.match(service.url,/^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(service.port,0);
    const health = await fetch(service.url+'/health');
    assert.equal((await health.json()).version,'0.4.0');
    assert.match(health.headers.get('content-security-policy'),/object-src 'none'/);
    const page = await fetch(service.url);assert.equal(await page.text(),'<html>isolated renderer fixture</html>');
    const project = await rpc(service,'project.create',{name:'Persistent workspace'});
    assert.equal(project.body.ok,true);
    const closed = service.close(); assert.equal(service.close(),closed); await closed;
    await assert.rejects(fetch(service.url+'/health'));
    service = await startServer({dataDir:path.join(root,'data'),port:0,token,distDir:dist});
    assert.equal((await rpc(service,'project.list')).body.data[0].id,project.body.data.id);
  } finally { await service.close(); }
});

test('refactored transport retains authorization, origin and host checks, without exposing token',async () => {
  const dataDir = await mkdtemp('/tmp/wb-auth-');
  const service = await startServer({dataDir,port:0,token});
  try {
    const unauthenticated = await fetch(service.url+'/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'project.list',input:{}})});
    assert.equal(unauthenticated.status,401);
    assert.equal((await rpc(service,'project.list',{}, {origin:'https://untrusted.example'})).status,403);
    const rejectedHost = await new Promise((resolve,reject)=>{const req=http.get(service.url+'/health',{headers:{host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
    assert.equal(rejectedHost,403);
    const wrong = await fetch(service.url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'错'.repeat(token.length)})});
    assert.equal(wrong.status,401,'UTF-8 byte-length mismatch must reject rather than throw');
    const login = await fetch(service.url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});
    assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    const publicHealth = await (await fetch(service.url+'/health')).text();assert.ok(!publicHealth.includes(token));
    await assert.rejects(startServer({dataDir,port:0,token}),/running backend/);
  } finally {await service.close();}
});

test('token remains private at rest, invalid startup releases lock for a corrected retry',async () => {
  const root = await mkdtemp('/tmp/wb-token-');
  let service = await startServer({dataDir:root,port:0});
  assert.equal((await stat(service.tokenFile)).mode & 0o777,0o600);
  assert.equal((await readFile(service.tokenFile,'utf8')).trim(),service.token);
  await service.close();
  await writeFile(path.join(root,'access-token'),'bad');
  await assert.rejects(startServer({dataDir:root,port:0}),/20 characters/);
  service = await startServer({dataDir:root,port:0,token});await service.close();
});
