import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {clipRemovalKey,displayTimelineFrame} from '../apps/web/src/timeline-removal.ts';
import {timelineHistoryState} from '../apps/web/src/timeline-history.ts';
import {i18nTestModule} from './helpers/i18n.ts';
import {stepPreviewMedia,previewProgress} from '../apps/web/src/preview-playback.ts';
import {timelinePointerFrame} from '../apps/web/src/timeline-view-geometry.ts';

interface RenderedNode {type?: unknown; props?: Record<string, unknown>; [key: string]: unknown}
type Nodes = RenderedNode[];
const nodes = (tree: unknown): Nodes => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [{...(tree as RenderedNode)}, ...nodes((tree as RenderedNode).props?.children)] : [];
interface Slot {deps?: readonly unknown[]; cleanup?: () => void; current?: unknown; [key: string]: unknown}
interface HarnessView {dialog: RenderedNode; request: (mode: string) => void; available: (mode: string) => boolean}
interface Harness {render: (options: unknown) => HarnessView; shortcuts: (options: unknown) => void; dispose: () => void}
interface MockMedia {readyState: number; currentTime: number; paused?: boolean; pause: () => void}
function harness(): Harness {
 const slots: Slot[]=[],effects: Array<() => void>=[];let cursor=0;
 const effect=(callback: () => void | (() => void),deps: readonly unknown[]): void=>{const index=cursor++,previous=slots[index];if(!previous||deps.some((value,i)=>value!==previous.deps?.[i])){slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slots[index].cleanup=callback() ?? undefined;});}};
 const react={createElement:(type: unknown,props: Record<string, unknown> | null,...children: unknown[]): RenderedNode=>({type,props:{...props,children}}),
  useRef:(initial: unknown): Slot=>{const index=cursor++;return (slots[index] ||= {current:initial});},
  useState:(initial: unknown): unknown[]=>{const index=cursor++;if(!(index in slots))slots[index]=initial as Slot;return [slots[index],(next: unknown)=>{slots[index]= (typeof next==='function' ? (next as (value: unknown) => unknown)(slots[index]) : next) as Slot;}];},
  useEffect:effect,useLayoutEffect:effect,default:undefined as unknown};
 react.default=react;
 const module: {exports: Record<string, unknown>}={exports:{}};
 Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/ClipRemovalControls.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)((name: string)=>{
  if(name==='react')return react;
  if(name==='./i18n/I18nProvider.tsx')return i18nTestModule();
  if(name==='./timeline-removal.ts')return {clipRemovalKey,clipRemovalTargetIsEditing:()=>false};
  if(name==='./workbench-modal-state.ts')return {hasOpenWorkbenchModal:()=>false};
  if(name==='lucide-react')return new Proxy({}, {get:(_target,key)=>String(key)});
  if(name.startsWith('@mioon/ui/components/'))return new Proxy({}, {get:(_target,key)=>String(key)});
  throw Error(name);
 },module,module.exports);
 return {render:(options: unknown)=>{cursor=0;const result=(module.exports.useClipRemoval as (options: unknown) => HarnessView)(options);while(effects.length)effects.shift()?.();return result;},
  shortcuts:(options: unknown)=>{cursor=0;(module.exports.TimelineRemovalShortcuts as (options: unknown) => void)(options);while(effects.length)effects.shift()?.();},dispose:()=>{for(const slot of slots)slot?.cleanup?.();}};
}

test('Backspace and Shift+Backspace are separate actions and all editing/admission guards win',()=>{
 assert.equal(clipRemovalKey({key:'Backspace'},false),'remove');assert.equal(clipRemovalKey({key:'Backspace',shiftKey:true},false),'ripple');
 for(const patch of [{key:'Delete'},{altKey:true},{ctrlKey:true},{metaKey:true},{repeat:true},{defaultPrevented:true},{isComposing:true},{keyCode:229}])assert.equal(clipRemovalKey({key:'Backspace',...patch},false),null);
 assert.equal(clipRemovalKey({key:'Backspace'},true),null);
 assert.equal(displayTimelineFrame(108031,30),'01:00:01:01');assert.equal(displayTimelineFrame(31,30,'seconds'),'1.03s');
});

test('both removal modes wait for confirmation and recheck dirty state, selected clip and revision before submission',async()=>{
 const h=harness(),calls: Array<[string, string]> = [];let dirty=false;
 let options={clip:{id:'clip1',name:'One',durationFrames:30},scope:'p:t:1:clip1',disabled:false,canRemove:()=>!dirty,onRemove:(id: string)=>calls.push(['remove',id]),onRippleRemove:(id: string)=>calls.push(['ripple',id])};
 let view=h.render(options);view.request('ripple');assert.deepEqual(calls,[]);view=h.render(options);assert.equal((view.dialog.props as {open?: boolean}).open,true);
 let submit=nodes(view.dialog).find(node=>node.props?.['data-testid']==='confirm-clip-removal');dirty=true;await (submit!.props!.onClick as () => Promise<void>)();assert.deepEqual(calls,[]);
 dirty=false;view=h.render(options);submit=nodes(view.dialog).find(node=>node.props?.['data-testid']==='confirm-clip-removal');
 options={...options,scope:'p:t:2:clip1'};h.render(options);await (submit!.props!.onClick as () => Promise<void>)();assert.deepEqual(calls,[],'retained confirmation cannot cross revisions');
 view=h.render(options);view.request('remove');view=h.render(options);submit=nodes(view.dialog).find(node=>node.props?.['data-testid']==='confirm-clip-removal');await (submit!.props!.onClick as () => Promise<void>)();assert.deepEqual(calls,[['remove','clip1']]);
 view=h.render(options);view.request('ripple');view=h.render(options);submit=nodes(view.dialog).find(node=>node.props?.['data-testid']==='confirm-clip-removal');await (submit!.props!.onClick as () => Promise<void>)();assert.deepEqual(calls,[['remove','clip1'],['ripple','clip1']]);
 h.dispose();
});

test('ripple uses its own localized history label',()=>{
 const state=timelineHistoryState({projectId:'p',timeline:{id:'t',revision:2},history:{projectId:'p',timelineId:'t',revision:2,cursor:1,length:1,canUndo:true,canRedo:false,undoEntry:{id:'entry',operation:'timeline.clip.rippleRemove'},redoEntry:null}});
 assert.equal(state.undoLabel,'波纹删除片段');assert.equal(state.canUndo,true);
});

test('native removal availability follows the same live confirmation owner, locks and component lifetime', () => {
 const h=harness(), calls: string[]=[];
 const options={clip:{id:'clip1',name:'One',durationFrames:30},scope:'p:t:1:clip1',disabled:false,onRemove:(id:string)=>calls.push(id)};
 let view=h.render(options); assert.equal(view.available('remove'),true); assert.equal(view.available('ripple'),false);
 view.request('remove'); view=h.render(options); assert.equal(view.dialog.props?.open,true); assert.deepEqual(calls,[]);
 const retained=view.available; h.render({...options,disabled:true}); assert.equal(retained('remove'),false,'old native callback must re-read a newly locked or dirty owner');
 h.render(options); assert.equal(retained('remove'),true); h.dispose(); assert.equal(retained('remove'),false);
 assert.deepEqual(calls,[],'availability and requesting confirmation never remove media themselves');
});

test('frame controls reject hidden/unready bindings and keep source clocks independent from timeline playhead',()=>{
 const seeks: unknown[]=[],notices: unknown[]=[];const media: MockMedia={readyState:1,currentTime:0,pause(){this.paused=true;}};
 const binding: {sourceSeekIntent: number | null; programmaticSeek: number | null}={sourceSeekIntent:null,programmaticSeek:20};
 const options={delta:1,media,current:true,timelineMode:false,timelineDuration:120,playhead:80,sourcePosition:29,sourceCount:300,sourceFps:30,binding,onSeek:(value: unknown)=>seeks.push(value),notify:()=>notices.push(true)};
 stepPreviewMedia({...options,current:false} as never);assert.equal(media.currentTime,0);assert.deepEqual(seeks,[]);
 stepPreviewMedia({...options,media:{...media,readyState:0}} as never);assert.equal(binding.programmaticSeek,20);
 stepPreviewMedia(options as never);assert.equal(media.currentTime,1);assert.equal(binding.sourceSeekIntent,30);assert.equal(binding.programmaticSeek,null);assert.deepEqual(seeks,[]);assert.deepEqual(notices,[true]);
 stepPreviewMedia({...options,timelineMode:true} as never);assert.deepEqual(seeks,[81]);assert.equal(media.currentTime,1);
 assert.equal(previewProgress(101),100);assert.equal(previewProgress(Infinity),null);assert.equal(previewProgress('57'),null);
});

test('ruler, drag and grab pointer coordinates preserve exact layout frames across90–125% display scale',()=>{
 for(const zoom of [.9,1,1.25])for(const frame of [0,30,75.25,18000]){
  const width=45600,left=-123.5,px=76/30,clientX=left+frame*px*zoom;
  assert.ok(Math.abs((timelinePointerFrame(clientX,left,width*zoom,width,px) as number)-frame)<1e-9);
 }
 assert.equal(timelinePointerFrame(100,0,0,400,2),null);
});
