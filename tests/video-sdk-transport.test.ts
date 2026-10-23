import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeVideoSdk} from '../packages/business/src/video/sdk-transport.ts';
import {createCompatibleVideoSdkClient} from '../packages/business/src/video/compatible-sdk.ts';
import {createJsonRequest,providerError} from '../packages/business/src/providers/live-common.ts';

const api='https://video.example.com/v1';
test('a second SDK POST is blocked and cannot classify the first accepted submit as unsent',async()=>{
  let calls=0;
  await assert.rejects(invokeVideoSdk({api,method:'POST',context:{},send:async()=>{calls++;return {id:'accepted'};}},async fetch=>{
    const options={method:'POST',headers:{'content-type':'application/json'},body:'{"model":"synthetic"}'};
    await fetch(`${api}/videos`,options);await fetch(`${api}/videos`,options);
  }),(error:unknown)=>{assert.equal((error as {code:string}).code,'SUBMISSION_UNKNOWN');assert.equal((error as {uncertain:boolean}).uncertain,true);assert.notEqual((error as {beforeDispatch?:boolean}).beforeDispatch,true);return true;});
  assert.equal(calls,1);
});
test('SDK exception wrapping and attempted retry retain the exact trusted transport failure',async()=>{
  const failure=providerError('SUBMISSION_UNKNOWN','Safe submission evidence',{uncertain:true});let calls=0;
  await assert.rejects(invokeVideoSdk({api,method:'POST',context:{},send:async()=>{calls++;throw failure;}},async fetch=>{
    const options={method:'POST',headers:{'content-type':'application/json'},body:'{}'};
    try{await fetch(`${api}/videos`,options);}catch{/* Simulate an SDK that retries despite configuration. */}
    try{await fetch(`${api}/videos`,options);}catch{throw new Error('PRIVATE SDK message');}
  }),error=>error===failure);assert.equal(calls,1);
});
test('foreign SDK origins, path escapes and changed methods never reach the transport',async()=>{
  for(const [url,method] of [['https://evil.example/videos','POST'],[api+'/../other','POST'],[api+'/videos','DELETE']]){
    let calls=0;
    await assert.rejects(invokeVideoSdk({api,method:'POST',context:{},send:async()=>{calls++;return {};}},fetch=>fetch(url!,{method,headers:{'content-type':'application/json'},body:'{}'})),{code:'VIDEO_SDK_REQUEST_INVALID'});assert.equal(calls,0);
  }
});
test('real OpenAI SDK multipart probe stays local; credentials and review fence remain with project transport',async()=>{
  let calls=0,fences=0;const key='synthetic-current-key';
  const send=createJsonRequest({api,headers:{Authorization:`Bearer ${key}`},ensureEnabled:()=>{},name:'Compatible',fetchImpl:async(url,init)=>{
    calls++;assert.equal(String(url),`${api}/videos`);assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${key}`);assert.equal(init?.redirect,'error');
    const form=await new Response(init?.body,{headers:{'content-type':new Headers(init?.headers).get('content-type')!}}).formData();
    assert.deepEqual([...form.keys()],['model','prompt','seconds','size']);assert.equal(form.get('model'),'custom-video');
    assert.ok(init?.signal);return new Response('{"id":"existing-task"}',{headers:{'content-type':'application/json'}});
  }});
  const sdk=createCompatibleVideoSdkClient({api,model:'custom-video',send});
  const controller=new AbortController(),input={prompt:'A synthetic shape',aspectRatio:'16:9',duration:8,parameters:{resolution:'720p'},images:[],subjectReference:false};
  assert.deepEqual(await sdk.submit(input,{signal:controller.signal,beforeSubmit:()=>{fences++;}}),{id:'existing-task'});assert.equal(fences,1);assert.equal(calls,1);
  controller.abort();await assert.rejects(sdk.submit(input,{signal:controller.signal}));assert.equal(calls,1);
  await assert.rejects(sdk.submit(input,{beforeSubmit:()=>{throw providerError('GENERATION_STATE_CHANGED','Review changed');}}),{code:'GENERATION_STATE_CHANGED'});assert.equal(calls,1);
});
test('OpenAI compatible SDK never retries rejected or ambiguous POST responses',async()=>{
  for(const status of [400,408,409,429,500,503]){
    let calls=0;const send=createJsonRequest({api,headers:{Authorization:'Bearer synthetic'},ensureEnabled:()=>{},name:'Compatible',fetchImpl:async()=>{calls++;return new Response('PRIVATE provider body',{status});}});
    const sdk=createCompatibleVideoSdkClient({api,model:'sora-2',send});
    await assert.rejects(sdk.submit({prompt:'Synthetic',aspectRatio:'9:16',duration:4,parameters:{resolution:'720p'},images:[],subjectReference:false}),(error:unknown)=>{
      assert.equal((error as {uncertain:boolean}).uncertain,[408,409,500,503].includes(status));assert.doesNotMatch(String(error),/PRIVATE/);return true;
    });assert.equal(calls,1);
  }
});
