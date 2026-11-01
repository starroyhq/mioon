import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';import {createServices,canonical} from '../packages/business/src/services.ts';
import {fork} from 'node:child_process';import {once} from 'node:events';
import {assetAnnotationSchemas,isAssetAnnotationResponse,isAssetAnnotationListResponse} from '../packages/contracts/src/asset-annotations.ts';
import {schemaObjects, withoutForeignKeys} from './helpers/project-database.ts';
interface AssetView { id: string; projectId: string }
interface AnnotationFixture { root: string; readonly store: ReturnType<typeof openStore>; call: (operation: string, input: Record<string, unknown>) => Promise<unknown>; restart(): void; asset(owner?: string): AssetView; input(asset: AssetView, patch?: Record<string, unknown>): Record<string, unknown> & {requestId: string}; project: AssetView }
async function fixture(t: import('node:test').TestContext): Promise<AnnotationFixture> {
 const root=await mkdtemp(path.join(tmpdir(),'annotations-'));let store=openStore(root),services=createServices(store,new Map());
 const f: AnnotationFixture={root,get store(){return store;},call:(operation: string, input: Record<string, unknown>)=>services.call(operation as never,input as never) as Promise<unknown>,restart(){store.close();store=openStore(root);services=createServices(store,new Map());},asset(owner=f.project.id){return store.put('assets',{id:randomUUID(),projectId:owner,name:'sentinel',mimeType:'image/png'}) as unknown as AssetView;},input(asset: AssetView,patch: Record<string, unknown>={}){return {projectId:asset.projectId,assetId:asset.id,expectedRevision:0,requestId:randomUUID(),tags:['标签','Review'],note:'literal <b>hello</b>\n\t日本語',...patch};},project:{id:'',projectId:''}};
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 f.project=await f.call('project.create',{name:'annotations'}) as AssetView;return f;
}
const list=(f: AnnotationFixture, assets: AssetView[]) => f.call('asset.annotation.list',{projectId:f.project.id,assetIds:assets.map(a=>a.id)}) as Promise<{items: {revision: number; tags: string[]; note: string}[]}>;
const byName=(a: {name: string}, b: {name: string}): number => a.name<b.name?-1:a.name>b.name?1:0;
const snapshot=(db: ReturnType<typeof openStore>['db'], omit: string[] = []): Record<string, unknown[]> => Object.fromEntries(schemaObjects(db).filter(r=>r.type==='table'&&!r.name.startsWith('sqlite_')).sort(byName).filter((r: {name: string})=>!omit.includes(r.name)).map((r: {name: string})=>[r.name,(db.prepare(`SELECT * FROM ${r.name} ORDER BY rowid`).all() as Record<string, unknown>[])]));

test('annotation contract bounds Unicode, canonical tags, literal notes and response identity',()=>{
 const input={projectId:randomUUID(),assetId:randomUUID(),expectedRevision:0,requestId:randomUUID(),tags:['标签','😀'.repeat(40)],note:'😀'.repeat(4000)};
 const schema=assetAnnotationSchemas['asset.annotation.set'];assert.equal(schema.safeParse(input).success,true);
 for(const patch of [{tags:['a','a']},{tags:[' a']},{tags:['e\u0301']},{tags:['\n']},{tags:['x'.repeat(41)]},{tags:Array.from({length:21},(_,i)=>String(i))},{note:'a'.repeat(4001)},{note:'\ud800'},{note:'a\0b'},{note:'\r'},{expectedRevision:2**53},{extra:1}])assert.equal(schema.safeParse({...input,...patch}).success,false,JSON.stringify(patch));
 assert.equal(schema.safeParse({...input,tags:['A','a'],note:'\n\t'}).success,true);
 assert.equal(isAssetAnnotationResponse({id:input.assetId,assetId:input.assetId,projectId:input.projectId,revision:0,tags:['x'],note:''}),false);
});

test('ordered bounded reads are noncreating and all-or-nothing; missing/foreign fail uniformly',async t=>{
 const f=await fixture(t),assets=Array.from({length:100},()=>f.asset()),before=snapshot(f.store.db),changes=(f.store.db.prepare('SELECT total_changes() n').get() as {n: number}).n;
 const result=await list(f,assets);assert.equal(isAssetAnnotationListResponse(result,{projectId:f.project.id,assetIds:assets.map(a=>a.id)}),true);assert.ok(result.items.every((r: {revision: number; tags: string[]; note: string})=>r.revision===0&&r.tags.length===0&&r.note===''));assert.deepEqual(snapshot(f.store.db),before);assert.equal((f.store.db.prepare('SELECT total_changes() n').get() as {n: number}).n,changes);
 for(const ids of [[],[assets[0].id,assets[0].id],Array.from({length:101},()=>randomUUID())])await assert.rejects(f.call('asset.annotation.list',{projectId:f.project.id,assetIds:ids}),{code:'VALIDATION_ERROR'});
 // Another project's asset lives in that project's own store: this project has no such asset.
 const foreign=await fixture(t),other=foreign.asset();
 for(const id of [other.id,randomUUID()])await assert.rejects(f.call('asset.annotation.list',{projectId:f.project.id,assetIds:[assets[0].id,id]}),(e: unknown)=>{const failure=e as {code?: string; details?: Record<string, unknown>};return failure.code==='NOT_FOUND'&&Object.keys(failure.details ?? {}).length===0;});
});

test('save/clear independent CAS and historical replay survive restart without changing assets or other tables',async t=>{
 const f=await fixture(t),a=f.asset(),before=snapshot(f.store.db,['asset_annotations','asset_annotation_requests']),input=f.input(a),one=await f.call('asset.annotation.set',input);
 const two=await f.call('asset.annotation.set',f.input(a,{expectedRevision:1,tags:[],note:''})) as {revision: number};assert.equal(two.revision,2);
 const revisions=before.agent_task_target_revisions_v2 as Record<string,unknown>[];
 assert.equal(revisions.some(row=>row.kind==='asset_annotation'&&row.targetId===a.id),false);
 revisions.push(Object.assign(Object.create(null),{projectId:a.projectId,kind:'asset_annotation',targetId:a.id,revision:2}));
 assert.deepEqual(snapshot(f.store.db,['asset_annotations','asset_annotation_requests']),before);
 const stable=snapshot(f.store.db);f.restart();assert.deepEqual(await f.call('asset.annotation.set',input),one);assert.deepEqual((await list(f,[a])).items,[two]);assert.deepEqual(snapshot(f.store.db),stable);
 await assert.rejects(f.call('asset.annotation.set',{...input,requestId:randomUUID()}),(e: unknown)=>{const failure=e as {code?: string; details?: {mutationOutcome?: string}};return failure.code==='REVISION_CONFLICT'&&failure.details?.mutationOutcome==='not_applied';});
 for(const patch of [{note:'changed'},{projectId:randomUUID()},{assetId:randomUUID()},{expectedRevision:1}])await assert.rejects(f.call('asset.annotation.set',{...input,...patch}),{code:'IDEMPOTENCY_CONFLICT'});
});

test('ownership drift prevents reads and replay; direct SQL cannot replace or delete state/receipts',async t=>{
 const f=await fixture(t),a=f.asset(),input=f.input(a);await f.call('asset.annotation.set',input);const foreign=(await fixture(t)).project;
 for(const sql of ["DELETE FROM asset_annotations","DELETE FROM asset_annotation_requests","UPDATE asset_annotation_requests SET response='{}'","INSERT OR REPLACE INTO asset_annotations SELECT * FROM asset_annotations","INSERT OR REPLACE INTO asset_annotation_requests SELECT * FROM asset_annotation_requests","UPDATE asset_annotations SET revision=revision"])assert.throws(()=>f.store.db.exec(sql));
 withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(foreign.id,a.id));await assert.rejects(list(f,[a]),{code:'NOT_FOUND'});await assert.rejects(f.call('asset.annotation.set',input),{code:'NOT_FOUND'});
});

test('all four legacy companion keys collide with annotations in both SQL directions',async t=>{
 const f=await fixture(t),a=f.asset(),input=f.input(a);const saved=await f.call('asset.annotation.set',input);
 const tables=['mutation_requests','asset_range_requests','asset_disposition_requests','subject_requests'];
 const operations=['shot.create','asset.range.set','asset.disposition.set','subject.create'];
 for(const [index,table] of tables.entries()){
  assert.throws(()=>f.store.db.prepare(`INSERT INTO ${table}(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)`).run(input.requestId,operations[index],f.project.id,JSON.stringify({projectId:f.project.id}),JSON.stringify({projectId:f.project.id})));
  const key=randomUUID();f.store.db.prepare(`INSERT INTO ${table}(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)`).run(key,operations[index],f.project.id,JSON.stringify({projectId:f.project.id}),JSON.stringify({projectId:f.project.id}));
  const {requestId,...fields}=input as Record<string, unknown>;assert.throws(()=>f.store.db.prepare('INSERT INTO asset_annotation_requests VALUES(?,?,?,?,?)').run(key,'asset.annotation.set',f.project.id,canonical(fields),JSON.stringify(saved)));
  await assert.rejects(f.call('asset.annotation.set',{...input,requestId:key}),{code:'IDEMPOTENCY_CONFLICT'});
 }
});

test('receipt insertion failure rolls back annotation save atomically',async t=>{
 const f=await fixture(t),a=f.asset();f.store.db.exec("CREATE TRIGGER fail_annotation_receipt BEFORE INSERT ON asset_annotation_requests BEGIN SELECT RAISE(ABORT,'sentinel');END;");
 const before=snapshot(f.store.db);await assert.rejects(f.call('asset.annotation.set',f.input(a)));assert.deepEqual(snapshot(f.store.db),before);
});

test('corrupt stored shapes and oversized bounded fields fail closed without raw TypeErrors',async t=>{
 const f=await fixture(t),a=f.asset();await f.call('asset.annotation.set',f.input(a));
 f.store.db.exec('PRAGMA ignore_check_constraints=ON');f.store.db.prepare('UPDATE asset_annotations SET revision=revision+1,note=?').run('x'.repeat(1024*1024));
 await assert.rejects(list(f,[a]),{code:'INVALID_ASSET_ANNOTATION_RECORD'});
 f.store.db.prepare("UPDATE assets SET data='null' WHERE id=?").run(a.id);await assert.rejects(list(f,[a]),{code:'INVALID_ASSET_ANNOTATION_RECORD'});
});

for(const sameKey of [false,true])test(`two-process annotation ${sameKey?'exact replay':'CAS'} race commits one immutable receipt`,{timeout:30000},async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);
 const children=[0,1].map(()=>fork(new URL('./helpers/asset-annotation-race-child.ts',import.meta.url),[f.root],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}));
 t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');});
 await Promise.all(children.map(async (child: ReturnType<typeof fork>)=>{const [ready]=await once(child,'message') as [{ready: boolean}];assert.equal(ready.ready,true);}));
 const results=children.map((child: ReturnType<typeof fork>)=>once(child,'message').then((args: unknown[])=>args[0])),exits=children.map((child: ReturnType<typeof fork>)=>once(child,'exit'));
 children[0].send(input);children[1].send({...input,requestId:sameKey?input.requestId:randomUUID()});
 const values=await Promise.all(results) as {ok?: boolean; code?: string}[];await Promise.all(exits);
 if(sameKey){assert.ok(values.every((v: {ok?: boolean})=>v.ok));assert.deepEqual(values[0],values[1]);}else{assert.equal(values.filter((v: {ok?: boolean})=>v.ok).length,1);const failed=values.find((v: {ok?: boolean})=>!v.ok);assert.ok(failed);assert.equal(failed.code,'REVISION_CONFLICT');}
 assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM asset_annotation_requests').get() as {n: number}).n,1);const finalList=await list(f,[asset]);assert.equal(finalList.items[0]?.revision,1);
});
