import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {WORKSPACE_LUT_SCHEMA_SQL} from '../packages/business/src/workspace-schema-v28.ts';
import {createLutResourceServices,assertLutReadProfile} from '../packages/business/src/lut-resources.ts';
import {createLookPackInspectionServices} from '../packages/business/src/look-pack-inspection.ts';
import {LOOK_PACK_START,LOOK_PACK_END} from '../packages/contracts/src/look-pack.ts';
import {lookPackInspectInputSchema,lookPackInspectResponseSchema,isLookPackInspectResponse} from '../packages/contracts/src/look-pack-inspection.ts';
import {LUT_RESOURCE_PROFILE,lutRestorePolicy} from '../packages/contracts/src/lut-resources.ts';
import {schemas,operationEffect,effectAnnotations} from '../packages/contracts/src/index.ts';
import {createClient,discoverSchema} from '../packages/client/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {RESTORE_READ_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';

const body=Buffer.from('# Original lexical Cube\r\nTITLE "Look original"\r\nLUT_3D_SIZE 2\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1');
const hash=value=>createHash('sha256').update(value).digest('hex');
function packBytes(patch={}){
 const manifest={schemaVersion:1,kind:'look-pack',id:'test.look',version:'1.0.0',title:'Original creative look',
  publisher:{id:'example.publisher',name:'Declared Publisher'},provenance:{url:'https://example.invalid/declared-only'},
  license:{identifier:'LicenseRef-Declared',text:'Publisher declaration only. User must verify their right to use this look.'},
  asset:{id:'test.look.asset',purpose:'rec709-sdr-creative',profile:LUT_RESOURCE_PROFILE,input:'rec709-sdr',output:'rec709-sdr',sha256:hash(body),sizeBytes:body.length},...patch};
 const json=JSON.stringify(manifest),lines=[];for(let offset=0;offset<json.length;offset+=200)lines.push('# '+json.slice(offset,offset+200));
 return Buffer.concat([Buffer.from([LOOK_PACK_START,...lines,LOOK_PACK_END,''].join('\r\n')),body]);
}
function fixture(t,source=packBytes()){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);'+WORKSPACE_LUT_SCHEMA_SQL);
 const projectId=randomUUID(),foreignId=randomUUID();for(const id of [projectId,foreignId])db.prepare('INSERT INTO projects VALUES(?,?)').run(id,JSON.stringify({id}));
 const state={owned:true,version:null};const controller=new AbortController();
 const runtime={ownsLock:()=>state.owned,assertReadable(){if(state.version!==null)assertLutReadProfile(state.version);},assertImportAllowed(){}};
 const imports=createLutResourceServices({db},{runtime}).handlers;
 const handlers=createLookPackInspectionServices({db},{runtime,signal:controller.signal}).handlers;
 const importInput={projectId,requestId:'exact-original-look-pack',name:'original.look.cube',dataBase64:source.toString('base64')};
 const imported=imports['lut.import'](importInput);const input={projectId,lutId:imported.resource.id};
 t.after(()=>db.close());return {db,state,controller,projectId,foreignId,imports,handlers,input,importInput,imported,source};
}
const totalChanges=db=>db.prepare('SELECT total_changes() AS n').get().n;
const snapshot=db=>({schema:db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),projects:db.prepare('SELECT * FROM projects ORDER BY id').all(),resources:db.prepare('SELECT * FROM project_lut_resources ORDER BY id').all(),receipts:db.prepare('SELECT * FROM lut_import_requests ORDER BY requestId').all(),changes:totalChanges(db)});
function metadataOnly(result,bytes){
 const json=JSON.stringify(result);
 assert.equal(json.includes(bytes.toString('base64')),false);assert.equal(json.includes(body.toString('utf8')),false);
 const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,nested] of Object.entries(value)){
  assert.equal(['bytes','content','dataBase64','path','relativePath','assetId','resourceUrl'].includes(key),false,key);visit(nested);
 }};visit(result);
}

test('existing lut.import stores and replays exact pack bytes; inspection is metadata only and changes no row',async t=>{
 const f=fixture(t),before=snapshot(f.db),result=await f.handlers['lut.look.inspect'](f.input);
 assert.deepEqual(f.imports['lut.import'](f.importInput),f.imported);
 assert.deepEqual(Buffer.from(f.db.prepare('SELECT content FROM project_lut_resources').get().content),f.source);
 assert.deepEqual(result.resource,f.imported.resource);assert.equal(result.resource.sha256,hash(f.source));
 assert.equal(result.status,'verified');assert.equal(result.integrity,'verified');assert.equal(result.pack.bodyIntegrity,'verified');
 assert.equal(result.pack.provenanceVerification,'unverified');assert.equal(result.pack.colourCompatibility,'unverified');assert.equal(result.pack.licenseAcknowledgementRequired,true);
 assert.equal(result.pack.manifest.provenance.url,'https://example.invalid/declared-only');
 assert.equal(isLookPackInspectResponse(result,f.input),true);metadataOnly(result,f.source);assert.deepEqual(snapshot(f.db),before);
});

test('ordinary Cube gets explicit not_pack, never a fabricated manifest or extra persistence',async t=>{
 const f=fixture(t,body),before=snapshot(f.db);
 assert.deepEqual(await f.handlers['lut.look.inspect'](f.input),{resource:f.imported.resource,integrity:'verified',status:'not_pack',pack:null});
 assert.deepEqual(snapshot(f.db),before);
});

test('malformed reserved markers and hash-mismatched declarations fail explicitly without ordinary fallback',async t=>{
 const cases=[Buffer.concat([Buffer.from('# MIOON_LOOK_PACK_V9\n'),body]),
  Buffer.from(packBytes().toString('utf8').replace('MIOON_LOOK_PACK_END','MIOON_LOOK_PACK_BROKEN')),
  packBytes({asset:{id:'test.look.asset',purpose:'rec709-sdr-creative',profile:LUT_RESOURCE_PROFILE,input:'rec709-sdr',output:'rec709-sdr',sha256:'f'.repeat(64),sizeBytes:body.length}})];
 for(const source of cases){const f=fixture(t,source),before=snapshot(f.db);
  await assert.rejects(f.handlers['lut.look.inspect'](f.input),error=>/^LOOK_PACK_/u.test(error.code)&&error.status===400);
  assert.deepEqual(snapshot(f.db),before);
 }
});

test('foreign and absent resources disclose nothing; invalid storage hash or parser metadata fails closed',async t=>{
 const f=fixture(t),before=snapshot(f.db);
 for(const input of [{...f.input,projectId:f.foreignId},{...f.input,projectId:randomUUID()},{...f.input,lutId:randomUUID()}])await assert.rejects(f.handlers['lut.look.inspect'](input),{code:'LUT_NOT_FOUND'});
 assert.deepEqual(snapshot(f.db),before);
 f.db.exec('DROP TRIGGER immutable_project_lut_resources');f.db.prepare('UPDATE project_lut_resources SET content=?').run(Buffer.from(f.source.toString('utf8').replace('Look original','Look modified')));
 await assert.rejects(f.handlers['lut.look.inspect'](f.input),{code:'LUT_RESOURCE_INVALID'});
 const other=fixture(t);other.db.exec('DROP TRIGGER immutable_project_lut_resources');const metadata={...other.imported.resource.metadata,title:'Forged title'};
 other.db.prepare('UPDATE project_lut_resources SET metadata=?').run(JSON.stringify(metadata));await assert.rejects(other.handlers['lut.look.inspect'](other.input),{code:'LUT_RESOURCE_INVALID'});
});

test('bounded SQL refuses over-limit blobs before materialization',async t=>{
 const f=fixture(t),queries=[];
 const facade={prepare(sql){queries.push(sql);return f.db.prepare(sql);}};
 const inspect=createLookPackInspectionServices({db:facade},{runtime:{ownsLock:()=>true,assertReadable(){}}}).handlers['lut.look.inspect'];
 await inspect(f.input);
 for(const sql of queries)assert.doesNotMatch(sql,/SELECT\s+\*/iu);
 const blobs=queries.filter(sql=>sql.includes(' AS content'));
 assert.ok(blobs.length>=1);assert.ok(blobs.every(sql=>sql.includes("typeof(content)='blob'")&&sql.includes('length(content) BETWEEN 1 AND 7340032')&&sql.includes('WHERE projectId=? AND id=?')));
});

test('plain input guard rejects getters, symbols, proxies, inherited and extra fields without invoking them',async t=>{
 const f=fixture(t);let touched=0;
 const getter={...f.input};Object.defineProperty(getter,'projectId',{enumerable:true,get(){touched++;return f.projectId;}});
 const proxy=new Proxy(f.input,{get(){touched++;throw Error('trap');},getPrototypeOf(){touched++;throw Error('trap');},ownKeys(){touched++;throw Error('trap');}});
 const revoked=Proxy.revocable(f.input,{});revoked.revoke();
 for(const input of [getter,proxy,revoked.proxy,Object.create(f.input),{...f.input,path:'/private/look.cube'},{...f.input,[Symbol('extra')]:true}])
  await assert.rejects(f.handlers['lut.look.inspect'](input),{code:'VALIDATION_ERROR'});
 assert.equal(touched,0);
});

test('lease, cancellation and resource identity are rechecked after asynchronous verification',async t=>{
 const lost=fixture(t),pending=lost.handlers['lut.look.inspect'](lost.input);lost.state.owned=false;await assert.rejects(pending,{code:'LUT_OWNER_REQUIRED'});
 const aborted=fixture(t),waiting=aborted.handlers['lut.look.inspect'](aborted.input);aborted.controller.abort();await assert.rejects(waiting,{code:'LUT_OWNER_REQUIRED'});
 const changed=fixture(t),reading=changed.handlers['lut.look.inspect'](changed.input);changed.db.exec('DROP TRIGGER immutable_project_lut_resources');changed.db.prepare("UPDATE project_lut_resources SET name='changed'").run();await assert.rejects(reading,{code:'LUT_RESOURCE_INVALID'});
});

test('read availability is limited to restored29/31; old restored profiles refuse before resource disclosure',async t=>{
 const f=fixture(t);assert.ok(RESTORE_READ_OPERATIONS.includes('lut.look.inspect'));
 for(const version of [25,27,29,31]){
  f.state.version=version;assert.equal(lutRestorePolicy('lut.look.inspect',version).available,[29,31].includes(version));
  if([29,31].includes(version))assert.equal((await f.handlers['lut.look.inspect'](f.input)).status,'verified');
  else await assert.rejects(f.handlers['lut.look.inspect'](f.input),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 }
});

test('client validates input scope, strict response shape, claims and pack-to-resource binding without retry',async t=>{
 const f=fixture(t),valid=await f.handlers['lut.look.inspect'](f.input);
 const clientFor=(value,onCall=()=>{})=>createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:9999',MIOON_TOKEN:'a'.repeat(64)},fetchImpl:async()=>{onCall();return new Response(JSON.stringify({ok:true,data:value}),{status:200});}});
 assert.deepEqual(await clientFor(valid).rpc('lut.look.inspect',f.input),valid);
 const bad=[{...valid,resource:{...valid.resource,projectId:f.foreignId}}, {...valid,resource:{...valid.resource,id:randomUUID()}},
  {...valid,content:'raw'}, {...valid,status:'not_pack'}, {...valid,pack:null}, {...valid,pack:{...valid.pack,sizeBytes:valid.pack.sizeBytes+1}},
  {...valid,pack:{...valid.pack,cubeMetadata:{...valid.pack.cubeMetadata,title:'Other'}}},
  {...valid,pack:{...valid.pack,provenanceVerification:'certified'}}, {...valid,pack:{...valid.pack,licenseAcknowledgementRequired:false}}];
 for(const value of bad){let calls=0;assert.equal(lookPackInspectResponseSchema.safeParse(value).success&&isLookPackInspectResponse(value,f.input),false);
  await assert.rejects(clientFor(value,()=>calls++).rpc('lut.look.inspect',f.input),{code:'BACKEND_PROTOCOL_ERROR'});assert.equal(calls,1);
 }
 let touched=0,calls=0;const input={...f.input};Object.defineProperty(input,'lutId',{enumerable:true,get(){touched++;return f.input.lutId;}});
 await assert.rejects(clientFor(valid,()=>calls++).rpc('lut.look.inspect',input),{code:'VALIDATION_ERROR'});
 await assert.rejects(clientFor(valid,()=>calls++).rpc('lut.look.inspect',new Proxy(f.input,{getPrototypeOf(){touched++;throw Error();}})),{code:'VALIDATION_ERROR'});
 assert.equal(touched,0);assert.equal(calls,0);
});

test('API CLI MCP share discovery and read-only effects; built-in Agent tool authority stays unchanged',()=>{
 assert.equal(schemas['lut.look.inspect'],lookPackInspectInputSchema);const definition=discoverSchema({operation:'lut.look.inspect'});
 assert.equal(definition.toolName,'lut_look_inspect');assert.equal(definition.command,'lut look inspect');assert.equal(definition.requiresRequestId,false);
 assert.deepEqual(definition.inputSchema.required,['projectId','lutId']);assert.equal(definition.inputSchema.additionalProperties,false);
 assert.deepEqual(effectAnnotations(operationEffect('lut.look.inspect')),{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 for(const key of ['databaseWrite','fileWrite','externalIO','localProcess','paidGeneration'])assert.equal(definition.effects[key],false);
 for(const file of ['read-tool-policy.ts','read-tool-runner.ts','tool-wire.ts'])assert.equal(readFileSync(new URL('../packages/business/src/agent/'+file,import.meta.url),'utf8').includes('lut.look.inspect'),false);
 const implementation=readFileSync(new URL('../packages/business/src/look-pack-inspection.ts',import.meta.url),'utf8');
 for(const forbidden of ['node:fs','node:child_process','node:http','node:https','fetch(','INSERT INTO','UPDATE main.','DELETE FROM'])assert.equal(implementation.includes(forbidden),false,forbidden);
});

test('real shared service and cold restore31 return awaited metadata and preserve exact bytes without file or timeline mutations',async t=>{
 const base=mkdtempSync(path.join(os.tmpdir(),'mioon-look-inspect-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'source'),source=packBytes();let store=openStore(root),services=createServices(store,new Map());
 const project=await services.call('project.create',{name:'Look Pack inspection'}),input={projectId:project.id,requestId:'shared-look-original',name:'look.cube',dataBase64:source.toString('base64')};
 const imported=await services.call('lut.import',input),inspectInput={projectId:project.id,lutId:imported.resource.id};
 const before=totalChanges(store.db),result=await services.call('lut.look.inspect',inspectInput);assert.equal(result.status,'verified');assert.equal(totalChanges(store.db),before);
 let touched=0;const malicious={...inspectInput};Object.defineProperty(malicious,'lutId',{enumerable:true,get(){touched++;return inspectInput.lutId;}});
 await assert.rejects(services.call('lut.look.inspect',malicious),{code:'VALIDATION_ERROR'});assert.equal(touched,0);
 assert.deepEqual(readdirSync(path.join(root,'media')),[]);await services.drain();store.close();
 store=openStore(root);services=createServices(store,new Map());assert.deepEqual(await services.call('lut.import',input),imported);assert.deepEqual(await services.call('lut.look.inspect',inspectInput),result);await services.drain();store.close();
 const backup=path.join(base,'backup'),destination=path.join(base,'restored');await createWorkspaceBackup({source:root,destination:backup});await restoreWorkspaceBackup({directory:backup,destination});
 store=openStore(destination);services=createServices(store,new Map());
 try{
  const changes=totalChanges(store.db);assert.deepEqual(await services.call('lut.look.inspect',inspectInput),result);assert.equal(totalChanges(store.db),changes);
  const policy=await services.call('workspace.restore.inspect',{});assert.equal(policy.operationPolicy.find(row=>row.operation==='lut.look.inspect').available,true);
  assert.deepEqual(Buffer.from(store.db.prepare('SELECT content FROM project_lut_resources WHERE id=?').get(imported.resource.id).content),source);
  assert.deepEqual(readdirSync(path.join(destination,'media')),[]);await assert.rejects(services.call('lut.import',input),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 }finally{await services.drain();store.close();}
});


test('actual CLI schema and official MCP discovery expose identical bounded read without a backend',async()=>{
 const repo=fileURLToPath(new URL('../',import.meta.url)),env={PATH:process.env.PATH??'',NODE_ENV:'test'};
 const cli=await promisify(execFile)(process.execPath,['apps/cli/src/index.ts','schema','lut.look.inspect'],{cwd:repo,env,timeout:10000,maxBuffer:128*1024});
 const envelope=JSON.parse(cli.stdout);assert.equal(envelope.ok,true);assert.equal(envelope.data.operation,'lut.look.inspect');
 assert.deepEqual(envelope.data.inputSchema,discoverSchema({operation:'lut.look.inspect'}).inputSchema);
 const transport=new StdioClientTransport({command:process.execPath,args:['apps/mcp/src/index.ts'],cwd:repo,env,stderr:'pipe'});
 const client=new Client({name:'look-pack-discovery-test',version:'1.0.0'},{capabilities:{}});
 try{
  await client.connect(transport);const listing=await client.listTools();const tool=listing.tools.find(row=>row.name==='lut_look_inspect');assert.ok(tool);
  assert.deepEqual(tool.inputSchema,envelope.data.inputSchema);assert.deepEqual(tool.annotations,effectAnnotations(operationEffect('lut.look.inspect')));
  const result=await client.callTool({name:'mioon_schema',arguments:{operation:'lut.look.inspect'}});
  assert.equal(result.isError,false);assert.deepEqual(result.structuredContent.data,envelope.data);
 }finally{await client.close();assert.equal(transport.pid,null);}
});
