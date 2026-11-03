import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProviderCatalog, createProviderRegistry, normalizedCapabilities, profileDate} from '../packages/business/src/provider-registry.ts';
import {listImageProfiles} from '../packages/business/src/images.ts';
import {createImageSettings, createCustomImageSettings} from '../packages/business/src/images/settings.ts';
import {createLiveImageGateway, createCompatibleImageGateway} from '../packages/business/src/images/gateway.ts';
import {DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';

test('application provider catalog matches project discovery without creating a database or managed files',t=>{
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-app-catalog-')),db=new DatabaseSync(':memory:');
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const before=globalThis.fetch;globalThis.fetch=async()=>assert.fail('Discovery cannot use the network');t.after(()=>{globalThis.fetch=before;});
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),changes=db.prepare('SELECT total_changes() AS n').get();
  for(const env of [{},{MIOON_ENABLE_LIVE_PROVIDER:'1',RUNWAYML_API_SECRET:'synthetic-catalog-key',ARK_API_KEY:'synthetic-catalog-key',GEMINI_API_KEY:'synthetic-catalog-key',MINIMAX_API_KEY:'synthetic-catalog-key',VIDU_API_KEY:'synthetic-catalog-key'},
    {MINIMAX_REGION:'invalid',VIDU_REGION:'invalid'}]) {
    const catalog=createProviderCatalog({root,env}),registry=createProviderRegistry({db,root,env});
    assert.deepEqual(catalog.list(),[...registry.values()].map(provider=>normalizedCapabilities(provider,env,0,{asOf:profileDate(),requireInputProfiles:true})));
    assert.equal(catalog.list().length,6);assert.doesNotMatch(JSON.stringify(catalog.list()),/synthetic-catalog-key/);
    assert.deepEqual(Object.keys(catalog),['list']);
  }
  assert.deepEqual(readdirSync(root),[]);
  assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),schema);
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(),changes);
});

test('application catalog exposes independent metadata snapshots without execution handles',()=>{
  const catalog=createProviderCatalog({root:'/uncreated/application/catalog',env:{}}),first=catalog.list();
  first[0].id='mutated';assert.equal(catalog.list()[0].id,'mock');
  assert.equal(first.some(value=>'submit' in value||'poll' in value||'download' in value),false);
});

test('image profile discovery reads settings metadata without opening a project or sending credentials',async()=>{
  const persistence={load:async()=>null,save:async()=>{}};
  const settings=await createImageSettings({persistence}),customSettings=await createCustomImageSettings({persistence});
  try {
    const saved=await settings.put({expectedRevision:(await settings.get()).revision,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:true},secret:{action:'replace',storage:'session',value:'synthetic-catalog-key'}});
    const custom=await customSettings.put({expectedRevision:(await customSettings.get()).revision,configuration:{...DEFAULT_CUSTOM_IMAGE_CONFIGURATION,enabled:true,baseUrl:'https://catalog.example.test/images',model:'catalog-model'},secret:{action:'replace',storage:'session',value:'synthetic-custom-key'}});
    const dependencies={settings,customSettings,liveGateway:createLiveImageGateway({settings}),customGateway:createCompatibleImageGateway({settings:customSettings})};
    const legacy=listImageProfiles(dependencies),revisions=listImageProfiles(dependencies,{includeSettingsRevision:true});
    assert.equal(legacy.liveEnabled,true);assert.deepEqual(legacy.items.map(item=>item.providerId),['mock','openai','openai-compatible']);
    assert.equal(legacy.items.some(item=>'settingsRevision' in item),false);
    assert.equal(revisions.items[1].settingsRevision,saved.revision);assert.equal(revisions.items[2].settingsRevision,custom.revision);
    assert.doesNotMatch(JSON.stringify(revisions),/synthetic-catalog-key|synthetic-custom-key|apiKey|encrypted/);
    assert.equal(listImageProfiles({settings}).liveEnabled,false,'a settings flag cannot invent an unavailable gateway');
    assert.equal(listImageProfiles().items.length,2);
  } finally {await settings.close();await customSettings.close();}
});
