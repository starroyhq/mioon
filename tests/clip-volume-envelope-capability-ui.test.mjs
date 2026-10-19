import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { isWorkspaceRestoreInspection, canEditTimelineVolumeEnvelope } from '../packages/contracts/src/workspace-restore.mjs';
import { VOLUME_ENVELOPE_PROFILE } from '../packages/contracts/src/timeline-volume-envelope.ts';
import { clipVolumeEnvelopeCapabilityMatches, observeClipVolumeEnvelopeCapability } from '../apps/web/src/clip-volume-envelope-capability.ts';
import { validateCatalogs, translate } from '../packages/i18n/src/index.ts';
import { volumeEnvelopeMessages } from '../packages/i18n/src/catalogs/volume-envelope.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { rawVolumeEnvelopeChanged } from '../apps/web/src/clip-volume-envelope-state.ts';
import * as opacityState from '../apps/web/src/clip-opacity-envelope-state.ts';
import * as opacityAssembly from '../apps/web/src/clip-opacity-candidate-assembly.ts';
import * as imeSubmitGuard from '../apps/web/src/opacity-ime-submit-guard.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import * as removalState from '../apps/web/src/timeline-removal.ts';
import {hasOpenWorkbenchModal} from '../apps/web/src/workbench-modal-state.ts';
const capability={profileId:VOLUME_ENVELOPE_PROFILE,editable:true};
const normal={restored:false};
const id=n=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const restored={restored:true,schemaVersion:41,profile:'restored-local-v9',workspaceOrigin:id(1),restorationId:id(2),createdAt:'2026-10-15T00:00:00.000Z',source:{backupId:id(3),schemaVersion:40,manifestHash:'a'.repeat(64),dbHash:'b'.repeat(64)},heldCounts:[],operationPolicy:[{operation:'timeline.clip.update',available:true,reason:'AVAILABLE'}],backupCreate:{available:false,reason:'RESTORE_BACKUP_UNAVAILABLE'}};
const matches=(a,b)=>clipVolumeEnvelopeCapabilityMatches(a,b,isWorkspaceRestoreInspection,canEditTimelineVolumeEnvelope);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('envelope capability requires exact profile and verified workspace identity, never generic update access',()=>{
 assert.equal(isWorkspaceRestoreInspection(restored),true);
 for(const workspace of [normal,restored]){
  assert.equal(matches(workspace,{...workspace,volumeEnvelopeCapability:capability}),true);
  for(const value of [workspace,null,{...workspace,volumeEnvelopeCapability:{...capability,editable:false}},{...workspace,volumeEnvelopeCapability:{...capability,profileId:'future'}},{...workspace,volumeEnvelopeCapability:{...capability,extra:true}}])assert.equal(matches(workspace,value),false);
 }
 for(const field of ['workspaceOrigin','restorationId'])assert.equal(matches(restored,{...restored,[field]:id(7),volumeEnvelopeCapability:capability}),false);
 for(const field of ['backupId','manifestHash','dbHash'])assert.equal(matches(restored,{...restored,source:{...restored.source,[field]:field==='backupId'?id(7):'c'.repeat(64)},volumeEnvelopeCapability:capability}),false);
 const old={...restored,schemaVersion:39,profile:'restored-local-v8',source:{...restored.source,schemaVersion:38}};
 assert.equal(isWorkspaceRestoreInspection(old),true);assert.equal(matches(old,{...old,volumeEnvelopeCapability:capability}),false);
});
test('optional capability is bounded, failure-isolated and connection-epoch fenced',async()=>{
 const seen=[];let resolve,epoch=1;
 observeClipVolumeEnvelopeCapability(normal,()=>new Promise(r=>resolve=r),isWorkspaceRestoreInspection,canEditTimelineVolumeEnvelope,()=>epoch===1,x=>seen.push(x));await tick();epoch=2;resolve({...normal,volumeEnvelopeCapability:capability});await tick();assert.deepEqual(seen,[]);
 const run=async read=>{observeClipVolumeEnvelopeCapability(normal,read,isWorkspaceRestoreInspection,canEditTimelineVolumeEnvelope,()=>true,x=>seen.push(x));await tick();};
 await run(async()=>{throw Error('legacy rejects optional input');});assert.equal(seen.at(-1),'unavailable');
 await run(async()=>({...normal,volumeEnvelopeCapability:{...capability,editable:false}}));assert.equal(seen.at(-1),'unsupported');
 await run(async()=>({...normal,volumeEnvelopeCapability:capability}));assert.equal(seen.at(-1),'editable');
 let signal;await new Promise(done=>observeClipVolumeEnvelopeCapability(normal,s=>{signal=s;return new Promise(()=>{});},isWorkspaceRestoreInspection,canEditTimelineVolumeEnvelope,()=>true,x=>{seen.push(x);done();},5));assert.equal(seen.at(-1),'unavailable');assert.equal(signal.aborted,true);
});
const nodes=t=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)];
function inspector(locale='en', eligible=true, supported=true){
 const hooks=[];let cursor=0,tree,capture=0;const calls=[];
 const raw={name:'clip',trackId:id(4),startFrame:'0',durationFrames:'10',sourceInFrame:'0',gain:'1',rect:{x:'0',y:'0',width:'720',height:'1280'},volumeEnvelope:{profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:'0',multiplier:'1'}]}};
 const state={raw,dirty:true,conflict:false,compositionPending:false};
 const token={owner:1};const controller={capture:()=>({serial:capture}),isDiscarding:()=>false,hasPendingComposition:()=>state.compositionPending,hasUnsaved:()=>state.dirty,getState:()=>state,edit:()=>true,discard:()=>calls.push('discard'),save:()=>calls.push('save'),beginVolumeComposition:c=>{calls.push(['begin',c]);state.compositionPending=true;return token;},updateVolumeComposition:(t,s)=>{calls.push(['update',t,s]);capture++;return true;},endVolumeComposition:t=>{calls.push(['end',t]);state.compositionPending=false;return true;},editVolumeEnvelope:(v,c)=>{calls.push(['edit',v,c]);state.raw={...state.raw,volumeEnvelope:v};return true;}};
 const removalModule={exports:{}};
 const react={createElement:(type,props,...children)=>type===removalModule.exports.ClipActionsMenu?type({...props,children}):({type,props:{...props,children}}),useRef:initial=>hooks[cursor++]??={current:initial},useState:initial=>{const at=cursor++;hooks[at]??={value:initial};return[hooks[at].value,next=>{hooks[at].value=typeof next==='function'?next(hooks[at].value):next;}];},useEffect(){},useLayoutEffect:fn=>{fn();}};react.default=react;
 const stubs={};const stub=name=>stubs[name]??=(props=>props);
 Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/ClipRemovalControls.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)(name=>{
  if(name==='react')return react;
  if(name.includes('I18nProvider'))return i18nTestModule(locale);
  if(name==='./timeline-removal.ts')return removalState;
  if(name==='./workbench-modal-state.ts')return {hasOpenWorkbenchModal};
  if(name.startsWith('@mioon/ui/'))return new Proxy({}, {get:(_,key)=>stub(key)});
  return assert.fail(name);
 },removalModule,removalModule.exports);
 const module={exports:{}};Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/TimelineInspector.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(name=>{
  if(name==='react')return react;
  if(name==='./UiPreferencesProvider.tsx')return {useUiPreferences:()=>({preferences:DEFAULT_UI_PREFERENCES})};
  if(name==='./timeline-removal.ts')return removalState;
  if(name==='./ClipRemovalControls.tsx')return removalModule.exports;
  if(name.includes('I18nProvider'))return i18nTestModule(locale);
  if(name.includes('i18n/src/index'))return {message:(key)=>({key})};
  if(name.includes('workbench-confirm'))return {useConfirmation:()=>async()=>{calls.push('confirm');return true;}};
  if(name==='@mioon/contracts')return {sourceFrameCount:()=>10,isTimelineRecord:()=>true};
  if(name.endsWith('/Timeline.jsx'))return {assetKind:a=>a.mimeType.split('/')[0],framesLabel:String};
  if(name.endsWith('clip-draft-hook.ts'))return {useClipDraft:()=>({state,controller})};
  if(name.endsWith('clip-draft-state.ts'))return {clipDraftRaw:clip=>({...raw,volumeEnvelope:clip.volumeEnvelope}),clipDraftSource:()=>({}),clipDraftPatch:()=>({})};
  if(name.endsWith('clip-volume-envelope-state.ts'))return {rawVolumeEnvelopeChanged};
  if(name.endsWith('clip-opacity-envelope-state.ts'))return opacityState;
  if(name.endsWith('clip-opacity-candidate-assembly.ts'))return opacityAssembly;
  if(name.endsWith('opacity-ime-submit-guard.ts'))return imeSubmitGuard;
  if(name.endsWith('clip-audio-role-state.ts'))return {clipAudioRoleChanged:()=>false};
  if(name.endsWith('clip-audio-state.js'))return {clipAudioIssue:()=>''};
  if(name.endsWith('timeline-format-state.js'))return {timelineRectIssue:()=>'',timelineRectMessage:()=>''};
  if(name.endsWith('workspace-visibility.jsx'))return {useWorkspaceVisibility:()=>true};
  if(name.endsWith('.css'))return {};
  if(name.startsWith('@mioon/ui/'))return new Proxy({}, {get:(_,key)=>stub(key)});
  return {__esModule:true,default:stub(name)};
 },module,module.exports);
 const props={clip:{id:id(5),assetId:id(6),volumeEnvelope:undefined},timeline:{projectId:id(1),id:id(2),revision:1,width:720,height:1280,tracks:[]},asset:{mimeType:'audio/wav',hasAudio:eligible},draftContext:{volumeEnvelopeEditable:supported,volumeEnvelopeCapability:supported?'editable':'unsupported'},onSave:()=>{},onRemove:()=>calls.push('remove')};
 const h={calls,state,controller,token,props,render(){cursor=0;tree=module.exports.default(props);return tree;},all:()=>nodes(tree),editor:()=>nodes(tree).find(n=>n.type===stubs['./ClipVolumeEnvelopeControls.tsx']),form:()=>nodes(tree).find(n=>n.type==='form'),button:testid=>nodes(tree).find(n=>n.props?.['data-testid']===testid)};h.render();return h;
}
function duckingKey(key='Enter',keyCode=13,isComposing=false,repeat=false){
 const observed={prevented:0,stopped:0};return {observed,key,nativeEvent:{keyCode,isComposing,repeat},target:{getAttribute:name=>name==='data-testid'?'ducking-startFrame':null},preventDefault(){observed.prevented++;},stopPropagation(){observed.stopped++;}};
}
function beginDucking(h,session){h.editor().props.onCompositionChange({session,pending:true,dirty:true,target:'ducking',field:'startFrame',text:'二'});h.render();}
function endDucking(h,session){h.editor().props.onCompositionChange({session,pending:false,dirty:false});h.render();}
const submitDucking=h=>h.form().props.onSubmit({preventDefault(){}});
const saves=h=>h.calls.filter(call=>call==='save').length;
for(const [key,keyCode] of [['Enter',13],['Process',229]])test(`actual Inspector ${key}/${keyCode} ducking IME confirmation survives compositionend and submit until keyup release`,async()=>{
 const h=inspector(),session=Symbol('duck-confirm');beginDucking(h,session);const event=duckingKey(key,keyCode,true);
 h.form().props.onKeyDownCapture(event);assert.equal(event.observed.prevented,0,'native IME default must not be cancelled');
 if(key==='Enter')assert.ok(event.observed.stopped>0);
 endDucking(h,session);assert.equal(h.state.compositionPending,false);assert.equal(h.button('save-clip').props.disabled,false);
 await submitDucking(h);assert.equal(saves(h),0,'compositionend must not turn confirmation into implicit Save');
 if(key==='Enter'){const repeat=duckingKey('Enter',13,false,true);h.form().props.onKeyDownCapture(repeat);assert.equal(repeat.observed.prevented,0);await submitDucking(h);assert.equal(saves(h),0);}
 h.form().props.onKeyUpCapture(duckingKey(key,keyCode));await submitDucking(h);assert.equal(saves(h),0,'same-event default submission precedes the queued keyup release');
 await Promise.resolve();await submitDucking(h);assert.equal(saves(h),1);
});
test('actual Inspector ducking confirmation is released only by a later independent pointer after composition',async()=>{
 const h=inspector(),session=Symbol('duck-pointer');beginDucking(h,session);h.form().props.onKeyDownCapture(duckingKey('Enter',13,true));
 h.form().props.onPointerDownCapture();await submitDucking(h);assert.equal(saves(h),0);endDucking(h,session);
 await submitDucking(h);assert.equal(saves(h),0);h.form().props.onPointerDownCapture();await submitDucking(h);assert.equal(saves(h),1);
});
test('an older ducking keyup microtask cannot clear a newer Inspector composition confirmation',async()=>{
 const h=inspector(),first=Symbol('first-duck'),second=Symbol('second-duck');
 beginDucking(h,first);h.form().props.onKeyDownCapture(duckingKey('Enter',13,true));endDucking(h,first);h.form().props.onKeyUpCapture(duckingKey());
 beginDucking(h,second);h.form().props.onKeyDownCapture(duckingKey('Enter',13,true));endDucking(h,second);
 await Promise.resolve();await submitDucking(h);assert.equal(saves(h),0,'first release owns the earlier confirmation only');
 h.form().props.onKeyUpCapture(duckingKey());await submitDucking(h);assert.equal(saves(h),0);await Promise.resolve();await submitDucking(h);assert.equal(saves(h),1);
});
test('Inspector wires controller-owned envelope token across renders and blocks save/remove during composition',async()=>{
 const h=inspector();const editor=h.editor();const session=Symbol('first');assert.equal(editor.props.disabled,false);
 editor.props.onCompositionChange({session,pending:true,dirty:true,row:0,field:'frame',text:'一'});h.render();assert.equal(h.button('save-clip').props.disabled,true);assert.equal(h.button('remove-clip').props.disabled,true);
 await h.button('remove-clip').props.onClick();assert.equal(h.calls.includes('confirm'),false);
 assert.equal(h.calls.includes('remove'),false);assert.equal(h.button('confirm-clip-removal').props.disabled,true);
 h.props.draftContext.volumeEnvelopeEditable=false;h.props.draftConnected=false;h.render();assert.equal(h.editor().props.disabled,false); // Never disable the active IME input before it can settle.
 h.props.draftContext.volumeEnvelopeEditable=true;h.props.draftConnected=true;
 const value={...h.state.raw.volumeEnvelope,points:[{frame:'1e-',multiplier:'1'}]};h.editor().props.onEdit(value,session);h.editor().props.onCompositionChange({session,pending:false,dirty:false});
 assert.equal(h.calls.find(c=>c[0]==='edit')[2],h.token);assert.equal(h.calls.at(-1)[1],h.token);
 h.render();assert.equal(h.button('save-clip').props.disabled,false);
});
test('unsupported or silent assets retain visible recovered envelope and localized blocked message',()=>{
 assert.deepEqual(validateCatalogs(volumeEnvelopeMessages),[]);
 for(const locale of ['en','zh-Hans','zh-Hant','ja'])for(const eligible of [true,false]){
  const h=inspector(locale,eligible,false);assert.ok(h.editor());assert.equal(h.editor().props.disabled,true);assert.equal(h.button('save-clip').props.disabled,true);
  assert.ok(h.all().some(n=>n.props?.children?.includes(translate(locale,'volume.envelope.unsupported'))));
 }
});
test('App navigation refuses composition before confirmation and rechecks after async confirmation',async()=>{
 const source=readFileSync(new URL('../apps/web/src/App.jsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  async function guardNavigation('),source.indexOf('  async function guardProjectNavigation('));
 let pending=true,confirmCount=0,discardCount=0;
 const clip={capture:()=>({}),hasUnsaved:()=>true,hasPendingComposition:()=>pending,isCurrent:()=>true,discard:async()=>{discardCount++;return true;}};
 const dependencies={nativeWindow:null,clipDraftRef:{current:clip},subtitlesRef:{current:null},shotTextRef:{current:null},context:()=>({}),isCurrent:()=>true,dirtyRef:{current:false},confirm:async()=>{confirmCount++;pending=true;return true;},msg:x=>x,subjectsRef:{current:null},setShotDirty:()=>{},setClipDirty:()=>{},setSourceDirty:()=>{},setSubjectDirty:()=>{},setSubtitleDirty:()=>{},setInspectorEpoch:()=>{}};
 const guard=Function(...Object.keys(dependencies),`${body};return guardNavigation;`)(...Object.values(dependencies));
 assert.equal(await guard(),false);assert.equal(confirmCount,0);assert.equal(discardCount,0);
 pending=false;assert.equal(await guard(),false);assert.equal(confirmCount,1);assert.equal(discardCount,0);
});
test('App optional envelope probe is connection-scoped rather than project boot-scoped',()=>{
 const source=readFileSync(new URL('../apps/web/src/App.jsx',import.meta.url),'utf8');
 const probe=source.slice(source.indexOf('  // Optional feature discovery'),source.indexOf('  async function boot()'));
 assert.match(probe,/includeVolumeEnvelopeCapability: true/);assert.match(probe,/\[workspace, online, auth\]/);assert.doesNotMatch(probe,/bootGuard|projectEpoch/);
 assert.match(source,/volumeEnvelopeObservation\.epoch === volumeEnvelopeProbeEpoch\.current/);
 const drain=source.slice(source.indexOf('    const drain = async () =>'),source.indexOf('    globalThis.__mioonFlushWorkspacePreferences'));
 assert.match(drain,/if \(clipDraftRef.current\?\.hasPendingComposition\(\)\) return false/);
});

test('retained old Inspector callbacks cannot retarget newer same-owner composition session',()=>{
 const h=inspector(),old=h.editor().props,first=Symbol('first'),second=Symbol('second');
 old.onCompositionChange({session:first,pending:true,dirty:true,row:0,field:'frame',text:'1'});
 old.onCompositionChange({session:first,pending:false,dirty:false});h.render();
 const current=h.editor().props;current.onCompositionChange({session:second,pending:true,dirty:true,row:0,field:'frame',text:'2'});h.render();
 const before=h.calls.length,raw=structuredClone(h.state.raw);
 old.onEdit({profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:'99',multiplier:'1'}]},first);
 old.onCompositionChange({session:first,pending:false,dirty:false});
 assert.equal(h.calls.length,before);assert.deepEqual(h.state.raw,raw);assert.equal(h.state.compositionPending,true);assert.equal(h.button('save-clip').props.disabled,true);
 current.onCompositionChange({session:second,pending:false,dirty:false});assert.equal(h.state.compositionPending,false);
});
test('retained Inspector adapter keeps exact composing owner across auth loss, missing/replaced selected clip and settlement',async()=>{
 const {retainClipInspector,retainClipWorkbench}=await import('../apps/web/src/clip-inspector-retention.ts');
 const snapshot={key:'project:clip:1',scope:'owner:1',projectId:id(1),timeline:{id:id(2),revision:3},clip:{id:id(3),assetId:id(4)},asset:{sha256:'a'.repeat(64)},restored:false};
 let result=retainClipInspector({snapshot:null,retained:false},snapshot,{pending:false,dirty:false,connected:true});
 result=retainClipInspector(result,null,{pending:true,dirty:true,connected:false});
 assert.equal(result.snapshot,snapshot);assert.equal(result.retained,true);assert.equal(retainClipWorkbench(result.snapshot,true,true),true);
 const replacement={...snapshot,key:'other:clip:2',scope:'other:2',projectId:id(9),clip:{id:id(8),assetId:id(7)}};
 result=retainClipInspector(result,replacement,{pending:true,dirty:true,connected:true});assert.equal(result.snapshot,snapshot);
 result=retainClipInspector(result,replacement,{pending:false,dirty:true,connected:true});assert.equal(result.snapshot,snapshot);assert.equal(result.retained,true);
 result=retainClipInspector(result,replacement,{pending:false,dirty:false,connected:true});assert.equal(result.snapshot,replacement);assert.equal(result.retained,false);
});
test('late App boot inspect response cannot adopt workspace or project after composition begins',async()=>{
 const source=readFileSync(new URL('../apps/web/src/App.jsx',import.meta.url),'utf8');
 const start=source.indexOf('  async function boot() {'),end=source.indexOf('  useEffect(() => {',start);
 const body=source.slice(start,end);let pending=false,resolve,adopted=0;
 const oldWorkspace={restored:false};
 const dependencies={clipDraftRef:{current:{hasPendingComposition:()=>pending,hasUnsaved:()=>pending}},bootGuard:{current:{begin:()=>({}),isCurrent:()=>true}},preferenceScope:{current:'old'},audioRoleProbe:{current:null},audioRoleProbeEpoch:{current:1},setAudioRoleCapability:()=>{},migrateBrowserStorage:()=>{},rpc:()=>new Promise(r=>resolve=r),retainWorkspaceIdentity:()=>oldWorkspace,workspaceRef:{current:oldWorkspace},setWorkspace:()=>adopted++,setAuth:()=>{},notify:()=>{},readableError:String};
 const boot=Function(...Object.keys(dependencies),`${body};return boot;`)(...Object.values(dependencies));
 const running=boot();await tick();pending=true;resolve({restored:false});await running;assert.equal(adopted,0);assert.equal(dependencies.workspaceRef.current,oldWorkspace);
 // Already pending must not even clear the original preference scope or read.
 dependencies.preferenceScope.current='retained';await boot();assert.equal(dependencies.preferenceScope.current,'retained');
});
test('retained auth interruption blocks App mutation/recovery entrypoints and keeps login/home from replacing owner',async()=>{
 const source=readFileSync(new URL('../apps/web/src/App.jsx',import.meta.url),'utf8');
 for(const name of ['run','runDurable','recoverTask','adoptLegacyTask','runSession']){
  const start=source.indexOf(`  async function ${name}(`),line=source.slice(start,source.indexOf('\n',start)),next=source.slice(source.indexOf('\n',start)+1).split('\n')[0];
  assert.match(next,/if \(clipConnectionBlocked.current\) return null/);
  const fn=Function('clipConnectionBlocked','captureTaskWorkspaceIntent','readTaskRevealContext','readableError',`${line}\n${next}\nthrow Error('should not dispatch');};return ${name};`)({current:true},()=>null,()=>null,String);
  assert.equal(await fn({},'op',{},'',{}),null);
 }
 assert.match(source,/auth === false && !retainWorkbenchForClip/);
 assert.match(source,/nativeWindow && !workbenchReady && !retainWorkbenchForClip/);
 assert.match(source,/draftConnected=\{!clipInspectorRetained && online && auth === true/);
 assert.match(source,/key=\{displayedClipInspector.key\}/);
});
