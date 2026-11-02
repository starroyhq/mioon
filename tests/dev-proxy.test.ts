import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '@mioon/server';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url));
interface ViteServer {listen(): Promise<unknown>; close(): Promise<unknown>}
type ViteFactory = (options: Record<string, unknown>)=>Promise<ViteServer>;
const {createServer}=await import(require.resolve('vite')) as {createServer: ViteFactory};

function replaceReviewed(source:string,before:string,after:string,count=1):string{
 assert.equal(source.split(before).length,count+1,`Expected ${count} reviewed Vite configuration fragment(s): ${before}`);
 return source.replaceAll(before,after);
}
async function isolatedConfiguration(root:string,port:number,backend:string):Promise<Record<string,unknown>>{
 const url=new URL('../apps/web/vite.config.ts',import.meta.url);
 let source=await readFile(url,'utf8');
 // Run the actual boundary/proxy implementation with only its test addresses
 // changed. Resolve imports and import.meta from the original configuration.
 source=replaceReviewed(source,'const port = 5173;',`const port = ${port};`);
 source=replaceReviewed(source,"const backend = 'http://127.0.0.1:4318';",`const backend = ${JSON.stringify(backend)};`);
 for(const name of ['vite','@tailwindcss/vite'])source=replaceReviewed(source,`from '${name}'`,`from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)}`);
 source=replaceReviewed(source,'import.meta.url',JSON.stringify(url.href));
 const configurationPath=path.join(root,'vite.config.ts');
 await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module'})+'\n',{mode:0o600});
 await writeFile(configurationPath,source,{mode:0o600});
 const loaded=await import(pathToFileURL(configurationPath).href) as {default:(environment:{command:'serve';mode:'development'})=>Record<string,unknown>};
 return loaded.default({command:'serve',mode:'development'});
}

test('Vite dev proxy validates incoming origins before adapting to the strict backend boundary',async t=>{
 const token='synthetic-development-proxy-test-token';
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'wb-proxy-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const backend=await startServer({dataDir:path.join(root,'data'),port:0,token});
 const reserved=http.createServer();
 let vite: ViteServer|undefined;
 try{
  await new Promise<void>((resolve,reject)=>{reserved.once('error',reject);reserved.listen(0,'127.0.0.1',resolve);});
  const address=reserved.address();assert.ok(address&&typeof address==='object');
  const configuration=await isolatedConfiguration(root,address.port,backend.url);
  vite=await createServer({...configuration,root:fileURLToPath(new URL('../apps/web',import.meta.url)),configFile:false,logLevel:'silent'});
  await new Promise<void>((resolve,reject)=>reserved.close(error=>error?reject(error):resolve()));
  await vite.listen();
  const origin=`http://127.0.0.1:${address.port}`;
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({token})});
  assert.equal(login.status,200);const cookie=(login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const rpc=await fetch(origin+'/api/rpc',{method:'POST',headers:{'content-type':'application/json',origin,cookie},body:JSON.stringify({operation:'project.list',input:{}})});
  assert.equal(rpc.status,200);assert.equal((await rpc.json()).ok,true);
  const hostile=await fetch(origin+'/api/rpc',{method:'POST',headers:{origin:'https://untrusted.example',cookie},body:'{}'});assert.equal(hostile.status,403);
  const host=await new Promise<number|undefined>((resolve,reject)=>{const request=http.get(origin+'/health',{headers:{host:'evil.example'}},(response)=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(host,403);
  const direct=await fetch(backend.url+'/api/rpc',{method:'POST',headers:{origin,cookie},body:'{}'});assert.equal(direct.status,403,'backend must not independently allow Vite origin');
  const page=await fetch(origin);assert.match(await page.text(),/@vite\/client/);
 }finally{if(reserved.listening)await new Promise<void>((resolve,reject)=>reserved.close(error=>error?reject(error):resolve()));await vite?.close();await backend.close();}
});
