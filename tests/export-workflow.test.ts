import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {message} from '../packages/i18n/src/index.ts';
import {i18nTestModule} from './helpers/i18n.ts';
import {mediaUrl} from '../apps/web/src/api.ts';
import type {ExportWorkflowRecord} from '../apps/web/src/ExportWorkflow.tsx';
const source=readFileSync(new URL('../apps/web/src/ExportWorkflow.tsx',import.meta.url),'utf8');
const PROJECT='e1000000-0000-4000-8000-000000000001',ASSET='e1000000-0000-4000-8000-000000000002';
interface UiNode {readonly type?: unknown; readonly props: Record<string, any> & {children?: unknown}}
type Render = (props: Record<string, unknown>) => unknown;
const nodes=(tree: unknown): UiNode[]=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree as UiNode,...nodes((tree as UiNode).props?.children)]:[];

const find=(tree: unknown,id: string): UiNode=>(nodes(tree).find(node=>node.props?.['data-testid']===id) as UiNode);
function harness(initial: Record<string, unknown> = {}) {
 const slots: unknown[]=[],effects:(()=>unknown)[]=[],calls:string[]=[];let visible=true,confirmation=async()=>true;const cleanups=new Map<number,()=>void>();let cursor=0,context=1,props: Record<string, unknown>={phase:'idle',children:'retained controls',onTasks:()=>calls.push('tasks'),...initial};
 const react={createElement:(type: unknown,props: Record<string, unknown>,...children: unknown[])=>({type,props:{...props,children:children.length===1?children[0]:children}}),createContext:()=>({Provider:'Provider'}),useContext:()=>context,
  useMemo(fn:()=>unknown,deps:unknown[]){const i=cursor++,old=slots[i] as {deps:unknown[];value:unknown}|undefined;if(!old||deps.some((value,n)=>!Object.is(value,old.deps[n])))slots[i]={deps,value:fn()};return (slots[i] as {value:unknown}).value;},
  useRef(value: unknown){const i=cursor++;return slots[i]??=( {current:value} );},useState(value: unknown){const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?(value as ()=>unknown)():value;return[slots[i],(next: unknown)=>{slots[i]=typeof next==='function'?(next as (current: unknown)=>unknown)(slots[i]):next;}];},
  useEffect(run: ()=>unknown,deps: unknown[]){const i=cursor++,before=slots[i] as unknown[]|undefined;if(before&&deps.every((value,n)=>Object.is(value,before[n])))return;slots[i]=deps;effects.push(()=>{cleanups.get(i)?.();const cleanup=run();if(typeof cleanup==='function')cleanups.set(i,cleanup as ()=>void);});}};
 const mod: {exports: {default: Render; ExportWorkflowSection: Render}}={exports:{default:()=>null,ExportWorkflowSection:()=>null}};Function('module','exports','require',transformSync(source,{loader:'tsx',format:'cjs',jsx:'transform'}).code)(mod,mod.exports,(name: string)=>name==='react'?react:name.endsWith('I18nProvider.tsx')?i18nTestModule():name.endsWith('workspace-visibility.tsx')?{useWorkspaceVisibility:()=>visible}:name.endsWith('workbench-confirm')?{useConfirmation:()=>confirmation}:name.endsWith('packages/i18n/src/index.ts')?{message}:name.endsWith('ExportFileActions.tsx')?{default:'ExportFileActions'}:name==='./api.ts'?{mediaUrl}:name.endsWith('.css')?{}:{WorkbenchButton:'Button',WorkbenchProgress:'Progress',WorkbenchIcon:'WorkbenchIcon'});
 return{calls,setConfirmation(fn:()=>Promise<boolean>){confirmation=fn;},setVisible(value:boolean){visible=value;},unmount(){for(const fn of cleanups.values())fn();},render(patch: Record<string, unknown> = {}){props={...props,...patch};cursor=0;let tree=mod.exports.default(props);for(const run of effects.splice(0))run();cursor=0;tree=mod.exports.default(props);return tree;},section(step: number,values: unknown): UiNode{context=step;return mod.exports.ExportWorkflowSection({steps:values,children:'retained'}) as UiNode;}};
}
test('workflow opens passively and latest check phase fences retained next handlers',()=>{
 const h=harness();let tree=h.render();assert.equal(find(tree,'export-workflow').props['data-step'],1);assert.equal(find(tree,'export-workflow-next').props.disabled,true);assert.deepEqual(h.calls,[]);
 tree=h.render({phase:'ready'});const next=find(tree,'export-workflow-next');next.props.onClick();tree=h.render();assert.equal(find(tree,'export-workflow').props['data-step'],2);
 const confirm=find(tree,'export-workflow-next');h.render({phase:'stale'});confirm.props.onClick();assert.equal(find(h.render(),'export-workflow').props['data-step'],2);assert.deepEqual(h.calls,[]);
 tree=h.render({phase:'ready'});find(tree,'export-workflow-next').props.onClick();assert.equal(find(h.render(),'export-workflow').props['data-step'],3);
 assert.equal(find(h.render({phase:'stale'}),'export-workflow').props['data-step'],2);
});
test('retained sections become both hidden and inert outside their step',()=>{
 const h=harness();assert.equal(h.section(1,[2]).props.hidden,true);assert.equal(h.section(1,[2]).props.inert,true);assert.equal(h.section(2,[2]).props.hidden,false);assert.equal(h.section(2,[2]).props.children,'retained');
});
test('settings estimate and the single check action stay in the fixed navigation footer',()=>{
 const check={type:'button',props:{'data-testid':'test-check',children:'check'}},estimate={type:'p',props:{'data-testid':'test-estimate',children:'size determined after encoding'}};
 const h=harness({phase:'ready',checkAction:check,settingsEstimate:estimate});let tree=h.render();
 let footer=nodes(tree).find(node=>node.props.className==='export-workflow-navigation');assert.ok(footer);assert.equal(nodes(footer).filter(node=>node.props['data-testid']==='test-check').length,1);assert.equal(find(tree,'test-estimate'),undefined);
 find(tree,'export-workflow-next').props.onClick();tree=h.render();footer=nodes(tree).find(node=>node.props.className==='export-workflow-navigation');assert.ok(footer);assert.ok(find(footer,'test-estimate'));assert.ok(find(footer,'test-check'));
 const retained=nodes(tree).find(node=>node.props.className==='export-workflow-retained');assert.ok(retained);assert.equal(find(retained,'test-estimate'),undefined);assert.deepEqual(h.calls,[]);
});
test('a shared sample-export lock blocks admission without becoming a formal export progress receipt',()=>{
 const h=harness({phase:'ready'});let tree=h.render();find(tree,'export-workflow-next').props.onClick();tree=h.render();
 const retainedNext=find(tree,'export-workflow-next');
 for(const lock of [{exportBusy:true,pendingExport:false},{exportBusy:false,pendingExport:true}]){
  tree=h.render(lock);assert.equal(find(tree,'export-workflow').props['data-step'],2);assert.equal(find(tree,'export-workflow-next').props.disabled,true);
  retainedNext.props.onClick();assert.equal(find(h.render(),'export-workflow').props['data-step'],2);
 }
 tree=h.render({exportBusy:false,pendingExport:false});assert.equal(find(tree,'export-workflow-next').props.disabled,false);
 find(tree,'export-workflow-next').props.onClick();assert.equal(find(h.render(),'export-workflow').props['data-step'],3);
 assert.equal(find(h.render({attempted:true,exportBusy:true}),'export-workflow').props['data-step'],4);assert.deepEqual(h.calls,[]);
});
test('pending and completed exports show their bound result without automatically checking or resubmitting',()=>{
 const h=harness({phase:'ready',attempted:true,pendingExport:true});let tree=h.render();assert.equal(find(tree,'export-workflow').props['data-step'],4);assert.deepEqual(h.calls,[]);find(tree,'export-workflow-tasks').props.onClick();assert.deepEqual(h.calls,['tasks']);
 tree=h.render({pendingExport:false,record:{id:'export-1',projectId:PROJECT,status:'succeeded',assetId:ASSET,url:`/media/${ASSET}`}});assert.equal(find(tree,'export-workflow').props['data-step'],5);assert.equal(find(tree,'export-workflow-download').props.href,mediaUrl(PROJECT,ASSET));assert.equal(find(tree,'export-workflow-result').props.hidden,false);
 assert.equal(find(h.render({downloadEnabled:false}),'export-workflow-download'),undefined,'held and candidate output cannot acquire a new download authority');
 assert.deepEqual(h.calls,['tasks']);
});

test('failed and cancelled exports return to step one for an explicit new check and confirmation',()=>{
 for (const code of ['INVALID_MEDIA','EXPORT_CANCELLED']) {
  let record:ExportWorkflowRecord|null={id:'first-export',projectId:PROJECT,status:'failed',error:{code,retryable:code==='INVALID_MEDIA'}};
  let reviewVersion=0;
  const calls:string[]=[];
  const checkAction={type:'button',props:{'data-testid':'retry-check',onClick:()=>calls.push('check')}};
  const h=harness({projectId:PROJECT,record,attempted:true,phase:'ready',checkAction,onReexport:()=>{
   record=null;
   reviewVersion++;
   calls.push('review');
  }});
  let tree=h.render();
  assert.equal(find(tree,'export-workflow').props['data-step'],4);
  const retry=find(tree,'export-workflow-reexport');
  assert.ok(retry,'a terminal failure must offer a direct way to start another export');
  assert.equal(retry.props.children,'重新导出');
  assert.equal(retry.props.disabled,false);
  retry.props.onClick();
  tree=h.render({record,reviewVersion});
  assert.deepEqual(calls,['review']);
  assert.equal(find(tree,'export-workflow').props['data-step'],1);
  assert.equal(find(tree,'export-workflow-next').props.disabled,true);
  find(tree,'retry-check').props.onClick();
  h.render({attempted:false,phase:'checking'});
  tree=h.render({phase:'ready'});
  assert.equal(find(tree,'export-workflow-next').props.disabled,false);
  find(tree,'export-workflow-next').props.onClick();
  tree=h.render();
  assert.equal(find(tree,'export-workflow').props['data-step'],2);
  find(tree,'export-workflow-next').props.onClick();
  assert.equal(find(h.render(),'export-workflow').props['data-step'],3);
  assert.deepEqual(calls,['review','check']);
 }
});

test('a failed result cannot start another export while a request is busy or unknown or after the view changes',()=>{
 const record={id:'failed-export',projectId:PROJECT,status:'failed'};
 for (const patch of [{exportBusy:true},{pendingExport:true},{cancelBusy:true}]) {
  const h=harness({projectId:PROJECT,record,onReexport:()=>assert.fail('locked retry')});
  const previous=find(h.render(),'export-workflow-reexport');
  assert.equal(find(h.render(patch),'export-workflow-reexport').props.disabled,true);
  previous.props.onClick();
 }
 const h=harness({projectId:PROJECT,record,onReexport:()=>assert.fail('stale retry')});
 const previous=find(h.render(),'export-workflow-reexport');
 for (const next of [{...record,status:'queued'},{...record,status:'running'},null]) {
  assert.equal(find(h.render({record:next,attempted:true,pendingExport:next===null}),'export-workflow-reexport'),undefined);
  previous.props.onClick();
 }
 h.render({record:{...record,id:'new-failed-export'},pendingExport:false});
 previous.props.onClick();
 const visible=harness({projectId:PROJECT,record,onReexport:()=>assert.fail('stale dialog retry')});
 const beforeHide=find(visible.render(),'export-workflow-reexport');
 visible.setVisible(false);visible.render();visible.setVisible(true);visible.render();
 beforeHide.props.onClick();
});

const deferred=()=>{let resolve!:(value:boolean)=>void;const promise=new Promise<boolean>(yes=>{resolve=yes;});return{promise,resolve};};
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
test('a completed output can open another review, and stale or blocked success controls cannot', () => {
 const record = {id:'finished-export', projectId:PROJECT, status:'succeeded', assetId:ASSET};
 const calls: string[] = [], onReexport = () => calls.push('review');
 const h = harness({projectId:PROJECT, record, onReexport});
 const another = find(h.render(), 'export-workflow-another');
 assert.equal(another.props.disabled, false);
 another.props.onClick();
 assert.deepEqual(calls, ['review']);
 for (const patch of [{pendingExport:true}, {pendingExport:false, exportBusy:true}, {exportBusy:false, cancelBusy:true}]) {
  assert.equal(find(h.render(patch), 'export-workflow-another').props.disabled, true);
  another.props.onClick();
 }
 h.render({cancelBusy:false, record:{...record,id:'replacement-export'}});
 another.props.onClick();
 assert.deepEqual(calls, ['review']);
});

test('unmeasurable activity stays indeterminate and observations cannot cross export identities',()=>{
 const h=harness({projectId:'p',attempted:true,record:{id:'e',status:'running'},activity:{projectId:'p',exportId:'e',status:'running',stage:'encoding',progress:null,elapsedSeconds:4,cancelled:false}});
 let tree=h.render();assert.ok(find(tree,'export-workflow-indeterminate'));assert.equal(nodes(tree).some(node=>node.type==='Progress'),false);assert.equal(find(tree,'export-workflow-progress').props.children,'进度暂不可测');
 tree=h.render({activity:{projectId:'p',exportId:'e',status:'running',stage:'encoding',progress:42,elapsedSeconds:4,cancelled:false}});assert.equal(nodes(tree).find(node=>node.type==='Progress')?.props.value,42);
 tree=h.render({activity:{projectId:'other',exportId:'e',status:'running',stage:'encoding',progress:99,elapsedSeconds:4,cancelled:false}});assert.ok(find(tree,'export-workflow-indeterminate'));
});
test('cancellation is explicit, single-dispatch and cannot continue after owner changes',async()=>{
 for(const change of ['none','reject','record','project','hide','hide-reopen','terminal','busy','unmount']){
  const held=deferred(),calls:string[]=[],h=harness({projectId:'p',record:{id:'e',status:'running'},onCancel:()=>{calls.push('cancel');}});h.setConfirmation(()=>held.promise);
  let tree=h.render();const button=find(tree,'export-workflow-cancel');button.props.onClick();button.props.onClick();assert.deepEqual(calls,[]);
  if(change==='record')h.render({record:{id:'other',status:'running'}});
  if(change==='project')h.render({projectId:'other'});
  if(change==='hide'||change==='hide-reopen'){h.setVisible(false);h.render();if(change==='hide-reopen'){h.setVisible(true);h.render();}}
  if(change==='terminal')h.render({record:{id:'e',status:'failed'}});
  if(change==='busy')h.render({cancelBusy:true});
  if(change==='unmount')h.unmount();
  held.resolve(change!=='reject');await flush();assert.deepEqual(calls,change==='none'?['cancel']:[],change);h.unmount();
 }
});
test('confirmation follows the latest cancellation callback when the same export starts running',async()=>{
 const held=deferred(),calls:string[]=[];let oldOwnerCurrent=true;
 const h=harness({projectId:'p',record:{id:'e',status:'queued'},onCancel:()=>{if(oldOwnerCurrent)calls.push('old');}});
 h.setConfirmation(()=>held.promise);
 const button=find(h.render(),'export-workflow-cancel');button.props.onClick();button.props.onClick();
 assert.equal(calls.length,0);
 // The real activity hook retires its queued observation owner when status
 // commits as running, while the formal export identity remains unchanged.
 oldOwnerCurrent=false;
 h.render({record:{id:'e',status:'running'},onCancel:()=>{calls.push('current');}});
 held.resolve(true);await flush();
 assert.deepEqual(calls,['current']);h.unmount();
});
test('an old cancel button cannot target a replacement export and project changes reset the workflow',async()=>{
 const calls:string[]=[],h=harness({projectId:'p',record:{id:'e',status:'running'},onCancel:()=>{calls.push('old');}});const old=find(h.render(),'export-workflow-cancel').props.onClick;
 h.render({record:{id:'replacement',status:'running'},onCancel:()=>{calls.push('new');}});old();await flush();assert.deepEqual(calls,[]);
 assert.equal(find(h.render({projectId:'new',record:null,attempted:false,phase:'idle'}),'export-workflow').props['data-step'],1);
});


test('restored completion preserves existing download authority without enabling file recovery or native actions',()=>{
 const h=harness({projectId:PROJECT,record:{id:'e',status:'succeeded',assetId:ASSET,url:`/media/${ASSET}`},downloadEnabled:true,fileRecoveryEnabled:false});const tree=h.render();
 // The output downloads at its project's address, not at the stored url.
 const actions=nodes(tree).find(node=>node.props.exportId==='e'&&node.props.downloadHref===`/api/projects/${PROJECT}/media/${ASSET}`);assert.ok(actions);assert.equal(actions.props.disabled,true);
 const hidden=h.render({downloadEnabled:false});assert.equal(nodes(hidden).some(node=>node.props.exportId==='e'&&typeof node.props.downloadHref==='string'),false);
});
