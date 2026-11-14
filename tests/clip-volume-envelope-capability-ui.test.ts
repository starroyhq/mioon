import type {ClipDraftRaw} from '../apps/web/src/clip-draft-state.ts';
import type {RawVolumeEnvelope} from '../apps/web/src/clip-volume-envelope-state.ts';
import type {Locale} from '../packages/i18n/src/index.ts';
type InspectorCall = string | [string, unknown?, unknown?];
import type { TestNode, TestTree, TestElementProps, TestComponent, HookCell } from './helpers/strict-timeline-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { VOLUME_ENVELOPE_PROFILE } from '../packages/contracts/src/timeline-volume-envelope.ts';
import { CLIP_LAYOUT_PROFILE, type ClipLayout } from '../packages/contracts/src/timeline-clip-layout.ts';
import * as formatState from '../apps/web/src/timeline-format-state.ts';
import { readGenerationProviderDirectory } from '../apps/web/src/video-provider-directory.ts';
import {projectEntryFixture,projectEntryOwnerFixture} from './helpers/project-entry-fixture.ts';
import {readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import {projectDirectoryProjects} from '../apps/web/src/project-directory-presentation.ts';
import {chooseInitialProject,retainLastProjectScope,createProjectBootGuard} from '../apps/web/src/last-project-navigation.ts';
import {editorInitialSelection} from '../apps/web/src/editor-native-window.ts';
import { validateCatalogs, translate } from '../packages/i18n/src/index.ts';
import { volumeEnvelopeMessages } from '../packages/i18n/src/catalogs/volume-envelope.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { rawVolumeEnvelopeChanged } from '../apps/web/src/clip-volume-envelope-state.ts';
import * as opacityState from '../apps/web/src/clip-opacity-envelope-state.ts';
import * as imeSubmitGuard from '../apps/web/src/opacity-ime-submit-guard.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import * as removalState from '../apps/web/src/timeline-removal.ts';
import {hasOpenWorkbenchModal} from '../apps/web/src/workbench-modal-state.ts';
import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const id=(n: number)=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const nodes = (t: TestTree): TestNode[] =>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)];
function inspector(locale: Locale='en', eligible=true, supported=true){
 const hooks: HookCell[]=[];let cursor=0,tree: TestTree,capture=0;const calls: InspectorCall[]=[];
 const raw: ClipDraftRaw={name:'clip',trackId:id(4),startFrame:'0',durationFrames:'10',sourceInFrame:'0',gain:'1',rect:{x:'0',y:'0',width:'720',height:'1280'},volumeEnvelope:{profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:'0',multiplier:'1'}]}};
 const state={raw,dirty:true,conflict:false,compositionPending:false};
 const token={owner:1};const controller={capture:()=>({serial:capture}),isDiscarding:()=>false,hasPendingComposition:()=>state.compositionPending,hasUnsaved:()=>state.dirty,getState:()=>state,edit:()=>true,discard:()=>calls.push('discard'),save:()=>calls.push('save'),beginVolumeComposition:(c: {serial:number})=>{calls.push(['begin',c]);state.compositionPending=true;return token;},updateVolumeComposition:(t: typeof token,s: unknown)=>{calls.push(['update',t,s]);capture++;return true;},endVolumeComposition:(t: typeof token)=>{calls.push(['end',t]);state.compositionPending=false;return true;},editVolumeEnvelope:(v: RawVolumeEnvelope | null | undefined,c: unknown)=>{calls.push(['edit',v,c]);state.raw={...state.raw,volumeEnvelope:v};return true;}};
 const removalModule={exports:{} as {ClipActionsMenu: TestComponent}};
 const react={createElement: (type: unknown, props: TestElementProps, ...children: TestTree[])=>type===removalModule.exports.ClipActionsMenu?(type as TestComponent)({...props,children}):({type,props:{...props,children}}),useRef:(initial: unknown)=>hooks[cursor++]??={current:initial},useState:(initial: unknown)=>{const at=cursor++;hooks[at]??={value:initial};return[hooks[at].value,(next: unknown)=>{hooks[at].value=typeof next==='function'?next(hooks[at].value):next;}];},useEffect(){},useLayoutEffect:(fn: ()=>void)=>{fn();}};(react as typeof react & {default: unknown}).default=react;
 const stubs: Record<PropertyKey, (props: unknown)=>unknown>={};const stub=(name: PropertyKey)=>stubs[name]??=((props: unknown)=>props);
 Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/ClipRemovalControls.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)((name: string)=>{
  if(name==='react')return react;
  if(name.includes('I18nProvider'))return i18nTestModule(locale);
  if(name==='./timeline-removal.ts')return removalState;
  if(name==='./workbench-modal-state.ts')return {hasOpenWorkbenchModal};
  if(name.startsWith('@mioon/ui/'))return new Proxy({}, {get:(_,key)=>stub(key)});
  return assert.fail(name);
 },removalModule,removalModule.exports);
 const module={exports:{} as {default: TestComponent}};Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/TimelineInspector.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)((name: string)=>{
  if(name==='react')return react;
  if(name==='./UiPreferencesProvider.tsx')return {useUiPreferences:()=>({preferences:DEFAULT_UI_PREFERENCES})};
  if(name==='./timeline-removal.ts')return removalState;
  if(name==='./ClipRemovalControls.tsx')return removalModule.exports;
  if(name.includes('I18nProvider'))return i18nTestModule(locale);
  if(name.includes('i18n/src/index'))return {message:(key: string)=>({key})};
  if(name.includes('workbench-confirm'))return {useConfirmation:()=>async()=>{calls.push('confirm');return true;}};
  if(name==='@mioon/contracts')return {sourceFrameCount:()=>10,isTimelineRecord:()=>true};
  if(name.endsWith('/Timeline.tsx'))return {assetKind:(a: {mimeType:string})=>a.mimeType.split('/')[0],framesLabel:String};
  if(name.endsWith('clip-draft-hook.ts'))return {useClipDraft:()=>({state,controller})};
  if(name.endsWith('clip-draft-state.ts'))return {clipDraftRaw:(clip: {volumeEnvelope?:RawVolumeEnvelope|null})=>({...raw,volumeEnvelope:clip.volumeEnvelope}),clipDraftSource:()=>({}),clipDraftPatch:()=>({})};
  if(name.endsWith('clip-volume-envelope-state.ts'))return {rawVolumeEnvelopeChanged};
  if(name.endsWith('clip-opacity-envelope-state.ts'))return opacityState;
  if(name.endsWith('opacity-ime-submit-guard.ts'))return imeSubmitGuard;
  if(name.endsWith('clip-audio-role-state.ts'))return {clipAudioRoleChanged:()=>false};
  if(name.endsWith('clip-audio-state.ts'))return {clipAudioIssue:()=>''};
  if(name.endsWith('timeline-format-state.ts'))return formatState;
  if(name.endsWith('workspace-visibility.tsx'))return {useWorkspaceVisibility:()=>true};
  if(name.endsWith('.css'))return {};
  if(name.startsWith('@mioon/ui/'))return new Proxy({}, {get:(_,key)=>stub(key)});
  return {__esModule:true,default:stub(name)};
 },module,module.exports);
 const props: Record<string,unknown> & {clip:{id:string;assetId:string;layout?:ClipLayout;volumeEnvelope?:RawVolumeEnvelope|null};timeline:Record<string,unknown>;asset:{mimeType:string;hasAudio:boolean};draftContext:{volumeEnvelopeEditable:boolean;volumeEnvelopeCapability:string};draftConnected?:boolean}={clip:{id:id(5),assetId:id(6),volumeEnvelope:undefined as RawVolumeEnvelope|null|undefined},timeline:{projectId:id(1),id:id(2),revision:1,width:720,height:1280,tracks:[]},asset:{mimeType:'audio/wav',hasAudio:eligible},draftContext:{volumeEnvelopeEditable:supported,volumeEnvelopeCapability:supported?'editable':'unsupported'},onSave:()=>{},onRemove:()=>calls.push('remove')};
 const h={calls,state,controller,token,props,render(){cursor=0;tree=module.exports.default(props);return tree;},all:()=>nodes(tree),editor:()=>nodes(tree).find(n=>n.type===stubs['./ClipVolumeEnvelopeControls.tsx']),form:()=>nodes(tree).find(n=>n.type==='form'),button:(testid: string)=>nodes(tree).find(n=>n.props?.['data-testid']===testid)};h.render();return h;
}
function duckingKey(key='Enter',keyCode=13,isComposing=false,repeat=false){
 const observed={prevented:0,stopped:0};return {observed,key,nativeEvent:{keyCode,isComposing,repeat},target:{getAttribute:(name: string)=>name==='data-testid'?'ducking-startFrame':null},preventDefault(){observed.prevented++;},stopPropagation(){observed.stopped++;}};
}
function beginDucking(h: ReturnType<typeof inspector>,session: symbol){h.editor()!.props.onCompositionChange({session,pending:true,dirty:true,target:'ducking',field:'startFrame',text:'二'});h.render();}
function endDucking(h: ReturnType<typeof inspector>,session: symbol){h.editor()!.props.onCompositionChange({session,pending:false,dirty:false});h.render();}
const submitDucking=(h: ReturnType<typeof inspector>)=>h.form()!.props.onSubmit({preventDefault(){}});
const saves=(h: ReturnType<typeof inspector>)=>h.calls.filter(call=>call==='save').length;
test('relative layout keeps the transform controls and allows nongeometry edits against a smaller current frame',async()=>{
 const h=inspector();
 h.props.asset.mimeType='video/mp4';
 h.props.onSetTransform=()=>{};
 h.props.timeline.height=720;
 h.props.timeline.width=1280;
 h.render();
 assert.ok(h.button('clip-height'),'a legacy clip keeps its rectangle fields');
 assert.equal(h.button('save-clip')!.props.disabled,true,'legacy rectangle bounds still guard Save');
 const transform = h.all().find(node=>typeof node.props.onSetTransform==='function');
 assert.ok(transform);
 h.props.clip.layout={profileId:CLIP_LAYOUT_PROFILE,basisPresetId:'portrait_720'};
 h.render();
 for(const field of ['x','y','width','height'])assert.equal(h.button(`clip-${field}`),undefined);
 assert.ok(h.all().some(node=>node.type===transform.type));
 assert.equal(h.button('save-clip')!.props.disabled,false);
 await submitDucking(h);
 assert.equal(saves(h),1);
});
for(const [key,keyCode] of [['Enter',13],['Process',229]] as const)test(`actual Inspector ${key}/${keyCode} ducking IME confirmation survives compositionend and submit until keyup release`,async()=>{
 const h=inspector(),session=Symbol('duck-confirm');beginDucking(h,session);const event=duckingKey(key,keyCode,true);
 h.form()!.props.onKeyDownCapture(event);assert.equal(event.observed.prevented,0,'native IME default must not be cancelled');
 if(key==='Enter')assert.ok(event.observed.stopped>0);
 endDucking(h,session);assert.equal(h.state.compositionPending,false);assert.equal(h.button('save-clip')!.props.disabled,false);
 await submitDucking(h);assert.equal(saves(h),0,'compositionend must not turn confirmation into implicit Save');
 if(key==='Enter'){const repeat=duckingKey('Enter',13,false,true);h.form()!.props.onKeyDownCapture(repeat);assert.equal(repeat.observed.prevented,0);await submitDucking(h);assert.equal(saves(h),0);}
 h.form()!.props.onKeyUpCapture(duckingKey(key,keyCode));await submitDucking(h);assert.equal(saves(h),0,'same-event default submission precedes the queued keyup release');
 await Promise.resolve();await submitDucking(h);assert.equal(saves(h),1);
});
test('actual Inspector ducking confirmation is released only by a later independent pointer after composition',async()=>{
 const h=inspector(),session=Symbol('duck-pointer');beginDucking(h,session);h.form()!.props.onKeyDownCapture(duckingKey('Enter',13,true));
 h.form()!.props.onPointerDownCapture();await submitDucking(h);assert.equal(saves(h),0);endDucking(h,session);
 await submitDucking(h);assert.equal(saves(h),0);h.form()!.props.onPointerDownCapture();await submitDucking(h);assert.equal(saves(h),1);
});
test('an older ducking keyup microtask cannot clear a newer Inspector composition confirmation',async()=>{
 const h=inspector(),first=Symbol('first-duck'),second=Symbol('second-duck');
 beginDucking(h,first);h.form()!.props.onKeyDownCapture(duckingKey('Enter',13,true));endDucking(h,first);h.form()!.props.onKeyUpCapture(duckingKey());
 beginDucking(h,second);h.form()!.props.onKeyDownCapture(duckingKey('Enter',13,true));endDucking(h,second);
 await Promise.resolve();await submitDucking(h);assert.equal(saves(h),0,'first release owns the earlier confirmation only');
 h.form()!.props.onKeyUpCapture(duckingKey());await submitDucking(h);assert.equal(saves(h),0);await Promise.resolve();await submitDucking(h);assert.equal(saves(h),1);
});
test('Inspector wires controller-owned envelope token across renders and blocks save/remove during composition',async()=>{
 const h=inspector();const editor=h.editor();const session=Symbol('first');assert.equal(editor!.props.disabled,false);
 editor!.props.onCompositionChange({session,pending:true,dirty:true,row:0,field:'frame',text:'一'});h.render();assert.equal(h.button('save-clip')!.props.disabled,true);assert.equal(h.button('remove-clip')!.props.disabled,true);
 await h.button('remove-clip')!.props.onClick();assert.equal(h.calls.includes('confirm'),false);
 assert.equal(h.calls.includes('remove'),false);assert.equal(h.button('confirm-clip-removal')!.props.disabled,true);
 h.props.draftContext.volumeEnvelopeEditable=false;h.props.draftConnected=false;h.render();assert.equal(h.editor()!.props.disabled,false); // Never disable the active IME input before it can settle.
 h.props.draftContext.volumeEnvelopeEditable=true;h.props.draftConnected=true;
 const value={...h.state.raw.volumeEnvelope,points:[{frame:'1e-',multiplier:'1'}]};h.editor()!.props.onEdit(value,session);h.editor()!.props.onCompositionChange({session,pending:false,dirty:false});
 assert.equal(h.calls.find(c=>c[0]==='edit')![2],h.token);assert.equal(h.calls.at(-1)![1],h.token);
 h.render();assert.equal(h.button('save-clip')!.props.disabled,false);
});
test('silent assets or unavailable editing retain the recovered envelope and keep saving blocked',()=>{
 assert.deepEqual(validateCatalogs(volumeEnvelopeMessages),[]);
 for(const locale of ['en','zh-Hans','zh-Hant','ja'] as const)for(const eligible of [true,false] as const){
  const h=inspector(locale,eligible,false);assert.ok(h.editor());assert.equal(h.editor()!.props.disabled,true);assert.equal(h.button('save-clip')!.props.disabled,true);

 }
});
test('App navigation refuses composition before confirmation and rechecks after async confirmation',async()=>{
 const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  async function guardNavigation('),source.indexOf('  async function guardProjectNavigation('));
 let pending=true,confirmCount=0,discardCount=0;
 const clip={capture:()=>({}),hasUnsaved:()=>true,hasPendingComposition:()=>pending,isCurrent:()=>true,discard:async()=>{discardCount++;return true;}};
 const dependencies={nativeWindow:null,clipDraftRef:{current:clip},subtitlesRef:{current:null},shotTextRef:{current:null},context:()=>({}),isCurrent:()=>true,dirtyRef:{current:false},confirm:async()=>{confirmCount++;pending=true;return true;},msg:(x: unknown)=>x,subjectsRef:{current:null},setShotDirty:()=>{},setClipDirty:()=>{},setSourceDirty:()=>{},setSubjectDirty:()=>{},setSubtitleDirty:()=>{},setInspectorEpoch:()=>{}};
 const guard=Function(...Object.keys(dependencies),`${body};return guardNavigation;`)(...Object.values(dependencies)) as () => Promise<boolean>;
 assert.equal(await guard(),false);assert.equal(confirmCount,0);assert.equal(discardCount,0);
 pending=false;assert.equal(await guard(),false);assert.equal(confirmCount,1);assert.equal(discardCount,0);
});

test('retained old Inspector callbacks cannot retarget newer same-owner composition session',()=>{
 const h=inspector(),old=h.editor()!.props,first=Symbol('first'),second=Symbol('second');
 old.onCompositionChange({session:first,pending:true,dirty:true,row:0,field:'frame',text:'1'});
 old.onCompositionChange({session:first,pending:false,dirty:false});h.render();
 const current=h.editor()!.props;current.onCompositionChange({session:second,pending:true,dirty:true,row:0,field:'frame',text:'2'});h.render();
 const before=h.calls.length,raw=structuredClone(h.state.raw);
 old.onEdit({profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:'99',multiplier:'1'}]},first);
 old.onCompositionChange({session:first,pending:false,dirty:false});
 assert.equal(h.calls.length,before);assert.deepEqual(h.state.raw,raw);assert.equal(h.state.compositionPending,true);assert.equal(h.button('save-clip')!.props.disabled,true);
 current.onCompositionChange({session:second,pending:false,dirty:false});assert.equal(h.state.compositionPending,false);
});
test('retained Inspector adapter keeps exact composing owner across auth loss, missing/replaced selected clip and settlement',async()=>{
 const {retainClipInspector,retainClipWorkbench}=await import('../apps/web/src/clip-inspector-retention.ts');
 const snapshot={key:'project:clip:1',scope:'owner:1',projectId:id(1),timeline:{id:id(2),revision:3},clip:{id:id(3),assetId:id(4)},asset:{sha256:'a'.repeat(64)}};
 let result=retainClipInspector({snapshot:null,retained:false},snapshot,{pending:false,dirty:false,connected:true});
 result=retainClipInspector(result,null,{pending:true,dirty:true,connected:false});
 assert.equal(result.snapshot,snapshot);assert.equal(result.retained,true);assert.equal(retainClipWorkbench(result.snapshot,true,true),true);
 const replacement={...snapshot,key:'other:clip:2',scope:'other:2',projectId:id(9),clip:{id:id(8),assetId:id(7)}};
 result=retainClipInspector(result,replacement,{pending:true,dirty:true,connected:true});assert.equal(result.snapshot,snapshot);
 result=retainClipInspector(result,replacement,{pending:false,dirty:true,connected:true});assert.equal(result.snapshot,snapshot);assert.equal(result.retained,true);
 result=retainClipInspector(result,replacement,{pending:false,dirty:false,connected:true});assert.equal(result.snapshot,replacement);assert.equal(result.retained,false);
});
test('late App boot directory response cannot adopt workspace or project after composition begins',async()=>{
 const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
 const start=source.indexOf('  async function boot(): Promise<void> {'),end=source.indexOf('  useEffect(() => {',start);
 const body=source.slice(start,end);let pending=false,held=true,resolve!: (value: unknown)=>void,adopted=0,reads=0;
 const oldWorkspace={};
 const directory=projectEntryFixture([{id:id(1)}]),identity=projectEntryOwnerFixture(()=>{reads++;return held?new Promise(r=>resolve=r):directory;});
 const bootGuard=createProjectBootGuard(()=>0);bootGuard.activate();const errors:unknown[]=[],emptyData={project:null};
 const dependencies={clipDraftRef:{current:{hasPendingComposition:()=>pending,hasUnsaved:()=>pending}},bootGuard:{current:bootGuard},preferenceScope:{current:null as string|null},locatorIdentity:{current:null},migrateBrowserStorage:()=>{},readGenerationProviderDirectory,setVideoDirectoryUnavailable:()=>{},rpc:async()=>[],editorSession: {current: 'normal'}, workspaceRef:{current:oldWorkspace},setWorkspace:()=>adopted++,
  projectEntryIdentityRef:{current:identity},readProjectEntryIdentity,projectDirectoryProjects,retainLastProjectScope,chooseInitialProject,editorInitialSelection,nativeWindow:null,URLSearchParams,window:{location:{search:''}},
  setProjects:()=>adopted++,providersRef:{current:[]},setProviders:()=>{},setAuth:(value:unknown)=>{if(value==='error')errors.push(value);},setOnline:()=>{},notify:(value:unknown)=>errors.push(value),readableError:String,
  emptyData,dataRef:{current:emptyData},currentProject:{current:null},openedProject:{current:null},viewReady:{current:false},setData:()=>{},setProjectOpening:()=>{}};
 const boot=Function(...Object.keys(dependencies),`${body};return boot;`)(...Object.values(dependencies)) as () => Promise<void>;
 const running=boot();await tick();assert.equal(reads,1);pending=true;held=false;resolve!(directory);await running;assert.equal(adopted,0);assert.equal(dependencies.workspaceRef.current,oldWorkspace);assert.deepEqual(errors,[]);
 // Already pending must not even clear the original preference scope or read.
 dependencies.preferenceScope.current='retained';await boot();assert.equal(dependencies.preferenceScope.current,'retained');assert.equal(reads,1);
 // A complete, non-composing control must reach the real directory adoption;
 // missing free variables caught by boot cannot masquerade as a guarded pass.
 pending=false;await boot();assert.equal(adopted,1);assert.equal(reads,2);assert.deepEqual(errors,[]);identity.dispose();
});
test('retained auth interruption blocks App mutation/recovery entrypoints and keeps login/home from replacing owner',async()=>{
 const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
 for(const name of ['run','runDurable','recoverTask','adoptLegacyTask','runSession'] as const){
  const start=source.indexOf(`  async function ${name}(`),line=source.slice(start,source.indexOf('\n',start)),guards=source.slice(source.indexOf('\n',start)+1).split('\n').slice(0,name==='run'?2:1);
  assert.match(guards.at(-1)!,/if \(clipConnectionBlocked.current\) return null/);
  if(name==='run')assert.match(guards[0],/if \(projectEntryIdentityRef.current!\.getState\(\)\.identityBlocked\) return null/);
  const fn=Function('clipConnectionBlocked','projectEntryIdentityRef','captureTaskWorkspaceIntent','readTaskRevealContext','readableError',`${line}\n${guards.join('\n')}\nthrow Error('should not dispatch');};return ${name};`)({current:true},{current:{getState:()=>({identityBlocked:false})}},()=>null,()=>null,String) as (...args: unknown[])=>Promise<unknown>;
  assert.equal(await fn({},'op',{},'',{}),null);
 }
 assert.match(source,/auth === false && !retainWorkbenchForClip/);
 assert.match(source,/nativeWindow && !workbenchReady && !retainWorkbenchForClip/);
 assert.match(source,/draftConnected=\{!clipInspectorRetained && online && auth === true/);
 assert.match(source,/key=\{displayedClipInspector.key\}/);
});
