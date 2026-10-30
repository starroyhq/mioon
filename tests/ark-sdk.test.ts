import test from 'node:test';
import assert from 'node:assert/strict';
import {createArkSdkClient} from '../packages/business/src/video/ark-sdk.ts';
import {createJsonRequest,providerError} from '../packages/business/src/providers/live-common.ts';
import type {ProviderContext} from '../packages/business/src/providers/live-common.ts';
import type {VideoAdapterInput} from '../packages/business/src/video/adapters.ts';

const API='https://ark.cn-beijing.volces.com/api/v3';
const MODEL='doubao-seedance-2-5-260628';
const ID='historical-ark-task';
const SECRET='ark-private-test-key';
const input:VideoAdapterInput={prompt:'A synthetic shape moves',aspectRatio:'9:16',duration:4,parameters:{resolution:'720p'},images:[],subjectReference:false};
type ResponseItem=Response|Error|((init:RequestInit)=>Promise<Response>);
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const bodyOf=(init:RequestInit)=>JSON.parse(typeof init.body==='string'?init.body:Buffer.from(init.body as Uint8Array).toString('utf8')) as Record<string,unknown>;
function fixture(responses:ResponseItem[],{model=MODEL,ensureEnabled=()=>{},audio}:{model?:string;ensureEnabled?:()=>void;audio?:'off'|'on'|'optional'}={}) {
  const calls:Array<{url:string;init:RequestInit}>=[];
  const fetchImpl:typeof fetch=async(url,init={})=>{
    calls.push({url:String(url),init});const next=responses.shift();
    if(next instanceof Error)throw next;
    if(typeof next==='function')return next(init);
    assert.ok(next,'Only injected responses may be used');return next;
  };
  const sdk=createArkSdkClient({api:API,model,...(audio?{audio}:{}),send:(endpoint,options)=>createJsonRequest({api:API,headers:{...options.headers,Authorization:`Bearer ${SECRET}`},fetchImpl,ensureEnabled,name:'Seedance'})(endpoint,options)});
  return {sdk,calls};
}

test('Ark official SDK constructs the task request before the bounded project transport',async()=>{
  const receipt={id:ID,usage:{tokens:2}},f=fixture([json(receipt)]);
  assert.deepEqual(await f.sdk.submit(input),receipt);assert.equal(f.calls.length,1);
  const {url,init}=f.calls[0]!;assert.equal(url,`${API}/contents/generations/tasks`);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),`Bearer ${SECRET}`);assert.equal(headers.get('x-project-name'),null);assert.equal(headers.get('x-client-request-id'),null);
  assert.deepEqual(bodyOf(init),{model:MODEL,content:[{type:'text',text:input.prompt}],duration:4,ratio:'9:16',resolution:'720p',output_format:'mp4',generate_audio:false});
  assert.equal(Object.hasOwn(bodyOf(init),'seed'),false);
});

test('Ark official SDK preserves the exact selected custom model, not an inferred model',async()=>{
  const f=fixture([json({id:ID})],{model:'custom-seedance-template-model'});await f.sdk.submit(input);
  assert.equal(bodyOf(f.calls[0]!.init).model,'custom-seedance-template-model');
});

for(const roles of [['first_frame'],['first_frame','last_frame']])test(`Ark official SDK preserves ordered ${roles.join('/')} image roles and adaptive ratio`,async()=>{
  const images=roles.map((role,index)=>({role,mimeType:index?'image/jpeg':'image/png',base64:Buffer.from(`image-${index}`).toString('base64')}));
  const f=fixture([json({id:ID})]);await f.sdk.submit({...input,images});
  const body=bodyOf(f.calls[0]!.init);assert.equal(body.ratio,'adaptive');assert.equal(body.omni_reference_task_type,undefined);
  assert.deepEqual(body.content,[{type:'text',text:input.prompt},...images.map(image=>({type:'image_url',image_url:{url:`data:${image.mimeType};base64,${image.base64}`},role:image.role}))]);
});

test('Ark official SDK retains the subject reference role and fixed output ratio',async()=>{
  const f=fixture([json({id:ID})]);await f.sdk.submit({...input,subjectReference:true,images:[{role:'subject_reference',mimeType:'image/png',base64:'c3ViamVjdA=='}]});
  const body=bodyOf(f.calls[0]!.init);assert.equal(body.ratio,'9:16');assert.equal(body.omni_reference_task_type,'reference');
  assert.deepEqual(body.content,[{type:'text',text:input.prompt},{type:'image_url',image_url:{url:'data:image/png;base64,c3ViamVjdA=='},role:'reference_image'}]);
});

test('Ark historical task retrieval preserves the raw response and exact task ID',async()=>{
  const task={id:ID,status:'expired',historical:true,content:{video_url:'https://output.invalid/video.mp4'}},f=fixture([json(task)]);
  assert.deepEqual(await f.sdk.retrieve(ID),task);assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.url,`${API}/contents/generations/tasks/${ID}`);assert.equal(f.calls[0]!.init.method,'GET');assert.equal(f.calls[0]!.init.body,undefined);
  for(const id of ['../task','a/b','https://other.invalid',''])await assert.rejects(f.sdk.retrieve(id),{code:'INVALID_PROVIDER_TASK_ID'});
  assert.equal(f.calls.length,1);
});

for(const status of [408,409,429,500])test(`Ark official SDK never retries a POST HTTP ${status}`,async()=>{
  const f=fixture([json({error:{message:SECRET}},status)]);
  await assert.rejects(f.sdk.submit(input),(error:unknown)=>{
    const failure=error as {code:string;message:string;uncertain:boolean};assert.equal(failure.code,status===429?'PROVIDER_HTTP_429':'SUBMISSION_UNKNOWN');assert.equal(failure.uncertain,status!==429);assert.doesNotMatch(failure.message,/private-test-key/);return true;
  });assert.equal(f.calls.length,1);
});

for(const response of [new Error(`failed ${SECRET}`),new DOMException(SECRET,'TimeoutError'),new Response('invalid')])test(`Ark official SDK preserves an uncertain ${response instanceof Error?response.name:'invalid JSON'} submission without retry`,async()=>{
  const f=fixture([response]);await assert.rejects(f.sdk.submit(input),{code:'SUBMISSION_UNKNOWN',uncertain:true});assert.equal(f.calls.length,1);
});

test('Ark official SDK preserves the last submit fence and already cancelled context',async()=>{
  const f=fixture([json({id:ID})]),controller=new AbortController();controller.abort();
  await assert.rejects(f.sdk.submit(input,{signal:controller.signal}),{code:'OPERATION_CANCELLED'});assert.equal(f.calls.length,0);
  const denied=providerError('VIDEO_CREDENTIAL_UNAVAILABLE','The bound credential was revoked.',{beforeDispatch:true});
  await assert.rejects(f.sdk.submit(input,{beforeSubmit(){throw denied;}}),error=>error===denied);assert.equal(f.calls.length,0);
});

test('Ark official SDK preserves post-dispatch cancellation evidence with one POST',async()=>{
  const controller=new AbortController(),f=fixture([async init=>{assert.equal(init.signal?.aborted,false);controller.abort();throw new DOMException('cancelled','AbortError');}]);
  await assert.rejects(f.sdk.submit(input,{signal:controller.signal}),{code:'SUBMISSION_UNKNOWN',uncertain:true});assert.equal(f.calls.length,1);
});

test('Ark official SDK keeps concurrent signals and task contexts separate',async()=>{
  const first=new AbortController(),second=new AbortController(),seen=new Map<string,AbortSignal>(),f=fixture([
    async init=>{seen.set(init.method!,init.signal!);return json({id:ID});},
    async init=>{seen.set(init.method!,init.signal!);return json({id:ID,status:'running'});},
  ]),contexts:ProviderContext[]=[{signal:first.signal},{signal:second.signal}];
  await Promise.all([f.sdk.submit(input,contexts[0]),f.sdk.retrieve(ID,contexts[1])]);assert.equal(seen.size,2);assert.notEqual(seen.get('POST'),seen.get('GET'));
  first.abort();assert.equal(seen.get('POST')?.aborted,true);assert.equal(seen.get('GET')?.aborted,false);
});

test('Ark ambient credentials and origin cannot replace the frozen operation binding',async t=>{
  const keys=['ARK_API_KEY','ARK_BASE_URL'] as const,original=keys.map(key=>process.env[key]);
  t.after(()=>keys.forEach((key,index)=>{if(original[index]===undefined)delete process.env[key];else process.env[key]=original[index];}));
  Object.assign(process.env,{ARK_API_KEY:'ambient-ark-secret',ARK_BASE_URL:'https://wrong-origin.invalid'});
  const f=fixture([json({id:ID})]);await f.sdk.submit(input);assert.equal(f.calls[0]!.url,`${API}/contents/generations/tasks`);
  assert.equal(new Headers(f.calls[0]!.init.headers).get('authorization'),`Bearer ${SECRET}`);assert.doesNotMatch(JSON.stringify(f.calls),/ambient-ark-secret/);
});

test('Ark SDK rejects unadvertised parameters and image combinations before transport',async()=>{
  const f=fixture([]),image={role:'first_frame',mimeType:'image/png',base64:'c3ludGhldGlj'};
  for(const patch of [{parameters:{seed:1}},{parameters:{generateAudio:true}},{images:[{...image,role:'last_frame'}]},{images:[image,{...image,role:'reference_image'}]},{images:[image,image,image]},{subjectReference:true},{subjectReference:true,images:[image]}])await assert.rejects(f.sdk.submit({...input,...patch}));
  assert.equal(f.calls.length,0);
});

test('Ark SDK sends Seedance 2.5 long, automatic, adaptive and 1080p requests exactly as resolved',async()=>{
  const cases:Array<[Partial<VideoAdapterInput>,Record<string,unknown>]>=[
    [{duration:30,aspectRatio:'21:9',parameters:{resolution:'1080p',durationSeconds:30,aspectRatio:'21:9',generateAudio:true}},{duration:30,ratio:'21:9',resolution:'1080p',generate_audio:true}],
    [{duration:-1,aspectRatio:'adaptive',parameters:{resolution:'480p',durationSeconds:-1,aspectRatio:'adaptive',generateAudio:false}},{duration:-1,ratio:'adaptive',resolution:'480p',generate_audio:false}],
    [{duration:12,aspectRatio:'1:1',parameters:{resolution:'720p'}},{duration:12,ratio:'1:1',resolution:'720p',generate_audio:false}],
  ];
  for(const [patch,expected] of cases){
    const f=fixture([json({id:ID})],{audio:'optional'});await f.sdk.submit({...input,...patch});
    assert.deepEqual(bodyOf(f.calls[0]!.init),{model:MODEL,content:[{type:'text',text:input.prompt}],output_format:'mp4',...expected});
  }
});

test('Ark SDK follows the saved audio mode and keeps frame tasks adaptive at any length',async()=>{
  const on=fixture([json({id:ID})],{audio:'on'});await on.sdk.submit(input);assert.equal(bodyOf(on.calls[0]!.init).generate_audio,true);
  const frames=fixture([json({id:ID})],{audio:'optional'}),image={role:'first_frame',mimeType:'image/png',base64:'Zmlyc3Q='};
  await frames.sdk.submit({...input,duration:25,aspectRatio:'4:3',parameters:{resolution:'720p',durationSeconds:25,aspectRatio:'4:3'},images:[image]});
  const body=bodyOf(frames.calls[0]!.init);assert.equal(body.duration,25);assert.equal(body.ratio,'adaptive');assert.equal(body.generate_audio,false);
});

test('Ark SDK rejects audio choices the saved model does not offer and parameters that disagree with the resolved input',async()=>{
  const optional=fixture([],{audio:'optional'}),on=fixture([],{audio:'on'});
  for(const patch of [{parameters:{generateAudio:'true'}},{duration:8,parameters:{durationSeconds:30}},{parameters:{aspectRatio:'16:9'}},{duration:3,parameters:{}},{duration:31,parameters:{}},{duration:4.5,parameters:{}},{parameters:{promptExtend:true}},{parameters:{watermark:false}}])await assert.rejects(optional.sdk.submit({...input,...patch} as VideoAdapterInput),{code:'UNSUPPORTED_PARAMETER'},JSON.stringify(patch));
  await assert.rejects(on.sdk.submit({...input,parameters:{generateAudio:false}}),{code:'UNSUPPORTED_PARAMETER'});
  assert.equal(optional.calls.length+on.calls.length,0);
});

test('Ark SDK sends an ordered Seedance 2.5 reference group with the chosen ratio and keeps it under the request budget',async()=>{
  const image=(index:number)=>({role:'reference_image',mimeType:'image/png',base64:Buffer.from(`reference ${index}`).toString('base64')});
  const images=Array.from({length:30},(_,index)=>image(index+1)),f=fixture([json({id:ID})],{audio:'optional'});
  await f.sdk.submit({...input,duration:-1,aspectRatio:'16:9',parameters:{resolution:'720p',durationSeconds:-1,aspectRatio:'16:9'},images});
  const body=bodyOf(f.calls[0]!.init);
  assert.equal(body.omni_reference_task_type,'reference');assert.equal(body.ratio,'16:9');assert.equal(body.duration,-1);
  assert.deepEqual(body.content,[{type:'text',text:input.prompt},...images.map(item=>({type:'image_url',image_url:{url:`data:image/png;base64,${item.base64}`},role:'reference_image'}))]);
  const adaptive=fixture([json({id:ID})]);
  await adaptive.sdk.submit({...input,aspectRatio:'adaptive',parameters:{resolution:'720p',aspectRatio:'adaptive'},images:[image(1)]});
  assert.equal(bodyOf(adaptive.calls[0]!.init).ratio,'adaptive');assert.equal(bodyOf(adaptive.calls[0]!.init).omni_reference_task_type,'reference');
  const rejected=fixture([]);
  await assert.rejects(rejected.sdk.submit({...input,images:Array.from({length:31},(_,index)=>image(index+1))}),{code:'UNSUPPORTED_INPUT_ROLE'});
  // Five 10 MiB images encode to about 70 MB, above the 60,000,000-byte budget.
  const large={role:'reference_image',mimeType:'image/png',base64:'A'.repeat(4*Math.ceil(10*1024*1024/3))};
  await assert.rejects(rejected.sdk.submit({...input,images:Array.from({length:5},()=>large)}),{code:'REFERENCE_REQUEST_TOO_LARGE'});
  assert.equal(rejected.calls.length,0);
});

test('Ark SDK sends Seedance 2.5 reference audio after the images, or alone, as a reference task',async()=>{
  const wav={mimeType:'audio/wav',base64:Buffer.from('RIFF\0\0\0\0WAVEfmt ').toString('base64')},mp3={mimeType:'audio/mpeg',base64:Buffer.from('ID3 synthetic').toString('base64')};
  const image={role:'reference_image',mimeType:'image/png',base64:Buffer.from('reference').toString('base64')};
  const both=fixture([json({id:ID})]);
  await both.sdk.submit({...input,aspectRatio:'16:9',parameters:{resolution:'720p',aspectRatio:'16:9'},images:[image],audios:[wav,mp3]});
  const body=bodyOf(both.calls[0]!.init);
  assert.deepEqual(body.content,[{type:'text',text:input.prompt},{type:'image_url',image_url:{url:`data:image/png;base64,${image.base64}`},role:'reference_image'},
    {type:'audio_url',audio_url:{url:`data:audio/wav;base64,${wav.base64}`},role:'reference_audio'},{type:'audio_url',audio_url:{url:`data:audio/mp3;base64,${mp3.base64}`},role:'reference_audio'}]);
  assert.equal(body.omni_reference_task_type,'reference');assert.equal(body.ratio,'16:9');
  const alone=fixture([json({id:ID})]);await alone.sdk.submit({...input,audios:[wav]});
  const only=bodyOf(alone.calls[0]!.init);
  assert.deepEqual(only.content,[{type:'text',text:input.prompt},{type:'audio_url',audio_url:{url:`data:audio/wav;base64,${wav.base64}`},role:'reference_audio'}]);
  assert.equal(only.omni_reference_task_type,'reference');assert.equal(only.ratio,'9:16');assert.equal(only.generate_audio,false,'Reference audio does not turn sound on');
});

test('Ark SDK rejects reference audio with frames, a subject, an unsupported format, too many clips or too many bytes',async()=>{
  const wav={mimeType:'audio/wav',base64:'UklGRg=='},f=fixture([]);
  const frame={role:'first_frame',mimeType:'image/png',base64:'cG5n'},subjectImage={role:'subject_reference',mimeType:'image/png',base64:'cG5n'};
  for(const patch of [{images:[frame],audios:[wav]},{subjectReference:true,images:[subjectImage],audios:[wav]},{audios:[{mimeType:'audio/mp4',base64:'AAAA'}]},{audios:Array.from({length:11},()=>wav)}])
    await assert.rejects(f.sdk.submit({...input,...patch}),{code:'UNSUPPORTED_INPUT_ROLE'},JSON.stringify(patch).slice(0,60));
  await assert.rejects(f.sdk.submit({...input,audios:[{mimeType:'audio/wav',base64:'A'.repeat(60_000_000)}]}),{code:'REFERENCE_REQUEST_TOO_LARGE'});
  assert.equal(f.calls.length,0);
});
