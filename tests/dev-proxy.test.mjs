import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {startServer} from '@mioon/server';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url));
const {createServer}=await import(require.resolve('vite'));

test('Vite dev proxy validates incoming origins before adapting to the strict backend boundary',async()=>{
 const token='synthetic-development-proxy-test-token';
 const backend=await startServer({dataDir:await mkdtemp('/tmp/wb-proxy-'),port:4318,token});
 let vite;
 try{
  vite=await createServer({root:fileURLToPath(new URL('../apps/web',import.meta.url)),configFile:fileURLToPath(new URL('../apps/web/vite.config.mjs',import.meta.url)),logLevel:'silent'});await vite.listen();
  const origin='http://127.0.0.1:5173';
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({token})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const rpc=await fetch(origin+'/api/rpc',{method:'POST',headers:{'content-type':'application/json',origin,cookie},body:JSON.stringify({operation:'project.list',input:{}})});
  assert.equal(rpc.status,200);assert.equal((await rpc.json()).ok,true);
  const hostile=await fetch(origin+'/api/rpc',{method:'POST',headers:{origin:'https://untrusted.example',cookie},body:'{}'});assert.equal(hostile.status,403);
  const host=await new Promise((resolve,reject)=>{const request=http.get(origin+'/health',{headers:{host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(host,403);
  const direct=await fetch(backend.url+'/api/rpc',{method:'POST',headers:{origin,cookie},body:'{}'});assert.equal(direct.status,403,'backend must not independently allow Vite origin');
  const page=await fetch(origin);assert.match(await page.text(),/@vite\/client/);
 }finally{await vite?.close();await backend.close();}
});
