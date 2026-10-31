import {CURRENT_ORDINARY_SCHEMA,CURRENT_RESTORED_ROLE,CURRENT_RESTORED_SCHEMA,CURRENT_RESTORE_PROFILE} from './helpers/workspace-schema-current.ts';
import {downgradeReviewedWorkspace} from './helpers/reviewed-schema-layers.ts';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {collectProject,packageDocumentBytes,buildManifest,createProjectFromDocument} from '../packages/business/src/project-package/document.ts';
import type {ProjectDocument} from '../packages/business/src/project-package/document.ts';
import {writeProjectPackage,readProjectPackage} from '../packages/business/src/project-package/container.ts';
import {AGENT_TASK_OPERATION_ADMISSION} from '../packages/business/src/agent/task-tools-v2.ts';
import {previsJpegSize} from '../packages/business/src/previs.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {PREVIS_LIMITS,defaultPrevisScene,descriptions,isPrevisMutationResponse,isPrevisThumbnailGetResponse,isPrevisThumbnailSetResponse,
 operationEffect,previsSceneBytes,previsSceneSchema,roundPrevisNumber} from '@mioon/contracts';
import type {PrevisNodeRecord,PrevisScene,PrevisThumbnailGetResponse,PrevisThumbnailSetResponse} from '@mioon/contracts';
type Row=Record<string, unknown>;
const sha=(bytes: Buffer): string=>createHash('sha256').update(bytes).digest('hex');
const operations=['previs.create','previs.scene.set','previs.thumbnail.set','previs.thumbnail.get'];
// A canvas-style JPEG container: JFIF, one baseline frame of the given size and
// a scan. The validator reads only the container, as the editor's encoder writes it.
function jpeg(width: number,height: number,{pad=0,frame=0xc0}: {pad?: number; frame?: number}={}): Buffer {
 return Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00]),
  Buffer.from([0xff,frame,0x00,0x11,0x08,height>>8,height&255,width>>8,width&255,0x03,0x01,0x22,0x00,0x02,0x11,0x01,0x03,0x11,0x01]),
  Buffer.from([0xff,0xda,0x00,0x0c,0x03,0x01,0x00,0x02,0x11,0x03,0x11,0x00,0x3f,0x00]),Buffer.alloc(pad,0x55),Buffer.from([0x12,0x34,0xff,0xd9])]);
}
async function failure(promise: Promise<unknown>): Promise<{code?: string; details?: Row}> {
 try{await promise;}catch(error){return error as {code?: string; details?: Row};}
 throw new Error('Expected a failure');
}
const camera=(focalLength=35,x=0)=>({position:[x,1.6,4] as [number,number,number],yaw:0,pitch:-4,focalLength});
const keyframe=(id: string,exports: string[]=[],focalLength=35)=>({id,name:'',camera:camera(focalLength),exports});
function scene(patch: Partial<PrevisScene>={}): PrevisScene {return {...defaultPrevisScene(),...patch};}
// Every list at its limit, every name and number at its widest.
function largestScene(): PrevisScene {
 const name='界'.repeat(PREVIS_LIMITS.nameLength),far: [number,number,number]=[-99.999,-99.999,-99.999];
 const wide={position:far,yaw:-179.999,pitch:-89.999,focalLength:299.999};
 return {schemaVersion:1,
  figures:Array.from({length:PREVIS_LIMITS.figures},(_,index)=>({id:`f${9990+index}`,name,visible:false,position:far,rotation:-179.999,pose:'look-back' as const,held:{propId:`p${9978+index}`,hand:'right' as const}})),
  props:Array.from({length:PREVIS_LIMITS.props},(_,index)=>({id:`p${9970+index}`,kind:index<8?'cylinder' as const:'umbrella' as const,name,visible:false,position:far,rotation:-179.999,size:[19.999,19.999,19.999] as [number,number,number]})),
  light:{visible:false,azimuth:-179.999,elevation:-89.999,intensity:3.999},camera:wide,
  keyframes:Array.from({length:PREVIS_LIMITS.keyframes},(_,index)=>({id:`k${9970+index}`,name,camera:wide,exports:Array.from({length:PREVIS_LIMITS.exportsPerKeyframe},()=>randomUUID())})),
  activeKeyframeId:'k9993'};
}
async function fixture(t: TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-previs-'));
 let store=openStore(root),services=createServices(store,new Map()),closed=false;
 const call=<T=Row>(operation: string,input: unknown): Promise<T>=>services.call(operation,input) as Promise<T>;
 const projectId=(await call<{id: string}>('project.create',{name:'Previs'})).id;
 async function asset(patch: Row={}): Promise<{id: string}> {
  const bytes=await renderMockImagePng({width:64,height:96}),id=randomUUID();
  const value={id,projectId,name:'K1.png',mimeType:'image/png',provenance:'user-import',sha256:sha(bytes),width:64,height:96,sizeBytes:bytes.length,relativePath:`media/${id}.png`,url:`/media/${id}`,createdAt:new Date().toISOString(),...patch};
  store.put('assets',value);writeFileSync(path.join(root,String(value.relativePath)),bytes,{mode:0o600});return value;
 }
 const f={root,projectId,asset,call,
  get store(){return store;},
  get services(){return services;},
  create:(patch: Row={})=>call<PrevisNodeRecord>('previs.create',{projectId,position:{x:40,y:60},requestId:randomUUID(),...patch}),
  save:(node: PrevisNodeRecord,value: PrevisScene,patch: Row={})=>call<PrevisNodeRecord>('previs.scene.set',{projectId,nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene:value,requestId:randomUUID(),...patch}),
  thumbnail:(node: PrevisNodeRecord,slot: string,bytes=jpeg(216,384),patch: Row={})=>call<PrevisThumbnailSetResponse>('previs.thumbnail.set',{projectId,nodeId:node.id,slot,sceneRevision:node.sceneRevision,dataBase64:bytes.toString('base64'),...patch}),
  thumbnails:(node: PrevisNodeRecord,slots: string[])=>call<PrevisThumbnailGetResponse>('previs.thumbnail.get',{projectId,nodeId:node.id,slots}),
  async stop(){await services.drain?.();store.close();closed=true;},
  async reopen(){if(!closed)await f.stop();store=openStore(root);services=createServices(store,new Map());closed=false;},
 };
 t.after(async()=>{if(!closed){await services.drain?.();store.close();}rmSync(root,{recursive:true,force:true});});
 return f;
}

test('a scene keeps its rules, and one at every item limit still fits 16 KiB',()=>{
 const largest=largestScene();
 assert.equal(previsSceneSchema.safeParse(largest).success,true);
 assert.ok(previsSceneBytes(largest)<=PREVIS_LIMITS.sceneBytes,`${previsSceneBytes(largest)} bytes`);
 assert.equal(previsSceneSchema.safeParse(defaultPrevisScene()).success,true);
 assert.deepEqual([roundPrevisNumber(0.1+0.2),roundPrevisNumber(1.23456),Object.is(roundPrevisNumber(-0.0004),0)],[0.3,1.235,true]);
 const base=defaultPrevisScene(),figure=base.figures[0]!,umbrella={id:'p1',kind:'umbrella' as const,name:'',visible:true,position:[0,0,0] as [number,number,number],rotation:0,size:[1,1,1] as [number,number,number]};
 const exported=randomUUID();
 const rejected: Record<string,unknown>={
  'four decimals':{...base,figures:[{...figure,position:[0.0001,0,0]}]},
  'nine figures':{...base,figures:Array.from({length:9},(_,index)=>({...figure,id:`f${index+1}`}))},
  'duplicate IDs':{...base,props:[umbrella,umbrella]},
  'a held box':{...base,props:[{...umbrella,kind:'box'}],figures:[{...figure,held:{propId:'p1',hand:'left'}}]},
  'a prop held twice':{...base,props:[umbrella],figures:[{...figure,held:{propId:'p1',hand:'left'}},{...figure,id:'f2',held:{propId:'p1',hand:'right'}}]},
  'a missing held prop':{...base,figures:[{...figure,held:{propId:'p7',hand:'left'}}]},
  'a missing active keyframe':{...base,keyframes:[keyframe('k1')],activeKeyframeId:'k2'},
  'one export on two keyframes':{...base,keyframes:[keyframe('k1',[exported]),keyframe('k2',[exported])]},
  'five exports':{...base,keyframes:[keyframe('k1',Array.from({length:5},()=>randomUUID()))]},
  'a control character':{...base,figures:[{...figure,name:'林\n夏'}]},
  'a long name':{...base,figures:[{...figure,name:'x'.repeat(21)}]},
  'an unknown field':{...base,figures:[{...figure,colour:'red'}]},
  'a later schema':{...base,schemaVersion:2},
  'a bad keyframe ID':{...base,keyframes:[keyframe('k0')]},
 };
 for(const [label,value] of Object.entries(rejected))assert.equal(previsSceneSchema.safeParse(value).success,false,label);
 assert.equal(previsSceneSchema.safeParse({...base,figures:[{...figure,name:'周屿🌂'}],props:[umbrella],keyframes:[keyframe('k1',[exported])],activeKeyframeId:'k1'}).success,true);
});

test('a previs node starts with the default scene and replays its creation exactly',async t=>{
 const f=await fixture(t),input={projectId:f.projectId,label:'机位预演',position:{x:40,y:60},requestId:randomUUID()};
 const node=await f.call<PrevisNodeRecord>('previs.create',input);
 assert.equal(isPrevisMutationResponse('previs.create',input,node),true);
 assert.deepEqual([node.type,node.label,node.text,node.revision,node.sceneRevision],['previs','机位预演','',1,1]);
 assert.deepEqual(node.scene,defaultPrevisScene());
 assert.deepEqual(await f.call('previs.create',input),node,'the same key returns the original node');
 await assert.rejects(f.call('previs.create',{...input,label:'另一个'}),{code:'IDEMPOTENCY_CONFLICT'});
 await assert.rejects(f.call('previs.create',{...input,projectId:randomUUID(),requestId:randomUUID()}),{code:'NOT_FOUND'});
 const project=await f.call<{nodes: PrevisNodeRecord[]}>('project.get',{projectId:f.projectId});
 assert.deepEqual(project.nodes.filter(item=>item.type==='previs'),[node]);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM nodes').get()!.n,1);
});

test('scenes save under scene revision CAS, so renaming or moving the node never conflicts',async t=>{
 const f=await fixture(t),node=await f.create();
 const first={...scene({keyframes:[keyframe('k1')],activeKeyframeId:'k1'}),figures:[{...defaultPrevisScene().figures[0]!,position:[0.8,0,-1.2] as [number,number,number],rotation:-35,pose:'hold' as const}]};
 const firstInput={projectId:f.projectId,nodeId:node.id,expectedSceneRevision:1,scene:first,requestId:randomUUID()};
 const saved=await f.call<PrevisNodeRecord>('previs.scene.set',firstInput);
 assert.equal(isPrevisMutationResponse('previs.scene.set',firstInput,saved),true);
 assert.deepEqual([saved.revision,saved.sceneRevision],[2,2]);
 const moved=await f.call<PrevisNodeRecord>('node.update',{nodeId:node.id,expectedRevision:2,patch:{label:'雨夜街口',position:{x:300,y:80}},requestId:randomUUID()});
 assert.deepEqual([moved.revision,moved.sceneRevision,moved.label],[3,2,'雨夜街口']);
 assert.deepEqual(moved.scene,first,'moving or renaming keeps the scene');
 const second=scene({keyframes:[keyframe('k1'),keyframe('k2',[],85)],activeKeyframeId:'k2'});
 const latest=await f.save(moved,second);
 assert.deepEqual([latest.revision,latest.sceneRevision,latest.label,latest.position],[4,3,'雨夜街口',{x:300,y:80}]);
 const staleKey=randomUUID(),stale=await failure(f.save(saved,scene(),{requestId:staleKey}));
 assert.equal(stale.code,'REVISION_CONFLICT');
 assert.equal(stale.details?.currentSceneRevision,3);
 assert.deepEqual((stale.details?.current as PrevisNodeRecord).scene,second,'the conflict carries the current node for a read-back');
 assert.deepEqual([stale.details?.mutationOutcome,stale.details?.operation,stale.details?.projectId,stale.details?.requestId],['not_applied','previs.scene.set',f.projectId,staleKey],
  'a fresh key refused inside the save transaction is marked not applied');
 assert.deepEqual(await f.call('previs.scene.set',firstInput),saved,'an exact retry returns the node as that save left it');
 const reused=await failure(f.call('previs.scene.set',{...firstInput,scene:second}));
 assert.equal(reused.code,'IDEMPOTENCY_CONFLICT');assert.equal(reused.details?.mutationOutcome,undefined,'a key with a receipt is never marked');
 const text=await f.call<{id: string}>('node.create',{projectId:f.projectId,type:'text',text:'雨夜',position:{x:0,y:0},requestId:randomUUID()});
 const notPrevis=await failure(f.call('previs.scene.set',{...firstInput,nodeId:text.id,requestId:randomUUID()}));
 assert.deepEqual([notPrevis.code,notPrevis.details?.mutationOutcome],['PREVIS_NODE_REQUIRED','not_applied']);
 await assert.rejects(f.call('previs.scene.set',{...firstInput,nodeId:randomUUID(),requestId:randomUUID()}),{code:'NOT_FOUND'});
 const missingProject=await failure(f.call('previs.create',{projectId:randomUUID(),position:{x:0,y:0},requestId:randomUUID()}));
 assert.deepEqual([missingProject.code,missingProject.details?.mutationOutcome],['NOT_FOUND','not_applied']);
 // The scene changes only through previs.scene.set.
 const refusal=await failure(f.call('node.update',{nodeId:node.id,expectedRevision:4,patch:{text:'note'},requestId:randomUUID()}));
 assert.equal(refusal.code,'INVALID_NODE_PATCH');assert.equal(refusal.details?.mutationOutcome,'not_applied');
 const renamed=await f.call<PrevisNodeRecord>('node.update',{nodeId:node.id,expectedRevision:4,patch:{label:'K',text:''},requestId:randomUUID()});
 assert.deepEqual([renamed.revision,renamed.sceneRevision,renamed.scene],[5,3,second]);
});

test('only the newest four scene saves keep receipts; an older retry is refused, never applied twice',async t=>{
 const f=await fixture(t);let node=await f.create();
 const inputs: Row[]=[];
 for(let index=1;index<=6;index++){
  const input={projectId:f.projectId,nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene:scene({light:{visible:true,azimuth:45,elevation:45,intensity:index/10}}),requestId:randomUUID()};
  inputs.push(input);node=await f.call<PrevisNodeRecord>('previs.scene.set',input);
 }
 assert.deepEqual(f.store.db.prepare('SELECT operation,sceneRevision FROM previs_requests WHERE nodeId=? ORDER BY sceneRevision,operation').all(node.id).map(row=>`${row.operation}:${row.sceneRevision}`),
  ['previs.create:1','previs.scene.set:4','previs.scene.set:5','previs.scene.set:6','previs.scene.set:7']);
 await assert.rejects(f.call('previs.scene.set',inputs[0]),{code:'REVISION_CONFLICT'});
 assert.equal((f.store.get('nodes',node.id) as PrevisNodeRecord).sceneRevision,7,'the pruned save is not applied again');
 assert.deepEqual(await f.call('previs.scene.set',inputs[5]),node);
 assert.equal(((await f.call<PrevisNodeRecord>('previs.scene.set',inputs[2]))).sceneRevision,4,'the oldest retained save still replays');
 // Only a save with three newer saves may go, as the next save prunes it first.
 assert.throws(()=>f.store.db.prepare("DELETE FROM previs_requests WHERE nodeId=? AND sceneRevision=5").run(node.id),/must be retained/);
 f.store.db.exec('SAVEPOINT prune');f.store.db.prepare("DELETE FROM previs_requests WHERE nodeId=? AND sceneRevision=4").run(node.id);f.store.db.exec('ROLLBACK TO prune;RELEASE prune');
 assert.throws(()=>f.store.db.prepare("DELETE FROM previs_requests WHERE nodeId=? AND operation='previs.create'").run(node.id),/must be retained/);
 assert.throws(()=>f.store.db.prepare("UPDATE previs_requests SET inputHash=? WHERE nodeId=?").run('0'.repeat(64),node.id),/immutable/);
});

test('keyframe exports must be image assets of the same project',async t=>{
 const f=await fixture(t),node=await f.create(),image=await f.asset(),video=await f.asset({mimeType:'video/mp4',name:'clip.mp4'});
 // Another project lives in a store of its own: its image does not exist in this one.
 const foreign=(await (await fixture(t)).asset({name:'B.png'})).id;
 for(const assetId of [randomUUID(),foreign,video.id])
  await assert.rejects(f.save(node,scene({keyframes:[keyframe('k1',[assetId])]})),{code:'PREVIS_EXPORT_INVALID'},assetId);
 const saved=await f.save(node,scene({keyframes:[keyframe('k1',[image.id])]}));
 assert.deepEqual(saved.scene.keyframes[0]!.exports,[image.id]);
});

test('thumbnails belong to the current scene, stay bounded JPEGs and leave with their keyframe',async t=>{
 const f=await fixture(t),created=await f.create(),node=await f.save(created,scene({keyframes:[keyframe('k1'),keyframe('k2')]}));
 const card=await f.thumbnail(node,'card'),cardInput={projectId:f.projectId,nodeId:node.id,slot:'card',sceneRevision:2,dataBase64:jpeg(216,384).toString('base64')};
 assert.equal(isPrevisThumbnailSetResponse(cardInput,card),true);
 assert.deepEqual([card.width,card.height,card.sceneRevision],[216,384,2]);
 const k2=jpeg(384,216,{pad:10});await f.thumbnail(node,'k1');await f.thumbnail(node,'k2',k2);
 const read=await f.thumbnails(node,['k2','card','k9']);
 assert.equal(isPrevisThumbnailGetResponse({projectId:f.projectId,nodeId:node.id,slots:['k2','card','k9']},read),true);
 assert.deepEqual(read.items.map(item=>[item.slot,item.width,item.height]),[['k2',384,216],['card',216,384]]);
 assert.equal(read.items[0]!.dataBase64,k2.toString('base64'));
 const replaced=jpeg(200,300,{pad:20});await f.thumbnail(node,'card',replaced);
 assert.equal((await f.thumbnails(node,['card'])).items[0]!.dataBase64,replaced.toString('base64'),'a slot is overwritten');
 await assert.rejects(f.thumbnail(node,'card',jpeg(216,384),{sceneRevision:1}),{code:'PREVIS_THUMBNAIL_STALE'});
 await assert.rejects(f.thumbnail(node,'k5'),{code:'PREVIS_THUMBNAIL_SLOT'});
 const png=await renderMockImagePng({width:32,height:32});
 for(const bytes of [png,jpeg(385,200),jpeg(200,385),jpeg(100,100,{pad:PREVIS_LIMITS.thumbnailBytes}),jpeg(100,100,{frame:0xc3}),jpeg(100,100).subarray(0,40)])
  await assert.rejects(f.thumbnail(node,'k1',bytes),(error: {code?: string})=>['PREVIS_THUMBNAIL_INVALID','VALIDATION_ERROR'].includes(String(error.code)));
 await assert.rejects(f.thumbnail(node,'k1',jpeg(100,100,{pad:PREVIS_LIMITS.thumbnailBytes-56})),{code:'PREVIS_THUMBNAIL_INVALID'},'a payload just over 64 KiB passes the base64 bound but not the byte bound');
 // Saving without k2 drops its thumbnail; the others stay, now older than the scene.
 const next=await f.save(node,scene({keyframes:[keyframe('k1')]}));
 assert.deepEqual((await f.thumbnails(next,['card','k1','k2'])).items.map(item=>[item.slot,item.sceneRevision]),[['card',2],['k1',2]]);
 // A keyframe that now looks elsewhere loses its picture; the card keeps its older one.
 const moved=await f.save(next,scene({keyframes:[{...keyframe('k1'),camera:camera(85)}]}));
 assert.deepEqual((await f.thumbnails(moved,['card','k1'])).items.map(item=>[item.slot,item.sceneRevision]),[['card',2]]);
 const text=await f.call<{id: string}>('node.create',{projectId:f.projectId,type:'text',text:'x',position:{x:0,y:0}});
 await assert.rejects(f.call('previs.thumbnail.get',{projectId:f.projectId,nodeId:text.id,slots:['card']}),{code:'PREVIS_NODE_REQUIRED'});
 assert.throws(()=>f.store.db.prepare('INSERT INTO previs_thumbnails(nodeId,slot,projectId,sceneRevision,width,height,bytes,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
  .run(node.id,'k2',f.projectId,3,1,1,jpeg(1,1),new Date().toISOString()),/current scene/);
});

test('a project keeps at most 1000 thumbnails and evicts the oldest',async t=>{
 const f=await fixture(t),slots=['card',...Array.from({length:24},(_,index)=>`k${index+1}`)];
 const value=scene({keyframes:slots.slice(1).map(slot=>keyframe(slot))});
 const nodes: PrevisNodeRecord[]=[];
 for(let index=0;index<41;index++)nodes.push(await f.save(await f.create(),value));
 for(const node of nodes.slice(0,40))for(const slot of slots)await f.thumbnail(node,slot,jpeg(8,8));
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM previs_thumbnails WHERE projectId=?').get(f.projectId)!.n,PREVIS_LIMITS.thumbnailsPerProject);
 const oldest=f.store.db.prepare('SELECT nodeId,slot FROM previs_thumbnails ORDER BY updatedAt,rowid LIMIT 1').get()!;
 await f.thumbnail(nodes[40]!,'card',jpeg(8,8));
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM previs_thumbnails WHERE projectId=?').get(f.projectId)!.n,PREVIS_LIMITS.thumbnailsPerProject);
 assert.equal(f.store.db.prepare('SELECT 1 FROM previs_thumbnails WHERE nodeId=? AND slot=?').get(oldest.nodeId,oldest.slot),undefined);
 assert.equal((await f.thumbnails(nodes[40]!,['card'])).items.length,1);
});

test('previs node rows stay bounded and keep their type',async t=>{
 const f=await fixture(t),node=await f.create();
 const text=await f.call<{id: string}>('node.create',{projectId:f.projectId,type:'text',text:'x',position:{x:0,y:0}});
 const data=(id: string)=>JSON.parse(String(f.store.db.prepare('SELECT data FROM nodes WHERE id=?').get(id)!.data)) as Row;
 const write=(id: string,value: Row)=>f.store.db.prepare('UPDATE nodes SET data=? WHERE id=?').run(JSON.stringify(value),id);
 assert.throws(()=>write(node.id,{...data(node.id),type:'text'}),/stay bounded/);
 assert.throws(()=>write(text.id,{...data(text.id),type:'previs'}),/stay bounded/);
 assert.throws(()=>write(node.id,{...data(node.id),label:'x'.repeat(PREVIS_LIMITS.nodeBytes)}),/stay bounded/);
 assert.throws(()=>write(node.id,{...data(node.id),assetId:randomUUID()}),/stay bounded/);
 const id=randomUUID();
 assert.throws(()=>f.store.db.prepare('INSERT INTO nodes(id,projectId,data) VALUES(?,?,?)').run(id,f.projectId,JSON.stringify({...data(node.id),id,scene:null})),/stay bounded/);
 write(text.id,{...data(text.id),text:'y'.repeat(5000)});
});

test('a current backup restores previs nodes read-only: thumbnails can be read, nothing can be saved',async t=>{
 const f=await fixture(t),node=await f.save(await f.create(),scene({keyframes:[keyframe('k1')]}));
 await f.thumbnail(node,'card');await f.thumbnail(node,'k1');
 const tables=['nodes','previs_requests','previs_thumbnails'];
 const rows=(db: DatabaseSync)=>Object.fromEntries(tables.map(table=>{const query=db.prepare(`SELECT rowid AS retainedRowid,* FROM ${table} ORDER BY rowid`);query.setReadBigInts(true);return [table,query.all().map(row=>({...row}))];}));
 const before=rows(f.store.db);await f.stop();
 const base=mkdtempSync(path.join(tmpdir(),'mioon-previs-backup-')),backup=path.join(base,'backup'),restored=path.join(base,'restored');
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 assert.equal((await createWorkspaceBackup({source:f.root,destination:backup})).databaseSchemaVersion,CURRENT_ORDINARY_SCHEMA);
 const result=await restoreWorkspaceBackup({directory:backup,destination:restored});
 assert.deepEqual([result.sourceSchema,result.databaseSchemaVersion,result.profile],[CURRENT_ORDINARY_SCHEMA,CURRENT_RESTORED_SCHEMA,CURRENT_RESTORE_PROFILE]);
 const store=openStore(restored),services=createServices(store,new Map());
 t.after(async()=>{await services.drain?.();store.close();});
 assert.equal(readCurrentWorkspaceRole(store.db),CURRENT_RESTORED_ROLE);
 assert.deepEqual(rows(store.db),before,'previs nodes, receipts and thumbnails are kept byte for byte');
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM workspace_restore_holds WHERE kind='previs_requests'").get()!.n,2);
 const read=await services.call('previs.thumbnail.get',{projectId:f.projectId,nodeId:node.id,slots:['card','k1']}) as PrevisThumbnailGetResponse;
 assert.deepEqual(read.items.map(item=>item.slot),['card','k1']);
 const refused: Record<string,Row>={
  'previs.create':{projectId:f.projectId,position:{x:0,y:0},requestId:randomUUID()},
  'previs.scene.set':{projectId:f.projectId,nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene:scene(),requestId:randomUUID()},
  'previs.thumbnail.set':{projectId:f.projectId,nodeId:node.id,slot:'card',sceneRevision:node.sceneRevision,dataBase64:jpeg(8,8).toString('base64')},
 };
 for(const [operation,input] of Object.entries(refused))await assert.rejects(services.call(operation,input),{code:'RESTORE_OPERATION_UNAVAILABLE'},operation);
 const policy=(await services.call('workspace.restore.inspect',{}) as {operationPolicy: {operation: string; available: boolean}[]}).operationPolicy;
 assert.deepEqual(operations.map(operation=>policy.find(item=>item.operation===operation)?.available),[false,false,false,true]);
 assert.throws(()=>store.db.prepare("UPDATE previs_thumbnails SET updatedAt='x' WHERE nodeId=?").run(node.id),/RESTORE_OPERATION_UNAVAILABLE/);
 assert.throws(()=>store.db.prepare('DELETE FROM previs_thumbnails WHERE nodeId=?').run(node.id),/RESTORE_OPERATION_UNAVAILABLE/);
 assert.throws(()=>store.db.prepare('DELETE FROM previs_requests WHERE nodeId=?').run(node.id),/RESTORED_RECORD_HELD|must be retained/);
 assert.deepEqual(rows(store.db),before);
});

test('an ordinary62 workspace upgrades to previs storage, and its backup restores without it',async t=>{
 const f=await fixture(t);
 const text=await f.call<{id: string}>('node.create',{projectId:f.projectId,type:'text',text:'雨夜',position:{x:0,y:0}});
 await f.stop();
 const db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));
 try{db.exec('PRAGMA foreign_keys=ON');downgradeReviewedWorkspace(db,62);}finally{db.close();}
 const base=mkdtempSync(path.join(tmpdir(),'mioon-previs-62-')),backup=path.join(base,'backup'),restored=path.join(base,'restored');
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 assert.equal((await createWorkspaceBackup({source:f.root,destination:backup})).databaseSchemaVersion,62);
 const result=await restoreWorkspaceBackup({directory:backup,destination:restored});
 assert.deepEqual([result.sourceSchema,result.databaseSchemaVersion],[62,63]);
 const store=openStore(restored),services=createServices(store,new Map());
 t.after(async()=>{await services.drain?.();store.close();});
 assert.equal(readCurrentWorkspaceRole(store.db),'restored-63-evidence');
 assert.equal(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name LIKE '%previs%'").get(),undefined);
 await assert.rejects(services.call('previs.create',{projectId:f.projectId,position:{x:0,y:0},requestId:randomUUID()}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 await assert.rejects(services.call('previs.thumbnail.get',{projectId:f.projectId,nodeId:text.id,slots:['card']}),{code:'PREVIS_NODE_REQUIRED'});
 await assert.rejects(services.call('previs.thumbnail.get',{projectId:f.projectId,nodeId:randomUUID(),slots:['card']}),{code:'NOT_FOUND'});
 // Opening the ordinary62 workspace itself upgrades it in place.
 await f.reopen();
 assert.equal(readCurrentWorkspaceRole(f.store.db),`ordinary-${CURRENT_ORDINARY_SCHEMA}`);
 const node=await f.create();
 assert.equal((await f.save(node,scene({keyframes:[keyframe('k1')]}))).sceneRevision,2);
});

test('project packages carry the scene with remapped exports and leave receipts and thumbnails behind',async t=>{
 const f=await fixture(t),image=await f.asset(),spare=await f.asset({name:'unused.png'});
 const node=await f.save(await f.create({label:'雨夜街口'}),scene({keyframes:[keyframe('k1',[image.id]),keyframe('k2')],activeKeyframeId:'k1'}));
 await f.thumbnail(node,'card');
 const options={media:'used' as const,includeExports:false},collected=collectProject(f.store as never,f.projectId,options);
 assert.deepEqual(collected.document.assets.map(asset=>asset.id),[image.id],'an exported keyframe image counts as used');
 assert.notEqual(spare.id,image.id);
 const work=mkdtempSync(path.join(tmpdir(),'mioon-previs-package-')),targetRoot=mkdtempSync(path.join(tmpdir(),'mioon-previs-target-')),staging=mkdtempSync(path.join(tmpdir(),'mioon-previs-stage-')),file=path.join(work,'previs.mioon');
 t.after(()=>{for(const directory of [work,targetRoot,staging])rmSync(directory,{recursive:true,force:true});});
 const document=packageDocumentBytes(collected.document),manifest=buildManifest({collected,document,appVersion:'test',options,name:'Previs'});
 await pipeline(Readable.from(writeProjectPackage({manifest,document,media:collected.media.map(entry=>entry.source)})),createWriteStream(file));
 const read=await readProjectPackage({source:createReadStream(file),destination:staging});
 const target=openStore(targetRoot),services=createServices(target,new Map());t.after(async()=>{await services.drain?.();target.close();});
 const files=new Map([...read.media].map(([key,value])=>[key,value.file]));
 const {projectId}=createProjectFromDocument(target as never,{document:read.document as never,files,name:'Imported previs',move:false});
 const imported=(await services.call('project.get',{projectId}) as {nodes: PrevisNodeRecord[]; assets: {id: string}[]});
 const copy=imported.nodes.find(item=>item.type==='previs')!;
 assert.notEqual(copy.id,node.id);
 assert.deepEqual([copy.label,copy.revision,copy.sceneRevision],['雨夜街口',node.revision,node.sceneRevision]);
 assert.deepEqual(copy.scene.keyframes[0]!.exports,[imported.assets[0]!.id],'the export follows its remapped asset');
 assert.notEqual(imported.assets[0]!.id,image.id);
 assert.deepEqual({...copy.scene,keyframes:copy.scene.keyframes.map(item=>({...item,exports:[]}))},{...node.scene,keyframes:node.scene.keyframes.map(item=>({...item,exports:[]}))});
 assert.equal(target.db.prepare('SELECT count(*) AS n FROM previs_requests').get()!.n,0);
 assert.equal(target.db.prepare('SELECT count(*) AS n FROM previs_thumbnails').get()!.n,0);
 const saved=await services.call('previs.scene.set',{projectId,nodeId:copy.id,expectedSceneRevision:copy.sceneRevision,scene:copy.scene,requestId:randomUUID()}) as PrevisNodeRecord;
 assert.equal(saved.sceneRevision,copy.sceneRevision+1);
 // A package whose previs node breaks the scene rules, or names a missing export, is refused whole.
 const packaged=read.document as ProjectDocument;
 const broken=(change: (row: Row)=>Row)=>({...packaged,nodes:packaged.nodes.map(row=>row.type==='previs'?change(row):row)}) as never;
 for(const document of [broken(row=>({...row,scene:{...(row.scene as Row),schemaVersion:2}})),broken(row=>({...row,scene:{...(row.scene as Row),keyframes:[keyframe('k1',[randomUUID()])],activeKeyframeId:null}}))])
  assert.throws(()=>createProjectFromDocument(target as never,{document,files,name:'Broken',move:false}),{code:'PROJECT_PACKAGE_INVALID_CONTENT'});
 assert.equal((await services.call('project.list',{}) as unknown[]).length,1);
});

test('deleting a project removes its previs nodes, receipts and thumbnails',async t=>{
 const f=await fixture(t),node=await f.save(await f.create(),scene({keyframes:[keyframe('k1')]}));
 await f.thumbnail(node,'card');await f.thumbnail(node,'k1');
 (f.services as unknown as {setProjectDeletionCompanions: (value: {assertDeletable(id: string): void; removeProject(id: string): void})=>unknown}).setProjectDeletionCompanions({assertDeletable(){},removeProject(){}});
 const project=await f.call<{project: {revision: number}}>('project.get',{projectId:f.projectId});
 await f.call('project.delete',{projectId:f.projectId,expectedRevision:project.project.revision,requestId:randomUUID(),confirmPermanentDeletion:true});
 for(const table of ['nodes','previs_requests','previs_thumbnails'])assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0,table);
});

test('Mio creates and saves previs scenes but never thumbnails, and each operation declares its effects',()=>{
 const admission=AGENT_TASK_OPERATION_ADMISSION as Record<string,{allowed: boolean; tier?: string}>;
 assert.deepEqual(operations.map(operation=>[admission[operation]?.allowed,admission[operation]?.tier]),
  [[true,'local_irreversible'],[true,'local_reversible'],[false,undefined],[false,undefined]]);
 for(const operation of operations)assert.ok(descriptions[operation],operation);
 assert.deepEqual(operations.map(operation=>[operationEffect(operation).readOnly,operationEffect(operation).databaseWrite,operationEffect(operation).paidGeneration]),
  [[false,true,false],[false,true,false],[false,true,false],[true,false,false]]);
});

test('the thumbnail reader accepts canvas JPEG containers and refuses everything else',async()=>{
 assert.deepEqual(previsJpegSize(jpeg(216,384)),{width:216,height:384});
 assert.deepEqual(previsJpegSize(jpeg(384,216,{frame:0xc2})),{width:384,height:216},'progressive');
 const twoFrames=Buffer.concat([jpeg(8,8).subarray(0,39),jpeg(8,8).subarray(20)]);
 for(const bytes of [jpeg(8,8,{frame:0xc3}),jpeg(8,8).subarray(0,30),twoFrames,await renderMockImagePng({width:8,height:8}),Buffer.from([0xff,0xd8,0xff,0xd9])])
  assert.equal(previsJpegSize(bytes),null);
});
