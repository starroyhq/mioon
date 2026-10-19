import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runStreaming,run,checkMediaEffect} from '../packages/business/src/media-runtime.ts';
import {waitForMediaProcesses} from '../packages/business/src/media-processes.ts';
import {createPrivateTemporaryDirectory,validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {JFIF_INPUT_ARGS,JFIF_RGB24_FILTER,validateJfifDecode} from '../packages/business/src/timeline-jpeg-decode.ts';
import {timelineImageDisplayTable} from '../packages/business/src/timeline-image-filter.ts';
import {prepareTimelineImageLayers} from '../packages/business/src/timeline-image-staging.ts';
import {inspectStaticSrgbJfif} from '../packages/business/src/timeline-jpeg-admission.ts';
import {pillowJfifFixture} from './helpers/timeline-jpeg-fixtures.ts';
import {jpegEvidenceOnly} from './helpers/timeline-jpeg-workflow-fixtures.ts';
const sha=(bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const expected=(code: number): number =>{const s=code/255;return (s<=.04045?s/12.92:((s+.055)/1.055)**2.4)**(1/2.4);};
async function fixture(t: import('node:test').TestContext, sampling: '444' | '422' | '420'){const root=await mkdtemp(path.join(tmpdir(),'mioon-jfif-decode-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'source.jpg'),bytes=pillowJfifFixture(sampling);await writeFile(file,bytes);return{root,file,bytes};}
async function raw(args: string[], max: number): Promise<Buffer> {const chunks: Uint8Array[] = [];await runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-threads','1','-filter_threads','1',...args],{timeout:12000,maxStdoutBytes:max,maxStderrBytes:65536,onStdout:(chunk: Uint8Array)=>chunks.push(Buffer.from(chunk))});return Buffer.concat(chunks);}
const decodeArgs=(file: string, filter: string = JFIF_RGB24_FILTER, pix = 'rgb24'): string[] =>[...JFIF_INPUT_ARGS,'-noautorotate','-i',file,'-vf',filter,'-frames:v','1','-an','-threads','1','-c:v','rawvideo','-pix_fmt',pix,'-f','rawvideo','pipe:1'];
for(const sampling of (['444','422','420'] as const))test(`strict ${sampling} decoder and transfer use actual RGB24, not lossy pre-encode pixels`,async t=>{
 const f=await fixture(t,sampling);await validateJfifDecode(f.file,{width:17,height:13},{beforeEffect:()=>{}},{runStreaming});
 const rgb=await raw(decodeArgs(f.file),17*13*3);assert.equal(rgb.length,17*13*3);
 let lossMax=0,lossSum=0;for(let y=0;y<13;y++)for(let x=0;x<17;x++){const original=[(x*31+y*7)%256,(x*13+y*43)%256,(x*53+y*17)%256];for(let c=0;c<3;c++){const delta=Math.abs(rgb[(y*17+x)*3+c]-original[c]);lossMax=Math.max(lossMax,delta);lossSum+=delta;}}
 t.diagnostic(`decoded RGB24 SHA256 ${sha(rgb)}; JPEG loss max=${lossMax}, mean=${lossSum/rgb.length}`);assert.ok(lossMax>0);
 const table=timelineImageDisplayTable(),tableFile=path.join(f.root,'display.cube');await writeFile(tableFile,table.text);
 const float=await raw(decodeArgs(f.file,`${JFIF_RGB24_FILTER},format=gbrp,zscale=matrixin=gbr:matrix=gbr:rangein=full:range=full:dither=none,format=gbrpf32le,copy,lut1d=file='${tableFile}':interp=linear`,'gbrpf32le'),17*13*12);
 let maximum=0;const n=17*13;for(let i=0;i<n;i++)for(let channel=0;channel<3;channel++){const plane=[2,0,1][channel];maximum=Math.max(maximum,Math.abs(float.readFloatLE((plane*n+i)*4)-expected(rgb[i*3+channel])));}
 assert.ok(maximum<1.5e-7,`transfer-only error ${maximum}`);
 const evidence=jpegEvidenceOnly(await inspectStaticSrgbJfif(f.bytes));const stage=await prepareTimelineImageLayers([{clipId:'jpeg',assetSha256:String(evidence.sha256),sourcePath:f.file,sourceWidth:17,sourceHeight:13,width:17,height:13,jpegEvidence:evidence as never}],path.join(f.root,'output.mp4'),{}, {run,waitForMediaProcesses,checkMediaEffect,createPrivateTemporaryDirectory,validatePrivateDirectory});
 const staged=stage.path('jpeg');assert.ok(staged);
 try{const out=await raw(['-i',staged,'-frames:v','1','-an','-threads','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'],17*13*4);for(let i=0;i<n;i++){assert.equal(out[i*4+3],255);for(let c=0;c<3;c++)assert.ok(Math.abs(out[i*4+c]-255*expected(rgb[i*3+c]))<=1,`staged ${sampling} sample ${i}/${c}`);}stage.verifyBytes();}finally{stage.cleanup();}
 assert.equal((await readdir(f.root)).some(name=>name.startsWith('.timeline-render-')),false);
});
test('444 fixed matrix is independent full-range BT.601, not video BT.709',async t=>{
 const f=await fixture(t,'444'),n=17*13;
 const yuv=await raw([...JFIF_INPUT_ARGS,'-noautorotate','-i',f.file,'-frames:v','1','-an','-threads','1','-c:v','rawvideo','-pix_fmt','yuvj444p','-f','rawvideo','pipe:1'],n*3);
 const rgb=await raw(decodeArgs(f.file),n*3),wrong=await raw(decodeArgs(f.file,JFIF_RGB24_FILTER.replace('in_color_matrix=bt601','in_color_matrix=bt709')),n*3);
 let max=0,wrongDifference=0;for(let i=0;i<n;i++){const y=yuv[i],cb=yuv[n+i]-128,cr=yuv[2*n+i]-128;const channels=[y+1.402*cr,y-.344136*cb-.714136*cr,y+1.772*cb];for(let c=0;c<3;c++){max=Math.max(max,Math.abs(rgb[i*3+c]-Math.max(0,Math.min(255,channels[c]))));wrongDifference=Math.max(wrongDifference,Math.abs(rgb[i*3+c]-wrong[i*3+c]));}}
 assert.ok(max<=2,`independent matrix error ${max}`);assert.ok(wrongDifference>=10,`wrong709 difference ${wrongDifference}`);
});
test('strict JPEG decoder requires full bounded pixel output and preserves cancellation',async t=>{
 const f=await fixture(t,'420');let args: string[] | undefined;
 await assert.rejects(validateJfifDecode(f.file,{width:17,height:13},{beforeEffect:()=>{}},{runStreaming:async(_command,argv,options)=>{args=argv;options.onStdout(new Uint8Array(1));}}),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
 for(const value of ['-xerror','-noautorotate','-max_pixels','-idct','-ec']) { assert.ok(args); assert.ok(args.includes(value)); }
 const controller=new AbortController();controller.abort();await assert.rejects(validateJfifDecode(f.file,{width:17,height:13},{signal:controller.signal,beforeEffect:()=>controller.signal.throwIfAborted()},{runStreaming}));
});
