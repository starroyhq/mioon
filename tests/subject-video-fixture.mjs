import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createArkProvider} from '../packages/business/src/providers/ark.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_SELECTION_RULE,canonicalFrameInput} from '../packages/contracts/src/frame-extraction.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS,canonicalImageInput} from '../packages/contracts/src/images.ts';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export function png(width=480,height=480,fill=0){
 const chunk=(name,data)=>{const body=Buffer.concat([Buffer.from(name),data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(body));return Buffer.concat([head,body,tail]);};
 const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height,fill))),chunk('IEND',Buffer.alloc(0))]);
}
export const insert=(db,table,value)=>{const keys=Object.keys(value);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value));};
export const rowBytes=(f,table,id)=>f.store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)?.data;
export async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-subject-video-')),store=openStore(root),env={MIOON_ENABLE_LIVE_PROVIDER:'1',ARK_API_KEY:'inert-offline'};
 const providers=createProviderRegistry({db:store.db,root,env});let asOf=Date.parse('2026-10-11T12:00:00Z'),worker,posts=0;
 const services=createServices(store,providers,{env,profileNow:()=>asOf}),call=(op,input)=>services.call(op,input);
 const project=await call('project.create',{name:'Subject video offline'}),other=await call('project.create',{name:'Other private project'});
 async function asset(patch={}){const width=patch.width??480,height=patch.height??480,bytes=png(width,height,store.list('assets').length),id=randomUUID(),record={id,projectId:project.id,name:'Synthetic subject image',mimeType:'image/png',relativePath:`media/${id}.png`,sha256:sha(bytes),sizeBytes:bytes.length,width,height,provenance:'user-import',createdAt:'2026-10-11T00:00:00.000Z',...patch};store.put('assets',record);await writeFile(path.join(root,record.relativePath),bytes);return record;}
 function ark({hook,reply}={}){env.ARK_APPROVED_ASSET_SHA256=store.list('assets').map(a=>a.sha256).join(',');const provider=createArkProvider({root,env,fetchImpl:async(url,options)=>{posts++;return reply?reply(url,options):new Response(JSON.stringify({id:'offline-subject-video'}));}});providers.set('ark',hook?{...provider,submit:(snapshot,context)=>hook(provider,snapshot,context)}:provider);return provider;}
 const subject=(a,kind='product')=>call('subject.create',{projectId:a.projectId,assetId:a.id,kind,name:'Synthetic subject',requestId:randomUUID()});
 const shot=(patch={})=>call('shot.create',{projectId:project.id,title:'Subject shot',prompt:'  A synthetic object turns.  ',duration:4,...patch});
 const input=(s,subjectVersionId,patch={})=>({shotId:s.id,expectedRevision:s.revision,providerId:'mock',requestId:randomUUID(),...(subjectVersionId?{subjectVersionId}:{}),...patch});
 const f={root,store,env,providers,services,call,project,other,asset,subject,shot,input,ark,posts:()=>posts,setDate:value=>{asOf=Date.parse(value);},submit:(s,v,patch)=>call('generation.submit',input(s,v,patch)),async tick(){worker??=startWorker(store,services,providers);await worker.tick();},stop:async()=>{await worker?.stop();worker=null;}};
 t.after(async()=>{await worker?.stop();await services.drain();store.close();await rm(root,{recursive:true,force:true});});return f;
}
export async function typedFrame(f){
 const db=f.store.db,projectId=f.project.id,source=await f.asset({mimeType:'video/mp4',duration:3,hasVideo:true,hasAudio:false}),taskId=randomUUID(),requestId=randomUUID(),assetId=randomUUID(),at='2026-10-11T00:00:00.000Z';
 const input={projectId,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:56,requestId},inputHash=sha(canonicalFrameInput(input));
 const snapshot={schemaVersion:1,projectId,taskId,source:{assetId:source.id,sha256:source.sha256,mimeType:source.mimeType,sizeBytes:source.sizeBytes,relativePath:source.relativePath,duration:source.duration,width:source.width,height:source.height},requested:{sourceFrame:56,fps:30},profile:FRAME_PROFILE};
 const bytes=png(),asset={id:assetId,projectId,name:'Extracted synthetic subject',mimeType:'image/png',width:480,height:480,sizeBytes:bytes.length,sha256:sha(bytes),relativePath:`media/${assetId}.png`,provenance:'extracted-frame',createdAt:at};
 const receipt={schemaVersion:1,projectId,taskId,inputHash,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,assetId,sha256:asset.sha256,mimeType:asset.mimeType,width:480,height:480,byteLength:asset.sizeBytes,probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:480,height:480,rotation:0,sarNumerator:1,sarDenominator:1}};
 const ack={id:taskId,projectId,requestId,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:at,updatedAt:at};
 f.store.tx(()=>{insert(db,'frame_tasks',{id:taskId,projectId,requestId,inputHash,input:canonicalFrameInput(input),snapshot:canonicalFrameInput(snapshot),state:'queued',revision:1,started:0,stagedReceipt:null,assetId:null,errorCode:null,createdAt:at,updatedAt:at});insert(db,'frame_requests',{requestId,operation:'frame.extract',projectId,taskId,inputHash,canonicalInput:canonicalFrameInput(input),response:canonicalFrameInput(ack)});});
 db.prepare("UPDATE frame_tasks SET state='running',started=1,revision=2 WHERE id=?").run(taskId);db.prepare("UPDATE frame_tasks SET state='persisting',revision=3,stagedReceipt=? WHERE id=?").run(canonicalFrameInput(receipt),taskId);
 f.store.tx(()=>{f.store.put('assets',asset);db.prepare("UPDATE frame_tasks SET state='succeeded',revision=4,assetId=? WHERE id=?").run(assetId,taskId);});await writeFile(path.join(f.root,asset.relativePath),bytes);return {asset,source,taskId};
}
export async function typedImage(f){
 const db=f.store.db,projectId=f.project.id,groupId=randomUUID(),taskId=randomUUID(),versionId=randomUUID(),assetId=randomUUID(),requestId=randomUUID(),at='2026-10-11T00:00:00.000Z',bytes=png(1024,1024);
 const input={projectId,name:'Image source',prompt:'Synthetic image',providerId:'mock',model:IMAGE_MODELS.mock,options:IMAGE_FIXED_OPTIONS,requestId},inputHash=sha(canonicalImageInput(input));
 const snapshot={schemaVersion:1,projectId,groupId,taskId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options};
 const receipt={schemaVersion:1,taskId,projectId,groupId,inputHash,assetId,versionId,sha256:sha(bytes),mimeType:'image/png',width:1024,height:1024,byteLength:bytes.length,isMock:true};
 const ack={id:taskId,projectId,groupId,requestId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:at,updatedAt:at};
 const asset={id:assetId,projectId,name:'Synthetic typed image',mimeType:'image/png',width:1024,height:1024,sizeBytes:bytes.length,sha256:sha(bytes),relativePath:`media/${assetId}.png`,provenance:'synthetic-mock',createdAt:at};
 const version={id:versionId,projectId,groupId,taskId,number:1,assetId,sha256:asset.sha256,mimeType:asset.mimeType,width:1024,height:1024,byteLength:bytes.length,isMock:true,providerId:input.providerId,model:input.model,options:input.options,createdAt:at};
 f.store.tx(()=>{insert(db,'image_groups',{id:groupId,projectId,name:input.name,revision:1,headVersionId:null,activeTaskId:taskId,createdAt:at,updatedAt:at});insert(db,'image_tasks',{id:taskId,projectId,groupId,requestId,inputHash,input:canonicalImageInput(input),snapshot:canonicalImageInput(snapshot),state:'queued',revision:1,dispatched:0,stagedReceipt:null,versionId:null,errorCode:null,createdAt:at,updatedAt:at});insert(db,'image_requests',{requestId,operation:'image.generate',projectId,inputHash,canonicalInput:canonicalImageInput(input),response:JSON.stringify(ack)});});
 f.store.tx(()=>{db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(taskId);db.prepare("UPDATE image_tasks SET state='persisting',stagedReceipt=?,revision=3 WHERE id=?").run(JSON.stringify(receipt),taskId);f.store.put('assets',asset);insert(db,'image_versions',{id:versionId,projectId,groupId,taskId,number:1,assetId,data:JSON.stringify(version)});db.prepare("UPDATE image_tasks SET state='succeeded',versionId=?,revision=4 WHERE id=?").run(versionId,taskId);db.prepare('UPDATE image_groups SET revision=2,headVersionId=?,activeTaskId=NULL WHERE id=?').run(versionId,groupId);});await writeFile(path.join(f.root,asset.relativePath),bytes);return {asset,groupId,taskId,versionId};
}
