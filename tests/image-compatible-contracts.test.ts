import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, imageSchemas, imageSnapshotSchema, imageReceiptSchema, imageVersionResponseSchema, imageProfilesResponseSchema, canonicalImageInput} from '../packages/contracts/src/images.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION, CUSTOM_IMAGE_PROFILE_ID, CUSTOM_IMAGE_SETTINGS_NAMESPACE, customImageConfigurationSchema, customImageSettingsUpdateSchema, customImageSettingsResultSchema, imageConfigurationSchema, normalizeCustomImageBaseUrl, getCustomImageDestination} from '../packages/contracts/src/image-settings.ts';
import {IMAGE_REVIEW_POLICY, IMAGE_REVIEW_DESTINATION, imageReviewIntentSchema, imageReviewResponseSchema, imageReviewSchemas} from '../packages/contracts/src/image-reviews.ts';
const config = () => ({...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled:true, baseUrl:'https://images.example.test/team/v1', model:'vendor/image-model:revision'});
const generation = () => ({projectId:randomUUID(),requestId:randomUUID(),name:'Custom image',providerId:'openai-compatible',model:config().model,prompt:'Original exact prompt',options:{...IMAGE_FIXED_OPTIONS}});
const intent = () => { const configuration=config();return {schemaVersion:2,reviewId:randomUUID(),input:generation(),settingsRevision:4,destination:getCustomImageDestination(configuration.baseUrl),policy:{...IMAGE_REVIEW_POLICY},configuration}; };
function dto(value: Omit<ReturnType<typeof intent>, 'configuration'> & {configuration?: ReturnType<typeof intent>['configuration']}){const at='2026-10-10T00:00:00.000Z';return {id:value.reviewId,projectId:value.input.projectId,requestId:value.input.requestId,input:value.input,inputHash:'a'.repeat(64),settingsRevision:value.settingsRevision,destination:value.destination,policy:value.policy,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null,configuration:value.configuration};}

test('custom endpoint normalization is explicit, bounded and never repairs ambiguous input',()=>{
 assert.equal(normalizeCustomImageBaseUrl('https://IMAGES.EXAMPLE.TEST:443/team/v1/'),'https://images.example.test/team/v1');
 assert.equal(getCustomImageDestination('https://images.example.test'),'https://images.example.test/images/generations');
 const rejected=['http://images.example.test/v1','https://images.example.test:8443/v1','https://user:pass@images.example.test/v1','https://images.example.test/v1?key=x','https://images.example.test/v1#fragment','https://images.example.test/%2e%2e','https://images.example.test/v1/../other','https://images.example.test/./v1','https://images.example.test//v1','https://images.example.test/v1//','https://images.example.test/v1\\other','https://127.0.0.1/v1','https://[::1]/v1','https://0x7f000001/v1','https://0177.0.0.1/v1','https://localhost/v1','https://images.example.test./v1','https://-images.example.test/v1','https://images.example.test/中文',' https://images.example.test/v1','https://images.example.test/'+ 'a'.repeat(2048)];
 for(const value of rejected)assert.throws(()=>normalizeCustomImageBaseUrl(value),value);
 for(const baseUrl of ['https://IMAGES.EXAMPLE.TEST/v1','https://images.example.test:443/v1','https://images.example.test/v1/'])assert.equal(customImageConfigurationSchema.safeParse({...config(),baseUrl}).success,false);
});

test('separate custom setting slot accepts empty disabled defaults and requires complete fixed profile to enable',()=>{
 assert.equal(CUSTOM_IMAGE_SETTINGS_NAMESPACE,'mioon.images.openai-compatible.v1');assert.equal(CUSTOM_IMAGE_PROFILE_ID,'openai-images-json-png-v1');
 assert.ok(customImageConfigurationSchema.safeParse(DEFAULT_CUSTOM_IMAGE_CONFIGURATION).success);assert.ok(customImageConfigurationSchema.safeParse(config()).success);
 for(const patch of [{enabled:true,baseUrl:'',model:''},{baseUrl:''},{model:''},{connectionId:'another'},{profileId:'arbitrary'},{providerId:'openai'},{model:' '},{model:'a b'},{model:'a\nb'},{model:'x'.repeat(121)},{options:{...IMAGE_FIXED_OPTIONS,n:2}},{headers:{Authorization:'secret'}}])assert.equal(customImageConfigurationSchema.safeParse({...config(),...patch}).success,false,JSON.stringify(patch));
 assert.equal(imageConfigurationSchema.safeParse(config()).success,false);
 assert.ok(customImageSettingsUpdateSchema.safeParse({expectedRevision:0,configuration:config(),secret:{action:'replace',storage:'session',value:'synthetic-test'}}).success);
 assert.equal(customImageSettingsResultSchema.safeParse({revision:0,configuration:DEFAULT_CUSTOM_IMAGE_CONFIGURATION,secret:{configured:true,storage:'session'},storage:{persistentAvailable:false,sessionScope:'server',reasonCode:'WEB_SESSION_ONLY'}}).success,false);
});

test('custom content uses existing exact image input/snapshot/receipt/version shapes without authority fields',()=>{
 const input=generation(),ids={groupId:randomUUID(),taskId:randomUUID()};assert.deepEqual(imageSchemas['image.generate'].parse(input),input);
 const {requestId,...content}=input;assert.ok(imageSnapshotSchema.safeParse({schemaVersion:1,...content,...ids}).success);
 for(const extra of [{configuration:config()},{endpoint:config().baseUrl},{connectionId:'custom'},{approved:true},{reviewId:randomUUID()}])assert.equal(imageSchemas['image.generate'].safeParse({...input,...extra}).success,false);
 for(const providerId of ['mock','openai'])assert.equal(imageSchemas['image.generate'].safeParse({...input,providerId}).success,false);
 const receipt={schemaVersion:1,taskId:ids.taskId,projectId:input.projectId,groupId:ids.groupId,inputHash:'a'.repeat(64),assetId:randomUUID(),versionId:randomUUID(),sha256:'b'.repeat(64),mimeType:'image/png',width:1024,height:1024,byteLength:100,isMock:false};assert.ok(imageReceiptSchema.safeParse(receipt).success);
 const version={id:receipt.versionId,projectId:receipt.projectId,groupId:receipt.groupId,taskId:receipt.taskId,number:1,assetId:receipt.assetId,sha256:receipt.sha256,mimeType:receipt.mimeType,width:1024,height:1024,byteLength:100,isMock:false,providerId:input.providerId,model:input.model,options:input.options,createdAt:'2026-10-10T00:00:00Z'};assert.ok(imageVersionResponseSchema.safeParse(version).success);
 const profile={providerId:input.providerId,model:input.model,name:'Custom',enabled:true,isMock:false,evidence:'offline-tested-not-live',options:input.options};assert.ok(imageProfilesResponseSchema.safeParse({items:[profile],liveEnabled:true}).success);assert.equal(imageProfilesResponseSchema.safeParse({items:[profile],liveEnabled:false}).success,false);
});

test('custom v2 review freezes the full exact configured recipient, model, slot and profile',()=>{
 const value=intent();assert.ok(imageReviewIntentSchema.safeParse(value).success);assert.ok(imageReviewResponseSchema.safeParse(dto(value)).success);
 assert.ok(imageReviewSchemas['image.review.prepare'].safeParse({input:value.input,settingsRevision:4}).success);
 for(const patch of [{schemaVersion:1},{configuration:undefined},{destination:IMAGE_REVIEW_DESTINATION},{configuration:{...value.configuration,baseUrl:'https://other.example.test/v1'}},{configuration:{...value.configuration,enabled:false}},{configuration:{...value.configuration,baseUrl:''}},{configuration:{...value.configuration,model:'other'}},{configuration:{...value.configuration,connectionId:'other'}},{configuration:{...value.configuration,profileId:'other'}},{configuration:{...value.configuration,apiKey:'secret'}},{input:{...value.input,providerId:'openai',model:IMAGE_MODELS.openai}}])assert.equal(imageReviewIntentSchema.safeParse({...value,...patch}).success,false);
 assert.equal(imageReviewResponseSchema.safeParse({...dto(value),configuration:undefined}).success,false);
 const official={schemaVersion:1,reviewId:randomUUID(),input:{...value.input,providerId:'openai',model:IMAGE_MODELS.openai},settingsRevision:1,destination:IMAGE_REVIEW_DESTINATION,policy:IMAGE_REVIEW_POLICY};const bytes=canonicalImageInput(official);assert.equal(canonicalImageInput(imageReviewIntentSchema.parse(official)),bytes);assert.equal(imageReviewIntentSchema.safeParse({...official,configuration:value.configuration}).success,false);
 const officialDto=dto({...official,configuration:undefined});delete officialDto.configuration;const oldBytes=JSON.stringify(officialDto);assert.ok(imageReviewResponseSchema.safeParse(officialDto).success);assert.equal(JSON.stringify(officialDto),oldBytes);assert.equal(canonicalImageInput(imageReviewResponseSchema.parse(officialDto)),canonicalImageInput(officialDto));
});
