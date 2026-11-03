import {validateTimelineOpacityRows as validateAll} from '../packages/business/src/timeline-retained-opacity.ts';
import {validateTimelineColourRows as validateRows} from '../packages/business/src/timeline-retained-colour.ts';
import {lexerDatabase,snapshot,publicAsset} from './helpers/current-retained-fixture.ts';

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';

import {deflateSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';

import {projectTimelineColourPlan} from '../packages/contracts/src/timeline-colour.ts';
import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import type { BinaryLike } from 'crypto';

const hash=(bytes: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
const stamp='2026-10-15T00:00:00.000Z';
const raw=(value?: unknown)=>' \n'+JSON.stringify(value,null,'\t').replaceAll('界','\\u754c')+'\n ';
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
function database(t: test.TestContext){return lexerDatabase(t);}

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
  const frozen={timeline,assets:assets.map(publicAsset)};const plan=projectTimelineColourPlan(frozen);if(plan)(frozen as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan=plan;
  rendered={id:randomUUID(),projectId,requestId:randomUUID(),mode:'timeline',purpose:'preview',timelineRevision:1,snapshot:frozen,status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
  db.prepare('INSERT INTO exports VALUES(?,?,?)').run(rendered.id,projectId,raw(rendered));
  db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(rendered.requestId,'a'.repeat(64),raw(rendered));
 }
 let taskInput;
 if(task){const requestId=randomUUID();taskInput={projectId,requestId,expectedRevision:1,clipId:clips[0].id,patch:{name:'Retained intent'}};insertTask(db,taskInput);}
 assert.doesNotThrow(()=>validateRows(db));
 return{projectId,project,assets,videoAsset,imageAsset,timeline,videoColour,imageColour,evidence,rendered,resourceId,taskInput};
}
function insertTask(db: DatabaseSync,input: { projectId: string; requestId: string; expectedRevision?: number; clipId?: `${string}-${string}-${string}-${string}-${string}`; patch?: { name: string; }|{ colour: { profileId: string; source: { assetSha256: string; profileId: string; interpretation: string; declaredBy: string; declaredAt: string; evidence: { profileId: string; sha256: string; sourceByteLength: number; width: number; height: number; bitDepth: number; alphaMode: string; orientation: number; colourTag: string; }; }; look: { resourceId: `${string}-${string}-${string}-${string}-${string}`; resourceSha256: string; resourceProfile: string; purpose: string; declaredBy: string; enabled: boolean; strength: number; }; }; }; },status='prepared'){
 const text=raw((((input!))));
 db.prepare('INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,errorCode,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),input.projectId,'timeline.clip.update',text,input.requestId,hash(text),'timeline:mutation','new',status,status==='prepared'?1:3,0,status==='not_applied'?'LUT_NOT_FOUND':null,stamp,stamp,16384);
 return text;
}
function rewrite(db: DatabaseSync,table: string,sql: string,...values: string[]){
 db.prepare(sql).run(...values);
}
function changeTimeline(db: DatabaseSync,change: (value:import('./helpers/strict-workspace-boundary-types.ts').MutableTimeline)=>void){const row=db.prepare('SELECT id,data FROM timelines ORDER BY rowid DESC LIMIT 1').get(),value=JSON.parse(((row!.data as string)));change(value);rewrite(db,'timelines','UPDATE timelines SET data=? WHERE id=?',raw(value),(row!.id as string));}
function updateAsset(db: DatabaseSync,asset: { id: unknown; projectId?: `${string}-${string}-${string}-${string}-${string}`; name?: string; mimeType?: unknown; relativePath?: string; sizeBytes?: unknown; sha256?: string; width?: number; height?: number; duration?: number|null; hasVideo?: boolean; hasAudio?: boolean; provenance?: string; createdAt?: string; },change: { mimeType: string; }){const next={...asset,...change};rewrite(db,'assets','UPDATE assets SET data=? WHERE id=?',raw(next),(asset.id as string));return next;}

for(const kind of ['source hash','evidence hash','source profile','clip profile','interpretation','unknown evidence field','wrong MIME','image profile on video','video profile on image','foreign asset','foreign LUT','missing LUT','LUT hash','audio track','duplicate key'] as const)test(`current PNG rejects accepted image binding corruption: ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});
 if(kind==='wrong MIME')updateAsset(db,f.imageAsset,{mimeType:'image/jpeg'});
 else if(kind==='foreign asset'){const other=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(other,raw({id:other}));db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(other,f.imageAsset.id);}
 else if(kind==='foreign LUT'){const other=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(other,raw({id:other}));rewrite(db,'project_lut_resources','UPDATE project_lut_resources SET projectId=? WHERE id=?',other,f.resourceId);}
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
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>validateRows(db),{code:'WORKSPACE_COLOUR_INVALID'});assert.throws(()=>validateRows(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

for(const profile of ['image','video'] as const)for(const mimeType of ['video/mp4','video/webm','image/png'] as const)test(`current PNG retains invalidated ${profile} declaration on ${mimeType}, but cannot freeze it for render`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});
 updateAsset(db,f.imageAsset,{mimeType});const colour={...(profile==='image'?f.imageColour:f.videoColour),source:null};
 changeTimeline(db,(value)=>{value.clips[1].colour=colour;});const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.doesNotThrow(()=>validateRows(db));assert.doesNotThrow(()=>validateAll(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 const timeline=JSON.parse(((db.prepare('SELECT data FROM timelines').get()!.data as string))),assets=f.assets.map(asset=>asset.id===f.imageAsset.id?{...asset,mimeType}:asset);
 assert.deepEqual(timeline.clips[1].colour,colour);assert.throws(()=>projectTimelineColourPlan({timeline,assets}),{code:'INVALID_TIMELINE_COLOUR'});

});

for(const mimeType of ['image/webp','audio/wav','video/quicktime'] as const)test(`invalidated source:null never admits unsupported ${mimeType}`,t=>{
 const db=database(t),f=seed(db,{history:false,render:false});updateAsset(db,f.imageAsset,{mimeType});changeTimeline(db,(value)=>{value.clips[1].colour!.source=null;});assert.throws(()=>validateRows(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

for(const kind of ['missing plan','wrong plan profile','changed evidence','changed algorithm','changed display','extra field'] as const)test(`current PNG frozen snapshot rejects ${kind}`,t=>{
 const db=database(t),f=seed(db,{history:false});const changed=structuredClone(f.rendered),plan=(changed!.snapshot as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureSnapshot).colourPlan;
 if(kind==='missing plan')delete (changed!.snapshot as unknown as Record<PropertyKey,unknown>).colourPlan;
 if(kind==='wrong plan profile')plan!.profileId='mioon-rec709-sdr-render-v1';
 if(kind==='changed evidence')(plan!.clips[1] as unknown as {evidence:{width:number}}).evidence.width++;
 if(kind==='changed algorithm')(plan!.clips[1] as unknown as {algorithmSha256:string}).algorithmSha256='f'.repeat(64);
 if(kind==='changed display')((plan!.clips[1] as unknown as {referenceDisplay:{gamma:number}}).referenceDisplay as unknown as {gamma:number}).gamma=2.2;
 if(kind==='extra field')(plan! as unknown as {future:boolean}).future=true;
 rewrite(db,'exports','UPDATE exports SET data=? WHERE id=?',raw(changed),f.rendered!.id);
 assert.throws(()=>validateRows(db),{code:'WORKSPACE_COLOUR_INVALID'});
});

for(const status of ['prepared','not_applied'] as const)test(`current PNG retains unresolved ${status} image intent without granting source or LUT authority`,t=>{
 const db=database(t),f=seed(db,{render:false});const colour=structuredClone(f.imageColour);
 colour.look.resourceId=randomUUID();colour.look.resourceSha256='f'.repeat(64);colour.source.assetSha256=colour.source.evidence.sha256='e'.repeat(64);
 const input={projectId:f.projectId,requestId:randomUUID(),expectedRevision:1,clipId:f.timeline.clips[1].id,patch:{colour}},text=insertTask(db,input,status),before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.doesNotThrow(()=>validateRows(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 assert.equal(db.prepare('SELECT input FROM edit_tasks').get()!.input,text);
});
