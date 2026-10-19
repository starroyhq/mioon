// Synthetic protocol fixture only. This is NOT ComfyUI or an inference runtime.
// Binds one owned literal-loopback ephemeral listener and never contacts a provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {deflateSync} from 'node:zlib';
import {COMFY_NODE_CLASSES} from '../../packages/business/src/comfy/profile.ts';
export const COMFY_FIXTURE_MODEL='synthetic/example.safetensors';
const model=COMFY_FIXTURE_MODEL;
export function createComfyFixturePng(): Buffer {
  const crc=(data: Buffer): number=>{let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;};
  const chunk=(name: string,data: Buffer): Buffer=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,b.length-4)),b.length-4);return b;};
  const h=Buffer.alloc(13);h.writeUInt32BE(512);h.writeUInt32BE(512,4);h[8]=8;h[9]=2;
  // Visible synthetic test card, never a model-generated depiction of a prompt.
  const letters: Record<string, string[]>={M:['10001','11011','10101','10101','10001','10001','10001'],O:['01110','10001','10001','10001','10001','10001','01110'],C:['01111','10000','10000','10000','10000','10000','01111'],K:['10001','10010','10100','11000','10100','10010','10001']};
  const raw=Buffer.alloc((512*3+1)*512);
  for(let y=0;y<512;y++)for(let x=0;x<512;x++){
    let color=(x%64<2||y%64<2)?[43,68,99]:[20,34,55];
    const column=Math.floor((x-118)/12),row=Math.floor((y-214)/12);
    if(column>=0&&column<23&&row>=0&&row<7&&column%6<5&&letters['MOCK'[Math.floor(column/6)]]?.[row]?.[column%6]==='1')color=[244,200,88];
    const at=y*(512*3+1)+1+x*3;raw[at]=color[0];raw[at+1]=color[1];raw[at+2]=color[2];
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const nodeInputs: Record<string, unknown>={CheckpointLoaderSimple:{ckpt_name:[[model]]},EmptyLatentImage:{width:['INT'],height:['INT'],batch_size:['INT']},CLIPTextEncode:{text:['STRING'],clip:['CLIP']},KSampler:{model:['MODEL'],seed:['INT'],steps:['INT'],cfg:['FLOAT'],sampler_name:[['euler']],scheduler:[['normal']],positive:['CONDITIONING'],negative:['CONDITIONING'],latent_image:['LATENT'],denoise:['FLOAT']},VAEDecode:{samples:['LATENT'],vae:['VAE']},SaveImage:{images:['IMAGE'],filename_prefix:['STRING']}};
const nodeOutputs: Record<string, unknown>={CheckpointLoaderSimple:['MODEL','CLIP','VAE'],EmptyLatentImage:['LATENT'],CLIPTextEncode:['CONDITIONING'],KSampler:['LATENT'],VAEDecode:['IMAGE'],SaveImage:['IMAGE']};
export interface FixtureCall {method: string | undefined; path: string; body?: FixtureBody}
export interface FixtureBody {client_id: string; extra_data: Record<string, unknown>; prompt: Record<string, {inputs: {filename_prefix: string}}>; prompt_id: string}
export interface ComfyFixture {baseUrl: string; png: Buffer; calls: FixtureCall[]; errors: string[]; jobs: Map<string, {body: FixtureBody; status: 'pending' | 'completed'}>;
  counts(): {posts: number; jobs: number; views: number; all: number}; complete(id: string): void; close(): Promise<void>}
export interface ComfyFixtureOptions {
  readonly dropAck?: boolean;
  readonly hold?: boolean;
  readonly onCall?: (call: FixtureCall) => void;
}
export async function startComfyFixture({dropAck=false,hold=false,onCall}: ComfyFixtureOptions = {}): Promise<ComfyFixture> {
  const png=createComfyFixturePng(),calls: FixtureCall[]=[],jobs=new Map<string, {body: FixtureBody; status: 'pending' | 'completed'}>(),errors: string[]=[];
  const json=(res: ServerResponse,status: number,value: unknown): void=>{const bytes=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json','Content-Length':String(bytes.length)});res.end(bytes);};
  const server=http.createServer(async(req: IncomingMessage,res: ServerResponse)=>{
    try{
      const url=req.url ?? '';
      const call: FixtureCall={method:req.method,path:url};calls.push(call);
      if(req.method!=='POST')onCall?.(structuredClone(call));
      assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);assert.equal(req.headers['accept-encoding'],'identity');
      if(req.method==='GET'&&url==='/system_stats')return json(res,200,{system:{comfyui_version:'0.39.0',argv:['synthetic-fixture-private-marker']}});
      if(req.method==='GET'&&url.startsWith('/object_info/')){
        const name=url.slice('/object_info/'.length);assert.ok((COMFY_NODE_CLASSES as readonly string[]).includes(name));
        return json(res,200,{[name]:{name,python_module:'nodes',input:{required:nodeInputs[name]},output:nodeOutputs[name],output_node:name==='SaveImage'}});
      }
      if(req.method==='POST'&&url==='/prompt'){
        let length=0;const chunks: Buffer[]=[];for await(const chunk of req as AsyncIterable<Buffer>){length+=chunk.length;assert.ok(length<=36*1024);chunks.push(chunk);}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as FixtureBody;call.body=body;
        assert.deepEqual(Object.keys(body).sort(),['client_id','extra_data','prompt','prompt_id']);assert.equal(jobs.has(body.prompt_id),false,'fixture must never receive a duplicate generation POST');
        jobs.set(body.prompt_id,{body,status:hold?'pending':'completed'});
        onCall?.(structuredClone(call));
        if(dropAck){res.destroy();return;}
        return json(res,200,{prompt_id:body.prompt_id,number:jobs.size-1,node_errors:{}});
      }
      if(req.method==='GET'&&url.startsWith('/api/jobs/')){
        const id=url.slice('/api/jobs/'.length),job=jobs.get(id);
        if(!job)return json(res,404,{error:'Job not found'});
        if(job.status!=='completed')return json(res,200,{id,status:job.status,outputs_count:0,previewable_outputs_count:0});
        const body=job.body,descriptor={filename:`${body.prompt['7'].inputs.filename_prefix}_00001_.png`,subfolder:'',type:'output'};
        return json(res,200,{id,status:'completed',outputs_count:1,previewable_outputs_count:1,
          execution_status:{status_str:'success',completed:true,messages:[['execution_success',{prompt_id:id,timestamp:1001}]]},
          workflow:{prompt:body.prompt,extra_data:{...body.extra_data,client_id:body.client_id,create_time:1000}},outputs:{'7':{images:[descriptor]}}});
      }
      if(req.method==='GET'&&url.startsWith('/view?')){
        const job=[...jobs.values()].find(job=>url===`/view?filename=${job.body.prompt['7'].inputs.filename_prefix}_00001_.png&subfolder=&type=output`);
        assert.ok(job&&job.status==='completed');res.writeHead(200,{'Content-Type':'image/png','Content-Length':String(png.length)});res.write(png.subarray(0,32));res.end(png.subarray(32));return;
      }
      assert.fail(`Unapproved synthetic route: ${req.method} ${req.url}`);
    }catch(error){errors.push(error instanceof Error ? error.message : String(error));if(!res.destroyed)json(res,500,{error:'Synthetic fixture rejected request'});}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const address=server.address(), port=typeof address==='object'&&address?address.port:0;
  return {baseUrl:`http://127.0.0.1:${port}`,png,calls,errors,jobs,
    counts(){return {posts:calls.filter(c=>c.method==='POST').length,jobs:calls.filter(c=>c.path.startsWith('/api/jobs/')).length,views:calls.filter(c=>c.path.startsWith('/view?')).length,all:calls.length};},
    complete(id: string){assert.ok(jobs.has(id));jobs.get(id)!.status='completed';},
    async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
