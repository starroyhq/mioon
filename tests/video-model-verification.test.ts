import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {defaultVideoModels,resolveVideoEndpoint,videoBindingCapabilities,validateVideoSnapshot,videoConnectionConfigurationSchema} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration,VideoConnectionDescriptor,VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';
import {generationSelection,videoConnectionProviders} from '../apps/web/src/generation-settings.ts';
import {catalogs,validateCatalogs} from '../packages/i18n/src/index.ts';

const connectionId='00000000-0000-4000-8000-000000000011',credentialRef='00000000-0000-4000-8000-000000000012';
function configuration():VideoConnectionConfiguration {
  const model=defaultVideoModels('wan')[0]!;
  return {id:connectionId,providerId:'wan',name:'Account',region:'cn-beijing',workspaceId:'',enabled:true,archived:false,outputHosts:['video.example.com'],models:[model,{...structuredClone(model),id:'00000000-0000-4000-8000-000000000013',name:'Custom exact model',modelId:'custom-future-wan-model'}]};
}
function descriptor():VideoConnectionDescriptor {
  const c=configuration();
  return {connectionId:c.id,providerId:c.providerId,name:c.name,configurationRevision:1,region:c.region,configured:true,enabled:true,archived:false,models:c.models.map(entry=>({entry,capabilities:videoBindingCapabilities({version:1,connectionId,configurationRevision:1,providerId:c.providerId,region:c.region,workspaceId:c.workspaceId,endpoint:resolveVideoEndpoint(c.providerId,c.region),credentialRef,model:entry,outputHosts:c.outputHosts},{asOf:'2026-10-20'})}))};
}

test('catalog model verification stays separate from offline protocol evidence without broadening capabilities',()=>{
  const c=configuration();assert.equal(videoConnectionConfigurationSchema.safeParse(c).success,true);
  const directory=descriptor();
  for(const {entry,capabilities} of directory.models){
    assert.equal(capabilities.verification,'unverified');assert.equal(capabilities.protocolVerification,'offline-tested');assert.equal(capabilities.liveVerified,false);
    assert.equal(capabilities.videoModel.modelId,entry.modelId);assert.equal(capabilities.modelEntryId,entry.id);
    const binding:VideoExecutionBinding={...capabilities.videoConnection,model:entry,credentialRef};
    const snapshot={providerId:c.providerId,model:entry.modelId,prompt:'Synthetic sunset',aspectRatio:'16:9',duration:5,parameters:{resolution:'720P'},referenceAssets:[]};
    assert.equal(validateVideoSnapshot(binding,snapshot,{asOf:'2026-10-20'}),true);
    assert.throws(()=>validateVideoSnapshot(binding,{...snapshot,parameters:{resolution:'4K'}},{asOf:'2026-10-20'}),{code:'UNSUPPORTED_PARAMETERS'});
  }
  const providers=videoConnectionProviders([directory]),custom=directory.models[1]!.entry;
  const selected=generationSelection(providers,{connectionId,modelEntryId:custom.id},{duration:5});
  assert.equal(selected.model,custom.modelId);assert.equal(selected.modelEntryId,custom.id);
  assert.equal(selected.provider?.verification,'unverified');assert.equal(selected.provider?.protocolVerification,'offline-tested');
});

test('the real generation selector labels a custom model unverified while preserving entry and request identities',()=>{
  const fixture=`
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server.browser';
    import ProviderSettings from './ProviderSettings.tsx';
    import {generationSelection,videoConnectionProviders} from './generation-settings.ts';
    const directory=${JSON.stringify(descriptor())};
    const providers=videoConnectionProviders([directory]),entry=directory.models[1].entry;
    const selected=generationSelection(providers,{connectionId:directory.connectionId,modelEntryId:entry.id},{duration:5});
    const configured=renderToStaticMarkup(<ProviderSettings providers={providers} provider={selected.provider} model={selected.model} modelEntryId={selected.modelEntryId} capabilities={selected.capabilities} onChange={()=>{}} />);
    const legacy={id:'wan',configured:true,enabled:true,status:'available',models:[entry.modelId]};
    const environment=renderToStaticMarkup(<ProviderSettings providers={[legacy]} provider={legacy} model={entry.modelId} onChange={()=>{}} />);
    export const result={configured,environment,model:selected.model,modelEntryId:selected.modelEntryId};`;
  const script=`import {build} from 'esbuild';
    const {outputFiles}=await build({stdin:{contents:${JSON.stringify(fixture)},loader:'tsx',resolveDir:${JSON.stringify(resolve('apps/web/src'))}},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
    const {result}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(result));process.exit(0);`;
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module'],{input:script,encoding:'utf8',timeout:30000})) as {configured:string;environment:string;model:string;modelEntryId:string};
  const entry=descriptor().models[1]!.entry;
  assert.equal(result.model,entry.modelId);assert.equal(result.modelEntryId,entry.id);
  assert.match(result.configured,/data-testid="model-select"[^>]*>[\s\S]*?Custom exact model · 尚未验证[\s\S]*?<\/button>/);
  assert.match(result.configured,/data-testid="video-model-unverified"/);
  assert.ok(result.configured.includes(catalogs['video.providers.unverifiedHint']['zh-Hans']));
  assert.doesNotMatch(result.environment,/data-testid="video-model-unverified"|尚未验证/);
});

test('verification and bound credential recovery messages cover all four languages',()=>{
  assert.deepEqual(validateCatalogs(),[]);
  for(const key of ['video.providers.unverified','video.providers.unverifiedHint','video.providers.credentialRestored','video.providers.credentialRestoredDraft','video.providers.restoreKey','video.providers.history']as const){
    for(const locale of ['zh-Hans','zh-Hant','en','ja']as const)assert.ok(catalogs[key][locale].trim());
  }
});
