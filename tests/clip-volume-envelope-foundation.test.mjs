import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as state from '../apps/web/src/clip-volume-envelope-state.ts';
import * as contract from '../packages/contracts/src/timeline-volume-envelope.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { validateCatalogs, translate } from '../packages/i18n/src/index.ts';
import { volumeEnvelopeMessages } from '../packages/i18n/src/catalogs/volume-envelope.ts';
import { clipDraftSlotSchema, LOCAL_DRAFT_LIMITS } from '../packages/contracts/src/local-drafts.ts';
const envelope = points => ({ profileId: contract.VOLUME_ENVELOPE_PROFILE, points });
const raw = points => ({ volumeEnvelope: envelope(points.map(([frame, multiplier]) => ({ frame, multiplier }))) });
test('lexical limits are atomic admission, not numeric validation or normalization', () => {
 for (const field of ['frame','multiplier']) {
  const limit=state.RAW_VOLUME_ENVELOPE_LIMITS[field];
  for(const text of ['', '.', '-', '1e', '1e-', '+.eE-', '9'.repeat(limit)]) assert.equal(state.acceptsVolumeEnvelopeText(field,text),true);
  for(const text of ['9'.repeat(limit+1),'１','1 2',' 1','1\n','Infinity','NaN','1,2','1\0']) assert.equal(state.acceptsVolumeEnvelopeText(field,text),false);
 }
 for(const text of ['', '.', '-', '1e', '1e-']) {const value=raw([[text,text]]);assert.equal(state.isRawVolumeEnvelope(value.volumeEnvelope),true);assert.equal(state.validateRawVolumeEnvelope(value,10).valid,false);}
});
test('preserves absent/null/value and requires complete ordered attenuation on proposed duration', () => {
 assert.deepEqual(state.rawVolumeEnvelopeFields({durationFrames:10}),{});
 assert.deepEqual(state.rawVolumeEnvelopeFields({durationFrames:10,volumeEnvelope:null}),{volumeEnvelope:null});
 assert.equal(state.rawVolumeEnvelopeChanged({},{volumeEnvelope:null}),true);
 for(const points of [[],[['-0','1']],[['0','-0']],[['0','1.1']],[['0','1e999']],[['0.5','1']],[['11','1']],[['2','1'],['1','1']],[['1','1'],['1','0']],Array.from({length:17},(_,i)=>[String(i),'1'])]) assert.equal(state.validateRawVolumeEnvelope(raw(points),10).valid,false);
 const saved={durationFrames:10,volumeEnvelope:envelope([{frame:0,multiplier:0},{frame:10,multiplier:1}])};
 const r=state.rawVolumeEnvelopeFields(saved);assert.equal(state.validateRawVolumeEnvelope(r,10).valid,true);
 assert.equal(state.volumeEnvelopeChange(r,saved,9).valid,false);
 assert.deepEqual(state.volumeEnvelopeChange(r,saved,11),{valid:true,fields:{}});
 assert.deepEqual(state.volumeEnvelopeChange({volumeEnvelope:null},saved,9),{valid:true,fields:{volumeEnvelope:null}});
 assert.equal(state.volumeEnvelopeChange({},saved,10).valid,false);
 assert.equal(state.validateRawVolumeEnvelope(raw(Array.from({length:16},(_,i)=>[String(i),'1'])),16).valid,true);
 for(const duration of [0,-0,18001,1.5,NaN,Infinity]) assert.equal(state.validateRawVolumeEnvelope({},duration).valid,false);
});
test('unchanged comparison is independent of key insertion order but not raw strings or absence', () => {
 const saved={durationFrames:10,volumeEnvelope:{points:[{multiplier:1,frame:0}],profileId:contract.VOLUME_ENVELOPE_PROFILE}};
 const canonical=state.rawVolumeEnvelopeFields(saved);
 assert.deepEqual(state.volumeEnvelopeChange(canonical,saved,10),{valid:true,fields:{}});
 const reversed={volumeEnvelope:{points:[{multiplier:'1',frame:'0'}],profileId:contract.VOLUME_ENVELOPE_PROFILE}};
 assert.equal(state.rawVolumeEnvelopeChanged(canonical,reversed),false);
 assert.equal(state.rawVolumeEnvelopeChanged(canonical,raw([['0','1.0']])),true);
 assert.deepEqual(state.volumeEnvelopeChange(raw([['0','1.0']]),saved,10),{valid:true,fields:{}});
 assert.equal(state.rawVolumeEnvelopeChanged({}, {volumeEnvelope:undefined}),true);
});
test('Number-to-string round trips extremes and deterministic doubles without display rounding', () => {
 let seed=123456789;const values=[0,1,Number.MIN_VALUE,0.9999999999999999,0.0000009999999999999997];
 for(let i=0;i<10000;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;values.push(seed/2**32);}
 for(const multiplier of values) {
  const saved={durationFrames:18000,volumeEnvelope:envelope([{frame:18000,multiplier}])};
  const r=state.rawVolumeEnvelopeFields(saved);assert.equal(r.volumeEnvelope.points[0].multiplier,String(multiplier));
  assert.equal(state.isRawVolumeEnvelope(r.volumeEnvelope),true);assert.deepEqual(state.validateRawVolumeEnvelope(r,18000),{valid:true,fields:{volumeEnvelope:saved.volumeEnvelope}});
 }
});
const nodes=t=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)];
function harness(locale='en', initial=raw([['0','1']]).volumeEnvelope) {
 const hooks=[];let cursor=0, tree, edits=[], events=[];
 const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),useId:()=> 'test-envelope',useRef:initial=>hooks[cursor++]??=( {current:initial}),useState(initial){const at=cursor++;hooks[at]??={value:initial};return [hooks[at].value,value=>{hooks[at].value=value;}];}};react.default=react;
 const module={exports:{}};
 Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/ClipVolumeEnvelopeControls.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)(name=>name==='react'?react:name.includes('I18nProvider')?i18nTestModule(locale):name.endsWith('clip-volume-envelope-state.ts')?state:name.endsWith('timeline-volume-envelope.ts')?contract:assert.fail(name),module,module.exports);
 const props={value:initial,proposedDuration:10,onEdit(value){edits.push(value);props.value=value;events.push('edit');},onCompositionChange(value){events.push(value);}};
 const h={props,edits,events,render(patch={}){Object.assign(props,patch);cursor=0;tree=module.exports.default(props);return tree;},input(field='frame',row=0){return nodes(tree).find(n=>n.props?.['data-testid']===`envelope-${row}-${field}`);},buttons(){return nodes(tree).filter(n=>n.type==='button');},all(){return nodes(tree);}};h.render();return h;
}
const event=(value,extras={})=>({currentTarget:{value},...extras});
test('four locales render text inputs, accessible labels, bounded rows and non-submit buttons',()=>{
 assert.deepEqual(validateCatalogs(volumeEnvelopeMessages),[]);
 for(const locale of ['zh-Hans','zh-Hant','en','ja']){
  const h=harness(locale);assert.equal(h.all().find(n=>n.type==='legend').props.children[0],translate(locale,'volume.envelope.title'));
  for(const input of h.all().filter(n=>n.type==='input')){assert.equal(input.props.type,'text');assert.equal(input.props.maxLength,undefined);assert.ok(h.all().some(n=>n.type==='label'&&n.props.htmlFor===input.props.id));}
  assert.ok(h.buttons().every(n=>n.props.type==='button'));h.buttons().at(-1).props.onClick();assert.equal(h.edits.at(-1),null);
 }
 const h=harness('en',raw(Array.from({length:16},(_,i)=>[String(i),'1'])).volumeEnvelope);assert.equal(h.all().filter(n=>n.type==='input').length,32);assert.equal(h.buttons().at(-2).props.disabled,true);h.buttons().at(-2).props.onClick();assert.equal(h.edits.length,0);
 const absent=harness('en',undefined);absent.render({value:undefined});assert.equal(absent.edits.length,0);absent.buttons().at(-2).props.onClick();assert.deepEqual(absent.edits[0].points,[{frame:'',multiplier:''}]);
});
test('whole pasted events reject visibly, preserve prior value, allow malformed intermediate',()=>{
 for(const locale of ['zh-Hans','zh-Hant','en','ja'])for(const text of ['１','12 3','9'.repeat(9)]){
  const h=harness(locale),e=event(text);h.input().props.onChange(e);h.render();assert.equal(h.edits.length,0);assert.equal(e.currentTarget.value,'0');assert.ok(h.all().some(n=>n.props.role==='alert'&&n.props.children[0]===translate(locale,'volume.envelope.rejected',{limit:8})));
 }
 const h=harness();h.input().props.onChange(event('1e-'));assert.equal(h.edits[0].points[0].frame,'1e-');
});
test('IME transient stays observable, guards structure synchronously, commits before releasing pending',()=>{
 const h=harness(),input=h.input(),buttons=h.buttons();input.props.onCompositionStart(event('0'));
 for(const b of buttons)b.props.onClick();assert.equal(h.edits.length,0);
 input.props.onChange(event('一'));h.render();assert.equal(h.input().props.value,'一');assert.equal(h.events.at(-1).pending,true);assert.equal(h.events.at(-1).dirty,true);assert.equal(h.events.at(-1).text,'一');assert.ok(h.buttons().every(b=>b.props.disabled));
 h.input().props.onCompositionEnd(event('1e-'));assert.equal(h.edits.at(-1).points[0].frame,'1e-');assert.deepEqual(h.events.slice(-2),['edit',{session:h.events.at(-1).session,pending:false,dirty:false}]);
});
test('IME rejection rolls back completely; platform cancellation keeps the original value; disabled guard',()=>{
 const h=harness();h.input().props.onCompositionStart(event('0'));h.input().props.onChange(event('１２'));h.render();const e=event('１２');h.input().props.onCompositionEnd(e);h.render();assert.equal(e.currentTarget.value,'0');assert.equal(h.edits.length,0);assert.equal(h.input().props['aria-invalid'],true);
 h.input().props.onCompositionStart(event('0'));h.input().props.onChange(event('2'));h.render();h.input().props.onCompositionEnd(event('0'));h.render();assert.equal(h.edits.length,0);assert.equal(h.input().props.value,'0');
 h.render({disabled:true});h.input().props.onChange(event('3'));for(const b of h.buttons())b.props.onClick();assert.equal(h.edits.length,0);
});
test('trailing input events after composition settlement preserve accepted or rejected values',()=>{
 const h=harness();h.input().props.onCompositionStart(event('0'));h.input().props.onChange(event('2'));h.render();
 h.input().props.onCompositionEnd(event('2'));h.render();h.input().props.onChange(event('2'));assert.equal(h.edits.length,1);assert.equal(h.edits[0].points[0].frame,'2');
 h.input().props.onCompositionStart(event('2'));h.input().props.onChange(event('２'));h.render();h.input().props.onCompositionEnd(event('２'));h.render();
 const rejected=event('２');h.input().props.onChange(rejected);assert.equal(rejected.currentTarget.value,'2');assert.equal(h.edits.length,1);h.render();assert.equal(h.input().props['aria-invalid'],true);
 h.input().props.onCompositionStart(event('2'));h.input().props.onChange(event('3'));h.render();h.input().props.onCompositionEnd(event('2'));h.render();h.input().props.onChange(event('2'));assert.equal(h.edits.length,1);
 assert.deepEqual(h.events.at(-1),{session:h.events.at(-1).session,pending:false,dirty:false});
});
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
test('exact raw field bound and complete legacy slot counterexamples do not widen any caps',t=>{
 const bounded=envelope(Array.from({length:16},()=>({frame:'9'.repeat(8),multiplier:'9'.repeat(32)})));
 assert.equal(state.isRawVolumeEnvelope(bounded),true);const rawFieldBytes=bytes({volumeEnvelope:bounded});assert.equal(rawFieldBytes,1182);
 // ASCII admission excludes quotes, backslashes and controls: no escaping.
 // Wrapper + empty envelope scaffold + 16 point objects + 15 commas.
 assert.equal(rawFieldBytes, bytes({volumeEnvelope:envelope([])}) + 16*bytes({frame:'9'.repeat(8),multiplier:'9'.repeat(32)}) + 15);
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',escaped='\u0001'.repeat(48),hash='a'.repeat(64);
 const source={assetId:id,assetSha256:hash,versionId:id,shotId:id,jobId:id};
 const colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:hash,streamIndex:Number.MAX_SAFE_INTEGER,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:'2026-10-15T00:00:00.000Z'},look:{resourceId:id,resourceSha256:hash,resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}};
 const legacy={name:'\u0001'.repeat(200),trackId:id,startFrame:escaped,durationFrames:escaped,sourceInFrame:escaped,rect:{x:escaped,y:escaped,width:escaped,height:escaped},gain:escaped,fadeInFrames:escaped,fadeOutFrames:escaped,colour,audioRole:'music'};
 const slot={projectId:id,timelineId:id,clipId:id,revision:Number.MAX_SAFE_INTEGER,draft:{baseRevision:Number.MAX_SAFE_INTEGER,source,raw:legacy,updatedAt:'2026-10-15T00:00:00.000Z'}};
 assert.equal(clipDraftSlotSchema.safeParse(slot).success,true);
 const combined={...slot,draft:{...slot.draft,raw:{...legacy,volumeEnvelope:bounded}}};assert.ok(bytes(combined)<LOCAL_DRAFT_LIMITS.rowBytes);
 const unsafe={...combined,draft:{...combined.draft,raw:{...legacy,volumeEnvelope:envelope(Array.from({length:16},()=>({frame:escaped,multiplier:escaped})))}}};assert.ok(bytes(unsafe)>LOCAL_DRAFT_LIMITS.rowBytes);assert.equal(state.isRawVolumeEnvelope(unsafe.draft.raw.volumeEnvelope),false);
 // Existing schema permits arbitrarily long fractional seconds. A legal old
 // slot can fit exactly while the newly bounded field still exceeds rowBytes.
 const delta=LOCAL_DRAFT_LIMITS.rowBytes-bytes(slot);const full={...slot,draft:{...slot.draft,updatedAt:'2026-10-15T00:00:00.'+'0'.repeat(3+delta)+'Z'}};
 assert.equal(clipDraftSlotSchema.safeParse(full).success,true);assert.equal(bytes(full),8192);
 const overflow={...full,draft:{...full.draft,raw:{...legacy,volumeEnvelope:bounded}}};assert.ok(bytes(overflow)>8192);
 assert.deepEqual(LOCAL_DRAFT_LIMITS,{slots:128,rowBytes:8192,envelopeBytes:2097152,httpBytes:12288,urlBytes:2048});
 t.diagnostic(JSON.stringify({rawFieldBytes,legacySlotBytes:bytes(slot),boundedCombinedBytes:bytes(combined),unboundedEnvelopeCounterexampleBytes:bytes(unsafe),fullLegalLegacyBytes:bytes(full),boundedOverflowBytes:bytes(overflow)}));
});

test('retained old control handlers cannot edit or end a newer same-row composition',()=>{
 const h=harness();h.input().props.onCompositionStart(event('0'));h.render();const old=h.input();
 old.props.onCompositionEnd(event('1'));h.render();h.input().props.onCompositionStart(event('1'));h.render();
 const current=h.input(),session=h.events.at(-1).session,before=h.edits.length;
 old.props.onChange(event('99'));old.props.onCompositionEnd(event('99'));h.render();
 assert.equal(h.edits.length,before);assert.equal(h.events.at(-1).pending,true);assert.equal(h.events.at(-1).session,session);assert.equal(h.input().props.value,'1');
 assert.ok(h.buttons().every(b=>b.props.disabled));
 current.props.onCompositionEnd(event('2'));h.render();assert.equal(h.edits.at(-1).points[0].frame,'2');assert.equal(h.events.at(-1).pending,false);
});
test('composition start and end can settle synchronously before pending rerender',()=>{
 const h=harness(),input=h.input();input.props.onCompositionStart(event('0'));input.props.onChange(event('2'));input.props.onCompositionEnd(event('2'));h.render();
 assert.equal(h.edits.at(-1).points[0].frame,'2');assert.equal(h.events.at(-1).pending,false);
});
