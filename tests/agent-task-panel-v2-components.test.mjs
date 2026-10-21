import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { i18nTestModule } from './helpers/i18n.ts';
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const source=readFileSync(new URL('../apps/web/src/AgentTaskPanel.tsx',import.meta.url),'utf8');
const projectId='11111111-1111-4111-8111-111111111111',stepId='22222222-2222-4222-8222-222222222222';
function harness({backgroundPending=false,readOnly=false,status,changes=[]}={}){
  const hooks=[];let cursor=0,pending=[],tree,loads=0;const calls=[];
  const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'fragment',useRef:value=>hooks[cursor++]??={current:value},useState:value=>{const index=cursor++;hooks[index]??={value};return[hooks[index].value,next=>{hooks[index].value=typeof next==='function'?next(hooks[index].value):next;}];},useLayoutEffect:(fn,deps)=>{const index=cursor++,old=hooks[index];if(!old||deps.some((value,at)=>value!==old.deps[at])){hooks[index]={...old,fn,deps};pending.push(index);}}};react.default=react;
  const snapshot={run:{id:'run',projectId,text:'synthetic task',status:status??(backgroundPending?'completed':'awaiting_approval'),stepsUsed:2,budget:30,configuration:{model:'historical-model'}},steps:[{id:stepId,kind:'tool',status:'completed',approvalRequired:true,tier:'paid',toolCall:{name:'mioon_generation_submit',arguments:{}}}],changes,backgroundPending};
  const state={phase:'ready',project:{readOnly,runs:[snapshot.run],authorization:{scopes:['project_agent']},settings:{configuration:{model:'current-model'}}},snapshot,draft:'next task',uploads:[],pending:null,error:'',history:{runs:[snapshot.run],nextCursor:null,phase:'ready'}};
  const module={exports:{}};let options;
  const previous=globalThis.document;globalThis.document={visibilityState:'visible',addEventListener(){},removeEventListener(){}};
  Function('module','exports','require',transformSync(source,{loader:'tsx',format:'cjs'}).code)(module,module.exports,id=>{
    if(id==='react')return react;if(id.includes('I18nProvider'))return i18nTestModule();if(id.includes('workspace-visibility'))return{useWorkspaceVisibility:()=>true};if(id==='./agent-tasks-v2.ts')return{createAgentTaskReceiptStore:()=>({}),agentTaskPromptValid:()=>true,createAgentTaskSession:value=>{options=value;return{getState:()=>state,load(){loads++;value.onChange(state);},setVisible(){},dispose(){},action:(...args)=>calls.push(args),history(){},select:(...args)=>calls.push(['select',...args])};}};
    if(id.includes('native-close-sources'))return{createAgentTaskCloseReporter:()=>({publish(){},release(){}})};if(id.includes('agent-settings.ts'))return{deriveAgentEndpoint:()=>'/synthetic'};if(id.includes('/button'))return{Button:'button'};if(id.includes('/textarea'))return{Textarea:'textarea'};if(id.includes('/input'))return{Input:'input'};if(id.includes('/badge'))return{Badge:'badge'};return{__esModule:true,default:'placeholder'};
  });
  const render=()=>{cursor=0;pending=[];tree=module.exports.default({projectId,onSettings(){calls.push(['settings']);},onClose(){}});for(const index of pending){hooks[index].cleanup?.();hooks[index].cleanup=hooks[index].fn();}return nodes(tree);};render();
  return{render,calls,state,get loads(){return loads;},find:id=>nodes(tree).find(node=>node.props?.['data-testid']===id),unmount(){for(const hook of hooks)hook.cleanup?.();globalThis.document=previous;}};
}
test('a read-only load error keeps its reload action visible and cannot send without a verified project',()=>{
  const h=harness();try{h.state.phase='read_error';h.state.error='NETWORK';h.state.project=null;h.state.snapshot=null;h.state.draft='';h.render();assert.ok(h.find('agent-task-error'));const reload=h.find('agent-task-reload');assert.ok(reload);assert.equal(reload.props.disabled,false);assert.equal(h.find('agent-task-send').props.disabled,true);const loads=h.loads;reload.props.onClick();assert.equal(h.loads,loads+1);assert.deepEqual(h.calls,[]);}finally{h.unmount();}
});
test('a saved step failure is visible as plain text beside its unknown-result controls',()=>{
  const h=harness();try{const step=h.state.snapshot.steps[0];step.kind='model';step.status='unknown';step.error={code:'AGENT_CHAT_HTTP_ERROR',message:'模型服务拒绝了请求（HTTP 401）。'};h.render();const error=h.find(`agent-task-step-error-${stepId}`);assert.ok(error);assert.equal(error.props.role,'alert');assert.deepEqual(error.props.children,[step.error.message]);assert.equal(error.props.dangerouslySetInnerHTML,undefined);}finally{h.unmount();}
});
test('an already accepted generation with renewed approval requirement renders the same exact-step approval card',()=>{
  const h=harness();try{h.render();assert.ok(h.find(`agent-task-approval-${stepId}`));h.find(`agent-task-approve-${stepId}`).props.onClick();assert.deepEqual(h.calls[0],['approve',{stepId}]);const card=h.find(`agent-task-approval-${stepId}`),buttons=nodes(card).filter(node=>node.type==='button');assert.equal(buttons.length,3);buttons[1].props.onClick();assert.deepEqual(h.calls[1],['deny',{stepId}]);buttons[2].props.onClick();assert.deepEqual(h.calls[2],['settings']);}finally{h.unmount();}
});
test('completed background work retains pause/stop controls and restored histories remain selectable',()=>{
  const h=harness({backgroundPending:true});try{h.render();assert.ok(h.find('agent-task-background-pending'));assert.ok(h.find('agent-task-pause'));assert.ok(h.find('agent-task-stop'));assert.equal(h.find('agent-task-send').props.disabled,false);const upload=h.find('agent-task-upload');assert.equal(upload.type,'input');assert.equal(upload.props.type,'file');assert.equal(upload.props.disabled,false);}finally{h.unmount();}
  const restored=harness({readOnly:true});try{const tree=restored.render();assert.ok(restored.find('agent-task-read-only'));const history=tree.find(node=>node.type==='details'&&node.props.className==='agent-task-history');assert.equal(nodes(history).find(node=>node.type==='button').props.disabled,false);assert.equal(restored.find('agent-task-send').props.disabled,true);assert.equal(restored.find('agent-task-upload'),undefined);}finally{restored.unmount();}
});

test('undo controls allow only safely finished runs and remain disabled through pause, approval and interruption',()=>{
  const changes=[{id:'change',summary:'local edit',operation:'shot.update',targets:[],reversible:true,status:'applied'}];
  for(const status of ['running','paused','awaiting_approval','interrupted','completed','failed','stopped']){
    const h=harness({status,changes});try{h.render();const allowed=['completed','failed','stopped'].includes(status);assert.equal(h.find('agent-task-undo-all').props.disabled,!allowed,status);assert.equal(h.find('agent-task-undo-change').props.disabled,!allowed,status);if(allowed){h.find('agent-task-undo-all').props.onClick();assert.deepEqual(h.calls.at(-1),['undo_all']);}}finally{h.unmount();}
  }
});
