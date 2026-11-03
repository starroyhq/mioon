





import type {LastProjectEnvelope} from '@mioon/contracts/last-project';
import type {RootFailure} from './helpers/strict-root-error-types.ts';
import type {FixtureProject} from './helpers/strict-timeline-core-types.ts';
type SupportedLocator=Extract<LastProjectEnvelope,{supported:true}>;
type LocatorData<S extends string>=S extends '/api/rpc'?FixtureProject:SupportedLocator;
interface LocatorOptions {method?:string;input?:unknown;raw?:string|Buffer;authenticated?:boolean;headers?:http.OutgoingHttpHeaders;chunked?:boolean}
interface LocatorHttpResponse<T=SupportedLocator> {status:number;headers:http.IncomingHttpHeaders;body:{ok:boolean;data:T;error:RootFailure}}
import type {ProcessOutcome, BackendReady, IpcMessage} from './helpers/strict-timeline-wire-response-types.ts';


import type {ChildProcess as OwnedChild} from 'node:child_process';
import type {TypedStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, stat, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LAST_PROJECT_LIMITS,lastProjectEnvelopeSchema} from '@mioon/contracts/last-project';
import {schemas} from '@mioon/contracts';

import {createServerProject} from './helpers/project-database.ts';
import {createApplicationStorageReader} from './fixtures/project-server-process.ts';

const repo=fileURLToPath(new URL('../',import.meta.url));
const workerPath=fileURLToPath(new URL('./fixtures/local-drafts-process.ts',import.meta.url));
const token='synthetic-last-project-http-process-token';
const route='/api/last-project';
const write=(envelope:{workspaceScope:string;instanceId:string;revision:number},projectId:string)=>({workspaceScope:envelope.workspaceScope,instanceId:envelope.instanceId,expectedRevision:envelope.revision,projectId});
function deadline<T>(promise:Promise<T>, label: string, milliseconds: number|undefined = 10000) {
  let timer: string|number|NodeJS.Timeout|undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function request(url: string, route?: string|undefined, {method = 'GET', input, raw, authenticated = true, headers = {}, chunked = false}:LocatorOptions = {}) {
  const payload = raw ?? (input === undefined ? undefined : JSON.stringify(input));
  return new Promise<LocatorHttpResponse>((resolve, reject) => {
    const req = http.request(url + route, {method, path: route, agent: false, headers: {
      'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {}),
      ...(payload !== undefined && !chunked ? {'content-length': Buffer.byteLength(payload)} : {}), ...headers,
    }}, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 2 * 1024 * 1024) res.destroy(Error('Synthetic response cap')); });
      res.once('error', reject);
      res.once('end', () => {
        try { resolve({status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : null}); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(Error('Synthetic HTTP request timeout')));
    req.once('error', reject);
    req.end(payload);
  });
}

function startProcess(root: string, auditPath: string) {
  const selected=workerPath;
  const child = spawn(process.execPath, [selected, auditPath], {cwd: repo, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {PATH: process.env.PATH || '', HOME: root, TMPDIR: root, LANG: 'C.UTF-8', NODE_ENV: 'test',
      MIOON_ENABLE_LIVE_PROVIDER: '0'},
  });
  let output = '', outputBytes = 0, stopped: ProcessOutcome|undefined;
  // One inventoried text-consumer registration, shared by the two owned pipes.
  for (const stream of [child.stdout, child.stderr]) (stream)!.setEncoding('utf8').on('data', chunk => {
    output = (output + chunk).slice(-8000);
    outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + Buffer.byteLength(chunk));
  });
  const ready = Promise.withResolvers<BackendReady>(), exited = Promise.withResolvers<ProcessOutcome>(), pending = new Map<string,ReturnType<typeof Promise.withResolvers<{phases:unknown[];armed?:boolean}>>>();
  const rejectPending = (error: Error) => { ready.reject(error); for (const reply of pending.values()) reply.reject(error); };
  child.once('error', rejectPending);
  child.once('close', (code, signal) => {
    stopped = {code, signal};
    rejectPending(Object.assign(Error(`Owned backend closed (${code}, ${signal}); ${outputBytes} output bytes\n${output}`), {code: 'FIXTURE_EXITED'}));
    exited.resolve(stopped);
  });
  child.on('message', ((message:IpcMessage) => {
    if (message.type === 'ready') ready.resolve(message);
    else if (message.type === 'reply') pending.get(message.id)?.resolve(message.data);
    else if (message.type === 'fatal') rejectPending(Error(message.message));
  }) as unknown as Parameters<OwnedChild['on']>[1]);
  child.send!({type: 'start', root, token}, error => { if (error) rejectPending(error); });
  return {child, ready: ready.promise, exited: exited.promise,
    diagnostic: () => ({pid: child.pid, outputBytes, output, exitCode: child.exitCode, signalCode: child.signalCode}),
    async ask(type: unknown, fields:Record<string,unknown>={}) {
      assert.equal(stopped, undefined, 'fixture IPC cannot contact a stopped child');
      const id = randomUUID(), reply = Promise.withResolvers<{phases:unknown[];armed?:boolean}>(); pending.set(id, reply);
      child.send({type, id, ...fields}, error => { if (error) reply.reject(error); });
      try { return await deadline(reply.promise, 'fixture IPC'); } finally { pending.delete(id); }
    },
    async close() {
      if (stopped) return stopped;
      if (child.connected) child.send({type: 'close'}, () => {});
      try { return await deadline(exited.promise, 'owned backend close'); }
      catch (error) { child.kill('SIGKILL'); await deadline(exited.promise, 'owned backend kill'); throw error; }
    },
    async kill() {
      if (!stopped) child.kill('SIGKILL');
      const result = await deadline(exited.promise, 'owned backend crash');
      assert.deepEqual(result, {code: null, signal: 'SIGKILL'});
      return result;
    },
  };
}

async function fixture(t:test.TestContext){
  const base=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-last-project-http-'))),source=path.join(base,'source'),root=source;
  const auditPath=path.join(base,'forbidden-effects.jsonl');await writeFile(auditPath,'');
  const processes:ReturnType<typeof startProcess>[]=[],reservations:http.Server[]=[];let backend!:ReturnType<typeof startProcess>,url!:string,proxy!:http.Server,drop=false,appRead!:ReturnType<typeof createApplicationStorageReader>;const observed:LocatorHttpResponse[]=[];
  t.after(async()=>{
    const failures=[];
    for(const clean of [async()=>{if(proxy){proxy.closeAllConnections();await deadline(new Promise(resolve=>proxy.close(resolve)),'proxy close');}},...reservations.map(server=>async()=>{server.closeAllConnections();await deadline(new Promise(resolve=>server.close(resolve)),'reservation close');}),...processes.map(worker=>()=>worker.close()),()=>rm(base,{recursive:true,force:true})])try{await clean();}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Owned last-project cleanup failed');
  });
  let project:FixtureProject,other:FixtureProject;
  const remembered=createServerProject(source,{name:'Existing remembered project'});project=(remembered.store as unknown as TypedStore).get('projects',remembered.projectId)! as FixtureProject;remembered.store.close();
  const second=createServerProject(source,{name:'OTHER_PROJECT_MUST_NOT_LEAK'});other=(second.store as unknown as TypedStore).get('projects',second.projectId)! as FixtureProject;second.store.close();
  const file=path.join(root,'last-project-v1.json');
  const start=async()=>{
    backend=startProcess(root,auditPath);processes.push(backend);appRead=createApplicationStorageReader(backend.child);const ready=await deadline(backend.ready,'owned backend readiness');
    assert.equal(ready.pid,backend.child.pid);assert.notEqual(ready.pid,process.pid);url=ready.url;assert.equal(new URL(url).hostname,'127.0.0.1');
  };await start();
  proxy=http.createServer(async(req,res)=>{
    try{
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw Error('Synthetic proxy limit');chunks.push(chunk);}
      const raw=Buffer.concat(chunks);const response=await request(url,req.url,{method:req.method,...(raw.length?{raw}:{})});observed.push(response);
      if(drop){drop=false;res.destroy();return;}
      res.writeHead(response.status,{'content-type':'application/json'});res.end(JSON.stringify(response.body));
    }catch{res.destroy();}
  });await deadline(new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve as ()=>void);}),'proxy listen');
  const proxyUrl=`http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`;
  return {base,source,root,file,project,other,observed,get url(){return url;},get backend(){return backend;},
    request:(selected: string|undefined=route,options?:LocatorOptions)=>request(url,selected,options),viaProxy:(options?:LocatorOptions)=>request(proxyUrl,route,options),lose(){drop=true;},
    async data<S extends string=typeof route>(selected:S=route as S,options?:LocatorOptions):Promise<LocatorData<S>>{const result=await this.request(selected,options);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.ok,true);return result.body.data as unknown as LocatorData<S>;},
    async get(){const data=await this.data();assert.ok(lastProjectEnvelopeSchema.safeParse(data).success);return data;},
    async restart(){const oldUrl=url,oldPid=backend.child.pid;await backend.kill();const reserve=http.createServer((_req,res)=>res.end());reservations.push(reserve);await deadline(new Promise((resolve,reject)=>{reserve.once('error',reject);reserve.listen(Number(new URL(oldUrl).port),'127.0.0.1',resolve as ()=>void);}),'reserve old port');await start();assert.notEqual(url,oldUrl);assert.notEqual(backend.child.pid,oldPid);},
    async snapshot(){
      const app=await appRead();
      return {schema:app.schema,application:{...app.rows,app_documents:app.rows.app_documents.filter(row=>row.name!=='last-project-v1.json')},projects:await Promise.all([project,other].map(value=>backend.ask('snapshot',{projectId:value.id})))};
    },
    async bytes(){const row=(await appRead()).rows.app_documents.find(row=>row.name==='last-project-v1.json');if(typeof row?.data!=='string')throw Error('Expected the real app locator document');return Buffer.from(row.data);},
    metadata:()=>stat(path.join(root,'app-library.db')),
    corrupt:()=>backend.ask('corrupt-last-project-document'),
    async noEffects(){assert.equal(await readFile(auditPath,'utf8'),'');assert.deepEqual(((await backend.ask('observe')).phases as unknown),[]);},
  };
}
const safeError=(response:LocatorHttpResponse<unknown>,f:{root:string},code:string,status=400)=>{
  assert.equal(response.status,status,JSON.stringify(response.body));assert.equal(response.body.ok,false);assert.equal(response.body.error.code,code);
  assert.equal(response.body.error.retryable,false);assert.deepEqual(response.body.error.details,{});
  for(const secret of [token,f.root,'OTHER_PROJECT_MUST_NOT_LEAK','SECRET_FIELD_MUST_NOT_PERSIST'])assert.equal(JSON.stringify(response.body).includes(secret),false);
};

test('actual HTTP rediscovery survives owned SIGKILL and a new listener without GET writes or domain effects',{timeout:30000},async t=>{
  const f=await fixture(t),before=await f.snapshot(),initial=await f.get();assert.equal(initial.targetStatus,'unset');assert.equal(initial.revision,0);await assert.rejects(stat(f.file),{code:'ENOENT'});
  const input=write(initial,f.project.id),saved=await f.data(route,{method:'PUT',input});assert.equal(saved.revision,1);assert.equal(saved.targetStatus,'matching');
  const bytes=await f.bytes(),metadata=await f.metadata();assert.equal(metadata.mode&0o777,0o600);assert.deepEqual(await f.snapshot(),before);await f.noEffects();
  await f.restart();const found=await f.get();assert.equal(found.workspaceScope,saved.workspaceScope);assert.notEqual(found.instanceId,saved.instanceId);assert.deepEqual({...found,instanceId:saved.instanceId},saved);
  safeError(await f.request(route,{method:'PUT',input}),f,'LAST_PROJECT_STALE_INSTANCE',409);
  for(let index=0;index<3;index++)assert.deepEqual((await f.viaProxy()).body.data,found);
  assert.deepEqual(await f.bytes(),bytes);assert.equal((await f.metadata()).mtimeMs,metadata.mtimeMs);assert.deepEqual(await f.snapshot(),before);await f.noEffects();
});

test('lost acknowledgement is rediscovered and exact retry does not write twice; stale conflicting selection cannot rebase',{timeout:30000},async t=>{
  const f=await fixture(t),initial=await f.get(),input=write(initial,f.project.id);f.lose();await assert.rejects(f.viaProxy({method:'PUT',input}));
  const accepted=f.observed.at(-1)!.body.data;assert.equal(accepted.revision,1);const bytes=await f.bytes(),metadata=await f.metadata();
  assert.deepEqual(await f.get(),accepted);assert.deepEqual(await f.data(route,{method:'PUT',input}),accepted);assert.deepEqual(await f.bytes(),bytes);assert.equal((await f.metadata()).mtimeMs,metadata.mtimeMs);
  safeError(await f.request(route,{method:'PUT',input:write(initial,f.other.id)}),f,'LAST_PROJECT_CONFLICT',409);
  const second=await f.data(route,{method:'PUT',input:write(accepted,f.other.id)});assert.equal(second.revision,2);
  safeError(await f.request(route,{method:'PUT',input}),f,'LAST_PROJECT_CONFLICT',409);assert.deepEqual(await f.get(),second);await f.noEffects();
});

test('private HTTP preserves token and cookie auth, Host/Origin checks, strict methods, fields and byte limits',{timeout:30000},async t=>{
  const f=await fixture(t),initial=await f.get(),input=write(initial,f.project.id),before=await f.snapshot();
  for(const method of ['GET','PUT']){
    const options={method,...(method==='PUT'?{input}:{})};
    for(const headers of [{},{authorization:'Bearer wrong'}])assert.equal((await f.request(route,{...options,authenticated:false,headers})).status,401);
    for(const headers of [{host:'foreign.invalid'},{origin:'null'},{origin:'https://foreign.invalid'}])assert.equal((await f.request(route,{...options,headers})).status,403);
  }
  const login=await f.request('/api/login',{method:'POST',input:{token},authenticated:false});assert.equal(login.status,200);const cookie=login.headers['set-cookie']![0].split(';')[0];assert.match(login.headers['set-cookie']![0],/HttpOnly; SameSite=Strict/);
  const cookieRead=await f.request(route,{authenticated:false,headers:{cookie,origin:f.url}});assert.equal(cookieRead.status,200);assert.equal(cookieRead.headers['cache-control'],'no-store');assert.equal(cookieRead.headers['x-content-type-options'],'nosniff');
  for(const bad of [{...input,extra:true},{...input,expectedRevision:-1},{...input,expectedRevision:0.5},{...input,expectedRevision:Number.MAX_SAFE_INTEGER+1},{...input,path:'SECRET_FIELD_MUST_NOT_PERSIST'},{...input,projectId:'bad'}])safeError(await f.request(route,{method:'PUT',input:bad}),f,'LAST_PROJECT_VALIDATION');
  for(const raw of ['{','null','[]','true','{"__proto__":{}}',Buffer.from([0xff])])safeError(await f.request(route,{method:'PUT',raw}),f,'LAST_PROJECT_VALIDATION');
  for(const headers of [{'content-type':'text/plain'},{'content-encoding':'gzip'}])safeError(await f.request(route,{method:'PUT',input,headers}),f,'LAST_PROJECT_VALIDATION');
  for(const chunked of [false,true])safeError(await f.request(route,{method:'PUT',chunked,raw:JSON.stringify(input)+' '.repeat(LAST_PROJECT_LIMITS.httpBytes)}),f,'LAST_PROJECT_LIMIT',413);
  for(const query of ['?projectId='+f.project.id,'?x=1&x=2','?','?workspaceScope=x'])safeError(await f.request(route+query),f,'LAST_PROJECT_VALIDATION');
  safeError(await f.request(route+'?x='+'x'.repeat(LAST_PROJECT_LIMITS.urlBytes)),f,'LAST_PROJECT_LIMIT',413);
  for(const method of ['POST','DELETE','PATCH','OPTIONS']){const response=await f.request(route,{method});assert.equal(response.status,405);assert.equal(response.headers.allow,'GET, PUT');}
  safeError(await f.request(route+'/anything'),f,'LAST_PROJECT_NOT_FOUND',404);
  safeError(await f.request(route,{method:'PUT',input:{...input,workspaceScope:'f'.repeat(64)}}),f,'LAST_PROJECT_SCOPE_MISMATCH',409);
  safeError(await f.request(route,{method:'PUT',input:{...input,instanceId:randomUUID()}}),f,'LAST_PROJECT_STALE_INSTANCE',409);
  safeError(await f.request(route,{method:'PUT',input:{...input,projectId:randomUUID()}}),f,'LAST_PROJECT_NOT_FOUND',404);
  await assert.rejects(stat(f.file),{code:'ENOENT'});assert.deepEqual(await f.snapshot(),before);await f.noEffects();
});

test('route and storage failure are private, nonrepairing and absent from the operation catalog',{timeout:30000},async t=>{
  const f=await fixture(t),initial=await f.get(),input=write(initial,f.project.id);
  assert.equal((await f.data(route,{method:'PUT',input})).revision,1,'the fault targets the actual app document');
  const before=await f.snapshot();
  assert.equal(Object.keys(schemas).some(name=>/last[.-]?project/i.test(name)),false);
  for(const operation of ['last-project.get','last-project.put','lastProject.get','lastProject.put']){const result=await f.request('/api/rpc',{method:'POST',input:{operation,input}});assert.equal(result.status,404);assert.equal(result.body.error.code,'UNKNOWN_OPERATION');}
  await f.corrupt();const bytes=await f.bytes();
  safeError(await f.request(),f,'LAST_PROJECT_STORAGE_UNAVAILABLE',503);safeError(await f.request(route,{method:'PUT',input}),f,'LAST_PROJECT_STORAGE_UNAVAILABLE',503);
  assert.deepEqual(await f.bytes(),bytes);assert.deepEqual(await f.snapshot(),before);await f.noEffects();
});
