/** Disposable packaged-native acceptance. Only synthetic source media, ordinary
 * shared services/settings, a loopback model, and read-only evidence audits.
 * UI actions are performed separately through supported native computer use. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,readdir,lstat,open,mkdir} from 'node:fs/promises';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createAgentSettings} from '../packages/business/src/agent/settings.mjs';
import {createAgentSettingsFile} from '../packages/business/src/agent/settings-file.mjs';
import {seedEditQaSettings,startEditQaModel,startEditQaMailbox,jsonFile,assertNativeFixtureClosed} from './helpers/agent-edits-qa-support.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const root=path.join(repo,'evidence/agent-timeline-move'),runtime=path.join(root,'native');
const paths={root,runtime,userData:path.join(runtime,'user-data'),workspace:path.join(runtime,'user-data/workspace'),
  mailbox:path.join(runtime,'mailbox'),mock:path.join(runtime,'mock'),mode:'native',synthetic:true};
const hash=value=>createHash('sha256').update(value).digest('hex');
async function readJson(file){return JSON.parse(await readFile(file,'utf8'));}
export function ownQaChild(child){
 let closed=false,observedError;
 const done=new Promise(resolve=>{
  child.on('error',error=>{observedError={code:error.code||null,message:error.message};});
  child.once('close',(code,signal)=>{closed=true;resolve({code,signal,...(observedError?{error:observedError}:{})});});
 });
 return {child,done,get closed(){return closed;},async stop(){
  if(closed)return done;
  child.kill('SIGTERM');let killTimer,deadline;
  try{return await Promise.race([done,new Promise((_,reject)=>{
   killTimer=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},3000);
   deadline=setTimeout(()=>reject(Error('Owned fixture child cleanup is unconfirmed')),10000);
  })]);}finally{clearTimeout(killTimer);clearTimeout(deadline);}
 }};
}
function cleanEnvironment(){
 const env=Object.fromEntries(['PATH','HOME','LANG','LC_ALL','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','TMPDIR'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
 return {...env,MIOON_DESKTOP_USER_DATA:paths.userData,MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe'};
}
async function ensureModelSettings(baseUrl,protocol,{reopen=false}={}){
 const expected={presetId:'ollama',platformId:'local',baseUrl,model:'qwen3:8b',protocol};
 const settings=await createAgentSettings({persistence:createAgentSettingsFile({directory:path.join(paths.userData,'agent-settings')})});
 let same;try{
  const current=await settings.get();if(current.secret.configured)throw Error('Refusing a fixture with a credential');
  same=Object.entries(expected).every(([key,value])=>current.configuration[key]===value);
 }finally{await settings.close();}
 if(same)return;
 if(reopen)throw Error('Native reopen must retain the exact saved model settings');
 await seedEditQaSettings(paths.userData,baseUrl,protocol);
}
async function ownedCommand(executable,args,log){
 const fd=await open(log,'a',0o600),owned=ownQaChild(spawn(executable,args,{cwd:repo,env:cleanEnvironment(),stdio:['ignore',fd.fd,fd.fd]}));
 let timer;try{
  const result=await Promise.race([owned.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Synthetic media preparation timed out')),30000);})]);
  if(result.code!==0||result.signal||result.error)throw Error(`Synthetic media preparation failed ${result.code}/${result.signal}`);
 }catch(error){await owned.stop();throw error;}finally{clearTimeout(timer);await fd.close();}
}
export async function prepareTimelineMoveNative(){
 await mkdir(root,{recursive:true});ensurePrivateDirectory(runtime,{create:true});await assertNativeFixtureClosed(paths);
 const manifest=path.join(runtime,'fixture.json');
 try{const prior=await readJson(manifest);if(prior.synthetic!==true||prior.workspace!==paths.workspace)throw Error('Unexpected existing fixture');return prior;}catch(error){if(error.code!=='ENOENT')throw error;}
 ensurePrivateDirectory(paths.userData,{create:true});
 const source=path.join(runtime,'synthetic-green-880hz.mp4');
 await ownedCommand('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x18bf57:s=320x180:r=30:d=3','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=3','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-t','3','-movflags','+faststart','-n',source],path.join(runtime,'prepare-media.log'));
 const bytes=await readFile(source),store=openStore(paths.workspace);
 try{
  const services=createServices(store,new Map()),project=await services.call('project.create',{name:'Agent 片段移动 · 合成验收'});
  const asset=await services.call('asset.import',{projectId:project.id,name:'绿色与 880Hz 合成原片.mp4',mimeType:'video/mp4',dataBase64:bytes.toString('base64')});
  let timeline=await services.call('timeline.get',{projectId:project.id});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:30,sourceInFrame:15,durationFrames:60,name:'可审阅移动 · 2 秒原片'});
  const fixture={...paths,projectId:project.id,timelineId:timeline.id,clipId:timeline.clips[0].id,assetId:asset.id,sourceSha256:hash(bytes),initialTimeline:timeline};
  await jsonFile(manifest,fixture);return fixture;
 }finally{store.close();}
}
export async function auditTimelineMoveNative(label){
 if(!/^[a-z0-9-]{1,48}$/u.test(label))throw Error('Invalid bounded audit label');
 const fixture=await readJson(path.join(runtime,'fixture.json'));
 if(fixture.synthetic!==true||fixture.workspace!==paths.workspace)throw Error('Not the owned fixture');
 const db=new DatabaseSync(path.join(paths.workspace,'workbench.sqlite'),{readOnly:true});
 const rows={};try{
  db.exec('BEGIN');
  const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 129").all();
  if(names.length>128)throw Error('Audit table limit');
  for(const {name}of names){if(!/^[a-z_]+$/u.test(name))throw Error('Unexpected fixture table');rows[name]=db.prepare(`SELECT * FROM "${name}" ORDER BY rowid LIMIT 1001`).all();if(rows[name].length>1000)throw Error('Audit row limit');}
  db.exec('COMMIT');
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
 const media={};for(const name of (await readdir(path.join(paths.workspace,'media'))).sort()){
  if(!/^[a-f0-9-]+\.(mp4|png|wav)$/u.test(name))continue;
  const file=path.join(paths.workspace,'media',name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>30*1024*1024)throw Error('Unexpected synthetic media');
  media[name]={bytes:info.size,sha256:hash(await readFile(file))};
 }
 const result={at:new Date().toISOString(),synthetic:true,tables:Object.fromEntries(Object.entries(rows).map(([name,value])=>[name,{count:value.length,sha256:hash(JSON.stringify(value))}])),
  timelines:rows.timelines.map(row=>JSON.parse(row.data)),proposals:rows.agent_edit_proposals,runs:rows.agent_chat_runs,requests:rows.timeline_requests,exports:rows.exports.map(row=>JSON.parse(row.data)),media};
 await jsonFile(path.join(runtime,`${label}-audit.json`),result);return result;
}
export async function launchTimelineMoveNative(label,protocol){
 if(!['first','reopen','responses'].includes(label)||!['chat_completions','responses'].includes(protocol))throw Error('Explicit native attempt/protocol required');
 const fixture=await prepareTimelineMoveNative();
 const entry=path.join(repo,'release/desktop/production/linux-unpacked/mioon'),asar=path.join(path.dirname(entry),'resources/app.asar');
 let mailbox,owned,model,log;
 try{
  log=await open(path.join(runtime,`${label}.log`),'a',0o600);
  model=await startEditQaModel(paths,{label});
  await ensureModelSettings(model.baseUrl,protocol,{reopen:label==='reopen'});
  mailbox=await startEditQaMailbox(fixture,model);
  const asarSha256=hash(await readFile(asar));
  owned=ownQaChild(spawn(entry,[],{cwd:repo,env:cleanEnvironment(),stdio:['ignore',log.fd,log.fd]}));
  const launch={pid:owned.child.pid,at:new Date().toISOString(),entry,asarSha256,backend:'unmodified packaged',protocol,synthetic:true,platform:'linux-x64',argv:[]};
  await jsonFile(path.join(runtime,`${label}-launch.json`),launch);await jsonFile(path.join(runtime,'launch.json'),launch);
  const ended=await owned.done;
  await mailbox.close();await model.close();await log.close();
  await jsonFile(path.join(runtime,`${label}-exit.json`),{...ended,at:new Date().toISOString()});
  await auditTimelineMoveNative(`${label}-exit`);process.exitCode=ended.code||((ended.signal||ended.error)?1:0);
 }catch(error){
  // Only the exact spawned child handle can be signalled; no PID-based cleanup.
  let cleanupError;try{if(owned&&!owned.closed)await owned.stop();}catch(failure){cleanupError=failure;}
  const cleanup=await Promise.allSettled([mailbox?.close(),model?.close(),log?.close()]);
  const rejected=cleanup.find(value=>value.status==='rejected');
  throw cleanupError||rejected?.reason||error;
 }
}
export async function controlTimelineMoveNative(item){
 if(!['model.plan','model.snapshot','model.release'].includes(item?.action))throw Error('Only synthetic model control allowed');
 const id=randomUUID(),request=path.join(paths.mailbox,`${id}.request.json`),result=path.join(paths.mailbox,`${id}.result.json`);
 await jsonFile(request,{...item,expiresAt:Date.now()+15000});
 for(const deadline=Date.now()+15000;Date.now()<deadline;){try{const value=await readJson(result);if(value.probeError)throw Error(value.probeError);return value;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,50));}
 throw Error('Synthetic model control timed out');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,arg,protocol]=process.argv.slice(2);
 if(command==='prepare')console.log(JSON.stringify(await prepareTimelineMoveNative()));
 else if(command==='audit')console.log(JSON.stringify(await auditTimelineMoveNative(arg)));
 else if(command==='launch')await launchTimelineMoveNative(arg,protocol);
 else if(command==='plan'){const startFrame=Number(arg);if(!Number.isSafeInteger(startFrame)||startFrame<0||startFrame>18000)throw Error('Invalid frame');console.log(JSON.stringify(await controlTimelineMoveNative({action:'model.plan',plan:{name:'mioon_propose_timeline_clip_move',arguments:{startFrame}}})));}
 else if(command==='model')console.log(JSON.stringify(await controlTimelineMoveNative({action:'model.snapshot'})));
 else throw Error('Expected prepare/audit/launch/plan/model');
}
