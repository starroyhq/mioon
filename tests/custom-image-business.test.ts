import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createImageSettings,createCustomImageSettings,IMAGE_SETTINGS_READ_CURRENT} from '../packages/business/src/images/settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION,DEFAULT_IMAGE_CONFIGURATION,getCustomImageDestination} from '../packages/contracts/src/image-settings.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS,canonicalImageInput} from '../packages/contracts/src/images.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import type { DatabaseSync } from 'node:sqlite';

const canonical=canonicalImageInput;
const config=(patch?: { baseUrl?: string; model?: string; }|undefined)=>({...structuredClone(DEFAULT_CUSTOM_IMAGE_CONFIGURATION),enabled:true,baseUrl:'https://images.example.com/provider/v1',model:'custom-fixture-model',...patch});
const memory=()=>{let value: unknown=null;return {load:async()=>structuredClone(value),save:async (next: unknown)=>{value=structuredClone(next);}};};
const generation=(projectId: string,patch={})=>({projectId,requestId:randomUUID(),name:'Custom image fixture',providerId:'openai-compatible',model:'custom-fixture-model',prompt:'Exact local synthetic description.',options:{...IMAGE_FIXED_OPTIONS},...patch});
const reviewInput=(review: { projectId: unknown; id: unknown; })=>({projectId:review.projectId,reviewId:review.id,expectedRevision:1});
async function fixture(t: test.TestContext,{autoRun=false,generate,beforeSubmit}: {autoRun?:boolean;generate?:(input: unknown,options: {configuration:unknown;beforeDispatch():void})=>Promise<{bytes:Buffer}>;beforeSubmit?:()=>void}={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-custom-image-business-')),customPersistence=memory(),officialPersistence=memory();
 let store=(openStore(root) as TypedStore),customSettings=await createCustomImageSettings({persistence:customPersistence}),settings=await createImageSettings({persistence:officialPersistence}),services: TypedServices,calls: { input: unknown; configuration: unknown; }[]=[];
 const gateway={generate:async(input: unknown,options: { configuration: unknown; beforeDispatch: () => void; })=>{calls.push({input:structuredClone(input),configuration:structuredClone(options.configuration)});beforeSubmit?.();options.beforeDispatch();return generate?generate(input,options):{bytes:await renderMockImagePng()};}};
 const create=()=>(createServices(store,new Map(),{env:{},imageOptions:{autoRun,settings,customSettings,customGateway:gateway as unknown as import('../packages/business/src/images/gateway.ts').Gateways,liveGateway:gateway as unknown as import('../packages/business/src/images/gateway.ts').Gateways}}) as TypedServices);
 services=create();
 await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
 const project=await services.call('project.create',{name:'Custom local fixture'}),other=await services.call('project.create',{name:'Other local fixture'});
 const f={root,project,other,calls,get store(){return store;},get services(){return services;},get customSettings(){return customSettings;},get settings(){return settings;},call:<O extends string>(operation: O,input: unknown)=>services.call(operation,input),input:(patch?: {}|undefined)=>generation(project.id,patch),
 async configure(configuration=config(),secret: {action:string;storage?:string;value?:string}={action:'replace',storage:'session',value:'custom-synthetic-secret'}){const old=await customSettings.get();return customSettings.put({expectedRevision:old.revision,configuration,secret});},
 async prepare(input: { projectId: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; name: string; providerId: string; model: string; prompt: string; options: { size: "1024x1024"; quality: "low"; outputFormat: "png"; background: "opaque"; n: 1; }; },settingsRevision?: unknown){settingsRevision??=(await customSettings.get()).revision;return services.call('image.review.prepare',{input,settingsRevision});},
 approve:async (review: {projectId: unknown; id: unknown})=>services.imageApproval(reviewInput(review)),
 async restart(){await services.drain();await settings.close();await customSettings.close();store.close();store=(openStore(root) as TypedStore);customSettings=await createCustomImageSettings({persistence:customPersistence});settings=await createImageSettings({persistence:officialPersistence});services=create();},
 async settled(id: unknown,state='succeeded'){const end=Date.now()+10000;while(Date.now()<end){const value=await services.call('image.task.get',{projectId:project.id,taskId:id});if(value.state===state)return value;if(['failed','outcome_unknown','local_result_error','succeeded'].includes(value.state))assert.fail(JSON.stringify(value));await pause(5);}assert.fail('Synthetic image did not settle');}
 };
 t.after(async()=>{await services.drain();await settings.close();await customSettings.close();store.close();rmSync(root,{recursive:true,force:true});});
 await f.configure();return f;
}
const imageRows=(db: DatabaseSync)=>JSON.stringify(['image_groups','image_tasks','image_versions','image_requests','image_reviews'].map(name=>[name,db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]));

test('custom review freezes exact backend connection and only private approval accepts a task',async t=>{
 const f=await fixture(t),input=f.input(),review=await f.prepare(input);
 assert.deepEqual(review.configuration,config());assert.equal(review.destination,getCustomImageDestination(config().baseUrl));assert.equal(review.input.prompt,input.prompt);
 assert.equal(JSON.parse((f.store.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(review.id)!.canonicalIntent as string)).schemaVersion,2);
 await assert.rejects(f.call('image.generate',input),{code:'IMAGE_REVIEW_REQUIRED'});assert.equal(f.calls.length,0);
 await assert.rejects(f.call('image.review.prepare',{input:{...input,requestId:randomUUID(),destination:'https://other.example.com/images/generations'},settingsRevision:1}),{code:'VALIDATION_ERROR'});
 const ack=await f.approve(review);assert.equal(ack.providerId,'openai-compatible');assert.equal(ack.state,'queued');assert.equal(f.calls.length,0);
 const before=imageRows(f.store.db);assert.deepEqual(await f.approve(review),ack);assert.deepEqual(await f.call('image.generate',input),ack);assert.equal(imageRows(f.store.db),before);
 await assert.rejects(async()=>f.services.imageApproval({...reviewInput(review),projectId:f.other.id}),{code:'IMAGE_REVIEW_NOT_FOUND'});assert.equal(imageRows(f.store.db),before);
});

test('destination or model changes invalidate unapproved review while exact historical preparation remains readable',async t=>{
 const f=await fixture(t),input=f.input(),review=await f.prepare(input),before=imageRows(f.store.db);
 await f.configure(config({baseUrl:'https://second.example.com/new-prefix'}));
 await assert.rejects(f.approve(review),{code:'IMAGE_REVIEW_SETTINGS_CHANGED'});assert.equal(imageRows(f.store.db),before);
 assert.deepEqual(await f.prepare(input,1),review);assert.equal(f.calls.length,0);
 const current=await f.prepare(f.input()),secondBefore=imageRows(f.store.db);await f.configure(config({baseUrl:'https://second.example.com/new-prefix',model:'different-model'}));
 await assert.rejects(f.approve(current),{code:'IMAGE_REVIEW_SETTINGS_CHANGED'});assert.equal(imageRows(f.store.db),secondBefore);
});

test('accepted custom ACK survives settings changes and recreated backend without new acquisition or execution',async t=>{
 const f=await fixture(t),input=f.input(),review=await f.prepare(input),ack=await f.approve(review);
 const raw=f.store.db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(input.requestId)!.response;
 await f.configure(config({baseUrl:'https://other.example.com/v2'}));await f.restart();
 assert.equal((await f.customSettings.get()).secret.configured,false);
 assert.equal((await f.call('image.task.get',{projectId:f.project.id,taskId:ack.id})).state,'interrupted_before_dispatch');
 const before=imageRows(f.store.db);assert.deepEqual(await f.approve(review),ack);assert.deepEqual(await f.call('image.request.get',{projectId:f.project.id,requestId:input.requestId}),{projectId:f.project.id,requestId:input.requestId,operation:'image.generate',response:ack});
 assert.equal(f.store.db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(input.requestId)!.response,raw);assert.equal(imageRows(f.store.db),before);assert.equal(f.calls.length,0);
 const historical=await f.call('image.review.get',{projectId:f.project.id,reviewId:review.id});assert.deepEqual(historical.configuration,config());assert.equal(historical.destination,review.destination);
});

test('new custom source version reuses managed image lineage without changing official version or prior receipt',async t=>{
 const f=await fixture(t,{autoRun:true});await f.settings.put({expectedRevision:0,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:true},secret:{action:'replace',storage:'session',value:'official-synthetic-secret'}});
 const official=f.input({providerId:'openai',model:IMAGE_MODELS.openai}),firstReview=await f.prepare(official,1),firstAck=await f.approve(firstReview),first=await f.settled(firstAck.id);
 const originalVersion=f.store.db.prepare('SELECT data FROM image_versions WHERE id=?').get(first.versionId)!.data,originalReceipt=f.store.db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(official.requestId)!.response;
 const asset=JSON.parse(f.store.db.prepare('SELECT data FROM assets WHERE id=?').get(JSON.parse(originalVersion as string).assetId)!.data as string),bytes=readFileSync(path.join(f.root,asset.relativePath));
 const group=await f.call('image.group.get',{projectId:f.project.id,groupId:first.groupId});const custom=f.input({groupId:group.id,expectedRevision:group.revision});const secondReview=await f.prepare(custom),secondAck=await f.approve(secondReview),second=await f.settled(secondAck.id);
 const versions=await f.call('image.version.list',{projectId:f.project.id,groupId:group.id});assert.equal(versions.items.length,2);assert.equal(versions.items[0].providerId,'openai-compatible');assert.equal(versions.items[1].providerId,'openai');assert.notEqual(second.versionId,first.versionId);
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].configuration,config());assert.equal(f.store.db.prepare('SELECT data FROM image_versions WHERE id=?').get(first.versionId)!.data,originalVersion);assert.equal(f.store.db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(official.requestId)!.response,originalReceipt);assert.deepEqual(readFileSync(path.join(f.root,asset.relativePath)),bytes);
 await f.configure(config({baseUrl:'https://later.example.com/v1'}));assert.deepEqual(await f.call('image.generate',official),firstAck);assert.equal(f.calls.length,2);
});

test('current custom profile is optional discovery and never supplies historical task destination',async t=>{
 const f=await fixture(t),input=f.input(),review=await f.prepare(input);const profile=await f.call('image.profile.list',{});
 assert.equal(profile.items.length,3);assert.equal(profile.items[2].providerId,'openai-compatible');assert.equal(profile.liveEnabled,true);
 await f.configure({...config(),enabled:false},{action:'remove'});const next=await f.call('image.profile.list',{});assert.equal(next.items[2].enabled,false);assert.equal(next.liveEnabled,false);assert.deepEqual((await f.call('image.review.get',{projectId:f.project.id,reviewId:review.id})).configuration,review.configuration);assert.equal(f.calls.length,0);
});

test('corrupt replay provider identity is refused even when custom model equals an official model identifier',async t=>{
 const f=await fixture(t);await f.configure(config({model:IMAGE_MODELS.openai}));const input=f.input({model:IMAGE_MODELS.openai}),review=await f.prepare(input),ack=await f.approve(review),cancel={projectId:f.project.id,taskId:ack.id,expectedRevision:1,requestId:randomUUID()};
 const result=await f.call('image.task.cancelQueued',cancel);f.store.db.exec('DROP TRIGGER immutable_image_requests');f.store.db.prepare('UPDATE image_requests SET response=? WHERE requestId=?').run(JSON.stringify({...result,providerId:'openai'}),cancel.requestId);
 const before=imageRows(f.store.db);await assert.rejects(f.call('image.request.get',{projectId:f.project.id,requestId:cancel.requestId}),{code:'IMAGE_RECORD_INVALID'});await assert.rejects(f.call('image.task.cancelQueued',cancel),{code:'IMAGE_RECORD_INVALID'});assert.equal(imageRows(f.store.db),before);assert.equal(f.calls.length,0);
});

test('custom reads and replay fail closed on invalid retained review destination without exposing or changing foreign data',async t=>{
 const f=await fixture(t),input=f.input(),review=await f.prepare(input),ack=await f.approve(review);
 f.store.db.exec('DROP TRIGGER immutable_image_review_identity; DROP TRIGGER image_review_state_transitions; PRAGMA ignore_check_constraints=ON;');
 const raw=JSON.parse((f.store.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(review.id)!.canonicalIntent as string));raw.destination='https://foreign.example.com/stolen/images/generations';f.store.db.prepare('UPDATE image_reviews SET canonicalIntent=? WHERE id=?').run(canonical(raw),review.id);f.store.db.exec('PRAGMA ignore_check_constraints=OFF');
 const before=imageRows(f.store.db);for(const [op,value]of [['image.task.get',{projectId:f.project.id,taskId:ack.id}],['image.generate',input],['image.review.get',{projectId:f.project.id,reviewId:review.id}]] as const)await assert.rejects(f.call(op,value),e=>(e as {code:string}).code==='IMAGE_REVIEW_INVALID'&&!JSON.stringify(e).includes('foreign.example.com'));assert.equal(imageRows(f.store.db),before);assert.equal(f.calls.length,0);
});


test('custom pre-dispatch connection failure retains a safe reason without consuming the review attempt',async t=>{
 const f=await fixture(t,{autoRun:true,beforeSubmit:()=>{throw Object.assign(Error('SYNTHETIC_PRIVATE_SENTINEL'),{code:'IMAGE_NETWORK_DENIED'});}}),input=f.input(),review=await f.prepare(input),ack=await f.approve(review),task=await f.settled(ack.id,'failed');
 assert.equal(task.errorCode,'IMAGE_NETWORK_DENIED');assert.equal(task.dispatched,false);assert.ok(!JSON.stringify(task).includes('SYNTHETIC_PRIVATE_SENTINEL'));const retained=await f.call('image.review.get',{projectId:f.project.id,reviewId:review.id});assert.equal(retained.postAttempts,0);assert.equal(retained.state,'approved');assert.equal(f.calls.length,1);
 const before=imageRows(f.store.db);assert.deepEqual(await f.approve(review),ack);assert.equal(f.calls.length,1);assert.equal(imageRows(f.store.db),before);
});

test('custom connection error after dispatch remains unknown and never suggests a confirmed no-charge failure',async t=>{
 const f=await fixture(t,{autoRun:true,generate:()=>{throw Object.assign(Error('SYNTHETIC_PRIVATE_SENTINEL'),{code:'IMAGE_CONNECTION_FAILED'});}}),input=f.input(),review=await f.prepare(input),ack=await f.approve(review),task=await f.settled(ack.id,'outcome_unknown');
 assert.equal(task.errorCode,'IMAGE_OUTCOME_UNKNOWN');assert.equal(task.dispatched,true);assert.equal((await f.call('image.review.get',{projectId:f.project.id,reviewId:review.id})).postAttempts,1);await f.restart();assert.deepEqual(await f.approve(review),ack);assert.equal(f.calls.length,1);
});
