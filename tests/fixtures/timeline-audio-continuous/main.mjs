/** Test-only Electron host. It uses the production native host, authority,
 * continuous service, decoder, managed-source validation and HTTP adapter.
 * Its fixed local fixture shell is separate from the production app UI. */
import {app,BrowserWindow,ipcMain,session as electronSession} from 'electron';
import {createServer} from 'node:http';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../../../packages/business/src/db.mjs';
import {validateTimeline} from '../../../packages/business/src/timeline-inputs.mjs';
import {readTimelinePreflightSnapshot,readTimelineSourceGraph} from '../../../packages/business/src/timeline-sources.mjs';
import {validateManagedSource,verifiedManagedHash} from '../../../packages/business/src/managed-media.mjs';
import {run,runStreamingWithBackpressure,checkMediaEffect} from '../../../packages/business/src/media-runtime.mjs';
import {withProbePermit} from '../../../packages/business/src/media-probe.mjs';
import {onMediaProcess,hasUnconfirmedMediaProcesses} from '../../../packages/business/src/media-processes.mjs';
import {createTimelineAudioContinuousServices} from '../../../packages/business/src/timeline-audio-continuous.ts';
import {createTimelineAudioContinuousDecoder} from '../../../packages/business/src/timeline-audio-continuous-decoder.ts';
import {createSavedTimelineAudioReader} from '../../../packages/business/src/timeline-audio-preview-coordinator.ts';
import {createTimelineAudioContinuousHttp} from '../../../apps/server/src/timeline-audio-continuous-http.ts';
import {createNativeAudioPreviewAuthority} from '../../../packages/business/src/native-audio-preview.ts';
import {createNativeAudioPreviewHost,createNativeAudioPreviewSigningIdentity} from '../../../apps/desktop/src/native-audio-preview-host.ts';
import {NATIVE_AUDIO_CHANNEL} from '../../../packages/contracts/src/native-audio-preview.ts';

const root=path.dirname(fileURLToPath(import.meta.url)),token=randomBytes(32).toString('hex');
const report={schemaVersion:1,status:'running',startedAt:new Date().toISOString(),scope:'Controlled original synthetic media, actual production service/HTTP/native proof/client/engine in sandboxed Electron renderer; silent pre-destination capture, no physical listening claim.',
  environment:{platform:process.platform,arch:process.arch,osRelease:os.release(),cpu:os.cpus()[0]?.model,versions:process.versions},cases:[]};
let store,server,service,audioHost,currentWindow,currentCase,currentDocument,settleCase,offMedia;
const telemetry=[],processes=[],documents=new Map(),ownerAbort=new AbortController();
const save=()=>writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const unconfirmed=()=>Object.assign(Error('Owned fixture cleanup remains unconfirmed'),{terminationUnconfirmed:true});
const boundedShutdown=async(work)=>{let timeout;try{return await Promise.race([work,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(unconfirmed()),10000);})]);}finally{clearTimeout(timeout);}};
function owner(contents){
  if(!currentWindow||contents!==currentWindow.webContents||contents.isDestroyed())return null;
  const frame=contents.mainFrame;
  if(!currentDocument||currentDocument.frame!==frame){currentDocument={backendId:signer.config.backendId,windowId:randomUUID(),contextId:randomUUID(),projectId:currentCase.input.projectId,contents,frame,isCurrent:()=>currentDocument?.contents===contents&&currentDocument?.frame===frame};documents.set(contents,currentDocument);}
  return currentDocument;
}
const signer=createNativeAudioPreviewSigningIdentity(randomUUID()),authority=createNativeAudioPreviewAuthority(signer.config);
app.setPath('userData',path.join(root,'electron-user-data'));
app.whenReady().then(async()=>{
  try{
    const manifest=JSON.parse(await readFile(path.join(root,'cases.json'),'utf8'));report.references=manifest.references;
    report.artifacts=Object.fromEntries(await Promise.all(['main.cjs','preload.cjs','web/entry.js','web/capture-worklet.js','cases.json'].map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
    try{report.environment.launch=JSON.parse(await readFile(path.join(root,'environment.json'),'utf8'));}catch{/* Earlier reusable fixtures did not record launcher metadata. */}
    try{report.sourceHashes=JSON.parse(await readFile(path.join(root,'source-hashes.json'),'utf8'));}catch{/* Earlier reusable fixtures did not record source hashes. */}
    await save();
    store=openStore(path.join(root,'workspace'));
    const readSavedAudio=createSavedTimelineAudioReader({db:store.db,
      readTimeline:projectId=>readTimelinePreflightSnapshot(store,projectId).timeline,
      readAssets:(projectId,timeline)=>readTimelineSourceGraph(store.db,projectId,timeline),
      validate:(timeline,assets)=>validateTimeline(timeline,assets,{structureOnly:true})});
    offMedia=onMediaProcess(event=>{processes.push({...event,observedAt:Date.now()});});
    service=createTimelineAudioContinuousServices(store,{signal:ownerAbort.signal,runtime:{assertOrdinaryWorkspace(){if(getWorkspaceRestoreContext(store))throw Error('Synthetic fixture unexpectedly restored');},ownsLock:()=>ownsStoreLock(store),
      readSavedTimeline:readSavedAudio,validateSource:validateManagedSource,hash:verifiedManagedHash,
      decoder:createTimelineAudioContinuousDecoder({run,runStreamingWithBackpressure,withProbePermit,checkMediaEffect}),boundedShutdown,
      telemetry:event=>{telemetry.push({...event,observedAt:Date.now()});}}});
    authority.bind({handlers:{'timeline.audioPreview.plan':async()=>{throw Error('No v1 fallback');},...service.handlers},retireSessionById:service.retireSessionById});
    const http=createTimelineAudioContinuousHttp({service,nativeAdmission:authority,signal:ownerAbort.signal,assertAvailable(){if(!ownsStoreLock(store))throw Error('Fixture store lock lost');}});
    server=createServer(async(req,res)=>{
      try{
        const origin=`http://127.0.0.1:${server.address().port}`;
        if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403).end();return;}
        const url=new URL(req.url,origin);
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'");
        if(url.pathname.startsWith('/api/')&&!(req.headers.cookie??'').split(';').map(value=>value.trim()).includes(`mioon_session=${token}`)){res.writeHead(401).end();return;}
        if(await http(req,res,url))return;
        if(url.pathname==='/api/rpc'&&req.method==='POST'){
          let text='';for await(const bytes of req){text+=bytes;if(Buffer.byteLength(text)>4096)throw Error('Synthetic RPC input exceeded bound');}
          const value=JSON.parse(text);if(value.operation!=='timeline.audioPreview.continuousPlan')throw Error('Synthetic RPC operation denied');
          const data=await service.handlers[value.operation](value.input);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,data}));return;
        }
        if(req.method!=='GET'||!['/','/entry.js','/capture-worklet.js'].includes(url.pathname)&&!/^\/oracle\/[a-z0-9-]+\/\d{5}\.f32$/u.test(url.pathname)){res.writeHead(404).end();return;}
        const file=path.join(root,'web',url.pathname==='/'?'index.html':url.pathname.slice(1)),info=await stat(file);if(!info.isFile()||info.size>2*1024*1024)throw Error('Synthetic static resource bound');
        res.writeHead(200,{'content-type':url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.f32')?'application/octet-stream':'text/html','content-length':info.size,'cache-control':'no-store'}).end(await readFile(file));
      }catch(error){if(res.headersSent)res.destroy();else res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:{code:error.code??'FIXTURE_ERROR'}}));}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
    const nativeSession=electronSession.fromPartition(`continuous-fixture-${randomUUID()}`);
    await nativeSession.cookies.set({url:origin,name:'mioon_session',value:token,httpOnly:true,sameSite:'strict'});
    audioHost=createNativeAudioPreviewHost({backendId:signer.config.backendId,origin,signer,isAdmissionAllowed:()=>!ownerAbort.signal.aborted,ownerForContents:owner,request:command=>authority.command(command)});
    nativeSession.webRequest.onBeforeSendHeaders((details,callback)=>callback(audioHost.beforeSendHeaders(details)));
    ipcMain.handle(NATIVE_AUDIO_CHANNEL,(event,value)=>audioHost.dispatch(event,value));
    ipcMain.handle('continuous-fixture:config',event=>{if(event.sender!==currentWindow?.webContents||event.senderFrame!==event.sender.mainFrame)throw Error('Wrong fixture renderer');return currentCase;});
    ipcMain.handle('continuous-fixture:report',(event,value)=>{
      if(event.sender!==currentWindow?.webContents||event.senderFrame!==event.sender.mainFrame||Buffer.byteLength(JSON.stringify(value))>2*1024*1024)throw Error('Invalid fixture report');
      settleCase(value);return true;
    });
    ipcMain.handle('continuous-fixture:capture',async(event,value)=>{
      if(event.sender!==currentWindow?.webContents||event.senderFrame!==event.sender.mainFrame||os.endianness()!=='LE'||
        !(value.left instanceof Float32Array)||!(value.right instanceof Float32Array)||value.left.length!==value.right.length||value.left.length>30*48000)throw Error('Invalid bounded synthetic capture');
      await writeFile(path.join(root,`${currentCase.name}.failed-left.f32le`),Buffer.from(value.left.buffer,value.left.byteOffset,value.left.byteLength),{mode:0o600});
      await writeFile(path.join(root,`${currentCase.name}.failed-right.f32le`),Buffer.from(value.right.buffer,value.right.byteOffset,value.right.byteLength),{mode:0o600});
      const {left,right,...metadata}=value;await writeFile(path.join(root,`${currentCase.name}.failed-capture.json`),JSON.stringify(metadata,null,2),{mode:0o600});return true;
    });
    const selected=process.env.MIOON_CONTINUOUS_CASES?.split(',');
    for(const item of manifest.cases.filter(item=>!selected||selected.includes(item.name))){
      currentCase=item;currentDocument=null;const telemetryStart=telemetry.length,processStart=processes.length;
      currentWindow=new BrowserWindow({show:false,width:1080,height:760,webPreferences:{preload:path.join(root,'preload.cjs'),session:nativeSession,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
      const window=currentWindow,finished=new Promise(resolve=>{settleCase=resolve;});
      window.webContents.on('render-process-gone',(_event,details)=>settleCase({name:item.name,status:'failed',error:`Renderer exited: ${details.reason}`}));
      await window.loadURL(`${origin}/?project=${item.input.projectId}`);
      let timer;const result=await Promise.race([finished,new Promise(resolve=>{timer=setTimeout(()=>resolve({name:item.name,status:'failed',error:'Bounded fixture case timeout'}),5*60*1000);})]);clearTimeout(timer);
      const document=owner(window.webContents);if(document)audioHost.revokeOwner(document,true);window.destroy();currentWindow=null;currentDocument=null;
      // The next window's native acquire also waits for this exact backend
      // retirement; this local observation merely lets telemetry settle.
      await new Promise(resolve=>setTimeout(resolve,30));
      const observed=processes.slice(processStart),active=new Set();let peak=0;
      for(const event of observed){if(event.type==='started'&&event.kind==='ffmpeg'){active.add(event.pid);peak=Math.max(peak,active.size);}else if(event.type==='exited')active.delete(event.pid);}
      const entries=telemetry.slice(telemetryStart);
      const expectedDecodeUnits=manifest.references.find(reference=>reference.name===item.name).compositionSegments.reduce((sum,segment)=>sum+segment.sourceVoices,0);
      const startedFfmpegProcesses=observed.filter(event=>event.type==='started'&&event.kind==='ffmpeg').length;
      if(item.mode!=='performance'&&result.status==='passed'&&startedFfmpegProcesses!==expectedDecodeUnits){result.status='failed';result.error=`Sequential playback reopened original decode units: ${startedFfmpegProcesses} processes for ${expectedDecodeUnits} original voice/segment units`;}
      report.cases.push({...result,name:item.name,backend:{telemetry:entries,mediaProcesses:observed,peakOwnedFfmpegProcesses:peak,remainingObservedFfmpeg:active.size,
        originalVoiceSegmentUnits:expectedDecodeUnits,startedFfmpegProcesses,
        measuredHashBytes:Math.max(0,...entries.filter(event=>event.type==='hash').map(event=>event.bytes)),measuredDecodeWorkFrames:Math.max(0,...entries.map(event=>event.workFrames??0)),
        peakConservativeBackendPcmBytes:Math.max(0,...entries.filter(event=>event.type==='block').map(event=>event.pcmPeakBoundBytes??0)),
        conservativeActivePcmBoundBytes:96*1024*1024,allocationNote:'Production protocol admission is fixed96MiB; renderer reports actual retained mixed-buffer copies. Backend telemetry reports per-block PCM and active cursor count; this is not process RSS.',
        workNote:'workFrames is measured conservative session debit, including original-segment seek prefixes and bounded read-ahead. measuredHashBytes/workFrames report the largest session within a case, not an RSS measurement or the sum of repeated performance sessions.'}});
      await save();if(result.status!=='passed')throw Error(`${item.name} failed`);
    }
    await audioHost.shutdown();await service.drain();assertNoChildren();report.remainingOwnedChildPids=remainingProcesses();report.status='passed';report.completedAt=new Date().toISOString();await save();
    await new Promise(resolve=>server.close(resolve));store.close();offMedia();app.exit(0);
  }catch(error){report.status='failed';report.error=String(error.stack??error);await save();
    ownerAbort.abort();currentWindow?.destroy();await service?.drain().catch(()=>{});server?.close();try{store?.close();}catch{}offMedia?.();app.exit(1);}
});
function remainingProcesses(){const active=new Set();for(const event of processes){if(event.type==='started')active.add(event.pid);else if(event.type==='exited')active.delete(event.pid);}return [...active];}
function assertNoChildren(){if(hasUnconfirmedMediaProcesses()||remainingProcesses().length)throw Error('Unconfirmed or still-active owned media child remains');}
app.on('window-all-closed',()=>{/* Serial fixture windows share one trusted backend epoch. */});
