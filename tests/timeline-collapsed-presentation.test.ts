import type {TestTree,TestNode,TestElementProps,TestComponent,HookCell} from './helpers/strict-timeline-ui-types.ts';
interface CollapsedProps extends TestElementProps {onSeek(...args:unknown[]):void;onSnap():void;onZoom(...args:unknown[]):void;onTrackAdd(...args:unknown[]):void;onSeed():void;onRender():void;onCollapse():void;onHistory(...args:unknown[]):void;onSplit():void;onSelect(...args:unknown[]):void;onAdd():void;onDragStart(...args:unknown[]):void;onDragOver(...args:unknown[]):void;onDrop(...args:unknown[]):Promise<void>;history:CollapsedNode;split:CollapsedNode;ref:{current:unknown}}
interface CollapsedNode extends TestNode {props:CollapsedProps}
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {i18nTestModule} from './helpers/i18n.ts';
import * as geometry from '../apps/web/src/timeline-view-geometry.ts';
import * as compactLayout from '../apps/web/src/timeline-compact-layout.ts';
import {displayTimelineFrame} from '../apps/web/src/timeline-removal.ts';
import {timelineDropPreview} from '../apps/web/src/timeline-snapping.ts';
import {rulerFrameForKey} from '../apps/web/src/timeline-keyboard.ts';

const nodes=(tree:TestTree):CollapsedNode[]=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree as CollapsedNode,...nodes(tree.props?.children)]:[];
function harness(locale: unknown='zh-Hans'){
 const slots: unknown[]=[],layouts: (() => void)[]=[],calls: (unknown[] | string[])[]=[];let cursor=0,lastWaveform!: {active:boolean}|undefined,removal!:{disabled:boolean}|undefined;
 const layout=(callback: () => void|(()=>void),deps?: unknown[]|undefined)=>{const index=cursor++,prior=slots[index] as HookCell|undefined;if(!prior||deps===undefined||deps.some((v,i)=>v!==prior.deps?.[i])){slots[index]={deps};layouts.push(((()=>{prior?.cleanup?.();(slots[index] as HookCell).cleanup=callback();}) as unknown as Parameters<typeof layouts.push>[0]));}};
 const react={createElement:(type?: unknown,props?: Record<string,unknown>,...children: unknown[])=>({type,props:{...(props as Record<string, unknown>),children}}),useRef:(initial?: unknown)=>slots[cursor++]||=( {current:initial}),useState:(initial?: unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],(next: (arg0?: unknown) => unknown)=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},useLayoutEffect:layout,useEffect:()=>{cursor++;}};(react as unknown as {default:({ createElement: (type?: unknown, props?: unknown, ...children: unknown[]) => { type: unknown; props: { children: unknown[]; }; }; useRef: (initial?: unknown) => {}; useState: (initial: () => unknown) => unknown[]; useLayoutEffect: (callback: () => unknown, deps?: unknown[] | undefined) => void; useEffect: () => void; })}).default=(react as unknown as ({default:({ createElement: (type?: unknown, props?: unknown, ...children: unknown[]) => { type: unknown; props: { children: unknown[]; }; }; useRef: (initial?: unknown) => {}; useState: (initial: () => unknown) => unknown[]; useLayoutEffect: (callback: () => unknown, deps?: unknown[] | undefined) => void; useEffect: () => void; })})["default"]);
 const mark=(name?: string)=>({__esModule:true,default:name}),module={exports:{}};
 Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/Timeline.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)((name?: string|undefined)=>{
  if(name==='react')return react;
  if(name==='./i18n/I18nProvider.tsx')return i18nTestModule(((locale) as unknown as Parameters<typeof i18nTestModule>[0]));
  if(name==='./UiPreferencesProvider.tsx')return{useUiPreferences:()=>({preferences:{timecodeFormat:'timecode'}})};
  if(name==='./timeline-view-geometry.ts')return geometry;
  if(name==='./timeline-compact-layout.ts')return compactLayout;
  if(name==='./timeline-removal.ts')return{displayTimelineFrame};
  if(name==='./timeline-keyboard.ts')return{rulerFrameForKey};
  if(name==='./timeline-snapping.ts')return{timelineDropPreview};
  if(name==='./timeline-source-freshness.ts')return{staleSourceSentence:()=>''};
  if(name==='./api.ts')return{assetUrl:(asset: { url: unknown; })=>asset?.url||''};
  if(name==='./Nodes.tsx')return{Media:'Media'};
  if(name==='./ClipRemovalControls.tsx')return{ClipActionsMenu:'ClipActionsMenu',TimelineRemovalShortcuts:'TimelineRemovalShortcuts',useClipRemoval:(options?: unknown)=>{removal=options as {disabled:boolean};return{request:(mode?: unknown|string)=>calls.push(['remove',mode]),dialog:null};}};
  if(name==='./use-timeline-waveforms.ts')return{useTimelineWaveforms:(options?: unknown)=>{lastWaveform=options as {active:boolean};return{windows:[],entries:new Map(),setEnabled:(value?: unknown|string)=>calls.push(['waveform',value]),retry:()=>calls.push(['retry'])};}};
  if(name==='./waveform-state.ts')return{WAVEFORM_LIMITS:{entries:20}};
  if(name==='./TimelineWaveform.tsx')return{__esModule:true,default:'TimelineWaveform',TimelineWaveformControls:'TimelineWaveformControls'};
  if((name)!.endsWith('.css'))return{};
  if((name)!.startsWith('@mioon/ui/'))return new Proxy({},{get:(_,key)=>String(key)});
  if(['./icons.tsx','./TimelineToolbar.tsx','./TimelineHistoryControls.tsx','./TimelineSplitControls.tsx','./SubtitleLane.tsx','./TimelineTransitionMarks.tsx'].includes(((name) as unknown as string)))return mark((name)!.slice(2).split('.')[0]);
  throw Error(name);
 },module,module.exports);
 const timeline={id:'t1',projectId:'p1',revision:2,fps:30,width:1080,height:1920,durationFrames:60,tracks:[{id:'v1',kind:'video',name:'Video1',orderIndex:0},{id:'a1',kind:'audio',name:'Audio1',orderIndex:1}],clips:[{id:'c1',trackId:'v1',assetId:'asset1',name:'Clip',startFrame:0,durationFrames:60,sourceInFrame:0,gain:1}]};
 const defaults={timeline,assets:[{id:'asset1',mimeType:'video/mp4',duration:10,hasAudio:true}],playhead:0,selectedClipId:'c1',historyState:{length:1,canUndo:true,canRedo:true},splitState:{canSplit:true},canSeed:true,visible:true,presentationVisible:true,collapsed:false,busy:false,onViewStateChange:(patch?: unknown|string)=>calls.push(['view',patch])};
 for(const name of (['onSeek','onCollapse','onHistory','onSplit','onTrackAdd','onSeed','onRender','onTrackUpdate','onSelectClip','onSelectSubtitle','onAddSubtitle','onMoveClip','onAddAsset','onRemove','onRippleRemove'] as const))(defaults as typeof defaults & Record<typeof name,(...args:unknown[])=>unknown>)[name]=(...args: unknown[])=>calls.push([name,...args]);
 return{calls,defaults,get waveforms(){return lastWaveform;},get removal(){return removal;},render:(patch?: Record<string,unknown>)=>{cursor=0;const tree=(module.exports as {default:TestComponent}).default({...defaults,...(patch as Record<string, unknown>)});while(layouts.length)(layouts.shift())!();return{tree,all:nodes(tree),toolbar:(nodes(tree).find((n)=>n.type==='TimelineToolbar'))!.props,body:(nodes(tree).find((n)=>n.type==='CollapsibleContent'))!.props};},dispose:()=>{for(const slot of slots)(slot as HookCell)?.cleanup?.();}};
}
const lane=(view: ReturnType<ReturnType<typeof harness>['render']>)=>(view.all.find((node)=>node.props?.['data-testid']==='track-lane-v1'))!.props;
const clip=(view: ReturnType<ReturnType<typeof harness>['render']>)=>(view.all.find((node)=>node.props?.['data-testid']==='timeline-clip-c1'))!.props;
const ruler=(view: ReturnType<ReturnType<typeof harness>['render']>)=>(view.all.find((node)=>node.props?.role==='slider'))!.props;
const element={offsetWidth:1000,getBoundingClientRect:()=>({left:0,width:1000}),contains:()=>false};
const event=()=>({clientX:76,currentTarget:element,target:element,key:'ArrowRight',preventDefault(){},stopPropagation(){},dataTransfer:{types:[],getData:()=>'',setData(){}}});

test('desktop collapsed presentation retains the same explicit toolbar while body, waveform and removal stay inactive',()=>{
 const h=harness(),view=h.render({visible:false,presentationVisible:true,collapsed:true});
 assert.equal(view.body.keepMounted,true);assert.equal(view.body.hidden,true);assert.equal(view.body.inert,true);assert.equal(view.body['aria-hidden'],true);assert.equal((h.waveforms)!.active,false);assert.equal((h.removal)!.disabled,true);assert.equal(clip(view).draggable,false);
 assert.equal((view.all.find((n)=>n.type==='TimelineRemovalShortcuts'))!.props.disabled,true);
 view.toolbar.onSeek(30);view.toolbar.onSnap();view.toolbar.onZoom(100);view.toolbar.history.props.onHistory('undo');view.toolbar.split.props.onSplit();view.toolbar.onTrackAdd('audio');view.toolbar.onSeed();view.toolbar.onRender();view.toolbar.onCollapse();
 assert.deepEqual(h.calls.map(c=>c[0]),['onSeek','view','view','onHistory','onSplit','onTrackAdd','onSeed','onRender','onCollapse']);assert.equal(h.calls[0][1],30);assert.equal((h.calls.at(-2))![1],'preview');
 h.dispose();
});

test('retained and current hidden body callbacks cannot seek, select, write tracks, drag or drop after collapse',async()=>{
 const h=harness(),active=h.render(),oldRuler=ruler(active),oldLane=lane(active),oldClip=clip(active),track=active.all.find((n)=>n.type==='Button'&&n.props?.['aria-pressed']!==undefined&&!n.props?.draggable),subtitle=(active.all.find((n)=>n.type==='SubtitleLane'))!.props;
 const hidden=h.render({visible:false,presentationVisible:true,collapsed:true});
 for(const view of ([active,hidden] as const)){ruler(view).onClick(event());ruler(view).onKeyDown(event());lane(view).onClick(event());clip(view).onClick(event());clip(view).onDragStart(event());await lane(view).onDrop(event());}
 oldLane.onDragOver(event());oldRuler.onKeyDown(event());oldClip.onClick(event());(track)!.props.onClick();subtitle.onSeek(30);subtitle.onSelect('cue');subtitle.onAdd();
 active.toolbar.onSeek(90);active.toolbar.onTrackAdd('video');active.toolbar.onCollapse();active.toolbar.history.props.onHistory('redo');
 assert.deepEqual((h.calls as unknown),[],'old closures and the mounted hidden body must not dispatch');
 hidden.toolbar.onSeek(60);assert.deepEqual(h.calls,[['onSeek',60]],'the current visible collapsed toolbar remains explicit');h.dispose();
});

test('project retirement and unmount fence old toolbar portals; expansion retains the body and view position',()=>{
 const h=harness(),viewState={pixelsPerSecond:90,scrollLeft:180,scrollTop:40,snappingEnabled:false},first=h.render({viewState});
 const scroller=first.all.find((n)=>n.props?.['data-testid']==='timeline-scroll');const element={scrollLeft:0,scrollTop:0};(scroller)!.props.ref.current=element;
 h.render({viewState,collapsed:true,visible:false,presentationVisible:true});const expanded=h.render({viewState});assert.equal(expanded.body.keepMounted,true);assert.equal(expanded.body.hidden,false);assert.equal(expanded.body.inert,false);assert.deepEqual(element,{scrollLeft:180,scrollTop:40});assert.equal(expanded.toolbar.snapping,false);assert.equal(expanded.toolbar.pixelsPerSecond,90);
 const next=h.render({timeline:{...h.defaults.timeline,id:'t2',projectId:'p2'},onSeek:(frame?: unknown|string)=>h.calls.push(['newProjectSeek',frame])});
 first.toolbar.onSeek(1);expanded.toolbar.onTrackAdd('audio');expanded.toolbar.onRender();assert.deepEqual((h.calls as unknown),[]);
 next.toolbar.onSeek(2);assert.deepEqual(h.calls,[['newProjectSeek',2]]);h.dispose();next.toolbar.onCollapse();next.toolbar.onSeek(3);assert.equal(h.calls.length,1);
});

test('the current expanded body still previews and commits an actual drag to the displayed frame',async t=>{
 const prior=Object.getOwnPropertyDescriptor(globalThis,'getComputedStyle');Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,value:(element: { offsetWidth: unknown; })=>({width:`${element.offsetWidth}px`,boxSizing:'border-box',getPropertyValue:()=> '0'})});t.after(()=>{if(prior)Object.defineProperty(globalThis,'getComputedStyle',prior);else delete (globalThis as {getComputedStyle?: unknown}).getComputedStyle;});
 const h=harness(),view=h.render(),payload=new Map(),transfer={types:['application/x-workbench-clip'],setData:(key?: unknown,value?: unknown)=>payload.set(key,value),getData:(key?: unknown)=>payload.get(key)||''};
 clip(view).onDragStart({...event(),clientX:0,currentTarget:{offsetWidth:152,getBoundingClientRect:()=>({left:0,width:152})},dataTransfer:transfer});
 lane(view).onDragOver({...event(),clientX:304,dataTransfer:transfer});const current=h.render();await lane(current).onDrop({...event(),dataTransfer:transfer});
 assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0],['onMoveClip','c1','v1',120,{projectId:'p1',expectedRevision:2,durationFrames:60}]);h.dispose();
});

test('default track names localize while a user supplied track name stays unchanged',()=>{
 const h=harness('en'),timeline={...h.defaults.timeline,tracks:[...h.defaults.timeline.tracks,{id:'a2',kind:'audio',name:'配乐',orderIndex:2}]};
 const view=h.render({timeline}),label=(id: string)=>((((view.all.find((node)=>node.props?.['data-testid']===`timeline-track-${id}`))!.props.children[0] as TestNode).props.children[0] as TestNode).props.children[1] as TestNode).props;
 assert.equal(label('v1').children[0],'Picture');
 assert.equal(label('a1').children[0],'Music');
 assert.equal(label('a2').children[0],'配乐');
 assert.equal(label('a2').title,'配乐');
 h.dispose();
});

test('transition marks sit on video lanes and their callbacks follow the body gate',()=>{
 type MarksProps={trackId:string;disabled:boolean;onAdd?:(...args:unknown[])=>unknown;onSelect:(...args:unknown[])=>unknown};
 const h=harness(),onAddTransition=(...args: unknown[])=>h.calls.push(['onAddTransition',...args]);
 const marksOf=(view: ReturnType<ReturnType<typeof harness>['render']>)=>view.all.filter((node)=>node.type==='TimelineTransitionMarks').map((node)=>node.props as unknown as MarksProps);
 const active=h.render({onAddTransition}),[marks]=marksOf(active);
 assert.deepEqual(marksOf(active).map(props=>props.trackId),['v1'],'video tracks only');
 assert.equal(marks!.disabled,false);
 marks!.onAdd!('c1','dissolve');marks!.onSelect('c1');
 assert.deepEqual(h.calls,[['onAddTransition','c1','dissolve'],['onSelectClip','c1']]);
 assert.equal(marksOf(h.render({onAddTransition,lockedTrackIds:new Set(['v1'])}))[0]!.disabled,true,'a locked track waits');
 h.calls.length=0;
 const [gated]=marksOf(h.render({onAddTransition,visible:false,presentationVisible:true,collapsed:true}));
 assert.equal(gated!.disabled,true);
 gated!.onAdd!('c1','dissolve');gated!.onSelect('c1');marks!.onSelect('c1');
 assert.deepEqual(h.calls,[],'a hidden body and retained closures never dispatch');
 h.dispose();
});
