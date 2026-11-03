import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {kernelFixture} from './helpers/current-retained-fixture.ts';
import {withNativeTriggerFault} from './helpers/current-native-fault.ts';
import {ownsStoreLock,assertProjectDatabase} from '../packages/business/src/store-runtime.ts';
import {schemaObjects} from './helpers/project-database.ts';
import {createLutResourceServices} from '../packages/business/src/lut-resources.ts';
import {validateLutResourceRows} from '../packages/business/src/lut-resource-validation.ts';
import {LUT_RESOURCE_LIMITS} from '../packages/contracts/src/lut-resources.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
interface FixtureState { owned: boolean; fault: ((point: string) => void) | null }
interface LutHandlers { 'lut.import': (input: Record<string, unknown>) => { requestId: string; resource: { id: string; sha256: string; sizeBytes: number; name: string; metadata: { size: number }; colourCompatibility: string; renderBinding: string } }; 'lut.inspect': (input: Record<string, unknown>) => { resource: unknown; integrity: string }; 'lut.list': (input: Record<string, unknown>) => { projectId: string; items: { id: string }[]; nextAfter: string | null } }
const text='# exact original comment\r\nTITLE "Original"\r\nLUT_3D_SIZE 2\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1';
function fixture(t: import('node:test').TestContext) {
 const kernel=kernelFixture(t,'LUT owner'),foreign=kernelFixture(t,'Foreign LUT owner'),store=kernel.store,db=store.db,projectId=kernel.projectId,foreignId=foreign.projectId;
 const state:FixtureState={owned:true,fault:null};
 const runtime={ownsLock:()=>ownsStoreLock(store)&&state.owned,assertReadable(){assertProjectDatabase(db);},assertImportAllowed(){assertProjectDatabase(db);}};
 const fresh=()=>createLutResourceServices({db},{runtime,fault(point:string){state.fault?.(point);}}).handlers;
 const foreignHandlers=createLutResourceServices(foreign.store,{runtime:{ownsLock:()=>ownsStoreLock(foreign.store),assertReadable(){assertProjectDatabase(foreign.store.db);},assertImportAllowed(){assertProjectDatabase(foreign.store.db);}}}).handlers;
 const f={store,kernel,foreign,foreignHandlers,db,projectId,foreignId,state,fresh,handlers:fresh() as unknown as LutHandlers,input:{projectId,requestId:'original-import-request',name:'original.cube',dataBase64:Buffer.from(text).toString('base64')}};
 return f;
}
const count=(db: DatabaseSync): number[] => [Number((db.prepare('SELECT count(*) AS n FROM project_lut_resources').get() as {n: number}).n),Number((db.prepare('SELECT count(*) AS n FROM lut_import_requests').get() as {n: number}).n)];
test('independent project hosts retain their own LUT quotas and exact replay after each is full',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'mioon-project-lut-capacity-'));
 const hosts:Array<{store:ReturnType<typeof openStore>;services:ReturnType<typeof createServices>}>=[];
 t.after(async()=>{for(const host of hosts){await host.services.drain();host.store.close();}rmSync(root,{recursive:true,force:true});});
 let total=0;
 for(let p=0;p<5;p++){
  const store=openStore(path.join(root,String(p))),services=createServices(store,new Map(),{env:{}});hosts.push({store,services});
  await services.call('project.create',{name:`LUT project ${p}`});
  const input={projectId:store.projectId,requestId:randomUUID(),name:'original.cube',dataBase64:Buffer.from(text).toString('base64')};
  const first=await services.call('lut.import',input);
  for(let n=1;n<LUT_RESOURCE_LIMITS.projectResources;n++)await services.call('lut.import',{...input,requestId:randomUUID()});
  const before=count(store.db);assert.deepEqual(before,[128,128]);
  await assert.rejects(services.call('lut.import',{...input,requestId:randomUUID()}),{code:'LUT_CAPACITY'});
  assert.deepEqual(await services.call('lut.import',input),first);assert.deepEqual(count(store.db),before);total+=before[0]!;
 }
 assert.equal(total,5*LUT_RESOURCE_LIMITS.projectResources);assert.ok(total>LUT_RESOURCE_LIMITS.workspaceResources);
 assert.equal(new Set(hosts.map(host=>host.store.db)).size,hosts.length);
});
test('exact bytes, project ownership, immutable hash and metadata-only resource flow',t=>{
 const f=fixture(t),result=f.handlers['lut.import'](f.input),resource=result.resource;
 assert.equal(resource.sha256,createHash('sha256').update(text).digest('hex'));assert.equal(resource.sizeBytes,Buffer.byteLength(text));
 assert.equal(resource.colourCompatibility,'unverified');assert.equal(resource.renderBinding,'not_implemented');
 const contentRow=f.db.prepare('SELECT content FROM project_lut_resources').get() as {content: Uint8Array} | undefined;assert.ok(contentRow);assert.deepEqual(Buffer.from(contentRow.content),Buffer.from(text));
 assert.deepEqual(f.handlers['lut.inspect']({projectId:f.projectId,lutId:resource.id}),{resource,integrity:'verified'});
 assert.deepEqual(f.handlers['lut.list']({projectId:f.projectId}),{projectId:f.projectId,items:[resource],nextAfter:null});
 for(const field of ['content','dataBase64','path','relativePath','url'])assert.equal(JSON.stringify(result).includes('"'+field+'"'),false);
 validateLutResourceRows(f.db);assert.deepEqual(count(f.db),[1,1]);
});
test('same request across restart wrappers replays exactly; every changed input conflicts',t=>{
 const f=fixture(t),result=f.handlers['lut.import'](f.input);
 assert.deepEqual(f.fresh()['lut.import'](f.input),result);
 for(const change of [{name:'different.cube'},{dataBase64:Buffer.from(text+'\r\n').toString('base64')}])
  assert.throws(()=>f.handlers['lut.import']({...f.input,...change}),{code:'IDEMPOTENCY_CONFLICT'});
 assert.throws(()=>f.handlers['lut.import']({...f.input,projectId:f.foreignId}),{code:'LUT_NOT_FOUND'});
 const foreign=f.foreignHandlers['lut.import']({...f.input,projectId:f.foreignId});assert.equal(foreign.requestId,result.requestId);assert.notEqual(foreign.resource.id,result.resource.id);
 assert.deepEqual(count(f.db),[1,1]);
});
test('different explicit requests create distinct immutable copies, never silently rename or dedupe',t=>{
 const f=fixture(t),a=f.handlers['lut.import'](f.input),b=f.handlers['lut.import']({...f.input,requestId:'another-import-request',name:'Copy.cube'});
 assert.notEqual(a.resource.id,b.resource.id);assert.equal(a.resource.sha256,b.resource.sha256);assert.equal(a.resource.name,'original.cube');assert.equal(b.resource.name,'Copy.cube');
});
test('foreign or absent project resource has no disclosure; pages are bounded and stable',t=>{
 const f=fixture(t);for(let i=0;i<5;i++)f.handlers['lut.import']({...f.input,requestId:'resource-page-'+i});
 const first=f.handlers['lut.list']({projectId:f.projectId,limit:2}),second=f.handlers['lut.list']({projectId:f.projectId,limit:2,after:first.nextAfter}),last=f.handlers['lut.list']({projectId:f.projectId,limit:2,after:second.nextAfter});
 assert.equal(first.items.length,2);assert.equal(second.items.length,2);assert.equal(last.items.length,1);assert.equal(last.nextAfter,null);
 const ids=[...first.items,...second.items,...last.items].map(r=>r.id);assert.equal(new Set(ids).size,5);assert.deepEqual(ids,[...ids].sort());
 for(const projectId of [f.foreignId,randomUUID()])assert.throws(()=>f.handlers['lut.inspect']({projectId,lutId:ids[0]}),{code:'LUT_NOT_FOUND'});
 assert.deepEqual(f.foreignHandlers['lut.list']({projectId:f.foreignId}).items,[]);
 assert.throws(()=>f.handlers['lut.list']({projectId:f.projectId,limit:51}),{code:'VALIDATION_ERROR'});
});
test('source bounds, strict byte decoding and canonical base64 reject before writes',t=>{
 const f=fixture(t);
 for(const bytes of [Buffer.from([0xff,0xfe]),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(text)]),Buffer.from(text+'\0'),Buffer.from(text.replace('LUT_3D_SIZE 2','LUT_1D_SIZE 2')),Buffer.from(text.replace('0 0 0','-1 0 0'))])
  assert.throws(()=>f.handlers['lut.import']({...f.input,dataBase64:bytes.toString('base64')}));
 for(const encoded of ['','A===','Zh==',' Zg==','Zg==\n','!!!!'])assert.throws(()=>f.handlers['lut.import']({...f.input,dataBase64:encoded}));
 assert.throws(()=>f.handlers['lut.import']({...f.input,dataBase64:'A'.repeat(LUT_RESOURCE_LIMITS.base64Characters+4)}),{code:'LUT_SOURCE_TOO_LARGE'});
 assert.deepEqual(count(f.db),[0,0]);
});
test('plain inputs do not invoke getters, accept paths or client ownership claims',t=>{
 const f=fixture(t);let called=0;
 for(const value of [{...f.input,get surprise(){called++;return true;}},{...f.input,path:'/outside/file.cube'},{...f.input,profile:'other'},{...f.input,approved:true}])
  assert.throws(()=>f.handlers['lut.import'](value),{code:'VALIDATION_ERROR'});
 assert.equal(called,0);assert.deepEqual(count(f.db),[0,0]);
});
test('real ownership and explicit lease loss precede import admission',t=>{
 const f=fixture(t);f.state.owned=false;assert.throws(()=>f.handlers['lut.import'](f.input),{code:'LUT_OWNER_REQUIRED'});f.state.owned=true;
 assert.deepEqual(count(f.db),[0,0]);
});
test('every precommit interruption rolls back both BLOB and receipt, with explicit retry',t=>{
 for(const point of ['beforeInsert','afterResourceInsert','afterReceiptInsert','beforeCommit']){
  const f=fixture(t);f.state.fault=(current: string)=>{if(current===point)throw Error('Injected interruption');};
  assert.throws(()=>f.handlers['lut.import'](f.input),{code:'LUT_STORAGE_UNAVAILABLE'});assert.deepEqual(count(f.db),[0,0]);
  f.state.fault=null;assert.ok(f.handlers['lut.import'](f.input).resource.id);assert.deepEqual(count(f.db),[1,1]);
 }
});
test('lease loss before commit cannot publish; lost response after commit exact-replays',t=>{
 const a=fixture(t);a.state.fault=(point: string)=>{if(point==='beforeCommit')a.state.owned=false;};
 assert.throws(()=>a.handlers['lut.import'](a.input),{code:'LUT_OWNER_REQUIRED'});assert.deepEqual(count(a.db),[0,0]);
 const b=fixture(t);b.state.fault=(point: string)=>{if(point==='afterCommit')throw Error('Lost response');};
 assert.throws(()=>b.handlers['lut.import'](b.input),{code:'LUT_IMPORT_UNCERTAIN'});assert.deepEqual(count(b.db),[1,1]);
 b.state.fault=null;const saved=b.handlers['lut.import'](b.input);assert.equal(saved.requestId,b.input.requestId);assert.deepEqual(count(b.db),[1,1]);
});
test('project count capacity is atomic; exact replay works even when full',t=>{
 const f=fixture(t),first=f.handlers['lut.import'](f.input);
 for(let i=1;i<LUT_RESOURCE_LIMITS.projectResources;i++)f.handlers['lut.import']({...f.input,requestId:'fill-project-'+i});
 assert.throws(()=>f.handlers['lut.import']({...f.input,requestId:'overflow-project'}),{code:'LUT_CAPACITY'});
 assert.deepEqual(f.handlers['lut.import'](f.input),first);assert.deepEqual(count(f.db),[128,128]);
 f.foreignHandlers['lut.import']({...f.input,projectId:f.foreignId,requestId:'other-project-allowed'});assert.deepEqual(count(f.db).map((value,index)=>value+count(f.foreign.store.db)[index]!),[129,129]);
});
test('SQL protections reject mutation, replacement and deletion with recursive triggers off',t=>{
 const f=fixture(t),r=f.handlers['lut.import'](f.input);f.db.exec('PRAGMA recursive_triggers=OFF;');
 for(const sql of ["UPDATE project_lut_resources SET name='changed'",'DELETE FROM project_lut_resources',
  'INSERT OR REPLACE INTO project_lut_resources SELECT * FROM project_lut_resources',
  "UPDATE lut_import_requests SET inputHash='"+'a'.repeat(64)+"'",'DELETE FROM lut_import_requests','INSERT OR REPLACE INTO lut_import_requests SELECT * FROM lut_import_requests'])assert.throws(()=>f.db.exec(sql));
 assert.deepEqual(f.handlers['lut.import'](f.input),r);validateLutResourceRows(f.db);
});
test('content corruption fails inspect and strict offline validation, not metadata-only listing',t=>{
 const f=fixture(t),r=f.handlers['lut.import'](f.input);
 withNativeTriggerFault(f.db,'project',['immutable_project_lut_resources'],()=>f.db.prepare('UPDATE project_lut_resources SET content=?').run(Buffer.from(text.replace('Original','Modified'))));
 assert.equal(f.handlers['lut.list']({projectId:f.projectId}).items.length,1);
 assert.throws(()=>f.handlers['lut.inspect']({projectId:f.projectId,lutId:r.resource.id}),{code:'LUT_RESOURCE_INVALID'});
 assert.throws(()=>validateLutResourceRows(f.db),{code:'LUT_RESOURCE_INVALID'});
});
test('real shared services persist through close/reopen, create no playable asset or file',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'mioon-lut-resource-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let store=openStore(root),services=createServices(store,new Map());
 const p=await services.call('project.create',{name:'LUT resource'}) as {id: string},i={projectId:p.id,requestId:'real-restart-import',name:'look.cube',dataBase64:Buffer.from(text).toString('base64')};
 const first=await services.call('lut.import',i) as {resource: {id: string}};assert.deepEqual(await services.call('asset.list',{projectId:p.id}),[]);assert.deepEqual(readdirSync(path.join(root,'media')),[]);
 await services.drain();store.close();store=openStore(root);services=createServices(store,new Map());
 try{assert.deepEqual(await services.call('lut.import',i),first);assert.deepEqual((await services.call('lut.inspect',{projectId:p.id,lutId:first.resource.id}) as {resource: unknown}).resource,first.resource);}
 finally{await services.drain();store.close();}
});

test('real512MiB allocated-page headroom rejects before writes and actual transaction growth rolls back',t=>{
 const f=fixture(t),canonical=schemaObjects(f.db),limit=LUT_RESOURCE_LIMITS.databaseBytes;
 const allocate=()=>{f.db.exec('CREATE TABLE quota_allocation_probe(value BLOB)');try{f.db.prepare('INSERT INTO quota_allocation_probe VALUES(zeroblob(?))').run(limit);}finally{f.db.exec('DROP TABLE quota_allocation_probe');}};
 allocate();assert.deepEqual(schemaObjects(f.db),canonical,'temporary allocation leaves the canonical kernel catalog exact');
 for(const mode of ['headroom','fragmented']){
  assert.ok(Number(f.db.prepare('PRAGMA main.page_count').get()!.page_count)*Number(f.db.prepare('PRAGMA main.page_size').get()!.page_size)>=limit,mode);
  assert.ok(Number(f.db.prepare('PRAGMA main.freelist_count').get()!.freelist_count)>0,'allocated free pages remain part of the physical budget');
  assert.throws(()=>f.handlers['lut.import'](f.input),{code:'LUT_CAPACITY'});assert.deepEqual(count(f.db),[0,0]);assert.equal(f.db.isTransaction,false);
 }
 f.db.exec('VACUUM main');assert.deepEqual(schemaObjects(f.db),canonical);
 f.state.fault=point=>{if(point==='afterResourceInsert')allocate();};
 assert.throws(()=>f.handlers['lut.import'](f.input),{code:'LUT_CAPACITY'});assert.deepEqual(count(f.db),[0,0]);assert.equal(f.db.isTransaction,false);
 assert.deepEqual(schemaObjects(f.db),canonical,'overflow rollback restores all actual catalog objects');
});

test('largest admitted7MiB exact source round-trips without canonicalization; one extra byte refuses',t=>{
 const f=fixture(t),size=33,header=`LUT_3D_SIZE ${size}\n`,rows=[];let extra=LUT_RESOURCE_LIMITS.sourceBytes-Buffer.byteLength(header)-size**3*6;
 for(let i=0;i<size**3;i++){const padding=Math.min(245,extra);rows.push('0 0 0'+' '.repeat(padding)+'\n');extra-=padding;}
 assert.equal(extra,0);const source=Buffer.from(header+rows.join(''));assert.equal(source.length,LUT_RESOURCE_LIMITS.sourceBytes);
 const response=f.handlers['lut.import']({...f.input,dataBase64:source.toString('base64')});
 assert.equal(response.resource.sizeBytes,LUT_RESOURCE_LIMITS.sourceBytes);assert.equal(response.resource.sha256,createHash('sha256').update(source).digest('hex'));
 assert.equal(response.resource.metadata.size,33);const largestRow=f.db.prepare('SELECT content FROM project_lut_resources').get() as {content: Uint8Array} | undefined;assert.ok(largestRow);assert.deepEqual(Buffer.from(largestRow.content),source);
 assert.throws(()=>f.handlers['lut.import']({...f.input,requestId:'one-byte-over-limit',dataBase64:Buffer.concat([source,Buffer.from('\n')]).toString('base64')}),{code:'LUT_SOURCE_TOO_LARGE'});
 assert.deepEqual(count(f.db),[1,1]);
});
test('names and keys preserve Unicode scalar text and reject lone surrogates before write',t=>{
 const f=fixture(t),i={...f.input,requestId:'用户请求-精确字节',name:'色调 🟢.cube'},r=f.handlers['lut.import'](i);assert.equal(r.resource.name,i.name);assert.deepEqual(f.handlers['lut.import'](i),r);validateLutResourceRows(f.db);
 for(const invalid of [{...f.input,name:'bad\ud800'},{...f.input,requestId:'request-\udfff'}])assert.throws(()=>f.handlers['lut.import'](invalid),{code:'VALIDATION_ERROR'});
 assert.deepEqual(count(f.db),[1,1]);
});

test('SQL and service enforce each real project64MiB quota independently of count and other hosts',t=>{
 const f=fixture(t),metadata=JSON.stringify({test:'quota-only'}),sourceBytes=LUT_RESOURCE_LIMITS.sourceBytes;
 for(const [store,projectId,handlers]of [[f.store,f.projectId,f.handlers],[f.foreign.store,f.foreignId,f.foreignHandlers]] as const){
  const insert=store.db.prepare(`INSERT INTO project_lut_resources(id,projectId,name,sha256,sizeBytes,profile,metadata,content,createdAt) VALUES(?,?,?,'${'a'.repeat(64)}',?,'mioon-cube3d-normalized-tetrahedral-v1',?,zeroblob(?),'2026-10-14T00:00:00.000Z')`);
  const add=(bytes:number)=>insert.run(randomUUID(),projectId,'quota-only.cube',bytes,metadata,bytes);
  for(let i=0;i<9;i++)add(sourceBytes);add(1024*1024);
  assert.throws(()=>add(1),/LUT_RESOURCE_LIMIT/);
  assert.equal(store.db.prepare('SELECT SUM(sizeBytes) AS bytes FROM project_lut_resources').get()!.bytes,64*1024*1024);
  assert.throws(()=>handlers['lut.import']({...f.input,projectId,requestId:'project-byte-overflow'}),{code:'LUT_CAPACITY'});
  assert.deepEqual(count(store.db),[10,0]);
 }
 const third=fixture(t);assert.ok(third.handlers['lut.import'](third.input).resource.id,'two full independent hosts cannot consume a third project quota');
 assert.deepEqual(count(third.db),[1,1]);
});
