import type {WorkspaceInspection} from './helpers/strict-workspace-boundary-types.ts';
import type {WorkspaceServices as FixtureServices} from './helpers/strict-workspace-boundary-types.ts';
import type {FixtureStore} from './helpers/strict-timeline-core-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30,validateWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32,validateWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {createWorkspaceRestoreProfileV31} from '../packages/business/src/workspace-restore-schema-v31.ts';
import {createWorkspaceRestoreProfileV33} from '../packages/business/src/workspace-restore-schema-v33.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {openStore,classifyCurrentWorkspaceSchema,installCurrentWorkspaceRestoreSchema,validateCurrentWorkspaceRestoreSchema,validateCurrentWorkspaceColourProfile,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {readWorkspaceBackupSchemaVersion} from '../packages/business/src/workspace-backup-schema-versions.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {createServices} from '../packages/business/src/services.ts';
import {RESTORE_READ_OPERATIONS,RESTORE_LOCAL_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {withOrdinaryMigrationSource} from '../apps/desktop/scripts/migration-restore-guard.ts';
import {workspaceBackupSourceSchemaVersion,workspaceRestorationPairSchema} from '../packages/contracts/src/workspace-schema-profiles.ts';
import {projectTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {CUBE_3D_PROFILE, parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import {open,snapshot,fixture,facade,createHistoricalDatabase} from './workspace-schema26-fixtures.mjs';
import type { BinaryLike } from 'crypto';

const hash=(bytes: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
const stamp='2026-10-15T00:00:00.000Z';
const raw=(value?: unknown)=>' \n'+JSON.stringify(value,null,'\t').replaceAll('界','\\u754c')+'\n ';
const meta=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp});
const videoBytes=Buffer.from('synthetic owned video source');
const cube=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
// A real static RGBA8 PNG, with an independent fixture CRC and one scanline.
function pngChunk(kind: string,bytes=Buffer.alloc(0)){
 const result=Buffer.alloc(bytes.length+12);result.writeUInt32BE(bytes.length);result.write(kind,4,4,'ascii');bytes.copy(result,8);
 let crc=0xffffffff;for(const byte of result.subarray(4,-4)){crc^=byte;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}
 result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;
}
const pngHeader=Buffer.alloc(13);pngHeader.writeUInt32BE(1,0);pngHeader.writeUInt32BE(1,4);pngHeader[8]=8;pngHeader[9]=6;
const imageBytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',pngHeader),pngChunk('sRGB',Buffer.from([0])),pngChunk('IDAT',deflateSync(Buffer.from([0,80,120,200,128]))),pngChunk('IEND')]);
const oldProfile=createWorkspaceRestoreProfileV31(initializeWorkspaceSchemaThrough24);
const newProfile=createWorkspaceRestoreProfileV33(initializeWorkspaceSchemaThrough24);
function database(t: test.TestContext,version=32,retained=false){
 const db=open(':memory:');t.after(()=>{if(db.isOpen)db.close();});
 if(retained)fixture(db,'ordinary-24-seeded');else initializeWorkspaceSchemaThrough24(db);
 if(version>=26)initializeWorkspaceSchema26(db);
 if(version>=28)initializeWorkspaceSchema28(db);
 if(version>=30)initializeWorkspaceSchema30(db);
 if(version>=32)initializeWorkspaceSchema32(db);
 return db;
}
function seed(db: DatabaseSync,{managed=true,images=true,history=true,render=true,task=false}={}){
 const projectId=randomUUID(),resourceId=randomUUID(),lutRequest=randomUUID(),trackId=randomUUID();
 const project={id:projectId,name:'Mixed SDR 界',createdAt:stamp,updatedAt:stamp};
 const makeAsset=(mimeType: string,bytes: string|unknown[]|Buffer<ArrayBuffer>)=>{const id=randomUUID();return{id,projectId,name:mimeType==='image/png'?'Still 界':'Video',mimeType,relativePath:`media/${id}.${mimeType==='image/png'?'png':'mp4'}`,sizeBytes:bytes.length,sha256:hash((bytes as unknown as Parameters<typeof hash>[0])),width:1,height:1,duration:mimeType==='image/png'?null:1,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:stamp};};
 const videoAsset=makeAsset('video/mp4',videoBytes),imageAsset=makeAsset('image/png',imageBytes),assets=images?[videoAsset,imageAsset]:[videoAsset];
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,raw(project));
 for(const asset of assets)db.prepare('INSERT INTO assets VALUES(?,?,?)').run(asset.id,projectId,raw(asset));
 db.prepare('INSERT INTO project_lut_resources VALUES(?,?,?,?,?,?,?,?,?)').run(resourceId,projectId,'look.cube',hash(cube),cube.length,'mioon-cube3d-normalized-tetrahedral-v1',raw(parseCube3D(cube.toString()).metadata),cube,stamp);
 db.prepare('INSERT INTO lut_import_requests VALUES(?,?,?,?)').run(lutRequest,projectId,lutInputHash({projectId,requestId:lutRequest,name:'look.cube'},hash(cube),cube.length),resourceId);
 const look={resourceId,resourceSha256:hash(cube),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:0.35};
 const videoColour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:videoAsset.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look};
 const evidence={profileId:'png-rgb8-srgb-v1',sha256:imageAsset.sha256,sourceByteLength:imageBytes.length,width:1,height:1,bitDepth:8,alphaMode:'straight',orientation:1,colourTag:'srgb'};
 const imageColour={profileId:'mioon-srgb-image-clip-v1',source:{assetSha256:imageAsset.sha256,profileId:'png-rgb8-srgb-v1',interpretation:'srgb',declaredBy:'user',declaredAt:stamp,evidence},look};
 const track={id:trackId,name:'Video 1',kind:'video',orderIndex:0,hidden:false,muted:false};
 const clips=assets.map((asset,index)=>({id:randomUUID(),assetId:asset.id,trackId,name:asset.name,startFrame:index*30,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,...(managed?{colour:asset.mimeType==='image/png'?imageColour:videoColour}:{})}));
 const timeline={id:randomUUID(),projectId,revision:1,fps:30,width:720,height:1280,tracks:[track],clips,durationFrames:clips.length*30,createdAt:stamp,updatedAt:stamp};
 db.prepare('INSERT INTO timelines VALUES(?,?,?)').run(timeline.id,projectId,raw(timeline));
 if(history){
  const before={tracks:[track],clips:clips.map(({colour,...clip})=>clip),durationFrames:timeline.durationFrames};
  const after={tracks:[track],clips,durationFrames:timeline.durationFrames};
  db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),projectId,1,'timeline.clip.update',stamp,raw(before),raw((((after!)))));
  db.prepare('INSERT INTO timeline_history_cursors VALUES(?,?)').run(projectId,1);
 }
 let rendered;
 if(render){
  const frozen={timeline,assets};const plan=projectTimelineColourPlan(frozen);if(plan)(frozen as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan=plan;
  rendered={id:randomUUID(),projectId,requestId:randomUUID(),mode:'timeline',purpose:'preview',timelineRevision:1,snapshot:frozen,status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
  db.prepare('INSERT INTO exports VALUES(?,?,?)').run(rendered.id,projectId,raw(rendered));
  db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(rendered.requestId,'a'.repeat(64),raw(rendered));
 }
 let taskInput;
 if(task){const requestId=randomUUID();taskInput={projectId,requestId,expectedRevision:1,clipId:clips[0].id,patch:{name:'Retained intent'}};insertTask(db,taskInput);}
 return{projectId,project,assets,videoAsset,imageAsset,timeline,videoColour,imageColour,evidence,rendered,resourceId,taskInput};
}
function insertTask(db: DatabaseSync,input: { projectId: string; requestId: string; expectedRevision?: number; clipId?: `${string}-${string}-${string}-${string}-${string}`; patch?: { name: string; }|{ colour: { profileId: string; source: { assetSha256: string; profileId: string; interpretation: string; declaredBy: string; declaredAt: string; evidence: { profileId: string; sha256: string; sourceByteLength: number; width: number; height: number; bitDepth: number; alphaMode: string; orientation: number; colourTag: string; }; }; look: { resourceId: `${string}-${string}-${string}-${string}-${string}`; resourceSha256: string; resourceProfile: string; purpose: string; declaredBy: string; enabled: boolean; strength: number; }; }; }; },status='prepared'){
 const text=raw((((input!))));
 db.prepare('INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,errorCode,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),input.projectId,'timeline.clip.update',text,input.requestId,hash(text),'timeline:mutation','new',status,status==='prepared'?1:3,0,status==='not_applied'?'LUT_NOT_FOUND':null,stamp,stamp,16384);
 return text;
}
function rewrite(db: DatabaseSync,table: string,sql: string,...values: string[]){
 const guards=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE UPDATE%'").all(table);
 for(const guard of guards)db.exec(`DROP TRIGGER "${guard.name}"`);
 db.prepare(sql).run(...values);
 for(const guard of guards)db.exec((guard.sql as string));
}
function changeTimeline(db: DatabaseSync,change: (value:import('./helpers/strict-workspace-boundary-types.ts').MutableTimeline)=>void){const row=db.prepare('SELECT id,data FROM timelines ORDER BY rowid DESC LIMIT 1').get(),value=JSON.parse(((row!.data as string)));change(value);rewrite(db,'timelines','UPDATE timelines SET data=? WHERE id=?',raw(value),(row!.id as string));}
function updateAsset(db: DatabaseSync,asset: { id: unknown; projectId?: `${string}-${string}-${string}-${string}-${string}`; name?: string; mimeType?: unknown; relativePath?: string; sizeBytes?: unknown; sha256?: string; width?: number; height?: number; duration?: number|null; hasVideo?: boolean; hasAudio?: boolean; provenance?: string; createdAt?: string; },change: { mimeType: string; }){const next={...asset,...change};rewrite(db,'assets','UPDATE assets SET data=? WHERE id=?',raw(next),(asset.id as string));return next;}
function rewriteLocation(db: DatabaseSync,location: string,value: { clips: { colour: { profileId: string; source: { assetSha256: string; streamIndex: number; profileId: string; range: string; declaredBy: string; declaredAt: string; }; look: { resourceId: `${string}-${string}-${string}-${string}-${string}`; resourceSha256: string; resourceProfile: string; purpose: string; declaredBy: string; enabled: boolean; strength: number; }; }|{ profileId: string; source: { assetSha256: string; profileId: string; interpretation: string; declaredBy: string; declaredAt: string; evidence: { profileId: string; sha256: string; sourceByteLength: number; width: number; height: number; bitDepth: number; alphaMode: string; orientation: number; colourTag: string; }; }; look: { resourceId: `${string}-${string}-${string}-${string}-${string}`; resourceSha256: string; resourceProfile: string; purpose: string; declaredBy: string; enabled: boolean; strength: number; }; }; id: `${string}-${string}-${string}-${string}-${string}`; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: `${string}-${string}-${string}-${string}-${string}`; name: string; startFrame: number; durationFrames: number; sourceInFrame: number; rect: { x: number; y: number; width: number; height: number; }; gain: number; }[]; id: `${string}-${string}-${string}-${string}-${string}`; projectId: `${string}-${string}-${string}-${string}-${string}`; revision: number; fps: number; width: number; height: number; tracks: { id: `${string}-${string}-${string}-${string}-${string}`; name: string; kind: string; orderIndex: number; hidden: boolean; muted: boolean; }[]; durationFrames: number; createdAt: string; updatedAt: string; sourceEvidence?: undefined; plan?: undefined; }|{ projectId: `${string}-${string}-${string}-${string}-${string}`; sourceEvidence: { assetSha256: string; profileId: string; interpretation: string; declaredBy: string; declaredAt: string; evidence: { profileId: string; sha256: string; sourceByteLength: number; width: number; height: number; bitDepth: number; alphaMode: string; orientation: number; colourTag: string; }; }; plan?: undefined; }|{ projectId: `${string}-${string}-${string}-${string}-${string}`; plan: { profileId: "mioon-rec709-sdr-render-v1"; working: "rec709-encoded-rgb8-v1"; output: "rec709-yuv420p-limited-v1"; lutAlgorithm: "cube3d-tetrahedral-premixed-v1"; outOfDomain: "clip-lut-domain"; clips: { assetId: string; clipId: string; assetSha256: string; streamIndex: number; range: "limited"|"full"; look: { resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; declaredBy: "user"; enabled: boolean; strength: number; }|null; }[]; }|{ profileId: "mioon-mixed-sdr-render-v2"; working: "rec709-encoded-rgb8-v1"; output: "rec709-yuv420p-limited-v1"; lutAlgorithm: "cube3d-tetrahedral-premixed-v1"; outOfDomain: "clip-lut-domain"; clips: ({ assetId: string; clipId: string; assetSha256: string; streamIndex: number; range: "limited"|"full"; look: { resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; declaredBy: "user"; enabled: boolean; strength: number; }|null; kind: "video"; sourceProfileId: "rec709-yuv-sdr-v1"; }|{ assetId: string; clipId: string; assetSha256: string; streamIndex: 0; look: { resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; declaredBy: "user"; enabled: boolean; strength: number; }|null; kind: "image"; sourceProfileId: "png-rgb8-srgb-v1"; interpretation: "srgb"; evidence: { sha256: string; profileId: "png-rgb8-srgb-v1"; sourceByteLength: number; width: number; height: number; bitDepth: 8; alphaMode: "straight"|"opaque"; orientation: 1; colourTag: "srgb"|"untagged"; }; transformProfile: "srgb8-to-bt1886-zero-black-display-v1"; algorithm: "rgb8-fixed-linear-table256-v1"; algorithmSha256: "383f159aebd6758ead128a3f1291ec70275bbd6bf60aef603e17d2d3726c303c"; referenceDisplay: { eotf: "bt1886-zero-black"; gamma: 2.4; black: 0; white: 1; luminance: "relative"; primaries: "bt709"; whitePoint: "D65"; }; alpha: "straight-transform-look-premultiply-resize"; resizeProfile: "png-contain-bilinear-mirror-premultiplied-v1"; })[]; }|{ profileId: "mioon-mixed-sdr-render-v3"; working: "rec709-encoded-rgb8-v1"; output: "rec709-yuv420p-limited-v1"; lutAlgorithm: "cube3d-tetrahedral-premixed-v1"; outOfDomain: "clip-lut-domain"; clips: ({ assetId: string; clipId: string; assetSha256: string; streamIndex: number; range: "limited"|"full"; look: { resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; declaredBy: "user"; enabled: boolean; strength: number; }|null; kind: "video"; sourceProfileId: "rec709-yuv-sdr-v1"; }|{ assetId: string; clipId: string; assetSha256: string; streamIndex: 0; look: { resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; declaredBy: "user"; enabled: boolean; strength: number; }|null; kind: "image"; sourceProfileId: "png-rgb8-srgb-v1"; interpretation: "srgb"; evidence: { sha256: string; profileId: "png-rgb8-srgb-v1"; sourceByteLength: number; width: number; height: number; bitDepth: 8; alphaMode: "straight"|"opaque"; orientation: 1; colourTag: "srgb"|"untagged"; }; transformProfile: "srgb8-to-bt1886-zero-black-display-v1"; algorithm: "rgb8-fixed-linear-table256-v1"; algorithmSha256: "383f159aebd6758ead128a3f1291ec70275bbd6bf60aef603e17d2d3726c303c"; referenceDisplay: { eotf: "bt1886-zero-black"; gamma: 2.4; black: 0; white: 1; luminance: "relative"; primaries: "bt709"; whitePoint: "D65"; }; alpha: "straight-transform-look-premultiply-resize"; resizeProfile: "png-contain-bilinear-mirror-premultiplied-v1"; }|{ assetId: string; clipId: string; assetSha256: string; streamIndex: 0; look: { resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; declaredBy: "user"; enabled: boolean; strength: number; }|null; kind: "image"; sourceProfileId: "jfif-ycbcr8-srgb-v1"; interpretation: "srgb"; evidence: { sha256: string; profileId: "jfif-ycbcr8-srgb-v1"; sourceByteLength: number; width: number; height: number; bitDepth: 8; alphaMode: "opaque"; orientation: 1; colourTag: "untagged"; sampling: "444"|"422"|"420"; decoderPolicy: "ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1"; }; transformProfile: "srgb8-to-bt1886-zero-black-display-v1"; algorithm: "rgb8-fixed-linear-table256-v1"; algorithmSha256: "383f159aebd6758ead128a3f1291ec70275bbd6bf60aef603e17d2d3726c303c"; referenceDisplay: { eotf: "bt1886-zero-black"; gamma: 2.4; black: 0; white: 1; luminance: "relative"; primaries: "bt709"; whitePoint: "D65"; }; alpha: "opaque-transform-look-premultiply-resize"; resizeProfile: "png-contain-bilinear-mirror-premultiplied-v1"; decodeProfile: "ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1"; })[]; }|undefined; sourceEvidence?: undefined; },f: ReturnType<typeof seed>){
 if(location==='timeline')rewrite(db,'timelines','UPDATE timelines SET data=? WHERE id=?',raw(value),f.timeline.id);
 if(location==='history')rewrite(db,'timeline_history','UPDATE timeline_history SET afterSnapshot=? WHERE projectId=?',raw(value),(f.projectId as string));
 if(location==='receipt')rewrite(db,'timeline_requests','UPDATE timeline_requests SET response=? WHERE requestId=?',raw(value),f.rendered!.requestId);
 if(location==='export')rewrite(db,'exports','UPDATE exports SET data=? WHERE id=?',raw(value),f.rendered!.id);
 if(location==='task')rewrite(db,'edit_tasks','UPDATE edit_tasks SET input=? WHERE requestId=?',raw({...f.taskInput,payload:value}),f.taskInput!.requestId);
}

for(const retained of [false,true] as const)test(`30→32 adds only its marker and preserves exact rows, types, rowids, DDL and v1 plan (retained=${retained})`,t=>{
 const db=database(t,30,retained);const f=seed(db,{images:false});const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.equal((f.rendered!.snapshot as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan!.profileId,'mioon-rec709-sdr-render-v1');
 initializeWorkspaceSchema32(db);const after=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.deepEqual(after.objects,before.objects);
 after.tables.schema_version.rows=after.tables.schema_version.rows.filter((row)=>row[0]!=='32');assert.deepEqual(after.tables,before.tables);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...Array.from({length:24},(_,i)=>i+1),26,28,30,32]);
 assert.deepEqual(classifyCurrentWorkspaceSchema(db),{schemaVersion:32,profile:'ordinary'});assert.equal(readWorkspaceBackupSchemaVersion(db),32);assert.equal(readCurrentWorkspaceRole(db),'ordinary-32');
 const stable=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);initializeWorkspaceSchema32(db);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),stable);
 assert.throws(()=>validateWorkspaceSchema30(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.throws(()=>oldProfile.classifyWorkspaceSchemaV30V31(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
});

for(const point of ['after marker','before commit'] as const)test(`schema32 migration rolls back all retained bytes ${point}`,t=>{
 const db=database(t,30);seed(db,{images:false});const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);let reached=false;
 const intercepted=((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>{if(point==='after marker'?event.phase==='after'&&event.sql==='INSERT INTO main.schema_version(version) VALUES(32)':event.phase==='before'&&event.sql==='COMMIT'){reached=true;throw Object.assign(Error('interrupted'),{code:'INJECTED32'});}}) as unknown as import("node:sqlite").DatabaseSync);
 assert.throws(()=>initializeWorkspaceSchema32((intercepted as unknown as Parameters<typeof initializeWorkspaceSchema32>[0])),{code:'INJECTED32'});assert.equal(reached,true);assert.equal(db.isTransaction,false);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 assert.doesNotThrow(()=>initializeWorkspaceSchema32(db));
});

for(const version of [24,26,28,30,32] as const)test(`current dispatcher retains exact source${version}/restored${version+1} pair without upgrading historical restores`,t=>{
 const db=database(t,version);assert.equal(classifyCurrentWorkspaceSchema(db).schemaVersion,version);
 const info=installCurrentWorkspaceRestoreSchema(db,meta());assert.equal(info.schemaVersion,version+1);assert.equal(info.sourceSchema,version);
 assert.equal(readCurrentWorkspaceRole(db),`restored-${version+1}-evidence`);assert.deepEqual(validateCurrentWorkspaceRestoreSchema(db),info);
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>initializeWorkspaceSchema32(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

test('wire contracts admit only exact registered source/restoration pairings and keep restored schemas out of backup sources',()=>{
 for(const value of [1,24,26,28,30,32,34,36,38,40,44,48] as const)assert.equal(workspaceBackupSourceSchemaVersion.safeParse(value).success,true);
 for(const value of [25,27,29,31,33,35,37,39,41,45,49,32.5] as const)assert.equal(workspaceBackupSourceSchemaVersion.safeParse(value).success,false);
 for(const [profile,sourceSchema,databaseSchemaVersion]of [['restored-local-v1',24,25],['restored-local-v2',26,27],['restored-local-v3',28,29],['restored-local-v4',30,31],['restored-local-v5',32,33],['restored-local-v6',34,35],['restored-local-v7',36,37],['restored-local-v8',38,39],['restored-local-v9',40,41],['restored-local-v11',44,45],['restored-local-v13',48,49]] as const)assert.equal(workspaceRestorationPairSchema.safeParse({profile,sourceSchema,databaseSchemaVersion}).success,true);
 for(const profile of ['restored-local-v10','restored-local-v12','restored-local-v14'] as const)for(const sourceSchema of [24,26,28,30,32,34,36,38,40,44,48] as const)assert.equal(workspaceRestorationPairSchema.safeParse({profile,sourceSchema,databaseSchemaVersion:sourceSchema+1}).success,false);
});

for(const change of ['future marker','missing32','missing30','missing28','missing26','restored33 without32','restored31 with32'] as const)test(`mixed-role reader rejects corrupt or downgraded markers: ${change}`,t=>{
 const db=database(t);seed(db);
 const sql={'future marker':'INSERT INTO schema_version VALUES(36)',missing32:'DELETE FROM schema_version WHERE version=32',missing30:'DELETE FROM schema_version WHERE version=30',missing28:'DELETE FROM schema_version WHERE version=28',missing26:'DELETE FROM schema_version WHERE version=26','restored33 without32':'DELETE FROM schema_version WHERE version=32;INSERT INTO schema_version VALUES(33)','restored31 with32':'INSERT INTO schema_version VALUES(31)'}[change];db.exec(sql);
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>classifyCurrentWorkspaceSchema(db));assert.throws(()=>validateCurrentWorkspaceColourProfile(db));assert.throws(()=>initializeWorkspaceSchema32(db));assert.throws(()=>readWorkspaceBackupSchemaVersion(db),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

for(const role of [30,31] as const)for(const location of ['timeline','history','receipt','task','export'] as const)for(const payload of ['image clip','image source','mixed plan'] as const)test(`historical${role} rejects ${payload} in ${location} without mutation`,t=>{
 const db=database(t,30),f=seed(db,{managed:false,task:true});
 if(role===31)oldProfile.installWorkspaceRestoreSchemaV31(db,meta());
 const mixedTimeline={...f.timeline,clips:f.timeline.clips.map((clip,index)=>({...clip,colour:index?f.imageColour:f.videoColour}))};
 const value=payload==='image clip'?{...mixedTimeline}:payload==='image source'?{projectId:f.projectId,sourceEvidence:f.imageColour.source}:{projectId:f.projectId,plan:projectTimelineColourPlan({timeline:mixedTimeline,assets:f.assets})};
 rewriteLocation(db,location,value,f);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.throws(()=>oldProfile.classifyWorkspaceSchemaV30V31(db));assert.throws(()=>classifyCurrentWorkspaceSchema(db));assert.throws(()=>validateCurrentWorkspaceColourProfile(db));
 if(role===30){assert.throws(()=>initializeWorkspaceSchema32(db));assert.throws(()=>readWorkspaceBackupSchemaVersion(db),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});}
 else assert.throws(()=>validateCurrentWorkspaceRestoreSchema(db));
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

for(const kind of ['source hash','evidence hash','source profile','clip profile','interpretation','unknown evidence field','wrong MIME','image profile on video','video profile on image','foreign asset','foreign LUT','missing LUT','LUT hash','audio track','duplicate key'] as const)test(`schema32 rejects accepted image binding corruption: ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});
 if(kind==='wrong MIME')updateAsset(db,f.imageAsset,{mimeType:'image/jpeg'});
 else if(kind==='foreign asset'){const other=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(other,raw({id:other}));db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(other,f.imageAsset.id);}
 else if(kind==='foreign LUT'){const other=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(other,raw({id:other}));db.exec('PRAGMA foreign_keys=OFF');rewrite(db,'project_lut_resources','UPDATE project_lut_resources SET projectId=? WHERE id=?',other,f.resourceId);db.exec('PRAGMA foreign_keys=ON');}
 else if(kind==='duplicate key')rewrite(db,'timelines','UPDATE timelines SET data=? WHERE id=?','{"colour":null,"colour":{}}',f.timeline.id);
 else changeTimeline(db,(value)=>{
  const colour=value.clips[1].colour;
  if(kind==='source hash')colour!.source!.assetSha256='f'.repeat(64);
  if(kind==='evidence hash')colour!.source!.evidence!.sha256='f'.repeat(64);
  if(kind==='source profile')colour!.source!.profileId='rec709-yuv-sdr-v1';
  if(kind==='clip profile')colour!.profileId='mioon-rec709-sdr-clip-v1';
  if(kind==='interpretation')colour!.source!.interpretation='display-p3';
  if(kind==='unknown evidence field')colour!.source!.evidence!.future=true;
  if(kind==='image profile on video')value.clips[1].assetId=f.videoAsset.id;
  if(kind==='video profile on image')value.clips[1].colour={...f.videoColour,source:{...f.videoColour.source,assetSha256:f.imageAsset.sha256}};
  if(kind==='missing LUT')colour!.look!.resourceId=randomUUID();
  if(kind==='LUT hash')colour!.look!.resourceSha256='f'.repeat(64);
  if(kind==='audio track')value.tracks[0].kind='audio';
 });
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>validateWorkspaceSchema32(db),{code:'WORKSPACE_COLOUR_INVALID'});assert.throws(()=>classifyCurrentWorkspaceSchema(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

for(const profile of ['image','video'] as const)for(const mimeType of ['video/mp4','video/webm','image/png'] as const)test(`schema32 retains invalidated ${profile} declaration on ${mimeType}, but cannot freeze it for render`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});
 updateAsset(db,f.imageAsset,{mimeType});const colour={...(profile==='image'?f.imageColour:f.videoColour),source:null};
 changeTimeline(db,(value)=>{value.clips[1].colour=colour;});const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.doesNotThrow(()=>validateWorkspaceSchema32(db));assert.doesNotThrow(()=>validateCurrentWorkspaceColourProfile(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 const timeline=JSON.parse(((db.prepare('SELECT data FROM timelines').get()!.data as string))),assets=f.assets.map(asset=>asset.id===f.imageAsset.id?{...asset,mimeType}:asset);
 assert.deepEqual(timeline.clips[1].colour,colour);assert.throws(()=>projectTimelineColourPlan({timeline,assets}),{code:'INVALID_TIMELINE_COLOUR'});
 const restored=installCurrentWorkspaceRestoreSchema(db,meta());assert.equal(restored.schemaVersion,33);assert.deepEqual(validateCurrentWorkspaceRestoreSchema(db),restored);
});

for(const mimeType of ['image/jpeg','image/webp','audio/wav','video/quicktime'] as const)test(`invalidated source:null never admits unsupported ${mimeType}`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});updateAsset(db,f.imageAsset,{mimeType});changeTimeline(db,(value)=>{value.clips[1].colour!.source=null;});assert.throws(()=>validateWorkspaceSchema32(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

for(const kind of ['missing plan','wrong plan profile','changed evidence','changed algorithm','changed display','extra field'] as const)test(`schema32 frozen snapshot rejects ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false});const changed=structuredClone(f.rendered),plan=(changed!.snapshot as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan;
 if(kind==='missing plan')delete (changed!.snapshot as unknown as Record<PropertyKey,unknown>).colourPlan;
 if(kind==='wrong plan profile')plan!.profileId='mioon-rec709-sdr-render-v1';
 if(kind==='changed evidence')(plan!.clips[1] as unknown as {evidence:{width:number}}).evidence.width++;
 if(kind==='changed algorithm')(plan!.clips[1] as unknown as {algorithmSha256:string}).algorithmSha256='f'.repeat(64);
 if(kind==='changed display')((plan!.clips[1] as unknown as {referenceDisplay:{gamma:number}}).referenceDisplay as unknown as {gamma:number}).gamma=2.2;
 if(kind==='extra field')(plan! as unknown as {future:boolean}).future=true;
 rewrite(db,'exports','UPDATE exports SET data=? WHERE id=?',raw(changed),f.rendered!.id);
 assert.throws(()=>validateWorkspaceSchema32(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

for(const status of ['prepared','not_applied'] as const)test(`schema32 retains unresolved ${status} image intent without granting source or LUT authority`,t=>{
 const db=database(t),f=seed(db,{render:false});const colour=structuredClone(f.imageColour);
 colour.look.resourceId=randomUUID();colour.look.resourceSha256='f'.repeat(64);colour.source.assetSha256=colour.source.evidence.sha256='e'.repeat(64);
 const input={projectId:f.projectId,requestId:randomUUID(),expectedRevision:1,clipId:f.timeline.clips[1].id,patch:{colour}},text=insertTask(db,input,status),before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.doesNotThrow(()=>initializeWorkspaceSchema32(db));assert.equal(readWorkspaceBackupSchemaVersion(db),32);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 assert.equal(installCurrentWorkspaceRestoreSchema(db,meta()).schemaVersion,33);assert.equal(db.prepare('SELECT input FROM edit_tasks').get()!.input,text);
});

for(const fragment of ['CREATE TABLE workspace_restoration','INSERT INTO workspace_restore_timeline_history','CREATE TRIGGER restore_legacy_schema_gate','COMMIT'] as const)test(`restored33 installation rolls back at ${fragment}`,t=>{
 const db=database(t);seed(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);let fired=false;
 const wrapped={get isTransaction(){return db.isTransaction;},prepare:db.prepare.bind(db),exec(sql: string|string[]){if(!fired&&fragment==='COMMIT'&&sql==='COMMIT'){fired=true;throw Error('injected33');}const result=db.exec((sql as unknown as Parameters<typeof db.exec>[0]));if(!fired&&sql.includes(fragment)){fired=true;throw Error('injected33');}return result;}};
 assert.throws(()=>newProfile.installWorkspaceRestoreSchemaV33((wrapped as unknown as Parameters<typeof newProfile.installWorkspaceRestoreSchemaV33>[0]),meta()),/injected33/);assert.equal(fired,true);assert.equal(db.isTransaction,false);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 assert.equal(newProfile.installWorkspaceRestoreSchemaV33(db,meta()).schemaVersion,33);
});

test('cold backup32→restored33 preserves exact mixed image evidence, raw receipts/history, v2 snapshot, LUT/source bytes across reopen',async t=>{
 const base=mkdtempSync(path.join(tmpdir(),'mioon-mixed-backup-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'source'),backup=path.join(base,'backup'),restored=path.join(base,'restored');
 const db=createHistoricalDatabase(root,32);const f=seed(db,{task:true}),before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.equal(classifyCurrentWorkspaceSchema(db).schemaVersion,32);
 for(const asset of f.assets)writeFileSync(path.join(root,asset.relativePath),asset.mimeType==='image/png'?imageBytes:videoBytes,{mode:0o600});db.close();
 const sourceBytes=readFileSync(path.join(root,'workbench.sqlite'));
 let consumed=false;await withOrdinaryMigrationSource(path.join(root,'workbench.sqlite'),async({file})=>{consumed=true;assert.deepEqual(readFileSync(file),sourceBytes);});assert.equal(consumed,true);
 const captured=await (createWorkspaceBackup({source:root,destination:backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);assert.equal(captured.databaseSchemaVersion,32);assert.equal(captured.integrity,'verified');
 assert.equal((await (verifyWorkspaceBackup({directory:backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>)).databaseSchemaVersion,32);assert.deepEqual(readFileSync(path.join(backup,'payload/workbench.sqlite')),sourceBytes);
 const installed=await (restoreWorkspaceBackup({directory:backup,destination:restored}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreResult>);assert.equal(installed.databaseSchemaVersion,33);assert.equal(installed.sourceSchema,32);assert.equal(installed.profile,'restored-local-v5');
 for(let attempt=0;attempt<2;attempt++){
  const reopened=(openStore(restored) as unknown as FixtureStore);try{
   assert.equal((getWorkspaceRestoreContext(reopened) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata|null)!.schemaVersion,33);const actual=(snapshot(reopened.db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
   for(const table of ['timelines','timeline_history','timeline_requests','exports','project_lut_resources','lut_import_requests'] as const)assert.deepEqual(actual.tables[table],before.tables[table],`${table}: raw retained bytes at reopen ${attempt}`);
   assert.deepEqual(JSON.parse(((reopened.db.prepare('SELECT data FROM timelines').get()!.data as string))),f.timeline);
   assert.deepEqual((JSON.parse(((reopened.db.prepare('SELECT data FROM exports').get()!.data as string))).snapshot as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan,(f.rendered!.snapshot as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan);
   assert.deepEqual(Buffer.from((reopened.db.prepare('SELECT content FROM project_lut_resources').get()!.content! as unknown as string)),cube);
   assert.equal(reopened.db.prepare('SELECT input FROM edit_tasks').get()!.input,raw(f.taskInput));assert.equal(reopened.db.prepare('SELECT executionEpoch FROM edit_tasks').get()!.executionEpoch,'captured');
   assert.deepEqual(reopened.db.prepare('SELECT id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot FROM workspace_restore_timeline_history ORDER BY capturedRowid').all(),reopened.db.prepare('SELECT id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot FROM timeline_history ORDER BY rowid').all());
   assert.throws(()=>oldProfile.classifyWorkspaceSchemaV30V31(reopened.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  }finally{reopened.close();}
 }
 assert.deepEqual(readFileSync(path.join(root,'workbench.sqlite')),sourceBytes);assert.deepEqual(readFileSync(path.join(restored,f.imageAsset.relativePath)),imageBytes);assert.deepEqual(readFileSync(path.join(restored,f.videoAsset.relativePath)),videoBytes);
 await assert.rejects((createWorkspaceBackup({source:restored,destination:path.join(base,'forbidden')}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>),{code:'RESTORE_BACKUP_UNAVAILABLE'});assert.equal(existsSync(path.join(base,'forbidden')),false);
});

for(const location of ['live timeline','archive','held snapshot'] as const)test(`restored33 revalidation rejects corrupted ${location} without repairing captured image evidence`,t=>{
 const db=database(t),f=seed(db);installCurrentWorkspaceRestoreSchema(db,meta());
 if(location==='live timeline')changeTimeline(db,(value)=>{value.clips[1].colour!.source!.evidence!.sha256='f'.repeat(64);});
 if(location==='archive'){const value={tracks:f.timeline.tracks,clips:structuredClone(f.timeline.clips),durationFrames:60};((value.clips[1].colour!.source as unknown as {evidence:{alphaMode:string}}).evidence as unknown as {alphaMode:string}).alphaMode='premultiplied';rewrite(db,'workspace_restore_timeline_history','UPDATE workspace_restore_timeline_history SET afterSnapshot=?',raw((((value!)))));}
 if(location==='held snapshot'){const value=structuredClone(f.rendered);((value!.snapshot as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan!.clips[1] as unknown as {resizeProfile:string}).resizeProfile='future-v2';rewrite(db,'exports','UPDATE exports SET data=?',raw(value));}
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>validateCurrentWorkspaceRestoreSchema(db),{code:'WORKSPACE_COLOUR_INVALID'});assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

test('restored33 keeps source inspection and LUT import denied; reads and explicit-origin local actions retain existing fences',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'mioon-mixed-permissions-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const hist=createHistoricalDatabase(root,32);const f=seed(hist);hist.close();const db=new DatabaseSync(path.join(root,'workbench.sqlite'));
 const info=installCurrentWorkspaceRestoreSchema(db,meta());db.close();let store=(openStore(root) as unknown as FixtureStore);const services=(createServices(store,new Map()) as unknown as FixtureServices);
 try{
  const context={expectedWorkspaceOrigin:info.workspaceOrigin};assert.deepEqual(await services.call('timeline.get',{projectId:f.projectId}),f.timeline);
  assert.equal((await services.call('asset.list',{projectId:f.projectId})).length,2);
  const disclosure=await services.call('workspace.restore.inspect',{}) as Extract<WorkspaceInspection,{restored:true}>;assert.equal(disclosure.schemaVersion,33);assert.equal(disclosure.source.schemaVersion,32);
  const before=(snapshot(store.db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
  for(const operation of ['timeline.colour.image.inspect','timeline.colour.source.inspect','lut.import'] as const){
   assert.equal(RESTORE_READ_OPERATIONS.includes(operation),false);assert.equal(RESTORE_LOCAL_OPERATIONS.includes(operation),false);
   const input=operation==='lut.import'?{projectId:f.projectId,requestId:randomUUID(),name:'new.cube',dataBase64:cube.toString('base64')}:{projectId:f.projectId,assetId:operation==='timeline.colour.image.inspect'?f.imageAsset.id:f.videoAsset.id};
   await assert.rejects(services.call(operation,input,context),{code:'RESTORE_OPERATION_UNAVAILABLE'});
  }
  for(const [context,code] of [[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']] as const)await assert.rejects(services.call('project.create',{name:'No authority'},context),{code});
  assert.deepEqual((snapshot(store.db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
  const created=await services.call('project.create',{name:'Explicit local action'},context);assert.equal(created.name,'Explicit local action');
  assert.equal(validateCurrentWorkspaceRestoreSchema(store.db).schemaVersion,33);
  assert.throws(()=>store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(raw(((({...f.rendered,status:'succeeded'}!)))),f.rendered!.id),/RESTORED_RECORD_HELD|immutable/i);
 }finally{await services.drain();store.close();}
});

test('cold capture and migration refuse missing32 and corrupt image evidence before publishing a destination',async t=>{
 for(const kind of ['missing32','corrupt evidence'] as const){
  const base=mkdtempSync(path.join(tmpdir(),'mioon-mixed-refuse-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const root=path.join(base,'source'),backup=path.join(base,'backup');
  const db=createHistoricalDatabase(root,32);seed(db,{render:false});if(kind==='missing32')db.exec('DELETE FROM schema_version WHERE version=32');else changeTimeline(db,(value)=>{value.clips[1].colour!.source!.evidence!.sha256='f'.repeat(64);});db.close();
  const bytes=readFileSync(path.join(root,'workbench.sqlite'));let consumed=false;await assert.rejects(withOrdinaryMigrationSource(path.join(root,'workbench.sqlite'),((()=>{consumed=true;}) as unknown as Parameters<typeof withOrdinaryMigrationSource>[1])));assert.equal(consumed,false);
  await assert.rejects((createWorkspaceBackup({source:root,destination:backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});assert.equal(existsSync(path.join(backup,'COMPLETE.json')),false);assert.deepEqual(readFileSync(path.join(root,'workbench.sqlite')),bytes);
 }
});
