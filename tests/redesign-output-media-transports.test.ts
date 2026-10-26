import type {ServiceResponse} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {stitch} from '../packages/business/src/media.ts';

const exec=promisify(execFile),repo=fileURLToPath(new URL('..',import.meta.url));
const token='synthetic-local-redesign-output-test';
function png(){
  const chunk=(name: string,data: Buffer)=>{const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;
    for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([head,body,tail]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(16);header.writeUInt32BE(16,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc(16*49,90);for(let row=0;row<16;row++)rows[row*49]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
test('three 1080 presets cross HTTP/CLI/MCP and produce native/downscaled/preview/sample MP4s at 30fps', {timeout:240000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'mioon-redesign-output-'));
  const backend=await startServer({dataDir:path.join(root,'workspace'),port:0,token,chatGateway:async function*(){throw Error('No external model calls');}});
  const mcp=new Client({name:'redesign-output-acceptance',version:'1.0.0'},{capabilities:{}});
  const env={...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_BASE_URL:backend.url,MIOON_TOKEN:token};
  t.after(async()=>{await mcp.close();await backend.close();await rm(root,{recursive:true,force:true});});
  await mcp.connect(new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env,stderr:'ignore'}));
  const http=async<O extends string>(operation: O,input: Record<string, unknown>): Promise<ServiceResponse<O>>=>{const response=await fetch(backend.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input})});const body=await response.json();assert.equal(body.ok,true,JSON.stringify(body));return body.data;};
  const cli=async<O extends string>(operation: O,input: Record<string, unknown>): Promise<ServiceResponse<O>>=>{const result=await exec(process.execPath,['apps/cli/src/index.ts',...operation.split('.'),'--input',JSON.stringify(input)],{cwd:repo,env,timeout:35000});const body=JSON.parse(result.stdout);assert.equal(body.ok,true);return body.data;};
  const tool=async<O extends string>(operation: O,input: Record<string, unknown>): Promise<ServiceResponse<O>>=>{const result=await mcp.callTool({name:operation.replaceAll('.','_'),arguments:input},undefined,{timeout:35000});const body=JSON.parse((result.content as {type: string; text: string}[]).find((item: { type: string; })=>item.type==='text')!.text);assert.equal(body.ok,true,JSON.stringify(body));return body.data;};
  const finish=async(id: unknown)=>{const end=Date.now()+60000;while(Date.now()<end){const result=await http('export.get',{exportId:id});if(result.status==='failed')assert.fail(JSON.stringify(result.error));if(result.status==='succeeded')return result;await new Promise(resolve=>setTimeout(resolve,30));}assert.fail('Local render timed out');};
  let firstFile;
  const verify=async(render: { id: unknown; },width: number,height: number,frames: number|undefined=3)=>{
    const completed=await finish(render.id),response=await fetch(backend.url+completed.url,{headers:{authorization:'Bearer '+token}});assert.equal(response.status,200);
    const file=path.join(root,completed.id+'.mp4');await writeFile(file,Buffer.from(await response.arrayBuffer()));
    const result=await exec('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',file],{timeout:20000});
    const probe=JSON.parse(result.stdout),video=probe.streams.find((stream: { codec_type: string; })=>stream.codec_type==='video');
    assert.deepEqual([video.width,video.height,video.r_frame_rate,Number(video.nb_read_frames)],[width,height,'30/1',frames]);
    assert.ok(Math.abs(Number(probe.format.duration)-frames/30)<0.06);
    firstFile??=file;return completed;
  };
  const cases=[['portrait_1080',1080,1920,http],['landscape_1080',1920,1080,cli],['square_1080',1080,1080,tool]] as const;
  for(const [presetId,width,height,call] of cases){
    const project=await http('project.create',{name:presetId});
    const empty=await http('timeline.format.get',{projectId:project.id});assert.equal(empty.presetId,'portrait_1080');assert.equal(empty.timelineId,null);
    let timeline=await call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId});
    assert.deepEqual([timeline.width,timeline.height],[width,height]);
    const source=await http('asset.import',{projectId:project.id,name:'synthetic.png',mimeType:'image/png',dataBase64:png().toString('base64')});
    timeline=await http('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks[0].id,assetId:source.id,startFrame:0,durationFrames:3});
    assert.deepEqual(timeline.clips[0].rect,{x:0,y:0,width,height});
    for(const resolution of ['native','short_720','short_360']){
      const exportSettings={profileId:'mp4_h264_v1',resolution,rateControl:{mode:'crf',quality:'standard'}};
      const preflight=await http('timeline.export.preflight',{projectId:project.id,expectedRevision:timeline.revision,exportSettings});assert.equal(preflight.status,'ready');assert.equal(preflight.summary!.width,width);
      const render=await call('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings});
      const scale=resolution==='native'?1:Number(resolution.slice(6))/1080;
      await verify(render,width*scale,height*scale);
    }
    await verify(await http('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'preview'}),width,height);
    await verify(await http('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportRange:{startFrame:0,endFrame:2}}),width,height,2);
  }
  const output=path.join(root,'storyboard.mp4');await stitch([firstFile!],output);
  const probe=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-of','json',output],{timeout:20000})).stdout);
  const video=probe.streams.find((stream: { codec_type: string; })=>stream.codec_type==='video');assert.deepEqual([video.width,video.height,video.r_frame_rate],[1080,1920,'30/1']);
});
