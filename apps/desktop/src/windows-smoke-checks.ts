// Fixed development-package checks. No script, inspector or renderer test API
// is accepted from outside the application; reports contain no local paths.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {access, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {App, BrowserWindow, Session, WebPreferences} from 'electron';
import {BrowserWindow as BrowserWindowRuntime} from 'electron';
import {validateManagedFile} from '@mioon/contracts/private-storage';
import {verifyProjectExampleResources} from '../../../packages/business/src/project-example-resources.ts';
import {createDesktopSecretCodec} from './secret-store.ts';
import type {DesktopSafeStorage} from './secret-store.ts';
import type {DesktopPaths} from './config.ts';
import type {BackendReady} from './supervisor.ts';
import type {DesktopStartReport} from './smoke-checks.ts';
import {probeDesktopProjectLocation} from './project-location-probe.ts';
import type {WindowsProjectVolumeReader} from './project-location-probe.ts';
import {projectLocationDecision} from './project-location-policy.ts';

interface SmokeCheck {name:string;status:'passed'|'blocked';code?:string}
interface InspectableContents {getLastWebPreferences():WebPreferences|null|undefined}
interface WindowsSmokeOptions {
 app:App;
 getWindow():BrowserWindow|null;
 getSession():Session|null;
 getReady():BackendReady|null;
 paths:DesktopPaths;
 report:DesktopStartReport;
 safeStorage:DesktopSafeStorage;
 output:string;
 windowsProjectVolume?: WindowsProjectVolumeReader | null;
}
const record=(value:unknown):Record<string,unknown>=>{
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;
};
/** Fixed progress markers shared with the outer smoke driver. Only these names
 * are ever written, so a hung launch can be located without raw output. */
export const WINDOWS_SMOKE_PHASES=Object.freeze(['startup','smoke','packaged-development-identity','bundled-utility-node-sqlite',
 'launcher-ui-ready','renderer-sandbox-and-origin','secure-memory-cookie','loopback-rpc-and-anonymous-denial',
 'renderer-network-window-permission-fences','private-discovery-acl','configured-windows-media-tools',
 'dpapi-app-scoped-roundtrip','packaged-example-resources','native-project-location','project-location-facts','project-location-paths',
 'project-location-network','native-project-core-flows','project-core-create','project-core-export','project-core-open','write-report'] as const);

interface CoreFlowOptions {app:App;session:Session|null;ready:BackendReady|null;smokeRoot:string;
 mark:(next:typeof WINDOWS_SMOKE_PHASES[number])=>Promise<void>}
const waitUntil=async(check:()=>Promise<boolean>,timeoutMs:number,message:string):Promise<void>=>{
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}
 throw new Error(message);
};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Desktop project core flows over the same loopback API and native bridges the
 * UI uses. Native location dialogs cannot be automated, so creation uses the
 * fixed template entry with an explicit retained parent directory; everything
 * after it (open, close, reopen) goes through the trusted desktop host. */
async function runProjectCoreFlows({app,session,ready,smokeRoot,mark}:CoreFlowOptions):Promise<void>{
 assert.ok(session&&ready);
 const request=async(address:string,operation:string,input:unknown):Promise<unknown>=>{
  const response=await session.fetch(new URL(address,ready.url).href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,input})});
  const payload=record(await response.json());
  if(!response.ok||payload.ok!==true)throw new Error('Windows project core flow request failed');
  return payload.data;
 };
 const projectAddress=(projectId:string)=>`/api/projects/${projectId}/rpc`;
 await mark('project-core-create');
 const createdAt=record(await request('/api/rpc','project.template.instantiate',{templateId:'timeline-basics',templateVersion:1,parentDir:smokeRoot,name:'W2 Smoke',requestId:randomUUID()}));
 const project=record(createdAt.project),projectId=String(project.projectId),projectFile=String(project.projectFile);
 assert.ok(/^[0-9a-f-]{36}$/u.test(projectId));assert.equal(path.basename(projectFile),'W2 Smoke.mioon');assert.equal(path.dirname(projectFile),path.join(smokeRoot,'W2 Smoke'));
 assert.equal(record(record(await request(projectAddress(projectId),'project.get',{projectId})).project).name,'W2 Smoke');
 await access(projectFile);
 const renamed=record(await request('/api/rpc','project.rename',{requestId:randomUUID(),projectId,
  expectedRevision:Number(record(record(await request(projectAddress(projectId),'project.get',{projectId})).project).revision),name:'W2 Smoke Renamed'}));
 assert.equal(renamed.name,'W2 Smoke Renamed');
 const example=path.join(process.resourcesPath,'examples','timeline-basics','media','overlay-star.png');
 const image=await readFile(example);
 const asset=record(await request(projectAddress(projectId),'asset.import',{projectId,name:'smoke-import.png',mimeType:'image/png',dataBase64:image.toString('base64')}));
 assert.equal(asset.name,'smoke-import.png');assert.equal(asset.mimeType,'image/png');
 await mark('project-core-export');
 const state=record(await request(projectAddress(projectId),'project.get',{projectId}));
 const timeline=record(state.timeline),exportIdValue=record(await request(projectAddress(projectId),'timeline.render',{projectId,
  expectedRevision:Number(timeline.revision),requestId:randomUUID(),purpose:'export',exportRange:{startFrame:0,endFrame:60}}));
 const exportId=String(exportIdValue.id);
 assert.ok(/^[0-9a-f-]{36}$/u.test(exportId));
 const deadline=Date.now()+180000;
 for(;;){
  const activity=record(await request(projectAddress(projectId),'export.activity.get',{projectId,exportId}));
  const stage=String(activity.stage);
  if(stage==='complete')break;
  if(stage==='failed'||stage==='cancelled')throw new Error('Windows project export did not complete');
  if(Date.now()>deadline)throw new Error('Windows project export timed out');
  await sleep(500);
 }
 const output=record(await request(projectAddress(projectId),'export.output.get',{projectId,exportId}));
 const outputFile=String(output.fileLocation),outputSize=Number(output.sizeBytes);
 assert.ok(path.isAbsolute(outputFile));assert.ok(Number.isSafeInteger(outputSize)&&outputSize>1024);
 assert.equal((await stat(outputFile)).size,outputSize);assert.match(String(output.sha256),/^[0-9a-f]{64}$/u);
 await mark('project-core-open');
 const bridgeOpen=async():Promise<BrowserWindow>=>{
  const launcher=getWindowForSmoke(app);assert.ok(launcher&&!launcher.isDestroyed());
  const result=record(await launcher.webContents.executeJavaScript(`(async()=>{const recent=await window.__mioonProjectEntries.listRecent();
   const entry=recent.registered.find(value=>value.project.projectId===${JSON.stringify(projectId)});if(!entry)return {status:'missing'};
   const opened=await window.__mioonProjectEntries.openRecent({projectId:${JSON.stringify(projectId)},remember:false,entryToken:crypto.randomUUID()});
   return {status:opened.status,projectId:opened.projectId??null};})()`,true));
  assert.equal(result.status,'opened');assert.equal(result.projectId,projectId);
  const expectedUrl=new URL(`/?project=${projectId}`,ready.url).href;
  await waitUntil(async()=>BrowserWindowRuntime.getAllWindows().some(window=>!window.isDestroyed()&&window.webContents.getURL()===expectedUrl),30000,'The project window did not open');
  const editor=BrowserWindowRuntime.getAllWindows().find(window=>!window.isDestroyed()&&window.webContents.getURL()===expectedUrl)!;
  await waitUntil(async()=>Boolean(await editor.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="workbench"]'))`,true).catch(()=>false)),60000,'The project workbench did not become ready');
  return editor;
 };
 const closeEditor=async(editor:BrowserWindow):Promise<void>=>{const closed=new Promise<void>(resolve=>{if(editor.isDestroyed())return resolve();editor.once('closed',()=>resolve());});editor.close();await closed;};
 let editor=await bridgeOpen();
 await closeEditor(editor);
 editor=await bridgeOpen();
 await closeEditor(editor);
 clearSmokeWorkspace(projectFile);
}
function getWindowForSmoke(app:App):BrowserWindow|null{
 const windows=BrowserWindowRuntime.getAllWindows().filter(window=>!window.isDestroyed());
 return windows.find(window=>window.webContents.getURL().endsWith('/'))??windows[0]??null;
}
function clearSmokeWorkspace(projectFile:string):void{
 // The desktop window has closed; the surrounding disposable Documents folder
 // is removed by the caller, never a user-chosen project.
 try{void rm(path.dirname(projectFile),{recursive:true,force:true});}catch{/* Best effort after a passing flow. */}
}
/** The hard gate is packaged launch/security, not complete Windows support.
 * Unavailable project and live-provider flows remain explicit blocked entries.
 * Progress and failure evidence contain fixed names only; never raw errors. */
export async function runWindowsSmoke({app,getWindow,getSession,getReady,paths,report,safeStorage,output,windowsProjectVolume}:WindowsSmokeOptions):Promise<void>{
 const checks:SmokeCheck[]=[];
 const passed=(name:string)=>{checks.push({name,status:'passed'});};
 const blocked=(name:string,code:string)=>{checks.push({name,status:'blocked',code});};
 const phaseFile=`${output}.phase`;
 let phase='smoke';
 const mark=async(next:typeof WINDOWS_SMOKE_PHASES[number]):Promise<void>=>{
  phase=next;
  await writeFile(phaseFile,JSON.stringify({schemaVersion:1,scope:'windows-development-launch',phase:next})+'\n').catch(()=>{});
 };
 try{
  await mark('packaged-development-identity');
  assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');
  assert.equal(app.isPackaged,true);assert.equal(report.identity.channel,'development');
  assert.equal(report.identity.appId,'app.starroy.mioon.dev');
  assert.equal(app.getName(),report.identity.productName);assert.equal(app.getPath('userData'),paths.userData);
  const metadata=record(JSON.parse(await readFile(path.join(app.getAppPath(),'package.json'),'utf8')));
  assert.deepEqual(metadata.mioonDesktop,report.identity);
  passed('packaged-development-identity');
  await mark('bundled-utility-node-sqlite');
  assert.ok(process.versions.electron);assert.ok(Number(report.runtime.node.split('.')[0])>=24);
  assert.equal(report.runtime.electron,process.versions.electron);assert.notEqual(report.runtime.pid,process.pid);
  passed('bundled-utility-node-sqlite');
  await mark('launcher-ui-ready');
  const window=getWindow();assert.ok(window&&!window.isDestroyed());
  const evaluate=(script:string):Promise<unknown>=>window.webContents.executeJavaScript(script,true);
  const deadline=Date.now()+60000;
  while(!await evaluate(`Boolean(document.querySelector('[data-testid="project-home"]'))`)){
   assert.ok(Date.now()<deadline,'Windows launcher did not become ready');
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  passed('launcher-ui-ready');
  await mark('renderer-sandbox-and-origin');
  const prefs=(window.webContents as unknown as InspectableContents).getLastWebPreferences();assert.ok(prefs);
  assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.webSecurity,true);
  const globals=record(await evaluate(`({node:typeof process,require:typeof require,electron:typeof window.electron,cookie:document.cookie,url:location.href,secure:isSecureContext})`));
  assert.equal(globals.node,'undefined');assert.equal(globals.require,'undefined');assert.equal(globals.electron,'undefined');
  assert.equal(globals.cookie,'');assert.equal(globals.secure,true);
  const origin=new URL(String(globals.url));assert.equal(origin.hostname,'127.0.0.1');assert.ok(!origin.searchParams.has('token'));
  passed('renderer-sandbox-and-origin');
  await mark('secure-memory-cookie');
  const session=getSession();assert.ok(session);
  const cookies=await session.cookies.get({name:'mioon_session'});assert.equal(cookies.length,1);
  assert.equal(cookies[0]!.secure,true);assert.equal(cookies[0]!.httpOnly,true);assert.equal(cookies[0]!.sameSite,'strict');assert.equal(cookies[0]!.session,true);
  passed('secure-memory-cookie');
  await mark('loopback-rpc-and-anonymous-denial');
  const rpc=record(await evaluate(`fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'project.list',input:{}})}).then(async response=>({status:response.status,body:await response.json()}))`));
  assert.equal(rpc.status,200);assert.equal(record(rpc.body).ok,true);
  const ready=getReady();assert.ok(ready);
  const anonymous=await fetch(new URL('/api/rpc',ready.url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'project.list',input:{}})});
  assert.equal(anonymous.status,401);
  passed('loopback-rpc-and-anonymous-denial');
  await mark('renderer-network-window-permission-fences');
  assert.equal(await evaluate(`window.open('https://example.com')===null`),true);
  assert.equal(await evaluate(`fetch('https://example.com').then(()=>false,()=>true)`),true);
  assert.equal(await evaluate(`Notification.requestPermission()`),'denied');
  passed('renderer-network-window-permission-fences');
  await mark('private-discovery-acl');
  const discovery=record(JSON.parse(await readFile(path.join(paths.userData,'mcp-connection.json'),'utf8')));
  assert.equal(discovery.appId,report.identity.appId);assert.equal(discovery.channel,'development');assert.equal(discovery.pid,ready.runtime.pid);
  assert.equal(discovery.tokenFile,path.join(paths.userData,'mcp-token'));
  for(const file of [path.join(paths.userData,'mcp-connection.json'),String(discovery.tokenFile)]){
   assert.ok(validateManagedFile(file,{root:paths.userData,private:true}));
  }
  passed('private-discovery-acl');
  await mark('configured-windows-media-tools');
  // report.tools carries the probed version lines; the renderer bridge reads
  // the configured absolute paths (env wins over the stored config document).
  const tools=record(await evaluate(`window.__mioonWorkspaceTools.read()`));
  const ffmpegPath=process.env.MIOON_FFMPEG_PATH,ffprobePath=process.env.MIOON_FFPROBE_PATH;
  assert.ok(typeof ffmpegPath==='string'&&path.isAbsolute(ffmpegPath));
  assert.ok(typeof ffprobePath==='string'&&path.isAbsolute(ffprobePath));
  assert.equal(tools.ffmpeg,ffmpegPath);assert.equal(tools.ffprobe,ffprobePath);
  assert.ok(typeof report.tools.ffmpeg==='string'&&report.tools.ffmpeg.length>0);
  assert.ok(typeof report.tools.ffprobe==='string'&&report.tools.ffprobe.length>0);
  passed('configured-windows-media-tools');
  await mark('dpapi-app-scoped-roundtrip');
  const codec=createDesktopSecretCodec({safeStorage,appId:report.identity.appId,platform:'win32'});
  try{
   assert.equal(codec.storage().persistentAvailable,true);
   const plaintext='mioon-windows-smoke:'+randomUUID();
   const ciphertext=await codec.encrypt(plaintext);assert.notEqual(ciphertext,plaintext);
   assert.equal(await codec.decrypt(ciphertext),plaintext);
  }finally{codec.close();}
  passed('dpapi-app-scoped-roundtrip');
  await mark('packaged-example-resources');
  verifyProjectExampleResources(path.join(process.resourcesPath,'examples'));
  passed('packaged-example-resources');
  await mark('native-project-location');
  // Real volume facts for the actual project location used by the core flows.
  const documents=app.getPath('documents'),smokeRoot=path.join(documents,'Mioon Windows Smoke '+randomUUID());
  await mkdir(smokeRoot,{recursive:true});
  const volumeDependencies=windowsProjectVolume?{readWindowsVolume:windowsProjectVolume}:{};
  try{
   await mark('project-location-facts');
   const facts=await probeDesktopProjectLocation({path:smokeRoot,purpose:'create',isDirectory:true},volumeDependencies);
   assert.equal(facts.fileSystem.toLowerCase(),'ntfs');
   assert.equal(facts.isLocal,true);assert.equal(facts.volumeReadOnly,false);assert.equal(facts.permissionBits,true);
   assert.notEqual(projectLocationDecision(facts).kind,'reject');
   await mark('project-location-paths');
   // Windows path details are rejected by the same probe before any file work.
   for(const [file,reason] of [[path.join(smokeRoot,'CON'),'reserved-name'],[path.join(smokeRoot,'trailing.'),'trailing-dot-or-space'],
    [path.join(smokeRoot,'bad<name'),'invalid-character'],['\\\\.\\pipe\\mioon','device-path']] as const){
    await probeDesktopProjectLocation({path:file,purpose:'create',isDirectory:false}).then(()=>assert.fail('malformed project path was accepted'),
     error=>{const value=record(error);assert.equal(value.code,'PROJECT_LOCATION_INVALID');assert.equal(record(value.details).reason,reason);});
   }
   await mark('project-location-network');
   const network=await probeDesktopProjectLocation({path:path.join(smokeRoot,'film.mioon'),purpose:'open',isDirectory:false},{
    readWindowsVolume:async()=>({fileSystem:'SMB',isLocal:false,volumeReadOnly:false,permissionBits:true,cloudSyncRoot:false,placeholder:false})});
   assert.deepEqual(projectLocationDecision(network),{kind:'reject'});
   passed('native-project-location');
  }catch(error){
   try{await rm(smokeRoot,{recursive:true,force:true});}catch{/* Best effort only after a failed probe. */}
   throw error;
  }
  await mark('native-project-core-flows');
  await runProjectCoreFlows({app,session:getSession(),ready:getReady(),smokeRoot,mark});
  passed('native-project-core-flows');
  try{await rm(smokeRoot,{recursive:true,force:true});}catch{/* The runner is disposable; cleanup never hides a passing flow. */}
  blocked('live-mio-and-generation','LIVE_CREDENTIALS_NOT_CONFIGURED');
  await mark('write-report');
  await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify({schemaVersion:1,scope:'windows-development-launch',ok:true,channel:'development',platform:'win32',arch:'x64',isPackaged:true,
   appVersion:app.getVersion(),runtime:{node:report.runtime.node,electron:report.runtime.electron},checks},null,2)+'\n');
 }catch{
  // Fixed failure evidence only: the outer driver reads the check name, while
  // assertion messages and paths never leave this process.
  await mkdir(path.dirname(output),{recursive:true}).catch(()=>{});
  await writeFile(output,JSON.stringify({schemaVersion:1,scope:'windows-development-launch',ok:false,code:'WINDOWS_SMOKE_CHECK_FAILED',check:phase})+'\n').catch(()=>{});
 }
}
