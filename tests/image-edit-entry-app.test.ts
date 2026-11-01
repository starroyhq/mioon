import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {captureImageEditIntent,imageEditIntentSource} from '../apps/web/src/image-edit-intent.ts';
import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const app=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const components=ast.statements.filter(ts.isFunctionDeclaration).filter(statement=>statement.name?.text==='App');
assert.equal(components.length,1);assert.ok(components[0]!.body);
// Execute only the three real image-entry functions. Their neighboring menu
// hooks and command assignments belong to a different owner.
const source=['imageEditScope','isImageEditIntentCurrent','openImageEdit'].map(name=>{
 const declarations=components[0]!.body!.statements.filter(ts.isFunctionDeclaration).filter(statement=>statement.name?.text===name);
 assert.equal(declarations.length,1,`The actual App contains one ${name} entry function`);assert.ok(declarations[0]!.body);
 return declarations[0]!.getText(ast);
}).join('\n');
const id=(n: number)=>`f1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const asset=()=>({id:id(2),projectId:id(1),name:'original.png',mimeType:'image/png',sha256:'a'.repeat(64),provenance:'user-import',sizeBytes:100,width:512,height:512});
interface EntryIntent {projectId: string; epoch: number; [key: string]: unknown}
interface EntryEnv {[key: string]: unknown; restored: boolean; online: boolean; auth: boolean; loading: boolean; showImage: boolean; webSettingsOpen: boolean; imageDraft: {current: unknown}; currentProject: {current: string}; projectEpoch: {current: number}; navigationEpoch: {current: number}; panelIntent: {current: number}; workspaceRef: {current: {id: string}}; clipDraftRef: {current: null | {hasPendingComposition?: () => boolean}}; imageEditIntentRef: {current: null | EntryIntent}; dataRef: {current: {assets: Record<string, unknown>[]}}}
function harness(): {env: EntryEnv; calls: unknown[][]; openImageEdit: (value: unknown) => Promise<boolean>; isImageEditIntentCurrent: (value: unknown) => boolean} {
 const calls: unknown[][]=[],env: EntryEnv={restored:false,online:true,auth:true,loading:false,showImage:false,webSettingsOpen:false,imageDraft:{current:true},
  currentProject:{current:id(1)},projectEpoch:{current:1},navigationEpoch:{current:2},panelIntent:{current:3},workspaceRef:{current:{id:'workspace'}},
  clipDraftRef:{current:null},imageEditIntentRef:{current:null},dataRef:{current:{assets:[asset()]}},captureImageEditIntent,imageEditIntentSource,
  workspaceOriginScope:(value: {id: string})=>value.id,requestId:()=>id(3),projectSessionReady:()=>true,msg:(key: string)=>({key}),
 };
 env.context=()=>({projectId:env.currentProject.current,epoch:env.navigationEpoch.current});env.isCurrent=(value: EntryIntent)=>value.projectId===env.currentProject.current&&value.epoch===env.navigationEpoch.current;
 env.guardNavigation=async(...args: unknown[])=>{calls.push(['guard',...args.slice(0,2)]);return true;};env.markPanelIntent=()=>{env.panelIntent.current++;};
 env.setShowTasks=(value: unknown)=>calls.push(['tasks',value]);env.setShowDelivery=(value: unknown)=>calls.push(['delivery',value]);env.setShowImage=(value: boolean)=>{env.showImage=value;calls.push(['image',value]);};env.setImageEditIntent=(value: EntryIntent)=>{env.imageEditIntentRef.current=value;calls.push(['intent',value]);};
 const methods=Function('env',`with(env){${source}\nreturn{openImageEdit,isImageEditIntentCurrent};}`)(env) as Record<string, unknown>;return{env,calls,...methods} as {env: EntryEnv; calls: unknown[][]; openImageEdit: (value: unknown) => Promise<boolean>; isImageEditIntentCurrent: (value: unknown) => boolean};
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
 for(const patch of [{online:false},{auth:false},{restored:true},{clipDraftRef:{current:{hasPendingComposition:()=>true}}}]){const h=harness();Object.assign(h.env,patch);assert.equal(await h.openImageEdit(asset()),false);assert.equal(h.calls.length,0);}
});
