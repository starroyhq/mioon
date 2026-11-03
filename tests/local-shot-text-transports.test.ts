import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {CONVERTED_TEMP_TRIGGERS} from '../packages/business/src/project-file/cross-file/converted-triggers.ts';
import {projectApiPath,projectRpcPath} from '../packages/contracts/src/project-file.ts';
import type {RpcEnvelope} from './helpers/strict-timeline-audio-types.ts';
import type {OrdinaryDeliveryEnvelope} from './helpers/strict-timeline-audio-draft-types.ts';
import type {LocalShotTextSupported} from '../apps/web/src/local-shot-text-state.ts';
import type {FixtureExport} from './helpers/strict-timeline-core-types.ts';
import type {MediaShot} from './helpers/strict-service-responses.ts';
type WireEnvelope=LocalShotTextSupported;
type WireExecution={envelope:WireEnvelope;response:MediaShot|null};
type WireResponse<T=WireEnvelope>={status:number;body:RpcEnvelope<T>};
interface WireOptions{method?:string;input?:unknown;headers?:Record<string,string>;authenticated?:boolean}
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,readFile,stat,rm} from 'node:fs/promises';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {createServices,canonical} from '../packages/business/src/services.ts';
import {createServerProject} from './helpers/project-database.ts';
import {readProjectState} from './helpers/project-state.ts';
import {schemas} from '@mioon/contracts';
import {createLocalShotTextSchemas,isLocalShotTextMutationResponse} from '@mioon/contracts/local-shot-text';
const token='synthetic-local-shot-text-http-token',route=(projectId:string)=>projectApiPath(projectId,'local-shot-text');
const sha=(value: import("node:crypto").BinaryLike)=>createHash('sha256').update(value).digest('hex');
const contract=createLocalShotTextSchemas(value=>schemas['shot.update'].safeParse(value).success);
const authority=(value: WireEnvelope)=>({workspaceScope:value.workspaceScope,instanceId:value.instanceId,projectId:value.projectId,shotId:value.shotId});
const execution=(value: WireEnvelope)=>({...authority(value),intentId:value.intent!.intentId,expectedIntentRevision:value.intentRevision});
function request<T=WireEnvelope>(url: string,suffix: string|undefined,{method='GET',input,headers={},authenticated=true}: WireOptions={}){const payload=input===undefined?undefined:JSON.stringify(input);return new Promise<WireResponse<T>>((resolve,reject)=>{const req=http.request(url+suffix,{method,agent:false,headers:{'content-type':'application/json',...(authenticated?{authorization:`Bearer ${token}`} : {}),...(payload?{'content-length':Buffer.byteLength(payload)}:{}),...headers}},res=>{let text='',bytes=0;res.setEncoding('utf8');res.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>2*1024*1024){res.destroy(Error('Synthetic response limit'));return;}text+=chunk;});res.once('error',reject);res.once('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(text)});}catch(error){reject(error);}});});req.setTimeout(10000,()=>req.destroy(Error('Synthetic HTTP deadline')));req.once('error',reject);req.end(payload);});}
async function fixture(t: test.TestContext){const parent=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-shot-text-wire-'))),root=path.join(parent,'workspace');let server:Awaited<ReturnType<typeof startServer>>,proxy: http.Server<typeof http.IncomingMessage,typeof http.ServerResponse>;
 // Filled before the server starts and closed before it does; every start
 // hands over that server's own connection.
 const created=createServerProject(root,{name:'Synthetic local shot HTTP recovery'}),store=(created.store as unknown as TypedStore),services=(createServices(store,new Map()) as TypedServices),project={id:created.projectId};let shot;let inspect!:InspectProject;
 try{shot=await services.call('shot.create',{projectId:project.id,title:'Saved title',prompt:'Saved prompt',duration:7,aspectRatio:'16:9',parameters:{seed:42}});}finally{await services.drain();store.close();}
 t.after(async()=>{try{if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}await server?.close();}finally{await rm(parent,{recursive:true,force:true});}});
 const start=async()=>server=await startServer({dataDir:root,port:0,token,inspectProject:received=>{inspect=received;}});await start();
 const call=async<T=WireEnvelope>(suffix:string,options?: WireOptions)=>{const result=await request<T>(server.url,suffix,options);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.ok,true);return result.body.data;};const get=()=>call(`${route(project.id)}?projectId=${project.id}&shotId=${shot.id}`);
 const put=(value: WireEnvelope,raw: unknown)=>({...authority(value),expectedDraftRevision:value.draftRevision,draftId:value.draft?.draftId??randomUUID(),baseRevision:shot.revision,baseText:{title:shot.title,prompt:shot.prompt},raw});
 const prepare=(value: WireEnvelope)=>({...authority(value),expectedIntentRevision:value.intentRevision,expectedIntentId:value.intent?.intentId??null,intentId:randomUUID(),baseRevision:shot.revision,baseText:value.draft!.baseText,draft:{draftId:value.draft!.draftId,revision:value.draftRevision,raw:value.draft!.raw},input:{shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),patch:value.draft!.raw}});
 // The running server holds the project, so rows() reads on its own
 // connection. The callback is synchronous, so no write lands between its
 // reads, and the server's connection is never switched to query_only.
 const rows=()=>inspect(project.id,db=>{
  const state=readProjectState(db),taskObject=(name:string)=>!name.startsWith('project_file_')&&/(?:^|_)agent_(?:task|target)_/u.test(name);
  const manifest=Object.values(SCHEMA_MANIFEST).flatMap(value=>[...value.entries]);
  const sort=<T extends {type:string;name:string}>(rows:T[])=>rows.sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name));
  const expected=sort([...manifest.filter(entry=>taskObject(entry.name)),...CONVERTED_TEMP_TRIGGERS.filter(entry=>taskObject(entry.name)).map(entry=>({
    type:'trigger',name:entry.name,tbl_name:entry.table,sha256:sha(entry.sql.replace('CREATE TEMP TRIGGER ','CREATE TRIGGER ')),
  }))]);
  const objects=sort(state.schema.filter(entry=>taskObject(entry.name)).map(({type,name,tbl_name,sql})=>({type,name,tbl_name,sha256:sha(sql??'')})));
  assert.deepEqual(objects,expected,'independent pinned project/history/TEMP task and target SQL');
  assert.equal(objects.length,expected.length);
  assert.equal(sha(JSON.stringify(objects)),sha(JSON.stringify(expected)),'exact pinned kernel catalog');
  assert.deepEqual(objects.filter(value=>!expected.some(entry=>entry.name===value.name)),[],'unknown task/target objects are not reviewed additions');
  const knownTables=new Set(manifest.filter(entry=>entry.type==='table').map(entry=>entry.name));
  for(const name of Object.keys(state.tables))assert.ok(knownTables.has(name),'only pinned project/history/cache tables enter the snapshot');
  return {shots:db.prepare('SELECT * FROM shots ORDER BY rowid').all(),receipts:db.prepare('SELECT * FROM mutation_requests ORDER BY rowid').all(),tables:state.tables};
 });
 return {root,project,shot,get,call,put,prepare,rows,get url(){return server.url;},file:path.join(created.store.localDir,'local-shot-text-v1.json'),async restart(){await server.close();await start();},
 async dropNextExecution(){const observed=Promise.withResolvers<WireResponse<WireExecution>>();void observed.promise.catch(()=>{});proxy=http.createServer(async(req,res)=>{try{let raw='';req.setEncoding('utf8');for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>256*1024)throw Error('Synthetic request limit');}const result=await request<WireExecution>(server.url,req.url,{method:req.method,input:JSON.parse(raw)});observed.resolve(result);res.destroy();}catch(error){observed.reject(error);res.destroy();}});await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});return {url:`http://127.0.0.1:${(proxy.address()! as import('node:net').AddressInfo).port}`,observed:observed.promise};}};
}
test('authenticated HTTP raw title/prompt draft is durable without business writes; GET never creates',{timeout:30000},async t=>{
 const f=await fixture(t);
 // Account for the host's daily version before proving every draft read/write leaves the database identical.
 const opened=await request<Record<string,unknown>>(f.url,projectRpcPath(f.project.id),{method:'POST',input:{operation:'project.inspect',input:{projectId:f.project.id}}});
 assert.equal(opened.status,200);assert.equal(opened.body.ok,true);
 const before=f.rows();
 assert.equal(before.tables.project_versions.filter(row=>row.projectId===f.project.id&&row.trigger==='daily-open').length,1);
 assert.equal(before.tables.project_version_capture_marks.filter(row=>row.projectId===f.project.id&&row.kind==='daily-open').length,1);
 const initial=await f.get();assert.equal(initial.draft,null);assert.equal(initial.intent,null);await assert.rejects(stat(f.file),{code:'ENOENT'});const raw={title:'',prompt:'invalid-for-save bounded raw prompt\n界🙂'};const saved=await f.call(route(f.project.id)+'/draft',{method:'PUT',input:f.put(initial,raw)});assert.deepEqual(saved.draft!.raw,raw);assert.deepEqual(f.rows(),before);const bytes=await readFile(f.file),info=await stat(f.file);assert.equal(info.mode&0o777,0o600);await f.get();assert.deepEqual(await readFile(f.file),bytes);assert.deepEqual(f.rows(),before);assert.equal((await request(f.url,route(f.project.id)+'/prepare',{method:'POST',input:f.prepare(saved)})).status,400);assert.deepEqual(f.rows(),before);assert.deepEqual(await readFile(f.file),bytes);
 for(const options of [{authenticated:false},{headers:{origin:'https://foreign.example'}}]){const denied=await request(f.url,`${route(f.project.id)}?projectId=${f.project.id}&shotId=${f.shot.id}`,options);assert.ok([401,403].includes(denied.status));assert.equal(JSON.stringify(denied.body).includes(raw.prompt),false);}
 for(const suffix of [`${route(f.project.id)}?projectId=${f.project.id}&shotId=${f.shot.id}&extra=1`,`${route(f.project.id)}?projectId=${f.project.id}&shotId=${f.shot.id}&shotId=${f.shot.id}`,`${route(f.project.id)}?projectId=${f.project.id}`])assert.equal((await request(f.url,suffix)).status,400);
});
test('real HTTP drops downstream 200 only after shared shot receipt commits; recreated backend recovers same raw receipt',{timeout:45000},async t=>{const f=await fixture(t),initial=await f.get();let current=await f.call(route(f.project.id)+'/draft',{method:'PUT',input:f.put(initial,{title:'恢复标题 · 原始请求',prompt:'恢复提示 🎬\nexact original text'})});const input=f.prepare(current);current=await f.call(route(f.project.id)+'/prepare',{method:'POST',input});const frozen=structuredClone(current.intent),before=f.rows();assert.equal(current.intent!.outcome.status,'pending');const proxy=await f.dropNextExecution();await assert.rejects(request(proxy.url,route(f.project.id)+'/execute',{method:'POST',input:execution(current)}));const upstream=await proxy.observed;assert.equal(upstream.status,200);assert.ok(contract.execution.safeParse(upstream.body.data).success);const applied=upstream.body.data;assert.equal(applied.envelope.intent!.outcome.status,'applied');assert.ok(isLocalShotTextMutationResponse(f.project.id,applied.envelope.intent!,applied.response));assert.equal(Object.hasOwn(applied.response,'status'),false,'Saved-shot receipt never becomes a queued-export ACK');const committed=f.rows(),receipt=committed.receipts.find(row=>row.requestId===input.input.requestId);assert.ok(receipt);assert.equal(committed.receipts.length,before.receipts.length+1);assert.equal(JSON.parse((committed.shots[0].data as string)).revision,f.shot.revision+1);const {requestId,...fields}=input.input;assert.equal(receipt.canonicalInput,canonical(fields));assert.deepEqual(JSON.parse((receipt.response as string)),applied.response);
 await f.restart();const rediscovered=await f.get(),bytes=await readFile(f.file);assert.equal(rediscovered.workspaceScope,initial.workspaceScope);assert.notEqual(rediscovered.instanceId,initial.instanceId);assert.equal(rediscovered.intent!.intentId,frozen!.intentId);assert.deepEqual(rediscovered.intent!.input,frozen!.input);assert.equal(rediscovered.draft,null);assert.deepEqual(f.rows(),committed);await f.get();assert.deepEqual(await readFile(f.file),bytes);assert.deepEqual(f.rows(),committed);
 const recovered=await f.call<WireExecution>(route(f.project.id)+'/recover',{method:'POST',input:execution(rediscovered)});assert.deepEqual(recovered.response,applied.response);assert.deepEqual(f.rows(),committed);assert.deepEqual(f.rows().receipts.find(row=>row.requestId===input.input.requestId),receipt);assert.equal(sha(JSON.stringify(recovered.response)),sha(receipt.response as string));const stale=await request(f.url,route(f.project.id)+'/execute',{method:'POST',input:execution(current)});assert.equal(stale.status,409);assert.deepEqual(f.rows(),committed);for(const key of ['duration','aspectRatio','parameters','referenceAssetIds','selectedVersionId','position'])assert.deepEqual(recovered.response[key],f.shot[key]);
});
test('two actual HTTP windows dispatch one exact shot update and retain a newer text draft',{timeout:45000},async t=>{const f=await fixture(t),initial=await f.get(),saved=await f.call(route(f.project.id)+'/draft',{method:'PUT',input:f.put(initial,{title:'Captured title',prompt:'Captured prompt'})}),input=f.prepare(saved),pending=await f.call(route(f.project.id)+'/prepare',{method:'POST',input});const alternative={...input,intentId:randomUUID(),input:{...input.input,requestId:randomUUID()}};assert.equal((await request(f.url,route(f.project.id)+'/prepare',{method:'POST',input:alternative})).status,409);const newer=await f.call(route(f.project.id)+'/draft',{method:'PUT',input:f.put(pending,{title:'Newer title',prompt:'Newer prompt'})});const results=await Promise.all([request(f.url,route(f.project.id)+'/execute',{method:'POST',input:execution(pending)}),request(f.url,route(f.project.id)+'/recover',{method:'POST',input:execution(pending)})]);assert.ok(results.some(result=>result.status===200));for(const result of results)assert.ok([200,409].includes(result.status));const observed=await f.get();assert.equal(observed.intent!.input.requestId,input.input.requestId);assert.equal(observed.intent!.outcome.status,'applied');assert.deepEqual(observed.draft,newer.draft);const rows=f.rows();assert.equal(JSON.parse((rows.shots[0].data as string)).revision,f.shot.revision+1);assert.equal(rows.receipts.filter(row=>row.requestId===input.input.requestId).length,1);
});
