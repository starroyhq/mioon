import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {isBuiltin} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {localRequireBundlePlugin} from '../apps/desktop/scripts/bundle-local-require.ts';
import {cleanEnvironment} from '../.github/scripts/media-environment.ts';

const run=promisify(execFile),repo=fileURLToPath(new URL('../',import.meta.url));

test('all official video SDKs submit and retrieve in an isolated desktop-style static CJS bundle',{timeout:60000},async t=>{
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-video-sdk-bundle-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const outfile=path.join(root,'backend.cjs'),cwd=path.join(root,'isolated');await mkdir(cwd);
  // The generated program imports production helpers and every real SDK. Only
  // the existing transport seam is substituted; no SDK assembly is mocked.
  const source=`
import assert from 'node:assert/strict';
import {createArkSdkClient} from './packages/business/src/video/ark-sdk.ts';
import {createVeoSdkClient} from './packages/business/src/video/veo-sdk.ts';
import {createRunwaySdkClient} from './packages/business/src/video/runway-sdk.ts';
import {createCompatibleVideoSdkClient} from './packages/business/src/video/compatible-sdk.ts';
import {createMinimaxSdkClient} from './packages/business/src/video/minimax-sdk.ts';

function capture(receipt,task){
  const calls=[];
  return {calls,send:async(path,options)=>{
    calls.push({path,options});
    assert.equal(options.method,calls.length===1?'POST':'GET');
    assert.ok(calls.length<=2,'The SDK must not add uploads, polling or retries');
    return calls.length===1?receipt:task;
  }};
}
function checkCalls(f,paths){
  assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls.map(call=>call.path),paths);
  assert.deepEqual(f.calls.map(call=>call.options.method),['POST','GET']);
  assert.equal(f.calls[1].options.body,undefined);
  assert.equal(f.calls[1].options.raw,undefined);
}
const first={role:'first_frame',mimeType:'image/png',base64:'Zmlyc3Q='};
const last={role:'last_frame',mimeType:'image/jpeg',base64:'bGFzdA=='};
const input={prompt:'Synthetic shapes move.',aspectRatio:'9:16',duration:4,parameters:{resolution:'720p'},images:[first],subjectReference:false};

export async function runBundleChecks(){
  let forbiddenFetches=0;
  globalThis.fetch=async()=>{forbiddenFetches++;throw Error('Real HTTP is forbidden in the bundle test');};
  for(const key of Object.keys(process.env))assert.doesNotMatch(key,/(?:KEY|SECRET|TOKEN|CREDENTIAL)|^NODE_(?:PATH|OPTIONS)$/i,'Sensitive environment inherited: '+key);
  const summary={};

  {
    const id='bundled-ark-task',model='doubao-seedance-2-5-260628';
    const receipt={id,legacyCreate:true},task={id,status:'succeeded',content:{video_url:'https://cdn.invalid/ark.mp4'},historical:{keep:true}},f=capture(receipt,task);
    const sdk=createArkSdkClient({api:'https://ark.cn-beijing.volces.com/api/v3',model,send:f.send});
    assert.deepEqual(await sdk.submit({...input,images:[first,last]}),receipt);
    assert.deepEqual(await sdk.retrieve(id),task);
    checkCalls(f,['/contents/generations/tasks','/contents/generations/tasks/'+id]);
    assert.deepEqual(f.calls[0].options.body,{model,content:[{type:'text',text:input.prompt},{type:'image_url',image_url:{url:'data:image/png;base64,Zmlyc3Q='},role:'first_frame'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,bGFzdA=='},role:'last_frame'}],duration:4,ratio:'adaptive',resolution:'720p',output_format:'mp4',generate_audio:false});
    summary.ark=f.calls.length;
  }
  {
    const model='veo-3.1-generate-preview',id='models/'+model+'/operations/bundled123';
    const receipt={name:id,metadata:{legacyCreate:true}},task={name:id,done:true,metadata:{keep:true},response:{generateVideoResponse:{generatedSamples:[{video:{uri:'https://cdn.invalid/veo.mp4',mimeType:'video/mp4'}}],raiMediaFilteredCount:0}}},f=capture(receipt,task);
    const sdk=createVeoSdkClient({api:'https://generativelanguage.googleapis.com/v1beta',model,send:f.send});
    assert.deepEqual(await sdk.submit(input),receipt);
    assert.deepEqual(await sdk.retrieve(id),task);
    checkCalls(f,['/models/'+model+':predictLongRunning','/'+id]);
    assert.deepEqual(f.calls[0].options.body,{instances:[{prompt:input.prompt,image:{bytesBase64Encoded:'Zmlyc3Q=',mimeType:'image/png'}}],parameters:{sampleCount:1,durationSeconds:4,aspectRatio:'9:16',resolution:'720p'}});
    summary.veo=f.calls.length;
  }
  {
    const id='12345678-1234-4123-8123-123456789abc';
    const receipt={id,legacyCreate:true},task={id,status:'CANCELLED',historical:{keep:true}},f=capture(receipt,task);
    const sdk=createRunwaySdkClient({api:'https://api.dev.runwayml.com',send:f.send});
    assert.deepEqual(await sdk.submit({...input,duration:5,parameters:{resolution:'720p',seed:123}}),receipt);
    assert.deepEqual(await sdk.retrieve(id),task);
    checkCalls(f,['/v1/image_to_video','/v1/tasks/'+id]);
    assert.deepEqual(f.calls[0].options.body,{model:'gen4_turbo',promptImage:'data:image/png;base64,Zmlyc3Q=',promptText:input.prompt,ratio:'720:1280',duration:5,seed:123});
    for(const call of f.calls)assert.equal(new Headers(call.options.headers).get('x-runway-version'),'2024-11-06');
    summary.runway=f.calls.length;
  }
  {
    const id='video-bundled',model='custom-reviewed-video-model';
    const receipt={id,status:'queued',legacyCreate:true},task={id,status:'completed',progress:100,historical:{keep:true}},f=capture(receipt,task);
    const sdk=createCompatibleVideoSdkClient({api:'https://compatible.example/v1',model,send:f.send});
    assert.deepEqual(await sdk.submit({...input,aspectRatio:'16:9',duration:8}),receipt);
    assert.deepEqual(await sdk.retrieve(id),task);
    checkCalls(f,['/videos','/videos/'+id]);
    const options=f.calls[0].options;assert.equal(options.body,undefined);assert.ok(options.raw);
    assert.match(options.raw.contentType,/^multipart\\/form-data; boundary=/);
    const form=await new Response(options.raw.bytes,{headers:{'content-type':options.raw.contentType}}).formData();
    assert.deepEqual([...form.keys()].sort(),['input_reference','model','prompt','seconds','size']);
    assert.equal(form.get('model'),model);assert.equal(form.get('prompt'),input.prompt);assert.equal(form.get('seconds'),'8');assert.equal(form.get('size'),'1280x720');
    const image=form.get('input_reference');assert.ok(image instanceof File);assert.equal(image.name,'reference.png');assert.equal(image.type,'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from('first'));
    summary.compatible=f.calls.length;
  }
  {
    const id='bundled-minimax-task',model='MiniMax-H3';
    const receipt={task_id:id,legacyCreate:true},task={task:{id,status:'succeeded',resolution:'768P',duration:4,content:{url:'https://cdn.invalid/minimax.mp4'}},historical:{keep:true}},f=capture(receipt,task);
    const sdk=createMinimaxSdkClient({api:'https://api.minimax.io',model,send:f.send});
    assert.deepEqual(await sdk.submit({...input,duration:8,parameters:{resolution:'2K'}}),receipt);
    assert.deepEqual(await sdk.retrieve(id),task);
    checkCalls(f,['/v2/video_generation','/v2/query/video_generation/'+id]);
    assert.deepEqual(f.calls[0].options.body,{model,content:[{type:'text',text:input.prompt},{type:'image_url',image_url:{url:'data:image/png;base64,Zmlyc3Q='},role:'first_frame'}],duration:8,resolution:'2K',ratio:'adaptive'});
    summary.minimax=f.calls.length;
  }
  assert.equal(forbiddenFetches,0);
  return {...summary,forbiddenFetches};
}
`;
  const bundled=await build({stdin:{contents:source,loader:'js',resolveDir:repo},outfile,bundle:true,platform:'node',format:'cjs',target:'node24',metafile:true,
    plugins:[localRequireBundlePlugin(repo)],define:{'import.meta.url':'__mioon_import_meta_url'},banner:{js:'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;'},logLevel:'silent'});
  // ws probes these optional native accelerators inside try/catch and provides
  // JavaScript fallbacks. Keep the production bundle behavior: neither module
  // is supplied, and the child below rejects both optional runtime requires.
  const optionalWsAccelerators=new Set(['bufferutil','utf-8-validate']);
  for(const output of Object.values(bundled.metafile!.outputs))for(const dependency of output.imports)assert.ok(!dependency.external||isBuiltin(dependency.path)||optionalWsAccelerators.has(dependency.path),`Unbundled dependency: ${dependency.path}`);
  // Block every non-builtin runtime require except this self-contained bundle.
  // The empty cwd and allowlisted environment cannot supply workspace modules,
  // NODE_PATH, Node preload hooks, or a real provider credential.
  const bootstrap=`const assert=require('node:assert/strict'),Module=require('node:module');
const bundle=process.argv[1],load=Module._load;
Module._load=function(request,...args){if(request!==bundle&&!Module.isBuiltin(request))throw Error('External dependency requested: '+request);return load.call(this,request,...args);};
globalThis.fetch=async()=>{throw Error('Real HTTP is forbidden before bundle loading');};
require(bundle).runBundleChecks().then(result=>{process.stdout.write(JSON.stringify(result));},error=>{console.error(error);process.exitCode=1;});`;
  const env={...cleanEnvironment(),TMPDIR:root,TMP:root,TEMP:root};
  const result=await run(process.execPath,['-e',bootstrap,outfile],{cwd,env,timeout:45000,killSignal:'SIGKILL',maxBuffer:1024*1024});
  assert.deepEqual(JSON.parse(result.stdout),{ark:2,veo:2,runway:2,compatible:2,minimax:2,forbiddenFetches:0});
});
