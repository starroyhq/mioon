import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {defaultVideoModels,effectiveVideoParameters,getVideoGenerationIssue,parseVideoBinding,resolveVideoEndpoint,validateVideoSnapshot,videoBindingCapabilities,videoConnectionConfigurationSchema,videoInputProfile,videoTemplate} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';
import {getCapabilityProfile} from '../packages/contracts/src/generation-input-profiles.ts';
import type {GenerationInputProfile} from '../packages/contracts/src/generation-input-profiles.ts';

function binding(resolutions:string[]=['2K']):VideoExecutionBinding {
  const model=defaultVideoModels('minimax')[0]!;
  model.durationResolutionMap=[{duration:[4,8],resolution:resolutions}];
  return {version:1,connectionId:randomUUID(),configurationRevision:1,providerId:'minimax',region:'global',workspaceId:'',endpoint:resolveVideoEndpoint('minimax','global'),credentialRef:randomUUID(),model,outputHosts:[]};
}
const snapshot=(parameters:Record<string,unknown>={})=>({providerId:'minimax',model:'MiniMax-H3',prompt:'A synthetic shape moves.',aspectRatio:'16:9',duration:4,parameters,referenceAssets:[]});
const resolutionValues=(profile:GenerationInputProfile)=>{const rule=profile.parameters.resolution;assert.ok(rule?.type==='enum');return rule.values;};

test('new MiniMax defaults and legacy input profiles advertise only the official SDK 2K submission capability',()=>{
  const models=defaultVideoModels('minimax');
  assert.equal(models.length,1);
  assert.deepEqual(models[0]!.durationResolutionMap,[{duration:[4,8],resolution:['2K']}]);
  for(const region of ['global','cn'])assert.equal(getCapabilityProfile('minimax','MiniMax-H3',region)?.output.resolution,'2K');
  const current=binding(),before=structuredClone(current),capabilities=videoBindingCapabilities(current);
  assert.deepEqual(resolutionValues(videoInputProfile(current)),['2K']);
  assert.deepEqual(capabilities.modelCapabilities[0]!.resolutions,['2K']);
  assert.equal(validateVideoSnapshot(current,snapshot()),true);
  assert.equal(validateVideoSnapshot(current,snapshot({resolution:'2K'})),true);
  assert.equal(getVideoGenerationIssue(snapshot(),capabilities),null);
  assert.deepEqual(current,before);
});

test('historical MiniMax 768P settings and frozen bindings remain readable without rewriting their original capabilities',()=>{
  const legacy=binding(['768P']),before=structuredClone(legacy);
  assert.deepEqual(videoTemplate('minimax-v2').resolutions,['2K','768P']);
  assert.deepEqual(parseVideoBinding(legacy),legacy);
  assert.equal(videoConnectionConfigurationSchema.safeParse({id:legacy.connectionId,providerId:legacy.providerId,name:'Historical account',region:legacy.region,workspaceId:'',enabled:true,archived:false,models:[legacy.model],outputHosts:[]}).success,true);
  assert.deepEqual(legacy,before);
  assert.throws(()=>parseVideoBinding({...legacy,model:{...legacy.model,durationResolutionMap:[{duration:[4],resolution:['1080p']}]}}),{code:'VIDEO_BINDING_INVALID'});
});

test('historical 768P new dispatch is rejected without changing implicit or explicit frozen resolution',()=>{
  const legacy=binding(['768P']);
  for(const parameters of [undefined,{}, {resolution:'768P'}]){
    const input={...snapshot(),...(parameters===undefined?{}:{parameters})};
    if(parameters===undefined)delete (input as {parameters?:Record<string,unknown>}).parameters;
    const before=structuredClone(input);
    assert.equal(effectiveVideoParameters(legacy,input).resolution,'768P');
    assert.throws(()=>validateVideoSnapshot(legacy,input),error=>error instanceof Error&&'code' in error&&error.code==='UNSUPPORTED_PARAMETERS'&&/2K/.test(error.message)&&/768P/.test(error.message));
    assert.equal(getVideoGenerationIssue(input,videoBindingCapabilities(legacy))?.code,'UNSUPPORTED_PARAMETERS');
    assert.deepEqual(input,before);
  }
  assert.throws(()=>validateVideoSnapshot(binding(),snapshot({resolution:'768P'})),{code:'UNSUPPORTED_PARAMETERS'});
});

test('current MiniMax capability discovery filters historical 768P while preserving original model maps for exact binding checks',()=>{
  for(const resolutions of [['768P'],['768P','2K'],['2K','768P']]){
    const frozen=binding(resolutions),before=structuredClone(frozen),capabilities=videoBindingCapabilities(frozen),expected=resolutions.includes('2K')?['2K']:[];
    assert.deepEqual(resolutionValues(videoInputProfile(frozen)),expected);
    assert.deepEqual(capabilities.modelCapabilities[0]!.resolutions,expected);
    assert.deepEqual(capabilities.videoModel.durationResolutionMap[0]!.resolution,resolutions);
    assert.deepEqual(frozen,before);
  }
});
