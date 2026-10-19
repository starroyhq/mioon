import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorWindowInputs } from '../apps/web/src/editor-window-inputs.ts';
import { createEditorSettingsScope } from '../apps/web/src/editor-settings-scope.ts';
const defaults={profileId:'mp4_h264_aac_v1',resolution:'project',rateControl:{mode:'crf',quality:'standard'}};
type ReadOptions = Parameters<ReturnType<typeof createEditorWindowInputs>['read']>[0];
type MutableOptions = {-readonly [K in keyof ReadOptions]: ReadOptions[K]};
interface Fixture {inputs: ReturnType<typeof createEditorWindowInputs>; busy: Set<string>; read(): ReturnType<ReturnType<typeof createEditorWindowInputs>['read']>; options: MutableOptions; changeSettings(value: typeof defaults): void; changeRange(value: {mode: string; startText: string; endText: string}): void}
const owner = () => ({dirty:false,inflight:false,unknown:false,identity:['operation',1]});
function fixture(): Fixture {
  const inputs=createEditorWindowInputs(), busy=new Set<string>(); let selected=defaults, range={mode:'whole',startText:'',endText:''}, version=0;
  const options: MutableOptions={busy, defaultSettings:defaults, settings:{getState:()=>({scope:'p1',version,exportSettings:selected})},range:{getState:()=>({scope:'p1',version,draft:range})}};
  return {inputs,busy,read:()=>inputs.read(options),options,changeSettings(value){selected={...value};version++;},changeRange(value){range={...value};version++;}};
}
test('unknown imports remain exact window-local evidence across successful refresh or later imports',()=>{
  const f=fixture(); assert.equal(f.read().unknown,false); const a=f.inputs.beginImport('project-a'); assert.equal(f.read().busy,true);
  f.inputs.finishImport(a,true); const unknown=f.read(); assert.equal(unknown.busy,false); assert.equal(unknown.unknown,true);
  const b=f.inputs.beginImport('project-b'); f.inputs.finishImport(b,false); assert.equal(f.read().unknown,true); assert.notDeepEqual(f.read().identity,unknown.identity);
  f.inputs.finishImport(a,false); assert.equal(f.read().unknown,true,'A stale/duplicate ACK cannot erase unrelated unknown evidence');
  assert.doesNotMatch(JSON.stringify(f.read()),/dataBase64|filename|password|token/);
});
test('only transient nondefault export selections are dirty, not hydration versions or backend jobs',()=>{
  const f=fixture(); assert.equal(f.read().dirty,false); f.changeSettings({...defaults}); assert.equal(f.read().dirty,false);
  f.changeSettings({...defaults,resolution:'1080'}); assert.equal(f.read().dirty,true); f.changeSettings(defaults);
  f.changeRange({mode:'selected',startText:'0',endText:'30'}); assert.equal(f.read().dirty,true);
  f.changeRange({mode:'whole',startText:'',endText:''}); assert.equal(f.read().dirty,false);
  f.busy.add('p:business-write'); assert.equal(f.read().busy,true); f.busy.clear(); assert.equal(f.read().busy,false);
});
test('navigation excludes only local orchestration latches while close still waits for the flow',()=>{
  const f=fixture(); f.busy.add('p:project-create-flow'); f.busy.add('p:structure');
  assert.equal(f.read().busy,true); assert.equal(f.inputs.read({...f.options,navigation:true}).busy,false);
  f.busy.add('p:project-create'); assert.equal(f.inputs.read({...f.options,navigation:true}).busy,true);
  f.busy.clear(); const token=f.inputs.beginImport('p'); f.inputs.finishImport(token,true);
  assert.equal(f.inputs.read({...f.options,navigation:true}).unknown,true);
});
test('pure reads never synchronize or write controller state and unknown DELETE is separate from dirty',()=>{
  const f=fixture(); let reads=0; f.options.clip={getEditorCloseSnapshot(){reads++;return {...owner(),unknown:true};}} as never;
  const first=f.read(); const second=f.read(); assert.equal(reads,2); assert.equal(first.unknown,true); assert.equal(first.dirty,false); assert.deepEqual(first,second);
});
test('native settings entry synchronously suspends consent before IPC and retains drafts across focus return',async()=>{
  const events: unknown[][] = []; const gate=Promise.withResolvers<boolean>(); let draft='private draft',consent=true;
  const scope=createEditorSettingsScope(async (slot: string)=>{events.push(['ipc',slot,consent]);return gate.promise;});
  const release=scope.subscribe((active: boolean)=>{if(!active)consent=false;events.push(['visible',active]);});
  const request=scope.open('agent'); assert.equal(scope.active,false); assert.deepEqual(events.at(-1),['ipc','agent',false]); assert.equal(draft,'private draft');
  gate.resolve(true); assert.equal(await request,true); assert.equal(scope.active,false); scope.focus(); assert.equal(scope.active,true); assert.equal(consent,false);
  scope.dispose(); scope.activate(true); assert.equal(scope.active,true,'StrictMode setup restores observed focus'); release();
});
test('late failed settings request cannot reactivate a subsequently blurred/replaced interaction',async()=>{
  const gate=Promise.withResolvers<boolean>(), scope=createEditorSettingsScope(()=>gate.promise);
  const request=scope.open('official'); scope.blur(); gate.resolve(false); await request; assert.equal(scope.active,false);
  scope.dispose(); scope.activate(false); assert.equal(scope.active,false);
});
