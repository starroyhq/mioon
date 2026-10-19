import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureImageEditIntent,imageEditIntentSource} from '../apps/web/src/image-edit-intent.ts';
const app=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
const begin=app.indexOf('  function imageEditScope()'),end=app.indexOf('  if (auth === false && !retainWorkbenchForClip)',begin);
assert.ok(begin>=0&&end>begin);const source=app.slice(begin,end);
const id=n=>`f1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const asset=()=>({id:id(2),projectId:id(1),name:'original.png',mimeType:'image/png',sha256:'a'.repeat(64),provenance:'user-import',sizeBytes:100,width:512,height:512});
function harness(){
 const calls=[],env={application:null,restored:false,online:true,auth:true,loading:false,showImage:false,webSettingsOpen:false,imageDraft:{current:true},
  currentProject:{current:id(1)},projectEpoch:{current:1},navigationEpoch:{current:2},panelIntent:{current:3},workspaceRef:{current:{id:'workspace'}},
  clipDraftRef:{current:null},imageEditIntentRef:{current:null},dataRef:{current:{assets:[asset()]}},captureImageEditIntent,imageEditIntentSource,
  workspaceOriginScope:value=>value.id,requestId:()=>id(3),projectSessionReady:()=>true,msg:key=>({key}),
 };
 env.context=()=>({projectId:env.currentProject.current,epoch:env.navigationEpoch.current});env.isCurrent=value=>value.projectId===env.currentProject.current&&value.epoch===env.navigationEpoch.current;
 env.guardNavigation=async(...args)=>{calls.push(['guard',...args.slice(0,2)]);return true;};env.markPanelIntent=()=>{env.panelIntent.current++;};
 env.setShowTasks=value=>calls.push(['tasks',value]);env.setShowDelivery=value=>calls.push(['delivery',value]);env.setShowImage=value=>{env.showImage=value;calls.push(['image',value]);};env.setImageEditIntent=value=>{env.imageEditIntentRef.current=value;calls.push(['intent',value]);};
 const methods=Function('env',`with(env){${source}\nreturn{openImageEdit,isImageEditIntentCurrent};}`)(env);return{env,calls,...methods};
}
test('image edit entry presents a source-bound intent while leaving the existing image draft for its own exact guard',async()=>{
 const h=harness();assert.equal(await h.openImageEdit(asset()),true);const intent=h.env.imageEditIntentRef.current;
 assert.ok(Object.isFrozen(intent));assert.equal(h.isImageEditIntentCurrent(intent),true);assert.equal(h.env.imageDraft.current,true);assert.equal(h.calls.filter(call=>call[0]==='intent').length,1);
 assert.doesNotMatch(source,/\.generate\(|\.approve\(|\.confirmTarget\(|\.selectSource\(|rpc\(/);
 h.env.dataRef.current.assets=[{...asset(),sha256:'b'.repeat(64)}];assert.equal(h.isImageEditIntentCurrent(intent),false);
 h.env.dataRef.current.assets=[asset()];h.env.panelIntent.current++;assert.equal(h.isImageEditIntentCurrent(intent),false);
});
test('image edit entry respects rejection, changed ownership and disconnected/composing admission',async()=>{
 const rejected=harness();rejected.env.guardNavigation=async()=>false;assert.equal(await rejected.openImageEdit(asset()),false);assert.equal(rejected.env.imageEditIntentRef.current,null);assert.equal(rejected.env.showImage,false);
 const changed=harness();changed.env.guardNavigation=async()=>{changed.env.navigationEpoch.current++;return true;};assert.equal(await changed.openImageEdit(asset()),false);assert.equal(changed.env.showImage,false);
 for(const patch of [{online:false},{auth:false},{restored:true},{application:{}},{clipDraftRef:{current:{hasPendingComposition:()=>true}}}]){const h=harness();Object.assign(h.env,patch);assert.equal(await h.openImageEdit(asset()),false);assert.equal(h.calls.length,0);}
});
