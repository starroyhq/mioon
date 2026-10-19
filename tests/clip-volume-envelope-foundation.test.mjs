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
function harness(locale='en', initial=raw([['0','1']]).volumeEnvelope, duration=10) {
 const hooks=[];let cursor=0, tree, edits=[], events=[];
 const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),useId:()=> 'test-envelope',useRef:initial=>hooks[cursor++]??=( {current:initial}),useState(initial){const at=cursor++;hooks[at]??={value:typeof initial==='function'?initial():initial};return [hooks[at].value,value=>{hooks[at].value=typeof value==='function'?value(hooks[at].value):value;}];}};react.default=react;
 const module={exports:{}};
 Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/ClipVolumeEnvelopeControls.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)(name=>name==='react'?react:name.includes('I18nProvider')?i18nTestModule(locale):name.endsWith('clip-volume-envelope-state.ts')?state:name.endsWith('timeline-volume-envelope.ts')?contract:assert.fail(name),module,module.exports);
 const props={value:initial,proposedDuration:duration,onEdit(value){edits.push(value);props.value=value;events.push('edit');},onCompositionChange(value){events.push(value);}};
 const h={props,edits,events,render(patch={}){Object.assign(props,patch);cursor=0;tree=module.exports.default(props);return tree;},input(field='frame',row=0){return nodes(tree).find(n=>n.props?.['data-testid']===`envelope-${row}-${field}`);},buttons(){return nodes(tree).filter(n=>n.type==='button');},all(){return nodes(tree);}};h.render();return h;
}
const event=(value,extras={})=>({currentTarget:{value},...extras});
const byTestId=(h,id)=>h.all().find(node=>node.props?.['data-testid']===id);
const preset=(h,kind)=>byTestId(h,`envelope-preset-${kind}`);
test('fade preset helper is bounded, exact and returns independent raw replacement curves',()=>{
 for(const kind of ['in','out'])for(const duration of [1,15,30,60,18000])for(const length of [...new Set([1,Math.min(15,duration),duration])]){
  const actual=state.createVolumeEnvelopeFadePreset(kind,duration,length);
  const expected=kind==='in'?[['0','0'],[String(length),'1']]:[[String(duration-length),'1'],[String(duration),'0']];
  assert.deepEqual(actual,raw(expected).volumeEnvelope);
  assert.equal(state.validateRawVolumeEnvelope({volumeEnvelope:actual},duration).valid,true);
  const other=state.createVolumeEnvelopeFadePreset(kind,duration,length);
  assert.notEqual(actual,other);assert.notEqual(actual.points,other.points);assert.notEqual(actual.points[0],other.points[0]);
  actual.points[0].multiplier='0.75';assert.deepEqual(other,raw(expected).volumeEnvelope);
 }
 for(const kind of ['', 'fade-in', undefined, null, 1])assert.equal(state.createVolumeEnvelopeFadePreset(kind,60,30),undefined);
 for(const duration of [0,-0,-1,18001,1.5,NaN,Infinity,-Infinity,'60',null,undefined])assert.equal(state.createVolumeEnvelopeFadePreset('in',duration,1),undefined);
 for(const length of [0,-0,-1,61,1.5,NaN,Infinity,-Infinity,'30',null,undefined])assert.equal(state.createVolumeEnvelopeFadePreset('out',60,length),undefined);
});
test('preset curves retain linear endpoint limits and half-open playback samples',()=>{
 const durationFrames=120, samples=durationFrames*1600;
 const evaluator=kind=>{
  const validated=state.validateRawVolumeEnvelope({volumeEnvelope:state.createVolumeEnvelopeFadePreset(kind,durationFrames,30)},durationFrames);
  assert.equal(validated.valid,true);return contract.createVolumeEnvelopeEvaluator({durationFrames,...validated.fields});
 };
 const fadeIn=evaluator('in'),fadeOut=evaluator('out');
 assert.equal(fadeIn.atSample(0),0);assert.equal(fadeIn.atSample(15*1600),.5);assert.equal(fadeIn.atSample(30*1600),1);
 assert.equal(fadeIn.limitAtSample(samples),1);assert.equal(fadeIn.atSample(samples-1),1);assert.equal(fadeIn.atSample(samples),0);
 assert.equal(fadeOut.atSample(0),1);assert.equal(fadeOut.atSample(90*1600),1);assert.equal(fadeOut.atSample(105*1600),.5);
 assert.ok(Math.abs(fadeOut.atSample(samples-1)-1/48000)<1e-14);assert.equal(fadeOut.limitAtSample(samples),0);assert.equal(fadeOut.atSample(samples),0);
});
test('all four locales expose explicit replacement presets, fixed frame choices and Save disclosure',()=>{
 const locales=['zh-Hans','zh-Hant','en','ja'];
 for(const suffix of ['title','hint','duration','frames','in','out','unavailable'])assert.deepEqual(Object.keys(volumeEnvelopeMessages[`volume.envelope.preset.${suffix}`]).sort(),[...locales].sort());
 for(const locale of locales){
  const h=harness(locale);h.render({proposedDuration:120});const select=byTestId(h,'envelope-preset-frames');
  assert.equal(select.type,'select');assert.equal(select.props.value,30);assert.equal(select.props.disabled,false);
  assert.deepEqual(nodes(select.props.children).filter(node=>node.type==='option').map(node=>[node.props.value,node.props.children[0]]),[15,30,60].map(frames=>[frames,translate(locale,'volume.envelope.preset.frames',{frames})]));
  assert.ok(h.all().some(node=>node.type==='label'&&node.props.htmlFor===select.props.id&&node.props.children[0]===translate(locale,'volume.envelope.preset.duration')));
  assert.ok(h.all().some(node=>node.type==='p'&&node.props.children[0]===translate(locale,'volume.envelope.preset.hint')));
  for(const kind of ['in','out']){const button=preset(h,kind);assert.equal(button.props.type,'button');assert.equal(button.props.disabled,false);assert.equal(button.props.children[0],translate(locale,`volume.envelope.preset.${kind}`));}
 }
});
test('real preset buttons replace every point only on click and leave point editing available',()=>{
 const initial=raw([['0','0.25'],['40','0.75'],['120','0.5']]).volumeEnvelope,h=harness('en',initial);h.render({proposedDuration:120});
 byTestId(h,'envelope-preset-frames').props.onChange(event('60'));assert.equal(h.edits.length,0);h.render();
 preset(h,'in').props.onClick();assert.deepEqual(h.edits.at(-1),raw([['0','0'],['60','1']]).volumeEnvelope);assert.deepEqual(initial,raw([['0','0.25'],['40','0.75'],['120','0.5']]).volumeEnvelope);
 h.render();preset(h,'out').props.onClick();assert.deepEqual(h.edits.at(-1),raw([['60','1'],['120','0']]).volumeEnvelope);
 h.render();h.input('multiplier',1).props.onChange(event('0.25'));assert.deepEqual(h.edits.at(-1),raw([['60','1'],['120','0.25']]).volumeEnvelope);
});
test('too-long and invalid-duration presets refuse clicks without clamping or clearing the draft',()=>{
 for(const duration of [0,NaN,Infinity,1.5,18001,14]){
  const h=harness();h.render({proposedDuration:duration});for(const kind of ['in','out']){assert.equal(preset(h,kind).props.disabled,true);preset(h,kind).props.onClick();}
  assert.equal(h.edits.length,0);assert.ok(h.all().some(node=>node.props.role==='status'&&node.props.children[0]===translate('en','volume.envelope.preset.unavailable')));
 }
 const h=harness();h.render({proposedDuration:20});assert.deepEqual(nodes(byTestId(h,'envelope-preset-frames').props.children).filter(node=>node.type==='option').map(node=>node.props.disabled),[false,true,true]);
 preset(h,'in').props.onClick();assert.equal(h.edits.length,0);
 byTestId(h,'envelope-preset-frames').props.onChange(event('15'));h.render();assert.equal(preset(h,'in').props.disabled,false);preset(h,'in').props.onClick();assert.deepEqual(h.edits.at(-1),raw([['0','0'],['15','1']]).volumeEnvelope);
});
test('preset event guards synchronously reject disabled, IME-pending and retained old-render actions',()=>{
 const h=harness();h.render({proposedDuration:120});let oldIn=preset(h,'in'),oldOut=preset(h,'out'),oldSelect=byTestId(h,'envelope-preset-frames');
 h.render({disabled:true});oldIn.props.onClick();oldOut.props.onClick();oldSelect.props.onChange(event('60'));
 for(const kind of ['in','out'])preset(h,kind).props.onClick();byTestId(h,'envelope-preset-frames').props.onChange(event('60'));assert.equal(h.edits.length,0);
 h.render({disabled:false});const input=h.input(),beforeComposition=preset(h,'in'),select=byTestId(h,'envelope-preset-frames');
 input.props.onCompositionStart(event('0'));beforeComposition.props.onClick();select.props.onChange(event('60'));assert.equal(h.edits.length,0);
 h.render();assert.equal(preset(h,'in').props.disabled,true);assert.equal(byTestId(h,'envelope-preset-frames').props.disabled,true);
 h.input().props.onCompositionEnd(event('0'));h.render();assert.equal(byTestId(h,'envelope-preset-frames').props.value,30);
 oldIn=preset(h,'in');oldOut=preset(h,'out');oldSelect=byTestId(h,'envelope-preset-frames');h.render({proposedDuration:90});
 oldIn.props.onClick();oldOut.props.onClick();oldSelect.props.onChange(event('60'));h.render();assert.equal(h.edits.length,0);assert.equal(byTestId(h,'envelope-preset-frames').props.value,30);
 for(const value of ['0','45','NaN','Infinity','abc']){byTestId(h,'envelope-preset-frames').props.onChange(event(value));h.render();assert.equal(byTestId(h,'envelope-preset-frames').props.value,30);}
 preset(h,'out').props.onClick();assert.deepEqual(h.edits.at(-1),raw([['60','1'],['90','0']]).volumeEnvelope);
});
test('four locales render text inputs, accessible labels, bounded rows and non-submit buttons',()=>{
 assert.deepEqual(validateCatalogs(volumeEnvelopeMessages),[]);
 for(const locale of ['zh-Hans','zh-Hant','en','ja']){
  const h=harness(locale);assert.equal(h.all().find(n=>n.type==='legend').props.children[0],translate(locale,'volume.envelope.title'));
  for(const input of h.all().filter(n=>n.type==='input')){assert.equal(input.props.type,'text');assert.equal(input.props.maxLength,undefined);assert.ok(h.all().some(n=>n.type==='label'&&n.props.htmlFor===input.props.id));}
  assert.ok(h.buttons().every(n=>n.props.type==='button'));h.buttons().at(-1).props.onClick();assert.equal(h.edits.at(-1),null);
 }
 const h=harness('en',raw(Array.from({length:16},(_,i)=>[String(i),'1'])).volumeEnvelope);assert.equal(h.all().filter(n=>n.type==='input'&&n.props?.['data-testid']?.startsWith('envelope-')).length,32);assert.equal(h.buttons().at(-2).props.disabled,true);h.buttons().at(-2).props.onClick();assert.equal(h.edits.length,0);
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

const duckingFields=['startFrame','endFrame','multiplier','attackFrames','releaseFrames'];
const duckingBase={startFrame:20,endFrame:100,multiplier:.25,attackFrames:10,releaseFrames:20};
const duckingRaw=value=>Object.fromEntries(Object.entries(value).map(([key,value])=>[key,String(value)]));
const duckingInput=(h,field)=>byTestId(h,`ducking-${field}`);
function changeDucking(h,values){for(const [field,value] of Object.entries(values)){duckingInput(h,field).props.onChange(event(String(value)));h.render();}}
test('manual ducking constructs exact ramps, plateau anchors and boundary-only zero slopes',()=>{
 const cases=[
  [120,duckingBase,[['20','1'],['30','0.25'],['80','0.25'],['100','1']]],
  [120,{...duckingBase,startFrame:20,endFrame:80,attackFrames:30,releaseFrames:30},[['20','1'],['50','0.25'],['80','1']]],
  [120,{...duckingBase,startFrame:0,endFrame:120,attackFrames:0,releaseFrames:0},[['0','0.25'],['120','0.25']]],
  [120,{...duckingBase,multiplier:1,attackFrames:0,releaseFrames:0},[['20','1'],['100','1']]],
  [120,{...duckingBase,startFrame:0,attackFrames:0},[['0','0.25'],['80','0.25'],['100','1']]],
  [120,{...duckingBase,endFrame:120,releaseFrames:0},[['20','1'],['30','0.25'],['120','0.25']]],
  [1,{startFrame:0,endFrame:1,multiplier:0,attackFrames:0,releaseFrames:0},[['0','0'],['1','0']]],
  [1,{startFrame:0,endFrame:1,multiplier:.25,attackFrames:1,releaseFrames:0},[['0','1'],['1','0.25']]],
  [1,{startFrame:0,endFrame:1,multiplier:.25,attackFrames:0,releaseFrames:1},[['0','0.25'],['1','1']]],
  [18000,{startFrame:0,endFrame:18000,multiplier:Number.MIN_VALUE,attackFrames:1,releaseFrames:1},[['0','1'],['1',String(Number.MIN_VALUE)],['17999',String(Number.MIN_VALUE)],['18000','1']]],
 ];
 for(const [duration,input,points] of cases){
  const before=structuredClone(input),value=state.createManualDuckingEnvelope(duration,input);
  assert.deepEqual(value,raw(points).volumeEnvelope);assert.deepEqual(input,before);
  assert.equal(state.validateRawVolumeEnvelope({volumeEnvelope:value},duration).valid,true);
  assert.deepEqual(state.manualDuckingEnvelopeFromRaw(duration,duckingRaw(input)),value);
  const other=state.createManualDuckingEnvelope(duration,input);assert.notEqual(value,other);assert.notEqual(value.points,other.points);value.points[0].multiplier='0.5';assert.deepEqual(other,raw(points).volumeEnvelope);
 }
});
test('manual ducking rejects invalid numbers and impossible internal edges without inventing frames',()=>{
 for(const duration of [0,-1,1.5,18001,NaN,Infinity,'120',null])assert.equal(state.createManualDuckingEnvelope(duration,duckingBase),undefined);
 for(const [field,values] of Object.entries({startFrame:[-1,1.5,100,101,NaN,Infinity,'20'],endFrame:[0,20,121,1.5,NaN,Infinity],multiplier:[-.1,-0,1.1,NaN,Infinity,'0.25'],attackFrames:[-1,.5,NaN,Infinity,81],releaseFrames:[-1,.5,NaN,Infinity,81]}))for(const value of values)assert.equal(state.createManualDuckingEnvelope(120,{...duckingBase,[field]:value}),undefined,`${field}=${String(value)}`);
 for(const input of [{...duckingBase,attackFrames:0},{...duckingBase,releaseFrames:0},{...duckingBase,attackFrames:50,releaseFrames:31},{startFrame:0,endFrame:1,multiplier:.25,attackFrames:1,releaseFrames:1}])assert.equal(state.createManualDuckingEnvelope(input.endFrame===1?1:120,input),undefined);
 for(const field of duckingFields)for(const text of ['', '.', '1e-', '１２', ' 1', '1\n', '0x10', 'Infinity'])assert.equal(state.manualDuckingEnvelopeFromRaw(120,{...duckingRaw(duckingBase),[field]:text}),undefined,`${field}:${JSON.stringify(text)}`);
 assert.equal(state.manualDuckingEnvelopeFromRaw(120,{...duckingRaw(duckingBase),startFrame:'9'.repeat(9)}),undefined);
 assert.equal(state.manualDuckingEnvelopeFromRaw(120,{...duckingRaw(duckingBase),multiplier:'0.'+'0'.repeat(31)}),undefined);
});
test('manual ducking evaluator holds unity outside the selected range and preserves half-open playback',()=>{
 const value=state.createManualDuckingEnvelope(120,duckingBase),parsed=state.validateRawVolumeEnvelope({volumeEnvelope:value},120);assert.equal(parsed.valid,true);
 const evaluate=contract.createVolumeEnvelopeEvaluator({durationFrames:120,...parsed.fields});
 for(const [frame,multiplier] of [[0,1],[19,1],[20,1],[25,.625],[30,.25],[60,.25],[80,.25],[90,.625],[100,1],[119,1]])assert.equal(evaluate.atSample(frame*1600),multiplier);
 assert.equal(evaluate.limitAtSample(120*1600),1);assert.equal(evaluate.atSample(120*1600),0);
 const full=state.validateRawVolumeEnvelope({volumeEnvelope:state.createManualDuckingEnvelope(1,{startFrame:0,endFrame:1,multiplier:.25,attackFrames:0,releaseFrames:0})},1);assert.equal(full.valid,true);
 const endpoint=contract.createVolumeEnvelopeEvaluator({durationFrames:1,...full.fields});assert.equal(endpoint.atSample(1599),.25);assert.equal(endpoint.limitAtSample(1600),.25);assert.equal(endpoint.atSample(1600),0);
});
test('manual ducking parameters are temporary text controls and Apply alone replaces the draft',()=>{
 const initial=raw([['0','0.5'],['60','1'],['120','0.5']]).volumeEnvelope,h=harness('en',initial,120);
 assert.deepEqual(Object.fromEntries(duckingFields.map(field=>[field,duckingInput(h,field).props.value])),{startFrame:'0',endFrame:'120',multiplier:'0.25',attackFrames:'30',releaseFrames:'30'});
 for(const field of duckingFields){const input=duckingInput(h,field);assert.equal(input.props.type,'text');assert.ok(h.all().some(node=>node.type==='label'&&node.props.htmlFor===input.props.id));}
 changeDucking(h,duckingBase);assert.equal(h.edits.length,0);assert.deepEqual(h.props.value,initial);
 const apply=byTestId(h,'ducking-apply');assert.equal(apply.props.type,'button');assert.equal(apply.props.disabled,false);apply.props.onClick();
 assert.deepEqual(h.edits.at(-1),raw([['20','1'],['30','0.25'],['80','0.25'],['100','1']]).volumeEnvelope);assert.deepEqual(initial,raw([['0','0.5'],['60','1'],['120','0.5']]).volumeEnvelope);
 h.render();h.input('multiplier',1).props.onChange(event('0.5'));assert.equal(h.edits.at(-1).points[1].multiplier,'0.5');
});
test('all four manual ducking copies disclose temporary settings, full replacement and original Save',()=>{
 const locales=['zh-Hans','zh-Hant','en','ja'];
 for(const suffix of ['title','hint','temporary','bounds',...duckingFields,'apply'])assert.deepEqual(Object.keys(volumeEnvelopeMessages[`volume.ducking.${suffix}`]).sort(),[...locales].sort());
 for(const locale of locales){
  const h=harness(locale,raw([['0','1']]).volumeEnvelope,120);assert.equal(byTestId(h,'ducking-apply').props.children[0],translate(locale,'volume.ducking.apply'));
  for(const suffix of ['hint','temporary','bounds'])assert.ok(h.all().some(node=>node.type==='p'&&node.props.children[0]===translate(locale,`volume.ducking.${suffix}`)));
  for(const field of duckingFields)assert.ok(h.all().some(node=>node.type==='label'&&node.props.htmlFor===duckingInput(h,field).props.id&&node.props.children[0]===translate(locale,`volume.ducking.${field}`)));
 }
});
test('one-frame manual Apply supports exact boundary zero ramps and refuses overlapping ramps',()=>{
 for(const [attackFrames,releaseFrames,expected] of [[0,0,[['0','0.25'],['1','0.25']]],[1,0,[['0','1'],['1','0.25']]],[0,1,[['0','0.25'],['1','1']]],[1,1,null]]){
  const h=harness('en',raw([['0','1']]).volumeEnvelope,1);changeDucking(h,{attackFrames,releaseFrames});const apply=byTestId(h,'ducking-apply');assert.equal(apply.props.disabled,expected===null);apply.props.onClick();
  if(expected)assert.deepEqual(h.edits.at(-1),raw(expected).volumeEnvelope);else assert.equal(h.edits.length,0);
 }
});
test('manual ducking invalid/oversize inputs and disabled Apply retain the complete existing curve',()=>{
 for(const values of [{startFrame:'20',attackFrames:'0'},{endFrame:'100',releaseFrames:'0'},{startFrame:'100',endFrame:'20'},{multiplier:'1.1'},{attackFrames:'100'},{multiplier:'1e-'}]){
  const h=harness('en',curveForDucking(),120);changeDucking(h,values);const apply=byTestId(h,'ducking-apply');assert.equal(apply.props.disabled,true);apply.props.onClick();assert.equal(h.edits.length,0);assert.deepEqual(h.props.value,curveForDucking());
 }
 const h=harness('en',curveForDucking(),120),input=duckingInput(h,'startFrame'),oversize=event('9'.repeat(9));input.props.onChange(oversize);h.render();assert.equal(duckingInput(h,'startFrame').props.value,'0');assert.equal(h.edits.length,0);
 h.render({disabled:true});for(const field of duckingFields)assert.equal(duckingInput(h,field).props.disabled,true);byTestId(h,'ducking-apply').props.onClick();assert.equal(h.edits.length,0);
});
function curveForDucking(){return raw([['0','0.5'],['120','1']]).volumeEnvelope;}
test('manual ducking Enter never bubbles a submit and stale render handlers cannot replace or change parameters',()=>{
 const h=harness('en',curveForDucking(),120);
 for(const field of duckingFields){let prevented=0;const e={key:'Enter',preventDefault(){prevented++;},stopPropagation(){}};duckingInput(h,field).props.onKeyDown(e);assert.equal(prevented,1);}
 assert.equal(h.edits.length,0);const apply=byTestId(h,'ducking-apply'),old=duckingInput(h,'startFrame');h.render();
 old.props.onChange(event('20'));old.props.onCompositionStart(event('0'));apply.props.onClick();h.render();assert.equal(duckingInput(h,'startFrame').props.value,'0');assert.equal(h.edits.length,0);assert.equal(h.events.length,0);
});
test('manual ducking IME uses one synchronous pending owner and rejects old sessions and point/preset actions',()=>{
 const h=harness('en',curveForDucking(),120),start=duckingInput(h,'startFrame'),apply=byTestId(h,'ducking-apply'),presetIn=preset(h,'in');
 start.props.onCompositionStart(event('0'));apply.props.onClick();presetIn.props.onClick();assert.equal(h.edits.length,0);
 start.props.onChange(event('二'));h.render();const pending=h.events.at(-1);
 assert.deepEqual({...pending,session:undefined},{session:undefined,pending:true,dirty:true,target:'ducking',field:'startFrame',text:'二'});assert.equal(duckingInput(h,'startFrame').props.value,'二');assert.ok(h.buttons().every(button=>button.props.disabled));
 for(const [key,keyCode] of [['Enter',13],['Process',229]]){let prevented=0,stopped=0;duckingInput(h,'startFrame').props.onKeyDown({key,nativeEvent:{keyCode,isComposing:true},preventDefault(){prevented++;},stopPropagation(){stopped++;}});assert.equal(prevented,0,'native composition confirmation must not be cancelled');assert.equal(stopped,1);}
 const old=duckingInput(h,'startFrame');old.props.onCompositionEnd(event('20'));h.render();assert.equal(duckingInput(h,'startFrame').props.value,'20');assert.equal(h.edits.length,0);assert.equal(h.events.at(-1).pending,false);
 duckingInput(h,'startFrame').props.onCompositionStart(event('20'));h.render();const current=duckingInput(h,'startFrame'),session=h.events.at(-1).session;
 old.props.onChange(event('99'));old.props.onCompositionEnd(event('99'));h.render();assert.equal(h.events.at(-1).session,session);assert.equal(h.events.at(-1).pending,true);assert.equal(duckingInput(h,'startFrame').props.value,'20');
 current.props.onCompositionEnd(event('２０'));h.render();assert.equal(duckingInput(h,'startFrame').props.value,'20');assert.equal(h.edits.length,0);assert.equal(h.events.at(-1).pending,false);
 h.input().props.onCompositionStart(event('0'));byTestId(h,'ducking-apply').props.onClick();assert.equal(h.edits.length,0);h.render();assert.equal(duckingInput(h,'startFrame').props.disabled,true);h.input().props.onCompositionEnd(event('0'));
});
