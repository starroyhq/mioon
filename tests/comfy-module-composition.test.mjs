import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {composeOfficialComfyModule,comfyModuleModeFromEnvironment} from '../apps/server/src/comfy-module.ts';
import {createComfyAdmission} from '../packages/business/src/comfy/admission.ts';
import {comfyConnectorAvailability,comfyConnectorAvailabilitySchema} from '../packages/contracts/src/comfy-availability.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {utilityEnvironment} from '../apps/desktop/src/config.ts';

test('fixed composition constructs only the loaded reviewed factory and snapshots admission',()=>{
 let calls=0;const connector=Object.freeze({check(){},submit(){},observe(){}}),factory=()=>{calls++;return connector;};
 for(const [mode,state,reason] of [['skip','not_loaded','startup_not_loaded'],['not-provided','not_provided','distribution_not_provided'],['load','available','ready']]){
  const composed=composeOfficialComfyModule(mode,factory);
  assert.deepEqual(composed.availability,{schemaVersion:1,connectorId:'mioon.comfy-local',implementationVersion:'1',state,reason,fixedForSession:true});
  assert.equal(composed.connector,mode==='load'?connector:undefined);
  assert.equal(Object.isFrozen(composed),true);assert.equal(Object.isFrozen(composed.availability),true);
  const declaration={...composed.availability},admission=createComfyAdmission(composed.connector,declaration);
  declaration.state='available';
  if(mode==='load')assert.doesNotThrow(()=>admission.assertAvailable());
  else assert.throws(()=>admission.assertAvailable(),{code:'COMFY_MODULE_UNAVAILABLE',status:503});
 }
 assert.equal(calls,1);
});
test('availability has no executable selector, inconsistent or forged declarations fail closed',()=>{
 const available=comfyConnectorAvailability('load'),absent=comfyConnectorAvailability('not-provided');
 for(const changed of [{...available,reason:'startup_not_loaded'},{...available,connectorId:'user.module'}, {...available,implementationVersion:'2'},{...available,fixedForSession:false},{...available,modulePath:'/tmp/plugin.js'},{...available,permissions:['*']}])assert.equal(comfyConnectorAvailabilitySchema.safeParse(changed).success,false);
 assert.throws(()=>createComfyAdmission(undefined,available));assert.throws(()=>createComfyAdmission({},absent));
 assert.throws(()=>composeOfficialComfyModule('unknown',()=>assert.fail('must not construct')));
});
test('launcher opt-out accepts only fixed load/skip values, not distribution claims or code paths',()=>{
 assert.equal(comfyModuleModeFromEnvironment(undefined),'load');
 assert.equal(comfyModuleModeFromEnvironment('load'),'load');assert.equal(comfyModuleModeFromEnvironment('skip'),'skip');
 for(const value of ['',null,0,false,'false','not-provided','not_loaded','./plugin.mjs','https://invalid.example/a.js',{},['skip']])assert.throws(()=>comfyModuleModeFromEnvironment(value));
});
test('module availability adds no RPC admin authority and existing remote discovery remains static',()=>{
 for(const name of ['image.generate','image.review.prepare','image.task.remote.get','image.task.observeRemote'])assert.ok(schemas[name]);
 for(const name of ['image.comfy.settings','image.comfy.check','image.comfy.module.set','comfy.module.load'])assert.equal(schemas[name],undefined);
 const index=readFileSync(new URL('../apps/server/src/index.ts',import.meta.url),'utf8');
 assert.ok(index.indexOf('if (!auth(req))')<index.indexOf('if (await comfyHttp(req,res,url))'));
 const config=readFileSync(new URL('../apps/desktop/src/config.ts',import.meta.url),'utf8');
 assert.ok(config.includes("'MIOON_COMFY_MODULE'"));
 assert.ok(readFileSync(new URL('../apps/desktop/src/backend.ts',import.meta.url),'utf8').includes('comfyModuleModeFromEnvironment(process.env.MIOON_COMFY_MODULE)'));
});

test('desktop forwards only the bounded launcher decision, not ambient code injection',()=>{
 const env=utilityEnvironment({MIOON_COMFY_MODULE:'skip',MIOON_COMFY_MODULE_PATH:'/tmp/evil.mjs',NODE_OPTIONS:'--import evil',UNRELATED_SECRET:'private'}, {ffmpeg:'/trusted/ffmpeg',ffprobe:'/trusted/ffprobe'});
 assert.equal(env.MIOON_COMFY_MODULE,'skip');
 assert.equal(env.MIOON_COMFY_MODULE_PATH,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.UNRELATED_SECRET,undefined);
 assert.equal(comfyModuleModeFromEnvironment(env.MIOON_COMFY_MODULE),'skip');
 assert.equal(comfyModuleModeFromEnvironment(utilityEnvironment({},{}).MIOON_COMFY_MODULE),'load');
});
