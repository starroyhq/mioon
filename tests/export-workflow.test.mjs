import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {i18nTestModule} from './helpers/i18n.ts';
const source=readFileSync(new URL('../apps/web/src/ExportWorkflow.tsx',import.meta.url),'utf8');
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];
const find=(tree,id)=>nodes(tree).find(node=>node.props?.['data-testid']===id);
function harness(initial={}){
 const slots=[],effects=[],calls=[];let cursor=0,context=1,props={phase:'idle',children:'retained controls',onRecheck:()=>calls.push('check'),onTasks:()=>calls.push('tasks'),...initial};
 const react={createElement:(type,props,...children)=>({type,props:{...props,children:children.length===1?children[0]:children}}),createContext:()=>({Provider:'Provider'}),useContext:()=>context,
  useRef(value){const i=cursor++;return slots[i]??=( {current:value} );},useState(value){const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},
  useEffect(run,deps){const i=cursor++,before=slots[i];if(before&&deps.every((value,n)=>Object.is(value,before[n])))return;slots[i]=deps;effects.push(run);}};
 const mod={exports:{}};Function('module','exports','require',transformSync(source,{loader:'tsx',format:'cjs',jsx:'transform'}).code)(mod,mod.exports,name=>name==='react'?react:name.endsWith('I18nProvider.tsx')?i18nTestModule():name.endsWith('.css')?{}:{WorkbenchButton:'Button',WorkbenchProgress:'Progress',WorkbenchIcon:'WorkbenchIcon'});
 return{calls,render(patch={}){props={...props,...patch};cursor=0;let tree=mod.exports.default(props);for(const run of effects.splice(0))run();cursor=0;tree=mod.exports.default(props);return tree;},section(step,values){context=step;return mod.exports.ExportWorkflowSection({steps:values,children:'retained'});}};
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
test('pending and completed exports show their bound result without automatically checking or resubmitting',()=>{
 const h=harness({phase:'ready',attempted:true,pendingExport:true});let tree=h.render();assert.equal(find(tree,'export-workflow').props['data-step'],4);assert.deepEqual(h.calls,[]);find(tree,'export-workflow-tasks').props.onClick();assert.deepEqual(h.calls,['tasks']);
 tree=h.render({pendingExport:false,record:{id:'export-1',status:'succeeded',url:'/media/export-1'}});assert.equal(find(tree,'export-workflow').props['data-step'],5);assert.ok(find(tree,'export-workflow-download'));assert.equal(find(tree,'export-workflow-result').props.hidden,false);
 assert.equal(find(h.render({downloadEnabled:false}),'export-workflow-download'),undefined,'held and candidate output cannot acquire a new download authority');
 assert.deepEqual(h.calls,['tasks']);
});
