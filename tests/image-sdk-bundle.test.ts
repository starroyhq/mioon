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

test('real image SDK generation and editing work in an isolated desktop-style CJS bundle',{timeout:60000},async t=>{
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-image-sdk-bundle-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const outfile=path.join(root,'backend.cjs'),cwd=path.join(root,'isolated');await mkdir(cwd);
  // Import production adapters, the real SDK and the real PNG validator. Only
  // the host transport is replaced; no SDK method or serializer is mocked.
  const source=`
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOpenAIImageAdapter,createCompatibleImageAdapter} from './packages/business/src/images/adapter.ts';
import {renderMockImagePng} from './packages/business/src/images/png.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from './packages/contracts/src/images.ts';

export async function runBundleChecks(){
  let forbiddenFetches=0;
  globalThis.fetch=async()=>{forbiddenFetches++;throw Error('Ambient network is forbidden');};
  for(const key of Object.keys(process.env))assert.doesNotMatch(key,/(?:KEY|SECRET|TOKEN|CREDENTIAL)|^NODE_(?:PATH|OPTIONS)$/i);
  const png=await renderMockImagePng(),sha256=createHash('sha256').update(png).digest('hex');
  const response=Buffer.from(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
  const requests=[];let fences=0;
  const transport=async request=>{
    requests.push(request);
    const before=fences;request.beforeDispatch();assert.equal(fences,before+1);
    return {body:response,providerRequestId:'req_isolated_image_sdk',dispatched:true};
  };
  const input={providerId:'openai',model:IMAGE_MODELS.openai,prompt:'Synthetic blue geometric shapes.',options:{...IMAGE_FIXED_OPTIONS}};
  const adapter=createOpenAIImageAdapter({transport});
  const generated=await adapter.generate(input,{beforeDispatch:()=>{fences++;}});
  assert.deepEqual(generated.bytes,png);assert.equal(generated.metadata.providerRequestId,'req_isolated_image_sdk');
  assert.deepEqual(JSON.parse(String(requests[0].body)),{model:input.model,prompt:input.prompt,n:1,quality:'low',size:'1024x1024',output_format:'png',background:'opaque',moderation:'auto'});

  const assetId='11111111-1111-4111-8111-111111111111';
  const edit={...input,purpose:'edit',inputImage:{assetId,sha256},sourceImage:{assetId,sha256,mimeType:'image/png',byteLength:png.length,width:1024,height:1024,name:'Synthetic source.png',origin:{kind:'user-import'}}};
  const edited=await adapter.generate(edit,{sourceBytes:png,beforeDispatch:()=>{fences++;}});
  assert.deepEqual(edited.bytes,png);
  const uploaded=requests[1];assert.match(uploaded.contentType,/^multipart\\/form-data; boundary=/);
  const form=await new Response(uploaded.body,{headers:{'content-type':uploaded.contentType}}).formData();
  assert.deepEqual([...form.keys()].sort(),['background','image','model','n','output_format','prompt','quality','size']);
  assert.equal(form.get('model'),input.model);assert.equal(form.get('prompt'),input.prompt);assert.equal(form.get('n'),'1');
  assert.equal(form.get('quality'),'low');assert.equal(form.get('size'),'1024x1024');assert.equal(form.get('output_format'),'png');assert.equal(form.get('background'),'opaque');
  assert.equal(form.has('moderation'),false,'Native SDK edits use their server-side moderation handling');
  const image=form.get('image');assert.ok(image instanceof File);assert.equal(image.type,'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);

  const compatible=createCompatibleImageAdapter({transport,baseUrl:'https://compatible.example/api/v1'});
  const custom=await compatible.generate({...input,providerId:'openai-compatible',model:'reviewed-custom-image'},{beforeDispatch:()=>{fences++;}});
  assert.deepEqual(custom.bytes,png);assert.equal(JSON.parse(String(requests[2].body)).model,'reviewed-custom-image');
  assert.equal(requests.length,3);assert.equal(fences,3);assert.equal(forbiddenFetches,0);
  return {operations:requests.length,fences,forbiddenFetches};
}
`;
  const bundled=await build({stdin:{contents:source,loader:'js',resolveDir:repo},outfile,bundle:true,platform:'node',format:'cjs',target:'node24',metafile:true,
    plugins:[localRequireBundlePlugin(repo)],define:{'import.meta.url':'__mioon_import_meta_url'},banner:{js:'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;'},logLevel:'silent'});
  const optionalWsAccelerators=new Set(['bufferutil','utf-8-validate']);
  for(const output of Object.values(bundled.metafile!.outputs))for(const dependency of output.imports)assert.ok(!dependency.external||isBuiltin(dependency.path)||optionalWsAccelerators.has(dependency.path),`Unbundled dependency: ${dependency.path}`);
  const bootstrap=`const Module=require('node:module'),bundle=process.argv[1],load=Module._load;
Module._load=function(request,...args){if(request!==bundle&&!Module.isBuiltin(request))throw Error('External dependency requested: '+request);return load.call(this,request,...args);};
globalThis.fetch=async()=>{throw Error('Ambient network is forbidden before loading');};
require(bundle).runBundleChecks().then(result=>process.stdout.write(JSON.stringify(result)),error=>{console.error(error);process.exitCode=1;});`;
  const result=await run(process.execPath,['--input-type=commonjs','-e',bootstrap,outfile],{cwd,env:{...cleanEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0'},encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
  assert.deepEqual(JSON.parse(result.stdout),{operations:3,fences:3,forbiddenFetches:0});
});
