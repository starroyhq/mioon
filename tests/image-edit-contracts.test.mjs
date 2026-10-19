import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {IMAGE_MODELS,IMAGE_FIXED_OPTIONS,IMAGE_EDIT_LIMITS,imageSchemas,imageEditSourceSchema,imageAdapterInputSchema,imageSnapshotSchema,imageTaskResponseSchema,imageVersionResponseSchema,isImageTaskResponse,isImageVersionResponse,isImageMutationResponse,canonicalImageInput} from '../packages/contracts/src/images.ts';
import {IMAGE_REVIEW_POLICY,IMAGE_REVIEW_DESTINATION,IMAGE_EDIT_REVIEW_DESTINATION,imageReviewSchemas,imageReviewIntentSchema,imageReviewResponseSchema,isImageReviewResponse,isImageReviewPreparationResponse} from '../packages/contracts/src/image-reviews.ts';
const at='2026-10-11T00:00:00.000Z',hash='a'.repeat(64);
const legacy=()=>({projectId:randomUUID(),requestId:randomUUID(),name:'Source edit',providerId:'mock',model:IMAGE_MODELS.mock,prompt:'Keep the framing and make it blue',options:{...IMAGE_FIXED_OPTIONS}});
const source=()=>({assetId:randomUUID(),sha256:hash,mimeType:'image/png',byteLength:512,width:320,height:180,name:'Source.png',origin:{kind:'user-import'}});
function fixture(){const sourceImage=source(),input={...legacy(),purpose:'edit',inputImage:{assetId:sourceImage.assetId,sha256:sourceImage.sha256}},groupId=randomUUID(),taskId=randomUUID();const {projectId,requestId,name,...adapter}=input;
 return {sourceImage,input,adapter:{...adapter,sourceImage},snapshot:{schemaVersion:1,projectId,groupId,taskId,name,...adapter,sourceImage},task:{...input,id:taskId,groupId,sourceImage,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:at,updatedAt:at}};}

test('edit input is one strict paired source reference on mock or official OpenAI only',()=>{
 for(const providerId of ['mock','openai']){const f=fixture(),input={...f.input,providerId,model:IMAGE_MODELS[providerId]};assert.deepEqual(imageSchemas['image.generate'].parse(input),input);}
 const f=fixture();
 for(const mutate of [v=>{delete v.purpose;},v=>{delete v.inputImage;},v=>{v.purpose='generate';},v=>{v.inputImage=null;},v=>{v.inputImage.assetId='bad';},v=>{v.inputImage.sha256='A'.repeat(64);},v=>{v.inputImage.path='/private/source.png';},v=>{v.sourceImage=f.sourceImage;},v=>{v.mask={assetId:randomUUID(),sha256:hash};},v=>{v.providerId='openai-compatible';v.model='vendor/model';},v=>{v.providerId='comfy-local';},v=>{v.providerId='openai';},v=>{v.options.n=2;},v=>{v.groupId=randomUUID();}]){const input=structuredClone(f.input);mutate(input);assert.equal(imageSchemas['image.generate'].safeParse(input).success,false,JSON.stringify(input));}
 const old=legacy(),raw=canonicalImageInput(old);assert.equal(canonicalImageInput(imageSchemas['image.generate'].parse(old)),raw);assert.ok(!Object.hasOwn(imageSchemas['image.generate'].parse(old),'purpose'));
});

test('edit source descriptor is bounded and has exactly one typed origin, never file/transport data',()=>{
 const imageSource={imageGroupId:randomUUID(),imageTaskId:randomUUID(),imageVersionId:randomUUID()},frameSource={frameTaskId:randomUUID(),sourceAssetId:randomUUID(),sourceHash:hash,sourceFrame:0,fps:30,profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1'};
 for(const origin of [{kind:'user-import'},{kind:'generated',imageSource},{kind:'synthetic-mock',imageSource},{kind:'extracted-frame',frameSource}])assert.ok(imageEditSourceSchema.safeParse({...source(),origin}).success);
 for(const patch of [{byteLength:0},{byteLength:IMAGE_EDIT_LIMITS.sourceBytes+1},{width:1025},{height:0},{mimeType:'image/jpeg'},{name:' '},{name:'x'.repeat(201)},{relativePath:'media/source.png'},{bytes:'base64'},{origin:{kind:'user-import',imageSource}},{origin:{kind:'generated'}},{origin:{kind:'generated',imageSource:{...imageSource,url:'https://private.test'}}},{origin:{kind:'extracted-frame',frameSource:{...frameSource,fps:60}}},{origin:{kind:'extracted-frame',frameSource,imageSource}}])assert.equal(imageEditSourceSchema.safeParse({...source(),...patch}).success,false,JSON.stringify(patch));
});

test('edit snapshot, adapter and safe task/version DTO freeze identity and keep historical omissions',()=>{
 const f=fixture();assert.deepEqual(imageAdapterInputSchema.parse(f.adapter),f.adapter);assert.deepEqual(imageSnapshotSchema.parse(f.snapshot),f.snapshot);assert.deepEqual(imageTaskResponseSchema.parse(f.task),f.task);assert.ok(isImageMutationResponse('image.generate',f.input,f.task));
 for(const patch of [{sourceImage:{...f.sourceImage,sha256:'b'.repeat(64)}},{sourceImage:{...f.sourceImage,assetId:randomUUID()}},{purpose:undefined},{inputImage:undefined},{sourceImage:undefined}]){assert.equal(imageSnapshotSchema.safeParse({...f.snapshot,...patch}).success,false);assert.equal(imageTaskResponseSchema.safeParse({...f.task,...patch}).success,false);}
 for(const patch of [{inputImage:{...f.input.inputImage,sha256:'b'.repeat(64)},sourceImage:{...f.sourceImage,sha256:'b'.repeat(64)}},{inputImage:{...f.input.inputImage,assetId:randomUUID()},sourceImage:{...f.sourceImage,assetId:randomUUID()}},{purpose:undefined,inputImage:undefined,sourceImage:undefined}])assert.equal(isImageMutationResponse('image.generate',f.input,{...f.task,...patch}),false);
 const version={id:randomUUID(),projectId:f.input.projectId,groupId:f.task.groupId,taskId:f.task.id,number:1,assetId:randomUUID(),sha256:hash,mimeType:'image/png',width:1024,height:1024,byteLength:512,isMock:true,providerId:'mock',model:IMAGE_MODELS.mock,options:{...IMAGE_FIXED_OPTIONS},createdAt:at,purpose:'edit',inputImage:f.input.inputImage,sourceImage:f.sourceImage};
 assert.deepEqual(imageVersionResponseSchema.parse(version),version);assert.equal(imageVersionResponseSchema.safeParse({...version,assetId:f.sourceImage.assetId}).success,false);
 const {purpose:_,inputImage:__,sourceImage:___,...old}=version,raw=JSON.stringify(old);assert.equal(JSON.stringify(imageVersionResponseSchema.parse(old)),raw);assert.equal(imageVersionResponseSchema.safeParse({...old,sourceImage:f.sourceImage}).success,false);
});

test('edit approval binds review intent v4 to one source and edits URL; public prepare never accepts a descriptor',()=>{
 const f=fixture(),input={...f.input,providerId:'openai',model:IMAGE_MODELS.openai},id=randomUUID(),intent={schemaVersion:4,reviewId:id,input,settingsRevision:7,destination:IMAGE_EDIT_REVIEW_DESTINATION,policy:{...IMAGE_REVIEW_POLICY},sourceImage:f.sourceImage};
 assert.deepEqual(imageReviewIntentSchema.parse(intent),intent);assert.ok(imageReviewSchemas['image.review.prepare'].safeParse({input,settingsRevision:7}).success);assert.equal(imageReviewSchemas['image.review.prepare'].safeParse({input,settingsRevision:7,sourceImage:f.sourceImage}).success,false);
 for(const mutate of [v=>{v.schemaVersion=1;},v=>{v.destination=IMAGE_REVIEW_DESTINATION;},v=>{delete v.sourceImage;},v=>{v.sourceImage.sha256='b'.repeat(64);},v=>{delete v.input.purpose;},v=>{v.input.sourceImage=f.sourceImage;},v=>{v.input.providerId='mock';v.input.model=IMAGE_MODELS.mock;}]){const changed=structuredClone(intent);mutate(changed);assert.equal(imageReviewIntentSchema.safeParse(changed).success,false);}
 const response={id,projectId:input.projectId,requestId:input.requestId,input,inputHash:hash,settingsRevision:7,destination:IMAGE_EDIT_REVIEW_DESTINATION,policy:{...IMAGE_REVIEW_POLICY},sourceImage:f.sourceImage,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null};
 assert.ok(imageReviewResponseSchema.safeParse(response).success);assert.ok(isImageReviewPreparationResponse({input,settingsRevision:7},response));
 const changedInput={...input,inputImage:{...input.inputImage,sha256:'b'.repeat(64)}},changedResponse={...response,input:changedInput,sourceImage:{...f.sourceImage,sha256:'b'.repeat(64)}};assert.ok(imageReviewResponseSchema.safeParse(changedResponse).success);assert.equal(isImageReviewPreparationResponse({input,settingsRevision:7},changedResponse),false);
 const {purpose:_,inputImage:__,...oldInput}=input,oldIntent={schemaVersion:1,reviewId:id,input:oldInput,settingsRevision:7,destination:IMAGE_REVIEW_DESTINATION,policy:{...IMAGE_REVIEW_POLICY}},raw=canonicalImageInput(oldIntent);assert.equal(canonicalImageInput(imageReviewIntentSchema.parse(oldIntent)),raw);
});

test('every edit parser rejects malformed source combinations without throwing from a dirty union branch',()=>{
 const f=fixture(),input={...f.input,providerId:'openai',model:IMAGE_MODELS.openai},reviewId=randomUUID();
 const version={id:randomUUID(),projectId:f.input.projectId,groupId:f.task.groupId,taskId:f.task.id,number:1,assetId:randomUUID(),sha256:hash,mimeType:'image/png',width:1024,height:1024,byteLength:512,isMock:true,providerId:'mock',model:IMAGE_MODELS.mock,options:{...IMAGE_FIXED_OPTIONS},createdAt:at,purpose:'edit',inputImage:f.input.inputImage,sourceImage:f.sourceImage};
 const intent={schemaVersion:4,reviewId,input,settingsRevision:1,destination:IMAGE_EDIT_REVIEW_DESTINATION,policy:{...IMAGE_REVIEW_POLICY},sourceImage:f.sourceImage};
 const review={id:reviewId,projectId:input.projectId,requestId:input.requestId,input,inputHash:hash,settingsRevision:1,destination:IMAGE_EDIT_REVIEW_DESTINATION,policy:{...IMAGE_REVIEW_POLICY},sourceImage:f.sourceImage,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null};
 const records=[[imageAdapterInputSchema,f.adapter],[imageSnapshotSchema,f.snapshot],[imageTaskResponseSchema,f.task],[imageVersionResponseSchema,version],[imageReviewIntentSchema,intent],[imageReviewResponseSchema,review]];
 const missing=Symbol('missing'),badValues=[missing,undefined,null,false,0,'invalid',[],{}];
 const set=(object,key,value)=>{if(value===missing)delete object[key];else object[key]=value;};
 for(const [schema,original] of records){
  const parseInvalid=value=>{let parsed;assert.doesNotThrow(()=>{parsed=schema.safeParse(value);});assert.equal(parsed.success,false);const guard=schema===imageTaskResponseSchema?isImageTaskResponse:schema===imageVersionResponseSchema?isImageVersionResponse:schema===imageReviewResponseSchema?isImageReviewResponse:null;if(guard)assert.equal(guard(value),false);if(schema===imageTaskResponseSchema)assert.equal(isImageMutationResponse('image.generate',f.input,value),false);};
  for(const inputImage of badValues)for(const sourceImage of badValues){const value=structuredClone(original),input=value.input??value;set(input,'inputImage',inputImage);set(value,'sourceImage',sourceImage);parseInvalid(value);}
  for(const key of ['purpose','inputImage'])for(const malformed of badValues){const value=structuredClone(original);set(value.input??value,key,malformed);parseInvalid(value);}
  for(const field of ['assetId','sha256'])for(const malformed of badValues){const value=structuredClone(original);set((value.input??value).inputImage,field,malformed);parseInvalid(value);}
  for(const field of ['assetId','sha256','mimeType','byteLength','width','height','name','origin'])for(const malformed of badValues){const value=structuredClone(original);set(value.sourceImage,field,field==='name'&&malformed==='invalid'?'':malformed);parseInvalid(value);}
  for(const malformed of badValues)parseInvalid(malformed===missing?undefined:malformed);
  // Exact legacy omission remains valid only in its own branch, not as a v4
  // intent or an edit receipt with only one additive field left behind.
  const partial=structuredClone(original);delete (partial.input??partial).purpose;delete (partial.input??partial).inputImage;parseInvalid(partial);
 }
});
