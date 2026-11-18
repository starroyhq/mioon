// Fixed development-package checks. No script, inspector or renderer test API
// is accepted from outside the application; reports contain no local paths.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {App, BrowserWindow, Session, WebPreferences} from 'electron';
import {validateManagedFile} from '@mioon/contracts/private-storage';
import {verifyProjectExampleResources} from '../../../packages/business/src/project-example-resources.ts';
import {createDesktopSecretCodec} from './secret-store.ts';
import type {DesktopSafeStorage} from './secret-store.ts';
import type {DesktopPaths} from './config.ts';
import type {BackendReady} from './supervisor.ts';
import type {DesktopStartReport} from './smoke-checks.ts';
import {probeDesktopProjectLocation} from './project-location-probe.ts';

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
}
const record=(value:unknown):Record<string,unknown>=>{
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;
};
/** Fixed progress markers shared with the outer smoke driver. Only these names
 * are ever written, so a hung launch can be located without raw output. */
export const WINDOWS_SMOKE_PHASES=Object.freeze(['startup','smoke','packaged-development-identity','bundled-utility-node-sqlite',
 'launcher-ui-ready','renderer-sandbox-and-origin','secure-memory-cookie','loopback-rpc-and-anonymous-denial',
 'renderer-network-window-permission-fences','private-discovery-acl','configured-windows-media-tools',
 'dpapi-app-scoped-roundtrip','packaged-example-resources','native-project-location','write-report'] as const);

/** The hard gate is packaged launch/security, not complete Windows support.
 * Unavailable project and live-provider flows remain explicit blocked entries.
 * Progress and failure evidence contain fixed names only; never raw errors. */
export async function runWindowsSmoke({app,getWindow,getSession,getReady,paths,report,safeStorage,output}:WindowsSmokeOptions):Promise<void>{
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
  let locationAvailable=false;
  try{
   await probeDesktopProjectLocation({path:paths.userData,purpose:'create',isDirectory:true});
   locationAvailable=true;passed('native-project-location');
  }catch(error){
   assert.equal(record(error).code,'PROJECT_LOCATION_INVALID');
   blocked('native-project-location','PROJECT_LOCATION_INVALID');
  }
  blocked('native-project-core-flows',locationAvailable?'WINDOWS_PROJECT_CORE_FLOWS_NOT_VERIFIED':'WINDOWS_PROJECT_LOCATION_UNAVAILABLE');
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
