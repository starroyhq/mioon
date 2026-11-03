import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import promises, {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {startServer} from '../apps/server/src/index.ts';
import {projectApiPath, projectMediaPath, projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {syntheticPng} from './helpers/runway-unknown-fixture.ts';

const token = 'synthetic-s1-http-token';
interface Envelope<T> {ok: boolean; data?: T; error?: {code: string; details?: unknown}}
interface Asset {id: string; projectId: string; url: string; sha256: string | null; referenceRevision: number}
interface Locations {assets: {assetId: string; displayPath: string}[]; locations: {directory: string; locationToken: string; confirmed: boolean}[]}

function noPaths(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {for (const item of value) noPaths(item);return;}
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!['reference','relativePath','sourcePath','displayPath','directory','path','volume'].includes(key), key);
    noPaths(item);
  }
}
function wav(payload: number): Buffer {
  const bytes = Buffer.alloc(payload + 44, 0);
  bytes.write('RIFF');bytes.writeUInt32LE(payload + 36,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);
  bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(payload,40);return bytes;
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(),'s1-media-http-'));
  const server = await startServer({dataDir:path.join(root,'application'),port:0,token});
  t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();await server.close();await rm(root,{recursive:true,force:true});});
  const headers = {authorization:`Bearer ${token}`,origin:server.url,'content-type':'application/json'};
  const request = async <T>(route:string,body:unknown,extra:Record<string,string>={}) => {
    const response=await fetch(server.url+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
    return {response,body:await response.json() as Envelope<T>};
  };
  const rpc = <T>(id:string|null,operation:string,input:unknown) => request<T>(id?projectRpcPath(id):'/api/rpc',{operation,input});
  const trusted = <T>(id:string,operation:string,input:unknown) => request<T>(projectApiPath(id,'asset-media','trusted'),{operation,input},{'x-mioon-user-action':'asset-media'});
  const created=await rpc<{id:string}>(null,'project.create',{name:'S1 HTTP'});assert.equal(created.response.status,200);assert.ok(created.body.data);
  const projectId=created.body.data.id;
  const imported=await rpc<Asset>(projectId,'asset.import',{projectId,name:'pixel.png',mimeType:'image/png',dataBase64:syntheticPng.toString('base64')});
  assert.equal(imported.response.status,200);assert.ok(imported.body.data);
  return {root,server,headers,projectId,asset:imported.body.data,request,rpc,trusted};
}

test('real media HTTP keeps bearer/origin and trusted user-action boundaries; public DTOs contain no paths',{timeout:30_000},async t=>{
  const f=await fixture(t),route=projectApiPath(f.projectId,'asset-media','trusted'),body={operation:'asset.media.location.list',input:{projectId:f.projectId}};
  const anonymous=await fetch(f.server.url+route,{method:'POST',headers:{'content-type':'application/json','x-mioon-user-action':'asset-media'},body:JSON.stringify(body)});
  assert.equal(anonymous.status,401);assert.equal((await anonymous.json() as Envelope<never>).error!.code,'UNAUTHORIZED');
  const hostile=await f.request(route,body,{origin:'https://untrusted.invalid','x-mioon-user-action':'asset-media'});
  assert.equal(hostile.response.status,403);assert.equal(hostile.body.error!.code,'ORIGIN_REJECTED');
  const noAction=await f.request(route,body);assert.equal(noAction.response.status,403);assert.equal(noAction.body.error!.code,'FORBIDDEN');
  for(const operation of ['asset.media.location.list','asset.media.outside.confirm','asset.import.path']) {
    const ordinary=await f.request(projectRpcPath(f.projectId),{operation,input:{projectId:f.projectId,locationToken:randomUUID(),trusted:true}},{'x-mioon-user-action':'asset-media'});
    assert.equal(ordinary.response.status,404);assert.equal(ordinary.body.error!.code,'UNKNOWN_OPERATION');
  }
  const location=await f.trusted<Locations>(f.projectId,body.operation,body.input);assert.equal(location.response.status,200);
  assert.equal(location.body.data!.assets[0]!.assetId,f.asset.id);assert.ok(path.isAbsolute(location.body.data!.assets[0]!.displayPath));
  noPaths(f.asset);assert.equal(f.asset.url,projectMediaPath(f.projectId,f.asset.id));
  for(const operation of ['asset.list','project.get']){const visible=await f.rpc(f.projectId,operation,{projectId:f.projectId});assert.equal(visible.response.status,200);noPaths(visible.body.data);}
});

test('uploaded media uses ID routes with guarded GET, HEAD and Range/no-store and project isolation',{timeout:30_000},async t=>{
  const f=await fixture(t),route=f.asset.url;
  const full=await fetch(f.server.url+route,{headers:f.headers});assert.equal(full.status,200);assert.equal(full.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await full.arrayBuffer()),syntheticPng);
  const head=await fetch(f.server.url+route,{method:'HEAD',headers:f.headers});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(syntheticPng.length));assert.equal(head.headers.get('cache-control'),'private, no-store');assert.equal((await head.arrayBuffer()).byteLength,0);
  const partial=await fetch(f.server.url+route,{headers:{...f.headers,range:'bytes=2-9'}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),`bytes 2-9/${syntheticPng.length}`);assert.equal(partial.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await partial.arrayBuffer()),syntheticPng.subarray(2,10));
  const second=await f.rpc<{id:string}>(null,'project.create',{name:'Other project'});assert.ok(second.body.data);
  const foreign=await fetch(f.server.url+projectMediaPath(second.body.data.id,f.asset.id),{headers:f.headers});assert.equal(foreign.status,404);assert.equal((await foreign.json() as Envelope<never>).error!.code,'NOT_FOUND');
  const missing=await fetch(f.server.url+projectMediaPath(f.projectId,randomUUID()),{headers:f.headers});assert.equal(missing.status,404);assert.equal((await missing.json() as Envelope<never>).error!.code,'NOT_FOUND');
});

test('external reference consent revocation stops an admitted real HTTP stream and denies subsequent reads',{timeout:30_000},async t=>{
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),originalOpen=promises.open;let gated=false,source='';
  t.after(()=>gate.resolve());
  t.mock.method(promises,'open',async(...args:Parameters<typeof originalOpen>)=>{
    const responseOpen=Boolean(new Error().stack?.includes('file-response.ts'));
    const handle=await originalOpen(...args);
    if(source&&String(args[0])===source&&responseOpen&&!gated){
      gated=true;const original=handle.createReadStream.bind(handle);
      t.mock.method(handle,'createReadStream',(...options:Parameters<typeof original>)=>{
        const real=original(...options),read=real._read.bind(real);let reads=0;
        // Keep the actual fs.ReadStream/FileHandle. Delay its second native
        // read, then call the original _read, rather than substituting bytes.
        t.mock.method(real,'_read',(size:number)=>{if(reads++===0)read(size);else void gate.promise.then(()=>{if(!real.destroyed)read(size);});});
        real.once('data',()=>entered.resolve());
        return real;
      });
    }
    return handle;
  });syncBuiltinESMExports();
  const f=await fixture(t),directory=path.join(f.root,'external');await mkdir(directory);
  source=path.join(directory,'large.wav');const bytes=wav(4*1024*1024);await writeFile(source,bytes);
  const denied=await f.rpc(f.projectId,'asset.import',{projectId:f.projectId,requestId:randomUUID(),sourcePath:source});assert.equal(denied.response.status,403);assert.equal(denied.body.error!.code,'MEDIA_OUTSIDE_NOT_CONFIRMED');
  const accepted=await f.trusted<{asset:Asset;confirmedDirectories:string[]}>(f.projectId,'asset.import.path',{projectId:f.projectId,requestId:randomUUID(),sourcePath:source});assert.equal(accepted.response.status,200);assert.ok(accepted.body.data);noPaths(accepted.body.data.asset);assert.deepEqual(accepted.body.data.confirmedDirectories,[directory]);
  const asset=accepted.body.data.asset,locations=await f.trusted<Locations>(f.projectId,'asset.media.location.list',{projectId:f.projectId});assert.equal(locations.response.status,200);
  const location=locations.body.data!.locations.find(value=>value.directory===directory);assert.ok(location);assert.equal(location.confirmed,true);
  const responsePromise=fetch(f.server.url+asset.url,{headers:f.headers});await entered.promise;const response=await responsePromise;assert.equal(response.status,200);
  assert.ok(response.body);const reader=response.body.getReader(),first=await reader.read();assert.equal(first.done,false);assert.ok(first.value&&first.value.byteLength>0);
  const observed=(async()=>{let received=first.value!.byteLength;try{for(;;){const next=await reader.read();if(next.done)return {complete:true,bytes:received};received+=next.value.byteLength;}}catch{return {complete:false,bytes:received};}})();
  const revoked=await f.trusted(f.projectId,'asset.media.outside.revoke',{projectId:f.projectId,requestId:randomUUID(),locationToken:location.locationToken});assert.equal(revoked.response.status,200);
  gate.resolve();const stopped=await observed;assert.equal(stopped.complete,false,'revoked stream cannot complete its promised content-length');assert.ok(stopped.bytes>0&&stopped.bytes<bytes.length);
  const after=await fetch(f.server.url+asset.url,{headers:f.headers});assert.equal(after.status,403);assert.equal((await after.json() as Envelope<never>).error!.code,'MEDIA_OUTSIDE_NOT_CONFIRMED');
  assert.deepEqual(await readFile(source),bytes,'revoking read consent never modifies source bytes');
});
