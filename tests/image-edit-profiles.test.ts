import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {IMAGE_EDIT_PROFILES,IMAGE_FIXED_OPTIONS,IMAGE_MODELS,imageEditOutputSize,imageEditProfile,imageEditSourceIssue,imageReceiptSchema,imageResultGeometry,
 imageSchemas,imageVersionResponseSchema,isImageEditOutputSize,parseImageSize} from '@mioon/contracts';

const hash='a'.repeat(64),at='2026-10-27T00:00:00.000Z';
const edit=(patch: Record<string, unknown>={})=>({projectId:randomUUID(),name:'Variant',providerId:'mock',model:IMAGE_MODELS.mock,prompt:'Change the camera.',
 options:{...IMAGE_FIXED_OPTIONS,size:'1152x1536'},purpose:'edit',inputImage:{assetId:randomUUID(),sha256:hash},requestId:randomUUID(),...patch});

test('each fixed edit model has a profile; other providers and models have none',()=>{
 assert.equal(imageEditProfile('mock',IMAGE_MODELS.mock),IMAGE_EDIT_PROFILES.mock);
 assert.equal(imageEditProfile('openai',IMAGE_MODELS.openai),IMAGE_EDIT_PROFILES.openai);
 for(const [providerId,model] of [['openai',IMAGE_MODELS.mock],['openai-compatible','vendor/model'],['comfy-local','model.safetensors'],['mock','other']])assert.equal(imageEditProfile(providerId,model),null);
});

test('output sizes follow the model rule: multiples of 16, ratio 1:3 to 3:1, at most 2560x1440 pixels',()=>{
 const profile=IMAGE_EDIT_PROFILES.openai;
 for(const size of ['1024x1024','1536x1024','1024x1536','1152x1536','1536x864','864x1536','1536x512','2560x1440'])assert.equal(isImageEditOutputSize(profile,size),true,size);
 for(const size of ['1000x1000','1536x1530','2560x2560','2576x1440','1536x496','240x240','01024x1024','1024X1024','1024x1024 ',1024])assert.equal(isImageEditOutputSize(profile,size),false,String(size));
 assert.equal(isImageEditOutputSize(null,'1024x1024'),false);
 assert.deepEqual(parseImageSize('1152x1536'),{width:1152,height:1536});assert.equal(parseImageSize('x'),null);
});

test('the chosen output keeps the source ratio with a 1536 long edge, clamped to the model ratio',()=>{
 const profile=IMAGE_EDIT_PROFILES.mock;
 for(const [width,height,size] of [[768,1024,'1152x1536'],[1024,1024,'1536x1536'],[1920,1080,'1536x864'],[1080,1920,'864x1536'],[4032,3024,'1536x1152'],
  [4000,1000,'1536x512'],[1,10,'512x1536'],[1536,1024,'1536x1024']] as const)assert.equal(imageEditOutputSize(profile,width,height),size,`${width}x${height}`);
});

test('source issues name the first failing limit of the model',()=>{
 const profile=IMAGE_EDIT_PROFILES.openai,ok={mimeType:'image/jpeg',byteLength:4_000_000,width:4032,height:3024};
 assert.equal(imageEditSourceIssue(profile,ok),null);
 for(const mimeType of ['image/png','image/webp'])assert.equal(imageEditSourceIssue(profile,{...ok,mimeType}),null);
 assert.equal(imageEditSourceIssue(profile,{...ok,mimeType:'image/gif'}),'format');
 assert.equal(imageEditSourceIssue(profile,{...ok,byteLength:50*1024*1024}),'bytes');
 assert.equal(imageEditSourceIssue(profile,{...ok,width:4097}),'dimensions');
 assert.equal(imageEditSourceIssue(profile,{...ok,width:4096,height:4096}),null);
});

test('edit requests carry a model size; text-to-image stays 1024x1024',()=>{
 const generate=imageSchemas['image.generate'];
 assert.equal(generate.safeParse(edit()).success,true);
 assert.equal(generate.safeParse(edit({options:{...IMAGE_FIXED_OPTIONS}})).success,true,'legacy 1024x1024 edits stay valid');
 assert.equal(generate.safeParse(edit({providerId:'openai',model:IMAGE_MODELS.openai})).success,true);
 for(const size of ['1000x1000','2560x2560','4096x1024'])assert.equal(generate.safeParse(edit({options:{...IMAGE_FIXED_OPTIONS,size}})).success,false,size);
 const {purpose:_,inputImage:__,...text}=edit();
 assert.equal(generate.safeParse(text).success,false);
 assert.equal(generate.safeParse({...text,options:{...IMAGE_FIXED_OPTIONS}}).success,true);
});

test('results and receipts are sized from the request; a 1024x1024 result keeps the v1 receipt',()=>{
 assert.deepEqual(imageResultGeometry({providerId:'mock',purpose:'edit',options:{size:'1152x1536'}}),{schemaVersion:3,width:1152,height:1536});
 assert.deepEqual(imageResultGeometry({providerId:'mock',purpose:'edit',options:{size:'1024x1024'}}),{schemaVersion:1,width:1024,height:1024});
 assert.deepEqual(imageResultGeometry({providerId:'openai',options:{size:'1024x1024'}}),{schemaVersion:1,width:1024,height:1024});
 assert.deepEqual(imageResultGeometry({providerId:'comfy-local',options:{size:'512x512'}}),{schemaVersion:2,width:512,height:512});
 const receipt={schemaVersion:3,taskId:randomUUID(),projectId:randomUUID(),groupId:randomUUID(),inputHash:hash,assetId:randomUUID(),versionId:randomUUID(),sha256:hash,mimeType:'image/png',width:1152,height:1536,byteLength:100,isMock:true};
 assert.equal(imageReceiptSchema.safeParse(receipt).success,true);
 assert.equal(imageReceiptSchema.safeParse({...receipt,width:1024,height:1024}).success,false);
 assert.equal(imageReceiptSchema.safeParse({...receipt,schemaVersion:1}).success,false);
 const source={assetId:randomUUID(),sha256:hash,mimeType:'image/jpeg',byteLength:500000,width:600,height:800,name:'Lin.jpg',origin:{kind:'user-import'}};
 const version={id:randomUUID(),projectId:randomUUID(),groupId:randomUUID(),taskId:randomUUID(),number:1,assetId:randomUUID(),sha256:'b'.repeat(64),mimeType:'image/png',width:1152,height:1536,
  byteLength:100,isMock:true,providerId:'mock',model:IMAGE_MODELS.mock,options:{...IMAGE_FIXED_OPTIONS,size:'1152x1536'},createdAt:at,purpose:'edit',inputImage:{assetId:source.assetId,sha256:hash},sourceImage:source};
 assert.equal(imageVersionResponseSchema.safeParse(version).success,true);
 assert.equal(imageVersionResponseSchema.safeParse({...version,width:1024}).success,false,'dimensions must match the requested size');
});
