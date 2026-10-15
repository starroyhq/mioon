/** Explicit offline WebAudio diagnostic, isolated from the running workspace.
 * node tests/fixtures/timeline-audio-continuous/origin-sweep.mjs <fresh-output-dir> [reference.f32]
 * An optional independent interleaved stereo reference supplies its first four
 * seconds. Otherwise use a deterministic faded signal. No device output. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, open, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const engine = path.join(repo, 'apps/web/src/timeline-audio-continuous-engine.ts');
const RATE = 48000, SAMPLE_FRAMES = 4 * RATE;
async function referencePrefix(file) {
  if (!file) {
    const bytes = Buffer.alloc(SAMPLE_FRAMES * 8);
    for (let sample = 0; sample < SAMPLE_FRAMES; sample++) {
      const value = .5 * Math.round(6200 * Math.sin(sample * .057) + 1700 * Math.cos(sample * .019)) / 32768 * Math.min(1, sample / 49600);
      bytes.writeFloatLE(value, sample * 8); bytes.writeFloatLE(-value, sample * 8 + 4);
    }
    return bytes;
  }
  const source = await open(file, 'r');
  try {
    const info = await source.stat(); assert.ok(info.isFile() && info.size >= SAMPLE_FRAMES * 8, 'Reference must contain four complete seconds');
    const bytes = Buffer.alloc(SAMPLE_FRAMES * 8), result = await source.read(bytes, 0, bytes.length, 0);
    assert.equal(result.bytesRead, bytes.length); return bytes;
  } finally {await source.close();}
}

const browserSource = `import {createContinuousTimelineAudioTransport} from ${JSON.stringify(engine)};
globalThis.runOriginSweep=async(base64)=>{
  const raw=atob(base64),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),reference=new DataView(bytes.buffer);
  const RATE=48000,BLOCK=96000,TOTAL=192000,rows=[];
  const expected=(sample,channel)=>reference.getFloat32(sample*8+channel*4,true);
  let referenceFirst=0;while(referenceFirst<TOTAL&&expected(referenceFirst,0)===0&&expected(referenceFirst,1)===0)referenceFirst++;
  if(referenceFirst===TOTAL)throw Error('The controlled reference must contain sound');
  for(const quantum of [0,6,17,23,43,45,47,49,50,92,333,511])for(const mode of ['production-engine','integer-division-control']){
    const expectedOrigin=quantum*128+960,offline=new OfflineAudioContext(2,expectedOrigin+TOTAL+8,RATE),starts=[];
    const makeBlock=(startFrame)=>{const buffer=offline.createBuffer(2,BLOCK,RATE);for(let channel=0;channel<2;channel++){
      const output=buffer.getChannelData(channel);for(let at=0;at<BLOCK;at++)output[at]=expected(startFrame*1600+at,channel);
    }return {startFrame,endFrame:startFrame+60,buffer};};
    const blocks=[makeBlock(0),makeBlock(60)],sources=[];
    const createSource=()=>{const source=offline.createBufferSource(),start=source.start;sources.push(source);
      source.start=function(...args){starts.push({when:args[0],offset:args[1],duration:args[2]});return Reflect.apply(start,this,args);};return source;};
    let transport=null;
    if(mode==='production-engine'){
      let state='running';
      const clock={sampleRate:RATE,get currentTime(){return quantum*128/RATE;},get state(){return state;},destination:offline.destination,
        createBufferSource:createSource,addEventListener(){},removeEventListener(){},resume:async()=>{},close:async()=>{state='closed';}};
      transport=createContinuousTimelineAudioTransport({context:clock,plan:{startFrame:0,durationFrames:120,blockFrames:60,sampleRate:RATE,channels:2},
        initialBlock:blocks[0],loadBlock:async(frame)=>{if(frame!==60)throw Error('Unexpected block');return blocks[1];}});
      if(!await transport.play())throw Error('Production graph failed to start');
      await new Promise(resolve=>setTimeout(resolve,0));
    }else{
      for(let at=0;at<2;at++){const source=createSource();source.buffer=blocks[at].buffer;source.connect(offline.destination);source.start((expectedOrigin+at*BLOCK)/RATE,0,2);}
    }
    if(starts.length!==2)throw Error('Both exact adjacent blocks must be scheduled before offline rendering');
    const rendered=await offline.startRendering(),channels=[rendered.getChannelData(0),rendered.getChannelData(1)];
    const observedOrigin=Math.round(starts[0].when*RATE);let firstSignal=null,maximumAbsoluteError=0,mismatchedSamples=0,maximumErrorAtSample=0;
    for(let at=0;at<channels[0].length;at++)if(channels[0][at]!==0||channels[1][at]!==0){firstSignal=at;break;}
    if(firstSignal===null)throw Error('Offline renderer produced no signal');
    const inferredOrigin=firstSignal-referenceFirst;let legacyAlignmentMaximumError=0;
    for(let sample=0;sample<TOTAL;sample++)for(let channel=0;channel<2;channel++){
      const difference=Math.abs(channels[channel][observedOrigin+sample]-expected(sample,channel));
      if(difference>maximumAbsoluteError){maximumAbsoluteError=difference;maximumErrorAtSample=sample;}
      if(difference>2e-6)mismatchedSamples++;
      legacyAlignmentMaximumError=Math.max(legacyAlignmentMaximumError,Math.abs((channels[channel][inferredOrigin+sample]??0)-expected(sample,channel)));
    }
    rows.push({quantum,mode,expectedOrigin,observedOrigin,firstSignal,referenceFirst,inferredOrigin,maximumAbsoluteError,mismatchedSamples,
      maximumErrorAtSample,legacyAlignmentMaximumError,startTimes:starts,firstRenderedSamples:Array.from(channels[0].slice(observedOrigin,observedOrigin+4))});
    if(transport)await transport.dispose();else for(const source of sources){source.onended=null;source.disconnect();source.buffer=null;}
  }
  return {rows,absoluteTolerance:2e-6,renderedCases:rows.length,
    anchoredFailures:rows.filter(row=>row.maximumAbsoluteError>2e-6),
    demonstratedLegacyAlignmentFailures:rows.filter(row=>row.legacyAlignmentMaximumError>2e-6).length};
};`;

export async function runOriginSweep(outputDirectory, referenceFile) {
  const root = path.resolve(outputDirectory); await mkdir(root, {mode: 0o700});
  const prefix = await referencePrefix(referenceFile);
  const bundle = await build({stdin: {contents: browserSource, loader: 'js', resolveDir: repo}, bundle: true,
    platform: 'browser', format: 'iife', target: 'chrome144', write: false, logLevel: 'silent'});
  await writeFile(path.join(root, 'entry.js'), bundle.outputFiles[0].contents, {mode: 0o600});
  await writeFile(path.join(root, 'reference-prefix.f32'), prefix, {mode: 0o600});
  const metadata = {schemaVersion: 1, engineSha256: sha(await readFile(engine)), referencePrefixSha256: sha(prefix),
    referenceFile: referenceFile ? path.resolve(referenceFile) : null,
    scope: 'Controlled actual OfflineAudioContext, production continuous engine versus integer-division control; no physical output or listening claim.'};
  await writeFile(path.join(root, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', {mode: 0o600});
  const main = `const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
    app.setPath('userData',path.join(__dirname,'electron-user-data'));
    app.whenReady().then(async()=>{let window;try{
      window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
      await window.loadURL('data:text/html,<title>Controlled offline audio scheduling sweep</title>');
      await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'entry.js'),'utf8'));
      const result=await window.webContents.executeJavaScript('globalThis.runOriginSweep('+JSON.stringify(fs.readFileSync(path.join(__dirname,'reference-prefix.f32')).toString('base64'))+')');
      const metadata=JSON.parse(fs.readFileSync(path.join(__dirname,'metadata.json'),'utf8'));
      const report={...metadata,versions:process.versions,...result};
      report.status=result.anchoredFailures.length===0&&result.demonstratedLegacyAlignmentFailures>0?'passed':'failed';
      fs.writeFileSync(path.join(__dirname,'report.json'),JSON.stringify(report,null,2)+'\\n',{mode:0o600});
      window.destroy();app.exit(report.status==='passed'?0:1);
    }catch(error){fs.writeFileSync(path.join(__dirname,'failure.txt'),String(error.stack??error),{mode:0o600});window?.destroy();app.exit(1);}});`;
  await writeFile(path.join(root, 'main.cjs'), main, {mode: 0o600});
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'main.cjs')], {cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']});
  const logs = []; let logBytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {if (logBytes < 1024 * 1024) {logs.push(Buffer.from(bytes)); logBytes += bytes.length;}});
  const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  const outcome = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));});
  clearTimeout(timer); await writeFile(path.join(root, 'electron.log'), Buffer.concat(logs), {mode: 0o600});
  assert.equal(outcome.code, 0, `Offline sweep failed; inspect ${root}`);
  const report = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
  assert.equal(report.status, 'passed'); assert.equal(report.anchoredFailures.length, 0); assert.ok(report.demonstratedLegacyAlignmentFailures > 0);
  console.log(JSON.stringify({root, status: report.status, renderedCases: report.renderedCases, anchoredFailures: 0,
    demonstratedLegacyAlignmentFailures: report.demonstratedLegacyAlignmentFailures}));
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Supply a fresh synthetic output directory');
  await runOriginSweep(process.argv[2], process.argv[3]);
}
