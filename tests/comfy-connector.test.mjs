import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {deflateSync} from 'node:zlib';
import {createComfyConnector} from '../packages/business/src/comfy/connector.mjs';
import {buildComfyWorkflow, hashComfyWorkflow, comfyCorrelationMarker} from '../packages/business/src/comfy/workflow.mjs';
import {COMFY_NODE_CLASSES} from '../packages/business/src/comfy/profile.mjs';
import {COMFY_IMAGE_OPTIONS} from '../packages/contracts/src/comfy-images.mjs';

const baseUrl='http://127.0.0.1:8188', model='sd15/example.safetensors';
const config={enabled:true,providerId:'comfy-local',connectionId:'comfy-local',profileId:'comfy-t2i-png-v1',baseUrl,model,options:COMFY_IMAGE_OPTIONS,comfyVersion:'0.39.0'};
function execution(){
  const e={workflowId:'comfy-t2i-png-v1',workflowVersion:1,comfyVersion:'0.39.0',seed:99,promptId:'11111111-1111-4111-8111-111111111111',clientId:'22222222-2222-4222-8222-222222222222',outputNonce:'33333333-3333-4333-8333-333333333333'};
  e.filenamePrefix=`mioon_${e.outputNonce}`;e.graph=buildComfyWorkflow({prompt:' The fox\n月亮 ',checkpoint:model,seed:e.seed,outputNonce:e.outputNonce});e.graphHash=hashComfyWorkflow(e.graph);return e;
}
function completeJob(e=execution()){
  return {id:e.promptId,status:'completed',outputs_count:1,previewable_outputs_count:1,workflow:{prompt:structuredClone(e.graph),extra_data:{client_id:e.clientId,create_time:1000,mioon:comfyCorrelationMarker(e)}},execution_status:{status_str:'success',completed:true,messages:[['execution_start',{prompt_id:e.promptId,timestamp:1000}],['execution_success',{prompt_id:e.promptId,timestamp:1001}]]},outputs:{'7':{images:[{filename:`${e.filenamePrefix}_00001_.png`,subfolder:'',type:'output'}]}}};
}
const fields={CheckpointLoaderSimple:{ckpt_name:[[model]]},EmptyLatentImage:{width:['INT'],height:['INT'],batch_size:['INT']},CLIPTextEncode:{text:['STRING'],clip:['CLIP']},KSampler:{model:['MODEL'],seed:['INT'],steps:['INT'],cfg:['FLOAT'],sampler_name:[['euler']],scheduler:[['normal']],positive:['CONDITIONING'],negative:['CONDITIONING'],latent_image:['LATENT'],denoise:['FLOAT']},VAEDecode:{samples:['LATENT'],vae:['VAE']},SaveImage:{images:['IMAGE'],filename_prefix:['STRING']}};
const outputs={CheckpointLoaderSimple:['MODEL','CLIP','VAE'],EmptyLatentImage:['LATENT'],CLIPTextEncode:['CONDITIONING'],KSampler:['LATENT'],VAEDecode:['IMAGE'],SaveImage:['IMAGE']};
function nodeInfo(name){return {[name]:{name,python_module:'nodes',output_node:name==='SaveImage',input:{required:structuredClone(fields[name])},output:outputs[name]}};}
function syntheticPng(edge=512){
  const crc=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;};
  const chunk=(name,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,b.length-4)),b.length-4);return b;};
  const h=Buffer.alloc(13);h.writeUInt32BE(edge);h.writeUInt32BE(edge,4);h[8]=8;h[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc((edge*3+1)*edge))),chunk('IEND',Buffer.alloc(0))]);
}
function backend(handler,{limits}={}){
  const calls=[];let destroyed=0;
  const httpRequest=(options,callback)=>{
    const req=new EventEmitter(),socket=new EventEmitter();
    Object.assign(socket,{remoteAddress:options.hostname,remotePort:options.port,destroy(){destroyed++;}});req.socket=socket;req.destroy=()=>{destroyed++;};
    req.end=body=>{
      const call={method:options.method,path:options.path,body:body===undefined?undefined:JSON.parse(body)};calls.push(call);
      const result=handler(call,calls.length);
      if(result===null)return;
      const {data={},status=200,type='application/json',headers={},complete=true,chunks}=result??{};
      const incoming=Readable.from(chunks??[Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data))]);
      Object.assign(incoming,{socket,statusCode:status,complete,headers:{'content-type':type,...headers}});callback(incoming);
    };
    queueMicrotask(()=>{req.emit('socket',socket);socket.emit('connect');});return req;
  };
  return {calls,get destroyed(){return destroyed;},connector:createComfyConnector({networkDeps:{httpRequest},reservedPorts:()=>[4318],limits})};
}
test('explicit check reads only version and six known classes, returns bounded checkpoint names without host details',async()=>{
  const b=backend(({path})=>({data:path==='/system_stats'?{system:{comfyui_version:'0.39.0',argv:['--private-path'],ram_total:123}}:nodeInfo(path.split('/').at(-1))}));
  const result=await b.connector.check({config:{baseUrl,model:''}});
  assert.deepEqual(result,{ok:true,baseUrl,comfyVersion:'0.39.0',checkpoints:[model],selectedCheckpointAvailable:false,nodeClasses:[...COMFY_NODE_CLASSES]});
  assert.deepEqual(b.calls.map(c=>c.path),['/system_stats',...COMFY_NODE_CLASSES.map(n=>`/object_info/${n}`)]);assert.ok(b.calls.every(c=>c.method==='GET'&&c.body===undefined));
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('check rejects wrong/missing version, missing/custom/partner nodes, unsafe checkpoints and unsupported sampler',async()=>{
  for(const mutation of [
    (path,data)=>{if(path==='/system_stats')data.system.comfyui_version='0.40.0';},
    (path,data)=>{if(path.endsWith('CheckpointLoaderSimple'))data.CheckpointLoaderSimple.input.required.ckpt_name=[['../outside']];},
    (path,data)=>{if(path.endsWith('KSampler'))data.KSampler.input.required.sampler_name=[['unsupported']];},
    (path,data)=>{if(path.endsWith('SaveImage'))data.SaveImage.python_module='custom_nodes.package';},
    (path,data)=>{if(path.endsWith('SaveImage'))data.SaveImage.api_node=true;},
    (path,data)=>{if(path.endsWith('SaveImage'))delete data.SaveImage;},
  ]){
    const b=backend(({path})=>{const data=path==='/system_stats'?{system:{comfyui_version:'0.39.0'}}:nodeInfo(path.split('/').at(-1));mutation(path,data);return{data};});
    await assert.rejects(b.connector.check({config:{baseUrl,model:''}}));assert.ok(b.calls.every(c=>c.method==='GET'));
  }
});
test('node metadata aggregate and explicit check wall-clock are bounded',async()=>{
  const b=backend(({path})=>({data:path==='/system_stats'?{system:{comfyui_version:'0.39.0'}}:nodeInfo(path.split('/').at(-1))}),{limits:{maxNodeInfoBytes:400}});
  await assert.rejects(b.connector.check({config:{baseUrl,model:''}}),{code:'COMFY_RESPONSE_TOO_LARGE'});assert.ok(b.calls.length<7);
  const c=backend(()=>null,{limits:{checkTimeoutMs:10}});await assert.rejects(c.connector.check({config:{baseUrl,model:''}}),{code:'COMFY_TIMEOUT'});assert.equal(c.calls.length,1);
});
test('submit sends exactly one fixed body after fence; acknowledgement is not proof of execution',async()=>{
  const e=execution(),b=backend(({body})=>({data:{prompt_id:body.prompt_id,number:0,node_errors:{}}}));let fences=0;
  const result=await b.connector.submit({execution:e,config,beforeSubmit:()=>{fences++;assert.equal(b.calls.length,0);}});
  assert.equal(fences,1);assert.equal(b.calls.length,1);assert.equal(b.calls[0].path,'/prompt');assert.equal(result.state,'submitted');assert.equal(result.contentVerified,false);
  assert.deepEqual(b.calls[0].body.prompt,e.graph);assert.equal(b.calls[0].body.extra_data.mioon.outputNonce,e.outputNonce);assert.equal(b.calls[0].body.client_id,e.clientId);
  assert.equal(b.calls[0].body.prompt['3'].inputs.text,' The fox\n月亮 ');
});
test('lost, malformed, mismatched and node-error acknowledgements stay unknown and never repost or auto-observe',async()=>{
  const e=execution();
  for(const response of [null,{data:{prompt_id:e.promptId,number:0,node_errors:{'7':{error:'private detail'}}}},{data:{prompt_id:'different',number:0,node_errors:{}}},{data:Buffer.from('{bad')},{data:{prompt_id:e.promptId,number:'0',node_errors:{}}}]){
    const b=backend(()=>response,{limits:{jsonTimeoutMs:10}});
    await assert.rejects(b.connector.submit({execution:e,config,beforeSubmit:()=>{}}),error=>error.dispatched===true&&error.outcomeUnknown===true&&!error.message.includes('private detail'));
    assert.equal(b.calls.length,1);assert.equal(b.calls[0].method,'POST');
  }
});
test('disabled or mismatched config, arbitrary graph and missing/async fence cannot POST',async()=>{
  for(const value of [{...config,enabled:false},{...config,model:'other.safetensors'},{...config,baseUrl:'http://localhost:8188'}]){
    const b=backend(()=>assert.fail());await assert.rejects(b.connector.submit({execution:execution(),config:value,beforeSubmit:()=>{}}));assert.equal(b.calls.length,0);
  }
  const e=execution();e.graph['7'].class_type='ExternalPartner';e.graphHash=hashComfyWorkflow(e.graph);
  const b=backend(()=>assert.fail());await assert.rejects(b.connector.submit({execution:e,config,beforeSubmit:()=>{}}));assert.equal(b.calls.length,0);
  await assert.rejects(b.connector.submit({execution:execution(),config}));assert.equal(b.calls.length,0);
});
test('one-shot pending/running/not-found observations never attest content or retrieve an output',async()=>{
  const e=execution();
  for(const status of ['pending','in_progress']){
    const b=backend(()=>({data:{id:e.promptId,status,outputs_count:0}}));
    const result=await b.connector.observe({execution:e,config});assert.deepEqual(result,{state:status==='pending'?'pending':'running',contentVerified:false});assert.equal(b.calls.length,1);assert.equal(b.calls[0].path,`/api/jobs/${e.promptId}`);
  }
  const b=backend(()=>({status:404,data:{error:'Job not found'}}));assert.deepEqual(await b.connector.observe({execution:e,config}),{state:'not_found',contentVerified:false});assert.equal(b.calls.length,1);
});
test('success requires complete original graph, exact marker and affirmative execution status before view',async()=>{
  for(const mutation of [
    j=>{j.id='other';},j=>{delete j.workflow;},j=>{delete j.workflow.prompt['6'];},
    j=>{j.workflow.prompt['3'].inputs.text='server optimized';},j=>{j.workflow.prompt['5'].inputs.steps=21;},
    j=>{j.workflow.prompt['1'].inputs.ckpt_name='replaced.safetensors';},j=>{j.workflow.extra_data.mioon.outputNonce='different';},
    j=>{j.workflow.extra_data.client_id='other';},j=>{j.workflow.extra_data.secret='unexpected';},
    j=>{j.workflow.extra_data.mioon.graphHash='0'.repeat(64);},j=>{delete j.execution_status;},
    j=>{j.execution_status={messages:[]};},j=>{j.execution_status.status_str='error';},j=>{j.execution_status.completed=false;},
    j=>{j.execution_status.messages.push(['execution_error',{prompt_id:j.id}]);},j=>{j.execution_error={exception_message:'private'};},
  ]){
    const job=completeJob();mutation(job);const b=backend(()=>({data:job}));
    await assert.rejects(b.connector.observe({execution:execution(),config}),{code:'COMFY_CORRELATION_FAILED'});assert.equal(b.calls.length,1);
  }
});
test('terminal success rejects all extra or path-authoritative descriptors without view',async()=>{
  for(const mutation of [
    j=>{j.outputs['7'].images.push(j.outputs['7'].images[0]);},j=>{j.outputs['8']=j.outputs['7'];},
    j=>{j.outputs['7'].images[0].subfolder='sub';},j=>{j.outputs['7'].images[0].filename='../escape.png';},
    j=>{j.outputs['7'].images[0].type='temp';},j=>{j.outputs['7'].video=[];},j=>{j.outputs_count=2;},
    j=>{j.outputs['7'].images[0].url='http://attacker.invalid';},j=>{j.outputs['7'].images[0].filename='other_00001_.png';},
  ]){const job=completeJob();mutation(job);const b=backend(()=>({data:job}));await assert.rejects(b.connector.observe({execution:execution(),config}),{code:'COMFY_OUTPUT_INVALID'});assert.equal(b.calls.length,1);}
});
test('valid terminal result yields one staged 512 PNG and provenance after exactly one job GET and one view',async()=>{
  const e=execution(),job=completeJob(e),png=syntheticPng();
  const b=backend(({path})=>path.startsWith('/api/jobs/')?{data:job}:{data:png,type:'image/png'});
  const result=await b.connector.observe({execution:e,config});
  assert.equal(result.state,'completed');assert.equal(result.contentVerified,true);assert.deepEqual(result.candidate.bytes,png);assert.equal(result.candidate.width,512);assert.equal(result.candidate.height,512);assert.equal(result.candidate.mimeType,'image/png');assert.equal(result.candidate.byteLength,png.length);assert.match(result.candidate.sha256,/^[0-9a-f]{64}$/);
  assert.equal(result.provenance.graphHash,e.graphHash);assert.equal(result.provenance.model,model);assert.equal(result.provenance.seed,e.seed);assert.equal(b.calls.length,2);assert.ok(b.calls.every(c=>c.method==='GET'));assert.equal(b.calls[1].path,`/view?filename=${job.outputs['7'].images[0].filename}&subfolder=&type=output`);
});
test('invalid, truncated or wrong-dimension PNG cannot produce a candidate',async()=>{
  for(const png of [Buffer.from('not PNG'),syntheticPng(16),syntheticPng().subarray(0,-1)]){
    const b=backend(({path})=>path.startsWith('/api/jobs/')?{data:completeJob()}:{data:png,type:'image/png'});await assert.rejects(b.connector.observe({execution:execution(),config}),{code:'COMFY_OUTPUT_INVALID'});assert.equal(b.calls.length,2);
  }
});
test('failed/interrupted terminal evidence is correlated and never retrieves or retries work',async()=>{
  for(const status of ['failed','cancelled']){
    const job=completeJob();job.status=status;job.execution_status={status_str:'error',completed:false,messages:[]};job.outputs={};
    const b=backend(()=>({data:job}));const result=await b.connector.observe({execution:execution(),config});assert.equal(result.state,'failed');assert.equal(result.contentVerified,true);assert.equal(b.calls.length,1);
  }
});
test('connector snapshots caller-owned execution and config across the asynchronous observation',async()=>{
  const e=execution(),saved=structuredClone(e),settings=structuredClone(config),job=completeJob(e);
  const b=backend(({path})=>{if(path.startsWith('/api/jobs/')){e.graph['3'].inputs.text='mutated';e.promptId='different';settings.baseUrl='http://127.0.0.1:9999';settings.model='other';return{data:job};}return{data:syntheticPng(),type:'image/png'};});
  const result=await b.connector.observe({execution:e,config:settings});assert.equal(result.provenance.promptId,saved.promptId);assert.equal(result.provenance.model,model);assert.equal(result.state,'completed');
});
test('stop-observing aborts local GET and never calls a remote interrupt or cancellation route',async()=>{
  const controller=new AbortController(),b=backend(()=>{controller.abort();return null;});
  await assert.rejects(b.connector.observe({execution:execution(),config,signal:controller.signal}),{code:'COMFY_ABORTED',dispatched:false});assert.equal(b.calls.length,1);assert.ok(b.destroyed>0);
});
