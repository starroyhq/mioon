/** Disposable packaged Linux acceptance. Only local synthetic assets and
 * ordinary shared business calls; no provider/model endpoints or credentials. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir,lstat,open,mkdir} from 'node:fs/promises';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '@mioon/contracts';
import {openStore,createServices} from '@mioon/business';
import {ownQaChild} from './agent-timeline-move-qa-native.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url)),root=path.join(repo,'evidence/workspace-backup'),runtime=path.join(root,'native');
const paths={runtime,userData:path.join(runtime,'user-data'),workspace:path.join(runtime,'user-data/workspace'),backup:path.join(runtime,'backups/verified-synthetic-workspace')};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=(name,value)=>writeFile(path.join(runtime,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function absent(file){try{await lstat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
function environment(){const env=Object.fromEntries(['PATH','HOME','LANG','LC_ALL','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','TMPDIR'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));return {...env,MIOON_DESKTOP_USER_DATA:paths.userData,MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe'};}
async function fixture(){const value=JSON.parse(await readFile(path.join(runtime,'fixture.json'),'utf8'));if(value.synthetic!==true||value.workspace!==paths.workspace)throw Error('Unexpected fixture identity');return value;}
export async function prepareBackupNative(){
 await mkdir(root,{recursive:true});ensurePrivateDirectory(runtime,{create:true});ensurePrivateDirectory(paths.userData,{create:true});ensurePrivateDirectory(path.join(runtime,'backups'),{create:true});
 if(!(await absent(path.join(runtime,'fixture.json'))))return fixture();
 if(!(await absent(path.join(paths.workspace,'server.lock'))))throw Error('Fixture backend must be normally closed');
 const store=openStore(paths.workspace),services=createServices(store,new Map());
 try{
  const other=await services.call('project.create',{name:'另一个合成项目',description:'SYNTHETIC_PRIVATE_OTHER_PROJECT_TEXT'});
  await services.call('shot.create',{projectId:other.id,title:'保留另一项目',prompt:'SYNTHETIC_PRIVATE_PROMPT_RETAINED',requestId:randomUUID()});
  const project=await services.call('project.create',{name:'工作区备份 · 本地合成验收'});
  const accepted=await services.call('image.generate',{projectId:project.id,requestId:randomUUID(),name:'备份中的合成图片',providerId:'mock',model:IMAGE_MODELS.mock,prompt:'Synthetic green blocks for local backup integrity only.',options:IMAGE_FIXED_OPTIONS});
  let task;
  for(const end=Date.now()+10000;Date.now()<end;){task=await services.call('image.task.get',{projectId:project.id,taskId:accepted.id});if(task.state==='succeeded')break;if(['failed','outcome_unknown','local_result_error'].includes(task.state))throw Error('Synthetic image fixture failed');await pause(20);}
  if(task?.state!=='succeeded')throw Error('Synthetic image fixture deadline');
  const asset=store.list('assets',project.id)[0];if(!asset||asset.provenance!=='synthetic-mock')throw Error('Expected owned mock asset');
  let timeline=await services.call('timeline.get',{projectId:project.id});timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,sourceInFrame:0,durationFrames:60,name:'备份原片 · 不改原始素材'});
  const result={...paths,synthetic:true,projectId:project.id,otherProjectId:other.id,taskId:task.id,assetId:asset.id,sourceSha256:asset.sha256,timelineId:timeline.id,clipId:timeline.clips[0].id};await save('fixture.json',result);return result;
 }finally{await services.drain();store.close();}
}
export async function closedSourceAudit(label){
 if(!/^[a-z0-9-]{1,40}$/.test(label))throw Error('Invalid audit label');await fixture();
 if(!(await absent(path.join(paths.workspace,'server.lock'))))throw Error('Audit requires original native backend to be closed');
 const files={};
 for(const relative of ['workbench.sqlite',...await Promise.all(['media','image-staging','frame-staging'].map(async dir=>{if(await absent(path.join(paths.workspace,dir)))return [];const names=await readdir(path.join(paths.workspace,dir));if(names.length>100)throw Error('Synthetic audit bound');return names.sort().map(name=>dir+'/'+name);})).then(values=>values.flat())]){
  const file=path.join(paths.workspace,relative),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>32*1024*1024)throw Error('Unexpected synthetic leaf');files[relative]={bytes:info.size,mode:info.mode&0o777,sha256:hash(await readFile(file))};
 }
 const result={at:new Date().toISOString(),synthetic:true,files};await save(label+'-source.json',result);return result;
}
export async function launchBackupNative(label){
 if(!['first','reopen'].includes(label))throw Error('Bounded native attempt required');await prepareBackupNative();
 if(!(await absent(path.join(paths.workspace,'server.lock'))))throw Error('Refusing duplicate fixture launch');
 const entry=path.join(repo,'release/desktop/production/linux-unpacked/mioon'),asar=path.join(path.dirname(entry),'resources/app.asar');let owned,log;
 try{
  log=await open(path.join(runtime,label+'.log'),'a',0o600);owned=ownQaChild(spawn(entry,[],{cwd:repo,env:environment(),stdio:['ignore',log.fd,log.fd]}));
  await save(label+'-launch.json',{at:new Date().toISOString(),entry,pid:owned.child.pid,asarSha256:hash(await readFile(asar)),argv:[],synthetic:true,platform:'linux-x64',backend:'unmodified packaged'});
  const end=await owned.done;await log.close();log=null;await save(label+'-exit.json',{...end,at:new Date().toISOString()});if(end.code!==0||end.signal||end.error)throw Error('Native fixture did not exit normally');await closedSourceAudit(label+'-exit');
 }catch(error){if(owned&&!owned.closed)await owned.stop();await log?.close();throw error;}
}
export async function runBackupNativeCli(command){
 if(!['create','verify'].includes(command))throw Error('Only explicit backup capture/verify');await fixture();await closedSourceAudit('before-'+command);
 const args=['apps/cli/src/backup.ts',command,...(command==='create'?['--source',paths.workspace,'--destination',paths.backup]:['--directory',paths.backup])],stdout=await open(path.join(runtime,command+'-stdout.json'),'w',0o600),stderr=await open(path.join(runtime,command+'-stderr.log'),'w',0o600);
 const owned=ownQaChild(spawn(process.execPath,args,{cwd:repo,env:environment(),stdio:['ignore',stdout.fd,stderr.fd]}));let timer;
 try{const end=await Promise.race([owned.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native CLI fixture deadline')),30000);})]);if(end.code!==0||end.signal||end.error)throw Error('Backup CLI fixture failed');}
 catch(error){await owned.stop();throw error;}finally{clearTimeout(timer);await stdout.close();await stderr.close();}
 const result=JSON.parse(await readFile(path.join(runtime,command+'-stdout.json'),'utf8'));if(result.ok!==true||result.data.integrity!=='verified'||result.data.warnings)throw Error('Backup CLI result not cleanly verified');
 const before=JSON.parse(await readFile(path.join(runtime,'before-'+command+'-source.json'),'utf8')),after=await closedSourceAudit('after-'+command);if(JSON.stringify(before.files)!==JSON.stringify(after.files))throw Error('Source bytes/modes changed');
 await save(command+'-evidence.json',{synthetic:true,args,result,sourceUnchanged:true});return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,arg]=process.argv.slice(2);
 if(command==='prepare')console.log(JSON.stringify(await prepareBackupNative()));
 else if(command==='audit')console.log(JSON.stringify(await closedSourceAudit(arg)));
 else if(command==='launch')await launchBackupNative(arg);
 else if(command==='create'||command==='verify')console.log(JSON.stringify(await runBackupNativeCli(command)));
 else throw Error('Expected prepare/audit/launch/create/verify');
}
