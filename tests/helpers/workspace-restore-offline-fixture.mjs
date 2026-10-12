import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openStore} from '../../packages/business/src/db.mjs';
import {createWorkspaceBackup} from '../../packages/business/src/workspace-backup.mjs';
import {canonicalImageInput as canonical,IMAGE_FIXED_OPTIONS} from '../../packages/contracts/src/images.mjs';
export const repo=fileURLToPath(new URL('../..',import.meta.url));
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const secret='SYNTHETIC_PRIVATE_TEXT_界_🙂_NOT_REDACTED';
export function tree(root){
 const visit=relative=>{
  const file=path.join(root,relative),info=fs.lstatSync(file);
  if(info.isDirectory())return [[relative,{mode:info.mode}],...fs.readdirSync(file).sort().flatMap(name=>visit(path.join(relative,name)))];
  return [[relative,{mode:info.mode,bytes:hash(fs.readFileSync(file)),size:info.size}]];
 };
 return visit('');
}
export function logical(db){
 const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>row.name);
 return Object.fromEntries(names.map(name=>[name,db.prepare(`SELECT rowid AS oldRowid,* FROM "${name}" ORDER BY rowid`).all()]));
}
export async function restoreFixture(t,{mediaBytes=1024,stages=true}={}){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-offline-restore-')),source=path.join(base,'source'),backup=path.join(base,'backup'),destination=path.join(base,'restored');
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const store=openStore(source),db=store.db,projectId=randomUUID(),assetId=randomUUID(),jobId=randomUUID(),exportId=randomUUID(),exportRequest=randomUUID();
 const write=(relative,bytes)=>{const file=path.join(source,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600});};
 const raw=value=>' \n'+JSON.stringify(value,null,'\t')+'\n ';
 const media=Buffer.alloc(mediaBytes,97),relativePath=`media/${assetId}.mp4`;
 store.put('projects',{id:projectId,name:secret});store.put('assets',{id:assetId,projectId,relativePath,sha256:hash(media),sizeBytes:media.length,mimeType:'video/mp4',name:'synthetic'});write(relativePath,media);
 db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(jobId,projectId,raw({id:jobId,projectId,status:'submission_unknown',requestId:randomUUID(),prompt:secret}));
 db.prepare('INSERT INTO exports VALUES(?,?,?)').run(exportId,projectId,raw({id:exportId,projectId,status:'running',requestId:exportRequest,mode:'storyboard'}));
 db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('export',exportRequest,'a'.repeat(64),exportId);
 db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(jobId,Buffer.from([0,255,13,10]),'at');
 for(let n=1;n<=2;n++)db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),projectId,n,'timeline.undo','at',raw({n:n-1}),raw({n}));
 db.prepare('INSERT INTO timeline_history_cursors VALUES(?,1)').run(projectId);
 const requestId=randomUUID();db.prepare("INSERT INTO edit_tasks(position,id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes) VALUES(17,?,?,'timeline.undo',?,?,?,'timeline:mutation','new','prepared',1,0,'at','at',16384)").run(randomUUID(),projectId,raw({projectId,requestId,expectedRevision:1}),requestId,'b'.repeat(64));
 db.exec("UPDATE sqlite_sequence SET seq=7001 WHERE name='edit_tasks'");
 write(`media/result-${jobId}.mp4.part.mp4`,'uncommitted video bytes');write(`media/export-${exportId}-${randomUUID()}.mp4.part.mp4`,'uncommitted export bytes');
 if(stages){
  const imageId=randomUUID(),groupId=randomUUID(),imageRequest=randomUUID();
  const input={projectId,requestId:imageRequest,name:'Synthetic image',providerId:'mock',model:'mock-image-v1',prompt:secret,options:{...IMAGE_FIXED_OPTIONS}},snapshot={schemaVersion:1,projectId,groupId,taskId:imageId,name:input.name,providerId:input.providerId,model:input.model,prompt:input.prompt,options:input.options};
  db.prepare('INSERT INTO image_groups(id,projectId,name,revision,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(groupId,projectId,'synthetic','at','at');
  db.prepare("INSERT INTO image_tasks(id,projectId,groupId,requestId,inputHash,input,snapshot,state,revision,dispatched,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'queued',1,0,'at','at')").run(imageId,projectId,groupId,imageRequest,hash(canonical(input)),canonical(input),canonical(snapshot));
  write(`image-staging/${imageId}.png`,'partial image bytes');
  const frameId=randomUUID(),frameRequest=randomUUID(),frameInput={projectId,requestId:frameRequest,sourceAssetId:assetId,sourceHash:hash(media),sourceFrame:0};
  const frameSnapshot={schemaVersion:1,projectId,taskId:frameId,source:{assetId,sha256:hash(media),mimeType:'video/mp4',sizeBytes:media.length,relativePath,duration:1,width:4,height:2},requested:{sourceFrame:0,fps:30},profile:{id:'local-png-1024-v1',maxEdge:1024,mimeType:'image/png',upscale:false,selectionRule:'first-pts-at-or-after-v1'}};
  const response={id:frameId,projectId,requestId:frameRequest,sourceAssetId:assetId,sourceHash:hash(media),sourceFrame:0,fps:30,profileId:frameSnapshot.profile.id,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:'at',updatedAt:'at'};
  db.exec('BEGIN');
  try{
   db.prepare("INSERT INTO frame_tasks(id,projectId,requestId,inputHash,input,snapshot,state,revision,started,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'queued',1,0,'at','at')").run(frameId,projectId,frameRequest,hash(canonical(frameInput)),canonical(frameInput),canonical(frameSnapshot));
   db.prepare("INSERT INTO frame_requests VALUES(?,'frame.extract',?,?,?,?,?)").run(frameRequest,projectId,frameId,hash(canonical(frameInput)),canonical(frameInput),canonical(response));
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');store.close();throw error;}
  write(`frame-staging/${frameId}.png`,'partial frame bytes');
 }
 const before=logical(db);store.close();
 write('access-token','EXCLUDED_SYNTHETIC_CREDENTIAL');write('image-settings/settings.json','EXCLUDED_SYNTHETIC_CREDENTIAL');
 const created=await createWorkspaceBackup({source,destination:backup});
 return {base,source,backup,destination,before,created,projectId,assetId,relativePath};
}
export function rewriteManifest(backup,mutate){
 const file=path.join(backup,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));mutate(manifest);
 const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(file,bytes);
 const completeFile=path.join(backup,'COMPLETE.json'),complete=JSON.parse(fs.readFileSync(completeFile,'utf8'));
 Object.assign(complete,{manifestSha256:hash(bytes),fileCount:manifest.entries.length,payloadBytes:manifest.entries.reduce((n,e)=>n+e.bytes,0)});fs.writeFileSync(completeFile,JSON.stringify(complete));
}
export function refreshDatabaseManifest(backup){rewriteManifest(backup,manifest=>{const entry=manifest.entries.find(e=>e.role==='database'),bytes=fs.readFileSync(path.join(backup,entry.path));entry.bytes=bytes.length;entry.sha256=hash(bytes);});}
export async function runRestoreChild(t,args,{preload,timeout=20000}={}){
 const child=spawn(process.execPath,[...(preload?['--import',preload]:[]),path.join(repo,'apps/cli/src/backup.mjs'),...args],{cwd:repo,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',failure,closed=false;
 // These are the only new child text collectors. Binary files stay bytes.
 child.stdout.setEncoding('utf8').on('data',text=>{stdout+=text;if(stdout.length>256*1024){failure=Error('bounded stdout exceeded');child.kill('SIGKILL');}});
 child.stderr.setEncoding('utf8').on('data',text=>{stderr+=text;if(stderr.length>256*1024){failure=Error('bounded stderr exceeded');child.kill('SIGKILL');}});
 const complete=new Promise(resolve=>{const timer=setTimeout(()=>{failure=Error('owned child deadline');child.kill('SIGKILL');},timeout);child.once('error',error=>{failure=error;});child.once('close',(code,signal)=>{clearTimeout(timer);closed=true;resolve({code,signal,stdout,stderr});});});
 t.after(async()=>{if(!closed){child.kill('SIGKILL');await complete;}});
 const result=await complete;if(failure)throw failure;return result;
}
