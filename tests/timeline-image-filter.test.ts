import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {run,runStreaming,checkMediaEffect} from '../packages/business/src/media-runtime.ts';
import {timelineImageDisplayTable,timelineImageFilterGraph,TIMELINE_IMAGE_DISPLAY_PROFILE,TIMELINE_IMAGE_DISPLAY_PROFILE_ID,TIMELINE_IMAGE_RESIZE_PROFILE_ID} from '../packages/business/src/timeline-image-filter.ts';
import {TIMELINE_COLOUR_OUTPUT_FILTER,timelineColourInputFilter} from '../packages/business/src/timeline-colour-lut.ts';

import {createPrivateTemporaryDirectory,validatePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {prepareTimelineImageLayers,TIMELINE_IMAGE_LAYER_LIMITS} from '../packages/business/src/timeline-image-staging.ts';
import {onMediaProcess,waitForMediaProcesses} from '../packages/business/src/media-processes.ts';
import type { BinaryLike } from 'crypto';

const layerRuntime={checkMediaEffect,createPrivateTemporaryDirectory,validatePrivateDirectory,run,waitForMediaProcesses};
const sha=(bytes: NonSharedBuffer|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
// Independent closed-form oracle, not the production table generator.
const display=(code: number)=>code/255<=.04045?Math.pow(code/(255*12.92),1/2.4):(code/255+.055)/1.055;
const look=(value: number[])=>value.map((v: number,c: number)=>[.05,.1,.02][c]+[.9,.8,.96][c]*(v<.5?.5*v:1.5*v-.5));
const cube=()=>['LUT_3D_SIZE 3','DOMAIN_MIN 0 0 0','DOMAIN_MAX 1 1 1',...Array.from({length:27},(_,i)=>look([i%3/2,Math.floor(i/3)%3/2,Math.floor(i/9)/2]).join(' '))].join('\n')+'\n';
function crc(bytes: Buffer<ArrayBuffer>){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let n=0;n<8;n++)value=(value>>>1)^(value&1?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function chunk(type: string,data: string|unknown[]|NonSharedBuffer|Uint8Array<ArrayBufferLike>|undefined=Buffer.alloc(0)){const name=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat((([name,data]) as unknown as Parameters<typeof Buffer.concat>[0]))));return Buffer.concat((([size,name,data,sum]) as unknown as Parameters<typeof Buffer.concat>[0]));}
async function png(root: string,name: string,width: number,height: number,data: Buffer<ArrayBuffer>,channels: number|undefined=4){
 assert.equal(data.length,width*height*channels);const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=channels===4?6:2;
 const rows=Buffer.alloc(height*(width*channels+1));for(let y=0;y<height;y++)Buffer.from(data.subarray(y*width*channels,(y+1)*width*channels)).copy(rows,y*(width*channels+1)+1);
 const file=path.join(root,`${name}.png`);await writeFile(file,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('sRGB',Buffer.from([0])),chunk('IDAT',deflateSync(rows)),chunk('IEND')]));return file;
}
async function fixture(t: test.TestContext){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-image-filter-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const table=path.join(root,"display:[x],quote'back\\slash.cube"),creative=path.join(root,"creative:[x],quote'back\\slash.cube");await writeFile(table,timelineImageDisplayTable().text);await writeFile(creative,cube());return {root,table,creative};
}
let invocations=0;
async function frame(inputs: (string|string[])[],filters: unknown[],format: string,width: number,height: number,output: string|undefined='out'){
 assert.ok(++invocations<=70,'bounded child count');assert.ok(width*height<=65536,'bounded frame size');
 const args=['-hide_banner','-loglevel','error','-nostdin','-filter_complex_threads','1','-filter_threads','1'];
 for(const input of inputs)args.push('-threads','1',...(typeof input==='string'?['-i',input]:input));
 args.push('-filter_complex',filters.join(';'),'-map',`[${output}]`,'-frames:v','1','-an','-threads','1','-c:v','rawvideo','-pix_fmt',format,'-f','rawvideo','pipe:1');
 const chunks: (Buffer<ArrayBuffer>)[]=[],result=await runStreaming('ffmpeg',args,{timeout:12000,maxStdoutBytes:1024*1024,maxStderrBytes:65536,onStdout:chunk=>chunks.push(Buffer.from(chunk))});
 const bytes=Buffer.concat(chunks,result.stdoutBytes),expected=width*height*(format==='gbrapf32le'?16:format==='rgba'?4:format==='yuv420p'?1.5:3);assert.equal(bytes.length,expected);return bytes;
}
const options=(f: Awaited<ReturnType<typeof fixture>>,sw: number,sh: number,width: number|undefined=sw,height: number|undefined=sh,extra: {creativeLutPath?: string;}={})=>({input:'0:v:0',label:'out',sourceWidth:sw,sourceHeight:sh,width,height,displayTablePath:f.table,...extra});
function floatValues(bytes: Buffer<ArrayBuffer>,width: number,height: number){const n=width*height;return Array.from({length:n},(_,p)=>[2,0,1,3].map(c=>bytes.readFloatLE((c*n+p)*4)));}
function converted(data: Buffer,creative: boolean|undefined=false){return Array.from({length:data.length/4},(_,p)=>{let rgb=[0,1,2].map(c=>display(((data[p*4+c]) as unknown as Parameters<typeof display>[0])));if(creative)rgb=look(rgb);return [...rgb,data[p*4+3]/255];});}
function premultiply(values: number[][]){return values.map((value: number[])=>[...value.slice(0,3).map((((v: number)=>v*value[3]) as unknown as (value: unknown, index: number, array: unknown[]) => number)),value[3]]);}
function near(actual: number[],expected: number[],tolerance: number,why: string){assert.equal(actual.length,expected.length);let maximum=0;for(let i=0;i<actual.length;i++)maximum=Math.max(maximum,Math.abs(actual[i]-expected[i]));assert.ok(maximum<=tolerance,`${why}: max ${maximum}, budget ${tolerance}`);return maximum;}
const flatten=(values: number[][])=>values.flat();
function randomPixels(width: number,height: number){let seed=0x4d494f4f;return Buffer.from(Array.from({length:width*height*4},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}));}
// Separable triangle kernel with widened downsample support and reflected
// edge coordinates, independently computed in double precision.
function resize(values: number[][],sw: number,sh: number,width: number,height: number){
 function axis(source: number,target: number){return Array.from({length:target},(_,out)=>{const scale=source/target,centre=(out+.5)*scale-.5,radius=Math.max(1,scale),weights=new Map();let sum=0;
  for(let sample=Math.floor(centre-radius)+1;sample<Math.ceil(centre+radius);sample++){const weight=Math.max(0,1-Math.abs(sample-centre)/radius);let index=((sample%(2*source))+2*source)%(2*source);if(index>=source)index=2*source-1-index;if(weight){weights.set(index,(weights.get(index)||0)+weight);sum+=weight;}}
  return [...weights].map(([index,weight])=>[index,weight/sum]);});}
 const xs=axis(sw,width),ys=axis(sh,height);return Array.from({length:width*height},(_,p)=>{const value=[0,0,0,0];for(const [y,wy] of ys[Math.floor(p/width)])for(const [x,wx] of xs[p%width])for(let c=0;c<4;c++)value[c]+=values[y*sw+x][c]*wy*wx;return value;});
}
// Stop only after an actual production graph stage; no duplicated FFmpeg
// implementation in the test. The complete graph is exercised separately.
function stage(graph: string[],name: string){const index=graph.findIndex((((line: string)=>line.endsWith(`[out_${name}]`)) as unknown as Parameters<typeof graph.findIndex>[0]));assert.ok(index>=0);return [...graph.slice(0,index+1),`[out_${name}]null[out]`];}

test('frozen table is exact trusted canonical bytes and output-referred sRGB, not source709',()=>{
 const table=timelineImageDisplayTable();assert.equal(table.bytes,14738);assert.equal(table.sha256,'383f159aebd6758ead128a3f1291ec70275bbd6bf60aef603e17d2d3726c303c');assert.equal(sha(table.text),table.sha256);assert.ok(Object.isFrozen(table));
 const rows=table.text.trimEnd().split('\n').slice(3).map(line=>line.split(' ').map(Number));assert.equal(rows.length,256);
 for(let code=0;code<256;code++){assert.deepEqual(rows[code],[rows[code][0],rows[code][0],rows[code][0]]);near(rows[code],[display(code),display(code),display(code)],3e-16,`code ${code}`);}
 assert.equal(rows[0][0],0);assert.equal(rows[255][0],1);assert.ok(Math.abs(rows[128][0]-.527924914041446)<1e-15);assert.ok(Math.abs(rows[128][0]-.45228429813739734)>.07);
 assert.equal(TIMELINE_IMAGE_DISPLAY_PROFILE_ID,'srgb8-to-bt1886-zero-black-display-v1');assert.equal(TIMELINE_IMAGE_RESIZE_PROFILE_ID,'png-contain-bilinear-mirror-premultiplied-v1');assert.equal(TIMELINE_IMAGE_DISPLAY_PROFILE.compositing,'encoded-rgb8-premultiplied');
});
test('graph validates finite bounded geometry and internal labels, while paths use filter escaping',()=>{
 const valid={input:'0:0',label:'v0',sourceWidth:7,sourceHeight:5,width:20,height:20,displayTablePath:'/private/table.cube'};
 assert.equal(timelineImageFilterGraph(valid).length,9);assert.match(timelineImageFilterGraph(valid).join(';'),/zscale=w=20:h=14:filter=bilinear/);
 for(const value of ([0,-1,NaN,Infinity,1.5,16385] as const))assert.throws(()=>timelineImageFilterGraph({...valid,width:value}),{code:'INVALID_TIMELINE_COLOUR'});
 for(const patch of ([{input:'0:v];movie=evil[out'},{label:'a;evil'},{sourceWidth:4097},{sourceWidth:4096,sourceHeight:4096},{sourceWidth:1920,sourceHeight:1081},{displayTablePath:'relative.cube'},{creativeLutPath:'/tmp/a\n.cube'}] as const))assert.throws(()=>timelineImageFilterGraph({...valid,...patch}));
 const graph=timelineImageFilterGraph({...valid,sourceWidth:1,sourceHeight:4096,width:3,height:3}).join(';');assert.match(graph,/zscale=w=1:h=3:filter=bilinear/);assert.doesNotMatch(graph,/force_divisible_by|bicubic|transferin=709/);
});
test('a clip transform crop applies to the source before the contain fit',()=>{
 const valid={input:'0:0',label:'v0',sourceWidth:200,sourceHeight:100,width:300,height:300,displayTablePath:'/private/table.cube'};
 const graph=timelineImageFilterGraph({...valid,crop:{x:50,y:0,width:100,height:100}}).join(';');
 assert.match(graph,/format=rgba,crop=100:100:50:0,split/);assert.match(graph,/zscale=w=300:h=300:filter=bilinear/);
 assert.doesNotMatch(timelineImageFilterGraph(valid).join(';'),/crop=/,'an uncropped layer keeps the historical graph');
 for(const crop of [{x:-1,y:0,width:10,height:10},{x:0,y:0,width:0,height:10},{x:150,y:0,width:100,height:100},{x:0,y:1.5,width:10,height:10}])
  assert.throws(()=>timelineImageFilterGraph({...valid,crop}),{code:'INVALID_TIMELINE_COLOUR'},JSON.stringify(crop));
});
test('actual PNG production conversion covers all256 RGB and alpha codes without scaling',{timeout:30000},async t=>{
 const f=await fixture(t),data=Buffer.from(Array.from({length:256},(_,i)=>[i,(i*73)%256,255-i,i]).flat()),file=await png(f.root,'ramp',256,1,data),graph=timelineImageFilterGraph(options(f,256,1));
 const straight=floatValues(await frame([file],stage(graph,'straight'),'gbrapf32le',256,1),256,1);near(flatten(straight),flatten(converted(data)),1.5e-7,'all256 float straight RGB and alpha');
 const output=await frame([file],graph,'rgba',256,1);for(let p=0;p<256;p++){assert.equal(output[p*4+3],data[p*4+3],`alpha ${p}`);for(let c=0;c<3;c++)near([output[p*4+c]],[display(data[p*4+c])*data[p*4+3]],1,'premultiplied byte');}
 const rgb=Buffer.from(Array.from({length:256},(_,i)=>[i,(i*73)%256,255-i]).flat()),rgbFile=await png(f.root,'rgb-ramp',256,1,rgb,3),opaque=await frame([rgbFile],graph,'rgba',256,1);
 for(let p=0;p<256;p++){assert.equal(opaque[p*4+3],255);for(let c=0;c<3;c++)near([opaque[p*4+c]],[display(rgb[p*3+c])*255],1,'opaque RGB transfer');}
});
test('narrow and odd plane boundaries preserve straight RGB, alpha and final RGBA8',{timeout:90000},async t=>{
 const f=await fixture(t);for(const [w,h] of ([[1,1],[1,17],[17,1],[3,5],[33,17]] as const)){
  const data=randomPixels(w,h),file=await png(f.root,`odd-${w}-${h}`,w,h,data);
  // Use identical dimensions, including the one-pixel case, to prove no hidden scaler.
  const normal=timelineImageFilterGraph(options(f,w,h)),actual=floatValues(await frame([file],stage(normal,'straight'),'gbrapf32le',w,h),w,h);near(flatten(actual),flatten(converted(data)),1.5e-7,`${w}x${h} straight`);
  const bytes=await frame([file],normal,'rgba',w,h);for(let p=0;p<w*h;p++)assert.equal(bytes[p*4+3],data[p*4+3]);
 }
});
test('nonidentity creative look is after display conversion on straight RGB and never alpha',{timeout:30000},async t=>{
 const f=await fixture(t),data=randomPixels(7,5);for(let p=0;p<35;p+=7)data[p*4+3]=0;
 const file=await png(f.root,'look',7,5,data),graph=timelineImageFilterGraph(options(f,7,5,14,10,{creativeLutPath:f.creative}));
 const straight=floatValues(await frame([file],stage(graph,'straight'),'gbrapf32le',7,5),7,5);near(flatten(straight),flatten(converted(data,true)),2e-7,'creative order');
 const scaled=floatValues(await frame([file],stage(graph,'scaled'),'gbrapf32le',14,10),14,10),expected=resize(((premultiply(converted(data,true))) as unknown as Parameters<typeof resize>[0]),7,5,14,10);near(flatten(scaled),flatten(expected),4e-7,'premultiply after look then resize');
 const reverse=look([display(data[4]),display(data[5]),display(data[6])].map(v=>v*data[7]/255));assert.ok(reverse.some((((value: number,c: number)=>Math.abs(value-converted(data,true)[1][c]*data[7]/255)>.01) as unknown as Parameters<typeof reverse.some>[0])));
});
test('production resize matches mirrored bilinear oracle up/down, odd and 65536 pixel bound',{timeout:90000},async t=>{
 const f=await fixture(t);for(const [sw,sh,w,h] of ([[4,2,8,4],[7,5,3,2],[1,5,3,15],[17,9,5,2],[16,16,256,256]] as const)){
  const data=randomPixels(sw,sh),file=await png(f.root,`resize-${sw}-${sh}-${w}-${h}`,sw,sh,data),graph=timelineImageFilterGraph(options(f,sw,sh,w,h,{creativeLutPath:f.creative}));
  const fw=w*sh<=h*sw?w:Math.max(1,Math.floor(sw*h/sh)),fh=w*sh<=h*sw?Math.max(1,Math.floor(sh*w/sw)):h;
  const actual=floatValues(await frame([file],stage(graph,'scaled'),'gbrapf32le',fw,fh),fw,fh),expected=resize(((premultiply(converted(data,true))) as unknown as Parameters<typeof resize>[0]),sw,sh,fw,fh);near(flatten(actual),flatten(expected),4e-7,`${sw}x${sh} to ${fw}x${fh}`);
 }
});
test('hidden RGB is invariant after look/resize and contain padding remains transparent',{timeout:30000},async t=>{
 const f=await fixture(t),a=Buffer.from([255,0,255,0,64,128,192,128,255,255,255,255,0,64,255,1,20,150,240,64,250,40,180,192,128,128,128,255,255,0,0,0]),b=Buffer.from(a);
 for(let p=0;p<8;p++)if(a[p*4+3]===0){b[p*4]=0;b[p*4+1]=255;b[p*4+2]=0;}
 const paths=await Promise.all([png(f.root,'hidden-a',4,2,a),png(f.root,'hidden-b',4,2,b)]),graph=timelineImageFilterGraph(options(f,4,2,8,8,{creativeLutPath:f.creative}));
 const results=await Promise.all(paths.map(file=>frame([file],graph,'rgba',8,8)));assert.deepEqual(results[0],results[1]);
 for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(y<2||y>=6)assert.deepEqual([...results[0].subarray((y*8+x)*4,(y*8+x+1)*4)],[0,0,0,0]);
});
test('one/two encoded RGB8 premultiplied overlays match independent composition oracle',{timeout:30000},async t=>{
 const f=await fixture(t),data=randomPixels(4,2),file=await png(f.root,'layer',4,2,data),background=Buffer.from(Array.from({length:32},()=>[51,102,153]).flat()),bg=await png(f.root,'background',8,4,background,3);
 const base=timelineImageFilterGraph(options(f,4,2,8,4)),expected=resize(((premultiply(converted(data))) as unknown as Parameters<typeof resize>[0]),4,2,8,4);
 const one=await frame([file,bg],[...base,'[1:v]format=rgba[bg]','[bg][out]overlay=format=rgb:alpha=premultiplied:shortest=1[one]'],'rgba',8,4,'one');
 const two=await frame([file,bg],[...base,'[out]split[a][b]','[1:v]format=rgba[bg]','[bg][a]overlay=format=rgb:alpha=premultiplied:shortest=1[first]','[first][b]overlay=format=rgb:alpha=premultiplied:shortest=1[two]'],'rgba',8,4,'two');
 for(let p=0;p<32;p++)for(let c=0;c<3;c++){const first=expected[p][c]*255+[51,102,153][c]*(1-expected[p][3]),second=expected[p][c]*255+first*(1-expected[p][3]);near([one[p*4+c]],[first],2,'single overlay');near([two[p*4+c]],[second],3,'double overlay');}
});
test('mixed known BT709 limited video background and PNG keep explicit limited YUV420 output mapping',{timeout:30000},async t=>{
 const f=await fixture(t),w=8,h=4,n=w*h,data=Buffer.from(Array.from({length:n},()=>[128,64,192,128]).flat()),file=await png(f.root,'mixed',w,h,data),yuv=path.join(f.root,'background.yuv');await writeFile(yuv,Buffer.concat([Buffer.alloc(n,80),Buffer.alloc(n/4,110),Buffer.alloc(n/4,150)]));
 const inputs=[file,['-f','rawvideo','-pixel_format','yuv420p','-video_size',`${w}x${h}`,'-i',yuv]],base=timelineImageFilterGraph(options(f,w,h)),filters=[...base,`[1:v]${timelineColourInputFilter('limited')},format=rgba[bg]`,'[bg][out]overlay=format=rgb:alpha=premultiplied:shortest=1[composed]'];
 const actual=await frame(inputs,filters,'rgba',w,h,'composed'),output=await frame(inputs,[...filters,`[composed]${TIMELINE_COLOUR_OUTPUT_FILTER}[final]`],'yuv420p',w,h,'final');
 const y=(80-16)/219,cb=(110-128)/224,cr=(150-128)/224,bg=[y+1.5748*cr,y-(.0722*1.8556/.7152)*cb-(.2126*1.5748/.7152)*cr,y+1.8556*cb],a=128/255,rgb=[128,64,192].map((code,c)=>display(code)*a+bg[c]*(1-a));
 for(let p=0;p<n;p++)near([...actual.subarray(p*4,p*4+3)],rgb.map(v=>v*255),2,'mixed composition');
 // The integer compositor is intentional. Use its measured byte boundary to
 // isolate the final full RGB -> limited BT709 YUV matrix/range mapping.
 const [r,g,b]=[...actual.subarray(0,3)].map(v=>v/255),luma=.2126*r+.7152*g+.0722*b,expected=[16+219*luma,128+224*(b-luma)/1.8556,128+224*(r-luma)/1.5748];
 for(let p=0;p<n;p++)near([output[p]],[expected[0]],.501,'limited Y');for(let p=0;p<n/4;p++){near([output[n+p]],[expected[1]],.501,'limited U');near([output[n+n/4+p]],[expected[2]],.501,'limited V');}
});

async function layerInput(f: Awaited<ReturnType<typeof fixture>>,name: string|undefined='source'){
 const data=randomPixels(7,5),file=await png(f.root,name,7,5,data);
 return {data,input:{clipId:name,assetSha256:sha(await readFile(file)),sourcePath:file,sourceWidth:7,sourceHeight:5,width:14,height:14,creativeLutPath:f.creative,lookCacheKey:JSON.stringify({resource:'fixture',profile:'mioon-cube3d-normalized-tetrahedral-v1',strength:1,sha256:sha(cube())})}};
}
test('owned static layer derives once, binds exact look identity and decodes byte-identically to direct graph',{timeout:30000},async t=>{
 const f=await fixture(t),{input}=await layerInput(f);let calls=0;
 const runtime={...layerRuntime,run:async(...args: unknown[])=>{calls++;return run(...(args as Parameters<typeof run>));}},stage=await prepareTimelineImageLayers([input,{...input,clipId:'reuse'},{...input,clipId:'other-binding',lookCacheKey:'different-strength-binding'}],path.join(f.root,'result.mp4'),{},runtime);
 try{
  assert.equal(calls,2);assert.equal(stage.path(input.clipId),stage.path('reuse'));assert.notEqual(stage.path(input.clipId),stage.path('other-binding'));assert.equal(stage.totalPixels,2*14*14);assert.ok(stage.totalBytes>14738);stage.effect();stage.verifyBytes();
  const direct=await frame([input.sourcePath],timelineImageFilterGraph(options(f,7,5,14,14,{creativeLutPath:f.creative})),'rgba',14,14);
  const decoded=await frame([stage.path(input.clipId)!],['[0:v]format=rgba[out]'],'rgba',14,14);assert.deepEqual(decoded,direct,'internal PNG must retain already-premultiplied encoded RGBA bytes exactly');
  for(let y=0;y<2;y++)for(let x=0;x<14;x++)assert.deepEqual([...decoded.subarray((y*14+x)*4,(y*14+x+1)*4)],[0,0,0,0]);
 }finally{assert.equal(stage.cleanup(),true);}
 assert.equal((await readdir(f.root)).some(name=>name.startsWith('.timeline-render-')),false);
});
test('owned layer rejects hash tampering and preserves unknown replacement files',{timeout:30000},async t=>{
 const f=await fixture(t),{input}=await layerInput(f),stage=await prepareTimelineImageLayers([input],path.join(f.root,'result.mp4'),{},layerRuntime),file=stage.path(input.clipId),original=await readFile(((file) as unknown as Parameters<NonNullable<typeof readFile>>[0]));
 await writeFile(((file) as unknown as Parameters<typeof writeFile>[0]),Buffer.alloc(original.length,32));assert.throws(()=>stage.verifyBytes(),{code:'TIMELINE_COLOUR_RESOURCE_CHANGED'});await writeFile(((file) as unknown as Parameters<typeof writeFile>[0]),original);stage.verifyBytes();
 const renamed=path.join(path.dirname(((file) as unknown as Parameters<typeof path.dirname>[0])),'unknown-renamed.png');await rename(((file) as unknown as Parameters<typeof rename>[0]),renamed);await writeFile(((file) as unknown as Parameters<typeof writeFile>[0]),'replacement',{mode:0o600});
 assert.throws(()=>stage.effect(),{code:'INVALID_TIMELINE_SNAPSHOT'});assert.equal(stage.cleanup(),false);assert.equal(await readFile(((file) as unknown as Parameters<NonNullable<typeof readFile>>[0]),'utf8'),'replacement');assert.deepEqual(await readFile(renamed),original);
});
test('layer admission binds source hash, look identity and source/output budgets before derivation',async t=>{
 const f=await fixture(t),{input}=await layerInput(f);let children=0;const runtime={...layerRuntime,run:async()=>{children++;throw Error('unexpected child');}};
 for(const patch of ([{assetSha256:'0'.repeat(64)},{sourceWidth:1920,sourceHeight:1081},{width:1920,height:1081},{lookCacheKey:null},{creativeLutPath:undefined},{sourcePath:'relative.png'}] as const))await assert.rejects(prepareTimelineImageLayers([{...input,...patch}],path.join(f.root,'out.mp4'),{},runtime));
 await assert.rejects(prepareTimelineImageLayers(Array.from({length:101},(_,i)=>({...input,clipId:`clip-${i}`})),path.join(f.root,'out.mp4'),{},runtime),{code:'TIMELINE_COLOUR_LUT_BUDGET'});
 assert.equal(TIMELINE_IMAGE_LAYER_LIMITS.sourcePixels,2073600);assert.equal(children,0);assert.equal((await readdir(f.root)).some(name=>name.startsWith('.timeline-render-')),false);
});
test('cancelled layer derivation joins its exact FFmpeg child and removes owned partial staging',{timeout:30000},async t=>{
 const f=await fixture(t),{input}=await layerInput(f),controller=new AbortController(),events: (import("../packages/business/src/media-processes.ts").MediaProcessEvent)[]=[],before=(await readdir(f.root)).sort();
 const stop=onMediaProcess(event=>{events.push(((event) as unknown as Parameters<typeof events.push>[0]));if(event.type==='started'&&event.kind==='ffmpeg')controller.abort();});
 try{await assert.rejects(prepareTimelineImageLayers([input],path.join(f.root,'cancelled.mp4'),{signal:controller.signal},layerRuntime),{code:'MEDIA_CANCELLED'});}finally{stop();}
 assert.equal(events.filter(event=>event.type==='started').length,1);assert.equal(events.filter(event=>event.type==='exited').length,1);assert.deepEqual((await readdir(f.root)).sort(),before);assert.equal(sha(await readFile(input.sourcePath)),input.assetSha256);
});
test('unconfirmed failed derivation retains its exact owned staging until runtime confirms the join',async t=>{
 const f=await fixture(t),{input}=await layerInput(f);let release!:()=>void,waits=0;
 const joined=new Promise<void>(resolve=>{release=resolve;}),runtime={...layerRuntime,run:async()=>{throw Object.assign(Error('owned child not yet confirmed'),{terminationUnconfirmed:true});},waitForMediaProcesses:()=>{waits++;return joined;}};
 await assert.rejects(prepareTimelineImageLayers([input],path.join(f.root,'uncertain.mp4'),{},runtime),{terminationUnconfirmed:true});
 const directory=(await readdir(f.root)).find(name=>name.startsWith('.timeline-render-'));assert.ok(directory);assert.equal(waits,1);assert.equal((await readdir(path.join(f.root,directory))).length,2);
 (release)!();await new Promise(resolve=>setTimeout(resolve,10));assert.equal((await readdir(f.root)).some(name=>name.startsWith('.timeline-render-')),false);
});
test('a FIFO source replacement rejects without blocking file open',{timeout:6000},async t=>{
 const f=await fixture(t),fifo=path.join(f.root,'fifo.png'),made=spawnSync('mkfifo',[fifo],{timeout:1000,encoding:'utf8'});
 if((made.error as Error & {code?:string}|undefined)?.code==='ENOENT'){t.skip('mkfifo is unavailable');return;}assert.equal(made.status,0,made.stderr);
 const staging=new URL('../packages/business/src/timeline-image-staging.ts',import.meta.url).href,storage=new URL('../packages/contracts/src/private-storage.ts',import.meta.url).href,runtime=new URL('../packages/business/src/media-runtime.ts',import.meta.url).href;
 const code=`import {prepareTimelineImageLayers} from ${JSON.stringify(staging)};import {createPrivateTemporaryDirectory,validatePrivateDirectory} from ${JSON.stringify(storage)};import {checkMediaEffect} from ${JSON.stringify(runtime)};try {await prepareTimelineImageLayers([{clipId:'fifo',assetSha256:'${'0'.repeat(64)}',sourcePath:${JSON.stringify(fifo)},sourceWidth:1,sourceHeight:1,width:1,height:1}],${JSON.stringify(path.join(f.root,'out.mp4'))},{},{createPrivateTemporaryDirectory,validatePrivateDirectory,checkMediaEffect,run:async()=>{throw Error('must not spawn');},waitForMediaProcesses:async()=>{}});process.exitCode=2;}catch(error){if(error.code!=='TIMELINE_COLOUR_RESOURCE_CHANGED')throw error;}`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{timeout:3000,maxBuffer:65536,encoding:'utf8'});assert.equal(child.error,undefined,'nonblocking open must finish before bounded child timeout');assert.equal(child.status,0,child.stderr);
 assert.equal((await readdir(f.root)).some(name=>name.startsWith('.timeline-render-')),false);
});
