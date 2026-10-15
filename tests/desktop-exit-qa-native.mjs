/** Disposable macOS native acceptance controller. No product seam, inspector,
 * renderer injection, sandbox override, real provider, or personal data is used.
 * Native UI actions/screenshots belong to the operator. Only an independently
 * verified direct utility child of the still-owned Electron handle is signalled.
 *
 * node tests/desktop-exit-qa-native.mjs prepare
 * node tests/desktop-exit-qa-native.mjs launch --root <root> --label first
 * node tests/desktop-exit-qa-native.mjs audit --root <root> --label before-crash
 * node tests/desktop-exit-qa-native.mjs crash --root <root> [--signal SIGKILL]
 * [operator explicitly restarts service, then normally quits Electron]
 * node tests/desktop-exit-qa-native.mjs finalize --root <root>
 */
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,lstat,readdir,realpath,open,rename,link,unlink} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore,ownsStoreLock} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createProviderRegistry} from '../packages/business/src/provider-registry.mjs';
import {createLocalDrafts} from '../packages/business/src/local-drafts.ts';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.mjs';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.mjs';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.js';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '../packages/contracts/src/private-storage.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const ffmpeg='/opt/homebrew/bin/ffmpeg',ffprobe='/opt/homebrew/bin/ffprobe';
const executeFile=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=value=>createHash('sha256').update(value).digest('hex'),json=value=>JSON.stringify(value,null,2)+'\n';
const [action,...args]=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){assert.ok(['--root','--label','--signal'].includes(args[i]));assert.ok(args[i+1]);options[args[i].slice(2)]=args[i+1];}
const fixedTables=['projects','assets','shots','nodes','edges','versions','exports','timelines','timeline_requests','reference_requests',
  'timeline_history','timeline_history_cursors','idempotency','mutation_requests','asset_ranges','asset_range_requests',
  'asset_dispositions','asset_disposition_requests','subjects','subject_versions','subject_bindings','subject_requests','edit_tasks'];
const label=value=>{assert.match(value,/^[a-z0-9-]{1,50}$/);return value;};
async function exists(file){try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function privateDirectory(directory){await mkdir(directory,{mode:0o700});}
async function readJson(file){const info=await lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<4*1024*1024);return JSON.parse(await readFile(file,'utf8'));}
async function writeNew(file,value){
  const temporary=file+'.partial-'+randomUUID();await writeFile(temporary,json(value),{mode:0o600,flag:'wx'});
  try{await link(temporary,file);}finally{await unlink(temporary);}
}
function environment(userData){return {...Object.fromEntries(['PATH','HOME','LANG','LC_ALL','TMPDIR','USER','LOGNAME','SHELL']
  .filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]])),
  MIOON_DESKTOP_USER_DATA:userData,MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_FFMPEG_PATH:ffmpeg,MIOON_FFPROBE_PATH:ffprobe};}
async function context(){
  assert.equal(process.platform,'darwin','The native controller is macOS-only');
  assert.ok(options.root,'--root is required');const root=path.resolve(options.root);
  assert.match(root,/^\/private\/tmp\/mioon-exit-native-[0-9a-f-]{36}$/);assert.equal(await realpath(root),root);
  const info=await lstat(root);assert.ok(info.isDirectory()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o700&&info.uid===process.getuid());
  const runtime=path.join(root,'private-runtime'),report=path.join(root,'report'),userData=path.join(runtime,'user-data'),workspace=path.join(userData,'workspace');
  const fixture=await readJson(path.join(runtime,'fixture.json'));assert.equal(fixture.synthetic,true);assert.equal(fixture.root,root);
  return {root,runtime,report,userData,workspace,fixture};
}
async function mediaHashes(workspace){return Promise.all((await readdir(path.join(workspace,'media'))).sort().map(async name=>{
  assert.match(name,/^[a-zA-Z0-9._-]+$/);const file=path.join(workspace,'media',name),info=await lstat(file);
  assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<4*1024*1024);return {name,bytes:info.size,sha256:sha(await readFile(file))};
}));}
function databaseSnapshot(workspace){
  const db=new DatabaseSync(path.join(workspace,'workbench.sqlite'),{readOnly:true});
  try{db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    const tables=Object.fromEntries(fixedTables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const jobs=db.prepare('SELECT data FROM jobs ORDER BY rowid').all().map(row=>JSON.parse(row.data));
    const submissions=db.prepare('SELECT request_id,job_id,provider_job_id,outcome FROM mock_provider_submissions ORDER BY id').all();
    const providerTasks=db.prepare('SELECT count(*) AS n FROM mock_provider_tasks').get().n;
    // SQLite rows use null prototypes; persisted baseline JSON uses ordinary
    // objects. Normalize both representations without changing any field.
    db.exec('COMMIT');return JSON.parse(JSON.stringify({tables,jobs,submissions,providerTasks}));
  }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
async function prepare(){
  assert.equal(process.platform,'darwin');assert.equal(options.root,undefined,'Preparation always creates a fresh private root');
  const root=path.join('/private/tmp','mioon-exit-native-'+randomUUID());await privateDirectory(root);
  const runtime=path.join(root,'private-runtime'),report=path.join(root,'report'),userData=path.join(runtime,'user-data'),workspace=path.join(userData,'workspace');
  for(const directory of [runtime,report,userData])await privateDirectory(directory);
  const source=path.join(runtime,'synthetic-green-880hz.mp4'),image=path.join(runtime,'synthetic-purple.png');
  await executeFile(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x18bf57:s=320x180:r=30:d=2',
    '-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-shortest','-n',source],{env:environment(userData),timeout:30000,maxBuffer:65536});
  await executeFile(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x8138a8:s=320x180','-frames:v','1','-threads','1','-n',image],{env:environment(userData),timeout:30000,maxBuffer:65536});
  process.env.MIOON_FFMPEG_PATH=ffmpeg;process.env.MIOON_FFPROBE_PATH=ffprobe;
  const store=openStore(workspace),env={MIOON_ENABLE_LIVE_PROVIDER:'0'},providers=createProviderRegistry({db:store.db,root:workspace,env}),services=createServices(store,providers,{env});let fixture;
  try{
    const project=await services.call('project.create',{name:'退出诊断 · 原生合成验收'});
    const asset=await services.call('asset.import',{projectId:project.id,name:'合成绿色画面与 880Hz.mp4',mimeType:'video/mp4',dataBase64:(await readFile(source)).toString('base64')});
    const imageAsset=await services.call('asset.import',{projectId:project.id,name:'合成紫色色块.png',mimeType:'image/png',dataBase64:(await readFile(image)).toString('base64')});
    const shot=await services.call('shot.create',{projectId:project.id,requestId:randomUUID(),title:'未知提交结果 · 不可重发',prompt:'Synthetic native exit QA',aspectRatio:'9:16',duration:2});
    await services.call('node.create',{projectId:project.id,requestId:randomUUID(),type:'image',assetId:imageAsset.id,label:'已保存合成图片',position:{x:80,y:80}});
    const currentProject=(await services.call('project.get',{projectId:project.id})).project;
    const currentTimeline=await services.call('timeline.get',{projectId:project.id});
    let timeline=await services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:currentProject.revision,expectedRevision:currentTimeline.revision,requestId:randomUUID(),presetId:'landscape_720'});
    timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,
      trackId:timeline.tracks.find(track=>track.kind==='video').id,startFrame:0,durationFrames:60,name:'已保存的合成时间线片段'});
    const subjectRequestId=randomUUID(),subject=await services.call('subject.create',{projectId:project.id,kind:'product',name:'已保存合成主体',assetId:imageAsset.id,requestId:subjectRequestId});
    const requestId=randomUUID(),job=await services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId,parameters:{scenario:'unknown'}});
    const clip=timeline.clips[0],drafts=createLocalDrafts({root:workspace,channel:'production',storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
      guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>false,readTimeline:id=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read(),readClipAsset:(id,value)=>createTimelineRecoveryBoundary(store.db,{projectId:id}).clipSource(value)}});
    const key={projectId:project.id,timelineId:timeline.id,clipId:clip.id},current=drafts.get(key);
    drafts.put({...key,workspaceScope:current.workspaceScope,instanceId:current.instanceId,expectedRevision:current.revision,baseRevision:timeline.revision,
      source:{assetId:asset.id,assetSha256:asset.sha256},raw:{name:'尚未应用的合成草稿',trackId:clip.trackId,startFrame:clip.startFrame,durationFrames:clip.durationFrames,sourceInFrame:clip.sourceInFrame,rect:clip.rect,gain:clip.gain}});
    const state=defaultWorkspaceState();state.activeMode='editing';state.editing.selectedClipId=clip.id;state.editing.previewKind='source';delete state.shared.assetSearch;
    createWorkspacePreferences(store).put(project.id,{expectedRevision:0,state});
    fixture={synthetic:true,root,projectId:project.id,projectName:project.name,assetId:asset.id,imageAssetId:imageAsset.id,shotId:shot.id,
      timelineId:timeline.id,clipId:clip.id,subjectId:subject.id,subjectRequestId,jobId:job.id,requestId};
  }finally{await services.drain();store.close();}
  await writeNew(path.join(runtime,'fixture.json'),fixture);
  await writeNew(path.join(runtime,'baseline.json'),{...databaseSnapshot(workspace),media:await mediaHashes(workspace),draftSha256:sha(await readFile(path.join(workspace,'local-drafts-v1.json')))});
  await writeNew(path.join(report,'fixture-summary.json'),{synthetic:true,platform:process.platform,arch:process.arch,appVersion:'0.4.1',channel:'production',
    assets:2,shots:1,timelineClips:1,existingSubjects:1,existingSubjectReceipts:1,localDrafts:1,generationScenario:'mock:unknown',realProvidersEnabled:false});
  return {root,report,projectName:fixture.projectName,projectId:fixture.projectId,clipId:fixture.clipId,jobId:fixture.jobId};
}
async function connection(c){
  const value=await readJson(path.join(c.userData,'mcp-connection.json')),origin=new URL(value.url);
  assert.equal(value.channel,'production');assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');
  assert.equal(origin.search,'');assert.equal(origin.hash,'');assert.ok(Number.isSafeInteger(value.pid)&&value.pid>1);
  return {origin:origin.origin,backendPid:value.pid};
}
async function processInfo(pid){
  assert.ok(Number.isSafeInteger(pid)&&pid>1);
  try{const {stdout}=await executeFile('/bin/ps',['-p',String(pid),'-o','pid=,ppid=,comm=,args='],{timeout:2000,maxBuffer:32768});
    const match=/^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(stdout.trim());if(!match)return null;
    return {pid:Number(match[1]),ppid:Number(match[2]),command:match[3]};
  }catch(error){if(error.code===1)return null;throw error;}
}
async function launch(){
  const c=await context(),name=label(options.label||'first'),electron=require('electron');
  const metadata=await readJson(path.join(repo,'apps/desktop/build/package.json'));assert.equal(metadata.mioonDesktop.channel,'production');
  assert.equal(await exists(path.join(c.runtime,'launch-'+name+'.json')),false,'Use a distinct launch label');
  const stdout=await open(path.join(c.runtime,name+'.stdout'),'wx',0o600),stderr=await open(path.join(c.runtime,name+'.stderr'),'wx',0o600);
  const child=spawn(electron,[path.join(repo,'apps/desktop/build')],{cwd:repo,env:environment(c.userData),stdio:['ignore',stdout.fd,stderr.fd]});
  let closed=false,exitResult,ready=false;const exited=Promise.withResolvers();
  child.once('error',error=>exited.reject(error));child.once('close',(code,signal)=>{closed=true;exitResult={code,signal};exited.resolve(exitResult);});
  await writeNew(path.join(c.runtime,'launch-'+name+'.json'),{synthetic:true,label:name,mainPid:child.pid,electron,build:path.join(repo,'apps/desktop/build'),controllerPid:process.pid});
  const deadline=Date.now()+120000;
  while(!closed&&Date.now()<deadline){
    try{const active=await connection(c),backend=await processInfo(active.backendPid);
      const response=await fetch(active.origin+'/health',{signal:AbortSignal.timeout(1500),redirect:'error'});await response.body?.cancel();
      if(response.status===200&&backend?.ppid===child.pid){ready=true;break;}
    }catch{}await pause(200);
  }
  if(!ready){if(!closed)child.kill('SIGTERM');throw Error('Owned native Electron did not become ready in 120 seconds; inspect private runtime output');}
  console.log(json({ready:true,root:c.root,label:name,mainPid:child.pid,report:c.report}));
  try{
    while(!closed){
      const requestFile=path.join(c.runtime,'crash-request.json');
      if(await exists(requestFile)){
        const request=await readJson(requestFile);assert.ok(['SIGKILL','SIGTERM','SIGINT'].includes(request.signal));assert.equal(request.fixtureId,c.fixture.requestId);
        assert.equal(request.mainPid,child.pid);assert.equal(request.launchLabel,name);
        const active=await connection(c),main=await processInfo(child.pid),backend=await processInfo(active.backendPid);
        assert.ok(!closed&&child.exitCode===null&&child.signalCode===null&&main?.pid===child.pid);
        assert.ok(main.command.includes(electron)&&main.command.includes(path.join(repo,'apps/desktop/build')));
        assert.equal(backend?.ppid,child.pid);assert.equal(backend.pid,active.backendPid);
        assert.ok(backend.command.includes('Electron Helper')&&backend.command.includes('--type=utility')&&backend.command.includes('node.mojom.NodeService'));
        const children=await executeFile('/bin/ps',['-axo','pid=,ppid=,comm=,args='],{timeout:2000,maxBuffer:1024*1024});
        const mediaChildren=children.stdout.split('\n').filter(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);return m&&Number(m[2])===backend.pid&&/ffmpeg|ffprobe/u.test(m[3]);});
        assert.equal(mediaChildren.length,0,'Refusing utility fault injection while an owned media child is active');
        await rename(requestFile,path.join(c.runtime,'crash-request-'+request.id+'.handled.json'));
        process.kill(backend.pid,request.signal);
        await writeNew(path.join(c.report,'fault-'+request.id+'.json'),{synthetic:true,signalRequested:request.signal,signalSent:true,ownershipVerified:true,noActiveMediaChildren:true,at:new Date().toISOString()});
      }
      await Promise.race([pause(150),exited.promise]);
    }
  }finally{await stdout.close();await stderr.close();}
  const final={synthetic:true,label:name,result:exitResult,backendLockReleased:!await exists(path.join(c.workspace,'server.lock'))};
  await writeNew(path.join(c.report,name+'-exit.json'),final);return final;
}
async function diagnostics(c){
  const directory=path.join(c.workspace,'diagnostics'),names=(await readdir(directory)).sort();
  assert.ok(names.length<=3);let totalBytes=0;const records=[];
  for(const name of names){assert.match(name,/^backend-exit\.jsonl(?:\.[12])?$/);const file=path.join(directory,name),info=await lstat(file);
    assert.ok(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o600&&info.size<=65536);totalBytes+=info.size;
    const content=await readFile(file,'utf8');assert.ok(!content.includes(c.root)&&!content.includes('/Users/')&&!content.includes('Synthetic native exit QA')&&!content.includes(c.fixture.projectName));
    for(const line of content.trim().split('\n').filter(Boolean)){const record=JSON.parse(line);assert.equal(record.appVersion,'0.4.1');assert.equal(record.channel,'production');
      assert.equal(record.signal,null);assert.ok(record.code===null||Number.isSafeInteger(record.code));assert.ok(Number.isFinite(Date.parse(record.time)));records.push(record);}
  }return {files:names.length,totalBytes,records:records.sort((a,b)=>a.time.localeCompare(b.time))};
}
async function audit(nameOverride){
  const c=await context(),name=label(typeof nameOverride==='string'?nameOverride:options.label||'audit'),baseline=await readJson(path.join(c.runtime,'baseline.json')),current=databaseSnapshot(c.workspace);
  for(const table of fixedTables)assert.deepEqual(current.tables[table],baseline.tables[table],`${table} changed across native lifecycle`);
  assert.deepEqual(await mediaHashes(c.workspace),baseline.media);assert.equal(sha(await readFile(path.join(c.workspace,'local-drafts-v1.json'))),baseline.draftSha256);
  assert.equal(current.jobs.length,1);const job=current.jobs[0],original=baseline.jobs[0];
  for(const key of ['id','projectId','shotId','requestId','snapshot','createdAt'])assert.deepEqual(job[key],original[key]);
  assert.equal(job.id,c.fixture.jobId);assert.equal(job.status,'submission_unknown');assert.equal(job.submissionCount,1);
  assert.equal(current.submissions.length,1);assert.equal(current.submissions[0].request_id,c.fixture.requestId);assert.equal(current.submissions[0].outcome,'unknown');assert.equal(current.providerTasks,0);
  const logs=await diagnostics(c),summary={synthetic:true,label:name,at:new Date().toISOString(),
    preserved:{businessTables:fixedTables.length,mediaFiles:baseline.media.length,timeline:true,subjectReceipts:true,localDraft:true},
    job:{status:job.status,submissionCount:job.submissionCount,providerSubmissionRows:current.submissions.length,providerTaskRows:current.providerTasks},
    diagnosticFiles:logs.files,diagnosticBytes:logs.totalBytes,starts:logs.records.filter(record=>record.event==='start').length,
    exits:logs.records.filter(record=>record.event==='exit').map(({runId,time,classification,reason,code,signal,expected,forced,exitConfirmed,mediaExitConfirmed,runtime})=>({runId,time,classification,reason,code,signal,expected,forced,exitConfirmed,mediaExitConfirmed,runtime}))};
  await writeNew(path.join(c.report,name+'-audit.json'),summary);return summary;
}
async function crash(){
  const c=await context(),signal=options.signal||'SIGKILL';assert.ok(['SIGKILL','SIGTERM','SIGINT'].includes(signal));
  const active=[];for(const file of (await readdir(c.runtime)).filter(name=>/^launch-[a-z0-9-]+\.json$/.test(name))){
    const launch=await readJson(path.join(c.runtime,file)),main=await processInfo(launch.mainPid);
    if(main?.ppid===launch.controllerPid&&main.command.includes(launch.electron)&&main.command.includes(launch.build))active.push(launch);
  }
  assert.equal(active.length,1,'Exactly one still-owned fixture launch is required');
  const request={synthetic:true,id:randomUUID(),fixtureId:c.fixture.requestId,signal,mainPid:active[0].mainPid,launchLabel:active[0].label};
  const requestFile=path.join(c.runtime,'crash-request.json');await writeNew(requestFile,request);
  const output=path.join(c.report,'fault-'+request.id+'.json');
  for(const deadline=Date.now()+10000;Date.now()<deadline;){if(await exists(output))return readJson(output);await pause(100);}
  if(await exists(requestFile)){const pending=await readJson(requestFile);if(pending.id===request.id)await rename(requestFile,path.join(c.runtime,'crash-request-'+request.id+'.expired.json'));}
  throw Error('Owned launcher did not acknowledge the fault request; the unhandled request was expired and no fallback signal was sent');
}
async function artifactHash(file){
  const info=await lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size<=512*1024*1024);const digest=createHash('sha256');
  for await(const chunk of createReadStream(file))digest.update(chunk);return {bytes:info.size,sha256:digest.digest('hex')};
}
async function metadata(){
  const c=await context(),sources={},artifacts={};
  for(const name of ['exit-diagnostics.ts','backend.mjs','supervisor.mjs'])sources[name]=await artifactHash(path.join(repo,'apps/desktop/src',name));
  sources['desktop-exit-qa-native.mjs']=await artifactHash(fileURLToPath(import.meta.url));
  for(const name of ['main.cjs','backend.cjs','preload.cjs','package.json'])artifacts[name]=await artifactHash(path.join(repo,'apps/desktop/build',name));
  const {stdout}=await executeFile('/usr/bin/sw_vers',['-productVersion'],{timeout:2000,maxBuffer:4096}),logs=await diagnostics(c);
  const result={synthetic:true,at:new Date().toISOString(),macOS:stdout.trim(),arch:process.arch,controllerNode:process.versions.node,
    electronPackage:require('electron/package.json').version,nativeRuntimes:[...new Map(logs.records.map(record=>[JSON.stringify(record.runtime),record.runtime])).values()],sources,artifacts};
  await writeNew(path.join(c.report,'metadata-'+randomUUID().slice(0,8)+'.json'),result);return result;
}
async function finalize(){
  const c=await context(),summary=await audit('final-'+randomUUID().slice(0,8)),logs=await diagnostics(c),exits=logs.records.filter(record=>record.event==='exit');
  assert.ok(exits.some(record=>record.classification==='normal'&&record.code===0&&record.expected===true&&record.exitConfirmed===true));
  assert.ok(exits.some(record=>record.classification==='abnormal'&&record.expected===false&&record.exitConfirmed===true));
  assert.ok(new Set(logs.records.filter(record=>record.event==='start').map(record=>record.runId)).size>=2);
  assert.equal(await exists(path.join(c.workspace,'server.lock')),false,'Normal native Quit has not released backend lock');
  const launches=(await readdir(c.runtime)).filter(name=>/^launch-[a-z0-9-]+\.json$/.test(name));
  for(const file of launches){const owned=await readJson(path.join(c.runtime,file)),exit=await readJson(path.join(c.report,owned.label+'-exit.json'));
    assert.deepEqual(exit.result,{code:0,signal:null});assert.equal(exit.backendLockReleased,true);assert.equal(await processInfo(owned.mainPid),null,'Owned Electron is still present');}
  await metadata();
  const result={...summary,ok:true,normalQuitVerified:true,abnormalUtilityExitVerified:true,
    explicitRecoveryNoResubmit:true,sandboxUnchanged:true,debuggingEnabled:false,productionBuild:true};
  await writeNew(path.join(c.report,'summary.json'),result);return result;
}
try{const actions={prepare,launch,audit,crash,metadata,finalize};assert.ok(actions[action],'Expected prepare/launch/audit/crash/metadata/finalize');console.log(json(await actions[action]()));}
catch(error){console.error(error.stack||String(error));process.exitCode=1;}
