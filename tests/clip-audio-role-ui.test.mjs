import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { i18nTestModule } from './helpers/i18n.ts';
import { validateCatalogs } from '../packages/i18n/src/index.ts';
import { audioRoleMessages } from '../packages/i18n/src/catalogs/audio-role.ts';
import * as roleContract from '../packages/contracts/src/timeline-audio-role.ts';
import { canEditTimelineAudioRole, isWorkspaceRestoreInspection } from '../packages/contracts/src/workspace-restore.mjs';
import { clipAudioRoleChanged, clipAudioRoleCapabilityMatches, readClipAudioRoleCapability } from '../apps/web/src/clip-audio-role-state.ts';
import { clipDraftRawSchema } from '../packages/contracts/src/local-drafts.ts';
import { clipDraftRaw, clipDraftPatch, createClipDraftController } from '../apps/web/src/clip-draft-state.ts';
import { isTimelineRecord } from '../packages/contracts/src/timeline-replacement.mjs';
const id = n => `d2000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stamp = '2026-10-15T00:00:00.000Z';
const raw = { name:'Clip', trackId:id(4), startFrame:0,durationFrames:120,sourceInFrame:0,gain:1,rect:{x:0,y:0,width:720,height:1280} };
const source = {assetId:id(5),assetSha256:'b'.repeat(64)};
const key = {projectId:id(1),timelineId:id(2),clipId:id(3)};
const context = patch => ({...key,scope:'role-test',restored:false,connected:true,busy:false,visible:true,audioRoleEditable:true,timelineRevision:7,source,saved:structuredClone(raw),...patch});
const timeline = (patch,revision=8) => ({id:id(2),projectId:id(1),revision,fps:30,width:720,height:1280,durationFrames:120,createdAt:stamp,updatedAt:stamp,
 tracks:[{id:id(4),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[{id:id(3),assetId:id(5),...raw,...patch}]});
function harness(t, patch={}) {
 let envelope={supported:true,workspaceScope:'a'.repeat(64),instanceId:id(6),key,revision:0,targetStatus:'matching',draft:null};
 const calls=[];
 const controller=createClipDraftController({context:context(patch),delay:100000,validateTimeline:(value,projectId)=>isTimelineRecord(value,{projectId}),client:{
  get:async()=>structuredClone(envelope),
  put:async input=>{calls.push(['put',structuredClone(input)]);assert.equal(input.expectedRevision,envelope.revision);envelope={...envelope,revision:envelope.revision+1,draft:{baseRevision:input.baseRevision,source:input.source,raw:input.raw,updatedAt:stamp}};return structuredClone(envelope);},
  remove:async input=>{calls.push(['delete',structuredClone(input)]);envelope={...envelope,revision:envelope.revision+1,draft:null};return structuredClone(envelope);}
 }});t.after(()=>controller.dispose());return {controller,calls,envelope:()=>structuredClone(envelope),setEnvelope:value=>{envelope=value;}};
}
const capability={profileId:roleContract.TIMELINE_AUDIO_ROLE_PROFILE,editable:true};
const matches=(workspace,inspection)=>clipAudioRoleCapabilityMatches(workspace,inspection,isWorkspaceRestoreInspection,canEditTimelineAudioRole);
test('capability is explicit and fail-closed, with no generic operation inference',async()=>{
 const normal={restored:false};assert.equal(matches(normal,{...normal,audioRoleCapability:capability}),true);
 for(const result of [normal,null,{...normal,audioRoleCapability:{...capability,editable:false}},{...normal,audioRoleCapability:{...capability,profileId:'future'}},{...normal,audioRoleCapability:{...capability,extra:true}},{...normal,operationPolicy:[{operation:'timeline.clip.update',available:true}]}])assert.equal(matches(normal,result),false);
 assert.equal(await readClipAudioRoleCapability(normal,async()=>{throw Error('legacy unknown input');},isWorkspaceRestoreInspection,canEditTimelineAudioRole),false);
});
test('restored capability binds exact verified origin and profile; old generic update support is insufficient',()=>{
 const inspection={restored:true,schemaVersion:39,profile:'restored-local-v8',workspaceOrigin:id(10),restorationId:id(11),createdAt:stamp,
 source:{backupId:id(12),schemaVersion:38,manifestHash:'c'.repeat(64),dbHash:'d'.repeat(64)},heldCounts:[],operationPolicy:[{operation:'timeline.clip.update',available:true,reason:'AVAILABLE'}],backupCreate:{available:false,reason:'RESTORE_BACKUP_UNAVAILABLE'}};
 assert.equal(isWorkspaceRestoreInspection(inspection),true);
 assert.equal(matches(inspection,{...inspection,audioRoleCapability:capability}),true);
 assert.equal(matches(inspection,{...inspection,workspaceOrigin:id(13),audioRoleCapability:capability}),false);
 assert.equal(matches(inspection,{...inspection,source:{...inspection.source,dbHash:'e'.repeat(64)},audioRoleCapability:capability}),false);
 const legacy={...inspection,schemaVersion:37,profile:'restored-local-v7',source:{...inspection.source,schemaVersion:36}};
 assert.equal(isWorkspaceRestoreInspection(legacy),true);
 assert.equal(matches(legacy,{...legacy,audioRoleCapability:capability}),false);
 assert.equal(matches(legacy,{...legacy,audioRoleCapability:{...capability,editable:false}}),false);
});
test('raw and patch preserve absent/null roles and reject invalid values without coercion',()=>{
 assert.equal(Object.hasOwn(clipDraftRaw(raw),'audioRole'),false);assert.equal(Object.hasOwn(clipDraftPatch(raw),'audioRole'),false);
 for(const role of [null,'human','music','sfx']){const next={...raw,audioRole:role};assert.equal(clipDraftRawSchema.safeParse(next).success,true);assert.equal(clipDraftRaw(next).audioRole,role);assert.equal(clipDraftPatch(next).audioRole,role);}
 for(const role of ['',undefined,'voice',false,1]){assert.equal(clipDraftPatch({...raw,audioRole:role}),null);}
 assert.equal(clipAudioRoleChanged(raw,{...raw,audioRole:null}),true);assert.equal(clipAudioRoleChanged({...raw,audioRole:null},{...raw,audioRole:null}),false);
});
test('role state saves through draft CAS and business save; role ACK mismatch retains input',async t=>{
 const h=harness(t);await h.controller.load();assert.equal(h.controller.edit('audioRole','music'),true);await h.controller.flush();
 assert.equal(h.envelope().draft.raw.audioRole,'music');assert.equal(h.controller.getState().dirty,true);
 let saved;await h.controller.save(async(clipId,patch,revision,options)=>{saved={clipId,patch,revision};assert.equal(options.canExecute(),true);return timeline({...patch,audioRole:'sfx'});});
 assert.equal(saved.patch.audioRole,'music');assert.equal(saved.revision,7);assert.equal(h.controller.getState().dirty,true);assert.equal(h.envelope().draft.raw.audioRole,'music');assert.match(h.controller.getState().error,/确认/);
});
test('unknown business ACK preserves exact role input and sidecar, with no automatic resubmit',async t=>{
 const h=harness(t);await h.controller.load();h.controller.edit('audioRole',null);let count=0;
 await h.controller.save(async()=>{count++;throw Error('response lost');});
 assert.equal(count,1);assert.equal(h.controller.getState().raw.audioRole,null);assert.equal(h.controller.getState().dirty,true);assert.equal(h.envelope().draft.raw.audioRole,null);assert.equal(h.calls.filter(x=>x[0]==='delete').length,0);
});
test('capability loss blocks role changes but omits unchanged role for unrelated edits',async t=>{
 const h=harness(t,{audioRoleEditable:false,saved:{...raw,audioRole:'music'}});await h.controller.load();assert.equal(h.controller.edit('audioRole','human'),false);h.controller.edit('name','Renamed');let sent;
 await h.controller.save(async(_,patch)=>{sent=patch;return timeline({...patch,audioRole:'music'});});assert.equal(Object.hasOwn(sent,'audioRole'),false);assert.equal(h.controller.getState().dirty,false);
 const blocked=harness(t);await blocked.controller.load();blocked.controller.edit('audioRole','human');blocked.controller.setContext(context({audioRoleEditable:false}));let called=false;
 await blocked.controller.save(async()=>{called=true;});assert.equal(called,false);assert.equal(blocked.controller.getState().raw.audioRole,'human');assert.equal(blocked.controller.getState().dirty,true);
});
test('role draft restore and discard preserve ownership and reset absence',async t=>{
 const h=harness(t);const row=h.envelope();h.setEnvelope({...row,revision:1,draft:{baseRevision:7,source,raw:{...raw,audioRole:'sfx'},updatedAt:stamp}});await h.controller.load();assert.equal(h.controller.restore(),true);assert.equal(h.controller.getState().raw.audioRole,'sfx');
 await h.controller.discard(h.controller.capture());assert.equal(Object.hasOwn(h.controller.getState().raw,'audioRole'),false);assert.equal(h.controller.getState().dirty,false);
});
test('late role ACK cannot clear a changed owner; role capability is rechecked at dispatch',async t=>{
 const h=harness(t);await h.controller.load();h.controller.edit('audioRole','human');let release,options;
 const flight=h.controller.save(async(_,patch,_revision,current)=>{options=current;await new Promise(resolve=>{release=resolve;});return timeline(patch);});
 while(!release)await new Promise(resolve=>setImmediate(resolve));h.controller.setContext(context({audioRoleEditable:false}));assert.equal(options.canExecute(),false);h.controller.setContext(context({scope:'another-owner'}));release();await flight;assert.equal(h.envelope().draft.raw.audioRole,'human');
});
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];
const text=tree=>Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):tree??'';
function view(locale,props){const react={createElement:(type,props,...children)=>({type,props:{...props,children}})};react.default=react;const module={exports:{}};
 Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/ClipAudioRoleControls.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)(name=>{
 if(name==='react')return react;if(name==='./i18n/I18nProvider.tsx')return i18nTestModule(locale);if(name==='@mioon/ui/components/label')return {Label:'Label'};if(name==='../../../packages/contracts/src/timeline-audio-role.ts')return roleContract;throw Error(name);
 },module,module.exports);return module.exports.default({kind:'video',editable:true,blocked:false,Select:'Select',onEdit(){},...props});}
test('TSX control labels and handlers cover four locales, explicit clear, invalid events and disabled states',()=>{
 assert.deepEqual(validateCatalogs(audioRoleMessages),[]);
 for(const locale of ['zh-Hans','zh-Hant','en','ja']){const events=[];const tree=view(locale,{onEdit:value=>events.push(value)});const selector=nodes(tree).find(x=>x.type==='Select');assert.equal(selector.props.value,'');assert.equal(nodes(tree).filter(x=>x.type==='option').length,4);assert.ok(text(tree).includes(audioRoleMessages['audio.role.hint'][locale]));
 for(const value of ['human','music','sfx','','not-a-role'])selector.props.onChange({target:{value}});assert.deepEqual(events,['human','music','sfx',null]);}
 for(const props of [{editable:false},{blocked:true}]){let writes=0;const selector=nodes(view('en',{...props,onEdit:()=>writes++})).find(x=>x.type==='Select');selector.props.onChange({target:{value:'human'}});assert.equal(writes,0);assert.equal(selector.props.disabled,true);}
 assert.equal(view('en',{kind:'image'}),null);assert.ok(view('en',{kind:'audio'}));
});
