import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as volumeState from '../apps/web/src/clip-volume-envelope-state.ts';
import * as volumeContract from '../packages/contracts/src/timeline-volume-envelope.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { createClipDraftController, clipDraftRaw, clipDraftPatch } from '../apps/web/src/clip-draft-state.ts';
import { createClipDraftClient, admitClipDraftRequest } from '../apps/web/src/clip-draft-client.ts';
import { VOLUME_ENVELOPE_PROFILE as profileId } from '../packages/contracts/src/timeline-volume-envelope.ts';
const id=n=>`d1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const key={projectId:id(1),timelineId:id(2),clipId:id(3)}, source={assetId:id(5),assetSha256:'b'.repeat(64)};
const base={name:'Clip',trackId:id(4),startFrame:0,durationFrames:120,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1};
const numeric={profileId,points:[{frame:0,multiplier:1},{frame:120,multiplier:0.5}]};
const curve={profileId,points:[{frame:'0',multiplier:'1'},{frame:'120',multiplier:'0.5'}]};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function harness(t,{saved={},candidate=null,editable=true,restored=false,putHook}={}) {
 const ctx={...key,scope:'owner1',restored,connected:true,visible:true,busy:false,volumeEnvelopeEditable:editable,timelineRevision:7,source,saved:{...base,...saved}};
 let row={supported:true,workspaceScope:'a'.repeat(64),instanceId:id(6),key,revision:candidate?1:0,targetStatus:'matching',draft:candidate}; const calls=[];
 const client={get:async()=>structuredClone(row),put:async input=>{calls.push(['put',input]);if(putHook)return putHook(input,row);row={...row,revision:input.expectedRevision+1,draft:{baseRevision:input.baseRevision,source:input.source,raw:input.raw,updatedAt:'2026-10-15T00:00:00.000Z'}};return structuredClone(row);},remove:async input=>{calls.push(['remove',input]);row={...row,revision:input.expectedRevision+1,draft:null};return structuredClone(row);}};
 const c=createClipDraftController({context:ctx,client,validateTimeline:()=>true,delay:100000});t.after(()=>c.dispose());
 const result=patch=>({id:key.timelineId,projectId:key.projectId,revision:8,clips:[{id:key.clipId,...source,...base,...saved,...patch}]});
 return {c,ctx,calls,client,result};
}
function presetControls(controller) {
 const hooks=[];let cursor=0,tree;
 const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),useId:()=> 'controller-preset',useRef:initial=>hooks[cursor++]??={current:initial},useState(initial){const index=cursor++;hooks[index]??={value:initial};return [hooks[index].value,next=>{hooks[index].value=next;}];}};react.default=react;
 const module={exports:{}};
 Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/ClipVolumeEnvelopeControls.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)(name=>name==='react'?react:name.includes('I18nProvider')?i18nTestModule('en'):name.endsWith('clip-volume-envelope-state.ts')?volumeState:name.endsWith('timeline-volume-envelope.ts')?volumeContract:assert.fail(name),module,module.exports);
 const nodes=value=>!value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...nodes(value.props?.children)];
 const h={render(){cursor=0;const captured=controller.capture(),raw=controller.getState().raw;tree=module.exports.default({value:raw.volumeEnvelope,proposedDuration:Number(raw.durationFrames),onEdit:value=>controller.editVolumeEnvelope(value,captured),onCompositionChange:()=>assert.fail('preset click is not composition')});},node(id){return nodes(tree).find(node=>node.props?.['data-testid']===id);}};h.render();return h;
}
for(const kind of ['in','out'])test(`real ${kind} preset edits only the draft until ordinary Save, preserving gain and legacy fades`,async t=>{
 const saved={volumeEnvelope:curve,gain:.5,fadeInFrames:8,fadeOutFrames:12},f=harness(t,{saved});await f.c.load();const controls=presetControls(f.c);
 controls.node('envelope-preset-frames').props.onChange({currentTarget:{value:'60'}});controls.render();assert.equal(f.c.hasUnsaved(),false);assert.equal(f.calls.length,0);
 controls.node(`envelope-preset-${kind}`).props.onClick();const expected=volumeState.createVolumeEnvelopeFadePreset(kind,120,60);
 assert.deepEqual(f.c.getState().raw.volumeEnvelope,expected);assert.equal(f.c.hasUnsaved(),true);assert.equal(f.calls.length,0);
 for(const field of ['gain','fadeInFrames','fadeOutFrames'])assert.equal(f.c.getState().raw[field],saved[field]);
 await f.c.flush();assert.equal(f.calls.filter(([method])=>method==='put').length,1);assert.deepEqual(f.calls[0][1].raw.volumeEnvelope,expected);
 let submissions=0;
 const out=await f.c.save(async(clipId,patch,revision,options)=>{submissions++;assert.equal(clipId,key.clipId);assert.equal(revision,7);assert.equal(options.canExecute(),true);assert.deepEqual(patch.volumeEnvelope,volumeState.validateRawVolumeEnvelope({volumeEnvelope:expected},120).fields.volumeEnvelope);for(const field of ['gain','fadeInFrames','fadeOutFrames'])assert.equal(patch[field],saved[field]);return f.result(patch);});
 assert.ok(out);assert.equal(submissions,1);assert.equal(f.c.hasUnsaved(),false);assert.equal(f.calls.filter(([method])=>method==='remove').length,1);
 assert.deepEqual(f.c.getState().raw.volumeEnvelope,expected);
});
test('preset draft recovery is explicit and Cancel restores the original curve without business Save',async t=>{
 const saved={volumeEnvelope:curve,gain:.75,fadeInFrames:5,fadeOutFrames:10},first=harness(t,{saved});await first.c.load();const controls=presetControls(first.c);
 controls.node('envelope-preset-out').props.onClick();await first.c.flush();const record={baseRevision:7,source,raw:structuredClone(first.calls[0][1].raw),updatedAt:'2026-10-15T00:00:00.000Z'};
 const recovered=harness(t,{saved,candidate:record});await recovered.c.load();assert.deepEqual(recovered.c.getState().raw.volumeEnvelope,curve);assert.equal(recovered.c.hasUnsaved(),false);
 assert.equal(recovered.c.restore(),true);assert.deepEqual(recovered.c.getState().raw.volumeEnvelope,record.raw.volumeEnvelope);assert.equal(recovered.c.hasUnsaved(),true);
 assert.equal(await recovered.c.discard(recovered.c.capture()),true);assert.deepEqual(recovered.c.getState().raw.volumeEnvelope,curve);assert.equal(recovered.c.hasUnsaved(),false);
 for(const field of ['gain','fadeInFrames','fadeOutFrames'])assert.equal(recovered.c.getState().raw[field],saved[field]);
 assert.equal(recovered.calls.filter(([method])=>method==='remove').length,1);assert.equal(recovered.calls.filter(([method])=>method==='put').length,0);
});
test('raw projection, proposed shrink, explicit replacement and clear preserve envelope presence',()=>{
 assert.equal(Object.hasOwn(clipDraftRaw(base),'volumeEnvelope'),false);
 assert.equal(clipDraftRaw({...base,volumeEnvelope:null}).volumeEnvelope,null);
 assert.deepEqual(clipDraftRaw({...base,volumeEnvelope:numeric}).volumeEnvelope,curve);
 assert.equal(clipDraftPatch({...base,durationFrames:100,volumeEnvelope:curve}),null);
 assert.deepEqual(clipDraftPatch({...base,durationFrames:100,volumeEnvelope:{profileId,points:[{frame:'100',multiplier:'1'}]}}).volumeEnvelope,{profileId,points:[{frame:100,multiplier:1}]});
 assert.equal(clipDraftPatch({...base,durationFrames:100,volumeEnvelope:null}).volumeEnvelope,null);
});
test('bounded invalid intermediates persist exactly without becoming business Save',async t=>{
 const {c,calls}=harness(t);await c.load();const raw={profileId,points:[{frame:'1e-',multiplier:'.'}]};assert.equal(c.editVolumeEnvelope(raw,c.capture()),true);await c.flush();assert.deepEqual(calls[0][1].raw.volumeEnvelope,raw);assert.equal(await c.save(()=>assert.fail('no business request')),null);assert.equal(c.hasUnpersisted(),false);assert.equal(c.hasUnsaved(),true);
});
test('composition is controller-owned dirty close/navigation protection and cannot persist transient text',async t=>{
 const {c,calls}=harness(t,{saved:{volumeEnvelope:curve}});await c.load();const before=c.capture(),token=c.beginVolumeComposition(before);assert.ok(token);assert.equal(c.isCurrent(before),false);assert.equal(c.hasUnsaved(),true);assert.equal(c.getEditorCloseSnapshot().dirty,true);assert.equal(c.getEditorCloseSnapshot().inflight,true);assert.equal(c.hasUnpersisted(),true);
 assert.equal(c.updateVolumeComposition(token,{pending:true,dirty:true,row:0,field:'frame',text:'１'}),true);
 assert.equal(c.edit('name','ignored'),false);assert.equal(c.canAbandon(),false);assert.equal(c.abandonCurrentInput(c.capture()),false);assert.equal(await c.discard(c.capture()),false);assert.equal(c.restore(),false);assert.equal(await c.flushForClose(),false);assert.equal(await c.save(()=>assert.fail('no Save')),null);await c.flush();assert.equal(calls.length,0);
 assert.equal(c.endVolumeComposition(token),true);assert.equal(c.hasUnsaved(),false);assert.equal(await c.flushForClose(),true);assert.equal(c.editVolumeEnvelope(curve,token),false);
});
test('composition settlement retains admitted input under capability loss and disconnect',async t=>{
 const {c,ctx}=harness(t,{saved:{volumeEnvelope:curve}});await c.load();const token=c.beginVolumeComposition(c.capture());c.setContext({...ctx,connected:false,volumeEnvelopeEditable:false});const next={profileId,points:[{frame:'1',multiplier:'0.75'}]};assert.equal(c.editVolumeEnvelope(next,token),true);assert.equal(c.endVolumeComposition(token),true);assert.deepEqual(c.getState().raw.volumeEnvelope,next);assert.equal(c.hasUnpersisted(),true);assert.equal(await c.save(()=>assert.fail('unsupported')),null);
});
test('old owner/token cannot update form or release a later composition',async t=>{
 const {c}=harness(t,{saved:{volumeEnvelope:curve}});await c.load();const old=c.beginVolumeComposition(c.capture());assert.equal(c.endVolumeComposition(old),true);const current=c.beginVolumeComposition(c.capture());assert.equal(c.editVolumeEnvelope(null,old),false);assert.equal(c.endVolumeComposition(old),false);assert.equal(c.hasPendingComposition(),true);assert.equal(c.endVolumeComposition(current),true);const capture=c.capture();c.dispose();c.activate();assert.equal(c.editVolumeEnvelope(null,capture),false);assert.equal(c.updateVolumeComposition(old,{pending:true,dirty:true,row:0,field:'frame',text:'2'}),false);
});
for(const expected of [undefined,null,curve])test(`business ACK checks omitted unchanged envelope ${expected===undefined?'absent':expected===null?'null':'value'}`,async t=>{
 const saved=expected===undefined?{}:{volumeEnvelope:expected};const {c,calls,result}=harness(t,{saved,editable:false});await c.load();c.edit('name','New');let sent;
 const out=await c.save(async(_id,patch)=>{sent=patch;const response=result(patch);if(expected===undefined)response.clips[0].volumeEnvelope=null;else delete response.clips[0].volumeEnvelope;return response;});assert.equal(out,null);assert.equal(Object.hasOwn(sent,'volumeEnvelope'),false);assert.equal(c.getState().dirty,true);assert.equal(calls.filter(x=>x[0]==='remove').length,0);
});
test('exact business ACK clears exact sidecar and saves numeric envelope through ordinary Save',async t=>{
 const {c,calls,result}=harness(t);await c.load();c.editVolumeEnvelope(curve,c.capture());assert.ok(await c.save(async(_id,patch,_base,options)=>{assert.equal(options.canExecute(),true);return result(patch);}));assert.equal(c.getState().dirty,false);assert.equal(calls.filter(x=>x[0]==='remove').length,1);assert.deepEqual(c.getState().raw.volumeEnvelope,curve);
});
test('changed recovered unsupported curve remains visible and blocked',async t=>{
 const candidate={baseRevision:7,source,raw:{...base,volumeEnvelope:curve},updatedAt:'2026-10-15T00:00:00.000Z'};const {c}=harness(t,{candidate,editable:false});await c.load();assert.equal(c.restore(),true);assert.deepEqual(c.getState().raw.volumeEnvelope,curve);assert.equal(await c.save(()=>assert.fail('unsupported')),null);assert.equal(c.getState().dirty,true);
});
test('late business ACK cannot delete newer curve input',async t=>{
 const {c,calls,result}=harness(t);await c.load();c.editVolumeEnvelope(curve,c.capture());const pending=deferred();const save=c.save(async(_id,patch)=>{pending.patch=patch;return pending.promise;});await c.flush();await Promise.resolve();assert.ok(pending.patch);c.edit('name','Newer');pending.resolve(result(pending.patch));await save;assert.equal(c.getState().raw.name,'Newer');assert.equal(calls.filter(x=>x[0]==='remove').length,0);
});
test('restored explicit capable business edits remain available without local companion IO',async t=>{
 const {c,calls,result}=harness(t,{restored:true});c.editVolumeEnvelope(curve,c.capture());assert.ok(await c.save(async(_id,patch)=>result(patch)));assert.equal(calls.length,0);assert.equal(c.getState().dirty,false);
});
test('capability loss during flush cancels business submission without stripping saved draft',async t=>{
 const pending=deferred();const {c,ctx}=harness(t,{putHook:async(input,row)=>{await pending.promise;return {...row,revision:1,draft:{baseRevision:7,source,raw:input.raw,updatedAt:'2026-10-15T00:00:00.000Z'}};}});await c.load();c.editVolumeEnvelope(curve,c.capture());const saving=c.save(()=>assert.fail('capability lost'));c.setContext({...ctx,volumeEnvelopeEditable:false});pending.resolve();assert.equal(await saving,null);assert.deepEqual(c.getState().raw.volumeEnvelope,curve);assert.equal(c.getState().dirty,true);
});
test('over-budget accepted form stays in memory with explicit refusal and close protection, no fetch',async t=>{
 let calls=0;const http=createClipDraftClient(async()=>{calls++;assert.fail('oversize cannot fetch');});const input={...key,workspaceScope:'a'.repeat(64),instanceId:id(6),expectedRevision:0,baseRevision:7,source,raw:{...base,name:'x'.repeat(9000),volumeEnvelope:curve}};
 assert.throws(()=>admitClipDraftRequest('PUT',input),e=>e.code==='LOCAL_DRAFT_LIMIT'&&e.kind==='refused');
 const {c,client}=harness(t);client.put=http.put;await c.load();c.edit('name',input.raw.name);await c.flush();assert.equal(c.getState().raw.name,input.raw.name);assert.equal(c.getState().errorDisplay.key,'volume.envelope.oversize');assert.equal(c.hasUnpersisted(),true);assert.equal(await c.flushForClose(),false);assert.equal(calls,0);
});

test('external owner-context replacement retains original pending composition and freezes effects',async t=>{
 const {c,ctx,calls}=harness(t,{saved:{volumeEnvelope:curve}});await c.load();const token=c.beginVolumeComposition(c.capture());
 c.updateVolumeComposition(token,{session:Symbol(),pending:true,dirty:true,row:0,field:'frame',text:'一'});
 c.setContext({...ctx,scope:'foreign',projectId:id(99)});
 assert.equal(c.hasPendingComposition(),true);assert.equal(c.capture().projectId,key.projectId);assert.equal(await c.flushForClose(),false);assert.equal(await c.save(()=>assert.fail('foreign Save')),null);
 assert.equal(c.editVolumeEnvelope({profileId,points:[{frame:'2',multiplier:'1'}]},token),true);assert.equal(c.endVolumeComposition(token),true);
 assert.equal(c.getState().raw.volumeEnvelope.points[0].frame,'2');assert.equal(c.getState().conflict,true);assert.equal(c.hasUnpersisted(),true);assert.equal(calls.length,0);
});
